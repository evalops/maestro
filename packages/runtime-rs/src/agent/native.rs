//! Native Rust agent implementation
//!
//! A fully native agent implementation that communicates directly with AI providers,
//! replacing the previous Node.js subprocess architecture with pure Rust for better
//! performance, type safety, and integration.
//!
//! # Architecture
//!
//! The agent uses a background task architecture to enable non-blocking operations:
//!
//! - **[`NativeAgent`]**: Lightweight handle held by the composing host. All methods
//!   return immediately, sending commands via channels.
//! - **`NativeAgentRunner`**: Private background task that owns mutable state, processes
//!   commands, and manages the AI conversation loop.
//! - **Channel communication**: All interaction happens through Tokio MPSC channels,
//!   enabling true async/non-blocking behavior.
//!
//! # Lifecycle
//!
//! ```text
//! 1. Host calls NativeAgent::start_with_resolved_client(...)
//!    ├─> Spawns background tokio::spawn(runner.run())
//!    └─> Returns (agent_handle, event_receiver)
//!
//! 2. Host calls agent.prompt(message)
//!    └─> Sends AgentCommand::Prompt via channel (returns immediately)
//!
//! 3. Background runner receives command
//!    ├─> Adds message to conversation history
//!    ├─> Calls AI provider API (streaming)
//!    ├─> Sends FromAgent::ResponseChunk events
//!    └─> Handles tool calls if requested
//!
//! 4. Host receives events from event_receiver
//!    └─> Updates UI in real-time
//! ```
//!
//! # Async Task Spawning
//!
//! The agent uses `tokio::spawn` to run the background task. This allows the host
//! task to remain responsive while the agent processes long-running AI requests:
//!
//! ```rust,ignore
//! tokio::spawn(async move {
//!     runner.run().await;
//! });
//! ```
//!
//! The spawned task runs independently and communicates exclusively via channels.
//!
//! # Channel Communication (MPSC)
//!
//! Three unbounded MPSC (multi-producer, single-consumer) channels coordinate
//! communication between the host and agent:
//!
//! 1. **Command channel** (`mpsc::UnboundedSender<AgentCommand>`):
//!    - Host sends commands (prompt, cancel, `set_model`, etc.)
//!    - Agent receives and processes in order
//!
//! 2. **Event channel** (`mpsc::UnboundedSender<FromAgent>`):
//!    - Agent sends events (response chunks, tool calls, errors)
//!    - Host receives and projects events
//!
//! 3. **Tool response channel** (`mpsc::UnboundedSender<ToolResponseMessage>`):
//!    - Host sends user approval for tool execution
//!    - Agent waits for approval before executing restricted tools
//!
//! Unbounded channels are used because:
//! - Commands are user-initiated and low-volume
//! - Hosts consume streamed events and own their presentation or transport
//! - Tool responses are synchronous (one response per tool call)
//!
//! # Cancellation
//!
//! The agent supports mid-request cancellation using `CancellationToken`:
//!
//! ```rust,ignore
//! // In runner
//! let cancel_token = CancellationToken::new();
//! tokio::select! {
//!     res = self.run_loop() => res,
//!     _ = cancel_token.cancelled() => {
//!         Err(anyhow::anyhow!("Request cancelled"))
//!     }
//! }
//! ```
//!
//! When the user presses Escape or sends `AgentCommand::Cancel`, the token is
//! triggered and the current request stops gracefully.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::extensions::{
    BatchEndContext, ExtensionRegistry, ExtensionVerdict,
    ToolCallContext as ExtensionToolCallContext, ToolResultContext as ExtensionToolResultContext,
    ToolResultPayload, TurnEndContext, TurnStartContext,
};
use super::message_queue::{
    MAX_PENDING_MESSAGES, MessageQueue, PendingMessage, PromptKind, QueuePlacement,
};
use super::native_host::{
    ApprovalMode, NativeExecutionHostHandle, NativeFirewallVerdict, NativeHookEvent,
    NativeHookResult, NativeModelCapabilities, NativeModelRoute, NativeResolvedClient,
    NativeToolExecutionOptions, QueueMode, ToolDefinition,
};
use super::reminders::{ReminderEngine, ToolOutcome as ReminderToolOutcome};
use super::safety::stable_stringify;
use super::safety::{DenialMemory, WorkflowStateTracker, apply_workflow_state_hooks};
use super::text_loop::{
    LoopKind, TextLoopDetector, billed_empty_reminder_message, loop_reminder_message,
};
use super::turn_budget::{DEFAULT_MAX_TURN_STEPS, TurnOutcome, TurnStepBudget};
use super::{
    CredentialVault, DenialReason, ExecutionPhase, ExecutionSource, FromAgent,
    ManagedInferenceAuthorization, ManagedPolicyMetadata, TokenUsage, ToolExecution, ToolOutcome,
    ToolResult, ensure_untrusted_content_policy,
};
use crate::ai::{
    AiProvider, ContentBlock, ImageSource, Message, MessageContent, ProviderStreamErrorKind,
    RequestConfig, Role, StopReason, StreamEvent, ThinkingConfig, Tool, UnifiedClient,
    provider_model_name,
};
use crate::{
    approval_span, record_model_usage, record_outcome, terminal_span, tool_span_for_call, turn_span,
};
use tracing::Instrument;

pub fn managed_turn_lineage_id(
    organization_id: &str,
    workspace_id: &str,
    thread_id: &str,
    run_id: &str,
    turn_id: &str,
) -> String {
    let mut material = b"maestro-managed-turn-v2".to_vec();
    for value in [organization_id, workspace_id, thread_id, run_id, turn_id] {
        material.extend_from_slice(&(value.len() as u64).to_be_bytes());
        material.extend_from_slice(value.as_bytes());
    }
    format!("maestro-turn-v2:{:x}", Sha256::digest(material))
}

#[derive(Debug)]
struct EmptyAssistantResponse;

impl std::fmt::Display for EmptyAssistantResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "empty_assistant_response: provider completed the turn without assistant text or tool calls",
        )
    }
}

impl std::error::Error for EmptyAssistantResponse {}

/// A host refused admission for a logical provider request.  This is kept as
/// a distinct error so the request retry classifier cannot mistake a lease or
/// event-ledger decision for a transient provider failure and open a fresh
/// request round.
#[derive(Debug)]
struct ProviderAdmissionDenied {
    kind: String,
    request_id: String,
    reason: String,
}

impl std::fmt::Display for ProviderAdmissionDenied {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "provider admission denied for {} request {}: {}",
            self.kind, self.request_id, self.reason
        )
    }
}

impl std::error::Error for ProviderAdmissionDenied {}

/// Derive the identity of one logical provider request from its immutable
/// input snapshot.  The identity survives an outer request retry and a
/// worker replay while changing when the model receives a new history, model,
/// or provider-request kind.  Transport-level retries happen below this
/// boundary and therefore reuse the same admission.
fn provider_request_id(kind: &str, model: &str, messages: &[Message]) -> Result<String> {
    let encoded_messages = serde_json::to_vec(messages)?;
    let mut material = Vec::with_capacity(kind.len() + model.len() + encoded_messages.len() + 32);
    for value in [
        kind.as_bytes(),
        model.as_bytes(),
        encoded_messages.as_slice(),
    ] {
        material.extend_from_slice(&(value.len() as u64).to_be_bytes());
        material.extend_from_slice(value);
    }
    Ok(format!(
        "native-provider-v1:{kind}:{:x}",
        Sha256::digest(material)
    ))
}

/// Describe a batch's tool results for the reminder engine.
///
/// A `ToolResult` block carries the call id, not the tool name, so the names
/// come from the `ToolUse` blocks of `assistant` -- the assistant message the
/// batch answers, which the runner pushes immediately above the batch.
fn tool_outcomes_for_batch(
    host: &NativeExecutionHostHandle,
    assistant: Option<&Message>,
    results: &[ContentBlock],
) -> Vec<ReminderToolOutcome> {
    let mut names: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    if let Some(Message {
        role: Role::Assistant,
        content: MessageContent::Blocks(blocks),
    }) = assistant
    {
        for block in blocks {
            if let ContentBlock::ToolUse { id, name, .. } = block {
                names.insert(id.as_str(), name.as_str());
            }
        }
    }
    results
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let tool = names
                    .get(tool_use_id.as_str())
                    .map_or_else(|| "unknown".to_string(), |name| name.to_lowercase());
                let success = !is_error.unwrap_or(false);
                let open_todos = (tool == "todo" && success)
                    .then(|| host.open_todo_count(content))
                    .flatten();
                Some(ReminderToolOutcome {
                    tool,
                    success,
                    open_todos,
                })
            }
            _ => None,
        })
        .collect()
}

/// Append reminder text to the last `ToolResult` block of a batch.
///
/// Returns whether a block was found. The reminder never becomes its own
/// message: a provider request pairs every `tool_use` with a `tool_result`,
/// and inserting a message between them makes the request invalid.
fn append_reminder_to_last_tool_result(results: &mut [ContentBlock], reminder: &str) -> bool {
    for block in results.iter_mut().rev() {
        if let ContentBlock::ToolResult { content, .. } = block {
            content.push_str("\n\n");
            content.push_str(reminder);
            return true;
        }
    }
    false
}

fn begin_queued_user_turn(
    reminders: &mut ReminderEngine,
    denial_memory: &mut DenialMemory,
    step_budget: &mut TurnStepBudget,
) {
    reminders.reset_turn();
    denial_memory.begin_turn();
    step_budget.reset();
}

/// How long one text-delta chunk may spend inside the loop detector.
///
/// The detector is O(period limit) per character, so a pathological chunk
/// could cost real time on the streaming path. The check is abandoned for
/// that chunk when the budget runs out and resumes on the next one.
const TEXT_LOOP_CHECK_BUDGET: Duration = Duration::from_millis(500);

/// The model repeated itself again after one steering attempt.
#[derive(Debug)]
struct AssistantTextLoop {
    kind: LoopKind,
}

impl std::fmt::Display for AssistantTextLoop {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "assistant_text_loop: the model repeated the same {} pattern {} times after a \
             steering reminder, so the turn was stopped",
            self.kind.label(),
            self.kind.repetitions(),
        )
    }
}

impl std::error::Error for AssistantTextLoop {}

#[derive(Debug)]
struct ProviderStreamFailure {
    kind: ProviderStreamErrorKind,
    message: String,
}

impl std::fmt::Display for ProviderStreamFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "provider_stream_error: {}", self.message)
    }
}

impl std::error::Error for ProviderStreamFailure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestFailureOwner {
    Request,
    ProviderStream,
}

fn request_retry_decision(
    retry_policy: &mut super::retry::RetryPolicy,
    error_kind: super::retry::ErrorKind,
    owner: RequestFailureOwner,
) -> super::retry::RetryDecision {
    if owner == RequestFailureOwner::ProviderStream {
        // UnifiedClient owns retries once a provider stream has opened. A
        // typed stream failure is therefore already the terminal outcome of
        // that policy. Retrying the entire request here would multiply the
        // stream budget and can keep a hosted turn non-terminal beyond its
        // controller deadline. Request/open failures still use this outer
        // policy because no stream-level retry owner exists for them.
        super::retry::RetryDecision::GiveUp {
            reason: "Provider stream retry policy reached a terminal outcome".to_string(),
        }
    } else {
        retry_policy.should_retry(error_kind)
    }
}

fn coding_turn_completed_event(
    executor: &NativeExecutionHostHandle,
    response_id: &str,
) -> Result<FromAgent, String> {
    let (coding_completion, coding_child_records) = match executor.coding_completion()? {
        Some(completion) => (Some(completion.submission), completion.child_records),
        None => (None, Vec::new()),
    };
    Ok(FromAgent::TurnCompleted {
        response_id: response_id.to_owned(),
        coding_completion,
        coding_child_records,
    })
}

fn closed_tool_response_failure(call_id: &str) -> anyhow::Error {
    anyhow::Error::new(ProviderStreamFailure {
        kind: ProviderStreamErrorKind::TransientProtocol,
        message: format!("tool approval response channel closed before `{call_id}` completed"),
    })
}

mod model_dynamics;
mod read_only_tools;
mod tool_execution;
mod tool_responses;

use self::tool_execution::{
    ApprovalDecision, DeferredToolCall, DeferredToolCallDisposition, PostExecutionHooks,
    ToolCallContext, abort_pending_tools_after_stream_error, append_hook_context,
    approved_inline_env_change_rejection, approved_input_change_rejection, cancel_deferred_suffix,
    cancelled_deferred_tool, clear_stashed_prompts, deferred_approved_policy_rejection,
    deferred_firewall_verdict, deferred_hook_block, deferred_policy_rejection_event,
    deferred_rejection_output_event, deferred_safety_rejection_event,
    deferred_tool_call_disposition, deferred_tool_call_event, emit_deferred_failure,
    emit_deferred_policy_failure, invalidate_cache_after_serial_tool,
    normalize_post_hook_tool_args, parse_tool_input, repeat_refusal_message,
    rerun_deferred_pre_tool_use, run_post_execution_hooks, run_pre_tool_use_hook,
    tool_args_for_execution, tool_is_visible_to_model, tool_requires_approval,
};

/// Compatibility exports for callers that historically imported these types
/// from `maestro_runtime::agent`.
pub use crate::{ToolResponseConsumption, ToolResponseMessage};
use crate::{ToolResponseCoordinator, ToolResponseWait};

use self::read_only_tools::{
    QueuedReadOnlyToolExecution, execute_native_read_only_tool_wave,
    is_explicit_inline_read_only_tool, is_native_parallel_read_only_tool_call,
};
use self::tool_responses::repair_orphaned_tool_calls;

fn provider_id(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Anthropic => "anthropic",
        AiProvider::Bedrock => "bedrock",
        AiProvider::OpenAI => "openai",
        AiProvider::Mistral => "mistral",
        AiProvider::Google => "google",
        AiProvider::Groq => "groq",
        AiProvider::VertexAi => "vertex-ai",
        AiProvider::DeepSeek => "deepseek",
        AiProvider::Moonshot => "moonshot",
        AiProvider::Qwen => "dashscope",
        AiProvider::MiniMax => "minimax",
        AiProvider::Zai => "zai",
        AiProvider::Scripted => "scripted-replay",
    }
}

fn policy_model_id(model: &str) -> String {
    if model.contains('/') {
        model.to_string()
    } else {
        let provider = AiProvider::from_model(model);
        format!("{}/{}", provider_id(provider), model)
    }
}

fn is_tool_result_only_user_message(message: &Message) -> bool {
    message.role == Role::User
        && matches!(
            &message.content,
            MessageContent::Blocks(blocks)
                if !blocks.is_empty()
                    && blocks
                        .iter()
                        .all(|block| matches!(block, ContentBlock::ToolResult { .. }))
        )
}

/// Drop legacy-alias properties from the model-facing tool schema.
///
/// Execution still accepts aliases in the tool handlers; they are only omitted
/// from the request payload to shrink every-turn tool definitions.
fn compact_tool_for_model(mut tool: Tool) -> Tool {
    let Some(properties) = tool
        .input_schema
        .get_mut("properties")
        .and_then(|value| value.as_object_mut())
    else {
        return tool;
    };
    properties.retain(|_name, schema| {
        let description = schema
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        !description.to_ascii_lowercase().contains("legacy alias")
    });
    tool
}

fn count_transcript_entries_before(messages: &[Message], first_kept_index: usize) -> usize {
    messages
        .iter()
        .take(first_kept_index.min(messages.len()))
        .filter(|message| !is_tool_result_only_user_message(message))
        .count()
}

fn emit_compaction_event(
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    messages: &[Message],
    summary: &str,
    cut_point: Option<&super::compaction::CutPoint>,
    continuation: Option<&super::compaction::ContinuationRecord>,
    auto: bool,
) {
    let first_kept_entry_index = cut_point
        .map(|point| count_transcript_entries_before(messages, point.first_kept_index))
        .unwrap_or(0);
    let tokens_before = cut_point.map(|point| point.tokens_before).unwrap_or(0);

    let _ = event_tx.send(FromAgent::Compaction {
        summary: summary.to_string(),
        first_kept_entry_index,
        tokens_before,
        auto,
        custom_instructions: None,
        continuation: continuation.cloned(),
        timestamp: Utc::now().to_rfc3339(),
    });
}

/// Provenance for the per-request output limit.
///
/// Catalog-derived limits follow model switches. Explicit limits are stable
/// across switches, even when their numeric value equals a catalog default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaxTokensSource {
    Catalog,
    Explicit,
}

/// Configuration for the native agent
///
/// Defines the AI model settings, system prompt, thinking capabilities, and execution
/// environment for the agent. All fields can be updated at runtime via agent methods.
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_runtime::agent::{ApprovalMode, NativeAgentConfig};
///
/// // Default configuration (Codex on OpenAI)
/// let config = NativeAgentConfig::default();
/// assert_eq!(config.model, "gpt-5.1-codex-max");
///
/// // Custom configuration with thinking enabled
/// let config = NativeAgentConfig {
///     model: "claude-opus-4-5-20251101".to_string(),
///     max_tokens: 32768,
///     max_tokens_source: maestro_runtime::agent::MaxTokensSource::Explicit,
///     system_prompt: Some("You are a helpful coding assistant.".to_string()),
///     thinking_enabled: true,
///     thinking_budget: 20000,
///     cwd: "/path/to/project".to_string(),
///     approval_mode: ApprovalMode::Selective,
///     context_window: None,
///     sandbox_policy: None,
///     max_turn_steps: maestro_runtime::agent::DEFAULT_MAX_TURN_STEPS,
///     allow_unbounded_turn: false,
///     retry_config: maestro_runtime::agent::retry::RetryConfig::default(),
///     managed_mcp_policy: None,
///     model_dynamics: Default::default(),
/// };
/// ```
#[derive(Debug, Clone)]
pub struct NativeAgentConfig {
    /// Model to use (e.g., "gpt-5.1-codex-max", "claude-opus-4-5-20251101")
    ///
    /// The model string is parsed by `UnifiedClient` to determine the provider
    /// (Anthropic, `OpenAI`, etc.) and model variant.
    pub model: String,

    /// Maximum tokens for responses
    ///
    /// Limits the length of generated responses. Different models support different
    /// max token values (check provider documentation).
    pub max_tokens: u32,

    /// Whether `max_tokens` came from model metadata or explicit configuration.
    pub max_tokens_source: MaxTokensSource,

    /// System prompt
    ///
    /// Optional instructions prepended to every conversation. Used to set the agent's
    /// role, coding standards, and behavioral guidelines.
    pub system_prompt: Option<String>,

    /// Whether extended thinking is enabled
    ///
    /// When true, the model uses a separate reasoning phase before generating the
    /// final response. Currently only supported by Claude Opus 4.5 and newer.
    pub thinking_enabled: bool,

    /// Token budget for thinking (if enabled)
    ///
    /// Maximum tokens allocated to the thinking/reasoning phase. Only used when
    /// `thinking_enabled` is true. Typical values: 5000-20000.
    pub thinking_budget: u32,

    /// Explicit local routing preferences, loaded from the user configuration by default.
    pub model_dynamics: super::model_dynamics::ModelDynamicsConfig,

    /// Current working directory
    ///
    /// The directory where file operations and commands are executed. Tools like
    /// `bash`, `read`, and `write` use this as their base path.
    pub cwd: String,

    /// Active approval mode for the tool-execution gate.
    ///
    /// This is the single source of truth for whether a tool call needs
    /// human approval before the runner executes it inline (see
    /// `NativeAgentRunner::run_loop`'s `requires_approval` computation).
    /// Callers embedding a caller-owned approval UI (the interactive TUI,
    /// headless server, etc.) must keep this in sync with their own mode
    /// selector via `NativeAgent::set_approval_mode` so the runner's
    /// auto-execute decision and the caller's approval UI never disagree.
    pub approval_mode: ApprovalMode,

    /// Optional explicit context-window override. When absent, the runner uses
    /// the active model catalog instead of a fixed compaction threshold.
    pub context_window: Option<u64>,

    /// Native OS sandbox policy applied to the runner's *own* tool executor.
    ///
    /// This is the executor that actually runs auto-approved calls: every
    /// [`ApprovalMode::Yolo`] call, and every [`ApprovalMode::Selective`]
    /// call the per-tool heuristic doesn't flag for approval, executes
    /// through `NativeAgentRunner::execute_tool` (see `run_loop`), which
    /// dispatches to this executor -- not to whatever separately-configured
    /// executor a caller (the interactive TUI's `App`, `print_mode`, the
    /// headless server) might use for its own approval-gated calls. A
    /// caller that resolves a sandbox policy for itself but does not also
    /// pass it here gets no sandboxing at all for the common case: only
    /// calls that actually reach a human approval prompt would ever have
    /// been sandboxed, and Yolo mode never asks a human anything.
    pub sandbox_policy: Option<maestro_sandbox::SandboxPolicy>,

    /// Maximum provider round trips inside a single turn.
    ///
    /// One step is one request/response pair with the provider. A turn spends
    /// a step every time the model answers with tool calls and the runner has
    /// to ask again with the results. `run_loop` refuses the tool batch that
    /// would need a step past this bound and ends the turn with
    /// [`TurnOutcome::StepBudgetExhausted`] rather than looping forever.
    ///
    /// Ignored when `allow_unbounded_turn` is true. Values below 1 are
    /// clamped to 1.
    pub max_turn_steps: usize,

    /// Remove the `max_turn_steps` ceiling for this agent.
    ///
    /// Set this only for a caller that owns an equivalent bound of its own or
    /// deliberately runs unattended without one. An unbounded turn has no
    /// other terminator: the doom-loop detector in
    /// [`crate::agent::safety`] blocks only three identical consecutive
    /// calls, so a model alternating between two calls never stops.
    pub allow_unbounded_turn: bool,

    /// Retry policy for provider request failures within the current turn.
    ///
    /// Callers may extend this bounded window, but retries remain inside the
    /// owning runtime so completed tool effects are never replayed.
    pub retry_config: super::retry::RetryConfig,
}

impl NativeAgentConfig {
    /// The step ceiling `run_loop` enforces, after the unbounded opt-out.
    #[must_use]
    pub fn resolved_max_turn_steps(&self) -> usize {
        if self.allow_unbounded_turn {
            usize::MAX
        } else {
            self.max_turn_steps.max(1)
        }
    }
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        let model = "gpt-5.1-codex-max".to_string();
        Self {
            model,
            // The host replaces catalog-derived values when it composes the
            // runtime.  Keep this fallback independent of the TUI catalog so
            // the runtime remains usable by headless hosts.
            max_tokens: 16_384,
            max_tokens_source: MaxTokensSource::Catalog,
            system_prompt: None,
            thinking_enabled: false,
            thinking_budget: 10000,
            model_dynamics: super::model_dynamics::ModelDynamicsConfig::default(),
            cwd: std::env::current_dir()
                .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string()),
            approval_mode: ApprovalMode::default(),
            context_window: None,
            sandbox_policy: None,
            max_turn_steps: DEFAULT_MAX_TURN_STEPS,
            allow_unbounded_turn: false,
            retry_config: super::retry::RetryConfig::default(),
        }
    }
}

#[derive(Clone)]
struct ModelToolCache {
    goal_tools_visible: bool,
    include_ide_tools: bool,
    active_tool_names: HashSet<String>,
    tools: Arc<Vec<Tool>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolProfile {
    Fast,
    All,
    Review,
    Explore,
}

impl ToolProfile {
    fn from_env() -> Self {
        match std::env::var("MAESTRO_TOOL_PROFILE")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("all" | "full") => Self::All,
            Some("review") => Self::Review,
            Some("explore") => Self::Explore,
            _ => Self::Fast,
        }
    }

    fn includes(self, name: &str) -> bool {
        if self == Self::All {
            return true;
        }

        let name = name.to_ascii_lowercase();
        let names: &[&str] = match self {
            Self::Fast => &[
                "bash",
                "read",
                "write",
                "edit",
                "glob",
                "grep",
                "find",
                "list",
                "search",
                "parallel_ripgrep",
                "diff",
                "status",
                "background_tasks",
                "todo",
                "ask_user",
                "get_goal",
                "update_goal",
                "get_harness_context",
                "propose_harness_refinement",
                "apply_harness_refinement",
                "reject_harness_refinement",
                "get_mailbox",
                "send_mailbox",
                "read_mailbox",
                "ack_mailbox",
                "compact_mailbox",
                "tool_search",
                "explore",
            ],
            Self::Review => &[
                "read",
                "grep",
                "find",
                "list",
                "search",
                "parallel_ripgrep",
                "diff",
                "status",
                "tool_search",
                "explore",
            ],
            Self::Explore => &[
                "read",
                "glob",
                "grep",
                "find",
                "list",
                "search",
                "parallel_ripgrep",
                "diff",
                "status",
                "tool_search",
                "explore",
            ],
            Self::All => &[],
        };
        names.contains(&name.as_str())
    }
}

fn initial_active_tool_names(
    profile: ToolProfile,
    tools: &HashMap<String, ToolDefinition>,
    external_tools: &HashSet<String>,
    explicit_allowed_tools: Option<&HashSet<String>>,
) -> HashSet<String> {
    tools
        .keys()
        .filter_map(|name| {
            let explicitly_allowed = explicit_allowed_tools
                .is_some_and(|allowed| allowed.contains(&name.to_ascii_lowercase()));
            (profile.includes(name) || explicitly_allowed).then_some(name.clone())
        })
        .chain(external_tools.iter().cloned())
        .collect()
}

fn is_rlm_context_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "get_rlm_context"
            | "set_rlm_context"
            | "append_rlm_context"
            | "render_rlm_context"
            | "clear_rlm_context"
    )
}

fn tool_search_profile_allows(
    profile: ToolProfile,
    name: &str,
    explicitly_allowed_tools: &HashSet<String>,
) -> bool {
    profile != ToolProfile::Fast
        || !is_rlm_context_tool(name)
        || explicitly_allowed_tools.contains(&name.to_ascii_lowercase())
}

fn effective_tool_definitions(
    tools: &HashMap<String, ToolDefinition>,
    active_tool_names: &HashSet<String>,
    goal_tools_visible: bool,
    include_ide_tools: bool,
) -> Vec<ToolDefinition> {
    let mut definitions = tools
        .values()
        .filter(|definition| {
            let name = definition.tool.name.as_str();
            active_tool_names.contains(&name.to_ascii_lowercase())
                && tool_is_visible_to_model(name, goal_tools_visible, include_ide_tools)
        })
        .cloned()
        .collect::<Vec<_>>();
    definitions.sort_unstable_by(|left, right| left.tool.name.cmp(&right.tool.name));
    for definition in &mut definitions {
        definition.tool = compact_tool_for_model(definition.tool.clone());
    }
    definitions
}

fn validate_governed_tools_with_host(
    host: NativeExecutionHostHandle,
    allowed_tools: &HashSet<String>,
    external_tool_definitions: &[ToolDefinition],
) -> Result<()> {
    for name in allowed_tools {
        let normalized = name.to_ascii_lowercase();
        if !host.has_native_tool(&normalized) || host.is_reserved_tool(name) {
            return Err(anyhow::anyhow!("Unknown allowed tool `{name}`"));
        }
    }
    let native_names = allowed_tools
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut external_names = HashSet::new();
    for definition in external_tool_definitions {
        let name = definition.tool.name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(anyhow::anyhow!("External tool name must not be empty"));
        }
        if native_names.contains(&name) || host.is_reserved_tool(&name) {
            return Err(anyhow::anyhow!(
                "Governed client tool name `{name}` collides with a reserved native name"
            ));
        }
        if !external_names.insert(name.clone()) {
            return Err(anyhow::anyhow!(
                "Ambiguous governed client tool name `{name}` has multiple owners"
            ));
        }
    }
    Ok(())
}

fn goal_tools_visible_from_execution(execution: &ToolExecution) -> Option<bool> {
    let ToolOutcome::Succeeded { output } = &execution.outcome else {
        return None;
    };
    let response: Value = serde_json::from_str(output.as_str()).ok()?;
    let status = response.get("goal")?.get("status")?.as_str()?;
    Some(matches!(status, "active" | "paused" | "blocked"))
}

/// Command sent to the background agent runner
///
/// Internal enum used for communication between `NativeAgent` (handle) and
/// `NativeAgentRunner` (background task). These commands are sent via the
/// command channel and processed sequentially by the runner.
///
/// This enum is private to the module - external code interacts through
/// `NativeAgent` methods which create and send these commands.
enum AgentCommand {
    ApplySelectiveSummary {
        messages: Vec<Message>,
        digest: String,
        reply: oneshot::Sender<Result<()>>,
    },
    SelectiveSummaryPreview {
        reply: oneshot::Sender<Result<super::SelectiveSummaryPreview>>,
    },
    SelectiveSummary {
        selection: super::RangeSelection,
        digest: String,
        instructions: Option<String>,
        cancellation: CancellationToken,
        reply: oneshot::Sender<super::SelectiveSummaryOutcome>,
    },
    Boost,
    SetContextToolExcluded {
        name: String,
        excluded: bool,
    },
    /// User submitted a prompt
    ///
    /// Adds the user message to conversation history and triggers a new
    /// AI completion request. The runner will stream the response via
    /// `FromAgent::ResponseChunk` events.
    Prompt {
        content: String,
        attachments: Vec<String>,
        kind: PromptKind,
        /// Optional queue id for correlating queued prompts with UI state.
        queue_id: Option<u64>,
        /// Correlation identity bound to this exact governed runtime turn.
        managed_request_lineage: Option<String>,
        /// Opaque capability bound to this exact managed runtime turn.
        managed_inference_authorization: Option<ManagedInferenceAuthorization>,
    },

    /// Reinsert a follow-up at the front of the follow-up subsection.
    RequeueFollowUpFront {
        content: String,
        attachments: Vec<String>,
        queue_id: u64,
        managed_request_lineage: Option<String>,
    },

    /// Cancel the current operation
    ///
    /// Triggers the cancellation token to stop the active AI request.
    /// The runner will clean up and send a `FromAgent::ResponseEnd` event.
    Cancel {
        clear_pending: bool,
    },

    /// Cancel a queued prompt by id
    CancelQueued {
        id: u64,
    },

    /// Reorder a queued prompt without changing its id or contents.
    ReorderQueued {
        id: u64,
        placement: QueuePlacement,
    },

    /// Change the active model
    ///
    /// Switches to a different AI model (e.g., from Claude to GPT-5).
    /// The conversation history is preserved.
    SetModel {
        model: String,
    },

    /// Re-resolve catalog/runtime limits for the already active model.
    RefreshModelBudgets,

    /// Update thinking configuration
    ///
    /// Enables or disables the extended thinking mode and sets the token budget.
    SetThinking {
        enabled: bool,
        budget: u32,
    },

    /// Update the per-request output-token limit
    ///
    /// `max_tokens` bounds a single provider response, so a caller enforcing a
    /// budget across a whole run (the subagent scheduler) lowers it between
    /// requests to the allowance that is still unspent.
    SetMaxTokens {
        max_tokens: u32,
    },

    /// Cap the cumulative output tokens this runner may request across a run.
    ///
    /// A caller enforcing a whole-run budget cannot do it with `SetMaxTokens`:
    /// that bounds one request, so the caller has to lower it between
    /// responses, and the command can arrive after the runner has already built
    /// the next request. This hands the accounting to the runner, which
    /// subtracts what each response spent and clamps the request it is about to
    /// build. Sent once, before the prompt it applies to.
    InstallProcessBudget {
        limits: super::process_budget::ProcessBudgetLimits,
        checkpoint: Option<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>>,
        applied: oneshot::Sender<
            Result<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>>,
        >,
    },

    ClearProcessBudget {
        system_prompt: String,
        applied: oneshot::Sender<Result<()>>,
    },

    SetOutputTokenBudget {
        max_total_output_tokens: u32,
    },

    /// Point the runner's tool executor at a different subagent scope.
    ///
    /// The runner's executor -- not the caller's -- is the one that spawns
    /// children, so it stamps the scope onto every child it starts. A new or
    /// resumed conversation rotates the scope on both sides; without this the
    /// caller would drain a scope no new child is ever tagged with.
    SetSubagentParentScope {
        parent_scope_id: String,
    },

    /// Tell the runner which conversation is active.
    ///
    /// The hook system lives here, not in the caller, so this is the only way
    /// the active session id reaches hook payloads and the only place
    /// `SessionStart` and `SessionEnd` can be dispatched from. The runner
    /// compares against the session it currently holds and fires the
    /// transition, so callers just report the new state.
    SetSessionContext {
        session_id: Option<String>,
        /// Canonical persisted JSONL path for observation-only lifecycle
        /// adapters. This is not restore authority.
        transcript_path: Option<String>,
        /// Why the session changed, published as the hook's `source` /
        /// `reason` (`new`, `resume`, `fork`, `exit`).
        reason: String,
        /// Whether this session has a durable owner that will clean up model
        /// tool-output spill files when the session is deleted.
        owns_persistent_tool_spills: bool,
        preserve_compacted_checkpoint: bool,
    },

    /// Point the hook system at a log file (test harness / diagnostics).
    ///
    /// Does not load project hook config; only enables
    /// [`IntegratedHookSystem`]'s existing `log_event` writer so session and
    /// recovery dispatches become assertable without trusting a temp workspace.
    SetHookLogFile {
        path: String,
    },

    /// Update whether the goal lifecycle tools are exposed to the model.
    SetGoalToolsVisible {
        visible: bool,
    },

    /// Update the active approval mode
    ///
    /// Keeps the runner's tool-execution gate (`requires_approval`) in sync
    /// with the caller's approval UI so the two never disagree about whether
    /// a tool needs approval before it executes.
    SetApprovalMode {
        mode: ApprovalMode,
    },

    /// Replace the exact governed native allowlist and caller-owned tools
    /// without rebuilding the runner or losing its private conversation state.
    ReplaceGovernedTools {
        allowed_tools: HashSet<String>,
        external_tool_definitions: Vec<ToolDefinition>,
    },

    /// Update steering queue drain mode.
    SetSteeringMode {
        mode: QueueMode,
    },

    /// Update follow-up queue drain mode.
    SetFollowUpMode {
        mode: QueueMode,
    },

    /// Update the system prompt
    ///
    /// Replaces the base system prompt used for subsequent requests.
    SetSystemPrompt {
        system_prompt: String,
    },

    /// Materialize the provider session that owns the current standing prompt.
    ///
    /// Unlike `SetSystemPrompt`, this is acknowledged only after Codex
    /// app-server has accepted `thread/start`. HTTP providers are stateless,
    /// so updating their request configuration is already the install boundary.
    EnsureProviderPromptInstalled {
        applied: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
    },

    /// Stage a system prompt to take effect when the next queued prompt runs.
    ///
    /// A prompt queued while the agent is busy needs its skills active for its
    /// own turn. `SetSystemPrompt` cannot express that: the runner drains
    /// commands inside the tool loop, so a prompt sent at enqueue time changes
    /// the turn that is already running.
    ///
    /// Keyed by queue id so each queued prompt gets the skills its own text
    /// triggered. An unkeyed staged value let a prompt inherit instructions
    /// activated only by a later queued prompt, which is wrong regardless of
    /// the order they run in.
    ///
    /// Applying an older entry after a newer one is correct here, not a bug:
    /// each entry is that prompt's own state, so a steer that jumps the queue
    /// does not leak its skills into the prompts behind it.
    SetSystemPromptForQueuedPrompt {
        queue_id: u64,
        system_prompt: String,
    },

    /// Clear conversation history
    ///
    /// Removes all messages from the conversation, starting fresh. Does not
    /// affect configuration (model, thinking, etc.).
    ClearHistory,

    /// Replace conversation history (used by /rewind and /fork rebuilds).
    ReplaceHistory {
        messages: Vec<Message>,
        continuation: Option<super::compaction::ContinuationRecord>,
    },

    /// Replace history for a delegated child resume without clearing the
    /// credential vault shared with its parent runner.
    ReplaceHistoryPreservingCredentials {
        messages: Vec<Message>,
    },

    /// Append a host-generated user note to conversation history without
    /// starting a model turn. Used for background-task lifecycle notices so
    /// the next completion request sees them (does not trigger a response).
    InjectUserNote {
        content: String,
        applied: tokio::sync::oneshot::Sender<()>,
        consumed: tokio::sync::oneshot::Sender<()>,
    },

    /// Continue from current context without a new user message
    ///
    /// Used for retrying after transient errors (rate limits, 5xx errors),
    /// continuing after context compaction, or resuming interrupted tool execution.
    Continue,
}

/// Handle to the shared native actor.
///
/// Hosts construct it with a resolved provider client and execution adapter,
/// send commands, and consume the returned event stream. The runner owns
/// mutable conversation state and turn execution.
///
/// Use [`Self::shutdown`] to cancel and await cleanup. Dropping the handle
/// preserves the local host's historical detached-task behavior; hosted owners
/// must retain the handle until admitted work has drained.
pub struct NativeAgent {
    host: NativeExecutionHostHandle,
    managed_run_id: String,
    /// Channel to send commands to the background runner
    ///
    /// Commands are processed sequentially by the runner. Sending is non-blocking.
    command_tx: mpsc::UnboundedSender<AgentCommand>,

    /// Sender for tool responses (kept for creating receivers)
    ///
    /// When the TUI approves or denies a tool execution, it sends the response
    /// via this channel. The agent waits for these responses before proceeding.
    tool_response_tx: mpsc::UnboundedSender<ToolResponseMessage>,

    /// Direct cancellation path shared with the background runner.
    active_cancellation: Arc<Mutex<ActiveCancellation>>,

    /// Channel to send events to the TUI (for `send_ready`)
    ///
    /// Used by helper methods like `send_ready()` and `send_session_info()` to
    /// emit events without going through the background task.
    event_tx: mpsc::UnboundedSender<FromAgent>,

    /// Model name
    ///
    /// Cached for emitting `FromAgent::Ready` events. Updated when the model
    /// is changed via `set_model()`.
    model_name: String,

    /// Provider name
    ///
    /// Cached provider identifier (e.g., "Anthropic", "`OpenAI`"). Used for
    /// status displays and debugging.
    provider_name: String,

    runtime_audit: Arc<RwLock<RuntimeAuditSnapshot>>,
    /// Priority lifecycle signal that prevents buffered prompts from starting
    /// once orderly shutdown begins.
    shutdown_token: CancellationToken,

    /// Background runner lifecycle retained for orderly signal shutdown.
    ///
    /// Normal drops preserve the historical detached-runner behavior. Signal
    /// shutdown consumes the agent, closes the command channel, and awaits
    /// this handle so queued cancellation and tool cleanup finish before App
    /// and session state are dropped.
    runner_handle: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct RuntimeAuditSnapshot {
    pub request_cache: Option<maestro_context::token_counting::RequestCacheSnapshot>,
    pub cache_reuse: Option<maestro_context::token_counting::CacheReuse>,
    pub request_context: Option<super::RequestContextUsage>,
    pub excluded_context_tools: HashSet<String>,
    pub prompt_revision: u64,
    pub system_prompt: Option<String>,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Default)]
struct ActiveCancellation {
    request: Option<CancellationToken>,
    tool: Option<CancellationToken>,
    approval: Option<CancellationToken>,
    tool_batch_active: bool,
    terminal_drain_required: bool,
    operation_interrupted: bool,
}

impl ActiveCancellation {
    fn activate_request(&mut self) -> CancellationToken {
        let token = CancellationToken::new();
        self.set_request(Some(token.clone()));
        token
    }

    fn set_request(&mut self, token: Option<CancellationToken>) {
        self.request = token;
        if self.request.is_none() {
            // An interruption marker is meaningful only within the request
            // whose active operation observed it.
            self.operation_interrupted = false;
            self.tool_batch_active = false;
            self.terminal_drain_required = false;
        }
    }

    fn set_tool(&mut self, token: Option<CancellationToken>, terminal_drain_required: bool) {
        if let Some(token) = token.as_ref() {
            if self.operation_interrupted {
                token.cancel();
            }
            self.terminal_drain_required |= terminal_drain_required;
        }
        self.tool = token;
    }

    fn finish_tool_batch(&mut self) -> bool {
        self.tool_batch_active = false;
        self.terminal_drain_required = false;
        std::mem::take(&mut self.operation_interrupted)
    }
}

fn cancel_active_operation(active_cancellation: &Arc<Mutex<ActiveCancellation>>) {
    let mut active = active_cancellation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(token) = active.tool.as_ref() {
        token.cancel();
        active.operation_interrupted = true;
    } else if let Some(token) = active.approval.as_ref() {
        token.cancel();
        active.operation_interrupted = true;
    } else if active.tool_batch_active {
        // The assistant ToolUse message is already in provider history.
        // Let the runner reach a cleanup boundary and repair/close every call
        // instead of dropping the request future from the outer selector.
        active.operation_interrupted = true;
    } else if let Some(token) = active.request.as_ref() {
        token.cancel();
    }
}

fn prompt_kind_starts_main_request(kind: PromptKind) -> bool {
    kind != PromptKind::SideQuestion
}

fn should_defer_prompt_command(kind: PromptKind, cancellation_seen: bool) -> bool {
    kind == PromptKind::Prompt || (cancellation_seen && prompt_kind_starts_main_request(kind))
}

fn append_completed_thinking_block(
    assistant_content: &mut Vec<ContentBlock>,
    current_thinking: &mut String,
    thinking_signature: Option<String>,
) {
    // An omitted thinking block has empty text but still carries the signed
    // encrypted payload needed when this assistant turn is replayed. Keep it
    // whenever a signature arrived, even though no thinking delta was emitted.
    if !current_thinking.is_empty() || thinking_signature.is_some() {
        assistant_content.push(ContentBlock::Thinking {
            thinking: std::mem::take(current_thinking),
            signature: thinking_signature,
        });
    }
}

impl NativeAgent {
    /// Install the exact reviewed child history only if the original is still
    /// unchanged and idle. Credential references retain their existing vault.
    pub fn apply_selective_summary(
        &self,
        messages: Vec<Message>,
        expected_history_digest: String,
    ) -> Result<oneshot::Receiver<Result<()>>> {
        let (reply, receiver) = oneshot::channel();
        self.command_tx
            .send(AgentCommand::ApplySelectiveSummary {
                messages,
                digest: expected_history_digest,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("Agent is unavailable"))?;
        Ok(receiver)
    }

    /// Preview authoritative provider turns without changing the conversation.
    pub fn start_selective_summary_preview(
        &self,
    ) -> Result<oneshot::Receiver<Result<super::SelectiveSummaryPreview>>> {
        let (reply, receiver) = oneshot::channel();
        self.command_tx
            .send(AgentCommand::SelectiveSummaryPreview { reply })
            .map_err(|_| anyhow::anyhow!("Agent is unavailable"))?;
        Ok(receiver)
    }

    /// Request a proposed child history. Cancel explicitly and retain the receiver
    /// to account for any usage already reported by the provider.
    pub fn start_selective_summary(
        &self,
        selection: super::RangeSelection,
        expected_history_digest: String,
    ) -> Result<super::SelectiveSummaryRequest> {
        self.start_selective_summary_with_instructions(selection, expected_history_digest, None)
    }

    pub fn start_selective_summary_with_instructions(
        &self,
        selection: super::RangeSelection,
        expected_history_digest: String,
        instructions: Option<String>,
    ) -> Result<super::SelectiveSummaryRequest> {
        let (reply, receiver) = oneshot::channel();
        let cancellation = CancellationToken::new();
        self.command_tx
            .send(AgentCommand::SelectiveSummary {
                selection,
                digest: expected_history_digest,
                instructions,
                cancellation: cancellation.clone(),
                reply,
            })
            .map_err(|_| anyhow::anyhow!("Agent is unavailable"))?;
        Ok(super::SelectiveSummaryRequest {
            receiver,
            cancellation,
        })
    }

    /// Start the actor with the host's resolved provider, tool, and policy decisions.
    pub fn start_with_resolved_client(
        config: NativeAgentConfig,
        host: NativeExecutionHostHandle,
        external_tool_definitions: Vec<ToolDefinition>,
        credential_vault: CredentialVault,
        allowed_tools: Option<&HashSet<String>>,
        resolved_client: NativeResolvedClient,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        if let Some(allowed_tools) = allowed_tools {
            validate_governed_tools_with_host(
                host.clone(),
                allowed_tools,
                &external_tool_definitions,
            )?;
        }
        let policy_id = policy_model_id(&config.model);
        if let Some(reason) = host.model_allowed(&policy_id) {
            return Err(anyhow::anyhow!(reason));
        }

        let NativeResolvedClient {
            client,
            provider_name,
            model_route,
        } = resolved_client;

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, tool_response_rx) = mpsc::unbounded_channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let shutdown_token = CancellationToken::new();
        // The host has already composed the concrete registry.  Copy only its
        // immutable model-facing projection; the runner never owns a second
        // registry or dispatch path.
        let mut tools: HashMap<String, ToolDefinition> = host
            .tool_definitions()
            .into_iter()
            .filter(|td| {
                allowed_tools.is_none_or(|allowed| allowed.contains(&td.tool.name.to_lowercase()))
            })
            .map(|td| (td.tool.name.clone(), td))
            .collect();
        let external_tools = external_tool_definitions
            .iter()
            .map(|definition| definition.tool.name.to_lowercase())
            .collect::<HashSet<_>>();
        for definition in external_tool_definitions {
            tools.insert(definition.tool.name.to_lowercase(), definition);
        }
        let goal_tools_visible = host.goal_tools_visible();
        let include_ide_tools = host.include_ide_tools();
        let tool_profile = ToolProfile::from_env();
        let explicitly_allowed_tools = allowed_tools.cloned().unwrap_or_default();
        let active_tool_names =
            initial_active_tool_names(tool_profile, &tools, &external_tools, allowed_tools);
        let runtime_audit = Arc::new(RwLock::new(RuntimeAuditSnapshot {
            request_cache: None,
            cache_reuse: None,
            request_context: None,
            excluded_context_tools: HashSet::new(),
            prompt_revision: 0,
            system_prompt: config.system_prompt.clone(),
            tools: effective_tool_definitions(
                &tools,
                &active_tool_names,
                goal_tools_visible,
                include_ide_tools,
            ),
        }));

        // Tool execution, hook loading, identity binding, and policy all live
        // in the host adapter.  The loop keeps two handles only for source
        // compatibility with the existing call sites; both point to this one
        // concrete host and therefore cannot execute a second path.
        let tool_executor = host.clone();
        let hooks = host.clone();

        // Create the agent extension registry. Loop behaviors -- doom-loop and
        // rate-limit enforcement today -- are registered tenants, not branches
        // inside `run_loop`. See `docs/agent-extensions.md`.
        let dynamics = Arc::new(std::sync::Mutex::new(
            super::model_dynamics::DynamicsState::default(),
        ));
        let mut extensions = ExtensionRegistry::with_default_tenants();
        extensions.register(Box::new(
            super::extensions::model_dynamics::ModelDynamicsExtension::new(
                Arc::clone(&dynamics),
                event_tx.clone(),
            ),
        ));

        // Create context compactor for handling long conversations
        let compactor = super::compaction::ContextCompactor::new(
            super::compaction::CompactionConfig::for_model(
                &config.model,
                config
                    .context_window
                    .or_else(|| host.model_context_window(&config.model)),
            ),
        );

        // Create retry policy for transient API errors
        let retry_policy = super::retry::RetryPolicy::new(config.retry_config.clone());

        // Create message queue for pending prompts (bounded)
        let pending_messages = MessageQueue::with_max_size(MAX_PENDING_MESSAGES);
        // The runner drains this queue between tool calls. A tool that blocks
        // holds the turn past that point, so blocking tools get the queue's
        // steering signal and stop waiting when a user message lands.
        tool_executor.set_steer_signal(pending_messages.steer_signal());
        let active_cancellation = Arc::new(Mutex::new(ActiveCancellation::default()));
        let managed_run_id = Uuid::new_v4().to_string();

        // The composing host owns product telemetry.  The runtime forwards the
        // exact event stream once; a TUI/headless consumer may record or render
        // it without introducing a second loop or event transformation layer.

        let runner = NativeAgentRunner {
            client,
            model_route,
            codex_session: None,
            codex_history_restore_prefix_len: None,
            codex_active_turn_id: None,
            codex_current_prompt_started: false,
            managed_run_id: managed_run_id.clone(),
            next_managed_turn_id: 0,
            config: config.clone(),
            messages: Arc::new(Vec::new()),
            tools,
            model_tool_cache: None,
            goal_tools_visible,
            include_ide_tools,
            tool_profile,
            explicitly_allowed_tools,
            active_tool_names,
            external_tools,
            tool_executor,
            credential_vault,
            event_tx: event_tx.clone(),
            tool_response_coordinator: ToolResponseCoordinator::new(tool_response_rx),
            command_rx,
            busy: false,
            cancel_token: None,
            active_cancellation: Arc::clone(&active_cancellation),
            shutdown_token: shutdown_token.clone(),
            clear_pending_on_cancel: true,
            hooks,
            owns_persistent_tool_spills: false,
            extensions,
            dynamics,
            boost_original: None,
            current_turn_id: String::new(),
            turn_index: 0,
            turn_tool_calls: 0,
            denial_memory: DenialMemory::new(),
            workflow_state: WorkflowStateTracker::default(),
            compactor,
            semantic_continuation: None,
            retry_policy,
            pending_messages,
            steering_mode: QueueMode::All,
            follow_up_mode: QueueMode::All,
            deferred_commands: VecDeque::new(),
            pending_user_note_consumptions: Vec::new(),
            active_user_note_consumptions: Vec::new(),
            pending_user_note_texts: Vec::new(),
            active_user_note_texts: Vec::new(),
            current_request_user_message_index: None,
            processed_prompt_queue_ids: HashSet::new(),
            prompt_context: None,
            output_token_budget: None,
            output_tokens_spent: 0,
            process_budget: None,
            queued_system_prompts: HashMap::new(),
            system_prompt_revision: 0,
            runtime_prompt_revision: 0,
            runtime_audit: Arc::clone(&runtime_audit),
            codex_file_change_paths_by_item: HashMap::new(),
            codex_native_tools_by_item: HashMap::new(),
            codex_native_pending_completions: HashMap::new(),
        };

        let host = runner.tool_executor.clone();

        // Spawn the background task
        let runner_handle = tokio::spawn(async move {
            runner.run().await;
        });

        let agent = Self {
            host,
            managed_run_id,
            command_tx,
            tool_response_tx,
            active_cancellation,
            event_tx,
            model_name: config.model,
            provider_name,
            runtime_audit,
            shutdown_token,
            runner_handle: Some(runner_handle),
        };

        Ok((agent, event_rx))
    }

    /// Stable actor identity used by host telemetry and request lineage.
    #[must_use]
    pub fn managed_run_id(&self) -> &str {
        &self.managed_run_id
    }

    /// Validate and replace the externally governed tool catalog for the next command boundary.
    pub fn replace_governed_tools(
        &self,
        allowed_tools: HashSet<String>,
        external_tool_definitions: Vec<ToolDefinition>,
    ) -> Result<()> {
        validate_governed_tools_with_host(
            self.host.clone(),
            &allowed_tools,
            &external_tool_definitions,
        )?;
        self.command_tx
            .send(AgentCommand::ReplaceGovernedTools {
                allowed_tools,
                external_tool_definitions,
            })
            .map_err(|_| anyhow::anyhow!("Agent command channel closed"))
    }

    /// Get the sender for tool responses
    #[must_use]
    pub fn tool_response_sender(&self) -> mpsc::UnboundedSender<ToolResponseMessage> {
        self.tool_response_tx.clone()
    }

    /// Send the ready event
    pub fn send_ready(&self) {
        let _ = self.event_tx.send(FromAgent::Ready {
            model: self.model_name.clone(),
            provider: self.provider_name.clone(),
        });
    }

    /// Send session info (cwd, git branch, etc.)
    pub fn send_session_info(
        &self,
        cwd: &str,
        session_id: Option<String>,
        git_branch: Option<String>,
    ) {
        let _ = self.event_tx.send(FromAgent::SessionInfo {
            session_id,
            cwd: cwd.to_string(),
            git_branch,
        });
    }

    /// Process a user prompt (non-blocking - sends to background task)
    ///
    /// Sends a prompt to the background agent runner and returns immediately.
    /// The actual AI request happens asynchronously, with results arriving via
    /// the event channel as `FromAgent::ResponseChunk` messages.
    ///
    /// # Parameters
    ///
    /// - `content`: The user's message/prompt
    /// - `attachments`: File paths to attach (images or text files)
    ///
    /// # Returns
    ///
    /// `Ok(())` if the command was sent successfully, `Err` if the channel is closed.
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// agent.prompt("Explain async/await in Rust".to_string(), vec![]).await?;
    /// // Returns immediately, response arrives via events
    /// ```
    pub async fn prompt(&self, content: String, attachments: Vec<String>) -> Result<()> {
        self.prompt_with_kind(content, attachments, PromptKind::Prompt, None)
            .await
    }

    /// Send a prompt with an explicit kind (prompt/steer/follow-up).
    pub async fn prompt_with_kind(
        &self,
        content: String,
        attachments: Vec<String>,
        kind: PromptKind,
        queue_id: Option<u64>,
    ) -> Result<()> {
        self.prompt_with_kind_and_lineage(content, attachments, kind, queue_id, None)
            .await
    }

    /// Send a prompt with correlation bound to the prompt rather than session state.
    pub async fn prompt_with_kind_and_lineage(
        &self,
        content: String,
        attachments: Vec<String>,
        kind: PromptKind,
        queue_id: Option<u64>,
        managed_request_lineage: Option<String>,
    ) -> Result<()> {
        self.prompt_with_kind_and_managed_context(
            content,
            attachments,
            kind,
            queue_id,
            managed_request_lineage,
            None,
        )
        .await
    }

    /// Send a prompt with managed correlation and authorization bound to it.
    pub async fn prompt_with_kind_and_managed_context(
        &self,
        content: String,
        attachments: Vec<String>,
        kind: PromptKind,
        queue_id: Option<u64>,
        managed_request_lineage: Option<String>,
        managed_inference_authorization: Option<ManagedInferenceAuthorization>,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::Prompt {
                content,
                attachments,
                kind,
                queue_id,
                managed_request_lineage,
                managed_inference_authorization,
            })
            .map_err(|e| anyhow::anyhow!("Failed to send prompt: {e}"))?;
        Ok(())
    }

    pub async fn requeue_follow_up_front(
        &self,
        content: String,
        attachments: Vec<String>,
        queue_id: u64,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::RequeueFollowUpFront {
                content,
                attachments,
                queue_id,
                managed_request_lineage: None,
            })
            .map_err(|e| anyhow::anyhow!("Failed to requeue follow-up: {e}"))?;
        Ok(())
    }

    /// Cancel the current operation
    pub fn cancel(&self) {
        self.cancel_with_options(true);
    }

    /// Cancel all queued and active work, close the command channel, and wait
    /// for the background runner to exit.
    ///
    /// This is a lifecycle barrier:
    /// buffered work must be preempted, active tool cleanup must finish, and
    /// the runner task must return before this future completes. The external
    /// repeat-signal monitor remains the hard escape hatch if platform cleanup
    /// itself wedges.
    pub async fn shutdown(mut self) {
        self.shutdown_token.cancel();
        self.cancel_with_options(true);
        let runner_handle = self.runner_handle.take();
        drop(self.command_tx);
        if let Some(runner_handle) = runner_handle {
            let _ = runner_handle.await;
        }
    }

    /// Cancel the current operation but keep any queued prompts.
    pub fn cancel_keep_queue(&self) {
        self.cancel_with_options(false);
    }

    pub fn cancel_queued(&self, id: u64) {
        let _ = self.command_tx.send(AgentCommand::CancelQueued { id });
    }

    pub fn reorder_queued(&self, id: u64, placement: QueuePlacement) {
        let _ = self
            .command_tx
            .send(AgentCommand::ReorderQueued { id, placement });
    }

    fn cancel_with_options(&self, clear_pending: bool) {
        // Preserve channel order before synchronously waking the runner. The
        // runner can then drain every prompt queued before this cancellation.
        let _ = self.command_tx.send(AgentCommand::Cancel { clear_pending });
        cancel_active_operation(&self.active_cancellation);
    }

    /// Clear conversation history
    pub fn clear_history(&self) {
        let _ = self.command_tx.send(AgentCommand::ClearHistory);
    }

    /// Replace conversation history with the provided messages.
    pub fn replace_history(&self, messages: Vec<Message>) {
        self.replace_history_with_continuation(messages, None);
    }

    pub fn replace_history_with_continuation(
        &self,
        messages: Vec<Message>,
        continuation: Option<super::compaction::ContinuationRecord>,
    ) {
        let _ = self.command_tx.send(AgentCommand::ReplaceHistory {
            messages,
            continuation,
        });
    }

    /// Replace conversation history while retaining credentials supplied by
    /// the parent runner for a delegated child resume.
    pub fn replace_history_preserving_credentials(&self, messages: Vec<Message>) {
        let _ = self
            .command_tx
            .send(AgentCommand::ReplaceHistoryPreservingCredentials { messages });
    }

    /// Append a host tool/user note to history without starting a turn.
    ///
    /// Callers must only flush these when the agent is idle so provider
    /// message order stays valid (no user turn between tool results).
    pub fn inject_user_note(
        &self,
        content: impl Into<String>,
    ) -> Result<(
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Receiver<()>,
    )> {
        let content = content.into();
        if content.trim().is_empty() {
            anyhow::bail!("Cannot inject an empty user note");
        }
        let (applied, applied_receiver) = tokio::sync::oneshot::channel();
        let (consumed, consumed_receiver) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(AgentCommand::InjectUserNote {
                content,
                applied,
                consumed,
            })
            .map_err(|error| anyhow::anyhow!("Failed to inject user note: {error}"))?;
        Ok((applied_receiver, consumed_receiver))
    }

    /// Set the model
    pub fn set_model(&self, model: impl Into<String>) -> Result<()> {
        let model = model.into();
        self.command_tx
            .send(AgentCommand::SetModel { model })
            .map_err(|e| anyhow::anyhow!("Failed to set model: {e}"))?;
        Ok(())
    }

    /// Refresh context and catalog-derived output limits for the active model.
    pub fn refresh_model_budgets(&self) -> Result<()> {
        self.command_tx
            .send(AgentCommand::RefreshModelBudgets)
            .map_err(|e| anyhow::anyhow!("Failed to refresh model budgets: {e}"))
    }

    /// Request a bounded boost at the next safe provider request boundary.
    pub fn boost(&self) -> Result<()> {
        self.command_tx
            .send(AgentCommand::Boost)
            .map_err(|e| anyhow::anyhow!("Failed to request boost: {e}"))
    }

    /// Set thinking level
    pub fn set_thinking(&self, enabled: bool, budget: u32) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetThinking { enabled, budget })
            .map_err(|e| anyhow::anyhow!("Failed to set thinking: {e}"))?;
        Ok(())
    }

    /// Set the per-request output-token limit.
    ///
    /// The limit applies to each provider response, so a caller that owns a
    /// budget for an entire run must lower it between requests. The runner
    /// drains this command in its tool loop, so it takes effect on the next
    /// request it builds.
    pub fn set_max_tokens(&self, max_tokens: u32) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetMaxTokens { max_tokens })
            .map_err(|e| anyhow::anyhow!("Failed to set max tokens: {e}"))?;
        Ok(())
    }

    /// Install the signed per-event budget and wait for native acknowledgement.
    /// An existing checkpoint retains spent usage across agent replacement.
    pub async fn install_process_budget(
        &self,
        limits: super::process_budget::ProcessBudgetLimits,
        checkpoint: Option<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>>,
    ) -> Result<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>> {
        let (applied, receiver) = oneshot::channel();
        self.command_tx
            .send(AgentCommand::InstallProcessBudget {
                limits,
                checkpoint,
                applied,
            })
            .map_err(|_| anyhow::anyhow!("process budget runner unavailable"))?;
        receiver
            .await
            .context("process budget admission was not acknowledged")?
    }

    /// Retire Process authority at an inactive, verified grant boundary.
    /// Acknowledgement covers both budget removal and the ordinary system prompt.
    pub async fn clear_process_budget(&self, system_prompt: String) -> Result<()> {
        let (applied, receiver) = oneshot::channel();
        self.command_tx
            .send(AgentCommand::ClearProcessBudget {
                system_prompt,
                applied,
            })
            .map_err(|_| anyhow::anyhow!("process budget runner unavailable"))?;
        receiver
            .await
            .context("process budget retirement was not acknowledged")?
    }

    /// Cap cumulative output tokens before the prompt they apply to.
    pub fn set_output_token_budget(&self, max_total_output_tokens: u32) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetOutputTokenBudget {
                max_total_output_tokens,
            })
            .map_err(|e| anyhow::anyhow!("Failed to set output token budget: {e}"))?;
        Ok(())
    }

    /// Stage a system prompt for the next queued prompt to start.
    ///
    /// Applied when the runner prepares the next pending message, so it does
    /// not change the turn that is running when it is sent. Superseded by any
    /// later `set_system_prompt`, which is authoritative.
    pub fn set_system_prompt_for_queued_prompt(
        &self,
        queue_id: u64,
        system_prompt: String,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSystemPromptForQueuedPrompt {
                queue_id,
                system_prompt,
            })
            .map_err(|e| anyhow::anyhow!("Failed to set queued system prompt: {e}"))?;
        Ok(())
    }

    /// Point the runner's tool executor at a different subagent scope.
    ///
    /// Send this whenever the caller rotates its own scope, so children started
    /// after the change are stamped with the scope the caller now drains.
    pub fn set_subagent_parent_scope(&self, parent_scope_id: String) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSubagentParentScope { parent_scope_id })
            .map_err(|e| anyhow::anyhow!("Failed to set subagent parent scope: {e}"))?;
        Ok(())
    }

    /// Tell the runner which conversation is active.
    ///
    /// Stamps the session id onto subsequent hook payloads and dispatches the
    /// `SessionEnd` / `SessionStart` hooks for the transition. Pass `None` to
    /// report that the active session ended without a replacement. Set
    /// `owns_persistent_tool_spills` only when a durable session owner also
    /// owns deletion of that session's spill directory.
    pub fn set_session_context(
        &self,
        session_id: Option<String>,
        reason: impl Into<String>,
        owns_persistent_tool_spills: bool,
    ) -> Result<()> {
        self.set_session_context_with_transcript(
            session_id,
            None,
            reason,
            owns_persistent_tool_spills,
        )
    }

    /// Tell the runner which persisted conversation and transcript are active.
    pub fn set_session_context_with_transcript(
        &self,
        session_id: Option<String>,
        transcript_path: Option<String>,
        reason: impl Into<String>,
        owns_persistent_tool_spills: bool,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSessionContext {
                session_id,
                transcript_path,
                reason: reason.into(),
                owns_persistent_tool_spills,
                preserve_compacted_checkpoint: false,
            })
            .map_err(|e| anyhow::anyhow!("Failed to set session context: {e}"))?;
        Ok(())
    }

    /// Continue a reviewed summary checkpoint in its newly persisted child.
    /// Unrelated session changes must use the reset-by-default method above.
    pub fn set_compacted_session_context_with_transcript(
        &self,
        session_id: String,
        transcript_path: Option<String>,
        owns_persistent_tool_spills: bool,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSessionContext {
                session_id: Some(session_id),
                transcript_path,
                reason: "summarize".into(),
                owns_persistent_tool_spills,
                preserve_compacted_checkpoint: true,
            })
            .map_err(|e| anyhow::anyhow!("Failed to adopt compacted session context: {e}"))?;
        Ok(())
    }

    /// Enable hook event logging to `path` (test harness / diagnostics).
    pub fn set_hook_log_file(&self, path: impl Into<String>) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetHookLogFile { path: path.into() })
            .map_err(|e| anyhow::anyhow!("Failed to set hook log file: {e}"))?;
        Ok(())
    }

    /// Set whether the goal lifecycle tools are exposed to the model.
    pub fn set_goal_tools_visible(&self, visible: bool) {
        let _ = self
            .command_tx
            .send(AgentCommand::SetGoalToolsVisible { visible });
    }

    /// Set the active approval mode.
    ///
    /// The runner is the sole owner of the tool-execution approval decision;
    /// callers with their own approval UI (interactive TUI, headless server)
    /// must call this whenever their user-facing mode selector changes so the
    /// runner's inline auto-execute gate stays consistent with what the UI
    /// tells the user will happen.
    pub fn set_approval_mode(&self, mode: ApprovalMode) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetApprovalMode { mode })
            .map_err(|e| anyhow::anyhow!("Failed to set approval mode: {e}"))?;
        Ok(())
    }

    /// Set steering queue drain mode.
    pub fn set_steering_mode(&self, mode: QueueMode) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSteeringMode { mode })
            .map_err(|e| anyhow::anyhow!("Failed to set steering mode: {e}"))?;
        Ok(())
    }

    /// Set follow-up queue drain mode.
    pub fn set_follow_up_mode(&self, mode: QueueMode) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetFollowUpMode { mode })
            .map_err(|e| anyhow::anyhow!("Failed to set follow-up mode: {e}"))?;
        Ok(())
    }

    /// Replace the base system prompt
    pub fn set_system_prompt(&self, system_prompt: impl Into<String>) -> Result<()> {
        let system_prompt = system_prompt.into();
        self.command_tx
            .send(AgentCommand::SetSystemPrompt { system_prompt })
            .map_err(|e| anyhow::anyhow!("Failed to set system prompt: {e}"))?;
        Ok(())
    }

    /// Wait until the active provider has accepted the current standing prompt.
    pub async fn ensure_provider_prompt_installed(&self) -> Result<()> {
        let (applied, receiver) = tokio::sync::oneshot::channel();
        self.command_tx
            .send(AgentCommand::EnsureProviderPromptInstalled { applied })
            .map_err(|error| {
                anyhow::anyhow!("Failed to request provider prompt install: {error}")
            })?;
        receiver
            .await
            .map_err(|error| {
                anyhow::anyhow!("Provider prompt install acknowledgement dropped: {error}")
            })?
            .map_err(anyhow::Error::msg)
    }

    pub fn set_context_tool_excluded(&self, name: String, excluded: bool) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetContextToolExcluded { name, excluded })
            .map_err(|_| anyhow::anyhow!("The agent is not running."))
    }

    #[must_use]
    pub fn runtime_audit_snapshot(&self) -> RuntimeAuditSnapshot {
        self.runtime_audit
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Restore diagnostic hashes from this session, before its first request.
    pub fn restore_request_cache(
        &self,
        snapshot: Option<maestro_context::token_counting::RequestCacheSnapshot>,
    ) {
        let mut audit = self
            .runtime_audit
            .write()
            .unwrap_or_else(|p| p.into_inner());
        audit.request_cache = snapshot;
        audit.cache_reuse = None;
    }

    /// Continue from current context without a new user message
    ///
    /// Used for:
    /// - Retrying after transient errors (rate limits, 5xx errors, overload)
    /// - Continuing after context compaction
    /// - Resuming interrupted tool execution
    ///
    /// # Returns
    ///
    /// `Ok(())` if the continue command was sent, `Err` if the channel is closed.
    pub fn continue_execution(&self) -> Result<()> {
        self.command_tx
            .send(AgentCommand::Continue)
            .map_err(|e| anyhow::anyhow!("Failed to send continue: {e}"))?;
        Ok(())
    }
}

async fn wait_for_retry_delay(
    delay: std::time::Duration,
    request_cancel: &CancellationToken,
    shutdown_token: &CancellationToken,
) -> bool {
    tokio::select! {
        () = tokio::time::sleep(delay) => true,
        () = request_cancel.cancelled() => false,
        () = shutdown_token.cancelled() => false,
    }
}

async fn wait_for_codex_auth_refresh(
    host: &NativeExecutionHostHandle,
    auth_path: &std::path::Path,
    request_cancel: &CancellationToken,
    shutdown_token: &CancellationToken,
    max_wait: Duration,
) -> bool {
    let baseline = tokio::fs::read(auth_path).await.ok();
    let wait = async {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let current = tokio::fs::read(auth_path).await.ok();
            if current != baseline && host.codex_auth_is_usable(auth_path) {
                return true;
            }
        }
    };
    tokio::select! {
        result = tokio::time::timeout(max_wait, wait) => result.unwrap_or(false),
        () = request_cancel.cancelled() => false,
        () = shutdown_token.cancelled() => false,
    }
}

enum CancellableLoad<T> {
    Loaded(T),
    RequestCancelled,
    Shutdown,
}

async fn load_until_cancelled<F, T>(
    load: F,
    request_cancel: &CancellationToken,
    shutdown_token: &CancellationToken,
) -> CancellableLoad<T>
where
    F: Future<Output = T>,
{
    tokio::pin!(load);
    tokio::select! {
        biased;
        () = shutdown_token.cancelled() => CancellableLoad::Shutdown,
        () = request_cancel.cancelled() => CancellableLoad::RequestCancelled,
        loaded = &mut load => CancellableLoad::Loaded(loaded),
    }
}

const SHUTDOWN_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const CODEX_SIDE_QUESTION_TIMEOUT: Duration = Duration::from_mins(2);
const CODEX_SIDE_QUESTION_MAX_CONTEXT_TOKENS: u64 = 20_000;

async fn run_request_with_cancellation<F>(
    request: F,
    request_cancel: &CancellationToken,
    shutdown_token: &CancellationToken,
    active_cancellation: &Arc<Mutex<ActiveCancellation>>,
) -> Result<()>
where
    F: Future<Output = Result<()>>,
{
    tokio::pin!(request);
    tokio::select! {
        biased;
        () = shutdown_token.cancelled() => {
            let terminal_drain_required = || {
                active_cancellation
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .terminal_drain_required
            };
            if terminal_drain_required() {
                // A mutating native tool may already have committed its
                // workspace change before bounded follow-up work (for example
                // LSP diagnostics) finishes. Keep the request alive through
                // batch cleanup so its one receipt-bearing terminal remains
                // truthful and cannot invite a duplicate retry.
                (&mut request).await
            } else {
                // Provider and legacy waits that have not crossed a mutating
                // native boundary retain bounded shutdown. Recheck after the
                // bound because polling the request may have crossed into a
                // mutating tool after shutdown won the outer selector.
                match tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, &mut request).await {
                    Ok(result) => result,
                    Err(_) if terminal_drain_required() => (&mut request).await,
                    Err(_) => Err(anyhow::anyhow!("Request cancelled")),
                }
            }
        }
        () = request_cancel.cancelled() => {
            Err(anyhow::anyhow!("Request cancelled"))
        }
        result = &mut request => result,
    }
}

fn native_tool_requires_terminal_drain(
    _tool_executor: &NativeExecutionHostHandle,
    tool_name: &str,
    args: &serde_json::Value,
) -> bool {
    let action = || args.get("action").and_then(serde_json::Value::as_str);

    match tool_name.to_ascii_lowercase().as_str() {
        // Shell syntax admits filesystem and process effects that cannot be
        // exhaustively proven read-only. Bash execution consumes shutdown
        // cancellation and reaps its process tree, so conservatively retain
        // its receipt-bearing terminal independent of approval-version pins.
        "bash" => true,
        "write" | "notebook_edit" | "todo" => true,
        "edit" => !args
            .get("dryRun")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        "background_tasks" => matches!(action(), Some("start" | "stop")),
        "gh_pr" => matches!(action(), Some("create" | "checkout" | "comment")),
        "gh_issue" => matches!(action(), Some("create" | "comment" | "close")),
        "gh_repo" => matches!(action(), Some("fork" | "clone")),
        // These built-ins are observation-only even when a separate policy
        // asks for approval (for example screenshot capture).
        "read"
        | "glob"
        | "grep"
        | "diff"
        | "list"
        | "find"
        | "search"
        | "parallel_ripgrep"
        | "websearch"
        | "codesearch"
        | "status"
        | "ask_user"
        | "extract_document"
        | "web_fetch"
        | "webfetch"
        | "read_image"
        | "screenshot"
        | "mcp_list_resources"
        | "mcp_list_prompts"
        | "mcp_read_resource"
        | "mcp_get_prompt"
        | "vscode_get_diagnostics"
        | "vscode_get_definition"
        | "vscode_find_references"
        | "vscode_read_file_range"
        | "jetbrains_get_diagnostics"
        | "jetbrains_get_definition"
        | "jetbrains_find_references"
        | "jetbrains_read_file_range" => false,
        // Unknown serial extensions are conservatively receipt-bearing.
        // Explicit read-only inline tools are drained by the parallel wave
        // before reaching this path.
        _ => true,
    }
}

fn command_after_shutdown_check(
    command: AgentCommand,
    shutdown_token: &CancellationToken,
) -> Option<AgentCommand> {
    (!shutdown_token.is_cancelled()).then_some(command)
}

/// The background agent runner that owns mutable state
///
/// This struct is private to the module and runs in a background tokio task.
/// It owns all mutable state (conversation history, configuration) and is the
/// only component that makes AI API calls.
///
/// # Ownership and Mutability
///
/// The runner is moved into `tokio::spawn` and owns:
/// - Conversation history (Vec<Message>)
/// - Configuration (`NativeAgentConfig`)
/// - AI client (`UnifiedClient`)
/// - All channel receivers
///
/// This ensures exclusive ownership and prevents data races - only the background
/// task can modify the agent state.
///
/// # Event Loop
///
/// The `run()` method processes commands in an event loop:
///
/// ```text
/// loop {
///     match command_rx.recv().await {
///         Prompt => run_loop() to handle AI request,
///         Cancel => trigger cancellation token,
///         SetModel => update client,
///         SetSystemPrompt => update base system prompt,
///         ClearHistory => clear messages,
///     }
/// }
/// ```
struct NativeAgentRunner {
    /// Direct AI client for HTTP-provider turns.
    ///
    /// This is absent for Codex app-server models: Codex app-server owns the
    /// ChatGPT login and all turn transport for those models.
    client: Option<UnifiedClient>,

    /// Live Codex app-server session for `openai-codex/*` models.
    ///
    /// Lazily created on the first prompt so ChatGPT OAuth refresh and
    /// `thread/start` / `turn/start` stay owned by Codex.
    codex_session: Option<super::codex_app_server_turns::CodexAppServerTurnSession>,

    /// Number of restored messages owned by the next fresh Codex thread.
    ///
    /// Captured when history is replaced and consumed after a successful
    /// `thread/inject_items`, so prompts appended before lazy session startup
    /// remain live-turn input rather than restored history.
    codex_history_restore_prefix_len: Option<usize>,

    /// Whether the current live prompt crossed a successful Codex
    /// `turn/start` boundary. Pre-turn failures may be retried, but a terminal
    /// GiveUp must not persist an undelivered prompt as provider history.
    codex_current_prompt_started: bool,
    /// Stable identity for this managed-gateway request lineage.
    managed_run_id: String,
    /// Monotonic turn number within the agent run.
    next_managed_turn_id: u64,
    model_route: NativeModelRoute,

    /// Configuration
    ///
    /// Current agent settings. Updated via commands like `SetModel`,
    /// `SetThinking`, and `SetSystemPrompt`.
    config: NativeAgentConfig,

    /// Conversation history
    ///
    /// Stores all messages (user prompts, assistant responses, tool results)
    /// in the current conversation. Cleared via `ClearHistory` command.
    messages: Arc<Vec<Message>>,

    /// Tool definitions
    ///
    /// Map of tool name to tool definition. Loaded from the tool registry
    /// at startup and remains constant.
    tools: HashMap<String, ToolDefinition>,
    codex_active_turn_id: Option<String>,

    /// Cached model-facing tool schemas. The registry is immutable for the
    /// lifetime of a runner; only goal visibility and the IDE-tools flag can
    /// change the filtered view.
    model_tool_cache: Option<ModelToolCache>,

    /// Tool schemas currently exposed to the model. The native `tool_search`
    /// path expands this set on demand without rebuilding the executor.
    active_tool_names: HashSet<String>,

    /// The profile constrains dynamic discovery as well as initial schemas.
    tool_profile: ToolProfile,

    /// Built-ins explicitly requested by a caller may bypass profile defaults.
    explicitly_allowed_tools: HashSet<String>,

    /// Whether the current goal exposes `get_goal` and `update_goal`.
    /// Updated by explicit app synchronization and successful `update_goal`
    /// executions; it is intentionally not reloaded from disk per request.
    goal_tools_visible: bool,

    /// Whether the process opted into IDE-only tool schemas. This is static
    /// process configuration, so read it once when the runner is created.
    include_ide_tools: bool,

    /// Tools whose execution is owned by the calling client.
    external_tools: HashSet<String>,

    /// Tool executor for running tools
    ///
    /// Handles actual tool execution (bash, read, write, etc.) and determines
    /// which tools require approval based on command content.
    tool_executor: NativeExecutionHostHandle,

    /// Shared vault for this agent session and its tool executors.
    credential_vault: CredentialVault,

    /// Channel to send events to the TUI
    ///
    /// Used to stream response chunks, tool calls, errors, etc. back to the UI.
    event_tx: mpsc::UnboundedSender<FromAgent>,

    /// Caller-owned tool response state, including the receiver, keyed
    /// responses, and cancellation tombstones.
    tool_response_coordinator: ToolResponseCoordinator,

    /// Channel to receive commands
    ///
    /// Main input for the runner. Receives prompts, cancellation requests,
    /// configuration changes, etc.
    command_rx: mpsc::UnboundedReceiver<AgentCommand>,

    /// Whether currently processing
    ///
    /// Guards against concurrent prompts. Only one AI request can be active
    /// at a time.
    busy: bool,

    /// Cancellation token for the current request
    ///
    /// Created when a prompt starts, triggered when `Cancel` command arrives.
    /// Used with `tokio::select!` to support graceful cancellation.
    cancel_token: Option<CancellationToken>,

    /// Token mirror reachable from the public agent handle while the runner is
    /// blocked awaiting a tool.
    active_cancellation: Arc<Mutex<ActiveCancellation>>,

    /// Priority lifecycle signal checked before deferred or buffered commands.
    shutdown_token: CancellationToken,

    /// Whether a cancellation should also clear pending messages.
    clear_pending_on_cancel: bool,

    /// Hook system for tool interception
    ///
    /// Executes pre/post tool hooks for safety checks, logging, and context injection.
    /// Loaded from ~/.composer/hooks.toml and .composer/hooks.toml.
    hooks: NativeExecutionHostHandle,

    /// Whether the active session owns cleanup of persistent tool-output
    /// spills. An ephemeral session can still have a hook session id.
    owns_persistent_tool_spills: bool,

    /// Ordered agent extensions invoked at the loop's declared hook points.
    ///
    /// Doom-loop and rate-limit enforcement live here as the `doom-loop`
    /// tenant. New loop behavior is registered here rather than branched into
    /// `run_loop`; see `docs/agent-extensions.md`.
    extensions: ExtensionRegistry,
    dynamics: Arc<std::sync::Mutex<super::model_dynamics::DynamicsState>>,
    boost_original: Option<super::model_dynamics::ModelChoice>,

    /// Identifier of the turn `run_loop` is executing, carried in every
    /// extension hook context.
    current_turn_id: String,

    /// How many turns `run_loop` has started, including the current one.
    turn_index: u64,

    /// How many tool calls the current turn has planned.
    turn_tool_calls: u64,

    /// Tool calls the user refused during the current turn.
    ///
    /// A denied call with identical arguments is refused again without a
    /// second prompt, and every refusal is retired at the next user turn.
    denial_memory: DenialMemory,

    /// Workflow state tracker for PII redaction enforcement
    workflow_state: WorkflowStateTracker,

    /// Context compactor for handling long conversations
    ///
    /// Summarizes older messages when the context grows too large to fit
    /// within the model's token limit.
    compactor: super::compaction::ContextCompactor,
    semantic_continuation: Option<super::compaction::ContinuationRecord>,

    /// Retry policy for handling transient API errors
    ///
    /// Implements exponential backoff with jitter for rate limits and server errors.
    retry_policy: super::retry::RetryPolicy,

    /// Message queue for pending user prompts
    ///
    /// When the agent is busy processing a request, incoming prompts are queued
    /// instead of rejected. After each request completes, pending messages are
    /// automatically processed.
    pending_messages: MessageQueue,

    /// Queue drain mode for steering messages.
    steering_mode: QueueMode,

    /// Queue drain mode for follow-up messages.
    follow_up_mode: QueueMode,

    /// Commands observed while the agent is inside a turn and deferred until idle.
    deferred_commands: VecDeque<AgentCommand>,

    /// Applied notes waiting to be included in the next main model turn.
    pending_user_note_consumptions: Vec<tokio::sync::oneshot::Sender<()>>,

    /// Note acknowledgements assigned to the currently running main turn.
    active_user_note_consumptions: Vec<tokio::sync::oneshot::Sender<()>>,

    /// Exact note text paired with pending consumption acknowledgements.
    pending_user_note_texts: Vec<String>,

    /// Exact note text assigned to the currently running main turn.
    active_user_note_texts: Vec<String>,

    /// User message created for the current prompt, if this is a prompt turn.
    current_request_user_message_index: Option<usize>,

    /// Explicit queue ids represented by the next semantic checkpoint.
    processed_prompt_queue_ids: HashSet<u64>,

    /// Extra system prompt context for the current request
    ///
    /// Set by prompt-related hooks and cleared after each request completes.
    prompt_context: Option<String>,

    /// Cumulative output-token ceiling for the whole run, if a caller set one.
    ///
    /// Set by `SetOutputTokenBudget`. `None` means unbounded, which is the
    /// interactive default; the subagent scheduler sets it for delegated runs.
    output_token_budget: Option<u32>,

    /// Output tokens this runner has already spent against
    /// [`Self::output_token_budget`].
    output_tokens_spent: u64,
    process_budget: Option<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>>,

    /// System prompt staged for the next queued prompt to start, with the
    /// [`Self::system_prompt_revision`] that was current when it was staged.
    ///
    /// Populated by `SetSystemPromptForQueuedPrompt` and consumed in
    /// `prepare_pending_message`. A mismatched revision means an authoritative
    /// `SetSystemPrompt` landed after the staging, so the staged value is stale
    /// and dropped.
    queued_system_prompts: HashMap<u64, (u64, String)>,

    /// Bumped by every authoritative system-prompt update.
    ///
    /// Used only to detect that a staged queued prompt has been overtaken.
    system_prompt_revision: u64,

    /// Revision of the prompt actually applied to a model request.
    runtime_prompt_revision: u64,

    runtime_audit: Arc<RwLock<RuntimeAuditSnapshot>>,

    /// File-change correlation for Codex items, keyed by item id.
    ///
    /// v2 `item/fileChange/requestApproval` often carries only `itemId`. Paths
    /// and per-path metadata (kind, content, move_path, …) arrive on earlier
    /// item notifications; this map correlates them so the action firewall and
    /// path-sensitive policy hooks see the same full change set.
    codex_file_change_paths_by_item: CodexFileChangeItemCache,

    /// Approved Codex-native operations awaiting their authoritative
    /// `item/completed` notification, keyed by Codex item id.
    codex_native_tools_by_item: HashMap<String, CodexNativeToolCorrelation>,

    /// Native operation completions that arrived before their approval could
    /// record an item correlation, keyed by Codex item id.
    codex_native_pending_completions: HashMap<String, bool>,
}

/// itemId → path → per-path patch metadata (may be an empty object).
type CodexFileChangeItemCache = HashMap<String, Map<String, Value>>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct CodexNativeToolCorrelation {
    call_id: String,
    tool_name: String,
}

/// One finished Codex tool call, ready to be turned into a wire response.
struct CodexToolOutcome<'a> {
    tool_name: &'a str,
    call_id: &'a str,
    args: &'a Value,
    /// Raw tool output, which is what the hooks contract on.
    hook_output: &'a str,
    /// Model-facing body that injected context is appended to.
    result_text: String,
    is_error: bool,
    /// Context a `PreToolUse` hook asked to add to this call's result.
    pre_hook_context: Option<&'a str>,
    /// Wall-clock time the tool took, for the hooks' `durationMs`.
    duration_ms: u64,
}

/// Build standing instructions from caller context and the model selected for
/// this request. Rebuild from the base prompt so switches and retries never
/// accumulate stale model identities. Shared by HTTP and Codex transports.
#[must_use]
pub fn runtime_system_prompt(
    base: Option<&str>,
    context: Option<&str>,
    model: &str,
    mut capabilities: NativeModelCapabilities,
) -> Option<String> {
    let mut system = base.unwrap_or_default().to_owned();
    if let Some(context) = context.filter(|context| !context.trim().is_empty()) {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(context);
    }
    if !system.is_empty() {
        system.push_str("\n\n");
    }
    system.push_str("Your model is provided by Deixic.\n");
    let model = model.trim();
    if model.is_empty() {
        system.push_str("The current model identifier is unavailable. Do not guess it.");
    } else {
        system.push_str(&format!(
            "The model identifier selected for this request is {model:?}."
        ));
    }
    system.push_str(concat!(
        "\nDeixic provides the agent experience; this does not mean Deixic trained the underlying model. ",
        "A configured model identifier may be an alias; do not invent a more specific model identity."
    ));
    // A zero ceiling is missing metadata, never evidence of a zero-token model.
    capabilities.context_tokens = capabilities.context_tokens.filter(|tokens| *tokens > 0);
    capabilities.output_tokens = capabilities.output_tokens.filter(|tokens| *tokens > 0);
    system.push_str("\nCatalog-reported model capabilities (null means unknown; token limits are ceilings, not remaining budget):\n");
    system.push_str(&serde_json::json!(capabilities).to_string());
    system.push_str(concat!(
        "\nUse these facts to plan work in bounded chunks and keep responses within the runtime's limits. ",
        "If image input is unsupported, use an available tool to obtain text or ask for a text description. ",
        "Only the tools supplied for this request are available; model tool-calling support does not grant access. ",
        "Reasoning support does not say whether reasoning is enabled. ",
        "If the task needs capabilities or reasoning beyond this configuration, explain the concrete limitation ",
        "and ask the caller to adjust the model or reasoning settings. Do not claim a model or setting changed ",
        "until the runtime reports it. Do not infer capability, intelligence, price, or permission from a model name."
    ));
    ensure_untrusted_content_policy(Some(system))
}

/// The staged system prompt to apply to a queued message starting now.
///
/// `None` when nothing is staged, or when an authoritative `SetSystemPrompt`
/// arrived after the staging and bumped `current_revision`. In that case the
/// authoritative prompt is newer and, because skill activation is cumulative,
/// already contains the skills the staged one carried; applying the stale
/// snapshot would revert the newer update.
fn staged_system_prompt_to_apply(
    staged: Option<(u64, String)>,
    current_revision: u64,
) -> Option<String> {
    match staged {
        Some((staged_revision, prompt)) if staged_revision == current_revision => Some(prompt),
        _ => None,
    }
}

fn apply_staged_system_prompt(
    staged_prompts: &mut HashMap<u64, (u64, String)>,
    queue_id: u64,
    authority_revision: u64,
    system_prompt: &mut Option<String>,
    runtime_revision: &mut u64,
) -> bool {
    let Some(staged) =
        staged_system_prompt_to_apply(staged_prompts.remove(&queue_id), authority_revision)
    else {
        return false;
    };
    *system_prompt = Some(staged);
    *runtime_revision = runtime_revision.saturating_add(1);
    true
}

/// The tool name a Codex-native operation is presented to policy hooks under.
///
/// Codex runs these itself, so they have no entry in the Maestro tool registry.
/// A hook still has to be able to name them, and matching on the raw app-server
/// method would tie a policy to protocol spelling, so they are mapped to stable
/// names alongside the tools a hook already knows.
fn codex_native_policy_tool(method: &str) -> &'static str {
    match method {
        "item/fileChange/requestApproval" | "applyPatchApproval" => "codex_file_change",
        _ => "codex_command_execution",
    }
}

/// Characters of model-generated payload in a Codex-native operation request.
///
/// The approval request carries the command line or the patch the model wrote,
/// which is the model-produced half of the exchange. The matching
/// `item/completed` notification carries the operation's *output*, which is
/// input to the model rather than output from it and is deliberately not
/// counted here.
fn codex_native_operation_chars(params: Option<&Value>) -> u64 {
    params
        .and_then(|params| serde_json::to_string(params).ok())
        .map_or(0, |json| json.chars().count() as u64)
}

fn codex_completion_usage_value(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(map) => {
            if let Some(usage) = map.get("usage").filter(|value| value.is_object()) {
                return Some(usage);
            }
            map.values().find_map(codex_completion_usage_value)
        }
        Value::Array(values) => values.iter().find_map(codex_completion_usage_value),
        _ => None,
    }
}

fn usage_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

pub(super) fn codex_token_usage_from_completion(value: &Value) -> Option<TokenUsage> {
    let usage = codex_completion_usage_value(value)?;
    let input_tokens = usage_u64(
        usage,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "input",
        ],
    );
    let output_tokens = usage_u64(
        usage,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
            "output",
        ],
    );
    let cache_read_tokens = usage_u64(
        usage,
        &[
            "cache_read_tokens",
            "cacheReadTokens",
            "cachedInputTokens",
            "cached_tokens",
            "cachedTokens",
            "cache_read",
        ],
    )
    .or_else(|| {
        [
            "input_tokens_details",
            "inputTokensDetails",
            "prompt_tokens_details",
        ]
        .iter()
        .find_map(|key| {
            usage
                .get(*key)
                .and_then(|details| usage_u64(details, &["cached_tokens", "cachedTokens"]))
        })
    });
    let cache_write_tokens = usage_u64(
        usage,
        &[
            "cache_write_tokens",
            "cacheWriteTokens",
            "cacheWriteInputTokens",
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_write",
        ],
    );
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
    {
        return None;
    }
    Some(TokenUsage {
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        cache_read_tokens: cache_read_tokens.unwrap_or(0),
        cache_write_tokens: cache_write_tokens.unwrap_or(0),
        cost: usage_u64(usage, &["cost_micros"])
            .map(|micros| micros as f64 / 1_000_000.0)
            .or_else(|| usage.get("cost").and_then(Value::as_f64))
            .or_else(|| usage.get("total_cost_usd").and_then(Value::as_f64)),
    })
}

fn choose_codex_turn_usage(
    completion: &Value,
    usage_notifications: &[Value],
) -> Option<TokenUsage> {
    codex_token_usage_from_completion(completion).or_else(|| {
        usage_notifications
            .iter()
            .rev()
            .find_map(codex_token_usage_from_completion)
    })
}
/// The Codex `sandbox` value matching a Maestro sandbox policy.
///
/// Codex accepts `read-only`, `workspace-write`, and `danger-full-access` on
/// `thread/start`. `None` means the caller set no policy, which leaves the
/// Codex default in place.
fn codex_sandbox_mode(policy: Option<&maestro_sandbox::SandboxPolicy>) -> Option<String> {
    match policy? {
        maestro_sandbox::SandboxPolicy::ReadOnly => Some("read-only".to_owned()),
        maestro_sandbox::SandboxPolicy::WorkspaceWrite { .. } => Some("workspace-write".to_owned()),
        maestro_sandbox::SandboxPolicy::DangerFullAccess => Some("danger-full-access".to_owned()),
    }
}

/// Whether this configuration forbids the agent from changing anything.
///
/// Used to decline Codex-native mutation approvals outright. Codex is asked to
/// sandbox itself via `thread/start`, but that is an external process honoring
/// a request; refusing the approval RPC is enforcement inside Maestro.
fn config_denies_mutation(policy: Option<&maestro_sandbox::SandboxPolicy>) -> bool {
    matches!(policy, Some(maestro_sandbox::SandboxPolicy::ReadOnly))
}

/// Whether the active tool allowlist excludes the Codex-native operation.
///
/// A restrictive specialist profile such as `tools: [read, grep]` removes
/// Maestro mutation tools from the registry-facing set, but Codex-native
/// `commandExecution` and `fileChange` never pass through that set. Without
/// this check, Yolo + a writable sandbox would still accept those RPCs and
/// break the profile's documented narrowing.
fn codex_native_denied_by_active_tools(
    method: &str,
    active_tool_names: &HashSet<String>,
) -> Option<&'static str> {
    let has = |name: &str| {
        active_tool_names
            .iter()
            .any(|active| active.eq_ignore_ascii_case(name))
    };
    match codex_native_policy_tool(method) {
        "codex_file_change" => {
            if has("write") || has("edit") {
                None
            } else {
                Some("active tool allowlist excludes file mutation tools (write/edit)")
            }
        }
        _ => {
            if has("bash") {
                None
            } else {
                Some("active tool allowlist excludes command execution (bash)")
            }
        }
    }
}

/// Whether a Codex `item/tool/call` names a tool absent from the live
/// governed allowlist.
fn codex_tool_call_denied_by_active_tools(
    tool_name: &str,
    active_tool_names: &HashSet<String>,
) -> Option<String> {
    if active_tool_names
        .iter()
        .any(|active| active.eq_ignore_ascii_case(tool_name))
    {
        None
    } else {
        Some(format!("active tool allowlist excludes `{tool_name}`"))
    }
}

fn model_tool_spill_dir_for_active_tools(
    host: Option<&NativeExecutionHostHandle>,
    active_tool_names: &HashSet<String>,
    cwd: &str,
    session_id: Option<&str>,
    owns_persistent_tool_spills: bool,
) -> Option<std::path::PathBuf> {
    if !owns_persistent_tool_spills || !active_tool_names.contains("read") {
        return None;
    }
    session_id.and_then(|session_id| host.map(|host| host.model_tool_spill_dir(cwd, session_id)))
}

/// Merge patch metadata objects.
///
/// Keys present in `from` overwrite `into` (later notifications win). Keys
/// only present in `into` are kept so a partial update does not erase fields
/// the later payload omitted.
fn merge_json_object_fields(into: &mut Value, from: Value) {
    let Value::Object(from_map) = from else {
        if into.is_null() || into == &Value::Object(Map::new()) {
            *into = from;
        }
        return;
    };
    let Value::Object(into_map) = into else {
        *into = Value::Object(from_map);
        return;
    };
    for (key, value) in from_map {
        into_map.insert(key, value);
    }
}

/// Record one path and its patch metadata. Later updates for the same path
/// overwrite keys they carry and keep keys they omit.
fn insert_file_change_entry(entries: &mut Map<String, Value>, path: &str, meta: Value) {
    if let Some(existing) = entries.get_mut(path) {
        merge_json_object_fields(existing, meta);
    } else {
        entries.insert(path.to_owned(), meta);
    }
}

/// Move destinations named on a path entry (`move_path` / `kind.move_path`).
fn file_change_move_destinations(meta: &Value) -> Vec<&str> {
    let mut dests = Vec::new();
    if let Some(dest) = meta
        .get("move_path")
        .or_else(|| meta.get("movePath"))
        .and_then(Value::as_str)
    {
        dests.push(dest);
    }
    if let Some(dest) = meta
        .pointer("/kind/move_path")
        .or_else(|| meta.pointer("/kind/movePath"))
        .and_then(Value::as_str)
    {
        dests.push(dest);
    }
    dests
}

/// Record a path in encounter order and merge its metadata.
fn push_file_change_entry(
    order: &mut Vec<String>,
    entries: &mut Map<String, Value>,
    path: &str,
    meta: Value,
) {
    if !entries.contains_key(path) {
        order.push(path.to_owned());
    }
    insert_file_change_entry(entries, path, meta);
}

/// Record a source path and every move destination it names.
fn push_file_change_entry_with_moves(
    order: &mut Vec<String>,
    entries: &mut Map<String, Value>,
    path: &str,
    meta: Value,
) {
    for dest in file_change_move_destinations(&meta) {
        push_file_change_entry(order, entries, dest, json!({}));
    }
    push_file_change_entry(order, entries, path, meta);
}

/// Paths plus per-path metadata named in a Codex file-change payload.
///
/// Encounter order is preserved (not map-key sort order) so multi-path
/// firewall checks keep a stable first-to-last path sequence.
///
/// Every shape that can carry a rename/move must push **both** the source and
/// every destination path. Missing a destination in one shape is the class of
/// bug that lets Yolo approve a contained source while the out-of-workspace
/// destination is never firewall-checked.
///
/// Observed Codex shapes:
/// - legacy `applyPatchApproval`: paths are keys of a `fileChanges` object
/// - speculative/array forms (`files`, `changes`, single `path`) still accepted
/// - v2 `item/fileChange/requestApproval` often carries only `itemId`; pass
///   previously observed item entries via `known_item_paths`
fn codex_native_file_change_entries(
    params: &Value,
    known_item_paths: Option<&CodexFileChangeItemCache>,
) -> Vec<(String, Value)> {
    let mut order: Vec<String> = Vec::new();
    let mut entries = Map::new();

    // Top-level single path with optional sibling patch fields as metadata.
    if let Some(path) = params
        .get("file_path")
        .or_else(|| params.get("path"))
        .or_else(|| params.get("filePath"))
        .and_then(Value::as_str)
    {
        let mut meta = Map::new();
        for key in ["content", "diff", "patch", "kind", "move_path", "movePath"] {
            if let Some(value) = params.get(key) {
                meta.insert(key.to_owned(), value.clone());
            }
        }
        push_file_change_entry_with_moves(&mut order, &mut entries, path, Value::Object(meta));
    }

    // Legacy applyPatchApproval: { "fileChanges": { "/path": {..., "move_path"?}, ... } }
    if let Some(file_changes) = params
        .get("fileChanges")
        .or_else(|| params.get("file_changes"))
        .and_then(Value::as_object)
    {
        for (path, value) in file_changes {
            push_file_change_entry_with_moves(&mut order, &mut entries, path, value.clone());
        }
    }

    if let Some(files) = params.get("files").and_then(Value::as_array) {
        for file in files {
            if let Some(path) = file.as_str() {
                push_file_change_entry(&mut order, &mut entries, path, json!({}));
            } else if let Some(path) = file
                .get("path")
                .or_else(|| file.get("file_path"))
                .and_then(Value::as_str)
            {
                push_file_change_entry_with_moves(&mut order, &mut entries, path, file.clone());
            }
        }
    }

    // v2 FileChangePatchUpdatedNotification: changes[].path plus
    // changes[].kind.move_path for renames/moves.
    if let Some(changes) = params.get("changes").and_then(Value::as_array) {
        for change in changes {
            if let Some(path) = change
                .get("path")
                .or_else(|| change.get("file_path"))
                .and_then(Value::as_str)
            {
                push_file_change_entry_with_moves(&mut order, &mut entries, path, change.clone());
            } else {
                // Pathless change objects still contribute any move destinations.
                for dest in file_change_move_destinations(change) {
                    push_file_change_entry(&mut order, &mut entries, dest, json!({}));
                }
            }
        }
    }

    // Nested item payload (some notifications wrap the file change).
    if let Some(item) = params.get("item") {
        for (path, meta) in codex_native_file_change_entries(item, None) {
            push_file_change_entry(&mut order, &mut entries, &path, meta);
        }
    }

    // Always union entries cached under this itemId.
    if let Some(item_id) = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .and_then(Value::as_str)
    {
        if let Some(known) = known_item_paths.and_then(|map| map.get(item_id)) {
            for (path, meta) in known {
                push_file_change_entry(&mut order, &mut entries, path, meta.clone());
            }
        }
    }

    order
        .into_iter()
        .filter_map(|path| entries.remove(&path).map(|meta| (path, meta)))
        .collect()
}

/// Paths named in a Codex file-change payload (encounter order).
fn codex_native_file_change_paths(
    params: &Value,
    known_item_paths: Option<&CodexFileChangeItemCache>,
) -> Vec<String> {
    codex_native_file_change_entries(params, known_item_paths)
        .into_iter()
        .map(|(path, _)| path)
        .collect()
}

/// Record paths and patch metadata on a Codex notification under its item id.
fn remember_codex_file_change_item_paths(
    params: &Value,
    known_item_paths: &mut CodexFileChangeItemCache,
) {
    let Some(item_id) = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .or_else(|| params.pointer("/item/id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let entries = codex_native_file_change_entries(params, None);
    if entries.is_empty() {
        return;
    }
    let entry = known_item_paths.entry(item_id).or_default();
    for (path, meta) in entries {
        insert_file_change_entry(entry, &path, meta);
    }
}

/// Preserve file-change paths carried by an `item/completed` notification.
///
/// The completion stream has a separate lifecycle owner from the ordinary
/// file-change notification stream, but a later item-id-only approval still
/// needs the completed item's paths for policy and firewall evaluation.
fn remember_codex_file_change_completion_paths(
    notification: &crate::codex_app_server::Notification,
    known_item_paths: &mut CodexFileChangeItemCache,
) {
    let Some(params) = notification.params.as_ref() else {
        return;
    };
    let is_file_change = params
        .pointer("/item/type")
        .or_else(|| params.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("fileChange"));
    if is_file_change {
        remember_codex_file_change_item_paths(params, known_item_paths);
    }
}

fn codex_native_item_id(params: Option<&Value>) -> Option<&str> {
    let params = params?;
    params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .or_else(|| params.pointer("/item/id"))
        .and_then(Value::as_str)
        .filter(|item_id| !item_id.trim().is_empty())
}

fn remember_approved_codex_native_operation(
    params: Option<&Value>,
    call_id: &str,
    tool_name: &str,
    correlations: &mut HashMap<String, CodexNativeToolCorrelation>,
) {
    let Some(item_id) = codex_native_item_id(params) else {
        return;
    };
    correlations.insert(
        item_id.to_owned(),
        CodexNativeToolCorrelation {
            call_id: call_id.to_owned(),
            tool_name: tool_name.to_owned(),
        },
    );
}

fn codex_native_completion(
    notification: &crate::codex_app_server::Notification,
) -> Option<(String, bool)> {
    if notification.method != "item/completed" {
        return None;
    }
    let params = notification.params.as_ref()?;
    let item = params.get("item")?;
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("fileChange" | "commandExecution")
    ) {
        return None;
    }
    let item_id = item
        .get("id")
        .or_else(|| params.get("itemId"))
        .and_then(Value::as_str)?
        .trim();
    if item_id.is_empty() {
        return None;
    }
    let failed_status = item
        .get("status")
        .or_else(|| params.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "cancelled" | "canceled"));
    let is_error = item
        .get("isError")
        .or_else(|| item.get("is_error"))
        .or_else(|| params.get("isError"))
        .or_else(|| params.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let nonzero_exit = matches!(
        item.get("type").and_then(Value::as_str),
        Some("commandExecution")
    ) && item
        .get("exitCode")
        .or_else(|| item.get("exit_code"))
        .or_else(|| params.get("exitCode"))
        .or_else(|| params.get("exit_code"))
        .and_then(Value::as_i64)
        .is_some_and(|exit_code| exit_code != 0);
    Some((
        item_id.to_owned(),
        !failed_status && !is_error && !nonzero_exit,
    ))
}

#[cfg(test)]
fn project_codex_native_completion(
    notification: &crate::codex_app_server::Notification,
    correlations: &mut HashMap<String, CodexNativeToolCorrelation>,
    receipt_policy: Option<ManagedPolicyMetadata>,
) -> Option<FromAgent> {
    let (item_id, success) = codex_native_completion(notification)?;
    project_codex_native_completion_parts(item_id, success, correlations, receipt_policy)
}

fn project_codex_native_completion_parts(
    item_id: String,
    success: bool,
    correlations: &mut HashMap<String, CodexNativeToolCorrelation>,
    receipt_policy: Option<ManagedPolicyMetadata>,
) -> Option<FromAgent> {
    let correlation = correlations.remove(&item_id)?;
    let result = if success {
        ToolResult::success(format!("{} completed", correlation.tool_name))
    } else {
        ToolResult::failure(format!("{} failed", correlation.tool_name))
    };
    let execution = ToolExecution::from_legacy(
        &correlation.call_id,
        &correlation.tool_name,
        ExecutionSource::Native,
        result.clone(),
    )
    .with_managed_policy(receipt_policy);
    Some(FromAgent::ToolEnd {
        call_id: correlation.call_id,
        success,
        result: Some(result),
        receipt: Some(execution.receipt),
    })
}

/// Project a completion immediately when its approval correlation already
/// exists, or retain the authoritative outcome until that correlation is
/// recorded. The app-server may deliver `item/completed` before the approval
/// request, so dropping an unmatched completion would lose the terminal tool
/// receipt permanently.
fn project_or_defer_codex_native_completion(
    notification: &crate::codex_app_server::Notification,
    correlations: &mut HashMap<String, CodexNativeToolCorrelation>,
    pending: &mut HashMap<String, bool>,
    receipt_policy: Option<ManagedPolicyMetadata>,
) -> Option<FromAgent> {
    let (item_id, success) = codex_native_completion(notification)?;
    if let Some(event) = project_codex_native_completion_parts(
        item_id.clone(),
        success,
        correlations,
        receipt_policy.clone(),
    ) {
        return Some(event);
    }
    pending.insert(item_id, success);
    None
}

fn project_deferred_codex_native_completion(
    params: Option<&Value>,
    pending: &mut HashMap<String, bool>,
    correlations: &mut HashMap<String, CodexNativeToolCorrelation>,
    receipt_policy: Option<ManagedPolicyMetadata>,
) -> Option<FromAgent> {
    let item_id = codex_native_item_id(params)?;
    let success = pending.remove(item_id)?;
    project_codex_native_completion_parts(item_id.to_owned(), success, correlations, receipt_policy)
}

fn discard_deferred_codex_native_completion(
    params: Option<&Value>,
    pending: &mut HashMap<String, bool>,
) {
    if let Some(item_id) = codex_native_item_id(params) {
        pending.remove(item_id);
    }
}

/// Canonical policy-hook input for a Codex-native file-change approval.
///
/// # Contract (class fix for alias/metadata review loops)
///
/// Policy hooks must treat these fields as authoritative:
/// - `paths`: ordered full path set (sources + move destinations)
/// - `fileChanges`: path → metadata object (kind/content/diff/move_path/…)
///
/// Every original path-bearing alias present on the approval is also fully
/// rewritten to that same complete set (`file_changes`, `files`, `changes`).
/// Prefer `paths` + `fileChanges`; aliases exist only for back-compat.
///
/// Correlation: v2 itemId-only approvals are filled from
/// `known_item_paths` (path + metadata cache from earlier notifications).
fn codex_native_policy_hook_args(
    method: &str,
    params: Option<&Value>,
    known_item_paths: &CodexFileChangeItemCache,
) -> Value {
    let base = params.cloned().unwrap_or(Value::Null);
    if codex_native_policy_tool(method) != "codex_file_change" {
        return base;
    }
    let empty = Value::Null;
    let raw = params.unwrap_or(&empty);
    let correlated_entries = codex_native_file_change_entries(raw, Some(known_item_paths));
    if correlated_entries.is_empty() {
        return base;
    }

    let mut enriched = match base {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("original".to_owned(), other);
            map
        }
    };

    let had_files = enriched.contains_key("files");
    let had_changes = enriched.contains_key("changes");
    let files_prefer_objects = enriched
        .get("files")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(Value::is_object));

    // Canonical complete views — always rewritten from the correlated set.
    let paths: Vec<String> = correlated_entries
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    let mut file_changes = Map::new();
    for (path, meta) in &correlated_entries {
        file_changes.insert(path.clone(), meta.clone());
    }
    let file_changes_value = Value::Object(file_changes);

    enriched.insert("paths".to_owned(), json!(paths));
    // Dual-write map aliases so neither camelCase nor snake_case consumers
    // can see a partial view (the class of bug that produced serial P1s).
    enriched.insert("fileChanges".to_owned(), file_changes_value.clone());
    enriched.insert("file_changes".to_owned(), file_changes_value);

    // Fully rewrite original array aliases to the complete correlated set.
    if had_files {
        enriched.insert(
            "files".to_owned(),
            materialize_path_array(&correlated_entries, files_prefer_objects),
        );
    }
    if had_changes {
        enriched.insert(
            "changes".to_owned(),
            materialize_path_array(&correlated_entries, true),
        );
    }

    Value::Object(enriched)
}

/// Build a `files`/`changes` array from the correlated path/metadata set.
fn materialize_path_array(entries: &[(String, Value)], as_objects: bool) -> Value {
    let items: Vec<Value> = entries
        .iter()
        .map(|(path, meta)| {
            if as_objects {
                let mut entry = match meta {
                    Value::Object(map) => map.clone(),
                    _ => Map::new(),
                };
                entry
                    .entry("path".to_owned())
                    .or_insert_with(|| Value::String(path.clone()));
                Value::Object(entry)
            } else {
                Value::String(path.clone())
            }
        })
        .collect();
    Value::Array(items)
}

/// Map a Codex-native approval request onto Maestro tool argument sets the
/// action firewall already understands.
///
/// Codex does not speak Maestro tool names; its approval params carry the
/// command line or the paths being patched. Normalizing them to `bash` /
/// `write` lets the same dangerous-command and path checks that guard
/// `item/tool/call` also guard the native mutation RPCs. File-change
/// requests with multiple paths produce one `write` argument set per path.
fn codex_native_firewall_arg_sets(
    method: &str,
    params: Option<&Value>,
    known_item_paths: Option<&CodexFileChangeItemCache>,
) -> Vec<(&'static str, Value)> {
    let Some(params) = params else {
        return Vec::new();
    };
    match codex_native_policy_tool(method) {
        "codex_file_change" => {
            let content = params
                .get("content")
                .or_else(|| params.get("diff"))
                .or_else(|| params.get("patch"))
                .and_then(Value::as_str)
                .unwrap_or("");
            codex_native_file_change_paths(params, known_item_paths)
                .into_iter()
                .map(|path| {
                    (
                        "write",
                        json!({
                            "file_path": path,
                            "content": content,
                        }),
                    )
                })
                .collect()
        }
        _ => {
            let command = params
                .get("command")
                .or_else(|| params.get("command_line"))
                .or_else(|| params.get("commandLine"))
                .or_else(|| params.get("cmd"))
                .and_then(|value| {
                    if let Some(text) = value.as_str() {
                        return Some(text.to_owned());
                    }
                    value.as_array().map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                });
            command
                .map(|command| vec![("bash", json!({ "command": command }))])
                .unwrap_or_default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexNativeFirewallDecision {
    Allow,
    RequireApproval { reason: String },
    Block { reason: String },
}

fn codex_native_firewall_decision(
    host: &NativeExecutionHostHandle,
    method: &str,
    params: Option<&Value>,
    workflow_state: Option<&crate::agent::safety::WorkflowStateSnapshot>,
    known_item_paths: Option<&CodexFileChangeItemCache>,
) -> CodexNativeFirewallDecision {
    let arg_sets = codex_native_firewall_arg_sets(method, params, known_item_paths);
    if arg_sets.is_empty() {
        return CodexNativeFirewallDecision::Block {
            reason: match codex_native_policy_tool(method) {
                "codex_file_change" => "Codex file-change approval carried no recoverable paths for the action firewall".to_owned(),
                _ => "Codex command approval carried no recoverable command for the action firewall".to_owned(),
            },
        };
    }
    let fallback_workflow_state = super::workflow_state::WorkflowStateTracker::default().snapshot();
    let workflow_state = workflow_state.unwrap_or(&fallback_workflow_state);
    let mut approval_reason = None;
    for (tool_name, args) in arg_sets {
        let verdict = host.firewall_verdict(tool_name, &args, workflow_state, None, false);
        match verdict {
            NativeFirewallVerdict::Block { reason } => {
                return CodexNativeFirewallDecision::Block { reason };
            }
            NativeFirewallVerdict::RequireApproval { reason } => {
                approval_reason.get_or_insert(reason);
            }
            NativeFirewallVerdict::Allow => {}
        }
    }
    approval_reason.map_or(CodexNativeFirewallDecision::Allow, |reason| {
        CodexNativeFirewallDecision::RequireApproval { reason }
    })
}
#[must_use]
fn codex_native_approval_requires_user(mode: ApprovalMode) -> bool {
    mode != ApprovalMode::Yolo
}

/// Exercise the production Codex effect-policy adapter with a concrete host.
#[cfg(feature = "test-support")]
pub fn codex_native_effect_denial_for_test(
    host: &NativeExecutionHostHandle,
    method: &str,
    params: Option<&Value>,
) -> Option<String> {
    match codex_native_firewall_decision(host, method, params, None, None) {
        CodexNativeFirewallDecision::Allow => None,
        CodexNativeFirewallDecision::Block { reason }
        | CodexNativeFirewallDecision::RequireApproval { reason } => Some(reason),
    }
}

/// Exercise the production serial-tool cache boundary from a composing-crate
/// integration test without exposing the private lifecycle module.
#[cfg(feature = "test-support")]
pub fn invalidate_cache_after_serial_tool_for_test(
    host: &NativeExecutionHostHandle,
    tool_name: &str,
    executed: bool,
) {
    invalidate_cache_after_serial_tool(host, tool_name, executed);
}

/// Exercise the production deferred firewall adapter from a composing-crate
/// integration test with the real host boundary.
#[cfg(feature = "test-support")]
pub fn deferred_firewall_verdict_for_test(
    host: &NativeExecutionHostHandle,
    tool_name: &str,
    args: &Value,
    workflow_snapshot: &super::safety::WorkflowStateSnapshot,
    annotations: Option<&super::native_host::NativeToolAnnotations>,
    is_external_tool: bool,
) -> NativeFirewallVerdict {
    deferred_firewall_verdict(
        host,
        tool_name,
        args,
        workflow_snapshot,
        annotations,
        is_external_tool,
    )
}

/// Build the production deferred policy-rejection event for an integration
/// test without making the private deferred-call context part of the API.
#[cfg(feature = "test-support")]
pub fn deferred_policy_rejection_event_for_test(
    call_id: &str,
    tool_name: &str,
    reason: &str,
) -> FromAgent {
    let call = ToolCallContext {
        call_id: call_id.to_owned(),
        tool_name: tool_name.to_owned(),
        args: Value::Null,
        safe_args: Value::Null,
        extra_context: None,
        pre_hook_args: Value::Null,
        initial_firewall_verdict: NativeFirewallVerdict::Allow,
        approval_inline_env: None,
    };
    deferred_policy_rejection_event(&call, reason, None)
}

/// Run the production deferred PreToolUse helper against a concrete host from
/// a composing-crate integration test.
#[cfg(feature = "test-support")]
pub async fn rerun_deferred_pre_tool_use_for_test(
    host: &NativeExecutionHostHandle,
    call_id: &str,
    tool_name: &str,
    pre_hook_args: &Value,
) -> std::result::Result<(Value, Option<String>), String> {
    let call = ToolCallContext {
        call_id: call_id.to_owned(),
        tool_name: tool_name.to_owned(),
        args: pre_hook_args.clone(),
        safe_args: pre_hook_args.clone(),
        extra_context: None,
        pre_hook_args: pre_hook_args.clone(),
        initial_firewall_verdict: NativeFirewallVerdict::Allow,
        approval_inline_env: None,
    };
    rerun_deferred_pre_tool_use(host, &call).await
}

/// Output allowance for one request under an optional cumulative budget.
///
/// `configured` is the per-request `max_tokens`. With no budget it is used
/// unchanged, which is the interactive case. With a budget the request is also
/// clamped to the unspent part, so a run that calls tools is not granted the
/// full allowance again on every request.
///
/// The floor of 1 keeps the request valid for providers that reject
/// `max_tokens: 0`; ending a run that has spent its budget is the job of the
/// caller that set it.
fn output_token_allowance(configured: u32, budget: Option<u32>, spent: u64) -> u32 {
    let Some(budget) = budget else {
        return configured;
    };
    let unspent = u64::from(budget).saturating_sub(spent);
    let unspent = u32::try_from(unspent).unwrap_or(u32::MAX);
    let allowance = configured.min(unspent);
    if allowance == 0 { 1 } else { allowance }
}

fn clamp_output_to_remaining_context(
    configured: u32,
    context_tokens: u64,
    estimated_input_tokens: u64,
) -> Option<u32> {
    const REQUEST_CONTEXT_SAFETY_TOKENS: u64 = 64;
    let remaining = context_tokens
        .saturating_sub(estimated_input_tokens)
        .saturating_sub(REQUEST_CONTEXT_SAFETY_TOKENS);
    (remaining > 0).then(|| configured.min(u32::try_from(remaining).unwrap_or(u32::MAX)))
}

async fn recv_command_or_shutdown(
    shutdown_token: &CancellationToken,
    command_rx: &mut mpsc::UnboundedReceiver<AgentCommand>,
) -> Option<AgentCommand> {
    tokio::select! {
        biased;
        () = shutdown_token.cancelled() => None,
        command = command_rx.recv() => command,
    }
}

async fn await_side_question_or_shutdown<F>(
    shutdown_token: &CancellationToken,
    side_question: F,
) -> Option<F::Output>
where
    F: Future,
{
    tokio::select! {
        biased;
        () = shutdown_token.cancelled() => None,
        output = side_question => Some(output),
    }
}

fn history_storage<T>(messages: Vec<Message>) -> T
where
    T: From<Vec<Message>>,
{
    T::from(messages)
}

fn resolve_provider_history(
    messages: &[Message],
    credential_vault: &CredentialVault,
) -> Result<Vec<Message>> {
    let serialized = serde_json::to_value(messages).context("serialize provider history")?;
    let resolved = credential_vault.resolve_in_json(&serialized);
    serde_json::from_value(resolved).context("deserialize resolved provider history")
}

fn json_contains_credential_reference(value: &Value) -> bool {
    match value {
        Value::String(value) => CredentialVault::has_references(value),
        Value::Array(values) => values.iter().any(json_contains_credential_reference),
        Value::Object(values) => values.values().any(json_contains_credential_reference),
        _ => false,
    }
}

fn message_contains_credential_reference(message: &Message) -> bool {
    match &message.content {
        MessageContent::Text(text) => CredentialVault::has_references(text),
        MessageContent::Blocks(blocks) => blocks.iter().any(|block| match block {
            ContentBlock::Text { text }
            | ContentBlock::Thinking { thinking: text, .. }
            | ContentBlock::ToolResult { content: text, .. } => {
                CredentialVault::has_references(text)
            }
            ContentBlock::ToolUse { input, .. } => json_contains_credential_reference(input),
            ContentBlock::Image { source } => match source {
                ImageSource::Base64 { media_type, data } => {
                    CredentialVault::has_references(media_type)
                        || CredentialVault::has_references(data)
                }
                ImageSource::Url { url } => CredentialVault::has_references(url),
            },
        }),
    }
}

fn resolve_provider_history_shared(
    messages: &Arc<Vec<Message>>,
    credential_vault: &CredentialVault,
) -> Result<Arc<Vec<Message>>> {
    if !messages.iter().any(message_contains_credential_reference) {
        return Ok(Arc::clone(messages));
    }
    Ok(Arc::new(resolve_provider_history(
        messages,
        credential_vault,
    )?))
}

fn resolve_codex_tool_result_for_wire(
    credential_vault: &CredentialVault,
    vaulted_content: &str,
) -> String {
    credential_vault.resolve_all(vaulted_content)
}

fn user_message_text(message: &Message) -> Option<String> {
    match (&message.role, &message.content) {
        (Role::User, MessageContent::Text(text)) => Some(text.clone()),
        (Role::User, MessageContent::Blocks(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn codex_app_server_user_text(
    messages: &[Message],
    injected_notes: &[String],
    current_user_message_index: Option<usize>,
) -> String {
    let current_prompt = current_user_message_index
        .and_then(|index| messages.get(index))
        .and_then(user_message_text);
    let mut parts = injected_notes.to_vec();
    if let Some(current_prompt) = current_prompt {
        parts.push(current_prompt);
    }
    if parts.is_empty() {
        return messages
            .iter()
            .rev()
            .find_map(user_message_text)
            .unwrap_or_default();
    }
    parts.join("\n\n")
}

fn refresh_model_budgets_with_host(
    host: &NativeExecutionHostHandle,
    config: &mut NativeAgentConfig,
    compactor: &mut super::compaction::ContextCompactor,
    model: &str,
) {
    if config.max_tokens_source == MaxTokensSource::Catalog {
        config.max_tokens = host.default_max_output_tokens(model);
    }
    *compactor =
        super::compaction::ContextCompactor::new(super::compaction::CompactionConfig::for_model(
            model,
            config
                .context_window
                .or_else(|| host.model_context_window(model)),
        ));
}

fn process_provider_cost_micros(cost: f64) -> Result<u64> {
    let micros = cost * 1_000_000.0;
    if !micros.is_finite() || micros < 0.0 || micros >= u64::MAX as f64 {
        anyhow::bail!("invalid process provider cost");
    }
    // Gateway integer microcosts pass through one f64 division and multiplication.
    // Normalize only their two-operation rounding envelope; genuine fractions
    // outside that envelope still round up to the next billable micro-unit.
    let nearest = micros.round();
    let roundoff = 2.0 * f64::EPSILON * micros.abs();
    let charged = if (micros - nearest).abs() <= roundoff {
        nearest
    } else {
        micros.ceil()
    };
    Ok(charged as u64)
}

fn set_explicit_max_tokens(config: &mut NativeAgentConfig, max_tokens: u32) {
    config.max_tokens = max_tokens;
    config.max_tokens_source = MaxTokensSource::Explicit;
}

impl NativeAgentRunner {
    async fn admit_provider_request(
        &self,
        kind: &str,
        request_id: &str,
        model: Option<&str>,
    ) -> Result<()> {
        let result = self
            .hooks
            .hook_pre_provider_request(kind, request_id, model)
            .await;
        let reason = match result {
            NativeHookResult::Continue => return Ok(()),
            NativeHookResult::Block { reason } => reason,
            NativeHookResult::ModifyInput { .. } => {
                "provider admission hook returned an unsupported input modification".to_owned()
            }
            NativeHookResult::InjectContext { .. } => {
                "provider admission hook returned unsupported context injection".to_owned()
            }
        };
        Err(anyhow::Error::new(ProviderAdmissionDenied {
            kind: kind.to_owned(),
            request_id: request_id.to_owned(),
            reason,
        }))
    }

    fn managed_gateway_receipt_event(
        receipt: maestro_ai::ManagedGatewayReceipt,
        experiment_eligible: bool,
    ) -> FromAgent {
        FromAgent::ManagedGatewayReceipt {
            request_id: receipt.request_id,
            record_id: receipt.record_id,
            lineage_id: receipt.lineage_id,
            record_status: receipt.record_status,
            // Auxiliary compaction uses its own instructions. Keep its cost
            // receipt, but never label it as exposure to the turn's treatment.
            provider_prompt_sha256: if experiment_eligible {
                receipt.provider_prompt_sha256
            } else {
                None
            },
        }
    }

    async fn resolve_managed_request_lineage(
        &mut self,
        explicit_lineage: Option<String>,
    ) -> Result<Option<String>> {
        let Some(client) = self.client.as_ref() else {
            return Ok(explicit_lineage);
        };
        if !client.is_managed_gateway() {
            return Ok(explicit_lineage);
        }
        let Some((organization_id, workspace_id)) =
            client
                .managed_gateway_scope()
                .map(|(organization_id, workspace_id)| {
                    (organization_id.to_owned(), workspace_id.to_owned())
                })
        else {
            bail!("managed gateway request requires complete organization/workspace scope");
        };

        if let Some(lineage) = explicit_lineage {
            return Ok(Some(lineage));
        }

        let thread_id = self
            .hooks
            .hook_session_id()
            .await
            .and_then(|value| {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_owned())
            })
            .context("managed gateway request requires an active session context")?;
        let next_turn = self
            .next_managed_turn_id
            .checked_add(1)
            .context("managed gateway turn sequence exhausted")?;
        self.next_managed_turn_id = next_turn;
        Ok(Some(managed_turn_lineage_id(
            &organization_id,
            &workspace_id,
            &thread_id,
            &self.managed_run_id,
            &format!("turn-{next_turn}"),
        )))
    }

    fn reject_managed_request(&self, error: anyhow::Error) {
        let _ = self.event_tx.send(FromAgent::Error {
            message: format!("Managed request rejected: {error:#}"),
            fatal: false,
            terminal: true,
            retryable: false,
        });
    }

    fn messages_mut(&mut self) -> &mut Vec<Message> {
        Arc::make_mut(&mut self.messages)
    }

    fn set_goal_tools_visible(&mut self, visible: bool) {
        if self.goal_tools_visible == visible {
            return;
        }
        self.goal_tools_visible = visible;
        self.model_tool_cache = None;
        self.refresh_runtime_audit();
    }

    fn set_context_tool_excluded(&mut self, name: &str, excluded: bool) {
        let name = name.to_ascii_lowercase();
        if self.model_route.uses_app_server() || !self.tools.contains_key(&name) {
            let _ = self.event_tx.send(FromAgent::Status {
                message: "Context tool selection requires a registered tool on the native provider route.".into()
            });
            return;
        }
        {
            let mut audit = self
                .runtime_audit
                .write()
                .unwrap_or_else(|p| p.into_inner());
            if excluded {
                audit.excluded_context_tools.insert(name.clone());
            } else {
                audit.excluded_context_tools.remove(&name);
            }
        }
        self.model_tool_cache = None;
        self.refresh_runtime_audit();
        let _ = self.event_tx.send(FromAgent::Status {
            message: format!(
                "{} {name} {} this session's request schemas.",
                if excluded { "Excluded" } else { "Included" },
                if excluded { "from" } else { "in" }
            ),
        });
    }

    fn refresh_runtime_audit(&self) {
        self.refresh_runtime_audit_with_prompt(self.config.system_prompt.clone());
    }

    fn refresh_runtime_audit_with_prompt(&self, system_prompt: Option<String>) {
        let previous = self
            .runtime_audit
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let excluded_context_tools = previous.excluded_context_tools;
        let snapshot = RuntimeAuditSnapshot {
            request_cache: previous.request_cache,
            cache_reuse: None,
            request_context: None,
            excluded_context_tools: excluded_context_tools.clone(),
            prompt_revision: self.runtime_prompt_revision,
            system_prompt,
            tools: effective_tool_definitions(
                &self.tools,
                &self.active_tool_names,
                self.goal_tools_visible,
                self.include_ide_tools,
            )
            .into_iter()
            .filter(|definition| {
                !excluded_context_tools.contains(&definition.tool.name.to_ascii_lowercase())
            })
            .collect(),
        };
        *self
            .runtime_audit
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot;
    }

    fn replace_governed_tools(
        &mut self,
        allowed_tools: &HashSet<String>,
        external_tool_definitions: Vec<ToolDefinition>,
    ) {
        let mut tools = self
            .tool_executor
            .tool_definitions()
            .into_iter()
            .filter(|definition| allowed_tools.contains(&definition.tool.name.to_ascii_lowercase()))
            .map(|definition| {
                (
                    definition.tool.name.to_ascii_lowercase(),
                    definition.clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let external_tools = external_tool_definitions
            .iter()
            .map(|definition| definition.tool.name.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        for definition in external_tool_definitions {
            tools.insert(definition.tool.name.to_ascii_lowercase(), definition);
        }
        self.active_tool_names = initial_active_tool_names(
            self.tool_profile,
            &tools,
            &external_tools,
            Some(allowed_tools),
        );
        self.explicitly_allowed_tools = allowed_tools.clone();
        self.tools = tools;
        self.external_tools = external_tools;
        self.model_tool_cache = None;
        self.refresh_runtime_audit();
    }

    /// Interrupt the active Codex turn after the outer cancellation future is dropped.
    ///
    /// The app-server owns the provider request, so dropping Maestro's wait future
    /// is not sufficient to stop the remote turn or release its thread.
    async fn interrupt_active_codex_turn(&mut self) {
        let Some(turn_id) = self.codex_active_turn_id.take() else {
            return;
        };
        let Some(session) = self.codex_session.as_ref() else {
            return;
        };
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            session.interrupt_turn(&turn_id, Some(1_500)),
        )
        .await;
        let message = match result {
            Ok(Ok(())) => {
                let _ = self.event_tx.send(FromAgent::CodexTurnState {
                    state: "interrupted".to_owned(),
                    thread_id: session.thread_id().to_owned(),
                    turn_id: Some(turn_id.clone()),
                });
                format!("Codex turn interrupted ({turn_id})")
            }
            Ok(Err(error)) => {
                let _ = self.event_tx.send(FromAgent::CodexTurnState {
                    state: "failed".to_owned(),
                    thread_id: session.thread_id().to_owned(),
                    turn_id: Some(turn_id.clone()),
                });
                format!("Codex turn interrupt failed: {error:#}")
            }
            Err(_) => {
                let _ = self.event_tx.send(FromAgent::CodexTurnState {
                    state: "failed".to_owned(),
                    thread_id: session.thread_id().to_owned(),
                    turn_id: Some(turn_id.clone()),
                });
                "Codex turn interrupt timed out".to_owned()
            }
        };
        let _ = self.event_tx.send(FromAgent::Status { message });
    }
    fn compact_codex_history_for_boundary(&mut self) {
        if !self.model_route.uses_app_server() {
            return;
        }

        let compaction_started = Instant::now();
        let mut result = self.compactor.compact_with_tokens(&self.messages);
        self.retain_continuation(&mut result);
        if !result.was_compacted() {
            return;
        }

        let _ = self.event_tx.send(FromAgent::CompactionMeasured {
            duration_ms: compaction_started
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        });
        let status_message = format!(
            "Codex history compacted: {} messages summarized, {} oversized messages bounded",
            result.compacted_count, result.intra_compacted_count
        );
        emit_compaction_event(
            &self.event_tx,
            &self.messages,
            result.summary.as_deref().unwrap_or(&status_message),
            result.cut_point.as_ref(),
            result.continuation.as_ref(),
            true,
        );
        self.messages = Arc::new(result.messages);
        self.codex_session = None;
        self.codex_history_restore_prefix_len = Some(self.messages.len());
        let _ = self.event_tx.send(FromAgent::Status {
            message: status_message,
        });
    }

    fn emit_conversation_snapshot(&mut self) {
        self.compact_codex_history_for_boundary();
        let mut processed_queue_ids = self
            .processed_prompt_queue_ids
            .iter()
            .copied()
            .collect::<Vec<_>>();
        processed_queue_ids.sort_unstable();
        if let Some(snapshot) = conversation_snapshot_event_with_queue_ids(
            &self.messages,
            processed_queue_ids,
            self.tool_executor.semantic_conversation_protocol(),
        ) {
            let _ = self.event_tx.send(snapshot);
            self.processed_prompt_queue_ids.clear();
        }
    }

    fn set_active_request_cancel_token(&mut self, token: Option<CancellationToken>) {
        let mut active = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active.set_request(token.clone());
        self.cancel_token = token;
    }

    fn set_active_tool_cancel_token(
        &self,
        token: Option<CancellationToken>,
        terminal_drain_required: bool,
    ) {
        let mut active = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active.set_tool(token, terminal_drain_required);
    }

    fn set_active_approval_cancel_token(&self, token: Option<CancellationToken>) {
        let mut active = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(token) = token.as_ref() {
            if active.operation_interrupted {
                token.cancel();
            }
        }
        active.approval = token;
    }

    fn set_tool_batch_active(&self, is_active: bool) {
        let mut active = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active.tool_batch_active = is_active;
        if !is_active {
            active.terminal_drain_required = false;
        }
    }

    fn take_active_operation_interruption(&self) -> bool {
        let mut active = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut active.operation_interrupted)
    }

    fn finish_tool_batch(&self) -> bool {
        self.active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .finish_tool_batch()
    }

    async fn take_deferred_command(&mut self) -> Option<(AgentCommand, Option<CancellationToken>)> {
        if self.deferred_commands.is_empty() {
            return None;
        }

        // The command drain can await hook state changes, so do not hold the
        // synchronous cancellation mutex across it. A cancellation that races
        // this drain still reaches the token installed below directly.
        let _ = self.drain_pending_commands().await;
        let command = self.deferred_commands.pop_front()?;
        let request_token = match &command {
            AgentCommand::Prompt { kind, .. } if prompt_kind_starts_main_request(*kind) => {
                let token = self
                    .active_cancellation
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .activate_request();
                self.cancel_token = Some(token.clone());
                Some(token)
            }
            _ => None,
        };
        Some((command, request_token))
    }

    async fn activate_received_command(
        &mut self,
        command: AgentCommand,
    ) -> (AgentCommand, Option<CancellationToken>) {
        let starts_main_request = matches!(
            &command, AgentCommand::Prompt { kind, .. } if prompt_kind_starts_main_request(*kind)
        );
        if !starts_main_request {
            return (command, None);
        }

        // Install the token before draining so a cancellation that races the
        // asynchronous hook updates can cancel the active request directly.
        let token = self
            .active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .activate_request();
        self.cancel_token = Some(token.clone());
        let _ = self.drain_pending_commands().await;
        (command, Some(token))
    }

    const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024; // 10MB
    const MAX_TEXT_ATTACHMENT_CHARS: usize = 100_000;

    fn resolve_attachment_path(&self, raw: &str) -> PathBuf {
        if raw == "~" {
            if let Some(home) = dirs::home_dir() {
                return home;
            }
        }

        if let Some(stripped) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            if let Some(home) = dirs::home_dir() {
                return home.join(stripped);
            }
        }

        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            Path::new(&self.config.cwd).join(p)
        }
    }

    fn detect_image_mime(path: &Path) -> Option<&'static str> {
        let ext = path.extension().and_then(|e| e.to_str())?.to_lowercase();
        match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "bmp" => Some("image/bmp"),
            "svg" => Some("image/svg+xml"),
            _ => None,
        }
    }

    fn truncate_text(text: &str, max_chars: usize) -> String {
        if text.chars().count() <= max_chars {
            return text.to_string();
        }
        text.chars().take(max_chars).collect()
    }

    fn apply_message_hook_modification(
        prompt: &mut String,
        attachments: &mut Vec<String>,
        new_input: serde_json::Value,
    ) {
        match new_input {
            serde_json::Value::String(text) => {
                *prompt = text;
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(text)) =
                    map.get("message").or_else(|| map.get("prompt"))
                {
                    *prompt = text.clone();
                }
                if let Some(serde_json::Value::Array(items)) = map.get("attachments") {
                    let mut next = Vec::new();
                    for item in items {
                        match item {
                            serde_json::Value::String(value) => next.push(value.clone()),
                            other => next.push(other.to_string()),
                        }
                    }
                    *attachments = next;
                }
            }
            _ => {}
        }
    }

    fn merge_prompt_context(target: &mut Option<String>, context: String) {
        if context.trim().is_empty() {
            return;
        }
        match target {
            Some(existing) => {
                existing.push('\n');
                existing.push_str(&context);
            }
            None => {
                *target = Some(context);
            }
        }
    }

    fn enqueue_pending_prompt(
        &mut self,
        content: String,
        attachments: Vec<String>,
        kind: PromptKind,
        queue_id: Option<u64>,
        managed_request_lineage: Option<String>,
        managed_inference_authorization: Option<ManagedInferenceAuthorization>,
    ) {
        let id = queue_id.unwrap_or_else(|| self.pending_messages.reserve_id());
        let pending = if kind == PromptKind::Steer {
            PendingMessage::urgent_with_kind_and_id_and_attachments(content, kind, id, attachments)
        } else {
            PendingMessage::with_kind_and_id_and_attachments(content, kind, id, attachments)
        }
        .with_managed_request_lineage(managed_request_lineage)
        .with_managed_inference_authorization(managed_inference_authorization);
        let dropped = self.pending_messages.push_message(pending);
        if let Some(dropped) = dropped {
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!("Queue full, dropped oldest {}", dropped.kind.label()),
            });
        }
        let stats = self.pending_messages.stats();
        let label = kind.label();
        let _ = self.event_tx.send(FromAgent::Status {
            message: if stats.pending_count == 1 {
                format!("Queued {label} #{id} (1 pending)")
            } else {
                format!("Queued {} #{} ({} pending)", label, id, stats.pending_count)
            },
        });
    }

    fn requeue_follow_up_front(
        &mut self,
        content: String,
        attachments: Vec<String>,
        queue_id: u64,
        managed_request_lineage: Option<String>,
    ) {
        let pending = PendingMessage::with_kind_and_id_and_attachments(
            content,
            PromptKind::FollowUp,
            queue_id,
            attachments,
        )
        .with_managed_request_lineage(managed_request_lineage);
        let dropped = self.pending_messages.push_message_front_of_kind(pending);
        if let Some(dropped) = dropped {
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!("Queue full, dropped oldest {}", dropped.kind.label()),
            });
        }
    }

    async fn drain_pending_commands(&mut self) -> bool {
        let mut cancelled = false;
        while let Ok(cmd) = self.command_rx.try_recv() {
            match cmd {
                AgentCommand::ApplySelectiveSummary { reply, .. } => {
                    let _ = reply.send(Err(anyhow::anyhow!(
                        "Wait for the current turn and queued messages to finish"
                    )));
                }
                AgentCommand::SelectiveSummaryPreview { reply } => {
                    let _ = reply.send(Err(anyhow::anyhow!(
                        "Wait for the current turn and queued messages to finish"
                    )));
                }
                AgentCommand::SelectiveSummary { reply, .. } => {
                    let _ = reply.send(super::SelectiveSummaryOutcome {
                        usage: None,
                        result: Err(anyhow::anyhow!(
                            "Wait for the current turn and queued messages to finish"
                        )),
                    });
                }
                AgentCommand::Prompt {
                    content,
                    attachments,
                    kind,
                    queue_id,
                    managed_request_lineage,
                    managed_inference_authorization,
                } => {
                    let managed_request_lineage = match self
                        .resolve_managed_request_lineage(managed_request_lineage)
                        .await
                    {
                        Ok(lineage) => lineage,
                        Err(error) => {
                            self.reject_managed_request(error);
                            continue;
                        }
                    };
                    if should_defer_prompt_command(kind, cancelled) {
                        self.deferred_commands.push_back(AgentCommand::Prompt {
                            content,
                            attachments,
                            kind,
                            queue_id,
                            managed_request_lineage,
                            managed_inference_authorization,
                        });
                    } else {
                        self.enqueue_pending_prompt(
                            content,
                            attachments,
                            kind,
                            queue_id,
                            managed_request_lineage,
                            managed_inference_authorization,
                        );
                    }
                }
                AgentCommand::Cancel { clear_pending } => {
                    self.clear_pending_on_cancel = clear_pending;
                    if clear_pending {
                        let cleared = self.pending_messages.clear();
                        let cleared_stashed = clear_stashed_prompts(&mut self.deferred_commands);
                        let cleared_count = cleared.len() + cleared_stashed;
                        if cleared_count != 0 {
                            let _ = self.event_tx.send(FromAgent::Status {
                                message: format!("Cleared {cleared_count} pending message(s)"),
                            });
                        }
                    }
                    self.reject_pending_tool_responses_on_cancel();
                    cancelled = true;
                }
                AgentCommand::CancelQueued { id } => {
                    // The staged system prompt is not keyed by id and stays
                    // staged: the skills it carries are still active in the UI,
                    // so the next message to start should see them.
                    if let Some(removed) = self.pending_messages.remove_by_id(id) {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!(
                                "Removed queued {} #{}",
                                removed.kind.label(),
                                removed.id
                            ),
                        });
                    } else {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!("No queued prompt found with id #{id}"),
                        });
                    }
                }
                AgentCommand::ReorderQueued { id, placement } => {
                    if !self.pending_messages.move_by_id(id, placement) {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!("No queued prompt found with id #{id}"),
                        });
                    }
                }
                AgentCommand::RequeueFollowUpFront {
                    content,
                    attachments,
                    queue_id,
                    managed_request_lineage,
                } => match self
                    .resolve_managed_request_lineage(managed_request_lineage)
                    .await
                {
                    Ok(lineage) => {
                        self.requeue_follow_up_front(content, attachments, queue_id, lineage);
                    }
                    Err(error) => self.reject_managed_request(error),
                },
                AgentCommand::SetContextToolExcluded { name, excluded } => {
                    self.set_context_tool_excluded(&name, excluded);
                }
                AgentCommand::Boost => {
                    let mut state = self.dynamics.lock().expect("model dynamics mutex");
                    if !state.used {
                        state.requested = true;
                        state.status = super::model_dynamics::BoostStatus::Pending;
                        let _ = self.event_tx.send(FromAgent::BoostChanged {
                            status: state.status,
                            thinking: None,
                        });
                    }
                }
                AgentCommand::SetThinking { enabled, budget } => {
                    self.preserve_explicit_intelligence_choice();
                    self.config.thinking_enabled = enabled;
                    self.config.thinking_budget = budget;
                }
                AgentCommand::RefreshModelBudgets => {
                    let model = self.config.model.clone();
                    refresh_model_budgets_with_host(
                        &self.tool_executor,
                        &mut self.config,
                        &mut self.compactor,
                        &model,
                    );
                }
                AgentCommand::SetMaxTokens { max_tokens } => {
                    set_explicit_max_tokens(&mut self.config, max_tokens);
                }
                AgentCommand::InstallProcessBudget {
                    limits,
                    checkpoint,
                    applied,
                } => {
                    let result = self.apply_process_budget(limits, checkpoint);
                    let _ = applied.send(result);
                }
                AgentCommand::ClearProcessBudget {
                    system_prompt,
                    applied,
                } => {
                    let result = self.retire_process_budget(system_prompt);
                    let _ = applied.send(result);
                }
                AgentCommand::SetOutputTokenBudget {
                    max_total_output_tokens,
                } => {
                    self.output_token_budget = Some(max_total_output_tokens);
                }
                AgentCommand::SetSubagentParentScope { parent_scope_id } => {
                    self.tool_executor
                        .set_subagent_parent_scope(parent_scope_id);
                }
                AgentCommand::SetSessionContext {
                    session_id,
                    transcript_path,
                    reason,
                    owns_persistent_tool_spills,
                    preserve_compacted_checkpoint,
                } => {
                    self.apply_session_context(
                        session_id,
                        transcript_path,
                        &reason,
                        owns_persistent_tool_spills,
                        preserve_compacted_checkpoint,
                    )
                    .await;
                }
                AgentCommand::SetHookLogFile { path } => {
                    self.hooks.hook_set_log_file(Some(path)).await;
                }
                AgentCommand::SetGoalToolsVisible { visible } => {
                    self.set_goal_tools_visible(visible);
                }
                AgentCommand::SetApprovalMode { mode } => {
                    self.config.approval_mode = mode;
                }
                AgentCommand::ReplaceGovernedTools {
                    allowed_tools,
                    external_tool_definitions,
                } => {
                    self.replace_governed_tools(&allowed_tools, external_tool_definitions);
                }
                AgentCommand::SetSteeringMode { mode } => {
                    self.steering_mode = mode;
                }
                AgentCommand::SetFollowUpMode { mode } => {
                    self.follow_up_mode = mode;
                }
                AgentCommand::SetSystemPrompt { system_prompt } => {
                    self.config.system_prompt = Some(system_prompt);
                    self.system_prompt_revision = self.system_prompt_revision.saturating_add(1);
                    self.runtime_prompt_revision = self.runtime_prompt_revision.saturating_add(1);
                    self.refresh_runtime_audit();
                }
                AgentCommand::SetSystemPromptForQueuedPrompt {
                    queue_id,
                    system_prompt,
                } => {
                    self.queued_system_prompts
                        .insert(queue_id, (self.system_prompt_revision, system_prompt));
                }
                AgentCommand::InjectUserNote {
                    content,
                    applied,
                    consumed,
                } => {
                    // Defer until idle so we never insert a user message mid-tool-loop.
                    self.deferred_commands
                        .push_back(AgentCommand::InjectUserNote {
                            content,
                            applied,
                            consumed,
                        });
                }
                other => {
                    self.deferred_commands.push_back(other);
                }
            }
        }
        if cancelled {
            if let Some(token) = &self.cancel_token {
                token.cancel();
            }
        }
        cancelled
    }

    fn apply_user_note(&mut self, content: String, consumed: tokio::sync::oneshot::Sender<()>) {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        self.messages_mut().push(Message {
            role: Role::User,
            content: MessageContent::text(trimmed.to_string()),
        });
        self.pending_user_note_consumptions.push(consumed);
        self.pending_user_note_texts.push(trimmed.to_string());
    }

    fn begin_user_note_consumption(&mut self) {
        debug_assert!(self.active_user_note_consumptions.is_empty());
        self.active_user_note_consumptions
            .append(&mut self.pending_user_note_consumptions);
        self.active_user_note_texts
            .append(&mut self.pending_user_note_texts);
    }

    fn finish_user_note_consumption(&mut self, succeeded: bool) {
        if succeeded {
            for consumed in self.active_user_note_consumptions.drain(..) {
                let _ = consumed.send(());
            }
            self.active_user_note_texts.clear();
        } else {
            self.pending_user_note_consumptions
                .append(&mut self.active_user_note_consumptions);
            self.pending_user_note_texts
                .append(&mut self.active_user_note_texts);
        }
    }

    fn reset_user_note_consumption(&mut self) {
        self.pending_user_note_consumptions.clear();
        self.active_user_note_consumptions.clear();
        self.pending_user_note_texts.clear();
        self.active_user_note_texts.clear();
        self.current_request_user_message_index = None;
    }

    /// Guarantee every assistant tool call in history has a matching tool result.
    ///
    /// A cancelled turn can leave an assistant `ToolUse` block without a
    /// `ToolResult` (the turn aborted after the assistant message was recorded
    /// but before its results were appended). Providers reject such histories
    /// (OpenAI answers 400), which wedges the session: every subsequent prompt
    /// fails the same way. Harvest any results that arrived late on the
    /// tool-response channel and repair the history before giving up on a
    /// turn and, defensively, before each API call.
    fn repair_orphaned_tool_calls(&mut self) {
        let messages = Arc::make_mut(&mut self.messages);
        repair_orphaned_tool_calls(
            messages,
            &mut self.tool_response_coordinator,
            self.tool_executor.managed_policy_metadata(),
        );
    }

    fn reset_tool_response_state(&mut self) {
        self.tool_response_coordinator.reset();
    }

    fn reject_pending_tool_responses_on_cancel(&mut self) {
        self.tool_response_coordinator.reject_buffered_on_cancel();
    }

    fn drain_leading_pending_messages(
        &mut self,
        kind: PromptKind,
        mode: QueueMode,
    ) -> Vec<PendingMessage> {
        let max_count = match mode {
            QueueMode::All => usize::MAX,
            QueueMode::One => 1,
        };
        self.pending_messages
            .drain_leading_kind_and_lineage(kind, max_count)
    }

    fn dequeue_next_turn_messages(&mut self, allow_follow_ups: bool) -> Vec<PendingMessage> {
        let steering = self.drain_leading_pending_messages(PromptKind::Steer, self.steering_mode);
        if !steering.is_empty() {
            return steering;
        }
        if !allow_follow_ups {
            return Vec::new();
        }
        self.drain_leading_pending_messages(PromptKind::FollowUp, self.follow_up_mode)
    }

    fn announce_next_turn_messages(&self, pending: &[PendingMessage]) {
        let Some(first) = pending.first() else {
            return;
        };
        let remaining = self.pending_messages.len();
        let label = first.kind.label();
        let message = if pending.len() == 1 {
            if remaining > 0 {
                format!(
                    "Processing queued {label} #{} ({} remaining)...",
                    first.id, remaining
                )
            } else {
                format!("Processing queued {label} #{}...", first.id)
            }
        } else if remaining > 0 {
            format!(
                "Processing {} queued {} message(s) ({} remaining)...",
                pending.len(),
                label,
                remaining
            )
        } else {
            format!(
                "Processing {} queued {} message(s)...",
                pending.len(),
                label
            )
        };
        let _ = self.event_tx.send(FromAgent::Status { message });
    }

    async fn prepare_pending_message(
        &mut self,
        pending: &PendingMessage,
    ) -> Result<Option<(Message, Option<String>)>> {
        // The skills this specific prompt's text triggered take effect here,
        // which is the first point that belongs to its own turn. Applying them
        // at enqueue time would have changed the turn that was still running,
        // and sharing one staged value across the queue let a prompt inherit
        // skills only a later prompt triggered. A staged prompt overtaken by an
        // authoritative
        // `SetSystemPrompt` is dropped: that update is newer and, because skill
        // activation is cumulative, already contains these skills.
        if apply_staged_system_prompt(
            &mut self.queued_system_prompts,
            pending.id,
            self.system_prompt_revision,
            &mut self.config.system_prompt,
            &mut self.runtime_prompt_revision,
        ) {
            self.refresh_runtime_audit();
        }

        let mut prompt = pending.content.clone();
        let mut attachments = pending.attachments.clone();
        let mut prompt_context: Option<String> = None;

        let hook_result = self
            .hooks
            .hook_user_prompt_submit(&prompt, attachments.len() as u32)
            .await;
        match hook_result {
            NativeHookResult::Block { reason } => {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Prompt blocked by hook: {reason}"),
                    fatal: false,
                    terminal: false,
                    retryable: false,
                });
                return Ok(None);
            }
            NativeHookResult::ModifyInput { new_input } => {
                Self::apply_message_hook_modification(&mut prompt, &mut attachments, new_input);
            }
            NativeHookResult::InjectContext { context } => {
                Self::merge_prompt_context(&mut prompt_context, context);
            }
            NativeHookResult::Continue => {}
        }

        let hook_result = self
            .hooks
            .hook_pre_message(&prompt, &attachments, Some(&self.config.model))
            .await;
        match hook_result {
            NativeHookResult::Block { reason } => {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Prompt blocked by hook: {reason}"),
                    fatal: false,
                    terminal: false,
                    retryable: false,
                });
                return Ok(None);
            }
            NativeHookResult::ModifyInput { new_input } => {
                Self::apply_message_hook_modification(&mut prompt, &mut attachments, new_input);
            }
            NativeHookResult::InjectContext { context } => {
                Self::merge_prompt_context(&mut prompt_context, context);
            }
            NativeHookResult::Continue => {}
        }

        let mut blocks = vec![ContentBlock::Text { text: prompt }];
        let attachment_blocks = self.load_attachment_blocks(&attachments).await;
        blocks.extend(attachment_blocks);

        let content = if blocks.len() == 1 {
            match &blocks[0] {
                ContentBlock::Text { text } => MessageContent::text(text.clone()),
                _ => MessageContent::Blocks(blocks),
            }
        } else {
            MessageContent::Blocks(blocks)
        };

        Ok(Some((
            Message {
                role: Role::User,
                content,
            },
            prompt_context,
        )))
    }

    async fn append_pending_messages_for_turn(
        &mut self,
        pending: Vec<PendingMessage>,
    ) -> Result<bool> {
        let managed_request_lineage = pending
            .first()
            .and_then(|message| message.managed_request_lineage.clone());
        let managed_inference_authorization = pending
            .first()
            .and_then(|message| message.managed_inference_authorization.clone());
        let mut next_prompt_context: Option<String> = None;
        let mut appended = false;
        for pending_message in pending {
            if let Some((message, prompt_context)) =
                self.prepare_pending_message(&pending_message).await?
            {
                self.messages_mut().push(message);
                if pending_message.id != 0 {
                    self.processed_prompt_queue_ids.insert(pending_message.id);
                }
                if let Some(context) = prompt_context {
                    Self::merge_prompt_context(&mut next_prompt_context, context);
                }
                appended = true;
            }
        }
        self.prompt_context = next_prompt_context;
        if appended {
            if let Some(client) = self.client.as_mut() {
                client.set_managed_request_lineage(managed_request_lineage);
                client.set_managed_inference_authorization(
                    managed_inference_authorization.map(ManagedInferenceAuthorization::into_inner),
                );
            }
        }
        Ok(appended)
    }

    fn stop_reason_label(reason: crate::ai::StopReason) -> &'static str {
        match reason {
            crate::ai::StopReason::EndTurn => "end_turn",
            crate::ai::StopReason::MaxTokens => "max_tokens",
            crate::ai::StopReason::StopSequence => "stop_sequence",
            crate::ai::StopReason::ToolUse => "tool_use",
        }
    }

    async fn load_attachment_blocks(&self, raw_paths: &[String]) -> Vec<ContentBlock> {
        if raw_paths.is_empty() {
            return Vec::new();
        }

        let mut blocks = Vec::new();

        for raw in raw_paths {
            match self.tool_executor.file_read_verdict(raw) {
                NativeFirewallVerdict::Block { reason } => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Attachment blocked: {reason}"),
                        fatal: false,
                        terminal: false,
                        retryable: false,
                    });
                    continue;
                }
                NativeFirewallVerdict::RequireApproval { reason } => {
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Attachment is sensitive: {reason} (attaching anyway)"),
                    });
                }
                NativeFirewallVerdict::Allow => {}
            }

            let path = self.resolve_attachment_path(raw);

            let meta = match fs::metadata(&path).await {
                Ok(m) => m,
                Err(e) => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Failed to read attachment metadata for {raw}: {e}"),
                        fatal: false,
                        terminal: false,
                        retryable: false,
                    });
                    continue;
                }
            };

            if !meta.is_file() {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment is not a file: {raw}"),
                    fatal: false,
                    terminal: false,
                    retryable: false,
                });
                continue;
            }

            let video_info = self.tool_executor.video_mime(&path);
            let video_mime = video_info.as_ref().map(|(mime, _)| mime.as_str());
            let attachment_limit = video_info
                .as_ref()
                .map_or(Self::MAX_ATTACHMENT_BYTES, |(_, limit)| *limit);
            if meta.len() > attachment_limit {
                let size_mb = meta.len().div_ceil(1024 * 1024);
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment too large ({size_mb}MB): {raw}"),
                    fatal: false,
                    terminal: false,
                    retryable: false,
                });
                continue;
            }

            if let Some(mime) = video_mime {
                match self.tool_executor.extract_video_frames(&path).await {
                    Ok(frames) => {
                        blocks.push(ContentBlock::Text {
                            text: format!(
                                "\n\n[Video: {} ({mime}); {} sampled frames follow]",
                                path.file_name()
                                    .and_then(|name| name.to_str())
                                    .unwrap_or(raw),
                                frames.len()
                            ),
                        });
                        blocks.extend(frames.into_iter().map(|data| ContentBlock::Image {
                            source: ImageSource::Base64 {
                                media_type: "image/jpeg".to_string(),
                                data,
                            },
                        }));
                    }
                    Err(error) => {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: format!("Failed to process video attachment {raw}: {error}"),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                    }
                }
                continue;
            }

            if let Some(mime) = Self::detect_image_mime(&path) {
                match fs::read(&path).await {
                    Ok(bytes) => {
                        let data = STANDARD.encode(&bytes);
                        blocks.push(ContentBlock::Image {
                            source: ImageSource::Base64 {
                                media_type: mime.to_string(),
                                data,
                            },
                        });
                    }
                    Err(e) => {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: format!("Failed to read image attachment {raw}: {e}"),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                    }
                }
                continue;
            }

            match fs::read_to_string(&path).await {
                Ok(text) => {
                    let truncated = Self::truncate_text(&text, Self::MAX_TEXT_ATTACHMENT_CHARS);
                    let file_name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(raw.as_str());
                    blocks.push(ContentBlock::Text {
                        text: format!("\n\n[Document: {file_name}]\n{truncated}"),
                    });
                }
                Err(e) => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Unsupported attachment (not image/utf8 text) {raw}: {e}"),
                        fatal: false,
                        terminal: false,
                        retryable: false,
                    });
                }
            }
        }

        blocks
    }

    /// Run the background task loop
    async fn run(mut self) {
        loop {
            if self.shutdown_token.is_cancelled() {
                break;
            }
            let (cmd, activated_request_token) =
                if let Some(command) = self.take_deferred_command().await {
                    command
                } else {
                    let command =
                        recv_command_or_shutdown(&self.shutdown_token, &mut self.command_rx).await;
                    let Some(command) = command else {
                        break;
                    };
                    self.activate_received_command(command).await
                };
            let Some(cmd) = command_after_shutdown_check(cmd, &self.shutdown_token) else {
                break;
            };
            match cmd {
                AgentCommand::ApplySelectiveSummary {
                    messages,
                    digest,
                    reply,
                } => {
                    let result = if self.busy
                        || !self.pending_messages.is_empty()
                        || !self.deferred_commands.is_empty()
                        || !self.command_rx.is_empty()
                    {
                        Err(anyhow::anyhow!(
                            "Wait for the current turn and queued messages to finish"
                        ))
                    } else {
                        self.apply_selective_summary_history(messages, &digest)
                            .await
                    };
                    let _ = reply.send(result);
                }
                AgentCommand::SelectiveSummaryPreview { reply } => {
                    let result = if self.busy
                        || !self.pending_messages.is_empty()
                        || !self.deferred_commands.is_empty()
                        || !self.command_rx.is_empty()
                    {
                        Err(anyhow::anyhow!(
                            "Wait for the current turn and queued messages to finish"
                        ))
                    } else {
                        super::selective_summary::preview(&self.messages)
                    };
                    let _ = reply.send(result);
                }
                AgentCommand::SelectiveSummary {
                    selection,
                    digest,
                    instructions,
                    cancellation,
                    mut reply,
                } => {
                    let mut usage = TokenUsage::default();
                    let mut saw_usage = false;
                    let result = if self.busy
                        || !self.pending_messages.is_empty()
                        || !self.deferred_commands.is_empty()
                        || !self.command_rx.is_empty()
                    {
                        Err(anyhow::anyhow!(
                            "Wait for the current turn and queued messages to finish"
                        ))
                    } else {
                        // Keep the task alive to settle usage when the UI cancels.
                        let dropped = cancellation.clone();
                        let operation = self.run_selective_summary(
                            selection,
                            &digest,
                            instructions.as_deref(),
                            &cancellation,
                            &mut usage,
                            &mut saw_usage,
                        );
                        tokio::pin!(operation);
                        tokio::select! {
                            result = &mut operation => result,
                            () = reply.closed() => { dropped.cancel(); operation.await }
                        }
                    };
                    if saw_usage {
                        self.output_tokens_spent =
                            self.output_tokens_spent.saturating_add(usage.output_tokens);
                    }
                    let _ = reply.send(super::SelectiveSummaryOutcome {
                        usage: (saw_usage || usage.cost.is_some()).then_some(usage),
                        result,
                    });
                }
                AgentCommand::RequeueFollowUpFront {
                    content,
                    attachments,
                    queue_id,
                    managed_request_lineage,
                } => {
                    match self
                        .resolve_managed_request_lineage(managed_request_lineage)
                        .await
                    {
                        Ok(lineage) => {
                            self.requeue_follow_up_front(content, attachments, queue_id, lineage);
                        }
                        Err(error) => self.reject_managed_request(error),
                    }
                    continue;
                }
                AgentCommand::InjectUserNote {
                    content,
                    applied,
                    consumed,
                } => {
                    if self.busy {
                        self.deferred_commands
                            .push_back(AgentCommand::InjectUserNote {
                                content,
                                applied,
                                consumed,
                            });
                        continue;
                    }
                    self.apply_user_note(content, consumed);
                    let _ = applied.send(());
                    continue;
                }
                AgentCommand::EnsureProviderPromptInstalled { applied } => {
                    let result = if self.model_route.uses_app_server() {
                        self.ensure_codex_session()
                            .await
                            .map_err(|error| format!("{error:#}"))
                    } else {
                        Ok(())
                    };
                    let _ = applied.send(result);
                    continue;
                }
                AgentCommand::Prompt {
                    content,
                    attachments,
                    kind,
                    queue_id,
                    managed_request_lineage,
                    managed_inference_authorization,
                } => {
                    let managed_request_lineage = match self
                        .resolve_managed_request_lineage(managed_request_lineage)
                        .await
                    {
                        Ok(lineage) => lineage,
                        Err(error) => {
                            self.reject_managed_request(error);
                            continue;
                        }
                    };
                    if self.busy {
                        self.enqueue_pending_prompt(
                            content,
                            attachments,
                            kind,
                            queue_id,
                            managed_request_lineage,
                            managed_inference_authorization,
                        );
                        continue;
                    }

                    if let Some(client) = self.client.as_mut() {
                        client.set_managed_request_lineage(managed_request_lineage);
                        client.set_managed_inference_authorization(
                            managed_inference_authorization
                                .map(ManagedInferenceAuthorization::into_inner),
                        );
                    }

                    if kind == PromptKind::SideQuestion {
                        self.busy = true;
                        self.run_side_question(content, true).await;
                        self.busy = false;
                        self.emit_conversation_snapshot();
                        let _ = self.event_tx.send(FromAgent::ResponseEnd {
                            response_id: "done".to_string(),
                            usage: None,
                        });
                        continue;
                    }

                    self.busy = true;
                    self.workflow_state.reset();
                    self.tool_executor.reset_coding_turn();

                    let mut prompt = content;
                    let mut attachments = attachments;
                    let mut prompt_context: Option<String> = None;

                    // Execute UserPromptSubmit hooks
                    let hook_result = self
                        .hooks
                        .hook_user_prompt_submit(&prompt, attachments.len() as u32)
                        .await;
                    match hook_result {
                        NativeHookResult::Block { reason } => {
                            self.emit_conversation_snapshot();
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Prompt blocked by hook: {reason}"),
                                fatal: false,
                                terminal: true,
                                retryable: false,
                            });
                            self.busy = false;
                            self.set_active_request_cancel_token(None);
                            self.prompt_context = None;
                            continue;
                        }
                        NativeHookResult::ModifyInput { new_input } => {
                            Self::apply_message_hook_modification(
                                &mut prompt,
                                &mut attachments,
                                new_input,
                            );
                        }
                        NativeHookResult::InjectContext { context } => {
                            Self::merge_prompt_context(&mut prompt_context, context);
                        }
                        NativeHookResult::Continue => {}
                    }

                    // Execute PreMessage hooks
                    let hook_result = self
                        .hooks
                        .hook_pre_message(&prompt, &attachments, Some(&self.config.model))
                        .await;
                    match hook_result {
                        NativeHookResult::Block { reason } => {
                            self.emit_conversation_snapshot();
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Prompt blocked by hook: {reason}"),
                                fatal: false,
                                terminal: true,
                                retryable: false,
                            });
                            self.busy = false;
                            self.set_active_request_cancel_token(None);
                            self.prompt_context = None;
                            continue;
                        }
                        NativeHookResult::ModifyInput { new_input } => {
                            Self::apply_message_hook_modification(
                                &mut prompt,
                                &mut attachments,
                                new_input,
                            );
                        }
                        NativeHookResult::InjectContext { context } => {
                            Self::merge_prompt_context(&mut prompt_context, context);
                        }
                        NativeHookResult::Continue => {}
                    }

                    self.prompt_context = prompt_context;

                    // Create cancellation token for this request
                    let cancel_token = activated_request_token.unwrap_or_else(|| {
                        let token = CancellationToken::new();
                        self.set_active_request_cancel_token(Some(token.clone()));
                        token
                    });

                    let mut blocks = Vec::new();
                    blocks.push(ContentBlock::Text { text: prompt });
                    match load_until_cancelled(
                        self.load_attachment_blocks(&attachments),
                        &cancel_token,
                        &self.shutdown_token,
                    )
                    .await
                    {
                        CancellableLoad::Loaded(attachment_blocks) => {
                            blocks.extend(attachment_blocks);
                        }
                        CancellableLoad::RequestCancelled => {
                            // Preserve the normal cancelled-request terminal below.
                        }
                        CancellableLoad::Shutdown => {
                            self.busy = false;
                            self.set_active_request_cancel_token(None);
                            self.prompt_context = None;
                            break;
                        }
                    }

                    let content = if blocks.len() == 1 {
                        match &blocks[0] {
                            ContentBlock::Text { text } => MessageContent::text(text.clone()),
                            _ => MessageContent::Blocks(blocks),
                        }
                    } else {
                        MessageContent::Blocks(blocks)
                    };

                    let current_prompt_index = self.messages.len();
                    self.messages_mut().push(Message {
                        role: Role::User,
                        content,
                    });
                    if let Some(queue_id) = queue_id {
                        self.processed_prompt_queue_ids.insert(queue_id);
                    }
                    self.current_request_user_message_index = Some(current_prompt_index);
                    let current_prompt_uses_codex = self.model_route.uses_app_server();
                    if current_prompt_uses_codex {
                        self.codex_current_prompt_started = false;
                    }

                    // Reset retry policy for new request
                    self.retry_policy.reset();
                    self.begin_user_note_consumption();
                    // Provider retries are attempts within this user turn, not
                    // fresh turns. Keep refusal memory and the provider
                    // round-trip ceiling outside the retry loop so neither is
                    // reset by a transient request failure.
                    self.denial_memory.begin_turn();
                    let mut step_budget =
                        TurnStepBudget::new(self.config.resolved_max_turn_steps());

                    // Run the agent loop with cancellation and retry support
                    let shutdown_token = self.shutdown_token.clone();
                    let active_cancellation = Arc::clone(&self.active_cancellation);
                    let mut request_cancelled = false;
                    let mut terminal_request_failure = false;
                    let mut terminal_failure_event = None;
                    let mut waited_for_codex_login = false;
                    let mut codex_transport_restarted = false;
                    let mut codex_auth_resumed = false;
                    loop {
                        let result = run_request_with_cancellation(
                            self.run_loop(&mut step_budget),
                            &cancel_token,
                            &shutdown_token,
                            &active_cancellation,
                        )
                        .await;

                        match result {
                            Ok(()) => break,
                            Err(e) => {
                                let provider_stream_failure = e
                                    .downcast_ref::<ProviderStreamFailure>()
                                    .map(|error| (error.kind, error.message.clone()));
                                let provider_admission_denied =
                                    e.downcast_ref::<ProviderAdmissionDenied>().is_some();
                                let empty_assistant_response =
                                    e.downcast_ref::<EmptyAssistantResponse>().is_some();
                                // Preserve the complete anyhow cause chain so
                                // connect/inject/start errors retain provider
                                // retry metadata hidden below their RPC context.
                                let msg = format!("{e:#}");
                                if msg == "Request cancelled" {
                                    request_cancelled = true;
                                    break;
                                }

                                // Classify error and check if we should retry. The host's
                                // admission reason is diagnostic text and may contain words
                                // such as "timeout". Never let that text turn an authoritative
                                // admission decision into an outer retry that could open a new
                                // provider request.
                                let error_kind = if provider_admission_denied {
                                    super::retry::ErrorKind::Unknown
                                } else {
                                    super::retry::ErrorKind::classify(&msg)
                                };
                                if current_prompt_uses_codex
                                    && !self.codex_current_prompt_started
                                    && !waited_for_codex_login
                                    && matches!(error_kind, super::retry::ErrorKind::AuthFailure)
                                {
                                    waited_for_codex_login = true;
                                    let auth = match self.tool_executor.codex_auth_context() {
                                        Ok(auth) => auth,
                                        Err(error) => {
                                            terminal_failure_event = Some(FromAgent::Error {
                                                message: error,
                                                fatal: false,
                                                terminal: true,
                                                retryable: false,
                                            });
                                            terminal_request_failure = true;
                                            break;
                                        }
                                    };
                                    let requested_profile = (auth.profile_name != "default")
                                        .then_some(auth.profile_name.clone());
                                    let profile_arg = requested_profile
                                        .as_deref()
                                        .map(|name| format!(" --profile {name}"))
                                        .unwrap_or_default();
                                    let _ = self.event_tx.send(FromAgent::Status {
                                        message: format!(
                                            "Codex sign-in needs attention. Run `deixic-code codex login{profile_arg} --force`; this prompt will resume after sign-in."
                                        ),
                                    });
                                    if wait_for_codex_auth_refresh(
                                        &self.tool_executor,
                                        &auth.auth_path,
                                        &cancel_token,
                                        &shutdown_token,
                                        Duration::from_mins(5),
                                    )
                                    .await
                                    {
                                        self.codex_session = None;
                                        codex_auth_resumed = true;
                                        continue;
                                    }
                                    if cancel_token.is_cancelled() || shutdown_token.is_cancelled()
                                    {
                                        request_cancelled = cancel_token.is_cancelled();
                                        break;
                                    }
                                }

                                let retry_decision = if step_budget
                                    .discarded_attempt_limit_reached()
                                {
                                    super::retry::RetryDecision::GiveUp {
                                        reason: "Native turn stopped after three discarded model attempts".into(),
                                    }
                                } else {
                                    request_retry_decision(
                                        &mut self.retry_policy,
                                        error_kind,
                                        if provider_stream_failure.is_some() {
                                            RequestFailureOwner::ProviderStream
                                        } else {
                                            RequestFailureOwner::Request
                                        },
                                    )
                                };
                                match retry_decision {
                                    super::retry::RetryDecision::Retry {
                                        delay,
                                        attempt,
                                        reason,
                                    } => {
                                        if current_prompt_uses_codex
                                            && !self.codex_current_prompt_started
                                        {
                                            self.codex_session = None;
                                            codex_transport_restarted = true;
                                            let _ =
                                                self.event_tx.send(FromAgent::CodexSessionState {
                                                    state: "reconnecting".to_owned(),
                                                    thread_id: String::new(),
                                                    profile: String::new(),
                                                });
                                            let _ = self.event_tx.send(FromAgent::Status {
                                                message: "Codex app-server disconnected before the turn started; restarting it safely"
                                                    .to_owned(),
                                            });
                                        }
                                        // Notify UI about retry
                                        let _ = self.event_tx.send(FromAgent::Status {
                                            message: format!(
                                                "{}. Retrying in {:.1}s (attempt {})...",
                                                reason,
                                                delay.as_secs_f64(),
                                                attempt
                                            ),
                                        });

                                        // Wait before retrying, but do not make
                                        // shutdown wait for the backoff timer.
                                        if !wait_for_retry_delay(
                                            delay,
                                            &cancel_token,
                                            &shutdown_token,
                                        )
                                        .await
                                        {
                                            request_cancelled = cancel_token.is_cancelled();
                                            break;
                                        }
                                        let _ =
                                            self.event_tx.send(FromAgent::RequestRetryObservation);
                                    }
                                    super::retry::RetryDecision::GiveUp { reason } => {
                                        // Not retryable or exhausted retries
                                        if empty_assistant_response {
                                            let _ = self.hooks.hook_stop_failure(
                                                "empty_assistant_response",
                                                Some(
                                                    "provider returned no assistant text or tool calls",
                                                ),
                                                None,
                                            )
                                            .await;
                                        }
                                        let hint = if matches!(
                                            error_kind,
                                            super::retry::ErrorKind::AuthFailure
                                        ) {
                                            if current_prompt_uses_codex {
                                                " — run `deixic-code codex status`; if needed, run `deixic-code codex login --force`"
                                            } else {
                                                " — run `deixic-code codex login --force` or set OPENAI_API_KEY"
                                            }
                                        } else {
                                            ""
                                        };
                                        terminal_failure_event = if let Some((kind, message)) =
                                            provider_stream_failure
                                        {
                                            Some(FromAgent::ProviderError { kind, message })
                                        } else {
                                            Some(FromAgent::Error {
                                                message: format!(
                                                    "Agent error: {msg} ({reason}){hint}"
                                                ),
                                                fatal: false,
                                                terminal: true,
                                                retryable: matches!(
                                                    error_kind,
                                                    super::retry::ErrorKind::Transient
                                                        | super::retry::ErrorKind::RateLimited { .. }
                                                ),
                                            })
                                        };
                                        terminal_request_failure = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if current_prompt_uses_codex {
                        if (terminal_request_failure || request_cancelled)
                            && !self.codex_current_prompt_started
                        {
                            let current_prompt = self.messages.get(current_prompt_index);
                            debug_assert!(
                                current_prompt.is_some_and(|message| message.role == Role::User),
                                "current Codex prompt index must still identify its user message"
                            );
                            if current_prompt.is_some_and(|message| message.role == Role::User) {
                                self.messages_mut().remove(current_prompt_index);
                            }
                        }
                        if terminal_request_failure
                            && self.codex_current_prompt_started
                            && !request_cancelled
                        {
                            if let (Some(turn_id), Some(session)) = (
                                self.codex_active_turn_id.take(),
                                self.codex_session.as_ref(),
                            ) {
                                let _ = self.event_tx.send(FromAgent::CodexTurnState {
                                    state: "failed".to_owned(),
                                    thread_id: session.thread_id().to_owned(),
                                    turn_id: Some(turn_id),
                                });
                            }
                        }
                        self.codex_current_prompt_started = false;
                    }

                    if request_cancelled {
                        // The cancellation token is tripped before the queued Cancel
                        // command is observed. Interrupt the provider turn before
                        // draining commands so the server cannot keep generating.
                        self.interrupt_active_codex_turn().await;
                        // Drain the command channel
                        // while this request still owns it so any prompts that preceded
                        // Cancel are stashed instead of being started as a new request
                        // ahead of that cancellation.
                        let _ = self.drain_pending_commands().await;
                    }

                    let completion_event = if !terminal_request_failure && !request_cancelled {
                        match coding_turn_completed_event(&self.tool_executor, "done") {
                            Ok(event) => Some(event),
                            Err(message) => {
                                terminal_request_failure = true;
                                terminal_failure_event = Some(FromAgent::Error {
                                    message,
                                    fatal: false,
                                    terminal: true,
                                    retryable: false,
                                });
                                None
                            }
                        }
                    } else {
                        None
                    };

                    // Count only turns that produced a completion the session
                    // still owns. SessionEnd reports this as turnCount.
                    if !terminal_request_failure && !request_cancelled {
                        self.hooks.hook_increment_turn().await;
                    }
                    self.current_request_user_message_index = None;

                    self.finish_task_boost(request_cancelled).await;
                    self.busy = false;
                    self.set_active_request_cancel_token(None);
                    let codex_transport_receipt = if current_prompt_uses_codex {
                        let outcome = if request_cancelled {
                            "cancelled"
                        } else if terminal_request_failure {
                            "failed"
                        } else {
                            "completed"
                        };
                        Some(FromAgent::CodexTransportReceipt {
                            provider: "openai-codex".to_owned(),
                            transport: "codex-app-server".to_owned(),
                            outcome: outcome.to_owned(),
                            transport_restarted: codex_transport_restarted,
                            auth_resumed: codex_auth_resumed,
                            cancellation_requested: request_cancelled,
                        })
                    } else {
                        None
                    };

                    self.prompt_context = None;

                    self.repair_orphaned_tool_calls();
                    // The semantic checkpoint is private but synchronously
                    // persistable by hosted owners. Publish it before exposing
                    // any terminal that permits the current owner to be killed.
                    self.emit_conversation_snapshot();

                    // Errors are terminal events and clear the TUI busy state.
                    // Publishing ResponseEnd after one would let stream adapters
                    // reinterpret a failed turn as a successful empty response.
                    if let Some(event) = terminal_failure_event {
                        match &event {
                            FromAgent::Error { message, fatal, .. } => {
                                let _ = self
                                    .hooks
                                    .hook_on_error(
                                        message,
                                        "agent_error",
                                        Some("agent_turn"),
                                        !fatal,
                                    )
                                    .await;
                            }
                            FromAgent::ProviderError { kind, message } => {
                                let error_kind = format!("provider_{kind:?}").to_lowercase();
                                let _ = self
                                    .hooks
                                    .hook_on_error(
                                        message,
                                        &error_kind,
                                        Some("provider_stream"),
                                        true,
                                    )
                                    .await;
                            }
                            _ => {}
                        }
                        let _ = self.event_tx.send(event);
                        if let Some(receipt) = codex_transport_receipt {
                            let _ = self.event_tx.send(receipt);
                        }
                    } else {
                        if let Some(receipt) = codex_transport_receipt {
                            let _ = self.event_tx.send(receipt);
                        }
                        let _ = self.event_tx.send(FromAgent::ResponseEnd {
                            response_id: "done".to_string(),
                            usage: None,
                        });
                    }
                    self.finish_user_note_consumption(
                        !terminal_request_failure && !request_cancelled,
                    );
                    if !terminal_request_failure && !request_cancelled {
                        if let Some(event) = completion_event {
                            let _ = self.event_tx.send(event);
                        }
                    } else if request_cancelled {
                        let _ = self.event_tx.send(FromAgent::TurnInterrupted {
                            response_id: "done".to_string(),
                            reason: "cancelled".to_string(),
                        });
                    }
                }
                AgentCommand::Cancel { clear_pending } => {
                    if let Some(token) = &self.cancel_token {
                        token.cancel();
                    }
                    self.clear_pending_on_cancel = clear_pending;
                    self.busy = false;
                    self.prompt_context = None;
                    if clear_pending {
                        // Also clear any pending messages on cancel
                        let cleared = self.pending_messages.clear();
                        if !cleared.is_empty() {
                            let _ = self.event_tx.send(FromAgent::Status {
                                message: format!("Cleared {} pending message(s)", cleared.len()),
                            });
                        }
                    }
                    self.reject_pending_tool_responses_on_cancel();
                }
                AgentCommand::CancelQueued { id } => {
                    // The staged system prompt is not keyed by id and stays
                    // staged: the skills it carries are still active in the UI,
                    // so the next message to start should see them.
                    if let Some(removed) = self.pending_messages.remove_by_id(id) {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!(
                                "Removed queued {} #{}",
                                removed.kind.label(),
                                removed.id
                            ),
                        });
                    } else {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!("No queued prompt found with id #{id}"),
                        });
                    }
                }
                AgentCommand::ReorderQueued { id, placement } => {
                    if !self.pending_messages.move_by_id(id, placement) {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!("No queued prompt found with id #{id}"),
                        });
                    }
                }
                AgentCommand::SetModel { model } => {
                    let policy_id = policy_model_id(&model);
                    if let Some(reason) = self.tool_executor.model_allowed(&policy_id) {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: reason.clone(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        let _ = self
                            .event_tx
                            .send(FromAgent::ModelChangeFailed { model, reason });
                        continue;
                    }

                    match self.tool_executor.resolve_model(&model) {
                        Ok(resolved) => {
                            let NativeResolvedClient {
                                client,
                                provider_name: provider,
                                model_route,
                            } = resolved;
                            // Admit the replacement before discarding the live transport.
                            self.codex_session = None;
                            self.codex_active_turn_id = None;
                            self.preserve_explicit_intelligence_choice();
                            let requested_thinking = super::model_dynamics::thinking_level(
                                self.config.thinking_enabled,
                                self.config.thinking_budget,
                            );
                            let thinking = self
                                .tool_executor
                                .normalize_thinking(&model, requested_thinking);
                            let (thinking_enabled, thinking_budget) = thinking.to_config();
                            self.config.thinking_enabled = thinking_enabled;
                            self.config.thinking_budget = thinking_budget;
                            self.client = client;
                            self.model_route = model_route;
                            refresh_model_budgets_with_host(
                                &self.tool_executor,
                                &mut self.config,
                                &mut self.compactor,
                                &model,
                            );
                            self.config.model = model.clone();
                            self.hooks.hook_set_model(&model).await;
                            let _ = self
                                .event_tx
                                .send(FromAgent::ModelChanged { model, provider });
                            let _ = self.event_tx.send(FromAgent::BoostChanged {
                                status: super::model_dynamics::BoostStatus::Idle,
                                thinking: Some(thinking),
                            });
                        }
                        Err(e) => {
                            let message = format!("Failed to set model: {e}");
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: message.clone(),
                                fatal: false,
                                terminal: false,
                                retryable: false,
                            });
                            let _ = self.event_tx.send(FromAgent::ModelChangeFailed {
                                model,
                                reason: message,
                            });
                        }
                    }
                }
                AgentCommand::SetContextToolExcluded { name, excluded } => {
                    self.set_context_tool_excluded(&name, excluded);
                }
                AgentCommand::Boost => {
                    let mut state = self.dynamics.lock().expect("model dynamics mutex");
                    if !state.used {
                        state.requested = true;
                        state.status = super::model_dynamics::BoostStatus::Pending;
                        let _ = self.event_tx.send(FromAgent::BoostChanged {
                            status: state.status,
                            thinking: None,
                        });
                    }
                }
                AgentCommand::SetThinking { enabled, budget } => {
                    self.preserve_explicit_intelligence_choice();
                    self.config.thinking_enabled = enabled;
                    self.config.thinking_budget = budget;
                }
                AgentCommand::RefreshModelBudgets => {
                    let model = self.config.model.clone();
                    refresh_model_budgets_with_host(
                        &self.tool_executor,
                        &mut self.config,
                        &mut self.compactor,
                        &model,
                    );
                }
                AgentCommand::SetMaxTokens { max_tokens } => {
                    set_explicit_max_tokens(&mut self.config, max_tokens);
                }
                AgentCommand::InstallProcessBudget {
                    limits,
                    checkpoint,
                    applied,
                } => {
                    let result = self.apply_process_budget(limits, checkpoint);
                    let _ = applied.send(result);
                }
                AgentCommand::ClearProcessBudget {
                    system_prompt,
                    applied,
                } => {
                    let result = self.retire_process_budget(system_prompt);
                    let _ = applied.send(result);
                }
                AgentCommand::SetOutputTokenBudget {
                    max_total_output_tokens,
                } => {
                    self.output_token_budget = Some(max_total_output_tokens);
                }
                AgentCommand::SetSubagentParentScope { parent_scope_id } => {
                    self.tool_executor
                        .set_subagent_parent_scope(parent_scope_id);
                }
                AgentCommand::SetSessionContext {
                    session_id,
                    transcript_path,
                    reason,
                    owns_persistent_tool_spills,
                    preserve_compacted_checkpoint,
                } => {
                    self.apply_session_context(
                        session_id,
                        transcript_path,
                        &reason,
                        owns_persistent_tool_spills,
                        preserve_compacted_checkpoint,
                    )
                    .await;
                }
                AgentCommand::SetHookLogFile { path } => {
                    self.hooks.hook_set_log_file(Some(path)).await;
                }
                AgentCommand::SetGoalToolsVisible { visible } => {
                    self.set_goal_tools_visible(visible);
                }
                AgentCommand::SetApprovalMode { mode } => {
                    self.config.approval_mode = mode;
                }
                AgentCommand::ReplaceGovernedTools {
                    allowed_tools,
                    external_tool_definitions,
                } => {
                    self.replace_governed_tools(&allowed_tools, external_tool_definitions);
                }
                AgentCommand::SetSteeringMode { mode } => {
                    self.steering_mode = mode;
                }
                AgentCommand::SetFollowUpMode { mode } => {
                    self.follow_up_mode = mode;
                }
                AgentCommand::SetSystemPrompt { system_prompt } => {
                    self.config.system_prompt = Some(system_prompt);
                    self.system_prompt_revision = self.system_prompt_revision.saturating_add(1);
                    self.runtime_prompt_revision = self.runtime_prompt_revision.saturating_add(1);
                    self.refresh_runtime_audit();
                }
                AgentCommand::SetSystemPromptForQueuedPrompt {
                    queue_id,
                    system_prompt,
                } => {
                    self.queued_system_prompts
                        .insert(queue_id, (self.system_prompt_revision, system_prompt));
                }
                AgentCommand::ClearHistory => {
                    self.semantic_continuation = None;
                    self.reset_tool_response_state();
                    self.reset_user_note_consumption();
                    self.messages_mut().clear();
                    self.codex_session = None;
                    self.codex_history_restore_prefix_len = None;
                    self.codex_current_prompt_started = false;
                    self.pending_messages.clear();
                    // The prompts it was staged for are gone with the queue.
                    self.queued_system_prompts.clear();
                    self.notify_extensions_user_turn_start();
                    self.credential_vault.clear();
                }
                AgentCommand::ReplaceHistory {
                    messages,
                    continuation,
                } => {
                    self.semantic_continuation = continuation;
                    self.reset_tool_response_state();
                    self.reset_user_note_consumption();
                    let restored_prefix_len = messages.len();
                    self.messages = Arc::new(messages);
                    self.codex_session = None;
                    self.codex_history_restore_prefix_len = Some(restored_prefix_len);
                    self.codex_current_prompt_started = false;
                    self.compact_codex_history_for_boundary();
                    self.pending_messages.clear();
                    // The prompts it was staged for are gone with the queue.
                    self.queued_system_prompts.clear();
                    self.notify_extensions_user_turn_start();
                    // Replacing history is used for session restore. References
                    // from the previous active session must not cross that boundary.
                    self.credential_vault.clear();
                }
                AgentCommand::ReplaceHistoryPreservingCredentials { messages } => {
                    self.semantic_continuation = None;
                    self.reset_user_note_consumption();
                    let restored_prefix_len = messages.len();
                    // `main` stores runner history in an Arc; keep this
                    // assignment compatible with both the pre-merge Vec and
                    // the current shared-history representation.
                    self.messages = history_storage(messages);
                    self.codex_session = None;
                    self.codex_history_restore_prefix_len = Some(restored_prefix_len);
                    self.codex_current_prompt_started = false;
                    self.compact_codex_history_for_boundary();
                    self.pending_messages.clear();
                    // The prompts it was staged for are gone with the queue.
                    self.queued_system_prompts.clear();
                    self.notify_extensions_user_turn_start();
                }
                AgentCommand::Continue => {
                    // Continue from current context without adding a new user message
                    // Used for retry after transient errors
                    if self.busy {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: "Agent is busy".to_string(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        continue;
                    }

                    // Need at least some history to continue from
                    if self.messages.is_empty() {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: "Cannot continue: no conversation history".to_string(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        continue;
                    }

                    self.busy = true;
                    self.current_request_user_message_index = None;
                    self.begin_user_note_consumption();
                    self.denial_memory.begin_turn();
                    let mut step_budget =
                        TurnStepBudget::new(self.config.resolved_max_turn_steps());
                    let cancel_token = CancellationToken::new();
                    self.set_active_request_cancel_token(Some(cancel_token.clone()));
                    let shutdown_token = self.shutdown_token.clone();
                    let active_cancellation = Arc::clone(&self.active_cancellation);

                    // Run the agent loop without adding a user message
                    let result = run_request_with_cancellation(
                        self.run_loop(&mut step_budget),
                        &cancel_token,
                        &shutdown_token,
                        &active_cancellation,
                    )
                    .await;

                    let mut request_succeeded = result.is_ok();
                    let mut request_cancelled = false;
                    let mut request_failure_event = None;
                    if let Err(e) = result {
                        let provider_stream_failure = e
                            .downcast_ref::<ProviderStreamFailure>()
                            .map(|error| (error.kind, error.message.clone()));
                        let msg = e.to_string();
                        if msg == "Request cancelled" {
                            request_cancelled = true;
                        } else if let Some((kind, message)) = provider_stream_failure {
                            request_failure_event =
                                Some(FromAgent::ProviderError { kind, message });
                        } else {
                            request_failure_event = Some(FromAgent::Error {
                                message: format!("Agent error: {e}"),
                                fatal: false,
                                terminal: true,
                                retryable: matches!(
                                    super::retry::ErrorKind::classify(&msg),
                                    super::retry::ErrorKind::Transient
                                        | super::retry::ErrorKind::RateLimited { .. }
                                ),
                            });
                        }
                    }

                    let completion_event = if request_succeeded {
                        match coding_turn_completed_event(&self.tool_executor, "continue") {
                            Ok(event) => Some(event),
                            Err(message) => {
                                request_succeeded = false;
                                request_failure_event = Some(FromAgent::Error {
                                    message,
                                    fatal: false,
                                    terminal: true,
                                    retryable: false,
                                });
                                None
                            }
                        }
                    } else {
                        None
                    };

                    self.finish_task_boost(request_cancelled).await;
                    self.busy = false;
                    self.set_active_request_cancel_token(None);
                    self.prompt_context = None;
                    self.current_request_user_message_index = None;

                    self.repair_orphaned_tool_calls();
                    self.emit_conversation_snapshot();

                    if let Some(event) = request_failure_event {
                        let _ = self.event_tx.send(event);
                    } else {
                        let _ = self.event_tx.send(FromAgent::ResponseEnd {
                            response_id: "continue".to_string(),
                            usage: None,
                        });
                    }
                    self.finish_user_note_consumption(request_succeeded);
                    if request_succeeded {
                        if let Some(event) = completion_event {
                            let _ = self.event_tx.send(event);
                        }
                    } else if request_cancelled {
                        let _ = self.event_tx.send(FromAgent::TurnInterrupted {
                            response_id: "continue".to_string(),
                            reason: "cancelled".to_string(),
                        });
                    }
                }
            }
        }

        // Close the active session for hooks here rather than from the caller.
        // The app's own exit path is skipped entirely on SIGINT/SIGTERM --
        // `run_with_shutdown` drops the `app.run()` future and then cancels the
        // runner -- and a command sent at that point would race the
        // cancellation. This runs on every way out of the loop, so a handled
        // signal, a normal quit, and a closed command channel all emit it.
        self.apply_session_context(None, None, "shutdown", false, false)
            .await;

        self.tool_executor.shutdown_background_processes().await;
    }

    /// Apply a session transition to the hook system.
    ///
    /// Dispatches `SessionEnd` for the session being left and `SessionStart`
    /// for the one being entered, and stamps the new id onto every subsequent
    /// hook payload. The end fires before the id changes so its payload names
    /// the session that actually ended.
    ///
    /// Both events are advisory: their results are logged by the hook system
    /// and cannot block a session transition the user has already made.
    async fn apply_session_context(
        &mut self,
        session_id: Option<String>,
        transcript_path: Option<String>,
        reason: &str,
        owns_persistent_tool_spills: bool,
        preserve_compacted_checkpoint: bool,
    ) {
        self.owns_persistent_tool_spills = owns_persistent_tool_spills && session_id.is_some();
        let previous_session = self.hooks.hook_session_id().await;
        if previous_session == session_id {
            self.hooks
                .hook_set_session_context(session_id, transcript_path)
                .await;
            return;
        }
        if previous_session.is_some() {
            let mut audit = self
                .runtime_audit
                .write()
                .unwrap_or_else(|p| p.into_inner());
            let retain_checkpoint = preserve_compacted_checkpoint
                && session_id.is_some()
                && audit.request_cache.as_ref().is_some_and(|snapshot| {
                    snapshot.cache_topology.as_ref().is_some_and(|topology| {
                        topology.transition
                            == maestro_ai::cache_topology::CacheTransition::HistoryRewritten
                    })
                });
            if !retain_checkpoint {
                audit.request_cache = None;
                audit.cache_reuse = None;
            }
            if let Some(record) = &mut self.semantic_continuation {
                record.tool_outputs.clear();
            }
        }
        self.runtime_audit
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .excluded_context_tools
            .clear();
        self.model_tool_cache = None;
        self.refresh_runtime_audit();
        // A live app-server thread is bound to the prior explicit session.
        // Drop it before changing identity so the next turn resolves the
        // session-aware persistent binding instead of reusing that thread.
        self.codex_session = None;
        self.tool_executor.reset_coding_turn();
        if self.hooks.hook_session_id().await.is_some() {
            let _ = self.hooks.hook_on_session_end(reason).await;
        }
        self.hooks
            .hook_set_session_context(session_id.clone(), transcript_path)
            .await;
        if session_id.is_some() {
            let _ = self.hooks.hook_on_session_start(reason).await;
        }
    }

    /// Output allowance for the request this runner is about to build.
    ///
    /// Without a cumulative budget this is the configured per-request
    /// `max_tokens`. With one, the request is additionally clamped to the part
    /// of the budget the run has not spent, so a run that calls tools cannot be
    /// granted the full allowance again on every request.
    ///
    /// The floor of 1 keeps the request valid for providers that reject
    /// `max_tokens: 0`. A run that has reached its budget is stopped by the
    /// caller that set it; this function does not end turns.
    fn remaining_output_token_allowance(&self) -> u32 {
        output_token_allowance(
            self.config.max_tokens,
            self.output_token_budget,
            self.output_tokens_spent,
        )
    }

    /// Build request configuration
    async fn build_config(
        &mut self,
        request_messages: &[Message],
        include_tools: bool,
    ) -> Result<RequestConfig> {
        if let Some(state) = self.process_budget.as_ref() {
            if !include_tools {
                anyhow::bail!("process grants do not admit auxiliary model requests");
            }
            state
                .lock()
                .map_err(|_| anyhow::anyhow!("process budget poisoned"))?
                .admit_request()
                .map_err(anyhow::Error::msg)?;
        }
        if include_tools {
            self.apply_requested_boost().await?;
        }
        // These values are cached for the runner lifetime and updated through
        // explicit commands when app-owned goal state changes.
        let goal_tools_visible = self.goal_tools_visible;
        let include_ide_tools = self.include_ide_tools;
        let cached_tools = self
            .model_tool_cache
            .as_ref()
            .filter(|cache| {
                cache.goal_tools_visible == goal_tools_visible
                    && cache.include_ide_tools == include_ide_tools
                    && cache.active_tool_names == self.active_tool_names
            })
            .map(|cache| Arc::clone(&cache.tools));
        let tools = if !include_tools {
            Arc::new(Vec::new())
        } else if let Some(tools) = cached_tools {
            tools
        } else {
            let definitions = effective_tool_definitions(
                &self.tools,
                &self.active_tool_names,
                goal_tools_visible,
                include_ide_tools,
            );
            let tools = Arc::new(
                definitions
                    .into_iter()
                    .map(|definition| definition.tool)
                    .collect(),
            );
            self.model_tool_cache = Some(ModelToolCache {
                goal_tools_visible,
                include_ide_tools,
                active_tool_names: self.active_tool_names.clone(),
                tools: Arc::clone(&tools),
            });
            tools
        };
        let excluded = self
            .runtime_audit
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .excluded_context_tools
            .clone();
        let tools = if excluded.is_empty() {
            tools
        } else {
            Arc::new(
                tools
                    .iter()
                    .filter(|tool| !excluded.contains(&tool.name.to_ascii_lowercase()))
                    .cloned()
                    .collect(),
            )
        };
        self.tool_executor.set_subagent_parent_model(
            self.config.model.clone(),
            super::model_dynamics::thinking_level(
                self.config.thinking_enabled,
                self.config.thinking_budget,
            )
            .label()
            .to_owned(),
        );
        let thinking = if self.config.thinking_enabled {
            Some(ThinkingConfig::enabled(self.config.thinking_budget))
        } else {
            None
        };

        let system = runtime_system_prompt(
            self.config.system_prompt.as_deref(),
            if include_tools {
                None
            } else {
                self.prompt_context.as_deref()
            },
            &self.config.model,
            self.tool_executor.model_capabilities(&self.config.model),
        );
        self.refresh_runtime_audit_with_prompt(system.clone());

        let configured_model = self.config.model.trim();
        let model = if ["evalops/", "maestro-managed/"].iter().any(|prefix| {
            configured_model
                .get(..prefix.len())
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
        }) {
            // Preserve the managed namespace for telemetry and let the
            // managed OpenAI boundary strip it immediately before dispatch.
            configured_model.to_string()
        } else {
            provider_model_name(configured_model)
        };

        let mut max_tokens = self.remaining_output_token_allowance();
        if let Some(context_tokens) = self
            .tool_executor
            .is_local_model(&self.config.model)
            .then(|| self.tool_executor.model_context_window(&self.config.model))
            .flatten()
            .filter(|tokens| *tokens > 0)
        {
            let estimated_input_tokens = self
                .compactor
                .estimate_tokens(request_messages)
                .saturating_add(
                    system
                        .as_deref()
                        .map_or(0, maestro_context::token_estimation::estimate_tokens),
                )
                .saturating_add(
                    maestro_context::token_estimation::estimate_tokens_from_json(tools.as_ref()),
                )
                .saturating_add(if include_tools {
                    self.prompt_context
                        .as_deref()
                        .map_or(0, maestro_context::token_estimation::estimate_tokens)
                } else {
                    0
                });
            max_tokens = clamp_output_to_remaining_context(
                max_tokens,
                context_tokens,
                estimated_input_tokens,
            )
            .with_context(|| {
                format!(
                    "Local model request input estimate ({estimated_input_tokens} tokens) fills the live {context_tokens}-token context; reduce the prompt/history/tools or increase the runtime context"
                )
            })?;
        }

        let mut config = RequestConfig {
            model,
            max_tokens,
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system,
            tools,
            thinking,
            cache_topology: None,
            // Enable prompt caching for Anthropic models
            cache_system_prompt: self
                .client
                .as_ref()
                .is_some_and(|client| client.provider() == AiProvider::Anthropic),
        };
        let mut audit = self
            .runtime_audit
            .write()
            .unwrap_or_else(|p| p.into_inner());
        if include_tools {
            let namespace = self
                .client
                .as_ref()
                .map(|client| client.cache_namespace())
                .transpose()?
                .unwrap_or_else(|| "local".into());
            let previous = audit
                .request_cache
                .as_ref()
                .and_then(|snapshot| snapshot.cache_topology.as_ref());
            config.cache_topology = Some(
                maestro_ai::cache_topology::PreparedPrompt::prepare(
                    request_messages,
                    &config,
                    namespace,
                    previous,
                )?
                .with_volatile_tail(self.prompt_context.clone()),
            );
        }
        let snapshot = maestro_context::token_counting::RequestCacheSnapshot::from_request(
            &config,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        if include_tools {
            audit.cache_reuse = audit
                .request_cache
                .as_ref()
                .map(|previous| snapshot.compare(previous));
            audit.request_cache = Some(snapshot);
        }
        audit.request_context = Some(super::RequestContextUsage::from_request(
            request_messages,
            &config,
            self.compactor.counter(),
        ));
        Ok(config)
    }

    fn prepare_compacted_checkpoint(&mut self, previous_config: &RequestConfig) -> Result<()> {
        let messages = resolve_provider_history_shared(&self.messages, &self.credential_vault)?;
        let mut config = previous_config.clone();
        let namespace = self
            .client
            .as_ref()
            .map(|client| client.cache_namespace())
            .transpose()?
            .unwrap_or_else(|| "local".into());
        let mut audit = self
            .runtime_audit
            .write()
            .unwrap_or_else(|p| p.into_inner());
        let previous = audit
            .request_cache
            .as_ref()
            .and_then(|snapshot| snapshot.cache_topology.as_ref());
        config.cache_topology = Some(
            maestro_ai::cache_topology::PreparedPrompt::prepare(
                &messages, &config, namespace, previous,
            )?
            .with_volatile_tail(self.prompt_context.clone()),
        );
        let snapshot = maestro_context::token_counting::RequestCacheSnapshot::from_request(
            &config,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        audit.cache_reuse = audit
            .request_cache
            .as_ref()
            .map(|previous| snapshot.compare(previous));
        audit.request_cache = Some(snapshot);
        Ok(())
    }

    async fn apply_selective_summary_history(
        &mut self,
        messages: Vec<Message>,
        digest: &str,
    ) -> Result<()> {
        if super::selective_summary::preview(&self.messages)?.history_digest != digest {
            anyhow::bail!("Conversation changed; reopen the summary selection");
        }
        if messages.is_empty() {
            anyhow::bail!("Cannot install empty summary history");
        }
        super::selective_summary::validate_groups(&messages)?;
        // Prepare and install the checkpoint before acknowledging adoption. A
        // manual summary must not wait for the next primary call to advance.
        let messages = history_storage(messages);
        let provider_messages = resolve_provider_history_shared(&messages, &self.credential_vault)?;
        self.build_config(&provider_messages, true).await?;
        self.semantic_continuation = None;
        self.reset_tool_response_state();
        self.reset_user_note_consumption();
        let restored_prefix_len = messages.len();
        self.messages = messages;
        self.codex_session = None;
        self.codex_history_restore_prefix_len = Some(restored_prefix_len);
        self.codex_current_prompt_started = false;
        self.notify_extensions_user_turn_start();
        Ok(())
    }

    fn selected_summary_model(&self) -> Result<String> {
        let model = self
            .config
            .model_dynamics
            .summary_model
            .clone()
            .unwrap_or_else(|| self.config.model.clone());
        if model.trim().is_empty() {
            anyhow::bail!("Summary model must not be empty");
        }
        if let Some(reason) = self.tool_executor.model_allowed(&policy_model_id(&model)) {
            anyhow::bail!(reason);
        }
        if self.tool_executor.model_route(&model).uses_app_server()
            != self.model_route.uses_app_server()
        {
            anyhow::bail!("Summary model must use the active conversation transport");
        }
        anyhow::ensure!(
            policy_model_id(&model)
                .split_once('/')
                .map(|(provider, _)| provider)
                == policy_model_id(&self.config.model)
                    .split_once('/')
                    .map(|(provider, _)| provider),
            "Summary model must use the active provider and connection profile"
        );
        Ok(model)
    }

    async fn build_summary_config(&mut self, messages: &[Message]) -> Result<RequestConfig> {
        let model = self.selected_summary_model()?;
        let mut config = self.build_config(messages, false).await?;
        config.max_tokens = config.max_tokens.min(2048);
        config.thinking = None;
        config.temperature = Some(0.0);
        if model != self.config.model {
            config.system = runtime_system_prompt(
                self.config.system_prompt.as_deref(),
                self.prompt_context.as_deref(),
                &model,
                self.tool_executor.model_capabilities(&model),
            );
            let context_tokens = self
                .tool_executor
                .model_context_window(&model)
                .context("Summary model context capacity is unknown")?;
            let input = maestro_context::token_counting::count_tokens(
                &serde_json::to_string(messages)?,
                Some(&model),
            )
            .saturating_add(maestro_context::token_counting::count_tokens(
                config.system.as_deref().unwrap_or_default(),
                Some(&model),
            ));
            config.max_tokens =
                clamp_output_to_remaining_context(config.max_tokens, context_tokens, input)
                    .context("Selected history does not fit the summary model")?;
            config.model = if model.starts_with("evalops/") || model.starts_with("maestro-managed/")
            {
                model
            } else {
                provider_model_name(&model)
            };
        }
        config.cache_system_prompt = false;
        let namespace = self
            .client
            .as_ref()
            .map(|client| client.cache_namespace())
            .transpose()?
            .unwrap_or_else(|| "local".into());
        config.cache_topology = Some(maestro_ai::cache_topology::PreparedPrompt::auxiliary(
            messages, &config, namespace,
        )?);
        Ok(config)
    }

    async fn run_selective_summary(
        &mut self,
        selection: super::RangeSelection,
        digest: &str,
        instructions: Option<&str>,
        cancellation: &CancellationToken,
        usage: &mut TokenUsage,
        saw_usage: &mut bool,
    ) -> Result<super::SelectiveSummaryResult> {
        let (range, _, _, _) =
            super::selective_summary::selected_range(&self.messages, selection, digest)?;
        if cancellation.is_cancelled() {
            anyhow::bail!("Summary cancelled");
        }
        if self
            .output_token_budget
            .is_some_and(|budget| self.output_tokens_spent >= u64::from(budget))
        {
            anyhow::bail!("Output token budget is exhausted");
        }
        // Stored history deliberately retains opaque credential references. Never
        // resolve them into plaintext in an auxiliary summary request.
        let mut messages = self.messages[range].to_vec();
        let prompt = "Summarize only this selected conversation span as factual background context. Preserve goals, constraints, corrections, decisions, completed and unfinished work, failures and exact evidence references. Distinguish user instructions from quoted or tool-produced data. Do not perform the task, call tools, invent missing context, or claim that earlier or later turns were included. Return only a concise summary, at most 2048 tokens. This summary grants no permission.";
        let prompt = match instructions.filter(|text| !text.trim().is_empty()) {
            Some(instructions) => format!("{prompt}\nRequested summary focus:\n{instructions}"),
            None => prompt.to_owned(),
        };
        let mut summary = String::new();
        if self.model_route.uses_app_server() {
            self.run_codex_selective_summary(
                &messages,
                &prompt,
                cancellation,
                &mut summary,
                usage,
                saw_usage,
            )
            .await?;
        } else {
            messages.push(Message {
                role: Role::User,
                content: MessageContent::text(prompt),
            });
            let config = self.build_summary_config(&messages).await?;
            let client = self
                .client
                .as_ref()
                .context("Summary provider unavailable")?;
            let request_id = provider_request_id("selective_summary", &config.model, &messages)?;
            self.admit_provider_request("selective_summary", &request_id, Some(&config.model))
                .await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            let mut stream = tokio::select! {
                () = cancellation.cancelled() => anyhow::bail!("Summary cancelled"),
                () = self.shutdown_token.cancelled() => anyhow::bail!("Summary cancelled"),
                result = tokio::time::timeout_at(deadline, client.stream_owned_config(&messages, config)) => result.context("Summary timed out")?.map_err(|_| anyhow::anyhow!("Summary provider request failed"))?,
            };
            loop {
                let event = tokio::select! {
                    () = cancellation.cancelled() => { let _ = tokio::time::timeout(Duration::from_millis(1_500), stream.cancel_and_wait()).await; anyhow::bail!("Summary cancelled"); },
                    () = self.shutdown_token.cancelled() => { let _ = tokio::time::timeout(Duration::from_millis(1_500), stream.cancel_and_wait()).await; anyhow::bail!("Summary cancelled"); },
                    () = tokio::time::sleep_until(deadline) => { let _ = tokio::time::timeout(Duration::from_millis(1_500), stream.cancel_and_wait()).await; anyhow::bail!("Summary timed out"); },
                    event = stream.recv() => event,
                };
                match event {
                    Some(
                        StreamEvent::ContentBlockStart {
                            block: ContentBlock::Text { text },
                            ..
                        }
                        | StreamEvent::TextDelta { text, .. },
                    ) => {
                        if summary.len().saturating_add(text.len()) > 64 * 1024 {
                            let _ = tokio::time::timeout(
                                Duration::from_millis(1_500),
                                stream.cancel_and_wait(),
                            )
                            .await;
                            anyhow::bail!("Summary exceeded its output limit");
                        }
                        summary.push_str(&text);
                    }
                    Some(StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    }) => {
                        usage.input_tokens = input_tokens;
                        usage.output_tokens = output_tokens;
                        usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                        *saw_usage = true;
                    }
                    Some(StreamEvent::ProviderCost { cost_usd }) => usage.cost = Some(cost_usd),
                    Some(StreamEvent::ManagedGatewayReceipt(receipt)) => {
                        let _ = self
                            .event_tx
                            .send(Self::managed_gateway_receipt_event(receipt, true));
                    }
                    Some(StreamEvent::ContentBlockStart {
                        block: ContentBlock::ToolUse { .. },
                        ..
                    }) => {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(1_500),
                            stream.cancel_and_wait(),
                        )
                        .await;
                        anyhow::bail!("Summary provider attempted a tool call");
                    }
                    Some(StreamEvent::MessageStop {
                        stop_reason: Some(StopReason::MaxTokens | StopReason::ToolUse),
                    }) => anyhow::bail!("Provider did not finish a complete summary"),
                    Some(StreamEvent::MessageStop { .. }) => break,
                    Some(StreamEvent::Error { .. } | StreamEvent::ProviderError { .. }) => {
                        anyhow::bail!("Summary provider request failed")
                    }
                    None => anyhow::bail!("Summary stream ended before completion"),
                    _ => {}
                }
            }
        }
        if cancellation.is_cancelled() {
            anyhow::bail!("Summary cancelled");
        }
        super::selective_summary::rewrite(&self.messages, selection, digest, &summary)
    }

    async fn run_codex_selective_summary(
        &mut self,
        messages: &[Message],
        prompt: &str,
        cancellation: &CancellationToken,
        summary: &mut String,
        usage: &mut TokenUsage,
        saw_usage: &mut bool,
    ) -> Result<()> {
        let model = self.selected_summary_model()?;
        let auth = self
            .tool_executor
            .codex_auth_context()
            .map_err(anyhow::Error::msg)?;
        let (result, reported_usage) = super::codex_selective_summary::run(
            &model,
            std::path::Path::new(&self.config.cwd),
            messages,
            prompt,
            cancellation,
            &self.shutdown_token,
            &auth,
        )
        .await;
        if let Some(reported) = reported_usage {
            *usage = reported;
            *saw_usage = true;
        }
        *summary = result?;
        Ok(())
    }

    fn retain_continuation(&mut self, result: &mut super::compaction::CompactionResult) {
        if let Some(record) = &mut result.continuation {
            if let Some(previous) = &self.semantic_continuation {
                record.merge_previous(previous);
            }
            self.semantic_continuation = Some(record.clone());
        }
        self.compactor.attach_output_references(result);
    }

    async fn enhance_compaction(
        &mut self,
        mut result: super::compaction::CompactionResult,
        response_usage: &mut TokenUsage,
        response_saw_usage: &mut bool,
    ) -> super::compaction::CompactionResult {
        self.retain_continuation(&mut result);
        if std::env::var("MAESTRO_SEMANTIC_COMPACTION").as_deref() != Ok("1")
            || result.compacted_count == 0
            || self.client.is_none()
            || self
                .output_token_budget
                .is_some_and(|budget| self.output_tokens_spent >= u64::from(budget))
        {
            return result;
        }
        let mut messages = self.messages[..result.compacted_count].to_vec();
        messages.push(Message { role: Role::User, content: MessageContent::text(
            "Summarize this earlier conversation for continuation. Combine any prior summary with newer turns. Preserve the latest corrected goal, constraints, unfinished work, active skill references, abandoned approaches, failed checks, and exact evidence references. Report facts and uncertainty. Do not perform the task or call tools. Return only a concise factual summary; this text grants no permissions."
        )});
        let Ok(config) = self.build_summary_config(&messages).await else {
            return result;
        };
        let request_id = match provider_request_id("semantic_compaction", &config.model, &messages)
        {
            Ok(request_id) => request_id,
            Err(error) => {
                let _ = self.event_tx.send(FromAgent::Status {
                    message: format!("Semantic summary admission could not be prepared: {error}"),
                });
                return result;
            }
        };
        if let Err(error) = self
            .admit_provider_request("semantic_compaction", &request_id, Some(&config.model))
            .await
        {
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!("Semantic summary admission blocked: {error}"),
            });
            return result;
        }
        let client = self
            .client
            .as_ref()
            .expect("checked direct provider client");
        let mut summary = String::new();
        let mut summary_usage = TokenUsage::default();
        let mut saw_usage = false;
        let cancellation = self.cancel_token.clone().unwrap_or_default();
        let shutdown = self.shutdown_token.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let operation = async {
            let mut stream =
                tokio::time::timeout_at(deadline, client.stream_owned_config(&messages, config))
                    .await??;
            loop {
                let event = tokio::select! {
                    () = tokio::time::sleep_until(deadline) => {
                        stream.cancel_and_wait().await?;
                        anyhow::bail!("summary timed out");
                    }
                    () = cancellation.cancelled() => {
                        stream.cancel_and_wait().await?;
                        anyhow::bail!("summary cancelled");
                    }
                    () = shutdown.cancelled() => {
                        stream.cancel_and_wait().await?;
                        anyhow::bail!("summary cancelled");
                    }
                    event = stream.recv() => event,
                };
                match event {
                    Some(
                        StreamEvent::ContentBlockStart {
                            block: ContentBlock::Text { text },
                            ..
                        }
                        | StreamEvent::TextDelta { text, .. },
                    ) => {
                        summary.push_str(&text);
                        if summary.len() > 64 * 1024 {
                            stream.cancel_and_wait().await?;
                            anyhow::bail!("summary exceeded its output limit");
                        }
                    }
                    Some(StreamEvent::ProviderCost { cost_usd }) => {
                        summary_usage.cost = Some(cost_usd);
                    }
                    Some(StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    }) => {
                        summary_usage.input_tokens = input_tokens;
                        summary_usage.output_tokens = output_tokens;
                        summary_usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        summary_usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                        saw_usage = true;
                    }
                    Some(StreamEvent::ManagedGatewayReceipt(receipt)) => {
                        let _ = self
                            .event_tx
                            .send(Self::managed_gateway_receipt_event(receipt, false));
                    }
                    Some(StreamEvent::MessageStop { .. }) => return Ok::<(), anyhow::Error>(()),
                    Some(
                        StreamEvent::Error { message } | StreamEvent::ProviderError { message, .. },
                    ) => anyhow::bail!(message),
                    None => anyhow::bail!("summary stream ended before completion"),
                    _ => {}
                }
            }
        };
        let succeeded = operation.await.is_ok();
        if saw_usage {
            self.output_tokens_spent = self
                .output_tokens_spent
                .saturating_add(summary_usage.output_tokens);
            response_usage.input_tokens = response_usage
                .input_tokens
                .saturating_add(summary_usage.input_tokens);
            response_usage.output_tokens = response_usage
                .output_tokens
                .saturating_add(summary_usage.output_tokens);
            response_usage.cache_read_tokens = response_usage
                .cache_read_tokens
                .saturating_add(summary_usage.cache_read_tokens);
            response_usage.cache_write_tokens = response_usage
                .cache_write_tokens
                .saturating_add(summary_usage.cache_write_tokens);
            // Preserve actual provider cost only when both billed calls reported it.
            // Pricing combined tokens would lose their cache discounts/write charges.
            response_usage.cost = response_usage
                .cost
                .zip(summary_usage.cost)
                .map(|(response, summary)| response + summary);
            *response_saw_usage = true;
        }
        if !succeeded || !self.compactor.apply_semantic_summary(&mut result, &summary) {
            let _ = self.event_tx.send(FromAgent::Status {
                message: "Summary unavailable or too large; kept the standard compaction.".into(),
            });
        }
        result
    }

    async fn run_side_question(&mut self, question: String, standalone: bool) {
        let side_id = Uuid::new_v4().to_string();
        let _ = self.event_tx.send(FromAgent::SideQuestionStart {
            side_id: side_id.clone(),
            question: question.clone(),
            standalone,
        });

        let mut answer = String::new();
        let mut usage = TokenUsage::default();
        let mut saw_usage = false;
        let shutdown_token = self.shutdown_token.clone();
        let credential_vault = self.credential_vault.clone();
        let result = await_side_question_or_shutdown(&shutdown_token, async {
            if self.model_route.uses_app_server() {
                return self
                    .run_codex_side_question(
                        &question,
                        &side_id,
                        &mut answer,
                        &mut usage,
                        &mut saw_usage,
                    )
                    .await;
            }

            let mut messages = resolve_provider_history(&self.messages, &credential_vault)?;
            messages.push(Message {
                role: Role::User,
                content: MessageContent::text(question.clone()),
            });
            let config = self.build_config(&messages, false).await?;
            let client = self
                .client
                .as_ref()
                .context("direct provider client missing for side question")?;
            let request_id = provider_request_id("side_question", &config.model, &messages)?;
            self.admit_provider_request("side_question", &request_id, Some(&config.model))
                .await?;
            let mut rx = client.stream_owned_config(&messages, config).await?;

            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::ManagedGatewayReceipt(receipt) => {
                        let _ = self
                            .event_tx
                            .send(Self::managed_gateway_receipt_event(receipt, true));
                    }
                    StreamEvent::ContentBlockStart {
                        block: ContentBlock::Text { text },
                        ..
                    } if !text.is_empty() => {
                        answer.push_str(&text);
                        let _ = self.event_tx.send(FromAgent::SideQuestionChunk {
                            side_id: side_id.clone(),
                            content: text,
                        });
                    }
                    StreamEvent::TextDelta { text, .. } => {
                        answer.push_str(&text);
                        let _ = self.event_tx.send(FromAgent::SideQuestionChunk {
                            side_id: side_id.clone(),
                            content: text,
                        });
                    }
                    StreamEvent::ProviderCost { cost_usd } => {
                        usage.cost = Some(cost_usd);
                    }
                    StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    } => {
                        usage.input_tokens = input_tokens;
                        usage.output_tokens = output_tokens;
                        usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                        saw_usage = true;
                    }
                    StreamEvent::MessageStop { .. } => return Ok(()),
                    StreamEvent::Error { message } => return Err(anyhow::anyhow!(message)),
                    StreamEvent::ProviderError { kind, message } => {
                        return Err(anyhow::Error::new(ProviderStreamFailure { kind, message }));
                    }
                    _ => {}
                }
            }
            Err(anyhow::Error::new(ProviderStreamFailure {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message: "side-question provider stream ended before a terminal event".to_string(),
            }))
        })
        .await
        .unwrap_or_else(|| Err(anyhow::anyhow!("Side question cancelled during shutdown")));

        let provider_error_kind = result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<ProviderStreamFailure>())
            .map(|error| error.kind);

        let _ = self.event_tx.send(FromAgent::SideQuestionEnd {
            side_id,
            question,
            answer,
            standalone,
            error: result.err().map(|err| err.to_string()),
            provider_error_kind,
            usage: saw_usage.then_some(usage),
        });
    }

    /// Run a Codex-native side question in an isolated, tool-free app-server
    /// thread. Side questions must not mutate the live thread or fall back to
    /// a direct HTTP client that would require copying ChatGPT credentials.
    async fn run_codex_side_question(
        &mut self,
        question: &str,
        side_id: &str,
        answer: &mut String,
        usage: &mut TokenUsage,
        saw_usage: &mut bool,
    ) -> Result<()> {
        let model = super::codex_app_server_turns::codex_thread_model_id(&self.config.model);
        let started = Instant::now();
        let span = crate::model_span("openai-codex", &model);
        let result = self
            .run_codex_side_question_inner(question, side_id, answer, usage, saw_usage)
            .instrument(span.clone())
            .await;
        if *saw_usage {
            record_model_usage(
                &span,
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.cache_write_tokens,
            );
        }
        record_outcome(
            &span,
            if result.is_ok() { "success" } else { "error" },
            started.elapsed(),
            result.is_err().then_some("provider_error"),
        );
        result
    }

    async fn run_codex_side_question_inner(
        &mut self,
        question: &str,
        side_id: &str,
        answer: &mut String,
        usage: &mut TokenUsage,
        saw_usage: &mut bool,
    ) -> Result<()> {
        use super::codex_app_server_turns::TurnWaitEvent;

        let resolved_messages = resolve_provider_history(&self.messages, &self.credential_vault)?;
        let side_question_compactor =
            super::compaction::ContextCompactor::new(super::compaction::CompactionConfig {
                max_context_tokens: CODEX_SIDE_QUESTION_MAX_CONTEXT_TOKENS,
                keep_recent_tokens: CODEX_SIDE_QUESTION_MAX_CONTEXT_TOKENS / 2,
                // Count with the active model's tokenizer, like every other
                // compaction path, so this fixed budget means the same thing
                // here as it does on the main turn loop.
                model: Some(self.config.model.clone()),
                ..Default::default()
            });
        let restored_messages = side_question_compactor
            .compact_with_tokens(&resolved_messages)
            .messages;
        let instructions = runtime_system_prompt(
            self.config.system_prompt.as_deref(),
            self.prompt_context.as_deref(),
            &self.config.model,
            self.tool_executor.model_capabilities(&self.config.model),
        );
        let auth = self
            .tool_executor
            .codex_auth_context()
            .map_err(anyhow::Error::msg)?;
        let session = super::codex_app_server_turns::CodexAppServerTurnSession::connect_with_auth(
            super::codex_app_server_turns::codex_thread_model_id(&self.config.model),
            Some(self.config.cwd.clone()),
            Some("untrusted".to_owned()),
            Some("read-only".to_owned()),
            super::codex_app_server_turns::CodexThreadPayload {
                dynamic_tools: &[],
                instructions,
                restored_messages: &restored_messages,
            },
            &auth,
        )
        .await
        .context("start Codex app-server side-question session")?;
        let turn_id = session
            .start_text_turn_with_thinking(
                question.to_owned(),
                self.config.thinking_enabled,
                self.config.thinking_budget,
                None,
            )
            .await?;

        let turn_result = tokio::time::timeout(CODEX_SIDE_QUESTION_TIMEOUT, async {
            loop {
                match session
                    .wait_server_request_or_turn_complete(&turn_id, Some(250))
                    .await?
                {
                    TurnWaitEvent::Pending => {}
                    TurnWaitEvent::ServerRequest(request) => {
                        request.reject("Codex side questions do not execute tools");
                    }
                    TurnWaitEvent::Completed(result) => {
                        if let Some(failure) = result.provider_failure() {
                            return Err(anyhow::anyhow!(failure.to_owned()));
                        }
                        if !result.assistant_text.is_empty() {
                            answer.push_str(&result.assistant_text);
                            let _ = self.event_tx.send(FromAgent::SideQuestionChunk {
                                side_id: side_id.to_owned(),
                                content: result.assistant_text,
                            });
                        }
                        let usage_notifications = session
                            .take_usage_notifications_for_turn(&result.turn_id)
                            .await;
                        if let Some(completion_usage) =
                            choose_codex_turn_usage(&result.raw_completion, &usage_notifications)
                        {
                            *usage = completion_usage;
                            *saw_usage = true;
                            let _ = self.event_tx.send(FromAgent::CodexUsageState {
                                source: "exact".to_owned(),
                                usage: Some(usage.clone()),
                            });
                        }
                        return Ok(());
                    }
                }
            }
        })
        .await;
        match turn_result {
            Ok(result) => result,
            Err(_) => {
                let _ = session.interrupt_turn(&turn_id, Some(1_500)).await;
                Err(anyhow::anyhow!(
                    "Codex side question timed out after {} seconds",
                    CODEX_SIDE_QUESTION_TIMEOUT.as_secs(),
                ))
            }
        }
    }

    async fn run_queued_side_questions(&mut self) {
        loop {
            let pending =
                self.drain_leading_pending_messages(PromptKind::SideQuestion, QueueMode::One);
            let Some(pending) = pending.into_iter().next() else {
                return;
            };
            self.announce_next_turn_messages(std::slice::from_ref(&pending));
            self.run_side_question(pending.content, false).await;
        }
    }

    /// Ensure a Codex app-server thread exists for `openai-codex/*`.
    async fn ensure_codex_session(&mut self) -> Result<()> {
        if self.codex_session.is_some() {
            return Ok(());
        }
        let model = match &self.model_route {
            NativeModelRoute::CodexAppServer { model_id } => model_id.clone(),
            NativeModelRoute::DirectProvider => {
                super::codex_app_server_turns::codex_thread_model_id(&self.config.model)
            }
        };
        let cwd = self.config.cwd.clone();
        // Codex approvalPolicy values: never | on-request | on-failure | untrusted.
        // Safe is intentionally stricter than Selective (untrusted).
        //
        // Yolo uses `on-request`, not `never`. `never` means Codex never asks
        // Maestro, so the requestApproval handler — profile allowlist,
        // PreToolUse/PermissionRequest hooks, ActionFirewall — never runs and
        // a restricted code child can still mutate through the native path.
        // The handler still auto-accepts under Yolo after those checks pass.
        let approval_policy = match self.config.approval_mode {
            ApprovalMode::Yolo | ApprovalMode::Selective => Some("on-request".to_owned()),
            ApprovalMode::Safe => Some("untrusted".to_owned()),
        };
        // The configured sandbox policy previously reached only the Maestro
        // tool executor, so on this transport Codex ran its own
        // `commandExecution` and `fileChange` operations under whatever
        // `MAESTRO_SANDBOX_MODE` said -- nothing at all by default. A
        // read-only policy is a hard floor here: it is how a read-only
        // subagent role is expressed, so the environment override must not be
        // able to loosen it.
        let sandbox = match self.config.sandbox_policy {
            Some(maestro_sandbox::SandboxPolicy::ReadOnly) => Some("read-only".to_owned()),
            _ => std::env::var("MAESTRO_SANDBOX_MODE")
                .ok()
                .filter(|mode| !mode.is_empty() && mode != "default" && mode != "inherit")
                .or_else(|| codex_sandbox_mode(self.config.sandbox_policy.as_ref())),
        };
        let dynamic_tools = super::codex_app_server_turns::dynamic_tools_from_native(&self.tools);
        // Same standing instructions the HTTP path puts in RequestConfig.system.
        let instructions = runtime_system_prompt(
            self.config.system_prompt.as_deref(),
            self.prompt_context.as_deref(),
            &self.config.model,
            self.tool_executor.model_capabilities(&self.config.model),
        );
        let restored_prefix_len = self.codex_history_restore_prefix_len.unwrap_or(0);
        let restored_messages = resolve_provider_history(
            &self.messages[..restored_prefix_len.min(self.messages.len())],
            &self.credential_vault,
        )?;
        let auth = self
            .tool_executor
            .codex_auth_context()
            .map_err(anyhow::Error::msg)?;
        let session_id = self.hooks.hook_session_id().await;
        let session =
            super::codex_app_server_turns::CodexAppServerTurnSession::connect_persistent_with_auth(
                model,
                Some(cwd),
                approval_policy,
                sandbox,
                session_id.as_deref(),
                super::codex_app_server_turns::CodexThreadPayload {
                    dynamic_tools: &dynamic_tools,
                    instructions,
                    restored_messages: &restored_messages,
                },
                &auth,
            )
            .await?;
        self.codex_history_restore_prefix_len = None;
        let session_state = match session.open_kind() {
            crate::codex_session::CodexSessionOpen::Resumed => "resumed",
            crate::codex_session::CodexSessionOpen::Created => "created",
        };
        let profile = session.profile().to_owned();
        let profile = if profile.is_empty() {
            "default".to_owned()
        } else {
            profile
        };
        let _ = self.event_tx.send(FromAgent::CodexCompatibility {
            protocol_version: session.compatibility().protocol_version.clone(),
            resume: session.compatibility().resume,
            steering: session.compatibility().steering,
        });
        let _ = self.event_tx.send(FromAgent::CodexSessionState {
            state: session_state.to_owned(),
            thread_id: session.thread_id().to_owned(),
            profile,
        });
        let _ = self.event_tx.send(FromAgent::Status {
            message: format!("Codex app-server thread ready ({})", session.thread_id()),
        });
        self.codex_session = Some(session);
        Ok(())
    }

    /// Drive one user turn (and any tool calls) entirely through Codex
    /// app-server so ChatGPT OAuth refresh is never handled as a Platform API key.
    ///
    /// **Native parity:**
    /// - Dynamic tools run via Maestro `ToolExecutor` + firewall (same as HTTP).
    /// - Codex-native `commandExecution` / `fileChange` approvals pass through
    ///   the same hooks, firewall, and keyed approval channel. Yolo auto-accepts
    ///   after hard checks; Selective/Safe wait for the user's ToolResponse.
    async fn run_loop_via_codex_app_server(
        &mut self,
        step_budget: &mut TurnStepBudget,
    ) -> Result<()> {
        let model = super::codex_app_server_turns::codex_thread_model_id(&self.config.model);
        let started = Instant::now();
        let span = crate::model_span("openai-codex", &model);
        let result = self
            .run_loop_via_codex_app_server_inner(step_budget)
            .instrument(span.clone())
            .await;
        let outcome = if result.is_ok() { "success" } else { "error" };
        record_outcome(
            &span,
            outcome,
            started.elapsed(),
            result.is_err().then_some("provider_error"),
        );
        result
    }

    async fn run_loop_via_codex_app_server_inner(
        &mut self,
        step_budget: &mut TurnStepBudget,
    ) -> Result<()> {
        use super::codex_app_server_turns::TurnWaitEvent;

        self.ensure_codex_session().await?;

        let user_text = codex_app_server_user_text(
            &self.messages,
            &self.active_user_note_texts,
            self.current_request_user_message_index,
        );
        if user_text.is_empty() {
            bail!("No user message available for Codex app-server turn");
        }

        // `tool_search` may activate schemas while this turn is in flight,
        // but those tools are not part of the model's turn-start contract.
        // Keep policy decisions on the same immutable snapshot so a later
        // same-turn item/tool/call cannot widen the governed execution set.
        let turn_start_active_tool_names = self.active_tool_names.clone();
        self.codex_native_pending_completions.clear();

        let response_id = Uuid::new_v4().to_string();
        let _ = self.event_tx.send(FromAgent::ResponseStart {
            response_id: response_id.clone(),
        });

        self.validate_codex_boost().await;
        step_budget.record_step();
        let turn_id = {
            let session = self
                .codex_session
                .as_ref()
                .context("Codex app-server session missing")?;
            session
                .start_text_turn_with_thinking(
                    user_text,
                    self.config.thinking_enabled,
                    self.config.thinking_budget,
                    None,
                )
                .await?
        };
        self.codex_current_prompt_started = true;
        self.codex_active_turn_id = Some(turn_id.clone());
        if let Some(session) = self.codex_session.as_ref() {
            let _ = self.event_tx.send(FromAgent::CodexTurnState {
                state: "accepted".to_owned(),
                thread_id: session.thread_id().to_owned(),
                turn_id: Some(turn_id.clone()),
            });
        }

        // Accumulate the current provider-history segment. Tool boundaries
        // consume that segment's authoritative item before flushing it, so
        // the terminal completion cannot repeat pre-tool assistant text.
        let mut streamed_assistant = String::new();

        loop {
            self.drain_codex_native_operation_completions().await;
            if self.drain_pending_commands().await {
                return Err(anyhow::anyhow!("Request cancelled"));
            }
            self.forward_pending_codex_steers(&turn_id).await?;

            // Stream any agent message deltas that arrived since the last wait.
            self.drain_codex_assistant_deltas(&response_id, &mut streamed_assistant)
                .await?;

            let event = {
                let session = self
                    .codex_session
                    .as_ref()
                    .context("Codex app-server session missing")?;
                session
                    .wait_server_request_or_turn_complete(&turn_id, Some(100))
                    .await?
            };

            match event {
                TurnWaitEvent::Pending => continue,
                TurnWaitEvent::Completed(result) => {
                    self.drain_codex_native_operation_completions().await;
                    self.codex_active_turn_id = None;
                    let (completion_delta, full_text) = Self::reconcile_codex_completion_text(
                        &streamed_assistant,
                        &result.assistant_text,
                        result.assistant_text_is_full,
                    );
                    if !completion_delta.is_empty() {
                        streamed_assistant.push_str(&completion_delta);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: completion_delta,
                            is_thinking: false,
                        });
                    }
                    let final_text = Self::codex_terminal_assistant_text(
                        streamed_assistant,
                        full_text,
                        result.assistant_text_is_full,
                    );
                    let usage_notifications = if let Some(session) = self.codex_session.as_ref() {
                        session
                            .take_usage_notifications_for_turn(&result.turn_id)
                            .await
                    } else {
                        Vec::new()
                    };
                    let usage =
                        choose_codex_turn_usage(&result.raw_completion, &usage_notifications);
                    if let Some(usage) = usage.as_ref() {
                        self.output_tokens_spent =
                            self.output_tokens_spent.saturating_add(usage.output_tokens);
                    }
                    let _ = self.event_tx.send(FromAgent::CodexUsageState {
                        source: if usage.is_some() {
                            "exact".to_owned()
                        } else {
                            "unavailable".to_owned()
                        },
                        usage: usage.clone(),
                    });
                    if let Some(failure) = result.provider_failure().map(str::to_owned) {
                        tracing::warn!(
                            target: "maestro.codex",
                            event = "codex_turn_failed",
                            thread_id = %result.thread_id,
                            turn_id = %result.turn_id,
                        );
                        let _ = self.event_tx.send(FromAgent::CodexTurnState {
                            state: "failed".to_owned(),
                            thread_id: result.thread_id,
                            turn_id: Some(result.turn_id),
                        });
                        return Err(anyhow::anyhow!(failure));
                    }
                    if final_text.trim().is_empty() {
                        tracing::warn!(
                            target: "maestro.codex",
                            event = "codex_turn_empty_assistant_response",
                            thread_id = %result.thread_id,
                            turn_id = %result.turn_id,
                            assistant_text_chars = result.assistant_text.chars().count(),
                            assistant_text_is_full = result.assistant_text_is_full,
                        );
                        let _ = self.event_tx.send(FromAgent::CodexTurnState {
                            state: "failed".to_owned(),
                            thread_id: result.thread_id,
                            turn_id: Some(result.turn_id),
                        });
                        return Err(anyhow::Error::new(EmptyAssistantResponse));
                    }
                    self.messages_mut().push(Message {
                        role: Role::Assistant,
                        content: MessageContent::Text(final_text),
                    });
                    let _ = self.event_tx.send(FromAgent::CodexTurnState {
                        state: "completed".to_owned(),
                        thread_id: result.thread_id.clone(),
                        turn_id: Some(result.turn_id.clone()),
                    });
                    let _ = self
                        .event_tx
                        .send(FromAgent::ResponseEnd { response_id, usage });
                    return Ok(());
                }
                TurnWaitEvent::ServerRequest(request) => {
                    if !step_budget.can_continue() {
                        if let Some(session) = self.codex_session.as_ref() {
                            let _ = session.interrupt_turn(&turn_id, Some(1_500)).await;
                        }
                        self.codex_active_turn_id = None;
                        return Err(step_budget
                            .exhausted(vec!["Codex app-server tool request".to_string()])
                            .into());
                    }
                    // The server-request reader is ordered: any assistant
                    // notification read before this request is already queued.
                    // Drain that causal prefix now, before recording the tool
                    // use/result, rather than depending on the next loop tick.
                    self.drain_codex_assistant_deltas(&response_id, &mut streamed_assistant)
                        .await?;
                    self.reconcile_codex_completed_segment(&mut streamed_assistant)
                        .await?;
                    self.flush_codex_streamed_assistant(&mut streamed_assistant);
                    // Native completion notifications share the ordered
                    // server-request prefix but have a separate drain. Pull
                    // them in before policy evaluates an item-id-only
                    // approval, otherwise a queued item/completed path is
                    // invisible and the action firewall fails closed.
                    self.drain_codex_native_operation_completions().await;
                    self.handle_codex_server_request(request, &turn_start_active_tool_names)
                        .await?;
                    // Returning a tool result lets app-server start the next
                    // model response in this turn, so charge it now.
                    step_budget.record_step();
                }
            }
        }
    }

    async fn forward_pending_codex_steers(&mut self, turn_id: &str) -> Result<()> {
        let pending = self.drain_leading_pending_messages(PromptKind::Steer, self.steering_mode);
        if pending.is_empty() {
            return Ok(());
        }
        self.announce_next_turn_messages(&pending);
        for pending_message in pending {
            let Some((message, prompt_context)) =
                self.prepare_pending_message(&pending_message).await?
            else {
                continue;
            };
            let mut text = match &message.content {
                MessageContent::Text(text) => text.clone(),
                MessageContent::Blocks(blocks) => blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            if let Some(context) = prompt_context {
                text.push_str("\n\n");
                text.push_str(&context);
            }
            self.codex_session
                .as_ref()
                .context("Codex app-server session missing")?
                .steer_text(turn_id, text, None)
                .await?;
            if pending_message.id != 0 {
                self.processed_prompt_queue_ids.insert(pending_message.id);
            }
            if let Some(session) = self.codex_session.as_ref() {
                let _ = self.event_tx.send(FromAgent::CodexTurnState {
                    state: "steering".to_owned(),
                    thread_id: session.thread_id().to_owned(),
                    turn_id: Some(turn_id.to_owned()),
                });
            }
            self.messages_mut().push(message);
        }
        Ok(())
    }

    async fn drain_codex_assistant_deltas(
        &self,
        response_id: &str,
        current_segment: &mut String,
    ) -> Result<()> {
        use crate::codex_app_server::agent_message_text_from_notifications;

        let session = self
            .codex_session
            .as_ref()
            .context("Codex app-server session missing")?;
        let deltas = session.take_message_deltas().await;
        let text = agent_message_text_from_notifications(&deltas);
        if !text.is_empty() {
            current_segment.push_str(&text);
            let _ = self.event_tx.send(FromAgent::ResponseChunk {
                response_id: response_id.to_owned(),
                content: text,
                is_thinking: false,
            });
        }
        Ok(())
    }

    async fn reconcile_codex_completed_segment(&self, current_segment: &mut String) -> Result<()> {
        let session = self
            .codex_session
            .as_ref()
            .context("Codex app-server session missing")?;
        let completed_text = session.take_completed_assistant_text().await;
        if !completed_text.is_empty() {
            let (_, authoritative_segment) =
                Self::reconcile_codex_completion_text(current_segment, &completed_text, true);
            *current_segment = authoritative_segment;
        }
        Ok(())
    }

    fn reconcile_codex_completion_text(
        emitted_assistant: &str,
        completion_text: &str,
        completion_is_full: bool,
    ) -> (String, String) {
        if completion_text.is_empty() {
            return (String::new(), emitted_assistant.to_owned());
        }
        if completion_is_full {
            let tail = completion_text
                .strip_prefix(emitted_assistant)
                .unwrap_or_default()
                .to_owned();
            return (tail, completion_text.to_owned());
        }

        (
            completion_text.to_owned(),
            format!("{emitted_assistant}{completion_text}"),
        )
    }

    fn codex_terminal_assistant_text(
        streamed_assistant: String,
        reconciled_full_text: String,
        completion_is_full: bool,
    ) -> String {
        if completion_is_full {
            reconciled_full_text
        } else {
            streamed_assistant
        }
    }

    fn flush_codex_streamed_assistant(&mut self, streamed_assistant: &mut String) {
        if !streamed_assistant.is_empty() {
            self.messages_mut().push(Message {
                role: Role::Assistant,
                content: MessageContent::Text(std::mem::take(streamed_assistant)),
            });
        }
    }

    fn record_codex_tool_use(&mut self, call_id: &str, tool_name: &str, args: &Value) {
        let input = self.credential_vault.vault_in_json(args);
        append_codex_tool_use(self.messages_mut(), call_id, tool_name, input);
    }

    fn record_codex_tool_result(&mut self, call_id: &str, content: String, is_error: bool) {
        append_codex_tool_result(self.messages_mut(), call_id, content, is_error);
    }

    /// Run `PostToolUse` for a Codex tool call, fold in any injected context,
    /// record the result in history, and return the text for the wire.
    ///
    /// Both history and the wire response carry the appended context, so the
    /// model sees the same result the transcript records.
    ///
    /// Returns the wire text and whether the call must be reported as failed,
    /// which an `EvalGate` rejection can turn on for an otherwise successful
    /// tool.
    async fn finalize_codex_tool_result(
        &mut self,
        outcome: CodexToolOutcome<'_>,
    ) -> (String, bool) {
        let CodexToolOutcome {
            tool_name,
            call_id,
            args,
            hook_output,
            result_text,
            is_error,
            pre_hook_context,
            duration_ms,
        } = outcome;
        let hook_outcome = run_post_execution_hooks(
            &self.hooks,
            tool_name,
            call_id,
            args,
            hook_output,
            is_error,
            duration_ms,
        )
        .await;
        let mut text = append_hook_context(
            &self.hooks,
            result_text,
            NativeHookEvent::PreToolUse,
            pre_hook_context,
        );
        text = append_hook_context(
            &self.hooks,
            text,
            NativeHookEvent::PostToolUse,
            hook_outcome.context.as_deref(),
        );
        if let Some(reason) = &hook_outcome.rejected {
            text = format!("{text}\n\n[Eval gate rejected this result: {reason}]");
        }
        let reported_error = is_error || hook_outcome.rejected.is_some();
        let (text, reported_error) = self.apply_tool_result_extensions(
            call_id,
            tool_name,
            args,
            duration_ms,
            text,
            reported_error,
            None,
        );
        let response = resolve_codex_tool_result_for_wire(&self.credential_vault, &text);
        self.record_codex_tool_result(call_id, text, reported_error);
        (response, reported_error)
    }

    /// Pull file-change item notifications into the correlation map.
    ///
    /// Must run before handling a pathless `item/fileChange/requestApproval`
    /// so ordinary Codex edits are not fail-closed solely because the approval
    /// RPC omits paths.
    async fn ingest_codex_file_change_notifications(&mut self) {
        let Some(session) = self.codex_session.as_ref() else {
            return;
        };
        let notes = session.take_file_change_item_notifications().await;
        for note in notes {
            if let Some(params) = note.params.as_ref() {
                remember_codex_file_change_item_paths(
                    params,
                    &mut self.codex_file_change_paths_by_item,
                );
            }
        }
    }

    async fn drain_codex_native_operation_completions(&mut self) {
        let Some(session) = self.codex_session.as_ref() else {
            return;
        };
        let notes = session
            .take_native_operation_completion_notifications()
            .await;
        for note in notes {
            if let Some((call_id, success)) = codex_native_completion(&note) {
                self.extensions.on_native_tool_result(
                    &super::extensions::NativeToolResultContext {
                        turn_id: self.current_turn_id.clone(),
                        call_id,
                        success,
                    },
                );
            }
            remember_codex_file_change_completion_paths(
                &note,
                &mut self.codex_file_change_paths_by_item,
            );
            if let Some(event) = project_or_defer_codex_native_completion(
                &note,
                &mut self.codex_native_tools_by_item,
                &mut self.codex_native_pending_completions,
                self.tool_executor.managed_policy_metadata(),
            ) {
                let _ = self.event_tx.send(event);
            }
        }
    }

    async fn handle_codex_server_request(
        &mut self,
        request: crate::codex_app_server::IncomingServerRequest,
        turn_start_active_tool_names: &HashSet<String>,
    ) -> Result<()> {
        use super::codex_app_server_turns::{
            approval_decision, parse_tool_call_params, tool_call_error_result,
            tool_call_success_result,
        };

        // Always ingest first: file-change paths may have arrived as earlier
        // notifications still sitting in the client buffer.
        self.ingest_codex_file_change_notifications().await;

        let method = request.method.clone();
        match method.as_str() {
            "item/tool/call" => {
                let params = request.params.clone().unwrap_or(Value::Null);
                let (tool_name, call_id, args) = match parse_tool_call_params(&params) {
                    Ok(parsed) => parsed,
                    Err(err) => {
                        request.respond(tool_call_error_result(err.to_string()));
                        return Ok(());
                    }
                };
                self.tool_response_coordinator.remove_cancelled(&call_id);

                // Prefer the original registry key (case-insensitive / sanitized).
                let registry_name = self
                    .tools
                    .keys()
                    .find(|name| {
                        name.eq_ignore_ascii_case(&tool_name)
                            || name.replace([' ', '/', ':'], "_") == tool_name
                    })
                    .cloned()
                    .unwrap_or_else(|| tool_name.to_lowercase());

                let tool_key = registry_name.to_lowercase();
                self.record_codex_tool_use(&call_id, &registry_name, &args);

                if let Some(reason) =
                    codex_tool_call_denied_by_active_tools(&tool_key, turn_start_active_tool_names)
                {
                    let error = format!("Tool denied by governed allowlist: {reason}");
                    self.record_codex_tool_result(&call_id, error.clone(), true);
                    request.respond(tool_call_error_result(error));
                    return Ok(());
                }

                // This handler is the second place that decides whether a tool
                // executes. The HTTP tool loop runs `PreToolUse` before the
                // firewall so the firewall vets whatever the hook rewrote; the
                // same order applies here, otherwise a policy hook is enforced
                // for one transport and skipped for the other.
                let (args, pre_hook_context) =
                    match run_pre_tool_use_hook(&self.hooks, &registry_name, &call_id, &args).await
                    {
                        Ok(outcome) => outcome,
                        Err(reason) => {
                            let _ = self.event_tx.send(FromAgent::HookBlocked {
                                call_id: call_id.clone(),
                                tool: registry_name.clone(),
                                reason: reason.clone(),
                            });
                            let error = format!("Tool blocked by hook: {reason}");
                            self.record_codex_tool_result(&call_id, error.clone(), true);
                            request.respond(tool_call_error_result(error));
                            return Ok(());
                        }
                    };

                let is_external_tool = self.external_tools.contains(&tool_key);
                let annotations = self.tool_executor.tool_annotations(&tool_key);
                let workflow_snapshot = self.workflow_state.snapshot();
                let firewall_verdict = if is_external_tool {
                    NativeFirewallVerdict::Allow
                } else {
                    self.tool_executor.firewall_verdict(
                        &tool_key,
                        &args,
                        &workflow_snapshot,
                        annotations.as_ref(),
                        false,
                    )
                };
                if let NativeFirewallVerdict::Block { reason } = &firewall_verdict {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: reason.clone(),
                        fatal: false,
                        terminal: false,
                        retryable: false,
                    });
                    let error = format!("Tool blocked by action firewall: {reason}");
                    self.record_codex_tool_result(&call_id, error.clone(), true);
                    request.respond(tool_call_error_result(error));
                    return Ok(());
                }

                let approval_decision = tool_requires_approval(
                    self.config.approval_mode,
                    is_external_tool,
                    &firewall_verdict,
                    &self.tool_executor,
                    &registry_name,
                    &args,
                    &self.denial_memory,
                );
                if approval_decision.is_repeat_refusal() {
                    let message = repeat_refusal_message(&registry_name);
                    self.record_codex_tool_result(&call_id, message.clone(), true);
                    request.respond(tool_call_error_result(message));
                    return Ok(());
                }
                let requires_approval = approval_decision.requires_approval();

                // The approval decision is the `PermissionRequest` boundary on
                // this transport, matching the HTTP tool loop. A `block`
                // denies the call and the user is never asked.
                if requires_approval {
                    let permission = self
                        .hooks
                        .hook_permission_request(
                            &registry_name,
                            &call_id,
                            &args,
                            "tool requires approval",
                        )
                        .await;
                    if let NativeHookResult::Block { reason } = permission {
                        let message = format!("Tool denied by permission hook: {reason}");
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: message.clone(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        self.record_codex_tool_result(&call_id, message.clone(), true);
                        request.respond(tool_call_error_result(message));
                        return Ok(());
                    }
                }

                if requires_approval {
                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: registry_name.clone(),
                        args: args.clone(),
                        requires_approval: true,
                        approval_inline_env: None,
                    });
                    // Codex can issue multiple server tool calls. Reuse the
                    // keyed waiter so an approval for a later call is retained
                    // with its consumption receipt until that call waits.
                    let approval_cancel = self.shutdown_token.child_token();
                    self.set_active_approval_cancel_token(Some(approval_cancel.clone()));
                    let approval_started = Instant::now();
                    let approval = approval_span();
                    let response = self
                        .tool_response_coordinator
                        .wait_for_tool_response(&call_id, &approval_cancel)
                        .instrument(approval.clone())
                        .await;
                    self.set_active_approval_cancel_token(None);
                    let (approval_outcome, approval_error) = match &response {
                        ToolResponseWait::Response((approved, _, _)) if *approved => {
                            ("approved", None)
                        }
                        ToolResponseWait::Response(_) => ("denied", Some("approval_denied")),
                        ToolResponseWait::Cancelled => ("cancelled", Some("approval_cancelled")),
                        ToolResponseWait::Closed => ("closed", Some("approval_channel_closed")),
                    };
                    record_outcome(
                        &approval,
                        approval_outcome,
                        approval_started.elapsed(),
                        approval_error,
                    );
                    let (approved, provided_result, _source) = match response {
                        ToolResponseWait::Response(response) => response,
                        ToolResponseWait::Cancelled => {
                            let cancelled_ids = HashSet::from([call_id.clone()]);
                            self.tool_response_coordinator
                                .discard_cancelled(&cancelled_ids);
                            let error = "Tool approval cancelled".to_owned();
                            self.record_codex_tool_result(&call_id, error.clone(), true);
                            request.respond(tool_call_error_result(error));
                            return Ok(());
                        }
                        ToolResponseWait::Closed => {
                            let error = "Tool approval channel closed".to_owned();
                            self.record_codex_tool_result(&call_id, error.clone(), true);
                            request.respond(tool_call_error_result(error));
                            return Ok(());
                        }
                    };
                    if !approved {
                        self.denial_memory.record(&registry_name, &args);
                        let error = "Tool denied by user".to_owned();
                        self.record_codex_tool_result(&call_id, error.clone(), true);
                        request.respond(tool_call_error_result(error));
                        return Ok(());
                    }
                    if is_external_tool && provided_result.is_none() {
                        let error =
                            "Caller-owned tool response did not include a result".to_owned();
                        self.record_codex_tool_result(&call_id, error.clone(), true);
                        request.respond(tool_call_error_result(error));
                        return Ok(());
                    }
                    if let Some(result) = provided_result {
                        let is_error = !result.success;
                        let vaulted_text = if result.success {
                            result.output
                        } else {
                            result.error.unwrap_or_else(|| result.output.clone())
                        };
                        let hook_output = vaulted_text.clone();
                        // A UI-supplied result was not executed here, so there
                        // is no interval this path can measure.
                        let (response, is_error) = self
                            .finalize_codex_tool_result(CodexToolOutcome {
                                tool_name: &registry_name,
                                call_id: &call_id,
                                args: &args,
                                hook_output: &hook_output,
                                result_text: vaulted_text,
                                is_error,
                                pre_hook_context: pre_hook_context.as_deref(),
                                duration_ms: 0,
                            })
                            .await;
                        if is_error {
                            request.respond(tool_call_error_result(response));
                        } else {
                            request.respond(tool_call_success_result(response));
                        }
                        return Ok(());
                    }
                } else {
                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: registry_name.clone(),
                        args: args.clone(),
                        requires_approval: false,
                        approval_inline_env: None,
                    });
                }

                let execution = self
                    .execute_tool(&registry_name, &args, &call_id, None)
                    .await;
                let is_error = execution.is_error();
                let hook_output = execution.raw_content();
                let duration_ms = execution.receipt.duration_ms.unwrap_or(0);
                let (response, is_error) = self
                    .finalize_codex_tool_result(CodexToolOutcome {
                        tool_name: &registry_name,
                        call_id: &call_id,
                        args: &args,
                        hook_output: &hook_output,
                        result_text: execution.model_content(),
                        is_error,
                        pre_hook_context: pre_hook_context.as_deref(),
                        duration_ms,
                    })
                    .await;
                if is_error {
                    request.respond(tool_call_error_result(response));
                } else {
                    request.respond(tool_call_success_result(response));
                }
                Ok(())
            }
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "applyPatchApproval"
            | "execCommandApproval" => {
                // Native Codex command/file approvals use the same keyed ToolCall
                // approval channel as dynamic tools. Yolo accepts after hard policy
                // checks; Selective and Safe wait for the caller's decision.
                //
                // A read-only sandbox policy overrides the approval mode. Every
                // subagent runs in Yolo, because a delegated child cannot
                // answer an approval prompt, so without this a read-only child
                // role -- explore, plan, review -- had its native exec and
                // file-change requests auto-accepted, and with
                // `isolation=shared` those act on the parent's own checkout.
                // Codex is also asked to sandbox itself on `thread/start`, but
                // that is a request to another process; this is the part
                // Maestro enforces.
                // Report the operation for output accounting before deciding
                // on it. Codex runs these itself instead of through
                // `item/tool/call`, so they produce no `ToolCall` event and a
                // caller metering this stream -- the subagent scheduler --
                // never charged the command or patch the model generated.
                // Charged whether or not it is approved: the model produced
                // the payload either way.
                let _ = self.event_tx.send(FromAgent::CodexNativeOperation {
                    method: request.method.clone(),
                    output_chars: codex_native_operation_chars(request.params.as_ref()),
                });

                // Policy hooks govern this branch too. Round 4 routed
                // `item/tool/call` through the pipeline, but a Codex-native
                // mutation is approved here instead, so a hook that blocks
                // shell commands or file writes was bypassed on exactly the
                // operations it exists to stop.
                //
                // The operation is presented under a stable synthetic tool name
                // so a policy can match it, with the request params as its
                // arguments. Only `block` is actionable: Codex has already
                // decided what to run and there is no way to hand it rewritten
                // arguments, so a `ModifyInput` rewrite is treated as a denial
                // rather than silently approving the unsanitized original.
                // A hook that must rewrite a command has to use the
                // `item/tool/call` path.
                //
                // Capture any paths on the approval itself before hooks run,
                // then hand hooks the same correlated path set the firewall
                // uses. itemId-only v2 approvals otherwise leave path-sensitive
                // PreToolUse / PermissionRequest hooks blind.
                if let Some(params) = request.params.as_ref() {
                    remember_codex_file_change_item_paths(
                        params,
                        &mut self.codex_file_change_paths_by_item,
                    );
                }
                let policy_tool = codex_native_policy_tool(&request.method);
                let policy_args = codex_native_policy_hook_args(
                    &request.method,
                    request.params.as_ref(),
                    &self.codex_file_change_paths_by_item,
                );
                let policy_call_id = Uuid::new_v4().to_string();
                let hook_denial = match run_pre_tool_use_hook(
                    &self.hooks,
                    policy_tool,
                    &policy_call_id,
                    &policy_args,
                )
                .await
                {
                    Err(reason) => Some(reason),
                    Ok((rewritten, _)) if rewritten != policy_args => Some(
                        "PreToolUse rewrote the Codex-native operation, which cannot accept rewritten parameters"
                            .to_string(),
                    ),
                    Ok(_) => match self.hooks.hook_permission_request(
                        policy_tool,
                        &policy_call_id,
                        &policy_args,
                        "Codex-native mutation",
                    )
                    .await
                    {
                        NativeHookResult::Block { reason } => Some(reason),
                        _ => None,
                    },
                };

                let denies_mutation = config_denies_mutation(self.config.sandbox_policy.as_ref());
                let profile_denial = codex_native_denied_by_active_tools(
                    &request.method,
                    turn_start_active_tool_names,
                );
                let firewall_decision = codex_native_firewall_decision(
                    &self.tool_executor,
                    &request.method,
                    request.params.as_ref(),
                    Some(&self.workflow_state.snapshot()),
                    Some(&self.codex_file_change_paths_by_item),
                );
                let firewall_denial = match &firewall_decision {
                    CodexNativeFirewallDecision::Block { reason } => Some(reason.clone()),
                    _ => None,
                };
                let denial_reason = if let Some(reason) = hook_denial.as_deref() {
                    Some(format!("blocked by a policy hook: {reason}"))
                } else if let Some(reason) = firewall_denial.as_deref() {
                    Some(format!("blocked by the action firewall: {reason}"))
                } else if let Some(reason) = profile_denial {
                    Some(reason.to_string())
                } else if denies_mutation {
                    Some("the sandbox policy is read-only".to_string())
                } else {
                    None
                };
                if let Some(reason) = denial_reason {
                    discard_deferred_codex_native_completion(
                        request.params.as_ref(),
                        &mut self.codex_native_pending_completions,
                    );
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Declined Codex-native {} ({reason})", request.method),
                    });
                    let _ = self.event_tx.send(FromAgent::CodexNativeDecision {
                        method: request.method.clone(),
                        decision: "denied_policy".to_owned(),
                    });
                    request.respond(approval_decision(false));
                    return Ok(());
                }
                if !codex_native_approval_requires_user(self.config.approval_mode) {
                    let _ = self.event_tx.send(FromAgent::CodexNativeDecision {
                        method: request.method.clone(),
                        decision: "approved_policy".to_owned(),
                    });
                    remember_approved_codex_native_operation(
                        request.params.as_ref(),
                        &policy_call_id,
                        policy_tool,
                        &mut self.codex_native_tools_by_item,
                    );
                    if let Some(event) = project_deferred_codex_native_completion(
                        request.params.as_ref(),
                        &mut self.codex_native_pending_completions,
                        &mut self.codex_native_tools_by_item,
                        self.tool_executor.managed_policy_metadata(),
                    ) {
                        let _ = self.event_tx.send(event);
                    }
                    request.respond(approval_decision(true));
                    return Ok(());
                }
                let _ = self.event_tx.send(FromAgent::ToolCall {
                    call_id: policy_call_id.clone(),
                    tool: policy_tool.to_owned(),
                    args: policy_args,
                    requires_approval: true,
                    approval_inline_env: None,
                });
                let approval_cancel = self.shutdown_token.child_token();
                self.set_active_approval_cancel_token(Some(approval_cancel.clone()));
                let approval_started = Instant::now();
                let approval = approval_span();
                let response = self
                    .tool_response_coordinator
                    .wait_for_tool_response(&policy_call_id, &approval_cancel)
                    .instrument(approval.clone())
                    .await;
                self.set_active_approval_cancel_token(None);
                let (approval_outcome, approval_error) = match &response {
                    ToolResponseWait::Response((approved, _, _)) if *approved => ("approved", None),
                    ToolResponseWait::Response(_) => ("denied", Some("approval_denied")),
                    ToolResponseWait::Cancelled => ("cancelled", Some("approval_cancelled")),
                    ToolResponseWait::Closed => ("closed", Some("approval_channel_closed")),
                };
                record_outcome(
                    &approval,
                    approval_outcome,
                    approval_started.elapsed(),
                    approval_error,
                );
                let (approved, _, _) = match response {
                    ToolResponseWait::Response(response) => response,
                    ToolResponseWait::Cancelled => {
                        discard_deferred_codex_native_completion(
                            request.params.as_ref(),
                            &mut self.codex_native_pending_completions,
                        );
                        let cancelled_ids = HashSet::from([policy_call_id.clone()]);
                        self.tool_response_coordinator
                            .discard_cancelled(&cancelled_ids);
                        let _ = self.event_tx.send(FromAgent::CodexNativeDecision {
                            method: request.method.clone(),
                            decision: "cancelled".to_owned(),
                        });
                        request.respond(approval_decision(false));
                        return Ok(());
                    }
                    ToolResponseWait::Closed => {
                        discard_deferred_codex_native_completion(
                            request.params.as_ref(),
                            &mut self.codex_native_pending_completions,
                        );
                        let _ = self.event_tx.send(FromAgent::CodexNativeDecision {
                            method: request.method.clone(),
                            decision: "channel_closed".to_owned(),
                        });
                        request.respond(approval_decision(false));
                        return Ok(());
                    }
                };
                if !approved {
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Declined Codex-native {} (user denied)", request.method),
                    });
                }
                let _ = self.event_tx.send(FromAgent::CodexNativeDecision {
                    method: request.method.clone(),
                    decision: if approved {
                        "approved_user"
                    } else {
                        "denied_user"
                    }
                    .to_owned(),
                });
                if approved {
                    remember_approved_codex_native_operation(
                        request.params.as_ref(),
                        &policy_call_id,
                        policy_tool,
                        &mut self.codex_native_tools_by_item,
                    );
                    if let Some(event) = project_deferred_codex_native_completion(
                        request.params.as_ref(),
                        &mut self.codex_native_pending_completions,
                        &mut self.codex_native_tools_by_item,
                        self.tool_executor.managed_policy_metadata(),
                    ) {
                        let _ = self.event_tx.send(event);
                    }
                } else {
                    discard_deferred_codex_native_completion(
                        request.params.as_ref(),
                        &mut self.codex_native_pending_completions,
                    );
                }
                request.respond(approval_decision(approved));
                Ok(())
            }
            "item/permissions/requestApproval" => {
                request.respond(json!({ "permissions": {}, "scope": "turn" }));
                Ok(())
            }
            other => {
                request.reject(format!("Unsupported Codex server-request: {other}"));
                Ok(())
            }
        }
    }

    /// Describe the batch's tool results for the reminder engine.
    fn tool_outcomes_for_batch(&self, results: &[ContentBlock]) -> Vec<ReminderToolOutcome> {
        tool_outcomes_for_batch(&self.tool_executor, self.messages.last(), results)
    }

    /// Refuse a whole tool batch because the turn's step budget is spent.
    ///
    /// Returns the refused tool names in call order.
    ///
    /// Each refused call gets a model-visible `ToolResult` in the same shape
    /// an executed call produces, which keeps every `tool_use` block paired
    /// with a `tool_result` and states the refusal instead of dropping it.
    /// Dropping a call would violate the provider transcript's tool-use/result
    /// pairing and leave its state ambiguous, allowing a later response to
    /// describe unexecuted work as queued or complete. An explicit refusal
    /// result preserves the pairing and makes non-execution authoritative.
    ///
    /// No `ToolCall` event is emitted for a refused call. That event is a
    /// request to execute: callers that own execution (`print_mode`, the
    /// headless server) act on it, and they must not run a call this turn
    /// just refused.
    fn refuse_tool_batch_over_step_budget(
        &mut self,
        calls: Vec<(String, String, Value, Option<String>)>,
        max_steps: usize,
    ) -> Vec<String> {
        let mut tool_results: Vec<ContentBlock> = Vec::new();
        let mut refused_tools: Vec<String> = Vec::new();
        for (call_id, tool_name, _args, _parse_error) in calls {
            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: call_id,
                content: format!(
                    "not_executed: this turn reached its step budget of {max_steps} model \
                     responses, so `{tool_name}` was refused and did not run. Tell the user \
                     what is still outstanding; do not report this call as done, queued, or \
                     running."
                ),
                is_error: Some(true),
            });
            refused_tools.push(tool_name);
        }
        self.messages_mut().push(Message {
            role: Role::User,
            content: MessageContent::Blocks(tool_results),
        });
        self.tool_executor.report_diagnostic(format!(
            "[agent] turn step budget exhausted after {max_steps} model responses; refused {} tool call(s): {}",
            refused_tools.len(),
            refused_tools.join(", "),
        ));
        refused_tools
    }

    fn retire_process_budget(&mut self, system_prompt: String) -> Result<()> {
        if self.busy || !self.pending_messages.is_empty() || !self.deferred_commands.is_empty() {
            anyhow::bail!("cannot retire process budget during an active or queued turn");
        }
        self.process_budget = None;
        self.config.system_prompt = Some(system_prompt);
        self.system_prompt_revision = self.system_prompt_revision.saturating_add(1);
        self.runtime_prompt_revision = self.runtime_prompt_revision.saturating_add(1);
        self.refresh_runtime_audit();
        Ok(())
    }

    fn apply_process_budget(
        &mut self,
        limits: super::process_budget::ProcessBudgetLimits,
        checkpoint: Option<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>>,
    ) -> Result<Arc<std::sync::Mutex<super::process_budget::ProcessBudgetState>>> {
        if self.model_route.uses_app_server() {
            anyhow::bail!("process budgets require managed native inference");
        }
        let state = self.process_budget.clone().or(checkpoint);
        let state = match state {
            Some(state) => {
                state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("process budget poisoned"))?
                    .install(&limits)
                    .map_err(anyhow::Error::msg)?;
                state
            }
            None => Arc::new(std::sync::Mutex::new(
                super::process_budget::ProcessBudgetState::new(limits)
                    .map_err(anyhow::Error::msg)?,
            )),
        };
        self.process_budget = Some(Arc::clone(&state));
        Ok(state)
    }

    fn refuse_tool_batch(
        &mut self,
        calls: Vec<(String, String, Value, Option<String>)>,
        reason: &str,
    ) {
        let results = calls
            .into_iter()
            .map(|(id, tool, _, _)| ContentBlock::ToolResult {
                tool_use_id: id,
                content: format!(
                    "not_executed: {tool} was refused because {reason}; it did not run."
                ),
                is_error: Some(true),
            })
            .collect::<Vec<_>>();
        if !results.is_empty() {
            self.messages_mut().push(Message {
                role: Role::User,
                content: MessageContent::Blocks(results),
            });
        }
    }

    /// Run the agent loop until complete or interrupted
    /// One user turn.
    ///
    /// Wraps [`Self::run_loop_inner`] so every exit path -- normal completion,
    /// cancellation, provider error -- fires `on_turn_end` exactly once.
    async fn run_loop(&mut self, step_budget: &mut TurnStepBudget) -> Result<()> {
        self.current_turn_id = Uuid::new_v4().to_string();
        self.turn_index = self.turn_index.saturating_add(1);
        self.turn_tool_calls = 0;

        self.apply_requested_boost().await?;
        self.tool_executor.set_subagent_parent_model(
            self.current_model_choice().model,
            self.current_model_choice().thinking.label().to_owned(),
        );
        let turn_started = Instant::now();
        let turn = turn_span(None);
        turn.record("gen_ai.agent.run.id", self.current_turn_id.as_str());
        let outcome = self
            .run_with_model_recovery(step_budget)
            .instrument(turn.clone())
            .await;
        let outcome_label = if outcome.is_ok() { "success" } else { "error" };
        record_outcome(
            &turn,
            outcome_label,
            turn_started.elapsed(),
            outcome.is_err().then_some("turn_error"),
        );
        turn.in_scope(|| {
            let terminal = terminal_span(outcome_label);
            record_outcome(
                &terminal,
                outcome_label,
                turn_started.elapsed(),
                outcome.is_err().then_some("turn_error"),
            );
        });

        let cx = TurnEndContext {
            turn_id: self.current_turn_id.clone(),
            tool_calls: self.turn_tool_calls,
            interrupted: outcome.is_err(),
        };
        self.extensions.on_turn_end(&cx);
        outcome
    }

    /// Fire `on_user_turn_start` on every registered extension.
    ///
    /// Called from the `AgentCommand` arms that discard conversation state, the
    /// same three places the doom-loop detector was reset before it became an
    /// extension tenant.
    fn notify_extensions_user_turn_start(&mut self) {
        let cx = TurnStartContext {
            turn_id: self.current_turn_id.clone(),
            turn_index: self.turn_index,
        };
        self.extensions.on_user_turn_start(&cx);
    }

    /// Build the `on_tool_call_planned` context for a call and dispatch it.
    ///
    /// Increments the per-turn tool-call counter, so `call_index` is the number
    /// of calls this turn planned before this one.
    fn plan_tool_call_through_extensions(
        &mut self,
        call_id: &str,
        tool_name: &str,
        safe_args: &serde_json::Value,
    ) -> ExtensionVerdict {
        let cx = ExtensionToolCallContext {
            turn_id: self.current_turn_id.clone(),
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            args_hash: stable_stringify(safe_args),
            args: safe_args.clone(),
            call_index: self.turn_tool_calls,
        };
        self.turn_tool_calls = self.turn_tool_calls.saturating_add(1);
        self.extensions.on_tool_call_planned(&cx)
    }

    /// Dispatch `on_tool_result` and apply whatever the tenants left in the
    /// payload back onto the model-facing result.
    #[allow(clippy::too_many_arguments)]
    fn apply_tool_result_extensions(
        &mut self,
        call_id: &str,
        tool_name: &str,
        safe_args: &serde_json::Value,
        duration_ms: u64,
        content: String,
        is_error: bool,
        receipt: Option<&super::protocol::ExecutionReceipt>,
    ) -> (String, bool) {
        let cx = ExtensionToolResultContext {
            edit: receipt.and_then(|receipt| match &receipt.details {
                super::protocol::ToolReceiptDetails::BuiltIn(crate::ToolDetails::Edit(edit))
                    if matches!(receipt.source, super::protocol::ExecutionSource::Native) =>
                {
                    Some(super::extensions::LocalEditResult {
                        path: edit.path.clone(),
                        text_not_found: edit.text_not_found,
                    })
                }
                _ => None,
            }),
            turn_id: self.current_turn_id.clone(),
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            args_hash: stable_stringify(safe_args),
            args: safe_args.clone(),
            is_error,
            duration_ms,
        };
        let mut payload = ToolResultPayload { content, is_error };
        self.extensions.on_tool_result(&cx, &mut payload);
        (payload.content, payload.is_error)
    }

    /// Dispatch `on_tool_batch_end` with the batch's last result as the mutable
    /// payload, then write any tenant edits back into that result.
    fn apply_tool_batch_end_extensions(&mut self, tool_results: &mut [ContentBlock]) {
        let error_count = tool_results
            .iter()
            .filter(|block| {
                matches!(
                    block,
                    ContentBlock::ToolResult {
                        is_error: Some(true),
                        ..
                    }
                )
            })
            .count() as u64;
        let cx = BatchEndContext {
            turn_id: self.current_turn_id.clone(),
            batch_size: tool_results.len() as u64,
            error_count,
        };

        let Some(ContentBlock::ToolResult {
            content, is_error, ..
        }) = tool_results.last_mut()
        else {
            // Still announce the boundary; a tenant that only counts batches
            // must not miss one because the batch ended on a non-tool block.
            let mut payload = ToolResultPayload::default();
            self.extensions.on_tool_batch_end(&cx, &mut payload);
            return;
        };

        let original_is_error = *is_error;
        let mut payload = ToolResultPayload {
            content: std::mem::take(content),
            is_error: original_is_error.unwrap_or(false),
        };
        self.extensions.on_tool_batch_end(&cx, &mut payload);
        *content = payload.content;
        // Only overwrite the flag when a tenant actually changed it, so a result
        // that carried `None` keeps carrying `None`.
        if Some(payload.is_error) != original_is_error {
            *is_error = Some(payload.is_error);
        }
    }

    async fn run_loop_inner(&mut self, step_budget: &mut TurnStepBudget) -> Result<()> {
        if self.model_route.uses_app_server() {
            return self.run_loop_via_codex_app_server(step_budget).await;
        }

        // Reminders accumulate across the tool batches of one turn and reset
        // when a queued user message starts a new one.
        let mut reminders = ReminderEngine::new();
        // Nothing else in the runner watches assistant text. Without this the
        // only thing that ends a repeating generation is the provider's own
        // output cap, which the user pays for in full.
        let mut text_loop_detector = TextLoopDetector::new();
        let mut steered_after_text_loop = false;
        let mut steered_after_billed_empty = false;
        'turn: loop {
            step_budget.admit_attempt().map_err(anyhow::Error::msg)?;
            text_loop_detector.reset();
            step_budget.record_step();
            let response_id = Uuid::new_v4().to_string();
            let start_time = Instant::now();
            let mut stop_reason: Option<crate::ai::StopReason> = None;

            // Signal response start
            let _ = self.event_tx.send(FromAgent::ResponseStart {
                response_id: response_id.clone(),
            });

            // A previous turn may have been interrupted after recording
            // assistant tool calls (the select on the cancellation token can
            // drop this loop mid-await, skipping the cleanup below). Never
            // send a history with orphaned tool calls to the provider.
            self.repair_orphaned_tool_calls();

            // Make the API call
            let request_messages = Arc::clone(&self.messages);
            let provider_messages =
                resolve_provider_history_shared(&request_messages, &self.credential_vault)?;
            let config = self.build_config(&provider_messages, true).await?;
            let request_id = if let Some(tail) = config
                .cache_topology
                .as_ref()
                .and_then(|prepared| prepared.volatile_tail())
            {
                let mut identity_messages = provider_messages.to_vec();
                identity_messages.push(Message {
                    role: Role::User,
                    content: MessageContent::text(tail),
                });
                provider_request_id("primary", &config.model, &identity_messages)?
            } else {
                provider_request_id("primary", &config.model, &provider_messages)?
            };
            self.admit_provider_request("primary", &request_id, Some(&config.model))
                .await?;
            let client = self
                .client
                .as_ref()
                .context("direct provider client missing for native turn")?;
            let mut rx = client
                .stream_owned_config_shared_messages_observed(
                    provider_messages,
                    config.clone(),
                    Some(Arc::new({
                        let event_tx = self.event_tx.clone();
                        move |observation| {
                            let _ = event_tx.send(FromAgent::StreamObservation { observation });
                        }
                    })),
                )
                .await
                .map_err(model_dynamics::ProviderRequestFailure)?;

            // Collect the response
            let mut assistant_content: Vec<ContentBlock> = Vec::new();
            let mut current_text = String::new();
            let mut current_thinking = String::new();
            // Track active tool plus any pre-start deltas (index, id, name, json)
            let mut current_tool: Option<(usize, String, String, String)> = None;
            let mut pending_tool_inputs: std::collections::HashMap<usize, String> =
                std::collections::HashMap::new();
            let mut usage = TokenUsage::default();
            // An OpenAI-compatible endpoint may omit the usage chunk entirely
            // (`packages/ai-rs/src/openai.rs` only emits `StreamEvent::Usage`
            // when the chunk carries one). Reporting the zero-valued default as
            // `Some(usage)` made "the provider says this turn cost nothing"
            // indistinguishable from "the provider said nothing", and a caller
            // metering the run believed the zero. The side-question loop
            // already made this distinction; the main turn loop did not.
            let mut saw_usage = false;
            let mut pending_tool_calls: Vec<(String, String, serde_json::Value, Option<String>)> =
                Vec::new();
            let mut stream_failed = false;
            let mut stream_error_message: Option<String> = None;
            let mut stream_error_kind: Option<ProviderStreamErrorKind> = None;
            let mut saw_stream_terminal = false;
            // Verdicts collected from `on_assistant_text_delta`, applied once
            // the provider response is complete so history is never left with
            // orphaned tool calls.
            let mut extension_text_block: Option<String> = None;
            let mut extension_text_steer: Vec<String> = Vec::new();
            let mut detected_text_loop: Option<LoopKind> = None;

            // Process stream events
            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::ManagedGatewayReceipt(receipt) => {
                        let _ = self
                            .event_tx
                            .send(Self::managed_gateway_receipt_event(receipt, true));
                    }
                    StreamEvent::MessageStart { .. } => {}
                    StreamEvent::ContentBlockStart { index, block } => match &block {
                        ContentBlock::Text { text } => {
                            current_text = text.clone();
                        }
                        ContentBlock::Thinking { thinking, .. } => {
                            current_thinking = thinking.clone();
                        }
                        ContentBlock::ToolUse { id, name, .. } => {
                            let buffered = pending_tool_inputs.remove(&index).unwrap_or_default();
                            current_tool = Some((index, id.clone(), name.clone(), buffered));
                        }
                        _ => {}
                    },
                    StreamEvent::TextDelta { text, .. } => {
                        current_text.push_str(&text);
                        match self.extensions.on_assistant_text_delta(&text) {
                            ExtensionVerdict::Proceed => {}
                            ExtensionVerdict::Block { reason } => {
                                if extension_text_block.is_none() {
                                    extension_text_block = Some(reason);
                                }
                            }
                            ExtensionVerdict::Steer { message } => {
                                if !extension_text_steer.contains(&message) {
                                    extension_text_steer.push(message);
                                }
                            }
                        }
                        // Check before rendering so the detector sees every
                        // delta exactly once and in order.
                        let text_loop = text_loop_detector
                            .add_text(&text, Instant::now() + TEXT_LOOP_CHECK_BUDGET);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: text,
                            is_thinking: false,
                        });
                        if let Some(kind) = text_loop {
                            // Stop reading the stream. Dropping `rx` ends the
                            // provider request, which is the point: the rest
                            // of this response is the same text again.
                            detected_text_loop = Some(kind);
                            saw_stream_terminal = true;
                            if !current_text.is_empty() {
                                assistant_content.push(ContentBlock::Text {
                                    text: std::mem::take(&mut current_text),
                                });
                            }
                            abort_pending_tools_after_stream_error(
                                &mut assistant_content,
                                &mut pending_tool_calls,
                            );
                            break;
                        }
                    }
                    StreamEvent::ThinkingDelta { thinking, .. } => {
                        current_thinking.push_str(&thinking);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: thinking,
                            is_thinking: true,
                        });
                    }
                    StreamEvent::ThinkingSignature { .. } => {
                        // Signature is captured in ContentBlockStop via parser state
                        // No action needed here - the signature is associated with the
                        // thinking block when the content block stops
                    }
                    StreamEvent::InputJsonDelta {
                        index,
                        partial_json,
                    } => {
                        // Deltas can precede a block start. Once the matching
                        // block is active, append only there; buffering as well
                        // would append the same bytes a second time at stop.
                        if let Some((active_index, _, _, ref mut json)) = current_tool {
                            if active_index == index {
                                json.push_str(&partial_json);
                                continue;
                            }
                        }
                        pending_tool_inputs
                            .entry(index)
                            .and_modify(|s| s.push_str(&partial_json))
                            .or_insert(partial_json);
                    }
                    StreamEvent::ContentBlockStop {
                        index: _,
                        thinking_signature,
                    } => {
                        // Finalize current content block
                        if !current_text.is_empty() {
                            assistant_content.push(ContentBlock::Text {
                                text: std::mem::take(&mut current_text),
                            });
                        }
                        append_completed_thinking_block(
                            &mut assistant_content,
                            &mut current_thinking,
                            thinking_signature,
                        );
                        if let Some((active_index, id, name, mut json)) = current_tool.take() {
                            // Merge any buffered deltas that arrived before the block start
                            if let Some(extra) = pending_tool_inputs.remove(&active_index) {
                                json.push_str(&extra);
                            }
                            let (input, parse_error) = match parse_tool_input(&name, &json) {
                                Ok(value) => (value, None),
                                Err(message) => (serde_json::json!({}), Some(message)),
                            };
                            let vaulted_input = self.credential_vault.vault_in_json(&input);
                            assistant_content.push(ContentBlock::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: vaulted_input.clone(),
                            });
                            pending_tool_calls.push((id, name, input, parse_error));
                        }
                    }
                    StreamEvent::ProviderCost { cost_usd } => {
                        usage.cost = Some(cost_usd);
                    }
                    StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    } => {
                        usage.input_tokens = input_tokens;
                        usage.output_tokens = output_tokens;
                        usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                        saw_usage = true;
                    }
                    StreamEvent::MessageStop {
                        stop_reason: reason,
                    } => {
                        saw_stream_terminal = true;
                        stop_reason = reason;
                        // An output limit does not imply that the input context is full.
                        // Even valid JSON tool arguments can be only a prefix of the
                        // intended operation. Return explicit failures without execution.
                        if matches!(stop_reason, Some(StopReason::MaxTokens)) {
                            for (_, _, _, refusal) in &mut pending_tool_calls {
                                *refusal = Some(
                                    "not_executed: provider output was truncated at its token limit; request the complete tool call again".to_owned(),
                                );
                            }
                        }
                        break;
                    }
                    StreamEvent::Error { message } => {
                        saw_stream_terminal = true;
                        stream_failed = true;
                        stream_error_message = Some(message.clone());
                        abort_pending_tools_after_stream_error(
                            &mut assistant_content,
                            &mut pending_tool_calls,
                        );
                        break;
                    }
                    StreamEvent::ProviderError { kind, message } => {
                        saw_stream_terminal = true;
                        stream_failed = true;
                        stream_error_kind = Some(kind);
                        stream_error_message = Some(message.clone());
                        abort_pending_tools_after_stream_error(
                            &mut assistant_content,
                            &mut pending_tool_calls,
                        );
                        break;
                    }
                }
            }

            if !saw_stream_terminal {
                stream_failed = true;
                stream_error_kind = Some(ProviderStreamErrorKind::TransientProtocol);
                stream_error_message = Some(
                    "native provider stream ended before an explicit terminal event".to_string(),
                );
                abort_pending_tools_after_stream_error(
                    &mut assistant_content,
                    &mut pending_tool_calls,
                );
            }

            // Some provider streams repeat a terminal function-call item after
            // streaming its argument deltas. A duplicate tool result is invalid
            // for OpenAI-compatible APIs, so preserve only the first occurrence
            // of each call ID in both history and execution.
            let mut tool_use_ids = std::collections::HashSet::new();
            assistant_content.retain(|block| match block {
                ContentBlock::ToolUse { id, .. } => tool_use_ids.insert(id.clone()),
                _ => true,
            });
            let mut pending_call_ids = std::collections::HashSet::new();
            pending_tool_calls
                .retain(|(call_id, _, _, _)| pending_call_ids.insert(call_id.clone()));

            let process_usage = self
                .process_budget
                .as_ref()
                .map(|state| {
                    if !saw_usage {
                        return Err(anyhow::anyhow!("process response omitted usage"));
                    }
                    state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("process budget poisoned"))?
                        .observe_usage(
                            // Provider adapters normalize input into disjoint buckets.
                            // Cached tokens still consume the process token budget.
                            usage
                                .input_tokens
                                .checked_add(usage.cache_read_tokens)
                                .and_then(|tokens| tokens.checked_add(usage.cache_write_tokens))
                                .ok_or_else(|| anyhow::anyhow!("process input usage overflow"))?,
                            usage.output_tokens,
                            usage.cost.map(process_provider_cost_micros).transpose()?,
                        )
                        .map_err(anyhow::Error::msg)
                })
                .transpose();
            if let Err(error) = process_usage {
                if !stream_failed {
                    let _ = self.event_tx.send(FromAgent::LocalAssistantContent {
                        response_id: response_id.clone(),
                        content: assistant_content.clone(),
                    });
                }
                if !assistant_content.is_empty() {
                    self.messages_mut().push(Message {
                        role: Role::Assistant,
                        content: MessageContent::Blocks(assistant_content),
                    });
                }
                self.refuse_tool_batch(pending_tool_calls, &error.to_string());
                return Err(error);
            }

            // Mark the cleanup-sensitive interval before storing ToolUse
            // history, closing the gap where outer request cancellation could
            // otherwise leave an orphaned provider message.
            self.set_tool_batch_active(!pending_tool_calls.is_empty());

            let response_text = assistant_content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");

            if stream_failed {
                self.set_tool_batch_active(false);
                // The request still consumed provider output, but a partial
                // response is not authoritative assistant history and must
                // not run success-oriented post-message hooks.
                self.output_tokens_spent =
                    self.output_tokens_spent.saturating_add(usage.output_tokens);
                let last_assistant = (!response_text.is_empty()).then_some(response_text.as_str());
                let _ = self
                    .hooks
                    .hook_stop_failure("api_error", stream_error_message.as_deref(), last_assistant)
                    .await;
                let message = stream_error_message.unwrap_or_else(|| "stream failed".to_string());
                return match stream_error_kind {
                    Some(kind) => Err(anyhow::Error::new(ProviderStreamFailure { kind, message })),
                    None => Err(model_dynamics::ProviderRequestFailure(anyhow::anyhow!(
                        "{message}"
                    ))
                    .into()),
                };
            }

            if let Some(kind) = detected_text_loop {
                // The unified stream owns both its retry forwarder and the
                // provider's HTTP/SSE producer. Confirm both have released
                // the abandoned response before starting the steered retry;
                // merely dropping the receiver can leave either task running.
                rx.cancel_and_wait()
                    .await
                    .context("failed to stop looping provider stream")?;
                // The response is real output the provider billed, so charge
                // it and record it as assistant history before deciding what
                // to do about the repetition.
                self.output_tokens_spent =
                    self.output_tokens_spent.saturating_add(usage.output_tokens);
                let _ = self.event_tx.send(FromAgent::LocalAssistantContent {
                    response_id: response_id.clone(),
                    content: assistant_content.clone(),
                });
                if !assistant_content.is_empty() {
                    self.messages_mut().push(Message {
                        role: Role::Assistant,
                        content: MessageContent::Blocks(assistant_content),
                    });
                }
                let _ = self.event_tx.send(FromAgent::ResponseEnd {
                    response_id: response_id.clone(),
                    usage: saw_usage.then_some(usage),
                });
                self.tool_executor.report_diagnostic(format!(
                    "[agent] assistant text loop detected (kind={}, repetitions={}, already_steered={steered_after_text_loop}): {}",
                    kind.label(),
                    kind.repetitions(),
                    kind.preview(),
                ));
                if steered_after_text_loop {
                    // One reminder is the whole budget. A model that loops
                    // again after being told is not going to stop, and
                    // retrying costs the user another full generation.
                    return Err(anyhow::Error::new(AssistantTextLoop { kind }));
                }
                steered_after_text_loop = true;
                let _ = self.event_tx.send(FromAgent::Status {
                    message: "Model output was repeating; steering once and retrying.".to_string(),
                });
                self.messages_mut().push(Message {
                    role: Role::User,
                    content: MessageContent::text(loop_reminder_message(&kind)),
                });
                if self.drain_pending_commands().await {
                    self.repair_orphaned_tool_calls();
                    return Err(anyhow::anyhow!("Request cancelled"));
                }
                continue 'turn;
            }

            if response_text.trim().is_empty() && pending_tool_calls.is_empty() {
                let provider = self
                    .client
                    .as_ref()
                    .map(UnifiedClient::provider_name)
                    .unwrap_or("unknown");
                tracing::warn!(
                    target: "maestro.provider",
                    event = "provider_empty_assistant_response",
                    provider,
                    model = %self.config.model,
                    normalized_blocks = assistant_content.len(),
                    saw_usage,
                    output_tokens = usage.output_tokens,
                );
                self.tool_executor.report_diagnostic(format!(
                    "[agent] provider returned no assistant text or tool calls (provider={provider}, model={}, normalized_blocks={}, saw_usage={saw_usage}, output_tokens={})",
                    self.config.model,
                    assistant_content.len(),
                    usage.output_tokens,
                ));
                // A billed empty completion is thinking-only or a stripped
                // thought turn, not a dropped connection. Retrying the same
                // request reproduces it; one continuation is the recovery.
                if saw_usage && usage.output_tokens > 0 && !steered_after_billed_empty {
                    self.output_tokens_spent =
                        self.output_tokens_spent.saturating_add(usage.output_tokens);
                    let _ = self.event_tx.send(FromAgent::LocalAssistantContent {
                        response_id: response_id.clone(),
                        content: assistant_content.clone(),
                    });
                    if !assistant_content.is_empty() {
                        self.messages_mut().push(Message {
                            role: Role::Assistant,
                            content: MessageContent::Blocks(assistant_content),
                        });
                    }
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: response_id.clone(),
                        usage: Some(usage),
                    });
                    steered_after_billed_empty = true;
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: "Model billed tokens with no assistant text; steering once and retrying."
                            .to_string(),
                    });
                    self.messages_mut().push(Message {
                        role: Role::User,
                        content: MessageContent::text(billed_empty_reminder_message()),
                    });
                    if self.drain_pending_commands().await {
                        self.repair_orphaned_tool_calls();
                        return Err(anyhow::anyhow!("Request cancelled"));
                    }
                    continue 'turn;
                }
                self.set_tool_batch_active(false);
                return Err(anyhow::Error::new(EmptyAssistantResponse));
            }

            step_budget.accept_attempt();

            // Persist the completed provider blocks before tool execution
            // events. Display state has neither those calls yet nor thinking
            // signatures.
            let _ = self.event_tx.send(FromAgent::LocalAssistantContent {
                response_id: response_id.clone(),
                content: assistant_content.clone(),
            });

            // Add assistant message to history
            if !assistant_content.is_empty() {
                self.messages_mut().push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Blocks(assistant_content),
                });
            }

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let stop_reason_label = stop_reason.map(Self::stop_reason_label);

            // Charge this response against any cumulative output budget before
            // the next request is built; `build_config` reads the running total.
            self.output_tokens_spent = self.output_tokens_spent.saturating_add(usage.output_tokens);

            // Complete optional summarization while this response still owns
            // the turn. Its billed usage is included in the response total.
            let prepared_compaction = if pending_tool_calls.is_empty()
                && self.compactor.should_auto_compact(&self.messages)
            {
                let compaction_started = Instant::now();
                let result = self.compactor.compact_with_tokens(&self.messages);
                let result = self
                    .enhance_compaction(result, &mut usage, &mut saw_usage)
                    .await;
                if result.was_compacted() {
                    let _ = self.event_tx.send(FromAgent::CompactionMeasured {
                        duration_ms: compaction_started
                            .elapsed()
                            .as_millis()
                            .min(u64::MAX as u128) as u64,
                    });
                }
                Some(result)
            } else {
                None
            };

            // The current user message is already in the JSONL. Snapshot its
            // size before ResponseEnd asks the UI to append the assistant turn,
            // so Session History waits for that exact persistence boundary.
            self.hooks
                .hook_checkpoint_transcript_before_response()
                .await;

            // Signal response end. `None` means the provider reported nothing
            // for this turn, which is not the same as reporting zero.
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: saw_usage.then_some(usage.clone()),
            });

            // ResponseEnd is enqueued first so the UI can append and flush the
            // canonical JSONL while the PostMessage capture hook waits for the
            // file to cross its pre-response size boundary.
            let _ = self
                .hooks
                .hook_post_message(
                    &response_text,
                    usage.input_tokens,
                    usage.output_tokens,
                    duration_ms,
                    stop_reason_label,
                )
                .await;

            // An extension voted to stop the assistant mid-stream. End the turn
            // now that the provider response is complete.
            if let Some(reason) = extension_text_block {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: reason,
                    fatal: false,
                    terminal: false,
                    retryable: false,
                });
                self.set_tool_batch_active(false);
                self.repair_orphaned_tool_calls();
                break 'turn;
            }

            // An extension asked to redirect the model. Queue the text as a
            // steering prompt, which the existing next-turn drain picks up.
            for message in std::mem::take(&mut extension_text_steer) {
                let _ = self.event_tx.send(FromAgent::Status {
                    message: message.clone(),
                });
                self.pending_messages
                    .push_with_kind(message, PromptKind::Steer);
            }

            if self.drain_pending_commands().await {
                self.repair_orphaned_tool_calls();
                return Err(anyhow::anyhow!("Request cancelled"));
            }

            // A tool batch costs another provider round trip: the runner has
            // to ask the model again with the results. When the turn cannot
            // afford that round trip, executing the batch would produce work
            // the model never sees, so the batch is refused explicitly and the
            // turn ends here.
            if !pending_tool_calls.is_empty() && !step_budget.can_continue() {
                let unexecuted_tools = self.refuse_tool_batch_over_step_budget(
                    pending_tool_calls,
                    step_budget.max_steps(),
                );
                self.set_tool_batch_active(false);
                let outcome: TurnOutcome = step_budget.exhausted(unexecuted_tools);
                return Err(anyhow::Error::new(outcome));
            }

            if let Err(reason) = pending_tool_calls
                .iter()
                .try_for_each(|(_, name, args, _)| step_budget.admit_tool(name, args))
            {
                self.refuse_tool_batch(pending_tool_calls, reason);
                self.set_tool_batch_active(false);
                return Err(anyhow::anyhow!(reason));
            }

            let process_tools = self
                .process_budget
                .as_ref()
                .map(|state| {
                    state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("process budget poisoned"))?
                        .admit_tools(pending_tool_calls.len())
                        .map_err(anyhow::Error::msg)
                })
                .transpose();
            if let Err(error) = process_tools {
                self.refuse_tool_batch(pending_tool_calls, &error.to_string());
                self.set_tool_batch_active(false);
                return Err(error);
            }

            // If there are tool calls, handle them
            if !pending_tool_calls.is_empty() {
                let mut tool_results: Vec<ContentBlock> = Vec::new();
                let mut deferred_steering: Vec<PendingMessage> = Vec::new();
                let mut deferred_tool_calls: Vec<DeferredToolCall> = Vec::new();
                let mut remaining_tool_calls: Vec<(
                    String,
                    String,
                    serde_json::Value,
                    Option<String>,
                )> = Vec::new();
                let mut pending_tool_calls_iter = pending_tool_calls.into_iter();
                let mut pending_read_only_tool_calls: Vec<QueuedReadOnlyToolExecution> = Vec::new();
                let mut processed_any_tool = false;

                while let Some((call_id, tool_name, args, parse_error)) =
                    pending_tool_calls_iter.next()
                {
                    self.tool_response_coordinator.remove_cancelled(&call_id);
                    if processed_any_tool {
                        if self.drain_pending_commands().await {
                            if !tool_results.is_empty() {
                                self.messages_mut().push(Message {
                                    role: Role::User,
                                    content: MessageContent::Blocks(std::mem::take(
                                        &mut tool_results,
                                    )),
                                });
                            }
                            self.repair_orphaned_tool_calls();
                            return Err(anyhow::anyhow!("Request cancelled"));
                        }
                        deferred_steering = self.dequeue_next_turn_messages(false);
                        if !deferred_steering.is_empty() {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            remaining_tool_calls.push((call_id, tool_name, args, parse_error));
                            remaining_tool_calls.extend(pending_tool_calls_iter);
                            break;
                        }
                    }
                    processed_any_tool = true;

                    if let Some(message) = parse_error {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: message.clone(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id.clone(),
                            content: message,
                            is_error: Some(true),
                        });
                        continue;
                    }
                    let tool_key = tool_name.to_lowercase();
                    if !self.tools.contains_key(&tool_key) {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            content: format!("Tool `{tool_name}` is not available in this run"),
                            is_error: Some(true),
                        });
                        continue;
                    }

                    // Preserve the model-provided input so a call deferred
                    // behind an approval boundary can rerun PreToolUse
                    // against current state without applying an earlier hook
                    // rewrite a second time.
                    let pre_hook_args = args.clone();

                    // Execute PreToolUse hooks
                    let hook_result = self
                        .hooks
                        .hook_pre_tool_use(&tool_name, &call_id, &pre_hook_args)
                        .await;

                    // Handle hook results
                    let (args, extra_context) = match hook_result {
                        NativeHookResult::Block { reason } => {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            // Hook blocked the tool - return error to model
                            let _ = self.event_tx.send(FromAgent::HookBlocked {
                                call_id: call_id.clone(),
                                tool: tool_name.clone(),
                                reason: reason.clone(),
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: format!("Tool blocked by hook: {reason}"),
                                is_error: Some(true),
                            });
                            continue;
                        }
                        NativeHookResult::ModifyInput { new_input } => {
                            // Use modified input
                            (new_input, None)
                        }
                        NativeHookResult::InjectContext { context } => {
                            // Keep original args, but track context to append
                            (args.clone(), Some(context))
                        }
                        NativeHookResult::Continue => {
                            // No modification
                            (args.clone(), None)
                        }
                    };

                    // Hooks may replace the complete input, so normalize and
                    // validate only after applying their result.
                    let (args, rewrote_empty_bash) =
                        normalize_post_hook_tool_args(&tool_name, args);
                    if rewrote_empty_bash {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message:
                                "Received empty bash tool call; auto-filled command as \"pwd\" to proceed."
                                    .to_string(),
                        });
                    }
                    let missing = self.tool_executor.missing_required(&tool_name, &args);
                    if !missing.is_empty() {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id.clone(),
                            content: format!(
                                "Missing required fields for tool '{}': {}",
                                tool_name,
                                missing.join(", ")
                            ),
                            is_error: Some(true),
                        });
                        continue;
                    }

                    let safe_args = self.credential_vault.vault_in_json(&args);
                    let resolved_args =
                        tool_args_for_execution(&tool_name, &safe_args, &self.credential_vault);

                    // Ask the registered extensions whether this call runs.
                    // The `doom-loop` tenant answers with the doom-loop and
                    // rate-limit verdicts this branch used to read directly.
                    match self.plan_tool_call_through_extensions(&call_id, &tool_name, &safe_args) {
                        ExtensionVerdict::Proceed => {
                            // Proceed with tool execution
                        }
                        ExtensionVerdict::Block { reason } => {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: reason.clone(),
                                fatal: false,
                                terminal: false,
                                retryable: false,
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: reason,
                                is_error: Some(true),
                            });
                            continue;
                        }
                        ExtensionVerdict::Steer { message } => {
                            // The tool does not run, but the model is told why
                            // in a result it is not meant to read as a failure.
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let _ = self.event_tx.send(FromAgent::Status {
                                message: message.clone(),
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: message,
                                is_error: Some(false),
                            });
                            continue;
                        }
                    }

                    let workflow_snapshot = self.workflow_state.snapshot();
                    // Ensure MCP annotations are loaded before firewall check
                    if self.tool_executor.is_mcp_tool(&tool_key) {
                        if let Err(error) = self.tool_executor.ensure_mcp_annotations().await {
                            self.tool_executor.report_diagnostic(format!(
                                "[agent] failed to refresh MCP annotations for {tool_key}: {error}"
                            ));
                        }
                    }
                    let is_external_tool = self.external_tools.contains(&tool_key);
                    let annotations = self.tool_executor.tool_annotations(&tool_key);
                    let firewall_verdict = if is_external_tool {
                        // The caller owns execution and applies its own sandbox and approval
                        // policy. The native firewall only governs native executors.
                        NativeFirewallVerdict::Allow
                    } else {
                        self.tool_executor.firewall_verdict(
                            &tool_key,
                            &args,
                            &workflow_snapshot,
                            annotations.as_ref(),
                            false,
                        )
                    };
                    if let NativeFirewallVerdict::Block { reason } = &firewall_verdict {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: reason.clone(),
                            fatal: false,
                            terminal: false,
                            retryable: false,
                        });
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            content: format!("Tool blocked by action firewall: {reason}"),
                            is_error: Some(true),
                        });
                        continue;
                    }

                    // Check if this tool requires approval. This is the ONE
                    // decision point for whether the runner executes inline
                    // below -- see `tool_requires_approval`'s doc comment.
                    let approval_decision = tool_requires_approval(
                        self.config.approval_mode,
                        is_external_tool,
                        &firewall_verdict,
                        &self.tool_executor,
                        &tool_name,
                        &args,
                        &self.denial_memory,
                    );
                    // The user already refused this exact call in this turn.
                    // Answer from that decision instead of asking again.
                    if approval_decision.is_repeat_refusal() {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        let message = repeat_refusal_message(&tool_name);
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            content: message,
                            is_error: Some(true),
                        });
                        continue;
                    }
                    let requires_approval = approval_decision.requires_approval();

                    // `PermissionRequest` hooks are documented to run when a
                    // tool needs approval (docs/design/HOOKS_SYSTEM.md). This is
                    // the one place that decides that, so it is the only place
                    // the hook can run without disagreeing with the decision.
                    // A `Block` denies the call outright and the user is never
                    // asked; every other result falls through to the normal
                    // approval path, because an approval gate has nothing to do
                    // with modified input or injected context.
                    if requires_approval {
                        let permission = self
                            .hooks
                            .hook_permission_request(
                                &tool_name,
                                &call_id,
                                &args,
                                "tool requires approval",
                            )
                            .await;
                        if let NativeHookResult::Block { reason } = permission {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let message = format!("Tool denied by permission hook: {reason}");
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: message.clone(),
                                fatal: false,
                                terminal: false,
                                retryable: false,
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: message,
                                is_error: Some(true),
                            });
                            continue;
                        }
                    }

                    let can_parallelize_read_only = is_native_parallel_read_only_tool_call(
                        &tool_key,
                        requires_approval,
                        annotations.as_ref(),
                        is_explicit_inline_read_only_tool(&tool_key, &self.tool_executor),
                    );

                    if !can_parallelize_read_only {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                    }

                    let deferred_disposition = deferred_tool_call_disposition(
                        requires_approval,
                        !deferred_tool_calls.is_empty(),
                    );
                    if deferred_disposition == Some(DeferredToolCallDisposition::AwaitApproval) {
                        // Defer the wait for the user's decision: emit every
                        // ToolCall event in this batch before awaiting any
                        // decisions so the UI can present one batched modal
                        // (#3085). Capture execution context before publishing
                        // it, then carry that same snapshot to both the UI and
                        // the execution-boundary comparison.
                        let approval_inline_env =
                            self.tool_executor.inline_tool_approval_context(&tool_name);
                        let call = ToolCallContext {
                            call_id,
                            tool_name,
                            args,
                            safe_args,
                            extra_context,
                            pre_hook_args,
                            initial_firewall_verdict: firewall_verdict,
                            approval_inline_env,
                        };
                        let _ = self.event_tx.send(deferred_tool_call_event(&call, true));
                        deferred_tool_calls.push(DeferredToolCall::AwaitApproval(call));
                        continue;
                    }

                    if deferred_disposition == Some(DeferredToolCallDisposition::Execute) {
                        // Preserve the model's tool-call order after an
                        // approval boundary. Delay this auto-approved call's
                        // ToolCall event until its refreshed PreToolUse input
                        // is known, so the emitted and executed inputs match.
                        deferred_tool_calls.push(DeferredToolCall::Execute(ToolCallContext {
                            call_id,
                            tool_name,
                            args,
                            safe_args,
                            extra_context,
                            pre_hook_args,
                            initial_firewall_verdict: firewall_verdict,
                            approval_inline_env: None,
                        }));
                        continue;
                    }

                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: tool_name.clone(),
                        args: safe_args.clone(),
                        requires_approval,
                        approval_inline_env: None,
                    });

                    if can_parallelize_read_only {
                        pending_read_only_tool_calls.push(QueuedReadOnlyToolExecution {
                            call_id,
                            tool_name,
                            args: safe_args.clone(),
                            safe_args,
                            resolved_args,
                            extra_context,
                        });
                        continue;
                    }

                    // Auto-approved, execute immediately
                    // Note: ToolExecutor sends ToolStart/ToolEnd events internally
                    let result = {
                        let resolved_args =
                            tool_args_for_execution(&tool_name, &safe_args, &self.credential_vault);
                        self.execute_tool(&tool_name, &resolved_args, &call_id, None)
                            .await
                    };
                    let tool_name_for_cache = tool_name.clone();
                    let call = ToolCallContext {
                        call_id,
                        tool_name,
                        args,
                        safe_args,
                        extra_context,
                        pre_hook_args,
                        initial_firewall_verdict: firewall_verdict,
                        approval_inline_env: None,
                    };
                    let result_block = self
                        .finalize_tool_call_result(call, true, Some(result))
                        .await;
                    tool_results.push(result_block);
                    // Serial tools may mutate state through bash, inline, MCP,
                    // or external execution. Reads that follow in this model
                    // batch must not reuse entries cached before that call.
                    invalidate_cache_after_serial_tool(
                        &self.tool_executor,
                        &tool_name_for_cache,
                        true,
                    );
                }

                self.drain_read_only_tool_calls(
                    &mut pending_read_only_tool_calls,
                    &mut tool_results,
                )
                .await?;

                // Every ToolCall event in this batch has been emitted. Now
                // execute the deferred suffix in model order, awaiting gated
                // decisions in FIFO order. Responses that arrive out of order
                // are stashed by wait_for_tool_response until their turn.
                let mut deferred_tool_calls_iter =
                    std::mem::take(&mut deferred_tool_calls).into_iter();
                if self.take_active_operation_interruption() {
                    let cancelled_ids = cancel_deferred_suffix(
                        &self.event_tx,
                        deferred_tool_calls_iter.by_ref(),
                        &mut tool_results,
                        self.tool_executor.managed_policy_metadata(),
                    );
                    self.tool_response_coordinator
                        .discard_cancelled(&cancelled_ids);
                }
                while let Some(deferred_call) = deferred_tool_calls_iter.next() {
                    match deferred_call {
                        DeferredToolCall::AwaitApproval(mut call) => {
                            let approval_cancel = self.shutdown_token.child_token();
                            self.set_active_approval_cancel_token(Some(approval_cancel.clone()));
                            let approval_started = Instant::now();
                            let approval = approval_span();
                            let response = self
                                .tool_response_coordinator
                                .wait_for_tool_response(&call.call_id, &approval_cancel)
                                .instrument(approval.clone())
                                .await;
                            self.set_active_approval_cancel_token(None);
                            let (approval_outcome, approval_error) = match &response {
                                ToolResponseWait::Response((approved, _, _)) if *approved => {
                                    ("approved", None)
                                }
                                ToolResponseWait::Response(_) => {
                                    ("denied", Some("approval_denied"))
                                }
                                ToolResponseWait::Cancelled => {
                                    ("cancelled", Some("approval_cancelled"))
                                }
                                ToolResponseWait::Closed => {
                                    ("closed", Some("approval_channel_closed"))
                                }
                            };
                            record_outcome(
                                &approval,
                                approval_outcome,
                                approval_started.elapsed(),
                                approval_error,
                            );
                            let (approved, result, source) = match response {
                                ToolResponseWait::Response(response) => response,
                                ToolResponseWait::Cancelled => {
                                    self.take_active_operation_interruption();
                                    let skipped_message = "Skipped after request cancellation.";
                                    let _ = self.event_tx.send(FromAgent::ToolOutput {
                                        call_id: call.call_id.clone(),
                                        content: skipped_message.to_string(),
                                    });
                                    let mut cancelled_ids = HashSet::from([call.call_id.clone()]);
                                    let (event, result_block) = cancelled_deferred_tool(
                                        &call,
                                        skipped_message,
                                        self.tool_executor.managed_policy_metadata(),
                                    );
                                    let _ = self.event_tx.send(event);
                                    tool_results.push(result_block);
                                    cancelled_ids.extend(cancel_deferred_suffix(
                                        &self.event_tx,
                                        deferred_tool_calls_iter.by_ref(),
                                        &mut tool_results,
                                        self.tool_executor.managed_policy_metadata(),
                                    ));
                                    self.tool_response_coordinator
                                        .discard_cancelled(&cancelled_ids);
                                    break;
                                }
                                ToolResponseWait::Closed => {
                                    return Err(closed_tool_response_failure(&call.call_id));
                                }
                            };
                            if approved && result.is_none() {
                                let (args, extra_context) =
                                    match rerun_deferred_pre_tool_use(&self.hooks, &call).await {
                                        Ok(result) => result,
                                        Err(reason) => {
                                            let (events, result_block) = deferred_hook_block(
                                                &call,
                                                reason,
                                                false,
                                                self.tool_executor.managed_policy_metadata(),
                                            );
                                            for event in events {
                                                let _ = self.event_tx.send(event);
                                            }
                                            tool_results.push(result_block);
                                            if self.cancel_remaining_deferred_if_interrupted(
                                                &mut deferred_tool_calls_iter,
                                                &mut tool_results,
                                            ) {
                                                break;
                                            }
                                            continue;
                                        }
                                    };
                                let (args, rewrote_empty_bash) =
                                    normalize_post_hook_tool_args(&call.tool_name, args);
                                if rewrote_empty_bash {
                                    let _ = self.event_tx.send(FromAgent::Status {
                                        message:
                                            "Received empty bash tool call; auto-filled command as \"pwd\" to proceed."
                                                .to_string(),
                                    });
                                }
                                let missing =
                                    self.tool_executor.missing_required(&call.tool_name, &args);
                                if !missing.is_empty() {
                                    let reason = format!(
                                        "Missing required fields for tool '{}': {}",
                                        call.tool_name,
                                        missing.join(", ")
                                    );
                                    emit_deferred_failure(
                                        &self.event_tx,
                                        &call,
                                        &reason,
                                        &mut tool_results,
                                        self.tool_executor.managed_policy_metadata(),
                                    );
                                    if self.cancel_remaining_deferred_if_interrupted(
                                        &mut deferred_tool_calls_iter,
                                        &mut tool_results,
                                    ) {
                                        break;
                                    }
                                    continue;
                                }
                                if let Some(reason) =
                                    approved_input_change_rejection(&call.args, &args)
                                {
                                    emit_deferred_failure(
                                        &self.event_tx,
                                        &call,
                                        reason,
                                        &mut tool_results,
                                        self.tool_executor.managed_policy_metadata(),
                                    );
                                    if self.cancel_remaining_deferred_if_interrupted(
                                        &mut deferred_tool_calls_iter,
                                        &mut tool_results,
                                    ) {
                                        break;
                                    }
                                    continue;
                                }
                                call.args = args;
                                call.safe_args = self.credential_vault.vault_in_json(&call.args);
                                call.extra_context = extra_context;

                                let tool_key = call.tool_name.to_lowercase();
                                if self.tool_executor.is_mcp_tool(&tool_key) {
                                    let _ = self.tool_executor.ensure_mcp_annotations().await;
                                }
                                let is_external_tool = self.external_tools.contains(&tool_key);
                                let annotations = self.tool_executor.tool_annotations(&tool_key);
                                let workflow_snapshot = self.workflow_state.snapshot();
                                let firewall_verdict = deferred_firewall_verdict(
                                    &self.tool_executor,
                                    &tool_key,
                                    &call.args,
                                    &workflow_snapshot,
                                    annotations.as_ref(),
                                    is_external_tool,
                                );
                                let policy_rejection = deferred_approved_policy_rejection(
                                    &call.initial_firewall_verdict,
                                    firewall_verdict,
                                );
                                if let Some(reason) = policy_rejection {
                                    emit_deferred_policy_failure(
                                        &self.event_tx,
                                        &call,
                                        &reason,
                                        &mut tool_results,
                                        self.tool_executor.managed_policy_metadata(),
                                    );
                                    if self.cancel_remaining_deferred_if_interrupted(
                                        &mut deferred_tool_calls_iter,
                                        &mut tool_results,
                                    ) {
                                        break;
                                    }
                                    continue;
                                }
                                if let Some(approved_context) = &call.approval_inline_env {
                                    let current_env = self
                                        .tool_executor
                                        .inline_tool_approval_context(&tool_key)
                                        .map(|context| context.environment);
                                    if let Some(reason) = approved_inline_env_change_rejection(
                                        Some(&approved_context.environment),
                                        current_env.as_ref(),
                                    ) {
                                        emit_deferred_failure(
                                            &self.event_tx,
                                            &call,
                                            reason,
                                            &mut tool_results,
                                            self.tool_executor.managed_policy_metadata(),
                                        );
                                        if self.cancel_remaining_deferred_if_interrupted(
                                            &mut deferred_tool_calls_iter,
                                            &mut tool_results,
                                        ) {
                                            break;
                                        }
                                        continue;
                                    }
                                }
                                let deferred_verdict = self.plan_tool_call_through_extensions(
                                    &call.call_id,
                                    &call.tool_name,
                                    &call.safe_args,
                                );
                                match deferred_verdict {
                                    ExtensionVerdict::Proceed => {}
                                    ExtensionVerdict::Block { reason }
                                    | ExtensionVerdict::Steer { message: reason } => {
                                        // The call was already announced to the
                                        // UI as running, so a steer is reported
                                        // the same way a block is.
                                        emit_deferred_failure(
                                            &self.event_tx,
                                            &call,
                                            &reason,
                                            &mut tool_results,
                                            self.tool_executor.managed_policy_metadata(),
                                        );
                                        if self.cancel_remaining_deferred_if_interrupted(
                                            &mut deferred_tool_calls_iter,
                                            &mut tool_results,
                                        ) {
                                            break;
                                        }
                                        continue;
                                    }
                                }
                            }
                            let result = if approved {
                                // `source` is whatever the responder on the
                                // other end of the tool-response channel
                                // actually sent (the TUI approval dialog sends
                                // `ExecutionSource::Native`; a headless/remote
                                // client sends `RemoteClient`) -- never
                                // hardcoded here, so a locally-approved
                                // batched tool call is not mislabeled as
                                // remote-originated.
                                result.map(|result| {
                                    ToolExecution::from_legacy(
                                        &call.call_id,
                                        &call.tool_name,
                                        source,
                                        result,
                                    )
                                    .with_managed_policy(
                                        self.tool_executor.managed_policy_metadata(),
                                    )
                                })
                            } else {
                                Some(
                                    ToolExecution::denied(
                                        &call.call_id,
                                        &call.tool_name,
                                        DenialReason::User,
                                    )
                                    .with_managed_policy(
                                        self.tool_executor.managed_policy_metadata(),
                                    ),
                                )
                            };
                            let tool_name_for_cache = call.tool_name.clone();
                            let result_block =
                                self.finalize_tool_call_result(call, approved, result).await;
                            tool_results.push(result_block);
                            invalidate_cache_after_serial_tool(
                                &self.tool_executor,
                                &tool_name_for_cache,
                                approved,
                            );
                        }
                        DeferredToolCall::Execute(mut call) => {
                            // PreToolUse may depend on filesystem or workflow
                            // state changed by an earlier approved mutation.
                            // Re-run it at the actual execution boundary using
                            // the original model input, then rebuild every
                            // derived argument form from that fresh decision.
                            let (args, extra_context) =
                                match rerun_deferred_pre_tool_use(&self.hooks, &call).await {
                                    Ok(result) => result,
                                    Err(reason) => {
                                        let (events, result_block) = deferred_hook_block(
                                            &call,
                                            reason,
                                            true,
                                            self.tool_executor.managed_policy_metadata(),
                                        );
                                        for event in events {
                                            let _ = self.event_tx.send(event);
                                        }
                                        tool_results.push(result_block);
                                        if self.cancel_remaining_deferred_if_interrupted(
                                            &mut deferred_tool_calls_iter,
                                            &mut tool_results,
                                        ) {
                                            break;
                                        }
                                        continue;
                                    }
                                };
                            let (args, rewrote_empty_bash) =
                                normalize_post_hook_tool_args(&call.tool_name, args);
                            if rewrote_empty_bash {
                                let _ = self.event_tx.send(FromAgent::Status {
                                    message:
                                        "Received empty bash tool call; auto-filled command as \"pwd\" to proceed."
                                            .to_string(),
                                });
                            }
                            let missing =
                                self.tool_executor.missing_required(&call.tool_name, &args);
                            if !missing.is_empty() {
                                let reason = format!(
                                    "Missing required fields for tool '{}': {}",
                                    call.tool_name,
                                    missing.join(", ")
                                );
                                let _ = self.event_tx.send(deferred_tool_call_event(&call, false));
                                let _ = self
                                    .event_tx
                                    .send(deferred_rejection_output_event(&call, &reason));
                                let _ = self.event_tx.send(deferred_safety_rejection_event(
                                    &call,
                                    &reason,
                                    self.tool_executor.managed_policy_metadata(),
                                ));
                                tool_results.push(ContentBlock::ToolResult {
                                    tool_use_id: call.call_id.clone(),
                                    content: reason,
                                    is_error: Some(true),
                                });
                                if self.cancel_remaining_deferred_if_interrupted(
                                    &mut deferred_tool_calls_iter,
                                    &mut tool_results,
                                ) {
                                    break;
                                }
                                continue;
                            }
                            call.args = args;
                            call.safe_args = self.credential_vault.vault_in_json(&call.args);
                            call.extra_context = extra_context;

                            // Earlier calls may have changed workflow state
                            // after this call's initial classification. Re-run
                            // the full firewall/approval gate against the
                            // current snapshot before allowing execution.
                            let tool_key = call.tool_name.to_lowercase();
                            if self.tool_executor.is_mcp_tool(&tool_key) {
                                let _ = self.tool_executor.ensure_mcp_annotations().await;
                            }
                            let is_external_tool = self.external_tools.contains(&tool_key);
                            let annotations = self.tool_executor.tool_annotations(&tool_key);
                            let workflow_snapshot = self.workflow_state.snapshot();
                            let firewall_verdict = deferred_firewall_verdict(
                                &self.tool_executor,
                                &tool_key,
                                &call.args,
                                &workflow_snapshot,
                                annotations.as_ref(),
                                is_external_tool,
                            );
                            let deferred_policy_rejection = match &firewall_verdict {
                                NativeFirewallVerdict::Block { reason } => Some(reason.clone()),
                                NativeFirewallVerdict::RequireApproval { reason } => Some(format!(
                                    "Tool now requires approval after earlier tool execution: {reason}"
                                )),
                                NativeFirewallVerdict::Allow => match tool_requires_approval(
                                    self.config.approval_mode,
                                    is_external_tool,
                                    &firewall_verdict,
                                    &self.tool_executor,
                                    &tool_key,
                                    &call.args,
                                    &self.denial_memory,
                                ) {
                                    ApprovalDecision::NotRequired => None,
                                    ApprovalDecision::Required => Some(
                                        "Tool now requires approval after earlier tool execution"
                                            .to_string(),
                                    ),
                                    ApprovalDecision::RefusedEarlierThisTurn => {
                                        Some(repeat_refusal_message(&tool_key))
                                    }
                                },
                            };
                            let deferred_requires_approval = matches!(
                                firewall_verdict,
                                NativeFirewallVerdict::RequireApproval { .. }
                            ) || tool_requires_approval(
                                self.config.approval_mode,
                                is_external_tool,
                                &firewall_verdict,
                                &self.tool_executor,
                                &tool_key,
                                &call.args,
                                &self.denial_memory,
                            )
                            .requires_approval();
                            let _ = self
                                .event_tx
                                .send(deferred_tool_call_event(&call, deferred_requires_approval));
                            let mut rejected = false;
                            if let Some(reason) = deferred_policy_rejection {
                                let _ = self
                                    .event_tx
                                    .send(deferred_rejection_output_event(&call, &reason));
                                let _ = self.event_tx.send(deferred_policy_rejection_event(
                                    &call,
                                    &reason,
                                    self.tool_executor.managed_policy_metadata(),
                                ));
                                tool_results.push(ContentBlock::ToolResult {
                                    tool_use_id: call.call_id.clone(),
                                    content: reason,
                                    is_error: Some(true),
                                });
                                rejected = true;
                            }

                            // Calls after an approval boundary were initially
                            // checked before earlier calls were recorded.
                            // Re-check against the now-current safety history
                            // so a deferred suffix cannot bypass doom-loop or
                            // rate-limit enforcement.
                            let extension_verdict = if rejected {
                                None
                            } else {
                                Some(self.plan_tool_call_through_extensions(
                                    &call.call_id,
                                    &call.tool_name,
                                    &call.safe_args,
                                ))
                            };
                            match extension_verdict {
                                None | Some(ExtensionVerdict::Proceed) => {}
                                Some(
                                    ExtensionVerdict::Block { reason }
                                    | ExtensionVerdict::Steer { message: reason },
                                ) => {
                                    let _ = self
                                        .event_tx
                                        .send(deferred_rejection_output_event(&call, &reason));
                                    let _ = self.event_tx.send(deferred_safety_rejection_event(
                                        &call,
                                        &reason,
                                        self.tool_executor.managed_policy_metadata(),
                                    ));
                                    tool_results.push(ContentBlock::ToolResult {
                                        tool_use_id: call.call_id.clone(),
                                        content: reason,
                                        is_error: Some(true),
                                    });
                                    rejected = true;
                                }
                            }
                            if !rejected {
                                let resolved_args = tool_args_for_execution(
                                    &call.tool_name,
                                    &call.safe_args,
                                    &self.credential_vault,
                                );
                                let result = self
                                    .execute_tool(
                                        &call.tool_name,
                                        &resolved_args,
                                        &call.call_id,
                                        None,
                                    )
                                    .await;
                                let tool_name_for_cache = call.tool_name.clone();
                                let result_block = self
                                    .finalize_tool_call_result(call, true, Some(result))
                                    .await;
                                tool_results.push(result_block);
                                invalidate_cache_after_serial_tool(
                                    &self.tool_executor,
                                    &tool_name_for_cache,
                                    true,
                                );
                            }
                        }
                    }

                    // Ctrl+C during a deferred tool cancels that execution
                    // directly so its subprocess can finish cleanup. Stop the
                    // ordered suffix here; drain_pending_commands below will
                    // consume the queued Cancel and close the turn.
                    if self.take_active_operation_interruption() {
                        let cancelled_ids = cancel_deferred_suffix(
                            &self.event_tx,
                            deferred_tool_calls_iter.by_ref(),
                            &mut tool_results,
                            self.tool_executor.managed_policy_metadata(),
                        );
                        self.tool_response_coordinator
                            .discard_cancelled(&cancelled_ids);
                        break;
                    }
                }

                if deferred_steering.is_empty() {
                    if self.drain_pending_commands().await {
                        if !tool_results.is_empty() {
                            self.messages_mut().push(Message {
                                role: Role::User,
                                content: MessageContent::Blocks(std::mem::take(&mut tool_results)),
                            });
                        }
                        self.repair_orphaned_tool_calls();
                        return Err(anyhow::anyhow!("Request cancelled"));
                    }
                    deferred_steering = self.dequeue_next_turn_messages(false);
                }

                if !deferred_steering.is_empty() {
                    for (call_id, tool_name, args, _parse_error) in remaining_tool_calls {
                        let skipped_message = "Skipped due to queued user message.".to_string();
                        let _ = self.event_tx.send(FromAgent::ToolCall {
                            call_id: call_id.clone(),
                            tool: tool_name.clone(),
                            args: self.credential_vault.vault_in_json(&args),
                            requires_approval: false,
                            approval_inline_env: None,
                        });
                        let _ = self.event_tx.send(FromAgent::ToolOutput {
                            call_id: call_id.clone(),
                            content: skipped_message.clone(),
                        });
                        let _ = self.event_tx.send(FromAgent::ToolEnd {
                            call_id: call_id.clone(),
                            success: false,
                            result: Some(ToolResult::failure(skipped_message.clone())),
                            receipt: Some(
                                ToolExecution::cancelled(
                                    &call_id,
                                    &tool_name,
                                    ExecutionSource::Native,
                                    ExecutionPhase::Queued,
                                )
                                .with_managed_policy(self.tool_executor.managed_policy_metadata())
                                .receipt,
                            ),
                        });
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            content: skipped_message,
                            is_error: Some(true),
                        });
                    }
                }

                // The batch is complete. Extensions see it before it becomes
                // history, with the last result as the mutable payload.
                // Reminder decisions use the unmutated outcomes so an extension
                // edit cannot hide a consecutive failure or an open todo list.
                let outcomes = self.tool_outcomes_for_batch(&tool_results);
                self.apply_tool_batch_end_extensions(&mut tool_results);
                if let Some(reminder) = reminders.observe_batch(&outcomes) {
                    append_reminder_to_last_tool_result(&mut tool_results, &reminder);
                }

                // Add tool results to history
                self.messages_mut().push(Message {
                    role: Role::User,
                    content: MessageContent::Blocks(tool_results),
                });
                if self.finish_tool_batch() || self.drain_pending_commands().await {
                    self.repair_orphaned_tool_calls();
                    return Err(anyhow::anyhow!("Request cancelled"));
                }

                if !deferred_steering.is_empty() {
                    self.workflow_state.reset();
                    self.announce_next_turn_messages(&deferred_steering);
                    if self
                        .append_pending_messages_for_turn(deferred_steering)
                        .await?
                    {
                        begin_queued_user_turn(
                            &mut reminders,
                            &mut self.denial_memory,
                            step_budget,
                        );
                        continue 'turn;
                    }
                }

                // Continue the loop to process the tool results
                continue 'turn;
            }

            // No tool calls, we're done
            // Check for auto-compaction before the next turn
            if let Some(result) = prepared_compaction {
                if result.was_compacted() {
                    let split_note = if result.was_turn_split() {
                        " (turn was split)"
                    } else {
                        ""
                    };
                    eprintln!(
                        "[agent] Auto-compacted {} messages{}",
                        result.compacted_count, split_note
                    );

                    // Notify the UI about auto-compaction
                    let status_msg = if let Some(ref cut_point) = result.cut_point {
                        format!(
                            "Auto-compacted: {} messages summarized (~{} → ~{} tokens){}",
                            result.compacted_count,
                            cut_point.tokens_before,
                            cut_point.tokens_after,
                            split_note
                        )
                    } else {
                        format!(
                            "Auto-compacted: {} messages summarized",
                            result.compacted_count
                        )
                    };
                    emit_compaction_event(
                        &self.event_tx,
                        &self.messages,
                        result.summary.as_deref().unwrap_or(&status_msg),
                        result.cut_point.as_ref(),
                        result.continuation.as_ref(),
                        true,
                    );
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: status_msg,
                    });
                    self.messages = Arc::new(result.messages);
                    self.prepare_compacted_checkpoint(&config)?;
                    self.emit_conversation_snapshot();
                }
            }

            if self.drain_pending_commands().await {
                return Err(anyhow::anyhow!("Request cancelled"));
            }

            self.run_queued_side_questions().await;

            let mut next_turn_messages = self.dequeue_next_turn_messages(true);
            while !next_turn_messages.is_empty() {
                self.workflow_state.reset();
                self.announce_next_turn_messages(&next_turn_messages);
                if self
                    .append_pending_messages_for_turn(next_turn_messages)
                    .await?
                {
                    begin_queued_user_turn(&mut reminders, &mut self.denial_memory, step_budget);
                    continue 'turn;
                }
                next_turn_messages = self.dequeue_next_turn_messages(true);
            }

            break;
        }

        Ok(())
    }

    fn execute_tool_search(&mut self, args: &Value, call_id: &str) -> ToolExecution {
        let emit = |execution: &ToolExecution| {
            let _ = self.event_tx.send(FromAgent::ToolStart {
                call_id: call_id.to_string(),
            });
            let result = execution.to_legacy();
            if !result.output.is_empty() {
                let _ = self.event_tx.send(FromAgent::ToolOutput {
                    call_id: call_id.to_string(),
                    content: result.output.clone(),
                });
            }
            let _ = self.event_tx.send(FromAgent::ToolEnd {
                call_id: call_id.to_string(),
                success: result.success,
                result: Some(result),
                receipt: Some(execution.receipt.clone()),
            });
        };

        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let exact_names = args
            .get("names")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if query.is_empty() && exact_names.is_empty() {
            let execution = ToolExecution::from_legacy(
                call_id,
                "tool_search",
                ExecutionSource::Native,
                ToolResult::failure("tool_search requires query or names"),
            )
            .with_managed_policy(self.tool_executor.managed_policy_metadata());
            emit(&execution);
            return execution;
        }

        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut candidates = self
            .tools
            .iter()
            .filter_map(|(name, definition)| {
                let name_lower = name.to_ascii_lowercase();
                if name_lower == "tool_search"
                    || self.tool_executor.is_reserved_tool(name)
                    || !tool_search_profile_allows(
                        self.tool_profile,
                        name,
                        &self.explicitly_allowed_tools,
                    )
                    || !tool_is_visible_to_model(
                        name,
                        self.goal_tools_visible,
                        self.include_ide_tools,
                    )
                {
                    return None;
                }
                let description = definition.tool.description.to_ascii_lowercase();
                let exact = exact_names.contains(&name_lower);
                let mut score = if exact { 1_000 } else { 0 };
                for term in &terms {
                    if name_lower.contains(term) {
                        score += 50;
                    }
                    if description.contains(term) {
                        score += 10;
                    }
                }
                (score > 0).then_some((score, name_lower, definition.tool.description.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_unstable_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));

        let max_results = args
            .get("maxResults")
            .and_then(Value::as_u64)
            .map_or(8, |value| value.clamp(1, 16) as usize);
        let selected = candidates.into_iter().take(max_results).collect::<Vec<_>>();
        if selected.is_empty() {
            let execution = ToolExecution::from_legacy(
                call_id,
                "tool_search",
                ExecutionSource::Native,
                ToolResult::failure(format!("No tools matched `{query}`")),
            )
            .with_managed_policy(self.tool_executor.managed_policy_metadata());
            emit(&execution);
            return execution;
        }

        let mut activated = Vec::new();
        let mut lines = Vec::with_capacity(selected.len() + 1);
        lines.push("Activated tools for the next turn:".to_string());
        for (_, name, description) in selected {
            if self.active_tool_names.insert(name.clone()) {
                activated.push(name.clone());
            }
            lines.push(format!("- {name}: {description}"));
        }
        if !activated.is_empty() {
            self.model_tool_cache = None;
            self.refresh_runtime_audit();
        }
        let result = ToolResult::success(lines.join("\n")).with_details(json!({
            "activated": activated,
            "nextTurn": true,
        }));
        let execution =
            ToolExecution::from_legacy(call_id, "tool_search", ExecutionSource::Native, result)
                .with_managed_policy(self.tool_executor.managed_policy_metadata());
        emit(&execution);
        execution
    }

    /// Execute a tool using the `ToolExecutor`
    async fn execute_tool(
        &mut self,
        tool_name: &str,
        args: &serde_json::Value,
        call_id: &str,
        approved_inline_env: Option<&HashMap<String, String>>,
    ) -> ToolExecution {
        if tool_name.eq_ignore_ascii_case("spawn_subagent") {
            let mut parent_record = super::compaction::build_continuation_record(&self.messages);
            if let Some(previous) = &self.semantic_continuation {
                parent_record.merge_previous(previous);
            }
            self.tool_executor
                .set_subagent_parent_requests(parent_record.user_requests);
        }
        let started = Instant::now();
        let span = tool_span_for_call(tool_name, Some(call_id));
        if tool_name.eq_ignore_ascii_case("tool_search") {
            let execution = span.in_scope(|| self.execute_tool_search(args, call_id));
            record_outcome(
                &span,
                if execution.is_error() {
                    "error"
                } else {
                    "success"
                },
                started.elapsed(),
                execution.is_error().then_some("tool_error"),
            );
            return execution;
        }

        let cancel = self.shutdown_token.child_token();
        let terminal_drain_required =
            native_tool_requires_terminal_drain(&self.tool_executor, tool_name, args);
        self.set_active_tool_cancel_token(Some(cancel.clone()), terminal_drain_required);
        // Timed here because this is the one place the runner owns a single
        // tool's execution. `ExecutionReceipt::duration_ms` had no producer, so
        // the documented `durationMs` hook field could never be populated.
        let execution = self
            .tool_executor
            .execute_tool(
                tool_name,
                args,
                Some(&self.event_tx),
                call_id,
                NativeToolExecutionOptions {
                    cancel,
                    approved_inline_env,
                },
            )
            .instrument(span.clone())
            .await;
        let execution = self
            .tool_executor
            .with_managed_policy(execution.with_duration(started.elapsed().as_millis() as u64));
        self.set_active_tool_cancel_token(None, false);
        // Direct Codex/native dispatch does not pass through the main turn's
        // serial-tool boundary. Keep the warm executor honest after a Bash,
        // inline, MCP, or other side-effecting call from that path too.
        invalidate_cache_after_serial_tool(&self.tool_executor, tool_name, true);
        if tool_name.eq_ignore_ascii_case("update_goal")
            && execution.receipt.source == ExecutionSource::Native
        {
            if let Some(visible) = goal_tools_visible_from_execution(&execution) {
                self.set_goal_tools_visible(visible);
            }
        }
        record_outcome(
            &span,
            if execution.is_error() {
                "error"
            } else {
                "success"
            },
            started.elapsed(),
            execution.is_error().then_some("tool_error"),
        );
        execution
    }

    /// Build the model result for a decided tool call. Approved local tools
    /// without a result execute here; caller-owned tools fail without one.
    /// Post-execution hooks and bookkeeping only observe supplied results or
    /// local execution.
    async fn finalize_tool_call_result(
        &mut self,
        call: ToolCallContext,
        approved: bool,
        result: Option<ToolExecution>,
    ) -> ContentBlock {
        let ToolCallContext {
            call_id,
            tool_name,
            args,
            safe_args,
            extra_context,
            pre_hook_args: _,
            initial_firewall_verdict: _,
            approval_inline_env,
        } = call;
        if !approved {
            // The user's refusal is remembered for the rest of this turn, so
            // an identical retry is answered without prompting again.
            self.denial_memory.record(&tool_name, &args);
        }
        let mut result = result;
        let caller_owns_execution = approved
            && result.is_none()
            && self
                .external_tools
                .contains(&tool_name.to_ascii_lowercase());
        if caller_owns_execution {
            // A caller-owned approval without a result is a failed handoff.
            // Surface that failure to the model without treating it as a
            // locally executed tool: post-execution hooks, workflow updates,
            // and result extensions must only observe real execution.
            let result = ToolExecution::from_legacy(
                &call_id,
                &tool_name,
                ExecutionSource::RemoteClient,
                ToolResult::failure("Tool task did not return a result"),
            )
            .with_managed_policy(self.tool_executor.managed_policy_metadata());
            let session_id = self.hooks.hook_session_id().await;
            let spill_dir = model_tool_spill_dir_for_active_tools(
                Some(&self.tool_executor),
                &self.active_tool_names,
                &self.config.cwd,
                session_id.as_deref(),
                self.owns_persistent_tool_spills,
            );
            let content = self.tool_executor.clamp_tool_output(
                &result.model_content(),
                &tool_name,
                spill_dir.as_deref(),
            );
            return ContentBlock::ToolResult {
                tool_use_id: call_id,
                content: content.content,
                is_error: Some(true),
            };
        }
        if approved && result.is_none() {
            let resolved_args =
                tool_args_for_execution(&tool_name, &safe_args, &self.credential_vault);
            let approved_environment = approval_inline_env
                .as_ref()
                .map(|context| &context.environment);
            result = Some(
                self.execute_tool(&tool_name, &resolved_args, &call_id, approved_environment)
                    .await,
            );
        }

        let result = result.unwrap_or_else(|| {
            if approved {
                ToolExecution::from_legacy(
                    &call_id,
                    &tool_name,
                    ExecutionSource::Native,
                    ToolResult::failure("Tool task did not return a result"),
                )
                .with_managed_policy(self.tool_executor.managed_policy_metadata())
            } else {
                ToolExecution::denied(&call_id, &tool_name, DenialReason::User)
                    .with_managed_policy(self.tool_executor.managed_policy_metadata())
            }
        });

        // Model-facing bound. The renderer clamp in `tool_output` never
        // covered this path, so a single large tool result went into
        // conversation history verbatim. Spill above 40 KB, sanitize control
        // characters (NUL included) on every result.
        let session_id = self.hooks.hook_session_id().await;
        let spill_dir = model_tool_spill_dir_for_active_tools(
            Some(&self.tool_executor),
            &self.active_tool_names,
            &self.config.cwd,
            session_id.as_deref(),
            self.owns_persistent_tool_spills,
        );
        let content = self.tool_executor.clamp_tool_output(
            &result.model_content(),
            &tool_name,
            spill_dir.as_deref(),
        );
        let is_error = result.is_error();

        // Bash bounds its own model projection before the outer clamp runs.
        // Retain its original capture, not just a possible spill of that tail.
        let captured_path = match &result.receipt.details {
            super::protocol::ToolReceiptDetails::BuiltIn(crate::ToolDetails::Bash(details))
                if matches!(result.receipt.source, ExecutionSource::Native) =>
            {
                details.full_output_path.clone()
            }
            _ => None,
        };
        for path in captured_path.into_iter().chain(
            content
                .saved_path
                .map(|path| path.to_string_lossy().into_owned()),
        ) {
            let outputs = &mut self
                .semantic_continuation
                .get_or_insert_with(Default::default)
                .tool_outputs;
            if !outputs
                .iter()
                .any(|output| output.tool_call_id == call_id && output.path == path)
            {
                outputs.push(super::compaction::ToolOutputReference {
                    tool_call_id: call_id.clone(),
                    path,
                });
            }
        }
        let content = content.content;

        let hook_outcome = if approved {
            // Execute hooks only for tools that were allowed to run.
            // Hooks contract on raw tool output, not the model-facing
            // envelope (see `ToolExecution::raw_content`).
            run_post_execution_hooks(
                &self.hooks,
                &tool_name,
                &call_id,
                &args,
                &result.raw_content(),
                is_error,
                result.receipt.duration_ms.unwrap_or(0),
            )
            .await
        } else {
            PostExecutionHooks::default()
        };
        // The gate's verdict changes what the model is told, not what the
        // workflow bookkeeping below records: the tool really did run.
        let reported_error = is_error || hook_outcome.rejected.is_some();

        // Append injected context if any. A `PostToolUse` hook's context was
        // computed and then dropped, so a hook that returned `contextToAdd`
        // had no effect on the request that followed.
        let mut result_content = append_hook_context(
            &self.hooks,
            content,
            NativeHookEvent::PreToolUse,
            extra_context.as_deref(),
        );
        result_content = append_hook_context(
            &self.hooks,
            result_content,
            NativeHookEvent::PostToolUse,
            hook_outcome.context.as_deref(),
        );
        if let Some(reason) = &hook_outcome.rejected {
            result_content =
                format!("{result_content}\n\n[Eval gate rejected this result: {reason}]");
        }

        if approved {
            if let Err(err) = apply_workflow_state_hooks(
                &tool_name,
                &call_id,
                &args,
                &mut self.workflow_state,
                is_error,
            ) {
                // Append workflow hook error to content instead of replacing it
                // to preserve successful tool output
                result_content = format!("{}\n\n[Workflow error: {}]", result_content, err.message);
            }
        }

        // Hand the finished call to the extensions. The `doom-loop` tenant
        // records it here, which is where `SafetyController::record_tool_call`
        // used to be called directly.
        let (result_content, reported_error) = self.apply_tool_result_extensions(
            &call_id,
            &tool_name,
            &safe_args,
            result.receipt.duration_ms.unwrap_or(0),
            result_content,
            reported_error,
            Some(&result.receipt),
        );

        ContentBlock::ToolResult {
            tool_use_id: call_id,
            content: result_content,
            is_error: Some(reported_error),
        }
    }

    fn cancel_remaining_deferred_if_interrupted(
        &mut self,
        deferred_calls: &mut impl Iterator<Item = DeferredToolCall>,
        tool_results: &mut Vec<ContentBlock>,
    ) -> bool {
        if !self.take_active_operation_interruption() {
            return false;
        }
        let cancelled_ids = cancel_deferred_suffix(
            &self.event_tx,
            deferred_calls,
            tool_results,
            self.tool_executor.managed_policy_metadata(),
        );
        self.tool_response_coordinator
            .discard_cancelled(&cancelled_ids);
        true
    }

    async fn drain_read_only_tool_calls(
        &mut self,
        pending: &mut Vec<QueuedReadOnlyToolExecution>,
        tool_results: &mut Vec<ContentBlock>,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }

        let pending_calls = std::mem::take(pending);
        let cancel_token = CancellationToken::new();
        self.set_active_tool_cancel_token(Some(cancel_token.clone()), false);
        // These calls run concurrently in one batch, so the batch is the only
        // interval this path can measure. Each call is reported with the batch
        // elapsed, which is an upper bound on its own -- documented in
        // `docs/design/HOOKS_SYSTEM.md` so a hook reading `durationMs` knows
        // what it is looking at.
        let wave_started = Instant::now();
        let mut results_by_call_id = execute_native_read_only_tool_wave(
            &self.tool_executor,
            &self.event_tx,
            &pending_calls,
            Some(cancel_token),
        )
        .await;
        let wave_duration_ms = wave_started.elapsed().as_millis() as u64;
        self.set_active_tool_cancel_token(None, false);

        for call in pending_calls {
            let result = results_by_call_id.remove(&call.call_id).unwrap_or_else(|| {
                ToolExecution::from_legacy(
                    &call.call_id,
                    &call.tool_name,
                    ExecutionSource::Native,
                    ToolResult::failure("Tool task did not return a result"),
                )
                .with_managed_policy(self.tool_executor.managed_policy_metadata())
            });
            let content = result.model_content();
            let is_error = result.is_error();

            // Hooks contract on raw tool output, not the model-facing
            // envelope (see `ToolExecution::raw_content`).
            let hook_outcome = run_post_execution_hooks(
                &self.hooks,
                &call.tool_name,
                &call.call_id,
                &call.args,
                &result.raw_content(),
                is_error,
                result.receipt.duration_ms.unwrap_or(wave_duration_ms),
            )
            .await;
            let reported_error = is_error || hook_outcome.rejected.is_some();

            let mut final_content = append_hook_context(
                &self.hooks,
                content,
                NativeHookEvent::PreToolUse,
                call.extra_context.as_deref(),
            );
            final_content = append_hook_context(
                &self.hooks,
                final_content,
                NativeHookEvent::PostToolUse,
                hook_outcome.context.as_deref(),
            );
            if let Some(reason) = &hook_outcome.rejected {
                final_content =
                    format!("{final_content}\n\n[Eval gate rejected this result: {reason}]");
            }

            if let Err(err) = apply_workflow_state_hooks(
                &call.tool_name,
                &call.call_id,
                &call.args,
                &mut self.workflow_state,
                is_error,
            ) {
                final_content = format!("{}\n\n[Workflow error: {}]", final_content, err.message);
            }

            let (final_content, reported_error) = self.apply_tool_result_extensions(
                &call.call_id,
                &call.tool_name,
                &call.safe_args,
                result.receipt.duration_ms.unwrap_or(wave_duration_ms),
                final_content,
                reported_error,
                Some(&result.receipt),
            );

            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: call.call_id,
                content: final_content,
                is_error: Some(reported_error),
            });
        }

        Ok(())
    }
}

fn append_codex_tool_use(
    messages: &mut Vec<Message>,
    call_id: &str,
    tool_name: &str,
    input: Value,
) {
    messages.push(Message {
        role: Role::Assistant,
        content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
            id: call_id.to_owned(),
            name: tool_name.to_owned(),
            input,
        }]),
    });
}

fn append_codex_tool_result(
    messages: &mut Vec<Message>,
    call_id: &str,
    content: String,
    is_error: bool,
) {
    messages.push(Message {
        role: Role::User,
        content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
            tool_use_id: call_id.to_owned(),
            content,
            is_error: Some(is_error),
        }]),
    });
}

#[cfg(test)]
fn conversation_snapshot_event(messages: &[Message]) -> Option<FromAgent> {
    conversation_snapshot_event_with_queue_ids(
        messages,
        Vec::new(),
        "evalops.maestro.semantic-conversation.v1",
    )
}

fn conversation_snapshot_event_with_queue_ids(
    messages: &[Message],
    processed_queue_ids: Vec<u64>,
    protocol_version: &str,
) -> Option<FromAgent> {
    let serialized = serde_json::to_value(sanitize_semantic_conversation(messages)).ok()?;
    let messages = serde_json::from_value(redact_semantic_snapshot_json(
        crate::agent::credential_store::redact_credentials_in_json(&serialized),
    ))
    .ok()?;
    Some(FromAgent::ConversationSnapshot {
        protocol_version: protocol_version.to_owned(),
        messages,
        processed_queue_ids,
    })
}

/// Private semantic checkpoints may retain provider-visible structure, but not
/// hidden reasoning or arbitrary tool output. Keep the tool IDs so restored
/// histories preserve the call/result relationship while replacing the output
/// body with a bounded marker.
fn sanitize_semantic_conversation(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(|message| match &message.content {
            MessageContent::Text(_) => Some(message.clone()),
            MessageContent::Blocks(blocks) => {
                let blocks: Vec<ContentBlock> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { .. } | ContentBlock::ToolUse { .. } => {
                            Some(block.clone())
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            is_error,
                            ..
                        } => Some(ContentBlock::ToolResult {
                            tool_use_id: tool_use_id.clone(),
                            content: "[tool result omitted from checkpoint]".to_string(),
                            is_error: *is_error,
                        }),
                        ContentBlock::Thinking { .. } | ContentBlock::Image { .. } => None,
                    })
                    .collect();
                (!blocks.is_empty()).then_some(Message {
                    role: message.role,
                    content: MessageContent::Blocks(blocks),
                })
            }
        })
        .collect()
}

fn redact_semantic_snapshot_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(redact_semantic_snapshot_json)
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let sensitive = matches!(
                        key.to_ascii_lowercase().as_str(),
                        "api_key" | "apikey" | "authorization" | "password" | "secret" | "token"
                    );
                    (
                        key,
                        if sensitive {
                            serde_json::Value::String("[REDACTED]".to_string())
                        } else {
                            redact_semantic_snapshot_json(value)
                        },
                    )
                })
                .collect(),
        ),
        value => value,
    }
}

#[cfg(test)]
#[path = "native/tests.rs"]
mod tests;

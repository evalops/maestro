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
//! - **[`NativeAgent`]**: Lightweight handle held by the TUI application. All methods
//!   return immediately, sending commands via channels.
//! - **`NativeAgentRunner`**: Private background task that owns mutable state, processes
//!   commands, and manages the AI conversation loop.
//! - **Channel communication**: All interaction happens through Tokio MPSC channels,
//!   enabling true async/non-blocking behavior.
//!
//! # Lifecycle
//!
//! ```text
//! 1. TUI creates NativeAgent::new(config)
//!    ├─> Spawns background tokio::spawn(runner.run())
//!    └─> Returns (agent_handle, event_receiver)
//!
//! 2. TUI calls agent.prompt(message)
//!    └─> Sends AgentCommand::Prompt via channel (returns immediately)
//!
//! 3. Background runner receives command
//!    ├─> Adds message to conversation history
//!    ├─> Calls AI provider API (streaming)
//!    ├─> Sends FromAgent::ResponseChunk events
//!    └─> Handles tool calls if requested
//!
//! 4. TUI receives events from event_receiver
//!    └─> Updates UI in real-time
//! ```
//!
//! # Async Task Spawning
//!
//! The agent uses `tokio::spawn` to run the background task. This allows the TUI
//! thread to remain responsive while the agent processes long-running AI requests:
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
//! communication between the TUI and agent:
//!
//! 1. **Command channel** (`mpsc::UnboundedSender<AgentCommand>`):
//!    - TUI sends commands (prompt, cancel, `set_model`, etc.)
//!    - Agent receives and processes in order
//!
//! 2. **Event channel** (`mpsc::UnboundedSender<FromAgent>`):
//!    - Agent sends events (response chunks, tool calls, errors)
//!    - TUI receives and updates UI
//!
//! 3. **Tool response channel** (`mpsc::UnboundedSender<ToolResponseMessage>`):
//!    - TUI sends user approval for tool execution
//!    - Agent waits for approval before executing restricted tools
//!
//! Unbounded channels are used because:
//! - Commands are user-initiated and low-volume
//! - Events are streamed but backpressure is handled by the TUI renderer
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
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use serde_json::{json, Map, Value};
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::message_queue::{
    MessageQueue, PendingMessage, PromptKind, QueuePlacement, MAX_PENDING_MESSAGES,
};
use super::protocol::InlineToolApprovalContext;
use super::safety::{SafetyController, SafetyVerdict};
use super::{
    ensure_untrusted_content_policy, CredentialVault, DenialReason, ExecutionPhase,
    ExecutionSource, FromAgent, TokenUsage, ToolExecution, ToolOutcome, ToolResult,
};
use crate::ai::{
    provider_model_name, AiProvider, ContentBlock, ImageSource, Message, MessageContent,
    RequestConfig, Role, StreamEvent, ThinkingConfig, Tool, UnifiedClient,
};
use crate::headless::report_diagnostic_nonblocking;
use crate::hooks::{HookResult, IntegratedHookSystem};
use crate::safety::{
    apply_workflow_state_hooks, check_model_allowed, ActionFirewall, FirewallContext,
    FirewallVerdict, WorkflowStateTracker,
};
use crate::state::{ApprovalMode, QueueMode};
use crate::tools::{ToolExecutionOptions, ToolExecutor, ToolRegistry};

mod read_only_tools;

/// Payload of the tool-response channel: `(call_id, approved, result,
/// source, consumed)`. `source` records the provenance of a caller-supplied `result`:
/// [`ExecutionSource::Native`] when the caller executed the tool locally on
/// this process's behalf (the interactive TUI) and
/// [`ExecutionSource::RemoteClient`] when a remote/headless client executed
/// it. Preserving that provenance is what lets
/// `ToolExecution::model_content` wrap client-authored results in the
/// untrusted-content envelope without wrapping locally executed ones.
/// Ignored when `result` is `None` (a bare approval/denial). `consumed` lets
/// headless transports acknowledge a response only after the native runner
/// has removed it from the channel.
pub type ToolResponseMessage = (
    String,
    bool,
    Option<ToolResult>,
    ExecutionSource,
    Option<tokio::sync::oneshot::Sender<ToolResponseConsumption>>,
);
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolResponseConsumption {
    Accepted,
    Rejected { reason: String },
}
type PendingToolResponse = (
    bool,
    Option<ToolResult>,
    ExecutionSource,
    Option<tokio::sync::oneshot::Sender<ToolResponseConsumption>>,
);
const MAX_CANCELLED_TOOL_TOMBSTONES: usize = 4096;

#[derive(Debug, Default)]
struct CancelledToolTombstones {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl CancelledToolTombstones {
    fn insert(&mut self, call_id: String) {
        if !self.ids.insert(call_id.clone()) {
            return;
        }
        self.order.push_back(call_id);
        while self.order.len() > MAX_CANCELLED_TOOL_TOMBSTONES {
            if let Some(evicted) = self.order.pop_front() {
                self.ids.remove(&evicted);
            }
        }
    }

    fn remove(&mut self, call_id: &str) {
        if self.ids.remove(call_id) {
            self.order.retain(|entry| entry != call_id);
        }
    }

    fn contains(&self, call_id: &str) -> bool {
        self.ids.contains(call_id)
    }

    fn clear(&mut self) {
        self.ids.clear();
        self.order.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.ids.len()
    }
}

use self::read_only_tools::{
    execute_native_read_only_tool_wave, is_explicit_inline_read_only_tool,
    is_native_parallel_read_only_tool_call, QueuedReadOnlyToolExecution,
};

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

/// Resolve the transport-specific client used by the native runner.
///
/// Codex models are driven by Codex app-server, which owns ChatGPT auth and
/// must not require Maestro to materialize the access token as an HTTP client
/// credential. Other models retain the direct `UnifiedClient` path, including
/// the legacy API-key compatibility applied from `CODEX_HOME/auth.json`.
fn resolve_native_client(
    model: &str,
    client_override: Option<UnifiedClient>,
) -> Result<(Option<UnifiedClient>, String)> {
    if let Some(client) = client_override {
        let provider_name = client.provider_name().to_string();
        return Ok((Some(client), provider_name));
    }

    if super::codex_app_server_turns::model_should_use_app_server_turns(model) {
        return Ok((None, "openai-codex".to_owned()));
    }

    let _ = crate::codex_auth::apply_codex_auth_to_process_env();
    let client = UnifiedClient::from_model(model)?;
    let provider_name = client.provider_name().to_string();
    Ok((Some(client), provider_name))
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
        timestamp: Utc::now().to_rfc3339(),
    });
}

/// Configuration for the native agent
///
/// Defines the AI model settings, system prompt, thinking capabilities, and execution
/// environment for the agent. All fields can be updated at runtime via agent methods.
///
/// # Examples
///
/// ```
/// use maestro_tui::agent::NativeAgentConfig;
/// use maestro_tui::state::ApprovalMode;
///
/// // Default configuration (Codex on OpenAI)
/// let config = NativeAgentConfig::default();
/// assert_eq!(config.model, "gpt-5.1-codex-max");
///
/// // Custom configuration with thinking enabled
/// let config = NativeAgentConfig {
///     model: "claude-opus-4-5-20251101".to_string(),
///     max_tokens: 32768,
///     system_prompt: Some("You are a helpful coding assistant.".to_string()),
///     thinking_enabled: true,
///     thinking_budget: 20000,
///     cwd: "/path/to/project".to_string(),
///     approval_mode: ApprovalMode::Selective,
///     sandbox_policy: None,
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
    pub sandbox_policy: Option<crate::sandbox::SandboxPolicy>,
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        Self {
            model: "gpt-5.1-codex-max".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: false,
            thinking_budget: 10000,
            cwd: std::env::current_dir()
                .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string()),
            approval_mode: ApprovalMode::default(),
            sandbox_policy: None,
        }
    }
}

/// Tool definition with execution handler
///
/// Wraps a tool schema with metadata about whether it requires user approval
/// before execution. Tools that modify the filesystem or execute arbitrary code
/// typically require approval in safe mode.
///
/// # Examples
///
/// ```rust,ignore
/// let tool_def = ToolDefinition {
///     tool: Tool::new("bash", "Execute shell commands")
///         .with_schema(bash_schema),
///     requires_approval: true,  // Bash requires approval
/// };
/// ```
#[derive(Clone)]
pub struct ToolDefinition {
    /// Tool metadata for the AI
    ///
    /// Contains the tool name, description, and JSON schema that defines the
    /// expected parameters. This is sent to the AI model to enable tool calling.
    pub tool: Tool,

    /// Whether this tool requires user approval
    ///
    /// If true, the agent will emit a `FromAgent::ToolCall` event and wait for
    /// a `ToAgent::ToolResponse` before executing. If false, the tool executes
    /// immediately without user intervention.
    pub requires_approval: bool,
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
                "get_rlm_context",
                "set_rlm_context",
                "append_rlm_context",
                "render_rlm_context",
                "clear_rlm_context",
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

fn include_ide_tools_enabled_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn include_ide_tools_enabled() -> bool {
    std::env::var("MAESTRO_INCLUDE_IDE_TOOLS")
        .map(|value| include_ide_tools_enabled_value(&value))
        .unwrap_or(false)
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
    },

    /// Reinsert a follow-up at the front of the follow-up subsection.
    RequeueFollowUpFront {
        content: String,
        attachments: Vec<String>,
        queue_id: u64,
    },

    /// Cancel the current operation
    ///
    /// Triggers the cancellation token to stop the active AI request.
    /// The runner will clean up and send a `FromAgent::ResponseEnd` event.
    Cancel { clear_pending: bool },

    /// Cancel a queued prompt by id
    CancelQueued { id: u64 },

    /// Reorder a queued prompt without changing its id or contents.
    ReorderQueued { id: u64, placement: QueuePlacement },

    /// Change the active model
    ///
    /// Switches to a different AI model (e.g., from Claude to GPT-5).
    /// The conversation history is preserved.
    SetModel { model: String },

    /// Update thinking configuration
    ///
    /// Enables or disables the extended thinking mode and sets the token budget.
    SetThinking { enabled: bool, budget: u32 },

    /// Update the per-request output-token limit
    ///
    /// `max_tokens` bounds a single provider response, so a caller enforcing a
    /// budget across a whole run (the subagent scheduler) lowers it between
    /// requests to the allowance that is still unspent.
    SetMaxTokens { max_tokens: u32 },

    /// Cap the cumulative output tokens this runner may request across a run.
    ///
    /// A caller enforcing a whole-run budget cannot do it with `SetMaxTokens`:
    /// that bounds one request, so the caller has to lower it between
    /// responses, and the command can arrive after the runner has already built
    /// the next request. This hands the accounting to the runner, which
    /// subtracts what each response spent and clamps the request it is about to
    /// build. Sent once, before the prompt it applies to.
    SetOutputTokenBudget { max_total_output_tokens: u32 },

    /// Point the runner's tool executor at a different subagent scope.
    ///
    /// The runner's executor -- not the caller's -- is the one that spawns
    /// children, so it stamps the scope onto every child it starts. A new or
    /// resumed conversation rotates the scope on both sides; without this the
    /// caller would drain a scope no new child is ever tagged with.
    SetSubagentParentScope { parent_scope_id: String },

    /// Tell the runner which conversation is active.
    ///
    /// The hook system lives here, not in the caller, so this is the only way
    /// the active session id reaches hook payloads and the only place
    /// `SessionStart` and `SessionEnd` can be dispatched from. The runner
    /// compares against the session it currently holds and fires the
    /// transition, so callers just report the new state.
    SetSessionContext {
        session_id: Option<String>,
        /// Why the session changed, published as the hook's `source` /
        /// `reason` (`new`, `resume`, `fork`, `exit`).
        reason: String,
    },

    /// Point the hook system at a log file (test harness / diagnostics).
    ///
    /// Does not load project hook config; only enables
    /// [`IntegratedHookSystem`]'s existing `log_event` writer so session and
    /// recovery dispatches become assertable without trusting a temp workspace.
    SetHookLogFile { path: String },

    /// Update whether the goal lifecycle tools are exposed to the model.
    SetGoalToolsVisible { visible: bool },

    /// Update the active approval mode
    ///
    /// Keeps the runner's tool-execution gate (`requires_approval`) in sync
    /// with the caller's approval UI so the two never disagree about whether
    /// a tool needs approval before it executes.
    SetApprovalMode { mode: ApprovalMode },

    /// Update steering queue drain mode.
    SetSteeringMode { mode: QueueMode },

    /// Update follow-up queue drain mode.
    SetFollowUpMode { mode: QueueMode },

    /// Update the system prompt
    ///
    /// Replaces the base system prompt used for subsequent requests.
    SetSystemPrompt { system_prompt: String },

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
    ReplaceHistory { messages: Vec<Message> },

    /// Replace history for a delegated child resume without clearing the
    /// credential vault shared with its parent runner.
    ReplaceHistoryPreservingCredentials { messages: Vec<Message> },

    /// Append a host-generated user note to conversation history without
    /// starting a model turn. Used for background-task lifecycle notices so
    /// the next completion request sees them (does not trigger a response).
    InjectUserNote { content: String },

    /// Continue from current context without a new user message
    ///
    /// Used for retrying after transient errors (rate limits, 5xx errors),
    /// continuing after context compaction, or resuming interrupted tool execution.
    Continue,
}

/// The native agent handle (held by TUI)
///
/// This is a lightweight, cloneable handle that the TUI uses to interact with the
/// agent's background task. All methods return immediately by sending messages via
/// channels - no blocking on AI requests.
///
/// # Arc and Shared Ownership
///
/// The `NativeAgent` uses `Arc` (Atomic Reference Counting) internally through the
/// channel senders. Multiple clones of the same handle can send commands to the same
/// background agent. This is useful for UI components that need to trigger agent
/// operations from different parts of the codebase.
///
/// # Thread Safety
///
/// All channel senders are `Send + Sync`, making `NativeAgent` safe to share across
/// threads. However, the typical usage is to keep it on the main TUI thread and
/// interact with it via async methods.
///
/// # Examples
///
/// ```rust,ignore
/// // Create the agent
/// let (agent, mut events) = NativeAgent::new(config)?;
///
/// // Send a prompt (returns immediately)
/// agent.prompt("Write a Rust function".to_string(), vec![]).await?;
///
/// // Process events asynchronously
/// tokio::spawn(async move {
///     while let Some(event) = events.recv().await {
///         println!("Event: {:?}", event);
///     }
/// });
///
/// // Cancel if needed
/// agent.cancel();
/// ```
pub struct NativeAgent {
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

impl NativeAgent {
    /// Create a new native agent
    ///
    /// Initializes the agent with the given configuration and spawns a background
    /// task to handle AI requests. Returns immediately with an agent handle and
    /// an event receiver.
    ///
    /// # Returns
    ///
    /// A tuple of:
    /// - `NativeAgent`: The handle used to send commands
    /// - `mpsc::UnboundedReceiver<FromAgent>`: Stream of events from the agent
    ///
    /// # Lifecycle
    ///
    /// The background task is spawned with `tokio::spawn` and runs until:
    /// - The command channel is closed (agent handle dropped)
    /// - An unrecoverable error occurs
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// let config = NativeAgentConfig {
    ///     model: "claude-opus-4-5-20251101".to_string(),
    ///     max_tokens: 16384,
    ///     system_prompt: Some("You are a Rust expert.".to_string()),
    ///     thinking_enabled: true,
    ///     thinking_budget: 10000,
    ///     cwd: env::current_dir()?.to_string_lossy().to_string(),
    ///     sandbox_policy: None,
    /// };
    ///
    /// let (agent, mut events) = NativeAgent::new(config)?;
    /// agent.send_ready();
    /// ```
    pub fn new(config: NativeAgentConfig) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault(config, Vec::new(), CredentialVault::new())
    }

    /// Create an agent using a caller-provided credential vault.
    pub fn new_with_credential_vault(
        config: NativeAgentConfig,
        credential_vault: CredentialVault,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault(config, Vec::new(), credential_vault)
    }

    /// Create an agent whose runner shares the caller's subagent lifecycle
    /// scope. The interactive app uses this so auto-executed delegation calls
    /// report terminal events to the same executor that owns the UI.
    pub(crate) fn new_with_credential_vault_and_subagent_scope(
        config: NativeAgentConfig,
        credential_vault: CredentialVault,
        subagent_parent_scope_id: String,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            Vec::new(),
            credential_vault,
            None,
            None,
            Some(subagent_parent_scope_id),
        )
    }

    /// Create an agent that advertises only the selected built-in tools and
    /// delegates their execution to the caller through `tool_response_sender`.
    pub fn new_with_allowed_tools_and_credential_vault(
        config: NativeAgentConfig,
        allowed_tools: &HashSet<String>,
        credential_vault: CredentialVault,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let registry = ToolRegistry::new();
        let definitions = allowed_tools
            .iter()
            .map(|name| {
                registry
                    .get(name)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Unknown allowed tool `{name}`"))
            })
            .collect::<Result<Vec<_>>>()?;
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            definitions,
            credential_vault,
            Some(allowed_tools),
            None,
            None,
        )
    }

    /// Create an agent that advertises only the selected built-in tools and
    /// executes them in its own runner. Delegation tools are filtered by the
    /// caller before this constructor is invoked, so the child cannot create
    /// an unbounded delegation tree.
    pub fn new_with_allowed_tools_and_credential_vault_runner(
        config: NativeAgentConfig,
        allowed_tools: &HashSet<String>,
        credential_vault: CredentialVault,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            Vec::new(),
            credential_vault,
            Some(allowed_tools),
            None,
            None,
        )
    }

    /// Create an agent with caller-provided tools. Caller tools override built-ins
    /// with the same name and are completed through `tool_response_sender`.
    pub fn new_with_tools(
        config: NativeAgentConfig,
        external_tool_definitions: Vec<ToolDefinition>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault(
            config,
            external_tool_definitions,
            CredentialVault::new(),
        )
    }

    /// Create an agent with caller-provided tools and credential vault.
    pub fn new_with_tools_and_credential_vault(
        config: NativeAgentConfig,
        external_tool_definitions: Vec<ToolDefinition>,
        credential_vault: CredentialVault,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            external_tool_definitions,
            credential_vault,
            None,
            None,
            None,
        )
    }

    /// Create an agent with a caller-provided client (e.g. a deterministic
    /// `UnifiedClient::Scripted` replay client) instead of resolving one from
    /// `config.model` through the provider registry.
    pub fn new_with_client(
        config: NativeAgentConfig,
        client: UnifiedClient,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            Vec::new(),
            CredentialVault::new(),
            None,
            Some(client),
            None,
        )
    }

    /// Create an agent with a caller-provided client, advertising only the
    /// selected built-in tools to the model. Unlike
    /// [`NativeAgent::new_with_allowed_tools_and_credential_vault`], execution
    /// stays with the runner's own tool executor (this is the
    /// `scenario run --execute` shape: scripted model, real tools).
    pub fn new_with_client_and_allowed_tools(
        config: NativeAgentConfig,
        allowed_tools: &HashSet<String>,
        client: UnifiedClient,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            Vec::new(),
            CredentialVault::new(),
            Some(allowed_tools),
            Some(client),
            None,
        )
    }

    #[cfg(test)]
    fn new_with_test_client(
        config: NativeAgentConfig,
        client: UnifiedClient,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        Self::new_with_tools_and_credential_vault_filtered(
            config,
            Vec::new(),
            CredentialVault::new(),
            None,
            Some(client),
            None,
        )
    }

    fn new_with_tools_and_credential_vault_filtered(
        config: NativeAgentConfig,
        external_tool_definitions: Vec<ToolDefinition>,
        credential_vault: CredentialVault,
        allowed_tools: Option<&HashSet<String>>,
        client_override: Option<UnifiedClient>,
        subagent_parent_scope_id: Option<String>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let policy_id = policy_model_id(&config.model);
        if let Some(reason) = check_model_allowed(&policy_id) {
            return Err(anyhow::anyhow!(reason));
        }

        let (client, provider_name) = resolve_native_client(&config.model, client_override)?;

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, tool_response_rx) = mpsc::unbounded_channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let shutdown_token = CancellationToken::new();

        // Build tool definitions from the registry
        let registry = ToolRegistry::new();
        let mut tools: HashMap<String, ToolDefinition> = registry
            .tools()
            .filter(|td| {
                allowed_tools.is_none_or(|allowed| allowed.contains(&td.tool.name.to_lowercase()))
            })
            .map(|td| (td.tool.name.clone(), td.clone()))
            .collect();
        let external_tools = external_tool_definitions
            .iter()
            .map(|definition| definition.tool.name.to_lowercase())
            .collect::<HashSet<_>>();
        for definition in external_tool_definitions {
            tools.insert(definition.tool.name.to_lowercase(), definition);
        }
        let goal_tools_visible = crate::goal::GoalStore::load_default().tools_visible();
        let include_ide_tools = include_ide_tools_enabled();
        let active_tool_names = initial_active_tool_names(
            ToolProfile::from_env(),
            &tools,
            &external_tools,
            allowed_tools,
        );

        // Create tool executor. This is the executor that actually runs
        // every auto-approved call (Yolo mode entirely, plus Selective
        // mode's allowlisted calls) -- see the doc comment on
        // `NativeAgentConfig::sandbox_policy`. It must receive the same
        // policy a caller resolved for its own approval-gated executor, or
        // the sandbox default silently does nothing for the common case.
        let tool_executor = Arc::new(build_runner_tool_executor(
            &config.cwd,
            credential_vault.clone(),
            config.sandbox_policy.clone(),
            subagent_parent_scope_id,
        ));

        // Load hook system from config files
        let mut hooks = IntegratedHookSystem::load_from_config(&config.cwd);
        hooks.set_model(&config.model);

        // Create safety controller for doom loop and rate limit detection
        let safety = SafetyController::new();

        // Create context compactor for handling long conversations
        let compactor = super::compaction::ContextCompactor::new(Default::default());

        // Create retry policy for transient API errors
        let retry_policy = super::retry::RetryPolicy::default();

        // Create message queue for pending prompts (bounded)
        let pending_messages = MessageQueue::with_max_size(MAX_PENDING_MESSAGES);
        let active_cancellation = Arc::new(Mutex::new(ActiveCancellation::default()));

        // Create the background runner
        let runner = NativeAgentRunner {
            client,
            codex_session: None,
            codex_history_restore_prefix_len: None,
            codex_current_prompt_started: false,
            config: config.clone(),
            messages: Arc::new(Vec::new()),
            tools,
            model_tool_cache: None,
            goal_tools_visible,
            include_ide_tools,
            active_tool_names,
            external_tools,
            tool_executor,
            credential_vault,
            event_tx: event_tx.clone(),
            tool_response_rx,
            command_rx,
            busy: false,
            cancel_token: None,
            active_cancellation: Arc::clone(&active_cancellation),
            shutdown_token: shutdown_token.clone(),
            clear_pending_on_cancel: true,
            hooks,
            safety,
            workflow_state: WorkflowStateTracker::default(),
            compactor,
            retry_policy,
            pending_messages,
            steering_mode: QueueMode::All,
            follow_up_mode: QueueMode::All,
            deferred_commands: VecDeque::new(),
            pending_tool_approvals: HashMap::new(),
            cancelled_tool_responses: CancelledToolTombstones::default(),
            prompt_context: None,
            output_token_budget: None,
            output_tokens_spent: 0,
            queued_system_prompts: HashMap::new(),
            system_prompt_revision: 0,
            codex_file_change_paths_by_item: HashMap::new(),
        };

        // Spawn the background task
        let runner_handle = tokio::spawn(async move {
            runner.run().await;
        });

        let agent = Self {
            command_tx,
            tool_response_tx,
            active_cancellation,
            event_tx,
            model_name: config.model,
            provider_name,
            shutdown_token,
            runner_handle: Some(runner_handle),
        };

        Ok((agent, event_rx))
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
        self.command_tx
            .send(AgentCommand::Prompt {
                content,
                attachments,
                kind,
                queue_id,
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
        let _ = self
            .command_tx
            .send(AgentCommand::ReplaceHistory { messages });
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
    pub fn inject_user_note(&self, content: impl Into<String>) {
        let content = content.into();
        if content.trim().is_empty() {
            return;
        }
        let _ = self
            .command_tx
            .send(AgentCommand::InjectUserNote { content });
    }

    /// Set the model
    pub fn set_model(&self, model: impl Into<String>) -> Result<()> {
        let model = model.into();
        self.command_tx
            .send(AgentCommand::SetModel { model })
            .map_err(|e| anyhow::anyhow!("Failed to set model: {e}"))?;
        Ok(())
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

    /// Cap the cumulative output tokens this agent may request across a run.
    ///
    /// Send this before the prompt it applies to. The runner then owns the
    /// accounting and clamps each request it builds to the unspent remainder,
    /// so no per-request update has to arrive before the next request is built.
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
    /// report that the active session ended without a replacement.
    pub fn set_session_context(
        &self,
        session_id: Option<String>,
        reason: impl Into<String>,
    ) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetSessionContext {
                session_id,
                reason: reason.into(),
            })
            .map_err(|e| anyhow::anyhow!("Failed to set session context: {e}"))?;
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
    _tool_executor: &ToolExecutor,
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

    /// Cached model-facing tool schemas. The registry is immutable for the
    /// lifetime of a runner; only goal visibility and the IDE-tools flag can
    /// change the filtered view.
    model_tool_cache: Option<ModelToolCache>,

    /// Tool schemas currently exposed to the model. The native `tool_search`
    /// path expands this set on demand without rebuilding the executor.
    active_tool_names: HashSet<String>,

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
    tool_executor: Arc<ToolExecutor>,

    /// Shared vault for this agent session and its tool executors.
    credential_vault: CredentialVault,

    /// Channel to send events to the TUI
    ///
    /// Used to stream response chunks, tool calls, errors, etc. back to the UI.
    event_tx: mpsc::UnboundedSender<FromAgent>,

    /// Channel to receive tool responses from the TUI
    ///
    /// When a tool requires approval, the runner waits on this channel for
    /// the user's decision (approve/deny).
    tool_response_rx: mpsc::UnboundedReceiver<ToolResponseMessage>,

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
    hooks: IntegratedHookSystem,

    /// Safety controller for doom loop and rate limit detection
    ///
    /// Prevents runaway agent behavior by blocking repeated identical tool calls
    /// and excessive tool invocations within a time window.
    safety: SafetyController,

    /// Workflow state tracker for PII redaction enforcement
    workflow_state: WorkflowStateTracker,

    /// Context compactor for handling long conversations
    ///
    /// Summarizes older messages when the context grows too large to fit
    /// within the model's token limit.
    compactor: super::compaction::ContextCompactor,

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

    /// Buffered tool approvals that arrived out of order
    pending_tool_approvals: HashMap<String, PendingToolResponse>,

    /// Recently cancelled call IDs whose late responses must be rejected.
    cancelled_tool_responses: CancelledToolTombstones,

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

    /// File-change correlation for Codex items, keyed by item id.
    ///
    /// v2 `item/fileChange/requestApproval` often carries only `itemId`. Paths
    /// and per-path metadata (kind, content, move_path, …) arrive on earlier
    /// item notifications; this map correlates them so the action firewall and
    /// path-sensitive policy hooks see the same full change set.
    codex_file_change_paths_by_item: CodexFileChangeItemCache,
}

/// itemId → path → per-path patch metadata (may be an empty object).
type CodexFileChangeItemCache = HashMap<String, Map<String, Value>>;

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

/// The Codex `sandbox` value matching a Maestro sandbox policy.
///
/// Codex accepts `read-only`, `workspace-write`, and `danger-full-access` on
/// `thread/start`. `None` means the caller set no policy, which leaves the
/// Codex default in place.
fn codex_sandbox_mode(policy: Option<&crate::sandbox::SandboxPolicy>) -> Option<String> {
    match policy? {
        crate::sandbox::SandboxPolicy::ReadOnly => Some("read-only".to_owned()),
        crate::sandbox::SandboxPolicy::WorkspaceWrite { .. } => Some("workspace-write".to_owned()),
        crate::sandbox::SandboxPolicy::DangerFullAccess => Some("danger-full-access".to_owned()),
    }
}

/// Whether this configuration forbids the agent from changing anything.
///
/// Used to decline Codex-native mutation approvals outright. Codex is asked to
/// sandbox itself via `thread/start`, but that is an external process honoring
/// a request; refusing the approval RPC is enforcement inside Maestro.
fn config_denies_mutation(policy: Option<&crate::sandbox::SandboxPolicy>) -> bool {
    matches!(policy, Some(crate::sandbox::SandboxPolicy::ReadOnly))
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

/// Run the action firewall on a Codex-native mutation.
///
/// Returns `Some(reason)` when any equivalent Maestro tool call would be
/// blocked or would require approval. Native approvals have no interactive
/// path, so a RequireApproval verdict is also a denial. Every mutated path
/// is checked so a safe first path cannot launder a later out-of-workspace
/// path through a multi-file request.
fn codex_native_firewall_denial(
    cwd: &str,
    method: &str,
    params: Option<&Value>,
    workflow_state: Option<&crate::safety::WorkflowStateSnapshot>,
    known_item_paths: Option<&CodexFileChangeItemCache>,
) -> Option<String> {
    let arg_sets = codex_native_firewall_arg_sets(method, params, known_item_paths);
    if arg_sets.is_empty() {
        // Fail closed: a file-change approval with no recoverable paths (the
        // common v2 itemId-only shape) or a command approval with no command
        // string would otherwise auto-accept under Yolo with no containment.
        return Some(match codex_native_policy_tool(method) {
            "codex_file_change" => {
                "Codex file-change approval carried no recoverable paths for the action firewall"
                    .to_string()
            }
            _ => "Codex command approval carried no recoverable command for the action firewall"
                .to_string(),
        });
    }
    let firewall = ActionFirewall::new(cwd);
    for (tool_name, args) in arg_sets {
        match firewall.check_tool_with_context(FirewallContext {
            tool_name,
            args: &args,
            workflow_state,
            annotations: None,
        }) {
            FirewallVerdict::Block { reason } | FirewallVerdict::RequireApproval { reason } => {
                return Some(reason);
            }
            FirewallVerdict::Allow => {}
        }
    }
    None
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
    if allowance == 0 {
        1
    } else {
        allowance
    }
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

impl NativeAgentRunner {
    fn messages_mut(&mut self) -> &mut Vec<Message> {
        Arc::make_mut(&mut self.messages)
    }

    fn set_goal_tools_visible(&mut self, visible: bool) {
        if self.goal_tools_visible == visible {
            return;
        }
        self.goal_tools_visible = visible;
        self.model_tool_cache = None;
    }

    fn compact_codex_history_for_boundary(&mut self) {
        if !super::codex_app_server_turns::model_should_use_app_server_turns(&self.config.model) {
            return;
        }

        let result = self.compactor.compact_with_tokens(&self.messages);
        if !result.was_compacted() {
            return;
        }

        let status_message = format!(
            "Codex history compacted: {} messages summarized, {} oversized messages bounded",
            result.compacted_count, result.intra_compacted_count
        );
        emit_compaction_event(
            &self.event_tx,
            &self.messages,
            result.summary.as_deref().unwrap_or(&status_message),
            result.cut_point.as_ref(),
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
        if let Some(snapshot) = conversation_snapshot_event(&self.messages) {
            let _ = self.event_tx.send(snapshot);
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

    fn take_deferred_command(&mut self) -> Option<(AgentCommand, Option<CancellationToken>)> {
        if self.deferred_commands.is_empty() {
            return None;
        }

        // Hold the same lock used by the synchronous cancellation path while
        // draining the channel and activating a stashed prompt. A cancellation
        // sent before this lock is acquired is consumed by the drain; one sent
        // afterward blocks until the request token is installed, then cancels it.
        let active_cancellation = Arc::clone(&self.active_cancellation);
        let mut active = active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.drain_pending_commands();
        let command = self.deferred_commands.pop_front()?;
        let request_token = match &command {
            AgentCommand::Prompt { kind, .. } if prompt_kind_starts_main_request(*kind) => {
                let token = active.activate_request();
                self.cancel_token = Some(token.clone());
                Some(token)
            }
            _ => None,
        };
        Some((command, request_token))
    }

    fn activate_received_command(
        &mut self,
        command: AgentCommand,
    ) -> (AgentCommand, Option<CancellationToken>) {
        let starts_main_request = matches!(
            &command, AgentCommand::Prompt { kind, .. } if prompt_kind_starts_main_request(*kind)
        );
        if !starts_main_request {
            return (command, None);
        }

        // The command has left the channel and is now the active request. Hold
        // the cancellation mutex while installing its token and draining any
        // commands that followed it. A concurrent cancel either lands in this
        // drain or waits for the token and cancels it directly.
        let active_cancellation = Arc::clone(&self.active_cancellation);
        let mut active = active_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let token = active.activate_request();
        self.cancel_token = Some(token.clone());
        let _ = self.drain_pending_commands();
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
    ) {
        let id = queue_id.unwrap_or_else(|| self.pending_messages.reserve_id());
        let pending = if kind == PromptKind::Steer {
            PendingMessage::urgent_with_kind_and_id_and_attachments(content, kind, id, attachments)
        } else {
            PendingMessage::with_kind_and_id_and_attachments(content, kind, id, attachments)
        };
        let dropped = self.pending_messages.push_message(pending);
        if let Some(dropped) = dropped {
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!(
                    "Queue full, dropped oldest {}: {}...",
                    dropped.kind.label(),
                    &dropped.content[..dropped.content.len().min(30)]
                ),
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
    ) {
        let pending = PendingMessage::with_kind_and_id_and_attachments(
            content,
            PromptKind::FollowUp,
            queue_id,
            attachments,
        );
        let dropped = self.pending_messages.push_message_front_of_kind(pending);
        if let Some(dropped) = dropped {
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!(
                    "Queue full, dropped oldest {}: {}...",
                    dropped.kind.label(),
                    &dropped.content[..dropped.content.len().min(30)]
                ),
            });
        }
    }

    fn drain_pending_commands(&mut self) -> bool {
        let mut cancelled = false;
        while let Ok(cmd) = self.command_rx.try_recv() {
            match cmd {
                AgentCommand::Prompt {
                    content,
                    attachments,
                    kind,
                    queue_id,
                } => {
                    if should_defer_prompt_command(kind, cancelled) {
                        self.deferred_commands.push_back(AgentCommand::Prompt {
                            content,
                            attachments,
                            kind,
                            queue_id,
                        });
                    } else {
                        self.enqueue_pending_prompt(content, attachments, kind, queue_id);
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
                } => {
                    self.requeue_follow_up_front(content, attachments, queue_id);
                }
                AgentCommand::SetThinking { enabled, budget } => {
                    self.config.thinking_enabled = enabled;
                    self.config.thinking_budget = budget;
                }
                AgentCommand::SetMaxTokens { max_tokens } => {
                    self.config.max_tokens = max_tokens;
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
                AgentCommand::SetSessionContext { session_id, reason } => {
                    self.apply_session_context(session_id, &reason);
                }
                AgentCommand::SetHookLogFile { path } => {
                    self.hooks.set_log_file(Some(path));
                }
                AgentCommand::SetGoalToolsVisible { visible } => {
                    self.set_goal_tools_visible(visible);
                }
                AgentCommand::SetApprovalMode { mode } => {
                    self.config.approval_mode = mode;
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
                }
                AgentCommand::SetSystemPromptForQueuedPrompt {
                    queue_id,
                    system_prompt,
                } => {
                    self.queued_system_prompts
                        .insert(queue_id, (self.system_prompt_revision, system_prompt));
                }
                AgentCommand::InjectUserNote { content } => {
                    // Defer until idle so we never insert a user message mid-tool-loop.
                    self.deferred_commands
                        .push_back(AgentCommand::InjectUserNote { content });
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

    fn apply_user_note(&mut self, content: String) {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        self.messages_mut().push(Message {
            role: Role::User,
            content: MessageContent::text(trimmed.to_string()),
        });
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
        // Stash late results delivered after we stopped waiting (e.g. the app
        // still reports the outcome of a tool it cancelled).
        while let Ok(response) = self.tool_response_rx.try_recv() {
            buffer_or_reject_tool_response(
                response,
                &mut self.pending_tool_approvals,
                &self.cancelled_tool_responses,
            );
        }
        let messages = Arc::make_mut(&mut self.messages);
        repair_orphaned_tool_calls(messages, &mut self.pending_tool_approvals);
    }

    fn reset_tool_response_state(&mut self) {
        for (_, _, _, consumed) in self.pending_tool_approvals.drain().map(|(_, value)| value) {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response invalidated by session boundary".to_string(),
                });
            }
        }
        while let Ok((_, _, _, _, consumed)) = self.tool_response_rx.try_recv() {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response invalidated by session boundary".to_string(),
                });
            }
        }
        self.cancelled_tool_responses.clear();
    }

    fn reject_pending_tool_responses_on_cancel(&mut self) {
        reject_buffered_tool_responses_on_cancel(&mut self.pending_tool_approvals);
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
        self.pending_messages.drain_leading_kind(kind, max_count)
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
        if let Some(system_prompt) = staged_system_prompt_to_apply(
            self.queued_system_prompts.remove(&pending.id),
            self.system_prompt_revision,
        ) {
            self.config.system_prompt = Some(system_prompt);
        }

        let mut prompt = pending.content.clone();
        let mut attachments = pending.attachments.clone();
        let mut prompt_context: Option<String> = None;

        let hook_result = self
            .hooks
            .execute_user_prompt_submit(&prompt, attachments.len() as u32);
        match hook_result {
            HookResult::Block { reason } => {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Prompt blocked by hook: {reason}"),
                    fatal: false,
                });
                return Ok(None);
            }
            HookResult::ModifyInput { new_input } => {
                Self::apply_message_hook_modification(&mut prompt, &mut attachments, new_input);
            }
            HookResult::InjectContext { context } => {
                Self::merge_prompt_context(&mut prompt_context, context);
            }
            HookResult::Continue => {}
        }

        let hook_result =
            self.hooks
                .execute_pre_message(&prompt, &attachments, Some(&self.config.model));
        match hook_result {
            HookResult::Block { reason } => {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Prompt blocked by hook: {reason}"),
                    fatal: false,
                });
                return Ok(None);
            }
            HookResult::ModifyInput { new_input } => {
                Self::apply_message_hook_modification(&mut prompt, &mut attachments, new_input);
            }
            HookResult::InjectContext { context } => {
                Self::merge_prompt_context(&mut prompt_context, context);
            }
            HookResult::Continue => {}
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
        let mut next_prompt_context: Option<String> = None;
        let mut appended = false;
        for pending_message in pending {
            if let Some((message, prompt_context)) =
                self.prepare_pending_message(&pending_message).await?
            {
                self.messages_mut().push(message);
                if let Some(context) = prompt_context {
                    Self::merge_prompt_context(&mut next_prompt_context, context);
                }
                appended = true;
            }
        }
        self.prompt_context = next_prompt_context;
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

        let firewall = ActionFirewall::new(&self.config.cwd);
        let mut blocks = Vec::new();

        for raw in raw_paths {
            match firewall.check_file_read(raw) {
                FirewallVerdict::Block { reason } => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Attachment blocked: {reason}"),
                        fatal: false,
                    });
                    continue;
                }
                FirewallVerdict::RequireApproval { reason } => {
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Attachment is sensitive: {reason} (attaching anyway)"),
                    });
                }
                FirewallVerdict::Allow => {}
            }

            let path = self.resolve_attachment_path(raw);

            let meta = match fs::metadata(&path).await {
                Ok(m) => m,
                Err(e) => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Failed to read attachment metadata for {raw}: {e}"),
                        fatal: false,
                    });
                    continue;
                }
            };

            if !meta.is_file() {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment is not a file: {raw}"),
                    fatal: false,
                });
                continue;
            }

            let video_mime = crate::video::detect_video_mime(&path);
            let attachment_limit = if video_mime.is_some() {
                crate::video::MAX_VIDEO_BYTES
            } else {
                Self::MAX_ATTACHMENT_BYTES
            };
            if meta.len() > attachment_limit {
                let size_mb = meta.len().div_ceil(1024 * 1024);
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment too large ({size_mb}MB): {raw}"),
                    fatal: false,
                });
                continue;
            }

            if let Some(mime) = video_mime {
                match crate::video::extract_frames(&path).await {
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
            let (cmd, activated_request_token) = if let Some(command) = self.take_deferred_command()
            {
                command
            } else {
                let command =
                    recv_command_or_shutdown(&self.shutdown_token, &mut self.command_rx).await;
                let Some(command) = command else {
                    break;
                };
                self.activate_received_command(command)
            };
            let Some(cmd) = command_after_shutdown_check(cmd, &self.shutdown_token) else {
                break;
            };
            match cmd {
                AgentCommand::RequeueFollowUpFront {
                    content,
                    attachments,
                    queue_id,
                } => {
                    self.requeue_follow_up_front(content, attachments, queue_id);
                    continue;
                }
                AgentCommand::InjectUserNote { content } => {
                    if self.busy {
                        self.deferred_commands
                            .push_back(AgentCommand::InjectUserNote { content });
                        continue;
                    }
                    self.apply_user_note(content);
                    continue;
                }
                AgentCommand::Prompt {
                    content,
                    attachments,
                    kind,
                    queue_id,
                } => {
                    if self.busy {
                        self.enqueue_pending_prompt(content, attachments, kind, queue_id);
                        continue;
                    }

                    if kind == PromptKind::SideQuestion {
                        self.busy = true;
                        self.run_side_question(content).await;
                        self.busy = false;
                        let _ = self.event_tx.send(FromAgent::ResponseEnd {
                            response_id: "done".to_string(),
                            usage: None,
                        });
                        self.emit_conversation_snapshot();
                        continue;
                    }

                    self.busy = true;
                    self.workflow_state.reset();

                    let mut prompt = content;
                    let mut attachments = attachments;
                    let mut prompt_context: Option<String> = None;

                    // Execute UserPromptSubmit hooks
                    let hook_result = self
                        .hooks
                        .execute_user_prompt_submit(&prompt, attachments.len() as u32);
                    match hook_result {
                        HookResult::Block { reason } => {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Prompt blocked by hook: {reason}"),
                                fatal: false,
                            });
                            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                                response_id: "blocked".to_string(),
                                usage: None,
                            });
                            self.emit_conversation_snapshot();
                            self.busy = false;
                            self.set_active_request_cancel_token(None);
                            self.prompt_context = None;
                            continue;
                        }
                        HookResult::ModifyInput { new_input } => {
                            Self::apply_message_hook_modification(
                                &mut prompt,
                                &mut attachments,
                                new_input,
                            );
                        }
                        HookResult::InjectContext { context } => {
                            Self::merge_prompt_context(&mut prompt_context, context);
                        }
                        HookResult::Continue => {}
                    }

                    // Execute PreMessage hooks
                    let hook_result = self.hooks.execute_pre_message(
                        &prompt,
                        &attachments,
                        Some(&self.config.model),
                    );
                    match hook_result {
                        HookResult::Block { reason } => {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Prompt blocked by hook: {reason}"),
                                fatal: false,
                            });
                            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                                response_id: "blocked".to_string(),
                                usage: None,
                            });
                            self.emit_conversation_snapshot();
                            self.busy = false;
                            self.set_active_request_cancel_token(None);
                            self.prompt_context = None;
                            continue;
                        }
                        HookResult::ModifyInput { new_input } => {
                            Self::apply_message_hook_modification(
                                &mut prompt,
                                &mut attachments,
                                new_input,
                            );
                        }
                        HookResult::InjectContext { context } => {
                            Self::merge_prompt_context(&mut prompt_context, context);
                        }
                        HookResult::Continue => {}
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
                    let current_prompt_uses_codex =
                        super::codex_app_server_turns::model_should_use_app_server_turns(
                            &self.config.model,
                        );
                    if current_prompt_uses_codex {
                        self.codex_current_prompt_started = false;
                    }

                    // Reset retry policy for new request
                    self.retry_policy.reset();

                    // Run the agent loop with cancellation and retry support
                    let shutdown_token = self.shutdown_token.clone();
                    let active_cancellation = Arc::clone(&self.active_cancellation);
                    let mut request_cancelled = false;
                    let mut terminal_request_failure = false;
                    loop {
                        let result = run_request_with_cancellation(
                            self.run_loop(),
                            &cancel_token,
                            &shutdown_token,
                            &active_cancellation,
                        )
                        .await;

                        match result {
                            Ok(()) => break,
                            Err(e) => {
                                // Preserve the complete anyhow cause chain so
                                // connect/inject/start errors retain provider
                                // retry metadata hidden below their RPC context.
                                let msg = format!("{e:#}");
                                if msg == "Request cancelled" {
                                    request_cancelled = true;
                                    break;
                                }

                                // Classify error and check if we should retry
                                let error_kind = super::retry::ErrorKind::classify(&msg);

                                match self.retry_policy.should_retry(error_kind) {
                                    super::retry::RetryDecision::Retry {
                                        delay,
                                        attempt,
                                        reason,
                                    } => {
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
                                    }
                                    super::retry::RetryDecision::GiveUp { reason } => {
                                        // Not retryable or exhausted retries
                                        let hint = if matches!(
                                            error_kind,
                                            super::retry::ErrorKind::AuthFailure
                                        ) {
                                            " — run `maestro codex login --force` or set OPENAI_API_KEY"
                                        } else {
                                            ""
                                        };
                                        let _ = self.event_tx.send(FromAgent::Error {
                                            message: format!("Agent error: {msg} ({reason}){hint}"),
                                            fatal: false,
                                        });
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
                        self.codex_current_prompt_started = false;
                    }

                    if request_cancelled {
                        // The cancellation token is tripped synchronously, before the
                        // queued Cancel command is observed. Drain the command channel
                        // while this request still owns it so any prompts that preceded
                        // Cancel are stashed instead of being started as a new request
                        // ahead of that cancellation.
                        let _ = self.drain_pending_commands();
                    }

                    // Count only turns that produced a completion the session
                    // still owns. SessionEnd reports this as turnCount.
                    if !terminal_request_failure && !request_cancelled {
                        self.hooks.increment_turn();
                    }

                    self.busy = false;
                    self.set_active_request_cancel_token(None);
                    self.prompt_context = None;

                    self.repair_orphaned_tool_calls();

                    // Signal that we're done (TUI can clear busy state)
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "done".to_string(),
                        usage: None,
                    });
                    self.emit_conversation_snapshot();
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
                    if let Some(reason) = check_model_allowed(&policy_id) {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: reason.clone(),
                            fatal: false,
                        });
                        let _ = self
                            .event_tx
                            .send(FromAgent::ModelChangeFailed { model, reason });
                        continue;
                    }

                    // Drop any live Codex thread when the model changes so the
                    // next openai-codex prompt opens a fresh app-server session.
                    self.codex_session = None;

                    match resolve_native_client(&model, None) {
                        Ok((client, provider)) => {
                            self.client = client;
                            self.config.model = model.clone();
                            self.hooks.set_model(&model);
                            let _ = self
                                .event_tx
                                .send(FromAgent::ModelChanged { model, provider });
                        }
                        Err(e) => {
                            let message = format!("Failed to set model: {e}");
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: message.clone(),
                                fatal: false,
                            });
                            let _ = self.event_tx.send(FromAgent::ModelChangeFailed {
                                model,
                                reason: message,
                            });
                        }
                    }
                }
                AgentCommand::SetThinking { enabled, budget } => {
                    self.config.thinking_enabled = enabled;
                    self.config.thinking_budget = budget;
                }
                AgentCommand::SetMaxTokens { max_tokens } => {
                    self.config.max_tokens = max_tokens;
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
                AgentCommand::SetSessionContext { session_id, reason } => {
                    self.apply_session_context(session_id, &reason);
                }
                AgentCommand::SetHookLogFile { path } => {
                    self.hooks.set_log_file(Some(path));
                }
                AgentCommand::SetGoalToolsVisible { visible } => {
                    self.set_goal_tools_visible(visible);
                }
                AgentCommand::SetApprovalMode { mode } => {
                    self.config.approval_mode = mode;
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
                }
                AgentCommand::SetSystemPromptForQueuedPrompt {
                    queue_id,
                    system_prompt,
                } => {
                    self.queued_system_prompts
                        .insert(queue_id, (self.system_prompt_revision, system_prompt));
                }
                AgentCommand::ClearHistory => {
                    self.reset_tool_response_state();
                    self.messages_mut().clear();
                    self.codex_session = None;
                    self.codex_history_restore_prefix_len = None;
                    self.codex_current_prompt_started = false;
                    self.pending_messages.clear();
                    // The prompts it was staged for are gone with the queue.
                    self.queued_system_prompts.clear();
                    self.safety.reset(); // Reset doom loop / rate limit state
                    self.credential_vault.clear();
                }
                AgentCommand::ReplaceHistory { messages } => {
                    self.reset_tool_response_state();
                    let restored_prefix_len = messages.len();
                    self.messages = Arc::new(messages);
                    self.codex_session = None;
                    self.codex_history_restore_prefix_len = Some(restored_prefix_len);
                    self.codex_current_prompt_started = false;
                    self.compact_codex_history_for_boundary();
                    self.pending_messages.clear();
                    // The prompts it was staged for are gone with the queue.
                    self.queued_system_prompts.clear();
                    self.safety.reset();
                    // Replacing history is used for session restore. References
                    // from the previous active session must not cross that boundary.
                    self.credential_vault.clear();
                }
                AgentCommand::ReplaceHistoryPreservingCredentials { messages } => {
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
                    self.safety.reset();
                }
                AgentCommand::Continue => {
                    // Continue from current context without adding a new user message
                    // Used for retry after transient errors
                    if self.busy {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: "Agent is busy".to_string(),
                            fatal: false,
                        });
                        continue;
                    }

                    // Need at least some history to continue from
                    if self.messages.is_empty() {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: "Cannot continue: no conversation history".to_string(),
                            fatal: false,
                        });
                        continue;
                    }

                    self.busy = true;
                    let cancel_token = CancellationToken::new();
                    self.set_active_request_cancel_token(Some(cancel_token.clone()));
                    let shutdown_token = self.shutdown_token.clone();
                    let active_cancellation = Arc::clone(&self.active_cancellation);

                    // Run the agent loop without adding a user message
                    let result = run_request_with_cancellation(
                        self.run_loop(),
                        &cancel_token,
                        &shutdown_token,
                        &active_cancellation,
                    )
                    .await;

                    if let Err(e) = result {
                        let msg = e.to_string();
                        if msg != "Request cancelled" {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Agent error: {e}"),
                                fatal: false,
                            });
                        }
                    }

                    self.busy = false;
                    self.set_active_request_cancel_token(None);
                    self.prompt_context = None;

                    self.repair_orphaned_tool_calls();

                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "continue".to_string(),
                        usage: None,
                    });
                    self.emit_conversation_snapshot();
                }
            }
        }

        // Close the active session for hooks here rather than from the caller.
        // The app's own exit path is skipped entirely on SIGINT/SIGTERM --
        // `run_with_shutdown` drops the `app.run()` future and then cancels the
        // runner -- and a command sent at that point would race the
        // cancellation. This runs on every way out of the loop, so a handled
        // signal, a normal quit, and a closed command channel all emit it.
        self.apply_session_context(None, "shutdown");

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
    fn apply_session_context(&mut self, session_id: Option<String>, reason: &str) {
        if self.hooks.session_id() == session_id.as_deref() {
            return;
        }
        if self.hooks.session_id().is_some() {
            let _ = self.hooks.on_session_end(reason);
        }
        self.hooks.set_session_id(session_id.clone());
        if session_id.is_some() {
            let _ = self.hooks.on_session_start(reason);
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
    fn build_config(&mut self) -> RequestConfig {
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
        let tools = if let Some(tools) = cached_tools {
            tools
        } else {
            let mut definitions: Vec<&ToolDefinition> = self
                .tools
                .values()
                .filter(|d| {
                    let name = d.tool.name.as_str();
                    if !self.active_tool_names.contains(&name.to_ascii_lowercase()) {
                        return false;
                    }
                    if !tool_is_visible_to_model(name, goal_tools_visible, include_ide_tools) {
                        return false;
                    }
                    true
                })
                .collect();
            definitions.sort_unstable_by(|left, right| left.tool.name.cmp(&right.tool.name));
            let tools = Arc::new(
                definitions
                    .into_iter()
                    .map(|d| compact_tool_for_model(d.tool.clone()))
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

        let thinking = if self.config.thinking_enabled {
            Some(ThinkingConfig::enabled(self.config.thinking_budget))
        } else {
            None
        };

        let system = match (&self.config.system_prompt, &self.prompt_context) {
            (Some(base), Some(extra)) if !extra.trim().is_empty() => {
                Some(format!("{base}\n\n{extra}"))
            }
            (Some(base), _) => Some(base.clone()),
            (None, Some(extra)) if !extra.trim().is_empty() => Some(extra.clone()),
            _ => None,
        };

        // Every runtime that can surface an `<untrusted_content>` envelope
        // (the shared `ToolExecution::model_content` chokepoint) must also
        // send the policy that gives the envelope its security meaning.
        // Callers that supply their own system prompt — the headless server,
        // the control-plane chat path — get it appended here; prompts that
        // already embed it (the TUI base prompt) pass through unchanged.
        let system = ensure_untrusted_content_policy(system);

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

        RequestConfig {
            model,
            max_tokens: self.remaining_output_token_allowance(),
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system,
            tools,
            thinking,
            // Enable prompt caching for Anthropic models
            cache_system_prompt: self
                .client
                .as_ref()
                .is_some_and(|client| client.provider() == AiProvider::Anthropic),
        }
    }

    async fn run_side_question(&mut self, question: String) {
        let side_id = Uuid::new_v4().to_string();
        let _ = self.event_tx.send(FromAgent::SideQuestionStart {
            side_id: side_id.clone(),
            question: question.clone(),
        });

        let mut answer = String::new();
        let mut usage = TokenUsage::default();
        let mut saw_usage = false;
        let shutdown_token = self.shutdown_token.clone();
        let credential_vault = self.credential_vault.clone();
        let result = await_side_question_or_shutdown(&shutdown_token, async {
            if super::codex_app_server_turns::model_should_use_app_server_turns(&self.config.model)
            {
                return self
                    .run_codex_side_question(&question, &side_id, &mut answer)
                    .await;
            }

            let mut messages = resolve_provider_history(&self.messages, &credential_vault)?;
            messages.push(Message {
                role: Role::User,
                content: MessageContent::text(question.clone()),
            });
            let mut config = self.build_config();
            config.tools = Arc::new(Vec::new());
            let client = self
                .client
                .as_ref()
                .context("direct provider client missing for side question")?;
            let mut rx = client.stream_owned_config(&messages, config).await?;

            while let Some(event) = rx.recv().await {
                match event {
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
                    StreamEvent::Error { message } => return Err(anyhow::anyhow!(message)),
                    _ => {}
                }
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|| Err(anyhow::anyhow!("Side question cancelled during shutdown")));

        let _ = self.event_tx.send(FromAgent::SideQuestionEnd {
            side_id,
            question,
            answer,
            error: result.err().map(|err| err.to_string()),
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
    ) -> Result<()> {
        use super::codex_app_server_turns::TurnWaitEvent;

        let restored_messages = resolve_provider_history(&self.messages, &self.credential_vault)?;
        let instructions = {
            let system = match (&self.config.system_prompt, &self.prompt_context) {
                (Some(base), Some(extra)) if !extra.trim().is_empty() => {
                    Some(format!("{base}\n\n{extra}"))
                }
                (Some(base), _) => Some(base.clone()),
                (None, Some(extra)) if !extra.trim().is_empty() => Some(extra.clone()),
                _ => None,
            };
            ensure_untrusted_content_policy(system)
        };
        let session = super::codex_app_server_turns::CodexAppServerTurnSession::connect(
            super::codex_app_server_turns::codex_thread_model_id(&self.config.model),
            Some(self.config.cwd.clone()),
            Some("untrusted".to_owned()),
            Some("read-only".to_owned()),
            &[],
            instructions,
            &restored_messages,
        )
        .await
        .context("start Codex app-server side-question session")?;
        let turn_id = session.start_text_turn(question.to_owned(), None).await?;

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
                    if !result.assistant_text.is_empty() {
                        answer.push_str(&result.assistant_text);
                        let _ = self.event_tx.send(FromAgent::SideQuestionChunk {
                            side_id: side_id.to_owned(),
                            content: result.assistant_text,
                        });
                    }
                    return Ok(());
                }
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
            self.run_side_question(pending.content).await;
        }
    }

    /// Ensure a Codex app-server thread exists for `openai-codex/*`.
    async fn ensure_codex_session(&mut self) -> Result<()> {
        if self.codex_session.is_some() {
            return Ok(());
        }
        let model = super::codex_app_server_turns::codex_thread_model_id(&self.config.model);
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
            Some(crate::sandbox::SandboxPolicy::ReadOnly) => Some("read-only".to_owned()),
            _ => std::env::var("MAESTRO_SANDBOX_MODE")
                .ok()
                .filter(|mode| !mode.is_empty() && mode != "default" && mode != "inherit")
                .or_else(|| codex_sandbox_mode(self.config.sandbox_policy.as_ref())),
        };
        let dynamic_tools = super::codex_app_server_turns::dynamic_tools_from_native(&self.tools);
        // Same standing instructions the HTTP path puts in RequestConfig.system.
        let instructions = {
            let system = match (&self.config.system_prompt, &self.prompt_context) {
                (Some(base), Some(extra)) if !extra.trim().is_empty() => {
                    Some(format!("{base}\n\n{extra}"))
                }
                (Some(base), _) => Some(base.clone()),
                (None, Some(extra)) if !extra.trim().is_empty() => Some(extra.clone()),
                _ => None,
            };
            ensure_untrusted_content_policy(system)
        };
        let restored_prefix_len = self.codex_history_restore_prefix_len.unwrap_or(0);
        let restored_messages = resolve_provider_history(
            &self.messages[..restored_prefix_len.min(self.messages.len())],
            &self.credential_vault,
        )?;
        let session = super::codex_app_server_turns::CodexAppServerTurnSession::connect(
            model,
            Some(cwd),
            approval_policy,
            sandbox,
            &dynamic_tools,
            instructions,
            &restored_messages,
        )
        .await?;
        self.codex_history_restore_prefix_len = None;
        let _ = self.event_tx.send(FromAgent::Status {
            message: format!("Codex app-server thread ready ({})", session.thread_id()),
        });
        self.codex_session = Some(session);
        Ok(())
    }

    /// Drive one user turn (and any tool calls) entirely through Codex
    /// app-server so ChatGPT OAuth refresh is never handled as a Platform API key.
    ///
    /// **Partial surface (tracked):**
    /// - Dynamic tools run via Maestro `ToolExecutor` + firewall (same as HTTP).
    /// - Codex-native `commandExecution` / `fileChange` approvals auto-accept
    ///   only in Yolo; Selective/Safe decline them (status line only). Codex
    ///   shell via those RPCs is effectively off unless Yolo.
    async fn run_loop_via_codex_app_server(&mut self) -> Result<()> {
        use super::codex_app_server_turns::TurnWaitEvent;

        self.ensure_codex_session().await?;

        let user_text = self
            .messages
            .iter()
            .rev()
            .find_map(|message| match (&message.role, &message.content) {
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
            })
            .unwrap_or_default();
        if user_text.is_empty() {
            bail!("No user message available for Codex app-server turn");
        }

        let response_id = Uuid::new_v4().to_string();
        let _ = self.event_tx.send(FromAgent::ResponseStart {
            response_id: response_id.clone(),
        });

        let turn_id = {
            let session = self
                .codex_session
                .as_ref()
                .context("Codex app-server session missing")?;
            session.start_text_turn(user_text, None).await?
        };
        self.codex_current_prompt_started = true;

        // Accumulate the current provider-history segment. Tool boundaries
        // consume that segment's authoritative item before flushing it, so
        // the terminal completion cannot repeat pre-tool assistant text.
        let mut streamed_assistant = String::new();

        loop {
            if self.drain_pending_commands() {
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
                    if !final_text.is_empty() {
                        self.messages_mut().push(Message {
                            role: Role::Assistant,
                            content: MessageContent::Text(final_text),
                        });
                    }
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id,
                        usage: None,
                    });
                    return Ok(());
                }
                TurnWaitEvent::ServerRequest(request) => {
                    // The server-request reader is ordered: any assistant
                    // notification read before this request is already queued.
                    // Drain that causal prefix now, before recording the tool
                    // use/result, rather than depending on the next loop tick.
                    self.drain_codex_assistant_deltas(&response_id, &mut streamed_assistant)
                        .await?;
                    self.reconcile_codex_completed_segment(&mut streamed_assistant)
                        .await?;
                    self.flush_codex_streamed_assistant(&mut streamed_assistant);
                    self.handle_codex_server_request(request).await?;
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
    fn finalize_codex_tool_result(&mut self, outcome: CodexToolOutcome<'_>) -> (String, bool) {
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
            &mut self.hooks,
            tool_name,
            call_id,
            args,
            hook_output,
            is_error,
            duration_ms,
        );
        let mut text = append_hook_context(result_text, pre_hook_context);
        text = append_hook_context(text, hook_outcome.context.as_deref());
        if let Some(reason) = &hook_outcome.rejected {
            text = format!("{text}\n\n[Eval gate rejected this result: {reason}]");
        }
        let reported_error = is_error || hook_outcome.rejected.is_some();
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

    async fn handle_codex_server_request(
        &mut self,
        request: crate::codex_app_server::IncomingServerRequest,
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
                self.cancelled_tool_responses.remove(&call_id);

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

                // This handler is the second place that decides whether a tool
                // executes. The HTTP tool loop runs `PreToolUse` before the
                // firewall so the firewall vets whatever the hook rewrote; the
                // same order applies here, otherwise a policy hook is enforced
                // for one transport and skipped for the other.
                let (args, pre_hook_context) =
                    match run_pre_tool_use_hook(&mut self.hooks, &registry_name, &call_id, &args) {
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
                let firewall = ActionFirewall::new(&self.config.cwd);
                let firewall_verdict = if is_external_tool {
                    FirewallVerdict::Allow
                } else {
                    firewall.check_tool_with_context(FirewallContext {
                        tool_name: &tool_key,
                        args: &args,
                        workflow_state: Some(&workflow_snapshot),
                        annotations: annotations.as_ref(),
                    })
                };
                if let FirewallVerdict::Block { reason } = &firewall_verdict {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: reason.clone(),
                        fatal: false,
                    });
                    let error = format!("Tool blocked by action firewall: {reason}");
                    self.record_codex_tool_result(&call_id, error.clone(), true);
                    request.respond(tool_call_error_result(error));
                    return Ok(());
                }

                let requires_approval = tool_requires_approval(
                    self.config.approval_mode,
                    is_external_tool,
                    &firewall_verdict,
                    &self.tool_executor,
                    &registry_name,
                    &args,
                );

                // The approval decision is the `PermissionRequest` boundary on
                // this transport, matching the HTTP tool loop. A `block`
                // denies the call and the user is never asked.
                if requires_approval {
                    let permission = self.hooks.execute_permission_request(
                        &registry_name,
                        &call_id,
                        &args,
                        "tool requires approval",
                    );
                    if let HookResult::Block { reason } = permission {
                        let message = format!("Tool denied by permission hook: {reason}");
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: message.clone(),
                            fatal: false,
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
                    let response = wait_for_codex_tool_response(
                        &call_id,
                        &mut self.tool_response_rx,
                        &mut self.pending_tool_approvals,
                        &self.cancelled_tool_responses,
                        &approval_cancel,
                    )
                    .await;
                    self.set_active_approval_cancel_token(None);
                    let (approved, provided_result, _source) = match response {
                        ToolResponseWait::Response(response) => response,
                        ToolResponseWait::Cancelled => {
                            let cancelled_ids = HashSet::from([call_id.clone()]);
                            discard_cancelled_tool_responses(
                                &cancelled_ids,
                                &mut self.tool_response_rx,
                                &mut self.pending_tool_approvals,
                                &mut self.cancelled_tool_responses,
                            );
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
                        let error = "Tool denied by user".to_owned();
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
                        let (response, is_error) =
                            self.finalize_codex_tool_result(CodexToolOutcome {
                                tool_name: &registry_name,
                                call_id: &call_id,
                                args: &args,
                                hook_output: &hook_output,
                                result_text: vaulted_text,
                                is_error,
                                pre_hook_context: pre_hook_context.as_deref(),
                                duration_ms: 0,
                            });
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
                let (response, is_error) = self.finalize_codex_tool_result(CodexToolOutcome {
                    tool_name: &registry_name,
                    call_id: &call_id,
                    args: &args,
                    hook_output: &hook_output,
                    result_text: execution.model_content(),
                    is_error,
                    pre_hook_context: pre_hook_context.as_deref(),
                    duration_ms,
                });
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
                // Partial: only Yolo auto-accepts Codex-native exec approvals.
                // Selective/Safe decline; Maestro dynamic tools still use the
                // normal ToolCall approval path above.
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
                    &mut self.hooks,
                    policy_tool,
                    &policy_call_id,
                    &policy_args,
                ) {
                    Err(reason) => Some(reason),
                    Ok((rewritten, _)) if rewritten != policy_args => Some(
                        "PreToolUse rewrote the Codex-native operation, which cannot accept rewritten parameters"
                            .to_string(),
                    ),
                    Ok(_) => match self.hooks.execute_permission_request(
                        policy_tool,
                        &policy_call_id,
                        &policy_args,
                        "Codex-native mutation",
                    ) {
                        HookResult::Block { reason } => Some(reason),
                        _ => None,
                    },
                };

                let denies_mutation = config_denies_mutation(self.config.sandbox_policy.as_ref());
                let profile_denial =
                    codex_native_denied_by_active_tools(&request.method, &self.active_tool_names);
                let firewall_denial = codex_native_firewall_denial(
                    &self.config.cwd,
                    &request.method,
                    request.params.as_ref(),
                    Some(&self.workflow_state.snapshot()),
                    Some(&self.codex_file_change_paths_by_item),
                );
                let accept = matches!(self.config.approval_mode, ApprovalMode::Yolo)
                    && !denies_mutation
                    && profile_denial.is_none()
                    && hook_denial.is_none()
                    && firewall_denial.is_none();
                if !accept {
                    let reason = if let Some(reason) = &hook_denial {
                        format!("blocked by a policy hook: {reason}")
                    } else if let Some(reason) = &firewall_denial {
                        format!("blocked by the action firewall: {reason}")
                    } else if let Some(reason) = profile_denial {
                        reason.to_string()
                    } else if denies_mutation {
                        "the sandbox policy is read-only".to_string()
                    } else {
                        "approval mode is not Yolo; use Maestro tools or switch to Yolo".to_string()
                    };
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Declined Codex-native {} ({reason})", request.method),
                    });
                }
                request.respond(approval_decision(accept));
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

    /// Run the agent loop until complete or interrupted
    async fn run_loop(&mut self) -> Result<()> {
        if super::codex_app_server_turns::model_should_use_app_server_turns(&self.config.model) {
            return self.run_loop_via_codex_app_server().await;
        }

        'turn: loop {
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
            let config = self.build_config();
            let provider_messages =
                resolve_provider_history_shared(&self.messages, &self.credential_vault)?;
            let client = self
                .client
                .as_ref()
                .context("direct provider client missing for native turn")?;
            let mut rx = client
                .stream_owned_config_shared_messages(provider_messages, config)
                .await?;

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

            // Process stream events
            while let Some(event) = rx.recv().await {
                match event {
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
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: text,
                            is_thinking: false,
                        });
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
                        if !current_thinking.is_empty() {
                            assistant_content.push(ContentBlock::Thinking {
                                thinking: std::mem::take(&mut current_thinking),
                                signature: thinking_signature,
                            });
                        }
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
                        stop_reason = reason;
                        // Check for context overflow
                        if matches!(stop_reason, Some(crate::ai::StopReason::MaxTokens)) {
                            eprintln!("[agent] Context overflow detected (MaxTokens)");
                            // Use token-aware compaction that respects turn boundaries
                            eprintln!("[agent] Performing context compaction...");
                            let result = self.compactor.compact_with_tokens(&self.messages);
                            if result.was_compacted() {
                                let split_note = if result.was_turn_split() {
                                    " (turn was split)"
                                } else {
                                    ""
                                };
                                eprintln!(
                                    "[agent] Compacted {} messages{}",
                                    result.compacted_count, split_note
                                );
                                // Notify the UI about compaction with details
                                let status_msg = if let Some(ref cut_point) = result.cut_point {
                                    format!(
                                        "Context compacted: {} messages summarized (~{} tokens → ~{} tokens){}",
                                        result.compacted_count,
                                        cut_point.tokens_before,
                                        cut_point.tokens_after,
                                        split_note
                                    )
                                } else {
                                    format!(
                                        "Context compacted: {} messages summarized",
                                        result.compacted_count
                                    )
                                };
                                emit_compaction_event(
                                    &self.event_tx,
                                    &self.messages,
                                    result.summary.as_deref().unwrap_or(&status_msg),
                                    result.cut_point.as_ref(),
                                    false,
                                );
                                let _ = self.event_tx.send(FromAgent::Status {
                                    message: status_msg,
                                });
                                self.messages = Arc::new(result.messages);
                                self.emit_conversation_snapshot();
                            }
                            // Hooks can also handle overflow
                            if self.hooks.handle_overflow() {
                                eprintln!("[agent] Hooks handling overflow");
                            }
                        }
                        break;
                    }
                    StreamEvent::Error { message } => {
                        stream_failed = true;
                        stream_error_message = Some(message.clone());
                        abort_pending_tools_after_stream_error(
                            &mut assistant_content,
                            &mut pending_tool_calls,
                        );
                        let _ = self.event_tx.send(FromAgent::Error {
                            message,
                            // A provider stream error ends this response. Mark it
                            // terminal so print mode cannot report a successful
                            // completed run after an API failure.
                            fatal: true,
                        });
                        break;
                    }
                }
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

            // Add assistant message to history
            if !assistant_content.is_empty() {
                self.messages_mut().push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Blocks(assistant_content),
                });
            }

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let stop_reason_label = stop_reason.map(Self::stop_reason_label);
            let _ = self.hooks.execute_post_message(
                &response_text,
                usage.input_tokens,
                usage.output_tokens,
                duration_ms,
                stop_reason_label,
            );

            // Charge this response against any cumulative output budget before
            // the next request is built; `build_config` reads the running total.
            self.output_tokens_spent = self.output_tokens_spent.saturating_add(usage.output_tokens);

            // Signal response end. `None` means the provider reported nothing
            // for this turn, which is not the same as reporting zero.
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: saw_usage.then_some(usage),
            });

            if stream_failed {
                self.set_tool_batch_active(false);
                // Terminal recovery boundary: the provider stream failed and no
                // further attempt will produce a valid completion for this turn.
                let last_assistant = (!response_text.is_empty()).then_some(response_text.as_str());
                let _ = self.hooks.execute_stop_failure(
                    "api_error",
                    stream_error_message.as_deref(),
                    last_assistant,
                );
                return Ok(());
            }

            if self.drain_pending_commands() {
                self.repair_orphaned_tool_calls();
                return Err(anyhow::anyhow!("Request cancelled"));
            }

            // If there are tool calls, handle them
            if !pending_tool_calls.is_empty() {
                let mut tool_results: Vec<ContentBlock> = Vec::new();
                let firewall = ActionFirewall::new(&self.config.cwd);
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
                    self.cancelled_tool_responses.remove(&call_id);
                    if processed_any_tool {
                        if self.drain_pending_commands() {
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
                    let hook_result =
                        self.hooks
                            .execute_pre_tool_use(&tool_name, &call_id, &pre_hook_args);

                    // Handle hook results
                    let (args, extra_context) = match hook_result {
                        HookResult::Block { reason } => {
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
                        HookResult::ModifyInput { new_input } => {
                            // Use modified input
                            (new_input, None)
                        }
                        HookResult::InjectContext { context } => {
                            // Keep original args, but track context to append
                            (args.clone(), Some(context))
                        }
                        HookResult::Continue => {
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

                    // Check safety controls (doom loop and rate limiting)
                    match self.safety.check_tool_call(&tool_name, &safe_args) {
                        SafetyVerdict::Allow => {
                            // Proceed with tool execution
                        }
                        SafetyVerdict::BlockDoomLoop { reason } => {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: reason.clone(),
                                fatal: false,
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: reason,
                                is_error: Some(true),
                            });
                            continue;
                        }
                        SafetyVerdict::BlockRateLimit { reason } => {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: reason.clone(),
                                fatal: false,
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: reason,
                                is_error: Some(true),
                            });
                            continue;
                        }
                    }

                    let workflow_snapshot = self.workflow_state.snapshot();
                    // Ensure MCP annotations are loaded before firewall check
                    if crate::mcp::McpClient::is_mcp_tool(&tool_key) {
                        if let Err(error) = self.tool_executor.ensure_mcp_annotations().await {
                            report_diagnostic_nonblocking(format!(
                                "[agent] failed to refresh MCP annotations for {tool_key}: {error}"
                            ));
                        }
                    }
                    let is_external_tool = self.external_tools.contains(&tool_key);
                    let annotations = self.tool_executor.tool_annotations(&tool_key);
                    let firewall_verdict = if is_external_tool {
                        // The caller owns execution and applies its own sandbox and approval
                        // policy. The native firewall only governs native executors.
                        FirewallVerdict::Allow
                    } else {
                        firewall.check_tool_with_context(FirewallContext {
                            tool_name: &tool_key,
                            args: &args,
                            workflow_state: Some(&workflow_snapshot),
                            annotations: annotations.as_ref(),
                        })
                    };
                    if let FirewallVerdict::Block { reason } = &firewall_verdict {
                        self.drain_read_only_tool_calls(
                            &mut pending_read_only_tool_calls,
                            &mut tool_results,
                        )
                        .await?;
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: reason.clone(),
                            fatal: false,
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
                    let requires_approval = tool_requires_approval(
                        self.config.approval_mode,
                        is_external_tool,
                        &firewall_verdict,
                        &self.tool_executor,
                        &tool_name,
                        &args,
                    );

                    // `PermissionRequest` hooks are documented to run when a
                    // tool needs approval (docs/design/HOOKS_SYSTEM.md). This is
                    // the one place that decides that, so it is the only place
                    // the hook can run without disagreeing with the decision.
                    // A `Block` denies the call outright and the user is never
                    // asked; every other result falls through to the normal
                    // approval path, because an approval gate has nothing to do
                    // with modified input or injected context.
                    if requires_approval {
                        let permission = self.hooks.execute_permission_request(
                            &tool_name,
                            &call_id,
                            &args,
                            "tool requires approval",
                        );
                        if let HookResult::Block { reason } = permission {
                            self.drain_read_only_tool_calls(
                                &mut pending_read_only_tool_calls,
                                &mut tool_results,
                            )
                            .await?;
                            let message = format!("Tool denied by permission hook: {reason}");
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: message.clone(),
                                fatal: false,
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
                            self.tool_executor.get_inline_tool(&tool_name).map(|tool| {
                                let (shell, shell_arg) =
                                    self.tool_executor.inline_tool_effective_shell();
                                InlineToolApprovalContext {
                                    command: tool.definition.command.clone(),
                                    source_path: tool.source_path.display().to_string(),
                                    source_label: tool.source.label().to_string(),
                                    cwd: self.tool_executor.inline_tool_effective_cwd(tool),
                                    environment: self.tool_executor.inline_tool_effective_env(tool),
                                    shell,
                                    shell_arg: shell_arg.to_string(),
                                }
                            });
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
                    );
                    discard_cancelled_tool_responses(
                        &cancelled_ids,
                        &mut self.tool_response_rx,
                        &mut self.pending_tool_approvals,
                        &mut self.cancelled_tool_responses,
                    );
                }
                while let Some(deferred_call) = deferred_tool_calls_iter.next() {
                    match deferred_call {
                        DeferredToolCall::AwaitApproval(mut call) => {
                            let approval_cancel = self.shutdown_token.child_token();
                            self.set_active_approval_cancel_token(Some(approval_cancel.clone()));
                            let response = wait_for_tool_response(
                                &call.call_id,
                                &mut self.tool_response_rx,
                                &mut self.pending_tool_approvals,
                                &self.cancelled_tool_responses,
                                &approval_cancel,
                            )
                            .await;
                            self.set_active_approval_cancel_token(None);
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
                                    let (event, result_block) =
                                        cancelled_deferred_tool(&call, skipped_message);
                                    let _ = self.event_tx.send(event);
                                    tool_results.push(result_block);
                                    cancelled_ids.extend(cancel_deferred_suffix(
                                        &self.event_tx,
                                        deferred_tool_calls_iter.by_ref(),
                                        &mut tool_results,
                                    ));
                                    discard_cancelled_tool_responses(
                                        &cancelled_ids,
                                        &mut self.tool_response_rx,
                                        &mut self.pending_tool_approvals,
                                        &mut self.cancelled_tool_responses,
                                    );
                                    break;
                                }
                                ToolResponseWait::Closed => return Ok(()),
                            };
                            if approved && result.is_none() {
                                let (args, extra_context) =
                                    match rerun_deferred_pre_tool_use(&mut self.hooks, &call) {
                                        Ok(result) => result,
                                        Err(reason) => {
                                            let (events, result_block) =
                                                deferred_hook_block(&call, reason, false);
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
                                if crate::mcp::McpClient::is_mcp_tool(&tool_key) {
                                    let _ = self.tool_executor.ensure_mcp_annotations().await;
                                }
                                let is_external_tool = self.external_tools.contains(&tool_key);
                                let annotations = self.tool_executor.tool_annotations(&tool_key);
                                let workflow_snapshot = self.workflow_state.snapshot();
                                let firewall_verdict = deferred_firewall_verdict(
                                    &firewall,
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
                                    let current_env =
                                        self.tool_executor.get_inline_tool(&tool_key).map(|tool| {
                                            self.tool_executor.inline_tool_effective_env(tool)
                                        });
                                    if let Some(reason) = approved_inline_env_change_rejection(
                                        Some(&approved_context.environment),
                                        current_env.as_ref(),
                                    ) {
                                        emit_deferred_failure(
                                            &self.event_tx,
                                            &call,
                                            reason,
                                            &mut tool_results,
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
                                match deferred_execution_safety_verdict(&self.safety, &call) {
                                    SafetyVerdict::Allow => {}
                                    SafetyVerdict::BlockDoomLoop { reason }
                                    | SafetyVerdict::BlockRateLimit { reason } => {
                                        emit_deferred_failure(
                                            &self.event_tx,
                                            &call,
                                            &reason,
                                            &mut tool_results,
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
                                })
                            } else {
                                Some(ToolExecution::denied(
                                    &call.call_id,
                                    &call.tool_name,
                                    DenialReason::User,
                                ))
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
                                match rerun_deferred_pre_tool_use(&mut self.hooks, &call) {
                                    Ok(result) => result,
                                    Err(reason) => {
                                        let (events, result_block) =
                                            deferred_hook_block(&call, reason, true);
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
                                let _ = self
                                    .event_tx
                                    .send(deferred_safety_rejection_event(&call, &reason));
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
                            if crate::mcp::McpClient::is_mcp_tool(&tool_key) {
                                let _ = self.tool_executor.ensure_mcp_annotations().await;
                            }
                            let is_external_tool = self.external_tools.contains(&tool_key);
                            let annotations = self.tool_executor.tool_annotations(&tool_key);
                            let workflow_snapshot = self.workflow_state.snapshot();
                            let firewall_verdict = deferred_firewall_verdict(
                                &firewall,
                                &tool_key,
                                &call.args,
                                &workflow_snapshot,
                                annotations.as_ref(),
                                is_external_tool,
                            );
                            let deferred_policy_rejection = match &firewall_verdict {
                                FirewallVerdict::Block { reason } => Some(reason.clone()),
                                FirewallVerdict::RequireApproval { reason } => Some(format!(
                                    "Tool now requires approval after earlier tool execution: {reason}"
                                )),
                                FirewallVerdict::Allow => tool_requires_approval(
                                    self.config.approval_mode,
                                    is_external_tool,
                                    &firewall_verdict,
                                    &self.tool_executor,
                                    &tool_key,
                                    &call.args,
                                )
                                .then(|| {
                                    "Tool now requires approval after earlier tool execution"
                                        .to_string()
                                }),
                            };
                            let deferred_requires_approval =
                                matches!(firewall_verdict, FirewallVerdict::RequireApproval { .. })
                                    || tool_requires_approval(
                                        self.config.approval_mode,
                                        is_external_tool,
                                        &firewall_verdict,
                                        &self.tool_executor,
                                        &tool_key,
                                        &call.args,
                                    );
                            let _ = self
                                .event_tx
                                .send(deferred_tool_call_event(&call, deferred_requires_approval));
                            let mut rejected = false;
                            if let Some(reason) = deferred_policy_rejection {
                                let _ = self
                                    .event_tx
                                    .send(deferred_rejection_output_event(&call, &reason));
                                let _ = self
                                    .event_tx
                                    .send(deferred_policy_rejection_event(&call, &reason));
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
                            let safety_verdict = (!rejected)
                                .then(|| deferred_execution_safety_verdict(&self.safety, &call));
                            match safety_verdict {
                                None | Some(SafetyVerdict::Allow) => {}
                                Some(
                                    SafetyVerdict::BlockDoomLoop { reason }
                                    | SafetyVerdict::BlockRateLimit { reason },
                                ) => {
                                    let _ = self
                                        .event_tx
                                        .send(deferred_rejection_output_event(&call, &reason));
                                    let _ = self
                                        .event_tx
                                        .send(deferred_safety_rejection_event(&call, &reason));
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
                        );
                        discard_cancelled_tool_responses(
                            &cancelled_ids,
                            &mut self.tool_response_rx,
                            &mut self.pending_tool_approvals,
                            &mut self.cancelled_tool_responses,
                        );
                        break;
                    }
                }

                if deferred_steering.is_empty() {
                    if self.drain_pending_commands() {
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

                // Add tool results to history
                self.messages_mut().push(Message {
                    role: Role::User,
                    content: MessageContent::Blocks(tool_results),
                });
                if self.finish_tool_batch() || self.drain_pending_commands() {
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
                        continue 'turn;
                    }
                }

                // Continue the loop to process the tool results
                continue 'turn;
            }

            // No tool calls, we're done
            // Check for auto-compaction before the next turn
            if self.compactor.should_auto_compact(&self.messages) {
                let usage_pct = self.compactor.usage_percentage(&self.messages);
                eprintln!("[agent] Auto-compaction triggered at {usage_pct:.1}% capacity");
                let result = self.compactor.compact_with_tokens(&self.messages);
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
                        true,
                    );
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: status_msg,
                    });
                    self.messages = Arc::new(result.messages);
                    self.emit_conversation_snapshot();
                }
            }

            if self.drain_pending_commands() {
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
            );
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
            );
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
        }
        let result = ToolResult::success(lines.join("\n")).with_details(json!({
            "activated": activated,
            "nextTurn": true,
        }));
        let execution =
            ToolExecution::from_legacy(call_id, "tool_search", ExecutionSource::Native, result);
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
        if tool_name.eq_ignore_ascii_case("tool_search") {
            return self.execute_tool_search(args, call_id);
        }

        let cancel = self.shutdown_token.child_token();
        let terminal_drain_required =
            native_tool_requires_terminal_drain(&self.tool_executor, tool_name, args);
        self.set_active_tool_cancel_token(Some(cancel.clone()), terminal_drain_required);
        // Timed here because this is the one place the runner owns a single
        // tool's execution. `ExecutionReceipt::duration_ms` had no producer, so
        // the documented `durationMs` hook field could never be populated.
        let started = Instant::now();
        let execution = self
            .tool_executor
            .execute_with_receipt_cancellable_inline_env(
                tool_name,
                args,
                Some(&self.event_tx),
                call_id,
                ToolExecutionOptions {
                    cancel,
                    approved_inline_env,
                    hooks: Some(&mut self.hooks),
                },
            )
            .await;
        let execution = execution.with_duration(started.elapsed().as_millis() as u64);
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
        execution
    }

    /// Shared tail for a decided tool call: execute locally when the
    /// decision came back approved without a result, run post-execution
    /// hooks and safety bookkeeping, and build the `ToolResult` block sent
    /// back to the model.
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
        let mut result = result;
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
            } else {
                ToolExecution::denied(&call_id, &tool_name, DenialReason::User)
            }
        });

        let content = result.model_content();
        let is_error = result.is_error();

        let hook_outcome = if approved {
            // Execute hooks only for tools that were allowed to run.
            // Hooks contract on raw tool output, not the model-facing
            // envelope (see `ToolExecution::raw_content`).
            run_post_execution_hooks(
                &mut self.hooks,
                &tool_name,
                &call_id,
                &args,
                &result.raw_content(),
                is_error,
                result.receipt.duration_ms.unwrap_or(0),
            )
        } else {
            PostExecutionHooks::default()
        };
        // The gate's verdict changes what the model is told, not what the
        // workflow bookkeeping below records: the tool really did run.
        let reported_error = is_error || hook_outcome.rejected.is_some();

        // Append injected context if any. A `PostToolUse` hook's context was
        // computed and then dropped, so a hook that returned `contextToAdd`
        // had no effect on the request that followed.
        let mut result_content = append_hook_context(content, extra_context.as_deref());
        result_content = append_hook_context(result_content, hook_outcome.context.as_deref());
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

        // Record tool call for safety tracking (doom loop / rate limit)
        self.safety.record_tool_call(&tool_name, &safe_args);

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
        let cancelled_ids = cancel_deferred_suffix(&self.event_tx, deferred_calls, tool_results);
        discard_cancelled_tool_responses(
            &cancelled_ids,
            &mut self.tool_response_rx,
            &mut self.pending_tool_approvals,
            &mut self.cancelled_tool_responses,
        );
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
            Arc::clone(&self.tool_executor),
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
            });
            let content = result.model_content();
            let is_error = result.is_error();

            // Hooks contract on raw tool output, not the model-facing
            // envelope (see `ToolExecution::raw_content`).
            let hook_outcome = run_post_execution_hooks(
                &mut self.hooks,
                &call.tool_name,
                &call.call_id,
                &call.args,
                &result.raw_content(),
                is_error,
                result.receipt.duration_ms.unwrap_or(wave_duration_ms),
            );
            let reported_error = is_error || hook_outcome.rejected.is_some();

            let mut final_content = append_hook_context(content, call.extra_context.as_deref());
            final_content = append_hook_context(final_content, hook_outcome.context.as_deref());
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

            self.safety
                .record_tool_call(&call.tool_name, &call.safe_args);

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

fn conversation_snapshot_event(messages: &[Message]) -> Option<FromAgent> {
    let serialized = serde_json::to_value(sanitize_semantic_conversation(messages)).ok()?;
    let messages = serde_json::from_value(redact_semantic_snapshot_json(
        crate::agent::credential_store::redact_credentials_in_json(&serialized),
    ))
    .ok()?;
    Some(FromAgent::ConversationSnapshot {
        protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL.to_string(),
        messages,
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

/// Rewrite an empty native Bash call before validation, approval, and
/// execution so every caller observes and acts on the same command.
fn normalize_post_hook_tool_args(
    tool_name: &str,
    mut args: serde_json::Value,
) -> (serde_json::Value, bool) {
    if !tool_name.eq_ignore_ascii_case("bash") {
        return (args, false);
    }

    let Some(object) = args.as_object_mut() else {
        return (args, false);
    };
    let command_is_empty = object
        .get("command")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|command| command.trim().is_empty());
    if !command_is_empty {
        return (args, false);
    }

    object.insert("command".to_string(), serde_json::json!("pwd"));
    (args, true)
}

/// Build the tool executor `NativeAgentRunner` uses for every call it
/// executes itself: every [`ApprovalMode::Yolo`] call, and every
/// [`ApprovalMode::Selective`] call the per-tool heuristic doesn't flag for
/// approval (see [`NativeAgentConfig::sandbox_policy`]'s doc comment for why
/// this executor -- not a caller's separately-configured one -- is the one
/// that must carry the sandbox policy).
fn build_runner_tool_executor(
    cwd: &str,
    credential_vault: CredentialVault,
    sandbox_policy: Option<crate::sandbox::SandboxPolicy>,
    subagent_parent_scope_id: Option<String>,
) -> ToolExecutor {
    let executor = ToolExecutor::with_credential_vault(cwd, credential_vault);
    let executor = match sandbox_policy {
        Some(policy) => executor.with_sandbox_policy(policy),
        None => executor,
    };
    match subagent_parent_scope_id {
        Some(parent_scope_id) => executor.with_subagent_parent_scope(parent_scope_id),
        None => executor,
    }
}

/// Decide whether a tool call must wait for caller approval before the
/// runner executes it, given the active `ApprovalMode`.
///
/// This is the single decision point behind `requires_approval` in
/// `run_loop`, and it is also the value reported on the `FromAgent::ToolCall`
/// event. Callers with their own approval UI (the interactive TUI, the
/// headless server) trust that field instead of recomputing their own
/// verdict; keeping this logic in one pure function (rather than duplicated
/// per-caller, as it used to be split between here and `app.rs`) is what
/// prevents the two from disagreeing again -- see issues #3149 and #3156.
///
/// - `is_external_tool`: the caller owns execution and its own approval
///   policy for this tool (see [`NativeAgentRunner`]'s external-tools doc);
///   always requires approval regardless of mode.
/// - [`ApprovalMode::Yolo`]: never require approval for ordinary calls
///   (including firewall soft holds; a hard [`FirewallVerdict::Block`] is
///   handled separately and always denies regardless of mode). The one
///   exception is a `bypass_sandbox` request: waiving the native sandbox is
///   the per-command escape hatch and must always be a decision a human
///   explicitly makes, so it requires approval even in Yolo.
/// - [`ApprovalMode::Safe`]: always require approval.
/// - [`ApprovalMode::Selective`]: defer to the tool executor's static/dynamic
///   per-tool heuristic (e.g. `bash` inspects the command).
fn tool_requires_approval(
    approval_mode: ApprovalMode,
    is_external_tool: bool,
    firewall_verdict: &FirewallVerdict,
    tool_executor: &ToolExecutor,
    tool_name: &str,
    args: &serde_json::Value,
) -> bool {
    let mode_requires_approval = match approval_mode {
        ApprovalMode::Yolo => tool_executor.requires_sandbox_bypass_approval(tool_name, args),
        ApprovalMode::Safe => true,
        ApprovalMode::Selective => tool_executor.requires_approval(tool_name, args),
    };
    let firewall_requires_approval =
        matches!(firewall_verdict, FirewallVerdict::RequireApproval { .. })
            && approval_mode != ApprovalMode::Yolo;
    is_external_tool || mode_requires_approval || firewall_requires_approval
}

fn parse_tool_input(tool_name: &str, json: &str) -> Result<serde_json::Value, String> {
    if json.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(json)
        .map_err(|err| format!("Failed to parse tool input JSON for '{tool_name}': {err}"))
}

fn abort_pending_tools_after_stream_error(
    assistant_content: &mut Vec<ContentBlock>,
    pending_tool_calls: &mut Vec<(String, String, Value, Option<String>)>,
) {
    pending_tool_calls.clear();
    assistant_content.retain(|block| !matches!(block, ContentBlock::ToolUse { .. }));
}

/// Lifecycle managers must receive opaque credential references so child
/// prompts and durable records never receive the parent's resolved secrets.
/// The child receives the shared vault separately and resolves only at the
/// provider/tool execution boundary.
fn tool_args_for_execution(
    tool_name: &str,
    safe_args: &serde_json::Value,
    credential_vault: &CredentialVault,
) -> serde_json::Value {
    if tool_name.eq_ignore_ascii_case("spawn_subagent")
        || tool_name.eq_ignore_ascii_case("resume_subagent")
    {
        safe_args.clone()
    } else {
        credential_vault.resolve_in_json(safe_args)
    }
}

/// Everything needed to finish a tool call once its execution decision is
/// known. Approval-needing calls capture their hook-adjusted arguments when
/// their batched `ToolCall` event is emitted. Auto-approved calls behind that
/// boundary also retain the original model input so PreToolUse and all
/// argument derivations can be refreshed immediately before their event and
/// execution.
struct ToolCallContext {
    call_id: String,
    tool_name: String,
    args: serde_json::Value,
    safe_args: serde_json::Value,
    extra_context: Option<String>,
    pre_hook_args: serde_json::Value,
    initial_firewall_verdict: FirewallVerdict,
    /// Exact inline command and execution context captured before the approval
    /// event was emitted. Approved calls must still match its environment at
    /// execution time.
    approval_inline_env: Option<InlineToolApprovalContext>,
}

enum DeferredToolCall {
    AwaitApproval(ToolCallContext),
    Execute(ToolCallContext),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeferredToolCallDisposition {
    AwaitApproval,
    Execute,
}

fn deferred_tool_call_disposition(
    requires_approval: bool,
    has_prior_deferred_call: bool,
) -> Option<DeferredToolCallDisposition> {
    if requires_approval {
        Some(DeferredToolCallDisposition::AwaitApproval)
    } else if has_prior_deferred_call {
        Some(DeferredToolCallDisposition::Execute)
    } else {
        None
    }
}

/// Run `PreToolUse` for one call and reduce the result to the arguments to
/// execute with plus any context the hook injected.
///
/// `Err` carries the block reason. Every path that decides whether a tool runs
/// uses this, so a policy hook cannot be enforced on one transport and skipped
/// on another.
fn run_pre_tool_use_hook(
    hooks: &mut IntegratedHookSystem,
    tool_name: &str,
    call_id: &str,
    args: &serde_json::Value,
) -> Result<(serde_json::Value, Option<String>), String> {
    match hooks.execute_pre_tool_use(tool_name, call_id, args) {
        HookResult::Block { reason } => Err(reason),
        HookResult::ModifyInput { new_input } => Ok((new_input, None)),
        HookResult::InjectContext { context } => Ok((args.clone(), Some(context))),
        HookResult::Continue => Ok((args.clone(), None)),
    }
}

fn rerun_deferred_pre_tool_use(
    hooks: &mut IntegratedHookSystem,
    call: &ToolCallContext,
) -> Result<(serde_json::Value, Option<String>), String> {
    run_pre_tool_use_hook(hooks, &call.tool_name, &call.call_id, &call.pre_hook_args)
}

/// The context a hook asked to add, if it asked for any.
///
/// `PostToolUse` hooks return `hookSpecificOutput.contextToAdd` as
/// `InjectContext`; the documented effect is that the text reaches the model
/// with the tool result.
fn hook_injected_context(result: HookResult) -> Option<String> {
    match result {
        HookResult::InjectContext { context } => Some(context),
        _ => None,
    }
}

/// What the post-execution hooks asked for on one finished tool call.
#[derive(Default)]
struct PostExecutionHooks {
    /// Context the hooks asked to add to the tool result.
    context: Option<String>,
    /// Why an `EvalGate` hook rejected the result, if it did.
    rejected: Option<String>,
}

/// Run `PostToolUse` and then `EvalGate` for one finished tool call.
///
/// `EvalGate` receives the same tool name, arguments, and raw output; its input
/// type is shaped for exactly this point and it had no dispatch site at all, so
/// a configured evaluation hook silently never ran. It runs after `PostToolUse`
/// so a gate scores the result a `PostToolUse` hook has already observed.
///
/// A gate's `block` cannot un-run the tool, so it is reported as a failed tool
/// result rather than pretending the call was prevented.
fn run_post_execution_hooks(
    hooks: &mut IntegratedHookSystem,
    tool_name: &str,
    call_id: &str,
    args: &serde_json::Value,
    raw_output: &str,
    is_error: bool,
    duration_ms: u64,
) -> PostExecutionHooks {
    let mut outcome = PostExecutionHooks {
        context: hook_injected_context(hooks.execute_post_tool_use(
            tool_name,
            call_id,
            args,
            raw_output,
            is_error,
            duration_ms,
        )),
        rejected: None,
    };

    match hooks.execute_eval_gate(tool_name, call_id, args, raw_output) {
        HookResult::Block { reason } => outcome.rejected = Some(reason),
        gate => {
            if let Some(gate_context) = hook_injected_context(gate) {
                outcome.context = Some(match outcome.context {
                    Some(existing) => format!("{existing}\n\n{gate_context}"),
                    None => gate_context,
                });
            }
        }
    }
    outcome
}

/// Append hook-injected context to a tool result body.
///
/// Empty or whitespace-only context is dropped rather than appended as blank
/// lines the model has to read.
fn append_hook_context(content: String, context: Option<&str>) -> String {
    match context {
        Some(context) if !context.trim().is_empty() => format!("{content}\n\n{context}"),
        _ => content,
    }
}

fn deferred_tool_call_event(call: &ToolCallContext, requires_approval: bool) -> FromAgent {
    FromAgent::ToolCall {
        call_id: call.call_id.clone(),
        tool: call.tool_name.clone(),
        args: call.safe_args.clone(),
        requires_approval,
        approval_inline_env: if requires_approval {
            call.approval_inline_env.clone()
        } else {
            None
        },
    }
}

fn deferred_approved_policy_rejection(
    initial_verdict: &FirewallVerdict,
    current_verdict: FirewallVerdict,
) -> Option<String> {
    match current_verdict {
        FirewallVerdict::Block { reason } => Some(reason),
        FirewallVerdict::RequireApproval { reason }
            if !matches!(
                initial_verdict,
                FirewallVerdict::RequireApproval {
                    reason: initial_reason
                } if initial_reason == &reason
            ) =>
        {
            Some(format!(
                "Tool requires fresh approval after earlier tool execution: {reason}"
            ))
        }
        FirewallVerdict::RequireApproval { .. } | FirewallVerdict::Allow => None,
    }
}

fn approved_input_change_rejection(
    approved_args: &serde_json::Value,
    refreshed_args: &serde_json::Value,
) -> Option<&'static str> {
    (approved_args != refreshed_args)
        .then_some("Tool input changed after approval; retry to review refreshed input")
}

fn approved_inline_env_change_rejection(
    approved_env: Option<&HashMap<String, String>>,
    current_env: Option<&HashMap<String, String>>,
) -> Option<&'static str> {
    approved_env
        .is_some_and(|approved| current_env != Some(approved))
        .then_some(
            "Inline tool environment changed after approval; retry to review refreshed environment",
        )
}

fn clear_stashed_prompts(deferred_commands: &mut VecDeque<AgentCommand>) -> usize {
    let original_len = deferred_commands.len();
    deferred_commands.retain(|command| {
        !matches!(
            command,
            AgentCommand::Prompt {
                kind,
                ..
            } if prompt_kind_starts_main_request(*kind)
        )
    });
    original_len - deferred_commands.len()
}

fn deferred_hook_block(
    call: &ToolCallContext,
    reason: String,
    emit_tool_call: bool,
) -> (Vec<FromAgent>, ContentBlock) {
    let message = format!("Tool blocked by hook: {reason}");
    let mut events = Vec::with_capacity(4);
    if emit_tool_call {
        events.push(deferred_tool_call_event(call, false));
    }
    events.extend([
        FromAgent::HookBlocked {
            call_id: call.call_id.clone(),
            tool: call.tool_name.clone(),
            reason,
        },
        deferred_rejection_output_event(call, &message),
        deferred_safety_rejection_event(call, &message),
    ]);
    (
        events,
        ContentBlock::ToolResult {
            tool_use_id: call.call_id.clone(),
            content: message,
            is_error: Some(true),
        },
    )
}

fn emit_deferred_failure(
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    call: &ToolCallContext,
    reason: &str,
    tool_results: &mut Vec<ContentBlock>,
) {
    let _ = event_tx.send(deferred_rejection_output_event(call, reason));
    let _ = event_tx.send(deferred_safety_rejection_event(call, reason));
    tool_results.push(ContentBlock::ToolResult {
        tool_use_id: call.call_id.clone(),
        content: reason.to_string(),
        is_error: Some(true),
    });
}

fn emit_deferred_policy_failure(
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    call: &ToolCallContext,
    reason: &str,
    tool_results: &mut Vec<ContentBlock>,
) {
    let _ = event_tx.send(deferred_rejection_output_event(call, reason));
    let _ = event_tx.send(deferred_policy_rejection_event(call, reason));
    tool_results.push(ContentBlock::ToolResult {
        tool_use_id: call.call_id.clone(),
        content: reason.to_string(),
        is_error: Some(true),
    });
}

fn invalidate_cache_after_serial_tool(
    tool_executor: &ToolExecutor,
    tool_name: &str,
    executed: bool,
) {
    if executed && tool_can_change_workspace(tool_name) {
        tool_executor.clear_cache();
    }
}

fn tool_can_change_workspace(tool_name: &str) -> bool {
    !matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "read"
            | "read_image"
            | "glob"
            | "grep"
            | "diff"
            | "list"
            | "find"
            | "search"
            | "parallel_ripgrep"
            | "explore"
            | "websearch"
            | "codesearch"
            | "status"
            | "ask_user"
            | "extract_document"
            | "web_fetch"
            | "webfetch"
            | "screenshot"
            | "mcp_list_resources"
            | "mcp_list_prompts"
            | "mcp_read_resource"
            | "mcp_get_prompt"
            | "get_goal"
            | "vscode_get_diagnostics"
            | "jetbrains_get_diagnostics"
            | "vscode_get_definition"
            | "jetbrains_get_definition"
            | "vscode_find_references"
            | "jetbrains_find_references"
            | "vscode_read_file_range"
            | "jetbrains_read_file_range"
    )
}

fn tool_is_visible_to_model(
    tool_name: &str,
    goal_tools_visible: bool,
    include_ide_tools: bool,
) -> bool {
    let name = tool_name.to_ascii_lowercase();
    if matches!(name.as_str(), "get_goal" | "update_goal") {
        return goal_tools_visible;
    }
    include_ide_tools || !(name.starts_with("vscode_") || name.starts_with("jetbrains_"))
}

fn deferred_firewall_verdict(
    firewall: &ActionFirewall,
    tool_name: &str,
    args: &serde_json::Value,
    workflow_snapshot: &crate::safety::WorkflowStateSnapshot,
    annotations: Option<&crate::mcp::McpToolAnnotations>,
    is_external_tool: bool,
) -> FirewallVerdict {
    if is_external_tool {
        FirewallVerdict::Allow
    } else {
        firewall.check_tool_with_context(FirewallContext {
            tool_name,
            args,
            workflow_state: Some(workflow_snapshot),
            annotations,
        })
    }
}

fn deferred_execution_safety_verdict(
    safety: &SafetyController,
    call: &ToolCallContext,
) -> SafetyVerdict {
    safety.check_tool_call(&call.tool_name, &call.safe_args)
}

fn deferred_rejection_output_event(call: &ToolCallContext, reason: &str) -> FromAgent {
    FromAgent::ToolOutput {
        call_id: call.call_id.clone(),
        content: reason.to_string(),
    }
}

fn deferred_safety_rejection_event(call: &ToolCallContext, reason: &str) -> FromAgent {
    let result = ToolResult::failure(reason);
    let receipt = ToolExecution::from_legacy(
        &call.call_id,
        &call.tool_name,
        ExecutionSource::Native,
        result.clone(),
    )
    .receipt;
    FromAgent::ToolEnd {
        call_id: call.call_id.clone(),
        success: false,
        result: Some(result),
        receipt: Some(receipt),
    }
}

fn deferred_policy_rejection_event(call: &ToolCallContext, reason: &str) -> FromAgent {
    let execution = ToolExecution::denied(
        &call.call_id,
        &call.tool_name,
        DenialReason::ActionFirewall {
            message: reason.to_string(),
        },
    );
    FromAgent::ToolEnd {
        call_id: call.call_id.clone(),
        success: false,
        result: Some(execution.to_legacy()),
        receipt: Some(execution.receipt),
    }
}

fn cancelled_deferred_tool(call: &ToolCallContext, reason: &str) -> (FromAgent, ContentBlock) {
    let execution = ToolExecution::cancelled(
        &call.call_id,
        &call.tool_name,
        ExecutionSource::Native,
        ExecutionPhase::Queued,
    );
    let result = ToolResult::failure(reason);
    (
        FromAgent::ToolEnd {
            call_id: call.call_id.clone(),
            success: false,
            result: Some(result),
            receipt: Some(execution.receipt),
        },
        ContentBlock::ToolResult {
            tool_use_id: call.call_id.clone(),
            content: reason.to_string(),
            is_error: Some(true),
        },
    )
}

fn cancel_deferred_suffix(
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    deferred_calls: impl IntoIterator<Item = DeferredToolCall>,
    tool_results: &mut Vec<ContentBlock>,
) -> HashSet<String> {
    let skipped_message = "Skipped after request cancellation.";
    let mut cancelled_ids = HashSet::new();
    for skipped_call in deferred_calls {
        let (call, needs_tool_call) = match skipped_call {
            DeferredToolCall::AwaitApproval(call) => (call, false),
            DeferredToolCall::Execute(call) => (call, true),
        };
        cancelled_ids.insert(call.call_id.clone());
        if needs_tool_call {
            let _ = event_tx.send(deferred_tool_call_event(&call, false));
        }
        let _ = event_tx.send(FromAgent::ToolOutput {
            call_id: call.call_id.clone(),
            content: skipped_message.to_string(),
        });
        let (event, result_block) = cancelled_deferred_tool(&call, skipped_message);
        let _ = event_tx.send(event);
        tool_results.push(result_block);
    }
    cancelled_ids
}

fn discard_cancelled_tool_responses(
    cancelled_ids: &HashSet<String>,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &mut CancelledToolTombstones,
) {
    for call_id in cancelled_ids {
        tombstones.insert(call_id.clone());
    }
    let pending_cancelled = pending
        .keys()
        .filter(|call_id| cancelled_ids.contains(*call_id))
        .cloned()
        .collect::<Vec<_>>();
    for call_id in pending_cancelled {
        if let Some((_, _, _, Some(consumed))) = pending.remove(&call_id) {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    }
    while let Ok((call_id, approved, result, source, consumed)) = rx.try_recv() {
        if tombstones.contains(&call_id) {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response cancelled before native consumption".to_string(),
                });
            }
        } else {
            pending.insert(call_id, (approved, result, source, consumed));
        }
    }
}

fn reject_buffered_tool_responses_on_cancel(pending: &mut HashMap<String, PendingToolResponse>) {
    for (_, _, _, consumed) in pending.drain().map(|(_, value)| value) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    }
}

fn buffer_or_reject_tool_response(
    response: ToolResponseMessage,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
) {
    let (call_id, approved, result, source, consumed) = response;
    if tombstones.contains(&call_id) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    } else {
        pending.insert(call_id, (approved, result, source, consumed));
    }
}

enum ToolResponseWait {
    Response((bool, Option<ToolResult>, ExecutionSource)),
    Cancelled,
    Closed,
}

async fn wait_for_codex_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
    cancel: &CancellationToken,
) -> ToolResponseWait {
    wait_for_tool_response(call_id, rx, pending, tombstones, cancel).await
}

async fn wait_for_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
    cancel: &CancellationToken,
) -> ToolResponseWait {
    if cancel.is_cancelled() {
        return ToolResponseWait::Cancelled;
    }
    if let Some((approved, result, source, consumed)) = pending.remove(call_id) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Accepted);
        }
        return ToolResponseWait::Response((approved, result, source));
    }

    loop {
        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return ToolResponseWait::Cancelled,
            response = rx.recv() => response,
        };
        let Some((id, approved, result, source, consumed)) = response else {
            return ToolResponseWait::Closed;
        };
        if tombstones.contains(&id) {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response cancelled before native consumption".to_string(),
                });
            }
            continue;
        }
        if id == call_id {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Accepted);
            }
            return ToolResponseWait::Response((approved, result, source));
        }
        pending.insert(id, (approved, result, source, consumed));
    }
}

/// Append failure tool results for any assistant `ToolUse` block in `messages`
/// that has no matching `ToolResult`, so an interrupted turn can never leave
/// the history with orphaned tool calls.
///
/// Repairs are grouped into the user message that already carries results for
/// the same assistant message when one exists, otherwise inserted immediately
/// after it, keeping the `ToolUse`/`ToolResult` pairing both the OpenAI and
/// Anthropic serializers require. A real result delivered late (stashed in
/// `pending_tool_approvals`) is used when available; otherwise a
/// "cancelled by user" failure is synthesized.
fn repair_orphaned_tool_calls(
    messages: &mut Vec<Message>,
    pending_tool_approvals: &mut HashMap<String, PendingToolResponse>,
) {
    let mut answered: HashSet<String> = HashSet::new();
    for message in messages.iter() {
        if let MessageContent::Blocks(blocks) = &message.content {
            for block in blocks {
                if let ContentBlock::ToolResult { tool_use_id, .. } = block {
                    answered.insert(tool_use_id.clone());
                }
            }
        }
    }

    let mut index = 0;
    while index < messages.len() {
        let missing: Vec<(String, String)> = match &messages[index] {
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(blocks),
            } => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, .. } if !answered.contains(id) => {
                        Some((id.clone(), name.clone()))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };

        if missing.is_empty() {
            index += 1;
            continue;
        }

        let repairs: Vec<ContentBlock> = missing
            .into_iter()
            .map(|(id, name)| {
                let pending = pending_tool_approvals.remove(&id).map(
                    |(approved, result, source, consumed)| {
                        if let Some(consumed) = consumed {
                            let _ = consumed.send(ToolResponseConsumption::Accepted);
                        }
                        (approved, result, source)
                    },
                );
                let (content, is_error) = match pending {
                    Some((true, Some(result), source)) => {
                        let execution = ToolExecution::from_legacy(&id, &name, source, result);
                        (execution.model_content(), execution.is_error())
                    }
                    Some((approved, result, source)) => {
                        let execution = if approved {
                            ToolExecution::from_legacy(
                                &id,
                                &name,
                                source,
                                result.unwrap_or_else(|| {
                                    ToolResult::failure("Tool task did not return a result")
                                }),
                            )
                        } else {
                            ToolExecution::denied(&id, &name, DenialReason::User)
                        };
                        (execution.model_content(), execution.is_error())
                    }
                    None => ("Tool execution cancelled by user.".to_string(), true),
                };
                answered.insert(id.clone());
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    content,
                    is_error: Some(is_error),
                }
            })
            .collect();

        // Merge into the existing tool-result message when one already
        // follows this assistant message; otherwise insert a new one.
        let merge_target = match messages.get_mut(index + 1) {
            Some(Message {
                role: Role::User,
                content: MessageContent::Blocks(blocks),
            }) if blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolResult { .. })) =>
            {
                Some(blocks)
            }
            _ => None,
        };
        match merge_target {
            Some(blocks) => blocks.extend(repairs),
            None => messages.insert(
                index + 1,
                Message {
                    role: Role::User,
                    content: MessageContent::Blocks(repairs),
                },
            ),
        }
        index += 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn codex_models_resolve_to_app_server_without_http_credentials() {
        let (client, provider) =
            resolve_native_client("openai-codex/gpt-5.5", None).expect("Codex transport");
        assert!(client.is_none());
        assert_eq!(provider, "openai-codex");
    }

    #[test]
    fn goal_tools_visibility_tracks_update_goal_results() {
        for (status, expected) in [
            ("active", true),
            ("paused", true),
            ("blocked", true),
            ("complete", false),
        ] {
            let execution = ToolExecution::from_legacy(
                "call-1",
                "update_goal",
                ExecutionSource::Native,
                ToolResult::success(serde_json::json!({"goal": {"status": status}}).to_string()),
            );
            assert_eq!(
                goal_tools_visible_from_execution(&execution),
                Some(expected),
                "unexpected visibility for goal status {status}"
            );
        }

        let failed = ToolExecution::from_legacy(
            "call-2",
            "update_goal",
            ExecutionSource::Native,
            ToolResult::failure("goal update failed"),
        );
        assert_eq!(goal_tools_visible_from_execution(&failed), None);

        let malformed = ToolExecution::from_legacy(
            "call-3",
            "update_goal",
            ExecutionSource::Native,
            ToolResult::success("not json"),
        );
        assert_eq!(goal_tools_visible_from_execution(&malformed), None);
    }

    #[test]
    fn codex_wire_results_resolve_vaulted_credentials_without_mutating_input() {
        let vault = CredentialVault::new();
        let reference = vault.store(
            "child-discovered-secret",
            crate::agent::CredentialType::Secret,
        );
        let vaulted = format!("child result: {reference}");

        let response = resolve_codex_tool_result_for_wire(&vault, &vaulted);

        assert_eq!(response, "child result: child-discovered-secret");
        assert_eq!(vaulted, format!("child result: {reference}"));
    }

    #[test]
    fn ide_tool_flag_accepts_only_explicit_truthy_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(include_ide_tools_enabled_value(value), "{value:?}");
        }
        for value in ["", "0", "false", "y", "random"] {
            assert!(!include_ide_tools_enabled_value(value), "{value:?}");
        }
    }

    async fn read_scripted_provider_request(
        stream: &mut tokio::net::TcpStream,
    ) -> serde_json::Value {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await.expect("read request");
            assert!(read > 0, "provider request closed before headers");
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("header end");
        let headers = String::from_utf8_lossy(&buffer[..header_end]);
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .find_map(|(_, value)| value.trim().parse::<usize>().ok())
            .expect("content length");
        let body_start = header_end + 4;
        while buffer.len() - body_start < content_length {
            let read = stream.read(&mut chunk).await.expect("read request body");
            assert!(read > 0, "provider request closed before body");
            buffer.extend_from_slice(&chunk[..read]);
        }
        serde_json::from_slice(&buffer[body_start..body_start + content_length])
            .expect("provider request json")
    }

    fn chat_sse_response(id: &str, content: &str, tool_call: bool) -> String {
        let mut events = vec![serde_json::json!({
            "id": id, "object": "chat.completion.chunk", "created": 0,
            "model": "gpt-4o", "choices": [{"index": 0,
                "delta": {"role": "assistant", "content": content}, "finish_reason": null}]
        })];
        if tool_call {
            events.push(serde_json::json!({
                "id": id, "object": "chat.completion.chunk", "created": 0,
                "model": "gpt-4o", "choices": [{"index": 0,
                    "delta": {"tool_calls": [{"index": 0, "id": "call-native-1", "type": "function",
                        "function": {"name": "read", "arguments": "{\"path\":\"Cargo.toml\"}"}}]},
                    "finish_reason": "tool_calls"}]
            }));
        } else {
            events.push(serde_json::json!({
                "id": id, "object": "chat.completion.chunk", "created": 0,
                "model": "gpt-4o", "choices": [{"index": 0,
                    "delta": {}, "finish_reason": "stop"}]
            }));
        }
        let mut body = String::new();
        for event in events {
            write!(body, "data: {event}\n\n").expect("write SSE event");
        }
        body.push_str("data: [DONE]\n\n");
        body
    }

    async fn scripted_native_provider() -> (String, Arc<Mutex<Vec<serde_json::Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind provider");
        let address = listener.local_addr().expect("provider address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        tokio::spawn(async move {
            for (index, response) in [
                chat_sse_response("first-tool", "I will read it.", true),
                chat_sse_response("first-final", "The first turn is complete.", false),
                chat_sse_response("second-final", "Continuation observed.", false),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut stream, _) = listener.accept().await.expect("provider accept");
                let request = read_scripted_provider_request(&mut stream).await;
                captured.lock().unwrap().push(request);
                let wire = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(), response
                );
                stream
                    .write_all(wire.as_bytes())
                    .await
                    .expect("provider response");
                if index == 2 {
                    break;
                }
            }
        });
        (format!("http://{address}/v1"), requests)
    }

    #[tokio::test]
    async fn native_provider_checkpoint_survives_process_death_and_restores_tool_continuity() {
        let (base_url, requests) = scripted_native_provider().await;
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(
            workspace.path().join("Cargo.toml"),
            "[package]\nname = \"fixture\"\n",
        )
        .expect("fixture file");
        let config = NativeAgentConfig {
            model: "openai/gpt-4o".to_owned(),
            cwd: workspace.path().display().to_string(),
            approval_mode: ApprovalMode::Yolo,
            ..NativeAgentConfig::default()
        };
        let source_client = UnifiedClient::OpenAI(
            crate::ai::OpenAiClient::with_base_url("test-key", base_url.clone())
                .expect("source client"),
        );
        let (source, mut source_events) =
            NativeAgent::new_with_test_client(config.clone(), source_client).expect("source agent");
        source
            .prompt("first turn".to_owned(), vec![])
            .await
            .expect("source prompt");

        let sessions = tempfile::tempdir().expect("sessions");
        let mut recorder =
            crate::headless::SessionRecorder::new(sessions.path()).expect("session recorder");
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match source_events.recv().await {
                    Some(FromAgent::ConversationSnapshot { messages, .. }) => break messages,
                    Some(FromAgent::Error { message, .. }) => {
                        panic!("fixture agent error: {message}")
                    }
                    Some(_) => continue,
                    None => panic!("source event channel closed before snapshot"),
                }
            }
        })
        .await
        .expect("runtime snapshot timeout");
        recorder
            .record_received(
                &crate::headless::messages::FromAgentMessage::ConversationSnapshot {
                    protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL
                        .to_owned(),
                    messages: snapshot,
                },
            )
            .expect("persist runtime snapshot");
        let session_id = recorder.id().to_owned();
        drop(recorder);
        source.shutdown().await;

        let restored_history =
            crate::headless::SessionRecorder::resume(sessions.path(), &session_id)
                .expect("resume runtime checkpoint")
                .replay()
                .semantic_conversation
                .expect("restored semantic history");
        let restored_client = UnifiedClient::OpenAI(
            crate::ai::OpenAiClient::with_base_url("test-key", base_url).expect("restored client"),
        );
        let (restored, mut restored_events) =
            NativeAgent::new_with_test_client(config, restored_client).expect("restored agent");
        restored.replace_history(restored_history);
        restored
            .prompt("second turn".to_owned(), vec![])
            .await
            .expect("second prompt");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(event) = restored_events.recv().await {
                if matches!(event, FromAgent::ConversationSnapshot { .. }) {
                    break;
                }
            }
        })
        .await
        .expect("second terminal snapshot timeout");
        restored.shutdown().await;

        let captured = requests.lock().unwrap();
        assert_eq!(captured.len(), 3);
        let continuation = serde_json::to_string(&captured[2]).expect("continuation request json");
        assert!(continuation.contains("first turn"), "{continuation}");
        assert!(continuation.contains("call-native-1"), "{continuation}");
        assert!(continuation.contains("second turn"), "{continuation}");
    }

    #[test]
    fn semantic_checkpoint_excludes_thinking_and_raw_tool_output_but_keeps_tool_pair_ids() {
        let checkpoint = sanitize_semantic_conversation(&[
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(vec![
                    ContentBlock::Thinking {
                        thinking: "hidden chain of thought".to_owned(),
                        signature: Some("signature".to_owned()),
                    },
                    ContentBlock::ToolUse {
                        id: "call-1".to_owned(),
                        name: "read".to_owned(),
                        input: serde_json::json!({ "path": "src/lib.rs" }),
                    },
                ]),
            },
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "call-1".to_owned(),
                    content: "unbounded private file content".to_owned(),
                    is_error: Some(false),
                }]),
            },
        ]);

        let json = serde_json::to_string(&checkpoint).unwrap();
        assert!(!json.contains("hidden chain of thought"));
        assert!(!json.contains("unbounded private file content"));
        assert!(json.contains("call-1"));
        assert!(json.contains("[tool result omitted from checkpoint]"));
    }

    #[test]
    fn terminal_snapshot_event_is_emitted_with_the_public_continue_terminal_shape() {
        let event = conversation_snapshot_event(&[Message {
            role: Role::User,
            content: MessageContent::text("continue from this context"),
        }])
        .expect("snapshot event");

        assert!(matches!(
            event,
            FromAgent::ConversationSnapshot { messages, .. }
                if messages.len() == 1 && messages[0].content.as_text() == Some("continue from this context")
        ));
    }

    #[test]
    fn codex_dynamic_tool_pair_is_retained_in_ordered_terminal_snapshot() {
        let mut messages = vec![Message {
            role: Role::Assistant,
            content: MessageContent::text("I'll inspect that first."),
        }];
        append_codex_tool_use(
            &mut messages,
            "codex-call-1",
            "read",
            serde_json::json!({ "path": "src/lib.rs" }),
        );
        append_codex_tool_result(
            &mut messages,
            "codex-call-1",
            "simulated tool failure".to_owned(),
            true,
        );

        let FromAgent::ConversationSnapshot { messages, .. } =
            conversation_snapshot_event(&messages).expect("snapshot")
        else {
            panic!("expected semantic snapshot");
        };
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0].content.as_text(),
            Some("I'll inspect that first.")
        );
        assert!(matches!(
            &messages[1].content,
            MessageContent::Blocks(blocks)
                if matches!(&blocks[0], ContentBlock::ToolUse { id, .. } if id == "codex-call-1")
        ));
        assert!(matches!(
            &messages[2].content,
            MessageContent::Blocks(blocks)
                if matches!(&blocks[0], ContentBlock::ToolResult { tool_use_id, is_error: Some(true), .. } if tool_use_id == "codex-call-1")
        ));
    }

    #[test]
    fn codex_completion_delta_is_emitted_once_and_reaches_terminal_snapshot() {
        let (visible_completion, full_text) =
            NativeAgentRunner::reconcile_codex_completion_text("prefix ", "suffix", false);
        assert_eq!(visible_completion, "suffix");
        assert_eq!(full_text, "prefix suffix");

        let FromAgent::ConversationSnapshot { messages, .. } =
            conversation_snapshot_event(&[Message {
                role: Role::Assistant,
                content: MessageContent::Text(full_text),
            }])
            .expect("terminal snapshot")
        else {
            panic!("expected semantic snapshot");
        };
        assert_eq!(messages[0].content.as_text(), Some("prefix suffix"));
    }

    #[test]
    fn codex_completion_reconciliation_accepts_suffix_or_authoritative_full_text() {
        assert_eq!(
            NativeAgentRunner::reconcile_codex_completion_text("prefix ", "suffix", false),
            ("suffix".to_owned(), "prefix suffix".to_owned())
        );
        assert_eq!(
            NativeAgentRunner::reconcile_codex_completion_text("prefix ", "prefix suffix", true),
            ("suffix".to_owned(), "prefix suffix".to_owned())
        );
    }

    #[test]
    fn codex_divergent_authoritative_completion_reaches_terminal_snapshot() {
        let (visible_completion, full_text) =
            NativeAgentRunner::reconcile_codex_completion_text("partial", "full answer", true);
        assert!(visible_completion.is_empty());

        let final_text =
            NativeAgentRunner::codex_terminal_assistant_text("partial".to_owned(), full_text, true);
        let FromAgent::ConversationSnapshot { messages, .. } =
            conversation_snapshot_event(&[Message {
                role: Role::Assistant,
                content: MessageContent::Text(final_text),
            }])
            .expect("terminal snapshot")
        else {
            panic!("expected semantic snapshot");
        };
        assert_eq!(messages[0].content.as_text(), Some("full answer"));
    }

    #[test]
    fn codex_authoritative_segments_preserve_tool_boundaries_without_duplication() {
        let (_, before) =
            NativeAgentRunner::reconcile_codex_completion_text("draft before", "before", true);
        let mut messages = vec![Message {
            role: Role::Assistant,
            content: MessageContent::Text(before),
        }];
        append_codex_tool_use(
            &mut messages,
            "call-1",
            "read",
            serde_json::json!({ "path": "src/lib.rs" }),
        );
        append_codex_tool_result(&mut messages, "call-1", "tool output".to_owned(), false);
        let (_, after) =
            NativeAgentRunner::reconcile_codex_completion_text("draft after", "after", true);
        messages.push(Message {
            role: Role::Assistant,
            content: MessageContent::Text(after),
        });

        let FromAgent::ConversationSnapshot { messages, .. } =
            conversation_snapshot_event(&messages).expect("terminal snapshot")
        else {
            panic!("expected semantic snapshot");
        };
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].content.as_text(), Some("before"));
        assert_eq!(messages[3].content.as_text(), Some("after"));
        assert!(!messages[3]
            .content
            .as_text()
            .expect("final assistant text")
            .contains("before"));
    }

    #[tokio::test]
    async fn codex_process_continuation_fixture() {
        let Ok(role) = std::env::var("MAESTRO_CODEX_FIXTURE_ROLE") else {
            return;
        };
        let workspace = std::path::PathBuf::from(
            std::env::var("MAESTRO_CODEX_FIXTURE_WORKSPACE").expect("fixture workspace"),
        );
        let checkpoint = std::path::PathBuf::from(
            std::env::var("MAESTRO_CODEX_FIXTURE_CHECKPOINT").expect("fixture checkpoint"),
        );
        let config = NativeAgentConfig {
            model: "openai-codex/gpt-5.5".to_owned(),
            cwd: workspace.display().to_string(),
            approval_mode: ApprovalMode::Yolo,
            ..NativeAgentConfig::default()
        };
        let (agent, mut events) = NativeAgent::new(config).expect("Codex fixture agent");
        if role == "restore" {
            let history =
                serde_json::from_slice(&std::fs::read(&checkpoint).expect("hydrated checkpoint"))
                    .expect("checkpoint messages");
            agent.replace_history(history);
        } else if std::env::var_os("MAESTRO_CODEX_FIXTURE_OVERSIZED").is_some() {
            let mut history = vec![Message {
                role: Role::User,
                content: MessageContent::Text("older context".to_owned()),
            }];
            append_codex_tool_use(
                &mut history,
                "bounded-call-1",
                "read",
                serde_json::json!({ "payload": "x".repeat(500_000) }),
            );
            append_codex_tool_result(
                &mut history,
                "bounded-call-1",
                "bounded tool result".to_owned(),
                false,
            );
            agent.replace_history(history);
        }
        agent
            .prompt(
                if role == "source" {
                    "first prompt".to_owned()
                } else {
                    "second prompt".to_owned()
                },
                vec![],
            )
            .await
            .expect("fixture prompt");
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                match events.recv().await {
                    Some(FromAgent::ConversationSnapshot { messages, .. }) => break messages,
                    Some(_) => continue,
                    None => panic!("fixture closed before terminal snapshot"),
                }
            }
        })
        .await
        .expect("fixture snapshot timeout");
        if role == "source" {
            std::fs::write(
                &checkpoint,
                serde_json::to_vec(&snapshot).expect("snapshot json"),
            )
            .expect("persist runtime checkpoint");
        }
        agent.shutdown().await;
    }

    async fn receive_codex_fixture_snapshot(
        events: &mut mpsc::UnboundedReceiver<FromAgent>,
    ) -> (Vec<Message>, Vec<String>, Vec<String>) {
        tokio::time::timeout(std::time::Duration::from_secs(12), async {
            let mut errors = Vec::new();
            let mut statuses = Vec::new();
            loop {
                match events.recv().await {
                    Some(FromAgent::Error { message, .. }) => errors.push(message),
                    Some(FromAgent::Status { message }) => statuses.push(message),
                    Some(FromAgent::ConversationSnapshot { messages, .. }) => {
                        break (messages, errors, statuses);
                    }
                    Some(_) => {}
                    None => panic!("fixture closed before terminal snapshot"),
                }
            }
        })
        .await
        .expect("fixture snapshot timeout")
    }

    #[tokio::test]
    async fn codex_pre_turn_failure_fixture() {
        let Ok(scenario) = std::env::var("MAESTRO_CODEX_FAILURE_SCENARIO") else {
            return;
        };
        let workspace = std::path::PathBuf::from(
            std::env::var("MAESTRO_CODEX_FIXTURE_WORKSPACE").expect("fixture workspace"),
        );
        let checkpoint = std::path::PathBuf::from(
            std::env::var("MAESTRO_CODEX_FIXTURE_CHECKPOINT").expect("fixture checkpoint"),
        );
        let history: Vec<Message> =
            serde_json::from_slice(&std::fs::read(&checkpoint).expect("fixture checkpoint"))
                .expect("checkpoint messages");
        let config = NativeAgentConfig {
            model: "openai-codex/gpt-5.5".to_owned(),
            cwd: workspace.display().to_string(),
            approval_mode: ApprovalMode::Yolo,
            ..NativeAgentConfig::default()
        };
        let (agent, mut events) = NativeAgent::new(config).expect("Codex fixture agent");
        agent.replace_history(history);

        let prompts: &[&str] = match scenario.as_str() {
            "transient-inject" => &["retry prompt"],
            "exhausted-start" => &["failed prompt", "second prompt"],
            "cancelled-start" => &["cancelled prompt"],
            "malformed-spawn" => &["malformed prompt"],
            "restart" => &["restart prompt"],
            other => panic!("unsupported failure scenario: {other}"),
        };
        let mut final_snapshot = Vec::new();
        for (index, prompt) in prompts.iter().enumerate() {
            agent
                .prompt((*prompt).to_owned(), vec![])
                .await
                .expect("fixture prompt");
            if scenario == "cancelled-start" {
                let marker = std::path::PathBuf::from(
                    std::env::var("MAESTRO_CODEX_FAILURE_MARKER").expect("failure marker"),
                );
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while !marker.exists() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("turn/start observation barrier");
                agent.cancel();
            }
            let (snapshot, errors, statuses) = receive_codex_fixture_snapshot(&mut events).await;
            if scenario == "exhausted-start" && index == 0 {
                assert!(
                    errors
                        .iter()
                        .any(|error| error.contains("Exhausted 3 retry attempts")),
                    "terminal GiveUp must remain visible: {errors:?}"
                );
                assert!(
                    !snapshot
                        .iter()
                        .any(|message| message.content.as_text() == Some("failed prompt")),
                    "an undelivered prompt must not enter the semantic snapshot: {snapshot:?}"
                );
            }
            if scenario == "cancelled-start" {
                assert!(
                    !snapshot
                        .iter()
                        .any(|message| message.content.as_text() == Some("cancelled prompt")),
                    "a prompt cancelled before turn/start acceptance must not enter provider history: {snapshot:?}"
                );
            }
            if scenario == "malformed-spawn" {
                assert!(
                    errors.iter().any(|error| {
                        error.contains("invalid MAESTRO_CODEX_APP_SERVER_ARGS_JSON")
                            && error.contains("column 429")
                            && error.contains("Unknown error - not retrying")
                            && !error.contains("Exhausted")
                    }),
                    "malformed local config must fail immediately as non-retryable: {errors:?}"
                );
                assert!(
                    !statuses.iter().any(|status| status.contains("Retrying")),
                    "malformed local config must GiveUp immediately: {statuses:?}"
                );
            }
            final_snapshot = snapshot;
        }

        std::fs::write(
            &checkpoint,
            serde_json::to_vec(&final_snapshot).expect("snapshot json"),
        )
        .expect("persist fixture checkpoint");
        agent.shutdown().await;
    }

    #[test]
    fn codex_pre_turn_failures_preserve_retry_prompt_and_discard_terminal_give_up() {
        let root = tempfile::tempdir().expect("fixture root");
        let script = root.path().join("app-server.js");
        std::fs::write(
            &script,
            r"const rl=require('readline').createInterface({input:process.stdin});
const fs=require('fs');
const scenario=process.env.MAESTRO_CODEX_FAILURE_SCENARIO;
const log=process.env.MAESTRO_CODEX_FAILURE_LOG;
const observed=process.env.MAESTRO_CODEX_FAILURE_ITEMS;
const marker=process.env.MAESTRO_CODEX_FAILURE_MARKER;
function send(x){fs.appendFileSync(log,'OUT '+JSON.stringify(x)+'\n');process.stdout.write(JSON.stringify(x)+'\n')}
function fail(x){send({id:x.id,error:{code:-32000,message:'429 rate limit retry-after: 0 seconds'}})}
rl.on('line',line=>{fs.appendFileSync(log,line+'\n');const x=JSON.parse(line);
if(x.method==='initialize'){send({id:x.id,result:{protocolVersion:'2025-01-01',capabilities:{}}})}
else if(x.method==='thread/start'){send({id:x.id,result:{thread:{id:'thread'}}})}
else if(x.method==='thread/inject_items'){
  if(scenario==='transient-inject'&&!fs.existsSync(marker)){fs.writeFileSync(marker,'failed');fail(x)}
  else{fs.writeFileSync(observed,JSON.stringify(x.params.items));send({id:x.id,result:{}})}
}
else if(x.method==='turn/start'){
  const wire=JSON.stringify(x);
  if(scenario==='cancelled-start'){fs.writeFileSync(marker,'turn observed')}
  else if(scenario==='exhausted-start'&&wire.includes('failed prompt')){fail(x)}
  else{fs.appendFileSync(log,'ACCEPT '+wire+'\n');send({id:x.id,result:{turn:{id:'turn'}}});send({method:'turn/completed',params:{turnId:'turn'}})}
}
});",
        )
        .expect("app-server script");
        let current = std::env::current_exe().expect("current test binary");

        let run_child = |scenario: &str,
                         workspace: &std::path::Path,
                         checkpoint: &std::path::Path,
                         log: &std::path::Path,
                         items: &std::path::Path,
                         marker: &std::path::Path| {
            std::fs::create_dir_all(workspace).expect("fixture workspace");
            let spawn_args = if scenario == "malformed-spawn" {
                format!("[\"{}\"", "x".repeat(426))
            } else {
                serde_json::to_string(&vec![script.display().to_string()]).expect("script args")
            };
            let output = std::process::Command::new(&current)
                .arg("agent::native::tests::codex_pre_turn_failure_fixture")
                .arg("--exact")
                .arg("--nocapture")
                .env("MAESTRO_CODEX_FAILURE_SCENARIO", scenario)
                .env("MAESTRO_CODEX_FIXTURE_WORKSPACE", workspace)
                .env("MAESTRO_CODEX_FIXTURE_CHECKPOINT", checkpoint)
                .env("MAESTRO_CODEX_FAILURE_LOG", log)
                .env("MAESTRO_CODEX_FAILURE_ITEMS", items)
                .env("MAESTRO_CODEX_FAILURE_MARKER", marker)
                .env("MAESTRO_CODEX_APP_SERVER_COMMAND", "node")
                .env("OPENAI_CODEX_TOKEN", "fixture-token")
                .env("RUST_BACKTRACE", "1")
                .env("RUST_MIN_STACK", "16777216")
                .env("MAESTRO_CODEX_APP_SERVER_ARGS_JSON", spawn_args)
                .output()
                .expect("spawn fixture child");
            assert!(
                output.status.success(),
                "{scenario} fixture failed: {}; stdout: {}; stderr: {}; app-server log: {}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
                std::fs::read_to_string(log).unwrap_or_default(),
            );
        };

        let initial_history = serde_json::to_vec(&vec![Message {
            role: Role::User,
            content: MessageContent::Text("restored context".to_owned()),
        }])
        .expect("initial history");

        let malformed = root.path().join("malformed");
        std::fs::create_dir_all(&malformed).expect("malformed root");
        let malformed_checkpoint = malformed.join("checkpoint.json");
        let malformed_log = malformed.join("app-server.log");
        let malformed_items = malformed.join("items.json");
        let malformed_marker = malformed.join("unused-marker");
        std::fs::write(&malformed_checkpoint, &initial_history).expect("malformed checkpoint");
        run_child(
            "malformed-spawn",
            &malformed.join("workspace"),
            &malformed_checkpoint,
            &malformed_log,
            &malformed_items,
            &malformed_marker,
        );

        let transient = root.path().join("transient");
        std::fs::create_dir_all(&transient).expect("transient root");
        let transient_checkpoint = transient.join("checkpoint.json");
        let transient_log = transient.join("app-server.log");
        let transient_items = transient.join("items.json");
        let transient_marker = transient.join("failed-once");
        std::fs::write(&transient_checkpoint, &initial_history).expect("transient checkpoint");
        run_child(
            "transient-inject",
            &transient.join("workspace"),
            &transient_checkpoint,
            &transient_log,
            &transient_items,
            &transient_marker,
        );
        let transient_log = std::fs::read_to_string(&transient_log).expect("transient log");
        assert_eq!(
            transient_log
                .matches("\"method\":\"thread/inject_items\"")
                .count(),
            2,
            "the frozen restore prefix must survive one failed injection: {transient_log}"
        );
        assert_eq!(
            transient_log.matches("ACCEPT ").count(),
            1,
            "the retried prompt must cross turn/start exactly once: {transient_log}"
        );
        assert!(
            transient_log
                .lines()
                .any(|line| line.starts_with("ACCEPT ") && line.contains("retry prompt")),
            "the retried prompt must remain the same pending live input: {transient_log}"
        );
        assert!(
            !std::fs::read_to_string(&transient_items)
                .expect("transient injected items")
                .contains("retry prompt"),
            "the live retry prompt must not leak into injected history"
        );

        let cancelled = root.path().join("cancelled");
        std::fs::create_dir_all(&cancelled).expect("cancelled root");
        let cancelled_checkpoint = cancelled.join("checkpoint.json");
        let cancelled_log = cancelled.join("app-server.log");
        let cancelled_items = cancelled.join("items.json");
        let cancelled_marker = cancelled.join("turn-observed");
        std::fs::write(&cancelled_checkpoint, &initial_history).expect("cancelled checkpoint");
        run_child(
            "cancelled-start",
            &cancelled.join("workspace"),
            &cancelled_checkpoint,
            &cancelled_log,
            &cancelled_items,
            &cancelled_marker,
        );
        let cancelled_snapshot =
            std::fs::read_to_string(&cancelled_checkpoint).expect("cancelled snapshot");
        assert!(
            !cancelled_snapshot.contains("cancelled prompt"),
            "pre-start cancellation must not persist the prompt: {cancelled_snapshot}"
        );

        let exhausted = root.path().join("exhausted");
        std::fs::create_dir_all(&exhausted).expect("exhausted root");
        let exhausted_checkpoint = exhausted.join("checkpoint.json");
        let exhausted_log = exhausted.join("app-server.log");
        let exhausted_items = exhausted.join("items.json");
        let exhausted_marker = exhausted.join("unused-marker");
        std::fs::write(&exhausted_checkpoint, &initial_history).expect("exhausted checkpoint");
        run_child(
            "exhausted-start",
            &exhausted.join("workspace"),
            &exhausted_checkpoint,
            &exhausted_log,
            &exhausted_items,
            &exhausted_marker,
        );
        run_child(
            "restart",
            &exhausted.join("restored-workspace"),
            &exhausted_checkpoint,
            &exhausted_log,
            &exhausted_items,
            &exhausted_marker,
        );
        let exhausted_log = std::fs::read_to_string(&exhausted_log).expect("exhausted log");
        assert_eq!(
            exhausted_log.matches("ACCEPT ").count(),
            2,
            "only the second and post-restart prompts may be accepted: {exhausted_log}"
        );
        let restored_items =
            std::fs::read_to_string(&exhausted_items).expect("post-GiveUp restored items");
        assert!(
            !restored_items.contains("failed prompt"),
            "the undelivered prompt must never be injected after restart: {restored_items}"
        );
        assert!(
            restored_items.contains("second prompt"),
            "the successfully started prompt must remain provider history: {restored_items}"
        );
    }

    #[test]
    fn codex_process_death_restores_split_delta_tool_history() {
        let root = tempfile::tempdir().expect("fixture root");
        let source_workspace = root.path().join("source");
        let restored_workspace = root.path().join("restored");
        std::fs::create_dir_all(&source_workspace).expect("source workspace");
        std::fs::create_dir_all(&restored_workspace).expect("restored workspace");
        std::fs::write(
            source_workspace.join("Cargo.toml"),
            "[package]\nname='fixture'\n",
        )
        .expect("source tool file");
        let checkpoint = source_workspace.join("checkpoint.json");
        let observed_items = root.path().join("restored-items.json");
        let script_log = root.path().join("app-server.log");
        let script = root.path().join("app-server.js");
        std::fs::write(
            &script,
            format!(
                r"const rl=require('readline').createInterface({{input:process.stdin}});
const fs=require('fs'); const source=process.env.MAESTRO_CODEX_FIXTURE_ROLE==='source'; const log='{}'; fs.appendFileSync(log,'started\n');
function send(x){{fs.appendFileSync(log,'OUT '+JSON.stringify(x)+'\n');process.stdout.write(JSON.stringify(x)+'\n')}}
rl.on('line', line=>{{fs.appendFileSync(log,line+'\n'); const x=JSON.parse(line); if(!x.method){{if(x.id==='tool-1')setTimeout(()=>{{send({{method:'item/agentMessage/delta',params:{{turnId:'turn',delta:'suffix'}}}});send({{method:'turn/completed',params:{{turnId:'turn'}}}})}},10);return}} if(x.method==='initialize'){{send({{id:x.id,result:{{protocolVersion:'2025-01-01',capabilities:{{}}}}}})}}
else if(x.method==='thread/start'){{send({{id:x.id,result:{{thread:{{id:'thread'}}}}}})}}
else if(x.method==='thread/inject_items'){{fs.writeFileSync('{}',JSON.stringify(x.params.items));send({{id:x.id,result:{{}}}})}}
else if(x.method==='turn/start'){{send({{id:x.id,result:{{turn:{{id:'turn'}}}}}}); if(source){{setTimeout(()=>{{send({{method:'item/agentMessage/delta',params:{{turnId:'turn',delta:'prefix '}}}});send({{id:'tool-1',method:'item/tool/call',params:{{tool:'read',callId:'call-codex-1',arguments:{{path:'Cargo.toml'}}}}}})}},10)}} else {{setTimeout(()=>send({{method:'turn/completed',params:{{turnId:'turn'}}}}),10)}}}}
}});",
                script_log.display(),
                observed_items.display()
            ),
        )
        .expect("app-server script");
        let current = std::env::current_exe().expect("current test binary");
        let run_child = |role: &str, workspace: &std::path::Path, checkpoint: &std::path::Path| {
            let output = std::process::Command::new(&current)
                .arg("agent::native::tests::codex_process_continuation_fixture")
                .arg("--exact")
                .arg("--nocapture")
                .env("MAESTRO_CODEX_FIXTURE_ROLE", role)
                .env("MAESTRO_CODEX_FIXTURE_WORKSPACE", workspace)
                .env("MAESTRO_CODEX_FIXTURE_CHECKPOINT", checkpoint)
                .env("MAESTRO_CODEX_APP_SERVER_COMMAND", "node")
                .env("OPENAI_CODEX_TOKEN", "fixture-token")
                .env("RUST_BACKTRACE", "1")
                .env("RUST_MIN_STACK", "16777216")
                .env(
                    "MAESTRO_CODEX_APP_SERVER_ARGS_JSON",
                    serde_json::to_string(&vec![script.display().to_string()])
                        .expect("script args"),
                )
                .output()
                .expect("spawn fixture child");
            assert!(
                output.status.success(),
                "{role} fixture failed: {}; stdout: {}; stderr: {}; app-server log: {}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
                std::fs::read_to_string(&script_log).unwrap_or_default(),
            );
        };
        run_child("source", &source_workspace, &checkpoint);
        std::fs::copy(&checkpoint, restored_workspace.join("checkpoint.json"))
            .expect("hydrate runtime-generated checkpoint");
        run_child(
            "restore",
            &restored_workspace,
            &restored_workspace.join("checkpoint.json"),
        );
        let restored_items_text = std::fs::read_to_string(&observed_items).expect("restored items");
        let restored_items: Vec<serde_json::Value> =
            serde_json::from_str(&restored_items_text).expect("restored item JSON");
        let item_shape: Vec<(&str, Option<&str>)> = restored_items
            .iter()
            .map(|item| {
                let kind = item["type"].as_str().expect("item type");
                let value = match kind {
                    "message" => item["content"][0]["text"].as_str(),
                    "function_call" | "function_call_output" => item["call_id"].as_str(),
                    other => panic!("unexpected restored item type: {other}"),
                };
                (kind, value)
            })
            .collect();
        assert_eq!(
            item_shape,
            vec![
                ("message", Some("first prompt")),
                ("message", Some("prefix ")),
                ("function_call", Some("call-codex-1")),
                ("function_call_output", Some("call-codex-1")),
                ("message", Some("suffix")),
            ],
            "provider-visible chronology changed: {restored_items_text}"
        );
        assert!(
            !restored_items_text.contains("second prompt"),
            "{restored_items_text}"
        );
        let app_server_log = std::fs::read_to_string(&script_log).expect("app-server log");
        assert_eq!(
            app_server_log.matches("second prompt").count(),
            1,
            "the live prompt must appear exactly once in turn/start: {app_server_log}"
        );
    }

    #[test]
    fn codex_semantic_history_is_bounded_before_snapshot_and_reinjection() {
        let root = tempfile::tempdir().expect("fixture root");
        let source_workspace = root.path().join("source");
        let restored_workspace = root.path().join("restored");
        std::fs::create_dir_all(&source_workspace).expect("source workspace");
        std::fs::create_dir_all(&restored_workspace).expect("restored workspace");
        let checkpoint = source_workspace.join("checkpoint.json");
        let observed_items = root.path().join("restored-items.json");
        let script_log = root.path().join("app-server.log");
        let script = root.path().join("app-server.js");
        std::fs::write(
            &script,
            format!(
                r"const rl=require('readline').createInterface({{input:process.stdin}});
const fs=require('fs'); const log='{}';
function send(x){{fs.appendFileSync(log,'OUT '+JSON.stringify(x)+'\n');process.stdout.write(JSON.stringify(x)+'\n')}}
rl.on('line', line=>{{fs.appendFileSync(log,line+'\n'); const x=JSON.parse(line);
if(x.method==='initialize'){{send({{id:x.id,result:{{protocolVersion:'2025-01-01',capabilities:{{}}}}}})}}
else if(x.method==='thread/start'){{send({{id:x.id,result:{{thread:{{id:'thread'}}}}}})}}
else if(x.method==='thread/inject_items'){{fs.writeFileSync('{}',JSON.stringify(x.params.items));send({{id:x.id,result:{{}}}})}}
else if(x.method==='turn/start'){{send({{id:x.id,result:{{turn:{{id:'turn'}}}}}});setTimeout(()=>send({{method:'turn/completed',params:{{turnId:'turn'}}}}),10)}}
}});",
                script_log.display(),
                observed_items.display()
            ),
        )
        .expect("app-server script");

        let current = std::env::current_exe().expect("current test binary");
        let run_child = |role: &str,
                         workspace: &std::path::Path,
                         checkpoint: &std::path::Path,
                         oversized: bool| {
            let mut command = std::process::Command::new(&current);
            command
                .arg("agent::native::tests::codex_process_continuation_fixture")
                .arg("--exact")
                .arg("--nocapture")
                .env("MAESTRO_CODEX_FIXTURE_ROLE", role)
                .env("MAESTRO_CODEX_FIXTURE_WORKSPACE", workspace)
                .env("MAESTRO_CODEX_FIXTURE_CHECKPOINT", checkpoint)
                .env("MAESTRO_CODEX_APP_SERVER_COMMAND", "node")
                .env("OPENAI_CODEX_TOKEN", "fixture-token")
                .env("RUST_BACKTRACE", "1")
                .env("RUST_MIN_STACK", "16777216")
                .env(
                    "MAESTRO_CODEX_APP_SERVER_ARGS_JSON",
                    serde_json::to_string(&vec![script.display().to_string()])
                        .expect("script args"),
                );
            if oversized {
                command.env("MAESTRO_CODEX_FIXTURE_OVERSIZED", "1");
            }
            let output = command.output().expect("spawn fixture child");
            assert!(
                output.status.success(),
                "{role} fixture failed: {}; stdout: {}; stderr: {}; app-server log: {}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
                std::fs::read_to_string(&script_log).unwrap_or_default(),
            );
        };

        run_child("source", &source_workspace, &checkpoint, true);
        let snapshot_bytes = std::fs::read(&checkpoint).expect("semantic snapshot");
        let snapshot: Vec<Message> =
            serde_json::from_slice(&snapshot_bytes).expect("snapshot messages");
        let compaction_config = super::super::compaction::CompactionConfig::default();
        let token_budget = compaction_config.max_context_tokens;
        let compactor = super::super::compaction::ContextCompactor::new(compaction_config);
        assert!(
            compactor.estimate_tokens(&snapshot) <= token_budget,
            "semantic snapshot exceeded configured token budget: {} > {token_budget}",
            compactor.estimate_tokens(&snapshot)
        );
        assert!(
            snapshot_bytes.len() as u64
                <= token_budget * crate::agent::token_estimation::BYTES_PER_TOKEN as u64,
            "serialized semantic snapshot exceeded the configured byte-derived bound"
        );
        assert!(
            snapshot
                .iter()
                .any(|message| message.content.as_text() == Some("first prompt")),
            "the most recent live prompt must survive compaction"
        );
        let snapshot_blocks: Vec<&ContentBlock> = snapshot
            .iter()
            .filter_map(|message| match &message.content {
                MessageContent::Blocks(blocks) => Some(blocks.iter()),
                MessageContent::Text(_) => None,
            })
            .flatten()
            .collect();
        let snapshot_tool_use_index = snapshot_blocks
            .iter()
            .position(|block| {
                matches!(
                    block,
                    ContentBlock::ToolUse { id, name, .. }
                        if id == "bounded-call-1" && name == "read"
                )
            })
            .expect("snapshot tool use");
        let snapshot_tool_result_index = snapshot_blocks
            .iter()
            .position(|block| {
                matches!(
                    block,
                    ContentBlock::ToolResult { tool_use_id, .. }
                        if tool_use_id == "bounded-call-1"
                )
            })
            .expect("snapshot tool result");
        assert!(
            snapshot_tool_use_index < snapshot_tool_result_index,
            "snapshot tool use/result pair must remain valid and ordered"
        );

        std::fs::copy(&checkpoint, restored_workspace.join("checkpoint.json"))
            .expect("hydrate bounded checkpoint");
        run_child(
            "restore",
            &restored_workspace,
            &restored_workspace.join("checkpoint.json"),
            false,
        );

        let restored_items_bytes = std::fs::read(&observed_items).expect("restored provider items");
        assert!(
            restored_items_bytes.len() as u64
                <= token_budget * crate::agent::token_estimation::BYTES_PER_TOKEN as u64,
            "reinjected provider items exceeded the configured byte-derived bound"
        );
        let restored_items: Vec<serde_json::Value> =
            serde_json::from_slice(&restored_items_bytes).expect("provider items json");
        let tool_use_index = restored_items
            .iter()
            .position(|item| {
                item.get("type").and_then(serde_json::Value::as_str) == Some("function_call")
                    && item.get("call_id").and_then(serde_json::Value::as_str)
                        == Some("bounded-call-1")
            })
            .expect("bounded tool use");
        let tool_result_index = restored_items
            .iter()
            .position(|item| {
                item.get("type").and_then(serde_json::Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(serde_json::Value::as_str)
                        == Some("bounded-call-1")
            })
            .expect("bounded tool result");
        assert!(
            tool_use_index < tool_result_index,
            "tool use/result pair must remain ordered: {restored_items:?}"
        );
        assert!(
            !String::from_utf8_lossy(&restored_items_bytes).contains("second prompt"),
            "live prompt leaked into restored provider items"
        );
        let app_server_log = std::fs::read_to_string(&script_log).expect("app-server log");
        assert_eq!(
            app_server_log.matches("second prompt").count(),
            1,
            "the post-restore prompt must appear once in turn/start: {app_server_log}"
        );
    }

    #[tokio::test]
    async fn retry_backoff_is_interrupted_by_request_cancellation() {
        let cancel_token = CancellationToken::new();
        let waiter_token = cancel_token.clone();
        let shutdown_token = CancellationToken::new();
        let waiter = tokio::spawn(async move {
            wait_for_retry_delay(
                std::time::Duration::from_mins(1),
                &waiter_token,
                &shutdown_token,
            )
            .await
        });

        tokio::task::yield_now().await;
        cancel_token.cancel();
        let completed_delay = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("cancellation must interrupt the retry backoff")
            .expect("retry waiter task must not panic");
        assert!(!completed_delay, "cancelled backoff must not begin a retry");
    }

    struct ContextInjectingPostToolUseHook {
        context: String,
    }

    impl crate::hooks::PostToolUseHook for ContextInjectingPostToolUseHook {
        fn on_post_tool_use(&self, _input: &crate::hooks::PostToolUseInput) -> HookResult {
            HookResult::InjectContext {
                context: self.context.clone(),
            }
        }
    }

    struct BlockingPreToolUseHook;

    impl crate::hooks::PreToolUseHook for BlockingPreToolUseHook {
        fn on_pre_tool_use(&self, _input: &crate::hooks::PreToolUseInput) -> HookResult {
            HookResult::Block {
                reason: "policy denied".to_string(),
            }
        }
    }

    struct StateDependentPreToolUseHook {
        block: Arc<AtomicBool>,
    }

    impl crate::hooks::PreToolUseHook for StateDependentPreToolUseHook {
        fn on_pre_tool_use(&self, _input: &crate::hooks::PreToolUseInput) -> HookResult {
            if self.block.load(Ordering::SeqCst) {
                HookResult::Block {
                    reason: "state changed".to_string(),
                }
            } else {
                HookResult::Continue
            }
        }
    }

    struct SequencedModifyPreToolUseHook {
        calls: Arc<AtomicUsize>,
    }

    impl crate::hooks::PreToolUseHook for SequencedModifyPreToolUseHook {
        fn on_pre_tool_use(&self, _input: &crate::hooks::PreToolUseInput) -> HookResult {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            HookResult::ModifyInput {
                new_input: serde_json::json!({"command": format!("rewrite-{call}")}),
            }
        }
    }

    struct FixedModifyPreToolUseHook {
        new_input: serde_json::Value,
    }

    impl crate::hooks::PreToolUseHook for FixedModifyPreToolUseHook {
        fn on_pre_tool_use(&self, _input: &crate::hooks::PreToolUseInput) -> HookResult {
            HookResult::ModifyInput {
                new_input: self.new_input.clone(),
            }
        }
    }

    struct InjectContextPreToolUseHook;

    impl crate::hooks::PreToolUseHook for InjectContextPreToolUseHook {
        fn on_pre_tool_use(&self, _input: &crate::hooks::PreToolUseInput) -> HookResult {
            HookResult::InjectContext {
                context: "fresh context".to_string(),
            }
        }
    }

    #[tokio::test]
    async fn buffered_prompt_does_not_run_hooks_or_emit_prompt_events_after_shutdown() {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        command_tx
            .send(AgentCommand::Prompt {
                content: "must not run".to_string(),
                attachments: vec!["must-not-be-read.txt".to_string()],
                kind: PromptKind::Prompt,
                queue_id: None,
            })
            .expect("buffer prompt");

        let shutdown_token = CancellationToken::new();
        let worker_shutdown = shutdown_token.clone();
        let acquired = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let release = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let worker_acquired = std::sync::Arc::clone(&acquired);
        let worker_release = std::sync::Arc::clone(&release);
        let (side_effect_tx, mut side_effect_rx) = mpsc::unbounded_channel();

        let worker = tokio::spawn(async move {
            let command = command_rx
                .recv()
                .await
                .expect("buffered prompt should be acquired");
            worker_acquired.wait().await;
            worker_release.wait().await;

            if let Some(AgentCommand::Prompt { .. }) =
                command_after_shutdown_check(command, &worker_shutdown)
            {
                let _ = side_effect_tx.send("hook-marker");
                let _ = side_effect_tx.send("prompt-event");
            }
        });

        acquired.wait().await;
        shutdown_token.cancel();
        release.wait().await;
        worker.await.expect("barrier worker should not panic");

        assert!(
            side_effect_rx.try_recv().is_err(),
            "shutdown after buffered receive must gate hooks, attachment I/O, and prompt events"
        );
    }

    #[cfg(unix)]
    fn process_group_exists(process_group: i32) -> bool {
        let result = unsafe { libc::kill(-process_group, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    async fn read_pid(path: &Path) -> i32 {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(raw) = fs::read_to_string(path).await {
                    if let Ok(pid) = raw.trim().parse::<i32>() {
                        return pid;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("bash process should publish its pid")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_cancels_native_bash_process_group_before_returning() {
        let workspace = tempfile::tempdir().expect("workspace");
        let parent_pid_path = workspace.path().join("parent.pid");
        let child_pid_path = workspace.path().join("child.pid");
        let sentinel_path = workspace.path().join("post-shutdown-sentinel");
        let command = format!(
            "printf '%s\\n' \"$$\" > '{}'; \
             sleep 30 & child=$!; printf '%s\\n' \"$child\" > '{}'; \
             (sleep 1; printf leaked > '{}') & wait \"$child\"",
            parent_pid_path.display(),
            child_pid_path.display(),
            sentinel_path.display()
        );

        let executor = ToolExecutor::new(workspace.path().display().to_string());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let shutdown_token = CancellationToken::new();
        let worker_shutdown = shutdown_token.clone();
        let tool_shutdown = worker_shutdown.child_token();
        let request_cancel = CancellationToken::new();
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let execution = tokio::spawn(async move {
            let active_cancellation = Arc::new(Mutex::new(ActiveCancellation {
                terminal_drain_required: true,
                ..ActiveCancellation::default()
            }));
            run_request_with_cancellation(
                async move {
                    let result = executor
                        .execute_with_receipt_cancellable(
                            "bash",
                            &serde_json::json!({"command": command, "timeout": 60_000}),
                            Some(&event_tx),
                            "shutdown-bash",
                            tool_shutdown,
                        )
                        .await;
                    let _ = result_tx.send(result);
                    Ok(())
                },
                &request_cancel,
                &worker_shutdown,
                &active_cancellation,
            )
            .await
        });

        let parent_pid = read_pid(&parent_pid_path).await;
        let child_pid = read_pid(&child_pid_path).await;
        assert!(parent_pid > 0);
        assert!(child_pid > 0);
        assert!(
            process_group_exists(parent_pid),
            "bash should lead a live process group before shutdown"
        );

        shutdown_token.cancel();
        let run_result = tokio::time::timeout(std::time::Duration::from_secs(5), execution)
            .await
            .expect("shutdown must await process-tree termination")
            .expect("native tool task should not panic");
        assert!(run_result.is_ok());
        let result = result_rx
            .await
            .expect("cancellable Bash future must finish before shutdown returns");
        assert!(result.is_error());
        assert!(result.model_content().to_lowercase().contains("cancel"));

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while process_group_exists(parent_pid) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("bash process group should be gone before shutdown completes");

        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        assert!(
            !sentinel_path.exists(),
            "a descendant survived shutdown and mutated the workspace"
        );
    }

    #[tokio::test]
    async fn shutdown_awaits_terminal_outcome_beyond_the_old_drain_cutoff() {
        let request_cancel = CancellationToken::new();
        let shutdown_token = CancellationToken::new();
        let shutdown = shutdown_token.clone();

        let request = tokio::spawn(async move {
            let active_cancellation = Arc::new(Mutex::new(ActiveCancellation {
                terminal_drain_required: true,
                ..ActiveCancellation::default()
            }));
            run_request_with_cancellation(
                async {
                    tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;
                    Ok(())
                },
                &request_cancel,
                &shutdown_token,
                &active_cancellation,
            )
            .await
        });
        tokio::task::yield_now().await;
        shutdown.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), request)
            .await
            .expect("shutdown should await the active terminal outcome")
            .expect("request task should not panic");
        assert!(
            result.is_ok(),
            "shutdown must not replace a late successful terminal with cancellation"
        );
    }

    #[tokio::test]
    async fn shutdown_keeps_non_tool_request_bounded() {
        let request_cancel = CancellationToken::new();
        let shutdown_token = CancellationToken::new();
        let shutdown = shutdown_token.clone();

        let request = tokio::spawn(async move {
            let active_cancellation = Arc::new(Mutex::new(ActiveCancellation::default()));
            run_request_with_cancellation(
                std::future::pending::<Result<()>>(),
                &request_cancel,
                &shutdown_token,
                &active_cancellation,
            )
            .await
        });
        tokio::task::yield_now().await;
        shutdown.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(3), request)
            .await
            .expect("non-tool shutdown must retain its bounded exit")
            .expect("request task should not panic");
        assert!(
            result.is_err(),
            "a non-terminating provider or legacy request must be dropped after the bound"
        );
    }

    #[tokio::test]
    async fn shutdown_preempts_retry_backoff() {
        let request_cancel = CancellationToken::new();
        let shutdown_token = CancellationToken::new();
        let shutdown = shutdown_token.clone();

        let waiting = tokio::spawn(async move {
            wait_for_retry_delay(
                std::time::Duration::from_mins(1),
                &request_cancel,
                &shutdown_token,
            )
            .await
        });
        shutdown.cancel();

        let completed = tokio::time::timeout(std::time::Duration::from_millis(100), waiting)
            .await
            .expect("shutdown should preempt the retry timer")
            .expect("retry wait task should not panic");
        assert!(!completed);
    }

    #[tokio::test]
    async fn shutdown_preempts_and_drops_attachment_loading() {
        struct DropFlag(Arc<AtomicBool>);

        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let request_cancel = CancellationToken::new();
        let shutdown_token = CancellationToken::new();
        let shutdown = shutdown_token.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let entered_by_load = Arc::clone(&entered);
        let dropped = Arc::new(AtomicBool::new(false));
        let dropped_by_load = Arc::clone(&dropped);

        let loading = tokio::spawn(async move {
            load_until_cancelled(
                async move {
                    let _drop_flag = DropFlag(dropped_by_load);
                    entered_by_load.notify_one();
                    std::future::pending::<Vec<ContentBlock>>().await
                },
                &request_cancel,
                &shutdown_token,
            )
            .await
        });

        entered.notified().await;
        shutdown.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_millis(100), loading)
            .await
            .expect("shutdown should preempt attachment loading")
            .expect("attachment loading task should not panic");
        assert!(matches!(result, CancellableLoad::Shutdown));
        assert!(
            dropped.load(Ordering::SeqCst),
            "shutdown must drop the in-flight attachment future"
        );
    }

    #[tokio::test]
    async fn shutdown_waits_for_the_runner_to_process_cancellation() {
        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finished_in_runner = std::sync::Arc::clone(&finished);
        let shutdown_token = CancellationToken::new();
        let runner_shutdown_token = shutdown_token.clone();
        let runner_task = tokio::spawn(async move {
            runner_shutdown_token.cancelled().await;
            finished_in_runner.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: Arc::new(Mutex::new(ActiveCancellation::default())),
            event_tx,
            model_name: "test".to_string(),
            provider_name: "test".to_string(),
            shutdown_token,
            runner_handle: Some(runner_task),
        };

        agent.shutdown().await;
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_reaps_registered_background_bash_before_returning() {
        let workspace = tempfile::tempdir().expect("workspace");
        let parent_pid_path = workspace.path().join("background-parent.pid");
        let child_pid_path = workspace.path().join("background-child.pid");
        let sentinel_path = workspace.path().join("background-post-shutdown-sentinel");
        // The child records its PID immediately but delays the workspace
        // mutation for 30s. A 0.4s delay raced the setup path on loaded CI
        // runners: if pid-file polls and pre-shutdown assertions were
        // starved past the mutation, the sentinel existed before shutdown
        // ran, and the post-shutdown assertion failed even though the kill
        // path worked (evalops/maestro-internal run 31023856096). 30s
        // matches the sibling bash shutdown fixtures and gives the
        // poll-plus-shutdown path a large margin while the process-group
        // assertions remain the kill-correctness proof.
        let command = format!(
            "printf '%s\n' \"$$\" > '{}'; \
             (sleep 30; printf leaked > '{}') & child=$!; \
             printf '%s\n' \"$child\" > '{}'; wait \"$child\"",
            parent_pid_path.display(),
            sentinel_path.display(),
            child_pid_path.display(),
        );
        let shutdown_token = CancellationToken::new();
        let executor = ToolExecutor::new(workspace.path().display().to_string());
        let result = executor
            .execute_with_receipt_cancellable(
                "bash",
                &serde_json::json!({
                    "command": command,
                    "description": "shutdown regression",
                    "run_in_background": true
                }),
                None,
                "background-shutdown",
                shutdown_token.child_token(),
            )
            .await;
        let legacy_result = result.to_legacy();
        assert!(
            legacy_result.success,
            "background Bash should start: {result:?}"
        );
        let background_pid = legacy_result
            .details
            .as_ref()
            .and_then(|details| details.get("pid"))
            .and_then(serde_json::Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .expect("background Bash receipt should include its pid");
        let parent_pid = read_pid(&parent_pid_path).await;
        let child_pid = read_pid(&child_pid_path).await;
        assert_ne!(
            background_pid as i32, parent_pid,
            "receipt PID should identify the outer supervisor, not the configured shell"
        );
        assert!(child_pid > 0);
        assert!(
            process_group_exists(background_pid as i32),
            "outer supervisor should lead the background process group"
        );
        assert!(
            crate::tools::process_registry::tracked_pids().contains(&background_pid),
            "background Bash should be registered before shutdown"
        );

        let (command_tx, _command_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let runner_shutdown_token = shutdown_token.clone();
        let runner_task = tokio::spawn(async move {
            runner_shutdown_token.cancelled().await;
            executor.shutdown_background_processes().await;
        });
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: Arc::new(Mutex::new(ActiveCancellation::default())),
            event_tx,
            model_name: "test".to_string(),
            provider_name: "test".to_string(),
            shutdown_token,
            runner_handle: Some(runner_task),
        };

        agent.shutdown().await;
        assert!(
            !crate::tools::process_registry::tracked_pids().contains(&background_pid),
            "shutdown must reap its registered background Bash process"
        );
        assert!(
            !process_group_exists(background_pid as i32),
            "background Bash process group must be gone before shutdown returns"
        );
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(
            !sentinel_path.exists(),
            "background Bash survived shutdown and mutated the workspace"
        );
    }

    #[test]
    fn test_config_default() {
        let config = NativeAgentConfig::default();
        assert_eq!(config.model, "gpt-5.1-codex-max");
        assert_eq!(config.max_tokens, 16384);
        assert!(!config.thinking_enabled);
        assert_eq!(config.approval_mode, ApprovalMode::Selective);
    }

    #[tokio::test]
    async fn agent_cancel_interrupts_a_blocked_runner_before_queue_processing() {
        let request_token = CancellationToken::new();
        let tool_token = CancellationToken::new();
        let active = Arc::new(Mutex::new(ActiveCancellation {
            request: Some(request_token.clone()),
            tool: Some(tool_token.clone()),
            approval: None,
            tool_batch_active: true,
            terminal_drain_required: false,
            operation_interrupted: false,
        }));
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: active.clone(),
            event_tx,
            model_name: "test-model".to_string(),
            provider_name: "test-provider".to_string(),
            shutdown_token: CancellationToken::new(),
            runner_handle: None,
        };

        agent.cancel_keep_queue();

        assert!(tool_token.is_cancelled());
        assert!(
            !request_token.is_cancelled(),
            "the turn selector must not race tool cleanup"
        );
        assert!(
            active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .operation_interrupted,
            "the deferred suffix must observe the interruption"
        );
        {
            let mut active = active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            active.set_request(None);
            assert!(
                !active.operation_interrupted,
                "an interruption must not leak into a later request"
            );
        }
        assert!(matches!(
            command_rx.try_recv(),
            Ok(AgentCommand::Cancel {
                clear_pending: false
            })
        ));
    }

    #[tokio::test]
    async fn shutdown_preempts_buffered_prompts_and_awaits_runner_exit() {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        command_tx
            .send(AgentCommand::Prompt {
                content: "queued-before-shutdown".to_string(),
                attachments: Vec::new(),
                kind: PromptKind::Prompt,
                queue_id: Some(41),
            })
            .expect("queue prompt");
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let runner_exited = Arc::new(AtomicBool::new(false));
        let runner_exited_in_task = Arc::clone(&runner_exited);
        let shutdown_token = CancellationToken::new();
        let runner_shutdown_token = shutdown_token.clone();
        let runner_handle = tokio::spawn(async move {
            assert!(
                recv_command_or_shutdown(&runner_shutdown_token, &mut command_rx)
                    .await
                    .is_none(),
                "priority shutdown must win over a buffered prompt"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            runner_exited_in_task.store(true, Ordering::SeqCst);
        });
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: Arc::new(Mutex::new(ActiveCancellation::default())),
            event_tx,
            model_name: "test-model".to_string(),
            provider_name: "test-provider".to_string(),
            shutdown_token,
            runner_handle: Some(runner_handle),
        };

        tokio::time::timeout(std::time::Duration::from_secs(2), agent.shutdown())
            .await
            .expect("shutdown lifecycle barrier timed out");
        assert!(
            runner_exited.load(Ordering::SeqCst),
            "shutdown returned before the runner exited"
        );
    }

    #[tokio::test]
    async fn shutdown_drops_an_in_flight_side_question() {
        struct DropProbe(Arc<AtomicBool>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let shutdown = CancellationToken::new();
        let trigger = shutdown.clone();
        let started = Arc::new(AtomicBool::new(false));
        let started_in_future = Arc::clone(&started);
        let dropped = Arc::new(AtomicBool::new(false));
        let dropped_in_future = Arc::clone(&dropped);
        let side_question = async move {
            let _drop_probe = DropProbe(dropped_in_future);
            started_in_future.store(true, Ordering::SeqCst);
            std::future::pending::<()>().await;
        };
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            trigger.cancel();
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            await_side_question_or_shutdown(&shutdown, side_question),
        )
        .await
        .expect("side question shutdown must not wait for provider completion");

        assert!(result.is_none());
        assert!(started.load(Ordering::SeqCst));
        assert!(
            dropped.load(Ordering::SeqCst),
            "shutdown must drop the provider stream future"
        );
    }

    #[test]
    fn agent_cancel_interrupts_an_approval_wait_without_dropping_the_request() {
        let request_token = CancellationToken::new();
        let approval_token = CancellationToken::new();
        let active = Arc::new(Mutex::new(ActiveCancellation {
            request: Some(request_token.clone()),
            tool: None,
            approval: Some(approval_token.clone()),
            tool_batch_active: true,
            terminal_drain_required: false,
            operation_interrupted: false,
        }));
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: active.clone(),
            event_tx,
            model_name: "test-model".to_string(),
            provider_name: "test-provider".to_string(),
            shutdown_token: CancellationToken::new(),
            runner_handle: None,
        };

        agent.cancel_keep_queue();

        assert!(approval_token.is_cancelled());
        assert!(!request_token.is_cancelled());
        assert!(
            active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .operation_interrupted
        );
        assert!(matches!(
            command_rx.try_recv(),
            Ok(AgentCommand::Cancel {
                clear_pending: false
            })
        ));
    }

    #[tokio::test]
    async fn agent_cancel_keeps_tool_batch_cleanup_alive_between_operations() {
        let request_token = CancellationToken::new();
        let active = Arc::new(Mutex::new(ActiveCancellation {
            request: Some(request_token.clone()),
            tool: None,
            approval: None,
            tool_batch_active: true,
            terminal_drain_required: false,
            operation_interrupted: false,
        }));
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, _tool_response_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let agent = NativeAgent {
            command_tx,
            tool_response_tx,
            active_cancellation: active.clone(),
            event_tx,
            model_name: "test-model".to_string(),
            provider_name: "test-provider".to_string(),
            shutdown_token: CancellationToken::new(),
            runner_handle: None,
        };

        agent.cancel_keep_queue();

        assert!(!request_token.is_cancelled());
        assert!(
            active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .operation_interrupted
        );
        assert!(matches!(
            command_rx.try_recv(),
            Ok(AgentCommand::Cancel {
                clear_pending: false
            })
        ));
    }

    #[test]
    fn every_main_request_prompt_kind_uses_atomic_activation() {
        assert!(prompt_kind_starts_main_request(PromptKind::Prompt));
        assert!(prompt_kind_starts_main_request(PromptKind::Steer));
        assert!(prompt_kind_starts_main_request(PromptKind::FollowUp));
        assert!(!prompt_kind_starts_main_request(PromptKind::SideQuestion));
    }

    #[test]
    fn cancellation_promotes_later_main_request_prompt_kinds() {
        assert!(should_defer_prompt_command(PromptKind::Prompt, false));
        assert!(!should_defer_prompt_command(PromptKind::Steer, false));
        assert!(!should_defer_prompt_command(PromptKind::FollowUp, false));

        assert!(should_defer_prompt_command(PromptKind::Prompt, true));
        assert!(should_defer_prompt_command(PromptKind::Steer, true));
        assert!(should_defer_prompt_command(PromptKind::FollowUp, true));
        assert!(!should_defer_prompt_command(PromptKind::SideQuestion, true));
    }

    #[test]
    fn cancellation_queued_after_receive_cancels_the_activated_request() {
        let active = Arc::new(Mutex::new(ActiveCancellation::default()));
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        command_tx
            .send(AgentCommand::Cancel {
                clear_pending: true,
            })
            .expect("cancel command should queue");

        let request_token = {
            let mut activation = active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let request_token = activation.activate_request();
            if matches!(command_rx.try_recv(), Ok(AgentCommand::Cancel { .. })) {
                request_token.cancel();
            }
            request_token
        };

        assert!(
            request_token.is_cancelled(),
            "a cancel queued after direct receive must be consumed at activation"
        );
    }

    #[test]
    fn cancellation_waiting_on_prompt_activation_lock_cancels_new_request() {
        let active = Arc::new(Mutex::new(ActiveCancellation::default()));
        let mut activation = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cancel_started = Arc::new(std::sync::Barrier::new(2));
        let active_for_cancel = Arc::clone(&active);
        let cancel_started_in_thread = Arc::clone(&cancel_started);
        let cancel_thread = std::thread::spawn(move || {
            cancel_started_in_thread.wait();
            cancel_active_operation(&active_for_cancel);
        });

        cancel_started.wait();
        let request_token = activation.activate_request();
        drop(activation);
        cancel_thread
            .join()
            .expect("cancellation thread must finish");

        assert!(
            request_token.is_cancelled(),
            "cancellation racing prompt activation must cancel the installed request token"
        );
    }

    #[test]
    fn tool_batch_exit_consumes_a_late_interruption() {
        let request_token = CancellationToken::new();
        let active = Arc::new(Mutex::new(ActiveCancellation {
            request: Some(request_token.clone()),
            tool: None,
            approval: None,
            tool_batch_active: true,
            terminal_drain_required: false,
            operation_interrupted: false,
        }));

        cancel_active_operation(&active);
        assert!(!request_token.is_cancelled());
        let interrupted = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .finish_tool_batch();

        assert!(interrupted);
        let active = active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!active.tool_batch_active);
        assert!(!active.operation_interrupted);
    }

    #[test]
    fn mutating_tool_terminal_drain_sticks_until_batch_cleanup() {
        let mut active = ActiveCancellation {
            tool_batch_active: true,
            ..ActiveCancellation::default()
        };
        active.set_tool(Some(CancellationToken::new()), true);
        active.set_tool(None, false);

        assert!(
            active.terminal_drain_required,
            "clearing the active token must not drop truthful terminal cleanup"
        );

        active.finish_tool_batch();
        assert!(
            !active.terminal_drain_required,
            "the terminal drain boundary ends with batch cleanup"
        );
    }

    #[test]
    fn persistent_todo_requires_terminal_drain_without_approval() {
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({"goal": "ship", "items": []});

        assert!(
            native_tool_requires_terminal_drain(&executor, "todo", &args),
            "todo persists its store even though it is auto-approved"
        );
    }

    #[test]
    fn legacy_bash_mutations_require_terminal_drain() {
        let mut executor = ToolExecutor::new(".");
        executor.pin_tool_version("bash", "legacy-1").unwrap();

        for command in [
            "find . -delete",
            "git branch -D obsolete",
            "git remote set-url origin https://example.invalid/repo.git",
            "printf x | tee target",
            "sed -i 's/a/b/' target",
        ] {
            let args = serde_json::json!({"command": command});
            assert!(
                native_tool_requires_terminal_drain(&executor, "bash", &args),
                "current effect analysis must classify legacy mutation: {command}"
            );
        }
    }

    #[test]
    fn read_only_background_wait_does_not_require_terminal_drain() {
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({
            "action": "waitForRotation",
            "taskId": "task-1",
            "timeoutMs": 60_000
        });

        assert!(
            !native_tool_requires_terminal_drain(&executor, "background_tasks", &args),
            "bounded shutdown must not become an unbounded wait for observation-only actions"
        );
    }

    #[test]
    fn read_only_github_actions_do_not_require_terminal_drain() {
        let executor = ToolExecutor::new(".");
        for (tool, action) in [
            ("gh_pr", "view"),
            ("gh_pr", "list"),
            ("gh_pr", "checks"),
            ("gh_pr", "diff"),
            ("gh_issue", "view"),
            ("gh_issue", "list"),
            ("gh_repo", "view"),
        ] {
            let args = serde_json::json!({"action": action});
            assert!(
                !native_tool_requires_terminal_drain(&executor, tool, &args),
                "{tool} {action} is observation-only"
            );
        }
    }

    #[test]
    fn post_tool_use_injected_context_reaches_the_tool_result() {
        // A `PostToolUse` hook returning `contextToAdd` had its result dropped,
        // so the context never reached the request that followed.
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_post_tool_use(Arc::new(ContextInjectingPostToolUseHook {
                context: "remember: the build is pinned".to_string(),
            }));

        let post_context = hook_injected_context(hooks.execute_post_tool_use(
            "bash",
            "call-1",
            &serde_json::json!({"command": "ls"}),
            "file1.txt",
            false,
            42,
        ));
        assert_eq!(
            post_context.as_deref(),
            Some("remember: the build is pinned")
        );

        let content = append_hook_context("file1.txt".to_string(), post_context.as_deref());
        assert_eq!(content, "file1.txt\n\nremember: the build is pinned");
    }

    #[test]
    fn pre_and_post_hook_context_are_both_appended() {
        let content = append_hook_context("output".to_string(), Some("from pre"));
        let content = append_hook_context(content, Some("from post"));
        assert_eq!(content, "output\n\nfrom pre\n\nfrom post");
    }

    #[test]
    fn blank_hook_context_is_not_appended() {
        assert_eq!(append_hook_context("output".to_string(), None), "output");
        assert_eq!(
            append_hook_context("output".to_string(), Some("  ")),
            "output"
        );
    }

    #[test]
    fn a_blocking_pre_tool_use_hook_stops_any_transport() {
        // The Codex app-server handler runs this same helper, so a policy hook
        // cannot be enforced for HTTP tool calls and skipped for Codex ones.
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_pre_tool_use(Arc::new(BlockingPreToolUseHook));

        assert_eq!(
            run_pre_tool_use_hook(
                &mut hooks,
                "bash",
                "call-1",
                &serde_json::json!({"command": "ls"})
            ),
            Err("policy denied".to_string())
        );
    }

    #[test]
    fn each_queued_prompt_consumes_only_its_own_staged_skills() {
        // A single shared staged value let a prompt run with instructions only
        // a later queued prompt triggered. Keyed entries are consumed by the
        // prompt they belong to, in whatever order the queue drains.
        let mut staged: HashMap<u64, (u64, String)> = HashMap::new();
        staged.insert(1, (0, "base + skill-a".to_string()));
        staged.insert(2, (0, "base + skill-a + skill-b".to_string()));

        // A steer jumps the queue and runs second-in-line first.
        assert_eq!(
            staged_system_prompt_to_apply(staged.remove(&2), 0).as_deref(),
            Some("base + skill-a + skill-b")
        );
        // The earlier prompt still gets its own prompt, without skill-b.
        assert_eq!(
            staged_system_prompt_to_apply(staged.remove(&1), 0).as_deref(),
            Some("base + skill-a"),
            "an earlier prompt must not inherit a later prompt's skills"
        );
        assert!(staged.is_empty(), "each entry is consumed once");
    }

    #[test]
    fn a_prompt_that_activates_nothing_still_gets_its_own_entry() {
        // Skipping the staging for a prompt with no new activations left it
        // with no entry, so a steer that jumped the queue and applied its own
        // skills first left them in place for the prompt behind it. An empty
        // activation set is a statement about that prompt, not an absence.
        let mut staged: HashMap<u64, (u64, String)> = HashMap::new();
        staged.insert(1, (0, "base".to_string()));
        staged.insert(2, (0, "base + steer-skill".to_string()));
        staged.insert(3, (0, "base + steer-skill".to_string()));

        // The steer jumps ahead and applies its own skills.
        assert_eq!(
            staged_system_prompt_to_apply(staged.remove(&2), 0).as_deref(),
            Some("base + steer-skill")
        );
        // The prompt behind it activated nothing and must fall back to its own
        // snapshot, not keep the steer's.
        assert_eq!(
            staged_system_prompt_to_apply(staged.remove(&1), 0).as_deref(),
            Some("base"),
            "a prompt that activates nothing must not inherit the steer's skills"
        );
        // A prompt queued after the steer legitimately carries its skills.
        assert_eq!(
            staged_system_prompt_to_apply(staged.remove(&3), 0).as_deref(),
            Some("base + steer-skill")
        );
    }

    #[test]
    fn a_staged_queued_prompt_applies_only_while_it_is_current() {
        let staged = Some((3, "with skills".to_string()));
        assert_eq!(
            staged_system_prompt_to_apply(staged.clone(), 3).as_deref(),
            Some("with skills")
        );
        assert_eq!(
            staged_system_prompt_to_apply(staged, 4),
            None,
            "an authoritative update after the staging supersedes it"
        );
        assert_eq!(staged_system_prompt_to_apply(None, 0), None);
    }

    struct RejectingEvalGateHook;

    impl crate::hooks::EvalGateHook for RejectingEvalGateHook {
        fn on_eval_gate(&self, _input: &crate::hooks::EvalGateInput) -> HookResult {
            HookResult::Block {
                reason: "score 0.2 below threshold 0.8".to_string(),
            }
        }
    }

    struct ScoringEvalGateHook;

    impl crate::hooks::EvalGateHook for ScoringEvalGateHook {
        fn on_eval_gate(&self, _input: &crate::hooks::EvalGateInput) -> HookResult {
            HookResult::InjectContext {
                context: "eval score 0.9".to_string(),
            }
        }
    }

    #[test]
    fn an_eval_gate_hook_runs_after_every_tool_call() {
        // `EvalGate` had no dispatch site at all, so a configured evaluation
        // hook observed nothing.
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_eval_gate(Arc::new(ScoringEvalGateHook));

        let outcome = run_post_execution_hooks(
            &mut hooks,
            "bash",
            "call-1",
            &serde_json::json!({"command": "ls"}),
            "file1.txt",
            false,
            12,
        );

        assert_eq!(outcome.context.as_deref(), Some("eval score 0.9"));
        assert!(outcome.rejected.is_none());
    }

    #[test]
    fn a_rejecting_eval_gate_marks_the_tool_result_failed() {
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_eval_gate(Arc::new(RejectingEvalGateHook));

        let outcome = run_post_execution_hooks(
            &mut hooks,
            "bash",
            "call-1",
            &serde_json::json!({"command": "ls"}),
            "file1.txt",
            false,
            12,
        );

        assert_eq!(
            outcome.rejected.as_deref(),
            Some("score 0.2 below threshold 0.8")
        );
    }

    #[test]
    fn post_tool_use_and_eval_gate_context_are_both_delivered() {
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_post_tool_use(Arc::new(ContextInjectingPostToolUseHook {
                context: "from post".to_string(),
            }));
        hooks
            .registry
            .register_eval_gate(Arc::new(ScoringEvalGateHook));

        let outcome = run_post_execution_hooks(
            &mut hooks,
            "bash",
            "call-1",
            &serde_json::json!({}),
            "out",
            false,
            0,
        );

        assert_eq!(
            outcome.context.as_deref(),
            Some("from post\n\neval score 0.9")
        );
    }

    #[test]
    fn codex_native_operations_are_named_for_policy_hooks() {
        assert_eq!(
            codex_native_policy_tool("item/fileChange/requestApproval"),
            "codex_file_change"
        );
        assert_eq!(
            codex_native_policy_tool("applyPatchApproval"),
            "codex_file_change"
        );
        assert_eq!(
            codex_native_policy_tool("item/commandExecution/requestApproval"),
            "codex_command_execution"
        );
        assert_eq!(
            codex_native_policy_tool("execCommandApproval"),
            "codex_command_execution"
        );
    }

    #[test]
    fn a_policy_hook_blocks_a_codex_native_mutation() {
        // Round 4 routed `item/tool/call` through the hook pipeline. A
        // Codex-native mutation is approved on a different branch, so a hook
        // that blocks shell commands was bypassed on exactly those operations.
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_pre_tool_use(Arc::new(BlockingPreToolUseHook));

        assert_eq!(
            run_pre_tool_use_hook(
                &mut hooks,
                codex_native_policy_tool("item/commandExecution/requestApproval"),
                "call-1",
                &serde_json::json!({"command": "rm -rf /"}),
            ),
            Err("policy denied".to_string())
        );
    }

    #[test]
    fn a_codex_native_operation_is_charged_its_generated_payload() {
        // Codex runs commandExecution and fileChange itself, so these never
        // appear as `ToolCall` and were charged nothing at all.
        let patch = "x".repeat(4_000);
        let charged = codex_native_operation_chars(Some(&serde_json::json!({
            "changes": {"src/main.rs": patch},
        })));

        assert!(
            charged > 4_000,
            "the generated patch must be charged, got {charged}"
        );
        assert_eq!(
            codex_native_operation_chars(None),
            0,
            "an operation with no params carries no model output"
        );
    }

    #[test]
    fn a_read_only_policy_maps_to_the_codex_read_only_sandbox() {
        use crate::sandbox::SandboxPolicy;

        assert_eq!(
            codex_sandbox_mode(Some(&SandboxPolicy::ReadOnly)).as_deref(),
            Some("read-only")
        );
        assert_eq!(
            codex_sandbox_mode(Some(&SandboxPolicy::DangerFullAccess)).as_deref(),
            Some("danger-full-access")
        );
        assert_eq!(
            codex_sandbox_mode(Some(&SandboxPolicy::WorkspaceWrite {
                writable_roots: Vec::new(),
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            }))
            .as_deref(),
            Some("workspace-write")
        );
        assert_eq!(codex_sandbox_mode(None), None);
    }

    #[test]
    fn a_read_only_policy_declines_codex_native_mutation() {
        use crate::sandbox::SandboxPolicy;

        // Every subagent runs in Yolo, because a delegated child cannot answer
        // an approval prompt. Without this the approval mode alone decided,
        // and a read-only child had its native exec and file-change requests
        // auto-accepted.
        assert!(config_denies_mutation(Some(&SandboxPolicy::ReadOnly)));
        assert!(!config_denies_mutation(Some(
            &SandboxPolicy::DangerFullAccess
        )));
        assert!(!config_denies_mutation(None));
    }

    #[test]
    fn codex_native_mutations_are_normalized_for_the_action_firewall() {
        let command_sets = codex_native_firewall_arg_sets(
            "item/commandExecution/requestApproval",
            Some(&json!({"command": "rm -rf /"})),
            None,
        );
        assert_eq!(command_sets.len(), 1);
        assert_eq!(command_sets[0].0, "bash");
        assert_eq!(command_sets[0].1["command"], "rm -rf /");

        let file_sets = codex_native_firewall_arg_sets(
            "item/fileChange/requestApproval",
            Some(&json!({"path": "/etc/passwd", "content": "x"})),
            None,
        );
        assert_eq!(file_sets.len(), 1);
        assert_eq!(file_sets[0].0, "write");
        assert_eq!(file_sets[0].1["file_path"], "/etc/passwd");

        let multi = codex_native_firewall_arg_sets(
            "item/fileChange/requestApproval",
            Some(&json!({
                "files": ["src/main.rs", "/etc/passwd"],
                "content": "x"
            })),
            None,
        );
        assert_eq!(multi.len(), 2);
        assert_eq!(multi[0].1["file_path"], "src/main.rs");
        assert_eq!(multi[1].1["file_path"], "/etc/passwd");

        let legacy = codex_native_firewall_arg_sets(
            "applyPatchApproval",
            Some(&json!({
                "fileChanges": {
                    "src/ok.rs": {"type": "update"},
                    "/etc/passwd": {"type": "update"}
                }
            })),
            None,
        );
        assert_eq!(legacy.len(), 2);

        let denial = codex_native_firewall_denial(
            "/tmp",
            "item/commandExecution/requestApproval",
            Some(&json!({"command": "rm -rf /"})),
            None,
            None,
        );
        assert!(
            denial.is_some(),
            "dangerous commands must be blocked by the firewall"
        );

        let multi_denial = codex_native_firewall_denial(
            "/tmp/workspace",
            "item/fileChange/requestApproval",
            Some(&json!({
                "files": ["/tmp/workspace/ok.rs", "/etc/passwd"],
                "content": "x"
            })),
            None,
            None,
        );
        assert!(
            multi_denial.is_some(),
            "a later out-of-workspace path must fail the whole multi-file request"
        );

        let item_id_only = codex_native_firewall_denial(
            "/tmp/workspace",
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-1",
                "threadId": "t",
                "turnId": "u",
                "startedAtMs": 1
            })),
            None,
            None,
        );
        assert!(
            item_id_only.is_some(),
            "itemId-only file-change approvals must fail closed with no recoverable paths"
        );

        let mut known = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-2",
                "path": "/tmp/workspace/ok.rs",
                "content": "safe"
            }),
            &mut known,
        );
        let correlated = codex_native_firewall_arg_sets(
            "item/fileChange/requestApproval",
            Some(&json!({"itemId": "item-2"})),
            Some(&known),
        );
        assert_eq!(correlated.len(), 1);
        assert_eq!(correlated[0].1["file_path"], "/tmp/workspace/ok.rs");

        // Path-sensitive policy hooks must receive the same correlated paths.
        let hook_args = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({"itemId": "item-2"})),
            &known,
        );
        assert_eq!(
            hook_args["paths"],
            json!(["/tmp/workspace/ok.rs"]),
            "itemId-only approvals must surface correlated paths to hooks"
        );
        assert_eq!(
            hook_args["fileChanges"]["/tmp/workspace/ok.rs"]["content"], "safe",
            "itemId-only approvals must replay cached patch metadata: {hook_args}"
        );
        // Path present but sparse: still replay cached content metadata.
        let already_pathed = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-2",
                "path": "/tmp/workspace/ok.rs"
            })),
            &known,
        );
        assert_eq!(
            already_pathed["fileChanges"]["/tmp/workspace/ok.rs"]["content"], "safe",
            "sparse path-only approvals must still receive cached metadata: {already_pathed}"
        );

        // Later notifications overwrite earlier metadata for the same path.
        let mut stale = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-stale",
                "path": "/tmp/workspace/x.rs",
                "content": "old",
                "kind": "update"
            }),
            &mut stale,
        );
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-stale",
                "path": "/tmp/workspace/x.rs",
                "content": "new"
            }),
            &mut stale,
        );
        assert_eq!(
            stale["item-stale"]["/tmp/workspace/x.rs"]["content"], "new",
            "later content must replace earlier content: {stale:?}"
        );
        assert_eq!(
            stale["item-stale"]["/tmp/workspace/x.rs"]["kind"], "update",
            "fields omitted from the later update must be retained: {stale:?}"
        );

        // Approval names only the rename source; cache also has the destination.
        let mut partial = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-partial",
                "changes": [{
                    "path": "/tmp/workspace/src.rs",
                    "kind": { "move_path": "/etc/passwd" }
                }]
            }),
            &mut partial,
        );
        let partial_merged = codex_native_file_change_paths(
            &json!({
                "itemId": "item-partial",
                "path": "/tmp/workspace/src.rs"
            }),
            Some(&partial),
        );
        assert!(
            partial_merged.iter().any(|p| p == "/tmp/workspace/src.rs"),
            "direct source must remain: {partial_merged:?}"
        );
        assert!(
            partial_merged.iter().any(|p| p == "/etc/passwd"),
            "cached destination must merge even when approval already has a path: {partial_merged:?}"
        );
        let partial_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-partial",
                "path": "/tmp/workspace/src.rs"
            })),
            &partial,
        );
        assert!(
            partial_hook["paths"]
                .as_array()
                .is_some_and(|paths| paths.iter().any(|p| p == "/etc/passwd")),
            "hooks must see the cached destination: {partial_hook}"
        );

        // Existing fileChanges metadata must survive enrichment.
        let mut with_meta = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-meta",
                "path": "/tmp/workspace/extra.rs"
            }),
            &mut with_meta,
        );
        let meta_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-meta",
                "fileChanges": {
                    "/tmp/workspace/src.rs": {
                        "kind": { "move_path": "/tmp/workspace/dst.rs" },
                        "content": "patched"
                    }
                }
            })),
            &with_meta,
        );
        assert_eq!(
            meta_hook["fileChanges"]["/tmp/workspace/src.rs"]["content"], "patched",
            "original fileChanges metadata must be preserved: {meta_hook}"
        );
        assert!(
            meta_hook["fileChanges"]
                .as_object()
                .is_some_and(|m| m.contains_key("/tmp/workspace/extra.rs")),
            "correlated missing paths must still be added: {meta_hook}"
        );

        // Snake-case file_changes must be updated in place (not only a new
        // camelCase field) so hooks that read the original alias see correlated
        // paths.
        let snake_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-meta",
                "file_changes": {
                    "/tmp/workspace/src.rs": {
                        "content": "snake-meta"
                    }
                }
            })),
            &with_meta,
        );
        assert_eq!(
            snake_hook["file_changes"]["/tmp/workspace/src.rs"]["content"], "snake-meta",
            "snake-case metadata must be preserved: {snake_hook}"
        );
        assert!(
            snake_hook["file_changes"]
                .as_object()
                .is_some_and(|m| m.contains_key("/tmp/workspace/extra.rs")),
            "snake-case file_changes must include correlated paths: {snake_hook}"
        );
        assert_eq!(
            snake_hook["fileChanges"]["/tmp/workspace/src.rs"]["content"], "snake-meta",
            "canonical fileChanges always mirrors the complete set: {snake_hook}"
        );

        // Array aliases (files / changes) must also receive correlated paths.
        let files_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-meta",
                "files": ["/tmp/workspace/src.rs"]
            })),
            &with_meta,
        );
        let files = files_hook["files"].as_array().cloned().unwrap_or_default();
        assert!(
            files
                .iter()
                .any(|v| v.as_str() == Some("/tmp/workspace/src.rs")),
            "original files entry preserved: {files_hook}"
        );
        assert!(
            files
                .iter()
                .any(|v| v.as_str() == Some("/tmp/workspace/extra.rs")),
            "correlated path must appear in files: {files_hook}"
        );
        assert!(
            files_hook["fileChanges"]
                .as_object()
                .is_some_and(|m| m.contains_key("/tmp/workspace/extra.rs")),
            "canonical fileChanges always present: {files_hook}"
        );

        let changes_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-meta",
                "changes": [{
                    "path": "/tmp/workspace/src.rs",
                    "kind": { "update": {} },
                    "content": "keep-me"
                }]
            })),
            &with_meta,
        );
        let changes = changes_hook["changes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            changes[0]["content"], "keep-me",
            "existing change metadata preserved: {changes_hook}"
        );
        assert!(
            changes
                .iter()
                .any(|c| c.get("path").and_then(Value::as_str) == Some("/tmp/workspace/extra.rs")),
            "correlated path must appear in changes: {changes_hook}"
        );

        // Notification-shaped payload (paths arrive before the approval RPC).
        let mut from_notification = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "item": {
                    "id": "item-3",
                    "type": "fileChange",
                    "path": "/tmp/workspace/from-notification.rs"
                }
            }),
            &mut from_notification,
        );
        assert!(
            from_notification
                .get("item-3")
                .is_some_and(|paths| paths.contains_key("/tmp/workspace/from-notification.rs")),
            "notification paths must be cached under item id: {from_notification:?}"
        );

        // Cached change metadata must be replayed for itemId-only approvals.
        let mut kind_cache = HashMap::new();
        remember_codex_file_change_item_paths(
            &json!({
                "itemId": "item-kind",
                "changes": [{
                    "path": "/tmp/workspace/delete-me.rs",
                    "kind": "delete",
                    "diff": "-gone"
                }]
            }),
            &mut kind_cache,
        );
        let kind_hook = codex_native_policy_hook_args(
            "item/fileChange/requestApproval",
            Some(&json!({"itemId": "item-kind"})),
            &kind_cache,
        );
        assert_eq!(
            kind_hook["fileChanges"]["/tmp/workspace/delete-me.rs"]["kind"], "delete",
            "cached kind must be replayed: {kind_hook}"
        );
        assert_eq!(
            kind_hook["fileChanges"]["/tmp/workspace/delete-me.rs"]["diff"], "-gone",
            "cached diff must be replayed: {kind_hook}"
        );

        // Rename/move destinations must be checked, not only sources.
        let move_paths = codex_native_file_change_paths(
            &json!({
                "itemId": "item-4",
                "changes": [{
                    "path": "/tmp/workspace/src.rs",
                    "kind": { "move_path": "/etc/passwd" }
                }]
            }),
            None,
        );
        assert!(
            move_paths.iter().any(|p| p == "/tmp/workspace/src.rs"),
            "source path required: {move_paths:?}"
        );
        assert!(
            move_paths.iter().any(|p| p == "/etc/passwd"),
            "move destination required: {move_paths:?}"
        );
        // Single-path { path, move_path } must also enumerate the destination.
        let single_move = codex_native_file_change_paths(
            &json!({
                "path": "/tmp/workspace/src.rs",
                "move_path": "/etc/passwd"
            }),
            None,
        );
        assert!(
            single_move.iter().any(|p| p == "/tmp/workspace/src.rs"),
            "single-path source required: {single_move:?}"
        );
        assert!(
            single_move.iter().any(|p| p == "/etc/passwd"),
            "single-path move destination required: {single_move:?}"
        );
        let single_kind_move = codex_native_file_change_paths(
            &json!({
                "path": "/tmp/workspace/src.rs",
                "kind": { "move_path": "/etc/shadow" }
            }),
            None,
        );
        assert!(
            single_kind_move.iter().any(|p| p == "/etc/shadow"),
            "single-path kind.move_path destination required: {single_kind_move:?}"
        );
        let move_denial = codex_native_firewall_denial(
            "/tmp/workspace",
            "item/fileChange/requestApproval",
            Some(&json!({
                "itemId": "item-4",
                "changes": [{
                    "path": "/tmp/workspace/src.rs",
                    "kind": { "move_path": "/etc/passwd" }
                }]
            })),
            None,
            None,
        );
        assert!(
            move_denial.is_some(),
            "out-of-workspace move destination must be blocked"
        );
    }

    #[test]
    fn a_restrictive_tool_profile_declines_codex_native_mutation() {
        // A code-role child with profile tools [read, grep] still has a
        // writable sandbox; the allowlist is what must stop Codex-native
        // commandExecution and fileChange from running outside that set.
        let read_only: HashSet<String> = ["read", "grep"].into_iter().map(str::to_owned).collect();
        assert!(codex_native_denied_by_active_tools(
            "item/commandExecution/requestApproval",
            &read_only
        )
        .is_some());
        assert!(
            codex_native_denied_by_active_tools("item/fileChange/requestApproval", &read_only)
                .is_some()
        );

        let with_bash: HashSet<String> = ["bash", "read"].into_iter().map(str::to_owned).collect();
        assert!(codex_native_denied_by_active_tools(
            "item/commandExecution/requestApproval",
            &with_bash
        )
        .is_none());
        assert!(
            codex_native_denied_by_active_tools("item/fileChange/requestApproval", &with_bash)
                .is_some()
        );

        let with_write: HashSet<String> =
            ["write", "read"].into_iter().map(str::to_owned).collect();
        assert!(codex_native_denied_by_active_tools(
            "item/fileChange/requestApproval",
            &with_write
        )
        .is_none());
    }

    #[test]
    fn output_allowance_is_unchanged_without_a_cumulative_budget() {
        assert_eq!(output_token_allowance(16_384, None, 0), 16_384);
        assert_eq!(
            output_token_allowance(16_384, None, 1_000_000),
            16_384,
            "spend is only meaningful against a budget"
        );
    }

    #[test]
    fn output_allowance_shrinks_to_the_unspent_budget() {
        // The runner owns this arithmetic so a delegated run cannot be granted
        // its whole allowance again on every request past a tool boundary.
        assert_eq!(output_token_allowance(4_096, Some(4_096), 0), 4_096);
        assert_eq!(output_token_allowance(4_096, Some(4_096), 4_000), 96);
        assert_eq!(
            output_token_allowance(4_096, Some(65_536), 0),
            4_096,
            "a budget above the per-request limit does not raise the limit"
        );
    }

    #[test]
    fn a_spent_budget_still_yields_a_valid_request() {
        assert_eq!(
            output_token_allowance(4_096, Some(4_096), 4_096),
            1,
            "providers reject max_tokens: 0"
        );
        assert_eq!(output_token_allowance(4_096, Some(4_096), 9_000), 1);
    }

    #[test]
    fn clear_pending_cancel_drops_only_prompts_stashed_before_boundary() {
        let mut deferred_commands = VecDeque::from([
            AgentCommand::SetThinking {
                enabled: true,
                budget: 1024,
            },
            AgentCommand::Prompt {
                content: "before cancel".to_string(),
                attachments: Vec::new(),
                kind: PromptKind::Prompt,
                queue_id: Some(1),
            },
            AgentCommand::Prompt {
                content: "steer before cancel".to_string(),
                attachments: Vec::new(),
                kind: PromptKind::Steer,
                queue_id: Some(2),
            },
            AgentCommand::Prompt {
                content: "follow-up before cancel".to_string(),
                attachments: Vec::new(),
                kind: PromptKind::FollowUp,
                queue_id: Some(3),
            },
            AgentCommand::Prompt {
                content: "side question before cancel".to_string(),
                attachments: Vec::new(),
                kind: PromptKind::SideQuestion,
                queue_id: Some(4),
            },
        ]);

        assert_eq!(clear_stashed_prompts(&mut deferred_commands), 3);

        deferred_commands.push_back(AgentCommand::Prompt {
            content: "after cancel".to_string(),
            attachments: Vec::new(),
            kind: PromptKind::Prompt,
            queue_id: Some(5),
        });
        assert!(matches!(
            deferred_commands.pop_front(),
            Some(AgentCommand::SetThinking {
                enabled: true,
                budget: 1024
            })
        ));
        assert!(matches!(
            deferred_commands.pop_front(),
            Some(AgentCommand::Prompt {
                content,
                kind: PromptKind::SideQuestion,
                queue_id: Some(4),
                ..
            }) if content == "side question before cancel"
        ));
        assert!(matches!(
            deferred_commands.pop_front(),
            Some(AgentCommand::Prompt {
                content,
                queue_id: Some(5),
                ..
            }) if content == "after cancel"
        ));
        assert!(deferred_commands.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────
    // `tool_requires_approval` -- the single decision point behind the
    // dual-executor fix (issues #3149, #3156). These exercise it directly
    // as a pure function so the safety-critical gate has coverage that
    // doesn't depend on spinning up a real provider/streaming loop.
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn safe_mode_requires_approval_even_for_a_selective_safe_command() {
        // Regression test for #3149: before the fix, this gate ignored
        // `ApprovalMode` entirely and used the Selective heuristic no
        // matter what, so Safe mode never actually gated anything the
        // Selective heuristic would have auto-approved (e.g. `ls`).
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({"command": "ls -la"});

        // Sanity check: Selective mode alone would NOT require approval
        // for this command (this is what made the old gate look correct
        // in the default mode while being wrong in Safe mode).
        assert!(!tool_requires_approval(
            ApprovalMode::Selective,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &args,
        ));

        assert!(tool_requires_approval(
            ApprovalMode::Safe,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &args,
        ));
    }

    #[test]
    fn yolo_mode_never_requires_approval_for_native_tools() {
        let executor = ToolExecutor::new(".");
        // Even a command the Selective heuristic would flag as risky must
        // not require approval in Yolo mode -- "auto-approve ALL tool
        // calls" is the documented contract of `ApprovalMode::Yolo`.
        let risky_args = serde_json::json!({"command": "rm -rf /tmp/whatever"});
        assert!(tool_requires_approval(
            ApprovalMode::Selective,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &risky_args,
        ));
        assert!(!tool_requires_approval(
            ApprovalMode::Yolo,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &risky_args,
        ));
    }

    #[test]
    fn yolo_mode_still_requires_approval_for_sandbox_bypass_requests() {
        // Waiving the native sandbox must always be a decision a human
        // explicitly makes, so a `bypass_sandbox` request is the one
        // exception to Yolo's "auto-approve ALL tool calls" contract.
        let executor =
            ToolExecutor::new(".").with_sandbox_policy(crate::sandbox::SandboxPolicy::ReadOnly);
        let bypass_args = serde_json::json!({"command": "ls -la", "bypass_sandbox": true});
        assert!(tool_requires_approval(
            ApprovalMode::Yolo,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &bypass_args,
        ));

        // Without an active sandbox policy the flag is meaningless and Yolo
        // auto-approves as usual.
        let unsandboxed = ToolExecutor::new(".");
        assert!(!tool_requires_approval(
            ApprovalMode::Yolo,
            false,
            &FirewallVerdict::Allow,
            &unsandboxed,
            "bash",
            &bypass_args,
        ));
    }

    /// Regression test for the review finding on #3144: `NativeAgentConfig`
    /// carries a resolved sandbox policy, but only if
    /// `build_runner_tool_executor` (used to build the executor the runner
    /// actually executes every Yolo/allowlisted-Selective call through --
    /// see `NativeAgentConfig::sandbox_policy`'s doc comment) applies it.
    /// Before this fix the runner always built an unsandboxed executor
    /// regardless of what a caller (the interactive TUI, print mode) passed
    /// in `NativeAgentConfig`, so only calls that reached a *human* approval
    /// prompt (through a caller's separately-configured executor) were ever
    /// sandboxed -- Yolo mode and Selective mode's allowlisted calls got
    /// unrestricted host access. `requires_sandbox_bypass_approval` is used
    /// here only as an externally observable proxy for "this executor has an
    /// active sandbox policy" (`ToolExecutor` does not expose that field
    /// directly); the fix under test is the executor construction, not this
    /// specific method.
    #[test]
    fn runner_tool_executor_carries_the_configured_sandbox_policy() {
        let credential_vault = CredentialVault::new();
        let bypass_args = serde_json::json!({"command": "ls -la", "bypass_sandbox": true});

        let sandboxed = build_runner_tool_executor(
            ".",
            credential_vault.clone(),
            Some(crate::sandbox::SandboxPolicy::ReadOnly),
            None,
        );
        assert!(
            sandboxed.requires_sandbox_bypass_approval("bash", &bypass_args),
            "a configured sandbox_policy must reach the runner's own executor"
        );

        let unsandboxed = build_runner_tool_executor(".", credential_vault, None, None);
        assert!(
            !unsandboxed.requires_sandbox_bypass_approval("bash", &bypass_args),
            "no sandbox_policy configured must produce no sandbox awareness"
        );
    }

    #[test]
    fn runner_tool_executor_uses_the_parent_subagent_scope() {
        let executor = build_runner_tool_executor(
            ".",
            CredentialVault::new(),
            None,
            Some("app-parent-scope".to_string()),
        );

        assert_eq!(
            executor.subagent_parent_scope_id(),
            "app-parent-scope",
            "auto-executed delegation must publish events to the caller's scope"
        );
    }

    #[test]
    fn empty_bash_is_rewritten_before_approval_and_execution() {
        let (args, rewritten) =
            normalize_post_hook_tool_args("BASH", serde_json::json!({"command": " \n\t"}));

        assert!(rewritten);
        assert_eq!(args, serde_json::json!({"command": "pwd"}));

        let executor = ToolExecutor::new(".");
        assert!(!tool_requires_approval(
            ApprovalMode::Yolo,
            false,
            &FirewallVerdict::Allow,
            &executor,
            "bash",
            &args,
        ));
    }

    #[test]
    fn hook_modified_empty_bash_is_normalized_before_approval_and_execution() {
        let hook_result = HookResult::ModifyInput {
            new_input: serde_json::json!({"command": " \n\t"}),
        };
        let HookResult::ModifyInput { new_input } = hook_result else {
            unreachable!("test constructs a ModifyInput result");
        };

        let (args, rewritten) = normalize_post_hook_tool_args("bash", new_input);

        assert!(rewritten);
        assert_eq!(args, serde_json::json!({"command": "pwd"}));
        assert!(
            ToolExecutor::new(".")
                .missing_required("bash", &args)
                .is_empty(),
            "hook-produced arguments must be normalized before validation"
        );
    }

    #[test]
    fn external_tool_always_requires_approval_regardless_of_mode() {
        // Callers embedding external tools (the SDK / ambient-agent path)
        // own execution and their own approval policy; even Yolo must not
        // let this runner treat the call as pre-approved.
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({});
        assert!(tool_requires_approval(
            ApprovalMode::Yolo,
            true,
            &FirewallVerdict::Allow,
            &executor,
            "some_external_tool",
            &args,
        ));
    }

    #[test]
    fn firewall_soft_hold_is_bypassed_only_in_yolo_mode() {
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({"command": "ls"});
        let verdict = FirewallVerdict::RequireApproval {
            reason: "test".to_string(),
        };

        // A firewall soft-hold forces approval in Safe and Selective mode
        // even for a command the per-tool heuristic alone would allow.
        assert!(tool_requires_approval(
            ApprovalMode::Selective,
            false,
            &verdict,
            &executor,
            "bash",
            &args,
        ));
        assert!(tool_requires_approval(
            ApprovalMode::Safe,
            false,
            &verdict,
            &executor,
            "bash",
            &args,
        ));
        // Yolo bypasses the soft hold too (matches the pre-existing
        // `app.rs` semantics this logic was migrated from).
        assert!(!tool_requires_approval(
            ApprovalMode::Yolo,
            false,
            &verdict,
            &executor,
            "bash",
            &args,
        ));
    }

    #[test]
    fn test_config_with_custom_model() {
        let config = NativeAgentConfig {
            model: "gpt-5.1-codex-max".to_string(),
            max_tokens: 8192,
            system_prompt: Some("You are a helpful assistant.".to_string()),
            thinking_enabled: true,
            thinking_budget: 5000,
            cwd: "/tmp".to_string(),
            ..NativeAgentConfig::default()
        };
        assert_eq!(config.model, "gpt-5.1-codex-max");
        assert_eq!(config.max_tokens, 8192);
        assert!(config.thinking_enabled);
        assert_eq!(config.thinking_budget, 5000);
    }

    #[test]
    fn test_thinking_config() {
        let thinking = ThinkingConfig::enabled(10000);
        assert_eq!(thinking.thinking_type, "enabled");
        assert_eq!(thinking.budget_tokens, 10000);
    }

    #[test]
    fn test_tool_definition_clone() {
        let tool_def = ToolDefinition {
            tool: Tool::new("test", "A test tool").with_schema(serde_json::json!({
                "type": "object",
                "properties": {}
            })),
            requires_approval: true,
        };
        let cloned = tool_def.clone();
        assert_eq!(cloned.tool.name, "test");
        assert!(cloned.requires_approval);
    }

    #[test]
    fn compact_tool_for_model_strips_legacy_alias_properties() {
        let tool = Tool::new("read", "Read a file").with_schema(serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file" },
                "file_path": { "type": "string", "description": "Legacy alias for path" },
                "offset": { "type": "number", "description": "Start line" }
            },
            "required": ["path"]
        }));
        let compact = compact_tool_for_model(tool);
        let props = compact.input_schema["properties"].as_object().unwrap();
        assert!(props.contains_key("path"));
        assert!(props.contains_key("offset"));
        assert!(!props.contains_key("file_path"));
    }

    #[test]
    fn test_tool_registry_integration() {
        // Verify tools are registered correctly from registry
        let registry = ToolRegistry::new();
        let tools: Vec<_> = registry.tools().collect();

        // Should have bash, read, write, glob, grep
        assert!(tools.len() >= 5);

        // Verify tool names
        let names: Vec<_> = tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(names.contains(&"bash"));
        assert!(names.contains(&"read"));
        assert!(names.contains(&"write"));
        assert!(names.contains(&"glob"));
        assert!(names.contains(&"grep"));
    }

    #[test]
    fn fast_tool_profile_is_small_but_has_an_escape_hatch() {
        let registry = ToolRegistry::new();
        let definitions = registry
            .tools()
            .map(|definition| (definition.tool.name.clone(), definition.clone()))
            .collect::<HashMap<_, _>>();
        let active =
            initial_active_tool_names(ToolProfile::Fast, &definitions, &HashSet::new(), None);

        assert!(active.contains("read"));
        assert!(active.contains("bash"));
        assert!(active.contains("tool_search"));
        assert!(active.contains("explore"));
        assert!(!active.contains("gh_pr"));
        assert!(!active.contains("vscode_get_definition"));
    }

    #[test]
    fn all_tool_profile_preserves_every_registered_tool() {
        let registry = ToolRegistry::new();
        let definitions = registry
            .tools()
            .map(|definition| (definition.tool.name.clone(), definition.clone()))
            .collect::<HashMap<_, _>>();
        let active =
            initial_active_tool_names(ToolProfile::All, &definitions, &HashSet::new(), None);

        assert_eq!(active.len(), definitions.len());
    }

    #[test]
    fn explicit_allowed_tools_override_fast_profile() {
        let registry = ToolRegistry::new();
        let definitions = registry
            .tools()
            .map(|definition| (definition.tool.name.clone(), definition.clone()))
            .collect::<HashMap<_, _>>();
        let allowed = HashSet::from([String::from("websearch")]);

        let active = initial_active_tool_names(
            ToolProfile::Fast,
            &definitions,
            &HashSet::new(),
            Some(&allowed),
        );

        assert!(active.contains("websearch"));
    }

    #[test]
    fn tool_visibility_matches_model_schema_filtering() {
        assert!(!tool_is_visible_to_model(
            "vscode_get_definition",
            false,
            false
        ));
        assert!(tool_is_visible_to_model(
            "vscode_get_definition",
            false,
            true
        ));
        assert!(!tool_is_visible_to_model("get_goal", false, true));
        assert!(tool_is_visible_to_model("get_goal", true, false));
        assert!(tool_is_visible_to_model("websearch", false, false));
    }

    #[test]
    fn test_request_config_building() {
        let config = NativeAgentConfig {
            model: "claude-sonnet-4-5-20250514".to_string(),
            max_tokens: 8192,
            system_prompt: Some("Test system prompt".to_string()),
            thinking_enabled: false,
            thinking_budget: 0,
            cwd: ".".to_string(),
            ..NativeAgentConfig::default()
        };

        // Build request config manually to verify structure
        let tools: Vec<Tool> = ToolRegistry::new()
            .tools()
            .map(|td| td.tool.clone())
            .collect();

        let request_config = RequestConfig {
            model: config.model.clone(),
            max_tokens: config.max_tokens,
            temperature: Some(0.7),
            system: config.system_prompt.clone(),
            tools: tools.into(),
            thinking: None,
            cache_system_prompt: true, // Test caching enabled
        };

        assert_eq!(request_config.model, "claude-sonnet-4-5-20250514");
        assert_eq!(request_config.max_tokens, 8192);
        assert!(request_config.system.is_some());
        assert!(!request_config.tools.is_empty());
        assert!(request_config.cache_system_prompt);
    }

    #[test]
    fn test_thinking_config_with_budget() {
        let config = NativeAgentConfig {
            model: "claude-opus-4-5-20251101".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: true,
            thinking_budget: 15000,
            cwd: ".".to_string(),
            ..NativeAgentConfig::default()
        };

        let thinking = if config.thinking_enabled {
            Some(ThinkingConfig::enabled(config.thinking_budget))
        } else {
            None
        };

        assert!(thinking.is_some());
        let thinking = thinking.unwrap();
        assert_eq!(thinking.thinking_type, "enabled");
        assert_eq!(thinking.budget_tokens, 15000);
    }

    #[test]
    fn test_from_agent_variants() {
        // Test that FromAgent variants serialize/deserialize correctly
        let ready = FromAgent::Ready {
            model: "claude-sonnet".to_string(),
            provider: "Anthropic".to_string(),
        };
        if let FromAgent::Ready { model, provider } = ready {
            assert_eq!(model, "claude-sonnet");
            assert_eq!(provider, "Anthropic");
        } else {
            panic!("Expected Ready variant");
        }

        let chunk = FromAgent::ResponseChunk {
            response_id: "resp_123".to_string(),
            content: "Hello".to_string(),
            is_thinking: false,
        };
        if let FromAgent::ResponseChunk {
            content,
            is_thinking,
            ..
        } = chunk
        {
            assert_eq!(content, "Hello");
            assert!(!is_thinking);
        } else {
            panic!("Expected ResponseChunk variant");
        }
    }

    #[test]
    fn test_tool_result_structure() {
        let success_result = ToolResult::success("Command executed successfully");
        assert!(success_result.success);
        assert!(!success_result.output.is_empty());
        assert!(success_result.error.is_none());

        let error_result = ToolResult::failure("Permission denied");
        assert!(!error_result.success);
        assert!(error_result.output.is_empty());
        assert!(error_result.error.is_some());
    }

    #[test]
    fn test_parse_tool_input_empty_ok() {
        let parsed = parse_tool_input("noop", "").unwrap();
        assert_eq!(parsed, serde_json::json!({}));
    }

    #[test]
    fn test_parse_tool_input_invalid_json() {
        let err = parse_tool_input("bash", "{invalid").unwrap_err();
        assert!(err.contains("bash"));
        assert!(err.contains("Failed to parse tool input JSON"));
    }

    #[test]
    fn fatal_stream_error_discards_completed_tool_calls() {
        let mut assistant_content = vec![
            ContentBlock::Text {
                text: "partial response".to_string(),
            },
            ContentBlock::ToolUse {
                id: "call-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "true"}),
            },
        ];
        let mut pending_tool_calls = vec![(
            "call-1".to_string(),
            "bash".to_string(),
            serde_json::json!({"command": "true"}),
            None,
        )];

        abort_pending_tools_after_stream_error(&mut assistant_content, &mut pending_tool_calls);

        assert!(pending_tool_calls.is_empty());
        assert!(assistant_content
            .iter()
            .all(|block| !matches!(block, ContentBlock::ToolUse { .. })));
    }

    #[test]
    fn lifecycle_tool_args_preserve_opaque_credential_references() {
        let vault = CredentialVault::new();
        let reference = vault.store("secret-value", crate::agent::CredentialType::Token);
        let args = serde_json::json!({
            "task": format!("Use {reference} in the child")
        });

        assert_eq!(
            tool_args_for_execution("spawn_subagent", &args, &vault),
            args,
            "durable lifecycle records must retain the opaque reference"
        );
        assert_eq!(
            tool_args_for_execution("bash", &args, &vault),
            serde_json::json!({"task": "Use secret-value in the child"})
        );
    }

    #[test]
    fn provider_history_resolves_references_without_mutating_durable_history() {
        let vault = CredentialVault::new();
        let reference = vault.store("secret-value", crate::agent::CredentialType::Token);
        let history = vec![Message {
            role: Role::User,
            content: MessageContent::Text(format!("Use {reference} in the child")),
        }];

        let resolved = resolve_provider_history(&history, &vault).expect("history should resolve");
        let MessageContent::Text(resolved_text) = &resolved[0].content else {
            panic!("expected resolved text message");
        };
        assert_eq!(resolved_text, "Use secret-value in the child");

        let MessageContent::Text(durable_text) = &history[0].content else {
            panic!("expected vaulted text message");
        };
        assert_eq!(durable_text, &format!("Use {reference} in the child"));
    }

    #[test]
    fn provider_history_without_references_reuses_shared_storage() {
        let history = Arc::new(vec![Message {
            role: Role::User,
            content: MessageContent::text("ordinary history"),
        }]);
        let resolved = resolve_provider_history_shared(&history, &CredentialVault::new())
            .expect("history should be reusable");

        assert!(Arc::ptr_eq(&history, &resolved));
    }

    #[tokio::test]
    async fn test_wait_for_tool_response_buffers_out_of_order() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let tombstones = CancelledToolTombstones::default();
        let cancel = CancellationToken::new();
        let (consumed_tx, mut consumed_rx) = tokio::sync::oneshot::channel();
        let (buffered_consumed_tx, mut buffered_consumed_rx) = tokio::sync::oneshot::channel();

        tx.send((
            "id-2".to_string(),
            true,
            None,
            ExecutionSource::Native,
            Some(buffered_consumed_tx),
        ))
        .unwrap();
        tx.send((
            "id-1".to_string(),
            false,
            None,
            ExecutionSource::RemoteClient,
            Some(consumed_tx),
        ))
        .unwrap();

        let result =
            wait_for_tool_response("id-1", &mut rx, &mut pending, &tombstones, &cancel).await;
        assert!(matches!(
            result,
            ToolResponseWait::Response((false, None, ExecutionSource::RemoteClient))
        ));
        assert!(
            consumed_rx.try_recv().is_ok(),
            "the receipt must fire only when the native wait consumes the response"
        );
        assert!(pending.contains_key("id-2"));
        assert!(
            matches!(
                buffered_consumed_rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "buffering an out-of-order response must not acknowledge consumption"
        );

        let result =
            wait_for_tool_response("id-2", &mut rx, &mut pending, &tombstones, &cancel).await;
        assert!(matches!(
            result,
            ToolResponseWait::Response((true, None, ExecutionSource::Native))
        ));
        assert!(buffered_consumed_rx.try_recv().is_ok());
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn codex_concurrent_approvals_buffer_second_response_delivered_first() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let tombstones = CancelledToolTombstones::default();
        let cancel = CancellationToken::new();
        let (second_consumed_tx, mut second_consumed_rx) = tokio::sync::oneshot::channel();
        let (first_consumed_tx, mut first_consumed_rx) = tokio::sync::oneshot::channel();
        tx.send((
            "codex-call-b".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(second_consumed_tx),
        ))
        .unwrap();
        tx.send((
            "codex-call-a".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(first_consumed_tx),
        ))
        .unwrap();

        let first = wait_for_codex_tool_response(
            "codex-call-a",
            &mut rx,
            &mut pending,
            &tombstones,
            &cancel,
        )
        .await;
        assert!(matches!(
            first,
            ToolResponseWait::Response((true, None, ExecutionSource::RemoteClient))
        ));
        assert!(first_consumed_rx.try_recv().is_ok());
        assert!(matches!(
            second_consumed_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        let second = wait_for_codex_tool_response(
            "codex-call-b",
            &mut rx,
            &mut pending,
            &tombstones,
            &cancel,
        )
        .await;
        assert!(matches!(
            second,
            ToolResponseWait::Response((true, None, ExecutionSource::RemoteClient))
        ));
        assert!(second_consumed_rx.try_recv().is_ok());
        assert!(pending.is_empty());
    }

    #[test]
    fn deferred_cancellation_completes_receipt_with_correlated_rejection() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (buffered_tx, buffered_rx) = tokio::sync::oneshot::channel();
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let mut pending = HashMap::from([(
            "cancelled-buffered".to_string(),
            (true, None, ExecutionSource::RemoteClient, Some(buffered_tx)),
        )]);
        tx.send((
            "cancelled-queued".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(queued_tx),
        ))
        .unwrap();
        let cancelled = HashSet::from([
            "cancelled-buffered".to_string(),
            "cancelled-queued".to_string(),
        ]);
        let mut tombstones = CancelledToolTombstones::default();

        discard_cancelled_tool_responses(&cancelled, &mut rx, &mut pending, &mut tombstones);

        for outcome in [buffered_rx.blocking_recv(), queued_rx.blocking_recv()] {
            assert!(matches!(
                outcome,
                Ok(ToolResponseConsumption::Rejected { ref reason })
                    if reason.contains("cancelled before native consumption")
            ));
        }
        assert!(pending.is_empty());
    }

    #[test]
    fn cancellation_rejects_all_buffered_response_receipts() {
        let (consumed_tx, consumed_rx) = tokio::sync::oneshot::channel();
        let mut pending = HashMap::from([
            (
                "buffered-with-receipt".to_string(),
                (true, None, ExecutionSource::RemoteClient, Some(consumed_tx)),
            ),
            (
                "buffered-without-receipt".to_string(),
                (false, None, ExecutionSource::RemoteClient, None),
            ),
        ]);

        reject_buffered_tool_responses_on_cancel(&mut pending);

        assert!(matches!(
            consumed_rx.blocking_recv(),
            Ok(ToolResponseConsumption::Rejected { ref reason })
                if reason.contains("cancelled before native consumption")
        ));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn standard_cancel_first_response_later_rejects_tombstoned_call() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let mut tombstones = CancelledToolTombstones::default();
        tombstones.insert("cancelled-standard".to_string());
        let (late_tx, mut late_rx) = tokio::sync::oneshot::channel();
        tx.send((
            "cancelled-standard".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(late_tx),
        ))
        .unwrap();
        tx.send((
            "active-standard".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            None,
        ))
        .unwrap();

        let result = wait_for_tool_response(
            "active-standard",
            &mut rx,
            &mut pending,
            &tombstones,
            &CancellationToken::new(),
        )
        .await;

        assert!(matches!(
            result,
            ToolResponseWait::Response((true, None, _))
        ));
        assert!(matches!(
            late_rx.try_recv(),
            Ok(ToolResponseConsumption::Rejected { ref reason })
                if reason.contains("cancelled before native consumption")
        ));
        assert!(!pending.contains_key("cancelled-standard"));
    }

    #[tokio::test]
    async fn codex_cancel_first_response_later_rejects_tombstoned_call() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let mut tombstones = CancelledToolTombstones::default();
        tombstones.insert("cancelled-codex".to_string());
        let (late_tx, mut late_rx) = tokio::sync::oneshot::channel();
        tx.send((
            "cancelled-codex".to_string(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(late_tx),
        ))
        .unwrap();
        tx.send((
            "active-codex".to_string(),
            false,
            None,
            ExecutionSource::RemoteClient,
            None,
        ))
        .unwrap();

        let result = wait_for_codex_tool_response(
            "active-codex",
            &mut rx,
            &mut pending,
            &tombstones,
            &CancellationToken::new(),
        )
        .await;

        assert!(matches!(
            result,
            ToolResponseWait::Response((false, None, _))
        ));
        assert!(matches!(
            late_rx.try_recv(),
            Ok(ToolResponseConsumption::Rejected { ref reason })
                if reason.contains("cancelled before native consumption")
        ));
        assert!(!pending.contains_key("cancelled-codex"));
    }

    #[tokio::test]
    async fn cancelled_tombstones_are_bounded_and_allow_legitimate_id_reuse() {
        let mut tombstones = CancelledToolTombstones::default();
        for index in 0..(MAX_CANCELLED_TOOL_TOMBSTONES + 10) {
            tombstones.insert(format!("cancelled-{index}"));
        }
        assert_eq!(tombstones.len(), MAX_CANCELLED_TOOL_TOMBSTONES);
        assert!(!tombstones.contains("cancelled-0"));
        let reused = format!("cancelled-{}", MAX_CANCELLED_TOOL_TOMBSTONES + 9);
        assert!(tombstones.contains(&reused));
        tombstones.remove(&reused);

        let (tx, mut rx) = mpsc::unbounded_channel();
        let (consumed_tx, mut consumed_rx) = tokio::sync::oneshot::channel();
        tx.send((
            reused.clone(),
            true,
            None,
            ExecutionSource::RemoteClient,
            Some(consumed_tx),
        ))
        .unwrap();
        let mut pending = HashMap::new();
        let result = wait_for_tool_response(
            &reused,
            &mut rx,
            &mut pending,
            &tombstones,
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(
            result,
            ToolResponseWait::Response((true, None, _))
        ));
        assert_eq!(
            consumed_rx.try_recv(),
            Ok(ToolResponseConsumption::Accepted)
        );
        tombstones.clear();
        assert_eq!(tombstones.len(), 0);
    }

    #[tokio::test]
    async fn approval_wait_honors_cancellation_before_buffered_decisions() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::from([(
            "id-1".to_string(),
            (true, None, ExecutionSource::Native, None),
        )]);
        let cancel = CancellationToken::new();
        let tombstones = CancelledToolTombstones::default();
        cancel.cancel();

        let result =
            wait_for_tool_response("id-1", &mut rx, &mut pending, &tombstones, &cancel).await;

        assert!(matches!(result, ToolResponseWait::Cancelled));
        assert!(pending.contains_key("id-1"));
    }

    #[tokio::test]
    async fn shutdown_preempts_pending_tool_response_wait() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let shutdown_token = CancellationToken::new();
        let cancel = shutdown_token.child_token();
        let tombstones = CancelledToolTombstones::default();

        let waiting = tokio::spawn(async move {
            let result =
                wait_for_tool_response("id-1", &mut rx, &mut pending, &tombstones, &cancel).await;
            (result, pending)
        });
        tokio::task::yield_now().await;
        shutdown_token.cancel();

        let (result, pending) =
            tokio::time::timeout(std::time::Duration::from_millis(100), waiting)
                .await
                .expect("shutdown should preempt an approval wait")
                .expect("approval wait task should not panic");
        assert!(matches!(result, ToolResponseWait::Cancelled));
        assert!(pending.is_empty());
    }

    #[test]
    fn later_auto_approved_calls_defer_behind_an_approval_boundary() {
        assert_eq!(
            deferred_tool_call_disposition(true, false),
            Some(DeferredToolCallDisposition::AwaitApproval)
        );
        assert_eq!(
            deferred_tool_call_disposition(false, true),
            Some(DeferredToolCallDisposition::Execute)
        );
        assert_eq!(deferred_tool_call_disposition(false, false), None);
    }

    #[test]
    fn deferred_execution_reruns_state_dependent_pre_tool_use_hook() {
        let block = Arc::new(AtomicBool::new(false));
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_pre_tool_use(Arc::new(StateDependentPreToolUseHook {
                block: Arc::clone(&block),
            }));
        let original_args = serde_json::json!({"command": "touch later"});
        let call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: original_args.clone(),
            safe_args: original_args.clone(),
            extra_context: None,
            pre_hook_args: original_args.clone(),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };

        assert!(matches!(
            hooks.execute_pre_tool_use(&call.tool_name, &call.call_id, &original_args),
            HookResult::Continue
        ));
        block.store(true, Ordering::SeqCst);

        assert_eq!(
            rerun_deferred_pre_tool_use(&mut hooks, &call),
            Err("state changed".to_string())
        );
    }

    #[test]
    fn deferred_execution_uses_second_modify_input_from_original_args() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_pre_tool_use(Arc::new(SequencedModifyPreToolUseHook {
                calls: Arc::clone(&calls),
            }));
        let original_args = serde_json::json!({"command": "model-input"});
        let initial_args = match hooks.execute_pre_tool_use("bash", "call-later", &original_args) {
            HookResult::ModifyInput { new_input } => new_input,
            result => panic!("expected initial ModifyInput, got {result:?}"),
        };
        let call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: initial_args.clone(),
            safe_args: initial_args,
            extra_context: None,
            pre_hook_args: original_args,
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };

        let (refreshed_args, refreshed_context) =
            rerun_deferred_pre_tool_use(&mut hooks, &call).expect("second ModifyInput");
        assert_eq!(refreshed_args, serde_json::json!({"command": "rewrite-2"}));
        assert_eq!(refreshed_context, None);
        assert_eq!(
            approved_input_change_rejection(&call.args, &refreshed_args),
            Some("Tool input changed after approval; retry to review refreshed input")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn approved_inline_environment_must_match_at_execution_boundary() {
        let approved = HashMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("GIT_ASKPASS".to_string(), "/approved/helper".to_string()),
        ]);
        let same = approved.clone();
        let changed = HashMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("GIT_ASKPASS".to_string(), "/new/helper".to_string()),
        ]);

        assert_eq!(
            approved_inline_env_change_rejection(Some(&approved), Some(&same)),
            None,
        );
        assert_eq!(
            approved_inline_env_change_rejection(Some(&approved), Some(&changed)),
            Some(
                "Inline tool environment changed after approval; retry to review refreshed environment"
            ),
        );
        assert_eq!(
            approved_inline_env_change_rejection(Some(&approved), None),
            Some(
                "Inline tool environment changed after approval; retry to review refreshed environment"
            ),
        );
        assert_eq!(
            approved_inline_env_change_rejection(None, Some(&changed)),
            None,
        );
    }

    #[test]
    fn approval_event_carries_the_execution_snapshot_without_serializing_it() {
        let args = serde_json::json!({});
        let approved_env = HashMap::from([
            ("PATH".to_string(), "/approved/bin".to_string()),
            (
                "DATABASE_URL".to_string(),
                "postgres://user:password@example.test/db".to_string(),
            ),
        ]);
        let call = ToolCallContext {
            call_id: "call-inline".to_string(),
            tool_name: "deploy".to_string(),
            args: args.clone(),
            safe_args: args.clone(),
            extra_context: None,
            pre_hook_args: args,
            initial_firewall_verdict: FirewallVerdict::RequireApproval {
                reason: "inline tool".to_string(),
            },
            approval_inline_env: Some(InlineToolApprovalContext {
                command: "./deploy.sh".to_string(),
                source_path: ".composer/tools.json".to_string(),
                source_label: "project".to_string(),
                cwd: "/workspace".to_string(),
                environment: approved_env.clone(),
                shell: "/bin/sh".to_string(),
                shell_arg: "-c".to_string(),
            }),
        };

        let event = deferred_tool_call_event(&call, true);
        let carried_env = match &event {
            FromAgent::ToolCall {
                approval_inline_env,
                ..
            } => approval_inline_env.as_ref(),
            event => panic!("expected ToolCall, got {event:?}"),
        };
        assert_eq!(
            carried_env.map(|context| &context.environment),
            Some(&approved_env)
        );

        // The raw snapshot exists only on the in-process handoff. Approval
        // rendering applies its credential redactor before displaying values,
        // and serialization must not leak the pre-redaction map.
        let serialized = serde_json::to_string(&event).expect("serialize ToolCall");
        assert!(!serialized.contains("approval_inline_env"));
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn deferred_execution_handles_continue_and_inject_context() {
        let original_args = serde_json::json!({"command": "model-input"});
        let call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: original_args.clone(),
            safe_args: original_args.clone(),
            extra_context: Some("stale context".to_string()),
            pre_hook_args: original_args.clone(),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let mut continue_hooks = IntegratedHookSystem::new("/tmp");
        assert_eq!(
            rerun_deferred_pre_tool_use(&mut continue_hooks, &call),
            Ok((original_args.clone(), None))
        );
        assert_eq!(
            approved_input_change_rejection(&call.args, &original_args),
            None
        );

        let mut context_hooks = IntegratedHookSystem::new("/tmp");
        context_hooks
            .registry
            .register_pre_tool_use(Arc::new(InjectContextPreToolUseHook));
        assert_eq!(
            rerun_deferred_pre_tool_use(&mut context_hooks, &call),
            Ok((original_args, Some("fresh context".to_string())))
        );
    }

    #[test]
    fn deferred_hook_refresh_normalizes_before_required_field_validation() {
        let mut hooks = IntegratedHookSystem::new("/tmp");
        let bash_args = serde_json::json!({"command": ""});
        let bash_call = ToolCallContext {
            call_id: "call-bash".to_string(),
            tool_name: "bash".to_string(),
            args: bash_args.clone(),
            safe_args: bash_args.clone(),
            extra_context: None,
            pre_hook_args: bash_args,
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let (refreshed, _) =
            rerun_deferred_pre_tool_use(&mut hooks, &bash_call).expect("continue hook");
        let (normalized, rewrote) = normalize_post_hook_tool_args("bash", refreshed);
        let executor = ToolExecutor::new("/tmp".to_string());
        assert!(rewrote);
        assert_eq!(normalized, serde_json::json!({"command": "pwd"}));
        assert!(executor.missing_required("bash", &normalized).is_empty());

        let read_args = serde_json::json!({});
        let read_call = ToolCallContext {
            call_id: "call-read".to_string(),
            tool_name: "read".to_string(),
            args: read_args.clone(),
            safe_args: read_args.clone(),
            extra_context: None,
            pre_hook_args: read_args,
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let (refreshed, _) =
            rerun_deferred_pre_tool_use(&mut hooks, &read_call).expect("continue hook");
        let (normalized, rewrote) = normalize_post_hook_tool_args("read", refreshed);
        assert!(!rewrote);
        assert_eq!(executor.missing_required("read", &normalized), vec!["path"]);
    }

    #[test]
    fn deferred_tool_call_event_matches_refreshed_vaulted_execution_input() {
        let secret = ["sk", "-", "abc123def456ghi789jkl012mno345pqr678"].join("");
        let refreshed_args = serde_json::json!({
            "command": format!("curl -H 'Authorization: Bearer {secret}' example.test")
        });
        let mut hooks = IntegratedHookSystem::new("/tmp");
        hooks
            .registry
            .register_pre_tool_use(Arc::new(FixedModifyPreToolUseHook {
                new_input: refreshed_args.clone(),
            }));
        let original_args = serde_json::json!({"command": "echo stale"});
        let mut call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: original_args.clone(),
            safe_args: original_args.clone(),
            extra_context: None,
            pre_hook_args: original_args,
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let (args, extra_context) =
            rerun_deferred_pre_tool_use(&mut hooks, &call).expect("modified input");
        let (args, rewrote) = normalize_post_hook_tool_args(&call.tool_name, args);
        let executor = ToolExecutor::new("/tmp".to_string());
        assert!(!rewrote);
        assert!(executor.missing_required(&call.tool_name, &args).is_empty());
        let vault = CredentialVault::new();
        call.args = args;
        call.safe_args = vault.vault_in_json(&call.args);
        call.extra_context = extra_context;

        let event_args = match deferred_tool_call_event(&call, false) {
            FromAgent::ToolCall { args, .. } => args,
            event => panic!("expected ToolCall, got {event:?}"),
        };
        assert_eq!(event_args, call.safe_args);
        assert!(!event_args.to_string().contains(&secret));
        assert_eq!(vault.resolve_in_json(&event_args), refreshed_args);
    }

    #[test]
    fn deferred_hook_block_emits_one_terminal_receipt() {
        let args = serde_json::json!({"command": "touch later"});
        let call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: args.clone(),
            safe_args: args.clone(),
            extra_context: None,
            pre_hook_args: args,
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let (events, result) = deferred_hook_block(&call, "state changed".to_string(), true);

        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FromAgent::ToolCall { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FromAgent::ToolEnd { .. }))
                .count(),
            1
        );
        assert!(events.iter().any(|event| matches!(
            event,
            FromAgent::ToolEnd {
                success: false,
                receipt: Some(_),
                ..
            }
        )));
        assert!(matches!(
            result,
            ContentBlock::ToolResult {
                is_error: Some(true),
                ..
            }
        ));
    }

    #[test]
    fn approved_deferred_call_requires_fresh_consent_for_new_firewall_hold() {
        let original_hold = FirewallVerdict::RequireApproval {
            reason: "existing hold".to_string(),
        };
        assert_eq!(
            deferred_approved_policy_rejection(
                &original_hold,
                FirewallVerdict::RequireApproval {
                    reason: "existing hold".to_string(),
                },
            ),
            None
        );
        assert_eq!(
            deferred_approved_policy_rejection(
                &FirewallVerdict::Allow,
                FirewallVerdict::RequireApproval {
                    reason: "new PII state".to_string(),
                },
            ),
            Some(
                "Tool requires fresh approval after earlier tool execution: new PII state"
                    .to_string()
            )
        );
        assert_eq!(
            deferred_approved_policy_rejection(
                &original_hold,
                FirewallVerdict::RequireApproval {
                    reason: "changed hold".to_string(),
                },
            ),
            Some(
                "Tool requires fresh approval after earlier tool execution: changed hold"
                    .to_string()
            )
        );
        assert_eq!(
            deferred_approved_policy_rejection(
                &FirewallVerdict::Allow,
                FirewallVerdict::Block {
                    reason: "blocked now".to_string(),
                },
            ),
            Some("blocked now".to_string())
        );
    }

    #[test]
    fn deferred_execution_rechecks_updated_safety_history() {
        let mut safety = SafetyController::new();
        let args = serde_json::json!({"command": "printf test"});
        let call = ToolCallContext {
            call_id: "call-3".to_string(),
            tool_name: "bash".to_string(),
            args: args.clone(),
            safe_args: args.clone(),
            extra_context: None,
            pre_hook_args: args.clone(),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };

        assert_eq!(
            deferred_execution_safety_verdict(&safety, &call),
            SafetyVerdict::Allow
        );
        safety.record_tool_call("bash", &args);
        safety.record_tool_call("bash", &args);

        assert!(matches!(
            deferred_execution_safety_verdict(&safety, &call),
            SafetyVerdict::BlockDoomLoop { .. }
        ));

        assert!(matches!(
            deferred_rejection_output_event(&call, "doom loop"),
            FromAgent::ToolOutput { call_id, content }
                if call_id == "call-3" && content == "doom loop"
        ));
        match deferred_safety_rejection_event(&call, "doom loop") {
            FromAgent::ToolEnd {
                call_id,
                success,
                result,
                receipt,
            } => {
                assert_eq!(call_id, "call-3");
                assert!(!success);
                assert!(result.is_some_and(|result| !result.success));
                assert_eq!(
                    receipt.map(|receipt| receipt.status),
                    Some(crate::agent::ExecutionStatus::Failed)
                );
            }
            event => panic!("expected terminal event, got {event:?}"),
        }
    }

    #[test]
    fn cancelled_deferred_calls_emit_terminal_queued_receipts() {
        let call = ToolCallContext {
            call_id: "call-later".to_string(),
            tool_name: "bash".to_string(),
            args: serde_json::json!({"command": "touch later"}),
            safe_args: serde_json::json!({"command": "touch later"}),
            extra_context: None,
            pre_hook_args: serde_json::json!({"command": "touch later"}),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };

        let (event, result_block) =
            cancelled_deferred_tool(&call, "Skipped after request cancellation.");

        match event {
            FromAgent::ToolEnd {
                call_id,
                success,
                receipt: Some(receipt),
                ..
            } => {
                assert_eq!(call_id, "call-later");
                assert!(!success);
                assert_eq!(
                    receipt.status,
                    crate::agent::ExecutionStatus::Cancelled {
                        phase: ExecutionPhase::Queued
                    }
                );
            }
            other => panic!("expected ToolEnd, got {other:?}"),
        }
        assert!(matches!(
            result_block,
            ContentBlock::ToolResult {
                tool_use_id,
                is_error: Some(true),
                ..
            } if tool_use_id == "call-later"
        ));
    }

    #[test]
    fn interruption_before_deferred_suffix_closes_every_call() {
        let deferred_calls = ["call-first", "call-second"].into_iter().map(|call_id| {
            DeferredToolCall::Execute(ToolCallContext {
                call_id: call_id.to_string(),
                tool_name: "bash".to_string(),
                args: serde_json::json!({"command": "touch later"}),
                safe_args: serde_json::json!({"command": "touch later"}),
                extra_context: None,
                pre_hook_args: serde_json::json!({"command": "touch later"}),
                initial_firewall_verdict: FirewallVerdict::Allow,
                approval_inline_env: None,
            })
        });
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let mut tool_results = Vec::new();

        let cancelled_ids = cancel_deferred_suffix(&event_tx, deferred_calls, &mut tool_results);

        assert_eq!(tool_results.len(), 2);
        assert_eq!(
            cancelled_ids,
            HashSet::from(["call-first".to_string(), "call-second".to_string()])
        );
        let events: Vec<_> = std::iter::from_fn(|| event_rx.try_recv().ok()).collect();
        assert_eq!(events.len(), 6);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FromAgent::ToolCall { .. }))
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FromAgent::ToolEnd { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn cancelled_suffix_announces_only_previously_unannounced_execute_calls() {
        let args = serde_json::json!({"command": "touch later"});
        let make_call = |call_id: &str| ToolCallContext {
            call_id: call_id.to_string(),
            tool_name: "bash".to_string(),
            args: args.clone(),
            safe_args: args.clone(),
            extra_context: None,
            pre_hook_args: args.clone(),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        let deferred_calls = [
            DeferredToolCall::AwaitApproval(make_call("call-announced")),
            DeferredToolCall::Execute(make_call("call-unannounced")),
        ];
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let mut tool_results = Vec::new();

        cancel_deferred_suffix(&event_tx, deferred_calls, &mut tool_results);

        let events: Vec<_> = std::iter::from_fn(|| event_rx.try_recv().ok()).collect();
        let announced_ids: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                FromAgent::ToolCall { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(announced_ids, vec!["call-unannounced"]);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FromAgent::ToolEnd { .. }))
                .count(),
            2
        );
        assert_eq!(tool_results.len(), 2);
    }

    #[test]
    fn cancelled_suffix_discards_only_its_queued_approvals() {
        let cancelled_ids = HashSet::from([
            "call-cancelled-buffered".to_string(),
            "call-cancelled-queued".to_string(),
        ]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send((
            "call-cancelled-queued".to_string(),
            true,
            None,
            ExecutionSource::Native,
            None,
        ))
        .expect("queue cancelled approval");
        tx.send((
            "call-unrelated".to_string(),
            false,
            None,
            ExecutionSource::Native,
            None,
        ))
        .expect("queue unrelated approval");
        let mut pending = HashMap::from([
            (
                "call-cancelled-buffered".to_string(),
                (true, None, ExecutionSource::Native, None),
            ),
            (
                "call-existing".to_string(),
                (false, None, ExecutionSource::Native, None),
            ),
        ]);

        let mut tombstones = CancelledToolTombstones::default();
        discard_cancelled_tool_responses(&cancelled_ids, &mut rx, &mut pending, &mut tombstones);

        assert!(!pending.contains_key("call-cancelled-buffered"));
        assert!(!pending.contains_key("call-cancelled-queued"));
        assert_eq!(
            pending
                .get("call-existing")
                .map(|(approved, _, _, _)| *approved),
            Some(false)
        );
        assert_eq!(
            pending
                .get("call-unrelated")
                .map(|(approved, _, _, _)| *approved),
            Some(false)
        );
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn serial_tool_boundary_invalidates_cached_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("ordered-cache.txt");
        std::fs::write(&file_path, "before").expect("write initial file");
        let executor = ToolExecutor::new(dir.path().display().to_string());
        let args = serde_json::json!({
            "file_path": file_path,
            "lineNumbers": false,
            "wrapInCodeFence": false,
            "withDiagnostics": false,
        });

        let initial = executor.execute("read", &args, None, "read-before").await;
        assert!(initial.output.contains("before"));
        std::fs::write(&file_path, "after").expect("simulate serial mutation");
        let stale = executor.execute("read", &args, None, "read-stale").await;
        assert!(stale.output.contains("before"));

        invalidate_cache_after_serial_tool(&executor, "bash", true);

        let refreshed = executor.execute("read", &args, None, "read-after").await;
        assert!(refreshed.output.contains("after"));
        assert!(!refreshed.output.contains("before"));
    }

    #[test]
    fn deferred_firewall_observes_workflow_state_from_prior_calls() {
        let dir = tempfile::tempdir().expect("tempdir");
        let firewall = ActionFirewall::new(dir.path());
        let mut workflow = WorkflowStateTracker::default();
        apply_workflow_state_hooks(
            "collect_customer_context",
            "call-capture",
            &serde_json::json!({"subject": "customer email"}),
            &mut workflow,
            false,
        )
        .expect("record PII workflow state");

        let verdict = deferred_firewall_verdict(
            &firewall,
            "send_notification",
            &serde_json::json!({"message": "update"}),
            &workflow.snapshot(),
            None,
            false,
        );

        assert!(matches!(
            verdict,
            FirewallVerdict::RequireApproval { reason }
                if reason.contains("Unredacted PII")
        ));

        let call = ToolCallContext {
            call_id: "call-notify".to_string(),
            tool_name: "send_notification".to_string(),
            args: serde_json::json!({"message": "update"}),
            safe_args: serde_json::json!({"message": "update"}),
            extra_context: None,
            pre_hook_args: serde_json::json!({"message": "update"}),
            initial_firewall_verdict: FirewallVerdict::Allow,
            approval_inline_env: None,
        };
        assert!(matches!(
            deferred_policy_rejection_event(&call, "approval required"),
            FromAgent::ToolEnd {
                call_id,
                success: false,
                ..
            } if call_id == "call-notify"
        ));
    }

    /// Regression test for #3149: once a call is genuinely awaiting approval
    /// (`requires_approval == true`, which after the fix now also holds in
    /// Safe mode -- see `safe_mode_requires_approval_even_for_a_selective_safe_command`),
    /// a `(call_id, false, None)` denial -- exactly what `handle_tool_approval`
    /// sends on Deny -- must resolve `wait_for_tool_response` (covered by
    /// `test_wait_for_tool_response_buffers_out_of_order` above) into a
    /// denied `ToolExecution` that reads as an error to the model, and must
    /// never reach `execute_tool`. `run_loop` only calls `execute_tool` when
    /// `approved` is true (see the `if approved && result.is_none()` branch);
    /// this asserts the denied-branch value it builds instead.
    #[test]
    fn denied_tool_response_is_an_error_result_and_never_executes() {
        let (approved, result): (bool, Option<ToolResult>) = (false, None);
        assert!(!approved, "run_loop must not call execute_tool when denied");

        let execution = if approved {
            unreachable!("this test only covers the denied branch");
        } else {
            ToolExecution::denied("call-1", "bash", DenialReason::User)
        };
        assert!(result.is_none());
        assert!(execution.is_error());
        assert!(execution
            .model_content()
            .to_lowercase()
            .contains("denied by user"));
    }

    /// Every assistant `ToolUse` id must have exactly one matching `ToolResult`
    /// in a user message that follows it - the invariant the OpenAI and
    /// Anthropic serializers (and providers) rely on.
    fn assert_tool_call_pairing(messages: &[Message]) {
        let mut tool_use_ids: Vec<String> = Vec::new();
        let mut tool_result_ids: Vec<String> = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            let MessageContent::Blocks(blocks) = &message.content else {
                continue;
            };
            for block in blocks {
                match block {
                    ContentBlock::ToolUse { id, .. } => {
                        assert_eq!(message.role, Role::Assistant);
                        tool_use_ids.push(id.clone());
                    }
                    ContentBlock::ToolResult { tool_use_id, .. } => {
                        assert_eq!(message.role, Role::User);
                        assert!(index > 0, "tool result cannot lead the history");
                        tool_result_ids.push(tool_use_id.clone());
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(
            tool_use_ids, tool_result_ids,
            "every tool call must have exactly one tool result, in order"
        );
    }

    fn assistant_tool_use_message(calls: &[(&str, &str)]) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(
                calls
                    .iter()
                    .map(|(id, name)| ContentBlock::ToolUse {
                        id: (*id).to_string(),
                        name: (*name).to_string(),
                        input: serde_json::json!({}),
                    })
                    .collect(),
            ),
        }
    }

    fn tool_result_blocks(message: &Message) -> Vec<(String, String, Option<bool>)> {
        match &message.content {
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => Some((tool_use_id.clone(), content.clone(), *is_error)),
                    _ => None,
                })
                .collect(),
            MessageContent::Text(_) => Vec::new(),
        }
    }

    #[test]
    fn test_repair_orphaned_tool_calls_synthesizes_missing_results() {
        // A turn cancelled after the assistant message was recorded but before
        // any tool result was appended (the Ctrl+C-during-bash repro).
        let mut messages = vec![
            Message {
                role: Role::User,
                content: MessageContent::Text("run sleep 120 via bash".to_string()),
            },
            assistant_tool_use_message(&[("call_1", "bash"), ("call_2", "read")]),
        ];
        let mut pending = HashMap::new();

        repair_orphaned_tool_calls(&mut messages, &mut pending);

        assert_eq!(messages.len(), 3);
        let repairs = tool_result_blocks(&messages[2]);
        assert_eq!(repairs.len(), 2);
        assert_eq!(repairs[0].0, "call_1");
        assert_eq!(repairs[1].0, "call_2");
        for (_, content, is_error) in &repairs {
            assert_eq!(content, "Tool execution cancelled by user.");
            assert_eq!(*is_error, Some(true));
        }
        assert_tool_call_pairing(&messages);

        // The cancellation terminal path repairs before emitting its durable
        // snapshot, so the next process never restores an orphaned ToolUse.
        let snapshot = conversation_snapshot_event(&messages).expect("snapshot event");
        let FromAgent::ConversationSnapshot {
            messages: snapshot_messages,
            ..
        } = snapshot
        else {
            panic!("expected semantic snapshot");
        };
        assert_tool_call_pairing(&snapshot_messages);

        // A subsequent prompt must not leave the orphaned call in the middle
        // of the history: the pairing still holds after it is appended.
        messages.push(Message {
            role: Role::User,
            content: MessageContent::Text("next prompt".to_string()),
        });
        assert_tool_call_pairing(&messages);
    }

    #[test]
    fn test_repair_orphaned_tool_calls_prefers_late_real_results() {
        // The app still delivers the cancelled tool's real outcome on the
        // tool-response channel; use it instead of a synthesized message.
        let mut messages = vec![assistant_tool_use_message(&[("call_1", "bash")])];
        let mut pending = HashMap::new();
        pending.insert(
            "call_1".to_string(),
            (
                true,
                Some(ToolResult::failure("Command cancelled")),
                ExecutionSource::Native,
                None,
            ),
        );

        repair_orphaned_tool_calls(&mut messages, &mut pending);

        assert_eq!(messages.len(), 2);
        let repairs = tool_result_blocks(&messages[1]);
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].0, "call_1");
        assert!(repairs[0].1.contains("Command cancelled"));
        assert_eq!(repairs[0].2, Some(true));
        assert!(pending.is_empty());
        assert_tool_call_pairing(&messages);
    }

    #[test]
    fn test_repair_orphaned_tool_calls_records_denials() {
        let mut messages = vec![assistant_tool_use_message(&[("call_1", "write")])];
        let mut pending = HashMap::new();
        pending.insert(
            "call_1".to_string(),
            (false, None, ExecutionSource::Native, None),
        );

        repair_orphaned_tool_calls(&mut messages, &mut pending);

        let repairs = tool_result_blocks(&messages[1]);
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].2, Some(true));
        assert_tool_call_pairing(&messages);
    }

    #[test]
    fn test_repair_orphaned_tool_calls_merges_into_existing_result_message() {
        // Partial results were already recorded for call_1 when the turn was
        // cancelled; call_2's result must join the same user message.
        let mut messages = vec![
            assistant_tool_use_message(&[("call_1", "read"), ("call_2", "bash")]),
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: "file contents".to_string(),
                    is_error: Some(false),
                }]),
            },
        ];
        let mut pending = HashMap::new();

        repair_orphaned_tool_calls(&mut messages, &mut pending);

        assert_eq!(messages.len(), 2);
        let results = tool_result_blocks(&messages[1]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "call_1");
        assert_eq!(results[0].1, "file contents");
        assert_eq!(results[1].0, "call_2");
        assert_eq!(results[1].1, "Tool execution cancelled by user.");
        assert_tool_call_pairing(&messages);
    }

    #[test]
    fn test_repair_orphaned_tool_calls_noop_on_paired_history() {
        let mut messages = vec![
            assistant_tool_use_message(&[("call_1", "read")]),
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: "ok".to_string(),
                    is_error: Some(false),
                }]),
            },
            Message {
                role: Role::Assistant,
                content: MessageContent::Text("done".to_string()),
            },
        ];
        let original = messages.clone();
        let mut pending = HashMap::new();

        repair_orphaned_tool_calls(&mut messages, &mut pending);

        assert_eq!(messages.len(), original.len());
        assert_tool_call_pairing(&messages);
    }
}

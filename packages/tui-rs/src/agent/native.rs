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

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::message_queue::{MessageQueue, PendingMessage, PromptKind, MAX_PENDING_MESSAGES};
use super::protocol::InlineToolApprovalContext;
use super::safety::{SafetyController, SafetyVerdict};
use super::{
    ensure_untrusted_content_policy, CredentialVault, DenialReason, ExecutionPhase,
    ExecutionSource, FromAgent, TokenUsage, ToolExecution, ToolResult,
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
use crate::tools::{ToolExecutor, ToolRegistry};

mod read_only_tools;

/// Payload of the tool-response channel: `(call_id, approved, result,
/// source)`. `source` records the provenance of a caller-supplied `result`:
/// [`ExecutionSource::Native`] when the caller executed the tool locally on
/// this process's behalf (the interactive TUI) and
/// [`ExecutionSource::RemoteClient`] when a remote/headless client executed
/// it. Preserving that provenance is what lets
/// `ToolExecution::model_content` wrap client-authored results in the
/// untrusted-content envelope without wrapping locally executed ones.
/// Ignored when `result` is `None` (a bare approval/denial).
pub type ToolResponseMessage = (String, bool, Option<ToolResult>, ExecutionSource);

use self::read_only_tools::{
    execute_native_read_only_tool_wave, is_explicit_inline_read_only_tool,
    is_native_parallel_read_only_tool_call, QueuedReadOnlyToolExecution,
};

fn provider_id(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Anthropic => "anthropic",
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

    /// Change the active model
    ///
    /// Switches to a different AI model (e.g., from Claude to GPT-5).
    /// The conversation history is preserved.
    SetModel { model: String },

    /// Update thinking configuration
    ///
    /// Enables or disables the extended thinking mode and sets the token budget.
    SetThinking { enabled: bool, budget: u32 },

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

    /// Clear conversation history
    ///
    /// Removes all messages from the conversation, starting fresh. Does not
    /// affect configuration (model, thinking, etc.).
    ClearHistory,

    /// Replace conversation history (used by /rewind and /fork rebuilds).
    ReplaceHistory { messages: Vec<Message> },

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
        )
    }

    fn new_with_tools_and_credential_vault_filtered(
        config: NativeAgentConfig,
        external_tool_definitions: Vec<ToolDefinition>,
        credential_vault: CredentialVault,
        allowed_tools: Option<&HashSet<String>>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let policy_id = policy_model_id(&config.model);
        if let Some(reason) = check_model_allowed(&policy_id) {
            return Err(anyhow::anyhow!(reason));
        }

        let client = UnifiedClient::from_model(&config.model)?;
        let provider = client.provider();

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

        // Create tool executor. This is the executor that actually runs
        // every auto-approved call (Yolo mode entirely, plus Selective
        // mode's allowlisted calls) -- see the doc comment on
        // `NativeAgentConfig::sandbox_policy`. It must receive the same
        // policy a caller resolved for its own approval-gated executor, or
        // the sandbox default silently does nothing for the common case.
        let tool_executor = build_runner_tool_executor(
            &config.cwd,
            credential_vault.clone(),
            config.sandbox_policy.clone(),
        );

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
            config: config.clone(),
            messages: Vec::new(),
            tools,
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
            prompt_context: None,
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
            provider_name: format!("{provider:?}"),
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
    /// AI client
    ///
    /// Handles communication with AI providers (Anthropic, `OpenAI`, etc.).
    /// Can be swapped at runtime via `SetModel` commands.
    client: UnifiedClient,

    /// Configuration
    ///
    /// Current agent settings. Updated via commands like `SetModel`,
    /// `SetThinking`, and `SetSystemPrompt`.
    config: NativeAgentConfig,

    /// Conversation history
    ///
    /// Stores all messages (user prompts, assistant responses, tool results)
    /// in the current conversation. Cleared via `ClearHistory` command.
    messages: Vec<Message>,

    /// Tool definitions
    ///
    /// Map of tool name to tool definition. Loaded from the tool registry
    /// at startup and remains constant.
    tools: HashMap<String, ToolDefinition>,

    /// Tools whose execution is owned by the calling client.
    external_tools: HashSet<String>,

    /// Tool executor for running tools
    ///
    /// Handles actual tool execution (bash, read, write, etc.) and determines
    /// which tools require approval based on command content.
    tool_executor: ToolExecutor,

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
    pending_tool_approvals: HashMap<String, (bool, Option<ToolResult>, ExecutionSource)>,

    /// Extra system prompt context for the current request
    ///
    /// Set by prompt-related hooks and cleared after each request completes.
    prompt_context: Option<String>,
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

impl NativeAgentRunner {
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
                    self.pending_tool_approvals.clear();
                    cancelled = true;
                }
                AgentCommand::CancelQueued { id } => {
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
        while let Ok((id, approved, result, source)) = self.tool_response_rx.try_recv() {
            self.pending_tool_approvals
                .insert(id, (approved, result, source));
        }
        repair_orphaned_tool_calls(&mut self.messages, &mut self.pending_tool_approvals);
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
                self.messages.push(message);
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

                    self.messages.push(Message {
                        role: Role::User,
                        content,
                    });

                    // Reset retry policy for new request
                    self.retry_policy.reset();

                    // Run the agent loop with cancellation and retry support
                    let shutdown_token = self.shutdown_token.clone();
                    let active_cancellation = Arc::clone(&self.active_cancellation);
                    let mut request_cancelled = false;
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
                                let msg = e.to_string();
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
                                        let _ = self.event_tx.send(FromAgent::Error {
                                            message: format!("Agent error: {msg} ({reason})"),
                                            fatal: false,
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if request_cancelled {
                        // The cancellation token is tripped synchronously, before the
                        // queued Cancel command is observed. Drain the command channel
                        // while this request still owns it so any prompts that preceded
                        // Cancel are stashed instead of being started as a new request
                        // ahead of that cancellation.
                        let _ = self.drain_pending_commands();
                    }

                    self.busy = false;
                    self.set_active_request_cancel_token(None);
                    self.prompt_context = None;

                    // Signal that we're done (TUI can clear busy state)
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "done".to_string(),
                        usage: None,
                    });
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
                    self.pending_tool_approvals.clear();
                }
                AgentCommand::CancelQueued { id } => {
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

                    match UnifiedClient::from_model(&model) {
                        Ok(client) => {
                            let provider = format!("{:?}", client.provider());
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
                }
                AgentCommand::ClearHistory => {
                    self.messages.clear();
                    self.pending_messages.clear();
                    self.safety.reset(); // Reset doom loop / rate limit state
                    self.credential_vault.clear();
                }
                AgentCommand::ReplaceHistory { messages } => {
                    self.messages = messages;
                    self.pending_messages.clear();
                    self.safety.reset();
                    // Replacing history is used for session restore. References
                    // from the previous active session must not cross that boundary.
                    self.credential_vault.clear();
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

                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "continue".to_string(),
                        usage: None,
                    });
                }
            }
        }
        self.tool_executor.shutdown_background_processes().await;
    }

    /// Build request configuration
    fn build_config(&self) -> RequestConfig {
        let tools: Vec<Tool> = self.tools.values().map(|d| d.tool.clone()).collect();

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

        RequestConfig {
            model: provider_model_name(&self.config.model),
            max_tokens: self.config.max_tokens,
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system,
            tools,
            thinking,
            // Enable prompt caching for Anthropic models
            cache_system_prompt: self.client.provider() == AiProvider::Anthropic,
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
        let result = await_side_question_or_shutdown(&self.shutdown_token, async {
            let mut messages = self.messages.clone();
            messages.push(Message {
                role: Role::User,
                content: MessageContent::text(question.clone()),
            });
            let mut config = self.build_config();
            config.tools.clear();
            let mut rx = self.client.stream(&messages, &config).await?;

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

    /// Run the agent loop until complete or interrupted
    async fn run_loop(&mut self) -> Result<()> {
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
            let mut rx = self.client.stream(&self.messages, &config).await?;

            // Collect the response
            let mut assistant_content: Vec<ContentBlock> = Vec::new();
            let mut current_text = String::new();
            let mut current_thinking = String::new();
            // Track active tool plus any pre-start deltas (index, id, name, json)
            let mut current_tool: Option<(usize, String, String, String)> = None;
            let mut pending_tool_inputs: std::collections::HashMap<usize, String> =
                std::collections::HashMap::new();
            let mut usage = TokenUsage::default();
            let mut pending_tool_calls: Vec<(String, String, serde_json::Value, Option<String>)> =
                Vec::new();

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
                                self.messages = result.messages;
                            }
                            // Hooks can also handle overflow
                            if self.hooks.handle_overflow() {
                                eprintln!("[agent] Hooks handling overflow");
                            }
                        }
                        break;
                    }
                    StreamEvent::Error { message } => {
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
                self.messages.push(Message {
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

            // Signal response end
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: Some(usage),
            });

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
                    if processed_any_tool {
                        if self.drain_pending_commands() {
                            if !tool_results.is_empty() {
                                self.messages.push(Message {
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
                    if !self.tools.contains_key(&tool_name.to_lowercase()) {
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
                    let resolved_args = self.credential_vault.resolve_in_json(&safe_args);

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

                    let tool_key = tool_name.to_lowercase();
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
                        let resolved_args = self.credential_vault.resolve_in_json(&safe_args);
                        self.execute_tool(&tool_name, &resolved_args, &call_id, None)
                            .await
                    };
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
                    invalidate_cache_after_serial_tool(&self.tool_executor, true);
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
                            let result_block =
                                self.finalize_tool_call_result(call, approved, result).await;
                            tool_results.push(result_block);
                            invalidate_cache_after_serial_tool(&self.tool_executor, approved);
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
                                let resolved_args =
                                    self.credential_vault.resolve_in_json(&call.safe_args);
                                let result = self
                                    .execute_tool(
                                        &call.tool_name,
                                        &resolved_args,
                                        &call.call_id,
                                        None,
                                    )
                                    .await;
                                let result_block = self
                                    .finalize_tool_call_result(call, true, Some(result))
                                    .await;
                                tool_results.push(result_block);
                                invalidate_cache_after_serial_tool(&self.tool_executor, true);
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
                        );
                        break;
                    }
                }

                if deferred_steering.is_empty() {
                    if self.drain_pending_commands() {
                        if !tool_results.is_empty() {
                            self.messages.push(Message {
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
                self.messages.push(Message {
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
                    self.messages = result.messages;
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

    /// Execute a tool using the `ToolExecutor`
    async fn execute_tool(
        &mut self,
        tool_name: &str,
        args: &serde_json::Value,
        call_id: &str,
        approved_inline_env: Option<&HashMap<String, String>>,
    ) -> ToolExecution {
        let cancel = self.shutdown_token.child_token();
        let terminal_drain_required =
            native_tool_requires_terminal_drain(&self.tool_executor, tool_name, args);
        self.set_active_tool_cancel_token(Some(cancel.clone()), terminal_drain_required);
        let execution = self
            .tool_executor
            .execute_with_receipt_cancellable_inline_env(
                tool_name,
                args,
                Some(&self.event_tx),
                call_id,
                cancel,
                approved_inline_env,
            )
            .await;
        self.set_active_tool_cancel_token(None, false);
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
            let resolved_args = self.credential_vault.resolve_in_json(&safe_args);
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

        if approved {
            // Execute hooks only for tools that were allowed to run.
            // Hooks contract on raw tool output, not the model-facing
            // envelope (see `ToolExecution::raw_content`).
            let _post_result = self.hooks.execute_post_tool_use(
                &tool_name,
                &call_id,
                &args,
                &result.raw_content(),
                is_error,
            );
        }

        // Append injected context if any
        let mut result_content = if let Some(ref ctx) = extra_context {
            format!("{content}\n\n{ctx}")
        } else {
            content
        };

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
            is_error: Some(is_error),
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
        let mut results_by_call_id = execute_native_read_only_tool_wave(
            &self.config.cwd,
            self.credential_vault.clone(),
            &self.event_tx,
            &pending_calls,
            Some(cancel_token),
        )
        .await;
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
            let _post_result = self.hooks.execute_post_tool_use(
                &call.tool_name,
                &call.call_id,
                &call.args,
                &result.raw_content(),
                is_error,
            );

            let mut final_content = if let Some(ref ctx) = call.extra_context {
                format!("{content}\n\n{ctx}")
            } else {
                content
            };

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
                is_error: Some(is_error),
            });
        }

        Ok(())
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
) -> ToolExecutor {
    let executor = ToolExecutor::with_credential_vault(cwd, credential_vault);
    match sandbox_policy {
        Some(policy) => executor.with_sandbox_policy(policy),
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

fn rerun_deferred_pre_tool_use(
    hooks: &mut IntegratedHookSystem,
    call: &ToolCallContext,
) -> Result<(serde_json::Value, Option<String>), String> {
    match hooks.execute_pre_tool_use(&call.tool_name, &call.call_id, &call.pre_hook_args) {
        HookResult::Block { reason } => Err(reason),
        HookResult::ModifyInput { new_input } => Ok((new_input, None)),
        HookResult::InjectContext { context } => Ok((call.pre_hook_args.clone(), Some(context))),
        HookResult::Continue => Ok((call.pre_hook_args.clone(), None)),
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

fn invalidate_cache_after_serial_tool(tool_executor: &ToolExecutor, executed: bool) {
    if executed {
        tool_executor.clear_cache();
    }
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
    pending: &mut HashMap<String, (bool, Option<ToolResult>, ExecutionSource)>,
) {
    pending.retain(|call_id, _| !cancelled_ids.contains(call_id));
    while let Ok((call_id, approved, result, source)) = rx.try_recv() {
        if !cancelled_ids.contains(&call_id) {
            pending.insert(call_id, (approved, result, source));
        }
    }
}

enum ToolResponseWait {
    Response((bool, Option<ToolResult>, ExecutionSource)),
    Cancelled,
    Closed,
}

async fn wait_for_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, (bool, Option<ToolResult>, ExecutionSource)>,
    cancel: &CancellationToken,
) -> ToolResponseWait {
    if cancel.is_cancelled() {
        return ToolResponseWait::Cancelled;
    }
    if let Some(result) = pending.remove(call_id) {
        return ToolResponseWait::Response(result);
    }

    loop {
        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return ToolResponseWait::Cancelled,
            response = rx.recv() => response,
        };
        let Some((id, approved, result, source)) = response else {
            return ToolResponseWait::Closed;
        };
        if id == call_id {
            return ToolResponseWait::Response((approved, result, source));
        }
        pending.insert(id, (approved, result, source));
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
    pending_tool_approvals: &mut HashMap<String, (bool, Option<ToolResult>, ExecutionSource)>,
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
                let (content, is_error) = match pending_tool_approvals.remove(&id) {
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
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

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
        let command = format!(
            "printf '%s\n' \"$$\" > '{}'; \
             (sleep 0.4; printf leaked > '{}') & child=$!; \
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
        );
        assert!(
            sandboxed.requires_sandbox_bypass_approval("bash", &bypass_args),
            "a configured sandbox_policy must reach the runner's own executor"
        );

        let unsandboxed = build_runner_tool_executor(".", credential_vault, None);
        assert!(
            !unsandboxed.requires_sandbox_bypass_approval("bash", &bypass_args),
            "no sandbox_policy configured must produce no sandbox awareness"
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
            tools,
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

    #[tokio::test]
    async fn test_wait_for_tool_response_buffers_out_of_order() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let cancel = CancellationToken::new();

        tx.send(("id-2".to_string(), true, None, ExecutionSource::Native))
            .unwrap();
        tx.send((
            "id-1".to_string(),
            false,
            None,
            ExecutionSource::RemoteClient,
        ))
        .unwrap();

        let result = wait_for_tool_response("id-1", &mut rx, &mut pending, &cancel).await;
        assert!(matches!(
            result,
            ToolResponseWait::Response((false, None, ExecutionSource::RemoteClient))
        ));
        assert!(pending.contains_key("id-2"));

        let result = wait_for_tool_response("id-2", &mut rx, &mut pending, &cancel).await;
        assert!(matches!(
            result,
            ToolResponseWait::Response((true, None, ExecutionSource::Native))
        ));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn approval_wait_honors_cancellation_before_buffered_decisions() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut pending =
            HashMap::from([("id-1".to_string(), (true, None, ExecutionSource::Native))]);
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = wait_for_tool_response("id-1", &mut rx, &mut pending, &cancel).await;

        assert!(matches!(result, ToolResponseWait::Cancelled));
        assert!(pending.contains_key("id-1"));
    }

    #[tokio::test]
    async fn shutdown_preempts_pending_tool_response_wait() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut pending = HashMap::new();
        let shutdown_token = CancellationToken::new();
        let cancel = shutdown_token.child_token();

        let waiting = tokio::spawn(async move {
            let result = wait_for_tool_response("id-1", &mut rx, &mut pending, &cancel).await;
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
        ))
        .expect("queue cancelled approval");
        tx.send((
            "call-unrelated".to_string(),
            false,
            None,
            ExecutionSource::Native,
        ))
        .expect("queue unrelated approval");
        let mut pending = HashMap::from([
            (
                "call-cancelled-buffered".to_string(),
                (true, None, ExecutionSource::Native),
            ),
            (
                "call-existing".to_string(),
                (false, None, ExecutionSource::Native),
            ),
        ]);

        discard_cancelled_tool_responses(&cancelled_ids, &mut rx, &mut pending);

        assert!(!pending.contains_key("call-cancelled-buffered"));
        assert!(!pending.contains_key("call-cancelled-queued"));
        assert_eq!(
            pending
                .get("call-existing")
                .map(|(approved, _, _)| *approved),
            Some(false)
        );
        assert_eq!(
            pending
                .get("call-unrelated")
                .map(|(approved, _, _)| *approved),
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

        invalidate_cache_after_serial_tool(&executor, true);

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
        pending.insert("call_1".to_string(), (false, None, ExecutionSource::Native));

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

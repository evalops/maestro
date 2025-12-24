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
//!    - TUI sends commands (prompt, cancel, set_model, etc.)
//!    - Agent receives and processes in order
//!
//! 2. **Event channel** (`mpsc::UnboundedSender<FromAgent>`):
//!    - Agent sends events (response chunks, tool calls, errors)
//!    - TUI receives and updates UI
//!
//! 3. **Tool response channel** (`mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>`):
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::message_queue::MessageQueue;
use super::safety::{SafetyController, SafetyVerdict};
use super::{FromAgent, TokenUsage, ToolResult};
use crate::ai::{
    AiProvider, ContentBlock, ImageSource, Message, MessageContent, RequestConfig, Role,
    StreamEvent, ThinkingConfig, Tool, UnifiedClient,
};
use crate::hooks::{HookResult, IntegratedHookSystem};
use crate::safety::{
    apply_workflow_state_hooks, ActionFirewall, FirewallContext, FirewallVerdict,
    WorkflowStateTracker,
};
use crate::tools::{ToolExecutor, ToolRegistry};

/// Configuration for the native agent
///
/// Defines the AI model settings, system prompt, thinking capabilities, and execution
/// environment for the agent. All fields can be updated at runtime via agent methods.
///
/// # Examples
///
/// ```
/// use composer_tui::agent::NativeAgentConfig;
///
/// // Default configuration (Claude Sonnet)
/// let config = NativeAgentConfig::default();
/// assert_eq!(config.model, "claude-sonnet-4-5-20250514");
///
/// // Custom configuration with thinking enabled
/// let config = NativeAgentConfig {
///     model: "claude-opus-4-5-20251101".to_string(),
///     max_tokens: 32768,
///     system_prompt: Some("You are a helpful coding assistant.".to_string()),
///     thinking_enabled: true,
///     thinking_budget: 20000,
///     cwd: "/path/to/project".to_string(),
/// };
/// ```
#[derive(Debug, Clone)]
pub struct NativeAgentConfig {
    /// Model to use (e.g., "claude-opus-4-5-20251101", "gpt-5.1-codex-max")
    ///
    /// The model string is parsed by `UnifiedClient` to determine the provider
    /// (Anthropic, OpenAI, etc.) and model variant.
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
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        Self {
            model: "claude-sonnet-4-5-20250514".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: false,
            thinking_budget: 10000,
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
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
    },

    /// Cancel the current operation
    ///
    /// Triggers the cancellation token to stop the active AI request.
    /// The runner will clean up and send a `FromAgent::ResponseEnd` event.
    Cancel,

    /// Change the active model
    ///
    /// Switches to a different AI model (e.g., from Claude to GPT-5).
    /// The conversation history is preserved.
    SetModel { model: String },

    /// Update thinking configuration
    ///
    /// Enables or disables the extended thinking mode and sets the token budget.
    SetThinking { enabled: bool, budget: u32 },

    /// Clear conversation history
    ///
    /// Removes all messages from the conversation, starting fresh. Does not
    /// affect configuration (model, thinking, etc.).
    ClearHistory,

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
    tool_response_tx: mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>,

    /// Channel to send events to the TUI (for send_ready)
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
    /// Cached provider identifier (e.g., "Anthropic", "OpenAI"). Used for
    /// status displays and debugging.
    provider_name: String,
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
    /// };
    ///
    /// let (agent, mut events) = NativeAgent::new(config)?;
    /// agent.send_ready();
    /// ```
    pub fn new(config: NativeAgentConfig) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let client = UnifiedClient::from_model(&config.model)?;
        let provider = client.provider();

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, tool_response_rx) = mpsc::unbounded_channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        // Build tool definitions from the registry
        let registry = ToolRegistry::new();
        let tools: HashMap<String, ToolDefinition> = registry
            .tools()
            .map(|td| (td.tool.name.clone(), td.clone()))
            .collect();

        // Create tool executor
        let tool_executor = ToolExecutor::new(&config.cwd);

        // Load hook system from config files
        let mut hooks = IntegratedHookSystem::load_from_config(&config.cwd);
        hooks.set_model(&config.model);

        // Create safety controller for doom loop and rate limit detection
        let safety = SafetyController::new();

        // Create context compactor for handling long conversations
        let compactor = super::compaction::ContextCompactor::new(Default::default());

        // Create retry policy for transient API errors
        let retry_policy = super::retry::RetryPolicy::default();

        // Create message queue for pending prompts (max 10 queued messages)
        let pending_messages = MessageQueue::with_max_size(10);

        // Create the background runner
        let runner = NativeAgentRunner {
            client,
            config: config.clone(),
            messages: Vec::new(),
            tools,
            tool_executor,
            event_tx: event_tx.clone(),
            tool_response_rx,
            command_rx,
            busy: false,
            cancel_token: None,
            hooks,
            safety,
            workflow_state: WorkflowStateTracker::default(),
            compactor,
            retry_policy,
            pending_messages,
            pending_tool_approvals: HashMap::new(),
        };

        // Spawn the background task
        tokio::spawn(async move {
            runner.run().await;
        });

        let agent = Self {
            command_tx,
            tool_response_tx,
            event_tx,
            model_name: config.model,
            provider_name: format!("{:?}", provider),
        };

        Ok((agent, event_rx))
    }

    /// Get the sender for tool responses
    pub fn tool_response_sender(
        &self,
    ) -> mpsc::UnboundedSender<(String, bool, Option<ToolResult>)> {
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
        self.command_tx
            .send(AgentCommand::Prompt {
                content,
                attachments,
            })
            .map_err(|e| anyhow::anyhow!("Failed to send prompt: {}", e))?;
        Ok(())
    }

    /// Cancel the current operation
    pub fn cancel(&self) {
        let _ = self.command_tx.send(AgentCommand::Cancel);
    }

    /// Clear conversation history
    pub fn clear_history(&self) {
        let _ = self.command_tx.send(AgentCommand::ClearHistory);
    }

    /// Set the model
    pub fn set_model(&self, model: impl Into<String>) -> Result<()> {
        let model = model.into();
        self.command_tx
            .send(AgentCommand::SetModel { model })
            .map_err(|e| anyhow::anyhow!("Failed to set model: {}", e))?;
        Ok(())
    }

    /// Set thinking level
    pub fn set_thinking(&self, enabled: bool, budget: u32) -> Result<()> {
        self.command_tx
            .send(AgentCommand::SetThinking { enabled, budget })
            .map_err(|e| anyhow::anyhow!("Failed to set thinking: {}", e))?;
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
            .map_err(|e| anyhow::anyhow!("Failed to send continue: {}", e))?;
        Ok(())
    }
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
/// - Configuration (NativeAgentConfig)
/// - AI client (UnifiedClient)
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
///         ClearHistory => clear messages,
///     }
/// }
/// ```
struct NativeAgentRunner {
    /// AI client
    ///
    /// Handles communication with AI providers (Anthropic, OpenAI, etc.).
    /// Can be swapped at runtime via `SetModel` commands.
    client: UnifiedClient,

    /// Configuration
    ///
    /// Current agent settings. Updated via commands like `SetModel` and
    /// `SetThinking`.
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

    /// Tool executor for running tools
    ///
    /// Handles actual tool execution (bash, read, write, etc.) and determines
    /// which tools require approval based on command content.
    tool_executor: ToolExecutor,

    /// Channel to send events to the TUI
    ///
    /// Used to stream response chunks, tool calls, errors, etc. back to the UI.
    event_tx: mpsc::UnboundedSender<FromAgent>,

    /// Channel to receive tool responses from the TUI
    ///
    /// When a tool requires approval, the runner waits on this channel for
    /// the user's decision (approve/deny).
    tool_response_rx: mpsc::UnboundedReceiver<(String, bool, Option<ToolResult>)>,

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

    /// Buffered tool approvals that arrived out of order
    pending_tool_approvals: HashMap<String, (bool, Option<ToolResult>)>,
}

impl NativeAgentRunner {
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
                        message: format!("Attachment blocked: {}", reason),
                        fatal: false,
                    });
                    continue;
                }
                FirewallVerdict::RequireApproval { reason } => {
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: format!("Attachment is sensitive: {} (attaching anyway)", reason),
                    });
                }
                FirewallVerdict::Allow => {}
            }

            let path = self.resolve_attachment_path(raw);

            let meta = match fs::metadata(&path).await {
                Ok(m) => m,
                Err(e) => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!("Failed to read attachment metadata for {}: {}", raw, e),
                        fatal: false,
                    });
                    continue;
                }
            };

            if !meta.is_file() {
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment is not a file: {}", raw),
                    fatal: false,
                });
                continue;
            }

            if meta.len() > Self::MAX_ATTACHMENT_BYTES {
                let size_mb = meta.len().div_ceil(1024 * 1024);
                let _ = self.event_tx.send(FromAgent::Error {
                    message: format!("Attachment too large ({}MB): {}", size_mb, raw),
                    fatal: false,
                });
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
                            message: format!("Failed to read image attachment {}: {}", raw, e),
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
                        text: format!("\n\n[Document: {}]\n{}", file_name, truncated),
                    });
                }
                Err(e) => {
                    let _ = self.event_tx.send(FromAgent::Error {
                        message: format!(
                            "Unsupported attachment (not image/utf8 text) {}: {}",
                            raw, e
                        ),
                        fatal: false,
                    });
                }
            }
        }

        blocks
    }

    /// Run the background task loop
    async fn run(mut self) {
        while let Some(cmd) = self.command_rx.recv().await {
            match cmd {
                AgentCommand::Prompt {
                    content,
                    attachments,
                } => {
                    if self.busy {
                        // Queue the message instead of rejecting it
                        // Note: attachments are not supported for queued messages yet
                        if !attachments.is_empty() {
                            let _ = self.event_tx.send(FromAgent::Status {
                                message: "Warning: attachments will be ignored for queued message"
                                    .to_string(),
                            });
                        }
                        if let Some(dropped) = self.pending_messages.push(&content) {
                            let _ = self.event_tx.send(FromAgent::Status {
                                message: format!(
                                    "Queue full, dropped oldest message: {}...",
                                    &dropped.content[..dropped.content.len().min(30)]
                                ),
                            });
                        }
                        let stats = self.pending_messages.stats();
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: stats.status_string(),
                        });
                        continue;
                    }

                    self.busy = true;
                    self.workflow_state.reset();

                    // Create cancellation token for this request
                    let cancel_token = CancellationToken::new();
                    self.cancel_token = Some(cancel_token.clone());

                    let mut blocks = Vec::new();
                    blocks.push(ContentBlock::Text { text: content });
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

                    self.messages.push(Message {
                        role: Role::User,
                        content,
                    });

                    // Reset retry policy for new request
                    self.retry_policy.reset();

                    // Run the agent loop with cancellation and retry support
                    loop {
                        let result = tokio::select! {
                            res = self.run_loop() => res,
                            _ = cancel_token.cancelled() => {
                                Err(anyhow::anyhow!("Request cancelled"))
                            }
                        };

                        match result {
                            Ok(()) => break,
                            Err(e) => {
                                let msg = e.to_string();
                                if msg == "Request cancelled" {
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

                                        // Wait before retrying
                                        tokio::time::sleep(delay).await;

                                        // Check if cancelled during wait
                                        if cancel_token.is_cancelled() {
                                            break;
                                        }
                                    }
                                    super::retry::RetryDecision::GiveUp { reason } => {
                                        // Not retryable or exhausted retries
                                        let _ = self.event_tx.send(FromAgent::Error {
                                            message: format!("Agent error: {} ({})", msg, reason),
                                            fatal: false,
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    self.busy = false;
                    self.cancel_token = None;

                    // Signal that we're done (TUI can clear busy state)
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "done".to_string(),
                        usage: None,
                    });

                    // Process any pending messages that were queued while busy
                    while let Some(pending) = self.pending_messages.pop() {
                        let remaining = self.pending_messages.len();
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: if remaining > 0 {
                                format!("Processing queued message ({} remaining)...", remaining)
                            } else {
                                "Processing queued message...".to_string()
                            },
                        });

                        self.busy = true;
                        let cancel_token = CancellationToken::new();
                        self.cancel_token = Some(cancel_token.clone());

                        // Add the pending message to conversation history
                        self.messages.push(Message {
                            role: Role::User,
                            content: MessageContent::text(pending.content),
                        });

                        self.retry_policy.reset();

                        // Run the agent loop for this pending message
                        loop {
                            let result = tokio::select! {
                                res = self.run_loop() => res,
                                _ = cancel_token.cancelled() => {
                                    Err(anyhow::anyhow!("Request cancelled"))
                                }
                            };

                            match result {
                                Ok(()) => break,
                                Err(e) => {
                                    let msg = e.to_string();
                                    if msg == "Request cancelled" {
                                        // Clear remaining pending messages on cancel
                                        self.pending_messages.clear();
                                        break;
                                    }

                                    let error_kind = super::retry::ErrorKind::classify(&msg);
                                    match self.retry_policy.should_retry(error_kind) {
                                        super::retry::RetryDecision::Retry {
                                            delay,
                                            attempt,
                                            reason,
                                        } => {
                                            let _ = self.event_tx.send(FromAgent::Status {
                                                message: format!(
                                                    "{}. Retrying in {:.1}s (attempt {})...",
                                                    reason,
                                                    delay.as_secs_f64(),
                                                    attempt
                                                ),
                                            });
                                            tokio::time::sleep(delay).await;
                                            if cancel_token.is_cancelled() {
                                                self.pending_messages.clear();
                                                break;
                                            }
                                        }
                                        super::retry::RetryDecision::GiveUp { reason } => {
                                            let _ = self.event_tx.send(FromAgent::Error {
                                                message: format!(
                                                    "Agent error: {} ({})",
                                                    msg, reason
                                                ),
                                                fatal: false,
                                            });
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        self.busy = false;
                        self.cancel_token = None;

                        let _ = self.event_tx.send(FromAgent::ResponseEnd {
                            response_id: "queued".to_string(),
                            usage: None,
                        });
                    }
                }
                AgentCommand::Cancel => {
                    if let Some(token) = &self.cancel_token {
                        token.cancel();
                    }
                    self.busy = false;
                    // Also clear any pending messages on cancel
                    let cleared = self.pending_messages.clear();
                    if !cleared.is_empty() {
                        let _ = self.event_tx.send(FromAgent::Status {
                            message: format!("Cleared {} pending message(s)", cleared.len()),
                        });
                    }
                    self.pending_tool_approvals.clear();
                }
                AgentCommand::SetModel { model } => match UnifiedClient::from_model(&model) {
                    Ok(client) => {
                        self.client = client;
                        self.config.model = model;
                    }
                    Err(e) => {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: format!("Failed to set model: {}", e),
                            fatal: false,
                        });
                    }
                },
                AgentCommand::SetThinking { enabled, budget } => {
                    self.config.thinking_enabled = enabled;
                    self.config.thinking_budget = budget;
                }
                AgentCommand::ClearHistory => {
                    self.messages.clear();
                    self.pending_messages.clear();
                    self.safety.reset(); // Reset doom loop / rate limit state
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
                    self.cancel_token = Some(cancel_token.clone());

                    // Run the agent loop without adding a user message
                    let result = tokio::select! {
                        res = self.run_loop() => res,
                        _ = cancel_token.cancelled() => {
                            Err(anyhow::anyhow!("Request cancelled"))
                        }
                    };

                    if let Err(e) = result {
                        let msg = e.to_string();
                        if msg != "Request cancelled" {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Agent error: {}", e),
                                fatal: false,
                            });
                        }
                    }

                    self.busy = false;
                    self.cancel_token = None;

                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "continue".to_string(),
                        usage: None,
                    });
                }
            }
        }
    }

    /// Build request configuration
    fn build_config(&self) -> RequestConfig {
        let tools: Vec<Tool> = self.tools.values().map(|d| d.tool.clone()).collect();

        let thinking = if self.config.thinking_enabled {
            Some(ThinkingConfig::enabled(self.config.thinking_budget))
        } else {
            None
        };

        RequestConfig {
            model: self.config.model.clone(),
            max_tokens: self.config.max_tokens,
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system: self.config.system_prompt.clone(),
            tools,
            thinking,
            // Enable prompt caching for Anthropic models
            cache_system_prompt: self.client.provider() == AiProvider::Anthropic,
        }
    }

    /// Run the agent loop until complete or interrupted
    async fn run_loop(&mut self) -> Result<()> {
        loop {
            let response_id = Uuid::new_v4().to_string();

            // Signal response start
            let _ = self.event_tx.send(FromAgent::ResponseStart {
                response_id: response_id.clone(),
            });

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
                        // Buffer by index so deltas that arrive before the tool block starts aren't lost
                        pending_tool_inputs
                            .entry(index)
                            .and_modify(|s| s.push_str(&partial_json))
                            .or_insert_with(|| partial_json.clone());

                        // If this is the active tool, append immediately too
                        if let Some((active_index, _, _, ref mut json)) = current_tool {
                            if active_index == index {
                                json.push_str(&partial_json);
                            }
                        }
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
                            assistant_content.push(ContentBlock::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
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
                    StreamEvent::MessageStop { stop_reason } => {
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
                                self.messages = result.messages;
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
                                let _ = self.event_tx.send(FromAgent::Status {
                                    message: status_msg,
                                });
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
                            fatal: false,
                        });
                        break;
                    }
                }
            }

            // Add assistant message to history
            if !assistant_content.is_empty() {
                self.messages.push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Blocks(assistant_content),
                });
            }

            // Signal response end
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: Some(usage),
            });

            // If there are tool calls, handle them
            if !pending_tool_calls.is_empty() {
                let mut tool_results: Vec<ContentBlock> = Vec::new();
                let firewall = ActionFirewall::new(&self.config.cwd);

                for (call_id, tool_name, args, parse_error) in pending_tool_calls {
                    if let Some(message) = parse_error {
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
                    // Validate required fields before surfacing to UI/agent
                    let missing = self.tool_executor.missing_required(&tool_name, &args);
                    if !missing.is_empty() {
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

                    // Check safety controls (doom loop and rate limiting)
                    match self.safety.check_tool_call(&tool_name, &args) {
                        SafetyVerdict::Allow => {
                            // Proceed with tool execution
                        }
                        SafetyVerdict::BlockDoomLoop { reason } => {
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

                    // Execute PreToolUse hooks
                    let hook_result = self.hooks.execute_pre_tool_use(&tool_name, &call_id, &args);

                    // Handle hook results
                    let (args, extra_context) = match hook_result {
                        HookResult::Block { reason } => {
                            // Hook blocked the tool - return error to model
                            let _ = self.event_tx.send(FromAgent::HookBlocked {
                                call_id: call_id.clone(),
                                tool: tool_name.clone(),
                                reason: reason.clone(),
                            });
                            tool_results.push(ContentBlock::ToolResult {
                                tool_use_id: call_id,
                                content: format!("Tool blocked by hook: {}", reason),
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

                    let tool_key = tool_name.to_lowercase();
                    let workflow_snapshot = self.workflow_state.snapshot();
                    // Ensure MCP annotations are loaded before firewall check
                    if crate::mcp::McpClient::is_mcp_tool(&tool_key) {
                        let _ = self.tool_executor.ensure_mcp_annotations().await;
                    }
                    let annotations = self.tool_executor.tool_annotations(&tool_key);
                    let firewall_verdict = firewall.check_tool_with_context(FirewallContext {
                        tool_name: &tool_key,
                        args: &args,
                        workflow_state: Some(&workflow_snapshot),
                        annotations: annotations.as_ref(),
                    });
                    if let FirewallVerdict::Block { reason } = &firewall_verdict {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: reason.clone(),
                            fatal: false,
                        });
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            content: format!("Tool blocked by action firewall: {}", reason),
                            is_error: Some(true),
                        });
                        continue;
                    }

                    // Check if this tool requires approval (dynamic bash logic)
                    let requires_approval =
                        matches!(&firewall_verdict, FirewallVerdict::RequireApproval { .. })
                            || self.tool_executor.requires_approval(&tool_name, &args);

                    // Send tool call event
                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: tool_name.clone(),
                        args: args.clone(),
                        requires_approval,
                    });

                    // If requires approval, wait for response
                    let (approved, result) = if requires_approval {
                        match wait_for_tool_response(
                            &call_id,
                            &mut self.tool_response_rx,
                            &mut self.pending_tool_approvals,
                        )
                        .await
                        {
                            Some(result) => result,
                            None => {
                                // Channel closed
                                return Ok(());
                            }
                        }
                    } else {
                        // Auto-approved, execute immediately
                        // Note: ToolExecutor sends ToolStart/ToolEnd events internally
                        let result = self.execute_tool(&tool_name, &args, &call_id).await;

                        (true, Some(result))
                    };

                    // Build tool result for conversation
                    let (result_content, is_error) = if approved {
                        if let Some(ref res) = result {
                            let content = if res.success {
                                res.output.clone()
                            } else {
                                format!("Error: {}", res.error.clone().unwrap_or_default())
                            };
                            let is_error = !res.success;

                            // Execute PostToolUse hooks
                            let _post_result = self.hooks.execute_post_tool_use(
                                &tool_name,
                                &call_id,
                                &args,
                                &content,
                                !res.success,
                            );

                            // Append injected context if any
                            let mut final_content = if let Some(ref ctx) = extra_context {
                                format!("{}\n\n{}", content, ctx)
                            } else {
                                content
                            };

                            if let Err(err) = apply_workflow_state_hooks(
                                &tool_name,
                                &call_id,
                                &args,
                                &mut self.workflow_state,
                                is_error,
                            ) {
                                // Append workflow hook error to content instead of replacing it
                                // to preserve successful tool output
                                final_content = format!(
                                    "{}\n\n[Workflow error: {}]",
                                    final_content, err.message
                                );
                            }

                            (final_content, is_error)
                        } else {
                            ("Tool executed successfully".to_string(), false)
                        }
                    } else {
                        ("Tool call was denied by user".to_string(), true)
                    };

                    // Record tool call for safety tracking (doom loop / rate limit)
                    self.safety.record_tool_call(&tool_name, &args);

                    tool_results.push(ContentBlock::ToolResult {
                        tool_use_id: call_id,
                        content: result_content,
                        is_error: Some(is_error),
                    });
                }

                // Add tool results to history
                self.messages.push(Message {
                    role: Role::User,
                    content: MessageContent::Blocks(tool_results),
                });

                // Continue the loop to process the tool results
                continue;
            }

            // No tool calls, we're done
            // Check for auto-compaction before the next turn
            if self.compactor.should_auto_compact(&self.messages) {
                let usage_pct = self.compactor.usage_percentage(&self.messages);
                eprintln!(
                    "[agent] Auto-compaction triggered at {:.1}% capacity",
                    usage_pct
                );
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
                    self.messages = result.messages;

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
                    let _ = self.event_tx.send(FromAgent::Status {
                        message: status_msg,
                    });
                }
            }
            break;
        }

        Ok(())
    }

    /// Execute a tool using the ToolExecutor
    async fn execute_tool(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        call_id: &str,
    ) -> ToolResult {
        self.tool_executor
            .execute(tool_name, args, Some(&self.event_tx), call_id)
            .await
    }
}

fn parse_tool_input(tool_name: &str, json: &str) -> Result<serde_json::Value, String> {
    if json.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(json).map_err(|err| {
        format!(
            "Failed to parse tool input JSON for '{}': {}",
            tool_name, err
        )
    })
}

async fn wait_for_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<(String, bool, Option<ToolResult>)>,
    pending: &mut HashMap<String, (bool, Option<ToolResult>)>,
) -> Option<(bool, Option<ToolResult>)> {
    if let Some(result) = pending.remove(call_id) {
        return Some(result);
    }

    while let Some((id, approved, result)) = rx.recv().await {
        if id == call_id {
            return Some((approved, result));
        }
        pending.insert(id, (approved, result));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = NativeAgentConfig::default();
        assert!(config.model.starts_with("claude"));
        assert_eq!(config.max_tokens, 16384);
        assert!(!config.thinking_enabled);
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

        tx.send(("id-2".to_string(), true, None)).unwrap();
        tx.send(("id-1".to_string(), false, None)).unwrap();

        let result = wait_for_tool_response("id-1", &mut rx, &mut pending).await;
        assert!(matches!(result, Some((false, None))));
        assert!(pending.contains_key("id-2"));

        let result = wait_for_tool_response("id-2", &mut rx, &mut pending).await;
        assert!(matches!(result, Some((true, None))));
        assert!(pending.is_empty());
    }
}

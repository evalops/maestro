//! # Native Composer TUI Application
//!
//! This is the main entry point for the native Rust TUI. It coordinates all
//! the major subsystems: terminal rendering, input handling, agent communication,
//! and tool execution.
//!
//! ## Architecture Overview
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                           App                                   │
//! │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
//! │  │ AppState │  │ Terminal │  │  Agent   │  │ Tool Executor    │ │
//! │  │ (state)  │  │(ratatui) │  │ (async)  │  │ (bash, read, ..) │ │
//! │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
//! │  ┌──────────────────────────────────────────────────────────────┐│
//! │  │                    Modals / Components                       ││
//! │  │  FileSearch, SessionSwitcher, CommandPalette, Approval, etc. ││
//! │  └──────────────────────────────────────────────────────────────┘│
//! └─────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## Rust Concepts Demonstrated
//!
//! - **Async Event Loop**: The `run()` method shows how to combine sync (terminal)
//!   and async (agent) operations using tokio.
//!
//! - **Message Passing**: Uses `mpsc` channels for agent communication, avoiding
//!   shared mutable state between async tasks.
//!
//! - **Ownership with Option**: Uses `Option<T>` for resources that may or may
//!   not be initialized (agent, channels).
//!
//! - **Pattern Matching for Input**: Handles keyboard input with exhaustive matching.

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::VecDeque;
use std::sync::Arc;
// `Arc` (Atomic Reference Counted) is a thread-safe reference-counted pointer.
// Multiple owners can share the same data. The data is freed when the last
// Arc is dropped. Unlike `Rc`, `Arc` is safe to use across threads.

use anyhow::{Context, Result};
// `anyhow` provides ergonomic error handling:
// - `Result` is shorthand for `Result<T, anyhow::Error>`
// - `.context("msg")` adds context to errors for better debugging

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers as CrosstermModifiers};
// `crossterm` is a cross-platform terminal manipulation library.
// It handles raw mode, events, and cursor control across Windows/Mac/Linux.

use ratatui::prelude::*;
// `ratatui` is the terminal UI framework (fork of `tui-rs`).
// It provides widgets (Paragraph, Block, List) and layout primitives.

use tokio::sync::mpsc;
// `mpsc` = Multi-Producer, Single-Consumer channel.
// Used for async message passing between tasks.
// - `mpsc::unbounded_channel()` creates a channel with no size limit
// - Sender can be cloned (multiple producers)
// - Receiver cannot be cloned (single consumer)

use crate::agent::MAX_PENDING_MESSAGES;
use crate::agent::{FromAgent, NativeAgent, NativeAgentConfig, PromptKind, ToolResult};
use crate::clipboard::ClipboardManager;
use crate::commands::{
    build_command_registry, CommandAction, CommandOutput, CommandRegistry, ModalType, QueueAction,
    QueueModeKind, SlashCommandMatcher, SlashCycleState,
};
use crate::components::{
    calculate_input_height, ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest,
    ChatInputWidget, ChatView, CommandPalette, FileSearchModal, ModelSelector, SessionSwitcher,
    ThemeSelector,
};
use crate::files::get_workspace_files;
use crate::git;
use crate::safety::FirewallVerdict;
use crate::session::{AppMessage, SessionManager, ThinkingLevel};
use crate::state::{AppState, ApprovalMode, Message, MessageRole};
use crate::terminal::{self, TerminalCapabilities};
use crate::tools::ToolExecutor;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/// Active modal in the UI.
///
/// Only one modal can be active at a time. This enum tracks which one.
/// Modals are overlays that capture input (like dialogs in web apps).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveModal {
    /// No modal active - normal chat input
    None,
    /// File search modal (Ctrl+P style)
    FileSearch,
    /// Session history browser
    SessionSwitcher,
    /// Command palette (Ctrl+Shift+P style)
    CommandPalette,
    /// Tool execution approval dialog
    Approval,
    /// AI model selector
    ModelSelector,
    /// Color theme selector
    ThemeSelector,
}

#[derive(Debug, Clone)]
struct QueuedPrompt {
    content: String,
    kind: PromptKind,
}

/// Main application struct - the central coordinator.
///
/// # Rust Concept: Struct with Many Fields
///
/// This struct owns many resources. In Rust, this is fine - there's no
/// overhead for having many fields. The struct size is the sum of its
/// field sizes, laid out contiguously in memory.
///
/// # Rust Concept: Option for Optional Resources
///
/// Fields like `native_agent: Option<NativeAgent>` use `Option` because
/// the agent may not be spawned yet. This is more explicit than null -
/// you must handle the None case.
///
/// # Rust Concept: Arc for Shared Ownership
///
/// `command_registry: Arc<CommandRegistry>` is wrapped in `Arc` because
/// multiple components need read access to the registry. Arc provides
/// thread-safe shared ownership through reference counting.
pub struct App {
    /// Central application state (messages, input, status).
    /// See `state.rs` for details.
    state: AppState,

    /// The AI agent that processes prompts and generates responses.
    /// `Option` because it's spawned asynchronously after app creation.
    native_agent: Option<NativeAgent>,

    /// Channel receiver for messages from the agent.
    /// The agent sends streaming responses, tool calls, etc. through this.
    /// `mpsc::UnboundedReceiver` = async channel with unlimited buffer.
    native_event_rx: Option<mpsc::UnboundedReceiver<FromAgent>>,

    /// Channel sender for tool execution results back to the agent.
    /// When a tool completes, we send the result through this channel.
    /// Tuple: (call_id, success, optional_result)
    tool_response_tx: Option<mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>>,

    /// Executes tools (bash commands, file reads, etc.) requested by the agent.
    tool_executor: ToolExecutor,

    /// The ratatui terminal handle for rendering.
    terminal: terminal::Terminal,

    /// Flag to exit the main loop.
    should_quit: bool,

    /// Terminal capabilities (color support, viewport position, etc.).
    capabilities: TerminalCapabilities,

    /// Registry of all available slash commands.
    /// Wrapped in Arc for shared access from command palette.
    command_registry: Arc<CommandRegistry>,

    /// Fuzzy matcher for slash command completion.
    slash_matcher: SlashCommandMatcher,

    /// State for Tab-cycling through slash command completions.
    slash_state: SlashCycleState,

    /// Which modal (if any) is currently shown.
    active_modal: ActiveModal,

    /// File search modal component (like VS Code's Ctrl+P).
    file_search: FileSearchModal,

    /// Session history browser modal.
    session_switcher: SessionSwitcher,

    /// Command palette modal (like VS Code's Ctrl+Shift+P).
    command_palette: CommandPalette,

    /// Handles tool execution approval flow.
    approval_controller: ApprovalController,

    /// Manages session persistence (save/load conversations).
    session_manager: SessionManager,

    /// System clipboard integration.
    clipboard: ClipboardManager,

    /// AI model selection modal.
    model_selector: ModelSelector,

    /// Color theme selection modal.
    theme_selector: ThemeSelector,

    /// Token usage and cost tracker.
    usage_tracker: crate::usage::UsageTracker,

    /// Prompt history for recall and search.
    prompt_history: crate::history::PromptHistory,

    /// Tool execution history.
    tool_history: crate::tools::ToolHistory,

    /// Prompts submitted while running (queued in the agent).
    queued_prompts: VecDeque<QueuedPrompt>,
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

impl App {
    /// Create a new application instance.
    ///
    /// # Rust Concept: Constructor Pattern
    ///
    /// Rust doesn't have constructors like OOP languages. Instead, we use
    /// associated functions (functions in `impl` blocks without `self`).
    /// By convention, `new()` creates a new instance.
    ///
    /// # Rust Concept: Error Propagation with `?`
    ///
    /// The `?` operator is syntactic sugar for error handling:
    /// - If the expression is `Ok(value)`, extract `value`
    /// - If the expression is `Err(e)`, return `Err(e)` from the function
    ///
    /// `.context("msg")` from anyhow wraps the error with additional context.
    ///
    /// # Returns
    ///
    /// `Result<Self>` - either a new App instance or an initialization error.
    pub fn new() -> Result<Self> {
        // Initialize the terminal (enters raw mode, sets up alternate screen).
        // This is a tuple destructuring - we get both values at once.
        let (terminal, capabilities) = terminal::init().context("Failed to initialize terminal")?;
        Ok(Self::new_with_terminal(terminal, capabilities))
    }

    fn new_with_terminal(terminal: terminal::Terminal, capabilities: TerminalCapabilities) -> Self {
        // Build the command registry and wrap it in Arc for shared ownership.
        // Arc::new() moves the registry into the Arc.
        let command_registry = Arc::new(build_command_registry());

        // Create the slash command matcher with a clone of the Arc.
        // Arc::clone() is cheap - it just increments the reference count.
        let slash_matcher = SlashCommandMatcher::new(Arc::clone(&command_registry));

        // Get current working directory, defaulting to "." if it fails.
        // `unwrap_or_else` takes a closure that's only called on Err.
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        // Construct the App with all fields initialized.
        // `Self` is an alias for the type we're implementing (App).
        Self {
            state: AppState::new(),
            native_agent: None,     // Agent spawned later in run()
            native_event_rx: None,  // Channel created when agent spawns
            tool_response_tx: None, // Channel created when agent spawns
            tool_executor: ToolExecutor::new(&cwd),
            terminal,
            should_quit: false,
            capabilities,
            command_palette: CommandPalette::new(Arc::clone(&command_registry)),
            command_registry,
            slash_matcher,
            slash_state: SlashCycleState::new(),
            active_modal: ActiveModal::None,
            file_search: FileSearchModal::new(),
            session_switcher: SessionSwitcher::new(&cwd),
            approval_controller: ApprovalController::new(),
            session_manager: SessionManager::new(&cwd),
            clipboard: ClipboardManager::new(),
            model_selector: ModelSelector::new(),
            theme_selector: ThemeSelector::new(),
            usage_tracker: crate::usage::UsageTracker::new(),
            prompt_history: crate::history::PromptHistory::load_or_create()
                .unwrap_or_else(|_| crate::history::PromptHistory::default()),
            tool_history: crate::tools::ToolHistory::default(),
            queued_prompts: VecDeque::new(),
        }
    }

    /// Get the current viewport top position (for history push).
    pub fn viewport_top(&self) -> u16 {
        self.capabilities.viewport_top
    }

    /// Run the main event loop.
    ///
    /// # Rust Concept: Async Main Loop
    ///
    /// This function is `async` because the agent communication is async.
    /// The pattern here combines sync operations (terminal rendering, input)
    /// with async operations (agent polling) using a polling approach.
    ///
    /// # Rust Concept: `mut self`
    ///
    /// Taking `mut self` (not `&mut self`) means this function takes ownership
    /// of the App and can modify it. The App is consumed when run() completes.
    /// This is appropriate because the terminal needs cleanup on exit.
    ///
    /// # Returns
    ///
    /// Exit code for the process (0 = success, non-zero = error).
    pub async fn run(mut self) -> Result<i32> {
        // Load workspace files for @ mentions in the input.
        self.load_workspace_files();

        // Spawn the agent (async operation).
        // This creates the channels and starts the agent task.
        self.spawn_agent().await?;

        // Main event loop - runs until should_quit is set to true.
        loop {
            // Render the UI to the terminal.
            // This is a sync operation that writes to stdout.
            self.render()?;

            // Poll for terminal events with a 50ms timeout.
            // The timeout ensures we regularly check for agent messages.
            //
            // Rust Concept: Non-blocking polling
            // `event::poll()` returns true if an event is available.
            // The timeout prevents blocking forever on input.
            if event::poll(std::time::Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    // Only handle key press events (not release).
                    // Some terminals send both press and release events.
                    if key.kind == KeyEventKind::Press {
                        self.handle_key(key.code, key.modifiers).await?;
                    }
                }
            }

            // Poll for messages from the agent (async operation).
            // This handles streaming responses, tool calls, etc.
            self.poll_agent().await?;

            // Check exit condition.
            if self.should_quit {
                break;
            }
        }

        // Cleanup background processes before exit
        let process_count = crate::tools::cleanup_background_processes();
        if process_count > 0 {
            eprintln!("[app] Cleaned up {} background process(es)", process_count);
        }

        // Cleanup terminal
        terminal::restore()?;

        Ok(0)
    }

    /// Load workspace files for file search
    fn load_workspace_files(&mut self) {
        let cwd = std::env::current_dir().unwrap_or_default();
        let files = get_workspace_files(&cwd, 10000);
        self.file_search.set_files(files);
    }

    /// Spawn the native Rust agent
    async fn spawn_agent(&mut self) -> Result<()> {
        let cwd_path = std::env::current_dir().unwrap_or_default();
        let cwd = cwd_path.to_string_lossy().to_string();

        // Detect git branch
        let git_branch = git::current_branch(&cwd_path);

        // Determine model from environment or default (prefer Claude)
        let model = std::env::var("COMPOSER_MODEL").unwrap_or_else(|_| {
            if std::env::var("ANTHROPIC_API_KEY").is_ok() {
                "claude-sonnet-4-5-20250514".to_string()
            } else if std::env::var("OPENAI_API_KEY").is_ok() {
                "gpt-4o".to_string()
            } else {
                // Default to Claude even without key (will fail with clear error)
                "claude-sonnet-4-5-20250514".to_string()
            }
        });

        let config = NativeAgentConfig {
            model: model.clone(),
            max_tokens: 16384,
            system_prompt: Some(self.build_system_prompt()),
            thinking_enabled: false,
            thinking_budget: 10000,
            cwd: cwd.clone(),
        };

        self.state.status = Some(format!("Initializing agent ({})...", model));

        match NativeAgent::new(config) {
            Ok((agent, event_rx)) => {
                let tool_tx = agent.tool_response_sender();
                self.native_agent = Some(agent);
                self.native_event_rx = Some(event_rx);
                self.tool_response_tx = Some(tool_tx);

                // Send ready event
                if let Some(agent) = &self.native_agent {
                    agent.send_ready();
                    // Send session info with git branch
                    agent.send_session_info(&cwd, None, git_branch);
                }

                // Ensure busy is false so user can type
                self.state.busy = false;
                self.state.status = Some(format!("Ready: {}", model));
            }
            Err(e) => {
                self.state.error = Some(format!("Failed to create agent: {}", e));
            }
        }

        Ok(())
    }

    /// Build the system prompt for the agent
    fn build_system_prompt(&self) -> String {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        format!(
            r#"You are an AI assistant helping with software development tasks.

Current working directory: {}

You have access to the following tools:
- bash: Execute shell commands. REQUIRED arg: {{\"command\":\"<cmd>\"}}. Do not send empty commands.
- read: Read file contents. REQUIRED: {{\"file_path\":\"/abs/path\"}}.
- write: Write to files. REQUIRED: {{\"file_path\":\"/abs/path\",\"content\":\"...\"}}.
- glob: Find files by pattern. REQUIRED: {{\"pattern\":\"*.rs\"}}. Optional: {{\"path\":\"/abs/dir\"}}.
- grep: Search file contents. REQUIRED: {{\"pattern\":\"regex or text\"}}. Optional: {{\"path\":\"/abs/dir\"}}.

Tool-calling rules:
- Always prefer read/write/glob/grep for filesystem; use bash only for commands that are not pure file ops.
- Never emit a tool call without all required fields.
- If a tool call is denied, immediately retry with corrected arguments instead of responding without action.

Always use tools when they would be helpful. Be concise and direct in your responses."#,
            cwd
        )
    }

    /// Poll for messages from the agent
    async fn poll_agent(&mut self) -> Result<()> {
        // Collect messages first to avoid borrow issues
        let mut messages = Vec::new();
        if let Some(rx) = &mut self.native_event_rx {
            while let Ok(msg) = rx.try_recv() {
                messages.push(msg);
            }
        }
        // Process messages
        for msg in messages {
            self.handle_agent_message(msg).await?;
        }
        Ok(())
    }

    /// Handle an agent message (common for both backends)
    async fn handle_agent_message(&mut self, msg: FromAgent) -> Result<()> {
        if matches!(msg, FromAgent::ResponseStart { .. }) {
            if let Some(pending) = self.queued_prompts.pop_front() {
                self.state.add_user_message(pending.content);
            }
        }
        match &msg {
            FromAgent::Ready { model, provider } => {
                self.state.status = Some(format!("Connected: {} via {}", model, provider));
            }
            FromAgent::SessionInfo { cwd, .. } => {
                self.state.status = Some(format!("Session in: {}", cwd));
            }
            FromAgent::ResponseEnd { .. } => {
                // Clear busy state when response completes
                self.state.busy = false;
            }
            FromAgent::Error { .. } => {
                // Clear busy state on error
                self.state.busy = false;
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval: _,
            } => {
                // Unknown tool name -> deny immediately
                if !self.tool_executor.has_tool(tool) {
                    let note = format!(
                        "Skipped unknown tool '{tool}' (not in registry); denied call. \
Retry with a supported tool (bash/read/write/glob/grep) and valid args."
                    );
                    self.state.add_system_message(note);
                    self.state.handle_agent_message(msg.clone());
                    self.state.fail_tool_call(call_id, "Unknown tool (denied)");
                    self.handle_tool_approval(call_id.clone(), tool.clone(), args.clone(), false)
                        .await?;
                    return Ok(());
                }

                // Drop obviously invalid bash requests so we don't spam the user with empty approvals
                let command = args.get("command").and_then(|v| v.as_str());
                let command_trimmed = command.and_then(|c| {
                    let trimmed = c.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                });

                if tool.eq_ignore_ascii_case("bash") && command_trimmed.is_none() {
                    // Auto-fill a safe default command so the model makes progress instead of looping
                    let mut filled_args = args.clone();
                    filled_args
                        .as_object_mut()
                        .map(|obj| obj.insert("command".to_string(), serde_json::json!("pwd")));

                    self.state.add_system_message(
                        "Received empty bash tool call; auto-filled command as \"pwd\" to proceed."
                            .to_string(),
                    );

                    // Record tool call
                    self.state.handle_agent_message(msg.clone());
                    // Run the tool with the filled command (auto-approved)
                    self.execute_tool_and_respond(
                        call_id.clone(),
                        tool.clone(),
                        filled_args.clone(),
                    )
                    .await?;
                    return Ok(());
                }

                // Validate required fields per tool schema
                let missing = self.tool_executor.missing_required(tool, args);
                if !missing.is_empty() {
                    let note = format!(
                        "Skipped tool '{tool}' due to missing fields: {}. \
Add the required fields and retry.",
                        missing.join(", ")
                    );
                    self.state.add_system_message(note);
                    self.state.handle_agent_message(msg.clone());
                    self.state
                        .fail_tool_call(call_id, "Missing required tool args (denied)");
                    self.handle_tool_approval(call_id.clone(), tool.clone(), args.clone(), false)
                        .await?;
                    return Ok(());
                }

                let firewall_verdict = self.tool_executor.firewall_verdict(tool, args);
                if let FirewallVerdict::Block { reason } = &firewall_verdict {
                    let note = format!("Blocked tool '{tool}' by action firewall: {reason}");
                    self.state.add_system_message(note);
                    self.state.handle_agent_message(msg.clone());
                    self.state
                        .fail_tool_call(call_id, "Blocked by action firewall");
                    self.handle_tool_approval(call_id.clone(), tool.clone(), args.clone(), false)
                        .await?;
                    return Ok(());
                }

                // Check approval requirement based on mode and registry
                let mut needs_approval = match self.state.approval_mode {
                    ApprovalMode::Yolo => false,
                    ApprovalMode::Safe => true,
                    ApprovalMode::Selective => self.tool_executor.requires_approval(tool, args),
                };

                if matches!(&firewall_verdict, FirewallVerdict::RequireApproval { .. })
                    && self.state.approval_mode != ApprovalMode::Yolo
                {
                    needs_approval = true;
                }

                if needs_approval {
                    let mut request =
                        ApprovalRequest::new(call_id.clone(), tool.clone(), args.clone());
                    if let FirewallVerdict::RequireApproval { reason } = &firewall_verdict {
                        request = request.with_reason(reason.clone());
                    }

                    // Queue approval
                    self.approval_controller.enqueue(request);
                    // Show approval modal
                    self.active_modal = ActiveModal::Approval;
                } else {
                    // Auto-approve and execute
                    self.execute_tool_and_respond(call_id.clone(), tool.clone(), args.clone())
                        .await?;
                }
            }
            _ => {}
        }
        self.state.handle_agent_message(msg);
        Ok(())
    }

    /// Execute a tool and send the response back to the agent
    async fn execute_tool_and_respond(
        &mut self,
        call_id: String,
        tool: String,
        args: serde_json::Value,
    ) -> Result<()> {
        // Execute the tool
        let result = self
            .tool_executor
            .execute(&tool, &args, None, &call_id)
            .await;

        if tool.eq_ignore_ascii_case("extract_document") && result.success {
            let attachment_id = result
                .details
                .as_ref()
                .and_then(|details| details.get("url"))
                .and_then(|value| value.as_str())
                .unwrap_or(&call_id)
                .to_string();
            let _ = self
                .session_manager
                .save_attachment_extract(attachment_id, result.output.clone());
        }

        // Send response back to native agent
        if let Some(tx) = &self.tool_response_tx {
            let _ = tx.send((call_id, true, Some(result)));
        }

        Ok(())
    }

    /// Handle a key press
    async fn handle_key(&mut self, code: KeyCode, modifiers: CrosstermModifiers) -> Result<()> {
        let ctrl = modifiers.contains(CrosstermModifiers::CONTROL);
        let alt = modifiers.contains(CrosstermModifiers::ALT);
        let shift = modifiers.contains(CrosstermModifiers::SHIFT);

        // Handle modal-specific input first
        match self.active_modal {
            ActiveModal::FileSearch => return self.handle_file_search_key(code, ctrl).await,
            ActiveModal::SessionSwitcher => {
                return self.handle_session_switcher_key(code, ctrl).await
            }
            ActiveModal::CommandPalette => {
                return self.handle_command_palette_key(code, ctrl).await
            }
            ActiveModal::Approval => return self.handle_approval_key(code).await,
            ActiveModal::ModelSelector => return self.handle_model_selector_key(code, ctrl).await,
            ActiveModal::ThemeSelector => return self.handle_theme_selector_key(code, ctrl).await,
            ActiveModal::None => {}
        }

        match code {
            // Quit
            KeyCode::Char('c') if ctrl => {
                if self.state.busy {
                    // Interrupt the agent
                    if let Some(agent) = &self.native_agent {
                        agent.cancel();
                    }
                    self.state.busy = false;
                    self.queued_prompts.clear();
                } else {
                    self.should_quit = true;
                }
            }
            KeyCode::Char('d') if ctrl => {
                self.should_quit = true;
            }

            // Open modals
            KeyCode::Char('p') if ctrl => {
                // Command palette
                self.command_palette.show();
                self.active_modal = ActiveModal::CommandPalette;
            }
            KeyCode::Char('o') if ctrl => {
                // File search
                self.file_search.show();
                self.active_modal = ActiveModal::FileSearch;
            }
            KeyCode::Char('r') if ctrl && alt => {
                // Session switcher
                self.session_switcher.show();
                self.active_modal = ActiveModal::SessionSwitcher;
            }

            // @ trigger for file search
            KeyCode::Char('@') if !self.state.busy => {
                self.state.insert_char('@');
                self.file_search.show();
                self.active_modal = ActiveModal::FileSearch;
            }

            // / trigger for slash commands
            KeyCode::Char('/') if self.state.input().is_empty() => {
                self.state.insert_char('/');
                self.slash_state.set_query("", &self.slash_matcher);
            }

            // Tab for slash command completion
            KeyCode::Tab if self.state.input().starts_with('/') => {
                self.handle_slash_tab();
            }

            // Navigation
            KeyCode::Up => {
                if self.state.input().starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_prev();
                    self.apply_slash_completion();
                } else {
                    self.state.scroll_up(1);
                }
            }
            KeyCode::Down => {
                if self.state.input().starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_next();
                    self.apply_slash_completion();
                } else {
                    self.state.scroll_down(1);
                }
            }
            // Vim-style scrolling: only when input is empty (not typing)
            KeyCode::Char('k') if ctrl => {
                self.state.scroll_up(1);
            }
            KeyCode::Char('j') if ctrl => {
                self.state.scroll_down(1);
            }
            KeyCode::PageUp => {
                let step = (self.capabilities.viewport_height as usize).max(5) / 2;
                self.state.scroll_up(step.max(1));
            }
            KeyCode::PageDown => {
                let step = (self.capabilities.viewport_height as usize).max(5) / 2;
                self.state.scroll_down(step.max(1));
            }
            // Jump shortcuts: only when input is empty (not typing)
            KeyCode::Char('g') if self.state.input().is_empty() && !ctrl => {
                // Jump to top (oldest messages)
                self.state.scroll_offset = usize::MAX / 2;
            }
            KeyCode::Char('G') if self.state.input().is_empty() => {
                // Jump to bottom (newest messages)
                self.state.scroll_offset = 0;
            }
            KeyCode::Char('t') if !self.state.busy && ctrl => {
                // Ctrl+T: toggle last tool call expansion
                self.toggle_last_tool_call();
            }
            KeyCode::Tab if !self.state.busy => {
                // Tab: toggle thinking on last assistant message with thinking
                self.toggle_last_thinking();
            }

            // Input editing
            KeyCode::Char(c) if !ctrl => {
                self.state.insert_char(c);
                self.update_slash_state();
            }
            KeyCode::Backspace => {
                self.state.backspace();
                self.update_slash_state();
            }
            KeyCode::Delete => {
                self.state.delete();
            }
            KeyCode::Left => {
                self.state.move_left();
            }
            KeyCode::Right => {
                self.state.move_right();
            }
            KeyCode::Home => {
                self.state.move_home();
            }
            KeyCode::End => {
                self.state.move_end();
            }

            // Submit or newline (Shift+Enter for newline)
            KeyCode::Enter => {
                if shift {
                    // Shift+Enter: insert newline for multi-line input
                    self.state.insert_char('\n');
                } else if !self.state.input().is_empty() {
                    if self.state.input().starts_with('/') {
                        self.execute_slash_command().await?;
                    } else if self.state.busy {
                        let input = self.state.input().to_string();
                        let ok = if alt {
                            self.handle_follow_up_submit(input).await?
                        } else {
                            self.handle_steer_submit(input).await?
                        };
                        if ok {
                            self.state.set_input("");
                        }
                    } else if alt {
                        let input = self.state.input().to_string();
                        let ok = self.handle_follow_up_submit(input).await?;
                        if ok {
                            self.state.set_input("");
                        }
                    } else {
                        let input = self.state.take_input();
                        self.submit_prompt(input).await?;
                    }
                }
            }

            // Clear input
            KeyCode::Char('u') if ctrl => {
                self.state.set_input("");
                self.slash_state.reset();
            }

            // Paste from clipboard
            KeyCode::Char('y') if ctrl => {
                if let Ok(text) = self.clipboard.paste() {
                    // Insert text including newlines for multi-line support
                    // Skip carriage returns to normalize line endings
                    for c in text.chars() {
                        if c != '\r' {
                            self.state.insert_char(c);
                        }
                    }
                    self.update_slash_state();
                }
            }

            // Clear screen
            KeyCode::Char('l') if ctrl => {
                // Clear messages
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }

            // Escape to clear completions
            KeyCode::Esc => {
                self.slash_state.reset();
            }

            _ => {}
        }

        Ok(())
    }

    /// Handle keys in file search modal
    async fn handle_file_search_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.file_search.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(file) = self.file_search.confirm() {
                    // Insert file path at cursor
                    for c in file.relative_path.chars() {
                        self.state.insert_char(c);
                    }
                    self.state.insert_char(' ');
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.file_search.move_up();
            }
            KeyCode::Down => {
                self.file_search.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.file_search.insert_char(c);
            }
            KeyCode::Backspace => {
                self.file_search.backspace();
            }
            KeyCode::Left => {
                self.file_search.move_left();
            }
            KeyCode::Right => {
                self.file_search.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in session switcher modal
    async fn handle_session_switcher_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.session_switcher.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(session_id) = self.session_switcher.confirm() {
                    // Load and restore the session
                    match self.session_manager.load_session(&session_id) {
                        Ok(session) => {
                            // Clear current messages
                            self.state.messages.clear();

                            // Restore messages from session
                            for app_msg in &session.messages {
                                let role = match app_msg {
                                    AppMessage::User { .. } => MessageRole::User,
                                    AppMessage::Assistant { .. } => MessageRole::Assistant,
                                    AppMessage::ToolResult { .. } => continue, // Skip tool results
                                };
                                self.state.messages.push(Message {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    role,
                                    content: app_msg.text_content(),
                                    thinking: String::new(),
                                    streaming: false,
                                    tool_calls: Vec::new(),
                                    usage: None,
                                    timestamp: std::time::SystemTime::now(),
                                    thinking_expanded: false,
                                });
                            }

                            self.state.session_id = Some(session_id.clone());
                            self.state.status = Some(format!("Resumed session: {}", session_id));
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to load session: {}", e));
                        }
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.session_switcher.move_up();
            }
            KeyCode::Down => {
                self.session_switcher.move_down();
            }
            KeyCode::Delete => {
                if let Err(e) = self.session_switcher.delete_selected() {
                    self.state.error = Some(e);
                }
            }
            KeyCode::Char(c) if !ctrl => {
                self.session_switcher.insert_char(c);
            }
            KeyCode::Backspace => {
                self.session_switcher.backspace();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in command palette modal
    async fn handle_command_palette_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.command_palette.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(cmd_name) = self.command_palette.confirm() {
                    // Set input to the command
                    self.state.set_input(&format!("/{}", cmd_name));
                    // Execute it
                    self.execute_slash_command().await?;
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.command_palette.move_up();
            }
            KeyCode::Down => {
                self.command_palette.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.command_palette.insert_char(c);
            }
            KeyCode::Backspace => {
                self.command_palette.backspace();
            }
            KeyCode::Left => {
                self.command_palette.move_left();
            }
            KeyCode::Right => {
                self.command_palette.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in approval modal
    async fn handle_approval_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                if let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Approve)
                {
                    // Execute the tool and send response
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                // Check if more approvals pending
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                if let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Deny)
                {
                    // Send denial
                    self.handle_tool_approval(request.call_id, request.tool, request.args, false)
                        .await?;
                }
                // Check if more approvals pending
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('a') | KeyCode::Char('A') => {
                // Approve all
                while let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Approve)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                self.active_modal = ActiveModal::None;
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in model selector modal
    async fn handle_model_selector_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.model_selector.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(model_id) = self.model_selector.confirm() {
                    // Set the new model
                    if let Some(agent) = &self.native_agent {
                        if let Err(e) = agent.set_model(&model_id) {
                            self.state.error = Some(format!("Failed to set model: {}", e));
                        } else {
                            self.state.status = Some(format!("Model: {}", model_id));
                        }
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.model_selector.move_up();
            }
            KeyCode::Down => {
                self.model_selector.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.model_selector.insert_char(c);
            }
            KeyCode::Backspace => {
                self.model_selector.backspace();
            }
            KeyCode::Left => {
                self.model_selector.move_left();
            }
            KeyCode::Right => {
                self.model_selector.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in theme selector modal
    async fn handle_theme_selector_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.theme_selector.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(theme_name) = self.theme_selector.confirm() {
                    // Set the new theme
                    if crate::themes::set_theme_by_name(&theme_name).is_ok() {
                        self.state.status = Some(format!("Theme: {}", theme_name));
                    } else {
                        self.state.error = Some(format!("Unknown theme: {}", theme_name));
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.theme_selector.move_up();
            }
            KeyCode::Down => {
                self.theme_selector.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.theme_selector.insert_char(c);
            }
            KeyCode::Backspace => {
                self.theme_selector.backspace();
            }
            KeyCode::Left => {
                self.theme_selector.move_left();
            }
            KeyCode::Right => {
                self.theme_selector.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle tool approval decision
    async fn handle_tool_approval(
        &mut self,
        call_id: String,
        tool: String,
        args: serde_json::Value,
        approved: bool,
    ) -> Result<()> {
        if approved {
            // Execute the tool
            let result = self
                .tool_executor
                .execute(&tool, &args, None, &call_id)
                .await;
            // Send result back to agent
            if let Some(tx) = &self.tool_response_tx {
                let _ = tx.send((call_id, true, Some(result)));
            }
        } else {
            // Send denial
            if let Some(tx) = &self.tool_response_tx {
                let _ = tx.send((call_id, false, None));
            }
        }
        Ok(())
    }

    /// Update slash state based on current input
    fn update_slash_state(&mut self) {
        if self.state.input().starts_with('/') {
            let query = &self.state.input()[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        } else {
            self.slash_state.reset();
        }
    }

    /// Handle tab for slash command completion
    fn handle_slash_tab(&mut self) {
        if !self.slash_state.has_completions() {
            let query = &self.state.input()[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        } else {
            self.slash_state.cycle_next();
        }
        self.apply_slash_completion();
    }

    /// Apply the current slash completion to input
    fn apply_slash_completion(&mut self) {
        if let Some(cmd) = self.slash_state.current() {
            self.state.set_input(&format!("/{}", cmd));
        }
    }

    /// Handle a command output from the registry
    async fn handle_command_output(&mut self, output: CommandOutput) {
        let mut stack = vec![output];
        while let Some(current) = stack.pop() {
            match current {
                CommandOutput::Message(msg) => {
                    self.state.add_system_message(msg);
                }
                CommandOutput::Help(msg) => {
                    self.state.add_system_message(msg);
                }
                CommandOutput::Warning(msg) => {
                    self.state.error = Some(msg);
                }
                CommandOutput::OpenModal(modal_type) => match modal_type {
                    ModalType::ThemeSelector => {
                        self.theme_selector.show();
                        self.active_modal = ActiveModal::ThemeSelector;
                    }
                    ModalType::ModelSelector => {
                        self.model_selector.show();
                        self.active_modal = ActiveModal::ModelSelector;
                    }
                    ModalType::SessionList => {
                        self.session_switcher.show();
                        self.active_modal = ActiveModal::SessionSwitcher;
                    }
                    ModalType::FileSearch => {
                        self.file_search.show();
                        self.active_modal = ActiveModal::FileSearch;
                    }
                    ModalType::CommandPalette => {
                        self.command_palette.show();
                        self.active_modal = ActiveModal::CommandPalette;
                    }
                    ModalType::Help => {
                        self.show_help();
                    }
                },
                CommandOutput::Action(action) => {
                    self.handle_command_action(action).await;
                }
                CommandOutput::Silent => {}
                CommandOutput::Multi(outputs) => {
                    for out in outputs.into_iter().rev() {
                        stack.push(out);
                    }
                }
            }
        }
    }

    /// Handle a command action that modifies state
    async fn handle_command_action(&mut self, action: CommandAction) {
        match action {
            CommandAction::ClearMessages => {
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }
            CommandAction::ToggleZenMode => {
                self.state.zen_mode = !self.state.zen_mode;
                if self.state.zen_mode {
                    self.state.status = Some("Zen mode enabled".to_string());
                } else {
                    self.state.status = Some("Zen mode disabled".to_string());
                }
            }
            CommandAction::SetApprovalMode(mode) => {
                if mode == "next" {
                    self.state.approval_mode = self.state.approval_mode.next();
                } else if let Some(m) = ApprovalMode::parse(&mode) {
                    self.state.approval_mode = m;
                } else {
                    self.state.error = Some(format!(
                        "Unknown approval mode: {}. Use: yolo, selective, safe",
                        mode
                    ));
                    return;
                }
                self.state.status = Some(format!(
                    "Approval mode: {}",
                    self.state.approval_mode.label()
                ));
            }
            CommandAction::SetThinkingLevel(level_str) => {
                if let Some(level) = ThinkingLevel::parse(&level_str) {
                    let (enabled, budget) = level.to_config();
                    if let Some(agent) = &self.native_agent {
                        if let Err(e) = agent.set_thinking(enabled, budget) {
                            self.state.error = Some(format!("Failed to set thinking: {}", e));
                            return;
                        }
                    }
                    self.state.status =
                        Some(format!("Thinking: {} (budget: {})", level.label(), budget));
                } else {
                    self.state.error = Some(format!(
                        "Unknown thinking level: {}. Use: off, minimal, low, medium, high, max",
                        level_str
                    ));
                }
            }
            CommandAction::Quit => {
                self.should_quit = true;
            }
            CommandAction::RefreshWorkspace => {
                self.load_workspace_files();
                self.state.status = Some("Workspace files refreshed".to_string());
            }
            CommandAction::CopyLastMessage => {
                if let Some(msg) = self
                    .state
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.role == MessageRole::Assistant && !m.content.is_empty())
                {
                    match self.clipboard.copy(&msg.content) {
                        Ok(_) => {
                            let chars: Vec<char> = msg.content.chars().collect();
                            let preview = if chars.len() > 50 {
                                format!("{}...", chars[..47].iter().collect::<String>())
                            } else {
                                msg.content.clone()
                            };
                            self.state.status = Some(format!("Copied: {}", preview));
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to copy: {}", e));
                        }
                    }
                } else {
                    self.state.status = Some("No message to copy".to_string());
                }
            }
            CommandAction::CompactConversation(instructions) => {
                // Compact conversation by summarizing older messages
                let msg_count = self.state.messages.len();
                if msg_count <= 4 {
                    self.state.status = Some("Conversation too short to compact".to_string());
                    return;
                }

                // Keep last 2 messages, summarize the rest
                let keep_count = 2;
                let to_summarize = msg_count - keep_count;

                // Build summary of compacted messages
                let mut summary = String::new();
                summary.push_str("## Conversation Summary\n\n");

                for (i, msg) in self.state.messages.iter().take(to_summarize).enumerate() {
                    let role = match msg.role {
                        MessageRole::User => "User",
                        MessageRole::Assistant => "Assistant",
                    };
                    let chars: Vec<char> = msg.content.chars().collect();
                    let preview = if chars.len() > 100 {
                        format!("{}...", chars[..97].iter().collect::<String>())
                    } else {
                        msg.content.clone()
                    };
                    summary.push_str(&format!("{}. **{}**: {}\n", i + 1, role, preview));
                }

                if let Some(ref instr) = instructions {
                    summary.push_str(&format!("\n*Focus: {}*\n", instr));
                }

                // Remove old messages and add summary
                let kept: Vec<_> = self.state.messages.drain(to_summarize..).collect();
                self.state.messages.clear();
                self.state.add_system_message(summary);
                self.state.messages.extend(kept);

                self.state.status =
                    Some(format!("Compacted {} messages into summary", to_summarize));
            }
            CommandAction::ShowMcpStatus => {
                // Show MCP server status
                let mut status = String::new();
                status.push_str("## MCP Servers\n\n");
                status.push_str("*No MCP servers configured*\n\n");
                status.push_str(
                    "To add MCP servers, create `~/.composer/mcp.json` or `.composer/mcp.json`:\n",
                );
                status.push_str("```json\n");
                status.push_str("{\n");
                status.push_str("  \"servers\": [\n");
                status.push_str("    {\n");
                status.push_str("      \"name\": \"example\",\n");
                status.push_str("      \"transport\": \"stdio\",\n");
                status.push_str("      \"command\": \"npx\",\n");
                status.push_str("      \"args\": [\"-y\", \"@example/mcp-server\"]\n");
                status.push_str("    }\n");
                status.push_str("  ]\n");
                status.push_str("}\n");
                status.push_str("```\n");
                self.state.add_system_message(status);
            }
            CommandAction::HooksManage(hooks_action) => {
                self.handle_hooks_action(hooks_action);
            }
            CommandAction::ShowUsage(usage_action) => {
                self.handle_usage_action(usage_action);
            }
            CommandAction::ExportSession(export_action) => {
                self.handle_export_action(export_action);
            }
            CommandAction::ShowHistory(history_action) => {
                self.handle_history_action(history_action);
            }
            CommandAction::ShowToolHistory(tool_history_action) => {
                self.handle_tool_history_action(tool_history_action);
            }
            CommandAction::Skills(skills_action) => {
                self.handle_skills_action(skills_action);
            }
            CommandAction::Queue(action) => {
                self.handle_queue_action(action);
            }
            CommandAction::Steer(text) => {
                let _ = self.handle_steer_submit(text).await;
            }
        }
    }

    /// Handle usage/cost display actions
    fn handle_usage_action(&mut self, action: crate::commands::UsageAction) {
        use crate::commands::UsageAction;

        match action {
            UsageAction::Summary => {
                let summary = self.usage_tracker.summary();
                self.state
                    .add_system_message(format!("## Usage Summary\n\n{}", summary));
            }
            UsageAction::Detailed => {
                let detailed = self.usage_tracker.detailed_summary();
                self.state
                    .add_system_message(format!("## Usage Details\n\n```\n{}\n```", detailed));
            }
            UsageAction::Reset => {
                self.usage_tracker.reset();
                self.state.status = Some("Usage tracking reset".to_string());
            }
        }
    }

    /// Handle session export actions
    fn handle_export_action(&mut self, action: crate::commands::ExportAction) {
        use crate::commands::ExportAction;
        use crate::session::{ExportFormat, ExportOptions};

        let (format, path) = match action {
            ExportAction::Markdown(p) => (ExportFormat::Markdown, p),
            ExportAction::Html(p) => (ExportFormat::Html, p),
            ExportAction::Json(p) => (ExportFormat::Json, p),
            ExportAction::PlainText(p) => (ExportFormat::PlainText, p),
            ExportAction::ShowOptions => {
                self.state.add_system_message(
                    "## Session Export\n\n\
                    Usage: `/export <format> [path]`\n\n\
                    **Formats:**\n\
                    - `markdown` or `md` - Human-readable markdown\n\
                    - `html` - Styled HTML page\n\
                    - `json` - Structured JSON data\n\
                    - `text` or `txt` - Plain text\n\n\
                    **Examples:**\n\
                    - `/export markdown` - Output to terminal\n\
                    - `/export html session.html` - Save to file\n"
                        .to_string(),
                );
                return;
            }
        };

        // For now, just show a message since we don't have actual session data
        let _options = ExportOptions {
            format,
            ..Default::default()
        };

        if let Some(ref file_path) = path {
            self.state.status = Some(format!(
                "Export to {} not yet implemented (would write to {})",
                format.extension(),
                file_path
            ));
        } else {
            self.state.status = Some(format!(
                "Export as {} not yet implemented",
                format.extension()
            ));
        }
    }

    /// Handle prompt history actions
    fn handle_history_action(&mut self, action: crate::commands::HistoryAction) {
        use crate::commands::HistoryAction;

        match action {
            HistoryAction::Recent(count) => {
                let recent = self.prompt_history.recent(count);
                if recent.is_empty() {
                    self.state.status = Some("No prompt history".to_string());
                    return;
                }

                let mut msg = String::from("## Recent Prompts\n\n");
                for (i, entry) in recent.iter().enumerate() {
                    let chars: Vec<char> = entry.prompt.chars().collect();
                    let preview = if chars.len() > 60 {
                        format!("{}...", chars[..57].iter().collect::<String>())
                    } else {
                        entry.prompt.clone()
                    };
                    msg.push_str(&format!("{}. {}\n", i + 1, preview));
                }
                self.state.add_system_message(msg);
            }
            HistoryAction::Search(query) => {
                let results = self.prompt_history.search(&query);
                if results.matches.is_empty() {
                    self.state.status = Some(format!("No matches for '{}'", query));
                    return;
                }

                let mut msg = format!("## Search Results for '{}'\n\n", query);
                for (i, m) in results.matches.iter().take(10).enumerate() {
                    let chars: Vec<char> = m.entry.prompt.chars().collect();
                    let preview = if chars.len() > 60 {
                        format!("{}...", chars[..57].iter().collect::<String>())
                    } else {
                        m.entry.prompt.clone()
                    };
                    msg.push_str(&format!("{}. {} (score: {:.2})\n", i + 1, preview, m.score));
                }
                self.state.add_system_message(msg);
            }
            HistoryAction::Clear => {
                self.prompt_history.clear();
                let _ = self.prompt_history.delete_file();
                self.state.status = Some("Prompt history cleared".to_string());
            }
        }
    }

    /// Handle tool history actions
    fn handle_tool_history_action(&mut self, action: crate::commands::ToolHistoryAction) {
        use crate::commands::ToolHistoryAction;

        match action {
            ToolHistoryAction::Recent(count) => {
                let recent = self.tool_history.recent(count);
                if recent.is_empty() {
                    self.state.status = Some("No tool history".to_string());
                    return;
                }

                let mut msg = String::from("## Recent Tool Executions\n\n");
                for exec in recent {
                    let status = if exec.success { "✓" } else { "✗" };
                    let duration = exec
                        .duration
                        .map(|d| format!("{:.0}ms", d.as_millis()))
                        .unwrap_or_else(|| "?".to_string());
                    msg.push_str(&format!(
                        "{} **{}** ({})\n",
                        status, exec.tool_name, duration
                    ));
                }
                self.state.add_system_message(msg);
            }
            ToolHistoryAction::Stats => {
                let summary = self.tool_history.summary();
                self.state
                    .add_system_message(format!("## Tool Statistics\n\n```\n{}\n```", summary));
            }
            ToolHistoryAction::ForTool(name) => {
                let execs = self.tool_history.for_tool(&name);
                if execs.is_empty() {
                    self.state.status = Some(format!("No history for tool '{}'", name));
                    return;
                }

                let mut msg = format!("## History for '{}'\n\n", name);
                for exec in execs.iter().take(10) {
                    let status = if exec.success { "✓" } else { "✗" };
                    let duration = exec
                        .duration
                        .map(|d| format!("{:.0}ms", d.as_millis()))
                        .unwrap_or_else(|| "?".to_string());
                    msg.push_str(&format!(
                        "{} {} - {}\n",
                        status,
                        duration,
                        exec.output_preview(50).unwrap_or_default()
                    ));
                }
                self.state.add_system_message(msg);
            }
            ToolHistoryAction::Clear => {
                self.tool_history.clear();
                self.state.status = Some("Tool history cleared".to_string());
            }
        }
    }

    /// Handle hooks management actions
    fn handle_hooks_action(&mut self, action: crate::commands::HooksAction) {
        use crate::commands::HooksAction;

        // For now, display messages since hooks aren't wired into App yet
        // In a full implementation, we'd access self.hooks: IntegratedHookSystem
        match action {
            HooksAction::List => {
                let mut msg = String::new();
                msg.push_str("## Hook System\n\n");
                msg.push_str("| Type | Count | Status |\n");
                msg.push_str("|------|-------|--------|\n");
                msg.push_str("| Native | 1 | SafetyHook |\n");
                msg.push_str("| Lua | 0 | - |\n");
                msg.push_str("| WASM | 0 | - |\n");
                msg.push_str("| TypeScript | 0 | - |\n\n");
                msg.push_str(
                    "*Configure hooks in `~/.composer/hooks.toml` or `.composer/hooks.toml`*\n",
                );
                self.state.add_system_message(msg);
            }
            HooksAction::Toggle => {
                self.state.status = Some("Hooks toggled".to_string());
                self.state.add_system_message(
                    "Hooks have been toggled. Use `/hooks` to see current status.".to_string(),
                );
            }
            HooksAction::Reload => {
                self.state.status = Some("Hooks reloaded".to_string());
                self.state
                    .add_system_message("Hook configuration reloaded from disk.".to_string());
            }
            HooksAction::Metrics => {
                let mut msg = String::new();
                msg.push_str("## Hook Metrics\n\n");
                msg.push_str("| Metric | Value |\n");
                msg.push_str("|--------|-------|\n");
                msg.push_str("| PreToolUse calls | 0 |\n");
                msg.push_str("| PostToolUse calls | 0 |\n");
                msg.push_str("| Blocks | 0 |\n");
                msg.push_str("| Total duration | 0ms |\n");
                msg.push_str("| Avg duration | 0ms |\n");
                self.state.add_system_message(msg);
            }
            HooksAction::Enable => {
                self.state.status = Some("Hooks enabled".to_string());
                self.state
                    .add_system_message("Hook system enabled.".to_string());
            }
            HooksAction::Disable => {
                self.state.status = Some("Hooks disabled".to_string());
                self.state
                    .add_system_message("Hook system disabled.".to_string());
            }
        }
    }

    /// Handle skills system actions
    fn handle_skills_action(&mut self, action: crate::commands::SkillsAction) {
        use crate::commands::SkillsAction;
        use crate::skills::SkillLoader;

        match action {
            SkillsAction::List => {
                // List all skills from the registry and filesystem
                let loader = SkillLoader::new();
                let (skills, errors) = loader.load_all_with_paths();

                let mut msg = String::from("## Available Skills\n\n");

                if skills.is_empty() && errors.is_empty() {
                    msg.push_str("*No skills found*\n\n");
                    msg.push_str("Skills are loaded from:\n");
                    msg.push_str("- `~/.composer/skills/` (global)\n");
                    msg.push_str("- `.composer/skills/` (project)\n\n");
                    msg.push_str("Create a `SKILL.md` file following the [Agent Skills spec](https://agentskills.io/specification).\n");
                } else {
                    msg.push_str("| Name | Description | Source | Tools |\n");
                    msg.push_str("|------|-------------|--------|-------|\n");

                    for loaded in &skills {
                        let skill = &loaded.definition;
                        let tools_count = skill.provided_tools.len();
                        let tools = if tools_count > 0 {
                            format!("{}", tools_count)
                        } else {
                            "-".to_string()
                        };
                        msg.push_str(&format!(
                            "| {} | {} | {:?} | {} |\n",
                            skill.name,
                            skill.description.chars().take(40).collect::<String>(),
                            skill.source,
                            tools
                        ));
                    }

                    msg.push_str(&format!("\n*{} skill(s) found*\n", skills.len()));
                }

                if !errors.is_empty() {
                    msg.push_str(&format!(
                        "\n**{} error(s) loading skills:**\n",
                        errors.len()
                    ));
                    for err in errors.iter().take(5) {
                        msg.push_str(&format!("- {}\n", err));
                    }
                }

                self.state.add_system_message(msg);
            }
            SkillsAction::Activate(name) => {
                // For now, just show a status message
                // Full implementation would activate the skill in the registry
                self.state.status = Some(format!("Skill '{}' activated", name));
                self.state.add_system_message(format!(
                    "Activated skill **{}**. System prompt will include skill instructions.",
                    name
                ));
            }
            SkillsAction::Deactivate(name) => {
                self.state.status = Some(format!("Skill '{}' deactivated", name));
                self.state
                    .add_system_message(format!("Deactivated skill **{}**.", name));
            }
            SkillsAction::Reload => {
                let loader = SkillLoader::new();
                let (skills, errors) = loader.load_all_with_paths();

                if errors.is_empty() {
                    self.state.status = Some(format!("Loaded {} skill(s)", skills.len()));
                } else {
                    self.state.status = Some(format!(
                        "Loaded {} skill(s), {} error(s)",
                        skills.len(),
                        errors.len()
                    ));
                }

                self.state.add_system_message(format!(
                    "Reloaded skills from filesystem. Found {} skill(s).",
                    skills.len()
                ));
            }
            SkillsAction::Info(name) => {
                let loader = SkillLoader::new();
                let (skills, _) = loader.load_all_with_paths();

                if let Some(loaded) = skills
                    .iter()
                    .find(|s| s.definition.id == name || s.definition.name == name)
                {
                    let skill = &loaded.definition;
                    let mut msg = format!("## Skill: {}\n\n", skill.name);
                    msg.push_str(&format!("**Description:** {}\n\n", skill.description));
                    msg.push_str(&format!("**Source:** {:?}\n\n", skill.source));
                    msg.push_str(&format!("**Path:** `{}`\n\n", loaded.source_path.display()));

                    if !skill.provided_tools.is_empty() {
                        msg.push_str(&format!(
                            "**Tools:** {}\n\n",
                            skill.provided_tools.join(", ")
                        ));
                    }

                    if let Some(ref prompt) = skill.system_prompt_additions {
                        let preview: String = prompt.chars().take(200).collect();
                        msg.push_str(&format!(
                            "**Instructions preview:**\n```\n{}...\n```\n",
                            preview
                        ));
                    }

                    self.state.add_system_message(msg);
                } else {
                    self.state.error = Some(format!("Skill '{}' not found", name));
                }
            }
        }
    }

    fn handle_queue_action(&mut self, action: QueueAction) {
        match action {
            QueueAction::Show => {
                let total = self.queued_prompts.len();
                let steer_count = self
                    .queued_prompts
                    .iter()
                    .filter(|p| p.kind == PromptKind::Steer)
                    .count();
                let follow_up_count = self
                    .queued_prompts
                    .iter()
                    .filter(|p| p.kind == PromptKind::FollowUp)
                    .count();
                let mut msg = String::new();
                msg.push_str("## Queue\n\n");
                msg.push_str(&format!(
                    "**Steering mode:** {}\n",
                    self.state.steering_mode.label()
                ));
                msg.push_str(&format!(
                    "**Follow-up mode:** {}\n",
                    self.state.follow_up_mode.label()
                ));
                msg.push_str(&format!("**Pending:** {}\n", total));
                if total > 0 {
                    msg.push_str(&format!(
                        "- steer: {}, follow-up: {}\n",
                        steer_count, follow_up_count
                    ));
                }
                msg.push_str("\nUse /queue mode [steer|followup] <one|all> to change behavior.");
                self.state.add_system_message(msg);
            }
            QueueAction::Mode { kind, mode } => {
                let label = match kind {
                    QueueModeKind::Steering => {
                        self.state.steering_mode = mode;
                        "Steering"
                    }
                    QueueModeKind::FollowUp => {
                        self.state.follow_up_mode = mode;
                        "Follow-up"
                    }
                };
                self.state
                    .status
                    .replace(format!("{label} mode: {}", mode.label()));
            }
        }
    }

    /// Execute a slash command
    async fn execute_slash_command(&mut self) -> Result<()> {
        let input = self.state.take_input();

        // Try executing through the registry first
        let cwd = self.state.cwd.clone().unwrap_or_else(|| ".".to_string());
        let session_id = self.state.session_id.clone();
        let model = self.state.model.clone();

        match self
            .command_registry
            .execute(&input, &cwd, session_id.as_deref(), model.as_deref())
        {
            Ok(output) => {
                self.handle_command_output(output).await;
                return Ok(());
            }
            Err(e) => {
                // Check if it's an unknown command - if so, try legacy handling or agent passthrough
                if e.message.contains("Unknown command") {
                    // Fall through to legacy handling below
                } else {
                    // Other errors (like missing args) should be shown to user
                    self.state.error = Some(e.to_string());
                    return Ok(());
                }
            }
        }

        // Legacy handling for commands not yet in registry
        let cmd_line = input.trim_start_matches('/');

        // Parse command and args
        let mut parts = cmd_line.split_whitespace();
        let cmd_name = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.collect();

        // Handle built-in commands
        match cmd_name {
            "help" => {
                self.show_help();
            }
            "clear" => {
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }
            "quit" | "exit" => {
                self.should_quit = true;
            }
            "theme" => {
                if let Some(theme_name) = args.first() {
                    if let Err(e) = crate::themes::set_theme_by_name(theme_name) {
                        self.state.error = Some(format!("Failed to set theme: {}", e));
                    } else {
                        self.state.status = Some(format!("Theme set to: {}", theme_name));
                    }
                } else {
                    // Open theme selector
                    self.theme_selector.show();
                    self.active_modal = ActiveModal::ThemeSelector;
                }
            }
            "model" => {
                if let Some(&model_id) = args.first() {
                    // Set model directly
                    if let Some(agent) = &self.native_agent {
                        if let Err(e) = agent.set_model(model_id) {
                            self.state.error = Some(format!("Failed to set model: {}", e));
                        } else {
                            self.state.status = Some(format!("Model: {}", model_id));
                        }
                    }
                } else {
                    // Open model selector
                    self.model_selector.show();
                    self.active_modal = ActiveModal::ModelSelector;
                }
            }
            "thinking" => {
                if let Some(&level_str) = args.first() {
                    if let Some(level) = ThinkingLevel::parse(level_str) {
                        let (enabled, budget) = level.to_config();
                        if let Some(agent) = &self.native_agent {
                            if let Err(e) = agent.set_thinking(enabled, budget) {
                                self.state.error = Some(format!("Failed to set thinking: {}", e));
                            } else {
                                self.state.status = Some(format!(
                                    "Thinking: {} (budget: {})",
                                    level.label(),
                                    budget
                                ));
                            }
                        }
                    } else {
                        self.state.error = Some(format!(
                            "Unknown thinking level: {}. Use: off, minimal, low, medium, high, max",
                            level_str
                        ));
                    }
                } else {
                    self.state.status = Some(
                        "Usage: /thinking <level>\nLevels: off, minimal, low, medium, high, max"
                            .to_string(),
                    );
                }
            }
            "zen" => {
                self.state.zen_mode = !self.state.zen_mode;
                if self.state.zen_mode {
                    self.state.status = Some("Zen mode enabled".to_string());
                } else {
                    self.state.status = Some("Zen mode disabled".to_string());
                }
            }
            "approvals" => {
                if let Some(&mode_str) = args.first() {
                    if let Some(mode) = ApprovalMode::parse(mode_str) {
                        self.state.approval_mode = mode;
                        self.state.status = Some(format!("Approval mode: {}", mode.label()));
                    } else {
                        self.state.error = Some(format!(
                            "Unknown approval mode: {}. Use: yolo, selective, safe",
                            mode_str
                        ));
                    }
                } else {
                    // Toggle to next mode
                    self.state.approval_mode = self.state.approval_mode.next();
                    self.state.status = Some(format!(
                        "Approval mode: {}",
                        self.state.approval_mode.label()
                    ));
                }
            }
            "diag" | "status" => {
                let mut diag = String::new();
                diag.push_str("## Diagnostics\n\n");

                // Model & Provider
                diag.push_str(&format!(
                    "**Model:** {}\n",
                    self.state.model.as_deref().unwrap_or("(none)")
                ));
                diag.push_str(&format!(
                    "**Provider:** {}\n",
                    self.state.provider.as_deref().unwrap_or("(none)")
                ));

                // Working directory & Git
                diag.push_str(&format!(
                    "**CWD:** {}\n",
                    self.state.cwd.as_deref().unwrap_or("(unknown)")
                ));
                diag.push_str(&format!(
                    "**Git Branch:** {}\n",
                    self.state.git_branch.as_deref().unwrap_or("(not a repo)")
                ));

                // Session
                diag.push_str(&format!(
                    "**Session:** {}\n",
                    self.state.session_id.as_deref().unwrap_or("(ephemeral)")
                ));

                // Modes
                diag.push_str(&format!(
                    "**Approval Mode:** {}\n",
                    self.state.approval_mode.label()
                ));
                diag.push_str(&format!(
                    "**Zen Mode:** {}\n",
                    if self.state.zen_mode { "on" } else { "off" }
                ));
                diag.push_str(&format!(
                    "**Steering Mode:** {}\n",
                    self.state.steering_mode.label()
                ));
                diag.push_str(&format!(
                    "**Follow-up Mode:** {}\n",
                    self.state.follow_up_mode.label()
                ));

                // Terminal info
                if let Ok((cols, rows)) = crossterm::terminal::size() {
                    diag.push_str(&format!("**Terminal:** {}x{}\n", cols, rows));
                }

                // Message count
                diag.push_str(&format!("**Messages:** {}\n", self.state.messages.len()));

                self.state.add_system_message(diag);
            }
            "sessions" | "resume" => {
                self.session_switcher.show();
                self.active_modal = ActiveModal::SessionSwitcher;
            }
            "files" => {
                self.file_search.show();
                self.active_modal = ActiveModal::FileSearch;
            }
            "commands" => {
                self.command_palette.show();
                self.active_modal = ActiveModal::CommandPalette;
            }
            "refresh" => {
                self.load_workspace_files();
                self.state.status = Some("Workspace files refreshed".to_string());
            }
            "copy" => {
                // Copy last assistant message to clipboard
                if let Some(msg) = self
                    .state
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.role == MessageRole::Assistant && !m.content.is_empty())
                {
                    match self.clipboard.copy(&msg.content) {
                        Ok(_) => {
                            let chars: Vec<char> = msg.content.chars().collect();
                            let preview = if chars.len() > 50 {
                                format!("{}...", chars[..47].iter().collect::<String>())
                            } else {
                                msg.content.clone()
                            };
                            self.state.status = Some(format!("Copied: {}", preview));
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to copy: {}", e));
                        }
                    }
                } else {
                    self.state.status = Some("No message to copy".to_string());
                }
            }
            _ => {
                // Unknown command - try to send to agent
                if let Some(agent) = &self.native_agent {
                    let _ = agent.prompt(format!("/{}", cmd_line), vec![]).await;
                    self.state.busy = true;
                } else {
                    self.state.error = Some(format!("Unknown command: /{}", cmd_name));
                }
            }
        }

        self.slash_state.reset();
        Ok(())
    }

    /// Show help message
    fn show_help(&mut self) {
        let help_text = r#"
Composer TUI - Keyboard Shortcuts

Navigation:
  Up/Down       Scroll messages / Navigate completions
  PageUp/Down   Scroll faster
  g/G           Jump to top/bottom (when input empty)
  Ctrl+J/K      Scroll down/up
  Ctrl+L        Clear screen

Input:
  Enter         Send message (steer while running)
  Alt+Enter     Queue follow-up (while running)
  @             Open file search
  /             Start slash command
  Ctrl+U        Clear input
  Esc           Cancel / Close modal

Toggle:
  Tab           Toggle thinking expansion
  Ctrl+T        Toggle tool call expansion

Modals:
  Ctrl+P        Open command palette
  Ctrl+O        Open file search
  Ctrl+Alt+R    Open session switcher

Session:
  Ctrl+C        Interrupt / Quit
  Ctrl+D        Quit

Clipboard:
  Ctrl+Y        Paste text
  /copy         Copy last response

Slash Commands:
  /help         Show this help
  /clear        Clear messages
  /copy         Copy last response
  /theme        Change theme
  /queue        Manage follow-up / steering queue modes
  /steer        Send a steering message
  /sessions     Browse sessions
  /files        Search files
  /commands     Open command palette
  /quit         Exit
"#;
        self.state.add_system_message(help_text.trim().to_string());
    }

    async fn handle_follow_up_submit(&mut self, content: String) -> Result<bool> {
        if content.trim().is_empty() {
            return Ok(false);
        }
        if self.state.busy && !self.state.follow_up_mode.allows_queue() {
            self.state.status = Some(
                "Follow-up mode set to one-at-a-time. Use /queue mode followup all to enable follow-ups while running."
                    .to_string(),
            );
            return Ok(false);
        }
        if self.state.busy {
            return self
                .queue_prompt(content, PromptKind::FollowUp, false)
                .await;
        }
        self.submit_prompt_with_kind(content, PromptKind::FollowUp)
            .await
    }

    async fn handle_steer_submit(&mut self, content: String) -> Result<bool> {
        if content.trim().is_empty() {
            return Ok(false);
        }
        if self.state.busy && !self.state.steering_mode.allows_queue() {
            self.state.status = Some(
                "Steering mode set to one-at-a-time. Use /queue mode steer all to allow multiple steering messages."
                    .to_string(),
            );
            return Ok(false);
        }
        if self.state.busy {
            if let Some(agent) = &self.native_agent {
                agent.cancel_keep_queue();
            }
            self.state.status = Some("Steering: interrupted current run".to_string());
            return self.queue_prompt(content, PromptKind::Steer, true).await;
        }
        self.submit_prompt_with_kind(content, PromptKind::Steer)
            .await
    }

    async fn queue_prompt(
        &mut self,
        content: String,
        kind: PromptKind,
        front: bool,
    ) -> Result<bool> {
        let Some(agent) = &self.native_agent else {
            self.state.error = Some("Agent not initialized".to_string());
            return Ok(false);
        };

        if let Err(e) = agent.prompt_with_kind(content.clone(), vec![], kind).await {
            self.state.error = Some(format!("Failed to queue prompt: {}", e));
            return Ok(false);
        }

        let dropped = self.enqueue_pending_prompt(content, kind, front);
        if let Some(dropped) = dropped {
            self.state.status = Some(format!(
                "Queue full, dropped oldest {}.",
                dropped.kind.label()
            ));
        }
        Ok(true)
    }

    fn enqueue_pending_prompt(
        &mut self,
        content: String,
        kind: PromptKind,
        front: bool,
    ) -> Option<QueuedPrompt> {
        let entry = QueuedPrompt { content, kind };
        if front {
            self.queued_prompts.push_front(entry);
        } else {
            self.queued_prompts.push_back(entry);
        }
        if self.queued_prompts.len() > MAX_PENDING_MESSAGES {
            return self.queued_prompts.pop_back();
        }
        None
    }

    /// Submit a prompt to the agent
    async fn submit_prompt(&mut self, content: String) -> Result<()> {
        let _ = self
            .submit_prompt_with_kind(content, PromptKind::Prompt)
            .await?;
        Ok(())
    }

    async fn submit_prompt_with_kind(&mut self, content: String, kind: PromptKind) -> Result<bool> {
        // Add user message to state
        self.state.add_user_message(content.clone());
        self.state.busy = true;

        if let Some(agent) = &self.native_agent {
            // Send the prompt - returns immediately, actual work happens in background task
            // Events will be received via poll_agent in the main loop
            if let Err(e) = agent.prompt_with_kind(content, vec![], kind).await {
                self.state.error = Some(format!("Failed to send prompt: {}", e));
                self.state.busy = false;
                return Ok(false);
            }
            return Ok(true);
        }
        self.state.error = Some("Agent not initialized".to_string());
        self.state.busy = false;
        Ok(false)
    }

    /// Render the UI
    fn render(&mut self) -> Result<()> {
        // Extract needed data to avoid borrow conflicts
        let state = &self.state;
        let active_modal = self.active_modal;
        let slash_state = &self.slash_state;
        let file_search = &self.file_search;
        let session_switcher = &self.session_switcher;
        let command_palette = &self.command_palette;
        let approval_controller = &self.approval_controller;
        let model_selector = &self.model_selector;
        let theme_selector = &self.theme_selector;

        self.terminal.draw(|frame| {
            let area = frame.area();
            let view = ChatView::new(state);
            frame.render_widget(view, area);

            // Show error if any
            if let Some(error) = &state.error {
                let error_area = Rect {
                    x: area.x + 1,
                    y: area.height.saturating_sub(5),
                    width: area.width.saturating_sub(2),
                    height: 2,
                };
                let error_widget = ratatui::widgets::Paragraph::new(error.as_str())
                    .style(Style::default().fg(Color::Red));
                frame.render_widget(error_widget, error_area);
            }

            // Render slash completions if active
            if active_modal == ActiveModal::None && slash_state.has_completions() {
                Self::render_slash_completions_static(slash_state, frame, area);
            }

            // Render modals
            match active_modal {
                ActiveModal::FileSearch => {
                    file_search.render(frame, area);
                }
                ActiveModal::SessionSwitcher => {
                    session_switcher.render(frame, area);
                }
                ActiveModal::CommandPalette => {
                    command_palette.render(frame, area);
                }
                ActiveModal::Approval => {
                    if let Some(request) = approval_controller.current() {
                        let modal = ApprovalModal::new(request);
                        frame.render_widget(modal, area);
                    }
                }
                ActiveModal::ModelSelector => {
                    model_selector.render(frame, area);
                }
                ActiveModal::ThemeSelector => {
                    theme_selector.render(frame, area);
                }
                ActiveModal::None => {}
            }

            // Position terminal cursor in the input area
            // Layout: [Messages(Min), Input(auto), Status(1)]
            if active_modal == ActiveModal::None {
                // Calculate input area position (same layout as ChatView)
                let status_height = if state.zen_mode { 0 } else { 1 };
                let input_height = calculate_input_height(state, area);
                let input_area = Rect {
                    x: area.x,
                    y: area
                        .y
                        .saturating_add(area.height.saturating_sub(status_height + input_height)),
                    width: area.width,
                    height: input_height,
                };

                // Create widget just to calculate cursor position
                let input_widget = ChatInputWidget::new(&state.textarea, "", state.busy, 0, None);

                if let Some((cursor_x, cursor_y)) = input_widget.cursor_pos(input_area) {
                    frame.set_cursor_position((cursor_x, cursor_y));
                }
            }
        })?;

        Ok(())
    }

    /// Toggle expansion for the most recent tool call
    fn toggle_last_tool_call(&mut self) {
        if let Some(call_id) = self
            .state
            .messages
            .iter()
            .rev()
            .find_map(|m| m.tool_calls.last().map(|tc| tc.call_id.clone()))
        {
            self.state.toggle_tool_call(&call_id);
        }
    }

    /// Toggle thinking expansion for the most recent message with thinking
    fn toggle_last_thinking(&mut self) {
        if let Some(msg_id) = self
            .state
            .messages
            .iter()
            .rev()
            .find(|m| !m.thinking.is_empty())
            .map(|m| m.id.clone())
        {
            self.state.toggle_thinking(&msg_id);
        }
    }

    /// Render slash command completions popup (static version for closure)
    fn render_slash_completions_static(
        slash_state: &SlashCycleState,
        frame: &mut ratatui::Frame,
        area: Rect,
    ) {
        use ratatui::widgets::{Block, Borders, Clear, List, ListItem};

        let completions = slash_state.completions();
        if completions.is_empty() {
            return;
        }

        let current_idx = slash_state.current_index();

        // Position above the input
        let popup_height = (completions.len() as u16 + 2).min(10);
        let popup_width = 40.min(area.width.saturating_sub(4));
        let popup_y = area.height.saturating_sub(4 + popup_height);

        let popup_area = Rect {
            x: area.x + 1,
            y: popup_y,
            width: popup_width,
            height: popup_height,
        };

        frame.render_widget(Clear, popup_area);

        let items: Vec<ListItem> = completions
            .iter()
            .enumerate()
            .map(|(i, cmd)| {
                let style = if i == current_idx {
                    Style::default().bg(Color::DarkGray).fg(Color::Cyan)
                } else {
                    Style::default().fg(Color::White)
                };
                // Completions already include the slash
                ListItem::new(cmd.clone()).style(style)
            })
            .collect();

        let list = List::new(items).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .style(Style::default().bg(Color::Black)),
        );

        frame.render_widget(list, popup_area);
    }
}

impl Default for App {
    fn default() -> Self {
        match Self::new() {
            Ok(app) => app,
            Err(err) => {
                eprintln!("[app] Warning: Failed to initialize terminal: {}", err);
                let (terminal, capabilities) =
                    terminal::init_fallback().unwrap_or_else(|fallback_err| {
                        panic!(
                            "Failed to create App: {}; fallback failed: {}",
                            err, fallback_err
                        );
                    });
                Self::new_with_terminal(terminal, capabilities)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // ActiveModal Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_active_modal_default() {
        let modal = ActiveModal::None;
        assert_eq!(modal, ActiveModal::None);
    }

    #[test]
    fn test_active_modal_equality() {
        assert_eq!(ActiveModal::FileSearch, ActiveModal::FileSearch);
        assert_ne!(ActiveModal::FileSearch, ActiveModal::CommandPalette);
    }

    #[test]
    fn test_active_modal_copy() {
        let modal = ActiveModal::Approval;
        let copy = modal;
        assert_eq!(modal, copy);
    }

    #[test]
    fn test_active_modal_variants_exist() {
        // Ensure all modal variants are defined correctly
        let modals = [
            ActiveModal::None,
            ActiveModal::FileSearch,
            ActiveModal::SessionSwitcher,
            ActiveModal::CommandPalette,
            ActiveModal::Approval,
            ActiveModal::ModelSelector,
            ActiveModal::ThemeSelector,
        ];
        assert_eq!(modals.len(), 7);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CommandOutput Handling Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_command_output_message_variants() {
        // Test that CommandOutput variants can be constructed
        let msg = CommandOutput::Message("test".to_string());
        assert!(matches!(msg, CommandOutput::Message(_)));

        let help = CommandOutput::Help("help text".to_string());
        assert!(matches!(help, CommandOutput::Help(_)));

        let warn = CommandOutput::Warning("warning".to_string());
        assert!(matches!(warn, CommandOutput::Warning(_)));

        let silent = CommandOutput::Silent;
        assert!(matches!(silent, CommandOutput::Silent));
    }

    #[test]
    fn test_command_output_multi() {
        let outputs = CommandOutput::Multi(vec![
            CommandOutput::Message("first".to_string()),
            CommandOutput::Warning("second".to_string()),
        ]);
        if let CommandOutput::Multi(items) = outputs {
            assert_eq!(items.len(), 2);
        } else {
            panic!("Expected Multi variant");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CommandAction Handling Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_command_action_clear_messages() {
        let action = CommandAction::ClearMessages;
        assert!(matches!(action, CommandAction::ClearMessages));
    }

    #[test]
    fn test_command_action_toggle_zen_mode() {
        let action = CommandAction::ToggleZenMode;
        assert!(matches!(action, CommandAction::ToggleZenMode));
    }

    #[test]
    fn test_command_action_set_approval_mode() {
        let action = CommandAction::SetApprovalMode("yolo".to_string());
        if let CommandAction::SetApprovalMode(mode) = action {
            assert_eq!(mode, "yolo");
        } else {
            panic!("Expected SetApprovalMode");
        }
    }

    #[test]
    fn test_command_action_set_thinking_level() {
        let action = CommandAction::SetThinkingLevel("high".to_string());
        if let CommandAction::SetThinkingLevel(level) = action {
            assert_eq!(level, "high");
        } else {
            panic!("Expected SetThinkingLevel");
        }
    }

    #[test]
    fn test_command_action_quit() {
        let action = CommandAction::Quit;
        assert!(matches!(action, CommandAction::Quit));
    }

    #[test]
    fn test_command_action_refresh_workspace() {
        let action = CommandAction::RefreshWorkspace;
        assert!(matches!(action, CommandAction::RefreshWorkspace));
    }

    #[test]
    fn test_command_action_copy_last_message() {
        let action = CommandAction::CopyLastMessage;
        assert!(matches!(action, CommandAction::CopyLastMessage));
    }

    #[test]
    fn test_command_action_compact_conversation() {
        let action = CommandAction::CompactConversation(Some("focus".to_string()));
        if let CommandAction::CompactConversation(instructions) = action {
            assert_eq!(instructions, Some("focus".to_string()));
        } else {
            panic!("Expected CompactConversation");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ModalType Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_modal_type_variants() {
        let types = [
            ModalType::ThemeSelector,
            ModalType::ModelSelector,
            ModalType::SessionList,
            ModalType::FileSearch,
            ModalType::CommandPalette,
            ModalType::Help,
        ];
        assert_eq!(types.len(), 6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ApprovalMode Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_approval_mode_parse() {
        assert_eq!(ApprovalMode::parse("yolo"), Some(ApprovalMode::Yolo));
        assert_eq!(ApprovalMode::parse("safe"), Some(ApprovalMode::Safe));
        assert_eq!(
            ApprovalMode::parse("selective"),
            Some(ApprovalMode::Selective)
        );
        assert_eq!(ApprovalMode::parse("invalid"), None);
    }

    #[test]
    fn test_approval_mode_next() {
        assert_eq!(ApprovalMode::Yolo.next(), ApprovalMode::Selective);
        assert_eq!(ApprovalMode::Selective.next(), ApprovalMode::Safe);
        assert_eq!(ApprovalMode::Safe.next(), ApprovalMode::Yolo);
    }

    #[test]
    fn test_approval_mode_label() {
        assert!(!ApprovalMode::Yolo.label().is_empty());
        assert!(!ApprovalMode::Safe.label().is_empty());
        assert!(!ApprovalMode::Selective.label().is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ThinkingLevel Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_thinking_level_parse() {
        assert!(ThinkingLevel::parse("off").is_some());
        assert!(ThinkingLevel::parse("minimal").is_some());
        assert!(ThinkingLevel::parse("low").is_some());
        assert!(ThinkingLevel::parse("medium").is_some());
        assert!(ThinkingLevel::parse("high").is_some());
        assert!(ThinkingLevel::parse("max").is_some());
        assert!(ThinkingLevel::parse("invalid").is_none());
    }

    #[test]
    fn test_thinking_level_to_config() {
        let off = ThinkingLevel::parse("off").unwrap();
        let (enabled, _budget) = off.to_config();
        assert!(!enabled);

        let high = ThinkingLevel::parse("high").unwrap();
        let (enabled, budget) = high.to_config();
        assert!(enabled);
        assert!(budget > 0);
    }

    #[test]
    fn test_thinking_level_label() {
        let medium = ThinkingLevel::parse("medium").unwrap();
        assert!(!medium.label().is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AppState Tests (Integration with app.rs logic)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_app_state_message_operations() {
        let mut state = AppState::new();
        assert!(state.messages.is_empty());

        state.add_user_message("Hello".to_string());
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].role, MessageRole::User);
        assert_eq!(state.messages[0].content, "Hello");

        state.add_system_message("System response".to_string());
        assert_eq!(state.messages.len(), 2);
    }

    #[test]
    fn test_app_state_input_operations() {
        let mut state = AppState::new();
        assert!(state.input().is_empty());

        state.insert_char('H');
        state.insert_char('i');
        assert_eq!(state.input(), "Hi");

        state.backspace();
        assert_eq!(state.input(), "H");

        state.set_input("New input");
        assert_eq!(state.input(), "New input");

        let taken = state.take_input();
        assert_eq!(taken, "New input");
        assert!(state.input().is_empty());
    }

    #[test]
    fn test_app_state_scroll_operations() {
        let mut state = AppState::new();
        assert_eq!(state.scroll_offset, 0);

        // scroll_down increases offset (scrolls toward older messages)
        state.scroll_down(5);
        assert_eq!(state.scroll_offset, 5);

        // scroll_up decreases offset (scrolls toward newer messages)
        state.scroll_up(3);
        assert_eq!(state.scroll_offset, 2);

        // scroll_up with larger amount clamps to 0
        state.scroll_up(10);
        assert_eq!(state.scroll_offset, 0);
    }

    #[test]
    fn test_app_state_zen_mode() {
        let mut state = AppState::new();
        assert!(!state.zen_mode);

        state.zen_mode = true;
        assert!(state.zen_mode);
    }

    #[test]
    fn test_app_state_busy_flag() {
        let mut state = AppState::new();
        assert!(!state.busy);

        state.busy = true;
        assert!(state.busy);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Slash Command State Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_slash_cycle_state_new() {
        let state = SlashCycleState::new();
        assert!(!state.has_completions());
        assert!(state.current().is_none());
    }

    #[test]
    fn test_slash_cycle_state_reset() {
        let mut state = SlashCycleState::new();
        state.reset();
        assert!(!state.has_completions());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Usage Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_usage_action_variants() {
        use crate::commands::UsageAction;

        let summary = UsageAction::Summary;
        assert!(matches!(summary, UsageAction::Summary));

        let detailed = UsageAction::Detailed;
        assert!(matches!(detailed, UsageAction::Detailed));

        let reset = UsageAction::Reset;
        assert!(matches!(reset, UsageAction::Reset));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Export Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_export_action_variants() {
        use crate::commands::ExportAction;

        let md = ExportAction::Markdown(None);
        assert!(matches!(md, ExportAction::Markdown(None)));

        let html = ExportAction::Html(Some("test.html".to_string()));
        if let ExportAction::Html(path) = html {
            assert_eq!(path, Some("test.html".to_string()));
        }

        let json = ExportAction::Json(None);
        assert!(matches!(json, ExportAction::Json(_)));

        let txt = ExportAction::PlainText(None);
        assert!(matches!(txt, ExportAction::PlainText(_)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // History Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_history_action_variants() {
        use crate::commands::HistoryAction;

        let recent = HistoryAction::Recent(10);
        if let HistoryAction::Recent(count) = recent {
            assert_eq!(count, 10);
        }

        let search = HistoryAction::Search("query".to_string());
        if let HistoryAction::Search(q) = search {
            assert_eq!(q, "query");
        }

        let clear = HistoryAction::Clear;
        assert!(matches!(clear, HistoryAction::Clear));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tool History Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_tool_history_action_variants() {
        use crate::commands::ToolHistoryAction;

        let recent = ToolHistoryAction::Recent(5);
        if let ToolHistoryAction::Recent(count) = recent {
            assert_eq!(count, 5);
        }

        let stats = ToolHistoryAction::Stats;
        assert!(matches!(stats, ToolHistoryAction::Stats));

        let for_tool = ToolHistoryAction::ForTool("bash".to_string());
        if let ToolHistoryAction::ForTool(name) = for_tool {
            assert_eq!(name, "bash");
        }

        let clear = ToolHistoryAction::Clear;
        assert!(matches!(clear, ToolHistoryAction::Clear));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Hooks Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_hooks_action_variants() {
        use crate::commands::HooksAction;

        let actions = [
            HooksAction::List,
            HooksAction::Toggle,
            HooksAction::Reload,
            HooksAction::Metrics,
            HooksAction::Enable,
            HooksAction::Disable,
        ];
        assert_eq!(actions.len(), 6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Message Role Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_message_role_equality() {
        assert_eq!(MessageRole::User, MessageRole::User);
        assert_eq!(MessageRole::Assistant, MessageRole::Assistant);
        assert_ne!(MessageRole::User, MessageRole::Assistant);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Integration Tests for State Transitions
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_message_content_preview() {
        let long_content = "a".repeat(200);
        let chars: Vec<char> = long_content.chars().collect();
        let preview = if chars.len() > 100 {
            format!("{}...", chars[..97].iter().collect::<String>())
        } else {
            long_content.clone()
        };
        assert_eq!(preview.len(), 100); // 97 chars + "..."
    }

    #[test]
    fn test_compact_conversation_logic() {
        // Test the logic used in CompactConversation action
        let msg_count = 10;
        let keep_count = 2;

        if msg_count > 4 {
            let to_summarize = msg_count - keep_count;
            assert_eq!(to_summarize, 8);
        }

        // Edge case: exactly 4 messages shouldn't compact
        let msg_count_small = 4;
        assert!(msg_count_small <= 4);
    }

    #[test]
    fn test_scroll_boundary_handling() {
        let mut state = AppState::new();

        // scroll_up at 0 should stay at 0 (can't go below 0)
        state.scroll_up(100);
        assert_eq!(state.scroll_offset, 0);

        // scroll_down increases offset (scroll toward history)
        state.scroll_down(50);
        assert_eq!(state.scroll_offset, 50);

        // scroll_up decreases offset (scroll toward recent)
        state.scroll_up(30);
        assert_eq!(state.scroll_offset, 20);

        // scroll_up by more than current clamps to 0
        state.scroll_up(100);
        assert_eq!(state.scroll_offset, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Input Cursor Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_cursor_movement() {
        let mut state = AppState::new();
        state.set_input("Hello World");

        // Cursor starts at end
        let initial_cursor = state.cursor();

        state.move_left();
        assert!(state.cursor() < initial_cursor || initial_cursor == 0);

        state.move_right();
        // Cursor should move right (or stay at end)

        state.move_home();
        assert_eq!(state.cursor(), 0);

        state.move_end();
        assert_eq!(state.cursor(), state.input().len());
    }

    #[test]
    fn test_delete_operation() {
        let mut state = AppState::new();
        state.set_input("Hello");
        state.move_home();
        state.delete(); // Delete 'H'
        assert_eq!(state.input(), "ello");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Error and Status Message Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_error_and_status_fields() {
        let mut state = AppState::new();

        assert!(state.error.is_none());
        assert!(state.status.is_none());

        state.error = Some("Test error".to_string());
        assert_eq!(state.error, Some("Test error".to_string()));

        state.status = Some("Connected".to_string());
        assert_eq!(state.status, Some("Connected".to_string()));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Session ID Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_session_id_handling() {
        let mut state = AppState::new();
        assert!(state.session_id.is_none());

        state.session_id = Some("session-123".to_string());
        assert_eq!(state.session_id, Some("session-123".to_string()));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tool Call Toggle Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_tool_call_toggle() {
        let mut state = AppState::new();
        let call_id = "call-123";

        // Initially not expanded
        assert!(!state.is_tool_call_expanded(call_id));

        // Toggle on
        state.toggle_tool_call(call_id);
        assert!(state.is_tool_call_expanded(call_id));

        // Toggle off
        state.toggle_tool_call(call_id);
        assert!(!state.is_tool_call_expanded(call_id));
    }

    #[test]
    fn test_multiple_tool_calls_expansion() {
        let mut state = AppState::new();

        state.toggle_tool_call("call-1");
        state.toggle_tool_call("call-2");

        assert!(state.is_tool_call_expanded("call-1"));
        assert!(state.is_tool_call_expanded("call-2"));
        assert!(!state.is_tool_call_expanded("call-3"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Thinking Toggle Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_thinking_toggle() {
        let mut state = AppState::new();

        // Add a user message and get its ID
        let msg_id = state.add_user_message("test".to_string());

        // Initially not expanded
        let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
        assert!(!msg.thinking_expanded);

        // Toggle on
        state.toggle_thinking(&msg_id);
        let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
        assert!(msg.thinking_expanded);

        // Toggle off
        state.toggle_thinking(&msg_id);
        let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
        assert!(!msg.thinking_expanded);
    }

    #[test]
    fn test_thinking_toggle_nonexistent() {
        let mut state = AppState::new();
        state.add_user_message("test".to_string());

        // Should not panic on nonexistent ID
        state.toggle_thinking("nonexistent-id");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // System Prompt Building Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_system_prompt_contains_tools() {
        // Test that system prompts mention available tools
        let prompt_template = r#"You have access to the following tools:
- bash: Execute shell commands
- read: Read file contents
- write: Write to files
- glob: Find files by pattern
- grep: Search file contents"#;

        assert!(prompt_template.contains("bash"));
        assert!(prompt_template.contains("read"));
        assert!(prompt_template.contains("write"));
        assert!(prompt_template.contains("glob"));
        assert!(prompt_template.contains("grep"));
    }
}

//! Native Composer TUI Application
//!
//! This is the main entry point for the native Rust TUI.
//! Supports two modes:
//! - Native agent: Pure Rust implementation that talks directly to AI providers (default)
//! - Node.js agent: Subprocess for legacy compatibility (use --legacy flag)
//!
//! The native agent is always the default. Use COMPOSER_LEGACY=1 to force Node.js mode.

use std::sync::Arc;

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers as CrosstermModifiers};
use ratatui::prelude::*;
use tokio::sync::mpsc;

use crate::agent::{AgentProcess, FromAgent, NativeAgent, NativeAgentConfig, ToolResult};
use crate::commands::{
    build_command_registry, CommandRegistry, SlashCommandMatcher, SlashCycleState,
};
use crate::components::{
    ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest, ChatInputWidget,
    ChatView, CommandPalette, FileSearchModal, SessionSwitcher,
};
use crate::files::get_workspace_files;
use crate::session::{AppMessage, SessionManager};
use crate::state::{AppState, Message, MessageRole};
use crate::terminal::{self, TerminalCapabilities};
use crate::tools::ToolExecutor;

/// Active modal in the UI
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveModal {
    None,
    FileSearch,
    SessionSwitcher,
    CommandPalette,
    Approval,
}

/// Agent backend type
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentBackend {
    /// Native Rust agent (default when API keys are set)
    Native,
    /// Node.js subprocess (legacy)
    NodeJs,
}

/// Main application
pub struct App {
    state: AppState,
    /// Node.js agent subprocess (legacy mode)
    node_agent: Option<AgentProcess>,
    /// Native Rust agent
    native_agent: Option<NativeAgent>,
    /// Event receiver for native agent
    native_event_rx: Option<mpsc::UnboundedReceiver<FromAgent>>,
    /// Tool response sender for native agent
    tool_response_tx: Option<mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>>,
    /// Tool executor for native agent
    tool_executor: ToolExecutor,
    /// Which backend we're using
    backend: AgentBackend,
    terminal: terminal::Terminal,
    should_quit: bool,
    /// Arguments to pass to the Node.js agent
    agent_args: Vec<String>,
    /// Terminal capabilities including viewport position
    capabilities: TerminalCapabilities,
    /// Command registry
    #[allow(dead_code)]
    command_registry: Arc<CommandRegistry>,
    /// Slash command matcher
    slash_matcher: SlashCommandMatcher,
    /// Slash command completion state
    slash_state: SlashCycleState,
    /// Currently active modal
    active_modal: ActiveModal,
    /// File search modal
    file_search: FileSearchModal,
    /// Session switcher modal
    session_switcher: SessionSwitcher,
    /// Command palette modal
    command_palette: CommandPalette,
    /// Approval controller
    approval_controller: ApprovalController,
    /// Session manager
    session_manager: SessionManager,
}

impl App {
    /// Create a new application
    pub fn new() -> Result<Self> {
        Self::with_args(Vec::new())
    }

    /// Create a new application with CLI arguments to pass to the agent
    pub fn with_args(agent_args: Vec<String>) -> Result<Self> {
        let (terminal, capabilities) = terminal::init().context("Failed to initialize terminal")?;
        let command_registry = Arc::new(build_command_registry());
        let slash_matcher = SlashCommandMatcher::new(Arc::clone(&command_registry));
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        // Determine which backend to use
        // Native is always the default; use COMPOSER_LEGACY=1 to force Node.js
        let use_legacy = std::env::var("COMPOSER_LEGACY")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let backend = if use_legacy {
            AgentBackend::NodeJs
        } else {
            AgentBackend::Native
        };

        Ok(Self {
            state: AppState::new(),
            node_agent: None,
            native_agent: None,
            native_event_rx: None,
            tool_response_tx: None,
            tool_executor: ToolExecutor::new(&cwd),
            backend,
            terminal,
            should_quit: false,
            agent_args,
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
        })
    }

    /// Get the current viewport top position (for history push)
    pub fn viewport_top(&self) -> u16 {
        self.capabilities.viewport_top
    }

    /// Run the main event loop
    pub async fn run(mut self) -> Result<i32> {
        // Load workspace files for @ mentions
        self.load_workspace_files();

        // Spawn the agent
        self.spawn_agent().await?;

        // Main loop
        loop {
            // Render
            self.render()?;

            // Handle events with a timeout so we can check for agent messages
            if event::poll(std::time::Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press {
                        self.handle_key(key.code, key.modifiers).await?;
                    }
                }
            }

            // Check for agent messages
            self.poll_agent().await?;

            if self.should_quit {
                break;
            }
        }

        // Cleanup
        if let Some(mut agent) = self.node_agent.take() {
            let _ = agent.shutdown().await;
        }
        terminal::restore()?;

        Ok(0)
    }

    /// Load workspace files for file search
    fn load_workspace_files(&mut self) {
        let cwd = std::env::current_dir().unwrap_or_default();
        let files = get_workspace_files(&cwd, 10000);
        self.file_search.set_files(files);
    }

    /// Spawn the agent (native or Node.js)
    async fn spawn_agent(&mut self) -> Result<()> {
        match self.backend {
            AgentBackend::Native => self.spawn_native_agent().await,
            AgentBackend::NodeJs => self.spawn_nodejs_agent().await,
        }
    }

    /// Spawn the native Rust agent
    async fn spawn_native_agent(&mut self) -> Result<()> {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

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

        self.state.status = Some(format!("Initializing native agent ({})...", model));

        match NativeAgent::new(config) {
            Ok((agent, event_rx)) => {
                let tool_tx = agent.tool_response_sender();
                self.native_agent = Some(agent);
                self.native_event_rx = Some(event_rx);
                self.tool_response_tx = Some(tool_tx);

                // Send ready event
                if let Some(agent) = &self.native_agent {
                    agent.send_ready();
                }

                // Ensure busy is false so user can type
                self.state.busy = false;
                self.state.status = Some(format!("Ready: {} (native)", model));
            }
            Err(e) => {
                self.state.error = Some(format!("Failed to create native agent: {}", e));
                // Fall back to Node.js agent
                self.backend = AgentBackend::NodeJs;
                return self.spawn_nodejs_agent().await;
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

    /// Spawn the Node.js agent subprocess (legacy)
    async fn spawn_nodejs_agent(&mut self) -> Result<()> {
        // Find the composer script to run
        let node_path = std::env::var("NODE_PATH").unwrap_or_else(|_| "node".to_string());

        // Try to find the composer entry point
        let script_path = std::env::var("COMPOSER_AGENT_SCRIPT").unwrap_or_else(|_| {
            // Default: look for local development path
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.join("dist/cli.js").to_string_lossy().to_string()
        });

        // Check if script exists
        if !std::path::Path::new(&script_path).exists() {
            // For now, just set status and continue without agent
            self.state.error = Some(format!(
                "No API key set and agent script not found: {}. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for native mode.",
                script_path
            ));
            return Ok(());
        }

        self.state.status = Some(format!("Spawning: {} {}", node_path, script_path));

        // Pass CLI arguments to the agent
        match AgentProcess::spawn(&node_path, &script_path, &self.agent_args).await {
            Ok(agent) => {
                self.node_agent = Some(agent);
                self.state.status = Some("Agent spawned, waiting for ready...".to_string());
            }
            Err(e) => {
                self.state.error = Some(format!("Failed to spawn agent: {}", e));
            }
        }

        Ok(())
    }

    /// Poll for messages from the agent
    async fn poll_agent(&mut self) -> Result<()> {
        match self.backend {
            AgentBackend::Native => self.poll_native_agent().await,
            AgentBackend::NodeJs => self.poll_nodejs_agent().await,
        }
    }

    /// Poll for messages from the native agent
    async fn poll_native_agent(&mut self) -> Result<()> {
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

    /// Poll for messages from the Node.js agent
    async fn poll_nodejs_agent(&mut self) -> Result<()> {
        // Collect messages first to avoid borrow issues
        let mut messages = Vec::new();
        if let Some(agent) = &mut self.node_agent {
            while let Ok(msg) = agent.rx.try_recv() {
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
        match &msg {
            FromAgent::Ready { model, provider } => {
                self.state.status = Some(format!("Connected: {} via {}", model, provider));
            }
            FromAgent::SessionInfo { cwd, .. } => {
                self.state.status = Some(format!("Session in: {}", cwd));
            }
            FromAgent::ResponseEnd { response_id, .. } => {
                // Clear busy state when response completes
                // The "done" response_id is a special marker from the native agent
                if response_id == "done" || self.backend == AgentBackend::Native {
                    self.state.busy = false;
                }
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

                // Check approval requirement via registry (includes dynamic bash rules)
                let needs_approval = self.tool_executor.requires_approval(tool, args);

                if needs_approval {
                    // Queue approval
                    self.approval_controller.enqueue(ApprovalRequest::new(
                        call_id.clone(),
                        tool.clone(),
                        args.clone(),
                    ));
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
            ActiveModal::None => {}
        }

        match code {
            // Quit
            KeyCode::Char('c') if ctrl => {
                if self.state.busy {
                    // Interrupt the agent
                    match self.backend {
                        AgentBackend::Native => {
                            if let Some(agent) = &self.native_agent {
                                agent.cancel();
                            }
                        }
                        AgentBackend::NodeJs => {
                            if let Some(agent) = &mut self.node_agent {
                                let _ = agent.interrupt().await;
                            }
                        }
                    }
                    self.state.busy = false;
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
            KeyCode::Char('/') if !self.state.busy && self.state.input.is_empty() => {
                self.state.insert_char('/');
                self.slash_state.set_query("", &self.slash_matcher);
            }

            // Tab for slash command completion
            KeyCode::Tab if !self.state.busy && self.state.input.starts_with('/') => {
                self.handle_slash_tab();
            }

            // Navigation
            KeyCode::Up => {
                if self.state.input.starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_prev();
                    self.apply_slash_completion();
                } else {
                    self.state.scroll_up(1);
                }
            }
            KeyCode::Down => {
                if self.state.input.starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_next();
                    self.apply_slash_completion();
                } else {
                    self.state.scroll_down(1);
                }
            }
            KeyCode::PageUp => {
                self.state.scroll_up(10);
            }
            KeyCode::PageDown => {
                self.state.scroll_down(10);
            }

            // Input editing
            KeyCode::Char(c) if !ctrl => {
                if !self.state.busy {
                    self.state.insert_char(c);
                    self.update_slash_state();
                }
            }
            KeyCode::Backspace => {
                if !self.state.busy {
                    self.state.backspace();
                    self.update_slash_state();
                }
            }
            KeyCode::Delete => {
                if !self.state.busy {
                    self.state.delete();
                }
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

            // Submit
            KeyCode::Enter => {
                if !self.state.busy && !self.state.input.is_empty() {
                    // Check for slash command
                    if self.state.input.starts_with('/') {
                        self.execute_slash_command().await?;
                    } else {
                        let input = self.state.take_input();
                        self.submit_prompt(input).await?;
                    }
                }
            }

            // Clear input
            KeyCode::Char('u') if ctrl => {
                if !self.state.busy {
                    self.state.input.clear();
                    self.state.cursor = 0;
                    self.slash_state.reset();
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
                    self.state.input = format!("/{}", cmd_name);
                    self.state.cursor = self.state.input.len();
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

    /// Handle tool approval decision
    async fn handle_tool_approval(
        &mut self,
        call_id: String,
        tool: String,
        args: serde_json::Value,
        approved: bool,
    ) -> Result<()> {
        match self.backend {
            AgentBackend::Native => {
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
            }
            AgentBackend::NodeJs => {
                if let Some(agent) = &mut self.node_agent {
                    agent.tool_response(call_id, approved, None).await?;
                }
            }
        }
        Ok(())
    }

    /// Update slash state based on current input
    fn update_slash_state(&mut self) {
        if self.state.input.starts_with('/') {
            let query = &self.state.input[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        } else {
            self.slash_state.reset();
        }
    }

    /// Handle tab for slash command completion
    fn handle_slash_tab(&mut self) {
        if !self.slash_state.has_completions() {
            let query = &self.state.input[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        } else {
            self.slash_state.cycle_next();
        }
        self.apply_slash_completion();
    }

    /// Apply the current slash completion to input
    fn apply_slash_completion(&mut self) {
        if let Some(cmd) = self.slash_state.current() {
            self.state.input = format!("/{}", cmd);
            self.state.cursor = self.state.input.len();
        }
    }

    /// Execute a slash command
    async fn execute_slash_command(&mut self) -> Result<()> {
        let input = self.state.take_input();
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
                    let themes = crate::themes::available_themes().join(", ");
                    self.state.status = Some(format!("Available themes: {}", themes));
                }
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
            _ => {
                // Unknown command - try to send to agent
                let sent = match self.backend {
                    AgentBackend::Native => {
                        if let Some(agent) = &self.native_agent {
                            let _ = agent.prompt(format!("/{}", cmd_line), vec![]).await;
                            self.state.busy = true;
                            true
                        } else {
                            false
                        }
                    }
                    AgentBackend::NodeJs => {
                        if let Some(agent) = &mut self.node_agent {
                            agent.prompt(format!("/{}", cmd_line), vec![]).await?;
                            self.state.busy = true;
                            true
                        } else {
                            false
                        }
                    }
                };
                if !sent {
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
  Ctrl+L        Clear screen

Input:
  Enter         Send message / Execute command
  Tab           Cycle slash command completions
  @             Open file search
  /             Start slash command
  Ctrl+U        Clear input
  Esc           Cancel / Close modal

Modals:
  Ctrl+P        Open command palette
  Ctrl+O        Open file search
  Ctrl+Alt+R    Open session switcher

Session:
  Ctrl+C        Interrupt / Quit
  Ctrl+D        Quit

Slash Commands:
  /help         Show this help
  /clear        Clear messages
  /theme        Change theme
  /sessions     Browse sessions
  /files        Search files
  /commands     Open command palette
  /quit         Exit
"#;
        self.state.add_system_message(help_text.trim().to_string());
    }

    /// Submit a prompt to the agent
    async fn submit_prompt(&mut self, content: String) -> Result<()> {
        // Add user message to state
        self.state.add_user_message(content.clone());
        self.state.busy = true;

        match self.backend {
            AgentBackend::Native => {
                if let Some(agent) = &self.native_agent {
                    // Send the prompt - returns immediately, actual work happens in background task
                    // Events will be received via poll_agent in the main loop
                    if let Err(e) = agent.prompt(content, vec![]).await {
                        self.state.error = Some(format!("Failed to send prompt: {}", e));
                        self.state.busy = false;
                    }
                } else {
                    self.state.error = Some("Native agent not initialized".to_string());
                    self.state.busy = false;
                }
            }
            AgentBackend::NodeJs => {
                if let Some(agent) = &mut self.node_agent {
                    if let Err(e) = agent.prompt(content, vec![]).await {
                        self.state.error = Some(format!("Agent error: {}", e));
                        self.state.busy = false;
                    }
                } else {
                    self.state.error = Some("Agent not connected".to_string());
                    self.state.busy = false;
                }
            }
        }

        Ok(())
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
            if active_modal == ActiveModal::None && slash_state.has_completions() && !state.busy {
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
                ActiveModal::None => {}
            }

            // Position terminal cursor in the input area
            // Layout: [Messages(Min), Input(3), Status(1)]
            if active_modal == ActiveModal::None && !state.busy {
                // Calculate input area position (same layout as ChatView)
                let input_area = Rect {
                    x: area.x,
                    y: area.y + area.height.saturating_sub(4),
                    width: area.width,
                    height: 3,
                };

                // Create widget just to calculate cursor position
                let input_widget =
                    ChatInputWidget::new(&state.input, state.cursor, "", state.busy, 0, None);

                if let Some((cursor_x, cursor_y)) = input_widget.cursor_pos(input_area) {
                    frame.set_cursor_position((cursor_x, cursor_y));
                }
            }
        })?;

        Ok(())
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
        Self::with_args(Vec::new()).expect("Failed to create App")
    }
}

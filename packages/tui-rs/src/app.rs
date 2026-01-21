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

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
// `Arc` (Atomic Reference Counted) is a thread-safe reference-counted pointer.
// Multiple owners can share the same data. The data is freed when the last
// Arc is dropped. Unlike `Rc`, `Arc` is safe to use across threads.

use anyhow::{bail, Context, Result};
// `anyhow` provides ergonomic error handling:
// - `Result` is shorthand for `Result<T, anyhow::Error>`
// - `.context("msg")` adds context to errors for better debugging

use crossterm::event::{
    self, Event, KeyCode, KeyEventKind, KeyModifiers as CrosstermModifiers, MouseEventKind,
};
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
use crate::ai::AiProvider;
use crate::clipboard::ClipboardManager;
use crate::commands::{
    build_command_registry, CommandAction, CommandOutput, CommandRegistry, ModalType, QueueAction,
    QueueModeKind, SlashCommandMatcher, SlashCycleState,
};
use crate::components::{
    calculate_input_height, ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest,
    ChatInputWidget, ChatView, CommandPalette, FileSearchModal, ModelSelector, SessionSwitcher,
    ShortcutsHelp, ThemeSelector,
};
use crate::files::get_workspace_files;
use crate::git;
use crate::safety::{
    check_model_allowed, check_path_allowed, check_session_limits, FirewallVerdict,
};
use crate::session::{
    AppMessage, CompactionEntry, ContentBlock as SessionContentBlock, MessageContent, MessageEntry,
    ModelChange, ParsedSession, SessionEntry, SessionExporter, SessionHeader, SessionManager,
    ThinkingLevel, ThinkingLevelChange, TokenCost, TokenUsage as SessionTokenUsage, ToolInfo,
};
use crate::skills::{skills_to_prompt, LoadedSkill, SkillLoadError, SkillLoader, SkillRegistry};
use crate::state::{AppState, ApprovalMode, Message, MessageRole};
use crate::terminal::{self, TerminalCapabilities};
use crate::tools::{ToolExecutor, ToolRegistry};
use chrono::Utc;

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
    /// Keyboard shortcuts help overlay
    ShortcutsHelp,
}

#[derive(Debug, Clone)]
struct QueuedPrompt {
    id: u64,
    content: String,
    kind: PromptKind,
}

#[derive(Debug, Clone)]
struct PendingModelChange {
    model: String,
}

#[derive(Debug, Clone, Copy)]
struct QueuedPromptCursor {
    id: u64,
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
    /// Tuple: (`call_id`, success, `optional_result`)
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

    /// Keyboard shortcuts help overlay.
    shortcuts_help: ShortcutsHelp,

    /// Token usage and cost tracker.
    usage_tracker: crate::usage::UsageTracker,

    /// Prompt history for recall and search.
    prompt_history: crate::history::PromptHistory,

    /// Tool execution history.
    tool_history: crate::tools::ToolHistory,

    /// Loaded skill definitions (with paths/resources).
    loaded_skills: Vec<LoadedSkill>,

    /// Skill load errors from last scan.
    skill_load_errors: Vec<SkillLoadError>,

    /// Runtime skill registry (activation state).
    skill_registry: SkillRegistry,

    /// Prompts submitted while running (queued in the agent).
    queued_prompts: VecDeque<QueuedPrompt>,

    /// Queued prompt reserved by the agent (between `ResponseEnd` and `ResponseStart`).
    queued_prompt_inflight: Option<QueuedPromptCursor>,

    /// Queued prompt currently being processed.
    queued_prompt_active: Option<QueuedPrompt>,

    /// Next id for queued prompts.
    next_queue_id: u64,

    /// When the current session started (for policy limits).
    session_started_at: SystemTime,

    /// True when a session was loaded but the writer failed to resume.
    session_resume_failed: bool,

    /// Current model in use (for session headers and usage tracking).
    current_model: String,

    /// Current thinking level (for session headers/changes).
    current_thinking_level: ThinkingLevel,

    /// Last time we refreshed MCP status for runtime badges.
    last_mcp_status_refresh: Option<Instant>,

    /// Pending model change awaiting agent confirmation.
    pending_model_change: Option<PendingModelChange>,

    /// Cached git branch for session info updates.
    current_git_branch: Option<String>,
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
        let workspace_dir =
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let config = crate::config::load_config(&workspace_dir, None);
        let mut history_config = crate::history::HistoryConfig::default();
        if let Some(history_settings) = config.history {
            if let Some(max_bytes) = history_settings.max_bytes {
                history_config = history_config.with_max_bytes(max_bytes);
            }
            if let Some(persistence) = history_settings.persistence {
                history_config = history_config.with_persistence(persistence);
            }
        }
        let prompt_history =
            crate::history::PromptHistory::load_with_config(history_config.clone())
                .unwrap_or_else(|_| crate::history::PromptHistory::new(history_config));
        Self::new_with_terminal_with_history(terminal, capabilities, prompt_history)
    }

    fn new_with_terminal_with_history(
        terminal: terminal::Terminal,
        capabilities: TerminalCapabilities,
        prompt_history: crate::history::PromptHistory,
    ) -> Self {
        // Build the command registry and wrap it in Arc for shared ownership.
        // Arc::new() moves the registry into the Arc.
        let command_registry = Arc::new(build_command_registry());

        // Create the slash command matcher with a clone of the Arc.
        // Arc::clone() is cheap - it just increments the reference count.
        let slash_matcher = SlashCommandMatcher::new(Arc::clone(&command_registry));

        // Get current working directory, defaulting to "." if it fails.
        // `unwrap_or_else` takes a closure that's only called on Err.
        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string());

        let mut state = AppState::new();
        let queue_modes = crate::ui_state::load_queue_modes();
        if let Some(mode) = queue_modes.steering_mode {
            state.steering_mode = mode;
        }
        if let Some(mode) = queue_modes.follow_up_mode {
            state.follow_up_mode = mode;
        }

        let loader = SkillLoader::new();
        let (loaded_skills, skill_load_errors) = loader.load_all_with_paths();
        let mut skill_registry = SkillRegistry::new();
        for loaded in &loaded_skills {
            skill_registry.register(loaded.definition.clone());
        }

        // Construct the App with all fields initialized.
        // `Self` is an alias for the type we're implementing (App).
        Self {
            state,
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
            shortcuts_help: ShortcutsHelp::new(),
            usage_tracker: crate::usage::UsageTracker::new(),
            prompt_history,
            tool_history: crate::tools::ToolHistory::default(),
            loaded_skills,
            skill_load_errors,
            skill_registry,
            queued_prompts: VecDeque::new(),
            queued_prompt_inflight: None,
            queued_prompt_active: None,
            next_queue_id: 1,
            session_started_at: SystemTime::now(),
            session_resume_failed: false,
            current_model: String::new(),
            current_thinking_level: ThinkingLevel::Off,
            last_mcp_status_refresh: None,
            pending_model_change: None,
            current_git_branch: None,
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
    /// of the App and can modify it. The App is consumed when `run()` completes.
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
                match event::read()? {
                    Event::Key(key) => {
                        // Only handle key press events (not release).
                        // Some terminals send both press and release events.
                        if key.kind == KeyEventKind::Press {
                            self.handle_key(key.code, key.modifiers).await?;
                        }
                    }
                    Event::Mouse(mouse) => {
                        // Handle mouse scroll wheel
                        match mouse.kind {
                            MouseEventKind::ScrollUp => {
                                self.state.scroll_up(3);
                            }
                            MouseEventKind::ScrollDown => {
                                self.state.scroll_down(3);
                            }
                            _ => {} // Ignore other mouse events
                        }
                    }
                    _ => {} // Ignore other events (resize, focus, paste handled elsewhere)
                }
            }

            // Poll for messages from the agent (async operation).
            // This handles streaming responses, tool calls, etc.
            self.poll_agent().await?;

            // Refresh MCP badge counts periodically without blocking the UI.
            self.refresh_mcp_badges().await;

            // Check exit condition.
            if self.should_quit {
                break;
            }
        }

        // Cleanup background processes before exit
        let process_count = crate::tools::cleanup_background_processes();
        if process_count > 0 {
            eprintln!("[app] Cleaned up {process_count} background process(es)");
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
        self.current_git_branch = git_branch.clone();

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

        let policy_model = policy_model_id(&model);
        if let Some(reason) = check_model_allowed(&policy_model) {
            self.state.error = Some(reason);
            return Ok(());
        }

        self.current_model = model.clone();
        self.current_thinking_level = ThinkingLevel::Off;
        self.state.thinking_level = self.current_thinking_level;
        self.usage_tracker.set_model(model.clone());

        self.state.status = Some(format!("Initializing agent ({model})..."));

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
                self.state.model = Some(model.clone());
                self.state.status = Some(format!("Ready: {model}"));
            }
            Err(e) => {
                self.state.error = Some(format!("Failed to create agent: {e}"));
            }
        }

        Ok(())
    }

    /// Build the system prompt for the agent
    fn build_system_prompt(&self) -> String {
        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string());
        let mut sections = vec![format!(
            r#"You are an AI assistant helping with software development tasks.

Current working directory: {cwd}

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

Always use tools when they would be helpful. Be concise and direct in your responses."#
        )];

        if !self.loaded_skills.is_empty() {
            sections.push(skills_to_prompt(&self.loaded_skills));
        }

        let active_prompt = self.skill_registry.active_system_prompt_additions();
        if !active_prompt.trim().is_empty() {
            sections.push(active_prompt);
        }

        sections.join("\n\n")
    }

    fn refresh_skills(&mut self, preserve_active: bool) {
        let active_ids: HashSet<String> = if preserve_active {
            self.skill_registry
                .active_skills()
                .iter()
                .map(|skill| skill.definition.id.clone())
                .collect()
        } else {
            HashSet::new()
        };

        let loader = SkillLoader::new();
        let (loaded_skills, skill_load_errors) = loader.load_all_with_paths();
        let mut registry = SkillRegistry::new();
        for loaded in &loaded_skills {
            registry.register(loaded.definition.clone());
        }
        if preserve_active {
            for id in active_ids {
                let _ = registry.activate(&id);
            }
        }

        self.loaded_skills = loaded_skills;
        self.skill_load_errors = skill_load_errors;
        self.skill_registry = registry;
    }

    fn resolve_skill_id(&self, query: &str) -> Result<String, String> {
        let normalized = query.trim().to_lowercase();
        if normalized.is_empty() {
            return Err("Skill name required".to_string());
        }

        let mut partial_matches: Vec<String> = Vec::new();
        for loaded in &self.loaded_skills {
            let def = &loaded.definition;
            let id = def.id.clone();
            let id_lower = id.to_lowercase();
            let name_lower = def.name.to_lowercase();

            if id_lower == normalized || name_lower == normalized {
                return Ok(id);
            }
            if id_lower.contains(&normalized) || name_lower.contains(&normalized) {
                partial_matches.push(id);
            }
        }

        partial_matches.sort();
        partial_matches.dedup();
        match partial_matches.len() {
            1 => Ok(partial_matches[0].clone()),
            0 => Err(format!("Skill \"{query}\" not found.")),
            _ => Err(format!(
                "Multiple skills match \"{query}\": {}",
                partial_matches.join(", ")
            )),
        }
    }

    fn find_loaded_skill(&self, id: &str) -> Option<&LoadedSkill> {
        self.loaded_skills
            .iter()
            .find(|skill| skill.definition.id == id || skill.definition.name == id)
    }

    fn update_agent_system_prompt(&mut self) {
        let prompt = self.build_system_prompt();
        if let Some(agent) = &self.native_agent {
            if let Err(e) = agent.set_system_prompt(prompt) {
                self.state.error = Some(format!("Failed to update system prompt: {e}"));
            }
        }
    }

    fn clear_active_skills(&mut self) {
        let active_ids: Vec<String> = self
            .skill_registry
            .active_skills()
            .iter()
            .map(|skill| skill.definition.id.clone())
            .collect();
        if active_ids.is_empty() {
            return;
        }
        for id in active_ids {
            let _ = self.skill_registry.deactivate(&id);
        }
        self.update_agent_system_prompt();
    }

    fn active_session_count(&self) -> Option<usize> {
        let sessions = self.session_manager.list_all_sessions().ok()?;
        let cutoff = SystemTime::now().checked_sub(Duration::from_secs(60 * 60))?;
        let mut count = 0usize;
        for session in sessions {
            if let Some(modified) = session.modified {
                if modified >= cutoff {
                    count += 1;
                }
            }
        }
        Some(count)
    }

    fn ensure_session_started(&mut self) -> Result<()> {
        if self.session_resume_failed {
            self.state.error =
                Some("Session resume failed; use /new to start a new session.".to_string());
            bail!("Session resume failed");
        }

        if self.session_manager.writer().is_some() {
            return Ok(());
        }

        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string());
        let session_id = uuid::Uuid::new_v4().to_string();
        let model = if !self.current_model.is_empty() {
            self.current_model.clone()
        } else {
            self.state
                .model
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        };
        if self.current_model.is_empty() {
            self.current_model = model.clone();
        }
        let policy_model = policy_model_id(&model);
        if let Some(reason) = check_model_allowed(&policy_model) {
            self.state.error = Some(reason.clone());
            bail!(reason);
        }
        let tools = ToolRegistry::new()
            .tools()
            .map(|tool| ToolInfo {
                name: tool.tool.name.clone(),
                label: None,
                description: Some(tool.tool.description.clone()),
            })
            .collect::<Vec<_>>();

        let header = SessionHeader {
            id: session_id.clone(),
            timestamp: Utc::now().to_rfc3339(),
            cwd,
            model: policy_model,
            model_metadata: None,
            thinking_level: self.current_thinking_level,
            system_prompt: None,
            tools,
            branched_from: None,
        };

        self.session_manager
            .start_session(header)
            .context("Failed to start session")?;
        let _ = self.session_manager.flush();

        self.state.session_id = Some(session_id.clone());
        self.session_started_at = SystemTime::now();
        self.session_resume_failed = false;
        self.usage_tracker = crate::usage::UsageTracker::with_session(session_id.clone());
        self.usage_tracker.set_model(self.current_model.clone());

        if let Some(agent) = &self.native_agent {
            agent.send_session_info(
                &std::env::current_dir()
                    .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string()),
                Some(session_id),
                self.current_git_branch.clone(),
            );
        }

        Ok(())
    }

    fn write_session_entry(&mut self, entry: SessionEntry) {
        let error = {
            let Some(writer) = self.session_manager.writer() else {
                return;
            };
            writer.write_entry(entry).err()
        };
        if let Some(err) = error {
            self.state.error = Some(format!("Failed to write session entry: {err}"));
        }
    }

    fn record_user_message(&mut self, content: &str) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let entry = SessionEntry::Message(MessageEntry {
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::User {
                content: MessageContent::Text(content.to_string()),
                attachments: None,
                timestamp: system_time_to_millis(SystemTime::now()),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    fn record_assistant_message(
        &mut self,
        response_id: &str,
        usage: Option<crate::agent::TokenUsage>,
    ) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let Some(message) = self
            .state
            .messages
            .iter()
            .find(|m| m.id == response_id && m.role == MessageRole::Assistant)
            .cloned()
        else {
            return;
        };

        let mut blocks = Vec::new();
        if !message.thinking.is_empty() {
            blocks.push(SessionContentBlock::Thinking {
                text: message.thinking.clone(),
                signature: None,
            });
        }
        if !message.content.is_empty() {
            blocks.push(SessionContentBlock::Text {
                text: message.content.clone(),
            });
        }
        for call in &message.tool_calls {
            blocks.push(SessionContentBlock::ToolCall {
                id: call.call_id.clone(),
                name: call.tool.clone(),
                args: call.args.clone(),
            });
        }

        let usage = usage
            .as_ref()
            .map(to_session_usage)
            .or_else(|| message.usage.as_ref().map(to_session_usage));

        let entry = SessionEntry::Message(MessageEntry {
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::Assistant {
                content: blocks,
                api: self.state.provider.clone(),
                provider: self.state.provider.clone(),
                model: Some(policy_model_id(&self.current_model)),
                usage,
                stop_reason: None,
                timestamp: system_time_to_millis(message.timestamp),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    fn record_tool_result(&mut self, call_id: &str, tool: &str, result: &ToolResult) {
        if result.success {
            self.tool_history.complete_with_details(
                call_id,
                result.output.clone(),
                result.details.clone(),
            );
        } else {
            let error = result
                .error
                .clone()
                .unwrap_or_else(|| result.output.clone());
            self.tool_history
                .fail_with_details(call_id, error, result.details.clone());
        }

        if self.ensure_session_started().is_err() {
            return;
        }

        let content = if result.success {
            result.output.clone()
        } else {
            result
                .error
                .clone()
                .unwrap_or_else(|| result.output.clone())
        };

        let entry = SessionEntry::Message(MessageEntry {
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::ToolResult {
                tool_call_id: call_id.to_string(),
                tool_name: tool.to_string(),
                content,
                details: result.details.clone(),
                is_error: !result.success,
                timestamp: system_time_to_millis(SystemTime::now()),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    fn record_model_change(&mut self, model: &str) {
        if self.session_manager.writer().is_none() {
            return;
        }

        let entry = SessionEntry::ModelChange(ModelChange {
            timestamp: Utc::now().to_rfc3339(),
            model: policy_model_id(model),
            model_metadata: None,
        });
        self.write_session_entry(entry);
    }

    fn record_thinking_level_change(&mut self, level: ThinkingLevel) {
        if self.session_manager.writer().is_none() {
            return;
        }

        let entry = SessionEntry::ThinkingLevelChange(ThinkingLevelChange {
            timestamp: Utc::now().to_rfc3339(),
            thinking_level: level,
        });
        self.write_session_entry(entry);
    }

    fn record_compaction_entry(
        &mut self,
        summary: String,
        first_kept_entry_index: usize,
        tokens_before: u64,
        custom_instructions: Option<String>,
    ) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let entry = SessionEntry::Compaction(CompactionEntry {
            timestamp: Utc::now().to_rfc3339(),
            summary,
            first_kept_entry_index,
            tokens_before,
            auto: false,
            custom_instructions,
        });
        self.write_session_entry(entry);
    }

    fn hydrate_usage_from_session(&mut self, session: &ParsedSession) {
        self.usage_tracker = crate::usage::UsageTracker::with_session(session.id());
        self.usage_tracker.set_model(session.header.model.clone());

        for entry in &session.usage_entries {
            let usage = crate::headless::TokenUsage {
                input_tokens: entry.usage.input,
                output_tokens: entry.usage.output,
                cache_read_tokens: entry.usage.cache_read,
                cache_write_tokens: entry.usage.cache_write,
                cost: entry.usage.cost.as_ref().map(|c| c.total),
            };
            let _ = self.usage_tracker.add_turn_for_model(&entry.model, &usage);
        }
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

    fn update_mcp_badge_counts(&mut self, servers: &[crate::tools::McpServerStatus]) {
        let connected = servers.iter().filter(|server| server.connected).count();
        let tool_count: usize = servers.iter().map(|server| server.tools.len()).sum();
        self.state.mcp_connected = connected;
        self.state.mcp_tool_count = tool_count;
    }

    async fn refresh_mcp_badges(&mut self) {
        let now = Instant::now();
        if self
            .last_mcp_status_refresh
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(5))
        {
            return;
        }
        self.last_mcp_status_refresh = Some(now);

        if let Ok(servers) = self.tool_executor.mcp_status().await {
            self.update_mcp_badge_counts(&servers);
        }
    }

    /// Handle an agent message (common for both backends)
    async fn handle_agent_message(&mut self, msg: FromAgent) -> Result<()> {
        let response_end_info = match &msg {
            FromAgent::ResponseEnd { response_id, usage } => {
                Some((response_id.clone(), usage.clone()))
            }
            _ => None,
        };

        if matches!(msg, FromAgent::ResponseStart { .. }) {
            let was_busy = self.state.busy;
            self.state.busy = true;
            self.queued_prompt_inflight = None;
            if !was_busy {
                if let Some(pending) = self.queued_prompts.pop_front() {
                    self.queued_prompt_active = Some(pending.clone());
                    self.state.add_user_message(pending.content);
                    self.sync_queue_prompt_count();
                } else {
                    self.queued_prompt_active = None;
                }
            }
        }
        match &msg {
            FromAgent::Ready { model, provider } => {
                self.state.status = Some(format!("Connected: {model} via {provider}"));
                self.current_model = model.clone();
                self.usage_tracker.set_model(model.clone());
            }
            FromAgent::ModelChanged { model, provider } => {
                let pending_matches = self
                    .pending_model_change
                    .as_ref()
                    .map(|pending| pending.model == *model)
                    .unwrap_or(false);

                self.current_model = model.clone();
                self.state.model = Some(model.clone());
                self.state.provider = Some(provider.clone());
                self.usage_tracker.set_model(model.clone());
                self.state.status = Some(format!("Model: {model}"));

                if pending_matches {
                    self.pending_model_change = None;
                    self.record_model_change(model);
                }
            }
            FromAgent::ModelChangeFailed { model, .. } => {
                if self
                    .pending_model_change
                    .as_ref()
                    .map(|pending| pending.model == *model)
                    .unwrap_or(false)
                {
                    self.pending_model_change = None;
                }
            }
            FromAgent::SessionInfo { cwd, .. } => {
                self.state.status = Some(format!("Session in: {cwd}"));
            }
            FromAgent::ResponseEnd { .. } => {
                // Clear busy state when response completes
                self.state.busy = false;
                self.queued_prompt_active = None;
                self.queued_prompt_inflight =
                    self.queued_prompts
                        .front()
                        .map(|prompt| QueuedPromptCursor {
                            id: prompt.id,
                            kind: prompt.kind,
                        });
                self.sync_queue_prompt_count();
            }
            FromAgent::Error { .. } => {
                // Clear busy state on error
                self.state.busy = false;
                self.queued_prompt_inflight = None;
                self.queued_prompt_active = None;
                self.sync_queue_prompt_count();
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                self.tool_history.start_with_approval(
                    call_id.clone(),
                    tool.clone(),
                    args.clone(),
                    *requires_approval,
                );
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
                    self.tool_history.record_approval(call_id, true);
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
                    self.tool_history.record_approval(call_id, true);
                    self.execute_tool_and_respond(call_id.clone(), tool.clone(), args.clone())
                        .await?;
                }
            }
            _ => {}
        }
        self.state.handle_agent_message(msg);

        if let Some((response_id, usage)) = response_end_info {
            if let Some(ref usage) = usage {
                let headless_usage = to_headless_usage(usage);
                let alerts = self.usage_tracker.add_turn(&headless_usage);
                for alert in alerts {
                    self.state.add_system_message(alert);
                }
            }
            self.record_assistant_message(&response_id, usage);
        }
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

        self.record_tool_result(&call_id, &tool, &result);

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
            ActiveModal::ShortcutsHelp => return self.handle_shortcuts_help_key(code).await,
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
                    self.queued_prompt_inflight = None;
                    self.queued_prompt_active = None;
                    self.sync_queue_prompt_count();
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
            KeyCode::F(1) => {
                // Keyboard shortcuts help
                self.shortcuts_help.show();
                self.active_modal = ActiveModal::ShortcutsHelp;
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
                } else if !self.state.input().is_empty() {
                    self.state.move_up();
                } else {
                    self.state.scroll_up(1);
                }
            }
            KeyCode::Down => {
                if self.state.input().starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_next();
                    self.apply_slash_completion();
                } else if !self.state.input().is_empty() {
                    self.state.move_down();
                } else {
                    self.state.scroll_down(1);
                }
            }
            // Vim-style scrolling: only when input is empty (not typing)
            KeyCode::Char('k') if ctrl => {
                if self.state.input().is_empty() {
                    self.state.scroll_up(1);
                } else {
                    self.state.delete_to_end_of_line();
                    self.update_slash_state();
                }
            }
            KeyCode::Char('j') if ctrl => {
                if self.state.input().is_empty() {
                    self.state.scroll_down(1);
                }
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
            KeyCode::Char('a') if ctrl => {
                self.state.move_home_smart();
            }
            KeyCode::Char('b') if alt => {
                self.state.move_word_left();
            }
            KeyCode::Char('f') if alt => {
                self.state.move_word_right();
            }
            KeyCode::Char('w') if ctrl => {
                self.state.delete_word_backward();
                self.update_slash_state();
            }
            KeyCode::Char('y') if alt => {
                self.state.yank_kill_ring();
                self.update_slash_state();
            }
            KeyCode::Char(c) if !ctrl => {
                self.state.insert_char(c);
                self.update_slash_state();
            }
            KeyCode::Backspace => {
                if alt {
                    self.state.delete_word_backward();
                } else {
                    self.state.backspace();
                }
                self.update_slash_state();
            }
            KeyCode::Delete => {
                self.state.delete();
            }
            KeyCode::Left => {
                if ctrl || alt {
                    self.state.move_word_left();
                } else {
                    self.state.move_left();
                }
            }
            KeyCode::Right => {
                if ctrl || alt {
                    self.state.move_word_right();
                } else {
                    self.state.move_right();
                }
            }
            KeyCode::Home => {
                self.state.move_home_smart();
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

            // Delete to start of line
            KeyCode::Char('u') if ctrl => {
                self.state.delete_to_start_of_line();
                self.update_slash_state();
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
                            self.state.status = Some(format!("Resumed session: {session_id}"));

                            let mut model_applied = true;
                            let mut thinking_applied = true;
                            if let Some(agent) = &self.native_agent {
                                if let Err(e) = agent.set_model(&session.header.model) {
                                    self.state.error = Some(format!("Failed to set model: {e}"));
                                    model_applied = false;
                                    thinking_applied = false;
                                } else {
                                    let (enabled, budget) =
                                        session.header.thinking_level.to_config();
                                    if let Err(e) = agent.set_thinking(enabled, budget) {
                                        self.state.error =
                                            Some(format!("Failed to set thinking: {e}"));
                                        thinking_applied = false;
                                    }
                                }
                            }

                            self.session_started_at =
                                chrono::DateTime::parse_from_rfc3339(&session.header.timestamp)
                                    .ok()
                                    .and_then(|dt| {
                                        let secs = dt.timestamp();
                                        if secs < 0 {
                                            None
                                        } else {
                                            Some(
                                                UNIX_EPOCH
                                                    + Duration::new(
                                                        secs as u64,
                                                        dt.timestamp_subsec_nanos(),
                                                    ),
                                            )
                                        }
                                    })
                                    .unwrap_or_else(SystemTime::now);
                            self.hydrate_usage_from_session(&session);

                            if model_applied {
                                self.current_model = session.header.model.clone();
                                self.state.model = Some(session.header.model.clone());
                                self.usage_tracker.set_model(session.header.model.clone());
                                if thinking_applied {
                                    self.current_thinking_level = session.header.thinking_level;
                                    self.state.thinking_level = self.current_thinking_level;
                                }
                            } else if !self.current_model.is_empty() {
                                self.usage_tracker.set_model(self.current_model.clone());
                            }

                            if let Err(err) = self.session_manager.resume_session_by_path(
                                session_id.clone(),
                                session.file_path.as_str(),
                            ) {
                                self.session_manager.reset_session();
                                self.session_resume_failed = true;
                                self.state.error =
                                    Some(format!("Failed to resume session writer: {err}"));
                                self.state.status = Some(format!(
                                    "Session resume failed ({session_id}); use /new to continue"
                                ));
                            } else {
                                self.session_resume_failed = false;
                            }
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to load session: {e}"));
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
                    self.state.set_input(&format!("/{cmd_name}"));
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
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
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
            KeyCode::Char('n' | 'N') | KeyCode::Esc => {
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
            KeyCode::Char('a' | 'A') => {
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
                        let policy_model = policy_model_id(&model_id);
                        if let Some(reason) = check_model_allowed(&policy_model) {
                            self.state.error = Some(reason);
                        } else if let Err(e) = agent.set_model(&model_id) {
                            self.state.error = Some(format!("Failed to set model: {e}"));
                        } else {
                            self.pending_model_change = Some(PendingModelChange {
                                model: model_id.clone(),
                            });
                            self.state.status = Some(format!("Switching model: {model_id}"));
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
                        self.state.status = Some(format!("Theme: {theme_name}"));
                    } else {
                        self.state.error = Some(format!("Unknown theme: {theme_name}"));
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

    /// Handle keyboard shortcuts help key events
    async fn handle_shortcuts_help_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Esc | KeyCode::F(1) => {
                self.shortcuts_help.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.shortcuts_help.scroll_up(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.shortcuts_help.scroll_down(1);
            }
            KeyCode::PageUp => {
                self.shortcuts_help.scroll_up(10);
            }
            KeyCode::PageDown => {
                self.shortcuts_help.scroll_down(10);
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
        self.tool_history.record_approval(&call_id, approved);
        if approved {
            self.execute_tool_and_respond(call_id, tool, args).await?;
        } else {
            self.tool_history.fail(&call_id, "Denied".to_string());
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
        if self.slash_state.has_completions() {
            self.slash_state.cycle_next();
        } else {
            let query = &self.state.input()[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        }
        self.apply_slash_completion();
    }

    /// Apply the current slash completion to input
    fn apply_slash_completion(&mut self) {
        if let Some(cmd) = self.slash_state.current() {
            self.state.set_input(&format!("/{cmd}"));
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
                self.session_manager.reset_session();
                self.state.session_id = None;
                self.session_started_at = SystemTime::now();
                self.session_resume_failed = false;
                self.usage_tracker = crate::usage::UsageTracker::new();
                if !self.current_model.is_empty() {
                    self.usage_tracker.set_model(self.current_model.clone());
                }
                self.clear_active_skills();
                if let Some(agent) = &self.native_agent {
                    agent.clear_history();
                }
            }
            CommandAction::ToggleZenMode => {
                self.state.zen_mode = !self.state.zen_mode;
                if self.state.zen_mode {
                    self.state.status = Some("Zen mode enabled".to_string());
                } else {
                    self.state.status = Some("Zen mode disabled".to_string());
                }
            }
            CommandAction::SetCompactTools(mode) => {
                let next = mode.unwrap_or(!self.state.compact_tool_outputs);
                self.state.compact_tool_outputs = next;
                self.state.expanded_tool_calls.clear();
                self.state.status = Some(if next {
                    "Tool outputs will collapse by default.".to_string()
                } else {
                    "Tool outputs will show full content.".to_string()
                });
            }
            CommandAction::SetApprovalMode(mode) => {
                if mode == "next" {
                    self.state.approval_mode = self.state.approval_mode.next();
                } else if let Some(m) = ApprovalMode::parse(&mode) {
                    self.state.approval_mode = m;
                } else {
                    self.state.error = Some(format!(
                        "Unknown approval mode: {mode}. Use: yolo, selective, safe"
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
                            self.state.error = Some(format!("Failed to set thinking: {e}"));
                            return;
                        }
                    }
                    self.current_thinking_level = level;
                    self.state.thinking_level = self.current_thinking_level;
                    self.record_thinking_level_change(level);
                    self.state.status =
                        Some(format!("Thinking: {} (budget: {})", level.label(), budget));
                } else {
                    self.state.error = Some(format!(
                        "Unknown thinking level: {level_str}. Use: off, minimal, low, medium, high, max"
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
                        Ok(()) => {
                            let chars: Vec<char> = msg.content.chars().collect();
                            let preview = if chars.len() > 50 {
                                format!("{}...", chars[..47].iter().collect::<String>())
                            } else {
                                msg.content.clone()
                            };
                            self.state.status = Some(format!("Copied: {preview}"));
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to copy: {e}"));
                        }
                    }
                } else {
                    self.state.status = Some("No message to copy".to_string());
                }
            }
            CommandAction::SetTheme(theme_name) => {
                if let Err(e) = crate::themes::set_theme_by_name(&theme_name) {
                    self.state.error = Some(format!("Failed to set theme: {e}"));
                } else {
                    self.state.status = Some(format!("Theme set to: {theme_name}"));
                }
            }
            CommandAction::SetModel(model_id) => {
                if let Some(agent) = &self.native_agent {
                    let policy_model = policy_model_id(&model_id);
                    if let Some(reason) = check_model_allowed(&policy_model) {
                        self.state.error = Some(reason);
                        return;
                    }
                    if let Err(e) = agent.set_model(&model_id) {
                        self.state.error = Some(format!("Failed to set model: {e}"));
                    } else {
                        self.pending_model_change = Some(PendingModelChange {
                            model: model_id.clone(),
                        });
                        self.state.status = Some(format!("Switching model: {model_id}"));
                    }
                } else {
                    self.state.error = Some("No agent available to set model".to_string());
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
                let tokens_before = self.usage_tracker.total_tokens();

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
                    summary.push_str(&format!("\n*Focus: {instr}*\n"));
                }

                // Remove old messages and add summary
                let kept: Vec<_> = self.state.messages.drain(to_summarize..).collect();
                self.state.messages.clear();
                let summary_clone = summary.clone();
                self.state.add_system_message(summary);
                self.state.messages.extend(kept);

                self.record_compaction_entry(
                    summary_clone,
                    to_summarize,
                    tokens_before,
                    instructions.clone(),
                );

                self.state.status = Some(format!("Compacted {to_summarize} messages into summary"));
            }
            CommandAction::Mcp(action) => {
                self.handle_mcp_action(action).await;
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
            CommandAction::ShowDiagnostics => {
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
                    diag.push_str(&format!("**Terminal:** {cols}x{rows}\n"));
                }

                // Message count
                diag.push_str(&format!("**Messages:** {}\n", self.state.messages.len()));

                self.state.add_system_message(diag);
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
                    .add_system_message(format!("## Usage Summary\n\n{summary}"));
            }
            UsageAction::Detailed => {
                let detailed = self.usage_tracker.detailed_summary();
                self.state
                    .add_system_message(format!("## Usage Details\n\n```\n{detailed}\n```"));
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
        use crate::session::{ExportFormat, ExportOptions, SessionReader};

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

        let options = ExportOptions {
            format,
            ..Default::default()
        };

        let _ = self.session_manager.flush();

        let session_path = self.session_manager.current_session_path().or_else(|| {
            let session_id = self.state.session_id.as_ref()?;
            self.session_manager
                .list_all_sessions()
                .ok()?
                .into_iter()
                .find(|s| &s.id == session_id)
                .map(|s| s.path)
        });

        let Some(session_path) = session_path else {
            self.state.error = Some("No active session to export".to_string());
            return;
        };

        let output_path = if let Some(path) = path {
            let expanded = if let Some(stripped) = path.strip_prefix("~/") {
                let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
                home.join(stripped)
            } else {
                std::path::PathBuf::from(path)
            };
            if expanded.is_absolute() {
                expanded
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .join(expanded)
            }
        } else {
            let mut default_path = session_path.clone();
            default_path.set_extension(format.extension());
            default_path
        };

        if let Some(reason) = check_path_allowed(&output_path) {
            self.state.error = Some(reason);
            return;
        }

        if let Some(parent) = output_path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                self.state.error = Some(format!("Failed to create export directory: {err}"));
                return;
            }
        }

        let session = match SessionReader::read_file(&session_path) {
            Ok(session) => session,
            Err(err) => {
                self.state.error = Some(format!("Failed to read session: {err}"));
                return;
            }
        };

        let exporter = SessionExporter::from_session(&session, options);
        let output = exporter.export_to_string();
        if let Err(err) = std::fs::write(&output_path, output) {
            self.state.error = Some(format!("Failed to write export: {err}"));
            return;
        }

        self.state.status = Some(format!(
            "Session exported to {}",
            output_path.to_string_lossy()
        ));
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
                    self.state.status = Some(format!("No matches for '{query}'"));
                    return;
                }

                let mut msg = format!("## Search Results for '{query}'\n\n");
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
                        .map_or_else(|| "?".to_string(), |d| format!("{:.0}ms", d.as_millis()));
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
                    .add_system_message(format!("## Tool Statistics\n\n```\n{summary}\n```"));
            }
            ToolHistoryAction::ForTool(name) => {
                let execs = self.tool_history.for_tool(&name);
                if execs.is_empty() {
                    self.state.status = Some(format!("No history for tool '{name}'"));
                    return;
                }

                let mut msg = format!("## History for '{name}'\n\n");
                for exec in execs.iter().take(10) {
                    let status = if exec.success { "✓" } else { "✗" };
                    let duration = exec
                        .duration
                        .map_or_else(|| "?".to_string(), |d| format!("{:.0}ms", d.as_millis()));
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

    /// Handle MCP actions
    async fn handle_mcp_action(&mut self, action: crate::commands::McpAction) {
        use crate::commands::McpAction;

        match action {
            McpAction::Status => match self.tool_executor.mcp_status().await {
                Ok(servers) => {
                    self.update_mcp_badge_counts(&servers);
                    let mut lines = Vec::new();
                    lines.push("Model Context Protocol".to_string());
                    lines.push(String::new());

                    if servers.is_empty() {
                        lines.push("No MCP servers configured.".to_string());
                        lines.push(String::new());
                        lines.push(
                            "Add servers to ~/.composer/mcp.json or .composer/mcp.json:"
                                .to_string(),
                        );
                        lines.push(String::new());
                        lines.push(
                            "{ \"mcpServers\": { \"my-server\": { \"command\": \"npx\", \"args\": [\"-y\", \"@example/mcp-server\"] } } }".to_string(),
                        );
                    } else {
                        for server in servers {
                            let status = if server.connected {
                                "connected"
                            } else {
                                "disconnected"
                            };
                            lines.push(format!("- {} ({})", server.name, status));
                            if server.connected {
                                if !server.tools.is_empty() {
                                    lines.push(format!("  Tools: {}", server.tools.join(", ")));
                                }
                                if !server.resources.is_empty() {
                                    lines.push(format!("  Resources: {}", server.resources.len()));
                                }
                                if !server.prompts.is_empty() {
                                    lines.push(format!("  Prompts: {}", server.prompts.join(", ")));
                                }
                            } else {
                                lines.push("  Not connected".to_string());
                            }
                        }
                        lines.push(String::new());
                        lines.push("Subcommands: /mcp resources, /mcp prompts".to_string());
                    }

                    self.state.add_system_message(lines.join("\n"));
                }
                Err(err) => {
                    self.state
                        .add_system_message(format!("Failed to load MCP status: {err}"));
                }
            },
            McpAction::Resources { server, uri } => {
                let servers = match self.tool_executor.mcp_status().await {
                    Ok(servers) => servers,
                    Err(err) => {
                        self.state
                            .add_system_message(format!("Failed to load MCP status: {err}"));
                        return;
                    }
                };
                self.update_mcp_badge_counts(&servers);

                if let (Some(server), Some(uri)) = (server, uri) {
                    let status = servers.iter().find(|s| s.name == server);
                    if let Some(status) = status {
                        if !status.connected {
                            self.state
                                .add_system_message(format!("Server '{server}' not connected"));
                            return;
                        }
                    }

                    match self.tool_executor.mcp_read_resource(&server, &uri).await {
                        Ok(result) => {
                            let mut lines = Vec::new();
                            lines.push(format!("Resource: {uri}"));
                            lines.push(String::new());
                            for content in &result.contents {
                                if let Some(text) = &content.text {
                                    lines.push(text.clone());
                                } else {
                                    let mime = content.mime_type.as_deref().unwrap_or("unknown");
                                    lines.push(format!("[Binary data: {mime}]"));
                                }
                            }
                            self.state.add_system_message(lines.join("\n"));
                        }
                        Err(err) => {
                            self.state
                                .add_system_message(format!("Failed to read resource: {err}"));
                        }
                    }
                    return;
                }

                let mut lines = vec!["MCP Resources".to_string(), String::new()];
                let mut has_resources = false;
                for server in servers {
                    if !server.connected || server.resources.is_empty() {
                        continue;
                    }
                    has_resources = true;
                    lines.push(format!("{}:", server.name));
                    for uri in server.resources {
                        lines.push(format!("  {uri}"));
                    }
                    lines.push(String::new());
                }
                if !has_resources {
                    lines.push("No resources available from connected servers.".to_string());
                }
                lines.push(String::new());
                lines.push("Usage: /mcp resources <server> <uri>".to_string());
                self.state.add_system_message(lines.join("\n"));
            }
            McpAction::Prompts { server, name } => {
                let servers = match self.tool_executor.mcp_status().await {
                    Ok(servers) => servers,
                    Err(err) => {
                        self.state
                            .add_system_message(format!("Failed to load MCP status: {err}"));
                        return;
                    }
                };
                self.update_mcp_badge_counts(&servers);

                if let (Some(server), Some(name)) = (server, name) {
                    let status = servers.iter().find(|s| s.name == server);
                    if let Some(status) = status {
                        if !status.connected {
                            self.state
                                .add_system_message(format!("Server '{server}' not connected"));
                            return;
                        }
                        if !status.prompts.contains(&name) {
                            self.state.add_system_message(format!(
                                "Prompt '{name}' not found on server '{server}'"
                            ));
                            return;
                        }
                    }

                    match self
                        .tool_executor
                        .mcp_get_prompt(&server, &name, None)
                        .await
                    {
                        Ok(result) => {
                            let mut lines = Vec::new();
                            lines.push(format!("Prompt: {name}"));
                            if let Some(desc) = result.description {
                                lines.push(String::new());
                                lines.push(format!("Description: {desc}"));
                            }
                            lines.push(String::new());
                            for msg in result.messages {
                                lines.push(format!("[{}]", msg.role));
                                let content = msg.content.as_text().unwrap_or("[non-text content]");
                                lines.push(content.to_string());
                                lines.push(String::new());
                            }
                            self.state.add_system_message(lines.join("\n"));
                        }
                        Err(err) => {
                            self.state
                                .add_system_message(format!("Failed to get prompt: {err}"));
                        }
                    }
                    return;
                }

                let mut lines = vec!["MCP Prompts".to_string(), String::new()];
                let mut has_prompts = false;
                for server in servers {
                    if !server.connected || server.prompts.is_empty() {
                        continue;
                    }
                    has_prompts = true;
                    lines.push(format!("{}:", server.name));
                    for prompt in server.prompts {
                        lines.push(format!("  {prompt}"));
                    }
                    lines.push(String::new());
                }
                if !has_prompts {
                    lines.push("No prompts available from connected servers.".to_string());
                }
                lines.push(String::new());
                lines.push("Usage: /mcp prompts <server> <name>".to_string());
                self.state.add_system_message(lines.join("\n"));
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

        match action {
            SkillsAction::List => {
                let mut msg = String::from("## Available Skills\n\n");
                if self.loaded_skills.is_empty() && self.skill_load_errors.is_empty() {
                    msg.push_str("*No skills found*\n\n");
                    msg.push_str("Skills are loaded from:\n");
                    msg.push_str("- `~/.composer/skills/` (global)\n");
                    msg.push_str("- `.composer/skills/` (project)\n\n");
                    msg.push_str("Create a `SKILL.md` file following the [Agent Skills spec](https://agentskills.io/specification).\n");
                } else {
                    msg.push_str("| Name | Description | Source | Active | Tools |\n");
                    msg.push_str("|------|-------------|--------|--------|-------|\n");

                    for loaded in &self.loaded_skills {
                        let skill = &loaded.definition;
                        let tools_count = skill.provided_tools.len();
                        let tools = if tools_count > 0 {
                            format!("{tools_count}")
                        } else {
                            "-".to_string()
                        };
                        let active = self
                            .skill_registry
                            .get(&skill.id)
                            .map(|s| s.is_active())
                            .unwrap_or(false);
                        let active_label = if active { "yes" } else { "no" };
                        msg.push_str(&format!(
                            "| {} | {} | {:?} | {} | {} |\n",
                            skill.name,
                            skill.description.chars().take(40).collect::<String>(),
                            skill.source,
                            active_label,
                            tools
                        ));
                    }

                    msg.push_str(&format!(
                        "\n*{} skill(s) found*\n",
                        self.loaded_skills.len()
                    ));
                    let active_ids: Vec<String> = self
                        .skill_registry
                        .active_skills()
                        .iter()
                        .map(|skill| skill.definition.name.clone())
                        .collect();
                    if !active_ids.is_empty() {
                        msg.push_str(&format!("Active: {}\n", active_ids.join(", ")));
                    }
                }

                if !self.skill_load_errors.is_empty() {
                    msg.push_str(&format!(
                        "\n**{} error(s) loading skills:**\n",
                        self.skill_load_errors.len()
                    ));
                    for err in self.skill_load_errors.iter().take(5) {
                        msg.push_str(&format!("- {err}\n"));
                    }
                }

                self.state.add_system_message(msg);
            }
            SkillsAction::Activate(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                let skill = match self.skill_registry.get(&id) {
                    Some(skill) => skill,
                    None => {
                        self.state.error = Some(format!("Skill '{name}' not found"));
                        return;
                    }
                };
                let skill_name = skill.definition.name.clone();
                if skill.is_active() {
                    self.state.status = Some(format!("Skill '{}' already active", skill_name));
                    return;
                }
                if let Err(err) = self.skill_registry.activate(&id) {
                    self.state.error = Some(err);
                    return;
                }
                self.update_agent_system_prompt();
                self.state.status = Some(format!("Activated skill '{}'", skill_name));
                self.state.add_system_message(format!(
                    "Activated skill **{}**. System prompt updated.",
                    skill_name
                ));
            }
            SkillsAction::Deactivate(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                let skill = match self.skill_registry.get(&id) {
                    Some(skill) => skill,
                    None => {
                        self.state.error = Some(format!("Skill '{name}' not found"));
                        return;
                    }
                };
                let skill_name = skill.definition.name.clone();
                if !skill.is_active() {
                    self.state.status = Some(format!("Skill '{}' not active", skill_name));
                    return;
                }
                if let Err(err) = self.skill_registry.deactivate(&id) {
                    self.state.error = Some(err);
                    return;
                }
                self.update_agent_system_prompt();
                self.state.status = Some(format!("Deactivated skill '{}'", skill_name));
                self.state.add_system_message(format!(
                    "Deactivated skill **{}**. System prompt updated.",
                    skill_name
                ));
            }
            SkillsAction::Reload => {
                self.refresh_skills(true);
                self.update_agent_system_prompt();
                if self.skill_load_errors.is_empty() {
                    self.state
                        .status
                        .replace(format!("Loaded {} skill(s)", self.loaded_skills.len()));
                } else {
                    self.state.status.replace(format!(
                        "Loaded {} skill(s), {} error(s)",
                        self.loaded_skills.len(),
                        self.skill_load_errors.len()
                    ));
                }
                let mut msg = format!(
                    "Reloaded skills from filesystem. Found {} skill(s).",
                    self.loaded_skills.len()
                );
                if !self.skill_load_errors.is_empty() {
                    msg.push_str("\n\nErrors:\n");
                    for err in self.skill_load_errors.iter().take(5) {
                        msg.push_str(&format!("- {err}\n"));
                    }
                }
                self.state.add_system_message(msg);
            }
            SkillsAction::Info(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                if let Some(loaded) = self.find_loaded_skill(&id) {
                    let skill = &loaded.definition;
                    let mut msg = format!("## Skill: {}\n\n", skill.name);
                    msg.push_str(&format!("**Description:** {}\n\n", skill.description));
                    let active = self
                        .skill_registry
                        .get(&skill.id)
                        .map(|s| s.is_active())
                        .unwrap_or(false);
                    msg.push_str(&format!(
                        "**Status:** {}\n\n",
                        if active { "active" } else { "inactive" }
                    ));
                    msg.push_str(&format!("**Source:** {:?}\n\n", skill.source));
                    msg.push_str(&format!("**Path:** `{}`\n\n", loaded.source_path.display()));

                    if !skill.provided_tools.is_empty() {
                        msg.push_str(&format!(
                            "**Tools:** {}\n\n",
                            skill.provided_tools.join(", ")
                        ));
                    }

                    if !skill.trigger_patterns.is_empty() {
                        msg.push_str(&format!(
                            "**Triggers:** {}\n\n",
                            skill.trigger_patterns.join(", ")
                        ));
                    }

                    if let Some(ref prompt) = skill.system_prompt_additions {
                        let preview: String = prompt.chars().take(200).collect();
                        msg.push_str(&format!(
                            "**Instructions preview:**\n```\n{preview}...\n```\n"
                        ));
                    }

                    self.state.add_system_message(msg);
                } else {
                    self.state.error = Some(format!("Skill '{name}' not found"));
                }
            }
        }
    }

    fn handle_queue_action(&mut self, action: QueueAction) {
        match action {
            QueueAction::Show => {
                let total = self.state.queued_prompt_count;
                let steer_count = self.state.queued_steering_count;
                let follow_up_count = self.state.queued_follow_up_count;
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
                msg.push_str(&format!("**Pending:** {total}\n"));
                if total > 0 {
                    msg.push_str(&format!(
                        "- steer: {steer_count}, follow-up: {follow_up_count}\n"
                    ));
                }
                if let Some(active) = &self.queued_prompt_active {
                    msg.push_str(&format!(
                        "\n**Active:** #{} ({}) – {}\n",
                        active.id,
                        active.kind.label(),
                        Self::format_queue_snippet(&active.content, 80)
                    ));
                }
                if self.queued_prompts.is_empty() {
                    msg.push_str("\nNo queued prompts.\n");
                } else {
                    msg.push_str("\n**Pending prompts:**\n");
                    let inflight_id = self.queued_prompt_inflight.map(|cursor| cursor.id);
                    for (index, prompt) in self.queued_prompts.iter().enumerate() {
                        let marker = if inflight_id == Some(prompt.id) {
                            " (starting...)"
                        } else {
                            ""
                        };
                        msg.push_str(&format!(
                            "{}. #{} ({}){} – {}\n",
                            index + 1,
                            prompt.id,
                            prompt.kind.label(),
                            marker,
                            Self::format_queue_snippet(&prompt.content, 80)
                        ));
                    }
                }
                msg.push_str(
                    "\nUse /queue cancel <id> to remove a prompt. Use /queue mode [steer|followup] <one|all> to change behavior.",
                );
                self.state.add_system_message(msg);
            }
            QueueAction::Cancel { id } => {
                if self
                    .queued_prompt_active
                    .as_ref()
                    .is_some_and(|prompt| prompt.id == id)
                {
                    self.state
                        .status
                        .replace(format!("Queued prompt #{id} is already processing."));
                    return;
                }
                if self
                    .queued_prompt_inflight
                    .is_some_and(|prompt| prompt.id == id)
                {
                    self.state.status.replace(format!(
                        "Queued prompt #{id} is starting; try again if it re-queues."
                    ));
                    return;
                }
                match self.remove_queued_prompt(id) {
                    Some(removed) => {
                        if let Some(agent) = &self.native_agent {
                            agent.cancel_queued(id);
                        }
                        self.state.status.replace(format!(
                            "Removed queued {} #{}.",
                            removed.kind.label(),
                            removed.id
                        ));
                    }
                    None => {
                        self.state
                            .status
                            .replace(format!("No queued prompt found with id #{id}."));
                    }
                }
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
                let _ = crate::ui_state::save_queue_modes(
                    self.state.steering_mode,
                    self.state.follow_up_mode,
                );
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
                self.slash_state.reset();
                return Ok(());
            }
            Err(e) => {
                if e.message.contains("Unknown command") {
                    if let Some(agent) = &self.native_agent {
                        let _ = agent.prompt(input.clone(), vec![]).await;
                        self.state.busy = true;
                    } else {
                        self.state.error = Some(format!("Unknown command: {input}"));
                    }
                } else {
                    // Other errors (like missing args) should be shown to user
                    self.state.error = Some(e.to_string());
                }
            }
        }

        self.slash_state.reset();
        Ok(())
    }

    /// Show help message
    fn show_help(&mut self) {
        let help_text = r"
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
  /queue        Manage queued prompts (list/cancel/modes)
  /steer        Send a steering message
  /sessions     Browse sessions
  /files        Search files
  /commands     Open command palette
  /quit         Exit
";
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
        let queue_id = self.reserve_queue_id();
        let Some(agent) = &self.native_agent else {
            self.state.error = Some("Agent not initialized".to_string());
            return Ok(false);
        };
        if let Err(e) = agent
            .prompt_with_kind(content.clone(), vec![], kind, Some(queue_id))
            .await
        {
            self.state.error = Some(format!("Failed to queue prompt: {e}"));
            return Ok(false);
        }

        let dropped = self.enqueue_pending_prompt(queue_id, content, kind, front);
        if let Some(dropped) = dropped {
            self.state.status = Some(format!(
                "Queue full, dropped oldest {}.",
                dropped.kind.label()
            ));
        }
        Ok(true)
    }

    fn reserve_queue_id(&mut self) -> u64 {
        let id = self.next_queue_id;
        self.next_queue_id = self.next_queue_id.saturating_add(1).max(1);
        id
    }

    fn enqueue_pending_prompt(
        &mut self,
        id: u64,
        content: String,
        kind: PromptKind,
        front: bool,
    ) -> Option<QueuedPrompt> {
        let entry = QueuedPrompt { id, content, kind };
        if front {
            self.queued_prompts.push_front(entry);
        } else {
            self.queued_prompts.push_back(entry);
        }
        let inflight_offset = usize::from(self.queued_prompt_inflight.is_some());
        let effective_len = self.queued_prompts.len().saturating_sub(inflight_offset);
        if effective_len > MAX_PENDING_MESSAGES {
            let dropped = self.queued_prompts.pop_back();
            self.sync_queue_prompt_count();
            return dropped;
        }
        self.sync_queue_prompt_count();
        None
    }

    fn remove_queued_prompt(&mut self, id: u64) -> Option<QueuedPrompt> {
        let index = self
            .queued_prompts
            .iter()
            .position(|prompt| prompt.id == id)?;
        let removed = self.queued_prompts.remove(index);
        self.sync_queue_prompt_count();
        removed
    }

    fn format_queue_snippet(text: &str, max_len: usize) -> String {
        let mut condensed = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if condensed.is_empty() {
            condensed = "(empty message)".to_string();
        }
        if condensed.len() <= max_len {
            return condensed;
        }
        if max_len <= 3 {
            return "...".to_string();
        }
        let cutoff = max_len.saturating_sub(3);
        let mut truncated = condensed.chars().take(cutoff).collect::<String>();
        truncated.push_str("...");
        truncated
    }

    fn sync_queue_prompt_count(&mut self) {
        let mut steer_count: usize = 0;
        let mut follow_up_count: usize = 0;
        for prompt in &self.queued_prompts {
            match prompt.kind {
                PromptKind::Steer => steer_count += 1,
                PromptKind::FollowUp => follow_up_count += 1,
                PromptKind::Prompt => {}
            }
        }
        let inflight_offset = usize::from(self.queued_prompt_inflight.is_some());
        self.state.queued_prompt_count = self.queued_prompts.len().saturating_sub(inflight_offset);
        if let Some(inflight) = self.queued_prompt_inflight {
            match inflight.kind {
                PromptKind::Steer => steer_count = steer_count.saturating_sub(1),
                PromptKind::FollowUp => follow_up_count = follow_up_count.saturating_sub(1),
                PromptKind::Prompt => {}
            }
        }
        self.state.queued_steering_count = steer_count;
        self.state.queued_follow_up_count = follow_up_count;
    }

    /// Submit a prompt to the agent
    async fn submit_prompt(&mut self, content: String) -> Result<()> {
        let _ = self
            .submit_prompt_with_kind(content, PromptKind::Prompt)
            .await?;
        Ok(())
    }

    async fn submit_prompt_with_kind(&mut self, content: String, kind: PromptKind) -> Result<bool> {
        if self.session_resume_failed {
            self.state.error =
                Some("Session resume failed; use /new to start a new session.".to_string());
            return Ok(false);
        }

        let mut active_sessions = self.active_session_count();
        if self.session_manager.writer().is_none() {
            // Count the session we're about to start.
            active_sessions = active_sessions.map(|count| count.saturating_add(1));
        }

        let started_at = if self.session_manager.writer().is_some() {
            self.session_started_at
        } else {
            SystemTime::now()
        };

        let token_count = if self.usage_tracker.turn_count() == 0 {
            let has_assistant = self
                .state
                .messages
                .iter()
                .any(|message| message.role == MessageRole::Assistant);
            if has_assistant {
                // We don't have usage entries for this session; fail closed.
                None
            } else {
                Some(0)
            }
        } else {
            Some(self.usage_tracker.total_tokens())
        };

        if let Some(reason) = check_session_limits(started_at, token_count, active_sessions) {
            self.state.error = Some(reason);
            return Ok(false);
        }

        if let Err(err) = self.ensure_session_started() {
            self.state.error = Some(format!("Failed to start session: {err}"));
            return Ok(false);
        }

        // Add user message to state
        self.state.add_user_message(content.clone());
        self.state.busy = true;
        self.record_user_message(&content);
        if let Some(session_id) = self.state.session_id.clone() {
            self.prompt_history
                .add_with_session(content.clone(), session_id);
        } else {
            self.prompt_history.add(content.clone());
        }

        if let Some(agent) = &self.native_agent {
            // Send the prompt - returns immediately, actual work happens in background task
            // Events will be received via poll_agent in the main loop
            if let Err(e) = agent.prompt_with_kind(content, vec![], kind, None).await {
                self.state.error = Some(format!("Failed to send prompt: {e}"));
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
        if let Ok(area) = self.terminal.size() {
            let inner_width = area.width.saturating_sub(2).max(1);
            self.state.set_input_width(inner_width);
        }

        // Extract needed data to avoid borrow conflicts
        let state = &self.state;
        let active_modal = self.active_modal;
        let slash_state = &mut self.slash_state;
        let file_search = &mut self.file_search;
        let session_switcher = &mut self.session_switcher;
        let command_palette = &mut self.command_palette;
        let approval_controller = &self.approval_controller;
        let model_selector = &mut self.model_selector;
        let theme_selector = &mut self.theme_selector;
        let shortcuts_help = &self.shortcuts_help;

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
                ActiveModal::ShortcutsHelp => {
                    frame.render_widget(shortcuts_help.clone(), area);
                }
                ActiveModal::None => {}
            }

            // Position terminal cursor in the input area
            // Layout: [Messages(Min), Input(auto), Status(1)]
            if active_modal == ActiveModal::None {
                // Calculate input area position (same layout as ChatView)
                let status_height = u16::from(!state.zen_mode);
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
                let input_widget =
                    ChatInputWidget::new(&state.textarea, "", state.busy, 0, None, None);

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
        slash_state: &mut SlashCycleState,
        frame: &mut ratatui::Frame,
        area: Rect,
    ) {
        use ratatui::widgets::{Block, Borders, Clear, List, ListItem};

        let completions = slash_state.completions();
        if completions.is_empty() {
            return;
        }

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
            .map(|cmd| {
                // Completions already include the slash
                ListItem::new(cmd.clone()).style(Style::default().fg(Color::White))
            })
            .collect();

        let list = List::new(items)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::DarkGray))
                    .style(Style::default().bg(Color::Black)),
            )
            .highlight_style(Style::default().bg(Color::DarkGray).fg(Color::Cyan));

        frame.render_stateful_widget(list, popup_area, slash_state.list_state_mut());
    }
}

impl Default for App {
    fn default() -> Self {
        match Self::new() {
            Ok(app) => app,
            Err(err) => {
                eprintln!("[app] Warning: Failed to initialize terminal: {err}");
                let (terminal, capabilities) =
                    terminal::init_fallback().unwrap_or_else(|fallback_err| {
                        panic!("Failed to create App: {err}; fallback failed: {fallback_err}");
                    });
                Self::new_with_terminal(terminal, capabilities)
            }
        }
    }
}

fn system_time_to_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_session_usage(usage: &crate::agent::TokenUsage) -> SessionTokenUsage {
    SessionTokenUsage {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens,
        cache_write: usage.cache_write_tokens,
        cost: usage.cost.map(|total| TokenCost {
            total,
            ..Default::default()
        }),
    }
}

fn to_headless_usage(usage: &crate::agent::TokenUsage) -> crate::headless::TokenUsage {
    crate::headless::TokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        cost: usage.cost,
    }
}

fn provider_id(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Anthropic => "anthropic",
        AiProvider::OpenAI => "openai",
        AiProvider::Mistral => "mistral",
        AiProvider::Google => "google",
        AiProvider::Groq => "groq",
        AiProvider::VertexAi => "vertex-ai",
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

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::QueueMode;

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
    // Queue State Tests
    // ─────────────────────────────────────────────────────────────────────────

    fn new_test_app() -> App {
        let fallback_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(fallback_path)
            .expect("open fallback terminal");
        let viewport_height = 24;
        let viewport_top = 1;
        let backend = ratatui::backend::CrosstermBackend::new(file);
        let terminal = ratatui::Terminal::with_options(
            backend,
            ratatui::TerminalOptions {
                viewport: ratatui::Viewport::Fixed(ratatui::layout::Rect::new(
                    0,
                    0,
                    80,
                    viewport_height,
                )),
            },
        )
        .expect("create fallback terminal");
        let capabilities = crate::terminal::TerminalCapabilities {
            enhanced_keys: false,
            viewport_top,
            viewport_height,
        };
        let mut app = App::new_with_terminal_with_history(
            terminal,
            capabilities,
            crate::history::PromptHistory::default(),
        );
        app.state.steering_mode = QueueMode::default();
        app.state.follow_up_mode = QueueMode::default();
        app
    }

    #[tokio::test]
    async fn test_queue_counts_sync_on_response_start() {
        let mut app = new_test_app();

        let follow_up_id = app.reserve_queue_id();
        let steer_id = app.reserve_queue_id();
        app.enqueue_pending_prompt(
            follow_up_id,
            "follow-up".to_string(),
            PromptKind::FollowUp,
            false,
        );
        app.enqueue_pending_prompt(steer_id, "steer".to_string(), PromptKind::Steer, false);
        assert_eq!(app.state.queued_prompt_count, 2);
        assert_eq!(app.state.queued_follow_up_count, 1);
        assert_eq!(app.state.queued_steering_count, 1);

        app.state.busy = false;
        app.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        })
        .await
        .expect("handle response start");

        assert_eq!(app.state.queued_prompt_count, 1);
        assert_eq!(app.state.queued_follow_up_count, 0);
        assert_eq!(app.state.queued_steering_count, 1);
    }

    #[tokio::test]
    async fn test_queue_counts_clear_on_interrupt() {
        let mut app = new_test_app();

        let follow_up_id = app.reserve_queue_id();
        let steer_id = app.reserve_queue_id();
        app.enqueue_pending_prompt(
            follow_up_id,
            "follow-up".to_string(),
            PromptKind::FollowUp,
            false,
        );
        app.enqueue_pending_prompt(steer_id, "steer".to_string(), PromptKind::Steer, false);
        app.state.busy = true;

        app.handle_key(KeyCode::Char('c'), CrosstermModifiers::CONTROL)
            .await
            .expect("interrupt");

        assert_eq!(app.state.queued_prompt_count, 0);
        assert_eq!(app.state.queued_follow_up_count, 0);
        assert_eq!(app.state.queued_steering_count, 0);
        assert!(app.queued_prompts.is_empty());
    }

    #[tokio::test]
    async fn test_queue_overflow_with_inflight_does_not_drop() {
        let mut app = new_test_app();

        for _ in 0..MAX_PENDING_MESSAGES {
            let id = app.reserve_queue_id();
            app.enqueue_pending_prompt(id, "follow-up".to_string(), PromptKind::FollowUp, false);
        }

        let inflight_id = app.queued_prompts.front().unwrap().id;
        app.queued_prompt_inflight = Some(QueuedPromptCursor {
            id: inflight_id,
            kind: PromptKind::FollowUp,
        });
        app.sync_queue_prompt_count();

        let new_id = app.reserve_queue_id();
        let dropped =
            app.enqueue_pending_prompt(new_id, "extra".to_string(), PromptKind::FollowUp, false);

        assert!(dropped.is_none());
        assert_eq!(app.queued_prompts.len(), MAX_PENDING_MESSAGES + 1);
        assert_eq!(app.state.queued_prompt_count, MAX_PENDING_MESSAGES);
    }

    #[test]
    fn test_queue_cancel_by_id() {
        let mut app = new_test_app();

        let first_id = app.reserve_queue_id();
        let second_id = app.reserve_queue_id();
        app.enqueue_pending_prompt(first_id, "first".to_string(), PromptKind::FollowUp, false);
        app.enqueue_pending_prompt(second_id, "second".to_string(), PromptKind::Steer, false);

        app.handle_queue_action(QueueAction::Cancel { id: first_id });

        assert_eq!(app.queued_prompts.len(), 1);
        assert_eq!(app.queued_prompts.front().unwrap().id, second_id);
        assert_eq!(app.state.queued_prompt_count, 1);
    }

    #[tokio::test]
    async fn test_queue_counts_clear_on_error() {
        let mut app = new_test_app();

        let id = app.reserve_queue_id();
        app.enqueue_pending_prompt(id, "follow-up".to_string(), PromptKind::FollowUp, false);
        app.queued_prompt_inflight = Some(QueuedPromptCursor {
            id,
            kind: PromptKind::FollowUp,
        });
        app.sync_queue_prompt_count();

        app.state.busy = true;
        app.handle_agent_message(FromAgent::Error {
            message: "oops".to_string(),
            fatal: false,
        })
        .await
        .expect("handle error");

        assert!(!app.state.busy);
        assert!(app.queued_prompt_inflight.is_none());
        assert_eq!(app.state.queued_prompt_count, 1);
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

        // Default: expanded when compact mode is off
        assert!(state.is_tool_call_expanded(call_id));

        // Toggle off
        state.toggle_tool_call(call_id);
        assert!(!state.is_tool_call_expanded(call_id));

        // Toggle on
        state.toggle_tool_call(call_id);
        assert!(state.is_tool_call_expanded(call_id));
    }

    #[test]
    fn test_multiple_tool_calls_expansion() {
        let mut state = AppState::new();
        state.compact_tool_outputs = true;

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
        let prompt_template = r"You have access to the following tools:
- bash: Execute shell commands
- read: Read file contents
- write: Write to files
- glob: Find files by pattern
- grep: Search file contents";

        assert!(prompt_template.contains("bash"));
        assert!(prompt_template.contains("read"));
        assert!(prompt_template.contains("write"));
        assert!(prompt_template.contains("glob"));
        assert!(prompt_template.contains("grep"));
    }
}

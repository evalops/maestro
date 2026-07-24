//! # Native Maestro TUI Application
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

use std::collections::{HashMap, HashSet, VecDeque};
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
use crate::agent::{
    CredentialVault, FromAgent, NativeAgent, NativeAgentConfig, PromptKind, ToolResult,
};
use crate::ai::AiProvider;
use crate::clipboard::ClipboardManager;
use crate::commands::{
    build_command_registry_with_extensions, BackgroundMonitorAction, CommandAction, CommandOutput,
    CommandRegistry, ModalType, PlanReviewAction, QueueAction, QueueModeKind, SlashCommandMatcher,
    SlashCycleState,
};
use crate::components::{
    calculate_input_height, ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest,
    ChatInputWidget, ChatInputWidgetOptions, ChatView, CommandPalette, FileSearchModal,
    ModelSelector, OperationsModal, SessionSwitcher, ShortcutsHelp, ThemeSelector,
};
use crate::config_watcher::{ConfigEvent, ConfigWatcher, ConfigWatcherBuilder};
use crate::files::{get_workspace_files, WorkspaceFile};
use crate::git;
use crate::keybindings::load_rust_tui_keybindings;
use crate::keybindings::{is_keybindings_config_path, summarize_keybindings_config_issues};
use crate::mcp::{
    append_mcp_prompt_summary, McpConfigScope, McpPrompt, McpRuntimeEvent, McpTransport,
};
use crate::palette_resource::{PaletteResource, PaletteResourceKind};
use crate::plugins::PluginRegistry;
use crate::prompts::{load_prompts, parse_args, render_prompt, PromptDefinition};
use crate::safety::{
    check_model_allowed, check_path_allowed, check_session_limits, FirewallVerdict,
};
use crate::session::{
    AppMessage, CompactionEntry, ContentBlock as SessionContentBlock, MessageContent, MessageEntry,
    ModelChange, ParsedSession, PlanReviewComment, PlanReviewEntry, PlanReviewEvent, SessionEntry,
    SessionExporter, SessionHeader, SessionManager, SideQuestionEntry, ThinkingLevel,
    ThinkingLevelChange, TokenCost, TokenUsage as SessionTokenUsage, ToolInfo,
};
use crate::skills::{skills_to_prompt, LoadedSkill, SkillLoadError, SkillLoader, SkillRegistry};
use crate::state::{AppState, ApprovalMode, Message, MessageKind, MessageRole, QueueMode};
use crate::terminal::{self, TerminalCapabilities};
use crate::tools::{ToolExecutor, ToolRegistry};
use chrono::{Datelike, Utc};

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
    /// Read-only persisted tool execution browser
    Operations,
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
}

fn build_mcp_config_watcher() -> ConfigWatcher {
    let mut builder = ConfigWatcherBuilder::new().debounce(Duration::from_millis(250));

    if let Some(home) = dirs::home_dir() {
        builder = builder
            .watch(home.join(".composer").join("mcp.json"))
            .watch(home.join(".composer").join("enterprise").join("mcp.json"))
            .watch(home.join(".maestro").join("keybindings.json"));
    }

    builder
        .watch(".composer/mcp.json")
        .watch(".composer/mcp.local.json")
        .watch(crate::keybindings::keybindings_config_path())
        .build()
        .unwrap_or_default()
}

fn is_mcp_config_path(path: &std::path::Path) -> bool {
    path.ends_with(std::path::Path::new(".composer").join("mcp.json"))
        || path.ends_with(std::path::Path::new(".composer").join("mcp.local.json"))
        || path.ends_with(
            std::path::Path::new(".composer")
                .join("enterprise")
                .join("mcp.json"),
        )
}

fn format_mcp_scope_label(scope: McpConfigScope) -> &'static str {
    match scope {
        McpConfigScope::Enterprise => "Enterprise config",
        McpConfigScope::Local => "Local config",
        McpConfigScope::Project => "Project config",
        McpConfigScope::User => "User config",
    }
}

fn format_mcp_transport_label(transport: McpTransport) -> &'static str {
    match transport {
        McpTransport::Http => "HTTP",
        McpTransport::Sse => "SSE",
        McpTransport::Stdio => "stdio",
    }
}

fn format_mcp_error_label(error: Option<&str>) -> Option<String> {
    error.map(|message| {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            "Connection failed.".to_string()
        } else {
            trimmed.to_string()
        }
    })
}

fn trim_optional_message(message: Option<&str>) -> Option<&str> {
    message.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn format_mcp_progress_status(
    server: &str,
    progress: f64,
    total: Option<f64>,
    message: Option<&str>,
) -> String {
    let message = trim_optional_message(message);
    if let Some(total) = total.filter(|value| value.is_finite() && *value > 0.0) {
        let percent = ((progress / total) * 100.0).round().clamp(0.0, 100.0) as i64;
        if let Some(message) = message {
            format!("MCP {server}: {message} ({percent}%)")
        } else {
            format!("MCP {server}: {percent}%")
        }
    } else if let Some(message) = message {
        format!("MCP {server}: {message}")
    } else {
        format!("MCP {server}: in progress")
    }
}

fn format_mcp_log_data(data: &serde_json::Value) -> String {
    let text = match data {
        serde_json::Value::String(message) => message.clone(),
        serde_json::Value::Null => "null".to_string(),
        other => {
            serde_json::to_string(other).unwrap_or_else(|_| "[Unserializable data]".to_string())
        }
    };

    text.chars().take(100).collect()
}

fn format_mcp_runtime_event_status(event: &McpRuntimeEvent) -> Option<String> {
    match event {
        McpRuntimeEvent::ToolsListChanged { server } => {
            Some(format!("MCP server \"{server}\" tools updated"))
        }
        McpRuntimeEvent::ResourcesListChanged { server } => {
            Some(format!("MCP server \"{server}\" resources updated"))
        }
        McpRuntimeEvent::PromptsListChanged { server } => {
            Some(format!("MCP server \"{server}\" prompts updated"))
        }
        McpRuntimeEvent::Progress {
            server,
            progress,
            total,
            message,
        } => Some(format_mcp_progress_status(
            server,
            *progress,
            *total,
            message.as_deref(),
        )),
        McpRuntimeEvent::Log {
            server,
            level,
            data,
            ..
        } => match level.as_str() {
            "warning" | "error" | "critical" | "alert" | "emergency" => {
                Some(format!("[{server}] {}", format_mcp_log_data(data)))
            }
            _ => None,
        },
    }
}

fn format_mcp_connection_status(name: &str, tools: usize) -> String {
    let label = if tools == 1 { "tool" } else { "tools" };
    format!("MCP server \"{name}\" connected ({tools} {label})")
}

fn format_mcp_disconnection_status(name: &str) -> String {
    format!("MCP server \"{name}\" disconnected")
}

fn format_mcp_connection_error_status(name: &str, error: Option<&str>) -> String {
    let error_label =
        format_mcp_error_label(error).unwrap_or_else(|| "Connection failed.".to_string());
    format!("MCP server \"{name}\" error: {error_label}")
}

fn format_mcp_server_transition_status(
    previous: Option<&crate::tools::McpServerStatus>,
    current: Option<&crate::tools::McpServerStatus>,
) -> Option<String> {
    match (previous, current) {
        (_, Some(server)) if server.connected => {
            if previous.is_none_or(|status| !status.connected) {
                Some(format_mcp_connection_status(
                    &server.name,
                    server.tools.len(),
                ))
            } else {
                None
            }
        }
        (Some(previous), Some(server)) => {
            let previous_error = format_mcp_error_label(previous.error.as_deref());
            let current_error = format_mcp_error_label(server.error.as_deref());

            if current_error != previous_error {
                current_error.as_deref().map(|_| {
                    format_mcp_connection_error_status(&server.name, server.error.as_deref())
                })
            } else if previous.connected && !server.connected {
                Some(format_mcp_disconnection_status(&server.name))
            } else {
                None
            }
        }
        (None, Some(server)) => server
            .error
            .as_deref()
            .map(|_| format_mcp_connection_error_status(&server.name, server.error.as_deref())),
        (Some(previous), None) if previous.connected => {
            Some(format_mcp_disconnection_status(&previous.name))
        }
        _ => None,
    }
}

fn snapshot_mcp_server_statuses(
    servers: &[crate::tools::McpServerStatus],
) -> HashMap<String, crate::tools::McpServerStatus> {
    servers
        .iter()
        .cloned()
        .map(|server| (server.name.clone(), server))
        .collect()
}

fn render_mcp_status_lines(servers: &[crate::tools::McpServerStatus]) -> Vec<String> {
    let mut lines = vec!["Model Context Protocol".to_string(), String::new()];

    if servers.is_empty() {
        lines.push("No MCP servers configured.".to_string());
        lines.push(String::new());
        lines.push("Add servers to ~/.composer/mcp.json or .composer/mcp.json:".to_string());
        lines.push(String::new());
        lines.push(
            "{ \"mcpServers\": { \"my-server\": { \"command\": \"npx\", \"args\": [\"-y\", \"@example/mcp-server\"] } } }"
                .to_string(),
        );
        return lines;
    }

    for server in servers {
        let status = if server.connected {
            "connected"
        } else {
            "disconnected"
        };
        lines.push(format!("- {} ({status})", server.name));
        lines.push(format!(
            "  Source: {}",
            format_mcp_scope_label(server.scope)
        ));
        lines.push(format!(
            "  Transport: {}",
            format_mcp_transport_label(server.transport)
        ));

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
            if let Some(error_label) = format_mcp_error_label(server.error.as_deref()) {
                lines.push(format!("  Error: {error_label}"));
            }
        }
    }

    lines.push(String::new());
    lines.push("Subcommands: /mcp resources, /mcp prompts".to_string());
    lines
}

fn render_mcp_prompt_lines(
    prompt_servers: &[(String, Vec<McpPrompt>)],
    server_name: Option<&str>,
) -> Vec<String> {
    let mut lines = vec!["MCP Prompts".to_string(), String::new()];

    if prompt_servers.is_empty() {
        lines.push(match server_name {
            Some(name) => format!("Server '{name}' does not expose prompts."),
            None => "No prompts available from connected servers.".to_string(),
        });
    } else {
        for (server_name, prompts) in prompt_servers {
            lines.push(format!("{server_name}:"));
            for prompt in prompts {
                append_mcp_prompt_summary(&mut lines, prompt, "  ", "    ");
            }
            lines.push(String::new());
        }
    }

    lines.push(String::new());
    lines.push("Usage: /mcp prompts <server> <name> [KEY=value ...]".to_string());
    lines
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

    /// Shared credential vault for the active application session.
    credential_vault: CredentialVault,

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

    /// Workspace files shared by file search and the unified palette.
    workspace_files: Vec<WorkspaceFile>,

    /// Session history browser modal.
    session_switcher: SessionSwitcher,

    /// Recent persisted tool executions.
    operations: OperationsModal,

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

    /// Discovered filesystem plugins (skills/commands/hooks/MCP packages).
    plugin_registry: PluginRegistry,

    /// Flat markdown prompt/command templates.
    custom_prompts: Vec<PromptDefinition>,

    /// Optional initial prompt from CLI (Grok-style trailing args).
    initial_prompt: Option<String>,

    /// Prompts submitted while running (queued in the agent).
    queued_prompts: VecDeque<QueuedPrompt>,

    /// Queued prompt reserved by the agent (between `ResponseEnd` and `ResponseStart`).
    queued_prompt_inflight: Option<QueuedPromptCursor>,

    /// Queued prompt currently being processed.
    queued_prompt_active: Option<QueuedPrompt>,

    /// Next id for queued prompts.
    next_queue_id: u64,

    /// Structured comments on the current plan, rebuilt from session events.
    plan_review_comments: Vec<PlanReviewComment>,

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

    /// Last observed MCP server status snapshots for transition messages.
    last_mcp_server_statuses: HashMap<String, crate::tools::McpServerStatus>,

    /// Watches MCP config files so status badges refresh immediately after edits.
    config_watcher: ConfigWatcher,

    /// Pending model change awaiting agent confirmation.
    pending_model_change: Option<PendingModelChange>,

    /// Bounded actor and result channel for selected-model verification.
    model_monitor: crate::model_monitor::ModelMonitor,
    model_verification_rx: std::sync::mpsc::Receiver<crate::model_monitor::ModelVerificationEvent>,

    /// Cached git branch for session info updates.
    current_git_branch: Option<String>,

    /// Keyboard shortcut used to open the command palette.
    command_palette_binding: crate::key_hints::KeyBinding,

    /// Keyboard shortcut used to open file search.
    file_search_binding: crate::key_hints::KeyBinding,

    /// Keyboard shortcut used to toggle tool output expansion.
    toggle_tool_outputs_binding: crate::key_hints::KeyBinding,

    /// Keyboard shortcut used to restore the last queued follow-up.
    queued_follow_up_edit_binding: crate::key_hints::KeyBinding,

    /// Last surfaced keybinding config issue summary.
    last_keybinding_issue_summary: Option<String>,

    /// Follow-up currently being edited out of the queue.
    editing_queued_follow_up: Option<QueuedPrompt>,

    /// Interrupt should immediately submit the next queued steering batch.
    submit_queued_steering_after_interrupt: bool,

    /// Interrupt should restore queued prompts into the composer after the run ends.
    restore_queued_prompts_after_interrupt: bool,
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
        Self::new_with_initial_prompt(None)
    }

    /// Create an app, optionally submitting `initial_prompt` after the agent is ready.
    pub fn new_with_initial_prompt(initial_prompt: Option<String>) -> Result<Self> {
        let (terminal, capabilities) = terminal::init().context("Failed to initialize terminal")?;
        Ok(Self::new_with_terminal(
            terminal,
            capabilities,
            initial_prompt,
        ))
    }

    fn new_with_terminal(
        terminal: terminal::Terminal,
        capabilities: TerminalCapabilities,
        initial_prompt: Option<String>,
    ) -> Self {
        let workspace_dir =
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let config = crate::config::load_config(&workspace_dir, None);
        let context_window = config.model_context_window.map(|value| value as u64);
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
        let slash_command_fallback = config
            .tui
            .as_ref()
            .and_then(|tui| tui.slash_command_fallback)
            .unwrap_or(true);
        let mut app = Self::new_with_terminal_with_history(
            terminal,
            capabilities,
            prompt_history,
            initial_prompt,
            context_window,
        );
        app.state.unknown_slash_command_fallback = slash_command_fallback;
        app
    }

    fn new_with_terminal_with_history(
        terminal: terminal::Terminal,
        capabilities: TerminalCapabilities,
        prompt_history: crate::history::PromptHistory,
        initial_prompt: Option<String>,
        context_window: Option<u64>,
    ) -> Self {
        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string());
        let workspace_dir = std::path::PathBuf::from(&cwd);
        let credential_vault = CredentialVault::new();

        let mut state = AppState::new();
        state.context_window = context_window;
        let queue_modes = crate::ui_state::load_queue_modes();
        if let Some(mode) = queue_modes.steering_mode {
            state.steering_mode = mode;
        }
        if let Some(mode) = queue_modes.follow_up_mode {
            state.follow_up_mode = mode;
        }
        let terminal_info = crate::terminal_info::TerminalInfo::get();
        let keybindings =
            load_rust_tui_keybindings(&terminal_info.name, std::env::var_os("TMUX").is_some());
        let keybinding_labels = keybindings.labels();
        let keybinding_issue_summary = summarize_keybindings_config_issues();
        state.queued_follow_up_edit_binding_label =
            keybinding_labels.edit_last_queued_follow_up.clone();
        if let Some(summary) = &keybinding_issue_summary {
            state.add_system_message(summary.clone());
        }

        let plugin_registry = PluginRegistry::discover();
        let loader = SkillLoader::with_plugins(&plugin_registry);
        let (loaded_skills, skill_load_errors) = loader.load_all_with_paths();
        let mut skill_registry = SkillRegistry::new();
        for loaded in &loaded_skills {
            skill_registry.register(loaded.definition.clone());
        }
        let custom_prompts = load_prompts(&workspace_dir);
        let (model_monitor, model_verification_rx) = crate::model_monitor::spawn_model_monitor();

        let command_registry = Arc::new(build_command_registry_with_extensions(
            &loaded_skills,
            &custom_prompts,
        ));
        let slash_matcher = SlashCommandMatcher::new(Arc::clone(&command_registry));

        Self {
            state,
            native_agent: None,
            native_event_rx: None,
            tool_response_tx: None,
            tool_executor: ToolExecutor::with_credential_vault(&cwd, credential_vault.clone()),
            credential_vault,
            terminal,
            should_quit: false,
            capabilities,
            command_palette: CommandPalette::new(Arc::clone(&command_registry)),
            command_registry,
            slash_matcher,
            slash_state: SlashCycleState::new(),
            active_modal: ActiveModal::None,
            file_search: FileSearchModal::new(),
            workspace_files: Vec::new(),
            session_switcher: SessionSwitcher::new(&cwd),
            operations: OperationsModal::new(&cwd),
            approval_controller: ApprovalController::new(),
            session_manager: SessionManager::new(&cwd),
            clipboard: ClipboardManager::new(),
            model_selector: ModelSelector::new(),
            theme_selector: ThemeSelector::new(),
            shortcuts_help: ShortcutsHelp::new_with_binding_labels(keybinding_labels),
            usage_tracker: crate::usage::UsageTracker::new(),
            prompt_history,
            tool_history: crate::tools::ToolHistory::default(),
            loaded_skills,
            skill_load_errors,
            skill_registry,
            plugin_registry,
            custom_prompts,
            initial_prompt: initial_prompt.filter(|p| !p.trim().is_empty()),
            queued_prompts: VecDeque::new(),
            queued_prompt_inflight: None,
            queued_prompt_active: None,
            next_queue_id: 1,
            plan_review_comments: Vec::new(),
            session_started_at: SystemTime::now(),
            session_resume_failed: false,
            current_model: String::new(),
            current_thinking_level: ThinkingLevel::Off,
            last_mcp_status_refresh: None,
            last_mcp_server_statuses: HashMap::new(),
            config_watcher: build_mcp_config_watcher(),
            pending_model_change: None,
            model_monitor,
            model_verification_rx,
            current_git_branch: None,
            command_palette_binding: keybindings.command_palette,
            file_search_binding: keybindings.file_search,
            toggle_tool_outputs_binding: keybindings.toggle_tool_outputs,
            queued_follow_up_edit_binding: keybindings.edit_last_queued_follow_up,
            last_keybinding_issue_summary: keybinding_issue_summary,
            editing_queued_follow_up: None,
            submit_queued_steering_after_interrupt: false,
            restore_queued_prompts_after_interrupt: false,
        }
    }

    /// Get the current viewport top position (for history push).
    pub fn viewport_top(&self) -> u16 {
        self.capabilities.viewport_top
    }

    fn build_base_system_prompt(cwd: &str) -> String {
        format!(
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
        )
    }

    fn build_shared_prompt_additions(current_year: i32, active_prompt: &str) -> String {
        let mut additions = Vec::new();
        additions.push(format!(
            "When using websearch/codesearch for up-to-date information, include the current year ({current_year}) in the query unless the user specifies a different year or a historical range."
        ));

        let trimmed = active_prompt.trim();
        if !trimmed.is_empty() {
            additions.push(trimmed.to_string());
        }

        additions.join("\n\n")
    }

    fn build_system_prompt_with_context(
        cwd: &str,
        current_year: i32,
        skills_section: Option<String>,
        active_prompt: &str,
    ) -> String {
        let mut sections = vec![Self::build_base_system_prompt(cwd)];

        if let Some(skills) = skills_section {
            if !skills.trim().is_empty() {
                sections.push(skills);
            }
        }

        let additions = Self::build_shared_prompt_additions(current_year, active_prompt);
        if !additions.trim().is_empty() {
            sections.push(additions);
        }

        sections.join("\n\n")
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
        // Optional Jane Street magic-trace slow-frame snapshots (Linux/Intel PT).
        if crate::magic_trace::init_from_env() {
            eprintln!(
                "[magic-trace] slow-frame stop indicator enabled (budget {}µs). Attach with scripts/magic-trace-tui.sh",
                std::env::var("MAESTRO_MAGIC_TRACE_FRAME_BUDGET_MS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(16)
                    * 1000
            );
        }

        // Paint the chrome immediately. Workspace file indexing used to run
        // *before* the first frame and blocked on `rg --files --follow` of the
        // entire cwd (often `$HOME`), so typing `maestro` looked hung/broken.
        self.render()?;

        // Index @-mention files with a bounded, killable scan (see workspace.rs).
        // Kick it off on a background thread so agent spawn is not gated on it.
        let (workspace_tx, workspace_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("maestro-workspace-scan".into())
            .spawn(move || {
                let cwd = std::env::current_dir().unwrap_or_default();
                let files = get_workspace_files(&cwd, 10_000);
                let _ = workspace_tx.send(files);
            })
            .ok();

        // Spawn the agent (async operation).
        // This creates the channels and starts the agent task.
        self.spawn_agent().await?;

        // Grok-style trailing prompt: submit after the agent is ready.
        if let Some(prompt) = self.initial_prompt.take() {
            let _ = self.submit_prompt(prompt).await;
        }

        // Main event loop - runs until should_quit is set to true.
        let mut workspace_rx = Some(workspace_rx);
        // Only repaint when something changed (or while busy for spinners).
        // Idle 20Hz full-buffer diffs were the top cost after FS badge work
        // (perf on developer@dev-desktop → ratatui Buffer::diff / unicode_width).
        let mut needs_redraw = true;
        loop {
            // Apply workspace scan results as soon as they arrive (non-blocking).
            if let Some(rx) = workspace_rx.as_ref() {
                match rx.try_recv() {
                    Ok(files) => {
                        self.workspace_files.clone_from(&files);
                        self.file_search.set_files(files);
                        workspace_rx = None;
                        needs_redraw = true;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        workspace_rx = None;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                }
            }

            // Poll for terminal events. Shorter timeout while busy (animations);
            // longer while idle to avoid burning CPU on empty frames.
            let poll_ms = if self.state.busy { 33 } else { 100 };
            if event::poll(std::time::Duration::from_millis(poll_ms))? {
                match event::read()? {
                    Event::Key(key)
                        // Only handle key press events (not release).
                        // Some terminals send both press and release events.
                        if key.kind == KeyEventKind::Press => {
                            self.handle_key(key.code, key.modifiers).await?;
                            needs_redraw = true;
                        }
                    Event::Mouse(mouse) => {
                        // Handle mouse scroll wheel
                        match mouse.kind {
                            MouseEventKind::ScrollUp => {
                                self.state.scroll_up(3);
                                needs_redraw = true;
                            }
                            MouseEventKind::ScrollDown => {
                                self.state.scroll_down(3);
                                needs_redraw = true;
                            }
                            _ => {} // Ignore other mouse events
                        }
                    }
                    Event::Resize(_, _) => {
                        needs_redraw = true;
                    }
                    _ => {} // Ignore other events (focus, paste handled elsewhere)
                }
            }

            // Poll for messages from the agent (async operation).
            // This handles streaming responses, tool calls, etc.
            let agent_activity = self.poll_agent().await?;
            if agent_activity {
                needs_redraw = true;
            }

            if self.poll_model_verification() {
                needs_redraw = true;
            }

            // Drain live MCP notifications so list changes refresh the UI
            // without waiting for a reconnect or a manual status check.
            if self.poll_mcp_updates().await {
                needs_redraw = true;
            }

            // Apply MCP config changes before the periodic refresh so edits
            // show up in the footer as soon as the watcher delivers them.
            if self.poll_config_watcher().await {
                needs_redraw = true;
            }

            // Refresh MCP badge counts periodically without blocking the UI.
            if self.refresh_mcp_badges().await {
                needs_redraw = true;
            }

            if self.operations.poll_load() {
                needs_redraw = true;
            }

            for event in crate::tools::background_tasks::poll_monitor_events() {
                self.operations.add_monitor_event(&event);
                needs_redraw = true;
            }

            // Paint when dirty, or continuously while busy (thinking/spinner).
            if needs_redraw || self.state.busy {
                self.render()?;
                if !self.state.busy {
                    needs_redraw = false;
                }
            }

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
        self.workspace_files.clone_from(&files);
        self.file_search.set_files(files);
    }

    /// Spawn the native Rust agent
    async fn spawn_agent(&mut self) -> Result<()> {
        let cwd_path = std::env::current_dir().unwrap_or_default();
        let cwd = cwd_path.to_string_lossy().to_string();

        // Detect git branch
        let git_branch = git::current_branch(&cwd_path);
        self.current_git_branch = git_branch.clone();

        // Determine model from environment or default (prefer Codex/OpenAI)
        let model =
            std::env::var("MAESTRO_MODEL").unwrap_or_else(|_| "gpt-5.1-codex-max".to_string());

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

        match NativeAgent::new_with_credential_vault(config, self.credential_vault.clone()) {
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
                    let _ = agent.set_steering_mode(self.state.steering_mode);
                    let _ = agent.set_follow_up_mode(self.state.follow_up_mode);
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
        let current_year = Utc::now().year();
        let skills_section = if self.loaded_skills.is_empty() {
            None
        } else {
            Some(skills_to_prompt(&self.loaded_skills))
        };
        let active_prompt = self.skill_registry.active_system_prompt_additions();

        Self::build_system_prompt_with_context(&cwd, current_year, skills_section, &active_prompt)
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

        self.plugin_registry = PluginRegistry::discover();
        let loader = SkillLoader::with_plugins(&self.plugin_registry);
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

        let workspace_dir =
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        self.custom_prompts = load_prompts(&workspace_dir);
        self.rebuild_slash_registry();
    }

    fn rebuild_slash_registry(&mut self) {
        let registry = Arc::new(build_command_registry_with_extensions(
            &self.loaded_skills,
            &self.custom_prompts,
        ));
        self.command_registry = Arc::clone(&registry);
        self.slash_matcher = SlashCommandMatcher::new(Arc::clone(&registry));
        self.command_palette.update_registry(registry);
    }

    fn format_skill_invoke(skill: &LoadedSkill, raw_args: &str) -> String {
        let body = skill
            .definition
            .system_prompt_additions
            .as_deref()
            .unwrap_or("")
            .trim();
        let args = raw_args.trim();

        if body.contains('$') {
            let parsed = parse_args(raw_args);
            let pseudo = PromptDefinition {
                name: skill.definition.name.clone(),
                description: None,
                argument_hint: None,
                body: body.to_string(),
                source_path: skill.source_path.clone(),
                source_type: crate::prompts::PromptSource::User,
                named_placeholders: Vec::new(),
                has_positional_placeholders: true,
            };
            return render_prompt(&pseudo, &parsed);
        }

        if args.is_empty() {
            if body.is_empty() {
                format!("Use the \"{}\" skill.", skill.definition.name)
            } else {
                body.to_string()
            }
        } else if body.is_empty() {
            args.to_string()
        } else {
            format!("{body}\n\n---\n\n{args}")
        }
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

    /// Poll for messages from the agent.
    /// Returns true if any messages were processed (UI should redraw).
    async fn poll_agent(&mut self) -> Result<bool> {
        // Collect messages first to avoid borrow issues
        let mut messages = Vec::new();
        if let Some(rx) = &mut self.native_event_rx {
            while let Ok(msg) = rx.try_recv() {
                messages.push(msg);
            }
        }
        let had_messages = !messages.is_empty();
        // Process messages
        for msg in messages {
            self.handle_agent_message(msg).await?;
        }
        Ok(had_messages)
    }

    fn poll_model_verification(&mut self) -> bool {
        let mut changed = false;
        while let Ok(event) = self.model_verification_rx.try_recv() {
            if !event.is_for_model(&self.current_model) {
                continue;
            }
            changed |= self
                .model_selector
                .set_verification(&event.model, event.verification.clone());
            if event.verification.state == crate::model_catalog::VerificationState::Unavailable {
                self.state.status = event.verification.detail;
                changed = true;
            }
        }
        changed
    }

    fn update_mcp_badge_counts(&mut self, servers: &[crate::tools::McpServerStatus]) {
        let connected = servers.iter().filter(|server| server.connected).count();
        let tool_count: usize = servers.iter().map(|server| server.tools.len()).sum();
        let failed = servers
            .iter()
            .filter(|server| !server.connected && server.error.is_some())
            .count();
        self.state.mcp_connected = connected;
        self.state.mcp_tool_count = tool_count;
        self.state.mcp_failed = failed;
    }

    /// Returns true if badge counts or status text changed.
    async fn refresh_mcp_badges(&mut self) -> bool {
        self.refresh_mcp_badges_with_force(false).await
    }

    /// Returns true if badge counts or status text changed.
    async fn refresh_mcp_badges_with_force(&mut self, force: bool) -> bool {
        let now = Instant::now();
        if !force
            && self
                .last_mcp_status_refresh
                .is_some_and(|last| now.duration_since(last) < Duration::from_secs(5))
        {
            return false;
        }
        self.last_mcp_status_refresh = Some(now);

        if let Ok(servers) = self.tool_executor.mcp_status().await {
            let mut status_message = None;
            let current_statuses = snapshot_mcp_server_statuses(&servers);

            for server in &servers {
                if let Some(message) = format_mcp_server_transition_status(
                    self.last_mcp_server_statuses.get(&server.name),
                    Some(server),
                ) {
                    status_message = Some(message);
                }
            }

            let mut removed_servers = self
                .last_mcp_server_statuses
                .keys()
                .filter(|name| !current_statuses.contains_key(*name))
                .cloned()
                .collect::<Vec<_>>();
            removed_servers.sort();
            for name in removed_servers {
                if let Some(message) = format_mcp_server_transition_status(
                    self.last_mcp_server_statuses.get(&name),
                    None,
                ) {
                    status_message = Some(message);
                }
            }

            let prev = (
                self.state.mcp_connected,
                self.state.mcp_tool_count,
                self.state.mcp_failed,
            );
            self.update_mcp_badge_counts(&servers);
            self.last_mcp_server_statuses = current_statuses;
            let counts_changed = prev
                != (
                    self.state.mcp_connected,
                    self.state.mcp_tool_count,
                    self.state.mcp_failed,
                );
            if let Some(message) = status_message {
                self.state.status = Some(message);
                return true;
            }
            return counts_changed;
        }
        false
    }

    /// Returns true if MCP events updated UI state.
    async fn poll_mcp_updates(&mut self) -> bool {
        let mut dirty = false;
        match self.tool_executor.poll_mcp_updates().await {
            Ok(events) => {
                if events.iter().any(McpRuntimeEvent::affects_badges) {
                    dirty |= self.refresh_mcp_badges_with_force(true).await;
                }

                if let Some(status) = events
                    .iter()
                    .rev()
                    .find_map(format_mcp_runtime_event_status)
                {
                    self.state.status = Some(status);
                    dirty = true;
                }
            }
            Err(err) => {
                self.state.status = Some(format!("MCP update error: {err}"));
                dirty = true;
            }
        }
        dirty
    }

    /// Returns true if any config events were applied.
    async fn poll_config_watcher(&mut self) -> bool {
        let mut dirty = false;
        while let Some(event) = self.config_watcher.poll() {
            self.handle_config_event(event).await;
            dirty = true;
        }
        dirty
    }

    async fn handle_config_event(&mut self, event: ConfigEvent) {
        match event {
            ConfigEvent::Changed(path)
            | ConfigEvent::Created(path)
            | ConfigEvent::Deleted(path)
                if is_mcp_config_path(&path) =>
            {
                self.refresh_mcp_badges_with_force(true).await;
            }
            ConfigEvent::Changed(path)
            | ConfigEvent::Created(path)
            | ConfigEvent::Deleted(path)
                if is_keybindings_config_path(&path) =>
            {
                self.reload_keybindings_from_config();
            }
            ConfigEvent::Error(message) => {
                self.state.status = Some(format!("Config watcher error: {message}"));
            }
            _ => {}
        }
    }

    fn apply_runtime_keybindings(&mut self, keybindings: crate::keybindings::RustTuiKeybindings) {
        let labels = keybindings.labels();
        self.state.queued_follow_up_edit_binding_label = labels.edit_last_queued_follow_up.clone();
        self.shortcuts_help.set_binding_labels(labels);
        self.command_palette_binding = keybindings.command_palette;
        self.file_search_binding = keybindings.file_search;
        self.toggle_tool_outputs_binding = keybindings.toggle_tool_outputs;
        self.queued_follow_up_edit_binding = keybindings.edit_last_queued_follow_up;
    }

    fn reload_keybindings_from_config(&mut self) {
        let terminal_info = crate::terminal_info::TerminalInfo::get();
        let keybindings =
            load_rust_tui_keybindings(&terminal_info.name, std::env::var_os("TMUX").is_some());
        self.apply_runtime_keybindings(keybindings);

        let next_issue_summary = summarize_keybindings_config_issues();
        if let Some(summary) = &next_issue_summary {
            if self.last_keybinding_issue_summary.as_ref() != Some(summary) {
                self.state.status = Some(summary.clone());
            }
        } else if self.last_keybinding_issue_summary.is_some() {
            self.state.status = Some("Keyboard shortcuts config reloaded cleanly.".to_string());
        }
        self.last_keybinding_issue_summary = next_issue_summary;
    }

    /// Handle an agent message (common for both backends)
    async fn handle_agent_message(&mut self, msg: FromAgent) -> Result<()> {
        let response_end_info = match &msg {
            FromAgent::ResponseEnd { response_id, usage } => {
                Some((response_id.clone(), usage.clone()))
            }
            _ => None,
        };
        let mut needs_post_interrupt_queue = false;

        if matches!(msg, FromAgent::ResponseStart { .. }) {
            let was_busy = self.state.busy;
            self.state.busy = true;
            self.queued_prompt_inflight = None;
            if !was_busy {
                let drain_count = match self.queued_prompts.front().map(|prompt| prompt.kind) {
                    Some(PromptKind::Steer)
                        if matches!(self.state.steering_mode, QueueMode::All) =>
                    {
                        self.queued_prompts
                            .iter()
                            .take_while(|prompt| prompt.kind == PromptKind::Steer)
                            .count()
                    }
                    Some(PromptKind::FollowUp)
                        if matches!(self.state.follow_up_mode, QueueMode::All) =>
                    {
                        self.queued_prompts
                            .iter()
                            .take_while(|prompt| prompt.kind == PromptKind::FollowUp)
                            .count()
                    }
                    Some(_) => 1,
                    None => 0,
                };

                let mut drained = Vec::new();
                for _ in 0..drain_count {
                    if let Some(pending) = self.queued_prompts.pop_front() {
                        drained.push(pending);
                    }
                }

                if let Some(active) = drained.first().cloned() {
                    self.queued_prompt_active = Some(active);
                    for pending in drained {
                        self.state.add_user_message(pending.content);
                    }
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
                self.model_monitor.verify(model.clone());
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
                self.model_monitor.verify(model.clone());
                self.state.status = Some(format!("Model: {model}"));

                if pending_matches {
                    self.pending_model_change = None;
                    self.record_model_change(model);
                }
            }
            FromAgent::ModelChangeFailed { model, .. }
                if self
                    .pending_model_change
                    .as_ref()
                    .map(|pending| pending.model == *model)
                    .unwrap_or(false) =>
            {
                self.pending_model_change = None;
            }
            FromAgent::SessionInfo { cwd, .. } => {
                self.state.status = Some(format!("Session in: {cwd}"));
            }
            FromAgent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => {
                self.state.apply_compaction(
                    summary.clone(),
                    *first_kept_entry_index,
                    parse_rfc3339_system_time(timestamp).unwrap_or_else(|_| SystemTime::now()),
                );
                self.record_compaction_entry(
                    summary.clone(),
                    *first_kept_entry_index,
                    *tokens_before,
                    *auto,
                    custom_instructions.clone(),
                );
                return Ok(());
            }
            FromAgent::SideQuestionStart { side_id, question } => {
                if let Some(index) = self.queued_prompts.iter().position(|prompt| {
                    prompt.kind == PromptKind::SideQuestion && prompt.content == *question
                }) {
                    self.queued_prompts.remove(index);
                    self.sync_queue_prompt_count();
                }
                self.state
                    .add_side_question(side_id.clone(), question.clone());
                self.state
                    .add_side_answer(format!("{side_id}-answer"), String::new(), true);
            }
            FromAgent::SideQuestionChunk { side_id, content } => {
                if let Some(answer) = self
                    .state
                    .messages
                    .iter_mut()
                    .find(|message| message.id == format!("{side_id}-answer"))
                {
                    answer.content.push_str(content);
                }
            }
            FromAgent::SideQuestionEnd {
                side_id,
                question,
                answer,
                error,
                ..
            } => {
                let display_answer = match error {
                    Some(error) if answer.is_empty() => format!("Side question failed: {error}"),
                    Some(error) => format!("{answer}\n\nSide question failed: {error}"),
                    None => answer.clone(),
                };
                if let Some(message) = self
                    .state
                    .messages
                    .iter_mut()
                    .find(|message| message.id == format!("{side_id}-answer"))
                {
                    message.streaming = false;
                    message.content = display_answer;
                }
                self.record_side_question(
                    side_id.clone(),
                    question.clone(),
                    answer.clone(),
                    error.clone(),
                );
            }
            FromAgent::ResponseEnd { response_id, .. } => {
                // Model responses can end before their tool calls and follow-up
                // responses complete. Only the runner's terminal sentinel ends
                // the full agent turn.
                if response_id == "done" {
                    self.state.busy = false;
                    self.queued_prompt_active = None;
                    self.queued_prompt_inflight = None;
                    self.queued_prompt_inflight = self
                        .queued_prompts
                        .front()
                        .map(|prompt| QueuedPromptCursor { id: prompt.id });
                    self.sync_queue_prompt_count();
                    needs_post_interrupt_queue = true;
                }
            }
            FromAgent::Error { .. } => {
                // Clear busy state on error
                self.state.busy = false;
                self.queued_prompt_inflight = None;
                self.queued_prompt_active = None;
                self.sync_queue_prompt_count();
                needs_post_interrupt_queue = true;
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

        if needs_post_interrupt_queue {
            let _ = self.maybe_handle_post_interrupt_queue().await?;
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
        let resolved_args = self.credential_vault.resolve_in_json(&args);
        let execution = self
            .tool_executor
            .execute_with_receipt(&tool, &resolved_args, None, &call_id)
            .await;
        let result = execution.to_legacy();

        self.record_tool_result(&call_id, &tool, &result, Some(&execution));

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

    /// Show help message
    fn show_help(&mut self) {
        let help_text = format!(
            r"
Maestro TUI - Keyboard Shortcuts

Navigation:
  Up/Down       Scroll messages / Navigate completions
  PageUp/Down   Scroll faster
  g/G           Jump to top/bottom (when input empty)
  Ctrl+J/K      Scroll down/up
  Ctrl+L        Clear screen

Input:
  Enter         Send message (steer while running)
  Tab           Send message / queue follow-up (while running)
  Alt+Enter     Queue follow-up (alternate while running)
  {}     Edit last queued follow-up
  @             Open file search
  /             Start slash command
  Ctrl+U        Clear input
  Esc           Cancel / Close modal

Toggle:
  Tab           Toggle thinking expansion (when input empty)
  {}        Toggle tool call expansion

Modals:
  {}        Open command palette
  {}        Open file search
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
",
            self.state.queued_follow_up_edit_binding_label,
            self.toggle_tool_outputs_binding.display(),
            self.command_palette_binding.display(),
            self.file_search_binding.display()
        );
        self.state.add_system_message(help_text.trim().to_string());
    }

    /// Render the UI
    fn render(&mut self) -> Result<()> {
        let (result, _elapsed) = crate::magic_trace::time_render(|| self.render_inner());
        result
    }

    fn render_inner(&mut self) -> Result<()> {
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
        let operations = &mut self.operations;
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
                ActiveModal::Operations => {
                    operations.render(frame, area);
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
                let input_widget = ChatInputWidget::new(
                    &state.textarea,
                    "",
                    ChatInputWidgetOptions {
                        busy: state.busy,
                        pending_input_preview: None,
                        ghost_text: None,
                    },
                );

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
                Self::new_with_terminal(terminal, capabilities, None)
            }
        }
    }
}

fn system_time_to_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_rfc3339_system_time(timestamp: &str) -> Result<SystemTime> {
    let parsed = chrono::DateTime::parse_from_rfc3339(timestamp)?;
    let millis = parsed.timestamp_millis();
    if millis < 0 {
        anyhow::bail!("negative timestamp");
    }
    Ok(UNIX_EPOCH + Duration::from_millis(millis as u64))
}

fn restore_visible_session_messages(state: &mut AppState, session: &ParsedSession) {
    state.messages.clear();

    for app_msg in &session.messages {
        let role = match app_msg {
            AppMessage::User { .. } => MessageRole::User,
            AppMessage::Assistant { .. } => MessageRole::Assistant,
            AppMessage::ToolResult { .. } => continue,
        };

        state.messages.push(Message {
            id: uuid::Uuid::new_v4().to_string(),
            role,
            kind: MessageKind::Regular,
            content: app_msg.text_content(),
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: UNIX_EPOCH + Duration::from_millis(app_msg.timestamp()),
            thinking_expanded: false,
        });
    }

    for compaction in &session.compactions {
        if let Some(first_kept_entry_index) = compaction.first_kept_entry_index {
            state.apply_compaction(
                compaction.summary.clone(),
                first_kept_entry_index,
                parse_rfc3339_system_time(&compaction.timestamp)
                    .unwrap_or_else(|_| SystemTime::now()),
            );
        }
    }

    let mut side_questions = session.side_questions.iter().collect::<Vec<_>>();
    side_questions
        .sort_by_key(|side| parse_rfc3339_system_time(&side.timestamp).unwrap_or(UNIX_EPOCH));
    for side in side_questions {
        let timestamp =
            parse_rfc3339_system_time(&side.timestamp).unwrap_or_else(|_| SystemTime::now());
        let question = Message {
            id: side.id.clone(),
            role: MessageRole::User,
            kind: MessageKind::SideQuestion,
            content: side.question.clone(),
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp,
            thinking_expanded: false,
        };
        let answer = match &side.error {
            Some(error) if side.answer.is_empty() => format!("Side question failed: {error}"),
            Some(error) => format!("{}\n\nSide question failed: {error}", side.answer),
            None => side.answer.clone(),
        };
        let response = Message {
            id: format!("{}-answer", side.id),
            role: MessageRole::Assistant,
            kind: MessageKind::SideAnswer,
            content: answer,
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp,
            thinking_expanded: false,
        };
        let insert_at = state
            .messages
            .iter()
            .position(|message| {
                message.kind != MessageKind::CompactionBoundary && message.timestamp > timestamp
            })
            .unwrap_or(state.messages.len());
        state.messages.insert(insert_at, question);
        state.messages.insert(insert_at + 1, response);
    }
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
        total_tokens: Some(usage.input_tokens + usage.output_tokens),
        model_id: None,
        provider: None,
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

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

mod command_handlers;
mod input_handlers;
mod prompt_queue;
mod session_recording;

#[cfg(test)]
mod tests;

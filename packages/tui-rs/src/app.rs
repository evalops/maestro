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
use std::io::Write;
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
    self, KeyCode, KeyEventKind, KeyModifiers as CrosstermModifiers, MouseEventKind,
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
    CredentialVault, ExecutionSource, FromAgent, NativeAgent, NativeAgentConfig, PromptKind,
    ToolExecution, ToolResponseMessage, ToolResult,
};
use crate::ai::AiProvider;
use crate::clipboard::ClipboardManager;
use crate::commands::{
    build_command_registry_with_extensions, BackgroundMonitorAction, CommandAction, CommandOutput,
    CommandRegistry, FooterStyle, LoopAction, ModalType, PlanReviewAction, QueueAction,
    QueueModeKind, SlashCommandMatcher, SlashCycleState,
};
use crate::components::{
    approval_modal_kind, calculate_input_height, ApprovalController, ApprovalDecision,
    ApprovalModal, ApprovalModalKind, ApprovalRequest, BatchedApprovalModal, ChatInputWidget,
    ChatInputWidgetOptions, ChatView, CommandPalette, DetailView, FileSearchModal, ModelSelector,
    OperationsModal, RewindPicker, SessionSwitcher, ShortcutsHelp, ThemeSelector,
};
use crate::config_watcher::{ConfigEvent, ConfigWatcher, ConfigWatcherBuilder};
use crate::files::{get_workspace_files, WorkspaceFile};
use crate::git;
use crate::goal::GoalStore;
use crate::keybindings::load_rust_tui_keybindings;
use crate::keybindings::{is_keybindings_config_path, summarize_keybindings_config_issues};
use crate::mcp::{
    append_mcp_prompt_summary, McpConfigScope, McpPrompt, McpRuntimeEvent, McpTransport,
};
use crate::palette_resource::{PaletteResource, PaletteResourceKind};
use crate::plugins::PluginRegistry;
use crate::prompts::{parse_args, render_prompt, PromptDefinition};
use crate::safety::{
    check_model_allowed, check_path_allowed, check_session_limits,
    guardian::{GuardianError, GuardianVerdict},
    FirewallVerdict,
};
use crate::session::{
    AppMessage, CompactionEntry, ContentBlock as SessionContentBlock, CustomEntry, MessageContent,
    MessageEntry, ModelChange, ParsedSession, PlanReviewComment, PlanReviewEntry, PlanReviewEvent,
    SessionEntry, SessionExporter, SessionHeader, SessionManager, SideQuestionEntry, ThinkingLevel,
    ThinkingLevelChange, TokenCost, TokenUsage as SessionTokenUsage, ToolInfo,
};
use crate::skills::{skills_to_prompt, LoadedSkill, SkillLoadError, SkillLoader, SkillRegistry};
use crate::state::{AppState, Message, MessageKind, MessageRole, QueueMode};
use crate::sync_output::{BeginSynchronizedUpdate, EndSynchronizedUpdate};
use crate::terminal::{self, AppTerminalEvent, TerminalCapabilities, TerminalEventReader};
use crate::tools::{ToolExecutor, ToolRegistry};
use chrono::{Datelike, Utc};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/// A finished guardian review: the pending approval request plus the verdict
/// (or the failure that must fall back to the human modal).
type GuardianReviewOutcome = (ApprovalRequest, Result<GuardianVerdict, GuardianError>);

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
    /// File checkpoint restore picker (double-Esc on empty input)
    RewindPicker,
    /// Full-output detail view (Ctrl+E)
    DetailView,
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
            .watch(home.join(".maestro").join("mcp.json"))
            .watch(home.join(".maestro").join("enterprise").join("mcp.json"))
            .watch(home.join(".maestro").join("keybindings.json"));
    }

    builder
        .watch(".composer/mcp.json")
        .watch(".composer/mcp.local.json")
        .watch(".maestro/mcp.json")
        .watch(".maestro/mcp.local.json")
        .watch(crate::keybindings::keybindings_config_path())
        .build()
        .unwrap_or_default()
}

fn is_mcp_config_path(path: &std::path::Path) -> bool {
    path.ends_with(std::path::Path::new(".composer").join("mcp.json"))
        || path.ends_with(std::path::Path::new(".composer").join("mcp.local.json"))
        || path.ends_with(std::path::Path::new(".maestro").join("mcp.json"))
        || path.ends_with(std::path::Path::new(".maestro").join("mcp.local.json"))
        || path.ends_with(
            std::path::Path::new(".composer")
                .join("enterprise")
                .join("mcp.json"),
        )
        || path.ends_with(
            std::path::Path::new(".maestro")
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
        lines.push(
            "Use `/mcp-config help`, or edit ~/.maestro/mcp.json or .maestro/mcp.json:".to_string(),
        );
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
/// A `/loop` schedule: re-fires a prompt on an interval.
///
/// The loop only fires while the app is idle; a due prompt waits for the
/// current turn to finish rather than interrupting it.
struct LoopSchedule {
    /// Seconds between firings.
    interval: Duration,
    /// The prompt to re-submit.
    prompt: String,
    /// Next time the loop should fire.
    next_fire: Instant,
}

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

    /// Channel sender for approval decisions back to the agent.
    /// The native agent owns ordered execution after approval.
    /// [`ToolResponseMessage`]: (`call_id`, approved, `optional_external_result`,
    /// provenance source).
    tool_response_tx: Option<mpsc::UnboundedSender<ToolResponseMessage>>,

    /// Executes tools (bash commands, file reads, etc.) requested by the agent.
    ///
    /// Shared via `Arc` so tool executions can run on spawned tasks instead of
    /// blocking the event loop (a bash command may run for minutes).
    tool_executor: Arc<ToolExecutor>,

    /// Shared credential vault for the active application session.
    credential_vault: CredentialVault,

    /// The ratatui terminal handle for rendering.
    terminal: terminal::Terminal,

    /// Protocol-aware terminal input. Falls back to crossterm when unavailable.
    terminal_events: Option<TerminalEventReader>,

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

    /// Receiver for the background workspace file scan (startup and
    /// `/refresh-workspace`); polled by the event loop.
    workspace_scan_rx: Option<std::sync::mpsc::Receiver<Vec<WorkspaceFile>>>,

    /// Set by `/refresh-workspace` so scan completion confirms in the status
    /// line (the startup scan stays silent).
    workspace_refresh_pending: bool,

    /// Session history browser modal.
    session_switcher: SessionSwitcher,

    /// Recent persisted tool executions.
    operations: OperationsModal,

    /// Command palette modal (like VS Code's Ctrl+Shift+P).
    command_palette: CommandPalette,

    /// Handles tool execution approval flow.
    approval_controller: ApprovalController,

    /// Native OS sandbox policy resolved at startup (see
    /// `config::resolve_interactive_sandbox_policy`).
    ///
    /// Stored so `spawn_agent` can pass the *same* policy into
    /// `NativeAgentConfig`: the native agent runner's own tool executor
    /// (which actually runs every Yolo-mode call and every allowlisted
    /// Selective-mode call) is entirely separate from `self.tool_executor`
    /// below, which only ever runs approval-gated calls. Without this,
    /// resolving a policy here and applying it only to `self.tool_executor`
    /// sandboxes nothing for the common case (review finding on #3144).
    sandbox_policy: Option<crate::sandbox::SandboxPolicy>,

    /// Optional guardian: an independent LLM reviewer that auto-approves
    /// routine tool calls silently and fails closed to the human modal.
    /// Enabled via `MAESTRO_GUARDIAN=1`; see `safety::guardian`.
    guardian: Option<crate::safety::guardian::Guardian>,

    /// Completion channel for spawned guardian reviews; drained by the event
    /// loop via `poll_guardian_verdicts`.
    guardian_tx: mpsc::UnboundedSender<GuardianReviewOutcome>,
    guardian_rx: mpsc::UnboundedReceiver<GuardianReviewOutcome>,

    /// Call IDs with a guardian review in flight. Cleared on interrupt so a
    /// review that finishes after Ctrl+C cannot auto-execute the tool.
    pending_guardian_reviews: HashSet<String>,

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

    /// File checkpoint restore picker modal.
    rewind_picker: RewindPicker,

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

    /// Droid-style executable slash commands from `.composer/commands/`.
    exec_commands: Vec<crate::exec_commands::ExecCommand>,

    /// Sender side of the exec-command completion channel (cloned into workers).
    exec_command_tx: std::sync::mpsc::Sender<exec_commands::ExecCommandOutcome>,

    /// Receiver polled each frame for finished executable command runs.
    exec_command_rx: std::sync::mpsc::Receiver<exec_commands::ExecCommandOutcome>,

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

    /// Last Esc press used for double-Esc "clear input" detection.
    last_esc_at: Option<Instant>,

    /// Active `/loop` schedule: re-fires a prompt on an interval while the
    /// app is running.
    loop_schedule: Option<LoopSchedule>,

    /// Structured goal mode store (`/goal`).
    goal_store: GoalStore,

    /// When true and the agent is idle, fire one goal continuation prompt.
    /// Armed on create/resume/auto-on, and when the second-model judge says
    /// the goal still needs work.
    goal_auto_continue_armed: bool,

    /// Receiver for background goal-completion judge results.
    goal_judge_rx: Option<std::sync::mpsc::Receiver<crate::goal_judge::GoalJudgeEvent>>,

    /// True while a goal judge agent is running.
    goal_judge_running: bool,

    /// Status-bar density (`/footer rich|solo|history|clear`).
    footer_style: FooterStyle,

    /// Local paths attached via `/attach` or clipboard image paste for the
    /// next `submit_prompt` (cleared after send).
    pending_attachments: Vec<String>,

    /// Last observed MCP server status snapshots for transition messages.
    last_mcp_server_statuses: HashMap<String, crate::tools::McpServerStatus>,

    /// Watches MCP config files so status badges refresh immediately after edits.
    config_watcher: ConfigWatcher,

    /// Pending model change awaiting agent confirmation.
    pending_model_change: Option<PendingModelChange>,

    /// Bounded actor and result channel for selected-model verification.
    model_monitor: crate::model_monitor::ModelMonitor,
    model_verification_rx: std::sync::mpsc::Receiver<crate::model_monitor::ModelVerificationEvent>,

    /// Receiver for a background `/rubber-duck` review; polled by the event loop.
    rubber_duck_rx: Option<std::sync::mpsc::Receiver<crate::rubber_duck::RubberDuckEvent>>,

    /// True while a rubber-duck review task is running.
    rubber_duck_running: bool,

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

    /// Pre-turn file checkpoint awaiting turn completion (git worktrees only).
    pending_checkpoint: Option<crate::checkpoints::PendingTurn>,

    /// Terminal-native turn notifications (OSC 9;4 tab progress, OSC 0 title,
    /// focus-gated desktop notifications).
    terminal_notifier: crate::notifications::TerminalStateNotifier,

    /// Whether `run_inner` started a terminal notification session.
    terminal_session_started: bool,

    /// Full-output detail view overlay (Ctrl+E), when open.
    detail_view: Option<DetailView>,

    /// Modal to restore when the detail view closes (e.g. back to Approval).
    detail_return_modal: ActiveModal,

    /// Last quantized Deixic welcome shimmer frame. Empty chat animates at
    /// [`crate::shimmer::SHIMMER_FPS`] without continuous full-rate idle paints.
    last_welcome_shimmer_frame: u64,
}

/// Build a single, user-facing notice explaining why repo-controlled
/// project config (inline tools, hooks, skills, plugins) was skipped
/// because this workspace isn't trusted.
///
/// Silently dropping a repository's tools/hooks/skills reads as a bug to
/// users, so every one of the four project-scoped load paths is checked
/// here (in addition to logging via `eprintln!` at the point of skipping,
/// for headless/log-based consumption) and folded into one system message
/// shown once at startup / on `/skills reload`. Returns `None` when the
/// workspace is trusted, or when it's untrusted but none of the
/// project-scoped config files/directories exist (nothing to explain).
fn untrusted_workspace_notice(
    workspace_dir: &std::path::Path,
    plugin_registry: &PluginRegistry,
) -> Option<String> {
    if crate::config::workspace_trusted_in_global_config(workspace_dir) {
        return None;
    }

    let mut skipped = Vec::new();
    if crate::tools::inline::has_project_tools_config(workspace_dir) {
        skipped.push(".composer/tools.json (custom tools)");
    }
    if crate::hooks::has_project_hook_config(workspace_dir) {
        skipped.push(".composer/hooks.toml or .json (hooks)");
    }
    if SkillLoader::has_project_skill_dirs(workspace_dir) {
        skipped.push(".agents|.composer|.maestro/skills (skills)");
    }
    let has_skipped_plugins = plugin_registry.untrusted_skip_notice().is_some();
    if has_skipped_plugins {
        skipped.push(".maestro|.composer/plugins (plugins)");
    }

    if skipped.is_empty() {
        return None;
    }

    Some(format!(
        "Workspace untrusted — skipped project config: {}. Run `/trust` (or `maestro-tui trust`) to load them for {}.",
        skipped.join(", "),
        workspace_dir.display()
    ))
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
        let mut app = Self::new_with_terminal(terminal, capabilities, initial_prompt);
        app.initialize_terminal_events();
        Ok(app)
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
        let theme_follow = config
            .tui
            .as_ref()
            .and_then(|tui| tui.theme_follow)
            .unwrap_or(false);
        let mut app = Self::new_with_terminal_with_history(
            terminal,
            capabilities,
            prompt_history,
            initial_prompt,
            context_window,
        );
        app.state.unknown_slash_command_fallback = slash_command_fallback;
        if theme_follow {
            let current = if crate::themes::current_theme_name() == "light" {
                "light"
            } else {
                "dark"
            };
            app.state.theme_follower = Some(crate::themes::osc11::AutoThemeFollower::new(current));
        }
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
        if let Some(notice) = untrusted_workspace_notice(&workspace_dir, &plugin_registry) {
            state.add_system_message(notice);
        }
        let plugin_command_dirs = plugin_registry.command_dirs();
        let custom_prompts =
            crate::prompts::load_prompts_with_plugin_dirs(&workspace_dir, &plugin_command_dirs);
        let exec_commands =
            crate::exec_commands::discover_with_plugin_dirs(&workspace_dir, &plugin_command_dirs);
        let (model_monitor, model_verification_rx) = crate::model_monitor::spawn_model_monitor();

        let app_config = crate::config::load_config(&workspace_dir, None);
        let tui_settings = app_config.tui.clone();

        // Native OS sandbox for the interactive session. See
        // `config::resolve_interactive_sandbox_policy` for the precedence
        // (explicit `MAESTRO_SANDBOX_MODE` > staged-rollout internal gate +
        // persistent config > today's unsandboxed default) and
        // `sandbox::SandboxPolicy::workspace_write_default` for what the
        // resulting policy actually restricts.
        //
        // Stage-1 note: if a policy is requested but the sandbox is
        // unavailable on this host (e.g. Landlock missing, as happens inside
        // some containers), we do not silently fall back to the sandboxed
        // spawn path (every command would fail closed with an opaque error)
        // nor do we build a policy that pretends to work. We tell the user
        // plainly and run the session unsandboxed, exactly as if no policy
        // had been requested. Promoting the interactive default to "on" for
        // everyone (stage 2) must replace this with an approval-gated
        // must-acknowledge flow instead of an automatic fallback — tracked in
        // the stage-2 follow-up issue referenced from the PR that introduced
        // this comment.
        let requested_sandbox_policy =
            crate::config::resolve_interactive_sandbox_policy(&app_config);
        let sandbox_policy = match requested_sandbox_policy {
            Some(_policy) if !crate::sandbox::is_sandbox_available() => {
                let reason = crate::sandbox::sandbox_unavailable_reason()
                    .unwrap_or_else(|| "the native sandbox is unavailable".to_string());
                state.add_system_message(format!(
                    "Native sandboxing was requested for this session but is not available \
                     here: {reason} Running WITHOUT the sandbox for this session instead of \
                     failing every command closed. Fix the environment (or accept this) and \
                     restart to try again."
                ));
                None
            }
            other => other,
        };

        let terminal_notifier = crate::notifications::TerminalStateNotifier::from_config(
            tui_settings.as_ref().and_then(|tui| tui.tab_progress),
            tui_settings.as_ref().and_then(|tui| tui.title_updates),
            tui_settings
                .as_ref()
                .and_then(|tui| tui.focus_gated_notifications),
            std::env::var("TERM_PROGRAM").ok().as_deref(),
        );

        let mut command_registry =
            build_command_registry_with_extensions(&loaded_skills, &custom_prompts);
        let skipped_exec =
            crate::commands::register_exec_commands(&mut command_registry, &exec_commands);
        if !skipped_exec.is_empty() {
            state.add_system_message(exec_commands::exec_collision_warning(&skipped_exec));
        }
        let command_registry = Arc::new(command_registry);
        let slash_matcher = SlashCommandMatcher::new(Arc::clone(&command_registry));
        let (guardian_tx, guardian_rx) = mpsc::unbounded_channel();
        let (exec_command_tx, exec_command_rx) = std::sync::mpsc::channel();

        // Cloned before being consumed below: `spawn_agent` needs the same
        // policy to configure the native agent runner's own tool executor
        // (see the `sandbox_policy` field doc on `App`).
        let stored_sandbox_policy = sandbox_policy.clone();
        let tool_executor = {
            let executor = ToolExecutor::with_credential_vault(&cwd, credential_vault.clone());
            match sandbox_policy {
                Some(policy) => executor.with_sandbox_policy(policy),
                None => executor,
            }
        };

        Self {
            state,
            native_agent: None,
            native_event_rx: None,
            tool_response_tx: None,
            tool_executor: Arc::new(tool_executor),
            credential_vault,
            terminal,
            terminal_events: None,
            should_quit: false,
            capabilities,
            command_palette: CommandPalette::new(Arc::clone(&command_registry)),
            command_registry,
            slash_matcher,
            slash_state: SlashCycleState::new(),
            active_modal: ActiveModal::None,
            file_search: FileSearchModal::new(),
            workspace_files: Vec::new(),
            workspace_scan_rx: None,
            workspace_refresh_pending: false,
            session_switcher: SessionSwitcher::new(&cwd),
            operations: OperationsModal::new(&cwd),
            approval_controller: ApprovalController::new(),
            sandbox_policy: stored_sandbox_policy,
            guardian: crate::safety::guardian::Guardian::from_env(app_config.model),
            guardian_tx,
            guardian_rx,
            pending_guardian_reviews: HashSet::new(),
            session_manager: SessionManager::new(&cwd),
            clipboard: ClipboardManager::new(),
            model_selector: ModelSelector::new(),
            theme_selector: ThemeSelector::new(),
            shortcuts_help: ShortcutsHelp::new_with_binding_labels(keybinding_labels),
            rewind_picker: RewindPicker::new(),
            usage_tracker: crate::usage::UsageTracker::new(),
            prompt_history,
            tool_history: crate::tools::ToolHistory::default(),
            loaded_skills,
            skill_load_errors,
            skill_registry,
            plugin_registry,
            custom_prompts,
            exec_commands,
            exec_command_tx,
            exec_command_rx,
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
            last_esc_at: None,
            loop_schedule: None,
            goal_store: GoalStore::load_default(),
            goal_auto_continue_armed: false,
            goal_judge_rx: None,
            goal_judge_running: false,
            footer_style: crate::ui_prefs::UiPrefs::load_default().footer_style(),
            pending_attachments: Vec::new(),
            last_mcp_server_statuses: HashMap::new(),
            config_watcher: build_mcp_config_watcher(),
            pending_model_change: None,
            model_monitor,
            model_verification_rx,
            rubber_duck_rx: None,
            rubber_duck_running: false,
            current_git_branch: None,
            command_palette_binding: keybindings.command_palette,
            file_search_binding: keybindings.file_search,
            toggle_tool_outputs_binding: keybindings.toggle_tool_outputs,
            queued_follow_up_edit_binding: keybindings.edit_last_queued_follow_up,
            last_keybinding_issue_summary: keybinding_issue_summary,
            editing_queued_follow_up: None,
            submit_queued_steering_after_interrupt: false,
            restore_queued_prompts_after_interrupt: false,
            pending_checkpoint: None,
            terminal_notifier,
            terminal_session_started: false,
            detail_view: None,
            detail_return_modal: ActiveModal::None,
            last_welcome_shimmer_frame: 0,
        }
    }

    /// Get the current viewport top position (for history push).
    pub fn viewport_top(&self) -> u16 {
        self.capabilities.viewport_top
    }

    fn build_base_system_prompt(cwd: &str) -> String {
        // The untrusted-content clause lives in
        // `agent::protocol::UNTRUSTED_CONTENT_POLICY` (single source of
        // truth, embedded here verbatim) so every native runtime sends the
        // same policy — see `ensure_untrusted_content_policy`.
        let policy = crate::agent::UNTRUSTED_CONTENT_POLICY;
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

{policy}

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

    fn initialize_terminal_events(&mut self) {
        if uncurses_input_enabled(std::env::var_os("MAESTRO_UNCURSES_INPUT").as_deref()) {
            self.terminal_events = TerminalEventReader::open().ok();
        }

        if self.state.theme_follower.is_some() {
            if self.terminal_events.is_some() {
                // Discover whether mode 2031 is already active before
                // changing it, so cleanup preserves a parent process's mode.
                let _ = terminal::initialize_theme_reporting();
                self.state.last_theme_query = Some(Instant::now());
            } else if self.capabilities.enhanced_keys {
                // Compatibility path for terminals where uncurses cannot open
                // the controlling tty.
                crate::themes::osc11::apply_auto_theme_from_terminal();
            }
        }
    }

    fn poll_terminal_event(&mut self, timeout: Duration) -> Result<Option<AppTerminalEvent>> {
        if let Some(reader) = &mut self.terminal_events {
            return reader.poll(timeout).map_err(Into::into);
        }
        if event::poll(timeout)? {
            return Ok(AppTerminalEvent::from_crossterm(event::read()?));
        }
        Ok(None)
    }

    fn poll_terminal_theme(&mut self) {
        if !terminal_theme_query_due(
            self.terminal_events.is_some(),
            self.state.theme_follower.is_some(),
            self.state.theme_reporting_available,
            self.state.last_theme_query.map(|last| last.elapsed()),
        ) {
            return;
        }
        let _ = terminal::query_theme();
        self.state.last_theme_query = Some(Instant::now());
    }

    fn apply_terminal_theme_event(&mut self, event: &AppTerminalEvent) -> bool {
        // Theme replies may be unsolicited or left in the input queue from a
        // previous query. They must never override an explicit opt-out.
        if self.state.theme_follower.is_none() {
            return false;
        }
        let next = match event {
            AppTerminalEvent::ColorScheme(scheme) => {
                let next = match scheme {
                    uncurses::event::ColorScheme::Light => "light",
                    uncurses::event::ColorScheme::Dark => "dark",
                };
                self.state.theme_follower =
                    Some(crate::themes::osc11::AutoThemeFollower::new(next));
                Some(next)
            }
            AppTerminalEvent::BackgroundColor { red, green, blue } => {
                let luminance = crate::themes::osc11::relative_luminance(*red, *green, *blue);
                self.state
                    .theme_follower
                    .as_mut()
                    .and_then(|follower| follower.observe_luminance(luminance))
            }
            _ => None,
        };
        let Some(next) = next else {
            return false;
        };
        if crate::themes::current_theme_name() == next {
            return false;
        }
        if crate::themes::set_theme_by_name(next).is_ok() {
            return true;
        }
        false
    }

    /// Run the main event loop.
    ///
    /// # Rust Concept: Async Main Loop
    ///
    /// This function is `async` because the agent communication is async.
    /// The pattern here combines sync operations (terminal rendering, input)
    /// with async operations (agent polling) using a polling approach.
    ///
    /// # Rust Concept: `&mut self`
    ///
    /// Borrowing the App mutably lets the signal wrapper cancel this future,
    /// then retain the App long enough to finish orderly shutdown cleanup.
    ///
    /// # Returns
    ///
    /// Exit code for the process (0 = success, non-zero = error).
    pub async fn run(&mut self) -> Result<i32> {
        let result = self.run_inner().await;
        let disable_theme_reporting = self.prepare_terminal_restore();
        if disable_theme_reporting {
            let _ = terminal::disable_theme_reporting();
        }
        // Restore the terminal unconditionally: an error propagated out of
        // the loop (event poll/read, render, agent poll, ...) must not leave
        // raw mode, bracketed paste, and mouse capture enabled. The panic
        // hook only covers panics, not `?` propagation.
        let restore_result = terminal::restore();
        match (result, restore_result) {
            (Ok(code), Ok(())) => Ok(code),
            (Err(e), _) => Err(e),
            (Ok(_), Err(e)) => Err(e).context("Failed to restore terminal"),
        }
    }

    async fn run_inner(&mut self) -> Result<i32> {
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

        // Save the terminal title and show the idle state (OSC title stack).
        self.terminal_session_started = true;
        let startup_seqs = self.terminal_notifier.session_started();
        Self::write_terminal_sequences(&startup_seqs);

        // Index @-mention files with a bounded, killable scan (see workspace.rs).
        // Kick it off on a background thread so agent spawn is not gated on it.
        self.spawn_workspace_scan();

        // Spawn the agent (async operation).
        // This creates the channels and starts the agent task.
        self.spawn_agent().await?;

        // Grok-style trailing prompt: submit after the agent is ready.
        if let Some(prompt) = self.initial_prompt.take() {
            let _ = self.submit_prompt(prompt).await;
        }

        // Main event loop - runs until should_quit is set to true.
        // Only repaint when something changed (or while busy for spinners).
        // Idle 20Hz full-buffer diffs were the top cost after FS badge work
        // (perf on developer@dev-desktop → ratatui Buffer::diff / unicode_width).
        let mut needs_redraw = true;
        loop {
            // Apply workspace scan results as soon as they arrive (non-blocking).
            if self.poll_workspace_scan() {
                needs_redraw = true;
            }

            // Apply finished executable slash command runs (non-blocking).
            if self.poll_exec_commands() {
                needs_redraw = true;
            }

            // Empty chat runs the Deixic welcome sheen; advance paint only when
            // the quantized shimmer frame changes (~12 fps), not every idle tick.
            let welcome_animating = self.state.messages.is_empty() && !self.state.busy;
            if welcome_animating {
                let frame = crate::shimmer::shimmer_frame();
                if frame != self.last_welcome_shimmer_frame {
                    self.last_welcome_shimmer_frame = frame;
                    needs_redraw = true;
                }
            }

            // Poll for terminal events. Shorter timeout while busy (animations)
            // or while the empty welcome sheen is active; longer while idle.
            let poll_ms = if self.state.busy || welcome_animating {
                33
            } else {
                100
            };
            self.poll_terminal_theme();
            if let Some(event) =
                self.poll_terminal_event(std::time::Duration::from_millis(poll_ms))?
            {
                match event {
                    AppTerminalEvent::Key(key) if should_handle_key_event(key.kind) => {
                        self.handle_key(key.code, key.modifiers).await?;
                        needs_redraw = true;
                    }
                    AppTerminalEvent::Mouse(mouse) => {
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
                            MouseEventKind::Down(crossterm::event::MouseButton::Left)
                                if self.slash_state.has_completions() =>
                            {
                                // Click-to-select on the slash completion popup.
                                if let Ok(size) = self.terminal.size() {
                                    let area = Rect::new(0, 0, size.width, size.height);
                                    let popup = Self::slash_popup_area(
                                        area,
                                        self.slash_state.completions().len(),
                                    );
                                    let in_x = mouse.column >= popup.x
                                        && mouse.column < popup.x + popup.width;
                                    let in_y = mouse.row > popup.y
                                        && mouse.row < popup.y + popup.height - 1;
                                    if in_x && in_y {
                                        let offset = self.slash_state.list_state_mut().offset();
                                        let index = offset + (mouse.row - popup.y - 1) as usize;
                                        self.slash_state.select(index);
                                        self.apply_slash_completion();
                                        self.update_slash_state();
                                        needs_redraw = true;
                                    }
                                }
                            }
                            _ => {} // Ignore other mouse events
                        }
                    }
                    AppTerminalEvent::Resize { height } => {
                        self.handle_resize(height)?;
                        needs_redraw = true;
                    }
                    // Bracketed paste: route to the open modal's text input,
                    // or to the main input (large pastes fold into a
                    // `[Pasted: N lines]` display chip).
                    AppTerminalEvent::Paste(text) => {
                        self.handle_paste(&text);
                        needs_redraw = true;
                    }
                    AppTerminalEvent::FocusGained => {
                        self.terminal_notifier.record_focus(true);
                    }
                    AppTerminalEvent::FocusLost => {
                        self.terminal_notifier.record_focus(false);
                    }
                    AppTerminalEvent::ThemeReportingStatus(setting) => {
                        self.state.theme_reporting_available = setting.is_available();
                        if setting == uncurses::ansi::mode::ModeSetting::Reset {
                            let _ = terminal::enable_theme_reporting();
                        }
                    }
                    theme_event @ (AppTerminalEvent::BackgroundColor { .. }
                    | AppTerminalEvent::ColorScheme(_)) => {
                        needs_redraw |= self.apply_terminal_theme_event(&theme_event);
                    }
                    _ => {}
                }
            }

            // Poll for messages from the agent (async operation).
            // This handles streaming responses, tool calls, etc.
            let agent_activity = self.poll_agent().await?;
            if agent_activity {
                needs_redraw = true;
            }

            // Apply finished guardian reviews (spawned per approval request).
            if self.poll_guardian_verdicts().await? {
                needs_redraw = true;
            }

            if self.poll_model_verification() {
                needs_redraw = true;
            }

            if self.poll_rubber_duck() {
                needs_redraw = true;
            }

            if self.poll_goal_judge() {
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

            // Fire a due /loop prompt. Loops never interrupt a running turn:
            // a due prompt waits for idle and then submits.
            let loop_prompt = if self.state.busy {
                None
            } else {
                self.loop_schedule.as_mut().and_then(|schedule| {
                    if Instant::now() >= schedule.next_fire {
                        schedule.next_fire = Instant::now() + schedule.interval;
                        Some(schedule.prompt.clone())
                    } else {
                        None
                    }
                })
            };
            if let Some(prompt) = loop_prompt {
                self.state.status.replace(format!("Loop: \"{prompt}\""));
                self.submit_prompt(prompt).await?;
                needs_redraw = true;
            }

            // Goal auto-continue: only after create/resume or a judge
            // "continue" verdict. Skip when busy, judging, loop, or queue.
            let queue_or_loop_busy = self.loop_schedule.is_some()
                || !self.queued_prompts.is_empty()
                || self.queued_prompt_inflight.is_some()
                || self.queued_prompt_active.is_some();
            if !self.state.busy
                && !self.goal_judge_running
                && !queue_or_loop_busy
                && self.goal_auto_continue_armed
                && self.goal_store.should_auto_continue()
            {
                if let Some(prompt) = self.goal_store.continuation_prompt() {
                    self.goal_auto_continue_armed = false;
                    match self.goal_store.note_auto_continue_submitted() {
                        Ok(hit_cap) => {
                            if hit_cap {
                                let max = self
                                    .goal_store
                                    .current
                                    .as_ref()
                                    .map(|g| g.max_turns)
                                    .unwrap_or(0);
                                self.state.status.replace(format!(
                                    "Goal auto-continue stopped (safety max {max})"
                                ));
                                self.state.add_system_message(format!(
                                    "Goal auto-continue hit safety max_turns={max}. \
                                     Completion is normally judged by a second model; this cap only prevents runaway loops. \
                                     Use `/goal resume` or `/goal auto on` to re-arm."
                                ));
                            } else {
                                self.state.status.replace("Goal auto-continue".to_string());
                                self.submit_prompt(prompt).await?;
                            }
                            needs_redraw = true;
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Goal auto-continue failed: {e}"));
                            needs_redraw = true;
                        }
                    }
                } else {
                    self.goal_auto_continue_armed = false;
                }
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

        // Clear tab progress and restore the original terminal title.
        let shutdown_seqs = self.terminal_session_ended_sequences();
        Self::write_terminal_sequences(&shutdown_seqs);

        // Terminal restore happens in `run`, which wraps this inner loop so
        // the terminal is restored even when the loop exits with an error.
        Ok(0)
    }

    /// Handle a terminal resize: recompute viewport capabilities (PageUp/
    /// PageDown step size) and resize the inline viewport itself.
    fn handle_resize(&mut self, height: u16) -> Result<()> {
        if self.update_viewport_capabilities(height) {
            // ratatui's inline viewport height is fixed at construction, so
            // growing/shrinking it requires rebuilding the Terminal around
            // the same device handle. Width-only changes are handled by
            // ratatui's autoresize on the next draw.
            self.terminal = terminal::recreate_with_viewport(self.capabilities.viewport_height)?;
        }
        Ok(())
    }

    /// Recompute viewport capabilities for a new terminal height.
    /// Returns true when they changed.
    fn update_viewport_capabilities(&mut self, height: u16) -> bool {
        let (viewport_top, viewport_height) = terminal::calculate_viewport(height);
        let changed = viewport_top != self.capabilities.viewport_top
            || viewport_height != self.capabilities.viewport_height;
        self.capabilities.viewport_top = viewport_top;
        self.capabilities.viewport_height = viewport_height;
        changed
    }

    /// Scan workspace files on a background thread.
    ///
    /// The `rg --files --follow` scan of the whole cwd can take seconds, so
    /// it must never run on the UI thread; the event loop polls the receiver
    /// via `poll_workspace_scan` and applies the result when it arrives.
    fn spawn_workspace_scan(&mut self) {
        let (workspace_tx, workspace_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("maestro-workspace-scan".into())
            .spawn(move || {
                let cwd = std::env::current_dir().unwrap_or_default();
                let files = get_workspace_files(&cwd, 10_000);
                let _ = workspace_tx.send(files);
            })
            .ok();
        self.workspace_scan_rx = Some(workspace_rx);
    }

    /// Apply background workspace scan results as soon as they arrive
    /// (non-blocking). Returns true when the file list changed.
    fn poll_workspace_scan(&mut self) -> bool {
        let Some(rx) = self.workspace_scan_rx.take() else {
            return false;
        };
        match rx.try_recv() {
            Ok(files) => {
                self.workspace_files.clone_from(&files);
                self.file_search.set_files(files);
                if std::mem::take(&mut self.workspace_refresh_pending) {
                    self.state.status = Some("Workspace files refreshed".to_string());
                }
                true
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.workspace_refresh_pending = false;
                false
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                self.workspace_scan_rx = Some(rx);
                false
            }
        }
    }

    /// Spawn the native Rust agent
    async fn spawn_agent(&mut self) -> Result<()> {
        let cwd_path = std::env::current_dir().unwrap_or_default();
        let cwd = cwd_path.to_string_lossy().to_string();

        // Detect git branch
        let git_branch = git::current_branch(&cwd_path);
        self.current_git_branch = git_branch.clone();

        // Codex ChatGPT login (CODEX_HOME/auth.json) wins when present and no
        // explicit MAESTRO_MODEL is set — see codex_auth::resolve_default_model.
        let _codex_auth = crate::codex_auth::apply_codex_auth_to_process_env();
        let model = crate::codex_auth::resolve_default_model();

        let (history, session_id, thinking_level) = self.agent_context_for_spawn();
        let (thinking_enabled, thinking_budget) = thinking_level.to_config();
        let config = NativeAgentConfig {
            model: model.clone(),
            max_tokens: 16384,
            system_prompt: Some(self.build_system_prompt()),
            thinking_enabled,
            thinking_budget,
            cwd: cwd.clone(),
            approval_mode: self.state.approval_mode,
            // See the `sandbox_policy` field doc on `App`: without this,
            // only calls that reach the human approval modal (via
            // `self.tool_executor`, a separate executor) were ever
            // sandboxed. Yolo mode and Selective mode's allowlisted calls
            // run through the native agent runner's own executor instead.
            sandbox_policy: self.sandbox_policy.clone(),
        };

        let policy_model = policy_model_id(&model);
        if let Some(reason) = check_model_allowed(&policy_model) {
            self.state.error = Some(reason);
            return Ok(());
        }

        self.current_model = model.clone();
        self.state.thinking_level = thinking_level;
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
                    // Startup session restore runs before the agent exists. Queue
                    // the copied conversation before any initial prompt so a
                    // fork continues with the same model context.
                    agent.replace_history(history);
                    agent.send_ready();
                    // Send session info with git branch
                    agent.send_session_info(&cwd, session_id, git_branch);
                    let _ = agent.set_steering_mode(self.state.steering_mode);
                    let _ = agent.set_follow_up_mode(self.state.follow_up_mode);
                }

                // Ensure busy is false so user can type
                self.state.busy = false;
                self.state.model = Some(model.clone());
                self.state.status = Some(format!("Ready: {model}"));
            }
            Err(e) => {
                let mut message = format!("Failed to create agent: {e}");
                if crate::codex_auth::read_codex_auth().is_none()
                    && std::env::var_os("OPENAI_API_KEY").is_none()
                    && std::env::var_os("OPENAI_CODEX_TOKEN").is_none()
                {
                    message
                        .push_str(" — run `maestro codex login` (ChatGPT) or set OPENAI_API_KEY.");
                }
                self.state.error = Some(message);
            }
        }

        Ok(())
    }

    fn agent_context_for_spawn(&self) -> (Vec<crate::ai::Message>, Option<String>, ThinkingLevel) {
        let history = self
            .state
            .messages
            .iter()
            .filter(|message| message.kind == MessageKind::Regular)
            .filter_map(|message| match message.role {
                MessageRole::User => Some(crate::ai::Message {
                    role: crate::ai::Role::User,
                    content: crate::ai::MessageContent::text(message.content.clone()),
                }),
                MessageRole::Assistant if message.is_assistant_reply() => {
                    Some(crate::ai::Message {
                        role: crate::ai::Role::Assistant,
                        content: crate::ai::MessageContent::text(message.content.clone()),
                    })
                }
                _ => None,
            })
            .collect();
        (
            history,
            self.state.session_id.clone(),
            self.current_thinking_level,
        )
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
        if let Some(notice) = untrusted_workspace_notice(&workspace_dir, &self.plugin_registry) {
            self.state.add_system_message(notice);
        }
        let plugin_command_dirs = self.plugin_registry.command_dirs();
        self.custom_prompts =
            crate::prompts::load_prompts_with_plugin_dirs(&workspace_dir, &plugin_command_dirs);
        self.exec_commands =
            crate::exec_commands::discover_with_plugin_dirs(&workspace_dir, &plugin_command_dirs);
        self.rebuild_slash_registry();
    }

    fn rebuild_slash_registry(&mut self) {
        let mut registry =
            build_command_registry_with_extensions(&self.loaded_skills, &self.custom_prompts);
        let skipped_exec =
            crate::commands::register_exec_commands(&mut registry, &self.exec_commands);
        if !skipped_exec.is_empty() {
            self.state
                .add_system_message(exec_commands::exec_collision_warning(&skipped_exec));
        }
        let registry = Arc::new(registry);
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

    /// Push `state.approval_mode` to the native agent.
    ///
    /// The agent is the sole owner of the approve/auto-execute decision (see
    /// the `FromAgent::ToolCall` handler in `poll_agent`); call this
    /// wherever `state.approval_mode` changes so the agent's inline gate
    /// never runs a stale mode against the one shown in the UI.
    pub(super) fn sync_agent_approval_mode(&mut self) {
        if let Some(agent) = &self.native_agent {
            let _ = agent.set_approval_mode(self.state.approval_mode);
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

    /// Poll the background `/rubber-duck` review channel and post the finished
    /// review (or failure) into the chat as a system message.
    fn poll_rubber_duck(&mut self) -> bool {
        let mut events = Vec::new();
        let mut disconnected = false;
        if let Some(rx) = &self.rubber_duck_rx {
            loop {
                match rx.try_recv() {
                    Ok(event) => events.push(event),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        if events.is_empty() && !disconnected {
            return false;
        }
        self.rubber_duck_rx = None;
        self.rubber_duck_running = false;
        self.state.status = None;
        if events.is_empty() {
            // Sender dropped without a result: the review task died early.
            self.state.add_system_message(
                "Rubber duck review failed: the review task exited without reporting a result."
                    .to_string(),
            );
            return true;
        }
        for event in events {
            match event {
                crate::rubber_duck::RubberDuckEvent::Completed { model, review } => {
                    self.state.add_system_message(format!(
                        "## Rubber duck review (model: {model})\n\n{review}"
                    ));
                }
                crate::rubber_duck::RubberDuckEvent::Failed { model, message } => {
                    self.state.add_system_message(format!(
                        "Rubber duck review failed (model: {model}): {message}"
                    ));
                }
            }
        }
        true
    }

    /// Start a second-model goal completion judge after a worker turn.
    ///
    /// The judge (not a fixed turn count) decides whether to auto-continue.
    fn start_goal_judge(&mut self) {
        if self.goal_judge_running {
            return;
        }
        if !self.goal_store.should_auto_continue() {
            return;
        }
        let Some(goal) = self.goal_store.current.clone() else {
            return;
        };
        let worker = if self.current_model.is_empty() {
            self.state
                .model
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        } else {
            self.current_model.clone()
        };
        let judge_model = match crate::rubber_duck::pick_review_model(&worker, None) {
            Ok(model) => model,
            Err(message) => {
                self.goal_auto_continue_armed = false;
                let _ = self.goal_store.set_auto_continue(false);
                self.state.add_system_message(format!(
                    "Goal judge unavailable ({message}). Auto-continue paused. \
                     Configure another model, or use `/goal complete` / `/goal resume`."
                ));
                return;
            }
        };

        let transcript = self.goal_transcript_excerpt();
        let cwd = self.state.cwd.clone().unwrap_or_else(|| ".".to_string());
        let (tx, rx) = std::sync::mpsc::channel();
        self.goal_judge_rx = Some(rx);
        self.goal_judge_running = true;
        self.state
            .status
            .replace(format!("Goal judge ({judge_model})…"));
        self.state.add_system_message(format!(
            "Goal judge started with **{judge_model}** (worker: {worker}). \
             Auto-continue continues only if this model says the goal is incomplete."
        ));
        tokio::spawn(crate::goal_judge::run_judge(
            crate::goal_judge::GoalJudgeRequest {
                model: judge_model,
                cwd,
                worker_model: worker,
                goal_id: goal.id,
                goal_text: goal.text,
                success_criteria: goal.success_criteria,
                transcript,
            },
            tx,
        ));
    }

    /// Recent user/assistant text for the goal judge prompt.
    fn goal_transcript_excerpt(&self) -> String {
        use crate::state::MessageRole;
        let mut lines: Vec<(String, String)> = Vec::new();
        for message in &self.state.messages {
            if message.content.trim().is_empty() {
                continue;
            }
            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant if message.is_assistant_reply() => "assistant",
                _ => continue,
            };
            // Skip the synthetic goal continuation system-ish prompts' noise is fine.
            let content: String = message.content.chars().take(4_000).collect();
            lines.push((role.to_string(), content));
        }
        // Keep the most recent ~30 role turns.
        let start = lines.len().saturating_sub(30);
        crate::goal_judge::format_transcript_lines(&lines[start..])
    }

    /// Apply finished goal-judge events: continue, complete, or block.
    fn poll_goal_judge(&mut self) -> bool {
        let mut events = Vec::new();
        let mut disconnected = false;
        if let Some(rx) = &self.goal_judge_rx {
            loop {
                match rx.try_recv() {
                    Ok(event) => events.push(event),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        if events.is_empty() && !disconnected {
            return false;
        }
        self.goal_judge_rx = None;
        self.goal_judge_running = false;
        if events.is_empty() {
            self.goal_auto_continue_armed = false;
            let _ = self.goal_store.set_auto_continue(false);
            self.state.add_system_message(
                "Goal judge failed: task exited without a result. Auto-continue paused.".into(),
            );
            return true;
        }
        for event in events {
            match event {
                crate::goal_judge::GoalJudgeEvent::Decided { model, verdict } => {
                    let reason = if verdict.reason.is_empty() {
                        "(no reason)".to_string()
                    } else {
                        verdict.reason.clone()
                    };
                    let _ = self
                        .goal_store
                        .set_last_judge_reason(format!("{}: {reason}", verdict.decision.as_str()));
                    match verdict.decision {
                        crate::goal_judge::GoalJudgeDecision::Continue => {
                            self.state.add_system_message(format!(
                                "## Goal judge ({model}): **continue**\n\n{reason}"
                            ));
                            if self.goal_store.should_auto_continue() {
                                self.goal_auto_continue_armed = true;
                                self.state
                                    .status
                                    .replace("Goal: judge says continue".into());
                            }
                        }
                        crate::goal_judge::GoalJudgeDecision::Complete => {
                            self.goal_auto_continue_armed = false;
                            match self.goal_store.complete() {
                                Ok(done) => {
                                    self.state.add_system_message(format!(
                                        "## Goal judge ({model}): **complete**\n\n{reason}\n\n\
                                         Goal {} marked complete.\n\n{}",
                                        done.id, done.text
                                    ));
                                    self.state
                                        .status
                                        .replace(format!("Goal {} complete (judge)", done.id));
                                }
                                Err(e) => {
                                    self.state.error =
                                        Some(format!("Judge said complete but store failed: {e}"));
                                }
                            }
                        }
                        crate::goal_judge::GoalJudgeDecision::Blocked => {
                            self.goal_auto_continue_armed = false;
                            match self.goal_store.block(Some(reason.clone())) {
                                Ok(goal) => {
                                    self.state.add_system_message(format!(
                                        "## Goal judge ({model}): **blocked**\n\n{reason}"
                                    ));
                                    self.state
                                        .status
                                        .replace(format!("Goal {} blocked (judge)", goal.id));
                                }
                                Err(e) => {
                                    self.state.error =
                                        Some(format!("Judge said blocked but store failed: {e}"));
                                }
                            }
                        }
                    }
                }
                crate::goal_judge::GoalJudgeEvent::Failed { model, message } => {
                    self.goal_auto_continue_armed = false;
                    let _ = self.goal_store.set_auto_continue(false);
                    self.state.add_system_message(format!(
                        "Goal judge failed (model: {model}): {message}\n\n\
                         Auto-continue paused. Use `/goal resume` to try again, or `/goal complete` / `/goal block`."
                    ));
                    self.state.status.replace("Goal judge failed".into());
                }
            }
        }
        true
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

    /// Cancel the current native-agent operation and wait until its request,
    /// approval, and foreground-tool cleanup are all quiescent. The
    /// repeat-signal monitor remains the escape hatch if cleanup wedges.
    pub(crate) async fn signal_shutdown_teardown(&mut self) -> (Vec<String>, bool) {
        if let Some(agent) = self.native_agent.take() {
            agent.shutdown().await;
        }
        self.drain_agent_events_after_shutdown().await;
        let disable_theme_reporting = self.prepare_terminal_restore();
        (
            self.terminal_session_ended_sequences(),
            disable_theme_reporting,
        )
    }

    /// Apply every event the agent published before its shutdown barrier
    /// completed. The runner owns the last event sender, so after
    /// `NativeAgent::shutdown` returns this channel is closed and `try_recv`
    /// drains a stable, finite suffix.
    ///
    /// Post-interrupt queue submission and immediate terminal notifications
    /// are intentionally disabled: signal teardown must persist terminal
    /// events without starting another request or blocking the async
    /// repeat-signal monitor on terminal I/O. The caller writes the final
    /// terminal-session sequences from its blocking cleanup.
    async fn drain_agent_events_after_shutdown(&mut self) {
        let mut messages = Vec::new();
        if let Some(rx) = &mut self.native_event_rx {
            while let Ok(message) = rx.try_recv() {
                messages.push(message);
            }
        }
        for message in messages {
            if let Err(error) = self
                .handle_agent_message_with_options(message, false, false)
                .await
            {
                self.state.error = Some(format!(
                    "Failed to finalize an agent event during shutdown: {error}"
                ));
            }
        }
    }

    /// Stop protocol-aware reads before terminal restoration and report
    /// whether mode 2031 must be disabled by the caller's blocking cleanup.
    ///
    /// Signal cleanup invokes this after cancelling the run future; app
    /// construction cleanup also invokes it on an app completed after the
    /// signal won. Keeping this synchronous lets both paths drop the tty
    /// reader before any restore while moving terminal writes off the async
    /// worker.
    pub(crate) fn prepare_terminal_restore(&mut self) -> bool {
        let had_terminal_events = self.terminal_events.take().is_some();
        terminal_reporting_shutdown_needed(had_terminal_events, self.state.theme_follower.is_some())
    }

    fn terminal_session_ended_sequences(&mut self) -> Vec<String> {
        if !self.terminal_session_started {
            return Vec::new();
        }
        self.terminal_session_started = false;
        self.terminal_notifier.session_ended()
    }

    /// Write terminal-notification escape sequences (OSC progress/title) to
    /// the terminal device. No-ops when the terminal is not initialized.
    pub(crate) fn write_terminal_sequences(seqs: &[String]) {
        if !seqs.is_empty() {
            let _ = terminal::write_raw(&seqs.concat());
        }
    }

    /// Emit the turn-start terminal state: indeterminate tab progress and the
    /// working title.
    fn notify_terminal_turn_started(&mut self) {
        let seqs = self.terminal_notifier.turn_started();
        Self::write_terminal_sequences(&seqs);
    }

    /// Emit the turn-end terminal state: clear tab progress, restore the idle
    /// title, and send the desktop notification unless the focus gate
    /// suppresses it (terminal focused).
    fn notify_terminal_turn_finished(&mut self) {
        let seqs = self.terminal_notifier.turn_finished();
        Self::write_terminal_sequences(&seqs);
        if self.terminal_notifier.should_send_desktop_notification() {
            crate::notifications::notify_turn_complete();
        }
    }

    async fn handle_agent_message(&mut self, msg: FromAgent) -> Result<()> {
        self.handle_agent_message_with_options(msg, true, true)
            .await
    }

    async fn handle_agent_message_with_options(
        &mut self,
        msg: FromAgent,
        allow_post_interrupt_queue: bool,
        allow_terminal_notifications: bool,
    ) -> Result<()> {
        let response_end_info = match &msg {
            FromAgent::ResponseEnd { response_id, usage } => {
                Some((response_id.clone(), usage.clone()))
            }
            _ => None,
        };
        let native_tool_completion = match &msg {
            FromAgent::ToolEnd {
                call_id,
                success,
                result,
                receipt,
            } => self.tool_history.get(call_id).map(|execution| {
                (
                    call_id.clone(),
                    execution.tool_name.clone(),
                    *success,
                    result.clone(),
                    receipt.clone(),
                )
            }),
            _ => None,
        };
        let mut needs_post_interrupt_queue = false;

        if matches!(msg, FromAgent::ResponseStart { .. }) {
            let was_busy = self.state.busy;
            self.state.busy = true;
            self.queued_prompt_inflight = None;
            if !was_busy && allow_terminal_notifications {
                self.notify_terminal_turn_started();
            }
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
            FromAgent::ResponseEnd { response_id, .. } if response_id == "done" => {
                // Model responses can end before their tool calls and follow-up
                // responses complete. Only the runner's terminal sentinel ends
                // the full agent turn.
                self.state.busy = false;
                if allow_terminal_notifications {
                    self.notify_terminal_turn_finished();
                }
                self.finalize_file_checkpoint();
                self.queued_prompt_active = None;
                self.queued_prompt_inflight = None;
                self.queued_prompt_inflight = self
                    .queued_prompts
                    .front()
                    .map(|prompt| QueuedPromptCursor { id: prompt.id });
                self.sync_queue_prompt_count();
                needs_post_interrupt_queue = true;
                // After a successful worker turn, a *different* model judges
                // whether the goal is complete. That verdict (not turn count)
                // decides whether to auto-continue.
                if self.goal_store.should_auto_continue() {
                    self.start_goal_judge();
                }
            }
            FromAgent::ResponseEnd { .. } => {}
            FromAgent::Error { .. } => {
                // Clear busy state on error
                self.state.busy = false;
                if allow_terminal_notifications {
                    self.notify_terminal_turn_finished();
                }
                self.finalize_file_checkpoint();
                self.queued_prompt_inflight = None;
                self.queued_prompt_active = None;
                self.sync_queue_prompt_count();
                needs_post_interrupt_queue = true;
                // Do not auto-continue after an error; user must re-arm via
                // /goal resume or a successful create.
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
                approval_inline_env,
            } => {
                self.tool_history.start_with_approval(
                    call_id.clone(),
                    tool.clone(),
                    args.clone(),
                    *requires_approval,
                );
                // Unknown tool name -> deny immediately
                if !self.tool_executor.has_tool(tool) && approval_inline_env.is_none() {
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

                // The native agent is the single owner of the approve/execute
                // decision: it already applied `self.state.approval_mode`
                // (kept in sync via `sync_agent_approval_mode`) to the same
                // Yolo/Safe/Selective gate before emitting this event, and if
                // `requires_approval` is false it has ALREADY executed the
                // tool inline and will report the result to the model itself
                // (see `NativeAgentRunner::run_loop` in `agent/native.rs`).
                //
                // Recomputing that decision here from `self.state` -- as this
                // used to do -- let the two sides disagree: in Safe mode the
                // agent (mode-unaware) would auto-execute while this recomputed
                // `true` and popped an approval modal for an already-finished
                // call, and Deny had nowhere to go (issue #3149). In Selective
                // mode both sides agreed `false` and both executed the tool,
                // running side effects (e.g. bash) twice (issue #3156).
                //
                // This mirrors the same rule the headless server already
                // enforces (see the module doc on `headless_server.rs`).
                if *requires_approval {
                    let mut request =
                        ApprovalRequest::new(call_id.clone(), tool.clone(), args.clone());
                    let firewall_reason = match &firewall_verdict {
                        FirewallVerdict::RequireApproval { reason } => Some(reason.clone()),
                        _ => None,
                    };
                    let bypass_requested = tool.eq_ignore_ascii_case("bash")
                        && args
                            .get("bypass_sandbox")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true);
                    // Make the sandbox escape hatch a thing the user is
                    // explicitly asked about, not a generic bash approval
                    // that happens to look the same as any other — and never
                    // let a firewall reason hide it: approving this call also
                    // removes the native sandbox, which the modal must say
                    // even when the firewall already gave a reason.
                    let bypass_reason = bypass_requested.then(|| {
                        "Agent is asking to run this command WITHOUT Maestro's native \
                         sandbox (a sandboxed attempt likely just failed)."
                            .to_string()
                    });
                    if let Some(reason) = combine_approval_reason(firewall_reason, bypass_reason) {
                        request = request.with_reason(reason);
                    }
                    // Inline tools (`.composer/tools.json`) resolve their entire
                    // shell command from the tool's own config, not from the
                    // call's JSON arguments. Without this, `display_command()`'s
                    // args-based fallback has nothing to show and the dialog
                    // renders as `tool_name: {}` -- approving a command the user
                    // never actually saw. Populate the real command (and where
                    // it came from) so the dialog can't hide it.
                    if let Some(inline_context) = approval_inline_env.as_ref() {
                        request = request.with_inline_tool_source(
                            inline_context.command.clone(),
                            &inline_context.source_path,
                            &inline_context.source_label,
                            Some(&inline_context.cwd),
                            &inline_context.environment,
                        );
                        request = request
                            .with_inline_shell(&inline_context.shell, &inline_context.shell_arg);
                    } else if self.tool_executor.get_inline_tool(tool).is_some() {
                        let note = format!(
                            "Skipped inline tool '{tool}': approval environment snapshot \
was missing; retry to review the exact execution context."
                        );
                        self.state.add_system_message(note);
                        self.state.handle_agent_message(msg.clone());
                        self.state
                            .fail_tool_call(call_id, "Missing approval environment snapshot");
                        self.handle_tool_approval(
                            call_id.clone(),
                            tool.clone(),
                            args.clone(),
                            false,
                        )
                        .await?;
                        return Ok(());
                    }

                    // Guardian mode: an independent LLM reviews the request first;
                    // allow executes silently, anything else falls back to the modal.
                    if !self.spawn_guardian_review(&request) {
                        // Queue approval
                        self.approval_controller.enqueue(request);
                        // Show approval modal
                        self.active_modal = ActiveModal::Approval;
                    }
                } else {
                    // Already auto-executed inline by the native agent above;
                    // do not execute it again. Just record the approval flag
                    // for the tool-history UI.
                    self.tool_history.record_approval(call_id, true);
                }
            }
            _ => {}
        }
        self.state.handle_agent_message(msg);

        if let Some((call_id, tool, success, result, receipt)) = native_tool_completion {
            self.record_native_tool_completion(&call_id, &tool, success, result, receipt);
        }

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

        if needs_post_interrupt_queue && allow_post_interrupt_queue {
            let _ = self.maybe_handle_post_interrupt_queue().await?;
        }
        Ok(())
    }

    /// Complete a tool that the native agent executed.
    fn record_native_tool_completion(
        &mut self,
        call_id: &str,
        tool: &str,
        success: bool,
        result: Option<ToolResult>,
        receipt: Option<crate::agent::ExecutionReceipt>,
    ) {
        let output = self
            .state
            .messages
            .iter()
            .rev()
            .flat_map(|message| message.tool_calls.iter())
            .find(|call| call.call_id == call_id)
            .map_or_else(String::new, |call| call.output.clone());
        let result = result.unwrap_or_else(|| {
            let error = (!success).then(|| {
                if output.is_empty() {
                    "Tool execution failed".to_string()
                } else {
                    output.clone()
                }
            });
            ToolResult {
                success,
                output,
                error,
                details: None,
            }
        });
        let execution = receipt.map(|receipt| {
            let mut execution =
                ToolExecution::from_legacy(call_id, tool, receipt.source, result.clone());
            execution.receipt = receipt;
            execution
        });

        self.record_tool_result(call_id, tool, &result, execution.as_ref());
        self.persist_attachment_extract(call_id, tool, &result);
    }

    /// Spawn a guardian review for a pending approval (guardian mode only).
    ///
    /// Returns false when the guardian is disabled, so the caller falls back
    /// to the human modal unchanged. When true, the review runs on a spawned
    /// task (like tool execution) and is applied by `poll_guardian_verdicts`,
    /// so the event loop never blocks on the review call.
    fn spawn_guardian_review(&mut self, request: &ApprovalRequest) -> bool {
        use crate::safety::guardian::{
            bounded_transcript, guardian_may_auto_approve, summarize_args, GuardianContext,
            TranscriptItem,
        };

        let Some(guardian) = self.guardian.clone() else {
            return false;
        };
        // Hard ceiling, enforced here rather than trusted to the review
        // model's own judgment: mutating/destructive/privacy-sensitive tools
        // (write, edit, background_tasks, gh_pr/issue/repo, screenshot, ...)
        // and any sandbox-bypass request always go to the human modal. See
        // `guardian_may_auto_approve`'s doc for why an allowlist here, not a
        // denylist.
        if !guardian_may_auto_approve(&request.tool, &request.args) {
            return false;
        }
        let transcript_items: Vec<TranscriptItem> = self
            .state
            .messages
            .iter()
            .filter(|message| message.kind == MessageKind::Regular)
            .map(|message| match message.role {
                MessageRole::User => TranscriptItem::User(message.content.clone()),
                MessageRole::Assistant => TranscriptItem::Assistant(message.content.clone()),
            })
            .collect();
        let context = GuardianContext {
            tool: request.tool.clone(),
            args_summary: summarize_args(&request.args),
            firewall_reason: request.reason.clone(),
            transcript: bounded_transcript(&transcript_items),
        };
        let guardian_tx = self.guardian_tx.clone();
        let request = request.clone();
        self.pending_guardian_reviews
            .insert(request.call_id.clone());
        tokio::spawn(async move {
            let verdict = guardian.evaluate(context).await;
            let _ = guardian_tx.send((request, verdict));
        });
        true
    }

    /// Apply finished guardian reviews (non-blocking). Auto-allow relays the
    /// approval to the native agent, which owns execution and runs the call
    /// in model order (see `handle_tool_approval`); a deny verdict or any
    /// failure fails closed to the human approval modal.
    /// Returns true when any review was applied.
    async fn poll_guardian_verdicts(&mut self) -> Result<bool> {
        use crate::safety::guardian::GuardianDecision;

        let mut outcomes = Vec::new();
        while let Ok(outcome) = self.guardian_rx.try_recv() {
            outcomes.push(outcome);
        }
        let had_outcomes = !outcomes.is_empty();
        for (request, verdict) in outcomes {
            // Ignore reviews that were interrupted (Ctrl+C) while in flight:
            // the approval must not be relayed after the user cancelled.
            if !self.pending_guardian_reviews.remove(&request.call_id) {
                continue;
            }
            let args_summary = crate::safety::guardian::summarize_args(&request.args);
            match verdict {
                Ok(verdict) if verdict.decision == GuardianDecision::Allow => {
                    self.record_guardian_decision(
                        &request.call_id,
                        &request.tool,
                        &args_summary,
                        "allow",
                        &verdict.reason,
                    );
                    self.state.add_system_message(format!(
                        "Tool '{}' auto-approved by guardian: {}",
                        request.tool, verdict.reason
                    ));
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                Ok(verdict) => {
                    self.record_guardian_decision(
                        &request.call_id,
                        &request.tool,
                        &args_summary,
                        "deny",
                        &verdict.reason,
                    );
                    self.state.add_system_message(format!(
                        "Guardian declined to auto-approve '{}': {}. Requesting your approval.",
                        request.tool, verdict.reason
                    ));
                    self.approval_controller.enqueue(request);
                    self.active_modal = ActiveModal::Approval;
                }
                Err(error) => {
                    self.record_guardian_decision(
                        &request.call_id,
                        &request.tool,
                        &args_summary,
                        "error",
                        &error.to_string(),
                    );
                    self.state.add_system_message(format!(
                        "Guardian review of '{}' failed ({error}). Requesting your approval.",
                        request.tool
                    ));
                    self.approval_controller.enqueue(request);
                    self.active_modal = ActiveModal::Approval;
                }
            }
        }
        Ok(had_outcomes)
    }

    fn persist_attachment_extract(&mut self, call_id: &str, tool: &str, result: &ToolResult) {
        if tool.eq_ignore_ascii_case("extract_document") && result.success {
            let attachment_id = result
                .details
                .as_ref()
                .and_then(|details| details.get("url"))
                .and_then(|value| value.as_str())
                .unwrap_or(call_id)
                .to_string();
            let _ = self
                .session_manager
                .save_attachment_extract(attachment_id, result.output.clone());
            self.flush_session();
        }
    }

    /// Drop in-flight guardian reviews (Ctrl+C interrupt): their outcomes are
    /// ignored by `poll_guardian_verdicts`, so a review finishing after the
    /// interrupt can neither relay an approval nor pop the approval modal.
    pub(super) fn cancel_pending_guardian_reviews(&mut self) {
        self.pending_guardian_reviews.clear();
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
  Ctrl+E        Open detail view (full output / error / message)

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
  /alerts       List recorded alerts
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
        let sandbox_label = self
            .sandbox_policy
            .as_ref()
            .map(crate::sandbox::SandboxPolicy::mode_label);
        let model_selector = &mut self.model_selector;
        let theme_selector = &mut self.theme_selector;
        let shortcuts_help = &self.shortcuts_help;
        let rewind_picker = &mut self.rewind_picker;
        let detail_view = &self.detail_view;
        let footer_style = self.footer_style;
        let goal_badge = self.goal_store.status_line();
        let attach_count = self.pending_attachments.len();

        // DEC mode 2026 lets capable terminals present a whole Ratatui diff
        // atomically, eliminating visible partial-frame tearing. Unknown DEC
        // modes are ignored, so this is safe on older terminals.
        {
            let writer = self.terminal.backend_mut();
            crossterm::queue!(writer, BeginSynchronizedUpdate)?;
            Write::flush(writer)?;
        }
        let draw_result = self
            .terminal
            .draw(|frame| {
                let area = frame.area();
                let workspace_trusted = state
                    .cwd
                    .as_deref()
                    .map(std::path::Path::new)
                    .is_some_and(crate::config::workspace_trusted_in_global_config);
                // Include the current request plus any queued behind it.
                let pending_approvals = approval_controller.pending().len();
                let view = ChatView::new(state)
                    .with_runtime_status(sandbox_label, workspace_trusted, pending_approvals)
                    .with_footer_style(footer_style)
                    .with_goal_badge(goal_badge.as_deref())
                    .with_attach_count(attach_count);
                frame.render_widget(view, area);

                // Show error if any. Wrap the full provider message across lines
                // (extracted upstream from the error body) instead of clipping a
                // fixed two-line slice of it. Hidden while a modal/overlay is
                // active so the error text cannot mix with the overlay's cells;
                // the status-bar alert badge and `/alerts` still surface it.
                let visible_error = if active_modal == ActiveModal::None {
                    state.error.as_deref()
                } else {
                    None
                };
                if let Some(error) = visible_error {
                    let error_width = area.width.saturating_sub(2).max(1);
                    let wrapped_lines = crate::wrapping::wrapped_line_count(
                        &ratatui::text::Text::raw(error),
                        error_width as usize,
                    ) as u16;
                    let error_height = wrapped_lines.clamp(1, 8);
                    let status_height = u16::from(!state.zen_mode);
                    let input_height = calculate_input_height(state, area);
                    let error_y = area
                        .height
                        .saturating_sub(status_height)
                        .saturating_sub(input_height)
                        .saturating_sub(error_height);
                    let error_area = Rect {
                        x: area.x + 1,
                        y: area.y + error_y,
                        width: error_width,
                        height: error_height,
                    };
                    // Blank the covered cells first so no older frame content
                    // shows through the wrapped paragraph.
                    frame.render_widget(ratatui::widgets::Clear, error_area);
                    let error_widget = ratatui::widgets::Paragraph::new(error)
                        .style(Style::default().fg(Color::Red))
                        .wrap(ratatui::widgets::Wrap { trim: false });
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
                        // Parallel tool calls queue several approvals at once; show
                        // them together in one batch modal instead of N sequential
                        // single-call modals. Re-evaluated every frame so an
                        // approval arriving while the single-call modal is open
                        // upgrades it to the batched variant.
                        if approval_modal_kind(approval_controller) == ApprovalModalKind::Batched {
                            let modal = BatchedApprovalModal::new(approval_controller.pending())
                                .selected(approval_controller.selected_index());
                            frame.render_widget(modal, area);
                        } else if let Some(request) = approval_controller.current() {
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
                    ActiveModal::RewindPicker => {
                        rewind_picker.render(frame, area);
                    }
                    ActiveModal::DetailView => {
                        if let Some(detail) = detail_view {
                            frame.render_widget(detail, area);
                        }
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
                        y: area.y.saturating_add(
                            area.height.saturating_sub(status_height + input_height),
                        ),
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
            })
            .map(|_| ());
        let sync_end_result = {
            let writer = self.terminal.backend_mut();
            crossterm::queue!(writer, EndSynchronizedUpdate).and_then(|()| Write::flush(writer))
        };
        draw_result?;
        sync_end_result?;

        Ok(())
    }

    /// Clear the on-screen error surface and force a full repaint of the
    /// inline viewport.
    ///
    /// ratatui's diff renderer only repaints cells that changed between the
    /// two most recent frames; when the transcript shrinks drastically (new
    /// session, session switch), cells that are blank in both buffers keep
    /// showing the previous frame's content on screen. `Terminal::clear`
    /// blanks the terminal from the viewport top down and resets the back
    /// buffer so the next frame redraws everything.
    fn reset_rendered_viewport(&mut self) {
        self.state.error = None;
        let _ = self.terminal.clear();
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

    /// Compute the slash completion popup's on-screen area.
    ///
    /// Shared by the renderer and mouse hit-testing so a click maps to the
    /// same geometry that was painted.
    fn slash_popup_area(area: Rect, completion_count: usize) -> Rect {
        let popup_height = (completion_count as u16 + 2).min(10);
        let popup_width = 40.min(area.width.saturating_sub(4));
        let popup_y = area.height.saturating_sub(4 + popup_height);
        Rect {
            x: area.x + 1,
            y: popup_y,
            width: popup_width,
            height: popup_height,
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

        let popup_area = Self::slash_popup_area(area, completions.len());

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

/// Whether a crossterm key event should be dispatched to `handle_key`.
///
/// Terminals using the kitty keyboard protocol (enabled via
/// `REPORT_EVENT_TYPES`) report `Press`, `Repeat`, and `Release` events.
/// Handle presses and repeats (so held keys auto-repeat); ignore releases.
fn should_handle_key_event(kind: KeyEventKind) -> bool {
    matches!(kind, KeyEventKind::Press | KeyEventKind::Repeat)
}

/// Combine an action-firewall reason and a sandbox-bypass warning into the
/// single reason string shown on an [`ApprovalRequest`].
///
/// # Ordering matters
///
/// `ApprovalRequest::summary()` (used by `BatchedApprovalModal` list rows)
/// shows only the *first line* of the combined reason. When both a firewall
/// reason and a bypass warning apply to the same call, the bypass warning
/// must come first: it says approving the request also removes the native
/// sandbox for this command, which is strictly more consequential than
/// whatever tripped the firewall, and must not be hidden behind it when the
/// user is approving from a batch (review finding on #3144).
fn combine_approval_reason(
    firewall_reason: Option<String>,
    bypass_reason: Option<String>,
) -> Option<String> {
    match (firewall_reason, bypass_reason) {
        (Some(firewall), Some(bypass)) => Some(format!("{bypass}\n\n{firewall}")),
        (Some(firewall), None) => Some(firewall),
        (None, Some(bypass)) => Some(bypass),
        (None, None) => None,
    }
}

fn uncurses_input_enabled(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_none_or(|value| value != "0")
}

fn terminal_theme_query_due(
    has_terminal_events: bool,
    has_theme_follower: bool,
    reporting_available: bool,
    elapsed_since_query: Option<Duration>,
) -> bool {
    has_terminal_events
        && has_theme_follower
        && !reporting_available
        && elapsed_since_query.is_none_or(|elapsed| elapsed >= Duration::from_secs(2))
}

fn terminal_reporting_shutdown_needed(had_terminal_events: bool, has_theme_follower: bool) -> bool {
    had_terminal_events && has_theme_follower
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

mod checkpoints;
mod command_handlers;
mod context_breakdown;
mod exec_commands;
mod input_handlers;
mod prompt_queue;
mod session_recording;

#[cfg(test)]
mod tests;

//! Composer TUI - Native terminal interface
//!
//! This crate provides the primary terminal UI for Composer. The Rust binary
//! is the main entry point that users run directly. It spawns a Node.js
//! subprocess for agent logic and handles all terminal rendering natively.
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │  Rust TUI Binary (ratatui + crossterm)      │
//! │  - Main entry point (users run this)        │
//! │  - Owns terminal completely                 │
//! │  - Native rendering & scrollback            │
//! │  - Chat UI, markdown display                │
//! └──────────────────┬──────────────────────────┘
//!                    │ Simple JSON IPC (prompts, responses)
//!                    ▼
//! ┌─────────────────────────────────────────────┐
//! │  Node.js Agent (--headless mode)            │
//! │  - API calls to Claude                      │
//! │  - Tool execution                           │
//! │  - Context management                       │
//! └─────────────────────────────────────────────┘
//! ```

// Core modules
pub mod agent;
pub mod ai;
pub mod commands;
pub mod components;
pub mod config;
pub mod effects;
pub mod files;
pub mod headless;
pub mod protocol;
pub mod session;
pub mod state;
pub mod terminal;
pub mod tools;

// Feature modules
pub mod clipboard;
pub mod diff;
pub mod execpolicy;
pub mod git;
pub mod key_hints;
pub mod markdown;
pub mod notifications;
pub mod pager;
pub mod palette;
pub mod prompts;
pub mod sandbox;
pub mod syntax;
pub mod themes;
pub mod tooltips;
pub mod wrapping;

mod app;

pub use agent::{NativeAgent, NativeAgentConfig, ToolDefinition};
pub use ai::{
    create_client, create_client_for_model, AiClient, AiProvider, AnthropicClient, OpenAiClient,
    UnifiedClient,
};
pub use app::App;
pub use state::AppState;

// Re-export commonly used items
pub use commands::{build_command_registry, CommandRegistry, SlashCommandMatcher};
pub use diff::{generate_diff, render_diff, Diff, DiffStats};
pub use headless::{
    // Core types
    AgentEvent, AgentState, FromAgentMessage, ToAgentMessage, TokenUsage,
    // Sync transport
    AgentTransport, AgentTransportBuilder, TransportConfig, TransportError,
    // Async transport
    AsyncAgentTransport, AsyncAgentTransportBuilder, AsyncTransportConfig, AsyncTransportError,
    // Session management
    SessionEntry, SessionMetadata, SessionReader, SessionRecorder,
    // Supervisor
    AgentSupervisor, HealthStatus, SupervisorBuilder, SupervisorConfig, SupervisorEvent,
    // Framing
    FrameReader, FrameWriter, FramingMode,
};
pub use key_hints::{KeyBinding, KeyHint};
pub use markdown::render_markdown;
pub use pager::Pager;
pub use palette::{best_color, color_level, has_true_color, theme, ColorLevel};
pub use tools::{BashTool, ToolExecutor, ToolRegistry};
pub use tooltips::random_tooltip;
pub use wrapping::{word_wrap_line, word_wrap_lines, RtOptions};

// Notification exports
pub use notifications::{
    is_enabled as is_notification_enabled, is_terminal_enabled, load_config as load_notify_config,
    notify_error, notify_session_start, notify_turn_complete, send_notification,
    send_terminal_notification, NotificationConfig, NotificationEvent, NotificationPayload,
};

// Prompts exports
pub use prompts::{
    find_prompt, format_prompt_list_item, get_usage_hint, load_prompts, parse_args,
    render_prompt, validate_args, ParsedArgs, PromptDefinition, PromptSource,
};

// Execpolicy exports
pub use execpolicy::{
    append_allow_prefix_rule, is_command_allowed, is_command_forbidden, load_policy,
    parse_command, parse_policy, whitelist_command, Decision, Evaluation, PatternToken,
    Policy, PrefixPattern, PrefixRule, RuleMatch,
};

// Config exports
pub use config::{
    clear_config_cache, get_available_profiles, get_config_summary, load_config,
    load_config_with_overrides, parse_cli_override, ApprovalPolicy, ComposerConfig,
    FeaturesConfig, FileOpener, HistoryConfig, HistoryPersistence, McpServerConfig,
    ModelProviderConfig, ModelVerbosity, NotificationsSetting, OtelConfig, ProfileConfig,
    ReasoningEffort, ReasoningSummary, SandboxMode, SandboxWorkspaceWriteConfig,
    ShellEnvironmentPolicy, ShellInherit, ToolsConfig, TrustLevel, TuiConfig, WireApi,
    DEFAULT_CONFIG,
};

// Sandbox exports
pub use sandbox::{
    is_sandbox_available, sandbox_type, spawn_sandboxed_command, spawn_unsandboxed_command,
    SandboxError, SandboxPolicy, SandboxResult, WritableRoot, SANDBOX_ENV_VAR,
};

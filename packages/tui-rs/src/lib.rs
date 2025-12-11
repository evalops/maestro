//! # Composer TUI - Native Terminal Interface Library
//!
//! This crate provides the primary terminal UI for Composer. The Rust binary
//! is the main entry point that users run directly. It spawns a Node.js
//! subprocess for agent logic and handles all terminal rendering natively.
//!
//! ## Rust Concept: Crate Structure
//!
//! In Rust, a "crate" is a compilation unit (like a package). A crate can be:
//! - A **binary crate** (`main.rs`) - produces an executable
//! - A **library crate** (`lib.rs`) - produces a library for others to use
//!
//! This file (`lib.rs`) is the root of the library crate. It defines:
//! 1. What modules exist (`mod` declarations)
//! 2. What's publicly accessible (`pub` visibility)
//! 3. Re-exports for convenient access (`pub use`)
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
//!
//! ## Module Organization
//!
//! The crate is organized into core modules (essential functionality) and
//! feature modules (optional/specific features).

// ─────────────────────────────────────────────────────────────────────────────
// CORE MODULES
// ─────────────────────────────────────────────────────────────────────────────
//
// Rust Concept: Module Declarations
//
// `pub mod foo;` does two things:
// 1. Tells Rust to look for `foo.rs` or `foo/mod.rs`
// 2. Makes the module publicly accessible (without `pub`, it's private)
//
// These are the essential modules that make up the core functionality.

/// Agent communication and lifecycle management.
/// Handles spawning, messaging, and coordinating with the AI agent subprocess.
pub mod agent;

/// AI provider clients (Anthropic, OpenAI, etc.).
/// Provides unified interfaces for different AI APIs with streaming support.
pub mod ai;

/// Slash command system.
/// Parses and executes commands like /help, /clear, /model, etc.
pub mod commands;

/// UI components (modals, selectors, text areas).
/// Reusable ratatui widgets for building the terminal interface.
pub mod components;

/// Configuration loading and management.
/// Reads from config files, environment variables, and CLI overrides.
pub mod config;

/// Visual effects (spinners, shimmers, animations).
/// Terminal-based animations for loading states and visual feedback.
pub mod effects;

/// File system operations (search, workspace management).
/// Handles file listing, fuzzy search, and workspace-relative paths.
pub mod files;

/// Headless mode communication protocol.
/// JSON-based IPC protocol for communicating with the Node.js agent.
pub mod headless;

/// Message protocol definitions.
/// Type definitions for messages exchanged between Rust and Node.js.
pub mod protocol;

/// Session persistence (save/load conversations).
/// JSONL-based session storage for resuming previous conversations.
pub mod session;

/// Application state management.
/// Central state struct that holds all mutable application data.
pub mod state;

/// Terminal setup and event handling.
/// Raw terminal mode, event polling, and cleanup on exit.
pub mod terminal;

/// Tool execution (bash, file operations).
/// Executes tools requested by the AI agent and returns results.
pub mod tools;

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE MODULES
// ─────────────────────────────────────────────────────────────────────────────
//
// These modules provide specific features that aren't part of the core
// request/response loop.

/// Clipboard integration (copy/paste).
/// Platform-specific clipboard access for copying code blocks.
pub mod clipboard;

/// Diff generation and rendering.
/// Shows file changes with colored additions/deletions.
pub mod diff;

/// Execution policy (command approval/blocking).
/// Security rules for which bash commands are auto-approved or blocked.
pub mod execpolicy;

/// Hook system for intercepting and modifying agent behavior.
/// Provides trait-based hooks for tool calls, session events, and overflow handling.
pub mod hooks;

/// Git integration.
/// Detects git repos, branches, and provides context to the agent.
pub mod git;

/// Keyboard shortcut hints.
/// Shows available key bindings in the UI footer.
pub mod key_hints;

/// Markdown rendering for terminal.
/// Converts markdown to styled terminal output with syntax highlighting.
pub mod markdown;

/// Desktop notifications.
/// Sends system notifications when tasks complete (optional).
pub mod notifications;

/// Scrollable text pager.
/// Like `less` - allows scrolling through long content.
pub mod pager;

/// Terminal color palette management.
/// Handles different color capability levels (16, 256, true color).
pub mod palette;

/// Custom prompt templates.
/// User-defined prompts with argument substitution.
pub mod prompts;

/// Command sandboxing (macOS Seatbelt, Linux Landlock).
/// Restricts file system access for executed commands.
pub mod sandbox;

/// Safety and security controls for agent operations.
/// Includes action firewall, dangerous pattern detection, and path containment.
pub mod safety;

/// Syntax highlighting for code blocks.
/// Uses syntect for highlighting in various languages.
pub mod syntax;

/// Color themes.
/// UI color schemes (dark, light, custom).
pub mod themes;

/// Loading tooltips.
/// Random tips shown while waiting for AI responses.
pub mod tooltips;

/// Text wrapping utilities.
/// Word-wraps text for terminal display, respecting ANSI codes.
pub mod wrapping;

/// Model Context Protocol (MCP) client.
/// Connects to external MCP servers for additional tools and capabilities.
pub mod mcp;

/// Usage and cost tracking.
/// Tracks token consumption and estimates costs across sessions.
pub mod usage;

/// Prompt history with persistence and search.
/// Stores and retrieves previous prompts for easy recall.
pub mod history;

/// Configuration file watcher for hot-reload.
/// Watches config files and emits events on changes.
pub mod config_watcher;

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE MODULES
// ─────────────────────────────────────────────────────────────────────────────
//
// Rust Concept: Private Modules
//
// Without `pub`, a module is private to this crate. It can be used internally
// but isn't exposed to external users of the library.

/// Main application struct and event loop.
/// This is the top-level coordinator that ties everything together.
mod app;

// ─────────────────────────────────────────────────────────────────────────────
// RE-EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Rust Concept: Re-exports with `pub use`
//
// `pub use` makes items from submodules available at the crate root.
// This provides a flatter, more convenient API. Instead of:
//   `composer_tui::agent::NativeAgent`
// Users can write:
//   `composer_tui::NativeAgent`
//
// This is a common pattern called "facade" - hiding internal structure
// while exposing a clean public API.

// Agent types - for spawning and communicating with AI agents
pub use agent::{NativeAgent, NativeAgentConfig, ToolDefinition};

// AI client types - for making API calls to different providers
pub use ai::{
    create_client,           // Factory function to create a client by provider name
    create_client_for_model, // Factory function that infers provider from model
    AiClient,                // Trait that all clients implement
    AiProvider,              // Enum of supported providers
    AnthropicClient,         // Anthropic-specific client
    OpenAiClient,            // OpenAI-specific client
    UnifiedClient,           // Client that can switch between providers
};

// Core application types
pub use app::App; // Main application struct
pub use state::AppState; // Application state

// Command system
pub use commands::{
    build_command_registry, // Creates the registry with all commands
    CommandRegistry,        // Holds all registered slash commands
    SlashCommandMatcher,    // Fuzzy matches user input to commands
};

// Diff utilities
pub use diff::{
    generate_diff, // Creates a diff between two strings
    render_diff,   // Renders diff as colored terminal output
    Diff,          // Represents a single diff change
    DiffStats,     // Summary statistics (lines added/removed)
};

// Headless protocol types - extensive as it's the IPC contract
pub use headless::{
    // Core message types for bidirectional communication
    AgentEvent, // Events emitted by the agent
    AgentState, // Current state of the agent (idle, thinking, etc.)
    // Supervisor (manages agent lifecycle)
    AgentSupervisor, // High-level agent manager
    // Transport layers (how we communicate)
    AgentTransport,        // Synchronous transport (blocking I/O)
    AgentTransportBuilder, // Builder pattern for sync transport
    AsyncAgentTransport,   // Asynchronous transport (non-blocking)
    AsyncAgentTransportBuilder,
    AsyncTransportConfig,
    AsyncTransportError,
    // Message framing (low-level protocol)
    FrameReader, // Reads framed messages from stream
    FrameWriter, // Writes framed messages to stream
    FramingMode, // Line-delimited or length-prefixed

    FromAgentMessage, // Messages we receive from the agent
    HealthStatus,     // Agent health/readiness status

    // Session management
    SessionEntry,      // Single entry in a session file
    SessionMetadata,   // Session metadata (id, timestamp, etc.)
    SessionReader,     // Reads session files
    SessionRecorder,   // Records sessions to disk
    SupervisorBuilder, // Builder for supervisor configuration
    SupervisorConfig,  // Supervisor settings
    SupervisorEvent,   // Events from supervisor

    ToAgentMessage, // Messages we send to the agent
    TokenUsage,     // Token consumption statistics
    TransportConfig,
    TransportError,
};

// Keyboard hints
pub use key_hints::{
    KeyBinding, // A key and its action
    KeyHint,    // Display-ready hint
};

// Markdown rendering
pub use markdown::render_markdown;

// Pager
pub use pager::Pager;

// Color palette utilities
pub use palette::{
    best_color,  // Picks best color for terminal capabilities
    color_level, // Detects terminal color support
    has_true_color,
    theme,      // Gets current theme
    ColorLevel, // Enum: Basic16, Ansi256, TrueColor
};

// Tool system
pub use tools::{
    BashTool,       // Executes shell commands
    HistoryFilter,  // Filter for tool history search
    ToolExecutor,   // Trait for tool execution
    ToolExecution,  // Single tool execution record
    ToolHistory,    // Tool execution history tracker
    ToolRegistry,   // Registry of available tools
    ToolStats,      // Statistics about tool executions
};

// Tooltips
pub use tooltips::random_tooltip;

// Text wrapping
pub use wrapping::{
    word_wrap_line,  // Wraps a single line
    word_wrap_lines, // Wraps multiple lines
    RtOptions,       // Wrapping options
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Notification system for alerting users when tasks complete.
///
/// Rust Concept: Renaming on Re-export
///
/// `pub use foo as bar` re-exports `foo` with the name `bar`.
/// This is useful when the original name would conflict or be unclear
/// at the crate root level.
pub use notifications::{
    is_enabled as is_notification_enabled, // Renamed to be clearer at crate root
    is_terminal_enabled,
    load_config as load_notify_config, // Renamed to avoid conflict with config::load_config
    notify_error,
    notify_session_start,
    notify_turn_complete,
    send_notification,
    send_terminal_notification,
    NotificationConfig,
    NotificationEvent,
    NotificationPayload,
};

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Custom prompt system for user-defined prompt templates.
pub use prompts::{
    find_prompt, // Finds a prompt by name
    format_prompt_list_item,
    get_usage_hint,   // Gets usage help for a prompt
    load_prompts,     // Loads all prompts from disk
    parse_args,       // Parses prompt arguments
    render_prompt,    // Renders prompt with substituted args
    validate_args,    // Validates arguments match schema
    ParsedArgs,       // Parsed argument values
    PromptDefinition, // Schema for a prompt
    PromptSource,     // Where prompt was loaded from
};

// ─────────────────────────────────────────────────────────────────────────────
// EXECPOLICY EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Execution policy for command approval/blocking.
///
/// This system determines which bash commands are:
/// - Auto-approved (trusted commands like `ls`, `git status`)
/// - Blocked (dangerous commands like `rm -rf /`)
/// - Require user approval (everything else)
pub use execpolicy::{
    append_allow_prefix_rule, // Adds a new allow rule to policy
    is_command_allowed,       // Checks if command is auto-approved
    is_command_forbidden,     // Checks if command is blocked
    load_policy,              // Loads policy from config files
    parse_command,            // Tokenizes a command string
    parse_policy,             // Parses policy file content
    whitelist_command,        // Adds command to allow list
    Decision,                 // Allow, Deny, or NeedsApproval
    Evaluation,               // Result of evaluating a command
    PatternToken,             // Part of a command pattern
    Policy,                   // Collection of rules
    PrefixPattern,            // Matches command prefixes
    PrefixRule,               // A single prefix-based rule
    RuleMatch,                // Which rule matched
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration system with layered sources.
///
/// Configuration is loaded from (in order of increasing priority):
/// 1. Default values
/// 2. Global config (~/.composer/config.toml)
/// 3. Project config (.composer/config.toml)
/// 4. Environment variables (COMPOSER_*)
/// 5. CLI arguments
pub use config::{
    // Loading functions
    clear_config_cache,     // Clears cached config (for testing)
    get_available_profiles, // Lists available config profiles
    get_config_summary,     // Human-readable config summary
    load_config,            // Main config loading function
    load_config_with_overrides,
    parse_cli_override, // Parses --config overrides

    // Policy enums
    ApprovalPolicy, // How tool execution is approved
    // Main config struct
    ComposerConfig, // The complete configuration

    // Nested config structs
    FeaturesConfig,       // Feature flags
    FileOpener,           // How to open files externally
    HistoryConfig,        // History settings
    HistoryPersistence,   // How history is saved
    McpServerConfig,      // MCP server connection settings
    ModelProviderConfig,  // Custom model provider settings
    ModelVerbosity,       // How verbose model output is
    NotificationsSetting, // Notification preferences
    OtelConfig,           // OpenTelemetry tracing settings
    ProfileConfig,        // Named configuration profiles
    ReasoningEffort,      // How much thinking the model does
    ReasoningSummary,     // How reasoning is summarized
    SandboxMode,          // Sandbox security level

    SandboxWorkspaceWriteConfig,
    ShellEnvironmentPolicy, // Which env vars to pass to shells
    ShellInherit,           // Shell environment inheritance
    ToolsConfig,            // Tool execution settings
    TrustLevel,             // Trust level for the project
    TuiConfig,              // TUI appearance settings
    WireApi,                // API wire format settings

    DEFAULT_CONFIG, // Default configuration values
};

// ─────────────────────────────────────────────────────────────────────────────
// SANDBOX EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Sandboxing system for restricting command execution.
///
/// Uses platform-specific sandboxing:
/// - macOS: Seatbelt (sandbox-exec)
/// - Linux: Landlock LSM
///
/// Sandboxing limits what files/directories commands can access,
/// providing defense-in-depth against malicious commands.
pub use sandbox::{
    is_sandbox_available,      // Checks if sandboxing is supported
    sandbox_type,              // Returns "seatbelt", "landlock", or "none"
    spawn_sandboxed_command,   // Runs command in sandbox
    spawn_unsandboxed_command, // Runs command without sandbox
    SandboxError,              // Error type for sandbox operations
    SandboxPolicy,             // Configuration for sandbox restrictions
    SandboxResult,             // Result type alias
    WritableRoot,              // A directory the sandbox can write to
    SANDBOX_ENV_VAR,           // Environment variable indicating sandbox mode
};

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Safety and security system for agent operations.
///
/// The safety module provides multiple layers of protection:
/// - **Action Firewall**: Central gateway that checks all tool operations
/// - **Dangerous Patterns**: Regex-based detection of malicious commands
/// - **Bash Analyzer**: Parse and classify shell command risk
/// - **Path Containment**: Ensure operations stay within safe directories
pub use safety::{
    // Firewall - main entry point
    ActionFirewall,  // Central security gateway
    FirewallVerdict, // Allow, Block, or RequireApproval

    // Bash analysis
    analyze_bash_command, // Analyze a command for risk
    BashAnalysis,         // Analysis result with risk level
    CommandRisk,          // Safe, RequiresApproval, or Dangerous

    // Dangerous pattern detection
    check_dangerous_patterns, // Check input against all patterns
    DangerousPattern,         // A pattern with regex and severity
    PatternMatch,             // Result of a pattern match

    // Path containment
    is_path_contained, // Check if path is in safe zones
    PathContainment,   // Contained, Escaped, or SystemProtected
};

// ─────────────────────────────────────────────────────────────────────────────
// MCP EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Model Context Protocol (MCP) client for external tool servers.
///
/// MCP allows the agent to connect to external servers that provide
/// additional tools. Servers are configured via JSON files and can use
/// different transports (stdio, HTTP, SSE).
pub use mcp::{
    // Client types
    McpClient,     // Manages multiple server connections
    McpConnection, // Single server connection
    McpError,      // Error type for MCP operations

    // Configuration
    load_mcp_config,                        // Load config from standard locations
    McpConfig,                              // Merged configuration from all sources
    McpServerConfig as McpServerJsonConfig, // JSON-based server config (renamed to avoid conflict with config::McpServerConfig)
    McpTransport,                           // Transport type (Stdio, Http, Sse)

    // Protocol types
    McpRequest,    // JSON-RPC request message
    McpResponse,   // JSON-RPC response message
    McpTool,       // Tool definition from server
    McpToolResult, // Result of tool execution
};

// ─────────────────────────────────────────────────────────────────────────────
// USAGE EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Usage and cost tracking for token consumption.
///
/// Tracks token usage across turns and sessions with:
/// - Per-model pricing configuration
/// - Cost alerts and thresholds
/// - Exportable statistics
pub use usage::{
    CostAlert,     // Configurable cost threshold alert
    ModelPricing,  // Per-model pricing database
    PricingTier,   // Cost per token tier
    SessionUsage,  // Aggregated session usage
    TurnUsage,     // Single turn usage record
    UsageExport,   // Exportable usage data
    UsageStats,    // Aggregated statistics
    UsageTracker,  // Main usage tracker
    DEFAULT_PRICING, // Global default pricing
};

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Prompt history with persistence and fuzzy search.
///
/// Stores user prompts for recall with:
/// - Arrow key navigation (up/down)
/// - Fuzzy search matching
/// - Persistent storage to disk
/// - Per-session filtering
pub use history::{
    HistoryConfig as PromptHistoryConfig, // History configuration (renamed to avoid conflict with config::HistoryConfig)
    HistoryEntry,   // Single history entry
    PromptHistory,  // Main history store
    SearchMatch,    // Search result match
    SearchResult,   // Search results
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG WATCHER EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration file watcher for hot-reload functionality.
///
/// Watches config files and emits events when they change:
/// - Debounced to avoid excessive notifications
/// - Non-blocking polling interface
/// - Supports multiple files simultaneously
pub use config_watcher::{
    ConfigEvent,          // Change, Created, Deleted, or Error events
    ConfigWatcher,        // Main watcher struct
    ConfigWatcherBuilder, // Builder for easy setup
};

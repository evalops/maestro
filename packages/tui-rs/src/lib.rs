//! # Composer TUI - Native Terminal Interface Library
//!
//! This crate provides the primary terminal UI and native agent for Composer.
//! The Rust binary is the user entry point: it owns terminal rendering, AI
//! calls, tool execution, and safety enforcement without any Node.js
//! subprocess.
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
//! │  Rust TUI + Native Agent (ratatui + tokio)  │
//! │  - Main entry point (users run this)        │
//! │  - Owns terminal + scrollback               │
//! │  - Native AI clients (Claude, OpenAI, etc.) │
//! │  - Tool execution + safety + hooks          │
//! │  - Chat UI, markdown, themes                │
//! └─────────────────────────────────────────────┘
//! ```
//!
//! Headless JSON IPC is still available via the `headless` module if you want
//! to drive the agent from another process, but the default path is fully
//! in-process Rust.
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

/// Telemetry and wide events.
/// Canonical turn events with tail sampling for observability.
pub mod telemetry;

/// Usage and cost tracking.
/// Tracks token consumption and estimates costs across sessions.
pub mod usage;

/// Prompt history with persistence and search.
/// Stores and retrieves previous prompts for easy recall.
pub mod history;

/// Configuration file watcher for hot-reload.
/// Watches config files and emits events on changes.
pub mod config_watcher;

/// Text formatting utilities (truncation, JSON compacting).
/// Ported from OpenAI Codex CLI (MIT licensed).
pub mod text_format;

/// Live/incremental text wrapping for streaming content.
/// Allows text to be pushed in fragments and wrapped correctly.
pub mod live_wrap;

/// Rendering utilities for terminal output.
/// Line manipulation, prefixing, and truncation helpers.
pub mod render_utils;

/// Color utilities (blending, perceptual distance, terminal detection).
/// Includes xterm 256 color palette and best-match color selection.
pub mod color_utils;

/// Streaming markdown collector for incremental rendering.
/// Buffers text and commits only complete lines.
pub mod markdown_stream;

/// Terminal information and detection utilities.
/// SSH, WSL, and terminal emulator detection.
pub mod terminal_info;

/// Paste burst detection for terminals without bracketed paste.
/// Heuristic-based detection using keystroke timing.
pub mod paste_burst;

/// Scroll/selection state for list menus.
/// Wrap-around navigation and scroll window management.
pub mod scroll_state;

/// Key binding utilities for keyboard shortcuts.
/// Platform-aware modifier display.
pub mod key_binding;

/// ANSI terminal commands for scroll regions and terminal control.
/// Essential for proper scrolling over SSH.
pub mod ansi_commands;

/// Synchronized output for flicker-free terminal updates.
/// Buffers output for atomic display.
pub mod sync_output;

/// Viewport management for scrollable content.
/// Includes viewport clipping, scroll offset rendering, and auto-scroll.
pub mod viewport;

/// Inline scrolling with scroll regions.
/// For inline TUI mode with terminal scrollback integration.
pub mod inline_scroll;

/// Selection list rendering for popups and menus.
/// Fuzzy match highlighting, aligned descriptions, smart wrapping.
pub mod selection_list;

/// Elapsed time formatting and pausable timer.
/// Compact duration display and animated spinners.
pub mod elapsed;

/// ANSI escape code handling.
/// Converts ANSI-escaped strings to ratatui styled text.
pub mod ansi_text;

/// Box and border drawing utilities.
/// Unicode box-drawing characters for cards and panels.
pub mod borders;

/// Field formatting for aligned label-value displays.
/// Consistent formatting for status displays.
pub mod field_format;

/// Shimmer animation effect.
/// Animated text highlights for loading indicators.
pub mod shimmer;

/// ANSI code tracker with surgical resets.
/// Stateful tracking of ANSI SGR codes for preventing visual artifacts.
pub mod ansi_tracker;

/// Single-line input with horizontal viewport scrolling.
/// Responsive text input for long lines over SSH.
pub mod single_line_input;

/// Truncated text display with ellipsis.
/// Smart truncation for text and paths.
pub mod truncated_text;

/// Undo/redo history with debounced snapshots.
/// Generic history management for editors.
pub mod undo_history;

/// Focus management and input routing.
/// Component hierarchy focus handling.
pub mod focus;

/// Terminal resize handling with cache invalidation.
/// Smart redraw detection and width-keyed caching.
pub mod resize_handler;

/// Animated loading indicator with spinners and progress bars.
/// Multiple styles with low-unicode/low-color fallbacks.
pub mod loader;

/// Keymap and chord detection system.
/// Multi-key sequences, vim-style modes, timeout-based chords.
pub mod keymap;

/// Notification queue for TUI feedback.
/// Priority-based notifications with batching and auto-dismiss.
pub mod notification_queue;

/// Layout constraints and responsive sizing.
/// Flex distribution, breakpoints, and priority-based degradation.
pub mod layout_constraints;

/// Kill ring and word movement for text editing.
/// Emacs-style kill/yank buffer with word boundary detection.
pub mod kill_ring;

/// Confirmation dialog widget.
/// Simple yes/no dialogs with keyboard navigation.
pub mod confirm_dialog;

/// OSC-8 terminal hyperlinks.
/// Clickable links in modern terminals.
pub mod hyperlink;

/// ASCII animation system.
/// Frame-based animations with built-in presets.
pub mod ascii_animation;

/// Skills system for dynamically activating specialized behaviors.
/// Skills can modify system prompts, provide tools, and change how the agent approaches tasks.
pub mod skills;

/// Swarm mode for multi-agent task orchestration.
/// Execute complex tasks across multiple agents in parallel with dependency management.
pub mod swarm;

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

// Telemetry types - for wide events tracking
pub use telemetry::{
    CanonicalTurnEvent, // The wide event emitted per turn
    TailSamplingConfig, // Sampling configuration
    TurnCollector,      // Accumulates context during a turn
    TurnTracker,        // Integrates with agent events
    TurnTrackerConfig,  // Configuration for turn tracking
    TurnTrackerContext, // Context that can be updated
};

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
pub use tools::process_registry; // Process registry module for fine-grained control
pub use tools::{
    background_process_count,     // Count of tracked background processes
    cleanup_background_processes, // Kill all tracked background processes
    BashTool,                     // Executes shell commands
    HistoryFilter,                // Filter for tool history search
    ToolExecution,                // Single tool execution record
    ToolExecutor,                 // Trait for tool execution
    ToolHistory,                  // Tool execution history tracker
    ToolRegistry,                 // Registry of available tools
    ToolStats,                    // Statistics about tool executions
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
    // Bash analysis
    analyze_bash_command, // Analyze a command for risk
    // Dangerous pattern detection
    check_dangerous_patterns, // Check input against all patterns
    // Path containment
    is_path_contained, // Check if path is in safe zones
    // Firewall - main entry point
    ActionFirewall, // Central security gateway
    BashAnalysis,   // Analysis result with risk level
    CommandRisk,    // Safe, RequiresApproval, or Dangerous

    DangerousPattern, // A pattern with regex and severity
    FirewallVerdict,  // Allow, Block, or RequireApproval

    PathContainment, // Contained, Escaped, or SystemProtected
    PatternMatch,    // Result of a pattern match
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
    // Configuration
    load_mcp_config, // Load config from standard locations
    // Client types
    McpClient,     // Manages multiple server connections
    McpConfig,     // Merged configuration from all sources
    McpConnection, // Single server connection
    McpError,      // Error type for MCP operations

    // Protocol types
    McpRequest,                             // JSON-RPC request message
    McpResponse,                            // JSON-RPC response message
    McpServerConfig as McpServerJsonConfig, // JSON-based server config (renamed to avoid conflict with config::McpServerConfig)
    McpTool,                                // Tool definition from server
    McpToolResult,                          // Result of tool execution
    McpTransport,                           // Transport type (Stdio, Http, Sse)
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
    CostAlert,       // Configurable cost threshold alert
    ModelPricing,    // Per-model pricing database
    PricingTier,     // Cost per token tier
    SessionUsage,    // Aggregated session usage
    TurnUsage,       // Single turn usage record
    UsageExport,     // Exportable usage data
    UsageStats,      // Aggregated statistics
    UsageTracker,    // Main usage tracker
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
    HistoryEntry,                         // Single history entry
    PromptHistory,                        // Main history store
    SearchMatch,                          // Search result match
    SearchResult,                         // Search results
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

// ─────────────────────────────────────────────────────────────────────────────
// LIVE WRAP EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Live/incremental text wrapping for streaming content.
///
/// Useful for rendering streaming AI responses in real-time, maintaining
/// correct wrapping regardless of how text fragments arrive.
pub use live_wrap::{
    take_prefix_by_width, // Take a prefix of text fitting within a width
    Row,                  // A single visual row with text and line break info
    RowBuilder,           // Incremental text wrapper
};

// ─────────────────────────────────────────────────────────────────────────────
// RENDER UTILS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Rendering utilities for styled terminal text.
///
/// Provides helpers for manipulating ratatui Lines/Spans:
/// - Prefixing lines with tree-style indentation
/// - Converting borrowed lines to static
/// - Truncating output with middle ellipsis
pub use render_utils::{
    ellipsis_line,          // Creates "… +N lines" ellipsis
    is_blank_line,          // Checks if line is empty/whitespace
    limit_lines_from_start, // Limits lines with trailing ellipsis
    line_to_static,         // Converts borrowed line to owned
    prefix_lines,           // Adds tree-style prefixes
    prefix_lines_borrowed,  // Prefix with borrowed prefixes
    push_owned_lines,       // Appends owned copies of lines
    truncate_lines_middle,  // Head/tail truncation with ellipsis
};

// ─────────────────────────────────────────────────────────────────────────────
// TEXT FORMAT EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Text formatting utilities for terminal display.
///
/// Ported from OpenAI Codex CLI (MIT licensed):
/// - Truncate text to fit within a given character count
/// - Format JSON in compact single-line format
/// - Center-truncate paths with ellipsis in middle
pub use text_format::{
    center_truncate_path,            // Path truncation preserving endpoints
    format_and_truncate_tool_result, // Format and truncate tool output
    format_json_compact,             // Single-line JSON with spaces
    relativize_to_home,              // Replace home dir with ~
    truncate_lines,                  // Line count truncation
    truncate_text,                   // Character count truncation
    TOOL_OUTPUT_MAX_LINES,           // Default max lines for tool output
};

// ─────────────────────────────────────────────────────────────────────────────
// COLOR UTILS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Color utilities for terminal rendering.
///
/// Provides perceptual color matching, blending, and terminal capability detection.
pub use color_utils::{
    best_color as best_color_match, // Find best matching color for terminal (renamed to avoid conflict)
    blend,                          // Blend two RGB colors
    has_256_color_support,          // Check for 256 color support
    has_true_color_support,         // Check for true color (24-bit)
    is_light,                       // Check if color is light
    perceptual_distance,            // CIE76 color distance
    XTERM_COLORS,                   // 256 color palette
};

// ─────────────────────────────────────────────────────────────────────────────
// MARKDOWN STREAM EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Streaming markdown collector for incremental rendering.
///
/// Buffers text deltas and commits only complete lines, preventing
/// partial markdown from causing visual glitches.
pub use markdown_stream::MarkdownStreamCollector;

// ─────────────────────────────────────────────────────────────────────────────
// TERMINAL INFO EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Terminal information and detection utilities.
///
/// Works across local, SSH, and WSL sessions:
/// - Terminal emulator detection (kitty, iTerm2, Alacritty, etc.)
/// - SSH session detection
/// - WSL detection and path conversion
pub use terminal_info::{
    convert_windows_path_to_wsl, // Convert Windows paths in WSL
    is_interactive,              // Check if fully interactive terminal
    is_ssh_session,              // Check if SSH session
    is_stderr_tty,               // Check if stderr is TTY
    is_stdin_tty,                // Check if stdin is TTY
    is_stdout_tty,               // Check if stdout is TTY
    is_wsl,                      // Check if WSL
    normalize_pasted_path,       // Normalize pasted file paths
    ssh_connection_info,         // Get SSH connection details
    TerminalInfo,                // Full terminal info struct
};

// ─────────────────────────────────────────────────────────────────────────────
// PASTE BURST EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Paste burst detection for terminals without bracketed paste.
///
/// Uses keystroke timing heuristics to detect paste-like input,
/// preventing accidental form submission when pasting multiline content.
pub use paste_burst::{
    retro_start_index, // Find byte index for retro-grabbing chars
    CharDecision,      // Decision for how to handle a character
    FlushResult,       // Result of flushing the buffer
    PasteBurst,        // Main detector struct
    RetroGrab,         // Info about retroactively grabbed text
};

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL STATE EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Scroll/selection state for list menus.
///
/// Encapsulates wrap-around navigation, page up/down, and
/// automatic scroll window adjustment.
pub use scroll_state::ScrollState;

// ─────────────────────────────────────────────────────────────────────────────
// KEY BINDING EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Key binding utilities for keyboard shortcuts.
///
/// Platform-aware modifier display (⌥ on macOS, alt elsewhere).
pub use key_binding::{
    alt,                       // Alt + key binding
    ctrl,                      // Ctrl + key binding
    ctrl_alt,                  // Ctrl + Alt + key binding
    ctrl_shift,                // Ctrl + Shift + key binding
    format_key_hint,           // Format binding for help text
    has_ctrl_or_alt,           // Check for ctrl/alt modifiers
    is_altgr,                  // Check for AltGr (Windows)
    plain,                     // Plain key binding
    shift,                     // Shift + key binding
    KeyBinding as KeyShortcut, // Key binding struct (renamed to avoid conflict)
};

// ─────────────────────────────────────────────────────────────────────────────
// ANSI COMMANDS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// ANSI terminal commands for scroll regions and advanced terminal control.
///
/// These commands use standard ANSI escape sequences that work over SSH:
/// - Scroll region commands (DECSTBM) for limiting scroll areas
/// - Alternate screen scroll mode for mouse wheel translation
/// - Desktop notifications (OSC 9)
/// - Cursor save/restore
pub use ansi_commands::{
    scroll_region_down,     // Scroll down within region using RI
    scroll_region_up,       // Scroll up within region using IND
    DisableAlternateScroll, // Disable mouse wheel translation in alt screen
    EnableAlternateScroll,  // Enable mouse wheel translation in alt screen
    Index,                  // Move cursor down, scroll at bottom (ESC D)
    PostNotification,       // Send desktop notification (OSC 9)
    ResetScrollRegion,      // Reset scroll region to full screen (ESC [ r)
    RestoreCursor,          // Restore cursor position (DECRC, ESC 8)
    ReverseIndex,           // Move cursor up, scroll at top (ESC M)
    SaveCursor,             // Save cursor position (DECSC, ESC 7)
    ScrollDown,             // Scroll down N lines (CSI T)
    ScrollUp,               // Scroll up N lines (CSI S)
    SetScrollRegion,        // Set scroll region (DECSTBM, ESC [ Pt;Pb r)
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNCHRONIZED OUTPUT EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Synchronized output for flicker-free terminal updates.
///
/// Wrap rendering in BeginSynchronizedUpdate/EndSynchronizedUpdate to buffer
/// all output and display it atomically. Essential for reducing flicker over SSH.
pub use sync_output::{
    with_synchronized_output, // Execute closure with sync output
    BeginSynchronizedUpdate,  // Start buffering (ESC [ ? 2026 h)
    EndSynchronizedUpdate,    // Flush buffer (ESC [ ? 2026 l)
    SynchronizedOutputGuard,  // RAII guard for sync output
};

// ─────────────────────────────────────────────────────────────────────────────
// VIEWPORT EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Viewport management for scrollable content with proper clipping.
///
/// This provides Codex-style viewport rendering with:
/// - Negative y offset for partially visible content
/// - Auto-scroll (follow bottom) detection
/// - Chunk-based visibility ensuring
pub use viewport::{
    CachedRenderable, // Height-caching wrapper for Renderable
    InsetRenderable,  // Padding/margin wrapper
    Renderable,       // Trait for height-aware rendering
    TextRenderable,   // Simple text implementation
    ViewportView,     // Core viewport state and rendering
};

// ─────────────────────────────────────────────────────────────────────────────
// INLINE SCROLL EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Inline scrolling with scroll regions for terminal scrollback integration.
///
/// Use these for inline TUI mode where you want history to flow into
/// the terminal's native scrollback rather than being lost.
pub use inline_scroll::insert_history_lines;

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION LIST EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Selection list rendering for popups and menus.
///
/// Includes fuzzy matching, aligned descriptions, and smart wrapping.
pub use selection_list::{
    fuzzy_filter,        // Filter items by fuzzy match
    fuzzy_match,         // Perform fuzzy matching
    fuzzy_score,         // Score a fuzzy match
    SelectionList,       // Selection list widget
    SelectionListConfig, // Configuration for selection list
    SelectionRow,        // A row in a selection list
};

// ─────────────────────────────────────────────────────────────────────────────
// ELAPSED TIME EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Elapsed time formatting and timer utilities.
///
/// Includes compact duration formatting and animated spinners.
pub use elapsed::{
    format_duration_compact, // Format Duration compactly
    format_elapsed_compact,  // Format seconds compactly
    format_elapsed_precise,  // Format with ms precision
    spinner,                 // Get current spinner frame
    spinner_frame,           // Get spinner frame with custom interval
    spinner_span,            // Get spinner as ratatui Span
    PausableTimer,           // Timer with pause/resume
    SPINNER_ASCII,           // ASCII spinner frames
    SPINNER_DOTS,            // Braille dots spinner
    SPINNER_FRAMES,          // Default spinner frames
};

// ─────────────────────────────────────────────────────────────────────────────
// DIFF EXPORTS (ENHANCED)
// ─────────────────────────────────────────────────────────────────────────────

/// Enhanced diff rendering with proper line wrapping.
pub use diff::{
    calculate_line_number_width,     // Calculate gutter width
    render_diff_wrapped,             // Render with line wrapping
    render_diff_wrapped_with_styles, // Render with custom styles and wrapping
    render_hunk_separator,           // Render hunk separator
    render_line_count_summary,       // Render (+N -M) summary
    render_wrapped_diff_line,        // Render single wrapped diff line
};

// ─────────────────────────────────────────────────────────────────────────────
// ANSI TEXT EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// ANSI escape code handling for terminal output.
pub use ansi_text::{
    ansi_display_width, // Width ignoring ANSI codes
    expand_tabs,        // Replace tabs with spaces
    expand_tabs_width,  // Replace tabs with custom width
    parse_ansi,         // Parse ANSI to ratatui Text
    parse_ansi_line,    // Parse single line with ANSI
    strip_ansi,         // Remove ANSI codes from string
};

// ─────────────────────────────────────────────────────────────────────────────
// BORDER EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Box and border drawing utilities.
pub use borders::{
    card_inner_width,     // Calculate usable inner width
    horizontal_separator, // Create horizontal separator line
    padded_emoji,         // Emoji with hair space
    separator_with_text,  // Separator with centered text
    with_border,          // Wrap content in rounded border
    with_border_style,    // Wrap with custom border style
    with_border_width,    // Wrap with minimum width
    BorderStyle,          // Border style configuration
};

// ─────────────────────────────────────────────────────────────────────────────
// FIELD FORMAT EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Field formatting for aligned displays.
pub use field_format::{
    truncate_line_to_width,      // Truncate line to width
    truncate_line_with_ellipsis, // Truncate with ellipsis
    FieldFormatter,              // Aligned field/value formatter
};
// Note: is_blank_line, line_display_width, line_to_static already exported from render_utils

// ─────────────────────────────────────────────────────────────────────────────
// SHIMMER EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Shimmer animation effect for loading indicators.
pub use shimmer::{
    shimmer_line,              // Create shimmer line
    shimmer_line_with_config,  // With custom config
    shimmer_spans,             // Create shimmer spans
    shimmer_spans_at_time,     // At specific time offset
    shimmer_spans_with_config, // With custom config
    ShimmerConfig,             // Shimmer configuration
};

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTRAINTS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Layout constraints system for responsive terminal UIs.
///
/// Provides:
/// - Min/max width/height constraints
/// - Flex-like proportional distribution
/// - Responsive breakpoints
/// - Priority-based degradation
pub use layout_constraints::{
    allocate_priority_zones, // Allocate space by priority
    content_width,           // Calculate inner content width
    distribute_flex,         // Distribute width among flex items
    responsive_width,        // Calculate responsive width
    Breakpoint,              // Terminal width breakpoints
    FlexItem,                // Flex item configuration
    LayoutConstraints,       // Core constraint struct
    Priority,                // Priority levels
    PriorityZone,            // Zone with priority
    Spacing,                 // Padding/margin spacing
    ZoneConfig,              // Zone configuration
    ZoneLayout,              // Multi-zone layout builder
};

/// Layout presets for common UI elements.
pub use layout_constraints::presets;

// ─────────────────────────────────────────────────────────────────────────────
// KILL RING EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Kill ring and text editing utilities.
///
/// Provides Emacs-style kill ring for storing deleted text:
/// - Ctrl+K: kill to end of line
/// - Ctrl+U: kill to start of line
/// - Ctrl+W / Alt+Backspace: kill word backward
/// - Ctrl+Y: yank (paste) last killed text
/// - Alt+Y: rotate through kill ring
pub use kill_ring::{
    // Word boundaries
    current_word_end,   // Find end of current word
    current_word_start, // Find start of current word
    is_word_separator,  // Check if char is word separator
    // Kill operations
    kill_to_end,         // Kill to end of line (Ctrl+K)
    kill_to_start,       // Kill to start of line (Ctrl+U)
    kill_word_backward,  // Kill word backward (Alt+Backspace)
    kill_word_forward,   // Kill word forward (Alt+Delete)
    next_word_end,       // Find end of next word
    previous_word_start, // Find start of previous word
    transpose_chars,     // Transpose characters (Ctrl+T)
    transpose_words,     // Transpose words (Alt+T)
    KillResult,          // Result of a kill operation
    // Kill ring
    KillRing, // Main kill ring struct
    YankInfo, // Info about last yank for replacement
    // Constants
    DEFAULT_KILL_RING_SIZE,
    WORD_SEPARATORS,
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM DIALOG EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Confirmation dialog for yes/no prompts.
pub use confirm_dialog::{ConfirmDialog, ConfirmDialogWidget, ConfirmResult};

// ─────────────────────────────────────────────────────────────────────────────
// HYPERLINK EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// OSC-8 terminal hyperlinks for clickable URLs.
pub use hyperlink::{
    contains_hyperlink,        // Check if string has hyperlinks
    extract_urls,              // Extract URLs from hyperlinked text
    format_link,               // Format URL as clickable link
    format_link_with_fallback, // With non-TTY fallback
    link_end,                  // OSC 8 end sequence
    link_span,                 // Ratatui Span with link
    link_start,                // OSC 8 start sequence
    strip_hyperlinks,          // Remove hyperlink formatting
    url_span,                  // Span with URL as label
    wrap_in_link,              // Wrap text in link
};

// ─────────────────────────────────────────────────────────────────────────────
// ASCII ANIMATION EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// ASCII animation system with built-in presets.
pub use ascii_animation::{
    // Built-in animations
    bouncing_ball,
    box_spin,
    clock,
    earth,
    progress_bar,
    pulse_ascii,
    spinner_dots,
    spinner_grow,
    spinner_line,
    thinking,
    wave,
    AnimationPreset, // Built-in animation presets
    // Core
    AsciiAnimation, // Main animation struct
    DEFAULT_FRAME_DURATION,
};

// ─────────────────────────────────────────────────────────────────────────────
// SKILLS EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Skills system for dynamically activating specialized behaviors.
///
/// Skills allow the agent to adapt its behavior based on context:
/// - Frontend design skill: Enhanced UI/UX focus
/// - Backend skill: API and database expertise
/// - Testing skill: Test-first development
///
/// Skills can be loaded from SKILL.md files following the Agent Skills spec:
/// - `~/.composer/skills/` for global user skills
/// - `.composer/skills/` for project-specific skills
pub use skills::{
    skills_to_prompt,     // Generate XML prompt block for skills
    ActiveSkill,          // Runtime skill state
    LoadedSkill,          // Result of loading a skill file
    SkillActivationState, // Inactive, Activating, Active, etc.
    SkillDefinition,      // Skill metadata and configuration
    SkillEvent,           // Skill lifecycle events
    SkillId,              // Unique skill identifier
    SkillLoadError,       // Errors from skill loading
    SkillLoader,          // Filesystem skill loader
    SkillRegistry,        // Skill management registry
    SkillResources,       // Resource directories (scripts, references, assets)
    SkillSource,          // Builtin, User, Plugin, Remote
};

// ─────────────────────────────────────────────────────────────────────────────
// SWARM EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/// Swarm mode for multi-agent task orchestration.
///
/// Break down complex tasks into subtasks executed by multiple agents:
/// - Dependency management between tasks
/// - Parallel execution with configurable concurrency
/// - Progress tracking and event streaming
/// - Markdown-based plan parsing
pub use swarm::{
    parse_plan,        // Parse markdown plan to SwarmPlan
    parse_simple_list, // Parse simple task list format
    validate_plan,     // Validate plan for consistency
    AgentId,           // Unique agent identifier
    SwarmConfig,       // Execution configuration
    SwarmEvent,        // Execution events
    SwarmExecutor,     // Main executor
    SwarmPlan,         // Execution plan
    SwarmState,        // Current execution state
    SwarmStatus,       // Running, Completed, Failed, etc.
    SwarmTask,         // Individual task definition
    TaskId,            // Unique task identifier
    TaskPriority,      // Low, Normal, High, Critical
    TaskResult,        // Task execution result
    TaskStatus,        // Pending, Running, Completed, etc.
};

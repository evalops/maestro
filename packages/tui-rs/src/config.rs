//! # TOML-based Configuration System with Profiles
//!
//! Ported from OpenAI Codex (MIT License) config pattern.
//!
//! ## Rust Concept: Configuration Loading
//!
//! This module demonstrates several important Rust patterns:
//!
//! 1. **Serde Serialization**: Using `#[derive(Serialize, Deserialize)]` to
//!    automatically convert between TOML files and Rust structs.
//!
//! 2. **Global Mutable State**: Using `Lazy<RwLock<T>>` for a thread-safe
//!    configuration cache that can be read from anywhere.
//!
//! 3. **Option-heavy Structs**: Using `Option<T>` for every field allows
//!    partial configuration - only specified fields override defaults.
//!
//! 4. **Deep Merging**: Implementing layered configuration where multiple
//!    sources combine into a final configuration.
//!
//! ## Configuration Sources (in order of precedence)
//!
//! 1. CLI flags (--model, --config key=value)
//! 2. Environment variables (MAESTRO_*)
//! 3. Active profile settings
//! 4. Project config.toml (.composer/config.toml)
//! 5. Global config.toml (~/.composer/config.toml)
//! 6. Built-in defaults (DEFAULT_CONFIG)
//!
//! ## Example config.toml
//!
//! ```toml
//! model = "gpt-5.5"
//! model_provider = "openai"
//! approval_policy = "on-failure"
//!
//! [profiles.fast]
//! model = "claude-3-haiku"
//!
//! [mcp_servers.context7]
//! command = "npx"
//! args = ["-y", "@upstash/context7-mcp"]
//! ```

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

// `once_cell::Lazy` provides lazy initialization for static values.
// The value is computed on first access and cached for subsequent accesses.
// This is Rust's solution to the "static initialization order" problem.

use serde::{Deserialize, Serialize};
// Serde is Rust's standard serialization framework.
// `Serialize` allows converting structs to formats like JSON, TOML
// `Deserialize` allows parsing formats into structs
// Derive macros auto-generate the implementation based on struct fields.

use std::collections::HashMap;
// HashMap is Rust's hash table implementation, similar to:
// - JavaScript: Object or Map
// - Python: dict
// - Java: HashMap

use std::env;
// Environment variable access

use std::fs;
// Filesystem operations (read, write files)

use std::path::{Path, PathBuf};
// `Path` is a borrowed path (like &str for strings)
// `PathBuf` is an owned path (like String for strings)

use std::sync::RwLock;
// RwLock allows multiple readers OR one writer at a time.
// This is thread-safe: multiple threads can read config simultaneously,
// but only one can update it. `Mutex` would only allow one accessor at a time.

// ─────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────
//
// Rust Concept: Serde Attributes
//
// Serde provides attributes to customize serialization:
//
// - `#[serde(rename_all = "kebab-case")]`: Converts PascalCase to kebab-case
//   So `OnFailure` becomes "on-failure" in TOML/JSON
//
// - `#[serde(rename = "foo")]`: Renames a specific field/variant
//
// - `#[serde(flatten)]`: Merges fields from a nested struct into the parent
//
// - `#[serde(untagged)]`: For enums, tries each variant in order without
//   looking for a type tag (useful for flexible input formats)

/// Approval policy for tool execution.
///
/// Controls when the user is asked to approve tool execution.
/// Lower values are more permissive; higher values are safer.
///
/// # Rust Concept: Enum with Serde
///
/// `#[serde(rename_all = "kebab-case")]` transforms variant names:
/// - `Untrusted` -> "untrusted"
/// - `OnFailure` -> "on-failure"
/// - `OnRequest` -> "on-request"
/// - `Never` -> "never"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    /// Ask for approval on all tool calls (safest)
    #[default]
    Untrusted,
    /// Only ask when a tool fails
    OnFailure,
    /// Ask when the model requests it
    OnRequest,
    /// Never ask - auto-approve everything (dangerous!)
    Never,
}

impl ApprovalPolicy {
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "untrusted" => Some(Self::Untrusted),
            "on-failure" => Some(Self::OnFailure),
            "on-request" => Some(Self::OnRequest),
            "never" => Some(Self::Never),
            _ => None,
        }
    }
}

/// Sandbox execution mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    #[default]
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read-only" => Some(Self::ReadOnly),
            "workspace-write" => Some(Self::WorkspaceWrite),
            "danger-full-access" => Some(Self::DangerFullAccess),
            _ => None,
        }
    }
}

/// Model reasoning effort level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Minimal,
    Low,
    #[default]
    Medium,
    High,
}

/// Reasoning summary mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningSummary {
    #[default]
    Auto,
    Concise,
    Detailed,
    None,
}

/// Model output verbosity
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModelVerbosity {
    Low,
    #[default]
    Medium,
    High,
}

/// Wire API format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    #[default]
    Chat,
    Responses,
}

/// Model provider configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelProviderConfig {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub env_key: Option<String>,
    pub wire_api: Option<WireApi>,
    pub query_params: Option<HashMap<String, String>>,
    pub http_headers: Option<HashMap<String, String>>,
    pub env_http_headers: Option<HashMap<String, String>>,
    pub request_max_retries: Option<u32>,
    pub stream_max_retries: Option<u32>,
    pub stream_idle_timeout_ms: Option<u64>,
}

/// MCP server configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub bearer_token_env_var: Option<String>,
    pub http_headers: Option<HashMap<String, String>>,
    pub env_http_headers: Option<HashMap<String, String>>,
    pub enabled: Option<bool>,
    pub startup_timeout_sec: Option<u32>,
    pub tool_timeout_sec: Option<u32>,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Option<Vec<String>>,
}

/// Features configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeaturesConfig {
    pub web_search_request: Option<bool>,
    pub view_image_tool: Option<bool>,
    pub ghost_commit: Option<bool>,
    #[serde(flatten)]
    pub extra: HashMap<String, bool>,
}

/// Tools configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolsConfig {
    pub web_search: Option<bool>,
    pub view_image: Option<bool>,
}

/// OTLP HTTP exporter configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OtlpHttpConfig {
    pub endpoint: String,
    pub protocol: Option<String>,
    pub headers: Option<HashMap<String, String>>,
}

/// OTLP gRPC exporter configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OtlpGrpcConfig {
    pub endpoint: String,
    pub headers: Option<HashMap<String, String>>,
}

/// OTEL exporter type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OtelExporter {
    None,
    #[serde(rename = "otlp-http")]
    OtlpHttp(OtlpHttpConfig),
    #[serde(rename = "otlp-grpc")]
    OtlpGrpc(OtlpGrpcConfig),
}

/// OTEL configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OtelConfig {
    pub environment: Option<String>,
    pub exporter: Option<OtelExporter>,
    pub log_user_prompt: Option<bool>,
}

/// History persistence mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryPersistence {
    #[default]
    SaveAll,
    None,
}

impl HistoryPersistence {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "none" => Some(Self::None),
            "save-all" | "save_all" | "saveall" | "all" => Some(Self::SaveAll),
            _ => None,
        }
    }
}

/// History configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryConfig {
    pub persistence: Option<HistoryPersistence>,
    pub max_bytes: Option<usize>,
}

/// Notifications setting (bool or list of event types)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NotificationsSetting {
    Enabled(bool),
    Events(Vec<String>),
}

impl Default for NotificationsSetting {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

/// Tab progress bar (OSC 9;4) support mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TabProgressMode {
    /// Emit OSC 9;4 only when the detected terminal is known to support it
    /// (iTerm2, `WezTerm`, ConEmu, detected via `TERM_PROGRAM`).
    #[default]
    Auto,
    /// Always emit OSC 9;4 sequences, regardless of the detected terminal.
    Always,
    /// Never emit OSC 9;4 sequences.
    Never,
}

/// TUI configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TuiConfig {
    pub notifications: Option<NotificationsSetting>,
    pub animations: Option<bool>,
    /// When true (default), an unrecognized slash command is forwarded to the
    /// agent as a prompt. Set to false to surface an error instead, so a typo
    /// can never become an unintended (and billed) agent call.
    pub slash_command_fallback: Option<bool>,
    /// Tab progress bar via OSC 9;4 sequences: indeterminate while a turn is
    /// running, cleared on completion. Defaults to `auto`.
    pub tab_progress: Option<TabProgressMode>,
    /// Update the terminal title (OSC 0) with working/idle state, restoring
    /// the original title on exit. Defaults to true.
    pub title_updates: Option<bool>,
    /// Suppress desktop notifications while the terminal window is focused
    /// (only when the terminal reports focus in/out events). Defaults to true.
    pub focus_gated_notifications: Option<bool>,
    /// When true (default false), follow live terminal light/dark and
    /// background-color reports through the protocol-aware input reader.
    /// Falls back to a one-time OSC 11 probe when that reader is unavailable.
    pub theme_follow: Option<bool>,
}

/// Shell environment inheritance mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShellInherit {
    #[default]
    All,
    Core,
    None,
}

/// Shell environment policy
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellEnvironmentPolicy {
    pub inherit: Option<ShellInherit>,
    pub ignore_default_excludes: Option<bool>,
    pub exclude: Option<Vec<String>>,
    pub set: Option<HashMap<String, String>>,
    pub include_only: Option<Vec<String>>,
}

/// Returns true if a workspace is marked trusted in the given config.
///
/// Trust is keyed by the canonical workspace path under `projects."<path>"`.
/// Only honor trust grants from global config: callers must evaluate this
/// against config loaded before any project config is merged, otherwise a
/// repository could grant itself trust.
#[must_use]
pub fn workspace_trusted(config: &ComposerConfig, workspace_dir: &Path) -> bool {
    let canonical =
        dunce::canonicalize(workspace_dir).unwrap_or_else(|_| workspace_dir.to_path_buf());
    let key = canonical.to_string_lossy();
    config
        .projects
        .as_ref()
        .and_then(|projects| projects.get(key.as_ref()))
        .and_then(|settings| settings.trust_level)
        == Some(TrustLevel::Trusted)
}

/// Returns true if the workspace is trusted in the *global* config only.
///
/// Trust decisions that gate repository-controlled behavior (project MCP
/// servers, project shell environment policy) must not consult project
/// config, or a repository could grant itself trust.
#[must_use]
pub fn workspace_trusted_in_global_config(workspace_dir: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let global_path = home.join(".composer").join("config.toml");
    parse_config_file(&global_path)
        .map(|config| workspace_trusted(&config, workspace_dir))
        .unwrap_or(false)
}

/// Env var names that a project config must never inject into shell commands:
/// they execute code or preload libraries on shell/process startup.
fn is_dangerous_shell_env_override(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(key.as_str(), "BASH_ENV" | "ENV" | "LD_PRELOAD") || key.starts_with("DYLD_")
}

/// Strip dangerous knobs from a project-supplied shell environment policy.
///
/// A repository-controlled `.composer/config.toml` must not disable the
/// default secret filter or inject startup-code env vars.
fn sanitize_project_shell_environment_policy(policy: &mut ShellEnvironmentPolicy) {
    policy.ignore_default_excludes = None;
    if let Some(set) = policy.set.as_mut() {
        set.retain(|key, _| !is_dangerous_shell_env_override(key));
    }
}

/// Sandbox workspace write configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SandboxWorkspaceWriteConfig {
    pub writable_roots: Option<Vec<String>>,
    pub network_access: Option<bool>,
    pub exclude_tmpdir_env_var: Option<bool>,
    pub exclude_slash_tmp: Option<bool>,
}

/// File opener application
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FileOpener {
    #[default]
    Vscode,
    VscodeInsiders,
    Windsurf,
    Cursor,
    None,
}

/// Project trust level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrustLevel {
    Trusted,
    #[default]
    Untrusted,
}

/// Project-specific settings
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectSettings {
    pub trust_level: Option<TrustLevel>,
}

/// Profile configuration (subset of main config)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileConfig {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub approval_policy: Option<ApprovalPolicy>,
    pub sandbox_mode: Option<SandboxMode>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub model_reasoning_summary: Option<ReasoningSummary>,
    pub model_verbosity: Option<ModelVerbosity>,
    #[serde(flatten)]
    pub extra: HashMap<String, toml::Value>,
}

/// Main Maestro configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ComposerConfig {
    // Model settings
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub model_context_window: Option<usize>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub model_reasoning_summary: Option<ReasoningSummary>,
    pub model_verbosity: Option<ModelVerbosity>,
    pub model_supports_reasoning_summaries: Option<bool>,

    // Execution environment
    pub approval_policy: Option<ApprovalPolicy>,
    pub sandbox_mode: Option<SandboxMode>,
    pub sandbox_workspace_write: Option<SandboxWorkspaceWriteConfig>,
    pub shell_environment_policy: Option<ShellEnvironmentPolicy>,

    // Providers
    pub model_providers: Option<HashMap<String, ModelProviderConfig>>,

    // MCP
    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,

    // Features
    pub features: Option<FeaturesConfig>,
    pub tools: Option<ToolsConfig>,

    // Observability
    pub otel: Option<OtelConfig>,
    pub notify: Option<Vec<String>>,
    pub hide_agent_reasoning: Option<bool>,
    pub show_raw_agent_reasoning: Option<bool>,

    // History
    pub history: Option<HistoryConfig>,

    // TUI
    pub tui: Option<TuiConfig>,

    // Project docs
    pub project_doc_max_bytes: Option<usize>,
    pub project_doc_fallback_filenames: Option<Vec<String>>,

    // Profiles
    pub profile: Option<String>,
    pub profiles: Option<HashMap<String, ProfileConfig>>,

    // File opener
    pub file_opener: Option<FileOpener>,

    // Instructions
    pub instructions: Option<String>,
    pub experimental_instructions_file: Option<String>,

    // Trust
    pub projects: Option<HashMap<String, ProjectSettings>>,
}

impl ComposerConfig {
    /// Resolve `sandbox_mode`/`sandbox_workspace_write` into an enforceable
    /// [`crate::sandbox::SandboxPolicy`]. Returns `None` for
    /// `danger-full-access` (explicitly no sandbox).
    ///
    /// This is the persistent-config escape hatch: a project or global
    /// `config.toml` with
    ///
    /// ```toml
    /// sandbox_mode = "danger-full-access"
    /// ```
    ///
    /// or
    ///
    /// ```toml
    /// [sandbox_workspace_write]
    /// network_access = false
    /// writable_roots = ["/some/extra/path"]
    /// ```
    ///
    /// changes what every subsequent session does, without needing a flag on
    /// every invocation. Because these settings decide how much of the host
    /// a session can touch, project-level values are only honored when the
    /// workspace is trusted — see `load_config`. User-supplied
    /// `writable_roots` are *added to* (not a replacement for) the curated
    /// package-manager cache roots from
    /// [`crate::sandbox::SandboxPolicy::dev_cache_writable_roots`], since
    /// those are load-bearing for `cargo build`/`npm install` — see that
    /// function's docs.
    #[must_use]
    pub fn resolved_sandbox_policy(&self) -> Option<crate::sandbox::SandboxPolicy> {
        use crate::sandbox::SandboxPolicy;

        match self.sandbox_mode.unwrap_or_default() {
            SandboxMode::DangerFullAccess => None,
            SandboxMode::ReadOnly => Some(SandboxPolicy::ReadOnly),
            SandboxMode::WorkspaceWrite => match &self.sandbox_workspace_write {
                None => Some(SandboxPolicy::workspace_write_default()),
                Some(cfg) => {
                    let mut writable_roots = SandboxPolicy::dev_cache_writable_roots();
                    writable_roots.extend(
                        cfg.writable_roots
                            .iter()
                            .flatten()
                            .map(std::path::PathBuf::from),
                    );
                    Some(SandboxPolicy::WorkspaceWrite {
                        writable_roots,
                        network_access: cfg.network_access.unwrap_or(true),
                        exclude_tmpdir_env_var: cfg.exclude_tmpdir_env_var.unwrap_or(false),
                        exclude_slash_tmp: cfg.exclude_slash_tmp.unwrap_or(false),
                    })
                }
            },
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────

/// Default configuration values
pub static DEFAULT_CONFIG: std::sync::LazyLock<ComposerConfig> =
    std::sync::LazyLock::new(|| ComposerConfig {
        model: Some("gpt-5.5".to_string()),
        model_provider: Some("openai".to_string()),
        approval_policy: Some(ApprovalPolicy::Untrusted),
        sandbox_mode: Some(SandboxMode::WorkspaceWrite),
        model_reasoning_effort: Some(ReasoningEffort::Medium),
        features: Some(FeaturesConfig {
            view_image_tool: Some(true),
            ..Default::default()
        }),
        history: Some(HistoryConfig {
            persistence: Some(HistoryPersistence::SaveAll),
            ..Default::default()
        }),
        tui: Some(TuiConfig {
            notifications: Some(NotificationsSetting::Enabled(true)),
            animations: Some(true),
            slash_command_fallback: Some(true),
            tab_progress: Some(TabProgressMode::Auto),
            title_updates: Some(true),
            focus_gated_notifications: Some(true),
            theme_follow: Some(false),
        }),
        file_opener: Some(FileOpener::Vscode),
        project_doc_max_bytes: Some(32 * 1024),
        project_doc_fallback_filenames: Some(vec!["CLAUDE.md".to_string()]),
        ..Default::default()
    });

// ─────────────────────────────────────────────────────────────
// Configuration Cache
// ─────────────────────────────────────────────────────────────
//
// Rust Concept: Global Mutable State
//
// Rust normally doesn't allow global mutable state because it's unsafe
// in concurrent programs. However, sometimes we need it (like caching).
//
// The pattern used here:
// 1. `static` - a global variable that exists for the program lifetime
// 2. `Lazy<T>` - delays initialization until first access
// 3. `RwLock<T>` - provides thread-safe access (multiple readers OR one writer)
//
// Accessing the cache:
// - `CONFIG_CACHE.read().unwrap()` - get a read lock (shared)
// - `CONFIG_CACHE.write().unwrap()` - get a write lock (exclusive)
//
// The `.unwrap()` panics if the lock is poisoned (a thread panicked while
// holding it). In practice, this is rare and indicates a serious bug.

/// Internal cache structure to avoid re-parsing config files.
struct ConfigCache {
    /// Cached configuration (None if not yet loaded)
    config: Option<ComposerConfig>,
    /// The workspace directory this config was loaded for
    workspace_dir: Option<PathBuf>,
    /// The profile name that was active when cached
    profile_name: Option<String>,
}

/// Global configuration cache.
///
/// # Rust Concept: Static with Lazy Initialization
///
/// `static` variables in Rust must be `Sync` (safe to share between threads).
/// `Lazy<RwLock<T>>` satisfies this:
/// - `Lazy` ensures thread-safe initialization
/// - `RwLock` provides thread-safe access
///
/// The `|| { ... }` is a closure that creates the initial value.
static CONFIG_CACHE: std::sync::LazyLock<RwLock<ConfigCache>> = std::sync::LazyLock::new(|| {
    RwLock::new(ConfigCache {
        config: None,
        workspace_dir: None,
        profile_name: None,
    })
});

/// Clear the configuration cache.
///
/// Used primarily in tests to ensure a fresh config load.
pub fn clear_config_cache() {
    // `.write()` acquires an exclusive write lock
    // Use `unwrap_or_else` to recover from poisoned locks
    let mut cache = CONFIG_CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.config = None;
    cache.workspace_dir = None;
    cache.profile_name = None;
}

// ─────────────────────────────────────────────────────────────
// Configuration Loading
// ─────────────────────────────────────────────────────────────

/// Deep merge two configurations, with source values overwriting target values
fn deep_merge(target: &mut ComposerConfig, source: &ComposerConfig) {
    // Simple fields - source overwrites if present
    if source.model.is_some() {
        target.model = source.model.clone();
    }
    if source.model_provider.is_some() {
        target.model_provider = source.model_provider.clone();
    }
    if source.model_context_window.is_some() {
        target.model_context_window = source.model_context_window;
    }
    if source.model_reasoning_effort.is_some() {
        target.model_reasoning_effort = source.model_reasoning_effort;
    }
    if source.model_reasoning_summary.is_some() {
        target.model_reasoning_summary = source.model_reasoning_summary;
    }
    if source.model_verbosity.is_some() {
        target.model_verbosity = source.model_verbosity;
    }
    if source.model_supports_reasoning_summaries.is_some() {
        target.model_supports_reasoning_summaries = source.model_supports_reasoning_summaries;
    }
    if source.approval_policy.is_some() {
        target.approval_policy = source.approval_policy;
    }
    if source.sandbox_mode.is_some() {
        target.sandbox_mode = source.sandbox_mode;
    }
    if source.profile.is_some() {
        target.profile = source.profile.clone();
    }
    if source.file_opener.is_some() {
        target.file_opener = source.file_opener;
    }
    if source.instructions.is_some() {
        target.instructions = source.instructions.clone();
    }
    if source.experimental_instructions_file.is_some() {
        target.experimental_instructions_file = source.experimental_instructions_file.clone();
    }
    if source.project_doc_max_bytes.is_some() {
        target.project_doc_max_bytes = source.project_doc_max_bytes;
    }
    if source.hide_agent_reasoning.is_some() {
        target.hide_agent_reasoning = source.hide_agent_reasoning;
    }
    if source.show_raw_agent_reasoning.is_some() {
        target.show_raw_agent_reasoning = source.show_raw_agent_reasoning;
    }

    // Arrays - source replaces entirely
    if source.notify.is_some() {
        target.notify = source.notify.clone();
    }
    if source.project_doc_fallback_filenames.is_some() {
        target.project_doc_fallback_filenames = source.project_doc_fallback_filenames.clone();
    }

    // Nested objects - merge recursively
    if let Some(source_features) = &source.features {
        let target_features = target.features.get_or_insert_with(Default::default);
        if source_features.web_search_request.is_some() {
            target_features.web_search_request = source_features.web_search_request;
        }
        if source_features.view_image_tool.is_some() {
            target_features.view_image_tool = source_features.view_image_tool;
        }
        if source_features.ghost_commit.is_some() {
            target_features.ghost_commit = source_features.ghost_commit;
        }
        target_features.extra.extend(source_features.extra.clone());
    }

    if let Some(source_tools) = &source.tools {
        let target_tools = target.tools.get_or_insert_with(Default::default);
        if source_tools.web_search.is_some() {
            target_tools.web_search = source_tools.web_search;
        }
        if source_tools.view_image.is_some() {
            target_tools.view_image = source_tools.view_image;
        }
    }

    if let Some(source_history) = &source.history {
        let target_history = target.history.get_or_insert_with(Default::default);
        if source_history.persistence.is_some() {
            target_history.persistence = source_history.persistence;
        }
        if source_history.max_bytes.is_some() {
            target_history.max_bytes = source_history.max_bytes;
        }
    }

    if let Some(source_tui) = &source.tui {
        let target_tui = target.tui.get_or_insert_with(Default::default);
        if source_tui.notifications.is_some() {
            target_tui.notifications = source_tui.notifications.clone();
        }
        if source_tui.animations.is_some() {
            target_tui.animations = source_tui.animations;
        }
        if source_tui.slash_command_fallback.is_some() {
            target_tui.slash_command_fallback = source_tui.slash_command_fallback;
        }
        if source_tui.tab_progress.is_some() {
            target_tui.tab_progress = source_tui.tab_progress;
        }
        if source_tui.title_updates.is_some() {
            target_tui.title_updates = source_tui.title_updates;
        }
        if source_tui.focus_gated_notifications.is_some() {
            target_tui.focus_gated_notifications = source_tui.focus_gated_notifications;
        }
        if source_tui.theme_follow.is_some() {
            target_tui.theme_follow = source_tui.theme_follow;
        }
    }

    if let Some(source_otel) = &source.otel {
        let target_otel = target.otel.get_or_insert_with(Default::default);
        if source_otel.environment.is_some() {
            target_otel.environment = source_otel.environment.clone();
        }
        if source_otel.exporter.is_some() {
            target_otel.exporter = source_otel.exporter.clone();
        }
        if source_otel.log_user_prompt.is_some() {
            target_otel.log_user_prompt = source_otel.log_user_prompt;
        }
    }

    if let Some(source_shell) = &source.shell_environment_policy {
        let target_shell = target
            .shell_environment_policy
            .get_or_insert_with(Default::default);
        if source_shell.inherit.is_some() {
            target_shell.inherit = source_shell.inherit;
        }
        if source_shell.ignore_default_excludes.is_some() {
            target_shell.ignore_default_excludes = source_shell.ignore_default_excludes;
        }
        if source_shell.exclude.is_some() {
            target_shell.exclude = source_shell.exclude.clone();
        }
        if source_shell.set.is_some() {
            target_shell.set = source_shell.set.clone();
        }
        if source_shell.include_only.is_some() {
            target_shell.include_only = source_shell.include_only.clone();
        }
    }

    if let Some(source_sandbox) = &source.sandbox_workspace_write {
        let target_sandbox = target
            .sandbox_workspace_write
            .get_or_insert_with(Default::default);
        if source_sandbox.writable_roots.is_some() {
            target_sandbox.writable_roots = source_sandbox.writable_roots.clone();
        }
        if source_sandbox.network_access.is_some() {
            target_sandbox.network_access = source_sandbox.network_access;
        }
        if source_sandbox.exclude_tmpdir_env_var.is_some() {
            target_sandbox.exclude_tmpdir_env_var = source_sandbox.exclude_tmpdir_env_var;
        }
        if source_sandbox.exclude_slash_tmp.is_some() {
            target_sandbox.exclude_slash_tmp = source_sandbox.exclude_slash_tmp;
        }
    }

    // Maps - merge by key
    if let Some(source_providers) = &source.model_providers {
        let target_providers = target.model_providers.get_or_insert_with(HashMap::new);
        for (key, value) in source_providers {
            target_providers.insert(key.clone(), value.clone());
        }
    }

    if let Some(source_servers) = &source.mcp_servers {
        let target_servers = target.mcp_servers.get_or_insert_with(HashMap::new);
        for (key, value) in source_servers {
            target_servers.insert(key.clone(), value.clone());
        }
    }

    if let Some(source_profiles) = &source.profiles {
        let target_profiles = target.profiles.get_or_insert_with(HashMap::new);
        for (key, value) in source_profiles {
            target_profiles.insert(key.clone(), value.clone());
        }
    }

    if let Some(source_projects) = &source.projects {
        let target_projects = target.projects.get_or_insert_with(HashMap::new);
        for (key, value) in source_projects {
            target_projects.insert(key.clone(), value.clone());
        }
    }
}

/// Parse a TOML configuration file
fn parse_config_file(path: &Path) -> Option<ComposerConfig> {
    if !path.exists() {
        return None;
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to read config file {}: {e}", path.display());
            return None;
        }
    };

    match toml::from_str(&content) {
        Ok(config) => Some(config),
        Err(e) => {
            eprintln!("Failed to parse config file {}: {e}", path.display());
            None
        }
    }
}

/// Apply environment variable overrides
fn apply_env_overrides(config: &mut ComposerConfig) {
    apply_env_overrides_from(config, |key| env::var(key).ok());
}

/// Apply overrides from an environment-like lookup.
///
/// Keeping the lookup injectable lets tests verify precedence without
/// mutating process-wide environment variables while other config tests run
/// in parallel.
fn apply_env_overrides_from(
    config: &mut ComposerConfig,
    mut lookup: impl FnMut(&str) -> Option<String>,
) {
    // MAESTRO_MODEL
    if let Some(model) = lookup("MAESTRO_MODEL") {
        config.model = Some(model);
    }

    // MAESTRO_MODEL_PROVIDER
    if let Some(provider) = lookup("MAESTRO_MODEL_PROVIDER") {
        config.model_provider = Some(provider);
    }

    // MAESTRO_APPROVAL_POLICY
    if let Some(policy) = lookup("MAESTRO_APPROVAL_POLICY") {
        if let Some(p) = ApprovalPolicy::parse(&policy) {
            config.approval_policy = Some(p);
        }
    }

    // MAESTRO_SANDBOX_MODE
    if let Some(mode) = lookup("MAESTRO_SANDBOX_MODE") {
        if let Some(m) = SandboxMode::parse(&mode) {
            config.sandbox_mode = Some(m);
        }
    }

    // MAESTRO_PROFILE
    if let Some(profile) = lookup("MAESTRO_PROFILE") {
        config.profile = Some(profile);
    }

    // MAESTRO_HISTORY_PERSISTENCE
    if let Some(persistence) = lookup("MAESTRO_HISTORY_PERSISTENCE") {
        if let Some(parsed) = HistoryPersistence::parse(&persistence) {
            let history = config.history.get_or_insert_with(Default::default);
            history.persistence = Some(parsed);
        }
    }

    // MAESTRO_HISTORY_MAX_BYTES
    if let Some(max_bytes) = lookup("MAESTRO_HISTORY_MAX_BYTES") {
        if let Ok(parsed) = max_bytes.trim().parse::<usize>() {
            let history = config.history.get_or_insert_with(Default::default);
            history.max_bytes = Some(parsed);
        }
    }
}

/// Apply profile settings to configuration
fn apply_profile(config: &mut ComposerConfig, profile_name: &str) {
    let profile = if let Some(profiles) = &config.profiles {
        if let Some(p) = profiles.get(profile_name) {
            p.clone()
        } else {
            eprintln!("Profile not found: {profile_name}");
            return;
        }
    } else {
        eprintln!("No profiles defined");
        return;
    };

    // Apply profile fields
    if profile.model.is_some() {
        config.model = profile.model;
    }
    if profile.model_provider.is_some() {
        config.model_provider = profile.model_provider;
    }
    if profile.approval_policy.is_some() {
        config.approval_policy = profile.approval_policy;
    }
    if profile.sandbox_mode.is_some() {
        config.sandbox_mode = profile.sandbox_mode;
    }
    if profile.model_reasoning_effort.is_some() {
        config.model_reasoning_effort = profile.model_reasoning_effort;
    }
    if profile.model_reasoning_summary.is_some() {
        config.model_reasoning_summary = profile.model_reasoning_summary;
    }
    if profile.model_verbosity.is_some() {
        config.model_verbosity = profile.model_verbosity;
    }
}

/// Load configuration from files and environment.
///
/// This is the main entry point for loading configuration. It implements
/// the layered configuration model, merging sources in order of precedence.
///
/// # Arguments
///
/// * `workspace_dir` - The current workspace directory (used for .composer/config.toml)
/// * `profile_name` - Optional profile name to activate (overrides config file's profile)
///
/// # Returns
///
/// A fully merged `ComposerConfig` with all overrides applied.
///
/// # Rust Concept: Caching with `RwLock`
///
/// Configuration loading is expensive (file I/O, parsing). We cache the result
/// and only reload if the workspace or profile changes.
///
/// Resolve the sandbox policy the *interactive TUI* should use for a session,
/// in precedence order:
///
/// 1. `MAESTRO_SANDBOX_MODE` env var — an explicit, session-scoped request
///    from the user (the same variable and grammar `maestro print`/`exec`
///    already honor). This is always applied when set to a recognized value,
///    regardless of the staged-rollout gate below: honoring an explicit,
///    already-existing env var the user typed is a pure bugfix (today it is
///    silently ignored by the interactive TUI), not a default-behavior change
///    that needs staging.
/// 2. The staged-rollout internal gate `MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT`
///    (see `docs/CONVENTIONS/staged-rollout-registry.json`, entry
///    `internal-gate:tui-sandbox-default`). While this is unset/false, the
///    interactive TUI keeps its historical unsandboxed-by-default behavior —
///    this ships the sandboxing mechanism as an enabling primitive, not as a
///    default-behavior flip, until a follow-up PR promotes it after an
///    internal soak period.
/// 3. Once the gate is set, `ComposerConfig::resolved_sandbox_policy` (which
///    itself defaults to [`crate::sandbox::SandboxPolicy::workspace_write_default`]
///    unless the config says otherwise).
#[must_use]
pub fn resolve_interactive_sandbox_policy(
    config: &ComposerConfig,
) -> Option<crate::sandbox::SandboxPolicy> {
    if let Ok(value) = std::env::var("MAESTRO_SANDBOX_MODE") {
        if matches!(value.trim(), "workspace-write" | "native") {
            let mut overridden = config.clone();
            overridden.sandbox_mode = Some(SandboxMode::WorkspaceWrite);
            return overridden.resolved_sandbox_policy();
        }
        if let Some(resolved) = parse_sandbox_mode_env_override(&value) {
            return resolved;
        }
        // Empty or unrecognized: fall through rather than silently disabling
        // the sandbox on a typo.
    }
    if !env_flag_enabled("MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT") {
        return None;
    }
    config.resolved_sandbox_policy()
}

/// Parse `MAESTRO_SANDBOX_MODE`. `Some(None)` means "explicitly no sandbox"
/// (`danger-full-access`); `None` means "not a recognized value, ignore it"
/// (the caller falls through to the next precedence tier rather than
/// treating a typo as an implicit opt-out).
fn parse_sandbox_mode_env_override(value: &str) -> Option<Option<crate::sandbox::SandboxPolicy>> {
    use crate::sandbox::SandboxPolicy;
    match value.trim() {
        "danger-full-access" => Some(None),
        "read-only" => Some(Some(SandboxPolicy::ReadOnly)),
        _ => None,
    }
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// The `{ ... }` block creates a temporary scope. The read lock is released
/// when `cache` goes out of scope at the end of the block. This allows us
/// to acquire a write lock later without deadlock.
pub fn load_config(workspace_dir: &Path, profile_name: Option<&str>) -> ComposerConfig {
    // Check cache - use a block to limit the scope of the read lock
    {
        let cache = CONFIG_CACHE
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Return cached config if it matches the requested parameters
        if cache.config.is_some()
            && cache.workspace_dir.as_deref() == Some(workspace_dir)
            && cache.profile_name.as_deref() == profile_name
        {
            // Clone the config because we can't return a reference to cached data
            // (the lock would be released when we return)
            return cache.config.clone().unwrap();
        }
    } // Read lock is released here

    // Start with defaults
    let mut config = DEFAULT_CONFIG.clone();

    // Load global config
    if let Some(home) = dirs::home_dir() {
        let global_path = home.join(".composer").join("config.toml");
        if let Some(global_config) = parse_config_file(&global_path) {
            deep_merge(&mut config, &global_config);
        }
    }

    // Load project config
    let project_path = workspace_dir.join(".composer").join("config.toml");
    if let Some(mut project_config) = parse_config_file(&project_path) {
        // The shell environment policy is applied verbatim to every spawned
        // command, so a repository-controlled config must not weaken secret
        // filtering or inject code-execution env vars. Only honor it when the
        // workspace is trusted (trust is read from global config above, so a
        // project cannot grant itself trust), and sanitize it even then.
        if workspace_trusted(&config, workspace_dir) {
            if let Some(policy) = project_config.shell_environment_policy.as_mut() {
                sanitize_project_shell_environment_policy(policy);
            }
        } else {
            project_config.shell_environment_policy = None;
            // Sandbox settings decide how much of the host a session can
            // touch, so they are security-sensitive in the same way: an
            // untrusted repository must not be able to check in
            // `sandbox_mode = "danger-full-access"` (disabling the sandbox
            // for everyone who opens it) or widen `sandbox_workspace_write`
            // with sensitive absolute paths. Strip them — and any
            // project-defined profile that could smuggle the same override
            // back in — unless the workspace is trusted; the global config
            // and env overrides remain authoritative.
            project_config.sandbox_mode = None;
            project_config.sandbox_workspace_write = None;
            if let Some(profiles) = project_config.profiles.as_mut() {
                for profile in profiles.values_mut() {
                    profile.sandbox_mode = None;
                }
            }
            // Stripping a project-defined profile's own `sandbox_mode`
            // (above) only stops an untrusted repo from smuggling a
            // dangerous profile IN. It does nothing to stop the repo from
            // smuggling a dangerous profile SELECTION: `active_profile`
            // below resolves from `config.profile` after this project
            // config is merged in, and `apply_profile` looks that name up
            // in the *merged* `profiles` map, which still includes every
            // profile the user's own trusted global config defines. A repo
            // checking in `profile = "unsandboxed"` in its
            // `.composer/config.toml` could silently activate a profile the
            // user only ever intended to opt into manually (e.g. via
            // `maestro --profile unsandboxed`), bypassing the sandbox
            // default without the user typing anything.
            //
            // Selecting a profile the *project itself* defines is fine: its
            // `sandbox_mode` was just stripped above, so activating it
            // can't touch the sandbox, and legitimate repo-local profiles
            // (picking a project's preferred model, for instance) still
            // work. Only a selector that resolves outside the project's own
            // `profiles` table -- i.e. into the trusted global config's
            // profiles -- is security-sensitive, so only that case is
            // cleared.
            let selects_only_a_project_owned_profile =
                project_config.profile.as_deref().is_some_and(|name| {
                    project_config
                        .profiles
                        .as_ref()
                        .is_some_and(|profiles| profiles.contains_key(name))
                });
            if !selects_only_a_project_owned_profile {
                project_config.profile = None;
            }
        }
        deep_merge(&mut config, &project_config);
    }

    // Apply environment overrides
    apply_env_overrides(&mut config);

    // Determine active profile
    let active_profile = profile_name
        .map(String::from)
        .or_else(|| config.profile.clone());
    if let Some(ref profile) = active_profile {
        apply_profile(&mut config, profile);
    }

    // Cache the result
    {
        let mut cache = CONFIG_CACHE
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.config = Some(config.clone());
        cache.workspace_dir = Some(workspace_dir.to_path_buf());
        cache.profile_name = profile_name.map(String::from);
    }

    config
}

/// Load configuration with CLI overrides
#[must_use]
pub fn load_config_with_overrides(
    workspace_dir: &Path,
    profile_name: Option<&str>,
    cli_overrides: ComposerConfig,
) -> ComposerConfig {
    let mut config = load_config(workspace_dir, profile_name);
    deep_merge(&mut config, &cli_overrides);
    config
}

// ─────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────

/// Get the list of available profiles
#[must_use]
pub fn get_available_profiles(workspace_dir: &Path) -> Vec<String> {
    let config = load_config(workspace_dir, None);
    match config.profiles {
        Some(profiles) => profiles.keys().cloned().collect(),
        None => Vec::new(),
    }
}

/// Get a summary of the current configuration for display
#[must_use]
pub fn get_config_summary(workspace_dir: &Path) -> String {
    let config = load_config(workspace_dir, None);
    let mut lines = Vec::new();

    lines.push("Current Configuration".to_string());
    lines.push("─".repeat(40));
    lines.push(format!(
        "Model: {}",
        config.model.as_deref().unwrap_or("default")
    ));
    lines.push(format!(
        "Provider: {}",
        config.model_provider.as_deref().unwrap_or("openai")
    ));
    lines.push(format!(
        "Approval Policy: {:?}",
        config.approval_policy.unwrap_or_default()
    ));
    lines.push(format!(
        "Sandbox Mode: {:?}",
        config.sandbox_mode.unwrap_or_default()
    ));

    if let Some(ref profile) = config.profile {
        lines.push(format!("Active Profile: {profile}"));
    }

    let profiles = get_available_profiles(workspace_dir);
    if !profiles.is_empty() {
        lines.push(format!("Available Profiles: {}", profiles.join(", ")));
    }

    lines.join("\n")
}

/// Parse a CLI config override in the format "key=value"
#[must_use]
pub fn parse_cli_override(override_str: &str) -> Option<(String, toml::Value)> {
    let eq_index = override_str.find('=')?;
    if eq_index == 0 {
        return None;
    }

    let key = override_str[..eq_index].trim().to_string();
    let value_str = override_str[eq_index + 1..].trim();

    // Try to parse as TOML value
    let toml_str = format!("value = {value_str}");
    if let Ok(table) = toml::from_str::<toml::Table>(&toml_str) {
        let value = table.get("value")?.clone();
        Some((key, value))
    } else {
        // Treat as string, removing surrounding quotes if present
        let mut v = value_str.to_string();
        if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
            v = v[1..v.len() - 1].to_string();
        }
        Some((key, toml::Value::String(v)))
    }
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────
//
// Rust Concept: Unit Testing
//
// Tests in Rust are typically in a `mod tests` block at the end of the file.
//
// Key testing patterns:
// - `#[cfg(test)]`: Only compile this module when running tests
// - `use super::*`: Import everything from the parent module
// - `#[test]`: Mark a function as a test
// - `assert_eq!(a, b)`: Panic if a != b (test fails)
// - `assert!(condition)`: Panic if condition is false
//
// Run tests with: `cargo test`
// Run specific test: `cargo test test_name`
// Run with output: `cargo test -- --nocapture`

#[cfg(test)]
mod tests {
    use super::*; // Import everything from parent (config) module
    use tempfile::TempDir; // Creates temporary directories that auto-cleanup

    #[test]
    fn test_default_config() {
        let config = DEFAULT_CONFIG.clone();
        assert_eq!(config.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(config.model_provider.as_deref(), Some("openai"));
        assert_eq!(config.approval_policy, Some(ApprovalPolicy::Untrusted));
        assert_eq!(config.sandbox_mode, Some(SandboxMode::WorkspaceWrite));
    }

    #[test]
    fn resolved_sandbox_policy_danger_full_access_disables_sandbox() {
        let config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::DangerFullAccess),
            ..Default::default()
        };
        assert!(config.resolved_sandbox_policy().is_none());
    }

    #[test]
    fn resolved_sandbox_policy_read_only() {
        let config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::ReadOnly),
            ..Default::default()
        };
        assert_eq!(
            config.resolved_sandbox_policy(),
            Some(crate::sandbox::SandboxPolicy::ReadOnly)
        );
    }

    #[test]
    fn resolved_sandbox_policy_workspace_write_defaults_to_network_on() {
        let config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        };
        let policy = config
            .resolved_sandbox_policy()
            .expect("workspace-write must resolve to a policy");
        assert!(policy.has_full_network_access());
        assert!(!policy.has_full_disk_write_access());
    }

    #[test]
    fn resolved_sandbox_policy_merges_user_roots_with_dev_cache_roots() {
        let config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::WorkspaceWrite),
            sandbox_workspace_write: Some(SandboxWorkspaceWriteConfig {
                writable_roots: Some(vec!["/custom/extra/path".to_string()]),
                network_access: Some(false),
                exclude_tmpdir_env_var: None,
                exclude_slash_tmp: None,
            }),
            ..Default::default()
        };
        let policy = config
            .resolved_sandbox_policy()
            .expect("workspace-write must resolve to a policy");
        assert!(!policy.has_full_network_access());
        let crate::sandbox::SandboxPolicy::WorkspaceWrite { writable_roots, .. } = &policy else {
            panic!("expected WorkspaceWrite");
        };
        assert!(writable_roots
            .iter()
            .any(|root| root == std::path::Path::new("/custom/extra/path")));
    }

    #[test]
    fn test_tui_slash_command_fallback_loads_from_project_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        let config_path = config_dir.join("config.toml");
        fs::write(
            &config_path,
            r"
[tui]
slash_command_fallback = false
",
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        assert_eq!(
            config.tui.and_then(|tui| tui.slash_command_fallback),
            Some(false)
        );
    }

    #[test]
    fn test_deep_merge_tui_slash_command_fallback() {
        let mut target = ComposerConfig::default();
        let source = ComposerConfig {
            tui: Some(TuiConfig {
                slash_command_fallback: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        };

        deep_merge(&mut target, &source);
        assert_eq!(
            target.tui.and_then(|tui| tui.slash_command_fallback),
            Some(false)
        );
    }

    #[test]
    fn test_tui_theme_follow_defaults_to_off() {
        let config = ComposerConfig::default();
        assert_eq!(config.tui.and_then(|tui| tui.theme_follow), None);
    }

    #[test]
    fn test_tui_theme_follow_loads_from_project_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        let config_path = config_dir.join("config.toml");
        fs::write(
            &config_path,
            r"
[tui]
theme_follow = true
",
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        assert_eq!(config.tui.and_then(|tui| tui.theme_follow), Some(true));
    }

    #[test]
    fn test_deep_merge_tui_theme_follow() {
        let mut target = ComposerConfig::default();
        let source = ComposerConfig {
            tui: Some(TuiConfig {
                theme_follow: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };

        deep_merge(&mut target, &source);
        assert_eq!(target.tui.and_then(|tui| tui.theme_follow), Some(true));
    }

    #[test]
    fn test_tui_terminal_notification_flags_parse() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        let config_path = config_dir.join("config.toml");
        fs::write(
            &config_path,
            r#"
[tui]
tab_progress = "always"
title_updates = false
focus_gated_notifications = false
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        let tui = config.tui.expect("tui config");
        assert_eq!(tui.tab_progress, Some(TabProgressMode::Always));
        assert_eq!(tui.title_updates, Some(false));
        assert_eq!(tui.focus_gated_notifications, Some(false));
    }

    #[test]
    fn test_deep_merge_tui_terminal_notification_flags() {
        let mut target = ComposerConfig {
            tui: Some(TuiConfig {
                tab_progress: Some(TabProgressMode::Never),
                title_updates: Some(false),
                focus_gated_notifications: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        };
        // A source that only sets one flag must not clobber the others.
        let source = ComposerConfig {
            tui: Some(TuiConfig {
                tab_progress: Some(TabProgressMode::Always),
                ..Default::default()
            }),
            ..Default::default()
        };

        deep_merge(&mut target, &source);
        let tui = target.tui.expect("tui config");
        assert_eq!(tui.tab_progress, Some(TabProgressMode::Always));
        assert_eq!(tui.title_updates, Some(false));
        assert_eq!(tui.focus_gated_notifications, Some(false));
    }

    #[test]
    fn test_load_project_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        let config_path = config_dir.join("config.toml");
        fs::write(
            &config_path,
            r#"
model = "gpt-4o"
model_provider = "openai"
approval_policy = "on-request"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        assert_eq!(config.model.as_deref(), Some("gpt-4o"));
        assert_eq!(config.model_provider.as_deref(), Some("openai"));
        assert_eq!(config.approval_policy, Some(ApprovalPolicy::OnRequest));
    }

    #[test]
    fn test_profiles() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        let config_path = config_dir.join("config.toml");
        fs::write(
            &config_path,
            r#"
model = "default-model"
profile = "fast"

[profiles.fast]
model = "fast-model"
model_reasoning_effort = "low"

[profiles.powerful]
model = "powerful-model"
model_reasoning_effort = "high"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        assert_eq!(config.model.as_deref(), Some("fast-model"));
        assert_eq!(config.model_reasoning_effort, Some(ReasoningEffort::Low));

        // Test profile override
        clear_config_cache();
        let config = load_config(temp_dir.path(), Some("powerful"));
        assert_eq!(config.model.as_deref(), Some("powerful-model"));
        assert_eq!(config.model_reasoning_effort, Some(ReasoningEffort::High));
    }

    #[test]
    fn test_env_overrides() {
        let mut config = DEFAULT_CONFIG.clone();
        apply_env_overrides_from(&mut config, |key| match key {
            "MAESTRO_MODEL" => Some("env-model".to_string()),
            "MAESTRO_MODEL_PROVIDER" => Some("env-provider".to_string()),
            _ => None,
        });
        assert_eq!(config.model.as_deref(), Some("env-model"));
        assert_eq!(config.model_provider.as_deref(), Some("env-provider"));
    }

    #[test]
    fn resolve_interactive_sandbox_policy_precedence() {
        // `MAESTRO_SANDBOX_MODE`/`MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT` are
        // process-global env vars and `#[test]` functions run concurrently by
        // default, so every scenario lives in one sequential test rather
        // than racing separate tests against the same two env vars.
        env::remove_var("MAESTRO_SANDBOX_MODE");
        env::remove_var("MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT");

        let workspace_write_config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        };

        // Stage 1: even though DEFAULT_CONFIG.sandbox_mode is already
        // `WorkspaceWrite`, the interactive TUI must not enforce it until the
        // internal gate is explicitly set — this is what makes the change an
        // enabling primitive rather than an immediate default flip.
        assert!(
            resolve_interactive_sandbox_policy(&workspace_write_config).is_none(),
            "gate off + no env override must stay unsandboxed"
        );

        // Once the internal gate is set, the config's resolved policy applies.
        env::set_var("MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT", "1");
        let gated_policy = resolve_interactive_sandbox_policy(&workspace_write_config);
        assert!(gated_policy.is_some(), "gate on must resolve a policy");
        assert!(gated_policy.unwrap().has_full_network_access());

        // An explicit env override always wins over the gate + config.
        env::set_var("MAESTRO_SANDBOX_MODE", "read-only");
        assert_eq!(
            resolve_interactive_sandbox_policy(&workspace_write_config),
            Some(crate::sandbox::SandboxPolicy::ReadOnly)
        );

        env::set_var("MAESTRO_SANDBOX_MODE", "danger-full-access");
        assert!(resolve_interactive_sandbox_policy(&workspace_write_config).is_none());

        let restricted_config = ComposerConfig {
            sandbox_mode: Some(SandboxMode::DangerFullAccess),
            sandbox_workspace_write: Some(SandboxWorkspaceWriteConfig {
                writable_roots: Some(vec!["/explicit-root".to_string()]),
                network_access: Some(false),
                exclude_tmpdir_env_var: Some(true),
                exclude_slash_tmp: Some(true),
            }),
            ..Default::default()
        };
        env::set_var("MAESTRO_SANDBOX_MODE", "workspace-write");
        let restricted = resolve_interactive_sandbox_policy(&restricted_config)
            .expect("workspace-write env override should enable the configured policy");
        assert!(!restricted.has_full_network_access());
        assert!(matches!(
            &restricted,
            crate::sandbox::SandboxPolicy::WorkspaceWrite {
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
                ..
            }
        ));
        let crate::sandbox::SandboxPolicy::WorkspaceWrite { writable_roots, .. } = restricted
        else {
            panic!("expected workspace-write policy");
        };
        assert!(writable_roots.contains(&std::path::PathBuf::from("/explicit-root")));

        // A typo must not be silently treated as an opt-out; it falls
        // through to the next precedence tier (gate still on here, so the
        // config's resolved policy applies, same as if the env var were unset).
        env::set_var("MAESTRO_SANDBOX_MODE", "not-a-real-mode");
        assert!(resolve_interactive_sandbox_policy(&workspace_write_config).is_some());

        env::remove_var("MAESTRO_SANDBOX_MODE");
        env::remove_var("MAESTRO_INTERNAL_TUI_SANDBOX_DEFAULT");
    }

    #[test]
    fn test_parse_cli_override() {
        let (key, value) = parse_cli_override("model=gpt-4o").unwrap();
        assert_eq!(key, "model");
        assert_eq!(value.as_str(), Some("gpt-4o"));

        let (key, value) = parse_cli_override("features.web_search=true").unwrap();
        assert_eq!(key, "features.web_search");
        assert_eq!(value.as_bool(), Some(true));

        let (key, value) = parse_cli_override("max_bytes=65536").unwrap();
        assert_eq!(key, "max_bytes");
        assert_eq!(value.as_integer(), Some(65536));

        assert!(parse_cli_override("invalid").is_none());
        assert!(parse_cli_override("=value").is_none());
    }

    #[test]
    fn test_get_available_profiles() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
[profiles.alpha]
model = "a"

[profiles.beta]
model = "b"
"#,
        )
        .unwrap();

        clear_config_cache();
        let profiles = get_available_profiles(temp_dir.path());
        assert!(profiles.contains(&"alpha".to_string()));
        assert!(profiles.contains(&"beta".to_string()));
        assert_eq!(profiles.len(), 2);
    }

    #[test]
    fn test_mcp_server_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
enabled = true
startup_timeout_sec = 30
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        let server = config
            .mcp_servers
            .as_ref()
            .unwrap()
            .get("context7")
            .unwrap();
        assert_eq!(server.command.as_deref(), Some("npx"));
        let expected_args: Vec<String> =
            vec!["-y".to_string(), "@upstash/context7-mcp".to_string()];
        assert_eq!(server.args, Some(expected_args));
        assert_eq!(server.enabled, Some(true));
        assert_eq!(server.startup_timeout_sec, Some(30));
    }

    #[test]
    fn test_shell_environment_policy_ignored_for_untrusted_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
[shell_environment_policy]
inherit = "core"
exclude = ["SECRET_KEY", "API_TOKEN"]

[shell_environment_policy.set]
NODE_ENV = "development"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        // Untrusted workspaces must not apply a repository-controlled shell
        // environment policy at all.
        assert!(config.shell_environment_policy.is_none());
    }

    #[test]
    fn test_sandbox_settings_ignored_for_untrusted_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
sandbox_mode = "danger-full-access"

[sandbox_workspace_write]
writable_roots = ["/etc"]

[profiles.escape]
sandbox_mode = "danger-full-access"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);
        // An untrusted repository must not be able to disable the sandbox or
        // widen its writable roots via checked-in config — including through
        // a project-defined profile. The `sandbox_mode` assertion only holds
        // when no `MAESTRO_SANDBOX_MODE` override was in effect: that env
        // var is process-global and another test mutates it concurrently,
        // and an explicit user override legitimately wins over the strip.
        if std::env::var_os("MAESTRO_SANDBOX_MODE").is_none() {
            assert_ne!(config.sandbox_mode, Some(SandboxMode::DangerFullAccess));
        }
        assert!(config.sandbox_workspace_write.is_none());
        assert_eq!(
            config
                .profiles
                .as_ref()
                .and_then(|profiles| profiles.get("escape"))
                .and_then(|profile| profile.sandbox_mode),
            None
        );
    }

    #[test]
    fn test_untrusted_workspace_cannot_select_a_profile_it_does_not_own() {
        // Regression test for the review finding on #3144: clearing a
        // project-defined profile's OWN `sandbox_mode` (the assertion in
        // `test_sandbox_settings_ignored_for_untrusted_workspace` above)
        // only stops an untrusted repo from smuggling a dangerous profile
        // IN. It does nothing to stop the repo from smuggling a dangerous
        // profile SELECTION: `active_profile` resolves from `config.profile`
        // after the project config merges in, and `apply_profile` looks
        // that name up in the *merged* `profiles` map -- which still
        // includes every profile the user's own trusted global config
        // defines. A repo checking in `profile = "some-global-profile-name"`
        // (naming a profile the project itself never defines) could
        // silently activate a profile the user only ever intended to opt
        // into manually (e.g. `maestro --profile unsandboxed`).
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
profile = "some-global-profile-name"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);

        // The selector must not survive into the resolved config: it names
        // a profile this untrusted project never defines itself, so it can
        // only be trying to reach into the trusted global config.
        assert_eq!(
            config.profile, None,
            "an untrusted project must not be able to select a profile it doesn't define itself"
        );
    }

    #[test]
    fn test_untrusted_workspace_can_still_select_a_profile_it_defines_itself() {
        // The other half of the fix above: a project selecting a profile it
        // *also defines*, for ordinary non-security-sensitive settings like
        // its preferred model, must keep working -- this is exactly
        // `test_profiles`'s scenario, and the profile's own `sandbox_mode`
        // is already neutralized by the stripping loop regardless of who
        // selects it.
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().join(".composer");
        fs::create_dir_all(&config_dir).unwrap();

        fs::write(
            config_dir.join("config.toml"),
            r#"
profile = "fast"

[profiles.fast]
model = "fast-model"
sandbox_mode = "danger-full-access"
"#,
        )
        .unwrap();

        clear_config_cache();
        let config = load_config(temp_dir.path(), None);

        assert_eq!(config.profile.as_deref(), Some("fast"));
        assert_eq!(config.model.as_deref(), Some("fast-model"));
        // The project-owned profile's own sandbox_mode is still stripped,
        // so selecting it (unlike selecting a global profile by name)
        // cannot widen the sandbox even though the selector itself passes
        // through.
        if std::env::var_os("MAESTRO_SANDBOX_MODE").is_none() {
            assert_ne!(config.sandbox_mode, Some(SandboxMode::DangerFullAccess));
        }
    }

    #[test]
    fn test_workspace_trusted_reads_canonical_project_key() {
        let temp_dir = TempDir::new().unwrap();
        let canonical = dunce::canonicalize(temp_dir.path()).unwrap();
        let key = canonical.to_string_lossy().to_string();

        let mut config = ComposerConfig::default();
        assert!(!workspace_trusted(&config, temp_dir.path()));

        config.projects = Some(HashMap::from([(
            key,
            ProjectSettings {
                trust_level: Some(TrustLevel::Trusted),
            },
        )]));
        assert!(workspace_trusted(&config, temp_dir.path()));

        config.projects = Some(HashMap::from([(
            dunce::canonicalize(temp_dir.path())
                .unwrap()
                .to_string_lossy()
                .to_string(),
            ProjectSettings {
                trust_level: Some(TrustLevel::Untrusted),
            },
        )]));
        assert!(!workspace_trusted(&config, temp_dir.path()));
    }

    #[test]
    fn test_sanitize_project_shell_environment_policy() {
        let mut policy = ShellEnvironmentPolicy {
            inherit: Some(ShellInherit::Core),
            ignore_default_excludes: Some(true),
            exclude: Some(vec!["SECRET_KEY".to_string()]),
            set: Some(HashMap::from([
                ("BASH_ENV".to_string(), "/tmp/evil.sh".to_string()),
                ("ENV".to_string(), "/tmp/evil.sh".to_string()),
                ("LD_PRELOAD".to_string(), "/tmp/evil.so".to_string()),
                (
                    "DYLD_INSERT_LIBRARIES".to_string(),
                    "/tmp/evil.dylib".to_string(),
                ),
                ("NODE_ENV".to_string(), "development".to_string()),
            ])),
            include_only: None,
        };

        sanitize_project_shell_environment_policy(&mut policy);

        assert_eq!(policy.ignore_default_excludes, None);
        let set = policy.set.as_ref().unwrap();
        assert!(!set.contains_key("BASH_ENV"));
        assert!(!set.contains_key("ENV"));
        assert!(!set.contains_key("LD_PRELOAD"));
        assert!(!set.contains_key("DYLD_INSERT_LIBRARIES"));
        assert_eq!(set.get("NODE_ENV"), Some(&"development".to_string()));
        // Benign knobs survive sanitization.
        assert_eq!(policy.inherit, Some(ShellInherit::Core));
        assert_eq!(policy.exclude, Some(vec!["SECRET_KEY".to_string()]));
    }
}

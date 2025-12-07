//! TOML-based Configuration System with Profiles
//!
//! Ported from OpenAI Codex (MIT License) config pattern.
//! Supports:
//! - ~/.composer/config.toml (global config)
//! - .composer/config.toml (project config - overrides global)
//! - Named profiles for different configurations
//! - Environment variable overrides
//! - CLI flag overrides
//!
//! Configuration precedence (highest first):
//! 1. CLI flags (--model, --config key=value)
//! 2. Environment variables (COMPOSER_*)
//! 3. Active profile settings
//! 4. Project config.toml
//! 5. Global config.toml
//! 6. Built-in defaults

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

// ─────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────

/// Approval policy for tool execution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    #[default]
    Untrusted,
    OnFailure,
    OnRequest,
    Never,
}

impl ApprovalPolicy {
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

/// TUI configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TuiConfig {
    pub notifications: Option<NotificationsSetting>,
    pub animations: Option<bool>,
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

/// Main Composer configuration
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

// ─────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────

/// Default configuration values
pub static DEFAULT_CONFIG: Lazy<ComposerConfig> = Lazy::new(|| ComposerConfig {
    model: Some("claude-sonnet-4-20250514".to_string()),
    model_provider: Some("anthropic".to_string()),
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
    }),
    file_opener: Some(FileOpener::Vscode),
    project_doc_max_bytes: Some(32 * 1024),
    project_doc_fallback_filenames: Some(vec!["CLAUDE.md".to_string()]),
    ..Default::default()
});

// ─────────────────────────────────────────────────────────────
// Configuration Cache
// ─────────────────────────────────────────────────────────────

struct ConfigCache {
    config: Option<ComposerConfig>,
    workspace_dir: Option<PathBuf>,
    profile_name: Option<String>,
}

static CONFIG_CACHE: Lazy<RwLock<ConfigCache>> = Lazy::new(|| {
    RwLock::new(ConfigCache {
        config: None,
        workspace_dir: None,
        profile_name: None,
    })
});

/// Clear the configuration cache
pub fn clear_config_cache() {
    let mut cache = CONFIG_CACHE.write().unwrap();
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
            eprintln!("Failed to read config file {:?}: {}", path, e);
            return None;
        }
    };

    match toml::from_str(&content) {
        Ok(config) => Some(config),
        Err(e) => {
            eprintln!("Failed to parse config file {:?}: {}", path, e);
            None
        }
    }
}

/// Apply environment variable overrides
fn apply_env_overrides(config: &mut ComposerConfig) {
    // COMPOSER_MODEL
    if let Ok(model) = env::var("COMPOSER_MODEL") {
        config.model = Some(model);
    }

    // COMPOSER_MODEL_PROVIDER
    if let Ok(provider) = env::var("COMPOSER_MODEL_PROVIDER") {
        config.model_provider = Some(provider);
    }

    // COMPOSER_APPROVAL_POLICY
    if let Ok(policy) = env::var("COMPOSER_APPROVAL_POLICY") {
        if let Some(p) = ApprovalPolicy::parse(&policy) {
            config.approval_policy = Some(p);
        }
    }

    // COMPOSER_SANDBOX_MODE
    if let Ok(mode) = env::var("COMPOSER_SANDBOX_MODE") {
        if let Some(m) = SandboxMode::parse(&mode) {
            config.sandbox_mode = Some(m);
        }
    }

    // COMPOSER_PROFILE
    if let Ok(profile) = env::var("COMPOSER_PROFILE") {
        config.profile = Some(profile);
    }
}

/// Apply profile settings to configuration
fn apply_profile(config: &mut ComposerConfig, profile_name: &str) {
    let profile = match &config.profiles {
        Some(profiles) => match profiles.get(profile_name) {
            Some(p) => p.clone(),
            None => {
                eprintln!("Profile not found: {}", profile_name);
                return;
            }
        },
        None => {
            eprintln!("No profiles defined");
            return;
        }
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

/// Load configuration from files and environment
///
/// # Arguments
/// * `workspace_dir` - The current workspace directory
/// * `profile_name` - Optional profile name to activate
pub fn load_config(workspace_dir: &Path, profile_name: Option<&str>) -> ComposerConfig {
    // Check cache
    {
        let cache = CONFIG_CACHE.read().unwrap();
        if cache.config.is_some()
            && cache.workspace_dir.as_deref() == Some(workspace_dir)
            && cache.profile_name.as_deref() == profile_name
        {
            return cache.config.clone().unwrap();
        }
    }

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
    if let Some(project_config) = parse_config_file(&project_path) {
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
        let mut cache = CONFIG_CACHE.write().unwrap();
        cache.config = Some(config.clone());
        cache.workspace_dir = Some(workspace_dir.to_path_buf());
        cache.profile_name = profile_name.map(String::from);
    }

    config
}

/// Load configuration with CLI overrides
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
pub fn get_available_profiles(workspace_dir: &Path) -> Vec<String> {
    let config = load_config(workspace_dir, None);
    match config.profiles {
        Some(profiles) => profiles.keys().cloned().collect(),
        None => Vec::new(),
    }
}

/// Get a summary of the current configuration for display
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
        config.model_provider.as_deref().unwrap_or("anthropic")
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
        lines.push(format!("Active Profile: {}", profile));
    }

    let profiles = get_available_profiles(workspace_dir);
    if !profiles.is_empty() {
        lines.push(format!("Available Profiles: {}", profiles.join(", ")));
    }

    lines.join("\n")
}

/// Parse a CLI config override in the format "key=value"
pub fn parse_cli_override(override_str: &str) -> Option<(String, toml::Value)> {
    let eq_index = override_str.find('=')?;
    if eq_index == 0 {
        return None;
    }

    let key = override_str[..eq_index].trim().to_string();
    let value_str = override_str[eq_index + 1..].trim();

    // Try to parse as TOML value
    let toml_str = format!("value = {}", value_str);
    match toml::from_str::<toml::Table>(&toml_str) {
        Ok(table) => {
            let value = table.get("value")?.clone();
            Some((key, value))
        }
        Err(_) => {
            // Treat as string, removing surrounding quotes if present
            let mut v = value_str.to_string();
            if (v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\''))
            {
                v = v[1..v.len() - 1].to_string();
            }
            Some((key, toml::Value::String(v)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::TempDir;

    #[test]
    fn test_default_config() {
        let config = DEFAULT_CONFIG.clone();
        assert_eq!(config.model.as_deref(), Some("claude-sonnet-4-20250514"));
        assert_eq!(config.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(config.approval_policy, Some(ApprovalPolicy::Untrusted));
        assert_eq!(config.sandbox_mode, Some(SandboxMode::WorkspaceWrite));
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
        let temp_dir = TempDir::new().unwrap();

        clear_config_cache();
        env::set_var("COMPOSER_MODEL", "env-model");
        env::set_var("COMPOSER_MODEL_PROVIDER", "env-provider");

        let config = load_config(temp_dir.path(), None);
        assert_eq!(config.model.as_deref(), Some("env-model"));
        assert_eq!(config.model_provider.as_deref(), Some("env-provider"));

        env::remove_var("COMPOSER_MODEL");
        env::remove_var("COMPOSER_MODEL_PROVIDER");
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
    fn test_shell_environment_policy() {
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
        let policy = config.shell_environment_policy.as_ref().unwrap();
        assert_eq!(policy.inherit, Some(ShellInherit::Core));
        let expected_exclude: Vec<String> = vec!["SECRET_KEY".to_string(), "API_TOKEN".to_string()];
        assert_eq!(policy.exclude, Some(expected_exclude));
        assert_eq!(
            policy.set.as_ref().unwrap().get("NODE_ENV"),
            Some(&"development".to_string())
        );
    }
}

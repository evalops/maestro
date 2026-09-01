//! MCP Configuration Loading and Management
//!
//! This module handles loading MCP server configurations from multiple sources
//! with proper precedence handling.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::path_utils::{dedupe_paths, env_path, legacy_composer_home_dir, maestro_home_dir};

/// Transport type for MCP server communication
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    /// Communicate via stdin/stdout with a subprocess
    #[default]
    Stdio,
    /// HTTP-based transport
    Http,
    /// Server-Sent Events transport
    Sse,
}

/// Configuration source for an MCP server definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpConfigScope {
    /// User-wide config in ~/.composer/mcp.json
    #[default]
    User,
    /// Configuration supplied by the managed connection authority.
    Managed,
    /// Project-local override in .composer/mcp.local.json
    Local,
    /// Project-shared config in .composer/mcp.json
    Project,
    /// Enterprise override in ~/.composer/enterprise/mcp.json
    Enterprise,
}

/// Configuration for a single MCP server
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Unique server name (must be alphanumeric with _ or -)
    pub name: String,

    /// Transport type (defaults to stdio)
    #[serde(default)]
    pub transport: McpTransport,

    /// Command to spawn (for stdio transport)
    #[serde(default)]
    pub command: Option<String>,

    /// Arguments for the command
    #[serde(default)]
    pub args: Vec<String>,

    /// Environment variables for the subprocess
    #[serde(default)]
    pub env: HashMap<String, String>,

    /// Working directory for the subprocess
    #[serde(default)]
    pub cwd: Option<String>,

    /// URL for HTTP/SSE transport
    #[serde(default)]
    pub url: Option<String>,

    /// HTTP headers for HTTP/SSE transport
    #[serde(default)]
    pub headers: HashMap<String, String>,

    #[serde(default, rename = "headersHelper")]
    pub headers_helper: Option<String>,

    #[serde(default, rename = "authPreset")]
    pub auth_preset: Option<String>,

    /// Opaque Maestro connection metadata used by an external credential
    /// broker. This is never a secret or an authentication header.
    #[serde(default, rename = "connectionRef")]
    pub connection_ref: Option<String>,

    /// Opaque credential reference owned by the external connection broker.
    #[serde(default, rename = "credentialRef")]
    pub credential_ref: Option<String>,

    /// Runtime-only generation captured from the managed connection record.
    ///
    /// This is deliberately not serialized: persisted MCP configuration may
    /// carry only opaque connection metadata, never a runtime authority
    /// snapshot.
    #[serde(skip, default)]
    pub managed_generation: Option<u64>,

    #[serde(default, rename = "supportsParallelToolCalls")]
    pub supports_parallel_tool_calls: Option<bool>,

    #[serde(default, rename = "requiresProjectApproval")]
    pub requires_project_approval: Option<bool>,

    /// Connection timeout in milliseconds
    #[serde(default)]
    pub timeout: Option<u64>,

    /// Whether this server is enabled (default: true)
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Whether this server is disabled (alternative to enabled: false)
    #[serde(default)]
    pub disabled: bool,

    /// Config source for UI provenance.
    #[serde(skip, default)]
    pub scope: McpConfigScope,
}

fn default_true() -> bool {
    true
}

impl McpServerConfig {
    /// Check if this server configuration is valid
    pub fn validate(&self) -> Result<(), String> {
        // Name validation
        if self.name.is_empty() {
            return Err("Server name is required".to_string());
        }
        if !self
            .name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            return Err("Server name must be alphanumeric with _ or -".to_string());
        }

        // Transport-specific validation
        match self.transport {
            McpTransport::Stdio => {
                if self.command.is_none() {
                    return Err("Stdio transport requires command".to_string());
                }
            }
            McpTransport::Http | McpTransport::Sse => {
                if self.url.is_none() {
                    return Err("HTTP/SSE transport requires url".to_string());
                }
            }
        }

        match (&self.connection_ref, &self.credential_ref) {
            (Some(connection_ref), Some(credential_ref)) => {
                if connection_ref.trim().is_empty()
                    || !connection_ref.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                    })
                {
                    return Err("MCP connectionRef contains unsupported characters".to_string());
                }
                crate::service_connections::validate_opaque_reference(
                    "MCP credentialRef",
                    credential_ref,
                )
                .map_err(|error| error.to_string())?;
            }
            (Some(_), None) | (None, Some(_)) => {
                return Err(
                    "MCP connectionRef and credentialRef must be provided together".to_string(),
                );
            }
            (None, None) => {}
        }

        Ok(())
    }

    /// Check if this server is effectively enabled
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.enabled && !self.disabled
    }
}

/// Raw config file format (supports both array and mcpServers formats)
#[derive(Debug, Deserialize, Default)]
struct RawConfig {
    /// Array-style server list
    #[serde(default)]
    servers: Vec<McpServerConfig>,

    /// Claude Desktop-style server map
    #[serde(default, rename = "mcpServers")]
    mcp_servers: HashMap<String, RawServerEntry>,
}

/// Raw server entry for Claude Desktop format
#[derive(Debug, Deserialize)]
struct RawServerEntry {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default, rename = "headersHelper")]
    headers_helper: Option<String>,
    #[serde(default, rename = "authPreset")]
    auth_preset: Option<String>,
    #[serde(default, rename = "connectionRef")]
    connection_ref: Option<String>,
    #[serde(default, rename = "credentialRef")]
    credential_ref: Option<String>,
    #[serde(default, rename = "supportsParallelToolCalls")]
    supports_parallel_tool_calls: Option<bool>,
    #[serde(default, rename = "requiresProjectApproval")]
    requires_project_approval: Option<bool>,
}

/// Merged MCP configuration from all sources
#[derive(Debug, Clone, Default)]
pub struct McpConfig {
    /// All configured servers (deduplicated by name)
    pub servers: Vec<McpServerConfig>,
}

impl McpConfig {
    /// Create an empty configuration
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Get a server by name
    #[must_use]
    pub fn get_server(&self, name: &str) -> Option<&McpServerConfig> {
        self.servers.iter().find(|s| s.name == name)
    }

    /// Get all enabled servers
    pub fn enabled_servers(&self) -> impl Iterator<Item = &McpServerConfig> {
        self.servers.iter().filter(|s| s.is_enabled())
    }
}

/// Load MCP configuration from standard locations
///
/// # Arguments
///
/// * `project_root` - Optional project root directory
///
/// # Returns
///
/// Merged configuration from all sources with proper precedence
#[must_use]
pub fn load_mcp_config(project_root: Option<&Path>) -> McpConfig {
    let plugin_paths = project_root
        .map(crate::plugins::PluginRegistry::discover_for_workspace)
        .unwrap_or_else(crate::plugins::PluginRegistry::discover)
        .mcp_paths();
    load_mcp_config_with_plugin_paths(project_root, &plugin_paths)
}

/// Load configured MCP servers and append bindings supplied by the external
/// connection authority. Managed bindings win by server name so a project or
/// user file cannot redirect a centrally managed connection to another endpoint.
#[must_use]
pub fn load_mcp_config_with_managed_connections(project_root: Option<&Path>) -> McpConfig {
    let mut config = load_mcp_config(project_root);
    append_managed_mcp_connections(&mut config);
    config
}

/// Append bindings supplied by the external connection authority after all
/// file-backed configuration has been merged. Managed bindings own their
/// server names and cannot be redirected by a project or user file.
pub fn append_managed_mcp_connections(config: &mut McpConfig) {
    append_managed_servers(
        config,
        crate::orb_connection::managed_mcp_servers(),
        crate::orb_connection::managed_mcp_server_reservations(),
    );
}

fn append_managed_servers<I, R>(config: &mut McpConfig, managed_servers: I, reserved_names: R)
where
    I: IntoIterator<Item = McpServerConfig>,
    R: IntoIterator<Item = String>,
{
    let reserved_names = reserved_names.into_iter().collect::<HashSet<_>>();
    config
        .servers
        .retain(|server| !reserved_names.contains(&server.name));
    for managed in managed_servers {
        config.servers.retain(|server| server.name != managed.name);
        config.servers.push(managed);
    }
}

fn load_mcp_config_with_plugin_paths(
    project_root: Option<&Path>,
    plugin_paths: &[PathBuf],
) -> McpConfig {
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();

    // Load in precedence order (lowest first, highest last)
    // User config (lowest precedence)
    if let Some(user_path) = effective_user_config_path() {
        load_config_file(&user_path, McpConfigScope::User, None, &mut merged);
    }

    // Plugin discovery already enforces workspace trust, install trust, the
    // enabled bit, and the MCP capability bit. Treat contributed servers as
    // project-scoped so stdio transports retain the runtime approval gate.
    for plugin_path in plugin_paths {
        load_config_file(
            plugin_path,
            McpConfigScope::Project,
            plugin_path.parent(),
            &mut merged,
        );
    }

    // Project configs
    if let Some(root) = project_root {
        // Legacy Composer paths are loaded first; native Maestro paths win.
        for directory in [".composer", ".maestro"] {
            let project_path = root.join(directory).join("mcp.json");
            load_config_file(&project_path, McpConfigScope::Project, None, &mut merged);
            let local_path = root.join(directory).join("mcp.local.json");
            load_config_file(&local_path, McpConfigScope::Local, None, &mut merged);
        }
    }

    // Enterprise config (highest precedence)
    if let Some(enterprise_path) = effective_enterprise_config_path() {
        load_config_file(
            &enterprise_path,
            McpConfigScope::Enterprise,
            None,
            &mut merged,
        );
    }

    McpConfig {
        servers: merged.into_values().collect(),
    }
}

pub(crate) fn effective_user_config_path() -> Option<PathBuf> {
    select_effective_config_path(user_config_paths())
}

fn effective_enterprise_config_path() -> Option<PathBuf> {
    select_effective_config_path(enterprise_config_paths())
}

fn select_effective_config_path(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| paths.into_iter().next())
}

fn user_config_paths() -> Vec<PathBuf> {
    if let Some(path) = env_path("MAESTRO_USER_MCP_PATH") {
        return vec![path];
    }
    let mut paths = Vec::new();
    if let Some(maestro_home) = maestro_home_dir() {
        paths.push(maestro_home.join("mcp.json"));
    }
    if let Some(composer_home) = legacy_composer_home_dir() {
        paths.push(composer_home.join("mcp.json"));
    }
    dedupe_paths(paths)
}

fn enterprise_config_paths() -> Vec<PathBuf> {
    if let Some(path) = env_path("MAESTRO_ENTERPRISE_MCP_PATH") {
        return vec![path];
    }
    let mut paths = Vec::new();
    if let Some(maestro_home) = maestro_home_dir() {
        paths.push(maestro_home.join("enterprise").join("mcp.json"));
    }
    if let Some(composer_home) = legacy_composer_home_dir() {
        paths.push(composer_home.join("enterprise").join("mcp.json"));
    }
    dedupe_paths(paths)
}

/// Load a single config file and merge into the map
fn load_config_file(
    path: &Path,
    scope: McpConfigScope,
    plugin_base: Option<&Path>,
    merged: &mut HashMap<String, McpServerConfig>,
) {
    if !path.exists() {
        return;
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mcp] Failed to read config {}: {}", path.display(), e);
            return;
        }
    };

    let raw: RawConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mcp] Failed to parse config {}: {}", path.display(), e);
            return;
        }
    };

    // Process array-style servers
    for mut server in raw.servers {
        server.scope = scope;
        anchor_plugin_stdio_paths(&mut server, plugin_base);
        if server.disabled || !server.enabled {
            merged.remove(&server.name);
        } else if server.validate().is_ok() {
            merged.insert(server.name.clone(), server);
        }
    }

    // Process Claude Desktop-style servers (mcpServers map)
    for (name, entry) in raw.mcp_servers {
        let transport = if entry.url.is_some() {
            McpTransport::Http
        } else {
            McpTransport::Stdio
        };

        let mut server = McpServerConfig {
            name: name.clone(),
            transport,
            command: entry.command,
            args: entry.args,
            env: entry.env,
            cwd: entry.cwd,
            url: entry.url,
            headers: entry.headers,
            headers_helper: entry.headers_helper,
            auth_preset: entry.auth_preset,
            connection_ref: entry.connection_ref,
            credential_ref: entry.credential_ref,
            managed_generation: None,
            supports_parallel_tool_calls: entry.supports_parallel_tool_calls,
            requires_project_approval: entry.requires_project_approval,
            timeout: None,
            enabled: true,
            disabled: false,
            scope,
        };
        anchor_plugin_stdio_paths(&mut server, plugin_base);

        if server.validate().is_ok() {
            merged.insert(name, server);
        }
    }
}

fn anchor_plugin_stdio_paths(server: &mut McpServerConfig, plugin_base: Option<&Path>) {
    let Some(base) = plugin_base else {
        return;
    };
    if server.transport != McpTransport::Stdio {
        return;
    }
    if let Some(command) = server.command.as_mut() {
        let command_path = Path::new(command);
        if command_path.is_relative() && command_path.components().count() > 1 {
            let command_path = command_path.strip_prefix(".").unwrap_or(command_path);
            *command = base.join(command_path).to_string_lossy().into_owned();
        }
    }
    server.cwd = Some(match server.cwd.as_deref() {
        Some(cwd) if Path::new(cwd).is_absolute() => cwd.to_string(),
        Some(cwd) => base.join(cwd).to_string_lossy().into_owned(),
        None => base.to_string_lossy().into_owned(),
    });
}

/// Expand environment variables in a string
///
/// Supports `${VAR}` and `${VAR:-default}` syntax
pub fn expand_env_vars(s: &str) -> String {
    expand_env_vars_internal(s, true)
}

/// Returns true if an env var name looks like it holds a secret
/// (e.g. API keys, tokens, passwords, credentials).
fn is_secret_env_var_name(name: &str) -> bool {
    let name = name.to_uppercase();
    ["KEY", "SECRET", "TOKEN", "PASS", "CREDENTIAL"]
        .iter()
        .any(|pattern| name.contains(pattern))
}

/// Expand environment variables for a server from the given config scope.
///
/// Project- and local-scoped servers come from the repository and may be
/// hostile, so secret-pattern variables (matching *KEY*/*SECRET*/*TOKEN*/
/// *PASS*/*CREDENTIAL*) are left unexpanded instead of handing maestro's own
/// provider credentials to a repo-controlled process or remote endpoint.
pub fn expand_env_vars_for_scope(s: &str, scope: McpConfigScope) -> String {
    if matches!(scope, McpConfigScope::Project | McpConfigScope::Local) {
        expand_env_vars_internal(s, false)
    } else {
        expand_env_vars(s)
    }
}

/// Returns true if connecting this server requires per-workspace trust
/// approval. Project/local-scoped servers are repository-controlled, so they
/// always require a trust decision regardless of transport or the value in
/// the repository file. A repository must not be able to grant itself trust
/// with `requiresProjectApproval: false`. User, enterprise, and managed
/// servers remain trusted by default and can opt into an additional workspace
/// approval with `requiresProjectApproval: true`.
pub fn server_requires_workspace_approval(server: &McpServerConfig) -> bool {
    match server.scope {
        McpConfigScope::Project | McpConfigScope::Local => true,
        McpConfigScope::User | McpConfigScope::Managed | McpConfigScope::Enterprise => {
            server.requires_project_approval.unwrap_or(false)
        }
    }
}

fn expand_env_vars_internal(s: &str, allow_secrets: bool) -> String {
    let mut result = s.to_string();
    let mut start = 0;

    while let Some(var_start) = result[start..].find("${") {
        let var_start = start + var_start;
        if let Some(var_end) = result[var_start..].find('}') {
            let var_end = var_start + var_end;
            let var_content = &result[var_start + 2..var_end];

            // Handle ${VAR:-default} syntax
            let (var_name, default) = if let Some(pos) = var_content.find(":-") {
                (&var_content[..pos], Some(&var_content[pos + 2..]))
            } else {
                (var_content, None)
            };

            if !allow_secrets && is_secret_env_var_name(var_name) {
                // Leave the reference unexpanded rather than leaking a
                // credential to a repo-controlled server.
                start = var_end + 1;
                continue;
            }

            let value = std::env::var(var_name)
                .ok()
                .or_else(|| default.map(String::from))
                .unwrap_or_default();

            result.replace_range(var_start..=var_end, &value);
            start = var_start + value.len();
        } else {
            start = var_start + 2;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{LazyLock, Mutex};

    static ENV_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn native_project_config_is_loaded() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".maestro");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("mcp.json"),
            r#"{"mcpServers":{"native-project":{"command":"cargo","args":[]}}}"#,
        )
        .unwrap();
        let config = load_mcp_config(Some(temp.path()));
        let server = config.get_server("native-project").unwrap();
        assert_eq!(server.scope, McpConfigScope::Project);
        assert_eq!(server.command.as_deref(), Some("cargo"));
    }

    #[test]
    fn local_mcp_config_overrides_shared_project_config() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".maestro");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("mcp.json"),
            r#"{"mcpServers":{"server":{"command":"shared"}}}"#,
        )
        .unwrap();
        std::fs::write(
            directory.join("mcp.local.json"),
            r#"{"mcpServers":{"server":{"command":"local"}}}"#,
        )
        .unwrap();

        let config = load_mcp_config(Some(temp.path()));
        let server = config.get_server("server").unwrap();
        assert_eq!(server.scope, McpConfigScope::Local);
        assert_eq!(server.command.as_deref(), Some("local"));
    }

    #[test]
    fn plugin_mcp_config_is_loaded_with_project_safety_scope() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_config = temp.path().join("plugin-mcp.json");
        std::fs::write(
            &plugin_config,
            r#"{"mcpServers":{"plugin-server":{"command":"./bin/plugin-agent","args":[],"cwd":"runtime"}}}"#,
        )
        .unwrap();

        let config = load_mcp_config_with_plugin_paths(None, &[plugin_config]);
        let server = config.get_server("plugin-server").unwrap();
        assert_eq!(server.scope, McpConfigScope::Project);
        assert_eq!(
            server.command.as_deref(),
            Some(temp.path().join("bin/plugin-agent").to_str().unwrap())
        );
        assert_eq!(
            server.cwd.as_deref(),
            Some(temp.path().join("runtime").to_str().unwrap())
        );
        assert!(server_requires_workspace_approval(server));
    }

    fn restore_env_var(name: &str, previous: Option<String>) {
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn test_server_config_validation_stdio() {
        let server = McpServerConfig {
            name: "test".to_string(),
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_ok());
    }

    #[test]
    fn test_server_config_validation_stdio_no_command() {
        let server = McpServerConfig {
            name: "test".to_string(),
            transport: McpTransport::Stdio,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_err());
    }

    #[test]
    fn test_server_config_validation_http() {
        let server = McpServerConfig {
            name: "test".to_string(),
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: Some("http://localhost:8080".to_string()),
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_ok());
    }

    #[test]
    fn test_server_config_validation_http_no_url() {
        let server = McpServerConfig {
            name: "test".to_string(),
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_err());
    }

    #[test]
    fn managed_server_precedence_cannot_be_shadowed_by_file_configuration() {
        let mut config = McpConfig {
            servers: vec![McpServerConfig {
                name: "orb".to_string(),
                transport: McpTransport::Http,
                command: None,
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                url: Some("https://attacker.example.test/mcp".to_string()),
                headers: HashMap::new(),
                headers_helper: None,
                auth_preset: None,
                connection_ref: None,
                credential_ref: None,
                managed_generation: None,
                supports_parallel_tool_calls: None,
                requires_project_approval: None,
                timeout: None,
                enabled: true,
                disabled: false,
                scope: McpConfigScope::Project,
            }],
        };
        let managed = McpServerConfig {
            name: "orb".to_string(),
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: Some("https://orb.evalops.dev/mcp".to_string()),
            headers: HashMap::new(),
            headers_helper: Some("externally managed by https://orb.evalops.dev".to_string()),
            auth_preset: None,
            connection_ref: Some("orb-team".to_string()),
            credential_ref: Some(
                "ref:orb/credential/00000000-0000-4000-8000-000000000001".to_string(),
            ),
            managed_generation: Some(1),
            supports_parallel_tool_calls: None,
            requires_project_approval: Some(false),
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::Managed,
        };

        append_managed_servers(&mut config, [managed], ["orb".to_string()]);

        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].scope, McpConfigScope::Managed);
        assert_eq!(
            config.servers[0].url.as_deref(),
            Some("https://orb.evalops.dev/mcp")
        );
    }

    #[test]
    fn revoked_managed_server_reservation_blocks_project_fallback() {
        let mut config = McpConfig {
            servers: vec![McpServerConfig {
                name: "orb".to_string(),
                transport: McpTransport::Http,
                command: None,
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                url: Some("https://attacker.example.test/mcp".to_string()),
                headers: HashMap::new(),
                headers_helper: None,
                auth_preset: None,
                connection_ref: None,
                credential_ref: None,
                managed_generation: None,
                supports_parallel_tool_calls: None,
                requires_project_approval: None,
                timeout: None,
                enabled: true,
                disabled: false,
                scope: McpConfigScope::Project,
            }],
        };

        append_managed_servers(
            &mut config,
            Vec::<McpServerConfig>::new(),
            ["orb".to_string()],
        );

        assert!(config.servers.is_empty());
    }

    #[test]
    fn test_server_config_validation_invalid_name() {
        let server = McpServerConfig {
            name: "test server".to_string(), // Space not allowed
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_err());
    }

    #[test]
    fn test_is_enabled() {
        let mut server = McpServerConfig {
            name: "test".to_string(),
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.is_enabled());

        server.enabled = false;
        assert!(!server.is_enabled());

        server.enabled = true;
        server.disabled = true;
        assert!(!server.is_enabled());
    }

    #[test]
    fn test_load_config_file_tracks_scope() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{ "mcpServers": { "scope-test": { "command": "npx", "args": ["-y", "@example/server"] } } }"#,
        )
        .expect("write mcp config");

        let mut merged = HashMap::new();
        load_config_file(&path, McpConfigScope::Project, None, &mut merged);

        let server = merged.get("scope-test").expect("server");
        assert_eq!(server.scope, McpConfigScope::Project);
        assert_eq!(server.transport, McpTransport::Stdio);
    }

    #[test]
    fn test_user_config_paths_do_not_fall_back_when_env_override_is_set() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous_override = std::env::var("MAESTRO_USER_MCP_PATH").ok();
        let previous_home = std::env::var("MAESTRO_HOME").ok();

        std::env::set_var("MAESTRO_USER_MCP_PATH", "/tmp/override-user-mcp.json");
        std::env::set_var("MAESTRO_HOME", "/tmp/maestro-home");

        assert_eq!(
            user_config_paths(),
            vec![PathBuf::from("/tmp/override-user-mcp.json")]
        );

        restore_env_var("MAESTRO_USER_MCP_PATH", previous_override);
        restore_env_var("MAESTRO_HOME", previous_home);
    }

    #[test]
    fn effective_path_prefers_an_existing_legacy_candidate() {
        let temp = tempfile::tempdir().expect("tempdir");
        let preferred = temp.path().join("new").join("mcp.json");
        let legacy = temp.path().join("legacy").join("mcp.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).expect("legacy parent");
        std::fs::write(&legacy, "{}").expect("legacy config");

        assert_eq!(
            select_effective_config_path(vec![preferred, legacy.clone()]),
            Some(legacy)
        );
    }

    #[test]
    fn test_enterprise_config_paths_do_not_fall_back_when_env_override_is_set() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous_override = std::env::var("MAESTRO_ENTERPRISE_MCP_PATH").ok();
        let previous_home = std::env::var("MAESTRO_HOME").ok();

        std::env::set_var(
            "MAESTRO_ENTERPRISE_MCP_PATH",
            "/tmp/override-enterprise-mcp.json",
        );
        std::env::set_var("MAESTRO_HOME", "/tmp/maestro-home");

        assert_eq!(
            enterprise_config_paths(),
            vec![PathBuf::from("/tmp/override-enterprise-mcp.json")]
        );

        restore_env_var("MAESTRO_ENTERPRISE_MCP_PATH", previous_override);
        restore_env_var("MAESTRO_HOME", previous_home);
    }

    #[test]
    fn test_user_config_paths_use_custom_maestro_home_without_default_maestro_fallback() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous_override = std::env::var("MAESTRO_USER_MCP_PATH").ok();
        let previous_home = std::env::var("MAESTRO_HOME").ok();
        let home = dirs::home_dir().expect("home dir");

        std::env::remove_var("MAESTRO_USER_MCP_PATH");
        std::env::set_var("MAESTRO_HOME", "/tmp/custom-maestro-home");

        let paths = user_config_paths();

        assert_eq!(
            paths,
            dedupe_paths(vec![
                PathBuf::from("/tmp/custom-maestro-home/mcp.json"),
                home.join(".composer").join("mcp.json"),
            ])
        );
        assert!(!paths.contains(&home.join(".maestro").join("mcp.json")));

        restore_env_var("MAESTRO_USER_MCP_PATH", previous_override);
        restore_env_var("MAESTRO_HOME", previous_home);
    }

    #[test]
    fn test_enterprise_config_paths_use_custom_maestro_home_without_default_maestro_fallback() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous_override = std::env::var("MAESTRO_ENTERPRISE_MCP_PATH").ok();
        let previous_home = std::env::var("MAESTRO_HOME").ok();
        let home = dirs::home_dir().expect("home dir");

        std::env::remove_var("MAESTRO_ENTERPRISE_MCP_PATH");
        std::env::set_var("MAESTRO_HOME", "/tmp/custom-maestro-home");

        let paths = enterprise_config_paths();

        assert_eq!(
            paths,
            dedupe_paths(vec![
                PathBuf::from("/tmp/custom-maestro-home/enterprise/mcp.json"),
                home.join(".composer").join("enterprise").join("mcp.json"),
            ])
        );
        assert!(!paths.contains(&home.join(".maestro").join("enterprise").join("mcp.json")));

        restore_env_var("MAESTRO_ENTERPRISE_MCP_PATH", previous_override);
        restore_env_var("MAESTRO_HOME", previous_home);
    }

    #[test]
    fn test_expand_env_vars_simple() {
        std::env::set_var("TEST_VAR", "hello");
        assert_eq!(expand_env_vars("${TEST_VAR}"), "hello");
        std::env::remove_var("TEST_VAR");
    }

    #[test]
    fn test_expand_env_vars_with_default() {
        std::env::remove_var("NONEXISTENT_VAR");
        assert_eq!(expand_env_vars("${NONEXISTENT_VAR:-default}"), "default");
    }

    #[test]
    fn test_expand_env_vars_multiple() {
        std::env::set_var("VAR1", "one");
        std::env::set_var("VAR2", "two");
        assert_eq!(expand_env_vars("${VAR1}-${VAR2}"), "one-two");
        std::env::remove_var("VAR1");
        std::env::remove_var("VAR2");
    }

    #[test]
    fn test_expand_env_vars_no_vars() {
        assert_eq!(expand_env_vars("no variables here"), "no variables here");
    }

    #[test]
    fn test_expand_env_vars_for_scope_blocks_secrets_for_project_scope() {
        std::env::set_var("MCP_TEST_PROVIDER_API_KEY", "sk-secret");
        std::env::set_var("MCP_TEST_REGION", "us-east-1");

        // Project scope: secret-pattern vars stay unexpanded, benign vars expand.
        let expanded = expand_env_vars_for_scope(
            "key=${MCP_TEST_PROVIDER_API_KEY} region=${MCP_TEST_REGION}",
            McpConfigScope::Project,
        );
        assert_eq!(
            expanded,
            "key=${MCP_TEST_PROVIDER_API_KEY} region=us-east-1"
        );

        let expanded =
            expand_env_vars_for_scope("${MCP_TEST_PROVIDER_API_KEY}", McpConfigScope::Local);
        assert_eq!(expanded, "${MCP_TEST_PROVIDER_API_KEY}");

        // User/enterprise scope: expansion is unchanged.
        let expanded =
            expand_env_vars_for_scope("${MCP_TEST_PROVIDER_API_KEY}", McpConfigScope::User);
        assert_eq!(expanded, "sk-secret");
        let expanded =
            expand_env_vars_for_scope("${MCP_TEST_PROVIDER_API_KEY}", McpConfigScope::Enterprise);
        assert_eq!(expanded, "sk-secret");

        std::env::remove_var("MCP_TEST_PROVIDER_API_KEY");
        std::env::remove_var("MCP_TEST_REGION");
    }

    #[test]
    fn test_expand_env_vars_for_scope_secret_patterns() {
        for (name, secret) in [
            ("MCP_TEST_TOKEN", true),
            ("MCP_TEST_PASSWORD", true),
            ("MCP_TEST_CREDENTIALS", true),
            ("MCP_TEST_CLIENT_SECRET", true),
            ("MCP_TEST_API_KEY", true),
            ("MCP_TEST_PLAIN", false),
        ] {
            std::env::set_var(name, "value");
            let reference = format!("${{{name}}}");
            let expanded = expand_env_vars_for_scope(&reference, McpConfigScope::Project);
            if secret {
                assert_eq!(expanded, reference, "{name} must stay unexpanded");
            } else {
                assert_eq!(expanded, "value", "{name} should expand");
            }
            std::env::remove_var(name);
        }
    }

    fn server(
        scope: McpConfigScope,
        transport: McpTransport,
        approval: Option<bool>,
    ) -> McpServerConfig {
        McpServerConfig {
            name: "test".to_string(),
            transport,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            headers_helper: None,
            auth_preset: None,
            connection_ref: None,
            credential_ref: None,
            managed_generation: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: approval,
            timeout: None,
            enabled: true,
            disabled: false,
            scope,
        }
    }

    #[test]
    fn test_server_requires_workspace_approval() {
        // User/enterprise servers remain trusted by default.
        assert!(!server_requires_workspace_approval(&server(
            McpConfigScope::User,
            McpTransport::Stdio,
            None,
        )));
        assert!(!server_requires_workspace_approval(&server(
            McpConfigScope::Enterprise,
            McpTransport::Stdio,
            None,
        )));

        // Project/local stdio servers require approval by default.
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Project,
            McpTransport::Stdio,
            None,
        )));
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Local,
            McpTransport::Stdio,
            None,
        )));

        // Project/local HTTP and SSE servers require approval by default too.
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Project,
            McpTransport::Http,
            Some(false),
        )));

        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Local,
            McpTransport::Sse,
            None,
        )));

        // A repository cannot weaken the trust boundary with an explicit
        // false value; true is accepted but is redundant for project/local.
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Project,
            McpTransport::Http,
            Some(true),
        )));
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::Project,
            McpTransport::Stdio,
            Some(false),
        )));

        // Non-repository sources preserve their existing default and opt-in
        // behavior.
        assert!(!server_requires_workspace_approval(&server(
            McpConfigScope::Managed,
            McpTransport::Http,
            Some(false),
        )));
        assert!(server_requires_workspace_approval(&server(
            McpConfigScope::User,
            McpTransport::Http,
            Some(true),
        )));
    }
}

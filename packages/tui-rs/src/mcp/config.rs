//! MCP Configuration Loading and Management
//!
//! This module handles loading MCP server configurations from multiple sources
//! with proper precedence handling.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

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
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();

    // Load in precedence order (lowest first, highest last)
    // User config (lowest precedence)
    if let Some(home) = dirs::home_dir() {
        let user_path = home.join(".composer").join("mcp.json");
        load_config_file(&user_path, McpConfigScope::User, &mut merged);
    }

    // Project configs
    if let Some(root) = project_root {
        // Local config (git-ignored)
        let local_path = root.join(".composer").join("mcp.local.json");
        load_config_file(&local_path, McpConfigScope::Local, &mut merged);

        // Project config
        let project_path = root.join(".composer").join("mcp.json");
        load_config_file(&project_path, McpConfigScope::Project, &mut merged);
    }

    // Enterprise config (highest precedence)
    if let Some(home) = dirs::home_dir() {
        let enterprise_path = home.join(".composer").join("enterprise").join("mcp.json");
        load_config_file(&enterprise_path, McpConfigScope::Enterprise, &mut merged);
    }

    McpConfig {
        servers: merged.into_values().collect(),
    }
}

/// Load a single config file and merge into the map
fn load_config_file(
    path: &Path,
    scope: McpConfigScope,
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

        let server = McpServerConfig {
            name: name.clone(),
            transport,
            command: entry.command,
            args: entry.args,
            env: entry.env,
            cwd: entry.cwd,
            url: entry.url,
            headers: HashMap::new(),
            timeout: None,
            enabled: true,
            disabled: false,
            scope,
        };

        if server.validate().is_ok() {
            merged.insert(name, server);
        }
    }
}

/// Expand environment variables in a string
///
/// Supports `${VAR}` and `${VAR:-default}` syntax
pub fn expand_env_vars(s: &str) -> String {
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
            timeout: None,
            enabled: true,
            disabled: false,
            scope: McpConfigScope::User,
        };
        assert!(server.validate().is_err());
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
        load_config_file(&path, McpConfigScope::Project, &mut merged);

        let server = merged.get("scope-test").expect("server");
        assert_eq!(server.scope, McpConfigScope::Project);
        assert_eq!(server.transport, McpTransport::Stdio);
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
}

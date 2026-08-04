//! Plugin manifest (`plugin.json`) schema.
//!
//! Manifests are optional. When missing, discovery falls back to convention
//! paths under the plugin root (`skills/`, `agents/`, `commands/`, hooks, MCP configs).

use serde::{Deserialize, Serialize};

/// Optional `plugin.json` metadata for a Maestro plugin package.
///
/// All fields are optional so partial manifests remain valid. Relative path
/// fields (`skills`, `agents`, `commands`, `hooks`, `mcp`) are resolved against the
/// plugin root; when omitted, convention paths are used instead.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginManifest {
    /// Human-readable plugin name. Defaults to the plugin directory name.
    pub name: Option<String>,
    /// Semantic version string (informational).
    pub version: Option<String>,
    /// Short description shown by `/plugins`.
    pub description: Option<String>,
    /// Relative path to a skills directory (default: `skills`).
    pub skills: Option<String>,
    /// Relative path to custom agent/profile definitions (default: `agents`).
    pub agents: Option<String>,
    /// Relative path to a commands directory (default: `commands`).
    pub commands: Option<String>,
    /// Relative path to a hooks config file (default: `hooks/hooks.toml` etc.).
    pub hooks: Option<String>,
    /// Relative path to an MCP config file (default: `mcp.json` / `.mcp.json`).
    pub mcp: Option<String>,
}

impl PluginManifest {
    /// Parse a manifest from JSON text.
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_manifest() {
        let json = r#"{
            "name": "team-tools",
            "version": "0.1.0",
            "description": "Shared team skills",
            "skills": "skills",
            "agents": "agents",
            "commands": "commands",
            "hooks": "hooks/hooks.toml",
            "mcp": "mcp.json"
        }"#;
        let manifest = PluginManifest::from_json(json).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("team-tools"));
        assert_eq!(manifest.version.as_deref(), Some("0.1.0"));
        assert_eq!(manifest.skills.as_deref(), Some("skills"));
        assert_eq!(manifest.agents.as_deref(), Some("agents"));
        assert_eq!(manifest.hooks.as_deref(), Some("hooks/hooks.toml"));
    }

    #[test]
    fn empty_object_uses_defaults() {
        let manifest = PluginManifest::from_json("{}").unwrap();
        assert!(manifest.name.is_none());
        assert!(manifest.skills.is_none());
        assert!(manifest.mcp.is_none());
    }

    #[test]
    fn partial_manifest_is_valid() {
        let manifest = PluginManifest::from_json(r#"{"name":"only-name"}"#).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("only-name"));
        assert!(manifest.version.is_none());
    }
}

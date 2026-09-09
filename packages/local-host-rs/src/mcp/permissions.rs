//! Local remembered approvals for MCP tools.
//!
//! Grants are bound to the model-facing tool name, its admitted schema, and
//! the non-secret transport configuration. A changed endpoint, command,
//! argument list, credential reference, or schema therefore requires a fresh
//! approval. Managed and enterprise servers are intentionally excluded:
//! their approval authority remains the hosted/administrator policy layer.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{LazyLock, RwLock};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{McpConfigScope, McpServerConfig};

static SESSION_GRANTS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpPermissionGrant {
    pub server: String,
    pub tool: String,
    pub fingerprint: String,
    pub granted_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PermissionFile {
    #[serde(default)]
    grants: Vec<McpPermissionGrant>,
}

#[derive(Debug, Clone)]
pub(crate) struct McpPermissionIdentity {
    pub server: String,
    pub tool: String,
    pub fingerprint: String,
}

impl McpPermissionIdentity {
    fn key(&self) -> String {
        format!("{}:{}:{}", self.server, self.tool, self.fingerprint)
    }
}

pub(crate) fn identity_for(
    server: &McpServerConfig,
    model_tool_name: &str,
    schema: &serde_json::Value,
) -> Option<McpPermissionIdentity> {
    if matches!(
        server.scope,
        McpConfigScope::Managed | McpConfigScope::Enterprise
    ) {
        return None;
    }
    let transport = serde_json::json!({
        "name": server.name,
        "scope": server.scope,
        "transport": server.transport,
        "command": server.command,
        "args": server.args,
        "cwd": server.cwd,
        "url": server.url,
        "headers": server.headers,
        "headersHelper": server.headers_helper,
        "authPreset": server.auth_preset,
        "connectionRef": server.connection_ref,
        "credentialRef": server.credential_ref,
        "schema": canonical_json(schema),
    });
    let bytes = serde_json::to_vec(&transport).ok()?;
    let fingerprint = hex_digest(&Sha256::digest(bytes));
    let tool = model_tool_name
        .strip_prefix(&format!("mcp__{}__", server.name))
        .unwrap_or(model_tool_name)
        .to_string();
    Some(McpPermissionIdentity {
        server: server.name.clone(),
        tool,
        fingerprint,
    })
}

pub(crate) fn is_allowed(identity: &McpPermissionIdentity) -> bool {
    if SESSION_GRANTS
        .read()
        .map(|grants| grants.contains(&identity.key()))
        .unwrap_or(false)
    {
        return true;
    }
    load_file()
        .map(|file| {
            file.grants.iter().any(|grant| {
                grant.server == identity.server
                    && grant.tool == identity.tool
                    && grant.fingerprint == identity.fingerprint
            })
        })
        .unwrap_or(false)
}

pub(crate) fn grant_session(identity: &McpPermissionIdentity) {
    if let Ok(mut grants) = SESSION_GRANTS.write() {
        grants.insert(identity.key());
    }
}

pub(crate) fn grant_persistent(identity: &McpPermissionIdentity) -> Result<()> {
    let mut file = load_file()?;
    file.grants
        .retain(|grant| grant.server != identity.server || grant.tool != identity.tool);
    file.grants.push(McpPermissionGrant {
        server: identity.server.clone(),
        tool: identity.tool.clone(),
        fingerprint: identity.fingerprint.clone(),
        granted_at: chrono::Utc::now().to_rfc3339(),
    });
    save_file(&file)
}

pub fn list_permissions() -> Result<Vec<McpPermissionGrant>> {
    let mut grants = load_file()?.grants;
    grants.sort_by(|left, right| (&left.server, &left.tool).cmp(&(&right.server, &right.tool)));
    Ok(grants)
}

pub fn revoke_permission(server: &str, tool: &str) -> Result<bool> {
    let mut file = load_file()?;
    let before = file.grants.len();
    file.grants
        .retain(|grant| grant.server != server || grant.tool != tool);
    let changed = file.grants.len() != before;
    if changed {
        save_file(&file)?;
    }
    if let Ok(mut session) = SESSION_GRANTS.write() {
        session.retain(|key| !key.starts_with(&format!("{server}:{tool}:")));
    }
    Ok(changed)
}

pub fn revoke_server_permissions(server: &str) -> Result<usize> {
    let mut file = load_file()?;
    let before = file.grants.len();
    file.grants.retain(|grant| grant.server != server);
    let removed = before.saturating_sub(file.grants.len());
    if removed > 0 {
        save_file(&file)?;
    }
    if let Ok(mut session) = SESSION_GRANTS.write() {
        session.retain(|key| !key.starts_with(&format!("{server}:")));
    }
    Ok(removed)
}

pub fn clear_permissions() -> Result<usize> {
    let mut file = load_file()?;
    let count = file.grants.len();
    file.grants.clear();
    save_file(&file)?;
    if let Ok(mut session) = SESSION_GRANTS.write() {
        session.clear();
    }
    Ok(count)
}

fn permission_path() -> Result<PathBuf> {
    if let Some(path) = crate::path_utils::env_path("MAESTRO_MCP_PERMISSIONS_PATH") {
        return Ok(path);
    }
    crate::path_utils::maestro_home_dir()
        .map(|home| home.join("mcp-permissions.json"))
        .context("could not resolve Maestro home directory")
}

fn load_file() -> Result<PermissionFile> {
    let path = permission_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid MCP permissions file {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PermissionFile::default()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn save_file(file: &PermissionFile) -> Result<()> {
    let path = permission_path()?;
    if file.grants.iter().any(|grant| {
        grant.server.is_empty() || grant.tool.is_empty() || grant.fingerprint.len() != 64
    }) {
        bail!("refusing to save malformed MCP permission");
    }
    crate::path_utils::atomic_private_write(&path, &serde_json::to_vec_pretty(file)?)
}

fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json).collect())
        }
        other => other.clone(),
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_changes_with_transport_or_schema_and_excludes_managed() {
        let mut server: McpServerConfig = serde_json::from_value(serde_json::json!({
            "name": "demo",
            "transport": "http",
            "url": "https://example.test/mcp"
        }))
        .unwrap();
        let first = identity_for(
            &server,
            "mcp__demo__run",
            &serde_json::json!({"type":"object"}),
        )
        .unwrap();
        assert_eq!(first.tool, "run");
        server.url = Some("https://other.example.test/mcp".to_string());
        let moved = identity_for(
            &server,
            "mcp__demo__run",
            &serde_json::json!({"type":"object"}),
        )
        .unwrap();
        assert_ne!(first.fingerprint, moved.fingerprint);
        server.scope = McpConfigScope::Managed;
        assert!(identity_for(&server, "mcp__demo__run", &serde_json::json!({})).is_none());
    }

    #[test]
    fn persistent_grants_can_be_listed_and_revoked() {
        let _guard = crate::config::test_process_env_lock();
        let previous = std::env::var_os("MAESTRO_MCP_PERMISSIONS_PATH");
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var(
            "MAESTRO_MCP_PERMISSIONS_PATH",
            temp.path().join("permissions.json"),
        );
        let identity = McpPermissionIdentity {
            server: "demo".to_string(),
            tool: "mcp__demo__run".to_string(),
            fingerprint: "a".repeat(64),
        };
        grant_persistent(&identity).unwrap();
        assert!(is_allowed(&identity));
        assert_eq!(list_permissions().unwrap().len(), 1);
        assert!(revoke_permission("demo", "mcp__demo__run").unwrap());
        assert!(list_permissions().unwrap().is_empty());
        match previous {
            Some(value) => std::env::set_var("MAESTRO_MCP_PERMISSIONS_PATH", value),
            None => std::env::remove_var("MAESTRO_MCP_PERMISSIONS_PATH"),
        }
    }
}

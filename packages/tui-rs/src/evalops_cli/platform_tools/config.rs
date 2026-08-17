use std::io;
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};

use super::{mcp_server_timeout_ms, SERVER_DISPLAY_NAME, SERVER_NAME};

const CONFIG_FORWARDED_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_URL",
    "MAESTRO_TOOL_EXECUTION_SERVICE_URL",
    "MAESTRO_PLATFORM_BASE_URL",
    "MAESTRO_EVALOPS_BASE_URL",
    "EVALOPS_BASE_URL",
    "TOOL_EXECUTION_SERVICE_TOKEN",
    "MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
    "MAESTRO_PLATFORM_ACCESS_TOKEN",
    "MAESTRO_EVALOPS_ACCESS_TOKEN",
    "EVALOPS_TOKEN",
    "TOOL_EXECUTION_SERVICE_ORGANIZATION_ID",
    "MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID",
    "MAESTRO_PLATFORM_ORGANIZATION_ID",
    "MAESTRO_EVALOPS_ORG_ID",
    "EVALOPS_ORGANIZATION_ID",
    "EVALOPS_ORG_ID",
    "MAESTRO_ENTERPRISE_ORG_ID",
    "TOOL_EXECUTION_SERVICE_WORKSPACE_ID",
    "MAESTRO_TOOL_EXECUTION_WORKSPACE_ID",
    "MAESTRO_PLATFORM_WORKSPACE_ID",
    "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
    "MAESTRO_EVALOPS_WORKSPACE_ID",
    "EVALOPS_WORKSPACE_ID",
    "MAESTRO_WORKSPACE_ID",
    "MAESTRO_HOME",
    "MAESTRO_PLATFORM_AGENT_RUN_ID",
    "MAESTRO_AGENT_RUN_ID",
    "EVALOPS_AGENT_RUN_ID",
    "MAESTRO_PLATFORM_AGENT_ID",
    "MAESTRO_AGENT_ID",
    "MAESTRO_PLATFORM_ACTOR_ID",
    "MAESTRO_EVALOPS_USER_ID",
    "EVALOPS_USER_ID",
    "MAESTRO_USER_ID",
    "MAESTRO_PLATFORM_CHANNEL_ID",
    "MAESTRO_CHANNEL_ID",
    "MAESTRO_THREAD_ID",
    "MAESTRO_PLATFORM_SANDBOX_SESSION_ID",
    "MAESTRO_RUNNER_SESSION_ID",
    "MAESTRO_SESSION_ID",
    "TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
    "MAESTRO_TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
    "TOOL_EXECUTION_APPROVAL_WAIT_MS",
    "MAESTRO_TOOL_EXECUTION_APPROVAL_WAIT_MS",
    "MAESTRO_TOOL_EXECUTION_APPROVAL_POLL_MS",
    "TRACEPARENT",
    "TRACESTATE",
];

pub(super) fn configure_user_server() -> Result<std::path::PathBuf> {
    let path = crate::mcp::effective_user_config_path()
        .context("could not resolve the user MCP configuration path")?;
    let executable = std::env::current_exe().context("resolve the Maestro executable")?;
    configure_path(&path, &executable)?;
    Ok(path)
}

pub(super) fn remove_user_server() -> Result<std::path::PathBuf> {
    let path = crate::mcp::effective_user_config_path()
        .context("could not resolve the user MCP configuration path")?;
    remove_configured_server(&path)?;
    Ok(path)
}

fn configure_path(path: &Path, executable: &Path) -> Result<()> {
    let mut root = read_config_root(path)?;
    remove_server_from_root(&mut root)?;
    let servers = root
        .as_object_mut()
        .context("MCP configuration root must be an object")?
        .entry("servers")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .context("MCP configuration `servers` must be an array")?;

    let env = CONFIG_FORWARDED_ENV_VARS
        .iter()
        .map(|name| ((*name).to_string(), Value::String(format!("${{{name}}}"))))
        .collect::<Map<String, Value>>();
    servers.push(json!({
        "name": SERVER_NAME,
        "transport": "stdio",
        "command": executable.to_string_lossy(),
        "args": ["evalops", "platform-tools", "serve"],
        "env": env,
        "timeout": mcp_server_timeout_ms(),
        "supportsParallelToolCalls": false,
        "requiresProjectApproval": false,
        "enabled": true
    }));
    write_config_root(path, &root)
}

fn remove_configured_server(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_config_root(path)?;
    remove_server_from_root(&mut root)?;
    write_config_root(path, &root)
}

fn read_config_root(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("invalid JSON in {}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.into()),
    }
}

fn write_config_root(path: &Path, root: &Value) -> Result<()> {
    crate::path_utils::atomic_private_write(path, &serde_json::to_vec_pretty(root)?)
}

fn remove_server_from_root(root: &mut Value) -> Result<()> {
    let object = root
        .as_object_mut()
        .context("MCP configuration root must be an object")?;
    if let Some(servers) = object.get_mut("servers") {
        let servers = servers
            .as_array_mut()
            .context("MCP configuration `servers` must be an array")?;
        servers.retain(|server| server.get("name").and_then(Value::as_str) != Some(SERVER_NAME));
    }
    if let Some(servers) = object.get_mut("mcpServers") {
        let servers = servers
            .as_object_mut()
            .context("MCP configuration `mcpServers` must be an object")?;
        servers.remove(SERVER_NAME);
    }
    Ok(())
}

pub(super) fn configured_message(path: &Path) -> String {
    format!(
        "Configured {SERVER_DISPLAY_NAME} in {}. Restart Maestro to load `mcp__{SERVER_NAME}__computer_shell`.",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn configuration_installs_a_user_scoped_long_running_mcp_server() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"evalops-platform":{"command":"old"},"other":{"command":"other"}},"servers":[{"name":"existing","transport":"stdio","command":"existing"}]}"#,
        )
        .unwrap();
        configure_path(&path, Path::new("/usr/local/bin/maestro")).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(value["mcpServers"].get(SERVER_NAME).is_none());
        assert_eq!(value["mcpServers"]["other"]["command"], "other");
        let servers = value["servers"].as_array().unwrap();
        assert!(servers.iter().any(|server| server["name"] == "existing"));
        let platform = servers
            .iter()
            .find(|server| server["name"] == SERVER_NAME)
            .unwrap();
        assert_eq!(platform["command"], "/usr/local/bin/maestro");
        assert_eq!(
            platform["args"],
            json!(["evalops", "platform-tools", "serve"])
        );
        assert_eq!(platform["timeout"], mcp_server_timeout_ms());
        assert_eq!(
            platform["env"]["TOOL_EXECUTION_SERVICE_TOKEN"],
            "${TOOL_EXECUTION_SERVICE_TOKEN}"
        );
        assert!(!value.to_string().contains("test-token"));
        assert_eq!(platform["env"]["MAESTRO_HOME"], "${MAESTRO_HOME}");
    }

    #[test]
    fn unconfigure_removes_both_supported_config_shapes() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"evalops-platform":{"command":"old"},"other":{"command":"other"}},"servers":[{"name":"evalops-platform","transport":"stdio","command":"new"},{"name":"existing","transport":"stdio","command":"existing"}]}"#,
        )
        .unwrap();
        remove_configured_server(&path).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(value["mcpServers"].get(SERVER_NAME).is_none());
        assert!(value["servers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|server| server["name"] != SERVER_NAME));
    }

    #[test]
    fn unconfigure_does_not_create_a_missing_config_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("mcp.json");
        remove_configured_server(&path).unwrap();
        assert!(!path.exists());
    }
}

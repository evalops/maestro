//! Safe, atomic MCP configuration mutations for `maestro mcp`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};

pub fn run_mcp_config(args: &[String]) -> Result<i32> {
    println!("{}", apply_mcp_config(args)?);
    Ok(0)
}

/// Apply a configuration command and return a UI-safe status message.
pub fn apply_mcp_config(args: &[String]) -> Result<String> {
    let command = args.first().map(String::as_str).unwrap_or("list");
    let cwd = std::env::current_dir()?;
    match command {
        "list" => {
            let config = crate::mcp::load_mcp_config(Some(&cwd));
            Ok(serde_json::to_string_pretty(&redact_server_configs(
                serde_json::to_value(&config.servers)?,
            ))?)
        }
        "add-stdio" => {
            let name = required(args, 1, "server name")?;
            let executable = required(args, 2, "server command")?;
            let (path, scope) = target_path(args, &cwd)?;
            let (command_args, env) = stdio_options(&args[3..])?;
            if scope != "user" && !env.is_empty() {
                bail!(
                    "environment bindings are user-scope only; project configs cannot read secrets"
                );
            }
            reject_literal_secrets(&command_args)?;
            mutate_server(
                &path,
                name,
                Some(json!({"command": executable, "args": command_args, "env":env})),
            )?;
            Ok(format!(
                "Configured stdio MCP server {name} in {}",
                path.display()
            ))
        }
        "add-http" => {
            let name = required(args, 1, "server name")?;
            let url = required(args, 2, "server URL")?;
            validate_http_url(url)?;
            let mut server = json!({"transport":"http", "url":url});
            if args.iter().any(|value| value == "--bearer-token-env")
                && option_value(args, "--bearer-token-env").is_none()
            {
                bail!("--bearer-token-env requires a variable");
            }
            if let Some(variable) = option_value(args, "--bearer-token-env") {
                validate_env_name(variable)?;
                server["headers"] = json!({"Authorization": format!("Bearer ${{{variable}}}")});
            }
            let (path, scope) = target_path(args, &cwd)?;
            if scope != "user" && server.get("headers").is_some() {
                bail!("bearer-token bindings are user-scope only; project configs cannot read secrets");
            }
            mutate_server(&path, name, Some(server))?;
            Ok(format!(
                "Configured HTTP MCP server {name} in {}",
                path.display()
            ))
        }
        "remove" => {
            let name = required(args, 1, "server name")?;
            let (path, _) = target_path(args, &cwd)?;
            mutate_server(&path, name, None)?;
            Ok(format!("Removed MCP server {name} from {}", path.display()))
        }
        "help" | "--help" | "-h" => Ok(help_text().to_string()),
        other => bail!("unknown mcp command: {other}"),
    }
}

fn redact_server_configs(mut value: Value) -> Value {
    if let Value::Object(servers) = &mut value {
        for server in servers.values_mut() {
            redact_config_value(server, Some("server"));
        }
    }
    value
}

fn redact_config_value(value: &mut Value, parent_key: Option<&str>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if matches!(parent_key, Some("env" | "headers")) || is_secret_key(key) {
                    *child = Value::String("[REDACTED]".to_string());
                } else {
                    redact_config_value(child, Some(key));
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                redact_config_value(child, parent_key);
            }
        }
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "authorization",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "password",
        "secret",
        "privatekey",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn help_text() -> &'static str {
    "Usage:\n\
         \x20 maestro mcp list\n\
         \x20 maestro mcp add-stdio <name> <command> [args...] [--env VAR] [--scope user|project|local]\n\
         \x20 maestro mcp add-http <name> <url> [--bearer-token-env VAR] [--scope ...]\n\
         \x20 maestro mcp remove <name> [--scope ...]\n\n\
         Secrets must use environment references in user scope; project configs cannot read them."
}

fn required<'a>(args: &'a [String], index: usize, label: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with("--"))
        .with_context(|| format!("missing {label}"))
}

fn option_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].as_str())
        .or_else(|| {
            args.iter()
                .find_map(|arg| arg.strip_prefix(&format!("{key}=")))
        })
}

fn target_path(args: &[String], cwd: &Path) -> Result<(PathBuf, &'static str)> {
    if args.iter().any(|value| value == "--scope") && option_value(args, "--scope").is_none() {
        bail!("--scope requires a value");
    }
    match option_value(args, "--scope").unwrap_or("user") {
        "user" => {
            let path = crate::mcp::effective_user_config_path()
                .context("could not resolve user MCP configuration path")?;
            Ok((path, "user"))
        }
        "project" => Ok((cwd.join(".maestro").join("mcp.json"), "project")),
        "local" => Ok((cwd.join(".maestro").join("mcp.local.json"), "local")),
        other => bail!("unknown MCP config scope: {other}"),
    }
}

fn validate_env_name(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
    {
        bail!("environment variable names must use A-Z, 0-9, and _");
    }
    Ok(())
}

fn validate_http_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).context("invalid HTTP MCP URL")?;
    let localhost = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && localhost) {
        bail!("HTTP MCP URLs must use HTTPS (loopback HTTP is allowed)");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("credentials may not be embedded in MCP URLs");
    }
    if url.query_pairs().any(|(key, _)| {
        matches!(
            key.to_ascii_lowercase().replace(['-', '_'], "").as_str(),
            "token"
                | "apikey"
                | "secret"
                | "password"
                | "accesstoken"
                | "refreshtoken"
                | "bearertoken"
        )
    }) {
        bail!("credential query parameters are not allowed; use --bearer-token-env");
    }
    Ok(())
}

fn stdio_options(args: &[String]) -> Result<(Vec<String>, Map<String, Value>)> {
    let mut command_args = Vec::new();
    let mut env = Map::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--scope" => {
                if args
                    .get(index + 1)
                    .is_none_or(|value| value.starts_with('-'))
                {
                    bail!("--scope requires a value");
                }
                index += 2;
            }
            value if value.starts_with("--scope=") => index += 1,
            "--env" => {
                let variable = args.get(index + 1).context("--env requires a variable")?;
                validate_env_name(variable)?;
                env.insert(variable.clone(), Value::String(format!("${{{variable}}}")));
                index += 2;
            }
            value if value.starts_with("--env=") => {
                let variable = value.trim_start_matches("--env=");
                validate_env_name(variable)?;
                env.insert(
                    variable.to_string(),
                    Value::String(format!("${{{variable}}}")),
                );
                index += 1;
            }
            _ => {
                command_args.push(args[index].clone());
                index += 1;
            }
        }
    }
    Ok((command_args, env))
}

fn reject_literal_secrets(args: &[String]) -> Result<()> {
    let mut secret_value_follows = false;
    for argument in args {
        if secret_value_follows && !argument.contains("${") {
            bail!("literal secrets are not allowed; use --env VAR");
        }
        let lower = argument.to_ascii_lowercase();
        secret_value_follows = matches!(
            lower.as_str(),
            "--api-key" | "--apikey" | "--token" | "--secret" | "--password"
        );
        if ["api_key=", "apikey=", "token=", "secret=", "password="]
            .iter()
            .any(|needle| lower.contains(needle))
            && !argument.contains("${")
        {
            bail!("literal secrets are not allowed; use --env VAR");
        }
    }
    Ok(())
}

fn mutate_server(path: &Path, name: &str, value: Option<Value>) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        bail!("server names must be alphanumeric with - or _");
    }
    let mut root = match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .with_context(|| format!("invalid JSON in {}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    let object = root
        .as_object_mut()
        .context("MCP configuration root must be an object")?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .context("mcpServers must be an object")?;
    match value {
        Some(value) => {
            servers.insert(name.to_string(), value);
        }
        None => {
            servers.remove(name);
        }
    }
    crate::path_utils::atomic_private_write(path, &serde_json::to_vec_pretty(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn mutations_preserve_other_servers_and_use_env_references() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("mcp.json");
        mutate_server(&path, "one", Some(json!({"command":"one"}))).unwrap();
        mutate_server(
            &path,
            "two",
            Some(
                json!({"url":"https://example.com","headers":{"Authorization":"Bearer ${TOKEN}"}}),
            ),
        )
        .unwrap();
        mutate_server(&path, "one", None).unwrap();
        let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(value["mcpServers"].get("one").is_none());
        assert_eq!(
            value["mcpServers"]["two"]["headers"]["Authorization"],
            "Bearer ${TOKEN}"
        );
    }

    #[test]
    fn stdio_flags_are_preserved_and_secret_literals_rejected() {
        let args = vec![
            "-y".to_string(),
            "@example/server".to_string(),
            "--env".to_string(),
            "SERVICE_TOKEN".to_string(),
            "--scope".to_string(),
            "project".to_string(),
        ];
        let (command_args, env) = stdio_options(&args).unwrap();
        assert_eq!(command_args, ["-y", "@example/server"]);
        assert_eq!(env["SERVICE_TOKEN"], "${SERVICE_TOKEN}");
        assert!(reject_literal_secrets(&["--token".into(), "secret".into()]).is_err());
        assert!(validate_http_url("http://localhost.evil.test/mcp").is_err());
        assert!(validate_http_url("https://example.test/mcp?token=secret").is_err());
        assert!(validate_http_url("https://example.test/mcp?access_token=secret").is_err());
        assert!(validate_http_url("https://example.test/mcp?refresh-token=secret").is_err());
        assert!(validate_http_url("http://127.0.0.1:3000/mcp").is_ok());
    }

    #[test]
    fn list_output_redacts_loaded_credentials() {
        let listed = redact_server_configs(json!({
            "stdio": {
                "env": {"SERVICE_TOKEN": "literal-secret", "SAFE": "${SAFE}"},
                "args": ["--verbose"]
            },
            "http": {
                "headers": {
                    "Authorization": "Bearer literal-secret",
                    "X-Custom-Credential": "also-secret"
                },
                "api_key": "literal-secret",
                "url": "https://example.test/mcp"
            },
            "private-key-service": {
                "command": "safe-command"
            }
        }));

        assert_eq!(listed["stdio"]["env"]["SERVICE_TOKEN"], "[REDACTED]");
        assert_eq!(listed["stdio"]["env"]["SAFE"], "[REDACTED]");
        assert_eq!(listed["http"]["headers"]["Authorization"], "[REDACTED]");
        assert_eq!(
            listed["http"]["headers"]["X-Custom-Credential"],
            "[REDACTED]"
        );
        assert_eq!(listed["http"]["api_key"], "[REDACTED]");
        assert_eq!(listed["http"]["url"], "https://example.test/mcp");
        assert_eq!(listed["private-key-service"]["command"], "safe-command");
    }
}

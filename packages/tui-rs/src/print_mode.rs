//! Non-interactive print mode (Grok-style `--print` / single-shot / `exec`).
//!
//! Runs the native agent without a TUI, auto-approves tools, prints the
//! assistant response, and exits. Supports `--output-last-message` and a
//! lightweight JSON Schema check via `--output-schema`.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::agent::{CredentialVault, FromAgent, NativeAgent, NativeAgentConfig};
use crate::safety::FirewallVerdict;
use crate::sandbox::SandboxPolicy;
use crate::tools::ToolExecutor;

/// Options for print / exec-style runs.
#[derive(Debug, Clone)]
pub struct PrintModeOptions {
    pub prompt: String,
    /// Emit simple JSONL events instead of plain text.
    pub json: bool,
    /// Model override (or from `MAESTRO_MODEL` / default).
    pub model: Option<String>,
    /// Write final assistant text to this path (exec parity).
    pub output_last_message: Option<PathBuf>,
    /// JSON Schema path or inline JSON object (required keys + type checks).
    pub output_schema: Option<String>,
    /// Native sandbox policy for tool subprocesses.
    pub sandbox_policy: Option<SandboxPolicy>,
    /// Reject tool calls that would require interactive approval.
    pub fail_on_approval: bool,
}

fn approval_denied(
    executor: &ToolExecutor,
    tool: &str,
    args: &serde_json::Value,
    fail_on_approval: bool,
) -> bool {
    fail_on_approval
        && (executor.requires_approval(tool, args)
            || matches!(
                executor.firewall_verdict(tool, args),
                FirewallVerdict::RequireApproval { .. }
            ))
}

#[derive(Debug, Clone)]
struct PrintModeLimits {
    max_tokens: u32,
    max_tool_calls: usize,
    max_turns: usize,
    workspace_only_file_tools: bool,
    allowed_tools: Option<HashSet<String>>,
}

impl PrintModeLimits {
    fn from_env() -> Result<Self> {
        Ok(Self {
            max_tokens: positive_env("MAESTRO_PRINT_MAX_TOKENS", 16384)?,
            max_tool_calls: positive_env("MAESTRO_PRINT_MAX_TOOL_CALLS", usize::MAX)?,
            max_turns: positive_env("MAESTRO_PRINT_MAX_TURNS", usize::MAX)?,
            workspace_only_file_tools: bool_env("MAESTRO_PRINT_WORKSPACE_ONLY_FILE_TOOLS")?,
            allowed_tools: allowed_tools_from_env()?,
        })
    }
}

fn positive_env<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr + PartialOrd + From<u8> + Copy,
    T::Err: std::fmt::Display,
{
    let Ok(raw) = std::env::var(name) else {
        return Ok(default);
    };
    let value = raw
        .parse::<T>()
        .map_err(|error| anyhow::anyhow!("{name} must be a positive integer: {error}"))?;
    if value < T::from(1) {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn bool_env(name: &str) -> Result<bool> {
    match std::env::var(name) {
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(err) => Err(err.into()),
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" | "" => Ok(false),
            _ => bail!("{name} must be a boolean"),
        },
    }
}

fn allowed_tools_from_env() -> Result<Option<HashSet<String>>> {
    let Ok(raw) = std::env::var("MAESTRO_PRINT_ALLOWED_TOOLS") else {
        return Ok(None);
    };
    let tools = raw
        .split(',')
        .map(|tool| tool.trim().to_ascii_lowercase())
        .filter(|tool| !tool.is_empty())
        .collect::<HashSet<_>>();
    if tools.is_empty() {
        bail!("MAESTRO_PRINT_ALLOWED_TOOLS must list at least one tool");
    }
    Ok(Some(tools))
}

fn canonical_workspace_path(workspace: &Path, input: &str) -> Result<PathBuf> {
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        workspace.join(input)
    };
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("canonicalize tool path {}", candidate.display()))?;
    if !canonical.starts_with(workspace) {
        bail!(
            "Tool path `{}` resolves outside workspace `{}`",
            input,
            workspace.display()
        );
    }
    Ok(canonical)
}

fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path.to_path_buf();
    while !ancestor.exists() {
        if !ancestor.pop() {
            bail!("Tool path has no existing ancestor: {}", path.display());
        }
    }
    ancestor
        .canonicalize()
        .with_context(|| format!("canonicalize tool path ancestor {}", ancestor.display()))
}

fn prepare_workspace_tool_args(
    tool: &str,
    args: &serde_json::Value,
    workspace: &Path,
) -> Result<serde_json::Value> {
    let mut prepared = args.clone();
    match tool.to_ascii_lowercase().as_str() {
        "read" => {
            let input = args
                .get("path")
                .or_else(|| args.get("file_path"))
                .and_then(serde_json::Value::as_str)
                .context("read tool requires a path")?;
            let canonical = canonical_workspace_path(workspace, input)?;
            prepared["path"] = serde_json::Value::String(canonical.display().to_string());
            if let Some(object) = prepared.as_object_mut() {
                object.remove("file_path");
            }
        }
        "glob" => {
            let pattern = args
                .get("pattern")
                .and_then(serde_json::Value::as_str)
                .context("glob tool requires a pattern")?;
            let pattern_path = Path::new(pattern);
            if pattern_path.is_absolute()
                || pattern_path.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                bail!("Glob pattern must stay relative to its workspace base path");
            }
            let base_input = args
                .get("path")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(".");
            let base = canonical_workspace_path(workspace, base_input)?;
            let components = pattern_path.components().collect::<Vec<_>>();
            let first_magic = components.iter().position(|component| {
                component
                    .as_os_str()
                    .to_string_lossy()
                    .chars()
                    .any(|character| matches!(character, '*' | '?' | '[' | '{'))
            });
            if first_magic.is_some_and(|index| index + 1 < components.len()) {
                bail!("Workspace-only glob patterns cannot wildcard directories");
            }
            let fixed_prefix = components
                .iter()
                .take(first_magic.unwrap_or(components.len()))
                .copied()
                .collect::<PathBuf>();
            let prefix = canonical_existing_ancestor(&base.join(fixed_prefix))?;
            if !prefix.starts_with(workspace) {
                bail!("Glob pattern resolves through a symlink outside the workspace");
            }
            prepared["path"] = serde_json::Value::String(base.display().to_string());
        }
        _ => {}
    }
    Ok(prepared)
}

/// Run one prompt non-interactively and print the final answer.
pub async fn run_print_mode(options: PrintModeOptions) -> Result<i32> {
    let limits = PrintModeLimits::from_env()?;
    let model = options
        .model
        .or_else(|| std::env::var("MAESTRO_MODEL").ok())
        .unwrap_or_else(|| "gpt-5.1-codex-max".to_string());

    let workspace = std::env::current_dir()
        .context("resolve print-mode working directory")?
        .canonicalize()
        .context("canonicalize print-mode working directory")?;
    let cwd = workspace.to_string_lossy().to_string();

    let system_prompt = format!(
        "You are Maestro, an AI coding assistant. Working directory: {cwd}. Be concise and use tools when helpful."
    );

    let config = NativeAgentConfig {
        model: model.clone(),
        max_tokens: limits.max_tokens,
        system_prompt: Some(system_prompt),
        thinking_enabled: false,
        thinking_budget: 0,
        cwd: cwd.clone(),
    };

    let credential_vault = CredentialVault::new();
    let (agent, mut event_rx) = match &limits.allowed_tools {
        Some(allowed_tools) => NativeAgent::new_with_allowed_tools_and_credential_vault(
            config,
            allowed_tools,
            credential_vault.clone(),
        ),
        None => NativeAgent::new_with_credential_vault(config, credential_vault.clone()),
    }
    .context("Failed to create native agent for print mode")?;
    let tool_tx = agent.tool_response_sender();
    let tool_executor = match options.sandbox_policy.clone() {
        Some(policy) => ToolExecutor::with_credential_vault(&cwd, credential_vault.clone())
            .with_sandbox_policy(policy),
        None => ToolExecutor::with_credential_vault(&cwd, credential_vault.clone()),
    };

    agent.send_ready();
    agent
        .prompt(options.prompt, vec![])
        .await
        .context("Failed to send prompt")?;

    let mut exit_code = 0i32;
    let mut assistant_buf = String::new();
    let mut last_assistant_message = String::new();
    let mut tool_calls = 0usize;
    let mut turns = 0usize;

    loop {
        let Some(msg) = event_rx.recv().await else {
            break;
        };

        match msg {
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if is_thinking {
                    continue;
                }
                if options.json {
                    let line = serde_json::json!({
                        "type": "item",
                        "subtype": "message_delta",
                        "text": content,
                    });
                    println!("{line}");
                } else {
                    print!("{content}");
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                }
                assistant_buf.push_str(&content);
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                ..
            } => {
                tool_calls += 1;
                let normalized_tool = tool.to_ascii_lowercase();
                let limit_error = if limits
                    .allowed_tools
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(&normalized_tool))
                {
                    Some(format!("Tool `{tool}` is not allowed in this print run"))
                } else if tool_calls > limits.max_tool_calls {
                    Some(format!(
                        "Print run exceeded MAESTRO_PRINT_MAX_TOOL_CALLS ({})",
                        limits.max_tool_calls
                    ))
                } else if turns >= limits.max_turns {
                    Some(format!(
                        "Tool `{tool}` would exceed MAESTRO_PRINT_MAX_TURNS ({})",
                        limits.max_turns
                    ))
                } else {
                    None
                };

                if options.json {
                    let line = serde_json::json!({
                        "type": "item",
                        "subtype": "tool_call",
                        "call_id": call_id,
                        "tool": tool,
                        "args": args,
                    });
                    println!("{line}");
                } else {
                    eprintln!("[tool] {tool}");
                }

                let mut resolved = credential_vault.resolve_in_json(&args);
                let workspace_error = if limits.workspace_only_file_tools {
                    match prepare_workspace_tool_args(&tool, &resolved, &workspace) {
                        Ok(prepared) => {
                            resolved = prepared;
                            None
                        }
                        Err(error) => Some(error.to_string()),
                    }
                } else {
                    None
                };
                let denied =
                    approval_denied(&tool_executor, &tool, &resolved, options.fail_on_approval);
                let rejection = limit_error.or(workspace_error).or_else(|| {
                    denied.then(|| {
                        format!("Tool `{tool}` requires approval, but approval mode is fail")
                    })
                });
                let result = if let Some(message) = &rejection {
                    crate::agent::ToolResult::failure(message)
                } else if denied {
                    crate::agent::ToolResult::failure(format!(
                        "Tool `{tool}` requires approval, but approval mode is fail"
                    ))
                } else {
                    tool_executor
                        .execute(&tool, &resolved, None, &call_id)
                        .await
                };

                if options.json {
                    let line = serde_json::json!({
                        "type": "item",
                        "subtype": "tool_result",
                        "call_id": call_id,
                        "tool": tool,
                        "success": result.success,
                        "output": result.output,
                    });
                    println!("{line}");
                }

                let approved = rejection.is_none() && !denied;
                let _ = tool_tx.send((call_id, approved, Some(result)));
                if rejection.is_some() {
                    exit_code = 1;
                    agent.cancel();
                    break;
                }
            }
            FromAgent::ResponseEnd { response_id, usage } => {
                if response_id != "done" {
                    turns += 1;
                    if turns > limits.max_turns {
                        if options.json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!(
                                        "Print run exceeded MAESTRO_PRINT_MAX_TURNS ({})",
                                        limits.max_turns
                                    ),
                                    "fatal": true,
                                })
                            );
                        }
                        exit_code = 1;
                        agent.cancel();
                        break;
                    }
                }
                if options.json && !assistant_buf.is_empty() {
                    let line = serde_json::json!({
                        "type": "item",
                        "subtype": "message_complete",
                        "text": assistant_buf,
                        "usage": usage,
                    });
                    println!("{line}");
                } else if !options.json
                    && !assistant_buf.is_empty()
                    && !assistant_buf.ends_with('\n')
                {
                    println!();
                }

                let terminal = record_completed_response(
                    &response_id,
                    &mut assistant_buf,
                    &mut last_assistant_message,
                );
                if terminal {
                    if options.json {
                        let done = serde_json::json!({
                            "type": "done",
                            "status": "ok",
                        });
                        println!("{done}");
                    }
                    break;
                }
            }
            FromAgent::Error { message, fatal } => {
                if options.json {
                    let line = serde_json::json!({
                        "type": "error",
                        "message": message,
                        "fatal": fatal,
                    });
                    println!("{line}");
                } else {
                    eprintln!("Error: {message}");
                }
                if fatal {
                    exit_code = 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if exit_code == 0 {
        if let Some(schema_src) = &options.output_schema {
            if let Err(err) = validate_against_schema(&last_assistant_message, schema_src) {
                if options.json {
                    let line = serde_json::json!({
                        "type": "error",
                        "message": err.to_string(),
                        "fatal": true,
                    });
                    println!("{line}");
                } else {
                    eprintln!("Schema validation failed: {err:#}");
                }
                exit_code = 1;
            }
        }
    }

    if exit_code == 0 {
        if let Some(path) = &options.output_last_message {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("create dir for {}", path.display()))?;
                }
            }
            std::fs::write(path, &last_assistant_message)
                .with_context(|| format!("write output-last-message to {}", path.display()))?;
            if !options.json {
                eprintln!("Wrote last message to {}", path.display());
            }
        }
    }

    Ok(exit_code)
}

/// Record a completed model response and report whether the whole agent turn is done.
/// NativeAgent emits one ResponseEnd per model response, including responses that
/// request tools, followed by a final synthetic `done` event after the tool loop.
fn record_completed_response(
    response_id: &str,
    current: &mut String,
    last_completed: &mut String,
) -> bool {
    if response_id == "done" {
        return true;
    }
    if !current.is_empty() {
        last_completed.clone_from(current);
        current.clear();
    }
    false
}

/// Process multiple prompts sequentially (exec multi-prompt).
pub async fn run_print_prompts(
    prompts: Vec<String>,
    json: bool,
    model: Option<String>,
    output_last_message: Option<PathBuf>,
    output_schema: Option<String>,
) -> Result<i32> {
    let mut code = 0;
    let last = prompts.len().saturating_sub(1);
    for (i, prompt) in prompts.into_iter().enumerate() {
        if i > 0 && !json {
            println!("\n---\n");
        }
        // Only attach file/schema capture on the final prompt (exec parity).
        let result = run_print_mode(PrintModeOptions {
            prompt,
            json,
            model: model.clone(),
            output_last_message: if i == last {
                output_last_message.clone()
            } else {
                None
            },
            output_schema: if i == last {
                output_schema.clone()
            } else {
                None
            },
            sandbox_policy: None,
            fail_on_approval: false,
        })
        .await?;
        if result != 0 {
            code = result;
            break;
        }
    }
    Ok(code)
}

/// Lightweight JSON Schema subset check (type + required + property types).
/// Full draft validation is not required for killing the TS exec path.
fn validate_against_schema(text: &str, schema_source: &str) -> Result<()> {
    let (schema, label) = load_schema(schema_source)?;
    let parsed: serde_json::Value = serde_json::from_str(text.trim())
        .with_context(|| format!("Assistant output is not valid JSON for schema {label}"))?;
    check_value(&parsed, &schema, "$").with_context(|| format!("schema {label}"))?;
    Ok(())
}

fn load_schema(source: &str) -> Result<(serde_json::Value, String)> {
    let trimmed = source.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let schema: serde_json::Value =
            serde_json::from_str(trimmed).context("parse inline JSON schema")?;
        return Ok((schema, "inline".to_string()));
    }
    let path = PathBuf::from(trimmed);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let raw = std::fs::read_to_string(&absolute)
        .with_context(|| format!("Schema file not found: {}", absolute.display()))?;
    let schema: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse schema {}", absolute.display()))?;
    Ok((schema, absolute.display().to_string()))
}

fn check_value(value: &serde_json::Value, schema: &serde_json::Value, path: &str) -> Result<()> {
    if let Some(types) = schema.get("type") {
        if !type_matches(value, types) {
            bail!("{path} has wrong type (expected {types}, got {value})");
        }
    }

    if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
        let obj = value
            .as_object()
            .with_context(|| format!("{path} is not an object but schema requires keys"))?;
        for key in required {
            let Some(name) = key.as_str() else {
                continue;
            };
            if !obj.contains_key(name) {
                bail!("{path} missing required property `{name}`");
            }
        }
    }

    if let (Some(props), Some(obj)) = (
        schema.get("properties").and_then(|p| p.as_object()),
        value.as_object(),
    ) {
        for (key, prop_schema) in props {
            if let Some(child) = obj.get(key) {
                check_value(child, prop_schema, &format!("{path}.{key}"))?;
            }
        }
    }

    if let (Some(item_schema), Some(arr)) = (schema.get("items"), value.as_array()) {
        for (i, item) in arr.iter().enumerate() {
            check_value(item, item_schema, &format!("{path}[{i}]"))?;
        }
    }

    if let Some(enum_vals) = schema.get("enum").and_then(|e| e.as_array()) {
        if !enum_vals.iter().any(|v| v == value) {
            bail!("{path} value not in enum");
        }
    }

    Ok(())
}

fn type_matches(value: &serde_json::Value, types: &serde_json::Value) -> bool {
    let check_one = |t: &str| -> bool {
        match t {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => true,
        }
    };
    if let Some(t) = types.as_str() {
        return check_one(t);
    }
    if let Some(arr) = types.as_array() {
        return arr.iter().filter_map(|v| v.as_str()).any(check_one);
    }
    true
}

/// Resolve a relative path against cwd.
#[allow(dead_code)]
pub fn resolve_output_path(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_options_default_json_false() {
        let opts = PrintModeOptions {
            prompt: "hi".into(),
            json: false,
            model: None,
            output_last_message: None,
            output_schema: None,
            sandbox_policy: None,
            fail_on_approval: false,
        };
        assert!(!opts.json);
        assert_eq!(opts.prompt, "hi");
    }

    #[test]
    fn schema_required_keys() {
        let schema =
            r#"{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}"#;
        validate_against_schema(r#"{"name":"ok"}"#, schema).unwrap();
        assert!(validate_against_schema(r#"{"other":1}"#, schema).is_err());
        assert!(validate_against_schema("not-json", schema).is_err());
    }

    #[test]
    fn schema_array_items() {
        let schema = r#"{"type":"array","items":{"type":"number"}}"#;
        validate_against_schema("[1,2,3]", schema).unwrap();
        assert!(validate_against_schema(r#"["a"]"#, schema).is_err());
    }

    #[test]
    fn print_mode_waits_for_terminal_event_and_keeps_last_response() {
        let mut current = "I will inspect the file.".to_string();
        let mut last = String::new();
        assert!(!record_completed_response(
            "model-turn-1",
            &mut current,
            &mut last
        ));
        assert_eq!(last, "I will inspect the file.");

        current.push_str("The final answer.");
        assert!(!record_completed_response(
            "model-turn-2",
            &mut current,
            &mut last
        ));
        assert_eq!(last, "The final answer.");
        assert!(record_completed_response("done", &mut current, &mut last));
        assert_eq!(last, "The final answer.");
    }

    #[test]
    fn fail_approval_mode_denies_restricted_tools() {
        let executor = ToolExecutor::new(".");
        assert!(approval_denied(
            &executor,
            "write",
            &serde_json::json!({"file_path":"note.txt","content":"hi"}),
            true,
        ));
        assert!(!approval_denied(
            &executor,
            "read",
            &serde_json::json!({"file_path":"note.txt"}),
            true,
        ));
    }

    #[test]
    fn workspace_paths_reject_traversal() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();

        let read = prepare_workspace_tool_args(
            "read",
            &serde_json::json!({"path": outside_file}),
            workspace.path(),
        );
        assert!(read.is_err());
        let glob = prepare_workspace_tool_args(
            "glob",
            &serde_json::json!({"path": ".", "pattern": "../*.txt"}),
            workspace.path(),
        );
        assert!(glob.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_paths_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(outside.path(), workspace.path().join("outside-link")).unwrap();

        let read = prepare_workspace_tool_args(
            "read",
            &serde_json::json!({"path": "outside-link/secret.txt"}),
            workspace.path(),
        );
        assert!(read.is_err());
        let glob = prepare_workspace_tool_args(
            "glob",
            &serde_json::json!({"path": ".", "pattern": "outside-link/*.txt"}),
            workspace.path(),
        );
        assert!(glob.is_err());
        let wildcarded_link = prepare_workspace_tool_args(
            "glob",
            &serde_json::json!({"path": ".", "pattern": "*/*.txt"}),
            workspace.path(),
        );
        assert!(wildcarded_link.is_err());
    }

    #[test]
    fn workspace_read_rewrites_to_canonical_path() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("nested")).unwrap();
        let file = workspace.path().join("nested").join("marker.txt");
        std::fs::write(&file, "marker").unwrap();

        let args = prepare_workspace_tool_args(
            "read",
            &serde_json::json!({"path": "nested/../nested/marker.txt"}),
            workspace.path(),
        )
        .unwrap();
        assert_eq!(args["path"].as_str(), file.canonicalize().unwrap().to_str());
    }
}

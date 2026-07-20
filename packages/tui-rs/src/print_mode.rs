//! Non-interactive print mode (Grok-style `--print` / single-shot / `exec`).
//!
//! Runs the native agent without a TUI, auto-approves tools, prints the
//! assistant response, and exits. Supports `--output-last-message` and a
//! lightweight JSON Schema check via `--output-schema`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::agent::{resolve_credentials_in_json, FromAgent, NativeAgent, NativeAgentConfig};
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
}

/// Run one prompt non-interactively and print the final answer.
pub async fn run_print_mode(options: PrintModeOptions) -> Result<i32> {
    let model = options
        .model
        .or_else(|| std::env::var("MAESTRO_MODEL").ok())
        .unwrap_or_else(|| "gpt-5.1-codex-max".to_string());

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let system_prompt = format!(
        "You are Maestro, an AI coding assistant. Working directory: {cwd}. Be concise and use tools when helpful."
    );

    let config = NativeAgentConfig {
        model: model.clone(),
        max_tokens: 16384,
        system_prompt: Some(system_prompt),
        thinking_enabled: false,
        thinking_budget: 0,
        cwd: cwd.clone(),
    };

    let (agent, mut event_rx) =
        NativeAgent::new(config).context("Failed to create native agent for print mode")?;
    let tool_tx = agent.tool_response_sender();
    let tool_executor = ToolExecutor::new(&cwd);

    agent.send_ready();
    agent
        .prompt(options.prompt, vec![])
        .await
        .context("Failed to send prompt")?;

    let mut exit_code = 0i32;
    let mut assistant_buf = String::new();

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

                let resolved = resolve_credentials_in_json(&args);
                let result = tool_executor
                    .execute(&tool, &resolved, None, &call_id)
                    .await;

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

                let _ = tool_tx.send((call_id, true, Some(result)));
            }
            FromAgent::ResponseEnd { usage, .. } => {
                if options.json {
                    let line = serde_json::json!({
                        "type": "item",
                        "subtype": "message_complete",
                        "text": assistant_buf,
                        "usage": usage,
                    });
                    println!("{line}");
                    let done = serde_json::json!({
                        "type": "done",
                        "status": "ok",
                    });
                    println!("{done}");
                } else if !assistant_buf.ends_with('\n') {
                    println!();
                }
                break;
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
            if let Err(err) = validate_against_schema(&assistant_buf, schema_src) {
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
            std::fs::write(path, &assistant_buf)
                .with_context(|| format!("write output-last-message to {}", path.display()))?;
            if !options.json {
                eprintln!("Wrote last message to {}", path.display());
            }
        }
    }

    Ok(exit_code)
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
}

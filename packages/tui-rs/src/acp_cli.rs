//! Native Agent Client Protocol (ACP v1) stdio adapter.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

type SharedStdout = Arc<Mutex<tokio::io::Stdout>>;
type ActivePrompts = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;

pub async fn run_acp(_args: &[String]) -> Result<i32> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut sessions: HashMap<String, PathBuf> = HashMap::new();
    let active_prompts: ActivePrompts = Arc::new(Mutex::new(HashMap::new()));

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_message(
                    &stdout,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}}),
                )
                .await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "initialize" => {
                if params.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
                    write_error(&stdout, id, -32602, "unsupported ACP protocol version").await?;
                    continue;
                }
                write_result(
                    &stdout,
                    id,
                    json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": false,
                            "promptCapabilities": {
                                "image": false,
                                "audio": false,
                                "embeddedContext": true
                            },
                            "mcpCapabilities": {"http": false, "sse": false}
                        },
                        "agentInfo": {
                            "name": "maestro",
                            "title": "Maestro",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }),
                )
                .await?;
            }
            "session/new" => {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or(std::env::current_dir()?);
                if !cwd.is_dir() {
                    write_error(&stdout, id, -32602, "session cwd is not a directory").await?;
                    continue;
                }
                let session_id = Uuid::new_v4().to_string();
                sessions.insert(session_id.clone(), cwd);
                write_result(&stdout, id, json!({"sessionId": session_id})).await?;
            }
            "session/prompt" => {
                let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                    write_error(&stdout, id, -32602, "missing sessionId").await?;
                    continue;
                };
                let Some(cwd) = sessions.get(session_id).cloned() else {
                    write_error(&stdout, id, -32602, "unknown sessionId").await?;
                    continue;
                };
                let prompt = prompt_text(&params);
                if prompt.is_empty() {
                    write_error(&stdout, id, -32602, "prompt contains no text").await?;
                    continue;
                }
                let (cancel_tx, cancel_rx) = oneshot::channel();
                if active_prompts.lock().await.contains_key(session_id) {
                    write_error(&stdout, id, -32600, "session already has an active prompt")
                        .await?;
                    continue;
                }
                active_prompts
                    .lock()
                    .await
                    .insert(session_id.to_string(), cancel_tx);
                let task_stdout = Arc::clone(&stdout);
                let task_active = Arc::clone(&active_prompts);
                let task_session_id = session_id.to_string();
                tokio::spawn(async move {
                    let result = execute_prompt(&cwd, &prompt, cancel_rx).await;
                    task_active.lock().await.remove(&task_session_id);
                    match result {
                        Ok(Some(text)) => {
                            let mut journal = crate::transcript::TranscriptJournal::new(16);
                            journal.push(
                                crate::transcript::TranscriptLevel::Block,
                                "agent_message",
                                json!({"text":text}),
                            );
                            for event in journal.after(0, crate::transcript::TranscriptGrade::Block)
                            {
                                let _ = write_message(
                                    &task_stdout,
                                    &json!({
                                        "jsonrpc":"2.0",
                                        "method":"session/update",
                                        "params":{
                                            "sessionId":task_session_id,
                                            "update":{
                                                "sessionUpdate":"agent_message_chunk",
                                                "content":{"type":"text","text":event.payload["text"]}
                                            }
                                        }
                                    }),
                                )
                                .await;
                            }
                            let _ =
                                write_result(&task_stdout, id, json!({"stopReason":"end_turn"}))
                                    .await;
                        }
                        Ok(None) => {
                            let _ =
                                write_result(&task_stdout, id, json!({"stopReason":"cancelled"}))
                                    .await;
                        }
                        Err(error) => {
                            let _ = write_error(&task_stdout, id, -32000, &error.to_string()).await;
                        }
                    }
                });
            }
            "session/cancel" => {
                if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
                    if let Some(sender) = active_prompts.lock().await.remove(session_id) {
                        let _ = sender.send(());
                    }
                }
                if !id.is_null() {
                    write_result(&stdout, id, json!({})).await?;
                }
            }
            _ if request.get("id").is_none() => {}
            _ => write_error(&stdout, id, -32601, "method not found").await?,
        }
    }
    Ok(0)
}

fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text" | "resource_link") => block.get("text").and_then(Value::as_str),
            Some("resource") => block
                .get("resource")
                .and_then(|resource| resource.get("text"))
                .or_else(|| block.get("text"))
                .and_then(Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn execute_prompt(
    cwd: &Path,
    prompt: &str,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Option<String>> {
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(["exec", "--approval-mode", "fail", prompt])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::select! {
        output = command.output() => output.context("failed to launch Maestro agent")?,
        _ = &mut cancelled => return Ok(None),
    };
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(
            "Maestro agent exited with {}: {message}",
            output.status.code().unwrap_or(1)
        );
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

async fn write_result(stdout: &SharedStdout, id: Value, result: Value) -> Result<()> {
    write_message(stdout, &json!({"jsonrpc":"2.0","id":id,"result":result})).await
}

async fn write_error(stdout: &SharedStdout, id: Value, code: i64, message: &str) -> Result<()> {
    write_message(
        stdout,
        &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    )
    .await
}

async fn write_message(stdout: &SharedStdout, value: &Value) -> Result<()> {
    let mut stdout = stdout.lock().await;
    stdout
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_supported_prompt_content() {
        let params = json!({
            "prompt":[
                {"type":"text","text":"hello"},
                {"type":"image","data":"ignored"},
                {"type":"resource","resource":{"uri":"file:///context.md","text":"context"}},
                {"type":"resource","text":"legacy context"}
            ]
        });
        assert_eq!(prompt_text(&params), "hello\ncontext\nlegacy context");
    }
}

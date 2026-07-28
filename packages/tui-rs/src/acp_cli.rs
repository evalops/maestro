//! Native Agent Client Protocol (ACP v1) stdio adapter.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

type SharedStdout = Arc<Mutex<tokio::io::Stdout>>;
type ActivePrompts = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;
type SharedSessions = Arc<Mutex<HashMap<String, AcpSession>>>;

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        self.take_available(false)
    }

    fn finish(&mut self) -> String {
        self.take_available(true)
    }

    fn take_available(&mut self, eof: bool) -> String {
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(
                            std::str::from_utf8(&self.pending[..valid])
                                .expect("validated UTF-8 prefix"),
                        );
                        self.pending.drain(..valid);
                    }
                    match error.error_len() {
                        Some(length) => {
                            output.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..length);
                        }
                        None if eof => {
                            output.push_str(&String::from_utf8_lossy(&self.pending));
                            self.pending.clear();
                            break;
                        }
                        None => break,
                    }
                }
            }
        }
        output
    }
}

#[derive(Debug)]
struct AcpSession {
    cwd: PathBuf,
    history: Vec<(String, String)>,
}

pub async fn run_acp(_args: &[String]) -> Result<i32> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let sessions: SharedSessions = Arc::new(Mutex::new(HashMap::new()));
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
                sessions.lock().await.insert(
                    session_id.clone(),
                    AcpSession {
                        cwd,
                        history: Vec::new(),
                    },
                );
                write_result(&stdout, id, json!({"sessionId": session_id})).await?;
            }
            "session/prompt" => {
                let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                    write_error(&stdout, id, -32602, "missing sessionId").await?;
                    continue;
                };
                let prompt = prompt_text(&params);
                if prompt.is_empty() {
                    write_error(&stdout, id, -32602, "prompt contains no text").await?;
                    continue;
                }
                let Some((cwd, execution_prompt)) =
                    sessions.lock().await.get(session_id).map(|session| {
                        (
                            session.cwd.clone(),
                            prompt_with_history(&session.history, &prompt),
                        )
                    })
                else {
                    write_error(&stdout, id, -32602, "unknown sessionId").await?;
                    continue;
                };
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
                let task_sessions = Arc::clone(&sessions);
                let task_session_id = session_id.to_string();
                tokio::spawn(async move {
                    let result = execute_prompt(
                        &cwd,
                        &execution_prompt,
                        cancel_rx,
                        &task_stdout,
                        &task_session_id,
                    )
                    .await;
                    task_active.lock().await.remove(&task_session_id);
                    match result {
                        Ok(Some(text)) => {
                            if let Some(session) =
                                task_sessions.lock().await.get_mut(&task_session_id)
                            {
                                session.history.push((prompt, text.clone()));
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

fn prompt_with_history(history: &[(String, String)], prompt: &str) -> String {
    if history.is_empty() {
        return prompt.to_string();
    }
    let mut context =
        String::from("Continue this conversation. Preserve all prior context and decisions.\n");
    for (user, assistant) in history {
        context.push_str("\n<user>\n");
        context.push_str(user);
        context.push_str("\n</user>\n<assistant>\n");
        context.push_str(assistant);
        context.push_str("\n</assistant>\n");
    }
    context.push_str("\n<user>\n");
    context.push_str(prompt);
    context.push_str("\n</user>");
    context
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
    acp_stdout: &SharedStdout,
    session_id: &str,
) -> Result<Option<String>> {
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(exec_arguments(prompt))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("failed to launch Maestro agent")?;
    let mut child_stdout = child.stdout.take().context("missing Maestro stdout")?;
    let mut child_stderr = child.stderr.take().context("missing Maestro stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        child_stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut response = Vec::new();
    let mut decoder = Utf8StreamDecoder::default();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = tokio::select! {
            read = child_stdout.read(&mut buffer) => read.context("failed to read Maestro output")?,
            _ = &mut cancelled => {
                let _ = child.kill().await;
                return Ok(None);
            },
        };
        if read == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..read]);
        let chunk = decoder.push(&buffer[..read]);
        if !chunk.is_empty() {
            write_agent_chunk(acp_stdout, session_id, &chunk).await?;
        }
    }
    let final_chunk = decoder.finish();
    if !final_chunk.is_empty() {
        write_agent_chunk(acp_stdout, session_id, &final_chunk).await?;
    }
    let status = child
        .wait()
        .await
        .context("failed to wait for Maestro agent")?;
    let stderr = stderr_task
        .await
        .context("failed to join Maestro stderr reader")??;
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        anyhow::bail!(
            "Maestro agent exited with {}: {message}",
            status.code().unwrap_or(1)
        );
    }
    Ok(Some(String::from_utf8_lossy(&response).trim().to_string()))
}

fn exec_arguments(prompt: &str) -> [&str; 5] {
    ["exec", "--approval-mode", "fail", "--", prompt]
}

async fn write_agent_chunk(stdout: &SharedStdout, session_id: &str, text: &str) -> Result<()> {
    write_message(
        stdout,
        &json!({
            "jsonrpc":"2.0",
            "method":"session/update",
            "params":{
                "sessionId":session_id,
                "update":{
                    "sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":text}
                }
            }
        }),
    )
    .await
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

    #[test]
    fn subsequent_prompts_include_prior_turns() {
        let prompt = prompt_with_history(
            &[(
                "Remember the codename is Juniper.".to_string(),
                "I will remember Juniper.".to_string(),
            )],
            "What is the codename?",
        );

        assert!(prompt.contains("<user>\nRemember the codename is Juniper.\n</user>"));
        assert!(prompt.contains("<assistant>\nI will remember Juniper.\n</assistant>"));
        assert!(prompt.ends_with("<user>\nWhat is the codename?\n</user>"));
    }

    #[test]
    fn streaming_decoder_preserves_split_unicode() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "A€B".as_bytes();

        assert_eq!(decoder.push(&bytes[..2]), "A");
        assert_eq!(decoder.push(&bytes[2..3]), "");
        assert_eq!(decoder.push(&bytes[3..]), "€B");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn exec_prompt_is_delimited_from_options() {
        assert_eq!(
            exec_arguments("--model explain-this"),
            [
                "exec",
                "--approval-mode",
                "fail",
                "--",
                "--model explain-this"
            ]
        );
    }
}

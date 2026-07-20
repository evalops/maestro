//! Native headless **server** — Rust agent speaks the headless protocol on stdio.
//!
//! Replaces the TypeScript `runHeadlessMode` agent path. Clients (including the
//! native TUI headless client, IDE bridges, and tests) send `ToAgentMessage`
//! lines on stdin and receive `FromAgentMessage` lines on stdout.
//!
//! The agent is created lazily on first `Prompt` so `Hello`/`Init` handshakes
//! work without credentials.

use std::io::{BufRead, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::agent::{
    resolve_credentials_in_json, FromAgent, NativeAgent, NativeAgentConfig, PromptKind,
};
use crate::headless::messages::{
    FromAgentMessage, HeadlessErrorType, ToAgentMessage, TokenUsage as HeadlessTokenUsage,
};
use crate::headless::HEADLESS_PROTOCOL_VERSION;
use crate::tools::ToolExecutor;

struct HeadlessState {
    model: String,
    cwd: String,
    system_prompt: String,
    thinking_enabled: bool,
    thinking_budget: u32,
    agent: Option<NativeAgent>,
    tool_tx: Option<mpsc::UnboundedSender<(String, bool, Option<crate::agent::ToolResult>)>>,
    event_task: Option<tokio::task::JoinHandle<()>>,
}

impl HeadlessState {
    fn new() -> Self {
        let model =
            std::env::var("MAESTRO_MODEL").unwrap_or_else(|_| "gpt-5.1-codex-max".to_string());
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let system_prompt = format!(
            "You are Maestro, an AI coding assistant. Working directory: {cwd}. Be concise and use tools when helpful."
        );
        Self {
            model,
            cwd,
            system_prompt,
            thinking_enabled: false,
            thinking_budget: 10_000,
            agent: None,
            tool_tx: None,
            event_task: None,
        }
    }

    fn ensure_agent(&mut self) -> Result<&NativeAgent> {
        if self.agent.is_none() {
            let config = NativeAgentConfig {
                model: self.model.clone(),
                max_tokens: 16384,
                system_prompt: Some(self.system_prompt.clone()),
                thinking_enabled: self.thinking_enabled,
                thinking_budget: self.thinking_budget,
                cwd: self.cwd.clone(),
            };
            let (agent, mut event_rx) = NativeAgent::new(config)
                .context("Failed to create native agent for headless server")?;
            let tool_tx = agent.tool_response_sender();
            let tool_executor = Arc::new(ToolExecutor::new(&self.cwd));
            let tool_tx_bg = tool_tx.clone();
            let event_task = tokio::spawn(async move {
                while let Some(msg) = event_rx.recv().await {
                    if let Err(err) = handle_agent_event(msg, &tool_executor, &tool_tx_bg).await {
                        let _ = emit(&FromAgentMessage::Error {
                            request_id: None,
                            message: format!("headless event bridge failed: {err:#}"),
                            fatal: false,
                            error_type: Some(HeadlessErrorType::Protocol),
                        });
                    }
                }
            });
            self.tool_tx = Some(tool_tx);
            self.event_task = Some(event_task);
            self.agent = Some(agent);
            // Ready is already emitted at server start; re-emit after real agent boot.
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model: self.model.clone(),
                provider: infer_provider_label(&self.model).to_string(),
                session_id: None,
            })?;
        }
        Ok(self.agent.as_ref().expect("agent just created"))
    }

    fn agent_mut(&mut self) -> Result<&NativeAgent> {
        self.ensure_agent()
    }
}

/// Run the native headless protocol server until EOF or shutdown.
pub async fn run_headless_server() -> Result<i32> {
    let mut state = HeadlessState::new();

    // Emit ready immediately so clients can proceed with Hello/Init without credentials.
    emit(&FromAgentMessage::Ready {
        protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        model: state.model.clone(),
        provider: infer_provider_label(&state.model).to_string(),
        session_id: None,
    })?;

    // stdin reader on a blocking thread → channel
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        while let Some(Ok(line)) = lines.next() {
            if stdin_tx.send(line).is_err() {
                break;
            }
        }
    });

    let exit_code = 0i32;
    while let Some(line) = stdin_rx.recv().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: ToAgentMessage = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(err) => {
                emit(&FromAgentMessage::Error {
                    request_id: None,
                    message: format!("Invalid headless message: {err}"),
                    fatal: false,
                    error_type: Some(HeadlessErrorType::Protocol),
                })?;
                continue;
            }
        };

        match msg {
            ToAgentMessage::Hello {
                protocol_version,
                client_info,
                capabilities,
                role,
                opt_out_notifications,
            } => {
                emit(&FromAgentMessage::HelloOk {
                    protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
                    connection_id: Some("native-local".to_string()),
                    client_protocol_version: protocol_version,
                    client_info,
                    capabilities,
                    opt_out_notifications,
                    role,
                    controller_connection_id: None,
                    lease_expires_at: None,
                })?;
            }
            ToAgentMessage::Init {
                system_prompt: sp,
                append_system_prompt,
                thinking_level,
                approval_mode: _,
            } => {
                if let Some(sp) = sp {
                    state.system_prompt = sp;
                }
                if let Some(append) = append_system_prompt {
                    state.system_prompt.push_str("\n\n");
                    state.system_prompt.push_str(&append);
                }
                if let Some(level) = thinking_level {
                    let (enabled, budget) = match level {
                        crate::headless::messages::ThinkingLevel::Off => (false, 0),
                        crate::headless::messages::ThinkingLevel::Minimal => (true, 1_000),
                        crate::headless::messages::ThinkingLevel::Low => (true, 5_000),
                        crate::headless::messages::ThinkingLevel::Medium => (true, 10_000),
                        crate::headless::messages::ThinkingLevel::High => (true, 20_000),
                        crate::headless::messages::ThinkingLevel::Ultra => (true, 50_000),
                    };
                    state.thinking_enabled = enabled;
                    state.thinking_budget = budget;
                }
                // If agent already exists, push updates through.
                if let Some(agent) = state.agent.as_ref() {
                    let _ = agent.set_system_prompt(state.system_prompt.clone());
                    let _ = agent.set_thinking(state.thinking_enabled, state.thinking_budget);
                }
                emit(&FromAgentMessage::Status {
                    message: "init applied".to_string(),
                })?;
            }
            ToAgentMessage::Prompt {
                content,
                attachments,
            } => {
                let atts = attachments.unwrap_or_default();
                match state.agent_mut() {
                    Ok(agent) => {
                        if let Err(err) = agent
                            .prompt_with_kind(content, atts, PromptKind::Prompt, None)
                            .await
                        {
                            emit(&FromAgentMessage::Error {
                                request_id: None,
                                message: format!("Failed to send prompt: {err:#}"),
                                fatal: false,
                                error_type: Some(HeadlessErrorType::Protocol),
                            })?;
                        }
                    }
                    Err(err) => {
                        emit(&FromAgentMessage::Error {
                            request_id: None,
                            message: format!("Failed to start agent: {err:#}"),
                            fatal: true,
                            error_type: Some(HeadlessErrorType::Fatal),
                        })?;
                    }
                }
            }
            ToAgentMessage::Interrupt | ToAgentMessage::Cancel => {
                if let Some(agent) = state.agent.as_ref() {
                    agent.cancel();
                }
            }
            ToAgentMessage::ToolResponse {
                call_id,
                approved,
                result,
            } => {
                if let Some(tool_tx) = state.tool_tx.as_ref() {
                    let agent_result = result.map(|r| crate::agent::ToolResult {
                        success: r.success,
                        output: r.output,
                        error: r.error,
                        details: r.details,
                    });
                    let _ = tool_tx.send((call_id, approved, agent_result));
                }
            }
            ToAgentMessage::Shutdown => {
                emit(&FromAgentMessage::Status {
                    message: "shutting down".to_string(),
                })?;
                break;
            }
            // Utility / client-tool surfaces: acknowledge without full Node parity yet.
            other => {
                emit(&FromAgentMessage::Status {
                    message: format!("native headless ignored message: {other:?}"),
                })?;
            }
        }
    }

    if let Some(task) = state.event_task.take() {
        task.abort();
    }
    Ok(exit_code)
}

async fn handle_agent_event(
    msg: FromAgent,
    tool_executor: &ToolExecutor,
    tool_tx: &mpsc::UnboundedSender<(String, bool, Option<crate::agent::ToolResult>)>,
) -> Result<()> {
    match msg {
        FromAgent::Ready { model, provider } => {
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model,
                provider,
                session_id: None,
            })?;
        }
        FromAgent::ResponseStart { response_id } => {
            emit(&FromAgentMessage::ResponseStart { response_id })?;
        }
        FromAgent::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } => {
            emit(&FromAgentMessage::ResponseChunk {
                response_id,
                content,
                is_thinking,
            })?;
        }
        FromAgent::ResponseEnd { response_id, usage } => {
            emit(&FromAgentMessage::ResponseEnd {
                response_id,
                usage: usage.map(to_headless_usage),
                tools_summary: None,
                duration_ms: None,
                ttft_ms: None,
            })?;
        }
        FromAgent::ToolCall {
            call_id,
            tool,
            args,
            requires_approval,
        } => {
            emit(&FromAgentMessage::ToolCall {
                call_id: call_id.clone(),
                tool_execution_id: None,
                tool: tool.clone(),
                args: args.clone(),
                requires_approval,
            })?;
            // Auto-execute when approval is not required (headless default).
            if !requires_approval {
                let resolved = resolve_credentials_in_json(&args);
                let result = tool_executor
                    .execute(&tool, &resolved, None, &call_id)
                    .await;
                emit(&FromAgentMessage::ToolStart {
                    call_id: call_id.clone(),
                })?;
                emit(&FromAgentMessage::ToolEnd {
                    call_id: call_id.clone(),
                    tool_execution_id: None,
                    success: result.success,
                    tool: Some(tool),
                    details: result.details.clone(),
                })?;
                let _ = tool_tx.send((call_id, true, Some(result)));
            }
        }
        FromAgent::ToolStart { call_id } => {
            emit(&FromAgentMessage::ToolStart { call_id })?;
        }
        FromAgent::ToolOutput { call_id, content } => {
            emit(&FromAgentMessage::ToolOutput { call_id, content })?;
        }
        FromAgent::ToolEnd { call_id, success } => {
            emit(&FromAgentMessage::ToolEnd {
                call_id,
                tool_execution_id: None,
                success,
                tool: None,
                details: None,
            })?;
        }
        FromAgent::Error { message, fatal } => {
            emit(&FromAgentMessage::Error {
                request_id: None,
                message,
                fatal,
                error_type: Some(if fatal {
                    HeadlessErrorType::Fatal
                } else {
                    HeadlessErrorType::Transient
                }),
            })?;
        }
        FromAgent::Status { message } => {
            emit(&FromAgentMessage::Status { message })?;
        }
        FromAgent::SessionInfo {
            session_id,
            cwd,
            git_branch,
        } => {
            emit(&FromAgentMessage::SessionInfo {
                session_id,
                cwd,
                git_branch,
            })?;
        }
        FromAgent::Compaction {
            summary,
            first_kept_entry_index,
            tokens_before,
            auto,
            custom_instructions,
            timestamp,
        } => {
            emit(&FromAgentMessage::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            })?;
        }
        _ => {}
    }
    Ok(())
}

fn emit(msg: &FromAgentMessage) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, msg).context("serialize headless message")?;
    stdout.write_all(b"\n").context("write headless newline")?;
    stdout.flush().context("flush headless stdout")?;
    Ok(())
}

fn to_headless_usage(usage: crate::agent::TokenUsage) -> HeadlessTokenUsage {
    HeadlessTokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        cost: usage.cost,
        total_tokens: Some(usage.input_tokens + usage.output_tokens),
        model_id: None,
        provider: None,
    }
}

fn infer_provider_label(model: &str) -> &'static str {
    let m = model.to_lowercase();
    if m.contains("claude") || m.contains("anthropic") {
        "Anthropic"
    } else if m.contains("gemini") || m.contains("google") {
        "Google"
    } else {
        "OpenAI"
    }
}

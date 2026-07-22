//! Native headless **server** — Rust agent speaks the headless protocol on stdio.
//!
//! Replaces the TypeScript `runHeadlessMode` agent path. Clients (including the
//! native TUI headless client, IDE bridges, and tests) send `ToAgentMessage`
//! lines on stdin and receive `FromAgentMessage` lines on stdout.
//!
//! The agent is created lazily on first `Prompt` so `Hello`/`Init` handshakes
//! work without credentials.
//!
//! ## Tool execution ownership
//!
//! Tools that do **not** require approval are auto-executed by the native agent
//! loop, which emits `ToolStart` / `ToolOutput` / `ToolEnd` through the event
//! bridge. Headless must **not** re-execute those tools (that would double-run
//! side effects and drop streaming `tool_output`).
//!
//! Tools that **do** require approval are resolved by:
//! - `ApprovalMode::Auto` → approve and let the native agent execute
//! - `ApprovalMode::Fail` → deny immediately
//! - `ApprovalMode::Prompt` / unset → wait for client `ToolResponse`

use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::agent::{FromAgent, NativeAgent, NativeAgentConfig, PromptKind, ToolResult};
use crate::git;
use crate::headless::messages::{
    ApprovalMode, FromAgentMessage, HeadlessErrorType, ToAgentMessage,
    TokenUsage as HeadlessTokenUsage, ToolResult as HeadlessToolResult,
};
use crate::headless::HEADLESS_PROTOCOL_VERSION;

/// Shared headless runtime metadata updated from Init / SessionInfo.
#[derive(Debug, Default, Clone)]
struct RuntimeMeta {
    session_id: Option<String>,
    approval_mode: Option<ApprovalMode>,
}

struct HeadlessState {
    model: String,
    cwd: String,
    system_prompt: String,
    thinking_enabled: bool,
    thinking_budget: u32,
    /// Seeded conversation history applied on agent creation / init.
    history: Option<Vec<crate::headless::messages::HistoryMessage>>,
    meta: Arc<Mutex<RuntimeMeta>>,
    agent: Option<NativeAgent>,
    tool_tx: Option<mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>>,
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
        let session_id = env_session_id();
        Self {
            model,
            cwd,
            system_prompt,
            thinking_enabled: false,
            thinking_budget: 10_000,
            history: None,
            meta: Arc::new(Mutex::new(RuntimeMeta {
                session_id,
                approval_mode: None,
            })),
            agent: None,
            tool_tx: None,
            event_task: None,
        }
    }

    fn session_id(&self) -> Option<String> {
        self.meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .session_id
            .clone()
    }

    fn set_approval_mode(&self, mode: Option<ApprovalMode>) {
        self.meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .approval_mode = mode;
    }

    fn ensure_session_id(&self) -> String {
        let mut meta = self
            .meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(id) = meta.session_id.clone().filter(|s| !s.is_empty()) {
            return id;
        }
        let id = uuid::Uuid::new_v4().to_string();
        meta.session_id = Some(id.clone());
        id
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
            // Apply any seeded multi-turn history before the first prompt.
            if let Some(history) = self.history.as_deref() {
                let messages = crate::headless::messages::history_to_ai_messages(Some(history));
                if !messages.is_empty() {
                    agent.replace_history(messages);
                }
            }
            let tool_tx = agent.tool_response_sender();
            let tool_tx_bg = tool_tx.clone();
            let meta_bg = Arc::clone(&self.meta);
            let event_task = tokio::spawn(async move {
                while let Some(msg) = event_rx.recv().await {
                    if let Err(err) = handle_agent_event(msg, &meta_bg, &tool_tx_bg).await {
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

            // Bind a session id once the real agent boots and surface it on Ready.
            let session_id = self.ensure_session_id();
            let git_branch = git::current_branch(Path::new(&self.cwd));
            if let Some(agent) = self.agent.as_ref() {
                agent.send_session_info(&self.cwd, Some(session_id.clone()), git_branch);
            }
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model: self.model.clone(),
                provider: infer_provider_label(&self.model).to_string(),
                session_id: Some(session_id),
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
    // Include session_id when already available (e.g. MAESTRO_SESSION_ID).
    emit(&FromAgentMessage::Ready {
        protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        model: state.model.clone(),
        provider: infer_provider_label(&state.model).to_string(),
        session_id: state.session_id(),
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
                approval_mode,
                history,
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
                if approval_mode.is_some() {
                    state.set_approval_mode(approval_mode);
                }
                if history.is_some() {
                    state.history = history;
                }
                // If agent already exists, push updates through.
                if let Some(agent) = state.agent.as_ref() {
                    let _ = agent.set_system_prompt(state.system_prompt.clone());
                    let _ = agent.set_thinking(state.thinking_enabled, state.thinking_budget);
                    if let Some(history) = state.history.as_deref() {
                        let messages =
                            crate::headless::messages::history_to_ai_messages(Some(history));
                        agent.replace_history(messages);
                    }
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
                let agent_result = result.map(headless_tool_result_to_agent);
                // When the client supplies a completed result, surface the full
                // tool lifecycle (including tool_output) for streaming consumers.
                // When only an approval is returned, the native agent executes
                // and emits ToolStart/ToolOutput/ToolEnd itself.
                if approved {
                    if let Some(ref tool_result) = agent_result {
                        for msg in tool_lifecycle_messages(&call_id, None, tool_result) {
                            emit(&msg)?;
                        }
                    }
                }
                if let Some(tool_tx) = state.tool_tx.as_ref() {
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
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>,
) -> Result<()> {
    match msg {
        FromAgent::Ready { model, provider } => {
            let session_id = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .session_id
                .clone();
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model,
                provider,
                session_id,
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
                tool,
                args,
                requires_approval,
            })?;

            // Tools that do not require approval are auto-executed by the
            // native agent (with ToolStart/ToolOutput/ToolEnd). Do not
            // re-execute here — that double-ran side effects and omitted
            // streaming tool_output.
            //
            // For approval-gated tools, honor Init approval_mode when set.
            let approval_mode = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .approval_mode;
            if let Some(approved) = resolve_tool_approval(requires_approval, approval_mode) {
                let _ = tool_tx.send((call_id, approved, None));
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
            if let Some(ref id) = session_id {
                if !id.is_empty() {
                    meta.lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .session_id = Some(id.clone());
                }
            }
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

fn env_session_id() -> Option<String> {
    std::env::var("MAESTRO_SESSION_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn headless_tool_result_to_agent(r: HeadlessToolResult) -> ToolResult {
    ToolResult {
        success: r.success,
        output: r.output,
        error: r.error,
        details: r.details,
    }
}

/// Decide whether headless should immediately resolve an approval-gated tool.
///
/// - `None` → leave to the native agent (auto-exec) or wait for the client
/// - `Some(true)` → approve; native agent executes and streams tool events
/// - `Some(false)` → deny
fn resolve_tool_approval(
    requires_approval: bool,
    approval_mode: Option<ApprovalMode>,
) -> Option<bool> {
    if !requires_approval {
        // Native agent auto-executes; headless must not inject a tool_response.
        return None;
    }
    match approval_mode {
        Some(ApprovalMode::Auto) => Some(true),
        Some(ApprovalMode::Fail) => Some(false),
        Some(ApprovalMode::Prompt) | None => None,
    }
}

/// Content for a `tool_output` event from a completed tool result.
fn tool_output_content(result: &ToolResult) -> Option<String> {
    if !result.output.is_empty() {
        return Some(result.output.clone());
    }
    if !result.success {
        return Some(format!(
            "Error: {}",
            result.error.as_deref().unwrap_or("tool failed")
        ));
    }
    None
}

/// Protocol messages for a completed tool run: start → output? → end.
fn tool_lifecycle_messages(
    call_id: &str,
    tool: Option<String>,
    result: &ToolResult,
) -> Vec<FromAgentMessage> {
    let mut msgs = Vec::with_capacity(3);
    msgs.push(FromAgentMessage::ToolStart {
        call_id: call_id.to_string(),
    });
    if let Some(content) = tool_output_content(result) {
        msgs.push(FromAgentMessage::ToolOutput {
            call_id: call_id.to_string(),
            content,
        });
    }
    msgs.push(FromAgentMessage::ToolEnd {
        call_id: call_id.to_string(),
        tool_execution_id: None,
        success: result.success,
        tool,
        details: result.details.clone(),
    });
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_tool_approval_leaves_auto_exec_to_native() {
        assert_eq!(resolve_tool_approval(false, None), None);
        assert_eq!(resolve_tool_approval(false, Some(ApprovalMode::Auto)), None);
        assert_eq!(resolve_tool_approval(false, Some(ApprovalMode::Fail)), None);
        assert_eq!(
            resolve_tool_approval(false, Some(ApprovalMode::Prompt)),
            None
        );
    }

    #[test]
    fn resolve_tool_approval_honors_mode_for_gated_tools() {
        assert_eq!(
            resolve_tool_approval(true, Some(ApprovalMode::Auto)),
            Some(true)
        );
        assert_eq!(
            resolve_tool_approval(true, Some(ApprovalMode::Fail)),
            Some(false)
        );
        assert_eq!(
            resolve_tool_approval(true, Some(ApprovalMode::Prompt)),
            None
        );
        assert_eq!(resolve_tool_approval(true, None), None);
    }

    #[test]
    fn tool_output_content_prefers_stdout() {
        let ok = ToolResult::success("hello from tool");
        assert_eq!(tool_output_content(&ok).as_deref(), Some("hello from tool"));

        let empty_ok = ToolResult::success("");
        assert_eq!(tool_output_content(&empty_ok), None);

        let fail = ToolResult::failure("boom");
        assert_eq!(tool_output_content(&fail).as_deref(), Some("Error: boom"));

        let fail_with_partial = ToolResult {
            success: false,
            output: "partial".into(),
            error: Some("exit 1".into()),
            details: None,
        };
        assert_eq!(
            tool_output_content(&fail_with_partial).as_deref(),
            Some("partial")
        );
    }

    #[test]
    fn tool_lifecycle_messages_include_tool_output() {
        let result = ToolResult::success("file contents");
        let msgs = tool_lifecycle_messages("call-1", Some("read".into()), &result);
        assert_eq!(msgs.len(), 3);
        assert!(matches!(
            &msgs[0],
            FromAgentMessage::ToolStart { call_id } if call_id == "call-1"
        ));
        assert!(matches!(
            &msgs[1],
            FromAgentMessage::ToolOutput { call_id, content }
                if call_id == "call-1" && content == "file contents"
        ));
        assert!(matches!(
            &msgs[2],
            FromAgentMessage::ToolEnd {
                call_id,
                success: true,
                tool: Some(t),
                ..
            } if call_id == "call-1" && t == "read"
        ));
    }

    #[test]
    fn tool_lifecycle_messages_omit_empty_success_output() {
        let result = ToolResult::success("");
        let msgs = tool_lifecycle_messages("call-2", None, &result);
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0], FromAgentMessage::ToolStart { .. }));
        assert!(matches!(
            msgs[1],
            FromAgentMessage::ToolEnd { success: true, .. }
        ));
    }

    #[test]
    fn ready_message_serializes_session_id_when_present() {
        let msg = FromAgentMessage::Ready {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            model: "gpt-test".into(),
            provider: "OpenAI".into(),
            session_id: Some("sess-abc".into()),
        };
        let json = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(json["type"], "ready");
        assert_eq!(json["session_id"], "sess-abc");
        assert_eq!(json["model"], "gpt-test");
    }

    #[test]
    fn ready_message_omits_null_session_id() {
        let msg = FromAgentMessage::Ready {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            model: "gpt-test".into(),
            provider: "OpenAI".into(),
            session_id: None,
        };
        let json = serde_json::to_value(&msg).expect("serialize");
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn env_session_id_reads_maestro_session_id() {
        // Isolate from ambient env for this process.
        let key = "MAESTRO_SESSION_ID";
        let previous = std::env::var(key).ok();
        // SAFETY: single-threaded test; restore after.
        unsafe {
            std::env::set_var(key, "  env-session-42  ");
        }
        let got = env_session_id();
        match previous {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
        assert_eq!(got.as_deref(), Some("env-session-42"));
    }
}

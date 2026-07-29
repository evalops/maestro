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

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::agent::{
    CredentialVault, FromAgent, NativeAgent, NativeAgentConfig, PromptKind, ToolResult,
};
use crate::git;
use crate::headless::messages::{
    ApprovalMode, ClientCapabilities, ClientToolResultContent, FromAgentMessage, HeadlessErrorType,
    ServerRequestResolutionStatus, ServerRequestResolvedBy, ServerRequestType, ToAgentMessage,
    TokenUsage as HeadlessTokenUsage, ToolResult as HeadlessToolResult, ToolRetryDecisionAction,
    UtilityCommandShellMode, UtilityCommandStream, UtilityCommandTerminalMode,
    UtilityFileSearchMatch, UtilityOperation,
};
use crate::headless::HEADLESS_PROTOCOL_VERSION;

/// Shared headless runtime metadata updated from Init / SessionInfo.
#[derive(Debug, Default, Clone)]
struct RuntimeMeta {
    session_id: Option<String>,
    approval_mode: Option<ApprovalMode>,
    transcript_grade: crate::transcript::TranscriptGrade,
    response_chunks: Vec<(String, bool)>,
}

impl RuntimeMeta {
    fn record_response_chunk(
        &mut self,
        content: &str,
        is_thinking: bool,
    ) -> crate::transcript::TranscriptGrade {
        let grade = self.transcript_grade;
        if grade != crate::transcript::TranscriptGrade::Delta {
            self.response_chunks
                .push((content.to_string(), is_thinking));
        }
        grade
    }
}

struct HeadlessState {
    model: String,
    cwd: String,
    system_prompt: String,
    thinking_enabled: bool,
    thinking_budget: u32,
    credential_vault: CredentialVault,
    /// Seeded conversation history applied on agent creation / init.
    history: Option<Vec<crate::headless::messages::HistoryMessage>>,
    meta: Arc<Mutex<RuntimeMeta>>,
    agent: Option<NativeAgent>,
    tool_tx: Option<mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>>,
    event_task: Option<tokio::task::JoinHandle<()>>,
    utility_commands: HashMap<String, mpsc::UnboundedSender<UtilityCommandControl>>,
    file_watches: HashMap<String, tokio::task::JoinHandle<()>>,
}

enum UtilityCommandControl {
    Terminate,
    Stdin { content: String, eof: bool },
}

struct UtilityCommandOptions {
    command_id: String,
    command: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    shell_mode: UtilityCommandShellMode,
    terminal_mode: UtilityCommandTerminalMode,
    allow_stdin: bool,
    columns: Option<u32>,
    rows: Option<u32>,
}

impl HeadlessState {
    fn new() -> Self {
        let model = std::env::var("MAESTRO_MODEL").unwrap_or_else(|_| "gpt-5.5".to_string());
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
            credential_vault: CredentialVault::new(),
            history: None,
            meta: Arc::new(Mutex::new(RuntimeMeta {
                session_id,
                approval_mode: None,
                transcript_grade: crate::transcript::TranscriptGrade::Delta,
                response_chunks: Vec::new(),
            })),
            agent: None,
            tool_tx: None,
            event_task: None,
            utility_commands: HashMap::new(),
            file_watches: HashMap::new(),
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
                // The headless protocol's own `ApprovalMode` (Auto/Fail/Prompt,
                // imported above) only resolves calls the runner already
                // marked `requires_approval`; preserve the prior (mode-unaware)
                // per-tool heuristic here exactly so that decision is unchanged.
                approval_mode: crate::state::ApprovalMode::Selective,
            };
            let (agent, mut event_rx) =
                NativeAgent::new_with_credential_vault(config, self.credential_vault.clone())
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
        state
            .utility_commands
            .retain(|_, control| !control.is_closed());
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
                if let Some(grade) = capabilities.and_then(|value| value.transcript_grade) {
                    state
                        .meta
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .transcript_grade = grade;
                }
                emit(&FromAgentMessage::HelloOk {
                    protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
                    connection_id: Some("native-local".to_string()),
                    client_protocol_version: protocol_version,
                    client_info,
                    capabilities: Some(native_capabilities()),
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
                emit(&FromAgentMessage::Error {
                    request_id: None,
                    message: "operation cancelled".to_string(),
                    fatal: false,
                    error_type: Some(HeadlessErrorType::Cancelled),
                })?;
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
                } else {
                    protocol_error(Some(call_id), "no pending native tool request")?;
                }
            }
            ToAgentMessage::ClientToolResult {
                call_id,
                content,
                is_error,
            } => {
                let result = client_content_to_agent_result(content, is_error);
                if let Some(tool_tx) = state.tool_tx.as_ref() {
                    let _ = tool_tx.send((call_id.clone(), true, Some(result.clone())));
                    for msg in tool_lifecycle_messages(&call_id, None, &result) {
                        emit(&msg)?;
                    }
                } else {
                    protocol_error(Some(call_id), "no pending native client-tool request")?;
                }
            }
            ToAgentMessage::ServerRequestResponse {
                request_id,
                request_type,
                approved,
                result,
                content,
                is_error,
                decision_action,
                reason,
            } => {
                let resolution = server_request_resolution(
                    request_type,
                    approved,
                    result.as_ref(),
                    is_error,
                    decision_action,
                );
                let agent_result = result.map(headless_tool_result_to_agent).or_else(|| {
                    content.map(|value| {
                        client_content_to_agent_result(value, is_error.unwrap_or(false))
                    })
                });
                if let Some(tool_tx) = state.tool_tx.as_ref() {
                    let approved = approved.unwrap_or(!matches!(
                        resolution,
                        ServerRequestResolutionStatus::Denied
                            | ServerRequestResolutionStatus::Failed
                            | ServerRequestResolutionStatus::Skipped
                            | ServerRequestResolutionStatus::Aborted
                    ));
                    let _ = tool_tx.send((request_id.clone(), approved, agent_result));
                }
                emit(&FromAgentMessage::ServerRequestResolved {
                    request_id: request_id.clone(),
                    request_type,
                    call_id: request_id,
                    resolution,
                    reason,
                    resolved_by: ServerRequestResolvedBy::Client,
                    started_at_ms: None,
                    resolved_at_ms: Some(unix_timestamp_ms()),
                })?;
            }
            ToAgentMessage::UtilityCommandStart {
                command_id,
                command,
                cwd,
                env,
                shell_mode,
                terminal_mode,
                allow_stdin,
                columns,
                rows,
            } => {
                if state.utility_commands.contains_key(&command_id) {
                    protocol_error(Some(command_id), "utility command id is already running")?;
                    continue;
                }
                let cwd = cwd.unwrap_or_else(|| state.cwd.clone());
                match start_utility_command(UtilityCommandOptions {
                    command_id: command_id.clone(),
                    command,
                    cwd,
                    env,
                    shell_mode: shell_mode.unwrap_or(UtilityCommandShellMode::Shell),
                    terminal_mode: terminal_mode.unwrap_or(UtilityCommandTerminalMode::Pipe),
                    allow_stdin: allow_stdin.unwrap_or(false),
                    columns,
                    rows,
                })
                .await
                {
                    Ok(control) => {
                        state.utility_commands.insert(command_id, control);
                    }
                    Err(err) => protocol_error(
                        Some(command_id),
                        format!("utility command failed: {err:#}"),
                    )?,
                }
            }
            ToAgentMessage::UtilityCommandTerminate { command_id, .. } => {
                match state.utility_commands.remove(&command_id) {
                    Some(control) => {
                        let _ = control.send(UtilityCommandControl::Terminate);
                    }
                    None => protocol_error(Some(command_id), "utility command is not running")?,
                }
            }
            ToAgentMessage::UtilityCommandStdin {
                command_id,
                content,
                eof,
            } => match state.utility_commands.get(&command_id) {
                Some(control) => {
                    let _ = control.send(UtilityCommandControl::Stdin {
                        content,
                        eof: eof.unwrap_or(false),
                    });
                }
                None => protocol_error(Some(command_id), "utility command is not running")?,
            },
            ToAgentMessage::UtilityCommandResize {
                command_id,
                columns,
                rows,
            } => {
                if state.utility_commands.contains_key(&command_id) {
                    emit(&FromAgentMessage::UtilityCommandResized {
                        command_id,
                        columns,
                        rows,
                    })?;
                } else {
                    protocol_error(Some(command_id), "utility command is not running")?;
                }
            }
            ToAgentMessage::UtilityFileSearch {
                search_id,
                query,
                cwd,
                limit,
            } => {
                let cwd = cwd.unwrap_or_else(|| state.cwd.clone());
                match utility_file_search(&cwd, &query, limit.unwrap_or(50) as usize) {
                    Ok((results, truncated)) => {
                        emit(&FromAgentMessage::UtilityFileSearchResults {
                            search_id,
                            query,
                            cwd,
                            results,
                            truncated,
                        })?;
                    }
                    Err(err) => {
                        protocol_error(Some(search_id), format!("file search failed: {err:#}"))?;
                    }
                }
            }
            ToAgentMessage::UtilityFileRead {
                read_id,
                path,
                cwd,
                offset,
                limit,
            } => {
                let cwd = cwd.unwrap_or_else(|| state.cwd.clone());
                match utility_file_read(&cwd, &path, offset.unwrap_or(0), limit.unwrap_or(2_000))
                    .await
                {
                    Ok(result) => emit(&FromAgentMessage::UtilityFileReadResult {
                        read_id,
                        path,
                        relative_path: result.relative_path,
                        cwd,
                        content: result.content,
                        start_line: result.start_line,
                        end_line: result.end_line,
                        total_lines: result.total_lines,
                        truncated: result.truncated,
                    })?,
                    Err(err) => {
                        protocol_error(Some(read_id), format!("file read failed: {err:#}"))?;
                    }
                }
            }
            ToAgentMessage::UtilityFileWatchStart {
                watch_id,
                root_dir,
                include_patterns,
                exclude_patterns,
                debounce_ms,
            } => {
                if state.file_watches.contains_key(&watch_id) {
                    protocol_error(Some(watch_id), "file watch id is already running")?;
                    continue;
                }
                let root_dir = root_dir.unwrap_or_else(|| state.cwd.clone());
                match start_file_watch(
                    watch_id.clone(),
                    root_dir.clone(),
                    include_patterns.clone(),
                    exclude_patterns.clone(),
                    debounce_ms.unwrap_or(100),
                ) {
                    Ok(task) => {
                        state.file_watches.insert(watch_id.clone(), task);
                        emit(&FromAgentMessage::UtilityFileWatchStarted {
                            watch_id,
                            root_dir,
                            include_patterns,
                            exclude_patterns,
                            debounce_ms: debounce_ms.unwrap_or(100),
                            owner_connection_id: Some("native-local".to_string()),
                        })?;
                    }
                    Err(err) => {
                        protocol_error(Some(watch_id), format!("file watch failed: {err:#}"))?;
                    }
                }
            }
            ToAgentMessage::UtilityFileWatchStop { watch_id } => {
                match state.file_watches.remove(&watch_id) {
                    Some(task) => {
                        task.abort();
                        emit(&FromAgentMessage::UtilityFileWatchStopped {
                            watch_id,
                            reason: Some("client requested".to_string()),
                        })?;
                    }
                    None => protocol_error(Some(watch_id), "file watch is not running")?,
                }
            }
            ToAgentMessage::Shutdown => {
                for (_, control) in state.utility_commands.drain() {
                    let _ = control.send(UtilityCommandControl::Terminate);
                }
                for (_, task) in state.file_watches.drain() {
                    task.abort();
                }
                emit(&FromAgentMessage::Status {
                    message: "shutting down".to_string(),
                })?;
                break;
            }
        }
    }

    if let Some(task) = state.event_task.take() {
        task.abort();
    }
    Ok(exit_code)
}

fn native_capabilities() -> ClientCapabilities {
    ClientCapabilities {
        server_requests: Some(vec![
            ServerRequestType::Approval,
            ServerRequestType::ClientTool,
            ServerRequestType::UserInput,
            ServerRequestType::ToolRetry,
        ]),
        utility_operations: Some(vec![
            UtilityOperation::CommandExec,
            UtilityOperation::FileSearch,
            UtilityOperation::FileRead,
            UtilityOperation::FileWatch,
        ]),
        raw_agent_events: Some(true),
        transcript_grade: Some(crate::transcript::TranscriptGrade::Delta),
    }
}

fn protocol_error(request_id: Option<String>, message: impl Into<String>) -> Result<()> {
    emit(&FromAgentMessage::Error {
        request_id,
        message: message.into(),
        fatal: false,
        error_type: Some(HeadlessErrorType::Protocol),
    })
}

fn client_content_to_agent_result(
    content: Vec<ClientToolResultContent>,
    is_error: bool,
) -> ToolResult {
    let output = content
        .into_iter()
        .map(|item| match item {
            ClientToolResultContent::Text { text } => text,
            ClientToolResultContent::Image { data, mime_type } => {
                format!("data:{mime_type};base64,{data}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    ToolResult {
        success: !is_error,
        error: is_error.then(|| output.clone()),
        output,
        details: None,
    }
}

fn server_request_resolution(
    request_type: ServerRequestType,
    approved: Option<bool>,
    result: Option<&HeadlessToolResult>,
    is_error: Option<bool>,
    decision: Option<ToolRetryDecisionAction>,
) -> ServerRequestResolutionStatus {
    if let Some(action) = decision {
        return match action {
            ToolRetryDecisionAction::Retry => ServerRequestResolutionStatus::Retried,
            ToolRetryDecisionAction::Skip => ServerRequestResolutionStatus::Skipped,
            ToolRetryDecisionAction::Abort => ServerRequestResolutionStatus::Aborted,
        };
    }
    if approved == Some(false) {
        return ServerRequestResolutionStatus::Denied;
    }
    if is_error == Some(true) || result.is_some_and(|value| !value.success) {
        return ServerRequestResolutionStatus::Failed;
    }
    match request_type {
        ServerRequestType::Approval => ServerRequestResolutionStatus::Approved,
        ServerRequestType::ClientTool => ServerRequestResolutionStatus::Completed,
        ServerRequestType::UserInput => ServerRequestResolutionStatus::Answered,
        ServerRequestType::ToolRetry => ServerRequestResolutionStatus::Retried,
    }
}

async fn start_utility_command(
    options: UtilityCommandOptions,
) -> Result<mpsc::UnboundedSender<UtilityCommandControl>> {
    let UtilityCommandOptions {
        command_id,
        command,
        cwd,
        env,
        shell_mode,
        terminal_mode,
        allow_stdin,
        columns,
        rows,
    } = options;
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        anyhow::bail!("working directory does not exist: {cwd}");
    }
    let mut process = match shell_mode {
        UtilityCommandShellMode::Shell => {
            #[cfg(windows)]
            let process = {
                let mut process = Command::new("cmd");
                process.args(["/C", &command]);
                process
            };
            #[cfg(not(windows))]
            let process = {
                let mut process = Command::new("sh");
                process.args(["-lc", &command]);
                process
            };
            process
        }
        UtilityCommandShellMode::Direct => {
            let args = shlex::split(&command).context("parse direct command")?;
            let (program, args) = args.split_first().context("direct command is empty")?;
            let mut process = Command::new(program);
            process.args(args);
            process
        }
    };
    process
        .current_dir(&cwd_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if allow_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    if let Some(env) = env {
        process.envs(env);
    }
    let mut child = process.spawn().context("spawn utility command")?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take();
    emit(&FromAgentMessage::UtilityCommandStarted {
        command_id: command_id.clone(),
        command,
        cwd: Some(cwd),
        shell_mode,
        terminal_mode,
        pid,
        columns,
        rows,
        owner_connection_id: Some("native-local".to_string()),
    })?;
    if let Some(stdout) = stdout {
        spawn_command_reader(command_id.clone(), UtilityCommandStream::Stdout, stdout);
    }
    if let Some(stderr) = stderr {
        spawn_command_reader(command_id.clone(), UtilityCommandStream::Stderr, stderr);
    }
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (success, exit_code, reason) = loop {
            tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(status) => break (status.success(), status.code(), None),
                        Err(err) => break (false, None, Some(format!("wait failed: {err}"))),
                    }
                }
                control = control_rx.recv() => {
                    match control {
                        Some(UtilityCommandControl::Terminate) => {
                            let kill_result = child.kill().await;
                            let status = child.wait().await.ok();
                            break (
                                false,
                                status.and_then(|value| value.code()),
                                kill_result.err().map(|err| format!("terminate failed: {err}"))
                                    .or_else(|| Some("terminated by client".to_string())),
                            );
                        }
                        Some(UtilityCommandControl::Stdin { content, eof }) => {
                            if let Some(writer) = stdin.as_mut() {
                                if writer.write_all(content.as_bytes()).await.is_err() {
                                    stdin = None;
                                } else if eof {
                                    let _ = writer.shutdown().await;
                                    stdin = None;
                                }
                            }
                        }
                        None => {
                            let _ = child.kill().await;
                            let status = child.wait().await.ok();
                            break (false, status.and_then(|value| value.code()), Some("runtime closed".to_string()));
                        }
                    }
                }
            }
        };
        let _ = emit(&FromAgentMessage::UtilityCommandExited {
            command_id,
            success,
            exit_code,
            signal: None,
            reason,
        });
    });
    Ok(control_tx)
}

fn spawn_command_reader<R>(command_id: String, stream: UtilityCommandStream, mut reader: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => {
                    let content = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    let _ = emit(&FromAgentMessage::UtilityCommandOutput {
                        command_id: command_id.clone(),
                        stream,
                        content,
                    });
                }
                Err(_) => break,
            }
        }
    });
}

fn utility_file_search(
    cwd: &str,
    query: &str,
    limit: usize,
) -> Result<(Vec<UtilityFileSearchMatch>, bool)> {
    let root = Path::new(cwd);
    if !root.is_dir() {
        anyhow::bail!("search directory does not exist: {cwd}");
    }
    let scan_limit = limit.saturating_mul(100).clamp(1_000, 100_000);
    let files = crate::files::get_workspace_files(root, scan_limit);
    let total_files = files.len();
    let result = crate::files::FileSearch::new(files)
        .max_results(limit.max(1))
        .search(query);
    let results = result
        .matches
        .into_iter()
        .map(|item| UtilityFileSearchMatch {
            path: item.file.relative_path,
            score: item.score,
        })
        .collect();
    Ok((results, total_files >= scan_limit))
}

struct FileReadResult {
    relative_path: String,
    content: String,
    start_line: u32,
    end_line: u32,
    total_lines: u32,
    truncated: bool,
}

async fn utility_file_read(
    cwd: &str,
    path: &str,
    offset: u32,
    limit: u32,
) -> Result<FileReadResult> {
    let root = tokio::fs::canonicalize(cwd)
        .await
        .with_context(|| format!("resolve read directory {cwd}"))?;
    let requested = Path::new(path);
    let target = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let target = tokio::fs::canonicalize(&target)
        .await
        .with_context(|| format!("resolve file {}", target.display()))?;
    if !target.starts_with(&root) {
        anyhow::bail!("file escapes the requested workspace");
    }
    let bytes = tokio::fs::read(&target)
        .await
        .context("read workspace file")?;
    let text = String::from_utf8(bytes).context("workspace file is not UTF-8")?;
    let lines = text.lines().collect::<Vec<_>>();
    let total_lines = u32::try_from(lines.len()).unwrap_or(u32::MAX);
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(lines.len());
    let take = usize::try_from(limit).unwrap_or(usize::MAX);
    let end = start.saturating_add(take).min(lines.len());
    let relative_path = target
        .strip_prefix(&root)
        .unwrap_or(&target)
        .to_string_lossy()
        .into_owned();
    Ok(FileReadResult {
        relative_path,
        content: lines[start..end].join("\n"),
        start_line: u32::try_from(start.saturating_add(1)).unwrap_or(u32::MAX),
        end_line: u32::try_from(end).unwrap_or(u32::MAX),
        total_lines,
        truncated: end < lines.len(),
    })
}

type WatchSnapshot = HashMap<String, (u64, u64)>;

fn start_file_watch(
    watch_id: String,
    root_dir: String,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    debounce_ms: u32,
) -> Result<tokio::task::JoinHandle<()>> {
    let root = PathBuf::from(&root_dir);
    if !root.is_dir() {
        anyhow::bail!("watch directory does not exist: {root_dir}");
    }
    let includes = compile_patterns(include_patterns.as_deref())?;
    let excludes = compile_patterns(exclude_patterns.as_deref())?;
    let mut previous = watch_snapshot(&root, &includes, &excludes);
    Ok(tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(u64::from(
            debounce_ms.max(25),
        )));
        interval.tick().await;
        loop {
            interval.tick().await;
            let current = watch_snapshot(&root, &includes, &excludes);
            for (path, stamp) in &current {
                let change_type = match previous.get(path) {
                    None => Some(crate::headless::messages::UtilityFileWatchChangeType::Create),
                    Some(previous_stamp) if previous_stamp != stamp => {
                        Some(crate::headless::messages::UtilityFileWatchChangeType::Modify)
                    }
                    _ => None,
                };
                if let Some(change_type) = change_type {
                    emit_watch_event(&watch_id, &root, path, change_type);
                }
            }
            for path in previous.keys().filter(|path| !current.contains_key(*path)) {
                emit_watch_event(
                    &watch_id,
                    &root,
                    path,
                    crate::headless::messages::UtilityFileWatchChangeType::Delete,
                );
            }
            previous = current;
        }
    }))
}

fn compile_patterns(patterns: Option<&[String]>) -> Result<Vec<glob::Pattern>> {
    patterns
        .unwrap_or(&[])
        .iter()
        .map(|pattern| {
            glob::Pattern::new(pattern).with_context(|| format!("invalid glob {pattern}"))
        })
        .collect()
}

fn watch_snapshot(
    root: &Path,
    includes: &[glob::Pattern],
    excludes: &[glob::Pattern],
) -> WatchSnapshot {
    crate::files::get_workspace_files(root, 100_000)
        .into_iter()
        .filter_map(|file| {
            let relative = file.relative_path;
            let included =
                includes.is_empty() || includes.iter().any(|pattern| pattern.matches(&relative));
            let excluded = excludes.iter().any(|pattern| pattern.matches(&relative));
            if !included || excluded {
                return None;
            }
            let metadata = std::fs::metadata(root.join(&relative)).ok()?;
            let modified = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some((relative, (modified, metadata.len())))
        })
        .collect()
}

fn emit_watch_event(
    watch_id: &str,
    root: &Path,
    relative_path: &str,
    change_type: crate::headless::messages::UtilityFileWatchChangeType,
) {
    let _ = emit(&FromAgentMessage::UtilityFileWatchEvent {
        watch_id: watch_id.to_string(),
        change_type,
        path: root.join(relative_path).to_string_lossy().into_owned(),
        relative_path: relative_path.to_string(),
        timestamp: unix_timestamp_ms(),
        is_directory: false,
    });
}

fn unix_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
            meta.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .response_chunks
                .clear();
            emit(&FromAgentMessage::ResponseStart { response_id })?;
        }
        FromAgent::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } => {
            let grade = {
                let mut meta = meta
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                meta.record_response_chunk(&content, is_thinking)
            };
            if grade == crate::transcript::TranscriptGrade::Delta {
                emit(&FromAgentMessage::ResponseChunk {
                    response_id,
                    content,
                    is_thinking,
                })?;
            }
        }
        FromAgent::ResponseEnd { response_id, usage } => {
            let (grade, content) = {
                let mut meta = meta
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let content = coalesce_response_chunks(&mut meta.response_chunks);
                (meta.transcript_grade, content)
            };
            if matches!(
                grade,
                crate::transcript::TranscriptGrade::Turn
                    | crate::transcript::TranscriptGrade::Block
            ) && !content.is_empty()
            {
                emit(&FromAgentMessage::ResponseChunk {
                    response_id: response_id.clone(),
                    content,
                    is_thinking: false,
                })?;
            }
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
            ..
        } => {
            let message = FromAgentMessage::ToolCall {
                call_id: call_id.clone(),
                tool_execution_id: None,
                tool,
                args,
                requires_approval,
            };
            if requires_approval {
                emit(&message)?;
            } else {
                emit_transcript(meta, crate::transcript::TranscriptLevel::Block, &message)?;
            }

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
            emit_transcript(
                meta,
                crate::transcript::TranscriptLevel::Block,
                &FromAgentMessage::ToolStart { call_id },
            )?;
        }
        FromAgent::ToolOutput { call_id, content } => {
            emit_transcript(
                meta,
                crate::transcript::TranscriptLevel::Delta,
                &FromAgentMessage::ToolOutput { call_id, content },
            )?;
        }
        FromAgent::ToolEnd {
            call_id,
            success,
            receipt,
            ..
        } => {
            emit_transcript(
                meta,
                crate::transcript::TranscriptLevel::Block,
                &FromAgentMessage::ToolEnd {
                    call_id,
                    tool_execution_id: None,
                    success,
                    tool: None,
                    details: None,
                    receipt,
                },
            )?;
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
            emit_transcript(
                meta,
                crate::transcript::TranscriptLevel::Delta,
                &FromAgentMessage::Status { message },
            )?;
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
            emit_transcript(
                meta,
                crate::transcript::TranscriptLevel::Block,
                &FromAgentMessage::Compaction {
                    summary,
                    first_kept_entry_index,
                    tokens_before,
                    auto,
                    custom_instructions,
                    timestamp,
                },
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn coalesce_response_chunks(chunks: &mut Vec<(String, bool)>) -> String {
    chunks
        .drain(..)
        .filter(|(_, is_thinking)| !is_thinking)
        .map(|(content, _)| content)
        .collect()
}

fn emit_transcript(
    meta: &Arc<Mutex<RuntimeMeta>>,
    level: crate::transcript::TranscriptLevel,
    message: &FromAgentMessage,
) -> Result<()> {
    let grade = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .transcript_grade;
    if grade.includes(level) {
        emit(message)?;
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
        receipt: None,
    });
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_capabilities_match_implemented_request_surface() {
        let capabilities = native_capabilities();
        assert_eq!(
            capabilities.utility_operations,
            Some(vec![
                UtilityOperation::CommandExec,
                UtilityOperation::FileSearch,
                UtilityOperation::FileRead,
                UtilityOperation::FileWatch,
            ])
        );
        assert_eq!(capabilities.raw_agent_events, Some(true));
        assert_eq!(
            capabilities.transcript_grade,
            Some(crate::transcript::TranscriptGrade::Delta)
        );
        assert_eq!(capabilities.server_requests.as_ref().map(Vec::len), Some(4));
    }

    #[test]
    fn coarser_transcripts_coalesce_text_and_drop_thinking() {
        let mut chunks = vec![
            ("reasoning".to_string(), true),
            ("hello ".to_string(), false),
            ("world".to_string(), false),
        ];
        assert_eq!(coalesce_response_chunks(&mut chunks), "hello world");
        assert!(chunks.is_empty());
    }

    #[test]
    fn delta_transcript_does_not_buffer_emitted_response_chunks() {
        let mut meta = RuntimeMeta {
            transcript_grade: crate::transcript::TranscriptGrade::Delta,
            ..RuntimeMeta::default()
        };

        for _ in 0..10_000 {
            assert_eq!(
                meta.record_response_chunk("already emitted", false),
                crate::transcript::TranscriptGrade::Delta,
            );
        }

        assert!(meta.response_chunks.is_empty());
    }

    #[test]
    fn client_tool_content_preserves_text_and_images() {
        let result = client_content_to_agent_result(
            vec![
                ClientToolResultContent::Text {
                    text: "done".to_string(),
                },
                ClientToolResultContent::Image {
                    data: "AAAA".to_string(),
                    mime_type: "image/png".to_string(),
                },
            ],
            false,
        );
        assert!(result.success);
        assert_eq!(result.output, "done\ndata:image/png;base64,AAAA");
        assert_eq!(result.error, None);
    }

    #[test]
    fn request_resolution_maps_each_response_shape() {
        assert_eq!(
            server_request_resolution(ServerRequestType::Approval, Some(false), None, None, None,),
            ServerRequestResolutionStatus::Denied
        );
        assert_eq!(
            server_request_resolution(
                ServerRequestType::ToolRetry,
                None,
                None,
                None,
                Some(ToolRetryDecisionAction::Skip),
            ),
            ServerRequestResolutionStatus::Skipped
        );
    }

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

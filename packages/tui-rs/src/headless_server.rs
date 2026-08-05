//! Native headless **server** — Rust agent speaks the headless protocol on stdio.
//!
//! Replaces the TypeScript `runHeadlessMode` agent path. Clients (including the
//! native TUI headless client, IDE bridges, and tests) send `ToAgentMessage`
//! lines on stdin and receive `FromAgentMessage` lines on stdout.
//!
//! The provider client is created before the first `Ready` message so clients
//! never admit a runtime whose configured model or credential is invalid.
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

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::agent::{
    CredentialVault, ExecutionSource, FromAgent, NativeAgent, NativeAgentConfig, PromptKind,
    ToolResponseConsumption, ToolResponseMessage, ToolResult,
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
    /// Controller-owned execution ids awaiting a native terminal event.
    tool_execution_ids: HashMap<String, String>,
    /// Governed executions for which this connection already accepted a decision.
    decided_tool_execution_ids: HashSet<String>,
    /// Tool call ids currently awaiting a raw client decision.
    pending_tool_calls: HashSet<String>,
    transcript_grade: crate::transcript::TranscriptGrade,
    response_chunks: Vec<(String, bool)>,
    /// Detached consumption-receipt acknowledgement tasks. Shutdown drains
    /// these so a dropped receipt's protocol error and rollback are emitted
    /// before the process exits. Shared behind an `Arc` because `RuntimeMeta`
    /// is `Clone` and every clone must observe the same registry.
    receipt_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl RuntimeMeta {
    fn reserve_tool_decision(&mut self, tool_execution_id: Option<&str>) -> bool {
        let Some(tool_execution_id) = tool_execution_id else {
            // Legacy, ungoverned clients have no durable id to deduplicate.
            return true;
        };
        self.decided_tool_execution_ids
            .insert(tool_execution_id.to_string())
    }

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
    /// Semantic provider history is meaningful only after an Init boundary.
    init_applied: bool,
    meta: Arc<Mutex<RuntimeMeta>>,
    agent: Option<NativeAgent>,
    tool_tx: Option<mpsc::UnboundedSender<ToolResponseMessage>>,
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
    fn new(model_override: Option<String>) -> Self {
        let model = resolve_headless_model(model_override, &std::env::vars().collect());
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
            init_applied: false,
            meta: Arc::new(Mutex::new(RuntimeMeta {
                session_id,
                approval_mode: None,
                tool_execution_ids: HashMap::new(),
                decided_tool_execution_ids: HashSet::new(),
                pending_tool_calls: HashSet::new(),
                transcript_grade: crate::transcript::TranscriptGrade::Delta,
                response_chunks: Vec::new(),
                receipt_tasks: Arc::new(Mutex::new(Vec::new())),
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
            let started = Instant::now();
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
                // The headless server has no sandbox-policy resolution of
                // its own today (unlike the interactive TUI's
                // `config::resolve_interactive_sandbox_policy` or print
                // mode's `PrintModeOptions::sandbox_policy`); preserve that
                // status quo explicitly rather than silently expanding this
                // PR's scope to headless sandboxing.
                sandbox_policy: None,
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
            let reported_model = self.model.clone();
            let routed_provider = managed_provider_override();

            // Hold native events until the validated Ready boundary has been
            // written. In particular, SessionInfo must never race ahead of
            // the first protocol event.
            let session_id = self.ensure_session_id();
            let git_branch = git::current_branch(Path::new(&self.cwd));
            let (model, provider) = reported_identity(
                &self.model,
                infer_provider_label(&self.model),
                managed_provider_override().as_deref(),
            );
            tracing::info!(
                target: "maestro.model_binding",
                event = "maestro_model_binding_ready",
                session_id = %session_id,
                configured_model = %self.model,
                configured_provider = infer_provider_label(&self.model),
                reported_model = %model,
                reported_provider = %provider,
                routed_provider = managed_provider_override().as_deref().unwrap_or(""),
                binding_mode = model_binding_mode(&self.model),
                duration_ms = started.elapsed().as_millis() as u64,
            );
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model,
                provider,
                session_id: Some(session_id),
            })?;
            agent.send_session_info(&self.cwd, self.session_id(), git_branch);
            let event_task = tokio::spawn(async move {
                while let Some(msg) = event_rx.recv().await {
                    if let Err(err) = handle_agent_event(
                        msg,
                        &meta_bg,
                        &tool_tx_bg,
                        &reported_model,
                        routed_provider.as_deref(),
                    )
                    .await
                    {
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
        }
        Ok(self.agent.as_ref().expect("agent just created"))
    }

    fn agent_mut(&mut self) -> Result<&NativeAgent> {
        self.ensure_agent()
    }
}

async fn submit_prompt_with_kind(
    state: &mut HeadlessState,
    content: String,
    attachments: Option<Vec<String>>,
    kind: PromptKind,
) -> Result<()> {
    let atts = attachments.unwrap_or_default();
    match state.agent_mut() {
        Ok(agent) => {
            if let Err(err) = agent.prompt_with_kind(content, atts, kind, None).await {
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
    Ok(())
}

/// Run the native headless protocol server until EOF or shutdown.
pub async fn run_headless_server(model_override: Option<String>) -> Result<i32> {
    let mut state = HeadlessState::new(model_override);
    tracing::info!(
        target: "maestro.model_binding",
        event = "maestro_model_binding_selected",
        session_id = ?state.session_id(),
        configured_model = %state.model,
        configured_provider = infer_provider_label(&state.model),
        routed_provider = managed_provider_override().as_deref().unwrap_or(""),
        binding_mode = model_binding_mode(&state.model),
    );

    // Provider construction resolves the exact model route and validates its
    // credential before `ensure_agent` emits the first Ready boundary.
    state.ensure_agent()?;

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
                // A client this build cannot serve must not get a session: the
                // error is fatal and ends the stdio loop, so a client that
                // ignores it cannot go on to Init and prompt anyway.
                if !crate::headless::messages::client_protocol_version_is_supported(
                    protocol_version.as_deref(),
                ) {
                    emit(&FromAgentMessage::Error {
                        request_id: None,
                        message:
                            crate::headless::messages::unsupported_client_protocol_version_message(
                                protocol_version.as_deref().unwrap_or_default(),
                            ),
                        fatal: true,
                        error_type: Some(HeadlessErrorType::Protocol),
                    })?;
                    break;
                }
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
                state.init_applied = true;
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
            ToAgentMessage::RestoreConversation {
                protocol_version,
                messages,
            } => {
                if !state.init_applied {
                    protocol_error(None, "semantic conversation restore requires a prior init")?;
                    continue;
                }
                if protocol_version != crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL {
                    protocol_error(
                        None,
                        format!(
                            "unsupported semantic conversation protocol version: {protocol_version}"
                        ),
                    )?;
                    continue;
                }
                match state.agent_mut() {
                    Ok(agent) => agent.replace_history(messages),
                    Err(error) => {
                        protocol_error(
                            None,
                            format!("failed to restore semantic conversation: {error:#}"),
                        )?;
                    }
                }
            }
            ToAgentMessage::Prompt {
                content,
                attachments,
            } => {
                submit_prompt_with_kind(&mut state, content, attachments, PromptKind::Prompt)
                    .await?;
            }
            ToAgentMessage::Steer {
                content,
                attachments,
            } => {
                submit_prompt_with_kind(&mut state, content, attachments, PromptKind::Steer)
                    .await?;
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
                tool_execution_id,
                approved,
                result,
            } => {
                let Some(tool_tx) = state.tool_tx.as_ref() else {
                    protocol_error(Some(call_id), "no pending native tool request")?;
                    continue;
                };
                match prepare_tool_response(
                    &state.meta,
                    call_id.clone(),
                    tool_execution_id,
                    approved,
                    result,
                ) {
                    Ok(accepted) => {
                        match dispatch_accepted_tool_response(
                            &state.meta,
                            tool_tx,
                            accepted,
                            call_id.clone(),
                        ) {
                            Ok(()) => {}
                            Err(message) => protocol_error(Some(call_id), message)?,
                        }
                    }
                    Err(message) => protocol_error(Some(call_id), message)?,
                }
            }
            ToAgentMessage::ClientToolResult {
                call_id,
                content,
                is_error,
            } => {
                let Some(tool_tx) = state.tool_tx.as_ref() else {
                    protocol_error(Some(call_id), "no pending native client-tool request")?;
                    continue;
                };
                match prepare_client_tool_result(&state.meta, call_id.clone(), content, is_error) {
                    Ok(accepted) => {
                        match dispatch_accepted_tool_response(
                            &state.meta,
                            tool_tx,
                            accepted,
                            call_id.clone(),
                        ) {
                            Ok(()) => {}
                            Err(message) => protocol_error(Some(call_id), message)?,
                        }
                    }
                    Err(message) => protocol_error(Some(call_id), message)?,
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
                let response_queued = if let Some(tool_tx) = state.tool_tx.as_ref() {
                    let approved = approved.unwrap_or(!matches!(
                        resolution,
                        ServerRequestResolutionStatus::Denied
                            | ServerRequestResolutionStatus::Failed
                            | ServerRequestResolutionStatus::Skipped
                            | ServerRequestResolutionStatus::Aborted
                    ));
                    send_tool_response_with_consumption_ack(
                        &state.meta,
                        tool_tx,
                        (
                            request_id.clone(),
                            approved,
                            agent_result,
                            ExecutionSource::RemoteClient,
                            None,
                        ),
                        request_id.clone(),
                    )
                } else {
                    false
                };
                if !response_queued {
                    protocol_error(
                        Some(request_id),
                        "native server-request response channel is closed",
                    )?;
                    continue;
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

    if let Some(agent) = state.agent.take() {
        agent.shutdown().await;
    }
    if let Some(task) = state.event_task.take() {
        let _ = task.await;
    }
    // The agent shutdown resolved every outstanding consumption receipt
    // (consumed or dropped); drain the acknowledgement tasks so dropped
    // receipts emit their protocol error and rollback before the process
    // exits and before the interrupted terminals are taken.
    for task in take_receipt_tasks(&state.meta) {
        let _ = task.await;
    }
    for message in take_interrupted_tool_terminal_messages(&state.meta) {
        emit(&message)?;
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

fn take_interrupted_tool_terminal_messages(
    meta: &Arc<Mutex<RuntimeMeta>>,
) -> Vec<FromAgentMessage> {
    let mut pending = {
        let mut meta = meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        meta.pending_tool_calls.clear();
        meta.tool_execution_ids.drain().collect::<Vec<_>>()
    };
    pending.sort_by(|(left, _), (right, _)| left.cmp(right));
    pending
        .into_iter()
        .map(|(call_id, tool_execution_id)| FromAgentMessage::ToolEnd {
            call_id,
            tool_execution_id: Some(tool_execution_id),
            success: false,
            tool: None,
            details: Some(serde_json::json!({
                "reason": "interrupted_before_tool_completion"
            })),
            receipt: None,
        })
        .collect()
}

async fn handle_agent_event(
    msg: FromAgent,
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<ToolResponseMessage>,
    configured_model: &str,
    routed_provider: Option<&str>,
) -> Result<()> {
    match msg {
        FromAgent::ConversationSnapshot {
            protocol_version,
            messages,
        } => {
            emit(&FromAgentMessage::ConversationSnapshot {
                protocol_version,
                messages,
            })?;
        }
        FromAgent::Ready { model, provider } => {
            let session_id = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .session_id
                .clone();
            let (native_model, native_provider, model, provider) =
                observed_ready_identity(&model, &provider, routed_provider);
            tracing::info!(
                target: "maestro.model_binding",
                event = "maestro_model_binding_observed",
                session_id = ?session_id,
                configured_model = %configured_model,
                native_model = %native_model,
                native_provider = %native_provider,
                reported_model = %model,
                reported_provider = %provider,
                routed_provider = routed_provider.unwrap_or(""),
                binding_mode = model_binding_mode(configured_model),
            );
            emit(&FromAgentMessage::Ready {
                protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                model,
                provider,
                session_id,
            })?;
        }
        FromAgent::ResponseStart { response_id } => {
            let session_id = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .session_id
                .clone();
            tracing::debug!(
                target: "maestro.llm",
                event = "maestro_response_started",
                session_id = ?session_id,
                response_id = %response_id,
            );
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
            let session_id = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .session_id
                .clone();
            tracing::info!(
                target: "maestro.llm",
                event = "maestro_response_completed",
                session_id = ?session_id,
                response_id = %response_id,
                usage_present = usage.is_some(),
                configured_model = %configured_model,
                routed_provider = routed_provider.unwrap_or(""),
            );
            for message in take_interrupted_tool_terminal_messages(meta) {
                emit(&message)?;
            }
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
                usage: usage
                    .map(|usage| to_headless_usage(usage, configured_model, routed_provider)),
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
            // Register an unresolved client decision before exposing the call.
            // A raw client can respond immediately after observing ToolCall.
            let immediate_approval = {
                let mut meta = meta
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let immediate = resolve_tool_approval(requires_approval, meta.approval_mode);
                if requires_approval && immediate.is_none() {
                    meta.pending_tool_calls.insert(call_id.clone());
                }
                immediate
            };
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
            if let Some(approved) = immediate_approval {
                let _ =
                    tool_tx.send((call_id, approved, None, ExecutionSource::RemoteClient, None));
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
            let tool_execution_id = {
                let mut meta = meta
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                meta.pending_tool_calls.remove(&call_id);
                meta.tool_execution_ids.remove(&call_id)
            };
            let terminal = FromAgentMessage::ToolEnd {
                call_id,
                tool_execution_id: tool_execution_id.clone(),
                success,
                tool: None,
                details: None,
                receipt,
            };
            if tool_execution_id.is_some() {
                emit(&terminal)?;
            } else {
                emit_transcript(meta, crate::transcript::TranscriptLevel::Block, &terminal)?;
            }
        }
        FromAgent::Error { message, fatal } => {
            let session_id = meta
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .session_id
                .clone();
            tracing::warn!(
                target: "maestro.llm",
                event = "maestro_response_failed",
                session_id = ?session_id,
                fatal,
                error_kind = if fatal { "fatal" } else { "transient" },
                configured_model = %configured_model,
                routed_provider = routed_provider.unwrap_or(""),
            );
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

fn to_headless_usage(
    usage: crate::agent::TokenUsage,
    configured_model: &str,
    routed_provider: Option<&str>,
) -> HeadlessTokenUsage {
    let (model, provider) = reported_identity(
        configured_model,
        infer_provider_label(configured_model),
        routed_provider,
    );
    HeadlessTokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        cost: usage.cost,
        total_tokens: Some(usage.input_tokens + usage.output_tokens),
        model_id: Some(model),
        provider: Some(provider),
    }
}

fn managed_provider_override() -> Option<String> {
    std::env::var("MAESTRO_EVALOPS_PROVIDER")
        .ok()
        .map(|provider| provider.trim().to_string())
        .filter(|provider| !provider.is_empty())
}

pub(crate) fn resolve_headless_model(
    model_override: Option<String>,
    env: &HashMap<String, String>,
) -> String {
    model_override
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            ["MAESTRO_MODEL", "MAESTRO_DEFAULT_MODEL"]
                .into_iter()
                .filter_map(|key| env.get(key))
                .map(String::as_str)
                .map(str::trim)
                .find(|model| !model.is_empty())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "gpt-5.5".to_string())
}

/// Return the identity of the provider/model selected by the hosted caller.
/// Managed model prefixes remain part of the advertised binding so the hosted
/// parent can compare Ready against the exact model it passed to the child.
fn reported_identity(
    model: &str,
    fallback_provider: &str,
    routed_provider: Option<&str>,
) -> (String, String) {
    let model = model.trim();
    let managed = ["evalops/", "maestro-managed/"].into_iter().any(|prefix| {
        model
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
    });
    let inferred_provider = infer_provider_label(model);
    (
        model.to_string(),
        if managed {
            routed_provider
                .filter(|provider| !provider.trim().is_empty())
                .unwrap_or(inferred_provider)
                .to_string()
        } else if inferred_provider == "OpenRouter" {
            inferred_provider.to_string()
        } else {
            fallback_provider.to_string()
        },
    )
}

fn observed_ready_identity(
    native_model: &str,
    native_provider: &str,
    routed_provider: Option<&str>,
) -> (String, String, String, String) {
    let (reported_model, reported_provider) =
        reported_identity(native_model, native_provider, routed_provider);
    (
        native_model.to_string(),
        native_provider.to_string(),
        reported_model,
        reported_provider,
    )
}

fn model_binding_mode(model: &str) -> &'static str {
    let model = model.trim();
    if ["evalops/", "maestro-managed/"].into_iter().any(|prefix| {
        model
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
    }) {
        "managed_normalized"
    } else {
        "native"
    }
}

fn infer_provider_label(model: &str) -> &'static str {
    let m = model.to_lowercase();
    if m.split_once('/')
        .is_some_and(|(provider, _)| provider == "openrouter")
    {
        "OpenRouter"
    } else if m.contains("claude") || m.contains("anthropic") {
        "Anthropic"
    } else if m.contains("gemini") || m.contains("google") {
        "Google"
    } else {
        "OpenAI"
    }
}

fn env_session_id() -> Option<String> {
    normalize_session_id(std::env::var("MAESTRO_SESSION_ID").ok().as_deref())
}

/// Trim and empty-filter a raw `MAESTRO_SESSION_ID` value. Split out of
/// `env_session_id` so the trimming/filtering behavior is testable without
/// mutating the process environment (`std::env::set_var`/`remove_var` are
/// unsound to call from a test when other tests may be reading or writing
/// the environment concurrently on the same `cargo test` process).
fn normalize_session_id(value: Option<&str>) -> Option<String> {
    value
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

#[derive(Debug)]
struct AcceptedToolResponse {
    messages: Vec<FromAgentMessage>,
    agent_response: ToolResponseMessage,
    rollback: ToolResponseRollback,
}

#[derive(Clone, Debug)]
struct ToolResponseRollback {
    call_id: String,
    tool_execution_id: Option<String>,
}

fn dispatch_accepted_tool_response(
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<ToolResponseMessage>,
    accepted: AcceptedToolResponse,
    request_id: String,
) -> std::result::Result<(), String> {
    dispatch_accepted_tool_response_with(
        meta,
        tool_tx,
        accepted,
        request_id,
        |message| emit(message).map_err(|error| format!("emit tool lifecycle: {error:#}")),
        |request_id, outcome, _dropped| {
            let _ = emit(&response_consumption_message(request_id, outcome));
        },
    )
}

fn dispatch_accepted_tool_response_with<Emit, Acknowledge>(
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<ToolResponseMessage>,
    accepted: AcceptedToolResponse,
    request_id: String,
    mut emit_lifecycle: Emit,
    acknowledge: Acknowledge,
) -> std::result::Result<(), String>
where
    Emit: FnMut(&FromAgentMessage) -> std::result::Result<(), String>,
    Acknowledge: FnOnce(String, ToolResponseConsumption, bool) + Send + 'static,
{
    for message in &accepted.messages {
        if let Err(error) = emit_lifecycle(message) {
            rollback_accepted_tool_response(meta, accepted.rollback);
            return Err(error);
        }
    }
    // A queued response can still be rejected by the consumption receipt (for
    // example when the call is cancelled before native consumption). Restore
    // the pending decision before surfacing the receipt so a corrected retry
    // is not refused as "not awaiting a decision". A dropped receipt means
    // the native side is gone: keep the execution binding so the shutdown
    // cleanup can still emit the interrupted ToolEnd that closes the exposed
    // tool lifecycle.
    let rejection_rollback = accepted.rollback.clone();
    let rejection_meta = Arc::clone(meta);
    if send_tool_response_with_consumption_ack_using(
        meta,
        tool_tx,
        accepted.agent_response,
        request_id,
        move |request_id, outcome, dropped| {
            if matches!(outcome, ToolResponseConsumption::Rejected { .. }) {
                if dropped {
                    rollback_dropped_tool_response(&rejection_meta, rejection_rollback);
                } else {
                    rollback_accepted_tool_response(&rejection_meta, rejection_rollback);
                }
            }
            acknowledge(request_id, outcome, dropped);
        },
    ) {
        return Ok(());
    }
    rollback_accepted_tool_response(meta, accepted.rollback);
    Err("native tool response channel is closed".to_string())
}

fn rollback_accepted_tool_response(meta: &Arc<Mutex<RuntimeMeta>>, rollback: ToolResponseRollback) {
    let mut meta = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    meta.pending_tool_calls.insert(rollback.call_id.clone());
    meta.tool_execution_ids.remove(&rollback.call_id);
    if let Some(tool_execution_id) = rollback.tool_execution_id {
        meta.decided_tool_execution_ids.remove(&tool_execution_id);
    }
}

/// Rollback for a response whose consumption receipt was dropped: the native
/// side shut down without consuming the queued message. The pending decision
/// and the reserved governed decision are restored like
/// [`rollback_accepted_tool_response`], but the `tool_execution_ids` binding
/// is deliberately preserved so [`take_interrupted_tool_terminal_messages`]
/// can still emit the interrupted `ToolEnd` for the lifecycle that was
/// already exposed to clients.
fn rollback_dropped_tool_response(meta: &Arc<Mutex<RuntimeMeta>>, rollback: ToolResponseRollback) {
    let mut meta = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    meta.pending_tool_calls.insert(rollback.call_id.clone());
    if let Some(tool_execution_id) = rollback.tool_execution_id {
        meta.decided_tool_execution_ids.remove(&tool_execution_id);
    }
}

fn send_tool_response_with_consumption_ack(
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<ToolResponseMessage>,
    response: ToolResponseMessage,
    request_id: String,
) -> bool {
    send_tool_response_with_consumption_ack_using(
        meta,
        tool_tx,
        response,
        request_id,
        |request_id, outcome, _dropped| {
            let _ = emit(&response_consumption_message(request_id, outcome));
        },
    )
}

/// Record a detached consumption-receipt acknowledgement task so shutdown can
/// drain it before the process exits. Completed handles are pruned in place.
fn record_receipt_task(meta: &Arc<Mutex<RuntimeMeta>>, task: tokio::task::JoinHandle<()>) {
    let registry = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .receipt_tasks
        .clone();
    let mut tasks = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tasks.retain(|task| !task.is_finished());
    tasks.push(task);
}

/// Take the outstanding receipt acknowledgement tasks for draining. After the
/// native agent shuts down, every receipt sender is either consumed or
/// dropped, so awaiting these completes promptly and guarantees the dropped
/// receipts' protocol errors and rollbacks are emitted before exit.
fn take_receipt_tasks(meta: &Arc<Mutex<RuntimeMeta>>) -> Vec<tokio::task::JoinHandle<()>> {
    let registry = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .receipt_tasks
        .clone();
    let mut tasks = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::mem::take(&mut *tasks)
}

fn response_consumption_message(
    request_id: String,
    outcome: ToolResponseConsumption,
) -> FromAgentMessage {
    match outcome {
        ToolResponseConsumption::Accepted => FromAgentMessage::ResponseAccepted { request_id },
        ToolResponseConsumption::Rejected { reason } => FromAgentMessage::Error {
            request_id: Some(request_id),
            message: reason,
            fatal: false,
            error_type: Some(HeadlessErrorType::Protocol),
        },
    }
}

fn send_tool_response_with_consumption_ack_using<Acknowledge>(
    meta: &Arc<Mutex<RuntimeMeta>>,
    tool_tx: &mpsc::UnboundedSender<ToolResponseMessage>,
    mut response: ToolResponseMessage,
    request_id: String,
    acknowledge: Acknowledge,
) -> bool
where
    Acknowledge: FnOnce(String, ToolResponseConsumption, bool) + Send + 'static,
{
    let (consumed_tx, consumed_rx) = tokio::sync::oneshot::channel();
    response.4 = Some(consumed_tx);
    if tool_tx.send(response).is_err() {
        return false;
    }
    let task = tokio::spawn(async move {
        // A dropped receipt sender means the native agent shut down or the
        // receiver was dropped before consuming the queued message. Treat it
        // as a rejection so the acknowledgement/rollback path restores the
        // pending decision instead of leaving the request stuck; the flag
        // lets the caller distinguish the dropped case from an explicit
        // rejection.
        let (outcome, dropped) = match consumed_rx.await {
            Ok(outcome) => (outcome, false),
            Err(_) => (
                ToolResponseConsumption::Rejected {
                    reason: "native agent dropped the response before consuming it".to_string(),
                },
                true,
            ),
        };
        acknowledge(request_id, outcome, dropped);
    });
    record_receipt_task(meta, task);
    true
}

fn prepare_tool_response(
    meta: &Arc<Mutex<RuntimeMeta>>,
    call_id: String,
    tool_execution_id: Option<String>,
    approved: bool,
    result: Option<HeadlessToolResult>,
) -> std::result::Result<AcceptedToolResponse, String> {
    let mut meta = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(active_execution_id) = meta.tool_execution_ids.get(&call_id) {
        return Err(format!(
            "tool call {call_id} already has an active decision for execution {active_execution_id}"
        ));
    }
    if !meta.pending_tool_calls.contains(&call_id) {
        return Err(format!("tool call {call_id} is not awaiting a decision"));
    }
    if !meta.reserve_tool_decision(tool_execution_id.as_deref()) {
        return Err(format!(
            "tool execution {} already has a decision",
            tool_execution_id
                .as_deref()
                .expect("only governed decisions can be duplicates")
        ));
    }
    meta.pending_tool_calls.remove(&call_id);

    let agent_result = result.map(headless_tool_result_to_agent);
    // When the client supplies a completed result, surface the full lifecycle.
    // When only an approval is returned, bind the durable id to the native end.
    let messages = if approved {
        if let Some(ref tool_result) = agent_result {
            tool_lifecycle_messages(&call_id, tool_execution_id.as_deref(), None, tool_result)
        } else {
            if let Some(ref tool_execution_id) = tool_execution_id {
                meta.tool_execution_ids
                    .insert(call_id.clone(), tool_execution_id.clone());
            }
            Vec::new()
        }
    } else {
        denied_tool_terminal_message(
            &call_id,
            tool_execution_id.as_deref(),
            agent_result.as_ref(),
        )
        .into_iter()
        .collect()
    };
    drop(meta);

    let rollback = ToolResponseRollback {
        call_id: call_id.clone(),
        tool_execution_id: tool_execution_id.clone(),
    };
    Ok(AcceptedToolResponse {
        messages,
        agent_response: (
            call_id,
            approved,
            agent_result,
            ExecutionSource::RemoteClient,
            None,
        ),
        rollback,
    })
}

fn prepare_client_tool_result(
    meta: &Arc<Mutex<RuntimeMeta>>,
    call_id: String,
    content: Vec<ClientToolResultContent>,
    is_error: bool,
) -> std::result::Result<AcceptedToolResponse, String> {
    let mut meta = meta
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !meta.pending_tool_calls.remove(&call_id) {
        return Err(format!("tool call {call_id} is not awaiting a decision"));
    }
    drop(meta);

    let result = client_content_to_agent_result(content, is_error);
    Ok(AcceptedToolResponse {
        messages: tool_lifecycle_messages(&call_id, None, None, &result),
        agent_response: (
            call_id.clone(),
            true,
            Some(result),
            ExecutionSource::RemoteClient,
            None,
        ),
        rollback: ToolResponseRollback {
            call_id,
            tool_execution_id: None,
        },
    })
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

/// A governed denial never executes natively, so it has no native `ToolEnd`.
/// Emit the correlated terminal failure directly when the controller supplied
/// a durable execution id.
fn denied_tool_terminal_message(
    call_id: &str,
    tool_execution_id: Option<&str>,
    result: Option<&ToolResult>,
) -> Option<FromAgentMessage> {
    Some(FromAgentMessage::ToolEnd {
        call_id: call_id.to_string(),
        tool_execution_id: Some(tool_execution_id?.to_string()),
        success: false,
        tool: None,
        details: result.and_then(|result| result.details.clone()),
        receipt: None,
    })
}

/// Protocol messages for a completed tool run: start → output? → end.
fn tool_lifecycle_messages(
    call_id: &str,
    tool_execution_id: Option<&str>,
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
        tool_execution_id: tool_execution_id.map(str::to_string),
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
    use serde_json::json;

    #[test]
    fn headless_model_resolution_uses_canonical_precedence_without_rewriting_managed_ids() {
        let env = HashMap::from([
            ("MAESTRO_MODEL".to_string(), " evalops/gpt-5.6 ".to_string()),
            (
                "MAESTRO_DEFAULT_MODEL".to_string(),
                "evalops/gpt-5.5".to_string(),
            ),
        ]);

        assert_eq!(
            resolve_headless_model(Some(" maestro-managed/gpt-5.7 ".to_string()), &env),
            "maestro-managed/gpt-5.7"
        );
        assert_eq!(resolve_headless_model(None, &env), "evalops/gpt-5.6");
        assert_eq!(
            resolve_headless_model(
                None,
                &HashMap::from([(
                    "MAESTRO_DEFAULT_MODEL".to_string(),
                    " evalops/gpt-5.5 ".to_string(),
                )]),
            ),
            "evalops/gpt-5.5"
        );
        assert_eq!(resolve_headless_model(None, &HashMap::new()), "gpt-5.5");
    }

    #[test]
    fn managed_headless_identity_reports_the_platform_route() {
        assert_eq!(
            reported_identity("evalops/openai/gpt-5.6", "OpenAI", Some("openrouter"),),
            (
                "evalops/openai/gpt-5.6".to_string(),
                "openrouter".to_string()
            )
        );
        assert_eq!(
            reported_identity(
                "MAESTRO-MANAGED/openai/gpt-5.6",
                "OpenAI",
                Some("openrouter"),
            ),
            (
                "MAESTRO-MANAGED/openai/gpt-5.6".to_string(),
                "openrouter".to_string()
            )
        );

        let usage = to_headless_usage(
            crate::agent::TokenUsage::default(),
            "evalops/openai/gpt-5.6",
            Some("openrouter"),
        );
        assert_eq!(usage.model_id.as_deref(), Some("evalops/openai/gpt-5.6"));
        assert_eq!(usage.provider.as_deref(), Some("openrouter"));
    }

    #[test]
    fn unbound_headless_identity_preserves_native_provider_label() {
        assert_eq!(
            reported_identity("gpt-5.5", "OpenAI", Some("openrouter")),
            ("gpt-5.5".to_string(), "OpenAI".to_string())
        );
    }

    #[test]
    fn openrouter_headless_identity_uses_route_not_nested_vendor() {
        assert_eq!(
            reported_identity("openrouter/anthropic/claude-sonnet-4.5", "OpenAI", None,),
            (
                "openrouter/anthropic/claude-sonnet-4.5".to_string(),
                "OpenRouter".to_string(),
            )
        );
        assert_eq!(
            reported_identity("openrouter/google/gemini-2.5-pro", "OpenAI", None,).1,
            "OpenRouter"
        );
        assert_eq!(
            reported_identity("openrouter/meta-llama/llama-4-maverick", "OpenAI", None,).1,
            "OpenRouter"
        );
    }

    #[test]
    fn observed_ready_identity_preserves_native_values_before_normalizing_route() {
        assert_eq!(
            observed_ready_identity("evalops/openai/gpt-5.6", "OpenAI", Some("openrouter"),),
            (
                "evalops/openai/gpt-5.6".to_string(),
                "OpenAI".to_string(),
                "evalops/openai/gpt-5.6".to_string(),
                "openrouter".to_string(),
            )
        );
    }

    #[tokio::test]
    async fn pod_shaped_managed_default_validates_before_qualified_ready() {
        if std::env::var_os("MAESTRO_HEADLESS_MANAGED_READY_FIXTURE").is_some() {
            assert_eq!(
                run_headless_server(None).await.expect("headless fixture"),
                0
            );
            return;
        }

        let root = tempfile::tempdir().expect("fixture root");
        let token = root.path().join("gateway-token");
        std::fs::write(&token, "tenant-token\n").expect("gateway token");
        let current = std::env::current_exe().expect("current test binary");
        let mut child = std::process::Command::new(current)
            .arg("headless_server::tests::pod_shaped_managed_default_validates_before_qualified_ready")
            .arg("--exact")
            .arg("--nocapture")
            .env("MAESTRO_HEADLESS_MANAGED_READY_FIXTURE", "1")
            .env_remove("MAESTRO_MODEL")
            .env_remove("OPENAI_API_KEY")
            .env("MAESTRO_DEFAULT_MODEL", "evalops/gpt-5.5")
            .env("MAESTRO_EVALOPS_ACCESS_TOKEN_FILE", &token)
            .env("MAESTRO_EVALOPS_BASE_URL", "https://gateway.example/v1")
            .env("MAESTRO_EVALOPS_ORG_ID", "org_1")
            .env("MAESTRO_EVALOPS_WORKSPACE_ID", "ws_1")
            .env("MAESTRO_EVALOPS_PROVIDER", "openrouter")
            .env("MAESTRO_EVALOPS_ENVIRONMENT", "production")
            .env("MAESTRO_EVALOPS_CREDENTIAL_NAME", "platform-default")
            .env("MAESTRO_EVALOPS_TEAM_ID", "team_1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn managed headless fixture");
        writeln!(
            child.stdin.take().expect("fixture stdin"),
            "{}",
            json!({"type":"shutdown"})
        )
        .expect("write shutdown");
        let output = child.wait_with_output().expect("headless fixture output");

        assert!(
            output.status.success(),
            "fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let ready = String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .expect("first protocol message");
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["model"], "evalops/gpt-5.5");
        assert_eq!(ready["provider"], "openrouter");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("OPENAI_API_KEY"));
    }

    #[tokio::test]
    async fn steer_message_reaches_codex_as_turn_steer_not_turn_start() {
        if std::env::var_os("MAESTRO_HEADLESS_STEER_FIXTURE").is_some() {
            assert_eq!(
                run_headless_server(None).await.expect("headless fixture"),
                0
            );
            return;
        }

        let root = tempfile::tempdir().expect("fixture root");
        let script = root.path().join("app-server.js");
        let log = root.path().join("app-server.log");
        std::fs::write(
            &script,
            r"const rl=require('readline').createInterface({input:process.stdin});
const fs=require('fs');
const log=process.env.MAESTRO_HEADLESS_STEER_LOG;
function send(x){process.stdout.write(JSON.stringify(x)+'\n')}
rl.on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(x)+'\n');
if(x.method==='initialize'){send({id:x.id,result:{protocolVersion:'2025-01-01',capabilities:{}}})}
else if(x.method==='thread/start'){send({id:x.id,result:{thread:{id:'thread-headless'}}})}
else if(x.method==='turn/start'){send({id:x.id,result:{turn:{id:'turn-active'}}})}
else if(x.method==='turn/steer'){send({id:x.id,result:{turn:{id:'turn-active'}}});setTimeout(()=>send({method:'turn/completed',params:{turnId:'turn-active'}}),10)}
});",
        )
        .expect("app-server script");
        let current = std::env::current_exe().expect("current test binary");
        let mut child = std::process::Command::new(current)
            .arg("headless_server::tests::steer_message_reaches_codex_as_turn_steer_not_turn_start")
            .arg("--exact")
            .arg("--nocapture")
            .env("MAESTRO_HEADLESS_STEER_FIXTURE", "1")
            .env("MAESTRO_HEADLESS_STEER_LOG", &log)
            .env("MAESTRO_MODEL", "openai-codex/gpt-5.5")
            .env("MAESTRO_CODEX_APP_SERVER_COMMAND", "node")
            .env(
                "MAESTRO_CODEX_APP_SERVER_ARGS_JSON",
                serde_json::to_string(&vec![script.display().to_string()])
                    .expect("app-server args"),
            )
            .env("OPENAI_CODEX_TOKEN", "fixture-token")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn headless fixture");
        let mut stdin = child.stdin.take().expect("fixture stdin");
        use std::io::Write as _;
        writeln!(
            stdin,
            "{}",
            json!({"type":"prompt","content":"start work","attachments":null})
        )
        .expect("write prompt");

        let turn_started = std::time::Instant::now();
        while !std::fs::read_to_string(&log)
            .unwrap_or_default()
            .contains(r#""method":"turn/start""#)
        {
            assert!(
                turn_started.elapsed() < std::time::Duration::from_secs(5),
                "headless prompt never reached turn/start: {}",
                std::fs::read_to_string(&log).unwrap_or_default()
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        writeln!(
            stdin,
            "{}",
            json!({"type":"steer","content":"inspect the logs too","attachments":null})
        )
        .expect("write steer");
        let steer_started = std::time::Instant::now();
        while !std::fs::read_to_string(&log)
            .unwrap_or_default()
            .contains(r#""method":"turn/steer""#)
        {
            assert!(
                steer_started.elapsed() < std::time::Duration::from_secs(5),
                "headless steer did not reach turn/steer: {}",
                std::fs::read_to_string(&log).unwrap_or_default()
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        writeln!(stdin, "{}", json!({"type":"shutdown"})).expect("write shutdown");
        drop(stdin);
        let status = child.wait().expect("headless fixture status");
        assert!(status.success(), "headless fixture failed: {status}");

        let requests = std::fs::read_to_string(log).expect("app-server log");
        assert_eq!(requests.matches(r#""method":"turn/start""#).count(), 1);
        assert_eq!(requests.matches(r#""method":"turn/steer""#).count(), 1);
    }

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
        let msgs = tool_lifecycle_messages(
            "call-1",
            Some("tool-execution-1"),
            Some("read".into()),
            &result,
        );
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
                tool_execution_id: Some(tool_execution_id),
                success: true,
                tool: Some(t),
                ..
            } if call_id == "call-1"
                && tool_execution_id == "tool-execution-1"
                && t == "read"
        ));
    }

    #[test]
    fn tool_lifecycle_messages_omit_empty_success_output() {
        let result = ToolResult::success("");
        let msgs = tool_lifecycle_messages("call-2", None, None, &result);
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0], FromAgentMessage::ToolStart { .. }));
        assert!(matches!(
            msgs[1],
            FromAgentMessage::ToolEnd { success: true, .. }
        ));
    }

    #[test]
    fn governed_denial_emits_correlated_terminal_failure() {
        let result = ToolResult::failure("denied").with_details(serde_json::json!({
            "decision": "deny"
        }));
        let message = denied_tool_terminal_message(
            "call-denied",
            Some("tool-execution-denied"),
            Some(&result),
        )
        .expect("governed denial terminal message");

        assert!(matches!(
            message,
            FromAgentMessage::ToolEnd {
                call_id,
                tool_execution_id: Some(tool_execution_id),
                success: false,
                details: Some(details),
                ..
            } if call_id == "call-denied"
                && tool_execution_id == "tool-execution-denied"
                && details["decision"] == "deny"
        ));
        assert!(
            denied_tool_terminal_message("call-local", None, Some(&result)).is_none(),
            "ungoverned denials have no durable execution to correlate"
        );
    }

    #[test]
    fn governed_tool_decisions_are_single_use_at_the_server_boundary() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        let (tool_tx, mut tool_rx) = mpsc::unbounded_channel::<ToolResponseMessage>();

        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("call-1".to_string());
        let accepted = prepare_tool_response(
            &meta,
            "call-1".to_string(),
            Some("execution-1".to_string()),
            true,
            None,
        )
        .expect("first decision accepted");
        assert!(accepted.messages.is_empty());
        assert!(
            tool_rx.try_recv().is_err(),
            "preparing lifecycle output must not deliver the native decision first"
        );
        tool_tx
            .send(accepted.agent_response)
            .expect("deliver first decision after lifecycle output");
        assert!(matches!(
            tool_rx.try_recv(),
            Ok((call_id, true, None, ExecutionSource::RemoteClient, _)) if call_id == "call-1"
        ));

        let error = prepare_tool_response(
            &meta,
            "call-1".to_string(),
            Some("execution-1".to_string()),
            false,
            None,
        )
        .expect_err("approve then deny must be rejected");
        assert!(error.contains("already has"));
        assert!(tool_rx.try_recv().is_err());

        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("call-2".to_string());
        let accepted = prepare_tool_response(
            &meta,
            "call-2".to_string(),
            Some("execution-2".to_string()),
            false,
            None,
        )
        .expect("first denial accepted");
        assert!(matches!(
            accepted.messages.as_slice(),
            [FromAgentMessage::ToolEnd {
                tool_execution_id: Some(tool_execution_id),
                success: false,
                ..
            }] if tool_execution_id == "execution-2"
        ));
        assert!(
            tool_rx.try_recv().is_err(),
            "the server must emit the correlated denial before native delivery"
        );
        tool_tx
            .send(accepted.agent_response)
            .expect("deliver denial after terminal lifecycle");
        assert!(matches!(
            tool_rx.try_recv(),
            Ok((call_id, false, None, ExecutionSource::RemoteClient, _)) if call_id == "call-2"
        ));
        assert!(
            prepare_tool_response(
                &meta,
                "call-2".to_string(),
                Some("execution-2".to_string()),
                true,
                None,
            )
            .is_err(),
            "deny then approve must be rejected"
        );
        assert!(tool_rx.try_recv().is_err());

        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("call-completed".to_string());
        let accepted = prepare_tool_response(
            &meta,
            "call-completed".to_string(),
            Some("execution-completed".to_string()),
            true,
            Some(HeadlessToolResult {
                success: true,
                output: "completed externally".to_string(),
                error: None,
                details: None,
            }),
        )
        .expect("completed client result accepted");
        assert!(matches!(
            accepted.messages.last(),
            Some(FromAgentMessage::ToolEnd {
                tool_execution_id: Some(tool_execution_id),
                success: true,
                ..
            }) if tool_execution_id == "execution-completed"
        ));
        assert!(
            tool_rx.try_recv().is_err(),
            "completed lifecycle must be emitted before native delivery"
        );
        tool_tx
            .send(accepted.agent_response)
            .expect("deliver completed result after lifecycle output");
        assert!(matches!(
            tool_rx.try_recv(),
            Ok((call_id, true, Some(result), ExecutionSource::RemoteClient, _))
                if call_id == "call-completed" && result.success
        ));

        let error = prepare_tool_response(
            &meta,
            "call-1".to_string(),
            Some("execution-3".to_string()),
            true,
            None,
        )
        .expect_err("an active call id must not be rebound to a new execution");
        assert!(error.contains("already has an active decision"));
        assert!(tool_rx.try_recv().is_err());

        meta.lock()
            .expect("runtime metadata")
            .tool_execution_ids
            .remove("call-1")
            .expect("simulate the prior native ToolEnd lifecycle boundary");
        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("call-1".to_string());
        let accepted = prepare_tool_response(
            &meta,
            "call-1".to_string(),
            Some("execution-3".to_string()),
            true,
            None,
        )
        .expect("call id reuse after the prior terminal boundary remains valid");
        tool_tx
            .send(accepted.agent_response)
            .expect("deliver distinct execution decision");
        assert!(matches!(
            tool_rx.try_recv(),
            Ok((call_id, true, None, ExecutionSource::RemoteClient, _)) if call_id == "call-1"
        ));

        for _ in 0..2 {
            meta.lock()
                .expect("runtime metadata")
                .pending_tool_calls
                .insert("legacy-call".to_string());
            let accepted =
                prepare_tool_response(&meta, "legacy-call".to_string(), None, true, None)
                    .expect("a registered legacy decision remains valid");
            tool_tx
                .send(accepted.agent_response)
                .expect("deliver legacy decision");
            assert!(tool_rx.try_recv().is_ok());
        }
    }

    #[test]
    fn governed_tool_response_rejects_an_unmatched_call_without_lifecycle_output() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));

        let error = prepare_tool_response(
            &meta,
            "mistyped-call".to_string(),
            Some("execution-mistyped".to_string()),
            false,
            Some(HeadlessToolResult {
                success: false,
                output: String::new(),
                error: Some("denied".to_string()),
                details: None,
            }),
        )
        .expect_err("unmatched governed response must be rejected");

        assert!(error.contains("not awaiting a decision"));
        let meta = meta.lock().expect("runtime metadata");
        assert!(meta.tool_execution_ids.is_empty());
        assert!(meta.decided_tool_execution_ids.is_empty());
    }

    #[tokio::test]
    async fn native_channel_send_failure_restores_governed_response_for_retry() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("retry-call".to_string());
        let (closed_tx, closed_rx) = mpsc::unbounded_channel();
        drop(closed_rx);
        let accepted = prepare_tool_response(
            &meta,
            "retry-call".to_string(),
            Some("retry-execution".to_string()),
            true,
            None,
        )
        .expect("initial governed response");

        let error =
            dispatch_accepted_tool_response(&meta, &closed_tx, accepted, "retry-call".to_string())
                .expect_err("closed native channel must reject delivery");
        assert!(error.contains("channel is closed"));
        {
            let meta = meta.lock().expect("runtime metadata");
            assert!(meta.pending_tool_calls.contains("retry-call"));
            assert!(!meta.decided_tool_execution_ids.contains("retry-execution"));
            assert!(!meta.tool_execution_ids.contains_key("retry-call"));
        }

        let (retry_tx, mut retry_rx) = mpsc::unbounded_channel();
        let corrected = prepare_tool_response(
            &meta,
            "retry-call".to_string(),
            Some("retry-execution".to_string()),
            true,
            None,
        )
        .expect("corrected governed retry");
        dispatch_accepted_tool_response(&meta, &retry_tx, corrected, "retry-call".to_string())
            .expect("retry reaches native channel");
        assert!(matches!(
            retry_rx.try_recv(),
            Ok((call_id, true, None, ExecutionSource::RemoteClient, _))
                if call_id == "retry-call"
        ));
    }

    #[tokio::test]
    async fn rejected_consumption_receipt_restores_governed_response_for_retry() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("receipt-call".to_string());
        let (tool_tx, mut tool_rx) = mpsc::unbounded_channel();
        let accepted = prepare_tool_response(
            &meta,
            "receipt-call".to_string(),
            Some("receipt-execution".to_string()),
            true,
            None,
        )
        .expect("initial governed response");

        dispatch_accepted_tool_response(&meta, &tool_tx, accepted, "receipt-call".to_string())
            .expect("response reaches native channel");
        let (_, _, _, _, consumed) = tool_rx.recv().await.expect("queued native response");
        consumed
            .expect("queued response carries a consumption receipt sender")
            .send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            })
            .expect("consumption receipt is delivered");

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                {
                    let meta = meta.lock().expect("runtime metadata");
                    if meta.pending_tool_calls.contains("receipt-call")
                        && !meta
                            .decided_tool_execution_ids
                            .contains("receipt-execution")
                        && !meta.tool_execution_ids.contains_key("receipt-call")
                    {
                        break;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("rejected receipt restores the pending decision");

        let corrected = prepare_tool_response(
            &meta,
            "receipt-call".to_string(),
            Some("receipt-execution".to_string()),
            true,
            None,
        )
        .expect("corrected governed retry");
        dispatch_accepted_tool_response(&meta, &tool_tx, corrected, "receipt-call".to_string())
            .expect("retry reaches native channel");
        assert!(matches!(
            tool_rx.try_recv(),
            Ok((call_id, true, None, ExecutionSource::RemoteClient, _))
                if call_id == "receipt-call"
        ));
    }

    #[tokio::test]
    async fn dropped_response_receipt_restores_governed_response_for_retry() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("dropped-call".to_string());
        let (tool_tx, tool_rx) = mpsc::unbounded_channel();
        let accepted = prepare_tool_response(
            &meta,
            "dropped-call".to_string(),
            Some("dropped-execution".to_string()),
            true,
            None,
        )
        .expect("initial governed response");

        dispatch_accepted_tool_response(&meta, &tool_tx, accepted, "dropped-call".to_string())
            .expect("response reaches native channel");
        // Dropping the receiver discards the queued message together with its
        // receipt sender: the native agent never consumed the response.
        drop(tool_rx);

        // Drain the recorded acknowledgement tasks exactly like the shutdown
        // path does, so the rollback is guaranteed to have run without
        // relying on scheduler timing.
        for task in take_receipt_tasks(&meta) {
            task.await.expect("receipt acknowledgement task");
        }
        {
            let meta = meta.lock().expect("runtime metadata");
            assert!(meta.pending_tool_calls.contains("dropped-call"));
            assert!(!meta
                .decided_tool_execution_ids
                .contains("dropped-execution"));
        }

        // The execution binding is preserved for the shutdown cleanup so the
        // exposed tool lifecycle is still closed with an interrupted ToolEnd.
        assert_eq!(
            meta.lock()
                .expect("runtime metadata")
                .tool_execution_ids
                .get("dropped-call")
                .map(String::as_str),
            Some("dropped-execution")
        );
        let terminals = take_interrupted_tool_terminal_messages(&meta);
        assert!(
            terminals.iter().any(|message| matches!(
                message,
                FromAgentMessage::ToolEnd {
                    call_id,
                    tool_execution_id: Some(tool_execution_id),
                    success: false,
                    ..
                } if call_id == "dropped-call" && tool_execution_id == "dropped-execution"
            )),
            "shutdown cleanup must terminalize the dropped governed response: {terminals:?}"
        );
    }

    #[test]
    fn deferred_consumption_rejection_is_a_correlated_protocol_error() {
        assert!(matches!(
            response_consumption_message(
                "cancelled-call".to_string(),
                ToolResponseConsumption::Rejected {
                    reason: "tool response cancelled before native consumption".to_string(),
                },
            ),
            FromAgentMessage::Error {
                request_id: Some(request_id),
                message,
                fatal: false,
                error_type: Some(HeadlessErrorType::Protocol),
            } if request_id == "cancelled-call"
                && message.contains("cancelled before native consumption")
        ));
    }

    async fn assert_lifecycle_precedes_native_acceptance(approved: bool) -> Vec<String> {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("ordered-call".to_string());
        let accepted = prepare_tool_response(
            &meta,
            "ordered-call".to_string(),
            Some("ordered-execution".to_string()),
            approved,
            Some(HeadlessToolResult {
                success: approved,
                output: "ordered output".to_string(),
                error: (!approved).then(|| "denied".to_string()),
                details: None,
            }),
        )
        .expect("ordered response");
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let (tool_tx, mut tool_rx) = mpsc::unbounded_channel::<ToolResponseMessage>();
        let receiver_events = Arc::clone(&events);
        tokio::spawn(async move {
            let (_, _, _, _, consumed) = tool_rx.recv().await.expect("native response");
            receiver_events
                .lock()
                .expect("ordered events")
                .push("native".to_string());
            consumed
                .expect("consumption receipt")
                .send(ToolResponseConsumption::Accepted)
                .ok();
        });
        let lifecycle_events = Arc::clone(&events);
        let acknowledgement_events = Arc::clone(&events);
        dispatch_accepted_tool_response_with(
            &meta,
            &tool_tx,
            accepted,
            "ordered-call".to_string(),
            move |message| {
                let label = match message {
                    FromAgentMessage::ToolStart { .. } => "start",
                    FromAgentMessage::ToolOutput { .. } => "output",
                    FromAgentMessage::ToolEnd { .. } => "end",
                    _ => "other",
                };
                lifecycle_events
                    .lock()
                    .expect("ordered events")
                    .push(label.to_string());
                Ok(())
            },
            move |_, outcome, _dropped| {
                assert_eq!(outcome, ToolResponseConsumption::Accepted);
                acknowledgement_events
                    .lock()
                    .expect("ordered events")
                    .push("accepted".to_string());
            },
        )
        .expect("ordered dispatch");
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if events
                    .lock()
                    .expect("ordered events")
                    .last()
                    .map(String::as_str)
                    == Some("accepted")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("acceptance event");
        let ordered = events.lock().expect("ordered events").clone();
        ordered
    }

    #[tokio::test]
    async fn completed_response_lifecycle_precedes_native_acceptance() {
        assert_eq!(
            assert_lifecycle_precedes_native_acceptance(true).await,
            ["start", "output", "end", "native", "accepted"]
        );
    }

    #[tokio::test]
    async fn denied_response_terminal_lifecycle_precedes_native_acceptance() {
        assert_eq!(
            assert_lifecycle_precedes_native_acceptance(false).await,
            ["end", "native", "accepted"]
        );
    }

    #[test]
    fn client_tool_result_requires_and_consumes_a_pending_call() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));

        let error = prepare_client_tool_result(
            &meta,
            "mistyped-client-call".to_string(),
            vec![ClientToolResultContent::Text {
                text: "ok".to_string(),
            }],
            false,
        )
        .expect_err("an unmatched client result must be rejected");
        assert!(error.contains("not awaiting a decision"));

        meta.lock()
            .expect("runtime metadata")
            .pending_tool_calls
            .insert("client-call".to_string());
        let accepted = prepare_client_tool_result(
            &meta,
            "client-call".to_string(),
            vec![ClientToolResultContent::Text {
                text: "ok".to_string(),
            }],
            false,
        )
        .expect("a registered client result must be accepted");
        assert!(matches!(
            accepted.messages.last(),
            Some(FromAgentMessage::ToolEnd {
                call_id,
                success: true,
                ..
            }) if call_id == "client-call"
        ));
        assert!(
            prepare_client_tool_result(
                &meta,
                "client-call".to_string(),
                vec![ClientToolResultContent::Text {
                    text: "ok".to_string(),
                }],
                false,
            )
            .is_err(),
            "the pending call must be consumed exactly once"
        );
    }

    #[test]
    fn interrupted_governed_tools_emit_correlated_terminal_failures() {
        let meta = Arc::new(Mutex::new(RuntimeMeta::default()));
        {
            let mut meta = meta.lock().expect("runtime metadata");
            meta.tool_execution_ids
                .insert("call-b".to_string(), "execution-b".to_string());
            meta.tool_execution_ids
                .insert("call-a".to_string(), "execution-a".to_string());
            meta.pending_tool_calls.insert("call-pending".to_string());
        }

        let messages = take_interrupted_tool_terminal_messages(&meta);

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            &messages[0],
            FromAgentMessage::ToolEnd {
                call_id,
                tool_execution_id: Some(tool_execution_id),
                success: false,
                ..
            } if call_id == "call-a" && tool_execution_id == "execution-a"
        ));
        assert!(matches!(
            &messages[1],
            FromAgentMessage::ToolEnd {
                call_id,
                tool_execution_id: Some(tool_execution_id),
                success: false,
                ..
            } if call_id == "call-b" && tool_execution_id == "execution-b"
        ));
        let meta = meta.lock().expect("runtime metadata");
        assert!(meta.tool_execution_ids.is_empty());
        assert!(meta.pending_tool_calls.is_empty());
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
        assert_eq!(
            normalize_session_id(Some("  env-session-42  ")).as_deref(),
            Some("env-session-42")
        );
    }

    #[test]
    fn env_session_id_filters_blank_value() {
        assert_eq!(normalize_session_id(Some("   ")), None);
        assert_eq!(normalize_session_id(None), None);
    }
}

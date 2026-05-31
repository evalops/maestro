//! Remote HTTP/SSE transport for headless sessions.
//!
//! This transport attaches to a long-lived headless runtime exposed by the
//! Maestro web server. It uses HTTP POST for outbound control messages and an
//! SSE subscription for replayable inbound events.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION},
    Client, StatusCode,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::async_transport::{AsyncTransportError, RemoteErrorKind};
use super::messages::{
    ActiveFileWatch, ActiveUtilityCommand, AgentState, ApprovalMode, ClientCapabilities,
    ClientInfo, CodexSubagentContinuityEdge, ConnectionRole, ConnectionState, FromAgentMessage,
    HeadlessErrorType, InitConfig, PendingApproval, ServerRequestType, StreamingResponse,
    ThinkingLevel, ToAgentMessage, UtilityCommandShellMode, UtilityCommandTerminalMode,
    UtilityOperation,
};

const MESSAGE_POST_MAX_RETRIES: u32 = 10;
#[cfg(test)]
const MESSAGE_POST_BASE_DELAY: Duration = Duration::from_millis(10);
#[cfg(not(test))]
const MESSAGE_POST_BASE_DELAY: Duration = Duration::from_millis(500);
#[cfg(test)]
const MESSAGE_POST_MAX_DELAY: Duration = Duration::from_millis(40);
#[cfg(not(test))]
const MESSAGE_POST_MAX_DELAY: Duration = Duration::from_secs(8);

/// Configuration for the remote headless transport.
#[derive(Debug, Clone)]
pub struct RemoteTransportConfig {
    /// Base URL for the Maestro web server.
    pub base_url: String,
    /// Optional bearer/API key for authenticated requests.
    pub api_key: Option<String>,
    /// Optional CSRF token for state-changing requests.
    pub csrf_token: Option<String>,
    /// Optional existing session id to attach to.
    pub session_id: Option<String>,
    /// Optional existing connection id to reuse when reconnecting.
    pub connection_id: Option<String>,
    /// Optional model override used when creating a new runtime.
    pub model: Option<String>,
    /// Optional thinking level used when creating a new runtime.
    pub thinking_level: Option<ThinkingLevel>,
    /// Optional approval mode used when creating a new runtime.
    pub approval_mode: Option<ApprovalMode>,
    /// Whether to enable client-side tools for the remote runtime.
    pub enable_client_tools: bool,
    /// Whether to enable runtime command execution on the shared control plane.
    pub enable_command_exec: bool,
    /// Whether to enable workspace file path search on the shared control plane.
    pub enable_file_search: bool,
    /// Whether to enable workspace file reads on the shared control plane.
    pub enable_file_read: bool,
    /// Whether to enable runtime file watching on the shared control plane.
    pub enable_file_watch: bool,
    /// Whether to stream untranslated raw agent events for advanced clients.
    pub enable_raw_agent_events: bool,
    /// Optional client flavor used to select client-specific tools.
    pub client: Option<String>,
    /// Optional human-readable client name for handshake metadata.
    pub client_name: String,
    /// Optional human-readable client version for handshake metadata.
    pub client_version: Option<String>,
    /// Optional connection role used for HTTP attach/message permissions.
    pub role: Option<String>,
    /// Notification classes the subscriber does not want streamed live.
    pub opt_out_notifications: Vec<String>,
    /// Whether a controller subscription should take over an existing controller lease.
    pub take_control: bool,
    /// Additional headers to send on every request.
    pub headers: HashMap<String, String>,
}

impl Default for RemoteTransportConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8080".to_string(),
            api_key: None,
            csrf_token: None,
            session_id: None,
            connection_id: None,
            model: None,
            thinking_level: None,
            approval_mode: None,
            enable_client_tools: false,
            enable_command_exec: true,
            enable_file_search: true,
            enable_file_read: true,
            enable_file_watch: true,
            enable_raw_agent_events: false,
            client: None,
            client_name: "maestro-tui-rs".to_string(),
            client_version: option_env!("CARGO_PKG_VERSION").map(str::to_string),
            role: Some("controller".to_string()),
            opt_out_notifications: vec![],
            take_control: false,
            headers: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UtilityCommandStartOptions {
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub shell_mode: Option<UtilityCommandShellMode>,
    pub terminal_mode: Option<UtilityCommandTerminalMode>,
    pub allow_stdin: Option<bool>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum RemoteIncoming {
    Snapshot {
        state: Box<AgentState>,
        last_init: Option<InitConfig>,
    },
    Reset {
        reason: String,
        state: Box<AgentState>,
        last_init: Option<InitConfig>,
    },
    Message(FromAgentMessage),
    Heartbeat,
}

#[derive(Debug, Serialize)]
struct RemoteSessionSubscribeRequest {
    #[serde(rename = "connectionId", skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo", skip_serializing_if = "Option::is_none")]
    client_info: Option<ClientInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<RemoteClientCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(rename = "optOutNotifications", skip_serializing_if = "Vec::is_empty")]
    opt_out_notifications: Vec<String>,
    #[serde(
        rename = "takeControl",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    take_control: bool,
}

#[derive(Debug, Deserialize)]
struct RemoteSessionSubscriptionResponse {
    connection_id: String,
    subscription_id: String,
    heartbeat_interval_ms: u64,
    snapshot: RemoteRuntimeSnapshot,
}

#[derive(Debug, Serialize)]
struct RemoteConnectionCreateRequest {
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo", skip_serializing_if = "Option::is_none")]
    client_info: Option<ClientInfo>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(rename = "connectionId", skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(rename = "thinkingLevel", skip_serializing_if = "Option::is_none")]
    thinking_level: Option<ThinkingLevel>,
    #[serde(rename = "approvalMode", skip_serializing_if = "Option::is_none")]
    approval_mode: Option<ApprovalMode>,
    #[serde(
        rename = "enableClientTools",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    enable_client_tools: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<RemoteClientCapabilities>,
    #[serde(rename = "optOutNotifications", skip_serializing_if = "Vec::is_empty")]
    opt_out_notifications: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(
        rename = "takeControl",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    take_control: bool,
}

#[derive(Debug, Serialize)]
struct RemoteClientCapabilities {
    #[serde(rename = "serverRequests")]
    server_requests: Vec<&'static str>,
    #[serde(rename = "utilityOperations", skip_serializing_if = "Vec::is_empty")]
    utility_operations: Vec<&'static str>,
    #[serde(
        rename = "rawAgentEvents",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    raw_agent_events: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteConnectionBootstrapResponse {
    session_id: String,
    connection_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteActiveToolState {
    call_id: String,
    tool: String,
    output: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteActiveUtilityCommandState {
    command_id: String,
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    shell_mode: UtilityCommandShellMode,
    terminal_mode: UtilityCommandTerminalMode,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    columns: Option<u32>,
    #[serde(default)]
    rows: Option<u32>,
    #[serde(default)]
    owner_connection_id: Option<String>,
    output: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteActiveFileWatchState {
    watch_id: String,
    root_dir: String,
    #[serde(default)]
    include_patterns: Option<Vec<String>>,
    #[serde(default)]
    exclude_patterns: Option<Vec<String>>,
    debounce_ms: u32,
    #[serde(default)]
    owner_connection_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteRuntimeStateSnapshot {
    #[serde(default)]
    protocol_version: Option<String>,
    #[serde(default)]
    client_protocol_version: Option<String>,
    #[serde(default)]
    client_info: Option<ClientInfo>,
    #[serde(default)]
    capabilities: Option<ClientCapabilities>,
    #[serde(default)]
    opt_out_notifications: Option<Vec<String>>,
    #[serde(default)]
    connection_role: Option<ConnectionRole>,
    #[serde(default)]
    connection_count: usize,
    #[serde(default)]
    subscriber_count: usize,
    #[serde(default)]
    controller_subscription_id: Option<String>,
    #[serde(default)]
    controller_connection_id: Option<String>,
    #[serde(default)]
    connections: Vec<ConnectionState>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    current_response: Option<StreamingResponse>,
    #[serde(default)]
    pending_approvals: Vec<PendingApproval>,
    #[serde(default)]
    pending_client_tools: Vec<PendingApproval>,
    #[serde(default)]
    pending_user_inputs: Vec<PendingApproval>,
    #[serde(default)]
    pending_tool_retries: Vec<PendingApproval>,
    #[serde(default)]
    tracked_tools: Vec<PendingApproval>,
    #[serde(default)]
    active_tools: Vec<RemoteActiveToolState>,
    #[serde(default)]
    codex_subagent_edges: Vec<CodexSubagentContinuityEdge>,
    #[serde(default)]
    active_utility_commands: Vec<RemoteActiveUtilityCommandState>,
    #[serde(default)]
    active_file_watches: Vec<RemoteActiveFileWatchState>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    last_error_type: Option<HeadlessErrorType>,
    #[serde(default)]
    last_status: Option<String>,
    #[serde(default)]
    last_response_duration_ms: Option<u64>,
    #[serde(default)]
    last_ttft_ms: Option<u64>,
    #[serde(default)]
    is_ready: bool,
    #[serde(default)]
    is_responding: bool,
}

impl RemoteRuntimeStateSnapshot {
    fn into_agent_state(self) -> AgentState {
        AgentState {
            protocol_version: self.protocol_version,
            client_protocol_version: self.client_protocol_version,
            client_info: self.client_info,
            capabilities: self.capabilities,
            opt_out_notifications: self.opt_out_notifications,
            connection_role: self.connection_role,
            connection_count: self.connection_count,
            subscriber_count: self.subscriber_count,
            controller_subscription_id: self.controller_subscription_id,
            controller_connection_id: self.controller_connection_id,
            connections: self.connections,
            model: self.model,
            provider: self.provider,
            session_id: self.session_id,
            cwd: self.cwd,
            git_branch: self.git_branch,
            current_response: self.current_response,
            pending_approvals: self.pending_approvals,
            pending_client_tools: self.pending_client_tools,
            pending_user_inputs: self.pending_user_inputs,
            pending_tool_retries: self.pending_tool_retries,
            tracked_tools: self
                .tracked_tools
                .into_iter()
                .map(|tool| (tool.call_id.clone(), tool))
                .collect::<HashMap<_, _>>(),
            active_tools: self
                .active_tools
                .into_iter()
                .map(|tool| {
                    (
                        tool.call_id.clone(),
                        super::messages::ActiveTool {
                            call_id: tool.call_id,
                            tool: tool.tool,
                            output: tool.output,
                            started: std::time::Instant::now(),
                        },
                    )
                })
                .collect(),
            codex_subagent_edges: self.codex_subagent_edges,
            active_utility_commands: self
                .active_utility_commands
                .into_iter()
                .map(|command| {
                    (
                        command.command_id.clone(),
                        ActiveUtilityCommand {
                            command_id: command.command_id,
                            command: command.command,
                            cwd: command.cwd,
                            shell_mode: command.shell_mode,
                            terminal_mode: command.terminal_mode,
                            pid: command.pid,
                            columns: command.columns,
                            rows: command.rows,
                            owner_connection_id: command.owner_connection_id,
                            output: command.output,
                        },
                    )
                })
                .collect(),
            active_file_watches: self
                .active_file_watches
                .into_iter()
                .map(|watch| {
                    (
                        watch.watch_id.clone(),
                        ActiveFileWatch {
                            watch_id: watch.watch_id,
                            root_dir: watch.root_dir,
                            include_patterns: watch.include_patterns,
                            exclude_patterns: watch.exclude_patterns,
                            debounce_ms: watch.debounce_ms,
                            owner_connection_id: watch.owner_connection_id,
                        },
                    )
                })
                .collect(),
            last_error: self.last_error,
            last_error_type: self.last_error_type,
            last_status: self.last_status,
            last_response_duration_ms: self.last_response_duration_ms,
            last_ttft_ms: self.last_ttft_ms,
            is_ready: self.is_ready,
            is_responding: self.is_responding,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteRuntimeSnapshot {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    session_id: String,
    cursor: u64,
    #[serde(default)]
    last_init: Option<InitConfig>,
    state: RemoteRuntimeStateSnapshot,
}

impl RemoteRuntimeSnapshot {
    fn into_state(self) -> (String, u64, Option<InitConfig>, AgentState) {
        let mut state = self.state.into_agent_state();
        state.protocol_version = Some(self.protocol_version.clone());
        (self.session_id, self.cursor, self.last_init, state)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RemoteEnvelope {
    Snapshot {
        snapshot: Box<RemoteRuntimeSnapshot>,
    },
    Reset {
        reason: String,
        snapshot: Box<RemoteRuntimeSnapshot>,
    },
    Message {
        cursor: u64,
        message: Box<FromAgentMessage>,
    },
    Heartbeat {
        cursor: u64,
    },
}

/// Transport for remote headless runtimes.
pub struct RemoteAgentTransport {
    message_tx: mpsc::UnboundedSender<ToAgentMessage>,
    event_rx: mpsc::UnboundedReceiver<Result<RemoteIncoming, AsyncTransportError>>,
    cancel_token: CancellationToken,
    shutdown_context: Arc<RemoteShutdownContext>,
    connection_role: Option<ConnectionRole>,
    session_id: String,
    connection_id: String,
    subscription_id: String,
    heartbeat_interval: Duration,
    state: AgentState,
    last_init: Option<InitConfig>,
    _reader_handle: tokio::task::JoinHandle<()>,
    _writer_handle: tokio::task::JoinHandle<()>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
}

struct WriterLoopContext {
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
    connection_id: String,
    subscription_id: String,
    event_tx: mpsc::UnboundedSender<Result<RemoteIncoming, AsyncTransportError>>,
    cancel: CancellationToken,
}

struct HeartbeatLoopContext {
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
    connection_id: String,
    subscription_id: String,
    event_tx: mpsc::UnboundedSender<Result<RemoteIncoming, AsyncTransportError>>,
    emit_success_heartbeat: bool,
    interval: Duration,
    cancel: CancellationToken,
}

struct RemoteShutdownContext {
    client: Client,
    config: RemoteTransportConfig,
}

#[derive(Debug, Clone, Copy)]
enum RemoteRequestKind {
    Bootstrap,
    Subscribe,
    Message,
    Stream,
    Heartbeat,
}

impl RemoteAgentTransport {
    /// Connect to a remote headless session and begin streaming events.
    pub async fn connect(config: RemoteTransportConfig) -> Result<Self, AsyncTransportError> {
        let client = Client::builder()
            .build()
            .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;
        let shutdown_context = Arc::new(RemoteShutdownContext {
            client: client.clone(),
            config: config.clone(),
        });

        let bootstrap = create_or_attach_connection(&client, &config).await?;
        let subscription = subscribe_to_session(
            &client,
            &config,
            &bootstrap.session_id,
            Some(&bootstrap.connection_id),
        )
        .await?;
        let (session_id, cursor, last_init, state) = subscription.snapshot.into_state();
        let connection_id = subscription.connection_id;
        let subscription_id = subscription.subscription_id;
        let heartbeat_interval = Duration::from_millis(subscription.heartbeat_interval_ms.max(1));

        let (message_tx, message_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();
        let reader_cancel = cancel_token.clone();
        let writer_cancel = cancel_token.clone();
        let heartbeat_cancel = cancel_token.clone();

        let reader_handle = tokio::spawn(reader_loop(
            client.clone(),
            config.clone(),
            session_id.clone(),
            subscription_id.clone(),
            cursor,
            event_tx.clone(),
            reader_cancel,
        ));
        let writer_handle = tokio::spawn(writer_loop(
            WriterLoopContext {
                client: client.clone(),
                config: config.clone(),
                session_id: session_id.clone(),
                connection_id: connection_id.clone(),
                subscription_id: subscription_id.clone(),
                event_tx: event_tx.clone(),
                cancel: writer_cancel,
            },
            message_rx,
        ));
        let heartbeat_handle = tokio::spawn(heartbeat_loop(HeartbeatLoopContext {
            client: Client::builder()
                .build()
                .map_err(|error| AsyncTransportError::Remote(error.to_string()))?,
            config: config.clone(),
            session_id: session_id.clone(),
            connection_id: connection_id.clone(),
            subscription_id: subscription_id.clone(),
            event_tx,
            emit_success_heartbeat: config
                .opt_out_notifications
                .iter()
                .any(|notification| notification == "heartbeat"),
            interval: heartbeat_interval,
            cancel: heartbeat_cancel,
        }));

        let transport = Self {
            message_tx,
            event_rx,
            cancel_token,
            shutdown_context,
            connection_role: build_remote_connection_role(&config),
            session_id,
            connection_id,
            subscription_id,
            heartbeat_interval,
            state,
            last_init,
            _reader_handle: reader_handle,
            _writer_handle: writer_handle,
            _heartbeat_handle: heartbeat_handle,
        };
        if transport.connection_role != Some(ConnectionRole::Viewer) {
            transport.send(build_remote_hello_message(&config))?;
        }
        Ok(transport)
    }

    pub fn send(&self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        if self.connection_role == Some(ConnectionRole::Viewer)
            && !matches!(msg, ToAgentMessage::Hello { .. })
        {
            return Err(AsyncTransportError::SendFailed(
                "viewer connections cannot send remote session messages".to_string(),
            ));
        }
        self.message_tx
            .send(msg)
            .map_err(|_| AsyncTransportError::ChannelClosed)
    }

    pub fn start_utility_command(
        &self,
        command_id: String,
        command: String,
        options: UtilityCommandStartOptions,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityCommandStart {
            command_id,
            command,
            cwd: options.cwd,
            env: options.env,
            shell_mode: options.shell_mode,
            terminal_mode: options.terminal_mode,
            allow_stdin: options.allow_stdin,
            columns: options.columns,
            rows: options.rows,
        })
    }

    pub fn terminate_utility_command(
        &self,
        command_id: String,
        force: bool,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityCommandTerminate {
            command_id,
            force: Some(force),
        })
    }

    pub fn write_utility_command_stdin(
        &self,
        command_id: String,
        content: String,
        eof: bool,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityCommandStdin {
            command_id,
            content,
            eof: Some(eof),
        })
    }

    pub fn resize_utility_command(
        &self,
        command_id: String,
        columns: u32,
        rows: u32,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityCommandResize {
            command_id,
            columns,
            rows,
        })
    }

    pub fn search_files(
        &self,
        search_id: String,
        query: String,
        cwd: Option<String>,
        limit: Option<u32>,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityFileSearch {
            search_id,
            query,
            cwd,
            limit,
        })
    }

    pub fn read_file(
        &self,
        read_id: String,
        path: String,
        cwd: Option<String>,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityFileRead {
            read_id,
            path,
            cwd,
            offset,
            limit,
        })
    }

    pub fn start_file_watch(
        &self,
        watch_id: String,
        root_dir: Option<String>,
        include_patterns: Option<Vec<String>>,
        exclude_patterns: Option<Vec<String>>,
        debounce_ms: Option<u32>,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityFileWatchStart {
            watch_id,
            root_dir,
            include_patterns,
            exclude_patterns,
            debounce_ms,
        })
    }

    pub fn stop_file_watch(&self, watch_id: String) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityFileWatchStop { watch_id })
    }

    pub fn shutdown(&self) -> Result<(), AsyncTransportError> {
        if self.cancel_token.is_cancelled() {
            return Ok(());
        }
        let shutdown_context = Arc::clone(&self.shutdown_context);
        let session_id = self.session_id.clone();
        let connection_id = self.connection_id.clone();
        let subscription_id = self.subscription_id.clone();
        let cancel = self.cancel_token.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                disconnect_connection(
                    &shutdown_context.client,
                    &shutdown_context.config,
                    &session_id,
                    &connection_id,
                    Some(&subscription_id),
                )
                .await;
                cancel.cancel();
            });
            Ok(())
        } else {
            self.cancel_token.cancel();
            Ok(())
        }
    }

    pub async fn shutdown_and_wait(self) -> Result<(), AsyncTransportError> {
        let Self {
            message_tx: _message_tx,
            event_rx: _event_rx,
            cancel_token,
            shutdown_context,
            connection_role: _connection_role,
            session_id,
            connection_id,
            subscription_id,
            heartbeat_interval: _heartbeat_interval,
            state: _state,
            last_init: _last_init,
            _reader_handle,
            _writer_handle,
            _heartbeat_handle,
        } = self;

        if !cancel_token.is_cancelled() {
            disconnect_connection(
                &shutdown_context.client,
                &shutdown_context.config,
                &session_id,
                &connection_id,
                Some(&subscription_id),
            )
            .await;
            cancel_token.cancel();
        }

        let (_reader_result, _writer_result, _heartbeat_result) =
            tokio::join!(_reader_handle, _writer_handle, _heartbeat_handle);
        Ok(())
    }

    pub(super) fn try_recv_incoming(
        &mut self,
    ) -> Option<Result<RemoteIncoming, AsyncTransportError>> {
        match self.event_rx.try_recv() {
            Ok(result) => Some(self.apply_incoming_result(result)),
            Err(mpsc::error::TryRecvError::Empty) => None,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                Some(Err(AsyncTransportError::ChannelClosed))
            }
        }
    }

    pub(crate) async fn recv_incoming(&mut self) -> Result<RemoteIncoming, AsyncTransportError> {
        let result = self
            .event_rx
            .recv()
            .await
            .ok_or(AsyncTransportError::ChannelClosed)?;
        self.apply_incoming_result(result)
    }

    pub fn state(&self) -> &AgentState {
        &self.state
    }

    pub fn last_init(&self) -> Option<&InitConfig> {
        self.last_init.as_ref()
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn heartbeat_interval(&self) -> Duration {
        self.heartbeat_interval
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    fn apply_incoming_result(
        &mut self,
        result: Result<RemoteIncoming, AsyncTransportError>,
    ) -> Result<RemoteIncoming, AsyncTransportError> {
        match result {
            Ok(RemoteIncoming::Snapshot { state, last_init }) => {
                self.state = (*state).clone();
                self.last_init = last_init.clone();
                Ok(RemoteIncoming::Snapshot { state, last_init })
            }
            Ok(RemoteIncoming::Reset {
                reason,
                state,
                last_init,
            }) => {
                self.state = (*state).clone();
                self.last_init = last_init.clone();
                Ok(RemoteIncoming::Reset {
                    reason,
                    state,
                    last_init,
                })
            }
            Ok(RemoteIncoming::Message(message)) => {
                let _ignored_event = self.state.handle_message(message.clone());
                Ok(RemoteIncoming::Message(message))
            }
            Ok(RemoteIncoming::Heartbeat) => Ok(RemoteIncoming::Heartbeat),
            Err(error) => Err(error),
        }
    }
}

fn build_remote_utility_operations(config: &RemoteTransportConfig) -> Vec<&'static str> {
    let mut operations = Vec::new();
    if config.enable_command_exec {
        operations.push("command_exec");
    }
    if config.enable_file_search {
        operations.push("file_search");
    }
    if config.enable_file_read {
        operations.push("file_read");
    }
    if config.enable_file_watch {
        operations.push("file_watch");
    }
    operations
}

fn build_remote_server_requests(config: &RemoteTransportConfig) -> Vec<&'static str> {
    let mut requests = vec!["approval"];
    if config.enable_client_tools {
        requests.push("client_tool");
    }
    if build_remote_connection_role(config) != Some(ConnectionRole::Viewer) {
        requests.push("user_input");
        requests.push("tool_retry");
    }
    requests
}

fn build_remote_server_request_types(config: &RemoteTransportConfig) -> Vec<ServerRequestType> {
    let mut requests = vec![ServerRequestType::Approval];
    if config.enable_client_tools {
        requests.push(ServerRequestType::ClientTool);
    }
    if build_remote_connection_role(config) != Some(ConnectionRole::Viewer) {
        requests.push(ServerRequestType::UserInput);
        requests.push(ServerRequestType::ToolRetry);
    }
    requests
}

fn build_remote_utility_operation_types(config: &RemoteTransportConfig) -> Vec<UtilityOperation> {
    let mut operations = Vec::new();
    if config.enable_command_exec {
        operations.push(UtilityOperation::CommandExec);
    }
    if config.enable_file_search {
        operations.push(UtilityOperation::FileSearch);
    }
    if config.enable_file_read {
        operations.push(UtilityOperation::FileRead);
    }
    if config.enable_file_watch {
        operations.push(UtilityOperation::FileWatch);
    }
    operations
}

fn build_remote_connection_role(config: &RemoteTransportConfig) -> Option<ConnectionRole> {
    match config.role.as_deref() {
        Some("viewer") => Some(ConnectionRole::Viewer),
        Some("controller") => Some(ConnectionRole::Controller),
        _ => None,
    }
}

fn build_remote_hello_message(config: &RemoteTransportConfig) -> ToAgentMessage {
    ToAgentMessage::Hello {
        protocol_version: Some(super::HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: config.client_name.clone(),
            version: config.client_version.clone(),
        }),
        capabilities: Some(ClientCapabilities {
            server_requests: Some(build_remote_server_request_types(config)),
            utility_operations: Some(build_remote_utility_operation_types(config)),
            raw_agent_events: Some(config.enable_raw_agent_events),
        }),
        role: build_remote_connection_role(config),
        opt_out_notifications: (!config.opt_out_notifications.is_empty())
            .then(|| config.opt_out_notifications.clone()),
    }
}

fn build_remote_connection_create_request(
    config: &RemoteTransportConfig,
    connection_id: Option<String>,
) -> RemoteConnectionCreateRequest {
    RemoteConnectionCreateRequest {
        protocol_version: Some(super::HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: config.client_name.clone(),
            version: config.client_version.clone(),
        }),
        session_id: config.session_id.clone(),
        connection_id,
        model: config.model.clone(),
        thinking_level: config.thinking_level,
        approval_mode: config.approval_mode,
        enable_client_tools: config.enable_client_tools,
        capabilities: Some(RemoteClientCapabilities {
            server_requests: build_remote_server_requests(config),
            utility_operations: build_remote_utility_operations(config),
            raw_agent_events: config.enable_raw_agent_events,
        }),
        opt_out_notifications: config.opt_out_notifications.clone(),
        client: config.client.clone(),
        role: config.role.clone(),
        take_control: config.take_control,
    }
}

async fn create_or_attach_connection(
    client: &Client,
    config: &RemoteTransportConfig,
) -> Result<RemoteConnectionBootstrapResponse, AsyncTransportError> {
    let url = format!(
        "{}/api/headless/connections",
        config.base_url.trim_end_matches('/')
    );
    let response = with_headers(
        client
            .post(&url)
            .json(&build_remote_connection_create_request(
                config,
                config.connection_id.clone(),
            )),
        config,
        true,
    )
    .send()
    .await
    .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    if response.status() == StatusCode::NOT_FOUND && config.connection_id.is_some() {
        let retry_response = with_headers(
            client
                .post(url)
                .json(&build_remote_connection_create_request(config, None)),
            config,
            true,
        )
        .send()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;
        return decode_json_response(retry_response, RemoteRequestKind::Bootstrap).await;
    }

    decode_json_response(response, RemoteRequestKind::Bootstrap).await
}

async fn subscribe_to_session(
    client: &Client,
    config: &RemoteTransportConfig,
    session_id: &str,
    connection_id: Option<&str>,
) -> Result<RemoteSessionSubscriptionResponse, AsyncTransportError> {
    let url = format!(
        "{}/api/headless/sessions/{session_id}/subscribe",
        config.base_url.trim_end_matches('/')
    );
    let request = RemoteSessionSubscribeRequest {
        connection_id: connection_id.map(str::to_string),
        protocol_version: Some(super::HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: config.client_name.clone(),
            version: config.client_version.clone(),
        }),
        capabilities: Some(RemoteClientCapabilities {
            server_requests: build_remote_server_requests(config),
            utility_operations: build_remote_utility_operations(config),
            raw_agent_events: config.enable_raw_agent_events,
        }),
        role: config.role.clone(),
        opt_out_notifications: config.opt_out_notifications.clone(),
        take_control: config.take_control,
    };

    let response = with_headers(client.post(url).json(&request), config, true)
        .send()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    decode_json_response(response, RemoteRequestKind::Subscribe).await
}

async fn disconnect_connection(
    client: &Client,
    config: &RemoteTransportConfig,
    session_id: &str,
    connection_id: &str,
    subscription_id: Option<&str>,
) {
    let url = format!(
        "{}/api/headless/sessions/{session_id}/disconnect",
        config.base_url.trim_end_matches('/')
    );
    let _ignored = with_headers(
        client.post(url).json(&serde_json::json!({
            "connectionId": connection_id,
            "subscriptionId": subscription_id,
        })),
        config,
        true,
    )
    .send()
    .await;
}

async fn heartbeat_session(
    client: &Client,
    config: &RemoteTransportConfig,
    session_id: &str,
    connection_id: &str,
    subscription_id: &str,
) -> Result<(), AsyncTransportError> {
    let url = format!(
        "{}/api/headless/sessions/{session_id}/heartbeat",
        config.base_url.trim_end_matches('/')
    );
    let response = with_headers(
        client.post(url).json(&serde_json::json!({
            "connectionId": connection_id,
            "subscriptionId": subscription_id,
        })),
        config,
        true,
    )
    .send()
    .await
    .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    let _response: serde_json::Value =
        decode_json_response(response, RemoteRequestKind::Heartbeat).await?;
    Ok(())
}

async fn writer_loop(context: WriterLoopContext, mut rx: mpsc::UnboundedReceiver<ToAgentMessage>) {
    let WriterLoopContext {
        client,
        config,
        session_id,
        connection_id,
        subscription_id,
        event_tx,
        cancel,
    } = context;
    let url = format!(
        "{}/api/headless/sessions/{session_id}/messages",
        config.base_url.trim_end_matches('/')
    );

    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            message = rx.recv() => {
                let Some(message) = message else {
                    break;
                };
                match send_message_with_retry(
                    &client,
                    &config,
                    &url,
                    &connection_id,
                    &subscription_id,
                    &message,
                    &cancel,
                )
                .await
                {
                    Ok(()) => {}
                    Err(AsyncTransportError::Cancelled) => break,
                    Err(error) => {
                        let _ = event_tx.send(Err(error));
                        break;
                    }
                }
            }
        }
    }
}

fn should_retry_message_error(error: &AsyncTransportError) -> bool {
    match error {
        AsyncTransportError::Remote(_) => true,
        AsyncTransportError::RemoteStatus {
            retryable,
            kind: RemoteErrorKind::Other,
            ..
        } => *retryable,
        _ => false,
    }
}

fn should_surface_heartbeat_error(error: &AsyncTransportError) -> bool {
    !error.is_retryable() || error.uses_stale_reference_retry_budget()
}

async fn send_message_with_retry(
    client: &Client,
    config: &RemoteTransportConfig,
    url: &str,
    connection_id: &str,
    subscription_id: &str,
    message: &ToAgentMessage,
    cancel: &CancellationToken,
) -> Result<(), AsyncTransportError> {
    let mut delay = MESSAGE_POST_BASE_DELAY;

    for attempt in 1..=MESSAGE_POST_MAX_RETRIES {
        if cancel.is_cancelled() {
            return Err(AsyncTransportError::Cancelled);
        }

        let result = with_headers(
            client
                .post(url)
                .header("x-maestro-headless-connection-id", connection_id)
                .header("x-composer-headless-connection-id", connection_id)
                .header("x-maestro-headless-subscriber-id", subscription_id)
                .header("x-composer-headless-subscriber-id", subscription_id)
                .json(message),
            config,
            true,
        )
        .send()
        .await;

        match result {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let error = response_status_error(response, RemoteRequestKind::Message).await;
                if attempt == MESSAGE_POST_MAX_RETRIES || !should_retry_message_error(&error) {
                    return Err(error);
                }
            }
            Err(error) => {
                let error = AsyncTransportError::Remote(error.to_string());
                if attempt == MESSAGE_POST_MAX_RETRIES || !should_retry_message_error(&error) {
                    return Err(error);
                }
            }
        }

        tokio::select! {
            () = cancel.cancelled() => return Err(AsyncTransportError::Cancelled),
            () = tokio::time::sleep(delay) => {}
        }
        delay = Duration::from_secs_f64(
            (delay.as_secs_f64() * 2.0).min(MESSAGE_POST_MAX_DELAY.as_secs_f64()),
        );
    }

    Err(AsyncTransportError::Remote(
        "message retries exhausted unexpectedly".to_string(),
    ))
}

async fn heartbeat_loop(context: HeartbeatLoopContext) {
    let HeartbeatLoopContext {
        client,
        config,
        session_id,
        connection_id,
        subscription_id,
        event_tx,
        emit_success_heartbeat,
        interval,
        cancel,
    } = context;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            _ = ticker.tick() => {
                match heartbeat_session(
                    &client,
                    &config,
                    &session_id,
                    &connection_id,
                    &subscription_id,
                )
                .await {
                    Ok(()) => {
                        if emit_success_heartbeat
                            && event_tx.send(Ok(RemoteIncoming::Heartbeat)).is_err()
                        {
                            cancel.cancel();
                            break;
                        }
                    }
                    Err(error) => {
                        if !should_surface_heartbeat_error(&error) {
                            continue;
                        }
                        let _ = event_tx.send(Err(error));
                        cancel.cancel();
                        break;
                    }
                }
            }
        }
    }
}

async fn reader_loop(
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
    subscription_id: String,
    initial_cursor: u64,
    event_tx: mpsc::UnboundedSender<Result<RemoteIncoming, AsyncTransportError>>,
    cancel: CancellationToken,
) {
    let mut cursor = initial_cursor;
    if cancel.is_cancelled() {
        return;
    }

    let url = format!(
        "{}/api/headless/sessions/{session_id}/events?cursor={cursor}&subscriptionId={subscription_id}",
        config.base_url.trim_end_matches('/')
    );
    let response = match with_headers(client.get(url), &config, false).send().await {
        Ok(response) => response,
        Err(error) => {
            let _ = event_tx.send(Err(AsyncTransportError::Remote(error.to_string())));
            return;
        }
    };

    if response.status() != StatusCode::OK {
        let _ = event_tx.send(Err(response_status_error(
            response,
            RemoteRequestKind::Stream,
        )
        .await));
        return;
    }

    let mut stream = response.bytes_stream().eventsource();
    let mut saw_event = false;

    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            event = stream.next() => {
                match event {
                    Some(Ok(event)) => {
                        saw_event = true;
                        match serde_json::from_str::<RemoteEnvelope>(&event.data) {
                            Ok(RemoteEnvelope::Message { cursor: next_cursor, message }) => {
                                if !advances_remote_cursor(cursor, next_cursor) {
                                    continue;
                                }
                                cursor = next_cursor;
                                if event_tx
                                    .send(Ok(RemoteIncoming::Message(*message)))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(RemoteEnvelope::Snapshot { snapshot }) => {
                                if !advances_remote_cursor(cursor, snapshot.cursor) {
                                    continue;
                                }
                                let (_snapshot_session_id, next_cursor, last_init, state) =
                                    snapshot.into_state();
                                cursor = next_cursor;
                                if event_tx
                                    .send(Ok(RemoteIncoming::Snapshot {
                                        state: Box::new(state),
                                        last_init,
                                    }))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(RemoteEnvelope::Reset { reason, snapshot }) => {
                                if !advances_remote_cursor(cursor, snapshot.cursor) {
                                    continue;
                                }
                                let (_snapshot_session_id, next_cursor, last_init, state) =
                                    snapshot.into_state();
                                cursor = next_cursor;
                                if event_tx
                                    .send(Ok(RemoteIncoming::Reset {
                                        reason,
                                        state: Box::new(state),
                                        last_init,
                                    }))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(RemoteEnvelope::Heartbeat { cursor: next_cursor }) => {
                                if !accepts_remote_heartbeat_cursor(cursor, next_cursor) {
                                    continue;
                                }
                                cursor = cursor.max(next_cursor);
                                if event_tx.send(Ok(RemoteIncoming::Heartbeat)).is_err() {
                                    return;
                                }
                            }
                            Err(error) => {
                                if event_tx.is_closed() {
                                    return;
                                }
                                eprintln!("failed to decode remote event: {error}");
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let _ = event_tx.send(Err(AsyncTransportError::Remote(error.to_string())));
                        return;
                    }
                    None => break,
                }
            }
        }
    }

    if cancel.is_cancelled() {
        return;
    }

    let error = if saw_event {
        AsyncTransportError::Remote("remote event stream closed after emitting data".to_string())
    } else {
        AsyncTransportError::Remote("remote event stream closed before emitting data".to_string())
    };
    let _ = event_tx.send(Err(error));
}

fn advances_remote_cursor(current_cursor: u64, next_cursor: u64) -> bool {
    next_cursor > current_cursor
}

fn accepts_remote_heartbeat_cursor(current_cursor: u64, next_cursor: u64) -> bool {
    next_cursor >= current_cursor
}

fn with_headers(
    mut request: reqwest::RequestBuilder,
    config: &RemoteTransportConfig,
    include_json_accept: bool,
) -> reqwest::RequestBuilder {
    if include_json_accept {
        request = request.header(ACCEPT, "application/json");
    } else {
        request = request.header(ACCEPT, "text/event-stream");
    }

    if let Some(api_key) = &config.api_key {
        request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }
    if let Some(csrf_token) = &config.csrf_token {
        request = request.header("x-maestro-csrf", csrf_token);
    }
    if let Some(role) = &config.role {
        request = request.header("x-maestro-headless-role", role);
        request = request.header("x-composer-headless-role", role);
    }

    let mut extra_headers = HeaderMap::new();
    for (key, value) in &config.headers {
        let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(value) else {
            continue;
        };
        extra_headers.insert(name, value);
    }
    request.headers(extra_headers)
}

async fn decode_json_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    kind: RemoteRequestKind,
) -> Result<T, AsyncTransportError> {
    if !response.status().is_success() {
        return Err(response_status_error(response, kind).await);
    }
    response
        .json::<T>()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))
}

fn classify_remote_status(
    status: StatusCode,
    kind: RemoteRequestKind,
    body: &str,
) -> (bool, RemoteErrorKind) {
    let trimmed_body = body.trim();

    if body_has_remote_error_code(trimmed_body, "runtime_owned_elsewhere") {
        return (false, RemoteErrorKind::OwnershipConflict);
    }
    if body_has_remote_error_code(trimmed_body, "runtime_not_ready") {
        return (true, RemoteErrorKind::RuntimeNotReady);
    }

    if trimmed_body.contains("Headless connection not found") {
        return (
            !matches!(kind, RemoteRequestKind::Bootstrap),
            RemoteErrorKind::StaleConnection,
        );
    }
    if trimmed_body.contains("Headless session not found")
        || trimmed_body == "Session not found"
        || trimmed_body.contains("\"error\":\"Session not found\"")
    {
        return (
            !matches!(kind, RemoteRequestKind::Bootstrap),
            RemoteErrorKind::StaleSession,
        );
    }
    if trimmed_body.contains("Headless subscriber not found") {
        return (
            matches!(
                kind,
                RemoteRequestKind::Stream
                    | RemoteRequestKind::Message
                    | RemoteRequestKind::Heartbeat
            ),
            RemoteErrorKind::StaleSubscriber,
        );
    }
    if trimmed_body.contains("Controller lease") {
        return (false, RemoteErrorKind::ControllerLeaseConflict);
    }
    if trimmed_body.contains("role does not match subscription role") {
        return (false, RemoteErrorKind::RoleConflict);
    }
    if trimmed_body.contains("does not have controller access") {
        return (false, RemoteErrorKind::AccessDenied);
    }
    if trimmed_body.contains("owned by another connection") {
        return (false, RemoteErrorKind::OwnershipConflict);
    }

    let retryable = match kind {
        RemoteRequestKind::Bootstrap => !matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::CONFLICT
        ),
        RemoteRequestKind::Subscribe => !matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::CONFLICT
        ),
        RemoteRequestKind::Message => {
            status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
        }
        RemoteRequestKind::Stream | RemoteRequestKind::Heartbeat => !matches!(
            status,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
        ),
    };
    (retryable, RemoteErrorKind::Other)
}

fn body_has_remote_error_code(body: &str, expected: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    if value.get("error_type").and_then(|value| value.as_str()) == Some(expected) {
        return true;
    }
    if value.get("code").and_then(|value| value.as_str()) == Some(expected) {
        return true;
    }
    value
        .get("details")
        .and_then(|value| value.as_array())
        .is_some_and(|details| {
            details.iter().any(|detail| {
                detail.get("reason").and_then(|value| value.as_str()) == Some(expected)
            })
        })
}

async fn response_status_error(
    response: reqwest::Response,
    kind: RemoteRequestKind,
) -> AsyncTransportError {
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| String::new())
        .trim()
        .to_string();
    let message = if body.is_empty() {
        format!("remote request failed with status {status}")
    } else {
        format!("remote request failed with status {status}: {body}")
    };
    let (retryable, kind) = classify_remote_status(status, kind, &body);
    AsyncTransportError::RemoteStatus {
        status: status.as_u16(),
        retryable,
        kind,
        message,
    }
}

#[cfg(test)]
mod tests;

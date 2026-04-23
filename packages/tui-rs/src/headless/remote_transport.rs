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
    ClientInfo, ConnectionRole, ConnectionState, FromAgentMessage, HeadlessErrorType, InitConfig,
    PendingApproval, ServerRequestType, StreamingResponse, ThinkingLevel, ToAgentMessage,
    UtilityCommandShellMode, UtilityCommandTerminalMode, UtilityOperation,
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
mod tests {
    use super::*;
    use crate::headless::HEADLESS_PROTOCOL_VERSION;
    use std::collections::VecDeque;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, Mutex};

    async fn read_http_request(
        socket: &mut TcpStream,
    ) -> Option<(String, Vec<(String, String)>, String)> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];

        loop {
            let bytes_read = socket.read(&mut chunk).await.ok()?;
            if bytes_read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..bytes_read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }

        let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")?;
        let header_bytes = &buffer[..header_end];
        let header_text = String::from_utf8_lossy(header_bytes);
        let request_line = header_text.lines().next()?;
        let path = request_line.split_whitespace().nth(1)?.to_string();
        let headers = header_text
            .lines()
            .skip(1)
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect::<Vec<_>>();
        let content_length = headers
            .iter()
            .find_map(|(name, value)| {
                if name == "content-length" {
                    value.parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        let mut body = buffer[(header_end + 4)..].to_vec();
        while body.len() < content_length {
            let bytes_read = socket.read(&mut chunk).await.ok()?;
            if bytes_read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..bytes_read]);
        }

        Some((
            path,
            headers,
            String::from_utf8_lossy(&body[..content_length]).to_string(),
        ))
    }

    async fn write_http_response(
        socket: &mut TcpStream,
        status_line: &str,
        content_type: &str,
        body: &str,
    ) {
        let response = format!(
            "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    }

    async fn wait_for_posted_bodies_len(
        posted_bodies: &Arc<Mutex<Vec<String>>>,
        expected_len: usize,
    ) -> Vec<String> {
        for _ in 0..50 {
            let posted = posted_bodies.lock().await.clone();
            if posted.len() >= expected_len {
                return posted;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        posted_bodies.lock().await.clone()
    }

    async fn spawn_remote_headless_server(
        snapshot_json: String,
        sse_events: Vec<String>,
    ) -> (
        std::net::SocketAddr,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<Vec<(String, String)>>>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let posted_bodies = Arc::new(Mutex::new(Vec::new()));
        let request_paths = Arc::new(Mutex::new(Vec::new()));
        let request_headers = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(VecDeque::from(sse_events)));

        tokio::spawn({
            let posted_bodies = Arc::clone(&posted_bodies);
            let request_paths = Arc::clone(&request_paths);
            let request_headers = Arc::clone(&request_headers);
            let events = Arc::clone(&events);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let posted_bodies = Arc::clone(&posted_bodies);
                    let request_paths = Arc::clone(&request_paths);
                    let request_headers = Arc::clone(&request_headers);
                    let events = Arc::clone(&events);
                    let snapshot_json = snapshot_json.clone();

                    tokio::spawn(async move {
                        let Some((path, headers, body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        request_paths.lock().await.push(path.clone());
                        request_headers.lock().await.push(headers);

                        if path == "/api/headless/connections" {
                            let body = serde_json::json!({
                                "session_id": "sess_remote",
                                "connection_id": "conn_remote",
                                "controller_connection_id": "conn_remote",
                                "lease_expires_at": "2026-04-02T00:00:15Z",
                                "heartbeat_interval_ms": 15000,
                                "snapshot": serde_json::from_str::<serde_json::Value>(&snapshot_json)
                                    .expect("valid snapshot json"),
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/subscribe")
                        {
                            let body = serde_json::json!({
                                "connection_id": "conn_remote",
                                "subscription_id": "sub_remote",
                                "controller_connection_id": "conn_remote",
                                "lease_expires_at": "2026-04-02T00:00:15Z",
                                "heartbeat_interval_ms": 15000,
                                "snapshot": serde_json::from_str::<serde_json::Value>(&snapshot_json)
                                    .expect("valid snapshot json"),
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/unsubscribe")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/disconnect")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/heartbeat")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"connection_id":"conn_remote","controller_lease_granted":true,"controller_connection_id":"conn_remote","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":15000}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/messages")
                        {
                            posted_bodies.lock().await.push(body);
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/") && path.contains("/events?")
                        {
                            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                            if socket.write_all(headers.as_bytes()).await.is_err() {
                                return;
                            }
                            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                            while let Some(event) = events.lock().await.pop_front() {
                                let _ = tx.send(event);
                            }
                            while let Some(event) = rx.recv().await {
                                let payload = format!("data: {event}\n\n");
                                if socket.write_all(payload.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            return;
                        }

                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "text/plain",
                            "not found",
                        )
                        .await;
                    });
                }
            }
        });

        (addr, posted_bodies, request_paths, request_headers)
    }

    #[test]
    fn remote_runtime_state_snapshot_maps_into_agent_state() {
        let snapshot = RemoteRuntimeStateSnapshot {
            protocol_version: Some("2026-03-30".to_string()),
            client_protocol_version: Some("2026-03-30".to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![
                    crate::headless::ServerRequestType::Approval,
                    crate::headless::ServerRequestType::ClientTool,
                    crate::headless::ServerRequestType::UserInput,
                    crate::headless::ServerRequestType::ToolRetry,
                ]),
                utility_operations: Some(vec![crate::headless::UtilityOperation::CommandExec]),
                raw_agent_events: Some(true),
            }),
            opt_out_notifications: Some(vec!["status".to_string()]),
            connection_role: Some(ConnectionRole::Controller),
            connection_count: 1,
            subscriber_count: 2,
            controller_subscription_id: Some("sub_remote".to_string()),
            controller_connection_id: Some("conn_remote".to_string()),
            connections: vec![ConnectionState {
                connection_id: "conn_remote".to_string(),
                role: ConnectionRole::Controller,
                client_protocol_version: Some("2026-03-30".to_string()),
                client_info: Some(ClientInfo {
                    name: "maestro-tui-rs".to_string(),
                    version: Some("0.1.0".to_string()),
                }),
                capabilities: Some(ClientCapabilities {
                    server_requests: Some(vec![
                        crate::headless::ServerRequestType::Approval,
                        crate::headless::ServerRequestType::ClientTool,
                        crate::headless::ServerRequestType::UserInput,
                        crate::headless::ServerRequestType::ToolRetry,
                    ]),
                    utility_operations: Some(vec![crate::headless::UtilityOperation::CommandExec]),
                    raw_agent_events: Some(true),
                }),
                opt_out_notifications: Some(vec!["status".to_string()]),
                subscription_count: 1,
                attached_subscription_count: 1,
                controller_lease_granted: true,
                lease_expires_at: Some("2026-04-02T00:00:15Z".to_string()),
            }],
            model: Some("gpt-5.4".to_string()),
            provider: Some("openai".to_string()),
            session_id: Some("session-1".to_string()),
            cwd: Some("/tmp/project".to_string()),
            git_branch: Some("main".to_string()),
            current_response: Some(StreamingResponse {
                response_id: "resp-1".to_string(),
                text: "Hello".to_string(),
                thinking: "Thinking".to_string(),
                usage: None,
            }),
            pending_approvals: vec![PendingApproval {
                call_id: "call-1".to_string(),
                request_id: None,
                tool: "bash".to_string(),
                args: serde_json::json!({"cmd": "ls"}),
            }],
            pending_client_tools: vec![PendingApproval {
                call_id: "call-client".to_string(),
                request_id: None,
                tool: "artifacts".to_string(),
                args: serde_json::json!({"command": "create", "filename": "report.txt"}),
            }],
            pending_user_inputs: vec![PendingApproval {
                call_id: "call-user-input".to_string(),
                request_id: None,
                tool: "ask_user".to_string(),
                args: serde_json::json!({
                    "questions": [{
                        "header": "Stack",
                        "question": "Which schema library should we use?",
                        "options": [{
                            "label": "Zod",
                            "description": "Use Zod schemas"
                        }]
                    }]
                }),
            }],
            pending_tool_retries: vec![PendingApproval {
                call_id: "call-retry".to_string(),
                request_id: Some("req-retry".to_string()),
                tool: "bash".to_string(),
                args: serde_json::json!({
                    "tool_call_id": "call-retry",
                    "args": {"cmd": "ls"},
                    "error_message": "command failed",
                    "attempt": 1
                }),
            }],
            tracked_tools: vec![PendingApproval {
                call_id: "call-2".to_string(),
                request_id: None,
                tool: "read".to_string(),
                args: serde_json::json!({"path": "package.json"}),
            }],
            active_tools: vec![RemoteActiveToolState {
                call_id: "call-2".to_string(),
                tool: "read".to_string(),
                output: "partial".to_string(),
            }],
            active_utility_commands: vec![RemoteActiveUtilityCommandState {
                command_id: "cmd-1".to_string(),
                command: "echo hi".to_string(),
                cwd: Some("/tmp/project".to_string()),
                shell_mode: UtilityCommandShellMode::Direct,
                terminal_mode: UtilityCommandTerminalMode::Pipe,
                pid: Some(1234),
                columns: None,
                rows: None,
                owner_connection_id: Some("conn-1".to_string()),
                output: "hi\n".to_string(),
            }],
            active_file_watches: vec![RemoteActiveFileWatchState {
                watch_id: "watch-1".to_string(),
                root_dir: "/tmp/project".to_string(),
                include_patterns: Some(vec!["src/**".to_string()]),
                exclude_patterns: Some(vec!["dist/**".to_string()]),
                debounce_ms: 100,
                owner_connection_id: Some("conn-1".to_string()),
            }],
            last_error: Some("boom".to_string()),
            last_error_type: Some(HeadlessErrorType::Tool),
            last_status: Some("Working".to_string()),
            last_response_duration_ms: Some(42),
            last_ttft_ms: Some(7),
            is_ready: true,
            is_responding: true,
        };

        let state = snapshot.into_agent_state();
        assert_eq!(state.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(state.provider.as_deref(), Some("openai"));
        assert_eq!(state.client_protocol_version.as_deref(), Some("2026-03-30"));
        assert_eq!(
            state.client_info.as_ref().map(|info| info.name.as_str()),
            Some("maestro-tui-rs")
        );
        assert_eq!(
            state
                .opt_out_notifications
                .as_ref()
                .map(|items| items.len()),
            Some(1)
        );
        assert_eq!(state.pending_approvals.len(), 1);
        assert_eq!(state.pending_client_tools.len(), 1);
        assert_eq!(state.pending_user_inputs.len(), 1);
        assert_eq!(state.pending_tool_retries.len(), 1);
        assert_eq!(state.subscriber_count, 2);
        assert_eq!(
            state.controller_subscription_id.as_deref(),
            Some("sub_remote")
        );
        assert_eq!(state.tracked_tools.len(), 1);
        assert_eq!(state.active_tools.len(), 1);
        assert_eq!(state.active_utility_commands.len(), 1);
        assert_eq!(state.active_file_watches.len(), 1);
        assert_eq!(
            state
                .active_utility_commands
                .get("cmd-1")
                .and_then(|command| command.owner_connection_id.as_deref()),
            Some("conn-1")
        );
        assert_eq!(
            state
                .active_file_watches
                .get("watch-1")
                .and_then(|watch| watch.owner_connection_id.as_deref()),
            Some("conn-1")
        );
        assert_eq!(state.last_error.as_deref(), Some("boom"));
        assert_eq!(state.last_status.as_deref(), Some("Working"));
        assert!(state.is_ready);
        assert!(state.is_responding);
    }

    #[test]
    fn remote_connection_create_request_serializes_client_tool_flags() {
        let request = RemoteConnectionCreateRequest {
            protocol_version: Some("2026-03-30".to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            session_id: Some("sess_remote".to_string()),
            connection_id: Some("conn_remote".to_string()),
            model: Some("gpt-5.4".to_string()),
            thinking_level: Some(ThinkingLevel::Low),
            approval_mode: Some(ApprovalMode::Prompt),
            enable_client_tools: true,
            capabilities: Some(RemoteClientCapabilities {
                server_requests: vec!["approval", "client_tool", "user_input", "tool_retry"],
                utility_operations: vec!["command_exec"],
                raw_agent_events: true,
            }),
            opt_out_notifications: vec!["status".to_string()],
            client: Some("vscode".to_string()),
            role: Some("controller".to_string()),
            take_control: true,
        };

        let json = serde_json::to_value(request).expect("serialize request");
        assert_eq!(json["protocolVersion"], "2026-03-30");
        assert_eq!(json["clientInfo"]["name"], "maestro-tui-rs");
        assert_eq!(json["clientInfo"]["version"], "0.1.0");
        assert_eq!(json["sessionId"], "sess_remote");
        assert_eq!(json["connectionId"], "conn_remote");
        assert_eq!(json["model"], "gpt-5.4");
        assert_eq!(json["thinkingLevel"], "low");
        assert_eq!(json["approvalMode"], "prompt");
        assert_eq!(json["enableClientTools"], true);
        assert_eq!(json["capabilities"]["serverRequests"][0], "approval");
        assert_eq!(json["capabilities"]["serverRequests"][1], "client_tool");
        assert_eq!(json["capabilities"]["serverRequests"][2], "user_input");
        assert_eq!(json["capabilities"]["serverRequests"][3], "tool_retry");
        assert_eq!(json["capabilities"]["rawAgentEvents"], true);
        assert_eq!(json["optOutNotifications"][0], "status");
        assert_eq!(json["client"], "vscode");
        assert_eq!(json["role"], "controller");
        assert_eq!(json["takeControl"], true);
    }

    #[test]
    fn remote_session_subscribe_request_serializes_opt_out_notifications() {
        let request = RemoteSessionSubscribeRequest {
            connection_id: Some("conn_remote".to_string()),
            protocol_version: Some("2026-04-02".to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            capabilities: Some(RemoteClientCapabilities {
                server_requests: vec!["approval", "client_tool", "user_input"],
                utility_operations: vec!["command_exec", "file_read", "file_watch"],
                raw_agent_events: true,
            }),
            role: Some("viewer".to_string()),
            opt_out_notifications: vec!["status".to_string(), "heartbeat".to_string()],
            take_control: false,
        };

        let json = serde_json::to_value(request).expect("serialize request");
        assert_eq!(json["connectionId"], "conn_remote");
        assert_eq!(json["role"], "viewer");
        assert_eq!(json["capabilities"]["rawAgentEvents"], true);
        assert_eq!(json["optOutNotifications"][0], "status");
        assert_eq!(json["optOutNotifications"][1], "heartbeat");
    }

    #[test]
    fn remote_hello_message_includes_interactive_server_requests_for_controller() {
        let message = build_remote_hello_message(&RemoteTransportConfig {
            enable_client_tools: true,
            ..RemoteTransportConfig::default()
        });

        let ToAgentMessage::Hello {
            capabilities: Some(capabilities),
            ..
        } = message
        else {
            panic!("expected hello message");
        };

        assert_eq!(
            capabilities.server_requests,
            Some(vec![
                ServerRequestType::Approval,
                ServerRequestType::ClientTool,
                ServerRequestType::UserInput,
                ServerRequestType::ToolRetry,
            ])
        );
    }

    #[test]
    fn remote_hello_message_omits_interactive_server_requests_for_viewer() {
        let message = build_remote_hello_message(&RemoteTransportConfig {
            enable_client_tools: true,
            role: Some("viewer".to_string()),
            ..RemoteTransportConfig::default()
        });

        let ToAgentMessage::Hello {
            capabilities: Some(capabilities),
            ..
        } = message
        else {
            panic!("expected hello message");
        };

        assert_eq!(
            capabilities.server_requests,
            Some(vec![
                ServerRequestType::Approval,
                ServerRequestType::ClientTool
            ])
        );
    }

    #[tokio::test]
    async fn remote_transport_retries_connection_bootstrap_without_stale_connection_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let bootstrap_attempt = Arc::new(AtomicUsize::new(0));
        let connection_requests = Arc::new(Mutex::new(Vec::new()));

        tokio::spawn({
            let bootstrap_attempt = Arc::clone(&bootstrap_attempt);
            let connection_requests = Arc::clone(&connection_requests);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };

                    tokio::spawn({
                        let bootstrap_attempt = Arc::clone(&bootstrap_attempt);
                        let connection_requests = Arc::clone(&connection_requests);
                        async move {
                            let Some((path, _headers, body)) = read_http_request(&mut socket).await
                            else {
                                return;
                            };

                            if path == "/api/headless/connections" {
                                let attempt = bootstrap_attempt.fetch_add(1, Ordering::SeqCst) + 1;
                                connection_requests.lock().await.push(body.clone());
                                let request = serde_json::from_str::<serde_json::Value>(&body)
                                    .expect("valid connection request");
                                if attempt == 1 {
                                    assert_eq!(
                                        request
                                            .get("connectionId")
                                            .and_then(serde_json::Value::as_str),
                                        Some("conn_stale")
                                    );
                                    write_http_response(
                                        &mut socket,
                                        "HTTP/1.1 404 Not Found",
                                        "application/json",
                                        r#"{"error":"Headless connection not found"}"#,
                                    )
                                    .await;
                                    return;
                                }
                                assert!(request.get("connectionId").is_none());
                                let body = serde_json::json!({
                                    "session_id": "sess_remote",
                                    "connection_id": "conn_fresh",
                                })
                                .to_string();
                                write_http_response(
                                    &mut socket,
                                    "HTTP/1.1 200 OK",
                                    "application/json",
                                    &body,
                                )
                                .await;
                                return;
                            }

                            if path.starts_with("/api/headless/sessions/")
                                && path.ends_with("/subscribe")
                            {
                                let body = serde_json::json!({
                                    "connection_id": "conn_fresh",
                                    "subscription_id": "sub_remote",
                                    "controller_connection_id": "conn_fresh",
                                    "lease_expires_at": "2026-04-02T00:00:15Z",
                                    "heartbeat_interval_ms": 15000,
                                    "snapshot": {
                                        "protocolVersion": "2026-03-30",
                                        "session_id": "sess_remote",
                                        "cursor": 0,
                                        "state": {
                                            "protocol_version": "2026-03-30",
                                            "session_id": "sess_remote",
                                            "pending_approvals": [],
                                            "active_tools": [],
                                            "active_utility_commands": [],
                                            "active_file_watches": [],
                                            "is_ready": true,
                                            "is_responding": false
                                        }
                                    }
                                })
                                .to_string();
                                write_http_response(
                                    &mut socket,
                                    "HTTP/1.1 200 OK",
                                    "application/json",
                                    &body,
                                )
                                .await;
                                return;
                            }

                            if path.starts_with("/api/headless/sessions/")
                                && path.ends_with("/disconnect")
                            {
                                write_http_response(
                                    &mut socket,
                                    "HTTP/1.1 200 OK",
                                    "application/json",
                                    r#"{"success":true,"connection_id":"conn_fresh","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                                )
                                .await;
                                return;
                            }

                            if path.starts_with("/api/headless/sessions/")
                                && path.ends_with("/heartbeat")
                            {
                                write_http_response(
                                    &mut socket,
                                    "HTTP/1.1 200 OK",
                                    "application/json",
                                    r#"{"connection_id":"conn_fresh","controller_lease_granted":true,"controller_connection_id":"conn_fresh","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":15000}"#,
                                )
                                .await;
                                return;
                            }

                            if path.starts_with("/api/headless/sessions/")
                                && path.contains("/events?")
                            {
                                let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                                let _ = socket.write_all(headers.as_bytes()).await;
                                let _ = socket.shutdown().await;
                                return;
                            }

                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 404 Not Found",
                                "text/plain",
                                "not found",
                            )
                            .await;
                        }
                    });
                }
            }
        });

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            session_id: Some("sess_remote".to_string()),
            connection_id: Some("conn_stale".to_string()),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        assert_eq!(transport.connection_id(), "conn_fresh");
        assert_eq!(connection_requests.lock().await.len(), 2);

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_classifies_bootstrap_conflict_as_non_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                return;
            };
            assert_eq!(path, "/api/headless/connections");
            write_http_response(
                &mut socket,
                "HTTP/1.1 409 Conflict",
                "application/json",
                r#"{"error":"Controller lease is already held by another connection"}"#,
            )
            .await;
        });

        let error = match RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        {
            Ok(_) => panic!("bootstrap conflict should fail"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 409,
                retryable: false,
                kind: RemoteErrorKind::ControllerLeaseConflict,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn remote_transport_classifies_generic_subscribe_404_as_non_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                        return;
                    };

                    if path == "/api/headless/connections" {
                        let body = serde_json::json!({
                            "session_id": "sess_remote",
                            "connection_id": "conn_remote",
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "application/json",
                            r#"{"error":"route not found"}"#,
                        )
                        .await;
                        return;
                    }

                    write_http_response(
                        &mut socket,
                        "HTTP/1.1 404 Not Found",
                        "text/plain",
                        "not found",
                    )
                    .await;
                });
            }
        });

        let error = match RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        {
            Ok(_) => panic!("generic subscribe 404 should fail"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: false,
                kind: RemoteErrorKind::Other,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn remote_transport_classifies_stream_404_as_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                        return;
                    };

                    if path == "/api/headless/connections" {
                        let body = serde_json::json!({
                            "session_id": "sess_remote",
                            "connection_id": "conn_remote",
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") {
                        let body = serde_json::json!({
                            "connection_id": "conn_remote",
                            "subscription_id": "sub_remote",
                            "controller_connection_id": "conn_remote",
                            "lease_expires_at": "2026-04-02T00:00:15Z",
                            "heartbeat_interval_ms": 15000,
                            "snapshot": {
                                "protocolVersion": "2026-03-30",
                                "session_id": "sess_remote",
                                "cursor": 0,
                                "state": {
                                    "protocol_version": "2026-03-30",
                                    "session_id": "sess_remote",
                                    "pending_approvals": [],
                                    "active_tools": [],
                                    "active_utility_commands": [],
                                    "active_file_watches": [],
                                    "is_ready": true,
                                    "is_responding": false
                                }
                            }
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.contains("/events?") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "application/json",
                            r#"{"error":"Headless subscriber not found"}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/disconnect")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/heartbeat") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"connection_id":"conn_remote","controller_lease_granted":true,"controller_connection_id":"conn_remote","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":15000}"#,
                        )
                        .await;
                        return;
                    }

                    write_http_response(
                        &mut socket,
                        "HTTP/1.1 404 Not Found",
                        "text/plain",
                        "not found",
                    )
                    .await;
                });
            }
        });

        let mut transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        let error = transport
            .recv_incoming()
            .await
            .expect_err("stream 404 should fail");
        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: true,
                kind: RemoteErrorKind::StaleSubscriber,
                ..
            }
        ));

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_classifies_generic_stream_404_as_non_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                        return;
                    };

                    if path == "/api/headless/connections" {
                        let body = serde_json::json!({
                            "session_id": "sess_remote",
                            "connection_id": "conn_remote",
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") {
                        let body = serde_json::json!({
                            "connection_id": "conn_remote",
                            "subscription_id": "sub_remote",
                            "controller_connection_id": "conn_remote",
                            "lease_expires_at": "2026-04-02T00:00:15Z",
                            "heartbeat_interval_ms": 15000,
                            "snapshot": {
                                "protocolVersion": "2026-03-30",
                                "session_id": "sess_remote",
                                "cursor": 0,
                                "state": {
                                    "protocol_version": "2026-03-30",
                                    "session_id": "sess_remote",
                                    "pending_approvals": [],
                                    "active_tools": [],
                                    "active_utility_commands": [],
                                    "active_file_watches": [],
                                    "is_ready": true,
                                    "is_responding": false
                                }
                            }
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.contains("/events?") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "application/json",
                            r#"{"error":"route not found"}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/disconnect")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/heartbeat") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "application/json",
                            r#"{"error":"route not found"}"#,
                        )
                        .await;
                        return;
                    }

                    write_http_response(
                        &mut socket,
                        "HTTP/1.1 404 Not Found",
                        "text/plain",
                        "not found",
                    )
                    .await;
                });
            }
        });

        let mut transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        let error = transport
            .recv_incoming()
            .await
            .expect_err("generic stream 404 should fail");
        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: false,
                kind: RemoteErrorKind::Other,
                ..
            }
        ));

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_surfaces_non_retryable_heartbeat_failures() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                        return;
                    };

                    if path == "/api/headless/connections" {
                        let body = serde_json::json!({
                            "session_id": "sess_remote",
                            "connection_id": "conn_remote",
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") {
                        let body = serde_json::json!({
                            "connection_id": "conn_remote",
                            "subscription_id": "sub_remote",
                            "controller_connection_id": "conn_remote",
                            "lease_expires_at": "2026-04-02T00:00:15Z",
                            "heartbeat_interval_ms": 1,
                            "snapshot": {
                                "protocolVersion": "2026-03-30",
                                "session_id": "sess_remote",
                                "cursor": 0,
                                "state": {
                                    "protocol_version": "2026-03-30",
                                    "session_id": "sess_remote",
                                    "pending_approvals": [],
                                    "active_tools": [],
                                    "active_utility_commands": [],
                                    "active_file_watches": [],
                                    "is_ready": true,
                                    "is_responding": false
                                }
                            }
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.contains("/events?") {
                        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                        if socket.write_all(headers.as_bytes()).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_mins(1)).await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/heartbeat") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "application/json",
                            r#"{"error":"route not found"}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/disconnect")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/unsubscribe")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true}"#,
                        )
                        .await;
                        return;
                    }

                    write_http_response(
                        &mut socket,
                        "HTTP/1.1 404 Not Found",
                        "text/plain",
                        "not found",
                    )
                    .await;
                });
            }
        });

        let mut transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");
        let cancel_token = transport.cancel_token();

        let error = tokio::time::timeout(Duration::from_secs(1), transport.recv_incoming())
            .await
            .expect("heartbeat failure should arrive before timeout")
            .expect_err("heartbeat failure should surface as an incoming error");
        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: false,
                kind: RemoteErrorKind::Other,
                ..
            }
        ));

        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
        transport.shutdown().expect("shutdown");
    }

    #[test]
    fn retryability_allows_recovery_from_stale_message_connection_errors() {
        assert_eq!(
            classify_remote_status(
                StatusCode::FORBIDDEN,
                RemoteRequestKind::Message,
                r#"{"error":"Headless connection not found"}"#,
            ),
            (true, RemoteErrorKind::StaleConnection)
        );
    }

    #[test]
    fn retryability_stops_bootstrap_connection_not_found_retries() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Bootstrap,
                r#"{"error":"Headless connection not found"}"#,
            ),
            (false, RemoteErrorKind::StaleConnection)
        );
    }

    #[test]
    fn retryability_keeps_session_not_found_retryable_after_bootstrap() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Stream,
                r#"{"error":"Headless session not found"}"#,
            ),
            (true, RemoteErrorKind::StaleSession)
        );
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Subscribe,
                r#"{"error":"Headless session not found"}"#,
            ),
            (true, RemoteErrorKind::StaleSession)
        );
    }

    #[test]
    fn retryability_stops_bootstrap_session_not_found_retries() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Bootstrap,
                r#"{"error":"Headless session not found"}"#,
            ),
            (false, RemoteErrorKind::StaleSession)
        );
    }

    #[test]
    fn retryability_keeps_controller_lease_conflicts_non_retryable() {
        assert_eq!(
            classify_remote_status(
                StatusCode::CONFLICT,
                RemoteRequestKind::Subscribe,
                r#"{"error":"Controller lease is already held by another connection"}"#,
            ),
            (false, RemoteErrorKind::ControllerLeaseConflict)
        );
    }

    #[test]
    fn retryability_classifies_structured_runtime_owner_mismatches() {
        assert_eq!(
            classify_remote_status(
                StatusCode::CONFLICT,
                RemoteRequestKind::Subscribe,
                r#"{"error":"Hosted runner is bound to Maestro session sess_owner","code":"ALREADY_EXISTS","error_type":"runtime_owned_elsewhere"}"#,
            ),
            (false, RemoteErrorKind::OwnershipConflict)
        );
        assert_eq!(
            classify_remote_status(
                StatusCode::CONFLICT,
                RemoteRequestKind::Heartbeat,
                r#"{"error":"Hosted runner is bound to Maestro session sess_owner","code":"ALREADY_EXISTS","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"runtime_owned_elsewhere","domain":"maestro.hosted_runner","metadata":{"owner_instance_id":"pod-a","maestro_session_id":"sess_owner"}}]}"#,
            ),
            (false, RemoteErrorKind::OwnershipConflict)
        );
    }

    #[test]
    fn retryability_keeps_subscriber_not_found_retryable_for_streams() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Stream,
                r#"{"error":"Headless subscriber not found"}"#,
            ),
            (true, RemoteErrorKind::StaleSubscriber)
        );
    }

    #[test]
    fn retryability_keeps_generic_stream_404s_non_retryable() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Stream,
                r#"{"error":"route not found"}"#,
            ),
            (false, RemoteErrorKind::Other)
        );
    }

    #[test]
    fn retryability_keeps_generic_heartbeat_404s_non_retryable() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Heartbeat,
                r#"{"error":"route not found"}"#,
            ),
            (false, RemoteErrorKind::Other)
        );
    }

    #[test]
    fn retryability_keeps_generic_subscribe_404s_non_retryable() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Subscribe,
                r#"{"error":"route not found"}"#,
            ),
            (false, RemoteErrorKind::Other)
        );
    }

    #[test]
    fn retryability_stops_subscriber_not_found_retries_for_subscribe() {
        assert_eq!(
            classify_remote_status(
                StatusCode::NOT_FOUND,
                RemoteRequestKind::Subscribe,
                r#"{"error":"Headless subscriber not found"}"#,
            ),
            (false, RemoteErrorKind::StaleSubscriber)
        );
    }

    #[test]
    fn retryability_keeps_generic_message_client_errors_non_retryable() {
        assert_eq!(
            classify_remote_status(
                StatusCode::BAD_REQUEST,
                RemoteRequestKind::Message,
                r#"{"error":"bad request"}"#,
            ),
            (false, RemoteErrorKind::Other)
        );
    }

    #[test]
    fn writer_retry_budget_ignores_stale_reference_errors() {
        assert!(!should_retry_message_error(
            &AsyncTransportError::RemoteStatus {
                status: 404,
                message: "remote request failed with status 404: Headless connection not found"
                    .to_string(),
                retryable: true,
                kind: RemoteErrorKind::StaleConnection,
            }
        ));
        assert!(!should_retry_message_error(
            &AsyncTransportError::RemoteStatus {
                status: 404,
                message: "remote request failed with status 404: Headless session not found"
                    .to_string(),
                retryable: true,
                kind: RemoteErrorKind::StaleSession,
            }
        ));
        assert!(!should_retry_message_error(
            &AsyncTransportError::RemoteStatus {
                status: 404,
                message: "remote request failed with status 404: Headless subscriber not found"
                    .to_string(),
                retryable: true,
                kind: RemoteErrorKind::StaleSubscriber,
            }
        ));
    }

    #[tokio::test]
    async fn remote_transport_connects_sends_and_receives_events() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "last_init": {
                "system_prompt": "Be terse",
                "thinking_level": "high",
                "approval_mode": "prompt"
            },
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "cwd": "/tmp/project",
                "git_branch": "main",
                "pending_approvals": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let hello_ok_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "hello_ok",
                "protocol_version": "2026-04-03",
                "connection_id": "conn_remote",
                "client_protocol_version": "2026-04-03",
                "client_info": {
                    "name": "maestro-tui-rs",
                    "version": "1.0.0"
                },
                "capabilities": {
                    "server_requests": ["approval"],
                    "utility_operations": ["command_exec", "file_search", "file_read", "file_watch"],
                    "raw_agent_events": false
                },
                "role": "controller",
                "controller_connection_id": "conn_remote"
            }
        })
        .to_string();
        let message_event = serde_json::json!({
            "type": "message",
            "cursor": 3,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();

        let (addr, posted_bodies, request_paths, request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), vec![hello_ok_event, message_event])
                .await;

        let mut config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            api_key: Some("secret".to_string()),
            ..RemoteTransportConfig::default()
        };
        config
            .headers
            .insert("x-maestro-client".to_string(), "tui-rs".to_string());

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();
        assert_eq!(transport.session_id(), "sess_remote");
        assert_eq!(transport.subscription_id(), "sub_remote");
        assert_eq!(transport.state().model.as_deref(), Some("gpt-5.4"));
        assert_eq!(transport.state().provider.as_deref(), Some("openai"));
        assert_eq!(transport.state().last_status.as_deref(), Some("Attached"));
        assert_eq!(
            transport
                .last_init()
                .and_then(|init| init.system_prompt.as_deref()),
            Some("Be terse")
        );

        let posted = wait_for_posted_bodies_len(&posted_bodies, 1).await;
        assert_eq!(posted.len(), 1);
        let sent = serde_json::from_str::<ToAgentMessage>(&posted[0]).expect("parse sent message");
        assert!(matches!(
            sent,
            ToAgentMessage::Hello {
                protocol_version,
                client_info,
                capabilities,
                role,
                ..
            } if protocol_version.as_deref() == Some(HEADLESS_PROTOCOL_VERSION)
                && client_info.as_ref().map(|info| info.name.as_str()) == Some("maestro-tui-rs")
                && capabilities.as_ref().and_then(|items| items.server_requests.as_ref()) == Some(&vec![
                    ServerRequestType::Approval,
                    ServerRequestType::UserInput,
                    ServerRequestType::ToolRetry,
                ])
                && role == Some(ConnectionRole::Controller)
        ));

        let incoming = transport.recv_incoming().await.expect("incoming hello_ok");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::HelloOk {
                connection_id,
                controller_connection_id,
                ..
            }) => {
                assert_eq!(connection_id.as_deref(), Some("conn_remote"));
                assert_eq!(controller_connection_id.as_deref(), Some("conn_remote"));
            }
            other => panic!("expected remote hello_ok, got {other:?}"),
        }
        assert_eq!(
            transport.state().client_protocol_version.as_deref(),
            Some("2026-04-03")
        );
        assert_eq!(
            transport.state().controller_connection_id.as_deref(),
            Some("conn_remote")
        );

        let incoming = transport
            .recv_incoming()
            .await
            .expect("incoming status event");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                assert_eq!(message, "Remote update");
            }
            other => panic!("expected remote status message, got {other:?}"),
        }
        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Remote update")
        );

        transport
            .send(ToAgentMessage::Interrupt)
            .expect("send interrupt");

        let posted = wait_for_posted_bodies_len(&posted_bodies, 2).await;
        assert_eq!(posted.len(), 2);
        let sent = serde_json::from_str::<ToAgentMessage>(&posted[1]).expect("parse sent message");
        assert!(matches!(sent, ToAgentMessage::Interrupt));

        let headers = request_headers.lock().await.clone();
        let connection_headers = headers.first().expect("connection request headers");
        let subscribe_headers = headers.get(1).expect("subscribe request headers");
        let message_headers = headers.iter().find(|entry| {
            entry.iter().any(|(name, value)| {
                name == "x-maestro-headless-subscriber-id" && value == "sub_remote"
            })
        });
        assert!(connection_headers
            .iter()
            .any(|(name, value)| { name == "authorization" && value == "Bearer secret" }));
        assert!(connection_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-client" && value == "tui-rs" }));
        assert!(connection_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-headless-role" && value == "controller" }));
        assert!(connection_headers
            .iter()
            .any(|(name, value)| { name == "x-composer-headless-role" && value == "controller" }));
        assert!(subscribe_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-headless-role" && value == "controller" }));
        assert!(message_headers.is_some());

        transport.shutdown().expect("shutdown");

        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let posted = posted_bodies.lock().await.clone();
        assert_eq!(posted.len(), 2);

        let paths = request_paths.lock().await.clone();
        assert!(
            paths.iter().any(|path| path.ends_with("/disconnect")),
            "expected remote shutdown to disconnect the explicit connection without shutting down the runtime"
        );
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_viewer_transport_rejects_controller_messages() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });

        let (addr, posted_bodies, request_paths, _request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            role: Some("viewer".to_string()),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(posted_bodies.lock().await.is_empty());
        assert!(
            request_paths
                .lock()
                .await
                .iter()
                .all(|path| !path.ends_with("/messages")),
            "viewer connect should not post a bootstrap hello message"
        );

        let prompt_error = transport
            .send(ToAgentMessage::Prompt {
                content: "viewer should stay read-only".to_string(),
                attachments: None,
            })
            .expect_err("viewer prompt should be rejected");
        assert!(matches!(
            prompt_error,
            AsyncTransportError::SendFailed(ref message)
                if message.contains("viewer connections cannot send remote session messages")
        ));

        let interrupt_error = transport
            .send(ToAgentMessage::Interrupt)
            .expect_err("viewer interrupt should be rejected");
        assert!(matches!(
            interrupt_error,
            AsyncTransportError::SendFailed(ref message)
                if message.contains("viewer connections cannot send remote session messages")
        ));

        let cancel_error = transport
            .send(ToAgentMessage::Cancel)
            .expect_err("viewer cancel should be rejected");
        assert!(matches!(
            cancel_error,
            AsyncTransportError::SendFailed(ref message)
                if message.contains("viewer connections cannot send remote session messages")
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(posted_bodies.lock().await.is_empty());

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_updates_cached_state_on_snapshot_events() {
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "last_init": {
                "system_prompt": "Initial prompt"
            },
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let snapshot_event = serde_json::json!({
            "type": "snapshot",
            "snapshot": {
                "protocolVersion": "2026-03-30",
                "session_id": "sess_remote",
                "cursor": 2,
                "last_init": {
                    "system_prompt": "Updated prompt"
                },
                "state": {
                    "protocol_version": "2026-03-30",
                    "model": "gpt-5.4",
                    "provider": "openai",
                    "session_id": "sess_remote",
                    "pending_approvals": [],
                    "tracked_tools": [],
                    "active_tools": [],
                    "last_status": "Replayed snapshot",
                    "is_ready": true,
                    "is_responding": false
                }
            }
        })
        .to_string();

        let (addr, _posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(initial_snapshot.to_string(), vec![snapshot_event]).await;

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();
        assert_eq!(transport.state().last_status.as_deref(), Some("Attached"));
        assert_eq!(
            transport
                .last_init()
                .and_then(|init| init.system_prompt.as_deref()),
            Some("Initial prompt")
        );

        let incoming = transport.recv_incoming().await.expect("incoming snapshot");
        match incoming {
            RemoteIncoming::Snapshot { .. } => {}
            other => panic!("expected remote snapshot, got {other:?}"),
        }

        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Replayed snapshot")
        );
        assert_eq!(
            transport
                .last_init()
                .and_then(|init| init.system_prompt.as_deref()),
            Some("Updated prompt")
        );

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_ignores_replayed_events_that_do_not_advance_cursor() {
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let first_status_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();
        let replayed_status_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "stale replay"
            }
        })
        .to_string();
        let heartbeat_event = serde_json::json!({
            "type": "heartbeat",
            "cursor": 3
        })
        .to_string();

        let (addr, _posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(
                initial_snapshot.to_string(),
                vec![first_status_event, replayed_status_event, heartbeat_event],
            )
            .await;

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();

        let incoming = transport
            .recv_incoming()
            .await
            .expect("incoming status event");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                assert_eq!(message, "Remote update");
            }
            other => panic!("expected remote status message, got {other:?}"),
        }

        let incoming = transport.recv_incoming().await.expect("incoming heartbeat");
        assert!(matches!(incoming, RemoteIncoming::Heartbeat));
        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Remote update")
        );
        assert!(transport.try_recv_incoming().is_none());

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_accepts_heartbeat_without_cursor_advance() {
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let first_status_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();
        let nonadvancing_heartbeat_event = serde_json::json!({
            "type": "heartbeat",
            "cursor": 2
        })
        .to_string();

        let (addr, _posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(
                initial_snapshot.to_string(),
                vec![first_status_event, nonadvancing_heartbeat_event],
            )
            .await;

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();

        let incoming = transport
            .recv_incoming()
            .await
            .expect("incoming status event");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                assert_eq!(message, "Remote update");
            }
            other => panic!("expected remote status message, got {other:?}"),
        }

        let incoming = transport.recv_incoming().await.expect("incoming heartbeat");
        assert!(matches!(incoming, RemoteIncoming::Heartbeat));
        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Remote update")
        );

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_synthesizes_liveness_when_stream_heartbeats_are_opted_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Some((path, _headers, _body)) = read_http_request(&mut socket).await else {
                        return;
                    };

                    if path == "/api/headless/connections" {
                        let body = serde_json::json!({
                            "session_id": "sess_remote",
                            "connection_id": "conn_remote",
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") {
                        let body = serde_json::json!({
                            "connection_id": "conn_remote",
                            "subscription_id": "sub_remote",
                            "controller_connection_id": "conn_remote",
                            "lease_expires_at": "2026-04-02T00:00:15Z",
                            "heartbeat_interval_ms": 1,
                            "snapshot": {
                                "protocolVersion": "2026-03-30",
                                "session_id": "sess_remote",
                                "cursor": 0,
                                "state": {
                                    "protocol_version": "2026-03-30",
                                    "session_id": "sess_remote",
                                    "pending_approvals": [],
                                    "active_tools": [],
                                    "active_utility_commands": [],
                                    "active_file_watches": [],
                                    "is_ready": true,
                                    "is_responding": false
                                }
                            }
                        })
                        .to_string();
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            &body,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.contains("/events?") {
                        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                        if socket.write_all(headers.as_bytes()).await.is_err() {
                            return;
                        }
                        let status_event = serde_json::json!({
                            "type": "message",
                            "cursor": 1,
                            "message": {
                                "type": "status",
                                "message": "Remote update"
                            }
                        });
                        let payload = format!("data: {status_event}\n\n");
                        if socket.write_all(payload.as_bytes()).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_mins(1)).await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/heartbeat") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"connection_id":"conn_remote","controller_lease_granted":true,"controller_connection_id":"conn_remote","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":25}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/messages") {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/disconnect")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                        )
                        .await;
                        return;
                    }

                    if path.starts_with("/api/headless/sessions/") && path.ends_with("/unsubscribe")
                    {
                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            r#"{"success":true}"#,
                        )
                        .await;
                        return;
                    }

                    write_http_response(
                        &mut socket,
                        "HTTP/1.1 404 Not Found",
                        "text/plain",
                        "not found",
                    )
                    .await;
                });
            }
        });

        let mut transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            opt_out_notifications: vec!["heartbeat".to_string()],
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");
        let cancel_token = transport.cancel_token();

        let mut saw_status = false;
        let mut saw_heartbeat = false;
        for _ in 0..3 {
            let incoming = tokio::time::timeout(Duration::from_secs(1), transport.recv_incoming())
                .await
                .expect("remote status or synthetic heartbeat should arrive before timeout")
                .expect("remote status or synthetic heartbeat should be delivered");
            match incoming {
                RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                    assert_eq!(message, "Remote update");
                    saw_status = true;
                }
                RemoteIncoming::Heartbeat => {
                    saw_heartbeat = true;
                }
                other => panic!("expected remote status or heartbeat, got {other:?}"),
            }

            if saw_status && saw_heartbeat {
                break;
            }
        }
        assert!(saw_status, "expected streamed status event");
        assert!(saw_heartbeat, "expected synthetic heartbeat event");
        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Remote update")
        );

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_ignores_malformed_events_and_keeps_streaming() {
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let first_status_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();
        let malformed_event = "{\"type\":\"message\",\"cursor\":3,\"message\":".to_string();
        let heartbeat_event = serde_json::json!({
            "type": "heartbeat",
            "cursor": 4
        })
        .to_string();

        let (addr, _posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(
                initial_snapshot.to_string(),
                vec![first_status_event, malformed_event, heartbeat_event],
            )
            .await;

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();

        let incoming = transport
            .recv_incoming()
            .await
            .expect("incoming status event");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                assert_eq!(message, "Remote update");
            }
            other => panic!("expected remote status message, got {other:?}"),
        }

        let incoming = transport.recv_incoming().await.expect("incoming heartbeat");
        assert!(matches!(incoming, RemoteIncoming::Heartbeat));
        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Remote update")
        );

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_reader_exits_after_malformed_event_when_receiver_is_dropped() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let server_handle = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let Some((_path, _headers, _body)) = read_http_request(&mut socket).await else {
                return;
            };

            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
            if socket.write_all(headers.as_bytes()).await.is_err() {
                return;
            }

            let malformed_event = "data: {\"type\":\"message\",\"cursor\":1,\"message\":\n\n";
            if socket.write_all(malformed_event.as_bytes()).await.is_err() {
                return;
            }

            tokio::time::sleep(Duration::from_mins(1)).await;
        });

        let (event_tx, event_rx) =
            mpsc::unbounded_channel::<Result<RemoteIncoming, AsyncTransportError>>();
        drop(event_rx);

        let cancel = CancellationToken::new();
        tokio::time::timeout(
            Duration::from_secs(1),
            reader_loop(
                Client::new(),
                RemoteTransportConfig {
                    base_url: format!("http://{addr}"),
                    ..RemoteTransportConfig::default()
                },
                "sess_remote".to_string(),
                "sub_remote".to_string(),
                0,
                event_tx,
                cancel.clone(),
            ),
        )
        .await
        .expect("reader loop should exit once the consumer channel is dropped");

        cancel.cancel();
        server_handle.abort();
        let _ = server_handle.await;
    }

    #[tokio::test]
    async fn remote_transport_surfaces_stream_closure_without_internal_reader_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let request_paths = Arc::new(Mutex::new(Vec::new()));
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let status_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();
        tokio::spawn({
            let request_paths = Arc::clone(&request_paths);
            let snapshot_json = initial_snapshot.to_string();
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let request_paths = Arc::clone(&request_paths);
                    let snapshot_json = snapshot_json.clone();
                    let status_event = status_event.clone();
                    tokio::spawn(async move {
                        let Some((path, _headers, _body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        request_paths.lock().await.push(path.clone());

                        if path == "/api/headless/connections" {
                            let body = serde_json::json!({
                                "session_id": "sess_remote",
                                "connection_id": "conn_remote",
                                "controller_connection_id": "conn_remote",
                                "lease_expires_at": "2026-04-02T00:00:15Z",
                                "heartbeat_interval_ms": 15000,
                                "snapshot": serde_json::from_str::<serde_json::Value>(&snapshot_json)
                                    .expect("valid snapshot json"),
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/subscribe")
                        {
                            let body = serde_json::json!({
                                "connection_id": "conn_remote",
                                "subscription_id": "sub_remote",
                                "controller_connection_id": "conn_remote",
                                "lease_expires_at": "2026-04-02T00:00:15Z",
                                "heartbeat_interval_ms": 15000,
                                "snapshot": serde_json::from_str::<serde_json::Value>(&snapshot_json)
                                    .expect("valid snapshot json"),
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/disconnect")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/heartbeat")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"connection_id":"conn_remote","controller_lease_granted":true,"controller_connection_id":"conn_remote","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":15000}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/messages")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/") && path.contains("/events?")
                        {
                            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
                            if socket.write_all(headers.as_bytes()).await.is_err() {
                                return;
                            }
                            let payload = format!("data: {status_event}\n\n");
                            let _ = socket.write_all(payload.as_bytes()).await;
                            let _ = socket.shutdown().await;
                            return;
                        }

                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "text/plain",
                            "not found",
                        )
                        .await;
                    });
                }
            }
        });

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");
        let cancel_token = transport.cancel_token();

        let incoming = transport
            .recv_incoming()
            .await
            .expect("incoming status event");
        match incoming {
            RemoteIncoming::Message(FromAgentMessage::Status { message }) => {
                assert_eq!(message, "Remote update");
            }
            other => panic!("expected remote status message, got {other:?}"),
        }

        let error = transport
            .recv_incoming()
            .await
            .expect_err("stream closure should surface as an incoming error");
        assert!(
            matches!(error, AsyncTransportError::Remote(message) if message.contains("closed after emitting data"))
        );

        tokio::time::sleep(Duration::from_millis(25)).await;
        let paths = request_paths.lock().await.clone();
        let event_requests = paths
            .iter()
            .filter(|path| path.contains("/events?"))
            .count();
        assert_eq!(
            event_requests, 1,
            "reader loop should not retry /events internally"
        );

        transport.shutdown().expect("shutdown");
        for _ in 0..50 {
            if cancel_token.is_cancelled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn remote_transport_sends_utility_command_resize_messages() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "active_tools": [],
                "active_utility_commands": [],
                "active_file_watches": [],
                "is_ready": true,
                "is_responding": false
            }
        });

        let (addr, posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), Vec::new()).await;

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        transport
            .resize_utility_command("cmd_pty".to_string(), 120, 40)
            .expect("send utility command resize");

        let posted = wait_for_posted_bodies_len(&posted_bodies, 2).await;
        assert_eq!(posted.len(), 2);
        let sent = serde_json::from_str::<ToAgentMessage>(&posted[1]).expect("parse sent message");
        assert!(matches!(
            sent,
            ToAgentMessage::UtilityCommandResize {
                command_id,
                columns,
                rows,
            } if command_id == "cmd_pty" && columns == 120 && rows == 40
        ));

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_retries_retryable_message_post_failures() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "active_tools": [],
                "active_utility_commands": [],
                "active_file_watches": [],
                "is_ready": true,
                "is_responding": false
            }
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let posted_bodies = Arc::new(Mutex::new(Vec::new()));
        let interrupt_attempts = Arc::new(AtomicUsize::new(0));

        tokio::spawn({
            let posted_bodies = Arc::clone(&posted_bodies);
            let interrupt_attempts = Arc::clone(&interrupt_attempts);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let posted_bodies = Arc::clone(&posted_bodies);
                    let interrupt_attempts = Arc::clone(&interrupt_attempts);
                    let snapshot = snapshot.clone();

                    tokio::spawn(async move {
                        let Some((path, _headers, body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };

                        if path == "/api/headless/connections" {
                            let body = serde_json::json!({
                                "session_id": "sess_remote",
                                "connection_id": "conn_remote",
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/subscribe")
                        {
                            let body = serde_json::json!({
                                "connection_id": "conn_remote",
                                "subscription_id": "sub_remote",
                                "controller_connection_id": "conn_remote",
                                "lease_expires_at": "2026-04-02T00:00:15Z",
                                "heartbeat_interval_ms": 15000,
                                "snapshot": snapshot,
                            })
                            .to_string();
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &body,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/disconnect")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true,"connection_id":"conn_remote","controller_connection_id":null,"disconnected_subscription_ids":["sub_remote"]}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/heartbeat")
                        {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"connection_id":"conn_remote","controller_lease_granted":true,"controller_connection_id":"conn_remote","lease_expires_at":"2026-04-02T00:00:15Z","heartbeat_interval_ms":15000}"#,
                            )
                            .await;
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/") && path.contains("/events?")
                        {
                            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                            let _ = socket.write_all(headers.as_bytes()).await;
                            let (_tx, mut rx) = mpsc::unbounded_channel::<String>();
                            while let Some(event) = rx.recv().await {
                                let payload = format!("data: {event}\n\n");
                                if socket.write_all(payload.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            return;
                        }

                        if path.starts_with("/api/headless/sessions/")
                            && path.ends_with("/messages")
                        {
                            posted_bodies.lock().await.push(body.clone());
                            let message = serde_json::from_str::<ToAgentMessage>(&body)
                                .expect("valid outbound message");
                            if matches!(message, ToAgentMessage::Interrupt) {
                                let attempt = interrupt_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                                if attempt == 1 {
                                    write_http_response(
                                        &mut socket,
                                        "HTTP/1.1 500 Internal Server Error",
                                        "application/json",
                                        r#"{"error":"temporary upstream failure"}"#,
                                    )
                                    .await;
                                    return;
                                }
                            }

                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                r#"{"success":true}"#,
                            )
                            .await;
                            return;
                        }

                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 404 Not Found",
                            "text/plain",
                            "not found",
                        )
                        .await;
                    });
                }
            }
        });

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        transport
            .send(ToAgentMessage::Interrupt)
            .expect("send interrupt");

        let posted = wait_for_posted_bodies_len(&posted_bodies, 3).await;
        assert_eq!(interrupt_attempts.load(Ordering::SeqCst), 2);
        assert!(matches!(
            serde_json::from_str::<ToAgentMessage>(&posted[1]).expect("parse retryable interrupt"),
            ToAgentMessage::Interrupt
        ));
        assert!(matches!(
            serde_json::from_str::<ToAgentMessage>(&posted[2]).expect("parse successful retry"),
            ToAgentMessage::Interrupt
        ));

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_sends_utility_file_read_messages() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "state": {
                "protocol_version": "2026-03-30",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "active_tools": [],
                "active_utility_commands": [],
                "active_file_watches": [],
                "is_ready": true,
                "is_responding": false
            }
        });

        let (addr, posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), Vec::new()).await;

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        transport
            .read_file(
                "read_src".to_string(),
                "src/main.rs".to_string(),
                Some("/tmp/project".to_string()),
                Some(10),
                Some(25),
            )
            .expect("send utility file read");

        let posted = wait_for_posted_bodies_len(&posted_bodies, 2).await;
        assert_eq!(posted.len(), 2);
        let sent = serde_json::from_str::<ToAgentMessage>(&posted[1]).expect("parse sent message");
        assert!(matches!(
            sent,
            ToAgentMessage::UtilityFileRead {
                read_id,
                path,
                cwd,
                offset,
                limit,
            } if read_id == "read_src"
                && path == "src/main.rs"
                && cwd.as_deref() == Some("/tmp/project")
                && offset == Some(10)
                && limit == Some(25)
        ));

        transport.shutdown().expect("shutdown");
    }

    #[tokio::test]
    async fn remote_transport_applies_reset_events_as_snapshots() {
        let initial_snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 1,
            "last_init": {
                "system_prompt": "Initial prompt"
            },
            "state": {
                "protocol_version": "2026-03-30",
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "sess_remote",
                "pending_approvals": [],
                "tracked_tools": [],
                "active_tools": [],
                "last_status": "Attached",
                "is_ready": true,
                "is_responding": false
            }
        });
        let reset_event = serde_json::json!({
            "type": "reset",
            "reason": "lagged",
            "snapshot": {
                "protocolVersion": "2026-03-30",
                "session_id": "sess_remote",
                "cursor": 2,
                "last_init": {
                    "system_prompt": "Reset prompt"
                },
                "state": {
                    "protocol_version": "2026-03-30",
                    "model": "gpt-5.4",
                    "provider": "openai",
                    "session_id": "sess_remote",
                    "pending_approvals": [],
                    "tracked_tools": [],
                    "active_tools": [],
                    "last_status": "Reset snapshot",
                    "is_ready": true,
                    "is_responding": false
                }
            }
        })
        .to_string();

        let (addr, _posted_bodies, _request_paths, _request_headers) =
            spawn_remote_headless_server(initial_snapshot.to_string(), vec![reset_event]).await;

        let config = RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        };

        let mut transport = RemoteAgentTransport::connect(config)
            .await
            .expect("connect");

        let incoming = transport.recv_incoming().await.expect("incoming reset");
        match incoming {
            RemoteIncoming::Reset { reason, .. } => {
                assert_eq!(reason, "lagged");
            }
            other => panic!("expected remote reset, got {other:?}"),
        }

        assert_eq!(
            transport.state().last_status.as_deref(),
            Some("Reset snapshot")
        );
        assert_eq!(
            transport
                .last_init()
                .and_then(|init| init.system_prompt.as_deref()),
            Some("Reset prompt")
        );
    }
}

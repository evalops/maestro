//! Remote HTTP/SSE transport for headless sessions.
//!
//! This transport attaches to a long-lived headless runtime exposed by the
//! Maestro web server. It uses HTTP POST for outbound control messages and an
//! SSE subscription for replayable inbound events.

use std::collections::HashMap;
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

use super::async_transport::AsyncTransportError;
use super::messages::{
    ActiveFileWatch, ActiveUtilityCommand, AgentState, ApprovalMode, ClientCapabilities,
    ClientInfo, ConnectionRole, ConnectionState, FromAgentMessage, HeadlessErrorType, InitConfig,
    PendingApproval, StreamingResponse, ThinkingLevel, ToAgentMessage, UtilityCommandShellMode,
};

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
    /// Whether to enable runtime file watching on the shared control plane.
    pub enable_file_watch: bool,
    /// Optional client flavor used to select client-specific tools.
    pub client: Option<String>,
    /// Optional human-readable client name for handshake metadata.
    pub client_name: String,
    /// Optional human-readable client version for handshake metadata.
    pub client_version: Option<String>,
    /// Optional connection role used for HTTP attach/message permissions.
    pub role: Option<String>,
    /// Whether a controller subscription should take over an existing controller lease.
    pub take_control: bool,
    /// Additional headers to send on every request.
    pub headers: HashMap<String, String>,
    /// Delay between SSE reconnect attempts.
    pub reconnect_delay: Duration,
}

impl Default for RemoteTransportConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8080".to_string(),
            api_key: None,
            csrf_token: None,
            session_id: None,
            model: None,
            thinking_level: None,
            approval_mode: None,
            enable_client_tools: false,
            enable_command_exec: true,
            enable_file_search: true,
            enable_file_watch: true,
            client: None,
            client_name: "maestro-tui-rs".to_string(),
            client_version: option_env!("CARGO_PKG_VERSION").map(str::to_string),
            role: Some("controller".to_string()),
            take_control: false,
            headers: HashMap::new(),
            reconnect_delay: Duration::from_millis(500),
        }
    }
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
struct RemoteSessionCreateRequest {
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo", skip_serializing_if = "Option::is_none")]
    client_info: Option<ClientInfo>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

#[derive(Debug, Serialize)]
struct RemoteClientCapabilities {
    #[serde(rename = "serverRequests")]
    server_requests: Vec<&'static str>,
    #[serde(rename = "utilityOperations", skip_serializing_if = "Vec::is_empty")]
    utility_operations: Vec<&'static str>,
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
    #[serde(default)]
    pid: Option<u32>,
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
                            pid: command.pid,
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

impl RemoteAgentTransport {
    /// Connect to a remote headless session and begin streaming events.
    pub async fn connect(config: RemoteTransportConfig) -> Result<Self, AsyncTransportError> {
        let client = Client::builder()
            .build()
            .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

        let attached_session = create_or_attach_session(&client, &config).await?;
        let bootstrap_connection_id = attached_session
            .state
            .connections
            .first()
            .map(|connection| connection.connection_id.clone());
        let subscription = subscribe_to_session(
            &client,
            &config,
            &attached_session.session_id,
            bootstrap_connection_id.as_deref(),
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
                client,
                config: config.clone(),
                session_id: session_id.clone(),
                connection_id: connection_id.clone(),
                subscription_id: subscription_id.clone(),
                event_tx,
                cancel: writer_cancel,
            },
            message_rx,
        ));
        let heartbeat_handle = tokio::spawn(heartbeat_loop(
            Client::builder()
                .build()
                .map_err(|error| AsyncTransportError::Remote(error.to_string()))?,
            config.clone(),
            session_id.clone(),
            connection_id.clone(),
            subscription_id.clone(),
            heartbeat_interval,
            heartbeat_cancel,
        ));

        Ok(Self {
            message_tx,
            event_rx,
            cancel_token,
            session_id,
            connection_id,
            subscription_id,
            heartbeat_interval,
            state,
            last_init,
            _reader_handle: reader_handle,
            _writer_handle: writer_handle,
            _heartbeat_handle: heartbeat_handle,
        })
    }

    pub fn send(&self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        self.message_tx
            .send(msg)
            .map_err(|_| AsyncTransportError::ChannelClosed)
    }

    pub fn start_utility_command(
        &self,
        command_id: String,
        command: String,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        shell_mode: Option<UtilityCommandShellMode>,
        allow_stdin: Option<bool>,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::UtilityCommandStart {
            command_id,
            command,
            cwd,
            env,
            shell_mode,
            allow_stdin,
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
        let result = self.send(ToAgentMessage::Shutdown);
        self.cancel_token.cancel();
        result
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

    pub(super) async fn recv_incoming(&mut self) -> Result<RemoteIncoming, AsyncTransportError> {
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
    if config.enable_file_watch {
        operations.push("file_watch");
    }
    operations
}

fn build_remote_server_requests(config: &RemoteTransportConfig) -> Vec<&'static str> {
    if config.enable_client_tools {
        vec!["approval", "client_tool"]
    } else {
        vec!["approval"]
    }
}

async fn create_or_attach_session(
    client: &Client,
    config: &RemoteTransportConfig,
) -> Result<RemoteRuntimeSnapshot, AsyncTransportError> {
    let url = format!(
        "{}/api/headless/sessions",
        config.base_url.trim_end_matches('/')
    );
    let request = RemoteSessionCreateRequest {
        protocol_version: Some(super::HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: config.client_name.clone(),
            version: config.client_version.clone(),
        }),
        session_id: config.session_id.clone(),
        model: config.model.clone(),
        thinking_level: config.thinking_level,
        approval_mode: config.approval_mode,
        enable_client_tools: config.enable_client_tools,
        capabilities: Some(RemoteClientCapabilities {
            server_requests: build_remote_server_requests(config),
            utility_operations: build_remote_utility_operations(config),
        }),
        client: config.client.clone(),
        role: config.role.clone(),
    };

    let response = with_headers(client.post(url).json(&request), config, true)
        .send()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    decode_json_response(response).await
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
        }),
        role: config.role.clone(),
        take_control: config.take_control,
    };

    let response = with_headers(client.post(url).json(&request), config, true)
        .send()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    decode_json_response(response).await
}

async fn unsubscribe_from_session(
    client: &Client,
    config: &RemoteTransportConfig,
    session_id: &str,
    subscription_id: &str,
    connection_id: Option<&str>,
) {
    let url = format!(
        "{}/api/headless/sessions/{session_id}/unsubscribe",
        config.base_url.trim_end_matches('/')
    );
    let _ignored = with_headers(
        client.post(url).json(&serde_json::json!({
            "subscriptionId": subscription_id,
            "connectionId": connection_id,
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

    let _response: serde_json::Value = decode_json_response(response).await?;
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
                let should_shutdown = matches!(message, ToAgentMessage::Shutdown);
                let response = with_headers(
                    client
                        .post(&url)
                        .header("x-maestro-headless-connection-id", &connection_id)
                        .header("x-composer-headless-connection-id", &connection_id)
                        .header("x-maestro-headless-subscriber-id", &subscription_id)
                        .header("x-composer-headless-subscriber-id", &subscription_id)
                        .json(&message),
                    &config,
                    true,
                )
                .send()
                .await;

                match response {
                    Ok(response) if response.status().is_success() => {
                        if should_shutdown {
                            unsubscribe_from_session(
                                &client,
                                &config,
                                &session_id,
                                &subscription_id,
                                Some(&connection_id),
                            )
                                .await;
                            cancel.cancel();
                            break;
                        }
                    }
                    Ok(response) => {
                        let error = response_status_error(response).await;
                        let _ = event_tx.send(Err(error));
                        break;
                    }
                    Err(error) => {
                        let _ = event_tx.send(Err(AsyncTransportError::Remote(error.to_string())));
                        break;
                    }
                }
            }
        }
    }
}

async fn heartbeat_loop(
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
    connection_id: String,
    subscription_id: String,
    interval: Duration,
    cancel: CancellationToken,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            _ = ticker.tick() => {
                if heartbeat_session(
                    &client,
                    &config,
                    &session_id,
                    &connection_id,
                    &subscription_id,
                )
                .await
                .is_err()
                {
                    // Best-effort liveness extension. Reader/writer paths surface hard failures.
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
    let reconnect_delay = config.reconnect_delay;

    loop {
        if cancel.is_cancelled() {
            break;
        }

        let url = format!(
            "{}/api/headless/sessions/{session_id}/events?cursor={cursor}&subscriptionId={subscription_id}",
            config.base_url.trim_end_matches('/')
        );
        let response = match with_headers(client.get(url), &config, false).send().await {
            Ok(response) => response,
            Err(error) => {
                let _ = event_tx.send(Err(AsyncTransportError::Remote(error.to_string())));
                tokio::time::sleep(reconnect_delay).await;
                continue;
            }
        };

        if response.status() != StatusCode::OK {
            let _ = event_tx.send(Err(response_status_error(response).await));
            tokio::time::sleep(reconnect_delay).await;
            continue;
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
                                    cursor = next_cursor;
                                    if event_tx
                                        .send(Ok(RemoteIncoming::Message(*message)))
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                                Ok(RemoteEnvelope::Snapshot { snapshot }) => {
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
                                    cursor = next_cursor;
                                    if event_tx.send(Ok(RemoteIncoming::Heartbeat)).is_err() {
                                        return;
                                    }
                                }
                                Err(error) => {
                                    if event_tx
                                        .send(Err(AsyncTransportError::Remote(format!(
                                            "failed to decode remote event: {error}"
                                        ))))
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                        }
                        Some(Err(error)) => {
                            let _ = event_tx.send(Err(AsyncTransportError::Remote(error.to_string())));
                            break;
                        }
                        None => break,
                    }
                }
            }
        }

        if cancel.is_cancelled() {
            break;
        }

        if !saw_event {
            let _ = event_tx.send(Err(AsyncTransportError::Remote(
                "remote event stream closed before emitting data".to_string(),
            )));
        }

        tokio::time::sleep(reconnect_delay).await;
    }
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
) -> Result<T, AsyncTransportError> {
    if !response.status().is_success() {
        return Err(response_status_error(response).await);
    }
    response
        .json::<T>()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))
}

async fn response_status_error(response: reqwest::Response) -> AsyncTransportError {
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
    AsyncTransportError::Remote(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Arc;

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

    async fn spawn_remote_headless_server(
        snapshot_json: String,
        sse_events: Vec<String>,
    ) -> (
        std::net::SocketAddr,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<Vec<(String, String)>>>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let posted_bodies = Arc::new(Mutex::new(Vec::new()));
        let request_headers = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(VecDeque::from(sse_events)));

        tokio::spawn({
            let posted_bodies = Arc::clone(&posted_bodies);
            let request_headers = Arc::clone(&request_headers);
            let events = Arc::clone(&events);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let posted_bodies = Arc::clone(&posted_bodies);
                    let request_headers = Arc::clone(&request_headers);
                    let events = Arc::clone(&events);
                    let snapshot_json = snapshot_json.clone();

                    tokio::spawn(async move {
                        let Some((path, headers, body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        request_headers.lock().await.push(headers);

                        if path == "/api/headless/sessions" {
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 200 OK",
                                "application/json",
                                &snapshot_json,
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

        (addr, posted_bodies, request_headers)
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
                ]),
                utility_operations: Some(vec![crate::headless::UtilityOperation::CommandExec]),
            }),
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
                    ]),
                    utility_operations: Some(vec![crate::headless::UtilityOperation::CommandExec]),
                }),
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
                tool: "bash".to_string(),
                args: serde_json::json!({"cmd": "ls"}),
            }],
            pending_client_tools: vec![PendingApproval {
                call_id: "call-client".to_string(),
                tool: "artifacts".to_string(),
                args: serde_json::json!({"command": "create", "filename": "report.txt"}),
            }],
            pending_user_inputs: vec![PendingApproval {
                call_id: "call-user-input".to_string(),
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
            tracked_tools: vec![PendingApproval {
                call_id: "call-2".to_string(),
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
                pid: Some(1234),
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
        assert_eq!(state.pending_approvals.len(), 1);
        assert_eq!(state.pending_client_tools.len(), 1);
        assert_eq!(state.pending_user_inputs.len(), 1);
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
    fn remote_session_create_request_serializes_client_tool_flags() {
        let request = RemoteSessionCreateRequest {
            protocol_version: Some("2026-03-30".to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            session_id: Some("sess_remote".to_string()),
            model: Some("gpt-5.4".to_string()),
            thinking_level: Some(ThinkingLevel::Low),
            approval_mode: Some(ApprovalMode::Prompt),
            enable_client_tools: true,
            capabilities: Some(RemoteClientCapabilities {
                server_requests: vec!["approval", "client_tool"],
                utility_operations: vec!["command_exec"],
            }),
            client: Some("vscode".to_string()),
            role: Some("controller".to_string()),
        };

        let json = serde_json::to_value(request).expect("serialize request");
        assert_eq!(json["protocolVersion"], "2026-03-30");
        assert_eq!(json["clientInfo"]["name"], "maestro-tui-rs");
        assert_eq!(json["clientInfo"]["version"], "0.1.0");
        assert_eq!(json["sessionId"], "sess_remote");
        assert_eq!(json["model"], "gpt-5.4");
        assert_eq!(json["thinkingLevel"], "low");
        assert_eq!(json["approvalMode"], "prompt");
        assert_eq!(json["enableClientTools"], true);
        assert_eq!(json["capabilities"]["serverRequests"][0], "approval");
        assert_eq!(json["capabilities"]["serverRequests"][1], "client_tool");
        assert_eq!(json["client"], "vscode");
        assert_eq!(json["role"], "controller");
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
        let message_event = serde_json::json!({
            "type": "message",
            "cursor": 2,
            "message": {
                "type": "status",
                "message": "Remote update"
            }
        })
        .to_string();

        let (addr, posted_bodies, request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), vec![message_event]).await;

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

        let incoming = transport.recv_incoming().await.expect("incoming event");
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

        for _ in 0..50 {
            if !posted_bodies.lock().await.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let posted = posted_bodies.lock().await.clone();
        assert_eq!(posted.len(), 1);
        let sent = serde_json::from_str::<ToAgentMessage>(&posted[0]).expect("parse sent message");
        assert!(matches!(sent, ToAgentMessage::Interrupt));

        let headers = request_headers.lock().await.clone();
        let create_headers = headers.first().expect("create request headers");
        let subscribe_headers = headers.get(1).expect("subscribe request headers");
        let message_headers = headers.iter().find(|entry| {
            entry.iter().any(|(name, value)| {
                name == "x-maestro-headless-subscriber-id" && value == "sub_remote"
            })
        });
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "authorization" && value == "Bearer secret" }));
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-client" && value == "tui-rs" }));
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-headless-role" && value == "controller" }));
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "x-composer-headless-role" && value == "controller" }));
        assert!(subscribe_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-headless-role" && value == "controller" }));
        assert!(message_headers.is_some());

        transport.shutdown().expect("shutdown");
        assert!(cancel_token.is_cancelled());
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

        let (addr, _posted_bodies, _request_headers) =
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
        assert!(cancel_token.is_cancelled());
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

        let (addr, _posted_bodies, _request_headers) =
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

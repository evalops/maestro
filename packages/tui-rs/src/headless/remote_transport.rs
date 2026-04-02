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
    AgentState, ApprovalMode, FromAgentMessage, HeadlessErrorType, InitConfig, PendingApproval,
    StreamingResponse, ThinkingLevel, ToAgentMessage,
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
    Message(FromAgentMessage),
    Heartbeat,
}

#[derive(Debug, Serialize)]
struct RemoteSessionCreateRequest {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(rename = "thinkingLevel", skip_serializing_if = "Option::is_none")]
    thinking_level: Option<ThinkingLevel>,
    #[serde(rename = "approvalMode", skip_serializing_if = "Option::is_none")]
    approval_mode: Option<ApprovalMode>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteActiveToolState {
    call_id: String,
    tool: String,
    output: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteRuntimeStateSnapshot {
    #[serde(default)]
    protocol_version: Option<String>,
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
    active_tools: Vec<RemoteActiveToolState>,
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
            model: self.model,
            provider: self.provider,
            session_id: self.session_id,
            cwd: self.cwd,
            git_branch: self.git_branch,
            current_response: self.current_response,
            pending_approvals: self.pending_approvals,
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
    state: AgentState,
    last_init: Option<InitConfig>,
    _reader_handle: tokio::task::JoinHandle<()>,
    _writer_handle: tokio::task::JoinHandle<()>,
}

impl RemoteAgentTransport {
    /// Connect to a remote headless session and begin streaming events.
    pub async fn connect(config: RemoteTransportConfig) -> Result<Self, AsyncTransportError> {
        let client = Client::builder()
            .build()
            .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

        let snapshot = create_or_attach_session(&client, &config).await?;
        let (session_id, cursor, last_init, state) = snapshot.into_state();

        let (message_tx, message_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();
        let reader_cancel = cancel_token.clone();
        let writer_cancel = cancel_token.clone();

        let reader_handle = tokio::spawn(reader_loop(
            client.clone(),
            config.clone(),
            session_id.clone(),
            cursor,
            event_tx.clone(),
            reader_cancel,
        ));
        let writer_handle = tokio::spawn(writer_loop(
            client,
            config,
            session_id.clone(),
            message_rx,
            event_tx,
            writer_cancel,
        ));

        Ok(Self {
            message_tx,
            event_rx,
            cancel_token,
            session_id,
            state,
            last_init,
            _reader_handle: reader_handle,
            _writer_handle: writer_handle,
        })
    }

    pub fn send(&self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        self.message_tx
            .send(msg)
            .map_err(|_| AsyncTransportError::ChannelClosed)
    }

    pub fn shutdown(&self) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Shutdown)
    }

    pub(super) fn try_recv_incoming(
        &mut self,
    ) -> Option<Result<RemoteIncoming, AsyncTransportError>> {
        match self.event_rx.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::error::TryRecvError::Empty) => None,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                Some(Err(AsyncTransportError::ChannelClosed))
            }
        }
    }

    pub(super) async fn recv_incoming(&mut self) -> Result<RemoteIncoming, AsyncTransportError> {
        self.event_rx
            .recv()
            .await
            .ok_or(AsyncTransportError::ChannelClosed)?
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

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
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
        session_id: config.session_id.clone(),
        model: config.model.clone(),
        thinking_level: config.thinking_level,
        approval_mode: config.approval_mode,
    };

    let response = with_headers(client.post(url).json(&request), config, true)
        .send()
        .await
        .map_err(|error| AsyncTransportError::Remote(error.to_string()))?;

    decode_json_response(response).await
}

async fn writer_loop(
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
    mut rx: mpsc::UnboundedReceiver<ToAgentMessage>,
    event_tx: mpsc::UnboundedSender<Result<RemoteIncoming, AsyncTransportError>>,
    cancel: CancellationToken,
) {
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
                    client.post(&url).json(&message),
                    &config,
                    true,
                )
                .send()
                .await;

                match response {
                    Ok(response) if response.status().is_success() => {
                        if should_shutdown {
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

async fn reader_loop(
    client: Client,
    config: RemoteTransportConfig,
    session_id: String,
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
            "{}/api/headless/sessions/{session_id}/events?cursor={cursor}",
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
            active_tools: vec![RemoteActiveToolState {
                call_id: "call-2".to_string(),
                tool: "read".to_string(),
                output: "partial".to_string(),
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
        assert_eq!(state.pending_approvals.len(), 1);
        assert_eq!(state.active_tools.len(), 1);
        assert_eq!(state.last_error.as_deref(), Some("boom"));
        assert_eq!(state.last_status.as_deref(), Some("Working"));
        assert!(state.is_ready);
        assert!(state.is_responding);
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
        assert_eq!(transport.session_id(), "sess_remote");
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
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "authorization" && value == "Bearer secret" }));
        assert!(create_headers
            .iter()
            .any(|(name, value)| { name == "x-maestro-client" && value == "tui-rs" }));

        transport.shutdown().expect("shutdown");
        transport.cancel_token().cancel();
    }
}

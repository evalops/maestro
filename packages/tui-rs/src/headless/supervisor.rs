//! Agent supervisor with reconnection and health monitoring
//!
//! Wraps the transport layer to provide:
//! - Automatic reconnection on failure
//! - Health monitoring with heartbeats
//! - Graceful degradation

use std::path::Path;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
// Note: interval/timeout available for future health checking
use tokio_util::sync::CancellationToken;

use super::async_transport::{AsyncAgentTransport, AsyncTransportConfig, AsyncTransportError};
use super::messages::{AgentEvent, AgentState, FromAgentMessage, InitConfig, ToAgentMessage};
use super::remote_transport::{RemoteAgentTransport, RemoteIncoming, RemoteTransportConfig};
use super::session::{SessionReader, SessionRecorder, SessionReplay};

/// Supervisor configuration
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// Transport configuration
    pub transport: AsyncTransportConfig,
    /// Optional remote transport configuration.
    pub remote: Option<RemoteTransportConfig>,
    /// Maximum reconnection attempts (0 = infinite)
    pub max_reconnect_attempts: u32,
    /// Initial delay between reconnection attempts
    pub reconnect_delay: Duration,
    /// Maximum delay between reconnection attempts
    pub max_reconnect_delay: Duration,
    /// Backoff multiplier for reconnection delay
    pub backoff_multiplier: f64,
    /// Health check interval
    pub health_check_interval: Duration,
    /// Timeout for health check response
    pub health_check_timeout: Duration,
    /// Whether to automatically reconnect on failure
    pub auto_reconnect: bool,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            transport: AsyncTransportConfig::default(),
            remote: None,
            max_reconnect_attempts: 5,
            reconnect_delay: Duration::from_secs(1),
            max_reconnect_delay: Duration::from_secs(30),
            backoff_multiplier: 2.0,
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            auto_reconnect: true,
        }
    }
}

/// Current health status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    /// Agent is healthy and responding
    Healthy,
    /// Agent might be degraded (slow responses)
    Degraded,
    /// Agent is unhealthy/disconnected
    Unhealthy,
    /// Currently reconnecting
    Reconnecting,
    /// Unknown state (not yet checked)
    Unknown,
}

/// Supervisor event
#[derive(Debug, Clone)]
pub enum SupervisorEvent {
    /// Agent event (pass-through)
    Agent(Box<AgentEvent>),
    /// Connection established
    Connected,
    /// State was hydrated from replay or a remote snapshot.
    StateHydrated { session_id: Option<String> },
    /// Connection lost
    Disconnected { error: String },
    /// Reconnecting
    Reconnecting { attempt: u32, max_attempts: u32 },
    /// Health status changed
    HealthChanged { status: HealthStatus },
    /// Supervisor shutting down
    ShuttingDown,
}

enum ManagedTransport {
    Local(AsyncAgentTransport),
    Remote(RemoteAgentTransport),
}

enum ManagedIncoming {
    Message(FromAgentMessage),
    Snapshot {
        state: Box<AgentState>,
        last_init: Option<InitConfig>,
    },
    Reset {
        reason: String,
        state: Box<AgentState>,
        last_init: Option<InitConfig>,
    },
    Heartbeat,
}

impl ManagedTransport {
    fn send(&self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        match self {
            Self::Local(transport) => transport.send(msg),
            Self::Remote(transport) => transport.send(msg),
        }
    }

    fn shutdown(&self) -> Result<(), AsyncTransportError> {
        match self {
            Self::Local(transport) => transport.shutdown(),
            Self::Remote(transport) => transport.shutdown(),
        }
    }

    fn needs_init_replay(&self) -> bool {
        matches!(self, Self::Local(_))
    }

    fn initial_snapshot(&self) -> Option<(AgentState, Option<InitConfig>)> {
        match self {
            Self::Local(_) => None,
            Self::Remote(transport) => {
                Some((transport.state().clone(), transport.last_init().cloned()))
            }
        }
    }

    fn try_recv_incoming(&mut self) -> Option<Result<ManagedIncoming, AsyncTransportError>> {
        match self {
            Self::Local(transport) => transport
                .try_recv_message()
                .map(|result| result.map(ManagedIncoming::Message)),
            Self::Remote(transport) => transport.try_recv_incoming().map(|result| {
                result.map(|incoming| match incoming {
                    RemoteIncoming::Message(message) => ManagedIncoming::Message(message),
                    RemoteIncoming::Snapshot { state, last_init } => {
                        ManagedIncoming::Snapshot { state, last_init }
                    }
                    RemoteIncoming::Reset {
                        reason,
                        state,
                        last_init,
                    } => ManagedIncoming::Reset {
                        reason,
                        state,
                        last_init,
                    },
                    RemoteIncoming::Heartbeat => ManagedIncoming::Heartbeat,
                })
            }),
        }
    }

    async fn recv_incoming(&mut self) -> Result<ManagedIncoming, AsyncTransportError> {
        match self {
            Self::Local(transport) => transport.recv_message().await.map(ManagedIncoming::Message),
            Self::Remote(transport) => {
                transport
                    .recv_incoming()
                    .await
                    .map(|incoming| match incoming {
                        RemoteIncoming::Message(message) => ManagedIncoming::Message(message),
                        RemoteIncoming::Snapshot { state, last_init } => {
                            ManagedIncoming::Snapshot { state, last_init }
                        }
                        RemoteIncoming::Reset {
                            reason,
                            state,
                            last_init,
                        } => ManagedIncoming::Reset {
                            reason,
                            state,
                            last_init,
                        },
                        RemoteIncoming::Heartbeat => ManagedIncoming::Heartbeat,
                    })
            }
        }
    }

    fn local_transport(&self) -> Option<&AsyncAgentTransport> {
        match self {
            Self::Local(transport) => Some(transport),
            Self::Remote(_) => None,
        }
    }

    fn local_transport_mut(&mut self) -> Option<&mut AsyncAgentTransport> {
        match self {
            Self::Local(transport) => Some(transport),
            Self::Remote(_) => None,
        }
    }
}

/// Agent supervisor
///
/// Provides a resilient wrapper around the transport with:
/// - Automatic reconnection
/// - Health monitoring
/// - Session recording
pub struct AgentSupervisor {
    /// Configuration
    config: SupervisorConfig,
    /// Current transport (if connected)
    transport: Option<ManagedTransport>,
    /// Last init config to replay after reconnects
    last_init: Option<InitConfig>,
    /// Current supervisor-owned agent state
    state: AgentState,
    /// Event sender
    event_tx: mpsc::UnboundedSender<SupervisorEvent>,
    /// Event receiver
    event_rx: mpsc::UnboundedReceiver<SupervisorEvent>,
    /// Current health status
    health_status: HealthStatus,
    /// Last successful response time
    last_response: Option<Instant>,
    /// Reconnection attempt counter
    reconnect_attempts: u32,
    /// Session recorder (optional)
    session_recorder: Option<SessionRecorder>,
    /// Cancellation token
    cancel_token: CancellationToken,
}

impl AgentSupervisor {
    /// Create a new supervisor
    #[must_use]
    pub fn new(config: SupervisorConfig) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            config,
            transport: None,
            last_init: None,
            state: AgentState::default(),
            event_tx,
            event_rx,
            health_status: HealthStatus::Unknown,
            last_response: None,
            reconnect_attempts: 0,
            session_recorder: None,
            cancel_token: CancellationToken::new(),
        }
    }

    /// Attach a session recorder
    #[must_use]
    pub fn with_session_recorder(mut self, recorder: SessionRecorder) -> Self {
        self.session_recorder = Some(recorder);
        self
    }

    /// Seed the supervisor with a replayed session snapshot.
    #[must_use]
    pub fn with_session_replay(mut self, replay: SessionReplay) -> Self {
        self.restore_session_replay(replay);
        self
    }

    /// Restore the supervisor's saved init config and reconstructed agent state.
    pub fn restore_session_replay(&mut self, replay: SessionReplay) {
        self.state = replay.state;
        self.last_init = replay.last_init;
    }

    async fn spawn_transport(&self) -> Result<ManagedTransport, AsyncTransportError> {
        if let Some(remote) = self.config.remote.clone() {
            RemoteAgentTransport::connect(remote)
                .await
                .map(ManagedTransport::Remote)
        } else {
            AsyncAgentTransport::spawn(self.config.transport.clone())
                .await
                .map(ManagedTransport::Local)
        }
    }

    /// Connect to the agent
    pub async fn connect(&mut self) -> Result<(), AsyncTransportError> {
        let transport = self.spawn_transport().await?;
        self.set_transport(transport)?;
        self.health_status = HealthStatus::Healthy;
        self.reconnect_attempts = 0;
        let _ = self.event_tx.send(SupervisorEvent::Connected);
        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
            status: HealthStatus::Healthy,
        });
        Ok(())
    }

    /// Disconnect from the agent
    pub fn disconnect(&mut self) {
        if let Some(transport) = self.transport.take() {
            let _ = transport.shutdown();
        }
        self.health_status = HealthStatus::Unhealthy;
        let _ = self.event_tx.send(SupervisorEvent::Disconnected {
            error: "Disconnected by request".to_string(),
        });
    }

    /// Attempt reconnection with exponential backoff
    pub async fn reconnect(&mut self) -> Result<(), AsyncTransportError> {
        self.health_status = HealthStatus::Reconnecting;
        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
            status: HealthStatus::Reconnecting,
        });

        let max_attempts = self.config.max_reconnect_attempts;
        let mut delay = self.config.reconnect_delay;

        loop {
            self.reconnect_attempts += 1;

            let _ = self.event_tx.send(SupervisorEvent::Reconnecting {
                attempt: self.reconnect_attempts,
                max_attempts,
            });

            match self.spawn_transport().await {
                Ok(transport) => {
                    self.set_transport(transport)?;
                    self.health_status = HealthStatus::Healthy;
                    self.reconnect_attempts = 0;
                    let _ = self.event_tx.send(SupervisorEvent::Connected);
                    let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                        status: HealthStatus::Healthy,
                    });
                    return Ok(());
                }
                Err(e) => {
                    if max_attempts > 0 && self.reconnect_attempts >= max_attempts {
                        self.health_status = HealthStatus::Unhealthy;
                        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                            status: HealthStatus::Unhealthy,
                        });
                        return Err(e);
                    }

                    // Wait with backoff
                    tokio::time::sleep(delay).await;
                    delay = Duration::from_secs_f64(
                        (delay.as_secs_f64() * self.config.backoff_multiplier)
                            .min(self.config.max_reconnect_delay.as_secs_f64()),
                    );
                }
            }
        }
    }

    /// Send a message to the agent
    pub fn send(&mut self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        let Some(transport) = &self.transport else {
            return Err(AsyncTransportError::ChannelClosed);
        };

        transport.send(msg.clone())?;
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.record_sent(&msg);
            self.state = recorder.replay_state().clone();
            self.last_init = recorder
                .last_init()
                .cloned()
                .or_else(|| self.last_init.clone());
        } else {
            self.state.handle_sent_message(&msg);
            if let ToAgentMessage::Init {
                system_prompt,
                append_system_prompt,
                thinking_level,
                approval_mode,
            } = &msg
            {
                self.last_init = Some(InitConfig {
                    system_prompt: system_prompt.clone(),
                    append_system_prompt: append_system_prompt.clone(),
                    thinking_level: *thinking_level,
                    approval_mode: *approval_mode,
                });
            }
        }

        Ok(())
    }

    /// Send a prompt
    pub fn prompt(&mut self, content: impl Into<String>) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Prompt {
            content: content.into(),
            attachments: None,
        })
    }

    /// Configure the agent before sending prompts
    pub fn init(&mut self, config: InitConfig) -> Result<(), AsyncTransportError> {
        self.last_init = Some(config.clone());
        self.send(Self::init_message(&config))
    }

    fn replay_saved_init(&mut self) -> Result<(), AsyncTransportError> {
        if let Some(config) = self.last_init.clone() {
            self.send(Self::init_message(&config))?;
        }
        Ok(())
    }

    fn set_transport(&mut self, transport: ManagedTransport) -> Result<(), AsyncTransportError> {
        let should_replay_init = transport.needs_init_replay();
        let snapshot = transport.initial_snapshot();
        self.transport = Some(transport);
        if let Some((state, last_init)) = snapshot {
            self.apply_snapshot(state, last_init);
        }
        if should_replay_init {
            if let Err(error) = self.replay_saved_init() {
                if let Some(transport) = self.transport.take() {
                    let _ = transport.shutdown();
                }
                return Err(error);
            }
        }
        Ok(())
    }

    fn init_message(config: &InitConfig) -> ToAgentMessage {
        ToAgentMessage::Init {
            system_prompt: config.system_prompt.clone(),
            append_system_prompt: config.append_system_prompt.clone(),
            thinking_level: config.thinking_level,
            approval_mode: config.approval_mode,
        }
    }

    fn apply_snapshot(&mut self, state: AgentState, last_init: Option<InitConfig>) {
        let resolved_last_init = last_init.or_else(|| self.last_init.clone());
        self.state = state;
        self.last_init = resolved_last_init.clone();
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.apply_snapshot(self.state.clone(), resolved_last_init.clone());
        }
        let _ = self.event_tx.send(SupervisorEvent::StateHydrated {
            session_id: self.state.session_id.clone(),
        });
    }

    fn apply_agent_message(&mut self, message: FromAgentMessage) -> Option<SupervisorEvent> {
        let event = self.state.handle_message(message.clone());
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.record_received(&message);
        }
        event.map(|event| SupervisorEvent::Agent(Box::new(event)))
    }

    fn handle_transport_error(&mut self, error: AsyncTransportError) -> SupervisorEvent {
        self.transport = None;
        self.health_status = HealthStatus::Unhealthy;
        SupervisorEvent::Disconnected {
            error: error.to_string(),
        }
    }

    fn handle_transport_incoming(&mut self, incoming: ManagedIncoming) -> Option<SupervisorEvent> {
        match incoming {
            ManagedIncoming::Message(message) => {
                self.last_response = Some(Instant::now());
                self.apply_agent_message(message)
            }
            ManagedIncoming::Snapshot { state, last_init } => {
                self.last_response = Some(Instant::now());
                self.apply_snapshot(*state, last_init);
                None
            }
            ManagedIncoming::Reset {
                reason: _reason,
                state,
                last_init,
            } => {
                self.last_response = Some(Instant::now());
                self.apply_snapshot(*state, last_init);
                None
            }
            ManagedIncoming::Heartbeat => {
                self.last_response = Some(Instant::now());
                None
            }
        }
    }

    /// Poll for events (non-blocking)
    pub fn poll(&mut self) -> Option<SupervisorEvent> {
        loop {
            let next_result = match self.transport.as_mut() {
                Some(transport) => transport.try_recv_incoming(),
                None => None,
            };
            let Some(result) = next_result else {
                break;
            };
            match result {
                Ok(incoming) => {
                    if let Some(event) = self.handle_transport_incoming(incoming) {
                        return Some(event);
                    }
                }
                Err(error) => return Some(self.handle_transport_error(error)),
            }
        }

        self.event_rx.try_recv().ok()
    }

    /// Wait for the next event
    pub async fn recv(&mut self) -> Option<SupervisorEvent> {
        // Clone the cancel token to avoid borrow conflict
        let cancel_token = self.cancel_token.clone();
        tokio::select! {
            () = cancel_token.cancelled() => {
                Some(SupervisorEvent::ShuttingDown)
            }
            event = self.recv_internal() => {
                event
            }
        }
    }

    async fn recv_internal(&mut self) -> Option<SupervisorEvent> {
        if self.transport.is_some() {
            loop {
                let result = {
                    let transport = self.transport.as_mut()?;
                    transport.recv_incoming().await
                };
                match result {
                    Ok(incoming) => {
                        if let Some(event) = self.handle_transport_incoming(incoming) {
                            return Some(event);
                        }
                    }
                    Err(error) => return Some(self.handle_transport_error(error)),
                }
            }
        }

        self.event_rx.recv().await
    }

    /// Check current health status
    #[must_use]
    pub fn health(&self) -> HealthStatus {
        self.health_status
    }

    /// Check if connected
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.transport.is_some()
    }

    /// Get a reference to the current supervisor-owned agent state.
    #[must_use]
    pub fn state(&self) -> &AgentState {
        &self.state
    }

    /// Get the underlying transport (if connected)
    #[must_use]
    pub fn transport(&self) -> Option<&AsyncAgentTransport> {
        self.transport
            .as_ref()
            .and_then(ManagedTransport::local_transport)
    }

    /// Get mutable transport
    pub fn transport_mut(&mut self) -> Option<&mut AsyncAgentTransport> {
        self.transport
            .as_mut()
            .and_then(ManagedTransport::local_transport_mut)
    }

    /// Shutdown the supervisor
    pub fn shutdown(&mut self) {
        self.cancel_token.cancel();
        self.disconnect();
        let _ = self.event_tx.send(SupervisorEvent::ShuttingDown);
    }

    /// Flush session recorder
    pub fn flush_session(&mut self) -> std::io::Result<()> {
        if let Some(ref mut recorder) = self.session_recorder {
            recorder.flush()?;
        }
        Ok(())
    }
}

/// Builder for `AgentSupervisor`
pub struct SupervisorBuilder {
    config: SupervisorConfig,
    session_recorder: Option<SessionRecorder>,
    session_replay: Option<SessionReplay>,
}

impl SupervisorBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            config: SupervisorConfig::default(),
            session_recorder: None,
            session_replay: None,
        }
    }

    /// Set the CLI path
    pub fn cli_path(mut self, path: impl Into<String>) -> Self {
        self.config.transport.cli_path = path.into();
        self
    }

    /// Set working directory
    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.config.transport.cwd = Some(cwd.into());
        self
    }

    /// Attach to a remote headless runtime instead of spawning a local CLI.
    #[must_use]
    pub fn remote(mut self, config: RemoteTransportConfig) -> Self {
        self.config.remote = Some(config);
        self
    }

    /// Set the remote base URL, enabling remote transport if needed.
    #[must_use]
    pub fn remote_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.config
            .remote
            .get_or_insert_with(RemoteTransportConfig::default)
            .base_url = base_url.into();
        self
    }

    /// Set the remote API key, enabling remote transport if needed.
    #[must_use]
    pub fn remote_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.config
            .remote
            .get_or_insert_with(RemoteTransportConfig::default)
            .api_key = Some(api_key.into());
        self
    }

    /// Set the remote session id, enabling remote transport if needed.
    #[must_use]
    pub fn remote_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.config
            .remote
            .get_or_insert_with(RemoteTransportConfig::default)
            .session_id = Some(session_id.into());
        self
    }

    /// Resume a recorded local session by restoring replay state and continuing
    /// to append to the same JSONL log.
    pub fn resume_recorded_session(
        mut self,
        sessions_dir: impl AsRef<Path>,
        session_id: &str,
    ) -> std::io::Result<Self> {
        let replay = SessionReader::load(sessions_dir.as_ref(), session_id)?.replay();
        let recorder = SessionRecorder::resume(sessions_dir, session_id)?;
        self.session_replay = Some(replay);
        self.session_recorder = Some(recorder);
        Ok(self)
    }

    /// Add an argument
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.config.transport.extra_args.push(arg.into());
        self
    }

    /// Set max reconnection attempts
    #[must_use]
    pub fn max_reconnect_attempts(mut self, attempts: u32) -> Self {
        self.config.max_reconnect_attempts = attempts;
        self
    }

    /// Set initial reconnection delay
    #[must_use]
    pub fn reconnect_delay(mut self, delay: Duration) -> Self {
        self.config.reconnect_delay = delay;
        self
    }

    /// Enable/disable auto reconnect
    #[must_use]
    pub fn auto_reconnect(mut self, enabled: bool) -> Self {
        self.config.auto_reconnect = enabled;
        self
    }

    /// Attach a session recorder
    #[must_use]
    pub fn session_recorder(mut self, recorder: SessionRecorder) -> Self {
        self.session_recorder = Some(recorder);
        self
    }

    /// Seed the supervisor with a replayed session snapshot.
    #[must_use]
    pub fn session_replay(mut self, replay: SessionReplay) -> Self {
        self.session_replay = Some(replay);
        self
    }

    /// Build the supervisor
    #[must_use]
    pub fn build(self) -> AgentSupervisor {
        let mut supervisor = AgentSupervisor::new(self.config);
        if let Some(recorder) = self.session_recorder {
            supervisor = supervisor.with_session_recorder(recorder);
        }
        if let Some(replay) = self.session_replay {
            supervisor = supervisor.with_session_replay(replay);
        }
        supervisor
    }
}

impl Default for SupervisorBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
fn event_to_message(event: &AgentEvent) -> Option<FromAgentMessage> {
    match event {
        AgentEvent::Ready {
            protocol_version,
            model,
            provider,
            session_id,
        } => Some(FromAgentMessage::Ready {
            protocol_version: protocol_version.clone(),
            model: model.clone(),
            provider: provider.clone(),
            session_id: session_id.clone(),
        }),
        AgentEvent::SessionInfo {
            session_id,
            cwd,
            git_branch,
        } => Some(FromAgentMessage::SessionInfo {
            session_id: session_id.clone(),
            cwd: cwd.clone(),
            git_branch: git_branch.clone(),
        }),
        AgentEvent::ResponseStart { response_id } => Some(FromAgentMessage::ResponseStart {
            response_id: response_id.clone(),
        }),
        AgentEvent::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } => Some(FromAgentMessage::ResponseChunk {
            response_id: response_id.clone(),
            content: content.clone(),
            is_thinking: *is_thinking,
        }),
        AgentEvent::ResponseEnd {
            response_id,
            usage,
            tools_summary,
            duration_ms,
            ttft_ms,
            ..
        } => Some(FromAgentMessage::ResponseEnd {
            response_id: response_id.clone(),
            usage: usage.clone(),
            tools_summary: tools_summary.clone(),
            duration_ms: *duration_ms,
            ttft_ms: *ttft_ms,
        }),
        AgentEvent::ToolCall {
            call_id,
            tool,
            args,
        } => Some(FromAgentMessage::ToolCall {
            call_id: call_id.clone(),
            tool: tool.clone(),
            args: args.clone(),
            requires_approval: false,
        }),
        AgentEvent::ApprovalRequired {
            call_id,
            tool,
            args,
        } => Some(FromAgentMessage::ToolCall {
            call_id: call_id.clone(),
            tool: tool.clone(),
            args: args.clone(),
            requires_approval: true,
        }),
        AgentEvent::ToolStart { call_id, .. } => Some(FromAgentMessage::ToolStart {
            call_id: call_id.clone(),
        }),
        AgentEvent::ToolOutput { call_id, content } => Some(FromAgentMessage::ToolOutput {
            call_id: call_id.clone(),
            content: content.clone(),
        }),
        AgentEvent::ToolEnd {
            call_id, success, ..
        } => Some(FromAgentMessage::ToolEnd {
            call_id: call_id.clone(),
            success: *success,
        }),
        AgentEvent::Error {
            message,
            fatal,
            error_type,
        } => Some(FromAgentMessage::Error {
            message: message.clone(),
            fatal: *fatal,
            error_type: *error_type,
        }),
        AgentEvent::Status { message } => Some(FromAgentMessage::Status {
            message: message.clone(),
        }),
        AgentEvent::Compaction {
            summary,
            first_kept_entry_index,
            tokens_before,
            auto,
            custom_instructions,
            timestamp,
        } => Some(FromAgentMessage::Compaction {
            summary: summary.clone(),
            first_kept_entry_index: *first_kept_entry_index,
            tokens_before: *tokens_before,
            auto: *auto,
            custom_instructions: custom_instructions.clone(),
            timestamp: timestamp.clone(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless::{HeadlessErrorType, TokenUsage};
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::Arc;

    #[cfg(unix)]
    use std::{os::unix::fs::PermissionsExt, path::Path};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;

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
                            while let Some(event) = events.lock().await.pop_front() {
                                let payload = format!("data: {event}\n\n");
                                if socket.write_all(payload.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(250)).await;
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

        (addr, posted_bodies, request_headers)
    }

    #[test]
    fn test_supervisor_config_defaults() {
        let config = SupervisorConfig::default();
        assert_eq!(config.max_reconnect_attempts, 5);
        assert_eq!(config.reconnect_delay, Duration::from_secs(1));
        assert!(config.auto_reconnect);
    }

    #[test]
    fn test_health_status() {
        assert_eq!(HealthStatus::Healthy, HealthStatus::Healthy);
        assert_ne!(HealthStatus::Healthy, HealthStatus::Unhealthy);
    }

    #[test]
    fn test_supervisor_builder() {
        let supervisor = SupervisorBuilder::new()
            .cli_path("/usr/bin/composer")
            .cwd("/home/user/project")
            .max_reconnect_attempts(10)
            .auto_reconnect(false)
            .build();

        assert!(!supervisor.is_connected());
        assert_eq!(supervisor.health(), HealthStatus::Unknown);
        assert!(supervisor.state().model.is_none());
    }

    #[test]
    fn test_supervisor_builder_restores_session_replay() {
        let replay = SessionReplay {
            state: AgentState {
                model: Some("claude-3-opus".to_string()),
                provider: Some("anthropic".to_string()),
                is_ready: true,
                ..AgentState::default()
            },
            last_init: Some(InitConfig {
                system_prompt: Some("You are Maestro".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::High),
                approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
            }),
        };

        let supervisor = SupervisorBuilder::new().session_replay(replay).build();
        assert_eq!(supervisor.state().model.as_deref(), Some("claude-3-opus"));
        assert_eq!(supervisor.state().provider.as_deref(), Some("anthropic"));
        assert!(supervisor.state().is_ready);
    }

    #[test]
    fn snapshot_incoming_preserves_existing_event_queue_order() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig::default());
        let _ = supervisor.event_tx.send(SupervisorEvent::Connected);

        let event = supervisor.handle_transport_incoming(ManagedIncoming::Snapshot {
            state: Box::new(AgentState {
                session_id: Some("sess_snapshot".to_string()),
                ..AgentState::default()
            }),
            last_init: None,
        });

        assert!(event.is_none());
        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::StateHydrated {
                session_id: Some(ref session_id)
            }) if session_id == "sess_snapshot"
        ));
    }

    #[test]
    fn test_supervisor_builder_remote_config_helpers() {
        let supervisor = SupervisorBuilder::new()
            .remote_base_url("http://127.0.0.1:8080")
            .remote_api_key("secret")
            .remote_session_id("sess_remote")
            .build();

        let remote = supervisor.config.remote.expect("remote config");
        assert_eq!(remote.base_url, "http://127.0.0.1:8080");
        assert_eq!(remote.api_key.as_deref(), Some("secret"));
        assert_eq!(remote.session_id.as_deref(), Some("sess_remote"));
    }

    #[test]
    fn resume_recorded_session_restores_replay_and_recorder() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sessions_dir = temp.path();
        let mut recorder = SessionRecorder::new(sessions_dir).expect("recorder");
        let session_id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Init {
                system_prompt: Some("Saved system prompt".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::Medium),
                approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
            })
            .expect("record init");
        recorder
            .record_received(&FromAgentMessage::Ready {
                protocol_version: Some("2026-03-30".to_string()),
                model: "gpt-5.4".to_string(),
                provider: "openai".to_string(),
                session_id: Some("sess_saved".to_string()),
            })
            .expect("record ready");
        recorder.flush().expect("flush");
        drop(recorder);

        let supervisor = SupervisorBuilder::new()
            .resume_recorded_session(sessions_dir, &session_id)
            .expect("resume builder")
            .build();

        assert_eq!(supervisor.state().model.as_deref(), Some("gpt-5.4"));
        assert_eq!(supervisor.state().provider.as_deref(), Some("openai"));
        assert_eq!(supervisor.state().session_id.as_deref(), Some("sess_saved"));
        assert!(supervisor.session_recorder.is_some());
        assert_eq!(
            supervisor
                .last_init
                .as_ref()
                .and_then(|init| init.system_prompt.as_deref()),
            Some("Saved system prompt")
        );
    }

    #[test]
    fn session_recorder_keeps_last_init_in_sync_with_sent_messages() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sessions_dir = temp.path();
        let mut recorder = SessionRecorder::new(sessions_dir).expect("recorder");
        recorder
            .record_sent(&ToAgentMessage::Init {
                system_prompt: Some("Saved system prompt".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::Medium),
                approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
            })
            .expect("record init");
        recorder.flush().expect("flush");
        let session_id = recorder.id().to_string();
        drop(recorder);

        let replay = SessionReader::load(sessions_dir, &session_id)
            .expect("load session")
            .replay();
        let recorder = SessionRecorder::resume(sessions_dir, &session_id).expect("resume recorder");

        assert_eq!(recorder.last_init(), replay.last_init.as_ref());
    }

    #[test]
    fn apply_snapshot_keeps_session_recorder_state_in_sync() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sessions_dir = temp.path();
        let recorder = SessionRecorder::new(sessions_dir).expect("recorder");
        let mut supervisor =
            AgentSupervisor::new(SupervisorConfig::default()).with_session_recorder(recorder);
        let snapshot_state = AgentState {
            model: Some("gpt-5.4".to_string()),
            provider: Some("openai".to_string()),
            session_id: Some("sess_remote".to_string()),
            is_ready: true,
            ..AgentState::default()
        };
        let snapshot_init = InitConfig {
            system_prompt: Some("Persisted prompt".to_string()),
            append_system_prompt: None,
            thinking_level: Some(super::super::messages::ThinkingLevel::High),
            approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
        };

        supervisor.apply_snapshot(snapshot_state.clone(), Some(snapshot_init.clone()));

        let recorder = supervisor
            .session_recorder
            .as_ref()
            .expect("session recorder");
        assert_eq!(recorder.replay_state().model, snapshot_state.model);
        assert_eq!(recorder.replay_state().provider, snapshot_state.provider);
        assert_eq!(
            recorder.replay_state().session_id,
            snapshot_state.session_id
        );
        assert_eq!(recorder.replay_state().is_ready, snapshot_state.is_ready);
        assert_eq!(recorder.last_init(), Some(&snapshot_init));
        assert_eq!(supervisor.last_init.as_ref(), Some(&snapshot_init));
    }

    #[test]
    fn event_to_message_preserves_headless_metadata() {
        let ready = event_to_message(&AgentEvent::Ready {
            protocol_version: Some("2026-03-30".to_string()),
            model: "claude-3-opus".to_string(),
            provider: "anthropic".to_string(),
            session_id: Some("sess_123".to_string()),
        })
        .expect("ready message");
        assert!(matches!(
            ready,
            super::super::messages::FromAgentMessage::Ready {
                protocol_version: Some(ref version),
                session_id: Some(ref session_id),
                ..
            } if version == "2026-03-30" && session_id == "sess_123"
        ));

        let response_end = event_to_message(&AgentEvent::ResponseEnd {
            response_id: "resp_1".to_string(),
            usage: Some(TokenUsage {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost: Some(0.1),
                total_tokens: Some(30),
                model_id: Some("claude-sonnet".to_string()),
                provider: Some("anthropic".to_string()),
            }),
            tools_summary: None,
            duration_ms: Some(2400),
            ttft_ms: Some(150),
            full_text: Some("Hello".to_string()),
        })
        .expect("response end message");
        assert!(matches!(
            response_end,
            super::super::messages::FromAgentMessage::ResponseEnd {
                duration_ms: Some(2400),
                ttft_ms: Some(150),
                ..
            }
        ));

        let error = event_to_message(&AgentEvent::Error {
            message: "cancelled".to_string(),
            fatal: false,
            error_type: Some(HeadlessErrorType::Cancelled),
        })
        .expect("error message");
        assert!(matches!(
            error,
            super::super::messages::FromAgentMessage::Error {
                error_type: Some(HeadlessErrorType::Cancelled),
                ..
            }
        ));
    }

    #[cfg(unix)]
    fn create_test_headless_script(dir: &Path) -> std::io::Result<std::path::PathBuf> {
        let script_path = dir.join("fake-maestro-headless.sh");
        fs::write(
            &script_path,
            r#"#!/bin/sh
log_file="${MAESTRO_TEST_LOG:?}"
: > "$log_file"
printf '{"type":"ready","model":"test","provider":"test"}\n'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log_file"
done
"#,
        )?;

        let mut permissions = fs::metadata(&script_path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)?;
        Ok(script_path)
    }

    #[cfg(unix)]
    fn create_streaming_headless_script(dir: &Path) -> std::io::Result<std::path::PathBuf> {
        let script_path = dir.join("fake-maestro-headless-stream.sh");
        fs::write(
            &script_path,
            r#"#!/bin/sh
printf '{"type":"ready","protocol_version":"2026-03-30","model":"test","provider":"test","session_id":"sess_ready"}\n'
printf '{"type":"session_info","session_id":"sess_state","cwd":"/tmp/project","git_branch":"main"}\n'
printf '{"type":"response_start","response_id":"resp_1"}\n'
printf '{"type":"response_chunk","response_id":"resp_1","content":"Partial reply","is_thinking":false}\n'
while IFS= read -r line; do
  :
done
"#,
        )?;

        let mut permissions = fs::metadata(&script_path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)?;
        Ok(script_path)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_recv_updates_replayed_state_from_transport_events() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script_path = create_streaming_headless_script(temp.path()).expect("script");

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.auto_reconnect = false;

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.connect().await.expect("connect");

        for _ in 0..4 {
            let event = supervisor.recv().await.expect("event");
            assert!(matches!(event, SupervisorEvent::Agent(_)));
        }

        assert_eq!(
            supervisor.state().protocol_version.as_deref(),
            Some("2026-03-30")
        );
        assert_eq!(supervisor.state().model.as_deref(), Some("test"));
        assert_eq!(supervisor.state().provider.as_deref(), Some("test"));
        assert_eq!(supervisor.state().session_id.as_deref(), Some("sess_state"));
        assert_eq!(supervisor.state().cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(supervisor.state().git_branch.as_deref(), Some("main"));
        assert!(supervisor.state().is_ready);
        assert!(supervisor.state().is_responding);
        assert_eq!(
            supervisor
                .state()
                .current_response
                .as_ref()
                .map(|response| response.text.as_str()),
            Some("Partial reply")
        );

        supervisor.disconnect();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connect_replays_saved_init_from_restored_session_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let log_path = temp.path().join("agent-stdin.log");
        let script_path = create_test_headless_script(temp.path()).expect("script");
        fs::write(&log_path, "").expect("create log");

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.transport.env.push((
            "MAESTRO_TEST_LOG".to_string(),
            log_path.to_string_lossy().into_owned(),
        ));
        config.auto_reconnect = false;

        let init = InitConfig {
            system_prompt: Some("system prompt".to_string()),
            append_system_prompt: Some("appendix".to_string()),
            thinking_level: Some(super::super::messages::ThinkingLevel::High),
            approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
        };
        let replay = SessionReplay {
            state: AgentState {
                session_id: Some("sess_replayed".to_string()),
                last_status: Some("Resuming session".to_string()),
                is_ready: true,
                ..AgentState::default()
            },
            last_init: Some(init.clone()),
        };

        let mut supervisor = AgentSupervisor::new(config).with_session_replay(replay);
        assert_eq!(
            supervisor.state().session_id.as_deref(),
            Some("sess_replayed")
        );
        assert_eq!(
            supervisor.state().last_status.as_deref(),
            Some("Resuming session")
        );
        assert!(supervisor.state().is_ready);

        supervisor.connect().await.expect("connect");
        for _ in 0..20 {
            let log_contents = fs::read_to_string(&log_path).expect("read log");
            if log_contents.contains(r#""type":"init""#) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        supervisor.disconnect();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let logged_inits: Vec<_> = fs::read_to_string(&log_path)
            .expect("read log")
            .lines()
            .filter_map(|line| {
                let message = serde_json::from_str::<ToAgentMessage>(line).expect("parse message");
                match message {
                    ToAgentMessage::Init {
                        system_prompt,
                        append_system_prompt,
                        thinking_level,
                        approval_mode,
                    } => Some((
                        system_prompt,
                        append_system_prompt,
                        thinking_level,
                        approval_mode,
                    )),
                    _ => None,
                }
            })
            .collect();

        assert_eq!(
            logged_inits,
            vec![(
                init.system_prompt,
                init.append_system_prompt,
                init.thinking_level,
                init.approval_mode,
            )]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reconnect_replays_last_init_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script_path = create_test_headless_script(temp.path()).expect("script");
        let sessions_dir = temp.path().join("sessions");
        let recorder = SessionRecorder::new(&sessions_dir).expect("recorder");
        let session_id = recorder.id().to_string();

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.auto_reconnect = false;

        let init = InitConfig {
            system_prompt: Some("system prompt".to_string()),
            append_system_prompt: Some("appendix".to_string()),
            thinking_level: Some(super::super::messages::ThinkingLevel::High),
            approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
        };

        let mut supervisor = AgentSupervisor::new(config).with_session_recorder(recorder);
        supervisor.connect().await.expect("connect");
        supervisor.init(init.clone()).expect("initial init");

        supervisor.disconnect();
        tokio::time::sleep(Duration::from_millis(50)).await;

        supervisor.reconnect().await.expect("reconnect");
        supervisor.disconnect();
        supervisor.flush_session().expect("flush");

        let logged_inits: Vec<_> = SessionReader::load(&sessions_dir, &session_id)
            .expect("load session")
            .sent_messages()
            .into_iter()
            .filter_map(|message| match message {
                ToAgentMessage::Init {
                    system_prompt,
                    append_system_prompt,
                    thinking_level,
                    approval_mode,
                } => Some((
                    system_prompt.clone(),
                    append_system_prompt.clone(),
                    *thinking_level,
                    *approval_mode,
                )),
                _ => None,
            })
            .collect();

        assert_eq!(logged_inits.len(), 2);
        for (system_prompt, append_system_prompt, thinking_level, approval_mode) in logged_inits {
            assert_eq!(system_prompt, init.system_prompt);
            assert_eq!(append_system_prompt, init.append_system_prompt);
            assert_eq!(thinking_level, init.thinking_level);
            assert_eq!(approval_mode, init.approval_mode);
        }
    }

    #[tokio::test]
    async fn remote_connect_hydrates_state_without_replaying_init() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 0,
            "last_init": {
                "system_prompt": "Persisted prompt",
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
        let status_event = serde_json::json!({
            "type": "message",
            "cursor": 1,
            "message": {
                "type": "status",
                "message": "Remote status"
            }
        })
        .to_string();
        let (addr, posted_bodies, request_headers) =
            spawn_remote_headless_server(snapshot.to_string(), vec![status_event]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .remote_api_key("secret")
            .remote_session_id("sess_remote")
            .build();

        supervisor.connect().await.expect("connect");

        assert_eq!(supervisor.state().model.as_deref(), Some("gpt-5.4"));
        assert_eq!(supervisor.state().provider.as_deref(), Some("openai"));
        assert_eq!(
            supervisor.state().session_id.as_deref(),
            Some("sess_remote")
        );
        assert_eq!(supervisor.state().last_status.as_deref(), Some("Attached"));

        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::StateHydrated {
                session_id: Some(ref session_id)
            }) if session_id == "sess_remote"
        ));
        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Agent(agent_event))
                if matches!(
                    *agent_event,
                    AgentEvent::Status { ref message } if message == "Remote status"
                )
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(posted_bodies.lock().await.is_empty());
        let headers = request_headers.lock().await.clone();
        assert!(headers.first().is_some_and(|request| {
            request
                .iter()
                .any(|(name, value)| name == "authorization" && value == "Bearer secret")
        }));

        supervisor.disconnect();
    }
}

//! Agent supervisor with reconnection and health monitoring
//!
//! Wraps the transport layer to provide:
//! - Automatic reconnection on failure
//! - Health monitoring with heartbeats
//! - Graceful degradation

use std::path::Path;
use std::time::{Duration, Instant};

use rand::Rng as _;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
// Note: interval/timeout available for future health checking
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use super::async_transport::RemoteErrorKind;
use super::async_transport::{AsyncAgentTransport, AsyncTransportConfig, AsyncTransportError};
use super::messages::{AgentEvent, AgentState, FromAgentMessage, InitConfig, ToAgentMessage};
use super::remote_transport::{RemoteAgentTransport, RemoteIncoming, RemoteTransportConfig};
use super::session::{SessionReader, SessionRecorder, SessionReplay};

const MAX_STALE_REMOTE_REFERENCE_RETRIES: u32 = 3;
const MIN_RECONNECT_SLEEP: Duration = Duration::from_millis(1);
const REMOTE_COMPACTION_SILENCE_TIMEOUT: Duration = Duration::from_mins(3);

fn jittered_reconnect_delay_for_sample(
    base_delay: Duration,
    jitter_factor: f64,
    jitter_sample: f64,
) -> Duration {
    if jitter_factor <= 0.0 || base_delay.is_zero() {
        return base_delay;
    }

    let capped_sample = jitter_sample.clamp(-1.0, 1.0);
    let jittered_secs = (base_delay.as_secs_f64()
        + base_delay.as_secs_f64() * jitter_factor * capped_sample)
        .max(MIN_RECONNECT_SLEEP.as_secs_f64());
    Duration::from_secs_f64(jittered_secs)
}

fn jittered_reconnect_delay(base_delay: Duration, jitter_factor: f64) -> Duration {
    if jitter_factor <= 0.0 || base_delay.is_zero() {
        return base_delay;
    }

    let mut rng = rand::rng();
    jittered_reconnect_delay_for_sample(base_delay, jitter_factor, rng.random_range(-1.0..=1.0))
}

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
    /// Randomized reconnect jitter ratio (0.25 = +/-25%).
    pub reconnect_jitter_factor: f64,
    /// Maximum total wall-clock time spent reconnecting before giving up.
    pub max_reconnect_elapsed: Duration,
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
            reconnect_jitter_factor: 0.25,
            max_reconnect_elapsed: Duration::from_mins(10),
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

    async fn shutdown_and_wait(self) -> Result<(), AsyncTransportError> {
        match self {
            Self::Local(transport) => transport.shutdown(),
            Self::Remote(transport) => transport.shutdown_and_wait().await,
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

    fn remote_session_id(&self) -> Option<&str> {
        match self {
            Self::Local(_) => None,
            Self::Remote(transport) => Some(transport.session_id()),
        }
    }

    fn remote_connection_id(&self) -> Option<&str> {
        match self {
            Self::Local(_) => None,
            Self::Remote(transport) => Some(transport.connection_id()),
        }
    }

    fn is_remote(&self) -> bool {
        matches!(self, Self::Remote(_))
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
    /// Consecutive retryable stale connection/subscriber failures.
    stale_reference_retries: u32,
    /// Whether a reconnect should be attempted on the next async receive cycle
    pending_auto_reconnect: bool,
    /// Background teardown for a transport that must finish before the next connect/reconnect.
    pending_transport_shutdown: Option<JoinHandle<()>>,
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
            stale_reference_retries: 0,
            pending_auto_reconnect: false,
            pending_transport_shutdown: None,
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
        self.seed_remote_session_id_if_missing(self.state.session_id.clone());
    }

    async fn spawn_transport(&mut self) -> Result<ManagedTransport, AsyncTransportError> {
        if let Some(remote_config) = self.config.remote.as_mut() {
            if remote_config.session_id.is_none() {
                remote_config.session_id = self.state.session_id.clone();
            }
            RemoteAgentTransport::connect(remote_config.clone())
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
        self.wait_for_pending_transport_shutdown().await;
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
        let was_remote = self
            .transport
            .as_ref()
            .is_some_and(ManagedTransport::is_remote);
        if let Some(transport) = self.transport.take() {
            self.begin_transport_shutdown(transport);
        }
        self.clear_disconnect_state();
        self.last_response = None;
        self.pending_auto_reconnect = false;
        self.stale_reference_retries = 0;
        if was_remote {
            self.remember_remote_connection_id(None);
        }
        self.health_status = HealthStatus::Unhealthy;
        let _ = self.event_tx.send(SupervisorEvent::Disconnected {
            error: "Disconnected by request".to_string(),
        });
    }

    /// Attempt reconnection with exponential backoff
    pub async fn reconnect(&mut self) -> Result<(), AsyncTransportError> {
        if self.health_status != HealthStatus::Reconnecting {
            self.health_status = HealthStatus::Reconnecting;
            let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                status: HealthStatus::Reconnecting,
            });
        }
        if let Some(existing) = self.transport.take() {
            let _ = existing.shutdown_and_wait().await;
        }
        self.wait_for_pending_transport_shutdown().await;
        self.last_response = None;

        let max_attempts = self.config.max_reconnect_attempts;
        let mut delay = self.config.reconnect_delay;
        let reconnect_started_at = Instant::now();

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
                    self.stale_reference_retries = 0;
                    self.pending_auto_reconnect = false;
                    let _ = self.event_tx.send(SupervisorEvent::Connected);
                    let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                        status: HealthStatus::Healthy,
                    });
                    return Ok(());
                }
                Err(e) => {
                    let within_retry_budget = self.consume_retry_budget_for_error(&e);
                    let reconnect_elapsed = reconnect_started_at.elapsed();
                    if !within_retry_budget
                        || (max_attempts > 0 && self.reconnect_attempts >= max_attempts)
                        || reconnect_elapsed >= self.config.max_reconnect_elapsed
                    {
                        self.health_status = HealthStatus::Unhealthy;
                        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                            status: HealthStatus::Unhealthy,
                        });
                        return Err(e);
                    }

                    // Wait with backoff, but never sleep past the reconnect budget.
                    let remaining_budget = self
                        .config
                        .max_reconnect_elapsed
                        .saturating_sub(reconnect_elapsed);
                    let sleep_duration =
                        jittered_reconnect_delay(delay, self.config.reconnect_jitter_factor)
                            .min(remaining_budget);
                    if sleep_duration.is_zero() {
                        self.health_status = HealthStatus::Unhealthy;
                        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                            status: HealthStatus::Unhealthy,
                        });
                        return Err(e);
                    }

                    tokio::time::sleep(sleep_duration).await;
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
        self.last_response = Some(Instant::now());
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

    /// Send a protocol message and drain any agent messages that are already available.
    pub fn send_and_drain_agent_messages(
        &mut self,
        msg: ToAgentMessage,
    ) -> Result<Vec<FromAgentMessage>, AsyncTransportError> {
        self.send(msg)?;
        Ok(self.drain_available_agent_messages())
    }

    /// Drain currently available supervisor agent events as headless protocol messages.
    #[must_use]
    pub fn drain_available_agent_messages(&mut self) -> Vec<FromAgentMessage> {
        let mut messages = Vec::new();
        while let Some(event) = self.poll() {
            if let SupervisorEvent::Agent(agent_event) = event {
                messages.push(agent_event_to_message(&agent_event));
            }
        }
        messages
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

    fn remember_remote_session_id(&mut self, session_id: Option<String>) {
        if let (Some(remote), Some(session_id)) = (self.config.remote.as_mut(), session_id) {
            remote.session_id = Some(session_id);
        }
    }

    fn remember_remote_connection_id(&mut self, connection_id: Option<String>) {
        if let Some(remote) = self.config.remote.as_mut() {
            remote.connection_id = connection_id;
        }
    }

    fn seed_remote_session_id_if_missing(&mut self, session_id: Option<String>) {
        if let (Some(remote), Some(session_id)) = (self.config.remote.as_mut(), session_id) {
            if remote.session_id.is_none() {
                remote.session_id = Some(session_id);
            }
        }
    }

    fn set_transport(&mut self, transport: ManagedTransport) -> Result<(), AsyncTransportError> {
        let remote_session_id = transport.remote_session_id().map(str::to_string);
        let remote_connection_id = transport.remote_connection_id().map(str::to_string);
        let should_replay_init = transport.needs_init_replay();
        let snapshot = transport.initial_snapshot();
        self.transport = Some(transport);
        self.stale_reference_retries = 0;
        self.last_response = Some(Instant::now());
        if let Some((state, last_init)) = snapshot {
            self.apply_snapshot(state, last_init);
        }
        self.remember_remote_session_id(
            remote_session_id.or_else(|| self.state.session_id.clone()),
        );
        self.remember_remote_connection_id(remote_connection_id);
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
        self.remember_remote_session_id(self.state.session_id.clone());
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

    fn clear_transient_progress_state(&mut self) {
        self.state.clear_transient_progress();
        self.persist_session_snapshot();
    }

    fn clear_disconnect_state(&mut self) {
        self.state.clear_transient_progress();
        self.state.clear_pending_request_state();
        self.persist_session_snapshot();
    }

    fn persist_session_snapshot(&mut self) {
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.apply_snapshot(self.state.clone(), self.last_init.clone());
        }
    }

    fn begin_transport_shutdown(&mut self, transport: ManagedTransport) {
        if let Some(handle) = self.pending_transport_shutdown.take() {
            handle.abort();
        }

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            self.pending_transport_shutdown = Some(handle.spawn(async move {
                let _ = transport.shutdown_and_wait().await;
            }));
        } else {
            let _ = transport.shutdown();
            self.pending_transport_shutdown = None;
        }
    }

    async fn wait_for_pending_transport_shutdown(&mut self) {
        if let Some(handle) = self.pending_transport_shutdown.take() {
            let _ = handle.await;
        }
    }

    fn handle_transport_error(&mut self, error: AsyncTransportError) -> SupervisorEvent {
        if let Some(transport) = self.transport.take() {
            self.begin_transport_shutdown(transport);
        }
        self.clear_transient_progress_state();
        self.last_response = None;
        self.health_status = HealthStatus::Unhealthy;
        SupervisorEvent::Disconnected {
            error: error.to_string(),
        }
    }

    fn schedule_auto_reconnect(&mut self) {
        if self.config.auto_reconnect {
            self.pending_auto_reconnect = true;
        }
    }

    fn consume_retry_budget_for_error(&mut self, error: &AsyncTransportError) -> bool {
        if !error.is_retryable() {
            self.stale_reference_retries = 0;
            return false;
        }

        if error.uses_stale_reference_retry_budget() {
            self.stale_reference_retries += 1;
            return self.stale_reference_retries <= MAX_STALE_REMOTE_REFERENCE_RETRIES;
        }

        self.stale_reference_retries = 0;
        true
    }

    fn handle_transport_disconnect(&mut self, error: AsyncTransportError) -> SupervisorEvent {
        let should_retry =
            self.config.auto_reconnect && self.consume_retry_budget_for_error(&error);
        if let Some(transport) = self.transport.take() {
            self.begin_transport_shutdown(transport);
        }
        self.last_response = None;
        if should_retry {
            self.health_status = HealthStatus::Reconnecting;
            self.schedule_auto_reconnect();
            return SupervisorEvent::HealthChanged {
                status: HealthStatus::Reconnecting,
            };
        }
        self.clear_transient_progress_state();
        self.health_status = HealthStatus::Unhealthy;
        self.pending_auto_reconnect = false;
        SupervisorEvent::Disconnected {
            error: error.to_string(),
        }
    }

    fn mark_response_received(&mut self, emit_health_event: bool) {
        self.last_response = Some(Instant::now());
        if emit_health_event && self.health_status != HealthStatus::Healthy {
            self.health_status = HealthStatus::Healthy;
            let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy,
            });
        }
    }

    fn silence_timeouts_enabled(&self) -> bool {
        !matches!(
            self.config
                .remote
                .as_ref()
                .and_then(|remote| remote.role.as_deref()),
            Some("viewer")
        )
    }

    fn remote_compaction_timeout(&self) -> Option<Duration> {
        if !self.silence_timeouts_enabled()
            || self.config.remote.is_none()
            || !self.state.is_responding
        {
            return None;
        }

        self.state
            .last_status
            .as_deref()
            .filter(|status| status.trim().eq_ignore_ascii_case("compacting"))
            .map(|_| REMOTE_COMPACTION_SILENCE_TIMEOUT)
    }

    fn next_health_deadline(&self) -> Option<Instant> {
        if !self.silence_timeouts_enabled() {
            return None;
        }
        let last_response = self.last_response?;
        if let Some(timeout) = self.remote_compaction_timeout() {
            return Some(last_response + timeout);
        }
        match self.health_status {
            HealthStatus::Healthy => Some(last_response + self.config.health_check_interval),
            HealthStatus::Degraded => Some(
                last_response
                    + self.config.health_check_interval
                    + self.config.health_check_timeout,
            ),
            _ => None,
        }
    }

    fn next_health_timeout(&self, now: Instant) -> Option<Duration> {
        self.next_health_deadline()
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    fn due_health_transition(&mut self, now: Instant) -> Option<SupervisorEvent> {
        if !self.silence_timeouts_enabled() {
            return None;
        }
        let last_response = self.last_response?;
        let silence = now.saturating_duration_since(last_response);
        if let Some(timeout) = self.remote_compaction_timeout() {
            if silence < timeout {
                return None;
            }

            return Some(self.transition_to_unhealthy_for_silence());
        }
        match self.health_status {
            HealthStatus::Healthy if silence >= self.config.health_check_interval => {
                self.health_status = HealthStatus::Degraded;
                Some(SupervisorEvent::HealthChanged {
                    status: HealthStatus::Degraded,
                })
            }
            HealthStatus::Degraded
                if silence
                    >= self.config.health_check_interval + self.config.health_check_timeout =>
            {
                Some(self.transition_to_unhealthy_for_silence())
            }
            _ => None,
        }
    }

    fn transition_to_unhealthy_for_silence(&mut self) -> SupervisorEvent {
        self.health_status = HealthStatus::Unhealthy;
        self.last_response = None;
        if self.config.auto_reconnect {
            if let Some(transport) = self.transport.take() {
                self.begin_transport_shutdown(transport);
            }
            self.pending_auto_reconnect = true;
        } else {
            self.pending_auto_reconnect = false;
            self.clear_transient_progress_state();
        }
        SupervisorEvent::HealthChanged {
            status: HealthStatus::Unhealthy,
        }
    }

    fn handle_transport_incoming(&mut self, incoming: ManagedIncoming) -> Option<SupervisorEvent> {
        let emit_health_event = self.transport.is_some();
        match incoming {
            ManagedIncoming::Message(message) => {
                self.mark_response_received(emit_health_event);
                self.apply_agent_message(message)
            }
            ManagedIncoming::Snapshot { state, last_init } => {
                self.mark_response_received(emit_health_event);
                self.apply_snapshot(*state, last_init);
                None
            }
            ManagedIncoming::Reset {
                reason: _reason,
                state,
                last_init,
            } => {
                self.mark_response_received(emit_health_event);
                self.apply_snapshot(*state, last_init);
                None
            }
            ManagedIncoming::Heartbeat => {
                self.mark_response_received(emit_health_event);
                None
            }
        }
    }

    /// Poll for events (non-blocking)
    pub fn poll(&mut self) -> Option<SupervisorEvent> {
        if let Ok(event) = self.event_rx.try_recv() {
            return Some(event);
        }

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
                Err(error) => return Some(self.handle_transport_disconnect(error)),
            }
        }

        if self.transport.is_some() {
            if let Some(event) = self.due_health_transition(Instant::now()) {
                return Some(event);
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
        loop {
            if let Ok(event) = self.event_rx.try_recv() {
                return Some(event);
            }

            if self.transport.is_none() {
                if self.pending_auto_reconnect {
                    self.pending_auto_reconnect = false;
                    if let Err(error) = self.reconnect().await {
                        let disconnected = self.handle_transport_error(error);
                        let _ = self.event_tx.send(disconnected);
                    }
                    continue;
                }
                return self.event_rx.recv().await;
            }

            let now = Instant::now();
            if let Some(event) = self.due_health_transition(now) {
                return Some(event);
            }

            let next_timeout = self.next_health_timeout(now);
            let result = {
                let transport = self.transport.as_mut()?;
                if let Some(timeout) = next_timeout {
                    match tokio::time::timeout(timeout, transport.recv_incoming()).await {
                        Ok(result) => result,
                        Err(_) => continue,
                    }
                } else {
                    transport.recv_incoming().await
                }
            };
            match result {
                Ok(incoming) => {
                    if let Some(event) = self.handle_transport_incoming(incoming) {
                        return Some(event);
                    }
                }
                Err(error) => return Some(self.handle_transport_disconnect(error)),
            }
        }
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

    /// Opt out of specific live notification types on the remote subscription.
    #[must_use]
    pub fn remote_opt_out_notification(mut self, notification: impl Into<String>) -> Self {
        let config = self
            .config
            .remote
            .get_or_insert_with(RemoteTransportConfig::default);
        let notification = notification.into();
        if !config.opt_out_notifications.contains(&notification) {
            config.opt_out_notifications.push(notification);
        }
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

    /// Add an environment variable for spawned local agents.
    #[must_use]
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.config.transport.env.push((key.into(), value.into()));
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

    /// Set randomized reconnect jitter ratio (0.25 = +/-25%).
    #[must_use]
    pub fn reconnect_jitter_factor(mut self, jitter_factor: f64) -> Self {
        self.config.reconnect_jitter_factor = jitter_factor;
        self
    }

    /// Set maximum total wall-clock time allowed for a reconnect loop.
    #[must_use]
    pub fn max_reconnect_elapsed(mut self, elapsed: Duration) -> Self {
        self.config.max_reconnect_elapsed = elapsed;
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

/// Convert a supervisor agent event into the wire-level headless message shape.
#[must_use]
pub fn agent_event_to_message(event: &AgentEvent) -> FromAgentMessage {
    match event {
        AgentEvent::RawAgentEvent { event_type, event } => FromAgentMessage::RawAgentEvent {
            event_type: event_type.clone(),
            event: event.clone(),
        },
        AgentEvent::Ready {
            protocol_version,
            model,
            provider,
            session_id,
        } => FromAgentMessage::Ready {
            protocol_version: protocol_version.clone(),
            model: model.clone(),
            provider: provider.clone(),
            session_id: session_id.clone(),
        },
        AgentEvent::SessionInfo {
            session_id,
            cwd,
            git_branch,
        } => FromAgentMessage::SessionInfo {
            session_id: session_id.clone(),
            cwd: cwd.clone(),
            git_branch: git_branch.clone(),
        },
        AgentEvent::ResponseStart { response_id } => FromAgentMessage::ResponseStart {
            response_id: response_id.clone(),
        },
        AgentEvent::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } => FromAgentMessage::ResponseChunk {
            response_id: response_id.clone(),
            content: content.clone(),
            is_thinking: *is_thinking,
        },
        AgentEvent::ResponseEnd {
            response_id,
            usage,
            tools_summary,
            duration_ms,
            ttft_ms,
            ..
        } => FromAgentMessage::ResponseEnd {
            response_id: response_id.clone(),
            usage: usage.clone(),
            tools_summary: tools_summary.clone(),
            duration_ms: *duration_ms,
            ttft_ms: *ttft_ms,
        },
        AgentEvent::ToolCall {
            call_id,
            tool,
            args,
        } => FromAgentMessage::ToolCall {
            call_id: call_id.clone(),
            tool_execution_id: None,
            tool: tool.clone(),
            args: args.clone(),
            requires_approval: false,
        },
        AgentEvent::ApprovalRequired {
            call_id,
            tool,
            args,
        } => FromAgentMessage::ToolCall {
            call_id: call_id.clone(),
            tool_execution_id: None,
            tool: tool.clone(),
            args: args.clone(),
            requires_approval: true,
        },
        AgentEvent::ToolStart { call_id, .. } => FromAgentMessage::ToolStart {
            call_id: call_id.clone(),
        },
        AgentEvent::ToolOutput { call_id, content } => FromAgentMessage::ToolOutput {
            call_id: call_id.clone(),
            content: content.clone(),
        },
        AgentEvent::ToolEnd {
            call_id, success, ..
        } => FromAgentMessage::ToolEnd {
            call_id: call_id.clone(),
            tool_execution_id: None,
            success: *success,
            tool: None,
            details: None,
        },
        AgentEvent::Error {
            request_id,
            message,
            fatal,
            error_type,
        } => FromAgentMessage::Error {
            request_id: request_id.clone(),
            message: message.clone(),
            fatal: *fatal,
            error_type: *error_type,
        },
        AgentEvent::Status { message } => FromAgentMessage::Status {
            message: message.clone(),
        },
        AgentEvent::Compaction {
            summary,
            first_kept_entry_index,
            tokens_before,
            auto,
            custom_instructions,
            timestamp,
        } => FromAgentMessage::Compaction {
            summary: summary.clone(),
            first_kept_entry_index: *first_kept_entry_index,
            tokens_before: *tokens_before,
            auto: *auto,
            custom_instructions: custom_instructions.clone(),
            timestamp: timestamp.clone(),
        },
    }
}

#[cfg(test)]
mod tests;

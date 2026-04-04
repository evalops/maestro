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
const REMOTE_COMPACTION_SILENCE_TIMEOUT: Duration = Duration::from_secs(180);

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
            max_reconnect_elapsed: Duration::from_secs(600),
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
            let _ = transport.shutdown();
        }
        self.clear_transient_progress_state();
        self.clear_pending_request_state();
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
        self.health_status = HealthStatus::Reconnecting;
        let _ = self.event_tx.send(SupervisorEvent::HealthChanged {
            status: HealthStatus::Reconnecting,
        });

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
                    if let Some(existing) = self.transport.take() {
                        let _ = existing.shutdown();
                    }
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
                    let reconnect_elapsed = reconnect_started_at.elapsed();
                    if !e.is_retryable()
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
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.apply_snapshot(self.state.clone(), self.last_init.clone());
        }
    }

    fn clear_pending_request_state(&mut self) {
        self.state.clear_pending_request_state();
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.apply_snapshot(self.state.clone(), self.last_init.clone());
        }
    }

    fn handle_transport_error(&mut self, error: AsyncTransportError) -> SupervisorEvent {
        if let Some(transport) = self.transport.take() {
            let _ = transport.shutdown();
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

    fn should_schedule_disconnect_retry(&mut self, error: &AsyncTransportError) -> bool {
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
        let should_retry = self.should_schedule_disconnect_retry(&error);
        let event = self.handle_transport_error(error);
        if should_retry {
            self.schedule_auto_reconnect();
        }
        event
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

            self.clear_transient_progress_state();
            self.health_status = HealthStatus::Unhealthy;
            self.last_response = None;
            if self.config.auto_reconnect {
                if let Some(transport) = self.transport.take() {
                    let _ = transport.shutdown();
                }
                self.pending_auto_reconnect = true;
            }
            return Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Unhealthy,
            });
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
                self.clear_transient_progress_state();
                self.health_status = HealthStatus::Unhealthy;
                self.last_response = None;
                if self.config.auto_reconnect {
                    if let Some(transport) = self.transport.take() {
                        let _ = transport.shutdown();
                    }
                    self.pending_auto_reconnect = true;
                }
                Some(SupervisorEvent::HealthChanged {
                    status: HealthStatus::Unhealthy,
                })
            }
            _ => None,
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

#[cfg(test)]
fn event_to_message(event: &AgentEvent) -> Option<FromAgentMessage> {
    match event {
        AgentEvent::RawAgentEvent { event_type, event } => Some(FromAgentMessage::RawAgentEvent {
            event_type: event_type.clone(),
            event: event.clone(),
        }),
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
            request_id,
            message,
            fatal,
            error_type,
        } => Some(FromAgentMessage::Error {
            request_id: request_id.clone(),
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
    use crate::headless::messages::{
        ActiveFileWatch, ActiveUtilityCommand, PendingApproval, UtilityCommandTerminalMode,
    };
    use crate::headless::{
        ActiveTool, HeadlessErrorType, StreamingResponse, TokenUsage, UtilityCommandShellMode,
    };
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

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
        Arc<Mutex<Vec<(String, String)>>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let posted_bodies = Arc::new(Mutex::new(Vec::new()));
        let request_headers = Arc::new(Mutex::new(Vec::new()));
        let request_bodies = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(VecDeque::from(sse_events)));
        let snapshot_value =
            serde_json::from_str::<serde_json::Value>(&snapshot_json).expect("valid snapshot json");
        let snapshot_session_id = snapshot_value
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("sess_remote")
            .to_string();

        tokio::spawn({
            let posted_bodies = Arc::clone(&posted_bodies);
            let request_headers = Arc::clone(&request_headers);
            let request_bodies = Arc::clone(&request_bodies);
            let events = Arc::clone(&events);
            let snapshot_session_id = snapshot_session_id.clone();
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let posted_bodies = Arc::clone(&posted_bodies);
                    let request_headers = Arc::clone(&request_headers);
                    let request_bodies = Arc::clone(&request_bodies);
                    let events = Arc::clone(&events);
                    let snapshot_json = snapshot_json.clone();
                    let snapshot_session_id = snapshot_session_id.clone();

                    tokio::spawn(async move {
                        let Some((path, headers, body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        request_headers.lock().await.push(headers);
                        request_bodies
                            .lock()
                            .await
                            .push((path.clone(), body.clone()));

                        if path == "/api/headless/connections" {
                            let body = serde_json::json!({
                                "session_id": snapshot_session_id,
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

        (addr, posted_bodies, request_headers, request_bodies)
    }

    #[test]
    fn test_supervisor_config_defaults() {
        let config = SupervisorConfig::default();
        assert_eq!(config.max_reconnect_attempts, 5);
        assert_eq!(config.reconnect_delay, Duration::from_secs(1));
        assert!((config.reconnect_jitter_factor - 0.25).abs() < f64::EPSILON);
        assert_eq!(config.max_reconnect_elapsed, Duration::from_secs(600));
        assert!(config.auto_reconnect);
    }

    #[test]
    fn reconnect_jitter_sample_stays_within_expected_bounds() {
        let base_delay = Duration::from_secs(4);

        assert_eq!(
            jittered_reconnect_delay_for_sample(base_delay, 0.25, -1.0),
            Duration::from_secs(3)
        );
        assert_eq!(
            jittered_reconnect_delay_for_sample(base_delay, 0.25, 1.0),
            Duration::from_secs(5)
        );
        assert_eq!(
            jittered_reconnect_delay_for_sample(base_delay, 0.25, 0.0),
            base_delay
        );
    }

    #[test]
    fn test_health_status() {
        assert_eq!(HealthStatus::Healthy, HealthStatus::Healthy);
        assert_ne!(HealthStatus::Healthy, HealthStatus::Unhealthy);
    }

    #[test]
    fn health_transitions_after_silence() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig {
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            ..SupervisorConfig::default()
        });
        let start = Instant::now();
        supervisor.health_status = HealthStatus::Healthy;
        supervisor.last_response = Some(start);

        assert!(supervisor
            .due_health_transition(start + Duration::from_secs(29))
            .is_none());
        assert!(matches!(
            supervisor.due_health_transition(start + Duration::from_secs(30)),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Degraded
            })
        ));
        assert_eq!(supervisor.health(), HealthStatus::Degraded);
        assert!(supervisor
            .due_health_transition(start + Duration::from_secs(34))
            .is_none());
        assert!(matches!(
            supervisor.due_health_transition(start + Duration::from_secs(35)),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Unhealthy
            })
        ));
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
    }

    #[test]
    fn remote_viewer_skips_silence_health_timeouts() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig {
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            remote: Some(RemoteTransportConfig {
                role: Some("viewer".to_string()),
                ..RemoteTransportConfig::default()
            }),
            ..SupervisorConfig::default()
        });
        let start = Instant::now();
        supervisor.health_status = HealthStatus::Healthy;
        supervisor.last_response = Some(start);

        assert!(supervisor.next_health_deadline().is_none());
        assert!(supervisor
            .due_health_transition(start + Duration::from_secs(35))
            .is_none());
        assert_eq!(supervisor.health(), HealthStatus::Healthy);
    }

    #[test]
    fn compacting_remote_sessions_use_extended_silence_deadline() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig {
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            remote: Some(RemoteTransportConfig {
                role: Some("controller".to_string()),
                ..RemoteTransportConfig::default()
            }),
            ..SupervisorConfig::default()
        });
        let start = Instant::now();
        supervisor.health_status = HealthStatus::Healthy;
        supervisor.last_response = Some(start);
        supervisor.state.is_responding = true;
        supervisor.state.last_status = Some(" compacting ".to_string());

        assert_eq!(
            supervisor.next_health_deadline(),
            Some(start + REMOTE_COMPACTION_SILENCE_TIMEOUT)
        );
        assert!(supervisor
            .due_health_transition(start + Duration::from_secs(35))
            .is_none());
        assert_eq!(supervisor.health(), HealthStatus::Healthy);
    }

    #[test]
    fn completed_remote_responses_do_not_keep_compaction_timeout_override() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig {
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            remote: Some(RemoteTransportConfig {
                role: Some("controller".to_string()),
                ..RemoteTransportConfig::default()
            }),
            ..SupervisorConfig::default()
        });
        let start = Instant::now();
        supervisor.health_status = HealthStatus::Healthy;
        supervisor.last_response = Some(start);
        supervisor.state.is_responding = false;
        supervisor.state.last_status = Some("compacting".to_string());

        assert_eq!(
            supervisor.next_health_deadline(),
            Some(start + Duration::from_secs(30))
        );
        assert!(matches!(
            supervisor.due_health_transition(start + Duration::from_secs(30)),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Degraded
            })
        ));
    }

    #[test]
    fn compacting_remote_sessions_become_unhealthy_after_extended_timeout() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig {
            health_check_interval: Duration::from_secs(30),
            health_check_timeout: Duration::from_secs(5),
            remote: Some(RemoteTransportConfig {
                role: Some("controller".to_string()),
                ..RemoteTransportConfig::default()
            }),
            auto_reconnect: true,
            ..SupervisorConfig::default()
        });
        let start = Instant::now();
        supervisor.health_status = HealthStatus::Healthy;
        supervisor.last_response = Some(start);
        supervisor.state.is_responding = true;
        supervisor.state.last_status = Some("compacting".to_string());

        assert!(matches!(
            supervisor.due_health_transition(start + REMOTE_COMPACTION_SILENCE_TIMEOUT),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Unhealthy
            })
        ));
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
        assert!(supervisor.pending_auto_reconnect);
    }

    #[test]
    fn incoming_heartbeat_restores_healthy_status() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig::default());
        supervisor.health_status = HealthStatus::Degraded;
        supervisor.last_response = Some(
            Instant::now()
                .checked_sub(Duration::from_secs(90))
                .expect("monotonic clock supports subtraction"),
        );

        supervisor.mark_response_received(true);
        assert_eq!(supervisor.health(), HealthStatus::Healthy);
        assert!(matches!(
            supervisor.poll(),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
    }

    #[test]
    fn transport_disconnect_clears_transient_progress_state() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig::default());
        supervisor.state.current_response = Some(StreamingResponse::new("resp_disconnect".into()));
        supervisor.state.is_responding = true;
        let approval = PendingApproval {
            call_id: "call_disconnect".to_string(),
            request_id: Some("req_disconnect".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "git push" }),
        };
        let client_tool = PendingApproval {
            call_id: "call_client_disconnect".to_string(),
            request_id: Some("req_client_disconnect".to_string()),
            tool: "client_tool".to_string(),
            args: serde_json::json!({ "name": "artifacts" }),
        };
        let user_input = PendingApproval {
            call_id: "call_user_disconnect".to_string(),
            request_id: Some("req_user_disconnect".to_string()),
            tool: "ask_user".to_string(),
            args: serde_json::json!({ "question": "continue?" }),
        };
        let tool_retry = PendingApproval {
            call_id: "call_retry_disconnect".to_string(),
            request_id: Some("req_retry_disconnect".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "retry" }),
        };
        supervisor.state.pending_approvals.push(approval.clone());
        supervisor
            .state
            .pending_client_tools
            .push(client_tool.clone());
        supervisor
            .state
            .pending_user_inputs
            .push(user_input.clone());
        supervisor
            .state
            .pending_tool_retries
            .push(tool_retry.clone());
        supervisor
            .state
            .tracked_tools
            .insert(approval.call_id.clone(), approval);
        supervisor
            .state
            .tracked_tools
            .insert(client_tool.call_id.clone(), client_tool);
        supervisor
            .state
            .tracked_tools
            .insert(user_input.call_id.clone(), user_input);
        supervisor
            .state
            .tracked_tools
            .insert(tool_retry.call_id.clone(), tool_retry);
        supervisor.state.active_tools.insert(
            "call_disconnect".to_string(),
            ActiveTool {
                call_id: "call_disconnect".to_string(),
                tool: "read".to_string(),
                output: "partial".to_string(),
                started: Instant::now(),
            },
        );
        supervisor.state.active_utility_commands.insert(
            "cmd_disconnect".to_string(),
            ActiveUtilityCommand {
                command_id: "cmd_disconnect".to_string(),
                command: "sleep 10".to_string(),
                cwd: Some("/tmp/project".to_string()),
                shell_mode: UtilityCommandShellMode::Shell,
                terminal_mode: UtilityCommandTerminalMode::Pipe,
                pid: Some(42),
                columns: None,
                rows: None,
                owner_connection_id: Some("conn_remote".to_string()),
                output: "partial".to_string(),
            },
        );
        supervisor.state.active_file_watches.insert(
            "watch_disconnect".to_string(),
            ActiveFileWatch {
                watch_id: "watch_disconnect".to_string(),
                root_dir: "/tmp/project".to_string(),
                include_patterns: None,
                exclude_patterns: None,
                debounce_ms: 250,
                owner_connection_id: Some("conn_remote".to_string()),
            },
        );

        let _event = supervisor.handle_transport_disconnect(AsyncTransportError::ChannelClosed);

        assert!(supervisor.state().current_response.is_none());
        assert_eq!(supervisor.state().pending_approvals.len(), 1);
        assert_eq!(supervisor.state().pending_client_tools.len(), 1);
        assert_eq!(supervisor.state().pending_user_inputs.len(), 1);
        assert_eq!(supervisor.state().pending_tool_retries.len(), 1);
        assert!(supervisor.state().active_tools.is_empty());
        assert!(supervisor.state().active_utility_commands.is_empty());
        assert!(supervisor.state().active_file_watches.is_empty());
        assert_eq!(supervisor.state().tracked_tools.len(), 4);
        assert!(!supervisor.state().is_responding);
    }

    #[test]
    fn manual_disconnect_clears_transient_progress_state() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig::default());
        supervisor.state.current_response = Some(StreamingResponse::new("resp_manual".into()));
        supervisor.state.is_responding = true;
        let approval = PendingApproval {
            call_id: "call_manual".to_string(),
            request_id: Some("req_manual".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "git push" }),
        };
        let client_tool = PendingApproval {
            call_id: "call_client_manual".to_string(),
            request_id: Some("req_client_manual".to_string()),
            tool: "client_tool".to_string(),
            args: serde_json::json!({ "name": "artifacts" }),
        };
        let user_input = PendingApproval {
            call_id: "call_user_manual".to_string(),
            request_id: Some("req_user_manual".to_string()),
            tool: "ask_user".to_string(),
            args: serde_json::json!({ "question": "continue?" }),
        };
        let tool_retry = PendingApproval {
            call_id: "call_retry_manual".to_string(),
            request_id: Some("req_retry_manual".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "retry" }),
        };
        supervisor.state.pending_approvals.push(approval.clone());
        supervisor
            .state
            .pending_client_tools
            .push(client_tool.clone());
        supervisor
            .state
            .pending_user_inputs
            .push(user_input.clone());
        supervisor
            .state
            .pending_tool_retries
            .push(tool_retry.clone());
        supervisor
            .state
            .tracked_tools
            .insert(approval.call_id.clone(), approval);
        supervisor
            .state
            .tracked_tools
            .insert(client_tool.call_id.clone(), client_tool);
        supervisor
            .state
            .tracked_tools
            .insert(user_input.call_id.clone(), user_input);
        supervisor
            .state
            .tracked_tools
            .insert(tool_retry.call_id.clone(), tool_retry);
        supervisor.state.active_tools.insert(
            "call_manual".to_string(),
            ActiveTool {
                call_id: "call_manual".to_string(),
                tool: "write".to_string(),
                output: "partial".to_string(),
                started: Instant::now(),
            },
        );
        supervisor.state.active_utility_commands.insert(
            "cmd_manual".to_string(),
            ActiveUtilityCommand {
                command_id: "cmd_manual".to_string(),
                command: "tail -f log".to_string(),
                cwd: Some("/tmp/project".to_string()),
                shell_mode: UtilityCommandShellMode::Direct,
                terminal_mode: UtilityCommandTerminalMode::Pty,
                pid: Some(7),
                columns: Some(80),
                rows: Some(24),
                owner_connection_id: Some("conn_remote".to_string()),
                output: "partial".to_string(),
            },
        );
        supervisor.state.active_file_watches.insert(
            "watch_manual".to_string(),
            ActiveFileWatch {
                watch_id: "watch_manual".to_string(),
                root_dir: "/tmp/project".to_string(),
                include_patterns: Some(vec!["src/**".to_string()]),
                exclude_patterns: None,
                debounce_ms: 250,
                owner_connection_id: Some("conn_remote".to_string()),
            },
        );

        supervisor.disconnect();

        assert!(supervisor.state().current_response.is_none());
        assert!(supervisor.state().pending_approvals.is_empty());
        assert!(supervisor.state().pending_client_tools.is_empty());
        assert!(supervisor.state().pending_user_inputs.is_empty());
        assert!(supervisor.state().pending_tool_retries.is_empty());
        assert!(supervisor.state().active_tools.is_empty());
        assert!(supervisor.state().active_utility_commands.is_empty());
        assert!(supervisor.state().active_file_watches.is_empty());
        assert!(supervisor.state().tracked_tools.is_empty());
        assert!(!supervisor.state().is_responding);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_resets_health_deadline_before_remote_reply_arrives() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script_path = create_test_headless_script(temp.path()).expect("script");

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.health_check_interval = Duration::from_millis(10);
        config.health_check_timeout = Duration::from_millis(10);
        config.auto_reconnect = false;
        let degraded_timeout = config.health_check_interval + config.health_check_timeout;

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.connect().await.expect("connect");

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        let _ = supervisor.recv().await.expect("ready");

        supervisor.health_status = HealthStatus::Degraded;
        let stale_response_at = Instant::now()
            .checked_sub(Duration::from_millis(25))
            .expect("monotonic clock supports subtraction");
        supervisor.last_response = Some(stale_response_at);

        supervisor.prompt("hello after idle").expect("prompt");

        let stale_deadline = stale_response_at + degraded_timeout;
        assert!(supervisor.due_health_transition(stale_deadline).is_none());
        assert_eq!(supervisor.health(), HealthStatus::Degraded);
    }

    #[test]
    fn transport_disconnect_schedules_auto_reconnect_when_enabled() {
        let mut supervisor = AgentSupervisor::new(SupervisorConfig::default());
        let event = supervisor.handle_transport_disconnect(AsyncTransportError::ChannelClosed);

        assert!(matches!(
            event,
            SupervisorEvent::Disconnected { ref error }
                if error == "Communication channel closed"
        ));
        assert!(supervisor.pending_auto_reconnect);
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
    fn session_replay_does_not_override_explicit_remote_session_id() {
        let replay = SessionReplay {
            state: AgentState {
                session_id: Some("sess_replayed".to_string()),
                is_ready: true,
                ..AgentState::default()
            },
            last_init: None,
        };

        let supervisor = SupervisorBuilder::new()
            .remote_base_url("http://127.0.0.1:8080")
            .remote_session_id("sess_explicit")
            .session_replay(replay)
            .build();

        assert_eq!(
            supervisor
                .config
                .remote
                .as_ref()
                .and_then(|remote| remote.session_id.as_deref()),
            Some("sess_explicit")
        );
        assert_eq!(
            supervisor.state().session_id.as_deref(),
            Some("sess_replayed")
        );
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
            .remote_opt_out_notification("status")
            .build();

        let remote = supervisor.config.remote.expect("remote config");
        assert_eq!(remote.base_url, "http://127.0.0.1:8080");
        assert_eq!(remote.api_key.as_deref(), Some("secret"));
        assert_eq!(remote.session_id.as_deref(), Some("sess_remote"));
        assert_eq!(remote.opt_out_notifications, vec!["status".to_string()]);
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
            request_id: None,
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
log_file="${MAESTRO_TEST_LOG:-}"
if [ -n "$log_file" ]; then
  : > "$log_file"
fi
printf '{"type":"ready","model":"test","provider":"test"}\n'
while IFS= read -r line; do
  if [ -n "$log_file" ]; then
    printf '%s\n' "$line" >> "$log_file"
  fi
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

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
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
        for _ in 0..80 {
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
        let (addr, posted_bodies, request_headers, _request_bodies) =
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
        let posted_bodies = posted_bodies.lock().await.clone();
        assert_eq!(posted_bodies.len(), 1);
        let sent =
            serde_json::from_str::<ToAgentMessage>(&posted_bodies[0]).expect("parse sent message");
        assert!(matches!(sent, ToAgentMessage::Hello { .. }));
        let headers = request_headers.lock().await.clone();
        assert!(headers.first().is_some_and(|request| {
            request
                .iter()
                .any(|(name, value)| name == "authorization" && value == "Bearer secret")
        }));

        supervisor.disconnect();
    }

    #[tokio::test]
    async fn recv_prioritizes_supervisor_events_before_remote_agent_messages() {
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
        let (addr, _posted_bodies, _request_headers, _request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![status_event]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .remote_api_key("secret")
            .remote_session_id("sess_remote")
            .build();

        supervisor.connect().await.expect("connect");

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::StateHydrated {
                session_id: Some(ref session_id)
            }) if session_id == "sess_remote"
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
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

        supervisor.disconnect();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recv_auto_reconnects_after_transport_disconnect() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script_path = create_streaming_headless_script(temp.path()).expect("script");

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.reconnect_delay = Duration::from_millis(5);
        config.max_reconnect_attempts = 1;
        config.auto_reconnect = true;

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.connect().await.expect("connect");

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        for _ in 0..4 {
            let _ = supervisor.recv().await.expect("initial agent event");
        }

        let disconnect = supervisor.handle_transport_disconnect(AsyncTransportError::ChannelClosed);
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error == "Communication channel closed"
        ));

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Reconnecting
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Reconnecting {
                attempt: 1,
                max_attempts: 1
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Agent(agent_event))
                if matches!(*agent_event, AgentEvent::Ready { .. })
        ));

        supervisor.disconnect();
    }

    #[tokio::test]
    async fn failed_auto_reconnect_emits_disconnected_instead_of_hanging() {
        let mut config = SupervisorConfig::default();
        config.transport.cli_path = "/definitely/missing/maestro-headless".to_string();
        config.reconnect_delay = Duration::from_millis(1);
        config.max_reconnect_attempts = 1;
        config.auto_reconnect = true;

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.pending_auto_reconnect = true;

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Reconnecting
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Reconnecting {
                attempt: 1,
                max_attempts: 1
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Unhealthy
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Disconnected { ref error })
                if error.contains("Failed to spawn agent")
        ));
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
        assert!(!supervisor.pending_auto_reconnect);
        assert!(!supervisor.is_connected());
    }

    #[tokio::test]
    async fn non_retryable_remote_disconnect_does_not_schedule_auto_reconnect() {
        let mut supervisor = SupervisorBuilder::new().build();

        let disconnect =
            supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                status: 409,
                retryable: false,
                kind: RemoteErrorKind::ControllerLeaseConflict,
                message: "remote request failed with status 409 Conflict".to_string(),
            });
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error.contains("409 Conflict")
        ));
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
        assert!(!supervisor.pending_auto_reconnect);
        assert!(supervisor.poll().is_none());
    }

    #[tokio::test]
    async fn non_retryable_remote_disconnect_shuts_down_transport() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 0,
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
        let (addr, _posted_bodies, _request_headers, _request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let transport = RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: format!("http://{addr}"),
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");
        let cancel_token = transport.cancel_token();

        let mut supervisor = SupervisorBuilder::new().build();
        supervisor.transport = Some(ManagedTransport::Remote(transport));

        let disconnect =
            supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                status: 409,
                retryable: false,
                kind: RemoteErrorKind::ControllerLeaseConflict,
                message: "remote request failed with status 409 Conflict".to_string(),
            });

        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error.contains("409 Conflict")
        ));
        tokio::time::timeout(Duration::from_secs(1), cancel_token.cancelled())
            .await
            .expect("cancel token should be cancelled");
        assert!(supervisor.transport.is_none());
    }

    #[test]
    fn stale_reference_disconnects_respect_retry_budget() {
        let mut supervisor = SupervisorBuilder::new().max_reconnect_attempts(0).build();

        for attempt in 1..=MAX_STALE_REMOTE_REFERENCE_RETRIES {
            let disconnect =
                supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                    status: 404,
                    retryable: true,
                    kind: RemoteErrorKind::StaleSubscriber,
                    message: "remote request failed with status 404 Not Found: {\"error\":\"Headless subscriber not found\"}".to_string(),
                });
            assert!(matches!(
                disconnect,
                SupervisorEvent::Disconnected { ref error }
                    if error.contains("Headless subscriber not found")
            ));
            assert_eq!(supervisor.stale_reference_retries, attempt);
            assert!(supervisor.pending_auto_reconnect);
            supervisor.pending_auto_reconnect = false;
        }

        let disconnect =
            supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: true,
                kind: RemoteErrorKind::StaleSubscriber,
                message: "remote request failed with status 404 Not Found: {\"error\":\"Headless subscriber not found\"}".to_string(),
            });
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error.contains("Headless subscriber not found")
        ));
        assert_eq!(
            supervisor.stale_reference_retries,
            MAX_STALE_REMOTE_REFERENCE_RETRIES + 1
        );
        assert!(!supervisor.pending_auto_reconnect);
    }

    #[test]
    fn stale_session_disconnects_respect_retry_budget() {
        let mut supervisor = SupervisorBuilder::new().max_reconnect_attempts(0).build();

        for attempt in 1..=MAX_STALE_REMOTE_REFERENCE_RETRIES {
            let disconnect =
                supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                    status: 404,
                    retryable: true,
                    kind: RemoteErrorKind::StaleSession,
                    message: "remote request failed with status 404 Not Found: {\"error\":\"Headless session not found\"}".to_string(),
                });
            assert!(matches!(
                disconnect,
                SupervisorEvent::Disconnected { ref error }
                    if error.contains("Headless session not found")
            ));
            assert_eq!(supervisor.stale_reference_retries, attempt);
            assert!(supervisor.pending_auto_reconnect);
            supervisor.pending_auto_reconnect = false;
        }

        let disconnect =
            supervisor.handle_transport_disconnect(AsyncTransportError::RemoteStatus {
                status: 404,
                retryable: true,
                kind: RemoteErrorKind::StaleSession,
                message: "remote request failed with status 404 Not Found: {\"error\":\"Headless session not found\"}".to_string(),
            });
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error.contains("Headless session not found")
        ));
        assert_eq!(
            supervisor.stale_reference_retries,
            MAX_STALE_REMOTE_REFERENCE_RETRIES + 1
        );
        assert!(!supervisor.pending_auto_reconnect);
    }

    #[tokio::test]
    async fn successful_remote_connect_resets_stale_reference_retry_budget() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 0,
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
        let (addr, _posted_bodies, _request_headers, _request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .build();
        supervisor.stale_reference_retries = MAX_STALE_REMOTE_REFERENCE_RETRIES;

        supervisor.connect().await.expect("connect");
        assert_eq!(supervisor.stale_reference_retries, 0);
    }

    #[tokio::test]
    async fn remote_auto_reconnect_reuses_bootstrapped_session_id() {
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
        let (addr, _posted_bodies, _request_headers, request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .max_reconnect_attempts(1)
            .reconnect_delay(Duration::from_millis(5))
            .build();

        supervisor.connect().await.expect("connect");
        assert_eq!(
            supervisor
                .config
                .remote
                .as_ref()
                .and_then(|config| config.session_id.as_deref()),
            Some("sess_remote")
        );

        let disconnect = supervisor.handle_transport_disconnect(AsyncTransportError::ChannelClosed);
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error == "Communication channel closed"
        ));

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::StateHydrated {
                session_id: Some(ref session_id)
            }) if session_id == "sess_remote"
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Reconnecting
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Reconnecting {
                attempt: 1,
                max_attempts: 1
            })
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::StateHydrated {
                session_id: Some(ref session_id)
            }) if session_id == "sess_remote"
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));

        let request_bodies = request_bodies.lock().await.clone();
        let connection_requests = request_bodies
            .into_iter()
            .filter(|(path, _body)| path == "/api/headless/connections")
            .map(|(_path, body)| {
                serde_json::from_str::<serde_json::Value>(&body).expect("valid connection body")
            })
            .collect::<Vec<_>>();
        assert_eq!(connection_requests.len(), 2);
        assert!(connection_requests[0].get("sessionId").is_none());
        assert_eq!(
            connection_requests[1]
                .get("sessionId")
                .and_then(serde_json::Value::as_str),
            Some("sess_remote")
        );

        supervisor.disconnect();
    }

    #[tokio::test]
    async fn remote_reconnect_stops_after_non_retryable_bootstrap_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let bootstrap_attempts = Arc::new(AtomicUsize::new(0));

        tokio::spawn({
            let bootstrap_attempts = Arc::clone(&bootstrap_attempts);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let bootstrap_attempts = Arc::clone(&bootstrap_attempts);
                    tokio::spawn(async move {
                        let Some((path, _headers, _body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        if path == "/api/headless/connections" {
                            bootstrap_attempts.fetch_add(1, Ordering::SeqCst);
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 409 Conflict",
                                "application/json",
                                r#"{"error":"Controller lease is already held by another connection"}"#,
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

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .max_reconnect_attempts(5)
            .reconnect_delay(Duration::from_millis(1))
            .build();

        let error = supervisor
            .reconnect()
            .await
            .expect_err("reconnect should fail");
        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 409,
                retryable: false,
                ..
            }
        ));
        assert_eq!(bootstrap_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
        assert!(!supervisor.pending_auto_reconnect);
    }

    #[tokio::test]
    async fn remote_reconnect_stops_after_elapsed_time_budget_for_retryable_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let bootstrap_attempts = Arc::new(AtomicUsize::new(0));

        tokio::spawn({
            let bootstrap_attempts = Arc::clone(&bootstrap_attempts);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let bootstrap_attempts = Arc::clone(&bootstrap_attempts);
                    tokio::spawn(async move {
                        let Some((path, _headers, _body)) = read_http_request(&mut socket).await
                        else {
                            return;
                        };
                        if path == "/api/headless/connections" {
                            bootstrap_attempts.fetch_add(1, Ordering::SeqCst);
                            write_http_response(
                                &mut socket,
                                "HTTP/1.1 500 Internal Server Error",
                                "application/json",
                                r#"{"error":"temporary upstream failure"}"#,
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

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .max_reconnect_attempts(0)
            .reconnect_delay(Duration::from_millis(5))
            .max_reconnect_elapsed(Duration::from_millis(500))
            .build();

        let error = supervisor
            .reconnect()
            .await
            .expect_err("reconnect should stop after the elapsed time budget");
        assert!(matches!(
            error,
            AsyncTransportError::RemoteStatus {
                status: 500,
                retryable: true,
                ..
            }
        ));
        assert!(bootstrap_attempts.load(Ordering::SeqCst) >= 1);
        assert_eq!(supervisor.health(), HealthStatus::Unhealthy);
        assert!(!supervisor.pending_auto_reconnect);
    }

    #[tokio::test]
    async fn remote_auto_reconnect_reuses_previous_connection_id_without_take_control() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 0,
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
        let (addr, _posted_bodies, _request_headers, request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .max_reconnect_attempts(1)
            .reconnect_delay(Duration::from_millis(5))
            .build();

        supervisor.connect().await.expect("connect");
        let disconnect = supervisor.handle_transport_disconnect(AsyncTransportError::ChannelClosed);
        assert!(matches!(
            disconnect,
            SupervisorEvent::Disconnected { ref error }
                if error == "Communication channel closed"
        ));

        for _ in 0..6 {
            let _ = supervisor.recv().await.expect("supervisor event");
        }

        let request_bodies = request_bodies.lock().await.clone();
        let connection_requests = request_bodies
            .into_iter()
            .filter(|(path, _body)| path == "/api/headless/connections")
            .map(|(_path, body)| {
                serde_json::from_str::<serde_json::Value>(&body).expect("valid connection body")
            })
            .collect::<Vec<_>>();
        assert_eq!(connection_requests.len(), 2);
        assert_eq!(
            connection_requests[1]
                .get("connectionId")
                .and_then(serde_json::Value::as_str),
            Some("conn_remote")
        );
        assert!(
            connection_requests[1].get("takeControl").is_none(),
            "unexpected remote reconnects should reclaim their prior connection id before forcing controller takeover"
        );

        supervisor.disconnect();
    }

    #[tokio::test]
    async fn clean_remote_disconnect_does_not_force_take_control_on_manual_reconnect() {
        let snapshot = serde_json::json!({
            "protocolVersion": "2026-03-30",
            "session_id": "sess_remote",
            "cursor": 0,
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
        let (addr, _posted_bodies, _request_headers, request_bodies) =
            spawn_remote_headless_server(snapshot.to_string(), vec![]).await;

        let mut supervisor = SupervisorBuilder::new()
            .remote_base_url(format!("http://{addr}"))
            .max_reconnect_attempts(1)
            .reconnect_delay(Duration::from_millis(5))
            .build();

        supervisor.connect().await.expect("connect");
        supervisor.disconnect();
        tokio::time::sleep(Duration::from_millis(50)).await;
        supervisor.reconnect().await.expect("manual reconnect");

        let request_bodies = request_bodies.lock().await.clone();
        let connection_requests = request_bodies
            .into_iter()
            .filter(|(path, _body)| path == "/api/headless/connections")
            .map(|(_path, body)| {
                serde_json::from_str::<serde_json::Value>(&body).expect("valid connection body")
            })
            .collect::<Vec<_>>();
        assert_eq!(connection_requests.len(), 2);
        assert!(
            connection_requests[1].get("connectionId").is_none(),
            "clean disconnects clear the remembered connection id before a manual reconnect"
        );
        assert!(
            connection_requests[1].get("takeControl").is_none(),
            "clean disconnects should not force controller takeover on the next manual reconnect"
        );

        supervisor.disconnect();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unhealthy_silence_schedules_auto_reconnect_for_next_recv() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script_path = create_streaming_headless_script(temp.path()).expect("script");

        let mut config = SupervisorConfig::default();
        config.transport.cli_path = script_path.to_string_lossy().into_owned();
        config.health_check_interval = Duration::from_millis(10);
        config.health_check_timeout = Duration::from_millis(10);
        config.reconnect_delay = Duration::from_millis(5);
        config.max_reconnect_attempts = 1;
        config.auto_reconnect = true;

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.connect().await.expect("connect");

        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::Connected)
        ));
        assert!(matches!(
            supervisor.recv().await,
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Healthy
            })
        ));
        for _ in 0..4 {
            let _ = supervisor.recv().await.expect("initial agent event");
        }

        supervisor.health_status = HealthStatus::Degraded;
        supervisor.last_response = Some(
            Instant::now()
                .checked_sub(Duration::from_millis(25))
                .expect("monotonic clock supports subtraction"),
        );
        supervisor.state.current_response = Some(StreamingResponse::new("resp_silence".into()));
        supervisor.state.is_responding = true;
        let approval = PendingApproval {
            call_id: "call_silence".to_string(),
            request_id: Some("req_silence".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "git push" }),
        };
        let client_tool = PendingApproval {
            call_id: "call_client_silence".to_string(),
            request_id: Some("req_client_silence".to_string()),
            tool: "client_tool".to_string(),
            args: serde_json::json!({ "name": "artifacts" }),
        };
        let user_input = PendingApproval {
            call_id: "call_user_silence".to_string(),
            request_id: Some("req_user_silence".to_string()),
            tool: "ask_user".to_string(),
            args: serde_json::json!({ "question": "continue?" }),
        };
        let tool_retry = PendingApproval {
            call_id: "call_retry_silence".to_string(),
            request_id: Some("req_retry_silence".to_string()),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "retry" }),
        };
        supervisor.state.pending_approvals.push(approval.clone());
        supervisor
            .state
            .pending_client_tools
            .push(client_tool.clone());
        supervisor
            .state
            .pending_user_inputs
            .push(user_input.clone());
        supervisor
            .state
            .pending_tool_retries
            .push(tool_retry.clone());
        supervisor
            .state
            .tracked_tools
            .insert(approval.call_id.clone(), approval);
        supervisor
            .state
            .tracked_tools
            .insert(client_tool.call_id.clone(), client_tool);
        supervisor
            .state
            .tracked_tools
            .insert(user_input.call_id.clone(), user_input);
        supervisor
            .state
            .tracked_tools
            .insert(tool_retry.call_id.clone(), tool_retry);
        supervisor.state.active_tools.insert(
            "call_silence".to_string(),
            ActiveTool {
                call_id: "call_silence".to_string(),
                tool: "grep".to_string(),
                output: "partial".to_string(),
                started: Instant::now(),
            },
        );
        supervisor.state.active_utility_commands.insert(
            "cmd_silence".to_string(),
            ActiveUtilityCommand {
                command_id: "cmd_silence".to_string(),
                command: "sleep 10".to_string(),
                cwd: Some("/tmp/project".to_string()),
                shell_mode: UtilityCommandShellMode::Shell,
                terminal_mode: UtilityCommandTerminalMode::Pipe,
                pid: Some(99),
                columns: None,
                rows: None,
                owner_connection_id: Some("conn_remote".to_string()),
                output: "partial".to_string(),
            },
        );
        supervisor.state.active_file_watches.insert(
            "watch_silence".to_string(),
            ActiveFileWatch {
                watch_id: "watch_silence".to_string(),
                root_dir: "/tmp/project".to_string(),
                include_patterns: None,
                exclude_patterns: Some(vec!["dist/**".to_string()]),
                debounce_ms: 500,
                owner_connection_id: Some("conn_remote".to_string()),
            },
        );

        assert!(matches!(
            supervisor.due_health_transition(Instant::now()),
            Some(SupervisorEvent::HealthChanged {
                status: HealthStatus::Unhealthy
            })
        ));
        assert!(!supervisor.is_connected());
        assert!(supervisor.pending_auto_reconnect);
        assert!(supervisor.state().current_response.is_none());
        assert_eq!(supervisor.state().pending_approvals.len(), 1);
        assert_eq!(supervisor.state().pending_client_tools.len(), 1);
        assert_eq!(supervisor.state().pending_user_inputs.len(), 1);
        assert_eq!(supervisor.state().pending_tool_retries.len(), 1);
        assert!(supervisor.state().active_tools.is_empty());
        assert!(supervisor.state().active_utility_commands.is_empty());
        assert!(supervisor.state().active_file_watches.is_empty());
        assert_eq!(supervisor.state().tracked_tools.len(), 4);
        assert!(!supervisor.state().is_responding);
    }
}

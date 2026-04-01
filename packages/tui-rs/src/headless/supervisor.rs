//! Agent supervisor with reconnection and health monitoring
//!
//! Wraps the transport layer to provide:
//! - Automatic reconnection on failure
//! - Health monitoring with heartbeats
//! - Graceful degradation

use std::time::{Duration, Instant};

use tokio::sync::mpsc;
// Note: interval/timeout available for future health checking
use tokio_util::sync::CancellationToken;

use super::async_transport::{AsyncAgentTransport, AsyncTransportConfig, AsyncTransportError};
use super::messages::{AgentEvent, AgentState, InitConfig, ToAgentMessage};
use super::session::{SessionRecorder, SessionReplay};

/// Supervisor configuration
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// Transport configuration
    pub transport: AsyncTransportConfig,
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
    /// Connection lost
    Disconnected { error: String },
    /// Reconnecting
    Reconnecting { attempt: u32, max_attempts: u32 },
    /// Health status changed
    HealthChanged { status: HealthStatus },
    /// Supervisor shutting down
    ShuttingDown,
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
    transport: Option<AsyncAgentTransport>,
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

    /// Connect to the agent
    pub async fn connect(&mut self) -> Result<(), AsyncTransportError> {
        let transport = AsyncAgentTransport::spawn(self.config.transport.clone()).await?;
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

            match AsyncAgentTransport::spawn(self.config.transport.clone()).await {
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
        // Record to session if available
        if let Some(ref mut recorder) = self.session_recorder {
            let _ = recorder.record_sent(&msg);
        }

        match &self.transport {
            Some(transport) => transport.send(msg),
            None => Err(AsyncTransportError::ChannelClosed),
        }
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

    fn set_transport(&mut self, transport: AsyncAgentTransport) -> Result<(), AsyncTransportError> {
        self.transport = Some(transport);
        if let Err(error) = self.replay_saved_init() {
            if let Some(transport) = self.transport.take() {
                let _ = transport.shutdown();
            }
            return Err(error);
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

    fn apply_agent_event(&mut self, event: &AgentEvent) {
        if let Some(msg) = event_to_message(event) {
            let _ = self.state.handle_message(msg.clone());
            if let Some(ref mut recorder) = self.session_recorder {
                let _ = recorder.record_received(&msg);
            }
        }
    }

    /// Poll for events (non-blocking)
    pub fn poll(&mut self) -> Option<SupervisorEvent> {
        // First check for transport events
        if let Some(ref mut transport) = self.transport {
            if let Some(result) = transport.try_recv() {
                match result {
                    Ok(event) => {
                        self.last_response = Some(Instant::now());
                        self.apply_agent_event(&event);

                        return Some(SupervisorEvent::Agent(Box::new(event)));
                    }
                    Err(e) => {
                        self.transport = None;
                        self.health_status = HealthStatus::Unhealthy;
                        let _ = self.event_tx.send(SupervisorEvent::Disconnected {
                            error: e.to_string(),
                        });
                    }
                }
            }
        }

        // Then check for supervisor events
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
        // First check transport
        if let Some(ref mut transport) = self.transport {
            match transport.recv().await {
                Ok(event) => {
                    self.last_response = Some(Instant::now());
                    self.apply_agent_event(&event);

                    return Some(SupervisorEvent::Agent(Box::new(event)));
                }
                Err(e) => {
                    self.transport = None;
                    self.health_status = HealthStatus::Unhealthy;
                    return Some(SupervisorEvent::Disconnected {
                        error: e.to_string(),
                    });
                }
            }
        }

        // If no transport, wait for supervisor events
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
        self.transport.as_ref()
    }

    /// Get mutable transport
    pub fn transport_mut(&mut self) -> Option<&mut AsyncAgentTransport> {
        self.transport.as_mut()
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

/// Convert an `AgentEvent` back to a `FromAgentMessage` for recording
fn event_to_message(event: &AgentEvent) -> Option<super::messages::FromAgentMessage> {
    use super::messages::FromAgentMessage;
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
mod tests {
    use super::*;
    use crate::headless::{HeadlessErrorType, TokenUsage};
    use std::fs;

    #[cfg(unix)]
    use std::{os::unix::fs::PermissionsExt, path::Path};

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
        let log_path = temp.path().join("agent-stdin.log");
        let script_path = create_test_headless_script(temp.path()).expect("script");

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

        let mut supervisor = AgentSupervisor::new(config);
        supervisor.connect().await.expect("connect");
        supervisor.init(init.clone()).expect("initial init");
        tokio::time::sleep(Duration::from_millis(100)).await;

        supervisor.disconnect();
        tokio::time::sleep(Duration::from_millis(50)).await;

        supervisor.reconnect().await.expect("reconnect");
        tokio::time::sleep(Duration::from_millis(100)).await;

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

        assert_eq!(logged_inits.len(), 2);
        for (system_prompt, append_system_prompt, thinking_level, approval_mode) in logged_inits {
            assert_eq!(system_prompt, init.system_prompt);
            assert_eq!(append_system_prompt, init.append_system_prompt);
            assert_eq!(thinking_level, init.thinking_level);
            assert_eq!(approval_mode, init.approval_mode);
        }
    }
}

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
use super::messages::{AgentEvent, ToAgentMessage};
use super::session::SessionRecorder;

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
    Agent(AgentEvent),
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

    /// Connect to the agent
    pub async fn connect(&mut self) -> Result<(), AsyncTransportError> {
        let transport = AsyncAgentTransport::spawn(self.config.transport.clone()).await?;
        self.transport = Some(transport);
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
                    self.transport = Some(transport);
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

    /// Poll for events (non-blocking)
    pub fn poll(&mut self) -> Option<SupervisorEvent> {
        // First check for transport events
        if let Some(ref mut transport) = self.transport {
            if let Some(result) = transport.try_recv() {
                match result {
                    Ok(event) => {
                        self.last_response = Some(Instant::now());

                        // Record to session if available
                        if let Some(ref mut recorder) = self.session_recorder {
                            // Convert event back to message for recording
                            if let Some(msg) = event_to_message(&event) {
                                let _ = recorder.record_received(&msg);
                            }
                        }

                        return Some(SupervisorEvent::Agent(event));
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

                    // Record to session if available
                    if let Some(ref mut recorder) = self.session_recorder {
                        if let Some(msg) = event_to_message(&event) {
                            let _ = recorder.record_received(&msg);
                        }
                    }

                    return Some(SupervisorEvent::Agent(event));
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
        AgentEvent::Ready { model, provider } => Some(FromAgentMessage::Ready {
            model: model.clone(),
            provider: provider.clone(),
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
            ..
        } => Some(FromAgentMessage::ResponseEnd {
            response_id: response_id.clone(),
            usage: usage.clone(),
            tools_summary: tools_summary.clone(),
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
        AgentEvent::Error { message, fatal } => Some(FromAgentMessage::Error {
            message: message.clone(),
            fatal: *fatal,
        }),
        AgentEvent::Status { message } => Some(FromAgentMessage::Status {
            message: message.clone(),
        }),
    }
}

/// Builder for `AgentSupervisor`
pub struct SupervisorBuilder {
    config: SupervisorConfig,
    session_recorder: Option<SessionRecorder>,
}

impl SupervisorBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            config: SupervisorConfig::default(),
            session_recorder: None,
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

    /// Build the supervisor
    #[must_use]
    pub fn build(self) -> AgentSupervisor {
        let mut supervisor = AgentSupervisor::new(self.config);
        if let Some(recorder) = self.session_recorder {
            supervisor = supervisor.with_session_recorder(recorder);
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
    }
}

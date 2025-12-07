//! Async transport layer for agent communication
//!
//! Provides tokio-based async communication with the Node.js agent subprocess.
//! This is the recommended transport for async applications.

use std::process::Stdio;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

use super::messages::{AgentEvent, AgentState, FromAgentMessage, ToAgentMessage};

/// Configuration for the async agent transport
#[derive(Debug, Clone)]
pub struct AsyncTransportConfig {
    /// Path to the composer CLI (default: "composer")
    pub cli_path: String,
    /// Working directory for the agent
    pub cwd: Option<String>,
    /// Additional arguments to pass to the agent
    pub extra_args: Vec<String>,
    /// Environment variables to set
    pub env: Vec<(String, String)>,
    /// Read timeout for messages (default: no timeout)
    pub read_timeout: Option<Duration>,
    /// Buffer size for stdout reader (default: 1MB)
    pub buffer_size: usize,
}

impl Default for AsyncTransportConfig {
    fn default() -> Self {
        Self {
            cli_path: "composer".to_string(),
            cwd: None,
            extra_args: Vec::new(),
            env: Vec::new(),
            read_timeout: None,
            buffer_size: 1024 * 1024, // 1MB
        }
    }
}

/// Error type for async transport operations
#[derive(Debug)]
pub enum AsyncTransportError {
    /// Failed to spawn the agent process
    SpawnFailed(std::io::Error),
    /// Failed to send message to agent
    SendFailed(String),
    /// Failed to parse message from agent
    ParseFailed(String),
    /// Agent process exited unexpectedly
    ProcessExited(Option<i32>),
    /// Communication channel closed
    ChannelClosed,
    /// Operation timed out
    Timeout,
    /// Operation was cancelled
    Cancelled,
}

impl std::fmt::Display for AsyncTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AsyncTransportError::SpawnFailed(e) => write!(f, "Failed to spawn agent: {}", e),
            AsyncTransportError::SendFailed(e) => write!(f, "Failed to send to agent: {}", e),
            AsyncTransportError::ParseFailed(e) => write!(f, "Failed to parse agent message: {}", e),
            AsyncTransportError::ProcessExited(code) => {
                write!(f, "Agent process exited with code: {:?}", code)
            }
            AsyncTransportError::ChannelClosed => write!(f, "Communication channel closed"),
            AsyncTransportError::Timeout => write!(f, "Operation timed out"),
            AsyncTransportError::Cancelled => write!(f, "Operation was cancelled"),
        }
    }
}

impl std::error::Error for AsyncTransportError {}

/// Handle for async communication with the agent process
pub struct AsyncAgentTransport {
    /// Sender for outgoing messages
    message_tx: mpsc::UnboundedSender<ToAgentMessage>,
    /// Receiver for incoming events
    event_rx: mpsc::UnboundedReceiver<Result<AgentEvent, AsyncTransportError>>,
    /// Current agent state
    state: AgentState,
    /// Cancellation token for graceful shutdown
    cancel_token: CancellationToken,
    /// Handle to the reader task
    _reader_handle: tokio::task::JoinHandle<()>,
    /// Handle to the writer task
    _writer_handle: tokio::task::JoinHandle<()>,
}

impl AsyncAgentTransport {
    /// Spawn a new agent process and connect to it
    pub async fn spawn(config: AsyncTransportConfig) -> Result<Self, AsyncTransportError> {
        let mut cmd = Command::new(&config.cli_path);
        cmd.arg("--headless")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        if let Some(ref cwd) = config.cwd {
            cmd.current_dir(cwd);
        }

        for arg in &config.extra_args {
            cmd.arg(arg);
        }

        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(AsyncTransportError::SpawnFailed)?;

        let stdin = child.stdin.take().expect("Failed to get stdin");
        let stdout = child.stdout.take().expect("Failed to get stdout");

        // Channels
        let (message_tx, message_rx) = mpsc::unbounded_channel::<ToAgentMessage>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<Result<AgentEvent, AsyncTransportError>>();

        let cancel_token = CancellationToken::new();

        // Spawn writer task
        let writer_cancel = cancel_token.clone();
        let writer_event_tx = event_tx.clone();
        let writer_handle = tokio::spawn(async move {
            Self::writer_loop(stdin, message_rx, writer_event_tx, writer_cancel).await;
        });

        // Spawn reader task
        let reader_cancel = cancel_token.clone();
        let reader_handle = tokio::spawn(async move {
            Self::reader_loop(stdout, child, event_tx, reader_cancel, config.buffer_size).await;
        });

        Ok(Self {
            message_tx,
            event_rx,
            state: AgentState::default(),
            cancel_token,
            _reader_handle: reader_handle,
            _writer_handle: writer_handle,
        })
    }

    /// Writer loop - sends messages to agent stdin
    async fn writer_loop(
        mut stdin: tokio::process::ChildStdin,
        mut rx: mpsc::UnboundedReceiver<ToAgentMessage>,
        error_tx: mpsc::UnboundedSender<Result<AgentEvent, AsyncTransportError>>,
        cancel: CancellationToken,
    ) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                msg = rx.recv() => {
                    match msg {
                        Some(msg) => {
                            let json = match serde_json::to_string(&msg) {
                                Ok(j) => j,
                                Err(e) => {
                                    let _ = error_tx.send(Err(AsyncTransportError::ParseFailed(e.to_string())));
                                    continue;
                                }
                            };

                            if let Err(e) = stdin.write_all(json.as_bytes()).await {
                                let _ = error_tx.send(Err(AsyncTransportError::SendFailed(e.to_string())));
                                break;
                            }

                            if let Err(e) = stdin.write_all(b"\n").await {
                                let _ = error_tx.send(Err(AsyncTransportError::SendFailed(e.to_string())));
                                break;
                            }

                            if let Err(e) = stdin.flush().await {
                                let _ = error_tx.send(Err(AsyncTransportError::SendFailed(e.to_string())));
                                break;
                            }
                        }
                        None => break, // Channel closed
                    }
                }
            }
        }
    }

    /// Reader loop - reads messages from agent stdout
    async fn reader_loop(
        stdout: tokio::process::ChildStdout,
        mut child: Child,
        tx: mpsc::UnboundedSender<Result<AgentEvent, AsyncTransportError>>,
        cancel: CancellationToken,
        buffer_size: usize,
    ) {
        let reader = BufReader::with_capacity(buffer_size, stdout);
        let mut lines = reader.lines();
        let mut state = AgentState::default();

        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                line_result = lines.next_line() => {
                    match line_result {
                        Ok(Some(line)) if line.trim().is_empty() => continue,
                        Ok(Some(line)) => {
                            match serde_json::from_str::<FromAgentMessage>(&line) {
                                Ok(msg) => {
                                    if let Some(event) = state.handle_message(msg) {
                                        if tx.send(Ok(event)).is_err() {
                                            break;
                                        }
                                    }
                                }
                                Err(e) => {
                                    // Log but continue - don't break on parse errors
                                    eprintln!("Parse error: {} - {}", e, &line[..line.len().min(100)]);
                                }
                            }
                        }
                        Ok(None) => {
                            // EOF - process closed stdout
                            break;
                        }
                        Err(e) => {
                            let _ = tx.send(Err(AsyncTransportError::SendFailed(e.to_string())));
                            break;
                        }
                    }
                }
            }
        }

        // Process ended, get exit code
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = tx.send(Err(AsyncTransportError::ProcessExited(code)));
    }

    /// Send a message to the agent
    pub fn send(&self, msg: ToAgentMessage) -> Result<(), AsyncTransportError> {
        self.message_tx
            .send(msg)
            .map_err(|_| AsyncTransportError::ChannelClosed)
    }

    /// Send a user prompt
    pub fn prompt(&self, content: impl Into<String>) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Prompt {
            content: content.into(),
            attachments: None,
        })
    }

    /// Send a prompt with file attachments
    pub fn prompt_with_attachments(
        &self,
        content: impl Into<String>,
        attachments: Vec<String>,
    ) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Prompt {
            content: content.into(),
            attachments: Some(attachments),
        })
    }

    /// Interrupt the current operation
    pub fn interrupt(&self) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Interrupt)
    }

    /// Cancel the current operation
    pub fn cancel(&self) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::Cancel)
    }

    /// Approve a tool call
    pub fn approve_tool(&self, call_id: impl Into<String>) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::ToolResponse {
            call_id: call_id.into(),
            approved: true,
            result: None,
        })
    }

    /// Deny a tool call
    pub fn deny_tool(&self, call_id: impl Into<String>) -> Result<(), AsyncTransportError> {
        self.send(ToAgentMessage::ToolResponse {
            call_id: call_id.into(),
            approved: false,
            result: None,
        })
    }

    /// Shut down the agent
    pub fn shutdown(&self) -> Result<(), AsyncTransportError> {
        let result = self.send(ToAgentMessage::Shutdown);
        self.cancel_token.cancel();
        result
    }

    /// Try to receive an event without blocking
    pub fn try_recv(&mut self) -> Option<Result<AgentEvent, AsyncTransportError>> {
        match self.event_rx.try_recv() {
            Ok(result) => {
                if let Ok(ref event) = result {
                    self.update_local_state(event);
                }
                Some(result)
            }
            Err(mpsc::error::TryRecvError::Empty) => None,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                Some(Err(AsyncTransportError::ChannelClosed))
            }
        }
    }

    /// Receive an event, blocking until one is available
    pub async fn recv(&mut self) -> Result<AgentEvent, AsyncTransportError> {
        let result = self
            .event_rx
            .recv()
            .await
            .ok_or(AsyncTransportError::ChannelClosed)?;

        if let Ok(ref event) = result {
            self.update_local_state(event);
        }

        result
    }

    /// Receive an event with a timeout
    pub async fn recv_timeout(
        &mut self,
        duration: Duration,
    ) -> Result<AgentEvent, AsyncTransportError> {
        match timeout(duration, self.event_rx.recv()).await {
            Ok(Some(result)) => {
                if let Ok(ref event) = result {
                    self.update_local_state(event);
                }
                result
            }
            Ok(None) => Err(AsyncTransportError::ChannelClosed),
            Err(_) => Err(AsyncTransportError::Timeout),
        }
    }

    /// Update local state based on an event
    fn update_local_state(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::Ready { model, provider } => {
                self.state.model = Some(model.clone());
                self.state.provider = Some(provider.clone());
                self.state.is_ready = true;
            }
            AgentEvent::SessionInfo {
                session_id,
                cwd,
                git_branch,
            } => {
                self.state.session_id = session_id.clone();
                self.state.cwd = Some(cwd.clone());
                self.state.git_branch = git_branch.clone();
            }
            AgentEvent::ResponseStart { .. } => {
                self.state.is_responding = true;
            }
            AgentEvent::ResponseEnd { .. } => {
                self.state.is_responding = false;
            }
            _ => {}
        }
    }

    /// Get a reference to the current agent state
    pub fn state(&self) -> &AgentState {
        &self.state
    }

    /// Check if the agent is ready
    pub fn is_ready(&self) -> bool {
        self.state.is_ready
    }

    /// Check if the agent is currently responding
    pub fn is_responding(&self) -> bool {
        self.state.is_responding
    }

    /// Get the model name
    pub fn model(&self) -> Option<&str> {
        self.state.model.as_deref()
    }

    /// Get the provider name
    pub fn provider(&self) -> Option<&str> {
        self.state.provider.as_deref()
    }

    /// Get the cancellation token for external cancellation
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }
}

/// Builder for creating an AsyncAgentTransport
pub struct AsyncAgentTransportBuilder {
    config: AsyncTransportConfig,
}

impl AsyncAgentTransportBuilder {
    pub fn new() -> Self {
        Self {
            config: AsyncTransportConfig::default(),
        }
    }

    /// Set the CLI path
    pub fn cli_path(mut self, path: impl Into<String>) -> Self {
        self.config.cli_path = path.into();
        self
    }

    /// Set the working directory
    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.config.cwd = Some(cwd.into());
        self
    }

    /// Add an extra argument
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.config.extra_args.push(arg.into());
        self
    }

    /// Add environment variable
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.config.env.push((key.into(), value.into()));
        self
    }

    /// Set read timeout
    pub fn read_timeout(mut self, duration: Duration) -> Self {
        self.config.read_timeout = Some(duration);
        self
    }

    /// Set buffer size
    pub fn buffer_size(mut self, size: usize) -> Self {
        self.config.buffer_size = size;
        self
    }

    /// Build and spawn the transport
    pub async fn spawn(self) -> Result<AsyncAgentTransport, AsyncTransportError> {
        AsyncAgentTransport::spawn(self.config).await
    }
}

impl Default for AsyncAgentTransportBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn async_config_defaults() {
        let config = AsyncTransportConfig::default();
        assert_eq!(config.cli_path, "composer");
        assert!(config.cwd.is_none());
        assert!(config.extra_args.is_empty());
        assert!(config.read_timeout.is_none());
        assert_eq!(config.buffer_size, 1024 * 1024);
    }

    #[test]
    fn async_builder_sets_options() {
        let builder = AsyncAgentTransportBuilder::new()
            .cli_path("/usr/bin/composer")
            .cwd("/home/user/project")
            .arg("--model")
            .arg("claude-3-opus")
            .env("API_KEY", "secret")
            .read_timeout(Duration::from_secs(30))
            .buffer_size(2 * 1024 * 1024);

        assert_eq!(builder.config.cli_path, "/usr/bin/composer");
        assert_eq!(builder.config.cwd, Some("/home/user/project".to_string()));
        assert_eq!(builder.config.extra_args.len(), 2);
        assert_eq!(builder.config.env.len(), 1);
        assert_eq!(builder.config.read_timeout, Some(Duration::from_secs(30)));
        assert_eq!(builder.config.buffer_size, 2 * 1024 * 1024);
    }

    #[test]
    fn error_display() {
        let err = AsyncTransportError::SpawnFailed(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        ));
        assert!(err.to_string().contains("spawn"));

        let err = AsyncTransportError::Timeout;
        assert!(err.to_string().contains("timed out"));

        let err = AsyncTransportError::ProcessExited(Some(1));
        assert!(err.to_string().contains("exited"));
    }
}

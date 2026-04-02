//! Transport layer for agent communication.
//!
//! Provides subprocess management and stdio-based IPC for communicating with the
//! Node.js agent process. This module handles process lifecycle, message routing,
//! and concurrent I/O using OS threads.
//!
//! # Architecture
//!
//! The transport layer spawns the Node.js agent as a child process and establishes
//! bidirectional communication:
//!
//! ```text
//! ┌─────────────────┐
//! │   Rust TUI      │
//! │                 │
//! │  AgentTransport │
//! └────────┬────────┘
//!          │
//!    ┌─────┴──────┐
//!    │            │
//! ┌──▼───┐    ┌──▼───┐
//! │Writer│    │Reader│
//! │Thread│    │Thread│
//! └──┬───┘    └──┬───┘
//!    │           │
//!    │   stdin   │ stdout
//!    │           │
//! ┌──▼───────────▼──┐
//! │  Node.js Agent  │
//! │   (Child Proc)  │
//! └─────────────────┘
//! ```
//!
//! # Thread-Based Concurrency
//!
//! The transport uses two OS threads for concurrent I/O:
//!
//! ## Writer Thread
//!
//! - Receives `ToAgentMessage` via an `mpsc` channel
//! - Serializes messages to JSON
//! - Writes to the agent's stdin
//! - Terminates when the channel is closed or write fails
//!
//! ## Reader Thread
//!
//! - Reads from the agent's stdout
//! - Parses newline-delimited JSON
//! - Converts raw messages to `AgentEvent` using state machine
//! - Sends events to the main thread via `mpsc` channel
//! - Monitors process exit and reports termination
//!
//! # Message Passing with mpsc
//!
//! Rust's `std::sync::mpsc` (multi-producer, single-consumer) channels provide
//! thread-safe communication:
//!
//! - **`to_agent_tx/rx`** - Main thread sends messages; writer thread receives
//! - **`from_agent_tx/rx`** - Reader thread sends events; main thread receives
//!
//! Benefits:
//! - **Type-safe** - Compiler enforces correct message types
//! - **Ownership-based** - No shared mutable state
//! - **Blocking operations** - `recv()` blocks until message available
//!
//! # Error Handling
//!
//! Errors from both threads are forwarded to the main thread via the event channel.
//! This allows centralized error handling in the main application loop.
//!
//! # Process Lifecycle
//!
//! The agent process is spawned with:
//! - **stdin** - Piped (controlled by writer thread)
//! - **stdout** - Piped (controlled by reader thread)
//! - **stderr** - Inherited (agent errors appear in parent's stderr)
//!
//! The process is automatically cleaned up when `AgentTransport` is dropped,
//! though child processes may continue running if not explicitly shut down.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use super::messages::{
    AgentEvent, AgentState, ClientCapabilities, ClientInfo, ConnectionRole, FromAgentMessage,
    InitConfig, ServerRequestType, ToAgentMessage, UtilityOperation,
};

/// Error type for transport operations
#[derive(Debug)]
pub enum TransportError {
    /// Failed to spawn the agent process
    SpawnFailed(std::io::Error),
    /// Failed to send message to agent
    SendFailed(std::io::Error),
    /// Failed to parse message from agent
    ParseFailed(serde_json::Error),
    /// Agent process exited unexpectedly
    ProcessExited(Option<i32>),
    /// Channel communication error
    ChannelError(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::SpawnFailed(e) => write!(f, "Failed to spawn agent: {e}"),
            TransportError::SendFailed(e) => write!(f, "Failed to send to agent: {e}"),
            TransportError::ParseFailed(e) => write!(f, "Failed to parse agent message: {e}"),
            TransportError::ProcessExited(code) => {
                write!(f, "Agent process exited with code: {code:?}")
            }
            TransportError::ChannelError(msg) => write!(f, "Channel error: {msg}"),
        }
    }
}

impl std::error::Error for TransportError {}

/// Configuration for the agent transport.
///
/// Specifies how to spawn and configure the Node.js agent process.
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_tui::headless::transport::TransportConfig;
///
/// let config = TransportConfig {
///     cli_path: "maestro".to_string(),
///     cwd: Some("/path/to/project".to_string()),
///     extra_args: vec!["--model".to_string(), "claude-3-opus".to_string()],
///     env: vec![("DEBUG".to_string(), "1".to_string())],
/// };
/// ```
#[derive(Debug, Clone)]
pub struct TransportConfig {
    /// Path to the Maestro CLI (default: "maestro")
    pub cli_path: String,
    /// Working directory for the agent
    pub cwd: Option<String>,
    /// Additional arguments to pass to the agent
    pub extra_args: Vec<String>,
    /// Environment variables to set
    pub env: Vec<(String, String)>,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            cli_path: "maestro".to_string(),
            cwd: None,
            extra_args: Vec::new(),
            env: Vec::new(),
        }
    }
}

/// Handle for communicating with the agent process.
///
/// Provides a synchronous interface for sending messages to and receiving events from
/// the Node.js agent. Internally manages two worker threads for concurrent I/O.
///
/// # Thread Safety
///
/// `AgentTransport` is `Send` but not `Sync`. It can be moved between threads but
/// cannot be shared across threads without synchronization (e.g., `Arc<Mutex<_>>`).
/// The underlying `mpsc::Sender` is `Send` but not `Sync`.
///
/// # Blocking Behavior
///
/// - `recv()` blocks until an event is available or the channel is closed
/// - `try_recv()` returns immediately with `None` if no events are available
/// - `send()` returns immediately (messages are queued internally)
///
/// # State Tracking
///
/// The transport maintains a local copy of `AgentState` that is updated as events
/// are received. This allows synchronous queries like `is_ready()` and `model()`
/// without additional IPC overhead.
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_tui::headless::transport::AgentTransportBuilder;
///
/// let mut transport = AgentTransportBuilder::new()
///     .cli_path("maestro")
///     .spawn()?;
///
/// // Wait for agent to be ready
/// while let Ok(event) = transport.recv() {
///     match event {
///         AgentEvent::Ready { .. } => break,
///         _ => {}
///     }
/// }
///
/// // Send a prompt
/// transport.prompt("Hello!")?;
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub struct AgentTransport {
    /// Sender for messages to the agent
    tx: Sender<ToAgentMessage>,
    /// Receiver for raw protocol messages from the agent
    rx: Receiver<Result<FromAgentMessage, TransportError>>,
    /// Current agent state
    state: AgentState,
    /// Handle to check if process is still running
    _process_handle: thread::JoinHandle<()>,
}

impl AgentTransport {
    /// Spawn a new agent process and connect to it
    pub fn spawn(config: TransportConfig) -> Result<Self, TransportError> {
        let mut cmd = Command::new(&config.cli_path);
        cmd.arg("--headless")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()); // Let errors go to our stderr

        if let Some(ref cwd) = config.cwd {
            cmd.current_dir(cwd);
        }

        for arg in &config.extra_args {
            cmd.arg(arg);
        }

        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(TransportError::SpawnFailed)?;

        let stdin = child.stdin.take().ok_or_else(|| {
            TransportError::SpawnFailed(std::io::Error::other("Failed to get stdin"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            TransportError::SpawnFailed(std::io::Error::other("Failed to get stdout"))
        })?;

        // Channel for sending messages to agent
        let (to_agent_tx, to_agent_rx) = mpsc::channel::<ToAgentMessage>();

        // Channel for receiving events from agent
        let (from_agent_tx, from_agent_rx) =
            mpsc::channel::<Result<FromAgentMessage, TransportError>>();

        // Spawn writer thread
        let writer_tx = from_agent_tx.clone();
        thread::spawn(move || {
            Self::writer_loop(stdin, to_agent_rx, writer_tx);
        });

        // Spawn reader thread
        let reader_tx = from_agent_tx;
        let process_handle = thread::spawn(move || {
            Self::reader_loop(stdout, child, reader_tx);
        });

        let transport = Self {
            tx: to_agent_tx,
            rx: from_agent_rx,
            state: AgentState::default(),
            _process_handle: process_handle,
        };
        transport.send(ToAgentMessage::Hello {
            protocol_version: Some(super::HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: option_env!("CARGO_PKG_VERSION").map(str::to_string),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![ServerRequestType::Approval]),
                utility_operations: Some(vec![UtilityOperation::CommandExec]),
            }),
            role: Some(ConnectionRole::Controller),
        })?;
        Ok(transport)
    }

    /// Writer loop - sends messages to the agent's stdin
    fn writer_loop(
        mut stdin: std::process::ChildStdin,
        rx: Receiver<ToAgentMessage>,
        error_tx: Sender<Result<FromAgentMessage, TransportError>>,
    ) {
        for msg in rx {
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    let _ = error_tx.send(Err(TransportError::ParseFailed(e)));
                    continue;
                }
            };

            if let Err(e) = writeln!(stdin, "{json}") {
                let _ = error_tx.send(Err(TransportError::SendFailed(e)));
                break;
            }

            if let Err(e) = stdin.flush() {
                let _ = error_tx.send(Err(TransportError::SendFailed(e)));
                break;
            }
        }
    }

    /// Reader loop - reads messages from the agent's stdout
    fn reader_loop(
        stdout: std::process::ChildStdout,
        mut child: Child,
        tx: Sender<Result<FromAgentMessage, TransportError>>,
    ) {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    match serde_json::from_str::<FromAgentMessage>(&line) {
                        Ok(msg) => {
                            if tx.send(Ok(msg)).is_err() {
                                break; // Receiver dropped
                            }
                        }
                        Err(e) => {
                            // Log parse error but continue
                            eprintln!("Failed to parse agent message: {e} - {line}");
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(TransportError::SendFailed(e)));
                    break;
                }
            }
        }

        // Process ended, get exit code
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = tx.send(Err(TransportError::ProcessExited(code)));
    }

    /// Send a message to the agent
    pub fn send(&self, msg: ToAgentMessage) -> Result<(), TransportError> {
        self.tx
            .send(msg)
            .map_err(|e| TransportError::ChannelError(e.to_string()))
    }

    /// Send a user prompt
    pub fn prompt(&self, content: impl Into<String>) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Prompt {
            content: content.into(),
            attachments: None,
        })
    }

    /// Configure the agent before sending prompts
    pub fn init(&self, config: InitConfig) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Init {
            system_prompt: config.system_prompt,
            append_system_prompt: config.append_system_prompt,
            thinking_level: config.thinking_level,
            approval_mode: config.approval_mode,
        })
    }

    /// Send a prompt with file attachments
    pub fn prompt_with_attachments(
        &self,
        content: impl Into<String>,
        attachments: Vec<String>,
    ) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Prompt {
            content: content.into(),
            attachments: Some(attachments),
        })
    }

    /// Interrupt the current operation
    pub fn interrupt(&self) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Interrupt)
    }

    /// Cancel the current operation
    pub fn cancel(&self) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Cancel)
    }

    /// Approve a tool call
    pub fn approve_tool(&self, call_id: impl Into<String>) -> Result<(), TransportError> {
        self.send(ToAgentMessage::ToolResponse {
            call_id: call_id.into(),
            approved: true,
            result: None,
        })
    }

    /// Deny a tool call
    pub fn deny_tool(&self, call_id: impl Into<String>) -> Result<(), TransportError> {
        self.send(ToAgentMessage::ToolResponse {
            call_id: call_id.into(),
            approved: false,
            result: None,
        })
    }

    /// Shut down the agent
    pub fn shutdown(&self) -> Result<(), TransportError> {
        self.send(ToAgentMessage::Shutdown)
    }

    /// Try to receive an event without blocking
    pub fn try_recv(&mut self) -> Option<Result<AgentEvent, TransportError>> {
        loop {
            match self.rx.try_recv() {
                Ok(result) => match self.apply_transport_result(result) {
                    Some(result) => return Some(result),
                    None => continue,
                },
                Err(mpsc::TryRecvError::Empty) => return None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Some(Err(TransportError::ChannelError(
                        "Channel disconnected".to_string(),
                    )));
                }
            }
        }
    }

    /// Receive an event, blocking until one is available
    pub fn recv(&mut self) -> Result<AgentEvent, TransportError> {
        loop {
            let result = self
                .rx
                .recv()
                .map_err(|e| TransportError::ChannelError(e.to_string()))?;
            if let Some(result) = self.apply_transport_result(result) {
                return result;
            }
        }
    }

    fn apply_transport_result(
        &mut self,
        result: Result<FromAgentMessage, TransportError>,
    ) -> Option<Result<AgentEvent, TransportError>> {
        match result {
            Ok(message) => self.state.handle_message(message).map(Ok),
            Err(error) => Some(Err(error)),
        }
    }

    /// Get a reference to the current agent state
    #[must_use]
    pub fn state(&self) -> &AgentState {
        &self.state
    }

    /// Check if the agent is ready
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.state.is_ready
    }

    /// Check if the agent is currently responding
    #[must_use]
    pub fn is_responding(&self) -> bool {
        self.state.is_responding
    }

    /// Get the model name
    #[must_use]
    pub fn model(&self) -> Option<&str> {
        self.state.model.as_deref()
    }

    /// Get the provider name
    #[must_use]
    pub fn provider(&self) -> Option<&str> {
        self.state.provider.as_deref()
    }
}

/// Builder for creating an `AgentTransport`
pub struct AgentTransportBuilder {
    config: TransportConfig,
}

impl AgentTransportBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            config: TransportConfig::default(),
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

    /// Build and spawn the transport
    pub fn spawn(self) -> Result<AgentTransport, TransportError> {
        AgentTransport::spawn(self.config)
    }
}

impl Default for AgentTransportBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_config_defaults() {
        let config = TransportConfig::default();
        assert_eq!(config.cli_path, "maestro");
        assert!(config.cwd.is_none());
        assert!(config.extra_args.is_empty());
    }

    #[test]
    fn builder_sets_options() {
        let builder = AgentTransportBuilder::new()
            .cli_path("/usr/bin/composer")
            .cwd("/home/user/project")
            .arg("--model")
            .arg("claude-3-opus")
            .env("API_KEY", "secret");

        assert_eq!(builder.config.cli_path, "/usr/bin/composer");
        assert_eq!(builder.config.cwd, Some("/home/user/project".to_string()));
        assert_eq!(builder.config.extra_args.len(), 2);
        assert_eq!(builder.config.env.len(), 1);
    }

    #[test]
    fn try_recv_skips_messages_without_events() {
        let (tx, _outgoing_rx) = mpsc::channel::<ToAgentMessage>();
        let (incoming_tx, rx) = mpsc::channel::<Result<FromAgentMessage, TransportError>>();
        incoming_tx
            .send(Ok(FromAgentMessage::SessionInfo {
                session_id: Some("sess_123".to_string()),
                cwd: "/tmp/project".to_string(),
                git_branch: Some("main".to_string()),
            }))
            .unwrap();
        incoming_tx
            .send(Ok(FromAgentMessage::Status {
                message: "working".to_string(),
            }))
            .unwrap();

        let process_handle = thread::spawn(|| {});
        let mut transport = AgentTransport {
            tx,
            rx,
            state: AgentState::default(),
            _process_handle: process_handle,
        };

        let session_info = transport.try_recv().expect("session info").expect("ok");
        assert!(matches!(
            session_info,
            AgentEvent::SessionInfo {
                ref cwd,
                git_branch: Some(ref git_branch),
                ..
            } if cwd == "/tmp/project" && git_branch == "main"
        ));

        let status = transport.try_recv().expect("status event").expect("ok");
        assert!(matches!(status, AgentEvent::Status { ref message } if message == "working"));
    }
}

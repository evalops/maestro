//! Headless protocol for communicating with the Node.js agent.
//!
//! This module implements the client side of the headless protocol, spawning the Node.js
//! agent process and communicating via JSON-over-stdio. It provides a multi-layered
//! architecture for inter-process communication (IPC) between Rust and Node.js.
//!
//! # Architecture Overview
//!
//! The headless module provides several layers of abstraction:
//!
//! 1. **Messages** - Protocol message types (ToAgentMessage, FromAgentMessage)
//! 2. **Framing** - Reliable message framing (newline-delimited or length-prefixed)
//! 3. **Transport** - Low-level subprocess communication (sync and async)
//! 4. **Session** - Session persistence (JSONL recording and replay)
//! 5. **Supervisor** - High-level wrapper with reconnection and health monitoring
//!
//! # Protocol Design
//!
//! ## Message-Based Communication
//!
//! The protocol uses a message-passing model where the Rust TUI and Node.js agent exchange
//! structured messages serialized as JSON. This design provides:
//!
//! - **Type safety** via Rust's type system and serde serialization
//! - **Language interoperability** through a language-agnostic JSON format
//! - **Structured data** with well-defined message schemas
//! - **Versioning support** through the `type` discriminator field
//!
//! ## JSON Message Framing
//!
//! Messages are framed using one of two protocols:
//!
//! ### Newline-Delimited JSON (Default)
//!
//! Each message is a single line of JSON terminated by a newline character:
//!
//! ```text
//! {"type":"prompt","content":"Hello"}\n
//! {"type":"response_chunk","response_id":"abc","content":"Hi","is_thinking":false}\n
//! ```
//!
//! This format is:
//! - **Human-readable** for debugging
//! - **Simple to implement** in any language
//! - **Compatible** with line-buffered I/O
//! - **Self-synchronizing** - lost frames don't corrupt subsequent messages
//!
//! ### Length-Prefixed Binary (Optional)
//!
//! For high-performance scenarios, messages can be framed with a 4-byte length prefix:
//!
//! ```text
//! [4-byte big-endian length][JSON bytes]
//! ```
//!
//! This format:
//! - **Avoids scanning** for newlines in large messages
//! - **Supports binary data** within JSON (base64-encoded)
//! - **Predictable performance** - no worst-case linear scanning
//!
//! ## Subprocess Communication Model
//!
//! The transport layer spawns the Node.js agent as a child process and uses:
//!
//! - **stdin** for sending messages (Rust -> Node.js)
//! - **stdout** for receiving messages (Node.js -> Rust)
//! - **stderr** for diagnostic output (inherited from parent)
//!
//! This design allows the agent to run independently while the TUI maintains control
//! over its lifecycle.
//!
//! # Rust Concepts Demonstrated
//!
//! ## Serde Serialization
//!
//! The protocol leverages [serde](https://serde.rs/) for zero-copy, type-safe serialization:
//!
//! ```rust,ignore
//! #[derive(Serialize, Deserialize)]
//! #[serde(tag = "type", rename_all = "snake_case")]
//! enum ToAgentMessage {
//!     Prompt { content: String },
//!     // ... other variants
//! }
//! ```
//!
//! Key features:
//! - **Tagged enums** - `#[serde(tag = "type")]` adds a discriminator field
//! - **Field renaming** - `rename_all = "snake_case"` converts Rust names to JSON convention
//! - **Optional fields** - `#[serde(skip_serializing_if = "Option::is_none")]` omits None values
//!
//! ## Async I/O with Tokio
//!
//! The async transport uses [tokio](https://tokio.rs/) for non-blocking I/O:
//!
//! ```rust,ignore
//! let mut reader = AsyncFrameReader::new(stdout);
//! let event = reader.read_message::<FromAgentMessage>().await?;
//! ```
//!
//! Benefits:
//! - **Concurrent operations** - read and write simultaneously without threads
//! - **Resource efficiency** - single thread handles multiple I/O operations
//! - **Cancellation support** - async tasks can be cancelled cleanly
//!
//! ## Buffered I/O
//!
//! Both sync and async implementations use buffered readers/writers:
//!
//! ```rust,ignore
//! let reader = BufReader::with_capacity(64 * 1024, stdout);
//! ```
//!
//! This reduces system call overhead by:
//! - **Batching reads** - fetch data in larger chunks
//! - **Reducing context switches** - fewer transitions between user/kernel mode
//! - **Improving throughput** - especially important for high-frequency messages
//!
//! ## Thread-Based Concurrency (Sync Transport)
//!
//! The synchronous transport uses OS threads for concurrent reading and writing:
//!
//! ```rust,ignore
//! thread::spawn(move || {
//!     // Reader thread processes stdout
//! });
//! thread::spawn(move || {
//!     // Writer thread processes stdin
//! });
//! ```
//!
//! This pattern:
//! - **Decouples I/O** - read and write operate independently
//! - **Handles blocking** - one blocked operation doesn't stall the other
//! - **Communicates via channels** - thread-safe message passing with mpsc
//!
//! # Usage Examples
//!
//! ## Simple Async Transport
//!
//! For basic use cases, use `AsyncAgentTransport`:
//!
//! ```ignore
//! use maestro_tui::headless::{AsyncAgentTransportBuilder, ToAgentMessage};
//!
//! let mut transport = AsyncAgentTransportBuilder::new()
//!     .cli_path("maestro")
//!     .cwd("/path/to/project")
//!     .spawn()
//!     .await?;
//!
//! // Send a prompt
//! transport.prompt("Hello!")?;
//!
//! // Process response stream
//! while let Ok(event) = transport.recv().await {
//!     match event {
//!         AgentEvent::ResponseChunk { content, .. } => print!("{}", content),
//!         AgentEvent::ResponseEnd { .. } => break,
//!         _ => {}
//!     }
//! }
//! ```
//!
//! ## Production Supervisor with Session Recording
//!
//! For production use with reconnection and session recording, use `AgentSupervisor`:
//!
//! ```ignore
//! use maestro_tui::headless::{SupervisorBuilder, SessionRecorder};
//!
//! // Create session recorder for persistence
//! let recorder = SessionRecorder::new("~/.composer/sessions")?;
//!
//! // Build supervisor with reconnection
//! let mut supervisor = SupervisorBuilder::new()
//!     .cli_path("maestro")
//!     .session_recorder(recorder)
//!     .max_reconnect_attempts(5)
//!     .build();
//!
//! // Connect and use
//! supervisor.connect().await?;
//! supervisor.prompt("Hello!")?;
//! ```
//!
//! # Thread Safety
//!
//! The transport types are designed for different concurrency models:
//!
//! - **AgentTransport** - Uses `mpsc::Sender` which is `Send` but not `Sync`
//! - **AsyncAgentTransport** - Futures are `Send` if used from a single task
//! - **SessionRecorder** - Not thread-safe; use one per transport
//!
//! For multi-threaded scenarios, wrap transports in `Arc<Mutex<_>>` or use the
//! async transport from a single task.

mod async_transport;
mod framing;
mod messages;
mod remote_transport;
mod session;
mod supervisor;
mod transport;

// Core message types
pub use messages::{
    ActiveTool, AgentEvent, AgentState, ApprovalMode, ClientCapabilities, ClientInfo,
    ClientToolResultContent, ConnectionRole, FromAgentMessage, HeadlessErrorType, InitConfig,
    PendingApproval, ServerRequestResolutionStatus,
    ServerRequestResolvedBy, ServerRequestType, StreamingResponse, ThinkingLevel, ToAgentMessage,
    TokenUsage, ToolResult, HEADLESS_PROTOCOL_VERSION,
};

// Sync transport
pub use transport::{AgentTransport, AgentTransportBuilder, TransportConfig, TransportError};

// Async transport
pub use async_transport::{
    AsyncAgentTransport, AsyncAgentTransportBuilder, AsyncTransportConfig, AsyncTransportError,
};

// Remote transport
pub use remote_transport::{RemoteAgentTransport, RemoteIncoming, RemoteTransportConfig};

// Session persistence
pub use session::{
    delete_session, list_sessions, SessionEntry, SessionMetadata, SessionReader, SessionRecorder,
    SessionReplay,
};

// Supervisor with reconnection
pub use supervisor::{
    AgentSupervisor, HealthStatus, SupervisorBuilder, SupervisorConfig, SupervisorEvent,
};

// Message framing
pub use framing::{
    AsyncFrameReader, AsyncFrameWriter, FrameReader, FrameWriter, FramingError, FramingMode,
    MAX_MESSAGE_SIZE,
};

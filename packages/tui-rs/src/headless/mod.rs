//! Headless protocol for communicating with the Node.js agent
//!
//! This module implements the client side of the headless protocol,
//! spawning the Node.js agent and communicating via JSON-over-stdio.
//!
//! ## Architecture
//!
//! The headless module provides several layers of abstraction:
//!
//! 1. **Messages** - Protocol message types (ToAgentMessage, FromAgentMessage)
//! 2. **Framing** - Reliable message framing (newline-delimited or length-prefixed)
//! 3. **Transport** - Low-level subprocess communication (sync and async)
//! 4. **Session** - Session persistence (JSONL recording and replay)
//! 5. **Supervisor** - High-level wrapper with reconnection and health monitoring
//!
//! ## Usage
//!
//! For simple use cases, use `AgentTransport` (sync) or `AsyncAgentTransport`:
//!
//! ```ignore
//! use tui_rs::headless::{AsyncAgentTransportBuilder, ToAgentMessage};
//!
//! let mut transport = AsyncAgentTransportBuilder::new()
//!     .cli_path("composer")
//!     .cwd("/path/to/project")
//!     .spawn()
//!     .await?;
//!
//! transport.prompt("Hello!")?;
//!
//! while let Ok(event) = transport.recv().await {
//!     match event {
//!         AgentEvent::ResponseChunk { content, .. } => print!("{}", content),
//!         AgentEvent::ResponseEnd { .. } => break,
//!         _ => {}
//!     }
//! }
//! ```
//!
//! For production use with reconnection and session recording, use `AgentSupervisor`:
//!
//! ```ignore
//! use tui_rs::headless::{SupervisorBuilder, SessionRecorder};
//!
//! let recorder = SessionRecorder::new("~/.composer/sessions")?;
//! let mut supervisor = SupervisorBuilder::new()
//!     .cli_path("composer")
//!     .session_recorder(recorder)
//!     .max_reconnect_attempts(5)
//!     .build();
//!
//! supervisor.connect().await?;
//! supervisor.prompt("Hello!")?;
//! ```

mod async_transport;
mod framing;
mod messages;
mod session;
mod supervisor;
mod transport;

// Core message types
pub use messages::{
    ActiveTool, AgentEvent, AgentState, FromAgentMessage, PendingApproval, StreamingResponse,
    ToAgentMessage, TokenUsage, ToolResult,
};

// Sync transport
pub use transport::{AgentTransport, AgentTransportBuilder, TransportConfig, TransportError};

// Async transport
pub use async_transport::{
    AsyncAgentTransport, AsyncAgentTransportBuilder, AsyncTransportConfig, AsyncTransportError,
};

// Session persistence
pub use session::{
    delete_session, list_sessions, SessionEntry, SessionMetadata, SessionReader, SessionRecorder,
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

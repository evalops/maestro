//! Agent communication module
//!
//! This module implements the native Rust agent used by the Composer TUI.
//! It exposes a lightweight handle for the UI layer and runs the actual
//! model/tool loop in a background task.
//!
//! # Architecture
//!
//! The agent follows an actor-style pattern:
//!
//! ```text
//! ┌─────────────┐        Commands         ┌──────────────────┐
//! │   TuiApp    │ ────────────────────────>│  NativeAgent     │
//! │             │                          │  (handle)        │
//! │             │<──────────────────────── │                  │
//! └─────────────┘        Events            └──────────────────┘
//!                                                   │
//!                                                   │ spawns
//!                                                   v
//!                                          ┌──────────────────┐
//!                                          │ NativeAgentRunner│
//!                                          │  (background)    │
//!                                          │                  │
//!                                          │ • Owns state     │
//!                                          │ • Runs AI loop   │
//!                                          │ • Executes tools │
//!                                          │ • Safety controls│
//!                                          └──────────────────┘
//! ```
//!
//! The [`NativeAgent`] type is a cheap, clonable handle held by the TUI.
//! The runner lives on a Tokio task and owns all mutable agent state.
//!
//! # Safety Controls
//!
//! The agent includes safety mechanisms to prevent runaway behavior:
//!
//! - **Doom loop detection**: Blocks repeated identical tool calls
//! - **Rate limiting**: Prevents excessive tool invocations per time window
//! - **Retryable error detection**: Identifies transient errors for auto-retry
//!
//! See the [`safety`] module for details.
//!
//! # Message types
//!
//! Communication is message-based and uses Tokio's unbounded MPSC channels:
//!
//! - [`ToAgent`]   - commands from TUI to agent (prompts, config changes, cancel).
//! - [`FromAgent`] - events from agent to TUI (streamed output, tool requests, status).
//!
//! Tool execution confirmation can optionally use a separate response channel
//! to avoid blocking the main UI event loop.
//!
//! All calls on [`NativeAgent`] are non-blocking from the TUI's perspective:
//! methods enqueue messages and return immediately; results arrive asynchronously
//! via the event channel as [`FromAgent`] values.
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::agent::{NativeAgent, NativeAgentConfig, FromAgent};
//!
//! # async fn example() -> anyhow::Result<()> {
//! // Create an agent and its event stream.
//! let config = NativeAgentConfig::default();
//! let (agent, mut events) = NativeAgent::new(config)?;
//!
//! // Optionally let the TUI know we're ready.
//! agent.send_ready()?;
//!
//! // Send a prompt (returns immediately).
//! agent.prompt("What is Rust?".to_string(), vec![])?;
//!
//! // Drive the event stream.
//! while let Some(event) = events.recv().await {
//!     match event {
//!         FromAgent::ResponseChunk { content, .. } => {
//!             print!("{content}");
//!         }
//!         FromAgent::ResponseEnd { .. } => {
//!             break;
//!         }
//!         _ => {}
//!     }
//! }
//! # Ok(())
//! # }
//! ```

pub mod compaction;
mod native;
mod protocol;
pub mod retry;
pub mod safety;

pub use compaction::{CompactionConfig, CompactionResult, ContextCompactor};
pub use native::{NativeAgent, NativeAgentConfig, ToolDefinition};
pub use protocol::{FromAgent, ToAgent, TokenUsage, ToolResult};
pub use retry::{ErrorKind, RetryConfig, RetryDecision, RetryPolicy};
pub use safety::{is_context_overflow, is_retryable_error, SafetyController, SafetyVerdict};

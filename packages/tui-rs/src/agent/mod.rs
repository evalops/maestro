//! Agent communication module
//!
//! This module implements a native Rust agent for AI model interaction, replacing
//! the previous Node.js subprocess architecture with a pure Rust implementation.
//!
//! # Architecture Overview
//!
//! The agent uses an actor-style pattern with background task execution:
//!
//! ```text
//! ┌─────────────┐        Commands         ┌──────────────────┐
//! │   TuiApp    │ ────────────────────────>│  NativeAgent     │
//! │             │                          │  (Handle)        │
//! │             │<──────────────────────── │                  │
//! └─────────────┘        Events            └──────────────────┘
//!                                                   │
//!                                                   │ Spawns
//!                                                   v
//!                                          ┌──────────────────┐
//!                                          │ Background Task  │
//!                                          │ (Runner)         │
//!                                          │                  │
//!                                          │ • Owns state     │
//!                                          │ • Runs AI loop   │
//!                                          │ • Executes tools │
//!                                          └──────────────────┘
//! ```
//!
//! # Key Components
//!
//! - [`NativeAgent`]: Lightweight handle held by the TUI application
//! - `NativeAgentRunner`: Background task that owns mutable state
//! - `FromAgent`: Events sent from agent to TUI (responses, tool calls, etc.)
//! - `ToAgent`: Commands sent from TUI to agent (prompts, cancellations, etc.)
//!
//! # Message Passing
//!
//! Communication uses Tokio's unbounded MPSC channels:
//!
//! - **Command channel**: TUI -> Agent (prompts, configuration changes)
//! - **Event channel**: Agent -> TUI (streaming responses, tool calls)
//! - **Tool response channel**: TUI -> Agent (user approval for tools)
//!
//! All operations are non-blocking on the TUI side - calling `prompt()` returns
//! immediately and results arrive asynchronously via the event channel.
//!
//! # Example Usage
//!
//! ```no_run
//! use tui_rs::agent::{NativeAgent, NativeAgentConfig, FromAgent};
//!
//! # async fn example() -> anyhow::Result<()> {
//! // Create agent with default config
//! let config = NativeAgentConfig::default();
//! let (agent, mut events) = NativeAgent::new(config)?;
//!
//! // Send initial ready event
//! agent.send_ready();
//!
//! // Send a prompt (non-blocking)
//! agent.prompt("What is Rust?".to_string(), vec![]).await?;
//!
//! // Process events from the agent
//! while let Some(event) = events.recv().await {
//!     match event {
//!         FromAgent::ResponseChunk { content, .. } => {
//!             print!("{}", content);
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

mod native;
mod protocol;

pub use native::{NativeAgent, NativeAgentConfig, ToolDefinition};
pub use protocol::*;

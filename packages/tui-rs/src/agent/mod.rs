//! Agent communication module
//!
//! This module implements the native Rust agent used by the Maestro TUI.
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
//! use maestro_tui::agent::{NativeAgent, NativeAgentConfig, FromAgent};
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
//!         FromAgent::ResponseEnd { .. } => { /* model-call boundary */ }
//!         FromAgent::TurnCompleted { .. } => {
//!             break;
//!         }
//!         FromAgent::TurnInterrupted { reason, .. } => return Err(reason.into()),
//!         FromAgent::ProviderError { message, .. } => return Err(message.into()),
//!         _ => {}
//!     }
//! }
//! # Ok(())
//! # }
//! ```

pub mod codex_app_server_turns;
pub mod compaction;
pub mod credential_store;
pub mod extensions;
#[cfg(test)]
pub mod harness;
pub mod message_queue;
mod native;
pub mod protocol;
pub mod reminders;
pub mod retry;
pub mod safety;
pub mod session_scope;
pub mod steer_signal;
pub mod text_loop;
pub mod token_counting;
pub mod token_estimation;
pub mod turn_budget;

pub use codex_app_server_turns::{
    CodexAppServerTurnResult, CodexAppServerTurnSession, DynamicToolSpec, TurnWaitEvent,
    approval_decision, codex_thread_model_id, dynamic_tools_from_native,
    model_should_use_app_server_turns, parse_tool_call_params, tool_call_error_result,
    tool_call_success_result,
};
pub use compaction::{CompactionConfig, CompactionResult, ContextCompactor, CutPoint};
pub use credential_store::{CredentialStats, CredentialStore, CredentialType, CredentialVault};
pub use extensions::{
    AgentExtension, BatchEndContext, DoomLoopExtension, ExtensionRegistry, ExtensionStats,
    ExtensionVerdict, ToolCallContext as ExtensionToolCallContext, ToolResultContext,
    ToolResultPayload, TurnEndContext, TurnStartContext,
};
pub use message_queue::{
    MAX_PENDING_MESSAGES, MessageQueue, PendingMessage, PromptKind, QueuePlacement, QueueStats,
};
pub(crate) use native::managed_turn_lineage_id;
pub use native::{
    MaxTokensSource, NativeAgent, NativeAgentConfig, ToolDefinition, ToolResponseConsumption,
    ToolResponseMessage,
};
pub use protocol::{
    DenialReason, ExecutionPhase, ExecutionReceipt, ExecutionSource, ExecutionStatus, FromAgent,
    ManagedInferenceAuthorization, ToAgent, TokenUsage, ToolError, ToolExecution, ToolOutcome,
    ToolOutput, ToolReceiptDetails, ToolResult, UNTRUSTED_CONTENT_POLICY,
    ensure_untrusted_content_policy,
};
pub use reminders::{REMINDER_CLOSE, REMINDER_OPEN, Reminder, ReminderContext, ReminderEngine};
pub use retry::{ErrorKind, RetryConfig, RetryDecision, RetryPolicy};
pub use safety::{
    SafetyConfig, SafetyController, SafetyVerdict, is_context_overflow, is_retryable_error,
    stable_stringify,
};
pub use session_scope::{ParentScopeId, SessionId, parent_scope_for_session};
pub use steer_signal::SteerSignal;
pub use text_loop::{LoopKind, TextLoopDetector, loop_reminder_message};
pub use turn_budget::{DEFAULT_MAX_TURN_STEPS, TurnOutcome, TurnStepBudget};

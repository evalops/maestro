//! Native Maestro actor, turn loop, and runtime contracts.
//!
//! The dependency-light contract implementation lives in
//! `maestro-runtime-contracts` so provider clients can use telemetry and
//! shared values without creating a cycle through the loop-owning runtime.
//! Hosts compose provider clients and execution adapters; this crate owns the
//! shared actor and turn algorithm and preserves the historical contract API.

#![forbid(unsafe_code)]

/// The transport-neutral native actor and its loop-facing contracts.
pub mod agent;

mod tool_responses;

/// Provider clients are composed by the host and passed into the runtime.
pub use maestro_ai as ai;
pub use maestro_codex::{codex_app_server, codex_session};

pub use maestro_coding_acceptance as coding_acceptance;
pub use maestro_runtime_contracts::*;

pub use tool_responses::{
    ToolResponseConsumption, ToolResponseCoordinator, ToolResponseData, ToolResponseMessage,
    ToolResponseWait,
};

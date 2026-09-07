//! Shared caller-owned tool-response coordination and runtime compatibility exports.
//!
//! The dependency-light contract implementation lives in
//! `maestro-runtime-contracts` so provider clients can use telemetry and
//! shared values without creating a cycle through the loop-owning runtime.
//! This crate preserves the historical `maestro_runtime` API while remaining
//! the future home of the native runtime loop. Tool-response coordination is
//! process-local; durable authority and canonical receipts remain host-owned.

#![forbid(unsafe_code)]

mod tool_responses;

pub use maestro_coding_acceptance as coding_acceptance;
pub use maestro_runtime_contracts::*;
pub use tool_responses::{
    ToolResponseConsumption, ToolResponseCoordinator, ToolResponseData, ToolResponseMessage,
    ToolResponseWait,
};

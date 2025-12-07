//! Agent communication module
//!
//! Provides the native Rust agent that communicates directly with AI providers.

mod native;
mod protocol;

pub use native::{NativeAgent, NativeAgentConfig, ToolDefinition};
pub use protocol::*;

//! Agent communication module
//!
//! Provides both:
//! - Node.js subprocess communication (legacy)
//! - Native Rust agent (new)

mod native;
mod process;
mod protocol;

pub use native::{NativeAgent, NativeAgentConfig, ToolDefinition};
pub use process::AgentProcess;
pub use protocol::*;

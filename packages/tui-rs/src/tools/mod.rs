//! Tool implementations
//!
//! Native Rust implementations of agent tools like bash, read, write, etc.

mod bash;
mod registry;

pub use bash::BashTool;
pub use registry::{ToolExecutor, ToolRegistry};

//! Agent communication module
//!
//! Handles IPC with the Node.js agent subprocess.

mod process;
mod protocol;

pub use process::AgentProcess;
pub use protocol::*;

//! Agent communication module
//!
//! Handles IPC with the Node.js agent subprocess.

mod protocol;
mod process;

pub use protocol::*;
pub use process::AgentProcess;

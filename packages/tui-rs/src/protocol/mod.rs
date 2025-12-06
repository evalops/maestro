//! IPC Protocol definitions for Composer TUI
//!
//! This module defines the JSON messages exchanged between the TypeScript
//! backend and the Rust TUI renderer.

mod messages;
mod render_tree;

pub use messages::*;
pub use render_tree::*;

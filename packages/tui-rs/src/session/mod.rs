//! Session management
//!
//! Handles session persistence, loading, and listing using JSONL format.

mod entries;
mod manager;
mod reader;
mod writer;

pub use entries::*;
pub use manager::{SessionInfo, SessionManager};
pub use reader::SessionReader;
pub use writer::SessionWriter;

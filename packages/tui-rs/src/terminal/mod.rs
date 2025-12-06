//! Terminal handling module
//!
//! Provides terminal initialization, cleanup, and event streaming.

mod events;
mod history;
mod setup;

pub use events::{TerminalEvent, TerminalEventStream};
pub use history::push_history_lines;
pub use setup::{check_tty, init, is_tty_available, restore, size, Terminal};

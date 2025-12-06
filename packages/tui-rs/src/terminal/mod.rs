//! Terminal handling module
//!
//! Provides terminal initialization, cleanup, and event streaming.

mod events;
mod setup;
mod history;

pub use events::{TerminalEvent, TerminalEventStream};
pub use setup::{
    check_tty, init, is_tty_available, restore, size, calculate_viewport,
    Terminal, TerminalCapabilities,
};
pub use history::push_history_lines;

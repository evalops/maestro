//! Terminal handling module
//!
//! This module provides comprehensive terminal management for the TUI application,
//! including initialization, cleanup, event streaming, and SSH-compatible scrollback.
//!
//! # Architecture Overview
//!
//! The terminal module is organized into specialized submodules:
//!
//! - `setup`: Terminal initialization and cleanup with raw mode configuration
//! - `events`: Async event stream for keyboard input, paste, and resize events
//! - `history`: Native scrollback integration using ANSI scroll regions
//!
//! # Platform Compatibility
//!
//! This module uses `/dev/tty` for terminal I/O instead of stdin/stdout, allowing
//! the application to reserve stdin/stdout for IPC communication with the TypeScript
//! backend. This approach works on Unix-like systems (Linux, macOS, BSD).
//!
//! # Inline Viewport Mode
//!
//! The terminal uses ratatui's inline viewport mode, which reserves a fixed number
//! of rows at the bottom of the terminal screen. Content above the viewport can
//! scroll into the terminal's native scrollback buffer, providing:
//!
//! - Persistence across SSH disconnects/reconnects
//! - Compatibility with tmux/screen scrollback
//! - Native Shift+PageUp/PageDown scrolling
//!
//! # Example Usage
//!
//! ```no_run
//! use composer_tui::terminal::{init, restore, TerminalEventStream};
//!
//! # async fn example() -> std::io::Result<()> {
//! // Initialize the terminal
//! let (mut terminal, capabilities) = init()?;
//!
//! // Create event stream
//! let mut events = TerminalEventStream::new();
//!
//! // Process events...
//! // while let Some(event) = events.next().await { ... }
//!
//! // Clean up on exit
//! restore()?;
//! # Ok(())
//! # }
//! ```

mod events;
mod history;
mod setup;

pub use events::{TerminalEvent, TerminalEventStream};
pub use history::push_history_lines;
pub use setup::{
    calculate_viewport, check_tty, init, is_tty_available, restore, size, Terminal,
    TerminalCapabilities,
};

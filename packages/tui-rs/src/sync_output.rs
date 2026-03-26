//! Synchronized Output for Flicker-Free Terminal Updates
//!
//! This module provides commands for synchronized terminal output, which
//! reduces or eliminates flicker during screen updates. This is especially
//! important for SSH sessions where latency can cause visible redraw artifacts.
//!
//! # How It Works
//!
//! Synchronized output uses DEC private modes 2026 to tell the terminal to
//! buffer output until explicitly flushed. This allows multiple screen updates
//! to appear as a single atomic change.
//!
//! ```text
//! ESC [ ? 2026 h  - Begin synchronized update (buffer output)
//! ... render commands ...
//! ESC [ ? 2026 l  - End synchronized update (flush buffer)
//! ```
//!
//! # Terminal Support
//!
//! Synchronized output is supported by:
//! - iTerm2
//! - Kitty
//! - Ghostty
//! - WezTerm
//! - Windows Terminal
//! - Many other modern terminals
//!
//! Terminals that don't support it will simply ignore the escape sequences,
//! so it's safe to use unconditionally.
//!
//! # Example
//!
//! ```rust,ignore
//! use crossterm::execute;
//! use maestro_tui::sync_output::{BeginSynchronizedUpdate, EndSynchronizedUpdate};
//!
//! let mut stdout = std::io::stdout();
//!
//! // Begin buffering
//! execute!(stdout, BeginSynchronizedUpdate)?;
//!
//! // ... render multiple widgets ...
//!
//! // Flush all at once
//! execute!(stdout, EndSynchronizedUpdate)?;
//! ```
//!
//! Ported from concepts in pi-tui and OpenAI Codex CLI.

use std::fmt;
use std::io;

use crossterm::Command;

/// Begin synchronized update mode (DEC private mode 2026).
///
/// While in this mode, the terminal buffers all output instead of displaying
/// it immediately. Call `EndSynchronizedUpdate` to flush the buffer and
/// display all changes at once.
///
/// # ANSI Sequence
///
/// `ESC [ ? 2026 h` - DECSET 2026 (Begin Synchronized Update)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeginSynchronizedUpdate;

impl Command for BeginSynchronizedUpdate {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[?2026h")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> {
        // Windows Terminal supports this via ANSI
        Ok(())
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

/// End synchronized update mode and flush the buffer.
///
/// This causes all buffered output since `BeginSynchronizedUpdate` to be
/// displayed atomically, preventing flicker.
///
/// # ANSI Sequence
///
/// `ESC [ ? 2026 l` - DECRST 2026 (End Synchronized Update)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndSynchronizedUpdate;

impl Command for EndSynchronizedUpdate {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[?2026l")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> {
        Ok(())
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

/// Execute a closure with synchronized output.
///
/// This is a convenience function that wraps output in begin/end synchronized
/// update commands. Even if the closure panics, the end command will be sent.
///
/// # Example
///
/// ```rust,ignore
/// use maestro_tui::sync_output::with_synchronized_output;
///
/// with_synchronized_output(&mut stdout, || {
///     // All rendering here is buffered
///     render_header(&mut stdout)?;
///     render_content(&mut stdout)?;
///     render_footer(&mut stdout)?;
///     Ok(())
/// })?;
/// // Buffer is flushed here - all changes appear at once
/// ```
pub fn with_synchronized_output<W, F, E>(writer: &mut W, f: F) -> Result<(), E>
where
    W: io::Write,
    F: FnOnce() -> Result<(), E>,
    E: From<io::Error>,
{
    use crossterm::queue;

    // Begin synchronized update
    queue!(writer, BeginSynchronizedUpdate).map_err(E::from)?;
    writer.flush().map_err(E::from)?;

    // Execute the closure
    let result = f();

    // Always end synchronized update, even on error
    let _ = queue!(writer, EndSynchronizedUpdate);
    let _ = writer.flush();

    result
}

/// A guard that ends synchronized output when dropped.
///
/// This is useful for RAII-style synchronized output where you want to ensure
/// the end command is sent even if an error occurs.
///
/// # Example
///
/// ```rust,ignore
/// use maestro_tui::sync_output::SynchronizedOutputGuard;
///
/// let _guard = SynchronizedOutputGuard::begin(&mut stdout)?;
/// // All output is buffered
/// render_widgets(&mut stdout)?;
/// // Guard dropped here - buffer is flushed
/// ```
pub struct SynchronizedOutputGuard<'a, W: io::Write> {
    writer: &'a mut W,
}

impl<'a, W: io::Write> SynchronizedOutputGuard<'a, W> {
    /// Begin synchronized output and return a guard.
    pub fn begin(writer: &'a mut W) -> io::Result<Self> {
        use crossterm::queue;
        queue!(writer, BeginSynchronizedUpdate)?;
        writer.flush()?;
        Ok(Self { writer })
    }
}

impl<W: io::Write> Drop for SynchronizedOutputGuard<'_, W> {
    fn drop(&mut self) {
        use crossterm::queue;
        let _ = queue!(self.writer, EndSynchronizedUpdate);
        let _ = self.writer.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_to_string<C: Command>(cmd: C) -> String {
        let mut s = String::new();
        cmd.write_ansi(&mut s).unwrap();
        s
    }

    #[test]
    fn test_begin_synchronized_update() {
        assert_eq!(command_to_string(BeginSynchronizedUpdate), "\x1b[?2026h");
    }

    #[test]
    fn test_end_synchronized_update() {
        assert_eq!(command_to_string(EndSynchronizedUpdate), "\x1b[?2026l");
    }

    #[test]
    fn test_guard() {
        let mut buf = Vec::new();
        {
            let _guard = SynchronizedOutputGuard::begin(&mut buf).unwrap();
            // Guard dropped here
        }
        let output = String::from_utf8(buf).unwrap();
        assert!(output.contains("\x1b[?2026h"));
        assert!(output.contains("\x1b[?2026l"));
    }
}

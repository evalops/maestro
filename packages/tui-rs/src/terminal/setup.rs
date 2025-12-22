//! Terminal setup and teardown
//!
//! This module handles low-level terminal initialization and cleanup, including
//! raw mode configuration, keyboard enhancement flags, and panic hook installation.
//!
//! # Platform-Specific Design
//!
//! We use `/dev/tty` for terminal I/O instead of stdin/stdout. This allows the
//! application to reserve stdin/stdout for IPC communication with the TypeScript
//! backend while maintaining full terminal control. This is a Unix-specific approach
//! that works on Linux, macOS, and BSD systems.
//!
//! # Raw Mode Configuration
//!
//! The terminal is configured with crossterm's raw mode, which provides:
//!
//! - No line buffering (characters available immediately)
//! - No echo (application controls output)
//! - No canonical mode processing
//! - Direct access to all keyboard events
//!
//! # Keyboard Enhancement
//!
//! On terminals that support it (detected via crossterm's `supports_keyboard_enhancement()`),
//! we enable enhanced keyboard protocol flags:
//!
//! - `DISAMBIGUATE_ESCAPE_CODES`: Distinguish Escape key from Alt+key sequences
//! - `REPORT_EVENT_TYPES`: Differentiate press, release, and repeat events
//! - `REPORT_ALTERNATE_KEYS`: Provide base layout keys alongside modified ones
//!
//! These enhancements improve the reliability of keyboard shortcuts, especially in
//! SSH sessions and modern terminals like iTerm2, WezTerm, and Kitty.
//!
//! # Inline Viewport Mode
//!
//! This terminal uses ratatui's inline viewport mode, which:
//!
//! - Reserves a fixed number of rows at the bottom of the terminal screen
//! - Allows content above the viewport to scroll into native terminal scrollback
//! - Maintains compatibility with SSH, tmux, and screen scrollback buffers
//! - Preserves the user's existing terminal content above the TUI
//!
//! The viewport height is calculated as `terminal_height - 2` to leave room for
//! context lines while maximizing usable space.
//!
//! # Panic Hook
//!
//! A custom panic hook is installed that ensures the terminal is properly restored
//! even if the application crashes. This prevents leaving the terminal in a broken
//! state (raw mode, hidden cursor, etc.) which would require manual reset.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::panic;
use std::sync::Mutex;

use crossterm::{
    cursor,
    event::{
        DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange,
        KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, supports_keyboard_enhancement},
};
use once_cell::sync::Lazy;
use ratatui::backend::CrosstermBackend;
use ratatui::{TerminalOptions, Viewport};

/// Global TTY file handle for terminal output.
///
/// This static mutex stores the `/dev/tty` file handle after initialization,
/// making it available for cleanup in the panic hook and restore functions.
///
/// We use `Lazy` from `once_cell` to ensure thread-safe lazy initialization,
/// and `Mutex` to provide interior mutability for the restore operation.
static TTY: Lazy<Mutex<Option<File>>> = Lazy::new(|| Mutex::new(None));

/// Type alias for our terminal backend.
///
/// Uses `CrosstermBackend<File>` instead of the typical `CrosstermBackend<Stdout>`
/// because we write to `/dev/tty` rather than stdout. This allows stdin/stdout
/// to be used for IPC communication with the TypeScript backend.
pub type Terminal = ratatui::Terminal<CrosstermBackend<File>>;

/// Terminal capabilities detected during initialization.
///
/// This struct captures feature detection results and viewport configuration,
/// allowing the application to adapt its behavior based on terminal capabilities.
///
/// # Fields
///
/// - `enhanced_keys`: Whether the terminal supports the enhanced keyboard protocol,
///   which provides better modifier key disambiguation and event type reporting.
///
/// - `viewport_top`: The 1-indexed row number where the inline viewport begins.
///   Used for ANSI scroll region operations (DECSTBM) to push content into scrollback.
///
/// - `viewport_height`: The number of rows allocated to the inline viewport.
///   Typically `terminal_height - 2` to maximize space while leaving context.
#[derive(Debug, Clone, Copy)]
pub struct TerminalCapabilities {
    /// Whether the terminal supports enhanced keyboard (modifier disambiguation)
    pub enhanced_keys: bool,
    /// The row where the viewport starts (1-indexed for ANSI)
    pub viewport_top: u16,
    /// Height of the viewport
    pub viewport_height: u16,
}

/// Check if `/dev/tty` is available.
///
/// Returns `true` if the application can open `/dev/tty` for read/write,
/// indicating that we're running in a terminal environment. Returns `false`
/// if running in a non-interactive context (e.g., piped input, systemd service).
///
/// This is a quick availability check that discards error details. For detailed
/// error reporting, use [`check_tty()`] instead.
pub fn is_tty_available() -> bool {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .is_ok()
}

/// Check if `/dev/tty` is available, returning detailed errors.
///
/// This function attempts to open `/dev/tty` for read/write access and returns
/// an `io::Result` that can be used to diagnose why TTY access failed.
///
/// # Errors
///
/// Returns an error if:
/// - `/dev/tty` doesn't exist (not a Unix system)
/// - No controlling terminal (running as a daemon, via SSH without TTY allocation)
/// - Permission denied (rare, but possible in restricted environments)
///
/// # Example
///
/// ```no_run
/// # use composer_tui::terminal::check_tty;
/// if let Err(e) = check_tty() {
///     eprintln!("Cannot access terminal: {}", e);
///     std::process::exit(1);
/// }
/// ```
pub fn check_tty() -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map(|_| ())
}

/// Initialize the terminal for TUI rendering.
///
/// This sets up:
/// - Raw mode (no line buffering, no echo)
/// - Inline viewport mode (content scrolls into native scrollback)
/// - Bracketed paste mode
/// - Keyboard enhancement flags (if supported)
/// - Focus change events
/// - Panic hook to restore terminal on crash
///
/// Uses /dev/tty for terminal I/O so that stdin/stdout can be used for IPC.
pub fn init() -> io::Result<(Terminal, TerminalCapabilities)> {
    // Open /dev/tty for terminal I/O
    // This allows us to use stdin/stdout for IPC with TypeScript
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("Cannot open /dev/tty: {}", e),
            )
        })?;

    // Get terminal size
    let (_width, height) = crossterm::terminal::size()?;

    // Reserve some rows for terminal scrollback history
    // Use most of the screen but leave a few lines at the top for context
    let viewport_height = height.saturating_sub(2).max(10);
    let viewport_top = height.saturating_sub(viewport_height) + 1; // 1-indexed for ANSI

    // Check capabilities before entering raw mode
    let enhanced_keys = supports_keyboard_enhancement().unwrap_or(false);

    // Enable raw mode
    enable_raw_mode()?;

    // Enable bracketed paste
    execute!(tty, EnableBracketedPaste)?;

    // Try to enable keyboard enhancement (may fail on some terminals)
    if enhanced_keys {
        let _ = execute!(
            tty,
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                    | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
            )
        );
    }

    // Enable focus change events
    let _ = execute!(tty, EnableFocusChange);

    // Move cursor to bottom of screen and print enough newlines to create
    // space for the inline viewport. This ensures the viewport starts at
    // the correct position for history push.
    write!(tty, "\x1b[{};1H", height)?; // Move to last row
    for _ in 0..viewport_height {
        writeln!(tty)?;
    }
    tty.flush()?;

    // Set up panic hook to restore terminal
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        // Attempt to restore terminal before printing panic
        let _ = restore_impl();
        original_hook(panic_info);
    }));

    // Store the TTY handle globally for restore
    // Use unwrap_or_else to recover from poisoned locks
    *TTY.lock().unwrap_or_else(|e| e.into_inner()) = Some(tty.try_clone()?);

    // Create the terminal with inline viewport mode
    let backend = CrosstermBackend::new(tty);
    let terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(viewport_height),
        },
    )?;

    let capabilities = TerminalCapabilities {
        enhanced_keys,
        viewport_top,
        viewport_height,
    };

    Ok((terminal, capabilities))
}

/// Initialize a fallback terminal for non-interactive contexts.
///
/// This avoids raw mode and `/dev/tty` usage, falling back to a null sink.
pub fn init_fallback() -> io::Result<(Terminal, TerminalCapabilities)> {
    let fallback_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fallback_path)?;
    let backend = CrosstermBackend::new(file);
    let terminal = ratatui::Terminal::new(backend)?;

    let (_width, height) = crossterm::terminal::size().unwrap_or((80, 24));
    let (viewport_top, viewport_height) = calculate_viewport(height);
    let capabilities = TerminalCapabilities {
        enhanced_keys: false,
        viewport_top,
        viewport_height,
    };

    Ok((terminal, capabilities))
}

/// Restore the terminal to its original state.
pub fn restore() -> io::Result<()> {
    restore_impl()
}

fn restore_impl() -> io::Result<()> {
    // Get the TTY handle - recover from poisoned lock to ensure terminal cleanup
    let mut guard = TTY.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref mut tty) = *guard {
        // Pop keyboard enhancement flags
        let _ = execute!(tty, PopKeyboardEnhancementFlags);

        // Disable bracketed paste
        let _ = execute!(tty, DisableBracketedPaste);

        // Disable focus change
        let _ = execute!(tty, DisableFocusChange);

        // Show cursor
        let _ = execute!(tty, cursor::Show);
    }

    // Disable raw mode
    disable_raw_mode()?;

    Ok(())
}

/// Get the current terminal size.
///
/// Returns a tuple of `(width, height)` in columns and rows. This uses crossterm's
/// `terminal::size()` which queries the terminal via ioctl on Unix systems.
///
/// # Errors
///
/// Returns an error if the terminal size cannot be determined (e.g., not running
/// in a terminal, or the terminal driver doesn't support size queries).
///
/// # Example
///
/// ```no_run
/// # use composer_tui::terminal::size;
/// let (width, height) = size()?;
/// println!("Terminal is {}x{} characters", width, height);
/// # Ok::<(), std::io::Error>(())
/// ```
pub fn size() -> io::Result<(u16, u16)> {
    crossterm::terminal::size()
}

/// Calculate viewport dimensions after a terminal resize.
///
/// This function computes the optimal viewport height and starting row based on
/// the new terminal height, maintaining the inline viewport layout strategy.
///
/// # Arguments
///
/// - `height`: The new terminal height in rows
///
/// # Returns
///
/// A tuple of `(viewport_top, viewport_height)` where:
/// - `viewport_top` is the 1-indexed row where the viewport starts
/// - `viewport_height` is the number of rows allocated to the viewport
///
/// The viewport height is calculated as `height - 2`, with a minimum of 10 rows
/// to ensure usability even in very small terminals.
pub fn calculate_viewport(height: u16) -> (u16, u16) {
    let viewport_height = height.saturating_sub(2).max(10);
    let viewport_top = height.saturating_sub(viewport_height) + 1;
    (viewport_top, viewport_height)
}

#[cfg(test)]
mod tests {
    // Note: Terminal tests are tricky because they require an actual TTY
    // These would typically be integration tests
}

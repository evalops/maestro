//! Terminal setup and teardown
//!
//! Handles raw mode, keyboard enhancement, panic hooks, etc.
//!
//! We use /dev/tty for terminal I/O so that stdin/stdout can be used
//! for IPC with the TypeScript backend.

use std::fs::{File, OpenOptions};
use std::io;
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

/// Global TTY file handle for terminal output
/// We use /dev/tty so that stdout can be used for IPC
static TTY: Lazy<Mutex<Option<File>>> = Lazy::new(|| Mutex::new(None));

/// Type alias for our terminal - uses /dev/tty instead of stdout
pub type Terminal = ratatui::Terminal<CrosstermBackend<File>>;

/// Terminal capabilities detected at init
#[derive(Debug, Clone, Copy)]
pub struct TerminalCapabilities {
    /// Whether the terminal supports enhanced keyboard (modifier disambiguation)
    pub enhanced_keys: bool,
}

/// Check if /dev/tty is available (we're running in a terminal)
pub fn is_tty_available() -> bool {
    OpenOptions::new().read(true).write(true).open("/dev/tty").is_ok()
}

/// Check if /dev/tty is available, with detailed error
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
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, format!("Cannot open /dev/tty: {}", e)))?;

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

    // Set up panic hook to restore terminal
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        // Attempt to restore terminal before printing panic
        let _ = restore_impl();
        original_hook(panic_info);
    }));

    // Store the TTY handle globally for restore
    *TTY.lock().unwrap() = Some(tty.try_clone()?);

    // Create the terminal with the TTY backend
    let backend = CrosstermBackend::new(tty);
    let terminal = Terminal::new(backend)?;

    let capabilities = TerminalCapabilities { enhanced_keys };

    Ok((terminal, capabilities))
}

/// Restore the terminal to its original state.
pub fn restore() -> io::Result<()> {
    restore_impl()
}

fn restore_impl() -> io::Result<()> {
    // Get the TTY handle
    let mut guard = TTY.lock().unwrap();

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

/// Get the current terminal size
pub fn size() -> io::Result<(u16, u16)> {
    crossterm::terminal::size()
}

#[cfg(test)]
mod tests {
    // Note: Terminal tests are tricky because they require an actual TTY
    // These would typically be integration tests
}

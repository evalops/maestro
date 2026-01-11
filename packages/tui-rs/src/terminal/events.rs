//! Terminal event stream
//!
//! This module provides async event streaming from the terminal using crossterm's
//! `EventStream`. It converts low-level crossterm events into application-specific
//! events, filtering out irrelevant events and normalizing key representations.
//!
//! # Event Filtering
//!
//! The event stream automatically filters:
//!
//! - Mouse events (not currently used by the application)
//! - Key release and repeat events (only key press events are processed)
//! - Lock key events (`CapsLock`, `NumLock`, `ScrollLock`)
//! - Media and modifier-only key events
//!
//! # Async Design
//!
//! This module uses Tokio streams (`tokio_stream::StreamExt`) to provide async event
//! polling. The event stream can be efficiently integrated with Tokio's async runtime,
//! allowing the application to handle events concurrently with other async tasks.
//!
//! # Key Event Normalization
//!
//! Crossterm's `KeyEvent` includes raw key codes and modifiers. This module converts
//! them to string representations (e.g., "Enter", "Backspace", "F1") that are easier
//! to work with in the application layer and can be serialized for IPC communication.

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind};
use tokio_stream::StreamExt;

use crate::protocol::KeyModifiers;

/// Events emitted by the terminal.
///
/// This enum represents the subset of crossterm events that the application
/// cares about. Events are normalized to be easier to handle and serialize.
///
/// # Variants
///
/// - `Key`: A key press event with normalized key string and modifiers
/// - `Paste`: Bracketed paste content (multi-line clipboard paste)
/// - `Resize`: Terminal window size changed
/// - `FocusGained`/`FocusLost`: Focus change events (if terminal supports them)
#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// Key press event.
    ///
    /// The `key` field contains a string representation of the key (e.g., "a", "Enter",
    /// "F1", "Up"). The `modifiers` field contains active modifier keys (Ctrl, Alt, Shift).
    Key {
        /// Key code as string representation
        key: String,
        /// Modifiers
        modifiers: KeyModifiers,
    },
    /// Paste event from bracketed paste mode.
    ///
    /// When the user pastes content (e.g., Ctrl+Shift+V in most terminals), the
    /// terminal sends the content as a paste event rather than individual key presses.
    /// This allows the application to distinguish typed text from pasted text.
    Paste(String),
    /// Terminal resized to new dimensions.
    ///
    /// Sent when the terminal window size changes (e.g., user resizes the window,
    /// or the terminal emulator's font size changes).
    Resize { width: u16, height: u16 },
    /// Terminal gained focus.
    ///
    /// Only sent if the terminal supports focus change events (enabled via crossterm's
    /// `EnableFocusChange` command).
    FocusGained,
    /// Terminal lost focus.
    ///
    /// Only sent if the terminal supports focus change events.
    FocusLost,
}

/// Async stream of terminal events.
///
/// This wraps crossterm's `EventStream` and provides a simplified async interface
/// for polling terminal events. Events are automatically filtered and converted
/// to `TerminalEvent` instances.
///
/// # Example
///
/// ```no_run
/// use composer_tui::terminal::TerminalEventStream;
///
/// # async fn example() {
/// let mut events = TerminalEventStream::new();
/// while let Some(event) = events.next().await {
///     match event {
///         composer_tui::terminal::TerminalEvent::Key { key, .. } => {
///             println!("Key pressed: {}", key);
///         }
///         _ => {}
///     }
/// }
/// # }
/// ```
pub struct TerminalEventStream {
    inner: EventStream,
}

impl TerminalEventStream {
    /// Create a new terminal event stream
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: EventStream::new(),
        }
    }

    /// Get the next terminal event
    pub async fn next(&mut self) -> Option<TerminalEvent> {
        loop {
            match self.inner.next().await {
                Some(Ok(event)) => {
                    if let Some(te) = convert_event(event) {
                        return Some(te);
                    }
                    // Event was filtered out, continue
                }
                Some(Err(_)) => continue,
                None => return None,
            }
        }
    }
}

impl Default for TerminalEventStream {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert crossterm event to our normalized event type.
///
/// This function maps crossterm's raw events to our simplified `TerminalEvent` enum,
/// filtering out events we don't care about (e.g., mouse events, key releases).
///
/// Returns `None` for filtered events, which causes the stream to skip them and
/// continue polling for the next event.
fn convert_event(event: Event) -> Option<TerminalEvent> {
    match event {
        Event::Key(key_event) => convert_key_event(key_event),
        Event::Paste(text) => Some(TerminalEvent::Paste(text)),
        Event::Resize(width, height) => Some(TerminalEvent::Resize { width, height }),
        Event::FocusGained => Some(TerminalEvent::FocusGained),
        Event::FocusLost => Some(TerminalEvent::FocusLost),
        Event::Mouse(_) => None, // Ignore mouse events for now
    }
}

/// Convert crossterm key event to our format.
///
/// Filters out key release and repeat events, keeping only key press events.
/// This is the most common behavior for TUI applications - we only care about
/// when a key is first pressed, not when it's released or auto-repeated.
///
/// Returns `None` for filtered events or keys we don't recognize.
fn convert_key_event(key: KeyEvent) -> Option<TerminalEvent> {
    // Only handle key press events, not release or repeat
    if key.kind != KeyEventKind::Press {
        return None;
    }

    let key_str = key_code_to_string(key.code)?;
    let modifiers = key.modifiers.into();

    Some(TerminalEvent::Key {
        key: key_str,
        modifiers,
    })
}

/// Convert crossterm key code to string representation.
///
/// This normalizes key codes to predictable string values that can be used for
/// key binding matching and IPC serialization. Character keys are converted to
/// their string form (e.g., 'a' -> "a"), while special keys use consistent names
/// (e.g., `KeyCode::Enter` -> "Enter", `KeyCode::F(1)` -> "F1").
///
/// Returns `None` for keys we don't want to handle (null, lock keys, media keys, etc.).
fn key_code_to_string(code: KeyCode) -> Option<String> {
    let s = match code {
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "Enter".to_string(),
        KeyCode::Backspace => "Backspace".to_string(),
        KeyCode::Delete => "Delete".to_string(),
        KeyCode::Tab => "Tab".to_string(),
        KeyCode::BackTab => "BackTab".to_string(),
        KeyCode::Esc => "Escape".to_string(),
        KeyCode::Up => "Up".to_string(),
        KeyCode::Down => "Down".to_string(),
        KeyCode::Left => "Left".to_string(),
        KeyCode::Right => "Right".to_string(),
        KeyCode::Home => "Home".to_string(),
        KeyCode::End => "End".to_string(),
        KeyCode::PageUp => "PageUp".to_string(),
        KeyCode::PageDown => "PageDown".to_string(),
        KeyCode::Insert => "Insert".to_string(),
        KeyCode::F(n) => format!("F{n}"),
        KeyCode::Null => return None,
        KeyCode::CapsLock => return None,
        KeyCode::ScrollLock => return None,
        KeyCode::NumLock => return None,
        KeyCode::PrintScreen => return None,
        KeyCode::Pause => return None,
        KeyCode::Menu => return None,
        KeyCode::KeypadBegin => return None,
        KeyCode::Media(_) => return None,
        KeyCode::Modifier(_) => return None,
    };
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_code_to_string() {
        assert_eq!(
            key_code_to_string(KeyCode::Char('a')),
            Some("a".to_string())
        );
        assert_eq!(
            key_code_to_string(KeyCode::Enter),
            Some("Enter".to_string())
        );
        assert_eq!(key_code_to_string(KeyCode::F(1)), Some("F1".to_string()));
        assert_eq!(key_code_to_string(KeyCode::Null), None);
    }
}

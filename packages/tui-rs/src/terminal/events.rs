//! Terminal event stream
//!
//! Provides async event streaming from the terminal using crossterm.

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind};
use tokio_stream::StreamExt;

use crate::protocol::KeyModifiers;

/// Events from the terminal
#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// Key press
    Key {
        /// Key code as string representation
        key: String,
        /// Modifiers
        modifiers: KeyModifiers,
    },
    /// Paste event
    Paste(String),
    /// Terminal resized
    Resize { width: u16, height: u16 },
    /// Terminal gained focus
    FocusGained,
    /// Terminal lost focus
    FocusLost,
}

/// Async stream of terminal events
pub struct TerminalEventStream {
    inner: EventStream,
}

impl TerminalEventStream {
    /// Create a new terminal event stream
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

/// Convert crossterm event to our event type
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

/// Convert key event to our format
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

/// Convert key code to string representation
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
        KeyCode::F(n) => format!("F{}", n),
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

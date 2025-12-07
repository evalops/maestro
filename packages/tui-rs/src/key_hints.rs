//! Platform-aware keyboard shortcut display
//!
//! Provides nice display of key bindings with platform-appropriate symbols.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

/// Platform-specific modifier symbols
#[cfg(target_os = "macos")]
const ALT_PREFIX: &str = "⌥";
#[cfg(not(target_os = "macos"))]
const ALT_PREFIX: &str = "Alt";

#[cfg(target_os = "macos")]
const CTRL_PREFIX: &str = "⌃";
#[cfg(not(target_os = "macos"))]
const CTRL_PREFIX: &str = "Ctrl";

#[cfg(target_os = "macos")]
const SHIFT_PREFIX: &str = "⇧";
#[cfg(not(target_os = "macos"))]
const SHIFT_PREFIX: &str = "Shift";

#[cfg(target_os = "macos")]
const CMD_PREFIX: &str = "⌘";
#[cfg(not(target_os = "macos"))]
const CMD_PREFIX: &str = "Super";

/// A keyboard binding
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyBinding {
    pub key: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyBinding {
    /// Create a new key binding
    pub const fn new(key: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { key, modifiers }
    }

    /// Check if this binding matches a key event
    pub fn matches(&self, event: &KeyEvent) -> bool {
        self.key == event.code
            && self.modifiers == event.modifiers
            && (event.kind == KeyEventKind::Press || event.kind == KeyEventKind::Repeat)
    }

    /// Get the display string for this binding
    pub fn display(&self) -> String {
        let mut parts = Vec::new();

        if self.modifiers.contains(KeyModifiers::CONTROL) {
            parts.push(CTRL_PREFIX);
        }
        if self.modifiers.contains(KeyModifiers::ALT) {
            parts.push(ALT_PREFIX);
        }
        if self.modifiers.contains(KeyModifiers::SHIFT) {
            parts.push(SHIFT_PREFIX);
        }
        if self.modifiers.contains(KeyModifiers::SUPER) {
            parts.push(CMD_PREFIX);
        }

        let key_str = key_to_string(self.key);
        parts.push(&key_str);

        #[cfg(target_os = "macos")]
        {
            // On macOS, use compact notation without separators
            parts.join("")
        }
        #[cfg(not(target_os = "macos"))]
        {
            // On other platforms, use + separator
            parts.join("+")
        }
    }
}

/// Convert a KeyCode to its display string
fn key_to_string(key: KeyCode) -> String {
    match key {
        KeyCode::Enter => "Enter".to_string(),
        KeyCode::Esc => "Esc".to_string(),
        KeyCode::Backspace => "Backspace".to_string(),
        KeyCode::Tab => "Tab".to_string(),
        KeyCode::Delete => "Del".to_string(),
        KeyCode::Insert => "Ins".to_string(),
        KeyCode::Home => "Home".to_string(),
        KeyCode::End => "End".to_string(),
        KeyCode::PageUp => "PgUp".to_string(),
        KeyCode::PageDown => "PgDn".to_string(),
        KeyCode::Up => "↑".to_string(),
        KeyCode::Down => "↓".to_string(),
        KeyCode::Left => "←".to_string(),
        KeyCode::Right => "→".to_string(),
        KeyCode::Char(' ') => "Space".to_string(),
        KeyCode::Char(c) => c.to_ascii_uppercase().to_string(),
        KeyCode::F(n) => format!("F{}", n),
        _ => "?".to_string(),
    }
}

// Convenience constructors
pub const fn plain(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::NONE)
}

pub const fn ctrl(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL)
}

pub const fn alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::ALT)
}

pub const fn shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::SHIFT)
}

pub const fn ctrl_shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::SHIFT))
}

pub const fn ctrl_alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::ALT))
}

impl From<KeyBinding> for Span<'static> {
    fn from(binding: KeyBinding) -> Self {
        Span::styled(
            binding.display(),
            Style::default().add_modifier(Modifier::DIM),
        )
    }
}

impl From<&KeyBinding> for Span<'static> {
    fn from(binding: &KeyBinding) -> Self {
        Span::styled(
            binding.display(),
            Style::default().add_modifier(Modifier::DIM),
        )
    }
}

/// A hint shown in the footer
#[derive(Clone, Debug)]
pub struct KeyHint {
    pub binding: KeyBinding,
    pub description: &'static str,
}

impl KeyHint {
    pub const fn new(binding: KeyBinding, description: &'static str) -> Self {
        Self {
            binding,
            description,
        }
    }

    /// Render as spans: [key] description
    pub fn to_spans(&self) -> Vec<Span<'static>> {
        vec![
            Span::styled(
                format!("[{}]", self.binding.display()),
                Style::default().add_modifier(Modifier::DIM),
            ),
            Span::raw(" "),
            Span::raw(self.description),
        ]
    }
}

// Common key bindings
pub mod bindings {
    use super::*;

    pub const QUIT: KeyBinding = ctrl(KeyCode::Char('c'));
    pub const ESCAPE: KeyBinding = plain(KeyCode::Esc);
    pub const ENTER: KeyBinding = plain(KeyCode::Enter);
    pub const UP: KeyBinding = plain(KeyCode::Up);
    pub const DOWN: KeyBinding = plain(KeyCode::Down);
    pub const PAGE_UP: KeyBinding = plain(KeyCode::PageUp);
    pub const PAGE_DOWN: KeyBinding = plain(KeyCode::PageDown);
    pub const HOME: KeyBinding = plain(KeyCode::Home);
    pub const END: KeyBinding = plain(KeyCode::End);
    pub const TAB: KeyBinding = plain(KeyCode::Tab);
    pub const HELP: KeyBinding = plain(KeyCode::F(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_binding_display() {
        let binding = ctrl(KeyCode::Char('c'));
        let display = binding.display();
        #[cfg(target_os = "macos")]
        assert_eq!(display, "⌃C");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(display, "Ctrl+C");
    }

    #[test]
    fn arrow_keys_display() {
        assert_eq!(key_to_string(KeyCode::Up), "↑");
        assert_eq!(key_to_string(KeyCode::Down), "↓");
        assert_eq!(key_to_string(KeyCode::Left), "←");
        assert_eq!(key_to_string(KeyCode::Right), "→");
    }
}

//! Key Binding Utilities
//!
//! Provides utilities for defining and displaying keyboard shortcuts:
//! - KeyBinding struct for matching key events
//! - Conversion to styled Span for display
//! - Platform-aware modifier display (⌥ on macOS, alt on other platforms)
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Span;

// Platform-specific alt key symbol
#[cfg(test)]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), target_os = "macos"))]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), not(target_os = "macos")))]
const ALT_PREFIX: &str = "alt + ";

const CTRL_PREFIX: &str = "ctrl + ";
const SHIFT_PREFIX: &str = "shift + ";

/// A keyboard shortcut binding.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct KeyBinding {
    /// The key code.
    pub key: KeyCode,
    /// Required modifiers.
    pub modifiers: KeyModifiers,
}

impl KeyBinding {
    /// Create a new key binding.
    pub const fn new(key: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { key, modifiers }
    }

    /// Check if a key event matches this binding.
    ///
    /// Matches on Press and Repeat events.
    pub fn is_press(&self, event: KeyEvent) -> bool {
        self.key == event.code
            && self.modifiers == event.modifiers
            && (event.kind == KeyEventKind::Press || event.kind == KeyEventKind::Repeat)
    }

    /// Check if a key event matches this binding (press only, no repeat).
    pub fn is_press_only(&self, event: KeyEvent) -> bool {
        self.key == event.code
            && self.modifiers == event.modifiers
            && event.kind == KeyEventKind::Press
    }
}

/// Create a binding for a plain key (no modifiers).
pub const fn plain(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::NONE)
}

/// Create a binding for Alt + key.
pub const fn alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::ALT)
}

/// Create a binding for Shift + key.
pub const fn shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::SHIFT)
}

/// Create a binding for Ctrl + key.
pub const fn ctrl(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL)
}

/// Create a binding for Ctrl + Alt + key.
pub const fn ctrl_alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::ALT))
}

/// Create a binding for Ctrl + Shift + key.
pub const fn ctrl_shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::SHIFT))
}

/// Convert modifiers to a display string.
fn modifiers_to_string(modifiers: KeyModifiers) -> String {
    let mut result = String::new();
    if modifiers.contains(KeyModifiers::CONTROL) {
        result.push_str(CTRL_PREFIX);
    }
    if modifiers.contains(KeyModifiers::SHIFT) {
        result.push_str(SHIFT_PREFIX);
    }
    if modifiers.contains(KeyModifiers::ALT) {
        result.push_str(ALT_PREFIX);
    }
    result
}

impl From<KeyBinding> for Span<'static> {
    fn from(binding: KeyBinding) -> Self {
        (&binding).into()
    }
}

impl From<&KeyBinding> for Span<'static> {
    fn from(binding: &KeyBinding) -> Self {
        let KeyBinding { key, modifiers } = binding;
        let modifiers = modifiers_to_string(*modifiers);
        let key = match key {
            KeyCode::Enter => "enter".to_string(),
            KeyCode::Char(' ') => "space".to_string(),
            KeyCode::Tab => "tab".to_string(),
            KeyCode::Backspace => "backspace".to_string(),
            KeyCode::Delete => "del".to_string(),
            KeyCode::Esc => "esc".to_string(),
            KeyCode::Up => "↑".to_string(),
            KeyCode::Down => "↓".to_string(),
            KeyCode::Left => "←".to_string(),
            KeyCode::Right => "→".to_string(),
            KeyCode::PageUp => "pgup".to_string(),
            KeyCode::PageDown => "pgdn".to_string(),
            KeyCode::Home => "home".to_string(),
            KeyCode::End => "end".to_string(),
            KeyCode::F(n) => format!("F{n}"),
            KeyCode::Char(c) => c.to_ascii_lowercase().to_string(),
            _ => format!("{key:?}").to_ascii_lowercase(),
        };
        Span::styled(format!("{modifiers}{key}"), key_hint_style())
    }
}

/// Default style for key hints (dimmed).
fn key_hint_style() -> Style {
    Style::default().dim()
}

/// Check if modifiers include Ctrl or Alt (but not AltGr on Windows).
pub fn has_ctrl_or_alt(mods: KeyModifiers) -> bool {
    (mods.contains(KeyModifiers::CONTROL) || mods.contains(KeyModifiers::ALT)) && !is_altgr(mods)
}

/// Check if modifiers represent AltGr (Windows-specific).
///
/// On Windows, AltGr is represented as Ctrl+Alt.
#[cfg(windows)]
#[inline]
pub fn is_altgr(mods: KeyModifiers) -> bool {
    mods.contains(KeyModifiers::ALT) && mods.contains(KeyModifiers::CONTROL)
}

#[cfg(not(windows))]
#[inline]
pub fn is_altgr(_mods: KeyModifiers) -> bool {
    false
}

/// Format a key binding for display in help text.
pub fn format_key_hint(binding: &KeyBinding) -> String {
    let span: Span = binding.into();
    span.content.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plain_binding() {
        let binding = plain(KeyCode::Enter);
        assert_eq!(binding.key, KeyCode::Enter);
        assert_eq!(binding.modifiers, KeyModifiers::NONE);
    }

    #[test]
    fn test_ctrl_binding() {
        let binding = ctrl(KeyCode::Char('c'));
        assert_eq!(binding.key, KeyCode::Char('c'));
        assert!(binding.modifiers.contains(KeyModifiers::CONTROL));
    }

    #[test]
    fn test_is_press() {
        let binding = ctrl(KeyCode::Char('c'));
        let event = KeyEvent::new_with_kind(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL,
            KeyEventKind::Press,
        );
        assert!(binding.is_press(event));
    }

    #[test]
    fn test_is_press_wrong_modifier() {
        let binding = ctrl(KeyCode::Char('c'));
        let event =
            KeyEvent::new_with_kind(KeyCode::Char('c'), KeyModifiers::ALT, KeyEventKind::Press);
        assert!(!binding.is_press(event));
    }

    #[test]
    fn test_span_conversion() {
        let binding = ctrl(KeyCode::Char('c'));
        let span: Span = binding.into();
        assert!(span.content.contains("ctrl"));
        assert!(span.content.contains("c"));
    }

    #[test]
    fn test_arrow_keys_display() {
        let up: Span = plain(KeyCode::Up).into();
        let down: Span = plain(KeyCode::Down).into();
        assert_eq!(up.content.as_ref(), "↑");
        assert_eq!(down.content.as_ref(), "↓");
    }

    #[test]
    fn test_format_key_hint() {
        let hint = format_key_hint(&ctrl(KeyCode::Char('s')));
        assert!(hint.contains("ctrl"));
        assert!(hint.contains("s"));
    }
}

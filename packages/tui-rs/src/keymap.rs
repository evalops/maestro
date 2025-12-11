//! Keymap and Chord Detection System
//!
//! Provides sophisticated keyboard shortcut handling with:
//! - Multi-key chord detection (Ctrl+K, Ctrl+C sequences)
//! - Timeout-based sequences (like vim's `jk` escape)
//! - Configurable keymaps per mode (insert, normal, etc.)
//! - Key sequence buffering with automatic timeout
//!
//! Inspired by Vim/Emacs keybinding systems.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// KEY SEQUENCE
// ─────────────────────────────────────────────────────────────────────────────

/// A normalized key representation for matching.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl Key {
    /// Create a new key.
    pub fn new(code: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { code, modifiers }
    }

    /// Create a key with no modifiers.
    pub fn plain(code: KeyCode) -> Self {
        Self::new(code, KeyModifiers::NONE)
    }

    /// Create a Ctrl+key combination.
    pub fn ctrl(c: char) -> Self {
        Self::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    /// Create an Alt+key combination.
    pub fn alt(c: char) -> Self {
        Self::new(KeyCode::Char(c), KeyModifiers::ALT)
    }

    /// Create a Ctrl+Shift+key combination.
    pub fn ctrl_shift(c: char) -> Self {
        Self::new(
            KeyCode::Char(c),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        )
    }

    /// Parse a key from string notation like "Ctrl+K" or "Alt+X".
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let parts: Vec<&str> = s.split('+').collect();

        let mut modifiers = KeyModifiers::NONE;
        let mut key_part = "";

        for (i, part) in parts.iter().enumerate() {
            let lower = part.to_lowercase();
            let is_last = i == parts.len() - 1;

            // Only treat as modifier if not the last part
            if !is_last {
                match lower.as_str() {
                    "ctrl" | "control" => {
                        modifiers |= KeyModifiers::CONTROL;
                        continue;
                    }
                    "alt" | "meta" => {
                        modifiers |= KeyModifiers::ALT;
                        continue;
                    }
                    "shift" => {
                        modifiers |= KeyModifiers::SHIFT;
                        continue;
                    }
                    _ => {}
                }
            }
            key_part = part;
        }

        let code = match key_part.to_lowercase().as_str() {
            "enter" | "return" => KeyCode::Enter,
            "esc" | "escape" => KeyCode::Esc,
            "tab" => KeyCode::Tab,
            "backspace" | "bs" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pageup" | "pgup" => KeyCode::PageUp,
            "pagedown" | "pgdn" => KeyCode::PageDown,
            "space" => KeyCode::Char(' '),
            s if s.len() == 1 => KeyCode::Char(s.chars().next().unwrap()),
            s if s.starts_with('f') => {
                let num: u8 = s[1..].parse().ok()?;
                KeyCode::F(num)
            }
            _ => return None,
        };

        Some(Self::new(code, modifiers))
    }
}

impl From<KeyEvent> for Key {
    fn from(event: KeyEvent) -> Self {
        Self::new(event.code, event.modifiers)
    }
}

/// A sequence of keys that form a chord.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KeySequence(pub Vec<Key>);

impl KeySequence {
    /// Create a new key sequence.
    pub fn new(keys: Vec<Key>) -> Self {
        Self(keys)
    }

    /// Create a single-key sequence.
    pub fn single(key: Key) -> Self {
        Self(vec![key])
    }

    /// Create from a string like "Ctrl+K Ctrl+C".
    pub fn parse(s: &str) -> Option<Self> {
        let keys: Option<Vec<Key>> = s.split_whitespace().map(Key::parse).collect();
        keys.map(Self)
    }

    /// Check if this sequence starts with another.
    pub fn starts_with(&self, prefix: &KeySequence) -> bool {
        if prefix.0.len() > self.0.len() {
            return false;
        }
        self.0.iter().zip(&prefix.0).all(|(a, b)| a == b)
    }

    /// Length of the sequence.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYMAP
// ─────────────────────────────────────────────────────────────────────────────

/// An action ID that can be triggered by a key binding.
pub type ActionId = &'static str;

/// A keymap binding entry.
#[derive(Debug, Clone)]
pub struct KeyBinding {
    /// The key sequence to trigger this binding.
    pub sequence: KeySequence,
    /// The action to trigger.
    pub action: ActionId,
    /// Description for help display.
    pub description: Option<String>,
    /// Modes where this binding is active (empty = all modes).
    pub modes: Vec<String>,
}

impl KeyBinding {
    /// Create a new binding.
    pub fn new(sequence: KeySequence, action: ActionId) -> Self {
        Self {
            sequence,
            action,
            description: None,
            modes: Vec::new(),
        }
    }

    /// Add a description.
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Restrict to specific modes.
    pub fn with_modes(mut self, modes: Vec<String>) -> Self {
        self.modes = modes;
        self
    }

    /// Check if this binding is active in a mode.
    pub fn active_in_mode(&self, mode: &str) -> bool {
        self.modes.is_empty() || self.modes.iter().any(|m| m == mode)
    }
}

/// A keymap that maps key sequences to actions.
#[derive(Debug, Clone, Default)]
pub struct Keymap {
    bindings: Vec<KeyBinding>,
}

impl Keymap {
    /// Create a new empty keymap.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a binding.
    pub fn bind(&mut self, binding: KeyBinding) {
        self.bindings.push(binding);
    }

    /// Add a simple single-key binding.
    pub fn bind_key(&mut self, key: Key, action: ActionId) {
        self.bindings.push(KeyBinding::new(KeySequence::single(key), action));
    }

    /// Add a chord binding from string.
    pub fn bind_chord(&mut self, chord: &str, action: ActionId) -> bool {
        if let Some(seq) = KeySequence::parse(chord) {
            self.bindings.push(KeyBinding::new(seq, action));
            true
        } else {
            false
        }
    }

    /// Find bindings that match a sequence in a mode.
    pub fn find_matches(&self, sequence: &KeySequence, mode: &str) -> Vec<&KeyBinding> {
        self.bindings
            .iter()
            .filter(|b| b.active_in_mode(mode) && b.sequence == *sequence)
            .collect()
    }

    /// Find bindings that could match with more keys (partial matches).
    pub fn find_partial_matches(&self, prefix: &KeySequence, mode: &str) -> Vec<&KeyBinding> {
        self.bindings
            .iter()
            .filter(|b| {
                b.active_in_mode(mode)
                    && b.sequence.starts_with(prefix)
                    && b.sequence.len() > prefix.len()
            })
            .collect()
    }

    /// Get all bindings for a mode (for help display).
    pub fn bindings_for_mode(&self, mode: &str) -> Vec<&KeyBinding> {
        self.bindings
            .iter()
            .filter(|b| b.active_in_mode(mode))
            .collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// KEY BUFFER
// ─────────────────────────────────────────────────────────────────────────────

/// Result of processing a key through the buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyResult {
    /// A complete binding was matched.
    Matched(ActionId),
    /// More keys needed to complete a potential chord.
    Pending,
    /// No binding matches, key should be handled normally.
    Unmatched(Key),
    /// Sequence timed out, return buffered keys as unmatched.
    Timeout(Vec<Key>),
}

/// Buffers keys for chord detection with timeout.
#[derive(Debug)]
pub struct KeyBuffer {
    /// Buffered keys waiting for chord completion.
    buffer: Vec<Key>,
    /// When the first key was pressed.
    first_key_time: Option<Instant>,
    /// Timeout for chord completion.
    timeout: Duration,
    /// Current mode.
    mode: String,
    /// The keymap to use.
    keymap: Keymap,
}

impl KeyBuffer {
    /// Default chord timeout (500ms).
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(500);

    /// Create a new key buffer with a keymap.
    pub fn new(keymap: Keymap) -> Self {
        Self {
            buffer: Vec::new(),
            first_key_time: None,
            timeout: Self::DEFAULT_TIMEOUT,
            mode: "default".to_string(),
            keymap,
        }
    }

    /// Set the chord timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Set the current mode.
    pub fn set_mode(&mut self, mode: impl Into<String>) {
        self.mode = mode.into();
    }

    /// Get the current mode.
    pub fn mode(&self) -> &str {
        &self.mode
    }

    /// Process a key event.
    pub fn process(&mut self, key: Key) -> KeyResult {
        let now = Instant::now();

        // Check for timeout on existing buffer
        if let Some(first_time) = self.first_key_time {
            if now.duration_since(first_time) > self.timeout && !self.buffer.is_empty() {
                let timed_out = std::mem::take(&mut self.buffer);
                self.first_key_time = None;
                // Re-process current key after clearing
                return self.process_after_timeout(key, timed_out);
            }
        }

        // Add key to buffer
        if self.buffer.is_empty() {
            self.first_key_time = Some(now);
        }
        self.buffer.push(key.clone());

        let sequence = KeySequence(self.buffer.clone());

        // Check for exact match
        let matches = self.keymap.find_matches(&sequence, &self.mode);
        if let Some(binding) = matches.first() {
            let action = binding.action; // Copy before clear
            self.clear();
            return KeyResult::Matched(action);
        }

        // Check for partial matches (more keys could complete a chord)
        let partial = self.keymap.find_partial_matches(&sequence, &self.mode);
        if !partial.is_empty() {
            return KeyResult::Pending;
        }

        // No matches - return the key as unmatched
        self.clear();
        KeyResult::Unmatched(key)
    }

    fn process_after_timeout(&mut self, current: Key, timed_out: Vec<Key>) -> KeyResult {
        // Start fresh with current key
        self.first_key_time = Some(Instant::now());
        self.buffer.push(current.clone());

        let sequence = KeySequence(self.buffer.clone());
        let matches = self.keymap.find_matches(&sequence, &self.mode);

        if let Some(binding) = matches.first() {
            let action = binding.action; // Copy before clear
            self.clear();
            KeyResult::Matched(action)
        } else if !self.keymap.find_partial_matches(&sequence, &self.mode).is_empty() {
            // Return timed out keys, keep current as pending
            KeyResult::Timeout(timed_out)
        } else {
            self.clear();
            KeyResult::Timeout(timed_out)
        }
    }

    /// Check if the buffer has timed out.
    pub fn check_timeout(&mut self) -> Option<Vec<Key>> {
        if let Some(first_time) = self.first_key_time {
            if Instant::now().duration_since(first_time) > self.timeout && !self.buffer.is_empty() {
                let timed_out = std::mem::take(&mut self.buffer);
                self.first_key_time = None;
                return Some(timed_out);
            }
        }
        None
    }

    /// Clear the buffer.
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.first_key_time = None;
    }

    /// Check if there are pending keys.
    pub fn is_pending(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// Get the current buffer contents.
    pub fn pending_keys(&self) -> &[Key] {
        &self.buffer
    }

    /// Get reference to the keymap.
    pub fn keymap(&self) -> &Keymap {
        &self.keymap
    }

    /// Get mutable reference to the keymap.
    pub fn keymap_mut(&mut self) -> &mut Keymap {
        &mut self.keymap
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMON KEYMAPS
// ─────────────────────────────────────────────────────────────────────────────

/// Create a default editor keymap.
pub fn default_editor_keymap() -> Keymap {
    let mut km = Keymap::new();

    // Navigation
    km.bind_key(Key::plain(KeyCode::Up), "move_up");
    km.bind_key(Key::plain(KeyCode::Down), "move_down");
    km.bind_key(Key::plain(KeyCode::Left), "move_left");
    km.bind_key(Key::plain(KeyCode::Right), "move_right");
    km.bind_key(Key::plain(KeyCode::Home), "move_start");
    km.bind_key(Key::plain(KeyCode::End), "move_end");
    km.bind_key(Key::ctrl('a'), "move_start");
    km.bind_key(Key::ctrl('e'), "move_end");

    // Editing
    km.bind_key(Key::ctrl('k'), "kill_line");
    km.bind_key(Key::ctrl('u'), "kill_to_start");
    km.bind_key(Key::ctrl('y'), "yank");
    km.bind_key(Key::ctrl('w'), "kill_word");
    km.bind_key(Key::ctrl('d'), "delete_char");

    // Undo/redo
    km.bind_key(Key::ctrl('z'), "undo");
    km.bind_key(Key::ctrl_shift('z'), "redo");

    // Clipboard
    km.bind_key(Key::ctrl('c'), "copy");
    km.bind_key(Key::ctrl('v'), "paste");
    km.bind_key(Key::ctrl('x'), "cut");

    // Submit/cancel
    km.bind_key(Key::plain(KeyCode::Enter), "submit");
    km.bind_key(Key::plain(KeyCode::Esc), "cancel");

    km
}

/// Create a vim-style keymap for normal mode.
pub fn vim_normal_keymap() -> Keymap {
    let mut km = Keymap::new();

    // Movement
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('h'))), "move_left")
        .with_modes(vec!["normal".to_string()]));
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('j'))), "move_down")
        .with_modes(vec!["normal".to_string()]));
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('k'))), "move_up")
        .with_modes(vec!["normal".to_string()]));
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('l'))), "move_right")
        .with_modes(vec!["normal".to_string()]));

    // Mode switching
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('i'))), "enter_insert")
        .with_modes(vec!["normal".to_string()]));
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Esc)), "enter_normal")
        .with_modes(vec!["insert".to_string()]));

    // Vim escape sequence (jk)
    km.bind(KeyBinding::new(
        KeySequence::new(vec![
            Key::plain(KeyCode::Char('j')),
            Key::plain(KeyCode::Char('k')),
        ]),
        "enter_normal",
    ).with_modes(vec!["insert".to_string()]));

    // Commands
    km.bind(KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char(':'))), "command_mode")
        .with_modes(vec!["normal".to_string()]));

    // Delete
    km.bind(KeyBinding::new(
        KeySequence::new(vec![
            Key::plain(KeyCode::Char('d')),
            Key::plain(KeyCode::Char('d')),
        ]),
        "delete_line",
    ).with_modes(vec!["normal".to_string()]));

    // Yank
    km.bind(KeyBinding::new(
        KeySequence::new(vec![
            Key::plain(KeyCode::Char('y')),
            Key::plain(KeyCode::Char('y')),
        ]),
        "yank_line",
    ).with_modes(vec!["normal".to_string()]));

    km
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_parse_simple() {
        let key = Key::parse("a").unwrap();
        assert_eq!(key.code, KeyCode::Char('a'));
        assert_eq!(key.modifiers, KeyModifiers::NONE);
    }

    #[test]
    fn key_parse_ctrl() {
        let key = Key::parse("Ctrl+K").unwrap();
        assert_eq!(key.code, KeyCode::Char('k'));
        assert!(key.modifiers.contains(KeyModifiers::CONTROL));
    }

    #[test]
    fn key_parse_special() {
        assert_eq!(Key::parse("Enter").unwrap().code, KeyCode::Enter);
        assert_eq!(Key::parse("Esc").unwrap().code, KeyCode::Esc);
        assert_eq!(Key::parse("Tab").unwrap().code, KeyCode::Tab);
    }

    #[test]
    fn sequence_parse() {
        let seq = KeySequence::parse("Ctrl+K Ctrl+C").unwrap();
        assert_eq!(seq.len(), 2);
        assert!(seq.0[0].modifiers.contains(KeyModifiers::CONTROL));
        assert!(seq.0[1].modifiers.contains(KeyModifiers::CONTROL));
    }

    #[test]
    fn keymap_single_key_match() {
        let mut km = Keymap::new();
        km.bind_key(Key::ctrl('c'), "copy");

        let matches = km.find_matches(&KeySequence::single(Key::ctrl('c')), "default");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].action, "copy");
    }

    #[test]
    fn keymap_chord_match() {
        let mut km = Keymap::new();
        km.bind_chord("Ctrl+K Ctrl+C", "comment");

        let seq = KeySequence::parse("Ctrl+K Ctrl+C").unwrap();
        let matches = km.find_matches(&seq, "default");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].action, "comment");
    }

    #[test]
    fn keymap_partial_match() {
        let mut km = Keymap::new();
        km.bind_chord("Ctrl+K Ctrl+C", "comment");

        let prefix = KeySequence::single(Key::ctrl('k'));
        let partial = km.find_partial_matches(&prefix, "default");
        assert_eq!(partial.len(), 1);
    }

    #[test]
    fn keybuffer_single_match() {
        let mut km = Keymap::new();
        km.bind_key(Key::ctrl('c'), "copy");

        let mut buffer = KeyBuffer::new(km);
        let result = buffer.process(Key::ctrl('c'));
        assert_eq!(result, KeyResult::Matched("copy"));
    }

    #[test]
    fn keybuffer_chord_pending() {
        let mut km = Keymap::new();
        km.bind_chord("Ctrl+K Ctrl+C", "comment");

        let mut buffer = KeyBuffer::new(km);

        // First key should be pending
        let result = buffer.process(Key::ctrl('k'));
        assert_eq!(result, KeyResult::Pending);

        // Second key should complete
        let result = buffer.process(Key::ctrl('c'));
        assert_eq!(result, KeyResult::Matched("comment"));
    }

    #[test]
    fn keybuffer_unmatched() {
        let km = Keymap::new();
        let mut buffer = KeyBuffer::new(km);

        let result = buffer.process(Key::plain(KeyCode::Char('x')));
        assert!(matches!(result, KeyResult::Unmatched(_)));
    }

    #[test]
    fn mode_filtering() {
        let mut km = Keymap::new();
        km.bind(
            KeyBinding::new(KeySequence::single(Key::plain(KeyCode::Char('i'))), "insert")
                .with_modes(vec!["normal".to_string()]),
        );

        // Should match in normal mode
        let matches = km.find_matches(
            &KeySequence::single(Key::plain(KeyCode::Char('i'))),
            "normal",
        );
        assert_eq!(matches.len(), 1);

        // Should not match in insert mode
        let matches = km.find_matches(
            &KeySequence::single(Key::plain(KeyCode::Char('i'))),
            "insert",
        );
        assert_eq!(matches.len(), 0);
    }
}

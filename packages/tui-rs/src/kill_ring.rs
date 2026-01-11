//! Kill Ring - Emacs-style Text Buffer
//!
//! Provides a kill ring for storing deleted text that can be yanked back.
//! Supports multiple entries with rotation (like Emacs M-y).
//!
//! Ported from OpenAI Codex CLI patterns (MIT licensed).

use std::collections::VecDeque;

// ─────────────────────────────────────────────────────────────────────────────
// KILL RING
// ─────────────────────────────────────────────────────────────────────────────

/// Default maximum entries in the kill ring.
pub const DEFAULT_KILL_RING_SIZE: usize = 60;

/// A kill ring that stores deleted text for later yanking.
///
/// Similar to Emacs kill ring:
/// - Ctrl+K kills to end of line
/// - Ctrl+U kills to start of line
/// - Ctrl+W kills word backward
/// - Ctrl+Y yanks (pastes) last killed text
/// - M-y rotates through kill ring (after yank)
#[derive(Debug, Clone)]
pub struct KillRing {
    /// Ring buffer of killed text entries.
    entries: VecDeque<String>,
    /// Maximum number of entries to keep.
    max_size: usize,
    /// Current position for rotation (0 = most recent).
    position: usize,
    /// Whether we're in yank rotation mode.
    in_rotation: bool,
    /// Last yank position and length for replacement.
    last_yank: Option<YankInfo>,
}

/// Information about the last yank operation.
#[derive(Debug, Clone, Copy)]
pub struct YankInfo {
    /// Start position where text was yanked.
    pub start: usize,
    /// Length of yanked text.
    pub length: usize,
}

impl Default for KillRing {
    fn default() -> Self {
        Self::new()
    }
}

impl KillRing {
    /// Create a new kill ring with default size.
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_KILL_RING_SIZE)
    }

    /// Create a kill ring with specified capacity.
    #[must_use]
    pub fn with_capacity(max_size: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(max_size.min(100)),
            max_size: max_size.max(1),
            position: 0,
            in_rotation: false,
            last_yank: None,
        }
    }

    /// Kill (store) text in the ring.
    ///
    /// Adds to front of ring, removing oldest if at capacity.
    pub fn kill(&mut self, text: impl Into<String>) {
        let text = text.into();
        if text.is_empty() {
            return;
        }

        // Reset rotation state
        self.position = 0;
        self.in_rotation = false;
        self.last_yank = None;

        // Add to front
        self.entries.push_front(text);

        // Trim if over capacity
        while self.entries.len() > self.max_size {
            self.entries.pop_back();
        }
    }

    /// Kill and append to most recent entry (for consecutive kills).
    ///
    /// Used when killing multiple times in succession (e.g., repeated Ctrl+K).
    pub fn kill_append(&mut self, text: impl Into<String>, prepend: bool) {
        let text = text.into();
        if text.is_empty() {
            return;
        }

        self.position = 0;
        self.in_rotation = false;
        self.last_yank = None;

        if let Some(front) = self.entries.front_mut() {
            if prepend {
                front.insert_str(0, &text);
            } else {
                front.push_str(&text);
            }
        } else {
            self.entries.push_front(text);
        }
    }

    /// Yank (retrieve) the current entry.
    ///
    /// Returns None if ring is empty.
    pub fn yank(&mut self) -> Option<&str> {
        if self.entries.is_empty() {
            return None;
        }

        self.in_rotation = true;
        self.entries
            .get(self.position)
            .map(std::string::String::as_str)
    }

    /// Yank and record position for later replacement.
    ///
    /// Use this when inserting into a text buffer to enable yank-pop.
    /// Returns the yanked text (cloned) and yank info.
    pub fn yank_with_info(&mut self, insert_pos: usize) -> Option<(String, YankInfo)> {
        if self.entries.is_empty() {
            return None;
        }

        self.in_rotation = true;
        let text = self.entries.get(self.position)?.clone();
        let info = YankInfo {
            start: insert_pos,
            length: text.len(),
        };
        self.last_yank = Some(info);
        Some((text, info))
    }

    /// Rotate to next entry (yank-pop, like Emacs M-y).
    ///
    /// Only works after a yank. Returns the new text to replace the previous yank.
    pub fn yank_pop(&mut self) -> Option<&str> {
        if !self.in_rotation || self.entries.is_empty() {
            return None;
        }

        self.position = (self.position + 1) % self.entries.len();
        let text = self.entries.get(self.position)?;

        // Update last_yank length for the new text
        if let Some(ref mut info) = self.last_yank {
            info.length = text.len();
        }

        Some(text.as_str())
    }

    /// Get the last yank info for replacement.
    #[must_use]
    pub fn last_yank_info(&self) -> Option<YankInfo> {
        self.last_yank
    }

    /// Reset rotation state (call when cursor moves or text is edited).
    pub fn reset_rotation(&mut self) {
        self.position = 0;
        self.in_rotation = false;
        self.last_yank = None;
    }

    /// Check if currently in rotation mode.
    #[must_use]
    pub fn is_rotating(&self) -> bool {
        self.in_rotation
    }

    /// Get number of entries in the ring.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if ring is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.position = 0;
        self.in_rotation = false;
        self.last_yank = None;
    }

    /// Get the most recent killed text without changing state.
    #[must_use]
    pub fn peek(&self) -> Option<&str> {
        self.entries.front().map(std::string::String::as_str)
    }

    /// Get entry at index (0 = most recent).
    #[must_use]
    pub fn get(&self, index: usize) -> Option<&str> {
        self.entries.get(index).map(std::string::String::as_str)
    }

    /// Iterate over all entries (most recent first).
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(std::string::String::as_str)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORD BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

/// Characters that separate words (Readline-style).
pub const WORD_SEPARATORS: &str = " \t\n\r.,;:!?\"'`()[]{}|/<>@#$%^&*-+=~\\";

/// Check if a character is a word separator.
#[must_use]
pub fn is_word_separator(c: char) -> bool {
    WORD_SEPARATORS.contains(c)
}

/// Find the start of the previous word from a position.
///
/// Returns the byte offset of the word start.
#[must_use]
pub fn previous_word_start(text: &str, pos: usize) -> usize {
    if pos == 0 {
        return 0;
    }

    let mut i = pos;

    // Skip any separators before cursor
    while i > 0 {
        let prev = find_prev_char_boundary(text, i);
        let c = text[prev..i].chars().next().unwrap_or(' ');
        if !is_word_separator(c) {
            break;
        }
        i = prev;
    }

    // Find start of word
    while i > 0 {
        let prev = find_prev_char_boundary(text, i);
        let c = text[prev..i].chars().next().unwrap_or(' ');
        if is_word_separator(c) {
            break;
        }
        i = prev;
    }

    i
}

/// Find the end of the next word from a position.
///
/// Returns the byte offset past the word end.
#[must_use]
pub fn next_word_end(text: &str, pos: usize) -> usize {
    let len = text.len();
    if pos >= len {
        return len;
    }

    let mut i = pos;

    // Skip any separators at cursor
    while i < len {
        let c = text[i..].chars().next().unwrap_or(' ');
        if !is_word_separator(c) {
            break;
        }
        i += c.len_utf8();
    }

    // Find end of word
    while i < len {
        let c = text[i..].chars().next().unwrap_or(' ');
        if is_word_separator(c) {
            break;
        }
        i += c.len_utf8();
    }

    i
}

/// Find the start of the current word (for word selection).
#[must_use]
pub fn current_word_start(text: &str, pos: usize) -> usize {
    if pos == 0 {
        return 0;
    }

    let mut i = pos;

    // If on a separator, find the previous word
    if i < text.len() {
        let c = text[i..].chars().next().unwrap_or(' ');
        if is_word_separator(c) {
            return previous_word_start(text, i);
        }
    }

    // Find start of current word
    while i > 0 {
        let prev = find_prev_char_boundary(text, i);
        let c = text[prev..i].chars().next().unwrap_or(' ');
        if is_word_separator(c) {
            break;
        }
        i = prev;
    }

    i
}

/// Find the end of the current word (for word selection).
#[must_use]
pub fn current_word_end(text: &str, pos: usize) -> usize {
    let len = text.len();
    if pos >= len {
        return len;
    }

    let mut i = pos;

    // If on a separator, find the next word
    let c = text[i..].chars().next().unwrap_or(' ');
    if is_word_separator(c) {
        return next_word_end(text, i);
    }

    // Find end of current word
    while i < len {
        let c = text[i..].chars().next().unwrap_or(' ');
        if is_word_separator(c) {
            break;
        }
        i += c.len_utf8();
    }

    i
}

/// Find previous character boundary (for UTF-8 safety).
fn find_prev_char_boundary(s: &str, pos: usize) -> usize {
    let mut i = pos.saturating_sub(1);
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT EDITING OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/// Result of a kill operation.
#[derive(Debug, Clone)]
pub struct KillResult {
    /// The killed text.
    pub killed: String,
    /// New cursor position.
    pub new_cursor: usize,
}

/// Kill from cursor to end of line.
#[must_use]
pub fn kill_to_end(text: &str, cursor: usize) -> Option<KillResult> {
    if cursor >= text.len() {
        return None;
    }

    // Find end of current line
    let end = text[cursor..].find('\n').map_or(text.len(), |i| cursor + i);

    if end == cursor {
        // At end of line, kill the newline
        if cursor < text.len() && text.as_bytes()[cursor] == b'\n' {
            return Some(KillResult {
                killed: "\n".to_string(),
                new_cursor: cursor,
            });
        }
        return None;
    }

    Some(KillResult {
        killed: text[cursor..end].to_string(),
        new_cursor: cursor,
    })
}

/// Kill from start of line to cursor.
#[must_use]
pub fn kill_to_start(text: &str, cursor: usize) -> Option<KillResult> {
    if cursor == 0 {
        return None;
    }

    // Find start of current line
    let start = text[..cursor].rfind('\n').map_or(0, |i| i + 1);

    if start == cursor {
        return None;
    }

    Some(KillResult {
        killed: text[start..cursor].to_string(),
        new_cursor: start,
    })
}

/// Kill word backward (like Alt+Backspace).
#[must_use]
pub fn kill_word_backward(text: &str, cursor: usize) -> Option<KillResult> {
    if cursor == 0 {
        return None;
    }

    let start = previous_word_start(text, cursor);
    if start == cursor {
        return None;
    }

    Some(KillResult {
        killed: text[start..cursor].to_string(),
        new_cursor: start,
    })
}

/// Kill word forward (like Alt+Delete).
#[must_use]
pub fn kill_word_forward(text: &str, cursor: usize) -> Option<KillResult> {
    if cursor >= text.len() {
        return None;
    }

    let end = next_word_end(text, cursor);
    if end == cursor {
        return None;
    }

    Some(KillResult {
        killed: text[cursor..end].to_string(),
        new_cursor: cursor,
    })
}

/// Transpose characters at cursor (Ctrl+T).
///
/// Swaps character before cursor with character at cursor.
#[must_use]
pub fn transpose_chars(text: &str, cursor: usize) -> Option<(String, usize)> {
    if cursor == 0 || cursor >= text.len() {
        // At end of text, transpose last two chars
        if cursor == text.len() && text.len() >= 2 {
            let mut chars: Vec<char> = text.chars().collect();
            let len = chars.len();
            chars.swap(len - 2, len - 1);
            return Some((chars.into_iter().collect(), text.len()));
        }
        return None;
    }

    // Find the two characters to swap
    let prev_start = find_prev_char_boundary(text, cursor);
    let prev_char = text[prev_start..cursor].chars().next()?;
    let curr_char = text[cursor..].chars().next()?;

    // Build new string
    let mut result = String::with_capacity(text.len());
    result.push_str(&text[..prev_start]);
    result.push(curr_char);
    result.push(prev_char);
    result.push_str(&text[cursor + curr_char.len_utf8()..]);

    // New cursor is after both characters
    let new_cursor = prev_start + curr_char.len_utf8() + prev_char.len_utf8();

    Some((result, new_cursor))
}

/// Transpose words at cursor (Alt+T).
#[must_use]
pub fn transpose_words(text: &str, cursor: usize) -> Option<(String, usize)> {
    // Find current/previous word boundaries
    let word1_end = current_word_end(text, cursor);
    let word1_start = current_word_start(text, cursor);

    // If we're on whitespace, use previous word as word1
    let (w1_start, w1_end) = if word1_start == word1_end {
        let end = previous_word_start(text, cursor);
        let start = current_word_start(text, end);
        if start == end {
            return None;
        }
        (start, cursor) // Include whitespace
    } else {
        (word1_start, word1_end)
    };

    // Find next word
    let w2_start = next_word_end(text, w1_end);
    let w2_start = if w2_start == w1_end {
        return None; // No next word
    } else {
        // Skip whitespace to find actual word start
        let mut i = w1_end;
        while i < text.len() && is_word_separator(text[i..].chars().next().unwrap_or(' ')) {
            i += text[i..].chars().next().unwrap_or(' ').len_utf8();
        }
        i
    };

    let w2_end = current_word_end(text, w2_start);
    if w2_start == w2_end {
        return None;
    }

    let word1 = &text[w1_start..w1_end];
    let between = &text[w1_end..w2_start];
    let word2 = &text[w2_start..w2_end];

    let mut result = String::with_capacity(text.len());
    result.push_str(&text[..w1_start]);
    result.push_str(word2);
    result.push_str(between);
    result.push_str(word1);
    result.push_str(&text[w2_end..]);

    Some((result, w2_end))
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_ring_basic() {
        let mut ring = KillRing::new();
        assert!(ring.is_empty());

        ring.kill("hello");
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.peek(), Some("hello"));

        ring.kill("world");
        assert_eq!(ring.len(), 2);
        assert_eq!(ring.peek(), Some("world"));
    }

    #[test]
    fn kill_ring_yank() {
        let mut ring = KillRing::new();
        ring.kill("first");
        ring.kill("second");
        ring.kill("third");

        // Most recent is at position 0
        assert_eq!(ring.yank(), Some("third"));
        // Rotate goes to position 1 (second most recent)
        assert_eq!(ring.yank_pop(), Some("second"));
        // Then position 2
        assert_eq!(ring.yank_pop(), Some("first"));
        // Wraps back to position 0
        assert_eq!(ring.yank_pop(), Some("third"));
    }

    #[test]
    fn kill_ring_append() {
        let mut ring = KillRing::new();
        ring.kill("hello");
        ring.kill_append(" world", false);
        assert_eq!(ring.peek(), Some("hello world"));

        ring.kill("test");
        ring.kill_append("pre-", true);
        assert_eq!(ring.peek(), Some("pre-test"));
    }

    #[test]
    fn kill_ring_capacity() {
        let mut ring = KillRing::with_capacity(3);
        ring.kill("a");
        ring.kill("b");
        ring.kill("c");
        ring.kill("d");

        assert_eq!(ring.len(), 3);
        assert_eq!(ring.get(0), Some("d"));
        assert_eq!(ring.get(1), Some("c"));
        assert_eq!(ring.get(2), Some("b"));
        assert_eq!(ring.get(3), None); // "a" was evicted
    }

    #[test]
    fn word_boundaries() {
        let text = "hello world test";

        assert_eq!(previous_word_start(text, 11), 6); // "world" -> "hello "
        assert_eq!(next_word_end(text, 0), 5); // -> end of "hello"
        assert_eq!(next_word_end(text, 5), 11); // skip space, end of "world"
    }

    #[test]
    fn word_boundaries_unicode() {
        let text = "héllo wörld";

        assert_eq!(previous_word_start(text, 7), 0); // Back to start
        assert_eq!(next_word_end(text, 0), 6); // "héllo" (é is 2 bytes)
    }

    #[test]
    fn kill_to_end_basic() {
        let result = kill_to_end("hello world", 6).unwrap();
        assert_eq!(result.killed, "world");
        assert_eq!(result.new_cursor, 6);
    }

    #[test]
    fn kill_to_end_multiline() {
        let result = kill_to_end("hello\nworld", 0).unwrap();
        assert_eq!(result.killed, "hello");
        assert_eq!(result.new_cursor, 0);
    }

    #[test]
    fn kill_to_start_basic() {
        let result = kill_to_start("hello world", 6).unwrap();
        assert_eq!(result.killed, "hello ");
        assert_eq!(result.new_cursor, 0);
    }

    #[test]
    fn kill_word_backward_basic() {
        let result = kill_word_backward("hello world", 11).unwrap();
        assert_eq!(result.killed, "world");
        assert_eq!(result.new_cursor, 6);
    }

    #[test]
    fn kill_word_forward_basic() {
        let result = kill_word_forward("hello world", 0).unwrap();
        assert_eq!(result.killed, "hello");
        assert_eq!(result.new_cursor, 0);
    }

    #[test]
    fn transpose_chars_middle() {
        let (result, cursor) = transpose_chars("abc", 1).unwrap();
        assert_eq!(result, "bac");
        assert_eq!(cursor, 2);
    }

    #[test]
    fn transpose_chars_end() {
        let (result, cursor) = transpose_chars("abc", 3).unwrap();
        assert_eq!(result, "acb");
        assert_eq!(cursor, 3);
    }

    #[test]
    fn current_word_bounds() {
        let text = "hello world test";

        // In middle of "world"
        assert_eq!(current_word_start(text, 8), 6);
        assert_eq!(current_word_end(text, 8), 11);

        // On space
        assert_eq!(current_word_start(text, 5), 0); // Goes to previous word
    }

    #[test]
    fn empty_kill_ignored() {
        let mut ring = KillRing::new();
        ring.kill("");
        assert!(ring.is_empty());
    }

    #[test]
    fn reset_rotation() {
        let mut ring = KillRing::new();
        ring.kill("a");
        ring.kill("b");

        ring.yank();
        assert!(ring.is_rotating());

        ring.reset_rotation();
        assert!(!ring.is_rotating());
        assert_eq!(ring.yank(), Some("b")); // Back to most recent
    }
}

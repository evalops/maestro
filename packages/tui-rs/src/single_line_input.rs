//! Single-Line Input with Horizontal Viewport Scrolling
//!
//! A focused implementation of single-line text input with:
//! - Horizontal viewport scrolling for long text
//! - Cursor positioning with center-tracking
//! - ANSI inverse video cursor rendering
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE LINE INPUT STATE
// ─────────────────────────────────────────────────────────────────────────────

/// State for a single-line text input field.
#[derive(Debug, Clone, Default)]
pub struct SingleLineInput {
    /// The current text value.
    value: String,
    /// Cursor position (byte offset).
    cursor: usize,
    /// Prompt string to display before input.
    prompt: String,
    /// Placeholder text when empty.
    placeholder: String,
}

impl SingleLineInput {
    /// Create a new single-line input.
    pub fn new() -> Self {
        Self {
            prompt: "> ".to_string(),
            ..Default::default()
        }
    }

    /// Create with a custom prompt.
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = prompt.into();
        self
    }

    /// Create with placeholder text.
    pub fn with_placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    /// Get the current value.
    pub fn value(&self) -> &str {
        &self.value
    }

    /// Set the value, clamping cursor to valid range.
    pub fn set_value(&mut self, value: impl Into<String>) {
        self.value = value.into();
        self.cursor = self.cursor.min(self.value.len());
    }

    /// Get cursor position.
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Set cursor position, clamped to value length.
    pub fn set_cursor(&mut self, pos: usize) {
        self.cursor = pos.min(self.value.len());
    }

    /// Move cursor to start.
    pub fn move_to_start(&mut self) {
        self.cursor = 0;
    }

    /// Move cursor to end.
    pub fn move_to_end(&mut self) {
        self.cursor = self.value.len();
    }

    /// Move cursor left by one character.
    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            // Find previous character boundary
            let mut new_pos = self.cursor - 1;
            while new_pos > 0 && !self.value.is_char_boundary(new_pos) {
                new_pos -= 1;
            }
            self.cursor = new_pos;
        }
    }

    /// Move cursor right by one character.
    pub fn move_right(&mut self) {
        if self.cursor < self.value.len() {
            // Find next character boundary
            let mut new_pos = self.cursor + 1;
            while new_pos < self.value.len() && !self.value.is_char_boundary(new_pos) {
                new_pos += 1;
            }
            self.cursor = new_pos;
        }
    }

    /// Insert a character at cursor position.
    pub fn insert(&mut self, ch: char) {
        self.value.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
    }

    /// Insert a string at cursor position.
    pub fn insert_str(&mut self, s: &str) {
        self.value.insert_str(self.cursor, s);
        self.cursor += s.len();
    }

    /// Delete character before cursor (backspace).
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            // Find previous character boundary
            let mut start = self.cursor - 1;
            while start > 0 && !self.value.is_char_boundary(start) {
                start -= 1;
            }
            self.value.remove(start);
            self.cursor = start;
        }
    }

    /// Delete character at cursor (delete key).
    pub fn delete(&mut self) {
        if self.cursor < self.value.len() {
            self.value.remove(self.cursor);
        }
    }

    /// Delete from cursor to end of line (Ctrl+K).
    pub fn kill_to_end(&mut self) -> String {
        let killed = self.value[self.cursor..].to_string();
        self.value.truncate(self.cursor);
        killed
    }

    /// Delete from start to cursor (Ctrl+U).
    pub fn kill_to_start(&mut self) -> String {
        let killed = self.value[..self.cursor].to_string();
        self.value = self.value[self.cursor..].to_string();
        self.cursor = 0;
        killed
    }

    /// Clear all text.
    pub fn clear(&mut self) {
        self.value.clear();
        self.cursor = 0;
    }

    /// Check if input is empty.
    pub fn is_empty(&self) -> bool {
        self.value.is_empty()
    }

    /// Calculate visible text and cursor position for a given width.
    ///
    /// Returns (visible_text, cursor_display_position, viewport_start).
    pub fn calculate_viewport(&self, available_width: usize) -> (&str, usize, usize) {
        let text_width = self.value.width();

        if text_width <= available_width {
            // Everything fits
            let cursor_pos = self.value[..self.cursor].width();
            return (&self.value, cursor_pos, 0);
        }

        // Need to scroll - use half-width centering algorithm
        let cursor_char_pos = self.value[..self.cursor].width();
        let half_width = available_width / 2;

        let (start_char, end_char, cursor_display) = if cursor_char_pos < half_width {
            // Cursor near start - show beginning
            (0, available_width, cursor_char_pos)
        } else if cursor_char_pos > text_width.saturating_sub(half_width) {
            // Cursor near end - show ending
            let start = text_width.saturating_sub(available_width);
            (start, text_width, cursor_char_pos - start)
        } else {
            // Cursor in middle - center it
            let start = cursor_char_pos.saturating_sub(half_width);
            (start, start + available_width, half_width)
        };

        // Convert char positions to byte positions
        let (byte_start, byte_end) = char_range_to_bytes(&self.value, start_char, end_char);

        (
            &self.value[byte_start..byte_end],
            cursor_display,
            start_char,
        )
    }

    /// Render the input to a Line with cursor styling.
    pub fn render_line(&self, width: usize) -> Line<'static> {
        let prompt_width = self.prompt.width();
        let available_width = width.saturating_sub(prompt_width);

        if self.value.is_empty() && !self.placeholder.is_empty() {
            // Show placeholder
            return Line::from(vec![
                Span::styled(self.prompt.clone(), Style::default().fg(Color::DarkGray)),
                Span::styled(
                    self.placeholder.clone(),
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
        }

        let (visible_text, cursor_display, _) = self.calculate_viewport(available_width);

        // Split text around cursor
        let (before_cursor, cursor_char, after_cursor) =
            split_at_display_pos(visible_text, cursor_display);

        let cursor_span = if cursor_char.is_empty() {
            // Cursor at end - show block cursor on space
            Span::styled(
                " ",
                Style::default()
                    .bg(Color::White)
                    .fg(Color::Black)
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            // Show cursor char with inverse video
            Span::styled(
                cursor_char.to_string(),
                Style::default()
                    .bg(Color::White)
                    .fg(Color::Black)
                    .add_modifier(Modifier::BOLD),
            )
        };

        Line::from(vec![
            Span::styled(self.prompt.clone(), Style::default().fg(Color::Cyan)),
            Span::raw(before_cursor.to_string()),
            cursor_span,
            Span::raw(after_cursor.to_string()),
        ])
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIDGET IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/// Widget for rendering a SingleLineInput.
pub struct SingleLineInputWidget<'a> {
    input: &'a SingleLineInput,
    focused: bool,
}

impl<'a> SingleLineInputWidget<'a> {
    pub fn new(input: &'a SingleLineInput) -> Self {
        Self {
            input,
            focused: true,
        }
    }

    pub fn focused(mut self, focused: bool) -> Self {
        self.focused = focused;
        self
    }
}

impl Widget for SingleLineInputWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let line = if self.focused {
            self.input.render_line(area.width as usize)
        } else {
            // Unfocused - no cursor
            let prompt_width = self.input.prompt.width();
            let available = area.width as usize - prompt_width;
            let (visible, _, _) = self.input.calculate_viewport(available);

            Line::from(vec![
                Span::styled(
                    self.input.prompt.clone(),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::raw(visible.to_string()),
            ])
        };

        Paragraph::new(line).render(area, buf);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Convert character display positions to byte positions.
fn char_range_to_bytes(s: &str, start_char: usize, end_char: usize) -> (usize, usize) {
    let mut current_width = 0;
    let mut byte_start = 0;
    let mut byte_end = s.len();
    let mut found_start = false;

    for (i, ch) in s.char_indices() {
        if current_width >= start_char && !found_start {
            byte_start = i;
            found_start = true;
        }
        current_width += ch.to_string().width();
        if current_width >= end_char {
            byte_end = i + ch.len_utf8();
            break;
        }
    }

    (byte_start, byte_end)
}

/// Split a string at a display position, returning (before, char_at_pos, after).
fn split_at_display_pos(s: &str, display_pos: usize) -> (&str, &str, &str) {
    let mut current_width = 0;

    for (i, ch) in s.char_indices() {
        if current_width >= display_pos {
            let char_end = i + ch.len_utf8();
            return (&s[..i], &s[i..char_end], &s[char_end..]);
        }
        current_width += ch.to_string().width();
    }

    // Cursor at end
    (s, "", "")
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_input_is_empty() {
        let input = SingleLineInput::new();
        assert!(input.is_empty());
        assert_eq!(input.cursor(), 0);
    }

    #[test]
    fn insert_updates_cursor() {
        let mut input = SingleLineInput::new();
        input.insert('a');
        input.insert('b');
        assert_eq!(input.value(), "ab");
        assert_eq!(input.cursor(), 2);
    }

    #[test]
    fn backspace_removes_char() {
        let mut input = SingleLineInput::new();
        input.set_value("abc");
        input.set_cursor(3);
        input.backspace();
        assert_eq!(input.value(), "ab");
        assert_eq!(input.cursor(), 2);
    }

    #[test]
    fn delete_removes_char_at_cursor() {
        let mut input = SingleLineInput::new();
        input.set_value("abc");
        input.set_cursor(1);
        input.delete();
        assert_eq!(input.value(), "ac");
        assert_eq!(input.cursor(), 1);
    }

    #[test]
    fn move_left_right() {
        let mut input = SingleLineInput::new();
        input.set_value("hello");
        input.set_cursor(3);

        input.move_left();
        assert_eq!(input.cursor(), 2);

        input.move_right();
        assert_eq!(input.cursor(), 3);
    }

    #[test]
    fn move_to_start_end() {
        let mut input = SingleLineInput::new();
        input.set_value("hello");
        input.set_cursor(3);

        input.move_to_start();
        assert_eq!(input.cursor(), 0);

        input.move_to_end();
        assert_eq!(input.cursor(), 5);
    }

    #[test]
    fn kill_to_end() {
        let mut input = SingleLineInput::new();
        input.set_value("hello world");
        input.set_cursor(6);
        let killed = input.kill_to_end();
        assert_eq!(input.value(), "hello ");
        assert_eq!(killed, "world");
    }

    #[test]
    fn kill_to_start() {
        let mut input = SingleLineInput::new();
        input.set_value("hello world");
        input.set_cursor(6);
        let killed = input.kill_to_start();
        assert_eq!(input.value(), "world");
        assert_eq!(killed, "hello ");
        assert_eq!(input.cursor(), 0);
    }

    #[test]
    fn viewport_fits_short_text() {
        let mut input = SingleLineInput::new();
        input.set_value("hi");
        let (visible, cursor_pos, start) = input.calculate_viewport(20);
        assert_eq!(visible, "hi");
        assert_eq!(cursor_pos, 0);
        assert_eq!(start, 0);
    }

    #[test]
    fn viewport_scrolls_long_text() {
        let mut input = SingleLineInput::new();
        input.set_value("this is a very long line of text that needs scrolling");
        input.set_cursor(30); // Middle of text

        let (visible, cursor_pos, _) = input.calculate_viewport(20);
        assert!(visible.len() <= 20);
        // Cursor should be roughly centered
        assert!(cursor_pos >= 8 && cursor_pos <= 12);
    }

    #[test]
    fn unicode_handling() {
        let mut input = SingleLineInput::new();
        input.set_value("日本語");
        input.set_cursor(3); // After first character

        input.move_right();
        assert_eq!(input.cursor(), 6); // Next character boundary

        input.backspace();
        assert_eq!(input.value(), "日語");
    }

    #[test]
    fn split_at_display_pos_works() {
        let (before, at, after) = split_at_display_pos("hello", 2);
        assert_eq!(before, "he");
        assert_eq!(at, "l");
        assert_eq!(after, "lo");
    }

    #[test]
    fn split_at_end() {
        let (before, at, after) = split_at_display_pos("hi", 2);
        assert_eq!(before, "hi");
        assert_eq!(at, "");
        assert_eq!(after, "");
    }
}

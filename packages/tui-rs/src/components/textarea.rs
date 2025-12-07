//! Text area widget with proper cursor positioning
//!
//! Adapted from OpenAI Codex (MIT License)
//! https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/textarea.rs
//!
//! This module provides a stateful text area component with:
//! - Proper multi-line cursor positioning
//! - Cached line wrapping for performance
//! - Unicode-aware column calculation
//!
//! Integrated with AppState for multi-line input support.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Widget;
use std::cell::RefCell;
use std::ops::Range;
use textwrap::Options;
use unicode_width::UnicodeWidthStr;

/// A text area with cursor tracking and proper positioning
#[derive(Debug)]
pub struct TextArea {
    /// The text content
    text: String,
    /// Cursor position in bytes
    cursor_pos: usize,
    /// Cached wrapped lines
    wrap_cache: RefCell<Option<WrapCache>>,
}

#[derive(Debug, Clone)]
struct WrapCache {
    width: u16,
    lines: Vec<Range<usize>>,
}

impl TextArea {
    /// Create a new empty text area
    pub fn new() -> Self {
        Self {
            text: String::new(),
            cursor_pos: 0,
            wrap_cache: RefCell::new(None),
        }
    }

    /// Set the text content
    pub fn set_text(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor_pos = self.cursor_pos.clamp(0, self.text.len());
        self.wrap_cache.replace(None);
    }

    /// Get the text content
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Set cursor position
    pub fn set_cursor(&mut self, pos: usize) {
        self.cursor_pos = pos.clamp(0, self.text.len());
    }

    /// Get cursor position
    pub fn cursor(&self) -> usize {
        self.cursor_pos
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Get the desired height for the given width
    pub fn desired_height(&self, width: u16) -> u16 {
        if width == 0 {
            return 1;
        }
        self.wrapped_lines(width).len().max(1) as u16
    }

    /// Compute the on-screen cursor position
    pub fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        if area.width == 0 || area.height == 0 {
            return None;
        }

        let lines = self.wrapped_lines(area.width);
        let line_idx = Self::wrapped_line_index(&lines, self.cursor_pos)?;
        let line_range = &lines[line_idx];

        // Calculate column based on unicode display width
        let col = self.text[line_range.start..self.cursor_pos].width() as u16;

        // Clamp to visible area
        let row = line_idx as u16;
        if row >= area.height {
            return None;
        }

        Some((area.x + col.min(area.width.saturating_sub(1)), area.y + row))
    }

    /// Find which wrapped line contains the given byte position
    fn wrapped_line_index(lines: &[Range<usize>], pos: usize) -> Option<usize> {
        let idx = lines.partition_point(|r| r.start <= pos);
        if idx == 0 {
            None
        } else {
            Some(idx - 1)
        }
    }

    /// Get wrapped lines for the given width (cached)
    fn wrapped_lines(&self, width: u16) -> Vec<Range<usize>> {
        {
            let cache = self.wrap_cache.borrow();
            if let Some(c) = cache.as_ref() {
                if c.width == width {
                    return c.lines.clone();
                }
            }
        }

        let lines = wrap_ranges(&self.text, width as usize);
        self.wrap_cache.replace(Some(WrapCache {
            width,
            lines: lines.clone(),
        }));
        lines
    }
}

impl Default for TextArea {
    fn default() -> Self {
        Self::new()
    }
}

/// Wrap text and return byte ranges for each line
#[allow(clippy::single_range_in_vec_init)] // Single-element vec is intentional for empty text case
fn wrap_ranges(text: &str, width: usize) -> Vec<Range<usize>> {
    if text.is_empty() {
        return vec![0..0];
    }

    let opts = Options::new(width.max(1)).wrap_algorithm(textwrap::WrapAlgorithm::FirstFit);

    let mut lines: Vec<Range<usize>> = Vec::new();

    for line in textwrap::wrap(text, opts) {
        match line {
            std::borrow::Cow::Borrowed(slice) => {
                // SAFETY: slice is borrowed from text, so pointer arithmetic is valid
                let start = unsafe { slice.as_ptr().offset_from(text.as_ptr()) as usize };
                let end = start + slice.len();
                // Include trailing space + sentinel byte for cursor positioning
                let trailing_spaces = text[end..].chars().take_while(|c| *c == ' ').count();
                lines.push(start..end + trailing_spaces + 1);
            }
            std::borrow::Cow::Owned(_) => {
                // textwrap shouldn't return owned strings for simple wrapping
                // but handle gracefully
                lines.push(0..text.len());
            }
        }
    }

    if lines.is_empty() {
        lines.push(0..text.len());
    }

    lines
}

/// Widget that renders a TextArea
pub struct TextAreaWidget<'a> {
    textarea: &'a TextArea,
    style: Style,
    placeholder: Option<&'a str>,
    placeholder_style: Style,
}

impl<'a> TextAreaWidget<'a> {
    pub fn new(textarea: &'a TextArea) -> Self {
        Self {
            textarea,
            style: Style::default(),
            placeholder: None,
            placeholder_style: Style::default(),
        }
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    pub fn placeholder(mut self, text: &'a str, style: Style) -> Self {
        self.placeholder = Some(text);
        self.placeholder_style = style;
        self
    }
}

impl Widget for TextAreaWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        if self.textarea.is_empty() {
            // Render placeholder
            if let Some(placeholder) = self.placeholder {
                buf.set_string(area.x, area.y, placeholder, self.placeholder_style);
            }
            return;
        }

        // Render text with wrapping
        let lines = self.textarea.wrapped_lines(area.width);
        for (row, range) in lines.iter().enumerate() {
            if row as u16 >= area.height {
                break;
            }
            let end = range.end.saturating_sub(1).min(self.textarea.text.len());
            if range.start < end {
                let line_text = &self.textarea.text[range.start..end];
                buf.set_string(area.x, area.y + row as u16, line_text, self.style);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_textarea() {
        let ta = TextArea::new();
        assert!(ta.is_empty());
        assert_eq!(ta.cursor(), 0);
        assert_eq!(ta.desired_height(80), 1);
    }

    #[test]
    fn set_text_and_cursor() {
        let mut ta = TextArea::new();
        ta.set_text("hello world");
        assert_eq!(ta.text(), "hello world");

        ta.set_cursor(5);
        assert_eq!(ta.cursor(), 5);

        // Cursor clamped to text length
        ta.set_cursor(100);
        assert_eq!(ta.cursor(), 11);
    }

    #[test]
    fn cursor_pos_simple() {
        let mut ta = TextArea::new();
        ta.set_text("hello");
        ta.set_cursor(2);

        let area = Rect::new(0, 0, 80, 10);
        let pos = ta.cursor_pos(area);
        assert_eq!(pos, Some((2, 0)));
    }

    #[test]
    fn cursor_pos_with_offset() {
        let mut ta = TextArea::new();
        ta.set_text("hello");
        ta.set_cursor(3);

        let area = Rect::new(5, 10, 80, 10);
        let pos = ta.cursor_pos(area);
        assert_eq!(pos, Some((8, 10))); // 5 + 3 = 8
    }

    #[test]
    fn wrap_ranges_simple() {
        let ranges = wrap_ranges("hello world", 5);
        assert!(ranges.len() >= 2);
    }

    #[test]
    fn wrap_ranges_empty() {
        let ranges = wrap_ranges("", 10);
        assert_eq!(ranges.len(), 1);
    }
}

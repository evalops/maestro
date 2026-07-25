//! Multi-line text area widget with cursor tracking
//!
//! This module provides a stateful text area component for multi-line text input
//! with proper cursor positioning and efficient text wrapping.
//!
//! # Architecture
//!
//! The text area is split into two parts:
//! - `TextArea`: Stateful data structure holding text content, cursor position, and wrap cache
//! - `TextAreaWidget`: Stateless widget that renders a `TextArea` reference
//!
//! This separation follows the stateful widget pattern common in Ratatui applications.
//!
//! # Features
//!
//! ## Unicode-Aware Cursor Positioning
//!
//! The cursor position is tracked in **byte offsets** (matching Rust's string indexing),
//! but displayed using **display width** (accounting for wide characters like emoji and
//! CJK characters). This is critical for proper cursor rendering in terminals.
//!
//! ```rust,ignore
//! let text = "Hello 世界"; // "世界" are 2-column wide characters
//! // Byte offset: 11 (5 ASCII + 6 UTF-8 bytes)
//! // Display width: 9 (5 + 4 columns)
//! ```
//!
//! ## Cached Line Wrapping
//!
//! Text wrapping is expensive to compute on every render, so results are cached:
//! - `WrapCache` stores wrapped line byte ranges for a given width
//! - Cache is invalidated when text changes or render width changes
//! - Uses `RefCell` for interior mutability (cache updates during const `&self` methods)
//!
//! ## Text Wrapping Algorithm
//!
//! Wrapping is performed by the `textwrap` crate using the `FirstFit` algorithm:
//! - Breaks at word boundaries when possible
//! - Preserves trailing spaces for accurate cursor positioning
//! - Returns byte ranges (`Range<usize>`) for each wrapped line
//!
//! Cursor positioning supports "end of line" without sentinel bytes by treating
//! the end of each wrapped range as a valid cursor position.
//!
//! ## Paste Folding
//!
//! Large pasted blocks (more than `PASTE_FOLD_MIN_LINES` lines or
//! `PASTE_FOLD_MIN_CHARS` bytes) are elided from the display as a single
//! `[Pasted: N lines]` chip line, while the full content stays in the text
//! buffer and is submitted byte-identically. Folding is display-only:
//! `display_text()` produces the elided view that wrapping and cursor math
//! operate on, with byte offsets mapped between the two representations.
//! Any edit (`set_text`) drops all folds.
//!
//! # Usage Pattern
//!
//! ```rust,ignore
//! // Create stateful text area
//! let mut textarea = TextArea::new();
//! textarea.set_text("Multi-line\ntext content");
//! textarea.set_cursor(10);
//!
//! // Render with widget
//! let widget = TextAreaWidget::new(&textarea)
//!     .style(Style::default().fg(Color::White))
//!     .placeholder("Type here...", Style::default().fg(Color::DarkGray));
//! frame.render_widget(widget, area);
//!
//! // Calculate cursor position for terminal
//! if let Some((x, y)) = textarea.cursor_pos(area) {
//!     frame.set_cursor_position((x, y));
//! }
//! ```
//!
//! # Widget Trait Implementation
//!
//! `TextAreaWidget` implements `Widget` by:
//! 1. Rendering placeholder if text is empty
//! 2. Computing wrapped lines for the given area width
//! 3. Rendering each wrapped line with `buf.set_string()`
//! 4. Rendering wrapped ranges as-is (end-of-line is range.end)
//!
//! # Cursor Position Calculation
//!
//! The `cursor_pos()` method computes the on-screen (x, y) position:
//! 1. Get wrapped line ranges for the area width
//! 2. Find which wrapped line contains the cursor byte offset (`wrapped_line_index`)
//! 3. Calculate display width from line start to cursor
//! 4. Clamp to visible area and return (x, y) coordinates
//!
//! # Credit
//!
//! Adapted from `OpenAI` Codex (MIT License):
//! <https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/textarea.rs>
//!
//! Integrated with `AppState` for multi-line input support in Maestro.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Widget;
use std::borrow::Cow;
use std::cell::RefCell;
use std::ops::Range;
use textwrap::core::break_words;
use textwrap::word_splitters::split_words;
use textwrap::Options;
use unicode_width::UnicodeWidthStr;

/// A pasted block is folded into a chip when it spans more than this many lines.
pub const PASTE_FOLD_MIN_LINES: usize = 8;
/// A pasted block is folded into a chip when it exceeds this many bytes.
pub const PASTE_FOLD_MIN_CHARS: usize = 400;

/// A pasted region of the text that is elided from the display as a chip.
///
/// The full pasted content stays in the text buffer (submission is
/// byte-identical); only rendering and cursor math elide the region into a
/// single `[Pasted: N lines]` chip line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteFold {
    /// Byte range of the pasted block within the full text.
    pub range: Range<usize>,
    /// Number of lines the pasted block spans (shown in the chip label).
    pub lines: usize,
}

/// The chip label shown in place of a folded paste.
fn chip_label(lines: usize) -> String {
    if lines == 1 {
        "[Pasted: 1 line]".to_string()
    } else {
        format!("[Pasted: {lines} lines]")
    }
}

/// Mapping between a folded region in the real text and its chip in the
/// display text.
#[derive(Debug)]
struct FoldSpan {
    /// Byte range in the real text.
    real: Range<usize>,
    /// Byte range of the chip in the display text.
    display: Range<usize>,
    /// The chip label shown in place of the folded region.
    chip: String,
}

/// A stateful text area widget with cursor tracking and efficient text wrapping.
///
/// This struct maintains the text content, cursor position, and cached line wrapping
/// information. It is designed to be used with `TextAreaWidget` for rendering.
///
/// # Cursor Position
///
/// The cursor position is stored as a **byte offset** into the text string, not a
/// character index or display column. This matches Rust's string indexing semantics
/// but requires special handling for:
/// - Unicode characters (multi-byte sequences)
/// - Wide characters (CJK, emoji) that take 2 terminal columns
///
/// Use `cursor_pos()` to convert the byte offset to terminal (x, y) coordinates.
///
/// # Wrap Caching
///
/// Line wrapping is computed lazily and cached using `RefCell` for interior mutability.
/// The cache is invalidated when:
/// - Text content changes (via `set_text()`)
/// - Rendering width changes
///
/// This optimization is critical for responsive rendering when typing.
#[derive(Debug)]
pub struct TextArea {
    /// The text content
    text: String,
    /// Cursor position in bytes (not characters or display columns)
    cursor_pos: usize,
    /// Pasted regions elided from the display as `[Pasted: N lines]` chips
    folds: Vec<PasteFold>,
    /// Cached wrapped lines for performance
    wrap_cache: RefCell<Option<WrapCache>>,
}

#[derive(Debug, Clone)]
struct WrapCache {
    width: u16,
    lines: Vec<Range<usize>>,
}

impl TextArea {
    /// Create a new empty text area
    #[must_use]
    pub fn new() -> Self {
        Self {
            text: String::new(),
            cursor_pos: 0,
            folds: Vec::new(),
            wrap_cache: RefCell::new(None),
        }
    }

    /// Set the text content
    ///
    /// This replaces the whole buffer, so any paste folds (which are keyed on
    /// byte ranges of the old buffer) are dropped: editing unfolds.
    pub fn set_text(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor_pos = self.cursor_pos.clamp(0, self.text.len());
        self.folds.clear();
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

    /// Register a pasted region to elide from the display as a chip.
    ///
    /// The range must be valid for the current text; call this immediately
    /// after inserting the pasted text (any later `set_text` drops all folds).
    pub fn add_paste_fold(&mut self, range: Range<usize>, lines: usize) {
        self.folds.push(PasteFold { range, lines });
        self.folds.sort_by_key(|fold| fold.range.start);
        self.wrap_cache.replace(None);
    }

    /// Remove all paste folds, restoring the full display.
    pub fn clear_paste_folds(&mut self) {
        if !self.folds.is_empty() {
            self.folds.clear();
            self.wrap_cache.replace(None);
        }
    }

    /// The currently folded paste regions.
    #[must_use]
    pub fn paste_folds(&self) -> &[PasteFold] {
        &self.folds
    }

    /// Total number of pasted lines currently folded, if any (for the
    /// status line note).
    #[must_use]
    pub fn folded_paste_lines(&self) -> Option<usize> {
        if self.folds.is_empty() {
            None
        } else {
            Some(self.folds.iter().map(|fold| fold.lines).sum())
        }
    }

    /// Range of the fold whose pasted block ends exactly at `byte`, if any.
    ///
    /// Used for unit delete: Backspace right after a folded paste removes the
    /// whole pasted block.
    #[must_use]
    pub fn fold_ending_at(&self, byte: usize) -> Option<Range<usize>> {
        self.folds
            .iter()
            .find(|fold| fold.range.end == byte)
            .map(|fold| fold.range.clone())
    }

    /// The text as displayed: folded paste regions replaced by chip labels.
    ///
    /// When there are no folds this borrows the real text; all rendering and
    /// cursor math operate on display-text byte offsets.
    #[must_use]
    pub fn display_text(&self) -> Cow<'_, str> {
        if self.folds.is_empty() {
            return Cow::Borrowed(&self.text);
        }
        let mut out = String::with_capacity(self.text.len());
        let mut cursor = 0;
        for span in self.fold_spans() {
            out.push_str(&self.text[cursor..span.real.start]);
            out.push_str(&span.chip);
            cursor = span.real.end;
        }
        out.push_str(&self.text[cursor..]);
        Cow::Owned(out)
    }

    /// Compute the real/display range pairs for each valid fold.
    ///
    /// Stale or overlapping folds (defensive; folds are dropped on edit) are
    /// skipped. Display ranges index into the string built by
    /// `display_text()`.
    fn fold_spans(&self) -> Vec<FoldSpan> {
        let mut spans = Vec::with_capacity(self.folds.len());
        let mut real_cursor = 0;
        let mut display_cursor = 0;
        for fold in &self.folds {
            let start = fold.range.start.min(self.text.len());
            let end = fold.range.end.min(self.text.len()).max(start);
            if start < real_cursor {
                continue;
            }
            display_cursor += start - real_cursor;
            let chip = chip_label(fold.lines);
            display_cursor += chip.len();
            spans.push(FoldSpan {
                real: start..end,
                display: display_cursor - chip.len()..display_cursor,
                chip,
            });
            real_cursor = end;
        }
        spans
    }

    /// Map a byte offset in the real text to a byte offset in display text.
    ///
    /// Offsets inside a folded region snap to the nearest chip edge.
    fn to_display_offset(&self, real: usize) -> usize {
        let mut display = real;
        for span in self.fold_spans() {
            if real <= span.real.start {
                break;
            }
            if real >= span.real.end {
                display = display - span.real.len() + span.display.len();
            } else {
                let chip_start = span.display.start;
                return if real - span.real.start <= span.real.end - real {
                    chip_start
                } else {
                    span.display.end
                };
            }
        }
        display
    }

    /// Map a byte offset in the display text back to a byte offset in the
    /// real text. Offsets inside a chip snap to the nearest edge of the
    /// folded region.
    fn to_real_offset(&self, display: usize) -> usize {
        let spans = self.fold_spans();
        for span in &spans {
            if display <= span.display.start {
                return display + (span.real.start - span.display.start);
            }
            if display < span.display.end {
                return if display - span.display.start <= span.display.end - display {
                    span.real.start
                } else {
                    span.real.end
                };
            }
        }
        if let Some(last) = spans.last() {
            display + (last.real.end - last.display.end)
        } else {
            display
        }
    }

    /// Get the desired height for the given width
    pub fn desired_height(&self, width: u16) -> u16 {
        if width == 0 {
            return 1;
        }
        self.wrapped_lines(width).len().max(1) as u16
    }

    /// Compute the on-screen (x, y) cursor position for the given rendering area.
    ///
    /// This method converts the byte-offset cursor position to terminal coordinates
    /// by accounting for:
    /// - Text wrapping within the area width
    /// - Unicode display width (not byte length)
    /// - Area offset (x, y position of the area)
    ///
    /// Returns `None` if the cursor is outside the visible area or if the area is
    /// too small to render.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let area = Rect::new(5, 10, 40, 3);
    /// if let Some((x, y)) = textarea.cursor_pos(area) {
    ///     frame.set_cursor_position((x, y));
    /// }
    /// ```
    pub fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        if area.width == 0 || area.height == 0 {
            return None;
        }

        let (line_idx, col) = self.cursor_line_col(area.width)?;

        // Clamp to visible area
        let row = line_idx as u16;
        if row >= area.height {
            return None;
        }

        Some((area.x + col.min(area.width.saturating_sub(1)), area.y + row))
    }

    /// Get the cursor's wrapped line index and display column.
    pub fn cursor_line_col(&self, width: u16) -> Option<(usize, u16)> {
        if width == 0 {
            return None;
        }
        let lines = self.wrapped_lines(width);
        let display = self.display_text();
        let display_cursor = self.to_display_offset(self.cursor_pos);
        let line_idx = Self::wrapped_line_index(&lines, display_cursor)?;
        let line_range = &lines[line_idx];
        let slice_end = display_cursor.min(line_range.end);
        let col = display[line_range.start..slice_end].width() as u16;
        Some((line_idx, col))
    }

    /// Convert a wrapped line index + display column into a byte offset.
    pub fn byte_pos_for_line_col(&self, width: u16, line_idx: usize, col: u16) -> Option<usize> {
        if width == 0 {
            return None;
        }
        let lines = self.wrapped_lines(width);
        let display = self.display_text();
        let range = lines.get(line_idx)?;
        if col == 0 {
            return Some(self.to_real_offset(range.start));
        }

        let slice = &display[range.start..range.end];
        let mut acc_width: u16 = 0;
        let mut byte_pos = range.start;

        for (offset, ch) in slice.char_indices() {
            let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) as u16;
            if acc_width.saturating_add(w) > col {
                break;
            }
            acc_width = acc_width.saturating_add(w);
            byte_pos = range.start + offset + ch.len_utf8();
        }

        let display_pos = if acc_width < col { range.end } else { byte_pos };
        Some(self.to_real_offset(display_pos))
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
    ///
    /// Wraps the display text, so returned ranges are byte offsets into
    /// `display_text()` (identical to `text()` when there are no folds).
    fn wrapped_lines(&self, width: u16) -> Vec<Range<usize>> {
        {
            let cache = self.wrap_cache.borrow();
            if let Some(c) = cache.as_ref() {
                if c.width == width {
                    return c.lines.clone();
                }
            }
        }

        let display = self.display_text();
        let lines = wrap_ranges(&display, width as usize);
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

/// Wrap text and return byte ranges for each wrapped line.
///
/// This function uses the `textwrap` crate to wrap text at the given width, then
/// converts the wrapped string slices to byte ranges into the original text.
///
/// Ranges are precise byte spans into the original buffer. Cursor positions are
/// allowed at `range.end` to represent end-of-line positions without sentinel bytes.
///
/// # Returns
///
/// A vector of byte ranges, one per wrapped line. For empty text, returns a
/// single 0..0 range.
#[allow(clippy::single_range_in_vec_init)] // Single-element vec is intentional for empty text case
fn wrap_ranges(text: &str, width: usize) -> Vec<Range<usize>> {
    if text.is_empty() {
        return vec![0..0];
    }

    let opts = Options::new(width.max(1)).wrap_algorithm(textwrap::WrapAlgorithm::FirstFit);
    let mut lines: Vec<Range<usize>> = Vec::new();

    let mut offset = 0usize;
    while offset <= text.len() {
        let remaining = &text[offset..];
        let Some(next_break) = remaining.find('\n') else {
            // Last line (no newline)
            let line = remaining;
            append_wrapped_line_ranges(line, offset, &opts, &mut lines);
            break;
        };

        let line_end = offset + next_break;
        let line = &text[offset..line_end];
        append_wrapped_line_ranges(line, offset, &opts, &mut lines);

        // Skip the newline character
        offset = line_end + 1;
        if offset == text.len() {
            // Trailing newline: add empty line
            lines.push(offset..offset);
            break;
        }
    }

    if lines.is_empty() {
        lines.push(0..text.len());
    }

    lines
}

fn append_wrapped_line_ranges(
    line: &str,
    line_start: usize,
    opts: &Options<'_>,
    out: &mut Vec<Range<usize>>,
) {
    let start_len = out.len();
    if line.is_empty() {
        out.push(line_start..line_start);
        return;
    }

    if UnicodeWidthStr::width(line) <= opts.width {
        out.push(line_start..(line_start + line.len()));
        return;
    }

    let initial_width = opts
        .width
        .saturating_sub(UnicodeWidthStr::width(opts.initial_indent));
    let subsequent_width = opts
        .width
        .saturating_sub(UnicodeWidthStr::width(opts.subsequent_indent));
    let line_widths = [initial_width, subsequent_width];

    let words = opts.word_separator.find_words(line);
    let split_words = split_words(words, &opts.word_splitter);
    let broken_words = if opts.break_words {
        break_words(split_words, line_widths[1])
    } else {
        split_words.collect::<Vec<_>>()
    };

    let wrapped_words = opts.wrap_algorithm.wrap(&broken_words, &line_widths);
    let mut idx = 0usize;

    for words in wrapped_words {
        if words.is_empty() {
            out.push(line_start + idx..line_start + idx);
            continue;
        }

        let last_word = words
            .last()
            .expect("wrapped word list cannot be empty here");
        let len = words
            .iter()
            .map(|word| word.len() + word.whitespace.len())
            .sum::<usize>()
            .saturating_sub(last_word.whitespace.len());

        let start = line_start + idx;
        let end = (start + len).min(line_start + line.len());
        out.push(start..end);
        idx = (end - line_start) + last_word.whitespace.len();
    }

    if out.len() == start_len {
        out.push(line_start..(line_start + line.len()));
    }
}

/// A stateless widget for rendering a `TextArea`.
///
/// This widget takes a reference to a `TextArea` and renders it to the terminal
/// buffer. It supports:
/// - Custom text styling
/// - Placeholder text when empty
/// - Automatic text wrapping
///
/// # Usage
///
/// ```rust,ignore
/// let widget = TextAreaWidget::new(&textarea)
///     .style(Style::default().fg(Color::White))
///     .placeholder("Type here...", Style::default().fg(Color::DarkGray));
/// frame.render_widget(widget, area);
/// ```
///
/// The cursor position is NOT rendered by this widget. Use `textarea.cursor_pos()`
/// to get coordinates and set the cursor separately.
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

    #[must_use]
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    #[must_use]
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

        // Render text with wrapping (display text elides folded pastes)
        let display = self.textarea.display_text();
        let lines = self.textarea.wrapped_lines(area.width);
        for (row, range) in lines.iter().enumerate() {
            if row as u16 >= area.height {
                break;
            }
            let end = range.end.min(display.len());
            if range.start <= end {
                let line_text = &display[range.start..end];
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

    #[test]
    fn wrap_ranges_preserves_newlines() {
        let ranges = wrap_ranges("one\ntwo\n", 10);
        assert!(ranges.len() >= 3);
        assert_eq!(ranges[0], 0..3);
        assert_eq!(ranges[1], 4..7);
        assert_eq!(ranges[2], 8..8);
    }

    fn folded_textarea() -> TextArea {
        // "before\n" + 10 pasted lines + "after"
        let pasted: String = (1..=10).fold(String::new(), |mut acc, i| {
            use std::fmt::Write as _;
            let _ = writeln!(acc, "line{i}");
            acc
        });
        let text = format!("before\n{pasted}after");
        let mut ta = TextArea::new();
        ta.set_text(&text);
        let start = "before\n".len();
        ta.add_paste_fold(start..start + pasted.len(), 10);
        ta.set_cursor(start + pasted.len());
        ta
    }

    #[test]
    fn paste_fold_elides_display_but_keeps_text() {
        let ta = folded_textarea();
        // Full text is untouched (submission is byte-identical).
        assert!(ta.text().contains("line5"));
        assert_eq!(ta.display_text(), "before\n[Pasted: 10 lines]after");
        assert_eq!(ta.folded_paste_lines(), Some(10));
    }

    #[test]
    fn paste_fold_shrinks_wrapped_height() {
        let mut ta = TextArea::new();
        let pasted: String = (1..=10).fold(String::new(), |mut acc, i| {
            use std::fmt::Write as _;
            let _ = writeln!(acc, "line{i}");
            acc
        });
        ta.set_text(&pasted);
        let unfolded_height = ta.desired_height(80);
        assert!(unfolded_height >= 10);

        ta.add_paste_fold(0..pasted.len(), 10);
        assert_eq!(ta.desired_height(80), 1);
    }

    #[test]
    fn paste_fold_cursor_maps_after_chip() {
        let ta = folded_textarea();
        // Cursor is at the end of the pasted block: it should render right
        // after the chip on the chip's line.
        let (line_idx, col) = ta.cursor_line_col(80).unwrap();
        assert_eq!(line_idx, 1);
        assert_eq!(col, "[Pasted: 10 lines]".len() as u16);

        // And the on-screen position matches.
        let area = Rect::new(0, 0, 80, 10);
        assert_eq!(
            ta.cursor_pos(area),
            Some((u16::try_from("[Pasted: 10 lines]".len()).unwrap(), 1))
        );
    }

    #[test]
    fn paste_fold_display_real_offset_roundtrip() {
        let ta = folded_textarea();
        // Positions before the fold are unaffected.
        assert_eq!(ta.to_display_offset(3), 3);
        assert_eq!(ta.to_real_offset(3), 3);
        // Fold start/end map to the chip edges.
        let start = "before\n".len();
        let end = ta.text().len() - "after".len();
        let chip_start = start;
        let chip_end = start + "[Pasted: 10 lines]".len();
        assert_eq!(ta.to_display_offset(start), chip_start);
        assert_eq!(ta.to_display_offset(end), chip_end);
        assert_eq!(ta.to_real_offset(chip_start), start);
        assert_eq!(ta.to_real_offset(chip_end), end);
        // Text after the fold shifts by the elision delta.
        let text_end = ta.text().len();
        assert_eq!(ta.to_display_offset(text_end), ta.display_text().len());
        assert_eq!(ta.to_real_offset(ta.display_text().len()), text_end);
    }

    #[test]
    fn paste_fold_byte_pos_for_line_col_crossing_chip() {
        let ta = folded_textarea();
        // Start of the chip line maps to the fold start.
        let start = "before\n".len();
        assert_eq!(ta.byte_pos_for_line_col(80, 1, 0), Some(start));
        // End of the chip maps to the fold end.
        let chip_cols = "[Pasted: 10 lines]".len() as u16;
        let fold_end = ta.text().len() - "after".len();
        assert_eq!(ta.byte_pos_for_line_col(80, 1, chip_cols), Some(fold_end));
    }

    #[test]
    fn set_text_drops_paste_folds() {
        let mut ta = folded_textarea();
        assert_eq!(ta.paste_folds().len(), 1);
        // Any edit replaces the buffer and unfolds.
        ta.set_text("edited");
        assert!(ta.paste_folds().is_empty());
        assert_eq!(ta.display_text(), "edited");
        assert_eq!(ta.folded_paste_lines(), None);
    }

    #[test]
    fn fold_ending_at_matches_block_end_only() {
        let ta = folded_textarea();
        let fold_end = ta.text().len() - "after".len();
        assert!(ta.fold_ending_at(fold_end).is_some());
        assert!(ta.fold_ending_at(fold_end - 1).is_none());
        assert!(ta.fold_ending_at(0).is_none());
    }
}

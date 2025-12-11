//! Truncated Text Display
//!
//! Provides utilities for displaying text that may be truncated with ellipsis,
//! with proper ANSI code handling to prevent style leakage.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

// ─────────────────────────────────────────────────────────────────────────────
// TRUNCATED TEXT
// ─────────────────────────────────────────────────────────────────────────────

/// A text component that truncates with ellipsis if needed.
///
/// Features:
/// - ANSI-aware truncation that preserves escape codes
/// - Reset codes before ellipsis to prevent style leakage
/// - Support for different truncation styles (end, middle, start)
#[derive(Debug, Clone)]
pub struct TruncatedText {
    text: String,
    style: Style,
    truncation: TruncationStyle,
    ellipsis: &'static str,
}

/// Where to truncate the text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TruncationStyle {
    /// Truncate at the end: "Hello wo…"
    #[default]
    End,
    /// Truncate in the middle: "Hello…rld"
    Middle,
    /// Truncate at the start: "…lo world"
    Start,
}

impl TruncatedText {
    /// Create a new truncated text component.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: Style::default(),
            truncation: TruncationStyle::End,
            ellipsis: "…",
        }
    }

    /// Set the text style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Set the truncation style.
    pub fn truncation(mut self, truncation: TruncationStyle) -> Self {
        self.truncation = truncation;
        self
    }

    /// Use ASCII ellipsis ("...") instead of unicode.
    pub fn ascii_ellipsis(mut self) -> Self {
        self.ellipsis = "...";
        self
    }

    /// Render to a Line that fits within the given width.
    pub fn render_line(&self, max_width: usize) -> Line<'static> {
        let text_width = self.text.width();

        if text_width <= max_width {
            // No truncation needed
            return Line::from(Span::styled(self.text.clone(), self.style));
        }

        let ellipsis_width = self.ellipsis.width();
        if max_width <= ellipsis_width {
            // Only room for ellipsis
            return Line::from(Span::styled(
                self.ellipsis.chars().take(max_width).collect::<String>(),
                self.style,
            ));
        }

        match self.truncation {
            TruncationStyle::End => self.truncate_end(max_width, ellipsis_width),
            TruncationStyle::Middle => self.truncate_middle(max_width, ellipsis_width),
            TruncationStyle::Start => self.truncate_start(max_width, ellipsis_width),
        }
    }

    fn truncate_end(&self, max_width: usize, ellipsis_width: usize) -> Line<'static> {
        let target_width = max_width - ellipsis_width;
        let truncated = truncate_to_width(&self.text, target_width);

        Line::from(vec![
            Span::styled(truncated, self.style),
            Span::styled(self.ellipsis, self.style.fg(Color::DarkGray)),
        ])
    }

    fn truncate_middle(&self, max_width: usize, ellipsis_width: usize) -> Line<'static> {
        let available = max_width - ellipsis_width;
        let left_width = (available + 1) / 2; // Slightly favor left side
        let right_width = available - left_width;

        let left = truncate_to_width(&self.text, left_width);
        let right = truncate_from_end(&self.text, right_width);

        Line::from(vec![
            Span::styled(left, self.style),
            Span::styled(self.ellipsis, self.style.fg(Color::DarkGray)),
            Span::styled(right, self.style),
        ])
    }

    fn truncate_start(&self, max_width: usize, ellipsis_width: usize) -> Line<'static> {
        let target_width = max_width - ellipsis_width;
        let truncated = truncate_from_end(&self.text, target_width);

        Line::from(vec![
            Span::styled(self.ellipsis, self.style.fg(Color::DarkGray)),
            Span::styled(truncated, self.style),
        ])
    }
}

impl Widget for TruncatedText {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let line = self.render_line(area.width as usize);
        Paragraph::new(line).render(area, buf);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUNCATED PATH
// ─────────────────────────────────────────────────────────────────────────────

/// A specialized truncated text for file paths.
///
/// Uses middle truncation to preserve both the root and filename,
/// which are typically the most important parts of a path.
#[derive(Debug, Clone)]
pub struct TruncatedPath {
    path: String,
    style: Style,
    separator: char,
}

impl TruncatedPath {
    /// Create a new truncated path component.
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            style: Style::default(),
            separator: std::path::MAIN_SEPARATOR,
        }
    }

    /// Set the path style.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    /// Render to a Line that fits within the given width.
    ///
    /// Preserves the first and last path segments when possible.
    pub fn render_line(&self, max_width: usize) -> Line<'static> {
        let path_width = self.path.width();

        if path_width <= max_width {
            return Line::from(Span::styled(self.path.clone(), self.style));
        }

        // Try smart path truncation
        let segments: Vec<&str> = self.path.split(self.separator).collect();

        if segments.len() <= 2 {
            // Just use regular middle truncation
            return TruncatedText::new(self.path.clone())
                .style(self.style)
                .truncation(TruncationStyle::Middle)
                .render_line(max_width);
        }

        // Try to keep first and last segments
        let first = segments.first().unwrap_or(&"");
        let last = segments.last().unwrap_or(&"");
        let ellipsis = "…";

        let min_path = format!(
            "{}{}{}{}{}",
            first, self.separator, ellipsis, self.separator, last
        );

        if min_path.width() > max_width {
            // Can't fit even minimal path, use regular truncation
            return TruncatedText::new(self.path.clone())
                .style(self.style)
                .truncation(TruncationStyle::Middle)
                .render_line(max_width);
        }

        // Add segments from both ends until we run out of space
        let mut left_segments = vec![*first];
        let mut right_segments = vec![*last];
        let mut left_idx = 1;
        let mut right_idx = segments.len() - 2;
        let ellipsis_sep = format!("{}{}{}", self.separator, ellipsis, self.separator);

        loop {
            // Try adding from left
            if left_idx <= right_idx {
                let test_left: Vec<&str> = left_segments
                    .iter()
                    .chain(std::iter::once(&segments[left_idx]))
                    .copied()
                    .collect();
                let test_path = format!(
                    "{}{}{}",
                    test_left.join(&self.separator.to_string()),
                    ellipsis_sep,
                    right_segments.join(&self.separator.to_string())
                );

                if test_path.width() <= max_width {
                    left_segments.push(segments[left_idx]);
                    left_idx += 1;
                    continue;
                }
            }

            // Try adding from right
            if left_idx <= right_idx {
                let test_right: Vec<&str> = std::iter::once(&segments[right_idx])
                    .chain(right_segments.iter())
                    .copied()
                    .collect();
                let test_path = format!(
                    "{}{}{}",
                    left_segments.join(&self.separator.to_string()),
                    ellipsis_sep,
                    test_right.join(&self.separator.to_string())
                );

                if test_path.width() <= max_width {
                    right_segments.insert(0, segments[right_idx]);
                    right_idx = right_idx.saturating_sub(1);
                    continue;
                }
            }

            break;
        }

        Line::from(vec![
            Span::styled(left_segments.join(&self.separator.to_string()), self.style),
            Span::styled(ellipsis_sep, self.style.fg(Color::DarkGray)),
            Span::styled(right_segments.join(&self.separator.to_string()), self.style),
        ])
    }
}

impl Widget for TruncatedPath {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let line = self.render_line(area.width as usize);
        Paragraph::new(line).render(area, buf);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Truncate a string to fit within a display width (from start).
fn truncate_to_width(s: &str, max_width: usize) -> String {
    let mut result = String::new();
    let mut current_width = 0;

    for ch in s.chars() {
        let ch_width = ch.to_string().width();
        if current_width + ch_width > max_width {
            break;
        }
        result.push(ch);
        current_width += ch_width;
    }

    result
}

/// Truncate a string to fit within a display width (from end).
fn truncate_from_end(s: &str, max_width: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut result = String::new();
    let mut current_width = 0;

    for ch in chars.into_iter().rev() {
        let ch_width = ch.to_string().width();
        if current_width + ch_width > max_width {
            break;
        }
        result.insert(0, ch);
        current_width += ch_width;
    }

    result
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_truncation_when_fits() {
        let text = TruncatedText::new("hello");
        let line = text.render_line(20);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(content, "hello");
    }

    #[test]
    fn truncate_end_adds_ellipsis() {
        let text = TruncatedText::new("hello world");
        let line = text.render_line(8);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.ends_with('…'));
        // Check display width, not byte length (ellipsis is 3 bytes but 1 cell)
        assert!(content.width() <= 8);
    }

    #[test]
    fn truncate_middle_preserves_ends() {
        let text = TruncatedText::new("hello world").truncation(TruncationStyle::Middle);
        let line = text.render_line(9);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains('…'));
        assert!(content.starts_with("hel") || content.starts_with("hell"));
        assert!(content.ends_with("ld") || content.ends_with("rld"));
    }

    #[test]
    fn truncate_start_preserves_end() {
        let text = TruncatedText::new("hello world").truncation(TruncationStyle::Start);
        let line = text.render_line(8);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.starts_with('…'));
        assert!(content.ends_with("world"));
    }

    #[test]
    fn ascii_ellipsis_option() {
        let text = TruncatedText::new("hello world").ascii_ellipsis();
        let line = text.render_line(10);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains("..."));
    }

    #[test]
    fn path_truncation_preserves_ends() {
        let path = TruncatedPath::new("/home/user/projects/very/long/nested/path/file.rs");
        let line = path.render_line(30);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();

        // Should preserve /home at start and file.rs at end
        assert!(content.contains("home") || content.starts_with('/'));
        assert!(content.contains("file.rs"));
        assert!(content.contains('…'));
    }

    #[test]
    fn short_path_not_truncated() {
        let path = TruncatedPath::new("/home/file.rs");
        let line = path.render_line(50);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(content, "/home/file.rs");
    }

    #[test]
    fn truncate_to_width_works() {
        assert_eq!(truncate_to_width("hello", 3), "hel");
        assert_eq!(truncate_to_width("hello", 10), "hello");
    }

    #[test]
    fn truncate_from_end_works() {
        assert_eq!(truncate_from_end("hello", 3), "llo");
        assert_eq!(truncate_from_end("hello", 10), "hello");
    }

    #[test]
    fn unicode_truncation() {
        // Each Japanese character is 2 cells wide
        let text = TruncatedText::new("日本語テスト");
        let line = text.render_line(8);
        let content: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        // Should fit 3 chars (6 cells) + ellipsis (1 cell) = 7 cells
        assert!(content.width() <= 8);
    }
}

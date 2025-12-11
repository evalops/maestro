//! Box and Border Drawing Utilities
//!
//! Provides utilities for drawing boxes and borders around content
//! using Unicode box-drawing characters.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

// ─────────────────────────────────────────────────────────────────────────────
// BORDER CHARACTERS
// ─────────────────────────────────────────────────────────────────────────────

/// Rounded corner box characters.
pub mod rounded {
    pub const TOP_LEFT: &str = "╭";
    pub const TOP_RIGHT: &str = "╮";
    pub const BOTTOM_LEFT: &str = "╰";
    pub const BOTTOM_RIGHT: &str = "╯";
    pub const HORIZONTAL: &str = "─";
    pub const VERTICAL: &str = "│";
}

/// Sharp corner box characters.
pub mod sharp {
    pub const TOP_LEFT: &str = "┌";
    pub const TOP_RIGHT: &str = "┐";
    pub const BOTTOM_LEFT: &str = "└";
    pub const BOTTOM_RIGHT: &str = "┘";
    pub const HORIZONTAL: &str = "─";
    pub const VERTICAL: &str = "│";
}

/// Double-line box characters.
pub mod double {
    pub const TOP_LEFT: &str = "╔";
    pub const TOP_RIGHT: &str = "╗";
    pub const BOTTOM_LEFT: &str = "╚";
    pub const BOTTOM_RIGHT: &str = "╝";
    pub const HORIZONTAL: &str = "═";
    pub const VERTICAL: &str = "║";
}

/// Heavy box characters.
pub mod heavy {
    pub const TOP_LEFT: &str = "┏";
    pub const TOP_RIGHT: &str = "┓";
    pub const BOTTOM_LEFT: &str = "┗";
    pub const BOTTOM_RIGHT: &str = "┛";
    pub const HORIZONTAL: &str = "━";
    pub const VERTICAL: &str = "┃";
}

// ─────────────────────────────────────────────────────────────────────────────
// BORDER STYLE
// ─────────────────────────────────────────────────────────────────────────────

/// Border style configuration.
#[derive(Debug, Clone, Copy)]
pub struct BorderStyle {
    pub top_left: &'static str,
    pub top_right: &'static str,
    pub bottom_left: &'static str,
    pub bottom_right: &'static str,
    pub horizontal: &'static str,
    pub vertical: &'static str,
}

impl BorderStyle {
    /// Rounded corners (default).
    pub const ROUNDED: Self = Self {
        top_left: rounded::TOP_LEFT,
        top_right: rounded::TOP_RIGHT,
        bottom_left: rounded::BOTTOM_LEFT,
        bottom_right: rounded::BOTTOM_RIGHT,
        horizontal: rounded::HORIZONTAL,
        vertical: rounded::VERTICAL,
    };

    /// Sharp corners.
    pub const SHARP: Self = Self {
        top_left: sharp::TOP_LEFT,
        top_right: sharp::TOP_RIGHT,
        bottom_left: sharp::BOTTOM_LEFT,
        bottom_right: sharp::BOTTOM_RIGHT,
        horizontal: sharp::HORIZONTAL,
        vertical: sharp::VERTICAL,
    };

    /// Double lines.
    pub const DOUBLE: Self = Self {
        top_left: double::TOP_LEFT,
        top_right: double::TOP_RIGHT,
        bottom_left: double::BOTTOM_LEFT,
        bottom_right: double::BOTTOM_RIGHT,
        horizontal: double::HORIZONTAL,
        vertical: double::VERTICAL,
    };

    /// Heavy lines.
    pub const HEAVY: Self = Self {
        top_left: heavy::TOP_LEFT,
        top_right: heavy::TOP_RIGHT,
        bottom_left: heavy::BOTTOM_LEFT,
        bottom_right: heavy::BOTTOM_RIGHT,
        horizontal: heavy::HORIZONTAL,
        vertical: heavy::VERTICAL,
    };
}

impl Default for BorderStyle {
    fn default() -> Self {
        Self::ROUNDED
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BORDER RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/// Wrap lines in a border.
///
/// The border is dimmed by default for a subtle appearance.
///
/// # Example
///
/// ```text
/// ╭──────────╮
/// │ Content  │
/// │ Line 2   │
/// ╰──────────╯
/// ```
pub fn with_border(lines: Vec<Line<'static>>) -> Vec<Line<'static>> {
    with_border_style(lines, BorderStyle::ROUNDED, None)
}

/// Wrap lines in a border with a minimum inner width.
///
/// This ensures the box is at least `inner_width` characters wide,
/// regardless of content width.
pub fn with_border_width(lines: Vec<Line<'static>>, inner_width: usize) -> Vec<Line<'static>> {
    with_border_style(lines, BorderStyle::ROUNDED, Some(inner_width))
}

/// Wrap lines in a border with custom style.
pub fn with_border_style(
    lines: Vec<Line<'static>>,
    style: BorderStyle,
    forced_inner_width: Option<usize>,
) -> Vec<Line<'static>> {
    // Calculate max line width
    let max_line_width = lines
        .iter()
        .map(|line| line_display_width(line))
        .max()
        .unwrap_or(0);

    let content_width = forced_inner_width
        .unwrap_or(max_line_width)
        .max(max_line_width);

    let mut out = Vec::with_capacity(lines.len() + 2);

    // Top border: ╭─────╮
    let border_inner_width = content_width + 2; // +2 for padding spaces
    let top = format!(
        "{}{}{}",
        style.top_left,
        style.horizontal.repeat(border_inner_width),
        style.top_right
    );
    out.push(Line::from(top.dim()));

    // Content lines with side borders
    for line in lines {
        let used_width = line_display_width(&line);
        let mut spans: Vec<Span<'static>> = Vec::with_capacity(line.spans.len() + 4);

        // Left border with padding
        spans.push(Span::from(format!("{} ", style.vertical)).dim());

        // Content
        spans.extend(line.spans);

        // Right padding if needed
        if used_width < content_width {
            spans.push(Span::from(" ".repeat(content_width - used_width)));
        }

        // Right border with padding
        spans.push(Span::from(format!(" {}", style.vertical)).dim());

        out.push(Line::from(spans));
    }

    // Bottom border: ╰─────╯
    let bottom = format!(
        "{}{}{}",
        style.bottom_left,
        style.horizontal.repeat(border_inner_width),
        style.bottom_right
    );
    out.push(Line::from(bottom.dim()));

    out
}

/// Calculate the inner width for a bordered card.
///
/// Returns None if the width is too small to contain a border.
pub fn card_inner_width(width: u16, max_inner_width: usize) -> Option<usize> {
    if width < 4 {
        return None;
    }
    // Subtract 4 for: │ + space + space + │
    let inner_width = std::cmp::min(width.saturating_sub(4) as usize, max_inner_width);
    Some(inner_width)
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Calculate the display width of a line.
fn line_display_width(line: &Line<'_>) -> usize {
    line.spans
        .iter()
        .map(|span| span.content.as_ref().width())
        .sum()
}

/// Create a horizontal separator line.
pub fn horizontal_separator(width: usize) -> Line<'static> {
    Line::from(rounded::HORIZONTAL.repeat(width).dim())
}

/// Create a horizontal separator with text.
///
/// Example: `──── Title ────`
pub fn separator_with_text(text: &str, width: usize) -> Line<'static> {
    let text_width = text.width();
    if text_width + 6 > width {
        // Not enough space, just show the separator
        return horizontal_separator(width);
    }

    let remaining = width - text_width - 2; // -2 for spaces around text
    let left = remaining / 2;
    let right = remaining - left;

    Line::from(vec![
        Span::from(rounded::HORIZONTAL.repeat(left)).dim(),
        Span::raw(" "),
        Span::raw(text.to_string()),
        Span::raw(" "),
        Span::from(rounded::HORIZONTAL.repeat(right)).dim(),
    ])
}

/// Add an emoji with proper spacing.
///
/// Uses a hair space (U+200A) after the emoji for consistent visual appearance
/// across terminals.
pub fn padded_emoji(emoji: &str) -> String {
    format!("{emoji}\u{200A}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn border_wraps_content() {
        let lines = vec![Line::from("Hello"), Line::from("World")];
        let bordered = with_border(lines);

        // Should have 4 lines: top + 2 content + bottom
        assert_eq!(bordered.len(), 4);

        // First line should start with ╭
        let first: String = bordered[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(first.starts_with('╭'));

        // Last line should start with ╰
        let last: String = bordered[3]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(last.starts_with('╰'));
    }

    #[test]
    fn border_with_minimum_width() {
        let lines = vec![Line::from("Hi")];
        let bordered = with_border_width(lines, 20);

        // The border should be at least 20 + 4 (for borders) wide
        let top: String = bordered[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(top.len() >= 24);
    }

    #[test]
    fn card_inner_width_returns_none_for_small() {
        assert!(card_inner_width(3, 100).is_none());
        assert!(card_inner_width(4, 100).is_some());
    }

    #[test]
    fn horizontal_separator_creates_line() {
        let sep = horizontal_separator(10);
        let content: String = sep.spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(content.chars().count(), 10);
    }

    #[test]
    fn separator_with_text_centers() {
        let sep = separator_with_text("Title", 20);
        let content: String = sep.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains("Title"));
    }

    #[test]
    fn padded_emoji_adds_hair_space() {
        let result = padded_emoji("✓");
        assert!(result.ends_with('\u{200A}'));
    }
}

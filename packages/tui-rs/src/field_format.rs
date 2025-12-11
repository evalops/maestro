//! Field Formatting for Aligned Label-Value Displays
//!
//! Provides utilities for formatting field/value pairs with consistent
//! alignment and indentation, commonly used in status displays.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

// ─────────────────────────────────────────────────────────────────────────────
// FIELD FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

/// Formats field/value pairs with aligned labels.
///
/// # Example
///
/// ```text
///  Model:     gpt-4
///  Status:    Running
///  Duration:  5m 30s
/// ```
#[derive(Debug, Clone)]
pub struct FieldFormatter {
    /// Indent string before labels.
    indent: String,
    /// Width of the widest label.
    label_width: usize,
    /// Total offset from start to value.
    value_offset: usize,
    /// Indent string for wrapped value lines.
    value_indent: String,
}

impl FieldFormatter {
    /// Default indent (single space).
    pub const DEFAULT_INDENT: &'static str = " ";

    /// Create a formatter from an iterator of labels.
    ///
    /// Calculates the maximum label width to ensure all values align.
    pub fn from_labels<S>(labels: impl IntoIterator<Item = S>) -> Self
    where
        S: AsRef<str>,
    {
        Self::from_labels_with_indent(labels, Self::DEFAULT_INDENT)
    }

    /// Create a formatter with custom indent.
    pub fn from_labels_with_indent<S>(labels: impl IntoIterator<Item = S>, indent: &str) -> Self
    where
        S: AsRef<str>,
    {
        let label_width = labels
            .into_iter()
            .map(|label| label.as_ref().width())
            .max()
            .unwrap_or(0);

        let indent_width = indent.width();
        // Format: indent + label + ":" + "   " (3 spaces)
        let value_offset = indent_width + label_width + 1 + 3;

        Self {
            indent: indent.to_string(),
            label_width,
            value_offset,
            value_indent: " ".repeat(value_offset),
        }
    }

    /// Format a label/value pair as a single line.
    pub fn line(&self, label: &str, value_spans: Vec<Span<'static>>) -> Line<'static> {
        Line::from(self.full_spans(label, value_spans))
    }

    /// Format a continuation line (for wrapped values).
    pub fn continuation(&self, mut spans: Vec<Span<'static>>) -> Line<'static> {
        let mut all_spans = Vec::with_capacity(spans.len() + 1);
        all_spans.push(Span::from(self.value_indent.clone()).dim());
        all_spans.append(&mut spans);
        Line::from(all_spans)
    }

    /// Calculate the available width for values.
    pub fn value_width(&self, available_width: usize) -> usize {
        available_width.saturating_sub(self.value_offset)
    }

    /// Get the total offset from start to value column.
    pub fn value_offset(&self) -> usize {
        self.value_offset
    }

    /// Build the full spans for a label/value pair.
    pub fn full_spans(
        &self,
        label: &str,
        mut value_spans: Vec<Span<'static>>,
    ) -> Vec<Span<'static>> {
        let mut spans = Vec::with_capacity(value_spans.len() + 1);
        spans.push(self.label_span(label));
        spans.append(&mut value_spans);
        spans
    }

    /// Create the label span with proper formatting.
    fn label_span(&self, label: &str) -> Span<'static> {
        let mut buf = String::with_capacity(self.value_offset);
        buf.push_str(&self.indent);
        buf.push_str(label);
        buf.push(':');

        // Add padding to align values
        let label_actual_width = label.width();
        let padding = 3 + self.label_width.saturating_sub(label_actual_width);
        for _ in 0..padding {
            buf.push(' ');
        }

        Span::from(buf).dim()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/// Calculate the display width of a line (sum of span widths).
pub fn line_display_width(line: &Line<'_>) -> usize {
    line.spans
        .iter()
        .map(|span| span.content.as_ref().width())
        .sum()
}

/// Truncate a line to fit within a maximum width.
///
/// Handles Unicode characters properly, truncating at character boundaries.
pub fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static> {
    if max_width == 0 {
        return Line::from(Vec::<Span<'static>>::new());
    }

    let mut used = 0usize;
    let mut spans_out: Vec<Span<'static>> = Vec::new();

    for span in line.spans {
        let text = span.content.into_owned();
        let style = span.style;
        let span_width = text.width();

        // Zero-width spans pass through
        if span_width == 0 {
            spans_out.push(Span::styled(text, style));
            continue;
        }

        // Already at limit
        if used >= max_width {
            break;
        }

        // Span fits completely
        if used + span_width <= max_width {
            used += span_width;
            spans_out.push(Span::styled(text, style));
            continue;
        }

        // Need to truncate within this span
        let mut truncated = String::new();
        for ch in text.chars() {
            let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + ch_width > max_width {
                break;
            }
            truncated.push(ch);
            used += ch_width;
        }

        if !truncated.is_empty() {
            spans_out.push(Span::styled(truncated, style));
        }

        break;
    }

    Line::from(spans_out)
}

/// Truncate a line and add ellipsis if truncated.
pub fn truncate_line_with_ellipsis(line: Line<'static>, max_width: usize) -> Line<'static> {
    let current_width = line_display_width(&line);
    if current_width <= max_width {
        return line;
    }

    // Truncate with space for ellipsis
    let mut truncated = truncate_line_to_width(line, max_width.saturating_sub(1));
    truncated.spans.push(Span::raw("…"));
    truncated
}

/// Check if a line contains only spaces (no other content).
pub fn is_blank_line(line: &Line<'_>) -> bool {
    line.spans
        .iter()
        .all(|span| span.content.chars().all(|c| c == ' '))
}

/// Convert a borrowed line to an owned 'static line.
pub fn line_to_static(line: &Line<'_>) -> Line<'static> {
    Line {
        spans: line
            .spans
            .iter()
            .map(|span| Span {
                content: span.content.to_string().into(),
                style: span.style,
            })
            .collect(),
        style: line.style,
        alignment: line.alignment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::{Color, Style};

    #[test]
    fn formatter_aligns_labels() {
        let labels = ["Short", "Much Longer Label"];
        let fmt = FieldFormatter::from_labels(labels);

        let line1 = fmt.line("Short", vec![Span::raw("value1")]);
        let line2 = fmt.line("Much Longer Label", vec![Span::raw("value2")]);

        // Values should start at the same column
        let label1_end = line1.spans[0].content.len();
        let label2_end = line2.spans[0].content.len();
        assert_eq!(label1_end, label2_end);
    }

    #[test]
    fn continuation_indents_properly() {
        let labels = ["Label"];
        let fmt = FieldFormatter::from_labels(labels);

        let cont = fmt.continuation(vec![Span::raw("continued value")]);
        assert!(!cont.spans.is_empty());
        // First span should be indentation
        assert!(cont.spans[0].content.chars().all(|c| c == ' '));
    }

    #[test]
    fn line_display_width_sums_spans() {
        let line = Line::from(vec![Span::raw("hello"), Span::raw(" "), Span::raw("world")]);
        assert_eq!(line_display_width(&line), 11);
    }

    #[test]
    fn truncate_line_respects_width() {
        let line = Line::from("This is a long line");
        let truncated = truncate_line_to_width(line, 10);
        assert!(line_display_width(&truncated) <= 10);
    }

    #[test]
    fn truncate_line_preserves_style() {
        let line = Line::from(vec![Span::styled(
            "colored",
            Style::default().fg(Color::Red),
        )]);
        let truncated = truncate_line_to_width(line, 4);
        assert_eq!(truncated.spans[0].style.fg, Some(Color::Red));
    }

    #[test]
    fn truncate_with_ellipsis_adds_ellipsis() {
        let line = Line::from("This is a long line");
        let truncated = truncate_line_with_ellipsis(line, 10);
        let content: String = truncated.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.ends_with('…'));
    }

    #[test]
    fn is_blank_detects_empty_lines() {
        assert!(is_blank_line(&Line::from("     ")));
        assert!(!is_blank_line(&Line::from("  x  ")));
    }

    #[test]
    fn line_to_static_converts() {
        let original = Line::from("test");
        let converted = line_to_static(&original);
        assert_eq!(converted.spans[0].content.as_ref(), "test");
    }
}

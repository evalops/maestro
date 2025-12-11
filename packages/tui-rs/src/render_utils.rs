//! Rendering utilities for terminal output
//!
//! This module provides helper functions for manipulating and formatting
//! styled text lines (ratatui Lines/Spans) for terminal display.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::text::{Line, Span};
use std::borrow::Cow;

/// Clone a borrowed ratatui `Line` into an owned `'static` line.
///
/// This is useful when you need to store lines in a collection that outlives
/// the original borrowed data.
pub fn line_to_static(line: &Line<'_>) -> Line<'static> {
    Line {
        style: line.style,
        alignment: line.alignment,
        spans: line
            .spans
            .iter()
            .map(|s| Span {
                style: s.style,
                content: Cow::Owned(s.content.to_string()),
            })
            .collect(),
    }
}

/// Append owned copies of borrowed lines to `out`.
pub fn push_owned_lines<'a>(src: &[Line<'a>], out: &mut Vec<Line<'static>>) {
    for l in src {
        out.push(line_to_static(l));
    }
}

/// Consider a line blank if it has no spans or only spans whose contents are
/// empty or consist solely of spaces (no tabs/newlines).
pub fn is_blank_line(line: &Line<'_>) -> bool {
    if line.spans.is_empty() {
        return true;
    }
    line.spans
        .iter()
        .all(|s| s.content.is_empty() || s.content.chars().all(|c| c == ' '))
}

/// Prefix each line with `initial_prefix` for the first line and
/// `subsequent_prefix` for following lines.
///
/// This is commonly used for tree-structured output like:
/// ```text
/// └ First line
///     Continuation line
///     Another continuation
/// ```
///
/// # Example
///
/// ```rust
/// use ratatui::text::{Line, Span};
/// use ratatui::style::Stylize;
/// use composer_tui::render_utils::prefix_lines;
///
/// let lines = vec![
///     Line::from("First line"),
///     Line::from("Second line"),
/// ];
/// let prefixed = prefix_lines(lines, "└ ".dim(), "  ".into());
/// // Result:
/// // └ First line
/// //   Second line
/// ```
pub fn prefix_lines(
    lines: Vec<Line<'static>>,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
) -> Vec<Line<'static>> {
    lines
        .into_iter()
        .enumerate()
        .map(|(i, l)| {
            let mut spans = Vec::with_capacity(l.spans.len() + 1);
            spans.push(if i == 0 {
                initial_prefix.clone()
            } else {
                subsequent_prefix.clone()
            });
            spans.extend(l.spans);
            Line::from(spans).style(l.style)
        })
        .collect()
}

/// Prefix lines with borrowed spans (for when you don't need owned output).
///
/// Returns a new Vec of lines with the prefixes prepended.
pub fn prefix_lines_borrowed<'a>(
    lines: &[Line<'a>],
    initial_prefix: &'a str,
    subsequent_prefix: &'a str,
) -> Vec<Line<'a>> {
    lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let prefix = if i == 0 {
                initial_prefix
            } else {
                subsequent_prefix
            };
            let mut spans = Vec::with_capacity(l.spans.len() + 1);
            spans.push(Span::raw(prefix));
            spans.extend(l.spans.iter().cloned());
            Line::from(spans).style(l.style)
        })
        .collect()
}

/// Truncate output lines using a head/tail approach with an ellipsis in the middle.
///
/// If `lines` exceeds `max_lines`, keeps the first half and last half of lines
/// with an ellipsis line showing how many lines were omitted.
///
/// # Arguments
///
/// * `lines` - The lines to truncate
/// * `max_lines` - Maximum number of lines to keep (including ellipsis)
/// * `omitted_hint` - Optional hint about already-omitted content to include in ellipsis
///
/// # Returns
///
/// A new Vec with at most `max_lines` lines, with an ellipsis if truncated.
pub fn truncate_lines_middle(
    lines: &[Line<'static>],
    max_lines: usize,
    omitted_hint: Option<usize>,
) -> Vec<Line<'static>> {
    if max_lines == 0 {
        return Vec::new();
    }
    if lines.len() <= max_lines {
        return lines.to_vec();
    }
    if max_lines == 1 {
        // Carry forward any previously omitted count and add any
        // additionally hidden content lines from this truncation.
        let base = omitted_hint.unwrap_or(0);
        let extra = lines
            .len()
            .saturating_sub(usize::from(omitted_hint.is_some()));
        let omitted = base + extra;
        return vec![ellipsis_line(omitted)];
    }

    let head = (max_lines - 1) / 2;
    let tail = max_lines - head - 1;
    let mut out: Vec<Line<'static>> = Vec::new();

    if head > 0 {
        out.extend(lines[..head].iter().cloned());
    }

    let base = omitted_hint.unwrap_or(0);
    let additional = lines
        .len()
        .saturating_sub(head + tail)
        .saturating_sub(usize::from(omitted_hint.is_some()));
    out.push(ellipsis_line(base + additional));

    if tail > 0 {
        out.extend(lines[lines.len() - tail..].iter().cloned());
    }

    out
}

/// Create an ellipsis line showing how many lines were omitted.
pub fn ellipsis_line(omitted: usize) -> Line<'static> {
    use ratatui::style::Stylize;
    Line::from(vec![format!("… +{omitted} lines").dim()])
}

/// Limit lines from the start, showing an ellipsis for any beyond the limit.
pub fn limit_lines_from_start(lines: &[Line<'static>], keep: usize) -> Vec<Line<'static>> {
    if lines.len() <= keep {
        return lines.to_vec();
    }
    if keep == 0 {
        return vec![ellipsis_line(lines.len())];
    }

    let mut out: Vec<Line<'static>> = lines[..keep].to_vec();
    out.push(ellipsis_line(lines.len() - keep));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Stylize;

    #[test]
    fn test_prefix_lines_basic() {
        let lines = vec![
            Line::from("First"),
            Line::from("Second"),
            Line::from("Third"),
        ];
        let prefixed = prefix_lines(lines, "└ ".into(), "  ".into());
        assert_eq!(prefixed.len(), 3);
        assert!(prefixed[0].to_string().starts_with("└ First"));
        assert!(prefixed[1].to_string().starts_with("  Second"));
        assert!(prefixed[2].to_string().starts_with("  Third"));
    }

    #[test]
    fn test_truncate_lines_middle_no_truncation() {
        let lines: Vec<Line<'static>> =
            vec![Line::from("one"), Line::from("two"), Line::from("three")];
        let result = truncate_lines_middle(&lines, 5, None);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_truncate_lines_middle_with_truncation() {
        let lines: Vec<Line<'static>> = (1..=10)
            .map(|i| Line::from(format!("line {}", i)))
            .collect();
        let result = truncate_lines_middle(&lines, 5, None);
        assert_eq!(result.len(), 5);
        // Should have head lines, ellipsis, tail lines
        assert!(result[2].to_string().contains("… +"));
    }

    #[test]
    fn test_line_to_static() {
        let line = Line::from(vec![
            Span::styled(
                "Hello",
                ratatui::style::Style::default().fg(ratatui::style::Color::Red),
            ),
            Span::raw(" world"),
        ]);
        let static_line = line_to_static(&line);
        assert_eq!(static_line.spans.len(), 2);
        assert_eq!(static_line.spans[0].content.as_ref(), "Hello");
    }

    #[test]
    fn test_is_blank_line() {
        assert!(is_blank_line(&Line::from("")));
        assert!(is_blank_line(&Line::from("   ")));
        assert!(!is_blank_line(&Line::from("a")));
        assert!(!is_blank_line(&Line::from(" a ")));
    }
}

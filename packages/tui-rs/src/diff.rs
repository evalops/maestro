//! Diff Rendering for File Changes
//!
//! This module generates and renders unified diffs for text comparison, using the
//! `similar` crate's Myers diff algorithm. It produces styled ratatui output similar
//! to `git diff` with color-coded additions, deletions, and context lines.
//!
//! # External Crates
//!
//! - **similar**: Fast diff library implementing the Myers diff algorithm with support
//!   for unified diff format, word-level diffs, and patience diff algorithm.
//! - **ratatui**: Used for styled terminal output.
//!
//! # Diff Format
//!
//! The output follows the unified diff format with:
//! - Hunk headers showing line ranges: `@@ -1,5 +1,7 @@`
//! - Line numbers in left (old) and right (new) columns
//! - Context lines (unchanged, no prefix)
//! - Added lines (green, `+` prefix)
//! - Removed lines (red, `-` prefix)
//!
//! # Line Wrapping
//!
//! Long diff lines are wrapped with proper gutter alignment:
//! - First line shows: `123 +content here...`
//! - Continuation shows: `      content continues...`
//!
//! This ensures the gutter (line numbers) stays aligned and the +/- sign
//! only appears on the first visual line.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).
//!
//! # Example
//!
//! ```
//! use composer_tui::diff::{generate_diff, render_diff};
//!
//! let old = "line 1\nline 2\nline 3";
//! let new = "line 1\nline 2 modified\nline 3";
//! let diff = generate_diff(old, new, 3);
//! let text = render_diff(&diff);
//! ```

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use similar::{ChangeTag, TextDiff};

/// Style configuration for diff display
#[derive(Clone)]
pub struct DiffStyles {
    pub added: Style,
    pub removed: Style,
    pub context: Style,
    pub header: Style,
    pub line_number: Style,
    pub hunk_header: Style,
}

impl Default for DiffStyles {
    fn default() -> Self {
        Self {
            added: Style::default().fg(Color::Green),
            removed: Style::default().fg(Color::Red),
            context: Style::default().fg(Color::Gray),
            header: Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
            line_number: Style::default().fg(Color::DarkGray),
            hunk_header: Style::default().fg(Color::Magenta),
        }
    }
}

/// A unified diff with metadata
pub struct Diff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub lines: Vec<DiffLine>,
    pub stats: DiffStats,
}

/// Statistics about the diff
#[derive(Default, Clone, Copy)]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
}

impl DiffStats {
    pub fn total_changes(&self) -> usize {
        self.added + self.removed
    }
}

/// A single line in a diff
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    pub old_line_num: Option<usize>,
    pub new_line_num: Option<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
    Header,
    HunkHeader,
}

/// Generate a diff between two strings
pub fn generate_diff(old: &str, new: &str, context_lines: usize) -> Diff {
    let text_diff = TextDiff::from_lines(old, new);
    let mut lines = Vec::new();
    let mut stats = DiffStats::default();

    for group in text_diff.grouped_ops(context_lines) {
        // Add hunk header
        let first_op = group.first();
        let last_op = group.last();

        if let (Some(first), Some(last)) = (first_op, last_op) {
            let old_start = first.old_range().start + 1;
            let old_len = last.old_range().end - first.old_range().start;
            let new_start = first.new_range().start + 1;
            let new_len = last.new_range().end - first.new_range().start;

            lines.push(DiffLine {
                kind: DiffLineKind::HunkHeader,
                content: format!(
                    "@@ -{},{} +{},{} @@",
                    old_start, old_len, new_start, new_len
                ),
                old_line_num: None,
                new_line_num: None,
            });

            // Reset line counters to match hunk start positions
            let mut old_line = old_start;
            let mut new_line = new_start;

            for op in &group {
                for change in text_diff.iter_changes(op) {
                    let (kind, old_num, new_num) = match change.tag() {
                        ChangeTag::Equal => {
                            let nums = (Some(old_line), Some(new_line));
                            old_line += 1;
                            new_line += 1;
                            (DiffLineKind::Context, nums.0, nums.1)
                        }
                        ChangeTag::Delete => {
                            stats.removed += 1;
                            let num = old_line;
                            old_line += 1;
                            (DiffLineKind::Removed, Some(num), None)
                        }
                        ChangeTag::Insert => {
                            stats.added += 1;
                            let num = new_line;
                            new_line += 1;
                            (DiffLineKind::Added, None, Some(num))
                        }
                    };

                    let content: String = change.value().to_string();

                    lines.push(DiffLine {
                        kind,
                        content: content.trim_end_matches('\n').to_string(),
                        old_line_num: old_num,
                        new_line_num: new_num,
                    });
                }
            }
        }
    }

    Diff {
        old_path: None,
        new_path: None,
        lines,
        stats,
    }
}

/// Render a diff to ratatui Text
pub fn render_diff(diff: &Diff) -> Text<'static> {
    render_diff_with_styles(diff, &DiffStyles::default())
}

/// Render a diff with custom styles
pub fn render_diff_with_styles(diff: &Diff, styles: &DiffStyles) -> Text<'static> {
    let mut output = Vec::new();

    // Header with file paths
    if let Some(old_path) = &diff.old_path {
        output.push(Line::from(vec![
            Span::styled("--- ", styles.header),
            Span::styled(old_path.clone(), styles.header),
        ]));
    }
    if let Some(new_path) = &diff.new_path {
        output.push(Line::from(vec![
            Span::styled("+++ ", styles.header),
            Span::styled(new_path.clone(), styles.header),
        ]));
    }

    // Stats line
    if diff.stats.total_changes() > 0 {
        let mut stats_spans = Vec::new();
        if diff.stats.added > 0 {
            stats_spans.push(Span::styled(format!("+{}", diff.stats.added), styles.added));
        }
        if diff.stats.removed > 0 {
            if !stats_spans.is_empty() {
                stats_spans.push(Span::raw(" "));
            }
            stats_spans.push(Span::styled(
                format!("-{}", diff.stats.removed),
                styles.removed,
            ));
        }
        output.push(Line::from(stats_spans));
        output.push(Line::from(""));
    }

    // Diff lines
    for line in &diff.lines {
        let (prefix, style) = match line.kind {
            DiffLineKind::Added => ("+", styles.added),
            DiffLineKind::Removed => ("-", styles.removed),
            DiffLineKind::Context => (" ", styles.context),
            DiffLineKind::HunkHeader => ("", styles.hunk_header),
            DiffLineKind::Header => ("", styles.header),
        };

        let mut spans = Vec::new();

        // Line numbers (optional)
        if line.kind != DiffLineKind::HunkHeader && line.kind != DiffLineKind::Header {
            let old_num = line
                .old_line_num
                .map(|n| format!("{:4}", n))
                .unwrap_or_else(|| "    ".to_string());
            let new_num = line
                .new_line_num
                .map(|n| format!("{:4}", n))
                .unwrap_or_else(|| "    ".to_string());

            spans.push(Span::styled(old_num, styles.line_number));
            spans.push(Span::styled(" ", styles.line_number));
            spans.push(Span::styled(new_num, styles.line_number));
            spans.push(Span::raw(" "));
        }

        spans.push(Span::styled(prefix.to_string(), style));
        spans.push(Span::styled(line.content.clone(), style));

        output.push(Line::from(spans));
    }

    Text::from(output)
}

/// Render a compact diff summary
pub fn render_diff_summary(diff: &Diff, path: &str) -> Line<'static> {
    let mut spans = Vec::new();

    // Shorten path if it starts with home dir
    let display_path = if let Some(home) = dirs::home_dir() {
        if let Ok(rel) = std::path::Path::new(path).strip_prefix(&home) {
            format!("~/{}", rel.display())
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    };

    spans.push(Span::styled(display_path, Style::default().fg(Color::Cyan)));
    spans.push(Span::raw(" "));

    if diff.stats.added > 0 {
        spans.push(Span::styled(
            format!("+{}", diff.stats.added),
            Style::default().fg(Color::Green),
        ));
    }
    if diff.stats.removed > 0 {
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            format!("-{}", diff.stats.removed),
            Style::default().fg(Color::Red),
        ));
    }

    Line::from(spans)
}

// Add dirs to Cargo.toml or use std::env::var("HOME")
mod dirs {
    use std::path::PathBuf;

    pub fn home_dir() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAPPED DIFF LINE RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/// Render a diff line with proper wrapping and gutter alignment.
///
/// Long lines are wrapped so that:
/// - First line: `123 +content...`
/// - Continuation: `      content continues...`
///
/// This keeps the gutter aligned and shows the +/- sign only on the first line.
pub fn render_wrapped_diff_line(
    line_number: usize,
    kind: DiffLineKind,
    text: &str,
    width: usize,
    line_number_width: usize,
    styles: &DiffStyles,
) -> Vec<Line<'static>> {
    let ln_str = line_number.to_string();
    let mut remaining_text: &str = text;

    // Reserve space for line number + space + sign
    let gutter_width = line_number_width.max(1);
    let prefix_cols = gutter_width + 1; // +1 for the sign column

    let (sign_char, line_style) = match kind {
        DiffLineKind::Added => ('+', styles.added),
        DiffLineKind::Removed => ('-', styles.removed),
        DiffLineKind::Context => (' ', styles.context),
        DiffLineKind::HunkHeader | DiffLineKind::Header => (' ', styles.hunk_header),
    };

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut first = true;

    loop {
        // Calculate available content width
        let available_cols = width.saturating_sub(prefix_cols + 1).max(1);

        // Split at character boundary
        let split_at = remaining_text
            .char_indices()
            .nth(available_cols)
            .map(|(i, _)| i)
            .unwrap_or(remaining_text.len());

        let (chunk, rest) = remaining_text.split_at(split_at);
        remaining_text = rest;

        if first {
            // Build gutter (right-aligned line number + space)
            let gutter = format!("{ln_str:>gutter_width$} ");
            // Content with sign
            let content = format!("{sign_char}{chunk}");
            lines.push(Line::from(vec![
                Span::styled(gutter, styles.line_number),
                Span::styled(content, line_style),
            ]));
            first = false;
        } else {
            // Continuation lines keep space for sign column
            let gutter = format!("{:gutter_width$}  ", "");
            lines.push(Line::from(vec![
                Span::styled(gutter, styles.line_number),
                Span::styled(chunk.to_string(), line_style),
            ]));
        }

        if remaining_text.is_empty() {
            break;
        }
    }

    lines
}

/// Calculate the width needed for line numbers.
pub fn calculate_line_number_width(max_line: usize) -> usize {
    if max_line == 0 {
        1
    } else {
        max_line.to_string().len()
    }
}

/// Render a diff with wrapping support.
///
/// This is like `render_diff` but wraps long lines properly.
pub fn render_diff_wrapped(diff: &Diff, width: usize) -> Text<'static> {
    render_diff_wrapped_with_styles(diff, width, &DiffStyles::default())
}

/// Render a diff with wrapping and custom styles.
pub fn render_diff_wrapped_with_styles(
    diff: &Diff,
    width: usize,
    styles: &DiffStyles,
) -> Text<'static> {
    let mut output = Vec::new();

    // Header with file paths
    if let Some(old_path) = &diff.old_path {
        output.push(Line::from(vec![
            Span::styled("--- ", styles.header),
            Span::styled(old_path.clone(), styles.header),
        ]));
    }
    if let Some(new_path) = &diff.new_path {
        output.push(Line::from(vec![
            Span::styled("+++ ", styles.header),
            Span::styled(new_path.clone(), styles.header),
        ]));
    }

    // Stats line
    if diff.stats.total_changes() > 0 {
        let mut stats_spans = Vec::new();
        if diff.stats.added > 0 {
            stats_spans.push(Span::styled(format!("+{}", diff.stats.added), styles.added));
        }
        if diff.stats.removed > 0 {
            if !stats_spans.is_empty() {
                stats_spans.push(Span::raw(" "));
            }
            stats_spans.push(Span::styled(
                format!("-{}", diff.stats.removed),
                styles.removed,
            ));
        }
        output.push(Line::from(stats_spans));
        output.push(Line::from(""));
    }

    // Calculate line number width
    let max_line = diff
        .lines
        .iter()
        .filter_map(|l| l.old_line_num.or(l.new_line_num))
        .max()
        .unwrap_or(1);
    let ln_width = calculate_line_number_width(max_line);

    // Diff lines with wrapping
    for line in &diff.lines {
        if line.kind == DiffLineKind::HunkHeader {
            output.push(Line::from(Span::styled(
                line.content.clone(),
                styles.hunk_header,
            )));
            continue;
        }
        if line.kind == DiffLineKind::Header {
            output.push(Line::from(Span::styled(
                line.content.clone(),
                styles.header,
            )));
            continue;
        }

        let line_num = line.new_line_num.or(line.old_line_num).unwrap_or(0);
        let wrapped =
            render_wrapped_diff_line(line_num, line.kind, &line.content, width, ln_width, styles);
        output.extend(wrapped);
    }

    Text::from(output)
}

/// Render a hunk separator line.
pub fn render_hunk_separator(line_number_width: usize, styles: &DiffStyles) -> Line<'static> {
    let spacer = format!("{:width$} ", "", width = line_number_width.max(1));
    Line::from(vec![
        Span::styled(spacer, styles.line_number),
        Span::styled("...", styles.context),
    ])
}

/// Render a line count summary like "(+5 -3)".
pub fn render_line_count_summary(added: usize, removed: usize) -> Vec<Span<'static>> {
    use ratatui::style::Stylize;
    vec![
        Span::raw("("),
        format!("+{added}").green(),
        Span::raw(" "),
        format!("-{removed}").red(),
        Span::raw(")"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_simple_diff() {
        let old = "line 1\nline 2\nline 3\n";
        let new = "line 1\nline 2 modified\nline 3\n";
        let diff = generate_diff(old, new, 2);

        assert!(diff.stats.added > 0 || diff.stats.removed > 0);
    }

    #[test]
    fn handles_additions() {
        let old = "line 1\n";
        let new = "line 1\nline 2\n";
        let diff = generate_diff(old, new, 2);

        assert_eq!(diff.stats.added, 1);
    }

    #[test]
    fn handles_deletions() {
        let old = "line 1\nline 2\n";
        let new = "line 1\n";
        let diff = generate_diff(old, new, 2);

        assert_eq!(diff.stats.removed, 1);
    }

    #[test]
    fn renders_diff() {
        let old = "hello\n";
        let new = "hello world\n";
        let diff = generate_diff(old, new, 2);
        let text = render_diff(&diff);

        assert!(!text.lines.is_empty());
    }
}

//! Diff rendering for file changes
//!
//! Uses the `similar` crate for generating and displaying diffs.

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

    let mut old_line = 1usize;
    let mut new_line = 1usize;

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
        }

        for op in group {
            for change in text_diff.iter_changes(&op) {
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

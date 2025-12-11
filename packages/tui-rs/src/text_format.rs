//! Text Formatting Utilities
//!
//! Provides utilities for formatting and truncating text for terminal display.
//! Ported from OpenAI Codex CLI (MIT licensed).
//!
//! # Features
//!
//! - Truncate text to fit within a given grapheme count
//! - Format JSON in compact single-line format with spacing
//! - Format and truncate tool results
//! - Center-truncate paths with ellipsis
//!
//! # Example
//!
//! ```rust
//! use composer_tui::text_format::{truncate_text, format_json_compact};
//!
//! let long_text = "This is a very long piece of text that needs truncation";
//! let truncated = truncate_text(long_text, 20);
//! assert_eq!(truncated, "This is a very lo...");
//!
//! // JSON is formatted with consistent spacing
//! let json = r#"[1,2,3]"#;
//! let formatted = format_json_compact(json);
//! assert_eq!(formatted, Some("[1, 2, 3]".to_string()));
//! ```

use unicode_width::UnicodeWidthStr;

/// Default max lines for truncating tool output
pub const TOOL_OUTPUT_MAX_LINES: usize = 5;

/// Truncate tool result to fit within height and width.
///
/// If the text is valid JSON, formats it compactly before truncating.
///
/// # Arguments
///
/// - `text`: The text to format/truncate
/// - `max_lines`: Maximum number of lines
/// - `line_width`: Width of each line
///
/// # Returns
///
/// Formatted and truncated string
pub fn format_and_truncate_tool_result(text: &str, max_lines: usize, line_width: usize) -> String {
    // Max graphemes = lines * width, minus a fudge factor
    let max_graphemes = (max_lines * line_width).saturating_sub(max_lines);

    if let Some(formatted_json) = format_json_compact(text) {
        truncate_text(&formatted_json, max_graphemes)
    } else {
        truncate_text(text, max_graphemes)
    }
}

/// Format JSON in compact single-line format with spaces.
///
/// Converts pretty-printed or minified JSON to a readable single-line format
/// by adding spaces after `:` and `,` (except before `}` or `]`).
///
/// # Example
///
/// Input: `{"a":"b","c":["d","e"]}`
/// Output: `{"a": "b", "c": ["d", "e"]}`
///
/// # Returns
///
/// `Some(formatted)` if input is valid JSON, `None` otherwise.
pub fn format_json_compact(text: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let json_pretty = serde_json::to_string_pretty(&json).unwrap_or_else(|_| json.to_string());

    let mut result = String::new();
    let mut chars = json_pretty.chars().peekable();
    let mut in_string = false;
    let mut escape_next = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if !escape_next => {
                in_string = !in_string;
                result.push(ch);
            }
            '\\' if in_string => {
                escape_next = !escape_next;
                result.push(ch);
            }
            '\n' | '\r' if !in_string => {
                // Skip newlines outside strings
            }
            ' ' | '\t' if !in_string => {
                // Add space after : or , but not before } or ]
                if let Some(&next_ch) = chars.peek() {
                    if let Some(last_ch) = result.chars().last() {
                        if (last_ch == ':' || last_ch == ',') && !matches!(next_ch, '}' | ']') {
                            result.push(' ');
                        }
                    }
                }
            }
            _ => {
                if escape_next && in_string {
                    escape_next = false;
                }
                result.push(ch);
            }
        }
    }

    Some(result)
}

/// Truncate text to a maximum number of characters.
///
/// Adds `...` suffix when truncated.
///
/// # Arguments
///
/// - `text`: The text to truncate
/// - `max_chars`: Maximum number of characters
///
/// # Returns
///
/// The truncated string, with `...` appended if truncated.
pub fn truncate_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();

    if chars.len() <= max_chars {
        return text.to_string();
    }

    if max_chars < 3 {
        // Too short for ellipsis
        return chars[..max_chars].iter().collect();
    }

    // Truncate to max - 3 and add "..."
    let truncated: String = chars[..max_chars - 3].iter().collect();
    format!("{}...", truncated)
}

/// Truncate text to a maximum number of lines.
///
/// # Arguments
///
/// - `text`: The text to truncate
/// - `max_lines`: Maximum number of lines
///
/// # Returns
///
/// Tuple of (truncated lines, number of omitted lines)
pub fn truncate_lines(text: &str, max_lines: usize) -> (Vec<&str>, usize) {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();

    if total <= max_lines {
        (lines, 0)
    } else {
        (lines[..max_lines].to_vec(), total - max_lines)
    }
}

/// Center-truncate a path, keeping leading and trailing segments.
///
/// This is a sophisticated path truncation algorithm ported from OpenAI Codex CLI.
/// It inserts a Unicode ellipsis in the middle when the path is too long, and
/// attempts to preserve as many segments as possible while fitting within the width.
///
/// If an individual segment cannot fit, it is front-truncated with an ellipsis.
///
/// # Arguments
///
/// - `path`: The path to truncate
/// - `max_width`: Maximum display width
///
/// # Returns
///
/// The truncated path string.
///
/// # Examples
///
/// ```rust
/// use composer_tui::text_format::center_truncate_path;
///
/// // Long path gets middle segments replaced with ellipsis
/// let path = "/home/user/projects/very/long/nested/path/file.rs";
/// let truncated = center_truncate_path(path, 30);
/// // Result: "/home/user/…/path/file.rs"
/// ```
pub fn center_truncate_path(path: &str, max_width: usize) -> String {
    use unicode_width::UnicodeWidthChar;

    if max_width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(path) <= max_width {
        return path.to_string();
    }

    let sep = std::path::MAIN_SEPARATOR;
    let has_leading_sep = path.starts_with(sep);
    let has_trailing_sep = path.ends_with(sep);
    let mut raw_segments: Vec<&str> = path.split(sep).collect();

    // Remove empty segments from leading/trailing separators
    if has_leading_sep && !raw_segments.is_empty() && raw_segments[0].is_empty() {
        raw_segments.remove(0);
    }
    if has_trailing_sep
        && !raw_segments.is_empty()
        && raw_segments.last().is_some_and(|last| last.is_empty())
    {
        raw_segments.pop();
    }

    if raw_segments.is_empty() {
        if has_leading_sep {
            let root = sep.to_string();
            if UnicodeWidthStr::width(root.as_str()) <= max_width {
                return root;
            }
        }
        return "…".to_string();
    }

    struct Segment<'a> {
        original: &'a str,
        text: String,
        truncatable: bool,
        is_suffix: bool,
    }

    let assemble = |leading: bool, segments: &[Segment<'_>]| -> String {
        let mut result = String::new();
        if leading {
            result.push(sep);
        }
        for segment in segments {
            if !result.is_empty() && !result.ends_with(sep) {
                result.push(sep);
            }
            result.push_str(segment.text.as_str());
        }
        result
    };

    let front_truncate = |original: &str, allowed_width: usize| -> String {
        if allowed_width == 0 {
            return String::new();
        }
        if UnicodeWidthStr::width(original) <= allowed_width {
            return original.to_string();
        }
        if allowed_width == 1 {
            return "…".to_string();
        }

        let mut kept: Vec<char> = Vec::new();
        let mut used_width = 1; // reserve space for leading ellipsis
        for ch in original.chars().rev() {
            let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used_width + ch_width > allowed_width {
                break;
            }
            used_width += ch_width;
            kept.push(ch);
        }
        kept.reverse();
        let mut truncated = String::from("…");
        for ch in kept {
            truncated.push(ch);
        }
        truncated
    };

    // Generate all combinations of (left_count, right_count) segments to try
    let mut combos: Vec<(usize, usize)> = Vec::new();
    let segment_count = raw_segments.len();
    for left in 1..=segment_count {
        let min_right = if left == segment_count { 0 } else { 1 };
        for right in min_right..=(segment_count - left) {
            combos.push((left, right));
        }
    }

    // Prioritize combinations that keep more suffix segments
    let desired_suffix = if segment_count > 1 {
        std::cmp::min(2, segment_count - 1)
    } else {
        0
    };
    let mut prioritized: Vec<(usize, usize)> = Vec::new();
    let mut fallback: Vec<(usize, usize)> = Vec::new();
    for combo in combos {
        if combo.1 >= desired_suffix {
            prioritized.push(combo);
        } else {
            fallback.push(combo);
        }
    }

    let sort_combos = |items: &mut Vec<(usize, usize)>| {
        items.sort_by(|(left_a, right_a), (left_b, right_b)| {
            left_b
                .cmp(left_a)
                .then_with(|| right_b.cmp(right_a))
                .then_with(|| (left_b + right_b).cmp(&(left_a + right_a)))
        });
    };
    sort_combos(&mut prioritized);
    sort_combos(&mut fallback);

    let fit_segments =
        |segments: &mut Vec<Segment<'_>>, allow_front_truncate: bool| -> Option<String> {
            loop {
                let candidate = assemble(has_leading_sep, segments);
                let width = UnicodeWidthStr::width(candidate.as_str());
                if width <= max_width {
                    return Some(candidate);
                }

                if !allow_front_truncate {
                    return None;
                }

                // Find truncatable segments, prioritizing suffix segments
                let mut indices: Vec<usize> = Vec::new();
                for (idx, seg) in segments.iter().enumerate().rev() {
                    if seg.truncatable && seg.is_suffix {
                        indices.push(idx);
                    }
                }
                for (idx, seg) in segments.iter().enumerate().rev() {
                    if seg.truncatable && !seg.is_suffix {
                        indices.push(idx);
                    }
                }

                if indices.is_empty() {
                    return None;
                }

                let mut changed = false;
                for idx in indices {
                    let original_width = UnicodeWidthStr::width(segments[idx].original);
                    if original_width <= max_width && segment_count > 2 {
                        continue;
                    }
                    let seg_width = UnicodeWidthStr::width(segments[idx].text.as_str());
                    let other_width = width.saturating_sub(seg_width);
                    let allowed_width = max_width.saturating_sub(other_width).max(1);
                    let new_text = front_truncate(segments[idx].original, allowed_width);
                    if new_text != segments[idx].text {
                        segments[idx].text = new_text;
                        changed = true;
                        break;
                    }
                }

                if !changed {
                    return None;
                }
            }
        };

    // Try each combination until one fits
    for (left_count, right_count) in prioritized.into_iter().chain(fallback.into_iter()) {
        let mut segments: Vec<Segment<'_>> = raw_segments[..left_count]
            .iter()
            .map(|seg| Segment {
                original: seg,
                text: (*seg).to_string(),
                truncatable: true,
                is_suffix: false,
            })
            .collect();

        let need_ellipsis = left_count + right_count < segment_count;
        if need_ellipsis {
            segments.push(Segment {
                original: "…",
                text: "…".to_string(),
                truncatable: false,
                is_suffix: false,
            });
        }

        if right_count > 0 {
            segments.extend(
                raw_segments[segment_count - right_count..]
                    .iter()
                    .map(|seg| Segment {
                        original: seg,
                        text: (*seg).to_string(),
                        truncatable: true,
                        is_suffix: true,
                    }),
            );
        }

        let allow_front_truncate = need_ellipsis || segment_count <= 2;
        if let Some(candidate) = fit_segments(&mut segments, allow_front_truncate) {
            return candidate;
        }
    }

    // Final fallback: front-truncate the entire path
    front_truncate(path, max_width)
}

/// Format a file path for display, relative to home if possible.
///
/// # Arguments
///
/// - `path`: The absolute path
///
/// # Returns
///
/// Path with home directory replaced by `~` if applicable.
pub fn relativize_to_home(path: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        if path.starts_with(home_str.as_ref()) {
            return format!("~{}", &path[home_str.len()..]);
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_text_no_truncation() {
        let text = "short";
        assert_eq!(truncate_text(text, 10), "short");
    }

    #[test]
    fn test_truncate_text_with_truncation() {
        let text = "this is a long piece of text";
        assert_eq!(truncate_text(text, 15), "this is a lo...");
    }

    #[test]
    fn test_truncate_text_exact_length() {
        let text = "exactly";
        assert_eq!(truncate_text(text, 7), "exactly");
    }

    #[test]
    fn test_truncate_text_very_short() {
        let text = "hello";
        assert_eq!(truncate_text(text, 2), "he");
    }

    #[test]
    fn test_format_json_compact_simple() {
        let json = r#"{"key": "value"}"#;
        let result = format_json_compact(json);
        assert!(result.is_some());
        assert!(result.unwrap().contains("\"key\": \"value\""));
    }

    #[test]
    fn test_format_json_compact_array() {
        let json = r#"{"arr":[1,2,3]}"#;
        let result = format_json_compact(json);
        assert!(result.is_some());
        let formatted = result.unwrap();
        assert!(formatted.contains("[1, 2, 3]"));
    }

    #[test]
    fn test_format_json_compact_invalid() {
        let not_json = "not valid json";
        assert!(format_json_compact(not_json).is_none());
    }

    #[test]
    fn test_truncate_lines_no_truncation() {
        let text = "line1\nline2\nline3";
        let (lines, omitted) = truncate_lines(text, 5);
        assert_eq!(lines.len(), 3);
        assert_eq!(omitted, 0);
    }

    #[test]
    fn test_truncate_lines_with_truncation() {
        let text = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
        let (lines, omitted) = truncate_lines(text, 5);
        assert_eq!(lines.len(), 5);
        assert_eq!(omitted, 5);
    }

    #[test]
    fn test_center_truncate_path_short() {
        let path = "/usr/bin";
        assert_eq!(center_truncate_path(path, 20), "/usr/bin");
    }

    #[test]
    fn test_center_truncate_path_long() {
        let sep = std::path::MAIN_SEPARATOR;
        let path = format!("{sep}home{sep}user{sep}very{sep}long{sep}path{sep}to{sep}some{sep}file.txt");
        let result = center_truncate_path(&path, 30);
        // Should contain ellipsis and fit within width
        assert!(result.contains('…'));
        assert!(UnicodeWidthStr::width(result.as_str()) <= 30);
    }

    #[test]
    fn test_center_truncate_keeps_suffix_segments() {
        let sep = std::path::MAIN_SEPARATOR;
        let path = format!("~{sep}hello{sep}the{sep}fox{sep}is{sep}very{sep}fast");
        let truncated = center_truncate_path(&path, 24);
        // Should preserve last two segments (very/fast)
        assert!(truncated.ends_with(&format!("{sep}fast")));
    }

    #[test]
    fn test_center_truncate_handles_long_segment() {
        let sep = std::path::MAIN_SEPARATOR;
        let path = format!("~{sep}supercalifragilisticexpialidocious");
        let truncated = center_truncate_path(&path, 18);
        // Should front-truncate the long segment with ellipsis
        assert!(truncated.contains('…'));
        assert!(UnicodeWidthStr::width(truncated.as_str()) <= 18);
    }

    #[test]
    fn test_relativize_to_home() {
        // This test is environment-dependent
        let home = dirs::home_dir();
        if let Some(home_path) = home {
            let test_path = format!("{}/test/file.txt", home_path.to_string_lossy());
            let result = relativize_to_home(&test_path);
            assert!(result.starts_with("~/"));
        }
    }

    #[test]
    fn test_format_and_truncate_tool_result() {
        let long_text = "a".repeat(1000);
        let result = format_and_truncate_tool_result(&long_text, 5, 80);
        assert!(result.len() < long_text.len());
        assert!(result.ends_with("..."));
    }
}

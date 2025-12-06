//! Unicode-aware text wrapping
//!
//! Handles proper wrapping of text with wide characters, emojis, and styled content.

use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

/// Wrap a single line of text to fit within a given width
pub fn wrap_line(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![];
    }

    let mut result = Vec::new();
    let mut current_line = String::new();
    let mut current_width = 0usize;

    for word in text.split_inclusive(char::is_whitespace) {
        let word_width = word.width();

        if current_width + word_width > width && !current_line.is_empty() {
            // Start new line
            result.push(current_line.trim_end().to_string());
            current_line = String::new();

            // Skip leading whitespace on new line
            let trimmed = word.trim_start();
            current_line.push_str(trimmed);
            current_width = trimmed.width();
        } else {
            current_line.push_str(word);
            current_width += word_width;
        }
    }

    if !current_line.is_empty() {
        result.push(current_line.trim_end().to_string());
    }

    if result.is_empty() {
        result.push(String::new());
    }

    result
}

/// Wrap styled spans to fit within a given width
pub fn wrap_spans(spans: &[Span<'_>], width: usize) -> Vec<Line<'static>> {
    if width == 0 {
        return vec![];
    }

    let mut result: Vec<Line<'static>> = Vec::new();
    let mut current_spans: Vec<Span<'static>> = Vec::new();
    let mut current_width = 0usize;

    for span in spans {
        let text = span.content.as_ref();
        let style = span.style;

        // Try to add the span
        let span_width = text.width();

        if current_width + span_width <= width {
            // Fits on current line
            current_spans.push(Span::styled(text.to_string(), style));
            current_width += span_width;
        } else {
            // Need to wrap
            let mut remaining = text;

            while !remaining.is_empty() {
                let available = width.saturating_sub(current_width);

                if available == 0 {
                    // Start new line
                    if !current_spans.is_empty() {
                        result.push(Line::from(std::mem::take(&mut current_spans)));
                    }
                    current_width = 0;
                    continue;
                }

                // Find break point
                let (fit, rest) = break_at_width(remaining, available);

                if !fit.is_empty() {
                    current_spans.push(Span::styled(fit.to_string(), style));
                    current_width += fit.width();
                }

                remaining = rest;

                if !remaining.is_empty() {
                    // Start new line
                    result.push(Line::from(std::mem::take(&mut current_spans)));
                    current_width = 0;
                }
            }
        }
    }

    if !current_spans.is_empty() {
        result.push(Line::from(current_spans));
    }

    if result.is_empty() {
        result.push(Line::from(""));
    }

    result
}

/// Break text at a given width, respecting grapheme boundaries
fn break_at_width(text: &str, max_width: usize) -> (&str, &str) {
    let mut width = 0usize;
    let mut break_idx = 0usize;
    let mut last_space_idx = None;

    for (idx, ch) in text.char_indices() {
        let ch_width = ch.width().unwrap_or(0);

        if width + ch_width > max_width {
            // Prefer breaking at last space
            if let Some(space_idx) = last_space_idx {
                return (&text[..space_idx], text[space_idx..].trim_start());
            }
            // If we haven't matched anything yet and the first char is too wide,
            // force include it to prevent infinite loop
            if break_idx == 0 {
                return (&text[..idx + ch.len_utf8()], &text[idx + ch.len_utf8()..]);
            }
            // Otherwise break here
            return (&text[..break_idx], &text[break_idx..]);
        }

        if ch.is_whitespace() {
            last_space_idx = Some(idx + ch.len_utf8());
        }

        width += ch_width;
        break_idx = idx + ch.len_utf8();
    }

    // Entire text fits
    (text, "")
}

/// Calculate the visible width of text (handling wide chars and emojis)
pub fn visible_width(text: &str) -> usize {
    text.width()
}

/// Truncate text to a maximum width, adding ellipsis if truncated
pub fn truncate(text: &str, max_width: usize) -> String {
    if max_width < 3 {
        return ".".repeat(max_width);
    }

    let text_width = text.width();
    if text_width <= max_width {
        return text.to_string();
    }

    let mut result = String::new();
    let mut width = 0usize;
    let target = max_width - 3; // Leave room for "..."

    for ch in text.chars() {
        let ch_width = ch.width().unwrap_or(0);
        if width + ch_width > target {
            break;
        }
        result.push(ch);
        width += ch_width;
    }

    result.push_str("...");
    result
}

/// Truncate styled spans to a maximum width
pub fn truncate_spans(spans: &[Span<'_>], max_width: usize) -> Vec<Span<'static>> {
    if max_width < 3 {
        return vec![Span::raw(".".repeat(max_width))];
    }

    // First, check if content fits without truncation
    let total_width: usize = spans.iter().map(|s| s.content.width()).sum();
    if total_width <= max_width {
        // Content fits, return as-is
        return spans
            .iter()
            .map(|s| Span::styled(s.content.to_string(), s.style))
            .collect();
    }

    // Content needs truncation - reserve space for ellipsis
    let mut result = Vec::new();
    let mut remaining_width = max_width - 3;
    let mut truncated = false;

    for span in spans {
        let text = span.content.as_ref();
        let text_width = text.width();

        if remaining_width == 0 {
            truncated = true;
            break;
        }

        if text_width <= remaining_width {
            result.push(Span::styled(text.to_string(), span.style));
            remaining_width -= text_width;
        } else {
            // Truncate this span
            let mut partial = String::new();
            for ch in text.chars() {
                let ch_width = ch.width().unwrap_or(0);
                if ch_width > remaining_width {
                    break;
                }
                partial.push(ch);
                remaining_width -= ch_width;
            }
            if !partial.is_empty() {
                result.push(Span::styled(partial, span.style));
            }
            truncated = true;
            break;
        }
    }

    if truncated {
        result.push(Span::raw("..."));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_simple() {
        let result = wrap_line("hello world", 5);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn wrap_fits() {
        let result = wrap_line("hello", 10);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "hello");
    }

    #[test]
    fn truncate_short() {
        assert_eq!(truncate("hi", 10), "hi");
    }

    #[test]
    fn truncate_long() {
        let result = truncate("hello world", 8);
        assert!(result.ends_with("..."));
        assert!(result.width() <= 8);
    }

    #[test]
    fn visible_width_ascii() {
        assert_eq!(visible_width("hello"), 5);
    }

    #[test]
    fn visible_width_wide_chars() {
        // CJK characters are typically 2 cells wide
        assert_eq!(visible_width("日本"), 4);
    }
}

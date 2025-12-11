//! OSC-8 Hyperlink Support
//!
//! Terminal hyperlinks using the OSC 8 escape sequence.
//! Works in modern terminals like iTerm2, Kitty, WezTerm, etc.
//!
//! Ported from Composer TypeScript TUI.

use ratatui::style::Style;
use ratatui::text::Span;

// ─────────────────────────────────────────────────────────────────────────────
// OSC-8 HYPERLINK FORMAT
// ─────────────────────────────────────────────────────────────────────────────

/// OSC 8 start sequence: `ESC ] 8 ; ;`
const OSC8_START: &str = "\x1b]8;;";

/// OSC 8 terminator: `BEL` (0x07)
const OSC8_TERM: &str = "\x07";

/// OSC 8 end sequence (empty URL to close link)
const OSC8_END: &str = "\x1b]8;;\x07";

// ─────────────────────────────────────────────────────────────────────────────
// HYPERLINK FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/// Format a clickable hyperlink using OSC 8 escape sequences.
///
/// # Arguments
/// * `url` - The URL to link to
/// * `label` - Optional display text (defaults to URL)
///
/// # Example
/// ```
/// use composer_tui::hyperlink::format_link;
///
/// // With custom label
/// let link = format_link("https://example.com", Some("Example"));
/// // Renders as clickable "Example" in supported terminals
///
/// // URL as label
/// let link = format_link("https://example.com", None);
/// ```
pub fn format_link(url: &str, label: Option<&str>) -> String {
    let text = label.unwrap_or(url);
    format!("{OSC8_START}{url}{OSC8_TERM}{text}{OSC8_END}")
}

/// Format a hyperlink with fallback for non-TTY output.
///
/// Returns `label (url)` format when not in a terminal.
pub fn format_link_with_fallback(url: &str, label: Option<&str>, is_tty: bool) -> String {
    let text = label.unwrap_or(url);
    if !is_tty {
        if label.is_some() {
            return format!("{text} ({url})");
        }
        return url.to_string();
    }
    format_link(url, label)
}

/// Create the OSC 8 start sequence for a URL.
///
/// Use this for manual link construction when you need
/// to apply styling to the link text.
pub fn link_start(url: &str) -> String {
    format!("{OSC8_START}{url}{OSC8_TERM}")
}

/// The OSC 8 end sequence to close a hyperlink.
pub fn link_end() -> &'static str {
    OSC8_END
}

/// Wrap text in hyperlink sequences.
///
/// Lower-level function for when you need more control.
pub fn wrap_in_link(url: &str, text: &str) -> String {
    format!("{}{}{}", link_start(url), text, OSC8_END)
}

// ─────────────────────────────────────────────────────────────────────────────
// RATATUI INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

/// Create a Span with hyperlink.
///
/// Note: ratatui's hyperlink support depends on the terminal.
/// This embeds the OSC 8 sequences in the content.
pub fn link_span(url: &str, label: &str, style: Style) -> Span<'static> {
    Span::styled(format_link(url, Some(label)), style)
}

/// Create a Span with hyperlink using URL as label.
pub fn url_span(url: &str, style: Style) -> Span<'static> {
    Span::styled(format_link(url, None), style)
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/// Check if a string contains OSC 8 hyperlink sequences.
pub fn contains_hyperlink(s: &str) -> bool {
    s.contains(OSC8_START)
}

/// Strip OSC 8 hyperlink sequences from a string.
///
/// Returns the visible text without link formatting.
pub fn strip_hyperlinks(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Check for OSC 8 sequence
            if chars.peek() == Some(&']') {
                chars.next(); // consume ']'
                if chars.peek() == Some(&'8') {
                    chars.next(); // consume '8'
                    if chars.peek() == Some(&';') {
                        chars.next(); // consume ';'
                        if chars.peek() == Some(&';') {
                            chars.next(); // consume ';'
                            // Skip until BEL (0x07) or ST (ESC \)
                            while let Some(ch) = chars.next() {
                                if ch == '\x07' {
                                    break;
                                }
                                if ch == '\x1b' && chars.peek() == Some(&'\\') {
                                    chars.next();
                                    break;
                                }
                            }
                            continue;
                        }
                    }
                }
            }
            // Not a hyperlink sequence, keep the escape
            result.push(c);
        } else {
            result.push(c);
        }
    }

    result
}

/// Extract URLs from text containing OSC 8 hyperlinks.
pub fn extract_urls(s: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut remaining = s;

    while let Some(start) = remaining.find(OSC8_START) {
        let after_start = &remaining[start + OSC8_START.len()..];
        if let Some(end) = after_start.find(OSC8_TERM) {
            let url = &after_start[..end];
            if !url.is_empty() {
                urls.push(url.to_string());
            }
            remaining = &after_start[end + OSC8_TERM.len()..];
        } else {
            break;
        }
    }

    urls
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_link_with_label() {
        let link = format_link("https://example.com", Some("Example"));
        assert!(link.contains("https://example.com"));
        assert!(link.contains("Example"));
        assert!(link.starts_with(OSC8_START));
        assert!(link.ends_with(OSC8_END));
    }

    #[test]
    fn format_link_url_as_label() {
        let link = format_link("https://example.com", None);
        // URL appears twice: once in the link, once as text
        assert_eq!(link.matches("https://example.com").count(), 2);
    }

    #[test]
    fn format_link_fallback_non_tty() {
        let link = format_link_with_fallback("https://example.com", Some("Example"), false);
        assert_eq!(link, "Example (https://example.com)");
    }

    #[test]
    fn format_link_fallback_tty() {
        let link = format_link_with_fallback("https://example.com", Some("Example"), true);
        assert!(link.contains(OSC8_START));
    }

    #[test]
    fn contains_hyperlink_detection() {
        let with_link = format_link("https://example.com", Some("test"));
        let without_link = "just plain text";

        assert!(contains_hyperlink(&with_link));
        assert!(!contains_hyperlink(without_link));
    }

    #[test]
    fn strip_hyperlinks_removes_links() {
        let link = format_link("https://example.com", Some("Example"));
        let stripped = strip_hyperlinks(&link);
        assert_eq!(stripped, "Example");
        assert!(!stripped.contains('\x1b'));
    }

    #[test]
    fn strip_hyperlinks_preserves_plain_text() {
        let text = "Hello, world!";
        assert_eq!(strip_hyperlinks(text), text);
    }

    #[test]
    fn extract_urls_finds_all() {
        let text = format!(
            "Check {} and {}",
            format_link("https://a.com", Some("A")),
            format_link("https://b.com", Some("B"))
        );
        let urls = extract_urls(&text);
        assert_eq!(urls, vec!["https://a.com", "https://b.com"]);
    }

    #[test]
    fn wrap_in_link_works() {
        let wrapped = wrap_in_link("https://example.com", "Click me");
        assert!(wrapped.contains("https://example.com"));
        assert!(wrapped.contains("Click me"));
    }
}

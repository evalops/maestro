//! ANSI Escape Code Handling
//!
//! Converts ANSI-escaped strings to ratatui styled text.
//! Handles terminal output that contains color codes, bold, etc.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::borrow::Cow;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

// ─────────────────────────────────────────────────────────────────────────────
// TAB EXPANSION
// ─────────────────────────────────────────────────────────────────────────────

/// Expand tabs to spaces.
///
/// Tabs can interact poorly with left-gutter prefixes in TUI and CLI
/// transcript views. Replacing tabs with spaces avoids odd visual artifacts.
#[must_use]
pub fn expand_tabs(s: &str) -> Cow<'_, str> {
    if s.contains('\t') {
        // Replace each tab with 4 spaces
        Cow::Owned(s.replace('\t', "    "))
    } else {
        Cow::Borrowed(s)
    }
}

/// Expand tabs with a custom width.
#[must_use]
pub fn expand_tabs_width(s: &str, tab_width: usize) -> Cow<'_, str> {
    if s.contains('\t') {
        Cow::Owned(s.replace('\t', &" ".repeat(tab_width)))
    } else {
        Cow::Borrowed(s)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANSI PARSING
// ─────────────────────────────────────────────────────────────────────────────

/// Parse ANSI-escaped text into ratatui Text.
///
/// This handles common ANSI escape sequences for:
/// - Colors (foreground and background)
/// - Bold, dim, italic, underline
/// - Reset codes
#[must_use]
pub fn parse_ansi(s: &str) -> Text<'static> {
    let s = expand_tabs(s);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut current_style = Style::default();

    for line in s.lines() {
        let spans = parse_ansi_line(line, &mut current_style);
        lines.push(Line::from(spans));
    }

    // Handle empty input
    if lines.is_empty() {
        lines.push(Line::from(""));
    }

    Text::from(lines)
}

/// Parse a single line with ANSI codes.
pub fn parse_ansi_line(s: &str, style: &mut Style) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut current_text = String::new();
    let mut chars = s.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Flush current text
            if !current_text.is_empty() {
                spans.push(Span::styled(std::mem::take(&mut current_text), *style));
            }

            // Parse escape sequence
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                let mut params = String::new();

                // Collect parameters until we hit a letter
                while let Some(&ch) = chars.peek() {
                    if ch.is_ascii_alphabetic() {
                        break;
                    }
                    params.push(chars.next().unwrap());
                }

                // Get the command character
                if let Some(cmd) = chars.next() {
                    if cmd == 'm' {
                        // SGR (Select Graphic Rendition)
                        apply_sgr(&params, style);
                    }
                    // Ignore other escape sequences
                }
            }
        } else {
            current_text.push(ch);
        }
    }

    // Flush remaining text
    if !current_text.is_empty() {
        spans.push(Span::styled(current_text, *style));
    }

    spans
}

/// Apply SGR (Select Graphic Rendition) parameters to a style.
fn apply_sgr(params: &str, style: &mut Style) {
    if params.is_empty() {
        *style = Style::default();
        return;
    }

    let codes: Vec<u8> = params.split(';').filter_map(|s| s.parse().ok()).collect();

    let mut i = 0;
    while i < codes.len() {
        match codes[i] {
            0 => *style = Style::default(),
            1 => *style = style.add_modifier(Modifier::BOLD),
            2 => *style = style.add_modifier(Modifier::DIM),
            3 => *style = style.add_modifier(Modifier::ITALIC),
            4 => *style = style.add_modifier(Modifier::UNDERLINED),
            7 => *style = style.add_modifier(Modifier::REVERSED),
            9 => *style = style.add_modifier(Modifier::CROSSED_OUT),
            22 => *style = style.remove_modifier(Modifier::BOLD | Modifier::DIM),
            23 => *style = style.remove_modifier(Modifier::ITALIC),
            24 => *style = style.remove_modifier(Modifier::UNDERLINED),
            27 => *style = style.remove_modifier(Modifier::REVERSED),
            29 => *style = style.remove_modifier(Modifier::CROSSED_OUT),

            // Standard foreground colors (30-37)
            30 => *style = style.fg(Color::Black),
            31 => *style = style.fg(Color::Red),
            32 => *style = style.fg(Color::Green),
            33 => *style = style.fg(Color::Yellow),
            34 => *style = style.fg(Color::Blue),
            35 => *style = style.fg(Color::Magenta),
            36 => *style = style.fg(Color::Cyan),
            37 => *style = style.fg(Color::White),
            39 => *style = style.fg(Color::Reset),

            // Standard background colors (40-47)
            40 => *style = style.bg(Color::Black),
            41 => *style = style.bg(Color::Red),
            42 => *style = style.bg(Color::Green),
            43 => *style = style.bg(Color::Yellow),
            44 => *style = style.bg(Color::Blue),
            45 => *style = style.bg(Color::Magenta),
            46 => *style = style.bg(Color::Cyan),
            47 => *style = style.bg(Color::White),
            49 => *style = style.bg(Color::Reset),

            // Bright foreground colors (90-97)
            90 => *style = style.fg(Color::DarkGray),
            91 => *style = style.fg(Color::LightRed),
            92 => *style = style.fg(Color::LightGreen),
            93 => *style = style.fg(Color::LightYellow),
            94 => *style = style.fg(Color::LightBlue),
            95 => *style = style.fg(Color::LightMagenta),
            96 => *style = style.fg(Color::LightCyan),
            97 => *style = style.fg(Color::Gray),

            // Bright background colors (100-107)
            100 => *style = style.bg(Color::DarkGray),
            101 => *style = style.bg(Color::LightRed),
            102 => *style = style.bg(Color::LightGreen),
            103 => *style = style.bg(Color::LightYellow),
            104 => *style = style.bg(Color::LightBlue),
            105 => *style = style.bg(Color::LightMagenta),
            106 => *style = style.bg(Color::LightCyan),
            107 => *style = style.bg(Color::Gray),

            // 256-color and true color
            38 => {
                if i + 2 < codes.len() && codes[i + 1] == 5 {
                    // 256-color foreground: 38;5;N
                    *style = style.fg(Color::Indexed(codes[i + 2]));
                    i += 2;
                } else if i + 4 < codes.len() && codes[i + 1] == 2 {
                    // True color foreground: 38;2;R;G;B
                    *style = style.fg(Color::Rgb(codes[i + 2], codes[i + 3], codes[i + 4]));
                    i += 4;
                }
            }
            48 => {
                if i + 2 < codes.len() && codes[i + 1] == 5 {
                    // 256-color background: 48;5;N
                    *style = style.bg(Color::Indexed(codes[i + 2]));
                    i += 2;
                } else if i + 4 < codes.len() && codes[i + 1] == 2 {
                    // True color background: 48;2;R;G;B
                    *style = style.bg(Color::Rgb(codes[i + 2], codes[i + 3], codes[i + 4]));
                    i += 4;
                }
            }

            _ => {} // Ignore unknown codes
        }
        i += 1;
    }
}

/// Strip ANSI escape codes from a string.
#[must_use]
pub fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_escape = false;

    for ch in s.chars() {
        if in_escape {
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
        } else if ch == '\x1b' {
            in_escape = true;
        } else {
            result.push(ch);
        }
    }

    result
}

/// Get the display width of a string, ignoring ANSI codes.
#[must_use]
pub fn ansi_display_width(s: &str) -> usize {
    use unicode_width::UnicodeWidthStr;
    strip_ansi(s).width()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tabs_replaces() {
        assert_eq!(expand_tabs("a\tb"), "a    b");
        assert_eq!(expand_tabs("no tabs"), "no tabs");
    }

    #[test]
    fn parse_simple_text() {
        let text = parse_ansi("hello world");
        assert_eq!(text.lines.len(), 1);
    }

    #[test]
    fn parse_bold_text() {
        let text = parse_ansi("\x1b[1mbold\x1b[0m");
        assert_eq!(text.lines.len(), 1);
        let line = &text.lines[0];
        assert!(!line.spans.is_empty());
    }

    #[test]
    fn parse_colored_text() {
        let text = parse_ansi("\x1b[31mred\x1b[0m");
        let line = &text.lines[0];
        assert!(!line.spans.is_empty());
        // First span should have red foreground
        assert_eq!(line.spans[0].style.fg, Some(Color::Red));
    }

    #[test]
    fn parse_256_color() {
        let text = parse_ansi("\x1b[38;5;196mred\x1b[0m");
        let line = &text.lines[0];
        assert_eq!(line.spans[0].style.fg, Some(Color::Indexed(196)));
    }

    #[test]
    fn parse_true_color() {
        let text = parse_ansi("\x1b[38;2;255;128;0morange\x1b[0m");
        let line = &text.lines[0];
        assert_eq!(line.spans[0].style.fg, Some(Color::Rgb(255, 128, 0)));
    }

    #[test]
    fn strip_ansi_removes_codes() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("plain text"), "plain text");
    }

    #[test]
    fn ansi_display_width_ignores_codes() {
        assert_eq!(ansi_display_width("\x1b[31mhello\x1b[0m"), 5);
    }

    #[test]
    fn parse_multiline() {
        let text = parse_ansi("line1\nline2\nline3");
        assert_eq!(text.lines.len(), 3);
    }
}

//! ANSI Code Tracker with Surgical Resets
//!
//! Provides stateful tracking of ANSI SGR codes with the ability to:
//! - Track active styles (bold, dim, italic, underline, colors, etc.)
//! - Generate surgical resets (e.g., disable underline only, preserving colors)
//! - Reapply tracked styles after line breaks
//!
//! This is critical for preventing visual artifacts like underlines bleeding
//! into padding when wrapping text.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

// ─────────────────────────────────────────────────────────────────────────────
// ANSI CODE TRACKER
// ─────────────────────────────────────────────────────────────────────────────

/// Tracks active ANSI SGR (Select Graphic Rendition) codes.
///
/// This allows for surgical resets and style reapplication across line breaks.
#[derive(Debug, Clone, Default)]
pub struct AnsiCodeTracker {
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    blink: bool,
    inverse: bool,
    hidden: bool,
    strikethrough: bool,
    /// Foreground color code (e.g., "31" for red, "38;5;196" for 256-color, "38;2;255;0;0" for RGB)
    fg_color: Option<String>,
    /// Background color code (e.g., "41" for red bg, "48;5;196" for 256-color, "48;2;255;0;0" for RGB)
    bg_color: Option<String>,
}

impl AnsiCodeTracker {
    /// Create a new tracker with no active styles.
    pub fn new() -> Self {
        Self::default()
    }

    /// Process an ANSI escape sequence and update tracked state.
    ///
    /// Expects a full escape sequence like `\x1b[1;31m`.
    pub fn process(&mut self, ansi_code: &str) {
        // Extract parameters from ESC[...m
        let params = if ansi_code.starts_with("\x1b[") && ansi_code.ends_with('m') {
            &ansi_code[2..ansi_code.len() - 1]
        } else {
            return;
        };

        if params.is_empty() {
            self.reset();
            return;
        }

        let parts: Vec<&str> = params.split(';').collect();
        let mut i = 0;

        while i < parts.len() {
            let code: u8 = match parts[i].parse() {
                Ok(c) => c,
                Err(_) => {
                    i += 1;
                    continue;
                }
            };

            match code {
                0 => self.reset(),
                1 => self.bold = true,
                2 => self.dim = true,
                3 => self.italic = true,
                4 => self.underline = true,
                5 => self.blink = true,
                7 => self.inverse = true,
                8 => self.hidden = true,
                9 => self.strikethrough = true,

                // Reset modifiers
                22 => {
                    self.bold = false;
                    self.dim = false;
                }
                23 => self.italic = false,
                24 => self.underline = false,
                25 => self.blink = false,
                27 => self.inverse = false,
                28 => self.hidden = false,
                29 => self.strikethrough = false,

                // Standard foreground colors (30-37)
                30..=37 => self.fg_color = Some(code.to_string()),
                39 => self.fg_color = None,

                // Standard background colors (40-47)
                40..=47 => self.bg_color = Some(code.to_string()),
                49 => self.bg_color = None,

                // Bright foreground colors (90-97)
                90..=97 => self.fg_color = Some(code.to_string()),

                // Bright background colors (100-107)
                100..=107 => self.bg_color = Some(code.to_string()),

                // 256-color and true color
                38 => {
                    if i + 2 < parts.len() && parts[i + 1] == "5" {
                        // 256-color: 38;5;N
                        self.fg_color = Some(format!("38;5;{}", parts[i + 2]));
                        i += 2;
                    } else if i + 4 < parts.len() && parts[i + 1] == "2" {
                        // True color: 38;2;R;G;B
                        self.fg_color = Some(format!(
                            "38;2;{};{};{}",
                            parts[i + 2],
                            parts[i + 3],
                            parts[i + 4]
                        ));
                        i += 4;
                    }
                }
                48 => {
                    if i + 2 < parts.len() && parts[i + 1] == "5" {
                        // 256-color: 48;5;N
                        self.bg_color = Some(format!("48;5;{}", parts[i + 2]));
                        i += 2;
                    } else if i + 4 < parts.len() && parts[i + 1] == "2" {
                        // True color: 48;2;R;G;B
                        self.bg_color = Some(format!(
                            "48;2;{};{};{}",
                            parts[i + 2],
                            parts[i + 3],
                            parts[i + 4]
                        ));
                        i += 4;
                    }
                }

                _ => {}
            }

            i += 1;
        }
    }

    /// Reset all tracked styles to default.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Check if any styles are currently active.
    pub fn has_active_codes(&self) -> bool {
        self.bold
            || self.dim
            || self.italic
            || self.underline
            || self.blink
            || self.inverse
            || self.hidden
            || self.strikethrough
            || self.fg_color.is_some()
            || self.bg_color.is_some()
    }

    /// Get a surgical reset code for line endings.
    ///
    /// Only resets styles that cause visual artifacts (like underline bleeding
    /// into padding). Preserves colors and other styles.
    pub fn get_line_end_reset(&self) -> &'static str {
        if self.underline {
            "\x1b[24m" // Underline off only
        } else {
            ""
        }
    }

    /// Get ANSI codes to reapply all currently active styles.
    ///
    /// Use this after a line break to restore styles.
    pub fn get_active_codes(&self) -> String {
        if !self.has_active_codes() {
            return String::new();
        }

        let mut codes = Vec::new();

        if self.bold {
            codes.push("1".to_string());
        }
        if self.dim {
            codes.push("2".to_string());
        }
        if self.italic {
            codes.push("3".to_string());
        }
        if self.underline {
            codes.push("4".to_string());
        }
        if self.blink {
            codes.push("5".to_string());
        }
        if self.inverse {
            codes.push("7".to_string());
        }
        if self.hidden {
            codes.push("8".to_string());
        }
        if self.strikethrough {
            codes.push("9".to_string());
        }

        if let Some(ref fg) = self.fg_color {
            codes.push(fg.clone());
        }
        if let Some(ref bg) = self.bg_color {
            codes.push(bg.clone());
        }

        if codes.is_empty() {
            String::new()
        } else {
            format!("\x1b[{}m", codes.join(";"))
        }
    }

    /// Get a full reset code (\x1b[0m).
    pub fn get_full_reset(&self) -> &'static str {
        if self.has_active_codes() {
            "\x1b[0m"
        } else {
            ""
        }
    }

    // Accessor methods for checking individual styles

    pub fn is_bold(&self) -> bool {
        self.bold
    }

    pub fn is_dim(&self) -> bool {
        self.dim
    }

    pub fn is_italic(&self) -> bool {
        self.italic
    }

    pub fn is_underline(&self) -> bool {
        self.underline
    }

    pub fn is_inverse(&self) -> bool {
        self.inverse
    }

    pub fn fg_color(&self) -> Option<&str> {
        self.fg_color.as_deref()
    }

    pub fn bg_color(&self) -> Option<&str> {
        self.bg_color.as_deref()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANSI-AWARE LINE WRAPPING
// ─────────────────────────────────────────────────────────────────────────────

/// Segment types in ANSI-formatted text.
#[derive(Debug, Clone, PartialEq)]
pub enum AnsiSegment {
    /// An ANSI escape sequence.
    Escape(String),
    /// A text segment (one or more characters).
    Text(String),
}

/// Parse a line into ANSI escape sequences and text segments.
pub fn parse_ansi_segments(line: &str) -> Vec<AnsiSegment> {
    let mut segments = Vec::new();
    let mut chars = line.chars().peekable();
    let mut current_text = String::new();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Flush current text
            if !current_text.is_empty() {
                segments.push(AnsiSegment::Text(std::mem::take(&mut current_text)));
            }

            // Parse escape sequence
            let mut escape = String::from('\x1b');
            if chars.peek() == Some(&'[') {
                escape.push(chars.next().unwrap());

                // Collect until we hit a letter
                while let Some(&c) = chars.peek() {
                    escape.push(chars.next().unwrap());
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            segments.push(AnsiSegment::Escape(escape));
        } else {
            current_text.push(ch);
        }
    }

    // Flush remaining text
    if !current_text.is_empty() {
        segments.push(AnsiSegment::Text(current_text));
    }

    segments
}

/// Wrap a line containing ANSI codes to a given width.
///
/// Uses the tracker to:
/// 1. Apply surgical resets at line ends (prevents underline bleeding)
/// 2. Reapply styles at the start of continuation lines
///
/// Returns wrapped lines as raw strings (with ANSI codes).
pub fn wrap_ansi_line(line: &str, width: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthStr;

    if width == 0 {
        return vec![String::new()];
    }

    let segments = parse_ansi_segments(line);
    let mut tracker = AnsiCodeTracker::new();
    let mut wrapped = Vec::new();
    let mut current_line = String::new();
    let mut current_width = 0;

    for segment in segments {
        match segment {
            AnsiSegment::Escape(code) => {
                tracker.process(&code);
                current_line.push_str(&code);
            }
            AnsiSegment::Text(text) => {
                for ch in text.chars() {
                    let ch_width = ch.to_string().width();

                    if current_width + ch_width > width {
                        // Need to wrap
                        let line_end_reset = tracker.get_line_end_reset();
                        if !line_end_reset.is_empty() {
                            current_line.push_str(line_end_reset);
                        }

                        // Add full reset if we have active codes
                        if tracker.has_active_codes() {
                            current_line.push_str("\x1b[0m");
                        }

                        wrapped.push(std::mem::take(&mut current_line));

                        // Start new line with reapplied styles
                        current_line = tracker.get_active_codes();
                        current_width = 0;
                    }

                    current_line.push(ch);
                    current_width += ch_width;
                }
            }
        }
    }

    // Push final line
    if !current_line.is_empty() || wrapped.is_empty() {
        wrapped.push(current_line);
    }

    wrapped
}

/// Wrap multiple lines, preserving ANSI codes across line breaks.
pub fn wrap_ansi_text(text: &str, width: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut tracker = AnsiCodeTracker::new();

    for line in text.lines() {
        // Process any ANSI codes in this line to update tracker
        for segment in parse_ansi_segments(line) {
            if let AnsiSegment::Escape(code) = segment {
                tracker.process(&code);
            }
        }

        // Wrap this line
        let wrapped = wrap_ansi_line(line, width);
        result.extend(wrapped);
    }

    result
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUNCATION WITH ANSI AWARENESS
// ─────────────────────────────────────────────────────────────────────────────

/// Truncate a line with ANSI codes to fit within a width.
///
/// Adds ellipsis if truncated, with proper reset before ellipsis.
pub fn truncate_ansi_line(line: &str, max_width: usize) -> String {
    use unicode_width::UnicodeWidthStr;

    if max_width == 0 {
        return String::new();
    }

    let segments = parse_ansi_segments(line);
    let mut tracker = AnsiCodeTracker::new();
    let mut result = String::new();
    let mut current_width = 0;
    let ellipsis_width = 1; // "…" is 1 cell wide
    let target_width = max_width.saturating_sub(ellipsis_width);
    let mut truncated = false;

    for segment in &segments {
        match segment {
            AnsiSegment::Escape(code) => {
                tracker.process(code);
                if !truncated {
                    result.push_str(code);
                }
            }
            AnsiSegment::Text(text) => {
                if truncated {
                    continue;
                }

                for ch in text.chars() {
                    let ch_width = ch.to_string().width();

                    if current_width + ch_width > target_width {
                        truncated = true;
                        break;
                    }

                    result.push(ch);
                    current_width += ch_width;
                }
            }
        }
    }

    // Check if we actually need ellipsis
    let total_text_width: usize = segments
        .iter()
        .filter_map(|s| match s {
            AnsiSegment::Text(t) => Some(t.width()),
            _ => None,
        })
        .sum();

    if total_text_width > max_width {
        // Add reset before ellipsis to prevent style leakage
        if tracker.has_active_codes() {
            result.push_str("\x1b[0m");
        }
        result.push('…');
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
    fn tracker_starts_empty() {
        let tracker = AnsiCodeTracker::new();
        assert!(!tracker.has_active_codes());
        assert_eq!(tracker.get_active_codes(), "");
    }

    #[test]
    fn tracker_processes_bold() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[1m");
        assert!(tracker.is_bold());
        assert!(tracker.has_active_codes());
        assert_eq!(tracker.get_active_codes(), "\x1b[1m");
    }

    #[test]
    fn tracker_processes_multiple_codes() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[1;31m"); // Bold + red
        assert!(tracker.is_bold());
        assert_eq!(tracker.fg_color(), Some("31"));
    }

    #[test]
    fn tracker_processes_256_color() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[38;5;196m");
        assert_eq!(tracker.fg_color(), Some("38;5;196"));
    }

    #[test]
    fn tracker_processes_true_color() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[38;2;255;128;0m");
        assert_eq!(tracker.fg_color(), Some("38;2;255;128;0"));
    }

    #[test]
    fn tracker_reset_clears_all() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[1;4;31m"); // Bold, underline, red
        tracker.process("\x1b[0m");
        assert!(!tracker.has_active_codes());
    }

    #[test]
    fn tracker_surgical_reset_underline() {
        let mut tracker = AnsiCodeTracker::new();
        tracker.process("\x1b[4m"); // Underline
        assert_eq!(tracker.get_line_end_reset(), "\x1b[24m");

        let mut tracker2 = AnsiCodeTracker::new();
        tracker2.process("\x1b[1m"); // Bold only
        assert_eq!(tracker2.get_line_end_reset(), "");
    }

    #[test]
    fn parse_segments_simple() {
        let segments = parse_ansi_segments("hello");
        assert_eq!(segments, vec![AnsiSegment::Text("hello".to_string())]);
    }

    #[test]
    fn parse_segments_with_ansi() {
        let segments = parse_ansi_segments("\x1b[31mred\x1b[0m");
        assert_eq!(
            segments,
            vec![
                AnsiSegment::Escape("\x1b[31m".to_string()),
                AnsiSegment::Text("red".to_string()),
                AnsiSegment::Escape("\x1b[0m".to_string()),
            ]
        );
    }

    #[test]
    fn wrap_ansi_preserves_codes() {
        let line = "\x1b[31mred text here\x1b[0m";
        let wrapped = wrap_ansi_line(line, 5);
        assert!(wrapped.len() > 1);
        // First line should have red code
        assert!(wrapped[0].contains("\x1b[31m"));
    }

    #[test]
    fn truncate_ansi_adds_ellipsis() {
        let line = "This is a long line";
        let truncated = truncate_ansi_line(line, 10);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() < line.len());
    }

    #[test]
    fn truncate_ansi_resets_before_ellipsis() {
        // Input without reset - underline active throughout
        let line = "\x1b[4munderlined text here";
        let truncated = truncate_ansi_line(line, 10);
        // Should have reset before ellipsis to prevent underline bleeding
        assert!(truncated.contains("\x1b[0m"));
        assert!(truncated.ends_with('…'));
    }
}

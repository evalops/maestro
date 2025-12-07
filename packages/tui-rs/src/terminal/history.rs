//! History line insertion
//!
//! This module implements the key technique for SSH compatibility:
//! pushing content into the terminal's native scrollback buffer using
//! ANSI scroll regions (DECSTBM).
//!
//! ## How it works
//!
//! Instead of maintaining our own scroll buffer in the application,
//! we use terminal scroll regions to insert lines above our viewport.
//! These lines go into the terminal's native scrollback, which:
//!
//! 1. Survives SSH disconnects/reconnects
//! 2. Can be scrolled with Shift+PageUp/PageDown
//! 3. Works with tmux/screen scrollback
//! 4. Persists even when our viewport is at the bottom
//!
//! ## ANSI Sequences Used
//!
//! - `ESC[n;mr` - DECSTBM: Set scroll region (rows n to m)
//! - `ESC[r` - Reset scroll region to full screen
//! - `ESC M` - RI (Reverse Index): Scroll content down, insert line at top
//!
//! ## Visual Representation
//!
//! ```text
//! ┌─Screen───────────────────────┐
//! │┌╌Scroll region╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐│
//! │┆  (terminal scrollback)     ┆│
//! │┆  History lines go here     ┆│
//! │┆                            ┆│
//! │█╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘│
//! │╭─Viewport───────────────────╮│
//! ││  Active TUI content        ││
//! │╰────────────────────────────╯│
//! └──────────────────────────────┘
//! ```

use std::io::{self, Write};

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use crate::protocol::HistoryLine;

/// Push lines into terminal scrollback above the viewport.
///
/// This is the core function for inserting content into the terminal's native
/// scrollback buffer using ANSI scroll region manipulation. Content is inserted
/// above the TUI viewport and becomes accessible via native terminal scrollback
/// (Shift+PageUp/PageDown).
///
/// # How It Works
///
/// 1. Set a scroll region from row 1 to `viewport_top - 1` using DECSTBM
/// 2. Move cursor to the bottom of this scroll region
/// 3. Print each line with `\r\n`, causing content to scroll up into scrollback
/// 4. Reset the scroll region to full screen
///
/// This technique allows the TUI to maintain a clean separation between:
/// - History content (in terminal scrollback, managed by terminal emulator)
/// - Active viewport (managed by ratatui, below the scroll region)
///
/// # Arguments
///
/// - `writer`: Output writer (typically the TTY file handle)
/// - `lines`: History lines to insert, with styled spans
/// - `viewport_top`: 1-indexed row where the viewport starts
/// - `width`: Terminal width for word wrapping
///
/// # Errors
///
/// Returns an error if writing to the terminal fails.
///
/// # Example
///
/// ```no_run
/// use std::fs::File;
/// use tui_rs::terminal::push_history_lines;
/// use tui_rs::protocol::HistoryLine;
///
/// # fn example(mut tty: File) -> std::io::Result<()> {
/// let lines = vec![/* history lines */];
/// push_history_lines(&mut tty, &lines, 10, 80)?;
/// # Ok(())
/// # }
/// ```
pub fn push_history_lines<W: Write>(
    writer: &mut W,
    lines: &[HistoryLine],
    viewport_top: u16,
    width: u16,
) -> io::Result<()> {
    if lines.is_empty() || viewport_top == 0 {
        return Ok(());
    }

    // Convert to ratatui lines for consistent wrapping
    let ratatui_lines: Vec<Line> = lines.iter().map(history_line_to_ratatui).collect();

    // Word-wrap lines to fit width
    let wrapped = wrap_lines(&ratatui_lines, width as usize);

    // Set scroll region from line 1 to just above viewport (1-indexed for DECSTBM)
    write!(writer, "\x1b[1;{}r", viewport_top)?;

    // Move cursor to bottom of scroll region
    write!(writer, "\x1b[{};1H", viewport_top)?;

    // Print each line - they'll scroll up into the scrollback
    for line in &wrapped {
        // New line first to scroll existing content up
        write!(writer, "\r\n")?;
        // Clear the line
        write!(writer, "\x1b[2K")?;
        // Write styled content
        write_styled_line(writer, line)?;
    }

    // Reset scroll region
    write!(writer, "\x1b[r")?;

    writer.flush()?;
    Ok(())
}

/// Convert protocol HistoryLine to ratatui Line.
///
/// This function bridges the gap between our protocol types (used for IPC) and
/// ratatui's rendering types. It converts styled spans from the protocol format
/// to ratatui's `Span` and `Style` types.
fn history_line_to_ratatui(line: &HistoryLine) -> Line<'static> {
    let spans: Vec<Span<'static>> = line
        .spans
        .iter()
        .map(|span| {
            let style: Style = span.style.clone().into();
            Span::styled(span.text.clone(), style)
        })
        .collect();
    Line::from(spans)
}

/// Word-wrap lines to fit within width, preserving span styles.
///
/// Uses the wrapping module's word wrapping algorithm to break long lines while
/// preserving the original span styles across line breaks. This ensures that
/// color, bold, italic, and other text attributes are maintained when lines wrap.
fn wrap_lines(lines: &[Line<'_>], width: usize) -> Vec<Line<'static>> {
    use crate::wrapping::word_wrap_lines;
    word_wrap_lines(lines, width)
}

/// Write a styled line to the writer using ANSI escape codes.
///
/// This function converts ratatui's style attributes to ANSI SGR (Select Graphic
/// Rendition) codes and writes them inline with the text. This is necessary because
/// we're writing directly to the terminal outside of ratatui's rendering system.
fn write_styled_line<W: Write>(writer: &mut W, line: &Line) -> io::Result<()> {
    for span in &line.spans {
        // Apply style
        apply_style(writer, &span.style)?;
        // Write content
        write!(writer, "{}", span.content)?;
    }
    // Reset style
    write!(writer, "\x1b[0m")?;
    Ok(())
}

/// Apply ratatui style as ANSI escape codes.
///
/// Converts ratatui's `Style` struct to ANSI SGR sequences for terminal output.
/// Handles foreground/background colors (including RGB and indexed colors) and
/// text modifiers (bold, italic, underline, dim, strikethrough).
fn apply_style<W: Write>(writer: &mut W, style: &Style) -> io::Result<()> {
    // Reset first
    write!(writer, "\x1b[0m")?;

    // Foreground color
    if let Some(fg) = style.fg {
        write!(writer, "{}", color_to_ansi_fg(fg))?;
    }

    // Background color
    if let Some(bg) = style.bg {
        write!(writer, "{}", color_to_ansi_bg(bg))?;
    }

    // Modifiers
    use ratatui::style::Modifier;
    if style.add_modifier.contains(Modifier::BOLD) {
        write!(writer, "\x1b[1m")?;
    }
    if style.add_modifier.contains(Modifier::DIM) {
        write!(writer, "\x1b[2m")?;
    }
    if style.add_modifier.contains(Modifier::ITALIC) {
        write!(writer, "\x1b[3m")?;
    }
    if style.add_modifier.contains(Modifier::UNDERLINED) {
        write!(writer, "\x1b[4m")?;
    }
    if style.add_modifier.contains(Modifier::CROSSED_OUT) {
        write!(writer, "\x1b[9m")?;
    }

    Ok(())
}

/// Convert ratatui color to ANSI foreground escape code.
///
/// Maps ratatui's `Color` enum to ANSI SGR foreground color codes (30-37, 90-97
/// for basic colors, 38;5;n for indexed, 38;2;r;g;b for RGB).
fn color_to_ansi_fg(color: ratatui::style::Color) -> String {
    use ratatui::style::Color;
    match color {
        Color::Reset => "\x1b[39m".to_string(),
        Color::Black => "\x1b[30m".to_string(),
        Color::Red => "\x1b[31m".to_string(),
        Color::Green => "\x1b[32m".to_string(),
        Color::Yellow => "\x1b[33m".to_string(),
        Color::Blue => "\x1b[34m".to_string(),
        Color::Magenta => "\x1b[35m".to_string(),
        Color::Cyan => "\x1b[36m".to_string(),
        Color::White | Color::Gray => "\x1b[37m".to_string(),
        Color::DarkGray => "\x1b[90m".to_string(),
        Color::LightRed => "\x1b[91m".to_string(),
        Color::LightGreen => "\x1b[92m".to_string(),
        Color::LightYellow => "\x1b[93m".to_string(),
        Color::LightBlue => "\x1b[94m".to_string(),
        Color::LightMagenta => "\x1b[95m".to_string(),
        Color::LightCyan => "\x1b[96m".to_string(),
        Color::Indexed(idx) => format!("\x1b[38;5;{}m", idx),
        Color::Rgb(r, g, b) => format!("\x1b[38;2;{};{};{}m", r, g, b),
    }
}

/// Convert ratatui color to ANSI background escape code.
///
/// Maps ratatui's `Color` enum to ANSI SGR background color codes (40-47, 100-107
/// for basic colors, 48;5;n for indexed, 48;2;r;g;b for RGB).
fn color_to_ansi_bg(color: ratatui::style::Color) -> String {
    use ratatui::style::Color;
    match color {
        Color::Reset => "\x1b[49m".to_string(),
        Color::Black => "\x1b[40m".to_string(),
        Color::Red => "\x1b[41m".to_string(),
        Color::Green => "\x1b[42m".to_string(),
        Color::Yellow => "\x1b[43m".to_string(),
        Color::Blue => "\x1b[44m".to_string(),
        Color::Magenta => "\x1b[45m".to_string(),
        Color::Cyan => "\x1b[46m".to_string(),
        Color::White | Color::Gray => "\x1b[47m".to_string(),
        Color::DarkGray => "\x1b[100m".to_string(),
        Color::LightRed => "\x1b[101m".to_string(),
        Color::LightGreen => "\x1b[102m".to_string(),
        Color::LightYellow => "\x1b[103m".to_string(),
        Color::LightBlue => "\x1b[104m".to_string(),
        Color::LightMagenta => "\x1b[105m".to_string(),
        Color::LightCyan => "\x1b[106m".to_string(),
        Color::Indexed(idx) => format!("\x1b[48;5;{}m", idx),
        Color::Rgb(r, g, b) => format!("\x1b[48;2;{};{};{}m", r, g, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{StyledSpan, TextStyle};

    #[test]
    fn test_push_history_empty() {
        let mut buf = Vec::new();
        push_history_lines(&mut buf, &[], 10, 80).unwrap();
        assert!(buf.is_empty());
    }

    #[test]
    fn test_push_history_single_line() {
        let mut buf = Vec::new();
        let lines = vec![HistoryLine {
            spans: vec![StyledSpan {
                text: "Hello".to_string(),
                style: TextStyle::default(),
            }],
        }];
        push_history_lines(&mut buf, &lines, 10, 80).unwrap();

        let output = String::from_utf8(buf).unwrap();
        // Should contain scroll region setup
        assert!(output.contains("\x1b[1;10r"));
        // Should contain reset
        assert!(output.contains("\x1b[r"));
        // Should contain our text
        assert!(output.contains("Hello"));
    }
}

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
/// This uses ANSI scroll regions to insert content that persists in
/// the terminal's native scrollback buffer.
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

/// Convert our HistoryLine to ratatui Line
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

/// Word-wrap lines to fit within width
fn wrap_lines(lines: &[Line<'_>], width: usize) -> Vec<Line<'static>> {
    let mut result = Vec::new();

    for line in lines {
        let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();

        if text.len() <= width {
            // Line fits, convert spans to owned
            let owned_spans: Vec<Span<'static>> = line.spans.iter()
                .map(|s| Span::styled(s.content.to_string(), s.style))
                .collect();
            result.push(Line::from(owned_spans));
        } else {
            // Need to wrap - for now simple character-based wrapping
            // TODO: Use textwrap for proper word-aware wrapping
            let wrapped = textwrap::wrap(&text, width);
            for (i, wrapped_text) in wrapped.iter().enumerate() {
                if i == 0 {
                    result.push(Line::from(wrapped_text.to_string()));
                } else {
                    result.push(Line::from(format!("  {}", wrapped_text)));
                }
            }
        }
    }

    result
}

/// Write a styled line to the writer
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

/// Apply ratatui style as ANSI codes
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

/// Convert ratatui color to ANSI foreground code
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

/// Convert ratatui color to ANSI background code
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

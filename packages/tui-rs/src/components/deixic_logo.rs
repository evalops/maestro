//! Deixic brand mark for the Maestro TUI welcome surface.
//!
//! Art is original terminal glyph work derived from the Dex ghost silhouette
//! on https://github.com/evalops/deixic (`app/icon.svg`, `components/dex/Ghost.tsx`):
//! rounded head, two eyes, scalloped hem. Colors come from Deixic violet
//! (`#6857fe`). Diagonal sheen uses [`crate::shimmer`].
//!
//! Size tiers follow Grok Build's welcome logo pattern (hide on short
//! viewports, compact mid, full on tall).

use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

use crate::shimmer::{
    diagonal_shimmer_lines, shimmer_spans, DEIXIC_LOGO_BASE, DEIXIC_LOGO_HILITE, DEIXIC_VIOLET,
};

/// Full Dex ghost (wide). Shown when the welcome area is tall enough.
pub const LOGO_FULL: &str = r"
        ⢀⣀⣀⣀⣀⣀⡀
      ⢀⣾⣿⣿⣿⣿⣿⣿⣷⡀
     ⢠⣿⣿⠁  ●  ●  ⠈⣿⣿⡄
     ⣿⣿⡇            ⢸⣿⣿
     ⢿⣿⡇            ⢸⣿⡿
     ⠈⣿⣿⣄   ⣀⣀   ⣠⣿⣿⠁
       ⠙⠿⣿⣿⣿⣿⣿⣿⣿⠿⠋
         ⠉⠉⠉  ⠉⠉⠉
";

/// Compact ghost for mid-height viewports.
pub const LOGO_COMPACT: &str = r"
     ⢀⣀⣀⣀⡀
    ⣾⣿  ●●  ⣿⣷
    ⢿⣿        ⣿⡿
     ⠈⠿⣿⣿⣿⠿⠁
";

/// Tiny two-line mark when vertical space is tight but not zero.
pub const LOGO_TINY: &str = r"
  ╭ ●● ╮
  ╰~~~~╯
";

/// One-line mark for compact terminal panes. It keeps the product visibly
/// branded when there is room for the title and hint but not the two-line art.
pub const LOGO_MICRO: &str = "  ◉";

/// Minimum area height (rows) to show the one-line mark.
pub const MICRO_MIN_HEIGHT: u16 = 4;
/// Minimum area height (rows) to show the tiny mark.
pub const TINY_MIN_HEIGHT: u16 = 8;
/// Minimum area height for the compact ghost.
pub const COMPACT_MIN_HEIGHT: u16 = 14;
/// Minimum area height for the full ghost.
pub const FULL_MIN_HEIGHT: u16 = 20;

/// Pick logo art for the given available height. `None` if too short.
#[must_use]
pub fn pick_logo(area_height: u16) -> Option<&'static str> {
    if area_height < MICRO_MIN_HEIGHT {
        None
    } else if area_height < TINY_MIN_HEIGHT {
        Some(LOGO_MICRO)
    } else if area_height < COMPACT_MIN_HEIGHT {
        Some(LOGO_TINY)
    } else if area_height < FULL_MIN_HEIGHT {
        Some(LOGO_COMPACT)
    } else {
        Some(LOGO_FULL)
    }
}

/// Non-empty lines of a logo string.
#[must_use]
pub fn logo_lines(logo: &str) -> Vec<&str> {
    logo.lines().filter(|l| !l.is_empty()).collect()
}

/// Line count of the selected logo (0 when hidden).
#[must_use]
pub fn logo_line_count(area_height: u16) -> u16 {
    pick_logo(area_height)
        .map(|l| logo_lines(l).len() as u16)
        .unwrap_or(0)
}

/// Visual width of the selected logo (display columns).
#[must_use]
pub fn logo_visual_width(area_height: u16) -> u16 {
    pick_logo(area_height)
        .map(|logo| {
            logo_lines(logo)
                .iter()
                .map(|l| UnicodeWidthStr::width(*l))
                .max()
                .unwrap_or(12) as u16
        })
        .unwrap_or(12)
}

/// Build shimmered logo lines (diagonal sheen) for the current wall clock.
#[must_use]
pub fn shimmered_logo_lines(area_height: u16) -> Vec<Line<'static>> {
    let Some(logo) = pick_logo(area_height) else {
        return Vec::new();
    };
    let lines = logo_lines(logo);
    diagonal_shimmer_lines(&lines, DEIXIC_LOGO_BASE, DEIXIC_LOGO_HILITE)
}

/// Static (non-animated) logo lines in solid Deixic violet.
#[must_use]
pub fn static_logo_lines(area_height: u16) -> Vec<Line<'static>> {
    let Some(logo) = pick_logo(area_height) else {
        return Vec::new();
    };
    logo_lines(logo)
        .into_iter()
        .map(|line| {
            Line::from(Span::styled(
                line.to_string(),
                Style::default()
                    .fg(Color::Rgb(
                        DEIXIC_VIOLET.0,
                        DEIXIC_VIOLET.1,
                        DEIXIC_VIOLET.2,
                    ))
                    .add_modifier(Modifier::BOLD),
            ))
        })
        .collect()
}

/// Wordmark line: "deixic" with linear shimmer (or solid violet when disabled).
#[must_use]
pub fn wordmark_line(animate: bool) -> Line<'static> {
    if animate {
        Line::from(shimmer_spans("deixic")).alignment(Alignment::Center)
    } else {
        Line::from(Span::styled(
            "deixic",
            Style::default()
                .fg(Color::Rgb(
                    DEIXIC_VIOLET.0,
                    DEIXIC_VIOLET.1,
                    DEIXIC_VIOLET.2,
                ))
                .add_modifier(Modifier::BOLD),
        ))
        .alignment(Alignment::Center)
    }
}

/// Product title line (kept as Maestro — product name is not Deixic).
#[must_use]
pub fn product_title_line(animate: bool) -> Line<'static> {
    if animate {
        Line::from(shimmer_spans("Maestro")).alignment(Alignment::Center)
    } else {
        Line::from(Span::styled(
            "Maestro",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ))
        .alignment(Alignment::Center)
    }
}

/// Hint line under the brand block.
#[must_use]
pub fn hint_line() -> Line<'static> {
    Line::from(Span::styled(
        "Type a message or /help.",
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::DIM),
    ))
    .alignment(Alignment::Center)
}

/// Full welcome content: logo + wordmark + product title + hint.
///
/// `area_height` drives logo tier. `animate` enables sheen on logo/wordmark/title.
#[must_use]
pub fn welcome_content_lines(area_height: u16, animate: bool) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let micro_logo = pick_logo(area_height) == Some(LOGO_MICRO);

    let logo = if animate {
        shimmered_logo_lines(area_height)
    } else {
        static_logo_lines(area_height)
    };
    if !logo.is_empty() {
        for mut line in logo {
            line.alignment = Some(Alignment::Center);
            lines.push(line);
        }
        if !micro_logo {
            lines.push(Line::from(""));
        }
    }

    // Wordmark only when logo is visible (brand block).
    if pick_logo(area_height).is_some() && !micro_logo {
        lines.push(wordmark_line(animate));
    }

    lines.push(product_title_line(animate));
    lines.push(hint_line());
    lines
}

/// Render the Deixic welcome block into `area` (centered vertically).
pub fn render_welcome(area: Rect, buf: &mut Buffer, animate: bool) {
    if area.is_empty() {
        return;
    }
    let content = welcome_content_lines(area.height, animate);
    let content_height = content.len() as u16;
    let y_offset = if area.height > content_height {
        (area.height - content_height) / 2
    } else {
        0
    };
    let content_area = Rect::new(
        area.x,
        area.y + y_offset,
        area.width,
        content_height.min(area.height),
    );
    Paragraph::new(content)
        .alignment(Alignment::Center)
        .render(content_area, buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_tiers_by_height() {
        assert!(pick_logo(MICRO_MIN_HEIGHT - 1).is_none());
        assert_eq!(pick_logo(MICRO_MIN_HEIGHT), Some(LOGO_MICRO));
        assert_eq!(pick_logo(TINY_MIN_HEIGHT - 1), Some(LOGO_MICRO));
        assert_eq!(pick_logo(TINY_MIN_HEIGHT), Some(LOGO_TINY));
        assert_eq!(pick_logo(COMPACT_MIN_HEIGHT), Some(LOGO_COMPACT));
        assert_eq!(pick_logo(FULL_MIN_HEIGHT), Some(LOGO_FULL));
    }

    #[test]
    fn full_logo_is_taller_than_compact() {
        assert!(logo_lines(LOGO_FULL).len() > logo_lines(LOGO_COMPACT).len());
        assert!(logo_lines(LOGO_COMPACT).len() > logo_lines(LOGO_TINY).len());
        assert!(logo_lines(LOGO_TINY).len() > logo_lines(LOGO_MICRO).len());
    }

    #[test]
    fn welcome_content_always_includes_maestro_and_hint() {
        let lines = welcome_content_lines(24, false);
        let text: String = lines
            .iter()
            .map(Line::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Maestro"));
        assert!(text.contains("Type a message or /help."));
        assert!(text.contains("deixic"));
    }

    #[test]
    fn welcome_short_height_hides_logo_keeps_title() {
        let lines = welcome_content_lines(MICRO_MIN_HEIGHT - 1, false);
        let text: String = lines
            .iter()
            .map(Line::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Maestro"));
        assert!(text.contains("Type a message or /help."));
        // No room for brand block.
        assert!(!text.contains("deixic"));
    }

    #[test]
    fn welcome_micro_height_keeps_a_visible_mark_without_wordmark() {
        let lines = welcome_content_lines(MICRO_MIN_HEIGHT, false);
        let text: String = lines
            .iter()
            .map(Line::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains('◉'));
        assert!(text.contains("Maestro"));
        assert!(text.contains("Type a message or /help."));
        assert!(!text.contains("deixic"));
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn logo_line_count_matches_art() {
        assert_eq!(
            logo_line_count(FULL_MIN_HEIGHT),
            logo_lines(LOGO_FULL).len() as u16
        );
        assert_eq!(logo_line_count(0), 0);
    }
}

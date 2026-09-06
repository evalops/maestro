//! Stateless session location and context-pressure header shared with previews.
use crate::shimmer::{DEIXIC_ACCENT, DEIXIC_BORDER, DEIXIC_MUTED, DEIXIC_SURFACE};
use ratatui::{prelude::*, widgets::Paragraph};
use unicode_width::UnicodeWidthStr;

fn brand_color(rgb: (u8, u8, u8)) -> Color {
    Color::Rgb(rgb.0, rgb.1, rgb.2)
}

fn brand_violet() -> Color {
    brand_color(DEIXIC_ACCENT)
}

fn brand_border() -> Color {
    brand_color(DEIXIC_BORDER)
}

fn brand_muted() -> Color {
    brand_color(DEIXIC_MUTED)
}

fn brand_surface() -> Color {
    brand_color(DEIXIC_SURFACE)
}

/// Grok-inspired one-line session header.
///
/// Keeps location on the left and context pressure on the right so the
/// conversation itself can remain visually quiet.
pub struct SessionHeaderWidget<'a> {
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    theme: Option<maestro_ui::UiTheme>,
}

impl<'a> SessionHeaderWidget<'a> {
    #[must_use]
    pub fn new(cwd: Option<&'a str>, git_branch: Option<&'a str>) -> Self {
        Self {
            cwd,
            git_branch,
            context_used: None,
            context_window: None,
            theme: None,
        }
    }

    /// Supply the application's palette; omitted palettes keep legacy terminal styling.
    #[must_use]
    pub fn theme(mut self, theme: Option<maestro_ui::UiTheme>) -> Self {
        self.theme = theme;
        self
    }

    #[must_use]
    pub fn with_context(mut self, used: Option<u64>, window: Option<u64>) -> Self {
        self.context_used = used;
        self.context_window = window.filter(|value| *value > 0);
        self
    }
}

impl Widget for SessionHeaderWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        buf.set_style(
            area,
            Style::default().bg(self.theme.map_or_else(brand_surface, |theme| theme.surface)),
        );
        let location = format_session_location(self.cwd, self.git_branch);
        let brand_label = super::deixic_logo::PRODUCT_TITLE;
        let brand_width = brand_label.width() as u16;
        let context = format_context_usage(self.context_used, self.context_window)
            .filter(|text| text.width() + usize::from(brand_width) + 2 <= usize::from(area.width));
        let context_width = context.as_ref().map_or(0, |text| text.width() as u16);
        let context_gap = u16::from(context_width > 0) * 2;
        let divider = "  │  ";
        let divider_width = divider.width() as u16;
        let location_width = area
            .width
            .saturating_sub(context_width)
            .saturating_sub(context_gap)
            .saturating_sub(brand_width)
            .saturating_sub(u16::from(!location.is_empty()) * divider_width);
        let location = truncate_location(&location, location_width as usize);
        let mut header_spans = vec![Span::styled(
            brand_label,
            Style::default()
                .fg(self.theme.map_or_else(brand_violet, |theme| theme.focus))
                .add_modifier(Modifier::BOLD),
        )];
        if !location.is_empty() {
            header_spans.push(Span::styled(
                divider,
                Style::default().fg(self.theme.map_or_else(brand_border, |theme| theme.border)),
            ));
            header_spans.push(Span::styled(
                location,
                Style::default().fg(self.theme.map_or_else(brand_muted, |theme| theme.muted)),
            ));
        }
        Paragraph::new(Line::from(header_spans)).render(area, buf);

        if let Some(context) = context {
            let color = match (self.context_used, self.context_window) {
                (Some(used), Some(window))
                    if used.saturating_mul(100) >= window.saturating_mul(90) =>
                {
                    self.theme.map_or(Color::Red, |theme| theme.error)
                }
                (Some(used), Some(window))
                    if used.saturating_mul(100) >= window.saturating_mul(75) =>
                {
                    self.theme.map_or(Color::Yellow, |theme| theme.attention)
                }
                _ => self.theme.map_or_else(brand_muted, |theme| theme.muted),
            };
            let x = area.right().saturating_sub(context_width);
            buf.set_string(
                x,
                area.y,
                context,
                Style::default()
                    .fg(color)
                    .bg(self.theme.map_or_else(brand_surface, |theme| theme.surface)),
            );
        }
    }
}

pub fn format_session_location(cwd: Option<&str>, git_branch: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return String::new();
    };
    let path = std::path::Path::new(cwd);
    let compact = path.file_name().map_or_else(
        || cwd.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    match git_branch {
        Some(branch) if !branch.is_empty() => format!("{compact}  ·  {branch}"),
        _ => compact,
    }
}

pub fn format_context_usage(used: Option<u64>, window: Option<u64>) -> Option<String> {
    match (used, window) {
        (Some(used), Some(window)) => Some(format!(
            "{} / {}",
            format_context_tokens(used),
            format_context_tokens(window)
        )),
        (Some(used), None) if used > 0 => Some(format!("{} context", format_context_tokens(used))),
        _ => None,
    }
}

pub fn format_context_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        let value = tokens as f64 / 1_000_000.0;
        if value < 10.0 {
            format!("{value:.1}M")
        } else {
            format!("{}M", tokens / 1_000_000)
        }
    } else if tokens >= 10_000 {
        format!("{}K", tokens / 1_000)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

pub fn truncate_location(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if value.width() <= max_width {
        return value.to_string();
    }
    if max_width == 1 {
        return "…".to_string();
    }
    let tail: String = value.chars().rev().take(max_width - 1).collect();
    format!("…{}", tail.chars().rev().collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn narrow_header_preserves_identity_and_context_boundary() {
        for width in [8, 16, 19, 20, 21, 24, 26, 27, 60, 100] {
            let area = Rect::new(0, 0, width, 1);
            let mut buf = Buffer::empty(area);
            SessionHeaderWidget::new(Some("/workspace/release-planner"), Some("main"))
                .with_context(Some(9500), Some(500000))
                .render(area, &mut buf);
            let row: String = (0..width).map(|x| buf[(x, 0)].symbol()).collect();
            assert!(row.starts_with("Dex Code"));
            assert_eq!(row.contains("9.5K / 500K"), width >= 21);
            if (21..27).contains(&width) {
                assert!(!row.contains('│'));
            }
        }
    }
}

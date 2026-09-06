//! A fixed sample for comparing palettes; never executes or persists a conversation.
use super::{
    composer::Composer,
    dex_companion::{DexCompanion, DexCompanionState},
};
use maestro_ui::{UiTheme, textarea::TextArea};
use ratatui::{prelude::*, widgets::Paragraph};

/// The same text, semantic outcomes and real composer for every palette.
pub struct ThemePreview(pub UiTheme);
impl Widget for ThemePreview {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let area = area.intersection(buf.area);
        if area.is_empty() {
            return;
        }
        let theme = self.0;
        buf.set_style(area, theme.text_style());
        let rows = Layout::vertical([Constraint::Length(4), Constraint::Min(0)]).split(area);
        Paragraph::new(vec![
            DexCompanion::new(DexCompanionState::Ready)
                .theme(Some(theme))
                .status_line(),
            Line::from("Let's make something useful."),
            Line::from(vec![
                Span::styled("✓ Passed  ", Style::default().fg(theme.success)),
                Span::styled("! Attention  ", Style::default().fg(theme.attention)),
                Span::styled("× Failed", Style::default().fg(theme.error)),
            ]),
            Line::styled("A quieter hint", theme.muted_style()),
        ])
        .render(rows[0], buf);
        let editor = TextArea::new();
        Composer {
            editor: &editor,
            queued: &[],
            busy: false,
            footer: None,
            completion: Some("Ask Dex…"),
            theme,
        }
        .render(rows[1], buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_uses_canvas_panel_and_semantic_text_without_changing_activity() {
        let theme = UiTheme {
            surface: Color::Rgb(230, 236, 223),
            panel: Some(Color::Rgb(219, 227, 210)),
            text: Color::Black,
            focus: Color::Green,
            ..Default::default()
        };
        for width in [24, 64] {
            let area = Rect::new(0, 0, width, 7);
            let mut buf = Buffer::empty(area);
            ThemePreview(theme).render(area, &mut buf);
            assert_eq!(buf[(0, 0)].fg, theme.focus);
            assert_eq!(buf[(width - 1, 0)].bg, theme.surface);
            assert_eq!(buf[(width - 1, 6)].bg, theme.panel.unwrap());
            let text: String = buf.content.iter().map(|cell| cell.symbol()).collect();
            assert!(text.contains("Dex · ready"));
            assert!(text.contains("Ask Dex"));
        }
    }
}

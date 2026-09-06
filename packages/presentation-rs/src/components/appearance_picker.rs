//! The product appearance dialog, shared by native rendering and previews.
use crate::{
    appearance::Appearance, components::dex_companion::DexCompanionState, dex_delight::DexLook,
};
use maestro_interaction::Action;
use maestro_ui::{ActionPicker, ModalSize, PickerHelp, PickerOptions};
use ratatui::layout::Rect;
pub fn render_appearance(
    frame: &mut ratatui::Frame,
    area: Rect,
    state: &mut ActionPicker<Action<Appearance>>,
    look: DexLook,
    theme: maestro_ui::UiTheme,
) {
    use ratatui::{
        layout::{Constraint, Layout},
        style::Style,
        widgets::Paragraph,
    };
    let inner = maestro_ui::Modal::sized("Dex appearance", ModalSize::Standard)
        .theme(theme)
        .render(frame, area);
    let chunks = Layout::vertical([Constraint::Length(2), Constraint::Min(0)]).split(inner);
    crate::components::dex_companion::DexCompanion::new(DexCompanionState::Ready)
        .look(look)
        .render_face(
            Rect::new(
                chunks[0].x,
                chunks[0].y,
                chunks[0].width.min(6),
                chunks[0].height,
            ),
            frame.buffer_mut(),
        );
    frame.render_widget(
        Paragraph::new("Make Dex yours").style(Style::default().fg(theme.muted)),
        Rect::new(
            chunks[0].x + 8,
            chunks[0].y,
            chunks[0].width.saturating_sub(8),
            1,
        ),
    );
    state.render(
        frame,
        chunks[1],
        theme,
        PickerOptions {
            position_when_clipped: true,
            help: PickerHelp {
                navigation: "select",
                confirm: "save",
                key_separator: " ",
            },
            ..PickerOptions::default()
        },
        |action| ratatui::widgets::ListItem::new(action.label),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appearance_frame_and_content_use_the_supplied_palette() {
        use ratatui::{Terminal, backend::TestBackend, style::Color};
        let mut terminal = Terminal::new(TestBackend::new(60, 20)).unwrap();
        let mut picker = ActionPicker::new(crate::appearance::LOOKS.to_vec());
        picker.open();
        let theme = maestro_ui::UiTheme {
            surface: Color::White,
            text: Color::Black,
            border: Color::Red,
            ..Default::default()
        };
        let area = Rect::new(0, 0, 60, 20);
        let border = maestro_ui::Modal::sized("Dex appearance", ModalSize::Standard).area(area);
        terminal
            .draw(|frame| render_appearance(frame, area, &mut picker, DexLook::default(), theme))
            .unwrap();
        let cell = &terminal.backend().buffer()[(border.x, border.y)];
        assert_eq!(cell.fg, Color::Red);
        assert_eq!(cell.bg, Color::White);
        assert_eq!(
            terminal.backend().buffer()[(border.x + 2, border.y)].fg,
            Color::Black
        );
    }
}

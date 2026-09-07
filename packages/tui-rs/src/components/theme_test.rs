//! Distinct palettes detect terminal colors that bypass the shared theme.
use maestro_ui::UiTheme;
use ratatui::{buffer::Buffer, style::Color};

pub(crate) fn palettes() -> [UiTheme; 2] {
    [false, true].map(|light| {
        let mut theme = if light {
            crate::themes::light_theme()
        } else {
            crate::themes::dark_theme()
        }
        .ui_theme();
        theme.focus = Color::Rgb(117, 63, 153);
        theme.success = Color::Rgb(27, 137, 83);
        theme.attention = Color::Rgb(181, 113, 29);
        theme.error = Color::Rgb(193, 51, 73);
        theme.selection = Some(Color::Rgb(83, 79, 113));
        theme
    })
}

pub(crate) fn assert_palette(buffer: &Buffer, theme: UiTheme) {
    let ink = [
        theme.text,
        theme.muted,
        theme.border,
        theme.focus,
        theme.success,
        theme.attention,
        theme.error,
    ];
    let mut painted = 0;
    for cell in &buffer.content {
        if cell.symbol().trim().is_empty() {
            continue;
        }
        painted += 1;
        assert!(
            ink.contains(&cell.fg),
            "unexpected ink {:?} on {:?}",
            cell.fg,
            cell.symbol()
        );
        assert!(
            [theme.surface, theme.selection.unwrap_or(theme.surface)].contains(&cell.bg),
            "unexpected background {:?} on {:?}",
            cell.bg,
            cell.symbol()
        );
    }
    assert!(painted > 0);
}

/// Check the first matching label, including the selection surface underneath it.
pub(crate) fn assert_label(buffer: &Buffer, label: &str, fg: Color, bg: Color) {
    for y in buffer.area.y..buffer.area.bottom() {
        let line: String = (buffer.area.x..buffer.area.right())
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        if let Some(index) = line.find(label) {
            let x = buffer.area.x + line[..index].chars().count() as u16;
            assert_eq!(buffer[(x, y)].fg, fg, "{label} ink");
            assert_eq!(buffer[(x, y)].bg, bg, "{label} background");
            return;
        }
    }
    panic!("missing label {label:?}");
}

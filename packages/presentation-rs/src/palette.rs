//! The default native control palette, also supplied to component previews.
use maestro_ui::UiTheme;
use ratatui::style::Color;
pub fn default_controls() -> UiTheme {
    UiTheme {
        panel: None,
        selection: None,
        surface: Color::Rgb(0x14, 0x11, 0x22),
        text: Color::Rgb(0xe9, 0xe5, 0xf7),
        muted: Color::Rgb(0x9a, 0x92, 0xba),
        border: Color::Rgb(0x3d, 0x32, 0x72),
        focus: Color::Rgb(0x68, 0x57, 0xfe),
        success: Color::Rgb(0x86, 0xef, 0xac),
        attention: Color::Rgb(0xfb, 0xbf, 0x24),
        error: Color::Rgb(0xfc, 0xa5, 0xa5),
    }
}

/// The restrained conversation palette used by the composer and transcript.
pub fn conversation() -> UiTheme {
    use crate::shimmer::{DEIXIC_ACCENT, DEIXIC_BORDER, DEIXIC_MUTED, DEIXIC_SURFACE, DEIXIC_TEXT};
    let color = |(r, g, b)| Color::Rgb(r, g, b);
    UiTheme {
        panel: None,
        selection: None,
        surface: color(DEIXIC_SURFACE),
        text: color(DEIXIC_TEXT),
        muted: color(DEIXIC_MUTED),
        border: color(DEIXIC_BORDER),
        focus: color(DEIXIC_ACCENT),
        success: Color::Rgb(0xa3, 0xbb, 0xa1),
        attention: Color::Rgb(0xcf, 0xb9, 0x87),
        error: Color::Rgb(0xdb, 0x9b, 0x96),
    }
}

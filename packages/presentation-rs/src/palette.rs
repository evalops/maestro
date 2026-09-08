//! The default native control palette, also supplied to component previews.
use maestro_ui::UiTheme;
use ratatui::style::Color;
pub fn default_controls() -> UiTheme {
    conversation()
}

/// The brand palette shared by the composer, transcript, and controls.
pub fn conversation() -> UiTheme {
    use crate::shimmer::{DEIXIC_ACCENT, DEIXIC_BORDER, DEIXIC_MUTED, DEIXIC_SURFACE, DEIXIC_TEXT};
    let color = |(r, g, b)| Color::Rgb(r, g, b);
    UiTheme {
        panel: Some(Color::Rgb(0x21, 0x1f, 0x30)),
        selection: Some(Color::Rgb(0x35, 0x2c, 0x50)),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_controls_and_conversation_share_the_brand_palette() {
        let controls = default_controls();
        assert_eq!(controls, conversation());
        assert_eq!(controls.surface, Color::Rgb(0x17, 0x16, 0x24));
        assert_eq!(controls.focus, Color::Rgb(0x9c, 0x92, 0xfc));
    }
}

//! Semantic colors supplied by the application, without global theme state.
use ratatui::style::{Color, Modifier, Style};

/// Colors shared by controls. `Reset` inherits the terminal palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiTheme {
    /// Control background.
    pub surface: Color,
    /// Optional inset surface for editors and code; omitted themes retain their canvas.
    pub panel: Option<Color>,
    /// Optional selected-row surface. Semantic foregrounds remain unchanged.
    pub selection: Option<Color>,
    /// Primary content.
    pub text: Color,
    /// Descriptions and inactive hints.
    pub muted: Color,
    /// Separators and unfocused borders.
    pub border: Color,
    /// Current selection and keyboard focus.
    pub focus: Color,
    /// Successful outcomes.
    pub success: Color,
    /// Decisions needing attention.
    pub attention: Color,
    /// Invalid values and failed outcomes.
    pub error: Color,
}

impl Default for UiTheme {
    fn default() -> Self {
        Self {
            surface: Color::Reset,
            panel: None,
            selection: None,
            text: Color::Reset,
            muted: Color::DarkGray,
            border: Color::DarkGray,
            focus: Color::Cyan,
            success: Color::Green,
            attention: Color::Yellow,
            error: Color::Red,
        }
    }
}

impl UiTheme {
    /// Quiet accent for decorative outlines; keep focal details in `focus`.
    /// Unknown terminal palettes retain their original accent.
    pub fn decorative_focus(self) -> Color {
        self.blended_focus(65)
    }

    /// Slightly quieter focus for an idle indicator; preserve terminal palettes.
    pub fn resting_focus_style(self) -> Style {
        let style = Style::default().fg(self.blended_focus(80));
        match (self.focus, self.surface) {
            (Color::Rgb(..), Color::Rgb(..)) => style,
            _ => style.add_modifier(Modifier::DIM),
        }
    }

    fn blended_focus(self, percent: u16) -> Color {
        match (self.focus, self.surface) {
            (Color::Rgb(r, g, b), Color::Rgb(sr, sg, sb)) => {
                let blend = |ink: u8, surface: u8| {
                    ((u16::from(ink) * percent + u16::from(surface) * (100 - percent)) / 100) as u8
                };
                Color::Rgb(blend(r, sr), blend(g, sg), blend(b, sb))
            }
            _ => self.focus,
        }
    }

    /// Resolve a palette for controls placed on an inset surface.
    pub fn on_panel(self) -> Self {
        Self {
            surface: self.panel.unwrap_or(self.surface),
            ..self
        }
    }

    /// Primary text on the caller's surface.
    pub fn text_style(self) -> Style {
        Style::default().fg(self.text).bg(self.surface)
    }

    /// Secondary text on the caller's surface.
    pub fn muted_style(self) -> Style {
        Style::default().fg(self.muted).bg(self.surface)
    }

    /// Emphasize selection without replacing semantic foreground colors.
    pub fn selection_style(self) -> Style {
        Style::default()
            .bg(self.selection.unwrap_or(self.surface))
            .add_modifier(Modifier::BOLD)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resting_focus_is_between_outline_and_active_ink() {
        let theme = UiTheme {
            focus: Color::Rgb(100, 120, 200),
            surface: Color::Rgb(0, 0, 0),
            ..Default::default()
        };
        assert_eq!(
            theme.resting_focus_style().fg,
            Some(Color::Rgb(80, 96, 160))
        );
        assert!(
            !theme
                .resting_focus_style()
                .add_modifier
                .contains(Modifier::DIM)
        );
        let indexed = UiTheme {
            focus: Color::Indexed(5),
            ..theme
        };
        assert_eq!(indexed.resting_focus_style().fg, Some(Color::Indexed(5)));
        assert!(
            indexed
                .resting_focus_style()
                .add_modifier
                .contains(Modifier::DIM)
        );
    }

    #[test]
    fn decorative_focus_uses_the_surface_and_preserves_unknown_palettes() {
        let theme = UiTheme {
            focus: Color::Rgb(100, 120, 200),
            surface: Color::Rgb(0, 0, 0),
            ..Default::default()
        };
        assert_eq!(theme.decorative_focus(), Color::Rgb(65, 78, 130));
        assert_eq!(
            UiTheme {
                surface: Color::Rgb(200, 200, 200),
                ..theme
            }
            .decorative_focus(),
            Color::Rgb(135, 148, 200)
        );
        assert_eq!(
            UiTheme {
                surface: Color::Reset,
                ..theme
            }
            .decorative_focus(),
            theme.focus
        );
        assert_eq!(
            UiTheme {
                focus: Color::Indexed(5),
                ..theme
            }
            .decorative_focus(),
            Color::Indexed(5)
        );
    }

    #[test]
    fn selection_keeps_status_ink_and_legacy_palettes_keep_their_surface() {
        let legacy = UiTheme {
            surface: Color::White,
            ..Default::default()
        };
        assert_eq!(legacy.on_panel().surface, legacy.surface);
        assert_eq!(legacy.selection_style().bg, Some(legacy.surface));
        let layered = UiTheme {
            panel: Some(Color::Gray),
            selection: Some(Color::DarkGray),
            ..legacy
        };
        assert_eq!(layered.on_panel().surface, Color::Gray);
        let selected_error = Style::default()
            .fg(Color::Red)
            .patch(layered.selection_style());
        assert_eq!(selected_error.fg, Some(Color::Red));
        assert_eq!(selected_error.bg, Some(Color::DarkGray));
        assert!(selected_error.add_modifier.contains(Modifier::BOLD));
    }
}

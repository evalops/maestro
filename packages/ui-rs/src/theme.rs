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

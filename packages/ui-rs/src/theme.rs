//! Semantic colors supplied by the application, without global theme state.
use ratatui::style::{Color, Modifier, Style};

/// Colors shared by controls. `Reset` inherits the terminal palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiTheme {
    /// Control background.
    pub surface: Color,
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
            .bg(self.surface)
            .add_modifier(Modifier::BOLD)
    }
}

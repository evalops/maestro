//! IPC message types
//!
//! Messages are JSON-encoded, one per line (newline-delimited JSON).

use serde::{Deserialize, Serialize};

use super::RenderNode;

/// Messages sent from TypeScript to the TUI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    /// Render a new frame
    Render {
        /// The render tree root
        root: RenderNode,
        /// Cursor position (if visible)
        cursor: Option<CursorPosition>,
    },

    /// Push lines into terminal scrollback (above viewport)
    PushHistory {
        /// Lines to push into scrollback
        lines: Vec<HistoryLine>,
    },

    /// Terminal was resized (informational, TUI detects this too)
    Resize { width: u16, height: u16 },

    /// Request TUI to exit
    Exit { code: i32 },

    /// Show a notification (desktop notification if terminal unfocused)
    Notify { message: String },
}

/// Messages sent from TUI to TypeScript
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    /// TUI is ready to receive render commands
    Ready {
        width: u16,
        height: u16,
        /// True if terminal supports enhanced keyboard (modifier disambiguation)
        enhanced_keys: bool,
    },

    /// Key press event
    Key {
        key: String,
        modifiers: KeyModifiers,
    },

    /// Paste event (bracketed paste)
    Paste { text: String },

    /// Terminal resized
    Resized { width: u16, height: u16 },

    /// Terminal focus changed
    Focus { focused: bool },

    /// TUI is exiting
    Exiting { code: i32 },

    /// Error occurred
    Error { message: String },
}

/// Cursor position for rendering
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CursorPosition {
    pub x: u16,
    pub y: u16,
}

/// Key modifiers
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct KeyModifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
}

impl KeyModifiers {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn ctrl() -> Self {
        Self {
            ctrl: true,
            ..Default::default()
        }
    }

    pub fn shift() -> Self {
        Self {
            shift: true,
            ..Default::default()
        }
    }

    pub fn alt() -> Self {
        Self {
            alt: true,
            ..Default::default()
        }
    }
}

impl From<crossterm::event::KeyModifiers> for KeyModifiers {
    fn from(mods: crossterm::event::KeyModifiers) -> Self {
        Self {
            shift: mods.contains(crossterm::event::KeyModifiers::SHIFT),
            ctrl: mods.contains(crossterm::event::KeyModifiers::CONTROL),
            alt: mods.contains(crossterm::event::KeyModifiers::ALT),
            meta: mods.contains(crossterm::event::KeyModifiers::META),
        }
    }
}

/// A styled line for history push
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryLine {
    /// Spans of styled text
    pub spans: Vec<StyledSpan>,
}

/// A span of styled text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyledSpan {
    pub text: String,
    #[serde(default)]
    pub style: TextStyle,
}

/// Text styling
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextStyle {
    #[serde(default)]
    pub fg: Option<Color>,
    #[serde(default)]
    pub bg: Option<Color>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub strikethrough: bool,
}

/// Color specification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Color {
    /// Named color
    Named(NamedColor),
    /// RGB color
    Rgb { r: u8, g: u8, b: u8 },
    /// 256-color palette index
    Indexed(u8),
}

/// Named terminal colors
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NamedColor {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    Gray,
    DarkGray,
    LightRed,
    LightGreen,
    LightYellow,
    LightBlue,
    LightMagenta,
    LightCyan,
    Reset,
}

impl From<Color> for ratatui::style::Color {
    fn from(color: Color) -> Self {
        match color {
            Color::Named(named) => match named {
                NamedColor::Black => ratatui::style::Color::Black,
                NamedColor::Red => ratatui::style::Color::Red,
                NamedColor::Green => ratatui::style::Color::Green,
                NamedColor::Yellow => ratatui::style::Color::Yellow,
                NamedColor::Blue => ratatui::style::Color::Blue,
                NamedColor::Magenta => ratatui::style::Color::Magenta,
                NamedColor::Cyan => ratatui::style::Color::Cyan,
                NamedColor::White => ratatui::style::Color::White,
                NamedColor::Gray => ratatui::style::Color::Gray,
                NamedColor::DarkGray => ratatui::style::Color::DarkGray,
                NamedColor::LightRed => ratatui::style::Color::LightRed,
                NamedColor::LightGreen => ratatui::style::Color::LightGreen,
                NamedColor::LightYellow => ratatui::style::Color::LightYellow,
                NamedColor::LightBlue => ratatui::style::Color::LightBlue,
                NamedColor::LightMagenta => ratatui::style::Color::LightMagenta,
                NamedColor::LightCyan => ratatui::style::Color::LightCyan,
                NamedColor::Reset => ratatui::style::Color::Reset,
            },
            Color::Rgb { r, g, b } => ratatui::style::Color::Rgb(r, g, b),
            Color::Indexed(idx) => ratatui::style::Color::Indexed(idx),
        }
    }
}

impl From<TextStyle> for ratatui::style::Style {
    fn from(style: TextStyle) -> Self {
        let mut s = ratatui::style::Style::default();
        if let Some(fg) = style.fg {
            s = s.fg(fg.into());
        }
        if let Some(bg) = style.bg {
            s = s.bg(bg.into());
        }
        if style.bold {
            s = s.add_modifier(ratatui::style::Modifier::BOLD);
        }
        if style.italic {
            s = s.add_modifier(ratatui::style::Modifier::ITALIC);
        }
        if style.underline {
            s = s.add_modifier(ratatui::style::Modifier::UNDERLINED);
        }
        if style.dim {
            s = s.add_modifier(ratatui::style::Modifier::DIM);
        }
        if style.strikethrough {
            s = s.add_modifier(ratatui::style::Modifier::CROSSED_OUT);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inbound_message_parsing() {
        let json = r#"{"type":"render","root":{"type":"text","content":"Hello"},"cursor":null}"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, InboundMessage::Render { .. }));
    }

    #[test]
    fn test_outbound_message_serialization() {
        let msg = OutboundMessage::Ready {
            width: 80,
            height: 24,
            enhanced_keys: true,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("ready"));
    }
}

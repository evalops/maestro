//! Theme System for the TUI
//!
//! This module provides a comprehensive theming system that supports built-in themes
//! and user-defined custom themes loaded from JSON files. Themes control all colors
//! used in the UI, from message backgrounds to syntax highlighting.
//!
//! # Built-in Themes
//!
//! Three themes are included out of the box:
//!
//! - **dark** (default): Dark background with soft, eye-friendly colors
//! - **light**: Light background suitable for bright environments
//! - **high-contrast**: Maximum contrast for accessibility
//!
//! # Custom Themes
//!
//! Users can create custom themes by placing JSON files in:
//!
//! - Global: `~/.composer/themes/<name>.json`
//! - Project: `.composer/themes/<name>.json`
//!
//! ## Theme JSON Format
//!
//! ```json
//! {
//!   "name": "my-theme",
//!   "colors": {
//!     "accent": "#7dd3fc",
//!     "border": "#334155",
//!     "text": "#e2e8f0",
//!     "error": "#fca5a5",
//!     "success": "#86efac",
//!     "md_heading": "#60a5fa",
//!     "syntax_keyword": "#c084fc"
//!   }
//! }
//! ```
//!
//! # Color Format
//!
//! Colors are specified as hex strings:
//!
//! - `#RRGGBB` - Standard hex color (e.g., `#ff0000` for red)
//! - `#RRGGBBAA` - Hex with alpha (alpha is ignored, for compatibility)
//! - `transparent` - No color (uses terminal default)
//!
//! # Color Categories
//!
//! Themes define colors for several categories:
//!
//! - **Core**: `accent`, `border`, `success`, `error`, `warning`, `text`, `muted`, `dim`
//! - **Messages**: `user_message_bg`, `assistant_message_bg`, etc.
//! - **Tools**: `tool_pending_bg`, `tool_success_bg`, `tool_error_bg`
//! - **Markdown**: `md_heading`, `md_link`, `md_code`, `md_quote`
//! - **Syntax**: `syntax_keyword`, `syntax_function`, `syntax_string`, etc.
//! - **Thinking**: `thinking_off`, `thinking_low`, `thinking_medium`, `thinking_high`
//!
//! # Usage Example
//!
//! ```rust,ignore
//! use maestro_tui::themes::{set_theme_by_name, current_theme, available_themes};
//!
//! // List available themes
//! for name in available_themes() {
//!     println!("Theme: {}", name);
//! }
//!
//! // Switch theme
//! set_theme_by_name("light").expect("theme should exist");
//!
//! // Use current theme for styling
//! let theme = current_theme();
//! let heading_style = theme.fg("md_heading");
//! ```
//!
//! # Thread Safety
//!
//! The current theme is stored in a `RwLock` for thread-safe access:
//!
//! - Multiple threads can read the theme simultaneously
//! - Theme changes acquire an exclusive write lock
//! - Theme changes are atomic (no partial updates visible)
//!
//! # Terminal Color Adaptation
//!
//! Colors are automatically adapted to the terminal's color capabilities:
//!
//! - **True Color** (16M colors): Full RGB colors used as-is
//! - **256 Color**: Mapped to nearest ANSI 256 color
//! - **16 Color**: Mapped to nearest basic ANSI color
//!
//! This ensures themes look reasonable even on limited terminals.

use ratatui::style::{Color, Style};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

use crate::palette;

/// Global theme state
static CURRENT_THEME: RwLock<Option<Theme>> = RwLock::new(None);

/// A complete theme definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    /// Theme name
    pub name: String,
    /// Theme colors
    #[serde(default)]
    pub colors: ThemeColors,
    /// Variable definitions (for interpolation)
    #[serde(default)]
    pub vars: HashMap<String, String>,
}

/// Theme color definitions
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeColors {
    // Core colors
    pub accent: String,
    pub border: String,
    pub success: String,
    pub error: String,
    pub warning: String,
    pub muted: String,
    pub dim: String,
    pub text: String,

    // Message colors
    pub user_message_bg: String,
    pub user_message_text: String,
    pub assistant_message_bg: String,
    pub assistant_message_text: String,

    // Tool colors
    pub tool_pending_bg: String,
    pub tool_success_bg: String,
    pub tool_error_bg: String,

    // Markdown colors
    pub md_heading: String,
    pub md_link: String,
    pub md_code: String,
    pub md_code_block: String,
    pub md_code_block_border: String,
    pub md_quote: String,

    // Syntax colors
    pub syntax_comment: String,
    pub syntax_keyword: String,
    pub syntax_function: String,
    pub syntax_variable: String,
    pub syntax_string: String,
    pub syntax_number: String,
    pub syntax_type: String,

    // Thinking indicator colors
    pub thinking_off: String,
    pub thinking_low: String,
    pub thinking_medium: String,
    pub thinking_high: String,
}

impl Default for ThemeColors {
    fn default() -> Self {
        // Default dark theme
        Self {
            accent: "#7dd3fc".to_string(),
            border: "#334155".to_string(),
            success: "#86efac".to_string(),
            error: "#fca5a5".to_string(),
            warning: "#fbbf24".to_string(),
            muted: "#94a3b8".to_string(),
            dim: "#64748b".to_string(),
            text: "#e2e8f0".to_string(),

            user_message_bg: "#1e293b".to_string(),
            user_message_text: "#e2e8f0".to_string(),
            assistant_message_bg: "transparent".to_string(),
            assistant_message_text: "#e2e8f0".to_string(),

            tool_pending_bg: "#1e293b".to_string(),
            tool_success_bg: "#14532d20".to_string(),
            tool_error_bg: "#7f1d1d20".to_string(),

            md_heading: "#60a5fa".to_string(),
            md_link: "#7dd3fc".to_string(),
            md_code: "#fde047".to_string(),
            md_code_block: "#1e293b".to_string(),
            md_code_block_border: "#334155".to_string(),
            md_quote: "#94a3b8".to_string(),

            syntax_comment: "#64748b".to_string(),
            syntax_keyword: "#c084fc".to_string(),
            syntax_function: "#60a5fa".to_string(),
            syntax_variable: "#fbbf24".to_string(),
            syntax_string: "#86efac".to_string(),
            syntax_number: "#fb923c".to_string(),
            syntax_type: "#f472b6".to_string(),

            thinking_off: "#64748b".to_string(),
            thinking_low: "#fbbf24".to_string(),
            thinking_medium: "#60a5fa".to_string(),
            thinking_high: "#c084fc".to_string(),
        }
    }
}

impl Theme {
    /// Create a new theme
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            colors: ThemeColors::default(),
            vars: HashMap::new(),
        }
    }

    /// Load a theme from a JSON file
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, ThemeError> {
        let content = std::fs::read_to_string(path.as_ref())
            .map_err(|e| ThemeError::IoError(e.to_string()))?;
        Self::load_from_str(&content)
    }

    /// Load a theme from a JSON string
    pub fn load_from_str(json: &str) -> Result<Self, ThemeError> {
        serde_json::from_str(json).map_err(|e| ThemeError::ParseError(e.to_string()))
    }

    /// Get a color by name
    #[must_use]
    pub fn get_color(&self, name: &str) -> Option<Color> {
        let hex = match name {
            "accent" => &self.colors.accent,
            "border" => &self.colors.border,
            "success" => &self.colors.success,
            "error" => &self.colors.error,
            "warning" => &self.colors.warning,
            "muted" => &self.colors.muted,
            "dim" => &self.colors.dim,
            "text" => &self.colors.text,
            "user_message_bg" => &self.colors.user_message_bg,
            "user_message_text" => &self.colors.user_message_text,
            "md_heading" => &self.colors.md_heading,
            "md_link" => &self.colors.md_link,
            "md_code" => &self.colors.md_code,
            "syntax_comment" => &self.colors.syntax_comment,
            "syntax_keyword" => &self.colors.syntax_keyword,
            "syntax_function" => &self.colors.syntax_function,
            "syntax_variable" => &self.colors.syntax_variable,
            "syntax_string" => &self.colors.syntax_string,
            "syntax_number" => &self.colors.syntax_number,
            "syntax_type" => &self.colors.syntax_type,
            _ => return None,
        };
        parse_color(hex)
    }

    /// Get a style with foreground color
    #[must_use]
    pub fn fg(&self, color_name: &str) -> Style {
        match self.get_color(color_name) {
            Some(color) => Style::default().fg(color),
            None => Style::default(),
        }
    }

    /// Get a style with background color
    #[must_use]
    pub fn bg(&self, color_name: &str) -> Style {
        match self.get_color(color_name) {
            Some(color) => Style::default().bg(color),
            None => Style::default(),
        }
    }
}

/// Parse a hex color string
fn parse_color(hex: &str) -> Option<Color> {
    if hex == "transparent" || hex.is_empty() {
        return None;
    }

    let hex = hex.trim_start_matches('#');

    // Handle 8-character hex with alpha (ignore alpha)
    let hex = if hex.len() == 8 { &hex[..6] } else { hex };

    if hex.len() != 6 {
        return None;
    }

    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;

    Some(palette::best_color(r, g, b))
}

/// Error type for theme operations
#[derive(Debug, Clone)]
pub enum ThemeError {
    IoError(String),
    ParseError(String),
    NotFound(String),
}

impl std::fmt::Display for ThemeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThemeError::IoError(msg) => write!(f, "IO error: {msg}"),
            ThemeError::ParseError(msg) => write!(f, "Parse error: {msg}"),
            ThemeError::NotFound(msg) => write!(f, "Theme not found: {msg}"),
        }
    }
}

impl std::error::Error for ThemeError {}

// =============================================================================
// Built-in themes
// =============================================================================

/// Get the dark theme (default)
#[must_use]
pub fn dark_theme() -> Theme {
    Theme::new("dark")
}

/// Get the light theme
#[must_use]
pub fn light_theme() -> Theme {
    let mut theme = Theme::new("light");
    theme.colors = ThemeColors {
        accent: "#0284c7".to_string(),
        border: "#cbd5e1".to_string(),
        success: "#16a34a".to_string(),
        error: "#dc2626".to_string(),
        warning: "#d97706".to_string(),
        muted: "#64748b".to_string(),
        dim: "#94a3b8".to_string(),
        text: "#1e293b".to_string(),

        user_message_bg: "#f1f5f9".to_string(),
        user_message_text: "#1e293b".to_string(),
        assistant_message_bg: "transparent".to_string(),
        assistant_message_text: "#1e293b".to_string(),

        tool_pending_bg: "#f1f5f9".to_string(),
        tool_success_bg: "#dcfce7".to_string(),
        tool_error_bg: "#fee2e2".to_string(),

        md_heading: "#1d4ed8".to_string(),
        md_link: "#0284c7".to_string(),
        md_code: "#a16207".to_string(),
        md_code_block: "#f1f5f9".to_string(),
        md_code_block_border: "#cbd5e1".to_string(),
        md_quote: "#64748b".to_string(),

        syntax_comment: "#94a3b8".to_string(),
        syntax_keyword: "#7c3aed".to_string(),
        syntax_function: "#1d4ed8".to_string(),
        syntax_variable: "#a16207".to_string(),
        syntax_string: "#16a34a".to_string(),
        syntax_number: "#c2410c".to_string(),
        syntax_type: "#be185d".to_string(),

        thinking_off: "#94a3b8".to_string(),
        thinking_low: "#d97706".to_string(),
        thinking_medium: "#1d4ed8".to_string(),
        thinking_high: "#7c3aed".to_string(),
    };
    theme
}

/// Get the high contrast theme
#[must_use]
pub fn high_contrast_theme() -> Theme {
    let mut theme = Theme::new("high-contrast");
    theme.colors = ThemeColors {
        accent: "#00ffff".to_string(),
        border: "#ffffff".to_string(),
        success: "#00ff00".to_string(),
        error: "#ff0000".to_string(),
        warning: "#ffff00".to_string(),
        muted: "#c0c0c0".to_string(),
        dim: "#808080".to_string(),
        text: "#ffffff".to_string(),

        user_message_bg: "#000080".to_string(),
        user_message_text: "#ffffff".to_string(),
        assistant_message_bg: "transparent".to_string(),
        assistant_message_text: "#ffffff".to_string(),

        tool_pending_bg: "#000080".to_string(),
        tool_success_bg: "#004400".to_string(),
        tool_error_bg: "#440000".to_string(),

        md_heading: "#00ffff".to_string(),
        md_link: "#00ffff".to_string(),
        md_code: "#ffff00".to_string(),
        md_code_block: "#000080".to_string(),
        md_code_block_border: "#ffffff".to_string(),
        md_quote: "#c0c0c0".to_string(),

        syntax_comment: "#808080".to_string(),
        syntax_keyword: "#ff00ff".to_string(),
        syntax_function: "#00ffff".to_string(),
        syntax_variable: "#ffff00".to_string(),
        syntax_string: "#00ff00".to_string(),
        syntax_number: "#ff8000".to_string(),
        syntax_type: "#ff00ff".to_string(),

        thinking_off: "#808080".to_string(),
        thinking_low: "#ffff00".to_string(),
        thinking_medium: "#00ffff".to_string(),
        thinking_high: "#ff00ff".to_string(),
    };
    theme
}

// =============================================================================
// Theme management
// =============================================================================

/// Get all available theme names
#[must_use]
pub fn available_themes() -> Vec<String> {
    let mut themes = vec![
        "dark".to_string(),
        "light".to_string(),
        "high-contrast".to_string(),
    ];

    // Look for user themes
    if let Some(home) = dirs::home_dir() {
        let user_themes_dir = home.join(".composer").join("themes");
        if let Ok(entries) = std::fs::read_dir(&user_themes_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.path().file_stem() {
                    if let Some(name) = name.to_str() {
                        if !themes.contains(&name.to_string()) {
                            themes.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    // Look for project themes
    let project_themes_dir = std::path::Path::new(".composer/themes");
    if let Ok(entries) = std::fs::read_dir(project_themes_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.path().file_stem() {
                if let Some(name) = name.to_str() {
                    if !themes.contains(&name.to_string()) {
                        themes.push(name.to_string());
                    }
                }
            }
        }
    }

    themes
}

/// Load a theme by name
pub fn load_theme(name: &str) -> Result<Theme, ThemeError> {
    // Check built-in themes first
    match name {
        "dark" => return Ok(dark_theme()),
        "light" => return Ok(light_theme()),
        "high-contrast" => return Ok(high_contrast_theme()),
        _ => {}
    }

    // Try user themes directory
    if let Some(home) = dirs::home_dir() {
        let path = home
            .join(".composer")
            .join("themes")
            .join(format!("{name}.json"));
        if path.exists() {
            return Theme::load_from_file(&path);
        }
    }

    // Try project themes directory
    let path = std::path::Path::new(".composer/themes").join(format!("{name}.json"));
    if path.exists() {
        return Theme::load_from_file(&path);
    }

    Err(ThemeError::NotFound(name.to_string()))
}

/// Set the current theme
pub fn set_theme(theme: Theme) {
    if let Ok(mut current) = CURRENT_THEME.write() {
        *current = Some(theme);
    }
}

/// Set the current theme by name
pub fn set_theme_by_name(name: &str) -> Result<(), ThemeError> {
    let theme = load_theme(name)?;
    set_theme(theme);
    Ok(())
}

/// Get the current theme
pub fn current_theme() -> Theme {
    if let Ok(current) = CURRENT_THEME.read() {
        if let Some(ref theme) = *current {
            return theme.clone();
        }
    }
    dark_theme()
}

/// Get the current theme name
#[must_use]
pub fn current_theme_name() -> String {
    current_theme().name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_color() {
        let color = parse_color("#ff0000");
        assert!(color.is_some());
    }

    #[test]
    fn parse_transparent() {
        let color = parse_color("transparent");
        assert!(color.is_none());
    }

    #[test]
    fn parse_hex_with_alpha() {
        let color = parse_color("#ff000080");
        assert!(color.is_some());
    }

    #[test]
    fn default_theme_colors() {
        let colors = ThemeColors::default();
        assert!(!colors.accent.is_empty());
        assert!(!colors.text.is_empty());
    }

    #[test]
    fn built_in_themes_exist() {
        let themes = available_themes();
        assert!(themes.contains(&"dark".to_string()));
        assert!(themes.contains(&"light".to_string()));
        assert!(themes.contains(&"high-contrast".to_string()));
    }

    #[test]
    fn load_built_in_theme() {
        let theme = load_theme("dark").unwrap();
        assert_eq!(theme.name, "dark");
    }

    #[test]
    fn theme_get_color() {
        let theme = dark_theme();
        let color = theme.get_color("accent");
        assert!(color.is_some());
    }

    #[test]
    fn set_and_get_theme() {
        set_theme(light_theme());
        assert_eq!(current_theme_name(), "light");
        // Reset to dark
        set_theme(dark_theme());
    }
}

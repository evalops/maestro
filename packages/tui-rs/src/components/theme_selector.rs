//! Theme selector modal
//!
//! Provides a UI for selecting UI themes.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
    Frame,
};

use crate::themes;

/// Theme selector modal state
pub struct ThemeSelector {
    /// Available theme names
    themes: Vec<String>,
    /// Current search query
    query: String,
    /// Cursor position in query
    cursor: usize,
    /// Filtered themes
    filtered: Vec<usize>,
    /// Selected index (in filtered list)
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// Current theme name (for highlighting)
    current_theme: Option<String>,
}

impl Default for ThemeSelector {
    fn default() -> Self {
        Self::new()
    }
}

impl ThemeSelector {
    /// Create a new theme selector
    #[must_use]
    pub fn new() -> Self {
        let theme_list = themes::available_themes();
        let filtered: Vec<usize> = (0..theme_list.len()).collect();
        Self {
            themes: theme_list,
            query: String::new(),
            cursor: 0,
            filtered,
            selected: 0,
            visible: false,
            current_theme: None,
        }
    }

    /// Set the current theme (for highlighting)
    pub fn set_current_theme(&mut self, theme_name: Option<String>) {
        self.current_theme = theme_name;
    }

    /// Show the modal
    pub fn show(&mut self) {
        self.visible = true;
        self.query.clear();
        self.cursor = 0;
        self.selected = 0;
        self.current_theme = Some(themes::current_theme_name());
        self.filter();
    }

    /// Hide the modal
    pub fn hide(&mut self) {
        self.visible = false;
    }

    /// Check if visible
    #[must_use]
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Insert a character
    pub fn insert_char(&mut self, c: char) {
        self.query.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.filter();
    }

    /// Delete character before cursor
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self.query[..self.cursor]
                .chars()
                .last()
                .map_or(0, char::len_utf8);
            self.query.remove(self.cursor - prev);
            self.cursor -= prev;
            self.filter();
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            let prev = self.query[..self.cursor]
                .chars()
                .last()
                .map_or(0, char::len_utf8);
            self.cursor -= prev;
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        if self.cursor < self.query.len() {
            let next = self.query[self.cursor..]
                .chars()
                .next()
                .map_or(0, char::len_utf8);
            self.cursor += next;
        }
    }

    /// Move selection up
    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.filtered.len() {
            self.selected += 1;
        }
    }

    /// Get the selected theme name
    #[must_use]
    pub fn selected_theme(&self) -> Option<&str> {
        self.filtered
            .get(self.selected)
            .and_then(|&idx| self.themes.get(idx))
            .map(std::string::String::as_str)
    }

    /// Confirm selection and return the theme name
    pub fn confirm(&mut self) -> Option<String> {
        let name = self.selected_theme().map(std::string::ToString::to_string);
        self.hide();
        name
    }

    /// Filter themes based on query
    fn filter(&mut self) {
        let query = self.query.to_lowercase();
        self.filtered = self
            .themes
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                if query.is_empty() {
                    return true;
                }
                t.to_lowercase().contains(&query)
            })
            .map(|(i, _)| i)
            .collect();

        // Reset selection if out of bounds
        if self.selected >= self.filtered.len() {
            self.selected = 0;
        }
    }

    /// Render the modal
    pub fn render(&self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Calculate modal size
        let modal_width = 50.min(area.width.saturating_sub(4));
        let modal_height = 12.min(area.height.saturating_sub(4));
        let modal_x = (area.width.saturating_sub(modal_width)) / 2;
        let modal_y = (area.height.saturating_sub(modal_height)) / 2;

        let modal_area = Rect {
            x: area.x + modal_x,
            y: area.y + modal_y,
            width: modal_width,
            height: modal_height,
        };

        // Clear the area
        frame.render_widget(Clear, modal_area);

        // Create the outer block
        let block = Block::default()
            .title(" Select Theme ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Magenta))
            .style(Style::default().bg(Color::Black));

        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        // Layout: search box + list
        let chunks = Layout::vertical([Constraint::Length(3), Constraint::Min(1)]).split(inner);

        // Search input
        let search_block = Block::default()
            .title(" Search ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let search_text = if self.query.is_empty() {
            Paragraph::new("Type to filter themes...")
                .style(Style::default().fg(Color::DarkGray))
                .block(search_block)
        } else {
            Paragraph::new(self.query.as_str())
                .style(Style::default().fg(Color::White))
                .block(search_block)
        };

        frame.render_widget(search_text, chunks[0]);

        // Theme list
        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .enumerate()
            .map(|(i, &theme_idx)| {
                let theme_name = &self.themes[theme_idx];
                let is_selected = i == self.selected;
                let is_current = self.current_theme.as_ref().is_some_and(|c| c == theme_name);

                let style = if is_selected {
                    Style::default().bg(Color::DarkGray).fg(Color::White)
                } else {
                    Style::default()
                };

                let mut spans = vec![Span::styled(
                    theme_name.clone(),
                    style.add_modifier(Modifier::BOLD),
                )];

                if is_current {
                    spans.push(Span::styled(
                        " (current)",
                        Style::default().fg(Color::Green),
                    ));
                }

                ListItem::new(Line::from(spans))
            })
            .collect();

        let list = List::new(items);
        frame.render_widget(list, chunks[1]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_theme_selector_creation() {
        let selector = ThemeSelector::new();
        assert!(!selector.is_visible());
        assert!(!selector.themes.is_empty());
    }

    #[test]
    fn test_theme_selector_show_hide() {
        let mut selector = ThemeSelector::new();
        selector.show();
        assert!(selector.is_visible());
        selector.hide();
        assert!(!selector.is_visible());
    }

    #[test]
    fn test_theme_selector_navigation() {
        let mut selector = ThemeSelector::new();
        selector.show();

        assert_eq!(selector.selected, 0);
        if selector.filtered.len() > 1 {
            selector.move_down();
            assert_eq!(selector.selected, 1);
            selector.move_up();
            assert_eq!(selector.selected, 0);
        }
    }

    #[test]
    fn test_theme_selector_confirm() {
        let mut selector = ThemeSelector::new();
        selector.show();

        let theme_name = selector.confirm();
        assert!(theme_name.is_some());
        assert!(!selector.is_visible());
    }
}

//! Command palette modal
//!
//! Provides fuzzy search over slash commands.

use std::sync::Arc;

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
    Frame,
};

use crate::commands::{CommandMatch, CommandRegistry, SlashCommandMatcher};

/// Command palette modal state
pub struct CommandPalette {
    /// Command matcher for fuzzy search
    matcher: SlashCommandMatcher,
    /// Current search query
    query: String,
    /// Cursor position in query
    cursor: usize,
    /// Matched commands
    matches: Vec<CommandMatch>,
    /// Selected index
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
}

impl CommandPalette {
    /// Create a new command palette
    pub fn new(registry: Arc<CommandRegistry>) -> Self {
        Self {
            matcher: SlashCommandMatcher::new(registry),
            query: String::new(),
            cursor: 0,
            matches: Vec::new(),
            selected: 0,
            visible: false,
        }
    }

    /// Update the registry
    pub fn update_registry(&mut self, registry: Arc<CommandRegistry>) {
        self.matcher = SlashCommandMatcher::new(registry);
        self.search();
    }

    /// Show the modal
    pub fn show(&mut self) {
        self.visible = true;
        self.query.clear();
        self.cursor = 0;
        self.selected = 0;
        self.search();
    }

    /// Hide the modal
    pub fn hide(&mut self) {
        self.visible = false;
    }

    /// Check if visible
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Insert a character
    pub fn insert_char(&mut self, c: char) {
        self.query.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.search();
    }

    /// Delete character before cursor
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self.query[..self.cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.query.remove(self.cursor - prev);
            self.cursor -= prev;
            self.search();
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            let prev = self.query[..self.cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.cursor -= prev;
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        if self.cursor < self.query.len() {
            let next = self.query[self.cursor..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
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
        if self.selected + 1 < self.matches.len() {
            self.selected += 1;
        }
    }

    /// Get the selected command
    pub fn selected_command(&self) -> Option<&CommandMatch> {
        self.matches.get(self.selected)
    }

    /// Confirm selection and return the command name
    pub fn confirm(&mut self) -> Option<String> {
        let name = self.selected_command().map(|m| m.command.name.clone());
        self.hide();
        name
    }

    /// Perform the search
    fn search(&mut self) {
        self.matches = self.matcher.get_matches(&self.query);
        // Limit to 15 results
        self.matches.truncate(15);
        // Reset selection if out of bounds
        if self.selected >= self.matches.len() {
            self.selected = 0;
        }
    }

    /// Render the modal
    pub fn render(&self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Center the modal
        let modal_width = area.width.min(70).max(45);
        let modal_height = area.height.min(20).max(10);
        let modal_x = (area.width.saturating_sub(modal_width)) / 2;
        let modal_y = (area.height.saturating_sub(modal_height)) / 2;

        let modal_area = Rect {
            x: area.x + modal_x,
            y: area.y + modal_y,
            width: modal_width,
            height: modal_height,
        };

        // Clear background
        frame.render_widget(Clear, modal_area);

        // Draw modal block
        let block = Block::default()
            .title(" Commands ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Green))
            .style(Style::default().bg(Color::Black));

        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        // Layout: input at top, results below
        let chunks = Layout::vertical([Constraint::Length(3), Constraint::Min(1)]).split(inner);

        // Render input (cursor is rendered inline)
        self.render_input(frame, chunks[0]);

        // Render results
        self.render_results(frame, chunks[1]);
    }

    fn render_input(&self, frame: &mut Frame, area: Rect) {
        let input_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let input_text = format!("/{}", self.query);
        let input = Paragraph::new(input_text)
            .style(Style::default().fg(Color::White))
            .block(input_block);

        frame.render_widget(input, area);

        // Position cursor inside input (after the "/" prefix)
        use unicode_width::UnicodeWidthStr;
        let inner_x = area.x + 1 + 1; // +1 for border, +1 for "/"
        let inner_y = area.y + 1;
        let col = self.query[..self.cursor.min(self.query.len())].width() as u16;
        frame.set_cursor_position((inner_x + col, inner_y));
    }

    fn render_results(&self, frame: &mut Frame, area: Rect) {
        if self.matches.is_empty() {
            let empty_msg = if self.query.is_empty() {
                "Type to search commands..."
            } else {
                "No matching commands"
            };
            let paragraph =
                Paragraph::new(empty_msg).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
            return;
        }

        let items: Vec<ListItem> = self
            .matches
            .iter()
            .enumerate()
            .map(|(i, m)| self.render_command(m, i == self.selected))
            .collect();

        let list = List::new(items);
        frame.render_widget(list, area);
    }

    fn render_command(&self, m: &CommandMatch, selected: bool) -> ListItem<'static> {
        let mut spans = Vec::new();

        // Command name
        spans.push(Span::styled(
            format!("/{}", m.command.name),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(if selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ));

        // Description
        if !m.command.description.is_empty() {
            spans.push(Span::styled(
                format!("  {}", m.command.description),
                Style::default().fg(Color::DarkGray),
            ));
        }

        let style = if selected {
            Style::default().bg(Color::DarkGray)
        } else {
            Style::default()
        };

        ListItem::new(Line::from(spans)).style(style)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::build_command_registry;

    #[test]
    fn command_palette_basics() {
        let registry = Arc::new(build_command_registry());
        let mut palette = CommandPalette::new(registry);

        assert!(!palette.is_visible());

        palette.show();
        assert!(palette.is_visible());
        assert!(!palette.matches.is_empty()); // Should show all commands initially

        palette.insert_char('h');
        palette.insert_char('e');
        palette.insert_char('l');
        palette.insert_char('p');

        // Should match /help
        assert!(palette
            .matches
            .iter()
            .any(|m| m.command.name == "help"));

        palette.hide();
        assert!(!palette.is_visible());
    }

    #[test]
    fn navigation() {
        let registry = Arc::new(build_command_registry());
        let mut palette = CommandPalette::new(registry);
        palette.show();

        let initial_count = palette.matches.len();
        assert!(initial_count > 0);

        assert_eq!(palette.selected, 0);
        palette.move_down();
        assert_eq!(palette.selected, 1);
        palette.move_up();
        assert_eq!(palette.selected, 0);
        palette.move_up(); // At start, should stay
        assert_eq!(palette.selected, 0);
    }
}

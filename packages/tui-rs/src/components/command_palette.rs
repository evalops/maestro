//! Command palette modal with fuzzy search
//!
//! This module implements a command palette (similar to VS Code's Cmd+P or Sublime's
//! Cmd+Shift+P) for discovering and executing slash commands via fuzzy search.
//!
//! # Architecture
//!
//! ## `CommandPalette` (Stateful Component)
//!
//! The `CommandPalette` struct maintains:
//! - `matcher`: Fuzzy search engine (`SlashCommandMatcher`) over command registry
//! - `query`: Current search text
//! - `cursor`: Cursor position in the search query
//! - `matches`: Filtered command results (limited to 15)
//! - `selected`: Index of the currently highlighted command
//! - `visible`: Whether the modal is shown
//!
//! This is a **stateful widget** that maintains its own state across renders.
//!
//! ## Fuzzy Search
//!
//! The palette uses `SlashCommandMatcher` (from `crate::commands`) to perform fuzzy
//! matching on command names and descriptions. Results are ranked by match quality
//! and limited to 15 to keep the UI responsive.
//!
//! When the search query is empty, all commands are shown (also limited to 15).
//!
//! # Widget Trait Implementation
//!
//! `CommandPalette` implements rendering via a `render()` method (not the Widget trait
//! directly) that takes a `&mut Frame`:
//!
//! 1. Calculates centered modal position (45-70 cols wide, 10-20 rows tall)
//! 2. Clears background with `Clear` widget
//! 3. Draws bordered block with green accent (command mode color)
//! 4. Uses vertical layout to split into:
//!    - Input box (3 rows) with inline cursor rendering
//!    - Results list (remaining space)
//!
//! ## Input Rendering
//!
//! The search input is rendered with:
//! - Prefix `/` to indicate slash command
//! - User query text
//! - Cursor positioned using `frame.set_cursor_position()`
//! - Unicode-aware cursor positioning via `UnicodeWidthStr`
//!
//! ## Results Rendering
//!
//! Results are rendered as a `List` widget with:
//! - Command name in cyan (`/command`)
//! - Description in dark gray
//! - Selected item highlighted with dark gray background
//! - Empty state messages ("Type to search..." or "No matching commands")
//!
//! # Keyboard Event Handling
//!
//! The palette provides methods for handling keyboard input:
//!
//! ## Text Input
//! - `insert_char(c)`: Insert character at cursor, update search
//! - `backspace()`: Delete character before cursor, update search
//! - `move_left()` / `move_right()`: Navigate cursor within query
//!
//! ## Navigation
//! - `move_up()` / `move_down()`: Navigate through search results
//! - Selection wraps at bounds (stays at 0 or max)
//!
//! ## Selection
//! - `selected_command()`: Get the currently highlighted command
//! - `confirm()`: Return selected command name and hide modal
//!
//! All text input methods trigger `search()` which updates the `matches` list.
//!
//! # Usage Pattern
//!
//! ```rust,ignore
//! // Create palette with command registry
//! let mut palette = CommandPalette::new(Arc::new(registry));
//!
//! // Show modal (typically bound to Ctrl+K)
//! palette.show();
//!
//! // Handle keyboard events
//! match key_code {
//!     KeyCode::Char(c) => palette.insert_char(c),
//!     KeyCode::Backspace => palette.backspace(),
//!     KeyCode::Up => palette.move_up(),
//!     KeyCode::Down => palette.move_down(),
//!     KeyCode::Enter => {
//!         if let Some(cmd) = palette.confirm() {
//!             // Execute command
//!         }
//!     }
//!     KeyCode::Esc => palette.hide(),
//!     _ => {}
//! }
//!
//! // Render if visible
//! if palette.is_visible() {
//!     palette.render(&mut frame, frame.area());
//! }
//! ```
//!
//! # Search Implementation
//!
//! The `search()` method:
//! 1. Calls `matcher.get_matches(&query)` to perform fuzzy search
//! 2. Truncates results to 15 items (performance + UX)
//! 3. Resets selection to 0 if out of bounds
//!
//! The fuzzy matcher (from `crate::commands`) scores matches based on:
//! - Command name matching
//! - Description matching
//! - Match quality (consecutive characters, word boundaries, etc.)
//!
//! # Layout Details
//!
//! Modal layout:
//! ```text
//! ┌─ Commands ──────────┐
//! │ ┌──────────────────┐│
//! │ │ /query_          ││  <- Input (3 rows, bordered)
//! │ └──────────────────┘│
//! │                     │
//! │ /help  Show help   │  <- Results (List widget)
//! │ /quit  Exit app    │
//! │ ...                 │
//! └─────────────────────┘
//! ```
//!
//! # Registry Updates
//!
//! The palette holds an `Arc<CommandRegistry>` for efficiency. If the registry needs
//! to be updated at runtime, use `update_registry()` which replaces the matcher and
//! refreshes search results.
//!
//! # Performance Considerations
//!
//! - Search is performed on every keystroke
//! - Results are limited to 15 to keep rendering fast
//! - Fuzzy matching is optimized for command lists (typically < 50 commands)
//! - Cursor calculation uses unicode width (not byte length) for correct display

use std::sync::Arc;

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::commands::{CommandMatch, CommandRegistry, SlashCommandMatcher};

/// Stateful command palette modal with fuzzy search.
///
/// Maintains search query state, cursor position, and filtered command matches.
/// Designed to help users discover and execute slash commands via keyboard-driven
/// fuzzy search.
///
/// # State Management
///
/// The palette is a stateful widget that tracks:
/// - Current search query and cursor position
/// - Filtered/matched commands (limited to 15 results)
/// - Selected command index
/// - Modal visibility
///
/// # Rendering
///
/// Unlike most widgets, `CommandPalette` provides a `render(&mut Frame)` method
/// instead of implementing the `Widget` trait directly. This allows it to manage
/// cursor positioning via `frame.set_cursor_position()`.
///
/// # Example
///
/// ```rust,ignore
/// let mut palette = CommandPalette::new(registry);
/// palette.show();
///
/// // In event loop
/// match key {
///     KeyCode::Char(c) => palette.insert_char(c),
///     KeyCode::Backspace => palette.backspace(),
///     KeyCode::Up => palette.move_up(),
///     KeyCode::Down => palette.move_down(),
///     KeyCode::Enter => {
///         if let Some(cmd) = palette.confirm() {
///             execute_command(cmd);
///         }
///     }
/// }
///
/// // In render loop
/// if palette.is_visible() {
///     palette.render(frame, frame.area());
/// }
/// ```
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
    /// List state for scrolling
    list_state: ListState,
}

impl CommandPalette {
    /// Create a new command palette
    #[must_use]
    pub fn new(registry: Arc<CommandRegistry>) -> Self {
        Self {
            matcher: SlashCommandMatcher::new(registry),
            query: String::new(),
            cursor: 0,
            matches: Vec::new(),
            selected: 0,
            visible: false,
            list_state: ListState::default(),
        }
    }

    /// Update the registry
    pub fn update_registry(&mut self, registry: Arc<CommandRegistry>) {
        self.matcher = SlashCommandMatcher::new(registry);
        self.search();
    }

    /// Show the modal and reset search state.
    ///
    /// Clears the query, resets cursor and selection, and performs an initial
    /// search to populate results with all commands.
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
    #[must_use]
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Insert a character at the cursor position and update search results.
    ///
    /// Handles unicode characters correctly by using character byte length.
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
                .map_or(0, char::len_utf8);
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
            self.sync_list_state();
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.matches.len() {
            self.selected += 1;
            self.sync_list_state();
        }
    }

    /// Get the selected command
    #[must_use]
    pub fn selected_command(&self) -> Option<&CommandMatch> {
        self.matches.get(self.selected)
    }

    /// Confirm the selected command, hide the modal, and return the command name.
    ///
    /// Returns `None` if no command is selected or if the results list is empty.
    pub fn confirm(&mut self) -> Option<String> {
        let name = self.selected_command().map(|m| m.command.name.clone());
        self.hide();
        name
    }

    /// Perform fuzzy search and update match results.
    ///
    /// Uses `SlashCommandMatcher` to find commands matching the query, then:
    /// 1. Truncates to 15 results (performance + UX)
    /// 2. Resets selection to 0 if out of bounds
    ///
    /// Called automatically by text input methods.
    fn search(&mut self) {
        self.matches = self.matcher.get_matches(&self.query);
        // Limit to 15 results
        self.matches.truncate(15);
        // Reset selection if out of bounds
        if self.selected >= self.matches.len() {
            self.selected = 0;
        }
        self.sync_list_state();
    }

    /// Sync the list state with the current selection
    fn sync_list_state(&mut self) {
        if self.matches.is_empty() {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(self.selected));
        }
    }

    /// Render the command palette modal to the frame.
    ///
    /// This method:
    /// 1. Calculates centered modal position
    /// 2. Clears background
    /// 3. Renders bordered block with green accent
    /// 4. Lays out input and results sections
    /// 5. Sets cursor position for the input field
    ///
    /// Does nothing if the modal is not visible.
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Center the modal
        let modal_width = area.width.clamp(45, 70);
        let modal_height = area.height.clamp(10, 20);
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

    fn render_results(&mut self, frame: &mut Frame, area: Rect) {
        if self.matches.is_empty() {
            let empty_msg = if self.query.is_empty() {
                "Type to search commands..."
            } else {
                "No matching commands"
            };
            let paragraph = Paragraph::new(empty_msg).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
            return;
        }

        let items: Vec<ListItem> = self
            .matches
            .iter()
            .enumerate()
            .map(|(i, m)| self.render_command(m, i == self.selected))
            .collect();

        let list = List::new(items).highlight_style(Style::default().bg(Color::DarkGray));
        frame.render_stateful_widget(list, area, &mut self.list_state);
    }

    fn render_command(&self, m: &CommandMatch, selected: bool) -> ListItem<'static> {
        let mut spans = Vec::new();

        // Command name
        spans.push(Span::styled(
            format!("/{}", m.command.name),
            Style::default().fg(Color::Cyan).add_modifier(if selected {
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
        assert!(palette.matches.iter().any(|m| m.command.name == "help"));

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

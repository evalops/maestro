//! File search modal for @ mentions
//!
//! Provides fuzzy file search with live preview.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::files::{highlight_matches, FileMatch, FileSearch, FileSearchResult, WorkspaceFile};

/// File search modal state
pub struct FileSearchModal {
    /// Current search query
    query: String,
    /// Cursor position in query
    cursor: usize,
    /// Available files to search
    files: Vec<WorkspaceFile>,
    /// Current search results
    results: FileSearchResult,
    /// Selected index
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// List state for scrolling
    list_state: ListState,
}

impl FileSearchModal {
    /// Create a new file search modal
    #[must_use]
    pub fn new() -> Self {
        Self {
            query: String::new(),
            cursor: 0,
            files: Vec::new(),
            results: FileSearchResult::default(),
            selected: 0,
            visible: false,
            list_state: ListState::default(),
        }
    }

    /// Set the available files
    pub fn set_files(&mut self, files: Vec<WorkspaceFile>) {
        self.files = files;
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
    #[must_use]
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
            self.list_state.select(Some(self.selected));
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.results.matches.len() {
            self.selected += 1;
            self.list_state.select(Some(self.selected));
        }
    }

    /// Get the selected file
    #[must_use]
    pub fn selected_file(&self) -> Option<&WorkspaceFile> {
        self.results.matches.get(self.selected).map(|m| &m.file)
    }

    /// Confirm selection and return the file
    pub fn confirm(&mut self) -> Option<WorkspaceFile> {
        let file = self.selected_file().cloned();
        self.hide();
        file
    }

    /// Perform the search
    fn search(&mut self) {
        let searcher = FileSearch::new(self.files.clone()).max_results(20);
        self.results = searcher.search(&self.query);
        // Reset selection if out of bounds
        if self.selected >= self.results.matches.len() {
            self.selected = 0;
        }
        // Sync list state
        if self.results.matches.is_empty() {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(self.selected));
        }
    }

    /// Render the modal
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Center the modal
        let modal_width = area.width.clamp(40, 60);
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
            .title(" Search Files (@) ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
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

    fn render_input(&mut self, frame: &mut Frame, area: Rect) {
        let input_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let input = Paragraph::new(self.query.as_str())
            .style(Style::default().fg(Color::White))
            .block(input_block);

        frame.render_widget(input, area);

        // Position cursor inside input
        use unicode_width::UnicodeWidthStr;
        let inner_x = area.x + 1;
        let inner_y = area.y + 1;
        let col = self.query[..self.cursor.min(self.query.len())].width() as u16;
        frame.set_cursor_position((inner_x + col, inner_y));
    }

    fn render_results(&mut self, frame: &mut Frame, area: Rect) {
        if self.results.matches.is_empty() {
            let empty_msg = if self.query.is_empty() {
                format!("Type to search {} files", self.results.total_files)
            } else {
                "No matches found".to_string()
            };
            let paragraph = Paragraph::new(empty_msg).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
            return;
        }

        let items: Vec<ListItem> = self
            .results
            .matches
            .iter()
            .map(|m| self.render_match(m))
            .collect();

        let list = List::new(items)
            .highlight_style(Style::default().bg(Color::DarkGray));
        frame.render_stateful_widget(list, area, &mut self.list_state);
    }

    fn render_match(&self, file_match: &FileMatch) -> ListItem<'static> {
        let file = &file_match.file;

        // Build highlighted name using highlight_matches utility
        let name_spans: Vec<Span<'static>> = if file_match.matched_indices.is_empty() {
            vec![Span::raw(file.name.clone())]
        } else {
            // Use highlight_matches to get (char, is_match) pairs
            let highlights = highlight_matches(&file.name, &file_match.matched_indices);

            // Group consecutive chars with same highlight status into spans
            let mut spans = Vec::new();
            let mut current_text = String::new();
            let mut current_highlighted = false;

            for (c, is_match) in highlights {
                if is_match != current_highlighted && !current_text.is_empty() {
                    // Emit the current span
                    if current_highlighted {
                        spans.push(Span::styled(
                            std::mem::take(&mut current_text),
                            Style::default()
                                .fg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        ));
                    } else {
                        spans.push(Span::raw(std::mem::take(&mut current_text)));
                    }
                }
                current_highlighted = is_match;
                current_text.push(c);
            }

            // Emit final span
            if !current_text.is_empty() {
                if current_highlighted {
                    spans.push(Span::styled(
                        current_text,
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ));
                } else {
                    spans.push(Span::raw(current_text));
                }
            }

            spans
        };

        // Add path suffix
        let mut line_spans = name_spans;
        if file.relative_path != file.name {
            line_spans.push(Span::styled(
                format!("  {}", file.relative_path),
                Style::default().fg(Color::DarkGray),
            ));
        }

        ListItem::new(Line::from(line_spans))
    }
}

impl Default for FileSearchModal {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_file(name: &str, path: &str) -> WorkspaceFile {
        WorkspaceFile {
            path: PathBuf::from(path),
            relative_path: path.to_string(),
            name: name.to_string(),
            extension: name.split('.').next_back().map(String::from),
            is_dir: false,
        }
    }

    #[test]
    fn file_search_modal_basics() {
        let mut modal = FileSearchModal::new();
        assert!(!modal.is_visible());

        modal.set_files(vec![
            make_file("main.rs", "src/main.rs"),
            make_file("lib.rs", "src/lib.rs"),
        ]);

        modal.show();
        assert!(modal.is_visible());
        assert_eq!(modal.results.matches.len(), 2);

        modal.insert_char('m');
        modal.insert_char('a');
        assert_eq!(modal.query, "ma");

        // main.rs should be first
        assert_eq!(modal.selected_file().unwrap().name, "main.rs");

        modal.hide();
        assert!(!modal.is_visible());
    }

    #[test]
    fn navigation() {
        let mut modal = FileSearchModal::new();
        modal.set_files(vec![
            make_file("a.rs", "a.rs"),
            make_file("b.rs", "b.rs"),
            make_file("c.rs", "c.rs"),
        ]);
        modal.show();

        assert_eq!(modal.selected, 0);
        modal.move_down();
        assert_eq!(modal.selected, 1);
        modal.move_down();
        assert_eq!(modal.selected, 2);
        modal.move_down(); // At end, should stay
        assert_eq!(modal.selected, 2);
        modal.move_up();
        assert_eq!(modal.selected, 1);
    }
}

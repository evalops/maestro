//! Model selector modal
//!
//! Provides a UI for selecting AI models.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

pub use crate::model_catalog::{available_models, ModelInfo, ModelVerification};

/// Model selector modal state
pub struct ModelSelector {
    /// Available models
    models: Vec<ModelInfo>,
    /// Current search query
    query: String,
    /// Cursor position in query
    cursor: usize,
    /// Filtered models
    filtered: Vec<usize>,
    /// Selected index (in filtered list)
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// Current model ID (for highlighting)
    current_model: Option<String>,
    /// List state for scrolling
    list_state: ListState,
}

impl Default for ModelSelector {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelSelector {
    /// Create a new model selector
    #[must_use]
    pub fn new() -> Self {
        let models = available_models();
        let filtered: Vec<usize> = (0..models.len()).collect();
        Self {
            models,
            query: String::new(),
            cursor: 0,
            filtered,
            selected: 0,
            visible: false,
            current_model: None,
            list_state: ListState::default(),
        }
    }

    /// Set the current model (for highlighting)
    pub fn set_current_model(&mut self, model_id: Option<String>) {
        self.current_model = model_id;
    }

    /// Apply verification to the matching catalog entry.
    pub fn set_verification(&mut self, model_id: &str, verification: ModelVerification) -> bool {
        let Some(catalog_model) = crate::model_catalog::find_model(model_id) else {
            return false;
        };
        let Some(model) = self
            .models
            .iter_mut()
            .find(|model| model.id == catalog_model.id)
        else {
            return false;
        };
        if model.verification == verification {
            return false;
        }
        model.verification = verification;
        true
    }

    /// Show the modal
    pub fn show(&mut self) {
        self.visible = true;
        self.query.clear();
        self.cursor = 0;
        self.selected = 0;
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
            self.list_state.select(Some(self.selected));
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.filtered.len() {
            self.selected += 1;
            self.list_state.select(Some(self.selected));
        }
    }

    /// Get the selected model
    #[must_use]
    pub fn selected_model(&self) -> Option<&ModelInfo> {
        self.filtered
            .get(self.selected)
            .and_then(|&idx| self.models.get(idx))
    }

    /// Confirm selection and return the model ID
    pub fn confirm(&mut self) -> Option<String> {
        let id = self.selected_model().map(|m| m.id.clone());
        self.hide();
        id
    }

    /// Filter models based on query
    fn filter(&mut self) {
        let query = self.query.to_lowercase();
        self.filtered = self
            .models
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                if query.is_empty() {
                    return true;
                }
                m.id.to_lowercase().contains(&query)
                    || m.name.to_lowercase().contains(&query)
                    || m.provider.to_lowercase().contains(&query)
                    || crate::palette_resource::PaletteResource::from(*m).matches(&query)
            })
            .map(|(i, _)| i)
            .collect();

        // Reset selection if out of bounds
        if self.selected >= self.filtered.len() {
            self.selected = 0;
        }
        // Sync list state
        if self.filtered.is_empty() {
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

        // Calculate modal size
        let modal_width = 60.min(area.width.saturating_sub(4));
        let modal_height = 15.min(area.height.saturating_sub(4));
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
            .title(" Select Model ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
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
            Paragraph::new("Type to filter models...")
                .style(Style::default().fg(Color::DarkGray))
                .block(search_block)
        } else {
            Paragraph::new(self.query.as_str())
                .style(Style::default().fg(Color::White))
                .block(search_block)
        };

        frame.render_widget(search_text, chunks[0]);

        // Model list
        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .map(|&model_idx| {
                let model = &self.models[model_idx];
                let is_current = self.current_model.as_ref().is_some_and(|c| c == &model.id);

                let mut spans = vec![
                    Span::styled(&model.name, Style::default().add_modifier(Modifier::BOLD)),
                    Span::styled(
                        format!(" ({}) ", model.provider),
                        Style::default().fg(Color::DarkGray),
                    ),
                ];

                if is_current {
                    spans.push(Span::styled("*", Style::default().fg(Color::Green)));
                }

                spans.push(Span::styled(
                    format!(
                        " {:?} T{} V{} R{} S{} {}k | {:?}",
                        model.capabilities.protocol,
                        u8::from(model.capabilities.tools),
                        u8::from(model.capabilities.vision),
                        u8::from(model.capabilities.reasoning),
                        u8::from(model.capabilities.streaming),
                        model.capabilities.context_tokens / 1000,
                        model.verification.state,
                    ),
                    Style::default().fg(Color::DarkGray),
                ));

                ListItem::new(Line::from(spans))
            })
            .collect();

        let list =
            List::new(items).highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White));
        frame.render_stateful_widget(list, chunks[1], &mut self.list_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_selector_creation() {
        let selector = ModelSelector::new();
        assert!(!selector.is_visible());
        assert!(!selector.models.is_empty());
    }

    #[test]
    fn test_model_selector_show_hide() {
        let mut selector = ModelSelector::new();
        selector.show();
        assert!(selector.is_visible());
        selector.hide();
        assert!(!selector.is_visible());
    }

    #[test]
    fn test_model_selector_filter() {
        let mut selector = ModelSelector::new();
        selector.show();

        // Filter for Claude
        selector.insert_char('c');
        selector.insert_char('l');
        selector.insert_char('a');
        selector.insert_char('u');
        selector.insert_char('d');
        selector.insert_char('e');

        // Should only have Claude models
        assert!(!selector.filtered.is_empty());
        for &idx in &selector.filtered {
            assert!(selector.models[idx].name.to_lowercase().contains("claude"));
        }
    }

    #[test]
    fn test_model_selector_navigation() {
        let mut selector = ModelSelector::new();
        selector.show();

        assert_eq!(selector.selected, 0);
        selector.move_down();
        assert_eq!(selector.selected, 1);
        selector.move_up();
        assert_eq!(selector.selected, 0);
    }

    #[test]
    fn test_model_selector_confirm() {
        let mut selector = ModelSelector::new();
        selector.show();

        let model_id = selector.confirm();
        assert!(model_id.is_some());
        assert!(!selector.is_visible());
    }

    #[test]
    fn verification_updates_matching_catalog_model_only() {
        let mut selector = ModelSelector::new();
        let verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "test".to_owned(),
            detail: None,
        };
        assert!(selector.set_verification("openai/gpt-4o", verification.clone()));
        assert_eq!(
            selector
                .models
                .iter()
                .find(|model| model.id == "gpt-4o")
                .map(|model| &model.verification),
            Some(&verification)
        );
        assert!(!selector.set_verification("anthropic/gpt-4o", verification));
    }
}

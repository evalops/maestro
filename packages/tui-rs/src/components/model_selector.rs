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

/// Maximum number of models in the focused slice shown before the
/// "show all models" affordance expands the full catalog.
const FOCUSED_SLICE_LIMIT: usize = 8;

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
    /// Selected index (in filtered list; may point at the show-all affordance row)
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// Current model ID (for highlighting)
    current_model: Option<String>,
    /// Whether the full catalog is shown instead of the focused slice
    show_all: bool,
    /// Whether a "show all N models" affordance row follows the filtered rows
    show_all_affordance: bool,
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
            show_all: false,
            show_all_affordance: false,
            list_state: ListState::default(),
        }
    }

    #[cfg(test)]
    fn with_models(models: Vec<ModelInfo>) -> Self {
        let mut selector = Self::new();
        selector.models = models;
        selector.filter();
        selector
    }

    /// Set the current model (for highlighting)
    pub fn set_current_model(&mut self, model_id: Option<String>) {
        self.current_model = model_id;
        if self.visible {
            self.filter();
        }
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
        self.show_all = false;
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

    /// Insert a string at the cursor position (e.g. pasted text).
    pub fn insert_str(&mut self, s: &str) {
        self.query.insert_str(self.cursor, s);
        self.cursor += s.len();
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
        let rows = self.filtered.len() + usize::from(self.show_all_affordance);
        if self.selected + 1 < rows {
            self.selected += 1;
            self.list_state.select(Some(self.selected));
        }
    }

    /// Whether the selection is on the "show all models" affordance row.
    #[must_use]
    pub fn selected_show_all(&self) -> bool {
        self.show_all_affordance && self.selected == self.filtered.len()
    }

    /// Toggle between the focused slice and the full catalog.
    pub fn toggle_show_all(&mut self) {
        self.show_all = !self.show_all;
        self.filter();
    }

    /// Get the selected model
    #[must_use]
    pub fn selected_model(&self) -> Option<&ModelInfo> {
        self.filtered
            .get(self.selected)
            .and_then(|&idx| self.models.get(idx))
    }

    /// Confirm selection and return the model ID. Confirming the "show all
    /// models" affordance row expands the full catalog instead of closing.
    pub fn confirm(&mut self) -> Option<String> {
        if self.selected_show_all() {
            self.toggle_show_all();
            return None;
        }
        let id = self.selected_model().map(|m| m.id.clone());
        self.hide();
        id
    }

    /// Filter models based on query
    fn filter(&mut self) {
        let query = self.query.to_lowercase();
        let full: Vec<usize> = self
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

        // With an empty query show the focused slice plus a "show all"
        // affordance; any search or an explicit expansion lists everything.
        if query.is_empty() && !self.show_all {
            self.filtered = self.focused_slice();
            self.show_all_affordance = full.len() > self.filtered.len();
        } else {
            self.filtered = full;
            self.show_all_affordance = false;
        }

        // Reset selection if out of bounds (the affordance row counts)
        let rows = self.filtered.len() + usize::from(self.show_all_affordance);
        if self.selected >= rows {
            self.selected = 0;
        }
        // Sync list state
        if rows == 0 {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(self.selected));
        }
    }

    /// Current model plus each catalog provider's default, deduplicated and
    /// capped at [`FOCUSED_SLICE_LIMIT`], so the freshly opened selector
    /// stays short now that the catalog spans dozens of models.
    fn focused_slice(&self) -> Vec<usize> {
        let mut slice: Vec<usize> = Vec::new();
        if let Some(current) = &self.current_model {
            let qualified = |model: &ModelInfo| format!("{}/{}", model.provider, model.id);
            if let Some(idx) = self
                .models
                .iter()
                .position(|model| &model.id == current || qualified(model) == *current)
            {
                slice.push(idx);
            }
        }
        for provider in crate::model_catalog::CATALOG_PROVIDERS {
            let Some(default_id) = crate::model_catalog::default_model_for_provider(provider)
            else {
                continue;
            };
            if let Some(idx) = self.models.iter().position(|model| model.id == default_id) {
                if !slice.contains(&idx) {
                    slice.push(idx);
                }
            }
        }
        slice.truncate(FOCUSED_SLICE_LIMIT);
        slice
    }

    /// Render the modal
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Calculate modal size
        let modal_width = 60.min(area.width.saturating_sub(4));
        let modal_height = 22.min(area.height.saturating_sub(4));
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

        // Layout: search box + list + key hints
        let chunks = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

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
        let mut items: Vec<ListItem> = self
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

                let detail = Line::from(Span::styled(
                    format!("  {}", description_summary(model)),
                    Style::default().fg(Color::DarkGray),
                ));

                ListItem::new(vec![Line::from(spans), detail])
            })
            .collect();

        if self.show_all_affordance {
            items.push(ListItem::new(Line::from(Span::styled(
                format!("… show all {} models (Tab)", self.models.len()),
                Style::default().fg(Color::Cyan),
            ))));
        }

        let list =
            List::new(items).highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White));
        frame.render_stateful_widget(list, chunks[1], &mut self.list_state);

        let hints = Paragraph::new("Enter: select · Tab: all · Ctrl+D: default · Esc: cancel")
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(hints, chunks[2]);
    }
}

/// Upper bound for the catalog description shown in a row's detail line, so
/// the context window label stays visible inside the modal.
const DESCRIPTION_MAX_CHARS: usize = 48;

/// Detail line under a model row: the catalog description plus its context
/// window. The models.dev snapshot carries no pricing data, so the context
/// window is the only metadata shown here.
fn description_summary(model: &ModelInfo) -> String {
    let mut description: String = model
        .description
        .chars()
        .take(DESCRIPTION_MAX_CHARS)
        .collect();
    if model.description.chars().count() > DESCRIPTION_MAX_CHARS {
        description.push('…');
    }
    format!(
        "{description} · {}",
        format_context_window(model.capabilities.context_tokens)
    )
}

/// Compact context window label: `1M ctx` for exact millions, `200k ctx`
/// otherwise.
fn format_context_window(context_tokens: u32) -> String {
    if context_tokens >= 1_000_000 && context_tokens.is_multiple_of(1_000_000) {
        format!("{}M ctx", context_tokens / 1_000_000)
    } else {
        format!("{}k ctx", context_tokens / 1000)
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
    fn test_model_selector_insert_str() {
        let mut selector = ModelSelector::new();
        selector.show();
        selector.insert_str("claude");
        assert_eq!(selector.query, "claude");
        assert_eq!(selector.cursor, 6);
        selector.move_left();
        selector.insert_str("-");
        assert_eq!(selector.query, "claud-e");
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

    fn test_model(id: &str, provider: &str) -> ModelInfo {
        ModelInfo {
            id: id.to_owned(),
            name: id.to_owned(),
            provider: provider.to_owned(),
            description: format!("{id} description"),
            capabilities: crate::model_catalog::ModelCapabilities {
                protocol: crate::model_catalog::ModelProtocol::OpenAiChat,
                tools: true,
                vision: false,
                reasoning: false,
                streaming: true,
                context_tokens: 200_000,
            },
            verification: ModelVerification::catalog(),
        }
    }

    /// The four real provider defaults plus filler models, so the focused
    /// slice exercises `default_model_for_provider` against known ids.
    fn slice_catalog() -> Vec<ModelInfo> {
        let mut models = vec![
            test_model("claude-sonnet-4-6", "anthropic"),
            test_model("gemini-2.5-pro", "google"),
            test_model("gpt-5.5", "openai"),
            test_model("grok-4.5", "xai"),
        ];
        for index in 0..12 {
            models.push(test_model(&format!("filler-{index}"), "openai"));
        }
        models
    }

    #[test]
    fn focused_slice_shows_current_and_provider_defaults() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.set_current_model(Some("grok-4.5".to_owned()));
        selector.show();

        let ids: Vec<&str> = selector
            .filtered
            .iter()
            .map(|&idx| selector.models[idx].id.as_str())
            .collect();
        assert_eq!(ids[0], "grok-4.5", "current model leads the slice");
        for default in ["claude-sonnet-4-6", "gemini-2.5-pro", "gpt-5.5"] {
            assert!(ids.contains(&default), "slice must include {default}");
        }
        assert!(ids.len() <= FOCUSED_SLICE_LIMIT);
        assert!(!ids.iter().any(|id| id.starts_with("filler-")));
        assert!(selector.show_all_affordance);
    }

    #[test]
    fn show_all_toggle_expands_and_collapses_full_catalog() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.show();
        let total = selector.models.len();
        assert!(selector.filtered.len() < total);

        selector.toggle_show_all();
        assert_eq!(selector.filtered.len(), total);
        assert!(!selector.show_all_affordance);

        selector.toggle_show_all();
        assert!(selector.filtered.len() < total);
        assert!(selector.show_all_affordance);
    }

    #[test]
    fn confirm_on_show_all_row_expands_instead_of_closing() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.show();
        while !selector.selected_show_all() {
            selector.move_down();
        }

        assert!(selector.confirm().is_none());
        assert!(selector.is_visible(), "expansion keeps the modal open");
        assert_eq!(selector.filtered.len(), selector.models.len());
        assert!(!selector.show_all_affordance);
    }

    #[test]
    fn search_bypasses_slice_and_hides_affordance() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.show();
        selector.insert_str("filler");

        assert!(!selector.show_all_affordance);
        assert_eq!(selector.filtered.len(), 12);
        for &idx in &selector.filtered {
            assert!(selector.models[idx].id.contains("filler"));
        }
    }

    #[test]
    fn description_summary_shows_description_and_context_window() {
        let mut model = test_model("gpt-5.5", "openai");
        model.description = "Flagship general-purpose model".to_owned();
        model.capabilities.context_tokens = 1_050_000;
        assert_eq!(
            description_summary(&model),
            "Flagship general-purpose model · 1050k ctx"
        );

        model.capabilities.context_tokens = 1_000_000;
        assert!(description_summary(&model).ends_with("1M ctx"));
        model.capabilities.context_tokens = 131_072;
        assert!(description_summary(&model).ends_with("131k ctx"));
    }

    #[test]
    fn description_summary_truncates_long_descriptions() {
        let mut model = test_model("gpt-5.5", "openai");
        model.description = "a".repeat(DESCRIPTION_MAX_CHARS + 10);
        let summary = description_summary(&model);
        assert!(summary.starts_with(&format!("{}… · ", "a".repeat(DESCRIPTION_MAX_CHARS))));

        model.description = "short".to_owned();
        assert!(description_summary(&model).starts_with("short · "));
    }
}

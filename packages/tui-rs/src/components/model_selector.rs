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

/// Return the route that must be passed to the native agent for a catalog
/// selection. Google and Vertex share Gemini ids, so both rows need an
/// explicit provider qualifier to keep Enter and Ctrl+D selections distinct;
/// other providers retain the historical bare-id behavior.
#[must_use]
pub(crate) fn selection_model_id(model: &ModelInfo) -> String {
    crate::model_catalog::model_route(model)
}

pub(crate) fn canonical_current_route(model_id: &str, models: &[ModelInfo]) -> Option<String> {
    let (provider, bare_id) = model_id
        .split_once('/')
        .map_or((None, model_id), |(provider, model)| {
            (Some(provider), model)
        });
    if let Some(provider) = provider {
        if let Some(descriptor) = crate::ai::ProviderRegistry::descriptor(provider) {
            if let Some(model) = models
                .iter()
                .find(|model| model.id == bare_id && model.provider == descriptor.id)
            {
                return Some(selection_model_id(model));
            }
            if descriptor.id == "openai-codex" {
                if let Some(model) = models
                    .iter()
                    .find(|model| model.id == bare_id && model.provider == "openai")
                {
                    return Some(selection_model_id(model));
                }
            }
            if descriptor.id != "openrouter" {
                if let Some(model) = models
                    .iter()
                    .find(|model| model.provider == "openrouter" && model.id == model_id)
                {
                    return Some(selection_model_id(model));
                }
            }
            return Some(format!("{}/{}", descriptor.id, bare_id));
        }
        if let Some(model) = models
            .iter()
            .find(|model| model.provider == "openrouter" && model.id == model_id)
        {
            return Some(selection_model_id(model));
        }
        return None;
    } else if let Some(model) = models.iter().find(|model| model.id == bare_id) {
        return Some(selection_model_id(model));
    }
    None
}

fn model_matches_current(
    model: &ModelInfo,
    raw_current: &str,
    canonical_current: Option<&str>,
) -> bool {
    let route = selection_model_id(model);
    canonical_current == Some(route.as_str())
        || (canonical_current.is_none() && raw_current == model.id && model.provider != "vertex-ai")
}

/// Model selector modal state
pub struct ModelSelector {
    /// Stable catalog snapshot used as the base for replacing discovery batches.
    catalog_models: Vec<ModelInfo>,
    /// Available models
    models: Vec<ModelInfo>,
    /// Latest applied local discovery generation.
    discovery_generation: u64,
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
    /// When false, `show` keeps an injected fixture catalog (tests).
    reload_live_catalog: bool,
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
            catalog_models: models.clone(),
            models,
            discovery_generation: 0,
            query: String::new(),
            cursor: 0,
            filtered,
            selected: 0,
            visible: false,
            current_model: None,
            show_all: false,
            show_all_affordance: false,
            list_state: ListState::default(),
            reload_live_catalog: true,
        }
    }

    #[cfg(test)]
    fn with_models(models: Vec<ModelInfo>) -> Self {
        let mut selector = Self::new();
        selector.catalog_models = models.clone();
        selector.models = models;
        selector.reload_live_catalog = false;
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
    pub fn set_verification(
        &mut self,
        model_id: &str,
        mut verification: ModelVerification,
    ) -> bool {
        let Some(catalog_model) = crate::model_catalog::find_model(model_id) else {
            return false;
        };
        let Some(model) = self
            .models
            .iter_mut()
            .find(|model| model.id == catalog_model.id && model.provider == catalog_model.provider)
        else {
            return false;
        };
        // A registry-only auth check is weaker than a successful live local
        // discovery. Preserve the live source so the ready badge and active
        // row retention continue to reflect the strongest evidence.
        if model.verification.source == "local-runtime"
            && verification.state == crate::model_catalog::VerificationState::Verified
            && verification.source == "provider-registry"
        {
            if model.verification.state != crate::model_catalog::VerificationState::Verified {
                return false;
            }
            verification.source.clone_from(&model.verification.source);
            if verification.detail.is_none() {
                verification.detail.clone_from(&model.verification.detail);
            }
        }
        if model.verification == verification {
            return false;
        }
        model.verification = verification;
        if let Some(base) = self
            .catalog_models
            .iter_mut()
            .find(|model| model.id == catalog_model.id && model.provider == catalog_model.provider)
        {
            base.verification = model.verification.clone();
        }
        true
    }

    /// Replace the complete discovered-model snapshot. Older batches are
    /// ignored, catalog duplicates are replaced in place, and the selected
    /// route remains stable when it still exists.
    pub fn replace_discovered_models(
        &mut self,
        generation: u64,
        discovered: Vec<ModelInfo>,
    ) -> bool {
        if generation <= self.discovery_generation {
            return false;
        }
        let selected_show_all = self.selected_show_all();
        let selected_route = self.selected_model_id();
        let active_discovered_model = self.current_model.as_deref().and_then(|current| {
            let current_route = canonical_current_route(current, &self.models)?;
            self.models
                .iter()
                .find(|model| {
                    model.verification.source == "local-runtime"
                        && selection_model_id(model) == current_route
                })
                .cloned()
        });
        self.discovery_generation = generation;
        self.models = self.catalog_models.clone();
        for discovered_model in discovered {
            if let Some(existing) = self.models.iter_mut().find(|model| {
                model.provider == discovered_model.provider && model.id == discovered_model.id
            }) {
                *existing = discovered_model;
            } else {
                self.models.push(discovered_model);
            }
        }
        if let Some(mut active_model) = active_discovered_model {
            let active_is_still_discovered = self.models.iter().any(|model| {
                model.provider == active_model.provider
                    && model.id == active_model.id
                    && model.verification.source == "local-runtime"
            });
            if !active_is_still_discovered {
                active_model.verification.state =
                    crate::model_catalog::VerificationState::Unavailable;
                let unavailable_detail = "Not reported by the local runtime on the latest refresh";
                match active_model.verification.detail.as_mut() {
                    Some(detail) if !detail.contains(unavailable_detail) => {
                        detail.push_str("; ");
                        detail.push_str(unavailable_detail);
                    }
                    Some(_) => {}
                    None => {
                        active_model.verification.detail = Some(unavailable_detail.to_owned());
                    }
                }
                if let Some(catalog_row) = self.models.iter_mut().find(|model| {
                    model.provider == active_model.provider && model.id == active_model.id
                }) {
                    *catalog_row = active_model;
                } else {
                    self.models.push(active_model);
                }
            }
        }
        self.filter();
        if selected_show_all {
            self.selected = if self.show_all_affordance {
                self.filtered.len()
            } else {
                0
            };
            self.list_state
                .select((!self.filtered.is_empty()).then_some(self.selected));
        } else if let Some(route) = selected_route {
            if let Some(position) = self.filtered.iter().position(|&idx| {
                self.models
                    .get(idx)
                    .is_some_and(|model| selection_model_id(model) == route)
            }) {
                self.selected = position;
                self.list_state.select(Some(position));
            } else {
                self.selected = 0;
                self.list_state
                    .select((!self.filtered.is_empty()).then_some(0));
            }
        }
        true
    }

    /// Show the modal
    pub fn show(&mut self) {
        self.reload_catalog_from_cache();
        self.visible = true;
        self.query.clear();
        self.cursor = 0;
        self.selected = 0;
        self.show_all = false;
        self.filter();
    }

    /// Pick up a completed background catalog refresh without dropping local
    /// discovery rows. `available_models` also schedules the next refresh.
    fn reload_catalog_from_cache(&mut self) {
        if !self.reload_live_catalog {
            return;
        }
        let catalog = available_models();
        if catalog == self.catalog_models {
            return;
        }
        let discovered: Vec<ModelInfo> = self
            .models
            .iter()
            .filter(|model| model.verification.source == "local-runtime")
            .cloned()
            .collect();
        self.catalog_models = catalog;
        self.models = self.catalog_models.clone();
        for discovered_model in discovered {
            if let Some(existing) = self.models.iter_mut().find(|model| {
                model.provider == discovered_model.provider && model.id == discovered_model.id
            }) {
                *existing = discovered_model;
            } else {
                self.models.push(discovered_model);
            }
        }
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

    /// Get the selected model route, preserving provider identity for shared
    /// Google/Vertex model ids. Used by both Enter and Ctrl+D paths.
    #[must_use]
    pub fn selected_model_id(&self) -> Option<String> {
        self.selected_model().map(selection_model_id)
    }

    /// Confirm selection and return the model ID. Confirming the "show all
    /// models" affordance row expands the full catalog instead of closing.
    pub fn confirm(&mut self) -> Option<String> {
        if self.selected_show_all() {
            self.toggle_show_all();
            return None;
        }
        let id = self.selected_model_id();
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
                    || model_status_summary(m).to_lowercase().contains(&query)
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

    /// Current model, discovered local models, and each catalog provider's
    /// default, deduplicated and normally capped at [`FOCUSED_SLICE_LIMIT`].
    /// The active row and every discovered row remain visible above that cap.
    fn focused_slice(&self) -> Vec<usize> {
        let mut slice: Vec<usize> = Vec::new();
        if let Some(current) = &self.current_model {
            let canonical_current = canonical_current_route(current, &self.models);
            if let Some(idx) = self.models.iter().position(|model| {
                model_matches_current(model, current, canonical_current.as_deref())
            }) {
                slice.push(idx);
            }
        }
        for (idx, model) in self.models.iter().enumerate() {
            if model.verification.source == "local-runtime" && !slice.contains(&idx) {
                slice.push(idx);
            }
        }
        for provider in crate::model_catalog::MODEL_SELECTOR_PROVIDERS {
            let Some(default_id) = crate::model_catalog::default_model_for_provider(provider)
            else {
                continue;
            };
            if let Some(idx) = self
                .models
                .iter()
                .position(|model| model.id == default_id && model.provider == *provider)
            {
                if !slice.contains(&idx) {
                    slice.push(idx);
                }
            }
        }
        if slice.len() > FOCUSED_SLICE_LIMIT {
            let detected = slice
                .iter()
                .filter(|&&idx| self.models[idx].verification.source == "local-runtime")
                .count();
            let active_catalog_row = usize::from(
                slice
                    .first()
                    .is_some_and(|&idx| self.models[idx].verification.source != "local-runtime"),
            );
            slice.truncate(FOCUSED_SLICE_LIMIT.max(detected + active_catalog_row));
        }
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
        let canonical_current = self
            .current_model
            .as_deref()
            .and_then(|current| canonical_current_route(current, &self.models));
        let mut items: Vec<ListItem> = self
            .filtered
            .iter()
            .map(|&model_idx| {
                let model = &self.models[model_idx];
                let is_current = self.current_model.as_deref().is_some_and(|current| {
                    model_matches_current(model, current, canonical_current.as_deref())
                });

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
                    format!(" {}", model_status_summary(model)),
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
    if context_tokens == 0 {
        "unknown ctx".to_owned()
    } else if context_tokens >= 1_000_000 && context_tokens.is_multiple_of(1_000_000) {
        format!("{}M ctx", context_tokens / 1_000_000)
    } else {
        format!("{}k ctx", context_tokens / 1000)
    }
}

fn model_status_summary(model: &ModelInfo) -> String {
    let local = model.verification.source == "local-runtime";
    let unknown = model
        .verification
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("not in the catalog"));
    let prefix = if local {
        match model.verification.state {
            crate::model_catalog::VerificationState::Verified => "Local · ready",
            crate::model_catalog::VerificationState::Unavailable => "Local · unavailable",
            crate::model_catalog::VerificationState::Catalog
            | crate::model_catalog::VerificationState::Unknown => "Local · unknown",
        }
    } else {
        "Catalog"
    };
    let mark = if unknown { "?" } else { "" };
    format!(
        "{prefix} · {mark}T{} {mark}V{} {mark}R{} · {}",
        u8::from(model.capabilities.tools),
        u8::from(model.capabilities.vision),
        u8::from(model.capabilities.reasoning),
        format_context_window(model.capabilities.context_tokens),
    )
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

        // Matches any catalog field the filter searches, including OpenRouter
        // vendor ids such as `anthropic/claude-sonnet-4.5`.
        assert!(!selector.filtered.is_empty());
        for &idx in &selector.filtered {
            let model = &selector.models[idx];
            let haystack = format!(
                "{} {} {}",
                model.id.to_lowercase(),
                model.name.to_lowercase(),
                model.provider.to_lowercase()
            );
            assert!(
                haystack.contains("claude")
                    || model_status_summary(model)
                        .to_lowercase()
                        .contains("claude")
                    || crate::palette_resource::PaletteResource::from(model).matches("claude"),
                "filtered model {} / {} must match query claude",
                model.provider,
                model.id
            );
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
    fn duplicate_google_and_vertex_rows_keep_provider_qualified_selection() {
        let mut selector = ModelSelector::with_models(vec![
            test_model("gemini-2.5-pro", "google"),
            test_model("gemini-2.5-pro", "vertex-ai"),
        ]);
        selector.show();

        assert_eq!(
            selector.confirm().as_deref(),
            Some("google/gemini-2.5-pro"),
            "Enter must preserve the Google route"
        );

        selector.show();
        selector.move_down();
        assert_eq!(
            selector.confirm().as_deref(),
            Some("vertex-ai/gemini-2.5-pro"),
            "Enter must preserve the Vertex route"
        );
    }

    #[test]
    fn ctrl_d_selection_route_preserves_vertex_provider_for_persistence() {
        let mut selector = ModelSelector::with_models(vec![
            test_model("gemini-2.5-pro", "google"),
            test_model("gemini-2.5-pro", "vertex-ai"),
        ]);
        selector.show();

        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("google/gemini-2.5-pro")
        );
        selector.move_down();
        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("vertex-ai/gemini-2.5-pro")
        );
    }

    #[test]
    fn selection_route_preserves_llamacpp_provider() {
        let model = crate::model_catalog::find_model("llamacpp/Qwen3.8-27B")
            .expect("local Qwen catalog row");

        assert_eq!(selection_model_id(&model), "llamacpp/Qwen3.8-27B");
    }

    #[test]
    fn selection_routes_preserve_every_local_provider() {
        for provider in ["llamacpp", "lmstudio", "ollama"] {
            let model = test_model("local-model", provider);
            assert_eq!(
                selection_model_id(&model),
                format!("{provider}/local-model")
            );
        }
    }

    #[test]
    fn focused_slice_canonicalizes_current_google_and_vertex_aliases() {
        for (current, expected_provider) in [
            ("vertex-ai/gemini-2.5-pro", "vertex-ai"),
            ("vertex/gemini-2.5-pro", "vertex-ai"),
            ("google/gemini-2.5-pro", "google"),
            ("gemini/gemini-2.5-pro", "google"),
            ("gemini-2.5-pro", "google"),
        ] {
            let mut selector = ModelSelector::with_models(vec![
                test_model("gemini-2.5-pro", "google"),
                test_model("gemini-2.5-pro", "vertex-ai"),
            ]);
            selector.set_current_model(Some(current.to_owned()));
            selector.show();

            let first = selector.filtered.first().map(|&idx| &selector.models[idx]);
            assert_eq!(
                first.map(|model| model.provider.as_str()),
                Some(expected_provider),
                "current route {current} must lead its canonical provider row"
            );
        }
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

    #[test]
    fn verification_updates_vertex_row_without_touching_google_row() {
        let mut selector = ModelSelector::new();
        let verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "test".to_owned(),
            detail: None,
        };
        assert!(selector.set_verification("vertex/gemini-2.5-pro", verification.clone()));
        assert_eq!(
            selector
                .models
                .iter()
                .find(|model| model.provider == "vertex-ai" && model.id == "gemini-2.5-pro")
                .map(|model| &model.verification),
            Some(&verification)
        );
        assert_ne!(
            selector
                .models
                .iter()
                .find(|model| model.provider == "google" && model.id == "gemini-2.5-pro")
                .map(|model| &model.verification),
            Some(&verification)
        );
    }

    #[test]
    fn offline_registry_verification_does_not_replace_live_local_evidence() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        let mut discovered = test_model("active-local", "llamacpp");
        discovered.verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "local-runtime".to_owned(),
            detail: Some("live discovery".to_owned()),
        };
        assert!(selector.replace_discovered_models(1, vec![discovered]));

        let changed = selector.set_verification(
            "llamacpp/active-local",
            ModelVerification {
                state: crate::model_catalog::VerificationState::Verified,
                source: "provider-registry".to_owned(),
                detail: None,
            },
        );

        assert!(!changed);
        let model = selector
            .models
            .iter()
            .find(|model| selection_model_id(model) == "llamacpp/active-local")
            .expect("discovered model");
        assert_eq!(model.verification.source, "local-runtime");
        assert_eq!(model.verification.detail.as_deref(), Some("live discovery"));
    }

    #[test]
    fn offline_registry_verification_does_not_revive_unavailable_local_evidence() {
        let mut selector = ModelSelector::new();
        let mut active = crate::model_catalog::find_model("llamacpp/Qwen3.8-27B")
            .expect("built-in local Qwen row");
        active.verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "local-runtime".to_owned(),
            detail: Some("live discovery".to_owned()),
        };
        assert!(selector.replace_discovered_models(1, vec![active]));
        selector.set_current_model(Some("llamacpp/Qwen3.8-27B".to_owned()));
        assert!(selector.replace_discovered_models(2, vec![]));

        assert!(!selector.set_verification(
            "llamacpp/Qwen3.8-27B",
            ModelVerification {
                state: crate::model_catalog::VerificationState::Verified,
                source: "provider-registry".to_owned(),
                detail: None,
            },
        ));

        let retained = selector
            .models
            .iter()
            .find(|model| model.provider == "llamacpp" && model.id == "Qwen3.8-27B")
            .expect("retained local Qwen row");
        assert_eq!(
            retained.verification.state,
            crate::model_catalog::VerificationState::Unavailable
        );
        assert_eq!(retained.verification.source, "local-runtime");
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
                output_tokens: None,
            },
            verification: ModelVerification::catalog(),
        }
    }

    /// The real provider defaults plus filler models, so the focused
    /// slice exercises `default_model_for_provider` against known ids.
    fn slice_catalog() -> Vec<ModelInfo> {
        let mut models = vec![
            test_model("claude-sonnet-4-6", "anthropic"),
            test_model("gemini-2.5-pro", "google"),
            test_model("gemini-2.5-pro", "vertex-ai"),
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
        let default_providers: Vec<&str> = selector
            .filtered
            .iter()
            .map(|&idx| selector.models[idx].provider.as_str())
            .collect();
        assert!(default_providers.contains(&"vertex-ai"));
        assert!(ids.len() <= FOCUSED_SLICE_LIMIT);
        assert!(!ids.iter().any(|id| id.starts_with("filler-")));
        assert!(selector.show_all_affordance);
    }

    #[test]
    fn focused_slice_keeps_current_model_ahead_of_discovered_models() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        let discovered = (0..10)
            .map(|index| {
                let mut model = test_model(&format!("local-{index}"), "ollama");
                model.verification = ModelVerification {
                    state: crate::model_catalog::VerificationState::Verified,
                    source: "local-runtime".to_owned(),
                    detail: None,
                };
                model
            })
            .collect();
        assert!(selector.replace_discovered_models(1, discovered));
        selector.set_current_model(Some("grok-4.5".to_owned()));
        selector.show();

        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("grok-4.5"),
            "opening and confirming the selector must preserve the active route"
        );
        assert_eq!(selector.filtered.len(), 11);
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
    fn search_matches_rendered_local_verification_status() {
        for (state, query, expected) in [
            (
                crate::model_catalog::VerificationState::Verified,
                "ready",
                "ready-local",
            ),
            (
                crate::model_catalog::VerificationState::Unavailable,
                "unavailable",
                "unavailable-local",
            ),
        ] {
            let mut matching = test_model(expected, "llamacpp");
            matching.verification = ModelVerification {
                state,
                source: "local-runtime".to_owned(),
                detail: None,
            };
            let mut other = test_model("other-local", "ollama");
            other.verification = ModelVerification {
                state: crate::model_catalog::VerificationState::Unknown,
                source: "local-runtime".to_owned(),
                detail: None,
            };
            let mut selector = ModelSelector::with_models(vec![matching, other]);
            selector.show();
            selector.insert_str(query);

            assert_eq!(selector.filtered.len(), 1, "status query {query}");
            assert_eq!(
                selector.selected_model_id().as_deref(),
                Some(format!("llamacpp/{expected}").as_str())
            );
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
        model.capabilities.context_tokens = 0;
        assert!(description_summary(&model).ends_with("unknown ctx"));
    }

    #[test]
    fn discovered_models_are_deduplicated_and_lead_the_focused_slice() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        let mut first = test_model("Qwen3.8-27B", "llamacpp");
        first.verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "local-runtime".to_owned(),
            detail: None,
        };
        selector.models.push(test_model("Qwen3.8-27B", "llamacpp"));
        let mut second = test_model("qwen3.6:27b", "ollama");
        second.verification = first.verification.clone();

        assert!(selector.replace_discovered_models(1, vec![first, second]));
        selector.show();

        let focused = selector
            .filtered
            .iter()
            .map(|&idx| (&selector.models[idx].provider, &selector.models[idx].id))
            .collect::<Vec<_>>();
        assert_eq!(focused[0].0, "llamacpp");
        assert_eq!(focused[1].0, "ollama");
        assert_eq!(
            selector
                .models
                .iter()
                .filter(|model| model.provider == "llamacpp" && model.id == "Qwen3.8-27B")
                .count(),
            1
        );
    }

    #[test]
    fn stale_discovery_batches_do_not_reorder_the_active_selection() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.show();
        selector.move_down();
        let selected = selector.selected_model_id();

        assert!(selector.replace_discovered_models(2, vec![]));
        assert!(!selector.replace_discovered_models(1, vec![test_model("stale", "ollama")]));
        assert_eq!(selector.selected_model_id(), selected);
    }

    #[test]
    fn discovery_refresh_resets_selection_when_the_selected_route_disappears() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        let mut first = test_model("first-local", "llamacpp");
        first.verification.source = "local-runtime".to_owned();
        let mut second = test_model("second-local", "ollama");
        second.verification.source = "local-runtime".to_owned();
        assert!(selector.replace_discovered_models(1, vec![first.clone(), second]));
        selector.show();
        selector.move_down();
        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("ollama/second-local")
        );

        assert!(selector.replace_discovered_models(2, vec![first]));

        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("llamacpp/first-local")
        );
        assert_eq!(selector.list_state.selected(), Some(0));
    }

    #[test]
    fn discovery_refresh_preserves_show_all_affordance_selection() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        selector.show();
        while !selector.selected_show_all() {
            selector.move_down();
        }
        let previous_index = selector.selected;

        let mut discovered = test_model("new-local", "ollama");
        discovered.verification.source = "local-runtime".to_owned();
        assert!(selector.replace_discovered_models(1, vec![discovered]));

        assert!(selector.selected_show_all());
        assert_ne!(selector.selected, previous_index);
        assert!(selector.selected_model_id().is_none());
    }

    #[test]
    fn discovery_refresh_retains_an_active_missing_local_route_as_unavailable() {
        let mut selector = ModelSelector::with_models(slice_catalog());
        let mut active = test_model("active-local", "llamacpp");
        active.verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "local-runtime".to_owned(),
            detail: Some("Capabilities are not in the catalog".to_owned()),
        };
        assert!(selector.replace_discovered_models(1, vec![active]));
        selector.set_current_model(Some("llamacpp/active-local".to_owned()));
        selector.show();

        assert!(selector.replace_discovered_models(2, vec![]));

        let retained = selector
            .models
            .iter()
            .find(|model| selection_model_id(model) == "llamacpp/active-local")
            .expect("active local model remains visible");
        assert_eq!(
            retained.verification.state,
            crate::model_catalog::VerificationState::Unavailable
        );
        let status = model_status_summary(retained);
        assert!(status.starts_with("Local · unavailable"));
        assert!(!status.contains("Local · ready"));
        assert!(status.contains("· ?T"));
        assert!(status.contains(" ?V"));
        assert!(status.contains(" ?R"));
        let detail = retained.verification.detail.as_deref().expect("detail");
        assert!(detail.contains("Capabilities are not in the catalog"));
        assert!(detail.contains("Not reported by the local runtime"));
        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("llamacpp/active-local")
        );
    }

    #[test]
    fn discovery_refresh_replaces_matching_catalog_row_with_unavailable_active_model() {
        let mut selector = ModelSelector::new();
        let mut active = crate::model_catalog::find_model("llamacpp/Qwen3.8-27B")
            .expect("built-in local Qwen row");
        active.verification = ModelVerification {
            state: crate::model_catalog::VerificationState::Verified,
            source: "local-runtime".to_owned(),
            detail: Some("Capabilities from the built-in catalog".to_owned()),
        };
        assert!(selector.replace_discovered_models(1, vec![active]));
        selector.set_current_model(Some("llamacpp/Qwen3.8-27B".to_owned()));
        selector.show();

        assert!(selector.replace_discovered_models(2, vec![]));

        let matching = selector
            .models
            .iter()
            .filter(|model| model.provider == "llamacpp" && model.id == "Qwen3.8-27B")
            .collect::<Vec<_>>();
        assert_eq!(
            matching.len(),
            1,
            "retention must not duplicate the catalog row"
        );
        assert_eq!(
            matching[0].verification.state,
            crate::model_catalog::VerificationState::Unavailable
        );
        assert_eq!(matching[0].verification.source, "local-runtime");
        assert_eq!(
            selector.selected_model_id().as_deref(),
            Some("llamacpp/Qwen3.8-27B")
        );
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

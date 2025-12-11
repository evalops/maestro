//! Configuration/Preferences selector modal
//!
//! Provides a UI for viewing and modifying runtime configuration settings.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
    Frame,
};

/// A single configurable setting
#[derive(Debug, Clone)]
pub struct ConfigOption {
    /// Setting key/identifier
    pub key: String,
    /// Human-readable name
    pub name: String,
    /// Current value display
    pub value: String,
    /// Available options (for enum-like settings)
    pub options: Vec<String>,
    /// Index of current option
    pub current_option: usize,
    /// Description of the setting
    pub description: String,
    /// Category for grouping
    pub category: ConfigCategory,
}

impl ConfigOption {
    /// Create a new config option
    pub fn new(
        key: &str,
        name: &str,
        description: &str,
        options: Vec<&str>,
        current: usize,
        category: ConfigCategory,
    ) -> Self {
        Self {
            key: key.to_string(),
            name: name.to_string(),
            value: options
                .get(current)
                .map(|s| s.to_string())
                .unwrap_or_default(),
            options: options.into_iter().map(String::from).collect(),
            current_option: current,
            description: description.to_string(),
            category,
        }
    }

    /// Cycle to next option
    pub fn next_option(&mut self) {
        if !self.options.is_empty() {
            self.current_option = (self.current_option + 1) % self.options.len();
            self.value = self.options[self.current_option].clone();
        }
    }

    /// Cycle to previous option
    pub fn prev_option(&mut self) {
        if !self.options.is_empty() {
            self.current_option = if self.current_option == 0 {
                self.options.len() - 1
            } else {
                self.current_option - 1
            };
            self.value = self.options[self.current_option].clone();
        }
    }
}

/// Categories for grouping settings
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigCategory {
    /// AI/Model settings
    Model,
    /// Security settings
    Security,
    /// UI/Display settings
    Display,
    /// Tool execution settings
    Tools,
}

impl ConfigCategory {
    fn display_name(&self) -> &'static str {
        match self {
            ConfigCategory::Model => "Model & AI",
            ConfigCategory::Security => "Security",
            ConfigCategory::Display => "Display",
            ConfigCategory::Tools => "Tools",
        }
    }
}

/// Event emitted when a config option changes
#[derive(Debug, Clone)]
pub struct ConfigChangeEvent {
    /// The setting key that changed
    pub key: String,
    /// The new value
    pub value: String,
    /// Index of the new option
    pub option_index: usize,
}

/// Configuration selector modal state
pub struct ConfigSelector {
    /// Available settings
    options: Vec<ConfigOption>,
    /// Selected setting index
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// Pending changes (key -> new value)
    changes: Vec<ConfigChangeEvent>,
}

impl Default for ConfigSelector {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigSelector {
    /// Create a new config selector with default settings
    pub fn new() -> Self {
        let options = Self::default_options();
        Self {
            options,
            selected: 0,
            visible: false,
            changes: Vec::new(),
        }
    }

    /// Create default configuration options
    fn default_options() -> Vec<ConfigOption> {
        vec![
            // Model settings
            ConfigOption::new(
                "reasoning_effort",
                "Reasoning Effort",
                "How much 'thinking' the model does",
                vec!["off", "low", "medium", "high"],
                0,
                ConfigCategory::Model,
            ),
            ConfigOption::new(
                "reasoning_summary",
                "Reasoning Summary",
                "How reasoning is summarized in output",
                vec!["off", "auto", "concise", "detailed"],
                1,
                ConfigCategory::Model,
            ),
            ConfigOption::new(
                "verbosity",
                "Model Verbosity",
                "How verbose the model's responses are",
                vec!["quiet", "normal", "verbose"],
                1,
                ConfigCategory::Model,
            ),
            // Security settings
            ConfigOption::new(
                "sandbox_mode",
                "Sandbox Mode",
                "Restrict command execution to safe zones",
                vec!["off", "permissive", "strict"],
                0,
                ConfigCategory::Security,
            ),
            ConfigOption::new(
                "approval_policy",
                "Approval Policy",
                "When to require user approval",
                vec!["auto", "suggest", "always"],
                0,
                ConfigCategory::Security,
            ),
            // Display settings
            ConfigOption::new(
                "notifications",
                "Notifications",
                "When to send desktop notifications",
                vec!["off", "errors", "all"],
                1,
                ConfigCategory::Display,
            ),
            ConfigOption::new(
                "syntax_highlight",
                "Syntax Highlighting",
                "Enable code syntax highlighting",
                vec!["off", "on"],
                1,
                ConfigCategory::Display,
            ),
            // Tool settings
            ConfigOption::new(
                "web_search",
                "Web Search",
                "Enable web search tool",
                vec!["off", "on"],
                1,
                ConfigCategory::Tools,
            ),
            ConfigOption::new(
                "view_image",
                "Image Viewing",
                "Enable image/screenshot tools",
                vec!["off", "on"],
                1,
                ConfigCategory::Tools,
            ),
        ]
    }

    /// Show the modal
    pub fn show(&mut self) {
        self.visible = true;
        self.changes.clear();
    }

    /// Hide the modal
    pub fn hide(&mut self) {
        self.visible = false;
    }

    /// Check if visible
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Move selection up
    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.options.len() {
            self.selected += 1;
        }
    }

    /// Cycle selected option to next value
    pub fn next_value(&mut self) {
        if let Some(opt) = self.options.get_mut(self.selected) {
            opt.next_option();
            self.changes.push(ConfigChangeEvent {
                key: opt.key.clone(),
                value: opt.value.clone(),
                option_index: opt.current_option,
            });
        }
    }

    /// Cycle selected option to previous value
    pub fn prev_value(&mut self) {
        if let Some(opt) = self.options.get_mut(self.selected) {
            opt.prev_option();
            self.changes.push(ConfigChangeEvent {
                key: opt.key.clone(),
                value: opt.value.clone(),
                option_index: opt.current_option,
            });
        }
    }

    /// Get the selected option
    pub fn selected_option(&self) -> Option<&ConfigOption> {
        self.options.get(self.selected)
    }

    /// Get all options
    pub fn options(&self) -> &[ConfigOption] {
        &self.options
    }

    /// Get pending changes and clear them
    pub fn take_changes(&mut self) -> Vec<ConfigChangeEvent> {
        std::mem::take(&mut self.changes)
    }

    /// Update a setting by key
    pub fn set_option(&mut self, key: &str, option_index: usize) {
        if let Some(opt) = self.options.iter_mut().find(|o| o.key == key) {
            if option_index < opt.options.len() {
                opt.current_option = option_index;
                opt.value = opt.options[option_index].clone();
            }
        }
    }

    /// Confirm and return all changes
    pub fn confirm(&mut self) -> Vec<ConfigChangeEvent> {
        self.hide();
        self.take_changes()
    }

    /// Cancel and discard changes
    pub fn cancel(&mut self) {
        self.hide();
        self.changes.clear();
    }

    /// Render the modal
    pub fn render(&self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Calculate modal size
        let modal_width = 70.min(area.width.saturating_sub(4));
        let modal_height = 20.min(area.height.saturating_sub(4));
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
            .title(" Preferences ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .style(Style::default().bg(Color::Black));

        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        // Layout: settings list + description
        let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).split(inner);

        // Build list items grouped by category
        let mut items: Vec<ListItem> = Vec::new();
        let mut current_category: Option<ConfigCategory> = None;

        for (i, opt) in self.options.iter().enumerate() {
            // Add category header if changed
            if current_category != Some(opt.category) {
                current_category = Some(opt.category);
                if !items.is_empty() {
                    items.push(ListItem::new(Line::from(""))); // Spacer
                }
                items.push(ListItem::new(Line::from(Span::styled(
                    format!("─── {} ───", opt.category.display_name()),
                    Style::default().fg(Color::DarkGray),
                ))));
            }

            let is_selected = i == self.selected;
            let style = if is_selected {
                Style::default().bg(Color::DarkGray).fg(Color::White)
            } else {
                Style::default()
            };

            let name_span = Span::styled(
                format!("  {} ", opt.name),
                style.add_modifier(Modifier::BOLD),
            );

            // Show current value with arrows if selected
            let value_str = if is_selected {
                format!("< {} >", opt.value)
            } else {
                opt.value.clone()
            };

            let value_style = style.fg(if is_selected {
                Color::Cyan
            } else {
                Color::Green
            });

            let line = Line::from(vec![
                name_span,
                Span::styled(
                    format!(
                        "{:>width$}",
                        value_str,
                        width = 20 - opt.value.len().min(15)
                    ),
                    value_style,
                ),
            ]);

            items.push(ListItem::new(line));
        }

        let list = List::new(items);
        frame.render_widget(list, chunks[0]);

        // Description area
        let desc_block = Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(Color::DarkGray));

        let description = self
            .selected_option()
            .map(|o| o.description.as_str())
            .unwrap_or("");

        let help_text = Line::from(vec![
            Span::styled(description, Style::default().fg(Color::Gray)),
            Span::raw("  "),
            Span::styled("← →", Style::default().fg(Color::Yellow)),
            Span::styled(" change  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Enter", Style::default().fg(Color::Yellow)),
            Span::styled(" confirm  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Esc", Style::default().fg(Color::Yellow)),
            Span::styled(" cancel", Style::default().fg(Color::DarkGray)),
        ]);

        let desc_paragraph = Paragraph::new(help_text).block(desc_block);
        frame.render_widget(desc_paragraph, chunks[1]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_selector_creation() {
        let selector = ConfigSelector::new();
        assert!(!selector.is_visible());
        assert!(!selector.options.is_empty());
    }

    #[test]
    fn test_config_selector_show_hide() {
        let mut selector = ConfigSelector::new();
        selector.show();
        assert!(selector.is_visible());
        selector.hide();
        assert!(!selector.is_visible());
    }

    #[test]
    fn test_config_selector_navigation() {
        let mut selector = ConfigSelector::new();
        selector.show();

        assert_eq!(selector.selected, 0);
        selector.move_down();
        assert_eq!(selector.selected, 1);
        selector.move_up();
        assert_eq!(selector.selected, 0);
    }

    #[test]
    fn test_config_option_cycle() {
        let mut opt = ConfigOption::new(
            "test",
            "Test",
            "Description",
            vec!["a", "b", "c"],
            0,
            ConfigCategory::Model,
        );

        assert_eq!(opt.value, "a");
        opt.next_option();
        assert_eq!(opt.value, "b");
        opt.next_option();
        assert_eq!(opt.value, "c");
        opt.next_option();
        assert_eq!(opt.value, "a"); // Wraps around
    }

    #[test]
    fn test_config_option_prev() {
        let mut opt = ConfigOption::new(
            "test",
            "Test",
            "Description",
            vec!["a", "b", "c"],
            0,
            ConfigCategory::Model,
        );

        assert_eq!(opt.value, "a");
        opt.prev_option();
        assert_eq!(opt.value, "c"); // Wraps around to end
        opt.prev_option();
        assert_eq!(opt.value, "b");
    }

    #[test]
    fn test_config_selector_changes() {
        let mut selector = ConfigSelector::new();
        selector.show();

        selector.next_value();
        let changes = selector.take_changes();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].key, "reasoning_effort");
    }

    #[test]
    fn test_config_selector_set_option() {
        let mut selector = ConfigSelector::new();

        selector.set_option("sandbox_mode", 2);
        let opt = selector
            .options
            .iter()
            .find(|o| o.key == "sandbox_mode")
            .unwrap();
        assert_eq!(opt.value, "strict");
    }

    #[test]
    fn test_config_selector_confirm() {
        let mut selector = ConfigSelector::new();
        selector.show();
        selector.next_value();

        let changes = selector.confirm();
        assert!(!changes.is_empty());
        assert!(!selector.is_visible());
    }

    #[test]
    fn test_config_selector_cancel() {
        let mut selector = ConfigSelector::new();
        selector.show();
        selector.next_value();

        selector.cancel();
        assert!(!selector.is_visible());
    }

    #[test]
    fn test_config_category_display() {
        assert_eq!(ConfigCategory::Model.display_name(), "Model & AI");
        assert_eq!(ConfigCategory::Security.display_name(), "Security");
        assert_eq!(ConfigCategory::Display.display_name(), "Display");
        assert_eq!(ConfigCategory::Tools.display_name(), "Tools");
    }
}

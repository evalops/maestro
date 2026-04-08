//! Keyboard Shortcuts Help Overlay Component
//!
//! Displays a modal overlay showing available keyboard shortcuts.
//! Organizes shortcuts by category with clear visual grouping.
//!
//! # Features
//!
//! - Categorized shortcut display
//! - Search/filter shortcuts
//! - Scrollable list for many shortcuts
//! - Context-aware (shows relevant shortcuts for current mode)
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::components::{ShortcutsHelp, ShortcutCategory};
//!
//! let mut help = ShortcutsHelp::new()
//!     .add_shortcut(ShortcutCategory::Navigation, "↑/↓", "Move selection")
//!     .add_shortcut(ShortcutCategory::Input, "Enter", "Submit input");
//!
//! // Toggle visibility
//! help.toggle();
//!
//! // In your render function:
//! help.render(frame, area);
//! ```

use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Clear, Padding, Row, Table, Widget},
};

use crate::keybindings::RustTuiKeybindingLabels;

/// Categories for organizing keyboard shortcuts
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ShortcutCategory {
    /// General navigation shortcuts
    Navigation,
    /// Text input shortcuts
    Input,
    /// Modal/dialog shortcuts
    Modal,
    /// Command shortcuts
    Commands,
    /// Session management
    Session,
    /// Tool-related shortcuts
    Tools,
    /// View/display shortcuts
    View,
    /// System shortcuts
    System,
}

impl ShortcutCategory {
    /// Get the display label for this category
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Navigation => "Navigation",
            Self::Input => "Input",
            Self::Modal => "Dialogs",
            Self::Commands => "Commands",
            Self::Session => "Session",
            Self::Tools => "Tools",
            Self::View => "View",
            Self::System => "System",
        }
    }

    /// Get the color for this category
    #[must_use]
    pub fn color(&self) -> Color {
        match self {
            Self::Navigation => Color::Cyan,
            Self::Input => Color::Green,
            Self::Modal => Color::Yellow,
            Self::Commands => Color::Magenta,
            Self::Session => Color::Blue,
            Self::Tools => Color::LightRed,
            Self::View => Color::LightCyan,
            Self::System => Color::Gray,
        }
    }

    /// Get all categories in display order
    #[must_use]
    pub fn all() -> &'static [ShortcutCategory] {
        &[
            Self::Navigation,
            Self::Input,
            Self::Commands,
            Self::Modal,
            Self::Session,
            Self::Tools,
            Self::View,
            Self::System,
        ]
    }
}

/// A single keyboard shortcut definition
#[derive(Debug, Clone)]
pub struct Shortcut {
    /// The key combination (e.g., "Ctrl+C", "↑/↓")
    pub keys: String,
    /// Description of what this shortcut does
    pub description: String,
    /// The category this shortcut belongs to
    pub category: ShortcutCategory,
    /// Whether this shortcut is context-dependent
    pub context_hint: Option<String>,
}

impl Shortcut {
    /// Create a new shortcut
    pub fn new(
        category: ShortcutCategory,
        keys: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        Self {
            keys: keys.into(),
            description: description.into(),
            category,
            context_hint: None,
        }
    }

    /// Add a context hint
    pub fn with_context(mut self, hint: impl Into<String>) -> Self {
        self.context_hint = Some(hint.into());
        self
    }
}

/// Keyboard shortcuts help overlay
#[derive(Debug, Clone)]
pub struct ShortcutsHelp {
    /// All registered shortcuts
    shortcuts: Vec<Shortcut>,
    /// Whether the overlay is visible
    pub visible: bool,
    /// Current scroll offset
    pub scroll_offset: usize,
    /// Optional filter text
    pub filter: Option<String>,
    /// Selected category filter
    pub selected_category: Option<ShortcutCategory>,
    /// Title for the overlay
    pub title: String,
}

impl Default for ShortcutsHelp {
    fn default() -> Self {
        Self::new()
    }
}

impl ShortcutsHelp {
    /// Create a new shortcuts help with default Composer shortcuts
    #[must_use]
    pub fn new() -> Self {
        Self::new_with_binding_labels(RustTuiKeybindingLabels::default())
    }

    /// Create a new shortcuts help with runtime binding labels.
    #[must_use]
    pub fn new_with_binding_labels(labels: RustTuiKeybindingLabels) -> Self {
        let mut help = Self {
            shortcuts: Vec::new(),
            visible: false,
            scroll_offset: 0,
            filter: None,
            selected_category: None,
            title: "Keyboard Shortcuts".to_string(),
        };

        help.add_default_shortcuts(&labels);
        help
    }

    /// Create a new shortcuts help with a terminal-aware queued follow-up edit binding label.
    #[must_use]
    pub fn new_with_queue_binding_label(
        queued_follow_up_edit_binding_label: impl Into<String>,
    ) -> Self {
        let mut labels = RustTuiKeybindingLabels::default();
        labels.edit_last_queued_follow_up = queued_follow_up_edit_binding_label.into();
        Self::new_with_binding_labels(labels)
    }

    /// Refresh runtime binding labels while preserving modal state.
    pub fn set_binding_labels(&mut self, labels: RustTuiKeybindingLabels) {
        let visible = self.visible;
        let scroll_offset = self.scroll_offset;
        let filter = self.filter.clone();
        let selected_category = self.selected_category;
        let title = self.title.clone();
        *self = Self::new_with_binding_labels(labels);
        self.visible = visible;
        self.scroll_offset = scroll_offset;
        self.filter = filter;
        self.selected_category = selected_category;
        self.title = title;
    }

    /// Create an empty shortcuts help
    #[must_use]
    pub fn empty() -> Self {
        Self {
            shortcuts: Vec::new(),
            visible: false,
            scroll_offset: 0,
            filter: None,
            selected_category: None,
            title: "Keyboard Shortcuts".to_string(),
        }
    }

    /// Add default Composer shortcuts
    fn add_default_shortcuts(&mut self, labels: &RustTuiKeybindingLabels) {
        // Navigation
        self.add(Shortcut::new(
            ShortcutCategory::Navigation,
            "↑ / ↓",
            "Scroll messages up/down",
        ));
        self.add(
            Shortcut::new(
                ShortcutCategory::Navigation,
                "Ctrl+K / Ctrl+J",
                "Scroll up/down (vim style)",
            )
            .with_context("when input empty"),
        );
        self.add(Shortcut::new(
            ShortcutCategory::Navigation,
            "Page Up/Down",
            "Scroll half page",
        ));
        self.add(
            Shortcut::new(
                ShortcutCategory::Navigation,
                "g / G",
                "Jump to oldest/newest",
            )
            .with_context("when input empty"),
        );
        self.add(Shortcut::new(
            ShortcutCategory::Navigation,
            "Mouse Scroll",
            "Scroll messages",
        ));

        // Input
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Enter",
            "Submit message (steer while running)",
        ));
        self.add(
            Shortcut::new(
                ShortcutCategory::Input,
                "Tab",
                "Submit message / queue follow-up",
            )
            .with_context("queues while running"),
        );
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Alt+Enter",
            "Queue follow-up (alternate while running)",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            &labels.edit_last_queued_follow_up,
            "Edit last queued follow-up",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Shift+Enter",
            "New line in input",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Ctrl+U",
            "Delete to start of line",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Ctrl+K",
            "Delete to end of line",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Alt+B / Alt+F",
            "Move by word",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Alt+Backspace / Ctrl+W",
            "Delete word backward",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Home / Ctrl+A",
            "Smart line start",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Alt+Y",
            "Yank last kill (cycle)",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "Ctrl+Y",
            "Paste from clipboard",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Input,
            "@",
            "Mention file (opens file search)",
        ));

        // Commands
        self.add(
            Shortcut::new(ShortcutCategory::Commands, "/", "Start slash command")
                .with_context("when input empty"),
        );
        self.add(
            Shortcut::new(ShortcutCategory::Commands, "Tab", "Complete slash command")
                .with_context("after /"),
        );
        self.add(Shortcut::new(
            ShortcutCategory::Commands,
            &labels.command_palette,
            "Open command palette",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Commands,
            &labels.file_search,
            "Open file search",
        ));

        // Modal
        self.add(Shortcut::new(
            ShortcutCategory::Modal,
            "Escape",
            "Close modal/cancel",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Modal,
            "Enter",
            "Confirm selection",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::Modal,
            "↑ / ↓",
            "Navigate list items",
        ));

        // Session
        self.add(Shortcut::new(
            ShortcutCategory::Session,
            "Ctrl+Alt+R",
            "Open session switcher",
        ));

        // Tools
        self.add(
            Shortcut::new(ShortcutCategory::Tools, "y / Enter", "Approve tool")
                .with_context("tool approval"),
        );
        self.add(
            Shortcut::new(ShortcutCategory::Tools, "n / Esc", "Reject tool")
                .with_context("tool approval"),
        );
        self.add(
            Shortcut::new(ShortcutCategory::Tools, "a", "Approve all pending")
                .with_context("tool approval"),
        );
        self.add(Shortcut::new(
            ShortcutCategory::Tools,
            &labels.toggle_tool_outputs,
            "Toggle last tool call expand",
        ));
        self.add(
            Shortcut::new(ShortcutCategory::Tools, "Tab", "Toggle last thinking block")
                .with_context("when input empty"),
        );

        // View
        self.add(Shortcut::new(
            ShortcutCategory::View,
            "Ctrl+L",
            "Clear screen",
        ));
        self.add(Shortcut::new(
            ShortcutCategory::View,
            "F1",
            "Show this help",
        ));
        self.add(
            Shortcut::new(ShortcutCategory::View, "j / k", "Scroll help (vim style)")
                .with_context("in this help"),
        );

        // System
        self.add(Shortcut::new(
            ShortcutCategory::System,
            "Ctrl+C",
            "Cancel / Quit",
        ));
        self.add(Shortcut::new(ShortcutCategory::System, "Ctrl+D", "Quit"));
    }

    /// Add a shortcut
    pub fn add(&mut self, shortcut: Shortcut) -> &mut Self {
        self.shortcuts.push(shortcut);
        self
    }

    /// Add a shortcut with builder pattern (consumes self)
    pub fn add_shortcut(
        mut self,
        category: ShortcutCategory,
        keys: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        self.shortcuts
            .push(Shortcut::new(category, keys, description));
        self
    }

    /// Show the overlay
    pub fn show(&mut self) {
        self.visible = true;
        self.scroll_offset = 0;
    }

    /// Hide the overlay
    pub fn hide(&mut self) {
        self.visible = false;
        self.filter = None;
    }

    /// Toggle overlay visibility
    pub fn toggle(&mut self) {
        if self.visible {
            self.hide();
        } else {
            self.show();
        }
    }

    /// Set filter text
    pub fn set_filter(&mut self, filter: impl Into<String>) {
        let filter = filter.into();
        if filter.is_empty() {
            self.filter = None;
        } else {
            self.filter = Some(filter.to_lowercase());
        }
        self.scroll_offset = 0;
    }

    /// Clear filter
    pub fn clear_filter(&mut self) {
        self.filter = None;
        self.scroll_offset = 0;
    }

    /// Filter by category
    pub fn filter_category(&mut self, category: Option<ShortcutCategory>) {
        self.selected_category = category;
        self.scroll_offset = 0;
    }

    /// Get filtered shortcuts
    #[must_use]
    pub fn filtered_shortcuts(&self) -> Vec<&Shortcut> {
        self.shortcuts
            .iter()
            .filter(|s| {
                // Category filter
                if let Some(cat) = self.selected_category {
                    if s.category != cat {
                        return false;
                    }
                }

                // Text filter
                if let Some(ref filter) = self.filter {
                    let matches = s.keys.to_lowercase().contains(filter)
                        || s.description.to_lowercase().contains(filter)
                        || s.category.label().to_lowercase().contains(filter);
                    if !matches {
                        return false;
                    }
                }

                true
            })
            .collect()
    }

    /// Scroll up
    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
    }

    /// Scroll down
    pub fn scroll_down(&mut self, amount: usize) {
        let max_offset = self.filtered_shortcuts().len().saturating_sub(1);
        self.scroll_offset = (self.scroll_offset + amount).min(max_offset);
    }

    /// Get shortcuts grouped by category
    #[must_use]
    pub fn grouped_shortcuts(&self) -> Vec<(ShortcutCategory, Vec<&Shortcut>)> {
        let filtered = self.filtered_shortcuts();
        let mut groups: Vec<(ShortcutCategory, Vec<&Shortcut>)> = Vec::new();

        for category in ShortcutCategory::all() {
            let shortcuts: Vec<_> = filtered
                .iter()
                .filter(|s| s.category == *category)
                .copied()
                .collect();

            if !shortcuts.is_empty() {
                groups.push((*category, shortcuts));
            }
        }

        groups
    }

    /// Render the shortcuts table
    fn render_table(&self, area: Rect, buf: &mut Buffer) {
        let groups = self.grouped_shortcuts();

        let mut rows: Vec<Row> = Vec::new();

        for (category, shortcuts) in groups {
            // Category header
            let header_text = format!("── {} ──", category.label());
            rows.push(
                Row::new(vec![String::new(), header_text]).style(
                    Style::default()
                        .fg(category.color())
                        .add_modifier(Modifier::BOLD),
                ),
            );

            // Shortcuts in this category
            for shortcut in shortcuts {
                let context = shortcut
                    .context_hint
                    .as_ref()
                    .map(|c| format!(" ({c})"))
                    .unwrap_or_default();

                rows.push(
                    Row::new(vec![
                        shortcut.keys.clone(),
                        shortcut.description.clone() + &context,
                    ])
                    .style(Style::default()),
                );
            }

            // Empty row between categories
            rows.push(Row::new(vec![String::new(), String::new()]));
        }

        // Apply scroll offset
        let visible_rows: Vec<Row> = rows
            .into_iter()
            .skip(self.scroll_offset)
            .take(area.height.saturating_sub(2) as usize)
            .collect();

        let widths = [Constraint::Length(16), Constraint::Min(20)];

        let table = Table::new(visible_rows, widths)
            .header(
                Row::new(vec!["Key", "Action"])
                    .style(
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD),
                    )
                    .bottom_margin(1),
            )
            .column_spacing(2);

        Widget::render(table, area, buf);
    }
}

impl Widget for ShortcutsHelp {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if !self.visible {
            return;
        }

        // Calculate modal size (70% width, 80% height, centered)
        let modal_width = (area.width * 70 / 100).max(50).min(area.width);
        let modal_height = (area.height * 80 / 100).max(20).min(area.height);

        let modal_x = area.x + (area.width - modal_width) / 2;
        let modal_y = area.y + (area.height - modal_height) / 2;

        let modal_area = Rect::new(modal_x, modal_y, modal_width, modal_height);

        // Clear background
        Clear.render(modal_area, buf);

        // Draw border
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(format!(" {} ", self.title))
            .title_style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )
            .title_bottom(" Press F1 or Esc to close ")
            .padding(Padding::horizontal(1));

        let inner = block.inner(modal_area);
        block.render(modal_area, buf);

        // Render shortcuts table
        self.render_table(inner, buf);
    }
}

/// Builder for custom shortcuts help
#[derive(Debug, Default)]
pub struct ShortcutsHelpBuilder {
    shortcuts: Vec<Shortcut>,
    title: String,
}

impl ShortcutsHelpBuilder {
    /// Create a new builder
    #[must_use]
    pub fn new() -> Self {
        Self {
            shortcuts: Vec::new(),
            title: "Keyboard Shortcuts".to_string(),
        }
    }

    /// Set the title
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// Add a shortcut
    pub fn shortcut(
        mut self,
        category: ShortcutCategory,
        keys: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        self.shortcuts
            .push(Shortcut::new(category, keys, description));
        self
    }

    /// Add a shortcut with context
    pub fn shortcut_with_context(
        mut self,
        category: ShortcutCategory,
        keys: impl Into<String>,
        description: impl Into<String>,
        context: impl Into<String>,
    ) -> Self {
        self.shortcuts
            .push(Shortcut::new(category, keys, description).with_context(context));
        self
    }

    /// Include default Composer shortcuts
    #[must_use]
    pub fn with_defaults(mut self) -> Self {
        let defaults = ShortcutsHelp::new();
        self.shortcuts.extend(defaults.shortcuts);
        self
    }

    /// Build the shortcuts help
    #[must_use]
    pub fn build(self) -> ShortcutsHelp {
        ShortcutsHelp {
            shortcuts: self.shortcuts,
            visible: false,
            scroll_offset: 0,
            filter: None,
            selected_category: None,
            title: self.title,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::RustTuiKeybindingLabels;

    #[test]
    fn test_shortcut_category_label() {
        assert_eq!(ShortcutCategory::Navigation.label(), "Navigation");
        assert_eq!(ShortcutCategory::Input.label(), "Input");
        assert_eq!(ShortcutCategory::System.label(), "System");
    }

    #[test]
    fn test_shortcut_category_all() {
        let all = ShortcutCategory::all();
        assert!(!all.is_empty());
        assert!(all.contains(&ShortcutCategory::Navigation));
        assert!(all.contains(&ShortcutCategory::System));
    }

    #[test]
    fn test_shortcut_new() {
        let shortcut = Shortcut::new(
            ShortcutCategory::Input,
            "Enter",
            "Submit message (steer while running)",
        );

        assert_eq!(shortcut.keys, "Enter");
        assert_eq!(shortcut.description, "Submit message (steer while running)");
        assert_eq!(shortcut.category, ShortcutCategory::Input);
        assert!(shortcut.context_hint.is_none());
    }

    #[test]
    fn test_shortcut_with_context() {
        let shortcut = Shortcut::new(ShortcutCategory::Tools, "y", "Approve tool")
            .with_context("tool approval");

        assert_eq!(shortcut.context_hint.as_deref(), Some("tool approval"));
    }

    #[test]
    fn test_shortcuts_help_default() {
        let help = ShortcutsHelp::new();

        assert!(!help.visible);
        assert!(!help.shortcuts.is_empty());
        assert!(help.filter.is_none());
    }

    #[test]
    fn test_shortcuts_help_uses_custom_queue_binding_label() {
        let help = ShortcutsHelp::new_with_queue_binding_label("Shift+Left");

        assert!(help
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.keys == "Shift+Left"
                && shortcut.description == "Edit last queued follow-up"));
        assert!(help.shortcuts.iter().any(|shortcut| {
            shortcut.keys == "Tab"
                && shortcut.description == "Submit message / queue follow-up"
                && shortcut.context_hint.as_deref() == Some("queues while running")
        }));
    }

    #[test]
    fn test_shortcuts_help_uses_runtime_binding_labels() {
        let help = ShortcutsHelp::new_with_binding_labels(RustTuiKeybindingLabels {
            command_palette: "Ctrl+O".to_string(),
            file_search: "Ctrl+P".to_string(),
            toggle_tool_outputs: "Shift+Left".to_string(),
            edit_last_queued_follow_up: "Ctrl+T".to_string(),
        });

        assert!(help
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.keys == "Ctrl+O"
                && shortcut.description == "Open command palette"));
        assert!(help.shortcuts.iter().any(
            |shortcut| shortcut.keys == "Ctrl+P" && shortcut.description == "Open file search"
        ));
        assert!(help
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.keys == "Shift+Left"
                && shortcut.description == "Toggle last tool call expand"));
        assert!(help
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.keys == "Ctrl+T"
                && shortcut.description == "Edit last queued follow-up"));
    }

    #[test]
    fn test_set_binding_labels_preserves_visible_state() {
        let mut help = ShortcutsHelp::new();
        help.visible = true;
        help.scroll_offset = 3;
        help.filter = Some("queue".to_string());
        help.selected_category = Some(ShortcutCategory::Input);
        help.set_binding_labels(RustTuiKeybindingLabels {
            command_palette: "Ctrl+O".to_string(),
            file_search: "Ctrl+P".to_string(),
            toggle_tool_outputs: "Shift+Left".to_string(),
            edit_last_queued_follow_up: "Shift+Left".to_string(),
        });

        assert!(help.visible);
        assert_eq!(help.scroll_offset, 3);
        assert_eq!(help.filter.as_deref(), Some("queue"));
        assert_eq!(help.selected_category, Some(ShortcutCategory::Input));
        assert!(help.shortcuts.iter().any(|shortcut| {
            shortcut.keys == "Ctrl+O" && shortcut.description == "Open command palette"
        }));
    }

    #[test]
    fn test_shortcuts_help_empty() {
        let help = ShortcutsHelp::empty();
        assert!(help.shortcuts.is_empty());
    }

    #[test]
    fn test_shortcuts_help_toggle() {
        let mut help = ShortcutsHelp::new();

        assert!(!help.visible);
        help.toggle();
        assert!(help.visible);
        help.toggle();
        assert!(!help.visible);
    }

    #[test]
    fn test_shortcuts_help_show_hide() {
        let mut help = ShortcutsHelp::new();

        help.show();
        assert!(help.visible);

        help.hide();
        assert!(!help.visible);
    }

    #[test]
    fn test_shortcuts_help_filter() {
        let mut help = ShortcutsHelp::new();

        help.set_filter("enter");
        assert!(help.filter.is_some());

        let filtered = help.filtered_shortcuts();
        assert!(!filtered.is_empty());
        assert!(filtered
            .iter()
            .any(|s| s.keys.to_lowercase().contains("enter")
                || s.description.to_lowercase().contains("enter")));

        help.clear_filter();
        assert!(help.filter.is_none());
    }

    #[test]
    fn test_shortcuts_help_category_filter() {
        let mut help = ShortcutsHelp::new();

        help.filter_category(Some(ShortcutCategory::Input));

        let filtered = help.filtered_shortcuts();
        assert!(!filtered.is_empty());
        assert!(filtered
            .iter()
            .all(|s| s.category == ShortcutCategory::Input));
    }

    #[test]
    fn test_shortcuts_help_scroll() {
        let mut help = ShortcutsHelp::new();

        assert_eq!(help.scroll_offset, 0);

        help.scroll_down(5);
        assert_eq!(help.scroll_offset, 5);

        help.scroll_up(3);
        assert_eq!(help.scroll_offset, 2);

        help.scroll_up(10);
        assert_eq!(help.scroll_offset, 0);
    }

    #[test]
    fn test_shortcuts_help_grouped() {
        let help = ShortcutsHelp::new();

        let groups = help.grouped_shortcuts();
        assert!(!groups.is_empty());

        // Should have multiple categories
        let categories: Vec<_> = groups.iter().map(|(cat, _)| cat).collect();
        assert!(categories.contains(&&ShortcutCategory::Navigation));
        assert!(categories.contains(&&ShortcutCategory::Input));
    }

    #[test]
    fn test_shortcuts_help_add() {
        let mut help = ShortcutsHelp::empty();
        let initial_count = help.shortcuts.len();

        help.add(Shortcut::new(
            ShortcutCategory::View,
            "Ctrl+X",
            "Test shortcut",
        ));

        assert_eq!(help.shortcuts.len(), initial_count + 1);
    }

    #[test]
    fn test_shortcuts_help_builder_pattern() {
        let help = ShortcutsHelp::empty()
            .add_shortcut(ShortcutCategory::Navigation, "↑", "Move up")
            .add_shortcut(ShortcutCategory::Navigation, "↓", "Move down");

        assert_eq!(help.shortcuts.len(), 2);
    }

    #[test]
    fn test_builder() {
        let help = ShortcutsHelpBuilder::new()
            .title("Custom Shortcuts")
            .shortcut(ShortcutCategory::View, "F1", "Help")
            .shortcut_with_context(ShortcutCategory::Tools, "a", "Approve", "dialog")
            .build();

        assert_eq!(help.title, "Custom Shortcuts");
        assert_eq!(help.shortcuts.len(), 2);
    }

    #[test]
    fn test_builder_with_defaults() {
        let custom = ShortcutsHelpBuilder::new()
            .with_defaults()
            .shortcut(ShortcutCategory::View, "F12", "Custom action")
            .build();

        let defaults = ShortcutsHelp::new();

        // Should have all defaults plus one custom
        assert_eq!(custom.shortcuts.len(), defaults.shortcuts.len() + 1);
    }
}

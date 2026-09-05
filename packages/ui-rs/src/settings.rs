//! Settings rendering that keeps option indexes separate from decorative rows.
use crate::{SELECTION_MARKER, UiTheme};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
};

/// A borrowed setting. Validation belongs to the application's typed value owner.
pub struct SettingField<'a> {
    /// Group heading.
    pub category: &'a str,
    /// Human-readable label.
    pub label: &'a str,
    /// Current value.
    pub value: &'a str,
    /// Explanation of this setting.
    pub description: &'a str,
    /// Validation error supplied by the value owner, if any.
    pub error: Option<&'a str>,
}

/// Grouped settings with scrolling, descriptions, validation, and key hints.
pub struct SettingsForm<'a> {
    fields: &'a [SettingField<'a>],
    selected: Option<usize>,
    theme: UiTheme,
    help: Line<'a>,
}

impl<'a> SettingsForm<'a> {
    /// Selection refers to a field, never a heading or spacer.
    pub fn new(fields: &'a [SettingField<'a>], selected: Option<usize>, theme: UiTheme) -> Self {
        Self {
            fields,
            selected,
            theme,
            help: Line::raw(""),
        }
    }

    /// Display the actual bindings supplied by the application.
    #[must_use]
    pub fn help(mut self, help: impl Into<Line<'a>>) -> Self {
        self.help = help.into();
        self
    }

    /// Render with caller-owned scrolling. Invalid selection remains unselected.
    pub fn render(self, frame: &mut Frame, area: Rect, state: &mut ListState) {
        let chunks = Layout::vertical([
            Constraint::Min(0),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);
        let mut rows = Vec::new();
        let mut category = None;
        let mut selected_row = None;
        for (index, field) in self.fields.iter().enumerate() {
            if category != Some(field.category) {
                category = Some(field.category);
                rows.push(ListItem::new(Line::styled(
                    field.category,
                    Style::default().fg(self.theme.muted),
                )));
            }
            if self.selected == Some(index) {
                selected_row = Some(rows.len());
            }
            let value_color = if field.error.is_some() {
                self.theme.error
            } else {
                self.theme.success
            };
            rows.push(ListItem::new(Line::from(vec![
                Span::raw(format!("{}  ", field.label)),
                Span::styled(field.value, Style::default().fg(value_color)),
            ])));
        }
        state.select(selected_row);
        if rows.is_empty() {
            frame.render_widget(
                Paragraph::new("No settings available")
                    .style(Style::default().fg(self.theme.muted)),
                chunks[0],
            );
        } else {
            frame.render_stateful_widget(
                List::new(rows)
                    .style(self.theme.text_style())
                    .highlight_symbol(SELECTION_MARKER)
                    .highlight_style(self.theme.selection_style()),
                chunks[0],
                state,
            );
        }
        let field = self.selected.and_then(|i| self.fields.get(i));
        let description = field.map_or("", |f| f.error.unwrap_or(f.description));
        let color = if field.is_some_and(|f| f.error.is_some()) {
            self.theme.error
        } else {
            self.theme.muted
        };
        frame.render_widget(
            Paragraph::new(description)
                .style(Style::default().fg(color))
                .block(
                    Block::default()
                        .borders(Borders::TOP)
                        .border_style(Style::default().fg(self.theme.border)),
                )
                .wrap(Wrap { trim: false }),
            chunks[1],
        );
        frame.render_widget(
            Paragraph::new(self.help).style(Style::default().fg(self.theme.muted)),
            chunks[2],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    #[test]
    fn category_rows_do_not_steal_selection_and_selected_field_stays_visible() {
        let fields: Vec<_> = (0..20)
            .map(|i| SettingField {
                category: if i < 10 { "First" } else { "Second" },
                label: "Setting",
                value: if i == 19 { "Last value" } else { "Value" },
                description: "Description",
                error: None,
            })
            .collect();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let mut state = ListState::default();
        terminal
            .draw(|f| {
                SettingsForm::new(&fields, Some(19), UiTheme::default()).render(
                    f,
                    f.area(),
                    &mut state,
                )
            })
            .unwrap();
        assert_eq!(state.selected(), Some(21));
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("Last value"));
        assert!(state.offset() > 0);
    }
    #[test]
    fn invalid_value_is_visible_and_tiny_empty_forms_are_safe() {
        let fields = [SettingField {
            category: "General",
            label: "Value",
            value: "bad",
            description: "Help",
            error: Some("Choose a valid option"),
        }];
        let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
        let mut state = ListState::default();
        terminal
            .draw(|f| {
                SettingsForm::new(&fields, Some(0), UiTheme::default()).render(
                    f,
                    f.area(),
                    &mut state,
                )
            })
            .unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("Choose a valid option"));
        for width in 0..4 {
            for height in 0..4 {
                let mut tiny = Terminal::new(TestBackend::new(width, height)).unwrap();
                tiny.draw(|f| {
                    SettingsForm::new(&[], Some(99), UiTheme::default()).render(
                        f,
                        f.area(),
                        &mut state,
                    )
                })
                .unwrap();
                assert_eq!(state.selected(), None);
            }
        }
    }
}

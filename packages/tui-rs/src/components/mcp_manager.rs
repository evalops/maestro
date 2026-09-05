//! Interactive MCP server manager.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

use crate::tools::{McpLifecycleState, McpServerStatus};

#[derive(Debug, Default)]
pub struct McpManager {
    statuses: Vec<McpServerStatus>,
    selected: usize,
    show_tools: bool,
    selected_tool: usize,
    catalog_mode: bool,
    selected_catalog: usize,
}

impl McpManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_statuses(&mut self, statuses: Vec<McpServerStatus>) {
        let selected_name = self.selected().map(|status| status.name.clone());
        self.statuses = statuses;
        self.selected = selected_name
            .as_deref()
            .and_then(|name| self.statuses.iter().position(|status| status.name == name))
            .unwrap_or(0)
            .min(self.statuses.len().saturating_sub(1));
    }

    #[must_use]
    pub fn selected(&self) -> Option<&McpServerStatus> {
        self.statuses.get(self.selected)
    }

    pub fn move_up(&mut self) {
        if self.catalog_mode {
            self.selected_catalog = self.selected_catalog.saturating_sub(1);
        } else if self.show_tools {
            self.selected_tool = self.selected_tool.saturating_sub(1);
        } else {
            self.selected = self.selected.saturating_sub(1);
        }
    }

    pub fn move_down(&mut self) {
        if self.catalog_mode {
            self.selected_catalog = (self.selected_catalog + 1).min(
                crate::mcp_config_cli::catalog_entries()
                    .len()
                    .saturating_sub(1),
            );
        } else if self.show_tools {
            self.selected_tool =
                (self.selected_tool + 1).min(self.selected_tool_count().saturating_sub(1));
        } else {
            self.selected = (self.selected + 1).min(self.statuses.len().saturating_sub(1));
        }
    }

    pub fn toggle_tools(&mut self) {
        if self.catalog_mode {
            return;
        }
        self.show_tools = !self.show_tools;
        self.selected_tool = 0;
    }

    #[must_use]
    pub fn selected_tool(&self) -> Option<(&str, bool)> {
        let status = self.selected()?;
        status
            .tools
            .get(self.selected_tool)
            .map(|tool| (tool.as_str(), true))
            .or_else(|| {
                status
                    .disabled_tools
                    .get(self.selected_tool.saturating_sub(status.tools.len()))
                    .map(|tool| (tool.as_str(), false))
            })
    }

    fn selected_tool_count(&self) -> usize {
        self.selected()
            .map(|status| status.tools.len() + status.disabled_tools.len())
            .unwrap_or(0)
    }

    pub fn enter_catalog(&mut self) {
        self.catalog_mode = true;
        self.selected_catalog = 0;
    }

    pub fn leave_catalog(&mut self) {
        self.catalog_mode = false;
    }

    #[must_use]
    pub fn in_catalog(&self) -> bool {
        self.catalog_mode
    }

    #[must_use]
    pub fn selected_catalog(&self) -> Option<&'static crate::mcp_config_cli::McpCatalogEntry> {
        crate::mcp_config_cli::catalog_entries().get(self.selected_catalog)
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect) {
        let width = area.width.saturating_sub(4).clamp(56, 108);
        let height = area.height.saturating_sub(2).clamp(14, 34);
        let modal = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, modal);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(" MCP servers ");
        let inner = block.inner(modal);
        frame.render_widget(block, modal);
        let sections = Layout::vertical([
            Constraint::Min(5),
            Constraint::Length(if self.show_tools { 9 } else { 5 }),
            Constraint::Length(2),
        ])
        .split(inner);

        if self.catalog_mode {
            let entries = crate::mcp_config_cli::catalog_entries();
            let rows = entries
                .iter()
                .map(|entry| {
                    ListItem::new(Line::from(vec![
                        Span::styled(
                            format!("{:<18}", entry.id),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                        Span::raw(entry.description),
                    ]))
                })
                .collect::<Vec<_>>();
            let mut state = ListState::default().with_selected(Some(self.selected_catalog));
            frame.render_stateful_widget(
                List::new(rows)
                    .highlight_symbol("› ")
                    .highlight_style(Style::default().bg(Color::Rgb(40, 50, 60))),
                sections[0],
                &mut state,
            );
            let detail = self.selected_catalog().map_or_else(
                || "No registry entries.".to_string(),
                |entry| format!("{} {}", entry.command, entry.args.join(" ")),
            );
            frame.render_widget(
                Paragraph::new(detail)
                    .block(Block::default().borders(Borders::TOP))
                    .wrap(Wrap { trim: true }),
                sections[1],
            );
            frame.render_widget(
                Paragraph::new("↑/↓ select  Enter add to user config  Esc back")
                    .style(Style::default().fg(Color::DarkGray)),
                sections[2],
            );
            return;
        }

        if self.statuses.is_empty() {
            frame.render_widget(
                Paragraph::new("No MCP servers configured. Press a to add one."),
                sections[0],
            );
        } else {
            let rows = self
                .statuses
                .iter()
                .map(|status| {
                    let state_style = state_style(status.state);
                    ListItem::new(Line::from(vec![
                        Span::styled(
                            format!("{:<22}", status.name),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(format!("{:<22}", status.state.label()), state_style),
                        Span::raw(format!(
                            "{:<10} {:<7} {} tools",
                            format!("{:?}", status.scope).to_lowercase(),
                            format!("{:?}", status.transport).to_lowercase(),
                            status.tools.len()
                        )),
                    ]))
                })
                .collect::<Vec<_>>();
            let mut state = ListState::default().with_selected(Some(self.selected));
            frame.render_stateful_widget(
                List::new(rows).highlight_symbol("› ").highlight_style(
                    Style::default()
                        .bg(Color::Rgb(40, 50, 60))
                        .add_modifier(Modifier::BOLD),
                ),
                sections[0],
                &mut state,
            );
        }

        let detail = self.selected().map_or_else(
            || Text::raw(""),
            |status| {
                let mut lines = Vec::new();
                if let Some(error) = &status.error {
                    lines.push(Line::styled(error.clone(), Style::default().fg(Color::Red)));
                } else if self.show_tools {
                    if status.tools.is_empty() && status.disabled_tools.is_empty() {
                        lines.push(Line::raw("No tools reported."));
                    }
                    for (index, tool) in status.tools.iter().enumerate() {
                        let marker = if index == self.selected_tool {
                            "›"
                        } else {
                            " "
                        };
                        lines.push(Line::raw(format!("{marker} ✓ {tool}")));
                    }
                    for (offset, tool) in status.disabled_tools.iter().enumerate() {
                        let marker = if status.tools.len() + offset == self.selected_tool {
                            "›"
                        } else {
                            " "
                        };
                        lines.push(Line::styled(
                            format!("{marker} ○ {tool} (disabled)"),
                            Style::default().fg(Color::DarkGray),
                        ));
                    }
                } else {
                    lines.push(Line::raw(format!(
                        "{} resources · {} prompts · {} disabled tools",
                        status.resources.len(),
                        status.prompts.len(),
                        status.disabled_tools.len()
                    )));
                }
                Text::from(lines)
            },
        );
        frame.render_widget(
            Paragraph::new(detail)
                .block(Block::default().borders(Borders::TOP))
                .wrap(Wrap { trim: true }),
            sections[1],
        );
        frame.render_widget(
            Paragraph::new(
                "↑/↓ select  Enter tools  Space enable/disable  r retry  a add  c catalog  o auth  x clear auth  d remove  p permissions  Esc close",
            )
            .style(Style::default().fg(Color::DarkGray))
            .wrap(Wrap { trim: true }),
            sections[2],
        );
    }
}

fn state_style(state: McpLifecycleState) -> Style {
    let color = match state {
        McpLifecycleState::Ready => Color::Green,
        McpLifecycleState::Connecting => Color::Yellow,
        McpLifecycleState::Disabled => Color::DarkGray,
        McpLifecycleState::NeedsAuth | McpLifecycleState::NeedsWorkspaceTrust => Color::Yellow,
        McpLifecycleState::Failed
        | McpLifecycleState::BlockedByPolicy
        | McpLifecycleState::ConfigError => Color::Red,
    };
    Style::default().fg(color)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{McpConfigScope, McpTransport};

    #[test]
    fn selection_survives_refresh_by_name() {
        let status = |name: &str| McpServerStatus {
            name: name.to_string(),
            state: McpLifecycleState::Ready,
            connected: true,
            scope: McpConfigScope::User,
            transport: McpTransport::Http,
            error: None,
            tools: vec!["run".to_string()],
            disabled_tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
        };
        let mut manager = McpManager::new();
        manager.set_statuses(vec![status("a"), status("b")]);
        manager.move_down();
        manager.set_statuses(vec![status("b"), status("c")]);
        assert_eq!(manager.selected().unwrap().name, "b");
    }
}

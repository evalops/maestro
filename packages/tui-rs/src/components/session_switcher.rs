//! Session switcher modal
//!
//! Provides a UI for listing and switching between sessions.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
    Frame,
};

use crate::session::{SessionInfo, SessionManager};

/// Session switcher modal state
pub struct SessionSwitcher {
    /// Session manager
    manager: SessionManager,
    /// Available sessions
    sessions: Vec<SessionInfo>,
    /// Selected index
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// Filter query
    query: String,
    /// Filtered sessions
    filtered: Vec<usize>,
    /// Loading state
    loading: bool,
    /// Error message
    error: Option<String>,
}

impl SessionSwitcher {
    /// Create a new session switcher
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            manager: SessionManager::new(cwd),
            sessions: Vec::new(),
            selected: 0,
            visible: false,
            query: String::new(),
            filtered: Vec::new(),
            loading: false,
            error: None,
        }
    }

    /// Show the modal and load sessions
    pub fn show(&mut self) {
        self.visible = true;
        self.query.clear();
        self.selected = 0;
        self.loading = true;
        self.error = None;
        self.refresh();
    }

    /// Hide the modal
    pub fn hide(&mut self) {
        self.visible = false;
    }

    /// Check if visible
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Refresh session list
    pub fn refresh(&mut self) {
        match self.manager.list_sessions() {
            Ok(sessions) => {
                self.sessions = sessions;
                self.loading = false;
                self.filter();
            }
            Err(e) => {
                self.error = Some(format!("Failed to load sessions: {}", e));
                self.loading = false;
            }
        }
    }

    /// Insert a character in filter
    pub fn insert_char(&mut self, c: char) {
        self.query.push(c);
        self.filter();
    }

    /// Delete character from filter
    pub fn backspace(&mut self) {
        self.query.pop();
        self.filter();
    }

    /// Clear filter
    pub fn clear_filter(&mut self) {
        self.query.clear();
        self.filter();
    }

    /// Filter sessions based on query
    fn filter(&mut self) {
        if self.query.is_empty() {
            self.filtered = (0..self.sessions.len()).collect();
        } else {
            let query = self.query.to_lowercase();
            self.filtered = self
                .sessions
                .iter()
                .enumerate()
                .filter(|(_, s)| {
                    s.id.to_lowercase().contains(&query)
                        || s.title().to_lowercase().contains(&query)
                })
                .map(|(i, _)| i)
                .collect();
        }
        // Reset selection if out of bounds
        if self.selected >= self.filtered.len() {
            self.selected = 0;
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
        if self.selected + 1 < self.filtered.len() {
            self.selected += 1;
        }
    }

    /// Get the selected session
    pub fn selected_session(&self) -> Option<&SessionInfo> {
        self.filtered
            .get(self.selected)
            .and_then(|&idx| self.sessions.get(idx))
    }

    /// Confirm selection and return the session ID
    pub fn confirm(&mut self) -> Option<String> {
        let id = self.selected_session().map(|s| s.id.clone());
        self.hide();
        id
    }

    /// Delete the selected session (removes the session file)
    pub fn delete_selected(&mut self) -> Result<(), String> {
        if let Some(session) = self.selected_session() {
            // Delete the session file
            std::fs::remove_file(&session.path)
                .map_err(|e| format!("Failed to delete session: {}", e))?;
            self.refresh();
        }
        Ok(())
    }

    /// Render the modal
    pub fn render(&self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Center the modal
        let modal_width = area.width.min(80).max(50);
        let modal_height = area.height.min(25).max(12);
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
        let title = format!(
            " Sessions ({}) ",
            if self.filtered.len() == self.sessions.len() {
                format!("{}", self.sessions.len())
            } else {
                format!("{}/{}", self.filtered.len(), self.sessions.len())
            }
        );
        let block = Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Magenta))
            .style(Style::default().bg(Color::Black));

        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        // Layout: filter input at top, sessions below, help at bottom
        let chunks =
            Layout::vertical([Constraint::Length(3), Constraint::Min(1), Constraint::Length(1)])
                .split(inner);

        // Render filter input
        self.render_filter(frame, chunks[0]);

        // Render sessions or loading/error state
        if self.loading {
            let loading = Paragraph::new("Loading sessions...")
                .style(Style::default().fg(Color::Yellow));
            frame.render_widget(loading, chunks[1]);
        } else if let Some(error) = &self.error {
            let error_widget =
                Paragraph::new(error.as_str()).style(Style::default().fg(Color::Red));
            frame.render_widget(error_widget, chunks[1]);
        } else {
            self.render_sessions(frame, chunks[1]);
        }

        // Render help
        self.render_help(frame, chunks[2]);
    }

    fn render_filter(&self, frame: &mut Frame, area: Rect) {
        let filter_text = if self.query.is_empty() {
            "Type to filter...".to_string()
        } else {
            self.query.clone()
        };

        let style = if self.query.is_empty() {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default().fg(Color::White)
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let filter = Paragraph::new(filter_text).style(style).block(block);

        frame.render_widget(filter, area);
    }

    fn render_sessions(&self, frame: &mut Frame, area: Rect) {
        if self.filtered.is_empty() {
            let empty_msg = if self.query.is_empty() {
                "No sessions found"
            } else {
                "No matching sessions"
            };
            let paragraph =
                Paragraph::new(empty_msg).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
            return;
        }

        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .enumerate()
            .filter_map(|(i, &idx)| {
                self.sessions
                    .get(idx)
                    .map(|s| self.render_session(s, i == self.selected))
            })
            .collect();

        let list = List::new(items);
        frame.render_widget(list, area);
    }

    fn render_session(&self, session: &SessionInfo, selected: bool) -> ListItem<'_> {
        let mut spans = Vec::new();

        // Favorite indicator
        if session.is_favorite() {
            spans.push(Span::styled("★ ", Style::default().fg(Color::Yellow)));
        }

        // Title
        let title: String = session.title().chars().take(30).collect();
        spans.push(Span::styled(
            title,
            Style::default()
                .fg(Color::White)
                .add_modifier(if selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ));

        // Timestamp
        let time_str = format_relative_time(&session.timestamp);
        spans.push(Span::styled(
            format!("  {}", time_str),
            Style::default().fg(Color::DarkGray),
        ));

        // Message count
        spans.push(Span::styled(
            format!("  {} msgs", session.stats.total_messages()),
            Style::default().fg(Color::Cyan),
        ));

        let style = if selected {
            Style::default().bg(Color::DarkGray)
        } else {
            Style::default()
        };

        ListItem::new(Line::from(spans)).style(style)
    }

    fn render_help(&self, frame: &mut Frame, area: Rect) {
        let help = Line::from(vec![
            Span::styled("↑↓", Style::default().fg(Color::Cyan)),
            Span::raw(" navigate  "),
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" select  "),
            Span::styled("Del", Style::default().fg(Color::Cyan)),
            Span::raw(" delete  "),
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" close"),
        ]);

        let paragraph = Paragraph::new(help);
        frame.render_widget(paragraph, area);
    }
}

impl Default for SessionSwitcher {
    fn default() -> Self {
        Self::new(".")
    }
}

/// Format a timestamp relative to now
fn format_relative_time(timestamp: &str) -> String {
    // Try to parse ISO timestamp
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        let now = chrono::Utc::now();
        let duration = now.signed_duration_since(dt.with_timezone(&chrono::Utc));

        if duration.num_minutes() < 1 {
            return "just now".to_string();
        } else if duration.num_hours() < 1 {
            let mins = duration.num_minutes();
            return format!("{}m ago", mins);
        } else if duration.num_days() < 1 {
            let hours = duration.num_hours();
            return format!("{}h ago", hours);
        } else if duration.num_days() < 7 {
            let days = duration.num_days();
            return format!("{}d ago", days);
        } else if duration.num_weeks() < 4 {
            let weeks = duration.num_weeks();
            return format!("{}w ago", weeks);
        }
    }

    // Fall back to raw timestamp
    timestamp.chars().take(10).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_relative_time_works() {
        // Just ensure it doesn't panic
        let _ = format_relative_time("2024-01-15T10:30:00Z");
        let _ = format_relative_time("invalid");
    }

    #[test]
    fn session_switcher_basics() {
        let mut switcher = SessionSwitcher::new("/tmp");
        assert!(!switcher.is_visible());

        switcher.show();
        assert!(switcher.is_visible());

        switcher.hide();
        assert!(!switcher.is_visible());
    }
}

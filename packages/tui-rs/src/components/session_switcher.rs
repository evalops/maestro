//! Session switcher modal
//!
//! Provides a UI for listing and switching between sessions.

use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

use crate::session::{
    IndexedSession, SessionInfo, SessionManager, SessionMeta, SessionReadError, SessionStats,
    ThinkingLevel,
};

/// Session switcher modal state
pub struct SessionSwitcher {
    /// Session manager
    manager: SessionManager,
    /// Session index cache path (fast previews); None disables the fast path
    index_path: Option<PathBuf>,
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
    /// List state for scrolling
    list_state: ListState,
}

impl SessionSwitcher {
    /// Create a new session switcher
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            manager: SessionManager::new(cwd),
            index_path: crate::session::default_index_path(),
            sessions: Vec::new(),
            selected: 0,
            visible: false,
            query: String::new(),
            filtered: Vec::new(),
            loading: false,
            error: None,
            list_state: ListState::default(),
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
    #[must_use]
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Refresh session list
    pub fn refresh(&mut self) {
        match self.load_sessions() {
            Ok(sessions) => {
                self.sessions = sessions;
                self.loading = false;
                self.filter();
            }
            Err(e) => {
                self.error = Some(format!("Failed to load sessions: {e}"));
                self.loading = false;
            }
        }
    }

    /// List sessions for the current working directory, preferring the
    /// session index (cached previews, no per-open parsing) and falling back
    /// to header reads when the index yields nothing.
    fn load_sessions(&self) -> Result<Vec<SessionInfo>, SessionReadError> {
        let indexed = self.list_from_index();
        if !indexed.is_empty() {
            return Ok(indexed);
        }
        self.manager.list_sessions()
    }

    /// Read this directory's sessions from the shared session index. Returns
    /// an empty list when the index is unavailable or has no entries here.
    fn list_from_index(&self) -> Vec<SessionInfo> {
        let Some(index_path) = self.index_path.as_deref() else {
            return Vec::new();
        };
        let dir = self.manager.sessions_dir();
        let Some(root) = dir.parent() else {
            return Vec::new();
        };
        crate::session::collect_sessions(root, Some(index_path))
            .iter()
            .filter(|session| session.path.parent() == Some(dir))
            .map(indexed_session_info)
            .collect()
    }

    /// Insert a character in filter
    pub fn insert_char(&mut self, c: char) {
        self.query.push(c);
        self.filter();
    }

    /// Insert a string into the filter (e.g. pasted text).
    pub fn insert_str(&mut self, s: &str) {
        self.query.push_str(s);
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
        // Sync list state
        if self.filtered.is_empty() {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(self.selected));
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

    /// Get the selected session
    #[must_use]
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

    /// Select a session by stable ID, refreshing the list if necessary.
    pub fn select_by_id(&mut self, id: &str) -> bool {
        self.refresh();
        let Some(index) = self.sessions.iter().position(|session| session.id == id) else {
            return false;
        };
        self.filtered = vec![index];
        self.selected = 0;
        self.list_state.select(Some(0));
        true
    }

    /// Delete the selected session (removes the session file)
    pub fn delete_selected(&mut self) -> Result<(), String> {
        if let Some(session) = self.selected_session() {
            // Delete the session file
            std::fs::remove_file(&session.path)
                .map_err(|e| format!("Failed to delete session: {e}"))?;
            self.refresh();
        }
        Ok(())
    }

    /// Render the modal
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Center the modal
        let modal_width = area.width.clamp(50, 80);
        let modal_height = area.height.clamp(12, 25);
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
        let chunks = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

        // Render filter input
        self.render_filter(frame, chunks[0]);

        // Render sessions or loading/error state
        if self.loading {
            let loading =
                Paragraph::new("Loading sessions...").style(Style::default().fg(Color::Yellow));
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

    fn render_sessions(&mut self, frame: &mut Frame, area: Rect) {
        if self.filtered.is_empty() {
            let empty_msg = if self.query.is_empty() {
                "No sessions found"
            } else {
                "No matching sessions"
            };
            let paragraph = Paragraph::new(empty_msg).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
            return;
        }

        // Collect items first to avoid borrowing self during iteration
        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .filter_map(|&idx| self.sessions.get(idx))
            .map(|s| Self::render_session_item(s))
            .collect();

        let list = List::new(items).highlight_style(Style::default().bg(Color::DarkGray));
        frame.render_stateful_widget(list, area, &mut self.list_state);
    }

    fn render_session_item(session: &SessionInfo) -> ListItem<'static> {
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
                .add_modifier(Modifier::BOLD),
        ));

        // Timestamp
        let time_str = format_relative_time(&session.timestamp);
        spans.push(Span::styled(
            format!("  {time_str}"),
            Style::default().fg(Color::DarkGray),
        ));

        // Message count
        spans.push(Span::styled(
            format!("  {} msgs", session.stats.total_messages()),
            Style::default().fg(Color::Cyan),
        ));

        ListItem::new(Line::from(spans))
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

/// Map a session-index entry onto the switcher's list model.
///
/// The index stores neither the model nor the per-role message breakdown, so
/// `model` is left empty and the total count sits in `user_messages` — only
/// `stats.total_messages()` is rendered here, and both fields are repopulated
/// from the full file when a session is actually resumed.
fn indexed_session_info(indexed: &IndexedSession) -> SessionInfo {
    let entry = &indexed.entry;
    SessionInfo {
        id: entry.id.clone(),
        path: indexed.path.clone(),
        cwd: entry.cwd.clone(),
        model: String::new(),
        thinking_level: ThinkingLevel::default(),
        timestamp: entry.started_at.clone(),
        stats: SessionStats {
            user_messages: entry.message_count,
            ..SessionStats::default()
        },
        meta: Some(SessionMeta {
            title: entry.title.clone(),
            favorite: entry.favorite,
            ..SessionMeta::default()
        }),
        preview: entry.preview.clone(),
        modified: Some(UNIX_EPOCH + Duration::from_millis(indexed.modified_ms)),
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
            return format!("{mins}m ago");
        } else if duration.num_days() < 1 {
            let hours = duration.num_hours();
            return format!("{hours}h ago");
        } else if duration.num_days() < 7 {
            let days = duration.num_days();
            return format!("{days}d ago");
        } else if duration.num_weeks() < 4 {
            let weeks = duration.num_weeks();
            return format!("{weeks}w ago");
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
    fn insert_str_appends_to_filter() {
        let mut switcher = SessionSwitcher::new("/tmp");
        switcher.insert_str("fix(tui)");
        switcher.insert_char('!');
        assert_eq!(switcher.query, "fix(tui)!");
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

    #[test]
    fn refresh_reads_previews_from_session_index() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("sessions");
        let dir = root.join("--tmp--");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2024-01-15T10-30-00-000Z_session-1.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        use std::io::Write;
        writeln!(
            file,
            r#"{{"type":"session","id":"session-1","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"openai/gpt-5.2","thinkingLevel":"medium"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:01Z","message":{{"role":"user","content":"untangle the resume flow","timestamp":0}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:02Z","message":{{"role":"assistant","content":[{{"type":"text","text":"On it."}}],"timestamp":1}}}}"#
        )
        .unwrap();
        drop(file);

        let index_path = temp.path().join("session-index.json");
        let mut switcher = SessionSwitcher::new("/tmp");
        switcher.manager = SessionManager::with_sessions_dir("/tmp", &dir);
        switcher.index_path = Some(index_path.clone());

        switcher.show();

        assert_eq!(switcher.sessions.len(), 1);
        let session = &switcher.sessions[0];
        // The model is only filled by the header-read fallback; an empty model
        // proves this row came from the index fast path.
        assert!(session.model.is_empty());
        assert_eq!(session.stats.total_messages(), 2);
        assert_eq!(session.title(), "untangle the resume flow");
        assert!(
            index_path.exists(),
            "refresh persisted the session index for the next open"
        );

        // Deleting the file prunes it from both the list and the index.
        switcher.delete_selected().unwrap();
        assert!(switcher.sessions.is_empty());
        let raw = std::fs::read_to_string(&index_path).unwrap();
        assert!(!raw.contains("session-1"));
    }

    #[test]
    fn refresh_falls_back_to_header_reads_when_index_is_empty() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("sessions");
        let dir = root.join("--tmp--");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2024-01-15T10-30-00-000Z_session-2.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        use std::io::Write;
        writeln!(
            file,
            r#"{{"type":"session","id":"session-2","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"openai/gpt-5.2","thinkingLevel":"medium"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:01Z","message":{{"role":"user","content":"fallback path","timestamp":0}}}}"#
        )
        .unwrap();
        drop(file);

        let mut switcher = SessionSwitcher::new("/tmp");
        switcher.manager = SessionManager::with_sessions_dir("/tmp", &dir);
        // Index disabled: the header-read fallback must still list the session.
        switcher.index_path = None;

        switcher.show();

        assert_eq!(switcher.sessions.len(), 1);
        assert_eq!(switcher.sessions[0].model, "openai/gpt-5.2");
    }
}

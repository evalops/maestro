//! Rewind picker modal
//!
//! Lists the current session's file checkpoints so the user can pick one to
//! restore. Opened by pressing Esc twice with an empty composer.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState},
};

use crate::checkpoints::Checkpoint;

/// Rewind picker modal state
pub struct RewindPicker {
    /// Checkpoints to choose from, newest first
    checkpoints: Vec<Checkpoint>,
    /// Selected index
    selected: usize,
    /// Whether the modal is visible
    visible: bool,
    /// List state for scrolling
    list_state: ListState,
}

impl Default for RewindPicker {
    fn default() -> Self {
        Self::new()
    }
}

impl RewindPicker {
    /// Create a new rewind picker
    #[must_use]
    pub fn new() -> Self {
        Self {
            checkpoints: Vec::new(),
            selected: 0,
            visible: false,
            list_state: ListState::default(),
        }
    }

    /// Show the modal with the given checkpoints (newest first)
    pub fn show(&mut self, checkpoints: Vec<Checkpoint>) {
        self.visible = true;
        self.checkpoints = checkpoints;
        self.selected = 0;
        self.list_state.select(Some(0));
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

    /// Move selection up
    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
            self.list_state.select(Some(self.selected));
        }
    }

    /// Move selection down
    pub fn move_down(&mut self) {
        if self.selected + 1 < self.checkpoints.len() {
            self.selected += 1;
            self.list_state.select(Some(self.selected));
        }
    }

    /// Confirm selection and return the chosen checkpoint
    pub fn confirm(&mut self) -> Option<Checkpoint> {
        let checkpoint = self.checkpoints.get(self.selected).cloned();
        self.hide();
        checkpoint
    }

    /// Summary of the files a checkpoint touched
    fn files_summary(checkpoint: &Checkpoint) -> String {
        const MAX_LISTED: usize = 3;
        let total = checkpoint.entries.len();
        let listed: Vec<&str> = checkpoint
            .entries
            .iter()
            .take(MAX_LISTED)
            .map(|entry| entry.path.as_str())
            .collect();
        let mut summary = format!(
            "{} file{}: {}",
            total,
            if total == 1 { "" } else { "s" },
            listed.join(", ")
        );
        if total > MAX_LISTED {
            summary.push_str(&format!(", +{} more", total - MAX_LISTED));
        }
        summary
    }

    /// Render the modal
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        if !self.visible {
            return;
        }

        // Two lines per checkpoint plus borders and a hint line.
        let content_height = (self.checkpoints.len() as u16) * 2 + 1;
        let modal_width = 72.min(area.width.saturating_sub(4));
        let modal_height = (content_height + 2)
            .min(area.height.saturating_sub(4))
            .max(5);
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

        let block = Block::default()
            .title(" Rewind to checkpoint ")
            .title_bottom(" ↑/↓ · Enter files · c conversation · b both · Esc cancel ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Magenta))
            .style(Style::default().bg(Color::Black));

        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        let items: Vec<ListItem> = self
            .checkpoints
            .iter()
            .map(|checkpoint| {
                let title = Line::from(vec![
                    Span::styled(
                        checkpoint.short_id().to_string(),
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(format!(
                        "  {}  \"{}\"",
                        checkpoint.created_at, checkpoint.prompt
                    )),
                ]);
                let files = Line::from(Span::styled(
                    format!("  {}", Self::files_summary(checkpoint)),
                    Style::default().fg(Color::DarkGray),
                ));
                ListItem::new(vec![title, files])
            })
            .collect();

        let list =
            List::new(items).highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White));
        frame.render_stateful_widget(list, inner, &mut self.list_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoints::{EntryKind, FileEntry};
    use std::path::PathBuf;

    fn checkpoint(id: &str, files: &[&str]) -> Checkpoint {
        Checkpoint {
            id: id.to_string(),
            created_at: "2026-07-24T00:00:00Z".to_string(),
            prompt: "do things".to_string(),
            repo_root: PathBuf::from("/tmp/repo"),
            head: None,
            user_turn_index: None,
            entries: files
                .iter()
                .map(|path| FileEntry {
                    path: (*path).to_string(),
                    kind: EntryKind::Modified,
                    pre_blob: Some("pre".to_string()),
                    post_hash: Some("post".to_string()),
                })
                .collect(),
        }
    }

    #[test]
    fn show_selects_newest_and_navigation_clamps() {
        let mut picker = RewindPicker::new();
        picker.show(vec![
            checkpoint("newest-xxx", &["a.rs"]),
            checkpoint("oldest-xxx", &["b.rs"]),
        ]);
        assert!(picker.is_visible());
        assert_eq!(picker.selected, 0);

        picker.move_up();
        assert_eq!(picker.selected, 0);
        picker.move_down();
        assert_eq!(picker.selected, 1);
        picker.move_down();
        assert_eq!(picker.selected, 1);

        let chosen = picker.confirm().expect("a checkpoint is selected");
        assert_eq!(chosen.id, "oldest-xxx");
        assert!(!picker.is_visible());
    }

    #[test]
    fn files_summary_truncates_long_lists() {
        let cp = checkpoint("id", &["a.rs", "b.rs", "c.rs", "d.rs"]);
        assert_eq!(
            RewindPicker::files_summary(&cp),
            "4 files: a.rs, b.rs, c.rs, +1 more"
        );
        let one = checkpoint("id", &["a.rs"]);
        assert_eq!(RewindPicker::files_summary(&one), "1 file: a.rs");
    }
}

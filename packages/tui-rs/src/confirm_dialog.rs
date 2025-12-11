//! Confirmation Dialog Widget
//!
//! A simple yes/no confirmation dialog for terminal UIs.
//!
//! Ported from OpenAI Codex CLI patterns (MIT licensed).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM DIALOG
// ─────────────────────────────────────────────────────────────────────────────

/// Result of a confirmation dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmResult {
    /// User confirmed (Yes).
    Confirmed,
    /// User cancelled (No/Escape).
    Cancelled,
    /// Dialog still pending.
    Pending,
}

/// A simple confirmation dialog.
#[derive(Debug, Clone)]
pub struct ConfirmDialog {
    /// Dialog title.
    title: String,
    /// Message to display.
    message: String,
    /// Currently selected option (true = yes, false = no).
    selected_yes: bool,
    /// Custom yes label.
    yes_label: String,
    /// Custom no label.
    no_label: String,
    /// Whether dialog is dangerous (destructive action).
    dangerous: bool,
    /// Result if resolved.
    result: Option<ConfirmResult>,
}

impl Default for ConfirmDialog {
    fn default() -> Self {
        Self::new("Confirm", "Are you sure?")
    }
}

impl ConfirmDialog {
    /// Create a new confirmation dialog.
    pub fn new(title: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            message: message.into(),
            selected_yes: false, // Default to No for safety
            yes_label: "Yes".to_string(),
            no_label: "No".to_string(),
            dangerous: false,
            result: None,
        }
    }

    /// Set custom button labels.
    pub fn labels(mut self, yes: impl Into<String>, no: impl Into<String>) -> Self {
        self.yes_label = yes.into();
        self.no_label = no.into();
        self
    }

    /// Mark as dangerous (destructive action).
    pub fn dangerous(mut self) -> Self {
        self.dangerous = true;
        self
    }

    /// Default to yes selected.
    pub fn default_yes(mut self) -> Self {
        self.selected_yes = true;
        self
    }

    /// Handle a key event.
    pub fn handle_key(&mut self, key: KeyEvent) -> ConfirmResult {
        if self.result.is_some() {
            return self.result.unwrap();
        }

        match key.code {
            // Arrow keys to switch selection
            KeyCode::Left | KeyCode::Right | KeyCode::Tab => {
                self.selected_yes = !self.selected_yes;
                ConfirmResult::Pending
            }
            // h/l vim keys
            KeyCode::Char('h') => {
                self.selected_yes = true;
                ConfirmResult::Pending
            }
            KeyCode::Char('l') => {
                self.selected_yes = false;
                ConfirmResult::Pending
            }
            // Direct selection
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                self.result = Some(ConfirmResult::Confirmed);
                ConfirmResult::Confirmed
            }
            KeyCode::Char('n') | KeyCode::Char('N') => {
                self.result = Some(ConfirmResult::Cancelled);
                ConfirmResult::Cancelled
            }
            // Enter confirms current selection
            KeyCode::Enter => {
                let result = if self.selected_yes {
                    ConfirmResult::Confirmed
                } else {
                    ConfirmResult::Cancelled
                };
                self.result = Some(result);
                result
            }
            // Escape always cancels
            KeyCode::Esc => {
                self.result = Some(ConfirmResult::Cancelled);
                ConfirmResult::Cancelled
            }
            // Ctrl+C cancels
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.result = Some(ConfirmResult::Cancelled);
                ConfirmResult::Cancelled
            }
            _ => ConfirmResult::Pending,
        }
    }

    /// Check if dialog is resolved.
    pub fn is_resolved(&self) -> bool {
        self.result.is_some()
    }

    /// Get the result if resolved.
    pub fn result(&self) -> Option<ConfirmResult> {
        self.result
    }

    /// Reset dialog for reuse.
    pub fn reset(&mut self) {
        self.result = None;
        self.selected_yes = false;
    }

    /// Calculate the preferred size for this dialog.
    pub fn preferred_size(&self) -> (u16, u16) {
        let msg_width = self.message.lines().map(|l| l.len()).max().unwrap_or(20);
        let title_width = self.title.len() + 4;
        let button_width = self.yes_label.len() + self.no_label.len() + 10;

        let width = msg_width.max(title_width).max(button_width).max(30) + 4;
        let height = self.message.lines().count() + 5; // title + padding + buttons

        (width.min(60) as u16, height.min(10) as u16)
    }
}

/// Widget for rendering a ConfirmDialog.
pub struct ConfirmDialogWidget<'a> {
    dialog: &'a ConfirmDialog,
}

impl<'a> ConfirmDialogWidget<'a> {
    pub fn new(dialog: &'a ConfirmDialog) -> Self {
        Self { dialog }
    }
}

impl Widget for ConfirmDialogWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Clear the area first
        Clear.render(area, buf);

        let border_style = if self.dialog.dangerous {
            Style::default().fg(Color::Red)
        } else {
            Style::default().fg(Color::Cyan)
        };

        let block = Block::default()
            .title(format!(" {} ", self.dialog.title))
            .borders(Borders::ALL)
            .border_style(border_style);

        let inner = block.inner(area);
        block.render(area, buf);

        if inner.height < 3 || inner.width < 10 {
            return;
        }

        // Render message
        let msg_lines: Vec<Line> = self
            .dialog
            .message
            .lines()
            .map(|l| Line::from(l.to_string()))
            .collect();

        let msg_height = msg_lines.len() as u16;
        let msg_area = Rect {
            x: inner.x + 1,
            y: inner.y,
            width: inner.width.saturating_sub(2),
            height: msg_height.min(inner.height.saturating_sub(2)),
        };

        Paragraph::new(msg_lines)
            .alignment(Alignment::Center)
            .render(msg_area, buf);

        // Render buttons at bottom
        let button_y = inner.y + inner.height.saturating_sub(1);
        if button_y <= inner.y {
            return;
        }

        let yes_style = if self.dialog.selected_yes {
            if self.dialog.dangerous {
                Style::default()
                    .fg(Color::White)
                    .bg(Color::Red)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Green)
                    .add_modifier(Modifier::BOLD)
            }
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let no_style = if !self.dialog.selected_yes {
            Style::default()
                .fg(Color::Black)
                .bg(Color::White)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let yes_text = format!(" {} ", self.dialog.yes_label);
        let no_text = format!(" {} ", self.dialog.no_label);
        let separator = "   ";

        let total_width = yes_text.len() + separator.len() + no_text.len();
        let start_x = inner.x + (inner.width.saturating_sub(total_width as u16)) / 2;

        let buttons = Line::from(vec![
            Span::styled(yes_text, yes_style),
            Span::raw(separator),
            Span::styled(no_text, no_style),
        ]);

        let button_area = Rect {
            x: start_x,
            y: button_y,
            width: total_width as u16,
            height: 1,
        };

        Paragraph::new(buttons).render(button_area, buf);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_no() {
        let dialog = ConfirmDialog::new("Test", "Message");
        assert!(!dialog.selected_yes);
    }

    #[test]
    fn y_key_confirms() {
        let mut dialog = ConfirmDialog::new("Test", "Message");
        let result = dialog.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE));
        assert_eq!(result, ConfirmResult::Confirmed);
        assert!(dialog.is_resolved());
    }

    #[test]
    fn n_key_cancels() {
        let mut dialog = ConfirmDialog::new("Test", "Message");
        let result = dialog.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));
        assert_eq!(result, ConfirmResult::Cancelled);
    }

    #[test]
    fn escape_cancels() {
        let mut dialog = ConfirmDialog::new("Test", "Message");
        let result = dialog.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(result, ConfirmResult::Cancelled);
    }

    #[test]
    fn arrow_toggles() {
        let mut dialog = ConfirmDialog::new("Test", "Message");
        assert!(!dialog.selected_yes);

        dialog.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        assert!(dialog.selected_yes);

        dialog.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        assert!(!dialog.selected_yes);
    }

    #[test]
    fn enter_confirms_selection() {
        let mut dialog = ConfirmDialog::new("Test", "Message").default_yes();
        let result = dialog.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(result, ConfirmResult::Confirmed);
    }

    #[test]
    fn custom_labels() {
        let dialog = ConfirmDialog::new("Delete", "Delete file?")
            .labels("Delete", "Keep")
            .dangerous();

        assert_eq!(dialog.yes_label, "Delete");
        assert_eq!(dialog.no_label, "Keep");
        assert!(dialog.dangerous);
    }

    #[test]
    fn preferred_size_reasonable() {
        let dialog = ConfirmDialog::new("Title", "Short message");
        let (w, h) = dialog.preferred_size();
        assert!(w >= 30);
        assert!(h >= 5);
    }

    #[test]
    fn reset_clears_result() {
        let mut dialog = ConfirmDialog::new("Test", "Message");
        dialog.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE));
        assert!(dialog.is_resolved());

        dialog.reset();
        assert!(!dialog.is_resolved());
    }
}

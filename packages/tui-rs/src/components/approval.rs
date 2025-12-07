//! Approval modal for tool call confirmation
//!
//! Displays a modal dialog for approving or denying tool executions.

use crossterm::event::KeyCode;
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};

use crate::palette::theme;

/// A pending approval request
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    /// Unique ID for this request
    pub call_id: String,
    /// Tool name
    pub tool: String,
    /// Human-readable reason for the action
    pub reason: Option<String>,
    /// Command or action being taken
    pub command: Option<String>,
    /// Full arguments (JSON)
    pub args: serde_json::Value,
    /// Whether this is a shell command
    pub is_shell: bool,
}

impl ApprovalRequest {
    pub fn new(
        call_id: impl Into<String>,
        tool: impl Into<String>,
        args: serde_json::Value,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            tool: tool.into(),
            reason: None,
            command: None,
            args,
            is_shell: false,
        }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    pub fn with_command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    pub fn shell(mut self) -> Self {
        self.is_shell = true;
        self
    }

    /// Extract a displayable command from args
    pub fn display_command(&self) -> String {
        if let Some(ref cmd) = self.command {
            return cmd.clone();
        }

        // Try to extract from args
        if let Some(cmd) = self.args.get("command").and_then(|v| v.as_str()) {
            return cmd.to_string();
        }

        // For other tools, show the tool name and action
        format!("{}: {}", self.tool, self.args)
    }
}

/// User's decision on an approval
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Cancel,
}

/// Approval modal widget
pub struct ApprovalModal<'a> {
    /// The request being displayed
    request: &'a ApprovalRequest,
    /// Number of requests in queue
    queue_size: usize,
    /// Whether the modal is focused
    focused: bool,
}

impl<'a> ApprovalModal<'a> {
    pub fn new(request: &'a ApprovalRequest) -> Self {
        Self {
            request,
            queue_size: 0,
            focused: true,
        }
    }

    pub fn queue_size(mut self, size: usize) -> Self {
        self.queue_size = size;
        self
    }

    pub fn focused(mut self, focused: bool) -> Self {
        self.focused = focused;
        self
    }

    /// Handle a key event, returning a decision if one was made
    pub fn handle_key(code: KeyCode) -> Option<ApprovalDecision> {
        match code {
            KeyCode::Char('y') | KeyCode::Char('Y') => Some(ApprovalDecision::Approve),
            KeyCode::Char('n') | KeyCode::Char('N') => Some(ApprovalDecision::Deny),
            KeyCode::Esc => Some(ApprovalDecision::Cancel),
            _ => None,
        }
    }
}

impl Widget for ApprovalModal<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Calculate modal size
        let modal_width = area.width.min(70).max(40);
        let modal_height = area.height.min(20).max(10);

        let x = (area.width.saturating_sub(modal_width)) / 2 + area.x;
        let y = (area.height.saturating_sub(modal_height)) / 2 + area.y;

        let modal_area = Rect::new(x, y, modal_width, modal_height);

        // Clear the area
        Clear.render(modal_area, buf);

        // Amber/warning colors for the border
        let border_color = Color::Rgb(251, 191, 36); // amber-400
        let bg_color = Color::Rgb(30, 30, 30);

        // Create double-bordered block
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color))
            .title(" Action Approval Required ")
            .title_style(
                Style::default()
                    .fg(border_color)
                    .add_modifier(Modifier::BOLD),
            )
            .style(Style::default().bg(bg_color));

        let inner = block.inner(modal_area);
        block.render(modal_area, buf);

        // Layout the content
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2), // Reason
                Constraint::Length(2), // Tool
                Constraint::Min(4),    // Command
                Constraint::Length(1), // Queue status
                Constraint::Length(2), // Key hints
            ])
            .split(inner);

        // Reason section
        if let Some(ref reason) = self.request.reason {
            let reason_text = Text::from(vec![Line::from(vec![
                Span::styled("Reason: ", Style::default().fg(Color::DarkGray)),
                Span::raw(reason.as_str()),
            ])]);
            Paragraph::new(reason_text)
                .wrap(Wrap { trim: true })
                .render(chunks[0], buf);
        }

        // Tool section
        let tool_line = Line::from(vec![
            Span::styled("Tool: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                &self.request.tool,
                Style::default()
                    .fg(theme::syntax_function())
                    .add_modifier(Modifier::BOLD),
            ),
            if self.request.is_shell {
                Span::styled(" (shell)", Style::default().fg(Color::DarkGray))
            } else {
                Span::raw("")
            },
        ]);
        Paragraph::new(tool_line).render(chunks[1], buf);

        // Command section
        let command = self.request.display_command();
        let command_lines: Vec<Line> = command
            .lines()
            .take(chunks[2].height as usize)
            .map(|line| {
                Line::from(Span::styled(
                    line.to_string(),
                    Style::default().fg(theme::syntax_string()),
                ))
            })
            .collect();

        let command_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(" Command ");

        let command_inner = command_block.inner(chunks[2]);
        command_block.render(chunks[2], buf);
        Paragraph::new(command_lines)
            .wrap(Wrap { trim: false })
            .render(command_inner, buf);

        // Queue status
        if self.queue_size > 0 {
            let queue_line = Line::from(vec![Span::styled(
                format!(
                    "{} more action{} awaiting approval",
                    self.queue_size,
                    if self.queue_size == 1 { "" } else { "s" }
                ),
                Style::default().fg(Color::DarkGray),
            )]);
            Paragraph::new(queue_line)
                .alignment(Alignment::Center)
                .render(chunks[3], buf);
        }

        // Key hints
        let hints = Line::from(vec![
            Span::styled(
                "[y]",
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" approve  "),
            Span::styled(
                "[n]",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Span::raw(" deny  "),
            Span::styled("[esc]", Style::default().fg(Color::DarkGray)),
            Span::raw(" cancel"),
        ]);
        Paragraph::new(hints)
            .alignment(Alignment::Center)
            .render(chunks[4], buf);
    }
}

/// Controller for managing approval queue
pub struct ApprovalController {
    /// Pending approvals
    queue: Vec<ApprovalRequest>,
    /// Whether the modal is currently shown
    visible: bool,
}

impl ApprovalController {
    pub fn new() -> Self {
        Self {
            queue: Vec::new(),
            visible: false,
        }
    }

    /// Add an approval request to the queue
    pub fn enqueue(&mut self, request: ApprovalRequest) {
        self.queue.push(request);
        if self.queue.len() == 1 {
            self.visible = true;
        }
    }

    /// Get the current request (if any)
    pub fn current(&self) -> Option<&ApprovalRequest> {
        self.queue.first()
    }

    /// Get the number of pending approvals (excluding current)
    pub fn pending_count(&self) -> usize {
        self.queue.len().saturating_sub(1)
    }

    /// Handle a decision for the current request
    pub fn decide(
        &mut self,
        decision: ApprovalDecision,
    ) -> Option<(ApprovalRequest, ApprovalDecision)> {
        if self.queue.is_empty() {
            return None;
        }

        let request = self.queue.remove(0);

        if self.queue.is_empty() {
            self.visible = false;
        }

        Some((request, decision))
    }

    /// Check if the modal should be visible
    pub fn is_visible(&self) -> bool {
        self.visible && !self.queue.is_empty()
    }

    /// Clear all pending approvals
    pub fn clear(&mut self) {
        self.queue.clear();
        self.visible = false;
    }

    /// Get total queue size
    pub fn total_count(&self) -> usize {
        self.queue.len()
    }
}

impl Default for ApprovalController {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_request_display_command() {
        let request = ApprovalRequest::new(
            "1",
            "bash",
            serde_json::json!({
                "command": "ls -la"
            }),
        );
        assert_eq!(request.display_command(), "ls -la");
    }

    #[test]
    fn approval_request_with_explicit_command() {
        let request =
            ApprovalRequest::new("1", "bash", serde_json::json!({})).with_command("echo hello");
        assert_eq!(request.display_command(), "echo hello");
    }

    #[test]
    fn approval_controller_enqueue() {
        let mut controller = ApprovalController::new();
        assert!(!controller.is_visible());

        controller.enqueue(ApprovalRequest::new("1", "bash", serde_json::json!({})));
        assert!(controller.is_visible());
        assert_eq!(controller.total_count(), 1);
    }

    #[test]
    fn approval_controller_decide() {
        let mut controller = ApprovalController::new();
        controller.enqueue(ApprovalRequest::new("1", "bash", serde_json::json!({})));
        controller.enqueue(ApprovalRequest::new("2", "write", serde_json::json!({})));

        let (request, decision) = controller.decide(ApprovalDecision::Approve).unwrap();
        assert_eq!(request.call_id, "1");
        assert_eq!(decision, ApprovalDecision::Approve);
        assert!(controller.is_visible()); // Still have one more

        let (request, _) = controller.decide(ApprovalDecision::Deny).unwrap();
        assert_eq!(request.call_id, "2");
        assert!(!controller.is_visible()); // Queue empty
    }

    #[test]
    fn approval_modal_handle_key() {
        assert_eq!(
            ApprovalModal::handle_key(KeyCode::Char('y')),
            Some(ApprovalDecision::Approve)
        );
        assert_eq!(
            ApprovalModal::handle_key(KeyCode::Char('n')),
            Some(ApprovalDecision::Deny)
        );
        assert_eq!(
            ApprovalModal::handle_key(KeyCode::Esc),
            Some(ApprovalDecision::Cancel)
        );
        assert_eq!(ApprovalModal::handle_key(KeyCode::Enter), None);
    }
}

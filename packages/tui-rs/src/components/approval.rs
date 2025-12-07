//! Tool approval modal for safe mode
//!
//! This module provides a modal dialog system for approving or denying tool executions
//! when running in safe mode. It implements a queue-based approval workflow with visual
//! feedback and keyboard-driven interaction.
//!
//! # Architecture
//!
//! The approval system has three main components:
//!
//! ## ApprovalRequest
//!
//! Represents a pending approval request with:
//! - `call_id`: Unique identifier for the tool call
//! - `tool`: Tool name (e.g., "bash", "write", "edit")
//! - `reason`: Human-readable explanation of what the tool will do
//! - `command`: The actual command/action being performed
//! - `args`: Full JSON arguments for the tool
//! - `is_shell`: Flag indicating if this is a shell command (higher risk)
//!
//! Builder pattern for construction:
//! ```rust,ignore
//! let request = ApprovalRequest::new("call_123", "bash", args)
//!     .with_reason("Install dependencies")
//!     .with_command("npm install")
//!     .shell();
//! ```
//!
//! ## ApprovalModal
//!
//! A stateless widget that renders the approval UI:
//! - Centered modal with amber border (warning color)
//! - Displays reason, tool name, and command
//! - Shows queue status if multiple approvals are pending
//! - Keyboard hints: `[y]` approve, `[n]` deny, `[esc]` cancel
//!
//! The modal uses `Clear` widget to render over the main UI and draw a bordered
//! panel in the center of the screen.
//!
//! ## ApprovalController
//!
//! Stateful controller managing the approval queue:
//! - Maintains a FIFO queue of pending approvals
//! - Tracks modal visibility
//! - Provides `enqueue()`, `decide()`, and `current()` methods
//! - Automatically shows/hides modal based on queue state
//!
//! # Widget Trait Implementation
//!
//! `ApprovalModal` implements `Widget` by:
//! 1. Calculating centered modal position (40-70 cols wide, 10-20 rows tall)
//! 2. Clearing the background with `Clear` widget
//! 3. Drawing a bordered block with amber title
//! 4. Using vertical layout to split content into sections:
//!    - Reason (if provided)
//!    - Tool name with shell indicator
//!    - Command display (bordered, scrollable)
//!    - Queue status
//!    - Keyboard hints
//!
//! # Keyboard Event Handling
//!
//! The modal provides a static `handle_key()` method that maps key codes to decisions:
//! - `y` or `Y` -> Approve
//! - `n` or `N` -> Deny
//! - `Esc` -> Cancel
//! - Other keys -> None
//!
//! This follows the pattern of separating event handling from rendering. The app's
//! event loop calls `handle_key()` and processes the decision via `ApprovalController`.
//!
//! # Usage Pattern
//!
//! ```rust,ignore
//! // Create controller (typically in app state)
//! let mut controller = ApprovalController::new();
//!
//! // Enqueue approval request
//! controller.enqueue(ApprovalRequest::new("call_1", "bash", args));
//!
//! // Render modal if visible
//! if controller.is_visible() {
//!     if let Some(request) = controller.current() {
//!         let modal = ApprovalModal::new(request)
//!             .queue_size(controller.pending_count())
//!             .focused(true);
//!         frame.render_widget(modal, frame.area());
//!     }
//! }
//!
//! // Handle keyboard event
//! if let Some(decision) = ApprovalModal::handle_key(key_code) {
//!     if let Some((request, decision)) = controller.decide(decision) {
//!         // Process the decision (approve/deny/cancel)
//!     }
//! }
//! ```
//!
//! # Layout Details
//!
//! The modal uses `ratatui::layout::Layout` with vertical constraints:
//! - Reason section: 2 rows (optional)
//! - Tool section: 2 rows
//! - Command block: Min 4 rows (scrollable)
//! - Queue status: 1 row
//! - Key hints: 2 rows
//!
//! The command is displayed in a bordered sub-block to visually separate it from
//! metadata, emphasizing the action being approved.
//!
//! # Design Principles
//!
//! - **Safety-first**: Amber warning colors and prominent approval UI
//! - **Transparency**: Shows full command and arguments before execution
//! - **Queue visibility**: Users know how many approvals are pending
//! - **Keyboard-driven**: Fast approval workflow with single-key actions
//! - **Stateless rendering**: Modal can be re-rendered without state loss

use crossterm::event::KeyCode;
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};

use crate::palette::theme;

/// A pending tool approval request for safe mode.
///
/// Represents a tool call that requires user approval before execution. Contains
/// all information needed to display in the approval modal and make an informed
/// decision.
///
/// # Builder Pattern
///
/// Use the builder pattern to construct requests:
///
/// ```rust,ignore
/// let request = ApprovalRequest::new("call_123", "bash", args)
///     .with_reason("Install project dependencies")
///     .with_command("npm install")
///     .shell();
/// ```
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

/// User's decision on a tool approval request.
///
/// - `Approve`: Allow the tool to execute
/// - `Deny`: Reject the tool execution
/// - `Cancel`: Cancel the approval flow (returns to agent without executing)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Cancel,
}

/// A stateless modal widget for displaying tool approval requests.
///
/// Renders a centered modal dialog with amber warning colors showing the tool
/// details and awaiting user decision (y/n/esc).
///
/// # Widget Trait
///
/// Implements `ratatui::widgets::Widget` to render directly to a buffer:
///
/// ```rust,ignore
/// let modal = ApprovalModal::new(&request)
///     .queue_size(2)  // Show "2 more actions awaiting approval"
///     .focused(true);
/// frame.render_widget(modal, frame.area());
/// ```
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

    /// Handle a keyboard event and return a decision if the key is bound.
    ///
    /// # Key Bindings
    ///
    /// - `y` or `Y` -> Approve
    /// - `n` or `N` -> Deny
    /// - `Esc` -> Cancel
    /// - Any other key -> None
    ///
    /// This is a static method since the modal itself is stateless. The app's
    /// event loop should call this and process the result through `ApprovalController`.
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
        let modal_width = area.width.clamp(40, 70);
        let modal_height = area.height.clamp(10, 20);

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

/// Stateful controller for managing the approval queue.
///
/// Maintains a FIFO queue of pending approval requests and tracks modal visibility.
/// Provides methods to enqueue requests, get the current request, and process decisions.
///
/// # Example
///
/// ```rust,ignore
/// let mut controller = ApprovalController::new();
///
/// // Add requests to queue
/// controller.enqueue(request);
///
/// // Get current request for display
/// if let Some(request) = controller.current() {
///     // Render modal
/// }
///
/// // Process decision
/// if let Some((request, decision)) = controller.decide(ApprovalDecision::Approve) {
///     // Execute or deny based on decision
/// }
/// ```
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

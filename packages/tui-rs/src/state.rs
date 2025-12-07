//! Application state
//!
//! Manages the chat state, messages, and UI state.

use std::time::{Instant, SystemTime};

use crate::agent::{FromAgent, TokenUsage};
use crate::components::textarea::TextArea;

/// A chat message in the conversation
#[derive(Debug, Clone)]
pub struct Message {
    /// Unique ID for this message
    pub id: String,
    /// Who sent this message
    pub role: MessageRole,
    /// The message content (may be streaming)
    pub content: String,
    /// Thinking/reasoning content (for models that support extended thinking)
    pub thinking: String,
    /// Whether this message is still being streamed
    pub streaming: bool,
    /// Tool calls associated with this message
    pub tool_calls: Vec<ToolCallState>,
    /// Token usage (for assistant messages)
    pub usage: Option<TokenUsage>,
    /// When this message was created
    pub timestamp: SystemTime,
    /// Whether thinking is expanded (for toggle)
    pub thinking_expanded: bool,
}

/// Who sent the message
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
}

/// State of a tool call
#[derive(Debug, Clone)]
pub struct ToolCallState {
    pub call_id: String,
    pub tool: String,
    pub args: serde_json::Value,
    pub status: ToolCallStatus,
    pub output: String,
}

/// Status of a tool call
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCallStatus {
    /// Waiting for user approval
    Pending,
    /// Running
    Running,
    /// Completed successfully
    Completed,
    /// Failed
    Failed,
}

/// Approval mode for tool execution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApprovalMode {
    /// Auto-approve all tool calls (YOLO mode)
    Yolo,
    /// Approve based on tool/command risk (default)
    #[default]
    Selective,
    /// Always require approval for all tool calls
    Safe,
}

impl ApprovalMode {
    /// Get the label for display
    pub fn label(&self) -> &'static str {
        match self {
            ApprovalMode::Yolo => "YOLO (auto-approve all)",
            ApprovalMode::Selective => "Selective (approve risky)",
            ApprovalMode::Safe => "Safe (approve all)",
        }
    }

    /// Parse from string
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "yolo" | "auto" | "trust" => Some(ApprovalMode::Yolo),
            "selective" | "default" | "normal" => Some(ApprovalMode::Selective),
            "safe" | "always" | "paranoid" => Some(ApprovalMode::Safe),
            _ => None,
        }
    }

    /// Cycle to next mode
    pub fn next(&self) -> Self {
        match self {
            ApprovalMode::Yolo => ApprovalMode::Selective,
            ApprovalMode::Selective => ApprovalMode::Safe,
            ApprovalMode::Safe => ApprovalMode::Yolo,
        }
    }
}

/// Main application state
pub struct AppState {
    /// All messages in the conversation
    pub messages: Vec<Message>,
    /// Input text area (multi-line support)
    pub textarea: TextArea,
    /// Agent model name
    pub model: Option<String>,
    /// Agent provider name
    pub provider: Option<String>,
    /// Current working directory
    pub cwd: Option<String>,
    /// Git branch (if in a repo)
    pub git_branch: Option<String>,
    /// Session ID
    pub session_id: Option<String>,
    /// Whether the agent is currently processing
    pub busy: bool,
    /// When the agent became busy (for elapsed time display)
    pub busy_since: Option<Instant>,
    /// Status message
    pub status: Option<String>,
    /// Scroll offset for message list
    pub scroll_offset: usize,
    /// Expanded tool call IDs (for toggling details)
    pub expanded_tool_calls: std::collections::HashSet<String>,
    /// Error message to display
    pub error: Option<String>,
    /// Current thinking header (extracted from bold text like **Header**)
    pub thinking_header: Option<String>,
    /// Full thinking buffer for the current response
    thinking_buffer: String,
    /// Zen mode - minimal UI (hide status bar, hints)
    pub zen_mode: bool,
    /// Approval mode for tool execution
    pub approval_mode: ApprovalMode,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            textarea: TextArea::new(),
            model: None,
            provider: None,
            cwd: None,
            git_branch: None,
            session_id: None,
            busy: false,
            busy_since: None,
            status: None,
            scroll_offset: 0,
            expanded_tool_calls: std::collections::HashSet::new(),
            error: None,
            thinking_header: None,
            thinking_buffer: String::new(),
            zen_mode: false,
            approval_mode: ApprovalMode::default(),
        }
    }

    /// Get elapsed time since busy started (in seconds)
    pub fn elapsed_busy_secs(&self) -> u64 {
        self.busy_since
            .map(|since| since.elapsed().as_secs())
            .unwrap_or(0)
    }

    /// Handle a message from the agent
    pub fn handle_agent_message(&mut self, msg: FromAgent) {
        match msg {
            FromAgent::Ready { model, provider } => {
                self.model = Some(model);
                self.provider = Some(provider);
                self.busy = false;
                self.busy_since = None;
            }

            FromAgent::ResponseStart { response_id } => {
                self.busy = true;
                self.busy_since = Some(Instant::now());
                self.messages.push(Message {
                    id: response_id,
                    role: MessageRole::Assistant,
                    content: String::new(),
                    thinking: String::new(),
                    streaming: true,
                    tool_calls: Vec::new(),
                    usage: None,
                    timestamp: SystemTime::now(),
                    thinking_expanded: false,
                });
            }

            FromAgent::ResponseChunk {
                response_id,
                content,
                is_thinking,
            } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == response_id) {
                    if is_thinking {
                        msg.thinking.push_str(&content);
                        // Accumulate thinking and extract header
                        self.thinking_buffer.push_str(&content);
                        if let Some(header) = extract_thinking_header(&self.thinking_buffer) {
                            self.thinking_header = Some(header);
                        }
                    } else {
                        msg.content.push_str(&content);
                    }
                }
            }

            FromAgent::ResponseEnd { response_id, usage } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == response_id) {
                    msg.streaming = false;
                    msg.usage = usage;
                }
                self.busy = false;
                self.busy_since = None;
                // Clear thinking state
                self.thinking_header = None;
                self.thinking_buffer.clear();
            }

            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                // Add tool call to the last assistant message
                if let Some(msg) = self
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| m.role == MessageRole::Assistant)
                {
                    msg.tool_calls.push(ToolCallState {
                        call_id,
                        tool,
                        args,
                        status: if requires_approval {
                            ToolCallStatus::Pending
                        } else {
                            ToolCallStatus::Running
                        },
                        output: String::new(),
                    });
                }
            }

            FromAgent::ToolStart { call_id } => {
                self.update_tool_status(&call_id, ToolCallStatus::Running);
            }

            FromAgent::ToolOutput { call_id, content } => {
                // Append output to the tool call
                for msg in self.messages.iter_mut().rev() {
                    for tc in msg.tool_calls.iter_mut() {
                        if tc.call_id == call_id {
                            tc.output.push_str(&content);
                            return;
                        }
                    }
                }
            }

            FromAgent::ToolEnd { call_id, success } => {
                self.update_tool_status(
                    &call_id,
                    if success {
                        ToolCallStatus::Completed
                    } else {
                        ToolCallStatus::Failed
                    },
                );
            }

            FromAgent::Error { message, fatal: _ } => {
                self.error = Some(message);
                self.busy = false;
                self.busy_since = None;
            }

            FromAgent::Status { message } => {
                self.status = Some(message);
            }

            FromAgent::SessionInfo {
                session_id,
                cwd,
                git_branch,
            } => {
                self.session_id = session_id;
                self.cwd = Some(cwd);
                self.git_branch = git_branch;
            }
        }
    }

    fn update_tool_status(&mut self, call_id: &str, status: ToolCallStatus) {
        for msg in self.messages.iter_mut().rev() {
            for tc in msg.tool_calls.iter_mut() {
                if tc.call_id == call_id {
                    tc.status = status;
                    return;
                }
            }
        }
    }

    /// Mark a tool call as failed with an inline note
    pub fn fail_tool_call(&mut self, call_id: &str, note: &str) {
        for msg in self.messages.iter_mut().rev() {
            for tc in msg.tool_calls.iter_mut() {
                if tc.call_id == call_id {
                    tc.status = ToolCallStatus::Failed;
                    if !note.is_empty() {
                        if !tc.output.is_empty() {
                            tc.output.push('\n');
                        }
                        tc.output.push_str(note);
                    }
                    return;
                }
            }
        }
    }

    /// Add a user message
    pub fn add_user_message(&mut self, content: String) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.messages.push(Message {
            id: id.clone(),
            role: MessageRole::User,
            content,
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });
        self.busy = true;
        self.busy_since = Some(Instant::now());
        id
    }

    /// Get current input text (read-only view)
    pub fn input(&self) -> &str {
        self.textarea.text()
    }

    /// Get cursor position
    pub fn cursor(&self) -> usize {
        self.textarea.cursor()
    }

    /// Insert character at cursor
    pub fn insert_char(&mut self, c: char) {
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert(cursor, c);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + c.len_utf8());
    }

    /// Insert a string at cursor
    pub fn insert_str(&mut self, s: &str) {
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert_str(cursor, s);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + s.len());
    }

    /// Delete character before cursor
    pub fn backspace(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            let prev = text[..cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            let mut new_text = text.to_string();
            new_text.remove(cursor - prev);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(cursor - prev);
        }
    }

    /// Delete character after cursor
    pub fn delete(&mut self) {
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            let mut new_text = text.to_string();
            new_text.remove(cursor);
            self.textarea.set_text(&new_text);
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            let prev = text[..cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.textarea.set_cursor(cursor - prev);
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            let next = text[cursor..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.textarea.set_cursor(cursor + next);
        }
    }

    /// Move cursor to start
    pub fn move_home(&mut self) {
        self.textarea.set_cursor(0);
    }

    /// Move cursor to end
    pub fn move_end(&mut self) {
        let len = self.textarea.text().len();
        self.textarea.set_cursor(len);
    }

    /// Take the input and reset
    pub fn take_input(&mut self) -> String {
        let input = self.textarea.text().to_string();
        self.textarea.set_text("");
        self.textarea.set_cursor(0);
        input
    }

    /// Set the input text directly
    pub fn set_input(&mut self, text: &str) {
        self.textarea.set_text(text);
        self.textarea.set_cursor(text.len());
    }

    /// Add a system message (for help, status, etc.)
    pub fn add_system_message(&mut self, content: String) {
        let id = uuid::Uuid::new_v4().to_string();
        self.messages.push(Message {
            id,
            role: MessageRole::Assistant,
            content,
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });
    }

    /// Toggle thinking expansion for a message
    pub fn toggle_thinking(&mut self, message_id: &str) {
        if let Some(msg) = self.messages.iter_mut().find(|m| m.id == message_id) {
            msg.thinking_expanded = !msg.thinking_expanded;
        }
    }

    /// Scroll up in message list
    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
    }

    /// Scroll down in message list
    pub fn scroll_down(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
    }

    /// Toggle tool call expansion
    pub fn toggle_tool_call(&mut self, call_id: &str) {
        if self.expanded_tool_calls.contains(call_id) {
            self.expanded_tool_calls.remove(call_id);
        } else {
            self.expanded_tool_calls.insert(call_id.to_string());
        }
    }

    /// Check if tool call is expanded
    pub fn is_tool_call_expanded(&self, call_id: &str) -> bool {
        self.expanded_tool_calls.contains(call_id)
    }
}

/// Extract the first bold header from thinking text (between ** and **)
fn extract_thinking_header(text: &str) -> Option<String> {
    // Look for **Header** pattern
    if let Some(start) = text.rfind("**") {
        let before_start = &text[..start];
        if let Some(open) = before_start.rfind("**") {
            let header = &text[open + 2..start];
            // Clean up the header - take first line only
            let header = header.lines().next().unwrap_or(header);
            if !header.is_empty() && header.len() < 100 {
                return Some(header.to_string());
            }
        }
    }
    None
}

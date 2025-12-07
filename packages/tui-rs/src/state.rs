//! Application state
//!
//! Manages the chat state, messages, and UI state.

use std::time::Instant;

use crate::agent::{FromAgent, TokenUsage};

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

/// Main application state
pub struct AppState {
    /// All messages in the conversation
    pub messages: Vec<Message>,
    /// Current input text
    pub input: String,
    /// Cursor position in input
    pub cursor: usize,
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
    /// Error message to display
    pub error: Option<String>,
    /// Current thinking header (extracted from bold text like **Header**)
    pub thinking_header: Option<String>,
    /// Full thinking buffer for the current response
    thinking_buffer: String,
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
            input: String::new(),
            cursor: 0,
            model: None,
            provider: None,
            cwd: None,
            git_branch: None,
            session_id: None,
            busy: false,
            busy_since: None,
            status: None,
            scroll_offset: 0,
            error: None,
            thinking_header: None,
            thinking_buffer: String::new(),
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
                            tc.output.push_str("\n");
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
        });
        self.busy = true;
        self.busy_since = Some(Instant::now());
        id
    }

    /// Insert character at cursor
    pub fn insert_char(&mut self, c: char) {
        self.input.insert(self.cursor, c);
        self.cursor += c.len_utf8();
    }

    /// Delete character before cursor
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self.input[..self.cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.input.remove(self.cursor - prev);
            self.cursor -= prev;
        }
    }

    /// Delete character after cursor
    pub fn delete(&mut self) {
        if self.cursor < self.input.len() {
            self.input.remove(self.cursor);
        }
    }

    /// Move cursor left
    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            let prev = self.input[..self.cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.cursor -= prev;
        }
    }

    /// Move cursor right
    pub fn move_right(&mut self) {
        if self.cursor < self.input.len() {
            let next = self.input[self.cursor..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.cursor += next;
        }
    }

    /// Move cursor to start
    pub fn move_home(&mut self) {
        self.cursor = 0;
    }

    /// Move cursor to end
    pub fn move_end(&mut self) {
        self.cursor = self.input.len();
    }

    /// Take the input and reset
    pub fn take_input(&mut self) -> String {
        let input = std::mem::take(&mut self.input);
        self.cursor = 0;
        input
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
        });
    }

    /// Scroll up in message list
    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
    }

    /// Scroll down in message list
    pub fn scroll_down(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
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

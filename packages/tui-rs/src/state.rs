//! # Application State Module
//!
//! This module manages the central state of the Composer TUI application.
//! It contains all mutable data that changes during program execution,
//! including messages, UI state, and agent status.
//!
//! ## Rust Concept: Centralized State
//!
//! Unlike component-based frameworks (React, Vue), this uses a single state
//! struct pattern. All state lives in `AppState`, which is passed around
//! by mutable reference (`&mut AppState`). This makes state changes explicit
//! and avoids the complexity of distributed state management.
//!
//! ## Why This Design?
//!
//! 1. **Single Source of Truth**: All state is in one place
//! 2. **No Hidden State**: Every field is visible in the struct
//! 3. **Easy Serialization**: Can easily save/restore entire state
//! 4. **Predictable Updates**: All mutations go through methods

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

use std::time::{Instant, SystemTime};
// `Instant` is for measuring elapsed time (monotonic clock - always goes forward)
// `SystemTime` is wall-clock time (can go backwards if system time changes)
// We use `Instant` for UI timers (elapsed seconds) and `SystemTime` for timestamps

use crate::agent::{FromAgent, TokenUsage};
// Import from our own crate using `crate::` prefix
// `FromAgent` is an enum of all messages the agent can send us

use crate::components::textarea::TextArea;
// Our multi-line text input component

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE TYPES
// ─────────────────────────────────────────────────────────────────────────────

/// A chat message in the conversation.
///
/// # Rust Concepts Used
///
/// - **`#[derive(...)]`**: Automatically implements traits:
///   - `Debug`: Enables `{:?}` formatting for printing
///   - `Clone`: Enables `.clone()` to create copies
///
/// - **Struct Fields**: All fields are `pub` (public), meaning code outside
///   this module can read and write them directly. This is a design choice -
///   for more encapsulation, we could use private fields with getter methods.
///
/// - **`String` vs `&str`**: We use `String` (owned) here because:
///   1. Messages live for an unknown duration
///   2. Content can be modified (appended to during streaming)
///   3. We need to store them in a `Vec`
///
///   If we used `&str` (borrowed), we'd need lifetime annotations and
///   couldn't modify the content.
#[derive(Debug, Clone)]
pub struct Message {
    /// Unique ID for this message.
    /// Used to find and update specific messages during streaming.
    pub id: String,

    /// Who sent this message (User or Assistant).
    pub role: MessageRole,

    /// The main message content.
    /// For streaming messages, this is appended to chunk by chunk.
    pub content: String,

    /// Thinking/reasoning content (for models that support extended thinking).
    /// Claude's extended thinking shows the model's reasoning process.
    pub thinking: String,

    /// Whether this message is still being streamed.
    /// When true, we show a cursor/animation. When false, the message is complete.
    pub streaming: bool,

    /// Tool calls associated with this message.
    /// An assistant message can request multiple tool executions.
    pub tool_calls: Vec<ToolCallState>,

    /// Token usage statistics (for assistant messages only).
    /// Shows input/output token counts for cost tracking.
    /// `Option<T>` because user messages don't have usage.
    pub usage: Option<TokenUsage>,

    /// When this message was created.
    /// Used for display and session recording.
    pub timestamp: SystemTime,

    /// Whether the thinking section is expanded in the UI.
    /// Users can toggle to show/hide extended thinking.
    pub thinking_expanded: bool,
}

/// Who sent the message.
///
/// # Rust Concepts Used
///
/// - **Enums**: Rust enums are "sum types" - a value can be ONE of the variants.
///   This is more powerful than enums in languages like Java/TypeScript because
///   each variant can hold different data (though this one doesn't).
///
/// - **`Copy` trait**: Small types that can be copied bit-for-bit (like integers)
///   can derive `Copy`. This means `=` creates a copy instead of a move.
///   Without `Copy`, assigning would transfer ownership.
///
/// - **`PartialEq` and `Eq`**: Enable `==` comparison.
///   `Eq` is a marker trait for types with true equality (no NaN issues).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    /// Message from the user
    User,
    /// Message from the AI assistant
    Assistant,
}

/// State of a tool call.
///
/// Represents a request from the AI to execute a tool (like running a
/// bash command or reading a file). We track its lifecycle from creation
/// through approval, execution, and completion.
///
/// # Rust Concept: Nested Data
///
/// This struct contains `serde_json::Value`, which is a dynamically-typed
/// JSON value. We use this because tool arguments vary by tool - bash takes
/// a command string, read takes a file path, etc. Rather than defining a
/// type for each tool's args, we keep them as JSON.
#[derive(Debug, Clone)]
pub struct ToolCallState {
    /// Unique identifier for this tool call.
    /// Used to match responses to requests.
    pub call_id: String,

    /// Name of the tool (e.g., "bash", "read", "write").
    pub tool: String,

    /// Tool arguments as JSON.
    /// Structure depends on the tool (e.g., {"command": "ls"} for bash).
    pub args: serde_json::Value,

    /// Current status of this tool call.
    pub status: ToolCallStatus,

    /// Output from the tool (stdout, file content, error messages).
    /// Appended to as the tool runs (for streaming output).
    pub output: String,
}

/// Status of a tool call in its lifecycle.
///
/// Tool calls go through this state machine:
/// ```text
/// Pending -> Running -> Completed
///    |          |
///    v          v
///  (rejected)  Failed
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCallStatus {
    /// Waiting for user approval.
    /// The tool won't run until the user approves it.
    Pending,

    /// Tool is currently executing.
    /// For bash commands, this means the process is running.
    Running,

    /// Tool completed successfully.
    /// Output contains the result.
    Completed,

    /// Tool execution failed.
    /// Output contains error information.
    Failed,
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL MODE
// ─────────────────────────────────────────────────────────────────────────────

/// Approval mode for tool execution.
///
/// Controls how strictly the user must approve tool calls. Higher trust
/// means faster interaction but more risk from malicious commands.
///
/// # Rust Concept: Default Trait
///
/// `#[default]` on a variant makes it the default when calling
/// `ApprovalMode::default()`. This is used when creating new state
/// without explicit configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApprovalMode {
    /// Auto-approve ALL tool calls without asking.
    /// Fast but dangerous - a malicious prompt could run `rm -rf /`.
    /// Only use when you fully trust the conversation.
    Yolo,

    /// Approve based on tool/command risk (default).
    /// Safe commands (ls, git status) run automatically.
    /// Risky commands (rm, sudo) require approval.
    #[default]
    Selective,

    /// Require approval for ALL tool calls.
    /// Safest mode - nothing runs without your OK.
    /// Slower but maximum control.
    Safe,
}

impl ApprovalMode {
    /// Get human-readable label for display in the UI.
    ///
    /// # Rust Concept: `&'static str`
    ///
    /// Returning `&'static str` means we return a reference to a string
    /// that lives forever (it's compiled into the binary). This is more
    /// efficient than returning `String` because there's no allocation.
    pub fn label(&self) -> &'static str {
        match self {
            ApprovalMode::Yolo => "YOLO (auto-approve all)",
            ApprovalMode::Selective => "Selective (approve risky)",
            ApprovalMode::Safe => "Safe (approve all)",
        }
    }

    /// Parse approval mode from a string.
    ///
    /// Accepts various aliases for user convenience.
    ///
    /// # Returns
    ///
    /// `Some(mode)` if the string is recognized, `None` otherwise.
    ///
    /// # Rust Concept: Returning Option
    ///
    /// Rather than throwing an exception for invalid input, we return
    /// `Option<Self>`. The caller must handle both cases, which the
    /// compiler enforces. This prevents runtime crashes from unhandled
    /// invalid input.
    pub fn parse(s: &str) -> Option<Self> {
        // Convert to lowercase for case-insensitive matching
        match s.to_lowercase().as_str() {
            "yolo" | "auto" | "trust" => Some(ApprovalMode::Yolo),
            "selective" | "default" | "normal" => Some(ApprovalMode::Selective),
            "safe" | "always" | "paranoid" => Some(ApprovalMode::Safe),
            _ => None, // Unknown mode - return None, not an error
        }
    }

    /// Cycle to the next mode (for keyboard shortcuts).
    ///
    /// Creates a circular cycle: Yolo -> Selective -> Safe -> Yolo
    ///
    /// # Rust Concept: `&self` vs `self`
    ///
    /// Taking `&self` (borrowed reference) means we don't consume the value.
    /// We can call this method and still use the original value afterward.
    /// Taking `self` (owned) would consume the value.
    pub fn next(&self) -> Self {
        match self {
            ApprovalMode::Yolo => ApprovalMode::Selective,
            ApprovalMode::Selective => ApprovalMode::Safe,
            ApprovalMode::Safe => ApprovalMode::Yolo,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION STATE
// ─────────────────────────────────────────────────────────────────────────────

/// Main application state.
///
/// This struct holds ALL mutable state for the application. Everything that
/// can change during program execution lives here. This centralized approach
/// makes it easy to understand what data exists and how it can change.
///
/// # Rust Concept: No Derive on Complex Structs
///
/// Notice we don't derive `Clone` or `Debug` here. That's because some fields
/// (like `HashSet`) have complex implementations, and we don't need to clone
/// the entire state (we pass it by reference instead).
///
/// # Rust Concept: Public Fields
///
/// All fields are `pub` for simplicity. In a library meant for external use,
/// we might make fields private and use methods for access. But for internal
/// use, direct field access is simpler and faster.
pub struct AppState {
    /// All messages in the conversation.
    /// Ordered chronologically (oldest first).
    /// We use `Vec` because we frequently append and iterate, rarely remove.
    pub messages: Vec<Message>,

    /// Input text area for composing messages.
    /// Supports multi-line editing with cursor movement.
    pub textarea: TextArea,

    /// Currently selected AI model name (e.g., "claude-3-opus").
    /// `Option` because it may not be known until the agent is ready.
    pub model: Option<String>,

    /// AI provider name (e.g., "anthropic", "openai").
    pub provider: Option<String>,

    /// Current working directory.
    /// Displayed in the UI and used for relative path resolution.
    pub cwd: Option<String>,

    /// Current git branch (if in a git repository).
    /// Displayed in the status bar for context.
    pub git_branch: Option<String>,

    /// Current session ID for persistence.
    /// Used to resume this conversation later.
    pub session_id: Option<String>,

    /// Whether the agent is currently processing a request.
    /// When true, we show a loading spinner and disable new input.
    pub busy: bool,

    /// When the agent became busy (for elapsed time display).
    /// Using `Instant` (monotonic clock) ensures accurate elapsed time
    /// even if system time changes.
    pub busy_since: Option<Instant>,

    /// Status message to display in the UI.
    /// Transient messages like "Copied to clipboard".
    pub status: Option<String>,

    /// Scroll offset for the message list.
    /// Higher values scroll further up (show older messages).
    pub scroll_offset: usize,

    /// Set of expanded tool call IDs.
    /// Tool calls in this set show full details; others show summary.
    /// Using `HashSet` for O(1) contains/insert/remove operations.
    pub expanded_tool_calls: std::collections::HashSet<String>,

    /// Error message to display.
    /// Shown prominently in the UI when set.
    pub error: Option<String>,

    /// Current thinking header (extracted from **Header** in thinking text).
    /// Shown while the model is thinking to indicate what it's working on.
    pub thinking_header: Option<String>,

    /// Full thinking buffer for the current response.
    /// Private because it's only used internally for header extraction.
    /// Public API uses the `thinking` field on individual messages.
    thinking_buffer: String,

    /// Zen mode - minimal UI.
    /// When enabled, hides status bar, hints, and other chrome.
    pub zen_mode: bool,

    /// Current approval mode for tool execution.
    /// Controls whether tools run automatically or require approval.
    pub approval_mode: ApprovalMode,
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/// Implement `Default` trait for `AppState`.
///
/// # Rust Concept: Traits
///
/// Traits are like interfaces in other languages. They define a set of
/// methods that a type must implement. `Default` is a standard library
/// trait that provides a `default()` method for creating a default value.
///
/// By implementing `Default`, we enable:
/// - `AppState::default()` to create a new state
/// - Generic code that requires `T: Default` to work with `AppState`
impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPSTATE IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/// Implementation block for `AppState`.
///
/// # Rust Concept: impl Blocks
///
/// In Rust, methods are defined in `impl` blocks separate from the struct
/// definition. A type can have multiple `impl` blocks, which is useful for
/// organizing code or conditional compilation.
impl AppState {
    /// Create a new `AppState` with default values.
    ///
    /// This is the primary constructor. All fields start empty/default.
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),      // Empty message list
            textarea: TextArea::new(), // Empty input area
            model: None,               // No model selected yet
            provider: None,            // No provider yet
            cwd: None,                 // No working directory
            git_branch: None,          // Not in a git repo (yet)
            session_id: None,          // No session yet
            busy: false,               // Not processing
            busy_since: None,          // No timer running
            status: None,              // No status message
            scroll_offset: 0,          // At bottom of messages
            expanded_tool_calls: std::collections::HashSet::new(),
            error: None,           // No error
            thinking_header: None, // No thinking in progress
            thinking_buffer: String::new(),
            zen_mode: false,                        // Full UI by default
            approval_mode: ApprovalMode::default(), // Selective mode
        }
    }

    /// Get elapsed time since the agent became busy (in seconds).
    ///
    /// Returns 0 if not currently busy.
    ///
    /// # Rust Concept: Method Chaining with Option
    ///
    /// `.map()` transforms `Option<T>` to `Option<U>` by applying a function.
    /// `.unwrap_or()` extracts the value or returns a default if `None`.
    ///
    /// This pattern avoids explicit `if let Some(x) = ...` blocks.
    pub fn elapsed_busy_secs(&self) -> u64 {
        self.busy_since
            .map(|since| since.elapsed().as_secs())
            .unwrap_or(0)
    }

    /// Handle a message from the agent.
    ///
    /// This is the main state machine that processes all agent events.
    /// Each event type triggers specific state updates.
    ///
    /// # Rust Concept: Pattern Matching with Enums
    ///
    /// `match` on an enum must handle all variants. This is exhaustive
    /// matching - the compiler ensures we don't miss any cases. If we
    /// add a new `FromAgent` variant, this code won't compile until
    /// we add a handler for it.
    pub fn handle_agent_message(&mut self, msg: FromAgent) {
        match msg {
            // Agent is ready with its model info
            FromAgent::Ready { model, provider } => {
                self.model = Some(model);
                self.provider = Some(provider);
                self.busy = false;
                self.busy_since = None;
            }

            // Agent started generating a response
            FromAgent::ResponseStart { response_id } => {
                self.busy = true;
                self.busy_since = Some(Instant::now());

                // Create a new empty message that will be filled in by chunks
                self.messages.push(Message {
                    id: response_id,
                    role: MessageRole::Assistant,
                    content: String::new(),
                    thinking: String::new(),
                    streaming: true, // Will receive more content
                    tool_calls: Vec::new(),
                    usage: None,
                    timestamp: SystemTime::now(),
                    thinking_expanded: false,
                });
            }

            // Received a chunk of the response (streaming)
            FromAgent::ResponseChunk {
                response_id,
                content,
                is_thinking,
            } => {
                // Find the message being streamed and append content
                // Rust Concept: `.iter_mut()` returns mutable references
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == response_id) {
                    if is_thinking {
                        // Append to thinking content
                        msg.thinking.push_str(&content);

                        // Also track in our buffer to extract headers
                        self.thinking_buffer.push_str(&content);
                        if let Some(header) = extract_thinking_header(&self.thinking_buffer) {
                            self.thinking_header = Some(header);
                        }
                    } else {
                        // Append to main content
                        msg.content.push_str(&content);
                    }
                }
            }

            // Response finished
            FromAgent::ResponseEnd { response_id, usage } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == response_id) {
                    msg.streaming = false;
                    msg.usage = usage;
                }
                self.busy = false;
                self.busy_since = None;

                // Clear thinking state for next response
                self.thinking_header = None;
                self.thinking_buffer.clear();
            }

            // Agent wants to call a tool
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                // Add tool call to the most recent assistant message
                // `.rev()` iterates in reverse order (newest first)
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

            // Tool execution started
            FromAgent::ToolStart { call_id } => {
                self.update_tool_status(&call_id, ToolCallStatus::Running);
            }

            // Tool produced output (may be called multiple times for streaming)
            FromAgent::ToolOutput { call_id, content } => {
                // Find and append to the tool call's output
                for msg in self.messages.iter_mut().rev() {
                    for tc in msg.tool_calls.iter_mut() {
                        if tc.call_id == call_id {
                            tc.output.push_str(&content);
                            return; // Early return once found
                        }
                    }
                }
            }

            // Tool finished
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

            // Error occurred
            FromAgent::Error { message, fatal: _ } => {
                self.error = Some(message);
                self.busy = false;
                self.busy_since = None;
            }

            // Status update (informational)
            FromAgent::Status { message } => {
                self.status = Some(message);
            }

            // Session info updated
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

    /// Update the status of a tool call.
    ///
    /// Helper method to find and update a tool call across all messages.
    /// Private because it's only used internally.
    fn update_tool_status(&mut self, call_id: &str, status: ToolCallStatus) {
        // Search in reverse (most recent messages first) for efficiency
        for msg in self.messages.iter_mut().rev() {
            for tc in msg.tool_calls.iter_mut() {
                if tc.call_id == call_id {
                    tc.status = status;
                    return; // Found it, done
                }
            }
        }
    }

    /// Mark a tool call as failed with an error note.
    ///
    /// Used when we reject a tool call locally (e.g., user declined approval).
    pub fn fail_tool_call(&mut self, call_id: &str, note: &str) {
        for msg in self.messages.iter_mut().rev() {
            for tc in msg.tool_calls.iter_mut() {
                if tc.call_id == call_id {
                    tc.status = ToolCallStatus::Failed;
                    if !note.is_empty() {
                        // Add separator if there's existing output
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

    /// Add a user message to the conversation.
    ///
    /// Creates a new message, marks us as busy, and returns the message ID.
    ///
    /// # Returns
    ///
    /// The ID of the new message (can be used for tracking).
    pub fn add_user_message(&mut self, content: String) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.messages.push(Message {
            id: id.clone(), // Clone because we return it and store it
            role: MessageRole::User,
            content,
            thinking: String::new(),
            streaming: false, // User messages are complete immediately
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });
        self.busy = true;
        self.busy_since = Some(Instant::now());
        id
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEXT INPUT METHODS
    // ─────────────────────────────────────────────────────────────────────────
    //
    // These methods delegate to the TextArea component but provide a simpler
    // interface for common operations.

    /// Get current input text (read-only view).
    ///
    /// # Rust Concept: Returning References
    ///
    /// Returning `&str` instead of `String` avoids allocation. The caller
    /// gets a view into our data without copying it. The lifetime of the
    /// returned reference is tied to `&self`.
    pub fn input(&self) -> &str {
        self.textarea.text()
    }

    /// Get cursor position (byte offset into the text).
    pub fn cursor(&self) -> usize {
        self.textarea.cursor()
    }

    /// Insert a character at the cursor position.
    ///
    /// # Rust Concept: UTF-8 String Handling
    ///
    /// Rust strings are UTF-8. Characters can be 1-4 bytes. We use
    /// `char.len_utf8()` to get the byte length for cursor movement.
    /// This ensures we don't split multi-byte characters.
    pub fn insert_char(&mut self, c: char) {
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert(cursor, c);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + c.len_utf8());
    }

    /// Insert a string at the cursor position.
    pub fn insert_str(&mut self, s: &str) {
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert_str(cursor, s);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + s.len());
    }

    /// Delete the character before the cursor (Backspace key).
    ///
    /// Handles multi-byte UTF-8 characters correctly.
    pub fn backspace(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            // Find the byte length of the previous character
            let prev = text[..cursor]
                .chars()
                .last() // Get the last char before cursor
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            let mut new_text = text.to_string();
            new_text.remove(cursor - prev);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(cursor - prev);
        }
    }

    /// Delete the character after the cursor (Delete key).
    pub fn delete(&mut self) {
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            let mut new_text = text.to_string();
            new_text.remove(cursor);
            self.textarea.set_text(&new_text);
        }
    }

    /// Move cursor one character left.
    pub fn move_left(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            // Find byte length of previous character for proper UTF-8 handling
            let prev = text[..cursor]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.textarea.set_cursor(cursor - prev);
        }
    }

    /// Move cursor one character right.
    pub fn move_right(&mut self) {
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            // Find byte length of next character
            let next = text[cursor..]
                .chars()
                .next() // Get the first char after cursor
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.textarea.set_cursor(cursor + next);
        }
    }

    /// Move cursor to the start of input (Home key).
    pub fn move_home(&mut self) {
        self.textarea.set_cursor(0);
    }

    /// Move cursor to the end of input (End key).
    pub fn move_end(&mut self) {
        let len = self.textarea.text().len();
        self.textarea.set_cursor(len);
    }

    /// Take the current input and clear it.
    ///
    /// Used when submitting input - we extract the text and reset.
    ///
    /// # Rust Concept: Ownership Transfer
    ///
    /// "Taking" implies ownership transfer. We return the String (owned)
    /// and clear the internal state. The caller now owns the string.
    pub fn take_input(&mut self) -> String {
        let input = self.textarea.text().to_string();
        self.textarea.set_text("");
        self.textarea.set_cursor(0);
        input
    }

    /// Set the input text directly (e.g., for command history).
    pub fn set_input(&mut self, text: &str) {
        self.textarea.set_text(text);
        self.textarea.set_cursor(text.len()); // Cursor at end
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MESSAGE MANIPULATION METHODS
    // ─────────────────────────────────────────────────────────────────────────

    /// Add a system message (for help, status, errors, etc.).
    ///
    /// System messages appear as assistant messages but are locally generated,
    /// not from the AI.
    pub fn add_system_message(&mut self, content: String) {
        let id = uuid::Uuid::new_v4().to_string();
        self.messages.push(Message {
            id,
            role: MessageRole::Assistant, // Display as assistant
            content,
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });
    }

    /// Toggle whether thinking is expanded for a message.
    pub fn toggle_thinking(&mut self, message_id: &str) {
        if let Some(msg) = self.messages.iter_mut().find(|m| m.id == message_id) {
            msg.thinking_expanded = !msg.thinking_expanded;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SCROLL METHODS
    // ─────────────────────────────────────────────────────────────────────────

    /// Scroll up in the message list.
    ///
    /// # Rust Concept: `saturating_sub`
    ///
    /// `saturating_sub` prevents underflow - if the result would be negative,
    /// it returns 0 instead. This is safer than wrapping subtraction which
    /// could give a huge number on underflow.
    pub fn scroll_up(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
    }

    /// Scroll down in the message list.
    ///
    /// Uses `saturating_add` to prevent overflow (though unlikely for scroll).
    pub fn scroll_down(&mut self, amount: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TOOL CALL EXPANSION METHODS
    // ─────────────────────────────────────────────────────────────────────────

    /// Toggle whether a tool call is expanded.
    ///
    /// Expanded tool calls show full output; collapsed show a summary.
    pub fn toggle_tool_call(&mut self, call_id: &str) {
        if self.expanded_tool_calls.contains(call_id) {
            self.expanded_tool_calls.remove(call_id);
        } else {
            self.expanded_tool_calls.insert(call_id.to_string());
        }
    }

    /// Check if a tool call is expanded.
    pub fn is_tool_call_expanded(&self, call_id: &str) -> bool {
        self.expanded_tool_calls.contains(call_id)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/// Extract the first bold header from thinking text.
///
/// Looks for `**Header**` patterns in the text and returns the header text.
/// Used to show a summary of what the model is thinking about.
///
/// # Arguments
///
/// * `text` - The thinking text to search
///
/// # Returns
///
/// `Some(header)` if a header was found, `None` otherwise.
fn extract_thinking_header(text: &str) -> Option<String> {
    // Look for **Header** pattern by finding the last closing **
    // then looking backward for the opening **
    if let Some(start) = text.rfind("**") {
        let before_start = &text[..start];
        if let Some(open) = before_start.rfind("**") {
            let header = &text[open + 2..start];
            // Take only the first line and validate length
            let header = header.lines().next().unwrap_or(header);
            if !header.is_empty() && header.len() < 100 {
                return Some(header.to_string());
            }
        }
    }
    None
}

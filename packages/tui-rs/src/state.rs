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

use serde::{Deserialize, Serialize};

use crate::agent::{FromAgent, TokenUsage};
use crate::kill_ring::{next_word_start, previous_word_start, KillRing};
use crate::session::ThinkingLevel;
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

    /// Tool was blocked by a hook.
    /// A `PreToolUse` hook prevented execution (e.g., safety check).
    Blocked,
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
    #[must_use]
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
    #[must_use]
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
    #[must_use]
    pub fn next(&self) -> Self {
        match self {
            ApprovalMode::Yolo => ApprovalMode::Selective,
            ApprovalMode::Selective => ApprovalMode::Safe,
            ApprovalMode::Safe => ApprovalMode::Yolo,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE MODES
// ─────────────────────────────────────────────────────────────────────────────

/// Queue mode for prompts while the agent is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueMode {
    /// Allow queueing multiple prompts while running
    #[default]
    All,
    /// Only allow one-at-a-time (no queueing while running)
    One,
}

impl QueueMode {
    /// Human-readable label for display in the UI.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            QueueMode::All => "all (queue while running)",
            QueueMode::One => "one-at-a-time (pause while running)",
        }
    }

    /// Short label for compact UI badges.
    #[must_use]
    pub fn short_label(&self) -> &'static str {
        match self {
            QueueMode::All => "all",
            QueueMode::One => "one",
        }
    }

    /// Parse a queue mode from user input.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "all" => Some(QueueMode::All),
            "one" | "single" => Some(QueueMode::One),
            _ => None,
        }
    }

    /// Whether queueing is allowed under this mode.
    #[must_use]
    pub fn allows_queue(&self) -> bool {
        matches!(self, QueueMode::All)
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

    /// Cached inner width for input cursor movement (in columns).
    pub input_width: u16,

    /// Preferred cursor column when moving up/down.
    input_preferred_col: Option<u16>,
    /// Emacs-style kill ring for yank/pop behavior.
    kill_ring: KillRing,
    /// Whether the last edit was a kill (for kill-ring append behavior).
    kill_chain_active: bool,

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
    /// When true, we show a loading spinner and adjust input hints.
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

    /// Current thinking level for runtime badges and UI hints.
    pub thinking_level: ThinkingLevel,

    /// Full thinking buffer for the current response.
    /// Private because it's only used internally for header extraction.
    /// Public API uses the `thinking` field on individual messages.
    thinking_buffer: String,

    /// Zen mode - minimal UI.
    /// When enabled, hides status bar, hints, and other chrome.
    pub zen_mode: bool,

    /// Whether tool outputs should be collapsed by default.
    pub compact_tool_outputs: bool,

    /// Current approval mode for tool execution.
    /// Controls whether tools run automatically or require approval.
    pub approval_mode: ApprovalMode,

    /// Queue mode for steering prompts while running.
    pub steering_mode: QueueMode,

    /// Queue mode for follow-up prompts while running.
    pub follow_up_mode: QueueMode,

    /// Number of prompts currently queued while running.
    pub queued_prompt_count: usize,

    /// Number of queued steering prompts.
    pub queued_steering_count: usize,

    /// Number of queued follow-up prompts.
    pub queued_follow_up_count: usize,

    /// Preview snippets for queued steering prompts.
    pub queued_steering_preview: Vec<String>,

    /// Preview snippets for queued follow-up prompts.
    pub queued_follow_up_preview: Vec<String>,

    /// Keyboard shortcut label for editing the last queued follow-up.
    pub queued_follow_up_edit_binding_label: String,

    /// Cached MCP connected server count for runtime badges.
    pub mcp_connected: usize,

    /// Cached MCP tool count for runtime badges.
    pub mcp_tool_count: usize,
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
    #[must_use]
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),      // Empty message list
            textarea: TextArea::new(), // Empty input area
            input_width: 1,            // Default width until first render
            input_preferred_col: None,
            kill_ring: KillRing::new(),
            kill_chain_active: false,
            model: None,      // No model selected yet
            provider: None,   // No provider yet
            cwd: None,        // No working directory
            git_branch: None, // Not in a git repo (yet)
            session_id: None, // No session yet
            busy: false,      // Not processing
            busy_since: None, // No timer running
            status: None,     // No status message
            scroll_offset: 0, // At bottom of messages
            expanded_tool_calls: std::collections::HashSet::new(),
            error: None,           // No error
            thinking_header: None, // No thinking in progress
            thinking_level: ThinkingLevel::Off,
            thinking_buffer: String::new(),
            zen_mode: false,                        // Full UI by default
            compact_tool_outputs: false,            // Expanded tool output by default
            approval_mode: ApprovalMode::default(), // Selective mode
            steering_mode: QueueMode::default(),    // Queue steering by default
            follow_up_mode: QueueMode::default(),   // Queue follow-ups by default
            queued_prompt_count: 0,                 // No queued prompts
            queued_steering_count: 0,               // No queued steering prompts
            queued_follow_up_count: 0,              // No queued follow-up prompts
            queued_steering_preview: Vec::new(),
            queued_follow_up_preview: Vec::new(),
            queued_follow_up_edit_binding_label: "Alt+Up".to_string(),
            mcp_connected: 0,
            mcp_tool_count: 0,
        }
    }

    /// Update cached input width (inner width of the input box).
    pub fn set_input_width(&mut self, width: u16) {
        self.input_width = width.max(1);
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
        self.busy_since.map_or(0, |since| since.elapsed().as_secs())
    }

    #[must_use]
    pub fn can_queue_follow_up_shortcut(&self) -> bool {
        if !self.busy || !self.follow_up_mode.allows_queue() {
            return false;
        }
        let text = self.textarea.text();
        !text.trim().is_empty()
            && !text.trim_start().starts_with('/')
            && !text.trim_start().starts_with('!')
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

            FromAgent::ModelChanged { model, provider } => {
                self.status = Some(format!("Model: {model}"));
                self.model = Some(model);
                self.provider = Some(provider);
            }

            FromAgent::ModelChangeFailed { reason, .. } => {
                self.error = Some(reason);
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
                    for tc in &mut msg.tool_calls {
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

            // Batch execution events (informational, handled by individual tool events)
            FromAgent::BatchStart { total } => {
                self.status = Some(format!("Executing {total} tools in parallel..."));
            }
            FromAgent::BatchEnd {
                total,
                successes,
                failures,
            } => {
                if failures > 0 {
                    self.status = Some(format!(
                        "Batch complete: {successes}/{total} succeeded, {failures} failed"
                    ));
                } else {
                    self.status = Some(format!("Batch complete: {total} tools succeeded"));
                }
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

            // Tool blocked by hook
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                // Update tool status to blocked
                self.update_tool_status(&call_id, ToolCallStatus::Blocked);

                // Log the blocking for debugging
                eprintln!("[hooks] Tool '{tool}' blocked: {reason} (call_id: {call_id})");
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
            for tc in &mut msg.tool_calls {
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
            for tc in &mut msg.tool_calls {
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
        self.insert_char_internal(c, true);
    }

    /// Insert a string at the cursor position.
    pub fn insert_str(&mut self, s: &str) {
        self.insert_str_internal(s, true);
    }

    fn insert_char_internal(&mut self, c: char, reset_kill_ring: bool) {
        self.kill_chain_active = false;
        if reset_kill_ring {
            self.kill_ring.reset_rotation();
        }
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert(cursor, c);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + c.len_utf8());
        self.input_preferred_col = None;
    }

    fn insert_str_internal(&mut self, s: &str, reset_kill_ring: bool) {
        self.kill_chain_active = false;
        if reset_kill_ring {
            self.kill_ring.reset_rotation();
        }
        let cursor = self.textarea.cursor();
        let mut text = self.textarea.text().to_string();
        text.insert_str(cursor, s);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(cursor + s.len());
        self.input_preferred_col = None;
    }

    /// Delete the character before the cursor (Backspace key).
    ///
    /// Handles multi-byte UTF-8 characters correctly.
    pub fn backspace(&mut self) {
        self.reset_kill_state();
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            // Find the byte length of the previous character
            let prev = text[..cursor]
                .chars()
                .last() // Get the last char before cursor
                .map_or(0, char::len_utf8);
            let mut new_text = text.to_string();
            new_text.remove(cursor - prev);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(cursor - prev);
            self.input_preferred_col = None;
        }
    }

    /// Delete the character after the cursor (Delete key).
    pub fn delete(&mut self) {
        self.reset_kill_state();
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            let mut new_text = text.to_string();
            new_text.remove(cursor);
            self.textarea.set_text(&new_text);
            self.input_preferred_col = None;
        }
    }

    /// Move cursor one character left.
    pub fn move_left(&mut self) {
        self.reset_kill_state();
        let cursor = self.textarea.cursor();
        if cursor > 0 {
            let text = self.textarea.text();
            // Find byte length of previous character for proper UTF-8 handling
            let prev = text[..cursor].chars().last().map_or(0, char::len_utf8);
            self.textarea.set_cursor(cursor - prev);
            self.input_preferred_col = None;
        }
    }

    /// Move cursor one character right.
    pub fn move_right(&mut self) {
        self.reset_kill_state();
        let cursor = self.textarea.cursor();
        let text = self.textarea.text();
        if cursor < text.len() {
            // Find byte length of next character
            let next = text[cursor..]
                .chars()
                .next() // Get the first char after cursor
                .map_or(0, char::len_utf8);
            self.textarea.set_cursor(cursor + next);
            self.input_preferred_col = None;
        }
    }

    /// Move cursor to the start of input (Home key).
    pub fn move_home(&mut self) {
        self.reset_kill_state();
        self.textarea.set_cursor(0);
        self.input_preferred_col = None;
    }

    /// Move cursor to the end of input (End key).
    pub fn move_end(&mut self) {
        self.reset_kill_state();
        let len = self.textarea.text().len();
        self.textarea.set_cursor(len);
        self.input_preferred_col = None;
    }

    /// Move cursor one wrapped line up.
    pub fn move_up(&mut self) {
        self.reset_kill_state();
        self.move_vertical(-1);
    }

    /// Move cursor one wrapped line down.
    pub fn move_down(&mut self) {
        self.reset_kill_state();
        self.move_vertical(1);
    }

    /// Move cursor to the start of the current line (smart Home).
    ///
    /// Toggles between the first non-whitespace character and column 0.
    pub fn move_home_smart(&mut self) {
        self.reset_kill_state();
        let text = self.textarea.text();
        let cursor = self.textarea.cursor();
        let (line_start, line_end, col) = Self::line_bounds(text, cursor);
        let line = &text[line_start..line_end];
        let first_non_blank = Self::first_non_whitespace_offset(line);
        let target = if col == first_non_blank {
            0
        } else {
            first_non_blank
        };
        self.textarea.set_cursor(line_start + target);
        self.input_preferred_col = None;
    }

    /// Move cursor to the start of the previous word.
    pub fn move_word_left(&mut self) {
        self.reset_kill_state();
        let text = self.textarea.text();
        let cursor = self.textarea.cursor();
        if cursor == 0 {
            return;
        }

        let (line_start, line_end, col) = Self::line_bounds(text, cursor);
        if col == 0 {
            if line_start == 0 {
                return;
            }
            let mut prev_end = line_start.saturating_sub(1);
            loop {
                let prev_start = text[..prev_end].rfind('\n').map_or(0, |i| i + 1);
                if prev_end > prev_start {
                    self.textarea.set_cursor(prev_end);
                    self.input_preferred_col = None;
                    return;
                }
                if prev_start == 0 {
                    self.textarea.set_cursor(0);
                    self.input_preferred_col = None;
                    return;
                }
                prev_end = prev_start.saturating_sub(1);
            }
        }

        let line = &text[line_start..line_end];
        let new_col = previous_word_start(line, col.min(line.len()));
        self.textarea.set_cursor(line_start + new_col);
        self.input_preferred_col = None;
    }

    /// Move cursor to the start of the next word.
    pub fn move_word_right(&mut self) {
        self.reset_kill_state();
        let text = self.textarea.text();
        let mut cursor = self.textarea.cursor();
        if cursor >= text.len() {
            return;
        }

        loop {
            let (line_start, line_end, col) = Self::line_bounds(text, cursor);
            let line = &text[line_start..line_end];
            let new_col = next_word_start(line, col.min(line.len()));
            if new_col >= line.len() {
                if line_end >= text.len() {
                    self.textarea.set_cursor(text.len());
                    self.input_preferred_col = None;
                    return;
                }
                cursor = line_end + 1;
                if cursor > text.len() {
                    self.textarea.set_cursor(text.len());
                    self.input_preferred_col = None;
                    return;
                }
                continue;
            }
            self.textarea.set_cursor(line_start + new_col);
            self.input_preferred_col = None;
            return;
        }
    }

    /// Delete the word before the cursor.
    pub fn delete_word_backward(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor == 0 {
            return;
        }
        let text = self.textarea.text().to_string();
        let (line_start, line_end, col) = Self::line_bounds(&text, cursor);

        if col == 0 {
            if line_start == 0 {
                return;
            }
            let remove_at = line_start.saturating_sub(1);
            let mut new_text = text;
            new_text.remove(remove_at);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(remove_at);
            self.input_preferred_col = None;
            self.record_kill("\n".to_string(), true);
            return;
        }

        let line = &text[line_start..line_end];
        let start = previous_word_start(line, col.min(line.len()));
        if start == col {
            return;
        }
        let killed = line[start..col].to_string();
        let mut new_text = text;
        new_text.replace_range(line_start + start..cursor, "");
        self.textarea.set_text(&new_text);
        self.textarea.set_cursor(line_start + start);
        self.input_preferred_col = None;
        self.record_kill(killed, true);
    }

    /// Delete from cursor to start of line (Ctrl+U).
    pub fn delete_to_start_of_line(&mut self) {
        let cursor = self.textarea.cursor();
        if cursor == 0 {
            return;
        }
        let text = self.textarea.text().to_string();
        let (line_start, _line_end, col) = Self::line_bounds(&text, cursor);
        if col == 0 {
            if line_start == 0 {
                return;
            }
            let remove_at = line_start.saturating_sub(1);
            let mut new_text = text;
            new_text.remove(remove_at);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(remove_at);
            self.input_preferred_col = None;
            self.record_kill("\n".to_string(), true);
            return;
        }
        let killed = text[line_start..cursor].to_string();
        let mut new_text = text;
        new_text.replace_range(line_start..cursor, "");
        self.textarea.set_text(&new_text);
        self.textarea.set_cursor(line_start);
        self.input_preferred_col = None;
        self.record_kill(killed, true);
    }

    /// Delete from cursor to end of line (Ctrl+K).
    pub fn delete_to_end_of_line(&mut self) {
        let cursor = self.textarea.cursor();
        let text = self.textarea.text().to_string();
        let (_line_start, line_end, _col) = Self::line_bounds(&text, cursor);
        if cursor < line_end {
            let killed = text[cursor..line_end].to_string();
            let mut new_text = text;
            new_text.replace_range(cursor..line_end, "");
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(cursor);
            self.input_preferred_col = None;
            self.record_kill(killed, false);
            return;
        }
        if line_end < text.len() {
            let mut new_text = text;
            new_text.remove(line_end);
            self.textarea.set_text(&new_text);
            self.textarea.set_cursor(cursor);
            self.input_preferred_col = None;
            self.record_kill("\n".to_string(), false);
        }
    }

    /// Yank the most recent kill (Alt+Y), cycling on repeated presses.
    pub fn yank_kill_ring(&mut self) {
        let cursor = self.textarea.cursor();
        self.kill_chain_active = false;
        if self.kill_ring.is_rotating() {
            let info = self.kill_ring.last_yank_info();
            let next = self.kill_ring.yank_pop().map(str::to_string);
            if let (Some(info), Some(next)) = (info, next) {
                self.replace_range_internal(info.start, info.start + info.length, &next, false);
            }
            return;
        }

        if let Some((text, _info)) = self.kill_ring.yank_with_info(cursor) {
            self.insert_str_internal(&text, false);
        }
    }

    fn move_vertical(&mut self, delta: i32) {
        let width = self.input_width.max(1);
        let Some((line_idx, col)) = self.textarea.cursor_line_col(width) else {
            return;
        };
        let mut line_idx = line_idx;
        let target_col = self.input_preferred_col.unwrap_or(col);
        if self.input_preferred_col.is_none() {
            self.input_preferred_col = Some(target_col);
        }

        if delta.is_positive() && col == 0 && self.input_preferred_col.is_some() && line_idx > 0 {
            line_idx = line_idx.saturating_sub(1);
        }

        let new_line = if delta.is_negative() {
            if line_idx == 0 {
                return;
            }
            line_idx.saturating_sub(delta.wrapping_abs() as usize)
        } else {
            line_idx.saturating_add(delta as usize)
        };

        if let Some(new_pos) = self
            .textarea
            .byte_pos_for_line_col(width, new_line, target_col)
        {
            self.textarea.set_cursor(new_pos);
        }
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
        self.input_preferred_col = None;
        self.reset_kill_state();
        input
    }

    /// Set the input text directly (e.g., for command history).
    pub fn set_input(&mut self, text: &str) {
        self.textarea.set_text(text);
        self.textarea.set_cursor(text.len()); // Cursor at end
        self.input_preferred_col = None;
        self.reset_kill_state();
    }

    fn replace_range_internal(
        &mut self,
        start: usize,
        end: usize,
        replacement: &str,
        reset_kill_ring: bool,
    ) {
        self.kill_chain_active = false;
        if reset_kill_ring {
            self.kill_ring.reset_rotation();
        }
        let mut text = self.textarea.text().to_string();
        let start = start.min(text.len());
        let end = end.min(text.len()).max(start);
        text.replace_range(start..end, replacement);
        self.textarea.set_text(&text);
        self.textarea.set_cursor(start + replacement.len());
        self.input_preferred_col = None;
    }

    fn line_bounds(text: &str, cursor: usize) -> (usize, usize, usize) {
        let cursor = cursor.min(text.len());
        let line_start = text[..cursor].rfind('\n').map_or(0, |i| i + 1);
        let line_end = text[cursor..].find('\n').map_or(text.len(), |i| cursor + i);
        let col = cursor.saturating_sub(line_start);
        (line_start, line_end, col)
    }

    fn first_non_whitespace_offset(line: &str) -> usize {
        line.char_indices()
            .find(|(_, c)| !c.is_whitespace())
            .map(|(idx, _)| idx)
            .unwrap_or(line.len())
    }

    fn reset_kill_state(&mut self) {
        self.kill_chain_active = false;
        self.kill_ring.reset_rotation();
    }

    fn record_kill(&mut self, text: String, prepend: bool) {
        if text.is_empty() {
            return;
        }
        if self.kill_chain_active {
            self.kill_ring.kill_append(text, prepend);
        } else {
            self.kill_ring.kill(text);
            self.kill_chain_active = true;
        }
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
        let toggled = self.expanded_tool_calls.contains(call_id);
        if self.compact_tool_outputs {
            toggled
        } else {
            !toggled
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // Message and MessageRole Tests
    // ============================================================

    #[test]
    fn test_message_role_equality() {
        assert_eq!(MessageRole::User, MessageRole::User);
        assert_eq!(MessageRole::Assistant, MessageRole::Assistant);
        assert_ne!(MessageRole::User, MessageRole::Assistant);
    }

    #[test]
    fn test_message_role_copy() {
        let role = MessageRole::User;
        let copied = role; // Copy, not move
        assert_eq!(role, copied);
    }

    #[test]
    fn test_tool_call_status_transitions() {
        assert_eq!(ToolCallStatus::Pending, ToolCallStatus::Pending);
        assert_ne!(ToolCallStatus::Pending, ToolCallStatus::Running);
        assert_ne!(ToolCallStatus::Running, ToolCallStatus::Completed);
        assert_ne!(ToolCallStatus::Completed, ToolCallStatus::Failed);
    }

    // ============================================================
    // ApprovalMode Tests
    // ============================================================

    #[test]
    fn test_approval_mode_default() {
        assert_eq!(ApprovalMode::default(), ApprovalMode::Selective);
    }

    #[test]
    fn test_approval_mode_parse() {
        // Yolo mode aliases
        assert_eq!(ApprovalMode::parse("yolo"), Some(ApprovalMode::Yolo));
        assert_eq!(ApprovalMode::parse("auto"), Some(ApprovalMode::Yolo));
        assert_eq!(ApprovalMode::parse("trust"), Some(ApprovalMode::Yolo));
        assert_eq!(ApprovalMode::parse("YOLO"), Some(ApprovalMode::Yolo)); // case insensitive

        // Selective mode aliases
        assert_eq!(
            ApprovalMode::parse("selective"),
            Some(ApprovalMode::Selective)
        );
        assert_eq!(
            ApprovalMode::parse("default"),
            Some(ApprovalMode::Selective)
        );
        assert_eq!(ApprovalMode::parse("normal"), Some(ApprovalMode::Selective));

        // Safe mode aliases
        assert_eq!(ApprovalMode::parse("safe"), Some(ApprovalMode::Safe));
        assert_eq!(ApprovalMode::parse("always"), Some(ApprovalMode::Safe));
        assert_eq!(ApprovalMode::parse("paranoid"), Some(ApprovalMode::Safe));

        // Invalid
        assert_eq!(ApprovalMode::parse("invalid"), None);
        assert_eq!(ApprovalMode::parse(""), None);
    }

    #[test]
    fn test_approval_mode_next_cycle() {
        assert_eq!(ApprovalMode::Yolo.next(), ApprovalMode::Selective);
        assert_eq!(ApprovalMode::Selective.next(), ApprovalMode::Safe);
        assert_eq!(ApprovalMode::Safe.next(), ApprovalMode::Yolo);
    }

    #[test]
    fn test_approval_mode_label() {
        assert!(ApprovalMode::Yolo.label().contains("YOLO"));
        assert!(ApprovalMode::Selective.label().contains("Selective"));
        assert!(ApprovalMode::Safe.label().contains("Safe"));
    }

    #[test]
    fn test_queue_mode_parse() {
        assert_eq!(QueueMode::parse("all"), Some(QueueMode::All));
        assert_eq!(QueueMode::parse("one"), Some(QueueMode::One));
        assert_eq!(QueueMode::parse("single"), Some(QueueMode::One));
        assert_eq!(QueueMode::parse("unknown"), None);
    }

    // ============================================================
    // AppState Creation Tests
    // ============================================================

    #[test]
    fn test_app_state_new() {
        let state = AppState::new();
        assert!(state.messages.is_empty());
        assert!(state.model.is_none());
        assert!(state.provider.is_none());
        assert!(state.cwd.is_none());
        assert!(state.git_branch.is_none());
        assert!(state.session_id.is_none());
        assert!(!state.busy);
        assert!(state.busy_since.is_none());
        assert!(state.status.is_none());
        assert_eq!(state.scroll_offset, 0);
        assert!(state.expanded_tool_calls.is_empty());
        assert!(state.error.is_none());
        assert!(state.thinking_header.is_none());
        assert!(!state.zen_mode);
        assert_eq!(state.approval_mode, ApprovalMode::Selective);
        assert_eq!(state.steering_mode, QueueMode::All);
        assert_eq!(state.follow_up_mode, QueueMode::All);
    }

    #[test]
    fn test_app_state_default() {
        let state = AppState::default();
        assert!(state.messages.is_empty());
    }

    // ============================================================
    // Text Input Tests (UTF-8 handling)
    // ============================================================

    #[test]
    fn test_insert_char_ascii() {
        let mut state = AppState::new();
        state.insert_char('h');
        state.insert_char('i');
        assert_eq!(state.input(), "hi");
        assert_eq!(state.cursor(), 2);
    }

    #[test]
    fn test_insert_char_unicode() {
        let mut state = AppState::new();
        state.insert_char('こ');
        state.insert_char('ん');
        assert_eq!(state.input(), "こん");
        // Each Japanese char is 3 bytes in UTF-8
        assert_eq!(state.cursor(), 6);
    }

    #[test]
    fn test_insert_char_emoji() {
        let mut state = AppState::new();
        state.insert_char('🎉');
        assert_eq!(state.input(), "🎉");
        // Emoji is 4 bytes in UTF-8
        assert_eq!(state.cursor(), 4);
    }

    #[test]
    fn test_insert_str() {
        let mut state = AppState::new();
        state.insert_str("hello");
        assert_eq!(state.input(), "hello");
        assert_eq!(state.cursor(), 5);
    }

    #[test]
    fn test_insert_str_unicode() {
        let mut state = AppState::new();
        state.insert_str("日本語");
        assert_eq!(state.input(), "日本語");
        assert_eq!(state.cursor(), 9); // 3 chars * 3 bytes
    }

    #[test]
    fn test_backspace_ascii() {
        let mut state = AppState::new();
        state.set_input("hello");
        state.backspace();
        assert_eq!(state.input(), "hell");
        assert_eq!(state.cursor(), 4);
    }

    #[test]
    fn test_backspace_unicode() {
        let mut state = AppState::new();
        state.set_input("日本語");
        state.backspace();
        assert_eq!(state.input(), "日本");
        assert_eq!(state.cursor(), 6); // 2 remaining chars * 3 bytes
    }

    #[test]
    fn test_backspace_emoji() {
        let mut state = AppState::new();
        state.set_input("hi🎉");
        state.backspace();
        assert_eq!(state.input(), "hi");
        assert_eq!(state.cursor(), 2);
    }

    #[test]
    fn test_backspace_at_start() {
        let mut state = AppState::new();
        state.set_input("hi");
        state.move_home();
        state.backspace(); // Should do nothing
        assert_eq!(state.input(), "hi");
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_delete_ascii() {
        let mut state = AppState::new();
        state.set_input("hello");
        state.move_home();
        state.delete();
        assert_eq!(state.input(), "ello");
    }

    #[test]
    fn test_delete_at_end() {
        let mut state = AppState::new();
        state.set_input("hi");
        state.delete(); // Cursor at end, should do nothing
        assert_eq!(state.input(), "hi");
    }

    #[test]
    fn test_move_left_ascii() {
        let mut state = AppState::new();
        state.set_input("abc");
        state.move_left();
        assert_eq!(state.cursor(), 2);
        state.move_left();
        assert_eq!(state.cursor(), 1);
    }

    #[test]
    fn test_move_left_unicode() {
        let mut state = AppState::new();
        state.set_input("日本");
        // Cursor at end (6 bytes)
        state.move_left();
        assert_eq!(state.cursor(), 3); // After first char
        state.move_left();
        assert_eq!(state.cursor(), 0); // At start
    }

    #[test]
    fn test_move_left_at_start() {
        let mut state = AppState::new();
        state.set_input("hi");
        state.move_home();
        state.move_left(); // Should stay at 0
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_move_right_ascii() {
        let mut state = AppState::new();
        state.set_input("abc");
        state.move_home();
        state.move_right();
        assert_eq!(state.cursor(), 1);
        state.move_right();
        assert_eq!(state.cursor(), 2);
    }

    #[test]
    fn test_move_right_unicode() {
        let mut state = AppState::new();
        state.set_input("日本");
        state.move_home();
        state.move_right();
        assert_eq!(state.cursor(), 3); // Past first 3-byte char
        state.move_right();
        assert_eq!(state.cursor(), 6); // At end
    }

    #[test]
    fn test_move_right_at_end() {
        let mut state = AppState::new();
        state.set_input("hi");
        state.move_right(); // Should stay at end
        assert_eq!(state.cursor(), 2);
    }

    #[test]
    fn test_move_home_end() {
        let mut state = AppState::new();
        state.set_input("hello world");
        assert_eq!(state.cursor(), 11); // At end after set_input
        state.move_home();
        assert_eq!(state.cursor(), 0);
        state.move_end();
        assert_eq!(state.cursor(), 11);
    }

    #[test]
    fn test_move_home_smart_toggle() {
        let mut state = AppState::new();
        state.set_input("  hello");
        state.move_end();
        state.move_home_smart();
        assert_eq!(state.cursor(), 2);
        state.move_home_smart();
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_move_word_left_across_lines() {
        let mut state = AppState::new();
        state.set_input("hello\nworld");
        state.textarea.set_cursor(6); // start of second line
        state.move_word_left();
        assert_eq!(state.cursor(), 5); // end of "hello"
    }

    #[test]
    fn test_move_word_right_across_lines() {
        let mut state = AppState::new();
        state.set_input("hello\nworld");
        state.textarea.set_cursor(5); // end of first line
        state.move_word_right();
        assert_eq!(state.cursor(), 11); // end of "world"
    }

    #[test]
    fn test_move_word_left_unicode() {
        let mut state = AppState::new();
        state.set_input("hi 🙂 there");
        state.move_word_left();
        let text = state.input().to_string();
        assert_eq!(&text[state.cursor()..], "there");
        state.move_word_left();
        assert_eq!(state.cursor(), text.find('🙂').unwrap());
    }

    #[test]
    fn test_delete_word_backward() {
        let mut state = AppState::new();
        state.set_input("hello world");
        state.delete_word_backward();
        assert_eq!(state.input(), "hello ");
        assert_eq!(state.cursor(), 6);
    }

    #[test]
    fn test_delete_to_start_of_line_merges() {
        let mut state = AppState::new();
        state.set_input("hello\nworld");
        state.textarea.set_cursor(6); // start of second line
        state.delete_to_start_of_line();
        assert_eq!(state.input(), "helloworld");
        assert_eq!(state.cursor(), 5);
    }

    #[test]
    fn test_yank_kill_ring() {
        let mut state = AppState::new();
        state.set_input("hello world");
        state.delete_word_backward();
        state.yank_kill_ring();
        assert_eq!(state.input(), "hello world");
        assert_eq!(state.cursor(), 11);
    }

    #[test]
    fn test_kill_ring_appends_consecutive_kills() {
        let mut state = AppState::new();
        state.set_input("hello world test");
        // Kill "test"
        state.delete_word_backward();
        // Consecutive kill should append (prepend for backward kill)
        state.delete_word_backward();
        state.yank_kill_ring();
        assert_eq!(state.input(), "hello world test");
    }

    #[test]
    fn test_move_up_down_wrapped_lines() {
        let mut state = AppState::new();
        state.set_input_width(5);
        state.set_input("0123456789");
        assert_eq!(state.cursor(), 10);
        state.move_up();
        assert_eq!(state.cursor(), 5);
        state.move_down();
        assert_eq!(state.cursor(), 10);
    }

    #[test]
    fn test_take_input() {
        let mut state = AppState::new();
        state.set_input("hello");
        let taken = state.take_input();
        assert_eq!(taken, "hello");
        assert_eq!(state.input(), "");
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_set_input_moves_cursor_to_end() {
        let mut state = AppState::new();
        state.set_input("hello");
        assert_eq!(state.cursor(), 5);
    }

    // ============================================================
    // Mixed UTF-8 Text Editing Tests
    // ============================================================

    #[test]
    fn test_insert_in_middle_of_unicode() {
        let mut state = AppState::new();
        state.set_input("日語"); // 6 bytes total
        state.move_home();
        state.move_right(); // After first char (position 3)
        state.insert_char('本'); // Insert in middle
        assert_eq!(state.input(), "日本語");
    }

    #[test]
    fn test_backspace_mixed_content() {
        let mut state = AppState::new();
        state.set_input("a日b本c");
        state.backspace(); // Delete 'c'
        assert_eq!(state.input(), "a日b本");
        state.backspace(); // Delete '本'
        assert_eq!(state.input(), "a日b");
        state.backspace(); // Delete 'b'
        assert_eq!(state.input(), "a日");
    }

    #[test]
    fn test_cursor_movement_through_mixed_content() {
        let mut state = AppState::new();
        state.set_input("a日b"); // 'a' = 1 byte, '日' = 3 bytes, 'b' = 1 byte = 5 bytes total
        state.move_home();
        assert_eq!(state.cursor(), 0);
        state.move_right(); // Past 'a'
        assert_eq!(state.cursor(), 1);
        state.move_right(); // Past '日'
        assert_eq!(state.cursor(), 4);
        state.move_right(); // Past 'b'
        assert_eq!(state.cursor(), 5);
    }

    // ============================================================
    // Message Management Tests
    // ============================================================

    #[test]
    fn test_add_user_message() {
        let mut state = AppState::new();
        let id = state.add_user_message("Hello!".to_string());

        assert!(!id.is_empty());
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].content, "Hello!");
        assert_eq!(state.messages[0].role, MessageRole::User);
        assert!(!state.messages[0].streaming);
        assert!(state.busy);
        assert!(state.busy_since.is_some());
    }

    #[test]
    fn test_add_system_message() {
        let mut state = AppState::new();
        state.add_system_message("System info".to_string());

        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].content, "System info");
        assert_eq!(state.messages[0].role, MessageRole::Assistant);
        assert!(!state.messages[0].streaming);
    }

    #[test]
    fn test_toggle_thinking() {
        let mut state = AppState::new();
        let id = state.add_user_message("test".to_string());

        // Initially not expanded
        let msg = state.messages.iter().find(|m| m.id == id).unwrap();
        assert!(!msg.thinking_expanded);

        // Toggle on
        state.toggle_thinking(&id);
        let msg = state.messages.iter().find(|m| m.id == id).unwrap();
        assert!(msg.thinking_expanded);

        // Toggle off
        state.toggle_thinking(&id);
        let msg = state.messages.iter().find(|m| m.id == id).unwrap();
        assert!(!msg.thinking_expanded);
    }

    #[test]
    fn test_toggle_thinking_nonexistent_id() {
        let mut state = AppState::new();
        state.add_user_message("test".to_string());

        // Should not panic
        state.toggle_thinking("nonexistent-id");
    }

    // ============================================================
    // Scroll Tests
    // ============================================================

    #[test]
    fn test_scroll_up() {
        let mut state = AppState::new();
        state.scroll_offset = 10;
        state.scroll_up(3);
        assert_eq!(state.scroll_offset, 7);
    }

    #[test]
    fn test_scroll_up_saturating() {
        let mut state = AppState::new();
        state.scroll_offset = 2;
        state.scroll_up(10); // Should not go below 0
        assert_eq!(state.scroll_offset, 0);
    }

    #[test]
    fn test_scroll_down() {
        let mut state = AppState::new();
        state.scroll_down(5);
        assert_eq!(state.scroll_offset, 5);
    }

    #[test]
    fn test_scroll_down_saturating() {
        let mut state = AppState::new();
        state.scroll_offset = usize::MAX - 5;
        state.scroll_down(10); // Should saturate at MAX
        assert_eq!(state.scroll_offset, usize::MAX);
    }

    // ============================================================
    // Tool Call Expansion Tests
    // ============================================================

    #[test]
    fn test_toggle_tool_call() {
        let mut state = AppState::new();
        let call_id = "call-123";

        // Default: expanded when compact mode is off
        assert!(state.is_tool_call_expanded(call_id));

        state.toggle_tool_call(call_id);
        assert!(!state.is_tool_call_expanded(call_id));

        state.toggle_tool_call(call_id);
        assert!(state.is_tool_call_expanded(call_id));

        // Compact mode flips default to collapsed
        state.compact_tool_outputs = true;
        state.expanded_tool_calls.clear();
        assert!(!state.is_tool_call_expanded(call_id));

        state.toggle_tool_call(call_id);
        assert!(state.is_tool_call_expanded(call_id));
    }

    #[test]
    fn test_multiple_tool_calls_expanded() {
        let mut state = AppState::new();
        state.compact_tool_outputs = true;

        state.toggle_tool_call("call-1");
        state.toggle_tool_call("call-2");

        assert!(state.is_tool_call_expanded("call-1"));
        assert!(state.is_tool_call_expanded("call-2"));
        assert!(!state.is_tool_call_expanded("call-3"));
    }

    // ============================================================
    // Elapsed Time Tests
    // ============================================================

    #[test]
    fn test_elapsed_busy_secs_not_busy() {
        let state = AppState::new();
        assert_eq!(state.elapsed_busy_secs(), 0);
    }

    #[test]
    fn test_elapsed_busy_secs_when_busy() {
        let mut state = AppState::new();
        state.busy = true;
        state.busy_since = Some(Instant::now());
        // Should be 0 or very small (just started)
        assert!(state.elapsed_busy_secs() < 2);
    }

    #[test]
    fn test_can_queue_follow_up_shortcut_requires_busy_queueable_non_command_input() {
        let mut state = AppState::new();
        state.textarea.set_text("follow-up");
        assert!(!state.can_queue_follow_up_shortcut());

        state.busy = true;
        state.follow_up_mode = QueueMode::One;
        assert!(!state.can_queue_follow_up_shortcut());

        state.follow_up_mode = QueueMode::All;
        state.textarea.set_text("/help");
        assert!(!state.can_queue_follow_up_shortcut());

        state.textarea.set_text("!ls");
        assert!(!state.can_queue_follow_up_shortcut());

        state.textarea.set_text("   ");
        assert!(!state.can_queue_follow_up_shortcut());

        state.textarea.set_text("follow-up");
        assert!(state.can_queue_follow_up_shortcut());
    }

    // ============================================================
    // Tool Call State Tests
    // ============================================================

    #[test]
    fn test_fail_tool_call() {
        let mut state = AppState::new();

        // Add a message with a tool call
        state.messages.push(Message {
            id: "msg-1".to_string(),
            role: MessageRole::Assistant,
            content: String::new(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![ToolCallState {
                call_id: "call-1".to_string(),
                tool: "bash".to_string(),
                args: serde_json::json!({"command": "ls"}),
                status: ToolCallStatus::Pending,
                output: String::new(),
            }],
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });

        state.fail_tool_call("call-1", "User rejected");

        let tc = &state.messages[0].tool_calls[0];
        assert_eq!(tc.status, ToolCallStatus::Failed);
        assert!(tc.output.contains("User rejected"));
    }

    #[test]
    fn test_fail_tool_call_with_existing_output() {
        let mut state = AppState::new();

        state.messages.push(Message {
            id: "msg-1".to_string(),
            role: MessageRole::Assistant,
            content: String::new(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![ToolCallState {
                call_id: "call-1".to_string(),
                tool: "bash".to_string(),
                args: serde_json::json!({}),
                status: ToolCallStatus::Running,
                output: "partial output".to_string(),
            }],
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        });

        state.fail_tool_call("call-1", "Timeout");

        let tc = &state.messages[0].tool_calls[0];
        assert_eq!(tc.status, ToolCallStatus::Failed);
        assert!(tc.output.contains("partial output"));
        assert!(tc.output.contains("Timeout"));
    }

    #[test]
    fn test_fail_tool_call_nonexistent() {
        let mut state = AppState::new();
        state.add_user_message("test".to_string());

        // Should not panic
        state.fail_tool_call("nonexistent", "error");
    }

    // ============================================================
    // Handle Agent Message Tests
    // ============================================================

    #[test]
    fn test_handle_ready_message() {
        let mut state = AppState::new();
        state.busy = true;

        state.handle_agent_message(FromAgent::Ready {
            model: "claude-3".to_string(),
            provider: "anthropic".to_string(),
        });

        assert_eq!(state.model, Some("claude-3".to_string()));
        assert_eq!(state.provider, Some("anthropic".to_string()));
        assert!(!state.busy);
    }

    #[test]
    fn test_handle_response_start() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        assert!(state.busy);
        assert!(state.busy_since.is_some());
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].id, "resp-1");
        assert_eq!(state.messages[0].role, MessageRole::Assistant);
        assert!(state.messages[0].streaming);
    }

    #[test]
    fn test_handle_response_chunk() {
        let mut state = AppState::new();

        // Start response first
        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        // Add content chunk
        state.handle_agent_message(FromAgent::ResponseChunk {
            response_id: "resp-1".to_string(),
            content: "Hello ".to_string(),
            is_thinking: false,
        });

        state.handle_agent_message(FromAgent::ResponseChunk {
            response_id: "resp-1".to_string(),
            content: "world!".to_string(),
            is_thinking: false,
        });

        assert_eq!(state.messages[0].content, "Hello world!");
    }

    #[test]
    fn test_handle_response_chunk_thinking() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ResponseChunk {
            response_id: "resp-1".to_string(),
            content: "**Analyzing**".to_string(),
            is_thinking: true,
        });

        assert_eq!(state.messages[0].thinking, "**Analyzing**");
        assert_eq!(state.thinking_header, Some("Analyzing".to_string()));
    }

    #[test]
    fn test_handle_response_end() {
        let mut state = AppState::new();
        state.busy = true;

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ResponseEnd {
            response_id: "resp-1".to_string(),
            usage: None,
        });

        assert!(!state.messages[0].streaming);
        assert!(!state.busy);
        assert!(state.thinking_header.is_none());
    }

    #[test]
    fn test_handle_tool_call() {
        let mut state = AppState::new();

        // Add an assistant message first
        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            requires_approval: true,
        });

        assert_eq!(state.messages[0].tool_calls.len(), 1);
        let tc = &state.messages[0].tool_calls[0];
        assert_eq!(tc.call_id, "call-1");
        assert_eq!(tc.tool, "bash");
        assert_eq!(tc.status, ToolCallStatus::Pending);
    }

    #[test]
    fn test_handle_tool_call_no_approval() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "read".to_string(),
            args: serde_json::json!({}),
            requires_approval: false,
        });

        let tc = &state.messages[0].tool_calls[0];
        assert_eq!(tc.status, ToolCallStatus::Running);
    }

    #[test]
    fn test_handle_tool_lifecycle() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({}),
            requires_approval: false,
        });

        // Tool started
        state.handle_agent_message(FromAgent::ToolStart {
            call_id: "call-1".to_string(),
        });
        assert_eq!(
            state.messages[0].tool_calls[0].status,
            ToolCallStatus::Running
        );

        // Tool output
        state.handle_agent_message(FromAgent::ToolOutput {
            call_id: "call-1".to_string(),
            content: "file1.txt\n".to_string(),
        });
        assert!(state.messages[0].tool_calls[0].output.contains("file1.txt"));

        // Tool completed
        state.handle_agent_message(FromAgent::ToolEnd {
            call_id: "call-1".to_string(),
            success: true,
        });
        assert_eq!(
            state.messages[0].tool_calls[0].status,
            ToolCallStatus::Completed
        );
    }

    #[test]
    fn test_handle_tool_failure() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({}),
            requires_approval: false,
        });

        state.handle_agent_message(FromAgent::ToolEnd {
            call_id: "call-1".to_string(),
            success: false,
        });

        assert_eq!(
            state.messages[0].tool_calls[0].status,
            ToolCallStatus::Failed
        );
    }

    #[test]
    fn test_handle_error() {
        let mut state = AppState::new();
        state.busy = true;

        state.handle_agent_message(FromAgent::Error {
            message: "Connection failed".to_string(),
            fatal: false,
        });

        assert_eq!(state.error, Some("Connection failed".to_string()));
        assert!(!state.busy);
    }

    #[test]
    fn test_handle_status() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::Status {
            message: "Loading...".to_string(),
        });

        assert_eq!(state.status, Some("Loading...".to_string()));
    }

    #[test]
    fn test_handle_session_info() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::SessionInfo {
            session_id: Some("sess-123".to_string()),
            cwd: "/home/user".to_string(),
            git_branch: Some("main".to_string()),
        });

        assert_eq!(state.session_id, Some("sess-123".to_string()));
        assert_eq!(state.cwd, Some("/home/user".to_string()));
        assert_eq!(state.git_branch, Some("main".to_string()));
    }

    #[test]
    fn test_handle_batch_events() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::BatchStart { total: 5 });
        assert!(state.status.as_ref().unwrap().contains('5'));

        state.handle_agent_message(FromAgent::BatchEnd {
            total: 5,
            successes: 4,
            failures: 1,
        });
        assert!(state.status.as_ref().unwrap().contains('4'));
        assert!(state.status.as_ref().unwrap().contains("failed"));
    }

    #[test]
    fn test_handle_hook_blocked() {
        let mut state = AppState::new();

        state.handle_agent_message(FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });

        state.handle_agent_message(FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({}),
            requires_approval: false,
        });

        state.handle_agent_message(FromAgent::HookBlocked {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            reason: "Blocked by security hook".to_string(),
        });

        assert_eq!(
            state.messages[0].tool_calls[0].status,
            ToolCallStatus::Blocked
        );
    }

    // ============================================================
    // Extract Thinking Header Tests
    // ============================================================

    #[test]
    fn test_extract_thinking_header_basic() {
        let text = "Some text **Header** more text";
        assert_eq!(extract_thinking_header(text), Some("Header".to_string()));
    }

    #[test]
    fn test_extract_thinking_header_multiple() {
        let text = "**First** some text **Second**";
        // Should extract the last complete header
        assert_eq!(extract_thinking_header(text), Some("Second".to_string()));
    }

    #[test]
    fn test_extract_thinking_header_none() {
        assert_eq!(extract_thinking_header("no header here"), None);
        assert_eq!(extract_thinking_header("**incomplete"), None);
        assert_eq!(extract_thinking_header(""), None);
    }

    #[test]
    fn test_extract_thinking_header_empty() {
        let text = "**** more";
        // Empty header between ** ** should not be extracted
        assert_eq!(extract_thinking_header(text), None);
    }

    #[test]
    fn test_extract_thinking_header_long() {
        let long_header = "a".repeat(150);
        let text = format!("**{}**", long_header);
        // Headers > 100 chars are rejected
        assert_eq!(extract_thinking_header(&text), None);
    }

    #[test]
    fn test_extract_thinking_header_multiline() {
        let text = "**Header\nwith newline**";
        // Should only take first line
        assert_eq!(extract_thinking_header(text), Some("Header".to_string()));
    }

    // ============================================================
    // Edge Cases and Boundary Tests
    // ============================================================

    #[test]
    fn test_empty_input_operations() {
        let mut state = AppState::new();

        // Operations on empty input should not panic
        state.backspace();
        state.delete();
        state.move_left();
        state.move_right();
        state.move_home();
        state.move_end();

        assert_eq!(state.input(), "");
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_very_long_input() {
        let mut state = AppState::new();
        let long_text = "a".repeat(100_000);
        state.set_input(&long_text);

        assert_eq!(state.input().len(), 100_000);
        assert_eq!(state.cursor(), 100_000);

        state.move_home();
        assert_eq!(state.cursor(), 0);
    }

    #[test]
    fn test_combining_characters() {
        let mut state = AppState::new();
        // é can be composed as e + combining acute accent
        state.set_input("café");
        assert_eq!(state.input(), "café");

        // Cursor movement should work
        state.move_home();
        state.move_right();
        state.move_right();
        state.move_right();
        state.move_right();
    }

    #[test]
    fn test_tool_call_state_clone() {
        let tc = ToolCallState {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            status: ToolCallStatus::Completed,
            output: "output".to_string(),
        };

        let cloned = tc.clone();
        assert_eq!(cloned.call_id, tc.call_id);
        assert_eq!(cloned.status, tc.status);
    }

    #[test]
    fn test_message_clone() {
        let msg = Message {
            id: "msg-1".to_string(),
            role: MessageRole::User,
            content: "Hello".to_string(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![],
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        };

        let cloned = msg.clone();
        assert_eq!(cloned.id, msg.id);
        assert_eq!(cloned.content, msg.content);
    }
}

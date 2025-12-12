//! Agent communication protocol
//!
//! Defines the message types for bidirectional communication between the TUI
//! and the agent. These types were originally designed for IPC with a Node.js
//! subprocess but are now used internally with the native Rust agent.
//!
//! # Message Flow
//!
//! ```text
//! ┌─────────────┐                                    ┌─────────────┐
//! │   TuiApp    │                                    │    Agent    │
//! │             │                                    │   Runner    │
//! └─────────────┘                                    └─────────────┘
//!       │                                                    │
//!       │  ToAgent::Prompt                                   │
//!       │ ───────────────────────────────────────────────────>│
//!       │                                                    │
//!       │                            FromAgent::ResponseStart│
//!       │<─────────────────────────────────────────────────── │
//!       │                                                    │
//!       │                             FromAgent::ResponseChunk│
//!       │<─────────────────────────────────────────────────── │
//!       │                             (streamed multiple times)
//!       │                                                    │
//!       │                               FromAgent::ToolCall  │
//!       │<─────────────────────────────────────────────────── │
//!       │                                                    │
//!       │  ToAgent::ToolResponse                             │
//!       │ ───────────────────────────────────────────────────>│
//!       │                                                    │
//!       │                              FromAgent::ResponseEnd│
//!       │<─────────────────────────────────────────────────── │
//! ```
//!
//! # Enum Message Types
//!
//! Both [`ToAgent`] and [`FromAgent`] are Rust enums with tagged variants.
//! This provides type safety and exhaustive pattern matching:
//!
//! ```rust,ignore
//! match event {
//!     FromAgent::ResponseChunk { content, .. } => {
//!         print!("{}", content);
//!     }
//!     FromAgent::ToolCall { call_id, tool, args, .. } => {
//!         // Handle tool approval UI
//!     }
//!     FromAgent::Error { message, fatal } => {
//!         // Display error
//!     }
//!     _ => {}
//! }
//! ```
//!
//! # Serialization
//!
//! All types use serde with `#[serde(tag = "type")]` for discriminated unions:
//!
//! ```json
//! {
//!   "type": "response_chunk",
//!   "response_id": "abc123",
//!   "content": "Hello, world!",
//!   "is_thinking": false
//! }
//! ```
//!
//! The `tag = "type"` attribute ensures the enum variant name is used as a
//! discriminator field, making the JSON format compatible with TypeScript and
//! other languages.

use serde::{Deserialize, Serialize};

// ============================================================================
// Messages from Rust TUI to Agent
// ============================================================================

/// Messages sent from the TUI to the agent
///
/// These messages represent user actions and decisions that drive the agent's
/// behavior. All variants are serializable for potential use with IPC or logging.
///
/// # Enum Variants as Message Types
///
/// Each variant represents a distinct command with its own data. Rust enums are
/// more powerful than TypeScript unions because they can carry associated data:
///
/// ```rust,ignore
/// // TypeScript equivalent would be:
/// // type ToAgent =
/// //   | { type: 'prompt'; content: string; attachments: string[] }
/// //   | { type: 'cancel' }
/// //   | { type: 'interrupt' }
///
/// // In Rust:
/// pub enum ToAgent {
///     Prompt { content: String, attachments: Vec<String> },
///     Cancel,
///     Interrupt,
/// }
/// ```
///
/// # Usage
///
/// ```rust,ignore
/// // Send a prompt
/// let msg = ToAgent::Prompt {
///     content: "Write a Rust function".to_string(),
///     attachments: vec![],
/// };
///
/// // Send a cancellation
/// let msg = ToAgent::Cancel;
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToAgent {
    /// User submitted a prompt
    ///
    /// Triggers a new AI completion request. The agent will add the user message
    /// to the conversation history and begin streaming a response.
    Prompt {
        /// The user's message
        content: String,

        /// Files to attach (paths).
        ///
        /// Images are attached as vision blocks; UTF-8 text files are attached
        /// as document text blocks.
        #[serde(default)]
        attachments: Vec<String>,
    },

    /// User interrupted the agent (escape/ctrl-c)
    ///
    /// Similar to Cancel, but specifically indicates a keyboard interrupt.
    /// Currently treated the same as Cancel.
    Interrupt,

    /// Response to a tool call
    ///
    /// Sent when the user approves or denies a tool execution request. The agent
    /// waits for this message before proceeding with restricted tools.
    ToolResponse {
        /// ID of the tool call this responds to
        ///
        /// Must match the `call_id` from the `FromAgent::ToolCall` event.
        call_id: String,

        /// Whether the tool was approved
        ///
        /// If true, the tool will execute. If false, the agent will be told
        /// the tool was denied.
        approved: bool,

        /// Result of the tool (if approved and executed)
        ///
        /// For auto-approved tools, the TUI may execute them and send the result
        /// here. For manually approved tools, this is typically None and the
        /// agent executes the tool itself.
        result: Option<ToolResult>,
    },

    /// Request to cancel current operation
    ///
    /// Triggers the cancellation token to stop the active AI request. The agent
    /// will clean up and send a ResponseEnd event.
    Cancel,

    /// Shutdown the agent gracefully
    ///
    /// Requests the agent to terminate. Currently unused (agent shuts down when
    /// the command channel closes).
    Shutdown,
}

/// Result of a tool execution
///
/// Contains the outcome of running a tool (bash, read, write, etc.).
/// Either `success` is true with output, or false with an error message.
///
/// # Examples
///
/// ```
/// use composer_tui::agent::ToolResult;
///
/// // Successful execution
/// let result = ToolResult {
///     success: true,
///     output: "Hello, world!".to_string(),
///     error: None,
/// };
///
/// // Failed execution
/// let result = ToolResult {
///     success: false,
///     output: String::new(),
///     error: Some("Permission denied".to_string()),
/// };
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// Whether the tool succeeded
    ///
    /// If true, the tool executed successfully and `output` contains the result.
    /// If false, the tool failed and `error` contains the reason.
    pub success: bool,

    /// Output from the tool
    ///
    /// For successful executions, contains stdout or the result data.
    /// For failures, this may be empty or contain partial output.
    pub output: String,

    /// Error message if failed
    ///
    /// Only set when `success` is false. Contains the error description
    /// (stderr, exception message, etc.).
    #[serde(default)]
    pub error: Option<String>,
}

// ============================================================================
// Messages from Agent to Rust TUI
// ============================================================================

/// Messages sent from the agent to the TUI
///
/// These events represent the agent's state, responses, and requests. The TUI
/// receives these via the event channel and updates the UI accordingly.
///
/// # Event Lifecycle
///
/// A typical prompt-response cycle involves:
///
/// 1. `ResponseStart` - Agent begins processing
/// 2. `ResponseChunk` - Streamed text/thinking (multiple)
/// 3. `ToolCall` - Agent wants to use a tool (optional, may repeat)
/// 4. `ToolStart`/`ToolOutput`/`ToolEnd` - Tool execution (optional)
/// 5. `ResponseEnd` - Agent finished, includes token usage
///
/// # Streaming Pattern
///
/// The agent uses server-sent events (SSE) style streaming:
///
/// ```rust,ignore
/// while let Some(event) = event_rx.recv().await {
///     match event {
///         FromAgent::ResponseChunk { content, is_thinking, .. } => {
///             if is_thinking {
///                 append_to_thinking_buffer(content);
///             } else {
///                 append_to_response_buffer(content);
///             }
///         }
///         FromAgent::ResponseEnd { usage, .. } => {
///             display_token_usage(usage);
///             break;
///         }
///         _ => {}
///     }
/// }
/// ```
///
/// # Enum Variants and Pattern Matching
///
/// Rust enums enable exhaustive pattern matching, ensuring all cases are handled:
///
/// ```rust,ignore
/// match event {
///     FromAgent::Ready { .. } => { /* handle ready */ }
///     FromAgent::ResponseStart { .. } => { /* handle start */ }
///     FromAgent::ResponseChunk { .. } => { /* handle chunk */ }
///     FromAgent::ResponseEnd { .. } => { /* handle end */ }
///     FromAgent::ToolCall { .. } => { /* handle tool call */ }
///     FromAgent::Error { .. } => { /* handle error */ }
///     // Compiler ensures all variants are covered
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromAgent {
    /// Agent is ready to receive prompts
    ///
    /// Emitted once at startup to indicate the agent is initialized and ready.
    /// Includes the active model and provider information.
    Ready {
        /// Current model name
        ///
        /// Example: "claude-opus-4-5-20251101"
        model: String,

        /// Provider name
        ///
        /// Example: "Anthropic", "OpenAI"
        provider: String,
    },

    /// Agent started generating a response
    ///
    /// Marks the beginning of a new AI response. The `response_id` can be used
    /// to correlate chunks and the final ResponseEnd event.
    ResponseStart {
        /// Unique ID for this response
        ///
        /// UUID v4 string used to track this specific response across events.
        response_id: String,
    },

    /// Streaming text chunk from the agent
    ///
    /// Contains a fragment of the AI's response. Multiple chunks are sent during
    /// streaming. The TUI appends these to build the complete response.
    ResponseChunk {
        /// Response ID this chunk belongs to
        ///
        /// Matches the `response_id` from ResponseStart.
        response_id: String,

        /// The text content
        ///
        /// UTF-8 text fragment. May be a word, sentence, or partial sentence.
        content: String,

        /// Whether this is thinking/reasoning (vs. final response)
        ///
        /// When true, this chunk is part of the extended thinking phase (Claude Opus 4.5+).
        /// The TUI typically renders thinking content in a different style or collapsed section.
        #[serde(default)]
        is_thinking: bool,
    },

    /// Agent finished generating response
    ///
    /// Signals the end of a response. Includes token usage statistics for
    /// tracking costs and context usage.
    ResponseEnd {
        /// Response ID
        ///
        /// Matches the `response_id` from ResponseStart.
        response_id: String,

        /// Token usage stats
        ///
        /// Optional because some providers don't return usage data.
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

    /// Agent wants to call a tool
    ///
    /// The agent has requested to execute a tool (bash, read, write, etc.).
    /// If `requires_approval` is true, the TUI must respond with a ToolResponse.
    ToolCall {
        /// Unique ID for this tool call
        ///
        /// UUID v4 string. Must be used in the ToolResponse to identify which
        /// tool call is being approved/denied.
        call_id: String,

        /// Name of the tool
        ///
        /// Example: "bash", "read", "write", "glob", "grep"
        tool: String,

        /// Tool arguments (as JSON object)
        ///
        /// Contains the parameters for the tool (e.g., `{"command": "ls -la"}`
        /// for bash, `{"file_path": "/foo/bar.rs"}` for read).
        args: serde_json::Value,

        /// Whether this requires user approval
        ///
        /// If true, the agent will wait for a ToolResponse before executing.
        /// If false, the tool is auto-approved and executes immediately.
        requires_approval: bool,
    },

    /// Tool execution started (auto-approved or after approval)
    ///
    /// Indicates the tool has begun executing. Useful for showing loading states.
    ToolStart {
        /// Tool call ID
        ///
        /// Matches the `call_id` from ToolCall.
        call_id: String,
    },

    /// Tool execution output (streaming)
    ///
    /// Contains stdout/stderr from the tool as it executes. For commands that
    /// produce output incrementally (e.g., long-running bash commands).
    ToolOutput {
        /// Tool call ID
        ///
        /// Matches the `call_id` from ToolCall.
        call_id: String,

        /// Output content
        ///
        /// Text output from the tool. May be sent in multiple chunks.
        content: String,
    },

    /// Tool execution completed
    ///
    /// Marks the end of tool execution with a success/failure status.
    ToolEnd {
        /// Tool call ID
        ///
        /// Matches the `call_id` from ToolCall.
        call_id: String,

        /// Whether it succeeded
        ///
        /// True if the tool executed without errors, false otherwise.
        success: bool,
    },

    /// Batch tool execution started
    ///
    /// Indicates multiple tools are being executed in parallel.
    BatchStart {
        /// Total number of tools in the batch
        total: usize,
    },

    /// Batch tool execution completed
    ///
    /// Summary of batch execution results.
    BatchEnd {
        /// Total number of tools executed
        total: usize,
        /// Number of successful executions
        successes: usize,
        /// Number of failed executions
        failures: usize,
    },

    /// An error occurred
    ///
    /// Represents an error in the agent or tool execution. If fatal, the agent
    /// may need to be restarted.
    Error {
        /// Error message
        ///
        /// Human-readable description of what went wrong.
        message: String,

        /// Whether this is fatal (agent should restart)
        ///
        /// If true, the error is unrecoverable and the agent should be reinitialized.
        /// If false, it's a transient error and the agent can continue.
        #[serde(default)]
        fatal: bool,
    },

    /// Agent status update
    ///
    /// General status message for debugging or user feedback.
    Status {
        /// Status message
        message: String,
    },

    /// Session info update
    ///
    /// Provides context about the current session (working directory, git branch).
    /// Sent at startup and when the session changes.
    SessionInfo {
        /// Session ID
        ///
        /// Unique identifier for this conversation session. Used for persistence
        /// and analytics.
        session_id: Option<String>,

        /// Working directory
        ///
        /// Current directory where file operations and commands execute.
        cwd: String,

        /// Git branch (if in a repo)
        ///
        /// The active git branch, or None if not in a git repository.
        #[serde(default)]
        git_branch: Option<String>,
    },

    /// Tool was blocked by a hook
    ///
    /// Emitted when a PreToolUse hook blocks tool execution. The tool result
    /// will contain an error message, and the model will be informed.
    HookBlocked {
        /// Tool call ID
        ///
        /// Matches the `call_id` from the attempted ToolCall.
        call_id: String,

        /// Name of the blocked tool
        tool: String,

        /// Reason the hook blocked this call
        ///
        /// Human-readable explanation of why the hook rejected this tool call.
        reason: String,
    },
}

/// Token usage statistics
///
/// Tracks token consumption for a single AI request. Used for monitoring costs,
/// context usage, and prompt cache efficiency.
///
/// # Token Types
///
/// - **Input tokens**: Tokens in the prompt (user message + system prompt + history)
/// - **Output tokens**: Tokens generated by the AI
/// - **Cache read tokens**: Tokens read from the prompt cache (cheaper than input)
/// - **Cache write tokens**: Tokens written to the prompt cache (one-time cost)
///
/// # Prompt Caching
///
/// Anthropic's prompt caching reduces costs by storing common context (like system
/// prompts and conversation history) for reuse. Cache read tokens are significantly
/// cheaper than regular input tokens:
///
/// - Regular input: $3 per million tokens
/// - Cache read: $0.30 per million tokens (10x cheaper)
/// - Cache write: $3.75 per million tokens (25% more than input)
///
/// # Examples
///
/// ```
/// use composer_tui::agent::TokenUsage;
///
/// let usage = TokenUsage {
///     input_tokens: 1000,
///     output_tokens: 500,
///     cache_read_tokens: 5000,  // 5K tokens loaded from cache
///     cache_write_tokens: 0,
///     cost: Some(0.025),  // Calculated cost in USD
/// };
///
/// println!("Total tokens: {}", usage.input_tokens + usage.output_tokens);
/// println!("Cache hit ratio: {:.1}%",
///     usage.cache_read_tokens as f64 / (usage.input_tokens + usage.cache_read_tokens) as f64 * 100.0
/// );
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Input tokens used
    ///
    /// Tokens in the user prompt, system prompt, and conversation history that
    /// were NOT served from cache. These are billed at the standard input rate.
    #[serde(default)]
    pub input_tokens: u64,

    /// Output tokens used
    ///
    /// Tokens generated by the AI in the response. Billed at the output rate,
    /// which is typically higher than input tokens.
    #[serde(default)]
    pub output_tokens: u64,

    /// Cache read tokens
    ///
    /// Tokens loaded from the prompt cache. These are significantly cheaper than
    /// regular input tokens (often 10x cheaper).
    #[serde(default)]
    pub cache_read_tokens: u64,

    /// Cache write tokens
    ///
    /// Tokens written to the prompt cache for future reuse. Slightly more expensive
    /// than input tokens but provide long-term cost savings.
    #[serde(default)]
    pub cache_write_tokens: u64,

    /// Cost in dollars (if available)
    ///
    /// Calculated cost based on the provider's pricing. May be None if pricing
    /// information is unavailable.
    #[serde(default)]
    pub cost: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_agent_prompt() {
        let msg = ToAgent::Prompt {
            content: "Hello".to_string(),
            attachments: vec![],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("prompt"));
        assert!(json.contains("Hello"));
    }

    #[test]
    fn test_from_agent_response_chunk() {
        let json = r#"{"type":"response_chunk","response_id":"123","content":"Hello","is_thinking":false}"#;
        let msg: FromAgent = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, FromAgent::ResponseChunk { content, .. } if content == "Hello"));
    }

    #[test]
    fn test_from_agent_tool_call() {
        let json = r#"{"type":"tool_call","call_id":"abc","tool":"read","args":{"path":"/foo"},"requires_approval":true}"#;
        let msg: FromAgent = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, FromAgent::ToolCall { tool, .. } if tool == "read"));
    }
}

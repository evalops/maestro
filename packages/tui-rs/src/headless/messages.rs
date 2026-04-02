//! Message types for the headless protocol.
//!
//! This module defines all messages exchanged between the Rust TUI and Node.js agent.
//! It uses [serde](https://serde.rs/) for type-safe JSON serialization and deserialization,
//! enabling reliable inter-process communication (IPC).
//!
//! # Protocol Message Types
//!
//! The protocol consists of two main message categories:
//!
//! - **`ToAgentMessage`** - Messages sent from the TUI to the agent (commands)
//! - **`FromAgentMessage`** - Messages received from the agent (events)
//!
//! All messages are tagged enums, meaning each variant includes a `type` field in the
//! JSON representation. This allows the receiver to determine the message type before
//! deserializing the full payload.
//!
//! # Serde JSON Serialization
//!
//! ## Tagged Enum Pattern
//!
//! The protocol uses serde's `tag` attribute to create discriminated unions:
//!
//! ```rust,ignore
//! #[derive(Serialize, Deserialize)]
//! #[serde(tag = "type", rename_all = "snake_case")]
//! enum ToAgentMessage {
//!     Prompt { content: String },
//!     Interrupt,
//! }
//! ```
//!
//! This generates JSON like:
//!
//! ```json
//! {"type": "prompt", "content": "Hello"}
//! {"type": "interrupt"}
//! ```
//!
//! Benefits:
//! - **Type safety** - Invalid message types are rejected at deserialization
//! - **Self-describing** - Each message carries its type information
//! - **Extensible** - New message types can be added without breaking old clients
//!
//! ## Field Attributes
//!
//! Optional fields use the `skip_serializing_if` attribute to omit null values:
//!
//! ```rust,ignore
//! #[serde(skip_serializing_if = "Option::is_none")]
//! attachments: Option<Vec<String>>
//! ```
//!
//! This produces cleaner JSON and reduces message size when optional fields are unused.
//!
//! # State Management
//!
//! The `AgentState` struct tracks the agent's current state by processing incoming messages.
//! This allows the TUI to maintain a synchronized view of the agent's status without
//! polling or complex state synchronization protocols.
//!
//! # Message Flow
//!
//! ## Typical Request-Response Flow
//!
//! ```text
//! TUI                           Agent
//!  |                              |
//!  |-- Prompt -----------------> |
//!  |                              |
//!  | <---------- Ready ----------|
//!  | <-- SessionInfo ------------|
//!  | <-- ResponseStart ----------|
//!  | <-- ResponseChunk ----------| (multiple)
//!  | <-- ResponseChunk ----------|
//!  | <-- ResponseEnd ------------|
//! ```
//!
//! ## Tool Approval Flow
//!
//! ```text
//! TUI                           Agent
//!  |                              |
//!  | <-------- ToolCall ---------|
//!  |                              |
//!  |-- ToolResponse (approved)-> |
//!  |                              |
//!  | <------- ToolStart ---------|
//!  | <------- ToolOutput --------| (streaming)
//!  | <------- ToolEnd -----------|
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Messages from TUI to Agent
// =============================================================================

/// Messages sent from the TUI to the agent.
///
/// These messages represent commands or control signals sent from the Rust TUI
/// to the Node.js agent. Each variant maps to a specific agent operation.
///
/// # Serialization Format
///
/// Uses serde's `tag` attribute to add a `type` discriminator field:
///
/// ```json
/// {"type": "prompt", "content": "Hello", "attachments": ["file.txt"]}
/// {"type": "interrupt"}
/// {"type": "shutdown"}
/// ```
///
/// The `rename_all = "snake_case"` attribute converts Rust's `PascalCase` variant names
/// to JSON's `snake_case` convention (e.g., `ToolResponse` becomes `"tool_response"`).
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_tui::headless::ToAgentMessage;
///
/// // Send a simple prompt
/// let msg = ToAgentMessage::Prompt {
///     content: "Hello!".to_string(),
///     attachments: None,
/// };
///
/// // Send a prompt with file attachments
/// let msg = ToAgentMessage::Prompt {
///     content: "Review these files".to_string(),
///     attachments: Some(vec!["main.rs".to_string()]),
/// };
///
/// // Interrupt current operation
/// let msg = ToAgentMessage::Interrupt;
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToAgentMessage {
    /// Configure agent behavior before the first prompt
    Init {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        append_system_prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking_level: Option<ThinkingLevel>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval_mode: Option<ApprovalMode>,
    },
    /// Send a user prompt
    Prompt {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<String>>,
    },
    /// Interrupt the current operation
    Interrupt,
    /// Respond to a tool approval request
    ToolResponse {
        call_id: String,
        approved: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
    },
    /// Cancel the current operation
    Cancel,
    /// Shut down the agent
    Shutdown,
}

/// Optional agent initialization settings sent before the first prompt.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct InitConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<ApprovalMode>,
}

/// Headless thinking effort configuration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Ultra,
}

/// Headless approval behavior for tool calls.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Auto,
    Prompt,
    Fail,
}

/// Result of a tool execution
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Structured details about the tool execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

// =============================================================================
// Messages from Agent to TUI
// =============================================================================

/// Messages received from the agent.
///
/// These messages represent events, responses, and status updates sent from the Node.js
/// agent to the Rust TUI. The TUI processes these messages to update its UI and state.
///
/// # Message Categories
///
/// - **Lifecycle** - `Ready`, `SessionInfo`
/// - **Responses** - `ResponseStart`, `ResponseChunk`, `ResponseEnd`
/// - **Tool Execution** - `ToolCall`, `ToolStart`, `ToolOutput`, `ToolEnd`
/// - **Status** - `Error`, `Status`
///
/// # Streaming Pattern
///
/// Many operations (responses, tool output) use a streaming pattern:
///
/// 1. **Start** message - Signals the beginning of an operation
/// 2. **Chunk/Output** messages - Stream data incrementally (0 or more)
/// 3. **End** message - Signals completion with metadata
///
/// This pattern enables:
/// - **Progressive rendering** - Display partial results before completion
/// - **Low latency** - Show the first token immediately
/// - **Cancellation** - Interrupt long-running operations
///
/// # Deserialization
///
/// The `#[serde(tag = "type")]` attribute enables type-directed deserialization:
///
/// ```rust,ignore
/// use maestro_tui::headless::FromAgentMessage;
///
/// let json = r#"{"type":"ready","model":"claude-3-opus","provider":"anthropic"}"#;
/// let msg: FromAgentMessage = serde_json::from_str(json)?;
///
/// match msg {
///     FromAgentMessage::Ready { model, .. } => {
///         println!("Agent ready with model: {}", model);
///     }
///     _ => {}
/// }
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromAgentMessage {
    /// Agent is ready
    Ready {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<String>,
        model: String,
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// Response streaming started
    ResponseStart { response_id: String },
    /// Response chunk (text or thinking)
    ResponseChunk {
        response_id: String,
        content: String,
        is_thinking: bool,
    },
    /// Response streaming ended
    ResponseEnd {
        response_id: String,
        #[serde(default)]
        usage: Option<TokenUsage>,
        #[serde(default)]
        tools_summary: Option<ResponseToolsSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttft_ms: Option<u64>,
    },
    /// Tool call (may require approval)
    ToolCall {
        call_id: String,
        tool: String,
        args: serde_json::Value,
        requires_approval: bool,
    },
    /// Tool execution started
    ToolStart { call_id: String },
    /// Tool output chunk
    ToolOutput { call_id: String, content: String },
    /// Tool execution ended
    ToolEnd { call_id: String, success: bool },
    /// Error occurred
    Error {
        message: String,
        fatal: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_type: Option<HeadlessErrorType>,
    },
    /// Status update
    Status { message: String },
    /// Conversation history was compacted into a summary
    Compaction {
        summary: String,
        first_kept_entry_index: usize,
        tokens_before: u64,
        #[serde(default)]
        auto: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
        timestamp: String,
    },
    /// Session information
    SessionInfo {
        session_id: Option<String>,
        cwd: String,
        git_branch: Option<String>,
    },
}

/// Token usage statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    #[serde(
        default,
        rename = "total_cost_usd",
        alias = "cost",
        skip_serializing_if = "Option::is_none"
    )]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Summary of the tools used during a response.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResponseToolsSummary {
    #[serde(default)]
    pub tools_used: Vec<String>,
    #[serde(default)]
    pub calls_succeeded: u64,
    #[serde(default)]
    pub calls_failed: u64,
    #[serde(default)]
    pub summary_labels: Vec<String>,
}

impl TokenUsage {
    #[must_use]
    pub fn total_tokens(&self) -> u64 {
        self.total_tokens
            .unwrap_or(self.input_tokens + self.output_tokens)
    }
}

/// Structured error category emitted by the headless protocol.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeadlessErrorType {
    Transient,
    Fatal,
    Tool,
    Cancelled,
    Protocol,
}

// =============================================================================
// State tracking
// =============================================================================

/// Current state of the agent connection.
///
/// Maintains a synchronized view of the agent's state by processing incoming messages.
/// This struct tracks active operations, pending approvals, and metadata about the
/// current session.
///
/// # State Synchronization
///
/// The `AgentState` uses an event-sourcing pattern where state is derived from
/// incoming messages rather than queried. The `handle_message()` method processes
/// each `FromAgentMessage` and updates internal state accordingly.
///
/// Benefits of this approach:
/// - **No polling** - State updates are event-driven
/// - **Consistency** - State always reflects the latest message
/// - **Simplicity** - No need for separate state query protocol
///
/// # Usage Pattern
///
/// ```rust,ignore
/// use maestro_tui::headless::{AgentState, FromAgentMessage};
///
/// let mut state = AgentState::default();
///
/// // Process a message
/// let msg = FromAgentMessage::Ready {
///     model: "claude-3-opus".to_string(),
///     provider: "anthropic".to_string(),
/// };
///
/// if let Some(event) = state.handle_message(msg) {
///     // React to the event
///     println!("Agent is ready!");
/// }
///
/// assert!(state.is_ready);
/// assert_eq!(state.model.as_deref(), Some("claude-3-opus"));
/// ```
///
/// # Thread Safety
///
/// `AgentState` is `Clone` but not thread-safe (`!Sync`). Each transport should
/// maintain its own state instance. For shared state across threads, wrap in
/// `Arc<Mutex<AgentState>>`.
#[derive(Debug, Clone, Default)]
pub struct AgentState {
    /// Model information
    pub protocol_version: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    /// Session information
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    /// Current response being streamed
    pub current_response: Option<StreamingResponse>,
    /// Pending tool calls requiring approval
    pub pending_approvals: Vec<PendingApproval>,
    /// Active tool executions
    pub active_tools: HashMap<String, ActiveTool>,
    /// Tracks tool metadata until a tool run completes, even when approval is not required.
    pub tracked_tools: HashMap<String, PendingApproval>,
    /// Last error message
    pub last_error: Option<String>,
    /// Last structured error type
    pub last_error_type: Option<HeadlessErrorType>,
    /// Last status message
    pub last_status: Option<String>,
    /// Last response duration
    pub last_response_duration_ms: Option<u64>,
    /// Last time-to-first-token telemetry
    pub last_ttft_ms: Option<u64>,
    /// Whether the agent is ready
    pub is_ready: bool,
    /// Whether currently processing a response
    pub is_responding: bool,
}

/// A response currently being streamed
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamingResponse {
    pub response_id: String,
    pub text: String,
    pub thinking: String,
    pub usage: Option<TokenUsage>,
}

impl StreamingResponse {
    #[must_use]
    pub fn new(response_id: String) -> Self {
        Self {
            response_id,
            text: String::new(),
            thinking: String::new(),
            usage: None,
        }
    }

    pub fn append(&mut self, content: &str, is_thinking: bool) {
        if is_thinking {
            self.thinking.push_str(content);
        } else {
            self.text.push_str(content);
        }
    }
}

/// A tool call pending approval
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingApproval {
    pub call_id: String,
    pub tool: String,
    pub args: serde_json::Value,
}

/// A tool currently executing
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveTool {
    pub call_id: String,
    pub tool: String,
    pub output: String,
    pub started: std::time::Instant,
}

impl AgentState {
    /// Handle an outbound message and update optimistic local state.
    pub fn handle_sent_message(&mut self, msg: &ToAgentMessage) {
        match msg {
            ToAgentMessage::Init { .. } => {}
            ToAgentMessage::Prompt { .. } => {
                self.current_response = None;
                self.last_error = None;
                self.last_error_type = None;
                self.last_status = None;
                self.is_responding = true;
            }
            ToAgentMessage::Interrupt | ToAgentMessage::Cancel => {
                self.current_response = None;
                self.pending_approvals.clear();
                self.active_tools.clear();
                self.tracked_tools.clear();
                self.is_responding = false;
            }
            ToAgentMessage::ToolResponse {
                call_id, approved, ..
            } => {
                let _ = self.remove_pending_approval(call_id);
                if !approved {
                    self.tracked_tools.remove(call_id);
                }
            }
            ToAgentMessage::Shutdown => {
                self.current_response = None;
                self.pending_approvals.clear();
                self.active_tools.clear();
                self.tracked_tools.clear();
                self.is_ready = false;
                self.is_responding = false;
            }
        }
    }

    /// Handle an incoming message and update state
    pub fn handle_message(&mut self, msg: FromAgentMessage) -> Option<AgentEvent> {
        match msg {
            FromAgentMessage::Ready {
                protocol_version,
                model,
                provider,
                session_id,
            } => {
                self.protocol_version = protocol_version.clone();
                self.model = Some(model.clone());
                self.provider = Some(provider.clone());
                self.session_id = session_id.clone();
                self.is_ready = true;
                Some(AgentEvent::Ready {
                    protocol_version,
                    model,
                    provider,
                    session_id,
                })
            }

            FromAgentMessage::SessionInfo {
                session_id,
                cwd,
                git_branch,
            } => {
                self.session_id = session_id.clone();
                self.cwd = Some(cwd.clone());
                self.git_branch = git_branch.clone();
                Some(AgentEvent::SessionInfo {
                    session_id,
                    cwd,
                    git_branch,
                })
            }

            FromAgentMessage::ResponseStart { response_id } => {
                self.current_response = Some(StreamingResponse::new(response_id.clone()));
                self.is_responding = true;
                Some(AgentEvent::ResponseStart { response_id })
            }

            FromAgentMessage::ResponseChunk {
                response_id,
                content,
                is_thinking,
            } => {
                if let Some(ref mut response) = self.current_response {
                    if response.response_id == response_id {
                        response.append(&content, is_thinking);
                    }
                }
                Some(AgentEvent::ResponseChunk {
                    response_id,
                    content,
                    is_thinking,
                })
            }

            FromAgentMessage::ResponseEnd {
                response_id,
                usage,
                tools_summary,
                duration_ms,
                ttft_ms,
            } => {
                if let Some(ref mut response) = self.current_response {
                    if response.response_id == response_id {
                        response.usage = usage.clone();
                    }
                }
                self.last_response_duration_ms = duration_ms;
                self.last_ttft_ms = ttft_ms;
                self.is_responding = false;
                let response = self.current_response.take();
                Some(AgentEvent::ResponseEnd {
                    response_id,
                    usage,
                    tools_summary,
                    duration_ms,
                    ttft_ms,
                    full_text: response.map(|r| r.text),
                })
            }

            FromAgentMessage::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                self.tracked_tools.insert(
                    call_id.clone(),
                    PendingApproval {
                        call_id: call_id.clone(),
                        tool: tool.clone(),
                        args: args.clone(),
                    },
                );
                if requires_approval {
                    self.pending_approvals.push(PendingApproval {
                        call_id: call_id.clone(),
                        tool: tool.clone(),
                        args: args.clone(),
                    });
                    Some(AgentEvent::ApprovalRequired {
                        call_id,
                        tool,
                        args,
                    })
                } else {
                    Some(AgentEvent::ToolCall {
                        call_id,
                        tool,
                        args,
                    })
                }
            }

            FromAgentMessage::ToolStart { call_id } => {
                let tool = self
                    .tracked_tools
                    .get(&call_id)
                    .map_or_else(|| "unknown".to_string(), |p| p.tool.clone());

                self.active_tools.insert(
                    call_id.clone(),
                    ActiveTool {
                        call_id: call_id.clone(),
                        tool: tool.clone(),
                        output: String::new(),
                        started: std::time::Instant::now(),
                    },
                );
                Some(AgentEvent::ToolStart { call_id, tool })
            }

            FromAgentMessage::ToolOutput { call_id, content } => {
                if let Some(tool) = self.active_tools.get_mut(&call_id) {
                    tool.output.push_str(&content);
                }
                Some(AgentEvent::ToolOutput { call_id, content })
            }

            FromAgentMessage::ToolEnd { call_id, success } => {
                let tool = self.active_tools.remove(&call_id);
                self.tracked_tools.remove(&call_id);
                self.pending_approvals.retain(|p| p.call_id != call_id);
                Some(AgentEvent::ToolEnd {
                    call_id,
                    success,
                    duration: tool.map(|t| t.started.elapsed()),
                })
            }

            FromAgentMessage::Error {
                message,
                fatal,
                error_type,
            } => {
                self.last_error = Some(message.clone());
                self.last_error_type = error_type;
                Some(AgentEvent::Error {
                    message,
                    fatal,
                    error_type,
                })
            }

            FromAgentMessage::Status { message } => {
                self.last_status = Some(message.clone());
                Some(AgentEvent::Status { message })
            }
            FromAgentMessage::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => Some(AgentEvent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            }),
        }
    }

    /// Remove a pending approval (after user decision)
    pub fn remove_pending_approval(&mut self, call_id: &str) -> Option<PendingApproval> {
        let idx = self
            .pending_approvals
            .iter()
            .position(|p| p.call_id == call_id)?;
        Some(self.pending_approvals.remove(idx))
    }
}

/// High-level events for the TUI to react to
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Ready {
        protocol_version: Option<String>,
        model: String,
        provider: String,
        session_id: Option<String>,
    },
    SessionInfo {
        session_id: Option<String>,
        cwd: String,
        git_branch: Option<String>,
    },
    ResponseStart {
        response_id: String,
    },
    ResponseChunk {
        response_id: String,
        content: String,
        is_thinking: bool,
    },
    ResponseEnd {
        response_id: String,
        usage: Option<TokenUsage>,
        tools_summary: Option<ResponseToolsSummary>,
        duration_ms: Option<u64>,
        ttft_ms: Option<u64>,
        full_text: Option<String>,
    },
    ToolCall {
        call_id: String,
        tool: String,
        args: serde_json::Value,
    },
    ApprovalRequired {
        call_id: String,
        tool: String,
        args: serde_json::Value,
    },
    ToolStart {
        call_id: String,
        tool: String,
    },
    ToolOutput {
        call_id: String,
        content: String,
    },
    ToolEnd {
        call_id: String,
        success: bool,
        duration: Option<std::time::Duration>,
    },
    Error {
        message: String,
        fatal: bool,
        error_type: Option<HeadlessErrorType>,
    },
    Status {
        message: String,
    },
    Compaction {
        summary: String,
        first_kept_entry_index: usize,
        tokens_before: u64,
        auto: bool,
        custom_instructions: Option<String>,
        timestamp: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ready_message() {
        let json = r#"{"type":"ready","protocol_version":"2026-03-30","model":"claude-3-opus","provider":"anthropic","session_id":"sess_123"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::Ready {
                protocol_version,
                model,
                provider,
                session_id,
            } => {
                assert_eq!(protocol_version.as_deref(), Some("2026-03-30"));
                assert_eq!(model, "claude-3-opus");
                assert_eq!(provider, "anthropic");
                assert_eq!(session_id.as_deref(), Some("sess_123"));
            }
            _ => panic!("Expected Ready message"),
        }
    }

    #[test]
    fn parse_response_chunk() {
        let json = r#"{"type":"response_chunk","response_id":"abc","content":"Hello","is_thinking":false}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ResponseChunk {
                response_id,
                content,
                is_thinking,
            } => {
                assert_eq!(response_id, "abc");
                assert_eq!(content, "Hello");
                assert!(!is_thinking);
            }
            _ => panic!("Expected ResponseChunk message"),
        }
    }

    #[test]
    fn parse_response_end_with_tools_summary() {
        let json = r#"{"type":"response_end","response_id":"abc","usage":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":0,"cache_write_tokens":0,"total_tokens":3,"total_cost_usd":0.25,"model_id":"claude-sonnet","provider":"anthropic"},"tools_summary":{"tools_used":["read","bash"],"calls_succeeded":1,"calls_failed":1,"summary_labels":["Read package.json","Ran cargo test"]},"duration_ms":2500,"ttft_ms":120}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ResponseEnd {
                response_id,
                usage,
                tools_summary,
                duration_ms,
                ttft_ms,
                ..
            } => {
                assert_eq!(response_id, "abc");
                let usage = usage.expect("expected usage");
                assert_eq!(usage.total_tokens(), 3);
                assert_eq!(usage.cost, Some(0.25));
                assert_eq!(usage.model_id.as_deref(), Some("claude-sonnet"));
                assert_eq!(usage.provider.as_deref(), Some("anthropic"));
                let tools_summary = tools_summary.expect("expected tools summary");
                assert_eq!(tools_summary.tools_used, vec!["read", "bash"]);
                assert_eq!(tools_summary.calls_succeeded, 1);
                assert_eq!(tools_summary.calls_failed, 1);
                assert_eq!(duration_ms, Some(2500));
                assert_eq!(ttft_ms, Some(120));
                assert_eq!(
                    tools_summary.summary_labels,
                    vec!["Read package.json", "Ran cargo test"]
                );
            }
            _ => panic!("Expected ResponseEnd message"),
        }
    }

    #[test]
    fn parse_compaction_message() {
        let json = r###"{"type":"compaction","summary":"## Conversation Summary","first_kept_entry_index":3,"tokens_before":9000,"auto":true,"timestamp":"2026-03-31T12:00:00Z"}"###;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::Compaction {
                first_kept_entry_index,
                tokens_before,
                auto,
                ..
            } => {
                assert_eq!(first_kept_entry_index, 3);
                assert_eq!(tokens_before, 9000);
                assert!(auto);
            }
            _ => panic!("Expected Compaction message"),
        }
    }

    #[test]
    fn serialize_prompt_message() {
        let msg = ToAgentMessage::Prompt {
            content: "Hello".to_string(),
            attachments: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"prompt""#));
        assert!(json.contains(r#""content":"Hello""#));
    }

    #[test]
    fn serialize_init_message() {
        let msg = ToAgentMessage::Init {
            system_prompt: Some("You are Maestro".to_string()),
            append_system_prompt: None,
            thinking_level: Some(ThinkingLevel::High),
            approval_mode: Some(ApprovalMode::Prompt),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"init""#));
        assert!(json.contains(r#""system_prompt":"You are Maestro""#));
        assert!(json.contains(r#""thinking_level":"high""#));
        assert!(json.contains(r#""approval_mode":"prompt""#));
    }

    #[test]
    fn state_handles_response_stream() {
        let mut state = AgentState::default();
        state.handle_message(FromAgentMessage::Ready {
            protocol_version: Some("2026-03-30".to_string()),
            model: "claude-3-opus".to_string(),
            provider: "anthropic".to_string(),
            session_id: Some("sess_123".to_string()),
        });

        assert_eq!(state.protocol_version.as_deref(), Some("2026-03-30"));
        assert_eq!(state.session_id.as_deref(), Some("sess_123"));

        // Start response
        state.handle_message(FromAgentMessage::ResponseStart {
            response_id: "resp1".to_string(),
        });
        assert!(state.is_responding);
        assert!(state.current_response.is_some());

        // Add chunks
        state.handle_message(FromAgentMessage::ResponseChunk {
            response_id: "resp1".to_string(),
            content: "Hello ".to_string(),
            is_thinking: false,
        });
        state.handle_message(FromAgentMessage::ResponseChunk {
            response_id: "resp1".to_string(),
            content: "world".to_string(),
            is_thinking: false,
        });

        assert_eq!(state.current_response.as_ref().unwrap().text, "Hello world");

        // End response
        state.handle_message(FromAgentMessage::ResponseEnd {
            response_id: "resp1".to_string(),
            usage: None,
            tools_summary: Some(ResponseToolsSummary {
                tools_used: vec!["read".to_string()],
                calls_succeeded: 1,
                calls_failed: 0,
                summary_labels: vec!["Read package.json".to_string()],
            }),
            duration_ms: Some(2300),
            ttft_ms: Some(150),
        });
        assert!(!state.is_responding);
        assert!(state.current_response.is_none());
        assert_eq!(state.last_response_duration_ms, Some(2300));
        assert_eq!(state.last_ttft_ms, Some(150));
    }

    #[test]
    fn state_tracks_structured_errors() {
        let mut state = AgentState::default();
        state.handle_message(FromAgentMessage::ResponseStart {
            response_id: "resp1".to_string(),
        });
        let event = state.handle_message(FromAgentMessage::Error {
            message: "Cancelled by user".to_string(),
            fatal: false,
            error_type: Some(HeadlessErrorType::Cancelled),
        });

        assert_eq!(state.last_error.as_deref(), Some("Cancelled by user"));
        assert_eq!(state.last_error_type, Some(HeadlessErrorType::Cancelled));
        assert!(state.is_responding);
        assert!(matches!(
            event,
            Some(AgentEvent::Error {
                error_type: Some(HeadlessErrorType::Cancelled),
                ..
            })
        ));
    }

    #[test]
    fn state_handles_compaction_event() {
        let mut state = AgentState::default();
        let event = state.handle_message(FromAgentMessage::Compaction {
            summary: "## Conversation Summary".to_string(),
            first_kept_entry_index: 2,
            tokens_before: 7000,
            auto: false,
            custom_instructions: None,
            timestamp: "2026-03-31T12:00:00Z".to_string(),
        });

        assert!(matches!(
            event,
            Some(AgentEvent::Compaction {
                first_kept_entry_index,
                tokens_before,
                auto,
                ..
            }) if first_kept_entry_index == 2 && tokens_before == 7000 && !auto
        ));
    }

    #[test]
    fn state_preserves_tool_name_for_nonapproval_runs() {
        let mut state = AgentState::default();

        let tool_call = state.handle_message(FromAgentMessage::ToolCall {
            call_id: "call_read".to_string(),
            tool: "read".to_string(),
            args: serde_json::json!({ "file_path": "package.json" }),
            requires_approval: false,
        });
        assert!(matches!(
            tool_call,
            Some(AgentEvent::ToolCall { ref tool, .. }) if tool == "read"
        ));

        let tool_start = state.handle_message(FromAgentMessage::ToolStart {
            call_id: "call_read".to_string(),
        });
        assert!(matches!(
            tool_start,
            Some(AgentEvent::ToolStart { ref tool, .. }) if tool == "read"
        ));
        assert_eq!(
            state
                .active_tools
                .get("call_read")
                .map(|tool| tool.tool.as_str()),
            Some("read")
        );
    }
}

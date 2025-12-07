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
//! - **ToAgentMessage** - Messages sent from the TUI to the agent (commands)
//! - **FromAgentMessage** - Messages received from the agent (events)
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
/// use composer_tui::headless::ToAgentMessage;
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

/// Result of a tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
/// use composer_tui::headless::FromAgentMessage;
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
    Ready { model: String, provider: String },
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
    Error { message: String, fatal: bool },
    /// Status update
    Status { message: String },
    /// Session information
    SessionInfo {
        session_id: Option<String>,
        cwd: String,
        git_branch: Option<String>,
    },
}

/// Token usage statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub cost: Option<f64>,
}

impl TokenUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
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
/// use composer_tui::headless::{AgentState, FromAgentMessage};
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
    /// Last error message
    pub last_error: Option<String>,
    /// Last status message
    pub last_status: Option<String>,
    /// Whether the agent is ready
    pub is_ready: bool,
    /// Whether currently processing a response
    pub is_responding: bool,
}

/// A response currently being streamed
#[derive(Debug, Clone)]
pub struct StreamingResponse {
    pub response_id: String,
    pub text: String,
    pub thinking: String,
    pub usage: Option<TokenUsage>,
}

impl StreamingResponse {
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
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub call_id: String,
    pub tool: String,
    pub args: serde_json::Value,
}

/// A tool currently executing
#[derive(Debug, Clone)]
pub struct ActiveTool {
    pub call_id: String,
    pub tool: String,
    pub output: String,
    pub started: std::time::Instant,
}

impl AgentState {
    /// Handle an incoming message and update state
    pub fn handle_message(&mut self, msg: FromAgentMessage) -> Option<AgentEvent> {
        match msg {
            FromAgentMessage::Ready { model, provider } => {
                self.model = Some(model.clone());
                self.provider = Some(provider.clone());
                self.is_ready = true;
                Some(AgentEvent::Ready { model, provider })
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

            FromAgentMessage::ResponseEnd { response_id, usage } => {
                if let Some(ref mut response) = self.current_response {
                    if response.response_id == response_id {
                        response.usage = usage.clone();
                    }
                }
                self.is_responding = false;
                let response = self.current_response.take();
                Some(AgentEvent::ResponseEnd {
                    response_id,
                    usage,
                    full_text: response.map(|r| r.text),
                })
            }

            FromAgentMessage::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
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
                // Find the tool info from pending or create new
                let tool = self
                    .pending_approvals
                    .iter()
                    .find(|p| p.call_id == call_id)
                    .map(|p| p.tool.clone())
                    .unwrap_or_else(|| "unknown".to_string());

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
                // Also remove from pending approvals
                self.pending_approvals.retain(|p| p.call_id != call_id);
                Some(AgentEvent::ToolEnd {
                    call_id,
                    success,
                    duration: tool.map(|t| t.started.elapsed()),
                })
            }

            FromAgentMessage::Error { message, fatal } => {
                self.last_error = Some(message.clone());
                Some(AgentEvent::Error { message, fatal })
            }

            FromAgentMessage::Status { message } => {
                self.last_status = Some(message.clone());
                Some(AgentEvent::Status { message })
            }
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
        model: String,
        provider: String,
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
    },
    Status {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ready_message() {
        let json = r#"{"type":"ready","model":"claude-3-opus","provider":"anthropic"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::Ready { model, provider } => {
                assert_eq!(model, "claude-3-opus");
                assert_eq!(provider, "anthropic");
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
    fn state_handles_response_stream() {
        let mut state = AgentState::default();

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
        });
        assert!(!state.is_responding);
        assert!(state.current_response.is_none());
    }
}

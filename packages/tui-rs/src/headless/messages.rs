//! Message types for headless protocol
//!
//! Defines all messages exchanged between the Rust TUI and Node.js agent.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Messages from TUI to Agent
// =============================================================================

/// Messages sent from the TUI to the agent
#[derive(Debug, Clone, Serialize)]
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

/// Messages received from the agent
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromAgentMessage {
    /// Agent is ready
    Ready {
        model: String,
        provider: String,
    },
    /// Response streaming started
    ResponseStart {
        response_id: String,
    },
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
    ToolStart {
        call_id: String,
    },
    /// Tool output chunk
    ToolOutput {
        call_id: String,
        content: String,
    },
    /// Tool execution ended
    ToolEnd {
        call_id: String,
        success: bool,
    },
    /// Error occurred
    Error {
        message: String,
        fatal: bool,
    },
    /// Status update
    Status {
        message: String,
    },
    /// Session information
    SessionInfo {
        session_id: Option<String>,
        cwd: String,
        git_branch: Option<String>,
    },
}

/// Token usage statistics
#[derive(Debug, Clone, Default, Deserialize)]
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

/// Current state of the agent connection
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
        let json =
            r#"{"type":"response_chunk","response_id":"abc","content":"Hello","is_thinking":false}"#;
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

        assert_eq!(
            state.current_response.as_ref().unwrap().text,
            "Hello world"
        );

        // End response
        state.handle_message(FromAgentMessage::ResponseEnd {
            response_id: "resp1".to_string(),
            usage: None,
        });
        assert!(!state.is_responding);
        assert!(state.current_response.is_none());
    }
}

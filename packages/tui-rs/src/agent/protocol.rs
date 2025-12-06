//! Agent IPC protocol
//!
//! Simple JSON messages between Rust TUI and Node.js agent.
//! Much simpler than render trees - just agent-level messages.

use serde::{Deserialize, Serialize};

// ============================================================================
// Messages from Rust TUI to Node.js Agent
// ============================================================================

/// Messages sent from Rust to the agent
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToAgent {
    /// User submitted a prompt
    Prompt {
        /// The user's message
        content: String,
        /// Files to attach (paths)
        #[serde(default)]
        attachments: Vec<String>,
    },

    /// User interrupted the agent (escape/ctrl-c)
    Interrupt,

    /// Response to a tool call
    ToolResponse {
        /// ID of the tool call this responds to
        call_id: String,
        /// Whether the tool was approved
        approved: bool,
        /// Result of the tool (if approved and executed)
        result: Option<ToolResult>,
    },

    /// Request to cancel current operation
    Cancel,

    /// Shutdown the agent gracefully
    Shutdown,
}

/// Result of a tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// Whether the tool succeeded
    pub success: bool,
    /// Output from the tool
    pub output: String,
    /// Error message if failed
    #[serde(default)]
    pub error: Option<String>,
}

// ============================================================================
// Messages from Node.js Agent to Rust TUI
// ============================================================================

/// Messages sent from the agent to Rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromAgent {
    /// Agent is ready to receive prompts
    Ready {
        /// Current model name
        model: String,
        /// Provider name
        provider: String,
    },

    /// Agent started generating a response
    ResponseStart {
        /// Unique ID for this response
        response_id: String,
    },

    /// Streaming text chunk from the agent
    ResponseChunk {
        /// Response ID this chunk belongs to
        response_id: String,
        /// The text content
        content: String,
        /// Whether this is thinking/reasoning (vs. final response)
        #[serde(default)]
        is_thinking: bool,
    },

    /// Agent finished generating response
    ResponseEnd {
        /// Response ID
        response_id: String,
        /// Token usage stats
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

    /// Agent wants to call a tool
    ToolCall {
        /// Unique ID for this tool call
        call_id: String,
        /// Name of the tool
        tool: String,
        /// Tool arguments (as JSON object)
        args: serde_json::Value,
        /// Whether this requires user approval
        requires_approval: bool,
    },

    /// Tool execution started (auto-approved or after approval)
    ToolStart {
        /// Tool call ID
        call_id: String,
    },

    /// Tool execution output (streaming)
    ToolOutput {
        /// Tool call ID
        call_id: String,
        /// Output content
        content: String,
    },

    /// Tool execution completed
    ToolEnd {
        /// Tool call ID
        call_id: String,
        /// Whether it succeeded
        success: bool,
    },

    /// An error occurred
    Error {
        /// Error message
        message: String,
        /// Whether this is fatal (agent should restart)
        #[serde(default)]
        fatal: bool,
    },

    /// Agent status update
    Status {
        /// Status message
        message: String,
    },

    /// Session info update
    SessionInfo {
        /// Session ID
        session_id: Option<String>,
        /// Working directory
        cwd: String,
        /// Git branch (if in a repo)
        #[serde(default)]
        git_branch: Option<String>,
    },
}

/// Token usage statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Input tokens used
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens used
    #[serde(default)]
    pub output_tokens: u64,
    /// Cache read tokens
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Cache write tokens
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// Cost in dollars (if available)
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

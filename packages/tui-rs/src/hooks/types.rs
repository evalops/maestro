//! Hook types and traits
//!
//! Defines the core types for the hook system including:
//! - Hook event types (`PreToolUse`, `PostToolUse`, etc.)
//! - Hook result types (Continue, Block, Modify)
//! - Traits for implementing hooks

use serde::{Deserialize, Serialize};

/// Result of a hook execution
///
/// Hooks return this to indicate how processing should continue.
#[derive(Debug, Clone, Default)]
pub enum HookResult {
    /// Continue with normal execution
    #[default]
    Continue,

    /// Block the operation with a reason
    Block { reason: String },

    /// Continue but with modified input
    ModifyInput { new_input: serde_json::Value },

    /// Continue but inject additional context
    InjectContext { context: String },
}

/// Hook event types matching the TypeScript implementation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum HookEventType {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    SessionStart,
    SessionEnd,
    SessionSwitch,
    SessionBeforeTree,
    SessionTree,
    UserPromptSubmit,
    PreCompact,
    Notification,
    Overflow,
    /// Before sending user message to model
    PreMessage,
    /// After receiving assistant response
    PostMessage,
    /// When an error occurs
    OnError,
    /// Evaluation gate for structured assertions/scores
    EvalGate,
    /// Before spawning a subagent
    SubagentStart,
    /// When a subagent completes
    SubagentStop,
    /// When permission is required for a tool
    PermissionRequest,
    /// When a session branch is created
    Branch,
}

/// Input data for `PreToolUse` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreToolUseInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub tool_input: serde_json::Value,
}

/// Input data for `PostToolUse` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostToolUseInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub tool_input: serde_json::Value,
    pub tool_output: String,
    pub is_error: bool,
}

/// Input data for `SessionStart` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStartInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub source: String,
}

/// Input data for `SessionEnd` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEndInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub reason: String,
    pub duration_ms: u64,
    pub turn_count: u32,
}

/// Input data for Overflow hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverflowInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub token_count: u64,
    pub max_tokens: u64,
}

/// Input data for `PreMessage` hooks
///
/// Called before a user message is sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreMessageInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// The user's message content
    pub message: String,
    /// Attached files (paths)
    pub attachments: Vec<String>,
    /// Current model being used
    pub model: Option<String>,
}

/// Input data for `PostMessage` hooks
///
/// Called after an assistant response is generated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostMessageInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// The assistant's response (text content only)
    pub response: String,
    /// Number of tokens used in input
    pub input_tokens: u64,
    /// Number of tokens in output
    pub output_tokens: u64,
    /// Total turn duration in milliseconds
    pub duration_ms: u64,
    /// Stop reason (if available)
    pub stop_reason: Option<String>,
}

/// Input data for `OnError` hooks
///
/// Called when an error occurs during agent execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnErrorInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Error message
    pub error: String,
    /// Error kind/type
    pub error_kind: String,
    /// Context where error occurred (tool name, api call, etc.)
    pub context: Option<String>,
    /// Whether the error is recoverable
    pub recoverable: bool,
}

/// Input data for `EvalGate` hooks
///
/// Called after tool execution to emit structured assertions/scores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalGateInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Tool name that was executed
    pub tool_name: String,
    /// Tool call ID
    pub tool_call_id: String,
    /// Tool input arguments
    pub tool_input: serde_json::Value,
    /// Tool output
    pub tool_output: String,
}

/// Input data for `SubagentStart` hooks
///
/// Called before spawning a subagent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentStartInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Subagent type being spawned
    pub subagent_type: String,
    /// Task description for the subagent
    pub task: String,
    /// Parent agent ID
    pub parent_agent_id: Option<String>,
}

/// Input data for `SubagentStop` hooks
///
/// Called when a subagent completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentStopInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Subagent type that completed
    pub subagent_type: String,
    /// Subagent ID
    pub subagent_id: String,
    /// Result summary from the subagent
    pub result: Option<String>,
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Whether the subagent succeeded
    pub success: bool,
}

/// Input data for `PermissionRequest` hooks
///
/// Called when permission is required for a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequestInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Tool requesting permission
    pub tool_name: String,
    /// Tool call ID
    pub tool_call_id: String,
    /// Tool input arguments
    pub tool_input: serde_json::Value,
    /// Reason permission is required
    pub reason: String,
}

/// Trait for `PreToolUse` hooks
///
/// Implement this trait to intercept tool calls before execution.
pub trait PreToolUseHook: Send + Sync {
    /// Called before a tool executes
    ///
    /// # Arguments
    /// * `input` - Information about the tool call
    ///
    /// # Returns
    /// A `HookResult` indicating how to proceed
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult;

    /// Optional: Check if this hook matches the tool
    ///
    /// Default implementation matches all tools.
    fn matches(&self, tool_name: &str) -> bool {
        let _ = tool_name;
        true
    }
}

/// Trait for `PostToolUse` hooks
///
/// Implement this trait to process tool results after execution.
pub trait PostToolUseHook: Send + Sync {
    /// Called after a tool executes
    ///
    /// # Arguments
    /// * `input` - Information about the tool call and result
    ///
    /// # Returns
    /// A `HookResult` indicating how to proceed
    fn on_post_tool_use(&self, input: &PostToolUseInput) -> HookResult;

    /// Optional: Check if this hook matches the tool
    fn matches(&self, tool_name: &str) -> bool {
        let _ = tool_name;
        true
    }
}

/// Trait for `SessionStart` hooks
pub trait SessionStartHook: Send + Sync {
    fn on_session_start(&self, input: &SessionStartInput) -> HookResult;
}

/// Trait for `SessionEnd` hooks
pub trait SessionEndHook: Send + Sync {
    fn on_session_end(&self, input: &SessionEndInput) -> HookResult;
}

/// Trait for Overflow hooks
///
/// Called when context overflow is detected.
pub trait OverflowHook: Send + Sync {
    /// Called when context overflow is detected
    ///
    /// # Arguments
    /// * `input` - Information about the overflow
    ///
    /// # Returns
    /// A `HookResult` - typically Continue to allow auto-compaction
    fn on_overflow(&self, input: &OverflowInput) -> HookResult;
}

/// Trait for `PreMessage` hooks
///
/// Called before a user message is sent to the model.
/// Can be used to modify, validate, or block messages.
pub trait PreMessageHook: Send + Sync {
    /// Called before sending user message to model
    ///
    /// # Returns
    /// - `Continue`: Send message as-is
    /// - `ModifyInput`: Send modified message
    /// - `Block`: Don't send message, show reason to user
    fn on_pre_message(&self, input: &PreMessageInput) -> HookResult;
}

/// Trait for `PostMessage` hooks
///
/// Called after an assistant response is generated.
/// Can be used for logging, analytics, or post-processing.
pub trait PostMessageHook: Send + Sync {
    /// Called after assistant response is generated
    ///
    /// # Note
    /// Return value is typically ignored for post-hooks.
    fn on_post_message(&self, input: &PostMessageInput) -> HookResult;
}

/// Trait for `OnError` hooks
///
/// Called when an error occurs during agent execution.
/// Can be used for error logging, alerting, or recovery.
pub trait OnErrorHook: Send + Sync {
    /// Called when an error occurs
    ///
    /// # Arguments
    /// * `input` - Information about the error
    ///
    /// # Returns
    /// - `Continue`: Proceed with default error handling
    /// - `Block`: Suppress the error (use with caution)
    fn on_error(&self, input: &OnErrorInput) -> HookResult;
}

/// Trait for `EvalGate` hooks
///
/// Called after tool execution to emit structured assertions/scores.
/// Used for evaluation and testing scenarios.
pub trait EvalGateHook: Send + Sync {
    /// Called after tool execution for evaluation
    fn on_eval_gate(&self, input: &EvalGateInput) -> HookResult;
}

/// Trait for `SubagentStart` hooks
///
/// Called before spawning a subagent.
/// Can be used to modify subagent parameters or block spawning.
pub trait SubagentStartHook: Send + Sync {
    /// Called before spawning a subagent
    ///
    /// # Returns
    /// - `Continue`: Proceed with spawning
    /// - `Block`: Prevent subagent spawn
    /// - `ModifyInput`: Modify subagent parameters
    fn on_subagent_start(&self, input: &SubagentStartInput) -> HookResult;
}

/// Trait for `SubagentStop` hooks
///
/// Called when a subagent completes execution.
/// Can be used for logging or post-processing subagent results.
pub trait SubagentStopHook: Send + Sync {
    /// Called when a subagent completes
    fn on_subagent_stop(&self, input: &SubagentStopInput) -> HookResult;
}

/// Trait for `PermissionRequest` hooks
///
/// Called when a tool requires permission to execute.
/// Can be used to auto-approve, auto-deny, or modify approval behavior.
pub trait PermissionRequestHook: Send + Sync {
    /// Called when permission is required
    ///
    /// # Returns
    /// - `Continue`: Show normal permission prompt
    /// - `Block`: Deny permission with reason
    /// - `InjectContext`: Add context to permission prompt
    fn on_permission_request(&self, input: &PermissionRequestInput) -> HookResult;
}

/// Output format for hooks (JSON-compatible with TypeScript)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookOutput {
    /// Whether to continue processing
    #[serde(rename = "continue")]
    pub should_continue: bool,

    /// Decision type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,

    /// Additional context to inject
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_context: Option<String>,

    /// Reason for blocking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_reason: Option<String>,

    /// Modified input
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_input: Option<serde_json::Value>,
}

impl From<HookResult> for HookOutput {
    fn from(result: HookResult) -> Self {
        match result {
            HookResult::Continue => HookOutput {
                should_continue: true,
                decision: Some("approve".to_string()),
                ..Default::default()
            },
            HookResult::Block { reason } => HookOutput {
                should_continue: false,
                decision: Some("block".to_string()),
                block_reason: Some(reason),
                ..Default::default()
            },
            HookResult::ModifyInput { new_input } => HookOutput {
                should_continue: true,
                decision: Some("approve".to_string()),
                modified_input: Some(new_input),
                ..Default::default()
            },
            HookResult::InjectContext { context } => HookOutput {
                should_continue: true,
                decision: Some("approve".to_string()),
                additional_context: Some(context),
                ..Default::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ========================================================================
    // HookResult Tests
    // ========================================================================

    #[test]
    fn test_hook_result_default() {
        let result = HookResult::default();
        assert!(matches!(result, HookResult::Continue));
    }

    #[test]
    fn test_hook_result_block() {
        let result = HookResult::Block {
            reason: "Test reason".to_string(),
        };
        if let HookResult::Block { reason } = result {
            assert_eq!(reason, "Test reason");
        } else {
            panic!("Expected Block variant");
        }
    }

    #[test]
    fn test_hook_result_modify_input() {
        let new_input = json!({"key": "value"});
        let result = HookResult::ModifyInput {
            new_input: new_input.clone(),
        };
        if let HookResult::ModifyInput { new_input: val } = result {
            assert_eq!(val, new_input);
        } else {
            panic!("Expected ModifyInput variant");
        }
    }

    #[test]
    fn test_hook_result_inject_context() {
        let result = HookResult::InjectContext {
            context: "Extra context".to_string(),
        };
        if let HookResult::InjectContext { context } = result {
            assert_eq!(context, "Extra context");
        } else {
            panic!("Expected InjectContext variant");
        }
    }

    // ========================================================================
    // HookEventType Tests
    // ========================================================================

    #[test]
    fn test_hook_event_type_serialization() {
        assert_eq!(
            serde_json::to_string(&HookEventType::PreToolUse).unwrap(),
            "\"PreToolUse\""
        );
        assert_eq!(
            serde_json::to_string(&HookEventType::PostToolUse).unwrap(),
            "\"PostToolUse\""
        );
        assert_eq!(
            serde_json::to_string(&HookEventType::SessionStart).unwrap(),
            "\"SessionStart\""
        );
        assert_eq!(
            serde_json::to_string(&HookEventType::EvalGate).unwrap(),
            "\"EvalGate\""
        );
    }

    #[test]
    fn test_hook_event_type_deserialization() {
        assert_eq!(
            serde_json::from_str::<HookEventType>("\"PreToolUse\"").unwrap(),
            HookEventType::PreToolUse
        );
        assert_eq!(
            serde_json::from_str::<HookEventType>("\"SubagentStart\"").unwrap(),
            HookEventType::SubagentStart
        );
        assert_eq!(
            serde_json::from_str::<HookEventType>("\"PermissionRequest\"").unwrap(),
            HookEventType::PermissionRequest
        );
    }

    #[test]
    fn test_hook_event_type_equality() {
        assert_eq!(HookEventType::PreToolUse, HookEventType::PreToolUse);
        assert_ne!(HookEventType::PreToolUse, HookEventType::PostToolUse);
    }

    // ========================================================================
    // HookOutput Tests
    // ========================================================================

    #[test]
    fn test_hook_output_default() {
        let output = HookOutput::default();
        assert!(!output.should_continue);
        assert!(output.decision.is_none());
        assert!(output.block_reason.is_none());
    }

    #[test]
    fn test_hook_output_from_continue() {
        let output = HookOutput::from(HookResult::Continue);
        assert!(output.should_continue);
        assert_eq!(output.decision.as_deref(), Some("approve"));
        assert!(output.block_reason.is_none());
    }

    #[test]
    fn test_hook_output_from_block() {
        let output = HookOutput::from(HookResult::Block {
            reason: "Not allowed".to_string(),
        });
        assert!(!output.should_continue);
        assert_eq!(output.decision.as_deref(), Some("block"));
        assert_eq!(output.block_reason.as_deref(), Some("Not allowed"));
    }

    #[test]
    fn test_hook_output_from_modify_input() {
        let new_input = json!({"modified": true});
        let output = HookOutput::from(HookResult::ModifyInput {
            new_input: new_input.clone(),
        });
        assert!(output.should_continue);
        assert_eq!(output.decision.as_deref(), Some("approve"));
        assert_eq!(output.modified_input, Some(new_input));
    }

    #[test]
    fn test_hook_output_from_inject_context() {
        let output = HookOutput::from(HookResult::InjectContext {
            context: "Injected".to_string(),
        });
        assert!(output.should_continue);
        assert_eq!(output.decision.as_deref(), Some("approve"));
        assert_eq!(output.additional_context.as_deref(), Some("Injected"));
    }

    #[test]
    fn test_hook_output_serialization() {
        let output = HookOutput {
            should_continue: true,
            decision: Some("approve".to_string()),
            additional_context: None,
            block_reason: None,
            modified_input: None,
        };
        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["continue"], true);
        assert_eq!(json["decision"], "approve");
        // None fields should be skipped
        assert!(json.get("blockReason").is_none());
    }

    // ========================================================================
    // Input Types Serialization Tests
    // ========================================================================

    #[test]
    fn test_pre_tool_use_input_serialization() {
        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/home/user".to_string(),
            session_id: Some("sess-123".to_string()),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            tool_name: "bash".to_string(),
            tool_call_id: "call-456".to_string(),
            tool_input: json!({"command": "ls"}),
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["hook_event_name"], "PreToolUse");
        assert_eq!(json["tool_name"], "bash");
        assert_eq!(json["tool_input"]["command"], "ls");
    }

    #[test]
    fn test_post_tool_use_input_serialization() {
        let input = PostToolUseInput {
            hook_event_name: "PostToolUse".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            tool_name: "read".to_string(),
            tool_call_id: "call-789".to_string(),
            tool_input: json!({"path": "/tmp/file"}),
            tool_output: "file contents".to_string(),
            is_error: false,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["tool_output"], "file contents");
        assert_eq!(json["is_error"], false);
    }

    #[test]
    fn test_session_end_input_serialization() {
        let input = SessionEndInput {
            hook_event_name: "SessionEnd".to_string(),
            cwd: "/home/user".to_string(),
            session_id: Some("sess-123".to_string()),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            reason: "user_exit".to_string(),
            duration_ms: 5000,
            turn_count: 10,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["duration_ms"], 5000);
        assert_eq!(json["turn_count"], 10);
    }

    #[test]
    fn test_overflow_input_serialization() {
        let input = OverflowInput {
            hook_event_name: "Overflow".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            token_count: 150_000,
            max_tokens: 128_000,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["token_count"], 150_000);
        assert_eq!(json["max_tokens"], 128_000);
    }

    #[test]
    fn test_on_error_input_serialization() {
        let input = OnErrorInput {
            hook_event_name: "OnError".to_string(),
            cwd: "/home/user".to_string(),
            session_id: Some("sess-123".to_string()),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            error: "Connection failed".to_string(),
            error_kind: "NetworkError".to_string(),
            context: Some("API call".to_string()),
            recoverable: true,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["error"], "Connection failed");
        assert_eq!(json["error_kind"], "NetworkError");
        assert_eq!(json["recoverable"], true);
    }

    #[test]
    fn test_subagent_stop_input_serialization() {
        let input = SubagentStopInput {
            hook_event_name: "SubagentStop".to_string(),
            cwd: "/home/user".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            subagent_type: "explorer".to_string(),
            subagent_id: "agent-001".to_string(),
            result: Some("Found 5 files".to_string()),
            duration_ms: 1500,
            success: true,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["subagent_type"], "explorer");
        assert_eq!(json["success"], true);
        assert_eq!(json["duration_ms"], 1500);
    }
}

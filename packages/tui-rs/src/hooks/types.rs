//! Hook types and traits
//!
//! Defines the core types for the hook system including:
//! - Hook event types (PreToolUse, PostToolUse, etc.)
//! - Hook result types (Continue, Block, Modify)
//! - Traits for implementing hooks

use serde::{Deserialize, Serialize};

/// Result of a hook execution
///
/// Hooks return this to indicate how processing should continue.
#[derive(Debug, Clone)]
pub enum HookResult {
    /// Continue with normal execution
    Continue,

    /// Block the operation with a reason
    Block { reason: String },

    /// Continue but with modified input
    ModifyInput { new_input: serde_json::Value },

    /// Continue but inject additional context
    InjectContext { context: String },
}

impl Default for HookResult {
    fn default() -> Self {
        HookResult::Continue
    }
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
    UserPromptSubmit,
    PreCompact,
    Notification,
    Overflow,
}

/// Input data for PreToolUse hooks
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

/// Input data for PostToolUse hooks
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

/// Input data for SessionStart hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStartInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub source: String,
}

/// Input data for SessionEnd hooks
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

/// Trait for PreToolUse hooks
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

/// Trait for PostToolUse hooks
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

/// Trait for SessionStart hooks
pub trait SessionStartHook: Send + Sync {
    fn on_session_start(&self, input: &SessionStartInput) -> HookResult;
}

/// Trait for SessionEnd hooks
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

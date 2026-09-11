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
    PostCompact,
    Notification,
    Overflow,
    StopFailure,
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
    /// Wall-clock time the tool itself took, in milliseconds.
    ///
    /// Part of the documented contract (`docs/design/HOOKS_SYSTEM.md`), which
    /// publishes it as `durationMs`. Measured around the execution only, so it
    /// excludes the hook dispatch that reports it.
    pub duration_ms: u64,
}

/// Input data for `SessionStart` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStartInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// Input data for `SessionEnd` hooks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEndInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    /// Absolute path to the canonical Maestro JSONL for this session.
    ///
    /// Lifecycle adapters use this path for observation-only transcript
    /// capture. It is never a continuation or restore authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
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

/// Input data for StopFailure hooks
///
/// Called when recovery cannot produce a valid completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopFailureInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub error: String,
    pub error_details: Option<String>,
    pub last_assistant_message: Option<String>,
}

/// Input data for `UserPromptSubmit` hooks
///
/// Called when the user submits a prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPromptSubmitInput {
    pub hook_event_name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// The user's prompt text
    pub prompt: String,
    /// Number of attachments included with the prompt
    pub attachment_count: u32,
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
    /// Absolute path to the canonical Maestro JSONL after this completed turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// File size observed before this response was persisted. Capture adapters
    /// wait for the JSONL to grow past this boundary before reading it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_size_before: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
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

/// Trait for StopFailure hooks
///
/// Called when recovery cannot produce a valid completion.
pub trait StopFailureHook: Send + Sync {
    /// Called when recovery ends without a valid assistant completion
    ///
    /// # Returns
    /// A `HookResult` - typically Continue so the caller can surface the failure.
    fn on_stop_failure(&self, input: &StopFailureInput) -> HookResult;
}

/// Trait for `UserPromptSubmit` hooks
///
/// Called when the user submits a prompt.
pub trait UserPromptSubmitHook: Send + Sync {
    /// Called when user submits a prompt
    ///
    /// # Returns
    /// - `Continue`: Proceed normally
    /// - `Block`: Prevent sending the prompt
    /// - `ModifyInput`: Modify the prompt content
    /// - `InjectContext`: Add context to the prompt
    fn on_user_prompt_submit(&self, input: &UserPromptSubmitInput) -> HookResult;
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

/// Permission decision an external hook may return.
///
/// Only `allow`, `deny`, or `ask` are accepted; every other value is rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookPermission {
    Allow,
    Deny,
    Ask,
}

impl HookPermission {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }
}

/// The permission values a hook event accepts.
///
/// The accepted domain follows each hook step: `beforeReadFile` accepts only
/// `allow`/`deny` while `preToolUse` also accepts `ask`.
///
/// - `PreToolUse` and `PermissionRequest` reach an approval decision, so all
///   three values are in domain. `Ask` is still refused at execution time
///   because an external hook has no interactive path, but it is a legal
///   value for a Claude-Code-compatible hook to return.
/// - Events that can refuse an operation but never prompt accept `allow` and
///   `deny` only.
/// - Lifecycle and notification events have no permission concept, so any
///   `permissionDecision` on them is a configuration error.
#[must_use]
pub fn permission_domain(event: HookEventType) -> &'static [HookPermission] {
    use HookEventType as E;
    use HookPermission as P;
    match event {
        E::PreToolUse | E::PermissionRequest => &[P::Allow, P::Deny, P::Ask],
        E::PostToolUse
        | E::PostToolUseFailure
        | E::UserPromptSubmit
        | E::PreMessage
        | E::PostMessage
        | E::EvalGate
        | E::SubagentStart
        | E::Overflow
        | E::StopFailure
        | E::OnError => &[P::Allow, P::Deny],
        E::SessionStart
        | E::SessionEnd
        | E::SessionSwitch
        | E::SessionBeforeTree
        | E::SessionTree
        | E::PreCompact
        | E::PostCompact
        | E::Notification
        | E::SubagentStop
        | E::Branch => &[],
    }
}

/// The coarse `decision` field of a hook response.
///
/// This is Maestro's older flat refusal channel, kept because shipped hooks
/// use it. The value domain is now closed: an unrecognised decision string is
/// a schema error instead of being silently treated as "approve".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookDecision {
    #[serde(alias = "allow", alias = "continue")]
    Approve,
    #[serde(alias = "deny", alias = "reject")]
    Block,
    Skip,
}

/// One EvalGate assertion inside a hook response.
///
/// Unknown keys are tolerated here on purpose: assertion objects carry
/// evaluator-specific annotations, and the fields below are the only ones the
/// gate decision reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalAssertion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

/// The `hookSpecificOutput` envelope documented in
/// `docs/design/HOOKS_SYSTEM.md`, "Hook Output Format".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookSpecificOutput {
    #[serde(
        default,
        alias = "hook_event_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub hook_event_name: Option<HookEventType>,

    #[serde(
        default,
        alias = "permission_decision",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_decision: Option<HookPermission>,

    #[serde(
        default,
        alias = "permission_decision_reason",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_decision_reason: Option<String>,

    #[serde(
        default,
        alias = "modified_input",
        alias = "updatedInput",
        alias = "updated_input",
        skip_serializing_if = "Option::is_none"
    )]
    pub modified_input: Option<serde_json::Value>,

    #[serde(
        default,
        alias = "context_to_add",
        skip_serializing_if = "Option::is_none"
    )]
    pub context_to_add: Option<String>,

    #[serde(
        default,
        alias = "additional_context",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional_context: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertions: Option<Vec<EvalAssertion>>,
}

fn default_should_continue() -> bool {
    true
}

/// Output format for hooks (JSON-compatible with `TypeScript`)
///
/// This is both what Maestro writes for downstream consumers and the schema an
/// external hook's stdout is deserialized into. `deny_unknown_fields` is what
/// makes a misspelled key (`modifedInput`, `permissionDecison`) a reported
/// error rather than a silently ignored field.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookOutput {
    /// Whether to continue processing
    #[serde(rename = "continue", default = "default_should_continue")]
    pub should_continue: bool,

    /// Decision type
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<HookDecision>,

    /// Additional context to inject
    #[serde(
        default,
        alias = "additionalContext",
        alias = "context",
        alias = "contextToAdd",
        alias = "context_to_add",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional_context: Option<String>,

    /// Reason for blocking
    #[serde(
        default,
        alias = "blockReason",
        alias = "reason",
        alias = "message",
        skip_serializing_if = "Option::is_none"
    )]
    pub block_reason: Option<String>,

    /// Modified input
    #[serde(
        default,
        alias = "modifiedInput",
        alias = "modify_input",
        alias = "updatedInput",
        alias = "updated_input",
        skip_serializing_if = "Option::is_none"
    )]
    pub modified_input: Option<serde_json::Value>,

    /// The documented per-event envelope.
    #[serde(
        default,
        rename = "hookSpecificOutput",
        alias = "hook_specific_output",
        skip_serializing_if = "Option::is_none"
    )]
    pub hook_specific_output: Option<HookSpecificOutput>,

    /// Flat refusal alias predating `decision`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertions: Option<Vec<EvalAssertion>>,
}

fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

impl HookOutput {
    /// Check this output against the domain of `event` and reduce it to a
    /// [`HookResult`].
    ///
    /// Returns `Err` when the response is well-formed JSON but illegal for the
    /// event: a permission value outside [`permission_domain`], a
    /// `modifiedInput` on an event that cannot rewrite tool input, or a
    /// `modifiedInput` that is not a JSON object.
    ///
    /// # Errors
    ///
    /// Returns an error describing the first domain violation found.
    pub fn validate_for(&self, event: HookEventType) -> anyhow::Result<HookResult> {
        let specific = self.hook_specific_output.as_ref();
        if let Some(declared_event) = specific.and_then(|specific| specific.hook_event_name) {
            anyhow::ensure!(
                declared_event == event,
                "hookEventName {declared_event:?} does not match dispatched event {event:?}"
            );
        }
        let permission = specific.and_then(|specific| specific.permission_decision);

        if let Some(permission) = permission {
            let domain = permission_domain(event);
            if !domain.contains(&permission) {
                let allowed = if domain.is_empty() {
                    "no permissionDecision at all".to_string()
                } else {
                    domain
                        .iter()
                        .map(|value| value.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                anyhow::bail!(
                    "permissionDecision \"{}\" is not valid for {event:?}, which accepts {allowed}",
                    permission.as_str()
                );
            }
        }

        let modified_input = specific
            .and_then(|specific| specific.modified_input.clone())
            .or_else(|| self.modified_input.clone());
        if let Some(input) = modified_input.as_ref() {
            anyhow::ensure!(
                event == HookEventType::PreToolUse,
                "modifiedInput is only valid for PreToolUse, not {event:?}"
            );
            anyhow::ensure!(
                input.is_object(),
                "modifiedInput must be a JSON object, got {}",
                json_type_name(input)
            );
        }

        let denied = self.block == Some(true)
            || self.decision == Some(HookDecision::Block)
            || permission == Some(HookPermission::Deny)
            || !self.should_continue;
        // `permissionDecision: "ask"` asks a human to decide. External hooks
        // have no interactive path in the Rust TUI, so the operation is
        // refused rather than silently allowed.
        let confirmation_requested = permission == Some(HookPermission::Ask);
        if denied || confirmation_requested {
            let fallback = if denied {
                "Blocked by external hook"
            } else {
                "External hook requested confirmation, which external hooks cannot prompt for"
            };
            let reason = specific
                .and_then(|specific| specific.permission_decision_reason.as_deref())
                .or(self.block_reason.as_deref())
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .unwrap_or(fallback);
            return Ok(HookResult::Block {
                reason: reason.to_string(),
            });
        }

        if let Some(new_input) = modified_input {
            return Ok(HookResult::ModifyInput { new_input });
        }

        if let Some(context) = specific
            .and_then(|specific| specific.context_to_add.clone())
            .or_else(|| specific.and_then(|specific| specific.additional_context.clone()))
            .or_else(|| self.additional_context.clone())
            .map(|context| context.trim().to_string())
            .filter(|context| !context.is_empty())
        {
            return Ok(HookResult::InjectContext { context });
        }

        Ok(self.eval_gate_result())
    }

    /// EvalGate structured outcomes (`docs/design/HOOKS_SYSTEM.md`).
    ///
    /// A failed evaluation becomes `Block` so the tool result is reported as
    /// failed; a successful score or rationale is injected as context.
    fn eval_gate_result(&self) -> HookResult {
        let specific = self.hook_specific_output.as_ref();
        let passed = specific
            .and_then(|specific| specific.passed)
            .or(self.passed);
        let score = specific.and_then(|specific| specific.score).or(self.score);
        let threshold = specific
            .and_then(|specific| specific.threshold)
            .or(self.threshold);
        let rationale = specific
            .and_then(|specific| specific.rationale.as_deref())
            .or(self.rationale.as_deref())
            .map(str::trim)
            .filter(|rationale| !rationale.is_empty());
        let assertions = specific
            .and_then(|specific| specific.assertions.as_deref())
            .or(self.assertions.as_deref());
        let assertion_failed = assertions.is_some_and(|items| {
            items.iter().any(|item| {
                item.passed == Some(false)
                    || match (item.score, item.threshold) {
                        (Some(score), Some(threshold)) => score < threshold,
                        _ => false,
                    }
            })
        });
        let score_below_threshold = match (score, threshold) {
            (Some(score), Some(threshold)) => score < threshold,
            _ => false,
        };
        if matches!(passed, Some(false)) || score_below_threshold || assertion_failed {
            let reason = rationale
                .map(str::to_owned)
                .or_else(|| match (score, threshold) {
                    (Some(score), Some(threshold)) => {
                        Some(format!("score {score} below threshold {threshold}"))
                    }
                    _ if assertion_failed => Some("EvalGate assertion failed".to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| "EvalGate failed".to_string());
            return HookResult::Block { reason };
        }
        if passed == Some(true) || score.is_some() || assertions.is_some() {
            let mut parts = Vec::new();
            if let Some(score) = score {
                if let Some(threshold) = threshold {
                    parts.push(format!("eval score {score} (threshold {threshold})"));
                } else {
                    parts.push(format!("eval score {score}"));
                }
            } else if passed == Some(true) {
                parts.push("eval passed".to_string());
            }
            if let Some(rationale) = rationale {
                parts.push(rationale.to_owned());
            }
            if !parts.is_empty() {
                return HookResult::InjectContext {
                    context: parts.join(": "),
                };
            }
        }
        HookResult::Continue
    }
}

impl From<HookResult> for HookOutput {
    fn from(result: HookResult) -> Self {
        match result {
            HookResult::Continue => HookOutput {
                should_continue: true,
                decision: Some(HookDecision::Approve),
                ..Default::default()
            },
            HookResult::Block { reason } => HookOutput {
                should_continue: false,
                decision: Some(HookDecision::Block),
                block_reason: Some(reason),
                ..Default::default()
            },
            HookResult::ModifyInput { new_input } => HookOutput {
                should_continue: true,
                decision: Some(HookDecision::Approve),
                modified_input: Some(new_input),
                ..Default::default()
            },
            HookResult::InjectContext { context } => HookOutput {
                should_continue: true,
                decision: Some(HookDecision::Approve),
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
        assert_eq!(
            serde_json::to_string(&HookEventType::PostCompact).unwrap(),
            "\"PostCompact\""
        );
        assert_eq!(
            serde_json::to_string(&HookEventType::StopFailure).unwrap(),
            "\"StopFailure\""
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
        assert_eq!(
            serde_json::from_str::<HookEventType>("\"PostCompact\"").unwrap(),
            HookEventType::PostCompact
        );
        assert_eq!(
            serde_json::from_str::<HookEventType>("\"StopFailure\"").unwrap(),
            HookEventType::StopFailure
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
        assert_eq!(output.decision, Some(HookDecision::Approve));
        assert!(output.block_reason.is_none());
    }

    #[test]
    fn test_hook_output_from_block() {
        let output = HookOutput::from(HookResult::Block {
            reason: "Not allowed".to_string(),
        });
        assert!(!output.should_continue);
        assert_eq!(output.decision, Some(HookDecision::Block));
        assert_eq!(output.block_reason.as_deref(), Some("Not allowed"));
    }

    #[test]
    fn test_hook_output_from_modify_input() {
        let new_input = json!({"modified": true});
        let output = HookOutput::from(HookResult::ModifyInput {
            new_input: new_input.clone(),
        });
        assert!(output.should_continue);
        assert_eq!(output.decision, Some(HookDecision::Approve));
        assert_eq!(output.modified_input, Some(new_input));
    }

    #[test]
    fn test_hook_output_from_inject_context() {
        let output = HookOutput::from(HookResult::InjectContext {
            context: "Injected".to_string(),
        });
        assert!(output.should_continue);
        assert_eq!(output.decision, Some(HookDecision::Approve));
        assert_eq!(output.additional_context.as_deref(), Some("Injected"));
    }

    #[test]
    fn test_hook_output_serialization() {
        let output = HookOutput {
            should_continue: true,
            decision: Some(HookDecision::Approve),
            ..Default::default()
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
    fn test_stop_failure_input_serialization() {
        let input = StopFailureInput {
            hook_event_name: "StopFailure".to_string(),
            cwd: "/home/user".to_string(),
            session_id: Some("sess-123".to_string()),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            error: "max_output_tokens".to_string(),
            error_details: Some("Continuation budget exhausted".to_string()),
            last_assistant_message: Some("Partial response".to_string()),
        };

        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["hook_event_name"], "StopFailure");
        assert_eq!(json["error"], "max_output_tokens");
        assert_eq!(json["error_details"], "Continuation budget exhausted");
        assert_eq!(json["last_assistant_message"], "Partial response");
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
            duration_ms: 250,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["tool_output"], "file contents");
        assert_eq!(json["is_error"], false);
        assert_eq!(json["duration_ms"], 250);
    }

    #[test]
    fn test_session_end_input_serialization() {
        let input = SessionEndInput {
            hook_event_name: "SessionEnd".to_string(),
            cwd: "/home/user".to_string(),
            session_id: Some("sess-123".to_string()),
            transcript_path: None,
            organization_id: None,
            workspace_id: None,
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

    // ========================================================================
    // Typed hook-output schema tests
    // ========================================================================

    const ALL_EVENTS: &[HookEventType] = &[
        HookEventType::PreToolUse,
        HookEventType::PostToolUse,
        HookEventType::PostToolUseFailure,
        HookEventType::SessionStart,
        HookEventType::SessionEnd,
        HookEventType::SessionSwitch,
        HookEventType::SessionBeforeTree,
        HookEventType::SessionTree,
        HookEventType::UserPromptSubmit,
        HookEventType::PreCompact,
        HookEventType::PostCompact,
        HookEventType::Notification,
        HookEventType::Overflow,
        HookEventType::StopFailure,
        HookEventType::PreMessage,
        HookEventType::PostMessage,
        HookEventType::OnError,
        HookEventType::EvalGate,
        HookEventType::SubagentStart,
        HookEventType::SubagentStop,
        HookEventType::PermissionRequest,
        HookEventType::Branch,
    ];

    fn parse_output(json: serde_json::Value) -> Result<HookOutput, serde_json::Error> {
        serde_json::from_value(json)
    }

    #[test]
    fn every_event_rejects_out_of_domain_permission() {
        for &event in ALL_EVENTS {
            let domain = permission_domain(event);
            for permission in [
                HookPermission::Allow,
                HookPermission::Deny,
                HookPermission::Ask,
            ] {
                let output = parse_output(json!({
                    "hookSpecificOutput": { "permissionDecision": permission.as_str() }
                }))
                .expect("permission value should deserialize");
                let outcome = output.validate_for(event);
                if domain.contains(&permission) {
                    assert!(
                        outcome.is_ok(),
                        "{event:?} should accept {}",
                        permission.as_str()
                    );
                } else {
                    let error = outcome
                        .expect_err(&format!("{event:?} must reject {}", permission.as_str()));
                    assert!(
                        error.to_string().contains(permission.as_str()),
                        "error should name the rejected value: {error}"
                    );
                }
            }
        }
    }

    #[test]
    fn unknown_permission_value_is_a_schema_error() {
        let error = parse_output(json!({
            "hookSpecificOutput": { "permissionDecision": "maybe" }
        }))
        .expect_err("unknown permission value must not deserialize");
        assert!(error.to_string().contains("maybe"), "{error}");
    }

    #[test]
    fn unknown_top_level_key_is_rejected() {
        let error = parse_output(json!({ "modifedInput": { "command": "ls" } }))
            .expect_err("misspelled key must be rejected");
        assert!(error.to_string().contains("modifedInput"), "{error}");
    }

    #[test]
    fn unknown_hook_specific_key_is_rejected() {
        let error = parse_output(json!({
            "hookSpecificOutput": { "permissionDecison": "deny" }
        }))
        .expect_err("misspelled envelope key must be rejected");
        assert!(error.to_string().contains("permissionDecison"), "{error}");
    }

    #[test]
    fn unknown_decision_value_is_rejected() {
        let error = parse_output(json!({ "decision": "maybe" }))
            .expect_err("unknown decision must be rejected");
        assert!(error.to_string().contains("maybe"), "{error}");
    }

    #[test]
    fn documented_skip_decision_continues() {
        let output = parse_output(json!({ "decision": "skip" })).unwrap();
        assert_eq!(output.decision, Some(HookDecision::Skip));
        assert!(matches!(
            output.validate_for(HookEventType::PreToolUse).unwrap(),
            HookResult::Continue
        ));
    }

    #[test]
    fn hook_event_name_must_match_dispatched_event() {
        let output = parse_output(json!({
            "hookSpecificOutput": { "hookEventName": "PostToolUse" }
        }))
        .unwrap();
        let error = output
            .validate_for(HookEventType::PreToolUse)
            .expect_err("a mismatched event envelope must be rejected");
        assert!(error.to_string().contains("PostToolUse"), "{error}");
        assert!(error.to_string().contains("PreToolUse"), "{error}");
    }

    #[test]
    fn unknown_hook_event_name_is_a_schema_error() {
        let error = parse_output(json!({
            "hookSpecificOutput": { "hookEventName": "BeforeLunch" }
        }))
        .expect_err("an unknown event discriminator must be rejected");
        assert!(error.to_string().contains("BeforeLunch"), "{error}");
    }

    #[test]
    fn modified_input_is_pre_tool_use_only_and_must_be_an_object() {
        let output = parse_output(json!({ "modifiedInput": { "command": "ls" } })).unwrap();
        assert!(matches!(
            output.validate_for(HookEventType::PreToolUse).unwrap(),
            HookResult::ModifyInput { .. }
        ));

        let error = output
            .validate_for(HookEventType::PostToolUse)
            .expect_err("PostToolUse cannot rewrite tool input");
        assert!(error.to_string().contains("PreToolUse"), "{error}");

        let scalar = parse_output(json!({ "modifiedInput": "rm -rf /" })).unwrap();
        let error = scalar
            .validate_for(HookEventType::PreToolUse)
            .expect_err("a non-object modifiedInput must be rejected");
        assert!(error.to_string().contains("JSON object"), "{error}");
    }

    #[test]
    fn missing_continue_defaults_to_true() {
        let output = parse_output(json!({})).unwrap();
        assert!(output.should_continue);
        assert!(matches!(
            output.validate_for(HookEventType::PreToolUse).unwrap(),
            HookResult::Continue
        ));
    }

    #[test]
    fn deny_carries_its_reason() {
        let output = parse_output(json!({
            "hookSpecificOutput": {
                "permissionDecision": "deny",
                "permissionDecisionReason": "writes outside the workspace"
            }
        }))
        .unwrap();
        match output.validate_for(HookEventType::PreToolUse).unwrap() {
            HookResult::Block { reason } => assert_eq!(reason, "writes outside the workspace"),
            other => panic!("expected Block, got {other:?}"),
        }
    }
}

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

use crate::tools::{
    BashDetails, GlobDetails, GrepDetails, ImageDetails, ListDetails, ToolDetails, WebFetchDetails,
};
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
    /// will clean up and send a `ResponseEnd` event.
    Cancel,

    /// Shutdown the agent gracefully
    ///
    /// Requests the agent to terminate. Currently unused (agent shuts down when
    /// the command channel closes).
    Shutdown,
}

/// Model-safe output emitted by a completed tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ToolOutput(String);

impl ToolOutput {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

/// Classified failure returned by a tool invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolError {
    Validation { message: String },
    Execution { message: String },
    Transport { message: String },
}

impl ToolError {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Validation { message }
            | Self::Execution { message }
            | Self::Transport { message } => message,
        }
    }
}

/// Reason a requested tool was not allowed to execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DenialReason {
    User,
    SandboxPolicy { message: String },
    ActionFirewall { message: String },
}

impl DenialReason {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::User => "Tool call was denied by user",
            Self::SandboxPolicy { message } | Self::ActionFirewall { message } => message,
        }
    }
}

/// Stage at which a tool invocation was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Queued,
    Running,
}

/// The semantic result of a tool invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolOutcome {
    Succeeded {
        output: ToolOutput,
    },
    Failed {
        error: ToolError,
        #[serde(skip_serializing_if = "Option::is_none")]
        partial_output: Option<ToolOutput>,
    },
    Denied {
        reason: DenialReason,
    },
    Cancelled {
        phase: ExecutionPhase,
    },
    /// The local executor stopped without learning whether a remote write committed.
    /// Callers must reconcile the remote operation before retrying.
    Indeterminate {
        reason: String,
    },
}

/// Lifecycle classification persisted with a receipt without duplicating tool output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExecutionStatus {
    Succeeded,
    Failed,
    Denied,
    Cancelled { phase: ExecutionPhase },
    Indeterminate,
}

impl ToolOutcome {
    #[must_use]
    pub fn status(&self) -> ExecutionStatus {
        match self {
            Self::Succeeded { .. } => ExecutionStatus::Succeeded,
            Self::Failed { .. } => ExecutionStatus::Failed,
            Self::Denied { .. } => ExecutionStatus::Denied,
            Self::Cancelled { phase } => ExecutionStatus::Cancelled { phase: *phase },
            Self::Indeterminate { .. } => ExecutionStatus::Indeterminate,
        }
    }
}

/// Where the result was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionSource {
    Native,
    RemoteClient,
    Cache,
}

/// Typed evidence captured for an execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "details", rename_all = "snake_case")]
pub enum ToolReceiptDetails {
    BuiltIn(ToolDetails),
    Mcp {
        server: String,
        tool: String,
        is_error: bool,
    },
    Cached,
    None,
}

/// Audit information that must not be sent as provider tool-result content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReceipt {
    pub call_id: String,
    pub tool_name: String,
    pub source: ExecutionSource,
    pub status: ExecutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub details: ToolReceiptDetails,
}

/// Typed internal result used by native execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecution {
    pub outcome: ToolOutcome,
    pub receipt: ExecutionReceipt,
}

impl ToolExecution {
    #[must_use]
    pub fn denied(
        call_id: impl Into<String>,
        tool_name: impl Into<String>,
        reason: DenialReason,
    ) -> Self {
        let outcome = ToolOutcome::Denied { reason };
        Self {
            outcome: outcome.clone(),
            receipt: ExecutionReceipt {
                call_id: call_id.into(),
                tool_name: tool_name.into(),
                source: ExecutionSource::Native,
                status: outcome.status(),
                duration_ms: Some(0),
                details: ToolReceiptDetails::None,
            },
        }
    }

    #[must_use]
    pub fn from_legacy(
        call_id: impl Into<String>,
        tool_name: impl Into<String>,
        source: ExecutionSource,
        result: ToolResult,
    ) -> Self {
        let call_id = call_id.into();
        let tool_name = tool_name.into();
        let details = receipt_details(&tool_name, result.details.as_ref());
        let cancelled = result.details.as_ref().is_some_and(|details| {
            details
                .get("cancelled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        });
        let remote_outcome_unknown = result.details.as_ref().is_some_and(|details| {
            details
                .get("remoteOutcome")
                .and_then(serde_json::Value::as_str)
                == Some("unknown")
        });
        let outcome = if remote_outcome_unknown {
            ToolOutcome::Indeterminate {
                reason: result.error.unwrap_or_else(|| {
                    "Remote write outcome is unknown and requires reconciliation".to_string()
                }),
            }
        } else if cancelled {
            ToolOutcome::Cancelled {
                phase: ExecutionPhase::Running,
            }
        } else if result.success && result.error.is_none() {
            ToolOutcome::Succeeded {
                output: ToolOutput::new(result.output),
            }
        } else if let Some(error) = result.error {
            ToolOutcome::Failed {
                error: legacy_error(&error),
                partial_output: (!result.output.is_empty()).then(|| ToolOutput::new(result.output)),
            }
        } else {
            ToolOutcome::Failed {
                error: ToolError::Execution {
                    message: "Tool returned an unsuccessful result without an error".to_string(),
                },
                partial_output: (!result.output.is_empty()).then(|| ToolOutput::new(result.output)),
            }
        };

        Self {
            outcome: outcome.clone(),
            receipt: ExecutionReceipt {
                call_id,
                tool_name,
                source,
                status: outcome.status(),
                duration_ms: None,
                details,
            },
        }
    }

    #[must_use]
    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.receipt.duration_ms = Some(duration_ms);
        self
    }

    #[must_use]
    pub fn cancelled(
        call_id: impl Into<String>,
        tool_name: impl Into<String>,
        source: ExecutionSource,
        phase: ExecutionPhase,
    ) -> Self {
        let outcome = ToolOutcome::Cancelled { phase };
        Self {
            outcome: outcome.clone(),
            receipt: ExecutionReceipt {
                call_id: call_id.into(),
                tool_name: tool_name.into(),
                source,
                status: outcome.status(),
                duration_ms: Some(0),
                details: ToolReceiptDetails::None,
            },
        }
    }

    /// Convert to the compatibility DTO used by existing headless clients.
    #[must_use]
    pub fn to_legacy(&self) -> ToolResult {
        let details = match &self.receipt.details {
            ToolReceiptDetails::BuiltIn(details) => Some(details.to_json()),
            ToolReceiptDetails::Mcp {
                server,
                tool,
                is_error,
            } => Some(serde_json::json!({"server": server, "tool": tool, "isError": is_error})),
            ToolReceiptDetails::Cached | ToolReceiptDetails::None => None,
        };
        match &self.outcome {
            ToolOutcome::Succeeded { output } => ToolResult {
                success: true,
                output: output.as_str().to_string(),
                error: None,
                details,
            },
            ToolOutcome::Failed {
                error,
                partial_output,
            } => ToolResult {
                success: false,
                output: partial_output
                    .as_ref()
                    .map_or_else(String::new, |output| output.as_str().to_string()),
                error: Some(error.message().to_string()),
                details,
            },
            ToolOutcome::Denied { reason } => ToolResult::failure(reason.message()),
            ToolOutcome::Cancelled { phase } => {
                let message = if matches!(
                    &self.receipt.details,
                    ToolReceiptDetails::BuiltIn(ToolDetails::Bash(_))
                ) {
                    "Command cancelled".to_string()
                } else {
                    format!("Tool execution cancelled during {phase:?}")
                };
                let result = ToolResult::failure(message);
                match details {
                    Some(details) => result.with_details(details),
                    None => result,
                }
            }
            ToolOutcome::Indeterminate { reason } => ToolResult::failure(reason.clone())
                .with_details(serde_json::json!({
                    "remoteOutcome": "unknown",
                    "retryable": false,
                    "requiresReconciliation": true
                })),
        }
    }

    #[must_use]
    pub fn is_error(&self) -> bool {
        !matches!(self.outcome, ToolOutcome::Succeeded { .. })
    }

    #[must_use]
    pub fn model_content(&self) -> String {
        match &self.outcome {
            ToolOutcome::Succeeded { output } => output.as_str().to_string(),
            ToolOutcome::Failed {
                error,
                partial_output: Some(output),
            } => format!(
                "Error: {}\n\nPartial output:\n{}",
                error.message(),
                output.as_str()
            ),
            ToolOutcome::Failed {
                error,
                partial_output: None,
            } => format!("Error: {}", error.message()),
            ToolOutcome::Denied { reason } => reason.message().to_string(),
            ToolOutcome::Cancelled { phase } => {
                format!("Tool execution cancelled during {phase:?}")
            }
            ToolOutcome::Indeterminate { reason } => {
                format!("Indeterminate remote outcome: {reason}. Reconcile before retrying.")
            }
        }
    }
}

fn legacy_error(message: &str) -> ToolError {
    if message.starts_with("Invalid ") {
        ToolError::Validation {
            message: message.to_string(),
        }
    } else if message.starts_with("MCP tool error:") {
        ToolError::Transport {
            message: message.to_string(),
        }
    } else {
        ToolError::Execution {
            message: message.to_string(),
        }
    }
}

fn receipt_details(tool_name: &str, details: Option<&serde_json::Value>) -> ToolReceiptDetails {
    let Some(details) = details else {
        return ToolReceiptDetails::None;
    };

    if let (Some(server), Some(tool), Some(is_error)) = (
        details.get("server").and_then(serde_json::Value::as_str),
        details.get("tool").and_then(serde_json::Value::as_str),
        details.get("isError").and_then(serde_json::Value::as_bool),
    ) {
        return ToolReceiptDetails::Mcp {
            server: server.to_string(),
            tool: tool.to_string(),
            is_error,
        };
    }

    let builtin = match tool_name.to_ascii_lowercase().as_str() {
        "bash" => BashDetails::from_json(details).map(ToolDetails::Bash),
        "read" => serde_json::from_value(details.clone())
            .ok()
            .map(ToolDetails::Read),
        "write" => serde_json::from_value(details.clone())
            .ok()
            .map(ToolDetails::Write),
        "edit" => serde_json::from_value(details.clone())
            .ok()
            .map(ToolDetails::Edit),
        "image" => ImageDetails::from_json(details).map(ToolDetails::Image),
        "webfetch" | "web_fetch" => WebFetchDetails::from_json(details).map(ToolDetails::WebFetch),
        "glob" => GlobDetails::from_json(details).map(ToolDetails::Glob),
        "grep" => GrepDetails::from_json(details).map(ToolDetails::Grep),
        "list" => ListDetails::from_json(details).map(ToolDetails::List),
        _ => ToolDetails::from_json(details),
    };

    builtin.map_or(ToolReceiptDetails::None, ToolReceiptDetails::BuiltIn)
}

/// Legacy wire result of a tool execution.
///
/// Contains the outcome of running a tool (bash, read, write, etc.).
/// Either `success` is true with output, or false with an error message.
///
/// # Examples
///
/// ```
/// use maestro_tui::agent::ToolResult;
///
/// // Successful execution using helper method
/// let result = ToolResult::success("Hello, world!");
/// assert!(result.success);
///
/// // Failed execution using helper method
/// let result = ToolResult::failure("Permission denied");
/// assert!(!result.success);
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

    /// Structured details about the tool execution
    ///
    /// Contains tool-specific metadata like execution time, exit codes,
    /// file paths, etc. Use `serde_json::from_value` to deserialize into
    /// the appropriate detail type (e.g., `BashDetails`, `ReadDetails`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ToolResult {
    /// Create a successful tool result
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            success: true,
            output: output.into(),
            ..Default::default()
        }
    }

    /// Create a failed tool result
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
            ..Default::default()
        }
    }

    /// Add details to the result
    #[must_use]
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.details
            .as_ref()
            .and_then(|details| details.get("cancelled"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}

// ============================================================================
// Messages from Agent to Rust TUI
// ============================================================================

/// Approval-critical inline-tool context captured by the native runner.
///
/// This value crosses only the in-process runner/TUI channel. The containing
/// [`FromAgent::ToolCall`] field is skipped by serde so raw environment values
/// cannot leak into transcripts or protocol logs before display redaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineToolApprovalContext {
    pub command: String,
    pub source_path: String,
    pub source_label: String,
    pub cwd: String,
    pub environment: std::collections::HashMap<String, String>,
    pub shell: String,
    pub shell_arg: String,
}

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
        /// Example: "Anthropic", "`OpenAI`"
        provider: String,
    },

    /// Agent successfully switched models
    ///
    /// Emitted after a model change command has been applied and validated.
    ModelChanged {
        /// The newly active model
        model: String,

        /// Provider name for the active model
        provider: String,
    },

    /// Agent failed to switch models
    ///
    /// Emitted when a model change is rejected by policy or fails to initialize.
    ModelChangeFailed {
        /// The requested model
        model: String,

        /// Failure reason
        reason: String,
    },

    /// Agent started generating a response
    ///
    /// Marks the beginning of a new AI response. The `response_id` can be used
    /// to correlate chunks and the final `ResponseEnd` event.
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
        /// Matches the `response_id` from `ResponseStart`.
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
        /// Matches the `response_id` from `ResponseStart`.
        response_id: String,

        /// Token usage stats
        ///
        /// Optional because some providers don't return usage data.
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

    /// A tool-free side question started outside the main conversation history.
    SideQuestionStart { side_id: String, question: String },

    /// Streaming answer text for a side question.
    SideQuestionChunk { side_id: String, content: String },

    /// A side question completed without changing native conversation history.
    SideQuestionEnd {
        side_id: String,
        question: String,
        answer: String,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

    /// Agent wants to call a tool
    ///
    /// The agent has requested to execute a tool (bash, read, write, etc.).
    /// If `requires_approval` is true, the TUI must respond with a `ToolResponse`.
    ToolCall {
        /// Unique ID for this tool call
        ///
        /// UUID v4 string. Must be used in the `ToolResponse` to identify which
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
        /// If true, the agent will wait for a `ToolResponse` before executing.
        /// If false, the tool is auto-approved and executes immediately.
        requires_approval: bool,

        /// Exact inline-tool context captured before approval was published.
        ///
        /// This is an in-process handoff from the native runner to the TUI so
        /// the approval renders the same environment later checked at the
        /// execution boundary. It is deliberately excluded from serialization:
        /// values are redacted only while building the approval surface.
        #[serde(skip)]
        approval_inline_env: Option<InlineToolApprovalContext>,
    },

    /// Tool execution started (auto-approved or after approval)
    ///
    /// Indicates the tool has begun executing. Useful for showing loading states.
    ToolStart {
        /// Tool call ID
        ///
        /// Matches the `call_id` from `ToolCall`.
        call_id: String,
    },

    /// Tool execution output (streaming)
    ///
    /// Contains stdout/stderr from the tool as it executes. For commands that
    /// produce output incrementally (e.g., long-running bash commands).
    ToolOutput {
        /// Tool call ID
        ///
        /// Matches the `call_id` from `ToolCall`.
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
        /// Matches the `call_id` from `ToolCall`.
        call_id: String,

        /// Whether it succeeded
        ///
        /// True if the tool executed without errors, false otherwise.
        success: bool,

        /// Complete semantic result when the producer owns execution.
        ///
        /// Older and remote producers may omit this; consumers can fall back
        /// to the streamed output and success flag in that case.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,

        /// Typed execution evidence when the producer has it available.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<ExecutionReceipt>,
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

    /// Conversation history was compacted into a summary.
    Compaction {
        /// Generated summary of compacted messages.
        summary: String,

        /// Index of the first transcript entry kept after compaction.
        first_kept_entry_index: usize,

        /// Estimated token count before compaction.
        tokens_before: u64,

        /// Whether this was automatically triggered.
        #[serde(default)]
        auto: bool,

        /// Optional custom instructions used while summarizing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,

        /// RFC 3339 timestamp when compaction occurred.
        timestamp: String,
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
    /// Emitted when a `PreToolUse` hook blocks tool execution. The tool result
    /// will contain an error message, and the model will be informed.
    HookBlocked {
        /// Tool call ID
        ///
        /// Matches the `call_id` from the attempted `ToolCall`.
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
/// use maestro_tui::agent::TokenUsage;
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

    #[test]
    fn test_from_agent_compaction() {
        let json = r###"{"type":"compaction","summary":"## Conversation Summary","first_kept_entry_index":4,"tokens_before":12345,"auto":true,"timestamp":"2026-03-31T12:00:00Z"}"###;
        let msg: FromAgent = serde_json::from_str(json).unwrap();
        assert!(matches!(
            msg,
            FromAgent::Compaction {
                first_kept_entry_index,
                tokens_before,
                auto,
                ..
            } if first_kept_entry_index == 4 && tokens_before == 12345 && auto
        ));
    }

    #[test]
    fn legacy_failure_preserves_partial_output_in_typed_outcome() {
        let execution = ToolExecution::from_legacy(
            "call-1",
            "bash",
            ExecutionSource::Native,
            ToolResult {
                success: false,
                output: "stdout before failure".to_string(),
                error: Some("Exit code: 1".to_string()),
                details: Some(serde_json::json!({
                    "command": "false",
                    "exit_code": 1,
                    "cancelled": false,
                    "truncated": false,
                    "background": false,
                    "required_approval": false,
                })),
            },
        );

        assert!(matches!(
            execution.outcome,
            ToolOutcome::Failed {
                partial_output: Some(_),
                ..
            }
        ));
        assert!(execution.model_content().contains("stdout before failure"));
        assert!(matches!(
            execution.receipt.details,
            ToolReceiptDetails::BuiltIn(ToolDetails::Bash(_))
        ));
    }

    #[test]
    fn legacy_cancellation_becomes_a_typed_running_cancellation() {
        let execution = ToolExecution::from_legacy(
            "call-cancelled",
            "bash",
            ExecutionSource::Native,
            ToolResult {
                success: false,
                output: String::new(),
                error: Some("Command cancelled".to_string()),
                details: Some(serde_json::json!({
                    "command": "sleep 30",
                    "exit_code": 130,
                    "cancelled": true,
                    "truncated": false,
                    "background": false,
                    "required_approval": true,
                })),
            },
        );

        assert_eq!(
            execution.receipt.status,
            ExecutionStatus::Cancelled {
                phase: ExecutionPhase::Running
            }
        );
        assert!(matches!(
            execution.outcome,
            ToolOutcome::Cancelled {
                phase: ExecutionPhase::Running
            }
        ));
    }

    #[test]
    fn unknown_remote_write_becomes_non_retryable_indeterminate() {
        let execution = ToolExecution::from_legacy(
            "call-gh-write",
            "gh_issue",
            ExecutionSource::Native,
            ToolResult::failure("GitHub write did not produce a terminal response before shutdown")
                .with_details(serde_json::json!({
                    "cancelled": true,
                    "remoteOutcome": "unknown",
                    "retryable": false,
                    "requiresReconciliation": true
                })),
        );

        assert_eq!(execution.receipt.status, ExecutionStatus::Indeterminate);
        assert!(matches!(
            execution.outcome,
            ToolOutcome::Indeterminate { .. }
        ));
        let legacy = execution.to_legacy();
        assert_eq!(
            legacy
                .details
                .as_ref()
                .and_then(|details| details.get("retryable")),
            Some(&serde_json::Value::Bool(false))
        );
        assert!(execution
            .model_content()
            .contains("Reconcile before retrying"));
    }

    #[test]
    fn explicit_non_cancelled_exit_130_stays_a_failure() {
        let execution = ToolExecution::from_legacy(
            "call-exit-130",
            "bash",
            ExecutionSource::Native,
            ToolResult {
                success: false,
                output: String::new(),
                error: Some("Exit code: 130".to_string()),
                details: Some(serde_json::json!({
                    "command": "exit 130",
                    "exit_code": 130,
                    "cancelled": false,
                    "truncated": false,
                    "background": false,
                    "required_approval": true,
                })),
            },
        );

        assert_eq!(execution.receipt.status, ExecutionStatus::Failed);
        assert!(matches!(execution.outcome, ToolOutcome::Failed { .. }));
    }

    #[test]
    fn exit_130_without_cancellation_evidence_stays_a_failure() {
        let execution = ToolExecution::from_legacy(
            "call-inline-exit-130",
            "custom_inline",
            ExecutionSource::Native,
            ToolResult {
                success: false,
                output: String::new(),
                error: Some("Exit code: 130".to_string()),
                details: Some(serde_json::json!({"exit_code": 130})),
            },
        );

        assert_eq!(execution.receipt.status, ExecutionStatus::Failed);
        assert!(matches!(execution.outcome, ToolOutcome::Failed { .. }));
    }

    #[test]
    fn legacy_contradiction_is_never_a_typed_success() {
        let execution = ToolExecution::from_legacy(
            "call-2",
            "read",
            ExecutionSource::RemoteClient,
            ToolResult {
                success: true,
                output: "stale output".to_string(),
                error: Some("remote failure".to_string()),
                details: None,
            },
        );

        assert!(matches!(execution.outcome, ToolOutcome::Failed { .. }));
        assert!(execution.is_error());
    }

    #[test]
    fn mcp_receipt_keeps_semantic_error_metadata() {
        let execution = ToolExecution::from_legacy(
            "call-3",
            "mcp_server_tool",
            ExecutionSource::Native,
            ToolResult {
                success: false,
                output: "MCP error body".to_string(),
                error: Some("MCP tool reported an error".to_string()),
                details: Some(serde_json::json!({
                    "server": "server",
                    "tool": "tool",
                    "isError": true,
                })),
            },
        );

        assert!(matches!(execution.outcome, ToolOutcome::Failed { .. }));
        assert!(matches!(
            execution.receipt.details,
            ToolReceiptDetails::Mcp { is_error: true, .. }
        ));
    }
}

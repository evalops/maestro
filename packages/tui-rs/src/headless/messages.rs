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

/// Current headless protocol version shared with the TypeScript runtime.
pub use super::generated_protocol::HEADLESS_PROTOCOL_VERSION;

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
    /// Declare client identity and negotiated capabilities for this connection
    Hello {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_info: Option<ClientInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<ClientCapabilities>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<ConnectionRole>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opt_out_notifications: Option<Vec<String>>,
    },
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
    /// Submit the result of a client-side tool execution
    ClientToolResult {
        call_id: String,
        content: Vec<ClientToolResultContent>,
        is_error: bool,
    },
    /// Generic response to a pending server request
    ServerRequestResponse {
        request_id: String,
        request_type: ServerRequestType,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approved: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ClientToolResultContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision_action: Option<ToolRetryDecisionAction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Start a utility command on the runtime
    UtilityCommandStart {
        command_id: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell_mode: Option<UtilityCommandShellMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_mode: Option<UtilityCommandTerminalMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allow_stdin: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        columns: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<u32>,
    },
    /// Terminate a utility command on the runtime
    UtilityCommandTerminate {
        command_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        force: Option<bool>,
    },
    /// Write stdin to a running utility command
    UtilityCommandStdin {
        command_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eof: Option<bool>,
    },
    /// Resize a PTY-backed utility command on the runtime
    UtilityCommandResize {
        command_id: String,
        columns: u32,
        rows: u32,
    },
    /// Search workspace file paths on the runtime
    UtilityFileSearch {
        search_id: String,
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
    /// Read a workspace file on the runtime
    UtilityFileRead {
        read_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
    /// Start a filesystem watch on the runtime
    UtilityFileWatchStart {
        watch_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_patterns: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_patterns: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        debounce_ms: Option<u32>,
    },
    /// Stop a filesystem watch on the runtime
    UtilityFileWatchStop { watch_id: String },
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

/// Identifies the attached headless client.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Negotiated client capabilities for the connection.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_requests: Option<Vec<ServerRequestType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utility_operations: Option<Vec<UtilityOperation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_agent_events: Option<bool>,
}

/// Snapshot of a live headless connection attached to a runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionState {
    pub connection_id: String,
    pub role: ConnectionRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<ClientInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ClientCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opt_out_notifications: Option<Vec<String>>,
    #[serde(default)]
    pub subscription_count: usize,
    #[serde(default)]
    pub attached_subscription_count: usize,
    #[serde(default)]
    pub controller_lease_granted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
}

/// Role granted to the attached headless connection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionRole {
    Viewer,
    Controller,
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

/// Utility-plane operations negotiated for the connection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityOperation {
    CommandExec,
    FileSearch,
    FileRead,
    FileWatch,
}

/// Output stream emitted by a running utility command.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityCommandStream {
    Stdout,
    Stderr,
}

/// Shell launch mode for utility commands.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityCommandShellMode {
    Shell,
    Direct,
}

/// Terminal mode for utility commands.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityCommandTerminalMode {
    Pipe,
    Pty,
}

/// File change type emitted by a running file watch.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityFileWatchChangeType {
    Create,
    Modify,
    Delete,
    Rename,
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

/// Content returned from a client-side tool execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientToolResultContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

/// Ranked file path match returned by a runtime file search.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UtilityFileSearchMatch {
    pub path: String,
    pub score: i32,
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
    /// Handshake acknowledgement for a specific client connection
    HelloOk {
        protocol_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_protocol_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_info: Option<ClientInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<ClientCapabilities>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opt_out_notifications: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<ConnectionRole>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        controller_connection_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lease_expires_at: Option<String>,
    },
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
    /// Client-side tool execution requested
    ClientToolRequest {
        call_id: String,
        tool: String,
        args: serde_json::Value,
    },
    /// Structured server-to-client request (currently approvals)
    ServerRequest {
        request_id: String,
        request_type: ServerRequestType,
        call_id: String,
        tool: String,
        args: serde_json::Value,
        reason: String,
    },
    /// Resolution of a structured server-to-client request
    ServerRequestResolved {
        request_id: String,
        request_type: ServerRequestType,
        call_id: String,
        resolution: ServerRequestResolutionStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        resolved_by: ServerRequestResolvedBy,
    },
    /// Error occurred
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
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
    /// Connection metadata negotiated by the client
    ConnectionInfo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_protocol_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_info: Option<ClientInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<ClientCapabilities>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opt_out_notifications: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<ConnectionRole>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_count: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        controller_connection_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lease_expires_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connections: Option<Vec<ConnectionState>>,
    },
    /// Raw agent event stream for advanced clients
    RawAgentEvent {
        event_type: String,
        event: serde_json::Value,
    },
    /// Utility command started on the runtime
    UtilityCommandStarted {
        command_id: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        shell_mode: UtilityCommandShellMode,
        terminal_mode: UtilityCommandTerminalMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        columns: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner_connection_id: Option<String>,
    },
    /// Utility command terminal resized on the runtime
    UtilityCommandResized {
        command_id: String,
        columns: u32,
        rows: u32,
    },
    /// Utility command output chunk
    UtilityCommandOutput {
        command_id: String,
        stream: UtilityCommandStream,
        content: String,
    },
    /// Utility command completed on the runtime
    UtilityCommandExited {
        command_id: String,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// File path search completed on the runtime
    UtilityFileSearchResults {
        search_id: String,
        query: String,
        cwd: String,
        results: Vec<UtilityFileSearchMatch>,
        truncated: bool,
    },
    /// File read completed on the runtime
    UtilityFileReadResult {
        read_id: String,
        path: String,
        relative_path: String,
        cwd: String,
        content: String,
        start_line: u32,
        end_line: u32,
        total_lines: u32,
        truncated: bool,
    },
    /// File watch started on the runtime
    UtilityFileWatchStarted {
        watch_id: String,
        root_dir: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_patterns: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_patterns: Option<Vec<String>>,
        debounce_ms: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner_connection_id: Option<String>,
    },
    /// File watch emitted a change event
    UtilityFileWatchEvent {
        watch_id: String,
        change_type: UtilityFileWatchChangeType,
        path: String,
        relative_path: String,
        timestamp: u64,
        is_directory: bool,
    },
    /// File watch stopped on the runtime
    UtilityFileWatchStopped {
        watch_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
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

/// Type of server-driven request sent over the headless protocol.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRequestType {
    Approval,
    ClientTool,
    UserInput,
    ToolRetry,
}

/// Actor that resolved a server request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRequestResolvedBy {
    User,
    Policy,
    Client,
    Runtime,
}

/// Approval resolution status for a server request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRequestResolutionStatus {
    Approved,
    Denied,
    Completed,
    Failed,
    Answered,
    Cancelled,
    Retried,
    Skipped,
    Aborted,
}

/// Decision action returned for a pending tool retry prompt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRetryDecisionAction {
    Retry,
    Skip,
    Abort,
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
    pub client_protocol_version: Option<String>,
    pub client_info: Option<ClientInfo>,
    pub capabilities: Option<ClientCapabilities>,
    pub opt_out_notifications: Option<Vec<String>>,
    pub connection_role: Option<ConnectionRole>,
    pub connection_count: usize,
    pub subscriber_count: usize,
    pub controller_subscription_id: Option<String>,
    pub controller_connection_id: Option<String>,
    pub connections: Vec<ConnectionState>,
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
    /// Pending client-side tool execution requests
    pub pending_client_tools: Vec<PendingApproval>,
    /// Pending structured user input requests
    pub pending_user_inputs: Vec<PendingApproval>,
    /// Pending tool retry requests
    pub pending_tool_retries: Vec<PendingApproval>,
    /// Active tool executions
    pub active_tools: HashMap<String, ActiveTool>,
    /// Active utility-plane commands
    pub active_utility_commands: HashMap<String, ActiveUtilityCommand>,
    /// Active utility-plane file watches
    pub active_file_watches: HashMap<String, ActiveFileWatch>,
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

const HEADLESS_OUTPUT_LIMIT: usize = 32_768;

fn append_headless_output(existing: &mut String, chunk: &str) {
    existing.push_str(chunk);
    if existing.len() <= HEADLESS_OUTPUT_LIMIT {
        return;
    }
    let mut drain_until = existing.len() - HEADLESS_OUTPUT_LIMIT;
    while drain_until < existing.len() && !existing.is_char_boundary(drain_until) {
        drain_until += 1;
    }
    existing.drain(..drain_until);
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
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

/// A utility command currently executing
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveUtilityCommand {
    pub command_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub shell_mode: UtilityCommandShellMode,
    pub terminal_mode: UtilityCommandTerminalMode,
    pub pid: Option<u32>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
    pub owner_connection_id: Option<String>,
    pub output: String,
}

/// A file watch currently active on the runtime.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveFileWatch {
    pub watch_id: String,
    pub root_dir: String,
    pub include_patterns: Option<Vec<String>>,
    pub exclude_patterns: Option<Vec<String>>,
    pub debounce_ms: u32,
    pub owner_connection_id: Option<String>,
}

impl AgentState {
    /// Clear volatile progress indicators that can become stale across transport gaps.
    pub fn clear_transient_progress(&mut self) {
        self.current_response = None;
        self.active_tools.clear();
        self.is_responding = false;
    }

    /// Handle an outbound message and update optimistic local state.
    pub fn handle_sent_message(&mut self, msg: &ToAgentMessage) {
        match msg {
            ToAgentMessage::Hello {
                protocol_version,
                client_info,
                capabilities,
                role,
                opt_out_notifications,
            } => {
                self.client_protocol_version = protocol_version.clone();
                self.client_info = client_info.clone();
                self.capabilities = capabilities.clone();
                self.opt_out_notifications = opt_out_notifications.clone();
                self.connection_role = Some(role.unwrap_or(ConnectionRole::Controller));
                self.connection_count = 1;
                self.controller_connection_id = match self.connection_role {
                    Some(ConnectionRole::Controller) => Some("local".to_string()),
                    _ => None,
                };
                self.connections = vec![ConnectionState {
                    connection_id: "local".to_string(),
                    role: self.connection_role.unwrap_or(ConnectionRole::Controller),
                    client_protocol_version: protocol_version.clone(),
                    client_info: client_info.clone(),
                    capabilities: capabilities.clone(),
                    opt_out_notifications: opt_out_notifications.clone(),
                    subscription_count: 1,
                    attached_subscription_count: 1,
                    controller_lease_granted: matches!(
                        self.connection_role,
                        Some(ConnectionRole::Controller)
                    ),
                    lease_expires_at: None,
                }];
            }
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
                self.pending_client_tools.clear();
                self.pending_user_inputs.clear();
                self.pending_tool_retries.clear();
                self.active_tools.clear();
                self.active_utility_commands.clear();
                self.active_file_watches.clear();
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
            ToAgentMessage::ClientToolResult { call_id, .. } => {
                self.pending_client_tools.retain(|p| p.call_id != *call_id);
                self.pending_user_inputs.retain(|p| p.call_id != *call_id);
            }
            ToAgentMessage::ServerRequestResponse {
                request_id,
                request_type,
                approved,
                ..
            } => match request_type {
                ServerRequestType::Approval => {
                    self.pending_approvals
                        .retain(|p| !pending_request_matches(p, request_id));
                    if approved != &Some(true) {
                        self.tracked_tools.remove(request_id);
                    }
                }
                ServerRequestType::ClientTool => {
                    self.pending_client_tools
                        .retain(|p| !pending_request_matches(p, request_id));
                }
                ServerRequestType::UserInput => {
                    self.pending_user_inputs
                        .retain(|p| !pending_request_matches(p, request_id));
                }
                ServerRequestType::ToolRetry => {
                    self.pending_tool_retries
                        .retain(|p| !pending_request_matches(p, request_id));
                }
            },
            ToAgentMessage::UtilityCommandStart { .. } => {}
            ToAgentMessage::UtilityCommandTerminate { .. } => {}
            ToAgentMessage::UtilityCommandStdin { .. } => {}
            ToAgentMessage::UtilityCommandResize { .. } => {}
            ToAgentMessage::UtilityFileSearch { .. } => {}
            ToAgentMessage::UtilityFileRead { .. } => {}
            ToAgentMessage::UtilityFileWatchStart { .. } => {}
            ToAgentMessage::UtilityFileWatchStop { .. } => {}
            ToAgentMessage::Shutdown => {
                self.current_response = None;
                self.pending_approvals.clear();
                self.pending_client_tools.clear();
                self.pending_user_inputs.clear();
                self.pending_tool_retries.clear();
                self.active_tools.clear();
                self.active_utility_commands.clear();
                self.active_file_watches.clear();
                self.tracked_tools.clear();
                self.is_ready = false;
                self.is_responding = false;
            }
        }
    }

    /// Handle an incoming message and update state
    pub fn handle_message(&mut self, msg: FromAgentMessage) -> Option<AgentEvent> {
        match msg {
            FromAgentMessage::HelloOk {
                protocol_version,
                connection_id: _connection_id,
                client_protocol_version,
                client_info,
                capabilities,
                opt_out_notifications,
                role,
                controller_connection_id,
                lease_expires_at: _lease_expires_at,
            } => {
                self.protocol_version = Some(protocol_version);
                self.client_protocol_version = client_protocol_version;
                self.client_info = client_info;
                self.capabilities = capabilities;
                self.opt_out_notifications = opt_out_notifications;
                self.connection_role = role;
                self.controller_connection_id = controller_connection_id;
                None
            }
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
            FromAgentMessage::ConnectionInfo {
                connection_id: _connection_id,
                client_protocol_version,
                client_info,
                capabilities,
                opt_out_notifications,
                role,
                connection_count,
                controller_connection_id,
                lease_expires_at: _lease_expires_at,
                connections,
            } => {
                self.client_protocol_version = client_protocol_version;
                self.client_info = client_info;
                self.capabilities = capabilities;
                self.opt_out_notifications = opt_out_notifications;
                self.connection_role = role;
                self.connection_count = connection_count.unwrap_or_default();
                self.controller_connection_id = controller_connection_id;
                self.connections = connections.unwrap_or_default();
                None
            }
            FromAgentMessage::RawAgentEvent { event_type, event } => {
                Some(AgentEvent::RawAgentEvent { event_type, event })
            }
            FromAgentMessage::UtilityCommandStarted {
                command_id,
                command,
                cwd,
                shell_mode,
                terminal_mode,
                pid,
                columns,
                rows,
                owner_connection_id,
            } => {
                self.active_utility_commands.insert(
                    command_id.clone(),
                    ActiveUtilityCommand {
                        command_id,
                        command,
                        cwd,
                        shell_mode,
                        terminal_mode,
                        pid,
                        columns,
                        rows,
                        owner_connection_id,
                        output: String::new(),
                    },
                );
                None
            }
            FromAgentMessage::UtilityCommandResized {
                command_id,
                columns,
                rows,
            } => {
                if let Some(command) = self.active_utility_commands.get_mut(&command_id) {
                    command.columns = Some(columns);
                    command.rows = Some(rows);
                }
                None
            }
            FromAgentMessage::UtilityCommandOutput {
                command_id,
                content,
                ..
            } => {
                if let Some(command) = self.active_utility_commands.get_mut(&command_id) {
                    append_headless_output(&mut command.output, &content);
                }
                None
            }
            FromAgentMessage::UtilityCommandExited { command_id, .. } => {
                self.active_utility_commands.remove(&command_id);
                None
            }
            FromAgentMessage::UtilityFileSearchResults { .. } => None,
            FromAgentMessage::UtilityFileReadResult { .. } => None,
            FromAgentMessage::UtilityFileWatchStarted {
                watch_id,
                root_dir,
                include_patterns,
                exclude_patterns,
                debounce_ms,
                owner_connection_id,
            } => {
                self.active_file_watches.insert(
                    watch_id.clone(),
                    ActiveFileWatch {
                        watch_id,
                        root_dir,
                        include_patterns,
                        exclude_patterns,
                        debounce_ms,
                        owner_connection_id,
                    },
                );
                None
            }
            FromAgentMessage::UtilityFileWatchEvent { .. } => None,
            FromAgentMessage::UtilityFileWatchStopped { watch_id, .. } => {
                self.active_file_watches.remove(&watch_id);
                None
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
                        request_id: None,
                        tool: tool.clone(),
                        args: args.clone(),
                    },
                );
                if requires_approval {
                    self.pending_approvals.push(PendingApproval {
                        call_id: call_id.clone(),
                        request_id: None,
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
                self.pending_client_tools.retain(|p| p.call_id != call_id);
                self.pending_user_inputs.retain(|p| p.call_id != call_id);
                self.pending_tool_retries.retain(|p| p.call_id != call_id);
                Some(AgentEvent::ToolEnd {
                    call_id,
                    success,
                    duration: tool.map(|t| t.started.elapsed()),
                })
            }

            FromAgentMessage::ClientToolRequest {
                call_id,
                tool,
                args,
            } => {
                self.tracked_tools.insert(
                    call_id.clone(),
                    PendingApproval {
                        call_id: call_id.clone(),
                        request_id: None,
                        tool: tool.clone(),
                        args: args.clone(),
                    },
                );
                if tool == "ask_user" {
                    self.pending_user_inputs.retain(|p| p.call_id != call_id);
                    self.pending_user_inputs.push(PendingApproval {
                        call_id,
                        request_id: None,
                        tool,
                        args,
                    });
                } else {
                    self.pending_client_tools.retain(|p| p.call_id != call_id);
                    self.pending_client_tools.push(PendingApproval {
                        call_id,
                        request_id: None,
                        tool,
                        args,
                    });
                }
                None
            }

            FromAgentMessage::ServerRequest {
                request_id,
                call_id,
                request_type,
                tool,
                args,
                ..
            } => {
                if request_type != ServerRequestType::ToolRetry
                    || !self.tracked_tools.contains_key(&call_id)
                {
                    self.tracked_tools.insert(
                        call_id.clone(),
                        PendingApproval {
                            call_id: call_id.clone(),
                            request_id: None,
                            tool: tool.clone(),
                            args: args.clone(),
                        },
                    );
                }
                let request_id = if request_id == call_id {
                    None
                } else {
                    Some(request_id)
                };
                match request_type {
                    ServerRequestType::Approval => {
                        self.pending_approvals.retain(|p| p.call_id != call_id);
                        self.pending_approvals.push(PendingApproval {
                            call_id,
                            request_id,
                            tool,
                            args,
                        });
                    }
                    ServerRequestType::ClientTool => {
                        self.pending_client_tools.retain(|p| p.call_id != call_id);
                        self.pending_client_tools.push(PendingApproval {
                            call_id,
                            request_id,
                            tool,
                            args,
                        });
                    }
                    ServerRequestType::UserInput => {
                        self.pending_user_inputs.retain(|p| p.call_id != call_id);
                        self.pending_user_inputs.push(PendingApproval {
                            call_id,
                            request_id,
                            tool,
                            args,
                        });
                    }
                    ServerRequestType::ToolRetry => {
                        self.pending_tool_retries.retain(|p| p.call_id != call_id);
                        self.pending_tool_retries.push(PendingApproval {
                            call_id,
                            request_id,
                            tool,
                            args,
                        });
                    }
                }
                None
            }

            FromAgentMessage::ServerRequestResolved {
                request_id,
                call_id,
                request_type,
                resolution,
                ..
            } => {
                match request_type {
                    ServerRequestType::Approval => {
                        self.pending_approvals
                            .retain(|p| !pending_request_matches(p, &request_id));
                        if resolution != ServerRequestResolutionStatus::Approved {
                            self.tracked_tools.remove(&call_id);
                        }
                    }
                    ServerRequestType::ClientTool => {
                        self.pending_client_tools
                            .retain(|p| !pending_request_matches(p, &request_id));
                        if resolution == ServerRequestResolutionStatus::Cancelled {
                            self.tracked_tools.remove(&call_id);
                        }
                    }
                    ServerRequestType::UserInput => {
                        self.pending_user_inputs
                            .retain(|p| !pending_request_matches(p, &request_id));
                        if resolution != ServerRequestResolutionStatus::Answered {
                            self.tracked_tools.remove(&call_id);
                        }
                    }
                    ServerRequestType::ToolRetry => {
                        self.pending_tool_retries
                            .retain(|p| !pending_request_matches(p, &request_id));
                    }
                }
                None
            }

            FromAgentMessage::Error {
                request_id,
                message,
                fatal,
                error_type,
            } => {
                self.last_error = Some(message.clone());
                self.last_error_type = error_type;
                Some(AgentEvent::Error {
                    request_id,
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

fn pending_request_matches(pending: &PendingApproval, request_id: &str) -> bool {
    pending.request_id.as_deref().unwrap_or(&pending.call_id) == request_id
}

/// High-level events for the TUI to react to
#[derive(Debug, Clone)]
pub enum AgentEvent {
    RawAgentEvent {
        event_type: String,
        event: serde_json::Value,
    },
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
        request_id: Option<String>,
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
    fn parse_server_request_message() {
        let json = r#"{"type":"server_request","request_id":"call_approval","request_type":"approval","call_id":"call_approval","tool":"bash","args":{"command":"git push --force"},"reason":"Force push requires approval"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ServerRequest {
                request_id,
                request_type,
                call_id,
                tool,
                args,
                reason,
            } => {
                assert_eq!(request_id, "call_approval");
                assert_eq!(request_type, ServerRequestType::Approval);
                assert_eq!(call_id, "call_approval");
                assert_eq!(tool, "bash");
                assert_eq!(args["command"], "git push --force");
                assert_eq!(reason, "Force push requires approval");
            }
            _ => panic!("Expected ServerRequest message"),
        }
    }

    #[test]
    fn parse_client_tool_server_request_message() {
        let json = r#"{"type":"server_request","request_id":"call_client","request_type":"client_tool","call_id":"call_client","tool":"artifacts","args":{"command":"create","filename":"report.txt"},"reason":"Client tool artifacts requires local execution"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ServerRequest {
                request_id,
                request_type,
                call_id,
                tool,
                args,
                reason,
            } => {
                assert_eq!(request_id, "call_client");
                assert_eq!(request_type, ServerRequestType::ClientTool);
                assert_eq!(call_id, "call_client");
                assert_eq!(tool, "artifacts");
                assert_eq!(args["command"], "create");
                assert_eq!(reason, "Client tool artifacts requires local execution");
            }
            _ => panic!("Expected ServerRequest message"),
        }
    }

    #[test]
    fn parse_user_input_server_request_message() {
        let json = r#"{"type":"server_request","request_id":"call_user_input","request_type":"user_input","call_id":"call_user_input","tool":"ask_user","args":{"questions":[{"header":"Stack","question":"Which schema library should we use?","options":[{"label":"Zod","description":"Use Zod schemas"}]}]},"reason":"Agent requested structured user input"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ServerRequest {
                request_id,
                request_type,
                call_id,
                tool,
                args,
                reason,
            } => {
                assert_eq!(request_id, "call_user_input");
                assert_eq!(request_type, ServerRequestType::UserInput);
                assert_eq!(call_id, "call_user_input");
                assert_eq!(tool, "ask_user");
                assert_eq!(args["questions"][0]["header"], "Stack");
                assert_eq!(reason, "Agent requested structured user input");
            }
            _ => panic!("Expected ServerRequest message"),
        }
    }

    #[test]
    fn parse_client_tool_request_message() {
        let json = r#"{"type":"client_tool_request","call_id":"call_client","tool":"artifacts","args":{"command":"create","filename":"report.txt"}}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ClientToolRequest {
                call_id,
                tool,
                args,
            } => {
                assert_eq!(call_id, "call_client");
                assert_eq!(tool, "artifacts");
                assert_eq!(args["command"], "create");
                assert_eq!(args["filename"], "report.txt");
            }
            _ => panic!("Expected ClientToolRequest message"),
        }
    }

    #[test]
    fn parse_connection_info_message() {
        let json = r#"{"type":"connection_info","connection_id":"conn_remote","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval","client_tool"]},"opt_out_notifications":["status","heartbeat"],"role":"controller","connection_count":1,"controller_connection_id":"conn_remote","connections":[{"connection_id":"conn_remote","role":"controller","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval","client_tool"]},"opt_out_notifications":["status","heartbeat"],"subscription_count":1,"attached_subscription_count":1,"controller_lease_granted":true}]}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::ConnectionInfo {
                connection_id,
                client_protocol_version,
                client_info,
                capabilities,
                opt_out_notifications,
                role,
                connection_count,
                controller_connection_id,
                connections,
                ..
            } => {
                assert_eq!(connection_id.as_deref(), Some("conn_remote"));
                assert_eq!(client_protocol_version.as_deref(), Some("2026-03-30"));
                assert_eq!(
                    client_info.as_ref().map(|info| info.name.as_str()),
                    Some("maestro-web")
                );
                assert_eq!(
                    capabilities
                        .as_ref()
                        .and_then(|caps| caps.server_requests.as_ref())
                        .map(|caps| caps.len()),
                    Some(2)
                );
                assert_eq!(
                    opt_out_notifications.as_ref().map(|items| items.len()),
                    Some(2)
                );
                assert_eq!(role, Some(ConnectionRole::Controller));
                assert_eq!(connection_count, Some(1));
                assert_eq!(controller_connection_id.as_deref(), Some("conn_remote"));
                assert_eq!(connections.as_ref().map(Vec::len), Some(1));
            }
            _ => panic!("Expected ConnectionInfo message"),
        }
    }

    #[test]
    fn parse_hello_ok_message() {
        let json = r#"{"type":"hello_ok","protocol_version":"2026-04-02","connection_id":"conn_remote","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval"]},"opt_out_notifications":["status"],"role":"controller","controller_connection_id":"conn_remote"}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::HelloOk {
                protocol_version,
                connection_id,
                client_protocol_version,
                client_info,
                capabilities,
                opt_out_notifications,
                role,
                controller_connection_id,
                lease_expires_at,
            } => {
                assert_eq!(protocol_version, "2026-04-02");
                assert_eq!(connection_id.as_deref(), Some("conn_remote"));
                assert_eq!(client_protocol_version.as_deref(), Some("2026-03-30"));
                assert_eq!(
                    client_info.as_ref().map(|info| info.name.as_str()),
                    Some("maestro-web")
                );
                assert_eq!(
                    capabilities
                        .as_ref()
                        .and_then(|caps| caps.server_requests.as_ref())
                        .map(|caps| caps.len()),
                    Some(1)
                );
                assert_eq!(opt_out_notifications, Some(vec!["status".to_string()]));
                assert_eq!(role, Some(ConnectionRole::Controller));
                assert_eq!(controller_connection_id.as_deref(), Some("conn_remote"));
                assert!(lease_expires_at.is_none());
            }
            _ => panic!("Expected HelloOk message"),
        }
    }

    #[test]
    fn parse_raw_agent_event_message() {
        let json = r#"{"type":"raw_agent_event","event_type":"status","event":{"type":"status","status":"Working","details":{}}}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::RawAgentEvent { event_type, event } => {
                assert_eq!(event_type, "status");
                assert_eq!(event["type"], "status");
                assert_eq!(event["status"], "Working");
            }
            _ => panic!("Expected RawAgentEvent message"),
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
    fn serialize_hello_message() {
        let msg = ToAgentMessage::Hello {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![ServerRequestType::Approval]),
                utility_operations: Some(vec![UtilityOperation::CommandExec]),
                raw_agent_events: Some(true),
            }),
            role: Some(ConnectionRole::Controller),
            opt_out_notifications: Some(vec!["status".to_string()]),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"hello""#));
        assert!(json.contains(&format!(
            r#""protocol_version":"{}""#,
            HEADLESS_PROTOCOL_VERSION
        )));
        assert!(json.contains(r#""name":"maestro-tui-rs""#));
        assert!(json.contains(r#""role":"controller""#));
        assert!(json.contains(r#""opt_out_notifications":["status"]"#));
    }

    #[test]
    fn serialize_server_request_response_message() {
        let msg = ToAgentMessage::ServerRequestResponse {
            request_id: "call_user_input".to_string(),
            request_type: ServerRequestType::UserInput,
            approved: None,
            result: None,
            content: Some(vec![ClientToolResultContent::Text {
                text: "Use Zod".to_string(),
            }]),
            is_error: Some(false),
            decision_action: None,
            reason: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"server_request_response""#));
        assert!(json.contains(r#""request_id":"call_user_input""#));
        assert!(json.contains(r#""request_type":"user_input""#));
    }

    #[test]
    fn serialize_utility_command_start_message_with_stdin() {
        let msg = ToAgentMessage::UtilityCommandStart {
            command_id: "cmd_stdin".to_string(),
            command: "cat".to_string(),
            cwd: None,
            env: None,
            shell_mode: Some(UtilityCommandShellMode::Direct),
            terminal_mode: Some(UtilityCommandTerminalMode::Pipe),
            allow_stdin: Some(true),
            columns: None,
            rows: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"utility_command_start""#));
        assert!(json.contains(r#""command_id":"cmd_stdin""#));
        assert!(json.contains(r#""allow_stdin":true"#));
    }

    #[test]
    fn serialize_utility_command_stdin_message() {
        let msg = ToAgentMessage::UtilityCommandStdin {
            command_id: "cmd_stdin".to_string(),
            content: "hello maestro".to_string(),
            eof: Some(true),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"utility_command_stdin""#));
        assert!(json.contains(r#""command_id":"cmd_stdin""#));
        assert!(json.contains(r#""content":"hello maestro""#));
        assert!(json.contains(r#""eof":true"#));
    }

    #[test]
    fn serialize_utility_command_resize_message() {
        let msg = ToAgentMessage::UtilityCommandResize {
            command_id: "cmd_stdin".to_string(),
            columns: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"utility_command_resize""#));
        assert!(json.contains(r#""columns":120"#));
        assert!(json.contains(r#""rows":40"#));
    }

    #[test]
    fn serialize_utility_file_search_message() {
        let msg = ToAgentMessage::UtilityFileSearch {
            search_id: "search_src".to_string(),
            query: "headless".to_string(),
            cwd: Some("/tmp/project".to_string()),
            limit: Some(25),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"utility_file_search""#));
        assert!(json.contains(r#""search_id":"search_src""#));
        assert!(json.contains(r#""query":"headless""#));
        assert!(json.contains(r#""limit":25"#));
    }

    #[test]
    fn serialize_utility_file_read_message() {
        let msg = ToAgentMessage::UtilityFileRead {
            read_id: "read_src".to_string(),
            path: "src/headless/mod.rs".to_string(),
            cwd: Some("/tmp/project".to_string()),
            offset: Some(25),
            limit: Some(40),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"utility_file_read""#));
        assert!(json.contains(r#""read_id":"read_src""#));
        assert!(json.contains(r#""path":"src/headless/mod.rs""#));
        assert!(json.contains(r#""offset":25"#));
        assert!(json.contains(r#""limit":40"#));
    }

    #[test]
    fn parse_utility_file_watch_event_message() {
        let json = r#"{"type":"utility_file_watch_event","watch_id":"watch_src","change_type":"modify","path":"/tmp/project/src/app.ts","relative_path":"src/app.ts","timestamp":1234,"is_directory":false}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::UtilityFileWatchEvent {
                watch_id,
                change_type,
                path,
                relative_path,
                timestamp,
                is_directory,
            } => {
                assert_eq!(watch_id, "watch_src");
                assert_eq!(change_type, UtilityFileWatchChangeType::Modify);
                assert_eq!(path, "/tmp/project/src/app.ts");
                assert_eq!(relative_path, "src/app.ts");
                assert_eq!(timestamp, 1234);
                assert!(!is_directory);
            }
            _ => panic!("Expected UtilityFileWatchEvent message"),
        }
    }

    #[test]
    fn parse_utility_file_read_result_message() {
        let json = r#"{"type":"utility_file_read_result","read_id":"read_src","path":"/tmp/project/src/main.rs","relative_path":"src/main.rs","cwd":"/tmp/project","content":"fn main() {}","start_line":1,"end_line":1,"total_lines":1,"truncated":false}"#;
        let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
        match msg {
            FromAgentMessage::UtilityFileReadResult {
                read_id,
                path,
                relative_path,
                cwd,
                content,
                start_line,
                end_line,
                total_lines,
                truncated,
            } => {
                assert_eq!(read_id, "read_src");
                assert_eq!(path, "/tmp/project/src/main.rs");
                assert_eq!(relative_path, "src/main.rs");
                assert_eq!(cwd, "/tmp/project");
                assert_eq!(content, "fn main() {}");
                assert_eq!(start_line, 1);
                assert_eq!(end_line, 1);
                assert_eq!(total_lines, 1);
                assert!(!truncated);
            }
            _ => panic!("Expected UtilityFileReadResult message"),
        }
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
            request_id: Some("read_missing".to_string()),
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
                request_id: Some(ref request_id),
                error_type: Some(HeadlessErrorType::Cancelled),
                ..
            }) if request_id == "read_missing"
        ));
    }

    #[test]
    fn state_tracks_and_clears_file_watches() {
        let mut state = AgentState::default();
        state.handle_message(FromAgentMessage::UtilityCommandStarted {
            command_id: "cmd_owned".to_string(),
            command: "echo hi".to_string(),
            cwd: Some("/tmp/project".to_string()),
            shell_mode: UtilityCommandShellMode::Direct,
            terminal_mode: UtilityCommandTerminalMode::Pipe,
            pid: Some(42),
            columns: None,
            rows: None,
            owner_connection_id: Some("conn_owned".to_string()),
        });
        state.handle_message(FromAgentMessage::UtilityFileWatchStarted {
            watch_id: "watch_src".to_string(),
            root_dir: "/tmp/project".to_string(),
            include_patterns: Some(vec!["src/**".to_string()]),
            exclude_patterns: Some(vec!["dist/**".to_string()]),
            debounce_ms: 50,
            owner_connection_id: Some("conn_owned".to_string()),
        });

        assert_eq!(state.active_utility_commands.len(), 1);
        assert_eq!(
            state
                .active_utility_commands
                .get("cmd_owned")
                .and_then(|command| command.owner_connection_id.as_deref()),
            Some("conn_owned")
        );
        assert_eq!(state.active_file_watches.len(), 1);
        assert_eq!(
            state
                .active_file_watches
                .get("watch_src")
                .map(|watch| watch.root_dir.as_str()),
            Some("/tmp/project")
        );
        assert_eq!(
            state
                .active_file_watches
                .get("watch_src")
                .and_then(|watch| watch.owner_connection_id.as_deref()),
            Some("conn_owned")
        );

        state.handle_message(FromAgentMessage::UtilityFileWatchStopped {
            watch_id: "watch_src".to_string(),
            reason: Some("Stopped by controller".to_string()),
        });

        assert!(state.active_file_watches.is_empty());
    }

    #[test]
    fn state_updates_active_utility_command_dimensions_after_resize() {
        let mut state = AgentState::default();
        state.handle_message(FromAgentMessage::UtilityCommandStarted {
            command_id: "cmd_pty".to_string(),
            command: "node app.js".to_string(),
            cwd: Some("/tmp/project".to_string()),
            shell_mode: UtilityCommandShellMode::Direct,
            terminal_mode: UtilityCommandTerminalMode::Pty,
            pid: Some(321),
            columns: Some(90),
            rows: Some(30),
            owner_connection_id: Some("conn_pty".to_string()),
        });

        state.handle_message(FromAgentMessage::UtilityCommandResized {
            command_id: "cmd_pty".to_string(),
            columns: 120,
            rows: 40,
        });

        let command = state
            .active_utility_commands
            .get("cmd_pty")
            .expect("active utility command");
        assert_eq!(command.terminal_mode, UtilityCommandTerminalMode::Pty);
        assert_eq!(command.columns, Some(120));
        assert_eq!(command.rows, Some(40));
        assert_eq!(command.owner_connection_id.as_deref(), Some("conn_pty"));
    }

    #[test]
    fn state_caps_active_utility_command_output() {
        let mut state = AgentState::default();
        state.handle_message(FromAgentMessage::UtilityCommandStarted {
            command_id: "cmd_cap".to_string(),
            command: "node app.js".to_string(),
            cwd: Some("/tmp/project".to_string()),
            shell_mode: UtilityCommandShellMode::Direct,
            terminal_mode: UtilityCommandTerminalMode::Pipe,
            pid: Some(321),
            columns: None,
            rows: None,
            owner_connection_id: None,
        });

        state.handle_message(FromAgentMessage::UtilityCommandOutput {
            command_id: "cmd_cap".to_string(),
            stream: UtilityCommandStream::Stdout,
            content: "a".repeat(HEADLESS_OUTPUT_LIMIT),
        });
        state.handle_message(FromAgentMessage::UtilityCommandOutput {
            command_id: "cmd_cap".to_string(),
            stream: UtilityCommandStream::Stdout,
            content: "bcdef".to_string(),
        });

        let command = state
            .active_utility_commands
            .get("cmd_cap")
            .expect("active utility command");
        assert_eq!(command.output.len(), HEADLESS_OUTPUT_LIMIT);
        assert!(command.output.ends_with("bcdef"));
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

    #[test]
    fn state_tracks_and_clears_server_request_approvals() {
        let mut state = AgentState::default();

        let event = state.handle_message(FromAgentMessage::ServerRequest {
            request_id: "call_approval".to_string(),
            request_type: ServerRequestType::Approval,
            call_id: "call_approval".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "git push --force" }),
            reason: "Force push requires approval".to_string(),
        });

        assert!(event.is_none());
        assert_eq!(state.pending_approvals.len(), 1);
        assert_eq!(state.pending_approvals[0].tool, "bash");
        assert!(state.tracked_tools.contains_key("call_approval"));

        let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
            request_id: "call_approval".to_string(),
            request_type: ServerRequestType::Approval,
            call_id: "call_approval".to_string(),
            resolution: ServerRequestResolutionStatus::Denied,
            reason: Some("Denied by user".to_string()),
            resolved_by: ServerRequestResolvedBy::User,
        });

        assert!(resolved.is_none());
        assert!(state.pending_approvals.is_empty());
        assert!(!state.tracked_tools.contains_key("call_approval"));
    }

    #[test]
    fn state_tracks_connection_metadata_from_hello_and_connection_info() {
        let mut state = AgentState::default();

        state.handle_sent_message(&ToAgentMessage::Hello {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-tui-rs".to_string(),
                version: Some("0.1.0".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![ServerRequestType::Approval]),
                utility_operations: Some(vec![UtilityOperation::CommandExec]),
                raw_agent_events: None,
            }),
            role: Some(ConnectionRole::Controller),
            opt_out_notifications: Some(vec!["status".to_string()]),
        });
        let event = state.handle_message(FromAgentMessage::ConnectionInfo {
            connection_id: Some("conn_remote".to_string()),
            client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-web".to_string(),
                version: Some("1.2.3".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![
                    ServerRequestType::Approval,
                    ServerRequestType::ClientTool,
                ]),
                utility_operations: Some(vec![UtilityOperation::CommandExec]),
                raw_agent_events: Some(true),
            }),
            opt_out_notifications: Some(vec!["status".to_string(), "connection_info".to_string()]),
            role: Some(ConnectionRole::Viewer),
            connection_count: Some(1),
            controller_connection_id: Some("conn_remote".to_string()),
            lease_expires_at: None,
            connections: Some(vec![ConnectionState {
                connection_id: "conn_remote".to_string(),
                role: ConnectionRole::Viewer,
                client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
                client_info: Some(ClientInfo {
                    name: "maestro-web".to_string(),
                    version: Some("1.2.3".to_string()),
                }),
                capabilities: Some(ClientCapabilities {
                    server_requests: Some(vec![
                        ServerRequestType::Approval,
                        ServerRequestType::ClientTool,
                    ]),
                    utility_operations: Some(vec![UtilityOperation::CommandExec]),
                    raw_agent_events: Some(true),
                }),
                opt_out_notifications: Some(vec![
                    "status".to_string(),
                    "connection_info".to_string(),
                ]),
                subscription_count: 1,
                attached_subscription_count: 1,
                controller_lease_granted: false,
                lease_expires_at: None,
            }]),
        });

        assert!(event.is_none());
        assert_eq!(
            state.client_protocol_version.as_deref(),
            Some(HEADLESS_PROTOCOL_VERSION)
        );
        assert_eq!(
            state.client_info.as_ref().map(|info| info.name.as_str()),
            Some("maestro-web")
        );
        assert_eq!(state.connection_role, Some(ConnectionRole::Viewer));
        assert_eq!(state.connection_count, 1);
        assert_eq!(
            state
                .opt_out_notifications
                .as_ref()
                .map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            state.controller_connection_id.as_deref(),
            Some("conn_remote")
        );
        assert_eq!(state.connections.len(), 1);
        assert_eq!(
            state
                .capabilities
                .as_ref()
                .and_then(|caps| caps.server_requests.as_ref())
                .map(|caps| caps.len()),
            Some(2)
        );
    }

    #[test]
    fn state_emits_raw_agent_events() {
        let mut state = AgentState::default();
        let event = state.handle_message(FromAgentMessage::RawAgentEvent {
            event_type: "status".to_string(),
            event: serde_json::json!({
                "type": "status",
                "status": "Working",
                "details": {},
            }),
        });

        match event {
            Some(AgentEvent::RawAgentEvent { event_type, event }) => {
                assert_eq!(event_type, "status");
                assert_eq!(event["status"], "Working");
            }
            _ => panic!("Expected raw agent event"),
        }
    }

    #[test]
    fn state_tracks_protocol_version_from_hello_ok() {
        let mut state = AgentState::default();

        let event = state.handle_message(FromAgentMessage::HelloOk {
            protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
            connection_id: Some("conn_remote".to_string()),
            client_protocol_version: Some("2026-04-02".to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-web".to_string(),
                version: Some("1.2.3".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![ServerRequestType::Approval]),
                utility_operations: Some(vec![UtilityOperation::FileRead]),
                raw_agent_events: None,
            }),
            opt_out_notifications: Some(vec!["connection_info".to_string()]),
            role: Some(ConnectionRole::Controller),
            controller_connection_id: Some("conn_remote".to_string()),
            lease_expires_at: None,
        });

        assert!(event.is_none());
        assert_eq!(
            state.protocol_version.as_deref(),
            Some(HEADLESS_PROTOCOL_VERSION)
        );
        assert_eq!(state.client_protocol_version.as_deref(), Some("2026-04-02"));
        assert_eq!(state.connection_role, Some(ConnectionRole::Controller));
        assert_eq!(
            state.controller_connection_id.as_deref(),
            Some("conn_remote")
        );
    }

    #[test]
    fn state_tracks_and_clears_client_tool_requests() {
        let mut state = AgentState::default();

        let event = state.handle_message(FromAgentMessage::ClientToolRequest {
            call_id: "call_client".to_string(),
            tool: "artifacts".to_string(),
            args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
        });

        assert!(event.is_none());
        assert_eq!(state.pending_client_tools.len(), 1);
        assert_eq!(state.pending_client_tools[0].tool, "artifacts");
        assert!(state.tracked_tools.contains_key("call_client"));

        state.handle_sent_message(&ToAgentMessage::ClientToolResult {
            call_id: "call_client".to_string(),
            content: vec![ClientToolResultContent::Text {
                text: "created".to_string(),
            }],
            is_error: false,
        });

        assert!(state.pending_client_tools.is_empty());
        assert!(state.tracked_tools.contains_key("call_client"));
    }

    #[test]
    fn state_tracks_and_clears_generic_client_tool_server_requests() {
        let mut state = AgentState::default();

        let event = state.handle_message(FromAgentMessage::ServerRequest {
            request_id: "call_client".to_string(),
            request_type: ServerRequestType::ClientTool,
            call_id: "call_client".to_string(),
            tool: "artifacts".to_string(),
            args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
            reason: "Client tool artifacts requires local execution".to_string(),
        });

        assert!(event.is_none());
        assert_eq!(state.pending_client_tools.len(), 1);
        assert_eq!(state.pending_client_tools[0].tool, "artifacts");
        assert!(state.tracked_tools.contains_key("call_client"));

        let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
            request_id: "call_client".to_string(),
            request_type: ServerRequestType::ClientTool,
            call_id: "call_client".to_string(),
            resolution: ServerRequestResolutionStatus::Completed,
            reason: None,
            resolved_by: ServerRequestResolvedBy::Client,
        });

        assert!(resolved.is_none());
        assert!(state.pending_client_tools.is_empty());
        assert!(state.tracked_tools.contains_key("call_client"));
    }

    #[test]
    fn state_tracks_and_clears_user_input_requests() {
        let mut state = AgentState::default();

        let event = state.handle_message(FromAgentMessage::ClientToolRequest {
            call_id: "call_user_input".to_string(),
            tool: "ask_user".to_string(),
            args: serde_json::json!({
                "questions": [{
                    "header": "Stack",
                    "question": "Which schema library should we use?",
                    "options": [{
                        "label": "Zod",
                        "description": "Use Zod schemas"
                    }]
                }]
            }),
        });

        assert!(event.is_none());
        assert_eq!(state.pending_user_inputs.len(), 1);
        assert_eq!(state.pending_user_inputs[0].tool, "ask_user");
        assert!(state.tracked_tools.contains_key("call_user_input"));

        let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
            request_id: "call_user_input".to_string(),
            request_type: ServerRequestType::UserInput,
            call_id: "call_user_input".to_string(),
            resolution: ServerRequestResolutionStatus::Answered,
            reason: None,
            resolved_by: ServerRequestResolvedBy::Client,
        });

        assert!(resolved.is_none());
        assert!(state.pending_user_inputs.is_empty());
        assert!(state.tracked_tools.contains_key("call_user_input"));
    }

    #[test]
    fn state_clears_user_input_on_sent_generic_server_request_response() {
        let mut state = AgentState::default();

        state.handle_message(FromAgentMessage::ServerRequest {
            request_id: "call_user_input".to_string(),
            request_type: ServerRequestType::UserInput,
            call_id: "call_user_input".to_string(),
            tool: "ask_user".to_string(),
            args: serde_json::json!({
                "questions": [{
                    "header": "Stack",
                    "question": "Which schema library should we use?",
                    "options": [{
                        "label": "Zod",
                        "description": "Use Zod schemas"
                    }]
                }]
            }),
            reason: "Agent requested structured user input".to_string(),
        });

        state.handle_sent_message(&ToAgentMessage::ServerRequestResponse {
            request_id: "call_user_input".to_string(),
            request_type: ServerRequestType::UserInput,
            approved: None,
            result: None,
            content: Some(vec![ClientToolResultContent::Text {
                text: "Use Zod".to_string(),
            }]),
            is_error: Some(false),
            decision_action: None,
            reason: None,
        });

        assert!(state.pending_user_inputs.is_empty());
        assert!(state.tracked_tools.contains_key("call_user_input"));
    }

    #[test]
    fn state_tracks_and_clears_tool_retry_requests_by_request_id() {
        let mut state = AgentState::default();

        state.handle_message(FromAgentMessage::ToolCall {
            call_id: "call_bash".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({ "command": "ls" }),
            requires_approval: false,
        });

        let event = state.handle_message(FromAgentMessage::ServerRequest {
            request_id: "retry_1".to_string(),
            request_type: ServerRequestType::ToolRetry,
            call_id: "call_bash".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({
                "tool_call_id": "call_bash",
                "args": { "command": "ls" },
                "error_message": "Command failed",
                "attempt": 1
            }),
            reason: "Retry bash command".to_string(),
        });

        assert!(event.is_none());
        assert_eq!(state.pending_tool_retries.len(), 1);
        assert_eq!(state.pending_tool_retries[0].call_id, "call_bash");
        assert_eq!(
            state.pending_tool_retries[0].request_id.as_deref(),
            Some("retry_1")
        );
        assert_eq!(
            state
                .tracked_tools
                .get("call_bash")
                .and_then(|tool| tool.args.get("command"))
                .and_then(serde_json::Value::as_str),
            Some("ls")
        );

        state.handle_sent_message(&ToAgentMessage::ServerRequestResponse {
            request_id: "retry_1".to_string(),
            request_type: ServerRequestType::ToolRetry,
            approved: None,
            result: None,
            content: None,
            is_error: None,
            decision_action: Some(ToolRetryDecisionAction::Retry),
            reason: Some("Try again".to_string()),
        });

        assert!(state.pending_tool_retries.is_empty());
        assert!(state.tracked_tools.contains_key("call_bash"));
    }

    #[test]
    fn state_clears_tracked_client_tool_on_cancelled_server_request() {
        let mut state = AgentState::default();

        state.handle_message(FromAgentMessage::ServerRequest {
            request_id: "call_client".to_string(),
            request_type: ServerRequestType::ClientTool,
            call_id: "call_client".to_string(),
            tool: "artifacts".to_string(),
            args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
            reason: "Client tool artifacts requires local execution".to_string(),
        });

        let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
            request_id: "call_client".to_string(),
            request_type: ServerRequestType::ClientTool,
            call_id: "call_client".to_string(),
            resolution: ServerRequestResolutionStatus::Cancelled,
            reason: Some("Interrupted before request completed".to_string()),
            resolved_by: ServerRequestResolvedBy::Runtime,
        });

        assert!(resolved.is_none());
        assert!(state.pending_client_tools.is_empty());
        assert!(!state.tracked_tools.contains_key("call_client"));
    }
}

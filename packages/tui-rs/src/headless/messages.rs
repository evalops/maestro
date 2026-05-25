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

pub(crate) const CODEX_SUBAGENT_TOOL_PREFIX: &str = "codex.subagent.";
pub(crate) const CODEX_SUBAGENT_WORK_GRAPH_SCHEMA: &str =
    "evalops.maestro.codex.subagent-workgraph.v1";

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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_execution_id: Option<String>,
        tool: String,
        args: serde_json::Value,
        requires_approval: bool,
    },
    /// Tool execution started
    ToolStart { call_id: String },
    /// Tool output chunk
    ToolOutput { call_id: String, content: String },
    /// Tool execution ended
    ToolEnd {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_execution_id: Option<String>,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
    },
    /// Client-side tool execution requested
    ClientToolRequest {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_execution_id: Option<String>,
        tool: String,
        args: serde_json::Value,
    },
    /// Structured server-to-client request (currently approvals)
    ServerRequest {
        request_id: String,
        request_type: ServerRequestType,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_execution_id: Option<String>,
        tool: String,
        args: serde_json::Value,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_at_ms: Option<u64>,
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
mod state;
#[allow(unused_imports)]
pub(crate) use state::{
    active_codex_subagent_status, codex_subagent_child_runs, codex_subagent_edge_key,
    codex_subagent_operation, codex_subagent_status_is_terminal, json_string_array_from_object,
    json_string_from_object, CodexSubagentChildRun, HEADLESS_OUTPUT_LIMIT,
};
pub use state::{
    ActiveFileWatch, ActiveTool, ActiveUtilityCommand, AgentEvent, AgentState,
    CodexSubagentContinuityEdge, PendingApproval, StreamingResponse,
};

#[cfg(test)]
mod tests;

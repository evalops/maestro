//! Session persistence for the headless protocol.
//!
//! Provides save/load/resume functionality for agent sessions using JSONL
//! (JSON Lines) format. This enables session replay, debugging, and conversation
//! history without requiring a database.
//!
//! # JSONL Format
//!
//! JSONL (JSON Lines) stores one JSON object per line:
//!
//! ```text
//! {"direction":"sent","timestamp":1234567890,"message":{"type":"prompt","content":"Hello"}}
//! {"direction":"received","timestamp":1234567891,"message":{"type":"ready","model":"claude-3-opus","provider":"anthropic"}}
//! {"direction":"received","timestamp":1234567892,"message":{"type":"response_chunk","response_id":"abc","content":"Hi","is_thinking":false}}
//! ```
//!
//! ## Why JSONL?
//!
//! - **Streaming writes** - Append new entries without rewriting entire file
//! - **Partial reads** - Process entries incrementally without loading full file
//! - **Crash recovery** - Previous entries remain valid even if write is interrupted
//! - **Line-based tools** - Compatible with `grep`, `sed`, `wc -l`, etc.
//! - **Human-readable** - Debug sessions with standard text tools
//!
//! ## File Structure
//!
//! Each session creates two files:
//!
//! - `{session_id}.jsonl` - JSONL file with all messages
//! - `{session_id}.meta.json` - JSON file with session metadata
//!
//! The metadata file is updated periodically and contains aggregated statistics
//! like token usage, message count, and session title.
//!
//! # Session Recording
//!
//! The `SessionRecorder` appends entries as they occur:
//!
//! ```rust,ignore
//! use maestro_tui::headless::session::SessionRecorder;
//! use maestro_tui::headless::ToAgentMessage;
//!
//! let mut recorder = SessionRecorder::new("/tmp/sessions")?;
//!
//! recorder.record_sent(&ToAgentMessage::Prompt {
//!     content: "Hello!".to_string(),
//!     attachments: None,
//! })?;
//!
//! recorder.flush()?; // Ensure writes are persisted
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Session Replay
//!
//! The `SessionReader` loads all entries from a session file:
//!
//! ```rust,ignore
//! use maestro_tui::headless::session::SessionReader;
//!
//! let reader = SessionReader::load("/tmp/sessions", "session-id")?;
//!
//! println!("Session: {}", reader.metadata().title.as_deref().unwrap_or("Untitled"));
//! println!("Messages: {}", reader.entries().len());
//!
//! for prompt in reader.prompts() {
//!     println!("User: {}", prompt);
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Buffered Writes
//!
//! `SessionRecorder` uses a `BufWriter` to batch writes, reducing filesystem
//! overhead. The buffer is automatically flushed:
//!
//! - When `flush()` is called explicitly
//! - When the recorder is dropped (via `Drop` implementation)
//! - When the internal buffer fills (typically 8KB)
//!
//! For reliability, call `flush()` after important events to ensure data is
//! persisted to disk.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::fs_atomic::create_dir_all_synced;

use super::messages::{
    ActiveFileWatch, ActiveTool, AgentState, CodexSubagentContinuityEdge, FromAgentMessage,
    InitConfig, PendingApproval, ServerRequestType, StreamingResponse, ToAgentMessage, TokenUsage,
};

/// A recorded session entry (either a sent or received message).
///
/// Represents a single message in the session history, tagged with direction
/// (sent to agent or received from agent) and timestamp.
///
/// # Serialization Format
///
/// Uses serde's `tag` attribute to add a `direction` discriminator:
///
/// ```json
/// {"direction":"sent","timestamp":1234567890,"message":{"type":"prompt","content":"Hello"}}
/// {"direction":"received","timestamp":1234567891,"message":{"type":"ready","model":"claude-3-opus","provider":"anthropic"}}
/// ```
///
/// # Timestamp Format
///
/// Timestamps are Unix milliseconds (milliseconds since 1970-01-01 00:00:00 UTC).
/// This provides millisecond precision for accurate timing analysis while remaining
/// compact and sortable as a numeric value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum SessionEntry {
    /// Message sent to the agent
    Sent {
        timestamp: u64,
        message: ToAgentMessage,
    },
    /// Message received from the agent
    Received {
        timestamp: u64,
        message: FromAgentMessage,
    },
    /// Periodic checkpoint of reconstructed runtime state.
    Checkpoint {
        timestamp: u64,
        state: Box<AgentStateCheckpoint>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_init: Option<InitConfig>,
    },
}

impl SessionEntry {
    /// Create a sent entry with current timestamp
    #[must_use]
    pub fn sent(message: ToAgentMessage) -> Self {
        SessionEntry::Sent {
            timestamp: current_timestamp(),
            message,
        }
    }

    /// Create a received entry with current timestamp
    #[must_use]
    pub fn received(message: FromAgentMessage) -> Self {
        SessionEntry::Received {
            timestamp: current_timestamp(),
            message,
        }
    }

    /// Get the timestamp of this entry
    #[must_use]
    pub fn timestamp(&self) -> u64 {
        match self {
            SessionEntry::Sent { timestamp, .. } => *timestamp,
            SessionEntry::Received { timestamp, .. } => *timestamp,
            SessionEntry::Checkpoint { timestamp, .. } => *timestamp,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveToolCheckpoint {
    pub call_id: String,
    pub tool: String,
    pub output: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveUtilityCommandCheckpoint {
    pub command_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub shell_mode: super::messages::UtilityCommandShellMode,
    pub terminal_mode: super::messages::UtilityCommandTerminalMode,
    pub pid: Option<u32>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
    pub owner_connection_id: Option<String>,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveFileWatchCheckpoint {
    pub watch_id: String,
    pub root_dir: String,
    pub include_patterns: Option<Vec<String>>,
    pub exclude_patterns: Option<Vec<String>>,
    pub debounce_ms: u32,
    pub owner_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentStateCheckpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<super::messages::ClientInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<super::messages::ClientCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opt_out_notifications: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_role: Option<super::messages::ConnectionRole>,
    #[serde(default)]
    pub connection_count: usize,
    #[serde(default)]
    pub subscriber_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_subscription_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_connection_id: Option<String>,
    #[serde(default)]
    pub connections: Vec<super::messages::ConnectionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_response: Option<StreamingResponse>,
    #[serde(default)]
    pub pending_approvals: Vec<PendingApproval>,
    #[serde(default)]
    pub pending_client_tools: Vec<PendingApproval>,
    #[serde(default)]
    pub pending_user_inputs: Vec<PendingApproval>,
    #[serde(default)]
    pub pending_tool_retries: Vec<PendingApproval>,
    #[serde(default)]
    pub tracked_tools: Vec<PendingApproval>,
    #[serde(default)]
    pub active_tools: Vec<ActiveToolCheckpoint>,
    #[serde(default)]
    pub codex_subagent_edges: Vec<CodexSubagentContinuityEdge>,
    #[serde(default)]
    pub active_utility_commands: Vec<ActiveUtilityCommandCheckpoint>,
    #[serde(default)]
    pub active_file_watches: Vec<ActiveFileWatchCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_type: Option<super::messages::HeadlessErrorType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ttft_ms: Option<u64>,
    #[serde(default)]
    pub is_ready: bool,
    #[serde(default)]
    pub is_responding: bool,
}

impl AgentStateCheckpoint {
    #[must_use]
    pub fn from_state(state: &AgentState) -> Self {
        Self {
            protocol_version: state.protocol_version.clone(),
            client_protocol_version: state.client_protocol_version.clone(),
            client_info: state.client_info.clone(),
            capabilities: state.capabilities.clone(),
            opt_out_notifications: state.opt_out_notifications.clone(),
            connection_role: state.connection_role,
            connection_count: state.connection_count,
            subscriber_count: state.subscriber_count,
            controller_subscription_id: state.controller_subscription_id.clone(),
            controller_connection_id: state.controller_connection_id.clone(),
            connections: state.connections.clone(),
            model: state.model.clone(),
            provider: state.provider.clone(),
            session_id: state.session_id.clone(),
            cwd: state.cwd.clone(),
            git_branch: state.git_branch.clone(),
            current_response: state.current_response.clone(),
            pending_approvals: state.pending_approvals.clone(),
            pending_client_tools: state.pending_client_tools.clone(),
            pending_user_inputs: state.pending_user_inputs.clone(),
            pending_tool_retries: state.pending_tool_retries.clone(),
            tracked_tools: state.tracked_tools.values().cloned().collect(),
            active_tools: state
                .active_tools
                .values()
                .map(|tool| ActiveToolCheckpoint {
                    call_id: tool.call_id.clone(),
                    tool: tool.tool.clone(),
                    output: tool.output.clone(),
                    elapsed_ms: tool.started.elapsed().as_millis() as u64,
                })
                .collect(),
            codex_subagent_edges: state.codex_subagent_edges.clone(),
            active_utility_commands: state
                .active_utility_commands
                .values()
                .map(|command| ActiveUtilityCommandCheckpoint {
                    command_id: command.command_id.clone(),
                    command: command.command.clone(),
                    cwd: command.cwd.clone(),
                    shell_mode: command.shell_mode,
                    terminal_mode: command.terminal_mode,
                    pid: command.pid,
                    columns: command.columns,
                    rows: command.rows,
                    owner_connection_id: command.owner_connection_id.clone(),
                    output: command.output.clone(),
                })
                .collect(),
            active_file_watches: state
                .active_file_watches
                .values()
                .map(|watch| ActiveFileWatchCheckpoint {
                    watch_id: watch.watch_id.clone(),
                    root_dir: watch.root_dir.clone(),
                    include_patterns: watch.include_patterns.clone(),
                    exclude_patterns: watch.exclude_patterns.clone(),
                    debounce_ms: watch.debounce_ms,
                    owner_connection_id: watch.owner_connection_id.clone(),
                })
                .collect(),
            last_error: state.last_error.clone(),
            last_error_type: state.last_error_type,
            last_status: state.last_status.clone(),
            last_response_duration_ms: state.last_response_duration_ms,
            last_ttft_ms: state.last_ttft_ms,
            is_ready: state.is_ready,
            is_responding: state.is_responding,
        }
    }

    #[must_use]
    pub fn into_state(self) -> AgentState {
        AgentState {
            protocol_version: self.protocol_version,
            client_protocol_version: self.client_protocol_version,
            client_info: self.client_info,
            capabilities: self.capabilities,
            opt_out_notifications: self.opt_out_notifications,
            connection_role: self.connection_role,
            connection_count: self.connection_count,
            subscriber_count: self.subscriber_count,
            controller_subscription_id: self.controller_subscription_id,
            controller_connection_id: self.controller_connection_id,
            connections: self.connections,
            model: self.model,
            provider: self.provider,
            session_id: self.session_id,
            cwd: self.cwd,
            git_branch: self.git_branch,
            current_response: self.current_response,
            pending_approvals: self.pending_approvals,
            pending_client_tools: self.pending_client_tools,
            pending_user_inputs: self.pending_user_inputs,
            pending_tool_retries: self.pending_tool_retries,
            tracked_tools: self
                .tracked_tools
                .into_iter()
                .map(|tool| (tool.call_id.clone(), tool))
                .collect::<HashMap<_, _>>(),
            active_tools: self
                .active_tools
                .into_iter()
                .map(|tool| {
                    let started = std::time::Instant::now()
                        .checked_sub(Duration::from_millis(tool.elapsed_ms))
                        .unwrap_or_else(std::time::Instant::now);
                    (
                        tool.call_id.clone(),
                        ActiveTool {
                            call_id: tool.call_id,
                            tool: tool.tool,
                            output: tool.output,
                            started,
                        },
                    )
                })
                .collect(),
            codex_subagent_edges: self.codex_subagent_edges,
            active_utility_commands: self
                .active_utility_commands
                .into_iter()
                .map(|command| {
                    (
                        command.command_id.clone(),
                        super::messages::ActiveUtilityCommand {
                            command_id: command.command_id,
                            command: command.command,
                            cwd: command.cwd,
                            shell_mode: command.shell_mode,
                            terminal_mode: command.terminal_mode,
                            pid: command.pid,
                            columns: command.columns,
                            rows: command.rows,
                            owner_connection_id: command.owner_connection_id,
                            output: command.output,
                        },
                    )
                })
                .collect::<HashMap<_, _>>(),
            active_file_watches: self
                .active_file_watches
                .into_iter()
                .map(|watch| {
                    (
                        watch.watch_id.clone(),
                        ActiveFileWatch {
                            watch_id: watch.watch_id,
                            root_dir: watch.root_dir,
                            include_patterns: watch.include_patterns,
                            exclude_patterns: watch.exclude_patterns,
                            debounce_ms: watch.debounce_ms,
                            owner_connection_id: watch.owner_connection_id,
                        },
                    )
                })
                .collect::<HashMap<_, _>>(),
            last_error: self.last_error,
            last_error_type: self.last_error_type,
            last_status: self.last_status,
            last_response_duration_ms: self.last_response_duration_ms,
            last_ttft_ms: self.last_ttft_ms,
            is_ready: self.is_ready,
            is_responding: self.is_responding,
        }
    }
}

/// Session metadata stored in a separate file.
///
/// Contains aggregated statistics and metadata about a session, stored as a
/// separate JSON file alongside the JSONL message log.
///
/// # Purpose
///
/// The metadata file enables:
/// - **Fast session listing** - Read metadata without parsing JSONL
/// - **Session search** - Find sessions by title, model, or date
/// - **Usage tracking** - Aggregate token counts and costs
/// - **Session preview** - Display title and stats without full load
///
/// # Update Strategy
///
/// Metadata is updated incrementally as messages are recorded and flushed
/// to disk when:
/// - `SessionRecorder::flush()` is called
/// - The recorder is dropped
///
/// This ensures metadata stays synchronized with the message log even if
/// the process crashes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetadata {
    /// Session ID
    pub id: String,
    /// When the session was created
    pub created_at: u64,
    /// When the session was last updated
    pub updated_at: u64,
    /// Session title (first user message, truncated)
    pub title: Option<String>,
    /// Model used in this session
    pub model: Option<String>,
    /// Provider used in this session
    pub provider: Option<String>,
    /// Headless protocol version reported by the agent
    #[serde(default)]
    pub protocol_version: Option<String>,
    /// Session ID reported by the agent itself
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Working directory
    pub cwd: Option<String>,
    /// Git branch (if any)
    pub git_branch: Option<String>,
    /// Total input tokens used
    pub total_input_tokens: u64,
    /// Total output tokens used
    pub total_output_tokens: u64,
    /// Number of messages in session
    pub message_count: usize,
}

impl SessionMetadata {
    /// Create new session metadata
    pub fn new(id: impl Into<String>) -> Self {
        let now = current_timestamp();
        Self {
            id: id.into(),
            created_at: now,
            updated_at: now,
            title: None,
            model: None,
            provider: None,
            protocol_version: None,
            agent_session_id: None,
            cwd: None,
            git_branch: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
            message_count: 0,
        }
    }

    /// Update title from first user prompt
    pub fn set_title_from_prompt(&mut self, content: &str) {
        if self.title.is_none() {
            let title = content.lines().next().unwrap_or(content);
            let chars: Vec<char> = title.chars().collect();
            let title = if chars.len() > 80 {
                format!("{}...", chars[..77].iter().collect::<String>())
            } else {
                title.to_string()
            };
            self.title = Some(title);
        }
    }

    /// Update token usage
    pub fn add_usage(&mut self, usage: &TokenUsage) {
        self.total_input_tokens += usage.input_tokens;
        self.total_output_tokens += usage.output_tokens;
    }
}

/// Session recorder - appends entries to a JSONL file.
///
/// Provides append-only recording of session messages to a JSONL file, with
/// automatic metadata tracking and buffered writes for performance.
///
/// # Lifecycle
///
/// 1. Create with `new()` or `resume()` an existing session
/// 2. Record messages with `record_sent()` and `record_received()`
/// 3. Flush periodically with `flush()` to persist to disk
/// 4. Automatic cleanup on drop (flushes remaining data)
///
/// # Buffering
///
/// Uses a `BufWriter` internally to batch writes. This significantly improves
/// performance for high-frequency message streams by reducing syscall overhead.
///
/// Call `flush()` explicitly after important events to ensure data is persisted,
/// especially before operations that might crash or terminate the process.
///
/// # File Safety
///
/// - Opens files in append mode (`OpenOptions::append(true)`)
/// - Creates parent directories automatically
/// - Flushes on drop to prevent data loss
/// - Metadata is written atomically (overwrites entire file)
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_tui::headless::session::SessionRecorder;
/// use maestro_tui::headless::ToAgentMessage;
///
/// let mut recorder = SessionRecorder::new("/tmp/sessions")?;
/// println!("Session ID: {}", recorder.id());
///
/// recorder.record_sent(&ToAgentMessage::Prompt {
///     content: "Hello".to_string(),
///     attachments: None,
/// })?;
///
/// recorder.flush()?; // Ensure persistence
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub struct SessionRecorder {
    /// Session ID
    id: String,
    /// Path to the session JSONL file
    path: PathBuf,
    /// Buffered writer for appending entries
    writer: BufWriter<File>,
    /// Session metadata
    metadata: SessionMetadata,
    /// Path to metadata file
    metadata_path: PathBuf,
    /// Reconstructed state including optimistic outbound actions.
    replay_state: AgentState,
    /// Last init message seen in the stream.
    last_init: Option<InitConfig>,
    /// Number of entries written since the last checkpoint.
    entries_since_checkpoint: usize,
}

const CHECKPOINT_INTERVAL: usize = 25;

/// Load `<id>.meta.json`, tolerating a corrupt or torn file left by a crash
/// mid-write.
///
/// A missing file yields fresh default metadata (normal for a brand-new
/// session). A file that exists but fails to parse is forensic evidence of
/// real damage (the pre-atomic-write code path here used a direct
/// `fs::write`, so a `kill -9` mid-write could truncate it); rather than
/// silently discarding that evidence or hard-failing the caller, the file is
/// rotated aside (`<id>.meta.json.corrupt.<millis>`) and fresh default
/// metadata is returned so `resume`/`list_sessions` still see the session
/// instead of treating it as gone. Only I/O errors (permissions, etc.) are
/// propagated as hard errors.
///
/// The returned flag is `true` when the metadata was reconstructed after
/// corruption, so callers can rebuild the lost fields from the still-intact
/// JSONL log via [`rebuild_metadata`].
fn load_metadata_tolerant(
    metadata_path: &Path,
    id: &str,
) -> std::io::Result<(SessionMetadata, bool)> {
    if !metadata_path.exists() {
        return Ok((SessionMetadata::new(id), false));
    }
    // Read bytes, not `read_to_string`: a file torn mid-write by a crash
    // (the whole reason this function tolerates a parse failure) can just
    // as easily be torn in the middle of a multi-byte UTF-8 character as
    // in the middle of a JSON token. `read_to_string` would then fail with
    // `InvalidData` from the `?` above before the tolerant JSON-parsing
    // branch below ever runs, hard-failing the caller instead of rotating
    // the file aside and reconstructing defaults like every other kind of
    // corruption here.
    let content = fs::read(metadata_path)?;
    match serde_json::from_slice(&content) {
        Ok(metadata) => Ok((metadata, false)),
        Err(err) => {
            eprintln!(
                "Corrupt session metadata at {}: {err}. Rotating aside and reconstructing defaults.",
                metadata_path.display()
            );
            crate::fs_atomic::rotate_corrupt_aside(metadata_path);
            Ok((SessionMetadata::new(id), true))
        }
    }
}

/// Reconstruct metadata by folding the JSONL log entries, mirroring the
/// incremental updates `record_sent`/`record_received` apply. Used when the
/// persisted metadata file was corrupt and had to be rotated aside, so the
/// historical title, model, token totals, and message count are not
/// permanently reset to defaults.
fn rebuild_metadata(id: &str, entries: &[SessionEntry]) -> SessionMetadata {
    let mut metadata = SessionMetadata::new(id);
    if let Some(first) = entries.first() {
        metadata.created_at = first.timestamp();
    }
    for entry in entries {
        match entry {
            SessionEntry::Sent { message, .. } => {
                if let ToAgentMessage::Prompt { content, .. } = message {
                    metadata.set_title_from_prompt(content);
                }
                metadata.message_count += 1;
            }
            SessionEntry::Received { message, .. } => {
                match message {
                    FromAgentMessage::Ready {
                        protocol_version,
                        model,
                        provider,
                        session_id,
                    } => {
                        metadata.model = Some(model.clone());
                        metadata.provider = Some(provider.clone());
                        metadata.protocol_version = protocol_version.clone();
                        if session_id.is_some() {
                            metadata.agent_session_id = session_id.clone();
                        }
                    }
                    FromAgentMessage::SessionInfo {
                        session_id,
                        cwd,
                        git_branch,
                    } => {
                        if session_id.is_some() {
                            metadata.agent_session_id = session_id.clone();
                        }
                        metadata.cwd = Some(cwd.clone());
                        metadata.git_branch = git_branch.clone();
                    }
                    FromAgentMessage::ResponseEnd {
                        usage: Some(usage), ..
                    } => {
                        metadata.add_usage(usage);
                    }
                    _ => {}
                }
                metadata.message_count += 1;
            }
            SessionEntry::Checkpoint { .. } => {}
        }
        metadata.updated_at = entry.timestamp();
    }
    metadata
}

impl SessionRecorder {
    /// Create a new session recorder
    pub fn new(sessions_dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::with_id(sessions_dir, &id)
    }

    /// Create a session recorder with a specific ID
    pub fn with_id(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        create_dir_all_synced(sessions_dir)?;

        let path = sessions_dir.join(format!("{id}.jsonl"));
        let metadata_path = sessions_dir.join(format!("{id}.meta.json"));

        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let writer = BufWriter::new(file);

        let metadata = SessionMetadata::new(id);

        Ok(Self {
            id: id.to_string(),
            path,
            writer,
            metadata,
            metadata_path,
            replay_state: AgentState::default(),
            last_init: None,
            entries_since_checkpoint: 0,
        })
    }

    /// Resume an existing session
    pub fn resume(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        create_dir_all_synced(sessions_dir)?;
        let path = sessions_dir.join(format!("{id}.jsonl"));
        let metadata_path = sessions_dir.join(format!("{id}.meta.json"));

        // Load existing metadata
        let (mut metadata, reconstructed) = load_metadata_tolerant(&metadata_path, id)?;

        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let writer = BufWriter::new(file);
        let reader = SessionReader::load(sessions_dir, id).ok();
        if reconstructed {
            // The corrupt metadata was rotated aside; rebuild what it held
            // (title, model, usage, counts) from the still-intact JSONL log
            // so the next flush doesn't permanently reset them to defaults.
            if let Some(reader) = &reader {
                metadata = rebuild_metadata(id, reader.entries());
            }
        }
        let replay = reader.map(|reader| reader.replay());

        Ok(Self {
            id: id.to_string(),
            path,
            writer,
            metadata,
            metadata_path,
            replay_state: replay
                .as_ref()
                .map_or_else(AgentState::default, |replay| replay.state.clone()),
            last_init: replay.and_then(|replay| replay.last_init),
            entries_since_checkpoint: 0,
        })
    }

    /// Get the session ID
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the path to the session JSONL file
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the session metadata
    #[must_use]
    pub fn metadata(&self) -> &SessionMetadata {
        &self.metadata
    }

    /// Get the current replay state tracked by the recorder.
    #[must_use]
    pub fn replay_state(&self) -> &AgentState {
        &self.replay_state
    }

    /// Get the last init config tracked by the recorder.
    #[must_use]
    pub fn last_init(&self) -> Option<&InitConfig> {
        self.last_init.as_ref()
    }

    /// Replace the reconstructed replay state with a snapshot and persist it.
    pub fn apply_snapshot(
        &mut self,
        state: AgentState,
        last_init: Option<InitConfig>,
    ) -> std::io::Result<()> {
        self.replay_state = state;
        self.last_init = last_init;
        self.metadata.model = self.replay_state.model.clone();
        self.metadata.provider = self.replay_state.provider.clone();
        self.metadata.protocol_version = self.replay_state.protocol_version.clone();
        if self.replay_state.session_id.is_some() {
            self.metadata.agent_session_id = self.replay_state.session_id.clone();
        }
        self.metadata.cwd = self.replay_state.cwd.clone();
        self.metadata.git_branch = self.replay_state.git_branch.clone();
        self.metadata.updated_at = current_timestamp();
        self.maybe_write_checkpoint(true)
    }

    /// Record a sent message
    pub fn record_sent(&mut self, message: &ToAgentMessage) -> std::io::Result<()> {
        let entry = SessionEntry::sent(message.clone());
        self.write_entry(&entry)?;
        self.replay_state.handle_sent_message(message);
        if let ToAgentMessage::Init {
            system_prompt,
            append_system_prompt,
            thinking_level,
            approval_mode,
            history,
        } = message
        {
            self.last_init = Some(InitConfig {
                system_prompt: system_prompt.clone(),
                append_system_prompt: append_system_prompt.clone(),
                thinking_level: *thinking_level,
                approval_mode: *approval_mode,
                history: history.clone(),
            });
        }
        self.entries_since_checkpoint += 1;
        self.maybe_write_checkpoint(false)?;

        // Update metadata
        if let ToAgentMessage::Prompt { content, .. } = message {
            self.metadata.set_title_from_prompt(content);
        }
        self.metadata.message_count += 1;
        self.metadata.updated_at = current_timestamp();

        Ok(())
    }

    /// Record a received message
    pub fn record_received(&mut self, message: &FromAgentMessage) -> std::io::Result<()> {
        let entry = SessionEntry::received(portable_redacted_message(message));
        self.write_entry(&entry)?;
        let _ = self.replay_state.handle_message(message.clone());
        self.entries_since_checkpoint += 1;
        self.maybe_write_checkpoint(matches!(
            message,
            FromAgentMessage::ResponseEnd { .. }
                | FromAgentMessage::Error { .. }
                | FromAgentMessage::Compaction { .. }
        ))?;

        // Update metadata
        match message {
            FromAgentMessage::Ready {
                protocol_version,
                model,
                provider,
                session_id,
            } => {
                self.metadata.model = Some(model.clone());
                self.metadata.provider = Some(provider.clone());
                self.metadata.protocol_version = protocol_version.clone();
                if session_id.is_some() {
                    self.metadata.agent_session_id = session_id.clone();
                }
            }
            FromAgentMessage::SessionInfo {
                session_id,
                cwd,
                git_branch,
            } => {
                if session_id.is_some() {
                    self.metadata.agent_session_id = session_id.clone();
                }
                self.metadata.cwd = Some(cwd.clone());
                self.metadata.git_branch = git_branch.clone();
            }
            FromAgentMessage::ResponseEnd {
                usage: Some(usage), ..
            } => {
                self.metadata.add_usage(usage);
            }
            _ => {}
        }
        self.metadata.message_count += 1;
        self.metadata.updated_at = current_timestamp();

        Ok(())
    }

    fn maybe_write_checkpoint(&mut self, force: bool) -> std::io::Result<()> {
        if !force && self.entries_since_checkpoint < CHECKPOINT_INTERVAL {
            return Ok(());
        }

        let checkpoint = SessionEntry::Checkpoint {
            timestamp: current_timestamp(),
            state: Box::new(portable_redacted_checkpoint(&self.replay_state)),
            last_init: self.last_init.clone(),
        };
        self.write_entry(&checkpoint)?;
        self.entries_since_checkpoint = 0;
        Ok(())
    }

    /// Write an entry to the JSONL file
    fn write_entry(&mut self, entry: &SessionEntry) -> std::io::Result<()> {
        let json = serde_json::to_string(entry)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writeln!(self.writer, "{json}")?;
        self.writer.flush()?;
        Ok(())
    }

    /// Flush and save metadata
    pub fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()?;
        // Make the JSONL log itself durable *before* persisting metadata
        // that describes it (message counts, usage totals, timestamps).
        // `BufWriter::flush` only transfers bytes to the OS; `save_metadata`
        // below now goes through `write_atomic`, which does fsync the
        // metadata file. Without this, a power loss right after `flush()`
        // returns could keep that durable metadata while losing the very
        // log entries it describes, leaving metadata durably ahead of the
        // actual session history on the next load.
        self.writer.get_ref().sync_all()?;
        self.save_metadata()?;
        Ok(())
    }

    /// Save metadata to file
    fn save_metadata(&self) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(&self.metadata)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        crate::fs_atomic::write_atomic(&self.metadata_path, json)?;
        Ok(())
    }
}

fn portable_redacted_message(message: &FromAgentMessage) -> FromAgentMessage {
    let mut redacted = message.clone();
    let args = match &mut redacted {
        FromAgentMessage::ClientToolRequest { args, .. }
        | FromAgentMessage::ServerRequest {
            request_type: ServerRequestType::ClientTool,
            args,
            ..
        } => Some(args),
        _ => None,
    };
    if let Some(args) = args {
        *args = crate::agent::credential_store::redact_credentials_in_json(args);
    }
    redacted
}

fn portable_redacted_checkpoint(state: &AgentState) -> AgentStateCheckpoint {
    let mut checkpoint = AgentStateCheckpoint::from_state(state);
    for pending in checkpoint
        .pending_client_tools
        .iter_mut()
        .chain(checkpoint.tracked_tools.iter_mut())
    {
        pending.args = crate::agent::credential_store::redact_credentials_in_json(&pending.args);
    }
    checkpoint
}

impl Drop for SessionRecorder {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

/// Session reader - loads entries from a JSONL file.
///
/// Loads a complete session from disk, including all messages and metadata.
/// Provides convenient methods for filtering and analyzing session history.
///
/// # Memory Considerations
///
/// `SessionReader` loads the entire session into memory. For very long sessions
/// (thousands of messages), this may consume significant memory. Consider
/// implementing streaming/pagination for production use with large sessions.
///
/// # Error Handling
///
/// Parse errors for individual entries are logged to stderr but don't prevent
/// loading the rest of the session. This provides resilience against corrupted
/// or incompatible entries in old session files.
///
/// # Examples
///
/// ```rust,ignore
/// use maestro_tui::headless::session::SessionReader;
///
/// let reader = SessionReader::load("/tmp/sessions", "session-id")?;
///
/// println!("Session: {}", reader.metadata().title.as_deref().unwrap_or("Untitled"));
/// println!("Total messages: {}", reader.entries().len());
/// println!("User prompts: {}", reader.prompts().len());
///
/// // Analyze conversation
/// for (i, prompt) in reader.prompts().iter().enumerate() {
///     println!("{}. {}", i + 1, prompt);
/// }
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub struct SessionReader {
    /// Session ID
    id: String,
    /// Loaded entries
    entries: Vec<SessionEntry>,
    /// Session metadata
    metadata: SessionMetadata,
}

/// Reconstructed headless session state derived from the recorded JSONL log.
#[derive(Debug, Clone)]
pub struct SessionReplay {
    /// Current reconstructed agent state after replaying recorded events.
    pub state: AgentState,
    /// Most recent init configuration sent to the headless agent, if any.
    pub last_init: Option<InitConfig>,
}

fn persist_rebuilt_metadata(path: &Path, metadata: &SessionMetadata) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(metadata)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    crate::fs_atomic::write_atomic(path, json)
}

impl SessionReader {
    /// Load a session from disk
    pub fn load(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        let path = sessions_dir.join(format!("{id}.jsonl"));
        let metadata_path = sessions_dir.join(format!("{id}.meta.json"));

        // Load metadata
        let (metadata, reconstructed) = load_metadata_tolerant(&metadata_path, id)?;

        // Load entries
        let mut entries = Vec::new();
        if path.exists() {
            let file = File::open(&path)?;
            let reader = BufReader::new(file);
            for line in reader.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<SessionEntry>(&line) {
                    Ok(entry) => entries.push(entry),
                    Err(e) => {
                        eprintln!("Warning: Failed to parse session entry: {e}");
                    }
                }
            }
        }

        // `load_metadata_tolerant` already rotated the corrupt file aside
        // above but, unlike `SessionRecorder::resume`, this is a read-only
        // path with no later `flush()` to persist a replacement -- so
        // without rebuilding and writing one back here, calling this
        // function directly (rather than through `resume`) would both
        // discard the title/usage/counts recoverable from these
        // just-loaded entries (falling back to bare defaults) and leave
        // the session with no `.meta.json` at all, making it invisible to
        // a later `list_sessions` scan.
        let metadata = if reconstructed {
            let rebuilt = rebuild_metadata(id, &entries);
            persist_rebuilt_metadata(&metadata_path, &rebuilt)?;
            rebuilt
        } else {
            metadata
        };

        Ok(Self {
            id: id.to_string(),
            entries,
            metadata,
        })
    }

    /// Get the session ID
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the session metadata
    #[must_use]
    pub fn metadata(&self) -> &SessionMetadata {
        &self.metadata
    }

    /// Get all entries
    #[must_use]
    pub fn entries(&self) -> &[SessionEntry] {
        &self.entries
    }

    /// Get only sent messages
    #[must_use]
    pub fn sent_messages(&self) -> Vec<&ToAgentMessage> {
        self.entries
            .iter()
            .filter_map(|e| match e {
                SessionEntry::Sent { message, .. } => Some(message),
                _ => None,
            })
            .collect()
    }

    /// Get only received messages
    #[must_use]
    pub fn received_messages(&self) -> Vec<&FromAgentMessage> {
        self.entries
            .iter()
            .filter_map(|e| match e {
                SessionEntry::Received { message, .. } => Some(message),
                _ => None,
            })
            .collect()
    }

    /// Get user prompts only
    #[must_use]
    pub fn prompts(&self) -> Vec<&str> {
        self.entries
            .iter()
            .filter_map(|e| match e {
                SessionEntry::Sent {
                    message: ToAgentMessage::Prompt { content, .. },
                    ..
                } => Some(content.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Return the last init configuration sent to the headless agent, if any.
    #[must_use]
    pub fn last_init(&self) -> Option<InitConfig> {
        self.replay().last_init
    }

    /// Replay the recorded agent messages into an `AgentState`.
    #[must_use]
    pub fn replay_state(&self) -> AgentState {
        self.replay().state
    }

    fn replay_parts(&self) -> (AgentState, Option<InitConfig>) {
        let mut state = AgentState::default();
        let mut last_init = None;
        let mut start_index = 0;

        for (index, entry) in self.entries.iter().enumerate() {
            if let SessionEntry::Checkpoint {
                state: checkpoint,
                last_init: checkpoint_init,
                ..
            } = entry
            {
                state = checkpoint.as_ref().clone().into_state();
                last_init = checkpoint_init.clone();
                start_index = index + 1;
            }
        }

        for entry in &self.entries[start_index..] {
            match entry {
                SessionEntry::Sent { message, .. } => {
                    state.handle_sent_message(message);
                    if let ToAgentMessage::Init {
                        system_prompt,
                        append_system_prompt,
                        thinking_level,
                        approval_mode,
                        history,
                    } = message
                    {
                        last_init = Some(InitConfig {
                            system_prompt: system_prompt.clone(),
                            append_system_prompt: append_system_prompt.clone(),
                            thinking_level: *thinking_level,
                            approval_mode: *approval_mode,
                            history: history.clone(),
                        });
                    }
                }
                SessionEntry::Received { message, .. } => {
                    let _ = state.handle_message(message.clone());
                }
                SessionEntry::Checkpoint { .. } => {}
            }
        }
        (state, last_init)
    }

    /// Build a resumable snapshot from the recorded session log.
    #[must_use]
    pub fn replay(&self) -> SessionReplay {
        let (state, last_init) = self.replay_parts();
        SessionReplay { state, last_init }
    }
}

/// List available sessions in a directory
pub fn list_sessions(sessions_dir: impl AsRef<Path>) -> std::io::Result<Vec<SessionMetadata>> {
    let sessions_dir = sessions_dir.as_ref();
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    // Collect entries up front: a corrupt metadata file is rebuilt and
    // re-persisted below, and a live directory iterator could observe the
    // newly written file and list the session twice.
    let entries = fs::read_dir(sessions_dir)?.collect::<std::io::Result<Vec<_>>>()?;
    for entry in entries {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".meta.json"))
        {
            // Read bytes, not `read_to_string`: a `.meta.json` torn
            // mid-write by a crash can be torn in the middle of a
            // multi-byte UTF-8 character just as easily as in the middle
            // of a JSON token, and `read_to_string` failing on that would
            // otherwise skip this whole `if let` block (and, per the
            // comment below, silently drop the session from the listing)
            // without ever reaching the same rotate-and-rebuild recovery a
            // JSON-parse failure already gets.
            if let Ok(content) = fs::read(&path) {
                match serde_json::from_slice::<SessionMetadata>(&content) {
                    Ok(meta) => sessions.push(meta),
                    Err(err) => {
                        // Previously this silently dropped the session from
                        // the listing, making a crash-torn metadata file
                        // look identical to "session never existed". Rotate
                        // the corrupt file aside, rebuild the metadata from
                        // the still-intact JSONL log, and persist the
                        // reconstruction so the session stays discoverable
                        // in subsequent listings.
                        let id = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .and_then(|n| n.strip_suffix(".meta.json"))
                            .unwrap_or("unknown");
                        eprintln!(
                            "Corrupt session metadata at {}: {err}. Rotating aside and reconstructing from the JSONL log.",
                            path.display()
                        );
                        crate::fs_atomic::rotate_corrupt_aside(&path);
                        let meta = match SessionReader::load(sessions_dir, id) {
                            Ok(reader) => rebuild_metadata(id, reader.entries()),
                            Err(_) => SessionMetadata::new(id),
                        };
                        persist_rebuilt_metadata(&path, &meta)?;
                        sessions.push(meta);
                    }
                }
            }
        }
    }

    // Sort by updated_at descending (most recent first)
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));

    Ok(sessions)
}

/// Delete a session
pub fn delete_session(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<()> {
    let sessions_dir = sessions_dir.as_ref();
    let jsonl_path = sessions_dir.join(format!("{id}.jsonl"));
    let meta_path = sessions_dir.join(format!("{id}.meta.json"));

    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path)?;
    }
    if meta_path.exists() {
        fs::remove_file(&meta_path)?;
    }

    Ok(())
}

/// Get current timestamp as unix millis
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_session_record_and_load() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        // Create and record a session
        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();

        // Record a prompt
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Hello, world!".to_string(),
                attachments: None,
            })
            .unwrap();

        // Record a response
        recorder
            .record_received(&FromAgentMessage::Ready {
                protocol_version: Some("2026-03-30".to_string()),
                model: "claude-3-opus".to_string(),
                provider: "anthropic".to_string(),
                session_id: Some("sess_123".to_string()),
            })
            .unwrap();

        recorder.flush().unwrap();
        drop(recorder);

        // Load the session
        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(reader.entries().len(), 2);
        assert_eq!(reader.prompts().len(), 1);
        assert_eq!(reader.prompts()[0], "Hello, world!");
        assert_eq!(reader.metadata().title.as_deref(), Some("Hello, world!"));
        assert_eq!(reader.metadata().model.as_deref(), Some("claude-3-opus"));
        assert_eq!(
            reader.metadata().protocol_version.as_deref(),
            Some("2026-03-30")
        );
        assert_eq!(
            reader.metadata().agent_session_id.as_deref(),
            Some("sess_123")
        );
    }

    #[test]
    fn recorder_entry_points_create_missing_session_directories() {
        let tmp = TempDir::new().unwrap();
        let new_sessions = tmp.path().join("new").join("sessions");
        let resumed_sessions = tmp.path().join("resumed").join("sessions");

        let new_recorder = SessionRecorder::with_id(&new_sessions, "new-session").unwrap();
        assert!(new_sessions.is_dir());
        assert!(new_recorder.path().exists());

        let resumed_recorder =
            SessionRecorder::resume(&resumed_sessions, "resumed-session").unwrap();
        assert!(resumed_sessions.is_dir());
        assert!(resumed_recorder.path().exists());
    }

    #[test]
    fn received_executable_args_are_portable_redacted_before_persistence() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();
        let client_secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
        let server_secret = "correct-horse-battery-staple";

        let mut recorder = SessionRecorder::with_id(sessions_dir, "redacted-session").unwrap();
        recorder
            .record_received(&FromAgentMessage::ClientToolRequest {
                call_id: "client-call".to_string(),
                tool_execution_id: None,
                tool: "bash".to_string(),
                args: serde_json::json!({
                    "command": format!(
                        "curl -H 'Authorization: Bearer {client_secret}' example.test"
                    )
                }),
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::ServerRequest {
                request_id: "server-request".to_string(),
                request_type: ServerRequestType::ClientTool,
                call_id: "server-call".to_string(),
                tool_execution_id: None,
                tool: "http".to_string(),
                args: serde_json::json!({
                    "payload": format!("password={server_secret}"),
                }),
                reason: "execute on client".to_string(),
                started_at_ms: None,
            })
            .unwrap();

        let live_args = serde_json::to_string(&recorder.replay_state().pending_client_tools)
            .expect("serialize live pending client tools");
        assert!(live_args.contains(client_secret));
        assert!(live_args.contains(server_secret));
        recorder.maybe_write_checkpoint(true).unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let jsonl =
            fs::read_to_string(sessions_dir.join("redacted-session.jsonl")).expect("read JSONL");
        assert!(!jsonl.contains(client_secret), "{jsonl}");
        assert!(!jsonl.contains(server_secret), "{jsonl}");
        assert!(
            jsonl.contains("[REDACTED:token:portable-export]"),
            "{jsonl}"
        );
        assert!(
            jsonl.contains("[REDACTED:password:portable-export]"),
            "{jsonl}"
        );

        let reader = SessionReader::load(sessions_dir, "redacted-session").unwrap();
        let recorded =
            serde_json::to_string(reader.received_messages().as_slice()).expect("serialize replay");
        let replayed = serde_json::to_string(&reader.replay_state().pending_client_tools)
            .expect("replay state");
        for persisted in [&recorded, &replayed] {
            assert!(!persisted.contains(client_secret), "{persisted}");
            assert!(!persisted.contains(server_secret), "{persisted}");
            assert!(persisted.contains("[REDACTED:"), "{persisted}");
        }
    }

    #[test]
    fn test_session_reader_replay_restores_state_and_init() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();

        recorder
            .record_sent(&ToAgentMessage::Init {
                system_prompt: Some("You are Maestro".to_string()),
                append_system_prompt: Some("Stay concise".to_string()),
                thinking_level: Some(super::super::messages::ThinkingLevel::High),
                approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
                history: None,
            })
            .unwrap();

        recorder
            .record_received(&FromAgentMessage::Ready {
                protocol_version: Some("2026-03-30".to_string()),
                model: "claude-3-opus".to_string(),
                provider: "anthropic".to_string(),
                session_id: Some("sess_ready".to_string()),
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::SessionInfo {
                session_id: Some("sess_info".to_string()),
                cwd: "/tmp/project".to_string(),
                git_branch: Some("main".to_string()),
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::ResponseStart {
                response_id: "resp_1".to_string(),
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::ResponseChunk {
                response_id: "resp_1".to_string(),
                content: "Partial reply".to_string(),
                is_thinking: false,
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::ToolCall {
                call_id: "call_1".to_string(),
                tool_execution_id: None,
                tool: "bash".to_string(),
                args: serde_json::json!({ "cmd": "git status" }),
                requires_approval: true,
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::UtilityCommandStarted {
                command_id: "cmd_owned".to_string(),
                command: "echo hi".to_string(),
                cwd: Some("/tmp/project".to_string()),
                shell_mode: super::super::messages::UtilityCommandShellMode::Direct,
                terminal_mode: super::super::messages::UtilityCommandTerminalMode::Pipe,
                pid: Some(1234),
                columns: None,
                rows: None,
                owner_connection_id: Some("conn_owned".to_string()),
            })
            .unwrap();
        recorder
            .record_received(&FromAgentMessage::UtilityFileWatchStarted {
                watch_id: "watch_owned".to_string(),
                root_dir: "/tmp/project".to_string(),
                include_patterns: Some(vec!["src/**".to_string()]),
                exclude_patterns: Some(vec!["dist/**".to_string()]),
                debounce_ms: 50,
                owner_connection_id: Some("conn_owned".to_string()),
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        let replay = reader.replay();

        assert_eq!(
            replay.last_init,
            Some(InitConfig {
                system_prompt: Some("You are Maestro".to_string()),
                append_system_prompt: Some("Stay concise".to_string()),
                thinking_level: Some(super::super::messages::ThinkingLevel::High),
                approval_mode: Some(super::super::messages::ApprovalMode::Prompt),
                history: None,
            })
        );
        assert_eq!(replay.state.protocol_version.as_deref(), Some("2026-03-30"));
        assert_eq!(replay.state.session_id.as_deref(), Some("sess_info"));
        assert_eq!(replay.state.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(replay.state.git_branch.as_deref(), Some("main"));
        assert!(replay.state.is_ready);
        assert!(replay.state.is_responding);
        assert_eq!(
            replay
                .state
                .current_response
                .as_ref()
                .map(|response| response.text.as_str()),
            Some("Partial reply")
        );
        assert_eq!(replay.state.pending_approvals.len(), 1);
        assert_eq!(replay.state.pending_approvals[0].tool, "bash");
        assert_eq!(
            replay
                .state
                .active_utility_commands
                .get("cmd_owned")
                .and_then(|command| command.owner_connection_id.as_deref()),
            Some("conn_owned")
        );
        assert_eq!(
            replay
                .state
                .active_file_watches
                .get("watch_owned")
                .and_then(|watch| watch.owner_connection_id.as_deref()),
            Some("conn_owned")
        );
    }

    #[test]
    fn test_last_init_returns_most_recent_init_message() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();

        recorder
            .record_sent(&ToAgentMessage::Init {
                system_prompt: Some("First".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::Low),
                approval_mode: Some(super::super::messages::ApprovalMode::Auto),
                history: None,
            })
            .unwrap();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Hello".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder
            .record_sent(&ToAgentMessage::Init {
                system_prompt: Some("Second".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::Ultra),
                approval_mode: Some(super::super::messages::ApprovalMode::Fail),
                history: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(
            reader.last_init(),
            Some(InitConfig {
                system_prompt: Some("Second".to_string()),
                append_system_prompt: None,
                thinking_level: Some(super::super::messages::ThinkingLevel::Ultra),
                approval_mode: Some(super::super::messages::ApprovalMode::Fail),
                history: None,
            })
        );
    }

    #[test]
    fn test_list_sessions() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        // Create a few sessions
        let mut r1 = SessionRecorder::new(sessions_dir).unwrap();
        r1.record_sent(&ToAgentMessage::Prompt {
            content: "First session".to_string(),
            attachments: None,
        })
        .unwrap();
        r1.flush().unwrap();

        let mut r2 = SessionRecorder::new(sessions_dir).unwrap();
        r2.record_sent(&ToAgentMessage::Prompt {
            content: "Second session".to_string(),
            attachments: None,
        })
        .unwrap();
        r2.flush().unwrap();

        // List sessions
        let sessions = list_sessions(sessions_dir).unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn test_delete_session() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        // Create a session
        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Test".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // Verify files exist
        assert!(sessions_dir.join(format!("{}.jsonl", id)).exists());
        assert!(sessions_dir.join(format!("{}.meta.json", id)).exists());

        // Delete the session
        delete_session(sessions_dir, &id).unwrap();

        // Verify files are gone
        assert!(!sessions_dir.join(format!("{}.jsonl", id)).exists());
        assert!(!sessions_dir.join(format!("{}.meta.json", id)).exists());
    }

    #[test]
    fn test_resume_session() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        // Create initial session
        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "First message".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // Resume the session
        let mut recorder = SessionRecorder::resume(sessions_dir, &id).unwrap();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Second message".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // Load and verify
        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(reader.prompts().len(), 2);
    }

    /// Regression test for a torn `.meta.json`: before the fix, both
    /// `SessionRecorder::resume` and `SessionReader::load` hard-failed with
    /// an `InvalidData` IO error on a corrupt metadata file, even though the
    /// JSONL log (the actual conversation history) was fully intact. A user
    /// hitting a crash right as metadata flushed would be unable to resume
    /// a session that was otherwise perfectly recoverable.
    #[test]
    fn resume_tolerates_corrupt_metadata_instead_of_hard_failing() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Before the crash".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // Simulate a crash mid-`fs::write` of the metadata file: truncated,
        // invalid JSON.
        let meta_path = sessions_dir.join(format!("{id}.meta.json"));
        fs::write(&meta_path, "{\"id\":\"partial").unwrap();

        // resume() must succeed rather than propagating a parse error.
        let mut recorder = SessionRecorder::resume(sessions_dir, &id)
            .expect("resume must tolerate corrupt metadata, not hard-fail");
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "After the resume".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // The corrupt file must be preserved as forensic evidence, not
        // silently overwritten in place.
        let rotated: Vec<_> = fs::read_dir(sessions_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".meta.json.corrupt.")
            })
            .collect();
        assert_eq!(
            rotated.len(),
            1,
            "corrupt metadata should be rotated aside, not discarded"
        );

        // The conversation history survived the crash even though metadata
        // did not: both prompts (before and after) must still be present.
        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(reader.prompts().len(), 2);

        // list_sessions must not hide a session just because its metadata
        // was corrupt -- that would make a crash look identical to the
        // session never having existed.
        let sessions = list_sessions(sessions_dir).unwrap();
        assert!(sessions.iter().any(|meta| meta.id == id));
    }

    /// Regression test: a `.meta.json` torn mid-write can just as easily be
    /// torn in the middle of a multi-byte UTF-8 character as in the middle
    /// of a JSON token. Before the fix, `load_metadata_tolerant` used
    /// `fs::read_to_string`, which failed with `InvalidData` before the
    /// tolerant JSON-parsing branch (exercised by
    /// `resume_tolerates_corrupt_metadata_instead_of_hard_failing` above)
    /// ever ran -- so this exact kind of corruption still hard-failed
    /// `resume` and silently dropped the session from `list_sessions`,
    /// even though the equivalent ASCII-corruption case was already fixed.
    #[test]
    fn resume_and_list_sessions_tolerate_invalid_utf8_metadata() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Before the crash".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        // Simulate a crash mid-write torn in the middle of a multi-byte
        // UTF-8 character: a valid JSON prefix followed by a lone
        // continuation byte, which is invalid UTF-8 on its own.
        let meta_path = sessions_dir.join(format!("{id}.meta.json"));
        let mut torn = br#"{"id":"partial","title":"caf"#.to_vec();
        torn.push(0xE9); // incomplete multi-byte sequence, not valid UTF-8
        fs::write(&meta_path, &torn).unwrap();
        assert!(
            std::str::from_utf8(&torn).is_err(),
            "test fixture must actually be invalid UTF-8"
        );

        let mut recorder = SessionRecorder::resume(sessions_dir, &id)
            .expect("resume must tolerate invalid-UTF-8 metadata, not hard-fail");
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "After the resume".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let rotated: Vec<_> = fs::read_dir(sessions_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".meta.json.corrupt.")
            })
            .collect();
        assert_eq!(
            rotated.len(),
            1,
            "invalid-UTF-8 metadata should be rotated aside, not discarded"
        );

        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(reader.prompts().len(), 2);

        let sessions = list_sessions(sessions_dir).unwrap();
        assert!(sessions.iter().any(|meta| meta.id == id));
    }

    /// When corrupt metadata is rotated aside on resume, the lost fields
    /// (title, message count) are rebuilt from the still-intact JSONL log
    /// instead of being permanently reset to defaults on the next flush.
    #[test]
    fn resume_rebuilds_corrupt_metadata_from_jsonl_log() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Recovered title".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let meta_path = sessions_dir.join(format!("{id}.meta.json"));
        fs::write(&meta_path, "{\"id\":\"partial").unwrap();

        let mut recorder = SessionRecorder::resume(sessions_dir, &id).unwrap();
        assert_eq!(
            recorder.metadata().title.as_deref(),
            Some("Recovered title"),
            "title must be rebuilt from the JSONL log, not reset"
        );
        assert_eq!(recorder.metadata().message_count, 1);
        recorder.flush().unwrap();
        drop(recorder);

        let reader = SessionReader::load(sessions_dir, &id).unwrap();
        assert_eq!(reader.metadata().title.as_deref(), Some("Recovered title"));
    }

    /// Regression test: calling `SessionReader::load` directly (not through
    /// `SessionRecorder::resume`) on a session with corrupt metadata must
    /// also rebuild the lost fields from the JSONL log, not silently reset
    /// them to defaults -- and must persist that rebuild, since this
    /// read-only path has no later `flush()` to do so, and without it a
    /// later `list_sessions` scan would find no `.meta.json` for this
    /// session at all (it was rotated aside above, with nothing to replace
    /// it) and treat a fully recoverable session as if it never existed.
    #[test]
    fn direct_session_reader_load_rebuilds_and_persists_corrupt_metadata() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Loaded directly".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let meta_path = sessions_dir.join(format!("{id}.meta.json"));
        fs::write(&meta_path, "{\"id\":\"partial").unwrap();

        let reader = SessionReader::load(sessions_dir, &id)
            .expect("load must tolerate corrupt metadata, not hard-fail");
        assert_eq!(
            reader.metadata().title.as_deref(),
            Some("Loaded directly"),
            "title must be rebuilt from the JSONL log via a direct load, not reset"
        );
        assert_eq!(reader.metadata().message_count, 1);

        // The rebuild must be persisted, not just returned in memory: a
        // later listing has to be able to find this session again.
        assert!(
            meta_path.exists(),
            "rebuilt metadata must be persisted after a direct load, not left absent"
        );
        let sessions = list_sessions(sessions_dir).unwrap();
        let found = sessions
            .iter()
            .find(|meta| meta.id == id)
            .expect("session must still be discoverable after a direct load rebuilt its metadata");
        assert_eq!(found.title.as_deref(), Some("Loaded directly"));
    }

    #[test]
    fn rebuilt_metadata_persistence_errors_are_propagated() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("session.meta.json");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("occupied"), "keep").unwrap();

        let metadata = SessionMetadata::new("session");
        let err = persist_rebuilt_metadata(&target, &metadata)
            .expect_err("replacing a non-empty directory must fail");

        assert!(
            !err.to_string().is_empty(),
            "the replacement error must reach the caller"
        );
        assert!(target.join("occupied").exists());
    }

    /// After `list_sessions` rotates a corrupt metadata file aside, it
    /// persists the rebuilt metadata so subsequent listings keep showing
    /// the session instead of hiding it (no `.meta.json` left to match).
    #[test]
    fn list_sessions_persists_rebuilt_metadata_after_rotation() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path();

        let mut recorder = SessionRecorder::new(sessions_dir).unwrap();
        let id = recorder.id().to_string();
        recorder
            .record_sent(&ToAgentMessage::Prompt {
                content: "Still here".to_string(),
                attachments: None,
            })
            .unwrap();
        recorder.flush().unwrap();
        drop(recorder);

        let meta_path = sessions_dir.join(format!("{id}.meta.json"));
        fs::write(&meta_path, "{\"id\":\"partial").unwrap();

        let first = list_sessions(sessions_dir).unwrap();
        assert!(first.iter().any(|meta| meta.id == id));
        assert!(
            meta_path.exists(),
            "rebuilt metadata must be persisted after rotation"
        );

        let second = list_sessions(sessions_dir).unwrap();
        let meta = second
            .iter()
            .find(|meta| meta.id == id)
            .expect("session must stay discoverable in subsequent listings");
        assert_eq!(meta.title.as_deref(), Some("Still here"));
        assert_eq!(meta.message_count, 1);
    }

    #[test]
    fn test_session_metadata_usage() {
        let mut metadata = SessionMetadata::new("test");

        // Add some usage
        metadata.add_usage(&TokenUsage {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: None,
            total_tokens: None,
            model_id: None,
            provider: None,
        });

        metadata.add_usage(&TokenUsage {
            input_tokens: 150,
            output_tokens: 300,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: None,
            total_tokens: None,
            model_id: None,
            provider: None,
        });

        assert_eq!(metadata.total_input_tokens, 250);
        assert_eq!(metadata.total_output_tokens, 500);
    }

    #[test]
    fn test_title_truncation() {
        let mut metadata = SessionMetadata::new("test");

        let long_message = "a".repeat(200);
        metadata.set_title_from_prompt(&long_message);

        assert!(metadata.title.as_ref().unwrap().len() <= 80);
        assert!(metadata.title.as_ref().unwrap().ends_with("..."));
    }
}

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

use super::messages::{
    ActiveTool, AgentState, FromAgentMessage, InitConfig, PendingApproval, StreamingResponse,
    ToAgentMessage, TokenUsage,
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
pub struct AgentStateCheckpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
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
    pub tracked_tools: Vec<PendingApproval>,
    #[serde(default)]
    pub active_tools: Vec<ActiveToolCheckpoint>,
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
            model: state.model.clone(),
            provider: state.provider.clone(),
            session_id: state.session_id.clone(),
            cwd: state.cwd.clone(),
            git_branch: state.git_branch.clone(),
            current_response: state.current_response.clone(),
            pending_approvals: state.pending_approvals.clone(),
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
            model: self.model,
            provider: self.provider,
            session_id: self.session_id,
            cwd: self.cwd,
            git_branch: self.git_branch,
            current_response: self.current_response,
            pending_approvals: self.pending_approvals,
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

impl SessionRecorder {
    /// Create a new session recorder
    pub fn new(sessions_dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Self::with_id(sessions_dir, &id)
    }

    /// Create a session recorder with a specific ID
    pub fn with_id(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        fs::create_dir_all(sessions_dir)?;

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
        let path = sessions_dir.join(format!("{id}.jsonl"));
        let metadata_path = sessions_dir.join(format!("{id}.meta.json"));

        // Load existing metadata
        let metadata = if metadata_path.exists() {
            let content = fs::read_to_string(&metadata_path)?;
            serde_json::from_str(&content)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
        } else {
            SessionMetadata::new(id)
        };

        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let writer = BufWriter::new(file);
        let replay = SessionReader::load(sessions_dir, id)
            .ok()
            .map(|reader| reader.replay());

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
        } = message
        {
            self.last_init = Some(InitConfig {
                system_prompt: system_prompt.clone(),
                append_system_prompt: append_system_prompt.clone(),
                thinking_level: *thinking_level,
                approval_mode: *approval_mode,
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
        let entry = SessionEntry::received(message.clone());
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
            state: Box::new(AgentStateCheckpoint::from_state(&self.replay_state)),
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
        self.save_metadata()?;
        Ok(())
    }

    /// Save metadata to file
    fn save_metadata(&self) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(&self.metadata)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(&self.metadata_path, json)?;
        Ok(())
    }
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

impl SessionReader {
    /// Load a session from disk
    pub fn load(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        let path = sessions_dir.join(format!("{id}.jsonl"));
        let metadata_path = sessions_dir.join(format!("{id}.meta.json"));

        // Load metadata
        let metadata = if metadata_path.exists() {
            let content = fs::read_to_string(&metadata_path)?;
            serde_json::from_str(&content)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
        } else {
            SessionMetadata::new(id)
        };

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
                    } = message
                    {
                        last_init = Some(InitConfig {
                            system_prompt: system_prompt.clone(),
                            append_system_prompt: append_system_prompt.clone(),
                            thinking_level: *thinking_level,
                            approval_mode: *approval_mode,
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
    for entry in fs::read_dir(sessions_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".meta.json"))
        {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(meta) = serde_json::from_str::<SessionMetadata>(&content) {
                    sessions.push(meta);
                }
            }
        }
    }

    // Sort by updated_at descending (most recent first)
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

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
                tool: "bash".to_string(),
                args: serde_json::json!({ "cmd": "git status" }),
                requires_approval: true,
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

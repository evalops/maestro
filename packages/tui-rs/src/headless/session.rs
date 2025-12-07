//! Session persistence for headless protocol
//!
//! Provides save/load/resume functionality for agent sessions.
//! Sessions are stored as JSONL files for streaming writes.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::messages::{FromAgentMessage, ToAgentMessage, TokenUsage};

/// A recorded session entry (either a sent or received message)
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
}

impl SessionEntry {
    /// Create a sent entry with current timestamp
    pub fn sent(message: ToAgentMessage) -> Self {
        SessionEntry::Sent {
            timestamp: current_timestamp(),
            message,
        }
    }

    /// Create a received entry with current timestamp
    pub fn received(message: FromAgentMessage) -> Self {
        SessionEntry::Received {
            timestamp: current_timestamp(),
            message,
        }
    }

    /// Get the timestamp of this entry
    pub fn timestamp(&self) -> u64 {
        match self {
            SessionEntry::Sent { timestamp, .. } => *timestamp,
            SessionEntry::Received { timestamp, .. } => *timestamp,
        }
    }
}

/// Session metadata stored in a separate file
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
            let title = if title.len() > 80 {
                format!("{}...", &title[..77])
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

/// Session recorder - appends entries to a JSONL file
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
        fs::create_dir_all(sessions_dir)?;

        let path = sessions_dir.join(format!("{}.jsonl", id));
        let metadata_path = sessions_dir.join(format!("{}.meta.json", id));

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let writer = BufWriter::new(file);

        let metadata = SessionMetadata::new(id);

        Ok(Self {
            id: id.to_string(),
            path,
            writer,
            metadata,
            metadata_path,
        })
    }

    /// Resume an existing session
    pub fn resume(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        let path = sessions_dir.join(format!("{}.jsonl", id));
        let metadata_path = sessions_dir.join(format!("{}.meta.json", id));

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

        Ok(Self {
            id: id.to_string(),
            path,
            writer,
            metadata,
            metadata_path,
        })
    }

    /// Get the session ID
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the path to the session JSONL file
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the session metadata
    pub fn metadata(&self) -> &SessionMetadata {
        &self.metadata
    }

    /// Record a sent message
    pub fn record_sent(&mut self, message: &ToAgentMessage) -> std::io::Result<()> {
        let entry = SessionEntry::sent(message.clone());
        self.write_entry(&entry)?;

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

        // Update metadata
        match message {
            FromAgentMessage::Ready { model, provider } => {
                self.metadata.model = Some(model.clone());
                self.metadata.provider = Some(provider.clone());
            }
            FromAgentMessage::SessionInfo {
                cwd, git_branch, ..
            } => {
                self.metadata.cwd = Some(cwd.clone());
                self.metadata.git_branch = git_branch.clone();
            }
            FromAgentMessage::ResponseEnd { usage, .. } => {
                if let Some(usage) = usage {
                    self.metadata.add_usage(usage);
                }
            }
            _ => {}
        }
        self.metadata.message_count += 1;
        self.metadata.updated_at = current_timestamp();

        Ok(())
    }

    /// Write an entry to the JSONL file
    fn write_entry(&mut self, entry: &SessionEntry) -> std::io::Result<()> {
        let json = serde_json::to_string(entry)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writeln!(self.writer, "{}", json)?;
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

/// Session reader - loads entries from a JSONL file
pub struct SessionReader {
    /// Session ID
    id: String,
    /// Loaded entries
    entries: Vec<SessionEntry>,
    /// Session metadata
    metadata: SessionMetadata,
}

impl SessionReader {
    /// Load a session from disk
    pub fn load(sessions_dir: impl AsRef<Path>, id: &str) -> std::io::Result<Self> {
        let sessions_dir = sessions_dir.as_ref();
        let path = sessions_dir.join(format!("{}.jsonl", id));
        let metadata_path = sessions_dir.join(format!("{}.meta.json", id));

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
                        eprintln!("Warning: Failed to parse session entry: {}", e);
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
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the session metadata
    pub fn metadata(&self) -> &SessionMetadata {
        &self.metadata
    }

    /// Get all entries
    pub fn entries(&self) -> &[SessionEntry] {
        &self.entries
    }

    /// Get only sent messages
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
        if path.extension().map(|e| e == "json").unwrap_or(false)
            && path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".meta.json"))
                .unwrap_or(false)
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
    let jsonl_path = sessions_dir.join(format!("{}.jsonl", id));
    let meta_path = sessions_dir.join(format!("{}.meta.json", id));

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
                model: "claude-3-opus".to_string(),
                provider: "anthropic".to_string(),
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
        });

        metadata.add_usage(&TokenUsage {
            input_tokens: 150,
            output_tokens: 300,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: None,
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

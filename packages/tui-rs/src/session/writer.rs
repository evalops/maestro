//! Session writer
//!
//! Writes session entries to JSONL files with batching.

use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use super::entries::{SessionEntry, SessionHeader};

/// Default batch size for writes
const DEFAULT_BATCH_SIZE: usize = 25;

/// Error type for session writing
#[derive(Debug)]
pub enum SessionWriteError {
    IoError(std::io::Error),
    SerializeError(String),
}

impl std::fmt::Display for SessionWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionWriteError::IoError(e) => write!(f, "IO error: {}", e),
            SessionWriteError::SerializeError(msg) => write!(f, "Serialize error: {}", msg),
        }
    }
}

impl std::error::Error for SessionWriteError {}

impl From<std::io::Error> for SessionWriteError {
    fn from(e: std::io::Error) -> Self {
        SessionWriteError::IoError(e)
    }
}

/// Session writer with batching
pub struct SessionWriter {
    /// Path to the session file
    path: PathBuf,
    /// Pending entries to write
    buffer: Vec<SessionEntry>,
    /// Batch size before auto-flush
    batch_size: usize,
    /// Whether the session header has been written
    header_written: bool,
}

impl SessionWriter {
    /// Create a new session writer
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SessionWriteError> {
        let path = path.as_ref().to_path_buf();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        Ok(Self {
            path,
            buffer: Vec::new(),
            batch_size: DEFAULT_BATCH_SIZE,
            header_written: false,
        })
    }

    /// Create a new session with a header
    pub fn create(path: impl AsRef<Path>, header: SessionHeader) -> Result<Self, SessionWriteError> {
        let mut writer = Self::new(path)?;
        writer.write_entry(SessionEntry::Session(header))?;
        writer.header_written = true;
        Ok(writer)
    }

    /// Set the batch size
    pub fn batch_size(mut self, size: usize) -> Self {
        self.batch_size = size;
        self
    }

    /// Get the file path
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write an entry (buffers until batch size reached)
    pub fn write_entry(&mut self, entry: SessionEntry) -> Result<(), SessionWriteError> {
        self.buffer.push(entry);

        if self.buffer.len() >= self.batch_size {
            self.flush()?;
        }

        Ok(())
    }

    /// Write multiple entries
    pub fn write_entries(&mut self, entries: Vec<SessionEntry>) -> Result<(), SessionWriteError> {
        for entry in entries {
            self.write_entry(entry)?;
        }
        Ok(())
    }

    /// Flush all buffered entries to disk
    pub fn flush(&mut self) -> Result<(), SessionWriteError> {
        if self.buffer.is_empty() {
            return Ok(());
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let mut writer = BufWriter::new(file);

        for entry in self.buffer.drain(..) {
            let json = serde_json::to_string(&entry)
                .map_err(|e| SessionWriteError::SerializeError(e.to_string()))?;
            writeln!(writer, "{}", json)?;
        }

        writer.flush()?;
        Ok(())
    }

    /// Check if header has been written
    pub fn has_header(&self) -> bool {
        self.header_written
    }

    /// Get the number of buffered entries
    pub fn buffered_count(&self) -> usize {
        self.buffer.len()
    }
}

impl Drop for SessionWriter {
    fn drop(&mut self) {
        // Flush remaining entries on drop
        let _ = self.flush();
    }
}

/// Generate a session filename
pub fn generate_session_filename(session_id: &str) -> String {
    let now = chrono::Utc::now();
    let timestamp = now.format("%Y-%m-%dT%H-%M-%S-%3fZ");
    format!("{}_{}.jsonl", timestamp, session_id)
}

/// Sanitize a path for use in session directory names
pub fn sanitize_path_for_dirname(path: &str) -> String {
    path.replace(['/', '\\', ':'], "-")
        .trim_matches('-')
        .to_string()
}

/// Get the sessions directory for a working directory
pub fn sessions_dir(cwd: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let sanitized = sanitize_path_for_dirname(cwd);
    PathBuf::from(home)
        .join(".composer")
        .join("agent")
        .join("sessions")
        .join(format!("--{}--", sanitized))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writer_creates_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let header = SessionHeader {
            id: "test123".to_string(),
            timestamp: "2024-01-15T10:30:00Z".to_string(),
            cwd: "/tmp".to_string(),
            model: "anthropic/claude-3".to_string(),
            model_metadata: None,
            thinking_level: Default::default(),
            system_prompt: None,
            tools: vec![],
            branched_from: None,
        };

        let mut writer = SessionWriter::create(&path, header).unwrap();
        writer.flush().unwrap();

        assert!(path.exists());
    }

    #[test]
    fn writer_batches_writes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let mut writer = SessionWriter::new(&path).unwrap().batch_size(3);

        // Write 2 entries (below batch size)
        writer
            .write_entry(SessionEntry::ThinkingLevelChange(
                super::super::entries::ThinkingLevelChange {
                    timestamp: "2024-01-15T10:30:00Z".to_string(),
                    thinking_level: super::super::entries::ThinkingLevel::High,
                },
            ))
            .unwrap();

        // File shouldn't exist yet (buffered)
        assert!(!path.exists());

        // Write 2 more (triggers flush at 3)
        writer
            .write_entry(SessionEntry::ThinkingLevelChange(
                super::super::entries::ThinkingLevelChange {
                    timestamp: "2024-01-15T10:31:00Z".to_string(),
                    thinking_level: super::super::entries::ThinkingLevel::Low,
                },
            ))
            .unwrap();
        writer
            .write_entry(SessionEntry::ThinkingLevelChange(
                super::super::entries::ThinkingLevelChange {
                    timestamp: "2024-01-15T10:32:00Z".to_string(),
                    thinking_level: super::super::entries::ThinkingLevel::Medium,
                },
            ))
            .unwrap();

        // Should have flushed now
        assert!(path.exists());
    }

    #[test]
    fn sanitize_path() {
        assert_eq!(
            sanitize_path_for_dirname("/Users/john/projects/myapp"),
            "Users-john-projects-myapp"
        );
    }

    #[test]
    fn generate_filename() {
        let filename = generate_session_filename("abc123");
        assert!(filename.ends_with("_abc123.jsonl"));
    }
}

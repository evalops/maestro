//! Session manager
//!
//! Handles listing, loading, and managing sessions.

use std::fs;
use std::path::{Path, PathBuf};

use super::entries::{SessionHeader, SessionMeta, SessionStats, ThinkingLevel};
use super::reader::{ParsedSession, SessionReadError, SessionReader};
use super::writer::{sessions_dir, SessionWriter};

/// Summary info for a session (for listing)
#[derive(Debug, Clone)]
pub struct SessionInfo {
    /// Session ID
    pub id: String,
    /// File path
    pub path: PathBuf,
    /// Working directory
    pub cwd: String,
    /// Model used
    pub model: String,
    /// Thinking level
    pub thinking_level: ThinkingLevel,
    /// Timestamp
    pub timestamp: String,
    /// Message statistics
    pub stats: SessionStats,
    /// Session metadata
    pub meta: Option<SessionMeta>,
    /// File modification time
    pub modified: Option<std::time::SystemTime>,
}

impl SessionInfo {
    /// Get the display title
    pub fn title(&self) -> String {
        if let Some(ref meta) = self.meta {
            if let Some(ref title) = meta.title {
                return title.clone();
            }
            if let Some(ref summary) = meta.summary {
                if summary.len() > 50 {
                    return format!("{}...", &summary[..47]);
                }
                return summary.clone();
            }
        }
        format!("Session {}", &self.id[..8.min(self.id.len())])
    }

    /// Check if this is a favorite
    pub fn is_favorite(&self) -> bool {
        self.meta.as_ref().map(|m| m.favorite).unwrap_or(false)
    }

    /// Get the short ID (first 8 chars)
    pub fn short_id(&self) -> &str {
        &self.id[..8.min(self.id.len())]
    }
}

/// Session manager
pub struct SessionManager {
    /// Current working directory
    cwd: String,
    /// Sessions directory
    sessions_dir: PathBuf,
    /// Current session ID
    current_session_id: Option<String>,
    /// Current session writer
    writer: Option<SessionWriter>,
}

impl SessionManager {
    /// Create a new session manager
    pub fn new(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        let dir = sessions_dir(&cwd);
        Self {
            cwd,
            sessions_dir: dir,
            current_session_id: None,
            writer: None,
        }
    }

    /// Get the sessions directory
    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    /// Get the current session ID
    pub fn current_session_id(&self) -> Option<&str> {
        self.current_session_id.as_deref()
    }

    /// List all sessions for the current working directory
    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>, SessionReadError> {
        self.list_sessions_in_dir(&self.sessions_dir)
    }

    /// List sessions in a specific directory
    fn list_sessions_in_dir(&self, dir: &Path) -> Result<Vec<SessionInfo>, SessionReadError> {
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut sessions = Vec::new();

        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                match SessionReader::read_header(&path) {
                    Ok((header, stats, meta)) => {
                        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
                        sessions.push(SessionInfo {
                            id: header.id,
                            path,
                            cwd: header.cwd,
                            model: header.model,
                            thinking_level: header.thinking_level,
                            timestamp: header.timestamp,
                            stats,
                            meta,
                            modified,
                        });
                    }
                    Err(_) => {
                        // Skip invalid session files
                        continue;
                    }
                }
            }
        }

        // Sort by modification time (newest first)
        sessions.sort_by(|a, b| {
            match (&b.modified, &a.modified) {
                (Some(b_time), Some(a_time)) => b_time.cmp(a_time),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        Ok(sessions)
    }

    /// List all sessions across all working directories
    pub fn list_all_sessions(&self) -> Result<Vec<SessionInfo>, SessionReadError> {
        let base_dir = self.sessions_dir.parent().unwrap_or(&self.sessions_dir);

        if !base_dir.exists() {
            return Ok(Vec::new());
        }

        let mut all_sessions = Vec::new();

        for entry in fs::read_dir(base_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                if let Ok(sessions) = self.list_sessions_in_dir(&path) {
                    all_sessions.extend(sessions);
                }
            }
        }

        // Sort by modification time (newest first)
        all_sessions.sort_by(|a, b| {
            match (&b.modified, &a.modified) {
                (Some(b_time), Some(a_time)) => b_time.cmp(a_time),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        Ok(all_sessions)
    }

    /// Get the N most recent sessions
    pub fn recent_sessions(&self, count: usize) -> Result<Vec<SessionInfo>, SessionReadError> {
        let mut sessions = self.list_sessions()?;
        sessions.truncate(count);
        Ok(sessions)
    }

    /// Load a session by ID
    pub fn load_session(&self, id: &str) -> Result<ParsedSession, SessionReadError> {
        // First try current directory
        let sessions = self.list_sessions()?;
        for session in &sessions {
            if session.id == id || session.id.starts_with(id) {
                return SessionReader::read_file(&session.path);
            }
        }

        // Try all directories
        let all_sessions = self.list_all_sessions()?;
        for session in &all_sessions {
            if session.id == id || session.id.starts_with(id) {
                return SessionReader::read_file(&session.path);
            }
        }

        Err(SessionReadError::InvalidFormat(format!(
            "Session not found: {}",
            id
        )))
    }

    /// Load a session by index (1-based, from recent list)
    pub fn load_session_by_index(&self, index: usize) -> Result<ParsedSession, SessionReadError> {
        let sessions = self.list_sessions()?;
        let session = sessions.get(index.saturating_sub(1)).ok_or_else(|| {
            SessionReadError::InvalidFormat(format!(
                "No session at index {}",
                index
            ))
        })?;
        SessionReader::read_file(&session.path)
    }

    /// Get the most recent session (for --continue)
    pub fn most_recent_session(&self) -> Result<Option<ParsedSession>, SessionReadError> {
        let sessions = self.list_sessions()?;
        if let Some(session) = sessions.first() {
            Ok(Some(SessionReader::read_file(&session.path)?))
        } else {
            Ok(None)
        }
    }

    /// Start a new session
    pub fn start_session(&mut self, header: SessionHeader) -> Result<(), super::writer::SessionWriteError> {
        self.current_session_id = Some(header.id.clone());

        let filename = super::writer::generate_session_filename(&header.id);
        let path = self.sessions_dir.join(filename);

        self.writer = Some(SessionWriter::create(path, header)?);
        Ok(())
    }

    /// Get the current session writer
    pub fn writer(&mut self) -> Option<&mut SessionWriter> {
        self.writer.as_mut()
    }

    /// Flush the current session
    pub fn flush(&mut self) -> Result<(), super::writer::SessionWriteError> {
        if let Some(ref mut writer) = self.writer {
            writer.flush()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::io::Write;

    fn create_test_session_file(dir: &Path, id: &str) {
        let filename = format!("2024-01-15T10-30-00-000Z_{}.jsonl", id);
        let path = dir.join(filename);
        let mut file = fs::File::create(path).unwrap();
        writeln!(file, r#"{{"type":"session","id":"{}","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"anthropic/claude-3","thinking_level":"medium"}}"#, id).unwrap();
        writeln!(file, r#"{{"type":"message","timestamp":"2024-01-15T10:30:00Z","message":{{"role":"user","content":"Hello","timestamp":0}}}}"#).unwrap();
    }

    #[test]
    fn list_sessions_empty() {
        let dir = TempDir::new().unwrap();
        let manager = SessionManager {
            cwd: "/tmp".to_string(),
            sessions_dir: dir.path().to_path_buf(),
            current_session_id: None,
            writer: None,
        };

        let sessions = manager.list_sessions().unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn list_sessions_finds_files() {
        let dir = TempDir::new().unwrap();
        create_test_session_file(dir.path(), "abc123");
        create_test_session_file(dir.path(), "def456");

        let manager = SessionManager {
            cwd: "/tmp".to_string(),
            sessions_dir: dir.path().to_path_buf(),
            current_session_id: None,
            writer: None,
        };

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn load_session_by_id() {
        let dir = TempDir::new().unwrap();
        create_test_session_file(dir.path(), "abc123");

        let manager = SessionManager {
            cwd: "/tmp".to_string(),
            sessions_dir: dir.path().to_path_buf(),
            current_session_id: None,
            writer: None,
        };

        let session = manager.load_session("abc123").unwrap();
        assert_eq!(session.id(), "abc123");
    }

    #[test]
    fn load_session_by_prefix() {
        let dir = TempDir::new().unwrap();
        create_test_session_file(dir.path(), "abc123");

        let manager = SessionManager {
            cwd: "/tmp".to_string(),
            sessions_dir: dir.path().to_path_buf(),
            current_session_id: None,
            writer: None,
        };

        let session = manager.load_session("abc").unwrap();
        assert_eq!(session.id(), "abc123");
    }

    #[test]
    fn session_info_title() {
        let info = SessionInfo {
            id: "abc123".to_string(),
            path: PathBuf::from("/tmp/test.jsonl"),
            cwd: "/tmp".to_string(),
            model: "anthropic/claude-3".to_string(),
            thinking_level: ThinkingLevel::Medium,
            timestamp: "2024-01-15T10:30:00Z".to_string(),
            stats: SessionStats::default(),
            meta: None,
            modified: None,
        };

        assert!(info.title().contains("abc123"));
        assert_eq!(info.short_id(), "abc123");
    }
}

//! Session Lifecycle Manager
//!
//! This module provides the high-level [`SessionManager`] API for managing session
//! persistence throughout the application lifecycle. It coordinates session discovery,
//! loading, and creation while maintaining the current active session state.
//!
//! # Responsibilities
//!
//! The `SessionManager` serves as the primary interface between the application and
//! the session persistence layer:
//!
//! 1. **Session Discovery**: Listing all sessions for a working directory
//! 2. **Session Loading**: Reading existing sessions by ID, index, or most recent
//! 3. **Session Creation**: Initializing new session files with proper headers
//! 4. **Write Coordination**: Managing the active session writer instance
//! 5. **Directory Organization**: Mapping working directories to session storage paths
//!
//! # Directory Structure
//!
//! Sessions are organized by working directory to enable project-scoped session history:
//!
//! ```text
//! ~/.composer/agent/sessions/
//!   ├── home-user-project1/          # Hash of /home/user/project1
//!   │   ├── 2024-01-15T10-30-00-000Z_abc123.jsonl
//!   │   └── 2024-01-15T11-00-00-000Z_def456.jsonl
//!   └── home-user-project2/          # Hash of /home/user/project2
//!       └── 2024-01-15T12-00-00-000Z_xyz789.jsonl
//! ```
//!
//! This structure allows:
//! - Isolating sessions per project/directory
//! - Efficiently listing sessions for the current context
//! - Searching across all projects when needed
//!
//! # Session Listing
//!
//! ## Directory-Scoped Listing
//!
//! The [`list_sessions`] method returns sessions for the current working directory,
//! sorted by modification time (newest first):
//!
//! ```rust,ignore
//! let manager = SessionManager::new("/home/user/project");
//! let sessions = manager.list_sessions()?;
//! for session in sessions {
//!     println!("{}: {}", session.short_id(), session.title());
//! }
//! ```
//!
//! ## Global Search
//!
//! The [`list_all_sessions`] method searches across all working directories:
//!
//! ```rust,ignore
//! let all_sessions = manager.list_all_sessions()?;
//! // Returns sessions from all projects, sorted by modification time
//! ```
//!
//! ## Recent Sessions
//!
//! The [`recent_sessions`] method provides a truncated list of the N most recent
//! sessions for quick access:
//!
//! ```rust,ignore
//! let recent = manager.recent_sessions(5)?;
//! // Returns up to 5 most recent sessions
//! ```
//!
//! # Session Loading Strategies
//!
//! ## By ID (with Prefix Matching)
//!
//! The [`load_session`] method accepts full session IDs or prefixes:
//!
//! ```rust,ignore
//! // Full ID
//! let session = manager.load_session("abc123def456")?;
//!
//! // Prefix (matches first session starting with "abc")
//! let session = manager.load_session("abc")?;
//! ```
//!
//! Search order:
//! 1. Current directory sessions (fast path)
//! 2. All directories (fallback for cross-project access)
//!
//! ## By Index
//!
//! The [`load_session_by_index`] method uses 1-based indexing from the recent list:
//!
//! ```rust,ignore
//! let session = manager.load_session_by_index(1)?;  // Most recent
//! let session = manager.load_session_by_index(2)?;  // Second most recent
//! ```
//!
//! This is useful for terminal UIs where users can select from a numbered list.
//!
//! ## Most Recent
//!
//! The [`most_recent_session`] method provides quick access to continue the last
//! conversation:
//!
//! ```rust,ignore
//! if let Some(session) = manager.most_recent_session()? {
//!     println!("Resuming session: {}", session.id());
//! } else {
//!     println!("No previous sessions found");
//! }
//! ```
//!
//! # Active Session Management
//!
//! ## Starting a New Session
//!
//! The [`start_session`] method initializes a new session file and writer:
//!
//! ```rust,ignore
//! let header = SessionHeader {
//!     id: uuid::Uuid::new_v4().to_string(),
//!     timestamp: chrono::Utc::now().to_rfc3339(),
//!     cwd: "/home/user/project".into(),
//!     model: "anthropic/claude-3".into(),
//!     thinking_level: ThinkingLevel::Medium,
//!     // ... other fields
//! };
//!
//! manager.start_session(header)?;
//! ```
//!
//! This:
//! 1. Sets the current session ID
//! 2. Generates a timestamped filename
//! 3. Creates the session file with the header entry
//! 4. Initializes a buffered writer for appending messages
//!
//! ## Writing to the Active Session
//!
//! The [`writer`] method provides mutable access to the active session writer:
//!
//! ```rust,ignore
//! if let Some(writer) = manager.writer() {
//!     writer.append_user_message("Hello!")?;
//!     writer.flush()?;  // Ensure durability
//! }
//! ```
//!
//! ## Flushing Writes
//!
//! The [`flush`] method ensures all buffered data is written to disk:
//!
//! ```rust,ignore
//! manager.flush()?;
//! ```
//!
//! Call this:
//! - After each complete message exchange
//! - Before long operations where crashes are possible
//! - On application shutdown
//!
//! # Sorting and Ordering
//!
//! Sessions are sorted by file modification time (newest first) using this comparison:
//!
//! ```rust,ignore
//! sessions.sort_by(|a, b| match (&b.modified, &a.modified) {
//!     (Some(b_time), Some(a_time)) => b_time.cmp(a_time),  // Both have timestamps
//!     (Some(_), None) => std::cmp::Ordering::Less,          // b is newer
//!     (None, Some(_)) => std::cmp::Ordering::Greater,       // a is newer
//!     (None, None) => std::cmp::Ordering::Equal,            // Unknown ordering
//! });
//! ```
//!
//! This ensures:
//! - Recently modified sessions appear first
//! - Sessions without metadata sort after those with metadata
//! - Stable ordering when timestamps are equal
//!
//! # File System Operations
//!
//! ## Directory Traversal
//!
//! Uses `std::fs::read_dir` for efficient directory listing:
//!
//! ```rust,ignore
//! for entry in fs::read_dir(dir)? {
//!     let entry = entry?;  // Propagate I/O errors
//!     let path = entry.path();
//!
//!     // Filter by extension
//!     if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
//!         // Process session file...
//!     }
//! }
//! ```
//!
//! ## Path Extension Filtering
//!
//! Only `.jsonl` files are processed:
//! ```rust,ignore
//! path.extension()           // Option<&OsStr>
//!     .map(|e| e == "jsonl") // Option<bool>
//!     .unwrap_or(false)      // bool (default to false if no extension)
//! ```
//!
//! ## Metadata Extraction
//!
//! File modification time is read for sorting:
//! ```rust,ignore
//! let modified = entry.metadata()    // Result<Metadata>
//!     .ok()                          // Option<Metadata>
//!     .and_then(|m| m.modified().ok()); // Option<SystemTime>
//! ```
//!
//! This pattern chains fallible operations, returning `None` if any step fails.
//!
//! # Error Handling Patterns
//!
//! ## Graceful Degradation
//!
//! Invalid session files are skipped during listing rather than failing the entire
//! operation:
//!
//! ```rust,ignore
//! match SessionReader::read_header(&path) {
//!     Ok((header, stats, meta)) => {
//!         sessions.push(SessionInfo { /* ... */ });
//!     }
//!     Err(_) => {
//!         // Skip invalid session files
//!         continue;
//!     }
//! }
//! ```
//!
//! ## Specific Error Messages
//!
//! Not-found errors include context for debugging:
//! ```rust,ignore
//! Err(SessionReadError::InvalidFormat(format!(
//!     "Session not found: {}",
//!     id
//! )))
//! ```
//!
//! # Performance Considerations
//!
//! ## Fast Path Optimization
//!
//! Loading by ID searches current directory first before scanning all directories:
//! ```rust,ignore
//! // Try current directory first (fast)
//! let sessions = self.list_sessions()?;
//! for session in &sessions {
//!     if session.id == id || session.id.starts_with(id) {
//!         return SessionReader::read_file(&session.path);
//!     }
//! }
//!
//! // Fallback to global search (slower)
//! let all_sessions = self.list_all_sessions()?;
//! // ...
//! ```
//!
//! ## Header-Only Reads
//!
//! Listing uses `SessionReader::read_header` instead of full reads for 10x speedup.
//!
//! # Rust Concepts Demonstrated
//!
//! ## Interior Mutability with Option
//! The `writer` field uses `Option<SessionWriter>` to represent the optional active
//! session state. Methods use `&mut self` to modify this state.
//!
//! ## Borrowing and Lifetimes
//! The `writer()` method returns `Option<&mut SessionWriter>`, borrowing the writer
//! mutably while keeping it owned by the manager.
//!
//! ## Method Chaining
//! Optional operations use `Option::map`, `Option::and_then`, and `Option::unwrap_or`
//! for expressive null handling without explicit if-let chains.
//!
//! ## Trait Conversion
//! `Into<String>` trait bound on `new()` allows constructing from both `&str` and `String`:
//! ```rust,ignore
//! pub fn new(cwd: impl Into<String>) -> Self {
//!     let cwd = cwd.into();  // Convert to String
//!     // ...
//! }
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use super::entries::{SessionHeader, SessionMeta, SessionStats, ThinkingLevel};
use super::reader::{ParsedSession, SessionReadError, SessionReader};
use super::writer::{sessions_dir, SessionWriter};

/// Lightweight session summary for listing operations.
///
/// Contains just enough information to display session lists without loading full
/// message history. Constructed from session headers using [`SessionReader::read_header`].
///
/// # Memory Efficiency
///
/// This struct is significantly smaller than [`ParsedSession`] because it doesn't
/// include the message history. For a 10,000 message session:
/// - `SessionInfo`: ~200 bytes
/// - `ParsedSession`: ~50 MB
///
/// # Display Methods
///
/// - [`title()`](SessionInfo::title): Human-readable title from metadata or first message
/// - [`short_id()`](SessionInfo::short_id): First 8 characters of session ID
/// - [`is_favorite()`](SessionInfo::is_favorite): Check if marked as favorite
#[derive(Debug, Clone)]
pub struct SessionInfo {
    /// Full session ID (typically a UUID).
    pub id: String,

    /// Absolute path to the session JSONL file.
    pub path: PathBuf,

    /// Working directory where the session was started.
    pub cwd: String,

    /// Model identifier (e.g., "anthropic/claude-3-5-sonnet-20241022").
    pub model: String,

    /// Extended thinking budget level.
    pub thinking_level: ThinkingLevel,

    /// ISO 8601 creation timestamp.
    pub timestamp: String,

    /// Aggregated message counts and token usage.
    pub stats: SessionStats,

    /// User-provided metadata (title, tags, favorite status).
    ///
    /// None if no metadata entry exists in the session file.
    pub meta: Option<SessionMeta>,

    /// File modification time from filesystem metadata.
    ///
    /// Used for sorting sessions by recency. None if metadata unavailable.
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

/// High-level session persistence coordinator.
///
/// Manages the lifecycle of conversation sessions, including discovery, loading,
/// creation, and writing. Maintains the current active session state and coordinates
/// file system operations.
///
/// # Responsibilities
///
/// - **Discovery**: Listing sessions for the current or all working directories
/// - **Loading**: Reading sessions by ID, index, or most recent
/// - **Creation**: Starting new sessions with proper initialization
/// - **Writing**: Managing buffered writes to the active session file
///
/// # Usage Pattern
///
/// ```rust,ignore
/// // Create manager for a working directory
/// let mut manager = SessionManager::new("/home/user/project");
///
/// // List recent sessions
/// let sessions = manager.recent_sessions(10)?;
///
/// // Start a new session
/// manager.start_session(header)?;
///
/// // Write to active session
/// if let Some(writer) = manager.writer() {
///     writer.append_user_message("Hello")?;
///     writer.flush()?;
/// }
/// ```
///
/// # Thread Safety
///
/// This type is **not** thread-safe. Use separate instances per thread or wrap
/// in a mutex for shared access.
pub struct SessionManager {
    /// Working directory path for session scoping.
    cwd: String,

    /// Filesystem path to the sessions directory for this working directory.
    ///
    /// Typically `~/.composer/agent/sessions/<cwd-hash>/`.
    sessions_dir: PathBuf,

    /// ID of the currently active session.
    ///
    /// Set by [`start_session`](SessionManager::start_session). None if no session is active.
    current_session_id: Option<String>,

    /// Buffered writer for the active session file.
    ///
    /// Set by [`start_session`](SessionManager::start_session). None if no session is active.
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

    /// Get the current working directory
    pub fn cwd(&self) -> &str {
        &self.cwd
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
        sessions.sort_by(|a, b| match (&b.modified, &a.modified) {
            (Some(b_time), Some(a_time)) => b_time.cmp(a_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
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
        all_sessions.sort_by(|a, b| match (&b.modified, &a.modified) {
            (Some(b_time), Some(a_time)) => b_time.cmp(a_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
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
            SessionReadError::InvalidFormat(format!("No session at index {}", index))
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
    pub fn start_session(
        &mut self,
        header: SessionHeader,
    ) -> Result<(), super::writer::SessionWriteError> {
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
    use std::io::Write;
    use tempfile::TempDir;

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

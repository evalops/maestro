//! Session reader
//!
//! Parses session JSONL files.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::entries::{AppMessage, SessionEntry, SessionHeader, SessionMeta, SessionStats};

/// Error type for session reading
#[derive(Debug)]
pub enum SessionReadError {
    IoError(std::io::Error),
    ParseError(String),
    InvalidFormat(String),
}

impl std::fmt::Display for SessionReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionReadError::IoError(e) => write!(f, "IO error: {}", e),
            SessionReadError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            SessionReadError::InvalidFormat(msg) => write!(f, "Invalid format: {}", msg),
        }
    }
}

impl std::error::Error for SessionReadError {}

impl From<std::io::Error> for SessionReadError {
    fn from(e: std::io::Error) -> Self {
        SessionReadError::IoError(e)
    }
}

/// A parsed session
#[derive(Debug, Clone)]
pub struct ParsedSession {
    /// Session header
    pub header: SessionHeader,
    /// All messages
    pub messages: Vec<AppMessage>,
    /// Session metadata
    pub meta: Option<SessionMeta>,
    /// Computed statistics
    pub stats: SessionStats,
    /// Source file path
    pub file_path: String,
}

impl ParsedSession {
    /// Get the session ID
    pub fn id(&self) -> &str {
        &self.header.id
    }

    /// Get the first user message (for preview)
    pub fn first_user_message(&self) -> Option<&str> {
        for msg in &self.messages {
            if let AppMessage::User { .. } = msg {
                return Some(msg.text_content().leak());
            }
        }
        None
    }

    /// Get the title (from meta or first message)
    pub fn title(&self) -> String {
        if let Some(ref meta) = self.meta {
            if let Some(ref title) = meta.title {
                return title.clone();
            }
        }

        // Fall back to first user message preview
        self.first_user_message()
            .map(|s| {
                let s = s.trim();
                if s.len() > 50 {
                    format!("{}...", &s[..47])
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_else(|| "Untitled session".to_string())
    }

    /// Check if this session is a favorite
    pub fn is_favorite(&self) -> bool {
        self.meta.as_ref().map(|m| m.favorite).unwrap_or(false)
    }
}

/// Session reader
pub struct SessionReader;

impl SessionReader {
    /// Read a session from a file
    pub fn read_file(path: impl AsRef<Path>) -> Result<ParsedSession, SessionReadError> {
        let path = path.as_ref();
        let file = File::open(path)?;
        let reader = BufReader::new(file);

        let mut header: Option<SessionHeader> = None;
        let mut messages: Vec<AppMessage> = Vec::new();
        let mut meta: Option<SessionMeta> = None;
        let mut stats = SessionStats::default();

        for (line_num, line) in reader.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }

            let entry: SessionEntry = serde_json::from_str(&line).map_err(|e| {
                SessionReadError::ParseError(format!("Line {}: {}", line_num + 1, e))
            })?;

            match entry {
                SessionEntry::Session(h) => {
                    if header.is_some() {
                        return Err(SessionReadError::InvalidFormat(
                            "Multiple session headers".to_string(),
                        ));
                    }
                    header = Some(h);
                }
                SessionEntry::Message(m) => {
                    // Update stats
                    match &m.message {
                        AppMessage::User { .. } => stats.user_messages += 1,
                        AppMessage::Assistant { usage, content, .. } => {
                            stats.assistant_messages += 1;
                            if let Some(u) = usage {
                                stats.total_input_tokens += u.input;
                                stats.total_output_tokens += u.output;
                                stats.total_cost += u.total_cost();
                            }
                            // Count tool calls
                            for block in content {
                                if matches!(block, super::entries::ContentBlock::ToolCall { .. }) {
                                    stats.tool_calls += 1;
                                }
                            }
                        }
                        AppMessage::ToolResult { .. } => stats.tool_results += 1,
                    }
                    messages.push(m.message);
                }
                SessionEntry::SessionMeta(m) => {
                    meta = Some(m);
                }
                SessionEntry::ThinkingLevelChange(_)
                | SessionEntry::ModelChange(_)
                | SessionEntry::Compaction(_) => {
                    // Track but don't store for now
                }
            }
        }

        let header = header.ok_or_else(|| {
            SessionReadError::InvalidFormat("Missing session header".to_string())
        })?;

        Ok(ParsedSession {
            header,
            messages,
            meta,
            stats,
            file_path: path.to_string_lossy().to_string(),
        })
    }

    /// Read just the header and stats from a session file (faster than full read)
    pub fn read_header(path: impl AsRef<Path>) -> Result<(SessionHeader, SessionStats, Option<SessionMeta>), SessionReadError> {
        let path = path.as_ref();
        let file = File::open(path)?;
        let reader = BufReader::new(file);

        let mut header: Option<SessionHeader> = None;
        let mut meta: Option<SessionMeta> = None;
        let mut stats = SessionStats::default();

        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }

            // Quick check for entry type without full parse
            if line.contains("\"type\":\"session\"") && header.is_none() {
                if let Ok(entry) = serde_json::from_str::<SessionEntry>(&line) {
                    if let SessionEntry::Session(h) = entry {
                        header = Some(h);
                    }
                }
            } else if line.contains("\"type\":\"message\"") {
                // Count messages without full parse
                if line.contains("\"role\":\"user\"") {
                    stats.user_messages += 1;
                } else if line.contains("\"role\":\"assistant\"") {
                    stats.assistant_messages += 1;
                } else if line.contains("\"role\":\"toolResult\"") {
                    stats.tool_results += 1;
                }
            } else if line.contains("\"type\":\"session_meta\"") {
                if let Ok(entry) = serde_json::from_str::<SessionEntry>(&line) {
                    if let SessionEntry::SessionMeta(m) = entry {
                        meta = Some(m);
                    }
                }
            }
        }

        let header = header.ok_or_else(|| {
            SessionReadError::InvalidFormat("Missing session header".to_string())
        })?;

        Ok((header, stats, meta))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn create_test_session() -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"type":"session","id":"test123","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"anthropic/claude-3","thinking_level":"medium"}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","timestamp":"2024-01-15T10:30:00Z","message":{{"role":"user","content":"Hello","timestamp":0}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","timestamp":"2024-01-15T10:30:01Z","message":{{"role":"assistant","content":[{{"type":"text","text":"Hi there!"}}],"timestamp":1}}}}"#).unwrap();
        file
    }

    #[test]
    fn read_session_file() {
        let file = create_test_session();
        let session = SessionReader::read_file(file.path()).unwrap();

        assert_eq!(session.id(), "test123");
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.stats.user_messages, 1);
        assert_eq!(session.stats.assistant_messages, 1);
    }

    #[test]
    fn read_header_only() {
        let file = create_test_session();
        let (header, stats, _meta) = SessionReader::read_header(file.path()).unwrap();

        assert_eq!(header.id, "test123");
        assert_eq!(stats.user_messages, 1);
    }

    #[test]
    fn session_title_from_first_message() {
        let file = create_test_session();
        let session = SessionReader::read_file(file.path()).unwrap();

        // Should use first user message as title
        assert!(session.title().contains("Hello"));
    }
}

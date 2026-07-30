//! Session forking: copy a session JSONL under a new session id so a
//! conversation can be branched for what-if experiments.
//!
//! Adopted from codex's `fork` (`ThreadManager::fork_thread` with
//! `ForkPersistence::Copied`): the fork re-persists the full history under a
//! fresh id and then appends independently of the source.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::entries::{SessionEntry, SessionHeader};
use super::writer::generate_session_filename;

/// Result of forking a session file.
#[derive(Debug, Clone)]
pub struct ForkedSession {
    /// New session id recorded in the fork's header.
    pub id: String,
    /// Path to the forked JSONL file.
    pub path: PathBuf,
    /// Id of the session the fork was copied from.
    pub source_id: String,
}

/// Copy `source_path` under a fresh session id in the same directory.
///
/// Only the first line (the session header) is rewritten: the id is replaced,
/// and `branchedFrom`/`parentSession` point back at the source. Every later
/// line is copied verbatim, so the fork's history is identical to the source
/// while its future appends are fully independent.
///
/// # Errors
///
/// Returns an I/O error if the source cannot be read or the fork cannot be
/// written, and `InvalidData` if the source has no parseable session header.
pub fn fork_session_file(source_path: &Path) -> io::Result<ForkedSession> {
    let raw = fs::read_to_string(source_path)?;
    let mut lines: Vec<&str> = raw.split_inclusive('\n').collect();

    // `source_path` may belong to a session another Maestro process has open
    // right now (forking a session someone else is actively using is exactly
    // what a fast session switcher makes easy to do). This read can land
    // mid-append, leaving the final line a torn, incomplete JSON fragment;
    // every earlier line was already a complete, newline-terminated write.
    // Drop a torn trailing line rather than copy the fragment verbatim into
    // the fork's own file -- the source file itself is never touched, and
    // the fork will simply be missing the one message that was still being
    // written when the fork ran.
    if let Some(last) = lines.last() {
        if serde_json::from_str::<serde_json::Value>(last.trim_end()).is_err() {
            lines.pop();
        }
    }

    let mut lines = lines.into_iter();
    let header_line = lines
        .next()
        .ok_or_else(|| invalid_data("empty session file"))?;
    let mut header: SessionHeader = serde_json::from_str(header_line.trim_end())
        .map_err(|err| invalid_data(format!("invalid session header: {err}")))?;

    let source_id = std::mem::replace(&mut header.id, uuid::Uuid::new_v4().to_string());
    header.branched_from = Some(source_path.to_string_lossy().into_owned());
    header.parent_session = Some(source_id.clone());

    let dir = source_path
        .parent()
        .ok_or_else(|| invalid_data("session path has no parent directory"))?;
    let id = header.id.clone();
    let path = dir.join(generate_session_filename(&id));

    let mut out = serde_json::to_string(&SessionEntry::Session(header))
        .map_err(|err| invalid_data(format!("failed to encode session header: {err}")))?;
    out.push('\n');
    out.extend(lines);
    fs::write(&path, out)?;

    Ok(ForkedSession {
        id,
        path,
        source_id,
    })
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::entries::{AppMessage, MessageContent, MessageEntry};
    use crate::session::{SessionReader, SessionWriter};
    use std::io::Write;
    use tempfile::TempDir;

    fn write_source_session(dir: &Path) -> PathBuf {
        let path = dir.join("2024-01-15T10-30-00-000Z_source-id.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"session","id":"source-id","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp/project","model":"openai/gpt-5.2","thinkingLevel":"medium"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:01Z","message":{{"role":"user","content":"try option A","timestamp":0}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:02Z","message":{{"role":"assistant","content":[{{"type":"text","text":"Done A."}}],"timestamp":1}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:03Z","message":{{"role":"user","content":"now option B","timestamp":2}}}}"#
        )
        .unwrap();
        path
    }

    #[test]
    fn fork_creates_new_id_with_identical_history() {
        let temp = TempDir::new().unwrap();
        let source_path = write_source_session(temp.path());

        let forked = fork_session_file(&source_path).unwrap();

        assert_ne!(forked.id, "source-id");
        assert!(!forked.id.is_empty());
        assert_eq!(forked.source_id, "source-id");
        assert_eq!(forked.path.parent(), Some(temp.path()));
        assert!(forked.path.exists());

        let source = SessionReader::read_file(&source_path).unwrap();
        let fork = SessionReader::read_file(&forked.path).unwrap();

        assert_eq!(fork.header.id, forked.id);
        assert_eq!(
            fork.header.parent_session.as_deref(),
            Some("source-id"),
            "parentSession points at the source id"
        );
        assert_eq!(
            fork.header.branched_from.as_deref(),
            Some(source_path.to_string_lossy().as_ref()),
            "branchedFrom points at the source file"
        );
        assert_eq!(
            fork.header.timestamp, source.header.timestamp,
            "fork keeps the original start timestamp"
        );
        assert_eq!(fork.messages.len(), source.messages.len());
        for (forked_msg, source_msg) in fork.messages.iter().zip(source.messages.iter()) {
            assert_eq!(forked_msg.text_content(), source_msg.text_content());
        }
        // The source file is untouched.
        assert_eq!(source.header.id, "source-id");
        assert_eq!(source.header.parent_session, None);
    }

    #[test]
    fn fork_future_appends_are_independent() {
        let temp = TempDir::new().unwrap();
        let source_path = write_source_session(temp.path());
        let forked = fork_session_file(&source_path).unwrap();

        // Append to the fork through the normal resume writer path.
        let mut writer = SessionWriter::open_existing(&forked.path).unwrap();
        writer
            .write_entry(SessionEntry::Message(MessageEntry {
                id: None,
                parent_id: None,
                timestamp: "2024-01-15T10:30:04Z".to_string(),
                message: AppMessage::User {
                    content: MessageContent::Text("fork-only message".to_string()),
                    attachments: None,
                    timestamp: 3,
                },
            }))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);

        let source = SessionReader::read_file(&source_path).unwrap();
        let fork = SessionReader::read_file(&forked.path).unwrap();

        assert_eq!(
            source.stats.user_messages, 2,
            "source history unchanged by fork appends"
        );
        assert_eq!(fork.stats.user_messages, 3);
        assert_eq!(
            fork.messages.last().map(|m| m.text_content()).as_deref(),
            Some("fork-only message")
        );
    }

    /// Regression test for the review finding on #3129: forking a session
    /// another Maestro process is actively appending to (see `SessionLock`
    /// in `session/writer.rs`, wired up for resume/prune in a parallel PR)
    /// can read the file mid-write. The fork must drop a torn trailing line
    /// instead of copying the fragment into its own file.
    #[test]
    fn fork_drops_a_torn_trailing_line_instead_of_copying_the_fragment() {
        let temp = TempDir::new().unwrap();
        let source_path = write_source_session(temp.path());

        // Simulate a writer caught mid-append: a final line with no
        // trailing newline and invalid JSON (as if `write!` landed the
        // opening bytes of the next entry before being interrupted).
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&source_path)
            .unwrap();
        write!(
            file,
            r#"{{"type":"message","timestamp":"2024-01-15T10:30:04"#
        )
        .unwrap();
        drop(file);

        let forked = fork_session_file(&source_path).unwrap();
        let fork_raw = fs::read_to_string(&forked.path).unwrap();
        assert!(
            fork_raw.ends_with('\n'),
            "fork must not end mid-line with a torn fragment: {fork_raw:?}"
        );
        for line in fork_raw.lines() {
            assert!(
                serde_json::from_str::<serde_json::Value>(line).is_ok(),
                "every line copied into the fork must be complete, valid JSON: {line:?}"
            );
        }

        // The source file is untouched, torn line and all -- forking never
        // mutates or truncates the file it reads from.
        let source_raw = fs::read_to_string(&source_path).unwrap();
        assert!(!source_raw.ends_with('\n'));
    }

    #[test]
    fn fork_rejects_unparseable_source() {
        let temp = TempDir::new().unwrap();
        let empty = temp.path().join("empty.jsonl");
        fs::write(&empty, b"").unwrap();
        assert!(fork_session_file(&empty).is_err());

        let garbage = temp.path().join("garbage.jsonl");
        fs::write(&garbage, b"not json\n").unwrap();
        assert!(fork_session_file(&garbage).is_err());

        // Failed forks leave no stray files behind.
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }
}

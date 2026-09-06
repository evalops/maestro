//! Session forking: copy a session JSONL under a new session id so a
//! conversation can be branched for what-if experiments.
//!
//! Adopted from codex's `fork` (`ThreadManager::fork_thread` with
//! `ForkPersistence::Copied`): the fork re-persists the full history under a
//! fresh id and then appends independently of the source.

use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use super::entries::{SessionEntry, SessionHeader};
use super::writer::generate_session_filename;

pub(super) const MAX_SESSION_LINE_BYTES: usize = 8 * 1024 * 1024;

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
    fork_session_prefix(source_path, None)
}

/// Locate the persisted boundary before the last `turns` user messages.
/// Offsets refer to complete JSONL entries, including tool and compaction records.
pub(crate) fn rewind_boundary(source_path: &Path, turns: usize) -> io::Result<u64> {
    if turns == 0 {
        return Err(invalid_data("rewind count must be at least one"));
    }
    let mut reader = BufReader::new(fs::File::open(source_path)?);
    let mut line = String::new();
    let mut offset = 0_u64;
    let mut boundaries = std::collections::VecDeque::new();
    while read_bounded_line(&mut reader, &mut line)? > 0 {
        let entry = serde_json::from_str::<SessionEntry>(line.trim_end())
            .map_err(|error| invalid_data(format!("invalid session entry: {error}")))?;
        if matches!(
            entry,
            SessionEntry::Message(super::entries::MessageEntry {
                message: super::entries::AppMessage::User { .. },
                ..
            })
        ) {
            boundaries.push_back(offset);
            if boundaries.len() > turns {
                boundaries.pop_front();
            }
        }
        offset += line.len() as u64;
    }
    boundaries
        .front()
        .copied()
        .ok_or_else(|| invalid_data("nothing to rewind"))
}

/// Fork an exact persisted prefix without changing the source transcript.
pub(crate) fn fork_session_prefix(
    source_path: &Path,
    end: Option<u64>,
) -> io::Result<ForkedSession> {
    let source = fs::File::open(source_path)?;
    let source_len = source.metadata()?.len();
    if end.is_some_and(|end| end > source_len) {
        return Err(invalid_data("rewind boundary exceeds the saved session"));
    }
    let mut reader = BufReader::new(source.take(end.unwrap_or(u64::MAX)));
    let mut line = String::new();
    let header_bytes = read_bounded_line(&mut reader, &mut line)?;
    if header_bytes == 0 {
        return Err(invalid_data("empty session file"));
    }
    if end.is_some() && !line.ends_with('\n') {
        return Err(invalid_data(
            "rewind boundary must include the complete header",
        ));
    }
    let mut header: SessionHeader = serde_json::from_str(line.trim_end())
        .map_err(|err| invalid_data(format!("invalid session header: {err}")))?;

    let source_id = std::mem::replace(&mut header.id, uuid::Uuid::new_v4().to_string());
    header.branched_from = Some(source_path.to_string_lossy().into_owned());
    header.parent_session = Some(source_id.clone());

    let dir = source_path
        .parent()
        .ok_or_else(|| invalid_data("session path has no parent directory"))?;
    let id = header.id.clone();
    let path = dir.join(generate_session_filename(&id));
    let temp_path = dir.join(format!(".{id}.fork-{}.tmp", uuid::Uuid::new_v4()));

    let write_result = (|| -> io::Result<()> {
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(output);

        let mut header = serde_json::to_string(&SessionEntry::Session(header))
            .map_err(|err| invalid_data(format!("failed to encode session header: {err}")))?;
        header.push('\n');
        writer.write_all(header.as_bytes())?;

        // Keep only one line buffered beyond the writer. This preserves the
        // existing behavior of dropping a torn final line without loading the
        // whole session into memory, and it also bounds every individual line.
        let mut pending = String::new();
        let mut next = String::new();
        let mut has_pending = false;
        loop {
            let bytes = read_bounded_line(&mut reader, &mut next)?;
            if bytes == 0 {
                break;
            }
            if has_pending {
                writer.write_all(pending.as_bytes())?;
            }
            std::mem::swap(&mut pending, &mut next);
            has_pending = true;
        }

        if has_pending {
            let valid = serde_json::from_str::<serde_json::Value>(pending.trim_end()).is_ok();
            if end.is_some() && (!valid || !pending.ends_with('\n')) {
                return Err(invalid_data(
                    "rewind boundary must end at a complete session entry",
                ));
            }
            if valid {
                writer.write_all(pending.as_bytes())?;
            }
        }
        writer.flush()?;
        writer.get_ref().sync_all()
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp_path, &path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    crate::fs_atomic::sync_dir(dir)?;

    Ok(ForkedSession {
        id,
        path,
        source_id,
    })
}

fn read_bounded_line<R: BufRead>(reader: &mut R, line: &mut String) -> io::Result<usize> {
    line.clear();
    let mut total = 0;

    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(total);
        }

        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.map_or(chunk.len(), |index| index + 1);
        if total.saturating_add(chunk_len) > MAX_SESSION_LINE_BYTES {
            return Err(invalid_data(format!(
                "session line exceeds {MAX_SESSION_LINE_BYTES} bytes"
            )));
        }

        let text = std::str::from_utf8(&chunk[..chunk_len])
            .map_err(|err| invalid_data(format!("session file is not UTF-8: {err}")))?;
        line.push_str(text);
        reader.consume(chunk_len);
        total += chunk_len;

        if newline.is_some() {
            return Ok(total);
        }
    }
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
    fn rewind_prefix_reopens_and_appends_without_resurrecting_removed_turns() {
        let temp = TempDir::new().unwrap();
        let source_path = write_source_session(temp.path());
        let original = fs::read(&source_path).unwrap();
        let boundary = rewind_boundary(&source_path, 1).unwrap();
        let fork = fork_session_prefix(&source_path, Some(boundary)).unwrap();
        let reopened = SessionReader::read_file(&fork.path).unwrap();
        assert_eq!(reopened.stats.user_messages, 1);
        assert_eq!(reopened.messages.last().unwrap().text_content(), "Done A.");
        assert_eq!(reopened.header.parent_session.as_deref(), Some("source-id"));
        {
            let mut writer = SessionWriter::open_existing(&fork.path).unwrap();
            writer
                .write_entry(SessionEntry::Message(MessageEntry {
                    id: None,
                    parent_id: None,
                    timestamp: "2024-01-15T10:30:04Z".into(),
                    message: AppMessage::User {
                        content: MessageContent::Text("try option C".into()),
                        attachments: None,
                        timestamp: 4,
                    },
                }))
                .unwrap();
            writer.flush().unwrap();
        }
        let reopened = SessionReader::read_file(&fork.path).unwrap();
        assert_eq!(reopened.stats.user_messages, 2);
        assert!(
            !reopened
                .messages
                .iter()
                .any(|m| m.text_content() == "now option B")
        );
        assert_eq!(fs::read(&source_path).unwrap(), original);
    }

    #[test]
    fn rewind_rejects_partial_entry_and_handles_first_turn() {
        let temp = TempDir::new().unwrap();
        let source = write_source_session(temp.path());
        let first = rewind_boundary(&source, usize::MAX).unwrap();
        let fork = fork_session_prefix(&source, Some(first)).unwrap();
        assert_eq!(
            SessionReader::read_file(&fork.path)
                .unwrap()
                .stats
                .user_messages,
            0
        );
        let second = rewind_boundary(&source, 1).unwrap();
        assert!(fork_session_prefix(&source, Some(second - 2)).is_err());
        assert!(rewind_boundary(&source, 0).is_err());
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

    #[test]
    fn fork_rejects_a_session_line_over_the_streaming_limit() {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("oversized.jsonl");
        let mut file = fs::File::create(&source_path).unwrap();
        writeln!(
            file,
            r#"{{"type":"session","id":"source-id","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp/project"}}"#
        )
        .unwrap();
        let payload = "x".repeat(8 * 1024 * 1024);
        writeln!(file, r#"{{"type":"message","payload":"{payload}"}}"#).unwrap();

        let error = fork_session_file(&source_path).expect_err("oversized line must be bounded");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}

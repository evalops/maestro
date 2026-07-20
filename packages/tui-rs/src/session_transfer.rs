//! Portable session import/export owned by the native CLI.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::credential_store::redact_credentials_in_json;
use crate::session::SessionManager;

const PORTABLE_FORMAT: &str = "maestro-session-export.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortableFormat {
    Json,
    Jsonl,
}

#[derive(Debug)]
pub struct ImportResult {
    pub session_file: PathBuf,
    pub session_id: String,
    pub imported_count: usize,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    session_id: String,
    parent_session_id: Option<String>,
    parent_session_file: Option<PathBuf>,
    timestamp: String,
    path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableBundle {
    format: String,
    exported_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sessions: Vec<PortableSession>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableSession {
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    entries: Vec<Value>,
}

pub fn export_portable_session(
    manager: &SessionManager,
    session_id: &str,
    output: Option<&Path>,
    format: PortableFormat,
    redact_secrets: bool,
) -> Result<PathBuf> {
    let selected = find_session(manager, session_id)?;
    let output = output.map_or_else(
        || default_export_path(&selected.path, format),
        Path::to_path_buf,
    );
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create export directory {}", parent.display()))?;
    }

    match format {
        PortableFormat::Jsonl if !redact_secrets => {
            fs::copy(&selected.path, &output).with_context(|| {
                format!("copy {} to {}", selected.path.display(), output.display())
            })?;
        }
        PortableFormat::Jsonl => {
            let entries = portable_entries(&selected.path, true)?;
            write_jsonl(&output, &entries)?;
        }
        PortableFormat::Json => {
            let records = session_records(
                selected
                    .path
                    .parent()
                    .context("selected session has no parent directory")?,
            )?;
            let ordered = related_sessions(&records, &selected.session_id);
            let sessions = ordered
                .iter()
                .map(|record| {
                    Ok(PortableSession {
                        session_id: record.session_id.clone(),
                        parent_session_id: record.parent_session_id.clone(),
                        entries: portable_entries(&record.path, redact_secrets)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let bundle = PortableBundle {
                format: PORTABLE_FORMAT.to_string(),
                exported_at: chrono::Utc::now().to_rfc3339(),
                session_id: Some(selected.session_id.clone()),
                entries: Some(portable_entries(&selected.path, redact_secrets)?),
                sessions,
            };
            write_private_file(&output, &serde_json::to_vec(&bundle)?)?;
        }
    }
    Ok(output)
}

pub fn import_portable_session(manager: &SessionManager, source: &Path) -> Result<ImportResult> {
    if !source.exists() {
        bail!("Import file not found: {}", source.display());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "json" {
        let raw = fs::read(source).with_context(|| format!("read {}", source.display()))?;
        let bundle: PortableBundle = serde_json::from_slice(&raw).with_context(|| {
            format!(
                "Portable session export is not valid JSON: {}",
                source.display()
            )
        })?;
        if bundle.format != PORTABLE_FORMAT {
            bail!("Unsupported portable session format: {}", bundle.format);
        }
        if !bundle.sessions.is_empty() {
            return import_bundle(manager, bundle);
        }
        if let Some(entries) = bundle.entries {
            return import_entries(manager, entries);
        }
        bail!("Portable session export is missing both entries and sessions");
    }

    import_entries(manager, portable_entries(source, false)?)
}

fn default_export_path(source: &Path, format: PortableFormat) -> PathBuf {
    match format {
        PortableFormat::Jsonl => PathBuf::from(
            source
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("session.jsonl")),
        ),
        PortableFormat::Json => PathBuf::from(
            source
                .file_stem()
                .unwrap_or_else(|| std::ffi::OsStr::new("session")),
        )
        .with_extension("json"),
    }
}

fn find_session(manager: &SessionManager, id: &str) -> Result<SessionRecord> {
    let sessions = manager
        .list_sessions()
        .context("list workspace sessions")?
        .into_iter()
        .chain(manager.list_all_sessions().context("list all sessions")?)
        .collect::<Vec<_>>();
    let info = sessions
        .iter()
        .find(|session| session.id == id)
        .or_else(|| sessions.iter().find(|session| session.id.starts_with(id)))
        .with_context(|| format!("Session not found: {id}"))?;
    session_record(&info.path)?.with_context(|| format!("invalid session: {}", info.path.display()))
}

fn session_records(directory: &Path) -> Result<Vec<SessionRecord>> {
    let mut records = fs::read_dir(directory)
        .with_context(|| format!("read session directory {}", directory.display()))?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter_map(|path| session_record(&path).transpose())
        .collect::<Result<Vec<_>>>()?;
    let by_path = records
        .iter()
        .map(|record| (canonicalish(&record.path), record.session_id.clone()))
        .collect::<HashMap<_, _>>();
    for record in &mut records {
        if record.parent_session_id.is_none() {
            record.parent_session_id = record
                .parent_session_file
                .as_ref()
                .and_then(|path| by_path.get(&canonicalish(path)).cloned());
        }
    }
    records.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    Ok(records)
}

fn session_record(path: &Path) -> Result<Option<SessionRecord>> {
    let Some(entries) = portable_entries(path, false).ok() else {
        return Ok(None);
    };
    let Some(header) = entries
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("session"))
    else {
        return Ok(None);
    };
    let Some(session_id) = header
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let parent_session_file = header
        .get("branchedFrom")
        .or_else(|| header.get("branched_from"))
        .and_then(Value::as_str)
        .map(PathBuf::from);
    Ok(Some(SessionRecord {
        session_id: session_id.to_string(),
        parent_session_id: header
            .get("parentSession")
            .or_else(|| header.get("parent_session"))
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_session_file,
        timestamp: header
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        path: path.to_path_buf(),
    }))
}

fn related_sessions<'a>(records: &'a [SessionRecord], selected_id: &str) -> Vec<&'a SessionRecord> {
    let by_id = records
        .iter()
        .map(|record| (record.session_id.as_str(), record))
        .collect::<HashMap<_, _>>();
    let mut root = by_id.get(selected_id).copied();
    let mut visited = HashSet::new();
    while let Some(record) = root {
        if !visited.insert(record.session_id.as_str()) {
            break;
        }
        let Some(parent) = record
            .parent_session_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied())
        else {
            break;
        };
        root = Some(parent);
    }
    let Some(root) = root else {
        return Vec::new();
    };
    let mut children: HashMap<&str, Vec<&SessionRecord>> = HashMap::new();
    for record in records {
        if let Some(parent) = record.parent_session_id.as_deref() {
            children.entry(parent).or_default().push(record);
        }
    }
    for values in children.values_mut() {
        values.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    }
    let mut queue = VecDeque::from([root]);
    let mut enqueued = HashSet::from([root.session_id.as_str()]);
    let mut ordered = Vec::new();
    while let Some(record) = queue.pop_front() {
        ordered.push(record);
        for child in children
            .get(record.session_id.as_str())
            .into_iter()
            .flatten()
        {
            if enqueued.insert(child.session_id.as_str()) {
                queue.push_back(child);
            }
        }
    }
    ordered
}

fn portable_entries(path: &Path, redact: bool) -> Result<Vec<Value>> {
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .map(|entry| {
            if redact {
                redact_credentials_in_json(&entry)
            } else {
                entry
            }
        })
        .collect())
}

fn import_bundle(manager: &SessionManager, bundle: PortableBundle) -> Result<ImportResult> {
    let selected_source = bundle.session_id.clone();
    let first_source = bundle
        .sessions
        .first()
        .map(|session| session.session_id.clone());
    let mut pending = bundle.sessions;
    let mut ordered = Vec::new();
    while !pending.is_empty() {
        let mut progressed = false;
        let mut index = 0;
        while index < pending.len() {
            let waiting_for_parent =
                pending[index]
                    .parent_session_id
                    .as_ref()
                    .is_some_and(|parent| {
                        pending
                            .iter()
                            .any(|candidate| &candidate.session_id == parent)
                    });
            if waiting_for_parent {
                index += 1;
            } else {
                ordered.push(pending.remove(index));
                progressed = true;
            }
        }
        if !progressed {
            ordered.append(&mut pending);
            break;
        }
    }

    let mut existing = existing_ids(manager);
    let mut imported_ids = HashMap::new();
    let mut imported_files = HashMap::new();
    for session in ordered {
        let source_id = session.session_id.clone();
        let parent_id = session
            .parent_session_id
            .as_ref()
            .and_then(|parent| imported_ids.get(parent).cloned());
        let parent_file = session
            .parent_session_id
            .as_ref()
            .and_then(|parent| imported_files.get(parent).cloned());
        let (id, file) = write_imported_entries(
            manager.sessions_dir(),
            session.entries,
            &mut existing,
            parent_id.as_deref(),
            parent_file.as_deref(),
        )?;
        imported_ids.insert(source_id.clone(), id);
        imported_files.insert(source_id, file);
    }
    let selected_source = selected_source
        .filter(|id| imported_ids.contains_key(id))
        .or(first_source)
        .context("Portable session bundle contained no sessions")?;
    Ok(ImportResult {
        session_file: imported_files[&selected_source].clone(),
        session_id: imported_ids[&selected_source].clone(),
        imported_count: imported_ids.len(),
    })
}

fn import_entries(manager: &SessionManager, entries: Vec<Value>) -> Result<ImportResult> {
    let mut existing = existing_ids(manager);
    let (session_id, session_file) =
        write_imported_entries(manager.sessions_dir(), entries, &mut existing, None, None)?;
    Ok(ImportResult {
        session_file,
        session_id,
        imported_count: 1,
    })
}

fn existing_ids(manager: &SessionManager) -> HashSet<String> {
    manager
        .list_all_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|session| session.id)
        .collect()
}

fn write_imported_entries(
    directory: &Path,
    mut entries: Vec<Value>,
    existing: &mut HashSet<String>,
    parent_session_id: Option<&str>,
    parent_session_file: Option<&Path>,
) -> Result<(String, PathBuf)> {
    let header_index = entries
        .iter()
        .position(|entry| entry.get("type").and_then(Value::as_str) == Some("session"))
        .context("Imported session file is missing a session header")?;
    let header = entries[header_index]
        .as_object_mut()
        .context("Imported session header is not an object")?;
    let proposed = header
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let session_id = if existing.contains(&proposed) {
        uuid::Uuid::new_v4().to_string()
    } else {
        proposed
    };
    existing.insert(session_id.clone());
    header.insert("id".to_string(), Value::String(session_id.clone()));
    header.remove("subject");
    if let Some(parent) = parent_session_id {
        header.insert(
            "parentSession".to_string(),
            Value::String(parent.to_string()),
        );
    }
    if let Some(parent) = parent_session_file {
        header.insert(
            "branchedFrom".to_string(),
            Value::String(parent.display().to_string()),
        );
    }
    fs::create_dir_all(directory)
        .with_context(|| format!("create session directory {}", directory.display()))?;
    let file = directory.join(format!(
        "{}_{}.jsonl",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ"),
        session_id
    ));
    write_jsonl(&file, &entries)?;
    Ok((session_id, file))
}

fn write_jsonl(path: &Path, entries: &[Value]) -> Result<()> {
    let mut bytes = Vec::new();
    for entry in entries {
        serde_json::to_writer(&mut bytes, entry)?;
        bytes.push(b'\n');
    }
    write_private_file(path, &bytes)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("write {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", path.display()))
}

fn canonicalish(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_secret(prefix: &str) -> String {
        [prefix, "abcdefghijklmnopqrstuvwxyz123456"].concat()
    }

    fn entry(id: &str, parent: Option<&str>, content: &str) -> Vec<Value> {
        vec![
            serde_json::json!({
                "type": "session",
                "id": id,
                "timestamp": "2026-01-01T00:00:00Z",
                "cwd": "/tmp/project",
                "model": "openai/gpt-5",
                "parentSession": parent,
            }),
            serde_json::json!({"type": "user", "message": content}),
        ]
    }

    #[test]
    fn bundle_export_keeps_branch_family_and_redacts_secrets() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent.jsonl");
        let child = root.path().join("child.jsonl");
        write_jsonl(&parent, &entry("parent", None, "hello")).unwrap();
        write_jsonl(
            &child,
            &entry(
                "child",
                Some("parent"),
                &format!("apiKey={}", fixture_secret("sk-ant-")),
            ),
        )
        .unwrap();

        let records = session_records(root.path()).unwrap();
        let ordered = related_sessions(&records, "child");
        assert_eq!(
            ordered
                .iter()
                .map(|record| record.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["parent", "child"]
        );
        let redacted = portable_entries(&child, true).unwrap();
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("sk-ant-"));
        assert!(serialized.contains("[REDACTED:api_key:portable-export]"));
    }

    #[test]
    fn imported_bundle_rewrites_conflicts_and_parent_links() {
        let root = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(root.path().to_string_lossy());
        let mut existing = HashSet::from(["parent".to_string()]);
        let (parent_id, parent_file) = write_imported_entries(
            root.path(),
            entry("parent", None, "root"),
            &mut existing,
            None,
            None,
        )
        .unwrap();
        assert_ne!(parent_id, "parent");
        let (child_id, child_file) = write_imported_entries(
            root.path(),
            entry("child", Some("parent"), "branch"),
            &mut existing,
            Some(&parent_id),
            Some(&parent_file),
        )
        .unwrap();
        let child_entries = portable_entries(&child_file, false).unwrap();
        let header = child_entries[0].as_object().unwrap();
        assert_eq!(header["id"], child_id);
        assert_eq!(header["parentSession"], parent_id);
        assert_eq!(header["branchedFrom"], parent_file.display().to_string());
        drop(manager);
    }

    #[test]
    fn jsonl_redaction_preserves_valid_entries_and_drops_partial_lines() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.jsonl");
        let source_contents = format!(
            "{{\"type\":\"session\",\"id\":\"one\"}}\npartial\n{{\"type\":\"user\",\"message\":\"Bearer {}\"}}\n",
            fixture_secret("sk-")
        );
        fs::write(&source, source_contents).unwrap();
        let entries = portable_entries(&source, true).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(!serde_json::to_string(&entries).unwrap().contains("sk-abc"));
    }
}

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{now_rfc3339, AppState, ATTACHMENT_TEMP_COUNTER};

use super::tasks::{
    a2a_agent_message, a2a_task_is_terminal, a2a_task_status_state, a2a_task_status_timestamp,
    a2a_task_value, generate_a2a_id, A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME,
    A2A_CONTROL_PLANE_LEDGER_PEER,
};

pub(crate) const A2A_LEDGER_LOCK_RETRY_MS: u64 = 25;
const A2A_LEDGER_LOCK_STALE_MS: u64 = 30_000;
const A2A_LEDGER_LOCK_TIMEOUT_MS: u64 = A2A_LEDGER_LOCK_STALE_MS + A2A_LEDGER_LOCK_RETRY_MS;
const A2A_LEDGER_LOCK_OWNER_FILE: &str = "owner";
pub(crate) const A2A_LEDGER_LOCK_HEARTBEAT_FILE: &str = "heartbeat";

pub(crate) async fn load_a2a_tasks(path: &Path) -> HashMap<String, Value> {
    let Some(parsed) = read_a2a_task_ledger_value(path).await else {
        return HashMap::new();
    };
    a2a_task_ledger_entries(&parsed)
        .into_iter()
        .filter_map(|entry| a2a_task_from_ledger_entry(&entry))
        .filter_map(|task| {
            let task_id = task.get("id").and_then(Value::as_str)?.trim().to_string();
            (!task_id.is_empty()).then_some((task_id, task))
        })
        .collect()
}

async fn read_a2a_task_ledger_value(path: &Path) -> Option<Value> {
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to read A2A task ledger {}: {error}", path.display());
            }
            return None;
        }
    };
    match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!(
                "failed to parse A2A task ledger {}: {error}",
                path.display()
            );
            None
        }
    }
}

fn a2a_task_ledger_entries(ledger: &Value) -> Vec<Value> {
    ledger
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn a2a_task_from_ledger_entry(entry: &Value) -> Option<Value> {
    let peer = entry.get("peer").and_then(Value::as_str);
    if peer.is_some_and(|peer| peer != A2A_CONTROL_PLANE_LEDGER_PEER) {
        return None;
    }
    if let Some(task) = entry.get("a2aTask").and_then(Value::as_object) {
        let task = Value::Object(task.clone());
        if task.get("id").and_then(Value::as_str).is_some() {
            return Some(task);
        }
    }
    if entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("status").and_then(Value::as_object).is_some()
    {
        return Some(entry.clone());
    }
    if peer != Some(A2A_CONTROL_PLANE_LEDGER_PEER) {
        return None;
    }
    let task_id = entry.get("taskId").and_then(Value::as_str)?;
    let context_id = entry
        .get("contextId")
        .and_then(Value::as_str)
        .unwrap_or("maestro-control-plane");
    let state = entry
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("TASK_STATE_UNKNOWN");
    let updated_at = entry
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339);
    let status_message_text = entry
        .get("responseText")
        .and_then(Value::as_str)
        .or_else(|| entry.get("text").and_then(Value::as_str))
        .unwrap_or("Restored A2A task from Maestro ledger.");
    let status_message = a2a_agent_message(context_id, status_message_text);
    let history = entry
        .get("transcript")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| a2a_message_from_ledger_transcript(context_id, item))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let metadata = entry
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut task = a2a_task_value(
        task_id,
        context_id,
        state,
        status_message,
        history,
        Vec::new(),
        metadata,
    );
    task["status"]["timestamp"] = Value::String(updated_at);
    Some(task)
}

fn a2a_message_from_ledger_transcript(context_id: &str, item: &Value) -> Option<Value> {
    let text = item.get("text").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let role = match item.get("role").and_then(Value::as_str) {
        Some(role) if role.eq_ignore_ascii_case("agent") => "ROLE_AGENT",
        _ => "ROLE_USER",
    };
    let message_id = item
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| generate_a2a_id("maestro-message"));
    Some(serde_json::json!({
        "messageId": message_id,
        "contextId": context_id,
        "role": role,
        "parts": [{ "text": text, "mediaType": "text/plain" }]
    }))
}

pub(crate) async fn persist_a2a_tasks(state: &AppState) {
    let _guard = state.a2a_task_persist_lock.lock().await;
    let file_lock = match acquire_a2a_task_ledger_file_lock(&state.config.a2a_tasks_file_path).await
    {
        Ok(file_lock) => file_lock,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let heartbeat_task =
        spawn_a2a_task_ledger_lock_heartbeat(&file_lock, a2a_task_ledger_lock_heartbeat_interval());
    let result = persist_a2a_tasks_locked(state).await;
    heartbeat_task.abort();
    let _ = heartbeat_task.await;
    release_a2a_task_ledger_file_lock(file_lock).await;
    if let Err(error) = result {
        eprintln!("{error}");
    }
}

async fn persist_a2a_tasks_locked(state: &AppState) -> Result<(), String> {
    let existing_entries = read_a2a_task_ledger_value(&state.config.a2a_tasks_file_path)
        .await
        .map(|ledger| a2a_task_ledger_entries(&ledger))
        .unwrap_or_default();
    let tasks = state.a2a_tasks.lock().await;
    let local_task_ids = tasks.keys().cloned().collect::<Vec<_>>();
    let mut retained_entries = existing_entries
        .iter()
        .filter(|entry| {
            if a2a_ledger_entry_is_raw_a2a_task(entry) {
                return false;
            }
            if a2a_ledger_entry_is_control_plane(entry) {
                let task_id = ledger_entry_task_id(entry);
                if task_id.is_empty() {
                    return true;
                }
                return !local_task_ids.iter().any(|local_id| local_id == task_id);
            }
            true
        })
        .cloned()
        .collect::<Vec<_>>();
    let existing_control_plane_entries = existing_entries
        .into_iter()
        .filter(a2a_ledger_entry_is_control_plane)
        .filter_map(|entry| {
            let task_id = entry.get("taskId").and_then(Value::as_str)?.to_string();
            Some((task_id, entry))
        })
        .collect::<HashMap<_, _>>();
    let mut control_plane_entries = tasks
        .values()
        .cloned()
        .filter_map(|task| {
            let task_id = task.get("id").and_then(Value::as_str)?;
            let existing = existing_control_plane_entries.get(task_id);
            Some(a2a_ledger_entry_from_task(&task, existing))
        })
        .collect::<Vec<_>>();
    drop(tasks);
    retained_entries.append(&mut control_plane_entries);
    retained_entries.sort_by(|left, right| {
        ledger_entry_updated_at(left)
            .cmp(ledger_entry_updated_at(right))
            .then_with(|| ledger_entry_task_id(left).cmp(ledger_entry_task_id(right)))
    });
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "tasks": retained_entries }))
        .unwrap_or_else(|_| br#"{"tasks":[]}"#.to_vec());
    let path = &state.config.a2a_tasks_file_path;
    if let Some(parent) = path.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return Err(format!(
                "failed to create A2A task ledger directory {}: {error}",
                parent.display()
            ));
        }
    }
    let tmp_path = a2a_task_ledger_temp_path(path);
    if let Err(error) = tokio::fs::write(&tmp_path, body).await {
        return Err(format!(
            "failed to write A2A task ledger {}: {error}",
            tmp_path.display()
        ));
    }
    if let Err(error) = tokio::fs::rename(&tmp_path, path).await {
        let message = format!(
            "failed to replace A2A task ledger {}: {error}",
            path.display()
        );
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(message);
    }
    Ok(())
}

pub(crate) struct A2ATaskLedgerFileLock {
    pub(crate) path: PathBuf,
    pub(crate) token: String,
}

pub(crate) async fn acquire_a2a_task_ledger_file_lock(
    path: &Path,
) -> Result<A2ATaskLedgerFileLock, String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "failed to create A2A task ledger directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let lock_path = a2a_task_ledger_lock_path(path);
    let token = format!(
        "{}:{}",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let deadline = Instant::now() + Duration::from_millis(A2A_LEDGER_LOCK_TIMEOUT_MS);
    loop {
        match tokio::fs::create_dir(&lock_path).await {
            Ok(()) => {
                if let Err(error) = write_a2a_task_ledger_lock_metadata(&lock_path, &token).await {
                    let _ = tokio::fs::remove_dir_all(&lock_path).await;
                    return Err(error);
                }
                return Ok(A2ATaskLedgerFileLock {
                    path: lock_path,
                    token,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if a2a_task_ledger_lock_is_stale(&lock_path).await {
                    let _ = tokio::fs::remove_dir_all(&lock_path).await;
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for A2A task ledger lock {}",
                        lock_path.display()
                    ));
                }
                tokio::time::sleep(Duration::from_millis(A2A_LEDGER_LOCK_RETRY_MS)).await;
            }
            Err(error) => {
                return Err(format!(
                    "failed to acquire A2A task ledger lock {}: {error}",
                    lock_path.display()
                ));
            }
        }
    }
}

async fn write_a2a_task_ledger_lock_metadata(lock_path: &Path, token: &str) -> Result<(), String> {
    tokio::fs::write(
        lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE),
        format!("{token}\n"),
    )
    .await
    .map_err(|error| {
        format!(
            "failed to write A2A task ledger lock owner {}: {error}",
            lock_path.display()
        )
    })?;
    write_a2a_task_ledger_lock_heartbeat(lock_path).await
}

async fn write_a2a_task_ledger_lock_heartbeat(lock_path: &Path) -> Result<(), String> {
    tokio::fs::write(
        lock_path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE),
        format!("{}\n", unix_millis_now()),
    )
    .await
    .map_err(|error| {
        format!(
            "failed to write A2A task ledger lock heartbeat {}: {error}",
            lock_path.display()
        )
    })
}

fn a2a_task_ledger_lock_heartbeat_interval() -> Duration {
    Duration::from_millis(
        (A2A_LEDGER_LOCK_STALE_MS / 3)
            .max(A2A_LEDGER_LOCK_RETRY_MS)
            .max(1),
    )
}

pub(crate) fn spawn_a2a_task_ledger_lock_heartbeat(
    file_lock: &A2ATaskLedgerFileLock,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    let lock_path = file_lock.path.clone();
    let token = file_lock.token.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if !a2a_task_ledger_lock_is_owned(&lock_path, &token).await {
                break;
            }
            let _ = write_a2a_task_ledger_lock_heartbeat(&lock_path).await;
        }
    })
}

pub(crate) async fn release_a2a_task_ledger_file_lock(file_lock: A2ATaskLedgerFileLock) {
    if a2a_task_ledger_lock_is_owned(&file_lock.path, &file_lock.token).await {
        let _ = tokio::fs::remove_dir_all(&file_lock.path).await;
    }
}

async fn a2a_task_ledger_lock_is_owned(lock_path: &Path, token: &str) -> bool {
    tokio::fs::read_to_string(lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE))
        .await
        .map(|owner| owner.trim() == token)
        .unwrap_or(false)
}

async fn a2a_task_ledger_lock_is_stale(lock_path: &Path) -> bool {
    let modified_at = match a2a_task_ledger_lock_modified_at(lock_path).await {
        Some(modified_at) => modified_at,
        None => return true,
    };
    SystemTime::now()
        .duration_since(modified_at)
        .map(|age| age > Duration::from_millis(A2A_LEDGER_LOCK_STALE_MS))
        .unwrap_or(false)
}

async fn a2a_task_ledger_lock_modified_at(lock_path: &Path) -> Option<SystemTime> {
    for path in [
        lock_path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE),
        lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE),
        lock_path.to_path_buf(),
    ] {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => return metadata.modified().ok(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
    }
    None
}

pub(crate) fn a2a_task_ledger_lock_path(path: &Path) -> PathBuf {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    PathBuf::from(lock_path)
}

fn a2a_task_ledger_temp_path(path: &Path) -> PathBuf {
    let mut tmp_path = path.as_os_str().to_os_string();
    tmp_path.push(format!(
        ".{}.{}.tmp",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    PathBuf::from(tmp_path)
}

fn unix_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn a2a_ledger_entry_is_control_plane(entry: &Value) -> bool {
    entry.get("peer").and_then(Value::as_str) == Some(A2A_CONTROL_PLANE_LEDGER_PEER)
        || (entry.get("peer").is_none()
            && entry.get("id").and_then(Value::as_str).is_some()
            && entry.get("status").and_then(Value::as_object).is_some())
}

fn a2a_ledger_entry_is_raw_a2a_task(entry: &Value) -> bool {
    entry.get("peer").is_none()
        && entry.get("taskId").is_none()
        && entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("status").and_then(Value::as_object).is_some()
}

fn a2a_ledger_entry_from_task(task: &Value, existing: Option<&Value>) -> Value {
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown-task");
    let context_id = task.get("contextId").and_then(Value::as_str);
    let state = a2a_task_status_state(task).unwrap_or("TASK_STATE_UNKNOWN");
    let updated_at = a2a_task_status_timestamp(task)
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339);
    let transcript = a2a_task_transcript(task, state, &updated_at);
    let text = transcript
        .iter()
        .find(|entry| entry.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|entry| entry.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            existing
                .and_then(|entry| entry.get("text").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("A2A task {task_id}"));
    let response_text = a2a_task_response_text(task);
    let created_at = existing
        .and_then(|entry| entry.get("createdAt").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            transcript
                .first()
                .and_then(|entry| entry.get("at").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| updated_at.clone());
    let metadata = a2a_clean_ledger_metadata(task.get("metadata"));
    let mut entry = serde_json::json!({
        "id": existing
            .and_then(|entry| entry.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("maestro-control-plane-{task_id}")),
        "kind": "message",
        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
        "peerDisplayName": A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME,
        "taskId": task_id,
        "text": text,
        "state": state,
        "transcript": transcript,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "metadata": metadata,
        "a2aTask": task
    });
    if let Some(context_id) = context_id {
        entry["contextId"] = Value::String(context_id.to_string());
    }
    if let Some(message_id) = a2a_task_first_user_message_id(task) {
        entry["messageId"] = Value::String(message_id);
    }
    if let Some(response_text) = response_text {
        entry["responseText"] = Value::String(response_text);
    }
    if a2a_task_is_terminal(task) {
        entry["completedAt"] = entry["updatedAt"].clone();
    }
    entry
}

fn a2a_task_transcript(task: &Value, state: &str, updated_at: &str) -> Vec<Value> {
    task.get("history")
        .and_then(Value::as_array)
        .map(|history| {
            history
                .iter()
                .filter_map(|message| a2a_transcript_entry_from_message(message, state, updated_at))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn a2a_transcript_entry_from_message(
    message: &Value,
    state: &str,
    updated_at: &str,
) -> Option<Value> {
    let text = a2a_message_value_text(message)?;
    let role = match message.get("role").and_then(Value::as_str) {
        Some(role)
            if role.eq_ignore_ascii_case("ROLE_AGENT") || role.eq_ignore_ascii_case("agent") =>
        {
            "agent"
        }
        _ => "user",
    };
    let mut entry = serde_json::json!({
        "at": updated_at,
        "role": role,
        "text": text
    });
    if role == "agent" {
        entry["state"] = Value::String(state.to_string());
    }
    if let Some(message_id) = message.get("messageId").and_then(Value::as_str) {
        entry["messageId"] = Value::String(message_id.to_string());
    }
    Some(entry)
}

fn a2a_task_response_text(task: &Value) -> Option<String> {
    task.get("status")
        .and_then(|status| status.get("message"))
        .and_then(a2a_message_value_text)
        .or_else(|| {
            task.get("artifacts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|artifact| {
                    artifact
                        .get("parts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .map(str::trim)
                .find(|text| !text.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            task.get("history")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .rev()
                .find(|message| {
                    message
                        .get("role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| {
                            role.eq_ignore_ascii_case("ROLE_AGENT")
                                || role.eq_ignore_ascii_case("agent")
                        })
                })
                .and_then(a2a_message_value_text)
        })
}

fn a2a_message_value_text(message: &Value) -> Option<String> {
    let text = message
        .get("parts")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn a2a_task_first_user_message_id(task: &Value) -> Option<String> {
    task.get("history")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(|role| {
                    role.eq_ignore_ascii_case("ROLE_USER") || role.eq_ignore_ascii_case("user")
                })
        })
        .and_then(|message| message.get("messageId").and_then(Value::as_str))
        .map(str::to_string)
}

fn a2a_clean_ledger_metadata(metadata: Option<&Value>) -> Value {
    let object = metadata
        .and_then(Value::as_object)
        .map(|metadata| {
            metadata
                .iter()
                .filter_map(|(key, value)| match value {
                    Value::String(_) | Value::Number(_) | Value::Bool(_) => {
                        Some((key.clone(), value.clone()))
                    }
                    _ => None,
                })
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    Value::Object(object)
}

fn ledger_entry_updated_at(entry: &Value) -> &str {
    entry
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn ledger_entry_task_id(entry: &Value) -> &str {
    entry
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

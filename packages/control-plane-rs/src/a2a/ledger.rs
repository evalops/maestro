use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{now_rfc3339, AppState, ATTACHMENT_TEMP_COUNTER};

use super::tasks::{
    a2a_agent_message, a2a_task_is_terminal, a2a_task_status_state, a2a_task_status_timestamp,
    a2a_task_value, canonical_a2a_task_state, generate_a2a_id,
    A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME, A2A_CONTROL_PLANE_LEDGER_PEER,
    A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY,
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
            return Some(a2a_task_with_ledger_evidence(task, entry));
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
        .map(canonical_a2a_task_state)
        .unwrap_or_else(|| "TASK_STATE_UNKNOWN".to_string());
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
    let metadata = a2a_task_metadata_from_ledger_entry(entry);
    let mut task = a2a_task_value(
        task_id,
        context_id,
        &state,
        status_message,
        history,
        Vec::new(),
        metadata,
    );
    task["status"]["timestamp"] = Value::String(updated_at);
    Some(task)
}

fn a2a_task_metadata_from_ledger_entry(entry: &Value) -> Value {
    let mut metadata = entry
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    a2a_merge_ledger_work_graph_into_metadata(&mut metadata, entry);
    metadata
}

fn a2a_task_with_ledger_evidence(mut task: Value, entry: &Value) -> Value {
    let context_id = task
        .get("contextId")
        .and_then(Value::as_str)
        .or_else(|| entry.get("contextId").and_then(Value::as_str))
        .unwrap_or("maestro-control-plane")
        .to_string();
    let Some(task_object) = task.as_object_mut() else {
        return task;
    };
    let metadata = task_object
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    a2a_merge_ledger_work_graph_into_metadata(metadata, entry);
    a2a_merge_ledger_status_into_task(task_object, entry, &context_id);
    if let Some(history) = a2a_history_from_ledger_transcript(&context_id, entry) {
        a2a_merge_ledger_history_into_task(task_object, history);
    }
    task
}

fn a2a_history_from_ledger_transcript(context_id: &str, entry: &Value) -> Option<Vec<Value>> {
    let history = entry
        .get("transcript")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| a2a_message_from_ledger_transcript(context_id, item))
        .collect::<Vec<_>>();
    (!history.is_empty()).then_some(history)
}

fn a2a_merge_ledger_history_into_task(
    task_object: &mut Map<String, Value>,
    ledger_history: Vec<Value>,
) {
    let history = task_object
        .entry("history".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !history.is_array() {
        *history = Value::Array(ledger_history);
        return;
    }
    let Some(history_array) = history.as_array_mut() else {
        return;
    };
    for message in ledger_history {
        a2a_merge_ledger_message_into_history(history_array, message);
    }
}

fn a2a_merge_ledger_message_into_history(history: &mut Vec<Value>, candidate: Value) {
    if let Some(message_id) = candidate.get("messageId").and_then(Value::as_str) {
        if let Some(index) = history.iter().position(|message| {
            message
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|existing_id| existing_id == message_id)
        }) {
            if let Some(existing_message) = history.get_mut(index) {
                a2a_refresh_history_message(existing_message, &candidate);
            }
            return;
        }
    }
    if !history
        .iter()
        .any(|message| a2a_messages_have_same_role_text(message, &candidate))
    {
        history.push(candidate);
    }
}

fn a2a_messages_have_same_role_text(existing: &Value, candidate: &Value) -> bool {
    let candidate_role = candidate
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let candidate_text = a2a_message_value_text(candidate);
    existing
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role.eq_ignore_ascii_case(candidate_role))
        && a2a_message_value_text(existing) == candidate_text
}

fn a2a_refresh_history_message(existing: &mut Value, candidate: &Value) {
    if a2a_messages_have_same_role_text(existing, candidate) {
        return;
    }
    if let (Some(existing_object), Some(candidate_object)) =
        (existing.as_object_mut(), candidate.as_object())
    {
        for (key, value) in candidate_object {
            if key == "parts" {
                // Transcript-derived candidates only carry plain-text parts.
                // Merge so attachment or file parts already stored on the
                // embedded history message are preserved while the plain-text
                // part is refreshed from the candidate.
                let merged = a2a_merge_history_parts(existing_object.get("parts"), value);
                existing_object.insert("parts".to_string(), merged);
                continue;
            }
            existing_object.insert(key.clone(), value.clone());
        }
        return;
    }
    *existing = candidate.clone();
}

/// Merge existing history parts with a transcript-derived candidate. Non-text
/// parts (attachments, data payloads) are preserved from the existing message;
/// plain-text parts are refreshed from the candidate so a stale summary does
/// not outlive a top-level responseText or status update.
fn a2a_merge_history_parts(existing: Option<&Value>, candidate: &Value) -> Value {
    let Some(existing_parts) = existing.and_then(Value::as_array) else {
        return candidate.clone();
    };
    let candidate_parts = candidate.as_array();
    // Preserve existing parts that carry no text (attachments, data payloads).
    // Drop existing parts that have a `text` field — whether pure plain-text or
    // decorated with extra keys like `partId` — so stale summary text does not
    // survive alongside the refreshed transcript text.
    let mut merged: Vec<Value> = existing_parts
        .iter()
        .filter(|part| !a2a_history_part_has_text(part))
        .cloned()
        .collect();
    if let Some(candidate_parts) = candidate_parts {
        for part in candidate_parts {
            if a2a_history_part_is_plain_text(part) {
                merged.push(part.clone());
            }
        }
    }
    Value::Array(merged)
}

/// True when the part has a `text` field (plain or decorated). Used to decide
/// which existing parts to drop during a transcript-driven refresh.
fn a2a_history_part_has_text(part: &Value) -> bool {
    part.as_object()
        .is_some_and(|object| object.get("text").is_some_and(Value::is_string))
}

fn a2a_history_part_is_plain_text(part: &Value) -> bool {
    let Some(object) = part.as_object() else {
        return false;
    };
    if !object.get("text").is_some_and(Value::is_string) {
        return false;
    }
    match object.len() {
        1 => true,
        2 => object
            .get("mediaType")
            .and_then(Value::as_str)
            .is_some_and(|media_type| media_type.eq_ignore_ascii_case("text/plain")),
        _ => false,
    }
}

fn a2a_merge_ledger_work_graph_into_metadata(metadata: &mut Value, entry: &Value) {
    let Some(work_graph) = entry
        .get("workGraph")
        .filter(|work_graph| !work_graph.is_null())
        .filter(|work_graph| a2a_ledger_work_graph_has_evidence(work_graph))
        .cloned()
    else {
        return;
    };
    if !metadata.is_object() {
        *metadata = Value::Object(Map::new());
    }
    if let Some(metadata_object) = metadata.as_object_mut() {
        metadata_object.insert("workGraph".to_string(), work_graph);
    }
}

fn a2a_ledger_work_graph_has_evidence(work_graph: &Value) -> bool {
    let Some(object) = work_graph.as_object() else {
        return false;
    };
    let string_field = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let number_field = |key: &str| object.get(key).and_then(Value::as_u64).is_some();
    let array_field = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    };
    string_field("state")
        || number_field("itemCount")
        || number_field("activeItemCount")
        || number_field("blockedItemCount")
        || number_field("waitingItemCount")
        || number_field("childRunCount")
        || array_field("childRunIds")
        || number_field("toolCallCount")
        || number_field("pendingToolCallCount")
        || array_field("toolExecutionIds")
        || number_field("waitItemCount")
        || array_field("waitIds")
        || object
            .get("stateCounts")
            .and_then(Value::as_object)
            .is_some_and(|counts| !counts.is_empty())
        || string_field("correlationPath")
        || object
            .get("codexSubagents")
            .is_some_and(a2a_codex_subagent_work_graph_has_evidence)
}

fn a2a_codex_subagent_work_graph_has_evidence(work_graph: &Value) -> bool {
    let Some(object) = work_graph.as_object() else {
        return false;
    };
    ["toolCallIds", "childRunIds", "threadIds", "edges"]
        .iter()
        .any(|key| {
            object
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|values| !values.is_empty())
        })
        || object.get("edgeCount").and_then(Value::as_u64).is_some()
}

fn a2a_merge_ledger_status_into_task(
    task_object: &mut Map<String, Value>,
    entry: &Value,
    context_id: &str,
) {
    let Some(state) = entry.get("state").and_then(Value::as_str) else {
        return;
    };
    let response_text = entry
        .get("responseText")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|response_text| !response_text.is_empty())
        .map(str::to_string)
        .or_else(|| a2a_latest_agent_transcript_text(entry))
        .or_else(|| a2a_latest_agent_history_text(task_object));
    let status = task_object
        .entry("status".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !status.is_object() {
        *status = Value::Object(Map::new());
    }
    let Some(status_object) = status.as_object_mut() else {
        return;
    };
    status_object.insert(
        "state".to_string(),
        Value::String(canonical_a2a_task_state(state)),
    );
    if let Some(updated_at) = entry.get("updatedAt").and_then(Value::as_str) {
        status_object.insert(
            "timestamp".to_string(),
            Value::String(updated_at.to_string()),
        );
    }
    if let Some(response_text) = response_text {
        status_object.insert(
            "message".to_string(),
            a2a_agent_message(context_id, &response_text),
        );
    }
}

/// Latest agent message text from the embedded task history. Used as a
/// fallback so a reloaded ledger row does not keep a stale "still working"
/// status message after the top-level state has advanced to completion.
fn a2a_latest_agent_history_text(task_object: &Map<String, Value>) -> Option<String> {
    task_object
        .get("history")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .is_some_and(|role| {
                    role.eq_ignore_ascii_case("ROLE_AGENT") || role.eq_ignore_ascii_case("agent")
                })
        })
        .and_then(a2a_message_value_text)
}

fn a2a_latest_agent_transcript_text(entry: &Value) -> Option<String> {
    entry
        .get("transcript")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find(|item| {
            item.get("role")
                .and_then(Value::as_str)
                .is_some_and(|role| {
                    role.eq_ignore_ascii_case("agent") || role.eq_ignore_ascii_case("ROLE_AGENT")
                })
        })
        .and_then(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn a2a_message_from_ledger_transcript(context_id: &str, item: &Value) -> Option<Value> {
    let text = item.get("text").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let role = match item.get("role").and_then(Value::as_str) {
        Some(role)
            if role.eq_ignore_ascii_case("ROLE_AGENT") || role.eq_ignore_ascii_case("agent") =>
        {
            "ROLE_AGENT"
        }
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
    let work_graph = task
        .get("metadata")
        .and_then(|metadata| metadata.get("workGraph"))
        .cloned();
    let ledger_task = a2a_task_for_ledger(task);
    let mut entry = serde_json::json!({
        "id": existing
            .and_then(|entry| entry.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("maestro-control-plane-{task_id}")),
        "kind": "delegation",
        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
        "peerDisplayName": A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME,
        "taskId": task_id,
        "text": text,
        "state": state,
        "transcript": transcript,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "metadata": metadata,
        "a2aTask": ledger_task
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
    if let Some(work_graph) = work_graph {
        entry["workGraph"] = work_graph;
    }
    if a2a_task_is_terminal(task) {
        entry["completedAt"] = entry["updatedAt"].clone();
    }
    entry
}

fn a2a_task_for_ledger(task: &Value) -> Value {
    let task_is_terminal = a2a_task_is_terminal(task);
    let mut task = task.clone();
    if let Some(task_object) = task.as_object_mut() {
        if let Some(metadata) = task_object.get("metadata") {
            let mut ledger_metadata = a2a_embedded_task_metadata_for_ledger(metadata);
            if !task_is_terminal {
                // In-flight tasks need callback delivery config after restart; terminal rows do not.
                if let Some(push_configs) = metadata.get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
                {
                    ledger_metadata[A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY] =
                        push_configs.clone();
                }
            }
            task_object.insert("metadata".to_string(), ledger_metadata);
        }
    }
    task
}

fn a2a_embedded_task_metadata_for_ledger(metadata: &Value) -> Value {
    let mut metadata = metadata
        .as_object()
        .map(|_| metadata.clone())
        .unwrap_or_else(|| Value::Object(Map::new()));
    a2a_remove_secret_ledger_metadata(&mut metadata);
    metadata
}

fn a2a_remove_secret_ledger_metadata(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| !a2a_ledger_metadata_key_is_secret(key));
            for value in object.values_mut() {
                a2a_remove_secret_ledger_metadata(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                a2a_remove_secret_ledger_metadata(value);
            }
        }
        _ => {}
    }
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
                    Value::String(_) | Value::Number(_) | Value::Bool(_)
                        if !a2a_ledger_metadata_key_is_secret(key) =>
                    {
                        Some((key.clone(), value.clone()))
                    }
                    _ => None,
                })
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    Value::Object(object)
}

fn a2a_ledger_metadata_key_is_secret(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| *ch != '-' && *ch != '_')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if a2a_ledger_metadata_key_is_token_metric(&normalized) {
        return false;
    }
    // Explicit sensitive aliases redact regardless of position in the key.
    matches!(
        normalized.as_str(),
        "authorization"
            | "token"
            | "apitoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "secret"
            | "clientsecret"
            | "sharedsecret"
            | "password"
            | "apikey"
            | "credentials"
            | "bearer"
    ) || a2a_ledger_metadata_key_has_secret_suffix(&normalized)
        || key == A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY
}

/// Catch compound credential field names such as `webhookSecret`,
/// `oauthToken`, or `apiPassword` that the exact-match list above would miss.
/// Explicitly exclude negated names (`nonSecret`, `nonCredentials`,
/// `notASecret`) so benign audit metadata is not stripped, and keep the
/// token-metric carve-out above authoritative for token-count fields.
fn a2a_ledger_metadata_key_has_secret_suffix(normalized: &str) -> bool {
    const SECRET_SUFFIXES: [&str; 5] = ["secret", "token", "password", "apikey", "credentials"];
    const NEGATION_PREFIXES: [&str; 3] = ["non", "not", "no"];
    let Some(stem) = SECRET_SUFFIXES
        .iter()
        .find_map(|suffix| normalized.strip_suffix(suffix))
    else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    !NEGATION_PREFIXES
        .iter()
        .any(|prefix| stem.starts_with(prefix))
}

fn a2a_ledger_metadata_key_is_token_metric(normalized: &str) -> bool {
    matches!(
        normalized,
        "totaltoken"
            | "totaltokens"
            | "inputtoken"
            | "inputtokens"
            | "outputtoken"
            | "outputtokens"
            | "cachetoken"
            | "cachetokens"
            | "cachereadtoken"
            | "cachereadtokens"
            | "cachewritetoken"
            | "cachewritetokens"
            | "prompttoken"
            | "prompttokens"
            | "completiontoken"
            | "completiontokens"
            | "maxtoken"
            | "maxtokens"
            | "tokencount"
            | "tokenscount"
    )
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

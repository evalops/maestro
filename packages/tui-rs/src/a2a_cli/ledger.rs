//! Local A2A task ledger (`~/.maestro/a2a/tasks.json`), TS-compatible.

use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::{extract_task_text, is_final_state, A2ATask};
use crate::path_utils::{env_path, maestro_home_dir, resolve_env_path};
use crate::skill_cli::write_atomic;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLedgerFile {
    #[serde(default)]
    pub tasks: Vec<TaskLedgerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLedgerEntry {
    pub id: String,
    pub kind: String,
    pub peer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_display_name: Option<String>,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_graph: Option<Value>,
    #[serde(default)]
    pub transcript: Vec<TranscriptEntry>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    pub at: String,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

pub fn get_task_ledger_path(path: Option<&str>) -> Result<PathBuf> {
    if let Some(configured) = path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| env_path("MAESTRO_A2A_TASKS_FILE"))
        .or_else(|| env_path("CODEX_A2A_TASKS_FILE"))
    {
        return Ok(resolve_env_path(&configured.to_string_lossy()).unwrap_or(configured));
    }
    Ok(maestro_home_dir()
        .context("Maestro home is unavailable")?
        .join("a2a")
        .join("tasks.json"))
}

pub fn load_task_ledger(path: Option<&str>) -> Result<TaskLedgerFile> {
    let path = get_task_ledger_path(path)?;
    if !path.exists() {
        return Ok(TaskLedgerFile::default());
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("read A2A task ledger {}", path.display()))?;
    let parsed: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse A2A task ledger {}", path.display()))?;
    let obj = parsed.as_object().with_context(|| {
        format!(
            "A2A task ledger at {} must be a JSON object",
            path.display()
        )
    })?;
    let tasks = obj
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::with_capacity(tasks.len());
    for (index, task) in tasks.iter().enumerate() {
        entries.push(normalize_ledger_entry(task, &format!("tasks[{index}]"))?);
    }
    Ok(TaskLedgerFile { tasks: entries })
}

pub fn save_task_ledger(ledger: &TaskLedgerFile, path: Option<&str>) -> Result<PathBuf> {
    let path = get_task_ledger_path(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create ledger directory {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let content = format!("{}\n", serde_json::to_string_pretty(ledger)?);
    write_atomic(&path, &content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

pub fn list_task_entries<'a>(
    ledger: &'a TaskLedgerFile,
    peer: Option<&str>,
) -> Vec<&'a TaskLedgerEntry> {
    let peer = peer.map(str::trim).filter(|s| !s.is_empty());
    let mut entries: Vec<_> = ledger
        .tasks
        .iter()
        .filter(|entry| match peer {
            None => true,
            Some(p) => entry.peer == p,
        })
        .collect();
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    entries
}

pub struct RecordTaskStartInput<'a> {
    pub path: Option<&'a str>,
    pub peer: &'a str,
    pub peer_display_name: Option<&'a str>,
    pub task: &'a A2ATask,
    pub text: &'a str,
    pub message_id: Option<&'a str>,
    pub context_id: Option<&'a str>,
    pub kind: &'a str,
    pub metadata: Option<Value>,
}

pub fn record_task_start(input: RecordTaskStartInput<'_>) -> Result<()> {
    let mut ledger = load_task_ledger(input.path)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let task_id = input.task.id.trim();
    if task_id.is_empty() {
        bail!("A2A task id is required");
    }
    let response_text = extract_task_text(input.task);
    let entry = TaskLedgerEntry {
        id: format!("maestro-a2a-task-{}", uuid::Uuid::new_v4()),
        kind: input.kind.to_string(),
        peer: input.peer.to_string(),
        peer_display_name: input.peer_display_name.map(str::to_string),
        task_id: task_id.to_string(),
        context_id: input
            .context_id
            .map(str::to_string)
            .or_else(|| input.task.context_id.clone()),
        message_id: input.message_id.map(str::to_string),
        text: input.text.to_string(),
        role: None,
        cwd: None,
        state: input.task.status.state.clone(),
        response_text: response_text.clone(),
        metadata: input.metadata,
        work_graph: extract_work_graph(input.task),
        transcript: {
            let mut transcript = vec![TranscriptEntry {
                at: now.clone(),
                role: "user".into(),
                text: input.text.to_string(),
                state: None,
                message_id: input.message_id.map(str::to_string),
            }];
            if let Some(response) = response_text {
                transcript.push(TranscriptEntry {
                    at: now.clone(),
                    role: "agent".into(),
                    text: response,
                    state: Some(input.task.status.state.clone()),
                    message_id: None,
                });
            }
            transcript
        },
        created_at: now.clone(),
        updated_at: now.clone(),
        completed_at: if is_final_state(&input.task.status.state) {
            Some(now)
        } else {
            None
        },
    };
    if let Some(index) = ledger
        .tasks
        .iter()
        .position(|e| e.peer == input.peer && e.task_id == task_id)
    {
        let previous = &ledger.tasks[index];
        let mut merged = entry;
        merged.id = previous.id.clone();
        merged.created_at = previous.created_at.clone();
        ledger.tasks[index] = merged;
    } else {
        ledger.tasks.push(entry);
    }
    save_task_ledger(&ledger, input.path)?;
    Ok(())
}

pub fn update_task_in_ledger(path: Option<&str>, peer: &str, task: &A2ATask) -> Result<()> {
    let mut ledger = load_task_ledger(path)?;
    let task_id = task.id.trim();
    if task_id.is_empty() {
        bail!("A2A task id is required");
    }
    let Some(index) = ledger
        .tasks
        .iter()
        .position(|e| e.peer == peer && e.task_id == task_id)
    else {
        return record_task_start(RecordTaskStartInput {
            path,
            peer,
            peer_display_name: None,
            task,
            text: extract_task_text(task).as_deref().unwrap_or(""),
            message_id: None,
            context_id: task.context_id.as_deref(),
            kind: "message",
            metadata: None,
        });
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let previous = &ledger.tasks[index];
    let response_text = extract_task_text(task).or_else(|| previous.response_text.clone());
    let mut entry = previous.clone();
    entry.state = task.status.state.clone();
    if let Some(context_id) = task
        .context_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        entry.context_id = Some(context_id.to_string());
    }
    entry.response_text = response_text.clone();
    if let Some(graph) = extract_work_graph(task) {
        entry.work_graph = Some(graph);
    }
    entry.updated_at = now.clone();
    if is_final_state(&task.status.state) {
        entry.completed_at = entry.completed_at.clone().or(Some(now.clone()));
    } else {
        entry.completed_at = None;
    }
    if let Some(response) = response_text {
        let should_append = !entry
            .transcript
            .iter()
            .rev()
            .any(|item| item.role == "agent" && item.text == response);
        if should_append {
            entry.transcript.push(TranscriptEntry {
                at: now,
                role: "agent".into(),
                text: response,
                state: Some(task.status.state.clone()),
                message_id: None,
            });
        }
    }
    ledger.tasks[index] = entry;
    save_task_ledger(&ledger, path)?;
    Ok(())
}

fn extract_work_graph(task: &A2ATask) -> Option<Value> {
    task.metadata
        .as_ref()
        .and_then(|meta| meta.get("workGraph").cloned())
        .or_else(|| {
            task.metadata
                .as_ref()
                .and_then(|meta| meta.get("evalops").cloned())
                .and_then(|evalops| evalops.get("workGraph").cloned())
        })
}

fn normalize_ledger_entry(input: &Value, label: &str) -> Result<TaskLedgerEntry> {
    let obj = input
        .as_object()
        .with_context(|| format!("{label} must be an object"))?;
    let task_id = obj
        .get("taskId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .with_context(|| format!("{label}.taskId is required"))?
        .to_string();
    let peer = obj
        .get("peer")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .with_context(|| format!("{label}.peer is required"))?
        .to_string();
    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("maestro-a2a-task-{task_id}"));
    let state = obj
        .get("state")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let text = obj
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let created_at = obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = obj
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or(&created_at)
        .to_string();
    let transcript = obj
        .get("transcript")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let entry = item.as_object()?;
                    Some(TranscriptEntry {
                        at: entry
                            .get("at")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        role: entry
                            .get("role")
                            .and_then(|v| v.as_str())
                            .unwrap_or("user")
                            .to_string(),
                        text: entry
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        state: entry
                            .get("state")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        message_id: entry
                            .get("messageId")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TaskLedgerEntry {
        id,
        kind: obj
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("message")
            .to_string(),
        peer,
        peer_display_name: string_field(obj, "peerDisplayName"),
        task_id,
        context_id: string_field(obj, "contextId"),
        message_id: string_field(obj, "messageId"),
        text,
        role: string_field(obj, "role"),
        cwd: string_field(obj, "cwd"),
        state,
        response_text: string_field(obj, "responseText"),
        metadata: obj.get("metadata").cloned(),
        work_graph: obj.get("workGraph").cloned(),
        transcript,
        created_at,
        updated_at,
        completed_at: string_field(obj, "completedAt"),
    })
}

fn string_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

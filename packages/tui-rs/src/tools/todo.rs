//! Todo tool for tracking multi-step tasks.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::agent::ToolResult;
use crate::safety::set_plan_satisfied;

#[derive(Debug, Deserialize)]
struct TodoArgs {
    goal: String,
    #[serde(default)]
    items: Option<serde_json::Value>,
    #[serde(default)]
    updates: Option<Vec<TodoUpdateInput>>,
    #[serde(default, alias = "includeSummary")]
    include_summary: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TodoItemInput {
    #[serde(default)]
    id: Option<String>,
    content: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    due: Option<String>,
    #[serde(default, alias = "blockedBy")]
    blocked_by: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct TodoUpdateInput {
    id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    due: Option<String>,
    #[serde(default, alias = "blockedBy")]
    blocked_by: Option<Vec<String>>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    remove: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct NormalizedTodo {
    id: String,
    content: String,
    status: String,
    priority: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    due: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "blockedBy")]
    blocked_by: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TodoRecord {
    goal: String,
    items: Vec<NormalizedTodo>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

type TodoStore = HashMap<String, TodoRecord>;

fn store_path() -> PathBuf {
    if let Ok(path) = std::env::var("COMPOSER_TODO_FILE") {
        return PathBuf::from(path);
    }
    dirs::home_dir().map_or_else(
        || std::env::temp_dir().join("composer-todos.json"),
        |home| home.join(".composer").join("todos.json"),
    )
}

async fn load_store() -> Result<TodoStore, String> {
    let path = store_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read todo store: {e}"))?;
    let store: TodoStore = serde_json::from_str(&content).unwrap_or_else(|_| HashMap::new());
    Ok(store)
}

async fn save_store(store: &TodoStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create todo dir: {e}"))?;
    }
    let data = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize todo store: {e}"))?;
    tokio::fs::write(&path, format!("{data}\n"))
        .await
        .map_err(|e| format!("Failed to write todo store: {e}"))?;
    Ok(())
}

fn normalize_items(items: Vec<TodoItemInput>) -> Vec<NormalizedTodo> {
    items
        .into_iter()
        .map(|item| NormalizedTodo {
            id: item.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            content: item.content,
            status: item.status.unwrap_or_else(|| "pending".to_string()),
            priority: item.priority.unwrap_or_else(|| "medium".to_string()),
            notes: item.notes,
            due: item.due,
            blocked_by: item.blocked_by,
        })
        .collect()
}

fn apply_updates(
    items: &mut Vec<NormalizedTodo>,
    updates: Vec<TodoUpdateInput>,
) -> Result<(), String> {
    for update in updates {
        let idx = items
            .iter()
            .position(|item| item.id == update.id)
            .ok_or_else(|| format!("No task found with id \"{}\" for this goal", update.id))?;
        if update.remove.unwrap_or(false) {
            items.remove(idx);
            continue;
        }
        let item = &mut items[idx];
        if let Some(status) = update.status {
            item.status = status;
        }
        if let Some(priority) = update.priority {
            item.priority = priority;
        }
        if let Some(notes) = update.notes {
            item.notes = Some(notes);
        }
        if let Some(due) = update.due {
            item.due = Some(due);
        }
        if let Some(blocked) = update.blocked_by {
            item.blocked_by = Some(blocked);
        }
        if let Some(content) = update.content {
            item.content = content;
        }
    }
    Ok(())
}

fn status_symbol(status: &str) -> &str {
    match status {
        "completed" => "[x]",
        "in_progress" => "[~]",
        _ => "[ ]",
    }
}

fn format_output(goal: &str, items: &[NormalizedTodo], include_summary: bool) -> String {
    let mut lines = vec![
        "Goal".to_string(),
        "------------------------".to_string(),
        goal.to_string(),
        String::new(),
    ];

    if include_summary {
        let total = items.len();
        let pending = items.iter().filter(|i| i.status == "pending").count();
        let in_progress = items.iter().filter(|i| i.status == "in_progress").count();
        let completed = items.iter().filter(|i| i.status == "completed").count();
        lines.push("Progress".to_string());
        lines.push("------------------------".to_string());
        if total == 0 {
            lines.push("No tasks yet - add items to get started.".to_string());
        } else {
            lines.push(format!(
                "Total: {total} | Pending: {pending} | In Progress: {in_progress} | Completed: {completed}"
            ));
        }
        lines.push(String::new());
    }

    if items.is_empty() {
        lines.push("Tasks".to_string());
        lines.push("────────────────────────".to_string());
        lines.push("No tasks available.".to_string());
        return lines.join("\n");
    }

    lines.push("Tasks".to_string());
    lines.push("------------------------".to_string());
    for item in items {
        lines.push(format!(
            "{} {} (priority: {})",
            status_symbol(&item.status),
            item.content,
            item.priority
        ));
        if let Some(notes) = &item.notes {
            lines.push(format!("    notes: {notes}"));
        }
        if let Some(due) = &item.due {
            lines.push(format!("    due: {due}"));
        }
        if let Some(blocked) = &item.blocked_by {
            lines.push(format!("    blocked by: {}", blocked.join(", ")));
        }
    }
    lines.join("\n")
}

pub async fn todo(args: serde_json::Value) -> ToolResult {
    let parsed: TodoArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid todo arguments: {err}")),
    };

    let mut store = match load_store().await {
        Ok(store) => store,
        Err(err) => return ToolResult::failure(err),
    };

    let include_summary = parsed.include_summary.unwrap_or(true);
    let goal = parsed.goal.clone();
    let mut record = store.remove(&goal).unwrap_or(TodoRecord {
        goal: goal.clone(),
        items: Vec::new(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    });

    if let Some(items_value) = parsed.items {
        let items_vec: Vec<TodoItemInput> = if items_value.is_string() {
            match serde_json::from_str(items_value.as_str().unwrap_or("[]")) {
                Ok(items) => items,
                Err(err) => return ToolResult::failure(format!("Invalid items JSON: {err}")),
            }
        } else {
            match serde_json::from_value(items_value) {
                Ok(items) => items,
                Err(err) => return ToolResult::failure(format!("Invalid items: {err}")),
            }
        };
        record.items = normalize_items(items_vec);
    }

    if let Some(updates) = parsed.updates {
        if let Err(err) = apply_updates(&mut record.items, updates) {
            return ToolResult::failure(err);
        }
    }

    record.updated_at = chrono::Utc::now().to_rfc3339();
    store.insert(goal.clone(), record);

    if let Err(err) = save_store(&store).await {
        return ToolResult::failure(err);
    }

    set_plan_satisfied(true);

    let record = store.get(&goal).cloned().unwrap_or(TodoRecord {
        goal: goal.clone(),
        items: Vec::new(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    });

    let output = format_output(&goal, &record.items, include_summary);
    let details = serde_json::json!({
        "goal": goal,
        "items": record.items,
        "updatedAt": record.updated_at
    });

    ToolResult::success(output).with_details(details)
}

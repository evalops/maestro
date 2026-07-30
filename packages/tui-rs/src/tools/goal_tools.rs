//! Agent-facing goal tools (Codex-aligned).
//!
//! The **same** worker model marks the goal complete or blocked via
//! `update_goal`. There is no second model after each turn. Completion is a
//! structured tool call; the TUI reloads `GoalStore` and continues only while
//! status stays active.

use serde::Deserialize;
use serde_json::json;

use crate::agent::ToolResult;
use crate::goal::{GoalStatus, GoalStore};

#[derive(Debug, Deserialize)]
struct UpdateGoalArgs {
    status: String,
    #[serde(default)]
    reason: Option<String>,
}

/// `get_goal` — read the current persisted goal.
pub fn get_goal() -> ToolResult {
    let store = GoalStore::load_default();
    match &store.current {
        None => ToolResult::success(
            json!({
                "goal": null,
                "message": "No active goal. The user can create one with /goal create <text>."
            })
            .to_string(),
        ),
        Some(g) => ToolResult::success(
            json!({
                "goal": {
                    "id": g.id,
                    "text": g.text,
                    "status": g.status.as_str(),
                    "successCriteria": g.success_criteria,
                    "blockReason": g.block_reason,
                    "autoContinue": g.auto_continue,
                    "autoContinueCount": g.auto_continue_count,
                    "maxTurns": g.max_turns,
                }
            })
            .to_string(),
        ),
    }
}

/// `update_goal` — mark complete or blocked only (Codex `update_goal` semantics).
pub fn update_goal(args: serde_json::Value) -> ToolResult {
    let parsed: UpdateGoalArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => {
            return ToolResult::failure(format!(
                "invalid update_goal args: {e}. Use status complete|blocked and optional reason."
            ));
        }
    };
    let status = parsed.status.trim().to_ascii_lowercase();
    if !matches!(
        status.as_str(),
        "complete" | "done" | "finished" | "blocked" | "block"
    ) {
        return ToolResult::failure(format!(
            "update_goal status must be `complete` or `blocked`, got '{status}'. \
             Pause/resume are user-controlled via /goal."
        ));
    }

    let mut store = GoalStore::load_default();
    if store.current.is_none() {
        return ToolResult::failure(
            "cannot update goal because there is no current goal; the user must /goal create first"
                .to_string(),
        );
    }

    match status.as_str() {
        "complete" | "done" | "finished" => match store.complete() {
            Ok(done) => ToolResult::success(
                json!({
                    "goal": {
                        "id": done.id,
                        "text": done.text,
                        "status": GoalStatus::Complete.as_str(),
                    },
                    "message": "Goal marked complete. Auto-continue will stop."
                })
                .to_string(),
            ),
            Err(e) => ToolResult::failure(format!("failed to complete goal: {e}")),
        },
        "blocked" | "block" => {
            let reason = parsed
                .reason
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty());
            match store.block(reason) {
                Ok(goal) => ToolResult::success(
                    json!({
                        "goal": {
                            "id": goal.id,
                            "text": goal.text,
                            "status": goal.status.as_str(),
                            "blockReason": goal.block_reason,
                        },
                        "message": "Goal marked blocked. Auto-continue will stop."
                    })
                    .to_string(),
                ),
                Err(e) => ToolResult::failure(format!("failed to block goal: {e}")),
            }
        }
        _ => unreachable!("status validated above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_terminal_status() {
        let bad = update_goal(json!({"status": "paused"}));
        assert!(!bad.success);
        let msg = bad.error.as_deref().unwrap_or(&bad.output);
        assert!(
            msg.contains("complete") || msg.contains("blocked"),
            "unexpected: {msg}"
        );
    }

    #[test]
    fn get_goal_succeeds() {
        let get = get_goal();
        assert!(get.success);
    }
}

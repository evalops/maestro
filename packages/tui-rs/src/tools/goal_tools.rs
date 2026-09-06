//! Agent-facing goal tools (Codex-aligned).
//!
//! The **same** worker model marks the goal complete or blocked via
//! `update_goal`. There is no second model after each turn. Completion is a
//! structured tool call; the TUI reloads `GoalStore` and continues only while
//! status stays active.

use serde::Deserialize;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

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
    let now = now_unix();
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
                    "tokenBudget": g.token_budget,
                    "tokensUsed": g.tokens_used,
                    "remainingTokens": g.token_budget.map(|b| b.saturating_sub(g.tokens_used)),
                    "maxDurationSecs": g.max_duration_secs,
                    "startedAtUnix": g.started_at_unix,
                    "elapsedSecs": g.started_at_unix.map(|started| now.saturating_sub(started)),
                    "remainingDurationSecs": g.max_duration_secs.map(|budget| {
                        budget.saturating_sub(
                            g.started_at_unix.map(|started| now.saturating_sub(started)).unwrap_or(0),
                        )
                    }),
                }
            })
            .to_string(),
        ),
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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

    #[test]
    fn update_goal_complete_persists_under_maestro_home() {
        let _env_guard = crate::config::test_process_env_lock();
        let dir = tempfile::tempdir().expect("tempdir");
        let previous = std::env::var("MAESTRO_HOME").ok();
        std::env::set_var("MAESTRO_HOME", dir.path());
        let mut seed = GoalStore::load_default();
        seed.create("finish it", None, true, Some(4), Some(9_000))
            .expect("seed goal");
        let id = seed.current.as_ref().unwrap().id.clone();

        let result = update_goal(json!({"status": "complete"}));
        assert!(result.success, "update_goal failed: {:?}", result.error);
        assert!(result.output.contains("complete"), "{}", result.output);

        let loaded = GoalStore::load_default();
        let goal = loaded.current.expect("goal should remain on disk");
        assert_eq!(goal.id, id);
        assert_eq!(goal.status, GoalStatus::Complete);
        assert!(!goal.auto_continue);

        match previous {
            Some(v) => std::env::set_var("MAESTRO_HOME", v),
            None => std::env::remove_var("MAESTRO_HOME"),
        }
    }
}

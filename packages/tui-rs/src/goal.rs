//! Interactive goal mode (Kimi-inspired).
//!
//! One structured objective per session, with states that drive optional
//! auto-continue while the agent is idle. Models complete goals via explicit
//! user slash commands (or future tool hooks); free-text "done" does not clear
//! the goal.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Lifecycle state for a user goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    /// Driver may auto-continue while the agent is idle.
    #[default]
    Active,
    /// User paused; no auto-continue.
    Paused,
    /// Needs external input or is impossible under current constraints.
    Blocked,
    /// Terminal success; cleared after status display.
    Complete,
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::Complete => "complete",
        }
    }

    pub fn badge(self) -> &'static str {
        match self {
            Self::Active => "goal:active",
            Self::Paused => "goal:paused",
            Self::Blocked => "goal:blocked",
            Self::Complete => "goal:done",
        }
    }
}

/// A single session goal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub success_criteria: Option<String>,
    pub status: GoalStatus,
    #[serde(default)]
    pub block_reason: Option<String>,
    pub created_at_unix: u64,
    pub updated_at_unix: u64,
    /// When true (default for active goals), the TUI re-submits a continuation
    /// prompt when the agent becomes idle.
    #[serde(default = "default_true")]
    pub auto_continue: bool,
}

fn default_true() -> bool {
    true
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    let full = uuid::Uuid::new_v4().to_string();
    format!("g-{}", &full[..8])
}

/// In-memory goal holder with optional disk persistence under `~/.maestro/goals.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStore {
    #[serde(default)]
    pub current: Option<Goal>,
    /// When `None`, mutations stay in-memory only (unit tests / ephemeral stores).
    #[serde(skip)]
    persist_path: Option<PathBuf>,
}

impl GoalStore {
    pub fn load_default() -> Self {
        let path = default_path();
        let mut store = load_from_path(&path).unwrap_or_default();
        store.persist_path = Some(path);
        store
    }

    pub fn save_default(&self) -> Result<()> {
        let Some(path) = &self.persist_path else {
            return Ok(());
        };
        save_to_path(self, path)
    }

    pub fn status_line(&self) -> Option<String> {
        self.current.as_ref().map(|g| {
            let preview: String = g.text.chars().take(40).collect();
            let ellipsis = if g.text.chars().count() > 40 {
                "…"
            } else {
                ""
            };
            format!("{} {preview}{ellipsis}", g.status.badge())
        })
    }

    pub fn create(
        &mut self,
        text: impl Into<String>,
        success_criteria: Option<String>,
        replace: bool,
    ) -> Result<&Goal> {
        let text = text.into().trim().to_string();
        if text.is_empty() {
            bail!("goal text must not be empty");
        }
        if text.chars().count() > 2_000 {
            bail!("goal text is too long (max 2000 characters)");
        }
        if let Some(existing) = &self.current {
            if !replace
                && matches!(
                    existing.status,
                    GoalStatus::Active | GoalStatus::Paused | GoalStatus::Blocked
                )
            {
                bail!(
                    "a goal is already {} ({}); use /goal replace <text> or /goal complete first",
                    existing.status.as_str(),
                    existing.id
                );
            }
        }
        let now = now_unix();
        self.current = Some(Goal {
            id: new_id(),
            text,
            success_criteria,
            status: GoalStatus::Active,
            block_reason: None,
            created_at_unix: now,
            updated_at_unix: now,
            auto_continue: true,
        });
        self.save_default()?;
        Ok(self.current.as_ref().expect("just set"))
    }

    pub fn pause(&mut self) -> Result<&Goal> {
        self.transition(GoalStatus::Paused, None)
    }

    pub fn resume(&mut self) -> Result<&Goal> {
        let goal = self.current.as_mut().context("no current goal")?;
        if matches!(goal.status, GoalStatus::Complete) {
            bail!("cannot resume a completed goal; create a new one");
        }
        goal.status = GoalStatus::Active;
        goal.block_reason = None;
        goal.auto_continue = true;
        goal.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(self.current.as_ref().expect("just set"))
    }

    pub fn block(&mut self, reason: Option<String>) -> Result<&Goal> {
        self.transition(GoalStatus::Blocked, reason)
    }

    pub fn complete(&mut self) -> Result<Goal> {
        let goal = self.current.take().context("no current goal")?;
        let mut done = goal;
        done.status = GoalStatus::Complete;
        done.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(done)
    }

    pub fn clear(&mut self) -> Result<Option<Goal>> {
        let prev = self.current.take();
        self.save_default()?;
        Ok(prev)
    }

    pub fn set_auto_continue(&mut self, enabled: bool) -> Result<&Goal> {
        let goal = self.current.as_mut().context("no current goal")?;
        goal.auto_continue = enabled;
        goal.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(self.current.as_ref().expect("just set"))
    }

    /// Whether the TUI should submit a continuation prompt now.
    pub fn should_auto_continue(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|g| g.status == GoalStatus::Active && g.auto_continue)
    }

    /// Prompt text injected when auto-continuing an active goal.
    pub fn continuation_prompt(&self) -> Option<String> {
        let g = self.current.as_ref()?;
        if g.status != GoalStatus::Active || !g.auto_continue {
            return None;
        }
        let mut prompt = format!(
            "Continue working toward the active goal (id {}).\n\nGoal: {}\n",
            g.id, g.text
        );
        if let Some(criteria) = &g.success_criteria {
            prompt.push_str(&format!("Success criteria: {criteria}\n"));
        }
        prompt.push_str(
            "\nRules:\n\
             - Make progress on one coherent slice, then stop for the next turn if more remains.\n\
             - If the goal is fully satisfied and verified, tell the user to run `/goal complete`.\n\
             - If blocked on external input or an impossible constraint, tell the user to run `/goal block <reason>`.\n\
             - Do not start unrelated work. Do not claim completion without verification.\n",
        );
        Some(prompt)
    }

    pub fn report(&self) -> String {
        match &self.current {
            None => "No active goal. Create one with `/goal create <text>`.".to_string(),
            Some(g) => {
                let mut out = format!(
                    "## Goal {}\n\n**Status:** {}\n**Auto-continue:** {}\n\n{}\n",
                    g.id,
                    g.status.as_str(),
                    if g.auto_continue { "on" } else { "off" },
                    g.text
                );
                if let Some(c) = &g.success_criteria {
                    out.push_str(&format!("\n**Success criteria:** {c}\n"));
                }
                if let Some(r) = &g.block_reason {
                    out.push_str(&format!("\n**Block reason:** {r}\n"));
                }
                out.push_str(
                    "\nCommands: `/goal pause` · `/goal resume` · `/goal block [reason]` · `/goal complete` · `/goal clear`\n",
                );
                out
            }
        }
    }

    fn transition(&mut self, status: GoalStatus, block_reason: Option<String>) -> Result<&Goal> {
        let goal = self.current.as_mut().context("no current goal")?;
        goal.status = status;
        goal.block_reason = block_reason;
        if status != GoalStatus::Active {
            goal.auto_continue = false;
        }
        goal.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(self.current.as_ref().expect("just set"))
    }
}

fn default_path() -> PathBuf {
    crate::path_utils::maestro_home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("goals.json")
}

fn load_from_path(path: &Path) -> Result<GoalStore> {
    if !path.exists() {
        return Ok(GoalStore::default());
    }
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let store: GoalStore = serde_json::from_str(&raw).context("parse goals.json")?;
    Ok(store)
}

fn save_to_path(store: &GoalStore, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let raw = serde_json::to_string_pretty(store).context("serialize goals")?;
    crate::fs_atomic::write_atomic(path, raw.as_bytes()).context("write goals.json")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_pause_resume_complete() {
        let mut store = GoalStore::default();
        store
            .create("Ship the release", Some("tag exists".into()), false)
            .unwrap();
        assert!(store.should_auto_continue());
        store.pause().unwrap();
        assert!(!store.should_auto_continue());
        store.resume().unwrap();
        assert!(store.should_auto_continue());
        let done = store.complete().unwrap();
        assert_eq!(done.status, GoalStatus::Complete);
        assert!(store.current.is_none());
    }

    #[test]
    fn refuses_second_goal_without_replace() {
        let mut store = GoalStore::default();
        store.create("first", None, false).unwrap();
        let err = store.create("second", None, false).unwrap_err();
        assert!(err.to_string().contains("already"));
        store.create("second", None, true).unwrap();
        assert_eq!(store.current.as_ref().unwrap().text, "second");
    }

    #[test]
    fn continuation_prompt_only_when_active() {
        let mut store = GoalStore::default();
        store.create("do the thing", None, false).unwrap();
        assert!(store
            .continuation_prompt()
            .unwrap()
            .contains("do the thing"));
        store.pause().unwrap();
        assert!(store.continuation_prompt().is_none());
    }
}

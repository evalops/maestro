//! Interactive goal mode (Kimi-inspired).
//!
//! One structured objective per session, with states that drive optional
//! auto-continue while the agent is idle.
//!
//! **Completion is measured by a second model** ([`crate::goal_judge`]), not by
//! a fixed turn budget. After each worker turn, a different model judges
//! whether the goal is complete, blocked, or still needs work. Auto-continue
//! stops when that judge says `complete` or `blocked`.
//!
//! `max_turns` remains only as a safety circuit-breaker (default 50) so a
//! stuck "continue" loop cannot run forever if the judge misbehaves.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Safety circuit-breaker: max auto-continue submissions if the judge keeps
/// saying "continue". Not the primary completion measure.
pub const DEFAULT_MAX_AUTO_CONTINUES: u32 = 50;

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
    /// Safety cap on auto-continue submissions (circuit-breaker only).
    /// Primary stop condition is the second-model judge.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// How many auto-continue prompts have already been submitted.
    #[serde(default)]
    pub auto_continue_count: u32,
    /// Last judge decision summary for status display.
    #[serde(default)]
    pub last_judge_reason: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_max_turns() -> u32 {
    DEFAULT_MAX_AUTO_CONTINUES
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
            let turns = if g.auto_continue {
                format!(" n={}", g.auto_continue_count)
            } else {
                String::new()
            };
            format!("{}{turns} {preview}{ellipsis}", g.status.badge())
        })
    }

    pub fn create(
        &mut self,
        text: impl Into<String>,
        success_criteria: Option<String>,
        replace: bool,
        max_turns: Option<u32>,
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
        let max_turns = max_turns.unwrap_or(DEFAULT_MAX_AUTO_CONTINUES).max(1);
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
            max_turns,
            auto_continue_count: 0,
            last_judge_reason: None,
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
        // Resume resets the auto-continue budget so operators can continue work.
        goal.auto_continue_count = 0;
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
        if enabled {
            // Re-enable with a fresh budget so `/goal auto on` is usable after
            // a max-turns stop.
            goal.auto_continue_count = 0;
        }
        goal.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(self.current.as_ref().expect("just set"))
    }

    /// Record that an auto-continue prompt was submitted. Disables further
    /// auto-continue when the safety `max_turns` circuit-breaker is reached.
    /// Returns `true` if the cap was just hit.
    pub fn note_auto_continue_submitted(&mut self) -> Result<bool> {
        let goal = self.current.as_mut().context("no current goal")?;
        goal.auto_continue_count = goal.auto_continue_count.saturating_add(1);
        goal.updated_at_unix = now_unix();
        let hit_cap = goal.auto_continue_count >= goal.max_turns;
        if hit_cap {
            goal.auto_continue = false;
            goal.last_judge_reason = Some(format!(
                "safety circuit-breaker: auto-continue hit max_turns={}",
                goal.max_turns
            ));
        }
        self.save_default()?;
        Ok(hit_cap)
    }

    /// Record the latest second-model judge reason (status / report).
    pub fn set_last_judge_reason(&mut self, reason: impl Into<String>) -> Result<()> {
        let goal = self.current.as_mut().context("no current goal")?;
        goal.last_judge_reason = Some(reason.into());
        goal.updated_at_unix = now_unix();
        self.save_default()
    }

    /// Whether the TUI should submit a continuation prompt now.
    pub fn should_auto_continue(&self) -> bool {
        self.current.as_ref().is_some_and(|g| {
            g.status == GoalStatus::Active && g.auto_continue && g.auto_continue_count < g.max_turns
        })
    }

    /// Prompt text injected when auto-continuing an active goal.
    pub fn continuation_prompt(&self) -> Option<String> {
        let g = self.current.as_ref()?;
        if !self.should_auto_continue() {
            return None;
        }
        let mut prompt = format!(
            "Continue working toward the active goal (id {}).\n\nGoal: {}\n\
             A second model will judge completion after this turn; keep going until the goal is verified done.\n\
             Auto-continue turns so far: {} (safety max {}).\n",
            g.id, g.text, g.auto_continue_count, g.max_turns
        );
        if let Some(criteria) = &g.success_criteria {
            prompt.push_str(&format!("Success criteria: {criteria}\n"));
        }
        if let Some(reason) = &g.last_judge_reason {
            prompt.push_str(&format!("Last judge note: {reason}\n"));
        }
        prompt.push_str(
            "\nRules:\n\
             - Make progress on one coherent slice this turn.\n\
             - Prefer verifiable outcomes (tests, files, commands) the judge can check.\n\
             - Do not start unrelated work. Do not claim completion without evidence.\n",
        );
        Some(prompt)
    }

    pub fn report(&self) -> String {
        match &self.current {
            None => "No active goal. Create one with `/goal create <text>`.".to_string(),
            Some(g) => {
                let mut out = format!(
                    "## Goal {}\n\n**Status:** {}\n**Auto-continue:** {} ({} turns; safety max {})\n\
                     **Completion:** second-model judge after each turn\n\n{}\n",
                    g.id,
                    g.status.as_str(),
                    if g.auto_continue { "on" } else { "off" },
                    g.auto_continue_count,
                    g.max_turns,
                    g.text
                );
                if let Some(c) = &g.success_criteria {
                    out.push_str(&format!("\n**Success criteria:** {c}\n"));
                }
                if let Some(r) = &g.block_reason {
                    out.push_str(&format!("\n**Block reason:** {r}\n"));
                }
                if let Some(j) = &g.last_judge_reason {
                    out.push_str(&format!("\n**Last judge:** {j}\n"));
                }
                out.push_str(
                    "\nCommands: `/goal pause` · `/goal resume` · `/goal block [reason]` · `/goal complete` · `/goal clear`\n\
                     Safety: `/goal create --max-turns N <text>` sets the circuit-breaker only (default 50).\n",
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

/// Strip `--max-turns N` / `--max-turns=N` from goal create text.
/// Returns `(remaining_text, max_turns)`.
pub fn strip_max_turns_flag(raw: &str) -> Result<(String, Option<u32>), String> {
    let mut max_turns = None;
    let mut out = Vec::new();
    let mut parts = raw.split_whitespace().peekable();
    while let Some(part) = parts.next() {
        if let Some(value) = part.strip_prefix("--max-turns=") {
            max_turns = Some(parse_max_turns(value)?);
            continue;
        }
        if part == "--max-turns" || part == "-n" {
            let value = parts
                .next()
                .ok_or_else(|| "Usage: --max-turns <N>".to_string())?;
            max_turns = Some(parse_max_turns(value)?);
            continue;
        }
        out.push(part);
    }
    Ok((out.join(" "), max_turns))
}

fn parse_max_turns(raw: &str) -> Result<u32, String> {
    let n: u32 = raw
        .parse()
        .map_err(|_| format!("invalid --max-turns value '{raw}' (expected positive integer)"))?;
    if n == 0 {
        return Err("--max-turns must be at least 1".to_string());
    }
    if n > 100 {
        return Err("--max-turns must be at most 100".to_string());
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_pause_resume_complete() {
        let mut store = GoalStore::default();
        store
            .create("Ship the release", Some("tag exists".into()), false, None)
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
        store.create("first", None, false, None).unwrap();
        let err = store.create("second", None, false, None).unwrap_err();
        assert!(err.to_string().contains("already"));
        store.create("second", None, true, None).unwrap();
        assert_eq!(store.current.as_ref().unwrap().text, "second");
    }

    #[test]
    fn continuation_prompt_only_when_active() {
        let mut store = GoalStore::default();
        store.create("do the thing", None, false, None).unwrap();
        assert!(store
            .continuation_prompt()
            .unwrap()
            .contains("do the thing"));
        store.pause().unwrap();
        assert!(store.continuation_prompt().is_none());
    }

    #[test]
    fn safety_max_turns_stops_auto_continue() {
        let mut store = GoalStore::default();
        store.create("ship it", None, false, Some(2)).unwrap();
        assert!(store.should_auto_continue());
        assert!(!store.note_auto_continue_submitted().unwrap());
        assert!(store.should_auto_continue());
        assert!(store.note_auto_continue_submitted().unwrap());
        assert!(!store.should_auto_continue());
        assert_eq!(store.current.as_ref().unwrap().auto_continue_count, 2);
        assert!(!store.current.as_ref().unwrap().auto_continue);
        assert!(store
            .current
            .as_ref()
            .unwrap()
            .last_judge_reason
            .as_ref()
            .unwrap()
            .contains("safety"));
    }

    #[test]
    fn strip_max_turns_flag_parses() {
        let (text, n) = strip_max_turns_flag("--max-turns 3 Ship the thing").unwrap();
        assert_eq!(text, "Ship the thing");
        assert_eq!(n, Some(3));
        let (text, n) = strip_max_turns_flag("Ship --max-turns=5 release").unwrap();
        assert_eq!(text, "Ship release");
        assert_eq!(n, Some(5));
    }
}

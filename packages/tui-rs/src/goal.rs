//! Interactive goal mode (Codex-aligned).
//!
//! One structured objective per session, with optional auto-continue while
//! the agent is idle.
//!
//! **Completion is declared by the same worker model** via the `update_goal`
//! tool (`complete` | `blocked`), matching OpenAI Codex
//! (`codex-rs/ext/goal` + `update_goal`). There is no second-model call after
//! each turn. The TUI reloads goal state from disk after turns and continues
//! only while status is still `active`.
//!
//! `max_turns` is a safety circuit-breaker (default 50) only.

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
    /// Primary stop is `update_goal` complete|blocked from the worker.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// How many auto-continue prompts have already been submitted.
    #[serde(default)]
    pub auto_continue_count: u32,
    /// Last status note (circuit-breaker, budget, or tool reason) for status.
    #[serde(default)]
    pub last_judge_reason: Option<String>,
    /// Optional token budget (Codex-style). When set, auto-continue stops once
    /// `tokens_used` reaches this value.
    #[serde(default)]
    pub token_budget: Option<u64>,
    /// Tokens accounted to this goal (sum of turn input+output while active).
    #[serde(default)]
    pub tokens_used: u64,
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
            // Keep the badge short so the status bar does not collide with the
            // right-side queue/term badges on narrow terminals (80 cols).
            const PREVIEW_CHARS: usize = 18;
            let preview: String = g.text.chars().take(PREVIEW_CHARS).collect();
            let ellipsis = if g.text.chars().count() > PREVIEW_CHARS {
                "…"
            } else {
                ""
            };
            let turns = if g.auto_continue {
                format!(" n={}", g.auto_continue_count)
            } else {
                String::new()
            };
            let budget = match g.token_budget {
                Some(b) => format!(" tok={}/{}", g.tokens_used, b),
                None if g.tokens_used > 0 => format!(" tok={}", g.tokens_used),
                None => String::new(),
            };
            format!("{}{turns}{budget} {preview}{ellipsis}", g.status.badge())
        })
    }

    pub fn create(
        &mut self,
        text: impl Into<String>,
        success_criteria: Option<String>,
        replace: bool,
        max_turns: Option<u32>,
        token_budget: Option<u64>,
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
        if let Some(budget) = token_budget {
            if budget == 0 {
                bail!("token budget must be at least 1 when set");
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
            max_turns,
            auto_continue_count: 0,
            last_judge_reason: None,
            token_budget,
            tokens_used: 0,
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
        // Keep the goal record with status `complete` (do not clear `current`).
        // Clearing used to race with mid-turn `account_tokens`, which rewrote a
        // stale Active snapshot over the tool's disk write.
        let goal = self.current.as_mut().context("no current goal")?;
        goal.status = GoalStatus::Complete;
        goal.auto_continue = false;
        goal.block_reason = None;
        goal.updated_at_unix = now_unix();
        self.save_default()?;
        Ok(self.current.clone().expect("just completed"))
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
        // Reload first: never clobber a mid-turn `update_goal` complete/blocked.
        if self.persist_path.is_some() {
            self.reload_from_disk();
        }
        let goal = self.current.as_mut().context("no current goal")?;
        if goal.status != GoalStatus::Active {
            // Terminal / paused goals must not be rewritten as Active.
            return Ok(true);
        }
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

    /// Account tokens for the latest worker turn. Returns `true` if a token
    /// budget was just exhausted (auto-continue disabled).
    pub fn account_tokens(&mut self, turn_tokens: u64) -> Result<bool> {
        if turn_tokens == 0 {
            return Ok(false);
        }
        // `update_goal` writes the same goals.json mid-turn. Reload so a stale
        // in-memory Active snapshot cannot overwrite complete/blocked.
        if self.persist_path.is_some() {
            self.reload_from_disk();
        }
        let Some(goal) = self.current.as_mut() else {
            return Ok(false);
        };
        if goal.status != GoalStatus::Active {
            return Ok(false);
        }
        goal.tokens_used = goal.tokens_used.saturating_add(turn_tokens);
        goal.updated_at_unix = now_unix();
        let hit = goal
            .token_budget
            .is_some_and(|budget| goal.tokens_used >= budget);
        if hit {
            goal.auto_continue = false;
            goal.last_judge_reason = Some(format!(
                "token budget exhausted: used {} of {}",
                goal.tokens_used,
                goal.token_budget.unwrap_or(0)
            ));
        }
        self.save_default()?;
        Ok(hit)
    }

    /// Whether the TUI should submit a continuation prompt now.
    pub fn should_auto_continue(&self) -> bool {
        self.current.as_ref().is_some_and(|g| {
            g.status == GoalStatus::Active
                && g.auto_continue
                && g.auto_continue_count < g.max_turns
                && g.token_budget.is_none_or(|budget| g.tokens_used < budget)
        })
    }

    /// True when get_goal / update_goal should be offered to the model.
    pub fn tools_visible(&self) -> bool {
        self.current.as_ref().is_some_and(|g| {
            matches!(
                g.status,
                GoalStatus::Active | GoalStatus::Paused | GoalStatus::Blocked
            )
        })
    }

    /// Reload from disk so agent `update_goal` tool mutations are visible.
    pub fn reload_from_disk(&mut self) {
        let path = self.persist_path.clone().unwrap_or_else(default_path);
        if let Ok(mut loaded) = load_from_path(&path) {
            loaded.persist_path = self.persist_path.clone().or(Some(path));
            *self = loaded;
        }
    }

    /// Prompt text injected when auto-continuing an active goal (Codex-style).
    pub fn continuation_prompt(&self) -> Option<String> {
        let g = self.current.as_ref()?;
        if !self.should_auto_continue() {
            return None;
        }
        // Keep this short: it is re-injected every auto-continue turn and was
        // burning thousands of tokens per turn during bugbash.
        let mut prompt = format!(
            "Continue the active goal {id}.\n\
             Objective: {text}\n\
             Turns {n}/{max}.",
            id = g.id,
            text = g.text,
            n = g.auto_continue_count,
            max = g.max_turns
        );
        if let Some(budget) = g.token_budget {
            let remaining = budget.saturating_sub(g.tokens_used);
            prompt.push_str(&format!(
                " Tokens {}/{} ({} left).",
                g.tokens_used, budget, remaining
            ));
        }
        if let Some(criteria) = &g.success_criteria {
            prompt.push_str(&format!(" Success criteria: {criteria}."));
        }
        prompt.push_str(
            " Make concrete progress. When evidence proves every requirement, \
             call update_goal status=complete. If blocked after repeated failures, \
             call update_goal status=blocked with reason. Do not stop without update_goal.",
        );
        Some(prompt)
    }

    pub fn report(&self) -> String {
        match &self.current {
            None => "No active goal. Create one with `/goal create <text>`.".to_string(),
            Some(g) => {
                let budget_line = match g.token_budget {
                    Some(b) => format!("**Tokens:** {} / {b}\n", g.tokens_used),
                    None => format!("**Tokens used:** {}\n", g.tokens_used),
                };
                let mut out = format!(
                    "## Goal {}\n\n**Status:** {}\n**Auto-continue:** {} ({} turns; safety max {})\n\
                     {budget_line}\
                     **Completion:** worker calls `update_goal` complete|blocked (same model; Codex-style)\n\n{}\n",
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
                    out.push_str(&format!("\n**Note:** {j}\n"));
                }
                out.push_str(
                    "\nCommands: `/goal pause` · `/goal resume` · `/goal block [reason]` · `/goal complete` · `/goal clear`\n\
                     Agent tools: `get_goal`, `update_goal` (visible only while a goal exists).\n\
                     Create flags: `--max-turns N` (safety), `--token-budget N` (Codex-style budget).\n",
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

/// Strip goal create flags from text.
/// Returns `(remaining_text, max_turns, token_budget)`.
pub fn strip_goal_flags(raw: &str) -> Result<(String, Option<u32>, Option<u64>), String> {
    let mut max_turns = None;
    let mut token_budget = None;
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
        if let Some(value) = part.strip_prefix("--token-budget=") {
            token_budget = Some(parse_token_budget(value)?);
            continue;
        }
        if part == "--token-budget" || part == "--budget" {
            let value = parts
                .next()
                .ok_or_else(|| "Usage: --token-budget <N>".to_string())?;
            token_budget = Some(parse_token_budget(value)?);
            continue;
        }
        out.push(part);
    }
    Ok((out.join(" "), max_turns, token_budget))
}

/// Back-compat wrapper.
pub fn strip_max_turns_flag(raw: &str) -> Result<(String, Option<u32>), String> {
    let (text, max_turns, _) = strip_goal_flags(raw)?;
    Ok((text, max_turns))
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

fn parse_token_budget(raw: &str) -> Result<u64, String> {
    let n: u64 = raw
        .parse()
        .map_err(|_| format!("invalid --token-budget value '{raw}' (expected positive integer)"))?;
    if n == 0 {
        return Err("--token-budget must be at least 1".to_string());
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
            .create(
                "Ship the release",
                Some("tag exists".into()),
                false,
                None,
                None,
            )
            .unwrap();
        assert!(store.should_auto_continue());
        store.pause().unwrap();
        assert!(!store.should_auto_continue());
        store.resume().unwrap();
        assert!(store.should_auto_continue());
        let done = store.complete().unwrap();
        assert_eq!(done.status, GoalStatus::Complete);
        assert_eq!(
            store.current.as_ref().map(|g| g.status),
            Some(GoalStatus::Complete)
        );
        assert!(!store.should_auto_continue());
        assert!(!store.tools_visible());
    }

    #[test]
    fn refuses_second_goal_without_replace() {
        let mut store = GoalStore::default();
        store.create("first", None, false, None, None).unwrap();
        let err = store.create("second", None, false, None, None).unwrap_err();
        assert!(err.to_string().contains("already"));
        store.create("second", None, true, None, None).unwrap();
        assert_eq!(store.current.as_ref().unwrap().text, "second");
    }

    #[test]
    fn continuation_prompt_only_when_active() {
        let mut store = GoalStore::default();
        store
            .create("do the thing", None, false, None, None)
            .unwrap();
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
        store.create("ship it", None, false, Some(2), None).unwrap();
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
    fn token_budget_stops_auto_continue() {
        let mut store = GoalStore::default();
        store
            .create("ship it", None, false, None, Some(100))
            .unwrap();
        assert!(store.should_auto_continue());
        assert!(!store.account_tokens(40).unwrap());
        assert!(store.should_auto_continue());
        assert!(store.account_tokens(70).unwrap());
        assert!(!store.should_auto_continue());
        assert_eq!(store.current.as_ref().unwrap().tokens_used, 110);
    }

    #[test]
    fn account_tokens_does_not_clobber_mid_turn_complete() {
        // Regression: worker `update_goal` complete writes goals.json; a later
        // ResponseEnd must not save a stale Active snapshot over it.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("goals.json");
        let mut app_store = GoalStore {
            persist_path: Some(path.clone()),
            ..Default::default()
        };
        app_store
            .create("finish the file", None, false, None, Some(50_000))
            .unwrap();
        assert_eq!(
            app_store.current.as_ref().unwrap().status,
            GoalStatus::Active
        );

        // Simulate agent tool path: load same file, complete, save.
        let mut tool_store = GoalStore {
            persist_path: Some(path.clone()),
            ..load_from_path(&path).unwrap()
        };
        tool_store.complete().unwrap();
        assert_eq!(
            tool_store.current.as_ref().unwrap().status,
            GoalStatus::Complete
        );

        // Stale in-memory Active must not overwrite complete when accounting.
        assert!(!app_store.account_tokens(1_200).unwrap());
        assert_eq!(
            app_store.current.as_ref().unwrap().status,
            GoalStatus::Complete
        );
        let reloaded = load_from_path(&path).unwrap();
        assert_eq!(
            reloaded.current.as_ref().unwrap().status,
            GoalStatus::Complete
        );
        // Tokens are not added after terminal status.
        assert_eq!(reloaded.current.as_ref().unwrap().tokens_used, 0);
    }

    #[test]
    fn tools_visible_only_with_goal() {
        let mut store = GoalStore::default();
        assert!(!store.tools_visible());
        store.create("x", None, false, None, None).unwrap();
        assert!(store.tools_visible());
        store.complete().unwrap();
        assert!(!store.tools_visible());
    }

    #[test]
    fn strip_goal_flags_parses() {
        let (text, n, b) =
            strip_goal_flags("--max-turns 3 --token-budget 5000 Ship the thing").unwrap();
        assert_eq!(text, "Ship the thing");
        assert_eq!(n, Some(3));
        assert_eq!(b, Some(5000));
        let (text, n) = strip_max_turns_flag("Ship --max-turns=5 release").unwrap();
        assert_eq!(text, "Ship release");
        assert_eq!(n, Some(5));
    }
}

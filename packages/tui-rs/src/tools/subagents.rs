//! Durable, provider-neutral child-agent delegation.
//!
//! A subagent is a real [`NativeAgent`] with its own provider conversation,
//! session journal, and optional git worktree. The parent only receives a
//! compact handle from `spawn_subagent`; the other lifecycle tools read the
//! durable record and can therefore observe or resume a child from another
//! `ToolExecutor` in the same process.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::agent::{CredentialVault, FromAgent, NativeAgent, NativeAgentConfig, ToolResult};
use crate::headless::{FromAgentMessage, SessionRecorder, ToAgentMessage};
use crate::hooks::{HookResult, IntegratedHookSystem};
use crate::sandbox::SandboxPolicy;
use crate::session::{sanitize_path_for_dirname, SessionLock};
use crate::state::ApprovalMode;
use crate::tools::ToolRegistry;
use crate::worktree::WorktreeSession;

/// Built-in tools which belong to this lifecycle surface and must not be
/// advertised to a child. Without this guard a child could recursively spawn
/// an unbounded tree of agents.
pub(crate) const SUBAGENT_TOOL_NAMES: [&str; 8] = [
    "spawn_subagent",
    "list_subagents",
    "get_subagent",
    "wait_subagent",
    "resume_subagent",
    "cancel_subagent",
    "inspect_subagent",
    "cleanup_subagent",
];

const MAX_TASK_BYTES: usize = 64 * 1024;
const MAX_WAIT_MS: u64 = 300_000;
const TERMINAL_SNAPSHOT_WAIT: Duration = Duration::from_millis(500);
const DEFAULT_CHILD_MAX_TOKENS: u32 = 16_384;
const MAX_CHILD_MAX_TOKENS: u32 = 131_072;
const DEFAULT_CHILD_TIMEOUT_MS: u64 = 7_200_000;
const MAX_CHILD_TIMEOUT_MS: u64 = 86_400_000;
const DEFAULT_MAX_RUNNING_SUBAGENTS: usize = 4;
const MAX_RUNNING_SUBAGENTS: usize = 32;

/// Characters of streamed assistant text counted as one output token when the
/// runtime reports no usage.
///
/// Four characters per token is the common English approximation. Code and
/// other dense text run closer to three, so this under-counts them: the
/// estimate reaches the budget later than the true token count would, never
/// earlier, and the run is cut off late rather than prematurely.
const CHILD_OUTPUT_CHARS_PER_TOKEN: u64 = 4;

/// Estimate output tokens from a count of streamed characters.
fn estimate_output_tokens(streamed_chars: u64) -> u64 {
    streamed_chars.div_ceil(CHILD_OUTPUT_CHARS_PER_TOKEN)
}

/// Whether the run has spent its cumulative output allowance, counting text
/// streamed since the last response boundary at the estimated rate.
///
/// Checked while a response streams so one long turn cannot overrun the budget
/// and only be noticed at the boundary that follows it. Only meaningful for a
/// runtime that reports no usage: see [`child_output_is_metered`].
fn child_output_budget_exhausted(used_tokens: u64, streamed_chars: u64, max_tokens: u32) -> bool {
    used_tokens.saturating_add(estimate_output_tokens(streamed_chars)) >= u64::from(max_tokens)
}

/// Characters of model-produced output carried by one tool call.
///
/// The tool name and its serialized arguments are tokens the model generated,
/// so they count against an unmetered run's budget exactly like assistant text.
/// A tool call whose arguments cannot be serialized contributes only its name;
/// under-counting is the safe direction, matching the estimate itself.
fn tool_call_output_chars(tool: &str, args: &serde_json::Value) -> u64 {
    let argument_chars = serde_json::to_string(args)
        .map(|json| json.chars().count())
        .unwrap_or(0);
    (tool.chars().count() as u64).saturating_add(argument_chars as u64)
}

/// Whether the child's runtime reports exact output-token usage.
///
/// Everything except the Codex app-server path returns usage on every
/// `ResponseEnd`, and the runner clamps each request to the unspent budget from
/// that exact count, so those runs are already bounded. Applying the
/// four-characters-per-token estimate on top of an exact count can only make
/// the parent cancel a response the budget still allowed, so the estimate is
/// confined to the unmetered path.
fn child_output_is_metered(model: &str) -> bool {
    !crate::codex_auth::model_uses_openai_codex(model)
}

/// Tracks whether a child's runtime actually reports output-token usage.
///
/// The model name is not a reliable answer. An OpenAI-compatible endpoint may
/// omit the usage chunk on any turn, in which case `ResponseEnd` carries no
/// usage even though the model is not Codex, and a name-based rule charged that
/// turn nothing at all. Observation decides instead: a turn that reports usage
/// is charged exactly, and a turn that reports none is charged the estimate.
#[derive(Debug, Default, Clone, Copy)]
struct ChildOutputMetering {
    /// True for the Codex app-server path, which reports no usage by design and
    /// also accepts no per-request `max_tokens`.
    known_unmetered: bool,
    /// Set once a turn has ended without a usage report.
    observed_missing_usage: bool,
}

impl ChildOutputMetering {
    fn for_model(model: &str) -> Self {
        Self {
            known_unmetered: !child_output_is_metered(model),
            observed_missing_usage: false,
        }
    }

    /// Characters to charge for a turn that reported `usage`, if any.
    ///
    /// `None` means "do not estimate": the provider reported real numbers, so
    /// the exact count is used and the streamed characters are discarded rather
    /// than charged on top of it.
    fn estimate_for_turn(&mut self, usage_reported: bool, streamed_chars: u64) -> Option<u64> {
        if usage_reported {
            return None;
        }
        self.observed_missing_usage = true;
        Some(streamed_chars)
    }

    /// Whether to police the budget from streamed text before a turn ends.
    ///
    /// Only where an overrun would otherwise go unbounded. The Codex path sends
    /// no per-request `max_tokens`, so it is policed from the first turn. Every
    /// other runtime is bounded per request by the runner's clamp, so
    /// mid-stream estimation waits until a turn has actually failed to report
    /// usage -- estimating before that could cancel a response a metering
    /// provider would have allowed.
    fn enforces_mid_stream(self) -> bool {
        self.known_unmetered || self.observed_missing_usage
    }
}

/// Add one response's output tokens to the run total and report whether the
/// cumulative budget is spent.
///
/// The Codex app-server runtime reports no usage: `turn/start`
/// (`codex_app_server.rs`) carries no token fields in either direction, so
/// `ResponseEnd` arrives with `usage: None` and an unestimated run was never
/// charged for anything it produced. `estimate_chars` carries the assistant
/// text observed for that response and is `None` on a metered runtime, where an
/// absent usage report is a provider anomaly rather than the norm and guessing
/// would risk cancelling a response the budget still allowed.
fn record_child_output_tokens(
    used_tokens: &mut u64,
    usage: Option<&crate::agent::TokenUsage>,
    estimate_chars: Option<u64>,
    max_tokens: u32,
) -> bool {
    let spent = match (usage, estimate_chars) {
        (Some(usage), _) => usage.output_tokens,
        (None, Some(chars)) => estimate_output_tokens(chars),
        (None, None) => 0,
    };
    *used_tokens = used_tokens.saturating_add(spent);
    *used_tokens >= u64::from(max_tokens)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
}

impl SubagentStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::TimedOut | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentRole {
    Explore,
    Plan,
    Code,
    Review,
}

impl SubagentRole {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("code").trim().to_ascii_lowercase().as_str() {
            "explore" | "explorer" => Ok(Self::Explore),
            "plan" | "planner" => Ok(Self::Plan),
            "code" | "coder" | "implement" => Ok(Self::Code),
            "review" | "reviewer" => Ok(Self::Review),
            other => Err(format!(
                "role must be one of explore, plan, code, or review; got {other}"
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Plan => "plan",
            Self::Code => "code",
            Self::Review => "review",
        }
    }

    /// Whether a child in this role is allowed to change anything.
    ///
    /// `Code` is the only role that writes. The others are advertised to the
    /// user as read-only, so the sandbox policy and the native-approval gate
    /// both have to enforce that, not just the advertised tool list.
    fn can_mutate(self) -> bool {
        matches!(self, Self::Code)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentIsolation {
    Shared,
    Worktree,
}

impl SubagentIsolation {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("worktree")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "shared" | "workspace" => Ok(Self::Shared),
            "worktree" | "isolated" => Ok(Self::Worktree),
            other => Err(format!(
                "isolation must be either shared or worktree; got {other}"
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SubagentResult {
    pub output: String,
    pub files_modified: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SubagentLifecycleEvent {
    pub subagent_id: String,
    pub parent_scope_id: String,
    pub parent_call_id: String,
    pub status: SubagentStatus,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub finished_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SubagentRecord {
    pub id: String,
    pub parent_scope_id: String,
    pub parent_call_id: String,
    pub last_parent_scope_id: String,
    pub last_call_id: String,
    pub task: String,
    pub current_prompt: String,
    pub role: SubagentRole,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub profile_prompt: Option<String>,
    #[serde(default)]
    pub profile_tools: Option<Vec<String>>,
    pub model: Option<String>,
    #[serde(default = "default_child_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_child_max_tokens")]
    pub max_tokens: u32,
    pub isolation: SubagentIsolation,
    pub cwd: String,
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub worktree_cleaned: bool,
    #[serde(default)]
    pub initial_files: Vec<String>,
    #[serde(default)]
    pub initial_file_fingerprints: HashMap<String, String>,
    #[serde(default)]
    pub initial_head: Option<String>,
    pub session_dir: String,
    pub status: SubagentStatus,
    pub attempt: u32,
    #[serde(default)]
    pub snapshot_attempt: Option<u32>,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub result: Option<SubagentResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct SpawnRequest {
    task: String,
    role: SubagentRole,
    profile: Option<String>,
    profile_prompt: Option<String>,
    profile_tools: Option<Vec<String>>,
    model: Option<String>,
    timeout_ms: u64,
    max_tokens: u32,
    run_in_background: bool,
    isolation: SubagentIsolation,
    worktree_name: Option<String>,
}

struct ChildLaunch {
    lease: Option<SessionLock>,
    credential_vault: CredentialVault,
    parent_credential_vault: CredentialVault,
    parent_credential_generation: u64,
    parent_cancel: Option<CancellationToken>,
}

struct ParentCredentialScope<'a> {
    vault: &'a CredentialVault,
    generation: u64,
}

struct WorktreeSetupGuard {
    session: Option<WorktreeSession>,
}

impl WorktreeSetupGuard {
    fn new(session: WorktreeSession) -> Self {
        Self {
            session: Some(session),
        }
    }

    fn copy_changes_from(&self, source: &Path) -> anyhow::Result<()> {
        self.session
            .as_ref()
            .expect("worktree setup guard must own a session")
            .copy_changes_from(source)
    }

    fn path_for(&self, source: &Path) -> anyhow::Result<PathBuf> {
        self.session
            .as_ref()
            .expect("worktree setup guard must own a session")
            .path_for(source)
    }

    fn path(&self) -> &Path {
        self.session
            .as_ref()
            .expect("worktree setup guard must own a session")
            .path()
    }

    fn disarm(mut self) {
        self.session.take();
    }
}

impl Drop for WorktreeSetupGuard {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            session.abort();
        }
    }
}

struct RuntimeRegistry {
    cancellation: Mutex<HashMap<String, CancellationToken>>,
    credential_scopes: Mutex<HashMap<String, CredentialVault>>,
    concurrency: Arc<Semaphore>,
    lifecycle_events: Mutex<VecDeque<SubagentLifecycleEvent>>,
}

impl RuntimeRegistry {
    fn new() -> Self {
        let configured = std::env::var("MAESTRO_MAX_RUNNING_SUBAGENTS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MAX_RUNNING_SUBAGENTS)
            .clamp(1, MAX_RUNNING_SUBAGENTS);
        Self::with_capacity(configured)
    }

    fn with_capacity(max_running: usize) -> Self {
        Self {
            cancellation: Mutex::new(HashMap::new()),
            credential_scopes: Mutex::new(HashMap::new()),
            concurrency: Arc::new(Semaphore::new(max_running.max(1))),
            lifecycle_events: Mutex::new(VecDeque::new()),
        }
    }

    async fn acquire_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        self.concurrency
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| format!("subagent scheduler closed: {error}"))
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.concurrency.available_permits()
    }

    fn insert(&self, id: &str, token: CancellationToken) {
        self.cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_string(), token);
    }

    fn remove(&self, id: &str) {
        self.cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
    }

    fn get(&self, id: &str) -> Option<CancellationToken> {
        self.cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    fn set_credential_scope(&self, id: &str, vault: CredentialVault) {
        self.credential_scopes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_string(), vault);
    }

    fn credential_scope(&self, id: &str) -> Option<CredentialVault> {
        self.credential_scopes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    fn push_event(&self, event: SubagentLifecycleEvent) {
        self.lifecycle_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(event);
    }

    fn poll_events(&self, parent_scope_id: &str) -> Vec<SubagentLifecycleEvent> {
        let mut events = self
            .lifecycle_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut matching = Vec::new();
        let mut remaining = VecDeque::with_capacity(events.len());
        while let Some(event) = events.pop_front() {
            if event.parent_scope_id == parent_scope_id {
                matching.push(event);
            } else {
                remaining.push_back(event);
            }
        }
        *events = remaining;
        matching
    }
}

fn runtime_registry() -> Arc<RuntimeRegistry> {
    static REGISTRY: OnceLock<Arc<RuntimeRegistry>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(RuntimeRegistry::new()))
        .clone()
}

/// Manager shared by one or more tool executors for a workspace.
#[derive(Clone)]
pub(crate) struct SubagentManager {
    cwd: PathBuf,
    root: PathBuf,
    /// Scope that owns the children this manager spawns and the lifecycle
    /// events it drains.
    ///
    /// Shared and mutable because the tool executor holding this manager lives
    /// behind an `Arc` for the whole process while the conversation it serves
    /// does not: a new or resumed session rotates the scope in place so a child
    /// started by an earlier conversation cannot report into a later one.
    parent_scope_id: Arc<Mutex<String>>,
    runtime: Arc<RuntimeRegistry>,
}

impl SubagentManager {
    pub(crate) fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        let root = default_root(&cwd);
        Self::with_root(cwd, root)
    }

    fn with_root(cwd: PathBuf, root: PathBuf) -> Self {
        Self::with_root_and_parent_scope(cwd, root, uuid::Uuid::new_v4().to_string())
    }

    pub(crate) fn with_parent_scope(
        cwd: impl Into<PathBuf>,
        parent_scope_id: impl Into<String>,
    ) -> Self {
        let cwd = cwd.into();
        let root = default_root(&cwd);
        Self::with_root_and_parent_scope(cwd, root, parent_scope_id.into())
    }

    fn with_root_and_parent_scope(cwd: PathBuf, root: PathBuf, parent_scope_id: String) -> Self {
        Self {
            cwd,
            root,
            parent_scope_id: Arc::new(Mutex::new(parent_scope_id)),
            runtime: runtime_registry(),
        }
    }

    pub(crate) fn parent_scope_id(&self) -> String {
        self.parent_scope_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Point this manager at a different scope.
    ///
    /// Children already running keep the scope they were spawned under -- the
    /// record snapshots it -- so their completions stay addressed to the
    /// conversation that started them and are drained only by a manager holding
    /// that same scope.
    pub(crate) fn set_parent_scope_id(&self, parent_scope_id: String) {
        let mut current = self
            .parent_scope_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = parent_scope_id;
    }

    pub(crate) fn poll_lifecycle_events(&self) -> Vec<SubagentLifecycleEvent> {
        self.runtime.poll_events(&self.parent_scope_id())
    }

    fn record_path(&self, id: &str) -> PathBuf {
        self.root.join(id).join("record.json")
    }

    fn validate_id(id: &str) -> Result<String, String> {
        let id = id.trim();
        uuid::Uuid::parse_str(id)
            .map(|_| id.to_string())
            .map_err(|_| format!("invalid subagent_id `{id}`"))
    }

    fn write_record(&self, record: &SubagentRecord) -> Result<(), String> {
        let path = self.record_path(&record.id);
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|error| format!("serialize subagent record: {error}"))?;
        crate::fs_atomic::write_atomic(path, bytes)
            .map_err(|error| format!("persist subagent record: {error}"))
    }

    fn load_record(&self, id: &str) -> Result<SubagentRecord, String> {
        let id = Self::validate_id(id)?;
        let path = self.record_path(&id);
        let bytes =
            std::fs::read(&path).map_err(|error| format!("read subagent {id} record: {error}"))?;
        let mut record: SubagentRecord = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse subagent {id} record: {error}"))?;
        if matches!(
            record.status,
            SubagentStatus::Queued | SubagentStatus::Running
        ) && self.runtime.get(&record.id).is_none()
            && !Self::execution_lease_is_held(&record)
        {
            record.status = SubagentStatus::Interrupted;
            record.finished_at_ms = Some(now_millis());
            record.error = Some(
                "Maestro restarted while this subagent was queued or running; resume it to continue"
                    .to_string(),
            );
            self.write_record(&record)?;
        }
        Ok(record)
    }

    /// Whether some process still holds the execution lease for `record`.
    ///
    /// `self.runtime` only knows about children this process launched, so a
    /// second Maestro sharing the workspace sees every live child of the first
    /// one as orphaned. The lease — the advisory lock the run path holds on
    /// the child's timeline file for as long as the child runs (see `spawn`,
    /// `resume`, and `run_child`) — is the cross-process signal, so consult it
    /// before rewriting a record to `Interrupted`. `Interrupted` is terminal,
    /// and `cleanup` force-removes the worktree of any terminal child.
    ///
    /// Anything other than a clean "nobody holds it" answer counts as held.
    /// A false positive leaves a genuinely dead record `Running` until the
    /// next load; a false negative deletes a live child's worktree underneath
    /// it.
    fn execution_lease_is_held(record: &SubagentRecord) -> bool {
        match SessionLock::is_held(&Self::timeline_path(record)) {
            Ok(held) => held,
            Err(error) => {
                eprintln!(
                    "subagent {}: could not read the execution lease ({error}); treating the child as still running",
                    record.id
                );
                true
            }
        }
    }

    /// Take the execution lease for `record` so a cleanup cannot run
    /// concurrently with a resume.
    ///
    /// Returns `Ok(None)` when the child's session directory is gone: the lock
    /// file lives in that directory, so nothing can be holding a lease and no
    /// `resume` could start one either — it opens the same directory and would
    /// fail first. This mirrors [`SessionLock::is_held`], which reports a
    /// missing directory as "not held", and keeps cleanup usable for a record
    /// whose transcript has already been pruned.
    ///
    /// Every other failure — including an unreadable lock file — is reported
    /// as "in use". A false positive leaves a worktree on disk for the user to
    /// remove; a false negative deletes the worktree of a running child.
    /// Re-read `id` under a held execution lease and confirm it can still run.
    ///
    /// `cleanup` takes the same lease around its own check and removal, so once
    /// this lease is held the record on disk is settled: a cleanup either
    /// completed before it or cannot start until it is released. A child whose
    /// worktree has been removed cannot be resumed, and saying so leaves the
    /// record untouched rather than relaunching into a directory that is gone.
    fn revalidate_resumable_under_lease(&self, id: &str) -> Result<SubagentRecord, String> {
        let record = self.load_record(id)?;
        if record.worktree_cleaned {
            return Err(format!(
                "subagent {id} cannot be resumed: its worktree was cleaned up; spawn a new child instead"
            ));
        }
        let cwd = deserialize_repository_path(&record.cwd);
        if !cwd.exists() {
            return Err(format!(
                "subagent {id} cannot be resumed: its working directory {} no longer exists",
                cwd.display()
            ));
        }
        Ok(record)
    }

    fn acquire_cleanup_lease(record: &SubagentRecord) -> Result<Option<SessionLock>, String> {
        if !Self::session_dir(record).exists() {
            return Ok(None);
        }
        SessionLock::acquire(&Self::timeline_path(record))
            .map(Some)
            .map_err(|error| {
                format!(
                    "subagent {} is being run by another process; not removing its worktree ({error})",
                    record.id
                )
            })
    }

    fn session_dir(record: &SubagentRecord) -> PathBuf {
        deserialize_repository_path(&record.session_dir)
    }

    fn timeline_path(record: &SubagentRecord) -> PathBuf {
        Self::session_dir(record).join(format!("{}.jsonl", record.id))
    }

    pub(crate) async fn spawn(
        &self,
        args: &serde_json::Value,
        parent_call_id: &str,
        sandbox_policy: Option<SandboxPolicy>,
        credential_vault: CredentialVault,
        cancel: Option<&CancellationToken>,
    ) -> ToolResult {
        let mut request = match parse_spawn_request(args) {
            Ok(request) => request,
            Err(error) => return ToolResult::failure(error),
        };
        let child_credential_vault = credential_vault.fork();

        if let Err(error) =
            apply_subagent_start_hook(&mut request, &self.cwd, &self.parent_scope_id())
        {
            return ToolResult::failure(error);
        }
        if let Err(error) = resolve_spawn_profile(&mut request, &self.cwd) {
            return ToolResult::failure(error);
        }
        // Resolve through the current parent scope first, then re-vault into
        // the child scope so the durable prompt never contains plaintext or
        // an unresolvable parent-only reference.
        let parent_resolved_task = credential_vault.resolve_all(&request.task);
        request.task = child_credential_vault.vault_in_text(&parent_resolved_task);

        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return cancelled_result("spawn_subagent cancelled before launch");
        }

        let id = uuid::Uuid::new_v4().to_string();
        let (child_cwd, worktree_path, mut worktree_setup) = match request.isolation {
            SubagentIsolation::Shared => (self.cwd.clone(), None, None),
            SubagentIsolation::Worktree => {
                if !worktree_setup_allowed(sandbox_policy.as_ref()) {
                    return ToolResult::failure(
                        "worktree isolation requires an unrestricted sandbox because host-side git worktree setup writes repository metadata; use isolation=shared or danger-full-access",
                    );
                }
                let name = request
                    .worktree_name
                    .as_deref()
                    .unwrap_or("maestro-subagent");
                let name = format!("{name}-{id}");
                let session = match WorktreeSession::create_in(&self.cwd, &name) {
                    Ok(session) => session,
                    Err(error) => {
                        return ToolResult::failure(format!("create subagent worktree: {error:#}"));
                    }
                };
                let setup = WorktreeSetupGuard::new(session);
                if let Err(error) = setup.copy_changes_from(&self.cwd) {
                    return ToolResult::failure(format!(
                        "copy parent changes into subagent worktree: {error:#}"
                    ));
                }
                let child_cwd = match setup.path_for(&self.cwd) {
                    Ok(path) => path,
                    Err(error) => {
                        return ToolResult::failure(format!(
                            "map parent directory into subagent worktree: {error:#}"
                        ));
                    }
                };
                let worktree_path = setup.path().to_path_buf();
                (child_cwd, Some(worktree_path), Some(setup))
            }
        };
        let (initial_paths, initial_fingerprints) = changed_file_baseline(&child_cwd);
        let (initial_files, initial_file_fingerprints) =
            serialize_file_baseline(initial_paths, initial_fingerprints);
        let initial_head = git_repository_head(&child_cwd);

        let session_dir = self.root.join(&id).join("session");
        if let Err(error) = crate::fs_atomic::create_dir_all_synced(&session_dir) {
            return ToolResult::failure(format!("create subagent session directory: {error}"));
        }

        let now = now_millis();
        let cwd = serialize_repository_path(&child_cwd);
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: self.parent_scope_id(),
            parent_call_id: parent_call_id.to_string(),
            last_parent_scope_id: self.parent_scope_id(),
            last_call_id: parent_call_id.to_string(),
            task: request.task.clone(),
            current_prompt: request.task.clone(),
            role: request.role,
            profile: request.profile.clone(),
            profile_prompt: request.profile_prompt.clone(),
            profile_tools: request.profile_tools.clone(),
            model: request.model.clone(),
            timeout_ms: request.timeout_ms,
            max_tokens: request.max_tokens,
            isolation: request.isolation,
            cwd,
            worktree_path: worktree_path
                .as_ref()
                .map(|path| serialize_repository_path(path)),
            worktree_cleaned: false,
            initial_files,
            initial_file_fingerprints,
            initial_head,
            session_dir: serialize_repository_path(&session_dir),
            status: SubagentStatus::Queued,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: now,
            started_at_ms: None,
            finished_at_ms: None,
            result: None,
            error: None,
        };

        let lease = match SessionLock::acquire(&Self::timeline_path(&record)) {
            Ok(lease) => lease,
            Err(error) => {
                return ToolResult::failure(format!(
                    "acquire subagent {} execution lease: {error}",
                    record.id
                ));
            }
        };

        let mut recorder = match SessionRecorder::with_id(&session_dir, &id) {
            Ok(recorder) => recorder,
            Err(error) => {
                return ToolResult::failure(format!("create subagent transcript: {error}"));
            }
        };
        if let Err(error) = recorder.record_sent(&ToAgentMessage::Prompt {
            content: request.task.clone(),
            attachments: None,
        }) {
            return ToolResult::failure(format!("record subagent prompt: {error}"));
        }
        if let Err(error) = recorder.flush_checkpoint() {
            return ToolResult::failure(format!("flush subagent prompt: {error}"));
        }
        drop(recorder);

        if let Err(error) = self.write_record(&record) {
            return ToolResult::failure(error);
        }

        let token = CancellationToken::new();
        self.runtime
            .set_credential_scope(&id, child_credential_vault.clone());
        self.runtime.insert(&id, token.clone());
        let manager = self.clone();
        let launch_record = record.clone();
        let launch_policy = sandbox_policy;
        let launch_token = token.clone();
        let run_in_background = request.run_in_background;
        let parent_cancel = if run_in_background {
            None
        } else {
            cancel.cloned()
        };
        let parent_credential_generation = credential_vault.generation();
        let launch = ChildLaunch {
            lease: Some(lease),
            credential_vault: child_credential_vault,
            parent_credential_vault: credential_vault,
            parent_credential_generation,
            parent_cancel,
        };
        let role = request.role;
        let task = request.task.clone();
        let launch_id = id.clone();
        let launch_error_id = id.clone();
        let launch = async move {
            let cancellation_link = launch.parent_cancel.clone().map(|parent| {
                let child_token = launch_token.clone();
                tokio::spawn(async move {
                    parent.cancelled().await;
                    child_token.cancel();
                })
            });
            let result = manager
                .run_child(
                    launch_record,
                    task,
                    None,
                    launch_policy,
                    launch_token,
                    launch,
                )
                .await;
            if let Some(cancellation_link) = cancellation_link {
                cancellation_link.abort();
            }
            manager.runtime.remove(&launch_id);
            result
        };

        if let Some(setup) = worktree_setup.take() {
            setup.disarm();
        }

        if run_in_background {
            let launch_error_id = launch_error_id.clone();
            tokio::spawn(async move {
                if let Err(error) = launch.await {
                    eprintln!("subagent {launch_error_id} failed: {error}");
                }
            });
            return ToolResult::success(format!(
                "Spawned {} subagent {} in the background",
                role.label(),
                id
            ))
            .with_details(record_details(&record));
        }

        match launch.await {
            Ok(record) => tool_result_for_record(record),
            Err(error) => ToolResult::failure(error),
        }
    }

    pub(crate) async fn list(&self) -> ToolResult {
        let mut records = Vec::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ToolResult::success("No subagents").with_details(serde_json::json!({
                    "count": 0,
                    "subagents": []
                }));
            }
            Err(error) => return ToolResult::failure(format!("list subagents: {error}")),
        };

        for entry in entries.flatten() {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if let Ok(record) = self.load_record(&id) {
                records.push(record);
            }
        }
        records.sort_by_key(|record| std::cmp::Reverse(record.created_at_ms));
        let lines = records
            .iter()
            .map(|record| {
                format!(
                    "{} {} {}",
                    record.id,
                    status_label(record.status),
                    record.task.replace(['\n', '\r'], " ")
                )
            })
            .collect::<Vec<_>>();
        let details = serde_json::json!({
            "count": records.len(),
            "subagents": records.iter().map(record_details).collect::<Vec<_>>()
        });
        ToolResult::success(if lines.is_empty() {
            "No subagents".to_string()
        } else {
            lines.join("\n")
        })
        .with_details(details)
    }

    pub(crate) fn get(&self, args: &serde_json::Value) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        match self.load_record(id) {
            Ok(record) => tool_result_for_record(record),
            Err(error) => ToolResult::failure(error),
        }
    }

    pub(crate) fn inspect(&self, args: &serde_json::Value) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        let record = match self.load_record(id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };
        let Some(serialized_path) = record.worktree_path.as_deref() else {
            return ToolResult::success(format!("Subagent {id} does not have a worktree"))
                .with_details(serde_json::json!({
                    "subagentId": record.id,
                    "worktreePath": null,
                    "worktreeCleaned": record.worktree_cleaned,
                }));
        };
        let path = deserialize_repository_path(serialized_path);
        let exists = path.exists();
        let status = if exists {
            git_worktree_command(&path, ["status", "--short"], None)
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_else(|error| format!("unable to inspect status: {error}"))
        } else {
            "worktree path does not exist".to_string()
        };
        let diff_stat = if exists {
            git_worktree_command(&path, ["diff", "--stat"], None)
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let details = serde_json::json!({
            "subagentId": record.id,
            "worktreePath": display_repository_path(&path),
            "worktreeCleaned": record.worktree_cleaned,
            "exists": exists,
            "status": status,
            "diffStat": diff_stat,
            "filesModified": record.result.as_ref().map(|result| &result.files_modified),
        });
        ToolResult::success(format!("Inspected worktree for subagent {id}")).with_details(details)
    }

    pub(crate) fn cleanup(&self, args: &serde_json::Value) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        // First load: learn where this child's lease lives, and let the
        // orphan reclassification in `load_record` run while no lease is held,
        // so a child left `Running` by a crashed process settles to
        // `Interrupted` before the check below rather than blocking cleanup.
        let record = match self.load_record(id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };

        // Take the execution lease before reading the status that decides
        // whether to delete, and hold it through the removal. A one-shot check
        // followed by an unguarded `git worktree remove --force` could pass
        // while another process was acquiring the lease in `resume`; cleanup
        // then deleted the worktree out from under a child that had just been
        // restarted. The lease is what `resume` and `run_child` hold for a
        // child's whole run, so taking it here makes the two mutually
        // exclusive: whoever gets it first wins, and the loser does nothing.
        let _lease = match Self::acquire_cleanup_lease(&record) {
            Ok(lease) => lease,
            Err(error) => return ToolResult::failure(error),
        };

        // Second load, now under the lease. A resume that beat us to the lease
        // has already rewritten this record, and one that arrives after cannot
        // start until we release it, so this status cannot change underneath
        // the removal below.
        let mut record = match self.load_record(id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };
        if !record.status.is_terminal() {
            return ToolResult::failure(format!(
                "subagent {id} must be terminal before its worktree can be cleaned up"
            ));
        }
        if record.worktree_cleaned {
            return ToolResult::success(format!("Worktree for subagent {id} is already cleaned"))
                .with_details(record_details(&record));
        }
        // Shared children never create a worktree. Leave `worktree_cleaned`
        // unset so a later `resume_subagent` is not rejected for a cleanup that
        // removed nothing.
        let Some(serialized_path) = record.worktree_path.as_deref() else {
            return ToolResult::success(format!("Subagent {id} did not have a worktree"))
                .with_details(record_details(&record));
        };
        let path = deserialize_repository_path(serialized_path);
        if path == self.cwd {
            return ToolResult::failure(
                "refusing to clean the parent workspace as a subagent worktree",
            );
        }
        if path.exists() {
            if !git_worktree_is_registered(&self.cwd, &path) {
                return ToolResult::failure(format!(
                    "refusing to remove unregistered worktree path {}",
                    path.display()
                ));
            }
            let output = match git_worktree_command(
                &self.cwd,
                ["worktree", "remove", "--force"],
                Some(&path),
            ) {
                Ok(output) => output,
                Err(error) => return ToolResult::failure(error),
            };
            if !output.status.success() {
                return ToolResult::failure(format!(
                    "remove subagent worktree {}: {}",
                    path.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            let _ = git_worktree_command(&self.cwd, ["worktree", "prune"], None);
        }
        record.worktree_cleaned = true;
        if let Err(error) = self.write_record(&record) {
            return ToolResult::failure(error);
        }
        ToolResult::success(format!("Cleaned worktree for subagent {id}"))
            .with_details(record_details(&record))
    }

    pub(crate) async fn wait(
        &self,
        args: &serde_json::Value,
        cancel: Option<&CancellationToken>,
    ) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        let timeout_ms = match parse_wait_timeout(args) {
            Ok(timeout_ms) => timeout_ms,
            Err(error) => return ToolResult::failure(error),
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);

        loop {
            let record = match self.load_record(id) {
                Ok(record) => record,
                Err(error) => return ToolResult::failure(error),
            };
            if record.status.is_terminal() || timeout_ms == 0 || Instant::now() >= deadline {
                return tool_result_for_record(record);
            }

            if cancel.is_some_and(CancellationToken::is_cancelled) {
                return cancelled_result("wait_subagent cancelled");
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            tokio::time::sleep(remaining.min(Duration::from_millis(50))).await;
        }
    }

    pub(crate) async fn resume(
        &self,
        args: &serde_json::Value,
        parent_call_id: &str,
        sandbox_policy: Option<SandboxPolicy>,
        credential_vault: CredentialVault,
        cancel: Option<&CancellationToken>,
    ) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        let prompt = args
            .get("task")
            .or_else(|| args.get("follow_up"))
            .or_else(|| args.get("followUp"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .map(str::to_string);
        let Some(prompt) = prompt else {
            return ToolResult::failure("task or follow_up is required to resume a subagent");
        };
        if prompt.len() > MAX_TASK_BYTES {
            return ToolResult::failure(format!(
                "subagent follow-up exceeds the {} byte limit",
                MAX_TASK_BYTES
            ));
        }
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return cancelled_result("resume_subagent cancelled before launch");
        }
        if self.runtime.get(id).is_some() {
            return ToolResult::failure(format!("subagent {id} is still running"));
        }

        let initial = match self.load_record(id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };
        let child_credential_vault = self
            .runtime
            .credential_scope(id)
            .unwrap_or_else(|| credential_vault.fork());
        let mut request = SpawnRequest {
            task: prompt,
            role: initial.role,
            profile: initial.profile.clone(),
            profile_prompt: initial.profile_prompt.clone(),
            profile_tools: initial.profile_tools.clone(),
            model: initial.model.clone(),
            timeout_ms: initial.timeout_ms,
            max_tokens: initial.max_tokens,
            run_in_background: args
                .get("run_in_background")
                .or_else(|| args.get("runInBackground"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            isolation: initial.isolation,
            worktree_name: None,
        };
        if let Err(error) =
            apply_subagent_start_hook(&mut request, &self.cwd, &self.parent_scope_id())
        {
            return ToolResult::failure(error);
        }
        // The retained child scope may predate credentials imported into the
        // parent after the previous attempt. Resolve through the current
        // parent scope, then re-vault into the child scope before persisting
        // or launching the follow-up.
        let parent_resolved_task = credential_vault.resolve_all(&request.task);
        request.task = child_credential_vault.vault_in_text(&parent_resolved_task);
        let prompt = request.task;
        let run_in_background = request.run_in_background;
        let session_dir = Self::session_dir(&initial);
        let lease = match SessionLock::acquire(&Self::timeline_path(&initial)) {
            Ok(lease) => lease,
            Err(error) => {
                return ToolResult::failure(format!(
                    "acquire subagent {id} execution lease: {error}"
                ));
            }
        };

        // Reload under the lease. Everything above was decided from a record
        // read before the lease existed: another process can have completed a
        // full resume attempt in that window, and `cleanup` can have removed
        // the worktree. Using the pre-lease copy would rewrite the attempt
        // counter and transcript sequence backward, or relaunch into a
        // deleted directory.
        let mut record = match Self::revalidate_resumable_under_lease(self, id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };
        let previous_prompt = record.current_prompt.clone();
        let next_attempt = record.attempt.saturating_add(1);
        record.role = request.role;
        record.profile = request.profile.clone();
        record.profile_prompt = request.profile_prompt.clone();
        record.profile_tools = request.profile_tools.clone();
        record.model = request.model.clone();
        record.timeout_ms = request.timeout_ms;
        record.max_tokens = request.max_tokens;

        let mut recorder = match SessionRecorder::resume(&session_dir, id) {
            Ok(recorder) => recorder,
            Err(error) => {
                return ToolResult::failure(format!("resume subagent transcript: {error}"))
            }
        };
        let snapshot_attempt = recorder
            .semantic_conversation_attempt()
            .or(record.snapshot_attempt);
        let history = restore_history_with_prompt(
            recorder.replay().semantic_conversation,
            &previous_prompt,
            record.attempt,
            snapshot_attempt,
        );
        if let Err(error) = recorder.record_sent(&ToAgentMessage::Prompt {
            content: prompt.clone(),
            attachments: None,
        }) {
            return ToolResult::failure(format!("record subagent follow-up: {error}"));
        }
        if let Err(error) = recorder.flush_checkpoint() {
            return ToolResult::failure(format!("flush subagent follow-up: {error}"));
        }
        drop(recorder);

        record.status = SubagentStatus::Queued;
        record.current_prompt = prompt.clone();
        record.attempt = next_attempt;
        record.last_parent_scope_id = self.parent_scope_id();
        record.last_call_id = parent_call_id.to_string();
        record.started_at_ms = None;
        record.finished_at_ms = None;
        record.result = None;
        record.error = None;
        if let Err(error) = self.write_record(&record) {
            return ToolResult::failure(error);
        }

        let token = CancellationToken::new();
        self.runtime.insert(id, token.clone());
        let manager = self.clone();
        let launch_record = record.clone();
        let launch_id = id.to_string();
        let launch_error_id = id.to_string();
        let launch_policy = sandbox_policy;
        let launch_token = token.clone();
        let parent_cancel = if run_in_background {
            None
        } else {
            cancel.cloned()
        };
        self.runtime
            .set_credential_scope(id, child_credential_vault.clone());
        let parent_credential_generation = credential_vault.generation();
        let launch = ChildLaunch {
            lease: Some(lease),
            credential_vault: child_credential_vault,
            parent_credential_vault: credential_vault,
            parent_credential_generation,
            parent_cancel,
        };
        let launch = async move {
            let cancellation_link = launch.parent_cancel.clone().map(|parent| {
                let child_token = launch_token.clone();
                tokio::spawn(async move {
                    parent.cancelled().await;
                    child_token.cancel();
                })
            });
            let result = manager
                .run_child(
                    launch_record,
                    prompt,
                    history,
                    launch_policy,
                    launch_token,
                    launch,
                )
                .await;
            if let Some(cancellation_link) = cancellation_link {
                cancellation_link.abort();
            }
            manager.runtime.remove(&launch_id);
            result
        };

        if run_in_background {
            let launch_error_id = launch_error_id.clone();
            tokio::spawn(async move {
                if let Err(error) = launch.await {
                    eprintln!("subagent {launch_error_id} failed: {error}");
                }
            });
            return ToolResult::success(format!("Resumed subagent {id} in the background"))
                .with_details(record_details(&record));
        }

        match launch.await {
            Ok(record) => tool_result_for_record(record),
            Err(error) => ToolResult::failure(error),
        }
    }

    pub(crate) fn cancel(&self, args: &serde_json::Value) -> ToolResult {
        let Some(id) = subagent_id(args) else {
            return ToolResult::failure("subagent_id is required");
        };
        let record = match self.load_record(id) {
            Ok(record) => record,
            Err(error) => return ToolResult::failure(error),
        };
        if record.status.is_terminal() {
            return tool_result_for_record(record);
        }
        let Some(token) = self.runtime.get(id) else {
            return ToolResult::failure(format!(
                "subagent {id} is not running in this Maestro process; resume it to restart"
            ));
        };
        token.cancel();
        ToolResult::success(format!("Cancellation requested for subagent {id}"))
            .with_details(record_details(&record))
    }

    async fn run_child(
        &self,
        mut record: SubagentRecord,
        prompt: String,
        history: Option<Vec<crate::ai::Message>>,
        sandbox_policy: Option<SandboxPolicy>,
        token: CancellationToken,
        launch: ChildLaunch,
    ) -> Result<SubagentRecord, String> {
        let ChildLaunch {
            lease,
            credential_vault,
            parent_credential_vault,
            parent_credential_generation,
            parent_cancel: _,
        } = launch;
        let parent_credential_scope = ParentCredentialScope {
            vault: &parent_credential_vault,
            generation: parent_credential_generation,
        };
        let _permit = tokio::select! {
            biased;
            () = token.cancelled() => {
                return self.finish_record(
                    record,
                    SubagentStatus::Cancelled,
                    None,
                    Some("subagent cancelled while queued".to_string()),
                    &credential_vault,
                    &parent_credential_scope,
                );
            }
            permit = self.runtime.acquire_permit() => permit.map_err(|error| {
                format!("acquire subagent scheduler permit: {error}")
            })?,
        };
        let _lease = match lease {
            Some(lease) => lease,
            None => SessionLock::acquire(&Self::timeline_path(&record)).map_err(|error| {
                format!("acquire subagent {} execution lease: {error}", record.id)
            })?,
        };
        let child_cwd = deserialize_repository_path(&record.cwd);
        if record.attempt > 0 {
            let (initial_paths, initial_fingerprints) = changed_file_baseline(&child_cwd);
            let (initial_files, initial_file_fingerprints) =
                serialize_file_baseline(initial_paths, initial_fingerprints);
            record.initial_files = initial_files;
            record.initial_file_fingerprints = initial_file_fingerprints;
            record.initial_head = git_repository_head(&child_cwd);
        }
        record.status = SubagentStatus::Running;
        record.started_at_ms = Some(now_millis());
        self.write_record(&record)?;

        let session_dir = Self::session_dir(&record);
        let mut recorder = match SessionRecorder::resume(&session_dir, &record.id) {
            Ok(recorder) => recorder,
            Err(error) => {
                return self.finish_record(
                    record,
                    SubagentStatus::Failed,
                    None,
                    Some(format!("open child transcript: {error}")),
                    &credential_vault,
                    &parent_credential_scope,
                );
            }
        };

        let child_policy = child_sandbox_policy(record.role, sandbox_policy);
        let model = record
            .model
            .clone()
            .unwrap_or_else(crate::codex_auth::resolve_default_model);
        // Captured before `model` moves into the config below.
        let mut output_metering = ChildOutputMetering::for_model(&model);
        let system_prompt = format!(
            "You are a delegated Maestro subagent in the {} role. Work independently on the assigned task.\n\
             Working directory: {}\n\
             {}\
             Return a concise result for the parent agent, including files changed and any remaining risk.\n\
             You are a child run: do not delegate further work.",
            record.role.label(),
            child_cwd.display(),
            record
                .profile_prompt
                .as_deref()
                .map(|prompt| format!("Specialist profile instructions:\n{prompt}\n"))
                .unwrap_or_default()
        );
        let config = NativeAgentConfig {
            model,
            max_tokens: record.max_tokens,
            system_prompt: Some(system_prompt),
            thinking_enabled: false,
            thinking_budget: 0,
            cwd: child_cwd.to_string_lossy().into_owned(),
            approval_mode: ApprovalMode::Yolo,
            context_window: None,
            sandbox_policy: child_policy,
        };
        let allowed_tools =
            child_allowed_tools_for_role(record.role, record.profile_tools.as_deref());
        let (agent, mut events) =
            match NativeAgent::new_with_allowed_tools_and_credential_vault_runner(
                config,
                &allowed_tools,
                credential_vault.clone(),
            ) {
                Ok(agent) => agent,
                Err(error) => {
                    return self.finish_record(
                        record,
                        SubagentStatus::Failed,
                        None,
                        Some(format!("create child agent: {error}")),
                        &credential_vault,
                        &parent_credential_scope,
                    );
                }
            };

        if let Some(history) = history {
            agent.replace_history_preserving_credentials(history);
        }
        agent.send_ready();
        let child_cwd_display = display_repository_path(&child_cwd);
        agent.send_session_info(&child_cwd_display, Some(record.id.clone()), None);
        // Stamp the durable child id onto the runner's hook system and fire
        // SessionStart. send_session_info only emits a UI event; without this
        // every child PreToolUse/PostToolUse payload carries sessionId: null.
        if let Err(error) = agent.set_session_context(Some(record.id.clone()), "subagent_start") {
            agent.shutdown().await;
            return self.finish_record(
                record,
                SubagentStatus::Failed,
                None,
                Some(format!("set child session context: {error}")),
                &credential_vault,
                &parent_credential_scope,
            );
        }
        // Hand the whole-run allowance to the runner before the prompt that
        // spends it. The runner subtracts each response and clamps the request
        // it is about to build, so the cap does not depend on a per-response
        // update arriving before the next request is built.
        if let Err(error) = agent.set_output_token_budget(record.max_tokens) {
            agent.shutdown().await;
            return self.finish_record(
                record,
                SubagentStatus::Failed,
                None,
                Some(format!("set child output budget: {error}")),
                &credential_vault,
                &parent_credential_scope,
            );
        }
        let execution_prompt = credential_vault.resolve_all(&prompt);
        if let Err(error) = agent.prompt(execution_prompt, Vec::new()).await {
            agent.shutdown().await;
            return self.finish_record(
                record,
                SubagentStatus::Failed,
                None,
                Some(format!("start child prompt: {error}")),
                &credential_vault,
                &parent_credential_scope,
            );
        }

        let mut current_output = String::new();
        let mut last_output = String::new();
        let mut terminal_seen = false;
        let mut blocked_seen = false;
        let mut cancelled = false;
        let mut timed_out = false;
        let mut output_tokens_used = 0_u64;
        // Assistant characters streamed since the last response boundary, used
        // to charge runtimes that report no usage.
        let mut streamed_output_chars = 0_u64;
        let mut run_error = None;
        let mut recording_error = None;
        let deadline = tokio::time::sleep(Duration::from_millis(record.timeout_ms));
        tokio::pin!(deadline);

        loop {
            let event = if terminal_seen {
                tokio::time::timeout(TERMINAL_SNAPSHOT_WAIT, events.recv())
                    .await
                    .unwrap_or_default()
            } else {
                tokio::select! {
                    biased;
                    () = token.cancelled() => {
                        cancelled = true;
                        agent.cancel();
                        break;
                    }
                    () = &mut deadline => {
                        timed_out = true;
                        agent.cancel();
                        break;
                    }
                    event = events.recv() => event,
                }
            };

            let Some(event) = event else {
                if !terminal_seen && !cancelled && run_error.is_none() {
                    run_error =
                        Some("child agent event stream ended before completion".to_string());
                }
                break;
            };

            if let Err(error) = persist_child_event(
                &mut recorder,
                &event,
                &record.id,
                &credential_vault,
                record.attempt,
            ) {
                recording_error = Some(format!("persist child event: {error}"));
                agent.cancel();
                break;
            }

            match event {
                // The post-terminal snapshot is the last event this loop waits
                // for; an earlier snapshot carries nothing it needs, so it
                // falls through to the catch-all arm.
                FromAgent::ConversationSnapshot { .. } if terminal_seen => {
                    break;
                }
                FromAgent::ResponseChunk {
                    content,
                    is_thinking,
                    ..
                } => {
                    // Thinking text is billed as output too, so it counts
                    // against the budget even though it is not the child's
                    // answer.
                    streamed_output_chars =
                        streamed_output_chars.saturating_add(content.chars().count() as u64);
                    if !is_thinking {
                        current_output.push_str(&content);
                    }
                    // Only an unmetered runtime is policed mid-stream. A
                    // metered one is bounded per request by the runner's clamp
                    // and charged exactly at the boundary, so estimating here
                    // could only cancel a response the budget still allowed.
                    if output_metering.enforces_mid_stream()
                        && child_output_budget_exhausted(
                            output_tokens_used,
                            streamed_output_chars,
                            record.max_tokens,
                        )
                    {
                        run_error = Some(format!(
                            "subagent exhausted its cumulative {} output-token budget",
                            record.max_tokens
                        ));
                        agent.cancel();
                        break;
                    }
                }
                FromAgent::ResponseEnd { response_id, usage } => {
                    let budget_exhausted = record_child_output_tokens(
                        &mut output_tokens_used,
                        usage.as_ref(),
                        output_metering.estimate_for_turn(usage.is_some(), streamed_output_chars),
                        record.max_tokens,
                    );
                    streamed_output_chars = 0;
                    if budget_exhausted && response_id != "done" && response_id != "blocked" {
                        run_error = Some(format!(
                            "subagent exhausted its cumulative {} output-token budget",
                            record.max_tokens
                        ));
                        agent.cancel();
                        break;
                    }
                    if response_id == "done" || response_id == "blocked" {
                        blocked_seen = response_id == "blocked";
                        terminal_seen = true;
                    } else {
                        if !current_output.is_empty() {
                            last_output.clone_from(&current_output);
                            current_output.clear();
                        }
                        // A non-terminal response boundary means a previous
                        // recoverable tool error did not prevent progress.
                        run_error = None;
                        // The next request's allowance needs no update here:
                        // the runner holds the whole-run budget sent before the
                        // prompt and clamps each request it builds. Lowering it
                        // from this loop raced the request the child had
                        // already started building.
                    }
                }
                FromAgent::ToolCall {
                    call_id,
                    tool,
                    requires_approval: true,
                    ..
                } => {
                    let reason = format!(
                        "child tool `{tool}` requires approval, which delegated runs cannot request"
                    );
                    let _ = agent.tool_response_sender().send((
                        call_id,
                        false,
                        Some(ToolResult::failure(reason.clone())),
                        crate::agent::ExecutionSource::Native,
                        None,
                    ));
                    run_error = Some(reason);
                    agent.cancel();
                    break;
                }
                FromAgent::CodexNativeOperation {
                    method,
                    output_chars,
                } => {
                    // Codex runs `commandExecution` and `fileChange` itself, so
                    // these never arrive as `ToolCall`. Without this arm a child
                    // could run repeated large native operations with no
                    // assistant text and never reach its budget.
                    let _ = method;
                    streamed_output_chars = streamed_output_chars.saturating_add(output_chars);
                    if output_metering.enforces_mid_stream()
                        && child_output_budget_exhausted(
                            output_tokens_used,
                            streamed_output_chars,
                            record.max_tokens,
                        )
                    {
                        run_error = Some(format!(
                            "subagent exhausted its cumulative {} output-token budget",
                            record.max_tokens
                        ));
                        agent.cancel();
                        break;
                    }
                }
                FromAgent::ToolCall { tool, args, .. } => {
                    // A tool call is model-produced output even though it never
                    // arrives as assistant text. Counting only `ResponseChunk`
                    // let a child emit large `write`/`edit` arguments, or call
                    // tools with no prose at all, and never reach its budget;
                    // the time limit was the only thing that stopped it.
                    streamed_output_chars =
                        streamed_output_chars.saturating_add(tool_call_output_chars(&tool, &args));
                    if output_metering.enforces_mid_stream()
                        && child_output_budget_exhausted(
                            output_tokens_used,
                            streamed_output_chars,
                            record.max_tokens,
                        )
                    {
                        run_error = Some(format!(
                            "subagent exhausted its cumulative {} output-token budget",
                            record.max_tokens
                        ));
                        agent.cancel();
                        break;
                    }
                }
                FromAgent::Error { message, fatal } => {
                    run_error = Some(message);
                    if fatal {
                        break;
                    }
                }
                _ => {}
            }
        }

        if token.is_cancelled() {
            cancelled = true;
            agent.cancel();
        }
        agent.shutdown().await;
        if let Err(error) = drain_child_events(
            &mut recorder,
            &mut events,
            &record.id,
            &credential_vault,
            record.attempt,
        ) {
            recording_error = Some(format!("persist shutdown child event: {error}"));
        }
        let checkpoint_flushed = match recorder.flush_checkpoint() {
            Ok(()) => true,
            Err(error) => {
                recording_error = Some(format!("flush child transcript: {error}"));
                false
            }
        };
        if checkpoint_flushed {
            if let Some(snapshot_attempt) = recorder.semantic_conversation_attempt() {
                record.snapshot_attempt = Some(snapshot_attempt);
            }
        }

        let output = if current_output.is_empty() {
            last_output
        } else {
            current_output
        };
        let output = credential_vault.vault_in_text(&output);
        let files_modified = changed_files_since(
            &child_cwd,
            record.initial_head.as_deref(),
            &record.initial_files,
            &record.initial_file_fingerprints,
        );
        let (status, error) = if cancelled {
            (
                SubagentStatus::Cancelled,
                Some("subagent cancelled".to_string()),
            )
        } else if timed_out {
            (
                SubagentStatus::TimedOut,
                Some(format!(
                    "subagent exceeded its {} ms execution budget",
                    record.timeout_ms
                )),
            )
        } else if blocked_seen {
            (
                SubagentStatus::Failed,
                Some(run_error.unwrap_or_else(|| "child prompt was blocked by a hook".to_string())),
            )
        } else if let Some(error) = recording_error.or(run_error) {
            (SubagentStatus::Failed, Some(error))
        } else {
            (SubagentStatus::Completed, None)
        };
        self.finish_record(
            record,
            status,
            Some(SubagentResult {
                output,
                files_modified,
            }),
            error,
            &credential_vault,
            &parent_credential_scope,
        )
    }

    fn finish_record(
        &self,
        mut record: SubagentRecord,
        status: SubagentStatus,
        result: Option<SubagentResult>,
        error: Option<String>,
        credential_vault: &CredentialVault,
        parent_credential_scope: &ParentCredentialScope<'_>,
    ) -> Result<SubagentRecord, String> {
        record.status = status;
        let finished_at_ms = now_millis();
        record.finished_at_ms = Some(finished_at_ms);
        let vaulted_result = result.map(|mut result| {
            result.output = credential_vault.vault_in_text(&result.output);
            result
        });
        let vaulted_error = error.map(|error| credential_vault.vault_in_text(&error));
        let credential_reference_map = parent_credential_scope
            .vault
            .absorb_child_credentials_at_generation(
                credential_vault,
                parent_credential_scope.generation,
            );
        record.result = vaulted_result.map(|mut result| {
            result.output =
                CredentialVault::translate_references(&result.output, &credential_reference_map);
            result
        });
        record.error = vaulted_error
            .map(|error| CredentialVault::translate_references(&error, &credential_reference_map));

        let duration_ms = record
            .started_at_ms
            .map(|started_at_ms| finished_at_ms.saturating_sub(started_at_ms))
            .unwrap_or_default();
        let result_text = record.result.as_ref().map(|result| result.output.as_str());
        let mut hooks = IntegratedHookSystem::load_from_config(&self.cwd.to_string_lossy());
        // Local load skips the runner's SetSessionContext wiring, so stamp the
        // raw parent session id (not the `session:` routing scope) before
        // dispatching so payloads match every other hook in that session.
        let hook_session =
            crate::agent::ParentScopeId::from_raw(&record.last_parent_scope_id).hook_session_id();
        hooks.set_session_id(Some(hook_session.into_string()));
        let _ = hooks.execute_subagent_stop(
            record.role.label(),
            &record.id,
            result_text,
            duration_ms,
            status == SubagentStatus::Completed,
        );
        // Address the completion to the scope and call that most recently
        // launched this child, not the original spawn. After a resume from a
        // different app or executor — the restart case — the spawning scope no
        // longer has a consumer, so an event queued under it is never polled
        // and the current parent never learns the child finished.
        let event = SubagentLifecycleEvent {
            subagent_id: record.id.clone(),
            parent_scope_id: record.last_parent_scope_id.clone(),
            parent_call_id: record.last_call_id.clone(),
            status,
            summary: record
                .result
                .as_ref()
                .map(|result| result.output.trim().chars().take(500).collect::<String>()),
            error: record.error.clone(),
            finished_at_ms,
        };
        match self.write_record(&record) {
            Ok(()) => {
                self.runtime.push_event(event);
                Ok(record)
            }
            Err(error) => Err(format!(
                "persist terminal subagent record {}: {error}",
                record.id
            )),
        }
    }
}

fn default_root(cwd: &Path) -> PathBuf {
    let base = std::env::var_os("MAESTRO_SUBAGENTS_DIR")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let base = if std::env::var_os("MAESTRO_SUBAGENTS_DIR").is_some() {
        base
    } else {
        base.join(".maestro").join("subagents")
    };
    let canonical_cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let canonical_cwd_string = canonical_cwd.to_string_lossy();
    let digest = Sha256::digest(canonical_cwd_string.as_bytes());
    let digest = format!("{digest:x}");
    base.join(format!(
        "--{}-{}--",
        sanitize_path_for_dirname(&canonical_cwd_string),
        &digest[..16]
    ))
}

fn parse_spawn_request(args: &serde_json::Value) -> Result<SpawnRequest, String> {
    let task = args
        .get("task")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|task| !task.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "task is required to spawn a subagent".to_string())?;
    if task.len() > MAX_TASK_BYTES {
        return Err(format!(
            "subagent task exceeds the {} byte limit",
            MAX_TASK_BYTES
        ));
    }

    let role = SubagentRole::parse(args.get("role").and_then(serde_json::Value::as_str))?;
    let profile = args
        .get("profile")
        .or_else(|| args.get("agent_profile"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|profile| !profile.is_empty())
        .map(str::to_ascii_lowercase);
    let isolation =
        SubagentIsolation::parse(args.get("isolation").and_then(serde_json::Value::as_str))?;
    let model = args
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let timeout_ms = parse_child_timeout(args)?;
    let max_tokens = parse_child_max_tokens(args)?;
    let run_in_background = args
        .get("run_in_background")
        .or_else(|| args.get("runInBackground"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let worktree_name = args
        .get("worktree_name")
        .or_else(|| args.get("worktreeName"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);

    Ok(SpawnRequest {
        task,
        role,
        profile,
        profile_prompt: None,
        profile_tools: None,
        model,
        timeout_ms,
        max_tokens,
        run_in_background,
        isolation,
        worktree_name,
    })
}

fn default_child_timeout_ms() -> u64 {
    DEFAULT_CHILD_TIMEOUT_MS
}

fn default_child_max_tokens() -> u32 {
    DEFAULT_CHILD_MAX_TOKENS
}

fn parse_child_timeout(args: &serde_json::Value) -> Result<u64, String> {
    let Some(value) = args.get("timeout_ms").or_else(|| args.get("timeoutMs")) else {
        return Ok(DEFAULT_CHILD_TIMEOUT_MS);
    };
    let timeout_ms = value
        .as_u64()
        .ok_or_else(|| "timeout_ms must be a positive integer".to_string())?;
    if timeout_ms == 0 {
        return Err("timeout_ms must be a positive integer".to_string());
    }
    Ok(timeout_ms.min(MAX_CHILD_TIMEOUT_MS))
}

fn parse_child_max_tokens(args: &serde_json::Value) -> Result<u32, String> {
    let Some(value) = args.get("max_tokens").or_else(|| args.get("maxTokens")) else {
        return Ok(DEFAULT_CHILD_MAX_TOKENS);
    };
    let max_tokens = value
        .as_u64()
        .ok_or_else(|| "max_tokens must be a positive integer".to_string())?;
    if max_tokens == 0 {
        return Err("max_tokens must be a positive integer".to_string());
    }
    Ok(max_tokens.min(u64::from(MAX_CHILD_MAX_TOKENS)) as u32)
}

fn resolve_spawn_profile(request: &mut SpawnRequest, cwd: &Path) -> Result<(), String> {
    let Some(profile_name) = request.profile.as_deref() else {
        return Ok(());
    };
    let plugin_registry = crate::plugins::PluginRegistry::discover_for_workspace(cwd);
    let agent_dirs = plugin_registry.agent_dirs();
    let profiles = crate::agents_cli::profiles_for_workspace_with_agent_dirs(cwd, &agent_dirs)
        .map_err(|error| format!("load agent profiles: {error}"))?;
    let Some(profile) = profiles
        .into_iter()
        .find(|profile| profile.name == profile_name)
    else {
        return Err(format!("agent profile `{profile_name}` was not found"));
    };
    request.profile = Some(profile.name);
    request.profile_prompt = Some(profile.prompt);
    request.profile_tools = profile.tools;
    if request.model.is_none() {
        request.model = profile.model;
    }
    Ok(())
}

fn fallback_history_from_prompt(prompt: &str) -> Option<Vec<crate::ai::Message>> {
    let prompt = prompt.trim();
    (!prompt.is_empty()).then(|| {
        vec![crate::ai::Message {
            role: crate::ai::Role::User,
            content: crate::ai::MessageContent::text(prompt),
        }]
    })
}

fn restore_history_with_prompt(
    history: Option<Vec<crate::ai::Message>>,
    prompt: &str,
    attempt: u32,
    snapshot_attempt: Option<u32>,
) -> Option<Vec<crate::ai::Message>> {
    let Some(fallback) = fallback_history_from_prompt(prompt) else {
        return history;
    };
    if snapshot_attempt == Some(attempt) {
        return history.or(Some(fallback));
    }
    match history {
        Some(mut history) => {
            history.extend(fallback);
            Some(history)
        }
        None => Some(fallback),
    }
}

fn subagent_id(args: &serde_json::Value) -> Option<&str> {
    args.get("subagent_id")
        .or_else(|| args.get("subagentId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn parse_wait_timeout(args: &serde_json::Value) -> Result<u64, String> {
    let Some(value) = args.get("timeout_ms").or_else(|| args.get("timeoutMs")) else {
        return Ok(0);
    };
    value
        .as_u64()
        .map(|timeout_ms| timeout_ms.min(MAX_WAIT_MS))
        .ok_or_else(|| "timeout_ms must be a non-negative integer".to_string())
}

const READ_ONLY_CHILD_TOOLS: [&str; 21] = [
    "read",
    "glob",
    "grep",
    "list",
    "diff",
    "status",
    "parallel_ripgrep",
    "search",
    "web_fetch",
    "websearch",
    "codesearch",
    "read_image",
    "screenshot",
    "vscode_get_diagnostics",
    "jetbrains_get_diagnostics",
    "vscode_get_definition",
    "jetbrains_get_definition",
    "vscode_find_references",
    "jetbrains_find_references",
    "mcp_list_resources",
    "mcp_read_resource",
];

fn child_allowed_tools_for_role(
    role: SubagentRole,
    profile_tools: Option<&[String]>,
) -> HashSet<String> {
    let mut tools = ToolRegistry::new()
        .tools()
        .filter(|definition| {
            let name = definition.tool.name.to_ascii_lowercase();
            let globally_allowed = !SUBAGENT_TOOL_NAMES.contains(&name.as_str())
                && !matches!(
                    name.as_str(),
                    "get_goal" | "update_goal" | "todo" | "background_tasks"
                );
            let role_allowed = matches!(role, SubagentRole::Code)
                || READ_ONLY_CHILD_TOOLS.contains(&name.as_str());
            globally_allowed && role_allowed
        })
        .map(|definition| definition.tool.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    if let Some(profile_tools) = profile_tools {
        let requested = profile_tools
            .iter()
            .map(|name| name.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        tools.retain(|name| requested.contains(name));
    }
    tools
}

fn git_worktree_command<const N: usize>(
    cwd: &Path,
    args: [&str; N],
    appended_path: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd);
    if let Some(path) = appended_path {
        command.arg(path);
    }
    command.output().map_err(|error| {
        format!(
            "run git {}: {error}",
            command.get_program().to_string_lossy()
        )
    })
}

fn git_worktree_is_registered(cwd: &Path, path: &Path) -> bool {
    let Ok(output) = git_worktree_command(cwd, ["worktree", "list", "--porcelain"], None) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(Path::new)
        .any(|candidate| candidate == path)
}

fn apply_subagent_start_hook(
    request: &mut SpawnRequest,
    cwd: &Path,
    parent_scope_id: &str,
) -> Result<(), String> {
    let mut hooks = IntegratedHookSystem::load_from_config(&cwd.to_string_lossy());
    // Local load skips the runner's SetSessionContext wiring, so stamp the
    // raw parent session id (not the `session:` routing scope) before
    // dispatching so payloads match every other hook in that session.
    let hook_session = crate::agent::ParentScopeId::from_raw(parent_scope_id).hook_session_id();
    hooks.set_session_id(Some(hook_session.into_string()));
    match hooks.execute_subagent_start(request.role.label(), &request.task, Some(parent_scope_id)) {
        HookResult::Continue => Ok(()),
        HookResult::Block { reason } => Err(format!("subagent spawn blocked by hook: {reason}")),
        HookResult::ModifyInput { new_input } => {
            match new_input {
                serde_json::Value::String(task) => request.task = task,
                serde_json::Value::Object(input) => {
                    if let Some(task) = input.get("task").and_then(serde_json::Value::as_str) {
                        request.task = task.to_string();
                    }
                    if let Some(role) = input.get("role").and_then(serde_json::Value::as_str) {
                        request.role = SubagentRole::parse(Some(role))?;
                    }
                }
                _ => return Err("subagent start hook returned an invalid input".to_string()),
            }
            Ok(())
        }
        HookResult::InjectContext { context } => {
            if !context.trim().is_empty() {
                request.task = format!("{}\n\nAdditional context:\n{}", request.task, context);
            }
            Ok(())
        }
    }?;

    request.task = request.task.trim().to_string();
    if request.task.is_empty() {
        return Err("subagent start hook returned an empty task".to_string());
    }
    if request.task.len() > MAX_TASK_BYTES {
        return Err(format!(
            "subagent task exceeds the {} byte limit after hook modification",
            MAX_TASK_BYTES
        ));
    }
    Ok(())
}

/// Sandbox policy for a child in `role`, given the parent's `policy`.
///
/// A role that is not allowed to mutate gets [`SandboxPolicy::ReadOnly`]
/// outright rather than inheriting the parent's. Restricting the advertised
/// tool list is not enough on its own: on the Codex app-server transport the
/// child also reaches native `commandExecution` and `fileChange` operations,
/// which never pass through the Maestro tool registry, and with
/// `isolation=shared` those act on the parent's own checkout. The policy is
/// what both transports enforce against, so it is where the role has to be
/// expressed.
fn child_sandbox_policy(
    role: SubagentRole,
    policy: Option<SandboxPolicy>,
) -> Option<SandboxPolicy> {
    if !role.can_mutate() {
        return Some(SandboxPolicy::ReadOnly);
    }
    match policy {
        Some(SandboxPolicy::WorkspaceWrite {
            writable_roots,
            network_access,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
        }) => Some(SandboxPolicy::WorkspaceWrite {
            writable_roots,
            network_access,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
        }),
        other => other,
    }
}

fn worktree_setup_allowed(policy: Option<&SandboxPolicy>) -> bool {
    matches!(policy, None | Some(SandboxPolicy::DangerFullAccess))
}

fn path_from_git_bytes(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(OsString::from(String::from_utf8_lossy(bytes).into_owned()))
    }
}

fn changed_files(cwd: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(cwd)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let path = &record[3..];
        if path.is_empty() {
            continue;
        }
        files.push(path_from_git_bytes(path));

        let status = &record[..2];
        if status.contains(&b'R') || status.contains(&b'C') {
            if let Some(previous) = records.next().filter(|path| !path.is_empty()) {
                files.push(path_from_git_bytes(previous));
            }
        }
    }
    files.sort();
    files.dedup();
    files
}

fn changed_file_fingerprints(cwd: &Path) -> HashMap<PathBuf, String> {
    let repository_root = git_repository_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let paths = changed_files(cwd);
    let index_fingerprints = git_index_fingerprints(&repository_root);
    paths
        .into_iter()
        .map(|path| {
            let index_fingerprint = index_fingerprints
                .get(&path)
                .map(String::as_str)
                .unwrap_or_default();
            let fingerprint = fingerprint_file(&repository_root, &path, index_fingerprint);
            (path, fingerprint)
        })
        .collect()
}

fn changed_file_baseline(cwd: &Path) -> (Vec<PathBuf>, HashMap<PathBuf, String>) {
    let fingerprints = changed_file_fingerprints(cwd);
    let mut files = fingerprints.keys().cloned().collect::<Vec<_>>();
    files.sort();
    (files, fingerprints)
}

fn serialize_file_baseline(
    paths: Vec<PathBuf>,
    fingerprints: HashMap<PathBuf, String>,
) -> (Vec<String>, HashMap<String, String>) {
    let paths = paths
        .into_iter()
        .map(|path| serialize_repository_path(&path))
        .collect();
    let fingerprints = fingerprints
        .into_iter()
        .map(|(path, fingerprint)| (serialize_repository_path(&path), fingerprint))
        .collect();
    (paths, fingerprints)
}

// The leading NUL cannot occur in a Unix filename, so this stays
// unambiguous with legacy records that stored UTF-8 paths directly.
const SERIALIZED_PATH_PREFIX: &str = "\0maestro-path-v1:";

fn serialize_repository_path(path: &Path) -> String {
    #[cfg(unix)]
    let bytes = path.as_os_str().as_bytes().to_vec();
    #[cfg(not(unix))]
    let bytes = path.to_string_lossy().into_owned().into_bytes();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing path bytes to a string cannot fail");
    }
    format!("{SERIALIZED_PATH_PREFIX}{encoded}")
}

fn deserialize_repository_path(serialized: &str) -> PathBuf {
    let Some(encoded) = serialized.strip_prefix(SERIALIZED_PATH_PREFIX) else {
        return PathBuf::from(serialized);
    };
    if encoded.len() % 2 != 0 {
        return PathBuf::from(serialized);
    }
    let Some(bytes) = (0..encoded.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&encoded[offset..offset + 2], 16).ok())
        .collect::<Option<Vec<_>>>()
    else {
        return PathBuf::from(serialized);
    };
    #[cfg(unix)]
    {
        PathBuf::from(OsString::from_vec(bytes))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(OsString::from(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

fn display_repository_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn git_repository_root(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?;
    let root = root.trim();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

fn git_repository_head(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8(output.stdout).ok()?;
    let head = head.trim();
    (!head.is_empty()).then(|| head.to_string())
}

fn fingerprint_file(
    repository_root: &Path,
    relative_path: &Path,
    index_fingerprint: &str,
) -> String {
    let path = repository_root.join(relative_path);
    let mut hasher = Sha256::new();
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            hasher.update(b"symlink:");
            update_file_mode(&mut hasher, &metadata);
            match std::fs::read_link(&path) {
                Ok(target) => hasher.update(target.to_string_lossy().as_bytes()),
                Err(_) => hasher.update(b"<unreadable>"),
            }
        }
        Ok(metadata) if metadata.is_file() => {
            hasher.update(b"file:");
            update_file_mode(&mut hasher, &metadata);
            match std::fs::read(&path) {
                Ok(contents) => hasher.update(contents),
                Err(_) => hasher.update(b"<unreadable>"),
            }
        }
        Ok(metadata) => {
            hasher.update(b"other:");
            update_file_mode(&mut hasher, &metadata);
            hasher.update(format!("{:?}", metadata.file_type()).as_bytes());
        }
        Err(_) => hasher.update(b"missing"),
    }
    hasher.update(b"\nindex:");
    hasher.update(index_fingerprint.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn update_file_mode(hasher: &mut Sha256, metadata: &std::fs::Metadata) {
    hasher.update(b"mode:");
    #[cfg(unix)]
    hasher.update((metadata.permissions().mode() & 0o7777).to_le_bytes());
    #[cfg(not(unix))]
    {
        let _ = metadata;
        hasher.update(b"unsupported");
    }
}

fn git_index_records(repository_root: &Path, stage: bool) -> Vec<(PathBuf, Vec<u8>)> {
    let args = if stage {
        ["ls-files", "--stage", "--full-name", "-z", "--"]
    } else {
        ["ls-files", "-v", "--full-name", "-z", "--"]
    };
    let Ok(output) = Command::new("git")
        .args(args)
        .current_dir(repository_root)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|record| {
            if record.is_empty() {
                return None;
            }
            if stage {
                let separator = record.iter().position(|byte| *byte == b'\t')?;
                let path = record.get(separator + 1..)?;
                Some((path_from_git_bytes(path), record[..separator].to_vec()))
            } else {
                Some((
                    path_from_git_bytes(record.get(2..)?),
                    record.get(..2)?.to_vec(),
                ))
            }
        })
        .collect()
}

fn git_index_fingerprints(repository_root: &Path) -> HashMap<PathBuf, String> {
    let mut stage = HashMap::<PathBuf, Vec<u8>>::new();
    for (path, metadata) in git_index_records(repository_root, true) {
        let entry = stage.entry(path).or_default();
        entry.extend_from_slice(&metadata);
        entry.push(0);
    }
    let mut flags = HashMap::<PathBuf, Vec<u8>>::new();
    for (path, metadata) in git_index_records(repository_root, false) {
        let entry = flags.entry(path).or_default();
        entry.extend_from_slice(&metadata);
        entry.push(0);
    }

    stage
        .keys()
        .chain(flags.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|path| {
            let mut hasher = Sha256::new();
            hasher.update(b"stage:");
            if let Some(value) = stage.get(&path) {
                hasher.update(value);
            }
            hasher.update([0]);
            hasher.update(b"flags:");
            if let Some(value) = flags.get(&path) {
                hasher.update(value);
            }
            (path, format!("{:x}", hasher.finalize()))
        })
        .collect()
}

fn committed_files_since(cwd: &Path, initial_head: Option<&str>) -> Vec<PathBuf> {
    let Some(initial_head) = initial_head else {
        return Vec::new();
    };
    let Some(current_head) = git_repository_head(cwd) else {
        return Vec::new();
    };
    if initial_head == current_head {
        return Vec::new();
    }

    let repository_root = git_repository_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let range = format!("{initial_head}..{current_head}");
    let output = Command::new("git")
        .args(["diff", "--name-only", "-z"])
        .arg(range)
        .arg("--")
        .current_dir(repository_root)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(path_from_git_bytes)
        .collect()
}

fn changed_files_since(
    cwd: &Path,
    initial_head: Option<&str>,
    initial_files: &[String],
    initial_file_fingerprints: &HashMap<String, String>,
) -> Vec<String> {
    let mut changed = if initial_file_fingerprints.is_empty() {
        let initial = initial_files
            .iter()
            .map(|path| deserialize_repository_path(path))
            .collect::<HashSet<_>>();
        changed_files(cwd)
            .into_iter()
            .filter(|path| !initial.contains(path))
            .collect::<Vec<_>>()
    } else {
        let initial_file_fingerprints = initial_file_fingerprints
            .iter()
            .map(|(path, fingerprint)| (deserialize_repository_path(path), fingerprint.clone()))
            .collect::<HashMap<_, _>>();
        let current_file_fingerprints = changed_file_fingerprints(cwd);
        let paths = initial_file_fingerprints
            .keys()
            .chain(current_file_fingerprints.keys())
            .cloned()
            .collect::<HashSet<_>>();
        paths
            .into_iter()
            .filter(|path| {
                initial_file_fingerprints.get(path) != current_file_fingerprints.get(path)
            })
            .collect::<Vec<_>>()
    };
    changed.extend(committed_files_since(cwd, initial_head));
    changed.sort();
    changed.dedup();
    changed
        .into_iter()
        .map(|path| display_repository_path(&path))
        .collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn status_label(status: SubagentStatus) -> &'static str {
    match status {
        SubagentStatus::Queued => "queued",
        SubagentStatus::Running => "running",
        SubagentStatus::Completed => "completed",
        SubagentStatus::Failed => "failed",
        SubagentStatus::Cancelled => "cancelled",
        SubagentStatus::TimedOut => "timed_out",
        SubagentStatus::Interrupted => "interrupted",
    }
}

fn record_details(record: &SubagentRecord) -> serde_json::Value {
    let cwd = deserialize_repository_path(&record.cwd);
    let worktree_path = record
        .worktree_path
        .as_deref()
        .map(deserialize_repository_path)
        .map(|path| display_repository_path(&path));
    let session_dir = SubagentManager::session_dir(record);
    let timeline_path = SubagentManager::timeline_path(record);
    serde_json::json!({
        "subagentId": record.id,
        "childSessionId": record.id,
        "parentScopeId": record.parent_scope_id,
        "parentCallId": record.parent_call_id,
        "lastParentScopeId": record.last_parent_scope_id,
        "lastCallId": record.last_call_id,
        "task": record.task,
        "currentPrompt": record.current_prompt,
        "role": record.role,
        "profile": record.profile,
        "model": record.model,
        "timeoutMs": record.timeout_ms,
        "maxTokens": record.max_tokens,
        "isolation": record.isolation,
        "cwd": display_repository_path(&cwd),
        "worktreePath": worktree_path,
        "worktreeCleaned": record.worktree_cleaned,
        "sessionDir": display_repository_path(&session_dir),
        "timelinePath": display_repository_path(&timeline_path),
        "status": record.status,
        "attempt": record.attempt,
        "snapshotAttempt": record.snapshot_attempt,
        "createdAtMs": record.created_at_ms,
        "startedAtMs": record.started_at_ms,
        "finishedAtMs": record.finished_at_ms,
        "result": record.result,
        "error": record.error,
        "recoverable": matches!(
            record.status,
            SubagentStatus::Queued
                | SubagentStatus::Running
                | SubagentStatus::TimedOut
                | SubagentStatus::Interrupted
        )
    })
}

fn tool_result_for_record(record: SubagentRecord) -> ToolResult {
    let details = record_details(&record);
    let status = status_label(record.status);
    let output = record
        .result
        .as_ref()
        .map(|result| result.output.trim().to_string())
        .filter(|output| !output.is_empty())
        .unwrap_or_else(|| format!("Subagent {} is {status}", record.id));
    if matches!(
        record.status,
        SubagentStatus::Failed
            | SubagentStatus::Cancelled
            | SubagentStatus::TimedOut
            | SubagentStatus::Interrupted
    ) {
        ToolResult::failure(
            record
                .error
                .clone()
                .unwrap_or_else(|| format!("Subagent {} failed", record.id)),
        )
        .with_details(details)
    } else {
        ToolResult::success(output).with_details(details)
    }
}

fn cancelled_result(message: &str) -> ToolResult {
    ToolResult::failure(message).with_details(serde_json::json!({
        "cancelled": true,
        "retryable": true
    }))
}

fn child_event_to_headless(event: &FromAgent, session_id: &str) -> Option<FromAgentMessage> {
    match event {
        FromAgent::ConversationSnapshot {
            protocol_version,
            messages,
        } => Some(FromAgentMessage::ConversationSnapshot {
            protocol_version: protocol_version.clone(),
            messages: messages.clone(),
        }),
        FromAgent::Ready { model, provider } => Some(FromAgentMessage::Ready {
            protocol_version: Some(crate::headless::HEADLESS_PROTOCOL_VERSION.to_string()),
            model: model.clone(),
            provider: provider.clone(),
            session_id: Some(session_id.to_string()),
        }),
        FromAgent::ResponseStart { response_id } => Some(FromAgentMessage::ResponseStart {
            response_id: response_id.clone(),
        }),
        FromAgent::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } if !is_thinking => Some(FromAgentMessage::ResponseChunk {
            response_id: response_id.clone(),
            content: content.clone(),
            is_thinking: false,
        }),
        FromAgent::ResponseEnd { response_id, usage } => Some(FromAgentMessage::ResponseEnd {
            response_id: response_id.clone(),
            usage: usage.as_ref().map(convert_usage),
            tools_summary: None,
            duration_ms: None,
            ttft_ms: None,
        }),
        FromAgent::ToolCall {
            call_id,
            tool,
            args,
            requires_approval,
            ..
        } => Some(FromAgentMessage::ToolCall {
            call_id: call_id.clone(),
            tool_execution_id: None,
            tool: tool.clone(),
            args: args.clone(),
            requires_approval: *requires_approval,
        }),
        FromAgent::ToolStart { call_id } => Some(FromAgentMessage::ToolStart {
            call_id: call_id.clone(),
        }),
        FromAgent::ToolOutput { call_id, content } => Some(FromAgentMessage::ToolOutput {
            call_id: call_id.clone(),
            content: content.clone(),
        }),
        FromAgent::ToolEnd {
            call_id,
            success,
            result,
            receipt,
        } => Some(FromAgentMessage::ToolEnd {
            call_id: call_id.clone(),
            tool_execution_id: None,
            success: *success,
            tool: None,
            details: result.as_ref().and_then(|result| result.details.clone()),
            receipt: receipt.clone(),
        }),
        FromAgent::Error { message, fatal } => Some(FromAgentMessage::Error {
            request_id: None,
            message: message.clone(),
            fatal: *fatal,
            error_type: None,
        }),
        FromAgent::CodexNativeDecision { method, decision } => {
            Some(FromAgentMessage::Status {
                message: format!(
                    "Codex approval receipt: method={method} decision={decision}"
                ),
            })
        }
        FromAgent::CodexTransportReceipt {
            provider,
            transport,
            outcome,
            transport_restarted,
            auth_resumed,
            cancellation_requested,
        } => Some(FromAgentMessage::Status {
            message: format!(
                "Codex transport receipt: provider={provider} transport={transport} outcome={outcome} restarted={transport_restarted} auth_resumed={auth_resumed} cancellation_requested={cancellation_requested}"
            ),
        }),
        FromAgent::Status { message } => Some(FromAgentMessage::Status {
            message: message.clone(),
        }),
        FromAgent::Compaction {
            summary,
            first_kept_entry_index,
            tokens_before,
            auto,
            custom_instructions,
            continuation,
            timestamp,
        } => Some(FromAgentMessage::Compaction {
            summary: summary.clone(),
            first_kept_entry_index: *first_kept_entry_index,
            tokens_before: *tokens_before,
            auto: *auto,
            custom_instructions: custom_instructions.clone(),
            continuation: continuation.clone(),
            timestamp: timestamp.clone(),
        }),
        FromAgent::SessionInfo {
            session_id: child_session_id,
            cwd,
            git_branch,
        } => Some(FromAgentMessage::SessionInfo {
            session_id: child_session_id
                .clone()
                .or_else(|| Some(session_id.to_string())),
            cwd: cwd.clone(),
            git_branch: git_branch.clone(),
        }),
        _ => None,
    }
}

fn persist_child_event(
    recorder: &mut SessionRecorder,
    event: &FromAgent,
    session_id: &str,
    credential_vault: &CredentialVault,
    snapshot_attempt: u32,
) -> Result<(), String> {
    let Some(message) = child_event_to_headless(event, session_id) else {
        return Ok(());
    };
    let message = vault_headless_message(&message, credential_vault)
        .map_err(|error| format!("vault child event: {error}"))?;
    recorder
        .record_received_preserving_credential_references_with_snapshot_attempt(
            &message,
            Some(snapshot_attempt),
        )
        .map_err(|error| format!("persist child event: {error}"))
}

fn drain_child_events(
    recorder: &mut SessionRecorder,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<FromAgent>,
    session_id: &str,
    credential_vault: &CredentialVault,
    snapshot_attempt: u32,
) -> Result<(), String> {
    while let Ok(event) = events.try_recv() {
        persist_child_event(
            recorder,
            &event,
            session_id,
            credential_vault,
            snapshot_attempt,
        )?;
    }
    Ok(())
}

fn vault_headless_message(
    message: &FromAgentMessage,
    credential_vault: &CredentialVault,
) -> Result<FromAgentMessage, String> {
    let value = serde_json::to_value(message).map_err(|error| error.to_string())?;
    let vaulted = credential_vault.vault_in_json(&value);
    serde_json::from_value(vaulted).map_err(|error| error.to_string())
}

fn convert_usage(usage: &crate::agent::TokenUsage) -> crate::headless::TokenUsage {
    crate::headless::TokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        cost: usage.cost,
        total_tokens: None,
        model_id: None,
        provider: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_request_defaults_to_isolated_background_code_agent() {
        let request = parse_spawn_request(&serde_json::json!({
            "task": "inspect the parser"
        }))
        .expect("request should parse");

        assert_eq!(request.role, SubagentRole::Code);
        assert_eq!(request.isolation, SubagentIsolation::Worktree);
        assert!(request.run_in_background);
    }

    #[test]
    fn wait_timeout_requires_a_non_negative_integer() {
        assert_eq!(parse_wait_timeout(&serde_json::json!({})), Ok(0));
        assert_eq!(
            parse_wait_timeout(&serde_json::json!({"timeout_ms": 1000})),
            Ok(1000)
        );
        assert!(parse_wait_timeout(&serde_json::json!({"timeout_ms": 1000.0})).is_err());
        assert!(parse_wait_timeout(&serde_json::json!({"timeout_ms": -1})).is_err());
    }

    #[test]
    fn spawn_budgets_are_bounded_and_have_safe_defaults() {
        let request = parse_spawn_request(&serde_json::json!({
            "task": "inspect the parser",
            "timeout_ms": 2500,
            "max_tokens": 4096
        }))
        .expect("budgeted request should parse");
        assert_eq!(request.timeout_ms, 2500);
        assert_eq!(request.max_tokens, 4096);

        assert!(parse_spawn_request(&serde_json::json!({
            "task": "inspect",
            "timeout_ms": 0
        }))
        .is_err());
        assert!(parse_spawn_request(&serde_json::json!({
            "task": "inspect",
            "max_tokens": 0
        }))
        .is_err());
    }

    #[test]
    fn child_output_budget_accumulates_across_responses() {
        let mut used_tokens = 0;
        let first = crate::agent::TokenUsage {
            output_tokens: 3,
            ..Default::default()
        };
        let second = crate::agent::TokenUsage {
            output_tokens: 2,
            ..Default::default()
        };

        assert!(!record_child_output_tokens(
            &mut used_tokens,
            Some(&first),
            None,
            5
        ));
        assert!(record_child_output_tokens(
            &mut used_tokens,
            Some(&second),
            None,
            5
        ));
        assert_eq!(used_tokens, 5);
    }

    #[test]
    fn child_output_is_estimated_when_the_runtime_reports_no_usage() {
        // The Codex app-server path emits `ResponseEnd { usage: None }`, so a
        // run under it was charged nothing and never reached its budget.
        let mut used_tokens = 0;

        assert!(
            !record_child_output_tokens(&mut used_tokens, None, Some(40), 100),
            "40 characters is about 10 tokens, well inside a 100-token budget"
        );
        assert_eq!(used_tokens, 10);

        assert!(
            record_child_output_tokens(&mut used_tokens, None, Some(400), 100),
            "an unmetered runtime must still exhaust the budget"
        );
        assert_eq!(used_tokens, 110);
    }

    #[test]
    fn exact_usage_wins_over_the_estimate() {
        let mut used_tokens = 0;
        let usage = crate::agent::TokenUsage {
            output_tokens: 3,
            ..Default::default()
        };

        assert!(!record_child_output_tokens(
            &mut used_tokens,
            Some(&usage),
            Some(4_000),
            100
        ));
        assert_eq!(
            used_tokens, 3,
            "streamed characters must be ignored when the provider reports usage"
        );
    }

    #[test]
    fn a_metered_runtime_is_never_charged_an_estimate() {
        // A metered provider that omits usage on one response must not be
        // charged a guess: it is already bounded per request by the runner's
        // clamp, and a guess can only cancel a response the budget allowed.
        let mut used_tokens = 0;

        assert!(!record_child_output_tokens(
            &mut used_tokens,
            None,
            None,
            100
        ));
        assert_eq!(used_tokens, 0);
    }

    #[test]
    fn tool_call_payloads_count_against_an_unmetered_budget() {
        // A write-heavy child emits its output as tool-call arguments, not as
        // assistant text. Counting only `ResponseChunk` left `max_tokens`
        // ineffective for exactly the children most able to do damage.
        let big_patch = "x".repeat(4_000);
        let charged = tool_call_output_chars(
            "write",
            &serde_json::json!({"path": "src/main.rs", "content": big_patch}),
        );
        assert!(
            charged > 4_000,
            "the serialized arguments must be charged, got {charged}"
        );

        let mut used_tokens = 0;
        assert!(
            record_child_output_tokens(&mut used_tokens, None, Some(charged), 100),
            "a tool-call-heavy child must reach its budget"
        );
    }

    #[test]
    fn a_tool_call_with_no_prose_is_still_charged() {
        assert!(
            tool_call_output_chars("read", &serde_json::json!({})) > 0,
            "even an argument-free call is model-produced output"
        );
    }

    #[test]
    fn read_only_child_roles_get_a_read_only_sandbox() {
        // The advertised tool list is not the only way a child acts: on the
        // Codex transport it also reaches native commandExecution and
        // fileChange, which never pass through the tool registry.
        for role in [
            SubagentRole::Explore,
            SubagentRole::Plan,
            SubagentRole::Review,
        ] {
            assert!(!role.can_mutate(), "{} must be read-only", role.label());
            assert!(
                matches!(
                    child_sandbox_policy(role, Some(SandboxPolicy::DangerFullAccess)),
                    Some(SandboxPolicy::ReadOnly)
                ),
                "{} must not inherit a writable parent policy",
                role.label()
            );
            assert!(
                matches!(
                    child_sandbox_policy(role, None),
                    Some(SandboxPolicy::ReadOnly)
                ),
                "{} must be restricted even with no parent policy",
                role.label()
            );
        }
    }

    #[test]
    fn a_code_child_still_inherits_the_parent_sandbox() {
        assert!(SubagentRole::Code.can_mutate());
        assert!(matches!(
            child_sandbox_policy(SubagentRole::Code, Some(SandboxPolicy::DangerFullAccess)),
            Some(SandboxPolicy::DangerFullAccess)
        ));
        assert!(child_sandbox_policy(SubagentRole::Code, None).is_none());
    }

    #[test]
    fn a_turn_without_usage_is_charged_the_estimate_even_on_a_metered_model() {
        // An OpenAI-compatible endpoint may omit the usage chunk on any turn.
        // Deciding by model name charged that turn nothing, so a tool-calling
        // child got its full allowance again every turn.
        let mut metering = ChildOutputMetering::for_model("openai/gpt-4o");
        assert!(
            !metering.enforces_mid_stream(),
            "a metered model is not policed mid-stream until it fails to report"
        );

        let estimate = metering.estimate_for_turn(false, 4_000);
        assert_eq!(
            estimate,
            Some(4_000),
            "a turn that reported no usage must be estimated"
        );
        assert!(
            metering.enforces_mid_stream(),
            "once a turn reports no usage the run is policed mid-stream"
        );

        let mut used_tokens = 0;
        assert!(record_child_output_tokens(
            &mut used_tokens,
            None,
            estimate,
            100
        ));
    }

    #[test]
    fn a_reported_turn_is_charged_exactly_and_not_also_estimated() {
        let mut metering = ChildOutputMetering::for_model("openai/gpt-4o");

        assert_eq!(
            metering.estimate_for_turn(true, 4_000),
            None,
            "streamed characters must not be charged on top of real usage"
        );
        assert!(
            !metering.enforces_mid_stream(),
            "a reporting provider stays unpoliced by the estimate"
        );

        let mut used_tokens = 0;
        let usage = crate::agent::TokenUsage {
            output_tokens: 7,
            ..Default::default()
        };
        assert!(!record_child_output_tokens(
            &mut used_tokens,
            Some(&usage),
            None,
            100
        ));
        assert_eq!(used_tokens, 7);
    }

    #[test]
    fn the_codex_path_is_policed_from_its_first_turn() {
        // Codex sends no per-request `max_tokens`, so an unpoliced first turn
        // has no bound at all. Every other runtime is bounded per request by
        // the runner's clamp, which is why they wait for evidence.
        let metering = ChildOutputMetering::for_model("openai-codex/gpt-5.5");
        assert!(metering.enforces_mid_stream());
    }

    #[test]
    fn only_the_codex_app_server_path_counts_as_unmetered() {
        assert!(!child_output_is_metered("openai-codex/gpt-5.5"));
        assert!(child_output_is_metered("claude-sonnet-4-5-20250514"));
        assert!(child_output_is_metered("openai/gpt-4o"));
    }

    #[test]
    fn streamed_output_exhausts_the_budget_before_the_response_boundary() {
        // Without the mid-stream check a single turn could produce far more
        // than the budget and only be stopped at the boundary after it.
        assert!(!child_output_budget_exhausted(0, 40, 100));
        assert!(
            child_output_budget_exhausted(50, 200, 100),
            "50 spent plus about 50 streamed reaches a 100-token budget"
        );
    }

    #[test]
    fn resumed_child_completion_is_routed_to_the_current_parent_scope() {
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(root.path().to_path_buf(), root.path().join("records"));
        let spawn_scope = format!("spawn-scope-{}", uuid::Uuid::new_v4());
        let resume_scope = format!("resume-scope-{}", uuid::Uuid::new_v4());
        let record = SubagentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            parent_scope_id: spawn_scope.clone(),
            parent_call_id: "spawn-call".to_string(),
            last_parent_scope_id: resume_scope.clone(),
            last_call_id: "resume-call".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: serialize_repository_path(root.path()),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&root.path().join("session")),
            status: SubagentStatus::Running,
            attempt: 2,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(2),
            finished_at_ms: None,
            result: None,
            error: None,
        };

        let child_vault = CredentialVault::new();
        let parent_vault = CredentialVault::new();
        let parent_scope = ParentCredentialScope {
            vault: &parent_vault,
            generation: parent_vault.generation(),
        };
        manager
            .finish_record(
                record,
                SubagentStatus::Completed,
                Some(SubagentResult {
                    output: "done".to_string(),
                    files_modified: Vec::new(),
                }),
                None,
                &child_vault,
                &parent_scope,
            )
            .expect("terminal record should persist");

        assert!(
            manager.runtime.poll_events(&spawn_scope).is_empty(),
            "the original spawn scope no longer has a consumer"
        );
        let events = manager.runtime.poll_events(&resume_scope);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].parent_call_id, "resume-call");
        assert_eq!(events[0].status, SubagentStatus::Completed);
    }

    #[tokio::test]
    async fn runtime_registry_queues_after_its_concurrency_limit() {
        let runtime = RuntimeRegistry::with_capacity(1);
        let first = runtime.acquire_permit().await.expect("first permit");
        assert_eq!(runtime.available_permits(), 0);

        let second =
            tokio::time::timeout(Duration::from_millis(10), runtime.acquire_permit()).await;
        assert!(second.is_err(), "second child should remain queued");
        drop(first);
        let _second = runtime
            .acquire_permit()
            .await
            .expect("permit should be reusable");
    }

    #[test]
    fn lifecycle_events_are_parent_scoped_and_consumed_once() {
        let runtime = RuntimeRegistry::with_capacity(1);
        runtime.push_event(SubagentLifecycleEvent {
            subagent_id: "child-1".to_string(),
            parent_scope_id: "parent-a".to_string(),
            parent_call_id: "call-1".to_string(),
            status: SubagentStatus::Completed,
            summary: Some("done".to_string()),
            error: None,
            finished_at_ms: 10,
        });
        runtime.push_event(SubagentLifecycleEvent {
            subagent_id: "child-2".to_string(),
            parent_scope_id: "parent-b".to_string(),
            parent_call_id: "call-2".to_string(),
            status: SubagentStatus::Failed,
            summary: None,
            error: Some("failed".to_string()),
            finished_at_ms: 11,
        });

        let events = runtime.poll_events("parent-a");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].subagent_id, "child-1");
        assert!(runtime.poll_events("parent-a").is_empty());
        assert_eq!(runtime.poll_events("parent-b").len(), 1);
    }

    #[test]
    fn a_manager_scope_rotates_behind_a_shared_handle() {
        // The tool executor holding this manager is behind an `Arc` that
        // outlives any one conversation, so the scope has to rotate through
        // `&self` rather than by rebuilding the executor.
        let manager = SubagentManager::with_parent_scope(PathBuf::from("/tmp"), "session:alpha");
        let shared = manager.clone();
        assert_eq!(shared.parent_scope_id(), "session:alpha");

        manager.set_parent_scope_id("session:beta".to_string());

        assert_eq!(manager.parent_scope_id(), "session:beta");
        assert_eq!(
            shared.parent_scope_id(),
            "session:beta",
            "every handle to one executor's manager must see the rotation"
        );
    }

    #[test]
    fn a_rotated_scope_leaves_the_previous_conversation_events_parked() {
        // A child that finishes after its conversation ended must not be
        // drained by the next one, and must still be there when its own
        // session is resumed.
        let runtime = RuntimeRegistry::with_capacity(1);
        runtime.push_event(SubagentLifecycleEvent {
            subagent_id: "child-1".to_string(),
            parent_scope_id: "session:alpha".to_string(),
            parent_call_id: "call-1".to_string(),
            status: SubagentStatus::Completed,
            summary: Some("done".to_string()),
            error: None,
            finished_at_ms: 10,
        });

        assert!(
            runtime.poll_events("session:beta").is_empty(),
            "the new conversation must not see the previous one's child"
        );

        let resumed = runtime.poll_events("session:alpha");
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].subagent_id, "child-1");
    }

    #[test]
    fn workspace_record_root_distinguishes_colliding_sanitized_paths() {
        let left = default_root(Path::new("/tmp/a/b-c"));
        let right = default_root(Path::new("/tmp/a-b/c"));
        assert_ne!(left, right);
    }

    #[test]
    fn worktree_setup_requires_an_unrestricted_parent_sandbox() {
        let workspace_write = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        assert!(!worktree_setup_allowed(Some(&workspace_write)));
        assert!(!worktree_setup_allowed(Some(&SandboxPolicy::ReadOnly)));
        assert!(worktree_setup_allowed(Some(
            &SandboxPolicy::DangerFullAccess
        )));
        assert!(worktree_setup_allowed(None));
    }

    #[test]
    fn changed_files_since_detects_changes_to_initially_dirty_files() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.path().join("tracked.txt"), "base\n")
            .expect("base file should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::fs::write(root.path().join("tracked.txt"), "parent change\n")
            .expect("parent change should be written");
        std::fs::write(root.path().join("space name.txt"), "untracked\n")
            .expect("untracked file should be written");
        assert!(changed_files(root.path()).contains(&PathBuf::from("space name.txt")));
        let (initial_paths, initial_fingerprints) = changed_file_baseline(root.path());
        let (initial_files, initial_file_fingerprints) =
            serialize_file_baseline(initial_paths, initial_fingerprints);

        std::fs::write(root.path().join("tracked.txt"), "child change\n")
            .expect("child change should be written");
        assert_eq!(
            changed_files_since(
                root.path(),
                None,
                &initial_files,
                &initial_file_fingerprints,
            ),
            vec!["tracked.txt"]
        );

        std::fs::remove_file(root.path().join("tracked.txt")).expect("tracked file should delete");
        std::fs::remove_file(root.path().join("space name.txt"))
            .expect("untracked file should delete");
        let mut deleted = changed_files_since(
            root.path(),
            None,
            &initial_files,
            &initial_file_fingerprints,
        );
        deleted.sort();
        assert_eq!(deleted, vec!["space name.txt", "tracked.txt"]);
    }

    #[test]
    fn changed_file_fingerprints_resolve_repository_root_relative_paths() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        let cwd = root.path().join("packages").join("foo");
        std::fs::create_dir_all(&cwd).expect("nested cwd should be created");
        std::fs::write(cwd.join("tracked.txt"), "base\n").expect("base file should be written");
        git(&["add", "packages/foo/tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::fs::write(cwd.join("tracked.txt"), "parent change\n")
            .expect("parent change should be written");
        let (initial_paths, initial_fingerprints) = changed_file_baseline(&cwd);
        let (initial_files, initial_file_fingerprints) =
            serialize_file_baseline(initial_paths, initial_fingerprints);

        std::fs::write(cwd.join("tracked.txt"), "child change\n")
            .expect("child change should be written");
        assert_eq!(
            changed_files_since(&cwd, None, &initial_files, &initial_file_fingerprints,),
            vec!["packages/foo/tracked.txt"]
        );
    }

    #[test]
    fn changed_files_since_detects_index_only_changes() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.path().join("tracked.txt"), "base\n")
            .expect("base file should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::fs::write(root.path().join("tracked.txt"), "parent change\n")
            .expect("parent change should be written");
        let (unstaged_paths, unstaged_fingerprints) = changed_file_baseline(root.path());
        let (unstaged_files, unstaged_fingerprints) =
            serialize_file_baseline(unstaged_paths, unstaged_fingerprints);

        git(&["add", "tracked.txt"]);
        assert_eq!(
            changed_files_since(root.path(), None, &unstaged_files, &unstaged_fingerprints,),
            vec!["tracked.txt"]
        );

        let (staged_paths, staged_fingerprints) = changed_file_baseline(root.path());
        let (staged_files, staged_fingerprints) =
            serialize_file_baseline(staged_paths, staged_fingerprints);
        git(&["restore", "--staged", "--", "tracked.txt"]);
        assert_eq!(
            changed_files_since(root.path(), None, &staged_files, &staged_fingerprints,),
            vec!["tracked.txt"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn changed_files_since_detects_worktree_mode_changes() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        let path = root.path().join("tracked.txt");
        std::fs::write(&path, "base\n").expect("base file should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("baseline mode should be set");

        let (initial_paths, initial_fingerprints) = changed_file_baseline(root.path());
        let (initial_files, initial_file_fingerprints) =
            serialize_file_baseline(initial_paths, initial_fingerprints);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("child mode should be set");

        assert_eq!(
            changed_files_since(
                root.path(),
                None,
                &initial_files,
                &initial_file_fingerprints,
            ),
            vec!["tracked.txt"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn serialized_non_utf8_paths_round_trip_for_change_reporting() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        let raw_name = b"invalid-\xff.txt";
        let path = PathBuf::from(OsString::from_vec(raw_name.to_vec()));
        let serialized = serialize_repository_path(&path);
        assert_eq!(
            deserialize_repository_path(&serialized)
                .as_os_str()
                .as_bytes(),
            raw_name
        );
        let initial_files = vec![serialized.clone()];
        let initial_file_fingerprints = HashMap::from([(serialized, "baseline".to_string())]);

        assert_eq!(
            changed_files_since(
                root.path(),
                None,
                &initial_files,
                &initial_file_fingerprints,
            ),
            vec![String::from_utf8_lossy(raw_name).into_owned()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn subagent_record_preserves_non_utf8_working_directory() {
        let root = tempfile::tempdir().expect("temp root");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let cwd = root.path().join(OsString::from_vec(b"child-\xff".to_vec()));
        let record = SubagentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: serialize_repository_path(&cwd),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&root.path().join("session")),
            status: SubagentStatus::Queued,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: None,
            finished_at_ms: None,
            result: None,
            error: None,
        };

        manager.write_record(&record).expect("write record");
        let loaded = manager.load_record(&record.id).expect("reload record");

        assert_eq!(deserialize_repository_path(&loaded.cwd), cwd);
    }

    #[test]
    fn changed_files_since_detects_committed_child_changes() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.path().join("tracked.txt"), "base\n")
            .expect("base file should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);

        let initial_head = git_repository_head(root.path()).expect("initial HEAD should exist");
        let (initial_paths, initial_fingerprints) = changed_file_baseline(root.path());
        let (initial_files, initial_file_fingerprints) =
            serialize_file_baseline(initial_paths, initial_fingerprints);
        std::fs::write(root.path().join("tracked.txt"), "child commit\n")
            .expect("child change should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "child"]);

        assert!(changed_files(root.path()).is_empty());
        assert_eq!(
            changed_files_since(
                root.path(),
                Some(&initial_head),
                &initial_files,
                &initial_file_fingerprints,
            ),
            vec!["tracked.txt"]
        );
    }

    #[test]
    fn refreshed_baseline_excludes_parent_changes_from_resumed_attempt() {
        let root = tempfile::tempdir().expect("temp root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.path().join("tracked.txt"), "base\n")
            .expect("base file should be written");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "init"]);

        let (spawn_paths, spawn_fingerprints) = changed_file_baseline(root.path());
        let (spawn_files, spawn_fingerprints) =
            serialize_file_baseline(spawn_paths, spawn_fingerprints);
        std::fs::write(root.path().join("tracked.txt"), "first attempt\n")
            .expect("first attempt should be written");
        assert_eq!(
            changed_files_since(root.path(), None, &spawn_files, &spawn_fingerprints,),
            vec!["tracked.txt"]
        );

        let (resume_paths, resume_fingerprints) = changed_file_baseline(root.path());
        let (resume_files, resume_fingerprints) =
            serialize_file_baseline(resume_paths, resume_fingerprints);
        assert!(
            changed_files_since(root.path(), None, &resume_files, &resume_fingerprints,).is_empty()
        );
    }

    #[test]
    fn subagent_record_is_atomic_and_reloadable() {
        let root = tempfile::tempdir().expect("temp root");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let record = SubagentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: "/workspace".to_string(),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: root.path().join("session").display().to_string(),
            status: SubagentStatus::Queued,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: None,
            finished_at_ms: None,
            result: None,
            error: None,
        };

        manager.write_record(&record).expect("write record");
        let loaded = manager.load_record(&record.id).expect("reload record");
        assert_eq!(loaded.id, record.id);
        assert_eq!(loaded.parent_call_id, "call-1");

        let mut cancelled = loaded;
        cancelled.status = SubagentStatus::Cancelled;
        cancelled.error = Some("subagent cancelled".to_string());
        assert!(!tool_result_for_record(cancelled).success);
    }

    #[test]
    fn terminal_subagent_without_worktree_can_be_inspected_and_cleaned() {
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: "/workspace".to_string(),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: root.path().join("session").display().to_string(),
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        let inspected = manager.inspect(&serde_json::json!({"subagent_id": id}));
        assert!(inspected.success);
        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": record.id}));
        assert!(cleaned.success);
        assert!(
            !manager
                .load_record(&record.id)
                .expect("record should remain durable")
                .worktree_cleaned,
            "shared children have no worktree, so cleanup must leave them resumable"
        );
    }

    #[test]
    fn shared_child_remains_resumable_after_noop_cleanup() {
        let root = tempfile::tempdir().expect("records root should exist");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace should exist");
        let manager = SubagentManager::with_root(workspace.clone(), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = root.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("session directory should exist");
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: serialize_repository_path(&workspace),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&session_dir),
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": id}));
        assert!(cleaned.success);
        assert!(
            manager.revalidate_resumable_under_lease(&id).is_ok(),
            "a shared child must remain resumable after a no-op cleanup"
        );
    }

    #[test]
    fn a_child_holding_the_execution_lease_is_not_marked_interrupted() {
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = root.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("session directory should exist");
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: "/workspace".to_string(),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&session_dir),
            status: SubagentStatus::Running,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: None,
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        // Stands in for a second Maestro process running this child: the
        // lease is held, but this process's runtime registry never saw the
        // child, so `runtime.get` reports nothing.
        let lease = SessionLock::acquire(&SubagentManager::timeline_path(&record))
            .expect("execution lease should be held");

        assert_eq!(
            manager.load_record(&id).expect("record should load").status,
            SubagentStatus::Running,
            "a leased child must not be rewritten to a terminal status"
        );
        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": id}));
        assert!(
            !cleaned.success,
            "cleanup must refuse a child whose execution lease is still held"
        );

        drop(lease);
        assert_eq!(
            manager.load_record(&id).expect("record should load").status,
            SubagentStatus::Interrupted,
            "a child with no live lease is an orphan from a previous run"
        );
    }

    #[test]
    fn cleanup_refuses_a_terminal_child_whose_lease_another_process_holds() {
        // The dangerous ordering is not "cleanup sees a running child" -- that
        // is already refused -- but "cleanup sees a terminal child, then a
        // second Maestro resumes it". `resume` takes the execution lease before
        // it rewrites the record, so a cleanup that does not hold the lease can
        // pass its status check and then force-remove a worktree the resumed
        // child is working in.
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = root.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("session directory should exist");
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: "/workspace".to_string(),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&session_dir),
            // Terminal, so the status check on its own would let cleanup run.
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        // Stands in for a second Maestro process that has just resumed this
        // child: it holds the lease, and this process's runtime registry never
        // saw the child.
        let lease = SessionLock::acquire(&SubagentManager::timeline_path(&record))
            .expect("execution lease should be held");

        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": id}));
        assert!(
            !cleaned.success,
            "cleanup must refuse a terminal child whose execution lease is held"
        );
        assert!(
            !manager
                .load_record(&id)
                .expect("record should load")
                .worktree_cleaned,
            "a refused cleanup must leave the record alone"
        );

        drop(lease);

        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": id}));
        assert!(
            cleaned.success,
            "cleanup must proceed once no process holds the lease"
        );
        // This fixture is isolation=shared (no worktree). Cleanup is a no-op
        // and must not flip worktree_cleaned, which would block resume.
        assert!(
            !manager
                .load_record(&id)
                .expect("record should load")
                .worktree_cleaned,
            "no-op cleanup must not mark a shared child as cleaned"
        );
    }

    #[test]
    fn a_cleaned_child_cannot_be_resumed() {
        // `cleanup` holds the execution lease across its check and removal, so
        // a resume that acquires the lease afterwards is looking at a record it
        // read before the removal. Relaunching on that stale copy would put the
        // child in a directory that no longer exists.
        let root = tempfile::tempdir().expect("records root should exist");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace should exist");
        let manager = SubagentManager::with_root(workspace.clone(), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = root.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("session directory should exist");
        let mut record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: serialize_repository_path(&workspace),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&session_dir),
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        assert!(
            manager.revalidate_resumable_under_lease(&id).is_ok(),
            "an uncleaned child with a live cwd is resumable"
        );

        record.worktree_cleaned = true;
        manager
            .write_record(&record)
            .expect("record should persist");

        let refused = manager
            .revalidate_resumable_under_lease(&id)
            .expect_err("a cleaned child must not be resumable");
        assert!(refused.contains("worktree was cleaned up"), "{refused}");
    }

    #[test]
    fn a_child_whose_working_directory_is_gone_cannot_be_resumed() {
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = root.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("session directory should exist");
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: serialize_repository_path(&root.path().join("removed-worktree")),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&session_dir),
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        let refused = manager
            .revalidate_resumable_under_lease(&id)
            .expect_err("a missing working directory must refuse the resume");
        assert!(refused.contains("no longer exists"), "{refused}");
    }

    #[test]
    fn cleanup_proceeds_when_the_session_directory_is_already_gone() {
        // The lock file lives in the session directory, so a pruned transcript
        // means no lease can exist and no resume can start one. Cleanup must
        // stay usable rather than refusing forever.
        let root = tempfile::tempdir().expect("records root should exist");
        let manager =
            SubagentManager::with_root(PathBuf::from("/workspace"), root.path().join("records"));
        let id = uuid::Uuid::new_v4().to_string();
        let record = SubagentRecord {
            id: id.clone(),
            parent_scope_id: "parent-scope".to_string(),
            parent_call_id: "call-1".to_string(),
            last_parent_scope_id: "parent-scope".to_string(),
            last_call_id: "call-1".to_string(),
            task: "inspect".to_string(),
            current_prompt: "inspect".to_string(),
            role: SubagentRole::Explore,
            profile: None,
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            isolation: SubagentIsolation::Shared,
            cwd: "/workspace".to_string(),
            worktree_path: None,
            worktree_cleaned: false,
            initial_files: Vec::new(),
            initial_file_fingerprints: HashMap::new(),
            initial_head: None,
            session_dir: serialize_repository_path(&root.path().join("missing-session")),
            status: SubagentStatus::Completed,
            attempt: 1,
            snapshot_attempt: None,
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: Some(2),
            result: None,
            error: None,
        };
        manager
            .write_record(&record)
            .expect("record should persist");

        let cleaned = manager.cleanup(&serde_json::json!({"subagent_id": id}));

        assert!(cleaned.success, "cleanup: {}", cleaned.output);
    }

    #[test]
    fn child_tool_set_excludes_parent_global_tools() {
        let tools = child_allowed_tools_for_role(SubagentRole::Code, None);
        for name in SUBAGENT_TOOL_NAMES {
            assert!(!tools.contains(name), "child advertised {name}");
        }
        assert!(!tools.contains("get_goal"));
        assert!(!tools.contains("update_goal"));
        assert!(!tools.contains("todo"));
        assert!(!tools.contains("background_tasks"));
        assert!(tools.contains("read"));
    }

    #[test]
    fn role_tool_policies_prevent_read_only_roles_from_mutating() {
        for role in [
            SubagentRole::Explore,
            SubagentRole::Plan,
            SubagentRole::Review,
        ] {
            let tools = child_allowed_tools_for_role(role, None);
            assert!(tools.contains("read"), "{role:?} should read files");
            assert!(tools.contains("grep"), "{role:?} should search files");
            assert!(
                !tools.contains("bash"),
                "{role:?} must not run shell commands"
            );
            assert!(!tools.contains("write"), "{role:?} must not write files");
            assert!(!tools.contains("edit"), "{role:?} must not edit files");
        }

        let code_tools = child_allowed_tools_for_role(SubagentRole::Code, None);
        assert!(code_tools.contains("bash"));
        assert!(code_tools.contains("write"));
        assert!(code_tools.contains("edit"));
    }

    #[test]
    fn profile_tools_only_narrow_a_role_policy() {
        let requested = ["read".to_string(), "write".to_string(), "bash".to_string()];
        let explore_tools = child_allowed_tools_for_role(SubagentRole::Explore, Some(&requested));
        assert_eq!(explore_tools, HashSet::from(["read".to_string()]));

        let code_tools = child_allowed_tools_for_role(SubagentRole::Code, Some(&requested));
        assert_eq!(
            code_tools,
            HashSet::from(["read".to_string(), "write".to_string(), "bash".to_string()])
        );
    }

    #[test]
    fn project_profile_resolves_prompt_tools_and_model_for_a_child() {
        let root = tempfile::tempdir().expect("profile root should exist");
        let profile_dir = root.path().join(".maestro/agent-profiles");
        std::fs::create_dir_all(&profile_dir).expect("profile directory should be created");
        std::fs::write(
            profile_dir.join("rust-reviewer.md"),
            "---\nname: rust-reviewer\ntools: [read, grep]\nmodel: review-model\n---\n\nFocus on correctness and regressions.\n",
        )
        .expect("profile should be written");

        let mut request = SpawnRequest {
            task: "review the change".to_string(),
            role: SubagentRole::Review,
            profile: Some("rust-reviewer".to_string()),
            profile_prompt: None,
            profile_tools: None,
            model: None,
            timeout_ms: DEFAULT_CHILD_TIMEOUT_MS,
            max_tokens: DEFAULT_CHILD_MAX_TOKENS,
            run_in_background: true,
            isolation: SubagentIsolation::Shared,
            worktree_name: None,
        };
        resolve_spawn_profile(&mut request, root.path()).expect("profile should resolve");

        assert_eq!(request.profile.as_deref(), Some("rust-reviewer"));
        assert_eq!(
            request.profile_prompt.as_deref(),
            Some("Focus on correctness and regressions.")
        );
        assert_eq!(
            request.profile_tools,
            Some(vec!["read".to_string(), "grep".to_string()])
        );
        assert_eq!(request.model.as_deref(), Some("review-model"));
    }

    #[test]
    fn child_credential_scope_survives_parent_reset_for_resume() {
        let runtime = RuntimeRegistry::new();
        let parent = CredentialVault::new();
        let child = parent.fork();
        runtime.set_credential_scope("child", child.clone());

        let reference = child.store(
            "discovered-child-secret",
            crate::agent::CredentialType::Secret,
        );
        parent.clear();

        let resumed = runtime
            .credential_scope("child")
            .expect("child credential scope should be retained");
        assert_eq!(resumed.resolve_all(&reference), "discovered-child-secret");
    }

    #[test]
    fn resume_rekeys_new_parent_credentials_into_child_scope() {
        let parent = CredentialVault::new();
        let child = parent.fork();
        let child_reference = child.store(
            "discovered-child-secret",
            crate::agent::CredentialType::Secret,
        );
        let mappings = parent.absorb_child_credentials_at_generation(&child, parent.generation());
        let parent_reference = mappings
            .get(&child_reference)
            .expect("child credential should be imported into parent");

        let incoming_task = format!("reuse {parent_reference}");
        let parent_resolved_task = parent.resolve_all(&incoming_task);
        let child_task = child.vault_in_text(&parent_resolved_task);

        assert!(!child_task.contains("discovered-child-secret"));
        assert_eq!(
            child.resolve_all(&child_task),
            incoming_task.replace(parent_reference, "discovered-child-secret",)
        );
    }

    #[test]
    fn fallback_history_restores_prompt_when_snapshot_is_missing() {
        let history = fallback_history_from_prompt("original delegated task")
            .expect("prompt should become fallback history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, crate::ai::Role::User);
        assert_eq!(
            history[0].content.as_text(),
            Some("original delegated task")
        );
        assert!(fallback_history_from_prompt("  ").is_none());
    }

    #[test]
    fn restore_history_augments_stale_snapshot_with_interrupted_prompt() {
        let prior = crate::ai::Message {
            role: crate::ai::Role::User,
            content: crate::ai::MessageContent::text("original delegated task"),
        };
        let restored = restore_history_with_prompt(
            Some(vec![prior.clone()]),
            "interrupted follow-up",
            2,
            None,
        )
        .expect("history should be restored");
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[1].content.as_text(), Some("interrupted follow-up"));

        let already_recorded = restore_history_with_prompt(
            Some(vec![
                prior,
                crate::ai::Message {
                    role: crate::ai::Role::User,
                    content: crate::ai::MessageContent::text("interrupted follow-up"),
                },
            ]),
            "interrupted follow-up",
            2,
            Some(2),
        )
        .expect("history should remain available");
        assert_eq!(already_recorded.len(), 2);
    }

    #[test]
    fn restore_history_appends_repeated_prompt_from_an_older_attempt() {
        let prompt = "repeat the same delegated task";
        let history = vec![crate::ai::Message {
            role: crate::ai::Role::User,
            content: crate::ai::MessageContent::text(prompt),
        }];
        let current_snapshot =
            restore_history_with_prompt(Some(history.clone()), prompt, 1, Some(1))
                .expect("current snapshot should be restored");
        assert_eq!(current_snapshot.len(), 1);

        let restored = restore_history_with_prompt(Some(history), prompt, 2, Some(1))
            .expect("history should be restored");
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[1].content.as_text(), Some(prompt));
    }

    #[test]
    fn child_transcript_preserves_resume_checkpoint() {
        let root = tempfile::tempdir().expect("temp root");
        let session_dir = root.path().join("session");
        let session_id = uuid::Uuid::new_v4().to_string();
        let messages = vec![crate::ai::Message {
            role: crate::ai::Role::User,
            content: crate::ai::MessageContent::text("inspect the parser"),
        }];
        let event = FromAgent::ConversationSnapshot {
            protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL.to_string(),
            messages: messages.clone(),
        };
        let received =
            child_event_to_headless(&event, &session_id).expect("snapshot should be recordable");

        let mut recorder =
            SessionRecorder::with_id(&session_dir, &session_id).expect("create transcript");
        recorder
            .record_received(&received)
            .expect("record snapshot");
        recorder.flush_checkpoint().expect("flush transcript");

        let resumed =
            SessionRecorder::resume(&session_dir, &session_id).expect("resume transcript");
        let restored = resumed
            .replay()
            .semantic_conversation
            .expect("semantic checkpoint");
        assert_eq!(
            serde_json::to_value(restored).expect("serialize restored messages"),
            serde_json::to_value(messages).expect("serialize source messages")
        );
    }

    #[test]
    fn child_snapshot_persists_attempt_with_resume_checkpoint() {
        let root = tempfile::tempdir().expect("temp root");
        let session_id = uuid::Uuid::new_v4().to_string();
        let event = FromAgent::ConversationSnapshot {
            protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL.to_string(),
            messages: vec![crate::ai::Message {
                role: crate::ai::Role::User,
                content: crate::ai::MessageContent::text("inspect the parser"),
            }],
        };
        let received =
            child_event_to_headless(&event, &session_id).expect("snapshot should be recordable");

        let mut recorder =
            SessionRecorder::with_id(root.path(), &session_id).expect("create transcript");
        recorder
            .record_received_preserving_credential_references_with_snapshot_attempt(
                &received,
                Some(7),
            )
            .expect("record snapshot attempt");
        recorder.flush_checkpoint().expect("flush transcript");
        drop(recorder);

        let resumed = SessionRecorder::resume(root.path(), &session_id).expect("resume transcript");
        assert_eq!(resumed.semantic_conversation_attempt(), Some(7));
        assert!(resumed.replay().semantic_conversation.is_some());
    }

    #[test]
    fn drains_shutdown_snapshot_into_resume_checkpoint() {
        let root = tempfile::tempdir().expect("temp root");
        let session_id = uuid::Uuid::new_v4().to_string();
        let messages = vec![
            crate::ai::Message {
                role: crate::ai::Role::User,
                content: crate::ai::MessageContent::text("inspect the parser"),
            },
            crate::ai::Message {
                role: crate::ai::Role::Assistant,
                content: crate::ai::MessageContent::text("I found the parser boundary."),
            },
        ];
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        sender
            .send(FromAgent::ConversationSnapshot {
                protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL
                    .to_string(),
                messages: messages.clone(),
            })
            .expect("queue shutdown snapshot");
        drop(sender);

        let mut recorder =
            SessionRecorder::with_id(root.path(), &session_id).expect("create transcript");
        drain_child_events(
            &mut recorder,
            &mut events,
            &session_id,
            &CredentialVault::new(),
            1,
        )
        .expect("drain shutdown snapshot");
        recorder.flush_checkpoint().expect("flush transcript");

        let restored = SessionRecorder::resume(root.path(), &session_id)
            .expect("resume transcript")
            .replay()
            .semantic_conversation
            .expect("semantic checkpoint");
        assert_eq!(
            serde_json::to_value(restored).expect("serialize restored messages"),
            serde_json::to_value(messages).expect("serialize source messages")
        );
    }

    #[test]
    fn child_snapshots_revault_resolved_prompt_content_before_persistence() {
        let root = tempfile::tempdir().expect("temp root");
        let vault = CredentialVault::new();
        let reference = vault.store("arbitrary-secret", crate::agent::CredentialType::Password);
        let session_id = uuid::Uuid::new_v4().to_string();
        let event = FromAgent::ConversationSnapshot {
            protocol_version: crate::headless::messages::SEMANTIC_CONVERSATION_PROTOCOL.to_string(),
            messages: vec![crate::ai::Message {
                role: crate::ai::Role::User,
                content: crate::ai::MessageContent::text("Use arbitrary-secret now"),
            }],
        };
        let message = child_event_to_headless(&event, "child").expect("snapshot should map");
        let vaulted = vault_headless_message(&message, &vault).expect("snapshot should re-vault");
        let serialized = serde_json::to_string(&vaulted).expect("snapshot should serialize");
        assert!(serialized.contains(&reference));
        assert!(!serialized.contains("arbitrary-secret"));

        let mut recorder =
            SessionRecorder::with_id(root.path(), &session_id).expect("create transcript");
        recorder
            .record_received_preserving_credential_references(&vaulted)
            .expect("record vaulted snapshot");
        recorder.flush_checkpoint().expect("flush transcript");
        let resumed = SessionRecorder::resume(root.path(), &session_id).expect("resume transcript");
        let restored = resumed
            .replay()
            .semantic_conversation
            .expect("semantic checkpoint");
        let restored_text = restored[0].content.as_text().expect("restored prompt text");
        assert_eq!(restored_text, format!("Use {reference} now"));
        assert_eq!(vault.resolve_all(restored_text), "Use arbitrary-secret now");
    }
}

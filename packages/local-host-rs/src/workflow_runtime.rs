//! Durable, budgeted local workflow run contracts.
//!
//! These records are a client-side journal for the native CLI.  They are not
//! hosted Run authority and must not be used as a substitute for Platform
//! acceptance.  Hosted runtimes keep their own owner records and receipts.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use fd_lock::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A model selection captured in the workflow specification before any child
/// is started.  The string form is accepted for compatibility with early
/// workflow files; the object form is what the CLI persists in the accepted
/// journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowModelConfig {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Per-child cumulative output-token ceiling.  The workflow's
    /// `tokenBudget` remains the shared output-token budget.
    pub max_output_tokens: u64,
}

impl Default for WorkflowModelConfig {
    fn default() -> Self {
        Self {
            model: "gpt-5.1-codex-max".to_owned(),
            provider: None,
            reasoning_effort: None,
            max_output_tokens: 16_384,
        }
    }
}

impl<'de> Deserialize<'de> for WorkflowModelConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[serde(deny_unknown_fields)]
        struct Object {
            model: String,
            #[serde(default)]
            provider: Option<String>,
            #[serde(default)]
            reasoning_effort: Option<String>,
            #[serde(default = "default_max_output_tokens")]
            max_output_tokens: u64,
        }

        fn default_max_output_tokens() -> u64 {
            WorkflowModelConfig::default().max_output_tokens
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input {
            Name(String),
            Object(Object),
        }

        match Input::deserialize(deserializer)? {
            Input::Name(model) => Ok(Self {
                model,
                ..Self::default()
            }),
            Input::Object(object) => Ok(Self {
                model: object.model,
                provider: object.provider,
                reasoning_effort: object.reasoning_effort,
                max_output_tokens: object.max_output_tokens,
            }),
        }
    }
}

/// One user-authored verification command.  Commands are parsed into argv by
/// the CLI and run after integration, so model output can never add or alter a
/// verifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct WorkflowVerification {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default = "default_verification_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_verification_timeout_ms() -> u64 {
    120_000
}

/// Typed state recorded for each local verification command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVerificationResult {
    pub command: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub output: String,
    pub timed_out: bool,
    /// Exact aggregate revision against which this command ran.  A verifier
    /// result without this binding is useful diagnostics, but cannot serve as
    /// acceptance evidence for an integrated workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sha: Option<String>,
}

/// Durable admission record for one user-authored verifier.  The reservation
/// is persisted before the command is spawned; if the process dies while it
/// exists, resume must require explicit reconciliation rather than silently
/// replaying an arbitrary command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVerificationReservation {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct WorkflowStep {
    pub id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Declared files used by this step.  They are scheduler hints and are
    /// also retained in the local journal for conflict-aware integration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSpec {
    pub name: String,
    pub version: String,
    pub steps: Vec<WorkflowStep>,
    pub max_agents: u32,
    pub max_concurrency: u32,
    pub token_budget: u64,
    /// Cross-process resume is allowed only for workflows whose effects are
    /// either read-only or protected by idempotent durable receipts.
    #[serde(default)]
    pub replay_safe: bool,
    /// Provider/model routing is pinned before the first child is admitted.
    #[serde(default)]
    pub model: WorkflowModelConfig,
    /// Every child inherits this explicit capability ceiling.  An empty list
    /// deliberately grants no tools and is valid for model-only workflows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Relative workspace paths that may be written by child tools.  The
    /// native CLI canonicalizes and checks these before launch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_scopes: Vec<String>,
    /// User-supplied post-integration verification commands.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verification: Vec<WorkflowVerification>,
}

impl WorkflowSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.version.trim().is_empty() {
            return Err("workflow name and version are required".to_string());
        }
        if self.steps.is_empty() {
            return Err("workflow must contain at least one step".to_string());
        }
        if self.max_agents == 0 || self.max_concurrency == 0 {
            return Err("workflow agent and concurrency budgets must be positive".to_string());
        }
        if self.max_concurrency > self.max_agents {
            return Err("maxConcurrency cannot exceed maxAgents".to_string());
        }
        if self.token_budget == 0 {
            return Err("workflow tokenBudget must be positive".to_string());
        }
        if self.model.model.trim().is_empty() {
            return Err("workflow model.model is required".to_string());
        }
        if self.model.max_output_tokens == 0 {
            return Err("workflow model.maxOutputTokens must be positive".to_string());
        }
        if self.model.max_output_tokens > u64::from(u32::MAX) {
            return Err("workflow model.maxOutputTokens exceeds the native limit".to_string());
        }
        if self.allowed_tools.iter().any(|tool| tool.trim().is_empty()) {
            return Err("workflow allowedTools must not contain empty names".to_string());
        }
        if self
            .write_scopes
            .iter()
            .any(|scope| scope.trim().is_empty())
        {
            return Err("workflow writeScopes must not contain empty paths".to_string());
        }
        if self
            .verification
            .iter()
            .any(|verification| verification.command.trim().is_empty())
        {
            return Err("workflow verification commands must not be empty".to_string());
        }
        let ids = self
            .steps
            .iter()
            .map(|step| step.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if ids.len() != self.steps.len() || ids.contains("") {
            return Err("workflow step ids must be non-empty and unique".to_string());
        }
        for step in &self.steps {
            if step.prompt.trim().is_empty() {
                return Err(format!("workflow step {} has an empty prompt", step.id));
            }
            if let Some(missing) = step.depends_on.iter().find(|id| !ids.contains(id.as_str())) {
                return Err(format!(
                    "workflow step {} depends on missing step {missing}",
                    step.id
                ));
            }
        }
        let mut completed = std::collections::HashSet::<&str>::new();
        while completed.len() < self.steps.len() {
            let before = completed.len();
            for step in &self.steps {
                if !completed.contains(step.id.as_str())
                    && step
                        .depends_on
                        .iter()
                        .all(|dependency| completed.contains(dependency.as_str()))
                {
                    completed.insert(step.id.as_str());
                }
            }
            if completed.len() == before {
                return Err("workflow dependencies must form an acyclic graph".to_string());
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn sha256(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        format!("{:x}", Sha256::digest(bytes))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    Running,
    NeedsInput,
    Blocked,
    Paused,
    Failed,
    Complete,
    Stopped,
}

impl WorkflowRunStatus {
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Failed | Self::Complete | Self::Stopped)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub spec: WorkflowSpec,
    pub spec_sha: String,
    #[serde(default)]
    pub args: serde_json::Value,
    pub status: WorkflowRunStatus,
    pub agents_started: u32,
    pub active_agents: u32,
    pub tokens_used: u64,
    /// Observed input tokens across child provider requests. Input is recorded
    /// for accounting but is not the pre-I/O output reservation.
    #[serde(default)]
    pub input_tokens: u64,
    /// Observed output tokens across child provider requests.
    #[serde(default)]
    pub output_tokens: u64,
    /// Conservative output allowance charged to the shared workflow budget.
    /// This includes a full reservation when a child ended without
    /// authoritative usage, so a resumed owner cannot reuse unknown spend.
    #[serde(default)]
    pub output_budget_charged: u64,
    /// Reservations persisted before a child provider request. Keys are the
    /// scheduler dispatch identities and values are output-token allowances.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub output_reservations: BTreeMap<String, u64>,
    pub owner_process_id: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    /// Serialized owner scheduler snapshot.  It stays opaque here so the
    /// local-host contract does not depend on the swarm crate; the CLI decodes
    /// it through the typed swarm recovery API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_snapshot: Option<serde_json::Value>,
    /// Scheduler identity bound by the first accepted snapshot. The local
    /// journal and scheduler use separate IDs so the scheduler can retain its
    /// own recovery contract without deriving identities from user input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_run_id: Option<String>,
    /// Monotonic local journal revision used to reject stale writers.
    #[serde(default)]
    pub revision: u64,
    /// Result of user-authored verification after integrated work.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verification_results: Vec<WorkflowVerificationResult>,
    /// Verifier commands admitted but without a durably recorded result.
    /// These are indeterminate on recovery and must never be auto-replayed.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub verification_reservations: BTreeMap<String, WorkflowVerificationReservation>,
    /// Exact integrated revision, when a workspace integration owner supplied
    /// one.  This remains evidence only and does not grant hosted acceptance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrated_revision: Option<String>,
    /// Git revision accepted before the first child was admitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    /// Workflow-owned aggregate ref used to recover an integrated revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_ref: Option<String>,
    /// Canonical workspace in which relative grants were accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// Canonical Git repository root, when the workflow has Git integration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_root: Option<String>,
    /// Bounded final workflow result assembled from accepted child results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_output: Option<String>,
}

impl WorkflowRun {
    pub fn start(spec: WorkflowSpec, args: serde_json::Value) -> Result<Self, String> {
        spec.validate()?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            spec_sha: spec.sha256(),
            spec,
            args,
            status: WorkflowRunStatus::Running,
            agents_started: 0,
            active_agents: 0,
            tokens_used: 0,
            input_tokens: 0,
            output_tokens: 0,
            output_budget_charged: 0,
            output_reservations: BTreeMap::new(),
            owner_process_id: std::process::id(),
            created_at: now.clone(),
            updated_at: now,
            status_reason: None,
            swarm_snapshot: None,
            swarm_run_id: None,
            revision: 0,
            verification_results: Vec::new(),
            verification_reservations: BTreeMap::new(),
            integrated_revision: None,
            base_revision: None,
            aggregate_ref: None,
            workspace_root: None,
            repository_root: None,
            final_output: None,
        })
    }

    /// Record a scheduler snapshot after incrementing the local journal
    /// revision.  The caller must persist this run through [`WorkflowStore`]
    /// before admitting the next callback.
    pub fn record_swarm_snapshot(&mut self, snapshot: serde_json::Value) {
        self.swarm_snapshot = Some(snapshot);
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    pub fn set_verification_results(&mut self, results: Vec<WorkflowVerificationResult>) {
        self.verification_results = results;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    pub fn begin_verification(
        &mut self,
        index: usize,
        command: String,
        result_sha: Option<String>,
    ) -> Result<(), String> {
        let key = index.to_string();
        if self.verification_reservations.contains_key(&key) {
            return Err(format!(
                "workflow verifier reservation already exists for {index}"
            ));
        }
        if self.verification_results.len() > index {
            return Err(format!(
                "workflow verifier {index} already has a recorded result"
            ));
        }
        self.verification_reservations.insert(
            key,
            WorkflowVerificationReservation {
                command,
                result_sha,
            },
        );
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn record_verification_result(
        &mut self,
        index: usize,
        result: WorkflowVerificationResult,
    ) -> Result<(), String> {
        let key = index.to_string();
        let reservation = self
            .verification_reservations
            .remove(&key)
            .ok_or_else(|| format!("workflow verifier reservation not found for {index}"))?;
        if reservation.command != result.command || reservation.result_sha != result.result_sha {
            self.verification_reservations.insert(key, reservation);
            return Err(format!("workflow verifier result mismatch for {index}"));
        }
        if self.verification_results.len() != index {
            self.verification_reservations.insert(key, reservation);
            return Err(format!(
                "workflow verifier result order mismatch for {index}"
            ));
        }
        self.verification_results.push(result);
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn set_integrated_revision(&mut self, revision: Option<String>) {
        self.integrated_revision = revision;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Persist a newly observed aggregate revision while a child callback is
    /// still in flight. This closes the crash window between Git integration
    /// and the scheduler's result checkpoint.
    pub fn record_integrated_revision(&mut self, revision: String) {
        if self.integrated_revision.as_deref() != Some(revision.as_str()) {
            self.integrated_revision = Some(revision);
            self.revision = self.revision.saturating_add(1);
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }

    pub fn set_integration_metadata(&mut self, base_revision: String, aggregate_ref: String) {
        self.base_revision = Some(base_revision);
        self.aggregate_ref = Some(aggregate_ref);
    }

    pub fn set_workspace_metadata(
        &mut self,
        workspace_root: String,
        repository_root: Option<String>,
    ) {
        self.workspace_root = Some(workspace_root);
        self.repository_root = repository_root;
    }

    /// Reserve a dispatch allowance before the native child starts provider
    /// I/O. Duplicate identities are rejected because a stable dispatch may
    /// only consume one reservation.
    pub fn record_output_reservation(
        &mut self,
        dispatch_id: String,
        amount: u64,
    ) -> Result<(), String> {
        if dispatch_id.trim().is_empty() || amount == 0 {
            return Err(
                "workflow output reservation must have an identity and positive amount".to_string(),
            );
        }
        let reserved = self.output_reservations.values().copied().sum::<u64>();
        if self
            .output_budget_charged
            .saturating_add(reserved)
            .saturating_add(amount)
            > self.spec.token_budget
        {
            return Err("workflow output budget cannot cover this reservation".to_string());
        }
        if self
            .output_reservations
            .insert(dispatch_id.clone(), amount)
            .is_some()
        {
            return Err(format!(
                "workflow output reservation already exists for dispatch {dispatch_id}"
            ));
        }
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    /// Settle exactly one persisted reservation. The conservative charge is
    /// retained even when provider usage is lower or unavailable.
    pub fn settle_output_reservation(
        &mut self,
        dispatch_id: &str,
        reservation_amount: u64,
        charged_amount: u64,
    ) -> Result<(), String> {
        let reserved = self
            .output_reservations
            .remove(dispatch_id)
            .ok_or_else(|| {
                format!("workflow output reservation not found for dispatch {dispatch_id}")
            })?;
        if reserved != reservation_amount {
            self.output_reservations
                .insert(dispatch_id.to_owned(), reserved);
            return Err(format!(
                "workflow output reservation mismatch for dispatch {dispatch_id}"
            ));
        }
        self.output_budget_charged = self.output_budget_charged.saturating_add(charged_amount);
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn set_observed_usage(&mut self, input_tokens: u64, output_tokens: u64) {
        self.input_tokens = input_tokens;
        self.output_tokens = output_tokens;
        self.tokens_used = output_tokens;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    pub fn set_final_output(&mut self, output: Option<String>) {
        self.final_output = output;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Resume a local journal after its accepted snapshot has been checked.
    /// Unlike the legacy slash-command transition, this method does not use a
    /// boolean replay flag as proof that an interrupted callback is safe: the
    /// CLI checks the typed snapshot and keeps every unresolved dispatch in
    /// `NeedsInput` before calling it.
    pub fn resume_local(
        &mut self,
        expected_spec_sha: &str,
        args: &serde_json::Value,
    ) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Paused && self.status != WorkflowRunStatus::NeedsInput
        {
            return Err("only a paused or input-blocked workflow can be resumed".to_string());
        }
        if expected_spec_sha != self.spec_sha {
            return Err("workflow spec changed; refusing unsafe resume".to_string());
        }
        if args != &self.args {
            return Err("workflow arguments changed; refusing unsafe resume".to_string());
        }
        self.owner_process_id = std::process::id();
        self.transition(WorkflowRunStatus::Running, None);
        Ok(())
    }

    pub fn mark_needs_input(&mut self, reason: impl Into<String>) -> Result<(), String> {
        if self.status.is_terminal() {
            return Err("workflow is already terminal".to_string());
        }
        self.active_agents = 0;
        self.transition(WorkflowRunStatus::NeedsInput, Some(reason.into()));
        Ok(())
    }

    pub fn complete(&mut self) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Running {
            return Err("only a running workflow can complete".to_string());
        }
        self.active_agents = 0;
        self.transition(WorkflowRunStatus::Complete, None);
        Ok(())
    }

    pub fn fail(&mut self, reason: impl Into<String>) -> Result<(), String> {
        if self.status.is_terminal() {
            return Err("workflow is already terminal".to_string());
        }
        self.active_agents = 0;
        self.transition(WorkflowRunStatus::Failed, Some(reason.into()));
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Running {
            return Err("only a running workflow can be paused".to_string());
        }
        self.transition(WorkflowRunStatus::Paused, None);
        Ok(())
    }

    pub fn resume(
        &mut self,
        expected_spec_sha: &str,
        args: &serde_json::Value,
    ) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Paused && self.status != WorkflowRunStatus::NeedsInput
        {
            return Err("only a paused or input-blocked workflow can be resumed".to_string());
        }
        if expected_spec_sha != self.spec_sha {
            return Err("workflow spec changed; refusing unsafe resume".to_string());
        }
        if args != &self.args {
            return Err("workflow arguments changed; refusing unsafe resume".to_string());
        }
        if self.owner_process_id != std::process::id() && !self.spec.replay_safe {
            return Err(
                "cross-process resume requires a replay-safe workflow with durable receipts"
                    .to_string(),
            );
        }
        self.owner_process_id = std::process::id();
        self.transition(WorkflowRunStatus::Running, None);
        Ok(())
    }

    pub fn stop(&mut self, reason: Option<String>) -> Result<(), String> {
        if self.status.is_terminal() {
            return Err("workflow is already terminal".to_string());
        }
        self.active_agents = 0;
        self.transition(WorkflowRunStatus::Stopped, reason);
        Ok(())
    }

    pub fn record_usage(
        &mut self,
        new_agents: u32,
        active_agents: u32,
        tokens: u64,
    ) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Running {
            return Err("workflow usage can only be recorded while running".to_string());
        }
        let agents_started = self.agents_started.saturating_add(new_agents);
        let tokens_used = self.tokens_used.saturating_add(tokens);
        if agents_started > self.spec.max_agents {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow agent budget exhausted".to_string()),
            );
            return Err("workflow agent budget exhausted".to_string());
        }
        if active_agents > self.spec.max_concurrency {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow concurrency budget exceeded".to_string()),
            );
            return Err("workflow concurrency budget exceeded".to_string());
        }
        if tokens_used > self.spec.token_budget {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow token budget exhausted".to_string()),
            );
            return Err("workflow token budget exhausted".to_string());
        }
        self.agents_started = agents_started;
        self.active_agents = active_agents;
        self.tokens_used = tokens_used;
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    fn transition(&mut self, status: WorkflowRunStatus, reason: Option<String>) {
        self.status = status;
        self.status_reason = reason;
        self.revision = self.revision.saturating_add(1);
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowStore {
    path: PathBuf,
}

/// An exclusive owner for one local workflow run.
///
/// The owner lock is deliberately separate from the journal lock.  A caller
/// holds this guard for the lifetime of a CLI execution, while each journal
/// write briefly takes the journal lock to perform a compare-and-swap against
/// the latest canonical record.  Dropping the guard releases the OS lock.
#[derive(Debug)]
pub struct WorkflowRunOwner {
    store: WorkflowStore,
    run_id: String,
    lock_path: PathBuf,
    state: Mutex<OwnerState>,
    _lock: WorkflowOwnerLock,
}

#[derive(Debug)]
struct WorkflowOwnerLock {
    file: fs::File,
}

impl Drop for WorkflowOwnerLock {
    fn drop(&mut self) {
        // A fork or duplicated handle can retain the open file description.
        // Closing our handle alone would leave the inherited lock held.
        if let Err(error) = self.file.unlock() {
            eprintln!("Could not release workflow owner lock: {error}");
        }
    }
}

#[derive(Debug, Default)]
struct OwnerState {
    initialized: bool,
    canonical: Option<CanonicalRun>,
}

impl WorkflowRunOwner {
    /// The run identity protected by this guard.
    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Persist a candidate record using an expected-revision CAS.
    ///
    /// `None` is used only for the initial revision-0 record.  For an existing
    /// run, `Some(previous_revision)` must equal the canonical highest
    /// revision under the journal lock.  The candidate revision may advance
    /// by more than one when several in-memory mutations are persisted as one
    /// snapshot.  Retrying the exact same record is idempotent.
    pub fn append_expected(
        &self,
        run: &WorkflowRun,
        expected_revision: Option<u64>,
    ) -> Result<(), String> {
        if run.id != self.run_id {
            return Err(format!(
                "workflow owner is for {}, not {}",
                self.run_id, run.id
            ));
        }
        if self.lock_path != self.store.owner_lock_path(&self.run_id) {
            return Err("workflow owner lock path changed".to_string());
        }
        match fs::symlink_metadata(&self.lock_path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Err("workflow owner lock path is not a regular file".to_string()),
            Err(error) => {
                return Err(format!(
                    "inspect workflow owner lock path {}: {error}",
                    self.lock_path.display()
                ));
            }
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "workflow owner state lock poisoned".to_string())?;
        self.store
            .append_expected_owned(run, expected_revision, &mut state)
    }
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => current.push(component.as_os_str()),
            Component::Normal(name) => {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(metadata)
                        if metadata.file_type().is_symlink()
                            && !is_platform_path_alias(&current) =>
                    {
                        return Err(format!(
                            "workflow journal path traverses a symlink: {}",
                            current.display()
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "inspect workflow journal path {}: {error}",
                            current.display()
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_platform_path_alias(path: &Path) -> bool {
    // macOS exposes /var as a compatibility alias for /private/var.  It is
    // present in every tempfile path on this host and is outside the caller's
    // journal path, so rejecting it would make safe temporary stores unusable.
    path == Path::new("/var")
}

#[cfg(not(target_os = "macos"))]
fn is_platform_path_alias(_path: &Path) -> bool {
    false
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.trim().is_empty() {
        return Err("workflow run id must be non-empty".to_string());
    }
    if run_id.chars().any(char::is_control) {
        return Err("workflow run id may not contain control characters".to_string());
    }
    Ok(())
}

fn immutable_identity_matches(existing: &WorkflowRun, candidate: &WorkflowRun) -> bool {
    existing.id == candidate.id
        && existing.spec == candidate.spec
        && existing.spec_sha == candidate.spec_sha
        && existing.args == candidate.args
        && existing.created_at == candidate.created_at
}

#[derive(Debug)]
struct CanonicalRun {
    run: WorkflowRun,
    /// Records written before the revision field was introduced use physical
    /// order for lifecycle replay.  Keep this bit while reading so those
    /// historical rows do not all appear to be conflicting revision zero
    /// snapshots.
    revision_explicit: bool,
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

impl WorkflowStore {
    #[must_use]
    pub fn for_workspace(workspace: &Path) -> Self {
        Self {
            path: workspace
                .join(".maestro")
                .join("workflows")
                .join("runs.jsonl"),
        }
    }

    #[must_use]
    pub fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    fn journal_lock_path(&self) -> PathBuf {
        self.path.with_extension("lock")
    }

    fn owner_lock_path(&self, run_id: &str) -> PathBuf {
        let digest = Sha256::digest(run_id.as_bytes());
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runs.jsonl");
        self.path
            .with_file_name(format!(".{file_name}.owner-{digest:x}.lock"))
    }

    fn parent(&self) -> Result<&Path, String> {
        Ok(self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new(".")))
    }

    fn prepare_paths(&self, create_parent: bool) -> Result<bool, String> {
        let parent = self.parent()?;
        reject_symlink_components(parent)?;
        if create_parent {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            reject_symlink_components(parent)?;
        }
        reject_symlink_components(&self.path)?;
        let lock_path = self.journal_lock_path();
        reject_symlink_components(&lock_path)?;
        let journal_existed = match fs::symlink_metadata(&self.path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(format!(
                    "workflow journal path is not a regular file: {}",
                    self.path.display()
                ));
            }
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(format!(
                    "workflow journal lock path is not a regular file: {}",
                    lock_path.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        Ok(journal_existed)
    }

    fn open_journal_lock(&self) -> Result<RwLock<fs::File>, String> {
        let lock_path = self.journal_lock_path();
        reject_symlink_components(&lock_path)?;
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        Ok(RwLock::new(lock_file))
    }

    fn open_owner_lock_file(&self, run_id: &str) -> Result<(PathBuf, fs::File), String> {
        validate_run_id(run_id)?;
        let parent = self.parent()?;
        reject_symlink_components(parent)?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        reject_symlink_components(parent)?;
        let path = self.owner_lock_path(run_id);
        reject_symlink_components(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        Ok((path, file))
    }

    fn acquire_legacy_fence(&self, run_id: &str) -> Result<WorkflowOwnerLock, String> {
        let (path, file) = self.open_owner_lock_file(run_id)?;
        match file.try_lock() {
            Ok(()) => Ok(WorkflowOwnerLock { file }),
            Err(TryLockError::WouldBlock) => Err(format!(
                "workflow run {run_id} is already owned by another process ({})",
                path.display()
            )),
            Err(TryLockError::Error(error)) => Err(format!(
                "lock workflow run {run_id} ({}): {error}",
                path.display()
            )),
        }
    }

    /// Acquire the exclusive owner used by the native workflow CLI.
    ///
    /// The operation is intentionally nonblocking: a second process must
    /// report that the run is busy instead of executing against a stale
    /// in-memory snapshot.
    pub fn acquire_run_owner(&self, run_id: &str) -> Result<WorkflowRunOwner, String> {
        // Validate the journal path before creating or opening the owner
        // sidecar.  This keeps an owner acquisition from succeeding for a
        // journal that traverses a symlink, even when no append follows yet.
        self.prepare_paths(false)?;
        let (lock_path, lock_file) = self.open_owner_lock_file(run_id)?;
        match lock_file.try_lock() {
            Ok(()) => Ok(WorkflowRunOwner {
                store: self.clone(),
                run_id: run_id.to_string(),
                lock_path,
                state: Mutex::new(OwnerState::default()),
                _lock: WorkflowOwnerLock { file: lock_file },
            }),
            Err(TryLockError::WouldBlock) => Err(format!(
                "workflow run {run_id} is already owned by another process"
            )),
            Err(TryLockError::Error(error)) => Err(format!("lock workflow run {run_id}: {error}")),
        }
    }

    fn read_canonical_bytes(&self, bytes: &[u8]) -> Result<HashMap<String, CanonicalRun>, String> {
        let mut latest = HashMap::<String, CanonicalRun>::new();
        let contents = std::str::from_utf8(bytes)
            .map_err(|error| format!("read workflow journal as UTF-8: {error}"))?;
        for (line_number, line) in contents.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let raw: serde_json::Value = serde_json::from_str(line).map_err(|error| {
                format!("parse workflow journal line {}: {error}", line_number + 1)
            })?;
            let revision_explicit = raw.get("revision").is_some();
            let run: WorkflowRun = serde_json::from_value(raw).map_err(|error| {
                format!("parse workflow journal line {}: {error}", line_number + 1)
            })?;
            validate_run_id(&run.id)?;
            if let Some(existing) = latest.get(&run.id) {
                if !immutable_identity_matches(&existing.run, &run) {
                    return Err(format!("workflow run identity changed for {}", run.id));
                }
                match (existing.revision_explicit, revision_explicit) {
                    // A historical row has no CAS revision.  Preserve its
                    // physical-last lifecycle semantics until an explicit
                    // revisioned row supersedes it.
                    (false, false) => {}
                    // Explicit rows are authoritative over a stale legacy
                    // row, regardless of physical order.
                    (false, true) => {}
                    // A legacy row cannot regress an explicit snapshot.
                    (true, false) => continue,
                    (true, true) => match run.revision.cmp(&existing.run.revision) {
                        std::cmp::Ordering::Less => continue,
                        std::cmp::Ordering::Equal if run == existing.run => continue,
                        std::cmp::Ordering::Equal => {
                            return Err(format!(
                                "conflicting workflow journal evidence for {} at revision {}",
                                run.id, run.revision
                            ));
                        }
                        std::cmp::Ordering::Greater => {}
                    },
                }
            }
            latest.insert(
                run.id.clone(),
                CanonicalRun {
                    run,
                    revision_explicit,
                },
            );
        }
        Ok(latest)
    }

    fn read_canonical_unlocked(&self) -> Result<HashMap<String, CanonicalRun>, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(error) => return Err(error.to_string()),
        };
        self.read_canonical_bytes(&bytes)
    }

    /// Repair a write torn after the last durable newline while holding the
    /// journal's exclusive lock.  Complete lines are parsed before any
    /// mutation, so malformed interior records (or a malformed complete line
    /// ending in a newline) still fail closed rather than being skipped.
    fn recover_torn_tail_unlocked(&self) -> Result<(), String> {
        let mut journal = match OpenOptions::new().read(true).open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let length = journal.metadata().map_err(|error| error.to_string())?.len();
        if length == 0 {
            return Ok(());
        }
        journal
            .seek(SeekFrom::End(-1))
            .map_err(|error| error.to_string())?;
        let mut last_byte = [0_u8; 1];
        journal
            .read_exact(&mut last_byte)
            .map_err(|error| error.to_string())?;
        if last_byte == [b'\n'] {
            return Ok(());
        }
        journal
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(length as usize);
        journal
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;

        let boundary = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let prefix = &bytes[..boundary];
        self.read_canonical_bytes(prefix)?;
        let tail = &bytes[boundary..];

        // A complete JSON value without its newline may be an older journal
        // written before the terminator was flushed.  Preserve it and restore
        // the JSONL invariant; a semantically malformed value remains visible
        // to the normal WorkflowRun parser below and fails closed.
        if serde_json::from_slice::<serde_json::Value>(tail).is_ok() {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&self.path)
                .map_err(|error| error.to_string())?;
            file.write_all(b"\n").map_err(|error| error.to_string())?;
            file.flush().map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            return Ok(());
        }

        let file = OpenOptions::new()
            .write(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        file.set_len(boundary as u64)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    }

    fn append_record_unlocked(
        &self,
        run: &WorkflowRun,
        journal_existed: bool,
    ) -> Result<(), String> {
        let mut record = serde_json::to_vec(run).map_err(|error| error.to_string())?;
        record.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        file.write_all(&record).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if !journal_existed {
            sync_parent_directory(self.parent()?).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn append_expected_owned(
        &self,
        run: &WorkflowRun,
        expected_revision: Option<u64>,
        state: &mut OwnerState,
    ) -> Result<(), String> {
        validate_run_id(&run.id)?;
        let journal_existed = self.prepare_paths(true)?;
        let mut lock = self.open_journal_lock()?;
        let _guard = lock.write().map_err(|error| error.to_string())?;
        self.recover_torn_tail_unlocked()?;

        // The owner sidecar excludes every normal writer for this run for the
        // lifetime of this guard.  Validate the journal once on the first
        // append, then advance this in-memory predecessor after each durable
        // write instead of reparsing the growing JSONL history on every
        // transition.  Legacy/all-run reads still perform a complete replay
        // under the journal lock.
        if !state.initialized {
            let mut latest = self.read_canonical_unlocked()?;
            state.canonical = latest.remove(&run.id);
            state.initialized = true;
        }

        match (state.canonical.as_ref(), expected_revision) {
            (None, None) => {
                if run.revision != 0 {
                    return Err(format!(
                        "initial workflow journal revision must be 0, got {}",
                        run.revision
                    ));
                }
            }
            (None, Some(expected)) => {
                return Err(format!(
                    "workflow revision CAS failed for {}; expected predecessor {}, but no record exists",
                    run.id, expected
                ));
            }
            (Some(existing), None) => {
                if !immutable_identity_matches(&existing.run, run) {
                    return Err(format!("workflow run identity changed for {}", run.id));
                }
                if existing.run.revision == 0 && run.revision == 0 && run == &existing.run {
                    return Ok(());
                }
                return Err(format!(
                    "workflow revision CAS failed for {}; expected no predecessor, found {}",
                    run.id, existing.run.revision
                ));
            }
            (Some(existing), Some(expected)) => {
                if !immutable_identity_matches(&existing.run, run) {
                    return Err(format!("workflow run identity changed for {}", run.id));
                }
                if existing.run.revision != expected {
                    return Err(format!(
                        "workflow revision CAS failed for {}; expected {}, found {}",
                        run.id, expected, existing.run.revision
                    ));
                }
                if run.revision == expected && run == &existing.run {
                    return Ok(());
                }
                if run.revision <= expected {
                    return Err(format!(
                        "stale workflow journal revision {} for {}; latest is {}",
                        run.revision, run.id, expected
                    ));
                }
            }
        }
        self.append_record_unlocked(run, journal_existed)?;
        state.canonical = Some(CanonicalRun {
            run: run.clone(),
            revision_explicit: true,
        });
        Ok(())
    }

    fn append_legacy(&self, run: &WorkflowRun) -> Result<(), String> {
        validate_run_id(&run.id)?;
        let _owner_fence = self.acquire_legacy_fence(&run.id)?;
        let journal_existed = self.prepare_paths(true)?;
        let mut lock = self.open_journal_lock()?;
        let _guard = lock.write().map_err(|error| error.to_string())?;
        self.recover_torn_tail_unlocked()?;
        let latest = self.read_canonical_unlocked()?;
        if let Some(existing) = latest.get(&run.id) {
            if !immutable_identity_matches(&existing.run, run) {
                return Err(format!("workflow run identity changed for {}", run.id));
            }
            if run.revision == existing.run.revision && run == &existing.run {
                return Ok(());
            }
            if existing.revision_explicit {
                match run.revision.cmp(&existing.run.revision) {
                    std::cmp::Ordering::Less => {
                        return Err(format!(
                            "stale workflow journal revision {} for {}; latest is {}",
                            run.revision, run.id, existing.run.revision
                        ));
                    }
                    std::cmp::Ordering::Equal => {
                        return Err(format!(
                            "conflicting workflow journal evidence for {} at revision {}",
                            run.id, run.revision
                        ));
                    }
                    std::cmp::Ordering::Greater => {}
                }
            } else if run.revision == existing.run.revision && run != &existing.run {
                // A revision-0 compatibility write can migrate a historical
                // row.  Once an explicit row exists, equal revisions are
                // protected by the conflict check above.
                if run.revision != 0 {
                    return Err(format!(
                        "conflicting workflow journal evidence for {} at revision {}",
                        run.id, run.revision
                    ));
                }
            }
        }
        self.append_record_unlocked(run, journal_existed)
    }

    pub fn list(&self) -> Result<Vec<WorkflowRun>, String> {
        let journal_existed = self.prepare_paths(false)?;
        if !journal_existed {
            return Ok(Vec::new());
        }
        let mut lock = self.open_journal_lock()?;
        let _guard = lock.write().map_err(|error| error.to_string())?;
        self.recover_torn_tail_unlocked()?;
        let latest = self.read_canonical_unlocked()?;
        let mut runs = latest
            .into_values()
            .map(|record| record.run)
            .collect::<Vec<_>>();
        runs.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.revision.cmp(&a.revision))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(runs)
    }

    pub fn get(&self, id: &str) -> Result<WorkflowRun, String> {
        let runs = self.list()?;
        if let Some(run) = runs.iter().find(|run| run.id == id) {
            return Ok(run.clone());
        }
        let matches = runs
            .into_iter()
            .filter(|run| run.id.starts_with(id))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [run] => Ok(run.clone()),
            [] => Err(format!("workflow run not found: {id}")),
            _ => Err(format!("workflow run id is ambiguous: {id}")),
        }
    }

    pub fn append(&self, run: &WorkflowRun) -> Result<(), String> {
        self.append_legacy(run)
    }

    /// Append a compatibility record while rejecting stale or conflicting
    /// revisions.  This method does not establish ownership and is fenced
    /// against an active CLI owner; native workflow execution should use
    /// [`WorkflowRunOwner::append_expected`] instead.
    pub fn append_monotonic(&self, run: &WorkflowRun) -> Result<(), String> {
        self.append_legacy(run)
    }

    pub fn dashboard(&self) -> Result<BTreeMap<String, Vec<WorkflowRun>>, String> {
        let mut groups = BTreeMap::<String, Vec<WorkflowRun>>::new();
        for run in self.list()? {
            let group = match run.status {
                WorkflowRunStatus::Running => "running",
                WorkflowRunStatus::NeedsInput => "needs_input",
                WorkflowRunStatus::Blocked | WorkflowRunStatus::Paused => "blocked",
                WorkflowRunStatus::Failed => "failed",
                WorkflowRunStatus::Complete | WorkflowRunStatus::Stopped => "complete",
            };
            groups.entry(group.to_string()).or_default().push(run);
        }
        Ok(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> WorkflowSpec {
        WorkflowSpec {
            name: "verified-research".to_string(),
            version: "1".to_string(),
            steps: vec![WorkflowStep {
                id: "research".to_string(),
                prompt: "Gather sourced claims".to_string(),
                depends_on: Vec::new(),
                files: Vec::new(),
            }],
            max_agents: 3,
            max_concurrency: 2,
            token_budget: 10_000,
            replay_safe: false,
            model: WorkflowModelConfig::default(),
            allowed_tools: Vec::new(),
            write_scopes: Vec::new(),
            verification: Vec::new(),
        }
    }

    #[test]
    fn resume_rejects_changed_spec_or_arguments() {
        let args = serde_json::json!({"topic": "compaction"});
        let mut run = WorkflowRun::start(spec(), args.clone()).unwrap();
        run.pause().unwrap();
        assert!(run.resume("wrong", &args).is_err());
        assert!(
            run.resume(
                &run.spec_sha.clone(),
                &serde_json::json!({"topic": "other"})
            )
            .is_err()
        );
        run.resume(&run.spec_sha.clone(), &args).unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Running);
    }

    #[test]
    fn cumulative_budgets_fail_closed() {
        let mut run = WorkflowRun::start(spec(), serde_json::json!({})).unwrap();
        run.record_usage(2, 2, 9_000).unwrap();
        assert!(run.record_usage(2, 1, 100).is_err());
        assert_eq!(run.status, WorkflowRunStatus::Failed);
    }

    #[test]
    fn cyclic_dependencies_are_rejected() {
        let mut spec = spec();
        spec.steps = vec![
            WorkflowStep {
                id: "a".to_string(),
                prompt: "A".to_string(),
                depends_on: vec!["b".to_string()],
                files: Vec::new(),
            },
            WorkflowStep {
                id: "b".to_string(),
                prompt: "B".to_string(),
                depends_on: vec!["a".to_string()],
                files: Vec::new(),
            },
        ];
        assert!(WorkflowRun::start(spec, serde_json::json!({})).is_err());
    }

    #[test]
    fn store_replays_latest_snapshot_and_groups_dashboard() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let mut run = WorkflowRun::start(spec(), serde_json::json!({})).unwrap();
        store.append(&run).unwrap();
        run.pause().unwrap();
        store.append(&run).unwrap();

        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(
            store.get(&run.id).unwrap().status,
            WorkflowRunStatus::Paused
        );
        assert_eq!(store.dashboard().unwrap()["blocked"].len(), 1);
    }
}

#[cfg(test)]
mod workflow_store_tests {
    use super::*;
    use std::thread;

    fn spec() -> WorkflowSpec {
        WorkflowSpec {
            name: "store-concurrency".to_string(),
            version: "1".to_string(),
            steps: vec![WorkflowStep {
                id: "step".to_string(),
                prompt: "exercise the journal".to_string(),
                depends_on: Vec::new(),
                files: Vec::new(),
            }],
            max_agents: 2,
            max_concurrency: 1,
            token_budget: 100,
            replay_safe: true,
            model: WorkflowModelConfig::default(),
            allowed_tools: Vec::new(),
            write_scopes: Vec::new(),
            verification: Vec::new(),
        }
    }

    fn run() -> WorkflowRun {
        WorkflowRun::start(spec(), serde_json::json!({"input": "value"})).unwrap()
    }

    fn write_records(path: &Path, records: &[WorkflowRun]) {
        let contents = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(path, format!("{contents}\n")).unwrap();
    }

    const LEGACY_RUNNING: &str = r#"{"id":"legacy-run","spec":{"name":"legacy","version":"1","steps":[{"id":"step","prompt":"exercise the journal"}],"maxAgents":2,"maxConcurrency":1,"tokenBudget":100,"replaySafe":false},"specSha":"legacy-spec-sha","args":{"input":"value"},"status":"running","agentsStarted":0,"activeAgents":0,"tokensUsed":0,"ownerProcessId":1,"createdAt":"2026-09-10T00:00:00Z","updatedAt":"2026-09-10T00:00:00Z","statusReason":null}"#;

    const LEGACY_PAUSED: &str = r#"{"id":"legacy-run","spec":{"name":"legacy","version":"1","steps":[{"id":"step","prompt":"exercise the journal"}],"maxAgents":2,"maxConcurrency":1,"tokenBudget":100,"replaySafe":false},"specSha":"legacy-spec-sha","args":{"input":"value"},"status":"paused","agentsStarted":0,"activeAgents":0,"tokensUsed":0,"ownerProcessId":1,"createdAt":"2026-09-10T00:00:00Z","updatedAt":"2026-09-10T00:00:01Z","statusReason":null}"#;

    #[test]
    fn legacy_revision_zero_cannot_regress_canonical_revision_two() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let mut current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();
        current.revision = 2;
        owner.append_expected(&current, Some(0)).unwrap();
        drop(owner);

        let mut stale = current.clone();
        stale.revision = 0;
        assert!(store.append(&stale).is_err());
        assert_eq!(store.get(&current.id).unwrap().revision, 2);
    }

    #[test]
    fn expected_predecessor_is_checked_against_canonical_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let mut current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();

        current.revision = 2;
        owner.append_expected(&current, Some(0)).unwrap();
        current.revision = 3;
        assert!(owner.append_expected(&current, Some(1)).is_err());
        assert_eq!(store.get(&current.id).unwrap().revision, 2);
    }

    #[test]
    fn only_one_process_can_acquire_a_run_owner() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        let contender_store = store.clone();
        let run_id = current.id.clone();
        let contender = thread::spawn(move || contender_store.acquire_run_owner(&run_id));
        assert!(contender.join().unwrap().is_err());
        drop(owner);
        assert!(store.acquire_run_owner(&current.id).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_fence_drop_releases_lock_with_duplicated_handle_alive() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let current = run();
        let fence = store.acquire_legacy_fence(&current.id).unwrap();
        let duplicate = fence.file.try_clone().unwrap();

        assert!(store.acquire_legacy_fence(&current.id).is_err());
        assert!(store.acquire_run_owner(&current.id).is_err());
        drop(fence);

        let next_fence = store.acquire_legacy_fence(&current.id).unwrap();
        assert!(store.acquire_run_owner(&current.id).is_err());
        drop(next_fence);
        let next_owner = store.acquire_run_owner(&current.id).unwrap();
        drop(next_owner);
        drop(duplicate);
    }

    #[cfg(unix)]
    #[test]
    fn run_owner_drop_releases_lock_with_duplicated_handle_alive() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        let duplicate = owner._lock.file.try_clone().unwrap();

        assert!(store.acquire_run_owner(&current.id).is_err());
        assert!(store.acquire_legacy_fence(&current.id).is_err());
        drop(owner);

        let next_owner = store.acquire_run_owner(&current.id).unwrap();
        assert!(store.acquire_legacy_fence(&current.id).is_err());
        drop(next_owner);
        let next_fence = store.acquire_legacy_fence(&current.id).unwrap();
        drop(next_fence);
        drop(duplicate);
    }

    #[test]
    fn exact_owned_duplicate_is_idempotent_but_conflicting_evidence_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        let current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();
        owner.append_expected(&current, None).unwrap();
        let line_count = fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(line_count, 1);

        let mut conflicting = current.clone();
        conflicting.status = WorkflowRunStatus::Paused;
        assert!(owner.append_expected(&conflicting, None).is_err());
        assert_eq!(store.get(&current.id).unwrap().status, current.status);
    }

    #[test]
    fn reads_highest_revision_even_when_a_stale_record_is_physical_last() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        let mut high = run();
        high.revision = 2;
        let mut low = high.clone();
        low.revision = 1;
        write_records(&path, &[high.clone(), low]);

        assert_eq!(store.list().unwrap()[0].revision, high.revision);
        assert_eq!(store.get(&high.id).unwrap().revision, high.revision);
    }

    #[test]
    fn revisionless_legacy_lifecycle_rows_remain_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        fs::write(&path, format!("{LEGACY_RUNNING}\n{LEGACY_PAUSED}\n")).unwrap();

        let runs = store.list().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, "legacy-run");
        assert_eq!(runs[0].status, WorkflowRunStatus::Paused);
        assert_eq!(runs[0].revision, 0);
    }

    #[test]
    fn legacy_append_can_migrate_a_revisionless_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        fs::write(&path, format!("{LEGACY_RUNNING}\n")).unwrap();
        let mut migrated = store.get("legacy-run").unwrap();
        migrated.status = WorkflowRunStatus::Paused;
        store.append(&migrated).unwrap();

        assert_eq!(
            store.get("legacy-run").unwrap().status,
            WorkflowRunStatus::Paused
        );
        assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 2);
    }

    #[test]
    fn stale_revisionless_row_cannot_regress_an_explicit_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        let mut current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();
        current.revision = 2;
        owner.append_expected(&current, Some(0)).unwrap();
        drop(owner);

        let mut legacy = serde_json::to_value(&current).unwrap();
        legacy.as_object_mut().unwrap().remove("revision");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        serde_json::to_writer(&mut file, &legacy).unwrap();
        writeln!(file).unwrap();

        assert_eq!(store.get(&current.id).unwrap().revision, 2);
    }

    #[test]
    fn conflicting_same_revision_evidence_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        let first = run();
        let mut second = first.clone();
        second.status = WorkflowRunStatus::Paused;
        write_records(&path, &[first, second]);

        assert!(store.list().is_err());
    }

    #[test]
    fn run_identity_cannot_change_at_a_later_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();

        let mut changed = current.clone();
        changed.revision = 1;
        changed.spec.name = "different-workflow".to_string();
        assert!(owner.append_expected(&changed, Some(0)).is_err());
    }

    #[test]
    fn torn_final_append_is_repaired_and_later_append_is_safe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runs.jsonl");
        let store = WorkflowStore::with_path(path.clone());
        let mut current = run();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, None).unwrap();
        drop(owner);

        // Simulate a process dying while the serialized record is still being
        // written.  The first snapshot is durable and ends at a valid newline;
        // only this incomplete tail may be discarded during recovery.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"id":"torn""#).unwrap();
        file.sync_all().unwrap();

        assert_eq!(store.get(&current.id).unwrap().revision, 0);
        assert!(fs::read(&path).unwrap().ends_with(b"\n"));

        current.pause().unwrap();
        let owner = store.acquire_run_owner(&current.id).unwrap();
        owner.append_expected(&current, Some(0)).unwrap();
        drop(owner);
        assert_eq!(
            store.get(&current.id).unwrap().status,
            WorkflowRunStatus::Paused
        );
        assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_journal_paths_are_rejected() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.jsonl");
        fs::File::create(&target).unwrap();
        let path = dir.path().join("runs.jsonl");
        symlink(&target, &path).unwrap();
        let store = WorkflowStore::with_path(path);
        assert!(store.list().is_err());
        assert!(store.acquire_run_owner("run-id").is_err());
    }
}

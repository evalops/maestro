//! Owner supplied checkpoint and recovery contracts for dynamic swarms.
//!
//! A [`SwarmSnapshot`] is an immutable value returned to the execution owner.
//! The scheduler can produce and validate snapshots, but it never stores them
//! outside its process and it never decides whether an interrupted callback
//! may be replayed.  The owner supplies that decision through
//! [`SwarmRecoveryHooks`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::expansion::SwarmTaskOutcome;
use crate::types::{
    SwarmConfig, SwarmPlan, SwarmState, SwarmStatus, TaskId, TaskResult, TaskStatus,
};

/// Version of the serialized swarm checkpoint contract.
pub const SWARM_SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// Identity of one callback admission.
pub type DispatchId = String;

/// A callback that was reserved by the scheduler when a snapshot was taken.
///
/// The reservation is written before the callback starts.  If the process
/// exits after this point, the owner must reconcile this exact dispatch before
/// allowing the task to run again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InFlightTask {
    /// Task identity in the immutable graph.
    pub task_id: TaskId,
    /// Runtime agent assigned to this dispatch.
    pub agent_id: String,
    /// Stable identity for the callback attempt.
    pub dispatch_id: DispatchId,
}

/// A callback that an owner chose to leave unresolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndeterminateTask {
    /// Task identity in the immutable graph.
    pub task_id: TaskId,
    /// Runtime agent assigned to the interrupted dispatch.
    pub agent_id: String,
    /// Stable identity for the interrupted callback attempt.
    pub dispatch_id: DispatchId,
    /// Owner supplied explanation for why the task remains unresolved.
    pub reason: String,
}

/// Owner decision for one persisted in-flight dispatch.
///
/// `Retry` is an explicit owner operation.  The scheduler never infers that
/// a callback is safe to replay from a timeout, process restart, or unknown
/// remote result.  `Reconcile` means the owner has authoritative evidence for
/// the callback result.  `ReconcileOutcome` additionally carries an already
/// accepted expansion for a callback that completed before its checkpoint
/// was written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", content = "value", rename_all = "snake_case")]
pub enum RecoveryDecision {
    /// Adopt an owner-confirmed task result without invoking the callback.
    Reconcile(TaskResult),
    /// Adopt an owner-confirmed result and its already accepted child graph.
    ReconcileOutcome(SwarmTaskOutcome),
    /// Explicitly allow a new callback dispatch for the task.
    Retry,
    /// Permanently fail the task with an owner supplied reason.
    Fail(String),
    /// Skip the task and its downstream consumers.
    Skip(String),
    /// Keep the task unresolved.  This never unlocks dependents.
    KeepIndeterminate(String),
}

impl RecoveryDecision {
    /// Construct a confirmed result decision.
    #[must_use]
    pub fn reconcile(result: TaskResult) -> Self {
        Self::Reconcile(result)
    }

    /// Construct a confirmed result plus accepted expansion decision.
    #[must_use]
    pub fn reconcile_outcome(outcome: SwarmTaskOutcome) -> Self {
        Self::ReconcileOutcome(outcome)
    }

    /// Construct an explicit retry decision.
    #[must_use]
    pub const fn retry() -> Self {
        Self::Retry
    }

    /// Construct a permanent failure decision.
    #[must_use]
    pub fn fail(reason: impl Into<String>) -> Self {
        Self::Fail(reason.into())
    }

    /// Construct a skip decision.
    #[must_use]
    pub fn skip(reason: impl Into<String>) -> Self {
        Self::Skip(reason.into())
    }

    /// Construct an indeterminate decision.
    #[must_use]
    pub fn keep_indeterminate(reason: impl Into<String>) -> Self {
        Self::KeepIndeterminate(reason.into())
    }
}

/// A complete owner-persistable view of a swarm transition.
///
/// Snapshots contain the expanded graph and every accepted result together so
/// a restored scheduler can reconstruct completed work without invoking those
/// callbacks again.  `graph_digest` and `result_digest` detect accidental or
/// partial snapshot mutations during serialization and restore.  They are
/// integrity checks, not an authorization boundary; durable owners remain
/// responsible for authenticating and accepting their journal records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwarmSnapshot {
    /// Serialized checkpoint schema version.
    pub schema_version: u32,
    /// Stable identity shared by every checkpoint for this run.
    pub run_id: String,
    /// Monotonic scheduler transition revision.
    pub revision: u64,
    /// Total task budget for the lifetime of this run.
    pub task_budget: usize,
    /// Expanded graph, including task results and statuses.
    pub plan: SwarmPlan,
    /// Successful results accepted by the scheduler, keyed by task ID.
    pub completed_tasks: BTreeMap<TaskId, TaskResult>,
    /// Failed results accepted by the scheduler, keyed by task ID.
    pub failed_tasks: BTreeMap<TaskId, TaskResult>,
    /// Callback reservations that had not produced an accepted result.
    pub in_flight: Vec<InFlightTask>,
    /// Owner decisions that leave a task unresolved.
    #[serde(default)]
    pub indeterminate_tasks: BTreeMap<TaskId, IndeterminateTask>,
    /// Scheduler status at the checkpoint boundary.
    pub status: SwarmStatus,
    /// Scheduler configuration used for resumed execution.
    pub config: SwarmConfig,
    /// Original start time, when execution has begun.
    #[serde(default)]
    pub started_at: Option<u64>,
    /// Stable digest of graph identity and dependency data.
    pub graph_digest: String,
    /// Stable digest of statuses, results, reservations, and revision.
    pub result_digest: String,
}

impl SwarmSnapshot {
    /// Validate graph, result, reservation, budget, and digest consistency.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SWARM_SNAPSHOT_SCHEMA_VERSION {
            bail!(
                "Unsupported swarm snapshot schema version {}",
                self.schema_version
            );
        }
        if self.run_id.trim().is_empty() {
            bail!("Swarm snapshot run ID must not be empty");
        }
        if self.task_budget == 0 {
            bail!("Swarm snapshot task budget must be positive");
        }
        if self.plan.tasks.len() > self.task_budget {
            bail!(
                "Swarm snapshot graph has {} tasks but budget is {}",
                self.plan.tasks.len(),
                self.task_budget
            );
        }
        if self.config.max_concurrency == 0 {
            bail!("Swarm snapshot concurrency must be positive");
        }
        crate::plan_parser::validate_plan(&self.plan)?;

        let task_ids: HashSet<&str> = self
            .plan
            .tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect();
        let mut in_flight_by_id = HashMap::new();
        for reservation in &self.in_flight {
            if reservation.task_id.trim().is_empty()
                || reservation.agent_id.trim().is_empty()
                || reservation.dispatch_id.trim().is_empty()
            {
                bail!("Swarm snapshot contains an incomplete in-flight reservation");
            }
            if !task_ids.contains(reservation.task_id.as_str()) {
                bail!(
                    "In-flight reservation references unknown task '{}'",
                    reservation.task_id
                );
            }
            if in_flight_by_id
                .insert(reservation.task_id.as_str(), reservation)
                .is_some()
            {
                bail!(
                    "Swarm snapshot contains duplicate in-flight task '{}'",
                    reservation.task_id
                );
            }
        }

        for (task_id, indeterminate) in &self.indeterminate_tasks {
            if task_id.trim().is_empty()
                || indeterminate.task_id != *task_id
                || indeterminate.agent_id.trim().is_empty()
                || indeterminate.dispatch_id.trim().is_empty()
                || indeterminate.reason.trim().is_empty()
            {
                bail!("Swarm snapshot contains an incomplete indeterminate task");
            }
            if !task_ids.contains(task_id.as_str()) {
                bail!("Indeterminate task references unknown task '{}'", task_id);
            }
            if in_flight_by_id.contains_key(task_id.as_str()) {
                bail!(
                    "Task '{}' cannot be both in-flight and indeterminate",
                    task_id
                );
            }
        }

        for (task_id, result) in &self.completed_tasks {
            let Some(task) = self.plan.get_task(task_id) else {
                bail!("Completed result references unknown task '{task_id}'");
            };
            if !result.success
                || task.status != TaskStatus::Completed
                || task.result.as_ref() != Some(result)
            {
                bail!("Completed result is inconsistent for task '{task_id}'");
            }
            if self.failed_tasks.contains_key(task_id)
                || in_flight_by_id.contains_key(task_id.as_str())
                || self.indeterminate_tasks.contains_key(task_id)
            {
                bail!("Task '{task_id}' has conflicting snapshot outcomes");
            }
        }

        for (task_id, result) in &self.failed_tasks {
            let Some(task) = self.plan.get_task(task_id) else {
                bail!("Failed result references unknown task '{task_id}'");
            };
            if result.success
                || task.status != TaskStatus::Failed
                || task.result.as_ref() != Some(result)
            {
                bail!("Failed result is inconsistent for task '{task_id}'");
            }
            if in_flight_by_id.contains_key(task_id.as_str())
                || self.indeterminate_tasks.contains_key(task_id)
            {
                bail!("Task '{task_id}' has conflicting snapshot outcomes");
            }
        }

        for task in &self.plan.tasks {
            let completed = self.completed_tasks.contains_key(&task.id);
            let failed = self.failed_tasks.contains_key(&task.id);
            let in_flight = in_flight_by_id.get(task.id.as_str());
            let indeterminate = self.indeterminate_tasks.contains_key(&task.id);
            match task.status {
                TaskStatus::Completed => {
                    if !completed || failed || in_flight.is_some() || indeterminate {
                        bail!(
                            "Completed task '{}' has inconsistent snapshot state",
                            task.id
                        );
                    }
                    if task.assigned_agent.is_some() {
                        bail!("Completed task '{}' retains an assigned agent", task.id);
                    }
                }
                TaskStatus::Failed => {
                    if !failed || completed || in_flight.is_some() || indeterminate {
                        bail!("Failed task '{}' has inconsistent snapshot state", task.id);
                    }
                    if task.assigned_agent.is_some() {
                        bail!("Failed task '{}' retains an assigned agent", task.id);
                    }
                }
                TaskStatus::Running => {
                    let Some(in_flight) = in_flight else {
                        bail!(
                            "Running task '{}' is missing its in-flight reservation",
                            task.id
                        );
                    };
                    if completed || failed || indeterminate {
                        bail!("Running task '{}' has a conflicting result", task.id);
                    }
                    if task.result.is_some() {
                        bail!("Running task '{}' has a stale result", task.id);
                    }
                    if task.assigned_agent.as_deref() != Some(in_flight.agent_id.as_str()) {
                        bail!("Running task '{}' has a mismatched assigned agent", task.id);
                    }
                }
                TaskStatus::Blocked => {
                    if completed || failed || in_flight.is_some() {
                        bail!("Blocked task '{}' has a conflicting result", task.id);
                    }
                    if indeterminate && task.assigned_agent.is_some() {
                        bail!("Indeterminate task '{}' retains an assigned agent", task.id);
                    }
                    if task.assigned_agent.is_some() || task.result.is_some() {
                        bail!("Blocked task '{}' has stale execution data", task.id);
                    }
                    if !indeterminate {
                        bail!(
                            "Blocked task '{}' is missing its indeterminate recovery record",
                            task.id
                        );
                    }
                }
                TaskStatus::Pending | TaskStatus::Skipped => {
                    if completed || failed || in_flight.is_some() || indeterminate {
                        bail!(
                            "{} task '{}' has a conflicting result",
                            status_name(task.status),
                            task.id
                        );
                    }
                    if task.assigned_agent.is_some() || task.result.is_some() {
                        bail!(
                            "{} task '{}' has stale execution data",
                            status_name(task.status),
                            task.id
                        );
                    }
                }
            }
        }

        match self.status {
            SwarmStatus::Completed => {
                if self
                    .plan
                    .tasks
                    .iter()
                    .any(|task| task.status != TaskStatus::Completed)
                    || !self.failed_tasks.is_empty()
                    || !self.in_flight.is_empty()
                    || !self.indeterminate_tasks.is_empty()
                {
                    bail!("Completed snapshot still contains unfinished work");
                }
            }
            SwarmStatus::Initializing => {
                if self.revision != 0
                    || !self.in_flight.is_empty()
                    || !self.indeterminate_tasks.is_empty()
                    || !self.completed_tasks.is_empty()
                    || !self.failed_tasks.is_empty()
                    || self
                        .plan
                        .tasks
                        .iter()
                        .any(|task| task.status != TaskStatus::Pending)
                {
                    bail!("Initializing snapshot contains execution state");
                }
            }
            SwarmStatus::Running
            | SwarmStatus::Planning
            | SwarmStatus::Cancelled
            | SwarmStatus::Failed => {}
        }

        let expected_graph = compute_graph_digest(&self.plan);
        if self.graph_digest != expected_graph {
            bail!("Swarm snapshot graph digest does not match its graph");
        }
        let expected_result = result_digest(self);
        if self.result_digest != expected_result {
            bail!("Swarm snapshot result digest does not match its results");
        }
        Ok(())
    }

    /// Return the IDs of callbacks that require owner reconciliation.
    #[must_use]
    pub fn in_flight_task_ids(&self) -> Vec<TaskId> {
        self.in_flight
            .iter()
            .map(|task| task.task_id.clone())
            .collect()
    }

    /// Build an owner snapshot from scheduler state.
    pub(crate) fn from_state(run_id: &str, state: &SwarmState) -> Self {
        // The state keeps accepted results in ordered maps alongside the ID
        // sets used by the scheduler. Cloning those maps avoids a linear plan
        // lookup and tree insertion for every task on every checkpoint.
        let completed_tasks =
            if !state.completed_results.is_empty() || state.completed_tasks.is_empty() {
                state.completed_results.clone()
            } else {
                result_map_from_plan(&state.plan, &state.completed_tasks)
            };
        let failed_tasks = if !state.failed_results.is_empty() || state.failed_tasks.is_empty() {
            state.failed_results.clone()
        } else {
            result_map_from_plan(&state.plan, &state.failed_tasks)
        };
        let mut in_flight: Vec<_> = state
            .running_tasks
            .iter()
            .filter_map(|(task_id, agent_id)| {
                state
                    .running_dispatches
                    .get(task_id)
                    .map(|dispatch_id| InFlightTask {
                        task_id: task_id.clone(),
                        agent_id: agent_id.clone(),
                        dispatch_id: dispatch_id.clone(),
                    })
            })
            .collect();
        in_flight.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        let indeterminate_tasks = state
            .indeterminate_tasks
            .iter()
            .map(|(task_id, task)| (task_id.clone(), task.clone()))
            .collect();
        let mut snapshot = Self {
            schema_version: SWARM_SNAPSHOT_SCHEMA_VERSION,
            run_id: run_id.to_owned(),
            revision: state.revision,
            task_budget: state.task_budget,
            plan: state.plan.clone(),
            completed_tasks,
            failed_tasks,
            in_flight,
            indeterminate_tasks,
            status: state.status,
            config: state.config.clone(),
            started_at: state.started_at,
            graph_digest: String::new(),
            result_digest: String::new(),
        };
        snapshot.graph_digest = if state.graph_digest.is_empty() {
            compute_graph_digest(&snapshot.plan)
        } else {
            state.graph_digest.clone()
        };
        snapshot.result_digest = result_digest(&snapshot);
        snapshot
    }
}

fn result_map_from_plan(
    plan: &SwarmPlan,
    task_ids: &std::collections::HashSet<TaskId>,
) -> BTreeMap<TaskId, TaskResult> {
    plan.tasks
        .iter()
        .filter(|task| task_ids.contains(&task.id))
        .filter_map(|task| task.result.clone().map(|result| (task.id.clone(), result)))
        .collect()
}

fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "Pending",
        TaskStatus::Blocked => "Blocked",
        TaskStatus::Running => "Running",
        TaskStatus::Completed => "Completed",
        TaskStatus::Failed => "Failed",
        TaskStatus::Skipped => "Skipped",
    }
}

pub(crate) fn compute_graph_digest(plan: &SwarmPlan) -> String {
    let mut digest = Sha256::new();
    hash_str(&mut digest, &plan.title);
    hash_str(&mut digest, &plan.goal);
    hash_usize(&mut digest, plan.max_concurrency);
    hash_bool(&mut digest, plan.continue_on_failure);
    for task in &plan.tasks {
        hash_str(&mut digest, &task.id);
        hash_str(&mut digest, &task.title);
        hash_str(&mut digest, &task.description);
        hash_u8(&mut digest, task.priority as u8);
        hash_strings(&mut digest, &task.dependencies);
        hash_u8(&mut digest, task.complexity);
        hash_strings(&mut digest, &task.files);
        hash_strings(&mut digest, &task.tags);
    }
    finish_digest(digest)
}

fn result_digest(snapshot: &SwarmSnapshot) -> String {
    // Plan order is immutable between snapshots except for append-only graph
    // expansion, so it is already a stable ordering. Avoid sorting every task
    // for every checkpoint in a large dynamic workflow.
    let mut in_flight = snapshot.in_flight.clone();
    in_flight.sort_by(|left, right| left.task_id.cmp(&right.task_id));
    let mut digest = Sha256::new();
    hash_u32(&mut digest, snapshot.schema_version);
    hash_str(&mut digest, &snapshot.run_id);
    hash_u64(&mut digest, snapshot.revision);
    hash_usize(&mut digest, snapshot.task_budget);
    hash_config(&mut digest, &snapshot.config);
    hash_optional_u64(&mut digest, snapshot.started_at);
    hash_status(&mut digest, snapshot.status);
    for task in &snapshot.plan.tasks {
        hash_str(&mut digest, &task.id);
        hash_task_status(&mut digest, task.status);
        hash_optional_str(&mut digest, task.assigned_agent.as_deref());
    }
    hash_usize(&mut digest, snapshot.completed_tasks.len());
    for (task_id, result) in &snapshot.completed_tasks {
        hash_u8(&mut digest, 0);
        hash_str(&mut digest, task_id);
        hash_result(&mut digest, result);
    }
    hash_usize(&mut digest, snapshot.failed_tasks.len());
    for (task_id, result) in &snapshot.failed_tasks {
        hash_u8(&mut digest, 1);
        hash_str(&mut digest, task_id);
        hash_result(&mut digest, result);
    }
    hash_usize(&mut digest, in_flight.len());
    for reservation in in_flight {
        hash_u8(&mut digest, 2);
        hash_str(&mut digest, &reservation.task_id);
        hash_str(&mut digest, &reservation.agent_id);
        hash_str(&mut digest, &reservation.dispatch_id);
    }
    hash_usize(&mut digest, snapshot.indeterminate_tasks.len());
    for (task_id, task) in &snapshot.indeterminate_tasks {
        hash_u8(&mut digest, 3);
        hash_str(&mut digest, task_id);
        hash_str(&mut digest, &task.task_id);
        hash_str(&mut digest, &task.agent_id);
        hash_str(&mut digest, &task.dispatch_id);
        hash_str(&mut digest, &task.reason);
    }
    finish_digest(digest)
}

fn hash_str(digest: &mut Sha256, value: &str) {
    hash_usize(digest, value.len());
    digest.update(value.as_bytes());
}

fn hash_strings(digest: &mut Sha256, values: &[String]) {
    hash_usize(digest, values.len());
    for value in values {
        hash_str(digest, value);
    }
}

fn hash_optional_str(digest: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hash_bool(digest, true);
            hash_str(digest, value);
        }
        None => hash_bool(digest, false),
    }
}

fn hash_result(digest: &mut Sha256, result: &TaskResult) {
    hash_bool(digest, result.success);
    hash_str(digest, &result.output);
    hash_strings(digest, &result.files_modified);
    hash_u64(digest, result.duration_ms);
    hash_optional_str(digest, result.error.as_deref());
}

fn hash_status(digest: &mut Sha256, status: SwarmStatus) {
    hash_u8(
        digest,
        match status {
            SwarmStatus::Initializing => 0,
            SwarmStatus::Planning => 1,
            SwarmStatus::Running => 2,
            SwarmStatus::Completed => 3,
            SwarmStatus::Cancelled => 4,
            SwarmStatus::Failed => 5,
        },
    );
}

fn hash_task_status(digest: &mut Sha256, status: TaskStatus) {
    hash_u8(
        digest,
        match status {
            TaskStatus::Pending => 0,
            TaskStatus::Blocked => 1,
            TaskStatus::Running => 2,
            TaskStatus::Completed => 3,
            TaskStatus::Failed => 4,
            TaskStatus::Skipped => 5,
        },
    );
}

fn hash_bool(digest: &mut Sha256, value: bool) {
    hash_u8(digest, u8::from(value));
}

fn hash_u8(digest: &mut Sha256, value: u8) {
    digest.update([value]);
}

fn hash_u64(digest: &mut Sha256, value: u64) {
    digest.update(value.to_le_bytes());
}

fn hash_optional_u64(digest: &mut Sha256, value: Option<u64>) {
    match value {
        Some(value) => {
            hash_bool(digest, true);
            hash_u64(digest, value);
        }
        None => hash_bool(digest, false),
    }
}

fn hash_u32(digest: &mut Sha256, value: u32) {
    digest.update(value.to_le_bytes());
}

fn hash_usize(digest: &mut Sha256, value: usize) {
    hash_u64(digest, value as u64);
}

fn hash_config(digest: &mut Sha256, config: &SwarmConfig) {
    hash_usize(digest, config.max_concurrency);
    hash_bool(digest, config.continue_on_failure);
    match config.task_timeout_ms {
        Some(timeout) => {
            hash_bool(digest, true);
            hash_u64(digest, timeout);
        }
        None => hash_bool(digest, false),
    }
    hash_optional_str(digest, config.model.as_deref());
    hash_optional_str(digest, config.system_prompt.as_deref());
    hash_optional_debug(digest, config.mode.as_ref());
    hash_optional_debug(digest, config.model_provider.as_ref());
    hash_optional_debug(digest, config.subagent_type.as_ref());
    hash_optional_debug(digest, config.reasoning_effort.as_ref());
}

fn hash_optional_debug<T: std::fmt::Debug>(digest: &mut Sha256, value: Option<&T>) {
    match value {
        Some(value) => {
            hash_bool(digest, true);
            hash_str(digest, &format!("{value:?}"));
        }
        None => hash_bool(digest, false),
    }
}

fn finish_digest(digest: Sha256) -> String {
    let bytes = digest.finalize();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

/// The boxed future returned by an owner snapshot hook.
pub type SnapshotFuture = Pin<Box<dyn Future<Output = Result<()>> + Send + 'static>>;

/// The boxed future returned by an owner reconciliation hook.
pub type ReconcileFuture = Pin<Box<dyn Future<Output = Result<RecoveryDecision>> + Send + 'static>>;

type PersistCallback = Arc<dyn Fn(SwarmSnapshot) -> SnapshotFuture + Send + Sync>;
type ReconcileCallback = Arc<dyn Fn(InFlightTask) -> ReconcileFuture + Send + Sync>;

/// Owner callback hooks for checkpoint persistence and crash recovery.
///
/// The scheduler invokes `persist` while transitions are serialized.  The
/// callback must durably accept or reject the supplied immutable value before
/// returning.  `reconcile` is called only for reservations restored from a
/// snapshot; returning [`RecoveryDecision::Retry`] is the owner's explicit
/// authorization for a new callback attempt.
#[derive(Clone)]
pub struct SwarmRecoveryHooks {
    persist_callback: PersistCallback,
    reconcile_callback: ReconcileCallback,
    /// Compatibility runs can opt out of snapshot construction entirely.
    /// Owner supplied hooks always enable checkpointing.
    checkpointing_enabled: bool,
}

impl std::fmt::Debug for SwarmRecoveryHooks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SwarmRecoveryHooks")
            .finish_non_exhaustive()
    }
}

impl SwarmRecoveryHooks {
    /// Create hooks from async owner callbacks.
    pub fn new<P, PF, R, RF>(persist: P, reconcile: R) -> Self
    where
        P: Fn(SwarmSnapshot) -> PF + Send + Sync + 'static,
        PF: Future<Output = Result<()>> + Send + 'static,
        R: Fn(InFlightTask) -> RF + Send + Sync + 'static,
        RF: Future<Output = Result<RecoveryDecision>> + Send + 'static,
    {
        Self {
            persist_callback: Arc::new(move |snapshot| Box::pin(persist(snapshot))),
            reconcile_callback: Arc::new(move |task| Box::pin(reconcile(task))),
            checkpointing_enabled: true,
        }
    }

    /// Create persistence-only hooks.  Restored in-flight work receives a
    /// conservative indeterminate decision and therefore cannot be replayed.
    pub fn persist_only<P, PF>(persist: P) -> Self
    where
        P: Fn(SwarmSnapshot) -> PF + Send + Sync + 'static,
        PF: Future<Output = Result<()>> + Send + 'static,
    {
        Self::new(persist, |_task| async {
            Ok(RecoveryDecision::KeepIndeterminate(
                "No reconciliation decision supplied".to_string(),
            ))
        })
    }

    /// Create no-op persistence hooks with a fail-closed recovery decision.
    #[must_use]
    pub fn noop() -> Self {
        Self {
            persist_callback: Arc::new(|_snapshot| Box::pin(async { Ok(()) })),
            reconcile_callback: Arc::new(|_task| {
                Box::pin(async {
                    Ok(RecoveryDecision::KeepIndeterminate(
                        "No recovery decision supplied".to_string(),
                    ))
                })
            }),
            checkpointing_enabled: false,
        }
    }

    pub(crate) fn checkpointing_enabled(&self) -> bool {
        self.checkpointing_enabled
    }

    pub(crate) async fn persist(&self, snapshot: SwarmSnapshot) -> Result<()> {
        (self.persist_callback)(snapshot).await
    }

    pub(crate) async fn reconcile(&self, task: InFlightTask) -> Result<RecoveryDecision> {
        (self.reconcile_callback)(task).await
    }
}

impl Default for SwarmRecoveryHooks {
    fn default() -> Self {
        Self::noop()
    }
}

impl From<&SwarmRecoveryHooks> for SwarmRecoveryHooks {
    fn from(hooks: &SwarmRecoveryHooks) -> Self {
        hooks.clone()
    }
}

impl From<Arc<SwarmRecoveryHooks>> for SwarmRecoveryHooks {
    fn from(hooks: Arc<SwarmRecoveryHooks>) -> Self {
        hooks.as_ref().clone()
    }
}

/// Compatibility alias for callers that use the shorter name.
pub type RecoveryHooks = SwarmRecoveryHooks;

/// Compatibility alias for callers that use a scheduler-prefixed name.
pub type SwarmRecoveryDecision = RecoveryDecision;

/// Compatibility alias for callers that use a scheduler-prefixed name.
pub type SwarmRecoverySnapshot = SwarmSnapshot;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SwarmTask;

    fn plan_with_task(status: TaskStatus, result: Option<TaskResult>) -> SwarmPlan {
        let mut task = SwarmTask::new("one", "one");
        task.status = status;
        task.result = result;
        SwarmPlan::new("snapshot").with_tasks(vec![task])
    }

    #[test]
    fn snapshot_digest_detects_graph_mutation() {
        let state = SwarmState::new(
            plan_with_task(TaskStatus::Pending, None),
            SwarmConfig::default(),
        );
        let mut snapshot = SwarmSnapshot::from_state("run-1", &state);
        snapshot.validate().unwrap();
        snapshot.plan.tasks[0].title = "changed".to_string();
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn snapshot_digest_detects_result_mutation() {
        let result = TaskResult {
            success: true,
            output: "ok".into(),
            files_modified: vec![],
            duration_ms: 1,
            error: None,
        };
        let state = SwarmState::new(
            plan_with_task(TaskStatus::Completed, Some(result.clone())),
            SwarmConfig::default(),
        );
        let mut state = state;
        state.status = SwarmStatus::Running;
        state.task_budget = 1;
        state.completed_tasks.insert("one".into());
        state.completed_results.insert("one".into(), result.clone());
        let mut snapshot = SwarmSnapshot::from_state("run-1", &state);
        snapshot.validate().unwrap();
        snapshot.completed_tasks.get_mut("one").unwrap().output = "tampered".into();
        assert!(snapshot.validate().is_err());
    }
}

//! Swarm Executor
//!
//! Coordinates execution of tasks across multiple agents.

use anyhow::{Result, anyhow};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio::task::JoinHandle;

use super::expansion::{SwarmTaskContext, SwarmTaskOutcome, expanded_plan, files_overlap};
use super::plan_parser::validate_plan;
use super::recovery::{
    InFlightTask, IndeterminateTask, RecoveryDecision, SwarmRecoveryHooks, SwarmSnapshot,
};
use super::types::{
    SwarmConfig, SwarmEvent, SwarmPlan, SwarmState, SwarmStatus, SwarmTask, TaskResult, TaskStatus,
};

/// Swarm executor - coordinates multi-agent task execution
pub struct SwarmExecutor {
    /// Shared state
    state: Arc<RwLock<SwarmState>>,
    /// Event sender
    event_tx: mpsc::UnboundedSender<SwarmEvent>,
    /// Event receiver (for external consumers)
    event_rx: Option<mpsc::UnboundedReceiver<SwarmEvent>>,
    /// Cancellation flag
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    /// Stable run identity used by every owner checkpoint.
    run_id: String,
    /// Whether the first run must reconcile restored in-flight callbacks.
    recovery_pending: std::sync::atomic::AtomicBool,
}

/// Shared state for owner checkpoint transitions.
struct RecoveryRuntime {
    hooks: SwarmRecoveryHooks,
    /// Serializes the state transition and the corresponding owner write.
    persistence_lock: Mutex<()>,
    /// Once persistence fails, no new callback may be admitted.
    failure: Mutex<Option<String>>,
}

impl RecoveryRuntime {
    fn new(hooks: SwarmRecoveryHooks) -> Self {
        Self {
            hooks,
            persistence_lock: Mutex::new(()),
            failure: Mutex::new(None),
        }
    }

    async fn fail(&self, error: impl Into<String>) {
        let mut failure = self.failure.lock().await;
        if failure.is_none() {
            *failure = Some(error.into());
        }
    }

    async fn failure(&self) -> Option<String> {
        self.failure.lock().await.clone()
    }
}

/// A task future admitted by [`SwarmExecutor`] and retained until its result
/// has been observed.  Dropping a `JoinHandle` would detach the callback and
/// allow a governed effect to continue after the swarm reports a terminal
/// state, so the executor owns these handles through every terminal path.
struct SpawnedTask {
    task_id: String,
    handle: JoinHandle<()>,
}

impl SwarmExecutor {
    /// Create a new executor with a plan
    pub fn new(plan: SwarmPlan, config: SwarmConfig) -> Result<Self> {
        // Validate the plan
        validate_plan(&plan)?;
        anyhow::ensure!(
            config.max_concurrency > 0,
            "Swarm concurrency must be positive"
        );

        let state = SwarmState::new(plan, config);
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Ok(Self {
            state: Arc::new(RwLock::new(state)),
            event_tx,
            event_rx: Some(event_rx),
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            run_id: uuid::Uuid::new_v4().to_string(),
            recovery_pending: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Create a new executor with an owner-assigned run identity.
    ///
    /// The identity is copied into every snapshot and cannot be changed once
    /// execution starts. This lets local journals and hosted owners bind the
    /// scheduler's checkpoints to their accepted run without rewriting a
    /// serialized snapshot.
    pub fn new_with_run_id(
        plan: SwarmPlan,
        config: SwarmConfig,
        run_id: impl Into<String>,
    ) -> Result<Self> {
        let run_id = run_id.into();
        anyhow::ensure!(!run_id.trim().is_empty(), "Swarm run ID must not be empty");
        let mut executor = Self::new(plan, config)?;
        executor.run_id = run_id;
        Ok(executor)
    }

    /// Restore an executor from an owner-validated immutable snapshot.
    ///
    /// A running task remains running in the restored state and is exposed to
    /// the recovery hook.  It is never silently converted into a pending task.
    pub fn from_snapshot(snapshot: SwarmSnapshot) -> Result<Self> {
        snapshot.validate()?;
        Self::from_validated_snapshot(snapshot)
    }

    /// Restore an executor while changing runtime-only scheduling settings.
    ///
    /// The snapshot's graph and lifetime task budget remain authoritative;
    /// `config` only controls this process's concurrency, timeout, and model
    /// settings.
    pub fn from_snapshot_with_config(snapshot: SwarmSnapshot, config: SwarmConfig) -> Result<Self> {
        snapshot.validate()?;
        anyhow::ensure!(
            config.max_concurrency > 0,
            "Swarm concurrency must be positive"
        );
        Self::from_validated_snapshot_with_config(snapshot, config)
    }

    fn from_validated_snapshot(snapshot: SwarmSnapshot) -> Result<Self> {
        let config = snapshot.config.clone();
        Self::from_validated_snapshot_with_config(snapshot, config)
    }

    fn from_validated_snapshot_with_config(
        snapshot: SwarmSnapshot,
        config: SwarmConfig,
    ) -> Result<Self> {
        let needs_recovery = snapshot.status == SwarmStatus::Running;
        let mut running_tasks = std::collections::HashMap::new();
        let mut running_dispatches = std::collections::HashMap::new();
        for task in &snapshot.in_flight {
            running_tasks.insert(task.task_id.clone(), task.agent_id.clone());
            running_dispatches.insert(task.task_id.clone(), task.dispatch_id.clone());
        }
        let completed_tasks = snapshot.completed_tasks.keys().cloned().collect();
        let failed_tasks = snapshot.failed_tasks.keys().cloned().collect();
        let indeterminate_tasks = snapshot
            .indeterminate_tasks
            .iter()
            .map(|(task_id, task)| (task_id.clone(), task.clone()))
            .collect();
        let state = SwarmState {
            status: snapshot.status,
            plan: snapshot.plan,
            config,
            completed_tasks,
            completed_results: snapshot.completed_tasks.clone(),
            failed_tasks,
            failed_results: snapshot.failed_tasks.clone(),
            running_tasks,
            running_dispatches,
            indeterminate_tasks,
            revision: snapshot.revision,
            task_budget: snapshot.task_budget,
            graph_digest: snapshot.graph_digest,
            started_at: snapshot.started_at,
            events: Vec::new(),
        };
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Ok(Self {
            state: Arc::new(RwLock::new(state)),
            event_tx,
            event_rx: Some(event_rx),
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            run_id: snapshot.run_id,
            recovery_pending: std::sync::atomic::AtomicBool::new(needs_recovery),
        })
    }

    /// Take the event receiver (can only be called once)
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<SwarmEvent>> {
        self.event_rx.take()
    }

    /// Subscribe to events (creates a new receiver)
    #[must_use]
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<SwarmEvent> {
        let (tx, rx) = mpsc::unbounded_channel();

        // Clone the state to send historical events
        let state = self.state.clone();
        let tx_clone = tx.clone();

        tokio::spawn(async move {
            let state = state.read().await;
            for event in &state.events {
                let _ = tx_clone.send(event.clone());
            }
        });

        rx
    }

    /// Get current state
    pub async fn state(&self) -> SwarmState {
        self.state.read().await.clone()
    }

    /// Capture a validated immutable owner snapshot of the current state.
    #[must_use]
    pub async fn snapshot(&self) -> SwarmSnapshot {
        let state = self.state.read().await;
        SwarmSnapshot::from_state(&self.run_id, &state)
    }

    /// Request scheduler cancellation.
    ///
    /// No new tasks are admitted. Callbacks already admitted to the scheduler
    /// are awaited before [`Self::run`] returns.
    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Check if cancelled
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Run the swarm execution
    ///
    /// This is the main entry point. It will:
    /// 1. Emit a Started event
    /// 2. Execute tasks in parallel respecting dependencies
    /// 3. Emit progress events
    /// 4. Emit a Completed/Failed/Cancelled event
    pub async fn run<F, Fut>(&self, task_executor: F) -> Result<SwarmState>
    where
        F: Fn(SwarmTask) -> Fut + Send + Sync + Clone + 'static,
        Fut: std::future::Future<Output = Result<TaskResult>> + Send,
    {
        let max_tasks = self.state.read().await.plan.tasks.len();
        self.run_expanding(max_tasks, move |context| {
            let executor = task_executor.clone();
            async move { executor(context.task).await.map(SwarmTaskOutcome::from) }
        })
        .await
    }

    /// Execute an owner-admitted graph that can grow after each successful task.
    ///
    /// This compatibility entry point uses no-op checkpoint hooks. Owners that
    /// need restart recovery should call [`Self::run_expanding_with_recovery`].
    pub async fn run_expanding<F, Fut>(
        &self,
        max_tasks: usize,
        task_executor: F,
    ) -> Result<SwarmState>
    where
        F: Fn(SwarmTaskContext) -> Fut + Send + Sync + Clone + 'static,
        Fut: std::future::Future<Output = Result<SwarmTaskOutcome>> + Send,
    {
        self.run_expanding_with_recovery(max_tasks, task_executor, SwarmRecoveryHooks::noop())
            .await
    }

    /// Execute a dynamic graph with owner supplied checkpoint and recovery
    /// hooks.
    ///
    /// A reservation snapshot is persisted before each callback starts.  A
    /// callback's result and accepted expansion are persisted as one state
    /// transition before the scheduler can launch a dependent task.  Hook
    /// calls are serialized by transition revision.  If persistence fails the
    /// scheduler stops admitting work, drains callbacks already admitted, and
    /// returns an error instead of reporting success.
    pub async fn run_expanding_with_recovery<F, Fut, H>(
        &self,
        max_tasks: usize,
        task_executor: F,
        hooks: H,
    ) -> Result<SwarmState>
    where
        F: Fn(SwarmTaskContext) -> Fut + Send + Sync + Clone + 'static,
        Fut: std::future::Future<Output = Result<SwarmTaskOutcome>> + Send,
        H: Into<SwarmRecoveryHooks>,
    {
        let start_time = Instant::now();
        let runtime = Arc::new(RecoveryRuntime::new(hooks.into()));
        let mut spawned_tasks = Vec::new();
        let mut terminal_event = None;
        // A KeepIndeterminate decision deliberately leaves the owner run
        // resumable. It returns a Running state after the final checkpoint so
        // callers can reconcile the unresolved effect without replaying it.
        let mut owner_recovery_required = false;
        let recovery_candidate = self
            .recovery_pending
            .load(std::sync::atomic::Ordering::SeqCst);

        // Initialize a new run and establish its first owner checkpoint. A
        // restored run retains Running task state and is reconciled below.
        let should_initialize = {
            let state = self.state.read().await;
            state.status == SwarmStatus::Initializing
        };
        if recovery_candidate && should_initialize {
            return Err(anyhow!(
                "Swarm recovery state is inconsistent: restored run is initializing"
            ));
        }
        if !recovery_candidate && !should_initialize {
            return Err(anyhow!("Swarm execution has already started"));
        }

        // Validate the persisted lifetime budget before consuming the
        // one-shot recovery guard. A caller that supplies the wrong budget can
        // correct it and retry without reconstructing the executor.
        if recovery_candidate {
            let state = self.state.read().await;
            anyhow::ensure!(
                state.status == SwarmStatus::Running,
                "Only a running swarm snapshot can be resumed"
            );
            anyhow::ensure!(
                max_tasks == state.task_budget,
                "Resumed swarm must retain its persisted task budget"
            );
        }

        let resumed = if recovery_candidate {
            self.recovery_pending
                .compare_exchange(
                    true,
                    false,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
        } else {
            false
        };
        if recovery_candidate && !resumed {
            return Err(anyhow!("Swarm execution has already started"));
        }

        if should_initialize {
            let initialization =
                persist_transition_on_state(&self.state, &self.run_id, &runtime, |state| {
                    anyhow::ensure!(
                        state.status == SwarmStatus::Initializing,
                        "Swarm execution has already started"
                    );
                    anyhow::ensure!(
                        max_tasks > 0 && state.plan.tasks.len() <= max_tasks,
                        "Initial plan exceeds swarm task budget"
                    );
                    state.status = SwarmStatus::Running;
                    state.task_budget = max_tasks;
                    state.started_at = Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64,
                    );
                    Ok(())
                })
                .await;
            if let Err(error) = initialization {
                let Some(message) = runtime.failure().await else {
                    return Err(error);
                };
                let mut state = self.state.write().await;
                state.status = SwarmStatus::Failed;
                drop(state);
                terminal_event = Some(SwarmEvent::Failed { error: message });
            }
        }

        if terminal_event.is_none() {
            // Restored reservations are intentionally handled before any new
            // callback can be admitted. The owner decides whether each one is
            // reconciled, retried, failed, skipped, or left indeterminate.
            if resumed {
                if let Err(error) = self.reconcile_in_flight(&runtime, max_tasks).await {
                    let message = runtime.failure().await.unwrap_or_else(|| error.to_string());
                    let mut state = self.state.write().await;
                    state.status = SwarmStatus::Failed;
                    drop(state);
                    terminal_event = Some(SwarmEvent::Failed { error: message });
                }
            }
        }

        if terminal_event.is_none() {
            // Emit started event only after the initial/recovery boundary has
            // been accepted by the owner.
            let (plan_title, total_tasks) = {
                let state = self.state.read().await;
                (state.plan.title.clone(), state.plan.tasks.len())
            };
            self.emit(SwarmEvent::Started {
                plan_title,
                total_tasks,
            })
            .await;
        }

        // Main execution loop
        while terminal_event.is_none() {
            self.reap_finished_tasks(&mut spawned_tasks, &runtime).await;

            if let Some(error) = runtime.failure().await {
                let mut state = self.state.write().await;
                state.status = SwarmStatus::Failed;
                drop(state);
                terminal_event = Some(SwarmEvent::Failed { error });
                break;
            }

            if self.is_cancelled() {
                let mut state = self.state.write().await;
                state.status = SwarmStatus::Cancelled;
                terminal_event = Some(SwarmEvent::Cancelled {
                    reason: "User cancelled".to_string(),
                });
                break;
            }

            let state = self.state.read().await;

            // Check if done
            if state.is_done() {
                break;
            }

            if !state.failed_tasks.is_empty() && !state.config.continue_on_failure {
                drop(state);
                let mut state = self.state.write().await;
                for task in &mut state.plan.tasks {
                    if task.status == TaskStatus::Pending {
                        task.status = TaskStatus::Skipped;
                    }
                }
                state.status = SwarmStatus::Failed;
                terminal_event = Some(SwarmEvent::Failed {
                    error: "A swarm task failed".into(),
                });
                break;
            }

            // Reserve declared scopes against running tasks and this batch.
            let running_tasks: Vec<_> = state
                .plan
                .tasks
                .iter()
                .filter(|task| state.running_tasks.contains_key(&task.id))
                .collect();
            let mut ready_tasks = Vec::<SwarmTask>::new();
            let capacity = state
                .config
                .max_concurrency
                .saturating_sub(state.running_tasks.len());
            for task in &state.plan.tasks {
                if ready_tasks.len() == capacity {
                    break;
                }
                if task.status != TaskStatus::Pending
                    || state.running_tasks.contains_key(&task.id)
                    || !task.can_start(&state.completed_tasks)
                    || running_tasks
                        .iter()
                        .any(|running| files_overlap(task, running))
                    || ready_tasks.iter().any(|ready| files_overlap(task, ready))
                {
                    continue;
                }
                ready_tasks.push(task.clone());
            }

            let can_start_more = state.can_start_more();
            let running_count = state.running_tasks.len();
            drop(state);

            // No tasks running and none ready - check if we're done or stuck
            if running_count == 0 && ready_tasks.is_empty() {
                let (all_done, has_indeterminate) = {
                    let state = self.state.read().await;
                    let all_done = state.plan.tasks.iter().all(|t| {
                        state.completed_tasks.contains(&t.id)
                            || state.failed_tasks.contains(&t.id)
                            || t.status == TaskStatus::Skipped
                    });
                    (all_done, !state.indeterminate_tasks.is_empty())
                };

                if all_done {
                    break;
                }

                if has_indeterminate {
                    // Keep the scheduler in Running with Blocked task entries
                    // and an owner-visible indeterminate record.  A later
                    // owner can restore this snapshot and make an explicit
                    // reconciliation decision; automatic failure would lose
                    // that boundary and invite unsafe replay.
                    owner_recovery_required = true;
                    break;
                }

                // Failure blocks every transitive consumer, even when unrelated
                // work is allowed to continue. Never spin on a skipped dependency.
                let mut state = self.state.write().await;
                let mut blocked = state.failed_tasks.clone();
                loop {
                    let before = blocked.len();
                    for task in &mut state.plan.tasks {
                        if task.status == TaskStatus::Skipped
                            || (task.status == TaskStatus::Pending
                                && task.dependencies.iter().any(|id| blocked.contains(id)))
                        {
                            task.status = TaskStatus::Skipped;
                            blocked.insert(task.id.clone());
                        }
                    }
                    if before == blocked.len() {
                        break;
                    }
                }
                state.status = SwarmStatus::Failed;
                terminal_event = Some(SwarmEvent::Failed {
                    error: "Tasks blocked by failed dependencies or an unschedulable plan".into(),
                });
                break;
            }

            // Start ready tasks. Every reservation is persisted before its
            // callback is spawned. If a reservation write fails, stop this
            // batch immediately and let the drain below settle prior work.
            if can_start_more {
                for task in ready_tasks {
                    let agent_id = format!("agent-{}", uuid::Uuid::new_v4());
                    let dispatch_id = format!("dispatch-{}", uuid::Uuid::new_v4());
                    let task_id = task.id.clone();
                    let task_title = task.title.clone();

                    let reservation =
                        persist_transition_on_state(&self.state, &self.run_id, &runtime, |state| {
                            anyhow::ensure!(
                                state.status == SwarmStatus::Running,
                                "Swarm is no longer accepting task reservations"
                            );
                            anyhow::ensure!(
                                task.status == TaskStatus::Pending
                                    && !state.running_tasks.contains_key(&task_id),
                                "Task '{}' is no longer pending",
                                task_id
                            );
                            state
                                .running_tasks
                                .insert(task_id.clone(), agent_id.clone());
                            state
                                .running_dispatches
                                .insert(task_id.clone(), dispatch_id.clone());
                            if let Some(t) = state.plan.get_task_mut(&task_id) {
                                t.status = TaskStatus::Running;
                                t.assigned_agent = Some(agent_id.clone());
                            }
                            Ok(InFlightTask {
                                task_id: task_id.clone(),
                                agent_id: agent_id.clone(),
                                dispatch_id: dispatch_id.clone(),
                            })
                        })
                        .await;
                    if let Err(error) = reservation {
                        let message = runtime.failure().await.unwrap_or_else(|| error.to_string());
                        let mut state = self.state.write().await;
                        state.status = SwarmStatus::Failed;
                        drop(state);
                        terminal_event = Some(SwarmEvent::Failed { error: message });
                        break;
                    }

                    // Emit started event
                    self.emit(SwarmEvent::TaskStarted {
                        task_id: task_id.clone(),
                        task_title,
                        agent_id: agent_id.clone(),
                    })
                    .await;

                    // Spawn task execution
                    let state = self.state.clone();
                    let event_tx = self.event_tx.clone();
                    let executor = task_executor.clone();
                    let runtime = runtime.clone();
                    let run_id = self.run_id.clone();
                    let timeout = {
                        let s = state.read().await;
                        s.config.task_timeout_ms
                    };

                    let dependency_results = {
                        let s = state.read().await;
                        task.dependencies
                            .iter()
                            .filter_map(|id| {
                                s.plan
                                    .get_task(id)
                                    .and_then(|dependency| dependency.result.clone())
                                    .map(|result| (id.clone(), result))
                            })
                            .collect()
                    };
                    let context = SwarmTaskContext {
                        dispatch_id,
                        task,
                        dependency_results,
                    };
                    let task_id_for_handle = task_id.clone();
                    let handle = tokio::spawn(async move {
                        let result = if let Some(timeout_ms) = timeout {
                            match tokio::time::timeout(
                                Duration::from_millis(timeout_ms),
                                executor(context),
                            )
                            .await
                            {
                                Ok(r) => r,
                                Err(_) => {
                                    if runtime.hooks.checkpointing_enabled() {
                                        let _ = mark_task_indeterminate_state(
                                            &state,
                                            &run_id,
                                            &runtime,
                                            &task_id,
                                            "Task timed out before an accepted result".to_string(),
                                        )
                                        .await;
                                        return;
                                    }
                                    Err(anyhow::anyhow!("Task timed out"))
                                }
                            }
                        } else {
                            executor(context).await
                        };

                        let outcome = match result {
                            Ok(outcome) => outcome,
                            Err(error) => {
                                if runtime.hooks.checkpointing_enabled() {
                                    // An error return only tells the scheduler
                                    // that no accepted result arrived. The
                                    // callback may have performed an external
                                    // effect before returning, so recovery
                                    // owners must reconcile it explicitly.
                                    let _ = mark_task_indeterminate_state(
                                        &state,
                                        &run_id,
                                        &runtime,
                                        &task_id,
                                        error.to_string(),
                                    )
                                    .await;
                                    return;
                                }
                                // Compatibility runs retain the legacy
                                // terminal failure behavior. Recovery-enabled
                                // owners must return an explicit failed result
                                // when failure is known before this boundary.
                                SwarmTaskOutcome::from(TaskResult {
                                    success: false,
                                    output: String::new(),
                                    files_modified: Vec::new(),
                                    duration_ms: 0,
                                    error: Some(error.to_string()),
                                })
                            }
                        };
                        let task_result =
                            persist_transition_on_state(&state, &run_id, &runtime, |state| {
                                Ok(commit_outcome(state, &task_id, outcome, max_tasks))
                            })
                            .await;
                        let Ok(task_result) = task_result else {
                            // The recovery runtime records the terminal
                            // persistence error. Avoid publishing a successful
                            // task event when its accepted result was not
                            // durably recorded.
                            return;
                        };
                        if task_result.success {
                            let _ = event_tx.send(SwarmEvent::TaskCompleted {
                                task_id,
                                result: task_result,
                            });
                        } else {
                            let _ = event_tx.send(SwarmEvent::TaskFailed {
                                task_id,
                                error: task_result
                                    .error
                                    .unwrap_or_else(|| "Task reported failure".into()),
                            });
                        }
                    });
                    spawned_tasks.push(SpawnedTask {
                        task_id: task_id_for_handle,
                        handle,
                    });
                }
            }

            if terminal_event.is_some() {
                break;
            }

            // Brief sleep to prevent busy loop
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Cancellation, dependency failure, and checkpoint failure are
        // terminal scheduler states, but they do not cancel an admitted
        // callback. Drain every retained handle before returning to the owner.
        self.drain_spawned_tasks(&mut spawned_tasks, &runtime).await;

        // A callback can become indeterminate while the scheduler is draining
        // another terminal path (for example, a sibling failure). Keep the
        // owner-recovery boundary resumable in that case as well; a Failed
        // status would make the unknown effect unreconcilable on restore.
        if runtime.failure().await.is_none()
            && !self.state.read().await.indeterminate_tasks.is_empty()
        {
            owner_recovery_required = true;
            // A terminal event is held until after the final checkpoint. An
            // unresolved effect supersedes cancellation/failure diagnostics:
            // the owner must receive a resumable Running state instead.
            terminal_event = None;
        }

        // Finalize through the same serialized owner boundary as every graph
        // and result transition. This gives durable owners a final revision
        // that contains the terminal status after all admitted callbacks have
        // drained, and prevents returning success for an uncheckpointed end.
        let duration_ms = start_time.elapsed().as_millis() as u64;
        let finalization =
            persist_transition_on_state(&self.state, &self.run_id, &runtime, |state| {
                // Continuing independent work never converts failed verification
                // into aggregate success. An indeterminate boundary stays
                // Running so a later owner restore can reconcile it explicitly.
                if owner_recovery_required {
                    state.status = SwarmStatus::Running;
                } else if state.status != SwarmStatus::Cancelled {
                    let failed = state.failed_tasks.len();
                    let skipped = state
                        .plan
                        .tasks
                        .iter()
                        .filter(|task| task.status == TaskStatus::Skipped)
                        .count();
                    state.status =
                        if failed > 0 || skipped > 0 || state.status == SwarmStatus::Failed {
                            SwarmStatus::Failed
                        } else {
                            SwarmStatus::Completed
                        };
                }
                Ok(())
            })
            .await;

        let mut terminal_emitted = terminal_event.is_some();
        if let Err(error) = finalization {
            // The runtime records hook failures and rejects all later
            // transitions. Preserve the fail-closed state in memory and
            // report an error even though this final write was not accepted.
            let message = runtime.failure().await.unwrap_or_else(|| error.to_string());
            let mut state = self.state.write().await;
            if state.status != SwarmStatus::Cancelled {
                state.status = SwarmStatus::Failed;
            }
            drop(state);
            if terminal_event.is_none() {
                terminal_event = Some(SwarmEvent::Failed { error: message });
                terminal_emitted = true;
            }
        }

        let result = self.state.read().await.clone();
        let successful = result.completed_tasks.len();
        let failed = result.failed_tasks.len();
        let skipped = result
            .plan
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Skipped)
            .count();

        // Publish terminal diagnostics only after the corresponding state has
        // crossed the owner persistence boundary.
        if let Some(event) = terminal_event {
            self.emit(event).await;
        }

        if result.status == SwarmStatus::Completed {
            self.emit(SwarmEvent::Completed {
                successful,
                failed,
                skipped,
                duration_ms,
            })
            .await;
        }

        if result.status == SwarmStatus::Failed && !terminal_emitted {
            self.emit(SwarmEvent::Failed {
                error: format!("Swarm finished with {failed} failed and {skipped} skipped tasks"),
            })
            .await;
        }

        if let Some(error) = runtime.failure().await {
            return Err(anyhow!(error));
        }

        if owner_recovery_required {
            // A successfully persisted indeterminate boundary is a valid
            // owner-visible pause, not a scheduler failure. The Running state
            // tells the owner to restore and reconcile before admitting work.
            return Ok(result);
        }

        Ok(result)
    }

    /// Reconcile every persisted callback reservation before scheduling new
    /// work. Reservations are sorted so the owner sees a stable order.
    async fn reconcile_in_flight(
        &self,
        runtime: &Arc<RecoveryRuntime>,
        max_tasks: usize,
    ) -> Result<()> {
        let mut reservations: Vec<InFlightTask> = {
            let state = self.state.read().await;
            let mut reservations: Vec<_> = state
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
            // An owner may intentionally leave an interrupted effect
            // indeterminate.  Include that persisted record in the next
            // recovery pass so a later owner can reconcile it explicitly;
            // never turn it into a fresh callback implicitly.
            reservations.extend(state.indeterminate_tasks.values().map(|task| InFlightTask {
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                dispatch_id: task.dispatch_id.clone(),
            }));
            reservations
        };
        reservations.sort_by(|left, right| left.task_id.cmp(&right.task_id));

        for reservation in reservations {
            if let Some(error) = runtime.failure().await {
                return Err(anyhow!(error));
            }
            let decision = match runtime.hooks.reconcile(reservation.clone()).await {
                Ok(decision) => decision,
                Err(error) => {
                    runtime.fail(error.to_string()).await;
                    return Err(error);
                }
            };
            self.apply_recovery_decision(runtime, reservation, decision, max_tasks)
                .await?;
        }
        Ok(())
    }

    async fn apply_recovery_decision(
        &self,
        runtime: &Arc<RecoveryRuntime>,
        reservation: InFlightTask,
        decision: RecoveryDecision,
        max_tasks: usize,
    ) -> Result<()> {
        let task_id = reservation.task_id.clone();
        match decision {
            RecoveryDecision::Reconcile(result) => {
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    Ok(commit_outcome(
                        state,
                        &task_id,
                        SwarmTaskOutcome::from(result),
                        max_tasks,
                    ))
                })
                .await
                .map(|_result| ())
            }
            RecoveryDecision::ReconcileOutcome(outcome) => {
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    Ok(commit_outcome(state, &task_id, outcome, max_tasks))
                })
                .await
                .map(|_result| ())
            }
            RecoveryDecision::Retry => {
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    clear_reservation(state, &reservation);
                    state.indeterminate_tasks.remove(&task_id);
                    state.completed_tasks.remove(&task_id);
                    state.failed_tasks.remove(&task_id);
                    state.completed_results.remove(&task_id);
                    state.failed_results.remove(&task_id);
                    if let Some(task) = state.plan.get_task_mut(&task_id) {
                        task.status = TaskStatus::Pending;
                        task.assigned_agent = None;
                        task.result = None;
                    }
                    Ok(())
                })
                .await
            }
            RecoveryDecision::Fail(reason) => {
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    clear_reservation(state, &reservation);
                    state.indeterminate_tasks.remove(&task_id);
                    state.completed_results.remove(&task_id);
                    state.failed_results.remove(&task_id);
                    let result = TaskResult {
                        success: false,
                        output: String::new(),
                        files_modified: Vec::new(),
                        duration_ms: 0,
                        error: Some(reason),
                    };
                    state.completed_tasks.remove(&task_id);
                    state.failed_tasks.insert(task_id.clone());
                    state.failed_results.insert(task_id.clone(), result.clone());
                    if let Some(task) = state.plan.get_task_mut(&task_id) {
                        task.status = TaskStatus::Failed;
                        task.assigned_agent = None;
                        task.result = Some(result);
                    }
                    Ok(())
                })
                .await
            }
            RecoveryDecision::Skip(_reason) => {
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    clear_reservation(state, &reservation);
                    state.indeterminate_tasks.remove(&task_id);
                    state.completed_tasks.remove(&task_id);
                    state.failed_tasks.remove(&task_id);
                    state.completed_results.remove(&task_id);
                    state.failed_results.remove(&task_id);
                    if let Some(task) = state.plan.get_task_mut(&task_id) {
                        task.status = TaskStatus::Skipped;
                        task.assigned_agent = None;
                        task.result = None;
                    }
                    Ok(())
                })
                .await
            }
            RecoveryDecision::KeepIndeterminate(reason) => {
                anyhow::ensure!(
                    !reason.trim().is_empty(),
                    "Indeterminate recovery decisions require a reason"
                );
                persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
                    clear_reservation(state, &reservation);
                    state.indeterminate_tasks.insert(
                        task_id.clone(),
                        IndeterminateTask {
                            task_id: task_id.clone(),
                            agent_id: reservation.agent_id.clone(),
                            dispatch_id: reservation.dispatch_id.clone(),
                            reason,
                        },
                    );
                    if let Some(task) = state.plan.get_task_mut(&task_id) {
                        task.status = TaskStatus::Blocked;
                        task.assigned_agent = None;
                        task.result = None;
                    }
                    Ok(())
                })
                .await
            }
        }
    }

    /// Reap callbacks that completed since the previous scheduler iteration.
    /// Normal callbacks update state themselves. A panic is indeterminate when
    /// recovery hooks are enabled because the callback may have performed an
    /// external effect before unwinding; compatibility runs retain the legacy
    /// failed-task behavior.
    async fn reap_finished_tasks(
        &self,
        spawned_tasks: &mut Vec<SpawnedTask>,
        runtime: &Arc<RecoveryRuntime>,
    ) {
        let mut index = 0;
        while index < spawned_tasks.len() {
            if !spawned_tasks[index].handle.is_finished() {
                index += 1;
                continue;
            }

            let spawned = spawned_tasks.swap_remove(index);
            if let Err(error) = spawned.handle.await {
                self.handle_admitted_callback_error(spawned.task_id, error.to_string(), runtime)
                    .await;
            }
        }
    }

    /// Await every admitted callback. This deliberately does not abort a
    /// child: a callback may already have submitted a durable effect and must
    /// be allowed to observe that effect's terminal result before the owner
    /// run returns.
    async fn drain_spawned_tasks(
        &self,
        spawned_tasks: &mut Vec<SpawnedTask>,
        runtime: &Arc<RecoveryRuntime>,
    ) {
        while let Some(spawned) = spawned_tasks.pop() {
            if let Err(error) = spawned.handle.await {
                self.handle_admitted_callback_error(spawned.task_id, error.to_string(), runtime)
                    .await;
            }
        }
    }

    async fn handle_admitted_callback_error(
        &self,
        task_id: String,
        error: String,
        runtime: &Arc<RecoveryRuntime>,
    ) {
        if runtime.hooks.checkpointing_enabled() {
            self.mark_task_indeterminate(task_id, error, runtime).await;
        } else {
            self.mark_task_failed(task_id, error, runtime).await;
        }
    }

    async fn mark_task_indeterminate(
        &self,
        task_id: String,
        reason: String,
        runtime: &Arc<RecoveryRuntime>,
    ) {
        let persisted = mark_task_indeterminate_state(
            &self.state,
            &self.run_id,
            runtime,
            &task_id,
            reason.clone(),
        )
        .await;
        if persisted.is_err() {
            // A persistence failure is already fail-closed in RecoveryRuntime;
            // clear the local slot so draining cannot wait on a phantom task.
            let mut state = self.state.write().await;
            state.running_tasks.remove(&task_id);
            state.running_dispatches.remove(&task_id);
        }
    }

    async fn mark_task_failed(
        &self,
        task_id: String,
        error: String,
        runtime: &Arc<RecoveryRuntime>,
    ) {
        let result = TaskResult {
            success: false,
            output: String::new(),
            files_modified: Vec::new(),
            duration_ms: 0,
            error: Some(error.clone()),
        };
        let persisted = persist_transition_on_state(&self.state, &self.run_id, runtime, |state| {
            state.running_tasks.remove(&task_id);
            state.running_dispatches.remove(&task_id);
            state.completed_tasks.remove(&task_id);
            state.failed_tasks.insert(task_id.clone());
            state.failed_results.insert(task_id.clone(), result.clone());
            state.completed_results.remove(&task_id);
            state.indeterminate_tasks.remove(&task_id);
            if let Some(task) = state.plan.get_task_mut(&task_id) {
                task.status = TaskStatus::Failed;
                task.assigned_agent = None;
                task.result = Some(result);
            }
            Ok(())
        })
        .await;
        if persisted.is_err() {
            // A prior checkpoint failure can prevent another persistence call;
            // still clear the in-memory running slot while the terminal error
            // remains recorded in RecoveryRuntime.
            let mut state = self.state.write().await;
            state.running_tasks.remove(&task_id);
            state.running_dispatches.remove(&task_id);
        } else {
            let _ = self
                .event_tx
                .send(SwarmEvent::TaskFailed { task_id, error });
        }
    }

    /// Emit an event
    async fn emit(&self, event: SwarmEvent) {
        let mut state = self.state.write().await;
        state.events.push(event.clone());
        drop(state);
        let _ = self.event_tx.send(event);
    }
}

async fn persist_transition_on_state<T, F>(
    state: &Arc<RwLock<SwarmState>>,
    run_id: &str,
    runtime: &Arc<RecoveryRuntime>,
    mutate: F,
) -> Result<T>
where
    F: FnOnce(&mut SwarmState) -> Result<T>,
{
    if !runtime.hooks.checkpointing_enabled() {
        if let Some(error) = runtime.failure().await {
            return Err(anyhow!(error));
        }
        let mut state = state.write().await;
        let value = mutate(&mut state)?;
        state.revision = state.revision.saturating_add(1);
        if state.graph_digest.is_empty() {
            state.graph_digest = crate::recovery::compute_graph_digest(&state.plan);
        }
        return Ok(value);
    }

    let _persistence_guard = runtime.persistence_lock.lock().await;
    if let Some(error) = runtime.failure().await {
        return Err(anyhow!(error));
    }

    let (snapshot, value) = {
        let mut state = state.write().await;
        let value = mutate(&mut state)?;
        state.revision = state.revision.saturating_add(1);
        if state.graph_digest.is_empty() {
            state.graph_digest = crate::recovery::compute_graph_digest(&state.plan);
        }
        let snapshot = SwarmSnapshot::from_state(run_id, &state);
        (snapshot, value)
    };

    match runtime.hooks.persist(snapshot).await {
        Ok(()) => Ok(value),
        Err(error) => {
            runtime.fail(error.to_string()).await;
            Err(error)
        }
    }
}

fn clear_reservation(state: &mut SwarmState, reservation: &InFlightTask) {
    state.running_tasks.remove(&reservation.task_id);
    state.running_dispatches.remove(&reservation.task_id);
}

async fn mark_task_indeterminate_state(
    state: &Arc<RwLock<SwarmState>>,
    run_id: &str,
    runtime: &Arc<RecoveryRuntime>,
    task_id: &str,
    reason: String,
) -> Result<()> {
    anyhow::ensure!(
        !reason.trim().is_empty(),
        "Indeterminate task recovery requires a reason"
    );
    persist_transition_on_state(state, run_id, runtime, |state| {
        let agent_id = state
            .running_tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("Task '{task_id}' has no running agent to reconcile"))?;
        let dispatch_id = state
            .running_dispatches
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("Task '{task_id}' has no dispatch reservation to reconcile"))?;
        state.running_tasks.remove(task_id);
        state.running_dispatches.remove(task_id);
        state.indeterminate_tasks.insert(
            task_id.to_string(),
            IndeterminateTask {
                task_id: task_id.to_string(),
                agent_id,
                dispatch_id,
                reason,
            },
        );
        if let Some(task) = state.plan.get_task_mut(task_id) {
            task.status = TaskStatus::Blocked;
            task.assigned_agent = None;
            task.result = None;
        }
        Ok(())
    })
    .await
}

fn commit_outcome(
    state: &mut SwarmState,
    task_id: &str,
    mut outcome: SwarmTaskOutcome,
    max_tasks: usize,
) -> TaskResult {
    state.running_tasks.remove(task_id);
    state.running_dispatches.remove(task_id);
    state.indeterminate_tasks.remove(task_id);

    if outcome.result.success && !outcome.follow_up_tasks.is_empty() {
        match expanded_plan(&state.plan, task_id, outcome.follow_up_tasks, max_tasks) {
            Ok(plan) => {
                state.plan = plan;
                state.graph_digest = crate::recovery::compute_graph_digest(&state.plan);
            }
            Err(error) => {
                outcome.result.success = false;
                outcome.result.error = Some(format!("Task expansion rejected: {error}"));
            }
        }
    }

    let task_result = outcome.result;
    if task_result.success {
        state.completed_tasks.insert(task_id.to_owned());
        state.failed_tasks.remove(task_id);
        state
            .completed_results
            .insert(task_id.to_owned(), task_result.clone());
        state.failed_results.remove(task_id);
    } else {
        state.failed_tasks.insert(task_id.to_owned());
        state.completed_tasks.remove(task_id);
        state
            .failed_results
            .insert(task_id.to_owned(), task_result.clone());
        state.completed_results.remove(task_id);
    }
    if let Some(task) = state.plan.get_task_mut(task_id) {
        task.status = if task_result.success {
            TaskStatus::Completed
        } else {
            TaskStatus::Failed
        };
        task.assigned_agent = None;
        task.result = Some(task_result.clone());
    }
    task_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    fn successful_task_result() -> TaskResult {
        TaskResult {
            success: true,
            output: "ok".to_string(),
            files_modified: Vec::new(),
            duration_ms: 0,
            error: None,
        }
    }

    #[test]
    fn test_executor_creation() {
        let plan = SwarmPlan::new("Test Plan").with_tasks(vec![
            SwarmTask::new("task-1", "First Task"),
            SwarmTask::new("task-2", "Second Task"),
        ]);

        let executor = SwarmExecutor::new(plan, SwarmConfig::default());
        assert!(executor.is_ok());
    }

    #[test]
    fn test_executor_cancellation_flag() {
        let plan = SwarmPlan::new("Test Plan").with_tasks(vec![SwarmTask::new("task-1", "First")]);

        let executor = SwarmExecutor::new(plan, SwarmConfig::default()).unwrap();
        assert!(!executor.is_cancelled());

        executor.cancel();
        assert!(executor.is_cancelled());
    }

    #[test]
    fn test_executor_rejects_invalid_plan() {
        // Plan with missing dependency
        let plan = SwarmPlan::new("Test Plan").with_tasks(vec![
            SwarmTask::new("task-1", "First Task").with_dependencies(vec!["nonexistent".into()]),
        ]);

        let result = SwarmExecutor::new(plan, SwarmConfig::default());
        assert!(result.is_err());
    }

    #[test]
    fn test_executor_rejects_cyclic_plan() {
        let plan = SwarmPlan::new("Test Plan").with_tasks(vec![
            SwarmTask::new("task-1", "First").with_dependencies(vec!["task-2".into()]),
            SwarmTask::new("task-2", "Second").with_dependencies(vec!["task-1".into()]),
        ]);

        let result = SwarmExecutor::new(plan, SwarmConfig::default());
        assert!(result.is_err());
    }

    #[test]
    fn cancellation_waits_for_admitted_sibling_before_returning() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        runtime.block_on(async {
            let plan = SwarmPlan::new("Cancellation drain")
                .with_tasks(vec![
                    SwarmTask::new("quick", "Quick task"),
                    SwarmTask::new("sibling", "Long sibling"),
                ])
                .with_max_concurrency(2);
            let config = SwarmConfig {
                max_concurrency: 2,
                task_timeout_ms: None,
                ..SwarmConfig::default()
            };

            let executor = Arc::new(SwarmExecutor::new(plan, config).unwrap());
            let sibling_started = Arc::new(Notify::new());
            let release_sibling = Arc::new(Notify::new());
            let sibling_finished = Arc::new(AtomicBool::new(false));

            let run_executor = Arc::clone(&executor);
            let run_sibling_started = Arc::clone(&sibling_started);
            let run_release_sibling = Arc::clone(&release_sibling);
            let run_sibling_finished = Arc::clone(&sibling_finished);
            let mut run = tokio::spawn(async move {
                run_executor
                    .run(move |task| {
                        let is_sibling = task.id == "sibling";
                        let sibling_started = Arc::clone(&run_sibling_started);
                        let release_sibling = Arc::clone(&run_release_sibling);
                        let sibling_finished = Arc::clone(&run_sibling_finished);
                        async move {
                            if is_sibling {
                                sibling_started.notify_one();
                                release_sibling.notified().await;
                                sibling_finished.store(true, Ordering::SeqCst);
                            }
                            Ok(successful_task_result())
                        }
                    })
                    .await
            });

            sibling_started.notified().await;
            executor.cancel();

            assert!(
                tokio::time::timeout(Duration::from_millis(50), &mut run)
                    .await
                    .is_err(),
                "cancellation must wait for the admitted sibling"
            );

            release_sibling.notify_one();
            let state = tokio::time::timeout(Duration::from_secs(1), run)
                .await
                .unwrap()
                .unwrap()
                .unwrap();

            assert_eq!(state.status, SwarmStatus::Cancelled);
            assert!(state.running_tasks.is_empty());
            assert!(sibling_finished.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn failure_waits_for_admitted_sibling_before_returning() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        runtime.block_on(async {
            let plan = SwarmPlan::new("Failure drain")
                .with_tasks(vec![
                    SwarmTask::new("failing", "Failing task"),
                    SwarmTask::new("sibling", "Long sibling"),
                ])
                .with_max_concurrency(2);
            let config = SwarmConfig {
                max_concurrency: 2,
                task_timeout_ms: None,
                ..SwarmConfig::default()
            };

            let executor = Arc::new(SwarmExecutor::new(plan, config).unwrap());
            let sibling_started = Arc::new(Notify::new());
            let release_sibling = Arc::new(Notify::new());
            let sibling_finished = Arc::new(AtomicBool::new(false));

            let run_executor = Arc::clone(&executor);
            let run_sibling_started = Arc::clone(&sibling_started);
            let run_release_sibling = Arc::clone(&release_sibling);
            let run_sibling_finished = Arc::clone(&sibling_finished);
            let mut run = tokio::spawn(async move {
                run_executor
                    .run(move |task| {
                        let is_failing = task.id == "failing";
                        let is_sibling = task.id == "sibling";
                        let sibling_started = Arc::clone(&run_sibling_started);
                        let release_sibling = Arc::clone(&run_release_sibling);
                        let sibling_finished = Arc::clone(&run_sibling_finished);
                        async move {
                            if is_failing {
                                return Err(anyhow::anyhow!("expected child failure"));
                            }
                            if is_sibling {
                                sibling_started.notify_one();
                                release_sibling.notified().await;
                                sibling_finished.store(true, Ordering::SeqCst);
                            }
                            Ok(successful_task_result())
                        }
                    })
                    .await
            });

            sibling_started.notified().await;

            assert!(
                tokio::time::timeout(Duration::from_millis(50), &mut run)
                    .await
                    .is_err(),
                "failure must wait for the admitted sibling"
            );

            release_sibling.notify_one();
            let state = tokio::time::timeout(Duration::from_secs(1), run)
                .await
                .unwrap()
                .unwrap()
                .unwrap();

            assert_eq!(state.status, SwarmStatus::Failed);
            assert!(state.running_tasks.is_empty());
            assert!(state.failed_tasks.contains("failing"));
            assert!(sibling_finished.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn panicking_task_is_terminalized_without_detaching() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        runtime.block_on(async {
            let plan = SwarmPlan::new("Panic handling")
                .with_tasks(vec![SwarmTask::new("panic", "Panicking task")]);
            let config = SwarmConfig {
                task_timeout_ms: None,
                ..SwarmConfig::default()
            };
            let executor = SwarmExecutor::new(plan, config).unwrap();

            let state = executor
                .run(|_task| async {
                    panic!("expected child panic");
                })
                .await
                .unwrap();

            assert_eq!(state.status, SwarmStatus::Failed);
            assert!(state.running_tasks.is_empty());
            assert!(state.failed_tasks.contains("panic"));
            assert_eq!(
                state.plan.get_task("panic").map(|task| task.status),
                Some(TaskStatus::Failed)
            );
        });
    }

    #[test]
    fn configured_task_timeout_fails_without_detaching() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        runtime.block_on(async {
            let plan = SwarmPlan::new("Timeout handling")
                .with_tasks(vec![SwarmTask::new("timeout", "Timed out task")]);
            let config = SwarmConfig {
                task_timeout_ms: Some(10),
                ..SwarmConfig::default()
            };
            let executor = SwarmExecutor::new(plan, config).unwrap();

            let state = executor
                .run(|_task| async { std::future::pending::<Result<TaskResult>>().await })
                .await
                .unwrap();

            assert_eq!(state.status, SwarmStatus::Failed);
            assert!(state.running_tasks.is_empty());
            assert!(state.failed_tasks.contains("timeout"));
            assert_eq!(
                state
                    .plan
                    .get_task("timeout")
                    .and_then(|task| task.result.as_ref())
                    .and_then(|result| result.error.as_deref()),
                Some("Task timed out")
            );
        });
    }
}

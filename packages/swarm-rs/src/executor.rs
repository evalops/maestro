//! Swarm Executor
//!
//! Coordinates execution of tasks across multiple agents.

use anyhow::Result;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{RwLock, mpsc};
use tokio::task::JoinHandle;

use super::expansion::{SwarmTaskContext, SwarmTaskOutcome, expanded_plan, files_overlap};
use super::plan_parser::validate_plan;
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
    /// `max_tasks` bounds all tasks, including completed discovery tasks. Each
    /// expansion is validated atomically and becomes a barrier for the source's
    /// existing consumers. Callbacks receive dependency results outside the
    /// parent conversation. The caller still owns admission, persistence,
    /// idempotency, effect cancellation, and final acceptance; this scheduler
    /// is an in-process cache and cannot recover a process crash itself.
    pub async fn run_expanding<F, Fut>(
        &self,
        max_tasks: usize,
        task_executor: F,
    ) -> Result<SwarmState>
    where
        F: Fn(SwarmTaskContext) -> Fut + Send + Sync + Clone + 'static,
        Fut: std::future::Future<Output = Result<SwarmTaskOutcome>> + Send,
    {
        let start_time = Instant::now();
        let mut spawned_tasks = Vec::new();
        let mut terminal_event = None;

        // Initialize
        {
            let mut state = self.state.write().await;
            anyhow::ensure!(
                state.status == SwarmStatus::Initializing,
                "Swarm execution has already started"
            );
            anyhow::ensure!(
                max_tasks > 0 && state.plan.tasks.len() <= max_tasks,
                "Initial plan exceeds swarm task budget"
            );
            state.status = SwarmStatus::Running;
            state.started_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            );
        }

        // Emit started event
        let (plan_title, total_tasks) = {
            let state = self.state.read().await;
            (state.plan.title.clone(), state.plan.tasks.len())
        };
        self.emit(SwarmEvent::Started {
            plan_title,
            total_tasks,
        })
        .await;

        // Main execution loop
        loop {
            self.reap_finished_tasks(&mut spawned_tasks).await;

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
                let state = self.state.read().await;
                let all_done = state.plan.tasks.iter().all(|t| {
                    state.completed_tasks.contains(&t.id)
                        || state.failed_tasks.contains(&t.id)
                        || t.status == TaskStatus::Skipped
                });
                drop(state);

                if all_done {
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

            // Start ready tasks
            if can_start_more {
                for task in ready_tasks {
                    let agent_id = format!("agent-{}", uuid::Uuid::new_v4());
                    let task_id = task.id.clone();
                    let task_title = task.title.clone();

                    // Mark as running
                    {
                        let mut state = self.state.write().await;
                        state
                            .running_tasks
                            .insert(task_id.clone(), agent_id.clone());
                        if let Some(t) = state.plan.get_task_mut(&task_id) {
                            t.status = TaskStatus::Running;
                            t.assigned_agent = Some(agent_id.clone());
                        }
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
                                Err(_) => Err(anyhow::anyhow!("Task timed out")),
                            }
                        } else {
                            executor(context).await
                        };

                        // Update state
                        let mut s = state.write().await;
                        s.running_tasks.remove(&task_id);

                        let outcome = result.map(|mut outcome| {
                            if outcome.result.success && !outcome.follow_up_tasks.is_empty() {
                                match expanded_plan(
                                    &s.plan,
                                    &task_id,
                                    outcome.follow_up_tasks,
                                    max_tasks,
                                ) {
                                    Ok(plan) => s.plan = plan,
                                    Err(error) => {
                                        outcome.result.success = false;
                                        outcome.result.error =
                                            Some(format!("Task expansion rejected: {error}"));
                                    }
                                }
                            }
                            outcome.result
                        });
                        let task_result = match outcome {
                            Ok(result) => result,
                            Err(error) => TaskResult {
                                success: false,
                                output: String::new(),
                                files_modified: Vec::new(),
                                duration_ms: 0,
                                error: Some(error.to_string()),
                            },
                        };
                        if task_result.success {
                            s.completed_tasks.insert(task_id.clone());
                        } else {
                            s.failed_tasks.insert(task_id.clone());
                        }
                        if let Some(task) = s.plan.get_task_mut(&task_id) {
                            task.status = if task_result.success {
                                TaskStatus::Completed
                            } else {
                                TaskStatus::Failed
                            };
                            task.result = Some(task_result.clone());
                        }
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

            // Brief sleep to prevent busy loop
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Cancellation and dependency failure are terminal scheduler states,
        // but they do not cancel an admitted callback.  Drain every retained
        // handle before publishing the terminal event or returning state so a
        // caller cannot release its owner while a child is still settling.
        self.drain_spawned_tasks(&mut spawned_tasks).await;
        let terminal_emitted = terminal_event.is_some();
        if let Some(event) = terminal_event {
            self.emit(event).await;
        }

        // Finalize
        let duration_ms = start_time.elapsed().as_millis() as u64;
        let mut state = self.state.write().await;

        let successful = state.completed_tasks.len();
        let failed = state.failed_tasks.len();
        let skipped = state
            .plan
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Skipped)
            .count();

        // Continuing independent work never converts failed verification into
        // aggregate success. Cancellation retains its explicit terminal state.
        if state.status != SwarmStatus::Cancelled {
            state.status = if failed > 0 || skipped > 0 || state.status == SwarmStatus::Failed {
                SwarmStatus::Failed
            } else {
                SwarmStatus::Completed
            };
        }

        let result = state.clone();
        drop(state);

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

        Ok(result)
    }

    /// Reap callbacks that completed since the previous scheduler iteration.
    /// Normal callbacks update state themselves; a panic before that update
    /// must still release the running slot and become a failed task instead of
    /// leaving the scheduler spinning forever.
    async fn reap_finished_tasks(&self, spawned_tasks: &mut Vec<SpawnedTask>) {
        let mut index = 0;
        while index < spawned_tasks.len() {
            if !spawned_tasks[index].handle.is_finished() {
                index += 1;
                continue;
            }

            let spawned = spawned_tasks.swap_remove(index);
            if let Err(error) = spawned.handle.await {
                self.mark_task_failed(
                    spawned.task_id,
                    format!("Task worker exited before reporting completion: {error}"),
                )
                .await;
            }
        }
    }

    /// Await every admitted callback.  This deliberately does not abort a
    /// child: a callback may already have submitted a durable effect and must
    /// be allowed to observe that effect's terminal result before the owner
    /// run returns.
    async fn drain_spawned_tasks(&self, spawned_tasks: &mut Vec<SpawnedTask>) {
        while let Some(spawned) = spawned_tasks.pop() {
            if let Err(error) = spawned.handle.await {
                self.mark_task_failed(
                    spawned.task_id,
                    format!("Task worker exited before reporting completion: {error}"),
                )
                .await;
            }
        }
    }

    async fn mark_task_failed(&self, task_id: String, error: String) {
        let should_emit = {
            let mut state = self.state.write().await;
            if state.running_tasks.remove(&task_id).is_none() {
                false
            } else {
                state.failed_tasks.insert(task_id.clone());
                if let Some(task) = state.plan.get_task_mut(&task_id) {
                    task.status = TaskStatus::Failed;
                    task.result = Some(TaskResult {
                        success: false,
                        output: String::new(),
                        files_modified: Vec::new(),
                        duration_ms: 0,
                        error: Some(error.clone()),
                    });
                }
                true
            }
        };

        if should_emit {
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

//! Swarm Executor
//!
//! Coordinates execution of tasks across multiple agents.

use anyhow::Result;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

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

impl SwarmExecutor {
    /// Create a new executor with a plan
    pub fn new(plan: SwarmPlan, config: SwarmConfig) -> Result<Self> {
        // Validate the plan
        validate_plan(&plan)?;

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

    /// Cancel execution
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
        let start_time = Instant::now();

        // Initialize
        {
            let mut state = self.state.write().await;
            state.status = SwarmStatus::Running;
            state.started_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            );
        }

        // Emit started event
        let state = self.state.read().await;
        self.emit(SwarmEvent::Started {
            plan_title: state.plan.title.clone(),
            total_tasks: state.plan.tasks.len(),
        })
        .await;
        drop(state);

        // Main execution loop
        loop {
            if self.is_cancelled() {
                self.emit(SwarmEvent::Cancelled {
                    reason: "User cancelled".to_string(),
                })
                .await;
                let mut state = self.state.write().await;
                state.status = SwarmStatus::Cancelled;
                break;
            }

            let state = self.state.read().await;

            // Check if done
            if state.is_done() {
                break;
            }

            // Find tasks we can start
            let ready_tasks: Vec<SwarmTask> = state
                .plan
                .tasks
                .iter()
                .filter(|t| {
                    t.status == TaskStatus::Pending
                        && !state.running_tasks.contains_key(&t.id)
                        && t.can_start(&state.completed_tasks)
                })
                .take(state.config.max_concurrency - state.running_tasks.len())
                .cloned()
                .collect();

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

                // Check for stuck state (tasks pending but blocked by failed deps)
                let mut state = self.state.write().await;
                let mut stuck = false;

                // Collect info needed to check dependencies (to avoid borrow conflicts)
                let failed_tasks = state.failed_tasks.clone();
                let continue_on_failure = state.config.continue_on_failure;

                for task in &mut state.plan.tasks {
                    if task.status == TaskStatus::Pending {
                        // Check if any dependency failed
                        let dep_failed = task.dependencies.iter().any(|d| failed_tasks.contains(d));

                        if dep_failed && !continue_on_failure {
                            task.status = TaskStatus::Skipped;
                            stuck = true;
                        }
                    }
                }

                if stuck && !continue_on_failure {
                    state.status = SwarmStatus::Failed;
                    drop(state);
                    self.emit(SwarmEvent::Failed {
                        error: "Tasks blocked by failed dependencies".to_string(),
                    })
                    .await;
                    break;
                }

                drop(state);
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

                    tokio::spawn(async move {
                        let result = if let Some(timeout_ms) = timeout {
                            match tokio::time::timeout(
                                Duration::from_millis(timeout_ms),
                                executor(task),
                            )
                            .await
                            {
                                Ok(r) => r,
                                Err(_) => Err(anyhow::anyhow!("Task timed out")),
                            }
                        } else {
                            executor(task).await
                        };

                        // Update state
                        let mut s = state.write().await;
                        s.running_tasks.remove(&task_id);

                        match result {
                            Ok(task_result) => {
                                s.completed_tasks.insert(task_id.clone());
                                if let Some(t) = s.plan.get_task_mut(&task_id) {
                                    t.status = TaskStatus::Completed;
                                    t.result = Some(task_result.clone());
                                }
                                let _ = event_tx.send(SwarmEvent::TaskCompleted {
                                    task_id,
                                    result: task_result,
                                });
                            }
                            Err(e) => {
                                s.failed_tasks.insert(task_id.clone());
                                if let Some(t) = s.plan.get_task_mut(&task_id) {
                                    t.status = TaskStatus::Failed;
                                    t.result = Some(TaskResult {
                                        success: false,
                                        output: String::new(),
                                        files_modified: Vec::new(),
                                        duration_ms: 0,
                                        error: Some(e.to_string()),
                                    });
                                }
                                let _ = event_tx.send(SwarmEvent::TaskFailed {
                                    task_id,
                                    error: e.to_string(),
                                });
                            }
                        }
                    });
                }
            }

            // Brief sleep to prevent busy loop
            tokio::time::sleep(Duration::from_millis(100)).await;
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

        let final_status = state.status;
        if state.failed_tasks.is_empty() || final_status == SwarmStatus::Cancelled {
            // Keep current status
        } else if !state.config.continue_on_failure {
            state.status = SwarmStatus::Failed;
        } else if final_status != SwarmStatus::Cancelled {
            state.status = SwarmStatus::Completed;
        }

        if state.status == SwarmStatus::Running {
            state.status = SwarmStatus::Completed;
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

        Ok(result)
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
        let plan =
            SwarmPlan::new("Test Plan").with_tasks(vec![SwarmTask::new("task-1", "First Task")
                .with_dependencies(vec!["nonexistent".into()])]);

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

    // Note: Full executor integration tests require a proper async runtime
    // and are complex due to spawned tasks. These are tested via integration
    // tests or manual verification.
}

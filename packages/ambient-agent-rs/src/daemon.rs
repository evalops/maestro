//! Ambient Daemon
//!
//! Main orchestration loop that ties all components together.
//! Watches for events, makes decisions, executes tasks, and learns.

use crate::{
    cascader::{Cascader, RoutingResult, TaskContext},
    checkpoint::CheckpointManager,
    critic::{Critic, CriticConfig},
    decider::{Decider, DeciderConfig},
    event_bus::{EventBus, EventBusConfig},
    learner::{Learner, Outcome},
    types::*,
};
use chrono::Utc;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, warn};

/// Commands sent to the daemon
#[derive(Debug)]
pub enum DaemonCommand {
    /// Pause processing
    Pause,
    /// Resume processing
    Resume,
    /// Shutdown gracefully
    Shutdown,
    /// Process a specific event
    ProcessEvent(NormalizedEvent),
    /// Update configuration
    UpdateConfig(AmbientConfig),
}

/// Status of the daemon
#[derive(Debug, Clone, PartialEq)]
pub enum DaemonStatus {
    Starting,
    Running,
    Paused,
    ShuttingDown,
    Stopped,
}

/// Statistics about daemon operation
#[derive(Debug, Clone, Default)]
pub struct DaemonStats {
    pub events_processed: u64,
    pub tasks_executed: u64,
    pub tasks_succeeded: u64,
    pub tasks_failed: u64,
    pub prs_created: u64,
    pub total_cost: f64,
    pub uptime_secs: u64,
}

/// The main daemon orchestrating all components
pub struct AmbientDaemon {
    config: AmbientConfig,
    event_bus: Arc<RwLock<EventBus>>,
    decider: Arc<RwLock<Decider>>,
    critic: Arc<Critic>,
    cascader: Arc<RwLock<Cascader>>,
    checkpoint_mgr: Arc<RwLock<CheckpointManager>>,
    learner: Arc<RwLock<Learner>>,
    status: Arc<RwLock<DaemonStatus>>,
    stats: Arc<RwLock<DaemonStats>>,
    command_tx: mpsc::Sender<DaemonCommand>,
    command_rx: Option<mpsc::Receiver<DaemonCommand>>,
    start_time: chrono::DateTime<Utc>,
}

impl AmbientDaemon {
    /// Create a new daemon
    pub fn new(config: AmbientConfig, data_dir: PathBuf) -> Self {
        let (command_tx, command_rx) = mpsc::channel(100);

        // Initialize components
        let event_bus_config = EventBusConfig {
            persist_dir: data_dir.join("events"),
            ..Default::default()
        };
        let event_bus = EventBus::new(event_bus_config);

        let decider_config = DeciderConfig {
            thresholds: config.thresholds.clone(),
            ..Default::default()
        };
        let decider = Decider::new(decider_config);

        let critic = Critic::new(CriticConfig::default());

        let cascader = Cascader::new(None);

        let checkpoint_mgr = CheckpointManager::new(data_dir.join("checkpoints"));

        let learner = Learner::new(data_dir.join("learner.json"));

        Self {
            config,
            event_bus: Arc::new(RwLock::new(event_bus)),
            decider: Arc::new(RwLock::new(decider)),
            critic: Arc::new(critic),
            cascader: Arc::new(RwLock::new(cascader)),
            checkpoint_mgr: Arc::new(RwLock::new(checkpoint_mgr)),
            learner: Arc::new(RwLock::new(learner)),
            status: Arc::new(RwLock::new(DaemonStatus::Starting)),
            stats: Arc::new(RwLock::new(DaemonStats::default())),
            command_tx,
            command_rx: Some(command_rx),
            start_time: Utc::now(),
        }
    }

    /// Get a command sender for controlling the daemon
    pub fn get_command_sender(&self) -> mpsc::Sender<DaemonCommand> {
        self.command_tx.clone()
    }

    /// Get current status
    pub async fn get_status(&self) -> DaemonStatus {
        self.status.read().await.clone()
    }

    /// Get current stats
    pub async fn get_stats(&self) -> DaemonStats {
        let mut stats = self.stats.read().await.clone();
        stats.uptime_secs = (Utc::now() - self.start_time).num_seconds() as u64;
        stats
    }

    /// Run the daemon main loop
    pub async fn run(&mut self) -> anyhow::Result<()> {
        info!("Starting Ambient Daemon");

        // Load persisted state
        self.load_state().await?;

        // Update status
        *self.status.write().await = DaemonStatus::Running;

        // Subscribe to events
        let mut event_rx = self.event_bus.read().await.subscribe();

        // Take ownership of command receiver
        let mut command_rx = self.command_rx.take()
            .ok_or_else(|| anyhow::anyhow!("Daemon already running"))?;

        info!("Daemon running, waiting for events");

        loop {
            tokio::select! {
                // Handle commands
                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        DaemonCommand::Pause => {
                            info!("Pausing daemon");
                            *self.status.write().await = DaemonStatus::Paused;
                        }
                        DaemonCommand::Resume => {
                            info!("Resuming daemon");
                            *self.status.write().await = DaemonStatus::Running;
                        }
                        DaemonCommand::Shutdown => {
                            info!("Shutting down daemon");
                            *self.status.write().await = DaemonStatus::ShuttingDown;
                            break;
                        }
                        DaemonCommand::ProcessEvent(event) => {
                            if *self.status.read().await == DaemonStatus::Running {
                                self.process_event(event).await;
                            }
                        }
                        DaemonCommand::UpdateConfig(new_config) => {
                            info!("Updating configuration");
                            self.config = new_config;
                        }
                    }
                }

                // Handle events from bus
                Ok(event) = event_rx.recv() => {
                    if *self.status.read().await == DaemonStatus::Running {
                        self.process_event(event).await;
                    }
                }
            }
        }

        // Cleanup
        self.save_state().await?;
        *self.status.write().await = DaemonStatus::Stopped;

        info!("Daemon stopped");
        Ok(())
    }

    /// Process a single event
    async fn process_event(&self, event: NormalizedEvent) {
        debug!("Processing event: {} - {}", event.id, event.title);

        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.events_processed += 1;
        }

        // Get confidence adjustment from learner
        let confidence_adj = self.learner.read().await.get_confidence_adjustment(&event);

        // Make decision
        let decision = self.decider.read().await.decide(&event).await;

        // Apply learner adjustment
        let adjusted_confidence = (decision.confidence + confidence_adj).clamp(0.0, 1.0);

        info!(
            "Event {} - confidence: {:.2} (adj: {:.2}) -> {:?}",
            event.id, decision.confidence, adjusted_confidence, decision.action
        );

        match decision.action {
            DecisionAction::Execute => {
                if let Some(plan) = decision.plan {
                    self.execute_plan(event, plan).await;
                }
            }
            DecisionAction::Ask => {
                // In a real implementation, this would notify the user
                info!("Would ask user about: {}", event.title);
            }
            DecisionAction::Skip => {
                debug!("Skipping event: {}", event.id);
            }
            DecisionAction::Queue => {
                debug!("Queuing event for later: {}", event.id);
            }
        }
    }

    /// Execute a task plan
    async fn execute_plan(&self, event: NormalizedEvent, plan: TaskPlan) {
        let start_time = Utc::now();

        // Create checkpoint
        let checkpoint_id = match self.checkpoint_mgr.write().await
            .create(&plan.task_id, &plan.summary).await
        {
            Ok(id) => id,
            Err(e) => {
                error!("Failed to create checkpoint: {}", e);
                return;
            }
        };

        // Route to appropriate model
        let task = Task {
            id: plan.task_id.clone(),
            task_type: TaskType::Fix, // Would be determined by analysis
            prompt: format!("{}\n\n{}", event.title, event.body.as_deref().unwrap_or_default()),
            files: plan.files.clone(),
            depends_on: vec![],
            priority: event.priority,
            estimated_tokens: None,
        };

        let context = TaskContext {
            complexity: plan.estimated_complexity,
            task_type: TaskType::Fix,
            estimated_tokens: None,
            previous_attempts: 0,
        };

        let routing = self.cascader.write().await.route(&task, &context);

        info!(
            "Routed to {} ({}) - estimated cost: ${:.4}",
            routing.tier.name, routing.model, routing.estimated_cost
        );

        // Execute (placeholder - real implementation would call the LLM)
        let result = self.mock_execute(&plan, &routing).await;

        // Critique the result
        let critique = self.critic.critique(&plan, &result).await;

        info!(
            "Critique: approved={}, confidence={:.2}, issues={}",
            critique.approved,
            critique.confidence,
            critique.issues.len()
        );

        // Record outcome
        let duration = (Utc::now() - start_time).num_seconds() as u64;
        let outcome = Outcome {
            task_id: plan.task_id.clone(),
            event_type: event.event_type,
            task_type: TaskType::Fix,
            complexity: plan.estimated_complexity,
            model_used: routing.model.clone(),
            success: critique.approved && result.status == ExecutionStatus::Success,
            confidence_predicted: critique.confidence,
            tokens_used: 0, // Would come from actual execution
            cost_usd: routing.estimated_cost,
            duration_secs: duration,
            failure_reason: result.error.clone(),
            labels: event.labels.clone(),
            repo: event.repository.clone(),
            timestamp: Utc::now(),
        };

        if let Err(e) = self.learner.write().await.record_outcome(outcome).await {
            error!("Failed to record outcome: {}", e);
        }

        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.tasks_executed += 1;
            if critique.approved {
                stats.tasks_succeeded += 1;
            } else {
                stats.tasks_failed += 1;
            }
            stats.total_cost += routing.estimated_cost;
        }

        // Handle result
        if critique.approved {
            // Commit checkpoint
            if let Err(e) = self.checkpoint_mgr.write().await.commit(&checkpoint_id).await {
                error!("Failed to commit checkpoint: {}", e);
            }

            // Would create PR here
            info!("Would create PR for: {}", plan.summary);
        } else {
            // Rollback
            warn!("Critique failed, rolling back");
            for issue in &critique.issues {
                warn!("  - {:?}: {}", issue.severity, issue.description);
            }

            if let Err(e) = self.checkpoint_mgr.write().await.rollback(&checkpoint_id).await {
                error!("Failed to rollback: {}", e);
            }
        }
    }

    /// Mock execution (placeholder for real LLM execution)
    async fn mock_execute(&self, plan: &TaskPlan, _routing: &RoutingResult) -> ExecutionResult {
        // In reality, this would:
        // 1. Prepare the context/prompt
        // 2. Call the LLM via the routed model
        // 3. Parse the response
        // 4. Apply file changes
        // 5. Run tests
        // 6. Return results

        ExecutionResult {
            status: ExecutionStatus::Success,
            changes: vec![],
            test_results: vec![],
            error: None,
            logs: vec![format!("Mock execution of: {}", plan.summary)],
        }
    }

    /// Load persisted state
    async fn load_state(&self) -> anyhow::Result<()> {
        // Load checkpoints
        let count = self.checkpoint_mgr.write().await.load_checkpoints().await?;
        info!("Loaded {} checkpoints", count);

        // Load learner data
        self.learner.write().await.load().await?;
        let stats = self.learner.read().await.get_stats();
        info!(
            "Loaded learner: {} outcomes, {:.1}% success rate",
            stats.total_outcomes,
            stats.overall_success_rate * 100.0
        );

        Ok(())
    }

    /// Save state before shutdown
    async fn save_state(&self) -> anyhow::Result<()> {
        // Persist learner
        self.learner.read().await.persist().await?;

        // Event bus persists automatically

        info!("State saved");
        Ok(())
    }
}

/// Builder for AmbientDaemon
pub struct DaemonBuilder {
    config: Option<AmbientConfig>,
    data_dir: Option<PathBuf>,
}

impl DaemonBuilder {
    pub fn new() -> Self {
        Self {
            config: None,
            data_dir: None,
        }
    }

    pub fn config(mut self, config: AmbientConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub fn data_dir(mut self, path: PathBuf) -> Self {
        self.data_dir = Some(path);
        self
    }

    pub fn build(self) -> anyhow::Result<AmbientDaemon> {
        let config = self.config.ok_or_else(|| anyhow::anyhow!("Config required"))?;
        let data_dir = self.data_dir.unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("ambient-agent")
        });

        Ok(AmbientDaemon::new(config, data_dir))
    }
}

impl Default for DaemonBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_config() -> AmbientConfig {
        AmbientConfig {
            enabled: true,
            auto_triggers: vec![],
            thresholds: Thresholds {
                auto_execute: 0.8,
                ask_human: 0.5,
                skip: 0.0,
            },
            limits: Limits::default(),
            capabilities: Capabilities::default(),
            schedule: ScheduleConfig::default(),
            notify: NotifyConfig::default(),
            learning: LearningConfig::default(),
        }
    }

    #[tokio::test]
    async fn test_daemon_lifecycle() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .build()
            .unwrap();

        // Check initial status
        assert_eq!(daemon.get_status().await, DaemonStatus::Starting);

        // Get command sender
        let cmd_tx = daemon.get_command_sender();

        // Spawn daemon in background
        let daemon_handle = tokio::spawn(async move {
            daemon.run().await
        });

        // Give it a moment to start
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Send shutdown
        cmd_tx.send(DaemonCommand::Shutdown).await.unwrap();

        // Wait for completion
        let _ = daemon_handle.await;
    }
}

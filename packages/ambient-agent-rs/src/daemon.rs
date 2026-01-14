//! Ambient Daemon
//!
//! Main orchestration loop that ties all components together.
//! Watches for events, makes decisions, executes tasks, and learns.

use crate::{
    cascader::{Cascader, TaskContext},
    checkpoint::CheckpointManager,
    critic::{Critic, CriticConfig},
    decider::{Decider, DeciderConfig},
    event_bus::{EventBus, EventBusConfig},
    executor::{Executor, ExecutorConfig},
    ipc::{IpcCommand, IpcResponse, IpcServer, StatusResponse, default_socket_path, verify_token_constant_time},
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
    executor: Arc<Executor>,
    checkpoint_mgr: Arc<RwLock<CheckpointManager>>,
    learner: Arc<RwLock<Learner>>,
    status: Arc<RwLock<DaemonStatus>>,
    stats: Arc<RwLock<DaemonStats>>,
    command_tx: mpsc::Sender<DaemonCommand>,
    command_rx: Option<mpsc::Receiver<DaemonCommand>>,
    start_time: chrono::DateTime<Utc>,
    ipc_server: Option<IpcServer>,
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

        // Executor for real LLM calls
        let executor_config = ExecutorConfig {
            api_key: std::env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
            working_dir: data_dir.to_string_lossy().to_string(),
            ..Default::default()
        };
        let executor = Executor::new(executor_config);

        let checkpoint_mgr = CheckpointManager::new(data_dir.join("checkpoints"));

        let learner = Learner::new(data_dir.join("learner.json"));

        // IPC server for CLI communication
        let ipc_server = IpcServer::new(default_socket_path());

        Self {
            config,
            event_bus: Arc::new(RwLock::new(event_bus)),
            decider: Arc::new(RwLock::new(decider)),
            critic: Arc::new(critic),
            cascader: Arc::new(RwLock::new(cascader)),
            executor: Arc::new(executor),
            checkpoint_mgr: Arc::new(RwLock::new(checkpoint_mgr)),
            learner: Arc::new(RwLock::new(learner)),
            status: Arc::new(RwLock::new(DaemonStatus::Starting)),
            stats: Arc::new(RwLock::new(DaemonStats::default())),
            command_tx,
            command_rx: Some(command_rx),
            start_time: Utc::now(),
            ipc_server: Some(ipc_server),
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

        // Start IPC server
        let mut ipc_server = self.ipc_server.take()
            .ok_or_else(|| anyhow::anyhow!("IPC server already taken"))?;
        ipc_server.bind().await?;

        // Update status
        *self.status.write().await = DaemonStatus::Running;

        // Subscribe to events
        let mut event_rx = self.event_bus.read().await.subscribe();

        // Take ownership of command receiver
        let mut command_rx = self.command_rx.take()
            .ok_or_else(|| anyhow::anyhow!("Daemon already running"))?;

        // Clone Arc references for IPC handler
        let status_ref = self.status.clone();
        let stats_ref = self.stats.clone();
        let cmd_tx = self.command_tx.clone();
        let start_time = self.start_time;

        // Get auth token for verification
        let auth_token = ipc_server.token().to_string();

        // Spawn IPC handler task
        let ipc_handle = tokio::spawn(async move {
            loop {
                match ipc_server.accept().await {
                    Ok(mut stream) => {
                        let status = status_ref.clone();
                        let stats = stats_ref.clone();
                        let cmd_tx = cmd_tx.clone();
                        let token = auth_token.clone();

                        tokio::spawn(async move {
                            if let Ok(request) = IpcServer::read_request(&mut stream).await {
                                // Verify authentication token using constant-time comparison
                                let response = if !verify_token_constant_time(&request.token, &token) {
                                    warn!("IPC request with invalid token");
                                    IpcResponse::Unauthorized
                                } else {
                                    match request.command {
                                        IpcCommand::Ping => IpcResponse::Pong,
                                        IpcCommand::Stop => {
                                            let _ = cmd_tx.send(DaemonCommand::Shutdown).await;
                                            IpcResponse::Ok(Some("Stopping daemon".to_string()))
                                        }
                                        IpcCommand::Status => {
                                            let status_val = status.read().await;
                                            IpcResponse::Status(StatusResponse {
                                                running: *status_val == DaemonStatus::Running,
                                                status: format!("{:?}", *status_val),
                                                uptime_secs: (Utc::now() - start_time).num_seconds() as u64,
                                                pid: std::process::id(),
                                            })
                                        }
                                        IpcCommand::Stats => {
                                            let mut s = stats.read().await.clone();
                                            s.uptime_secs = (Utc::now() - start_time).num_seconds() as u64;
                                            IpcResponse::Stats(s.into())
                                        }
                                        IpcCommand::Pause => {
                                            let _ = cmd_tx.send(DaemonCommand::Pause).await;
                                            IpcResponse::Ok(Some("Pausing daemon".to_string()))
                                        }
                                        IpcCommand::Resume => {
                                            let _ = cmd_tx.send(DaemonCommand::Resume).await;
                                            IpcResponse::Ok(Some("Resuming daemon".to_string()))
                                        }
                                    }
                                };
                                let _ = IpcServer::write_response(&mut stream, &response).await;
                            }
                        });
                    }
                    Err(e) => {
                        // Socket closed, exit IPC handler
                        debug!("IPC accept error (likely shutdown): {}", e);
                        break;
                    }
                }
            }
        });

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
        ipc_handle.abort(); // Stop IPC handler
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

        // Apply learner adjustment to confidence and re-determine action
        let adjusted_confidence = (decision.confidence + confidence_adj).clamp(0.0, 1.0);
        let adjusted_action = {
            let thresholds = &self.config.thresholds;

            // Respect complexity-based execution blocks from the decider
            // If original decision was Ask despite high confidence, it's due to complexity
            // (Complex/High tasks are never auto-executed, even with high confidence)
            let complexity_blocked = decision.action == DecisionAction::Ask
                && decision.confidence >= thresholds.auto_execute;

            if complexity_blocked {
                // Don't upgrade to Execute - complexity restriction applies
                if adjusted_confidence >= thresholds.ask_human {
                    DecisionAction::Ask
                } else {
                    DecisionAction::Skip
                }
            } else if adjusted_confidence >= thresholds.auto_execute {
                DecisionAction::Execute
            } else if adjusted_confidence >= thresholds.ask_human {
                DecisionAction::Ask
            } else {
                DecisionAction::Skip
            }
        };

        info!(
            "Event {} - confidence: {:.2} -> {:.2} (learner adj: {:+.2}) -> {:?}",
            event.id, decision.confidence, adjusted_confidence, confidence_adj, adjusted_action
        );

        match adjusted_action {
            DecisionAction::Execute => {
                // Get plan from decision, or create one if learner upgraded the action
                let plan = match decision.plan {
                    Some(plan) => plan,
                    None => {
                        // Learner upgraded action to Execute but no plan exists
                        // Create a plan directly since the decision was for a lower action
                        info!(
                            "Learner upgraded action to Execute, creating plan for event {}",
                            event.id
                        );
                        self.decider.read().await.create_plan_for_event(&event).await
                    }
                };
                self.execute_plan(event, plan).await;
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

        // Determine the main task type from the plan
        let main_task_type = plan.tasks.first()
            .map(|t| t.task_type)
            .unwrap_or(TaskType::Fix);

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
            task_type: main_task_type,
            prompt: format!("{}\n\n{}", event.title, event.body.as_deref().unwrap_or_default()),
            files: plan.files.clone(),
            depends_on: vec![],
            priority: event.priority,
            estimated_tokens: None,
        };

        let context = TaskContext {
            complexity: plan.estimated_complexity,
            task_type: main_task_type,
            estimated_tokens: None,
            previous_attempts: 0,
        };

        let routing = self.cascader.write().await.route(&task, &context);

        info!(
            "Routed to {} ({}) - estimated cost: ${:.4}",
            routing.tier.name, routing.model, routing.estimated_cost
        );

        // Execute the plan using the real LLM
        let result = self.executor.execute(&plan, &routing).await;

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
            task_type: main_task_type,
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

    /// Load persisted state
    async fn load_state(&self) -> anyhow::Result<()> {
        // Load persisted events
        if let Err(e) = self.event_bus.read().await.init().await {
            warn!("Failed to load persisted events: {}", e);
        }

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

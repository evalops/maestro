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
    ipc::{
        default_socket_path, verify_token_constant_time, IpcCommand, IpcResponse, IpcServer,
        StatusResponse,
    },
    learner::{Learner, Outcome},
    platform_event_bus::{
        AmbientCloseReason, AmbientSessionEvent, AmbientSessionState, PlatformEventBus,
    },
    pr_creator::{PrCreator, PrCreatorConfig},
    types::*,
};
use chrono::Utc;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, warn};

/// Commands sent to the daemon
#[allow(clippy::large_enum_variant)]
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
    pr_creator: Arc<PrCreator>,
    status: Arc<RwLock<DaemonStatus>>,
    stats: Arc<RwLock<DaemonStats>>,
    command_tx: mpsc::Sender<DaemonCommand>,
    command_rx: Option<mpsc::Receiver<DaemonCommand>>,
    start_time: chrono::DateTime<Utc>,
    ipc_server: Option<IpcServer>,
    platform_event_bus: PlatformEventBus,
    session_id: String,
    data_dir: PathBuf,
    workspace_root: PathBuf,
}

impl AmbientDaemon {
    /// Create a new daemon
    pub fn new(config: AmbientConfig, data_dir: PathBuf) -> Self {
        Self::new_with_options(
            config,
            data_dir,
            PlatformEventBus::from_env(),
            default_socket_path(),
        )
    }

    fn new_with_options(
        config: AmbientConfig,
        data_dir: PathBuf,
        platform_event_bus: PlatformEventBus,
        ipc_socket_path: PathBuf,
    ) -> Self {
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

        // PR creator for creating pull requests
        let pr_creator_config = PrCreatorConfig {
            token: std::env::var("GITHUB_TOKEN").unwrap_or_default(),
            ..Default::default()
        };
        let pr_creator = PrCreator::new(pr_creator_config);

        // IPC server for CLI communication
        let ipc_server = IpcServer::new(ipc_socket_path);
        let workspace_root = std::env::current_dir().unwrap_or_else(|_| data_dir.clone());

        Self {
            config,
            event_bus: Arc::new(RwLock::new(event_bus)),
            decider: Arc::new(RwLock::new(decider)),
            critic: Arc::new(critic),
            cascader: Arc::new(RwLock::new(cascader)),
            executor: Arc::new(executor),
            checkpoint_mgr: Arc::new(RwLock::new(checkpoint_mgr)),
            learner: Arc::new(RwLock::new(learner)),
            pr_creator: Arc::new(pr_creator),
            status: Arc::new(RwLock::new(DaemonStatus::Starting)),
            stats: Arc::new(RwLock::new(DaemonStats::default())),
            command_tx,
            command_rx: Some(command_rx),
            start_time: Utc::now(),
            ipc_server: Some(ipc_server),
            platform_event_bus,
            session_id: uuid::Uuid::new_v4().to_string(),
            data_dir,
            workspace_root,
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
        let mut ipc_server = self
            .ipc_server
            .take()
            .ok_or_else(|| anyhow::anyhow!("IPC server already taken"))?;
        ipc_server.bind().await?;

        // Update status
        *self.status.write().await = DaemonStatus::Running;
        self.record_session_event(AmbientSessionState::Started, None, None)
            .await;

        // Subscribe to events
        let mut event_rx = self.event_bus.read().await.subscribe();

        // Take ownership of command receiver
        let mut command_rx = self
            .command_rx
            .take()
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
                                let response =
                                    if !verify_token_constant_time(&request.token, &token) {
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
                                                    uptime_secs: (Utc::now() - start_time)
                                                        .num_seconds()
                                                        as u64,
                                                    pid: std::process::id(),
                                                })
                                            }
                                            IpcCommand::Stats => {
                                                let mut s = stats.read().await.clone();
                                                s.uptime_secs =
                                                    (Utc::now() - start_time).num_seconds() as u64;
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

        let (close_reason, close_message) = loop {
            tokio::select! {
                // Handle commands
                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        DaemonCommand::Pause => {
                            info!("Pausing daemon");
                            *self.status.write().await = DaemonStatus::Paused;
                            self.record_session_event(AmbientSessionState::Suspended, None, None)
                                .await;
                        }
                        DaemonCommand::Resume => {
                            info!("Resuming daemon");
                            *self.status.write().await = DaemonStatus::Running;
                            self.record_session_event(AmbientSessionState::Resumed, None, None)
                                .await;
                        }
                        DaemonCommand::Shutdown => {
                            info!("Shutting down daemon");
                            *self.status.write().await = DaemonStatus::ShuttingDown;
                            break (
                                AmbientCloseReason::UserStopped,
                                Some("shutdown requested".to_string()),
                            );
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
        };

        // Cleanup
        ipc_handle.abort(); // Stop IPC handler
        let save_result = self.save_state().await;
        if let Err(error) = &save_result {
            warn!(
                "Failed to save Ambient daemon state during shutdown: {}",
                error
            );
        }
        *self.status.write().await = DaemonStatus::Stopped;
        self.record_session_event(
            AmbientSessionState::Closed,
            Some(close_reason),
            close_message,
        )
        .await;

        info!("Daemon stopped");
        save_result
    }

    async fn record_session_event(
        &self,
        state: AmbientSessionState,
        close_reason: Option<AmbientCloseReason>,
        close_message: Option<String>,
    ) {
        let status = self.get_status().await;
        let mut event = AmbientSessionEvent::new(&self.session_id, state, &self.workspace_root)
            .metadata(
                "daemon_status",
                format!("{:?}", status).to_ascii_lowercase(),
            )
            .metadata("data_dir", self.data_dir.to_string_lossy().to_string())
            .metadata("pid", serde_json::json!(std::process::id()));

        if let Some(reason) = close_reason {
            event = event.close_reason(reason);
        }
        if let Some(message) = close_message {
            event = event.close_message(message);
        }

        self.platform_event_bus.publish_session_event(event).await;
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
                        self.decider
                            .read()
                            .await
                            .create_plan_for_event(&event)
                            .await
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
        let main_task_type = plan
            .tasks
            .first()
            .map(|t| t.task_type)
            .unwrap_or(TaskType::Fix);

        // Create checkpoint
        let checkpoint_id = match self
            .checkpoint_mgr
            .write()
            .await
            .create(&plan.task_id, &plan.summary)
            .await
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
            prompt: format!(
                "{}\n\n{}",
                event.title,
                event.body.as_deref().unwrap_or_default()
            ),
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
            if let Err(e) = self
                .checkpoint_mgr
                .write()
                .await
                .commit(&checkpoint_id)
                .await
            {
                error!("Failed to commit checkpoint: {}", e);
            }

            // Create PR for the changes
            let pr_title = format!("[Ambient] {}", plan.summary);
            let pr_body = self.generate_pr_body(&plan, &result, &critique);
            let repo_path = std::path::Path::new(&event.repo.path);

            let pr_result = self
                .pr_creator
                .create_pr(
                    repo_path,
                    &event.repository,
                    &event.repo.default_branch,
                    &pr_title,
                    &pr_body,
                    &result.changes,
                    &event,
                )
                .await;

            if pr_result.success {
                info!(
                    "Created PR #{} at {}",
                    pr_result.pr_number.unwrap_or(0),
                    pr_result.pr_url.as_deref().unwrap_or("unknown")
                );
                self.stats.write().await.prs_created += 1;
            } else {
                warn!(
                    "Failed to create PR: {}",
                    pr_result.error.as_deref().unwrap_or("unknown error")
                );
            }
        } else {
            // Rollback
            warn!("Critique failed, rolling back");
            for issue in &critique.issues {
                warn!("  - {:?}: {}", issue.severity, issue.description);
            }

            if let Err(e) = self
                .checkpoint_mgr
                .write()
                .await
                .rollback(&checkpoint_id)
                .await
            {
                error!("Failed to rollback: {}", e);
            }
        }
    }

    /// Generate PR body from plan and results
    fn generate_pr_body(
        &self,
        plan: &TaskPlan,
        result: &ExecutionResult,
        critique: &CriticResult,
    ) -> String {
        let mut body = String::new();

        // Summary
        body.push_str("## Summary\n\n");
        body.push_str(&plan.summary);
        body.push_str("\n\n");

        // Changes
        body.push_str("## Changes\n\n");
        for change in &result.changes {
            let icon = match change.change_type {
                ChangeType::Create => "➕",
                ChangeType::Modify => "✏️",
                ChangeType::Delete => "🗑️",
                ChangeType::Rename => "📝",
            };
            body.push_str(&format!(
                "- {} `{}` (+{}, -{})\n",
                icon, change.file, change.additions, change.deletions
            ));
        }
        body.push('\n');

        // Test results
        if !result.test_results.is_empty() {
            body.push_str("## Test Results\n\n");
            for test in &result.test_results {
                let icon = if test.passed { "✅" } else { "❌" };
                body.push_str(&format!("- {} {}\n", icon, test.name));
            }
            body.push('\n');
        }

        // Critic assessment
        body.push_str("## Quality Assessment\n\n");
        body.push_str(&format!(
            "**Confidence:** {:.0}%\n\n",
            critique.confidence * 100.0
        ));

        if !critique.suggestions.is_empty() {
            body.push_str("**Suggestions:**\n");
            for suggestion in &critique.suggestions {
                body.push_str(&format!("- {}\n", suggestion));
            }
        }

        body
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
    ipc_socket_path: Option<PathBuf>,
    platform_event_bus: Option<PlatformEventBus>,
}

impl DaemonBuilder {
    pub fn new() -> Self {
        Self {
            config: None,
            data_dir: None,
            ipc_socket_path: None,
            platform_event_bus: None,
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

    pub fn ipc_socket_path(mut self, path: PathBuf) -> Self {
        self.ipc_socket_path = Some(path);
        self
    }

    pub fn platform_event_bus(mut self, publisher: PlatformEventBus) -> Self {
        self.platform_event_bus = Some(publisher);
        self
    }

    pub fn build(self) -> anyhow::Result<AmbientDaemon> {
        let config = self
            .config
            .ok_or_else(|| anyhow::anyhow!("Config required"))?;
        let data_dir = self.data_dir.unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("ambient-agent")
        });
        let ipc_socket_path = self.ipc_socket_path.unwrap_or_else(default_socket_path);
        let platform_event_bus = self
            .platform_event_bus
            .unwrap_or_else(PlatformEventBus::from_env);

        Ok(AmbientDaemon::new_with_options(
            config,
            data_dir,
            platform_event_bus,
            ipc_socket_path,
        ))
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
    use crate::platform_event_bus::{PlatformEventBusConfig, PlatformEventBusTransport};
    use async_trait::async_trait;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    #[derive(Default)]
    struct RecordingTransport {
        published: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl PlatformEventBusTransport for RecordingTransport {
        async fn publish(&self, subject: &str, payload: String) -> anyhow::Result<()> {
            self.published
                .lock()
                .unwrap()
                .push((subject.to_string(), payload));
            Ok(())
        }
    }

    async fn wait_for_published(transport: &RecordingTransport, expected_len: usize) {
        for _ in 0..50 {
            if transport.published.lock().unwrap().len() >= expected_len {
                return;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }
        let actual_len = transport.published.lock().unwrap().len();
        panic!("expected {expected_len} published events, got {actual_len}");
    }

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
            .ipc_socket_path(temp.path().join("daemon.sock"))
            .build()
            .unwrap();

        // Check initial status
        assert_eq!(daemon.get_status().await, DaemonStatus::Starting);

        // Get command sender
        let cmd_tx = daemon.get_command_sender();

        // Spawn daemon in background
        let daemon_handle = tokio::spawn(async move { daemon.run().await });

        // Give it a moment to start
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Send shutdown
        cmd_tx.send(DaemonCommand::Shutdown).await.unwrap();

        // Wait for completion
        let _ = daemon_handle.await;
    }

    #[tokio::test]
    async fn test_daemon_publishes_session_lifecycle_events() {
        let temp = TempDir::new().unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let publisher =
            PlatformEventBus::with_transport(PlatformEventBusConfig::for_test(), transport.clone());
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-events.sock"))
            .platform_event_bus(publisher)
            .build()
            .unwrap();
        let cmd_tx = daemon.get_command_sender();

        let daemon_handle = tokio::spawn(async move { daemon.run().await });

        wait_for_published(&transport, 1).await;
        cmd_tx.send(DaemonCommand::Pause).await.unwrap();
        wait_for_published(&transport, 2).await;
        cmd_tx.send(DaemonCommand::Resume).await.unwrap();
        wait_for_published(&transport, 3).await;
        cmd_tx.send(DaemonCommand::Shutdown).await.unwrap();

        daemon_handle.await.unwrap().unwrap();
        wait_for_published(&transport, 4).await;

        let published = transport.published.lock().unwrap();
        let subjects: Vec<_> = published
            .iter()
            .map(|(subject, _)| subject.as_str())
            .collect();
        assert_eq!(
            subjects,
            vec![
                "maestro.sessions.session.started",
                "maestro.sessions.session.suspended",
                "maestro.sessions.session.resumed",
                "maestro.sessions.session.closed",
            ]
        );

        let started: Value = serde_json::from_str(&published[0].1).unwrap();
        assert_eq!(started["source"], "maestro.ambient-agent");
        assert_eq!(
            started["data"]["correlation"]["agent_id"],
            "ambient_agent_daemon"
        );
        assert_eq!(
            started["data"]["runtime_mode"],
            "MAESTRO_RUNTIME_MODE_HEADLESS"
        );
        assert_ne!(
            started["data"]["workspace_root"],
            temp.path().to_string_lossy().as_ref()
        );
        assert_eq!(
            started["data"]["metadata"]["data_dir"],
            temp.path().to_string_lossy().as_ref()
        );

        let closed: Value = serde_json::from_str(&published[3].1).unwrap();
        assert_eq!(closed["data"]["state"], "MAESTRO_SESSION_STATE_CLOSED");
        assert_eq!(
            closed["data"]["close_reason"],
            "MAESTRO_CLOSE_REASON_USER_STOPPED"
        );
        assert_eq!(closed["data"]["close_message"], "shutdown requested");
    }
}

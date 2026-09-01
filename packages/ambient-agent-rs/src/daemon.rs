//! Ambient Daemon
//!
//! Main orchestration loop that ties all components together.
//! Watches for events, makes decisions, executes tasks, and learns.

use crate::{
    cascader::Cascader,
    checkpoint::CheckpointManager,
    critic::{Critic, CriticConfig},
    decider::{Decider, DeciderConfig},
    event_bus::{EventBus, EventBusConfig},
    execution_report::ExecutionReport,
    executor::{Executor, ExecutorConfig},
    goal_evaluator::{
        GoalEvaluationError, GoalEvaluator, GoalEvaluatorConfig, GoalEvaluatorDecision,
        GoalEvaluatorVerdict,
    },
    ipc::{
        IpcCommand, IpcResponse, IpcServer, StatusResponse, default_socket_path,
        verify_token_constant_time,
    },
    learner::Learner,
    platform_event_bus::{
        AmbientCloseReason, AmbientPlanEvent, AmbientPlanEventKind, AmbientSessionEvent,
        AmbientSessionState, PlatformEventBus,
    },
    pr_creator::{PrCreator, PrCreatorConfig},
    runtime_config::EffectiveRuntimeConfig,
    shadow_routing::ShadowRouter,
    task_run::{CostAccounting, PlanRunContext, PlanRunOutcome},
    types::*,
};
use chrono::Utc;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, mpsc};
use tracing::{debug, error, info, warn};

struct FinishedPlanExecution<'a> {
    event: &'a NormalizedEvent,
    plan: &'a TaskPlan,
    checkpoint_id: &'a str,
    model_used: &'a str,
    result: &'a ExecutionResult,
    critique: &'a CriticResult,
    success: bool,
}

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
    shadow_router: Arc<Mutex<ShadowRouter>>,
    executor: Arc<Executor>,
    goal_evaluator: Option<GoalEvaluator>,
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
            limits: config.limits.clone(),
            capabilities: config.capabilities.clone(),
            ..Default::default()
        };
        let decider = Decider::new(decider_config);

        let critic = Critic::new(CriticConfig::default());

        let cascader = Cascader::new(None);

        let shadow_router = match ShadowRouter::from_data_dir(&data_dir) {
            Ok(router) => router,
            Err(error) => {
                warn!("Shadow routing state unavailable; keeping selection disabled: {error}");
                ShadowRouter::disabled(&data_dir)
            }
        };

        // Executor for real LLM calls
        let executor_config = ExecutorConfig::from_env(data_dir.to_string_lossy().to_string());
        let executor = Arc::new(Executor::new(executor_config));

        // Goal evaluator: an independent LLM judge that adversarially checks
        // executor completion claims before the Critic verifies them. Disabled
        // without an API key; judge model overridable via env.
        let goal_evaluator = executor
            .has_api_key()
            .then(|| GoalEvaluator::new(GoalEvaluatorConfig::from_env(), executor.clone()));

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
            shadow_router: Arc::new(Mutex::new(shadow_router)),
            executor,
            goal_evaluator,
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
        let learner_ref = self.learner.clone();
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
                        let learner = learner_ref.clone();
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
                                            IpcCommand::FlushLearner => {
                                                let learner = learner.read().await;
                                                let learner_path =
                                                    learner.storage_path().display().to_string();
                                                match learner.persist().await {
                                                    Ok(()) => IpcResponse::Ok(Some(learner_path)),
                                                    Err(error) => IpcResponse::Error(format!(
                                                        "Failed to flush learner state: {error}"
                                                    )),
                                                }
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
                            let should_publish = {
                                let mut status = self.status.write().await;
                                if *status == DaemonStatus::Running {
                                    info!("Pausing daemon");
                                    *status = DaemonStatus::Paused;
                                    true
                                } else {
                                    debug!("Ignoring pause command while daemon is {:?}", *status);
                                    false
                                }
                            };
                            if should_publish {
                                self.record_session_event(AmbientSessionState::Suspended, None, None)
                                    .await;
                            }
                        }
                        DaemonCommand::Resume => {
                            let should_publish = {
                                let mut status = self.status.write().await;
                                if *status == DaemonStatus::Paused {
                                    info!("Resuming daemon");
                                    *status = DaemonStatus::Running;
                                    true
                                } else {
                                    debug!("Ignoring resume command while daemon is {:?}", *status);
                                    false
                                }
                            };
                            if should_publish {
                                self.record_session_event(AmbientSessionState::Resumed, None, None)
                                    .await;
                            }
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
                            self.update_config(new_config).await;
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

    async fn update_config(&mut self, new_config: AmbientConfig) {
        self.decider
            .write()
            .await
            .update_runtime_config(&new_config);
        self.config = new_config;
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

        // Apply learner adjustment to confidence and re-determine action unless
        // a deterministic policy/safety gate already made the decision final.
        let adjusted_confidence = if decision.final_action {
            decision.confidence
        } else {
            (decision.confidence + confidence_adj).clamp(0.0, 1.0)
        };
        let adjusted_action = if decision.final_action {
            decision.action
        } else {
            let effective_config = EffectiveRuntimeConfig::from_ambient(&self.config, &event);
            Self::adjusted_action(&decision, adjusted_confidence, effective_config.thresholds)
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

    fn adjusted_action(
        decision: &Decision,
        adjusted_confidence: f64,
        thresholds: &Thresholds,
    ) -> DecisionAction {
        if decision.auto_execute_blocked {
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
    }

    /// Execute a task plan
    async fn execute_plan(&self, event: NormalizedEvent, plan: TaskPlan) {
        let start_time = Utc::now();
        let run_context = PlanRunContext::from_plan(&event, &plan);

        let Some(checkpoint_id) = self.create_plan_checkpoint(&plan).await else {
            return;
        };

        let task = run_context.route_task(&event, &plan);
        let context = run_context.task_context();
        let primary_routing = self.cascader.write().await.route(&task, &context);
        let routing =
            match self
                .shadow_router
                .lock()
                .await
                .decide(&task, &context, &primary_routing)
            {
                Ok(decision) => decision.routing,
                Err(error) => {
                    warn!("Shadow routing decision failed; preserving primary route: {error}");
                    primary_routing
                }
            };

        info!(
            "Routed to {} ({}) - estimated cost: ${:.4}",
            routing.tier.name, routing.model, routing.estimated_cost
        );
        self.record_plan_event(
            AmbientPlanEventKind::RoutingSelected,
            &run_context,
            &routing,
            None,
        )
        .await;

        let effective_config = EffectiveRuntimeConfig::from_ambient(&self.config, &event);
        let limits = effective_config.limits;
        if routing.estimated_cost > limits.max_cost_per_task_usd {
            let failure_reason = format!(
                "estimated cost ${:.4} exceeds configured per-task limit ${:.4}",
                routing.estimated_cost, limits.max_cost_per_task_usd
            );
            warn!("Skipping event {} because {}", event.id, failure_reason);
            self.rollback_checkpoint(&checkpoint_id, "cost-limited")
                .await;
            let outcome = PlanRunOutcome::cost_limited(
                failure_reason,
                CostAccounting::estimated_only(routing.estimated_cost),
            );
            self.record_plan_event(
                AmbientPlanEventKind::CostLimited,
                &run_context,
                &routing,
                Some(&outcome),
            )
            .await;
            self.record_shadow_outcome(&routing, &outcome, start_time)
                .await;
            self.record_plan_outcome(&run_context, &routing.model, start_time, &outcome)
                .await;
            return;
        }

        let mut result = self.executor.execute(&plan, &routing).await;

        // Goal evaluation gate (grok-build pattern): an executor Success status
        // is only the agent's own claim of completion. When a judge is
        // configured, the claim must be confirmed as candidate_complete by an
        // independent, adversarial evaluation before the Critic runs
        // verification and a PR can be opened. A `continue` verdict feeds the
        // judge's next_step back into the executor for a bounded number of
        // retries (default 1); any rejection or judge failure after that is
        // conservative: roll back and do not ship.
        if result.status == ExecutionStatus::Success {
            if let Some(evaluator) = &self.goal_evaluator {
                let mut gate = Some(
                    evaluator
                        .evaluate_execution(&event, &plan, &result, &routing.model)
                        .await,
                );
                let mut retries_left = evaluator.max_continue_retries();
                let mut retry_notes: Vec<String> = Vec::new();
                loop {
                    let continue_verdict = match gate {
                        Some(Ok(ref verdict))
                            if retries_left > 0
                                && verdict.decision == GoalEvaluatorDecision::Continue =>
                        {
                            verdict.clone()
                        }
                        _ => break,
                    };
                    retries_left -= 1;
                    retry_notes.push(format!(
                        "attempt {}: {} (next: {})",
                        retry_notes.len() + 1,
                        continue_verdict.evidence,
                        continue_verdict.next_step
                    ));
                    info!(
                        "Goal evaluator: retrying execution with judge's next step — {}",
                        continue_verdict.next_step
                    );
                    let retry_plan = plan_with_retry_guidance(&plan, &continue_verdict);
                    result = self.executor.execute(&retry_plan, &routing).await;
                    if result.status != ExecutionStatus::Success {
                        // The retry itself failed; fall through to the normal
                        // failed-execution path instead of rejecting on a
                        // verdict that judged the previous attempt.
                        gate = None;
                        break;
                    }
                    gate = Some(
                        evaluator
                            .evaluate_execution(&event, &plan, &result, &routing.model)
                            .await,
                    );
                }
                if let Some(mut reason) = gate.and_then(goal_gate_rejection_reason) {
                    if !retry_notes.is_empty() {
                        reason = format!("{reason} (retried after: {})", retry_notes.join("; "));
                    }
                    warn!("Event {} not shipped: {}", event.id, reason);
                    let outcome = PlanRunOutcome::rejected(
                        reason,
                        CostAccounting::estimate_as_actual(routing.estimated_cost, 0),
                    );
                    self.record_plan_event(
                        AmbientPlanEventKind::ExecutionCompleted,
                        &run_context,
                        &routing,
                        Some(&outcome),
                    )
                    .await;
                    self.record_shadow_outcome(&routing, &outcome, start_time)
                        .await;
                    self.record_plan_outcome(&run_context, &routing.model, start_time, &outcome)
                        .await;
                    self.rollback_checkpoint(&checkpoint_id, "goal-evaluator-rejected")
                        .await;
                    return;
                }
            }
        }

        let critique = self.critic.critique(&plan, &result).await;

        info!(
            "Critique: approved={}, confidence={:.2}, issues={}",
            critique.approved,
            critique.confidence,
            critique.issues.len()
        );

        let outcome = PlanRunOutcome::from_execution(
            &result,
            &critique,
            CostAccounting::estimate_as_actual(routing.estimated_cost, 0),
        );
        self.record_plan_event(
            AmbientPlanEventKind::ExecutionCompleted,
            &run_context,
            &routing,
            Some(&outcome),
        )
        .await;
        self.record_shadow_outcome(&routing, &outcome, start_time)
            .await;
        self.record_plan_outcome(&run_context, &routing.model, start_time, &outcome)
            .await;
        self.finish_plan_execution(FinishedPlanExecution {
            event: &event,
            plan: &plan,
            checkpoint_id: &checkpoint_id,
            model_used: &routing.model,
            result: &result,
            critique: &critique,
            success: outcome.success,
        })
        .await;
    }

    async fn create_plan_checkpoint(&self, plan: &TaskPlan) -> Option<String> {
        match self
            .checkpoint_mgr
            .write()
            .await
            .create(&plan.task_id, &plan.summary)
            .await
        {
            Ok(id) => Some(id),
            Err(e) => {
                error!("Failed to create checkpoint: {}", e);
                None
            }
        }
    }

    async fn rollback_checkpoint(&self, checkpoint_id: &str, reason: &str) {
        if let Err(e) = self
            .checkpoint_mgr
            .write()
            .await
            .rollback(checkpoint_id)
            .await
        {
            error!("Failed to rollback {reason} checkpoint: {}", e);
        }
    }

    async fn record_plan_event(
        &self,
        kind: AmbientPlanEventKind,
        run_context: &PlanRunContext,
        routing: &crate::cascader::RoutingResult,
        outcome: Option<&PlanRunOutcome>,
    ) {
        let mut event = AmbientPlanEvent::new(&self.session_id, kind, &self.workspace_root)
            .event_id(run_context.event_id())
            .repository(run_context.repository())
            .task_type(format!("{:?}", run_context.task_type()).to_ascii_lowercase())
            .complexity(format!("{:?}", run_context.complexity()).to_ascii_lowercase())
            .model(routing.model.clone())
            .provider(Self::selected_model_provider())
            .tier(routing.tier.name.clone())
            .estimated_cost_usd(routing.estimated_cost)
            .metadata("routing_reason", routing.reason.clone());

        if let Some(outcome) = outcome {
            event = event
                .actual_cost_usd(outcome.costs.actual_cost_usd)
                .success(outcome.success);
            if let Some(reason) = &outcome.failure_reason {
                event = event.metadata("failure_reason", reason.clone());
            }
        }

        if let Some(decision_id) = &routing.shadow_decision_id {
            event = event.metadata("shadow_decision_id", decision_id.clone());
        }

        self.platform_event_bus.publish_plan_event(event).await;
    }

    fn selected_model_provider() -> &'static str {
        match std::env::var("MAESTRO_AMBIENT_LLM_API").ok().as_deref() {
            Some("anthropic") | Some("anthropic-messages") => "anthropic",
            _ => crate::cascader::DEFAULT_FRONTIER_PROVIDER,
        }
    }

    async fn record_shadow_outcome(
        &self,
        routing: &crate::cascader::RoutingResult,
        outcome: &PlanRunOutcome,
        start_time: chrono::DateTime<Utc>,
    ) {
        let Some(decision_id) = routing.shadow_decision_id.as_deref() else {
            return;
        };
        let latency_ms = (Utc::now() - start_time).num_milliseconds().max(0) as u64;
        if let Err(error) = self.shadow_router.lock().await.record_outcome(
            decision_id,
            outcome.confidence_predicted,
            outcome.success,
            outcome.costs.actual_cost_usd,
            latency_ms,
            outcome.costs.tokens_used,
        ) {
            warn!("Failed to persist shadow routing outcome: {error}");
        }
    }

    async fn commit_checkpoint(&self, checkpoint_id: &str) {
        if let Err(e) = self
            .checkpoint_mgr
            .write()
            .await
            .commit(checkpoint_id)
            .await
        {
            error!("Failed to commit checkpoint: {}", e);
        }
    }

    async fn record_plan_outcome(
        &self,
        run_context: &PlanRunContext,
        model_used: &str,
        start_time: chrono::DateTime<Utc>,
        outcome: &PlanRunOutcome,
    ) {
        let duration = (Utc::now() - start_time).num_seconds() as u64;
        let learner_outcome = run_context.learner_outcome(model_used, duration, outcome);

        if let Err(e) = self
            .learner
            .write()
            .await
            .record_outcome(learner_outcome)
            .await
        {
            error!("Failed to record outcome: {}", e);
        }

        let mut stats = self.stats.write().await;
        stats.tasks_executed += 1;
        if outcome.success {
            stats.tasks_succeeded += 1;
        } else {
            stats.tasks_failed += 1;
        }
        stats.total_cost += outcome.costs.actual_cost_usd;
    }

    async fn finish_plan_execution(&self, execution: FinishedPlanExecution<'_>) {
        let FinishedPlanExecution {
            event,
            plan,
            checkpoint_id,
            model_used,
            result,
            critique,
            success,
        } = execution;

        if success {
            self.commit_checkpoint(checkpoint_id).await;

            if let Some(pr_result) = self
                .create_pr_for_execution(event, plan, model_used, result, critique)
                .await
            {
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
            }
        } else {
            warn!("Execution did not pass final approval, rolling back");
            for issue in &critique.issues {
                warn!("  - {:?}: {}", issue.severity, issue.description);
            }

            self.rollback_checkpoint(checkpoint_id, "failed execution")
                .await;
        }
    }

    async fn create_pr_for_execution(
        &self,
        event: &NormalizedEvent,
        plan: &TaskPlan,
        model_used: &str,
        result: &ExecutionResult,
        critique: &CriticResult,
    ) -> Option<crate::pr_creator::PrCreationResult> {
        let pr_title = format!("[Ambient] {}", plan.summary);
        let pr_body = ExecutionReport::new(event, plan, result, critique).render_markdown();
        let repo_path = std::path::Path::new(&event.repo.path);
        let authorship = match PrCreator::build_authorship_metadata(event, model_used) {
            Ok(authorship) => authorship,
            Err(e) => {
                error!("Failed to build Maestro commit authorship trailers: {}", e);
                return None;
            }
        };

        Some(
            self.pr_creator
                .create_pr(
                    repo_path,
                    &event.repository,
                    &event.repo.default_branch,
                    &pr_title,
                    &pr_body,
                    &result.changes,
                    event,
                    &authorship,
                )
                .await,
        )
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

/// Build the follow-up plan for a `continue` retry: the same tasks with the
/// judge's evidence and next step appended, so the executor addresses the
/// remaining work instead of repeating the first attempt.
fn plan_with_retry_guidance(plan: &TaskPlan, verdict: &GoalEvaluatorVerdict) -> TaskPlan {
    let guidance = format!(
        "\n\nA review of the previous attempt found work remaining: {}\nFinish the remaining work: {}",
        verdict.evidence, verdict.next_step
    );
    let mut retry_plan = plan.clone();
    for task in &mut retry_plan.tasks {
        task.prompt.push_str(&guidance);
    }
    retry_plan
}

/// Map a goal-evaluation outcome to a rejection reason. `None` means the run
/// is candidate_complete and may proceed to the Critic for adversarial
/// verification; `Some(reason)` means do not ship. Judge failures are
/// conservative: no PR is created without a completed evaluation.
fn goal_gate_rejection_reason(
    gate: Result<GoalEvaluatorVerdict, GoalEvaluationError>,
) -> Option<String> {
    match gate {
        Ok(verdict) => match verdict.decision {
            GoalEvaluatorDecision::CandidateComplete => {
                info!(
                    "Goal evaluator: candidate complete, routing to critic — {}",
                    verdict.evidence
                );
                None
            }
            GoalEvaluatorDecision::Continue => Some(format!(
                "goal evaluator: work remains — {} (next: {})",
                verdict.evidence, verdict.next_step
            )),
            GoalEvaluatorDecision::Blocked => Some(format!(
                "goal evaluator: blocked [{}] — {} (needs: {})",
                verdict.blocker_key, verdict.evidence, verdict.next_step
            )),
        },
        Err(error) => Some(format!(
            "goal evaluator failed; refusing to ship without verification: {error}"
        )),
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
    use crate::cascader::TaskContext;
    use crate::executor::LlmApiProvider;
    use crate::platform_event_bus::{PlatformEventBusConfig, PlatformEventBusTransport};
    use crate::task_run::{CostAccounting, PlanRunOutcome};
    use async_trait::async_trait;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::mpsc;
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

    fn test_event(title: &str, body: &str, event_type: EventType) -> NormalizedEvent {
        let repo = Repository {
            owner: "evalops".to_string(),
            name: "maestro".to_string(),
            full_name: "evalops/maestro".to_string(),
            default_branch: "main".to_string(),
            path: "/tmp/maestro".to_string(),
            url: "https://github.com/evalops/maestro".to_string(),
            config: None,
            agent_md: Some("instructions".to_string()),
            test_coverage: Some(80.0),
            codeowners: vec!["@evalops/runtime".to_string()],
        };

        NormalizedEvent {
            id: "evt_test".to_string(),
            source: WatcherType::GitHubPoll,
            event_type,
            repo: repo.clone(),
            repository: repo.full_name.clone(),
            priority: 50,
            title: title.to_string(),
            body: Some(body.to_string()),
            labels: vec![],
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: Some(title.to_string()),
                body: Some(body.to_string()),
                number: Some(1),
                labels: vec![],
                author: Some("octocat".to_string()),
                url: Some("https://github.com/evalops/maestro/issues/1".to_string()),
                extra: std::collections::HashMap::new(),
            },
            created_at: Utc::now(),
            processed_at: None,
            status: EventStatus::Pending,
            flags: EventFlags::default(),
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
    async fn test_update_config_refreshes_decider_policy_defaults() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-config.sock"))
            .build()
            .unwrap();
        let event = test_event(
            "GHSA advisory for crate foo",
            "CVE-2026-1234 in foo requires remediation.",
            EventType::SecurityAlert,
        );

        let before = daemon.decider.read().await.decide(&event).await;
        assert!(!before.reason.contains("Ambient policy gate"));

        let mut updated = test_config();
        updated.capabilities.security_patches = false;
        daemon.update_config(updated).await;

        let after = daemon.decider.read().await.decide(&event).await;
        assert_eq!(after.action, DecisionAction::Skip);
        assert!(after.reason.contains("security patch work is disabled"));
    }

    #[test]
    fn test_adjusted_action_respects_supplied_thresholds() {
        let decision = Decision {
            action: DecisionAction::Ask,
            confidence: 0.6,
            reason: "below auto threshold".to_string(),
            plan: None,
            question: None,
            final_action: false,
            auto_execute_blocked: false,
        };

        let daemon_thresholds = Thresholds {
            auto_execute: 0.8,
            ask_human: 0.5,
            skip: 0.0,
        };
        let repo_thresholds = Thresholds {
            auto_execute: 0.95,
            ask_human: 0.5,
            skip: 0.0,
        };

        assert_eq!(
            AmbientDaemon::adjusted_action(&decision, 0.85, &daemon_thresholds),
            DecisionAction::Execute
        );
        assert_eq!(
            AmbientDaemon::adjusted_action(&decision, 0.85, &repo_thresholds),
            DecisionAction::Ask
        );
    }

    #[test]
    fn test_adjusted_action_respects_complexity_ask_ceiling() {
        let decision = Decision {
            action: DecisionAction::Ask,
            confidence: 0.9,
            reason: "complexity requires human approval".to_string(),
            plan: None,
            question: None,
            final_action: false,
            auto_execute_blocked: true,
        };
        let thresholds = Thresholds {
            auto_execute: 0.8,
            ask_human: 0.5,
            skip: 0.0,
        };

        assert_eq!(
            AmbientDaemon::adjusted_action(&decision, 0.95, &thresholds),
            DecisionAction::Ask
        );
        assert_eq!(
            AmbientDaemon::adjusted_action(&decision, 0.4, &thresholds),
            DecisionAction::Skip
        );

        let moderate_confidence_decision = Decision {
            confidence: 0.6,
            ..decision
        };
        assert_eq!(
            AmbientDaemon::adjusted_action(&moderate_confidence_decision, 0.95, &thresholds),
            DecisionAction::Ask
        );
    }

    #[tokio::test]
    async fn test_execute_plan_blocks_estimated_cost_over_limit() {
        let temp = TempDir::new().unwrap();
        let mut config = test_config();
        config.limits.max_cost_per_task_usd = 0.0001;
        let daemon = DaemonBuilder::new()
            .config(config)
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-cost-limit.sock"))
            .build()
            .unwrap();
        let event = test_event(
            "Implement hosted runtime bridge",
            "Implement the hosted runtime bridge with tests.",
            EventType::Issue,
        );
        let plan = TaskPlan {
            task_id: "plan_cost_limit".to_string(),
            summary: "Handle issue: Implement hosted runtime bridge".to_string(),
            estimated_complexity: Complexity::Medium,
            event: event.clone(),
            strategy: ExecutionStrategy::Solo,
            estimated_duration_ms: 60_000,
            tasks: vec![Task {
                id: "plan_cost_limit_main".to_string(),
                task_type: TaskType::Implement,
                prompt: "Implement hosted runtime bridge".to_string(),
                files: vec![],
                depends_on: vec![],
                priority: 100,
                estimated_tokens: None,
            }],
            files: vec![],
            risks: vec![],
        };
        let expected_estimated_cost = {
            let mut cascader = Cascader::new(None);
            let task = plan.tasks.first().unwrap().clone();
            let context = TaskContext {
                complexity: plan.estimated_complexity,
                task_type: TaskType::Implement,
                estimated_tokens: None,
                previous_attempts: 0,
            };
            cascader.route(&task, &context).estimated_cost
        };

        daemon.execute_plan(event, plan).await;

        let stats = daemon.stats.read().await;
        assert_eq!(stats.tasks_executed, 1);
        assert_eq!(stats.tasks_failed, 1);
        assert_eq!(stats.total_cost, 0.0);
        drop(stats);

        let learner_stats = daemon.learner.read().await.get_stats();
        assert_eq!(learner_stats.total_outcomes, 1);
        assert_eq!(learner_stats.overall_success_rate, 0.0);
        assert_eq!(learner_stats.total_estimated_cost, expected_estimated_cost);
        assert_eq!(learner_stats.total_cost, 0.0);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());
    }

    #[tokio::test]
    async fn test_final_plan_success_requires_executor_success() {
        let temp = TempDir::new().unwrap();
        let daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-final-success.sock"))
            .build()
            .unwrap();
        let event = test_event(
            "Fix failing route",
            "The route should return a successful response.",
            EventType::Issue,
        );
        let plan = TaskPlan {
            task_id: "plan_final_success".to_string(),
            summary: "Handle issue: Fix failing route".to_string(),
            estimated_complexity: Complexity::Simple,
            event: event.clone(),
            strategy: ExecutionStrategy::Solo,
            estimated_duration_ms: 60_000,
            tasks: vec![Task {
                id: "plan_final_success_main".to_string(),
                task_type: TaskType::Fix,
                prompt: "Fix failing route".to_string(),
                files: vec![],
                depends_on: vec![],
                priority: 100,
                estimated_tokens: None,
            }],
            files: vec![],
            risks: vec![],
        };
        let checkpoint_id = daemon.create_plan_checkpoint(&plan).await.unwrap();
        let result = ExecutionResult {
            status: ExecutionStatus::Failed,
            changes: vec![],
            test_results: vec![],
            error: Some("executor failed".to_string()),
            logs: vec![],
        };
        let critique = CriticResult {
            approved: true,
            confidence: 0.95,
            issues: vec![],
            suggestions: vec![],
        };
        let outcome = PlanRunOutcome::from_execution(
            &result,
            &critique,
            CostAccounting::estimate_as_actual(0.01, 0),
        );

        daemon
            .finish_plan_execution(FinishedPlanExecution {
                event: &event,
                plan: &plan,
                checkpoint_id: &checkpoint_id,
                model_used: "claude-3-5-haiku-20241022",
                result: &result,
                critique: &critique,
                success: outcome.success,
            })
            .await;

        assert!(!outcome.success);
        assert_eq!(daemon.stats.read().await.prs_created, 0);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());
    }

    fn verdict(decision: GoalEvaluatorDecision, blocker_key: &str) -> GoalEvaluatorVerdict {
        GoalEvaluatorVerdict {
            decision,
            evidence: "evidence".to_string(),
            next_step: "next step".to_string(),
            blocker_key: blocker_key.to_string(),
        }
    }

    #[test]
    fn test_goal_gate_only_passes_candidate_complete() {
        assert!(
            goal_gate_rejection_reason(Ok(verdict(GoalEvaluatorDecision::CandidateComplete, "")))
                .is_none()
        );

        let reason =
            goal_gate_rejection_reason(Ok(verdict(GoalEvaluatorDecision::Continue, ""))).unwrap();
        assert!(reason.contains("work remains"));

        let reason = goal_gate_rejection_reason(Ok(verdict(
            GoalEvaluatorDecision::Blocked,
            "missing_github_access",
        )))
        .unwrap();
        assert!(reason.contains("missing_github_access"));

        // Judge failures are conservative: no ship without verification.
        let reason = goal_gate_rejection_reason(Err(GoalEvaluationError::Timeout(
            std::time::Duration::from_secs(30),
        )))
        .unwrap();
        assert!(reason.contains("refusing to ship"));
    }

    /// Serve `bodies` in order, one per connection; further connections get
    /// the last body again (a retried executor call reuses the same fixture).
    /// Every received request is forwarded on the returned channel so tests
    /// can assert how many calls were made and what they contained.
    fn mock_openrouter_server_sequence(bodies: Vec<String>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bodies = bodies.into_iter();
            let mut last: Option<String> = None;
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).unwrap();
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    let Some(header_end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let headers =
                        String::from_utf8_lossy(&buffer[..header_end]).to_ascii_lowercase();
                    let content_length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buffer.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
                let _ = request_tx.send(String::from_utf8_lossy(&buffer).into_owned());
                let body = bodies
                    .next()
                    .unwrap_or_else(|| last.clone().unwrap_or_default());
                last = Some(body.clone());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (format!("http://{}", addr), request_rx)
    }

    fn chat_completion_body(content: &str) -> String {
        serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
        })
        .to_string()
    }

    fn install_mock_llms(daemon: &mut AmbientDaemon, working_dir: &Path, judge_verdict: &str) {
        install_mock_llms_with_judge_sequence(daemon, working_dir, &[judge_verdict]);
    }

    /// Install mock executor and judge LLMs. The judge serves `judge_verdicts`
    /// in order across evaluation calls. Returns the request receivers for
    /// the executor and judge mocks so tests can inspect the calls.
    fn install_mock_llms_with_judge_sequence(
        daemon: &mut AmbientDaemon,
        working_dir: &Path,
        judge_verdicts: &[&str],
    ) -> (mpsc::Receiver<String>, mpsc::Receiver<String>) {
        let (executor_url, executor_rx) = mock_openrouter_server_sequence(vec![
            chat_completion_body(
                "<file_change><action>create</action><path>src/feature.rs</path><content>pub fn feature() {}\n</content></file_change>",
            ),
        ]);
        daemon.executor = Arc::new(Executor::new(ExecutorConfig {
            api_key: "test-key".to_string(),
            api_base_url: executor_url,
            api_provider: LlmApiProvider::OpenRouterChatCompletions,
            run_tests: false,
            working_dir: working_dir.to_string_lossy().to_string(),
            ..ExecutorConfig::default()
        }));
        let (judge_url, judge_rx) = mock_openrouter_server_sequence(
            judge_verdicts
                .iter()
                .map(|verdict| chat_completion_body(verdict))
                .collect(),
        );
        daemon.goal_evaluator = Some(GoalEvaluator::new(
            GoalEvaluatorConfig {
                model: Some("judge-model".to_string()),
                timeout: std::time::Duration::from_secs(5),
                ..Default::default()
            },
            Arc::new(Executor::new(ExecutorConfig {
                api_key: "test-key".to_string(),
                api_base_url: judge_url,
                api_provider: LlmApiProvider::OpenRouterChatCompletions,
                ..ExecutorConfig::default()
            })),
        ));
        (executor_rx, judge_rx)
    }

    fn feature_plan(event: &NormalizedEvent) -> TaskPlan {
        TaskPlan {
            task_id: "plan_goal_eval".to_string(),
            summary: "Handle issue: Add feature".to_string(),
            estimated_complexity: Complexity::Simple,
            event: event.clone(),
            strategy: ExecutionStrategy::Solo,
            estimated_duration_ms: 60_000,
            tasks: vec![Task {
                id: "plan_goal_eval_main".to_string(),
                task_type: TaskType::Implement,
                prompt: "Add feature".to_string(),
                files: vec![],
                depends_on: vec![],
                priority: 100,
                estimated_tokens: None,
            }],
            files: vec![],
            risks: vec![],
        }
    }

    #[tokio::test]
    async fn test_execute_plan_goal_evaluator_continue_rolls_back() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-goal-continue.sock"))
            .build()
            .unwrap();
        install_mock_llms(
            &mut daemon,
            temp.path(),
            r#"{"decision":"continue","evidence":"no tests were run","next_step":"run the test suite","blocker_key":""}"#,
        );
        let event = test_event(
            "Add feature",
            "Add the feature with tests.",
            EventType::Issue,
        );
        let plan = feature_plan(&event);

        daemon.execute_plan(event, plan).await;

        let stats = daemon.stats.read().await;
        assert_eq!(stats.tasks_executed, 1);
        assert_eq!(stats.tasks_succeeded, 0);
        assert_eq!(stats.tasks_failed, 1);
        assert_eq!(stats.prs_created, 0);
        drop(stats);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());
        let learner_stats = daemon.learner.read().await.get_stats();
        assert_eq!(learner_stats.total_outcomes, 1);
        assert_eq!(learner_stats.overall_success_rate, 0.0);
    }

    #[tokio::test]
    async fn test_execute_plan_candidate_complete_reaches_critic() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-goal-complete.sock"))
            .build()
            .unwrap();
        install_mock_llms(
            &mut daemon,
            temp.path(),
            r#"{"decision":"candidate_complete","evidence":"change applied to src/feature.rs","next_step":"open the PR","blocker_key":""}"#,
        );
        let event = test_event("Add feature", "Add the feature.", EventType::Issue);
        let plan = feature_plan(&event);

        daemon.execute_plan(event, plan).await;

        // The run clears both the goal evaluator and the critic. No real
        // GitHub repo/token exists in tests, so no PR is created.
        let stats = daemon.stats.read().await;
        assert_eq!(stats.tasks_executed, 1);
        assert_eq!(stats.tasks_succeeded, 1);
        assert_eq!(stats.tasks_failed, 0);
        assert_eq!(stats.prs_created, 0);
        drop(stats);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());
    }

    #[tokio::test]
    async fn test_execute_plan_continue_retry_then_candidate_complete_ships() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-goal-retry-ship.sock"))
            .build()
            .unwrap();
        let (executor_rx, _judge_rx) = install_mock_llms_with_judge_sequence(
            &mut daemon,
            temp.path(),
            &[
                r#"{"decision":"continue","evidence":"no tests were run","next_step":"run the test suite","blocker_key":""}"#,
                r#"{"decision":"candidate_complete","evidence":"change applied and verified","next_step":"open the PR","blocker_key":""}"#,
            ],
        );
        let event = test_event("Add feature", "Add the feature.", EventType::Issue);
        let plan = feature_plan(&event);

        daemon.execute_plan(event, plan).await;

        // The retry cleared the goal evaluator and the critic. No real
        // GitHub repo/token exists in tests, so no PR is created.
        let stats = daemon.stats.read().await;
        assert_eq!(stats.tasks_executed, 1);
        assert_eq!(stats.tasks_succeeded, 1);
        assert_eq!(stats.tasks_failed, 0);
        assert_eq!(stats.prs_created, 0);
        drop(stats);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());

        // The executor ran exactly twice, and the judge's next_step from the
        // first attempt was fed back into the retry prompt.
        let first = executor_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let second = executor_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(!first.contains("run the test suite"));
        assert!(second.contains("run the test suite"));
        assert!(
            executor_rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "retry loop must be bounded to one retry"
        );

        let learner = daemon.learner.read().await;
        let outcomes = learner.outcomes();
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].success);
    }

    #[tokio::test]
    async fn test_execute_plan_continue_retry_still_continue_fails_closed() {
        let temp = TempDir::new().unwrap();
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-goal-retry-fail.sock"))
            .build()
            .unwrap();
        install_mock_llms_with_judge_sequence(
            &mut daemon,
            temp.path(),
            &[
                r#"{"decision":"continue","evidence":"no tests were run","next_step":"run the test suite","blocker_key":""}"#,
                r#"{"decision":"continue","evidence":"tests still missing","next_step":"add coverage for the new module","blocker_key":""}"#,
            ],
        );
        let event = test_event("Add feature", "Add the feature.", EventType::Issue);
        let plan = feature_plan(&event);

        daemon.execute_plan(event, plan).await;

        let stats = daemon.stats.read().await;
        assert_eq!(stats.tasks_executed, 1);
        assert_eq!(stats.tasks_succeeded, 0);
        assert_eq!(stats.tasks_failed, 1);
        assert_eq!(stats.prs_created, 0);
        drop(stats);
        assert!(daemon.checkpoint_mgr.read().await.list_active().is_empty());

        // Both judge attempts are recorded in the failure reason: the verdict
        // that triggered the retry and the verdict that closed the run.
        let learner = daemon.learner.read().await;
        let outcomes = learner.outcomes();
        assert_eq!(outcomes.len(), 1);
        assert!(!outcomes[0].success);
        let reason = outcomes[0].failure_reason.as_deref().unwrap();
        assert!(
            reason.contains("run the test suite"),
            "missing first attempt in: {reason}"
        );
        assert!(
            reason.contains("tests still missing"),
            "missing retry verdict in: {reason}"
        );
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
        cmd_tx.send(DaemonCommand::Resume).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert_eq!(transport.published.lock().unwrap().len(), 1);
        cmd_tx.send(DaemonCommand::Pause).await.unwrap();
        wait_for_published(&transport, 2).await;
        cmd_tx.send(DaemonCommand::Pause).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert_eq!(transport.published.lock().unwrap().len(), 2);
        cmd_tx.send(DaemonCommand::Resume).await.unwrap();
        wait_for_published(&transport, 3).await;
        cmd_tx.send(DaemonCommand::Resume).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert_eq!(transport.published.lock().unwrap().len(), 3);
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

    #[tokio::test]
    async fn test_daemon_publishes_closed_event_when_save_state_fails() {
        let temp = TempDir::new().unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let publisher =
            PlatformEventBus::with_transport(PlatformEventBusConfig::for_test(), transport.clone());
        let mut daemon = DaemonBuilder::new()
            .config(test_config())
            .data_dir(temp.path().to_path_buf())
            .ipc_socket_path(temp.path().join("daemon-save-failure.sock"))
            .platform_event_bus(publisher)
            .build()
            .unwrap();
        let cmd_tx = daemon.get_command_sender();

        let daemon_handle = tokio::spawn(async move { daemon.run().await });

        wait_for_published(&transport, 1).await;

        // Make the learner storage path unwritable in a way that also fails
        // under privileged users.
        std::fs::create_dir(temp.path().join("learner.json")).unwrap();

        cmd_tx.send(DaemonCommand::Shutdown).await.unwrap();

        let result = daemon_handle.await.unwrap();

        assert!(result.is_err());
        wait_for_published(&transport, 2).await;

        let published = transport.published.lock().unwrap();
        let subjects: Vec<_> = published
            .iter()
            .map(|(subject, _)| subject.as_str())
            .collect();
        assert_eq!(
            subjects,
            vec![
                "maestro.sessions.session.started",
                "maestro.sessions.session.closed",
            ]
        );

        let closed: Value = serde_json::from_str(&published[1].1).unwrap();
        assert_eq!(closed["data"]["state"], "MAESTRO_SESSION_STATE_CLOSED");
        assert_eq!(
            closed["data"]["close_reason"],
            "MAESTRO_CLOSE_REASON_USER_STOPPED"
        );
        assert_eq!(closed["data"]["close_message"], "shutdown requested");
    }
}

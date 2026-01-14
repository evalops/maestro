//! Core types for the Ambient Agent
//!
//! An always-on GitHub agent that watches repositories, identifies work,
//! and ships code autonomously via PRs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Event Types
// =============================================================================

/// Source of events
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatcherType {
    GitHubWebhook,
    GitHubPoll,
    Ci,
    Dependency,
    Security,
    Schedule,
    Backlog,
    Slack,
}

/// Normalized event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Issue,
    IssueCreated,
    IssueLabeled,
    IssueMentioned,
    PullRequest,
    PrOpened,
    PrReviewRequested,
    PrComment,
    PushToMain,
    CiFailure,
    DependencyUpdate,
    SecurityAlert,
    ScheduledTask,
    BacklogReady,
    SlackRequest,
}

/// Event processing status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventStatus {
    Pending,
    Processing,
    Completed,
    Skipped,
    Failed,
}

/// Raw event from a watcher
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawEvent {
    pub source: WatcherType,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub timestamp: DateTime<Utc>,
    pub repo: String,
}

/// Repository information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repository {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub default_branch: String,
    pub path: String,
    pub url: String,
    pub config: Option<AmbientConfig>,
    pub agent_md: Option<String>,
    pub test_coverage: Option<f64>,
    pub codeowners: Vec<String>,
}

/// Event context for enrichment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventContext {
    pub repo: Repository,
    pub history: Vec<NormalizedEvent>,
    pub related: Vec<NormalizedEvent>,
}

/// Event payload with extracted fields
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventPayload {
    pub title: Option<String>,
    pub body: Option<String>,
    pub number: Option<u64>,
    pub labels: Vec<String>,
    pub author: Option<String>,
    pub url: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Flags detected on events
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventFlags {
    pub potential_injection: bool,
    pub high_priority: bool,
    pub requires_approval: bool,
}

/// Normalized event ready for processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedEvent {
    pub id: String,
    pub source: WatcherType,
    pub event_type: EventType,
    pub repo: Repository,
    pub repository: String, // Convenience field: "owner/name"
    pub priority: u8,
    pub title: String,
    pub body: Option<String>,
    pub labels: Vec<String>,
    pub context: EventContext,
    pub payload: EventPayload,
    pub created_at: DateTime<Utc>,
    pub processed_at: Option<DateTime<Utc>>,
    pub status: EventStatus,
    pub flags: EventFlags,
}

impl NormalizedEvent {
    /// Get the full repository name
    pub fn full_repo_name(&self) -> String {
        format!("{}/{}", self.repo.owner, self.repo.name)
    }
}

// =============================================================================
// Decision Types
// =============================================================================

/// Action to take for an event
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAction {
    Execute,
    Ask,
    Skip,
    Queue,
}

/// Decision made by the Decider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub action: DecisionAction,
    pub confidence: f64,
    pub reason: String,
    pub plan: Option<TaskPlan>,
    pub question: Option<String>,
}

/// Factors that contribute to confidence score
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfidenceFactors {
    pub pattern_match: f64,
    pub complexity: Complexity,
    pub history_score: f64,
    pub repo_maturity: f64,
}

// =============================================================================
// Task & Plan Types
// =============================================================================

/// Task complexity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Complexity {
    Trivial,
    Simple,
    Medium,
    Complex,
    High,
}

/// Types of tasks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Implement,
    Test,
    Refactor,
    Fix,
    Document,
    Security,
}

/// Task status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

/// Execution strategy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStrategy {
    Solo,
    Swarm,
}

/// A single task to execute
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub task_type: TaskType,
    pub prompt: String,
    pub files: Vec<String>,
    pub depends_on: Vec<String>,
    pub priority: u8,
    pub estimated_tokens: Option<u64>,
}

/// Plan for executing tasks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPlan {
    pub task_id: String,
    pub summary: String,
    pub estimated_complexity: Complexity,
    pub event: NormalizedEvent,
    pub strategy: ExecutionStrategy,
    pub tasks: Vec<Task>,
    pub estimated_duration_ms: u64,
    pub files: Vec<String>,
    pub risks: Vec<Risk>,
}

/// Risk assessment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Risk {
    pub risk_type: RiskType,
    pub severity: Severity,
    pub description: String,
    pub mitigation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskType {
    BreakingChange,
    Security,
    Performance,
    DataLoss,
    ScopeCreep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

// =============================================================================
// Execution Types
// =============================================================================

/// A file change made during execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub file: String,
    pub change_type: ChangeType,
    pub content: Option<String>,
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    Create,
    Modify,
    Delete,
    Rename,
}

/// Test result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Cost tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostRecord {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub model: String,
}

/// Result of executing a plan
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub status: ExecutionStatus,
    pub changes: Vec<FileChange>,
    pub test_results: Vec<TestResult>,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Success,
    Partial,
    Failed,
}

// =============================================================================
// Critic Types (LLM-as-Judge)
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticIssueSeverity {
    Blocker,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticIssueType {
    Correctness,
    Style,
    Security,
    Performance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticIssue {
    pub severity: CriticIssueSeverity,
    pub issue_type: CriticIssueType,
    pub location: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticResult {
    pub approved: bool,
    pub confidence: f64,
    pub issues: Vec<CriticIssue>,
    pub suggestions: Vec<String>,
}

// =============================================================================
// Cascader Types (Model Routing)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTier {
    pub name: String,
    pub model: String,
    pub cost_per_1k_input: f64,
    pub cost_per_1k_output: f64,
    pub capabilities: Vec<String>,
    pub max_complexity: Complexity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascaderConfig {
    pub tiers: Vec<ModelTier>,
    pub fallback_to_higher: bool,
    pub max_retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostTracker {
    pub task_type: String,
    pub model_used: String,
    pub tokens: u64,
    pub cost_usd: f64,
    pub success: bool,
    pub timestamp: DateTime<Utc>,
}

// =============================================================================
// Checkpoint Types (Transaction Management)
// =============================================================================

/// Status of a checkpoint
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointState {
    Created,
    Active,
    Committed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub task_id: String,
    pub description: String,
    pub state: CheckpointState,
    pub created_at: DateTime<Utc>,
    pub file_backups: HashMap<String, Option<String>>,
    pub git_state: Option<String>,
    pub metadata: HashMap<String, String>,
}

// =============================================================================
// Policy Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyEnforcement {
    Block,
    Warn,
    Log,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyContext {
    pub event: NormalizedEvent,
    pub plan: Option<TaskPlan>,
    pub changes: Vec<FileChange>,
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyEvaluation {
    pub allowed: bool,
    pub violations: Vec<PolicyResult>,
    pub warnings: Vec<PolicyResult>,
}

// =============================================================================
// PR Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStatus {
    Draft,
    Ready,
    Reviewing,
    Merged,
    Rejected,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub branch: String,
    pub base: String,
    pub status: PrStatus,
    pub url: String,
    pub head_sha: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub merged_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
}

// =============================================================================
// Learner Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeResult {
    Merged,
    Rejected,
    Abandoned,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Outcome {
    pub id: String,
    pub event_id: String,
    pub plan_id: String,
    pub pr_number: u64,
    pub result: OutcomeResult,
    pub feedback: Option<String>,
    pub duration_ms: u64,
    pub cost_usd: f64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pattern {
    pub id: String,
    pub pattern_type: String,
    pub weight: f64,
    pub success_count: u64,
    pub failure_count: u64,
    pub last_updated: DateTime<Utc>,
}

// =============================================================================
// Retrainer Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrainerConfig {
    pub quality_threshold: f64,
    pub max_iterations: u32,
    pub evaluation_samples: u32,
    pub improvement_min_delta: f64,
}

impl Default for RetrainerConfig {
    fn default() -> Self {
        Self {
            quality_threshold: 0.8,
            max_iterations: 5,
            evaluation_samples: 10,
            improvement_min_delta: 0.05,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrainingCycle {
    pub iteration: u32,
    pub quality_score: f64,
    pub samples_evaluated: u32,
    pub improvements: Vec<String>,
    pub next_actions: Vec<String>,
    pub timestamp: DateTime<Utc>,
}

// =============================================================================
// Failure Detection Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureMode {
    HallucinationCascade,
    MemoryCorruption,
    ToolMisuse,
    PromptDecay,
    NonAtomicOperations,
    VerificationFailure,
    PromptInjection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureDetection {
    pub mode: FailureMode,
    pub detected: bool,
    pub confidence: f64,
    pub evidence: Option<String>,
}

// =============================================================================
// Daemon Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonStatus {
    Starting,
    Running,
    Paused,
    Stopping,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonState {
    pub id: String,
    pub status: DaemonStatus,
    pub started_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub events_processed: u64,
    pub prs_opened: u64,
    pub prs_merged: u64,
    pub prs_rejected: u64,
    pub total_cost_usd: f64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerState {
    pub consecutive_failures: u32,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub tripped: bool,
    pub trip_reason: Option<String>,
    pub cooldown_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    pub max_consecutive_failures: u32,
    pub max_daily_cost_usd: f64,
    pub max_rejection_rate: f64,
    pub cooldown_minutes: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            max_consecutive_failures: 3,
            max_daily_cost_usd: 50.0,
            max_rejection_rate: 0.5,
            cooldown_minutes: 60,
        }
    }
}

// =============================================================================
// Configuration Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbientConfig {
    pub enabled: bool,
    pub auto_triggers: Vec<AutoTrigger>,
    pub thresholds: Thresholds,
    pub limits: Limits,
    pub capabilities: Capabilities,
    pub schedule: ScheduleConfig,
    pub notify: NotifyConfig,
    pub learning: LearningConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTrigger {
    pub trigger_type: TriggerType,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    Label,
    Mention,
    Event,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thresholds {
    pub auto_execute: f64,
    pub ask_human: f64,
    pub skip: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            auto_execute: 0.8,
            ask_human: 0.5,
            skip: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Limits {
    pub max_prs_per_day: u32,
    pub max_complexity: Complexity,
    pub max_files_changed: u32,
    pub max_cost_per_task_usd: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_prs_per_day: 5,
            max_complexity: Complexity::Medium,
            max_files_changed: 20,
            max_cost_per_task_usd: 5.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub implement_features: bool,
    pub fix_bugs: bool,
    pub update_dependencies: bool,
    pub refactor: bool,
    pub add_tests: bool,
    pub update_docs: bool,
    pub security_patches: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            implement_features: true,
            fix_bugs: true,
            update_dependencies: true,
            refactor: true,
            add_tests: true,
            update_docs: true,
            security_patches: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    pub nightly_improvements: bool,
    pub nightly_time: String,
    pub timezone: String,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            nightly_improvements: true,
            nightly_time: "03:00".to_string(),
            timezone: "UTC".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyConfig {
    pub slack_channel: Option<String>,
    pub on_pr_opened: bool,
    pub on_pr_merged: bool,
    pub on_failure: bool,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            slack_channel: None,
            on_pr_opened: true,
            on_pr_merged: true,
            on_failure: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningConfig {
    pub enabled: bool,
    pub feedback_from_reviews: bool,
    pub pattern_extraction: bool,
}

impl Default for LearningConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            feedback_from_reviews: true,
            pattern_extraction: true,
        }
    }
}

// =============================================================================
// Safety Constants
// =============================================================================

/// Actions that should never be auto-executed
pub const NEVER_AUTO_ACTIONS: &[&str] = &[
    "delete_branch",
    "force_push",
    "modify_ci_config",
    "change_permissions",
    "modify_secrets",
    "production_deploy",
];

/// Actions that always require human approval
pub const REQUIRE_APPROVAL_ACTIONS: &[&str] = &[
    "breaking_change",
    "api_modification",
    "database_migration",
    "dependency_major_upgrade",
];

/// File patterns that should never be touched
pub const PROTECTED_FILE_PATTERNS: &[&str] = &[
    ".github/workflows/*",
    "**/secrets.*",
    "**/credentials.*",
    ".env*",
];

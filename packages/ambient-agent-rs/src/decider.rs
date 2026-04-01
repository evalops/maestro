//! Decider
//!
//! Determines what action to take for each event based on confidence scoring.
//! Uses pattern matching, complexity estimation, and historical success rates.

use crate::types::*;
use chrono::Utc;
use regex::Regex;
use std::sync::LazyLock;
use tracing::info;

/// Static regex pattern for identifying files in text
static FILE_PATH_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`([^`]+\.[a-z]+)`").unwrap());

/// Configuration for the Decider
#[derive(Debug, Clone)]
pub struct DeciderConfig {
    pub thresholds: Thresholds,
    pub min_historical_samples: usize,
    pub pattern_weight: f64,
    pub complexity_weight: f64,
    pub history_weight: f64,
    pub maturity_weight: f64,
}

impl Default for DeciderConfig {
    fn default() -> Self {
        Self {
            thresholds: Thresholds::default(),
            min_historical_samples: 3,
            pattern_weight: 0.3,
            complexity_weight: 0.25,
            history_weight: 0.25,
            maturity_weight: 0.2,
        }
    }
}

/// Outcome storage trait for historical lookups
#[async_trait::async_trait]
pub trait OutcomeStore: Send + Sync {
    async fn get_similar(&self, event: &NormalizedEvent) -> Vec<Outcome>;
    async fn get_for_repo(&self, repo: &str) -> Vec<Outcome>;
}

/// Pattern storage trait
#[async_trait::async_trait]
pub trait PatternStore: Send + Sync {
    async fn get_patterns(&self, repo: &str) -> Vec<Pattern>;
    async fn update_weight(&self, pattern_id: &str, delta: f64) -> anyhow::Result<()>;
}

/// The Decider determines what action to take for events
pub struct Decider {
    config: DeciderConfig,
    outcome_store: Option<Box<dyn OutcomeStore>>,
    pattern_store: Option<Box<dyn PatternStore>>,
}

impl Decider {
    /// Create a new Decider
    pub fn new(config: DeciderConfig) -> Self {
        Self {
            config,
            outcome_store: None,
            pattern_store: None,
        }
    }

    /// Set the outcome store
    pub fn with_outcome_store(mut self, store: Box<dyn OutcomeStore>) -> Self {
        self.outcome_store = Some(store);
        self
    }

    /// Set the pattern store
    pub fn with_pattern_store(mut self, store: Box<dyn PatternStore>) -> Self {
        self.pattern_store = Some(store);
        self
    }

    /// Make a decision for an event
    pub async fn decide(&self, event: &NormalizedEvent) -> Decision {
        // Get repo-specific thresholds if available
        let thresholds = event
            .repo
            .config
            .as_ref()
            .map(|c| &c.thresholds)
            .unwrap_or(&self.config.thresholds);

        // Calculate confidence factors
        let factors = self.calculate_confidence_factors(event).await;

        // Compute overall confidence
        let confidence = self.compute_confidence(&factors);

        // Check for flags that modify behavior
        if event.flags.potential_injection {
            return Decision {
                action: DecisionAction::Skip,
                confidence: 0.0,
                reason: "Potential prompt injection detected in event content".to_string(),
                plan: None,
                question: None,
            };
        }

        if event.flags.requires_approval {
            return Decision {
                action: DecisionAction::Ask,
                confidence,
                reason: "Event has a label requiring manual approval".to_string(),
                plan: None,
                question: Some(self.format_question(event)),
            };
        }

        // Determine action based on confidence
        let action = self.determine_action(confidence, &factors.complexity, thresholds);

        let mut decision = Decision {
            action,
            confidence,
            reason: self.format_reason(action, confidence, &factors),
            plan: None,
            question: None,
        };

        // Add plan if executing
        if action == DecisionAction::Execute {
            decision.plan = Some(self.create_plan(event, &factors).await);
        }

        // Add question if asking
        if action == DecisionAction::Ask {
            decision.question = Some(self.format_question(event));
        }

        info!(
            event_id = %event.id,
            action = ?action,
            confidence = confidence,
            "Decision made"
        );

        decision
    }

    /// Calculate confidence factors
    async fn calculate_confidence_factors(&self, event: &NormalizedEvent) -> ConfidenceFactors {
        let pattern_match = self.calculate_pattern_match(event).await;
        let complexity = self.estimate_complexity(event);
        let history_score = self.calculate_history_score(event).await;
        let repo_maturity = self.calculate_repo_maturity(event);

        ConfidenceFactors {
            pattern_match,
            complexity,
            history_score,
            repo_maturity,
        }
    }

    /// Calculate pattern match score (0-1)
    async fn calculate_pattern_match(&self, event: &NormalizedEvent) -> f64 {
        let mut score = 0.0;

        // Label-based patterns
        for label in &event.payload.labels {
            let label_lower = label.to_lowercase();
            if label_lower.contains("composer-auto") {
                score += 0.3;
            }
            if label_lower.contains("good-first-issue") {
                score += 0.2;
            }
        }

        // Check stored patterns
        if let Some(ref store) = self.pattern_store {
            let patterns = store.get_patterns(&event.repo.full_name).await;
            for pattern in patterns {
                if self.matches_pattern(event, &pattern) {
                    score += pattern.weight * 0.1;
                }
            }
        }

        // Type-based patterns
        let high_confidence_types = [
            EventType::CiFailure,
            EventType::DependencyUpdate,
            EventType::IssueLabeled,
        ];
        if high_confidence_types.contains(&event.event_type) {
            score += 0.15;
        }

        score.min(1.0)
    }

    /// Check if event matches a pattern
    fn matches_pattern(&self, event: &NormalizedEvent, pattern: &Pattern) -> bool {
        let content = format!(
            "{} {}",
            event.payload.title.as_deref().unwrap_or(""),
            event.payload.body.as_deref().unwrap_or("")
        )
        .to_lowercase();

        content.contains(&pattern.pattern_type.to_lowercase())
    }

    /// Estimate task complexity
    fn estimate_complexity(&self, event: &NormalizedEvent) -> Complexity {
        let content = format!(
            "{} {}",
            event.payload.title.as_deref().unwrap_or(""),
            event.payload.body.as_deref().unwrap_or("")
        )
        .to_lowercase();

        // Check for complexity indicators
        if content.contains("typo")
            || content.contains("comment")
            || content.contains("readme")
            || content.contains("documentation")
        {
            return Complexity::Trivial;
        }

        if content.contains("fix")
            || content.contains("update")
            || content.contains("rename")
            || content.contains("style")
            || content.contains("lint")
        {
            return Complexity::Simple;
        }

        if content.contains("implement")
            || content.contains("feature")
            || content.contains("refactor")
            || content.contains("test")
        {
            return Complexity::Medium;
        }

        if content.contains("architecture")
            || content.contains("migration")
            || content.contains("integration")
        {
            return Complexity::Complex;
        }

        // Default by event type
        match event.event_type {
            EventType::CiFailure => Complexity::Simple,
            EventType::DependencyUpdate => Complexity::Simple,
            EventType::SecurityAlert => Complexity::Medium,
            EventType::BacklogReady => Complexity::Complex,
            _ => Complexity::Medium,
        }
    }

    /// Calculate historical success score (0-1)
    async fn calculate_history_score(&self, event: &NormalizedEvent) -> f64 {
        if let Some(ref store) = self.outcome_store {
            let outcomes = store.get_similar(event).await;
            if outcomes.len() < self.config.min_historical_samples {
                return 0.5; // Not enough data
            }

            let merged = outcomes
                .iter()
                .filter(|o| o.result == OutcomeResult::Merged)
                .count();
            return merged as f64 / outcomes.len() as f64;
        }

        0.5 // Neutral if no history
    }

    /// Calculate repo maturity score (0-1)
    fn calculate_repo_maturity(&self, event: &NormalizedEvent) -> f64 {
        let mut score: f64 = 0.5;

        if let Some(coverage) = event.repo.test_coverage {
            if coverage >= 80.0 {
                score += 0.2;
            } else if coverage >= 60.0 {
                score += 0.1;
            } else if coverage < 40.0 {
                score -= 0.1;
            }
        }

        if event.repo.agent_md.is_some() {
            score += 0.15;
        }

        if event.repo.config.is_some() {
            score += 0.1;
        }

        if !event.repo.codeowners.is_empty() {
            score += 0.05;
        }

        score.clamp(0.0, 1.0)
    }

    /// Compute overall confidence from factors
    fn compute_confidence(&self, factors: &ConfidenceFactors) -> f64 {
        let complexity_penalty = match factors.complexity {
            Complexity::Trivial => 0.0,
            Complexity::Simple => 0.05,
            Complexity::Medium => 0.1,
            Complexity::Complex => 0.25,
            Complexity::High => 0.4,
        };

        let confidence = factors.pattern_match * self.config.pattern_weight
            + (1.0 - complexity_penalty) * self.config.complexity_weight
            + factors.history_score * self.config.history_weight
            + factors.repo_maturity * self.config.maturity_weight;

        confidence.clamp(0.0, 1.0)
    }

    /// Determine action based on confidence and thresholds
    fn determine_action(
        &self,
        confidence: f64,
        complexity: &Complexity,
        thresholds: &Thresholds,
    ) -> DecisionAction {
        // Never auto-execute high complexity tasks
        if matches!(complexity, Complexity::High | Complexity::Complex) {
            return if confidence >= thresholds.ask_human {
                DecisionAction::Ask
            } else {
                DecisionAction::Skip
            };
        }

        if confidence >= thresholds.auto_execute {
            DecisionAction::Execute
        } else if confidence >= thresholds.ask_human {
            DecisionAction::Ask
        } else {
            DecisionAction::Skip
        }
    }

    /// Format the reason for a decision
    fn format_reason(
        &self,
        action: DecisionAction,
        confidence: f64,
        factors: &ConfidenceFactors,
    ) -> String {
        let pct = (confidence * 100.0) as u8;
        match action {
            DecisionAction::Execute => {
                format!(
                    "Confidence {}% exceeds auto-execute threshold. Complexity: {:?}",
                    pct, factors.complexity
                )
            }
            DecisionAction::Ask => {
                format!(
                    "Confidence {}% requires human approval. Complexity: {:?}",
                    pct, factors.complexity
                )
            }
            DecisionAction::Skip => {
                format!(
                    "Confidence {}% below threshold. Complexity: {:?}",
                    pct, factors.complexity
                )
            }
            DecisionAction::Queue => {
                format!(
                    "Confidence {}% - queued for later. Complexity: {:?}",
                    pct, factors.complexity
                )
            }
        }
    }

    /// Format a question for the human
    fn format_question(&self, event: &NormalizedEvent) -> String {
        let title = event.payload.title.as_deref().unwrap_or("Untitled");
        let event_type = format!("{:?}", event.event_type)
            .to_lowercase()
            .replace('_', " ");
        let body = event
            .payload
            .body
            .as_deref()
            .map(|b| if b.len() > 500 { &b[..500] } else { b })
            .unwrap_or("(no description)");

        format!(
            "Should I work on this {}?\n\n**{}**\n\n{}",
            event_type, title, body
        )
    }

    /// Create an execution plan for an event
    /// This is called internally by decide() when action is Execute,
    /// but can also be called directly when a learner upgrades an action
    pub async fn create_plan_for_event(&self, event: &NormalizedEvent) -> TaskPlan {
        let factors = self.calculate_confidence_factors(event).await;
        self.create_plan(event, &factors).await
    }

    /// Create an execution plan (internal)
    async fn create_plan(&self, event: &NormalizedEvent, factors: &ConfidenceFactors) -> TaskPlan {
        let task_id = format!(
            "plan_{}_{}",
            Utc::now().timestamp_millis(),
            rand::random::<u32>() & 0xFFFFFF
        );

        let summary = format!(
            "Handle {}: {}",
            format!("{:?}", event.event_type).to_lowercase(),
            event.title
        );

        let strategy = if factors.complexity >= Complexity::Complex {
            ExecutionStrategy::Swarm
        } else {
            ExecutionStrategy::Solo
        };

        let tasks = self.create_tasks(event, factors);
        let files = self.identify_files(event);
        let risks = self.assess_risks(event, factors);

        TaskPlan {
            task_id,
            summary,
            estimated_complexity: factors.complexity,
            event: event.clone(),
            strategy,
            estimated_duration_ms: self.estimate_duration(&tasks, factors),
            tasks,
            files,
            risks,
        }
    }

    /// Create tasks for an event
    fn create_tasks(&self, event: &NormalizedEvent, _factors: &ConfidenceFactors) -> Vec<Task> {
        let base_id = Utc::now().timestamp_millis();
        let main_type = self.get_main_task_type(event);

        let mut tasks = vec![Task {
            id: format!("{}_main", base_id),
            task_type: main_type,
            prompt: self.build_task_prompt(event, main_type),
            files: vec![],
            depends_on: vec![],
            priority: 100,
            estimated_tokens: None,
        }];

        // Add test task if needed
        if matches!(
            main_type,
            TaskType::Fix | TaskType::Implement | TaskType::Security
        ) {
            tasks.push(Task {
                id: format!("{}_test", base_id),
                task_type: TaskType::Test,
                prompt: format!(
                    "Write tests for the changes made to address: {}",
                    event.payload.title.as_deref().unwrap_or("the issue")
                ),
                files: vec![],
                depends_on: vec![format!("{}_main", base_id)],
                priority: 80,
                estimated_tokens: None,
            });
        }

        tasks
    }

    /// Get the main task type
    fn get_main_task_type(&self, event: &NormalizedEvent) -> TaskType {
        let content = format!(
            "{} {}",
            event.payload.title.as_deref().unwrap_or(""),
            event.payload.body.as_deref().unwrap_or("")
        )
        .to_lowercase();

        if content.contains("bug") || content.contains("fix") || content.contains("error") {
            TaskType::Fix
        } else if content.contains("refactor") || content.contains("cleanup") {
            TaskType::Refactor
        } else if content.contains("test") || content.contains("coverage") {
            TaskType::Test
        } else if content.contains("doc")
            || content.contains("readme")
            || content.contains("comment")
        {
            TaskType::Document
        } else if content.contains("security") || content.contains("vulnerability") {
            TaskType::Security
        } else {
            TaskType::Implement
        }
    }

    /// Build a task prompt
    fn build_task_prompt(&self, event: &NormalizedEvent, task_type: TaskType) -> String {
        let title = event.payload.title.as_deref().unwrap_or("Untitled task");
        let body = event.payload.body.as_deref().unwrap_or("");

        let verb = match task_type {
            TaskType::Implement => "Implement",
            TaskType::Fix => "Fix",
            TaskType::Refactor => "Refactor",
            TaskType::Test => "Write tests for",
            TaskType::Document => "Document",
            TaskType::Security => "Address security issue in",
        };

        format!(
            "{}: {}\n\n{}\n\nRepository: {}",
            verb, title, body, event.repo.full_name
        )
    }

    /// Identify files likely to be touched
    fn identify_files(&self, event: &NormalizedEvent) -> Vec<String> {
        let mut files = vec![];
        let body = event.payload.body.as_deref().unwrap_or("");

        // Extract file paths from backticks using static pattern
        for cap in FILE_PATH_PATTERN.captures_iter(body) {
            if let Some(m) = cap.get(1) {
                files.push(m.as_str().to_string());
            }
        }

        files
            .into_iter()
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect()
    }

    /// Assess risks
    fn assess_risks(&self, event: &NormalizedEvent, factors: &ConfidenceFactors) -> Vec<Risk> {
        let mut risks = vec![];
        let content = format!(
            "{} {}",
            event.payload.title.as_deref().unwrap_or(""),
            event.payload.body.as_deref().unwrap_or("")
        )
        .to_lowercase();

        if content.contains("breaking")
            || content.contains("api change")
            || content.contains("migration")
        {
            risks.push(Risk {
                risk_type: RiskType::BreakingChange,
                severity: Severity::High,
                description: "This change may break existing functionality".to_string(),
                mitigation: Some(
                    "Ensure backward compatibility or document migration steps".to_string(),
                ),
            });
        }

        if matches!(factors.complexity, Complexity::Complex | Complexity::High) {
            risks.push(Risk {
                risk_type: RiskType::ScopeCreep,
                severity: Severity::Medium,
                description: "Complex task may expand beyond original scope".to_string(),
                mitigation: Some("Focus on core requirements, create follow-up issues".to_string()),
            });
        }

        if content.contains("auth") || content.contains("password") || content.contains("token") {
            risks.push(Risk {
                risk_type: RiskType::Security,
                severity: Severity::Medium,
                description: "Changes may affect security-sensitive code".to_string(),
                mitigation: Some("Extra review needed for security implications".to_string()),
            });
        }

        risks
    }

    /// Estimate duration in milliseconds
    fn estimate_duration(&self, tasks: &[Task], factors: &ConfidenceFactors) -> u64 {
        let base = match factors.complexity {
            Complexity::Trivial => 60_000,
            Complexity::Simple => 180_000,
            Complexity::Medium => 600_000,
            Complexity::Complex => 1_800_000,
            Complexity::High => 3_600_000,
        };

        base * tasks.len() as u64
    }
}

//! Learner (Self-Evolving Patterns)
//!
//! Tracks outcomes and updates patterns based on successes/failures.
//! Enables the agent to improve over time without external retraining.

use crate::types::*;
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

/// Persisted task outcome used by the learner to derive patterns.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LearnerOutcome {
    pub task_id: String,
    pub event_type: EventType,
    pub task_type: TaskType,
    pub complexity: Complexity,
    pub model_used: String,
    pub success: bool,
    pub confidence_predicted: f64,
    pub tokens_used: u64,
    #[serde(default)]
    pub estimated_cost_usd: f64,
    pub cost_usd: f64,
    pub duration_secs: u64,
    pub failure_reason: Option<String>,
    pub labels: Vec<String>,
    pub repo: String,
    pub timestamp: DateTime<Utc>,
}

impl LearnerOutcome {
    fn normalize_costs(&mut self) {
        // Older persisted outcomes only tracked a single cost field. Backfill the
        // explicit estimate so we can keep historical learner stats coherent.
        if self.estimated_cost_usd == 0.0 && self.cost_usd > 0.0 {
            self.estimated_cost_usd = self.cost_usd;
        }
    }
}

/// Pattern derived from outcomes
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LearnedPattern {
    pub pattern_type: PatternType,
    pub key: String,
    pub success_rate: f64,
    pub sample_count: u64,
    pub avg_confidence: f64,
    #[serde(default)]
    pub avg_estimated_cost: f64,
    pub avg_cost: f64,
    pub last_updated: DateTime<Utc>,
}

/// Recommendation derived from learned outcomes and patterns.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LearnerRecommendation {
    pub kind: LearnerRecommendationKind,
    pub title: String,
    pub evidence: String,
    pub action: String,
    pub confidence: f64,
}

/// Recommendation categories that keep learning actionable and bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearnerRecommendationKind {
    PromotePattern,
    RepairPattern,
    GuardTransientFailure,
}

/// Type of pattern being tracked
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum PatternType {
    Label,
    TaskType,
    Complexity,
    Model,
    Repo,
    EventType,
}

/// Learner tracks outcomes and derives patterns
pub struct Learner {
    storage_path: PathBuf,
    outcomes: Vec<LearnerOutcome>,
    patterns: HashMap<(PatternType, String), LearnedPattern>,
    max_outcomes: usize,
    min_samples_for_pattern: u64,
}

impl Learner {
    /// Create a new Learner
    pub fn new(storage_path: PathBuf) -> Self {
        Self {
            storage_path,
            outcomes: vec![],
            patterns: HashMap::new(),
            max_outcomes: 10000,
            min_samples_for_pattern: 3,
        }
    }

    /// Path where learner state is persisted
    pub fn storage_path(&self) -> &std::path::Path {
        &self.storage_path
    }

    /// Record an outcome
    pub async fn record_outcome(&mut self, mut outcome: LearnerOutcome) -> anyhow::Result<()> {
        outcome.normalize_costs();
        self.outcomes.push(outcome.clone());

        // Keep transient setup failures available for learner stats and advice
        // without depressing long-lived routing confidence.
        if !outcome_is_transient_failure(&outcome) {
            self.update_patterns(&outcome);
        }

        // Persist periodically
        if self.outcomes.len().is_multiple_of(10) {
            self.persist().await?;
        }

        // Trim old outcomes
        if self.outcomes.len() > self.max_outcomes {
            self.outcomes = self.outcomes.split_off(self.max_outcomes / 2);
        }

        Ok(())
    }

    /// Update patterns based on new outcome
    fn update_patterns(&mut self, outcome: &LearnerOutcome) {
        // Update label patterns
        for label in &outcome.labels {
            self.update_pattern(PatternType::Label, label, outcome);
        }

        // Update task type pattern
        self.update_pattern(
            PatternType::TaskType,
            &format!("{:?}", outcome.task_type),
            outcome,
        );

        // Update complexity pattern
        self.update_pattern(
            PatternType::Complexity,
            &format!("{:?}", outcome.complexity),
            outcome,
        );

        // Update model pattern
        self.update_pattern(PatternType::Model, &outcome.model_used, outcome);

        // Update repo pattern
        self.update_pattern(PatternType::Repo, &outcome.repo, outcome);

        // Update event type pattern
        self.update_pattern(
            PatternType::EventType,
            &format!("{:?}", outcome.event_type),
            outcome,
        );
    }

    /// Update a single pattern
    fn update_pattern(&mut self, pattern_type: PatternType, key: &str, outcome: &LearnerOutcome) {
        let pattern_key = (pattern_type.clone(), key.to_string());

        let pattern = self
            .patterns
            .entry(pattern_key)
            .or_insert_with(|| LearnedPattern {
                pattern_type,
                key: key.to_string(),
                success_rate: 0.5, // Start with neutral
                sample_count: 0,
                avg_confidence: 0.0,
                avg_estimated_cost: 0.0,
                avg_cost: 0.0,
                last_updated: Utc::now(),
            });

        // Exponential moving average for success rate
        let alpha = 0.1; // Learning rate
        let success_val = if outcome.success { 1.0 } else { 0.0 };
        pattern.success_rate = pattern.success_rate * (1.0 - alpha) + success_val * alpha;

        // Update sample count
        pattern.sample_count += 1;

        // Update running averages
        let n = pattern.sample_count as f64;
        pattern.avg_confidence =
            ((n - 1.0) * pattern.avg_confidence + outcome.confidence_predicted) / n;
        pattern.avg_estimated_cost =
            ((n - 1.0) * pattern.avg_estimated_cost + outcome.estimated_cost_usd) / n;
        pattern.avg_cost = ((n - 1.0) * pattern.avg_cost + outcome.cost_usd) / n;

        pattern.last_updated = Utc::now();
    }

    /// Get success rate for a label
    pub fn get_label_success_rate(&self, label: &str) -> Option<f64> {
        self.patterns
            .get(&(PatternType::Label, label.to_string()))
            .filter(|p| p.sample_count >= self.min_samples_for_pattern)
            .map(|p| p.success_rate)
    }

    /// Get recommended model for a task type
    pub fn get_recommended_model(&self, task_type: &TaskType) -> Option<String> {
        let _task_key = format!("{:?}", task_type);

        // Find model patterns with best success rate for this task type
        // This is a simplified version - real implementation would cross-reference
        self.patterns
            .iter()
            .filter(|((pt, _), p)| {
                *pt == PatternType::Model && p.sample_count >= self.min_samples_for_pattern
            })
            .max_by(|(_, a), (_, b)| a.success_rate.total_cmp(&b.success_rate))
            .map(|((_, key), _)| key.clone())
    }

    /// Get confidence adjustment based on patterns
    pub fn get_confidence_adjustment(&self, event: &NormalizedEvent) -> f64 {
        let mut adjustment = 0.0;
        let mut factors = 0;

        // Check label patterns
        for label in &event.labels {
            if let Some(rate) = self.get_label_success_rate(label) {
                adjustment += (rate - 0.5) * 0.2; // Scale adjustment
                factors += 1;
            }
        }

        // Check repo pattern
        if let Some(pattern) = self
            .patterns
            .get(&(PatternType::Repo, event.repository.clone()))
        {
            if pattern.sample_count >= self.min_samples_for_pattern {
                adjustment += (pattern.success_rate - 0.5) * 0.1;
                factors += 1;
            }
        }

        // Check event type pattern
        if let Some(pattern) = self
            .patterns
            .get(&(PatternType::EventType, format!("{:?}", event.event_type)))
        {
            if pattern.sample_count >= self.min_samples_for_pattern {
                adjustment += (pattern.success_rate - 0.5) * 0.15;
                factors += 1;
            }
        }

        if factors > 0 {
            adjustment / factors as f64
        } else {
            0.0
        }
    }

    /// Get all patterns with sufficient samples
    pub fn get_patterns(&self) -> Vec<&LearnedPattern> {
        self.patterns
            .values()
            .filter(|p| p.sample_count >= self.min_samples_for_pattern)
            .collect()
    }

    /// Get patterns sorted by success rate
    pub fn get_top_patterns(
        &self,
        pattern_type: PatternType,
        limit: usize,
    ) -> Vec<&LearnedPattern> {
        let mut patterns: Vec<_> = self
            .patterns
            .values()
            .filter(|p| {
                p.pattern_type == pattern_type && p.sample_count >= self.min_samples_for_pattern
            })
            .collect();

        patterns.sort_by(|a, b| b.success_rate.partial_cmp(&a.success_rate).unwrap());
        patterns.truncate(limit);
        patterns
    }

    /// Get patterns that need attention (low success rate)
    pub fn get_problematic_patterns(&self, threshold: f64) -> Vec<&LearnedPattern> {
        self.patterns
            .values()
            .filter(|p| {
                p.sample_count >= self.min_samples_for_pattern && p.success_rate < threshold
            })
            .collect()
    }

    /// Build durable recommendations from outcomes and learned patterns.
    ///
    /// This intentionally keeps transient setup failures out of long-lived
    /// playbooks. Missing binaries, credentials, rate limits, and short-lived
    /// network/setup failures should produce setup or retry advice, not a
    /// permanent claim that a tool or task class is impossible.
    pub fn get_recommendations(&self, limit: usize) -> Vec<LearnerRecommendation> {
        let mut recommendations = vec![];

        let transient_failures = self
            .outcomes
            .iter()
            .filter(|outcome| !outcome.success)
            .filter_map(|outcome| outcome.failure_reason.as_deref())
            .filter(|reason| is_transient_failure_reason(reason))
            .count();
        if transient_failures > 0 {
            recommendations.push(LearnerRecommendation {
                kind: LearnerRecommendationKind::GuardTransientFailure,
                title: "Quarantine transient setup failures".to_string(),
                evidence: format!(
                    "{transient_failures} failure(s) matched setup, credential, network, timeout, or rate-limit patterns"
                ),
                action: "Capture the recovery step or prerequisite; do not persist a durable rule that the tool or task class is broken.".to_string(),
                confidence: (0.6 + (transient_failures as f64 * 0.05)).min(0.95),
            });
        }

        let mut promotable: Vec<_> = self
            .patterns
            .values()
            .filter_map(|pattern| {
                let stats = self.pattern_non_transient_stats(pattern);
                (stats.sample_count >= self.min_samples_for_pattern && stats.success_rate >= 0.75)
                    .then_some((pattern, stats))
            })
            .collect();
        promotable.sort_by(|left, right| {
            right
                .1
                .success_rate
                .total_cmp(&left.1.success_rate)
                .then_with(|| right.1.sample_count.cmp(&left.1.sample_count))
                .then_with(|| {
                    recommendation_pattern_priority(&left.0.pattern_type)
                        .cmp(&recommendation_pattern_priority(&right.0.pattern_type))
                })
                .then_with(|| left.0.key.cmp(&right.0.key))
        });
        for (pattern, stats) in promotable.into_iter().take(2) {
            recommendations.push(LearnerRecommendation {
                kind: LearnerRecommendationKind::PromotePattern,
                title: format!("Promote successful {} pattern", pattern.key),
                evidence: format!(
                    "{:?}={} succeeded {:.1}% across {} non-transient sample(s)",
                    pattern.pattern_type,
                    pattern.key,
                    stats.success_rate * 100.0,
                    stats.sample_count
                ),
                action: "Create or update a class-level playbook with the task shape, required evidence, and verification steps.".to_string(),
                confidence: stats.success_rate,
            });
        }

        let mut problematic: Vec<_> = self
            .get_problematic_patterns(0.45)
            .into_iter()
            .filter(|pattern| self.pattern_has_non_transient_failure(pattern))
            .collect();
        problematic.sort_by(|left, right| {
            left.success_rate
                .total_cmp(&right.success_rate)
                .then_with(|| right.sample_count.cmp(&left.sample_count))
        });
        for pattern in problematic.into_iter().take(2) {
            recommendations.push(LearnerRecommendation {
                kind: LearnerRecommendationKind::RepairPattern,
                title: format!("Repair weak {} pattern", pattern.key),
                evidence: format!(
                    "{:?}={} succeeded only {:.1}% across {} sample(s)",
                    pattern.pattern_type,
                    pattern.key,
                    pattern.success_rate * 100.0,
                    pattern.sample_count
                ),
                action: "Tighten routing, approval thresholds, or verification for this class before allowing more ambient autonomy.".to_string(),
                confidence: 1.0 - pattern.success_rate,
            });
        }

        recommendations.sort_by(|left, right| {
            right
                .confidence
                .total_cmp(&left.confidence)
                .then_with(|| format!("{:?}", left.kind).cmp(&format!("{:?}", right.kind)))
        });
        recommendations.truncate(limit);
        recommendations
    }

    fn pattern_has_non_transient_failure(&self, pattern: &LearnedPattern) -> bool {
        self.outcomes.iter().any(|outcome| {
            !outcome.success
                && !outcome
                    .failure_reason
                    .as_deref()
                    .is_some_and(is_transient_failure_reason)
                && outcome_matches_pattern(outcome, pattern)
        })
    }

    fn pattern_non_transient_stats(&self, pattern: &LearnedPattern) -> PatternEvidenceStats {
        let mut success_count = 0usize;
        let mut sample_count = 0usize;
        for outcome in self
            .outcomes
            .iter()
            .filter(|outcome| outcome_matches_pattern(outcome, pattern))
        {
            if outcome.success {
                success_count += 1;
                sample_count += 1;
            } else if !outcome
                .failure_reason
                .as_deref()
                .is_some_and(is_transient_failure_reason)
            {
                sample_count += 1;
            }
        }
        PatternEvidenceStats {
            sample_count: sample_count as u64,
            success_rate: if sample_count == 0 {
                0.0
            } else {
                success_count as f64 / sample_count as f64
            },
        }
    }

    /// Get summary statistics
    pub fn get_stats(&self) -> LearnerStats {
        let total_outcomes = self.outcomes.len();
        let successful = self.outcomes.iter().filter(|o| o.success).count();
        let total_cost: f64 = self.outcomes.iter().map(|o| o.cost_usd).sum();
        let total_estimated_cost: f64 = self.outcomes.iter().map(|o| o.estimated_cost_usd).sum();
        let total_patterns = self.patterns.len();
        let protected_transient_failure_count = self
            .outcomes
            .iter()
            .filter(|outcome| !outcome.success)
            .filter_map(|outcome| outcome.failure_reason.as_deref())
            .filter(|reason| is_transient_failure_reason(reason))
            .count() as u64;

        // Recent performance (last 24 hours)
        let cutoff = Utc::now() - Duration::hours(24);
        let recent: Vec<_> = self
            .outcomes
            .iter()
            .filter(|o| o.timestamp > cutoff)
            .collect();
        let recent_success_rate = if recent.is_empty() {
            0.0
        } else {
            recent.iter().filter(|o| o.success).count() as f64 / recent.len() as f64
        };

        LearnerStats {
            total_outcomes: total_outcomes as u64,
            overall_success_rate: if total_outcomes > 0 {
                successful as f64 / total_outcomes as f64
            } else {
                0.0
            },
            recent_success_rate,
            total_cost,
            total_estimated_cost,
            total_patterns: total_patterns as u64,
            protected_transient_failure_count,
        }
    }

    /// Persist to disk
    pub async fn persist(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.storage_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let data = LearnerData {
            outcomes: self.outcomes.clone(),
            patterns: self.patterns.values().cloned().collect(),
        };

        let json = serde_json::to_string_pretty(&data)?;
        fs::write(&self.storage_path, json).await?;

        Ok(())
    }

    /// Load from disk
    pub async fn load(&mut self) -> anyhow::Result<()> {
        if !self.storage_path.exists() {
            return Ok(());
        }

        let content = fs::read_to_string(&self.storage_path).await?;
        let data: LearnerData = serde_json::from_str(&content)?;

        self.outcomes = data.outcomes;
        for outcome in &mut self.outcomes {
            outcome.normalize_costs();
        }
        self.patterns.clear();

        // Rebuild derived patterns from outcomes so schema changes in persisted
        // pattern caches do not leave learner behavior stale or ambiguous.
        for outcome in self.outcomes.clone() {
            if !outcome_is_transient_failure(&outcome) {
                self.update_patterns(&outcome);
            }
        }

        Ok(())
    }
}

/// Stats about the learner
#[derive(Debug, Clone)]
pub struct LearnerStats {
    pub total_outcomes: u64,
    pub overall_success_rate: f64,
    pub recent_success_rate: f64,
    pub total_cost: f64,
    pub total_estimated_cost: f64,
    pub total_patterns: u64,
    pub protected_transient_failure_count: u64,
}

/// Serialization helper
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct LearnerData {
    outcomes: Vec<LearnerOutcome>,
    patterns: Vec<LearnedPattern>,
}

struct PatternEvidenceStats {
    sample_count: u64,
    success_rate: f64,
}

fn recommendation_pattern_priority(pattern_type: &PatternType) -> u8 {
    match pattern_type {
        PatternType::Label => 0,
        PatternType::Repo => 1,
        PatternType::TaskType => 2,
        PatternType::Complexity => 3,
        PatternType::Model => 4,
        PatternType::EventType => 5,
    }
}

fn outcome_is_transient_failure(outcome: &LearnerOutcome) -> bool {
    !outcome.success
        && outcome
            .failure_reason
            .as_deref()
            .is_some_and(is_transient_failure_reason)
}

fn is_transient_failure_reason(reason: &str) -> bool {
    let reason = reason.to_lowercase();
    [
        "command not found",
        "no such file or directory",
        "missing binary",
        "missing credential",
        "unconfigured",
        "not configured",
        "authentication required",
        "connection refused",
        "temporary failure in name resolution",
    ]
    .iter()
    .any(|needle| reason.contains(needle))
        || is_transient_rate_limit_failure_reason(&reason)
        || is_transient_transport_failure_reason(&reason)
}

fn is_transient_rate_limit_failure_reason(reason: &str) -> bool {
    ["429 too many requests", "http 429", "status 429"]
        .iter()
        .any(|needle| reason.contains(needle))
        || (reason.contains("rate limit") && has_transient_environment_context(reason))
}

fn is_transient_transport_failure_reason(reason: &str) -> bool {
    [
        "etimedout",
        "econnreset",
        "enotfound",
        "eai_again",
        "connection timed out",
        "socket timed out",
        "network unreachable",
        "network unavailable",
        "network reset",
        "temporary network",
    ]
    .iter()
    .any(|needle| reason.contains(needle))
        || ([
            "request timed out",
            "connect timed out",
            "fetch timed out",
            "timed out",
            "network error",
            "network failure",
            "dns lookup",
            "name resolution",
        ]
        .iter()
        .any(|needle| reason.contains(needle))
            && has_transient_environment_context(reason))
}

fn has_transient_environment_context(reason: &str) -> bool {
    [
        "while bootstrapping",
        "while fetching",
        "while downloading",
        "while installing",
        "while authenticating",
        "while connecting",
        "while calling",
        "fetching dependencies",
        "downloading dependencies",
        "installing dependencies",
        "dependency install",
        "fresh runner",
        "github api",
        "npm registry",
        "package registry",
    ]
    .iter()
    .any(|needle| reason.contains(needle))
}

fn outcome_matches_pattern(outcome: &LearnerOutcome, pattern: &LearnedPattern) -> bool {
    match pattern.pattern_type {
        PatternType::Label => outcome.labels.iter().any(|label| label == &pattern.key),
        PatternType::TaskType => format!("{:?}", outcome.task_type) == pattern.key,
        PatternType::Complexity => format!("{:?}", outcome.complexity) == pattern.key,
        PatternType::Model => outcome.model_used == pattern.key,
        PatternType::Repo => outcome.repo == pattern.key,
        PatternType::EventType => format!("{:?}", outcome.event_type) == pattern.key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_outcome(success: bool, labels: Vec<&str>) -> LearnerOutcome {
        LearnerOutcome {
            task_id: "test-task".to_string(),
            event_type: EventType::Issue,
            task_type: TaskType::Fix,
            complexity: Complexity::Simple,
            model_used: "claude-sonnet".to_string(),
            success,
            confidence_predicted: 0.8,
            tokens_used: 1000,
            estimated_cost_usd: 0.01,
            cost_usd: 0.01,
            duration_secs: 60,
            failure_reason: if success {
                None
            } else {
                Some("test failure".to_string())
            },
            labels: labels.iter().map(|s| s.to_string()).collect(),
            repo: "test/repo".to_string(),
            timestamp: Utc::now(),
        }
    }

    fn make_event(labels: Vec<&str>) -> NormalizedEvent {
        let repo = Repository {
            owner: "test".to_string(),
            name: "repo".to_string(),
            full_name: "test/repo".to_string(),
            default_branch: "main".to_string(),
            path: "/tmp/test-repo".to_string(),
            url: "https://github.com/test/repo".to_string(),
            config: None,
            agent_md: None,
            test_coverage: None,
            codeowners: vec![],
        };

        NormalizedEvent {
            id: "event-1".to_string(),
            source: WatcherType::GitHubPoll,
            event_type: EventType::Issue,
            repo: repo.clone(),
            repository: repo.full_name.clone(),
            priority: 50,
            title: "Test event".to_string(),
            body: Some("Test body".to_string()),
            labels: labels.iter().map(|label| label.to_string()).collect(),
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: Some("Test event".to_string()),
                body: Some("Test body".to_string()),
                number: Some(1),
                labels: labels.iter().map(|label| label.to_string()).collect(),
                author: Some("octocat".to_string()),
                url: Some("https://github.com/test/repo/issues/1".to_string()),
                extra: std::collections::HashMap::new(),
            },
            created_at: Utc::now(),
            processed_at: None,
            status: EventStatus::Pending,
            flags: EventFlags::default(),
        }
    }

    #[tokio::test]
    async fn test_pattern_learning() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        // Record several outcomes with "bug" label
        // EMA with alpha=0.1 starting from 0.5 after 5 successes gives ~0.70
        for _ in 0..5 {
            learner
                .record_outcome(make_outcome(true, vec!["bug"]))
                .await
                .unwrap();
        }

        // Should have learned pattern - rate should be above initial 0.5
        let rate = learner.get_label_success_rate("bug");
        assert!(rate.is_some());
        assert!(rate.unwrap() > 0.65); // Conservative threshold given EMA
    }

    #[tokio::test]
    async fn test_persistence() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("learner.json");

        {
            let mut learner = Learner::new(path.clone());
            for _ in 0..5 {
                learner
                    .record_outcome(make_outcome(true, vec!["test"]))
                    .await
                    .unwrap();
            }
            learner.persist().await.unwrap();
        }

        // Reload
        let mut learner = Learner::new(path);
        learner.load().await.unwrap();

        let stats = learner.get_stats();
        assert_eq!(stats.total_outcomes, 5);
        assert_eq!(stats.total_estimated_cost, 0.05);
    }

    #[tokio::test]
    async fn test_load_backfills_missing_estimated_costs() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("learner.json");
        let legacy = serde_json::json!({
            "outcomes": [{
                "task_id": "legacy-task",
                "event_type": "issue",
                "task_type": "fix",
                "complexity": "simple",
                "model_used": "claude-sonnet",
                "success": true,
                "confidence_predicted": 0.7,
                "tokens_used": 500,
                "cost_usd": 0.42,
                "duration_secs": 5,
                "failure_reason": null,
                "labels": ["bug"],
                "repo": "test/repo",
                "timestamp": Utc::now(),
            }],
            "patterns": [],
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap())
            .await
            .unwrap();

        let mut learner = Learner::new(path);
        learner.load().await.unwrap();

        let stats = learner.get_stats();
        assert_eq!(stats.total_outcomes, 1);
        assert_eq!(stats.total_cost, 0.42);
        assert_eq!(stats.total_estimated_cost, 0.42);
        assert!(learner.get_label_success_rate("bug").is_none());
    }

    #[tokio::test]
    async fn test_recommendations_promote_patterns_and_guard_transient_failures() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        for _ in 0..8 {
            learner
                .record_outcome(make_outcome(true, vec!["safe-refactor"]))
                .await
                .unwrap();
        }

        let mut transient = make_outcome(false, vec!["nightly"]);
        transient.failure_reason = Some("command not found: gh in fresh runner".to_string());
        learner.record_outcome(transient).await.unwrap();

        let stats = learner.get_stats();
        assert_eq!(stats.protected_transient_failure_count, 1);

        let recommendations = learner.get_recommendations(10);
        assert!(recommendations.iter().any(|recommendation| {
            recommendation.kind == LearnerRecommendationKind::GuardTransientFailure
                && recommendation
                    .action
                    .contains("do not persist a durable rule")
        }));
        assert!(recommendations.iter().any(|recommendation| {
            recommendation.kind == LearnerRecommendationKind::PromotePattern
                && recommendation.evidence.contains("safe-refactor")
        }));
    }

    #[tokio::test]
    async fn test_recommendations_skip_transient_only_repair_patterns() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        for reason in [
            "command not found: gh in fresh runner",
            "missing credential for GitHub",
            "rate limit while bootstrapping",
            "request timed out while fetching dependencies",
            "network error while bootstrapping",
        ] {
            let mut outcome = make_outcome(false, vec!["nightly"]);
            outcome.failure_reason = Some(reason.to_string());
            learner.record_outcome(outcome).await.unwrap();
        }

        let recommendations = learner.get_recommendations(10);
        assert!(recommendations
            .iter()
            .any(|recommendation| recommendation.kind
                == LearnerRecommendationKind::GuardTransientFailure));
        assert!(!recommendations
            .iter()
            .any(|recommendation| recommendation.kind == LearnerRecommendationKind::RepairPattern));
    }

    #[tokio::test]
    async fn test_recommendations_promote_with_transient_noise() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        for _ in 0..3 {
            learner
                .record_outcome(make_outcome(true, vec!["bug"]))
                .await
                .unwrap();
        }
        for _ in 0..5 {
            let mut outcome = make_outcome(false, vec!["bug"]);
            outcome.failure_reason = Some("command not found: gh".to_string());
            learner.record_outcome(outcome).await.unwrap();
        }

        let recommendations = learner.get_recommendations(10);
        assert!(recommendations.iter().any(|recommendation| {
            recommendation.kind == LearnerRecommendationKind::PromotePattern
                && recommendation.evidence.contains("non-transient sample")
        }));
    }

    #[tokio::test]
    async fn test_transient_failures_do_not_adjust_confidence() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        for _ in 0..3 {
            let mut outcome = make_outcome(false, vec!["nightly"]);
            outcome.failure_reason = Some("command not found: gh in fresh runner".to_string());
            learner.record_outcome(outcome).await.unwrap();
        }

        let adjustment = learner.get_confidence_adjustment(&make_event(vec!["nightly"]));
        assert_eq!(adjustment, 0.0);
        assert!(learner.get_label_success_rate("nightly").is_none());
    }

    #[tokio::test]
    async fn test_load_keeps_transient_failures_out_of_patterns() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("learner.json");

        {
            let mut learner = Learner::new(path.clone());
            for _ in 0..3 {
                let mut outcome = make_outcome(false, vec!["nightly"]);
                outcome.failure_reason = Some("command not found: gh in fresh runner".to_string());
                learner.record_outcome(outcome).await.unwrap();
            }
            learner.persist().await.unwrap();
        }

        let mut learner = Learner::new(path);
        learner.load().await.unwrap();

        let adjustment = learner.get_confidence_adjustment(&make_event(vec!["nightly"]));
        assert_eq!(adjustment, 0.0);
        assert!(learner.get_label_success_rate("nightly").is_none());
    }

    #[tokio::test]
    async fn test_recommendations_keep_durable_repair_patterns() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        for reason in [
            "checkout timeout budget regressed in product flow",
            "network graph planner returned invalid route",
            "review rejected incomplete fix",
        ] {
            let mut outcome = make_outcome(false, vec!["bug"]);
            outcome.failure_reason = Some(reason.to_string());
            learner.record_outcome(outcome).await.unwrap();
        }

        let stats = learner.get_stats();
        assert_eq!(stats.protected_transient_failure_count, 0);

        let recommendations = learner.get_recommendations(10);
        assert!(recommendations
            .iter()
            .any(|recommendation| recommendation.kind == LearnerRecommendationKind::RepairPattern));
    }

    #[test]
    fn test_transient_classifier_requires_environment_context_for_product_terms() {
        for reason in [
            "name resolution rule emitted the wrong symbol",
            "network error UI failed to show retry guidance",
            "rate limit policy resolver failed closed",
        ] {
            assert!(
                !is_transient_failure_reason(reason),
                "{reason} should stay durable learner evidence"
            );
        }

        for reason in [
            "temporary failure in name resolution",
            "network error while bootstrapping",
            "rate limit while fetching dependencies",
            "request timed out while installing dependencies",
        ] {
            assert!(
                is_transient_failure_reason(reason),
                "{reason} should be quarantined as transient evidence"
            );
        }
    }
}

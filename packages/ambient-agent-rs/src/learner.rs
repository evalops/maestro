//! Learner (Self-Evolving Patterns)
//!
//! Tracks outcomes and updates patterns based on successes/failures.
//! Enables the agent to improve over time without external retraining.

use crate::types::*;
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

/// Outcome record for learning
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Outcome {
    pub task_id: String,
    pub event_type: EventType,
    pub task_type: TaskType,
    pub complexity: Complexity,
    pub model_used: String,
    pub success: bool,
    pub confidence_predicted: f64,
    pub tokens_used: u64,
    pub cost_usd: f64,
    pub duration_secs: u64,
    pub failure_reason: Option<String>,
    pub labels: Vec<String>,
    pub repo: String,
    pub timestamp: DateTime<Utc>,
}

/// Pattern derived from outcomes
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LearnedPattern {
    pub pattern_type: PatternType,
    pub key: String,
    pub success_rate: f64,
    pub sample_count: u64,
    pub avg_confidence: f64,
    pub avg_cost: f64,
    pub last_updated: DateTime<Utc>,
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
    outcomes: Vec<Outcome>,
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

    /// Record an outcome
    pub async fn record_outcome(&mut self, outcome: Outcome) -> anyhow::Result<()> {
        self.outcomes.push(outcome.clone());

        // Update patterns
        self.update_patterns(&outcome);

        // Persist periodically
        if self.outcomes.len() % 10 == 0 {
            self.persist().await?;
        }

        // Trim old outcomes
        if self.outcomes.len() > self.max_outcomes {
            self.outcomes = self.outcomes.split_off(self.max_outcomes / 2);
        }

        Ok(())
    }

    /// Update patterns based on new outcome
    fn update_patterns(&mut self, outcome: &Outcome) {
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
    fn update_pattern(&mut self, pattern_type: PatternType, key: &str, outcome: &Outcome) {
        let pattern_key = (pattern_type.clone(), key.to_string());

        let pattern = self.patterns.entry(pattern_key).or_insert_with(|| LearnedPattern {
            pattern_type,
            key: key.to_string(),
            success_rate: 0.5, // Start with neutral
            sample_count: 0,
            avg_confidence: 0.0,
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
        pattern.avg_confidence = ((n - 1.0) * pattern.avg_confidence + outcome.confidence_predicted) / n;
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
            .max_by(|(_, a), (_, b)| a.success_rate.partial_cmp(&b.success_rate).unwrap())
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
        if let Some(pattern) = self.patterns.get(&(PatternType::Repo, event.repository.clone())) {
            if pattern.sample_count >= self.min_samples_for_pattern {
                adjustment += (pattern.success_rate - 0.5) * 0.1;
                factors += 1;
            }
        }

        // Check event type pattern
        if let Some(pattern) = self.patterns.get(&(PatternType::EventType, format!("{:?}", event.event_type))) {
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
    pub fn get_top_patterns(&self, pattern_type: PatternType, limit: usize) -> Vec<&LearnedPattern> {
        let mut patterns: Vec<_> = self.patterns
            .values()
            .filter(|p| p.pattern_type == pattern_type && p.sample_count >= self.min_samples_for_pattern)
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

    /// Get summary statistics
    pub fn get_stats(&self) -> LearnerStats {
        let total_outcomes = self.outcomes.len();
        let successful = self.outcomes.iter().filter(|o| o.success).count();
        let total_cost: f64 = self.outcomes.iter().map(|o| o.cost_usd).sum();
        let total_patterns = self.patterns.len();

        // Recent performance (last 24 hours)
        let cutoff = Utc::now() - Duration::hours(24);
        let recent: Vec<_> = self.outcomes.iter().filter(|o| o.timestamp > cutoff).collect();
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
            total_patterns: total_patterns as u64,
        }
    }

    /// Persist to disk
    pub async fn persist(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.storage_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let data = LearnerData {
            outcomes: self.outcomes.clone(),
            patterns: self.patterns.iter().map(|(_, v)| v.clone()).collect(),
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
        self.patterns.clear();

        for pattern in data.patterns {
            let key = (pattern.pattern_type.clone(), pattern.key.clone());
            self.patterns.insert(key, pattern);
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
    pub total_patterns: u64,
}

/// Serialization helper
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct LearnerData {
    outcomes: Vec<Outcome>,
    patterns: Vec<LearnedPattern>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_outcome(success: bool, labels: Vec<&str>) -> Outcome {
        Outcome {
            task_id: "test-task".to_string(),
            event_type: EventType::Issue,
            task_type: TaskType::Fix,
            complexity: Complexity::Simple,
            model_used: "claude-sonnet".to_string(),
            success,
            confidence_predicted: 0.8,
            tokens_used: 1000,
            cost_usd: 0.01,
            duration_secs: 60,
            failure_reason: if success { None } else { Some("test failure".to_string()) },
            labels: labels.iter().map(|s| s.to_string()).collect(),
            repo: "test/repo".to_string(),
            timestamp: Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_pattern_learning() {
        let temp = TempDir::new().unwrap();
        let mut learner = Learner::new(temp.path().join("learner.json"));

        // Record several outcomes with "bug" label
        // EMA with alpha=0.1 starting from 0.5 after 5 successes gives ~0.70
        for _ in 0..5 {
            learner.record_outcome(make_outcome(true, vec!["bug"])).await.unwrap();
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
                learner.record_outcome(make_outcome(true, vec!["test"])).await.unwrap();
            }
            learner.persist().await.unwrap();
        }

        // Reload
        let mut learner = Learner::new(path);
        learner.load().await.unwrap();

        let stats = learner.get_stats();
        assert_eq!(stats.total_outcomes, 5);
    }
}

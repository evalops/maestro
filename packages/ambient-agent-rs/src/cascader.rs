//! Cascader (Model Routing)
//!
//! Routes tasks to appropriate models based on complexity, type, and cost.
//! Research shows up to 94% cost reduction possible with proper routing.

use crate::types::*;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::LazyLock;

pub const DEFAULT_OPENROUTER_FRONTIER_MODEL: &str = "~anthropic/claude-opus-latest";
pub const DEFAULT_ANTHROPIC_FRONTIER_MODEL: &str = "claude-opus-4-1-20250805";
pub const DEFAULT_FRONTIER_PROVIDER: &str = "openrouter";

/// Default model tiers
fn default_tiers() -> Vec<ModelTier> {
    vec![ModelTier {
        name: "frontier".to_string(),
        model: ambient_frontier_model(),
        // OpenRouter currently lists Claude Opus latest/4.7 at $5/M input and
        // $25/M output tokens. Keep these estimates conservative and visible.
        cost_per_1k_input: 0.005,
        cost_per_1k_output: 0.025,
        capabilities: vec![
            "typo-fix".to_string(),
            "simple-refactor".to_string(),
            "doc-update".to_string(),
            "feature-impl".to_string(),
            "bug-fix".to_string(),
            "refactor".to_string(),
            "test-write".to_string(),
            "architecture".to_string(),
            "complex-debug".to_string(),
            "security-fix".to_string(),
        ],
        max_complexity: Complexity::High,
    }]
}

fn ambient_frontier_model() -> String {
    std::env::var("MAESTRO_AMBIENT_FRONTIER_MODEL")
        .or_else(|_| std::env::var("AMBIENT_FRONTIER_MODEL"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_frontier_model_for_configured_provider)
}

fn default_frontier_model_for_configured_provider() -> String {
    match std::env::var("MAESTRO_AMBIENT_LLM_API").ok().as_deref() {
        Some("anthropic") | Some("anthropic-messages") => {
            DEFAULT_ANTHROPIC_FRONTIER_MODEL.to_string()
        }
        _ => DEFAULT_OPENROUTER_FRONTIER_MODEL.to_string(),
    }
}

/// Static task type to capability mapping to avoid recreation on every call
static TASK_TYPE_CAPABILITIES: LazyLock<HashMap<TaskType, Vec<&'static str>>> =
    LazyLock::new(|| {
        let mut map = HashMap::new();
        map.insert(TaskType::Implement, vec!["feature-impl", "architecture"]);
        map.insert(
            TaskType::Fix,
            vec!["bug-fix", "simple-refactor", "complex-debug"],
        );
        map.insert(
            TaskType::Refactor,
            vec!["simple-refactor", "refactor", "architecture"],
        );
        map.insert(TaskType::Test, vec!["test-write", "feature-impl"]);
        map.insert(TaskType::Document, vec!["doc-update"]);
        map.insert(TaskType::Security, vec!["security-fix", "complex-debug"]);
        map
    });

/// Routing result
#[derive(Debug, Clone)]
pub struct RoutingResult {
    pub model: String,
    pub tier: ModelTier,
    pub reason: String,
    pub estimated_cost: f64,
}

/// Statistics about routing
#[derive(Debug, Clone, Default)]
pub struct CascaderStats {
    pub total_routings: u64,
    pub routings_by_tier: HashMap<String, u64>,
    pub total_cost_saved: f64,
    pub average_cost: f64,
}

/// Task context for routing decisions
#[derive(Debug, Clone)]
pub struct TaskContext {
    pub complexity: Complexity,
    pub task_type: TaskType,
    pub estimated_tokens: Option<u64>,
    pub previous_attempts: u32,
}

/// Cascader routes tasks to appropriate models
pub struct Cascader {
    config: CascaderConfig,
    cost_history: Vec<CostTracker>,
    stats: CascaderStats,
}

impl Cascader {
    /// Create a new Cascader
    pub fn new(config: Option<CascaderConfig>) -> Self {
        let config = config.unwrap_or_else(|| CascaderConfig {
            tiers: default_tiers(),
            fallback_to_higher: true,
            max_retries: 2,
        });

        let mut stats = CascaderStats::default();
        for tier in &config.tiers {
            stats.routings_by_tier.insert(tier.name.clone(), 0);
        }

        Self {
            config,
            cost_history: vec![],
            stats,
        }
    }

    /// Route a task to the most appropriate model
    pub fn route(&mut self, task: &Task, context: &TaskContext) -> RoutingResult {
        self.stats.total_routings += 1;

        let needed = TASK_TYPE_CAPABILITIES
            .get(&context.task_type)
            .cloned()
            .unwrap_or_default();

        // Find eligible tiers
        let mut eligible: Vec<_> = self
            .config
            .tiers
            .iter()
            .filter(|tier| {
                tier.max_complexity >= context.complexity
                    && tier
                        .capabilities
                        .iter()
                        .any(|c| needed.contains(&c.as_str()))
            })
            .collect();

        // Sort by cost (using total_cmp to avoid NaN panics)
        eligible.sort_by(|a, b| {
            let cost_a = a.cost_per_1k_input + a.cost_per_1k_output;
            let cost_b = b.cost_per_1k_input + b.cost_per_1k_output;
            cost_a.total_cmp(&cost_b)
        });

        // Get default tier safely (first tier, or create a default if empty)
        let default_tier = || {
            self.config
                .tiers
                .first()
                .cloned()
                .unwrap_or_else(|| ModelTier {
                    name: "fallback".to_string(),
                    model: ambient_frontier_model(),
                    cost_per_1k_input: 0.005,
                    cost_per_1k_output: 0.025,
                    capabilities: vec![
                        "feature-impl".to_string(),
                        "architecture".to_string(),
                        "security-fix".to_string(),
                    ],
                    max_complexity: Complexity::High,
                })
        };

        let (selected, reason) = if let Some(tier) = eligible.first() {
            (
                (*tier).clone(),
                format!(
                    "Cheapest tier with {:?} capability for {:?} complexity",
                    context.task_type, context.complexity
                ),
            )
        } else if self.config.fallback_to_higher {
            (
                self.config
                    .tiers
                    .last()
                    .cloned()
                    .unwrap_or_else(default_tier),
                "Fallback to advanced tier".to_string(),
            )
        } else {
            (
                default_tier(),
                "Default to configured frontier tier".to_string(),
            )
        };

        // Escalate on retry
        let (selected, reason) = if context.previous_attempts > 0 {
            let current_idx = self
                .config
                .tiers
                .iter()
                .position(|t| t.name == selected.name)
                .unwrap_or(0);
            if current_idx < self.config.tiers.len() - 1 {
                (
                    self.config.tiers[current_idx + 1].clone(),
                    format!(
                        "Escalated after {} failed attempt(s)",
                        context.previous_attempts
                    ),
                )
            } else {
                (selected, reason)
            }
        } else {
            (selected, reason)
        };

        // Update stats
        *self
            .stats
            .routings_by_tier
            .entry(selected.name.clone())
            .or_insert(0) += 1;

        // Estimate cost
        let tokens = context
            .estimated_tokens
            .unwrap_or(self.estimate_tokens(task, context));
        let estimated_cost = (tokens as f64 * selected.cost_per_1k_input) / 1000.0
            + (tokens as f64 * 0.3 * selected.cost_per_1k_output) / 1000.0;

        RoutingResult {
            model: selected.model.clone(),
            tier: selected,
            reason,
            estimated_cost,
        }
    }

    /// Record an outcome
    pub fn record_outcome(
        &mut self,
        tier: &ModelTier,
        success: bool,
        actual_tokens: u64,
        actual_cost: f64,
    ) {
        self.cost_history.push(CostTracker {
            task_type: "unknown".to_string(),
            model_used: tier.model.clone(),
            tokens: actual_tokens,
            cost_usd: actual_cost,
            success,
            timestamp: Utc::now(),
        });

        // Calculate cost saved vs highest-cost configured tier.
        if let Some(advanced) = self.config.tiers.iter().max_by(|a, b| {
            let cost_a = a.cost_per_1k_input + a.cost_per_1k_output;
            let cost_b = b.cost_per_1k_input + b.cost_per_1k_output;
            cost_a.total_cmp(&cost_b)
        }) {
            if tier.name != advanced.name {
                let advanced_cost = (actual_tokens as f64 * advanced.cost_per_1k_input) / 1000.0
                    + (actual_tokens as f64 * 0.3 * advanced.cost_per_1k_output) / 1000.0;
                self.stats.total_cost_saved += advanced_cost - actual_cost;
            }
        }

        // Update average
        let total: f64 = self.cost_history.iter().map(|h| h.cost_usd).sum();
        self.stats.average_cost = total / self.cost_history.len() as f64;

        // Keep bounded
        if self.cost_history.len() > 1000 {
            self.cost_history = self.cost_history.split_off(500);
        }
    }

    /// Estimate tokens for a task
    fn estimate_tokens(&self, _task: &Task, context: &TaskContext) -> u64 {
        let base = match context.complexity {
            Complexity::Trivial => 500,
            Complexity::Simple => 2000,
            Complexity::Medium => 8000,
            Complexity::Complex => 25000,
            Complexity::High => 50000,
        };

        let multiplier = match context.task_type {
            TaskType::Implement => 1.5,
            TaskType::Fix => 1.0,
            TaskType::Refactor => 1.3,
            TaskType::Test => 1.2,
            TaskType::Document => 0.5,
            TaskType::Security => 1.8,
        };

        (base as f64 * multiplier) as u64
    }

    /// Get statistics
    pub fn get_stats(&self) -> CascaderStats {
        self.stats.clone()
    }

    /// Get cost savings percentage
    pub fn get_cost_savings_percent(&self) -> f64 {
        if self.cost_history.is_empty() {
            return 0.0;
        }

        let advanced = match self.config.tiers.iter().max_by(|a, b| {
            let cost_a = a.cost_per_1k_input + a.cost_per_1k_output;
            let cost_b = b.cost_per_1k_input + b.cost_per_1k_output;
            cost_a.total_cmp(&cost_b)
        }) {
            Some(t) => t,
            None => return 0.0,
        };

        let actual_total: f64 = self.cost_history.iter().map(|h| h.cost_usd).sum();
        let advanced_total: f64 = self
            .cost_history
            .iter()
            .map(|h| {
                (h.tokens as f64 * advanced.cost_per_1k_input) / 1000.0
                    + (h.tokens as f64 * 0.3 * advanced.cost_per_1k_output) / 1000.0
            })
            .sum();

        if advanced_total == 0.0 {
            0.0
        } else {
            ((advanced_total - actual_total) / advanced_total) * 100.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn task(task_type: TaskType) -> Task {
        Task {
            id: "task-1".to_string(),
            task_type,
            prompt: "Do the work".to_string(),
            files: vec![],
            depends_on: vec![],
            priority: 100,
            estimated_tokens: Some(4_000),
        }
    }

    #[test]
    fn default_routes_ambient_work_to_openrouter_opus_latest() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("MAESTRO_AMBIENT_FRONTIER_MODEL");
        std::env::remove_var("AMBIENT_FRONTIER_MODEL");
        std::env::remove_var("MAESTRO_AMBIENT_LLM_API");
        let mut cascader = Cascader::new(None);

        let documentation = cascader.route(
            &task(TaskType::Document),
            &TaskContext {
                complexity: Complexity::Trivial,
                task_type: TaskType::Document,
                estimated_tokens: Some(2_000),
                previous_attempts: 0,
            },
        );
        let security = cascader.route(
            &task(TaskType::Security),
            &TaskContext {
                complexity: Complexity::High,
                task_type: TaskType::Security,
                estimated_tokens: Some(20_000),
                previous_attempts: 0,
            },
        );

        assert_eq!(documentation.tier.name, "frontier");
        assert_eq!(documentation.model, DEFAULT_OPENROUTER_FRONTIER_MODEL);
        assert_eq!(security.tier.name, "frontier");
        assert_eq!(security.model, DEFAULT_OPENROUTER_FRONTIER_MODEL);
    }

    #[test]
    fn anthropic_api_default_uses_native_anthropic_model_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("MAESTRO_AMBIENT_FRONTIER_MODEL");
        std::env::remove_var("AMBIENT_FRONTIER_MODEL");
        std::env::set_var("MAESTRO_AMBIENT_LLM_API", "anthropic");

        let mut cascader = Cascader::new(None);
        let routed = cascader.route(
            &task(TaskType::Implement),
            &TaskContext {
                complexity: Complexity::High,
                task_type: TaskType::Implement,
                estimated_tokens: Some(4_000),
                previous_attempts: 0,
            },
        );

        assert_eq!(routed.tier.name, "frontier");
        assert_eq!(routed.model, DEFAULT_ANTHROPIC_FRONTIER_MODEL);
        std::env::remove_var("MAESTRO_AMBIENT_LLM_API");
    }

    #[test]
    fn non_fallback_path_uses_configured_default_tier() {
        let mut cascader = Cascader::new(Some(CascaderConfig {
            tiers: vec![ModelTier {
                name: "frontier".to_string(),
                model: "test-frontier".to_string(),
                cost_per_1k_input: 0.001,
                cost_per_1k_output: 0.002,
                capabilities: vec!["doc-update".to_string()],
                max_complexity: Complexity::Trivial,
            }],
            fallback_to_higher: false,
            max_retries: 0,
        }));

        let routed = cascader.route(
            &task(TaskType::Security),
            &TaskContext {
                complexity: Complexity::High,
                task_type: TaskType::Security,
                estimated_tokens: Some(4_000),
                previous_attempts: 0,
            },
        );

        assert_eq!(routed.tier.name, "frontier");
        assert_eq!(routed.model, "test-frontier");
        assert_eq!(routed.reason, "Default to configured frontier tier");
    }
}

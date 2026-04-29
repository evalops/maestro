//! Task run accounting for daemon plan execution.

use crate::{cascader::TaskContext, learner::LearnerOutcome, text::one_line, types::*};
use chrono::Utc;

#[derive(Debug, Clone)]
pub(crate) struct PlanRunContext {
    task_id: String,
    event_type: EventType,
    task_type: TaskType,
    complexity: Complexity,
    labels: Vec<String>,
    repo: String,
}

impl PlanRunContext {
    pub(crate) fn from_plan(event: &NormalizedEvent, plan: &TaskPlan) -> Self {
        Self {
            task_id: plan.task_id.clone(),
            event_type: event.event_type,
            task_type: Self::main_task_type(plan),
            complexity: plan.estimated_complexity,
            labels: event.labels.clone(),
            repo: event.repository.clone(),
        }
    }

    pub(crate) fn main_task_type(plan: &TaskPlan) -> TaskType {
        plan.tasks
            .first()
            .map(|task| task.task_type)
            .unwrap_or(TaskType::Fix)
    }

    pub(crate) fn route_task(&self, event: &NormalizedEvent, plan: &TaskPlan) -> Task {
        Task {
            id: self.task_id.clone(),
            task_type: self.task_type,
            prompt: format!(
                "{}\n\n{}",
                event.title,
                event.body.as_deref().unwrap_or_default()
            ),
            files: plan.files.clone(),
            depends_on: vec![],
            priority: event.priority,
            estimated_tokens: None,
        }
    }

    pub(crate) fn task_context(&self) -> TaskContext {
        TaskContext {
            complexity: self.complexity,
            task_type: self.task_type,
            estimated_tokens: None,
            previous_attempts: 0,
        }
    }

    pub(crate) fn learner_outcome(
        &self,
        model_used: &str,
        duration_secs: u64,
        outcome: &PlanRunOutcome,
    ) -> LearnerOutcome {
        LearnerOutcome {
            task_id: self.task_id.clone(),
            event_type: self.event_type,
            task_type: self.task_type,
            complexity: self.complexity,
            model_used: model_used.to_string(),
            success: outcome.success,
            confidence_predicted: outcome.confidence_predicted,
            tokens_used: outcome.costs.tokens_used,
            estimated_cost_usd: outcome.costs.estimated_cost_usd,
            cost_usd: outcome.costs.actual_cost_usd,
            duration_secs,
            failure_reason: outcome.failure_reason.clone(),
            labels: self.labels.clone(),
            repo: self.repo.clone(),
            timestamp: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CostAccounting {
    pub(crate) estimated_cost_usd: f64,
    pub(crate) actual_cost_usd: f64,
    pub(crate) tokens_used: u64,
}

impl CostAccounting {
    pub(crate) fn estimated_only(estimated_cost_usd: f64) -> Self {
        Self {
            estimated_cost_usd,
            actual_cost_usd: 0.0,
            tokens_used: 0,
        }
    }

    pub(crate) fn estimate_as_actual(estimated_cost_usd: f64, tokens_used: u64) -> Self {
        Self {
            estimated_cost_usd,
            actual_cost_usd: estimated_cost_usd,
            tokens_used,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlanRunOutcome {
    pub(crate) success: bool,
    pub(crate) confidence_predicted: f64,
    pub(crate) failure_reason: Option<String>,
    pub(crate) costs: CostAccounting,
}

impl PlanRunOutcome {
    pub(crate) fn cost_limited(failure_reason: String, costs: CostAccounting) -> Self {
        Self {
            success: false,
            confidence_predicted: 0.0,
            failure_reason: Some(failure_reason),
            costs,
        }
    }

    pub(crate) fn from_execution(
        result: &ExecutionResult,
        critique: &CriticResult,
        costs: CostAccounting,
    ) -> Self {
        let success = critique.approved && result.status == ExecutionStatus::Success;
        Self {
            success,
            confidence_predicted: critique.confidence,
            failure_reason: if success {
                None
            } else {
                result
                    .error
                    .clone()
                    .or_else(|| execution_failure_reason(result, critique))
            },
            costs,
        }
    }
}

fn execution_failure_reason(result: &ExecutionResult, critique: &CriticResult) -> Option<String> {
    if result.status != ExecutionStatus::Success {
        return Some(format!("execution ended with status {:?}", result.status));
    }

    if critique.approved {
        return None;
    }

    let critic_context = critique
        .issues
        .iter()
        .max_by_key(|issue| issue_severity_rank(issue.severity))
        .map(|issue| {
            let location = issue
                .location
                .as_deref()
                .map(|location| format!(" at {location}"))
                .unwrap_or_default();
            format!(
                "{:?}/{:?}{location}: {}",
                issue.severity,
                issue.issue_type,
                one_line(&issue.description)
            )
        })
        .unwrap_or_else(|| format!("confidence {:.0}%", critique.confidence * 100.0));

    Some(format!("critic rejected: {critic_context}"))
}

fn issue_severity_rank(severity: CriticIssueSeverity) -> u8 {
    match severity {
        CriticIssueSeverity::Blocker => 3,
        CriticIssueSeverity::Warning => 2,
        CriticIssueSeverity::Info => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::collections::HashMap;

    fn event() -> NormalizedEvent {
        let repo = Repository {
            owner: "evalops".to_string(),
            name: "maestro".to_string(),
            full_name: "evalops/maestro".to_string(),
            default_branch: "main".to_string(),
            path: "/tmp/maestro".to_string(),
            url: "https://github.com/evalops/maestro".to_string(),
            config: None,
            agent_md: None,
            test_coverage: None,
            codeowners: vec![],
        };

        NormalizedEvent {
            id: "evt".to_string(),
            source: WatcherType::GitHubPoll,
            event_type: EventType::Issue,
            repo: repo.clone(),
            repository: repo.full_name.clone(),
            priority: 42,
            title: "Fix route".to_string(),
            body: Some("Body".to_string()),
            labels: vec!["bug".to_string()],
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: None,
                body: None,
                number: None,
                labels: vec![],
                author: None,
                url: None,
                extra: HashMap::new(),
            },
            created_at: Utc::now(),
            processed_at: None,
            status: EventStatus::Pending,
            flags: EventFlags::default(),
        }
    }

    fn plan(tasks: Vec<Task>) -> TaskPlan {
        TaskPlan {
            task_id: "task-1".to_string(),
            summary: "Fix route".to_string(),
            estimated_complexity: Complexity::Medium,
            event: event(),
            strategy: ExecutionStrategy::Solo,
            tasks,
            estimated_duration_ms: 60_000,
            files: vec!["src/lib.rs".to_string()],
            risks: vec![],
        }
    }

    #[test]
    fn main_task_type_falls_back_to_fix_for_empty_plans() {
        let plan = plan(vec![]);
        assert_eq!(PlanRunContext::main_task_type(&plan), TaskType::Fix);
    }

    #[test]
    fn route_task_uses_plan_files_and_event_prompt() {
        let event = event();
        let plan = plan(vec![Task {
            id: "inner".to_string(),
            task_type: TaskType::Refactor,
            prompt: "unused".to_string(),
            files: vec![],
            depends_on: vec![],
            priority: 1,
            estimated_tokens: None,
        }]);
        let context = PlanRunContext::from_plan(&event, &plan);

        let task = context.route_task(&event, &plan);

        assert_eq!(task.task_type, TaskType::Refactor);
        assert_eq!(task.files, vec!["src/lib.rs"]);
        assert!(task.prompt.contains("Fix route"));
        assert!(task.prompt.contains("Body"));
    }

    #[test]
    fn cost_limited_outcome_keeps_estimate_separate_from_actual_spend() {
        let outcome = PlanRunOutcome::cost_limited(
            "too expensive".to_string(),
            CostAccounting::estimated_only(0.5),
        );

        assert!(!outcome.success);
        assert_eq!(outcome.costs.estimated_cost_usd, 0.5);
        assert_eq!(outcome.costs.actual_cost_usd, 0.0);
    }

    #[test]
    fn execution_outcome_requires_critic_approval_and_execution_success() {
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
            CostAccounting::estimate_as_actual(0.2, 0),
        );

        assert!(!outcome.success);
        assert_eq!(outcome.failure_reason.as_deref(), Some("executor failed"));
    }

    #[test]
    fn execution_outcome_records_critic_rejection_reason() {
        let result = ExecutionResult {
            status: ExecutionStatus::Success,
            changes: vec![],
            test_results: vec![],
            error: None,
            logs: vec![],
        };
        let critique = CriticResult {
            approved: false,
            confidence: 0.55,
            issues: vec![CriticIssue {
                severity: CriticIssueSeverity::Blocker,
                issue_type: CriticIssueType::Security,
                location: Some("src/auth.rs".to_string()),
                description: "Hardcoded token detected.\nRemove it.".to_string(),
            }],
            suggestions: vec![],
        };

        let outcome = PlanRunOutcome::from_execution(
            &result,
            &critique,
            CostAccounting::estimate_as_actual(0.2, 0),
        );

        assert!(!outcome.success);
        assert_eq!(
            outcome.failure_reason.as_deref(),
            Some("critic rejected: Blocker/Security at src/auth.rs: Hardcoded token detected. Remove it.")
        );
    }

    #[test]
    fn execution_outcome_prefers_highest_severity_critic_issue() {
        let result = ExecutionResult {
            status: ExecutionStatus::Success,
            changes: vec![],
            test_results: vec![],
            error: None,
            logs: vec![],
        };
        let critique = CriticResult {
            approved: false,
            confidence: 0.45,
            issues: vec![
                CriticIssue {
                    severity: CriticIssueSeverity::Warning,
                    issue_type: CriticIssueType::Style,
                    location: Some("src/style.rs".to_string()),
                    description: "Remove debug logging.".to_string(),
                },
                CriticIssue {
                    severity: CriticIssueSeverity::Blocker,
                    issue_type: CriticIssueType::Correctness,
                    location: Some("src/lib.rs".to_string()),
                    description: "Tests still fail.".to_string(),
                },
            ],
            suggestions: vec![],
        };

        let outcome = PlanRunOutcome::from_execution(
            &result,
            &critique,
            CostAccounting::estimate_as_actual(0.2, 0),
        );

        assert!(!outcome.success);
        assert_eq!(
            outcome.failure_reason.as_deref(),
            Some("critic rejected: Blocker/Correctness at src/lib.rs: Tests still fail.")
        );
    }

    #[test]
    fn execution_outcome_records_non_success_status_without_error() {
        let result = ExecutionResult {
            status: ExecutionStatus::Partial,
            changes: vec![],
            test_results: vec![],
            error: None,
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
            CostAccounting::estimate_as_actual(0.2, 0),
        );

        assert!(!outcome.success);
        assert_eq!(
            outcome.failure_reason.as_deref(),
            Some("execution ended with status Partial")
        );
    }

    #[test]
    fn learner_outcome_preserves_run_accounting() {
        let event = event();
        let plan = plan(vec![]);
        let context = PlanRunContext::from_plan(&event, &plan);
        let run_outcome = PlanRunOutcome::cost_limited(
            "too expensive".to_string(),
            CostAccounting::estimated_only(0.5),
        );

        let learner_outcome = context.learner_outcome("model-a", 7, &run_outcome);

        assert_eq!(learner_outcome.task_id, "task-1");
        assert_eq!(learner_outcome.model_used, "model-a");
        assert_eq!(learner_outcome.duration_secs, 7);
        assert_eq!(learner_outcome.estimated_cost_usd, 0.5);
        assert_eq!(learner_outcome.cost_usd, 0.0);
        assert_eq!(learner_outcome.labels, vec!["bug"]);
    }
}

//! Execution report rendering for ambient pull requests.

use crate::types::*;

pub(crate) struct ExecutionReport<'a> {
    event: &'a NormalizedEvent,
    plan: &'a TaskPlan,
    result: &'a ExecutionResult,
    critique: &'a CriticResult,
}

impl<'a> ExecutionReport<'a> {
    pub(crate) fn new(
        event: &'a NormalizedEvent,
        plan: &'a TaskPlan,
        result: &'a ExecutionResult,
        critique: &'a CriticResult,
    ) -> Self {
        Self {
            event,
            plan,
            result,
            critique,
        }
    }

    pub(crate) fn render_markdown(&self) -> String {
        let mut body = String::new();

        self.push_summary(&mut body);
        self.push_source(&mut body);
        self.push_changes(&mut body);
        self.push_validation(&mut body);
        self.push_quality_assessment(&mut body);
        self.push_follow_ups(&mut body);

        body.trim_end().to_string()
    }

    fn push_summary(&self, body: &mut String) {
        body.push_str("## Summary\n\n");
        body.push_str(&self.plan.summary);
        body.push_str("\n\n");
    }

    fn push_source(&self, body: &mut String) {
        body.push_str("## Source\n\n");

        if let Some(url) = self.event.payload.url.as_deref() {
            body.push_str(&format!("- Event: {url}\n"));
        } else if let Some(number) = self.event.payload.number {
            body.push_str(&format!("- Event: #{}\n", number));
        } else {
            body.push_str(&format!("- Event: `{}`\n", inline_code(&self.event.id)));
        }

        body.push_str(&format!(
            "- Repository: `{}`\n",
            inline_code(&self.event.repository)
        ));
        body.push_str(&format!("- Event type: `{:?}`\n\n", self.event.event_type));
    }

    fn push_changes(&self, body: &mut String) {
        body.push_str("## Changes\n\n");

        if self.result.changes.is_empty() {
            body.push_str("- No file changes were reported.\n\n");
            return;
        }

        for change in &self.result.changes {
            body.push_str(&format!(
                "- `{}`: {} (+{}, -{})\n",
                inline_code(&change.file),
                change_summary(change),
                change.additions,
                change.deletions
            ));
        }
        body.push('\n');
    }

    fn push_validation(&self, body: &mut String) {
        body.push_str("## Validation\n\n");
        body.push_str(&format!("- Execution status: `{:?}`\n", self.result.status));

        if self.result.test_results.is_empty() {
            body.push_str("- No test results were reported.\n\n");
            return;
        }

        for test in &self.result.test_results {
            let status = if test.passed { "pass" } else { "fail" };
            body.push_str(&format!(
                "- {}: `{}` ({} ms)",
                status,
                inline_code(&test.name),
                test.duration_ms
            ));
            if let Some(error) = test.error.as_deref() {
                body.push_str(&format!(" - {}", one_line(error)));
            }
            body.push('\n');
        }
        body.push('\n');
    }

    fn push_quality_assessment(&self, body: &mut String) {
        body.push_str("## Quality Assessment\n\n");
        body.push_str(&format!(
            "- Approved: `{}`\n- Confidence: `{:.0}%`\n",
            self.critique.approved,
            self.critique.confidence * 100.0
        ));

        if self.critique.issues.is_empty() {
            body.push_str("- Critic issues: none\n\n");
            return;
        }

        body.push_str("- Critic issues:\n");
        for issue in &self.critique.issues {
            let location = issue
                .location
                .as_deref()
                .map(|value| format!(" at `{}`", inline_code(value)))
                .unwrap_or_default();
            body.push_str(&format!(
                "  - {:?}/{:?}{}: {}\n",
                issue.severity,
                issue.issue_type,
                location,
                one_line(&issue.description)
            ));
        }
        body.push('\n');
    }

    fn push_follow_ups(&self, body: &mut String) {
        if self.critique.suggestions.is_empty() {
            return;
        }

        body.push_str("## Follow-up Suggestions\n\n");
        for suggestion in &self.critique.suggestions {
            body.push_str(&format!("- {}\n", one_line(suggestion)));
        }
        body.push('\n');
    }
}

fn change_summary(change: &FileChange) -> String {
    match change.change_type {
        ChangeType::Create => "created".to_string(),
        ChangeType::Modify => "modified".to_string(),
        ChangeType::Delete => "deleted".to_string(),
        ChangeType::Rename => change
            .old_path
            .as_deref()
            .map(|old_path| format!("renamed from `{}`", inline_code(old_path)))
            .unwrap_or_else(|| "renamed".to_string()),
    }
}

fn inline_code(value: &str) -> String {
    value.replace('`', "\\`")
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
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
            id: "evt-1".to_string(),
            source: WatcherType::GitHubWebhook,
            event_type: EventType::IssueCreated,
            repo: repo.clone(),
            repository: repo.full_name.clone(),
            priority: 60,
            title: "Fix report".to_string(),
            body: Some("Report body".to_string()),
            labels: vec!["ambient-agent".to_string()],
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: Some("Fix report".to_string()),
                body: Some("Report body".to_string()),
                number: Some(123),
                labels: vec!["ambient-agent".to_string()],
                author: Some("octocat".to_string()),
                url: Some("https://github.com/evalops/maestro/issues/123".to_string()),
                extra: HashMap::new(),
            },
            created_at: Utc::now(),
            processed_at: None,
            status: EventStatus::Pending,
            flags: EventFlags::default(),
        }
    }

    fn plan() -> TaskPlan {
        TaskPlan {
            task_id: "plan-1".to_string(),
            summary: "Tighten execution report rendering".to_string(),
            estimated_complexity: Complexity::Medium,
            event: event(),
            strategy: ExecutionStrategy::Solo,
            tasks: vec![],
            estimated_duration_ms: 60_000,
            files: vec!["src/daemon.rs".to_string()],
            risks: vec![],
        }
    }

    fn result() -> ExecutionResult {
        ExecutionResult {
            status: ExecutionStatus::Success,
            changes: vec![FileChange {
                file: "src/report.rs".to_string(),
                change_type: ChangeType::Modify,
                old_path: None,
                additions: 12,
                deletions: 3,
                content: None,
            }],
            test_results: vec![TestResult {
                name: "cargo test".to_string(),
                passed: true,
                duration_ms: 1250,
                error: None,
            }],
            error: None,
            logs: vec![],
        }
    }

    fn critique() -> CriticResult {
        CriticResult {
            approved: true,
            confidence: 0.91,
            issues: vec![],
            suggestions: vec!["Watch for reviewer confusion in follow-up runs.".to_string()],
        }
    }

    #[test]
    fn renders_source_changes_validation_and_quality_from_execution_data() {
        let event = event();
        let plan = plan();
        let result = result();
        let critique = critique();

        let body = ExecutionReport::new(&event, &plan, &result, &critique).render_markdown();

        assert!(body.contains("## Source"));
        assert!(body.contains("https://github.com/evalops/maestro/issues/123"));
        assert!(body.contains("- `src/report.rs`: modified (+12, -3)"));
        assert!(body.contains("- Execution status: `Success`"));
        assert!(body.contains("- pass: `cargo test` (1250 ms)"));
        assert!(body.contains("- Approved: `true`"));
        assert!(body.contains("- Confidence: `91%`"));
        assert!(body.contains("## Follow-up Suggestions"));
    }

    #[test]
    fn renders_absent_changes_and_tests_explicitly() {
        let event = event();
        let plan = plan();
        let result = ExecutionResult {
            changes: vec![],
            test_results: vec![],
            ..result()
        };
        let critique = CriticResult {
            issues: vec![CriticIssue {
                severity: CriticIssueSeverity::Warning,
                issue_type: CriticIssueType::Correctness,
                location: Some("src/lib.rs".to_string()),
                description: "Double check behavior.\nLine two.".to_string(),
            }],
            suggestions: vec![],
            ..critique()
        };

        let body = ExecutionReport::new(&event, &plan, &result, &critique).render_markdown();

        assert!(body.contains("- No file changes were reported."));
        assert!(body.contains("- No test results were reported."));
        assert!(
            body.contains("Warning/Correctness at `src/lib.rs`: Double check behavior. Line two.")
        );
        assert!(!body.contains("## Follow-up Suggestions"));
    }

    #[test]
    fn renders_rename_provenance_when_available() {
        let event = event();
        let plan = plan();
        let result = ExecutionResult {
            changes: vec![FileChange {
                file: "src/new.rs".to_string(),
                change_type: ChangeType::Rename,
                old_path: Some("src/old.rs".to_string()),
                additions: 2,
                deletions: 1,
                content: None,
            }],
            ..result()
        };
        let critique = critique();

        let body = ExecutionReport::new(&event, &plan, &result, &critique).render_markdown();

        assert!(body.contains("- `src/new.rs`: renamed from `src/old.rs` (+2, -1)"));
    }
}

//! Critic (LLM-as-Judge)
//!
//! Evaluates agent outputs before committing. Uses a separate LLM call
//! to review changes and catch errors the executor might have missed.

use crate::types::*;
use regex::Regex;
use std::sync::LazyLock;

/// Configuration for the Critic
#[derive(Debug, Clone)]
pub struct CriticConfig {
    pub model: String,
    pub approval_threshold: f64,
    pub max_warnings: usize,
    pub security_checks: bool,
    pub style_checks: bool,
    pub performance_checks: bool,
}

impl Default for CriticConfig {
    fn default() -> Self {
        Self {
            model: "claude-opus-4-20250115".to_string(),
            approval_threshold: 0.7,
            max_warnings: 5,
            security_checks: true,
            style_checks: true,
            performance_checks: true,
        }
    }
}

/// Security patterns to detect
static SECURITY_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"eval\s*\(").unwrap(),
            "Use of eval() is dangerous",
        ),
        (
            Regex::new(r"innerHTML\s*=").unwrap(),
            "innerHTML can lead to XSS",
        ),
        (
            Regex::new(r"dangerouslySetInnerHTML").unwrap(),
            "dangerouslySetInnerHTML can lead to XSS",
        ),
        (
            Regex::new(r"exec\s*\(").unwrap(),
            "Potential command injection via exec()",
        ),
        (
            Regex::new(r#"password\s*[:=]\s*['"][^'"]+['"]"#).unwrap(),
            "Hardcoded password detected",
        ),
        (
            Regex::new(r#"(?i)api[_-]?key\s*[:=]\s*['"][^'"]+['"]"#).unwrap(),
            "Hardcoded API key detected",
        ),
    ]
});

/// Performance patterns to detect
static PERFORMANCE_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"\.map\([^)]+\)\.filter\(").unwrap(),
            "Consider combining map and filter",
        ),
        (
            Regex::new(r"for\s*\([^)]+\)\s*\{[^}]*await").unwrap(),
            "Sequential await in loop - consider Promise.all",
        ),
        (
            Regex::new(r"JSON\.parse\(JSON\.stringify").unwrap(),
            "Expensive deep clone",
        ),
    ]
});

/// Style patterns to detect
static STYLE_PATTERNS: LazyLock<StylePatterns> = LazyLock::new(|| StylePatterns {
    console_log: Regex::new(r"console\.(log|debug|info)\(").unwrap(),
    todo_comment: Regex::new(r"//\s*(TODO|FIXME|HACK|XXX)").unwrap(),
    any_type: Regex::new(r":\s*any\b").unwrap(),
});

/// Style patterns container
struct StylePatterns {
    console_log: Regex,
    todo_comment: Regex,
    any_type: Regex,
}

/// Critic evaluates agent outputs
pub struct Critic {
    config: CriticConfig,
}

impl Critic {
    /// Create a new Critic
    pub fn new(config: CriticConfig) -> Self {
        Self { config }
    }

    /// Critique an execution result
    pub async fn critique(&self, plan: &TaskPlan, result: &ExecutionResult) -> CriticResult {
        let mut issues = vec![];
        let suggestions = vec![];

        // Run static analysis
        for change in &result.changes {
            if let Some(ref content) = change.content {
                issues.extend(self.check_security(content, &change.file));
                issues.extend(self.check_performance(content, &change.file));
                issues.extend(self.check_style(content, &change.file));
            }
        }

        // Check test results
        issues.extend(self.check_tests(&result.test_results));

        // Check for obvious mismatches
        issues.extend(self.check_request_match(plan, result));

        self.enforce_warning_budget(&mut issues);

        // Calculate confidence
        let confidence = self.calculate_confidence(&issues);
        let has_blockers = issues
            .iter()
            .any(|i| i.severity == CriticIssueSeverity::Blocker);
        let approved = !has_blockers && confidence >= self.config.approval_threshold;

        CriticResult {
            approved,
            confidence,
            issues,
            suggestions,
        }
    }

    /// Check for security issues
    fn check_security(&self, content: &str, file: &str) -> Vec<CriticIssue> {
        if !self.config.security_checks {
            return vec![];
        }

        let mut issues = vec![];
        for (pattern, message) in SECURITY_PATTERNS.iter() {
            if pattern.is_match(content) {
                issues.push(CriticIssue {
                    severity: CriticIssueSeverity::Blocker,
                    issue_type: CriticIssueType::Security,
                    location: Some(file.to_string()),
                    description: message.to_string(),
                });
            }
        }
        issues
    }

    /// Check for performance issues
    fn check_performance(&self, content: &str, file: &str) -> Vec<CriticIssue> {
        if !self.config.performance_checks {
            return vec![];
        }

        let mut issues = vec![];
        for (pattern, message) in PERFORMANCE_PATTERNS.iter() {
            if pattern.is_match(content) {
                issues.push(CriticIssue {
                    severity: CriticIssueSeverity::Warning,
                    issue_type: CriticIssueType::Performance,
                    location: Some(file.to_string()),
                    description: message.to_string(),
                });
            }
        }
        issues
    }

    /// Check for style issues
    fn check_style(&self, content: &str, file: &str) -> Vec<CriticIssue> {
        if !self.config.style_checks {
            return vec![];
        }

        let mut issues = vec![];

        // Check for console.log (using static pattern)
        if STYLE_PATTERNS.console_log.is_match(content) {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Warning,
                issue_type: CriticIssueType::Style,
                location: Some(file.to_string()),
                description: "Console logging statements should be removed".to_string(),
            });
        }

        // Check for TODO/FIXME (using static pattern)
        if STYLE_PATTERNS.todo_comment.is_match(content) {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Info,
                issue_type: CriticIssueType::Style,
                location: Some(file.to_string()),
                description: "Contains TODO/FIXME comments".to_string(),
            });
        }

        // Check for 'any' type in TypeScript (using static pattern)
        if file.ends_with(".ts") && STYLE_PATTERNS.any_type.is_match(content) {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Warning,
                issue_type: CriticIssueType::Style,
                location: Some(file.to_string()),
                description: "Avoid using 'any' type".to_string(),
            });
        }

        issues
    }

    /// Check test results
    fn check_tests(&self, test_results: &[TestResult]) -> Vec<CriticIssue> {
        let mut issues = vec![];

        if test_results.is_empty() {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Warning,
                issue_type: CriticIssueType::Correctness,
                location: None,
                description: "No test results provided".to_string(),
            });
            return issues;
        }

        let failed: Vec<_> = test_results.iter().filter(|t| !t.passed).collect();
        if !failed.is_empty() {
            let names: Vec<_> = failed.iter().map(|t| t.name.as_str()).collect();
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Blocker,
                issue_type: CriticIssueType::Correctness,
                location: None,
                description: format!("{} test(s) failed: {}", failed.len(), names.join(", ")),
            });
        }

        issues
    }

    /// Check if implementation matches request
    fn check_request_match(&self, _plan: &TaskPlan, result: &ExecutionResult) -> Vec<CriticIssue> {
        let mut issues = vec![];

        if result.changes.is_empty() {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Blocker,
                issue_type: CriticIssueType::Correctness,
                location: None,
                description: "No files were changed - implementation appears incomplete"
                    .to_string(),
            });
        }

        if result.status == ExecutionStatus::Failed {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Blocker,
                issue_type: CriticIssueType::Correctness,
                location: None,
                description: format!(
                    "Execution failed: {}",
                    result.error.as_deref().unwrap_or("Unknown error")
                ),
            });
        }

        if result.status == ExecutionStatus::Partial {
            issues.push(CriticIssue {
                severity: CriticIssueSeverity::Warning,
                issue_type: CriticIssueType::Correctness,
                location: None,
                description: "Execution only partially completed".to_string(),
            });
        }

        issues
    }

    /// Calculate confidence based on issues
    fn calculate_confidence(&self, issues: &[CriticIssue]) -> f64 {
        let mut confidence: f64 = 1.0;

        for issue in issues {
            match issue.severity {
                CriticIssueSeverity::Blocker => confidence -= 0.5,
                CriticIssueSeverity::Warning => confidence -= 0.1,
                CriticIssueSeverity::Info => confidence -= 0.02,
            }
        }

        confidence.max(0.0)
    }

    fn enforce_warning_budget(&self, issues: &mut Vec<CriticIssue>) {
        let warning_count = issues
            .iter()
            .filter(|issue| issue.severity == CriticIssueSeverity::Warning)
            .count();

        if warning_count <= self.config.max_warnings {
            return;
        }

        issues.push(CriticIssue {
            severity: CriticIssueSeverity::Blocker,
            issue_type: CriticIssueType::Correctness,
            location: None,
            description: format!(
                "Warning budget exceeded: {warning_count} warning(s) found, maximum allowed is {}",
                self.config.max_warnings
            ),
        });
    }

    /// Quick check without full evaluation
    pub fn quick_check(&self, changes: &[FileChange]) -> Vec<CriticIssue> {
        let mut issues = vec![];
        for change in changes {
            if let Some(ref content) = change.content {
                issues.extend(self.check_security(content, &change.file));
            }
        }
        issues
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
            priority: 10,
            title: "Tighten ambient critic".to_string(),
            body: Some("Keep warning gates deterministic".to_string()),
            labels: vec!["ambient".to_string()],
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: Some("Tighten ambient critic".to_string()),
                body: Some("Keep warning gates deterministic".to_string()),
                number: Some(42),
                labels: vec!["ambient".to_string()],
                author: Some("octocat".to_string()),
                url: None,
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
            summary: "Tighten ambient critic".to_string(),
            estimated_complexity: Complexity::Simple,
            event: event(),
            strategy: ExecutionStrategy::Solo,
            tasks: vec![],
            estimated_duration_ms: 60_000,
            files: vec!["src/app.ts".to_string()],
            risks: vec![],
        }
    }

    fn result_with_content(content: &str) -> ExecutionResult {
        ExecutionResult {
            status: ExecutionStatus::Success,
            changes: vec![FileChange {
                file: "src/app.ts".to_string(),
                change_type: ChangeType::Modify,
                content: Some(content.to_string()),
                old_path: None,
                additions: 1,
                deletions: 0,
            }],
            test_results: vec![TestResult {
                name: "cargo test".to_string(),
                passed: true,
                duration_ms: 1200,
                error: None,
            }],
            error: None,
            logs: vec![],
        }
    }

    #[tokio::test]
    async fn critique_approves_when_warnings_are_at_budget() {
        let critic = Critic::new(CriticConfig {
            max_warnings: 1,
            ..CriticConfig::default()
        });

        let critique = critic
            .critique(&plan(), &result_with_content("console.log('debug');"))
            .await;

        assert!(critique.approved);
        assert_eq!(
            critique
                .issues
                .iter()
                .filter(|issue| issue.severity == CriticIssueSeverity::Warning)
                .count(),
            1
        );
        assert!(!critique
            .issues
            .iter()
            .any(|issue| issue.description.contains("Warning budget exceeded")));
    }

    #[tokio::test]
    async fn critique_rejects_when_warnings_exceed_budget() {
        let critic = Critic::new(CriticConfig {
            max_warnings: 1,
            ..CriticConfig::default()
        });

        let critique = critic
            .critique(
                &plan(),
                &result_with_content("const payload: any = value;\nconsole.log(payload);"),
            )
            .await;

        assert!(!critique.approved);
        assert!(critique.issues.iter().any(|issue| {
            issue.severity == CriticIssueSeverity::Blocker
                && issue
                    .description
                    .contains("Warning budget exceeded: 2 warning(s) found")
        }));
    }
}

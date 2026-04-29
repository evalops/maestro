//! File permission evaluation for executor writes.
//!
//! Inspired by the explicit allow/ask/deny permission shape used by Codex
//! exec-policy and opencode permissions. Ambient execution is non-interactive,
//! so both Ask and Deny stop the write; keeping the distinction lets future
//! approval plumbing surface "ask" without changing executor call sites.

use glob::Pattern;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilePermissionDecision {
    Allow,
    Ask,
    Deny,
}

impl FilePermissionDecision {
    pub fn is_blocking(self) -> bool {
        !matches!(self, Self::Allow)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePermissionRule {
    pub pattern: String,
    pub decision: FilePermissionDecision,
    pub reason: Option<String>,
}

impl FilePermissionRule {
    pub fn new(pattern: impl Into<String>, decision: FilePermissionDecision) -> Self {
        Self {
            pattern: pattern.into(),
            decision,
            reason: None,
        }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePermissionEvaluation {
    pub decision: FilePermissionDecision,
    pub matched_pattern: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePermissionPolicyError {
    pub pattern: String,
    pub message: String,
}

impl fmt::Display for FilePermissionPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid file permission glob '{}': {}",
            self.pattern, self.message
        )
    }
}

impl std::error::Error for FilePermissionPolicyError {}

#[derive(Debug, Clone)]
pub struct FilePermissionPolicy {
    rules: Vec<FilePermissionRule>,
    validation_error: Option<FilePermissionPolicyError>,
}

impl FilePermissionPolicy {
    pub fn new(rules: Vec<FilePermissionRule>) -> Self {
        match Self::try_new(rules) {
            Ok(policy) => policy,
            Err(error) => Self {
                rules: vec![],
                validation_error: Some(error),
            },
        }
    }

    pub fn try_new(rules: Vec<FilePermissionRule>) -> Result<Self, FilePermissionPolicyError> {
        for rule in &rules {
            Pattern::new(&rule.pattern).map_err(|error| FilePermissionPolicyError {
                pattern: rule.pattern.clone(),
                message: error.to_string(),
            })?;
        }

        Ok(Self {
            rules,
            validation_error: None,
        })
    }

    pub fn default_write_policy() -> Self {
        Self::new(DEFAULT_WRITE_RULES.clone())
    }

    pub fn validation_error(&self) -> Option<&FilePermissionPolicyError> {
        self.validation_error.as_ref()
    }

    pub fn evaluate(&self, path: &str) -> FilePermissionEvaluation {
        if let Some(error) = &self.validation_error {
            return FilePermissionEvaluation {
                decision: FilePermissionDecision::Deny,
                matched_pattern: Some(error.pattern.clone()),
                reason: Some(error.to_string()),
            };
        }

        let normalized = normalize_path(path);
        let matched = self.rules.iter().rev().find(|rule| {
            Pattern::new(&rule.pattern)
                .map(|pattern| pattern.matches(&normalized))
                .unwrap_or(false)
        });

        match matched {
            Some(rule) => FilePermissionEvaluation {
                decision: rule.decision,
                matched_pattern: Some(rule.pattern.clone()),
                reason: rule.reason.clone(),
            },
            None => FilePermissionEvaluation {
                decision: FilePermissionDecision::Ask,
                matched_pattern: None,
                reason: Some("no file permission rule matched".to_string()),
            },
        }
    }
}

impl Default for FilePermissionPolicy {
    fn default() -> Self {
        Self::default_write_policy()
    }
}

static DEFAULT_WRITE_RULES: LazyLock<Vec<FilePermissionRule>> = LazyLock::new(|| {
    use FilePermissionDecision::{Allow, Deny};

    vec![
        FilePermissionRule::new("*", Allow),
        FilePermissionRule::new(".git/**", Deny).with_reason("git internals are protected"),
        FilePermissionRule::new(".env*", Deny).with_reason("environment files are protected"),
        FilePermissionRule::new("**/.env*", Deny).with_reason("environment files are protected"),
        FilePermissionRule::new("*credentials*", Deny)
            .with_reason("credential files are protected"),
        FilePermissionRule::new("*secret.*", Deny).with_reason("secret files are protected"),
        FilePermissionRule::new("*secrets.*", Deny).with_reason("secret files are protected"),
        FilePermissionRule::new("*.pem", Deny).with_reason("private key material is protected"),
        FilePermissionRule::new("*.key", Deny).with_reason("private key material is protected"),
        FilePermissionRule::new("*id_rsa*", Deny).with_reason("ssh key material is protected"),
        FilePermissionRule::new(".ssh/**", Deny).with_reason("ssh configuration is protected"),
        FilePermissionRule::new("**/.ssh/**", Deny).with_reason("ssh configuration is protected"),
        FilePermissionRule::new("node_modules/**", Deny)
            .with_reason("dependency install output is protected"),
        FilePermissionRule::new("**/node_modules/**", Deny)
            .with_reason("dependency install output is protected"),
        FilePermissionRule::new("vendor/**", Deny)
            .with_reason("vendored dependencies are protected"),
        FilePermissionRule::new("**/vendor/**", Deny)
            .with_reason("vendored dependencies are protected"),
    ]
});

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_allows_normal_source_files() {
        let policy = FilePermissionPolicy::default_write_policy();

        let evaluation = policy.evaluate("src/main.rs");

        assert_eq!(evaluation.decision, FilePermissionDecision::Allow);
        assert_eq!(evaluation.matched_pattern.as_deref(), Some("*"));

        for path in ["src/secret_manager.rs", "docs/secrets-handling.md"] {
            assert_eq!(
                policy.evaluate(path).decision,
                FilePermissionDecision::Allow,
                "{path} should not be treated as secret material"
            );
        }
    }

    #[test]
    fn default_policy_denies_protected_paths() {
        let policy = FilePermissionPolicy::default_write_policy();

        for path in [
            ".git/config",
            ".env",
            ".env.local",
            "config/secrets.json",
            "credentials.yaml",
            "server.key",
            "node_modules/package/index.js",
        ] {
            let evaluation = policy.evaluate(path);
            assert_eq!(
                evaluation.decision,
                FilePermissionDecision::Deny,
                "{path} should be denied"
            );
            assert!(evaluation.reason.is_some(), "{path} should have a reason");
        }
    }

    #[test]
    fn later_matching_rules_win() {
        let policy = FilePermissionPolicy::new(vec![
            FilePermissionRule::new("*", FilePermissionDecision::Allow),
            FilePermissionRule::new("docs/**", FilePermissionDecision::Ask),
            FilePermissionRule::new("docs/public/**", FilePermissionDecision::Allow),
        ]);

        assert_eq!(
            policy.evaluate("docs/private/runbook.md").decision,
            FilePermissionDecision::Ask
        );
        assert_eq!(
            policy.evaluate("docs/public/readme.md").decision,
            FilePermissionDecision::Allow
        );
    }

    #[test]
    fn try_new_rejects_invalid_glob_rules() {
        let error = FilePermissionPolicy::try_new(vec![
            FilePermissionRule::new("*", FilePermissionDecision::Allow),
            FilePermissionRule::new("[", FilePermissionDecision::Deny),
        ])
        .unwrap_err();

        assert_eq!(error.pattern, "[");
        assert!(error.message.contains("invalid range pattern"));
    }

    #[test]
    fn infallible_new_fails_closed_for_invalid_glob_rules() {
        let policy = FilePermissionPolicy::new(vec![
            FilePermissionRule::new("*", FilePermissionDecision::Allow),
            FilePermissionRule::new("[", FilePermissionDecision::Deny),
        ]);

        let evaluation = policy.evaluate("src/main.rs");

        assert_eq!(evaluation.decision, FilePermissionDecision::Deny);
        assert_eq!(evaluation.matched_pattern.as_deref(), Some("["));
        assert!(evaluation
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("invalid file permission glob")));
        assert!(policy.validation_error().is_some());
    }
}

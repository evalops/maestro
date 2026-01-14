//! GitHub Watcher (Polling Mode)
//!
//! Polls GitHub API for issues and PRs matching configured criteria.
//! Emits events to the EventBus for processing by the daemon.

use crate::event_bus::EventBus;
use crate::types::*;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// Configuration for the GitHub watcher
#[derive(Debug, Clone)]
pub struct GitHubWatcherConfig {
    /// GitHub personal access token
    pub token: String,
    /// Repositories to watch (owner/repo format)
    pub repositories: Vec<String>,
    /// Labels that trigger processing
    pub trigger_labels: Vec<String>,
    /// Poll interval in seconds
    pub poll_interval_secs: u64,
    /// Only fetch issues/PRs updated since this time ago (seconds)
    pub lookback_secs: u64,
    /// GitHub API base URL (for enterprise support)
    pub api_base_url: String,
    /// Request timeout in seconds
    pub request_timeout_secs: u64,
}

impl Default for GitHubWatcherConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            repositories: vec![],
            trigger_labels: vec!["composer-auto".to_string(), "good-first-issue".to_string()],
            poll_interval_secs: 60,
            lookback_secs: 3600, // 1 hour
            api_base_url: "https://api.github.com".to_string(),
            request_timeout_secs: 30,
        }
    }
}

/// GitHub Issue/PR from API
#[derive(Debug, Clone, Deserialize)]
struct GitHubIssue {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,
    html_url: String,
    #[allow(dead_code)] // Used for filtering by date
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    user: GitHubUser,
    labels: Vec<GitHubLabel>,
    pull_request: Option<serde_json::Value>, // Present if this is a PR
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubLabel {
    name: String,
}

/// Statistics about the watcher
#[derive(Debug, Clone, Default)]
pub struct WatcherStats {
    pub polls_completed: u64,
    pub issues_found: u64,
    pub prs_found: u64,
    pub events_emitted: u64,
    pub errors: u64,
    pub last_poll_at: Option<DateTime<Utc>>,
}

/// GitHub Watcher polls repositories for issues and PRs
pub struct GitHubWatcher {
    config: GitHubWatcherConfig,
    client: Client,
    event_bus: Arc<RwLock<EventBus>>,
    seen_ids: Arc<RwLock<HashSet<String>>>,
    stats: Arc<RwLock<WatcherStats>>,
    running: Arc<RwLock<bool>>,
}

impl GitHubWatcher {
    /// Create a new GitHub watcher
    pub fn new(config: GitHubWatcherConfig, event_bus: Arc<RwLock<EventBus>>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .user_agent("ambient-agent/0.1")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            config,
            client,
            event_bus,
            seen_ids: Arc::new(RwLock::new(HashSet::new())),
            stats: Arc::new(RwLock::new(WatcherStats::default())),
            running: Arc::new(RwLock::new(false)),
        }
    }

    /// Start the watcher loop
    pub async fn start(&self) -> anyhow::Result<()> {
        if self.config.token.is_empty() {
            anyhow::bail!("GitHub token not configured");
        }

        if self.config.repositories.is_empty() {
            anyhow::bail!("No repositories configured to watch");
        }

        *self.running.write().await = true;
        info!(
            "Starting GitHub watcher for {} repositories",
            self.config.repositories.len()
        );

        while *self.running.read().await {
            if let Err(e) = self.poll_all_repos().await {
                error!("Poll cycle failed: {}", e);
                self.stats.write().await.errors += 1;
            }

            // Update last poll time
            self.stats.write().await.last_poll_at = Some(Utc::now());
            self.stats.write().await.polls_completed += 1;

            // Wait for next poll
            tokio::time::sleep(Duration::from_secs(self.config.poll_interval_secs)).await;
        }

        info!("GitHub watcher stopped");
        Ok(())
    }

    /// Stop the watcher
    pub async fn stop(&self) {
        *self.running.write().await = false;
    }

    /// Get current statistics
    pub async fn get_stats(&self) -> WatcherStats {
        self.stats.read().await.clone()
    }

    /// Poll all configured repositories
    async fn poll_all_repos(&self) -> anyhow::Result<()> {
        for repo in &self.config.repositories {
            if let Err(e) = self.poll_repo(repo).await {
                warn!("Failed to poll {}: {}", repo, e);
                // Continue with other repos
            }
        }
        Ok(())
    }

    /// Poll a single repository for issues and PRs
    async fn poll_repo(&self, repo: &str) -> anyhow::Result<()> {
        debug!("Polling repository: {}", repo);

        // Calculate since timestamp
        let since = Utc::now() - chrono::Duration::seconds(self.config.lookback_secs as i64);

        // Fetch issues (includes PRs in GitHub API)
        let issues = self.fetch_issues(repo, &since).await?;

        for issue in issues {
            // Check if we've seen this issue in this session (atomically check and insert)
            let issue_key = format!("{}#{}", repo, issue.number);
            {
                let mut seen = self.seen_ids.write().await;
                if seen.contains(&issue_key) {
                    continue;
                }
                // Mark as seen immediately to prevent race conditions
                seen.insert(issue_key.clone());
            }

            // Check if issue matches our criteria
            if !self.should_process(&issue) {
                continue;
            }

            // Emit event
            let is_pr = issue.pull_request.is_some();
            let event_type = if is_pr {
                "pull_request"
            } else {
                "issues"
            };

            let raw_event = RawEvent {
                source: WatcherType::GitHubPoll,
                event_type: event_type.to_string(),
                payload: self.issue_to_payload(&issue),
                timestamp: issue.updated_at,
                repo: repo.to_string(),
            };

            // Emit to event bus
            let event_bus = self.event_bus.write().await;
            if event_bus.emit(raw_event).await.is_some() {
                info!(
                    "Emitted event for {} {} #{}",
                    repo,
                    if is_pr { "PR" } else { "issue" },
                    issue.number
                );

                // Update stats
                let mut stats = self.stats.write().await;
                stats.events_emitted += 1;
                if is_pr {
                    stats.prs_found += 1;
                } else {
                    stats.issues_found += 1;
                }
            }
        }

        Ok(())
    }

    /// Fetch issues from GitHub API
    async fn fetch_issues(
        &self,
        repo: &str,
        since: &DateTime<Utc>,
    ) -> anyhow::Result<Vec<GitHubIssue>> {
        let url = format!(
            "{}/repos/{}/issues?state=open&since={}&sort=updated&direction=desc&per_page=100",
            self.config.api_base_url,
            repo,
            since.format("%Y-%m-%dT%H:%M:%SZ")
        );

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.config.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API error {}: {}", status, body);
        }

        let issues: Vec<GitHubIssue> = response.json().await?;
        Ok(issues)
    }

    /// Check if an issue should be processed
    fn should_process(&self, issue: &GitHubIssue) -> bool {
        // Must be open
        if issue.state != "open" {
            return false;
        }

        // Check for trigger labels
        let has_trigger_label = issue.labels.iter().any(|label| {
            self.config
                .trigger_labels
                .iter()
                .any(|trigger| label.name.to_lowercase() == trigger.to_lowercase())
        });

        has_trigger_label
    }

    /// Convert GitHub issue to event payload
    fn issue_to_payload(&self, issue: &GitHubIssue) -> serde_json::Value {
        let action = "opened"; // Treat polled issues as newly opened

        let labels: Vec<String> = issue.labels.iter().map(|l| l.name.clone()).collect();

        let inner = if issue.pull_request.is_some() {
            serde_json::json!({
                "pull_request": {
                    "number": issue.number,
                    "title": issue.title,
                    "body": issue.body,
                    "html_url": issue.html_url,
                    "user": { "login": issue.user.login },
                    "labels": labels.iter().map(|l| serde_json::json!({"name": l})).collect::<Vec<_>>()
                }
            })
        } else {
            serde_json::json!({
                "issue": {
                    "number": issue.number,
                    "title": issue.title,
                    "body": issue.body,
                    "html_url": issue.html_url,
                    "user": { "login": issue.user.login },
                    "labels": labels.iter().map(|l| serde_json::json!({"name": l})).collect::<Vec<_>>()
                }
            })
        };

        let mut payload = inner;
        payload["action"] = serde_json::json!(action);
        payload
    }

    /// Clear seen IDs (useful for testing or manual refresh)
    pub async fn clear_seen(&self) {
        self.seen_ids.write().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_process_with_trigger_label() {
        let config = GitHubWatcherConfig {
            trigger_labels: vec!["composer-auto".to_string()],
            ..Default::default()
        };

        let issue = GitHubIssue {
            number: 1,
            title: "Test".to_string(),
            body: None,
            state: "open".to_string(),
            html_url: "https://github.com/test/repo/issues/1".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            user: GitHubUser {
                login: "testuser".to_string(),
            },
            labels: vec![GitHubLabel {
                name: "composer-auto".to_string(),
            }],
            pull_request: None,
        };

        // Create a mock event bus for testing
        let event_bus = Arc::new(RwLock::new(EventBus::new(Default::default())));
        let watcher = GitHubWatcher::new(config, event_bus);

        assert!(watcher.should_process(&issue));
    }

    #[test]
    fn test_should_not_process_without_trigger_label() {
        let config = GitHubWatcherConfig {
            trigger_labels: vec!["composer-auto".to_string()],
            ..Default::default()
        };

        let issue = GitHubIssue {
            number: 1,
            title: "Test".to_string(),
            body: None,
            state: "open".to_string(),
            html_url: "https://github.com/test/repo/issues/1".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            user: GitHubUser {
                login: "testuser".to_string(),
            },
            labels: vec![GitHubLabel {
                name: "bug".to_string(),
            }],
            pull_request: None,
        };

        let event_bus = Arc::new(RwLock::new(EventBus::new(Default::default())));
        let watcher = GitHubWatcher::new(config, event_bus);

        assert!(!watcher.should_process(&issue));
    }

    #[test]
    fn test_should_not_process_closed() {
        let config = GitHubWatcherConfig {
            trigger_labels: vec!["composer-auto".to_string()],
            ..Default::default()
        };

        let issue = GitHubIssue {
            number: 1,
            title: "Test".to_string(),
            body: None,
            state: "closed".to_string(),
            html_url: "https://github.com/test/repo/issues/1".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            user: GitHubUser {
                login: "testuser".to_string(),
            },
            labels: vec![GitHubLabel {
                name: "composer-auto".to_string(),
            }],
            pull_request: None,
        };

        let event_bus = Arc::new(RwLock::new(EventBus::new(Default::default())));
        let watcher = GitHubWatcher::new(config, event_bus);

        assert!(!watcher.should_process(&issue));
    }
}

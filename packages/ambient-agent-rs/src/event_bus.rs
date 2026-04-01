//! EventBus
//!
//! Normalizes, deduplicates, enriches, and persists events from various watchers.
//! Central event processing hub for the Ambient Agent.

use crate::types::*;
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, error, info, warn};

/// Configuration for the EventBus
#[derive(Debug, Clone)]
pub struct EventBusConfig {
    /// Directory for persisting events
    pub persist_dir: PathBuf,
    /// Maximum events to keep in memory
    pub max_in_memory_events: usize,
    /// Deduplication window in seconds
    pub dedupe_window_secs: u64,
    /// Event TTL in seconds
    pub event_ttl_secs: u64,
}

impl Default for EventBusConfig {
    fn default() -> Self {
        Self {
            persist_dir: PathBuf::from(".ambient/events"),
            max_in_memory_events: 1000,
            dedupe_window_secs: 3600,      // 1 hour
            event_ttl_secs: 7 * 24 * 3600, // 7 days
        }
    }
}

/// Statistics about the EventBus
#[derive(Debug, Clone, Default)]
pub struct EventBusStats {
    pub total_received: u64,
    pub total_processed: u64,
    pub total_deduplicated: u64,
    pub total_enriched: u64,
    pub pending_count: usize,
    pub processing_count: usize,
}

/// Internal state of the EventBus
struct EventBusState {
    events: HashMap<String, NormalizedEvent>,
    recent_hashes: HashMap<String, i64>, // hash -> unix timestamp
    stats: EventBusStats,
}

/// EventBus manages event flow from watchers to processors
pub struct EventBus {
    config: EventBusConfig,
    state: Arc<RwLock<EventBusState>>,
    event_tx: broadcast::Sender<NormalizedEvent>,
}

impl EventBus {
    /// Create a new EventBus
    pub fn new(config: EventBusConfig) -> Self {
        let (event_tx, _) = broadcast::channel(1000);

        let state = EventBusState {
            events: HashMap::new(),
            recent_hashes: HashMap::new(),
            stats: EventBusStats::default(),
        };

        let bus = Self {
            config,
            state: Arc::new(RwLock::new(state)),
            event_tx,
        };

        // Ensure persist directory exists
        if let Err(e) = std::fs::create_dir_all(&bus.config.persist_dir) {
            warn!("Failed to create persist directory: {}", e);
        }

        bus
    }

    /// Initialize by loading persisted events
    /// Call this after creating the EventBus to restore previous state
    pub async fn init(&self) -> anyhow::Result<()> {
        load_persisted_events(
            self.state.clone(),
            self.config.persist_dir.clone(),
            self.config.event_ttl_secs,
        )
        .await
    }

    /// Subscribe to events
    pub fn subscribe(&self) -> broadcast::Receiver<NormalizedEvent> {
        self.event_tx.subscribe()
    }

    /// Emit a raw event into the bus
    pub async fn emit(&self, raw: RawEvent) -> Option<NormalizedEvent> {
        let mut state = self.state.write().await;
        state.stats.total_received += 1;

        // Compute dedup hash
        let hash = compute_hash(&raw);

        // Check for duplicate
        if self.is_duplicate(&state, &hash) {
            state.stats.total_deduplicated += 1;
            debug!("Duplicate event detected: {}", hash);
            return None;
        }

        // Normalize the event
        let normalized = match self.normalize(raw).await {
            Ok(event) => event,
            Err(e) => {
                error!("Failed to normalize event: {}", e);
                return None;
            }
        };

        // Mark hash as seen
        state.recent_hashes.insert(hash, Utc::now().timestamp());

        // Store event
        let event_id = normalized.id.clone();
        state.events.insert(event_id.clone(), normalized.clone());
        state.stats.pending_count += 1;
        state.stats.total_enriched += 1;

        drop(state);

        // Persist to disk
        if let Err(e) = self.persist_event(&normalized).await {
            error!("Failed to persist event: {}", e);
        }

        // Broadcast to subscribers
        let _ = self.event_tx.send(normalized.clone());

        // Cleanup old events
        self.cleanup().await;

        info!("Event emitted: {}", event_id);
        Some(normalized)
    }

    /// Get an event by ID
    pub async fn get(&self, id: &str) -> Option<NormalizedEvent> {
        let state = self.state.read().await;
        state.events.get(id).cloned()
    }

    /// Get all pending events, sorted by priority (highest first)
    pub async fn get_pending(&self) -> Vec<NormalizedEvent> {
        let state = self.state.read().await;
        let mut pending: Vec<_> = state
            .events
            .values()
            .filter(|e| e.status == EventStatus::Pending)
            .cloned()
            .collect();
        pending.sort_by(|a, b| b.priority.cmp(&a.priority));
        pending
    }

    /// Get events by status
    pub async fn get_by_status(&self, status: EventStatus) -> Vec<NormalizedEvent> {
        let state = self.state.read().await;
        state
            .events
            .values()
            .filter(|e| e.status == status)
            .cloned()
            .collect()
    }

    /// Get recent events for a repository
    pub async fn get_recent_for_repo(&self, repo: &str, limit: usize) -> Vec<NormalizedEvent> {
        let state = self.state.read().await;
        let mut events: Vec<_> = state
            .events
            .values()
            .filter(|e| e.repo.full_name == repo)
            .cloned()
            .collect();
        events.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        events.truncate(limit);
        events
    }

    /// Update event status
    pub async fn update_status(&self, id: &str, status: EventStatus) {
        let mut state = self.state.write().await;

        // First, update the event and extract needed info
        let updated_event = if let Some(event) = state.events.get_mut(id) {
            let old_status = event.status;
            event.status = status;

            if status == EventStatus::Processing {
                event.processed_at = Some(Utc::now());
            }

            Some((old_status, event.clone()))
        } else {
            None
        };

        // Now update stats without holding the event borrow
        if let Some((old_status, event_clone)) = updated_event {
            match status {
                EventStatus::Processing => {
                    state.stats.processing_count += 1;
                    if old_status == EventStatus::Pending {
                        state.stats.pending_count = state.stats.pending_count.saturating_sub(1);
                    }
                }
                EventStatus::Completed | EventStatus::Failed | EventStatus::Skipped => {
                    state.stats.total_processed += 1;
                    if old_status == EventStatus::Processing {
                        state.stats.processing_count =
                            state.stats.processing_count.saturating_sub(1);
                    }
                    if old_status == EventStatus::Pending {
                        state.stats.pending_count = state.stats.pending_count.saturating_sub(1);
                    }
                }
                _ => {}
            }

            // Persist updated event
            let persist_dir = self.config.persist_dir.clone();
            tokio::spawn(async move {
                let path = persist_dir.join(format!("{}.json", event_clone.id));
                if let Err(e) = tokio::fs::write(
                    &path,
                    serde_json::to_string_pretty(&event_clone).unwrap_or_default(),
                )
                .await
                {
                    error!("Failed to persist event update: {}", e);
                }
            });
        }
    }

    /// Get statistics
    pub async fn get_stats(&self) -> EventBusStats {
        let state = self.state.read().await;
        state.stats.clone()
    }

    /// Check if an event hash was seen recently
    fn is_duplicate(&self, state: &EventBusState, hash: &str) -> bool {
        if let Some(&timestamp) = state.recent_hashes.get(hash) {
            let now = Utc::now().timestamp();
            return (now - timestamp) < self.config.dedupe_window_secs as i64;
        }
        false
    }

    /// Normalize a raw event
    async fn normalize(&self, raw: RawEvent) -> anyhow::Result<NormalizedEvent> {
        let id = generate_id();
        let event_type = map_event_type(&raw);
        let payload = extract_payload(&raw);
        let repo = get_repo_context(&raw.repo).await?;
        let flags = detect_flags(&payload);
        let priority = compute_priority(&event_type, &payload, &repo);
        let repository = format!("{}/{}", repo.owner, repo.name);
        let title = payload.title.clone().unwrap_or_default();
        let body = payload.body.clone();
        let labels = payload.labels.clone();

        Ok(NormalizedEvent {
            id,
            source: raw.source,
            event_type,
            repo: repo.clone(),
            repository,
            priority,
            title,
            body,
            labels,
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload,
            created_at: raw.timestamp,
            processed_at: None,
            status: EventStatus::Pending,
            flags,
        })
    }

    /// Persist an event to disk
    async fn persist_event(&self, event: &NormalizedEvent) -> anyhow::Result<()> {
        let path = self.config.persist_dir.join(format!("{}.json", event.id));
        let content = serde_json::to_string_pretty(event)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    /// Cleanup old events and hashes
    async fn cleanup(&self) {
        let mut state = self.state.write().await;
        let now = Utc::now().timestamp();

        // Cleanup old hashes
        state
            .recent_hashes
            .retain(|_, timestamp| (now - *timestamp) < self.config.dedupe_window_secs as i64);

        // Cleanup events if over limit
        if state.events.len() > self.config.max_in_memory_events {
            // First, remove completed/skipped events (oldest first)
            let mut completed: Vec<_> = state
                .events
                .iter()
                .filter(|(_, e)| {
                    e.status == EventStatus::Completed || e.status == EventStatus::Skipped
                })
                .map(|(id, e)| (id.clone(), e.created_at))
                .collect();

            completed.sort_by(|a, b| a.1.cmp(&b.1));

            let excess = state
                .events
                .len()
                .saturating_sub(self.config.max_in_memory_events);
            let to_remove_completed = excess.min(completed.len());

            for (id, _) in completed.into_iter().take(to_remove_completed) {
                state.events.remove(&id);
            }

            // If still over limit, drop oldest active events to prevent unbounded growth
            if state.events.len() > self.config.max_in_memory_events {
                let mut active: Vec<_> = state
                    .events
                    .iter()
                    .filter(|(_, e)| {
                        e.status == EventStatus::Pending || e.status == EventStatus::Processing
                    })
                    .map(|(id, e)| (id.clone(), e.created_at))
                    .collect();

                active.sort_by(|a, b| a.1.cmp(&b.1));

                let still_excess = state
                    .events
                    .len()
                    .saturating_sub(self.config.max_in_memory_events);
                for (id, _) in active.into_iter().take(still_excess) {
                    warn!("Dropping active event {} due to memory pressure", id);
                    state.events.remove(&id);
                }
            }
        }
    }
}

/// Compute a hash for deduplication
fn compute_hash(raw: &RawEvent) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", raw.source).as_bytes());
    hasher.update(raw.event_type.as_bytes());
    hasher.update(raw.repo.as_bytes());

    // Include relevant payload fields but not timestamps
    if let Some(obj) = raw.payload.as_object() {
        if let Some(number) = obj.get("number") {
            hasher.update(number.to_string().as_bytes());
        }
        if let Some(title) = obj.get("title") {
            hasher.update(title.to_string().as_bytes());
        }
        if let Some(action) = obj.get("action") {
            hasher.update(action.to_string().as_bytes());
        }
    }

    hex::encode(hasher.finalize())
}

/// Generate a unique event ID
fn generate_id() -> String {
    let timestamp = Utc::now().timestamp_millis();
    let random: u64 = rand::random();
    format!("evt_{}_{:x}", timestamp, random & 0xFFFFFF)
}

/// Map raw event type to normalized EventType
fn map_event_type(raw: &RawEvent) -> EventType {
    let type_str = raw.event_type.to_lowercase();
    let action = raw
        .payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if type_str.contains("issue") {
        return match action {
            "opened" | "created" => EventType::IssueCreated,
            "labeled" => EventType::IssueLabeled,
            _ => EventType::IssueMentioned,
        };
    }

    if type_str.contains("pull_request") || type_str.contains("pr") {
        return match action {
            "opened" => EventType::PrOpened,
            "review_requested" => EventType::PrReviewRequested,
            _ => EventType::PrComment,
        };
    }

    if type_str.contains("push") {
        return EventType::PushToMain;
    }

    if type_str.contains("check") || type_str.contains("workflow") || type_str.contains("ci") {
        return EventType::CiFailure;
    }

    if type_str.contains("dependabot") || type_str.contains("dependency") {
        return EventType::DependencyUpdate;
    }

    if type_str.contains("security") || type_str.contains("vulnerability") {
        return EventType::SecurityAlert;
    }

    if type_str.contains("schedule") || type_str.contains("cron") {
        return EventType::ScheduledTask;
    }

    if type_str.contains("backlog") {
        return EventType::BacklogReady;
    }

    if type_str.contains("slack") {
        return EventType::SlackRequest;
    }

    EventType::IssueMentioned
}

/// Extract structured payload from raw event
fn extract_payload(raw: &RawEvent) -> EventPayload {
    let obj = raw.payload.as_object();

    // Handle different payload structures
    let target = obj
        .and_then(|o| o.get("issue").or_else(|| o.get("pull_request")))
        .and_then(|v| v.as_object())
        .or(obj);

    let mut payload = EventPayload::default();

    if let Some(target) = target {
        payload.title = target
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        payload.body = target
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        payload.number = target.get("number").and_then(|v| v.as_u64());
        payload.author = target
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        payload.url = target
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Extract labels
        if let Some(labels) = target.get("labels").and_then(|v| v.as_array()) {
            payload.labels = labels
                .iter()
                .filter_map(|l| {
                    l.as_str().map(|s| s.to_string()).or_else(|| {
                        l.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    })
                })
                .collect();
        }
    }

    // Also get action from root
    if let Some(action) = obj.and_then(|o| o.get("action")).and_then(|v| v.as_str()) {
        payload.extra.insert(
            "action".to_string(),
            serde_json::Value::String(action.to_string()),
        );
    }

    payload
}

/// Detect flags from payload content
fn detect_flags(payload: &EventPayload) -> EventFlags {
    let content = format!(
        "{} {}",
        payload.title.as_deref().unwrap_or(""),
        payload.body.as_deref().unwrap_or("")
    )
    .to_lowercase();

    let mut flags = EventFlags::default();

    // Check for injection patterns
    let injection_patterns = [
        "ignore previous instructions",
        "you are now",
        "disregard system prompt",
        "override safety",
        "new instructions:",
        "[system]",
    ];

    for pattern in injection_patterns {
        if content.contains(pattern) {
            flags.potential_injection = true;
            break;
        }
    }

    // Check for high priority
    let high_priority_labels = ["urgent", "critical", "security", "p0", "p1"];
    if payload.labels.iter().any(|l| {
        high_priority_labels
            .iter()
            .any(|hp| l.to_lowercase().contains(hp))
    }) {
        flags.high_priority = true;
    }

    // Check for approval requirement
    let approval_labels = ["needs-approval", "manual", "breaking"];
    if payload.labels.iter().any(|l| {
        approval_labels
            .iter()
            .any(|al| l.to_lowercase().contains(al))
    }) {
        flags.requires_approval = true;
    }

    flags
}

/// Get repository context, cloning if necessary
async fn get_repo_context(repo_name: &str) -> anyhow::Result<Repository> {
    let parts: Vec<&str> = repo_name.split('/').collect();
    let (owner, name) = if parts.len() >= 2 {
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("unknown".to_string(), repo_name.to_string())
    };

    let repo_path = format!("/tmp/repos/{}", repo_name);
    let repo_url = format!("https://github.com/{}", repo_name);

    // Clone repository if it doesn't exist
    if !std::path::Path::new(&repo_path).join(".git").exists() {
        clone_repository(&repo_url, &repo_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to clone repository {}: {}", repo_name, e))?;
    }

    Ok(Repository {
        owner: owner.clone(),
        name: name.clone(),
        full_name: repo_name.to_string(),
        default_branch: "main".to_string(),
        path: repo_path,
        url: repo_url,
        config: None,
        agent_md: None,
        test_coverage: None,
        codeowners: vec![],
    })
}

/// Clone a repository to the specified path
async fn clone_repository(url: &str, path: &str) -> anyhow::Result<()> {
    use std::process::Stdio;
    use tokio::process::Command;

    // Create parent directory
    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    info!("Cloning repository {} to {}", url, path);

    let output = Command::new("git")
        .args(["clone", "--depth", "1", url, path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git clone failed: {}", stderr);
    }

    info!("Successfully cloned repository to {}", path);
    Ok(())
}

/// Compute event priority (0-100)
fn compute_priority(event_type: &EventType, payload: &EventPayload, _repo: &Repository) -> u8 {
    let base = match event_type {
        EventType::SecurityAlert => 90,
        EventType::CiFailure => 80,
        EventType::PrReviewRequested => 70,
        EventType::IssueLabeled => 65,
        EventType::Issue | EventType::IssueCreated => 60,
        EventType::PullRequest | EventType::PrOpened => 60,
        EventType::PrComment => 55,
        EventType::PushToMain => 50,
        EventType::DependencyUpdate => 45,
        EventType::BacklogReady => 40,
        EventType::ScheduledTask => 35,
        EventType::SlackRequest => 60,
        EventType::IssueMentioned => 50,
    };

    let mut priority: u8 = base;

    // Label adjustments
    for label in &payload.labels {
        let label_lower = label.to_lowercase();
        if label_lower.contains("urgent") {
            priority = priority.saturating_add(20);
        }
        if label_lower.contains("composer-auto") {
            priority = priority.saturating_add(15);
        }
        if label_lower.contains("good-first-issue") {
            priority = priority.saturating_add(10);
        }
    }

    priority.min(100)
}

/// Load persisted events from disk
async fn load_persisted_events(
    state: Arc<RwLock<EventBusState>>,
    persist_dir: PathBuf,
    event_ttl_secs: u64,
) -> anyhow::Result<()> {
    if !persist_dir.exists() {
        return Ok(());
    }

    let mut entries = tokio::fs::read_dir(&persist_dir).await?;
    let now = Utc::now();

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => {
                    if let Ok(event) = serde_json::from_str::<NormalizedEvent>(&content) {
                        // Check TTL
                        let age = (now - event.created_at).num_seconds() as u64;
                        if age < event_ttl_secs {
                            let mut state = state.write().await;
                            if event.status == EventStatus::Pending {
                                state.stats.pending_count += 1;
                            }
                            if event.status == EventStatus::Processing {
                                state.stats.processing_count += 1;
                            }
                            state.events.insert(event.id.clone(), event);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to read event file {:?}: {}", path, e);
                }
            }
        }
    }

    let state = state.read().await;
    info!("Loaded {} persisted events", state.events.len());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Create a fake git repo at /tmp/repos/test/repo for tests
    async fn setup_test_repo() {
        let repo_path = std::path::Path::new("/tmp/repos/test/repo");
        if !repo_path.join(".git").exists() {
            tokio::fs::create_dir_all(repo_path).await.ok();
            tokio::fs::create_dir_all(repo_path.join(".git")).await.ok();
        }
    }

    #[tokio::test]
    async fn test_event_emission() {
        setup_test_repo().await;
        let dir = tempdir().unwrap();
        let config = EventBusConfig {
            persist_dir: dir.path().to_path_buf(),
            ..Default::default()
        };

        let bus = EventBus::new(config);

        let raw = RawEvent {
            source: WatcherType::GitHubWebhook,
            event_type: "issues".to_string(),
            payload: serde_json::json!({
                "action": "opened",
                "issue": {
                    "number": 123,
                    "title": "Test issue",
                    "body": "Test body",
                    "labels": ["bug"]
                }
            }),
            timestamp: Utc::now(),
            repo: "test/repo".to_string(),
        };

        let event = bus.emit(raw).await;
        assert!(event.is_some());

        let event = event.unwrap();
        assert_eq!(event.event_type, EventType::IssueCreated);
        assert_eq!(event.status, EventStatus::Pending);
    }

    #[tokio::test]
    async fn test_deduplication() {
        setup_test_repo().await;
        let dir = tempdir().unwrap();
        let config = EventBusConfig {
            persist_dir: dir.path().to_path_buf(),
            ..Default::default()
        };

        let bus = EventBus::new(config);

        let raw = RawEvent {
            source: WatcherType::GitHubWebhook,
            event_type: "issues".to_string(),
            payload: serde_json::json!({
                "action": "opened",
                "issue": { "number": 123, "title": "Test" }
            }),
            timestamp: Utc::now(),
            repo: "test/repo".to_string(),
        };

        // First emission should succeed
        let first = bus.emit(raw.clone()).await;
        assert!(first.is_some());

        // Second emission of same event should be deduplicated
        let second = bus.emit(raw).await;
        assert!(second.is_none());

        let stats = bus.get_stats().await;
        assert_eq!(stats.total_received, 2);
        assert_eq!(stats.total_deduplicated, 1);
    }
}

//! Durable, budgeted workflow run contracts shared by TUI and control plane.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use fd_lock::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSpec {
    pub name: String,
    pub version: String,
    pub steps: Vec<WorkflowStep>,
    pub max_agents: u32,
    pub max_concurrency: u32,
    pub token_budget: u64,
    /// Cross-process resume is allowed only for workflows whose effects are
    /// either read-only or protected by idempotent durable receipts.
    #[serde(default)]
    pub replay_safe: bool,
}

impl WorkflowSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.version.trim().is_empty() {
            return Err("workflow name and version are required".to_string());
        }
        if self.steps.is_empty() {
            return Err("workflow must contain at least one step".to_string());
        }
        if self.max_agents == 0 || self.max_concurrency == 0 {
            return Err("workflow agent and concurrency budgets must be positive".to_string());
        }
        if self.max_concurrency > self.max_agents {
            return Err("maxConcurrency cannot exceed maxAgents".to_string());
        }
        if self.token_budget == 0 {
            return Err("workflow tokenBudget must be positive".to_string());
        }
        let ids = self
            .steps
            .iter()
            .map(|step| step.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if ids.len() != self.steps.len() || ids.contains("") {
            return Err("workflow step ids must be non-empty and unique".to_string());
        }
        for step in &self.steps {
            if step.prompt.trim().is_empty() {
                return Err(format!("workflow step {} has an empty prompt", step.id));
            }
            if let Some(missing) = step.depends_on.iter().find(|id| !ids.contains(id.as_str())) {
                return Err(format!(
                    "workflow step {} depends on missing step {missing}",
                    step.id
                ));
            }
        }
        let mut completed = std::collections::HashSet::<&str>::new();
        while completed.len() < self.steps.len() {
            let before = completed.len();
            for step in &self.steps {
                if !completed.contains(step.id.as_str())
                    && step
                        .depends_on
                        .iter()
                        .all(|dependency| completed.contains(dependency.as_str()))
                {
                    completed.insert(step.id.as_str());
                }
            }
            if completed.len() == before {
                return Err("workflow dependencies must form an acyclic graph".to_string());
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn sha256(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        format!("{:x}", Sha256::digest(bytes))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    Running,
    NeedsInput,
    Blocked,
    Paused,
    Failed,
    Complete,
    Stopped,
}

impl WorkflowRunStatus {
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Failed | Self::Complete | Self::Stopped)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub spec: WorkflowSpec,
    pub spec_sha: String,
    #[serde(default)]
    pub args: serde_json::Value,
    pub status: WorkflowRunStatus,
    pub agents_started: u32,
    pub active_agents: u32,
    pub tokens_used: u64,
    pub owner_process_id: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
}

impl WorkflowRun {
    pub fn start(spec: WorkflowSpec, args: serde_json::Value) -> Result<Self, String> {
        spec.validate()?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            spec_sha: spec.sha256(),
            spec,
            args,
            status: WorkflowRunStatus::Running,
            agents_started: 0,
            active_agents: 0,
            tokens_used: 0,
            owner_process_id: std::process::id(),
            created_at: now.clone(),
            updated_at: now,
            status_reason: None,
        })
    }

    pub fn pause(&mut self) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Running {
            return Err("only a running workflow can be paused".to_string());
        }
        self.transition(WorkflowRunStatus::Paused, None);
        Ok(())
    }

    pub fn resume(
        &mut self,
        expected_spec_sha: &str,
        args: &serde_json::Value,
    ) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Paused && self.status != WorkflowRunStatus::NeedsInput
        {
            return Err("only a paused or input-blocked workflow can be resumed".to_string());
        }
        if expected_spec_sha != self.spec_sha {
            return Err("workflow spec changed; refusing unsafe resume".to_string());
        }
        if args != &self.args {
            return Err("workflow arguments changed; refusing unsafe resume".to_string());
        }
        if self.owner_process_id != std::process::id() && !self.spec.replay_safe {
            return Err(
                "cross-process resume requires a replay-safe workflow with durable receipts"
                    .to_string(),
            );
        }
        self.owner_process_id = std::process::id();
        self.transition(WorkflowRunStatus::Running, None);
        Ok(())
    }

    pub fn stop(&mut self, reason: Option<String>) -> Result<(), String> {
        if self.status.is_terminal() {
            return Err("workflow is already terminal".to_string());
        }
        self.active_agents = 0;
        self.transition(WorkflowRunStatus::Stopped, reason);
        Ok(())
    }

    pub fn record_usage(
        &mut self,
        new_agents: u32,
        active_agents: u32,
        tokens: u64,
    ) -> Result<(), String> {
        if self.status != WorkflowRunStatus::Running {
            return Err("workflow usage can only be recorded while running".to_string());
        }
        let agents_started = self.agents_started.saturating_add(new_agents);
        let tokens_used = self.tokens_used.saturating_add(tokens);
        if agents_started > self.spec.max_agents {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow agent budget exhausted".to_string()),
            );
            return Err("workflow agent budget exhausted".to_string());
        }
        if active_agents > self.spec.max_concurrency {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow concurrency budget exceeded".to_string()),
            );
            return Err("workflow concurrency budget exceeded".to_string());
        }
        if tokens_used > self.spec.token_budget {
            self.transition(
                WorkflowRunStatus::Failed,
                Some("workflow token budget exhausted".to_string()),
            );
            return Err("workflow token budget exhausted".to_string());
        }
        self.agents_started = agents_started;
        self.active_agents = active_agents;
        self.tokens_used = tokens_used;
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    fn transition(&mut self, status: WorkflowRunStatus, reason: Option<String>) {
        self.status = status;
        self.status_reason = reason;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowStore {
    path: PathBuf,
}

impl WorkflowStore {
    #[must_use]
    pub fn for_workspace(workspace: &Path) -> Self {
        Self {
            path: workspace
                .join(".maestro")
                .join("workflows")
                .join("runs.jsonl"),
        }
    }

    #[must_use]
    pub fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> Result<Vec<WorkflowRun>, String> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.path.with_extension("lock"))
            .map_err(|error| error.to_string())?;
        let lock = RwLock::new(lock_file);
        let _guard = lock.read().map_err(|error| error.to_string())?;
        let file = fs::File::open(&self.path).map_err(|error| error.to_string())?;
        let mut latest = HashMap::<String, WorkflowRun>::new();
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let run: WorkflowRun =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            latest.insert(run.id.clone(), run);
        }
        let mut runs = latest.into_values().collect::<Vec<_>>();
        runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(runs)
    }

    pub fn get(&self, id: &str) -> Result<WorkflowRun, String> {
        let runs = self.list()?;
        if let Some(run) = runs.iter().find(|run| run.id == id) {
            return Ok(run.clone());
        }
        let matches = runs
            .into_iter()
            .filter(|run| run.id.starts_with(id))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [run] => Ok(run.clone()),
            [] => Err(format!("workflow run not found: {id}")),
            _ => Err(format!("workflow run id is ambiguous: {id}")),
        }
    }

    pub fn append(&self, run: &WorkflowRun) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "invalid workflow store path".to_string())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.path.with_extension("lock"))
            .map_err(|error| error.to_string())?;
        let mut lock = RwLock::new(lock_file);
        let _guard = lock.write().map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, run).map_err(|error| error.to_string())?;
        writeln!(file).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())
    }

    pub fn dashboard(&self) -> Result<BTreeMap<String, Vec<WorkflowRun>>, String> {
        let mut groups = BTreeMap::<String, Vec<WorkflowRun>>::new();
        for run in self.list()? {
            let group = match run.status {
                WorkflowRunStatus::Running => "running",
                WorkflowRunStatus::NeedsInput => "needs_input",
                WorkflowRunStatus::Blocked | WorkflowRunStatus::Paused => "blocked",
                WorkflowRunStatus::Failed => "failed",
                WorkflowRunStatus::Complete | WorkflowRunStatus::Stopped => "complete",
            };
            groups.entry(group.to_string()).or_default().push(run);
        }
        Ok(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> WorkflowSpec {
        WorkflowSpec {
            name: "verified-research".to_string(),
            version: "1".to_string(),
            steps: vec![WorkflowStep {
                id: "research".to_string(),
                prompt: "Gather sourced claims".to_string(),
                depends_on: Vec::new(),
            }],
            max_agents: 3,
            max_concurrency: 2,
            token_budget: 10_000,
            replay_safe: false,
        }
    }

    #[test]
    fn resume_rejects_changed_spec_or_arguments() {
        let args = serde_json::json!({"topic": "compaction"});
        let mut run = WorkflowRun::start(spec(), args.clone()).unwrap();
        run.pause().unwrap();
        assert!(run.resume("wrong", &args).is_err());
        assert!(run
            .resume(
                &run.spec_sha.clone(),
                &serde_json::json!({"topic": "other"})
            )
            .is_err());
        run.resume(&run.spec_sha.clone(), &args).unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Running);
    }

    #[test]
    fn cumulative_budgets_fail_closed() {
        let mut run = WorkflowRun::start(spec(), serde_json::json!({})).unwrap();
        run.record_usage(2, 2, 9_000).unwrap();
        assert!(run.record_usage(2, 1, 100).is_err());
        assert_eq!(run.status, WorkflowRunStatus::Failed);
    }

    #[test]
    fn cyclic_dependencies_are_rejected() {
        let mut spec = spec();
        spec.steps = vec![
            WorkflowStep {
                id: "a".to_string(),
                prompt: "A".to_string(),
                depends_on: vec!["b".to_string()],
            },
            WorkflowStep {
                id: "b".to_string(),
                prompt: "B".to_string(),
                depends_on: vec!["a".to_string()],
            },
        ];
        assert!(WorkflowRun::start(spec, serde_json::json!({})).is_err());
    }

    #[test]
    fn store_replays_latest_snapshot_and_groups_dashboard() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::with_path(dir.path().join("runs.jsonl"));
        let mut run = WorkflowRun::start(spec(), serde_json::json!({})).unwrap();
        store.append(&run).unwrap();
        run.pause().unwrap();
        store.append(&run).unwrap();

        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(
            store.get(&run.id).unwrap().status,
            WorkflowRunStatus::Paused
        );
        assert_eq!(store.dashboard().unwrap()["blocked"].len(), 1);
    }
}

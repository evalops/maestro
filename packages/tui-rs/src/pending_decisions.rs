//! Durable non-blocking user decisions.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use fd_lock::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    Pending,
    Answered,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDecision {
    pub id: String,
    pub questions: serde_json::Value,
    pub status: DecisionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_blocking_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<String>,
    pub updated_at: String,
}

impl PendingDecision {
    #[must_use]
    pub fn new(
        questions: serde_json::Value,
        non_blocking_reason: Option<String>,
        deadline_seconds: Option<u64>,
    ) -> Self {
        let now = chrono::Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            questions,
            status: DecisionStatus::Pending,
            non_blocking_reason,
            answer: None,
            created_at: now.to_rfc3339(),
            deadline_at: deadline_seconds
                .and_then(|seconds| i64::try_from(seconds).ok())
                .and_then(|seconds| now.checked_add_signed(chrono::Duration::seconds(seconds)))
                .map(|deadline| deadline.to_rfc3339()),
            updated_at: now.to_rfc3339(),
        }
    }

    #[must_use]
    pub fn effective_status(&self) -> DecisionStatus {
        if self.status == DecisionStatus::Pending
            && self
                .deadline_at
                .as_deref()
                .and_then(|deadline| chrono::DateTime::parse_from_rfc3339(deadline).ok())
                .is_some_and(|deadline| deadline < chrono::Utc::now())
        {
            DecisionStatus::Expired
        } else {
            self.status
        }
    }

    pub fn answer(&mut self, answer: String) -> Result<(), String> {
        if self.effective_status() != DecisionStatus::Pending {
            return Err("decision is no longer pending".to_string());
        }
        if answer.trim().is_empty() {
            return Err("decision answer cannot be empty".to_string());
        }
        self.answer = Some(answer);
        self.status = DecisionStatus::Answered;
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if self.effective_status() != DecisionStatus::Pending {
            return Err("decision is no longer pending".to_string());
        }
        self.status = DecisionStatus::Cancelled;
        self.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PendingDecisionStore {
    path: PathBuf,
}

impl PendingDecisionStore {
    #[must_use]
    pub fn default_store() -> Self {
        let base = std::env::var_os("MAESTRO_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".maestro")))
            .unwrap_or_else(|| PathBuf::from(".maestro"));
        Self {
            path: base.join("pending-decisions.jsonl"),
        }
    }

    #[must_use]
    pub fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn append(&self, decision: &PendingDecision) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
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
        serde_json::to_writer(&mut file, decision).map_err(|error| error.to_string())?;
        writeln!(file).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())
    }

    pub fn list(&self) -> Result<Vec<PendingDecision>, String> {
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
        let mut latest = HashMap::<String, PendingDecision>::new();
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let decision: PendingDecision =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            latest.insert(decision.id.clone(), decision);
        }
        let mut decisions = latest.into_values().collect::<Vec<_>>();
        decisions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(decisions)
    }

    pub fn get(&self, id: &str) -> Result<PendingDecision, String> {
        let decisions = self.list()?;
        if let Some(decision) = decisions.iter().find(|decision| decision.id == id) {
            return Ok(decision.clone());
        }
        let matches = decisions
            .into_iter()
            .filter(|decision| decision.id.starts_with(id))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [decision] => Ok(decision.clone()),
            [] => Err(format!("pending decision not found: {id}")),
            _ => Err(format!("pending decision id is ambiguous: {id}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_is_durable_and_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingDecisionStore::with_path(dir.path().join("decisions.jsonl"));
        let mut decision =
            PendingDecision::new(serde_json::json!([{"question": "Ship?"}]), None, None);
        store.append(&decision).unwrap();
        decision.answer("yes".to_string()).unwrap();
        store.append(&decision).unwrap();

        let restored = store.get(&decision.id).unwrap();
        assert_eq!(restored.status, DecisionStatus::Answered);
        assert_eq!(restored.answer.as_deref(), Some("yes"));
        assert!(decision.answer("again".to_string()).is_err());
    }
}

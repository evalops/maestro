//! Checkpoint (Transaction Management)
//!
//! Provides atomic operations with rollback capability.
//! Ensures agent changes can be reversed if something goes wrong.

use crate::types::*;
use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

/// Checkpoint manager for transaction-like operations
pub struct CheckpointManager {
    storage_dir: PathBuf,
    active_checkpoints: HashMap<String, Checkpoint>,
    max_checkpoints: usize,
}

impl CheckpointManager {
    /// Create a new checkpoint manager
    pub fn new(storage_dir: PathBuf) -> Self {
        Self {
            storage_dir,
            active_checkpoints: HashMap::new(),
            max_checkpoints: 100,
        }
    }

    /// Create a checkpoint before making changes
    pub async fn create(&mut self, task_id: &str, description: &str) -> anyhow::Result<String> {
        let checkpoint_id = Uuid::new_v4().to_string();

        let checkpoint = Checkpoint {
            id: checkpoint_id.clone(),
            task_id: task_id.to_string(),
            description: description.to_string(),
            state: CheckpointState::Created,
            created_at: Utc::now(),
            file_backups: HashMap::new(),
            git_state: None,
            metadata: HashMap::new(),
        };

        self.active_checkpoints.insert(checkpoint_id.clone(), checkpoint.clone());

        // Persist to disk
        self.persist_checkpoint(&checkpoint).await?;

        // Cleanup old checkpoints if needed
        self.cleanup_old_checkpoints().await?;

        Ok(checkpoint_id)
    }

    /// Backup a file before modifying it
    pub async fn backup_file(&mut self, checkpoint_id: &str, file_path: &Path) -> anyhow::Result<()> {
        // Read current file content if it exists
        let content = if file_path.exists() {
            Some(fs::read_to_string(file_path).await?)
        } else {
            None
        };

        {
            let checkpoint = self.active_checkpoints
                .get_mut(checkpoint_id)
                .ok_or_else(|| anyhow::anyhow!("Checkpoint not found: {}", checkpoint_id))?;

            if checkpoint.state != CheckpointState::Created && checkpoint.state != CheckpointState::Active {
                anyhow::bail!("Cannot backup to checkpoint in state {:?}", checkpoint.state);
            }

            checkpoint.file_backups.insert(
                file_path.to_string_lossy().to_string(),
                content,
            );
            checkpoint.state = CheckpointState::Active;
        }

        // Persist after releasing the mutable borrow
        let checkpoint = self.active_checkpoints.get(checkpoint_id).unwrap();
        self.persist_checkpoint(checkpoint).await?;

        Ok(())
    }

    /// Capture git state for potential rollback
    pub async fn capture_git_state(&mut self, checkpoint_id: &str, repo_path: &Path) -> anyhow::Result<()> {
        // Get current HEAD commit
        let output = tokio::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo_path)
            .output()
            .await?;

        if output.status.success() {
            let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();

            {
                let checkpoint = self.active_checkpoints
                    .get_mut(checkpoint_id)
                    .ok_or_else(|| anyhow::anyhow!("Checkpoint not found: {}", checkpoint_id))?;
                checkpoint.git_state = Some(commit);
            }

            let checkpoint = self.active_checkpoints.get(checkpoint_id).unwrap();
            self.persist_checkpoint(checkpoint).await?;
        }

        Ok(())
    }

    /// Commit the checkpoint (mark as complete, no rollback needed)
    pub async fn commit(&mut self, checkpoint_id: &str) -> anyhow::Result<()> {
        {
            let checkpoint = self.active_checkpoints
                .get_mut(checkpoint_id)
                .ok_or_else(|| anyhow::anyhow!("Checkpoint not found: {}", checkpoint_id))?;
            checkpoint.state = CheckpointState::Committed;
        }

        let checkpoint = self.active_checkpoints.get(checkpoint_id).unwrap();
        self.persist_checkpoint(checkpoint).await?;

        Ok(())
    }

    /// Rollback to checkpoint state
    pub async fn rollback(&mut self, checkpoint_id: &str) -> anyhow::Result<RollbackResult> {
        // First, extract file backups and update state
        let file_backups = {
            let checkpoint = self.active_checkpoints
                .get_mut(checkpoint_id)
                .ok_or_else(|| anyhow::anyhow!("Checkpoint not found: {}", checkpoint_id))?;

            if checkpoint.state == CheckpointState::Committed {
                anyhow::bail!("Cannot rollback committed checkpoint");
            }

            if checkpoint.state == CheckpointState::RolledBack {
                anyhow::bail!("Checkpoint already rolled back");
            }

            checkpoint.state = CheckpointState::RolledBack;
            checkpoint.file_backups.clone() // Need to clone backups to restore files
        };

        let mut restored_files = vec![];
        let mut errors = vec![];

        // Restore files
        for (path, content) in &file_backups {
            let file_path = Path::new(path);

            match content {
                Some(original_content) => {
                    // Restore original content
                    if let Err(e) = fs::write(file_path, original_content).await {
                        errors.push(format!("Failed to restore {}: {}", path, e));
                    } else {
                        restored_files.push(path.clone());
                    }
                }
                None => {
                    // File didn't exist before, remove it
                    if file_path.exists() {
                        if let Err(e) = fs::remove_file(file_path).await {
                            errors.push(format!("Failed to remove {}: {}", path, e));
                        } else {
                            restored_files.push(path.clone());
                        }
                    }
                }
            }
        }

        let checkpoint = self.active_checkpoints.get(checkpoint_id).unwrap();
        self.persist_checkpoint(checkpoint).await?;

        let success = errors.is_empty();
        Ok(RollbackResult {
            checkpoint_id: checkpoint_id.to_string(),
            restored_files,
            errors,
            success,
        })
    }

    /// Rollback git changes if needed
    pub async fn rollback_git(&mut self, checkpoint_id: &str, repo_path: &Path) -> anyhow::Result<()> {
        let checkpoint = self.active_checkpoints
            .get(checkpoint_id)
            .ok_or_else(|| anyhow::anyhow!("Checkpoint not found: {}", checkpoint_id))?;

        if let Some(ref commit) = checkpoint.git_state {
            // Reset to the captured commit
            let output = tokio::process::Command::new("git")
                .args(["reset", "--hard", commit])
                .current_dir(repo_path)
                .output()
                .await?;

            if !output.status.success() {
                anyhow::bail!(
                    "Git reset failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }

        Ok(())
    }

    /// Get checkpoint by ID
    pub fn get(&self, checkpoint_id: &str) -> Option<&Checkpoint> {
        self.active_checkpoints.get(checkpoint_id)
    }

    /// List all active checkpoints
    pub fn list_active(&self) -> Vec<&Checkpoint> {
        self.active_checkpoints
            .values()
            .filter(|c| c.state == CheckpointState::Created || c.state == CheckpointState::Active)
            .collect()
    }

    /// Persist checkpoint to disk
    async fn persist_checkpoint(&self, checkpoint: &Checkpoint) -> anyhow::Result<()> {
        fs::create_dir_all(&self.storage_dir).await?;

        let file_path = self.storage_dir.join(format!("{}.json", checkpoint.id));
        let json = serde_json::to_string_pretty(checkpoint)?;
        fs::write(file_path, json).await?;

        Ok(())
    }

    /// Load checkpoints from disk
    pub async fn load_checkpoints(&mut self) -> anyhow::Result<usize> {
        if !self.storage_dir.exists() {
            return Ok(0);
        }

        let mut entries = fs::read_dir(&self.storage_dir).await?;
        let mut count = 0;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                let content = fs::read_to_string(&path).await?;
                if let Ok(checkpoint) = serde_json::from_str::<Checkpoint>(&content) {
                    self.active_checkpoints.insert(checkpoint.id.clone(), checkpoint);
                    count += 1;
                }
            }
        }

        Ok(count)
    }

    /// Cleanup old committed/rolled-back checkpoints
    async fn cleanup_old_checkpoints(&mut self) -> anyhow::Result<()> {
        // Keep only recent checkpoints
        // Only cleanup if we exceed max checkpoints
        if self.active_checkpoints.len() <= self.max_checkpoints {
            return Ok(());
        }

        // Collect completed checkpoints that can be removed
        let to_remove: Vec<_> = self.active_checkpoints
            .iter()
            .filter(|(_, c)| {
                matches!(c.state, CheckpointState::Committed | CheckpointState::RolledBack)
            })
            .map(|(id, _)| id.clone())
            .collect();

        // Calculate how many we need to remove to get back under limit
        let excess = self.active_checkpoints.len().saturating_sub(self.max_checkpoints);
        let remove_count = excess.min(to_remove.len());

        for id in to_remove.iter().take(remove_count) {
            self.active_checkpoints.remove(id);

            // Remove from disk
            let file_path = self.storage_dir.join(format!("{}.json", id));
            let _ = fs::remove_file(file_path).await;
        }

        Ok(())
    }
}

/// Result of a rollback operation
#[derive(Debug, Clone)]
pub struct RollbackResult {
    pub checkpoint_id: String,
    pub restored_files: Vec<String>,
    pub errors: Vec<String>,
    pub success: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_checkpoint_create_and_commit() {
        let temp = TempDir::new().unwrap();
        let mut manager = CheckpointManager::new(temp.path().join("checkpoints"));

        let cp_id = manager.create("task-1", "Test checkpoint").await.unwrap();
        assert!(manager.get(&cp_id).is_some());

        let cp = manager.get(&cp_id).unwrap();
        assert_eq!(cp.state, CheckpointState::Created);

        manager.commit(&cp_id).await.unwrap();

        let cp = manager.get(&cp_id).unwrap();
        assert_eq!(cp.state, CheckpointState::Committed);
    }

    #[tokio::test]
    async fn test_file_backup_and_rollback() {
        let temp = TempDir::new().unwrap();
        let mut manager = CheckpointManager::new(temp.path().join("checkpoints"));

        // Create a test file
        let test_file = temp.path().join("test.txt");
        fs::write(&test_file, "original content").await.unwrap();

        // Create checkpoint and backup file
        let cp_id = manager.create("task-1", "Test").await.unwrap();
        manager.backup_file(&cp_id, &test_file).await.unwrap();

        // Modify the file
        fs::write(&test_file, "modified content").await.unwrap();

        // Verify modification
        let content = fs::read_to_string(&test_file).await.unwrap();
        assert_eq!(content, "modified content");

        // Rollback
        let result = manager.rollback(&cp_id).await.unwrap();
        assert!(result.success);
        assert_eq!(result.restored_files.len(), 1);

        // Verify rollback
        let content = fs::read_to_string(&test_file).await.unwrap();
        assert_eq!(content, "original content");
    }
}

//! Session Branching
//!
//! Provides the ability to fork a conversation at any point, creating
//! alternative paths through the conversation history.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Unique identifier for a branch
pub type BranchId = String;

/// Unique identifier for a message within a session
pub type MessageId = String;

/// Branch point in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchPoint {
    /// Unique identifier for this branch point
    pub id: BranchId,
    /// ID of the message where the branch starts
    pub fork_message_id: MessageId,
    /// Index of the message in the original conversation
    pub fork_index: usize,
    /// When the branch was created (unix timestamp ms)
    pub created_at: u64,
    /// Optional description of why this branch was created
    pub description: Option<String>,
    /// Tags for organizing branches
    pub tags: Vec<String>,
}

impl BranchPoint {
    /// Create a new branch point
    pub fn new(fork_message_id: impl Into<String>, fork_index: usize) -> Self {
        Self {
            id: format!("branch-{}", uuid::Uuid::new_v4()),
            fork_message_id: fork_message_id.into(),
            fork_index,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            description: None,
            tags: Vec::new(),
        }
    }

    /// Set a description for the branch
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Add tags to the branch
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }
}

/// Branch metadata stored in session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchMetadata {
    /// Branch points in this session
    pub branches: Vec<BranchPoint>,
    /// ID of the current active branch (None = main branch)
    pub active_branch: Option<BranchId>,
    /// Parent session ID if this is a branched session
    pub parent_session: Option<String>,
    /// Parent branch ID if branched from another branch
    pub parent_branch: Option<BranchId>,
}

impl Default for BranchMetadata {
    fn default() -> Self {
        Self {
            branches: Vec::new(),
            active_branch: None,
            parent_session: None,
            parent_branch: None,
        }
    }
}

impl BranchMetadata {
    /// Create new branch metadata
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a new branch point
    pub fn add_branch(&mut self, branch: BranchPoint) -> BranchId {
        let id = branch.id.clone();
        self.branches.push(branch);
        id
    }

    /// Get a branch by ID
    pub fn get_branch(&self, id: &str) -> Option<&BranchPoint> {
        self.branches.iter().find(|b| b.id == id)
    }

    /// List all branches
    pub fn list_branches(&self) -> &[BranchPoint] {
        &self.branches
    }

    /// Set the active branch
    pub fn set_active_branch(&mut self, id: Option<BranchId>) {
        self.active_branch = id;
    }

    /// Get the active branch
    pub fn get_active_branch(&self) -> Option<&BranchPoint> {
        self.active_branch
            .as_ref()
            .and_then(|id| self.get_branch(id))
    }

    /// Check if this is a branched session
    pub fn is_branched(&self) -> bool {
        self.parent_session.is_some() || !self.branches.is_empty()
    }

    /// Get branch lineage (path from root to current)
    pub fn lineage(&self) -> Vec<&BranchPoint> {
        // For now, just return the active branch if any
        self.get_active_branch().into_iter().collect()
    }
}

/// Manages session branching operations
#[derive(Debug, Default)]
pub struct BranchManager {
    /// Metadata for the current session
    metadata: BranchMetadata,
    /// Cache of message indices
    message_indices: HashMap<MessageId, usize>,
}

impl BranchManager {
    /// Create a new branch manager
    pub fn new() -> Self {
        Self::default()
    }

    /// Create from existing metadata
    pub fn from_metadata(metadata: BranchMetadata) -> Self {
        Self {
            metadata,
            message_indices: HashMap::new(),
        }
    }

    /// Get the metadata
    pub fn metadata(&self) -> &BranchMetadata {
        &self.metadata
    }

    /// Register a message with its index
    pub fn register_message(&mut self, message_id: impl Into<String>, index: usize) {
        self.message_indices.insert(message_id.into(), index);
    }

    /// Create a branch at a specific message
    pub fn branch_at(&mut self, message_id: &str, description: Option<&str>) -> Option<BranchId> {
        let index = self.message_indices.get(message_id)?;

        let mut branch = BranchPoint::new(message_id, *index);
        if let Some(desc) = description {
            branch = branch.with_description(desc);
        }

        Some(self.metadata.add_branch(branch))
    }

    /// Switch to a different branch
    pub fn switch_to(&mut self, branch_id: Option<BranchId>) -> bool {
        match &branch_id {
            Some(id) => {
                if self.metadata.get_branch(id).is_some() {
                    self.metadata.set_active_branch(branch_id);
                    true
                } else {
                    false
                }
            }
            None => {
                // Switch to main branch
                self.metadata.set_active_branch(None);
                true
            }
        }
    }

    /// Get the fork index for the active branch
    pub fn active_fork_index(&self) -> Option<usize> {
        self.metadata.get_active_branch().map(|b| b.fork_index)
    }

    /// List all branches with their descriptions
    pub fn list_branches(&self) -> Vec<BranchSummary> {
        self.metadata
            .branches
            .iter()
            .map(|b| BranchSummary {
                id: b.id.clone(),
                description: b.description.clone(),
                fork_index: b.fork_index,
                created_at: b.created_at,
                is_active: self.metadata.active_branch.as_ref() == Some(&b.id),
            })
            .collect()
    }
}

/// Summary of a branch for display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchSummary {
    /// Branch ID
    pub id: BranchId,
    /// Optional description
    pub description: Option<String>,
    /// Fork index in conversation
    pub fork_index: usize,
    /// When created
    pub created_at: u64,
    /// Whether this is the active branch
    pub is_active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_branch_point_creation() {
        let branch =
            BranchPoint::new("msg-123", 5).with_description("Testing alternative approach");

        assert!(branch.id.starts_with("branch-"));
        assert_eq!(branch.fork_message_id, "msg-123");
        assert_eq!(branch.fork_index, 5);
        assert!(branch.description.is_some());
    }

    #[test]
    fn test_branch_metadata() {
        let mut metadata = BranchMetadata::new();

        assert!(!metadata.is_branched());

        let branch1 = BranchPoint::new("msg-1", 0);
        let id1 = metadata.add_branch(branch1);

        assert!(metadata.is_branched());
        assert!(metadata.get_branch(&id1).is_some());
        assert_eq!(metadata.list_branches().len(), 1);
    }

    #[test]
    fn test_branch_manager() {
        let mut manager = BranchManager::new();

        // Register some messages
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);
        manager.register_message("msg-2", 2);

        // Create a branch
        let branch_id = manager
            .branch_at("msg-1", Some("Alternative path"))
            .unwrap();

        assert_eq!(manager.list_branches().len(), 1);

        // Switch to branch
        assert!(manager.switch_to(Some(branch_id.clone())));
        assert_eq!(manager.active_fork_index(), Some(1));

        // Switch back to main
        assert!(manager.switch_to(None));
        assert_eq!(manager.active_fork_index(), None);
    }

    #[test]
    fn test_branch_manager_invalid_switch() {
        let mut manager = BranchManager::new();

        // Try to switch to non-existent branch
        assert!(!manager.switch_to(Some("nonexistent".to_string())));
    }
}

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
        assert_eq!(branch.description.unwrap(), "Testing alternative approach");
    }

    #[test]
    fn test_branch_point_with_tags() {
        let branch = BranchPoint::new("msg-1", 0)
            .with_description("Experimental")
            .with_tags(vec!["experiment".to_string(), "v2".to_string()]);

        assert_eq!(branch.tags.len(), 2);
        assert!(branch.tags.contains(&"experiment".to_string()));
        assert!(branch.tags.contains(&"v2".to_string()));
    }

    #[test]
    fn test_branch_point_created_at() {
        let branch = BranchPoint::new("msg-1", 0);
        // Timestamp should be recent (within last second)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(branch.created_at <= now);
        assert!(branch.created_at > now - 1000); // within last second
    }

    #[test]
    fn test_branch_point_unique_ids() {
        let branch1 = BranchPoint::new("msg-1", 0);
        let branch2 = BranchPoint::new("msg-1", 0);
        assert_ne!(branch1.id, branch2.id);
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
    fn test_branch_metadata_default() {
        let metadata = BranchMetadata::default();
        assert!(metadata.branches.is_empty());
        assert!(metadata.active_branch.is_none());
        assert!(metadata.parent_session.is_none());
        assert!(metadata.parent_branch.is_none());
    }

    #[test]
    fn test_branch_metadata_multiple_branches() {
        let mut metadata = BranchMetadata::new();

        let id1 = metadata.add_branch(BranchPoint::new("msg-1", 1));
        let id2 = metadata.add_branch(BranchPoint::new("msg-2", 2));
        let id3 = metadata.add_branch(BranchPoint::new("msg-3", 3));

        assert_eq!(metadata.list_branches().len(), 3);
        assert!(metadata.get_branch(&id1).is_some());
        assert!(metadata.get_branch(&id2).is_some());
        assert!(metadata.get_branch(&id3).is_some());
        assert!(metadata.get_branch("nonexistent").is_none());
    }

    #[test]
    fn test_branch_metadata_active_branch() {
        let mut metadata = BranchMetadata::new();

        let id1 = metadata.add_branch(BranchPoint::new("msg-1", 1));

        assert!(metadata.get_active_branch().is_none());

        metadata.set_active_branch(Some(id1.clone()));
        assert!(metadata.get_active_branch().is_some());
        assert_eq!(metadata.get_active_branch().unwrap().id, id1);

        metadata.set_active_branch(None);
        assert!(metadata.get_active_branch().is_none());
    }

    #[test]
    fn test_branch_metadata_is_branched_with_parent() {
        let mut metadata = BranchMetadata::new();
        assert!(!metadata.is_branched());

        // Adding a parent session also makes it "branched"
        metadata.parent_session = Some("parent-session-id".to_string());
        assert!(metadata.is_branched());
    }

    #[test]
    fn test_branch_metadata_lineage() {
        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-1", 1));

        // No active branch = empty lineage
        assert!(metadata.lineage().is_empty());

        // With active branch
        metadata.set_active_branch(Some(id.clone()));
        let lineage = metadata.lineage();
        assert_eq!(lineage.len(), 1);
        assert_eq!(lineage[0].id, id);
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

    #[test]
    fn test_branch_manager_from_metadata() {
        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-5", 5));
        metadata.set_active_branch(Some(id.clone()));

        let manager = BranchManager::from_metadata(metadata);
        assert_eq!(manager.metadata().list_branches().len(), 1);
        assert!(manager.metadata().get_active_branch().is_some());
    }

    #[test]
    fn test_branch_manager_branch_at_nonexistent_message() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);

        // Try to branch at unregistered message
        assert!(manager.branch_at("msg-unknown", None).is_none());
    }

    #[test]
    fn test_branch_manager_multiple_branches_at_same_message() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);

        let id1 = manager.branch_at("msg-1", Some("Branch A")).unwrap();
        let id2 = manager.branch_at("msg-1", Some("Branch B")).unwrap();

        assert_ne!(id1, id2);
        assert_eq!(manager.list_branches().len(), 2);

        // Both branches should fork at index 1
        let branches = manager.list_branches();
        assert!(branches.iter().all(|b| b.fork_index == 1));
    }

    #[test]
    fn test_branch_manager_list_branches_is_active_flag() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);

        let id1 = manager.branch_at("msg-0", Some("Branch 1")).unwrap();
        let _id2 = manager.branch_at("msg-1", Some("Branch 2")).unwrap();

        // No active branch
        let branches = manager.list_branches();
        assert!(branches.iter().all(|b| !b.is_active));

        // Activate one branch
        manager.switch_to(Some(id1.clone()));
        let branches = manager.list_branches();
        let active_count = branches.iter().filter(|b| b.is_active).count();
        assert_eq!(active_count, 1);
        assert!(branches.iter().find(|b| b.id == id1).unwrap().is_active);
    }

    #[test]
    fn test_branch_summary_fields() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-5", 5);

        let id = manager
            .branch_at("msg-5", Some("Test description"))
            .unwrap();
        manager.switch_to(Some(id.clone()));

        let summaries = manager.list_branches();
        assert_eq!(summaries.len(), 1);

        let summary = &summaries[0];
        assert_eq!(summary.id, id);
        assert_eq!(summary.description, Some("Test description".to_string()));
        assert_eq!(summary.fork_index, 5);
        assert!(summary.is_active);
        assert!(summary.created_at > 0);
    }

    #[test]
    fn test_branch_manager_overwrite_message_index() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-0", 5); // Overwrite

        let id = manager.branch_at("msg-0", None).unwrap();
        manager.switch_to(Some(id));

        // Should use the latest registered index
        assert_eq!(manager.active_fork_index(), Some(5));
    }

    #[test]
    fn test_branch_manager_metadata_accessor() {
        let manager = BranchManager::new();
        let metadata = manager.metadata();
        assert!(metadata.branches.is_empty());
    }

    #[test]
    fn test_branch_serialization() {
        let branch = BranchPoint::new("msg-1", 1)
            .with_description("Test")
            .with_tags(vec!["tag1".to_string()]);

        let json = serde_json::to_string(&branch).unwrap();
        let deserialized: BranchPoint = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, branch.id);
        assert_eq!(deserialized.fork_message_id, branch.fork_message_id);
        assert_eq!(deserialized.fork_index, branch.fork_index);
        assert_eq!(deserialized.description, branch.description);
        assert_eq!(deserialized.tags, branch.tags);
    }

    #[test]
    fn test_branch_metadata_serialization() {
        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some(id.clone()));
        metadata.parent_session = Some("parent-123".to_string());

        let json = serde_json::to_string(&metadata).unwrap();
        let deserialized: BranchMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.branches.len(), 1);
        assert_eq!(deserialized.active_branch, Some(id));
        assert_eq!(deserialized.parent_session, Some("parent-123".to_string()));
    }

    #[test]
    fn test_branch_summary_serialization() {
        let summary = BranchSummary {
            id: "branch-123".to_string(),
            description: Some("Test".to_string()),
            fork_index: 5,
            created_at: 1234567890,
            is_active: true,
        };

        let json = serde_json::to_string(&summary).unwrap();
        let deserialized: BranchSummary = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, summary.id);
        assert_eq!(deserialized.description, summary.description);
        assert_eq!(deserialized.fork_index, summary.fork_index);
        assert_eq!(deserialized.created_at, summary.created_at);
        assert_eq!(deserialized.is_active, summary.is_active);
    }
}

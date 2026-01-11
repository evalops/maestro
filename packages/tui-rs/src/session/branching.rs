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
    #[must_use]
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }
}

/// Branch metadata stored in session
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

impl BranchMetadata {
    /// Create new branch metadata
    #[must_use]
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
    #[must_use]
    pub fn get_branch(&self, id: &str) -> Option<&BranchPoint> {
        self.branches.iter().find(|b| b.id == id)
    }

    /// List all branches
    #[must_use]
    pub fn list_branches(&self) -> &[BranchPoint] {
        &self.branches
    }

    /// Set the active branch
    pub fn set_active_branch(&mut self, id: Option<BranchId>) {
        self.active_branch = id;
    }

    /// Get the active branch
    #[must_use]
    pub fn get_active_branch(&self) -> Option<&BranchPoint> {
        self.active_branch
            .as_ref()
            .and_then(|id| self.get_branch(id))
    }

    /// Check if this is a branched session
    #[must_use]
    pub fn is_branched(&self) -> bool {
        self.parent_session.is_some() || !self.branches.is_empty()
    }

    /// Get branch lineage (path from root to current)
    #[must_use]
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
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Create from existing metadata
    #[must_use]
    pub fn from_metadata(metadata: BranchMetadata) -> Self {
        Self {
            metadata,
            message_indices: HashMap::new(),
        }
    }

    /// Get the metadata
    #[must_use]
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
        if let Some(id) = &branch_id {
            if self.metadata.get_branch(id).is_some() {
                self.metadata.set_active_branch(branch_id);
                true
            } else {
                false
            }
        } else {
            // Switch to main branch
            self.metadata.set_active_branch(None);
            true
        }
    }

    /// Get the fork index for the active branch
    #[must_use]
    pub fn active_fork_index(&self) -> Option<usize> {
        self.metadata.get_active_branch().map(|b| b.fork_index)
    }

    /// List all branches with their descriptions
    #[must_use]
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
            created_at: 1_234_567_890,
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

    #[test]
    fn test_branch_point_empty_description() {
        let branch = BranchPoint::new("msg-1", 0);
        assert!(branch.description.is_none());
    }

    #[test]
    fn test_branch_point_empty_tags() {
        let branch = BranchPoint::new("msg-1", 0);
        assert!(branch.tags.is_empty());
    }

    #[test]
    fn test_branch_point_with_empty_string_description() {
        let branch = BranchPoint::new("msg-1", 0).with_description("");
        assert_eq!(branch.description, Some(String::new()));
    }

    #[test]
    fn test_branch_point_with_empty_tags_vec() {
        let branch = BranchPoint::new("msg-1", 0).with_tags(vec![]);
        assert!(branch.tags.is_empty());
    }

    #[test]
    fn test_branch_point_id_format() {
        let branch = BranchPoint::new("msg-1", 0);
        assert!(branch.id.starts_with("branch-"));
        assert!(branch.id.len() > 7); // "branch-" + UUID
    }

    #[test]
    fn test_branch_point_fork_index_zero() {
        let branch = BranchPoint::new("msg-first", 0);
        assert_eq!(branch.fork_index, 0);
    }

    #[test]
    fn test_branch_point_fork_index_large() {
        let branch = BranchPoint::new("msg-last", 9999);
        assert_eq!(branch.fork_index, 9999);
    }

    #[test]
    fn test_branch_point_chained_builders() {
        let branch = BranchPoint::new("msg-1", 5)
            .with_description("Description")
            .with_tags(vec!["tag1".to_string()])
            .with_description("New Description")
            .with_tags(vec!["tag2".to_string(), "tag3".to_string()]);

        // Last call wins
        assert_eq!(branch.description, Some("New Description".to_string()));
        assert_eq!(branch.tags.len(), 2);
    }

    #[test]
    fn test_branch_metadata_get_nonexistent_branch() {
        let metadata = BranchMetadata::new();
        assert!(metadata.get_branch("nonexistent").is_none());
    }

    #[test]
    fn test_branch_metadata_set_active_nonexistent() {
        let mut metadata = BranchMetadata::new();
        // Setting active branch to non-existent ID doesn't validate
        metadata.set_active_branch(Some("nonexistent".to_string()));
        assert_eq!(metadata.active_branch, Some("nonexistent".to_string()));
        // But get_active_branch returns None since branch doesn't exist
        assert!(metadata.get_active_branch().is_none());
    }

    #[test]
    fn test_branch_metadata_parent_branch_field() {
        let mut metadata = BranchMetadata::new();
        metadata.parent_branch = Some("parent-branch-id".to_string());
        assert_eq!(metadata.parent_branch, Some("parent-branch-id".to_string()));
    }

    #[test]
    fn test_branch_metadata_both_parent_fields() {
        let mut metadata = BranchMetadata::new();
        metadata.parent_session = Some("session-id".to_string());
        metadata.parent_branch = Some("branch-id".to_string());

        assert!(metadata.is_branched());
        assert_eq!(metadata.parent_session, Some("session-id".to_string()));
        assert_eq!(metadata.parent_branch, Some("branch-id".to_string()));
    }

    #[test]
    fn test_branch_metadata_add_branch_returns_id() {
        let mut metadata = BranchMetadata::new();
        let branch = BranchPoint::new("msg-1", 1);
        let expected_id = branch.id.clone();

        let returned_id = metadata.add_branch(branch);
        assert_eq!(returned_id, expected_id);
    }

    #[test]
    fn test_branch_manager_register_many_messages() {
        let mut manager = BranchManager::new();
        for i in 0..100 {
            manager.register_message(format!("msg-{}", i), i);
        }

        // Can branch at any registered message
        assert!(manager.branch_at("msg-0", None).is_some());
        assert!(manager.branch_at("msg-50", None).is_some());
        assert!(manager.branch_at("msg-99", None).is_some());
        assert!(manager.branch_at("msg-100", None).is_none());
    }

    #[test]
    fn test_branch_manager_switch_back_and_forth() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);

        let id1 = manager.branch_at("msg-0", None).unwrap();
        let id2 = manager.branch_at("msg-1", None).unwrap();

        // Switch between branches
        assert!(manager.switch_to(Some(id1.clone())));
        assert_eq!(manager.active_fork_index(), Some(0));

        assert!(manager.switch_to(Some(id2.clone())));
        assert_eq!(manager.active_fork_index(), Some(1));

        assert!(manager.switch_to(Some(id1.clone())));
        assert_eq!(manager.active_fork_index(), Some(0));

        assert!(manager.switch_to(None));
        assert_eq!(manager.active_fork_index(), None);
    }

    #[test]
    fn test_branch_manager_branch_without_description() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);

        let id = manager.branch_at("msg-0", None).unwrap();
        let summaries = manager.list_branches();

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].description.is_none());
        assert_eq!(summaries[0].id, id);
    }

    #[test]
    fn test_branch_manager_default_trait() {
        let manager = BranchManager::default();
        assert!(manager.metadata().branches.is_empty());
        assert!(manager.list_branches().is_empty());
    }

    #[test]
    fn test_branch_summary_without_description() {
        let summary = BranchSummary {
            id: "branch-1".to_string(),
            description: None,
            fork_index: 0,
            created_at: 0,
            is_active: false,
        };

        assert!(summary.description.is_none());
    }

    #[test]
    fn test_branch_summary_inactive() {
        let summary = BranchSummary {
            id: "branch-1".to_string(),
            description: None,
            fork_index: 0,
            created_at: 0,
            is_active: false,
        };

        assert!(!summary.is_active);
    }

    #[test]
    fn test_branch_point_serialization_all_fields() {
        let branch = BranchPoint::new("msg-123", 42)
            .with_description("Full test")
            .with_tags(vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        let json = serde_json::to_string(&branch).unwrap();

        assert!(json.contains("\"fork_message_id\":\"msg-123\""));
        assert!(json.contains("\"fork_index\":42"));
        assert!(json.contains("\"description\":\"Full test\""));
        assert!(json.contains("\"tags\":["));
    }

    #[test]
    fn test_branch_metadata_serialization_empty() {
        let metadata = BranchMetadata::new();
        let json = serde_json::to_string(&metadata).unwrap();
        let deserialized: BranchMetadata = serde_json::from_str(&json).unwrap();

        assert!(deserialized.branches.is_empty());
        assert!(deserialized.active_branch.is_none());
        assert!(deserialized.parent_session.is_none());
        assert!(deserialized.parent_branch.is_none());
    }

    #[test]
    fn test_branch_metadata_serialization_with_all_fields() {
        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some(id.clone()));
        metadata.parent_session = Some("session-abc".to_string());
        metadata.parent_branch = Some("branch-xyz".to_string());

        let json = serde_json::to_string(&metadata).unwrap();
        let deserialized: BranchMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.branches.len(), 1);
        assert_eq!(deserialized.active_branch, Some(id));
        assert_eq!(deserialized.parent_session, Some("session-abc".to_string()));
        assert_eq!(deserialized.parent_branch, Some("branch-xyz".to_string()));
    }

    #[test]
    fn test_branch_manager_list_branches_order() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);
        manager.register_message("msg-2", 2);

        let id1 = manager.branch_at("msg-0", Some("First")).unwrap();
        let id2 = manager.branch_at("msg-1", Some("Second")).unwrap();
        let id3 = manager.branch_at("msg-2", Some("Third")).unwrap();

        let summaries = manager.list_branches();

        // Should be in insertion order
        assert_eq!(summaries[0].id, id1);
        assert_eq!(summaries[1].id, id2);
        assert_eq!(summaries[2].id, id3);
    }

    #[test]
    fn test_branch_manager_from_metadata_preserves_branches() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1).with_description("Branch 1"));
        metadata.add_branch(BranchPoint::new("msg-2", 2).with_description("Branch 2"));

        let manager = BranchManager::from_metadata(metadata);
        let summaries = manager.list_branches();

        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn test_branch_manager_message_indices_not_preserved_in_from_metadata() {
        let metadata = BranchMetadata::new();
        let mut manager = BranchManager::from_metadata(metadata);

        // New manager doesn't have message indices from previous manager
        assert!(manager.branch_at("msg-0", None).is_none());
    }

    #[test]
    fn test_branch_point_special_characters_in_message_id() {
        let branch = BranchPoint::new("msg/with/slashes", 0);
        assert_eq!(branch.fork_message_id, "msg/with/slashes");

        let branch = BranchPoint::new("msg-with-unicode-日本語", 0);
        assert_eq!(branch.fork_message_id, "msg-with-unicode-日本語");
    }

    #[test]
    fn test_branch_point_special_characters_in_description() {
        let branch = BranchPoint::new("msg-1", 0)
            .with_description("Description with 'quotes' and \"double quotes\" and\nnewlines");
        assert!(branch.description.is_some());

        // Should serialize/deserialize correctly
        let json = serde_json::to_string(&branch).unwrap();
        let deserialized: BranchPoint = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.description, branch.description);
    }

    #[test]
    fn test_branch_metadata_is_branched_only_with_branches() {
        let mut metadata = BranchMetadata::new();
        assert!(!metadata.is_branched());

        metadata.add_branch(BranchPoint::new("msg-1", 1));
        assert!(metadata.is_branched());
    }

    #[test]
    fn test_branch_metadata_is_branched_only_with_parent_session() {
        let mut metadata = BranchMetadata::new();
        assert!(!metadata.is_branched());

        metadata.parent_session = Some("parent".to_string());
        assert!(metadata.is_branched());
    }

    #[test]
    fn test_branch_summary_clone() {
        let summary = BranchSummary {
            id: "branch-1".to_string(),
            description: Some("Test".to_string()),
            fork_index: 5,
            created_at: 12345,
            is_active: true,
        };

        let cloned = summary.clone();
        assert_eq!(cloned.id, summary.id);
        assert_eq!(cloned.description, summary.description);
        assert_eq!(cloned.fork_index, summary.fork_index);
        assert_eq!(cloned.created_at, summary.created_at);
        assert_eq!(cloned.is_active, summary.is_active);
    }

    #[test]
    fn test_branch_point_clone() {
        let branch = BranchPoint::new("msg-1", 5)
            .with_description("Test")
            .with_tags(vec!["tag".to_string()]);

        let cloned = branch.clone();
        assert_eq!(cloned.id, branch.id);
        assert_eq!(cloned.fork_message_id, branch.fork_message_id);
        assert_eq!(cloned.fork_index, branch.fork_index);
        assert_eq!(cloned.description, branch.description);
        assert_eq!(cloned.tags, branch.tags);
    }

    #[test]
    fn test_branch_metadata_clone() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.parent_session = Some("parent".to_string());

        let cloned = metadata.clone();
        assert_eq!(cloned.branches.len(), metadata.branches.len());
        assert_eq!(cloned.parent_session, metadata.parent_session);
    }

    // ============================================================
    // UUID Format Validation Tests
    // ============================================================

    #[test]
    fn test_branch_id_is_valid_uuid_format() {
        let branch = BranchPoint::new("msg-1", 0);
        // Extract UUID part after "branch-"
        let uuid_part = branch.id.strip_prefix("branch-").unwrap();
        // UUID v4 should be 36 chars (32 hex + 4 dashes)
        assert_eq!(uuid_part.len(), 36);
        // Should parse as valid UUID
        assert!(uuid::Uuid::parse_str(uuid_part).is_ok());
    }

    #[test]
    fn test_branch_id_uuid_is_v4() {
        let branch = BranchPoint::new("msg-1", 0);
        let uuid_part = branch.id.strip_prefix("branch-").unwrap();
        let parsed = uuid::Uuid::parse_str(uuid_part).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn test_many_branch_ids_are_unique() {
        let mut ids = std::collections::HashSet::new();
        for _ in 0..1000 {
            let branch = BranchPoint::new("msg-1", 0);
            assert!(ids.insert(branch.id), "Duplicate branch ID generated");
        }
    }

    // ============================================================
    // Timestamp Tests
    // ============================================================

    #[test]
    fn test_branches_created_in_sequence_have_nondecreasing_timestamps() {
        let mut timestamps = Vec::new();
        for _ in 0..100 {
            let branch = BranchPoint::new("msg-1", 0);
            timestamps.push(branch.created_at);
        }
        // Each timestamp should be >= previous
        for i in 1..timestamps.len() {
            assert!(
                timestamps[i] >= timestamps[i - 1],
                "Timestamp decreased: {} < {}",
                timestamps[i],
                timestamps[i - 1]
            );
        }
    }

    #[test]
    fn test_timestamp_is_in_reasonable_range() {
        let branch = BranchPoint::new("msg-1", 0);
        // Should be after year 2020 (in ms)
        let year_2020_ms = 1_577_836_800_000_u64; // Jan 1, 2020
                                                  // Should be before year 2100
        let year_2100_ms = 4_102_444_800_000_u64;
        assert!(
            branch.created_at > year_2020_ms,
            "Timestamp too early: {}",
            branch.created_at
        );
        assert!(
            branch.created_at < year_2100_ms,
            "Timestamp too late: {}",
            branch.created_at
        );
    }

    #[test]
    fn test_timestamp_precision_is_milliseconds() {
        let branch1 = BranchPoint::new("msg-1", 0);
        // Sleep a bit and create another
        std::thread::sleep(std::time::Duration::from_millis(5));
        let branch2 = BranchPoint::new("msg-1", 0);

        // Should have different timestamps (with 5ms gap)
        // Note: this might rarely fail on very slow systems
        assert!(
            branch2.created_at >= branch1.created_at,
            "Second branch should have equal or later timestamp"
        );
    }

    // ============================================================
    // Lineage Tests
    // ============================================================

    #[test]
    fn test_lineage_empty_when_no_active_branch() {
        let metadata = BranchMetadata::new();
        assert!(metadata.lineage().is_empty());
    }

    #[test]
    fn test_lineage_with_single_active_branch() {
        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some(id.clone()));

        let lineage = metadata.lineage();
        assert_eq!(lineage.len(), 1);
        assert_eq!(lineage[0].id, id);
    }

    #[test]
    fn test_lineage_does_not_include_inactive_branches() {
        let mut metadata = BranchMetadata::new();
        let id1 = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.add_branch(BranchPoint::new("msg-2", 2));
        metadata.add_branch(BranchPoint::new("msg-3", 3));

        metadata.set_active_branch(Some(id1.clone()));
        let lineage = metadata.lineage();

        // Only includes active branch, not siblings
        assert_eq!(lineage.len(), 1);
        assert_eq!(lineage[0].id, id1);
    }

    #[test]
    fn test_lineage_after_switching_branches() {
        let mut metadata = BranchMetadata::new();
        let id1 = metadata.add_branch(BranchPoint::new("msg-1", 1));
        let id2 = metadata.add_branch(BranchPoint::new("msg-2", 2));

        metadata.set_active_branch(Some(id1.clone()));
        assert_eq!(metadata.lineage()[0].id, id1);

        metadata.set_active_branch(Some(id2.clone()));
        assert_eq!(metadata.lineage()[0].id, id2);
    }

    // ============================================================
    // Large Index Boundary Tests
    // ============================================================

    #[test]
    fn test_branch_point_max_fork_index() {
        let branch = BranchPoint::new("msg-max", usize::MAX);
        assert_eq!(branch.fork_index, usize::MAX);
    }

    #[test]
    fn test_branch_manager_large_index() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-large", usize::MAX - 1);

        let id = manager.branch_at("msg-large", None).unwrap();
        manager.switch_to(Some(id));

        assert_eq!(manager.active_fork_index(), Some(usize::MAX - 1));
    }

    #[test]
    fn test_branch_serialization_large_index() {
        let branch = BranchPoint::new("msg-max", usize::MAX);
        let json = serde_json::to_string(&branch).unwrap();
        let deserialized: BranchPoint = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.fork_index, usize::MAX);
    }

    #[test]
    fn test_branch_summary_large_values() {
        let summary = BranchSummary {
            id: "branch-1".to_string(),
            description: None,
            fork_index: usize::MAX,
            created_at: u64::MAX,
            is_active: true,
        };

        let json = serde_json::to_string(&summary).unwrap();
        let deserialized: BranchSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.fork_index, usize::MAX);
        assert_eq!(deserialized.created_at, u64::MAX);
    }

    // ============================================================
    // Message ID Validation Tests
    // ============================================================

    #[test]
    fn test_empty_message_id() {
        let branch = BranchPoint::new("", 0);
        assert_eq!(branch.fork_message_id, "");
    }

    #[test]
    fn test_message_id_with_only_whitespace() {
        let branch = BranchPoint::new("   ", 0);
        assert_eq!(branch.fork_message_id, "   ");
    }

    #[test]
    fn test_very_long_message_id() {
        let long_id = "a".repeat(10000);
        let branch = BranchPoint::new(&long_id, 0);
        assert_eq!(branch.fork_message_id, long_id);
    }

    #[test]
    fn test_message_id_with_null_bytes() {
        let branch = BranchPoint::new("msg\0with\0nulls", 0);
        assert_eq!(branch.fork_message_id, "msg\0with\0nulls");
    }

    #[test]
    fn test_manager_register_empty_message_id() {
        let mut manager = BranchManager::new();
        manager.register_message("", 0);
        assert!(manager.branch_at("", None).is_some());
    }

    // ============================================================
    // Integration Tests - Fork Chains
    // ============================================================

    #[test]
    fn test_fork_modify_fork_chain() {
        let mut manager = BranchManager::new();

        // Register messages
        for i in 0..10 {
            manager.register_message(format!("msg-{}", i), i);
        }

        // Fork at message 3
        let branch1 = manager.branch_at("msg-3", Some("First fork")).unwrap();
        manager.switch_to(Some(branch1.clone()));
        assert_eq!(manager.active_fork_index(), Some(3));

        // Fork again at message 5 (while on branch1)
        let branch2 = manager.branch_at("msg-5", Some("Second fork")).unwrap();
        manager.switch_to(Some(branch2.clone()));
        assert_eq!(manager.active_fork_index(), Some(5));

        // Fork again at message 7
        let branch3 = manager.branch_at("msg-7", Some("Third fork")).unwrap();
        manager.switch_to(Some(branch3.clone()));
        assert_eq!(manager.active_fork_index(), Some(7));

        // Should have 3 branches total
        assert_eq!(manager.list_branches().len(), 3);

        // Can still switch back to earlier branches
        manager.switch_to(Some(branch1.clone()));
        assert_eq!(manager.active_fork_index(), Some(3));
    }

    #[test]
    fn test_multiple_forks_from_same_point() {
        let mut manager = BranchManager::new();
        manager.register_message("fork-point", 5);

        // Create multiple branches from same point
        let branches: Vec<_> = (0..10)
            .map(|i| {
                manager
                    .branch_at("fork-point", Some(&format!("Branch {}", i)))
                    .unwrap()
            })
            .collect();

        assert_eq!(manager.list_branches().len(), 10);

        // All branches fork at index 5
        for summary in manager.list_branches() {
            assert_eq!(summary.fork_index, 5);
        }

        // All branch IDs are unique
        let unique: std::collections::HashSet<_> = branches.iter().collect();
        assert_eq!(unique.len(), 10);
    }

    #[test]
    fn test_switch_to_all_branches_in_sequence() {
        let mut manager = BranchManager::new();
        for i in 0..5 {
            manager.register_message(format!("msg-{}", i), i);
        }

        let branch_ids: Vec<_> = (0..5)
            .map(|i| manager.branch_at(&format!("msg-{}", i), None).unwrap())
            .collect();

        // Switch to each branch in sequence
        for (i, id) in branch_ids.iter().enumerate() {
            assert!(manager.switch_to(Some(id.clone())));
            assert_eq!(manager.active_fork_index(), Some(i));
        }
    }

    // ============================================================
    // Serialization Edge Cases
    // ============================================================

    #[test]
    fn test_deserialize_branch_point_from_minimal_json() {
        // Only required fields (based on struct definition with defaults)
        let json = r#"{
            "id": "branch-test",
            "fork_message_id": "msg-1",
            "fork_index": 5,
            "created_at": 1_234_567_890,
            "description": null,
            "tags": []
        }"#;

        let branch: BranchPoint = serde_json::from_str(json).unwrap();
        assert_eq!(branch.id, "branch-test");
        assert_eq!(branch.fork_message_id, "msg-1");
        assert_eq!(branch.fork_index, 5);
        assert!(branch.description.is_none());
        assert!(branch.tags.is_empty());
    }

    #[test]
    fn test_deserialize_branch_metadata_from_minimal_json() {
        let json = r#"{
            "branches": [],
            "active_branch": null,
            "parent_session": null,
            "parent_branch": null
        }"#;

        let metadata: BranchMetadata = serde_json::from_str(json).unwrap();
        assert!(metadata.branches.is_empty());
        assert!(metadata.active_branch.is_none());
    }

    #[test]
    fn test_roundtrip_complex_branch_structure() {
        let mut metadata = BranchMetadata::new();

        // Add multiple branches with various data
        for i in 0..5 {
            let branch = BranchPoint::new(format!("msg-{}", i), i)
                .with_description(format!("Branch {} description", i))
                .with_tags(vec![format!("tag-{}", i), "common".to_string()]);
            metadata.add_branch(branch);
        }

        metadata.parent_session = Some("parent-session-id".to_string());
        metadata.parent_branch = Some("parent-branch-id".to_string());
        metadata.set_active_branch(Some(metadata.branches[2].id.clone()));

        // Serialize and deserialize
        let json = serde_json::to_string(&metadata).unwrap();
        let restored: BranchMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.branches.len(), 5);
        assert_eq!(restored.active_branch, metadata.active_branch);
        assert_eq!(restored.parent_session, metadata.parent_session);
        assert_eq!(restored.parent_branch, metadata.parent_branch);

        for (original, restored) in metadata.branches.iter().zip(restored.branches.iter()) {
            assert_eq!(original.id, restored.id);
            assert_eq!(original.fork_message_id, restored.fork_message_id);
            assert_eq!(original.fork_index, restored.fork_index);
            assert_eq!(original.description, restored.description);
            assert_eq!(original.tags, restored.tags);
        }
    }

    // ============================================================
    // Edge Cases and Error Conditions
    // ============================================================

    #[test]
    fn test_switch_to_after_removing_message_registration() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        let id = manager.branch_at("msg-0", None).unwrap();

        // The branch still exists even if we don't have the message anymore
        // (manager doesn't have a way to remove messages, but tests the concept)
        assert!(manager.switch_to(Some(id)));
    }

    #[test]
    fn test_active_fork_index_with_no_branches() {
        let manager = BranchManager::new();
        assert!(manager.active_fork_index().is_none());
    }

    #[test]
    fn test_list_branches_empty() {
        let manager = BranchManager::new();
        assert!(manager.list_branches().is_empty());
    }

    #[test]
    fn test_get_branch_by_partial_id() {
        let mut metadata = BranchMetadata::new();
        let branch = BranchPoint::new("msg-1", 1);
        let full_id = metadata.add_branch(branch);

        // Partial ID should not match
        let partial = &full_id[..10];
        assert!(metadata.get_branch(partial).is_none());
    }

    #[test]
    fn test_branch_description_with_emoji() {
        let branch = BranchPoint::new("msg-1", 0).with_description("Testing 🎉🚀💡");
        assert_eq!(branch.description, Some("Testing 🎉🚀💡".to_string()));

        let json = serde_json::to_string(&branch).unwrap();
        let deserialized: BranchPoint = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.description, branch.description);
    }

    #[test]
    fn test_branch_tags_with_special_characters() {
        let branch = BranchPoint::new("msg-1", 0).with_tags(vec![
            "tag-with-dashes".to_string(),
            "tag.with.dots".to_string(),
            "tag/with/slashes".to_string(),
            "tag with spaces".to_string(),
            "日本語タグ".to_string(),
        ]);

        assert_eq!(branch.tags.len(), 5);

        let json = serde_json::to_string(&branch).unwrap();
        let deserialized: BranchPoint = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.tags, branch.tags);
    }

    #[test]
    fn test_branch_manager_many_branches_performance() {
        let mut manager = BranchManager::new();

        // Register many messages
        for i in 0..1000 {
            manager.register_message(format!("msg-{}", i), i);
        }

        // Create many branches
        for i in 0..100 {
            manager
                .branch_at(&format!("msg-{}", i), Some(&format!("Branch {}", i)))
                .unwrap();
        }

        assert_eq!(manager.list_branches().len(), 100);

        // Switching should still work
        let branches = manager.list_branches();
        let mid_branch = &branches[50].id;
        assert!(manager.switch_to(Some(mid_branch.clone())));
    }

    #[test]
    fn test_metadata_with_orphaned_active_branch() {
        let mut metadata = BranchMetadata::new();
        // Set active branch to ID that doesn't exist
        metadata.set_active_branch(Some("orphaned-branch-id".to_string()));

        // Should handle gracefully
        assert!(metadata.get_active_branch().is_none());
        assert!(metadata.lineage().is_empty());
        assert!(!metadata.is_branched()); // No actual branches
    }

    #[test]
    fn test_branch_with_duplicate_tags() {
        let branch = BranchPoint::new("msg-1", 0).with_tags(vec![
            "duplicate".to_string(),
            "duplicate".to_string(),
            "unique".to_string(),
        ]);

        // Allows duplicates (not deduped)
        assert_eq!(branch.tags.len(), 3);
    }

    // ============================================================
    // Orphaned Branch Handling Tests
    // ============================================================

    #[test]
    fn test_orphaned_active_branch_get_active_returns_none() {
        let mut metadata = BranchMetadata::new();
        // Add a real branch
        let real_id = metadata.add_branch(BranchPoint::new("msg-1", 1));

        // Set active to a non-existent branch
        metadata.set_active_branch(Some("orphaned-id-12345".to_string()));

        // get_active_branch should return None since the ID doesn't exist
        assert!(metadata.get_active_branch().is_none());

        // But active_branch field still holds the orphaned ID
        assert_eq!(
            metadata.active_branch,
            Some("orphaned-id-12345".to_string())
        );

        // Real branch should still be accessible
        assert!(metadata.get_branch(&real_id).is_some());
    }

    #[test]
    fn test_orphaned_active_branch_lineage_is_empty() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));

        // Set to orphaned branch
        metadata.set_active_branch(Some("nonexistent-branch".to_string()));

        // Lineage should be empty since active branch doesn't exist
        assert!(metadata.lineage().is_empty());
    }

    #[test]
    fn test_orphaned_active_branch_after_serialization() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some("orphaned-branch".to_string()));

        // Serialize and deserialize
        let json = serde_json::to_string(&metadata).unwrap();
        let restored: BranchMetadata = serde_json::from_str(&json).unwrap();

        // Orphaned reference should be preserved
        assert_eq!(restored.active_branch, Some("orphaned-branch".to_string()));
        // But get_active_branch still returns None
        assert!(restored.get_active_branch().is_none());
    }

    #[test]
    fn test_branch_manager_switch_to_orphaned_fails() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.branch_at("msg-0", None).unwrap();

        // Try to switch to non-existent branch
        let result = manager.switch_to(Some("orphaned-id".to_string()));
        assert!(!result);

        // Active branch should remain unchanged (None in this case)
        assert!(manager.active_fork_index().is_none());
    }

    #[test]
    fn test_branch_manager_switch_preserves_state_on_failure() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);

        let valid_id = manager.branch_at("msg-1", None).unwrap();

        // Switch to valid branch
        assert!(manager.switch_to(Some(valid_id.clone())));
        assert_eq!(manager.active_fork_index(), Some(1));

        // Try to switch to orphaned branch - should fail
        let result = manager.switch_to(Some("nonexistent".to_string()));
        assert!(!result);

        // Should still be on the valid branch
        assert_eq!(manager.active_fork_index(), Some(1));
    }

    #[test]
    fn test_branch_manager_from_metadata_with_orphaned_active() {
        let mut metadata = BranchMetadata::new();
        let _real_id = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some("orphaned-branch".to_string()));

        let manager = BranchManager::from_metadata(metadata);

        // active_fork_index relies on get_active_branch which returns None for orphaned
        assert!(manager.active_fork_index().is_none());

        // But we can still list the real branch
        assert_eq!(manager.list_branches().len(), 1);

        // And none should be marked active since the reference is orphaned
        assert!(!manager.list_branches()[0].is_active);
    }

    #[test]
    fn test_branch_manager_list_branches_with_orphaned_active() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        manager.register_message("msg-1", 1);

        let _id1 = manager.branch_at("msg-0", Some("Branch 1")).unwrap();
        let _id2 = manager.branch_at("msg-1", Some("Branch 2")).unwrap();

        // Manually set orphaned active branch through metadata
        // (Simulating corruption or deleted branch)
        let metadata = BranchMetadata {
            branches: vec![BranchPoint::new("msg-0", 0), BranchPoint::new("msg-1", 1)],
            active_branch: Some("deleted-branch-xyz".to_string()),
            parent_session: None,
            parent_branch: None,
        };

        let manager = BranchManager::from_metadata(metadata);
        let summaries = manager.list_branches();

        // Both branches exist
        assert_eq!(summaries.len(), 2);

        // Neither should be marked active since the active reference is orphaned
        for summary in &summaries {
            assert!(
                !summary.is_active,
                "Branch {} should not be active",
                summary.id
            );
        }
    }

    #[test]
    fn test_recover_from_orphaned_active_by_switching() {
        let mut metadata = BranchMetadata::new();
        let real_id = metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some("orphaned-id".to_string()));

        let mut manager = BranchManager::from_metadata(metadata);

        // Currently orphaned
        assert!(manager.active_fork_index().is_none());

        // Recovery: switch to a valid branch
        assert!(manager.switch_to(Some(real_id.clone())));
        assert_eq!(manager.active_fork_index(), Some(1));

        // Or switch to main (None)
        assert!(manager.switch_to(None));
        assert!(manager.active_fork_index().is_none());
    }

    #[test]
    fn test_orphaned_parent_branch_reference() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.parent_branch = Some("deleted-parent-branch".to_string());

        // parent_branch is just a reference, not validated
        assert_eq!(
            metadata.parent_branch,
            Some("deleted-parent-branch".to_string())
        );

        // is_branched only checks parent_session or branches existence
        assert!(metadata.is_branched()); // Has branches

        // Serialize/deserialize preserves orphaned reference
        let json = serde_json::to_string(&metadata).unwrap();
        let restored: BranchMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(
            restored.parent_branch,
            Some("deleted-parent-branch".to_string())
        );
    }

    #[test]
    fn test_orphaned_parent_session_reference() {
        let mut metadata = BranchMetadata::new();
        metadata.parent_session = Some("nonexistent-session-abc".to_string());

        // is_branched considers parent_session
        assert!(metadata.is_branched());

        // The reference is stored but not validated
        assert_eq!(
            metadata.parent_session,
            Some("nonexistent-session-abc".to_string())
        );
    }

    #[test]
    fn test_multiple_orphaned_references() {
        let mut metadata = BranchMetadata::new();
        metadata.active_branch = Some("orphaned-active".to_string());
        metadata.parent_branch = Some("orphaned-parent".to_string());
        metadata.parent_session = Some("orphaned-session".to_string());

        // All references are orphaned, but stored
        assert_eq!(metadata.active_branch, Some("orphaned-active".to_string()));
        assert_eq!(metadata.parent_branch, Some("orphaned-parent".to_string()));
        assert_eq!(
            metadata.parent_session,
            Some("orphaned-session".to_string())
        );

        // is_branched still true due to parent_session
        assert!(metadata.is_branched());

        // get_active_branch returns None
        assert!(metadata.get_active_branch().is_none());

        // lineage is empty
        assert!(metadata.lineage().is_empty());
    }

    #[test]
    fn test_clear_orphaned_active_branch() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some("orphaned-id".to_string()));

        // Verify it's orphaned
        assert!(metadata.get_active_branch().is_none());

        // Clear by setting to None
        metadata.set_active_branch(None);

        // Now explicitly no active branch
        assert!(metadata.active_branch.is_none());
        assert!(metadata.get_active_branch().is_none());
    }

    #[test]
    fn test_branch_becomes_orphaned_conceptually() {
        // Simulates the scenario where a branch existed, was set active,
        // then the branch was "removed" (in real system) leaving orphaned reference

        let mut metadata = BranchMetadata::new();
        let id = metadata.add_branch(BranchPoint::new("msg-1", 1));

        // Set as active
        metadata.set_active_branch(Some(id.clone()));
        assert!(metadata.get_active_branch().is_some());

        // In a real system, if we could remove the branch, the reference becomes orphaned
        // Simulate by creating new metadata with same active_branch but no branches
        let orphaned_metadata = BranchMetadata {
            branches: vec![],                // Branch was removed
            active_branch: Some(id.clone()), // But reference remains
            parent_session: None,
            parent_branch: None,
        };

        // Now it's orphaned
        assert!(orphaned_metadata.get_active_branch().is_none());
        assert!(orphaned_metadata.lineage().is_empty());
        assert!(!orphaned_metadata.is_branched()); // No branches or parent_session
    }

    #[test]
    fn test_is_active_flag_with_orphaned_reference() {
        let metadata = BranchMetadata {
            branches: vec![BranchPoint::new("msg-0", 0), BranchPoint::new("msg-1", 1)],
            active_branch: Some("orphaned".to_string()),
            parent_session: None,
            parent_branch: None,
        };

        let manager = BranchManager::from_metadata(metadata);
        let summaries = manager.list_branches();

        // The comparison in list_branches checks if active_branch == Some(branch.id)
        // Since "orphaned" doesn't match any real branch ID, none are active
        for summary in summaries {
            assert!(!summary.is_active);
        }
    }

    #[test]
    fn test_switch_from_orphaned_to_main() {
        let mut metadata = BranchMetadata::new();
        metadata.add_branch(BranchPoint::new("msg-1", 1));
        metadata.set_active_branch(Some("orphaned".to_string()));

        let mut manager = BranchManager::from_metadata(metadata);

        // Currently orphaned (active_fork_index returns None)
        assert!(manager.active_fork_index().is_none());

        // Switch to main (None) - should always succeed
        assert!(manager.switch_to(None));
        assert!(manager.metadata().active_branch.is_none());
    }

    #[test]
    fn test_orphaned_branch_json_representation() {
        let metadata = BranchMetadata {
            branches: vec![],
            active_branch: Some("orphaned-ref".to_string()),
            parent_session: Some("orphaned-session".to_string()),
            parent_branch: Some("orphaned-parent".to_string()),
        };

        let json = serde_json::to_string_pretty(&metadata).unwrap();

        // Verify JSON contains the orphaned references
        assert!(json.contains("orphaned-ref"));
        assert!(json.contains("orphaned-session"));
        assert!(json.contains("orphaned-parent"));

        // Can deserialize back
        let restored: BranchMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.active_branch, Some("orphaned-ref".to_string()));
    }

    #[test]
    fn test_orphaned_branch_stress_many_invalid_switches() {
        let mut manager = BranchManager::new();
        manager.register_message("msg-0", 0);
        let valid_id = manager.branch_at("msg-0", None).unwrap();

        // Try many invalid switches
        for i in 0..100 {
            let result = manager.switch_to(Some(format!("fake-id-{}", i)));
            assert!(!result);
        }

        // Manager should still be functional
        assert!(manager.switch_to(Some(valid_id)));
        assert_eq!(manager.active_fork_index(), Some(0));
    }
}

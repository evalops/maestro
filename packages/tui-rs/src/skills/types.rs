//! Skills Types
//!
//! Defines types for the skills system, allowing specialized behaviors
//! to be activated dynamically.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Unique identifier for a skill
pub type SkillId = String;

/// Source of a skill definition
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    /// Built into the application
    Builtin,
    /// Defined by the user
    User,
    /// Provided by a plugin
    Plugin,
    /// Loaded from a remote source
    Remote,
}

/// Skill definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    /// Unique identifier
    pub id: SkillId,
    /// Human-readable name
    pub name: String,
    /// Description of what the skill does
    pub description: String,
    /// Source of the skill
    pub source: SkillSource,
    /// Whether the skill is currently enabled
    pub enabled: bool,
    /// Version string
    pub version: Option<String>,
    /// Author information
    pub author: Option<String>,
    /// Additional metadata
    pub metadata: HashMap<String, serde_json::Value>,
    /// System prompt additions when skill is active
    pub system_prompt_additions: Option<String>,
    /// Tools provided by this skill
    pub provided_tools: Vec<String>,
    /// Trigger patterns that activate this skill
    pub trigger_patterns: Vec<String>,
}

impl SkillDefinition {
    /// Create a new skill definition
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            source: SkillSource::User,
            enabled: true,
            version: None,
            author: None,
            metadata: HashMap::new(),
            system_prompt_additions: None,
            provided_tools: Vec::new(),
            trigger_patterns: Vec::new(),
        }
    }

    /// Set description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// Set source
    pub fn with_source(mut self, source: SkillSource) -> Self {
        self.source = source;
        self
    }

    /// Add system prompt additions
    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt_additions = Some(prompt.into());
        self
    }

    /// Add provided tools
    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.provided_tools = tools;
        self
    }

    /// Add trigger patterns
    pub fn with_triggers(mut self, patterns: Vec<String>) -> Self {
        self.trigger_patterns = patterns;
        self
    }
}

/// Skill activation state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillActivationState {
    /// Skill is inactive
    Inactive,
    /// Skill is pending activation
    Activating,
    /// Skill is active
    Active,
    /// Skill is being deactivated
    Deactivating,
    /// Skill failed to activate
    Failed,
}

/// Runtime state of an activated skill
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSkill {
    /// Skill definition
    pub definition: SkillDefinition,
    /// Current activation state
    pub state: SkillActivationState,
    /// When the skill was activated
    pub activated_at: Option<u64>,
    /// Number of times the skill has been used
    pub usage_count: u64,
    /// Last error if activation failed
    pub last_error: Option<String>,
}

impl ActiveSkill {
    /// Create from a definition
    pub fn from_definition(definition: SkillDefinition) -> Self {
        Self {
            definition,
            state: SkillActivationState::Inactive,
            activated_at: None,
            usage_count: 0,
            last_error: None,
        }
    }

    /// Check if the skill is active
    pub fn is_active(&self) -> bool {
        self.state == SkillActivationState::Active
    }

    /// Mark as activated
    pub fn activate(&mut self) {
        self.state = SkillActivationState::Active;
        self.activated_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        );
    }

    /// Mark as deactivated
    pub fn deactivate(&mut self) {
        self.state = SkillActivationState::Inactive;
    }

    /// Increment usage count
    pub fn record_usage(&mut self) {
        self.usage_count += 1;
    }
}

/// Event emitted by the skills system
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SkillEvent {
    /// Skill was registered
    Registered { skill_id: SkillId },
    /// Skill was activated
    Activated { skill_id: SkillId },
    /// Skill was deactivated
    Deactivated { skill_id: SkillId },
    /// Skill was used
    Used { skill_id: SkillId, context: String },
    /// Skill activation failed
    ActivationFailed { skill_id: SkillId, error: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skill_definition_builder() {
        let skill = SkillDefinition::new("frontend-design", "Frontend Design")
            .with_description("Design web frontends with high quality")
            .with_source(SkillSource::Builtin)
            .with_tools(vec!["write".into(), "edit".into()])
            .with_triggers(vec!["design".into(), "frontend".into()]);

        assert_eq!(skill.id, "frontend-design");
        assert_eq!(skill.name, "Frontend Design");
        assert_eq!(skill.source, SkillSource::Builtin);
        assert_eq!(skill.provided_tools.len(), 2);
        assert_eq!(skill.trigger_patterns.len(), 2);
    }

    #[test]
    fn test_skill_definition_defaults() {
        let skill = SkillDefinition::new("test", "Test");

        assert_eq!(skill.id, "test");
        assert_eq!(skill.name, "Test");
        assert!(skill.description.is_empty());
        assert_eq!(skill.source, SkillSource::User);
        assert!(skill.enabled);
        assert!(skill.version.is_none());
        assert!(skill.author.is_none());
        assert!(skill.metadata.is_empty());
        assert!(skill.system_prompt_additions.is_none());
        assert!(skill.provided_tools.is_empty());
        assert!(skill.trigger_patterns.is_empty());
    }

    #[test]
    fn test_skill_definition_with_system_prompt() {
        let skill = SkillDefinition::new("test", "Test")
            .with_system_prompt("You are an expert at testing.");

        assert_eq!(
            skill.system_prompt_additions,
            Some("You are an expert at testing.".to_string())
        );
    }

    #[test]
    fn test_skill_source_variants() {
        assert_eq!(SkillSource::Builtin, SkillSource::Builtin);
        assert_ne!(SkillSource::Builtin, SkillSource::User);
        assert_ne!(SkillSource::User, SkillSource::Plugin);
        assert_ne!(SkillSource::Plugin, SkillSource::Remote);
    }

    #[test]
    fn test_skill_source_serialization() {
        let json = serde_json::to_string(&SkillSource::Builtin).unwrap();
        assert_eq!(json, "\"builtin\"");

        let json = serde_json::to_string(&SkillSource::User).unwrap();
        assert_eq!(json, "\"user\"");

        let json = serde_json::to_string(&SkillSource::Plugin).unwrap();
        assert_eq!(json, "\"plugin\"");

        let json = serde_json::to_string(&SkillSource::Remote).unwrap();
        assert_eq!(json, "\"remote\"");
    }

    #[test]
    fn test_skill_source_deserialization() {
        let builtin: SkillSource = serde_json::from_str("\"builtin\"").unwrap();
        assert_eq!(builtin, SkillSource::Builtin);

        let user: SkillSource = serde_json::from_str("\"user\"").unwrap();
        assert_eq!(user, SkillSource::User);
    }

    #[test]
    fn test_skill_activation_state_variants() {
        assert_eq!(
            SkillActivationState::Inactive,
            SkillActivationState::Inactive
        );
        assert_ne!(SkillActivationState::Inactive, SkillActivationState::Active);
        assert_ne!(
            SkillActivationState::Activating,
            SkillActivationState::Deactivating
        );
    }

    #[test]
    fn test_skill_activation_state_serialization() {
        let json = serde_json::to_string(&SkillActivationState::Inactive).unwrap();
        assert_eq!(json, "\"inactive\"");

        let json = serde_json::to_string(&SkillActivationState::Active).unwrap();
        assert_eq!(json, "\"active\"");

        let json = serde_json::to_string(&SkillActivationState::Failed).unwrap();
        assert_eq!(json, "\"failed\"");
    }

    #[test]
    fn test_active_skill_lifecycle() {
        let definition = SkillDefinition::new("test", "Test Skill");
        let mut active = ActiveSkill::from_definition(definition);

        assert!(!active.is_active());
        assert_eq!(active.usage_count, 0);

        active.activate();
        assert!(active.is_active());
        assert!(active.activated_at.is_some());

        active.record_usage();
        active.record_usage();
        assert_eq!(active.usage_count, 2);

        active.deactivate();
        assert!(!active.is_active());
    }

    #[test]
    fn test_active_skill_from_definition() {
        let definition = SkillDefinition::new("test", "Test")
            .with_description("A test skill")
            .with_source(SkillSource::Plugin);

        let active = ActiveSkill::from_definition(definition);

        assert_eq!(active.definition.id, "test");
        assert_eq!(active.definition.name, "Test");
        assert_eq!(active.definition.source, SkillSource::Plugin);
        assert_eq!(active.state, SkillActivationState::Inactive);
        assert!(active.activated_at.is_none());
        assert_eq!(active.usage_count, 0);
        assert!(active.last_error.is_none());
    }

    #[test]
    fn test_active_skill_activated_at_timestamp() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let activated = active.activated_at.unwrap();
        assert!(activated <= now);
        assert!(activated > now - 1000); // Within last second
    }

    #[test]
    fn test_active_skill_deactivate_preserves_data() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        active.record_usage();
        active.record_usage();
        active.record_usage();

        let activated_at = active.activated_at;

        active.deactivate();

        assert!(!active.is_active());
        // These should be preserved
        assert_eq!(active.usage_count, 3);
        assert_eq!(active.activated_at, activated_at);
    }

    #[test]
    fn test_skill_event_registered() {
        let event = SkillEvent::Registered {
            skill_id: "test".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"registered\""));
        assert!(json.contains("\"skill_id\":\"test\""));
    }

    #[test]
    fn test_skill_event_activated() {
        let event = SkillEvent::Activated {
            skill_id: "frontend".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"activated\""));
    }

    #[test]
    fn test_skill_event_deactivated() {
        let event = SkillEvent::Deactivated {
            skill_id: "frontend".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"deactivated\""));
    }

    #[test]
    fn test_skill_event_used() {
        let event = SkillEvent::Used {
            skill_id: "frontend".to_string(),
            context: "designing a button".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"used\""));
        assert!(json.contains("\"context\":\"designing a button\""));
    }

    #[test]
    fn test_skill_event_activation_failed() {
        let event = SkillEvent::ActivationFailed {
            skill_id: "broken".to_string(),
            error: "Missing dependency".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"activation_failed\""));
        assert!(json.contains("\"error\":\"Missing dependency\""));
    }

    #[test]
    fn test_skill_definition_serialization() {
        let skill = SkillDefinition::new("test", "Test Skill")
            .with_description("A test")
            .with_source(SkillSource::Builtin)
            .with_tools(vec!["read".to_string()])
            .with_triggers(vec!["test".to_string()]);

        let json = serde_json::to_string(&skill).unwrap();
        let deserialized: SkillDefinition = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, skill.id);
        assert_eq!(deserialized.name, skill.name);
        assert_eq!(deserialized.description, skill.description);
        assert_eq!(deserialized.source, skill.source);
        assert_eq!(deserialized.provided_tools, skill.provided_tools);
        assert_eq!(deserialized.trigger_patterns, skill.trigger_patterns);
    }

    #[test]
    fn test_active_skill_serialization() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);
        active.activate();
        active.record_usage();

        let json = serde_json::to_string(&active).unwrap();
        let deserialized: ActiveSkill = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.definition.id, "test");
        assert_eq!(deserialized.state, SkillActivationState::Active);
        assert_eq!(deserialized.usage_count, 1);
    }

    #[test]
    fn test_skill_definition_with_metadata() {
        let mut skill = SkillDefinition::new("test", "Test");
        skill
            .metadata
            .insert("key1".to_string(), serde_json::json!("value1"));
        skill
            .metadata
            .insert("key2".to_string(), serde_json::json!(42));

        assert_eq!(skill.metadata.len(), 2);
        assert_eq!(
            skill.metadata.get("key1").unwrap(),
            &serde_json::json!("value1")
        );
        assert_eq!(skill.metadata.get("key2").unwrap(), &serde_json::json!(42));
    }

    #[test]
    fn test_skill_definition_with_version_and_author() {
        let mut skill = SkillDefinition::new("test", "Test");
        skill.version = Some("1.0.0".to_string());
        skill.author = Some("Test Author".to_string());

        assert_eq!(skill.version, Some("1.0.0".to_string()));
        assert_eq!(skill.author, Some("Test Author".to_string()));
    }

    #[test]
    fn test_active_skill_last_error() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        assert!(active.last_error.is_none());

        active.last_error = Some("Something went wrong".to_string());
        active.state = SkillActivationState::Failed;

        assert!(active.last_error.is_some());
        assert_eq!(active.last_error.unwrap(), "Something went wrong");
        assert_eq!(active.state, SkillActivationState::Failed);
    }
}

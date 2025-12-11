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

    #[test]
    fn test_skill_definition_empty_name() {
        let skill = SkillDefinition::new("test-id", "");
        assert!(skill.name.is_empty());
        assert_eq!(skill.id, "test-id");
    }

    #[test]
    fn test_skill_definition_empty_id() {
        let skill = SkillDefinition::new("", "Test Name");
        assert!(skill.id.is_empty());
        assert_eq!(skill.name, "Test Name");
    }

    #[test]
    fn test_skill_definition_special_characters_in_id() {
        let skill = SkillDefinition::new("my-skill_v1.0", "My Skill");
        assert_eq!(skill.id, "my-skill_v1.0");
    }

    #[test]
    fn test_skill_definition_unicode_name() {
        let skill = SkillDefinition::new("japanese-skill", "日本語スキル");
        assert_eq!(skill.name, "日本語スキル");
    }

    #[test]
    fn test_skill_definition_long_description() {
        let long_desc = "A".repeat(10000);
        let skill = SkillDefinition::new("test", "Test").with_description(&long_desc);
        assert_eq!(skill.description.len(), 10000);
    }

    #[test]
    fn test_skill_definition_multiline_system_prompt() {
        let prompt = "Line 1\nLine 2\nLine 3\n\nWith blank line";
        let skill = SkillDefinition::new("test", "Test").with_system_prompt(prompt);
        assert_eq!(skill.system_prompt_additions, Some(prompt.to_string()));
    }

    #[test]
    fn test_skill_definition_duplicate_tools() {
        let skill = SkillDefinition::new("test", "Test").with_tools(vec![
            "read".into(),
            "read".into(),
            "write".into(),
        ]);
        assert_eq!(skill.provided_tools.len(), 3); // Duplicates allowed
    }

    #[test]
    fn test_skill_definition_duplicate_triggers() {
        let skill = SkillDefinition::new("test", "Test")
            .with_triggers(vec!["design".into(), "design".into()]);
        assert_eq!(skill.trigger_patterns.len(), 2); // Duplicates allowed
    }

    #[test]
    fn test_skill_definition_chained_with_calls() {
        let skill = SkillDefinition::new("test", "Test")
            .with_description("First")
            .with_source(SkillSource::Builtin)
            .with_description("Second") // Override
            .with_system_prompt("Prompt 1")
            .with_system_prompt("Prompt 2") // Override
            .with_tools(vec!["a".into()])
            .with_tools(vec!["b".into(), "c".into()]) // Override
            .with_triggers(vec!["x".into()])
            .with_triggers(vec!["y".into()]); // Override

        assert_eq!(skill.description, "Second");
        assert_eq!(skill.system_prompt_additions, Some("Prompt 2".to_string()));
        assert_eq!(skill.provided_tools, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(skill.trigger_patterns, vec!["y".to_string()]);
    }

    #[test]
    fn test_skill_source_copy_trait() {
        let source = SkillSource::Builtin;
        let copied = source;
        assert_eq!(source, copied);
    }

    #[test]
    fn test_skill_activation_state_copy_trait() {
        let state = SkillActivationState::Active;
        let copied = state;
        assert_eq!(state, copied);
    }

    #[test]
    fn test_skill_activation_state_all_variants() {
        let states = [
            SkillActivationState::Inactive,
            SkillActivationState::Activating,
            SkillActivationState::Active,
            SkillActivationState::Deactivating,
            SkillActivationState::Failed,
        ];
        assert_eq!(states.len(), 5);
        // All variants are distinct
        for i in 0..states.len() {
            for j in (i + 1)..states.len() {
                assert_ne!(states[i], states[j]);
            }
        }
    }

    #[test]
    fn test_skill_activation_state_activating_serialization() {
        let json = serde_json::to_string(&SkillActivationState::Activating).unwrap();
        assert_eq!(json, "\"activating\"");
    }

    #[test]
    fn test_skill_activation_state_deactivating_serialization() {
        let json = serde_json::to_string(&SkillActivationState::Deactivating).unwrap();
        assert_eq!(json, "\"deactivating\"");
    }

    #[test]
    fn test_active_skill_reactivate() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        let first_activation = active.activated_at;

        // Small sleep to ensure different timestamp
        std::thread::sleep(std::time::Duration::from_millis(10));

        active.deactivate();
        active.activate();
        let second_activation = active.activated_at;

        assert!(second_activation.unwrap() >= first_activation.unwrap());
    }

    #[test]
    fn test_active_skill_usage_count_after_deactivate() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        active.record_usage();
        active.record_usage();
        active.deactivate();

        // Usage count persists after deactivation
        assert_eq!(active.usage_count, 2);
    }

    #[test]
    fn test_active_skill_record_usage_when_inactive() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        // Can record usage even when inactive (no restriction)
        active.record_usage();
        assert_eq!(active.usage_count, 1);
    }

    #[test]
    fn test_active_skill_set_failed_state() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.state = SkillActivationState::Activating;
        assert!(!active.is_active());

        active.state = SkillActivationState::Failed;
        active.last_error = Some("Connection timeout".to_string());
        assert!(!active.is_active());
    }

    #[test]
    fn test_skill_event_deserialization() {
        let json = r#"{"type":"registered","skill_id":"test-skill"}"#;
        let event: SkillEvent = serde_json::from_str(json).unwrap();
        match event {
            SkillEvent::Registered { skill_id } => {
                assert_eq!(skill_id, "test-skill");
            }
            _ => panic!("Expected Registered event"),
        }
    }

    #[test]
    fn test_skill_event_activated_deserialization() {
        let json = r#"{"type":"activated","skill_id":"my-skill"}"#;
        let event: SkillEvent = serde_json::from_str(json).unwrap();
        match event {
            SkillEvent::Activated { skill_id } => {
                assert_eq!(skill_id, "my-skill");
            }
            _ => panic!("Expected Activated event"),
        }
    }

    #[test]
    fn test_skill_event_used_deserialization() {
        let json = r#"{"type":"used","skill_id":"design-skill","context":"creating button"}"#;
        let event: SkillEvent = serde_json::from_str(json).unwrap();
        match event {
            SkillEvent::Used { skill_id, context } => {
                assert_eq!(skill_id, "design-skill");
                assert_eq!(context, "creating button");
            }
            _ => panic!("Expected Used event"),
        }
    }

    #[test]
    fn test_skill_event_clone() {
        let event = SkillEvent::Registered {
            skill_id: "test".to_string(),
        };
        let cloned = event.clone();
        match (event, cloned) {
            (SkillEvent::Registered { skill_id: a }, SkillEvent::Registered { skill_id: b }) => {
                assert_eq!(a, b);
            }
            _ => panic!("Clone mismatch"),
        }
    }

    #[test]
    fn test_skill_definition_clone() {
        let skill = SkillDefinition::new("test", "Test")
            .with_description("Description")
            .with_source(SkillSource::Plugin)
            .with_system_prompt("Prompt")
            .with_tools(vec!["read".into()])
            .with_triggers(vec!["trigger".into()]);

        let cloned = skill.clone();
        assert_eq!(cloned.id, skill.id);
        assert_eq!(cloned.name, skill.name);
        assert_eq!(cloned.description, skill.description);
        assert_eq!(cloned.source, skill.source);
        assert_eq!(
            cloned.system_prompt_additions,
            skill.system_prompt_additions
        );
        assert_eq!(cloned.provided_tools, skill.provided_tools);
        assert_eq!(cloned.trigger_patterns, skill.trigger_patterns);
    }

    #[test]
    fn test_active_skill_clone() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);
        active.activate();
        active.record_usage();
        active.last_error = Some("error".to_string());

        let cloned = active.clone();
        assert_eq!(cloned.definition.id, active.definition.id);
        assert_eq!(cloned.state, active.state);
        assert_eq!(cloned.activated_at, active.activated_at);
        assert_eq!(cloned.usage_count, active.usage_count);
        assert_eq!(cloned.last_error, active.last_error);
    }

    #[test]
    fn test_skill_definition_debug_trait() {
        let skill = SkillDefinition::new("test", "Test");
        let debug_str = format!("{:?}", skill);
        assert!(debug_str.contains("test"));
        assert!(debug_str.contains("Test"));
    }

    #[test]
    fn test_skill_source_debug_trait() {
        let debug_str = format!("{:?}", SkillSource::Builtin);
        assert!(debug_str.contains("Builtin"));
    }

    #[test]
    fn test_skill_activation_state_debug_trait() {
        let debug_str = format!("{:?}", SkillActivationState::Active);
        assert!(debug_str.contains("Active"));
    }

    #[test]
    fn test_active_skill_debug_trait() {
        let definition = SkillDefinition::new("test", "Test");
        let active = ActiveSkill::from_definition(definition);
        let debug_str = format!("{:?}", active);
        assert!(debug_str.contains("ActiveSkill"));
    }

    #[test]
    fn test_skill_event_debug_trait() {
        let event = SkillEvent::Registered {
            skill_id: "test".to_string(),
        };
        let debug_str = format!("{:?}", event);
        assert!(debug_str.contains("Registered"));
        assert!(debug_str.contains("test"));
    }

    #[test]
    fn test_skill_definition_enabled_field() {
        let mut skill = SkillDefinition::new("test", "Test");
        assert!(skill.enabled); // Default true

        skill.enabled = false;
        assert!(!skill.enabled);
    }

    #[test]
    fn test_skill_definition_metadata_complex_values() {
        let mut skill = SkillDefinition::new("test", "Test");
        skill.metadata.insert(
            "config".to_string(),
            serde_json::json!({
                "nested": {
                    "array": [1, 2, 3],
                    "flag": true
                }
            }),
        );

        assert!(skill.metadata.contains_key("config"));
        let config = skill.metadata.get("config").unwrap();
        assert!(config.get("nested").is_some());
    }

    #[test]
    fn test_skill_definition_full_serialization_roundtrip() {
        let mut skill = SkillDefinition::new("complex-skill", "Complex Skill")
            .with_description("A complex skill for testing")
            .with_source(SkillSource::Remote)
            .with_system_prompt("You are a specialist.")
            .with_tools(vec!["read".into(), "write".into(), "bash".into()])
            .with_triggers(vec!["complex".into(), "advanced".into()]);

        skill.version = Some("2.1.0".to_string());
        skill.author = Some("Test Author <test@example.com>".to_string());
        skill
            .metadata
            .insert("priority".to_string(), serde_json::json!(10));
        skill.enabled = false;

        let json = serde_json::to_string_pretty(&skill).unwrap();
        let deserialized: SkillDefinition = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, skill.id);
        assert_eq!(deserialized.name, skill.name);
        assert_eq!(deserialized.description, skill.description);
        assert_eq!(deserialized.source, skill.source);
        assert_eq!(deserialized.enabled, skill.enabled);
        assert_eq!(deserialized.version, skill.version);
        assert_eq!(deserialized.author, skill.author);
        assert_eq!(
            deserialized.system_prompt_additions,
            skill.system_prompt_additions
        );
        assert_eq!(deserialized.provided_tools, skill.provided_tools);
        assert_eq!(deserialized.trigger_patterns, skill.trigger_patterns);
        assert_eq!(
            deserialized.metadata.get("priority"),
            skill.metadata.get("priority")
        );
    }

    #[test]
    fn test_active_skill_full_serialization_roundtrip() {
        let definition = SkillDefinition::new("test", "Test")
            .with_description("Test skill")
            .with_source(SkillSource::Plugin);

        let mut active = ActiveSkill::from_definition(definition);
        active.activate();
        active.record_usage();
        active.record_usage();
        active.record_usage();
        active.last_error = Some("Previous error".to_string());

        let json = serde_json::to_string(&active).unwrap();
        let deserialized: ActiveSkill = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.definition.id, active.definition.id);
        assert_eq!(deserialized.state, active.state);
        assert_eq!(deserialized.usage_count, active.usage_count);
        assert_eq!(deserialized.last_error, active.last_error);
        // activated_at serializes as u64
        assert_eq!(deserialized.activated_at, active.activated_at);
    }

    // ============================================================
    // State Transition Tests
    // ============================================================

    #[test]
    fn test_state_transition_inactive_to_activating() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        assert_eq!(active.state, SkillActivationState::Inactive);
        active.state = SkillActivationState::Activating;
        assert_eq!(active.state, SkillActivationState::Activating);
        assert!(!active.is_active());
    }

    #[test]
    fn test_state_transition_activating_to_active() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.state = SkillActivationState::Activating;
        active.activate();
        assert_eq!(active.state, SkillActivationState::Active);
        assert!(active.is_active());
    }

    #[test]
    fn test_state_transition_activating_to_failed() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.state = SkillActivationState::Activating;
        active.state = SkillActivationState::Failed;
        active.last_error = Some("Activation timeout".to_string());

        assert!(!active.is_active());
        assert_eq!(active.state, SkillActivationState::Failed);
    }

    #[test]
    fn test_state_transition_active_to_deactivating() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        assert!(active.is_active());

        active.state = SkillActivationState::Deactivating;
        assert!(!active.is_active());
    }

    #[test]
    fn test_state_transition_deactivating_to_inactive() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        active.state = SkillActivationState::Deactivating;
        active.deactivate();

        assert_eq!(active.state, SkillActivationState::Inactive);
    }

    #[test]
    fn test_state_transition_failed_to_inactive() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.state = SkillActivationState::Failed;
        active.last_error = Some("Previous failure".to_string());
        active.deactivate();

        assert_eq!(active.state, SkillActivationState::Inactive);
        // Note: deactivate() doesn't clear last_error
    }

    #[test]
    fn test_state_transition_failed_to_activating_retry() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        // First attempt fails
        active.state = SkillActivationState::Activating;
        active.state = SkillActivationState::Failed;
        active.last_error = Some("First failure".to_string());

        // Retry
        active.state = SkillActivationState::Activating;
        active.last_error = None; // Clear error on retry
        active.activate();

        assert!(active.is_active());
        assert!(active.last_error.is_none());
    }

    #[test]
    fn test_state_all_transitions_possible() {
        // The implementation doesn't enforce state machine - test that all transitions work
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        // Can go from any state to any other state (no enforcement)
        let all_states = [
            SkillActivationState::Inactive,
            SkillActivationState::Activating,
            SkillActivationState::Active,
            SkillActivationState::Deactivating,
            SkillActivationState::Failed,
        ];

        for from in &all_states {
            for to in &all_states {
                active.state = *from;
                active.state = *to;
                assert_eq!(active.state, *to);
            }
        }
    }

    // ============================================================
    // Validation Tests
    // ============================================================

    #[test]
    fn test_skill_definition_validation_empty_strings_allowed() {
        // Empty strings are allowed by the type system
        let skill = SkillDefinition::new("", "")
            .with_description("")
            .with_system_prompt("");

        assert!(skill.id.is_empty());
        assert!(skill.name.is_empty());
        assert!(skill.description.is_empty());
        assert_eq!(skill.system_prompt_additions, Some(String::new()));
    }

    #[test]
    fn test_skill_definition_whitespace_only_strings() {
        let skill = SkillDefinition::new("   ", "\t\n")
            .with_description("  \n  ")
            .with_system_prompt("\t\t");

        assert_eq!(skill.id, "   ");
        assert_eq!(skill.name, "\t\n");
        assert_eq!(skill.description, "  \n  ");
    }

    #[test]
    fn test_skill_definition_very_long_id() {
        let long_id = "a".repeat(10000);
        let skill = SkillDefinition::new(&long_id, "Test");
        assert_eq!(skill.id.len(), 10000);
    }

    #[test]
    fn test_skill_definition_null_bytes_in_strings() {
        let skill =
            SkillDefinition::new("id\0with\0nulls", "Name\0too").with_description("Desc\0null");

        assert_eq!(skill.id, "id\0with\0nulls");
        assert_eq!(skill.name, "Name\0too");
        assert_eq!(skill.description, "Desc\0null");
    }

    #[test]
    fn test_skill_definition_empty_tools_and_triggers() {
        let skill = SkillDefinition::new("test", "Test")
            .with_tools(vec![])
            .with_triggers(vec![]);

        assert!(skill.provided_tools.is_empty());
        assert!(skill.trigger_patterns.is_empty());
    }

    #[test]
    fn test_skill_definition_many_tools() {
        let tools: Vec<String> = (0..1000).map(|i| format!("tool-{}", i)).collect();
        let skill = SkillDefinition::new("test", "Test").with_tools(tools.clone());
        assert_eq!(skill.provided_tools.len(), 1000);
    }

    #[test]
    fn test_skill_definition_many_triggers() {
        let triggers: Vec<String> = (0..1000).map(|i| format!("trigger-{}", i)).collect();
        let skill = SkillDefinition::new("test", "Test").with_triggers(triggers.clone());
        assert_eq!(skill.trigger_patterns.len(), 1000);
    }

    // ============================================================
    // Usage Count Boundary Tests
    // ============================================================

    #[test]
    fn test_active_skill_usage_count_many_increments() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        for _ in 0..10000 {
            active.record_usage();
        }

        assert_eq!(active.usage_count, 10000);
    }

    #[test]
    fn test_active_skill_usage_count_max_value() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.usage_count = u64::MAX - 1;
        active.record_usage();

        assert_eq!(active.usage_count, u64::MAX);
    }

    #[test]
    fn test_active_skill_usage_count_overflow_wraps() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.usage_count = u64::MAX;
        // This will overflow in debug mode but wrap in release
        // We're just testing the type can hold max value
        assert_eq!(active.usage_count, u64::MAX);
    }

    // ============================================================
    // Timestamp Tests
    // ============================================================

    #[test]
    fn test_active_skill_timestamp_reasonable() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();

        let ts = active.activated_at.unwrap();
        // Should be after year 2020
        assert!(ts > 1577836800000);
        // Should be before year 2100
        assert!(ts < 4102444800000);
    }

    #[test]
    fn test_active_skill_multiple_activations_update_timestamp() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        let first_ts = active.activated_at.unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));

        active.activate();
        let second_ts = active.activated_at.unwrap();

        assert!(second_ts >= first_ts);
    }

    #[test]
    fn test_active_skill_timestamp_preserved_after_deactivate() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        active.activate();
        let ts = active.activated_at;

        active.deactivate();

        // Timestamp is preserved
        assert_eq!(active.activated_at, ts);
    }

    // ============================================================
    // Event Serialization Edge Cases
    // ============================================================

    #[test]
    fn test_skill_event_empty_strings() {
        let event = SkillEvent::Used {
            skill_id: "".to_string(),
            context: "".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: SkillEvent = serde_json::from_str(&json).unwrap();

        match deserialized {
            SkillEvent::Used { skill_id, context } => {
                assert!(skill_id.is_empty());
                assert!(context.is_empty());
            }
            _ => panic!("Wrong event type"),
        }
    }

    #[test]
    fn test_skill_event_unicode() {
        let event = SkillEvent::Used {
            skill_id: "日本語スキル".to_string(),
            context: "テスト 🎉".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: SkillEvent = serde_json::from_str(&json).unwrap();

        match deserialized {
            SkillEvent::Used { skill_id, context } => {
                assert_eq!(skill_id, "日本語スキル");
                assert_eq!(context, "テスト 🎉");
            }
            _ => panic!("Wrong event type"),
        }
    }

    #[test]
    fn test_skill_event_special_characters() {
        let event = SkillEvent::ActivationFailed {
            skill_id: "skill/with:special".to_string(),
            error: "Error with \"quotes\" and\nnewlines".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: SkillEvent = serde_json::from_str(&json).unwrap();

        match deserialized {
            SkillEvent::ActivationFailed { skill_id, error } => {
                assert_eq!(skill_id, "skill/with:special");
                assert!(error.contains("\"quotes\""));
                assert!(error.contains("\n"));
            }
            _ => panic!("Wrong event type"),
        }
    }

    #[test]
    fn test_skill_event_very_long_error() {
        let long_error = "e".repeat(100000);
        let event = SkillEvent::ActivationFailed {
            skill_id: "test".to_string(),
            error: long_error.clone(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: SkillEvent = serde_json::from_str(&json).unwrap();

        match deserialized {
            SkillEvent::ActivationFailed { error, .. } => {
                assert_eq!(error.len(), 100000);
            }
            _ => panic!("Wrong event type"),
        }
    }

    // ============================================================
    // Metadata Tests
    // ============================================================

    #[test]
    fn test_skill_definition_metadata_empty() {
        let skill = SkillDefinition::new("test", "Test");
        assert!(skill.metadata.is_empty());
    }

    #[test]
    fn test_skill_definition_metadata_all_json_types() {
        let mut skill = SkillDefinition::new("test", "Test");

        skill
            .metadata
            .insert("null".into(), serde_json::Value::Null);
        skill
            .metadata
            .insert("bool".into(), serde_json::json!(true));
        skill
            .metadata
            .insert("number_int".into(), serde_json::json!(42));
        skill
            .metadata
            .insert("number_float".into(), serde_json::json!(3.15));
        skill
            .metadata
            .insert("string".into(), serde_json::json!("hello"));
        skill
            .metadata
            .insert("array".into(), serde_json::json!([1, 2, 3]));
        skill
            .metadata
            .insert("object".into(), serde_json::json!({"nested": "value"}));

        assert_eq!(skill.metadata.len(), 7);

        // Verify types preserved after serialization
        let json = serde_json::to_string(&skill).unwrap();
        let deserialized: SkillDefinition = serde_json::from_str(&json).unwrap();

        assert!(deserialized.metadata.get("null").unwrap().is_null());
        assert!(deserialized.metadata.get("bool").unwrap().is_boolean());
        assert!(deserialized.metadata.get("number_int").unwrap().is_i64());
        assert!(deserialized.metadata.get("number_float").unwrap().is_f64());
        assert!(deserialized.metadata.get("string").unwrap().is_string());
        assert!(deserialized.metadata.get("array").unwrap().is_array());
        assert!(deserialized.metadata.get("object").unwrap().is_object());
    }

    #[test]
    fn test_skill_definition_metadata_overwrite() {
        let mut skill = SkillDefinition::new("test", "Test");

        skill
            .metadata
            .insert("key".into(), serde_json::json!("value1"));
        skill
            .metadata
            .insert("key".into(), serde_json::json!("value2"));

        assert_eq!(
            skill.metadata.get("key").unwrap(),
            &serde_json::json!("value2")
        );
    }

    // ============================================================
    // Source Equality Tests
    // ============================================================

    #[test]
    fn test_skill_source_equality() {
        assert_eq!(SkillSource::Builtin, SkillSource::Builtin);
        assert_eq!(SkillSource::User, SkillSource::User);
        assert_eq!(SkillSource::Plugin, SkillSource::Plugin);
        assert_eq!(SkillSource::Remote, SkillSource::Remote);
    }

    #[test]
    fn test_skill_source_inequality() {
        let sources = [
            SkillSource::Builtin,
            SkillSource::User,
            SkillSource::Plugin,
            SkillSource::Remote,
        ];

        for i in 0..sources.len() {
            for j in 0..sources.len() {
                if i != j {
                    assert_ne!(sources[i], sources[j]);
                }
            }
        }
    }

    // ============================================================
    // Activation State is_active Tests
    // ============================================================

    #[test]
    fn test_is_active_only_true_for_active_state() {
        let definition = SkillDefinition::new("test", "Test");
        let mut active = ActiveSkill::from_definition(definition);

        // Test all states
        active.state = SkillActivationState::Inactive;
        assert!(!active.is_active());

        active.state = SkillActivationState::Activating;
        assert!(!active.is_active());

        active.state = SkillActivationState::Active;
        assert!(active.is_active());

        active.state = SkillActivationState::Deactivating;
        assert!(!active.is_active());

        active.state = SkillActivationState::Failed;
        assert!(!active.is_active());
    }

    // ============================================================
    // Disabled Skill Tests
    // ============================================================

    #[test]
    fn test_skill_definition_disabled() {
        let mut skill = SkillDefinition::new("test", "Test");
        skill.enabled = false;

        assert!(!skill.enabled);

        let json = serde_json::to_string(&skill).unwrap();
        let deserialized: SkillDefinition = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.enabled);
    }

    #[test]
    fn test_active_skill_from_disabled_definition() {
        let mut definition = SkillDefinition::new("test", "Test");
        definition.enabled = false;

        let active = ActiveSkill::from_definition(definition);

        // ActiveSkill inherits the disabled flag
        assert!(!active.definition.enabled);
        // But can still be activated (no enforcement at this level)
        assert!(!active.is_active());
    }

    #[test]
    fn test_can_activate_disabled_skill() {
        let mut definition = SkillDefinition::new("test", "Test");
        definition.enabled = false;

        let mut active = ActiveSkill::from_definition(definition);
        active.activate();

        // No enforcement - disabled skill can still be activated
        assert!(active.is_active());
        assert!(!active.definition.enabled);
    }
}

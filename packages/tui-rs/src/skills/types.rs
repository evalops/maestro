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
}

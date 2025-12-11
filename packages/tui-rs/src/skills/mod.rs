//! Skills System
//!
//! Provides a mechanism for dynamically activating specialized behaviors.
//! Skills can modify the system prompt, provide additional tools, and
//! change how the agent approaches certain tasks.
//!
//! # Overview
//!
//! The skills system allows:
//! - Registering skills with specific capabilities
//! - Activating/deactivating skills based on context
//! - Injecting skill-specific prompts and tools
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::skills::{SkillDefinition, SkillSource, SkillRegistry};
//!
//! // Define a skill
//! let skill = SkillDefinition::new("frontend-design", "Frontend Design")
//!     .with_description("Create high-quality web interfaces")
//!     .with_source(SkillSource::Builtin)
//!     .with_system_prompt("Focus on visual design, accessibility, and UX...")
//!     .with_triggers(vec!["design".into(), "frontend".into(), "UI".into()]);
//!
//! // Register with a registry
//! let mut registry = SkillRegistry::new();
//! registry.register(skill);
//!
//! // Activate when needed
//! registry.activate("frontend-design")?;
//! ```

mod types;

pub use types::{
    ActiveSkill, SkillActivationState, SkillDefinition, SkillEvent, SkillId, SkillSource,
};

use std::collections::HashMap;

/// Registry for managing skills
#[derive(Debug, Default)]
pub struct SkillRegistry {
    /// Registered skills by ID
    skills: HashMap<SkillId, ActiveSkill>,
    /// Event history
    events: Vec<SkillEvent>,
}

impl SkillRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new skill
    pub fn register(&mut self, definition: SkillDefinition) {
        let id = definition.id.clone();
        let active_skill = ActiveSkill::from_definition(definition);
        self.skills.insert(id.clone(), active_skill);
        self.events.push(SkillEvent::Registered { skill_id: id });
    }

    /// Get a skill by ID
    pub fn get(&self, id: &str) -> Option<&ActiveSkill> {
        self.skills.get(id)
    }

    /// Get a mutable skill by ID
    pub fn get_mut(&mut self, id: &str) -> Option<&mut ActiveSkill> {
        self.skills.get_mut(id)
    }

    /// List all registered skills
    pub fn list(&self) -> Vec<&ActiveSkill> {
        self.skills.values().collect()
    }

    /// List all active skills
    pub fn active_skills(&self) -> Vec<&ActiveSkill> {
        self.skills.values().filter(|s| s.is_active()).collect()
    }

    /// Activate a skill by ID
    pub fn activate(&mut self, id: &str) -> Result<(), String> {
        match self.skills.get_mut(id) {
            Some(skill) => {
                skill.activate();
                self.events.push(SkillEvent::Activated {
                    skill_id: id.to_string(),
                });
                Ok(())
            }
            None => Err(format!("Skill not found: {}", id)),
        }
    }

    /// Deactivate a skill by ID
    pub fn deactivate(&mut self, id: &str) -> Result<(), String> {
        match self.skills.get_mut(id) {
            Some(skill) => {
                skill.deactivate();
                self.events.push(SkillEvent::Deactivated {
                    skill_id: id.to_string(),
                });
                Ok(())
            }
            None => Err(format!("Skill not found: {}", id)),
        }
    }

    /// Get combined system prompt additions from all active skills
    pub fn active_system_prompt_additions(&self) -> String {
        self.active_skills()
            .iter()
            .filter_map(|s| s.definition.system_prompt_additions.as_ref())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Get all tools provided by active skills
    pub fn active_skill_tools(&self) -> Vec<String> {
        self.active_skills()
            .iter()
            .flat_map(|s| s.definition.provided_tools.iter().cloned())
            .collect()
    }

    /// Check if any skill matches the given input
    pub fn match_triggers(&self, input: &str) -> Vec<&ActiveSkill> {
        let input_lower = input.to_lowercase();
        self.skills
            .values()
            .filter(|skill| {
                skill.definition.enabled
                    && skill
                        .definition
                        .trigger_patterns
                        .iter()
                        .any(|pattern| input_lower.contains(&pattern.to_lowercase()))
            })
            .collect()
    }

    /// Get event history
    pub fn events(&self) -> &[SkillEvent] {
        &self.events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_register_and_get() {
        let mut registry = SkillRegistry::new();
        let skill = SkillDefinition::new("test", "Test Skill");

        registry.register(skill);

        assert!(registry.get("test").is_some());
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_registry_activate_deactivate() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("test", "Test Skill"));

        assert!(!registry.get("test").unwrap().is_active());

        registry.activate("test").unwrap();
        assert!(registry.get("test").unwrap().is_active());

        registry.deactivate("test").unwrap();
        assert!(!registry.get("test").unwrap().is_active());
    }

    #[test]
    fn test_registry_active_skills() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("skill1", "Skill 1"));
        registry.register(SkillDefinition::new("skill2", "Skill 2"));
        registry.register(SkillDefinition::new("skill3", "Skill 3"));

        assert_eq!(registry.active_skills().len(), 0);

        registry.activate("skill1").unwrap();
        registry.activate("skill3").unwrap();

        assert_eq!(registry.active_skills().len(), 2);
    }

    #[test]
    fn test_registry_match_triggers() {
        let mut registry = SkillRegistry::new();
        registry.register(
            SkillDefinition::new("frontend", "Frontend").with_triggers(vec![
                "design".into(),
                "ui".into(),
                "frontend".into(),
            ]),
        );
        registry.register(
            SkillDefinition::new("backend", "Backend")
                .with_triggers(vec!["api".into(), "database".into()]),
        );

        let matches = registry.match_triggers("Help me design a new UI");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].definition.id, "frontend");

        let matches = registry.match_triggers("Create an API endpoint");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].definition.id, "backend");

        let matches = registry.match_triggers("Hello world");
        assert_eq!(matches.len(), 0);
    }

    #[test]
    fn test_registry_system_prompt_additions() {
        let mut registry = SkillRegistry::new();
        registry.register(
            SkillDefinition::new("skill1", "Skill 1").with_system_prompt("Prompt addition 1"),
        );
        registry.register(
            SkillDefinition::new("skill2", "Skill 2").with_system_prompt("Prompt addition 2"),
        );

        // No active skills = empty
        assert!(registry.active_system_prompt_additions().is_empty());

        registry.activate("skill1").unwrap();
        assert_eq!(
            registry.active_system_prompt_additions(),
            "Prompt addition 1"
        );

        registry.activate("skill2").unwrap();
        let additions = registry.active_system_prompt_additions();
        assert!(additions.contains("Prompt addition 1"));
        assert!(additions.contains("Prompt addition 2"));
    }

    #[test]
    fn test_registry_default() {
        let registry = SkillRegistry::default();
        assert!(registry.list().is_empty());
        assert!(registry.active_skills().is_empty());
        assert!(registry.events().is_empty());
    }

    #[test]
    fn test_registry_list_all_skills() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("skill1", "Skill 1"));
        registry.register(SkillDefinition::new("skill2", "Skill 2"));
        registry.register(SkillDefinition::new("skill3", "Skill 3"));

        let skills = registry.list();
        assert_eq!(skills.len(), 3);
    }

    #[test]
    fn test_registry_get_mut() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("test", "Test Skill"));

        {
            let skill = registry.get_mut("test").unwrap();
            skill.record_usage();
            skill.record_usage();
        }

        assert_eq!(registry.get("test").unwrap().usage_count, 2);
    }

    #[test]
    fn test_registry_activate_nonexistent() {
        let mut registry = SkillRegistry::new();
        let result = registry.activate("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_registry_deactivate_nonexistent() {
        let mut registry = SkillRegistry::new();
        let result = registry.deactivate("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_registry_events_tracking() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("test", "Test"));
        registry.activate("test").unwrap();
        registry.deactivate("test").unwrap();

        let events = registry.events();
        assert_eq!(events.len(), 3); // Registered, Activated, Deactivated
    }

    #[test]
    fn test_registry_active_skill_tools() {
        let mut registry = SkillRegistry::new();
        registry.register(
            SkillDefinition::new("skill1", "Skill 1")
                .with_tools(vec!["read".into(), "write".into()]),
        );
        registry
            .register(SkillDefinition::new("skill2", "Skill 2").with_tools(vec!["bash".into()]));

        // No active skills = empty tools
        assert!(registry.active_skill_tools().is_empty());

        registry.activate("skill1").unwrap();
        let tools = registry.active_skill_tools();
        assert_eq!(tools.len(), 2);
        assert!(tools.contains(&"read".to_string()));
        assert!(tools.contains(&"write".to_string()));

        registry.activate("skill2").unwrap();
        let tools = registry.active_skill_tools();
        assert_eq!(tools.len(), 3);
        assert!(tools.contains(&"bash".to_string()));
    }

    #[test]
    fn test_registry_match_triggers_case_insensitive() {
        let mut registry = SkillRegistry::new();
        registry.register(
            SkillDefinition::new("frontend", "Frontend")
                .with_triggers(vec!["DESIGN".into(), "UI".into()]),
        );

        // Should match regardless of case
        let matches = registry.match_triggers("design something");
        assert_eq!(matches.len(), 1);

        let matches = registry.match_triggers("DESIGN something");
        assert_eq!(matches.len(), 1);

        let matches = registry.match_triggers("Design something");
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn test_registry_match_triggers_disabled_skill() {
        let mut registry = SkillRegistry::new();
        let mut skill =
            SkillDefinition::new("frontend", "Frontend").with_triggers(vec!["design".into()]);
        skill.enabled = false;
        registry.register(skill);

        // Disabled skills should not match
        let matches = registry.match_triggers("design something");
        assert_eq!(matches.len(), 0);
    }

    #[test]
    fn test_registry_match_triggers_multiple_matches() {
        let mut registry = SkillRegistry::new();
        registry.register(
            SkillDefinition::new("frontend", "Frontend")
                .with_triggers(vec!["design".into(), "button".into()]),
        );
        registry.register(
            SkillDefinition::new("ux", "UX")
                .with_triggers(vec!["design".into(), "user experience".into()]),
        );

        // "design" should match both
        let matches = registry.match_triggers("design something");
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn test_registry_double_registration_overwrites() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("test", "Test 1").with_description("First"));
        registry.register(SkillDefinition::new("test", "Test 2").with_description("Second"));

        // Should have the second registration
        let skill = registry.get("test").unwrap();
        assert_eq!(skill.definition.name, "Test 2");
        assert_eq!(skill.definition.description, "Second");
    }

    #[test]
    fn test_registry_system_prompt_without_prompt_addition() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("skill1", "Skill 1")); // No system prompt
        registry.register(SkillDefinition::new("skill2", "Skill 2").with_system_prompt("Prompt 2"));

        registry.activate("skill1").unwrap();
        registry.activate("skill2").unwrap();

        // Should only include skill2's prompt
        let additions = registry.active_system_prompt_additions();
        assert_eq!(additions, "Prompt 2");
    }

    #[test]
    fn test_registry_events_order() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillDefinition::new("test", "Test"));
        registry.activate("test").unwrap();
        registry.deactivate("test").unwrap();

        let events = registry.events();

        match &events[0] {
            SkillEvent::Registered { skill_id } => assert_eq!(skill_id, "test"),
            _ => panic!("Expected Registered event"),
        }
        match &events[1] {
            SkillEvent::Activated { skill_id } => assert_eq!(skill_id, "test"),
            _ => panic!("Expected Activated event"),
        }
        match &events[2] {
            SkillEvent::Deactivated { skill_id } => assert_eq!(skill_id, "test"),
            _ => panic!("Expected Deactivated event"),
        }
    }
}

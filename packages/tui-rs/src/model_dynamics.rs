//! Task-level model choices. Global preferences never grant provider or tool authority.
use crate::session::ThinkingLevel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskDifficulty {
    Light,
    #[default]
    Medium,
    Heavy,
}

impl TaskDifficulty {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "light" => Ok(Self::Light),
            "medium" => Ok(Self::Medium),
            "heavy" => Ok(Self::Heavy),
            _ => Err("difficulty must be light, medium, or heavy".into()),
        }
    }

    pub fn cap(self, inherited: ThinkingLevel) -> ThinkingLevel {
        let limit = match self {
            Self::Light => ThinkingLevel::Low,
            Self::Medium => ThinkingLevel::Medium,
            Self::Heavy => ThinkingLevel::High,
        };
        if inherited.to_config().1 > limit.to_config().1 {
            limit
        } else {
            inherited
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChoice {
    pub model: String,
    #[serde(default)]
    pub thinking: ThinkingLevel,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ModelDynamicsConfig {
    pub light: Option<ModelChoice>,
    pub medium: Option<ModelChoice>,
    pub heavy: Option<ModelChoice>,
    pub boost: Option<ModelChoice>,
    /// Optional tool-free summarizer; the active conversation model is unchanged.
    pub summary_model: Option<String>,
    pub fallbacks: Vec<ModelChoice>,
    pub auto_boost: bool,
}

impl ModelDynamicsConfig {
    pub fn choice(&self, difficulty: TaskDifficulty) -> Option<&ModelChoice> {
        match difficulty {
            TaskDifficulty::Light => self.light.as_ref(),
            TaskDifficulty::Medium => self.medium.as_ref(),
            TaskDifficulty::Heavy => self.heavy.as_ref(),
        }
    }

    pub fn resolve_child(
        &self,
        difficulty: TaskDifficulty,
        model: Option<&str>,
        thinking: Option<ThinkingLevel>,
        parent: &ModelChoice,
    ) -> ModelChoice {
        let tier = self.choice(difficulty);
        ModelChoice {
            model: model
                .map(str::to_owned)
                .or_else(|| tier.map(|choice| choice.model.clone()))
                .unwrap_or_else(|| parent.model.clone()),
            thinking: thinking.unwrap_or_else(|| {
                // A profile's explicit model must not acquire another model's effort.
                if let Some(model) = model {
                    if model == parent.model {
                        difficulty.cap(parent.thinking)
                    } else {
                        ThinkingLevel::Medium
                    }
                } else {
                    tier.map(|choice| choice.thinking)
                        .unwrap_or_else(|| difficulty.cap(parent.thinking))
                }
            }),
        }
    }
}

/// Recover the persisted UI level from the existing native budget contract.
pub fn thinking_level(enabled: bool, budget: u32) -> ThinkingLevel {
    if !enabled {
        return ThinkingLevel::Off;
    }
    match budget {
        0..=1024 => ThinkingLevel::Minimal,
        1025..=4096 => ThinkingLevel::Low,
        4097..=10000 => ThinkingLevel::Medium,
        10001..=20000 => ThinkingLevel::High,
        _ => ThinkingLevel::Max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn difficulty_changes_effort_without_changing_role_or_model() {
        let config = ModelDynamicsConfig::default();
        let parent = ModelChoice {
            model: "fixture".into(),
            thinking: ThinkingLevel::Max,
        };
        for (difficulty, expected) in [
            (TaskDifficulty::Light, ThinkingLevel::Low),
            (TaskDifficulty::Medium, ThinkingLevel::Medium),
            (TaskDifficulty::Heavy, ThinkingLevel::High),
        ] {
            let resolved = config.resolve_child(difficulty, None, None, &parent);
            assert_eq!(resolved.model, parent.model);
            assert_eq!(resolved.thinking, expected);
        }
    }
    #[test]
    fn explicit_choices_win_and_off_remains_off() {
        let config = ModelDynamicsConfig {
            heavy: Some(ModelChoice {
                model: "tier".into(),
                thinking: ThinkingLevel::High,
            }),
            ..Default::default()
        };
        let parent = ModelChoice {
            model: "parent".into(),
            thinking: ThinkingLevel::Low,
        };
        let explicit = config.resolve_child(
            TaskDifficulty::Heavy,
            Some("pinned"),
            Some(ThinkingLevel::Off),
            &parent,
        );
        assert_eq!(explicit.model, "pinned");
        assert_eq!(explicit.thinking, ThinkingLevel::Off);
        let routed = config.resolve_child(TaskDifficulty::Heavy, None, None, &parent);
        assert_eq!(routed.model, "tier");
        assert_eq!(routed.thinking, ThinkingLevel::High);
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoostStatus {
    #[default]
    Idle,
    Suggested,
    Pending,
    Active,
}

/// Shared only between a runner and its extension. Durable choices use session entries.
#[derive(Debug, Default)]
pub(crate) struct DynamicsState {
    pub status: BoostStatus,
    pub requested: bool,
    pub used: bool,
    pub available: bool,
    pub fallback_models: std::collections::HashSet<String>,
    pub fallback_attempts: usize,
}

pub fn boost_choice(current: &ModelChoice, config: &ModelDynamicsConfig) -> Option<ModelChoice> {
    let info = crate::model_catalog::find_model(&current.model)?;
    let next = if let Some(choice) = &config.boost {
        ModelChoice {
            model: choice.model.clone(),
            thinking: normalize_thinking(&choice.model, choice.thinking),
        }
    } else {
        if !info.capabilities.reasoning {
            return None;
        }
        let thinking = if crate::codex_auth::resolve_model_route(&current.model).uses_app_server() {
            if current.thinking == ThinkingLevel::Max {
                return None;
            }
            ThinkingLevel::Max
        } else {
            match current.thinking {
                ThinkingLevel::Off
                | ThinkingLevel::Minimal
                | ThinkingLevel::Low
                | ThinkingLevel::Medium => ThinkingLevel::High,
                ThinkingLevel::High => ThinkingLevel::Max,
                ThinkingLevel::Max => return None,
            }
        };
        ModelChoice {
            model: current.model.clone(),
            thinking,
        }
    };
    if next.model != current.model {
        let target = crate::model_catalog::find_model(&next.model)?;
        if info.capabilities.protocol != target.capabilities.protocol
            || info.capabilities.context_tokens != target.capabilities.context_tokens
            || info.capabilities.vision != target.capabilities.vision
            || info.capabilities.tools != target.capabilities.tools
            || crate::codex_auth::resolve_model_route(&current.model).uses_app_server()
        {
            return None;
        }
    }
    if next.model == current.model && next.thinking.to_config().1 <= current.thinking.to_config().1
    {
        return None;
    }
    if matches!(
        info.capabilities.protocol,
        crate::model_catalog::ModelProtocol::OpenAiChat
            | crate::model_catalog::ModelProtocol::OpenAiResponses
    ) && !crate::codex_auth::resolve_model_route(&current.model).uses_app_server()
        && next.model == current.model
        && current.thinking != ThinkingLevel::Off
    {
        let caps = crate::ai::openai_request_capabilities(Some(&info.provider), &current.model);
        if caps.reasoning_effort(current.thinking.to_config().1)
            == caps.reasoning_effort(next.thinking.to_config().1)
        {
            return None;
        }
    }
    Some(next)
}

/// Normalize a generic UI level to the direct adapter's actual supported value.
/// App-server capabilities are resolved live by the Codex turn adapter.
pub fn normalize_thinking(model: &str, requested: ThinkingLevel) -> ThinkingLevel {
    if crate::codex_auth::resolve_model_route(model).uses_app_server() {
        return requested;
    }
    let Some(info) = crate::model_catalog::find_model(model) else {
        return requested;
    };
    if !info.capabilities.reasoning {
        return ThinkingLevel::Off;
    }
    if !matches!(
        info.capabilities.protocol,
        crate::model_catalog::ModelProtocol::OpenAiChat
            | crate::model_catalog::ModelProtocol::OpenAiResponses
    ) || requested == ThinkingLevel::Off
    {
        return requested;
    }
    let caps = crate::ai::openai_request_capabilities(Some(&info.provider), model);
    match caps.reasoning_effort(requested.to_config().1) {
        "low" => ThinkingLevel::Low,
        "medium" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        _ => requested,
    }
}

/// Cycle distinct effective levels, skipping budgets the provider normalizes
/// to the same effort. Unknown/custom models retain the existing six levels.
pub fn next_thinking_level(model: &str, current: ThinkingLevel) -> ThinkingLevel {
    let mut levels = Vec::new();
    for requested in [
        ThinkingLevel::Off,
        ThinkingLevel::Minimal,
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Max,
    ] {
        let level = normalize_thinking(model, requested);
        if !levels.contains(&level) {
            levels.push(level);
        }
    }
    let current = normalize_thinking(model, current);
    let index = levels
        .iter()
        .position(|level| *level == current)
        .unwrap_or(0);
    levels[(index + 1) % levels.len()]
}

#[cfg(test)]
mod selection_tests {
    use super::*;
    #[test]
    fn shift_tab_cycles_distinct_provider_levels() {
        let model = "openai/gpt-4o";
        assert_eq!(
            normalize_thinking(model, ThinkingLevel::High),
            ThinkingLevel::Off
        );
        assert_eq!(
            next_thinking_level(model, ThinkingLevel::Off),
            ThinkingLevel::Off
        );

        // o1 supports low/medium/high; normalized Minimal and Max must not
        // trap the cycle at Low or High.
        let model = "openrouter/openai/o1";
        assert_eq!(
            next_thinking_level(model, ThinkingLevel::Off),
            ThinkingLevel::Low
        );
        assert_eq!(
            next_thinking_level(model, ThinkingLevel::Low),
            ThinkingLevel::Medium
        );
        assert_eq!(
            next_thinking_level(model, ThinkingLevel::Medium),
            ThinkingLevel::High
        );
        assert_eq!(
            next_thinking_level(model, ThinkingLevel::High),
            ThinkingLevel::Off
        );
    }
    #[test]
    fn explicit_parent_model_does_not_inherit_another_tiers_effort() {
        let parent = ModelChoice {
            model: "parent".into(),
            thinking: ThinkingLevel::Off,
        };
        let config = ModelDynamicsConfig {
            heavy: Some(ModelChoice {
                model: "other".into(),
                thinking: ThinkingLevel::High,
            }),
            ..Default::default()
        };
        assert_eq!(
            config.resolve_child(TaskDifficulty::Heavy, Some("parent"), None, &parent),
            parent
        );
        assert_eq!(
            config
                .resolve_child(TaskDifficulty::Heavy, Some("third"), None, &parent)
                .thinking,
            ThinkingLevel::Medium
        );
    }
    #[test]
    fn settings_roundtrip_and_reject_unknown_difficulty() {
        let config: ModelDynamicsConfig =
            toml::from_str("[heavy]\nmodel = 'openai/gpt-5.5'\nthinking = 'max'").unwrap();
        assert_eq!(config.heavy.unwrap().thinking, ThinkingLevel::Max);
        assert!(TaskDifficulty::parse("automatic").is_err());
        assert!(toml::from_str::<ModelDynamicsConfig>("auto_boost = 'true'").is_err());
    }
    #[test]
    fn boosts_do_not_advertise_equivalent_wire_settings() {
        let config = ModelDynamicsConfig::default();
        let current = ModelChoice {
            model: "openrouter/openai/o1".into(),
            thinking: ThinkingLevel::High,
        };
        assert!(boost_choice(&current, &config).is_none());
        let medium = ModelChoice {
            thinking: ThinkingLevel::Medium,
            ..current
        };
        assert_eq!(
            boost_choice(&medium, &config).unwrap().thinking,
            ThinkingLevel::High
        );
        assert_eq!(
            normalize_thinking("openrouter/openai/o1", ThinkingLevel::Low),
            ThinkingLevel::Low
        );
    }
    #[test]
    fn codex_effort_keeps_live_adapter_authority() {
        let model = "openai-codex/gpt-6-astra";
        assert_eq!(
            normalize_thinking(model, ThinkingLevel::Max),
            ThinkingLevel::Max
        );
        let current = ModelChoice {
            model: model.into(),
            thinking: ThinkingLevel::High,
        };
        assert_eq!(
            boost_choice(&current, &ModelDynamicsConfig::default())
                .unwrap()
                .thinking,
            ThinkingLevel::Max
        );
    }
}

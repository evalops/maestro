//! Preparation and dispatch integrity for native prompts.
use crate::{Message, RequestConfig};
use anyhow::{Result, ensure};
pub use maestro_runtime_contracts::cache_topology::{CacheTopology, CacheTransition};
use maestro_runtime_contracts::cache_topology::{PromptShape, digest};

#[derive(Clone, Debug)]
pub struct PreparedPrompt {
    topology: CacheTopology,
    affinity: Option<String>,
}

impl PreparedPrompt {
    pub fn prepare(
        messages: &[Message],
        config: &RequestConfig,
        namespace: String,
        previous: Option<&CacheTopology>,
    ) -> Result<Self> {
        let affinity = std::env::var("MAESTRO_OPENROUTER_PROMPT_CACHE_KEY")
            .ok()
            .filter(|key| !key.is_empty() && key.len() <= 256);
        Ok(Self {
            topology: CacheTopology::prepare(
                shape(messages, config, namespace, affinity.as_deref()),
                previous,
            )
            .map_err(anyhow::Error::msg)?,
            affinity,
        })
    }
    /// Standalone summaries carry no explicit cache hints and never advance the primary checkpoint.
    pub fn auxiliary(
        messages: &[Message],
        config: &RequestConfig,
        namespace: String,
    ) -> Result<Self> {
        ensure!(
            !config.cache_system_prompt,
            "auxiliary request must disable explicit cache markers"
        );
        let mut topology = CacheTopology::prepare(shape(messages, config, namespace, None), None)
            .map_err(anyhow::Error::msg)?;
        topology.transition = CacheTransition::Auxiliary;
        Ok(Self {
            topology,
            affinity: None,
        })
    }
    pub(crate) fn affinity(&self) -> Option<&str> {
        self.affinity.as_deref()
    }
    pub fn topology(&self) -> &CacheTopology {
        &self.topology
    }
    pub fn validate(&self, messages: &[Message], config: &RequestConfig) -> Result<()> {
        self.topology
            .validate(&shape(
                messages,
                config,
                self.topology.shape.namespace.clone(),
                self.affinity.as_deref(),
            ))
            .map_err(anyhow::Error::msg)
    }
    pub fn validate_namespace(&self, namespace: &str) -> Result<()> {
        ensure!(
            self.topology.shape.namespace == namespace,
            "cache topology restore scope mismatch"
        );
        Ok(())
    }
}

fn shape(
    messages: &[Message],
    config: &RequestConfig,
    namespace: String,
    affinity: Option<&str>,
) -> PromptShape {
    PromptShape {
        namespace,
        model: digest(&config.model),
        instructions: digest(&config.system),
        tools: digest(config.tools.as_ref()),
        thinking: digest(&config.thinking),
        cache_policy: digest(&(config.cache_system_prompt, affinity)),
        history: messages.iter().map(digest).collect(),
    }
}

pub(crate) fn validate_prepared(messages: &[Message], config: &RequestConfig) -> Result<()> {
    if let Some(prepared) = &config.cache_topology {
        prepared.validate(messages, config)?;
    }
    Ok(())
}

/// Version 1 attests only route bundles that preserve the declared wire shape.
/// Translating codecs, unknown providers, and model-changing fallbacks retain
/// their existing behavior without a hosted attestation.
pub(crate) fn supports_hosted_wire_topology(body: &serde_json::Value) -> bool {
    let Some(model) = body.get("model").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let supported = |candidate: &serde_json::Value| {
        let provider = candidate
            .get("provider_ref")
            .unwrap_or(candidate)
            .get("provider")
            .and_then(serde_json::Value::as_str)
            .and_then(crate::ProviderRegistry::descriptor);
        provider.is_some_and(|provider| {
            matches!(
                provider.protocol,
                crate::ProviderProtocol::OpenAi | crate::ProviderProtocol::OpenAiCompatible
            )
        }) && candidate
            .get("model")
            .is_none_or(|value| value.as_str() == Some(model))
    };
    if let Some(candidates) = body.get("provider_candidates") {
        return candidates
            .as_array()
            .is_some_and(|candidates| !candidates.is_empty() && candidates.iter().all(supported));
    }
    if body.get("provider_refs").is_some() {
        return false;
    }
    body.get("provider_ref").is_some_and(supported)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_topology_hosted_support_checks_every_authorized_candidate() {
        use serde_json::json;
        let mut body = json!({"model":"m", "provider_candidates":[
            {"model":"m","provider_ref":{"provider":"openai"}},
            {"model":"m","provider_ref":{"provider":"openrouter"}}
        ]});
        assert!(supports_hosted_wire_topology(&body));
        body["provider_candidates"][1]["provider_ref"]["provider"] = json!("google");
        assert!(!supports_hosted_wire_topology(&body));
        body["provider_candidates"][1]["provider_ref"]["provider"] = json!("openai");
        body["provider_candidates"][1]["model"] = json!("other");
        assert!(!supports_hosted_wire_topology(&body));
        assert!(!supports_hosted_wire_topology(&json!({"model":"m"})));
    }

    #[test]
    fn cache_topology_rejects_post_preparation_changes() {
        let messages = vec![Message {
            role: crate::Role::User,
            content: crate::MessageContent::text("hello"),
        }];
        let mut config = RequestConfig::default();
        config.cache_topology =
            Some(PreparedPrompt::prepare(&messages, &config, "local".into(), None).unwrap());
        validate_prepared(&messages, &config).unwrap();
        config.system = Some("late injection".into());
        assert!(validate_prepared(&messages, &config).is_err());
        config.system = None;
        assert!(
            validate_prepared(
                &[Message {
                    role: crate::Role::User,
                    content: crate::MessageContent::text("changed")
                }],
                &config
            )
            .is_err()
        );
        assert!(
            config
                .cache_topology
                .as_ref()
                .unwrap()
                .validate_namespace("other-tenant")
                .is_err()
        );
    }
    #[test]
    fn cache_topology_auxiliary_is_separate_from_primary() {
        let messages = vec![];
        let config = RequestConfig::default();
        let primary = PreparedPrompt::prepare(&messages, &config, "local".into(), None).unwrap();
        let auxiliary = PreparedPrompt::auxiliary(&messages, &config, "local".into()).unwrap();
        assert_eq!(auxiliary.topology().transition, CacheTransition::Auxiliary);
        assert!(auxiliary.affinity().is_none());
        auxiliary.validate(&messages, &config).unwrap();
        let next =
            PreparedPrompt::prepare(&messages, &config, "local".into(), Some(primary.topology()))
                .unwrap();
        assert_eq!(next.topology().generation, primary.topology().generation);
    }
}

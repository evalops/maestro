//! Preparation and dispatch integrity for native prompts.
use crate::{Message, RequestConfig};
use anyhow::{Result, ensure};
pub use maestro_runtime_contracts::cache_topology::{CacheTopology, CacheTransition};
use maestro_runtime_contracts::cache_topology::{PromptShape, digest};

#[derive(Clone, Debug)]
pub struct PreparedPrompt {
    topology: CacheTopology,
    affinity: Option<String>,
    volatile_tail: Option<String>,
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
            volatile_tail: None,
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
            volatile_tail: None,
        })
    }
    /// The tail is owned by the prepared request, so dispatch cannot read a
    /// newer clock, plan, listing, voice setting, or custom instruction. It is
    /// serialized after history, outside the reusable prefix identity.
    pub fn with_volatile_tail(mut self, tail: Option<String>) -> Self {
        self.volatile_tail = tail.filter(|tail| !tail.trim().is_empty());
        self
    }

    pub fn volatile_tail(&self) -> Option<&str> {
        self.volatile_tail.as_deref()
    }

    pub(crate) fn append_volatile_tail(&self, body: &mut serde_json::Value) {
        let Some(tail) = &self.volatile_tail else {
            return;
        };
        let field = if body.get("input").is_some() {
            "input"
        } else {
            "messages"
        };
        if let Some(messages) = body[field].as_array_mut() {
            messages.push(serde_json::json!({"role":"user", "content": tail}));
        }
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

pub(crate) fn messages_with_volatile_tail<'a>(
    messages: &'a [Message],
    config: &RequestConfig,
) -> std::borrow::Cow<'a, [Message]> {
    let Some(tail) = config
        .cache_topology
        .as_ref()
        .and_then(PreparedPrompt::volatile_tail)
    else {
        return std::borrow::Cow::Borrowed(messages);
    };
    let mut request = messages.to_vec();
    request.push(Message {
        role: crate::Role::User,
        content: crate::MessageContent::text(tail),
    });
    std::borrow::Cow::Owned(request)
}

/// Shape each primary checkpoint, including the first request after compaction.
/// Call before appending the volatile tail and before attesting provider bytes.
pub(crate) fn mark_stable_history(body: &mut serde_json::Value, ttl: &str) {
    let marker = serde_json::json!({"type":"ephemeral", "ttl":ttl});
    let Some(messages) = body
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for message in messages.iter_mut().rev() {
        let Some(content) = message.get_mut("content") else {
            continue;
        };
        if let Some(text) = content.as_str().filter(|text| !text.is_empty()) {
            *content = serde_json::json!([{"type":"text", "text":text, "cache_control":marker}]);
            break;
        }
        if let Some(block) = content.as_array_mut().and_then(|blocks| {
            blocks.iter_mut().rev().find(|block| {
                !matches!(
                    block.get("type").and_then(serde_json::Value::as_str),
                    Some("thinking" | "redacted_thinking")
                ) && block.is_object()
            })
        }) {
            block["cache_control"] = marker;
            break;
        }
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
    fn compacted_checkpoint_is_marked_before_the_volatile_tail() {
        let config = RequestConfig::default();
        let old = vec![Message {
            role: crate::Role::User,
            content: crate::MessageContent::text("old"),
        }];
        let first = PreparedPrompt::prepare(&old, &config, "session".into(), None).unwrap();
        let checkpoint = vec![Message {
            role: crate::Role::User,
            content: crate::MessageContent::text("checkpoint"),
        }];
        let next = PreparedPrompt::prepare(
            &checkpoint,
            &config,
            "session".into(),
            Some(first.topology()),
        )
        .unwrap()
        .with_volatile_tail(Some("clock: now".into()));
        assert_eq!(next.topology().generation, 2);
        let mut body = serde_json::json!({"messages":[{"role":"user","content":"checkpoint"}]});
        mark_stable_history(&mut body, "1h");
        next.append_volatile_tail(&mut body);
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["ttl"],
            "1h"
        );
        assert_eq!(body["messages"][1]["content"], "clock: now");
        assert!(body["messages"][1].get("cache_control").is_none());
    }

    #[test]
    fn volatile_tail_changes_wire_bytes_without_rewriting_the_prefix() {
        let config = RequestConfig::default();
        let first = PreparedPrompt::prepare(&[], &config, "session".into(), None)
            .unwrap()
            .with_volatile_tail(Some("clock: 1; plan: a".into()));
        let next = PreparedPrompt::prepare(&[], &config, "session".into(), Some(first.topology()))
            .unwrap()
            .with_volatile_tail(Some("clock: 2; plan: b".into()));
        assert_eq!(next.topology().generation, first.topology().generation);
        let mut before = serde_json::json!({"messages":[]});
        let mut after = before.clone();
        first.append_volatile_tail(&mut before);
        next.append_volatile_tail(&mut after);
        assert_ne!(before, after);
        next.validate(&[], &config).unwrap();
        let mut mutated = config.clone();
        mutated.system = Some("changed standing instruction".into());
        assert!(next.validate(&[], &mutated).is_err());
    }

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

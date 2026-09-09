//! Cache structure is request provenance, never authorization or proof of a hit.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const CACHE_TOPOLOGY_VERSION: u32 = 1;

pub fn digest(value: &impl Serialize) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("cache identity serializes"))
    )
}

/// Ordered message digests preserve append-only history without storing prompt text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptShape {
    pub namespace: String,
    pub model: String,
    pub instructions: String,
    pub tools: String,
    pub thinking: String,
    pub cache_policy: String,
    pub history: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheTransition {
    Initial,
    Append,
    ModelChanged,
    InstructionsChanged,
    ToolsChanged,
    ThinkingChanged,
    CachePolicyChanged,
    HistoryRewritten,
    Auxiliary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheTopology {
    pub version: u32,
    pub generation: u64,
    pub transition: CacheTransition,
    pub shape: PromptShape,
}

impl CacheTopology {
    /// The preparation owner explicitly records a new generation for a changed prefix.
    /// Restoring another tenant/session's topology is never a cache transition.
    pub fn prepare(shape: PromptShape, previous: Option<&Self>) -> Result<Self, &'static str> {
        let (generation, transition) = match previous {
            None => (1, CacheTransition::Initial),
            Some(previous) => {
                if previous.version != CACHE_TOPOLOGY_VERSION || previous.generation == 0 {
                    return Err("unsupported cache topology checkpoint");
                }
                let before = &previous.shape;
                if before.namespace != shape.namespace {
                    return Err("cache topology restore scope mismatch");
                }
                let transition = if before.model != shape.model {
                    CacheTransition::ModelChanged
                } else if before.tools != shape.tools {
                    CacheTransition::ToolsChanged
                } else if before.instructions != shape.instructions {
                    CacheTransition::InstructionsChanged
                } else if before.thinking != shape.thinking {
                    CacheTransition::ThinkingChanged
                } else if before.cache_policy != shape.cache_policy {
                    CacheTransition::CachePolicyChanged
                } else if !shape.history.starts_with(&before.history) {
                    CacheTransition::HistoryRewritten
                } else {
                    CacheTransition::Append
                };
                let generation = if transition == CacheTransition::Append {
                    previous.generation
                } else {
                    previous
                        .generation
                        .checked_add(1)
                        .ok_or("cache generation exhausted")?
                };
                (generation, transition)
            }
        };
        Ok(Self {
            version: CACHE_TOPOLOGY_VERSION,
            generation,
            transition,
            shape,
        })
    }

    pub fn validate(&self, shape: &PromptShape) -> Result<(), &'static str> {
        if self.version != CACHE_TOPOLOGY_VERSION || self.generation == 0 || &self.shape != shape {
            return Err("prepared cache topology differs from request");
        }
        Ok(())
    }
}

/// Scope comes from the admitted caller/authorization, not from a cache key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheScope {
    pub organization_id: String,
    pub workspace_id: String,
    pub session_id: String,
}

impl CacheScope {
    pub fn namespace(&self) -> String {
        digest(self)
    }
}

/// Contract for the OpenAI-compatible hosted request path. Provider translations
/// that change this structure require a separately implemented codec contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostedCacheTopology {
    pub scope: CacheScope,
    pub topology: CacheTopology,
}

pub fn wire_shape(body: &Value, namespace: String) -> Result<PromptShape, &'static str> {
    if !body.is_object() {
        return Err("cache payload must be an object");
    }
    let history = body
        .get("messages")
        .or_else(|| body.get("input"))
        .and_then(Value::as_array)
        .ok_or("cache topology requires an ordered message array")?;
    // Hash the actual serializer's JSON values. Do not sort messages, tools, or
    // content arrays to make diagnostics look stable while changing wire order.
    Ok(PromptShape {
        namespace,
        model: digest(&body.get("model")),
        instructions: digest(&json!([body.get("system"), body.get("instructions")])),
        tools: digest(&body.get("tools")),
        thinking: digest(&json!([
            body.get("thinking"),
            body.get("reasoning"),
            body.get("reasoning_effort"),
            body.get("tool_choice")
        ])),
        cache_policy: digest(&json!([
            body.get("cache_control"),
            body.get("session_id"),
            body.get("prompt_cache_key"),
            body.get("prompt_cache_retention"),
            body.get("prompt_cache_options"),
            body.get("cache_prompt")
        ])),
        history: history.iter().map(digest).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shape() -> PromptShape {
        wire_shape(
            &json!({"model":"m", "messages":[{"role":"user","content":"a"}], "tools":[]}),
            "scope-a".into(),
        )
        .unwrap()
    }
    #[test]
    fn cache_topology_append_and_rewrite_have_distinct_generations() {
        let initial = CacheTopology::prepare(shape(), None).unwrap();
        let mut next = shape();
        next.history.push(digest(&"b"));
        let append = CacheTopology::prepare(next, Some(&initial)).unwrap();
        assert_eq!(append.generation, 1);
        assert_eq!(append.transition, CacheTransition::Append);
        let rewrite = CacheTopology::prepare(shape(), Some(&append)).unwrap();
        assert_eq!(rewrite.generation, 2);
        assert_eq!(rewrite.transition, CacheTransition::HistoryRewritten);
    }
    #[test]
    fn cache_topology_rejects_mutation_and_cross_scope_restore() {
        let initial = CacheTopology::prepare(shape(), None).unwrap();
        let mut changed = shape();
        changed.tools = digest(&"new tool");
        assert!(initial.validate(&changed).is_err());
        assert_eq!(
            CacheTopology::prepare(changed, Some(&initial))
                .unwrap()
                .transition,
            CacheTransition::ToolsChanged
        );
        let mut other = shape();
        other.namespace = "scope-b".into();
        assert!(CacheTopology::prepare(other, Some(&initial)).is_err());
    }
    #[test]
    fn cache_topology_wire_order_and_policy_are_significant() {
        let a = json!({"model":"m", "messages":[], "tools":[{"name":"a"},{"name":"b"}]});
        let mut b = a.clone();
        b["tools"].as_array_mut().unwrap().reverse();
        assert_ne!(
            wire_shape(&a, "s".into()).unwrap(),
            wire_shape(&b, "s".into()).unwrap()
        );
        b = a.clone();
        b["prompt_cache_key"] = json!("different");
        assert_ne!(
            wire_shape(&a, "s".into()).unwrap(),
            wire_shape(&b, "s".into()).unwrap()
        );
    }

    #[test]
    fn cache_topology_binds_provider_session_affinity() {
        let a = json!({"model":"m", "messages":[], "session_id":"first"});
        let mut b = a.clone();
        b["session_id"] = json!("second");
        assert_ne!(
            wire_shape(&a, "s".into()).unwrap(),
            wire_shape(&b, "s".into()).unwrap()
        );
    }
}

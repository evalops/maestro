//! Provider-scoped request capabilities shared by transport and model inspection.
use crate::provider_model_name;
use serde::Serialize;

pub const ASTRA_CONTEXT_TOKENS: u32 = 1_050_000;
pub const ASTRA_OUTPUT_TOKENS: u32 = 128_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenAiWireProtocol {
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRequestCapabilities {
    pub protocol: OpenAiWireProtocol,
    pub temperature: bool,
    pub reasoning_budget_levels: [&'static str; 3],
    pub maximum_reasoning_effort: &'static str,
    pub context_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

/// Resolve the actual route before applying model-specific restrictions.
#[must_use]
pub fn openai_request_capabilities(
    provider: Option<&str>,
    model: &str,
) -> OpenAiRequestCapabilities {
    let stripped = strip_managed_model_prefix(model.trim());
    let provider = provider.or_else(|| stripped.split_once('/').map(|(p, _)| p));
    let local = provider.is_some_and(|p| {
        ["llamacpp", "lmstudio", "ollama"]
            .iter()
            .any(|v| p.eq_ignore_ascii_case(v))
    });
    let astra = !local
        && stripped
            .rsplit('/')
            .next()
            .is_some_and(|v| v.eq_ignore_ascii_case("gpt-6-astra"));
    let responses = uses_responses_api(provider, model);
    OpenAiRequestCapabilities {
        protocol: if responses {
            OpenAiWireProtocol::OpenAiResponses
        } else {
            OpenAiWireProtocol::OpenAiChat
        },
        temperature: !responses && !astra,
        reasoning_budget_levels: if provider == Some("llamacpp")
            && stripped
                .rsplit('/')
                .next()
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("qwen3.8"))
        {
            ["low", "medium", "xhigh"]
        } else {
            ["low", "medium", "high"]
        },
        maximum_reasoning_effort: if !local && matches!(provider, Some("openai" | "openrouter")) {
            let name = stripped.rsplit('/').next().unwrap_or(stripped);
            if name.starts_with("gpt-5.6-") {
                "max"
            } else if ["gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5"]
                .iter()
                .any(|prefix| {
                    name == *prefix
                        || name
                            .strip_prefix(prefix)
                            .is_some_and(|rest| rest.starts_with("-"))
                })
            {
                "xhigh"
            } else {
                "high"
            }
        } else if provider == Some("llamacpp")
            && stripped
                .rsplit('/')
                .next()
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("qwen3.8"))
        {
            "xhigh"
        } else {
            "high"
        },
        context_tokens: astra.then_some(ASTRA_CONTEXT_TOKENS),
        output_tokens: astra.then_some(ASTRA_OUTPUT_TOKENS),
    }
}

fn strip_managed_model_prefix(model: &str) -> &str {
    for prefix in ["evalops/", "maestro-managed/"] {
        if let Some(candidate) = model.get(..prefix.len()) {
            if candidate.eq_ignore_ascii_case(prefix) {
                return &model[prefix.len()..];
            }
        }
    }
    model
}

fn has_managed_model_prefix(model: &str) -> bool {
    let model = model.trim();
    ["evalops/", "maestro-managed/"].iter().any(|prefix| {
        model
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
    })
}

fn strip_provider_model_prefix<'a>(model: &'a str, provider: &str) -> &'a str {
    let Some((prefix, model_id)) = model.split_once('/') else {
        return model;
    };
    if prefix.eq_ignore_ascii_case(provider) && !model_id.trim().is_empty() {
        model_id.trim()
    } else {
        model
    }
}

fn uses_responses_api(provider: Option<&str>, model: &str) -> bool {
    let managed_namespace = has_managed_model_prefix(model);
    let model = strip_managed_model_prefix(model).trim();
    let inferred_provider = model.split_once('/').map(|(provider, _)| provider.trim());
    let provider = provider.or(inferred_provider);
    let is_native_local = provider.is_some_and(|provider| {
        ["llamacpp", "lmstudio", "ollama"]
            .iter()
            .any(|local| provider.eq_ignore_ascii_case(local))
    });
    if is_native_local {
        return false;
    }
    let is_openrouter =
        provider.is_some_and(|provider| provider.eq_ignore_ascii_case("openrouter"));
    let normalized = provider_model_name(model);
    let normalized = if is_openrouter && !managed_namespace {
        let routed_model = strip_provider_model_prefix(&normalized, "openrouter");
        provider_model_name(routed_model)
    } else {
        normalized
    };
    let normalized = normalized.to_ascii_lowercase();

    if is_openrouter {
        return normalized == "gpt-5.6";
    }

    // Direct OpenAI and managed OpenAI routes use the Responses families
    // already supported by the native client.
    normalized.contains("codex")
        || normalized.starts_with("gpt-5")
        || normalized == "gpt-6-astra"
        || normalized.starts_with("o3")
}

impl OpenAiRequestCapabilities {
    /// Map the existing budget contract to a supported wire value.
    #[must_use]
    pub fn reasoning_effort(&self, budget_tokens: u32) -> &str {
        if budget_tokens > 20000 {
            return self.maximum_reasoning_effort;
        }
        self.reasoning_budget_levels[if budget_tokens > 10000 {
            2
        } else if budget_tokens > 4096 {
            1
        } else {
            0
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_effort_is_provider_and_model_specific() {
        for (model, expected) in [
            ("gpt-5.5", "xhigh"),
            ("gpt-5.6-luna", "max"),
            ("unknown", "high"),
        ] {
            let capabilities = openai_request_capabilities(Some("openai"), model);
            assert_eq!(capabilities.reasoning_effort(20_000), "high");
            assert_eq!(capabilities.reasoning_effort(50_000), expected);
        }
        assert_eq!(
            openai_request_capabilities(Some("ollama"), "gpt-5.6-luna").reasoning_effort(50_000),
            "high"
        );
    }
    #[test]
    fn routes_preserve_provider_capabilities() {
        for (provider, model, responses, temperature) in [
            ("openai", "gpt-6-astra", true, false),
            ("openrouter", "openai/gpt-6-astra", false, false),
            ("ollama", "gpt-6-astra", false, true),
            ("lmstudio", "gpt-6-astra", false, true),
            ("llamacpp", "gpt-6-astra", false, true),
            ("openrouter", "openai/gpt-5.6-terra", false, true),
        ] {
            let c = openai_request_capabilities(Some(provider), model);
            assert_eq!(
                c.protocol == OpenAiWireProtocol::OpenAiResponses,
                responses,
                "{provider}/{model}"
            );
            assert_eq!(c.temperature, temperature, "{provider}/{model}");
            assert_eq!(
                c.context_tokens.is_some(),
                model.ends_with("astra") && !temperature
            );
        }
    }
    #[test]
    fn local_reasoning_mapping_preserves_vendor_namespaces() {
        for model in ["qwen3.8", "Qwen/Qwen3.8-27B", "llamacpp/Qwen/Qwen3.8-27B"] {
            let local = openai_request_capabilities(Some("llamacpp"), model);
            assert_eq!(local.reasoning_effort(12_000), "xhigh", "{model}");
            // The CLI's Low setting is 4,096 tokens on every direct adapter.
            for budget in [3_000, 4_000, 4_096] {
                assert_eq!(local.reasoning_effort(budget), "low", "{model}/{budget}");
            }
            for budget in [4_097, 10_000] {
                assert_eq!(local.reasoning_effort(budget), "medium", "{model}/{budget}");
            }
            assert_eq!(
                openai_request_capabilities(Some("openrouter"), model).reasoning_effort(12_000),
                "high"
            );
        }
    }

    #[test]
    fn managed_and_explicit_routes_agree() {
        assert_eq!(
            openai_request_capabilities(None, "maestro-managed/openai/gpt-6-astra"),
            openai_request_capabilities(Some("openai"), "gpt-6-astra")
        );
    }
}

//! Shared model capability metadata for CLI and TUI surfaces.

use serde::{Deserialize, Serialize};

use crate::ai::{ProviderProtocol, ProviderRegistry};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelProtocol {
    Anthropic,
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    Google,
    CodexAppServer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    Catalog,
    Verified,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelVerification {
    pub state: VerificationState,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ModelVerification {
    #[must_use]
    pub fn catalog() -> Self {
        Self {
            state: VerificationState::Catalog,
            source: "builtin-catalog".to_owned(),
            detail: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub protocol: ModelProtocol,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub streaming: bool,
    pub context_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub description: String,
    pub capabilities: ModelCapabilities,
    pub verification: ModelVerification,
}

#[allow(clippy::too_many_arguments)]
fn model(
    id: &str,
    name: &str,
    provider: &str,
    description: &str,
    protocol: ModelProtocol,
    vision: bool,
    reasoning: bool,
    context_tokens: u32,
) -> ModelInfo {
    ModelInfo {
        id: id.to_owned(),
        name: name.to_owned(),
        provider: provider.to_owned(),
        description: description.to_owned(),
        capabilities: ModelCapabilities {
            protocol,
            tools: true,
            vision,
            reasoning,
            streaming: true,
            context_tokens,
        },
        verification: ModelVerification::catalog(),
    }
}

/// Built-in model catalog used by `maestro models` and the model selector.
#[must_use]
pub fn available_models() -> Vec<ModelInfo> {
    vec![
        model(
            "claude-sonnet-4-5-20250514",
            "Claude Sonnet 4.5",
            "anthropic",
            "Fast general-purpose model",
            ModelProtocol::Anthropic,
            true,
            true,
            200_000,
        ),
        model(
            "claude-opus-4-6",
            "Claude Opus 4.6",
            "anthropic",
            "Complex tasks and long-running agents",
            ModelProtocol::Anthropic,
            true,
            true,
            200_000,
        ),
        model(
            "claude-3-5-haiku-20241022",
            "Claude Haiku 3.5",
            "anthropic",
            "Low-latency model",
            ModelProtocol::Anthropic,
            true,
            false,
            200_000,
        ),
        model(
            "gpt-5.1-codex-max",
            "GPT-5.1 Codex Max",
            "openai",
            "Default coding model",
            ModelProtocol::OpenAiResponses,
            true,
            true,
            400_000,
        ),
        model(
            "gpt-4o",
            "GPT-4o",
            "openai",
            "Multimodal general-purpose model",
            ModelProtocol::OpenAiChat,
            true,
            false,
            128_000,
        ),
        model(
            "gpt-4o-mini",
            "GPT-4o Mini",
            "openai",
            "Low-cost multimodal model",
            ModelProtocol::OpenAiChat,
            true,
            false,
            128_000,
        ),
        model(
            "o1",
            "O1",
            "openai",
            "Reasoning model",
            ModelProtocol::OpenAiResponses,
            true,
            true,
            200_000,
        ),
        model(
            "o3",
            "O3",
            "openai",
            "Reasoning and tool-use model",
            ModelProtocol::OpenAiResponses,
            true,
            true,
            200_000,
        ),
        model(
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            "google",
            "Multimodal reasoning model",
            ModelProtocol::Google,
            true,
            true,
            1_048_576,
        ),
        model(
            "gemini-2.0-flash",
            "Gemini 2.0 Flash",
            "google",
            "Low-latency multimodal model",
            ModelProtocol::Google,
            true,
            false,
            1_048_576,
        ),
        model(
            "grok-3",
            "Grok 3",
            "xai",
            "General-purpose frontier model",
            ModelProtocol::OpenAiChat,
            false,
            true,
            131_072,
        ),
        model(
            "grok-4",
            "Grok 4",
            "xai",
            "Reasoning frontier model",
            ModelProtocol::OpenAiChat,
            true,
            true,
            256_000,
        ),
    ]
}

#[must_use]
pub fn find_model(id: &str) -> Option<ModelInfo> {
    let (provider, bare_id) = id
        .split_once('/')
        .map_or((None, id), |(provider, model)| (Some(provider), model));
    let model = available_models()
        .into_iter()
        .find(|model| model.id == bare_id)?;
    if provider.is_some_and(|provider| {
        ProviderRegistry::descriptor(provider)
            .is_none_or(|descriptor| descriptor.id != model.provider)
    }) {
        return None;
    }
    Some(model)
}

#[must_use]
pub fn has_provider_mismatch(id: &str) -> bool {
    let Some((provider, bare_id)) = id.split_once('/') else {
        return false;
    };
    let Some(model) = available_models()
        .into_iter()
        .find(|model| model.id == bare_id)
    else {
        return false;
    };
    ProviderRegistry::descriptor(provider).is_none_or(|descriptor| descriptor.id != model.provider)
}

/// Verify registry routing and credential presence without network access.
#[must_use]
pub fn verify_model_offline(model_id: &str) -> ModelVerification {
    let env = std::env::vars().collect();
    match ProviderRegistry::resolve(model_id, &env) {
        Ok(provider) if provider.credential.is_some() => ModelVerification {
            state: VerificationState::Verified,
            source: "environment".to_owned(),
            detail: provider.auth_source,
        },
        Ok(provider) => ModelVerification {
            state: VerificationState::Unavailable,
            source: "environment".to_owned(),
            detail: Some(format!(
                "{} credentials not found ({})",
                provider.provider.id,
                provider.provider.auth_env.join(", ")
            )),
        },
        Err(error) => ModelVerification {
            state: VerificationState::Unknown,
            source: "provider-registry".to_owned(),
            detail: Some(error.to_string()),
        },
    }
}

#[must_use]
pub fn protocol_name(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::Anthropic => "anthropic",
        ProviderProtocol::OpenAi => "openai",
        ProviderProtocol::OpenAiCompatible => "openai-compatible",
        ProviderProtocol::Google => "google",
        ProviderProtocol::Codex => "codex-app-server",
        ProviderProtocol::AzureOpenAi => "azure-openai",
        ProviderProtocol::Bedrock => "bedrock",
        ProviderProtocol::Managed => "managed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_exposes_capabilities_separately_from_verification() {
        let model = find_model("openai/gpt-5.1-codex-max").expect("catalog model");
        assert!(model.capabilities.tools);
        assert!(model.capabilities.reasoning);
        assert_eq!(model.verification.state, VerificationState::Catalog);
        assert_eq!(model.capabilities.context_tokens, 400_000);
    }

    #[test]
    fn catalog_rejects_provider_model_mismatches() {
        assert!(find_model("anthropic/gpt-4o").is_none());
        assert!(has_provider_mismatch("anthropic/gpt-4o"));
        assert!(find_model("anthropic/claude-sonnet-4-5-20250514").is_some());
        assert!(!has_provider_mismatch(
            "anthropic/claude-sonnet-4-5-20250514"
        ));
        assert!(find_model("claude/claude-sonnet-4-5-20250514").is_some());
        assert!(!has_provider_mismatch("openai/custom-model"));
    }
}

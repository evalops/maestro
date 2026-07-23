//! Canonical native provider registry.
//!
//! Provider identity, aliases, credential precedence, protocol selection, and
//! compatible endpoint defaults live here so native clients and CLI surfaces
//! share one routing contract.

use std::collections::HashMap;

use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderProtocol {
    Anthropic,
    OpenAi,
    OpenAiCompatible,
    Google,
    Codex,
    AzureOpenAi,
    Bedrock,
    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub aliases: &'static [&'static str],
    pub auth_env: &'static [&'static str],
    pub base_url_env: &'static [&'static str],
    pub default_base_url: Option<&'static str>,
    pub protocol: ProviderProtocol,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProvider {
    pub provider: &'static ProviderDescriptor,
    pub auth_source: Option<String>,
    pub credential: Option<String>,
    pub base_url: Option<String>,
}

pub struct ProviderRegistry;

impl ProviderRegistry {
    #[must_use]
    pub fn all() -> &'static [ProviderDescriptor] {
        PROVIDERS
    }

    #[must_use]
    pub fn descriptor(id_or_alias: &str) -> Option<&'static ProviderDescriptor> {
        let requested = id_or_alias.trim().to_ascii_lowercase();
        PROVIDERS.iter().find(|provider| {
            provider.id == requested || provider.aliases.iter().any(|alias| *alias == requested)
        })
    }

    pub fn resolve(
        model_or_provider: &str,
        env: &HashMap<String, String>,
    ) -> Result<ResolvedProvider> {
        let requested = model_or_provider.trim();
        let descriptor = if let Some((prefix, _)) = requested.split_once('/') {
            Self::descriptor(prefix)
                .ok_or_else(|| anyhow::anyhow!("unknown provider prefix: {prefix}"))?
        } else if let Some(provider) = Self::descriptor(requested) {
            provider
        } else {
            descriptor_for_bare_model(requested)
        };
        let (auth_source, credential) = first_env(env, descriptor.auth_env)
            .map_or((None, None), |(name, value)| {
                (Some(name.to_string()), Some(value.to_string()))
            });
        let base_url = first_env(env, descriptor.base_url_env)
            .map(|(_, value)| normalize_base_url(value))
            .or_else(|| descriptor.default_base_url.map(str::to_string));
        Ok(ResolvedProvider {
            provider: descriptor,
            auth_source,
            credential,
            base_url,
        })
    }

    pub fn require(
        model_or_provider: &str,
        env: &HashMap<String, String>,
    ) -> Result<ResolvedProvider> {
        let resolved = Self::resolve(model_or_provider, env)?;
        if resolved.credential.is_none() {
            bail!(
                "provider {} requires one of: {}",
                resolved.provider.id,
                resolved.provider.auth_env.join(", ")
            );
        }
        Ok(resolved)
    }
}

fn first_env<'a>(
    env: &'a HashMap<String, String>,
    names: &[&'static str],
) -> Option<(&'static str, &'a str)> {
    names.iter().find_map(|name| {
        env.get(*name)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| (*name, value))
    })
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn descriptor_for_bare_model(model: &str) -> &'static ProviderDescriptor {
    let model = model.to_ascii_lowercase();
    let id = if model.starts_with("claude") {
        "anthropic"
    } else if model.starts_with("gemini") {
        "google"
    } else if model.starts_with("deepseek-") {
        "deepseek"
    } else if model.starts_with("kimi-") || model.starts_with("moonshot-") {
        "moonshot"
    } else if model.starts_with("qwen") || model.starts_with("qwq-") {
        "dashscope"
    } else if model.starts_with("minimax-") {
        "minimax"
    } else if model.starts_with("glm-") {
        "zai"
    } else if model.contains("mistral") || model.contains("mixtral") || model.contains("codestral")
    {
        "mistral"
    } else if model.starts_with("llama") {
        "groq"
    } else {
        "openai"
    };
    ProviderRegistry::descriptor(id).expect("built-in provider descriptor")
}

const PROVIDERS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "google",
        aliases: &["gemini"],
        auth_env: &["GEMINI_API_KEY"],
        base_url_env: &["GEMINI_BASE_URL", "GOOGLE_AI_BASE_URL"],
        default_base_url: Some("https://generativelanguage.googleapis.com"),
        protocol: ProviderProtocol::Google,
    },
    ProviderDescriptor {
        id: "google-gemini-cli",
        aliases: &[],
        auth_env: &["GOOGLE_GEMINI_CLI_TOKEN"],
        base_url_env: &["GOOGLE_GEMINI_CLI_BASE_URL"],
        default_base_url: Some("https://cloudcode-pa.googleapis.com"),
        protocol: ProviderProtocol::Google,
    },
    ProviderDescriptor {
        id: "google-antigravity",
        aliases: &[],
        auth_env: &["GOOGLE_ANTIGRAVITY_TOKEN"],
        base_url_env: &["GOOGLE_ANTIGRAVITY_BASE_URL"],
        default_base_url: None,
        protocol: ProviderProtocol::Google,
    },
    ProviderDescriptor {
        id: "evalops",
        aliases: &["maestro-managed"],
        auth_env: &["MAESTRO_EVALOPS_ACCESS_TOKEN", "EVALOPS_TOKEN"],
        base_url_env: &["MAESTRO_EVALOPS_BASE_URL", "EVALOPS_API_URL"],
        default_base_url: Some("https://llm-gateway.evalops.dev/v1"),
        protocol: ProviderProtocol::Managed,
    },
    ProviderDescriptor {
        id: "openai",
        aliases: &[],
        auth_env: &["OPENAI_API_KEY"],
        base_url_env: &["OPENAI_BASE_URL"],
        default_base_url: Some("https://api.openai.com/v1"),
        protocol: ProviderProtocol::OpenAi,
    },
    ProviderDescriptor {
        id: "openai-codex",
        aliases: &["codex"],
        auth_env: &[
            "OPENAI_CODEX_TOKEN",
            "OPENAI_CODEX_ACCESS_TOKEN",
            "CODEX_API_KEY",
        ],
        base_url_env: &["OPENAI_CODEX_BASE_URL", "OPENAI_BASE_URL"],
        default_base_url: Some("https://api.openai.com/v1"),
        protocol: ProviderProtocol::Codex,
    },
    ProviderDescriptor {
        id: "azure-openai",
        aliases: &["azure"],
        auth_env: &["AZURE_OPENAI_API_KEY"],
        base_url_env: &["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_BASE_URL"],
        default_base_url: None,
        protocol: ProviderProtocol::AzureOpenAi,
    },
    ProviderDescriptor {
        id: "anthropic",
        aliases: &["claude"],
        auth_env: &["ANTHROPIC_API_KEY"],
        base_url_env: &["ANTHROPIC_BASE_URL"],
        default_base_url: Some("https://api.anthropic.com/v1"),
        protocol: ProviderProtocol::Anthropic,
    },
    ProviderDescriptor {
        id: "bedrock",
        aliases: &["aws-bedrock"],
        auth_env: &[
            "AWS_ACCESS_KEY_ID",
            "AWS_PROFILE",
            "AWS_SSO_SESSION_NAME",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        ],
        base_url_env: &["AWS_BEDROCK_ENDPOINT"],
        default_base_url: None,
        protocol: ProviderProtocol::Bedrock,
    },
    ProviderDescriptor {
        id: "writer",
        aliases: &[],
        auth_env: &["WRITER_API_KEY"],
        base_url_env: &["WRITER_BASE_URL"],
        default_base_url: Some("https://api.writer.com/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "xai",
        aliases: &["grok"],
        auth_env: &["XAI_API_KEY"],
        base_url_env: &["XAI_BASE_URL"],
        default_base_url: Some("https://api.x.ai/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "groq",
        aliases: &[],
        auth_env: &["GROQ_API_KEY"],
        base_url_env: &["GROQ_BASE_URL"],
        default_base_url: Some("https://api.groq.com/openai/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "cerebras",
        aliases: &[],
        auth_env: &["CEREBRAS_API_KEY"],
        base_url_env: &["CEREBRAS_BASE_URL"],
        default_base_url: Some("https://api.cerebras.ai/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "openrouter",
        aliases: &[],
        auth_env: &["OPENROUTER_API_KEY"],
        base_url_env: &["OPENROUTER_BASE_URL"],
        default_base_url: Some("https://openrouter.ai/api/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "zai",
        aliases: &[],
        auth_env: &["ZAI_API_KEY"],
        base_url_env: &["ZAI_BASE_URL"],
        default_base_url: Some("https://api.z.ai/api/coding/paas/v4"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "mistral",
        aliases: &[],
        auth_env: &["MISTRAL_API_KEY"],
        base_url_env: &["MISTRAL_BASE_URL"],
        default_base_url: Some("https://api.mistral.ai/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "deepseek",
        aliases: &[],
        auth_env: &["DEEPSEEK_API_KEY"],
        base_url_env: &["DEEPSEEK_BASE_URL"],
        default_base_url: Some("https://api.deepseek.com/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "moonshot",
        aliases: &["kimi"],
        auth_env: &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        base_url_env: &["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
        default_base_url: Some("https://api.moonshot.ai/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "dashscope",
        aliases: &["qwen"],
        auth_env: &["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
        base_url_env: &["DASHSCOPE_BASE_URL", "QWEN_BASE_URL"],
        default_base_url: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
    ProviderDescriptor {
        id: "minimax",
        aliases: &[],
        auth_env: &["MINIMAX_API_KEY"],
        base_url_env: &["MINIMAX_BASE_URL"],
        default_base_url: Some("https://api.minimax.io/v1"),
        protocol: ProviderProtocol::OpenAiCompatible,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_codex_models_use_openai_credentials() {
        let env = HashMap::from([("OPENAI_API_KEY".to_string(), "secret".to_string())]);
        let resolved = ProviderRegistry::require("gpt-5.1-codex-max", &env).unwrap();
        assert_eq!(resolved.provider.id, "openai");
        assert_eq!(resolved.auth_source.as_deref(), Some("OPENAI_API_KEY"));
    }

    #[test]
    fn explicit_codex_provider_keeps_codex_credentials() {
        let env = HashMap::from([("OPENAI_CODEX_TOKEN".to_string(), "secret".to_string())]);
        let resolved = ProviderRegistry::require("openai-codex/gpt-5.1-codex-max", &env).unwrap();
        assert_eq!(resolved.provider.id, "openai-codex");
    }

    #[test]
    fn evalops_managed_provider_has_gateway_default() {
        let env = HashMap::from([(
            "MAESTRO_EVALOPS_ACCESS_TOKEN".to_string(),
            "delegated-token".to_string(),
        )]);
        let resolved = ProviderRegistry::require("evalops/gpt-4o-mini", &env).unwrap();
        assert_eq!(resolved.provider.protocol, ProviderProtocol::Managed);
        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://llm-gateway.evalops.dev/v1")
        );
    }
}

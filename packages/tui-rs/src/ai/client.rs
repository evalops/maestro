//! Unified AI client abstraction
//!
//! Provides a common interface for different AI providers.

use anyhow::Result;
use tokio::sync::mpsc;

use super::anthropic::AnthropicClient;
use super::google::GoogleClient;
use super::openai::OpenAiClient;
use super::types::{Message, RequestConfig, StreamEvent};
use super::vertex::VertexAiClient;

/// AI provider enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Anthropic,
    OpenAI,
    /// Mistral AI - uses OpenAI-compatible API with special tool handling
    Mistral,
    /// Google Gemini
    Google,
    /// Groq - uses OpenAI-compatible API for fast inference
    Groq,
    /// Google Vertex AI - enterprise Gemini via GCP
    VertexAi,
    /// DeepSeek - OpenAI-compatible API (api.deepseek.com)
    DeepSeek,
    /// Moonshot AI / Kimi - OpenAI-compatible API (api.moonshot.ai)
    Moonshot,
    /// Alibaba Qwen via DashScope - OpenAI-compatible API
    Qwen,
    /// MiniMax - OpenAI-compatible API (api.minimax.io)
    MiniMax,
    /// Z.ai / Zhipu GLM - OpenAI-compatible API (api.z.ai)
    Zai,
}

impl AiProvider {
    fn direct_provider_from_bare_model(model_lower: &str) -> Option<Self> {
        if matches!(model_lower, "deepseek-chat" | "deepseek-reasoner")
            || model_lower.starts_with("deepseek-v")
        {
            return Some(Self::DeepSeek);
        }

        if model_lower.starts_with("kimi-")
            || model_lower == "kimi-latest"
            || model_lower.starts_with("moonshot-v1-")
        {
            return Some(Self::Moonshot);
        }

        if model_lower.starts_with("qwen3-")
            || matches!(
                model_lower,
                "qwen-max" | "qwen-plus" | "qwen-turbo" | "qwen-vl-max" | "qwq-32b"
            )
        {
            return Some(Self::Qwen);
        }

        if matches!(
            model_lower,
            "minimax-m2" | "minimax-m2.5" | "minimax-m2.7" | "minimax-text-01"
        ) {
            return Some(Self::MiniMax);
        }

        if model_lower.starts_with("glm-") {
            return Some(Self::Zai);
        }

        None
    }

    /// Parse provider from model name
    #[must_use]
    pub fn from_model(model: &str) -> Self {
        let model_lower = model.to_lowercase();
        let provider_prefix = model_lower.split_once('/').map(|(provider, _)| provider);
        match provider_prefix {
            Some("anthropic") => return AiProvider::Anthropic,
            Some("openai" | "azure-openai" | "azure") => return AiProvider::OpenAI,
            Some("google" | "gemini") => return AiProvider::Google,
            Some("mistral") => return AiProvider::Mistral,
            Some("groq") => return AiProvider::Groq,
            Some("vertex-ai" | "vertex") => return AiProvider::VertexAi,
            Some("deepseek") => return AiProvider::DeepSeek,
            Some("moonshot" | "kimi") => return AiProvider::Moonshot,
            Some("dashscope" | "qwen") => return AiProvider::Qwen,
            Some("minimax") => return AiProvider::MiniMax,
            Some("zai" | "zhipu") => return AiProvider::Zai,
            _ => {}
        }

        if let Some(provider) = Self::direct_provider_from_bare_model(&model_lower) {
            return provider;
        }

        if model_lower.starts_with("claude") || model_lower.starts_with("anthropic") {
            AiProvider::Anthropic
        } else if model_lower.starts_with("gpt")
            || model_lower.starts_with("o1")
            || model_lower.starts_with("o3")
            || model_lower.contains("codex")
        {
            AiProvider::OpenAI
        } else if model_lower.starts_with("gemini") || model_lower.contains("google") {
            AiProvider::Google
        } else if model_lower.contains("mistral")
            || model_lower.contains("mixtral")
            || model_lower.contains("codestral")
            || model_lower.contains("pixtral")
        {
            AiProvider::Mistral
        } else if model_lower.contains("groq/")
            || model_lower.starts_with("llama-")
            || model_lower.starts_with("llama3")
            || model_lower.contains("deepseek")
            || model_lower.contains("qwen")
        {
            // Groq hosts Llama, DeepSeek, Qwen models with fast inference.
            // Direct-provider bare ids are handled earlier by
            // `direct_provider_from_bare_model`, so the Groq-hosted distill/coder
            // variants (deepseek-r1-distill-llama-70b, qwen-2.5-coder-32b,
            // qwen-qwq-32b) are what remain here.
            AiProvider::Groq
        } else {
            // Default to OpenAI/Codex for unknown models
            AiProvider::OpenAI
        }
    }
}

/// Return the provider-native model id to send to upstream model APIs.
#[must_use]
pub fn provider_model_name(model: &str) -> String {
    let trimmed = model.trim();
    let Some((provider, model_id)) = trimmed.split_once('/') else {
        return trimmed.to_string();
    };
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return trimmed.to_string();
    }

    match provider.to_ascii_lowercase().as_str() {
        "anthropic" | "openai" | "azure-openai" | "azure" | "google" | "gemini" | "mistral"
        | "groq" | "vertex-ai" | "vertex" | "deepseek" | "moonshot" | "kimi" | "dashscope"
        | "qwen" | "minimax" | "zai" | "zhipu" => model_id.to_string(),
        _ => trimmed.to_string(),
    }
}

/// Unified AI client trait
#[allow(async_fn_in_trait)]
pub trait AiClient: Send + Sync {
    /// Stream a request to the AI provider
    async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>>;

    /// Get the provider type
    fn provider(&self) -> AiProvider;
}

/// Enum-based unified client that can hold either provider
pub enum UnifiedClient {
    Anthropic(AnthropicClient),
    OpenAI(OpenAiClient),
    /// Mistral uses `OpenAI` client with custom base URL
    Mistral(OpenAiClient),
    /// Google Gemini
    Google(GoogleClient),
    /// Groq uses `OpenAI` client with custom base URL for fast inference
    Groq(OpenAiClient),
    /// Google Vertex AI for enterprise Gemini
    VertexAi(VertexAiClient),
    /// DeepSeek uses `OpenAI` client with custom base URL
    DeepSeek(OpenAiClient),
    /// Moonshot / Kimi uses `OpenAI` client with custom base URL
    Moonshot(OpenAiClient),
    /// Alibaba Qwen (DashScope) uses `OpenAI` client with custom base URL
    Qwen(OpenAiClient),
    /// MiniMax uses `OpenAI` client with custom base URL
    MiniMax(OpenAiClient),
    /// Z.ai / Zhipu GLM uses `OpenAI` client with custom base URL
    Zai(OpenAiClient),
}

impl UnifiedClient {
    /// Create client for Anthropic
    pub fn anthropic() -> Result<Self> {
        Ok(Self::Anthropic(AnthropicClient::from_env()?))
    }

    /// Create client for `OpenAI`
    pub fn openai() -> Result<Self> {
        Ok(Self::OpenAI(OpenAiClient::from_env()?))
    }

    /// Create client for Mistral
    pub fn mistral() -> Result<Self> {
        Ok(Self::Mistral(OpenAiClient::mistral_from_env()?))
    }

    /// Create client for Google Gemini
    pub fn google() -> Result<Self> {
        Ok(Self::Google(GoogleClient::from_env()?))
    }

    /// Create client for Groq
    pub fn groq() -> Result<Self> {
        Ok(Self::Groq(OpenAiClient::groq_from_env()?))
    }

    /// Create client for Vertex AI
    pub fn vertex_ai() -> Result<Self> {
        Ok(Self::VertexAi(VertexAiClient::from_env()?))
    }

    /// Create client for DeepSeek
    pub fn deepseek() -> Result<Self> {
        Ok(Self::DeepSeek(OpenAiClient::deepseek_from_env()?))
    }

    /// Create client for Moonshot / Kimi
    pub fn moonshot() -> Result<Self> {
        Ok(Self::Moonshot(OpenAiClient::moonshot_from_env()?))
    }

    /// Create client for Alibaba Qwen (DashScope)
    pub fn qwen() -> Result<Self> {
        Ok(Self::Qwen(OpenAiClient::qwen_from_env()?))
    }

    /// Create client for MiniMax
    pub fn minimax() -> Result<Self> {
        Ok(Self::MiniMax(OpenAiClient::minimax_from_env()?))
    }

    /// Create client for Z.ai / Zhipu GLM
    pub fn zai() -> Result<Self> {
        Ok(Self::Zai(OpenAiClient::zai_from_env()?))
    }

    /// Create client based on provider
    pub fn from_provider(provider: AiProvider) -> Result<Self> {
        match provider {
            AiProvider::Anthropic => Self::anthropic(),
            AiProvider::OpenAI => Self::openai(),
            AiProvider::Mistral => Self::mistral(),
            AiProvider::Google => Self::google(),
            AiProvider::Groq => Self::groq(),
            AiProvider::VertexAi => Self::vertex_ai(),
            AiProvider::DeepSeek => Self::deepseek(),
            AiProvider::Moonshot => Self::moonshot(),
            AiProvider::Qwen => Self::qwen(),
            AiProvider::MiniMax => Self::minimax(),
            AiProvider::Zai => Self::zai(),
        }
    }

    /// Create client based on model name
    pub fn from_model(model: &str) -> Result<Self> {
        Self::from_provider(AiProvider::from_model(model))
    }

    /// Get the provider type
    #[must_use]
    pub fn provider(&self) -> AiProvider {
        match self {
            Self::Anthropic(_) => AiProvider::Anthropic,
            Self::OpenAI(_) => AiProvider::OpenAI,
            Self::Mistral(_) => AiProvider::Mistral,
            Self::Google(_) => AiProvider::Google,
            Self::Groq(_) => AiProvider::Groq,
            Self::VertexAi(_) => AiProvider::VertexAi,
            Self::DeepSeek(_) => AiProvider::DeepSeek,
            Self::Moonshot(_) => AiProvider::Moonshot,
            Self::Qwen(_) => AiProvider::Qwen,
            Self::MiniMax(_) => AiProvider::MiniMax,
            Self::Zai(_) => AiProvider::Zai,
        }
    }

    /// Stream a request to the AI provider
    pub async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        match self {
            Self::Anthropic(client) => client.stream(messages, config).await,
            Self::OpenAI(client) => client.stream(messages, config).await,
            Self::Mistral(client) => client.stream(messages, config).await,
            Self::Google(client) => client.stream(messages, config).await,
            Self::Groq(client) => client.stream(messages, config).await,
            Self::VertexAi(client) => client.stream(messages, config).await,
            Self::DeepSeek(client) => client.stream(messages, config).await,
            Self::Moonshot(client) => client.stream(messages, config).await,
            Self::Qwen(client) => client.stream(messages, config).await,
            Self::MiniMax(client) => client.stream(messages, config).await,
            Self::Zai(client) => client.stream(messages, config).await,
        }
    }
}

/// Create a unified client for the given provider
pub fn create_client(provider: AiProvider) -> Result<UnifiedClient> {
    UnifiedClient::from_provider(provider)
}

/// Create a unified client based on model name
pub fn create_client_for_model(model: &str) -> Result<UnifiedClient> {
    UnifiedClient::from_model(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_from_model_anthropic() {
        assert_eq!(
            AiProvider::from_model("claude-opus-4-5-20251101"),
            AiProvider::Anthropic
        );
        assert_eq!(
            AiProvider::from_model("claude-sonnet-4-5"),
            AiProvider::Anthropic
        );
        assert_eq!(
            AiProvider::from_model("claude-3-haiku"),
            AiProvider::Anthropic
        );
        assert_eq!(
            AiProvider::from_model("anthropic/claude"),
            AiProvider::Anthropic
        );
    }

    #[test]
    fn test_provider_from_model_openai() {
        assert_eq!(
            AiProvider::from_model("gpt-5.1-codex-max"),
            AiProvider::OpenAI
        );
        assert_eq!(
            AiProvider::from_model("openai/gpt-5.1-codex-max"),
            AiProvider::OpenAI
        );
        assert_eq!(
            AiProvider::from_model("azure-openai/gpt-4o"),
            AiProvider::OpenAI
        );
        assert_eq!(AiProvider::from_model("gpt-4o"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model("gpt-4-turbo"), AiProvider::OpenAI);
        assert_eq!(
            AiProvider::from_model("codex-mini-latest"),
            AiProvider::OpenAI
        );
        assert_eq!(AiProvider::from_model("o1-preview"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model("o3-mini"), AiProvider::OpenAI);
    }

    #[test]
    fn test_provider_from_model_mistral() {
        assert_eq!(AiProvider::from_model("mistral-large"), AiProvider::Mistral);
        assert_eq!(AiProvider::from_model("mistral-small"), AiProvider::Mistral);
        assert_eq!(AiProvider::from_model("mixtral-8x7b"), AiProvider::Mistral);
        assert_eq!(AiProvider::from_model("codestral"), AiProvider::Mistral);
        assert_eq!(AiProvider::from_model("pixtral-12b"), AiProvider::Mistral);
        // Case insensitive
        assert_eq!(AiProvider::from_model("Mistral-Large"), AiProvider::Mistral);
        assert_eq!(AiProvider::from_model("MIXTRAL-8x22b"), AiProvider::Mistral);
    }

    #[test]
    fn test_provider_from_model_google() {
        assert_eq!(
            AiProvider::from_model("gemini-2.0-flash"),
            AiProvider::Google
        );
        assert_eq!(
            AiProvider::from_model("google/gemini-2.5-pro"),
            AiProvider::Google
        );
        assert_eq!(AiProvider::from_model("gemini-2.5-pro"), AiProvider::Google);
        assert_eq!(
            AiProvider::from_model("gemini-1.5-pro-latest"),
            AiProvider::Google
        );
        // Case insensitive
        assert_eq!(AiProvider::from_model("Gemini-Pro"), AiProvider::Google);
    }

    #[test]
    fn test_provider_from_model_groq() {
        // Explicit Groq prefix
        assert_eq!(
            AiProvider::from_model("groq/llama-3.1-70b"),
            AiProvider::Groq
        );
        // Llama models (common on Groq)
        assert_eq!(
            AiProvider::from_model("llama-3.1-70b-versatile"),
            AiProvider::Groq
        );
        assert_eq!(AiProvider::from_model("llama3-8b-8192"), AiProvider::Groq);
        assert_eq!(AiProvider::from_model("llama-guard-3-8b"), AiProvider::Groq);
        // DeepSeek models
        assert_eq!(
            AiProvider::from_model("deepseek-r1-distill-llama-70b"),
            AiProvider::Groq
        );
        // Qwen models
        assert_eq!(
            AiProvider::from_model("qwen-2.5-coder-32b"),
            AiProvider::Groq
        );
        // Case insensitive
        assert_eq!(AiProvider::from_model("Llama-3.1-8B"), AiProvider::Groq);
    }

    #[test]
    fn test_provider_from_model_chinese_providers() {
        // Explicit provider prefixes route to the direct provider.
        assert_eq!(
            AiProvider::from_model("deepseek/deepseek-chat"),
            AiProvider::DeepSeek
        );
        assert_eq!(
            AiProvider::from_model("moonshot/kimi-k2.6"),
            AiProvider::Moonshot
        );
        assert_eq!(
            AiProvider::from_model("kimi/kimi-k2-thinking"),
            AiProvider::Moonshot
        );
        assert_eq!(
            AiProvider::from_model("dashscope/qwen3-max"),
            AiProvider::Qwen
        );
        assert_eq!(
            AiProvider::from_model("qwen/qwen3-coder-plus"),
            AiProvider::Qwen
        );
        assert_eq!(
            AiProvider::from_model("minimax/MiniMax-M2"),
            AiProvider::MiniMax
        );
        assert_eq!(AiProvider::from_model("zai/glm-4.6"), AiProvider::Zai);
        assert_eq!(AiProvider::from_model("zhipu/glm-4.6"), AiProvider::Zai);

        // Bare direct-provider ids (from model selectors / config presets) route
        // to the direct provider even without an explicit prefix.
        assert_eq!(
            AiProvider::from_model("deepseek-chat"),
            AiProvider::DeepSeek
        );
        assert_eq!(
            AiProvider::from_model("deepseek-reasoner"),
            AiProvider::DeepSeek
        );
        assert_eq!(AiProvider::from_model("kimi-k2.6"), AiProvider::Moonshot);
        assert_eq!(
            AiProvider::from_model("moonshot-v1-128k"),
            AiProvider::Moonshot
        );
        assert_eq!(AiProvider::from_model("qwen3-max"), AiProvider::Qwen);
        assert_eq!(AiProvider::from_model("qwq-32b"), AiProvider::Qwen);
        assert_eq!(AiProvider::from_model("MiniMax-M2"), AiProvider::MiniMax);
        assert_eq!(AiProvider::from_model("glm-4.6"), AiProvider::Zai);

        // Bare Groq-hosted distill/coder names still route to Groq for
        // backward compatibility (no explicit provider prefix).
        assert_eq!(
            AiProvider::from_model("deepseek-r1-distill-llama-70b"),
            AiProvider::Groq
        );
        assert_eq!(
            AiProvider::from_model("qwen-2.5-coder-32b"),
            AiProvider::Groq
        );

        // Prefix stripping yields the upstream-native model id.
        assert_eq!(
            provider_model_name("deepseek/deepseek-reasoner"),
            "deepseek-reasoner"
        );
        assert_eq!(provider_model_name("moonshot/kimi-k2.6"), "kimi-k2.6");
        assert_eq!(provider_model_name("dashscope/qwen3-max"), "qwen3-max");
        assert_eq!(provider_model_name("minimax/MiniMax-M2"), "MiniMax-M2");
        assert_eq!(provider_model_name("zai/glm-4.6"), "glm-4.6");
    }

    #[test]
    fn test_provider_from_model_default() {
        // Unknown models default to OpenAI/Codex
        assert_eq!(AiProvider::from_model("unknown-model"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model(""), AiProvider::OpenAI);
    }

    #[test]
    fn test_provider_model_name_strips_known_provider_prefixes() {
        assert_eq!(
            provider_model_name("openai/gpt-5.1-codex-max"),
            "gpt-5.1-codex-max"
        );
        assert_eq!(
            provider_model_name("anthropic/claude-sonnet-4-5-20250514"),
            "claude-sonnet-4-5-20250514"
        );
        assert_eq!(
            provider_model_name(" google/gemini-2.5-pro\n"),
            "gemini-2.5-pro"
        );
        assert_eq!(
            provider_model_name("unknown-provider/model/name"),
            "unknown-provider/model/name"
        );
    }

    #[test]
    fn test_provider_equality() {
        assert_eq!(AiProvider::Anthropic, AiProvider::Anthropic);
        assert_eq!(AiProvider::OpenAI, AiProvider::OpenAI);
        assert_eq!(AiProvider::Mistral, AiProvider::Mistral);
        assert_eq!(AiProvider::Groq, AiProvider::Groq);
        assert_ne!(AiProvider::Anthropic, AiProvider::OpenAI);
        assert_ne!(AiProvider::OpenAI, AiProvider::Mistral);
        assert_ne!(AiProvider::Mistral, AiProvider::Groq);
    }
}

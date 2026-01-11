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
}

impl AiProvider {
    /// Parse provider from model name
    #[must_use]
    pub fn from_model(model: &str) -> Self {
        let model_lower = model.to_lowercase();
        if model_lower.starts_with("claude") || model_lower.starts_with("anthropic") {
            AiProvider::Anthropic
        } else if model_lower.starts_with("gpt")
            || model_lower.starts_with("o1")
            || model_lower.starts_with("o3")
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
            // Groq hosts Llama, DeepSeek, Qwen models with fast inference
            // Models prefixed with "groq/" explicitly use Groq
            AiProvider::Groq
        } else {
            // Default to Anthropic for unknown models
            AiProvider::Anthropic
        }
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

    /// Create client based on provider
    pub fn from_provider(provider: AiProvider) -> Result<Self> {
        match provider {
            AiProvider::Anthropic => Self::anthropic(),
            AiProvider::OpenAI => Self::openai(),
            AiProvider::Mistral => Self::mistral(),
            AiProvider::Google => Self::google(),
            AiProvider::Groq => Self::groq(),
            AiProvider::VertexAi => Self::vertex_ai(),
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
        assert_eq!(AiProvider::from_model("gpt-4o"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model("gpt-4-turbo"), AiProvider::OpenAI);
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
    fn test_provider_from_model_default() {
        // Unknown models default to Anthropic
        assert_eq!(
            AiProvider::from_model("unknown-model"),
            AiProvider::Anthropic
        );
        assert_eq!(AiProvider::from_model(""), AiProvider::Anthropic);
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

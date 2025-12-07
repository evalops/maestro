//! Unified AI client abstraction
//!
//! Provides a common interface for different AI providers.

use anyhow::Result;
use tokio::sync::mpsc;

use super::anthropic::AnthropicClient;
use super::openai::OpenAiClient;
use super::types::*;

/// AI provider enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Anthropic,
    OpenAI,
}

impl AiProvider {
    /// Parse provider from model name
    pub fn from_model(model: &str) -> Self {
        if model.starts_with("claude") || model.starts_with("anthropic") {
            AiProvider::Anthropic
        } else if model.starts_with("gpt") || model.starts_with("o1") || model.starts_with("o3") {
            AiProvider::OpenAI
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
}

impl UnifiedClient {
    /// Create client for Anthropic
    pub fn anthropic() -> Result<Self> {
        Ok(Self::Anthropic(AnthropicClient::from_env()?))
    }

    /// Create client for OpenAI
    pub fn openai() -> Result<Self> {
        Ok(Self::OpenAI(OpenAiClient::from_env()?))
    }

    /// Create client based on provider
    pub fn from_provider(provider: AiProvider) -> Result<Self> {
        match provider {
            AiProvider::Anthropic => Self::anthropic(),
            AiProvider::OpenAI => Self::openai(),
        }
    }

    /// Create client based on model name
    pub fn from_model(model: &str) -> Result<Self> {
        Self::from_provider(AiProvider::from_model(model))
    }

    /// Get the provider type
    pub fn provider(&self) -> AiProvider {
        match self {
            Self::Anthropic(_) => AiProvider::Anthropic,
            Self::OpenAI(_) => AiProvider::OpenAI,
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
        assert_ne!(AiProvider::Anthropic, AiProvider::OpenAI);
    }
}

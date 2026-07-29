//! Unified AI client abstraction
//!
//! Provides a common interface for different AI providers.

use std::collections::HashMap;

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use super::anthropic::AnthropicClient;
use super::google::GoogleClient;
use super::openai::OpenAiClient;
use super::providers::{ProviderProtocol, ProviderRegistry, ResolvedProvider};
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
        if let Some(descriptor) = provider_prefix.and_then(ProviderRegistry::descriptor) {
            return ai_provider_for_descriptor(descriptor.id);
        }
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
        "anthropic" | "claude" | "openai" | "openai-codex" | "codex" | "azure-openai" | "azure"
        | "google" | "gemini" | "google-gemini-cli" | "google-antigravity" | "mistral" | "groq"
        | "vertex-ai" | "vertex" | "deepseek" | "moonshot" | "kimi" | "dashscope" | "qwen"
        | "minimax" | "zai" | "zhipu" | "evalops" | "maestro-managed" | "bedrock"
        | "aws-bedrock" | "writer" | "xai" | "grok" | "cerebras" | "openrouter" => {
            model_id.to_string()
        }
        _ => trimmed.to_string(),
    }
}

/// Default maximum time a streaming response may go without delivering any
/// event before the attempt is abandoned as stalled.
///
/// This bounds idle gaps only: a slow stream that keeps producing events never
/// trips it, while a fully hung HTTP stream (no bytes, no error) is cut off
/// instead of blocking the turn forever.
pub const DEFAULT_STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_mins(2);

/// Default number of times a stalled stream attempt is retried (from scratch)
/// before the failure is surfaced to the caller as a terminal error.
pub const DEFAULT_STREAM_MAX_RETRIES: u32 = 2;

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
#[derive(Clone)]
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
        let env = std::env::vars().collect();
        let resolved = ProviderRegistry::require(model, &env)?;
        Self::from_resolved_provider(&resolved, &env)
    }

    fn from_resolved_provider(
        resolved: &ResolvedProvider,
        env: &HashMap<String, String>,
    ) -> Result<Self> {
        let credential = resolved
            .credential
            .as_deref()
            .context("provider credential unexpectedly missing")?;
        match resolved.provider.protocol {
            ProviderProtocol::Anthropic => Ok(Self::Anthropic(AnthropicClient::new(credential)?)),
            ProviderProtocol::Google => Ok(Self::Google(GoogleClient::new(credential))),
            ProviderProtocol::Bedrock => {
                anyhow::bail!("native Bedrock transport requires AWS SigV4 runtime configuration")
            }
            ProviderProtocol::Managed => {
                let base_url = resolved
                    .base_url
                    .as_deref()
                    .context("managed provider requires an explicit base URL")?;
                let organization_id = ["MAESTRO_EVALOPS_ORG_ID", "EVALOPS_ORGANIZATION_ID"]
                    .iter()
                    .find_map(|name| env.get(*name))
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .context("EvalOps managed provider requires MAESTRO_EVALOPS_ORG_ID")?;
                let provider = env
                    .get("MAESTRO_EVALOPS_PROVIDER")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("openai");
                let environment = env
                    .get("MAESTRO_EVALOPS_ENVIRONMENT")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("prod");
                let mut provider_ref = serde_json::json!({
                    "provider": provider,
                    "environment": environment,
                });
                if let Some(object) = provider_ref.as_object_mut() {
                    for (env_name, field) in [
                        ("MAESTRO_EVALOPS_CREDENTIAL_NAME", "credential_name"),
                        ("MAESTRO_EVALOPS_TEAM_ID", "team_id"),
                    ] {
                        if let Some(value) = env
                            .get(env_name)
                            .map(String::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                        {
                            object.insert(field.to_string(), serde_json::json!(value));
                        }
                    }
                }
                let client = OpenAiClient::with_base_url(credential, base_url)?
                    .with_managed_gateway_context(organization_id, provider_ref)?;
                Ok(Self::OpenAI(client))
            }
            ProviderProtocol::OpenAi
            | ProviderProtocol::OpenAiCompatible
            | ProviderProtocol::Codex
            | ProviderProtocol::AzureOpenAi => {
                let base_url = resolved
                    .base_url
                    .as_deref()
                    .context("provider requires an explicit base URL")?;
                let client = OpenAiClient::with_base_url(credential, base_url)?;
                Ok(match resolved.provider.id {
                    "mistral" => Self::Mistral(client),
                    "groq" => Self::Groq(client),
                    "deepseek" => Self::DeepSeek(client),
                    "moonshot" => Self::Moonshot(client),
                    "dashscope" => Self::Qwen(client),
                    "minimax" => Self::MiniMax(client),
                    "zai" => Self::Zai(client),
                    _ => Self::OpenAI(client),
                })
            }
        }
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
    ///
    /// Applies the default stream idle policy
    /// (`DEFAULT_STREAM_IDLE_TIMEOUT` / `DEFAULT_STREAM_MAX_RETRIES`): an
    /// attempt that delivers no event for the idle window is retried, and if
    /// stalls persist a terminal `StreamEvent::Error` is emitted so exec and
    /// headless callers fail loudly instead of hanging on a dead stream.
    pub async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        // Start the first attempt inline so connect/request failures surface
        // from this call exactly as they did before the idle policy existed.
        let first = self.stream_once(messages, config).await?;

        let (tx, rx) = mpsc::unbounded_channel();
        let client = self.clone();
        let messages = messages.to_vec();
        let config = config.clone();
        tokio::spawn(async move {
            forward_stream_with_idle_policy(
                first,
                move || {
                    let client = client.clone();
                    let messages = messages.clone();
                    let config = config.clone();
                    async move { client.stream_once(&messages, &config).await }
                },
                DEFAULT_STREAM_IDLE_TIMEOUT,
                DEFAULT_STREAM_MAX_RETRIES,
                tx,
            )
            .await;
        });
        Ok(rx)
    }

    /// A single streaming attempt with no idle-timeout or retry policy.
    async fn stream_once(
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

/// Forward events from streaming attempts to `tx`, bounding how long an
/// attempt may go without delivering any event.
///
/// `first` is the already-started first attempt; `begin_attempt` starts a
/// fresh attempt and is only used for retries. An attempt that stalls (no
/// event for `idle_timeout`) is retried from scratch up to `max_retries`
/// times, but only while no content event has been forwarded yet — replaying
/// a request after partial content would duplicate it for the consumer. A
/// stall after partial content, or after retries are exhausted, produces a
/// terminal `StreamEvent::Error`.
///
/// Only the streaming phase is bounded here; request/connect semantics are
/// unchanged. A retried attempt's receiver is dropped, which detaches the
/// provider's stream task until its HTTP connection ends.
async fn forward_stream_with_idle_policy<F, Fut>(
    first: mpsc::UnboundedReceiver<StreamEvent>,
    mut begin_attempt: F,
    idle_timeout: std::time::Duration,
    max_retries: u32,
    tx: mpsc::UnboundedSender<StreamEvent>,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<mpsc::UnboundedReceiver<StreamEvent>>>,
{
    let max_attempts = max_retries.saturating_add(1);
    let mut attempt = 1u32;
    let mut attempt_rx = first;
    loop {
        let mut committed_content = false;
        loop {
            let event = match tokio::time::timeout(idle_timeout, attempt_rx.recv()).await {
                Ok(Some(event)) => event,
                // Attempt stream ended; whatever it delivered was forwarded.
                Ok(None) => return,
                Err(_elapsed) => {
                    if !committed_content && attempt < max_attempts {
                        break; // Discard the stalled attempt and retry.
                    }
                    let message = if committed_content {
                        format!(
                            "Provider stream stalled: no data received for {}s mid-response; \
                             not retrying because partial content was already streamed",
                            idle_timeout.as_secs()
                        )
                    } else {
                        format!(
                            "Provider stream stalled: no data received for {}s after \
                             {attempt} attempt(s); giving up",
                            idle_timeout.as_secs()
                        )
                    };
                    let _ = tx.send(StreamEvent::Error { message });
                    return;
                }
            };
            committed_content |= stream_event_commits_content(&event);
            let terminal = matches!(
                event,
                StreamEvent::MessageStop { .. } | StreamEvent::Error { .. }
            );
            if tx.send(event).is_err() {
                return; // Caller dropped the receiver.
            }
            if terminal {
                return;
            }
        }
        attempt += 1;
        match begin_attempt().await {
            Ok(next) => attempt_rx = next,
            Err(err) => {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Provider stream retry failed: {err:#}"),
                });
                return;
            }
        }
    }
}

/// Whether forwarding this event commits partial response content to the
/// consumer. A retried attempt replays events from the beginning, so a retry
/// is only safe while nothing contentful has been forwarded. Marker events
/// (`MessageStart`, `Usage`) are idempotent for consumers and do not block a
/// retry.
fn stream_event_commits_content(event: &StreamEvent) -> bool {
    matches!(
        event,
        StreamEvent::ContentBlockStart { .. }
            | StreamEvent::ContentBlockStop { .. }
            | StreamEvent::TextDelta { .. }
            | StreamEvent::ThinkingDelta { .. }
            | StreamEvent::ThinkingSignature { .. }
            | StreamEvent::InputJsonDelta { .. }
    )
}

/// Create a unified client for the given provider
pub fn create_client(provider: AiProvider) -> Result<UnifiedClient> {
    UnifiedClient::from_provider(provider)
}

/// Create a unified client based on model name
pub fn create_client_for_model(model: &str) -> Result<UnifiedClient> {
    UnifiedClient::from_model(model)
}

fn ai_provider_for_descriptor(id: &str) -> AiProvider {
    match id {
        "anthropic" | "bedrock" => AiProvider::Anthropic,
        "google" | "google-gemini-cli" | "google-antigravity" => AiProvider::Google,
        "mistral" => AiProvider::Mistral,
        "groq" => AiProvider::Groq,
        "deepseek" => AiProvider::DeepSeek,
        "moonshot" => AiProvider::Moonshot,
        "dashscope" => AiProvider::Qwen,
        "minimax" => AiProvider::MiniMax,
        "zai" => AiProvider::Zai,
        _ => AiProvider::OpenAI,
    }
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
    fn managed_provider_builds_from_delegated_context() {
        let env = HashMap::from([
            (
                "MAESTRO_EVALOPS_ACCESS_TOKEN".to_string(),
                "delegated-token".to_string(),
            ),
            ("MAESTRO_EVALOPS_ORG_ID".to_string(), "org_123".to_string()),
            (
                "MAESTRO_EVALOPS_PROVIDER".to_string(),
                "anthropic".to_string(),
            ),
        ]);
        let resolved = ProviderRegistry::require("evalops/claude-sonnet-4-5", &env).unwrap();
        assert!(UnifiedClient::from_resolved_provider(&resolved, &env).is_ok());

        let missing_org = HashMap::from([(
            "MAESTRO_EVALOPS_ACCESS_TOKEN".to_string(),
            "delegated-token".to_string(),
        )]);
        let resolved = ProviderRegistry::require("evalops/gpt-4o-mini", &missing_org).unwrap();
        assert!(UnifiedClient::from_resolved_provider(&resolved, &missing_org).is_err());
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

#[cfg(test)]
mod stream_idle_policy_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const IDLE: Duration = Duration::from_millis(100);
    const RETRIES: u32 = 2;

    type AttemptRx = mpsc::UnboundedReceiver<StreamEvent>;
    type Attempts = Arc<AtomicU32>;
    /// Senders kept alive so stub channels stay open (hung) instead of closing.
    type Keepalive = Vec<mpsc::UnboundedSender<StreamEvent>>;

    fn drain(rx: &mut AttemptRx) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// A channel that never delivers an event and never closes.
    fn hung_attempt(keepalive: &mut Keepalive) -> AttemptRx {
        let (tx, rx) = mpsc::unbounded_channel();
        keepalive.push(tx);
        rx
    }

    #[test]
    fn stream_idle_policy_defaults_are_sane() {
        assert_eq!(DEFAULT_STREAM_IDLE_TIMEOUT, Duration::from_mins(2));
        assert_eq!(DEFAULT_STREAM_MAX_RETRIES, 2);
    }

    #[tokio::test]
    async fn stalled_stream_exhausts_retries_and_surfaces_error() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let mut keepalive = Keepalive::new();
        let first = hung_attempt(&mut keepalive);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            first,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
                std::mem::forget(attempt_tx); // Retry attempts hang too.
                async move { Ok(attempt_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        // 1 initial attempt + 2 retries, then a terminal error.
        assert_eq!(attempts.load(Ordering::SeqCst), RETRIES);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Error { message } => {
                assert!(
                    message.contains("stalled"),
                    "error should name the stall: {message}"
                );
                assert!(
                    message.contains("3 attempt(s)"),
                    "error should report exhausted attempts: {message}"
                );
            }
            other => panic!("expected terminal error event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn slow_but_progressing_stream_is_not_killed() {
        let retried = Attempts::new(AtomicU32::new(0));
        let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            for i in 0..5 {
                // Gaps stay under the idle window: the stream is slow but
                // never fully idle.
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = attempt_tx.send(StreamEvent::TextDelta {
                    index: 0,
                    text: format!("chunk{i}"),
                });
            }
            let _ = attempt_tx.send(StreamEvent::MessageStop { stop_reason: None });
        });
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            attempt_rx,
            || {
                retried.fetch_add(1, Ordering::SeqCst);
                let (retry_tx, retry_rx) = mpsc::unbounded_channel();
                std::mem::forget(retry_tx);
                async move { Ok(retry_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(retried.load(Ordering::SeqCst), 0);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 6);
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, StreamEvent::Error { .. })),
            "progressing stream must not surface an error"
        );
        assert!(matches!(
            events.last(),
            Some(StreamEvent::MessageStop { .. })
        ));
    }

    #[tokio::test]
    async fn stalled_first_attempt_is_retried_and_success_streams() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let mut keepalive = Keepalive::new();
        let first = hung_attempt(&mut keepalive);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            first,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
                tokio::spawn(async move {
                    let _ = attempt_tx.send(StreamEvent::MessageStart {
                        id: "msg-1".to_string(),
                        model: "test-model".to_string(),
                    });
                    let _ = attempt_tx.send(StreamEvent::TextDelta {
                        index: 0,
                        text: "hello".to_string(),
                    });
                    let _ = attempt_tx.send(StreamEvent::MessageStop { stop_reason: None });
                });
                async move { Ok(attempt_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        assert!(matches!(events[1], StreamEvent::TextDelta { .. }));
        assert!(matches!(events[2], StreamEvent::MessageStop { .. }));
    }

    #[tokio::test]
    async fn stall_after_partial_content_surfaces_error_without_retry() {
        let retried = Attempts::new(AtomicU32::new(0));
        let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
        attempt_tx
            .send(StreamEvent::TextDelta {
                index: 0,
                text: "partial".to_string(),
            })
            .unwrap();
        // Sender stays alive (moved into the factory closure's keepalive) but
        // never sends again.
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            attempt_rx,
            || {
                retried.fetch_add(1, Ordering::SeqCst);
                let (retry_tx, retry_rx) = mpsc::unbounded_channel::<StreamEvent>();
                std::mem::forget(retry_tx);
                async move { Ok(retry_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;
        drop(attempt_tx);

        // No retry: replaying the request would duplicate the partial content.
        assert_eq!(retried.load(Ordering::SeqCst), 0);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::TextDelta { .. }));
        match &events[1] {
            StreamEvent::Error { message } => {
                assert!(
                    message.contains("mid-response"),
                    "error should explain why no retry happened: {message}"
                );
            }
            other => panic!("expected terminal error event, got {other:?}"),
        }
    }
}

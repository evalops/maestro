//! Unified AI client abstraction
//!
//! Provides a common interface for different AI providers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use tracing::Instrument;

use super::anthropic::AnthropicClient;
use super::bedrock::BedrockClient;
use super::google::GoogleClient;
use super::openai::OpenAiClient;
use super::providers::{ProviderProtocol, ProviderRegistry, ResolvedProvider};
use super::scripted::ScriptedClient;
use super::types::{Message, ProviderStreamErrorKind, RequestConfig, StreamEvent};
use super::vertex::VertexAiClient;

/// AI provider enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Anthropic,
    /// Amazon Bedrock Converse API (AWS SigV4).
    Bedrock,
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
    /// Deterministic scripted replay (no network, no credentials). Drives
    /// `maestro scenario run --execute`; never constructed from the provider
    /// registry -- injected directly as `UnifiedClient::Scripted`.
    Scripted,
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
            Some("scripted-replay" | "scripted") => return AiProvider::Scripted,
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
        | "aws-bedrock" | "writer" | "xai" | "grok" | "cerebras" => {
            // OpenRouter model ids are opaque and may themselves begin with
            // `openrouter/`; the OpenAI-compatible transport strips the
            // outer routing prefix exactly once at its boundary.
            model_id.to_string()
        }
        _ => trimmed.to_string(),
    }
}

fn telemetry_provider_model(provider: &str, model: &str) -> String {
    let model = model.trim();
    // Keep the managed namespace long enough to distinguish an OpenRouter
    // model id owned by the gateway from a direct OpenRouter route. The
    // managed request boundary strips this prefix before sending the request,
    // but telemetry must retain the provider-owned `openrouter/` namespace.
    for prefix in ["evalops/", "maestro-managed/"] {
        if model
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
        {
            let managed_model = model[prefix.len()..].trim();
            return if provider.eq_ignore_ascii_case("openrouter") {
                managed_model.to_string()
            } else {
                provider_model_name(managed_model)
            };
        }
    }
    if provider.eq_ignore_ascii_case("openrouter") {
        model
            .split_once('/')
            .filter(|(prefix, _)| prefix.eq_ignore_ascii_case("openrouter"))
            .map_or_else(|| model.to_string(), |(_, nested)| nested.to_string())
    } else {
        provider_model_name(model)
    }
}

/// Canonical `provider_ref.environment` for managed gateway requests. The
/// gateway's Keys contract stores `production`; the legacy `prod` spelling is
/// normalized so every producer resolves the same tuple.
pub fn canonical_managed_environment(value: Option<&str>) -> String {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("production");
    if value.eq_ignore_ascii_case("prod") {
        "production".to_string()
    } else {
        value.to_string()
    }
}

/// Canonical `provider_ref.credential_name` for managed gateway requests.
pub fn canonical_managed_credential_name(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string()
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

/// Managed gateway calls are interactive product traffic. Bound both a
/// request that never opens and a stream that opens without producing an
/// event tightly enough for the outer turn lifecycle to observe terminal
/// failure. Two retries retain transient recovery without leaving the turn
/// indefinitely RUNNING.
pub const MANAGED_GATEWAY_STREAM_IDLE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);
pub const MANAGED_GATEWAY_STREAM_MAX_RETRIES: u32 = 2;

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
    /// Amazon Bedrock Converse API.
    Bedrock(BedrockClient),
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
    /// Deterministic scripted replay client (`scripted.rs`). Not resolvable
    /// through `from_model` -- callers inject it explicitly.
    Scripted(ScriptedClient),
}

impl UnifiedClient {
    fn stream_idle_policy(&self) -> (std::time::Duration, u32) {
        match self {
            Self::OpenAI(client) if client.is_managed_gateway() => (
                MANAGED_GATEWAY_STREAM_IDLE_TIMEOUT,
                MANAGED_GATEWAY_STREAM_MAX_RETRIES,
            ),
            _ => (DEFAULT_STREAM_IDLE_TIMEOUT, DEFAULT_STREAM_MAX_RETRIES),
        }
    }

    fn stream_owner_starts_initial_attempt(&self) -> bool {
        matches!(self, Self::OpenAI(client) if client.is_managed_gateway())
    }

    /// Create client for Anthropic
    pub fn anthropic() -> Result<Self> {
        Ok(Self::Anthropic(AnthropicClient::from_env()?))
    }

    /// Create a client for Amazon Bedrock using the AWS runtime credential
    /// provider chain.
    pub fn bedrock() -> Result<Self> {
        Ok(Self::Bedrock(BedrockClient::from_env()?))
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
            AiProvider::Bedrock => Self::bedrock(),
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
            AiProvider::Scripted => anyhow::bail!(
                "scripted-replay clients are constructed directly (ScriptedClient), not from the provider registry"
            ),
        }
    }

    /// Create client based on model name
    pub fn from_model(model: &str) -> Result<Self> {
        let env = std::env::vars().collect();
        Self::from_model_with_env(model, &env)
    }

    /// Create a client from an explicit environment map without mutating
    /// process-global state.
    pub fn from_model_with_env(model: &str, env: &HashMap<String, String>) -> Result<Self> {
        // Bedrock credentials are resolved by the AWS SDK's default chain at
        // request time. Unlike API-key providers, that chain may be backed by
        // a profile file without any credential environment variable. Keep
        // the registry's strict `require` contract for every other provider.
        let resolved = ProviderRegistry::resolve(model, env)?;
        if resolved.provider.protocol != ProviderProtocol::Bedrock && resolved.credential.is_none()
        {
            anyhow::bail!(
                "provider {} requires one of: {}",
                resolved.provider.id,
                resolved.provider.auth_env.join(", ")
            );
        }
        Self::from_resolved_provider(&resolved, env)
    }

    fn from_resolved_provider(
        resolved: &ResolvedProvider,
        env: &HashMap<String, String>,
    ) -> Result<Self> {
        match resolved.provider.protocol {
            ProviderProtocol::Anthropic => {
                let credential = resolved
                    .credential
                    .as_deref()
                    .context("provider credential unexpectedly missing")?;
                Ok(Self::Anthropic(AnthropicClient::new(credential)?))
            }
            ProviderProtocol::Google => {
                let credential = resolved
                    .credential
                    .as_deref()
                    .context("provider credential unexpectedly missing")?;
                Ok(Self::Google(GoogleClient::new(credential)))
            }
            ProviderProtocol::VertexAi => {
                let credential = resolved
                    .credential
                    .as_deref()
                    .context("provider credential unexpectedly missing")?;
                let auth_source = resolved
                    .auth_source
                    .as_deref()
                    .context("Vertex AI credential source unexpectedly missing")?;
                Ok(Self::VertexAi(VertexAiClient::from_resolved_env(
                    env,
                    credential,
                    auth_source,
                )?))
            }
            ProviderProtocol::Bedrock => Ok(Self::Bedrock(BedrockClient::from_runtime_env(
                env,
                resolved.base_url.as_deref(),
            )?)),
            ProviderProtocol::Managed => {
                let credential = resolved
                    .credential
                    .as_deref()
                    .context("provider credential unexpectedly missing")?;
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
                let workspace_id = ["MAESTRO_EVALOPS_WORKSPACE_ID", "EVALOPS_WORKSPACE_ID"]
                    .iter()
                    .find_map(|name| {
                        env.get(*name)
                            .map(String::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                    });
                let provider = env
                    .get("MAESTRO_EVALOPS_PROVIDER")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("openai");
                let environment = env
                    .get("MAESTRO_EVALOPS_ENVIRONMENT")
                    .map(String::as_str)
                    .map(str::trim);
                let mut provider_ref = serde_json::json!({
                    "provider": provider,
                    "environment": canonical_managed_environment(environment),
                    "credential_name": canonical_managed_credential_name(
                        env.get("MAESTRO_EVALOPS_CREDENTIAL_NAME")
                            .map(String::as_str),
                    ),
                });
                if let Some(object) = provider_ref.as_object_mut() {
                    for (env_name, field) in [("MAESTRO_EVALOPS_TEAM_ID", "team_id")] {
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
                tracing::info!(
                    target: "maestro.llm",
                    event = "managed_provider_ref_configured",
                    provider = %provider,
                    environment = %provider_ref["environment"],
                    credential_name_present = provider_ref
                        .get("credential_name")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| !value.is_empty()),
                    team_id_present = provider_ref
                        .get("team_id")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| !value.is_empty()),
                    organization_id = %organization_id,
                    workspace_id_present = workspace_id.is_some(),
                    "managed provider reference prepared"
                );
                let client = OpenAiClient::with_base_url(credential, base_url)?
                    .with_route_provider(provider);
                let client = if let Some(workspace_id) = workspace_id {
                    client.with_managed_gateway_scope(
                        organization_id,
                        workspace_id,
                        provider_ref,
                    )?
                } else {
                    client.with_managed_gateway_context(organization_id, provider_ref)?
                };
                Ok(Self::OpenAI(client))
            }
            ProviderProtocol::OpenAi
            | ProviderProtocol::OpenAiCompatible
            | ProviderProtocol::Codex
            | ProviderProtocol::AzureOpenAi => {
                let credential = resolved
                    .credential
                    .as_deref()
                    .context("provider credential unexpectedly missing")?;
                let base_url = resolved
                    .base_url
                    .as_deref()
                    .context("provider requires an explicit base URL")?;
                let client = OpenAiClient::with_base_url(credential, base_url)?
                    .with_route_provider(resolved.provider.id);
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
            Self::Bedrock(_) => AiProvider::Bedrock,
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
            Self::Scripted(_) => AiProvider::Scripted,
        }
    }

    /// Return the routed provider identity used for lifecycle telemetry.
    ///
    /// Several providers intentionally use the OpenAI-compatible transport.
    /// Keep the transport enum available for behavior such as prompt caching,
    /// but preserve the configured route here so an OpenRouter or managed
    /// Anthropic turn is not mislabeled as OpenAI in traces.
    #[must_use]
    pub fn provider_name(&self) -> &str {
        match self {
            Self::Anthropic(_) => "anthropic",
            Self::Bedrock(_) => "bedrock",
            Self::OpenAI(client) => client.routed_provider().unwrap_or("openai"),
            Self::Mistral(_) => "mistral",
            Self::Google(_) => "google",
            Self::Groq(_) => "groq",
            Self::VertexAi(_) => "vertex-ai",
            Self::DeepSeek(_) => "deepseek",
            Self::Moonshot(_) => "moonshot",
            Self::Qwen(_) => "qwen",
            Self::MiniMax(_) => "minimax",
            Self::Zai(_) => "zai",
            Self::Scripted(_) => "scripted",
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
        self.stream_owned_config(messages, config.clone()).await
    }

    /// Stream a request while transferring ownership of its immutable config.
    ///
    /// The normal agent loop builds a request config and does not use it after
    /// dispatch. Moving it into the retry task avoids a deep clone of every
    /// tool schema before the first response event. The borrowed `stream`
    /// API above remains for callers that need to retain their config.
    pub async fn stream_owned_config(
        &self,
        messages: &[Message],
        config: RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        self.stream_owned_config_shared_messages(Arc::new(messages.to_vec()), config)
            .await
    }

    /// Stream a request while sharing an owned immutable message snapshot.
    ///
    /// The native agent keeps its conversation history in an `Arc<Vec<_>>`,
    /// so the first attempt and any retry can share the snapshot without
    /// cloning the transcript on every successful turn.
    pub async fn stream_owned_config_shared_messages(
        &self,
        messages: Arc<Vec<Message>>,
        config: RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        let provider = self.provider_name().to_string();
        let (idle_timeout, max_retries) = self.stream_idle_policy();
        let model = config.model.trim().to_string();
        let provider_model = telemetry_provider_model(&provider, &model);
        let started = Instant::now();
        tracing::info!(
            target: "maestro.llm",
            event = "llm_stream_start",
            provider = %provider,
            model = %model,
            provider_model = %provider_model,
            message_count = messages.len(),
            tool_count = config.tools.len(),
            max_tokens = config.max_tokens,
            thinking_enabled = config.thinking.is_some(),
            cache_system_prompt = config.cache_system_prompt,
        );
        // Managed-gateway response opening is part of the bounded provider
        // attempt budget. Starting it here would let an opening timeout escape
        // to the native request loop before the stream retry owner exists,
        // producing one outer retry plus a fresh inner retry budget. Direct
        // providers retain their historical synchronous start-error contract.
        let first = if self.stream_owner_starts_initial_attempt() {
            None
        } else {
            let first = match self.stream_once(messages.as_slice(), &config).await {
                Ok(first) => first,
                Err(error) => {
                    tracing::warn!(
                        target: "maestro.llm",
                        event = "llm_stream_start_failed",
                        provider = %provider,
                        model = %model,
                        provider_model = %provider_model,
                        duration_ms = started.elapsed().as_millis() as u64,
                        outcome = "request_error",
                    );
                    return Err(error);
                }
            };
            tracing::debug!(
                target: "maestro.llm",
                event = "llm_stream_open",
                provider = %provider,
                model = %model,
                provider_model = %provider_model,
                duration_ms = started.elapsed().as_millis() as u64,
                outcome = "stream_open",
            );
            Some(first)
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let client = self.clone();
        let config = Arc::new(config);
        let stream_span = tracing::info_span!(
            target: "maestro.llm",
            "llm_stream_lifecycle",
            event = "llm_stream_lifecycle",
            provider = %provider,
            model = %model,
            provider_model = %provider_model,
        );
        tokio::spawn(
            async move {
                forward_stream_with_idle_policy(
                    first,
                    move || {
                        let client = client.clone();
                        let messages = Arc::clone(&messages);
                        let config = Arc::clone(&config);
                        async move {
                            client
                                .stream_once(messages.as_slice(), config.as_ref())
                                .await
                        }
                    },
                    idle_timeout,
                    max_retries,
                    tx,
                )
                .await;
            }
            .instrument(stream_span),
        );
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
            Self::Bedrock(client) => client.stream(messages, config).await,
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
            Self::Scripted(client) => client.stream(messages, config).await,
        }
    }
}

/// Forward events from streaming attempts to `tx`, bounding how long an
/// attempt may go without delivering any event.
///
/// `first` is an optional already-started first attempt. Managed-gateway
/// callers pass `None`, making this function the sole owner of opening the
/// first request and every retry. Other providers preserve their historical
/// inline-open behavior by passing `Some`. An attempt that stalls (no
/// event for `idle_timeout`) or returns a typed transient provider error is
/// retried from scratch up to `max_retries` times, but only while no content
/// event has been forwarded yet — replaying a request after partial content
/// would duplicate it for the consumer. A stall after partial content, an
/// attempt that closes without a terminal event, or retries that are exhausted
/// produces a typed transient protocol error.
///
/// For managed gateways, response opening and streaming share this budget.
/// Other providers keep their existing request/connect semantics. A retried
/// attempt's receiver is dropped, which detaches the provider's stream task
/// until its HTTP connection ends.
async fn forward_stream_with_idle_policy<F, Fut>(
    first: Option<mpsc::UnboundedReceiver<StreamEvent>>,
    begin_attempt: F,
    idle_timeout: std::time::Duration,
    max_retries: u32,
    tx: mpsc::UnboundedSender<StreamEvent>,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<mpsc::UnboundedReceiver<StreamEvent>>>,
{
    let max_attempts = max_retries.saturating_add(1);
    let mut attempt = u32::from(first.is_some());
    let mut pending_attempt = first;
    let mut begin_attempt = Some(begin_attempt);
    let stream_started = Instant::now();
    let mut events_forwarded = 0u64;
    loop {
        let mut attempt_rx = if let Some(first) = pending_attempt.take() {
            first
        } else {
            loop {
                attempt += 1;
                let Some(begin_attempt_fn) = begin_attempt.as_mut() else {
                    tracing::error!(
                        target: "maestro.llm",
                        event = "llm_stream_failed",
                        reason = "retry_state_unavailable",
                        attempt,
                        max_attempts,
                        duration_ms = stream_started.elapsed().as_millis() as u64,
                        events_forwarded,
                    );
                    let _ = tx.send(StreamEvent::ProviderError {
                        kind: ProviderStreamErrorKind::TransientProtocol,
                        message: "Provider stream retry state was unavailable".to_string(),
                    });
                    return;
                };
                match begin_attempt_fn().await {
                    Ok(next) => break next,
                    Err(err) if attempt < max_attempts => {
                        tracing::warn!(
                            target: "maestro.llm",
                            event = "llm_stream_retry",
                            reason = "attempt_open_failed",
                            attempt,
                            max_attempts,
                            duration_ms = stream_started.elapsed().as_millis() as u64,
                            events_forwarded,
                            error = %err,
                        );
                    }
                    Err(err) => {
                        tracing::error!(
                            target: "maestro.llm",
                            event = "llm_stream_failed",
                            reason = "attempt_open_failed",
                            attempt,
                            max_attempts,
                            duration_ms = stream_started.elapsed().as_millis() as u64,
                            events_forwarded,
                        );
                        let _ = tx.send(StreamEvent::ProviderError {
                            kind: ProviderStreamErrorKind::TransientProtocol,
                            message: format!("Provider stream opening failed: {err:#}"),
                        });
                        return;
                    }
                }
            }
        };
        let attempt_started = Instant::now();
        let mut committed_content = false;
        loop {
            let event = match tokio::time::timeout(idle_timeout, attempt_rx.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => {
                    if !committed_content && attempt < max_attempts {
                        tracing::warn!(
                            target: "maestro.llm",
                            event = "llm_stream_retry",
                            reason = "closed_without_terminal",
                            attempt,
                            max_attempts,
                            committed_content,
                            attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                            duration_ms = stream_started.elapsed().as_millis() as u64,
                            events_forwarded,
                        );
                        break; // The provider closed before producing content; retry.
                    }
                    tracing::error!(
                        target: "maestro.llm",
                        event = "llm_stream_failed",
                        reason = "closed_without_terminal",
                        attempt,
                        max_attempts,
                        committed_content,
                        attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                        duration_ms = stream_started.elapsed().as_millis() as u64,
                        events_forwarded,
                    );
                    let message = if committed_content {
                        "Provider stream closed mid-response without a terminal event; \
                         not retrying because partial content was already streamed"
                            .to_string()
                    } else {
                        format!(
                            "Provider stream closed without a terminal event after \
                             {attempt} attempt(s); giving up"
                        )
                    };
                    let _ = tx.send(StreamEvent::ProviderError {
                        kind: ProviderStreamErrorKind::TransientProtocol,
                        message,
                    });
                    return;
                }
                Err(_elapsed) => {
                    if !committed_content && attempt < max_attempts {
                        tracing::warn!(
                            target: "maestro.llm",
                            event = "llm_stream_retry",
                            reason = "idle_timeout",
                            attempt,
                            max_attempts,
                            committed_content,
                            idle_timeout_ms = idle_timeout.as_millis() as u64,
                            attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                            duration_ms = stream_started.elapsed().as_millis() as u64,
                            events_forwarded,
                        );
                        break; // Discard the stalled attempt and retry.
                    }
                    tracing::error!(
                        target: "maestro.llm",
                        event = "llm_stream_failed",
                        reason = "idle_timeout",
                        attempt,
                        max_attempts,
                        committed_content,
                        idle_timeout_ms = idle_timeout.as_millis() as u64,
                        attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                        duration_ms = stream_started.elapsed().as_millis() as u64,
                        events_forwarded,
                    );
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
                    let _ = tx.send(StreamEvent::ProviderError {
                        kind: ProviderStreamErrorKind::TransientProtocol,
                        message,
                    });
                    return;
                }
            };
            events_forwarded = events_forwarded.saturating_add(1);
            committed_content |= stream_event_commits_content(&event);
            if committed_content {
                // Once content has been forwarded, retries are forbidden to
                // avoid duplicating the response. Drop the retry closure now
                // so its transcript/config snapshots are released during the
                // normal successful path.
                begin_attempt = None;
            }
            if matches!(
                &event,
                StreamEvent::ProviderError {
                    kind: ProviderStreamErrorKind::TransientProtocol,
                    ..
                }
            ) && !committed_content
                && attempt < max_attempts
            {
                tracing::warn!(
                    target: "maestro.llm",
                    event = "llm_stream_retry",
                    reason = "transient_provider_error",
                    attempt,
                    max_attempts,
                    committed_content,
                    attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                    duration_ms = stream_started.elapsed().as_millis() as u64,
                    events_forwarded,
                );
                break;
            }
            let terminal_error = matches!(
                &event,
                StreamEvent::Error { .. } | StreamEvent::ProviderError { .. }
            );
            if terminal_error {
                let error_message_len = match &event {
                    StreamEvent::Error { message } | StreamEvent::ProviderError { message, .. } => {
                        message.len()
                    }
                    _ => 0,
                };
                tracing::error!(
                    target: "maestro.llm",
                    event = "llm_stream_failed",
                    reason = "provider_error",
                    attempt,
                    max_attempts,
                    committed_content,
                    error_message_len,
                    attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                    duration_ms = stream_started.elapsed().as_millis() as u64,
                    events_forwarded,
                );
            }
            let terminal = terminal_error || matches!(&event, StreamEvent::MessageStop { .. });
            if tx.send(event).is_err() {
                tracing::debug!(
                    target: "maestro.llm",
                    event = "llm_stream_abandoned",
                    reason = "consumer_dropped",
                    attempt,
                    max_attempts,
                    committed_content,
                    attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                    duration_ms = stream_started.elapsed().as_millis() as u64,
                    events_forwarded,
                );
                return; // Caller dropped the receiver.
            }
            if terminal {
                if !terminal_error {
                    tracing::info!(
                        target: "maestro.llm",
                        event = "llm_stream_completed",
                        outcome = "success",
                        attempt,
                        max_attempts,
                        committed_content,
                        attempt_duration_ms = attempt_started.elapsed().as_millis() as u64,
                        duration_ms = stream_started.elapsed().as_millis() as u64,
                        events_forwarded,
                    );
                }
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
        "anthropic" => AiProvider::Anthropic,
        "bedrock" => AiProvider::Bedrock,
        "google" | "google-gemini-cli" | "google-antigravity" => AiProvider::Google,
        "vertex-ai" => AiProvider::VertexAi,
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
    fn test_provider_from_model_bedrock() {
        assert_eq!(
            AiProvider::from_model("bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0"),
            AiProvider::Bedrock
        );
        assert_eq!(
            AiProvider::from_model("aws-bedrock/mistral.mistral-large-2407-v1:0"),
            AiProvider::Bedrock
        );
        assert_eq!(
            provider_model_name("bedrock/amazon.nova-pro-v1:0"),
            "amazon.nova-pro-v1:0"
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
    fn test_provider_from_model_vertex_ai() {
        assert_eq!(
            AiProvider::from_model("vertex-ai/gemini-2.5-pro"),
            AiProvider::VertexAi
        );
        assert_eq!(
            AiProvider::from_model("vertex/gemini-2.5-pro"),
            AiProvider::VertexAi
        );
        assert_eq!(
            provider_model_name("vertex-ai/gemini-2.5-pro"),
            "gemini-2.5-pro"
        );
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
    fn telemetry_provider_model_preserves_openrouter_vendor_namespace() {
        assert_eq!(
            telemetry_provider_model("openrouter", "anthropic/claude-sonnet-4.5"),
            "anthropic/claude-sonnet-4.5"
        );
        assert_eq!(
            telemetry_provider_model("openrouter", "openrouter/google/gemini-2.5-pro"),
            "google/gemini-2.5-pro"
        );
        assert_eq!(
            telemetry_provider_model("openrouter", "evalops/openrouter/auto"),
            "openrouter/auto"
        );
        assert_eq!(
            telemetry_provider_model("openai", "openai/gpt-5.5"),
            "gpt-5.5"
        );
    }

    #[test]
    fn managed_provider_ref_defaults_are_canonical() {
        assert_eq!(canonical_managed_environment(None), "production");
        assert_eq!(canonical_managed_environment(Some("prod")), "production");
        assert_eq!(
            canonical_managed_environment(Some(" Production ")),
            "Production"
        );
        assert_eq!(canonical_managed_environment(Some("staging")), "staging");
        assert_eq!(canonical_managed_credential_name(None), "default");
        assert_eq!(
            canonical_managed_credential_name(Some(" team-shared ")),
            "team-shared"
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
            (
                "MAESTRO_EVALOPS_ENVIRONMENT".to_string(),
                "prod".to_string(),
            ),
            (
                "MAESTRO_EVALOPS_WORKSPACE_ID".to_string(),
                "workspace_456".to_string(),
            ),
        ]);
        let resolved = ProviderRegistry::require("evalops/claude-sonnet-4-5", &env).unwrap();
        let client = UnifiedClient::from_resolved_provider(&resolved, &env).unwrap();
        assert!(matches!(client, UnifiedClient::OpenAI(_)));

        let mut alias_env = env.clone();
        alias_env.insert(
            "MAESTRO_EVALOPS_WORKSPACE_ID".to_string(),
            "   ".to_string(),
        );
        alias_env.insert(
            "EVALOPS_WORKSPACE_ID".to_string(),
            "workspace_alias".to_string(),
        );
        let alias_client = UnifiedClient::from_resolved_provider(&resolved, &alias_env).unwrap();
        let UnifiedClient::OpenAI(alias_client) = alias_client else {
            panic!("managed provider should use the OpenAI-compatible client");
        };
        assert_eq!(
            alias_client.headers().get("x-workspace-id").unwrap(),
            "workspace_alias"
        );

        let missing_org = HashMap::from([(
            "MAESTRO_EVALOPS_ACCESS_TOKEN".to_string(),
            "delegated-token".to_string(),
        )]);
        let resolved = ProviderRegistry::require("evalops/gpt-4o-mini", &missing_org).unwrap();
        assert!(UnifiedClient::from_resolved_provider(&resolved, &missing_org).is_err());
    }

    #[test]
    fn bedrock_provider_matrix_constructs_native_client() {
        let env = HashMap::from([
            ("AWS_ACCESS_KEY_ID".to_string(), "access".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "secret".to_string()),
            ("AWS_REGION".to_string(), "eu-west-1".to_string()),
            (
                "AWS_BEDROCK_ENDPOINT".to_string(),
                "http://localhost:4566/".to_string(),
            ),
        ]);
        let resolved =
            ProviderRegistry::require("bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0", &env)
                .unwrap();
        assert_eq!(resolved.provider.protocol, ProviderProtocol::Bedrock);
        let client = UnifiedClient::from_resolved_provider(&resolved, &env).unwrap();
        assert_eq!(client.provider(), AiProvider::Bedrock);
        assert_eq!(client.provider_name(), "bedrock");
        let UnifiedClient::Bedrock(client) = client else {
            panic!("bedrock descriptor must construct the native Bedrock client");
        };
        assert_eq!(client.region(), "eu-west-1");
        assert_eq!(client.endpoint_url(), Some("http://localhost:4566"));
    }

    #[test]
    fn bedrock_alias_and_allowlist_remain_scoped() {
        let env = HashMap::from([
            ("AWS_ACCESS_KEY_ID".to_string(), "access".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "secret".to_string()),
        ]);
        let resolved =
            ProviderRegistry::require("aws-bedrock/amazon.nova-lite-v1:0", &env).unwrap();
        assert_eq!(resolved.provider.id, "bedrock");
        assert_eq!(resolved.provider.protocol, ProviderProtocol::Bedrock);
        assert!(ProviderRegistry::resolve("openai/gpt-4o", &env)
            .unwrap()
            .credential
            .is_none());

        let unrelated = HashMap::from([("OPENAI_API_KEY".to_string(), "secret".to_string())]);
        let error = ProviderRegistry::require("bedrock/amazon.nova-lite-v1:0", &unrelated)
            .unwrap_err()
            .to_string();
        assert!(error.contains("AWS_ACCESS_KEY_ID"));
        assert!(error.contains("AWS_PROFILE"));
    }

    #[test]
    fn bedrock_client_construction_reports_precise_missing_credentials() {
        let env = HashMap::new();
        let resolved = ProviderRegistry::resolve("bedrock/amazon.nova-lite-v1:0", &env).unwrap();
        let error = match UnifiedClient::from_resolved_provider(&resolved, &env) {
            Ok(_) => panic!("missing AWS configuration must fail closed"),
            Err(error) => error.to_string(),
        };
        assert!(error.starts_with("Bedrock requires AWS credentials."));
        assert!(error.contains("AWS_SECRET_ACCESS_KEY"));
        assert!(error.contains("AWS_CONFIG_FILE"));
        assert!(error.contains("AWS_CONTAINER_CREDENTIALS_FULL_URI"));
    }

    #[test]
    fn provider_name_preserves_openrouter_route_identity() {
        let env = HashMap::from([("OPENROUTER_API_KEY".to_string(), "secret".to_string())]);
        let resolved =
            ProviderRegistry::require("openrouter/anthropic/claude-sonnet-4.5:free", &env).unwrap();
        let client = UnifiedClient::from_resolved_provider(&resolved, &env).unwrap();

        assert!(matches!(client, UnifiedClient::OpenAI(_)));
        assert_eq!(client.provider(), AiProvider::OpenAI);
        assert_eq!(client.provider_name(), "openrouter");
    }

    #[test]
    fn vertex_provider_builds_native_client_from_resolved_env() {
        let env = HashMap::from([
            ("VERTEX_ACCESS_TOKEN".to_string(), "oauth-token".to_string()),
            (
                "GOOGLE_CLOUD_PROJECT".to_string(),
                "project-123".to_string(),
            ),
            ("VERTEX_REGION".to_string(), "europe-west4".to_string()),
        ]);
        let resolved = ProviderRegistry::require("vertex-ai/gemini-2.5-pro", &env).unwrap();
        let client = UnifiedClient::from_resolved_provider(&resolved, &env).unwrap();

        assert!(matches!(client, UnifiedClient::VertexAi(_)));
        assert_eq!(client.provider(), AiProvider::VertexAi);
        assert_eq!(client.provider_name(), "vertex-ai");
    }

    #[test]
    fn from_model_with_explicit_env_constructs_without_process_injection() {
        let env = HashMap::from([("OPENAI_API_KEY".to_string(), "test-key".to_string())]);
        let client = UnifiedClient::from_model_with_env("openai/gpt-4o", &env)
            .expect("explicit environment should resolve OpenAI");
        assert_eq!(client.provider(), AiProvider::OpenAI);
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
    use crate::types::ProviderStreamErrorKind;
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

    #[test]
    fn managed_gateway_uses_product_bounded_stream_policy() {
        let direct = UnifiedClient::OpenAI(OpenAiClient::new("test-key").expect("direct client"));
        assert_eq!(
            direct.stream_idle_policy(),
            (DEFAULT_STREAM_IDLE_TIMEOUT, DEFAULT_STREAM_MAX_RETRIES)
        );

        let managed = UnifiedClient::OpenAI(
            OpenAiClient::with_base_url("delegated-token", "http://gateway.invalid/v1")
                .expect("managed client")
                .with_managed_gateway_context(
                    "org-test",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "production",
                        "credential_name": "default"
                    }),
                )
                .expect("managed scope"),
        );
        assert_eq!(
            managed.stream_idle_policy(),
            (
                MANAGED_GATEWAY_STREAM_IDLE_TIMEOUT,
                MANAGED_GATEWAY_STREAM_MAX_RETRIES
            )
        );
        assert_eq!(MANAGED_GATEWAY_STREAM_IDLE_TIMEOUT, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn stalled_stream_exhausts_retries_and_surfaces_error() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let mut keepalive = Keepalive::new();
        let first = hung_attempt(&mut keepalive);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(first),
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
            StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            } => {
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
            Some(attempt_rx),
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
            Some(first),
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
    async fn closed_stream_before_content_is_retried_and_success_streams() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let (first_tx, first_rx) = mpsc::unbounded_channel();
        drop(first_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(first_rx),
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
                let _ = attempt_tx.send(StreamEvent::MessageStart {
                    id: "msg-closed-retry".to_string(),
                    model: "test-model".to_string(),
                });
                let _ = attempt_tx.send(StreamEvent::TextDelta {
                    index: 0,
                    text: "recovered".to_string(),
                });
                let _ = attempt_tx.send(StreamEvent::MessageStop { stop_reason: None });
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
    async fn legacy_untyped_error_is_forwarded_without_retry() {
        let retried = Attempts::new(AtomicU32::new(0));
        let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
        attempt_tx
            .send(StreamEvent::Error {
                message: "provider returned 401".to_string(),
            })
            .unwrap();
        drop(attempt_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(attempt_rx),
            || {
                retried.fetch_add(1, Ordering::SeqCst);
                async move { unreachable!("provider errors must not retry") }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(retried.load(Ordering::SeqCst), 0);
        let events = drain(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [StreamEvent::Error { message }] if message == "provider returned 401"
        ));
    }

    #[tokio::test]
    async fn transient_provider_error_is_retried_only_by_stream_owner() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let (first_tx, first_rx) = mpsc::unbounded_channel();
        first_tx
            .send(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message: "gateway operation timeout".to_string(),
            })
            .unwrap();
        drop(first_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(first_rx),
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
                attempt_tx
                    .send(StreamEvent::ProviderError {
                        kind: ProviderStreamErrorKind::TransientProtocol,
                        message: "gateway operation timeout".to_string(),
                    })
                    .unwrap();
                drop(attempt_tx);
                async move { Ok(attempt_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(attempts.load(Ordering::SeqCst), RETRIES);
        let events = drain(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            }] if message == "gateway operation timeout"
        ));
    }

    #[tokio::test]
    async fn retry_open_failures_exhaust_one_stream_budget_with_one_typed_terminal() {
        let retry_starts = Attempts::new(AtomicU32::new(0));
        let (first_tx, first_rx) = mpsc::unbounded_channel();
        first_tx
            .send(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message: "gateway operation timeout".to_string(),
            })
            .unwrap();
        drop(first_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(first_rx),
            || {
                retry_starts.fetch_add(1, Ordering::SeqCst);
                async { Err(anyhow::anyhow!("gateway response-open timeout")) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(
            retry_starts.load(Ordering::SeqCst),
            RETRIES,
            "the initial request plus retry starts must equal the bounded attempt budget"
        );
        let events = drain(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            }] if message.contains("gateway response-open timeout")
        ));
    }

    #[tokio::test]
    async fn managed_gateway_timeout_has_one_bounded_retry_owner() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock gateway");
        let address = listener.local_addr().expect("mock gateway address");
        let requests = Attempts::new(AtomicU32::new(0));
        let server_requests = Arc::clone(&requests);
        let server = std::thread::spawn(move || {
            for _ in 0..=MANAGED_GATEWAY_STREAM_MAX_RETRIES {
                let (mut stream, _) = listener.accept().expect("accept gateway request");
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).expect("read gateway request");
                server_requests.fetch_add(1, Ordering::SeqCst);
                let body = r#"{"error":{"type":"server_error","message":"operation timed out"}}"#;
                write!(
                    stream,
                    "HTTP/1.1 504 Gateway Timeout\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body,
                )
                .expect("write gateway timeout");
            }
        });

        let client = UnifiedClient::OpenAI(
            OpenAiClient::with_base_url("delegated-token", format!("http://{address}/v1"))
                .expect("managed gateway client")
                .with_managed_gateway_context(
                    "org-test",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "production",
                        "credential_name": "default"
                    }),
                )
                .expect("managed gateway scope"),
        );
        let mut events = client
            .stream_owned_config_shared_messages(
                Arc::new(Vec::new()),
                RequestConfig {
                    model: "evalops/openai/gpt-5.6-terra".to_string(),
                    ..Default::default()
                },
            )
            .await
            .expect("gateway stream opens");

        assert!(matches!(
            events.recv().await,
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            }) if message.contains("504 Gateway Timeout")
        ));
        assert!(
            events.recv().await.is_none(),
            "terminal error must be emitted once"
        );
        server.join().expect("mock gateway server");
        assert_eq!(
            requests.load(Ordering::SeqCst),
            MANAGED_GATEWAY_STREAM_MAX_RETRIES + 1,
            "the stream owner must be the only retry owner"
        );
    }

    #[tokio::test]
    async fn managed_gateway_response_open_timeouts_share_the_stream_attempt_budget() {
        use std::io::Read;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stalled mock gateway");
        listener
            .set_nonblocking(true)
            .expect("set mock gateway nonblocking");
        let address = listener.local_addr().expect("mock gateway address");
        let requests = Attempts::new(AtomicU32::new(0));
        let server_requests = Arc::clone(&requests);
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_millis(500);
            let mut last_request = std::time::Instant::now();
            while std::time::Instant::now() < deadline
                && (server_requests.load(Ordering::SeqCst) < MANAGED_GATEWAY_STREAM_MAX_RETRIES + 1
                    || last_request.elapsed() < Duration::from_millis(100))
            {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 4096];
                        let _ = stream.read(&mut request).expect("read gateway request");
                        server_requests.fetch_add(1, Ordering::SeqCst);
                        last_request = std::time::Instant::now();
                        // Accept the request but never open an HTTP response.
                        // Keep the socket alive past the client-side boundary.
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("accept mock gateway request: {error}"),
                }
            }
        });

        let client = UnifiedClient::OpenAI(
            OpenAiClient::with_base_url("delegated-token", format!("http://{address}/v1"))
                .expect("managed gateway client")
                .with_managed_gateway_context(
                    "org-test",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "production",
                        "credential_name": "default"
                    }),
                )
                .expect("managed gateway scope")
                .with_response_open_timeout_for_test(Duration::from_millis(25)),
        );
        let mut events = client
            .stream_owned_config_shared_messages(
                Arc::new(Vec::new()),
                RequestConfig {
                    model: "evalops/openai/gpt-5.6-terra".to_string(),
                    ..Default::default()
                },
            )
            .await
            .expect("stream owner is established before opening attempt one");

        assert!(matches!(
            events.recv().await,
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            }) if message.contains("response headers timed out")
        ));
        assert!(
            events.recv().await.is_none(),
            "exhaustion must emit exactly one typed terminal event"
        );
        server.join().expect("mock gateway server");
        assert_eq!(
            requests.load(Ordering::SeqCst),
            MANAGED_GATEWAY_STREAM_MAX_RETRIES + 1,
            "initial response opening and retries must share one three-attempt budget"
        );
    }

    #[tokio::test]
    async fn deterministic_request_error_is_forwarded_once_without_retry() {
        let retried = Attempts::new(AtomicU32::new(0));
        let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
        attempt_tx
            .send(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::OutputTokenExhaustion,
                message: "openai_response_exhausted: reason=max_output_tokens".to_string(),
            })
            .unwrap();
        drop(attempt_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(attempt_rx),
            || {
                retried.fetch_add(1, Ordering::SeqCst);
                async move { unreachable!("deterministic request errors must not retry") }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(retried.load(Ordering::SeqCst), 0);
        let events = drain(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::OutputTokenExhaustion,
                message,
            }]
                if message == "openai_response_exhausted: reason=max_output_tokens"
        ));
    }

    #[tokio::test]
    async fn closed_stream_after_partial_content_surfaces_error_without_retry() {
        let retried = Attempts::new(AtomicU32::new(0));
        let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
        attempt_tx
            .send(StreamEvent::TextDelta {
                index: 0,
                text: "partial".to_string(),
            })
            .unwrap();
        drop(attempt_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(attempt_rx),
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

        assert_eq!(retried.load(Ordering::SeqCst), 0);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::TextDelta { .. }));
        match &events[1] {
            StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            } => assert!(
                message.contains("closed mid-response"),
                "error should explain why no retry happened: {message}"
            ),
            other => panic!("expected terminal error event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn closed_stream_exhausts_retries_and_surfaces_error() {
        let attempts = Attempts::new(AtomicU32::new(0));
        let (first_tx, first_rx) = mpsc::unbounded_channel();
        drop(first_tx);
        let (tx, mut rx) = mpsc::unbounded_channel();

        forward_stream_with_idle_policy(
            Some(first_rx),
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                let (attempt_tx, attempt_rx) = mpsc::unbounded_channel();
                drop(attempt_tx);
                async move { Ok(attempt_rx) }
            },
            IDLE,
            RETRIES,
            tx,
        )
        .await;

        assert_eq!(attempts.load(Ordering::SeqCst), RETRIES);
        let events = drain(&mut rx);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            } => {
                assert!(
                    message.contains("closed without a terminal event"),
                    "error should name the abnormal closure: {message}"
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
            Some(attempt_rx),
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
            StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            } => {
                assert!(
                    message.contains("mid-response"),
                    "error should explain why no retry happened: {message}"
                );
            }
            other => panic!("expected terminal error event, got {other:?}"),
        }
    }
}

//! `OpenAI` API Client
//!
//! Implements streaming communication with `OpenAI`'s APIs, supporting two different endpoints:
//!
//! # API Endpoints
//!
//! ## Chat Completions API (`/v1/chat/completions`)
//!
//! Used by standard models like GPT-4o, GPT-4 Turbo, o1-preview, o1-mini:
//!
//! - Request format: Array of messages with role/content
//! - Streaming: Line-based SSE with `data:` prefix
//! - Tool calls: Accumulated in delta events, sent in completion
//! - Special marker: `data: [DONE]` signals end of stream
//!
//! ## Responses API (`/v1/responses`)
//!
//! Used by advanced models like gpt-5.1-codex-max, gpt-5.1-codex-lite, o3:
//!
//! - Request format: Array of `ResponseItems` (messages, function calls, outputs)
//! - Streaming: Structured SSE with distinct event types
//! - Tool calls: Sent as separate `function_call` items
//! - Reasoning: Native reasoning/thinking support with encrypted content
//! - Schema restrictions: No oneOf/anyOf/allOf at top level
//!
//! Note: Responses API models may require `ChatGPT` Plus authentication.
//!
//! # Rust Concepts
//!
//! ## Two SSE Parsing Strategies
//!
//! This module demonstrates two approaches to parsing Server-Sent Events:
//!
//! ### 1. Manual Line-Based Parsing (Chat Completions)
//!
//! ```rust,ignore
//! let mut buffer = String::new();
//! while let Some(chunk) = stream.next().await {
//!     buffer.push_str(&String::from_utf8_lossy(&chunk?));
//!     while let Some(pos) = buffer.find('\n') {
//!         let line = buffer[..pos].trim();
//!         // Process line...
//!     }
//! }
//! ```
//!
//! Advantages: Simple, full control, minimal dependencies.
//!
//! ### 2. eventsource-stream Crate (Responses API)
//!
//! ```rust,ignore
//! let mut sse_stream = stream
//!     .map(|result| result.map_err(std::io::Error::other))
//!     .eventsource();
//! while let Some(event_result) = sse_stream.next().await {
//!     // event_result contains parsed SSE event
//! }
//! ```
//!
//! Advantages: Handles reconnection, proper SSE spec compliance.
//!
//! ## Pattern Matching for API Selection
//!
//! Uses provider-aware model detection for API selection:
//!
//! ```rust,ignore
//! fn uses_responses_api(provider: Option<&str>, model: &str) -> bool {
//!     // OpenRouter model ids are opaque and stay on Chat Completions unless
//!     // the provider/model catalog explicitly maps them to Responses.
//!     provider == Some("openrouter") && model.starts_with("gpt-5.6-")
//! }
//! ```
//!
//! ## Function Composition
//!
//! The module uses helper functions to organize complex logic:
//!
//! - `classify_error()`: Maps API errors to retry strategies
//! - `extract_function_call()`: Parses function call items
//! - `filter_responses_api_tools()`: Removes incompatible tool schemas
//! - `parse_retry_after()`: Extracts retry duration from error messages
//!
//! ## Error Classification for Retries
//!
//! The `ApiError` enum classifies errors into categories:
//!
//! - `ContextWindowExceeded`: Fatal, need to reduce input
//! - `QuotaExceeded`: Fatal, billing issue
//! - `RateLimited`: Retryable with delay
//! - `Retryable`: Temporary failures (server overload)
//! - `Fatal`: Authentication, invalid requests
//!
//! # Example: Model-Specific Behavior
//!
//! ```rust,ignore
//! let body = if uses_responses_api(Some("openai"), &config.model) {
//!     self.build_responses_request_body(messages, config)
//! } else {
//!     self.build_chat_request_body(messages, config)
//! };
//! ```
//!
//! This demonstrates runtime polymorphism without trait objects - the decision
//! is made at runtime but with zero-cost static dispatch.

use anyhow::{Context, Result};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::client::{provider_model_name, AiClient, AiProvider};
use super::op_secret;
use super::types::{
    ContentBlock, ImageSource, Message, MessageContent, ProviderStreamErrorKind, RequestConfig,
    Role, StreamEvent, Tool,
};

pub(crate) const MANAGED_GATEWAY_RESPONSE_OPEN_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);

/// SSE event structure for Responses API (matches `OpenAI`'s format)
///
/// # Serde Field Attributes
///
/// - `#[serde(rename = "type")]`: Map Rust field `kind` to JSON field `type`
///   (avoiding Rust keyword)
/// - `#[serde(default)]`: Use default value (None) if field is missing
/// - `#[allow(dead_code)]`: Suppress warnings for fields reserved for future use
///
/// # Event Types
///
/// The Responses API emits many event types:
///
/// - `response.created`: Initial response metadata
/// - `response.output_item.added`: New output item started
/// - `response.output_text.delta`: Incremental text content
/// - `response.function_call_arguments.delta`: Incremental tool arguments
/// - `response.reasoning_text.delta`: Thinking/reasoning content
/// - `response.completed`: Response finished successfully
/// - `response.failed`: Error occurred
#[derive(Debug, Deserialize)]
struct ResponsesSseEvent {
    /// Event type (e.g., "response.created", "`response.output_text.delta`")
    #[serde(rename = "type")]
    kind: String,
    /// Response metadata (present in some events)
    #[serde(default)]
    response: Option<serde_json::Value>,
    /// Output item data (present in item-related events)
    #[serde(default)]
    item: Option<serde_json::Value>,
    /// Content part data (present in content-part events)
    #[serde(default)]
    part: Option<serde_json::Value>,
    /// Delta content (text, reasoning, or arguments)
    #[serde(default)]
    delta: Option<String>,
    /// Index of the content part within the output item (for multi-part content)
    #[serde(default)]
    #[allow(dead_code)] // Reserved for future multi-part content support
    content_index: Option<i64>,
    /// Index for reasoning summaries (reserved for future use)
    #[serde(default)]
    #[allow(dead_code)] // Reserved for future reasoning summary support
    summary_index: Option<i64>,
    /// Index of the output item in the response
    #[serde(default)]
    output_index: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
struct IncompleteResponseError {
    kind: ProviderStreamErrorKind,
    reason: String,
}

impl std::fmt::Display for IncompleteResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self.kind {
            ProviderStreamErrorKind::OutputTokenExhaustion => "openai_response_exhausted",
            ProviderStreamErrorKind::TransientProtocol
            | ProviderStreamErrorKind::IncompleteResponse => "openai_response_incomplete",
            ProviderStreamErrorKind::ProviderDeclaredFailure => "openai_response_failed",
        };
        write!(formatter, "{code}: reason={}", self.reason)
    }
}

impl std::error::Error for IncompleteResponseError {}

fn incomplete_response_error(response: Option<&serde_json::Value>) -> IncompleteResponseError {
    let reason = response
        .and_then(|response| response.get("incomplete_details"))
        .and_then(|details| details.get("reason"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let kind = if reason == "max_output_tokens" {
        ProviderStreamErrorKind::OutputTokenExhaustion
    } else {
        ProviderStreamErrorKind::IncompleteResponse
    };
    IncompleteResponseError { kind, reason }
}

const RESPONSES_MISSING_TERMINAL_EVENT_ERROR: &str =
    "openai_response_protocol_error: kind=transient reason=missing_terminal_event";

async fn send_with_response_open_timeout(
    request: reqwest::RequestBuilder,
    timeout: Option<std::time::Duration>,
) -> Result<reqwest::Response> {
    let send = request.send();
    match timeout {
        Some(timeout) => tokio::time::timeout(timeout, send)
            .await
            .map_err(|_| anyhow::anyhow!("managed gateway response headers timed out"))?,
        None => send.await,
    }
    .context("Failed to send request to OpenAI API")
}

fn missing_text_suffix(emitted: &str, aggregate: &str) -> Option<String> {
    if aggregate.is_empty() || emitted.starts_with(aggregate) {
        None
    } else {
        aggregate
            .strip_prefix(emitted)
            .filter(|suffix| !suffix.is_empty())
            .map(str::to_string)
    }
}

/// Error classification for retry logic
///
/// This enum categorizes API errors to determine the appropriate retry strategy.
/// It's used internally by error handling logic to decide whether to retry,
/// wait, or fail immediately.
///
/// # Design Pattern
///
/// This is the "parse, don't validate" pattern - instead of checking error
/// strings repeatedly, we parse once into a structured type that encodes
/// the retry decision.
#[derive(Debug, Clone)]
pub enum ApiError {
    /// Context window exceeded - fatal, need to reduce input
    ///
    /// This error means the conversation history is too long. The client
    /// should truncate messages or use a model with a larger context window.
    ContextWindowExceeded,

    /// Quota exceeded - fatal, billing issue
    ///
    /// The API key has exceeded its usage quota. This requires manual
    /// intervention (upgrading plan, adding billing info).
    QuotaExceeded,

    /// Rate limited - retryable with delay
    ///
    /// Too many requests in a short time. Should retry after the specified
    /// duration (or a default backoff if not specified).
    RateLimited {
        retry_after: Option<std::time::Duration>,
    },

    /// Generic retryable error
    ///
    /// Temporary server issues (overloaded, maintenance). Should retry
    /// with exponential backoff.
    Retryable { message: String },

    /// Fatal error
    ///
    /// Permanent failures (invalid API key, bad request, model not found).
    /// Retrying won't help - the request needs to be fixed.
    Fatal { message: String },
}

/// Extract function call from a `ResponseItem`
///
/// # Pattern: Option Chaining
///
/// This function uses the `?` operator with `Option` to short-circuit if any
/// field is missing. This is more concise than nested `if let` or `match`:
///
/// ```rust,ignore
/// let item_type = item.get("type")?.as_str()?;  // Returns None if missing
/// ```
///
/// # Returns
///
/// `Some((call_id, name, arguments))` if this is a `function_call` item,
/// `None` otherwise.
fn extract_function_call(item: &serde_json::Value) -> Option<(String, String, serde_json::Value)> {
    let item_type = item.get("type")?.as_str()?;
    if item_type != "function_call" {
        return None;
    }

    let call_id = item.get("call_id")?.as_str()?.to_string();
    let name = item.get("name")?.as_str()?.to_string();
    let arguments = item.get("arguments")?;
    if !matches!(arguments, serde_json::Value::String(_)) {
        let kind = match arguments {
            serde_json::Value::Null => "null",
            serde_json::Value::Bool(_) => "bool",
            serde_json::Value::Number(_) => "number",
            serde_json::Value::String(_) => "string",
            serde_json::Value::Array(_) => "array",
            serde_json::Value::Object(_) => "object",
        };
        eprintln!(
            "[openai] function_call.arguments was {kind}; expected string (call_id={call_id}, name={name})"
        );
    }
    let arguments_value = match arguments {
        serde_json::Value::String(raw) => {
            serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({}))
        }
        serde_json::Value::Null => serde_json::json!({}),
        other => other.clone(),
    };

    Some((call_id, name, arguments_value))
}

/// Check if an error message indicates context window overflow.
///
/// This function detects context overflow errors from multiple LLM providers
/// by checking for known error message patterns.
///
/// # Supported Providers
///
/// - **Anthropic**: "prompt is too long: X tokens > Y maximum"
/// - **`OpenAI`**: "exceeds the context window"
/// - **Google Gemini**: "input token count exceeds the maximum"
/// - **xAI (Grok)**: "maximum prompt length is X but request contains Y"
/// - **Groq**: "reduce the length of the messages"
/// - **Cerebras/Mistral**: 400/413 status code (no body)
/// - **`OpenRouter`**: "maximum context length is X tokens"
/// - **llama.cpp**: "exceeds the available context size"
/// - **LM Studio**: "greater than the context length"
///
/// # Returns
///
/// `true` if the message indicates a context overflow error.
pub fn is_context_overflow_error(message: &str) -> bool {
    let lower = message.to_lowercase();

    // Provider-specific patterns
    if lower.contains("prompt is too long")
        || lower.contains("exceeds the context window")
        || (lower.contains("input token count") && lower.contains("exceeds the maximum"))
        || (lower.contains("maximum prompt length is") && lower.contains("contains"))
        || lower.contains("reduce the length of the messages")
        || lower.contains("maximum context length is")
        || lower.contains("exceeds the available context size")
        || lower.contains("greater than the context length")
    {
        return true;
    }

    // Generic fallback patterns
    if lower.contains("context length exceeded")
        || lower.contains("too many tokens")
        || lower.contains("token limit exceeded")
        || (lower.contains("context window") && lower.contains("exceeded"))
        || (lower.contains("maximum") && lower.contains("tokens") && lower.contains("exceeded"))
    {
        return true;
    }

    // Cerebras and Mistral return 400/413 with no body
    // Match patterns like "400 status code (no body)" or "413 (no body)"
    if (lower.contains("400") || lower.contains("413")) && lower.contains("(no body)") {
        return true;
    }

    false
}

/// Classify API error for retry logic
///
/// # Strategy
///
/// 1. Check for context overflow first (most important for agent loop)
/// 2. Check error code (most reliable)
/// 3. Fall back to error type
/// 4. Check message for keywords ("overloaded", "temporarily")
///
/// # Pattern: Early Returns
///
/// Uses pattern matching with early returns for clarity:
///
/// ```rust,ignore
/// match code {
///     Some("rate_limit_exceeded") => return ApiError::RateLimited { ... },
///     Some("invalid_api_key") => return ApiError::Fatal { ... },
///     _ => { /* continue checking */ }
/// }
/// ```
///
/// This is more readable than deeply nested if/else chains.
fn classify_error(error: &serde_json::Value) -> ApiError {
    let code = error.get("code").and_then(|c| c.as_str());
    let error_type = error.get("type").and_then(|t| t.as_str());
    let message = error
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string();

    // Check for context overflow first (may not have a specific error code)
    if is_context_overflow_error(&message) {
        return ApiError::ContextWindowExceeded;
    }

    match code {
        Some("context_length_exceeded") => ApiError::ContextWindowExceeded,
        Some("insufficient_quota") => ApiError::QuotaExceeded,
        Some("rate_limit_exceeded") => {
            // Try to parse retry-after from message
            let retry_after = parse_retry_after(&message);
            ApiError::RateLimited { retry_after }
        }
        // Fatal errors that should not be retried
        Some("invalid_api_key" | "model_not_found" | "invalid_request_error") => {
            ApiError::Fatal { message }
        }
        _ => {
            // Check error type for additional classification
            match error_type {
                Some("authentication_error" | "permission_error") => ApiError::Fatal { message },
                Some("server_error" | "service_unavailable") => ApiError::Retryable { message },
                _ => {
                    // Default: check if message suggests retryable
                    if message.contains("overloaded") || message.contains("temporarily") {
                        ApiError::Retryable { message }
                    } else {
                        ApiError::Fatal { message }
                    }
                }
            }
        }
    }
}

/// Parse retry-after duration from error message
fn parse_retry_after(message: &str) -> Option<std::time::Duration> {
    // Pattern: "try again in X.XXs" or "try again in X seconds"
    let lower = message.to_lowercase();
    if let Some(pos) = lower.find("try again in") {
        let after = &lower[pos + 13..];
        // Try to parse number
        let num_str: String = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if let Ok(num) = num_str.parse::<f64>() {
            // Check unit
            let rest = &after[num_str.len()..].trim_start();
            if rest.starts_with("ms") {
                return Some(std::time::Duration::from_millis(num as u64));
            }
            // Assume seconds
            return Some(std::time::Duration::from_secs_f64(num));
        }
    }
    None
}

/// Check if a tool schema has incompatible constructs for Responses API
///
/// The Responses API has stricter schema requirements than Chat Completions.
/// It doesn't support JSON Schema combinators at the top level:
///
/// - `oneOf`: Union types (A OR B)
/// - `anyOf`: Any of multiple schemas
/// - `allOf`: Intersection types (A AND B)
/// - `not`: Negation
/// - `enum`: Top-level enums
///
/// These are often used in complex tool schemas but must be avoided for
/// Responses API compatibility. Consider simplifying schemas or using
/// Chat Completions API instead.
///
/// # Pattern: Object Introspection
///
/// Uses `as_object()` to check if JSON value is an object, then checks
/// for specific keys:
///
/// ```rust,ignore
/// if let Some(obj) = schema.as_object() {
///     obj.contains_key("oneOf") || obj.contains_key("anyOf")
/// }
/// ```
fn has_incompatible_schema(schema: &serde_json::Value) -> bool {
    if let Some(obj) = schema.as_object() {
        obj.contains_key("oneOf")
            || obj.contains_key("anyOf")
            || obj.contains_key("allOf")
            || obj.contains_key("not")
            // Top-level enum is also problematic
            || obj.contains_key("enum")
    } else {
        false
    }
}

/// Filter tools to only include those compatible with Responses API
fn filter_responses_api_tools(tools: &[Tool]) -> Vec<Tool> {
    tools
        .iter()
        .filter(|tool| {
            // Tool must have a name
            if tool.name.trim().is_empty() {
                return false;
            }
            // Check schema compatibility
            !has_incompatible_schema(&tool.input_schema)
        })
        .cloned()
        .collect()
}

/// Extract text from a `ResponseItem` (Message type with `output_text` content)
fn extract_text_from_item(item: &serde_json::Value) -> Option<String> {
    let item_type = item.get("type")?.as_str()?;
    if item_type != "message" {
        return None;
    }

    let content = item.get("content")?.as_array()?;
    let mut text = String::new();
    for part in content {
        if let Some(part_type) = part.get("type").and_then(|v| v.as_str()) {
            if part_type == "output_text" {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }

    if text.is_empty() {
        None
    } else {
        Some(text)
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

/// Returns true if the model uses the Responses API (vs Chat Completions).
///
/// OpenRouter exposes one OpenAI-compatible Chat Completions surface for its
/// broad model catalog. Its model ids are opaque, often nested
/// (`openrouter/anthropic/claude-...`), and must not inherit OpenAI's model-name
/// heuristic. OpenRouter's stable Chat Completions surface owns routed models;
/// only the explicitly mapped plain gpt-5.6 alias remains on its beta Responses
/// surface. In particular, Terra must use Chat Completions: production proved
/// that the beta Responses route can accept the request without opening a
/// response, exhausting the bounded stream retry budget without an answer.
fn uses_responses_api(provider: Option<&str>, model: &str) -> bool {
    let managed_namespace = has_managed_model_prefix(model);
    let model = strip_managed_model_prefix(model).trim();
    let inferred_provider = model.split_once('/').map(|(provider, _)| provider.trim());
    let provider = provider.or(inferred_provider);
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
    normalized.contains("codex") || normalized.starts_with("gpt-5") || normalized.starts_with("o3")
}

/// Check if this is a Mistral model (requires special tool ID handling)
///
/// Mistral API has specific requirements:
/// - Tool call IDs must be exactly 9 alphanumeric characters
/// - Tool results must include the `name` field
fn is_mistral_model(model: &str, base_url: Option<&str>) -> bool {
    let model_lower = model.to_lowercase();
    if model_lower.contains("mistral")
        || model_lower.contains("mixtral")
        || model_lower.contains("codestral")
        || model_lower.contains("pixtral")
    {
        return true;
    }
    if let Some(url) = base_url {
        if url.contains("mistral.ai") {
            return true;
        }
    }
    false
}

/// Check if this is a Groq-hosted model
///
/// Groq provides fast inference using their LPU (Language Processing Unit).
/// They host models like Llama, Mixtral, Gemma, `DeepSeek`, and Qwen.
/// Groq uses OpenAI-compatible API format with no special handling required.
fn is_groq_model(model: &str, base_url: Option<&str>) -> bool {
    let model_lower = model.to_lowercase();
    // Explicit groq/ prefix
    if model_lower.starts_with("groq/") {
        return true;
    }
    // A custom base URL pins the provider: only Groq's host is Groq. This keeps
    // Groq-specific request shaping (e.g. omitting parallel_tool_calls) off the
    // direct DeepSeek/DashScope/etc. clients, whose ids also contain "deepseek"
    // or "qwen".
    if let Some(url) = base_url {
        return url.contains("groq.com");
    }
    // No custom base URL: fall back to model-name heuristics for the open models
    // commonly hosted on Groq (Llama, and DeepSeek/Qwen distill/coder variants).
    model_lower.starts_with("llama-")
        || model_lower.starts_with("llama3")
        || model_lower.contains("deepseek")
        || model_lower.contains("qwen")
}

/// Normalize a tool call ID for Mistral compatibility.
///
/// Mistral requires tool IDs to be exactly 9 alphanumeric characters.
/// This function:
/// - Removes non-alphanumeric characters
/// - Pads with zeros if too short
/// - Truncates if too long
fn normalize_mistral_tool_id(id: &str) -> String {
    // Remove non-alphanumeric characters
    let normalized: String = id.chars().filter(|c| c.is_alphanumeric()).collect();

    // Ensure exactly 9 characters
    if normalized.len() < 9 {
        format!("{normalized:0<9}")
    } else if normalized.len() > 9 {
        normalized[..9].to_string()
    } else {
        normalized
    }
}

/// Get the appropriate API URL for the model
fn api_url_for_model(model: &str) -> &'static str {
    if uses_responses_api(None, model) {
        "https://api.openai.com/v1/responses"
    } else {
        "https://api.openai.com/v1/chat/completions"
    }
}

/// `OpenAI` API client
///
/// Handles communication with `OpenAI`'s APIs (Chat Completions and Responses).
/// Automatically selects the appropriate API endpoint based on model name.
/// Also supports Mistral API through OpenAI-compatible endpoint with special
/// tool ID handling.
///
/// # Thread Safety
///
/// Like `AnthropicClient`, this implements `Send + Sync` for safe concurrent use.
/// The `reqwest::Client` is internally synchronized and benefits from connection
/// pooling when reused across requests.
#[derive(Clone)]
pub struct OpenAiClient {
    /// Reusable HTTP client with connection pooling
    client: reqwest::Client,
    /// API key for authentication (via Authorization: Bearer header)
    api_key: String,
    /// Optional base URL override (for Mistral or other OpenAI-compatible APIs)
    base_url: Option<String>,
    extra_headers: HeaderMap,
    request_extensions: serde_json::Map<String, serde_json::Value>,
    managed_gateway: bool,
    managed_request_lineage: Option<ManagedRequestLineage>,
    route_provider: Option<String>,
    #[cfg(test)]
    response_open_timeout_override: Option<std::time::Duration>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedRequestLineage {
    pub(crate) lineage_id: String,
}

impl OpenAiClient {
    /// Create a new `OpenAI` client
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_mins(5))
            .build()
            .context("Failed to create HTTP client")?;
        let api_key = api_key.into().trim().to_string();

        Ok(Self {
            client,
            api_key,
            base_url: None,
            extra_headers: HeaderMap::new(),
            request_extensions: serde_json::Map::new(),
            managed_gateway: false,
            managed_request_lineage: None,
            route_provider: None,
            #[cfg(test)]
            response_open_timeout_override: None,
        })
    }

    /// Create a new client with a custom base URL (for Mistral or other providers)
    pub fn with_base_url(api_key: impl Into<String>, base_url: impl Into<String>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_mins(5))
            .build()
            .context("Failed to create HTTP client")?;
        let api_key = api_key.into().trim().to_string();

        Ok(Self {
            client,
            api_key,
            base_url: Some(base_url.into()),
            extra_headers: HeaderMap::new(),
            request_extensions: serde_json::Map::new(),
            managed_gateway: false,
            managed_request_lineage: None,
            route_provider: None,
            #[cfg(test)]
            response_open_timeout_override: None,
        })
    }

    pub(crate) fn with_route_provider(mut self, provider: &str) -> Self {
        self.route_provider = Some(provider.trim().to_string());
        self
    }

    pub(crate) fn routed_provider(&self) -> Option<&str> {
        self.route_provider.as_deref()
    }

    pub(crate) fn is_managed_gateway(&self) -> bool {
        self.managed_gateway
    }

    pub(crate) fn set_managed_request_lineage(&mut self, lineage_id: Option<String>) {
        self.managed_request_lineage =
            lineage_id.map(|lineage_id| ManagedRequestLineage { lineage_id });
    }

    fn response_open_timeout(&self) -> Option<std::time::Duration> {
        #[cfg(test)]
        if let Some(timeout) = self.response_open_timeout_override {
            return Some(timeout);
        }
        self.managed_gateway
            .then_some(MANAGED_GATEWAY_RESPONSE_OPEN_TIMEOUT)
    }

    #[cfg(test)]
    pub(crate) fn with_response_open_timeout_for_test(
        mut self,
        timeout: std::time::Duration,
    ) -> Self {
        self.response_open_timeout_override = Some(timeout);
        self
    }

    pub(crate) fn with_managed_gateway_context(
        mut self,
        organization_id: &str,
        provider_ref: serde_json::Value,
    ) -> Result<Self> {
        self.managed_gateway = true;
        self.extra_headers.insert(
            HeaderName::from_static("x-organization-id"),
            HeaderValue::from_str(organization_id).context("invalid EvalOps organization id")?,
        );
        self.request_extensions
            .insert("provider_ref".to_string(), provider_ref);
        Ok(self)
    }

    /// Attach the tenant scope used by a hosted Platform turn. The managed
    /// provider reference and both tenant headers must travel together so the
    /// gateway cannot resolve a model for one workspace while authorizing
    /// another.
    pub(crate) fn with_managed_gateway_scope(
        mut self,
        organization_id: &str,
        workspace_id: &str,
        provider_ref: serde_json::Value,
    ) -> Result<Self> {
        self = self.with_managed_gateway_context(organization_id, provider_ref)?;
        self.extra_headers.insert(
            HeaderName::from_static("x-workspace-id"),
            HeaderValue::from_str(workspace_id).context("invalid EvalOps workspace id")?,
        );
        Ok(self)
    }

    /// Create a new client from environment variable
    pub fn from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["OPENAI_API_KEY"])?;
        Self::new(api_key)
    }

    /// Create a new Mistral client from environment variable
    pub fn mistral_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["MISTRAL_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.mistral.ai/v1")
    }

    /// Create a new Groq client from environment variable
    ///
    /// Groq provides fast inference for open models like Llama, Mixtral, and Gemma.
    /// Uses OpenAI-compatible API format.
    pub fn groq_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["GROQ_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.groq.com/openai/v1")
    }

    /// Create a new DeepSeek client from environment variable.
    ///
    /// DeepSeek exposes an OpenAI-compatible API at `https://api.deepseek.com/v1`.
    pub fn deepseek_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["DEEPSEEK_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.deepseek.com/v1")
    }

    /// Create a new Moonshot (Kimi) client from environment variable.
    ///
    /// Uses the international endpoint `https://api.moonshot.ai/v1`. Accepts
    /// `MOONSHOT_API_KEY` or, as a fallback, `KIMI_API_KEY`.
    pub fn moonshot_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["MOONSHOT_API_KEY", "KIMI_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.moonshot.ai/v1")
    }

    /// Create a new Alibaba Qwen (DashScope) client from environment variable.
    ///
    /// Uses the international compatible-mode endpoint. Accepts
    /// `DASHSCOPE_API_KEY` or, as a fallback, `QWEN_API_KEY`.
    pub fn qwen_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["DASHSCOPE_API_KEY", "QWEN_API_KEY"])?;
        Self::with_base_url(
            api_key,
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        )
    }

    /// Create a new MiniMax client from environment variable.
    ///
    /// Uses the international endpoint `https://api.minimax.io/v1`.
    pub fn minimax_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["MINIMAX_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.minimax.io/v1")
    }

    /// Create a new Z.ai / Zhipu GLM client from environment variable.
    ///
    /// Uses the international endpoint `https://api.z.ai/api/coding/paas/v4`.
    pub fn zai_from_env() -> Result<Self> {
        let api_key = op_secret::env_credential(&["ZAI_API_KEY"])?;
        Self::with_base_url(api_key, "https://api.z.ai/api/coding/paas/v4")
    }

    /// Build request headers
    pub(crate) fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.api_key))
                .unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        headers.extend(self.extra_headers.clone());
        headers
    }

    fn managed_request(&self, mut body: serde_json::Value) -> Result<serde_json::Value> {
        let Some(lineage) = self.managed_request_lineage.as_ref() else {
            return Ok(body);
        };
        if !self.managed_gateway {
            return Ok(body);
        }

        let object = body
            .as_object_mut()
            .context("managed gateway request body must be an object")?;
        object.insert(
            "lineage_id".to_string(),
            serde_json::Value::String(lineage.lineage_id.clone()),
        );
        Ok(body)
    }

    /// Convert internal messages to `OpenAI` format
    ///
    /// When `is_mistral` is true, applies Mistral-specific transformations:
    /// - Tool call IDs are normalized to 9 alphanumeric characters
    /// - Tool results include the `name` field (required by Mistral)
    fn convert_messages(
        &self,
        messages: &[Message],
        is_mistral: bool,
        tool_id_to_name: &std::collections::HashMap<String, String>,
    ) -> Vec<OpenAiMessage> {
        let mut converted = Vec::new();
        for msg in messages {
            if let MessageContent::Blocks(blocks) = &msg.content {
                let tool_results: Vec<_> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => Some((tool_use_id, content)),
                        _ => None,
                    })
                    .collect();
                if !tool_results.is_empty() {
                    for (tool_use_id, content) in tool_results {
                        let normalized_id = if is_mistral {
                            normalize_mistral_tool_id(tool_use_id)
                        } else {
                            tool_use_id.clone()
                        };
                        converted.push(OpenAiMessage {
                            role: "tool".to_string(),
                            content: Some(OpenAiContent::Text(content.clone())),
                            tool_calls: None,
                            tool_call_id: Some(normalized_id),
                            name: is_mistral
                                .then(|| tool_id_to_name.get(tool_use_id).cloned())
                                .flatten(),
                        });
                    }
                    continue;
                }
            }
            if let Some(message) = self.convert_message(msg, is_mistral, tool_id_to_name) {
                converted.push(message);
            }
        }
        converted
    }

    /// Managed gateway requests use the exact Platform model key. Direct
    /// provider clients still receive the provider-native model id expected by
    /// their upstream API.
    fn request_model_name(&self, model: &str) -> String {
        let model = model.trim();
        if self.managed_gateway {
            // The managed gateway resolves the provider-native id itself.
            // Remove only Maestro's routing namespace; OpenRouter model ids
            // are opaque and may themselves begin with `openrouter/`.
            strip_managed_model_prefix(model).to_string()
        } else if self
            .route_provider
            .as_deref()
            .is_some_and(|provider| provider.eq_ignore_ascii_case("openrouter"))
        {
            // OpenRouter's native id is often `<vendor>/<model>`. Strip only
            // the optional outer routing prefix; a second pass must not turn
            // `anthropic/claude-...` into `claude-...`.
            strip_provider_model_prefix(model, "openrouter").to_string()
        } else {
            provider_model_name(model)
        }
    }

    fn uses_responses_api_for(&self, model: &str) -> bool {
        uses_responses_api(self.route_provider.as_deref(), model)
    }

    fn convert_message(
        &self,
        msg: &Message,
        is_mistral: bool,
        tool_id_to_name: &std::collections::HashMap<String, String>,
    ) -> Option<OpenAiMessage> {
        let role = match msg.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        };

        // Convert content
        match &msg.content {
            MessageContent::Text(text) => Some(OpenAiMessage {
                role: role.to_string(),
                content: Some(OpenAiContent::Text(text.clone())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }),
            MessageContent::Blocks(blocks) => {
                // Handle tool results specially
                if let Some(ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                }) = blocks.first()
                {
                    let normalized_id = if is_mistral {
                        normalize_mistral_tool_id(tool_use_id)
                    } else {
                        tool_use_id.clone()
                    };

                    // Mistral requires the tool name in tool results
                    let name = if is_mistral {
                        tool_id_to_name.get(tool_use_id).cloned()
                    } else {
                        None
                    };

                    return Some(OpenAiMessage {
                        role: "tool".to_string(),
                        content: Some(OpenAiContent::Text(content.clone())),
                        tool_calls: None,
                        tool_call_id: Some(normalized_id),
                        name,
                    });
                }

                // Chat Completions requires an assistant `tool_calls`
                // array before any subsequent `role: tool` result.
                // Serializing tool uses as text leaves tool results
                // orphaned and is rejected by OpenAI.
                if msg.role == Role::Assistant {
                    let tool_calls: Vec<OpenAiToolCall> = blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::ToolUse { id, name, input } => Some(OpenAiToolCall {
                                index: None,
                                id: Some(id.clone()),
                                tool_type: Some("function".to_string()),
                                function: Some(OpenAiFunctionCall {
                                    name: Some(name.clone()),
                                    arguments: Some(
                                        serde_json::to_string(input)
                                            .unwrap_or_else(|_| "{}".to_string()),
                                    ),
                                }),
                            }),
                            _ => None,
                        })
                        .collect();
                    if !tool_calls.is_empty() {
                        let text = blocks
                            .iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<String>();
                        return Some(OpenAiMessage {
                            role: "assistant".to_string(),
                            content: (!text.is_empty()).then_some(OpenAiContent::Text(text)),
                            tool_calls: Some(tool_calls),
                            tool_call_id: None,
                            name: None,
                        });
                    }
                }

                // Convert blocks to OpenAI content parts
                let parts: Vec<OpenAiContentPart> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => {
                            Some(OpenAiContentPart::Text { text: text.clone() })
                        }
                        ContentBlock::Image { source } => match source {
                            ImageSource::Url { url } => Some(OpenAiContentPart::ImageUrl {
                                image_url: ImageUrlData {
                                    url: url.clone(),
                                    detail: None,
                                },
                            }),
                            ImageSource::Base64 { media_type, data } => {
                                Some(OpenAiContentPart::ImageUrl {
                                    image_url: ImageUrlData {
                                        url: format!("data:{media_type};base64,{data}"),
                                        detail: None,
                                    },
                                })
                            }
                        },
                        ContentBlock::ToolUse { .. } => None,
                        _ => None,
                    })
                    .collect();

                if parts.is_empty() {
                    None
                } else if parts.len() == 1 {
                    if let OpenAiContentPart::Text { text } = &parts[0] {
                        Some(OpenAiMessage {
                            role: role.to_string(),
                            content: Some(OpenAiContent::Text(text.clone())),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        })
                    } else {
                        Some(OpenAiMessage {
                            role: role.to_string(),
                            content: Some(OpenAiContent::Parts(parts)),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        })
                    }
                } else {
                    Some(OpenAiMessage {
                        role: role.to_string(),
                        content: Some(OpenAiContent::Parts(parts)),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    })
                }
            }
        }
    }

    /// Build a mapping from tool call IDs to tool names from the message history.
    /// This is needed for Mistral which requires the tool name in tool results.
    fn build_tool_id_to_name_map(
        messages: &[Message],
    ) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        for msg in messages {
            if let MessageContent::Blocks(blocks) = &msg.content {
                for block in blocks {
                    if let ContentBlock::ToolUse { id, name, .. } = block {
                        map.insert(id.clone(), name.clone());
                    }
                }
            }
        }
        map
    }

    /// Convert internal tools to `OpenAI` format
    fn convert_tools(&self, tools: &[Tool]) -> Vec<OpenAiTool> {
        tools
            .iter()
            .map(|tool| OpenAiTool {
                tool_type: "function".to_string(),
                function: OpenAiFunction {
                    name: tool.name.clone(),
                    description: Some(tool.description.clone()),
                    parameters: Some(tool.input_schema.clone()),
                },
            })
            .collect()
    }

    /// Build the request body for Chat Completions API
    fn build_chat_request_body(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> serde_json::Value {
        let model = self.request_model_name(&config.model);
        // Check if this is a Mistral model (needs special tool handling)
        let is_mistral = is_mistral_model(&model, self.base_url.as_deref());
        // Check if this is a Groq model (may need parameter adjustments)
        let is_groq = is_groq_model(&model, self.base_url.as_deref());

        // Build tool ID to name mapping for Mistral
        let tool_id_to_name = if is_mistral {
            Self::build_tool_id_to_name_map(messages)
        } else {
            std::collections::HashMap::new()
        };

        let openai_messages = self.convert_messages(messages, is_mistral, &tool_id_to_name);

        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": config.max_tokens,
            "messages": openai_messages,
            "stream": true,
            "stream_options": {
                "include_usage": true
            },
            // Nudge model to actually choose a tool when tools are present
            "tool_choice": if config.tools.is_empty() { serde_json::json!("none") } else { serde_json::json!("auto") }
        });

        // Only add parallel_tool_calls for providers that support it
        // Groq doesn't support this parameter, Mistral ignores it
        if !is_groq {
            body["parallel_tool_calls"] = serde_json::json!(true);
        }

        // Add system message if provided
        if let Some(system) = &config.system {
            // Prepend system message
            if let Some(msgs) = body["messages"].as_array_mut() {
                msgs.insert(
                    0,
                    serde_json::json!({
                        "role": "system",
                        "content": system
                    }),
                );
            }
        }

        if let Some(temp) = config.temperature {
            body["temperature"] = serde_json::json!(temp);
        }

        if !config.tools.is_empty() {
            body["tools"] = serde_json::json!(self.convert_tools(&config.tools));
        }

        // GPT-5.1 supports reasoning_effort for adaptive thinking
        if let Some(thinking) = &config.thinking {
            // Map thinking budget to reasoning effort
            let effort = if thinking.budget_tokens > 10000 {
                "high"
            } else if thinking.budget_tokens > 3000 {
                "medium"
            } else {
                "low"
            };
            body["reasoning_effort"] = serde_json::json!(effort);
        }

        body
    }

    /// Build the request body for Responses API (gpt-5.1-codex-* models)
    fn build_responses_request_body(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> serde_json::Value {
        let model = self.request_model_name(&config.model);
        // Convert messages to Responses API format
        // The input array contains ResponseItems, which can be messages, function calls, or function outputs
        let mut input: Vec<serde_json::Value> = Vec::new();

        for msg in messages {
            match msg.role {
                Role::System => continue, // System goes in instructions
                Role::User => {
                    // User messages use "input_text" content type
                    match &msg.content {
                        MessageContent::Text(text) => {
                            input.push(serde_json::json!({
                                "type": "message",
                                "role": "user",
                                "content": [{
                                    "type": "input_text",
                                    "text": text
                                }]
                            }));
                        }
                        MessageContent::Blocks(blocks) => {
                            // Check if this is tool results (they go as separate items, not in a message)
                            let mut has_tool_results = false;
                            for block in blocks {
                                if let ContentBlock::ToolResult {
                                    tool_use_id,
                                    content,
                                    is_error: _,
                                } = block
                                {
                                    has_tool_results = true;
                                    // The Responses API expects output as a plain string for success
                                    // Format: { type: "function_call_output", call_id: "...", output: "..." }
                                    input.push(serde_json::json!({
                                        "type": "function_call_output",
                                        "call_id": tool_use_id,
                                        "output": content
                                    }));
                                }
                            }

                            // If not tool results, treat as regular user message
                            if !has_tool_results {
                                let content: Vec<serde_json::Value> = blocks
                                    .iter()
                                    .filter_map(|block| match block {
                                        ContentBlock::Text { text } => Some(serde_json::json!({
                                            "type": "input_text",
                                            "text": text
                                        })),
                                        _ => None,
                                    })
                                    .collect();

                                if !content.is_empty() {
                                    input.push(serde_json::json!({
                                        "type": "message",
                                        "role": "user",
                                        "content": content
                                    }));
                                }
                            }
                        }
                    }
                }
                Role::Assistant => {
                    // Assistant messages use "output_text" content type
                    // Tool calls go as separate "function_call" items
                    match &msg.content {
                        MessageContent::Text(text) => {
                            input.push(serde_json::json!({
                                "type": "message",
                                "role": "assistant",
                                "content": [{
                                    "type": "output_text",
                                    "text": text
                                }]
                            }));
                        }
                        MessageContent::Blocks(blocks) => {
                            // First, collect any text content into a message
                            let text_content: Vec<serde_json::Value> = blocks
                                .iter()
                                .filter_map(|block| match block {
                                    ContentBlock::Text { text } => Some(serde_json::json!({
                                        "type": "output_text",
                                        "text": text
                                    })),
                                    _ => None,
                                })
                                .collect();

                            if !text_content.is_empty() {
                                input.push(serde_json::json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "content": text_content
                                }));
                            }

                            // Then, add tool calls as separate items
                            for block in blocks {
                                if let ContentBlock::ToolUse {
                                    id,
                                    name,
                                    input: args,
                                } = block
                                {
                                    input.push(serde_json::json!({
                                        "type": "function_call",
                                        "call_id": id,
                                        "name": name,
                                        "arguments": serde_json::to_string(args).unwrap_or_default()
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut body = serde_json::json!({
            "model": model,
            "input": input,
            "max_output_tokens": config.max_tokens,
            "stream": true,
            "parallel_tool_calls": true,
            // Tell the model tools are available and should be used when appropriate
            "tool_choice": if config.tools.is_empty() { serde_json::json!("none") } else { serde_json::json!("auto") },
        });

        // Add instructions (system prompt)
        if let Some(system) = &config.system {
            body["instructions"] = serde_json::json!(system);
        }

        // Add tools (filtered for Responses API compatibility)
        if !config.tools.is_empty() {
            let compatible_tools = filter_responses_api_tools(&config.tools);
            if !compatible_tools.is_empty() {
                let tools: Vec<serde_json::Value> = compatible_tools
                    .iter()
                    .map(|tool| {
                        serde_json::json!({
                            "type": "function",
                            "name": tool.name,
                            "description": tool.description,
                            "strict": false,
                            "parameters": tool.input_schema
                        })
                    })
                    .collect();
                body["tools"] = serde_json::json!(tools);
            }
        }

        // Add reasoning configuration
        // Codex models do reasoning by default, we need to include the content to see it
        if let Some(thinking) = &config.thinking {
            let effort = if thinking.budget_tokens > 10000 {
                "high"
            } else if thinking.budget_tokens > 3000 {
                "medium"
            } else {
                "low"
            };
            body["reasoning"] = serde_json::json!({
                "effort": effort,
                "summary": "auto"  // Request reasoning summaries
            });
        }

        // Always include reasoning content for visibility
        // This enables streaming of reasoning text (only encrypted_content is valid)
        body["include"] = serde_json::json!(["reasoning.encrypted_content"]);

        body
    }

    /// Build the appropriate request body based on model
    fn build_request_body(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> serde_json::Value {
        let mut body = if self.uses_responses_api_for(&config.model) {
            self.build_responses_request_body(messages, config)
        } else {
            self.build_chat_request_body(messages, config)
        };
        if let Some(object) = body.as_object_mut() {
            object.extend(self.request_extensions.clone());
        }
        body
    }

    /// Resolve the full request URL for a model.
    ///
    /// When a custom `base_url` is configured (Mistral, Groq, DeepSeek, Moonshot,
    /// DashScope, MiniMax, Z.ai, and other OpenAI-compatible providers), the
    /// request must target that provider's endpoint rather than the hardcoded
    /// OpenAI host. We append the OpenAI-compatible path (`/chat/completions` or
    /// `/responses`) to the configured base. Without a custom base, fall back to
    /// the OpenAI defaults.
    fn request_url(&self, model: &str) -> String {
        match &self.base_url {
            Some(base) => {
                let trimmed = base.trim_end_matches('/');
                if self.uses_responses_api_for(model) {
                    format!("{trimmed}/responses")
                } else {
                    format!("{trimmed}/chat/completions")
                }
            }
            None => api_url_for_model(model).to_string(),
        }
    }
}

impl AiClient for OpenAiClient {
    fn provider(&self) -> AiProvider {
        AiProvider::OpenAI
    }

    async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();

        // Build request body
        let body = self.managed_request(self.build_request_body(messages, config))?;

        // Get the appropriate API URL for this model, honoring any custom
        // provider base URL (Mistral/Groq/DeepSeek/Moonshot/DashScope/etc.).
        let api_url = self.request_url(&config.model);

        // Make request
        let request = self
            .client
            .post(&api_url)
            .headers(self.headers())
            .json(&body);
        let response =
            send_with_response_open_timeout(request, self.response_open_timeout()).await?;

        // Check for errors
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let kind = if status.is_server_error()
                || matches!(
                    status,
                    reqwest::StatusCode::REQUEST_TIMEOUT
                        | reqwest::StatusCode::CONFLICT
                        | reqwest::StatusCode::TOO_MANY_REQUESTS
                ) {
                ProviderStreamErrorKind::TransientProtocol
            } else {
                ProviderStreamErrorKind::ProviderDeclaredFailure
            };
            let _ = tx.send(StreamEvent::ProviderError {
                kind,
                message: format!(
                    "API error {status}: {}",
                    super::summarize_error_body(&error_text)
                ),
            });
            return Ok(rx);
        }

        // Spawn task to process SSE stream
        let model = config.model.clone();
        let is_responses_api = self.uses_responses_api_for(&config.model);

        if is_responses_api {
            // Use eventsource-stream for proper SSE parsing (Responses API)
            let stream = response.bytes_stream();
            tokio::spawn(async move {
                let mut sse_stream = stream
                    .map(|result| result.map_err(std::io::Error::other))
                    .eventsource();

                let mut content_started = false;
                let mut emitted_text = String::new();
                let mut emitted_tool_call_ids = std::collections::HashSet::new();
                let mut streamed_tool_argument_indices = std::collections::HashSet::new();
                let mut tool_indices_by_output = std::collections::HashMap::new();
                let mut tool_call_index = 1; // Start at 1, reserve 0 for text content

                while let Some(event_result) = sse_stream.next().await {
                    match event_result {
                        Ok(sse) => {
                            // Parse the SSE data as JSON
                            let event: ResponsesSseEvent = match serde_json::from_str(&sse.data) {
                                Ok(e) => e,
                                Err(_) => continue,
                            };

                            match event.kind.as_str() {
                                "response.created" => {
                                    if let Some(resp) = &event.response {
                                        if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                                            let _ = tx.send(StreamEvent::MessageStart {
                                                id: id.to_string(),
                                                model: model.clone(),
                                            });
                                        }
                                    }
                                }
                                // Reasoning/thinking events - stream as thinking deltas
                                "response.reasoning_summary_text.delta"
                                | "response.reasoning_text.delta" => {
                                    if let Some(delta) = &event.delta {
                                        let _ = tx.send(StreamEvent::ThinkingDelta {
                                            index: 0,
                                            thinking: delta.clone(),
                                        });
                                    }
                                }
                                "response.output_item.added" => {
                                    // Check if this is a message item (not reasoning)
                                    if let Some(item) = &event.item {
                                        let item_type = item.get("type").and_then(|v| v.as_str());
                                        if item_type == Some("message") && !content_started {
                                            content_started = true;
                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: 0,
                                                block: ContentBlock::Text {
                                                    text: String::new(),
                                                },
                                            });
                                        }
                                    }
                                }
                                "response.content_part.added"
                                    if event.part.as_ref().and_then(|part| {
                                        part.get("type").and_then(serde_json::Value::as_str)
                                    }) == Some("output_text")
                                        && !content_started =>
                                {
                                    content_started = true;
                                    let _ = tx.send(StreamEvent::ContentBlockStart {
                                        index: 0,
                                        block: ContentBlock::Text {
                                            text: String::new(),
                                        },
                                    });
                                }
                                "response.content_part.done" => {
                                    if let Some(text) = event
                                        .part
                                        .as_ref()
                                        .and_then(|part| part.get("text"))
                                        .and_then(serde_json::Value::as_str)
                                        .and_then(|text| missing_text_suffix(&emitted_text, text))
                                    {
                                        if !content_started {
                                            content_started = true;
                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: 0,
                                                block: ContentBlock::Text {
                                                    text: String::new(),
                                                },
                                            });
                                        }
                                        emitted_text.push_str(&text);
                                        let _ = tx.send(StreamEvent::TextDelta { index: 0, text });
                                    }
                                }
                                "response.output_item.done" => {
                                    if let Some(item) = &event.item {
                                        // Check if this is a function call
                                        if let Some((call_id, name, arguments)) =
                                            extract_function_call(item)
                                        {
                                            if !emitted_tool_call_ids.insert(call_id.clone()) {
                                                continue;
                                            }
                                            // Emit tool use block
                                            let tool_index =
                                                if let Some(output_index) = event.output_index {
                                                    *tool_indices_by_output
                                                        .entry(output_index)
                                                        .or_insert_with(|| {
                                                            let index = tool_call_index;
                                                            tool_call_index += 1;
                                                            index
                                                        })
                                                } else {
                                                    let index = tool_call_index;
                                                    tool_call_index += 1;
                                                    index
                                                };

                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: tool_index,
                                                block: ContentBlock::ToolUse {
                                                    id: call_id.clone(),
                                                    name: name.clone(),
                                                    input: arguments.clone(),
                                                },
                                            });

                                            if event.output_index.is_none_or(|output_index| {
                                                !streamed_tool_argument_indices
                                                    .contains(&output_index)
                                            }) {
                                                let _ = tx.send(StreamEvent::InputJsonDelta {
                                                    index: tool_index,
                                                    partial_json: arguments.to_string(),
                                                });
                                            }

                                            let _ = tx.send(StreamEvent::ContentBlockStop {
                                                index: tool_index,
                                                thinking_signature: None,
                                            });
                                        } else if let Some(text) = extract_text_from_item(item)
                                            .and_then(|text| {
                                                missing_text_suffix(&emitted_text, &text)
                                            })
                                        {
                                            if !content_started {
                                                content_started = true;
                                                let _ = tx.send(StreamEvent::ContentBlockStart {
                                                    index: 0,
                                                    block: ContentBlock::Text {
                                                        text: String::new(),
                                                    },
                                                });
                                            }
                                            emitted_text.push_str(&text);
                                            let _ =
                                                tx.send(StreamEvent::TextDelta { index: 0, text });
                                        }
                                    }
                                }
                                // Handle streaming function call arguments
                                "response.function_call_arguments.delta" => {
                                    if let Some(delta) = &event.delta {
                                        // Get or create tool call index
                                        let output_index = event.output_index.unwrap_or(0);
                                        streamed_tool_argument_indices.insert(output_index);
                                        let tool_idx = *tool_indices_by_output
                                            .entry(output_index)
                                            .or_insert_with(|| {
                                                let index = tool_call_index;
                                                tool_call_index += 1;
                                                index
                                            });

                                        let _ = tx.send(StreamEvent::InputJsonDelta {
                                            index: tool_idx,
                                            partial_json: delta.clone(),
                                        });
                                    }
                                }
                                "response.output_text.delta" => {
                                    if !content_started {
                                        content_started = true;
                                        let _ = tx.send(StreamEvent::ContentBlockStart {
                                            index: 0,
                                            block: ContentBlock::Text {
                                                text: String::new(),
                                            },
                                        });
                                    }
                                    if let Some(delta) = &event.delta {
                                        emitted_text.push_str(delta);
                                        let _ = tx.send(StreamEvent::TextDelta {
                                            index: 0,
                                            text: delta.clone(),
                                        });
                                    }
                                }
                                "response.output_text.done" => {
                                    // Text content finished - but don't stop yet, more might come
                                }
                                "response.completed" => {
                                    if let Some(output) = event
                                        .response
                                        .as_ref()
                                        .and_then(|response| response.get("output"))
                                        .and_then(serde_json::Value::as_array)
                                    {
                                        for (output_index, item) in output.iter().enumerate() {
                                            if let Some((call_id, name, arguments)) =
                                                extract_function_call(item)
                                            {
                                                if emitted_tool_call_ids.insert(call_id.clone()) {
                                                    let output_index = output_index as i64;
                                                    let tool_index = *tool_indices_by_output
                                                        .entry(output_index)
                                                        .or_insert_with(|| {
                                                            let index = tool_call_index;
                                                            tool_call_index += 1;
                                                            index
                                                        });
                                                    let partial_json = arguments.to_string();
                                                    let _ =
                                                        tx.send(StreamEvent::ContentBlockStart {
                                                            index: tool_index,
                                                            block: ContentBlock::ToolUse {
                                                                id: call_id,
                                                                name,
                                                                input: arguments,
                                                            },
                                                        });
                                                    if !streamed_tool_argument_indices
                                                        .contains(&output_index)
                                                    {
                                                        let _ =
                                                            tx.send(StreamEvent::InputJsonDelta {
                                                                index: tool_index,
                                                                partial_json,
                                                            });
                                                    }
                                                    let _ =
                                                        tx.send(StreamEvent::ContentBlockStop {
                                                            index: tool_index,
                                                            thinking_signature: None,
                                                        });
                                                }
                                            } else if let Some(text) = extract_text_from_item(item)
                                                .and_then(|text| {
                                                    missing_text_suffix(&emitted_text, &text)
                                                })
                                            {
                                                if !content_started {
                                                    content_started = true;
                                                    let _ =
                                                        tx.send(StreamEvent::ContentBlockStart {
                                                            index: 0,
                                                            block: ContentBlock::Text {
                                                                text: String::new(),
                                                            },
                                                        });
                                                }
                                                emitted_text.push_str(&text);
                                                let _ = tx.send(StreamEvent::TextDelta {
                                                    index: 0,
                                                    text,
                                                });
                                            }
                                        }
                                    }
                                    // Now close the content block
                                    if content_started {
                                        let _ = tx.send(StreamEvent::ContentBlockStop {
                                            index: 0,
                                            thinking_signature: None,
                                        });
                                    }
                                    // Extract usage from response if present
                                    if let Some(resp) = &event.response {
                                        if let Some(usage) = resp.get("usage") {
                                            let input = usage
                                                .get("input_tokens")
                                                .and_then(serde_json::Value::as_u64)
                                                .unwrap_or(0);
                                            let output = usage
                                                .get("output_tokens")
                                                .and_then(serde_json::Value::as_u64)
                                                .unwrap_or(0);
                                            // Extract cached tokens from input_tokens_details
                                            let cache_read = usage
                                                .get("input_tokens_details")
                                                .and_then(|d| d.get("cached_tokens"))
                                                .and_then(serde_json::Value::as_u64);
                                            // Extract reasoning tokens from output_tokens_details
                                            let _reasoning_tokens = usage
                                                .get("output_tokens_details")
                                                .and_then(|d| d.get("reasoning_tokens"))
                                                .and_then(serde_json::Value::as_u64);
                                            let _ = tx.send(StreamEvent::Usage {
                                                input_tokens: input,
                                                output_tokens: output,
                                                cache_read_tokens: cache_read,
                                                cache_creation_tokens: None,
                                            });
                                        }
                                    }
                                    let _ = tx.send(StreamEvent::MessageStop { stop_reason: None });
                                    return;
                                }
                                "response.incomplete" => {
                                    let error = incomplete_response_error(event.response.as_ref());
                                    let _ = tx.send(StreamEvent::ProviderError {
                                        kind: error.kind,
                                        message: error.to_string(),
                                    });
                                    return;
                                }
                                "response.failed" => {
                                    // Classify the error for proper handling
                                    let (error_msg, _api_error) = if let Some(resp) =
                                        &event.response
                                    {
                                        if let Some(error) = resp.get("error") {
                                            let classified = classify_error(error);
                                            let msg = match &classified {
                                                ApiError::ContextWindowExceeded => {
                                                    "Context window exceeded - message too long"
                                                        .to_string()
                                                }
                                                ApiError::QuotaExceeded => {
                                                    "API quota exceeded - check your billing"
                                                        .to_string()
                                                }
                                                ApiError::RateLimited { retry_after } => {
                                                    if let Some(delay) = retry_after {
                                                        format!(
                                                            "Rate limited - retry after {delay:?}"
                                                        )
                                                    } else {
                                                        "Rate limited - please try again"
                                                            .to_string()
                                                    }
                                                }
                                                ApiError::Retryable { message } => message.clone(),
                                                ApiError::Fatal { message } => message.clone(),
                                            };
                                            (msg, Some(classified))
                                        } else {
                                            ("Unknown error".to_string(), None)
                                        }
                                    } else {
                                        ("Unknown error".to_string(), None)
                                    };

                                    let _ = tx.send(StreamEvent::ProviderError {
                                        kind: ProviderStreamErrorKind::ProviderDeclaredFailure,
                                        message: format!("openai_response_failed: {error_msg}"),
                                    });
                                    return;
                                }
                                _ => {
                                    // Unknown event type, ignore
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(StreamEvent::ProviderError {
                                kind: ProviderStreamErrorKind::TransientProtocol,
                                message: format!("SSE stream error: {e}"),
                            });
                            return;
                        }
                    }
                }

                let _ = tx.send(StreamEvent::ProviderError {
                    kind: ProviderStreamErrorKind::TransientProtocol,
                    message: RESPONSES_MISSING_TERMINAL_EVENT_ERROR.to_string(),
                });
            });
        } else {
            // Chat Completions API - uses simpler line-based SSE
            let mut stream = response.bytes_stream();
            tokio::spawn(async move {
                let mut buffer = String::new();
                let mut message_id = String::new();
                let mut current_tool_calls: Vec<ToolCallAccumulator> = Vec::new();
                let mut content_started = false;

                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            // Process complete SSE lines
                            while let Some(pos) = buffer.find('\n') {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 1..].to_string();

                                if line.is_empty() {
                                    continue;
                                }

                                if line == "data: [DONE]" {
                                    // Flush any completed tool calls
                                    for (idx, call) in current_tool_calls.iter().enumerate() {
                                        if !call.name.is_empty()
                                            && !call.arguments.trim().is_empty()
                                        {
                                            let block_idx = idx + 1; // reserve 0 for text
                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: block_idx,
                                                block: ContentBlock::ToolUse {
                                                    id: call.id.clone(),
                                                    name: call.name.clone(),
                                                    input: serde_json::from_str(&call.arguments)
                                                        .unwrap_or(serde_json::json!({})),
                                                },
                                            });
                                            let _ = tx.send(StreamEvent::InputJsonDelta {
                                                index: block_idx,
                                                partial_json: call.arguments.clone(),
                                            });
                                            let _ = tx.send(StreamEvent::ContentBlockStop {
                                                index: block_idx,
                                                thinking_signature: None,
                                            });
                                        }
                                    }
                                    let _ = tx.send(StreamEvent::MessageStop { stop_reason: None });
                                    return;
                                }

                                if let Some(data) = line.strip_prefix("data: ") {
                                    if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                                        if message_id.is_empty() {
                                            message_id = chunk.id.clone();
                                            let _ = tx.send(StreamEvent::MessageStart {
                                                id: chunk.id.clone(),
                                                model: model.clone(),
                                            });
                                        }

                                        for choice in &chunk.choices {
                                            if let Some(content) = &choice.delta.content {
                                                if !content_started {
                                                    content_started = true;
                                                    let _ =
                                                        tx.send(StreamEvent::ContentBlockStart {
                                                            index: 0,
                                                            block: ContentBlock::Text {
                                                                text: String::new(),
                                                            },
                                                        });
                                                }
                                                let _ = tx.send(StreamEvent::TextDelta {
                                                    index: 0,
                                                    text: content.clone(),
                                                });
                                            }

                                            if let Some(tool_calls) = &choice.delta.tool_calls {
                                                for tc in tool_calls {
                                                    let idx = tc.index.unwrap_or(0);

                                                    while current_tool_calls.len() <= idx {
                                                        current_tool_calls.push(
                                                            ToolCallAccumulator {
                                                                id: String::new(),
                                                                name: String::new(),
                                                                arguments: String::new(),
                                                            },
                                                        );
                                                    }

                                                    if let Some(id) = &tc.id {
                                                        current_tool_calls[idx].id = id.clone();
                                                    }
                                                    if let Some(func) = &tc.function {
                                                        if let Some(name) = &func.name {
                                                            current_tool_calls[idx].name =
                                                                name.clone();
                                                        }
                                                        if let Some(args) = &func.arguments {
                                                            current_tool_calls[idx]
                                                                .arguments
                                                                .push_str(args);
                                                        }
                                                    }
                                                }
                                            }

                                            if choice.finish_reason.is_some() {
                                                if content_started && current_tool_calls.is_empty()
                                                {
                                                    let _ =
                                                        tx.send(StreamEvent::ContentBlockStop {
                                                            index: 0,
                                                            thinking_signature: None,
                                                        });
                                                }
                                                // On tool_calls finish, flush completed tool calls
                                                if choice.finish_reason.as_deref()
                                                    == Some("tool_calls")
                                                {
                                                    for (idx, call) in
                                                        current_tool_calls.iter().enumerate()
                                                    {
                                                        if call.name.is_empty()
                                                            || call.arguments.trim().is_empty()
                                                        {
                                                            continue;
                                                        }
                                                        let block_idx = idx + 1; // reserve 0 for text
                                                        let _ = tx.send(
                                                            StreamEvent::ContentBlockStart {
                                                                index: block_idx,
                                                                block: ContentBlock::ToolUse {
                                                                    id: call.id.clone(),
                                                                    name: call.name.clone(),
                                                                    input: serde_json::from_str(
                                                                        &call.arguments,
                                                                    )
                                                                    .unwrap_or(
                                                                        serde_json::json!({}),
                                                                    ),
                                                                },
                                                            },
                                                        );
                                                        let _ =
                                                            tx.send(StreamEvent::InputJsonDelta {
                                                                index: block_idx,
                                                                partial_json: call
                                                                    .arguments
                                                                    .clone(),
                                                            });
                                                        let _ = tx.send(
                                                            StreamEvent::ContentBlockStop {
                                                                index: block_idx,
                                                                thinking_signature: None,
                                                            },
                                                        );
                                                    }
                                                }
                                            }
                                        }

                                        if let Some(usage) = &chunk.usage {
                                            let _ = tx.send(StreamEvent::Usage {
                                                input_tokens: usage.prompt_tokens.unwrap_or(0),
                                                output_tokens: usage.completion_tokens.unwrap_or(0),
                                                cache_read_tokens: usage
                                                    .prompt_tokens_details
                                                    .as_ref()
                                                    .and_then(|d| d.cached_tokens),
                                                cache_creation_tokens: None,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(StreamEvent::ProviderError {
                                kind: ProviderStreamErrorKind::TransientProtocol,
                                message: format!("Stream error: {e}"),
                            });
                            break;
                        }
                    }
                }
            });
        }

        Ok(rx)
    }
}

// ============================================================================
// OpenAI API Types
// ============================================================================
//
// These types represent the OpenAI Chat Completions API request/response format.
// They use serde for serialization (requests) and deserialization (responses).
//
// # Serde Serialization Attributes
//
// - `#[serde(skip_serializing_if = "Option::is_none")]`: Omit null fields from JSON
// - `#[serde(untagged)]`: Serialize enum as the inner type (no type field)
// - `#[serde(tag = "type")]`: Add a type discriminator field for enums

/// Message in `OpenAI` format (role + content)
///
/// # Serde Conditional Serialization
///
/// Fields marked with `skip_serializing_if` are omitted from JSON if None:
///
/// ```rust,ignore
/// #[serde(skip_serializing_if = "Option::is_none")]
/// tool_calls: Option<Vec<OpenAiToolCall>>,
/// ```
///
/// This generates cleaner JSON - `{"role": "user", "content": "Hi"}` instead
/// of `{"role": "user", "content": "Hi", "tool_calls": null}`.
#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<OpenAiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    /// Tool name - required by Mistral for tool results
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// Content can be either simple text or structured parts
///
/// # Serde Untagged Enum
///
/// The `#[serde(untagged)]` attribute means this enum serializes without
/// a type discriminator. Instead, serde tries each variant in order:
///
/// ```json
/// "Hello"                              -> Text("Hello")
/// [{"type": "text", "text": "Hi"}]     -> Parts([...])
/// ```
///
/// This matches `OpenAI`'s API which accepts both formats.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum OpenAiContent {
    Text(String),
    Parts(Vec<OpenAiContentPart>),
}

/// Content part (text or image) in a multi-part message
///
/// # Serde Tagged Enum
///
/// Unlike `OpenAiContent` (untagged), this uses `tag = "type"` to add
/// a discriminator field:
///
/// ```json
/// {"type": "text", "text": "Hello"}
/// {"type": "image_url", "image_url": {"url": "..."}}
/// ```
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OpenAiContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlData },
}

#[derive(Debug, Serialize)]
struct ImageUrlData {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAiTool {
    #[serde(rename = "type")]
    tool_type: String,
    function: OpenAiFunction,
}

#[derive(Debug, Serialize)]
struct OpenAiFunction {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAiToolCall {
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    tool_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function: Option<OpenAiFunctionCall>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAiFunctionCall {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<String>,
}

// Streaming response types
#[derive(Debug, Deserialize)]
struct OpenAiChunk {
    id: String,
    #[allow(dead_code)]
    object: String,
    #[allow(dead_code)]
    created: u64,
    #[allow(dead_code)]
    model: String,
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    #[allow(dead_code)]
    index: usize,
    delta: OpenAiDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiDelta {
    /// Role of the message (typically "assistant" for streaming responses)
    #[serde(default)]
    #[allow(dead_code)] // Part of API structure, role is implicit in streaming context
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    cached_tokens: Option<u64>,
}

/// Accumulator for building tool calls from streaming deltas
///
/// # Problem
///
/// In Chat Completions API, tool calls arrive as incremental deltas:
///
/// ```json
/// {"index": 0, "id": "call_123"}
/// {"index": 0, "function": {"name": "read"}}
/// {"index": 0, "function": {"arguments": "{\"pa"}}
/// {"index": 0, "function": {"arguments": "th\":"}}
/// {"index": 0, "function": {"arguments": "\"/tmp\""}}
/// {"index": 0, "function": {"arguments": "}"}}
/// ```
///
/// # Solution
///
/// This struct accumulates the fragments into complete tool calls.
/// We maintain a `Vec<ToolCallAccumulator>` indexed by the `index` field,
/// appending to the appropriate accumulator as deltas arrive.
///
/// Once the stream completes, we serialize the complete tool calls.
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_with_responses_sse(sse_body: &str) -> OpenAiClient {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock Responses server");
        let address = listener.local_addr().expect("mock server address");
        let sse_body = sse_body.to_owned();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept Responses request");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .expect("set request timeout");
            let mut request = [0_u8; 16 * 1024];
            let _ = stream.read(&mut request).expect("read Responses request");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse_body.len(),
                sse_body
            )
            .expect("write Responses SSE");
        });

        OpenAiClient::with_base_url("test-key", format!("http://{address}/v1"))
            .expect("construct mock Responses client")
    }

    async fn collect_responses_sse(sse_body: &str) -> Vec<StreamEvent> {
        let client = client_with_responses_sse(sse_body);
        let config = RequestConfig {
            model: "gpt-5.1-codex-max".to_string(),
            ..Default::default()
        };
        let mut receiver = client
            .stream(&[], &config)
            .await
            .expect("start Responses stream");

        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            let mut events = Vec::new();
            while let Some(event) = receiver.recv().await {
                events.push(event);
            }
            events
        })
        .await
        .expect("Responses stream should terminate")
    }

    #[test]
    fn test_provider_detection() {
        assert_eq!(
            AiProvider::from_model("gpt-5.1-codex-max"),
            AiProvider::OpenAI
        );
        assert_eq!(AiProvider::from_model("gpt-4o"), AiProvider::OpenAI);
        assert_eq!(
            AiProvider::from_model("claude-opus-4-5-20251101"),
            AiProvider::Anthropic
        );
        assert_eq!(
            AiProvider::from_model("claude-sonnet-4-5"),
            AiProvider::Anthropic
        );
    }

    #[test]
    fn test_uses_responses_api() {
        // gpt-5.1-codex-* should use Responses API
        assert!(uses_responses_api(None, "gpt-5.1-codex-max"));
        assert!(uses_responses_api(None, "openai/gpt-5.1-codex-max"));
        assert!(uses_responses_api(None, "gpt-5.1-codex-lite"));
        // o3 models use Responses API
        assert!(uses_responses_api(None, "o3"));
        assert!(uses_responses_api(None, "o3-mini"));
        // Other models should not
        assert!(!uses_responses_api(None, "gpt-4o"));
        assert!(!uses_responses_api(None, "gpt-4-turbo"));
        assert!(!uses_responses_api(None, "o1"));
    }

    #[test]
    fn openrouter_models_use_stable_chat_completions_except_plain_gpt_5_6() {
        for model in [
            "openrouter/anthropic/claude-sonnet-4.5",
            "openrouter/google/gemini-2.5-pro",
            "openrouter/meta-llama/llama-4-maverick",
            "openrouter/openai/gpt-5.4",
            "openrouter/openai/o3-mini",
            "openrouter/openrouter/auto",
            "evalops/openrouter/gpt-5.6",
            "openrouter/gpt-5.6-terra",
            "openrouter/openai/gpt-5.6-terra",
        ] {
            assert!(
                !uses_responses_api(None, model),
                "OpenRouter model must use Chat Completions: {model}"
            );
        }
        assert!(uses_responses_api(None, "openrouter/gpt-5.6"));
        assert!(uses_responses_api(
            Some("openrouter"),
            "evalops/openai/gpt-5.6"
        ));
        assert!(!uses_responses_api(
            Some("openrouter"),
            "evalops/openai/gpt-5.6-terra"
        ));
        assert!(!uses_responses_api(
            Some("openrouter"),
            "evalops/anthropic/claude-sonnet-4.5"
        ));
        assert!(!uses_responses_api(
            Some("openrouter"),
            "evalops/openrouter/gpt-5.6"
        ));
    }

    #[test]
    fn test_api_url_selection() {
        // Responses API models go to /v1/responses
        assert_eq!(
            api_url_for_model("gpt-5.1-codex-max"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            api_url_for_model("openai/gpt-5.1-codex-max"),
            "https://api.openai.com/v1/responses"
        );
        // Chat Completions models go to /v1/chat/completions
        assert_eq!(
            api_url_for_model("gpt-4o"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_request_url_honors_custom_base_url() {
        // Default client (no base URL) targets OpenAI.
        let openai = OpenAiClient::new("k").unwrap();
        assert_eq!(
            openai.request_url("gpt-4o"),
            "https://api.openai.com/v1/chat/completions"
        );

        // Custom OpenAI-compatible providers must hit their own endpoint, not
        // OpenAI. A trailing slash on the base URL is tolerated.
        let deepseek = OpenAiClient::with_base_url("k", "https://api.deepseek.com/v1").unwrap();
        assert_eq!(
            deepseek.request_url("deepseek-chat"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        let zai = OpenAiClient::with_base_url("k", "https://api.z.ai/api/coding/paas/v4/").unwrap();
        assert_eq!(
            zai.request_url("glm-4.6"),
            "https://api.z.ai/api/coding/paas/v4/chat/completions"
        );
        let groq = OpenAiClient::with_base_url("k", "https://api.groq.com/openai/v1").unwrap();
        assert_eq!(
            groq.request_url("llama-3.3-70b-versatile"),
            "https://api.groq.com/openai/v1/chat/completions"
        );
    }

    #[test]
    fn test_has_incompatible_schema() {
        // Simple schema is compatible
        let simple = serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        });
        assert!(!has_incompatible_schema(&simple));

        // oneOf is incompatible
        let one_of = serde_json::json!({
            "oneOf": [
                {"type": "string"},
                {"type": "number"}
            ]
        });
        assert!(has_incompatible_schema(&one_of));

        // anyOf is incompatible
        let any_of = serde_json::json!({
            "anyOf": [
                {"type": "string"},
                {"type": "number"}
            ]
        });
        assert!(has_incompatible_schema(&any_of));

        // allOf is incompatible
        let all_of = serde_json::json!({
            "allOf": [
                {"type": "object"},
                {"properties": {"x": {"type": "number"}}}
            ]
        });
        assert!(has_incompatible_schema(&all_of));

        // Top-level enum is incompatible
        let top_enum = serde_json::json!({
            "enum": ["a", "b", "c"]
        });
        assert!(has_incompatible_schema(&top_enum));
    }

    #[test]
    fn test_filter_responses_api_tools() {
        let tools = vec![
            Tool::new("read", "Read a file").with_schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"}
                }
            })),
            Tool::new("", "Empty name tool") // Should be filtered out
                .with_schema(serde_json::json!({})),
            Tool::new("bad", "Has oneOf").with_schema(serde_json::json!({
                "oneOf": [{"type": "string"}, {"type": "number"}]
            })),
        ];

        let filtered = filter_responses_api_tools(&tools);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "read");
    }

    #[test]
    fn trims_api_key_before_building_headers() {
        let client = OpenAiClient::new("  test-key\n").unwrap();
        let headers = client.headers();

        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer test-key");
    }

    #[test]
    fn strips_provider_prefix_from_request_body_model() {
        let client = OpenAiClient::new("test-key").unwrap();
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let responses_body = client.build_request_body(
            &messages,
            &RequestConfig {
                model: "openai/gpt-5.1-codex-max".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(responses_body["model"], "gpt-5.1-codex-max");

        let chat_body = client.build_request_body(
            &messages,
            &RequestConfig {
                model: "openai/gpt-4o".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(chat_body["model"], "gpt-4o");
    }

    #[test]
    fn openrouter_nested_model_ids_remain_opaque_on_chat_completions() {
        let client = OpenAiClient::with_base_url("test-key", "https://openrouter.example/v1")
            .unwrap()
            .with_route_provider("openrouter");
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];
        let config = RequestConfig {
            model: "openrouter/anthropic/claude-sonnet-4.5".to_string(),
            ..Default::default()
        };

        let body = client.build_request_body(&messages, &config);

        assert_eq!(body["model"], "anthropic/claude-sonnet-4.5");
        assert!(body["messages"].is_array());
        assert!(body.get("input").is_none());
        assert_eq!(
            client.request_url(&config.model),
            "https://openrouter.example/v1/chat/completions"
        );
    }

    #[test]
    fn openrouter_normalized_model_ids_keep_the_vendor_namespace() {
        let client = OpenAiClient::with_base_url("test-key", "https://openrouter.example/v1")
            .unwrap()
            .with_route_provider("openrouter");
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let chat_body = client.build_request_body(
            &messages,
            &RequestConfig {
                model: "anthropic/claude-sonnet-4.5".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(chat_body["model"], "anthropic/claude-sonnet-4.5");

        let terra_body = client.build_request_body(
            &messages,
            &RequestConfig {
                model: "openai/gpt-5.6-terra".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(terra_body["model"], "openai/gpt-5.6-terra");
        assert!(terra_body.get("messages").is_some());
        assert!(terra_body.get("input").is_none());
        assert_eq!(
            client.request_url("openai/gpt-5.6-terra"),
            "https://openrouter.example/v1/chat/completions"
        );
    }

    #[test]
    fn openrouter_owned_model_namespace_is_not_stripped_twice() {
        let client = OpenAiClient::with_base_url("test-key", "https://openrouter.example/v1")
            .unwrap()
            .with_route_provider("openrouter");
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];
        let config = RequestConfig {
            model: provider_model_name("openrouter/openrouter/auto"),
            ..Default::default()
        };

        assert_eq!(config.model, "openrouter/openrouter/auto");
        let body = client.build_request_body(&messages, &config);

        assert_eq!(body["model"], "openrouter/auto");
    }

    fn tool_call_history(calls: &[(&str, &str, serde_json::Value, &str)]) -> Vec<Message> {
        vec![
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(
                    calls
                        .iter()
                        .map(|(id, name, input, _)| ContentBlock::ToolUse {
                            id: (*id).to_string(),
                            name: (*name).to_string(),
                            input: input.clone(),
                        })
                        .collect(),
                ),
            },
            Message {
                role: Role::User,
                content: MessageContent::Blocks(
                    calls
                        .iter()
                        .map(|(id, _, _, output)| ContentBlock::ToolResult {
                            tool_use_id: (*id).to_string(),
                            content: (*output).to_string(),
                            is_error: Some(false),
                        })
                        .collect(),
                ),
            },
        ]
    }

    #[test]
    fn chat_history_keeps_single_and_parallel_tool_calls_with_their_results() {
        let client = OpenAiClient::new("test-key").unwrap();
        for calls in [
            vec![(
                "call_read",
                "read",
                serde_json::json!({"path": "Cargo.toml"}),
                "contents",
            )],
            vec![
                (
                    "call_read",
                    "read",
                    serde_json::json!({"path": "Cargo.toml"}),
                    "contents",
                ),
                (
                    "call_glob",
                    "glob",
                    serde_json::json!({"pattern": "*.rs"}),
                    "src/main.rs",
                ),
            ],
        ] {
            let body = client.build_chat_request_body(
                &tool_call_history(&calls),
                &RequestConfig {
                    model: "openai/gpt-4.1-mini".to_string(),
                    ..Default::default()
                },
            );
            let messages = body["messages"].as_array().expect("chat messages");
            assert_eq!(messages.len(), calls.len() + 1);

            let tool_calls = messages[0]["tool_calls"].as_array().expect("tool calls");
            assert_eq!(tool_calls.len(), calls.len());
            for (tool_call, (id, name, input, _)) in tool_calls.iter().zip(&calls) {
                assert_eq!(tool_call["id"], *id);
                assert_eq!(tool_call["type"], "function");
                assert_eq!(tool_call["function"]["name"], *name);
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        tool_call["function"]["arguments"]
                            .as_str()
                            .expect("function arguments"),
                    )
                    .expect("valid function arguments"),
                    *input
                );
            }
            for (result, (id, _, _, output)) in messages[1..].iter().zip(&calls) {
                assert_eq!(result["role"], "tool");
                assert_eq!(result["tool_call_id"], *id);
                assert_eq!(result["content"], *output);
            }
        }
    }

    #[test]
    fn responses_history_keeps_single_and_parallel_tool_calls_with_their_results() {
        let client = OpenAiClient::new("test-key").unwrap();
        for calls in [
            vec![(
                "call_read",
                "read",
                serde_json::json!({"path": "Cargo.toml"}),
                "contents",
            )],
            vec![
                (
                    "call_read",
                    "read",
                    serde_json::json!({"path": "Cargo.toml"}),
                    "contents",
                ),
                (
                    "call_glob",
                    "glob",
                    serde_json::json!({"pattern": "*.rs"}),
                    "src/main.rs",
                ),
            ],
        ] {
            let body = client.build_responses_request_body(
                &tool_call_history(&calls),
                &RequestConfig {
                    model: "openai/gpt-5.1-codex-max".to_string(),
                    ..Default::default()
                },
            );
            let input = body["input"].as_array().expect("Responses input");
            assert_eq!(input.len(), calls.len() * 2);

            for (function_call, (id, name, args, _)) in input[..calls.len()].iter().zip(&calls) {
                assert_eq!(function_call["type"], "function_call");
                assert_eq!(function_call["call_id"], *id);
                assert_eq!(function_call["name"], *name);
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        function_call["arguments"]
                            .as_str()
                            .expect("function arguments"),
                    )
                    .expect("valid function arguments"),
                    *args
                );
            }
            for (result, (id, _, _, output)) in input[calls.len()..].iter().zip(&calls) {
                assert_eq!(result["type"], "function_call_output");
                assert_eq!(result["call_id"], *id);
                assert_eq!(result["output"], *output);
            }
        }
    }

    #[test]
    fn responses_requests_use_max_output_tokens() {
        let client = OpenAiClient::new("test-key").unwrap();
        let body = client.build_responses_request_body(
            &[],
            &RequestConfig {
                model: "gpt-5.1-codex-max".to_string(),
                max_tokens: 1234,
                ..Default::default()
            },
        );

        assert_eq!(body["max_output_tokens"], 1234);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn responses_history_pairs_synthesized_cancel_result_with_its_call() {
        // History shape left by `repair_orphaned_tool_calls` after a turn is
        // cancelled mid-tool-execution: the assistant tool call is immediately
        // followed by a user message carrying only the synthesized failure
        // result, then the next prompt. The Responses payload must pair every
        // function_call with a function_call_output or OpenAI answers 400.
        let client = OpenAiClient::new("test-key").unwrap();
        let messages = vec![
            Message {
                role: Role::User,
                content: MessageContent::Text("run sleep 120 via bash".to_string()),
            },
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                    id: "call_1".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command": "sleep 120"}),
                }]),
            },
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: "Tool execution cancelled by user.".to_string(),
                    is_error: Some(true),
                }]),
            },
            Message {
                role: Role::User,
                content: MessageContent::Text("next prompt".to_string()),
            },
        ];

        let body = client.build_responses_request_body(
            &messages,
            &RequestConfig {
                model: "gpt-5.1-codex-max".to_string(),
                ..Default::default()
            },
        );
        let input = body["input"].as_array().expect("Responses input");
        let call_ids: Vec<&str> = input
            .iter()
            .filter(|item| item["type"] == "function_call")
            .map(|item| item["call_id"].as_str().expect("function call id"))
            .collect();
        let output_ids: Vec<&str> = input
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .map(|item| item["call_id"].as_str().expect("function output id"))
            .collect();
        assert_eq!(call_ids, vec!["call_1"]);
        assert_eq!(call_ids, output_ids);

        // The Chat Completions serializer must pair them too: an assistant
        // tool_calls message immediately followed by a matching tool message.
        let chat_body = client.build_request_body(
            &messages,
            &RequestConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
        );
        let chat_messages = chat_body["messages"].as_array().expect("chat messages");
        let assistant_index = chat_messages
            .iter()
            .position(|msg| msg["tool_calls"].is_array())
            .expect("assistant tool_calls message");
        let tool_msg = &chat_messages[assistant_index + 1];
        assert_eq!(tool_msg["role"], "tool");
        assert_eq!(
            tool_msg["tool_call_id"],
            chat_messages[assistant_index]["tool_calls"][0]["id"]
        );
    }

    #[test]
    fn managed_gateway_adds_org_header_and_provider_reference() {
        let client =
            OpenAiClient::with_base_url("delegated-token", "https://llm-gateway.evalops.dev/v1")
                .unwrap()
                .with_managed_gateway_context(
                    "org_123",
                    serde_json::json!({
                        "provider": "anthropic",
                        "environment": "prod",
                        "credential_name": "team-shared"
                    }),
                )
                .unwrap();
        assert_eq!(
            client.headers().get("x-organization-id").unwrap(),
            "org_123"
        );
        assert_eq!(
            client.response_open_timeout(),
            Some(MANAGED_GATEWAY_RESPONSE_OPEN_TIMEOUT)
        );

        let body = client.build_request_body(
            &[Message {
                role: Role::User,
                content: MessageContent::Text("Hello".to_string()),
            }],
            &RequestConfig {
                model: "evalops/gpt-4o-mini".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(body["provider_ref"]["provider"], "anthropic");
        assert_eq!(body["provider_ref"]["credential_name"], "team-shared");
    }

    #[test]
    fn managed_gateway_turn_lineage_is_stable_and_body_scoped() {
        let mut client =
            OpenAiClient::with_base_url("delegated-token", "https://llm-gateway.evalops.dev/v1")
                .unwrap()
                .with_managed_gateway_scope(
                    "org_123",
                    "workspace_456",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "production",
                        "credential_name": "default"
                    }),
                )
                .unwrap();
        client.set_managed_request_lineage(Some("maestro-turn-v2:digest".to_string()));

        let request = |content: &str| {
            client
                .managed_request(client.build_request_body(
                    &[Message {
                        role: Role::User,
                        content: MessageContent::Text(content.to_string()),
                    }],
                    &RequestConfig {
                        model: "evalops/openrouter/auto".to_string(),
                        ..Default::default()
                    },
                ))
                .expect("managed request")
        };
        let first_body = request("first");
        let replay_body = request("first");
        let next_body = request("second");

        assert_eq!(first_body["lineage_id"], replay_body["lineage_id"]);
        assert_eq!(first_body["lineage_id"], next_body["lineage_id"]);
        assert!(first_body["lineage_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("maestro-turn-v2:")));
        assert_eq!(first_body, replay_body);
        assert_ne!(first_body, next_body);
    }

    #[tokio::test]
    async fn managed_gateway_timeout_response_is_a_typed_transient_stream_failure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock gateway");
        let address = listener.local_addr().expect("mock gateway address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept gateway request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("read gateway request");
            let body = r#"{"error":{"type":"server_error","message":"operation timeout"}}"#;
            write!(
                stream,
                "HTTP/1.1 504 Gateway Timeout\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            )
            .expect("write gateway timeout");
        });

        let client = OpenAiClient::with_base_url("delegated-token", format!("http://{address}/v1"))
            .unwrap()
            .with_managed_gateway_context(
                "org_123",
                serde_json::json!({
                    "provider": "openrouter",
                    "environment": "prod",
                    "credential_name": "default"
                }),
            )
            .unwrap();
        let mut events = client
            .stream(
                &[],
                &RequestConfig {
                    model: "evalops/openai/gpt-5.6-terra".to_string(),
                    ..Default::default()
                },
            )
            .await
            .expect("gateway response opened");

        assert!(matches!(
            events.recv().await,
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            }) if message.contains("504 Gateway Timeout")
        ));
    }

    #[tokio::test]
    async fn managed_gateway_response_open_timeout_stops_stalled_headers() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock gateway");
        let address = listener.local_addr().expect("mock gateway address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept gateway request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("read gateway request");
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });

        let request = reqwest::Client::new().get(format!("http://{address}/responses"));
        let error =
            send_with_response_open_timeout(request, Some(std::time::Duration::from_millis(25)))
                .await
                .expect_err("stalled response opening must time out");

        assert!(
            error
                .to_string()
                .contains("managed gateway response headers timed out"),
            "unexpected error: {error:#}"
        );
    }

    #[tokio::test]
    async fn managed_gateway_response_open_timeout_does_not_cover_stream_body() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock gateway");
        let address = listener.local_addr().expect("mock gateway address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept gateway request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("read gateway request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n")
                .expect("write response headers");
            stream.flush().expect("flush response headers");
            std::thread::sleep(std::time::Duration::from_millis(150));
            stream.write_all(b"hello").expect("write delayed body");
        });

        let request = reqwest::Client::new().get(format!("http://{address}/responses"));
        let response =
            send_with_response_open_timeout(request, Some(std::time::Duration::from_millis(50)))
                .await
                .expect("response headers should arrive within the open timeout");
        let body = response
            .text()
            .await
            .expect("body may continue past the response-open timeout");

        assert_eq!(body, "hello");
    }

    #[test]
    fn managed_gateway_scope_adds_workspace_header_without_changing_provider_reference() {
        let client =
            OpenAiClient::with_base_url("delegated-token", "https://llm-gateway.evalops.dev/v1")
                .unwrap()
                .with_managed_gateway_scope(
                    "org_123",
                    "workspace_456",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "prod",
                    }),
                )
                .unwrap();
        assert_eq!(
            client.headers().get("x-organization-id").unwrap(),
            "org_123"
        );
        assert_eq!(
            client.headers().get("x-workspace-id").unwrap(),
            "workspace_456"
        );
        assert_eq!(
            client.request_extensions["provider_ref"]["provider"],
            "openrouter"
        );
        assert_eq!(
            client.request_extensions["provider_ref"]["environment"],
            "prod"
        );
        let body = client.build_request_body(
            &[Message {
                role: Role::User,
                content: MessageContent::Text("Hello".to_string()),
            }],
            &RequestConfig {
                model: "openai/gpt-5.6".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(body["model"], "openai/gpt-5.6");
    }

    #[test]
    fn managed_openrouter_gateway_preserves_opaque_model_namespace() {
        let client =
            OpenAiClient::with_base_url("delegated-token", "https://llm-gateway.evalops.dev/v1")
                .unwrap()
                .with_route_provider("openrouter")
                .with_managed_gateway_scope(
                    "org_123",
                    "workspace_456",
                    serde_json::json!({
                        "provider": "openrouter",
                        "environment": "prod",
                    }),
                )
                .unwrap();

        for model in ["openrouter/auto", "evalops/openrouter/auto"] {
            let body = client.build_request_body(
                &[Message {
                    role: Role::User,
                    content: MessageContent::Text("Hello".to_string()),
                }],
                &RequestConfig {
                    model: model.to_string(),
                    ..Default::default()
                },
            );

            assert_eq!(body["model"], "openrouter/auto");
        }
    }

    #[test]
    fn managed_gateway_classifies_namespaced_responses_models_before_protocol_selection() {
        let client =
            OpenAiClient::with_base_url("delegated-token", "https://llm-gateway.evalops.dev/v1")
                .unwrap()
                .with_managed_gateway_scope(
                    "org_123",
                    "workspace_456",
                    serde_json::json!({
                        "provider": "openai",
                        "environment": "prod",
                    }),
                )
                .unwrap();
        for model in [
            "evalops/openai/gpt-5.6",
            "EVALOPS/openai/gpt-5.6",
            "maestro-managed/openai/gpt-5.6",
            "MAESTRO-MANAGED/openai/gpt-5.6",
        ] {
            let body = client.build_request_body(
                &[Message {
                    role: Role::User,
                    content: MessageContent::Text("Hello".to_string()),
                }],
                &RequestConfig {
                    model: model.to_string(),
                    ..Default::default()
                },
            );

            assert!(client.uses_responses_api_for(model));
            assert!(body["input"].is_array());
            assert_eq!(
                client.request_url(model),
                "https://llm-gateway.evalops.dev/v1/responses"
            );
            assert_eq!(body["model"], "openai/gpt-5.6");
        }
    }

    #[test]
    fn test_extract_function_call() {
        // Valid function call
        let valid = serde_json::json!({
            "type": "function_call",
            "call_id": "call_123",
            "name": "read",
            "arguments": "{\"path\": \"/tmp/test.txt\"}"
        });
        let result = extract_function_call(&valid);
        assert!(result.is_some());
        let (call_id, name, args) = result.unwrap();
        assert_eq!(call_id, "call_123");
        assert_eq!(name, "read");
        assert_eq!(args, serde_json::json!({ "path": "/tmp/test.txt" }));

        // Arguments can arrive as an object
        let object_args = serde_json::json!({
            "type": "function_call",
            "call_id": "call_456",
            "name": "read",
            "arguments": { "path": "/tmp/other.txt" }
        });
        let result = extract_function_call(&object_args);
        assert!(result.is_some());
        let (_, _, args) = result.unwrap();
        assert_eq!(args, serde_json::json!({ "path": "/tmp/other.txt" }));

        // Invalid JSON strings fall back to empty object
        let invalid_args = serde_json::json!({
            "type": "function_call",
            "call_id": "call_789",
            "name": "read",
            "arguments": "{not-json}"
        });
        let result = extract_function_call(&invalid_args);
        assert!(result.is_some());
        let (_, _, args) = result.unwrap();
        assert_eq!(args, serde_json::json!({}));

        // Null arguments are treated as empty object
        let null_args = serde_json::json!({
            "type": "function_call",
            "call_id": "call_999",
            "name": "read",
            "arguments": null
        });
        let result = extract_function_call(&null_args);
        assert!(result.is_some());
        let (_, _, args) = result.unwrap();
        assert_eq!(args, serde_json::json!({}));

        // Not a function call
        let message = serde_json::json!({
            "type": "message",
            "content": "Hello"
        });
        assert!(extract_function_call(&message).is_none());

        // Missing fields
        let incomplete = serde_json::json!({
            "type": "function_call",
            "name": "read"
        });
        assert!(extract_function_call(&incomplete).is_none());
    }

    #[test]
    fn test_extract_text_from_item() {
        // Message with output_text content
        let msg = serde_json::json!({
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": "Hello, world!"
                }
            ]
        });
        let text = extract_text_from_item(&msg);
        assert_eq!(text, Some("Hello, world!".to_string()));

        // Message with no content
        let empty = serde_json::json!({
            "type": "message",
            "content": []
        });
        assert!(extract_text_from_item(&empty).is_none());

        // Not a message
        let other = serde_json::json!({
            "type": "function_call"
        });
        assert!(extract_text_from_item(&other).is_none());
    }

    #[test]
    fn test_classify_error() {
        // Context length exceeded
        let ctx_error = serde_json::json!({
            "code": "context_length_exceeded",
            "message": "Maximum context length exceeded"
        });
        match classify_error(&ctx_error) {
            ApiError::ContextWindowExceeded => {}
            _ => panic!("Expected ContextWindowExceeded"),
        }

        // Quota exceeded
        let quota_error = serde_json::json!({
            "code": "insufficient_quota",
            "message": "You exceeded your quota"
        });
        match classify_error(&quota_error) {
            ApiError::QuotaExceeded => {}
            _ => panic!("Expected QuotaExceeded"),
        }

        // Rate limited
        let rate_error = serde_json::json!({
            "code": "rate_limit_exceeded",
            "message": "Rate limit exceeded"
        });
        match classify_error(&rate_error) {
            ApiError::RateLimited { .. } => {}
            _ => panic!("Expected RateLimited"),
        }

        // Unknown error without retryable keywords is Fatal
        let generic = serde_json::json!({
            "code": "something_else",
            "message": "Something went wrong"
        });
        match classify_error(&generic) {
            ApiError::Fatal { message } => {
                assert_eq!(message, "Something went wrong");
            }
            _ => panic!("Expected Fatal for unknown errors"),
        }

        // Error with "temporarily" keyword is Retryable
        let temp_error = serde_json::json!({
            "code": "some_error",
            "message": "The service is temporarily unavailable"
        });
        match classify_error(&temp_error) {
            ApiError::Retryable { .. } => {}
            _ => panic!("Expected Retryable for temporary errors"),
        }

        // Error with "overloaded" keyword is Retryable
        let overload_error = serde_json::json!({
            "code": "some_error",
            "message": "Server is overloaded, please retry"
        });
        match classify_error(&overload_error) {
            ApiError::Retryable { .. } => {}
            _ => panic!("Expected Retryable for overload errors"),
        }

        // Server error type is Retryable
        let server_error = serde_json::json!({
            "type": "server_error",
            "message": "Internal server error"
        });
        match classify_error(&server_error) {
            ApiError::Retryable { .. } => {}
            _ => panic!("Expected Retryable for server errors"),
        }

        // Authentication error is Fatal
        let auth_error = serde_json::json!({
            "type": "authentication_error",
            "message": "Invalid API key"
        });
        match classify_error(&auth_error) {
            ApiError::Fatal { .. } => {}
            _ => panic!("Expected Fatal for auth errors"),
        }

        // Invalid API key is Fatal
        let invalid_key = serde_json::json!({
            "code": "invalid_api_key",
            "message": "Provided API key is invalid"
        });
        match classify_error(&invalid_key) {
            ApiError::Fatal { .. } => {}
            _ => panic!("Expected Fatal for invalid API key"),
        }
    }

    #[test]
    fn test_parse_retry_after() {
        // Seconds
        let secs = parse_retry_after("Please try again in 30s");
        assert!(secs.is_some());
        assert_eq!(secs.unwrap(), std::time::Duration::from_secs(30));

        // Milliseconds
        let ms = parse_retry_after("Try again in 500ms");
        assert!(ms.is_some());
        assert_eq!(ms.unwrap(), std::time::Duration::from_millis(500));

        // Float seconds
        let float = parse_retry_after("try again in 2.5s");
        assert!(float.is_some());
        assert_eq!(float.unwrap(), std::time::Duration::from_secs_f64(2.5));

        // No retry-after info
        let none = parse_retry_after("Rate limit exceeded");
        assert!(none.is_none());
    }

    #[test]
    fn test_responses_sse_event_parsing() {
        // Test parsing response.created event
        let created_data = r#"{"type":"response.created","response":{"id":"resp_123"}}"#;
        let event: ResponsesSseEvent = serde_json::from_str(created_data).unwrap();
        assert_eq!(event.kind, "response.created");
        assert!(event.response.is_some());
        let resp = event.response.unwrap();
        assert_eq!(resp.get("id").unwrap().as_str().unwrap(), "resp_123");

        // Test parsing output_text.delta event
        let delta_data = r#"{"type":"response.output_text.delta","delta":"Hello"}"#;
        let event: ResponsesSseEvent = serde_json::from_str(delta_data).unwrap();
        assert_eq!(event.kind, "response.output_text.delta");
        assert_eq!(event.delta, Some("Hello".to_string()));

        // Test parsing output_item.done event
        let done_data =
            r#"{"type":"response.output_item.done","item":{"type":"message","content":[]}}"#;
        let event: ResponsesSseEvent = serde_json::from_str(done_data).unwrap();
        assert_eq!(event.kind, "response.output_item.done");
        assert!(event.item.is_some());

        let part_data = r#"{"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}"#;
        let event: ResponsesSseEvent = serde_json::from_str(part_data).unwrap();
        assert_eq!(event.kind, "response.content_part.added");
        assert_eq!(event.part.unwrap()["type"], "output_text");
    }

    #[tokio::test]
    async fn responses_empty_current_shape_emits_clean_terminal_sequence() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_empty"}}

data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":17,"output_tokens":0}}}

"#,
        )
        .await;

        assert!(matches!(
            events.as_slice(),
            [
                StreamEvent::MessageStart { id, .. },
                StreamEvent::Usage {
                    input_tokens: 17,
                    output_tokens: 0,
                    ..
                },
                StreamEvent::MessageStop { .. }
            ] if id == "resp_empty"
        ));
    }

    #[tokio::test]
    async fn responses_current_content_part_shape_emits_text_once() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_text"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","content":[]}}

data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}

data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello, world!"}}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"Hello, world!"}]}}

data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hello, world!"}]}],"usage":{"input_tokens":3,"output_tokens":4}}}

"#,
        )
        .await;

        let text = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::TextDelta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(text, ["Hello", ", world!"]);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::ContentBlockStart { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::ContentBlockStop { .. }))
                .count(),
            1
        );
        assert!(matches!(
            events.last(),
            Some(StreamEvent::MessageStop { .. })
        ));
    }

    #[tokio::test]
    async fn responses_terminal_output_recovers_tool_only_with_arguments() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_tool"}}

data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"Cargo.toml\"}"}],"usage":{"input_tokens":5,"output_tokens":2}}}

"#,
        )
        .await;

        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::ContentBlockStart {
                index: 1,
                block: ContentBlock::ToolUse { id, name, input }
            } if id == "call_1" && name == "read" && input == &serde_json::json!({"path": "Cargo.toml"})
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::InputJsonDelta { index: 1, partial_json }
                if partial_json == "{\"path\":\"Cargo.toml\"}"
        )));
        assert!(matches!(
            events.last(),
            Some(StreamEvent::MessageStop { .. })
        ));
    }

    #[tokio::test]
    async fn responses_streamed_tool_arguments_keep_one_index_after_reasoning() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_tool_index"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read","arguments":""}}

data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"path\":\"Cargo.toml\"}"}

data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"Cargo.toml\"}"}}

data: {"type":"response.completed","response":{"output":[{"type":"reasoning"},{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"Cargo.toml\"}"}],"usage":{"input_tokens":5,"output_tokens":2}}}

"#,
        )
        .await;

        let start_index = events.iter().find_map(|event| match event {
            StreamEvent::ContentBlockStart {
                index,
                block: ContentBlock::ToolUse { id, .. },
            } if id == "call_1" => Some(*index),
            _ => None,
        });
        let delta_indices = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::InputJsonDelta {
                    index,
                    partial_json,
                } if partial_json == "{\"path\":\"Cargo.toml\"}" => Some(*index),
                _ => None,
            })
            .collect::<Vec<_>>();
        let stop_index = events.iter().find_map(|event| match event {
            StreamEvent::ContentBlockStop { index, .. } => Some(*index),
            _ => None,
        });

        assert_eq!(start_index, Some(1));
        assert_eq!(delta_indices, [1]);
        assert_eq!(stop_index, start_index);
    }

    #[tokio::test]
    async fn responses_terminal_tool_fallback_reuses_streamed_argument_index() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_tool_fallback_index"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read","arguments":""}}

data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"path\":\"Cargo.toml\"}"}

data: {"type":"response.completed","response":{"output":[{"type":"reasoning"},{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"Cargo.toml\"}"}],"usage":{"input_tokens":5,"output_tokens":2}}}

"#,
        )
        .await;

        let start_index = events.iter().find_map(|event| match event {
            StreamEvent::ContentBlockStart {
                index,
                block: ContentBlock::ToolUse { id, .. },
            } if id == "call_1" => Some(*index),
            _ => None,
        });
        let delta_indices = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::InputJsonDelta {
                    index,
                    partial_json,
                } if partial_json == "{\"path\":\"Cargo.toml\"}" => Some(*index),
                _ => None,
            })
            .collect::<Vec<_>>();
        let stop_index = events.iter().find_map(|event| match event {
            StreamEvent::ContentBlockStop { index, .. } => Some(*index),
            _ => None,
        });

        assert_eq!(start_index, Some(1));
        assert_eq!(delta_indices, [1]);
        assert_eq!(stop_index, start_index);
    }

    #[tokio::test]
    async fn responses_incomplete_is_terminal_error_without_message_stop() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_incomplete"}}

data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"do not expose"}]}]}}

"#,
        )
        .await;

        assert!(matches!(
            events.last(),
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::OutputTokenExhaustion,
                message,
            })
                if message == "openai_response_exhausted: reason=max_output_tokens"
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, StreamEvent::MessageStop { .. })));
    }

    #[tokio::test]
    async fn responses_failed_is_typed_provider_declared_failure() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.failed","response":{"id":"resp_failed","error":{"code":"provider_error","message":"provider rejected the response"}}}

"#,
        )
        .await;

        assert!(matches!(
            events.last(),
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::ProviderDeclaredFailure,
                message,
            }) if message.contains("provider rejected the response")
        ));
        assert!(!events.iter().any(|event| matches!(
            event,
            StreamEvent::Error { .. } | StreamEvent::MessageStop { .. }
        )));
    }

    #[tokio::test]
    async fn responses_eof_before_terminal_frame_is_transient_error() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.created","response":{"id":"resp_cut"}}

"#,
        )
        .await;

        assert!(matches!(
            events.last(),
            Some(StreamEvent::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message,
            })
                if message
                    == "openai_response_protocol_error: kind=transient reason=missing_terminal_event"
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, StreamEvent::MessageStop { .. })));
    }

    #[tokio::test]
    async fn responses_completed_with_assistant_text_is_success() {
        let events = collect_responses_sse(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}

"#,
        )
        .await;

        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::TextDelta { text, .. } if text == "hello"
        )));
        assert!(matches!(
            events.last(),
            Some(StreamEvent::MessageStop { .. })
        ));
        assert!(!events.iter().any(|event| matches!(
            event,
            StreamEvent::Error { .. } | StreamEvent::ProviderError { .. }
        )));
    }

    #[test]
    fn responses_terminal_output_fills_only_missing_text_and_tools() {
        assert_eq!(
            missing_text_suffix("Hello", "Hello, world!"),
            Some(", world!".to_string())
        );
        assert_eq!(missing_text_suffix("Hello, world!", "Hello, world!"), None);

        let completed_data = r#"{
            "type":"response.completed",
            "response":{"output":[
                {"type":"message","content":[{"type":"output_text","text":"fallback"}]},
                {"type":"function_call","call_id":"call_1","name":"read","arguments":"{}"}
            ]}
        }"#;
        let event: ResponsesSseEvent = serde_json::from_str(completed_data).unwrap();
        let response = event.response.unwrap();
        let output = response["output"].as_array().expect("terminal output");
        assert_eq!(
            extract_text_from_item(&output[0]).and_then(|text| missing_text_suffix("", &text)),
            Some("fallback".to_string())
        );
        let (call_id, _, _) = extract_function_call(&output[1]).expect("terminal tool call");
        let mut emitted = std::collections::HashSet::new();
        assert!(emitted.insert(call_id.clone()));
        assert!(!emitted.insert(call_id));
    }

    #[test]
    fn incomplete_response_error_exposes_only_stable_reason() {
        let response = serde_json::json!({
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"content": [{"text": "private response content"}]}]
        });
        let error = incomplete_response_error(Some(&response));

        assert_eq!(error.kind, ProviderStreamErrorKind::OutputTokenExhaustion);
        assert_eq!(error.reason, "max_output_tokens");
        assert_eq!(
            error.to_string(),
            "openai_response_exhausted: reason=max_output_tokens"
        );
        assert!(!error.to_string().contains("private response content"));
    }

    #[test]
    fn test_responses_sse_event_defaults() {
        // Missing optional fields should default to None
        let minimal = r#"{"type":"response.created"}"#;
        let event: ResponsesSseEvent = serde_json::from_str(minimal).unwrap();
        assert_eq!(event.kind, "response.created");
        assert!(event.response.is_none());
        assert!(event.item.is_none());
        assert!(event.part.is_none());
        assert!(event.delta.is_none());
        assert!(event.output_index.is_none());
    }

    #[test]
    fn test_is_context_overflow_error() {
        // Anthropic pattern
        assert!(is_context_overflow_error(
            "prompt is too long: 213462 tokens > 200000 maximum"
        ));

        // OpenAI pattern
        assert!(is_context_overflow_error(
            "Your input exceeds the context window of this model"
        ));

        // Google Gemini pattern
        assert!(is_context_overflow_error(
            "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
        ));

        // xAI (Grok) pattern
        assert!(is_context_overflow_error(
            "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
        ));

        // Groq pattern
        assert!(is_context_overflow_error(
            "Please reduce the length of the messages or completion"
        ));

        // OpenRouter pattern
        assert!(is_context_overflow_error(
            "This endpoint's maximum context length is 128000 tokens"
        ));

        // llama.cpp pattern
        assert!(is_context_overflow_error(
            "the request exceeds the available context size"
        ));

        // LM Studio pattern
        assert!(is_context_overflow_error(
            "tokens to keep from the initial prompt is greater than the context length"
        ));

        // Cerebras/Mistral 400 status code
        assert!(is_context_overflow_error("400 status code (no body)"));
        assert!(is_context_overflow_error("413 (no body)"));

        // Generic patterns
        assert!(is_context_overflow_error("context length exceeded"));
        assert!(is_context_overflow_error("too many tokens in request"));
        assert!(is_context_overflow_error("token limit exceeded"));

        // Non-overflow errors should return false
        assert!(!is_context_overflow_error("Rate limit exceeded"));
        assert!(!is_context_overflow_error("Invalid API key"));
        assert!(!is_context_overflow_error("Server error"));
    }

    #[test]
    fn test_is_mistral_model() {
        // Mistral models by name
        assert!(is_mistral_model("mistral-large", None));
        assert!(is_mistral_model("mistral-small", None));
        assert!(is_mistral_model("mixtral-8x7b", None));
        assert!(is_mistral_model("codestral", None));
        assert!(is_mistral_model("pixtral-12b", None));

        // Case insensitive
        assert!(is_mistral_model("Mistral-Large", None));
        assert!(is_mistral_model("MIXTRAL-8x22b", None));

        // By base URL
        assert!(is_mistral_model(
            "some-model",
            Some("https://api.mistral.ai/v1")
        ));

        // Non-Mistral models
        assert!(!is_mistral_model("gpt-4o", None));
        assert!(!is_mistral_model("claude-opus-4-5", None));
        assert!(!is_mistral_model("llama-3.1", None));
    }

    #[test]
    fn test_is_groq_model() {
        // Explicit groq/ prefix
        assert!(is_groq_model("groq/llama-3.1-70b", None));
        assert!(is_groq_model("groq/mixtral-8x7b", None));

        // By base URL
        assert!(is_groq_model(
            "some-model",
            Some("https://api.groq.com/openai/v1")
        ));

        // Llama models
        assert!(is_groq_model("llama-3.1-70b-versatile", None));
        assert!(is_groq_model("llama3-8b-8192", None));
        assert!(is_groq_model("llama-guard-3-8b", None));

        // DeepSeek models
        assert!(is_groq_model("deepseek-r1-distill-llama-70b", None));

        // Qwen models
        assert!(is_groq_model("qwen-2.5-coder-32b", None));

        // Case insensitive
        assert!(is_groq_model("Llama-3.1-8B", None));
        assert!(is_groq_model("GROQ/llama", None));

        // Non-Groq models
        assert!(!is_groq_model("gpt-4o", None));
        assert!(!is_groq_model("claude-opus-4-5", None));
        assert!(!is_groq_model("gemini-pro", None));

        // A custom non-Groq base URL pins the provider, so deepseek/qwen ids do
        // NOT get Groq-specific request shaping on direct provider clients.
        assert!(!is_groq_model(
            "deepseek-chat",
            Some("https://api.deepseek.com/v1")
        ));
        assert!(!is_groq_model(
            "qwen3-max",
            Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
        ));
    }

    #[test]
    fn test_normalize_mistral_tool_id() {
        // Already valid 9-char alphanumeric
        assert_eq!(normalize_mistral_tool_id("abcdefghi"), "abcdefghi");

        // Too short - should pad with zeros
        assert_eq!(normalize_mistral_tool_id("abc"), "abc000000");
        assert_eq!(normalize_mistral_tool_id("a"), "a00000000");

        // Too long - should truncate
        assert_eq!(normalize_mistral_tool_id("abcdefghijklm"), "abcdefghi");

        // Contains non-alphanumeric - should remove them
        assert_eq!(normalize_mistral_tool_id("call_abc123"), "callabc12");
        assert_eq!(normalize_mistral_tool_id("a-b-c-d-e"), "abcde0000");

        // UUID-like IDs
        assert_eq!(
            normalize_mistral_tool_id("550e8400-e29b-41d4-a716-446655440000"),
            "550e8400e"
        );
    }

    #[test]
    fn test_classify_error_with_overflow_patterns() {
        // Test that classify_error detects overflow from message patterns
        // even without the specific error code

        // Anthropic-style message without code
        let anthropic_overflow = serde_json::json!({
            "message": "prompt is too long: 213462 tokens > 200000 maximum"
        });
        match classify_error(&anthropic_overflow) {
            ApiError::ContextWindowExceeded => {}
            _ => panic!("Expected ContextWindowExceeded"),
        }

        // OpenRouter-style message
        let openrouter_overflow = serde_json::json!({
            "message": "This endpoint's maximum context length is 128000 tokens"
        });
        match classify_error(&openrouter_overflow) {
            ApiError::ContextWindowExceeded => {}
            _ => panic!("Expected ContextWindowExceeded"),
        }

        // Cerebras/Mistral 400 with no body
        let status_overflow = serde_json::json!({
            "message": "400 status code (no body)"
        });
        match classify_error(&status_overflow) {
            ApiError::ContextWindowExceeded => {}
            _ => panic!("Expected ContextWindowExceeded"),
        }
    }
}

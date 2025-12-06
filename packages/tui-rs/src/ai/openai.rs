//! OpenAI API client
//!
//! Implements streaming communication with the OpenAI API.
//! Supports both Chat Completions API (gpt-4o, o1) and Responses API (gpt-5.1-codex-*).
//!
//! Note: The Responses API models (gpt-5.1-codex-*) may require ChatGPT Plus authentication.

use anyhow::{Context, Result};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::client::{AiClient, AiProvider};
use super::types::*;

/// SSE event structure for Responses API (matches OpenAI's format)
#[derive(Debug, Deserialize)]
struct ResponsesSseEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    response: Option<serde_json::Value>,
    #[serde(default)]
    item: Option<serde_json::Value>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    content_index: Option<i64>,
    #[serde(default)]
    summary_index: Option<i64>,
    #[serde(default)]
    output_index: Option<i64>,
}

/// Error classification for retry logic
#[derive(Debug, Clone)]
pub enum ApiError {
    /// Context window exceeded - fatal, need to reduce input
    ContextWindowExceeded,
    /// Quota exceeded - fatal, billing issue
    QuotaExceeded,
    /// Rate limited - retryable with delay
    RateLimited { retry_after: Option<std::time::Duration> },
    /// Generic retryable error
    Retryable { message: String },
    /// Fatal error
    Fatal { message: String },
}

/// Extract function call from a ResponseItem
fn extract_function_call(item: &serde_json::Value) -> Option<(String, String, String)> {
    let item_type = item.get("type")?.as_str()?;
    if item_type != "function_call" {
        return None;
    }

    let call_id = item.get("call_id")?.as_str()?.to_string();
    let name = item.get("name")?.as_str()?.to_string();
    let arguments = item.get("arguments")?.as_str()?.to_string();

    Some((call_id, name, arguments))
}

/// Classify API error for retry logic
fn classify_error(error: &serde_json::Value) -> ApiError {
    let code = error.get("code").and_then(|c| c.as_str());
    let message = error
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string();

    match code {
        Some("context_length_exceeded") => ApiError::ContextWindowExceeded,
        Some("insufficient_quota") => ApiError::QuotaExceeded,
        Some("rate_limit_exceeded") => {
            // Try to parse retry-after from message
            let retry_after = parse_retry_after(&message);
            ApiError::RateLimited { retry_after }
        }
        _ => ApiError::Retryable { message },
    }
}

/// Parse retry-after duration from error message
fn parse_retry_after(message: &str) -> Option<std::time::Duration> {
    // Pattern: "try again in X.XXs" or "try again in X seconds"
    let lower = message.to_lowercase();
    if let Some(pos) = lower.find("try again in") {
        let after = &lower[pos + 13..];
        // Try to parse number
        let num_str: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        if let Ok(num) = num_str.parse::<f64>() {
            // Check unit
            let rest = &after[num_str.len()..].trim_start();
            if rest.starts_with("ms") {
                return Some(std::time::Duration::from_millis(num as u64));
            } else {
                // Assume seconds
                return Some(std::time::Duration::from_secs_f64(num));
            }
        }
    }
    None
}

/// Check if a tool schema has incompatible constructs for Responses API
/// Responses API doesn't support oneOf, anyOf, allOf, enum at top level
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

/// Extract text from a ResponseItem (Message type with output_text content)
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

/// Returns true if the model uses the Responses API (vs Chat Completions)
fn uses_responses_api(model: &str) -> bool {
    // Codex models and gpt-5.x models use the Responses API
    model.contains("codex") || model.starts_with("gpt-5") || model.starts_with("o3")
}

/// Get the appropriate API URL for the model
fn api_url_for_model(model: &str) -> &'static str {
    if uses_responses_api(model) {
        "https://api.openai.com/v1/responses"
    } else {
        "https://api.openai.com/v1/chat/completions"
    }
}

/// OpenAI API client
pub struct OpenAiClient {
    client: reqwest::Client,
    api_key: String,
}

impl OpenAiClient {
    /// Create a new OpenAI client
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self {
            client,
            api_key: api_key.into(),
        })
    }

    /// Create a new client from environment variable
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("OPENAI_API_KEY")
            .context("OPENAI_API_KEY environment variable not set")?;
        Self::new(api_key)
    }

    /// Build request headers
    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.api_key))
                .unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        headers
    }

    /// Convert internal messages to OpenAI format
    fn convert_messages(&self, messages: &[Message]) -> Vec<OpenAiMessage> {
        messages
            .iter()
            .filter_map(|msg| {
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
                    }),
                    MessageContent::Blocks(blocks) => {
                        // Handle tool results specially
                        if let Some(ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        }) = blocks.first()
                        {
                            return Some(OpenAiMessage {
                                role: "tool".to_string(),
                                content: Some(OpenAiContent::Text(content.clone())),
                                tool_calls: None,
                                tool_call_id: Some(tool_use_id.clone()),
                            });
                        }

                        // Convert blocks to OpenAI content parts
                        let parts: Vec<OpenAiContentPart> = blocks
                            .iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text { text } => Some(OpenAiContentPart::Text {
                                    text: text.clone(),
                                }),
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
                                                url: format!(
                                                    "data:{};base64,{}",
                                                    media_type, data
                                                ),
                                                detail: None,
                                            },
                                        })
                                    }
                                },
                                ContentBlock::ToolUse { id, name, input } => {
                                    // This would be in assistant message
                                    Some(OpenAiContentPart::Text {
                                        text: format!(
                                            "Tool call: {} ({}): {}",
                                            name,
                                            id,
                                            serde_json::to_string(input).unwrap_or_default()
                                        ),
                                    })
                                }
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
                                })
                            } else {
                                Some(OpenAiMessage {
                                    role: role.to_string(),
                                    content: Some(OpenAiContent::Parts(parts)),
                                    tool_calls: None,
                                    tool_call_id: None,
                                })
                            }
                        } else {
                            Some(OpenAiMessage {
                                role: role.to_string(),
                                content: Some(OpenAiContent::Parts(parts)),
                                tool_calls: None,
                                tool_call_id: None,
                            })
                        }
                    }
                }
            })
            .collect()
    }

    /// Convert internal tools to OpenAI format
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
        let openai_messages = self.convert_messages(messages);

        let mut body = serde_json::json!({
            "model": config.model,
            "max_tokens": config.max_tokens,
            "messages": openai_messages,
            "stream": true,
            "stream_options": {
                "include_usage": true
            }
        });

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
                                    is_error,
                                } = block
                                {
                                    has_tool_results = true;
                                    // Wrap output with success field for proper Responses API format
                                    // The Responses API expects { output: string } or { output: string, success: bool }
                                    let is_success = !is_error.unwrap_or(false);
                                    input.push(serde_json::json!({
                                        "type": "function_call_output",
                                        "call_id": tool_use_id,
                                        "output": content,
                                        "success": is_success
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
                                if let ContentBlock::ToolUse { id, name, input: args } = block {
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
            "model": config.model,
            "input": input,
            "stream": true
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
                            "parameters": tool.input_schema
                        })
                    })
                    .collect();
                body["tools"] = serde_json::json!(tools);
            }
        }

        // Add reasoning effort for thinking models
        if let Some(thinking) = &config.thinking {
            let effort = if thinking.budget_tokens > 10000 {
                "high"
            } else if thinking.budget_tokens > 3000 {
                "medium"
            } else {
                "low"
            };
            body["reasoning"] = serde_json::json!({
                "effort": effort
            });

            // Include encrypted reasoning content for multi-turn conversations
            // This preserves reasoning state across turns
            body["include"] = serde_json::json!(["reasoning.encrypted_content"]);
        }

        body
    }

    /// Build the appropriate request body based on model
    fn build_request_body(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> serde_json::Value {
        if uses_responses_api(&config.model) {
            self.build_responses_request_body(messages, config)
        } else {
            self.build_chat_request_body(messages, config)
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
        let body = self.build_request_body(messages, config);

        // Get the appropriate API URL for this model
        let api_url = api_url_for_model(&config.model);

        // Make request
        let response = self
            .client
            .post(api_url)
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .context("Failed to send request to OpenAI API")?;

        // Check for errors
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let _ = tx.send(StreamEvent::Error {
                message: format!("API error {}: {}", status, error_text),
            });
            return Ok(rx);
        }

        // Spawn task to process SSE stream
        let model = config.model.clone();
        let is_responses_api = uses_responses_api(&config.model);

        if is_responses_api {
            // Use eventsource-stream for proper SSE parsing (Responses API)
            let stream = response.bytes_stream();
            tokio::spawn(async move {
                let mut sse_stream = stream
                    .map(|result| result.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
                    .eventsource();

                let mut content_started = false;
                let mut received_streaming_text = false; // Track if we got text via streaming deltas
                let mut tool_call_index = 1; // Start at 1, reserve 0 for text content

                while let Some(event_result) = sse_stream.next().await {
                    match event_result {
                        Ok(sse) => {
                            // Parse the SSE data as JSON
                            let event: ResponsesSseEvent = match serde_json::from_str(&sse.data) {
                                Ok(e) => e,
                                Err(_) => continue, // Skip unparseable events
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
                                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                                    if let Some(delta) = &event.delta {
                                        let _ = tx.send(StreamEvent::ThinkingDelta {
                                            index: 0,
                                            thinking: delta.clone(),
                                        });
                                    }
                                }
                                "response.output_item.added" | "response.content_part.added" => {
                                    // Check if this is a message item (not reasoning)
                                    if let Some(item) = &event.item {
                                        let item_type = item.get("type").and_then(|v| v.as_str());
                                        if item_type == Some("message") {
                                            if !content_started {
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
                                }
                                "response.output_item.done" => {
                                    if let Some(item) = &event.item {
                                        // Check if this is a function call
                                        if let Some((call_id, name, arguments)) = extract_function_call(item) {
                                            // Parse arguments JSON
                                            let input: serde_json::Value = serde_json::from_str(&arguments)
                                                .unwrap_or(serde_json::json!({}));

                                            // Emit tool use block
                                            let tool_index = tool_call_index;
                                            tool_call_index += 1;

                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: tool_index,
                                                block: ContentBlock::ToolUse {
                                                    id: call_id.clone(),
                                                    name: name.clone(),
                                                    input: input.clone(),
                                                },
                                            });

                                            let _ = tx.send(StreamEvent::ContentBlockStop { index: tool_index });
                                        }
                                        // Only extract text as fallback if we didn't receive streaming deltas
                                        else if !received_streaming_text {
                                            if let Some(text) = extract_text_from_item(item) {
                                                if !content_started {
                                                    content_started = true;
                                                    let _ = tx.send(StreamEvent::ContentBlockStart {
                                                        index: 0,
                                                        block: ContentBlock::Text {
                                                            text: String::new(),
                                                        },
                                                    });
                                                }
                                                let _ = tx.send(StreamEvent::TextDelta {
                                                    index: 0,
                                                    text,
                                                });
                                            }
                                        }
                                    }
                                }
                                // Handle streaming function call arguments
                                "response.function_call_arguments.delta" => {
                                    if let Some(delta) = &event.delta {
                                        // Get or create tool call index
                                        let idx = event.output_index.unwrap_or(0) as usize;
                                        let tool_idx = idx + 1; // Reserve 0 for text

                                        let _ = tx.send(StreamEvent::InputJsonDelta {
                                            index: tool_idx,
                                            partial_json: delta.clone(),
                                        });
                                    }
                                }
                                "response.output_text.delta" => {
                                    received_streaming_text = true; // Mark that we're receiving streaming text
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
                                    // Now close the content block
                                    if content_started {
                                        let _ = tx.send(StreamEvent::ContentBlockStop { index: 0 });
                                    }
                                    // Extract usage from response if present
                                    if let Some(resp) = &event.response {
                                        if let Some(usage) = resp.get("usage") {
                                            let input = usage
                                                .get("input_tokens")
                                                .and_then(|v| v.as_u64())
                                                .unwrap_or(0);
                                            let output = usage
                                                .get("output_tokens")
                                                .and_then(|v| v.as_u64())
                                                .unwrap_or(0);
                                            // Extract cached tokens from input_tokens_details
                                            let cache_read = usage
                                                .get("input_tokens_details")
                                                .and_then(|d| d.get("cached_tokens"))
                                                .and_then(|v| v.as_u64());
                                            // Extract reasoning tokens from output_tokens_details
                                            let _reasoning_tokens = usage
                                                .get("output_tokens_details")
                                                .and_then(|d| d.get("reasoning_tokens"))
                                                .and_then(|v| v.as_u64());
                                            let _ = tx.send(StreamEvent::Usage {
                                                input_tokens: input,
                                                output_tokens: output,
                                                cache_read_tokens: cache_read,
                                                cache_creation_tokens: None,
                                            });
                                        }
                                    }
                                    let _ = tx.send(StreamEvent::MessageStop);
                                    return;
                                }
                                "response.failed" => {
                                    // Classify the error for proper handling
                                    let (error_msg, _api_error) = if let Some(resp) = &event.response {
                                        if let Some(error) = resp.get("error") {
                                            let classified = classify_error(error);
                                            let msg = match &classified {
                                                ApiError::ContextWindowExceeded => {
                                                    "Context window exceeded - message too long".to_string()
                                                }
                                                ApiError::QuotaExceeded => {
                                                    "API quota exceeded - check your billing".to_string()
                                                }
                                                ApiError::RateLimited { retry_after } => {
                                                    if let Some(delay) = retry_after {
                                                        format!("Rate limited - retry after {:?}", delay)
                                                    } else {
                                                        "Rate limited - please try again".to_string()
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

                                    let _ = tx.send(StreamEvent::Error {
                                        message: error_msg,
                                    });
                                    return;
                                }
                                _ => {
                                    // Unknown event type, ignore
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(StreamEvent::Error {
                                message: format!("SSE stream error: {}", e),
                            });
                            return;
                        }
                    }
                }

                // Stream ended without response.completed
                let _ = tx.send(StreamEvent::MessageStop);
            });
        } else {
            // Chat Completions API - uses simpler line-based SSE
            let mut stream = response.bytes_stream();
            tokio::spawn(async move {
                let mut buffer = String::new();
                let mut message_id = String::new();
                let mut current_tool_calls: Vec<ToolCallAccumulator> = Vec::new();
                let mut content_started = false;
                let mut tool_use_index = 0;

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
                                    for (idx, _) in current_tool_calls.iter().enumerate() {
                                        let _ = tx.send(StreamEvent::ContentBlockStop { index: idx + 1 });
                                    }
                                    let _ = tx.send(StreamEvent::MessageStop);
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
                                                    let _ = tx.send(StreamEvent::ContentBlockStart {
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
                                                        current_tool_calls.push(ToolCallAccumulator {
                                                            id: String::new(),
                                                            name: String::new(),
                                                            arguments: String::new(),
                                                        });
                                                    }

                                                    if let Some(id) = &tc.id {
                                                        current_tool_calls[idx].id = id.clone();
                                                    }
                                                    if let Some(func) = &tc.function {
                                                        if let Some(name) = &func.name {
                                                            current_tool_calls[idx].name = name.clone();
                                                            if content_started {
                                                                let _ = tx.send(
                                                                    StreamEvent::ContentBlockStop { index: 0 },
                                                                );
                                                            }
                                                            tool_use_index = idx + 1;
                                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                                index: tool_use_index,
                                                                block: ContentBlock::ToolUse {
                                                                    id: current_tool_calls[idx].id.clone(),
                                                                    name: name.clone(),
                                                                    input: serde_json::Value::Object(
                                                                        Default::default(),
                                                                    ),
                                                                },
                                                            });
                                                        }
                                                        if let Some(args) = &func.arguments {
                                                            current_tool_calls[idx].arguments.push_str(args);
                                                            let _ = tx.send(StreamEvent::InputJsonDelta {
                                                                index: tool_use_index,
                                                                partial_json: args.clone(),
                                                            });
                                                        }
                                                    }
                                                }
                                            }

                                            if choice.finish_reason.is_some() {
                                                if content_started && current_tool_calls.is_empty() {
                                                    let _ = tx.send(StreamEvent::ContentBlockStop { index: 0 });
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
                            let _ = tx.send(StreamEvent::Error {
                                message: format!("Stream error: {}", e),
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

#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<OpenAiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum OpenAiContent {
    Text(String),
    Parts(Vec<OpenAiContentPart>),
}

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
    #[serde(default)]
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
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_detection() {
        assert_eq!(AiProvider::from_model("gpt-5.1-codex-max"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model("gpt-4o"), AiProvider::OpenAI);
        assert_eq!(AiProvider::from_model("claude-opus-4-5-20251101"), AiProvider::Anthropic);
        assert_eq!(AiProvider::from_model("claude-sonnet-4-5"), AiProvider::Anthropic);
    }
}

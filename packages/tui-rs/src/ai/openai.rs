//! OpenAI API client
//!
//! Implements streaming communication with the OpenAI API.
//! Supports both Chat Completions API (gpt-4o, o1) and Responses API (gpt-5.1-codex-*).
//!
//! Note: The Responses API models (gpt-5.1-codex-*) may require ChatGPT Plus authentication.

use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::client::{AiClient, AiProvider};
use super::types::*;

/// Returns true if the model uses the Responses API (vs Chat Completions)
fn uses_responses_api(model: &str) -> bool {
    model.contains("codex") || model.starts_with("gpt-5")
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
        let input: Vec<serde_json::Value> = messages
            .iter()
            .filter_map(|msg| {
                let role = match msg.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    Role::System => return None, // System goes in instructions
                };

                match &msg.content {
                    MessageContent::Text(text) => Some(serde_json::json!({
                        "type": "message",
                        "role": role,
                        "content": [{
                            "type": "input_text",
                            "text": text
                        }]
                    })),
                    MessageContent::Blocks(blocks) => {
                        let content: Vec<serde_json::Value> = blocks
                            .iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text { text } => Some(serde_json::json!({
                                    "type": "input_text",
                                    "text": text
                                })),
                                ContentBlock::ToolUse { id, name, input } => {
                                    Some(serde_json::json!({
                                        "type": "function_call",
                                        "call_id": id,
                                        "name": name,
                                        "arguments": input.to_string()
                                    }))
                                }
                                ContentBlock::ToolResult {
                                    tool_use_id,
                                    content,
                                    ..
                                } => Some(serde_json::json!({
                                    "type": "function_call_output",
                                    "call_id": tool_use_id,
                                    "output": content
                                })),
                                _ => None,
                            })
                            .collect();

                        if content.is_empty() {
                            None
                        } else {
                            Some(serde_json::json!({
                                "type": "message",
                                "role": role,
                                "content": content
                            }))
                        }
                    }
                }
            })
            .collect();

        let mut body = serde_json::json!({
            "model": config.model,
            "input": input,
            "stream": true
        });

        // Add instructions (system prompt)
        if let Some(system) = &config.system {
            body["instructions"] = serde_json::json!(system);
        }

        // Add tools
        if !config.tools.is_empty() {
            let tools: Vec<serde_json::Value> = config
                .tools
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
        let mut stream = response.bytes_stream();
        let model = config.model.clone();

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

                            // Skip empty lines
                            if line.is_empty() {
                                continue;
                            }

                            // Check for stream end
                            if line == "data: [DONE]" {
                                // Finalize any pending tool calls
                                for (idx, tool_acc) in current_tool_calls.iter().enumerate() {
                                    let input: serde_json::Value =
                                        serde_json::from_str(&tool_acc.arguments)
                                            .unwrap_or(serde_json::Value::Object(Default::default()));
                                    let _ = tx.send(StreamEvent::ContentBlockStop {
                                        index: idx + 1, // +1 because text is index 0
                                    });
                                }
                                let _ = tx.send(StreamEvent::MessageStop);
                                return;
                            }

                            // Parse SSE data
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                                    // Handle message start
                                    if message_id.is_empty() {
                                        message_id = chunk.id.clone();
                                        let _ = tx.send(StreamEvent::MessageStart {
                                            id: chunk.id.clone(),
                                            model: model.clone(),
                                        });
                                    }

                                    // Process choices
                                    for choice in &chunk.choices {
                                        // Handle text content
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

                                        // Handle tool calls
                                        if let Some(tool_calls) = &choice.delta.tool_calls {
                                            for tc in tool_calls {
                                                let idx = tc.index.unwrap_or(0);

                                                // Ensure we have an accumulator for this index
                                                while current_tool_calls.len() <= idx {
                                                    current_tool_calls.push(ToolCallAccumulator {
                                                        id: String::new(),
                                                        name: String::new(),
                                                        arguments: String::new(),
                                                    });
                                                }

                                                // Accumulate tool call data
                                                if let Some(id) = &tc.id {
                                                    current_tool_calls[idx].id = id.clone();
                                                }
                                                if let Some(func) = &tc.function {
                                                    if let Some(name) = &func.name {
                                                        current_tool_calls[idx].name = name.clone();
                                                        // Emit content block start for tool
                                                        if content_started {
                                                            let _ = tx.send(
                                                                StreamEvent::ContentBlockStop {
                                                                    index: 0,
                                                                },
                                                            );
                                                        }
                                                        tool_use_index = idx + 1;
                                                        let _ = tx.send(
                                                            StreamEvent::ContentBlockStart {
                                                                index: tool_use_index,
                                                                block: ContentBlock::ToolUse {
                                                                    id: current_tool_calls[idx]
                                                                        .id
                                                                        .clone(),
                                                                    name: name.clone(),
                                                                    input: serde_json::Value::Object(
                                                                        Default::default(),
                                                                    ),
                                                                },
                                                            },
                                                        );
                                                    }
                                                    if let Some(args) = &func.arguments {
                                                        current_tool_calls[idx]
                                                            .arguments
                                                            .push_str(args);
                                                        let _ =
                                                            tx.send(StreamEvent::InputJsonDelta {
                                                                index: tool_use_index,
                                                                partial_json: args.clone(),
                                                            });
                                                    }
                                                }
                                            }
                                        }

                                        // Handle finish reason
                                        if choice.finish_reason.is_some() {
                                            if content_started && current_tool_calls.is_empty() {
                                                let _ = tx.send(StreamEvent::ContentBlockStop {
                                                    index: 0,
                                                });
                                            }
                                        }
                                    }

                                    // Handle usage stats (sent at end with stream_options)
                                    if let Some(usage) = &chunk.usage {
                                        let _ = tx.send(StreamEvent::Usage {
                                            input_tokens: usage.prompt_tokens.unwrap_or(0),
                                            output_tokens: usage.completion_tokens.unwrap_or(0),
                                            cache_read_tokens: usage.prompt_tokens_details
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

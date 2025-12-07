//! Anthropic API client
//!
//! Implements streaming communication with the Claude API.
//! Supports Claude Opus 4.5, Sonnet 4.5, and other Claude models.

use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde::Deserialize;
use tokio::sync::mpsc;

use super::client::{AiClient, AiProvider};
use super::types::*;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic API client
pub struct AnthropicClient {
    client: reqwest::Client,
    api_key: String,
}

impl AnthropicClient {
    /// Create a new Anthropic client
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
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .context("ANTHROPIC_API_KEY environment variable not set")?;
        Self::new(api_key)
    }

    /// Build request headers
    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(&self.api_key).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        headers.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        // Enable extended features
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("prompt-caching-2024-07-31,interleaved-thinking-2025-05-14"),
        );
        headers
    }

    /// Stream a request to the API (internal implementation)
    async fn stream_impl(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();

        // Build request body
        let body = self.build_request_body(messages, config)?;

        // Make request
        let response = self
            .client
            .post(ANTHROPIC_API_URL)
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .context("Failed to send request to Anthropic API")?;

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
        tokio::spawn(async move {
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));

                        // Process complete SSE events
                        while let Some(pos) = buffer.find("\n\n") {
                            let event_data = buffer[..pos].to_string();
                            buffer = buffer[pos + 2..].to_string();

                            if let Some(event) = parse_sse_event(&event_data) {
                                if tx.send(event).is_err() {
                                    return; // Receiver dropped
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

    /// Build the request body
    fn build_request_body(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<serde_json::Value> {
        let mut body = serde_json::json!({
            "model": config.model,
            "max_tokens": config.max_tokens,
            "messages": messages,
            "stream": true,
        });

        if let Some(system) = &config.system {
            body["system"] = serde_json::json!(system);
        }

        if let Some(temp) = config.temperature {
            body["temperature"] = serde_json::json!(temp);
        }

        if !config.tools.is_empty() {
            body["tools"] = serde_json::json!(config.tools);
        }

        if let Some(thinking) = &config.thinking {
            body["thinking"] = serde_json::json!(thinking);
        }

        Ok(body)
    }
}

impl AiClient for AnthropicClient {
    fn provider(&self) -> AiProvider {
        AiProvider::Anthropic
    }

    async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        self.stream_impl(messages, config).await
    }
}

/// Parse an SSE event into a StreamEvent
fn parse_sse_event(data: &str) -> Option<StreamEvent> {
    let mut event_type = None;
    let mut event_data = None;

    for line in data.lines() {
        if let Some(t) = line.strip_prefix("event: ") {
            event_type = Some(t.trim());
        } else if let Some(d) = line.strip_prefix("data: ") {
            event_data = Some(d.trim());
        }
    }

    let event_type = event_type?;
    let event_data = event_data?;

    match event_type {
        "message_start" => {
            let parsed: MessageStartEvent = serde_json::from_str(event_data).ok()?;
            Some(StreamEvent::MessageStart {
                id: parsed.message.id,
                model: parsed.message.model,
            })
        }
        "content_block_start" => {
            let parsed: ContentBlockStartEvent = serde_json::from_str(event_data).ok()?;
            let block = match parsed.content_block {
                RawContentBlock::Text { text } => ContentBlock::Text { text },
                RawContentBlock::ToolUse { id, name, input } => ContentBlock::ToolUse {
                    id,
                    name,
                    input: input.unwrap_or(serde_json::Value::Object(Default::default())),
                },
                RawContentBlock::Thinking { thinking } => ContentBlock::Thinking { thinking },
            };
            Some(StreamEvent::ContentBlockStart {
                index: parsed.index,
                block,
            })
        }
        "content_block_delta" => {
            let parsed: ContentBlockDeltaEvent = serde_json::from_str(event_data).ok()?;
            match parsed.delta {
                DeltaType::TextDelta { text } => Some(StreamEvent::TextDelta {
                    index: parsed.index,
                    text,
                }),
                DeltaType::ThinkingDelta { thinking } => Some(StreamEvent::ThinkingDelta {
                    index: parsed.index,
                    thinking,
                }),
                DeltaType::InputJsonDelta { partial_json } => Some(StreamEvent::InputJsonDelta {
                    index: parsed.index,
                    partial_json,
                }),
            }
        }
        "content_block_stop" => {
            let parsed: ContentBlockStopEvent = serde_json::from_str(event_data).ok()?;
            Some(StreamEvent::ContentBlockStop {
                index: parsed.index,
            })
        }
        "message_delta" => {
            let parsed: MessageDeltaEvent = serde_json::from_str(event_data).ok()?;
            if let Some(usage) = parsed.usage {
                Some(StreamEvent::Usage {
                    input_tokens: usage.input_tokens.unwrap_or(0),
                    output_tokens: usage.output_tokens.unwrap_or(0),
                    cache_read_tokens: usage.cache_read_input_tokens,
                    cache_creation_tokens: usage.cache_creation_input_tokens,
                })
            } else {
                None
            }
        }
        "message_stop" => Some(StreamEvent::MessageStop),
        "error" => {
            let parsed: ErrorEvent = serde_json::from_str(event_data).ok()?;
            Some(StreamEvent::Error {
                message: parsed.error.message,
            })
        }
        "ping" => None, // Ignore pings
        _ => None,
    }
}

// ============================================================================
// SSE Event Parsing Types
// ============================================================================

#[derive(Debug, Deserialize)]
struct MessageStartEvent {
    message: MessageInfo,
}

#[derive(Debug, Deserialize)]
struct MessageInfo {
    id: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct ContentBlockStartEvent {
    index: usize,
    content_block: RawContentBlock,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Option<serde_json::Value>,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
}

#[derive(Debug, Deserialize)]
struct ContentBlockDeltaEvent {
    index: usize,
    delta: DeltaType,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DeltaType {
    TextDelta { text: String },
    ThinkingDelta { thinking: String },
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Deserialize)]
struct ContentBlockStopEvent {
    index: usize,
}

#[derive(Debug, Deserialize)]
struct MessageDeltaEvent {
    #[serde(default)]
    usage: Option<UsageInfo>,
}

#[derive(Debug, Deserialize)]
struct UsageInfo {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ErrorEvent {
    error: ErrorInfo,
}

#[derive(Debug, Deserialize)]
struct ErrorInfo {
    message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_message_start() {
        let data = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-3-opus-20240229","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}"#;

        let event = parse_sse_event(data).unwrap();
        assert!(matches!(event, StreamEvent::MessageStart { id, .. } if id == "msg_123"));
    }

    #[test]
    fn parse_text_delta() {
        let data = r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;

        let event = parse_sse_event(data).unwrap();
        assert!(matches!(event, StreamEvent::TextDelta { text, .. } if text == "Hello"));
    }
}

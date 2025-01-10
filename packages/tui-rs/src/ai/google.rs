//! Google Gemini AI Client
//!
//! Implementation of the Google Gemini API for streaming AI responses.
//! Supports Gemini 2.5 Pro/Flash models with function calling.
//!
//! # API Differences from Anthropic/OpenAI
//!
//! - Uses `generateContent` endpoint with streaming
//! - Different message format (Content with Parts)
//! - Tool calls are returned as `functionCall` parts
//! - Supports `thought` field for reasoning/thinking
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::ai::google::GoogleClient;
//!
//! let client = GoogleClient::from_env()?;
//! let mut rx = client.stream(&messages, &config).await?;
//! while let Some(event) = rx.recv().await {
//!     // Handle streaming events
//! }
//! ```

use std::env;

use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

use super::types::*;
use super::AiProvider;

/// Google Gemini API base URL
const GOOGLE_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Google Gemini client
#[derive(Clone)]
pub struct GoogleClient {
    api_key: String,
    client: Client,
}

impl GoogleClient {
    /// Create a new Google client with the given API key
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            client: Client::new(),
        }
    }

    /// Create a Google client from GOOGLE_API_KEY environment variable
    pub fn from_env() -> Result<Self> {
        let api_key = env::var("GOOGLE_API_KEY")
            .or_else(|_| env::var("GEMINI_API_KEY"))
            .context("GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set")?;
        Ok(Self::new(api_key))
    }

    /// Stream a request to the Gemini API
    pub async fn stream(
        &self,
        messages: &[Message],
        config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();

        // Build the request
        let request = self.build_request(messages, config)?;

        // Clone for the spawned task
        let client = self.client.clone();
        let api_key = self.api_key.clone();
        let model = config.model.clone();

        tokio::spawn(async move {
            if let Err(e) =
                stream_google_response(client, api_key, model, request, tx.clone()).await
            {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Google API error: {}", e),
                });
            }
        });

        Ok(rx)
    }

    /// Build the Gemini API request body
    fn build_request(&self, messages: &[Message], config: &RequestConfig) -> Result<GoogleRequest> {
        let contents = messages
            .iter()
            .map(|msg| self.message_to_content(msg))
            .collect();

        let mut request = GoogleRequest {
            contents,
            generation_config: Some(GenerationConfig {
                max_output_tokens: Some(config.max_tokens as u32),
                temperature: config.temperature,
                ..Default::default()
            }),
            system_instruction: config.system.as_ref().map(|s| Content {
                role: None,
                parts: vec![Part::Text { text: s.clone() }],
            }),
            tools: None,
        };

        // Add tools if provided
        if !config.tools.is_empty() {
            let function_declarations: Vec<FunctionDeclaration> = config
                .tools
                .iter()
                .map(|tool| FunctionDeclaration {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.input_schema.clone(),
                })
                .collect();

            request.tools = Some(vec![GoogleTool {
                function_declarations,
            }]);
        }

        Ok(request)
    }

    /// Convert our Message type to Google Content format
    fn message_to_content(&self, msg: &Message) -> Content {
        let role = match msg.role {
            Role::User => "user",
            Role::Assistant => "model",
            Role::System => "user", // Google handles system via system_instruction
        };

        let parts = match &msg.content {
            MessageContent::Text(text) => vec![Part::Text { text: text.clone() }],
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(Part::Text { text: text.clone() }),
                    ContentBlock::Thinking { thinking } => Some(Part::Text {
                        text: format!("<thinking>{}</thinking>", thinking),
                    }),
                    ContentBlock::ToolUse { id: _, name, input } => Some(Part::FunctionCall {
                        function_call: FunctionCall {
                            name: name.clone(),
                            args: input.clone(),
                        },
                    }),
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } => Some(Part::FunctionResponse {
                        function_response: FunctionResponse {
                            name: tool_use_id.clone(),
                            response: json!({ "result": content }),
                        },
                    }),
                    _ => None,
                })
                .collect(),
        };

        Content {
            role: Some(role.to_string()),
            parts,
        }
    }

    /// Get the provider type
    pub fn provider(&self) -> AiProvider {
        AiProvider::Google
    }
}

/// Stream response from Google Gemini API
async fn stream_google_response(
    client: Client,
    api_key: String,
    model: String,
    request: GoogleRequest,
    tx: mpsc::UnboundedSender<StreamEvent>,
) -> Result<()> {
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse&key={}",
        GOOGLE_API_BASE, model, api_key
    );

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .context("Failed to send request to Google API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Google API error ({}): {}", status, body);
    }

    // Parse SSE stream
    let mut stream = response.bytes_stream();

    let mut buffer = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Failed to read chunk")?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE events
        while let Some(pos) = buffer.find("\n\n") {
            let event = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            // Parse SSE data
            if let Some(data) = event.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    break;
                }

                if let Ok(response) = serde_json::from_str::<GoogleResponse>(data) {
                    // Process candidates
                    if let Some(candidates) = response.candidates {
                        for candidate in candidates {
                            if let Some(content) = candidate.content {
                                for part in content.parts {
                                    match part {
                                        Part::Text { text } => {
                                            let _ =
                                                tx.send(StreamEvent::TextDelta { index: 0, text });
                                        }
                                        Part::FunctionCall { function_call } => {
                                            // Tool use - send as content block start with ToolUse
                                            let _ = tx.send(StreamEvent::ContentBlockStart {
                                                index: 0,
                                                block: ContentBlock::ToolUse {
                                                    id: format!("call_{}", uuid::Uuid::new_v4()),
                                                    name: function_call.name,
                                                    input: function_call.args,
                                                },
                                            });
                                        }
                                        _ => {}
                                    }
                                }
                            }

                            // Check finish reason
                            if let Some(reason) = candidate.finish_reason {
                                let stop_reason = match reason.as_str() {
                                    "STOP" => Some(StopReason::EndTurn),
                                    "MAX_TOKENS" => Some(StopReason::MaxTokens),
                                    "SAFETY" => Some(StopReason::EndTurn),
                                    _ => Some(StopReason::EndTurn),
                                };
                                let _ = tx.send(StreamEvent::MessageStop { stop_reason });
                            }
                        }
                    }

                    // Update usage
                    if let Some(metadata) = response.usage_metadata {
                        input_tokens = metadata.prompt_token_count.unwrap_or(0);
                        output_tokens = metadata.candidates_token_count.unwrap_or(0);
                    }
                }
            }
        }
    }

    // Send final usage
    let _ = tx.send(StreamEvent::Usage {
        input_tokens,
        output_tokens,
        cache_read_tokens: Some(0),
        cache_creation_tokens: Some(0),
    });

    Ok(())
}

// ============================================================================
// Google API Types
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleRequest {
    contents: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GoogleTool>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Content {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    parts: Vec<Part>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum Part {
    Text {
        text: String,
    },
    FunctionCall {
        #[serde(rename = "functionCall")]
        function_call: FunctionCall,
    },
    FunctionResponse {
        #[serde(rename = "functionResponse")]
        function_response: FunctionResponse,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct FunctionCall {
    name: String,
    args: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct FunctionResponse {
    name: String,
    response: serde_json::Value,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_k: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTool {
    function_declarations: Vec<FunctionDeclaration>,
}

#[derive(Debug, Serialize)]
struct FunctionDeclaration {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleResponse {
    candidates: Option<Vec<Candidate>>,
    usage_metadata: Option<UsageMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    content: Option<Content>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageMetadata {
    prompt_token_count: Option<u64>,
    candidates_token_count: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_google_client_creation() {
        let client = GoogleClient::new("test-key");
        assert_eq!(client.provider(), AiProvider::Google);
    }

    #[test]
    fn test_message_to_content_text() {
        let client = GoogleClient::new("test");
        let msg = Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.role, Some("user".to_string()));
        assert_eq!(content.parts.len(), 1);
    }

    #[test]
    fn test_message_to_content_assistant() {
        let client = GoogleClient::new("test");
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Text("Hi there".to_string()),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.role, Some("model".to_string()));
    }

    #[test]
    fn test_build_request_with_tools() {
        let client = GoogleClient::new("test");
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            temperature: Some(0.7),
            system: Some("You are helpful".to_string()),
            tools: vec![Tool::new("test", "A test tool").with_schema(json!({
                "type": "object",
                "properties": {}
            }))],
            thinking: None,
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert!(request.tools.is_some());
        assert!(request.system_instruction.is_some());
    }
}

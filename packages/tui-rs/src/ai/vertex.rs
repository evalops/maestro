//! Vertex AI Client
//!
//! Implementation of Google's Vertex AI API for streaming AI responses.
//! Supports Gemini models via the Vertex AI endpoint with OAuth or API key auth.
//!
//! # API Differences from Direct Gemini API
//!
//! - Uses project-based endpoint: `{region}-aiplatform.googleapis.com`
//! - Requires Google Cloud project ID and region
//! - Supports both API key and OAuth authentication
//! - Different request format with Vertex-specific fields
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::ai::vertex::VertexAiClient;
//!
//! let client = VertexAiClient::from_env()?;
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

/// Default Vertex AI region
const DEFAULT_REGION: &str = "us-central1";

/// Vertex AI client
#[derive(Clone)]
pub struct VertexAiClient {
    api_key: Option<String>,
    access_token: Option<String>,
    project_id: String,
    region: String,
    client: Client,
}

impl VertexAiClient {
    /// Create a new Vertex AI client with project ID and region
    pub fn new(
        project_id: impl Into<String>,
        region: impl Into<String>,
        api_key: Option<String>,
        access_token: Option<String>,
    ) -> Self {
        Self {
            api_key,
            access_token,
            project_id: project_id.into(),
            region: region.into(),
            client: Client::new(),
        }
    }

    /// Create a Vertex AI client from environment variables
    ///
    /// Required:
    /// - `GOOGLE_CLOUD_PROJECT` or `VERTEX_PROJECT_ID`: Google Cloud project ID
    ///
    /// Optional:
    /// - `VERTEX_REGION`: Region (defaults to us-central1)
    /// - `GOOGLE_API_KEY`: API key for authentication
    /// - `VERTEX_ACCESS_TOKEN`: OAuth access token (takes precedence over API key)
    pub fn from_env() -> Result<Self> {
        let project_id = env::var("GOOGLE_CLOUD_PROJECT")
            .or_else(|_| env::var("VERTEX_PROJECT_ID"))
            .context("GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID environment variable not set")?;

        let region = env::var("VERTEX_REGION").unwrap_or_else(|_| DEFAULT_REGION.to_string());

        let api_key = env::var("GOOGLE_API_KEY").ok();
        let access_token = env::var("VERTEX_ACCESS_TOKEN").ok();

        if api_key.is_none() && access_token.is_none() {
            anyhow::bail!("Either GOOGLE_API_KEY or VERTEX_ACCESS_TOKEN must be set for Vertex AI");
        }

        Ok(Self::new(project_id, region, api_key, access_token))
    }

    /// Stream a request to the Vertex AI API
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
        let project_id = self.project_id.clone();
        let region = self.region.clone();
        let api_key = self.api_key.clone();
        let access_token = self.access_token.clone();
        let model = config.model.clone();

        tokio::spawn(async move {
            if let Err(e) = stream_vertex_response(
                client,
                project_id,
                region,
                model,
                api_key,
                access_token,
                request,
                tx.clone(),
            )
            .await
            {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Vertex AI error: {}", e),
                });
            }
        });

        Ok(rx)
    }

    /// Build the Vertex AI request body
    fn build_request(&self, messages: &[Message], config: &RequestConfig) -> Result<VertexRequest> {
        let contents = messages
            .iter()
            .map(|msg| self.message_to_content(msg))
            .collect();

        let mut request = VertexRequest {
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
            safety_settings: None,
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

            request.tools = Some(vec![VertexTool {
                function_declarations,
            }]);
        }

        Ok(request)
    }

    /// Convert our Message type to Vertex Content format
    fn message_to_content(&self, msg: &Message) -> Content {
        let role = match msg.role {
            Role::User => "user",
            Role::Assistant => "model",
            Role::System => "user", // Vertex handles system via system_instruction
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
        AiProvider::VertexAi
    }
}

/// Stream response from Vertex AI API
#[allow(clippy::too_many_arguments)]
async fn stream_vertex_response(
    client: Client,
    project_id: String,
    region: String,
    model: String,
    api_key: Option<String>,
    access_token: Option<String>,
    request: VertexRequest,
    tx: mpsc::UnboundedSender<StreamEvent>,
) -> Result<()> {
    // Vertex AI endpoint format
    let url = format!(
        "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/publishers/google/models/{}:streamGenerateContent",
        region, project_id, region, model
    );

    let mut req_builder = client.post(&url).header("Content-Type", "application/json");

    // Add authentication
    if let Some(token) = access_token {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", token));
    } else if let Some(key) = api_key {
        req_builder = req_builder.query(&[("key", key)]);
    }

    let response = req_builder
        .json(&request)
        .send()
        .await
        .context("Failed to send request to Vertex AI")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Vertex AI error ({}): {}", status, body);
    }

    // Parse SSE stream
    let mut stream = response.bytes_stream();

    let mut buffer = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Failed to read chunk")?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete JSON objects (Vertex uses newline-delimited JSON)
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() || line == "[" || line == "]" || line == "," {
                continue;
            }

            // Strip leading comma if present (array format)
            let json_str = line.trim_start_matches(',').trim();
            if json_str.is_empty() {
                continue;
            }

            if let Ok(response) = serde_json::from_str::<VertexResponse>(json_str) {
                // Process candidates
                if let Some(candidates) = response.candidates {
                    for candidate in candidates {
                        if let Some(content) = candidate.content {
                            for part in content.parts {
                                match part {
                                    Part::Text { text } => {
                                        let _ = tx.send(StreamEvent::TextDelta { index: 0, text });
                                    }
                                    Part::FunctionCall { function_call } => {
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
                                "TOOL_USE" => Some(StopReason::ToolUse),
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
// Vertex AI Types
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VertexRequest {
    contents: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<VertexTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    safety_settings: Option<Vec<SafetySetting>>,
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
struct VertexTool {
    function_declarations: Vec<FunctionDeclaration>,
}

#[derive(Debug, Serialize)]
struct FunctionDeclaration {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafetySetting {
    category: String,
    threshold: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VertexResponse {
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
    fn test_vertex_client_creation() {
        let client = VertexAiClient::new(
            "test-project",
            "us-central1",
            Some("test-key".to_string()),
            None,
        );
        assert_eq!(client.provider(), AiProvider::VertexAi);
        assert_eq!(client.project_id, "test-project");
        assert_eq!(client.region, "us-central1");
    }

    #[test]
    fn test_vertex_client_with_access_token() {
        let client = VertexAiClient::new(
            "my-project",
            "europe-west4",
            None,
            Some("access-token-123".to_string()),
        );
        assert_eq!(client.project_id, "my-project");
        assert_eq!(client.region, "europe-west4");
        assert!(client.api_key.is_none());
        assert!(client.access_token.is_some());
    }

    #[test]
    fn test_vertex_client_with_both_auth_methods() {
        let client = VertexAiClient::new(
            "test-project",
            "us-central1",
            Some("api-key".to_string()),
            Some("access-token".to_string()),
        );
        // Both are allowed, access_token takes precedence in actual requests
        assert!(client.api_key.is_some());
        assert!(client.access_token.is_some());
    }

    #[test]
    fn test_message_to_content_text() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.role, Some("user".to_string()));
        assert_eq!(content.parts.len(), 1);
        match &content.parts[0] {
            Part::Text { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Text part"),
        }
    }

    #[test]
    fn test_message_to_content_assistant() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Text("Hi there".to_string()),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.role, Some("model".to_string()));
    }

    #[test]
    fn test_message_to_content_system_role() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::System,
            content: MessageContent::Text("You are helpful".to_string()),
        };

        let content = client.message_to_content(&msg);
        // System messages are converted to user role (system is handled via system_instruction)
        assert_eq!(content.role, Some("user".to_string()));
    }

    #[test]
    fn test_message_to_content_with_blocks() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text {
                    text: "Let me help.".to_string(),
                },
                ContentBlock::Thinking {
                    thinking: "I should analyze this.".to_string(),
                },
            ]),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.role, Some("model".to_string()));
        assert_eq!(content.parts.len(), 2);

        match &content.parts[0] {
            Part::Text { text } => assert_eq!(text, "Let me help."),
            _ => panic!("Expected Text part"),
        }

        match &content.parts[1] {
            Part::Text { text } => assert!(text.contains("<thinking>")),
            _ => panic!("Expected Text part for thinking"),
        }
    }

    #[test]
    fn test_message_to_content_with_tool_use() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                id: "call-123".to_string(),
                name: "read_file".to_string(),
                input: json!({"path": "/tmp/test.txt"}),
            }]),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.parts.len(), 1);

        match &content.parts[0] {
            Part::FunctionCall { function_call } => {
                assert_eq!(function_call.name, "read_file");
                assert_eq!(function_call.args["path"], "/tmp/test.txt");
            }
            _ => panic!("Expected FunctionCall part"),
        }
    }

    #[test]
    fn test_message_to_content_with_tool_result() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let msg = Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "read_file".to_string(),
                content: "file contents here".to_string(),
                is_error: Some(false),
            }]),
        };

        let content = client.message_to_content(&msg);
        assert_eq!(content.parts.len(), 1);

        match &content.parts[0] {
            Part::FunctionResponse { function_response } => {
                assert_eq!(function_response.name, "read_file");
                assert_eq!(function_response.response["result"], "file contents here");
            }
            _ => panic!("Expected FunctionResponse part"),
        }
    }

    #[test]
    fn test_build_request_with_tools() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
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
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert!(request.tools.is_some());
        let tools = request.tools.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].function_declarations.len(), 1);
        assert_eq!(tools[0].function_declarations[0].name, "test");
        assert!(request.system_instruction.is_some());
    }

    #[test]
    fn test_build_request_with_multiple_tools() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            tools: vec![
                Tool::new("read", "Read a file").with_schema(json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}}
                })),
                Tool::new("write", "Write a file").with_schema(json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}}
                })),
            ],
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        let tools = request.tools.unwrap();
        assert_eq!(tools[0].function_declarations.len(), 2);
        assert_eq!(tools[0].function_declarations[0].name, "read");
        assert_eq!(tools[0].function_declarations[1].name, "write");
    }

    #[test]
    fn test_build_request_without_tools() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            tools: vec![],
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert!(request.tools.is_none());
    }

    #[test]
    fn test_build_request_generation_config() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Test".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 2048,
            temperature: Some(0.9),
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        let gen_config = request.generation_config.unwrap();
        assert_eq!(gen_config.max_output_tokens, Some(2048));
        assert_eq!(gen_config.temperature, Some(0.9));
    }

    #[test]
    fn test_build_request_with_system_instruction() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            system: Some("You are a helpful coding assistant.".to_string()),
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert!(request.system_instruction.is_some());
        let sys = request.system_instruction.unwrap();
        assert!(sys.role.is_none()); // system_instruction doesn't have role
        assert_eq!(sys.parts.len(), 1);
        match &sys.parts[0] {
            Part::Text { text } => assert_eq!(text, "You are a helpful coding assistant."),
            _ => panic!("Expected Text part"),
        }
    }

    #[test]
    fn test_build_request_without_system() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![Message {
            role: Role::User,
            content: MessageContent::Text("Hello".to_string()),
        }];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            system: None,
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert!(request.system_instruction.is_none());
    }

    #[test]
    fn test_build_request_multiple_messages() {
        let client = VertexAiClient::new("test", "us-central1", Some("key".to_string()), None);
        let messages = vec![
            Message {
                role: Role::User,
                content: MessageContent::Text("Hello".to_string()),
            },
            Message {
                role: Role::Assistant,
                content: MessageContent::Text("Hi! How can I help?".to_string()),
            },
            Message {
                role: Role::User,
                content: MessageContent::Text("Write some code".to_string()),
            },
        ];

        let config = RequestConfig {
            model: "gemini-2.0-flash".to_string(),
            max_tokens: 1024,
            ..Default::default()
        };

        let request = client.build_request(&messages, &config).unwrap();
        assert_eq!(request.contents.len(), 3);
        assert_eq!(request.contents[0].role, Some("user".to_string()));
        assert_eq!(request.contents[1].role, Some("model".to_string()));
        assert_eq!(request.contents[2].role, Some("user".to_string()));
    }

    #[test]
    fn test_default_region_constant() {
        assert_eq!(DEFAULT_REGION, "us-central1");
    }

    #[test]
    fn test_vertex_response_parsing() {
        let json_str = r#"{
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{"text": "Hello!"}]
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 5
            }
        }"#;

        let response: VertexResponse = serde_json::from_str(json_str).unwrap();
        assert!(response.candidates.is_some());
        let candidates = response.candidates.unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].finish_reason, Some("STOP".to_string()));

        let usage = response.usage_metadata.unwrap();
        assert_eq!(usage.prompt_token_count, Some(10));
        assert_eq!(usage.candidates_token_count, Some(5));
    }

    #[test]
    fn test_vertex_response_with_function_call() {
        let json_str = r#"{
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{
                        "functionCall": {
                            "name": "read_file",
                            "args": {"path": "/tmp/test.txt"}
                        }
                    }]
                },
                "finishReason": "TOOL_USE"
            }]
        }"#;

        let response: VertexResponse = serde_json::from_str(json_str).unwrap();
        let candidates = response.candidates.unwrap();
        assert_eq!(candidates[0].finish_reason, Some("TOOL_USE".to_string()));
    }
}

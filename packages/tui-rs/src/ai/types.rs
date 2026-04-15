//! AI types for messages, tools, and responses

use serde::{Deserialize, Serialize};

/// A message in the conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
}

/// Message role
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// Message content - can be text or structured
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl MessageContent {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            Self::Blocks(blocks) => {
                // Return first text block
                blocks.iter().find_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
            }
        }
    }
}

/// Content block types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        source: ImageSource,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    Thinking {
        thinking: String,
        /// Cryptographic signature for replaying thinking blocks to the API.
        /// This signature is required when sending a conversation with thinking
        /// blocks back to Claude - without it, the API will reject the request.
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
}

/// Image source for vision
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Base64 { media_type: String, data: String },
    Url { url: String },
}

/// Tool definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl Tool {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    #[must_use]
    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.input_schema = schema;
        self
    }
}

/// Streaming event from the AI
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Message started
    MessageStart { id: String, model: String },
    /// Content block started
    ContentBlockStart { index: usize, block: ContentBlock },
    /// Text delta
    TextDelta { index: usize, text: String },
    /// Thinking delta
    ThinkingDelta { index: usize, thinking: String },
    /// Tool use input delta (JSON string chunk)
    InputJsonDelta { index: usize, partial_json: String },
    /// Thinking block signature (required for replaying thinking to API)
    ThinkingSignature { index: usize, signature: String },
    /// Content block completed
    ContentBlockStop {
        index: usize,
        /// Signature for thinking blocks (captured from `signature_delta`)
        thinking_signature: Option<String>,
    },
    /// Message completed
    MessageStop {
        /// Stop reason from the API (`MaxTokens` indicates overflow)
        stop_reason: Option<StopReason>,
    },
    /// Usage stats
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: Option<u64>,
        cache_creation_tokens: Option<u64>,
    },
    /// Error occurred
    Error { message: String },
}

/// Request configuration
#[derive(Debug, Clone)]
pub struct RequestConfig {
    pub model: String,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub system: Option<String>,
    pub tools: Vec<Tool>,
    pub thinking: Option<ThinkingConfig>,
    /// Enable prompt caching for system prompt (Anthropic only)
    /// When true, the system prompt will be marked for caching
    pub cache_system_prompt: bool,
}

impl Default for RequestConfig {
    fn default() -> Self {
        Self {
            model: "claude-sonnet-4-20250514".to_string(),
            max_tokens: 8192,
            temperature: None,
            system: None,
            tools: Vec::new(),
            thinking: None,
            cache_system_prompt: false,
        }
    }
}

/// Extended thinking configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingConfig {
    #[serde(rename = "type")]
    pub thinking_type: String,
    pub budget_tokens: u32,
}

impl ThinkingConfig {
    #[must_use]
    pub fn enabled(budget_tokens: u32) -> Self {
        Self {
            thinking_type: "enabled".to_string(),
            budget_tokens,
        }
    }
}

/// Stop reason from the API
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    StopSequence,
    ToolUse,
}

/// Token usage statistics
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl Usage {
    #[must_use]
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ========================================================================
    // Role Tests
    // ========================================================================

    #[test]
    fn test_role_serialization() {
        assert_eq!(serde_json::to_string(&Role::User).unwrap(), "\"user\"");
        assert_eq!(
            serde_json::to_string(&Role::Assistant).unwrap(),
            "\"assistant\""
        );
        assert_eq!(serde_json::to_string(&Role::System).unwrap(), "\"system\"");
    }

    #[test]
    fn test_role_deserialization() {
        assert_eq!(
            serde_json::from_str::<Role>("\"user\"").unwrap(),
            Role::User
        );
        assert_eq!(
            serde_json::from_str::<Role>("\"assistant\"").unwrap(),
            Role::Assistant
        );
        assert_eq!(
            serde_json::from_str::<Role>("\"system\"").unwrap(),
            Role::System
        );
    }

    // ========================================================================
    // MessageContent Tests
    // ========================================================================

    #[test]
    fn test_message_content_text() {
        let content = MessageContent::text("Hello, world!");
        assert_eq!(content.as_text(), Some("Hello, world!"));
    }

    #[test]
    fn test_message_content_blocks_with_text() {
        let content = MessageContent::Blocks(vec![ContentBlock::Text {
            text: "Block text".to_string(),
        }]);
        assert_eq!(content.as_text(), Some("Block text"));
    }

    #[test]
    fn test_message_content_blocks_no_text() {
        let content = MessageContent::Blocks(vec![ContentBlock::ToolUse {
            id: "tool-1".to_string(),
            name: "read".to_string(),
            input: json!({"path": "/tmp/test"}),
        }]);
        assert_eq!(content.as_text(), None);
    }

    #[test]
    fn test_message_content_blocks_finds_first_text() {
        let content = MessageContent::Blocks(vec![
            ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read".to_string(),
                input: json!({}),
            },
            ContentBlock::Text {
                text: "First text".to_string(),
            },
            ContentBlock::Text {
                text: "Second text".to_string(),
            },
        ]);
        assert_eq!(content.as_text(), Some("First text"));
    }

    // ========================================================================
    // Tool Tests
    // ========================================================================

    #[test]
    fn test_tool_new() {
        let tool = Tool::new("read", "Read a file");
        assert_eq!(tool.name, "read");
        assert_eq!(tool.description, "Read a file");
        assert_eq!(tool.input_schema["type"], "object");
    }

    #[test]
    fn test_tool_with_schema() {
        let schema = json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        });
        let tool = Tool::new("read", "Read a file").with_schema(schema.clone());
        assert_eq!(tool.input_schema, schema);
    }

    // ========================================================================
    // ThinkingConfig Tests
    // ========================================================================

    #[test]
    fn test_thinking_config_enabled() {
        let config = ThinkingConfig::enabled(4096);
        assert_eq!(config.thinking_type, "enabled");
        assert_eq!(config.budget_tokens, 4096);
    }

    // ========================================================================
    // StopReason Tests
    // ========================================================================

    #[test]
    fn test_stop_reason_serialization() {
        assert_eq!(
            serde_json::to_string(&StopReason::EndTurn).unwrap(),
            "\"end_turn\""
        );
        assert_eq!(
            serde_json::to_string(&StopReason::MaxTokens).unwrap(),
            "\"max_tokens\""
        );
        assert_eq!(
            serde_json::to_string(&StopReason::ToolUse).unwrap(),
            "\"tool_use\""
        );
    }

    // ========================================================================
    // Usage Tests
    // ========================================================================

    #[test]
    fn test_usage_total_tokens() {
        let usage = Usage {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        };
        assert_eq!(usage.total_tokens(), 150);
    }

    #[test]
    fn test_usage_default() {
        let usage = Usage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens(), 0);
    }

    // ========================================================================
    // RequestConfig Tests
    // ========================================================================

    #[test]
    fn test_request_config_default() {
        let config = RequestConfig::default();
        assert_eq!(config.model, "claude-sonnet-4-20250514");
        assert_eq!(config.max_tokens, 8192);
        assert!(config.temperature.is_none());
        assert!(config.system.is_none());
        assert!(config.tools.is_empty());
        assert!(config.thinking.is_none());
        assert!(!config.cache_system_prompt);
    }

    // ========================================================================
    // ContentBlock Serialization Tests
    // ========================================================================

    #[test]
    fn test_content_block_text_serialization() {
        let block = ContentBlock::Text {
            text: "Hello".to_string(),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "text");
        assert_eq!(json["text"], "Hello");
    }

    #[test]
    fn test_content_block_tool_use_serialization() {
        let block = ContentBlock::ToolUse {
            id: "tool-123".to_string(),
            name: "bash".to_string(),
            input: json!({"command": "ls"}),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "tool_use");
        assert_eq!(json["id"], "tool-123");
        assert_eq!(json["name"], "bash");
        assert_eq!(json["input"]["command"], "ls");
    }

    #[test]
    fn test_content_block_thinking_serialization() {
        let block = ContentBlock::Thinking {
            thinking: "Let me think...".to_string(),
            signature: Some("sig123".to_string()),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "thinking");
        assert_eq!(json["thinking"], "Let me think...");
        assert_eq!(json["signature"], "sig123");
    }

    #[test]
    fn test_content_block_thinking_without_signature() {
        let block = ContentBlock::Thinking {
            thinking: "Let me think...".to_string(),
            signature: None,
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "thinking");
        assert!(json.get("signature").is_none());
    }
}

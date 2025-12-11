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
    /// Content block completed
    ContentBlockStop { index: usize },
    /// Message completed
    MessageStop {
        /// Stop reason from the API (MaxTokens indicates overflow)
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
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

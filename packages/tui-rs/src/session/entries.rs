//! Session entry types
//!
//! Defines the JSONL format for session persistence.

use serde::{Deserialize, Serialize};

/// A session entry in JSONL format
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEntry {
    /// Session header (first entry)
    Session(SessionHeader),
    /// A conversation message
    Message(MessageEntry),
    /// Thinking level change
    ThinkingLevelChange(ThinkingLevelChange),
    /// Model change
    ModelChange(ModelChange),
    /// Session metadata update
    SessionMeta(SessionMeta),
    /// Context compaction event
    Compaction(CompactionEntry),
}

/// Session header entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHeader {
    /// Unique session ID (UUID)
    pub id: String,
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Working directory
    pub cwd: String,
    /// Model identifier (provider/modelId format)
    pub model: String,
    /// Model metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<ModelMetadata>,
    /// Thinking level
    #[serde(default)]
    pub thinking_level: ThinkingLevel,
    /// Custom system prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Available tools
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolInfo>,
    /// Parent session if branched
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branched_from: Option<String>,
}

/// Model metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMetadata {
    pub provider: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Tool information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Thinking level
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    Max,
}

impl ThinkingLevel {
    pub fn label(&self) -> &'static str {
        match self {
            ThinkingLevel::Off => "Off",
            ThinkingLevel::Minimal => "Minimal",
            ThinkingLevel::Low => "Low",
            ThinkingLevel::Medium => "Medium",
            ThinkingLevel::High => "High",
            ThinkingLevel::Max => "Max",
        }
    }

    /// Convert to (enabled, budget) configuration
    pub fn to_config(&self) -> (bool, u32) {
        match self {
            ThinkingLevel::Off => (false, 0),
            ThinkingLevel::Minimal => (true, 1024),
            ThinkingLevel::Low => (true, 4096),
            ThinkingLevel::Medium => (true, 10000),
            ThinkingLevel::High => (true, 20000),
            ThinkingLevel::Max => (true, 50000),
        }
    }

    /// Parse from string
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "off" | "none" | "disabled" => Some(ThinkingLevel::Off),
            "minimal" | "min" => Some(ThinkingLevel::Minimal),
            "low" => Some(ThinkingLevel::Low),
            "medium" | "med" | "default" => Some(ThinkingLevel::Medium),
            "high" => Some(ThinkingLevel::High),
            "max" | "maximum" => Some(ThinkingLevel::Max),
            _ => None,
        }
    }
}

/// A message entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEntry {
    pub timestamp: String,
    pub message: AppMessage,
}

/// An application message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AppMessage {
    /// User message
    User {
        content: MessageContent,
        #[serde(default)]
        timestamp: u64,
    },
    /// Assistant message
    Assistant {
        content: Vec<ContentBlock>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        #[serde(default)]
        timestamp: u64,
    },
    /// Tool result
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        timestamp: u64,
    },
}

impl AppMessage {
    /// Get the role of this message
    pub fn role(&self) -> &'static str {
        match self {
            AppMessage::User { .. } => "user",
            AppMessage::Assistant { .. } => "assistant",
            AppMessage::ToolResult { .. } => "toolResult",
        }
    }

    /// Get the timestamp
    pub fn timestamp(&self) -> u64 {
        match self {
            AppMessage::User { timestamp, .. } => *timestamp,
            AppMessage::Assistant { timestamp, .. } => *timestamp,
            AppMessage::ToolResult { timestamp, .. } => *timestamp,
        }
    }

    /// Get text content (for display)
    pub fn text_content(&self) -> String {
        match self {
            AppMessage::User { content, .. } => match content {
                MessageContent::Text(s) => s.clone(),
                MessageContent::Blocks(blocks) => blocks
                    .iter()
                    .filter_map(|b| {
                        if let ContentBlock::Text { text } = b {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            },
            AppMessage::Assistant { content, .. } => content
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text } = b {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(""),
            AppMessage::ToolResult { content, .. } => content.clone(),
        }
    }
}

/// Message content (can be string or blocks)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// Content block types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text
    Text { text: String },
    /// Thinking content
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Tool call
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Image (base64)
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<ImageSource>,
    },
}

/// Image source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub media_type: String,
    pub data: String,
}

/// Token usage statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default, rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(default, rename = "cacheWrite")]
    pub cache_write: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<TokenCost>,
}

impl TokenUsage {
    pub fn total(&self) -> u64 {
        self.input + self.output
    }

    pub fn total_cost(&self) -> f64 {
        self.cost.as_ref().map(|c| c.total).unwrap_or(0.0)
    }
}

/// Token cost breakdown
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(default, rename = "cacheRead")]
    pub cache_read: f64,
    #[serde(default, rename = "cacheWrite")]
    pub cache_write: f64,
    #[serde(default)]
    pub total: f64,
}

/// Thinking level change entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingLevelChange {
    pub timestamp: String,
    pub thinking_level: ThinkingLevel,
}

/// Model change entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelChange {
    pub timestamp: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<ModelMetadata>,
}

/// Session metadata entry
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionMeta {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

/// Context compaction entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionEntry {
    pub timestamp: String,
    pub summary: String,
    pub first_kept_entry_index: usize,
    pub tokens_before: u64,
    #[serde(default)]
    pub auto: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
}

/// Aggregated session statistics
#[derive(Debug, Clone, Default)]
pub struct SessionStats {
    pub user_messages: usize,
    pub assistant_messages: usize,
    pub tool_calls: usize,
    pub tool_results: usize,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost: f64,
}

impl SessionStats {
    pub fn total_messages(&self) -> usize {
        self.user_messages + self.assistant_messages + self.tool_results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_header() {
        let json = r#"{"type":"session","id":"abc123","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"anthropic/claude-3","thinking_level":"medium"}"#;
        let entry: SessionEntry = serde_json::from_str(json).unwrap();
        match entry {
            SessionEntry::Session(header) => {
                assert_eq!(header.id, "abc123");
                assert_eq!(header.cwd, "/tmp");
            }
            _ => panic!("Expected Session entry"),
        }
    }

    #[test]
    fn parse_user_message() {
        let json = r#"{"type":"message","timestamp":"2024-01-15T10:30:00Z","message":{"role":"user","content":"Hello","timestamp":0}}"#;
        let entry: SessionEntry = serde_json::from_str(json).unwrap();
        match entry {
            SessionEntry::Message(msg) => {
                assert_eq!(msg.message.role(), "user");
            }
            _ => panic!("Expected Message entry"),
        }
    }

    #[test]
    fn parse_assistant_message() {
        let json = r#"{"type":"message","timestamp":"2024-01-15T10:30:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"timestamp":0}}"#;
        let entry: SessionEntry = serde_json::from_str(json).unwrap();
        match entry {
            SessionEntry::Message(msg) => {
                assert_eq!(msg.message.role(), "assistant");
                assert_eq!(msg.message.text_content(), "Hi there!");
            }
            _ => panic!("Expected Message entry"),
        }
    }

    #[test]
    fn thinking_level_serialize() {
        assert_eq!(
            serde_json::to_string(&ThinkingLevel::High).unwrap(),
            "\"high\""
        );
    }

    #[test]
    fn token_usage_total() {
        let usage = TokenUsage {
            input: 100,
            output: 50,
            ..Default::default()
        };
        assert_eq!(usage.total(), 150);
    }
}

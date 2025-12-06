//! Native Rust agent
//!
//! A fully native agent implementation that communicates directly with AI providers.
//! Replaces the Node.js subprocess architecture with pure Rust.

use std::collections::HashMap;

use anyhow::Result;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::{FromAgent, TokenUsage, ToolResult};
use crate::ai::{
    ContentBlock, Message, MessageContent, RequestConfig, Role, StreamEvent, Tool,
    ThinkingConfig, UnifiedClient,
};

/// Configuration for the native agent
#[derive(Debug, Clone)]
pub struct NativeAgentConfig {
    /// Model to use (e.g., "claude-opus-4-5-20251101", "gpt-5.1-codex-max")
    pub model: String,
    /// Maximum tokens for responses
    pub max_tokens: u32,
    /// System prompt
    pub system_prompt: Option<String>,
    /// Whether extended thinking is enabled
    pub thinking_enabled: bool,
    /// Token budget for thinking (if enabled)
    pub thinking_budget: u32,
    /// Current working directory
    pub cwd: String,
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        Self {
            model: "claude-sonnet-4-5-20250514".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: false,
            thinking_budget: 10000,
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
        }
    }
}

/// Tool definition with execution handler
pub struct ToolDefinition {
    /// Tool metadata for the AI
    pub tool: Tool,
    /// Whether this tool requires user approval
    pub requires_approval: bool,
}

/// The native agent orchestrator
pub struct NativeAgent {
    /// AI client
    client: UnifiedClient,
    /// Configuration
    config: NativeAgentConfig,
    /// Conversation history
    messages: Vec<Message>,
    /// Tool definitions
    tools: HashMap<String, ToolDefinition>,
    /// Channel to send events to the TUI
    event_tx: mpsc::UnboundedSender<FromAgent>,
    /// Channel to receive tool responses from the TUI
    tool_response_rx: mpsc::UnboundedReceiver<(String, bool, Option<ToolResult>)>,
    /// Sender for tool responses (kept for creating receivers)
    tool_response_tx: mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>,
    /// Whether the agent is currently processing
    busy: bool,
    /// Current session ID
    session_id: Option<String>,
}

impl NativeAgent {
    /// Create a new native agent
    pub fn new(config: NativeAgentConfig) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let client = UnifiedClient::from_model(&config.model)?;
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, tool_response_rx) = mpsc::unbounded_channel();

        let agent = Self {
            client,
            config,
            messages: Vec::new(),
            tools: HashMap::new(),
            event_tx,
            tool_response_rx,
            tool_response_tx,
            busy: false,
            session_id: None,
        };

        Ok((agent, event_rx))
    }

    /// Get the sender for tool responses
    pub fn tool_response_sender(
        &self,
    ) -> mpsc::UnboundedSender<(String, bool, Option<ToolResult>)> {
        self.tool_response_tx.clone()
    }

    /// Register a tool
    pub fn register_tool(&mut self, name: impl Into<String>, def: ToolDefinition) {
        self.tools.insert(name.into(), def);
    }

    /// Set the session ID
    pub fn set_session_id(&mut self, id: Option<String>) {
        self.session_id = id.clone();
        let _ = self.event_tx.send(FromAgent::SessionInfo {
            session_id: id,
            cwd: self.config.cwd.clone(),
            git_branch: None, // TODO: detect git branch
        });
    }

    /// Send the ready event
    pub fn send_ready(&self) {
        let provider = format!("{:?}", self.client.provider());
        let _ = self.event_tx.send(FromAgent::Ready {
            model: self.config.model.clone(),
            provider,
        });
    }

    /// Check if the agent is busy
    pub fn is_busy(&self) -> bool {
        self.busy
    }

    /// Clear conversation history
    pub fn clear_history(&mut self) {
        self.messages.clear();
    }

    /// Get the current model
    pub fn model(&self) -> &str {
        &self.config.model
    }

    /// Set the model
    pub fn set_model(&mut self, model: impl Into<String>) -> Result<()> {
        let model = model.into();
        self.client = UnifiedClient::from_model(&model)?;
        self.config.model = model;
        Ok(())
    }

    /// Build request configuration
    fn build_config(&self) -> RequestConfig {
        let tools: Vec<Tool> = self.tools.values().map(|d| d.tool.clone()).collect();

        let thinking = if self.config.thinking_enabled {
            Some(ThinkingConfig::enabled(self.config.thinking_budget))
        } else {
            None
        };

        RequestConfig {
            model: self.config.model.clone(),
            max_tokens: self.config.max_tokens,
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system: self.config.system_prompt.clone(),
            tools,
            thinking,
        }
    }

    /// Process a user prompt
    pub async fn prompt(&mut self, content: String, _attachments: Vec<String>) -> Result<()> {
        if self.busy {
            let _ = self.event_tx.send(FromAgent::Error {
                message: "Agent is busy".to_string(),
                fatal: false,
            });
            return Ok(());
        }

        self.busy = true;

        // Add user message to history
        self.messages.push(Message {
            role: Role::User,
            content: MessageContent::text(content),
        });

        // Run the agent loop
        self.run_loop().await?;

        self.busy = false;
        Ok(())
    }

    /// Run the agent loop until complete or interrupted
    async fn run_loop(&mut self) -> Result<()> {
        loop {
            let response_id = Uuid::new_v4().to_string();

            // Signal response start
            let _ = self.event_tx.send(FromAgent::ResponseStart {
                response_id: response_id.clone(),
            });

            // Make the API call
            let config = self.build_config();
            let mut rx = self.client.stream(&self.messages, &config).await?;

            // Collect the response
            let mut assistant_content: Vec<ContentBlock> = Vec::new();
            let mut current_text = String::new();
            let mut current_thinking = String::new();
            let mut current_tool: Option<(String, String, String)> = None; // (id, name, json)
            let mut usage = TokenUsage::default();
            let mut pending_tool_calls: Vec<(String, String, serde_json::Value)> = Vec::new();

            // Process stream events
            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::MessageStart { .. } => {}
                    StreamEvent::ContentBlockStart { index: _, block } => {
                        match &block {
                            ContentBlock::Text { text } => {
                                current_text = text.clone();
                            }
                            ContentBlock::Thinking { thinking } => {
                                current_thinking = thinking.clone();
                            }
                            ContentBlock::ToolUse { id, name, .. } => {
                                current_tool = Some((id.clone(), name.clone(), String::new()));
                            }
                            _ => {}
                        }
                    }
                    StreamEvent::TextDelta { text, .. } => {
                        current_text.push_str(&text);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: text,
                            is_thinking: false,
                        });
                    }
                    StreamEvent::ThinkingDelta { thinking, .. } => {
                        current_thinking.push_str(&thinking);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: thinking,
                            is_thinking: true,
                        });
                    }
                    StreamEvent::InputJsonDelta { partial_json, .. } => {
                        if let Some((_, _, ref mut json)) = current_tool {
                            json.push_str(&partial_json);
                        }
                    }
                    StreamEvent::ContentBlockStop { index: _ } => {
                        // Finalize current content block
                        if !current_text.is_empty() {
                            assistant_content.push(ContentBlock::Text {
                                text: std::mem::take(&mut current_text),
                            });
                        }
                        if !current_thinking.is_empty() {
                            assistant_content.push(ContentBlock::Thinking {
                                thinking: std::mem::take(&mut current_thinking),
                            });
                        }
                        if let Some((id, name, json)) = current_tool.take() {
                            let input: serde_json::Value =
                                serde_json::from_str(&json).unwrap_or(serde_json::json!({}));
                            assistant_content.push(ContentBlock::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            });
                            pending_tool_calls.push((id, name, input));
                        }
                    }
                    StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    } => {
                        usage.input_tokens = input_tokens;
                        usage.output_tokens = output_tokens;
                        usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                    }
                    StreamEvent::MessageStop => {
                        break;
                    }
                    StreamEvent::Error { message } => {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message,
                            fatal: false,
                        });
                        break;
                    }
                }
            }

            // Add assistant message to history
            if !assistant_content.is_empty() {
                self.messages.push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Blocks(assistant_content),
                });
            }

            // Signal response end
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: Some(usage),
            });

            // If there are tool calls, handle them
            if !pending_tool_calls.is_empty() {
                let mut tool_results: Vec<ContentBlock> = Vec::new();

                for (call_id, tool_name, args) in pending_tool_calls {
                    // Check if this tool requires approval
                    let requires_approval = self
                        .tools
                        .get(&tool_name)
                        .map(|d| d.requires_approval)
                        .unwrap_or(true); // Default to requiring approval

                    // Send tool call event
                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: tool_name.clone(),
                        args: args.clone(),
                        requires_approval,
                    });

                    // If requires approval, wait for response
                    let (approved, result) = if requires_approval {
                        // Wait for tool response from TUI
                        match self.tool_response_rx.recv().await {
                            Some((id, approved, result)) if id == call_id => (approved, result),
                            Some(_) => {
                                // Wrong call_id, treat as not approved
                                (false, None)
                            }
                            None => {
                                // Channel closed
                                return Ok(());
                            }
                        }
                    } else {
                        // Auto-approved, execute immediately
                        let _ = self.event_tx.send(FromAgent::ToolStart {
                            call_id: call_id.clone(),
                        });

                        let result = self.execute_tool(&tool_name, &args).await;

                        let _ = self.event_tx.send(FromAgent::ToolEnd {
                            call_id: call_id.clone(),
                            success: result.success,
                        });

                        (true, Some(result))
                    };

                    // Build tool result for conversation
                    let result_content = if approved {
                        if let Some(res) = result {
                            if res.success {
                                res.output
                            } else {
                                format!("Error: {}", res.error.unwrap_or_default())
                            }
                        } else {
                            "Tool executed successfully".to_string()
                        }
                    } else {
                        "Tool call was denied by user".to_string()
                    };

                    tool_results.push(ContentBlock::ToolResult {
                        tool_use_id: call_id,
                        content: result_content,
                        is_error: Some(!approved),
                    });
                }

                // Add tool results to history
                self.messages.push(Message {
                    role: Role::User,
                    content: MessageContent::Blocks(tool_results),
                });

                // Continue the loop to process the tool results
                continue;
            }

            // No tool calls, we're done
            break;
        }

        Ok(())
    }

    /// Execute a tool (placeholder - tools will be implemented separately)
    async fn execute_tool(&self, tool_name: &str, args: &serde_json::Value) -> ToolResult {
        // This is a placeholder - actual tool implementations will be in tools module
        match tool_name {
            "bash" => {
                // Will be implemented in tools module
                ToolResult {
                    success: false,
                    output: String::new(),
                    error: Some("Bash tool not yet implemented".to_string()),
                }
            }
            "read" => ToolResult {
                success: false,
                output: String::new(),
                error: Some("Read tool not yet implemented".to_string()),
            },
            _ => ToolResult {
                success: false,
                output: String::new(),
                error: Some(format!("Unknown tool: {}", tool_name)),
            },
        }
    }

    /// Cancel the current operation
    pub fn cancel(&mut self) {
        // For now, just reset busy flag
        // TODO: Implement proper cancellation with tokio cancellation tokens
        self.busy = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = NativeAgentConfig::default();
        assert!(config.model.starts_with("claude"));
        assert_eq!(config.max_tokens, 16384);
        assert!(!config.thinking_enabled);
    }

    #[test]
    fn test_config_with_custom_model() {
        let config = NativeAgentConfig {
            model: "gpt-5.1-codex-max".to_string(),
            max_tokens: 8192,
            system_prompt: Some("You are a helpful assistant.".to_string()),
            thinking_enabled: true,
            thinking_budget: 5000,
            cwd: "/tmp".to_string(),
        };
        assert_eq!(config.model, "gpt-5.1-codex-max");
        assert_eq!(config.max_tokens, 8192);
        assert!(config.thinking_enabled);
        assert_eq!(config.thinking_budget, 5000);
    }

    #[test]
    fn test_thinking_config() {
        let thinking = ThinkingConfig::enabled(10000);
        assert_eq!(thinking.thinking_type, "enabled");
        assert_eq!(thinking.budget_tokens, 10000);
    }
}

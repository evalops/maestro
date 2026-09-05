//! Estimates from the request built by the runtime, never from all registered tools.
use super::compaction::TokenCounter;
use crate::ai::{ContentBlock, Message, MessageContent, RequestConfig};

#[derive(Debug, Clone, Default)]
pub(crate) struct RequestContextUsage {
    pub model: String,
    pub system: u64,
    pub conversation: u64,
    pub tool_results: u64,
    pub other: u64,
    pub tools: Vec<(String, u64)>,
}

impl RequestContextUsage {
    pub(crate) fn from_request(
        messages: &[Message],
        config: &RequestConfig,
        counter: &TokenCounter,
    ) -> Self {
        let count = |text: &str| counter.count(text);
        let mut usage = Self {
            model: config.model.clone(),
            system: config.system.as_deref().map_or(0, count),
            tools: config
                .tools
                .iter()
                .map(|tool| {
                    (
                        tool.name.clone(),
                        count(&serde_json::to_string(tool).unwrap_or_default()),
                    )
                })
                .collect(),
            ..Self::default()
        };
        for message in messages {
            match &message.content {
                MessageContent::Text(text) => usage.conversation += count(text),
                MessageContent::Blocks(blocks) => {
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => usage.conversation += count(text),
                            ContentBlock::Thinking { thinking, .. } => {
                                usage.other += count(thinking);
                            }
                            ContentBlock::ToolUse { name, input, .. } => {
                                usage.tool_results += count(name) + count(&input.to_string());
                            }
                            ContentBlock::ToolResult { content, .. } => {
                                usage.tool_results += count(content);
                            }
                            ContentBlock::Image { .. } => {
                                usage.other += super::token_estimation::IMAGE_TOKEN_ESTIMATE;
                            }
                        }
                    }
                }
            }
        }
        usage
            .tools
            .sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        usage
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::Tool;
    use std::sync::Arc;

    #[test]
    fn reports_only_schemas_in_the_prepared_request() {
        let tool = Tool::new("fixture_integration", "large optional schema")
            .with_schema(serde_json::json!({"description": "schema ".repeat(4000)}));
        let mut config = RequestConfig {
            tools: Arc::new(vec![tool]),
            ..Default::default()
        };
        let counter = TokenCounter::new(Some(config.model.clone()));
        let with_tool = RequestContextUsage::from_request(&[], &config, &counter);
        assert_eq!(with_tool.tools.len(), 1);
        assert!(with_tool.tools[0].1 > 1000);
        config.tools = Arc::new(Vec::new());
        let without_tool = RequestContextUsage::from_request(&[], &config, &counter);
        assert!(without_tool.tools.is_empty());
        assert_eq!(without_tool.system, with_tool.system);
    }
}

//! TUI history repair for caller-owned tool responses.

use std::collections::HashSet;

use super::super::{DenialReason, ToolExecution, ToolResult};
use crate::ai::{ContentBlock, Message, MessageContent, Role};
use maestro_runtime::ToolResponseCoordinator;

/// Append failure tool results for any assistant `ToolUse` block in `messages`
/// that has no matching `ToolResult`, so an interrupted turn can never leave
/// the history with orphaned tool calls.
///
/// Repairs are grouped into the user message that already carries results for
/// the same assistant message when one exists, otherwise inserted immediately
/// after it, keeping the `ToolUse`/`ToolResult` pairing both the OpenAI and
/// Anthropic serializers require. A real result delivered late (stashed in
/// the shared coordinator) is used when available; otherwise a
/// "cancelled by user" failure is synthesized.
pub(super) fn repair_orphaned_tool_calls(
    messages: &mut Vec<Message>,
    tool_response_coordinator: &mut ToolResponseCoordinator,
) {
    tool_response_coordinator.drain_available();
    let mut answered: HashSet<String> = HashSet::new();
    for message in messages.iter() {
        if let MessageContent::Blocks(blocks) = &message.content {
            for block in blocks {
                if let ContentBlock::ToolResult { tool_use_id, .. } = block {
                    answered.insert(tool_use_id.clone());
                }
            }
        }
    }

    let mut index = 0;
    while index < messages.len() {
        let missing: Vec<(String, String)> = match &messages[index] {
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(blocks),
            } => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, .. } if !answered.contains(id) => {
                        Some((id.clone(), name.clone()))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };

        if missing.is_empty() {
            index += 1;
            continue;
        }

        let repairs: Vec<ContentBlock> = missing
            .into_iter()
            .map(|(id, name)| {
                let pending = tool_response_coordinator.take_pending_for_repair(&id);
                let (content, is_error) = match pending {
                    Some((approved, result, source)) => {
                        let execution = if approved {
                            ToolExecution::from_legacy(
                                &id,
                                &name,
                                source,
                                result.unwrap_or_else(|| {
                                    ToolResult::failure("Tool task did not return a result")
                                }),
                            )
                        } else {
                            ToolExecution::denied(&id, &name, DenialReason::User)
                        };
                        (execution.model_content(), execution.is_error())
                    }
                    None => ("Tool execution cancelled by user.".to_string(), true),
                };
                answered.insert(id.clone());
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    content,
                    is_error: Some(is_error),
                }
            })
            .collect();

        // Merge into the existing tool-result message when one already
        // follows this assistant message; otherwise insert a new one.
        let merge_target = match messages.get_mut(index + 1) {
            Some(Message {
                role: Role::User,
                content: MessageContent::Blocks(blocks),
            }) if blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolResult { .. })) =>
            {
                Some(blocks)
            }
            _ => None,
        };
        match merge_target {
            Some(blocks) => blocks.extend(repairs),
            None => messages.insert(
                index + 1,
                Message {
                    role: Role::User,
                    content: MessageContent::Blocks(repairs),
                },
            ),
        }
        index += 2;
    }
}

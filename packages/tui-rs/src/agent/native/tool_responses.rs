//! Tool-approval response buffering and cancellation repair for the native agent.

use std::collections::{HashMap, HashSet};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::{DenialReason, ExecutionSource, ToolExecution, ToolResult};
use super::{
    CancelledToolTombstones, PendingToolResponse, ToolResponseConsumption, ToolResponseMessage,
};
use crate::ai::{ContentBlock, Message, MessageContent, Role};

pub(super) fn discard_cancelled_tool_responses(
    cancelled_ids: &HashSet<String>,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &mut CancelledToolTombstones,
) {
    for call_id in cancelled_ids {
        tombstones.insert(call_id.clone());
    }
    let pending_cancelled = pending
        .keys()
        .filter(|call_id| cancelled_ids.contains(*call_id))
        .cloned()
        .collect::<Vec<_>>();
    for call_id in pending_cancelled {
        if let Some((_, _, _, Some(consumed))) = pending.remove(&call_id) {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    }
    while let Ok((call_id, approved, result, source, consumed)) = rx.try_recv() {
        if tombstones.contains(&call_id) {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response cancelled before native consumption".to_string(),
                });
            }
        } else {
            pending.insert(call_id, (approved, result, source, consumed));
        }
    }
}

pub(super) fn reject_buffered_tool_responses_on_cancel(
    pending: &mut HashMap<String, PendingToolResponse>,
) {
    for (_, _, _, consumed) in pending.drain().map(|(_, value)| value) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    }
}

pub(super) fn buffer_or_reject_tool_response(
    response: ToolResponseMessage,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
) {
    let (call_id, approved, result, source, consumed) = response;
    if tombstones.contains(&call_id) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Rejected {
                reason: "tool response cancelled before native consumption".to_string(),
            });
        }
    } else {
        pending.insert(call_id, (approved, result, source, consumed));
    }
}

pub(super) enum ToolResponseWait {
    Response((bool, Option<ToolResult>, ExecutionSource)),
    Cancelled,
    Closed,
}

pub(super) async fn wait_for_codex_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
    cancel: &CancellationToken,
) -> ToolResponseWait {
    wait_for_tool_response(call_id, rx, pending, tombstones, cancel).await
}

pub(super) async fn wait_for_tool_response(
    call_id: &str,
    rx: &mut mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: &mut HashMap<String, PendingToolResponse>,
    tombstones: &CancelledToolTombstones,
    cancel: &CancellationToken,
) -> ToolResponseWait {
    if cancel.is_cancelled() {
        return ToolResponseWait::Cancelled;
    }
    if let Some((approved, result, source, consumed)) = pending.remove(call_id) {
        if let Some(consumed) = consumed {
            let _ = consumed.send(ToolResponseConsumption::Accepted);
        }
        return ToolResponseWait::Response((approved, result, source));
    }

    loop {
        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => return ToolResponseWait::Cancelled,
            response = rx.recv() => response,
        };
        let Some((id, approved, result, source, consumed)) = response else {
            return ToolResponseWait::Closed;
        };
        if tombstones.contains(&id) {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Rejected {
                    reason: "tool response cancelled before native consumption".to_string(),
                });
            }
            continue;
        }
        if id == call_id {
            if let Some(consumed) = consumed {
                let _ = consumed.send(ToolResponseConsumption::Accepted);
            }
            return ToolResponseWait::Response((approved, result, source));
        }
        pending.insert(id, (approved, result, source, consumed));
    }
}

/// Append failure tool results for any assistant `ToolUse` block in `messages`
/// that has no matching `ToolResult`, so an interrupted turn can never leave
/// the history with orphaned tool calls.
///
/// Repairs are grouped into the user message that already carries results for
/// the same assistant message when one exists, otherwise inserted immediately
/// after it, keeping the `ToolUse`/`ToolResult` pairing both the OpenAI and
/// Anthropic serializers require. A real result delivered late (stashed in
/// `pending_tool_approvals`) is used when available; otherwise a
/// "cancelled by user" failure is synthesized.
pub(super) fn repair_orphaned_tool_calls(
    messages: &mut Vec<Message>,
    pending_tool_approvals: &mut HashMap<String, PendingToolResponse>,
) {
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
                let pending = pending_tool_approvals.remove(&id).map(
                    |(approved, result, source, consumed)| {
                        if let Some(consumed) = consumed {
                            let _ = consumed.send(ToolResponseConsumption::Accepted);
                        }
                        (approved, result, source)
                    },
                );
                let (content, is_error) = match pending {
                    Some((true, Some(result), source)) => {
                        let execution = ToolExecution::from_legacy(&id, &name, source, result);
                        (execution.model_content(), execution.is_error())
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_responses_buffers_open_call_responses() {
        let mut pending = HashMap::new();
        let tombstones = super::super::CancelledToolTombstones::default();
        buffer_or_reject_tool_response(
            (
                "call_1".to_string(),
                true,
                None,
                ExecutionSource::Native,
                None,
            ),
            &mut pending,
            &tombstones,
        );

        assert!(matches!(
            pending.remove("call_1"),
            Some((true, None, ExecutionSource::Native, None))
        ));
    }
}

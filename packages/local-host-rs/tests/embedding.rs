use std::time::Duration;

use maestro_local_host::agent::{FromAgent, ToolDefinition, ToolResult};
use maestro_local_host::ai::{
    ContentBlock, MessageContent, ScriptedBlock, ScriptedResponse, StopReason, Tool,
};
use maestro_local_host::embedding::{
    EmbeddedAgentSession, EmbeddedToolResponse, test_kit::ScriptedEmbeddingBuilder,
};

async fn next_event_matching(
    session: &mut EmbeddedAgentSession,
    predicate: impl Fn(&FromAgent) -> bool,
) -> FromAgent {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = session
                .events()
                .recv()
                .await
                .expect("embedding event stream should stay open");
            if predicate(&event) {
                return event;
            }
        }
    })
    .await
    .expect("expected embedding event before timeout")
}

async fn events_through_completion(session: &mut EmbeddedAgentSession) -> Vec<FromAgent> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut events = Vec::new();
        loop {
            let event = session
                .events()
                .recv()
                .await
                .expect("embedding event stream should stay open");
            let completed = matches!(event, FromAgent::TurnCompleted { .. });
            events.push(event);
            if completed {
                return events;
            }
        }
    })
    .await
    .expect("expected embedding completion before timeout")
}

fn caller_owned_tool() -> ToolDefinition {
    ToolDefinition {
        tool: Tool::new("lookup_status", "Return the current project status").with_schema(
            serde_json::json!({
                "type": "object",
                "additionalProperties": false
            }),
        ),
        requires_approval: true,
    }
}

#[tokio::test]
async fn scripted_embedding_returns_a_caller_owned_tool_result_to_the_native_loop() {
    let workspace = tempfile::tempdir().expect("workspace");
    let script = vec![
        ScriptedResponse {
            blocks: vec![ScriptedBlock::ToolUse {
                id: "lookup-status-1".to_owned(),
                name: "lookup_status".to_owned(),
                input: serde_json::json!({}),
            }],
            stop_reason: StopReason::ToolUse,
            error: None,
        },
        ScriptedResponse::text("The project status is ready."),
    ];
    let mut session = ScriptedEmbeddingBuilder::new(script)
        .working_directory(workspace.path())
        .external_tools([caller_owned_tool()])
        .start()
        .expect("scripted embedding starts");

    session
        .agent()
        .prompt("Check the project status.")
        .await
        .expect("prompt is queued");
    let event = next_event_matching(&mut session, |event| {
        matches!(event, FromAgent::ToolCall { .. })
    })
    .await;
    let FromAgent::ToolCall {
        call_id,
        tool,
        requires_approval,
        ..
    } = event
    else {
        unreachable!("the predicate only returns tool calls");
    };
    assert_eq!(tool, "lookup_status");
    assert!(requires_approval);
    session
        .agent()
        .send_tool_response(EmbeddedToolResponse::external_result(
            call_id,
            ToolResult::success("ready"),
        ))
        .expect("caller result reaches the actor");

    let completed = next_event_matching(&mut session, |event| {
        matches!(event, FromAgent::TurnCompleted { .. })
    })
    .await;
    assert!(matches!(completed, FromAgent::TurnCompleted { .. }));
    session.shutdown().await;
}

#[tokio::test]
async fn scripted_embedding_denial_reaches_the_next_turn_without_local_execution() {
    let workspace = tempfile::tempdir().expect("workspace");
    let script = vec![
        ScriptedResponse {
            blocks: vec![ScriptedBlock::ToolUse {
                id: "lookup-status-denied".to_owned(),
                name: "lookup_status".to_owned(),
                input: serde_json::json!({}),
            }],
            stop_reason: StopReason::ToolUse,
            error: None,
        },
        ScriptedResponse::text("The tool call was denied."),
    ];
    let mut session = ScriptedEmbeddingBuilder::new(script)
        .working_directory(workspace.path())
        .external_tools([caller_owned_tool()])
        .start()
        .expect("scripted embedding starts");

    session
        .agent()
        .prompt("Check the project status.")
        .await
        .expect("prompt is queued");
    let event = next_event_matching(&mut session, |event| {
        matches!(event, FromAgent::ToolCall { .. })
    })
    .await;
    let FromAgent::ToolCall { call_id, .. } = event else {
        unreachable!("the predicate only returns tool calls");
    };
    session
        .agent()
        .send_tool_response(EmbeddedToolResponse::deny(call_id.clone()))
        .expect("caller denial reaches the actor");

    let events = events_through_completion(&mut session).await;
    session.shutdown().await;

    assert!(
        events.iter().any(|event| matches!(
            event,
            FromAgent::ResponseChunk { content, is_thinking: false, .. }
                if content == "The tool call was denied."
        )),
        "the scripted second provider round must complete after the denial"
    );
    assert!(
        !events.iter().any(|event| match event {
            FromAgent::ToolStart {
                call_id: event_call_id,
            }
            | FromAgent::ToolOutput {
                call_id: event_call_id,
                ..
            } => event_call_id == &call_id,
            FromAgent::ToolEnd {
                call_id: event_call_id,
                success: true,
                ..
            } => event_call_id == &call_id,
            _ => false,
        }),
        "a denied caller-owned tool must not execute locally or claim success"
    );
    let snapshot = events
        .iter()
        .rev()
        .find_map(|event| match event {
            FromAgent::ConversationSnapshot { messages, .. } => Some(messages),
            _ => None,
        })
        .expect("completed embedding turn must publish a conversation snapshot");
    assert!(
        snapshot.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::Blocks(blocks)
                    if blocks.iter().any(|block| matches!(
                        block,
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error: Some(true),
                        } if tool_use_id == &call_id && content == "[tool result omitted from checkpoint]"
                    ))
            )
        }),
        "denial must become an error tool result before the next provider turn"
    );
}

#[tokio::test]
async fn shutdown_cancels_a_pending_embedded_turn_before_returning() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut session = ScriptedEmbeddingBuilder::new(vec![ScriptedResponse {
        blocks: vec![ScriptedBlock::Pending],
        stop_reason: StopReason::EndTurn,
        error: None,
    }])
    .working_directory(workspace.path())
    .start()
    .expect("scripted embedding starts");

    session
        .agent()
        .prompt("Wait for cancellation.")
        .await
        .expect("prompt is queued");
    let _ = next_event_matching(&mut session, |event| {
        matches!(event, FromAgent::ResponseStart { .. })
    })
    .await;
    tokio::time::timeout(Duration::from_secs(3), session.shutdown())
        .await
        .expect("embedded shutdown waits for cancellation cleanup");
}

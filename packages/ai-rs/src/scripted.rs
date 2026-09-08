//! Deterministic scripted-replay provider.
//!
//! [`ScriptedClient`] replays a fixed list of assistant responses
//! ([`ScriptedResponse`]) through the normal `UnifiedClient` streaming
//! interface. Each [`ScriptedClient::stream`] call pops the next scripted
//! response and emits it as the same [`StreamEvent`] sequence a live
//! provider would produce, so the real agent loop -- tool gating, execution,
//! session recording, approvals -- runs unchanged against a deterministic
//! "model".
//!
//! This backs `maestro scenario run --execute`: an
//! `evalops.maestro.scripted-scenario.v1` fixture becomes the model, and the
//! runtime executes its recorded tool calls for real.
//!
//! Determinism contract: a `ScriptedClient` yields its responses in order,
//! exactly once, regardless of the messages or request config it is asked
//! about. When the script is exhausted the stream fails loudly -- silently
//! inventing an extra response would break replay determinism.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::mpsc;

use super::types::{
    ContentBlock, Message, ProviderStreamErrorKind, RequestConfig, StopReason, StreamEvent,
};

/// One content block of a scripted assistant response.
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptedBlock {
    /// Assistant text, emitted as one `TextDelta`.
    Text(String),
    /// A tool call. `input` is emitted as a single `InputJsonDelta` chunk.
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// End the channel without a protocol terminal event.
    Eof,
    /// Keep the channel open forever without a terminal event.
    Pending,
    /// End the response with a typed provider failure.
    ProviderError {
        kind: ProviderStreamErrorKind,
        message: String,
    },
    /// No assistant content; the usage chunk reports these output tokens.
    ///
    /// Models that think privately (Gemini 2.5 on Vertex Chat Completions)
    /// finish this way: billed `completion_tokens`, empty `delta.content`.
    BilledSilence { output_tokens: u64 },
}

/// One scripted assistant response (one `stream` call's worth of events).
#[derive(Debug, Clone, PartialEq)]
pub struct ScriptedResponse {
    pub blocks: Vec<ScriptedBlock>,
    pub stop_reason: StopReason,
    /// When set, the stream ends with `StreamEvent::Error` after any blocks
    /// (and before a normal `MessageStop`). Used to exercise terminal recovery
    /// paths such as `StopFailure` hooks without a live provider.
    pub error: Option<String>,
}

impl ScriptedResponse {
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            blocks: vec![ScriptedBlock::Text(text.into())],
            stop_reason: StopReason::EndTurn,
            error: None,
        }
    }

    #[must_use]
    pub fn stream_error(message: impl Into<String>) -> Self {
        Self {
            blocks: Vec::new(),
            stop_reason: StopReason::EndTurn,
            error: Some(message.into()),
        }
    }

    #[must_use]
    pub fn has_tool_use(&self) -> bool {
        self.blocks
            .iter()
            .any(|block| matches!(block, ScriptedBlock::ToolUse { .. }))
    }
}

/// Deterministic replay client. Clone-cheap; clones share the same response
/// cursor, which is what `UnifiedClient`'s idle-policy wrapper needs when it
/// clones the client for potential retries.
#[derive(Clone)]
pub struct ScriptedClient {
    model: String,
    responses: Arc<Mutex<VecDeque<ScriptedResponse>>>,
}

impl ScriptedClient {
    #[must_use]
    pub fn new(model: impl Into<String>, responses: Vec<ScriptedResponse>) -> Self {
        Self {
            model: model.into(),
            responses: Arc::new(Mutex::new(VecDeque::from(responses))),
        }
    }

    /// Number of scripted responses not yet consumed.
    #[must_use]
    pub fn remaining(&self) -> usize {
        self.responses.lock().map(|queue| queue.len()).unwrap_or(0)
    }

    /// Stream the next scripted response.
    ///
    /// The `messages`/`config` arguments are accepted for interface parity
    /// and intentionally ignored: the whole point of the provider is that
    /// the response depends only on the script, never on the request.
    pub async fn stream(
        &self,
        _messages: &[Message],
        _config: &RequestConfig,
    ) -> Result<mpsc::UnboundedReceiver<StreamEvent>> {
        let response = self
            .responses
            .lock()
            .map_err(|_| anyhow::anyhow!("scripted replay queue poisoned"))?
            .pop_front()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "scripted replay exhausted: the agent loop requested more responses than the script contains"
                )
            })?;

        let (tx, rx) = mpsc::unbounded_channel();
        let mut output_tokens = 0u64;
        let _ = tx.send(StreamEvent::MessageStart {
            id: format!("scripted-{}", self.model),
            model: self.model.clone(),
        });
        for (index, block) in response.blocks.iter().enumerate() {
            match block {
                ScriptedBlock::Text(text) => {
                    let _ = tx.send(StreamEvent::ContentBlockStart {
                        index,
                        block: ContentBlock::Text {
                            text: String::new(),
                        },
                    });
                    let _ = tx.send(StreamEvent::TextDelta {
                        index,
                        text: text.clone(),
                    });
                }
                ScriptedBlock::ToolUse { id, name, input } => {
                    let _ = tx.send(StreamEvent::ContentBlockStart {
                        index,
                        block: ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: serde_json::json!({}),
                        },
                    });
                    let _ = tx.send(StreamEvent::InputJsonDelta {
                        index,
                        partial_json: input.to_string(),
                    });
                }
                ScriptedBlock::Eof => return Ok(rx),
                ScriptedBlock::Pending => {
                    tokio::spawn(async move {
                        std::future::pending::<()>().await;
                        drop(tx);
                    });
                    return Ok(rx);
                }
                ScriptedBlock::ProviderError { kind, message } => {
                    let _ = tx.send(StreamEvent::ProviderError {
                        kind: *kind,
                        message: message.clone(),
                    });
                    return Ok(rx);
                }
                ScriptedBlock::BilledSilence {
                    output_tokens: tokens,
                } => {
                    output_tokens = *tokens;
                    continue;
                }
            }
            let _ = tx.send(StreamEvent::ContentBlockStop {
                index,
                thinking_signature: None,
            });
        }
        let _ = tx.send(StreamEvent::Usage {
            input_tokens: 0,
            output_tokens,
            cache_read_tokens: Some(0),
            cache_creation_tokens: Some(0),
        });
        if let Some(message) = response.error {
            let _ = tx.send(StreamEvent::Error { message });
        } else {
            let _ = tx.send(StreamEvent::MessageStop {
                stop_reason: Some(response.stop_reason),
            });
        }
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_script() -> Vec<ScriptedResponse> {
        vec![
            ScriptedResponse {
                blocks: vec![
                    ScriptedBlock::Text("I will read the manifest.".to_string()),
                    ScriptedBlock::ToolUse {
                        id: "call-read-1".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({ "path": "package.json" }),
                    },
                ],
                stop_reason: StopReason::ToolUse,
                error: None,
            },
            ScriptedResponse {
                blocks: vec![ScriptedBlock::Text("Done.".to_string())],
                stop_reason: StopReason::EndTurn,
                error: None,
            },
        ]
    }

    async fn collect(rx: mpsc::UnboundedReceiver<StreamEvent>) -> Vec<StreamEvent> {
        let mut rx = rx;
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn scripted_client_replays_responses_in_order() {
        let client = ScriptedClient::new("maestro-replay-v1", sample_script());
        assert_eq!(client.remaining(), 2);

        let first = collect(
            client
                .stream(&[], &RequestConfig::default())
                .await
                .expect("first stream"),
        )
        .await;
        assert!(matches!(first[0], StreamEvent::MessageStart { .. }));
        assert!(first.iter().any(|event| matches!(
            event,
            StreamEvent::TextDelta { text, .. } if text == "I will read the manifest."
        )));
        assert!(first.iter().any(|event| matches!(
            event,
            StreamEvent::InputJsonDelta { partial_json, .. }
                if partial_json == "{\"path\":\"package.json\"}"
        )));
        assert!(first.iter().any(|event| matches!(
            event,
            StreamEvent::ContentBlockStart {
                block: ContentBlock::ToolUse { id, name, .. },
                ..
            } if id == "call-read-1" && name == "read"
        )));
        assert!(matches!(
            first.last(),
            Some(StreamEvent::MessageStop {
                stop_reason: Some(StopReason::ToolUse)
            })
        ));

        let second = collect(
            client
                .stream(&[], &RequestConfig::default())
                .await
                .expect("second stream"),
        )
        .await;
        assert!(matches!(
            second.last(),
            Some(StreamEvent::MessageStop {
                stop_reason: Some(StopReason::EndTurn)
            })
        ));
        assert_eq!(client.remaining(), 0);
    }

    #[tokio::test]
    async fn scripted_client_fails_loudly_when_exhausted() {
        let client = ScriptedClient::new(
            "maestro-replay-v1",
            vec![ScriptedResponse {
                blocks: vec![],
                stop_reason: StopReason::EndTurn,
                error: None,
            }],
        );
        client
            .stream(&[], &RequestConfig::default())
            .await
            .expect("first stream");
        let error = client
            .stream(&[], &RequestConfig::default())
            .await
            .expect_err("exhausted script must error");
        assert!(error.to_string().contains("scripted replay exhausted"));
    }

    #[tokio::test]
    async fn scripted_client_clones_share_the_cursor() {
        let client = ScriptedClient::new("maestro-replay-v1", sample_script());
        let clone = client.clone();
        client
            .stream(&[], &RequestConfig::default())
            .await
            .expect("first stream");
        assert_eq!(clone.remaining(), 1);
    }
}

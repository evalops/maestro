//! Exact identity compatibility and repeatable preparation microbenchmarks.
use super::*;

fn legacy_id(kind: &str, model: &str, messages: &[Message], tail: Option<&str>) -> String {
    let mut owned;
    let messages = if let Some(tail) = tail {
        owned = messages.to_vec();
        owned.push(Message {
            role: Role::User,
            content: MessageContent::text(tail),
        });
        owned.as_slice()
    } else {
        messages
    };
    let encoded = serde_json::to_vec(messages).unwrap();
    let mut material = Vec::with_capacity(kind.len() + model.len() + encoded.len() + 32);
    for bytes in [kind.as_bytes(), model.as_bytes(), encoded.as_slice()] {
        material.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        material.extend_from_slice(bytes);
    }
    format!("native-provider-v1:{kind}:{:x}", Sha256::digest(material))
}

fn history(count: usize, bytes: usize) -> Vec<Message> {
    (0..count).map(|index| Message {
        role: if index % 2 == 0 { Role::User } else { Role::Assistant },
        content: MessageContent::Blocks(vec![
            ContentBlock::Text { text: format!("message {index}: {}", "source λ\n".repeat(bytes / 10)) },
            ContentBlock::ToolUse { id: format!("call-{index}"), name: "read".into(), input: serde_json::json!({"path":format!("src/{index}.rs"),"offset":index,"nested":{"literal":"\"\\\n"}}) , gemini_context: None, },
            ContentBlock::ToolResult { tool_use_id: format!("call-{index}"), content: "result\twith\rcontrols\n".into(), is_error: Some(false) },
        ]),
    }).collect()
}

#[test]
fn request_identity_preserves_v1_bytes_with_borrowed_history() {
    for messages in [Vec::new(), history(1, 20), history(16, 2048)] {
        for tail in [
            None,
            Some(""),
            Some("clock: 12:00\nUnicode λ 👋\t\"quoted\""),
        ] {
            for (kind, model) in [("primary", "gpt-5"), ("semantic_compaction", "model:λ")] {
                assert_eq!(
                    provider_request_id_with_tail(kind, model, &messages, tail).unwrap(),
                    legacy_id(kind, model, &messages, tail)
                );
            }
        }
    }
}

#[test]
fn request_identity_keeps_empty_tail_distinct_from_no_tail() {
    let messages = history(2, 128);
    let absent = provider_request_id_with_tail("primary", "gpt-5", &messages, None).unwrap();
    assert_ne!(
        absent,
        provider_request_id_with_tail("primary", "gpt-5", &messages, Some("")).unwrap()
    );
    assert_ne!(
        provider_request_id_with_tail("primary", "gpt-5", &messages, Some("clock A")).unwrap(),
        provider_request_id_with_tail("primary", "gpt-5", &messages, Some("clock B")).unwrap()
    );
}

fn median(mut values: Vec<u128>) -> u128 {
    values.sort_unstable();
    values[values.len() / 2]
}

/// Run with `cargo test -p maestro-runtime --release --lib request_preparation_microbench
/// --locked -- --ignored --nocapture --test-threads=1`. Timings are observations, not gates.
#[test]
#[ignore = "explicit performance measurement; no timing assertion"]
fn request_preparation_microbench() {
    use maestro_context::{context_usage::RequestContextUsage, token_counter::TokenCounter};
    use std::hint::black_box;
    for (count, bytes) in [(16, 256), (128, 1024), (512, 4096)] {
        let messages = history(count, bytes);
        let config = RequestConfig {
            model: "gpt-5".into(),
            system: Some("Stable system instructions. ".repeat(256)),
            tools: Arc::new(
                (0..20)
                    .map(|index| {
                        crate::ai::Tool::new(
                            format!("tool_{index}"),
                            "Tool schema description. ".repeat(40),
                        )
                    })
                    .collect(),
            ),
            ..Default::default()
        };
        let counter = TokenCounter::new(Some(config.model.clone()));
        let mut old_id = Vec::new();
        let mut new_id = Vec::new();
        let mut old_count = Vec::new();
        let mut new_count = Vec::new();
        for round in 0..11 {
            // Alternate order to reduce warm-cache/CPU-order bias.
            for old_first in [round % 2 == 0, round % 2 != 0] {
                let start = Instant::now();
                let id = if old_first {
                    legacy_id("primary", &config.model, &messages, Some("volatile tail"))
                } else {
                    provider_request_id_with_tail(
                        "primary",
                        &config.model,
                        &messages,
                        Some("volatile tail"),
                    )
                    .unwrap()
                };
                black_box(id);
                if round >= 2 {
                    (if old_first { &mut old_id } else { &mut new_id })
                        .push(start.elapsed().as_nanos());
                }
                let start = Instant::now();
                let usage = RequestContextUsage::from_request(&messages, &config, &counter);
                let (audit, total) = if old_first {
                    (
                        usage,
                        RequestContextUsage::from_request(&messages, &config, &counter).total(),
                    )
                } else {
                    (usage.clone(), usage.total())
                };
                assert_eq!(audit.total(), total);
                black_box((audit, total));
                if round >= 2 {
                    (if old_first {
                        &mut old_count
                    } else {
                        &mut new_count
                    })
                    .push(start.elapsed().as_nanos());
                }
            }
        }
        println!(
            "{}",
            serde_json::json!({"messages":count,"serialized_history_bytes":serde_json::to_vec(&messages).unwrap().len(),"legacy_identity_ns":median(old_id),"borrowed_identity_ns":median(new_id),"double_accounting_ns":median(old_count),"single_accounting_ns":median(new_count)})
        );
    }
}

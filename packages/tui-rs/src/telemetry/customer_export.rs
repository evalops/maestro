//! Customer collector encoding of the existing content-free turn projection.
use super::ExternalTurnEvent;

/// Encode a sampled terminal observation as JSON or an OTLP/HTTP JSON log.
/// Unknown formats fail closed instead of posting the wrong protocol to a collector.
pub(super) fn encode(event: &ExternalTurnEvent, format: &str) -> Option<String> {
    use serde_json::json;
    match format {
        "json" => return serde_json::to_string(event).ok(),
        "otlp" => {}
        _ => return None,
    }
    let timestamp = chrono::DateTime::parse_from_rfc3339(&event.timestamp)
        .ok()?
        .timestamp_nanos_opt()
        .filter(|v| *v >= 0)?
        .to_string();
    let mut attrs = vec![
        json!({"key": "deixic.turn.status", "value": {"stringValue": event.status.to_string()}}),
        json!({"key": "deixic.cost.complete", "value": {"boolValue": event.reported_cost_usd.is_some_and(|v| v.is_finite() && v >= 0.0)}}),
        json!({"key": "deixic.collection", "value": {"stringValue": "sampled"}}),
    ];
    // Provider identifiers can contain deployment URLs. Only known names cross this boundary.
    if matches!(
        event.model_provider.as_str(),
        "anthropic"
            | "openai"
            | "openai-codex"
            | "google"
            | "vertex-ai"
            | "bedrock"
            | "openrouter"
            | "moonshot"
            | "mistral"
            | "groq"
            | "deepseek"
            | "qwen"
            | "minimax"
            | "zai"
            | "scripted"
    ) {
        attrs.push(
            json!({"key": "gen_ai.provider.name", "value": {"stringValue": event.model_provider}}),
        );
    }
    if let Some(cost) = event
        .reported_cost_usd
        .filter(|v| v.is_finite() && *v >= 0.0)
    {
        attrs.push(json!({"key": "deixic.cost.usd", "value": {"doubleValue": cost}}));
    }
    let mut count = |key: &str, value: u64| {
        // OTLP JSON uses decimal strings for 64-bit integer values.
        attrs.push(json!({"key": key, "value": {"intValue": value.to_string()}}));
    };
    count("deixic.turn.duration_ms", event.total_duration_ms);
    count("deixic.turn.model_duration_ms", event.llm_duration_ms);
    count("deixic.tokens.input", event.tokens.input);
    count("deixic.tokens.output", event.tokens.output);
    count("deixic.tokens.cache_read", event.tokens.cache_read);
    count("deixic.tokens.cache_write", event.tokens.cache_write);
    let tools = &event.tool_outcomes;
    for (key, value) in [
        ("deixic.tools.succeeded", tools.succeeded),
        ("deixic.tools.failed", tools.failed),
        ("deixic.tools.denied", tools.denied),
        ("deixic.tools.cancelled", tools.cancelled),
        ("deixic.tools.indeterminate", tools.indeterminate),
        ("deixic.tools.unknown", tools.unknown),
        (
            "deixic.tools.measured_execution_count",
            tools.measured_execution_count,
        ),
    ] {
        count(key, u64::from(value));
    }
    if tools.measured_execution_count > 0 {
        count(
            "deixic.tools.execution_duration_ms",
            tools.execution_duration_ms,
        );
    }
    if let Some(m) = &event.measurements {
        for (key, value) in [
            ("deixic.turn.first_output_ms", m.first_output_ms),
            (
                "deixic.turn.compaction_duration_ms",
                m.compaction_duration_ms,
            ),
            ("deixic.stream.stalls", m.stream_stall_count.map(u64::from)),
            (
                "deixic.stream.open_failures",
                m.stream_open_failure_count.map(u64::from),
            ),
            (
                "deixic.stream.disconnects",
                m.stream_disconnect_count.map(u64::from),
            ),
            ("deixic.stream.retries", m.stream_retry_count.map(u64::from)),
            (
                "deixic.stream.recoveries",
                m.stream_recovery_count.map(u64::from),
            ),
        ] {
            if let Some(value) = value {
                count(key, value);
            }
        }
        for (key, value) in [
            ("deixic.model.retries", m.request_retry_count),
            ("deixic.compaction.count", m.compaction_count),
            ("deixic.compaction.automatic", m.automatic_compaction_count),
            ("deixic.model.responses", m.response_count),
            ("deixic.model.responses_with_usage", m.responses_with_usage),
            ("deixic.model.responses_with_cost", m.responses_with_cost),
        ] {
            count(key, u64::from(value));
        }
        count("deixic.compaction.input_tokens", m.compacted_input_tokens);
    }
    serde_json::to_string(&json!({"resourceLogs": [{
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": "deixic-code"}},
            {"key": "service.version", "value": {"stringValue": env!("CARGO_PKG_VERSION")}}
        ]},
        "scopeLogs": [{"scope": {"name": "deixic.turn", "version": "1"},
            "logRecords": [{"timeUnixNano": timestamp,
                "body": {"stringValue": "canonical-turn"}, "attributes": attrs}]
        }]
    }]}))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{TailSamplingConfig, TokenUsage, TurnCollector, TurnStatus};

    #[test]
    fn otlp_preserves_known_zero_and_omits_unavailable_cost_and_private_fields() {
        let mut turn = TurnCollector::new("private-session", 1, TailSamplingConfig::default());
        turn.record_output();
        let mut event = turn
            .complete(TurnStatus::Success, TokenUsage::default(), 0.0, None, None)
            .external_projection();
        event.model_provider = "private-provider-url".into();
        for (cost, expected) in [
            (None, None),
            (Some(0.0), Some(0.0)),
            (Some(0.25), Some(0.25)),
        ] {
            event.reported_cost_usd = cost;
            let encoded = encode(&event, "otlp").unwrap();
            let wire: serde_json::Value = serde_json::from_str(&encoded).unwrap();
            let record = &wire["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];
            let attributes = record["attributes"].as_array().expect("OTLP attributes");
            let value = |key: &str| {
                attributes
                    .iter()
                    .find(|a| a["key"] == key)
                    .map(|a| &a["value"])
            };
            assert_eq!(
                value("deixic.cost.usd").and_then(|v| v["doubleValue"].as_f64()),
                expected
            );
            assert_eq!(
                value("deixic.cost.complete").unwrap()["boolValue"],
                cost.is_some()
            );
            assert!(value("deixic.turn.first_output_ms").is_some());
            assert!(!encoded.contains("private-session"));
            assert!(!encoded.contains("private-provider-url"));
            assert!(
                record["timeUnixNano"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 0
            );
        }
        assert!(encode(&event, "invalid").is_none());
    }
}

#[cfg(test)]
mod provider_id_tests {
    use super::*;
    use crate::telemetry::{TailSamplingConfig, TokenUsage, TurnCollector, TurnStatus};

    #[test]
    fn otlp_exports_canonical_provider_ids_without_deployment_urls() {
        let event = TurnCollector::new("fixture", 1, TailSamplingConfig::default()).complete(
            TurnStatus::Success,
            TokenUsage::default(),
            0.0,
            None,
            None,
        );
        let mut external = event.external_projection();
        for (provider, expected) in [
            ("anthropic", true),
            ("openai", true),
            ("openai-codex", true),
            ("google", true),
            ("bedrock", true),
            ("openrouter", true),
            ("mistral", true),
            ("groq", true),
            ("deepseek", true),
            ("qwen", true),
            ("minimax", true),
            ("zai", true),
            ("scripted", true),
            ("vertex-ai", true),
            ("moonshot", true),
            ("https://private.example/model", false),
        ] {
            external.model_provider = provider.to_owned();
            let encoded: serde_json::Value =
                serde_json::from_str(&encode(&external, "otlp").unwrap()).unwrap();
            let attrs = encoded["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"]
                .as_array()
                .unwrap();
            let attribute = attrs.iter().find(|a| a["key"] == "gen_ai.provider.name");
            assert_eq!(attribute.is_some(), expected);
            if let Some(attribute) = attribute {
                assert_eq!(attribute["value"]["stringValue"], provider);
            }
        }
    }
}

#![allow(clippy::all)]
#![allow(dead_code)]
#![allow(missing_docs)]

// Generated protobuf types for the headless protocol live under a separate
// namespace so they can coexist with the current serde-based JSON transport.
pub mod maestro {
    pub mod v1 {
        include!(concat!(env!("OUT_DIR"), "/maestro.v1.rs"));
    }
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::maestro::v1::to_agent_envelope::Payload;
    use super::maestro::v1::{HelloMessage, ToAgentEnvelope, ToolEndMessage, ToolResponseMessage};

    #[test]
    fn generated_headless_proto_types_compile() {
        let hello = HelloMessage {
            protocol_version: Some("2026-04-02".to_string()),
            ..HelloMessage::default()
        };

        let envelope = ToAgentEnvelope {
            payload: Some(Payload::Hello(hello)),
        };

        assert!(matches!(envelope.payload, Some(Payload::Hello(_))));

        let tool_end = ToolEndMessage {
            call_id: "call-1".to_string(),
            success: true,
            receipt: Some(prost_types::Value::default()),
            ..ToolEndMessage::default()
        };
        assert!(tool_end.receipt.is_some());
    }

    #[test]
    fn tool_response_round_trips_tool_execution_id() {
        let response = ToolResponseMessage {
            call_id: "call-1".to_string(),
            approved: false,
            tool_execution_id: Some("tool-execution-1".to_string()),
            ..ToolResponseMessage::default()
        };

        let encoded = response.encode_to_vec();
        let decoded =
            ToolResponseMessage::decode(encoded.as_slice()).expect("decode tool response");

        assert_eq!(
            decoded.tool_execution_id.as_deref(),
            Some("tool-execution-1")
        );
    }
}

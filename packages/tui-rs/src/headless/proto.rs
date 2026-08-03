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
    use super::maestro::v1::{
        FromAgentEnvelope, HelloMessage, ResponseAcceptedMessage, ToAgentEnvelope, ToolEndMessage,
        ToolResponseMessage,
    };

    #[test]
    fn generated_headless_proto_types_compile() {
        let hello = HelloMessage {
            protocol_version: Some("2026-08-01".to_string()),
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

    #[test]
    fn response_acceptance_is_in_the_authoritative_proto_envelope() {
        let envelope = FromAgentEnvelope {
            payload: Some(
                super::maestro::v1::from_agent_envelope::Payload::ResponseAccepted(
                    ResponseAcceptedMessage {
                        request_id: "call-1".to_string(),
                    },
                ),
            ),
        };
        let encoded = envelope.encode_to_vec();
        let decoded = FromAgentEnvelope::decode(encoded.as_slice()).expect("decode envelope");
        assert!(matches!(
            decoded.payload,
            Some(super::maestro::v1::from_agent_envelope::Payload::ResponseAccepted(
                ResponseAcceptedMessage { request_id }
            )) if request_id == "call-1"
        ));
    }
}

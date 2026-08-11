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
        CodeMode, FromAgentEnvelope, GovernedInitMessage, GovernedToolGrant, HelloMessage,
        NativeToolCapability, ProviderErrorMessage, ProviderStreamErrorKind,
        ResponseAcceptedMessage, ServerCapabilities, ToAgentEnvelope, ToolEndMessage,
        ToolResponseMessage, TurnCompletedMessage, TurnInterruptedMessage,
    };

    #[test]
    fn generated_headless_proto_types_compile() {
        let hello = HelloMessage {
            protocol_version: Some("2026-08-08".to_string()),
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

        let governed = ToAgentEnvelope {
            payload: Some(Payload::GovernedInit(GovernedInitMessage {
                code_mode: CodeMode::GovernedCode.into(),
                tool_grant: Some(GovernedToolGrant {
                    envelope_version: 2,
                    grant_id: "grant-1".to_string(),
                    ..GovernedToolGrant::default()
                }),
                ..GovernedInitMessage::default()
            })),
        };
        assert!(matches!(governed.payload, Some(Payload::GovernedInit(_))));

        let hello_ok = super::maestro::v1::HelloOkMessage {
            server_capabilities: Some(ServerCapabilities {
                native_tools: vec![NativeToolCapability {
                    name: "bash".to_string(),
                    requires_approval: true,
                    version: Some("current".to_string()),
                }],
                ..ServerCapabilities::default()
            }),
            ..super::maestro::v1::HelloOkMessage::default()
        };
        let encoded = hello_ok.encode_to_vec();
        let decoded = super::maestro::v1::HelloOkMessage::decode(encoded.as_slice())
            .expect("decode hello acknowledgement");
        let tool = decoded
            .server_capabilities
            .expect("server capabilities")
            .native_tools
            .into_iter()
            .next()
            .expect("native tool capability");
        assert_eq!(tool.name, "bash");
        assert!(tool.requires_approval);
        assert_eq!(tool.version.as_deref(), Some("current"));
    }

    #[test]
    fn explicit_turn_terminals_are_in_the_authoritative_proto_envelope() {
        use super::maestro::v1::from_agent_envelope::Payload;

        for payload in [
            Payload::TurnCompleted(TurnCompletedMessage {
                response_id: "done".to_string(),
            }),
            Payload::TurnInterrupted(TurnInterruptedMessage {
                response_id: "done".to_string(),
                reason: "cancelled".to_string(),
            }),
            Payload::ProviderError(ProviderErrorMessage {
                kind: ProviderStreamErrorKind::TransientProtocol.into(),
                message: "unexpected eof".to_string(),
            }),
        ] {
            let encoded = FromAgentEnvelope {
                payload: Some(payload),
            }
            .encode_to_vec();
            let decoded = FromAgentEnvelope::decode(encoded.as_slice()).expect("decode terminal");
            assert!(matches!(
                decoded.payload,
                Some(
                    Payload::TurnCompleted(_)
                        | Payload::TurnInterrupted(_)
                        | Payload::ProviderError(_)
                )
            ));
        }

        for message_type in ["turn_completed", "turn_interrupted", "provider_error"] {
            assert!(
                super::super::generated_protocol::HEADLESS_FROM_AGENT_MESSAGE_TYPES
                    .contains(&message_type),
                "generated JSON contract is missing {message_type}"
            );
        }
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

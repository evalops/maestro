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
    use super::maestro::v1::to_agent_envelope::Payload;
    use super::maestro::v1::{HelloMessage, ToAgentEnvelope};

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
    }
}

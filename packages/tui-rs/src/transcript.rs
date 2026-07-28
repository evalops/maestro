//! Bounded, graded transcript subscriptions for remote and protocol clients.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptGrade {
    Off,
    Turn,
    Block,
    #[default]
    Delta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptLevel {
    Turn,
    Block,
    Delta,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub sequence: u64,
    pub level: TranscriptLevel,
    pub kind: String,
    pub payload: Value,
}

impl TranscriptGrade {
    #[must_use]
    pub fn includes(self, level: TranscriptLevel) -> bool {
        match self {
            Self::Off => false,
            Self::Turn => level == TranscriptLevel::Turn,
            Self::Block => level != TranscriptLevel::Delta,
            Self::Delta => true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TranscriptJournal {
    next_sequence: u64,
    capacity: usize,
    events: VecDeque<TranscriptEvent>,
}

impl TranscriptJournal {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            next_sequence: 1,
            capacity: capacity.max(1),
            events: VecDeque::new(),
        }
    }

    pub fn push(&mut self, level: TranscriptLevel, kind: impl Into<String>, payload: Value) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.events.push_back(TranscriptEvent {
            sequence,
            level,
            kind: kind.into(),
            payload: redact(payload),
        });
        while self.events.len() > self.capacity {
            self.events.pop_front();
        }
        sequence
    }

    #[must_use]
    pub fn after(&self, cursor: u64, grade: TranscriptGrade) -> Vec<TranscriptEvent> {
        self.events
            .iter()
            .filter(|event| event.sequence > cursor && grade.includes(event.level))
            .cloned()
            .collect()
    }
}

fn redact(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized_key = key.to_ascii_lowercase().replace(['-', '_'], "");
                if matches!(
                    normalized_key.as_str(),
                    "authorization"
                        | "apikey"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "clientsecret"
                        | "bearertoken"
                        | "secret"
                        | "password"
                        | "privatekey"
                ) {
                    *child = Value::String("[REDACTED]".to_string());
                } else {
                    *child = redact(child.take());
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                *child = redact(child.take());
            }
        }
        _ => {}
    }
    value
}

pub(crate) fn redact_agent_message(
    message: crate::headless::messages::FromAgentMessage,
) -> crate::headless::messages::FromAgentMessage {
    let Ok(value) = serde_json::to_value(&message) else {
        return message;
    };
    let Ok(mut redacted_message) = serde_json::from_value(redact(value)) else {
        return message;
    };
    match &mut redacted_message {
        crate::headless::messages::FromAgentMessage::ToolOutput { content, .. }
        | crate::headless::messages::FromAgentMessage::UtilityCommandOutput { content, .. }
            if contains_credential_marker(content) =>
        {
            *content = "[REDACTED]".to_string();
        }
        _ => {}
    }
    redacted_message
}

fn contains_credential_marker(content: &str) -> bool {
    let normalized = content.to_ascii_lowercase();
    [
        "authorization",
        "api_key",
        "api-key",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "client_secret",
        "client-secret",
        "token",
        "secret",
        "password",
        "private_key",
    ]
    .iter()
    .any(|marker| {
        normalized.match_indices(marker).any(|(index, marker)| {
            normalized[index + marker.len()..]
                .trim_start()
                .strip_prefix(['=', ':'])
                .is_some_and(|value| !value.trim().is_empty())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grades_filter_and_replay_from_cursor() {
        let mut journal = TranscriptJournal::new(3);
        journal.push(TranscriptLevel::Turn, "turn", json!({"text":"a"}));
        let cursor = journal.push(TranscriptLevel::Block, "block", json!({"text":"b"}));
        journal.push(TranscriptLevel::Delta, "delta", json!({"text":"c"}));
        assert_eq!(journal.after(cursor, TranscriptGrade::Turn).len(), 0);
        assert_eq!(journal.after(0, TranscriptGrade::Block).len(), 2);
        assert_eq!(journal.after(cursor, TranscriptGrade::Delta).len(), 1);
    }

    #[test]
    fn redacts_credentials_before_journaling() {
        let mut journal = TranscriptJournal::new(2);
        journal.push(
            TranscriptLevel::Block,
            "tool",
            json!({"nested":{"token":"sensitive","result":"ok"}}),
        );
        let event = &journal.after(0, TranscriptGrade::Delta)[0];
        assert_eq!(event.payload["nested"]["token"], "[REDACTED]");
    }

    #[test]
    fn redacts_structured_tool_args_and_credential_shaped_output() {
        use crate::headless::messages::{FromAgentMessage, UtilityCommandStream};

        let call = redact_agent_message(FromAgentMessage::ToolCall {
            call_id: "call".into(),
            tool_execution_id: None,
            tool: "http".into(),
            args: serde_json::json!({"headers":{"authorization":"Bearer secret"}}),
            requires_approval: false,
        });
        let output = redact_agent_message(FromAgentMessage::ToolOutput {
            call_id: "call".into(),
            content: "access_token=secret".into(),
        });
        assert!(!serde_json::to_string(&call)
            .unwrap()
            .contains("Bearer secret"));
        assert!(!serde_json::to_string(&output)
            .unwrap()
            .contains("access_token"));

        let utility_output = redact_agent_message(FromAgentMessage::UtilityCommandOutput {
            command_id: "command".into(),
            stream: UtilityCommandStream::Stderr,
            content: "OPENAI_API_KEY=secret".into(),
        });
        assert!(!serde_json::to_string(&utility_output)
            .unwrap()
            .contains("OPENAI_API_KEY"));

        let prose = redact_agent_message(FromAgentMessage::ToolOutput {
            call_id: "call".into(),
            content: "search results for authorization middleware".into(),
        });
        assert!(serde_json::to_string(&prose)
            .unwrap()
            .contains("authorization middleware"));
    }
}

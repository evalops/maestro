//! Per-turn memory of tool calls the user already refused.
//!
//! The approval path decides one call at a time and keeps no record of a
//! refusal, so a model that re-issues the same call with the same arguments
//! prompts the user again, and can keep doing so for the rest of the turn.
//!
//! Refusals are keyed on `agentId\0action\0sha256(target)`, retired when a
//! turn begins, and repeated calls in the same epoch are refused without asking.
//!
//! Scope: refusals only. Approvals are not remembered here: an approval that
//! outlived its call would widen what runs without a human deciding.

use std::collections::HashSet;

use sha2::{Digest, Sha256};

/// Largest canonical argument string that is hashed into a refusal key.
///
/// Two calls whose canonical arguments agree for the first
/// [`MAX_DENIAL_TARGET_CHARS`] characters share a key, so a refusal can cover
/// a call the user did not literally see. That is the safe direction: it
/// refuses more, never less.
pub const MAX_DENIAL_TARGET_CHARS: usize = 10_000;

/// A refusal key: the tool name plus a digest of its canonical arguments.
type DenialKey = (String, [u8; 32]);

/// Tool calls the user refused during the current turn.
#[derive(Debug, Default, Clone)]
pub struct DenialMemory {
    epoch: u64,
    refused: HashSet<DenialKey>,
}

impl DenialMemory {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The current turn number.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Start a new turn: bump the epoch and retire every refusal.
    ///
    /// A refusal is scoped to the turn it was made in. The user asking for
    /// something new is the event that makes the earlier refusal stale.
    pub fn begin_turn(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.refused.clear();
    }

    /// Record that `tool` with these arguments was refused this turn.
    pub fn record(&mut self, tool: &str, args: &serde_json::Value) {
        self.refused.insert(denial_key(tool, args));
    }

    /// Whether this exact call was already refused this turn.
    #[must_use]
    pub fn was_refused(&self, tool: &str, args: &serde_json::Value) -> bool {
        self.refused.contains(&denial_key(tool, args))
    }

    /// How many distinct calls are refused this turn.
    #[must_use]
    pub fn len(&self) -> usize {
        self.refused.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.refused.is_empty()
    }
}

fn denial_key(tool: &str, args: &serde_json::Value) -> DenialKey {
    let mut canonical = canonical_json(args);
    if canonical.chars().count() > MAX_DENIAL_TARGET_CHARS {
        canonical = canonical
            .chars()
            .take(MAX_DENIAL_TARGET_CHARS)
            .collect::<String>();
    }
    let digest: [u8; 32] = Sha256::digest(canonical.as_bytes()).into();
    (tool.to_lowercase(), digest)
}

/// Serialize `value` with object keys in sorted order.
///
/// `serde_json::to_string` preserves the order keys were parsed in, so two
/// identical calls whose JSON differs only in key order would hash
/// differently and the second would prompt again.
fn canonical_json(value: &serde_json::Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_identical_repeat_is_remembered_until_the_turn_ends() {
        let mut memory = DenialMemory::new();
        let args = json!({"command": "rm -rf /tmp/x"});
        assert!(!memory.was_refused("bash", &args));

        memory.record("bash", &args);
        assert!(memory.was_refused("bash", &args));
        assert_eq!(memory.len(), 1);

        memory.begin_turn();
        assert!(!memory.was_refused("bash", &args));
        assert!(memory.is_empty());
    }

    #[test]
    fn begin_turn_bumps_the_epoch() {
        let mut memory = DenialMemory::new();
        let first = memory.epoch();
        memory.begin_turn();
        assert_eq!(memory.epoch(), first + 1);
    }

    #[test]
    fn different_arguments_are_a_different_call() {
        let mut memory = DenialMemory::new();
        memory.record("bash", &json!({"command": "rm -rf /tmp/x"}));
        assert!(!memory.was_refused("bash", &json!({"command": "ls"})));
    }

    #[test]
    fn different_tools_are_a_different_call() {
        let mut memory = DenialMemory::new();
        memory.record("bash", &json!({"command": "ls"}));
        assert!(!memory.was_refused("write", &json!({"command": "ls"})));
    }

    #[test]
    fn tool_name_case_does_not_change_the_key() {
        let mut memory = DenialMemory::new();
        memory.record("Bash", &json!({"command": "ls"}));
        assert!(memory.was_refused("bash", &json!({"command": "ls"})));
    }

    #[test]
    fn key_order_does_not_change_the_key() {
        let mut memory = DenialMemory::new();
        let first: serde_json::Value =
            serde_json::from_str(r#"{"a":1,"b":{"c":2,"d":3}}"#).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(r#"{"b":{"d":3,"c":2},"a":1}"#).unwrap();
        memory.record("bash", &first);
        assert!(memory.was_refused("bash", &second));
    }

    #[test]
    fn oversized_arguments_are_capped_before_hashing() {
        let mut memory = DenialMemory::new();
        let long = "x".repeat(MAX_DENIAL_TARGET_CHARS * 2);
        let args = json!({"command": long});
        memory.record("bash", &args);
        assert!(memory.was_refused("bash", &args));
        assert_eq!(memory.len(), 1);
    }
}

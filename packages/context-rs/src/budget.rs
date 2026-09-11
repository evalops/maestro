//! Durable prepared-request budget snapshots for user-facing graphics.

use serde::{Deserialize, Serialize};

pub const CONTEXT_BUDGET_CUSTOM_TYPE: &str = "context_budget_snapshot_v1";
pub const CONTEXT_BUDGET_SCHEMA: &str = "evalops.maestro.context-budget.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetCountConfidence {
    Measured,
    Estimated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudgetPhase {
    PreparedRequest,
    BeforeCompaction,
}

/// Content-free accounting for one exact prepared model request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetSnapshot {
    pub schema_version: String,
    pub snapshot_id: String,
    pub timestamp: String,
    pub model: String,
    pub phase: ContextBudgetPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    pub system_prompt: u64,
    pub tool_schemas: u64,
    pub tool_results: u64,
    pub conversation: u64,
    pub other: u64,
    pub response_reserve: u64,
    pub safety_margin: u64,
    pub confidence: BudgetCountConfidence,
}

impl ContextBudgetSnapshot {
    #[must_use]
    pub fn input_tokens(&self) -> u64 {
        self.system_prompt
            .saturating_add(self.tool_schemas)
            .saturating_add(self.tool_results)
            .saturating_add(self.conversation)
            .saturating_add(self.other)
    }

    #[must_use]
    pub fn occupied_tokens(&self) -> u64 {
        self.input_tokens()
            .saturating_add(self.response_reserve)
            .saturating_add(self.safety_margin)
    }

    #[must_use]
    pub fn remaining_headroom(&self) -> Option<u64> {
        self.context_window
            .map(|window| window.saturating_sub(self.occupied_tokens()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headroom_reserves_response_and_safety_tokens() {
        let snapshot = ContextBudgetSnapshot {
            schema_version: CONTEXT_BUDGET_SCHEMA.into(),
            snapshot_id: "snapshot-1".into(),
            timestamp: "2026-09-08T00:00:00Z".into(),
            model: "gpt-5.6".into(),
            phase: ContextBudgetPhase::PreparedRequest,
            compaction_id: None,
            context_window: Some(100),
            system_prompt: 10,
            tool_schemas: 10,
            tool_results: 10,
            conversation: 10,
            other: 10,
            response_reserve: 20,
            safety_margin: 5,
            confidence: BudgetCountConfidence::Measured,
        };
        assert_eq!(snapshot.input_tokens(), 50);
        assert_eq!(snapshot.occupied_tokens(), 75);
        assert_eq!(snapshot.remaining_headroom(), Some(25));
    }
}

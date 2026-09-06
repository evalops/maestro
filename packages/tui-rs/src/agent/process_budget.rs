//! Signed limits for one Platform process event. Accounting stays in the
//! native request path so replay polling cannot permit another model call.
use serde::{Deserialize, Serialize};

/// Immutable ceilings admitted by Platform for one process event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessBudgetLimits {
    /// Platform event identity bound to the governed turn.
    pub event_id: String,
    /// Maximum admitted model requests for this event.
    pub max_requests: u32,
    /// Maximum cumulative input plus output tokens.
    pub max_total_tokens: u64,
    /// Maximum cumulative model plus tool cost in USD micros.
    pub max_cost_micros: u64,
    /// Fallback USD micros charged per token when provider cost is absent.
    pub cost_micros_per_token: u64,
}

impl ProcessBudgetLimits {
    /// Reject empty event identities and zero ceilings.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.event_id.trim().is_empty()
            || self.max_requests == 0
            || self.max_total_tokens == 0
            || self.max_cost_micros == 0
            || self.cost_micros_per_token == 0
        {
            return Err("invalid process budget limits");
        }
        Ok(())
    }
}

/// Native accounting checkpoint; repeated grants cannot reset spent usage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessBudgetState {
    /// The immutable signed event ceilings.
    pub limits: ProcessBudgetLimits,
    /// Number of admitted model requests, including unresolved ones.
    pub requests: u32,
    /// Number of admitted tool proposals.
    pub tool_calls: u32,
    /// Observed cumulative input plus output tokens.
    pub total_tokens: u64,
    /// Observed cumulative model and acknowledged tool cost.
    pub cost_micros: u64,
    /// Whether an admitted model request still lacks its terminal usage.
    pub awaiting_usage: bool,
    #[serde(default)]
    /// Acknowledged tool cost by execution identity, for replay deduplication.
    pub tool_costs: std::collections::BTreeMap<String, u64>,
}

impl ProcessBudgetState {
    /// Create an unspent checkpoint after validating every ceiling.
    pub fn new(limits: ProcessBudgetLimits) -> Result<Self, &'static str> {
        limits.validate()?;
        Ok(Self {
            limits,
            requests: 0,
            tool_calls: 0,
            total_tokens: 0,
            cost_micros: 0,
            awaiting_usage: false,
            tool_costs: Default::default(),
        })
    }

    /// A repeated grant is observation, never permission to reset spent usage.
    pub fn install(&mut self, limits: &ProcessBudgetLimits) -> Result<(), &'static str> {
        limits.validate()?;
        if &self.limits != limits {
            return Err("cannot replace an admitted process budget");
        }
        Ok(())
    }

    /// Reserve one request before provider I/O; unresolved usage blocks another.
    pub fn admit_request(&mut self) -> Result<(), &'static str> {
        if self.awaiting_usage {
            return Err("process request usage is unresolved");
        }
        self.check_usage()?;
        if self.requests >= self.limits.max_requests {
            return Err("process request budget exhausted");
        }
        self.requests += 1;
        self.awaiting_usage = true;
        Ok(())
    }

    /// Charge before acting on the response. Preserve overspend as evidence,
    /// and refuse tools and subsequent model calls once a ceiling is crossed.
    pub fn observe_usage(
        &mut self,
        input: u64,
        output: u64,
        provider_cost_micros: Option<u64>,
    ) -> Result<(), &'static str> {
        if !self.awaiting_usage {
            return Err("process usage has no admitted request");
        }
        let tokens = input.checked_add(output).ok_or("process usage overflow")?;
        self.total_tokens = self
            .total_tokens
            .checked_add(tokens)
            .ok_or("process usage overflow")?;
        let cost = match provider_cost_micros {
            Some(cost) => cost,
            None => tokens
                .checked_mul(self.limits.cost_micros_per_token)
                .ok_or("process cost overflow")?,
        };
        self.cost_micros = self
            .cost_micros
            .checked_add(cost)
            .ok_or("process cost overflow")?;
        self.awaiting_usage = false;
        self.check_usage()
    }

    /// Permit at most one tool per model request so parallel proposals cannot
    /// multiply the admitted effect allowance.
    pub fn admit_tools(&mut self, count: usize) -> Result<(), &'static str> {
        self.check_usage()?;
        let count = u32::try_from(count).map_err(|_| "process tool budget exhausted")?;
        let next = self
            .tool_calls
            .checked_add(count)
            .ok_or("process tool budget exhausted")?;
        if count > 1 || next > self.limits.max_requests || self.awaiting_usage {
            return Err("process tool budget exhausted");
        }
        self.tool_calls = next;
        Ok(())
    }

    /// The authenticated tool owner reports the same nominal duration cost
    /// used by Platform's process service. Replayed results never charge twice.
    pub fn charge_tool(&mut self, execution_id: &str, cost: u64) -> Result<(), &'static str> {
        if execution_id.is_empty() || self.awaiting_usage {
            return Err("invalid process tool usage");
        }
        if let Some(previous) = self.tool_costs.get(execution_id) {
            return if *previous == cost {
                Ok(())
            } else {
                Err("process tool usage changed on replay")
            };
        }
        let next = self
            .cost_micros
            .checked_add(cost)
            .ok_or("process cost overflow")?;
        self.tool_costs.insert(execution_id.to_owned(), cost);
        self.cost_micros = next;
        Ok(())
    }

    fn check_usage(&self) -> Result<(), &'static str> {
        if self.total_tokens > self.limits.max_total_tokens
            || self.cost_micros > self.limits.max_cost_micros
        {
            return Err("process token or cost budget exhausted");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn limits() -> ProcessBudgetLimits {
        ProcessBudgetLimits {
            event_id: "event-1".into(),
            max_requests: 2,
            max_total_tokens: 10,
            max_cost_micros: 20,
            cost_micros_per_token: 2,
        }
    }
    #[test]
    fn replay_cannot_reset_spent_budget_or_double_charge_usage() {
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        state.observe_usage(3, 2, None).unwrap();
        let checkpoint = serde_json::to_value(&state).unwrap();
        let mut restored: ProcessBudgetState = serde_json::from_value(checkpoint).unwrap();
        restored.install(&limits()).unwrap();
        assert_eq!(restored.total_tokens, 5);
        assert!(restored.observe_usage(3, 2, None).is_err());
        assert_eq!(restored.total_tokens, 5);
        restored.admit_request().unwrap();
        restored.observe_usage(2, 3, None).unwrap();
        assert!(restored.admit_request().is_err());
    }
    #[test]
    fn usage_blocks_effects_before_another_request_and_cannot_be_forgiven() {
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        assert!(state.admit_request().is_err());
        assert!(state.observe_usage(8, 3, None).is_err());
        assert_eq!(state.total_tokens, 11);
        assert!(state.admit_request().is_err());
        let mut widened = limits();
        widened.max_total_tokens = 100;
        assert!(state.install(&widened).is_err());
    }
    #[test]
    fn zero_limits_and_arithmetic_overflow_fail_closed() {
        let mut invalid = limits();
        invalid.max_requests = 0;
        assert!(ProcessBudgetState::new(invalid).is_err());
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        assert!(state.observe_usage(u64::MAX, 1, None).is_err());
        assert!(state.admit_request().is_err());
    }
    #[test]
    fn parallel_tool_proposals_cannot_multiply_the_iteration_budget() {
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        assert!(state.admit_tools(1).is_err());
        state.observe_usage(1, 1, None).unwrap();
        assert!(state.admit_tools(3).is_err());
        assert_eq!(state.tool_calls, 0);
        assert!(state.admit_tools(2).is_err());
        state.admit_tools(1).unwrap();
        state.admit_tools(1).unwrap();
        assert!(state.admit_tools(1).is_err());
    }
    #[test]
    fn provider_cost_is_authoritative_when_present() {
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        assert!(state.observe_usage(1, 1, Some(21)).is_err());
        assert_eq!(state.cost_micros, 21);
        assert!(state.admit_tools(1).is_err());
        assert!(state.admit_request().is_err());
    }

    #[test]
    fn tool_cost_is_charged_once_before_the_next_request() {
        let mut state = ProcessBudgetState::new(limits()).unwrap();
        state.admit_request().unwrap();
        state.observe_usage(1, 1, None).unwrap();
        state.admit_tools(1).unwrap();
        state.charge_tool("execution-1", 17).unwrap();
        assert_eq!(state.cost_micros, 21);
        state.charge_tool("execution-1", 17).unwrap();
        assert_eq!(state.cost_micros, 21);
        assert!(state.charge_tool("execution-1", 0).is_err());
        assert!(state.admit_request().is_err());
    }
}

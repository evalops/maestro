//! Per-turn step budget for the native agent loop.
//!
//! `NativeAgentRunner::run_loop` re-enters its `'turn: loop` every time the
//! model answers with tool calls, so a model that never stops calling tools
//! never ends the turn. The doom-loop detector in [`crate::agent::safety`]
//! only blocks three *identical* consecutive calls, and nothing else bounds
//! the loop: a model that alternates between two calls, or reads a different
//! path on every step, runs until the process is killed.
//!
//! This module owns the bound and the terminal value that reports it. The
//! bound is a count of provider round trips ("steps"), not of tool calls: one
//! step is one request/response pair, and a turn spends a step every time the
//! runner has to ask the model again with tool results.

use std::fmt;

/// Default ceiling on provider round trips inside one interactive turn.
///
/// Chosen well above any turn length the scenario corpus produces, so the
/// bound only fires on a run that is not making progress.
pub const DEFAULT_MAX_TURN_STEPS: usize = 200;

/// Why one interactive turn stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnOutcome {
    /// The model answered without requesting further tool calls.
    Completed,
    /// The turn reached its step budget while the model still wanted tools.
    StepBudgetExhausted {
        /// Provider round trips this turn actually executed.
        executed: usize,
        /// Round trips the turn would have needed to let the model finish.
        /// Always at least `executed + 1`, because the response that spent
        /// the last step still asked for more tool calls.
        requested: usize,
        /// Tool names from that last response, in call order. These calls
        /// were refused, not executed.
        unexecuted_tools: Vec<String>,
    },
}

impl fmt::Display for TurnOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Completed => formatter.write_str("turn_completed"),
            Self::StepBudgetExhausted {
                executed,
                requested,
                unexecuted_tools,
            } => {
                write!(
                    formatter,
                    "step_budget_exhausted: reached the per-turn budget of {executed} model \
                     responses before the turn ended (possible tool loop); the turn needed at \
                     least {requested}",
                )?;
                if unexecuted_tools.is_empty() {
                    Ok(())
                } else {
                    write!(
                        formatter,
                        ". These requested tool calls were not executed: {}",
                        unexecuted_tools.join(", "),
                    )
                }
            }
        }
    }
}

impl std::error::Error for TurnOutcome {}

/// Counts provider round trips inside one turn against a fixed ceiling.
#[derive(Debug, Clone, Copy)]
pub struct TurnStepBudget {
    max_steps: usize,
    executed: usize,
}

impl TurnStepBudget {
    /// Create a budget. `max_steps` below 1 is clamped to 1: a turn that may
    /// not make a single provider request is not a turn.
    #[must_use]
    pub fn new(max_steps: usize) -> Self {
        Self {
            max_steps: max_steps.max(1),
            executed: 0,
        }
    }

    /// Record that a provider round trip started.
    pub fn record_step(&mut self) {
        self.executed = self.executed.saturating_add(1);
    }

    /// Whether the turn can afford another round trip.
    ///
    /// Read this before executing a tool batch: executing tools the turn can
    /// never report back to the model produces work the model never sees.
    #[must_use]
    pub fn can_continue(&self) -> bool {
        self.executed < self.max_steps
    }

    /// Round trips executed so far in this turn.
    #[must_use]
    pub fn executed(&self) -> usize {
        self.executed
    }

    /// The configured ceiling.
    #[must_use]
    pub fn max_steps(&self) -> usize {
        self.max_steps
    }

    /// Start a fresh turn. A new user message resets the bound.
    pub fn reset(&mut self) {
        self.executed = 0;
    }

    /// Build the terminal outcome for a batch this budget cannot afford.
    #[must_use]
    pub fn exhausted(&self, unexecuted_tools: Vec<String>) -> TurnOutcome {
        TurnOutcome::StepBudgetExhausted {
            executed: self.executed,
            requested: self.executed.saturating_add(1),
            unexecuted_tools,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TurnOutcome, TurnStepBudget};

    #[test]
    fn budget_allows_exactly_max_steps_round_trips() {
        let mut budget = TurnStepBudget::new(3);
        for expected in 1..=3 {
            assert!(budget.can_continue());
            budget.record_step();
            assert_eq!(budget.executed(), expected);
        }
        assert!(!budget.can_continue());
    }

    #[test]
    fn zero_max_steps_is_clamped_to_one_request() {
        let mut budget = TurnStepBudget::new(0);
        assert_eq!(budget.max_steps(), 1);
        assert!(budget.can_continue());
        budget.record_step();
        assert!(!budget.can_continue());
    }

    #[test]
    fn reset_starts_a_new_turn_at_full_budget() {
        let mut budget = TurnStepBudget::new(2);
        budget.record_step();
        budget.record_step();
        assert!(!budget.can_continue());
        budget.reset();
        assert_eq!(budget.executed(), 0);
        assert!(budget.can_continue());
    }

    #[test]
    fn exhausted_outcome_names_the_counts_and_the_refused_tools() {
        let mut budget = TurnStepBudget::new(2);
        budget.record_step();
        budget.record_step();
        let outcome = budget.exhausted(vec!["read".to_string(), "bash".to_string()]);
        assert_eq!(
            outcome,
            TurnOutcome::StepBudgetExhausted {
                executed: 2,
                requested: 3,
                unexecuted_tools: vec!["read".to_string(), "bash".to_string()],
            }
        );
        let rendered = outcome.to_string();
        assert!(rendered.contains("step_budget_exhausted"), "{rendered}");
        assert!(
            rendered.contains("budget of 2 model responses"),
            "{rendered}"
        );
        assert!(rendered.contains("read, bash"), "{rendered}");
    }

    #[test]
    fn exhausted_outcome_without_refused_tools_omits_the_tool_sentence() {
        let outcome = TurnStepBudget::new(1).exhausted(Vec::new());
        let rendered = outcome.to_string();
        assert!(rendered.contains("step_budget_exhausted"), "{rendered}");
        assert!(!rendered.contains("not executed"), "{rendered}");
    }
}

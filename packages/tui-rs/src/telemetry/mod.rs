//! Wide Events Telemetry - Canonical Turn Events
//!
//! Implements the "wide events" pattern from loggingsucks.com:
//! Instead of scattered log statements, emit ONE rich event per agent turn
//! with comprehensive context for analytics-style querying.
//!
//! # Key Principles
//!
//! - One event per turn, not N log lines
//! - High-cardinality fields for queryability
//! - Tail sampling: always keep errors/slow, sample successes
//! - Optimized for querying, not writing
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::telemetry::{TurnCollector, TailSamplingConfig};
//!
//! let mut turn = TurnCollector::new("session-123", 1, TailSamplingConfig::default());
//! turn.set_model(ModelInfo {
//!     id: "claude-opus-4-5-20251101".to_string(),
//!     provider: "anthropic".to_string(),
//!     thinking_level: ThinkingLevel::Medium,
//! });
//!
//! // During tool execution
//! turn.record_tool_start("bash", "call-123", None);
//! // ... execute tool ...
//! turn.record_tool_end("call-123", true, None, None);
//!
//! // At turn end
//! let event = turn.complete(
//!     TurnStatus::Success,
//!     tokens,
//!     0.05,
//!     None,
//!     None,
//! );
//! ```

mod tracker;
mod wide_events;

pub use tracker::{TurnTracker, TurnTrackerConfig, TurnTrackerContext};
pub use wide_events::{
    AbortReason, ApprovalMode, CanonicalTurnEvent, ErrorDetails, FeatureFlags, ModelInfo,
    SampleReason, SandboxMode, TailSamplingConfig, ThinkingLevel, TokenUsage, ToolExecution,
    TurnCollector, TurnStatus,
};

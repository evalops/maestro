//! Context accounting primitives shared by the native Maestro runtime.
//!
//! This crate owns token estimation, model-aware token counting, memoized
//! counters, prepared-request accounting, context compaction, continuation
//! state, and summary framing. It remains independent of the TUI, provider
//! catalog, live agent loop, and tool policy.

pub mod compaction;
pub mod context_usage;
pub mod envelope;
pub mod token_counter;
pub mod token_counting;
pub mod token_estimation;

pub use compaction::{
    CompactionConfig, CompactionResult, ContextCompactor, ContinuationCommand, ContinuationRecord,
    CutPoint, allocate_summary_chars, build_continuation_record, extract_context_summary,
    render_context_summary,
};
pub use context_usage::RequestContextUsage;
pub use envelope::close_dangling_untrusted_content_envelope;
pub use token_counter::TokenCounter;

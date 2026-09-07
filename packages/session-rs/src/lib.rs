//! Local Maestro session persistence.
//!
//! This crate owns the native append-only JSONL session format, its readers,
//! writers, indexes, forks, branches, exports, and file-level checkpoints.
//! The format remains a local runtime concern: remote Session History is a
//! separate redacted transcript adapter, and Platform remains the authority
//! for hosted runs, policy, effects, receipts, and acceptance.

pub mod checkpoints;
pub mod fs_atomic;
pub mod session;

pub use checkpoints::{
    Checkpoint, CheckpointStore, EntryKind, FileEntry, PendingTurn, RestoreReport, begin_turn,
    checkpoints_for_turns, finalize_turn, fork_before_turn, preview_turns, restore_checkpoint,
    restore_latest, restore_turns,
};
pub use session::*;

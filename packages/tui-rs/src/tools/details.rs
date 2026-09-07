//! Compatibility re-exports for structured tool execution details.
//!
//! The value models are owned by `maestro-runtime-contracts` so session and runtime
//! consumers can persist receipts without depending on the TUI.  The
//! historical `maestro_tui::tools::details` paths remain available here.

pub use maestro_runtime::{
    BashDetails, BatchDetails, DiffDetails, EditDetails, GlobDetails, GrepDetails, ImageDetails,
    InlineToolDetails, ListDetails, ReadDetails, ToolDetails, WebFetchDetails, WriteDetails,
};

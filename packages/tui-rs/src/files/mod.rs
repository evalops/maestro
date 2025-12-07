//! File handling and @mention support
//!
//! Provides file search, listing, and attachment functionality.

mod search;
mod workspace;

pub use search::{FileMatch, FileSearch, FileSearchResult};
pub use workspace::{get_workspace_files, WorkspaceFile};

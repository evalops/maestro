//! File Handling and @mention Support
//!
//! This module provides file search, listing, and attachment functionality for the TUI.
//! It enables the `@` mention feature that allows users to quickly search for and reference
//! files in their workspace.
//!
//! # Features
//!
//! - **Workspace Indexing**: Recursively scans the project directory for files
//! - **Fuzzy File Search**: Fast, typo-tolerant file name matching
//! - **Git-Aware Filtering**: Respects `.gitignore` patterns and excludes common directories
//! - **Match Highlighting**: Highlights matching characters in search results
//!
//! # Architecture
//!
//! The module is split into two submodules:
//!
//! - `workspace`: Handles file discovery and indexing
//! - `search`: Implements fuzzy matching and result ranking
//!
//! ```text
//! ┌─────────────────────┐     ┌─────────────────────┐
//! │  FileSearchModal    │     │  WorkspaceFile      │
//! │  (UI component)     │     │  (File metadata)    │
//! └─────────────────────┘     └─────────────────────┘
//!           │                           │
//!           │                           │
//!           ▼                           ▼
//! ┌─────────────────────┐     ┌─────────────────────┐
//! │  FileSearch         │────>│  Workspace Scanner  │
//! │  (Fuzzy matching)   │     │  (File discovery)   │
//! └─────────────────────┘     └─────────────────────┘
//! ```
//!
//! # Usage Example
//!
//! ```rust,ignore
//! use composer_tui::files::{get_workspace_files, FileSearch, WorkspaceFile};
//!
//! // Index workspace files (typically done once at startup)
//! let files = get_workspace_files("/path/to/project", 10000);
//!
//! // Create a search instance
//! let mut search = FileSearch::new(files);
//!
//! // Perform a fuzzy search
//! let results = search.search("main.rs");
//!
//! // Results are sorted by relevance
//! for result in results.iter().take(10) {
//!     println!("{} (score: {})", result.file.relative_path, result.score);
//! }
//! ```
//!
//! # Performance Considerations
//!
//! - File indexing is bounded by `max_files` parameter to prevent memory issues
//! - Search results are cached until the query changes
//! - Fuzzy matching uses character-by-character scoring for accuracy
//! - Common build artifacts and `node_modules` are excluded by default
//!
//! # Rust Concepts Demonstrated
//!
//! - **Iterator Adapters**: Uses `filter_map`, `take`, and `enumerate` for efficient processing
//! - **Borrowing**: Search returns references to indexed files (no allocation on search)
//! - **Pattern Matching**: Fuzzy algorithm uses character-level pattern matching

mod search;
mod workspace;

pub use search::{highlight_matches, FileMatch, FileSearch, FileSearchResult};
pub use workspace::{get_workspace_files, patterns, WorkspaceFile};

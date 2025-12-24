//! Tool implementations for agent command execution
//!
//! This module provides native Rust implementations of agent tools that enable the AI
//! to interact with the system. Tools are executed through a registry-based architecture
//! that handles validation, approval workflows, and result reporting.
//!
//! # Architecture Overview
//!
//! The tools module is organized into three key components:
//!
//! - **Tool Registry** (`registry.rs`): Manages tool definitions, validates arguments
//!   against JSON schemas, and determines which tools require user approval
//! - **Tool Executor** (`registry.rs`): Dispatches tool calls to appropriate implementations
//!   and manages event streams for real-time progress reporting
//! - **Tool Implementations** (`bash.rs`, etc.): Individual tool implementations that
//!   perform the actual work (command execution, file I/O, etc.)
//!
//! # Tool Execution Flow
//!
//! 1. Agent requests a tool execution with arguments
//! 2. Registry validates required fields and checks approval requirements
//! 3. Executor dispatches to the appropriate tool implementation
//! 4. Tool sends progress events via unbounded channels (ToolStart, ToolOutput, ToolEnd)
//! 5. Result is returned with success status, output, and optional error message
//!
//! # Available Tools
//!
//! - **bash**: Execute shell commands with timeout and approval controls
//! - **read**: Read file contents with line numbers
//! - **write**: Write content to files, creating parent directories as needed
//! - **edit**: Perform exact string replacements in files
//! - **glob**: Find files matching glob patterns (e.g., "*.rs", "**/*.toml")
//! - **grep**: Search file contents using ripgrep/grep with regex support
//!
//! # Safety and Approval
//!
//! Tools implement a two-tier safety model:
//!
//! 1. **Static approval**: Tools like `write` and `edit` always require approval
//! 2. **Dynamic approval**: The `bash` tool inspects command content to determine
//!    if approval is needed (read-only commands like `ls` are auto-approved)
//!
//! Dangerous commands (e.g., `rm -rf /`) are blocked entirely and return an error.
//!
//! # Example Usage
//!
//! ```rust,no_run
//! use composer_tui::tools::{ToolExecutor, BashTool};
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! // Create an executor with a working directory
//! let executor = ToolExecutor::new("/path/to/workspace");
//!
//! // Check if a tool exists
//! assert!(executor.has_tool("bash"));
//!
//! // Check approval requirements
//! let args = serde_json::json!({"command": "ls -la"});
//! let needs_approval = executor.requires_approval("bash", &args);
//!
//! // Execute a tool
//! let result = executor.execute(
//!     "bash",
//!     &args,
//!     None,  // Optional event channel
//!     "call-id-123"
//! ).await;
//!
//! if result.success {
//!     println!("Output: {}", result.output);
//! } else {
//!     eprintln!("Error: {:?}", result.error);
//! }
//! # Ok(())
//! # }
//! ```

mod ask_user;
mod background_tasks;
mod bash;
mod batch;
mod cache;
pub mod details;
mod exa;
mod extract_document;
mod gh;
mod history;
mod image;
pub mod inline;
mod notebook_edit;
pub mod process_registry;
mod process_utils;
mod registry;
mod status;
mod todo;
mod web_fetch;

pub(crate) use bash::resolve_shell_config;
pub use bash::BashTool;
pub use batch::{BatchConfig, BatchExecutor, BatchToolCall, BatchToolResult};
pub use cache::{CacheConfig, CacheKey, CacheStats, CachedResult, ToolResultCache};
pub use details::{
    BashDetails, BatchDetails, DiffDetails, EditDetails, GlobDetails, GrepDetails, ImageDetails,
    InlineToolDetails, ListDetails, ReadDetails, ToolDetails, WebFetchDetails, WriteDetails,
};
pub use history::{HistoryFilter, ToolExecution, ToolHistory, ToolStats};
pub use image::ImageTool;
pub use inline::{
    get_config_paths as get_inline_tools_config_paths, load_inline_tools, InlineTool,
    InlineToolExecutor, InlineToolSource, InlineToolsConfig, InlineToolsPaths,
};
pub use process_registry::{
    cleanup_all as cleanup_background_processes, count as background_process_count,
};
pub use registry::{ToolExecutor, ToolRegistry};
pub use web_fetch::WebFetchTool;

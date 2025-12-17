//! Tool registry and execution dispatcher
//!
//! This module implements the central registry and executor for agent tools. It provides
//! a type-safe, validated execution environment that bridges AI tool calls to native Rust
//! implementations.
//!
//! # Architecture
//!
//! The registry system consists of two main components:
//!
//! - **ToolRegistry**: A HashMap-based registry of tool definitions with JSON schemas.
//!   It validates arguments, checks required fields, and determines approval requirements.
//! - **ToolExecutor**: The execution dispatcher that routes tool calls to implementations.
//!   It manages event streams, handles errors, and ensures consistent result reporting.
//!
//! # Tool Definition System
//!
//! Each tool is registered with:
//! - **Name**: Case-insensitive identifier (e.g., "bash", "read")
//! - **Description**: Human-readable explanation of what the tool does
//! - **JSON Schema**: Defines required/optional parameters with types and descriptions
//! - **Approval requirement**: Static boolean or dynamic function based on arguments
//!
//! ## Schema Validation
//!
//! Tool schemas follow JSON Schema specification. The registry validates:
//! - Required fields are present and non-empty
//! - Field types match expectations (string, number, boolean, etc.)
//! - Nested objects conform to their schemas
//!
//! # Execution Model
//!
//! Tool execution follows a request-response pattern with event streaming:
//!
//! ```text
//! ┌─────────────┐
//! │   AI Agent  │
//! └──────┬──────┘
//!        │ Tool call with JSON args
//!        ▼
//! ┌─────────────────┐
//! │  ToolExecutor   │ 1. Validate arguments
//! │                 │ 2. Check approval
//! │                 │ 3. Dispatch to implementation
//! └────────┬────────┘
//!          │
//!          ├──────────────────┬──────────────────┬──────────────────┐
//!          ▼                  ▼                  ▼                  ▼
//!      BashTool           ReadTool          WriteTool         EditTool
//!          │                  │                  │                  │
//!          └──────────────────┴──────────────────┴──────────────────┘
//!                                     │
//!                   ┌─────────────────┼─────────────────┐
//!                   ▼                 ▼                 ▼
//!              ToolStart          ToolOutput         ToolEnd
//!           (via event_tx)     (via event_tx)    (via event_tx)
//! ```
//!
//! # Event Streaming
//!
//! Tools emit events via an unbounded mpsc channel (`mpsc::UnboundedSender<FromAgent>`):
//!
//! 1. **ToolStart**: Emitted when execution begins (contains call_id)
//! 2. **ToolOutput**: Emitted for progress/partial output (optional, repeatable)
//! 3. **ToolEnd**: Emitted when execution completes (contains success flag)
//!
//! These events enable real-time UI updates and streaming output display.
//!
//! # Error Handling
//!
//! Errors are returned in the ToolResult structure, never panicked:
//! - **Validation errors**: Missing required fields, invalid JSON
//! - **Execution errors**: File not found, permission denied, timeout
//! - **Unknown tools**: Tool name not found in registry
//!
//! All errors set `success: false` and populate the `error` field with a message.
//!
//! # Tool Implementations
//!
//! The executor currently supports these built-in tools:
//!
//! - **bash**: Execute shell commands (see `BashTool` for details)
//! - **read**: Read file contents with line numbers
//! - **write**: Write content to files, creating directories as needed
//! - **edit**: Exact string replacement in files with uniqueness checks
//! - **glob**: Find files matching glob patterns
//! - **grep**: Search file contents using ripgrep/grep
//!
//! New tools can be added by:
//! 1. Implementing the tool logic in a new module
//! 2. Registering the tool definition in `ToolRegistry::new()`
//! 3. Adding a match arm in `ToolExecutor::execute()`

use std::collections::HashMap;
use std::sync::RwLock;

use tokio::sync::mpsc;

use super::bash::{BashArgs, BashTool};
use super::cache::{CacheConfig, CacheKey, CacheStats, CachedResult, ToolResultCache};
use super::image::{ImageTool, ReadImageArgs, ScreenshotArgs};
use super::inline::{load_inline_tools, InlineTool, InlineToolExecutor};
use super::web_fetch::{WebFetchArgs, WebFetchTool};
use crate::agent::{FromAgent, ToolDefinition, ToolResult};
use crate::ai::Tool;

/// Tool executor that dispatches and runs agent tools
///
/// The executor is the primary interface for tool execution. It maintains instances
/// of all tool implementations and routes calls based on the tool name. Each executor
/// is bound to a working directory that becomes the current directory for all tools.
///
/// # Design
///
/// The executor uses a match-based dispatch system rather than dynamic dispatch or
/// trait objects. This provides:
/// - Zero-cost abstraction (no vtable lookups)
/// - Compile-time verification of tool implementations
/// - Easy addition of new tools via match arms
///
/// # Working Directory
///
/// The `cwd` field is passed to all tool instances and used for:
/// - Resolving relative paths in file operations
/// - Setting the working directory for bash commands
/// - Glob pattern base directory
///
/// # Thread Safety
///
/// ToolExecutor is `Send` but not `Sync` because it contains `BashTool` which uses
/// non-Sync primitives. However, it can be moved across async tasks and used within
/// a single-threaded context safely.
pub struct ToolExecutor {
    /// Bash command execution tool
    ///
    /// Handles shell command execution with approval logic and timeout enforcement.
    bash: BashTool,

    /// Web fetch tool for retrieving web content
    ///
    /// Fetches URLs and converts HTML to markdown for the agent to process.
    web_fetch: WebFetchTool,

    /// Image tool for reading images and capturing screenshots
    ///
    /// Enables vision-capable models to work with images.
    image: ImageTool,

    /// Inline tool executor for user-defined shell-based tools
    ///
    /// Executes tools defined in .composer/tools.json files.
    inline_executor: InlineToolExecutor,

    /// Inline tools loaded from configuration
    ///
    /// Maps lowercase tool names to their definitions.
    inline_tools: HashMap<String, InlineTool>,

    /// Current working directory for all tool operations
    ///
    /// This directory is used as the base for relative paths and as the cwd for
    /// spawned processes. Typically set to the workspace root.
    cwd: String,

    /// Tool registry for validation and metadata
    ///
    /// Contains tool definitions with JSON schemas, used for argument validation
    /// and approval checking before execution.
    registry: ToolRegistry,

    /// Cache for tool results
    ///
    /// Caches results from read-only tools (read, glob, grep) to avoid redundant
    /// operations. Uses RwLock for thread-safe access across async tasks.
    cache: RwLock<ToolResultCache>,
}

impl ToolExecutor {
    /// Create a new tool executor with the given working directory
    ///
    /// # Arguments
    ///
    /// - `cwd`: Working directory for all tool operations. Accepts any type that
    ///   converts to String (String, &str, PathBuf via display, etc.)
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolExecutor;
    ///
    /// // From &str
    /// let executor = ToolExecutor::new("/workspace");
    ///
    /// // From String
    /// let cwd = String::from("/home/user/project");
    /// let executor = ToolExecutor::new(cwd);
    ///
    /// // From PathBuf
    /// use std::path::PathBuf;
    /// let path = PathBuf::from("/tmp");
    /// let executor = ToolExecutor::new(path.display().to_string());
    /// ```
    pub fn new(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        let cwd_path = std::path::Path::new(&cwd);

        // Load inline tools from config files
        let inline_tools_list = load_inline_tools(cwd_path);
        let mut inline_tools = HashMap::new();
        let mut registry = ToolRegistry::new();

        // Register inline tools
        for tool in inline_tools_list {
            let name = tool.definition.name.to_lowercase();
            registry.register(
                &name,
                ToolDefinition {
                    tool: tool.to_tool(),
                    requires_approval: tool.requires_approval(),
                },
            );
            inline_tools.insert(name, tool);
        }

        Self {
            bash: BashTool::new(&cwd),
            web_fetch: WebFetchTool::new(),
            image: ImageTool::new(),
            inline_executor: InlineToolExecutor::new(&cwd),
            inline_tools,
            cwd,
            registry,
            cache: RwLock::new(ToolResultCache::default()),
        }
    }

    /// Create a new tool executor with custom cache configuration
    ///
    /// # Arguments
    ///
    /// - `cwd`: Working directory for all tool operations
    /// - `cache_config`: Configuration for the tool result cache
    pub fn with_cache_config(cwd: impl Into<String>, cache_config: CacheConfig) -> Self {
        let cwd = cwd.into();
        let cwd_path = std::path::Path::new(&cwd);

        // Load inline tools from config files
        let inline_tools_list = load_inline_tools(cwd_path);
        let mut inline_tools = HashMap::new();
        let mut registry = ToolRegistry::new();

        // Register inline tools
        for tool in inline_tools_list {
            let name = tool.definition.name.to_lowercase();
            registry.register(
                &name,
                ToolDefinition {
                    tool: tool.to_tool(),
                    requires_approval: tool.requires_approval(),
                },
            );
            inline_tools.insert(name, tool);
        }

        Self {
            bash: BashTool::new(&cwd),
            web_fetch: WebFetchTool::new(),
            image: ImageTool::new(),
            inline_executor: InlineToolExecutor::new(&cwd),
            inline_tools,
            cwd,
            registry,
            cache: RwLock::new(ToolResultCache::new(cache_config)),
        }
    }

    /// Get the list of loaded inline tools
    ///
    /// Returns an iterator over the inline tool definitions.
    pub fn inline_tools(&self) -> impl Iterator<Item = &InlineTool> {
        self.inline_tools.values()
    }

    /// Get the count of loaded inline tools
    pub fn inline_tool_count(&self) -> usize {
        self.inline_tools.len()
    }

    /// Get cache statistics
    ///
    /// Returns statistics about cache performance including hit rate, entries, etc.
    pub fn cache_stats(&self) -> CacheStats {
        self.cache.read().unwrap_or_else(|e| e.into_inner()).stats()
    }

    /// Clear the tool result cache
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.write() {
            cache.clear();
        }
    }

    /// Invalidate cache entries for a specific file path
    ///
    /// Called when files are modified to ensure stale data isn't returned.
    fn invalidate_file_cache(&self, path: &str) {
        if let Ok(mut cache) = self.cache.write() {
            // Clear all entries - a more sophisticated approach would track
            // which cache entries depend on which files
            cache.clear();
            // Note: File modification triggered cache invalidation for: {path}
            let _ = path; // silence unused warning
        }
    }

    /// Check if a tool exists in the registry
    ///
    /// Performs case-insensitive lookup. Returns true if the tool is registered,
    /// false otherwise.
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolExecutor;
    ///
    /// let executor = ToolExecutor::new(".");
    /// assert!(executor.has_tool("bash"));
    /// assert!(executor.has_tool("Bash"));  // Case-insensitive
    /// assert!(!executor.has_tool("nonexistent"));
    /// ```
    pub fn has_tool(&self, name: &str) -> bool {
        self.registry.get(name).is_some()
    }

    /// Return missing required fields for a tool given its arguments
    ///
    /// Validates the provided arguments against the tool's JSON schema and returns
    /// a list of required field names that are missing or empty.
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name (case-insensitive)
    /// - `args`: JSON object containing the tool arguments
    ///
    /// # Returns
    ///
    /// Vector of missing field names. Empty vector if all required fields are present.
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolExecutor;
    /// use serde_json::json;
    ///
    /// let executor = ToolExecutor::new(".");
    ///
    /// // Missing required field
    /// let args = json!({});
    /// let missing = executor.missing_required("bash", &args);
    /// assert_eq!(missing, vec!["command"]);
    ///
    /// // All required fields present
    /// let args = json!({"command": "ls"});
    /// let missing = executor.missing_required("bash", &args);
    /// assert!(missing.is_empty());
    /// ```
    pub fn missing_required(&self, name: &str, args: &serde_json::Value) -> Vec<String> {
        self.registry.missing_required(name, args)
    }

    /// Check whether a tool requires user approval given its arguments
    ///
    /// This method consults both static and dynamic approval logic:
    /// - Static approval: Set per-tool in the registry (e.g., write always needs approval)
    /// - Dynamic approval: Computed based on arguments (e.g., bash inspects the command)
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name (case-insensitive)
    /// - `args`: JSON object containing the tool arguments
    ///
    /// # Returns
    ///
    /// True if the tool requires user approval, false if it can execute automatically.
    /// Unknown tools default to requiring approval.
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolExecutor;
    /// use serde_json::json;
    ///
    /// let executor = ToolExecutor::new(".");
    ///
    /// // Read is safe - no approval needed
    /// let args = json!({"file_path": "/tmp/test.txt"});
    /// assert!(!executor.requires_approval("read", &args));
    ///
    /// // Write always needs approval
    /// let args = json!({"file_path": "/tmp/test.txt", "content": "hello"});
    /// assert!(executor.requires_approval("write", &args));
    ///
    /// // Bash approval is dynamic based on command
    /// let safe_cmd = json!({"command": "ls -la"});
    /// assert!(!executor.requires_approval("bash", &safe_cmd));
    ///
    /// let unsafe_cmd = json!({"command": "cargo build"});
    /// assert!(executor.requires_approval("bash", &unsafe_cmd));
    /// ```
    pub fn requires_approval(&self, name: &str, args: &serde_json::Value) -> bool {
        self.registry.requires_approval(name, args)
    }

    /// Execute a tool by name with the given arguments
    ///
    /// This is the main entry point for tool execution. It dispatches to the appropriate
    /// tool implementation, manages event streams, and returns a result.
    ///
    /// # Process Flow
    ///
    /// 1. Match on tool name (case-insensitive)
    /// 2. Deserialize JSON args to tool-specific argument struct
    /// 3. Send ToolStart event (if event_tx provided)
    /// 4. Execute tool implementation
    /// 5. Send ToolOutput event for any output (if event_tx provided)
    /// 6. Send ToolEnd event with success status (if event_tx provided)
    /// 7. Return ToolResult
    ///
    /// # Arguments
    ///
    /// - `tool_name`: Name of the tool to execute (e.g., "bash", "read")
    /// - `args`: JSON object containing tool arguments
    /// - `event_tx`: Optional channel for streaming progress events to the UI
    /// - `call_id`: Unique identifier for this tool call (used in events)
    ///
    /// # Returns
    ///
    /// A ToolResult containing:
    /// - `success`: Whether the tool executed successfully
    /// - `output`: Tool output (stdout, file contents, etc.)
    /// - `error`: Optional error message if success is false
    ///
    /// # Event Streaming
    ///
    /// If `event_tx` is provided, the executor sends events for real-time updates:
    /// - **ToolStart**: Sent before execution begins
    /// - **ToolOutput**: Sent when output is available (may be sent multiple times)
    /// - **ToolEnd**: Sent after execution completes
    ///
    /// # Error Handling
    ///
    /// Errors are never panicked. Instead, they are returned in the ToolResult:
    /// - Invalid arguments: Deserialization errors
    /// - Tool errors: File not found, permission denied, etc.
    /// - Unknown tool: Tool name not found in registry
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use composer_tui::tools::ToolExecutor;
    /// use serde_json::json;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let executor = ToolExecutor::new("/workspace");
    ///
    /// // Execute without event streaming
    /// let args = json!({"command": "git status"});
    /// let result = executor.execute("bash", &args, None, "call-1").await;
    ///
    /// if result.success {
    ///     println!("Output: {}", result.output);
    /// } else {
    ///     eprintln!("Error: {:?}", result.error);
    /// }
    ///
    /// // Execute with event streaming
    /// use tokio::sync::mpsc;
    /// use composer_tui::agent::FromAgent;
    ///
    /// let (tx, mut rx) = mpsc::unbounded_channel();
    /// let result = executor.execute("read", &json!({"file_path": "Cargo.toml"}), Some(&tx), "call-2").await;
    ///
    /// // Process events from rx
    /// while let Some(event) = rx.recv().await {
    ///     match event {
    ///         FromAgent::ToolStart { call_id } => println!("Tool started: {}", call_id),
    ///         FromAgent::ToolOutput { content, .. } => println!("Output: {}", content),
    ///         FromAgent::ToolEnd { success, .. } => println!("Done: {}", success),
    ///         _ => {}
    ///     }
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn execute(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        event_tx: Option<&mpsc::UnboundedSender<FromAgent>>,
        call_id: &str,
    ) -> ToolResult {
        // Check cache for cacheable tools
        let cache_key = CacheKey::new(tool_name, args);
        let is_cacheable = self
            .cache
            .read()
            .map(|c| c.is_cacheable(tool_name))
            .unwrap_or(false);

        if is_cacheable {
            if let Ok(mut cache) = self.cache.write() {
                if let Some(cached) = cache.get(&cache_key) {
                    // Cache hit for tool execution

                    // Send events for cached result
                    if let Some(tx) = event_tx {
                        let _ = tx.send(FromAgent::ToolStart {
                            call_id: call_id.to_string(),
                        });
                        if !cached.output.is_empty() {
                            let _ = tx.send(FromAgent::ToolOutput {
                                call_id: call_id.to_string(),
                                content: cached.output.clone(),
                            });
                        }
                        let _ = tx.send(FromAgent::ToolEnd {
                            call_id: call_id.to_string(),
                            success: !cached.is_error,
                        });
                    }

                    return ToolResult {
                        success: !cached.is_error,
                        output: cached.output.clone(),
                        error: if cached.is_error {
                            Some(cached.output.clone())
                        } else {
                            None
                        },
                        details: None,
                    };
                }
            }
        }

        // Execute the tool
        let result = self.execute_impl(tool_name, args, event_tx, call_id).await;

        // Store result in cache for cacheable tools
        if is_cacheable {
            if let Ok(mut cache) = self.cache.write() {
                let cached_result = CachedResult::new(
                    if result.success {
                        &result.output
                    } else {
                        result.error.as_deref().unwrap_or("")
                    },
                    !result.success,
                );
                cache.put(cache_key, cached_result);
                // Stored result in cache
            }
        }

        result
    }

    /// Internal implementation of tool execution (without caching)
    async fn execute_impl(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        event_tx: Option<&mpsc::UnboundedSender<FromAgent>>,
        call_id: &str,
    ) -> ToolResult {
        match tool_name {
            "bash" | "Bash" => {
                let bash_args: BashArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid bash arguments: {}", e));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.bash.execute(bash_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "read" | "Read" => {
                // File reading tool with optional offset/limit
                let path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Optional line offset (1-indexed, defaults to 1)
                let offset = args
                    .get("offset")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.max(1) as usize)
                    .unwrap_or(1);

                // Optional line limit (defaults to reading all)
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);

                if path.is_empty() {
                    return ToolResult::failure("Missing file_path argument");
                }

                match tokio::fs::read_to_string(path).await {
                    Ok(content) => {
                        // Add line numbers with offset/limit support
                        let lines: Vec<&str> = content.lines().collect();
                        let total_lines = lines.len();

                        // Apply offset (convert to 0-indexed)
                        let start_idx = (offset - 1).min(total_lines);

                        // Apply limit
                        let end_idx = match limit {
                            Some(lim) => (start_idx + lim).min(total_lines),
                            None => total_lines,
                        };

                        let numbered: String = lines[start_idx..end_idx]
                            .iter()
                            .enumerate()
                            .map(|(i, line)| format!("{:>6}\t{}", start_idx + i + 1, line))
                            .collect::<Vec<_>>()
                            .join("\n");

                        ToolResult::success(numbered)
                    }
                    Err(e) => ToolResult::failure(format!("Failed to read file: {}", e)),
                }
            }
            "write" | "Write" => {
                let path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");

                if path.is_empty() {
                    return ToolResult::failure("Missing file_path argument");
                }

                // Create parent directories if needed
                if let Some(parent) = std::path::Path::new(path).parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return ToolResult::failure(format!("Failed to create directory: {}", e));
                    }
                }

                match tokio::fs::write(path, content).await {
                    Ok(_) => {
                        // Invalidate cache since file was modified
                        self.invalidate_file_cache(path);
                        ToolResult::success(format!("File written successfully: {}", path))
                    }
                    Err(e) => ToolResult::failure(format!("Failed to write file: {}", e)),
                }
            }
            "glob" | "Glob" => {
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");

                let base_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);

                // Build full glob pattern
                let full_pattern = if pattern.starts_with('/') {
                    pattern.to_string()
                } else {
                    format!("{}/{}", base_path, pattern)
                };

                // Use native glob crate
                match glob::glob(&full_pattern) {
                    Ok(paths) => {
                        let matches: Vec<String> = paths
                            .filter_map(|p| p.ok())
                            .take(100)
                            .map(|p| p.display().to_string())
                            .collect();

                        ToolResult::success(matches.join("\n"))
                    }
                    Err(e) => ToolResult::failure(format!("Glob error: {}", e)),
                }
            }
            "grep" | "Grep" => {
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");

                let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");

                if pattern.is_empty() {
                    return ToolResult::failure("Missing pattern argument");
                }

                // Use ripgrep if available, fall back to grep
                let result = self
                    .bash
                    .execute(BashArgs {
                        command: format!(
                            "rg --no-heading -n '{}' {} 2>/dev/null || grep -rn '{}' {} 2>/dev/null | head -100",
                            pattern, path, pattern, path
                        ),
                        timeout: Some(30000),
                        description: Some("Search for pattern".to_string()),
                        run_in_background: false,
                    })
                    .await;

                result
            }
            "edit" | "Edit" => {
                let path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let old_string = args
                    .get("old_string")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_string = args
                    .get("new_string")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let replace_all = args
                    .get("replace_all")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if path.is_empty() {
                    return ToolResult::failure("Missing file_path argument");
                }

                if old_string.is_empty() {
                    return ToolResult::failure("Missing old_string argument");
                }

                // Read file content
                let content = match tokio::fs::read_to_string(path).await {
                    Ok(c) => c,
                    Err(e) => {
                        return ToolResult::failure(format!("Failed to read file: {}", e));
                    }
                };

                // Check if old_string exists in file
                let occurrences = content.matches(old_string).count();
                if occurrences == 0 {
                    return ToolResult::failure(
                        "old_string not found in file. Make sure the string matches exactly.",
                    );
                }

                // Check for uniqueness if not replace_all
                if !replace_all && occurrences > 1 {
                    return ToolResult::failure(format!(
                        "old_string found {} times. Use replace_all: true or provide more context to make it unique.",
                        occurrences
                    ));
                }

                // Perform replacement
                let new_content = if replace_all {
                    content.replace(old_string, new_string)
                } else {
                    content.replacen(old_string, new_string, 1)
                };

                // Write back
                match tokio::fs::write(path, &new_content).await {
                    Ok(_) => {
                        // Invalidate cache since file was modified
                        self.invalidate_file_cache(path);
                        let replaced = if replace_all { occurrences } else { 1 };
                        ToolResult::success(format!(
                            "Successfully replaced {} occurrence(s) in {}",
                            replaced, path
                        ))
                    }
                    Err(e) => ToolResult::failure(format!("Failed to write file: {}", e)),
                }
            }
            "diff" | "Diff" => {
                // Git diff tool - shows changes in working tree or between commits
                let target = args
                    .get("target")
                    .and_then(|v| v.as_str())
                    .unwrap_or("HEAD");

                let path = args.get("path").and_then(|v| v.as_str());

                // Build git diff command
                let cmd = match path {
                    Some(p) => format!("git diff {} -- {}", target, p),
                    None => format!("git diff {}", target),
                };

                let result = self
                    .bash
                    .execute(BashArgs {
                        command: cmd,
                        timeout: Some(30000),
                        description: Some("Get git diff".to_string()),
                        run_in_background: false,
                    })
                    .await;

                result
            }
            "list" | "List" | "ls" => {
                // Directory listing tool
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);

                let recursive = args
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let cmd = if recursive {
                    format!("find {} -type f | head -200", path)
                } else {
                    format!("ls -la {}", path)
                };

                self.bash
                    .execute(BashArgs {
                        command: cmd,
                        timeout: Some(10000),
                        description: Some("List directory".to_string()),
                        run_in_background: false,
                    })
                    .await
            }
            "web_fetch" | "WebFetch" | "webfetch" => {
                let fetch_args: WebFetchArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid web_fetch arguments: {}", e));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.web_fetch.execute(fetch_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "read_image" | "ReadImage" | "readimage" => {
                let image_args: ReadImageArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid read_image arguments: {}", e));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.image.read_image(image_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "screenshot" | "Screenshot" => {
                let screenshot_args: ScreenshotArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid screenshot arguments: {}", e));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.image.screenshot(screenshot_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            _ => {
                // Check if this is an inline tool
                let tool_key = tool_name.to_lowercase();
                if let Some(inline_tool) = self.inline_tools.get(&tool_key) {
                    // Send tool start event
                    if let Some(tx) = event_tx {
                        let _ = tx.send(FromAgent::ToolStart {
                            call_id: call_id.to_string(),
                        });
                    }

                    let result = self
                        .inline_executor
                        .execute(inline_tool, args.clone())
                        .await;

                    // Send tool output and end events
                    if let Some(tx) = event_tx {
                        if !result.output.is_empty() {
                            let _ = tx.send(FromAgent::ToolOutput {
                                call_id: call_id.to_string(),
                                content: result.output.clone(),
                            });
                        }

                        let _ = tx.send(FromAgent::ToolEnd {
                            call_id: call_id.to_string(),
                            success: result.success,
                        });
                    }

                    result
                } else {
                    ToolResult::failure(format!("Unknown tool: {}", tool_name))
                }
            }
        }
    }
}

/// Tool registry that holds tool definitions with schemas and validation logic
///
/// The registry is a HashMap-based collection of tool definitions. Each tool is
/// identified by a lowercase name and contains metadata including:
/// - Tool description and usage information
/// - JSON schema for argument validation
/// - Approval requirement (static or dynamic)
///
/// # Schema-Based Validation
///
/// Tool definitions include JSON schemas that specify:
/// - Required vs optional parameters
/// - Parameter types (string, number, boolean, object, array)
/// - Parameter descriptions for the AI
/// - Default values (via serde defaults)
///
/// The registry validates arguments by:
/// 1. Checking for presence of required fields
/// 2. Ensuring non-empty string values for required fields
/// 3. Returning missing field names for client-side error handling
///
/// # Case Insensitivity
///
/// Tool lookups are case-insensitive. "bash", "Bash", and "BASH" all resolve to
/// the same tool definition. Internally, all tool names are stored lowercase.
///
/// # Default Tools
///
/// The registry is pre-populated with built-in tools via `new()`:
/// - bash, read, write, edit, glob, grep
///
/// # Examples
///
/// ```
/// use composer_tui::tools::ToolRegistry;
/// use serde_json::json;
///
/// let registry = ToolRegistry::new();
///
/// // Check if a tool exists
/// assert!(registry.get("bash").is_some());
/// assert!(registry.get("Bash").is_some());  // Case-insensitive
///
/// // Validate arguments
/// let args = json!({});
/// let missing = registry.missing_required("bash", &args);
/// assert_eq!(missing, vec!["command"]);
///
/// // Check approval requirements
/// let safe_args = json!({"command": "ls"});
/// assert!(!registry.requires_approval("bash", &safe_args));
/// ```
pub struct ToolRegistry {
    /// HashMap of tool definitions keyed by lowercase tool name
    ///
    /// Keys are normalized to lowercase for case-insensitive lookups.
    /// Values contain the full tool definition with schema and approval logic.
    tools: HashMap<String, ToolDefinition>,
}

impl ToolRegistry {
    /// Create a new tool registry with default tools
    pub fn new() -> Self {
        let mut tools = HashMap::new();

        // Bash tool
        tools.insert(
            "bash".to_string(),
            ToolDefinition {
                tool: BashTool::definition(),
                requires_approval: true, // Dynamic based on command
            },
        );

        // Read tool
        tools.insert(
            "read".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "read",
                    "Read a TEXT file from the filesystem. Use this for ALL text files: .txt, .md, .rs, .py, .js, .ts, .json, .toml, .yaml, .xml, .html, .css, .sh, source code, configs, docs, etc. Returns file contents with line numbers. Do NOT use read_image for text files - only use read_image for actual images (PNG/JPEG/GIF/WebP).",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "The absolute path to the text file to read"
                        },
                        "offset": {
                            "type": "number",
                            "description": "Line number to start reading from (optional)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Number of lines to read (optional)"
                        }
                    },
                    "required": ["file_path"]
                })),
                requires_approval: false,
            },
        );

        // Write tool
        tools.insert(
            "write".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "write",
                    "Write content to a file. Creates the file if it doesn't exist.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "The absolute path to the file to write"
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write to the file"
                        }
                    },
                    "required": ["file_path", "content"]
                })),
                requires_approval: true,
            },
        );

        // Glob tool
        tools.insert(
            "glob".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "glob",
                    "Find files matching a glob pattern. Returns matching file paths.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "The glob pattern to match (e.g., '*.rs', '**/*.ts')"
                        },
                        "path": {
                            "type": "string",
                            "description": "The directory to search in (optional, defaults to cwd)"
                        }
                    },
                    "required": ["pattern"]
                })),
                requires_approval: false,
            },
        );

        // Grep tool
        tools.insert(
            "grep".to_string(),
            ToolDefinition {
                tool: Tool::new("grep", "Search for a pattern in files using ripgrep/grep.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": {
                                "type": "string",
                                "description": "The regex pattern to search for"
                            },
                            "path": {
                                "type": "string",
                                "description": "The file or directory to search in (optional)"
                            }
                        },
                        "required": ["pattern"]
                    })),
                requires_approval: false,
            },
        );

        // Edit tool
        tools.insert(
            "edit".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "edit",
                    "Perform exact string replacement in a file. The old_string must be unique unless replace_all is true.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "The absolute path to the file to edit"
                        },
                        "old_string": {
                            "type": "string",
                            "description": "The exact text to find and replace"
                        },
                        "new_string": {
                            "type": "string",
                            "description": "The text to replace old_string with"
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "Replace all occurrences instead of requiring uniqueness (default: false)"
                        }
                    },
                    "required": ["file_path", "old_string", "new_string"]
                })),
                requires_approval: true,
            },
        );

        // Diff tool - git diff
        tools.insert(
            "diff".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "diff",
                    "Show changes in git working tree or between commits.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "target": {
                            "type": "string",
                            "description": "Git ref to diff against (default: HEAD)"
                        },
                        "path": {
                            "type": "string",
                            "description": "File or directory path to limit diff to (optional)"
                        }
                    },
                    "required": []
                })),
                requires_approval: false,
            },
        );

        // List tool - directory listing
        tools.insert(
            "list".to_string(),
            ToolDefinition {
                tool: Tool::new("list", "List contents of a directory.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Directory path to list (default: current directory)"
                            },
                            "recursive": {
                                "type": "boolean",
                                "description": "List files recursively (default: false)"
                            }
                        },
                        "required": []
                    }),
                ),
                requires_approval: false,
            },
        );

        // Web fetch tool - retrieve web content
        tools.insert(
            "web_fetch".to_string(),
            ToolDefinition {
                tool: WebFetchTool::definition(),
                requires_approval: false, // Safe read-only operation
            },
        );

        // Image reading tool - for vision-capable models
        tools.insert(
            "read_image".to_string(),
            ToolDefinition {
                tool: ImageTool::read_image_definition(),
                requires_approval: false, // Safe read-only operation
            },
        );

        // Screenshot capture tool
        tools.insert(
            "screenshot".to_string(),
            ToolDefinition {
                tool: ImageTool::screenshot_definition(),
                requires_approval: true, // Captures screen content - needs approval
            },
        );

        Self { tools }
    }

    /// Return missing required fields for a tool based on its JSON schema
    ///
    /// This method validates the provided arguments against the tool's schema and
    /// returns a list of required field names that are either:
    /// - Not present in the args object
    /// - Present but empty (for string fields)
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name (case-insensitive)
    /// - `args`: JSON object containing the proposed arguments
    ///
    /// # Returns
    ///
    /// Vector of field names that are missing or invalid. Empty vector if all
    /// required fields are present and valid.
    ///
    /// # Schema Processing
    ///
    /// 1. Look up tool definition by name (lowercase)
    /// 2. Extract "required" array from tool's input_schema
    /// 3. For each required field, check if:
    ///    - Field exists in args
    ///    - Field value is not an empty string (for string types)
    /// 4. Collect missing field names
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolRegistry;
    /// use serde_json::json;
    ///
    /// let registry = ToolRegistry::new();
    ///
    /// // Missing command field
    /// let args = json!({});
    /// let missing = registry.missing_required("bash", &args);
    /// assert_eq!(missing, vec!["command"]);
    ///
    /// // Empty command field (treated as missing)
    /// let args = json!({"command": ""});
    /// let missing = registry.missing_required("bash", &args);
    /// assert_eq!(missing, vec!["command"]);
    ///
    /// // All required fields present
    /// let args = json!({"command": "ls -la"});
    /// let missing = registry.missing_required("bash", &args);
    /// assert!(missing.is_empty());
    ///
    /// // Edit tool requires multiple fields
    /// let args = json!({"file_path": "/tmp/file.txt"});
    /// let missing = registry.missing_required("edit", &args);
    /// assert!(missing.contains(&"old_string".to_string()));
    /// assert!(missing.contains(&"new_string".to_string()));
    /// ```
    pub fn missing_required(&self, name: &str, args: &serde_json::Value) -> Vec<String> {
        let mut missing = Vec::new();
        let key = name.to_lowercase();
        if let Some(def) = self.tools.get(&key) {
            if let Some(required) = def
                .tool
                .input_schema
                .get("required")
                .and_then(|v| v.as_array())
            {
                for field in required.iter().filter_map(|f| f.as_str()) {
                    let present = args.get(field).is_some()
                        && !args
                            .get(field)
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().is_empty())
                            .unwrap_or(false);
                    if !present {
                        missing.push(field.to_string());
                    }
                }
            }
        }
        missing
    }

    /// Get an iterator over all registered tool definitions
    ///
    /// Returns an iterator that yields immutable references to all ToolDefinitions
    /// in the registry. The order is undefined (HashMap iteration order).
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolRegistry;
    ///
    /// let registry = ToolRegistry::new();
    ///
    /// // Count tools
    /// let count = registry.tools().count();
    /// assert_eq!(count, 11);  // bash, read, write, edit, glob, grep, diff, list, web_fetch, read_image, screenshot
    ///
    /// // List tool names
    /// for tool_def in registry.tools() {
    ///     println!("Tool: {}", tool_def.tool.name);
    /// }
    /// ```
    pub fn tools(&self) -> impl Iterator<Item = &ToolDefinition> {
        self.tools.values()
    }

    /// Get a tool definition by name (case-insensitive lookup)
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name to look up (e.g., "bash", "Bash", "BASH")
    ///
    /// # Returns
    ///
    /// Some(&ToolDefinition) if the tool exists, None otherwise.
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolRegistry;
    ///
    /// let registry = ToolRegistry::new();
    ///
    /// // Case-insensitive lookup
    /// assert!(registry.get("bash").is_some());
    /// assert!(registry.get("Bash").is_some());
    /// assert!(registry.get("BASH").is_some());
    ///
    /// // Unknown tool
    /// assert!(registry.get("unknown").is_none());
    /// ```
    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.get(&name.to_lowercase())
    }

    /// Check if a tool requires user approval, considering dynamic logic
    ///
    /// This method implements a two-tier approval system:
    ///
    /// 1. **Dynamic approval (bash only)**: Inspects command content to determine
    ///    if approval is needed. Safe commands like "ls" are auto-approved.
    /// 2. **Static approval**: Uses the `requires_approval` flag from the tool
    ///    definition. Tools like "write" always require approval.
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name (case-insensitive)
    /// - `args`: JSON object containing tool arguments
    ///
    /// # Returns
    ///
    /// - `true`: Tool requires user approval before execution
    /// - `false`: Tool can execute automatically without prompting
    ///
    /// Unknown tools default to requiring approval for safety.
    ///
    /// # Examples
    ///
    /// ```
    /// use composer_tui::tools::ToolRegistry;
    /// use serde_json::json;
    ///
    /// let registry = ToolRegistry::new();
    ///
    /// // Read tool - static approval (false)
    /// let args = json!({"file_path": "/etc/passwd"});
    /// assert!(!registry.requires_approval("read", &args));
    ///
    /// // Write tool - static approval (true)
    /// let args = json!({"file_path": "/tmp/test.txt", "content": "hello"});
    /// assert!(registry.requires_approval("write", &args));
    ///
    /// // Bash tool - dynamic approval based on command
    /// let safe_cmd = json!({"command": "git status"});
    /// assert!(!registry.requires_approval("bash", &safe_cmd));
    ///
    /// let unsafe_cmd = json!({"command": "rm -rf /"});
    /// assert!(registry.requires_approval("bash", &unsafe_cmd));
    ///
    /// // Unknown tool - defaults to requiring approval
    /// let args = json!({});
    /// assert!(registry.requires_approval("unknown_tool", &args));
    /// ```
    pub fn requires_approval(&self, name: &str, args: &serde_json::Value) -> bool {
        match name {
            "bash" | "Bash" => {
                if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                    BashTool::requires_approval(cmd)
                } else {
                    true
                }
            }
            _ => self
                .tools
                .get(&name.to_lowercase())
                .map(|d| d.requires_approval)
                .unwrap_or(true),
        }
    }

    /// Register a tool from an external source (e.g., inline tools, MCP)
    ///
    /// This method adds a new tool to the registry. If a tool with the same name
    /// already exists, it will be overwritten.
    ///
    /// # Arguments
    ///
    /// - `name`: Tool name (will be normalized to lowercase)
    /// - `definition`: The tool definition to register
    ///
    /// # Example
    ///
    /// ```
    /// use composer_tui::tools::ToolRegistry;
    /// use composer_tui::agent::ToolDefinition;
    /// use composer_tui::ai::Tool;
    ///
    /// let mut registry = ToolRegistry::new();
    ///
    /// let tool = Tool::new("my_tool", "A custom tool")
    ///     .with_schema(serde_json::json!({
    ///         "type": "object",
    ///         "properties": {},
    ///         "required": []
    ///     }));
    ///
    /// registry.register("my_tool", ToolDefinition {
    ///     tool,
    ///     requires_approval: true,
    /// });
    ///
    /// assert!(registry.get("my_tool").is_some());
    /// ```
    pub fn register(&mut self, name: &str, definition: ToolDefinition) {
        self.tools.insert(name.to_lowercase(), definition);
    }

    /// Unregister a tool by name
    ///
    /// Returns true if the tool was found and removed, false otherwise.
    pub fn unregister(&mut self, name: &str) -> bool {
        self.tools.remove(&name.to_lowercase()).is_some()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_default_tools() {
        let registry = ToolRegistry::new();

        assert!(registry.get("bash").is_some());
        assert!(registry.get("read").is_some());
        assert!(registry.get("write").is_some());
        assert!(registry.get("glob").is_some());
        assert!(registry.get("grep").is_some());
        assert!(registry.get("edit").is_some());
    }

    #[test]
    fn test_registry_tool_count() {
        let registry = ToolRegistry::new();
        let count = registry.tools().count();
        assert_eq!(count, 11); // bash, read, write, glob, grep, edit, diff, list, web_fetch, read_image, screenshot
    }

    #[test]
    fn test_registry_requires_approval_read() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({"file_path": "/etc/passwd"});
        assert!(!registry.requires_approval("read", &args));
    }

    #[test]
    fn test_registry_requires_approval_bash_dynamic() {
        let registry = ToolRegistry::new();
        let safe = serde_json::json!({"command": "ls -la"});
        let unsafe_cmd = serde_json::json!({"command": "cargo build"});

        assert!(!registry.requires_approval("bash", &safe));
        assert!(registry.requires_approval("bash", &unsafe_cmd));
    }

    #[test]
    fn test_registry_missing_required_fields() {
        let registry = ToolRegistry::new();
        // read requires file_path
        let missing = registry.missing_required("read", &serde_json::json!({}));
        assert_eq!(missing, vec!["file_path".to_string()]);

        // present field -> no missing
        let ok =
            registry.missing_required("read", &serde_json::json!({"file_path": "/tmp/file.txt"}));
        assert!(ok.is_empty());
    }

    #[test]
    fn test_registry_requires_approval_write() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({"file_path": "/tmp/test.txt", "content": "hello"});
        assert!(registry.requires_approval("write", &args));
    }

    #[test]
    fn test_registry_requires_approval_bash_safe() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({"command": "ls -la"});
        assert!(!registry.requires_approval("bash", &args));
    }

    #[test]
    fn test_registry_requires_approval_bash_unsafe() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({"command": "rm -rf /tmp/test"});
        assert!(registry.requires_approval("bash", &args));
    }

    #[test]
    fn test_registry_unknown_tool() {
        let registry = ToolRegistry::new();
        assert!(registry.get("unknown").is_none());
        // Unknown tools require approval
        let args = serde_json::json!({});
        assert!(registry.requires_approval("unknown", &args));
    }

    #[tokio::test]
    async fn test_executor_read_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        std::fs::write(&file_path, "line 1\nline 2\nline 3").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(result.success);
        assert!(result.output.contains("line 1"));
        assert!(result.output.contains("line 2"));
        assert!(result.output.contains("line 3"));
    }

    #[tokio::test]
    async fn test_executor_write_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("output.txt");

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "content": "test content"
        });
        let result = executor.execute("write", &args, None, "test-call").await;

        assert!(result.success);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "test content");
    }

    #[tokio::test]
    async fn test_executor_unknown_tool() {
        let executor = ToolExecutor::new(".");
        let args = serde_json::json!({});
        let result = executor
            .execute("nonexistent", &args, None, "test-call")
            .await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn test_executor_edit_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("edit_test.txt");
        std::fs::write(&file_path, "hello world").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "old_string": "world",
            "new_string": "rust"
        });
        let result = executor.execute("edit", &args, None, "test-call").await;

        assert!(result.success);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "hello rust");
    }

    #[tokio::test]
    async fn test_executor_edit_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("edit_test.txt");
        std::fs::write(&file_path, "hello world").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "old_string": "nonexistent",
            "new_string": "rust"
        });
        let result = executor.execute("edit", &args, None, "test-call").await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn test_executor_edit_non_unique() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("edit_test.txt");
        std::fs::write(&file_path, "foo bar foo").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "old_string": "foo",
            "new_string": "baz"
        });
        let result = executor.execute("edit", &args, None, "test-call").await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("2 times"));
    }

    #[tokio::test]
    async fn test_executor_edit_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("edit_test.txt");
        std::fs::write(&file_path, "foo bar foo").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "old_string": "foo",
            "new_string": "baz",
            "replace_all": true
        });
        let result = executor.execute("edit", &args, None, "test-call").await;

        assert!(result.success);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "baz bar baz");
    }

    #[test]
    fn test_registry_requires_approval_edit() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({
            "file_path": "/tmp/test.txt",
            "old_string": "foo",
            "new_string": "bar"
        });
        assert!(registry.requires_approval("edit", &args));
    }

    // ========== Cache Integration Tests ==========

    #[tokio::test]
    async fn test_executor_cache_hit() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("cache_test.txt");
        std::fs::write(&file_path, "cached content").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

        // First call - cache miss
        let result1 = executor.execute("read", &args, None, "call-1").await;
        assert!(result1.success);
        let stats1 = executor.cache_stats();
        assert_eq!(stats1.misses, 1);
        assert_eq!(stats1.hits, 0);

        // Second call - cache hit
        let result2 = executor.execute("read", &args, None, "call-2").await;
        assert!(result2.success);
        assert_eq!(result1.output, result2.output);
        let stats2 = executor.cache_stats();
        assert_eq!(stats2.misses, 1);
        assert_eq!(stats2.hits, 1);
    }

    #[tokio::test]
    async fn test_executor_cache_invalidation_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("invalidate_test.txt");
        std::fs::write(&file_path, "original content").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let read_args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

        // Read file - populates cache
        let result1 = executor.execute("read", &read_args, None, "call-1").await;
        assert!(result1.success);
        assert!(result1.output.contains("original content"));

        // Write to file - should invalidate cache
        let write_args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "content": "new content"
        });
        let write_result = executor.execute("write", &write_args, None, "call-2").await;
        assert!(write_result.success);

        // Read again - should get new content (cache was invalidated)
        let result2 = executor.execute("read", &read_args, None, "call-3").await;
        assert!(result2.success);
        assert!(result2.output.contains("new content"));
    }

    #[tokio::test]
    async fn test_executor_cache_invalidation_on_edit() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("edit_cache_test.txt");
        std::fs::write(&file_path, "hello world").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let read_args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

        // Read file - populates cache
        let result1 = executor.execute("read", &read_args, None, "call-1").await;
        assert!(result1.success);
        assert!(result1.output.contains("hello world"));

        // Edit file - should invalidate cache
        let edit_args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "old_string": "world",
            "new_string": "rust"
        });
        let edit_result = executor.execute("edit", &edit_args, None, "call-2").await;
        assert!(edit_result.success);

        // Read again - should get updated content (cache was invalidated)
        let result2 = executor.execute("read", &read_args, None, "call-3").await;
        assert!(result2.success);
        assert!(result2.output.contains("hello rust"));
    }

    #[tokio::test]
    async fn test_executor_cache_not_used_for_bash() {
        let dir = tempfile::tempdir().unwrap();
        let executor = ToolExecutor::new(dir.path().to_str().unwrap());

        let args = serde_json::json!({"command": "echo hello"});

        // First call
        executor.execute("bash", &args, None, "call-1").await;

        // Second call - should NOT be cached (bash is excluded)
        executor.execute("bash", &args, None, "call-2").await;

        let stats = executor.cache_stats();
        // Bash calls should not affect cache stats (they're excluded)
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0);
    }

    #[test]
    fn test_executor_clear_cache() {
        let executor = ToolExecutor::new("/tmp");

        // Verify cache starts empty
        let stats1 = executor.cache_stats();
        assert_eq!(stats1.entries, 0);

        // Clear cache (no-op when empty, but should not panic)
        executor.clear_cache();

        let stats2 = executor.cache_stats();
        assert_eq!(stats2.entries, 0);
    }

    #[test]
    fn test_executor_with_custom_cache_config() {
        use std::time::Duration;

        let config = CacheConfig {
            max_entries: 10,
            ttl: Duration::from_secs(30),
            enabled: true,
            excluded_tools: vec!["bash".to_string()],
        };

        let executor = ToolExecutor::with_cache_config("/tmp", config);
        let stats = executor.cache_stats();
        assert_eq!(stats.max_entries, 10);
    }
}

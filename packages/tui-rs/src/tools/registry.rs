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
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use tokio::sync::mpsc;

use super::ask_user;
use super::background_tasks;
use super::bash::{BashArgs, BashTool};
use super::cache::{CacheConfig, CacheKey, CacheStats, CachedResult, ToolResultCache};
use super::details::{
    DiffDetails, EditDetails, GlobDetails, GrepDetails, ListDetails, ReadDetails, WriteDetails,
};
use super::exa;
use super::extract_document;
use super::gh;
use super::image::{ImageTool, ReadImageArgs, ScreenshotArgs};
use super::inline::{load_inline_tools, InlineTool, InlineToolExecutor};
use super::notebook_edit;
use super::status;
use super::todo;
use super::web_fetch::{WebFetchArgs, WebFetchTool};
use crate::agent::{FromAgent, ToolDefinition, ToolResult};
use crate::ai::Tool;
use crate::lsp;
use crate::mcp::{load_mcp_config, McpClient, McpContent};
use crate::safety::{
    expand_tilde, is_tilde_path, require_plan, run_validators_with_diagnostics, ActionFirewall,
    FirewallVerdict,
};

const MAX_READ_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_GREP_LINES: usize = 100;
const MAX_LIST_LINES: usize = 200;
const MAX_DIFF_LINES: usize = 400;

fn shell_escape(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }
    let mut escaped = String::with_capacity(arg.len() + 2);
    escaped.push('\'');
    for ch in arg.chars() {
        if ch == '\'' {
            escaped.push_str("'\\''");
        } else {
            escaped.push(ch);
        }
    }
    escaped.push('\'');
    escaped
}

fn build_glob_pattern(base_path: &str, pattern: &str) -> String {
    if Path::new(pattern).is_absolute() {
        return pattern.to_string();
    }

    Path::new(base_path)
        .join(pattern)
        .to_string_lossy()
        .to_string()
}

fn resolve_tool_path(cwd: &str, input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Missing file_path argument".to_string());
    }

    let path = Path::new(trimmed);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else if is_tilde_path(path) {
        expand_tilde(path)
            .ok_or_else(|| "Home directory unavailable for ~ expansion".to_string())?
    } else {
        Path::new(cwd).join(path)
    };

    Ok(resolved.to_string_lossy().to_string())
}

fn to_shell_path(path: &str) -> String {
    #[cfg(windows)]
    {
        let normalized = path.replace('\\', "/");
        if normalized.starts_with("//") {
            return normalized;
        }
        if normalized.len() >= 2 && normalized.as_bytes().get(1) == Some(&b':') {
            let drive = normalized[0..1].to_ascii_lowercase();
            let rest = normalized[2..].trim_start_matches('/');
            if rest.is_empty() {
                return format!("/{}", drive);
            }
            return format!("/{}/{}", drive, rest);
        }
        normalized
    }

    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn normalize_shell_path(input: &str) -> Result<(String, String), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Missing path argument".to_string());
    }
    let path = Path::new(trimmed);
    if is_tilde_path(path) {
        let expanded = expand_tilde(path)
            .ok_or_else(|| "Home directory unavailable for ~ expansion".to_string())?;
        let display = expanded.to_string_lossy().to_string();
        let shell_path = to_shell_path(&display);
        return Ok((display, shell_path));
    }

    let display = trimmed.to_string();
    let shell_path = to_shell_path(trimmed);
    Ok((display, shell_path))
}

fn normalize_git_path(cwd: &str, input: &str) -> Result<(String, String), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Missing path argument".to_string());
    }

    let path = Path::new(trimmed);
    let mut resolved = if path.is_absolute() {
        path.to_path_buf()
    } else if is_tilde_path(path) {
        expand_tilde(path)
            .ok_or_else(|| "Home directory unavailable for ~ expansion".to_string())?
    } else {
        path.to_path_buf()
    };

    let cwd_path = Path::new(cwd);
    let relative = cwd_path
        .canonicalize()
        .ok()
        .and_then(|cwd_canon| {
            resolved
                .canonicalize()
                .ok()
                .and_then(|path_canon| path_canon.strip_prefix(&cwd_canon).ok().map(PathBuf::from))
        })
        .or_else(|| resolved.strip_prefix(cwd_path).ok().map(PathBuf::from));

    if let Some(rel) = relative {
        resolved = rel;
    }

    let display = resolved.to_string_lossy().to_string();
    let shell_path = to_shell_path(&display);
    Ok((display, shell_path))
}

fn extract_grep_path(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b':' {
            let mut digit_idx = idx + 1;
            if digit_idx < bytes.len() && bytes[digit_idx].is_ascii_digit() {
                while digit_idx < bytes.len() && bytes[digit_idx].is_ascii_digit() {
                    digit_idx += 1;
                }
                if digit_idx < bytes.len() && bytes[digit_idx] == b':' {
                    let path = &line[..idx];
                    return if path.is_empty() { None } else { Some(path) };
                }
            }
        }
        idx += 1;
    }
    None
}

fn is_probably_binary(data: &[u8]) -> bool {
    data.iter().take(2048).any(|byte| *byte == 0)
}

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

    /// MCP client for resource tools (lazy-initialized)
    mcp_client: tokio::sync::Mutex<Option<crate::mcp::McpClient>>,

    /// MCP tool annotations for approval hints
    mcp_tool_annotations: RwLock<HashMap<String, crate::mcp::McpToolAnnotations>>,
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
            mcp_client: tokio::sync::Mutex::new(None),
            mcp_tool_annotations: RwLock::new(HashMap::new()),
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
            mcp_client: tokio::sync::Mutex::new(None),
            mcp_tool_annotations: RwLock::new(HashMap::new()),
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

    async fn ensure_mcp_client(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<McpClient>>, String> {
        let mut guard = self.mcp_client.lock().await;
        if guard.is_none() {
            let config = load_mcp_config(Some(Path::new(&self.cwd)));
            let client = McpClient::new();
            let servers: Vec<_> = config.enabled_servers().cloned().collect();
            for server in servers {
                if let Err(err) = client.connect(server.clone()).await {
                    eprintln!("[mcp] Failed to connect to server {}: {}", server.name, err);
                }
            }
            let annotations = client.list_tool_annotations().await;
            if let Ok(mut map) = self.mcp_tool_annotations.write() {
                map.clear();
                for (name, meta) in annotations {
                    map.insert(name.to_lowercase(), meta);
                }
            }
            *guard = Some(client);
        }
        Ok(guard)
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

    /// Ensure MCP client is initialized and annotations are cached.
    /// Call this before checking annotations for MCP tools.
    pub async fn ensure_mcp_annotations(&self) -> Result<(), String> {
        let _ = self.ensure_mcp_client().await?;
        Ok(())
    }

    /// Get MCP tool annotations if available
    pub fn tool_annotations(&self, name: &str) -> Option<crate::mcp::McpToolAnnotations> {
        let key = name.to_lowercase();
        self.mcp_tool_annotations
            .read()
            .ok()
            .and_then(|map| map.get(&key).cloned())
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

    /// Check a tool call against the action firewall.
    pub fn firewall_verdict(&self, name: &str, args: &serde_json::Value) -> FirewallVerdict {
        let firewall = ActionFirewall::new(&self.cwd);
        let tool_name = name.to_lowercase();
        firewall.check_tool(&tool_name, args)
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
        if let FirewallVerdict::Block { reason } = self.firewall_verdict(tool_name, args) {
            return ToolResult::failure(format!("Blocked by action firewall: {}", reason));
        }

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

    async fn execute_search(&self, args: &serde_json::Value) -> ToolResult {
        let start_time = Instant::now();
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        if pattern.is_empty() {
            return ToolResult::failure("Missing pattern argument".to_string());
        }

        let paths: Vec<String> = match args.get("paths") {
            Some(Value::String(path)) => vec![path.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => Vec::new(),
        };

        let mut cmd = String::from("rg --color=never --no-heading -n");
        let output_mode = args
            .get("outputMode")
            .and_then(|v| v.as_str())
            .unwrap_or("content");
        if output_mode == "files" {
            cmd.push_str(" -l");
        } else if output_mode == "count" {
            cmd.push_str(" --count-matches");
        }
        if args
            .get("ignoreCase")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" -i");
        }
        if args
            .get("literal")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" -F");
        }
        if args.get("word").and_then(|v| v.as_bool()).unwrap_or(false) {
            cmd.push_str(" -w");
        }
        if args
            .get("multiline")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" --multiline");
        }
        if let Some(max_results) = args.get("maxResults").and_then(|v| v.as_u64()) {
            cmd.push_str(&format!(" -m {}", max_results));
        }
        if let Some(context) = args.get("context").and_then(|v| v.as_u64()) {
            cmd.push_str(&format!(" -C {}", context));
        } else {
            if let Some(before) = args.get("beforeContext").and_then(|v| v.as_u64()) {
                cmd.push_str(&format!(" -B {}", before));
            }
            if let Some(after) = args.get("afterContext").and_then(|v| v.as_u64()) {
                cmd.push_str(&format!(" -A {}", after));
            }
        }
        if let Some(glob) = args.get("glob").and_then(|v| v.as_str()) {
            cmd.push_str(&format!(" -g {}", shell_escape(glob)));
        }
        if args
            .get("includeHidden")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" --hidden");
        }
        if args
            .get("useGitIgnore")
            .and_then(|v| v.as_bool())
            .map(|v| !v)
            .unwrap_or(false)
        {
            cmd.push_str(" --no-ignore");
        }
        if args
            .get("invertMatch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" --invert-match");
        }
        if args
            .get("onlyMatching")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            cmd.push_str(" --only-matching");
        }

        cmd.push_str(&format!(" -- {}", shell_escape(pattern)));
        for path in &paths {
            cmd.push_str(&format!(" {}", shell_escape(path)));
        }

        let head_limit = args
            .get("headLimit")
            .and_then(|v| v.as_u64())
            .unwrap_or(MAX_GREP_LINES as u64) as usize;
        cmd.push_str(&format!(
            " | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ] || [ $status -eq 1 ]; then exit 0; else exit $status; fi",
            head_limit
        ));

        let result = self
            .bash
            .execute(BashArgs {
                command: cmd,
                timeout: Some(30000),
                description: Some("Search for pattern".to_string()),
                run_in_background: false,
            })
            .await;

        let duration_ms = start_time.elapsed().as_millis() as u64;
        let matches_count = result.output.lines().count();
        let truncated = matches_count >= head_limit;

        let mut details = GrepDetails::new(pattern)
            .with_path(paths.join(", "))
            .with_matches(matches_count)
            .with_duration(duration_ms);
        if truncated {
            details = details.with_truncation();
        }

        if result.success {
            ToolResult::success(result.output).with_details(details.to_json())
        } else {
            ToolResult::failure(result.error.unwrap_or_default()).with_details(details.to_json())
        }
    }

    /// Internal implementation of tool execution (without caching)
    async fn execute_impl(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        event_tx: Option<&mpsc::UnboundedSender<FromAgent>>,
        call_id: &str,
    ) -> ToolResult {
        if McpClient::is_mcp_tool(tool_name) {
            let guard = match self.ensure_mcp_client().await {
                Ok(guard) => guard,
                Err(err) => return ToolResult::failure(err),
            };
            let client = match guard.as_ref() {
                Some(client) => client,
                None => return ToolResult::failure("No MCP servers configured".to_string()),
            };

            match client
                .call_tool_with_metadata(tool_name, args.clone())
                .await
            {
                Ok((server_name, tool_label, result)) => {
                    let text_output = result
                        .content
                        .iter()
                        .filter_map(|content| match content {
                            McpContent::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let output = if !text_output.is_empty() {
                        text_output
                    } else {
                        serde_json::to_string_pretty(&result.content)
                            .unwrap_or_else(|_| "MCP tool returned non-text content".to_string())
                    };
                    let details = serde_json::json!({
                        "server": server_name,
                        "tool": tool_label,
                        "content": result.content,
                        "isError": result.is_error
                    });
                    return ToolResult::success(output).with_details(details);
                }
                Err(err) => {
                    return ToolResult::failure(format!("MCP tool error: {}", err));
                }
            }
        }

        match tool_name {
            "bash" | "Bash" => {
                let bash_args: BashArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid bash arguments: {}", e));
                    }
                };

                if let Err(err) = require_plan("bash") {
                    return ToolResult::failure(err);
                }

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
                let start_time = Instant::now();
                let raw_path = args
                    .get("path")
                    .or_else(|| args.get("file_path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                let path_buf = std::path::Path::new(&path);
                let extension = path_buf
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase());

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

                let mode = args
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("normal");

                let line_numbers = args
                    .get("lineNumbers")
                    .or_else(|| args.get("line_numbers"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let wrap_in_code_fence = args
                    .get("wrapInCodeFence")
                    .or_else(|| args.get("wrap_in_code_fence"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let as_base64 = args
                    .get("asBase64")
                    .or_else(|| args.get("as_base64"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let with_diagnostics = args
                    .get("withDiagnostics")
                    .or_else(|| args.get("diagnostics"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let language = args.get("language").and_then(|v| v.as_str());

                if let Some(ext) = extension.as_deref() {
                    let is_image =
                        matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg");
                    if is_image {
                        let image_args = ReadImageArgs {
                            file_path: path.clone(),
                            max_dimension: None,
                        };
                        return self.image.read_image(image_args).await;
                    }
                }

                if let Some(ext) = extension.as_deref() {
                    if ext == "pdf" {
                        let bytes = match tokio::fs::read(&path).await {
                            Ok(data) => data,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!("Failed to read PDF: {}", err))
                                    .with_details(details.to_json());
                            }
                        };
                        let text = match pdf_extract::extract_text_from_mem(&bytes) {
                            Ok(text) => text,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64)
                                    .with_mime_type("application/pdf");
                                return ToolResult::failure(format!(
                                    "Failed to extract PDF: {}",
                                    err
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let mut output = text;
                        if wrap_in_code_fence {
                            let fence_language = language.unwrap_or("");
                            output = format!("```{}\n{}\n```", fence_language, output);
                        }
                        let details = ReadDetails::new(path.clone())
                            .with_size(bytes.len() as u64)
                            .with_mime_type("application/pdf")
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::success(output).with_details(details.to_json());
                    }
                }

                if let Some(ext) = extension.as_deref() {
                    if ext == "ipynb" {
                        let content = match tokio::fs::read_to_string(&path).await {
                            Ok(text) => text,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!(
                                    "Failed to read notebook: {}",
                                    err
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let notebook: serde_json::Value = match serde_json::from_str(&content) {
                            Ok(val) => val,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!(
                                    "Failed to parse notebook: {}",
                                    err
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let cells = notebook.get("cells").and_then(|v| v.as_array()).cloned();
                        let cells = match cells {
                            Some(val) => val,
                            None => {
                                return ToolResult::failure(
                                    "Invalid notebook format: missing cells".to_string(),
                                );
                            }
                        };
                        let mut lines = Vec::new();
                        for (idx, cell) in cells.iter().enumerate() {
                            let cell_type = cell
                                .get("cell_type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("code");
                            let cell_id = cell.get("id").and_then(|v| v.as_str());
                            let source = cell.get("source").map(|v| {
                                if v.is_array() {
                                    v.as_array()
                                        .unwrap_or(&Vec::new())
                                        .iter()
                                        .filter_map(|line| line.as_str())
                                        .collect::<Vec<_>>()
                                        .join("")
                                } else {
                                    v.as_str().unwrap_or("").to_string()
                                }
                            });
                            let preview = source.unwrap_or_default();
                            let preview_lines: Vec<&str> = preview.lines().take(3).collect();
                            let truncated = if preview.lines().count() > 3 {
                                "..."
                            } else {
                                ""
                            };
                            let id_suffix = cell_id
                                .map(|id| format!(" (id: {})", id))
                                .unwrap_or_default();
                            lines.push(format!(
                                "[{}] {}{}:\n{}{}",
                                idx,
                                cell_type,
                                id_suffix,
                                preview_lines.join("\n"),
                                truncated
                            ));
                            lines.push(String::new());
                        }
                        let output = lines.join("\n");
                        let details = ReadDetails::new(path.clone())
                            .with_size(content.len() as u64)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::success(output).with_details(details.to_json());
                    }
                }

                if let Ok(metadata) = tokio::fs::metadata(&path).await {
                    let size_bytes = metadata.len();
                    if size_bytes > MAX_READ_SIZE_BYTES {
                        let size_mb = (size_bytes as f64) / (1024.0 * 1024.0);
                        let details = ReadDetails::new(path.clone())
                            .with_size(size_bytes)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!(
                            "File is too large ({:.2}MB). Maximum size is 10MB. Use offset/limit or bash head/tail for large files.",
                            size_mb
                        ))
                        .with_details(details.to_json());
                    }
                }

                let bytes = match tokio::fs::read(&path).await {
                    Ok(data) => data,
                    Err(e) => {
                        let details = ReadDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to read file: {}", e))
                            .with_details(details.to_json());
                    }
                };

                if is_probably_binary(&bytes) && !as_base64 {
                    let details = ReadDetails::new(path.clone())
                        .with_size(bytes.len() as u64)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(
                        "Binary file detected. Re-run with asBase64=true or use the bash tool.",
                    )
                    .with_details(details.to_json());
                }

                if as_base64 {
                    let encoded = STANDARD.encode(&bytes);
                    let details = ReadDetails::new(path.clone())
                        .with_size(bytes.len() as u64)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::success(encoded).with_details(details.to_json());
                }

                let content = match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => {
                        let details = ReadDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(
                            "File is not valid UTF-8. Re-run with asBase64=true or use the bash tool.",
                        )
                        .with_details(details.to_json());
                    }
                };

                let lines: Vec<&str> = content.lines().collect();
                let total_lines = lines.len();

                let mut start_idx = (offset - 1).min(total_lines);
                let mut max_lines = limit.unwrap_or(total_lines);

                match mode {
                    "head" => {
                        start_idx = 0;
                        max_lines = limit.unwrap_or(total_lines);
                    }
                    "tail" => {
                        max_lines = limit.unwrap_or(total_lines);
                        start_idx = total_lines.saturating_sub(max_lines);
                    }
                    "normal" => {}
                    _ => {
                        let details = ReadDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure("Invalid mode. Use normal, head, or tail.")
                            .with_details(details.to_json());
                    }
                }

                let end_idx = (start_idx + max_lines).min(total_lines);
                let lines_read = end_idx.saturating_sub(start_idx);
                let truncated = limit.is_some() && end_idx < total_lines;

                let mut output: String = lines[start_idx..end_idx]
                    .iter()
                    .enumerate()
                    .map(|(i, line)| {
                        if line_numbers {
                            format!("{:>6}\t{}", start_idx + i + 1, line)
                        } else {
                            (*line).to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");

                if wrap_in_code_fence {
                    let fence_language = language.unwrap_or("");
                    output = format!("```{}\n{}\n```", fence_language, output);
                }

                if with_diagnostics {
                    if let Ok(diagnostics) = lsp::diagnostics_for_file(&self.cwd, &path).await {
                        if !diagnostics.is_empty() {
                            let errors: Vec<_> = diagnostics
                                .iter()
                                .filter(|d| d.severity == Some(1) || d.severity.is_none())
                                .collect();
                            let warnings: Vec<_> = diagnostics
                                .iter()
                                .filter(|d| d.severity == Some(2))
                                .collect();

                            if !errors.is_empty() || !warnings.is_empty() {
                                output.push_str("\n\n--- LSP Diagnostics ---\n");
                                let max_diagnostics = lsp::max_diagnostics_per_file();
                                let mut count = 0usize;

                                for diag in &errors {
                                    if count >= max_diagnostics {
                                        break;
                                    }
                                    let message = lsp::sanitize_diagnostic_message(&diag.message);
                                    output.push_str(&format!(
                                        "ERROR (line {}): {}\n",
                                        diag.range.start.line + 1,
                                        message
                                    ));
                                    count += 1;
                                }

                                for diag in &warnings {
                                    if count >= max_diagnostics {
                                        break;
                                    }
                                    let message = lsp::sanitize_diagnostic_message(&diag.message);
                                    output.push_str(&format!(
                                        "WARN (line {}): {}\n",
                                        diag.range.start.line + 1,
                                        message
                                    ));
                                    count += 1;
                                }

                                if errors.len() + warnings.len() > max_diagnostics {
                                    let remaining = errors.len() + warnings.len() - max_diagnostics;
                                    output.push_str(&format!(
                                        "...and {} more {} hidden.\n",
                                        remaining,
                                        if remaining == 1 {
                                            "diagnostic"
                                        } else {
                                            "diagnostics"
                                        }
                                    ));
                                }
                            }
                        }
                    }
                }

                let details = ReadDetails::new(path.clone())
                    .with_size(content.len() as u64)
                    .with_lines(lines_read)
                    .with_truncated(truncated)
                    .with_offset(if offset > 1 { Some(offset) } else { None })
                    .with_limit(limit)
                    .with_duration(start_time.elapsed().as_millis() as u64);

                ToolResult::success(output).with_details(details.to_json())
            }
            "write" | "Write" => {
                let start_time = Instant::now();
                let raw_path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                if let Err(err) = require_plan("write") {
                    return ToolResult::failure(err);
                }

                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let preview_diff = args
                    .get("previewDiff")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let backup = args.get("backup").and_then(|v| v.as_bool()).unwrap_or(true);

                let file_existed = std::path::Path::new(&path).exists();
                let mut previous_content: Option<String> = None;
                if file_existed {
                    if let Ok(text) = tokio::fs::read_to_string(&path).await {
                        previous_content = Some(text);
                    }
                }

                if let Some(parent) = std::path::Path::new(&path).parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        let details = WriteDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to create directory: {}", e))
                            .with_details(details.to_json());
                    }
                }

                let mut backup_path: Option<String> = None;
                let mut backup_renamed = false;
                if file_existed && backup {
                    let backup_target = format!("{}.bak", path);
                    if tokio::fs::rename(&path, &backup_target).await.is_ok() {
                        backup_renamed = true;
                    } else if let Some(prev) = &previous_content {
                        let _ = tokio::fs::write(&backup_target, prev).await;
                    }
                    backup_path = Some(backup_target);
                }

                let tmp_path = format!("{}.{}.tmp", path, uuid::Uuid::new_v4());
                let write_result = async {
                    tokio::fs::write(&tmp_path, &content).await?;
                    tokio::fs::rename(&tmp_path, &path).await?;
                    Ok::<(), std::io::Error>(())
                }
                .await;

                if let Err(e) = write_result {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    if backup_renamed {
                        let _ = tokio::fs::rename(format!("{}.bak", path), &path).await;
                    } else if let Some(prev) = &previous_content {
                        let _ = tokio::fs::write(&path, prev).await;
                    }
                    let details = WriteDetails::new(path.clone())
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(format!("Failed to write file: {}", e))
                        .with_details(details.to_json());
                }

                let diff = if preview_diff {
                    previous_content.as_ref().map(|old| {
                        let diff = similar::TextDiff::from_lines(old, &content);
                        diff.unified_diff().to_string()
                    })
                } else {
                    None
                };

                let display_path = if raw_path.is_empty() { &path } else { raw_path };
                let mut linter_output = String::new();
                let lsp_diagnostics = match lsp::collect_diagnostics_for_paths(
                    &self.cwd,
                    std::slice::from_ref(&path),
                )
                .await
                {
                    Ok(map) => {
                        if let Some(file_diags) = map.get(&path).or_else(|| map.get(display_path)) {
                            linter_output =
                                lsp::format_lsp_summary(display_path, file_diags.as_slice());
                        }
                        Some(map)
                    }
                    Err(_) => None,
                };

                let validators = match run_validators_with_diagnostics(
                    std::slice::from_ref(&path),
                    lsp_diagnostics.as_ref(),
                )
                .await
                {
                    Ok(results) => Some(results),
                    Err(err) => {
                        if backup_renamed {
                            let _ = tokio::fs::rename(format!("{}.bak", path), &path).await;
                        } else if let Some(prev) = &previous_content {
                            let _ = tokio::fs::write(&path, prev).await;
                        }
                        return ToolResult::failure(err);
                    }
                };

                self.invalidate_file_cache(&path);

                let mut details = WriteDetails::new(path.clone())
                    .with_bytes(content.len() as u64)
                    .with_created(!file_existed)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                if let Some(diff) = diff {
                    details = details.with_diff(diff);
                }
                if let Some(backup_path) = backup_path {
                    details = details.with_backup(backup_path);
                }
                if let Some(validators) = validators {
                    details = details.with_validators(validators);
                }

                let mut summary = format!("File written successfully: {}", path);
                if !linter_output.is_empty() {
                    summary.push_str(&linter_output);
                }

                ToolResult::success(summary).with_details(details.to_json())
            }
            "glob" | "Glob" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");

                let base_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);

                let full_pattern = build_glob_pattern(base_path, pattern);

                // Use native glob crate
                match glob::glob(&full_pattern) {
                    Ok(paths) => {
                        const MAX_GLOB_RESULTS: usize = 100;
                        let mut matches: Vec<String> = Vec::new();
                        let mut truncated = false;

                        for entry in paths {
                            let Ok(path) = entry else {
                                continue;
                            };
                            if matches.len() >= MAX_GLOB_RESULTS {
                                truncated = true;
                                break;
                            }
                            matches.push(path.display().to_string());
                        }

                        let details = GlobDetails::new(pattern)
                            .with_base_path(base_path)
                            .with_matches(matches.len())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        let details = if truncated {
                            details.with_truncation()
                        } else {
                            details
                        };

                        ToolResult::success(matches.join("\n")).with_details(details.to_json())
                    }
                    Err(e) => {
                        let details = GlobDetails::new(pattern)
                            .with_base_path(base_path)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        ToolResult::failure(format!("Glob error: {}", e))
                            .with_details(details.to_json())
                    }
                }
            }
            "grep" | "Grep" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                let raw_path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let (display_path, shell_path) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                if pattern.is_empty() {
                    let details =
                        GrepDetails::new("").with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure("Missing pattern argument")
                        .with_details(details.to_json());
                }

                // Use ripgrep if available, fall back to grep
                let result = self
                    .bash
                    .execute(BashArgs {
                        command: format!(
                            "(rg --no-heading -n -- {} {} 2>/dev/null || grep -rn -- {} {} 2>/dev/null) | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ] || [ $status -eq 1 ]; then exit 0; else exit $status; fi",
                            shell_escape(pattern),
                            shell_escape(&shell_path),
                            shell_escape(pattern),
                            shell_escape(&shell_path),
                            MAX_GREP_LINES
                        ),
                        timeout: Some(30000),
                        description: Some("Search for pattern".to_string()),
                        run_in_background: false,
                    })
                    .await;

                // Build grep details from result
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let matches_count = result.output.lines().count();
                let files_matched = result
                    .output
                    .lines()
                    .filter_map(extract_grep_path)
                    .collect::<std::collections::HashSet<_>>()
                    .len();
                let truncated = matches_count >= MAX_GREP_LINES;

                let details = GrepDetails::new(pattern)
                    .with_path(&display_path)
                    .with_matches(matches_count)
                    .with_files_matched(files_matched)
                    .with_duration(duration_ms);

                let details = if truncated {
                    details.with_truncation()
                } else {
                    details
                };

                if result.success {
                    ToolResult::success(result.output).with_details(details.to_json())
                } else {
                    ToolResult::failure(result.error.unwrap_or_default())
                        .with_details(details.to_json())
                }
            }
            "edit" | "Edit" => {
                let start_time = Instant::now();
                let raw_path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                if let Err(err) = require_plan("edit") {
                    return ToolResult::failure(err);
                }

                let replace_all = args
                    .get("replaceAll")
                    .or_else(|| args.get("replace_all"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let occurrence =
                    args.get("occurrence").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let dry_run = args
                    .get("dryRun")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let edits_value = args.get("edits").and_then(|v| v.as_array());
                let mut edits: Vec<(String, String)> = Vec::new();

                if let Some(edits_array) = edits_value {
                    if replace_all || occurrence != 1 {
                        return ToolResult::failure(
                            "Cannot use replaceAll or occurrence with edits array".to_string(),
                        );
                    }
                    for edit in edits_array {
                        let old = edit
                            .get("oldText")
                            .or_else(|| edit.get("old_string"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if old.is_empty() {
                            return ToolResult::failure("Edit entry missing oldText".to_string());
                        }
                        let new = edit
                            .get("newText")
                            .or_else(|| edit.get("new_string"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        edits.push((old, new));
                    }
                } else {
                    let old = args
                        .get("oldText")
                        .or_else(|| args.get("old_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if old.is_empty() {
                        return ToolResult::failure("Missing oldText argument".to_string());
                    }
                    let new = args
                        .get("newText")
                        .or_else(|| args.get("new_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    edits.push((old, new));
                }

                // Read file content
                let content = match tokio::fs::read_to_string(&path).await {
                    Ok(c) => c,
                    Err(e) => {
                        let details = EditDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to read file: {}", e))
                            .with_details(details.to_json());
                    }
                };

                let mut new_content = content.clone();
                let mut replacements_total = 0;
                for (old_text, new_text) in edits.iter() {
                    let positions: Vec<usize> = new_content
                        .match_indices(old_text)
                        .map(|(i, _)| i)
                        .collect();
                    if positions.is_empty() {
                        let details = EditDetails::new(path.clone())
                            .with_replacements(replacements_total)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(
                            "oldText not found in file. Make sure the string matches exactly."
                                .to_string(),
                        )
                        .with_details(details.to_json());
                    }
                    if replace_all && edits.len() == 1 {
                        replacements_total += positions.len();
                        new_content = new_content.replace(old_text, new_text);
                        continue;
                    }
                    let idx = occurrence.saturating_sub(1);
                    if idx >= positions.len() {
                        return ToolResult::failure(format!(
                            "Occurrence {} out of range ({} matches)",
                            occurrence,
                            positions.len()
                        ));
                    }
                    let pos = positions[idx];
                    let mut updated = String::new();
                    updated.push_str(&new_content[..pos]);
                    updated.push_str(new_text);
                    updated.push_str(&new_content[pos + old_text.len()..]);
                    new_content = updated;
                    replacements_total += 1;
                }

                let diff = similar::TextDiff::from_lines(&content, &new_content)
                    .unified_diff()
                    .to_string();

                if dry_run {
                    let details = EditDetails::new(path.clone())
                        .with_replacements(replacements_total)
                        .with_diff(diff)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::success(
                        "Dry run complete (no changes written)".to_string(),
                    )
                    .with_details(details.to_json());
                }

                let tmp_path = format!("{}.{}.tmp", path, uuid::Uuid::new_v4());
                let write_result = async {
                    tokio::fs::write(&tmp_path, &new_content).await?;
                    tokio::fs::rename(&tmp_path, &path).await?;
                    Ok::<(), std::io::Error>(())
                }
                .await;

                if let Err(e) = write_result {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let details = EditDetails::new(path.clone())
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(format!("Failed to write file: {}", e))
                        .with_details(details.to_json());
                }

                let display_path = if raw_path.is_empty() { &path } else { raw_path };
                let mut linter_output = String::new();
                let lsp_diagnostics = match lsp::collect_diagnostics_for_paths(
                    &self.cwd,
                    std::slice::from_ref(&path),
                )
                .await
                {
                    Ok(map) => {
                        if let Some(file_diags) = map.get(&path).or_else(|| map.get(display_path)) {
                            linter_output =
                                lsp::format_lsp_summary(display_path, file_diags.as_slice());
                        }
                        Some(map)
                    }
                    Err(_) => None,
                };

                let validators = match run_validators_with_diagnostics(
                    std::slice::from_ref(&path),
                    lsp_diagnostics.as_ref(),
                )
                .await
                {
                    Ok(results) => Some(results),
                    Err(err) => {
                        let _ = tokio::fs::write(&path, &content).await;
                        return ToolResult::failure(err);
                    }
                };

                self.invalidate_file_cache(&path);

                let mut details = EditDetails::new(path.clone())
                    .with_replacements(replacements_total)
                    .with_diff(diff)
                    .with_duration(start_time.elapsed().as_millis() as u64)
                    .with_line_changes(&content, &new_content);
                if let Some(validators) = validators {
                    details = details.with_validators(validators);
                }

                let mut summary = format!(
                    "Successfully replaced {} occurrence(s) in {}",
                    replacements_total, path
                );
                if !linter_output.is_empty() {
                    summary.push_str(&linter_output);
                }

                ToolResult::success(summary).with_details(details.to_json())
            }
            "diff" | "Diff" => {
                let start_time = Instant::now();
                // Git diff tool - shows changes in working tree or between commits
                let target = args
                    .get("target")
                    .and_then(|v| v.as_str())
                    .unwrap_or("HEAD");

                let path = args.get("path").and_then(|v| v.as_str());
                let normalized_path = path.map(|raw_path| normalize_git_path(&self.cwd, raw_path));
                let (display_path, shell_path) = match normalized_path.transpose() {
                    Ok(Some((display, shell))) => (Some(display), Some(shell)),
                    Ok(None) => (None, None),
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                // Build git diff command
                let cmd = match shell_path.as_ref() {
                    Some(p) => format!(
                        "git diff {} -- {} | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ]; then exit 0; else exit $status; fi",
                        shell_escape(target),
                        shell_escape(p),
                        MAX_DIFF_LINES
                    ),
                    None => format!(
                        "git diff {} | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ]; then exit 0; else exit $status; fi",
                        shell_escape(target),
                        MAX_DIFF_LINES
                    ),
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

                // Build diff details
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let mut details = DiffDetails::new(target).with_duration(duration_ms);

                if let Some(p) = display_path.as_ref() {
                    details = details.with_path(p);
                }

                // Parse diff stats from output (count +/- lines)
                let insertions = result
                    .output
                    .lines()
                    .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                    .count();
                let deletions = result
                    .output
                    .lines()
                    .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                    .count();
                let files_changed = result
                    .output
                    .lines()
                    .filter(|line| line.starts_with("diff --git"))
                    .count();

                if files_changed > 0 || insertions > 0 || deletions > 0 {
                    details = details.with_stats(files_changed, insertions, deletions);
                }

                let truncated = result.output.lines().count() >= MAX_DIFF_LINES;
                if truncated {
                    details = details.with_truncation();
                }

                if result.success {
                    ToolResult::success(result.output).with_details(details.to_json())
                } else {
                    ToolResult::failure(result.error.unwrap_or_default())
                        .with_details(details.to_json())
                }
            }
            "list" | "List" | "ls" => {
                let start_time = Instant::now();
                // Directory listing tool
                let raw_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);
                let (display_path, shell_path) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                let recursive = args
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let cmd = if recursive {
                    format!(
                        "find -- {} -type f | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ]; then exit 0; else exit $status; fi",
                        shell_escape(&shell_path),
                        MAX_LIST_LINES
                    )
                } else {
                    format!(
                        "ls -la -- {} | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ]; then exit 0; else exit $status; fi",
                        shell_escape(&shell_path),
                        MAX_LIST_LINES
                    )
                };

                let result = self
                    .bash
                    .execute(BashArgs {
                        command: cmd,
                        timeout: Some(10000),
                        description: Some("List directory".to_string()),
                        run_in_background: false,
                    })
                    .await;

                // Build list details
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let entries_count = result.output.lines().count();
                let truncated = entries_count >= MAX_LIST_LINES;

                let mut details = ListDetails::new(&display_path)
                    .with_entries(entries_count)
                    .with_duration(duration_ms);

                if recursive {
                    details = details.with_recursive();
                }

                if truncated {
                    details = details.with_truncation();
                }

                if result.success {
                    ToolResult::success(result.output).with_details(details.to_json())
                } else {
                    ToolResult::failure(result.error.unwrap_or_default())
                        .with_details(details.to_json())
                }
            }
            "find" | "Find" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                if pattern.is_empty() {
                    return ToolResult::failure("Missing pattern argument".to_string());
                }
                let raw_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);
                let (display_path, shell_path) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => return ToolResult::failure(message),
                };
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(1000) as usize;
                let include_hidden = args
                    .get("includeHidden")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let mut cmd = String::from("rg --files --color=never");
                if include_hidden {
                    cmd.push_str(" --hidden");
                }
                cmd.push_str(&format!(
                    " -g {} -- {}",
                    shell_escape(pattern),
                    shell_escape(&shell_path)
                ));
                cmd.push_str(&format!(
                    " | head -{}; status=${{PIPESTATUS[0]}}; if [ $status -eq 141 ]; then exit 0; else exit $status; fi",
                    limit
                ));

                let result = self
                    .bash
                    .execute(BashArgs {
                        command: cmd,
                        timeout: Some(20000),
                        description: Some("Find files".to_string()),
                        run_in_background: false,
                    })
                    .await;

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let count = result.output.lines().count();
                let truncated = count >= limit;
                let mut details = ListDetails::new(&display_path)
                    .with_entries(count)
                    .with_duration(duration_ms);
                if truncated {
                    details = details.with_truncation();
                }

                if result.success {
                    ToolResult::success(result.output).with_details(details.to_json())
                } else {
                    ToolResult::failure(result.error.unwrap_or_default())
                        .with_details(details.to_json())
                }
            }
            "search" | "Search" => self.execute_search(args).await,
            "parallel_ripgrep" | "ParallelRipgrep" => {
                let patterns = args.get("patterns").and_then(|v| v.as_array()).cloned();
                let patterns = match patterns {
                    Some(p) if !p.is_empty() => p,
                    _ => return ToolResult::failure("patterns array required".to_string()),
                };

                let mut combined = Vec::new();
                let mut commands = Vec::new();
                let mut total_matches = 0usize;
                for pattern_value in patterns {
                    let pattern = match pattern_value.as_str() {
                        Some(p) => p.to_string(),
                        None => continue,
                    };
                    let mut search_args = args.clone();
                    if let Some(obj) = search_args.as_object_mut() {
                        obj.insert("pattern".to_string(), Value::String(pattern.clone()));
                        obj.remove("patterns");
                    }
                    let result = self.execute_search(&search_args).await;
                    commands.push(pattern);
                    if result.success {
                        let line_count = result.output.lines().count();
                        total_matches += line_count;
                        combined.push(result.output);
                    } else {
                        combined.push(result.error.unwrap_or_default());
                    }
                }
                let details = serde_json::json!({
                    "commands": commands,
                    "matchCount": total_matches
                });
                ToolResult::success(combined.join("\n\n")).with_details(details)
            }
            "status" | "Status" => status::git_status(args.clone(), &self.cwd).await,
            "background_tasks" => {
                let action = args
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("list");
                match action {
                    "start" => {
                        if let Err(err) = require_plan("background_tasks") {
                            return ToolResult::failure(err);
                        }
                        let command = match args.get("command").and_then(|v| v.as_str()) {
                            Some(cmd) => cmd.to_string(),
                            None => {
                                return ToolResult::failure(
                                    "command required for start".to_string(),
                                )
                            }
                        };
                        let cwd = args
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&self.cwd)
                            .to_string();
                        let shell = args.get("shell").and_then(|v| v.as_bool()).unwrap_or(false);
                        let env = args.get("env").and_then(|v| v.as_object()).map(|map| {
                            map.iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                .collect::<std::collections::HashMap<_, _>>()
                        });
                        match background_tasks::start(command, cwd, shell, env).await {
                            Ok(task) => {
                                let details = serde_json::json!({
                                    "id": task.id,
                                    "pid": task.pid,
                                    "status": "running",
                                    "logPath": task.log_path
                                });
                                ToolResult::success(format!("Started task {}", task.id))
                                    .with_details(details)
                            }
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    "stop" => {
                        let id = match args.get("taskId").and_then(|v| v.as_str()) {
                            Some(id) => id,
                            None => {
                                return ToolResult::failure("taskId required for stop".to_string())
                            }
                        };
                        match background_tasks::stop(id) {
                            Ok(task) => ToolResult::success(format!("Stopped task {}", task.id)),
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    "logs" => {
                        let id = match args.get("taskId").and_then(|v| v.as_str()) {
                            Some(id) => id,
                            None => {
                                return ToolResult::failure("taskId required for logs".to_string())
                            }
                        };
                        let lines =
                            args.get("lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
                        match background_tasks::logs(id, lines) {
                            Ok(logs) => ToolResult::success(logs),
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    _ => {
                        let tasks = background_tasks::list();
                        let summary = tasks
                            .iter()
                            .map(|t| format!("{} {:?} {}", t.id, t.status, t.command))
                            .collect::<Vec<_>>()
                            .join("\n");
                        let details = serde_json::json!({ "count": tasks.len() });
                        ToolResult::success(if summary.is_empty() {
                            "No background tasks".to_string()
                        } else {
                            summary
                        })
                        .with_details(details)
                    }
                }
            }
            "todo" => todo::todo(args.clone()).await,
            "ask_user" => ask_user::ask_user(args.clone()),
            "extract_document" => extract_document::extract_document(args.clone()).await,
            "notebook_edit" => notebook_edit::notebook_edit(args.clone(), &self.cwd).await,
            "websearch" => exa::websearch(args.clone()).await,
            "codesearch" => exa::codesearch(args.clone()).await,
            "gh_pr" => gh::gh_pr(args.clone(), &self.cwd).await,
            "gh_issue" => gh::gh_issue(args.clone()).await,
            "gh_repo" => gh::gh_repo(args.clone(), &self.cwd).await,
            "mcp_list_resources" => {
                let server_filter = args.get("server").and_then(|v| v.as_str());
                let guard = match self.ensure_mcp_client().await {
                    Ok(guard) => guard,
                    Err(err) => return ToolResult::failure(err),
                };
                let client = match guard.as_ref() {
                    Some(client) => client,
                    None => {
                        return ToolResult::success(
                            "No MCP resources available. Either no servers are connected or they don't expose resources.".to_string(),
                        )
                        .with_details(serde_json::json!({ "servers": [] }));
                    }
                };

                let mut resources = client.list_all_resources().await;
                if let Some(filter) = server_filter {
                    resources.retain(|(name, _)| name == filter);
                }

                let mut servers = Vec::new();
                for (name, uris) in resources {
                    if uris.is_empty() {
                        continue;
                    }
                    servers.push(serde_json::json!({
                        "name": name,
                        "resources": uris
                    }));
                }

                if servers.is_empty() {
                    return ToolResult::success(
                        "No MCP resources available. Either no servers are connected or they don't expose resources.".to_string(),
                    )
                    .with_details(serde_json::json!({ "servers": [] }));
                }

                let mut lines = Vec::new();
                lines.push("# Available MCP Resources".to_string());
                lines.push(String::new());
                for server in &servers {
                    let name = server
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    lines.push(format!("## {}", name));
                    if let Some(resources) = server.get("resources").and_then(|v| v.as_array()) {
                        for uri in resources {
                            if let Some(uri_str) = uri.as_str() {
                                lines.push(format!("- {}", uri_str));
                            }
                        }
                    }
                    lines.push(String::new());
                }

                ToolResult::success(lines.join("\n"))
                    .with_details(serde_json::json!({ "servers": servers }))
            }
            "mcp_read_resource" => {
                let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
                let uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                if server.is_empty() || uri.is_empty() {
                    return ToolResult::failure("server and uri are required".to_string());
                }

                let guard = match self.ensure_mcp_client().await {
                    Ok(guard) => guard,
                    Err(err) => return ToolResult::failure(err),
                };
                let client = match guard.as_ref() {
                    Some(client) => client,
                    None => {
                        return ToolResult::failure("No MCP servers configured".to_string());
                    }
                };

                match client.read_resource(server, uri).await {
                    Ok(result) => {
                        if result.contents.is_empty() {
                            return ToolResult::success(format!("Resource '{}' is empty.", uri))
                                .with_details(serde_json::json!({
                                    "server": server,
                                    "uri": uri,
                                    "contents": []
                                }));
                        }

                        let text_output = result
                            .contents
                            .iter()
                            .filter_map(|content| content.text.clone())
                            .collect::<Vec<_>>()
                            .join("\n---\n");
                        let output = if !text_output.is_empty() {
                            text_output
                        } else {
                            serde_json::to_string_pretty(&result.contents).unwrap_or_else(|_| {
                                "MCP resource returned non-text content".to_string()
                            })
                        };

                        ToolResult::success(output).with_details(serde_json::json!({
                            "server": server,
                            "uri": uri,
                            "contents": result.contents
                        }))
                    }
                    Err(err) => {
                        ToolResult::failure(format!("Failed to read MCP resource: {}", err))
                    }
                }
            }
            "vscode_get_diagnostics"
            | "vscode_get_definition"
            | "vscode_find_references"
            | "vscode_read_file_range"
            | "jetbrains_get_diagnostics"
            | "jetbrains_get_definition"
            | "jetbrains_find_references"
            | "jetbrains_read_file_range" => ToolResult::failure(
                "IDE integration is only available in the TypeScript CLI".to_string(),
            ),
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
/// The registry is pre-populated with built-in tools via `new()`, including
/// core file/shell tools plus search, web, GitHub, MCP resource, and IDE stubs.
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
                    "Read a file (text, notebook, PDF, or image). Use for text files, configs, and docs. Supports images and .ipynb with automatic formatting.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to read (relative or absolute)"
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Legacy alias for path"
                        },
                        "offset": {
                            "type": "number",
                            "description": "Line number to start reading from (optional)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Number of lines to read (optional)"
                        },
                        "mode": {
                            "type": "string",
                            "description": "Reading mode: normal, head, or tail (default: normal)"
                        },
                        "lineNumbers": {
                            "type": "boolean",
                            "description": "Prefix output lines with line numbers (default: true)"
                        },
                        "line_numbers": {
                            "type": "boolean",
                            "description": "Legacy alias for lineNumbers"
                        },
                        "wrapInCodeFence": {
                            "type": "boolean",
                            "description": "Wrap output in a Markdown code fence (default: true)"
                        },
                        "wrap_in_code_fence": {
                            "type": "boolean",
                            "description": "Legacy alias for wrapInCodeFence"
                        },
                        "asBase64": {
                            "type": "boolean",
                            "description": "Return base64-encoded content instead of text (default: false)"
                        },
                        "as_base64": {
                            "type": "boolean",
                            "description": "Legacy alias for asBase64"
                        },
                        "language": {
                            "type": "string",
                            "description": "Language identifier for code fence syntax highlighting (optional)"
                        },
                        "diagnostics": {
                            "type": "boolean",
                            "description": "Include diagnostics if available (optional)"
                        },
                        "withDiagnostics": {
                            "type": "boolean",
                            "description": "Include LSP diagnostics if available (optional)"
                        }
                    },
                    "required": ["path"]
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
                        "path": {
                            "type": "string",
                            "description": "Path to the file to write (relative or absolute)"
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Legacy alias for path"
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write to the file (default: empty string)"
                        },
                        "previewDiff": {
                            "type": "boolean",
                            "description": "Return a diff preview (default: true)"
                        },
                        "backup": {
                            "type": "boolean",
                            "description": "Write a .bak copy before overwriting (default: true)"
                        }
                    },
                    "required": ["path"]
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
                    "Edit files with find-and-replace. Supports single edit, multi-edit, replace-all, and dry-run.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to edit (relative or absolute)"
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Legacy alias for path"
                        },
                        "oldText": {
                            "type": "string",
                            "description": "Exact text to find and replace"
                        },
                        "newText": {
                            "type": "string",
                            "description": "Replacement text (omit or empty string to delete)"
                        },
                        "old_string": {
                            "type": "string",
                            "description": "Legacy alias for oldText"
                        },
                        "new_string": {
                            "type": "string",
                            "description": "Legacy alias for newText"
                        },
                        "edits": {
                            "type": "array",
                            "description": "Multiple edits to apply sequentially",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "oldText": {"type": "string"},
                                    "newText": {"type": "string"},
                                    "old_string": {"type": "string"},
                                    "new_string": {"type": "string"}
                                },
                                "required": ["oldText"]
                            }
                        },
                        "replaceAll": {
                            "type": "boolean",
                            "description": "Replace all occurrences (default: false)"
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "Legacy alias for replaceAll"
                        },
                        "occurrence": {
                            "type": "number",
                            "description": "Which occurrence to replace (default: 1)"
                        },
                        "dryRun": {
                            "type": "boolean",
                            "description": "Preview diff without writing"
                        }
                    },
                    "required": ["path"]
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

        // Find tool
        tools.insert(
            "find".to_string(),
            ToolDefinition {
                tool: Tool::new("find", "Search for files by glob pattern.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": {"type": "string", "description": "Glob pattern to match files"},
                            "path": {"type": "string", "description": "Directory to search (default: cwd)"},
                            "limit": {"type": "number", "description": "Maximum number of results (default: 1000)"},
                            "includeHidden": {"type": "boolean", "description": "Include hidden files (default: true)"}
                        },
                        "required": ["pattern"]
                    })),
                requires_approval: false,
            },
        );

        // Search tool
        tools.insert(
            "search".to_string(),
            ToolDefinition {
                tool: Tool::new("search", "Search file contents using ripgrep.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": {"type": "string", "description": "Regex or literal pattern"},
                            "paths": {
                                "anyOf": [
                                    {"type": "string"},
                                    {"type": "array", "items": {"type": "string"}}
                                ]
                            },
                            "glob": {"type": "string", "description": "Glob filter"},
                            "ignoreCase": {"type": "boolean", "description": "Case-insensitive search"},
                            "literal": {"type": "boolean", "description": "Treat pattern as literal"},
                            "word": {"type": "boolean", "description": "Match whole words only"},
                            "multiline": {"type": "boolean", "description": "Enable multiline"},
                            "maxResults": {"type": "number", "description": "Maximum matches"},
                            "context": {"type": "number", "description": "Lines of context (before/after)"},
                            "beforeContext": {"type": "number", "description": "Lines of context before"},
                            "afterContext": {"type": "number", "description": "Lines of context after"},
                            "cwd": {"type": "string", "description": "Working directory"},
                            "includeHidden": {"type": "boolean", "description": "Include hidden files"},
                            "useGitIgnore": {"type": "boolean", "description": "Respect .gitignore"},
                            "outputMode": {"type": "string", "description": "content | files | count"},
                            "format": {"type": "string", "description": "text | json"},
                            "invertMatch": {"type": "boolean", "description": "Invert match"},
                            "onlyMatching": {"type": "boolean", "description": "Only matching text"},
                            "headLimit": {"type": "number", "description": "Limit output lines"}
                        },
                        "required": ["pattern"]
                    })),
                requires_approval: false,
            },
        );

        // Parallel ripgrep tool
        tools.insert(
            "parallel_ripgrep".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "parallel_ripgrep",
                    "Run multiple ripgrep patterns in parallel and merge results.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "patterns": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                        "paths": {
                            "anyOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ]
                        },
                        "glob": {"type": "string"},
                        "ignoreCase": {"type": "boolean"},
                        "literal": {"type": "boolean"},
                        "word": {"type": "boolean"},
                        "multiline": {"type": "boolean"},
                        "maxResults": {"type": "number"},
                        "context": {"type": "number"},
                        "beforeContext": {"type": "number"},
                        "afterContext": {"type": "number"},
                        "cwd": {"type": "string"},
                        "includeHidden": {"type": "boolean"},
                        "useGitIgnore": {"type": "boolean"},
                        "headLimit": {"type": "number"}
                    },
                    "required": ["patterns"]
                })),
                requires_approval: false,
            },
        );

        // Web search tool (Exa)
        tools.insert(
            "websearch".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "websearch",
                    "Search the web for current information via Exa.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "numResults": {"type": "number"},
                        "type": {"type": "string"},
                        "category": {"type": "string"},
                        "includeDomains": {"type": "array", "items": {"type": "string"}},
                        "excludeDomains": {"type": "array", "items": {"type": "string"}},
                        "text": {},
                        "summary": {},
                        "highlights": {},
                        "context": {},
                        "startPublishedDate": {"type": "string"},
                        "endPublishedDate": {"type": "string"},
                        "livecrawl": {"type": "string"},
                        "subpages": {"type": "object"}
                    },
                    "required": ["query"]
                })),
                requires_approval: false,
            },
        );

        // Code search tool (Exa)
        tools.insert(
            "codesearch".to_string(),
            ToolDefinition {
                tool: Tool::new("codesearch", "Search code examples and docs via Exa.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "tokensNum": {}
                        },
                        "required": ["query"]
                    })),
                requires_approval: false,
            },
        );

        // Background tasks tool
        tools.insert(
            "background_tasks".to_string(),
            ToolDefinition {
                tool: Tool::new("background_tasks", "Manage long-running background tasks.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "description": "start | stop | list | logs"},
                            "command": {"type": "string"},
                            "cwd": {"type": "string"},
                            "env": {"type": "object"},
                            "shell": {"type": "boolean"},
                            "taskId": {"type": "string"},
                            "lines": {"type": "number"},
                            "restart": {"type": "object"}
                        },
                        "required": ["action"]
                    })),
                requires_approval: true,
            },
        );

        // Status tool
        tools.insert(
            "status".to_string(),
            ToolDefinition {
                tool: Tool::new("status", "Show git status (porcelain v2).").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "branchSummary": {"type": "boolean"},
                            "includeIgnored": {"type": "boolean"},
                            "paths": {
                                "anyOf": [
                                    {"type": "string"},
                                    {"type": "array", "items": {"type": "string"}}
                                ]
                            }
                        },
                        "required": []
                    }),
                ),
                requires_approval: false,
            },
        );

        // Todo tool
        tools.insert(
            "todo".to_string(),
            ToolDefinition {
                tool: Tool::new("todo", "Create or update a todo checklist.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "goal": {"type": "string"},
                            "items": {},
                            "updates": {"type": "array"},
                            "includeSummary": {"type": "boolean"}
                        },
                        "required": ["goal"]
                    }),
                ),
                requires_approval: false,
            },
        );

        // Ask user tool
        tools.insert(
            "ask_user".to_string(),
            ToolDefinition {
                tool: Tool::new("ask_user", "Ask structured questions to the user.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "questions": {"type": "array"}
                        },
                        "required": ["questions"]
                    }),
                ),
                requires_approval: false,
            },
        );

        // Extract document tool
        tools.insert(
            "extract_document".to_string(),
            ToolDefinition {
                tool: Tool::new(
                    "extract_document",
                    "Download a document and extract its text (PDF, DOCX, XLSX, PPTX).",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "maxChars": {"type": "number"}
                    },
                    "required": ["url"]
                })),
                requires_approval: false,
            },
        );

        // Notebook edit tool
        tools.insert(
            "notebook_edit".to_string(),
            ToolDefinition {
                tool: Tool::new("notebook_edit", "Edit Jupyter notebook (.ipynb) files.")
                    .with_schema(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "cell_id": {"type": "string"},
                            "cell_index": {"type": "number"},
                            "new_source": {"type": "string"},
                            "cell_type": {"type": "string"},
                            "edit_mode": {"type": "string"}
                        },
                        "required": ["path", "new_source"]
                    })),
                requires_approval: true,
            },
        );

        // GitHub CLI tools (gh api)
        tools.insert(
            "gh_pr".to_string(),
            ToolDefinition {
                tool: Tool::new("gh_pr", "GitHub pull request operations via gh api.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "action": {"type": "string"},
                            "number": {"type": "number"},
                            "title": {"type": "string"},
                            "body": {"type": "string"},
                            "branch": {"type": "string"},
                            "base": {"type": "string"},
                            "draft": {"type": "boolean"},
                            "state": {"type": "string"},
                            "author": {"type": "string"},
                            "label": {"type": "array", "items": {"type": "string"}},
                            "milestone": {"type": "string"},
                            "limit": {"type": "number"},
                            "json": {"type": "boolean"},
                            "nameOnly": {"type": "boolean"},
                            "repository": {"type": "string"}
                        },
                        "required": ["action"]
                    }),
                ),
                requires_approval: true,
            },
        );

        tools.insert(
            "gh_issue".to_string(),
            ToolDefinition {
                tool: Tool::new("gh_issue", "GitHub issue operations via gh api.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "action": {"type": "string"},
                            "number": {"type": "number"},
                            "title": {"type": "string"},
                            "body": {"type": "string"},
                            "labels": {"type": "array", "items": {"type": "string"}},
                            "state": {"type": "string"},
                            "author": {"type": "string"},
                            "limit": {"type": "number"},
                            "json": {"type": "boolean"},
                            "repository": {"type": "string"}
                        },
                        "required": ["action"]
                    }),
                ),
                requires_approval: true,
            },
        );

        tools.insert(
            "gh_repo".to_string(),
            ToolDefinition {
                tool: Tool::new("gh_repo", "GitHub repository operations via gh api.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "action": {"type": "string"},
                            "repository": {"type": "string"},
                            "directory": {"type": "string"},
                            "json": {"type": "boolean"}
                        },
                        "required": ["action"]
                    }),
                ),
                requires_approval: true,
            },
        );

        // Web fetch tool - retrieve web content
        let webfetch_definition = WebFetchTool::definition();
        tools.insert(
            "web_fetch".to_string(),
            ToolDefinition {
                tool: webfetch_definition.clone(),
                requires_approval: false, // Safe read-only operation
            },
        );
        tools.insert(
            "webfetch".to_string(),
            ToolDefinition {
                tool: Tool::new("webfetch", webfetch_definition.description.clone())
                    .with_schema(webfetch_definition.input_schema.clone()),
                requires_approval: false,
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

        // MCP resource tools
        tools.insert(
            "mcp_list_resources".to_string(),
            ToolDefinition {
                tool: Tool::new("mcp_list_resources", "List available MCP resources.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "server": {"type": "string"}
                        },
                        "required": []
                    }),
                ),
                requires_approval: false,
            },
        );
        tools.insert(
            "mcp_read_resource".to_string(),
            ToolDefinition {
                tool: Tool::new("mcp_read_resource", "Read an MCP resource by URI.").with_schema(
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "server": {"type": "string"},
                            "uri": {"type": "string"}
                        },
                        "required": ["server", "uri"]
                    }),
                ),
                requires_approval: false,
            },
        );

        // IDE tools (stubs for parity)
        for name in [
            "vscode_get_diagnostics",
            "vscode_get_definition",
            "vscode_find_references",
            "vscode_read_file_range",
            "jetbrains_get_diagnostics",
            "jetbrains_get_definition",
            "jetbrains_find_references",
            "jetbrains_read_file_range",
        ] {
            tools.insert(
                name.to_string(),
                ToolDefinition {
                    tool: Tool::new(name, "IDE integration tool (client-side).").with_schema(
                        serde_json::json!({
                            "type": "object",
                            "properties": {
                                "uri": {"type": "string"},
                                "line": {"type": "number"},
                                "character": {"type": "number"},
                                "startLine": {"type": "number"},
                                "endLine": {"type": "number"}
                            },
                            "required": []
                        }),
                    ),
                    requires_approval: false,
                },
            );
        }

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
    /// // Edit tool requires a path (edit params are validated at runtime)
    /// let args = json!({"file_path": "/tmp/file.txt"});
    /// let missing = registry.missing_required("edit", &args);
    /// assert!(missing.is_empty());
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
                    let alias_present = match field {
                        "file_path" => args
                            .get("path")
                            .and_then(|v| v.as_str())
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false),
                        "path" => args
                            .get("file_path")
                            .and_then(|v| v.as_str())
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false),
                        _ => false,
                    };
                    if !present && !alias_present {
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
    /// assert_eq!(count, 36);  // includes search/parity tools + IDE stubs
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
    use crate::tools::details;

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
        assert_eq!(count, 36); // includes parity tools + IDE stubs
    }

    #[test]
    fn test_build_glob_pattern_relative() {
        let base = "/tmp/root";
        let pattern = "**/*.rs";
        let expected = Path::new(base).join(pattern).to_string_lossy().to_string();
        assert_eq!(build_glob_pattern(base, pattern), expected);
    }

    #[test]
    #[cfg(not(windows))]
    fn test_build_glob_pattern_absolute_unix() {
        let base = "/tmp/root";
        let pattern = "/tmp/root/**/*.rs";
        assert_eq!(build_glob_pattern(base, pattern), pattern);
    }

    #[test]
    #[cfg(windows)]
    fn test_build_glob_pattern_absolute_windows() {
        let base = r"C:\root";
        let pattern = r"C:\root\**\*.rs";
        assert_eq!(build_glob_pattern(base, pattern), pattern);
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
        // read requires path (file_path is accepted as alias)
        let missing = registry.missing_required("read", &serde_json::json!({}));
        assert_eq!(missing, vec!["path".to_string()]);

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
    async fn test_executor_read_file_as_base64() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("binary.bin");
        let bytes = [0_u8, 1, 2, 3, 4, 5];
        std::fs::write(&file_path, bytes).unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "as_base64": true
        });
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(result.success);
        let expected = STANDARD.encode(bytes);
        assert_eq!(result.output, expected);
    }

    #[tokio::test]
    async fn test_executor_read_file_binary_requires_base64() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("binary.bin");
        let bytes = [0_u8, 1, 2, 3, 4, 5];
        std::fs::write(&file_path, bytes).unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap()
        });
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(!result.success);
        assert!(result
            .error
            .unwrap_or_default()
            .to_lowercase()
            .contains("binary file detected"));
    }

    #[tokio::test]
    async fn test_executor_read_file_no_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("plain.txt");
        std::fs::write(&file_path, "alpha\nbeta").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": file_path.to_str().unwrap(),
            "line_numbers": false,
            "wrap_in_code_fence": false
        });
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(result.success);
        assert!(result.output.contains("alpha\nbeta"));
        assert!(!result.output.contains('\t'));
    }

    #[tokio::test]
    async fn test_executor_read_file_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("relative.txt");
        std::fs::write(&file_path, "hello from relative").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({"file_path": "relative.txt"});
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(result.success);
        assert!(result.output.contains("hello from relative"));
    }

    #[tokio::test]
    async fn test_executor_read_file_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("large.txt");
        let data = vec![b'a'; (MAX_READ_SIZE_BYTES + 1) as usize];
        std::fs::write(&file_path, data).unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});
        let result = executor.execute("read", &args, None, "test-call").await;

        assert!(!result.success);
        assert!(result
            .error
            .unwrap_or_default()
            .to_lowercase()
            .contains("too large"));
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
    async fn test_executor_write_file_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": "nested/output.txt",
            "content": "relative write"
        });
        let result = executor.execute("write", &args, None, "test-call").await;

        assert!(result.success);
        let content = std::fs::read_to_string(dir.path().join("nested/output.txt")).unwrap();
        assert_eq!(content, "relative write");
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

        assert!(result.success);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "baz bar foo");
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

    #[test]
    fn test_shell_escape() {
        assert_eq!(shell_escape(""), "''");
        assert_eq!(shell_escape("simple"), "'simple'");
        assert_eq!(shell_escape("with space"), "'with space'");
        assert_eq!(shell_escape("a'b"), "'a'\\''b'");
    }

    #[test]
    fn test_extract_grep_path_unix() {
        assert_eq!(
            extract_grep_path("src/main.rs:12:fn main()"),
            Some("src/main.rs")
        );
    }

    #[test]
    fn test_extract_grep_path_colon_in_match() {
        assert_eq!(
            extract_grep_path("src/lib.rs:5:let x: i32 = 5;"),
            Some("src/lib.rs")
        );
    }

    #[test]
    fn test_extract_grep_path_windows() {
        assert_eq!(
            extract_grep_path(r"C:\repo\main.rs:12:fn main()"),
            Some(r"C:\repo\main.rs")
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_to_shell_path_drive_letter() {
        assert_eq!(to_shell_path(r"C:\repo\file.txt"), "/c/repo/file.txt");
    }

    #[test]
    #[cfg(not(windows))]
    fn test_to_shell_path_passthrough() {
        assert_eq!(to_shell_path("src/main.rs"), "src/main.rs");
    }

    #[test]
    #[cfg(not(windows))]
    fn test_normalize_git_path_strips_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("foo.txt");
        std::fs::write(&file_path, "data").unwrap();

        let (display, shell) =
            normalize_git_path(dir.path().to_str().unwrap(), file_path.to_str().unwrap()).unwrap();

        assert_eq!(display, "foo.txt");
        assert_eq!(shell, "foo.txt");
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

    // ============================================================
    // Tool Details Tests
    // ============================================================

    #[tokio::test]
    async fn test_read_details_populated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "line1\nline2\nline3\n").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": path.to_str().unwrap()
        });

        let result = executor.execute("read", &args, None, "test-call").await;
        assert!(result.success);
        assert!(result.details.is_some());

        let details: details::ReadDetails =
            serde_json::from_value(result.details.unwrap()).unwrap();
        assert_eq!(details.path, path.to_str().unwrap());
        assert!(details.size_bytes.is_some());
        assert_eq!(details.lines_read, Some(3));
        assert!(!details.truncated);
        assert!(details.duration_ms.is_some());
    }

    #[tokio::test]
    async fn test_write_details_populated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new_file.txt");

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": path.to_str().unwrap(),
            "content": "hello world"
        });

        let result = executor.execute("write", &args, None, "test-call").await;
        assert!(result.success);
        assert!(result.details.is_some());

        let details: details::WriteDetails =
            serde_json::from_value(result.details.unwrap()).unwrap();
        assert_eq!(details.path, path.to_str().unwrap());
        assert_eq!(details.bytes_written, Some(11));
        assert!(details.created); // New file was created
        assert!(details.duration_ms.is_some());
    }

    #[tokio::test]
    async fn test_write_details_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.txt");
        std::fs::write(&path, "old content").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": path.to_str().unwrap(),
            "content": "new content"
        });

        let result = executor.execute("write", &args, None, "test-call").await;
        assert!(result.success);
        assert!(result.details.is_some());

        let details: details::WriteDetails =
            serde_json::from_value(result.details.unwrap()).unwrap();
        assert!(!details.created); // File already existed
    }

    #[tokio::test]
    async fn test_edit_details_populated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edit_test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": path.to_str().unwrap(),
            "old_string": "world",
            "new_string": "rust"
        });

        let result = executor.execute("edit", &args, None, "test-call").await;
        assert!(result.success);
        assert!(result.details.is_some());

        let details: details::EditDetails =
            serde_json::from_value(result.details.unwrap()).unwrap();
        assert_eq!(details.path, path.to_str().unwrap());
        assert_eq!(details.replacements, Some(1));
        assert!(details.duration_ms.is_some());
    }

    #[tokio::test]
    async fn test_edit_details_with_line_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("multiline.txt");
        std::fs::write(&path, "single line").unwrap();

        let executor = ToolExecutor::new(dir.path().to_str().unwrap());
        let args = serde_json::json!({
            "file_path": path.to_str().unwrap(),
            "old_string": "single line",
            "new_string": "line one\nline two\nline three"
        });

        let result = executor.execute("edit", &args, None, "test-call").await;
        assert!(result.success);
        assert!(result.details.is_some());

        let details: details::EditDetails =
            serde_json::from_value(result.details.unwrap()).unwrap();
        assert_eq!(details.lines_added, Some(2)); // Added 2 lines
    }
}

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
//! - **`ToolRegistry`**: A HashMap-based registry of tool definitions with JSON schemas.
//!   It validates arguments, checks required fields, and determines approval requirements.
//! - **`ToolExecutor`**: The execution dispatcher that routes tool calls to implementations.
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
//! 1. **`ToolStart`**: Emitted when execution begins (contains `call_id`)
//! 2. **`ToolOutput`**: Emitted for progress/partial output (optional, repeatable)
//! 3. **`ToolEnd`**: Emitted when execution completes (contains success flag)
//!
//! These events enable real-time UI updates and streaming output display.
//!
//! # Error Handling
//!
//! Errors are returned in the `ToolResult` structure, never panicked:
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
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
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
use crate::lsp;
use crate::mcp::{
    append_mcp_prompt_summary, load_mcp_config, McpClient, McpConfigScope, McpContent, McpPrompt,
    McpTransport,
};
use crate::safety::{
    expand_tilde, is_tilde_path, require_plan, run_validators_with_diagnostics, ActionFirewall,
    FirewallVerdict,
};

const MAX_READ_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_GREP_LINES: usize = 100;
const MAX_LIST_LINES: usize = 200;
const MAX_DIFF_LINES: usize = 400;
const MCP_RECONNECT_RETRY_COOLDOWN: Duration = Duration::from_secs(30);

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

fn normalize_uri_input(input: &str) -> String {
    if let Some(rest) = input.strip_prefix("file://") {
        let mut path = rest.to_string();
        let mut stripped_localhost = false;
        if let Some(stripped) = path.strip_prefix("localhost/") {
            path = stripped.to_string();
            stripped_localhost = true;
        }
        #[cfg(not(windows))]
        if stripped_localhost && !path.starts_with('/') {
            path = format!("/{path}");
        }
        #[cfg(windows)]
        {
            if path.len() >= 3 && path.as_bytes()[0] == b'/' && path.as_bytes()[2] == b':' {
                path = path[1..].to_string();
            }
        }
        return path;
    }
    input.to_string()
}

async fn read_file_range(
    path: &str,
    start_line: usize,
    end_line: usize,
) -> Result<(String, usize), String> {
    if start_line > end_line {
        return Err("startLine must be <= endLine".to_string());
    }

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let reader = tokio::io::BufReader::new(file);
    let mut lines = reader.lines();
    let mut output = String::new();
    let mut index: usize = 0;
    let mut lines_read = 0;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?
    {
        if index >= start_line && index <= end_line {
            output.push_str(&line);
            output.push('\n');
            lines_read += 1;
        }
        if index >= end_line {
            break;
        }
        index += 1;
    }

    Ok((output, lines_read))
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

/// MCP server status snapshot for UI rendering
#[derive(Debug, Clone)]
pub struct McpServerStatus {
    pub name: String,
    pub connected: bool,
    pub scope: McpConfigScope,
    pub transport: McpTransport,
    pub error: Option<String>,
    pub tools: Vec<String>,
    pub resources: Vec<String>,
    pub prompts: Vec<String>,
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
/// `ToolExecutor` is `Send` but not `Sync` because it contains `BashTool` which uses
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
    /// operations. Uses `RwLock` for thread-safe access across async tasks.
    cache: RwLock<ToolResultCache>,

    /// MCP client for resource tools (lazy-initialized)
    mcp_client: tokio::sync::Mutex<Option<Arc<crate::mcp::McpClient>>>,

    /// MCP tool annotations for approval hints
    mcp_tool_annotations: RwLock<HashMap<String, crate::mcp::McpToolAnnotations>>,

    /// Last connection error for configured MCP servers.
    mcp_last_errors: RwLock<HashMap<String, String>>,

    /// Last synced MCP config snapshot, keyed by server name.
    mcp_synced_configs: RwLock<HashMap<String, crate::mcp::McpServerConfig>>,

    /// Last reconnect attempt timestamp for configured MCP servers.
    mcp_last_connect_attempts: RwLock<HashMap<String, Instant>>,
}

impl ToolExecutor {
    /// Create a new tool executor with the given working directory
    ///
    /// # Arguments
    ///
    /// - `cwd`: Working directory for all tool operations. Accepts any type that
    ///   converts to String (String, &str, `PathBuf` via display, etc.)
    ///
    /// # Examples
    ///
    /// ```
    /// use maestro_tui::tools::ToolExecutor;
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
            mcp_last_errors: RwLock::new(HashMap::new()),
            mcp_synced_configs: RwLock::new(HashMap::new()),
            mcp_last_connect_attempts: RwLock::new(HashMap::new()),
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
            mcp_last_errors: RwLock::new(HashMap::new()),
            mcp_synced_configs: RwLock::new(HashMap::new()),
            mcp_last_connect_attempts: RwLock::new(HashMap::new()),
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
        self.cache
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stats()
    }

    /// Clear the tool result cache
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.write() {
            cache.clear();
        }
    }

    async fn ensure_mcp_client(&self) -> Result<Arc<McpClient>, String> {
        let config = load_mcp_config(Some(Path::new(&self.cwd)));
        let servers: Vec<_> = config.enabled_servers().cloned().collect();
        let desired_configs: HashMap<String, crate::mcp::McpServerConfig> = servers
            .iter()
            .cloned()
            .map(|server| (server.name.clone(), server))
            .collect();
        let previous_configs = self
            .mcp_synced_configs
            .read()
            .map(|configs| configs.clone())
            .unwrap_or_default();
        let mut last_errors = self
            .mcp_last_errors
            .read()
            .map(|errors| errors.clone())
            .unwrap_or_default();
        let mut last_attempts = self
            .mcp_last_connect_attempts
            .read()
            .map(|attempts| attempts.clone())
            .unwrap_or_default();
        let client = {
            let mut guard = self.mcp_client.lock().await;
            Arc::clone(guard.get_or_insert_with(|| Arc::new(McpClient::new())))
        };

        for (name, previous) in &previous_configs {
            if desired_configs.get(name) != Some(previous) {
                let _ = client.disconnect(name).await;
            }
        }

        let connected: std::collections::HashSet<_> =
            client.connected_servers().await.into_iter().collect();
        let now = Instant::now();

        for server in &servers {
            let name = &server.name;
            let config_changed = previous_configs.get(name) != Some(server);
            let is_connected = connected.contains(name);
            let retry_allowed = match last_attempts.get(name) {
                Some(last_attempt) => {
                    now.duration_since(*last_attempt) >= MCP_RECONNECT_RETRY_COOLDOWN
                }
                None => true,
            };

            if config_changed || (!is_connected && retry_allowed) {
                match client.connect(server.clone()).await {
                    Ok(()) => {
                        last_errors.remove(name);
                    }
                    Err(err) => {
                        let message = err.to_string();
                        if last_errors.get(name) != Some(&message) {
                            eprintln!(
                                "[mcp] Failed to connect to server {}: {}",
                                server.name, message
                            );
                        }
                        last_errors.insert(name.clone(), message);
                    }
                }
                last_attempts.insert(name.clone(), Instant::now());
            } else if is_connected {
                last_errors.remove(name);
            }
        }

        last_errors.retain(|name, _| desired_configs.contains_key(name));
        last_attempts.retain(|name, _| desired_configs.contains_key(name));

        if let Ok(mut map) = self.mcp_synced_configs.write() {
            *map = desired_configs;
        }
        if let Ok(mut map) = self.mcp_last_errors.write() {
            *map = last_errors;
        }
        if let Ok(mut map) = self.mcp_last_connect_attempts.write() {
            *map = last_attempts;
        }

        let annotations = client.list_tool_annotations().await;
        if let Ok(mut map) = self.mcp_tool_annotations.write() {
            map.clear();
            for (name, meta) in annotations {
                map.insert(name.to_lowercase(), meta);
            }
        }

        Ok(client)
    }

    /// Get MCP server status snapshots for UI display
    pub async fn mcp_status(&self) -> Result<Vec<McpServerStatus>, String> {
        let config = load_mcp_config(Some(Path::new(&self.cwd)));
        let client = self.ensure_mcp_client().await?;

        let connected: std::collections::HashSet<_> =
            client.connected_servers().await.into_iter().collect();
        let tools_map: HashMap<String, Vec<String>> =
            client.list_tools_by_server().await.into_iter().collect();
        let resources_map: HashMap<String, Vec<String>> =
            client.list_all_resources().await.into_iter().collect();
        let prompts_map: HashMap<String, Vec<String>> =
            client.list_all_prompts().await.into_iter().collect();
        let last_errors = self
            .mcp_last_errors
            .read()
            .map(|errors| errors.clone())
            .unwrap_or_default();

        let mut statuses = Vec::new();
        for server in config.enabled_servers() {
            let name = server.name.clone();
            let status = McpServerStatus {
                name: name.clone(),
                connected: connected.contains(&name),
                scope: server.scope,
                transport: server.transport,
                error: last_errors.get(&name).cloned(),
                tools: tools_map.get(&name).cloned().unwrap_or_default(),
                resources: resources_map.get(&name).cloned().unwrap_or_default(),
                prompts: prompts_map.get(&name).cloned().unwrap_or_default(),
            };
            statuses.push(status);
        }

        Ok(statuses)
    }

    /// Get detailed MCP prompt metadata for connected servers
    pub async fn mcp_prompt_details(
        &self,
        server_filter: Option<&str>,
    ) -> Result<Vec<(String, Vec<McpPrompt>)>, String> {
        let client = self.ensure_mcp_client().await?;
        let mut prompts = client.list_all_prompt_details().await;
        if let Some(filter) = server_filter {
            prompts.retain(|(name, _)| name == filter);
        }

        Ok(prompts
            .into_iter()
            .filter(|(_, prompt_entries)| !prompt_entries.is_empty())
            .collect())
    }

    /// Read an MCP resource via the configured client
    pub async fn mcp_read_resource(
        &self,
        server: &str,
        uri: &str,
    ) -> Result<crate::mcp::protocol::ResourceReadResult, String> {
        let client = self.ensure_mcp_client().await?;
        client
            .read_resource(server, uri)
            .await
            .map_err(|err| err.to_string())
    }

    /// Get an MCP prompt via the configured client
    pub async fn mcp_get_prompt(
        &self,
        server: &str,
        name: &str,
        arguments: Option<HashMap<String, String>>,
    ) -> Result<crate::mcp::PromptGetResult, String> {
        let client = self.ensure_mcp_client().await?;
        client
            .get_prompt(server, name, arguments)
            .await
            .map_err(|err| err.to_string())
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
    /// use maestro_tui::tools::ToolExecutor;
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

    /// Drain live MCP notifications and refresh cached metadata when server lists change.
    pub async fn poll_mcp_updates(&self) -> Result<Vec<crate::mcp::McpRuntimeEvent>, String> {
        let client = {
            let guard = self.mcp_client.lock().await;
            guard.as_ref().cloned()
        };
        let Some(client) = client else {
            return Ok(Vec::new());
        };

        let events = client
            .poll_notifications()
            .await
            .map_err(|err| err.to_string())?;

        if events
            .iter()
            .any(crate::mcp::McpRuntimeEvent::changes_tools)
        {
            let annotations = client.list_tool_annotations().await;
            if let Ok(mut map) = self.mcp_tool_annotations.write() {
                map.clear();
                for (name, meta) in annotations {
                    map.insert(name.to_lowercase(), meta);
                }
            }
        }

        Ok(events)
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
    /// use maestro_tui::tools::ToolExecutor;
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
    /// use maestro_tui::tools::ToolExecutor;
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
    /// 3. Send `ToolStart` event (if `event_tx` provided)
    /// 4. Execute tool implementation
    /// 5. Send `ToolOutput` event for any output (if `event_tx` provided)
    /// 6. Send `ToolEnd` event with success status (if `event_tx` provided)
    /// 7. Return `ToolResult`
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
    /// A `ToolResult` containing:
    /// - `success`: Whether the tool executed successfully
    /// - `output`: Tool output (stdout, file contents, etc.)
    /// - `error`: Optional error message if success is false
    ///
    /// # Event Streaming
    ///
    /// If `event_tx` is provided, the executor sends events for real-time updates:
    /// - **`ToolStart`**: Sent before execution begins
    /// - **`ToolOutput`**: Sent when output is available (may be sent multiple times)
    /// - **`ToolEnd`**: Sent after execution completes
    ///
    /// # Error Handling
    ///
    /// Errors are never panicked. Instead, they are returned in the `ToolResult`:
    /// - Invalid arguments: Deserialization errors
    /// - Tool errors: File not found, permission denied, etc.
    /// - Unknown tool: Tool name not found in registry
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use maestro_tui::tools::ToolExecutor;
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
    /// use maestro_tui::agent::FromAgent;
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
            return ToolResult::failure(format!("Blocked by action firewall: {reason}"));
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
}

mod execute;
mod tool_registry;
pub use tool_registry::ToolRegistry;
#[cfg(test)]
mod tests;

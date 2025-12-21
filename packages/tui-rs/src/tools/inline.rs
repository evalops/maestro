//! Inline Tool Definitions
//!
//! Allows users to define custom shell-based tools via JSON configuration files.
//! Tools are loaded from:
//! - `~/.composer/tools.json` (user-level)
//! - `.composer/tools.json` (project-level, overrides user)
//!
//! # Configuration Format
//!
//! ```json
//! {
//!   "tools": [
//!     {
//!       "name": "deploy",
//!       "description": "Deploy to environment",
//!       "command": "./deploy.sh",
//!       "parameters": {
//!         "environment": {
//!           "type": "string",
//!           "enum": ["staging", "prod"],
//!           "description": "Target environment"
//!         }
//!       },
//!       "timeout": 60000,
//!       "cwd": "./scripts",
//!       "annotations": {
//!         "destructive": true,
//!         "requiresApproval": true
//!       }
//!     }
//!   ]
//! }
//! ```
//!
//! # Execution Model
//!
//! When an inline tool is called:
//! 1. Parameters are serialized to JSON and passed via stdin
//! 2. The command is executed in a shell with the configured working directory
//! 3. stdout is captured as the tool result
//! 4. Non-zero exit codes result in an error
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::tools::inline::{load_inline_tools, InlineToolExecutor};
//!
//! let tools = load_inline_tools("/path/to/workspace");
//! for tool in &tools {
//!     println!("Found inline tool: {}", tool.name);
//! }
//!
//! // Execute an inline tool
//! let executor = InlineToolExecutor::new("/path/to/workspace");
//! let result = executor.execute(&tools[0], serde_json::json!({"env": "staging"})).await;
//! ```

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::details::InlineToolDetails;
use crate::agent::ToolResult;
use crate::ai::Tool;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/// Root configuration structure for tools.json
#[derive(Debug, Clone, Deserialize, Default)]
pub struct InlineToolsConfig {
    /// List of tool definitions
    #[serde(default)]
    pub tools: Vec<InlineToolDef>,
}

/// A single inline tool definition from the config file
#[derive(Debug, Clone, Deserialize)]
pub struct InlineToolDef {
    /// Unique tool name (must match pattern: starts with letter, alphanumeric + underscore)
    pub name: String,

    /// Human-readable description shown to the AI
    pub description: String,

    /// Shell command to execute
    pub command: String,

    /// Parameter definitions (optional)
    #[serde(default)]
    pub parameters: HashMap<String, ParameterDef>,

    /// Timeout in milliseconds (default: 120000 = 2 minutes)
    #[serde(default = "default_timeout")]
    pub timeout: u64,

    /// Working directory for command execution (default: workspace root)
    #[serde(default)]
    pub cwd: Option<String>,

    /// Environment variables to set
    #[serde(default)]
    pub env: HashMap<String, String>,

    /// Tool annotations for safety/UI hints
    #[serde(default)]
    pub annotations: ToolAnnotations,
}

/// Parameter definition for an inline tool
#[derive(Debug, Clone, Deserialize)]
pub struct ParameterDef {
    /// JSON Schema type: "string", "number", "boolean", "integer"
    #[serde(rename = "type")]
    pub param_type: String,

    /// Parameter description
    #[serde(default)]
    pub description: String,

    /// Allowed values (for enums)
    #[serde(rename = "enum", default)]
    pub enum_values: Vec<String>,

    /// Default value
    #[serde(default)]
    pub default: Option<serde_json::Value>,

    /// Whether parameter is required (default: true if no default)
    #[serde(default)]
    pub required: Option<bool>,
}

/// Tool annotations for safety and UI behavior
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ToolAnnotations {
    /// Indicates the tool performs destructive operations
    #[serde(default)]
    pub destructive: bool,

    /// Forces user approval before execution
    #[serde(rename = "requiresApproval", default)]
    pub requires_approval: bool,

    /// Tool is read-only (can be auto-approved)
    #[serde(rename = "readOnly", default)]
    pub read_only: bool,

    /// Tool is idempotent (safe to retry)
    #[serde(default)]
    pub idempotent: bool,
}

fn default_timeout() -> u64 {
    120_000 // 2 minutes
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaded Tool (ready for registration)
// ─────────────────────────────────────────────────────────────────────────────

/// A fully loaded inline tool ready for execution
#[derive(Debug, Clone)]
pub struct InlineTool {
    /// Tool definition for AI
    pub definition: InlineToolDef,

    /// Source file path
    pub source_path: PathBuf,

    /// Whether this is a user-level or project-level tool
    pub source: InlineToolSource,
}

/// Source of an inline tool definition
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InlineToolSource {
    /// User-level tool from ~/.composer/tools.json
    User,
    /// Project-level tool from .composer/tools.json
    Project,
}

impl InlineTool {
    /// Convert to AI Tool definition for registration
    pub fn to_tool(&self) -> Tool {
        Tool {
            name: self.definition.name.clone(),
            description: self.definition.description.clone(),
            input_schema: self.build_schema(),
        }
    }

    /// Build JSON schema from parameter definitions
    fn build_schema(&self) -> serde_json::Value {
        let mut properties = serde_json::Map::new();
        let mut required = Vec::new();

        for (name, param) in &self.definition.parameters {
            let mut prop = serde_json::Map::new();
            prop.insert("type".to_string(), serde_json::json!(param.param_type));

            if !param.description.is_empty() {
                prop.insert(
                    "description".to_string(),
                    serde_json::json!(param.description),
                );
            }

            if !param.enum_values.is_empty() {
                prop.insert("enum".to_string(), serde_json::json!(param.enum_values));
            }

            if let Some(default) = &param.default {
                prop.insert("default".to_string(), default.clone());
            }

            properties.insert(name.clone(), serde_json::Value::Object(prop));

            // Determine if required
            let is_required = param.required.unwrap_or(param.default.is_none());
            if is_required {
                required.push(name.clone());
            }
        }

        serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": required
        })
    }

    /// Check if this tool requires user approval
    pub fn requires_approval(&self) -> bool {
        // Requires approval if explicitly set, or if destructive, or not read-only
        self.definition.annotations.requires_approval
            || self.definition.annotations.destructive
            || !self.definition.annotations.read_only
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/// Get the paths to check for inline tools configuration
pub fn get_config_paths(workspace_dir: &Path) -> InlineToolsPaths {
    let user_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".composer")
        .join("tools.json");

    let project_path = workspace_dir.join(".composer").join("tools.json");

    InlineToolsPaths {
        user: user_path,
        project: project_path,
    }
}

/// Paths for inline tools configuration files
#[derive(Debug, Clone)]
pub struct InlineToolsPaths {
    /// User-level config: ~/.composer/tools.json
    pub user: PathBuf,
    /// Project-level config: .composer/tools.json
    pub project: PathBuf,
}

/// Load all inline tools from user and project configuration files
///
/// Project-level tools override user-level tools with the same name.
pub fn load_inline_tools(workspace_dir: &Path) -> Vec<InlineTool> {
    let paths = get_config_paths(workspace_dir);
    let mut tools_by_name: HashMap<String, InlineTool> = HashMap::new();

    // Load user-level tools first
    if let Some(user_tools) = load_tools_from_file(&paths.user, InlineToolSource::User) {
        for tool in user_tools {
            tools_by_name.insert(tool.definition.name.to_lowercase(), tool);
        }
    }

    // Load project-level tools (override user-level)
    if let Some(project_tools) = load_tools_from_file(&paths.project, InlineToolSource::Project) {
        for tool in project_tools {
            tools_by_name.insert(tool.definition.name.to_lowercase(), tool);
        }
    }

    // Sort by name for consistent ordering
    let mut tools: Vec<_> = tools_by_name.into_values().collect();
    tools.sort_by(|a, b| a.definition.name.cmp(&b.definition.name));
    tools
}

/// Load tools from a single configuration file
fn load_tools_from_file(path: &Path, source: InlineToolSource) -> Option<Vec<InlineTool>> {
    if !path.exists() {
        return None;
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Warning: Failed to read {}: {}", path.display(), e);
            return None;
        }
    };

    let config: InlineToolsConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Warning: Failed to parse {}: {}", path.display(), e);
            return None;
        }
    };

    let tools: Vec<InlineTool> = config
        .tools
        .into_iter()
        .filter(validate_tool_def)
        .map(|definition| InlineTool {
            definition,
            source_path: path.to_path_buf(),
            source,
        })
        .collect();

    Some(tools)
}

/// Validate a tool definition
fn validate_tool_def(def: &InlineToolDef) -> bool {
    // Name must start with letter and contain only alphanumeric + underscore
    if def.name.is_empty() {
        eprintln!("Warning: Skipping tool with empty name");
        return false;
    }

    let first_char = def.name.chars().next().unwrap();
    if !first_char.is_alphabetic() {
        eprintln!(
            "Warning: Skipping tool '{}': name must start with a letter",
            def.name
        );
        return false;
    }

    if !def
        .name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        eprintln!(
            "Warning: Skipping tool '{}': name contains invalid characters",
            def.name
        );
        return false;
    }

    // Command must not be empty
    if def.command.trim().is_empty() {
        eprintln!(
            "Warning: Skipping tool '{}': command cannot be empty",
            def.name
        );
        return false;
    }

    true
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/// Executor for inline tools
#[derive(Debug)]
pub struct InlineToolExecutor {
    /// Base workspace directory
    workspace_dir: PathBuf,
}

impl InlineToolExecutor {
    /// Create a new inline tool executor
    pub fn new(workspace_dir: impl Into<PathBuf>) -> Self {
        Self {
            workspace_dir: workspace_dir.into(),
        }
    }

    /// Execute an inline tool with the given arguments
    pub async fn execute(&self, tool: &InlineTool, args: serde_json::Value) -> ToolResult {
        let start_time = Instant::now();

        // Determine working directory
        let cwd = match &tool.definition.cwd {
            Some(dir) => {
                let path = Path::new(dir);
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.workspace_dir.join(path)
                }
            }
            None => self.workspace_dir.clone(),
        };

        // Build base details
        let mut details = InlineToolDetails::new(&tool.definition.name, &tool.definition.command)
            .with_cwd(cwd.display().to_string())
            .with_timeout_config(tool.definition.timeout)
            .with_source(match tool.source {
                InlineToolSource::User => "user",
                InlineToolSource::Project => "project",
            });

        // Build the command
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(&tool.definition.command)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Set environment variables
        for (key, value) in &tool.definition.env {
            cmd.env(key, value);
        }

        // Spawn the process
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                details = details.with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!("Failed to spawn command: {}", e))
                    .with_details(details.to_json());
            }
        };

        // Capture PID for process tree killing on timeout
        let child_pid = child.id();

        // Write args to stdin as JSON
        if let Some(mut stdin) = child.stdin.take() {
            let args_json = serde_json::to_string(&args).unwrap_or_default();
            if let Err(e) = stdin.write_all(args_json.as_bytes()).await {
                eprintln!("Warning: Failed to write to stdin: {}", e);
            }
            // stdin is dropped here, closing the pipe
        }

        // Take stdout/stderr handles before waiting
        let stdout_handle = child.stdout.take();
        let stderr_handle = child.stderr.take();

        // Wait for completion with timeout
        let timeout_duration = Duration::from_millis(tool.definition.timeout);

        let result = tokio::time::timeout(timeout_duration, async {
            let stdout_fut = async {
                if let Some(mut handle) = stdout_handle {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let read = handle.read_to_end(&mut buf).await;
                    read.map(|_| buf)
                } else {
                    Ok(Vec::new())
                }
            };

            let stderr_fut = async {
                if let Some(mut handle) = stderr_handle {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let read = handle.read_to_end(&mut buf).await;
                    read.map(|_| buf)
                } else {
                    Ok(Vec::new())
                }
            };

            tokio::join!(stdout_fut, stderr_fut, child.wait())
        })
        .await;

        match result {
            Ok((Ok(stdout), Ok(stderr), Ok(status))) => {
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let stdout_text = String::from_utf8_lossy(&stdout).to_string();
                let stderr_text = String::from_utf8_lossy(&stderr).to_string();

                // Update details with exit code and duration
                let exit_code = status.code().unwrap_or(-1);
                details = details.with_exit_code(exit_code).with_duration(duration_ms);

                if status.success() {
                    ToolResult::success(stdout_text.trim()).with_details(details.to_json())
                } else {
                    let error_msg = if stderr_text.is_empty() {
                        format!("Command exited with status: {}", status)
                    } else {
                        stderr_text.trim().to_string()
                    };

                    ToolResult {
                        success: false,
                        output: stdout_text,
                        error: Some(error_msg),
                        details: Some(details.to_json()),
                    }
                }
            }
            Ok((Err(e), _, _)) | Ok((_, Err(e), _)) => {
                let duration_ms = start_time.elapsed().as_millis() as u64;
                details = details.with_duration(duration_ms);
                ToolResult::failure(format!("IO error: {}", e)).with_details(details.to_json())
            }
            Ok((_, _, Err(e))) => {
                let duration_ms = start_time.elapsed().as_millis() as u64;
                details = details.with_duration(duration_ms);
                ToolResult::failure(format!("Process error: {}", e)).with_details(details.to_json())
            }
            Err(_) => {
                // Timeout - kill the process tree to avoid orphan children
                if let Some(pid) = child_pid {
                    kill_process_tree(pid);
                } else {
                    let _ = child.kill().await;
                }
                // Best-effort reap
                let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;

                let duration_ms = start_time.elapsed().as_millis() as u64;
                details = details.with_duration(duration_ms).with_timeout();

                ToolResult::failure(format!(
                    "Command timed out after {}ms",
                    tool.definition.timeout
                ))
                .with_details(details.to_json())
            }
        }
    }
}

/// Kill an entire process tree by PID.
///
/// Mirrors bash tool behavior to avoid leaving orphaned child processes.
#[cfg(unix)]
fn kill_process_tree(pid: u32) {
    // First, try to kill all child processes using pkill
    let _ = std::process::Command::new("pkill")
        .args(["-KILL", "-P", &pid.to_string()])
        .output();

    // Then kill the process itself using libc
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_config(dir: &Path, config: &str) {
        let composer_dir = dir.join(".composer");
        fs::create_dir_all(&composer_dir).unwrap();
        fs::write(composer_dir.join("tools.json"), config).unwrap();
    }

    #[test]
    fn test_load_empty_config() {
        let temp = TempDir::new().unwrap();
        let tools = load_inline_tools(temp.path());
        assert!(tools.is_empty());
    }

    #[test]
    fn test_load_simple_tool() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [{
                    "name": "hello",
                    "description": "Say hello",
                    "command": "echo hello"
                }]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].definition.name, "hello");
        assert_eq!(tools[0].definition.description, "Say hello");
        assert_eq!(tools[0].source, InlineToolSource::Project);
    }

    #[test]
    fn test_load_tool_with_parameters() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [{
                    "name": "greet",
                    "description": "Greet someone",
                    "command": "echo",
                    "parameters": {
                        "name": {
                            "type": "string",
                            "description": "Name to greet"
                        },
                        "loud": {
                            "type": "boolean",
                            "default": false
                        }
                    }
                }]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert_eq!(tools.len(), 1);

        let schema = tools[0].build_schema();
        let props = schema.get("properties").unwrap();
        assert!(props.get("name").is_some());
        assert!(props.get("loud").is_some());

        // "name" should be required (no default)
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.contains(&serde_json::json!("name")));
        // "loud" should not be required (has default)
        assert!(!required.contains(&serde_json::json!("loud")));
    }

    #[test]
    fn test_load_tool_with_enum() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [{
                    "name": "deploy",
                    "description": "Deploy to environment",
                    "command": "./deploy.sh",
                    "parameters": {
                        "environment": {
                            "type": "string",
                            "enum": ["staging", "prod"]
                        }
                    }
                }]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert_eq!(tools.len(), 1);

        let schema = tools[0].build_schema();
        let env_schema = schema
            .get("properties")
            .unwrap()
            .get("environment")
            .unwrap();
        let enum_values = env_schema.get("enum").unwrap().as_array().unwrap();
        assert_eq!(enum_values.len(), 2);
    }

    #[test]
    fn test_load_tool_with_annotations() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [{
                    "name": "dangerous",
                    "description": "Dangerous operation",
                    "command": "rm -rf /",
                    "annotations": {
                        "destructive": true,
                        "requiresApproval": true
                    }
                }]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert_eq!(tools.len(), 1);
        assert!(tools[0].definition.annotations.destructive);
        assert!(tools[0].definition.annotations.requires_approval);
        assert!(tools[0].requires_approval());
    }

    #[test]
    fn test_skip_invalid_tool_name() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [
                    {
                        "name": "123invalid",
                        "description": "Invalid",
                        "command": "echo"
                    },
                    {
                        "name": "valid_name",
                        "description": "Valid",
                        "command": "echo"
                    }
                ]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].definition.name, "valid_name");
    }

    #[test]
    fn test_skip_empty_command() {
        let temp = TempDir::new().unwrap();
        create_test_config(
            temp.path(),
            r#"{
                "tools": [{
                    "name": "empty",
                    "description": "Empty command",
                    "command": ""
                }]
            }"#,
        );

        let tools = load_inline_tools(temp.path());
        assert!(tools.is_empty());
    }

    #[test]
    fn test_malformed_json() {
        let temp = TempDir::new().unwrap();
        let composer_dir = temp.path().join(".composer");
        fs::create_dir_all(&composer_dir).unwrap();
        fs::write(composer_dir.join("tools.json"), "{ invalid json }").unwrap();

        let tools = load_inline_tools(temp.path());
        assert!(tools.is_empty());
    }

    #[test]
    fn test_missing_tools_array() {
        let temp = TempDir::new().unwrap();
        create_test_config(temp.path(), r#"{}"#);

        let tools = load_inline_tools(temp.path());
        assert!(tools.is_empty());
    }

    #[test]
    fn test_to_tool_conversion() {
        let def = InlineToolDef {
            name: "test".to_string(),
            description: "Test tool".to_string(),
            command: "echo test".to_string(),
            parameters: HashMap::new(),
            timeout: 60000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let inline_tool = InlineTool {
            definition: def,
            source_path: PathBuf::from("/test/tools.json"),
            source: InlineToolSource::Project,
        };

        let tool = inline_tool.to_tool();
        assert_eq!(tool.name, "test");
        assert_eq!(tool.description, "Test tool");
    }

    #[test]
    fn test_requires_approval_logic() {
        // Default annotations - not read_only, so requires approval
        let def1 = InlineToolDef {
            name: "test".to_string(),
            description: "Test".to_string(),
            command: "echo".to_string(),
            parameters: HashMap::new(),
            timeout: 60000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };
        let tool1 = InlineTool {
            definition: def1,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };
        assert!(tool1.requires_approval());

        // Read-only tool - no approval needed
        let def2 = InlineToolDef {
            name: "test".to_string(),
            description: "Test".to_string(),
            command: "echo".to_string(),
            parameters: HashMap::new(),
            timeout: 60000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations {
                read_only: true,
                ..Default::default()
            },
        };
        let tool2 = InlineTool {
            definition: def2,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };
        assert!(!tool2.requires_approval());

        // Destructive tool - always requires approval
        let def3 = InlineToolDef {
            name: "test".to_string(),
            description: "Test".to_string(),
            command: "echo".to_string(),
            parameters: HashMap::new(),
            timeout: 60000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations {
                destructive: true,
                read_only: true, // Even with read_only, destructive takes precedence
                ..Default::default()
            },
        };
        let tool3 = InlineTool {
            definition: def3,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };
        assert!(tool3.requires_approval());
    }

    #[test]
    fn test_get_config_paths() {
        let paths = get_config_paths(Path::new("/workspace"));
        assert!(paths.user.to_string_lossy().contains(".composer"));
        assert!(paths.user.to_string_lossy().contains("tools.json"));
        assert_eq!(
            paths.project,
            PathBuf::from("/workspace/.composer/tools.json")
        );
    }

    #[tokio::test]
    async fn test_execute_simple_command() {
        let temp = TempDir::new().unwrap();
        let executor = InlineToolExecutor::new(temp.path());

        let def = InlineToolDef {
            name: "echo_test".to_string(),
            description: "Echo test".to_string(),
            command: "echo 'hello world'".to_string(),
            parameters: HashMap::new(),
            timeout: 5000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor.execute(&tool, serde_json::json!({})).await;
        assert!(result.success);
        assert_eq!(result.output, "hello world");
    }

    #[tokio::test]
    async fn test_execute_with_stdin() {
        let temp = TempDir::new().unwrap();
        let executor = InlineToolExecutor::new(temp.path());

        // Command that reads from stdin and echoes it
        let def = InlineToolDef {
            name: "stdin_test".to_string(),
            description: "Stdin test".to_string(),
            command: "cat".to_string(),
            parameters: HashMap::new(),
            timeout: 5000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor
            .execute(&tool, serde_json::json!({"key": "value"}))
            .await;
        assert!(result.success);
        assert!(result.output.contains("key"));
        assert!(result.output.contains("value"));
    }

    #[tokio::test]
    async fn test_execute_failure() {
        let temp = TempDir::new().unwrap();
        let executor = InlineToolExecutor::new(temp.path());

        let def = InlineToolDef {
            name: "fail_test".to_string(),
            description: "Fail test".to_string(),
            command: "exit 1".to_string(),
            parameters: HashMap::new(),
            timeout: 5000,
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor.execute(&tool, serde_json::json!({})).await;
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn test_execute_timeout() {
        let temp = TempDir::new().unwrap();
        let executor = InlineToolExecutor::new(temp.path());

        let def = InlineToolDef {
            name: "timeout_test".to_string(),
            description: "Timeout test".to_string(),
            command: "sleep 10".to_string(),
            parameters: HashMap::new(),
            timeout: 100, // 100ms timeout
            cwd: None,
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor.execute(&tool, serde_json::json!({})).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("timed out"));
    }

    #[tokio::test]
    async fn test_execute_with_cwd() {
        let temp = TempDir::new().unwrap();
        let subdir = temp.path().join("subdir");
        fs::create_dir(&subdir).unwrap();

        let executor = InlineToolExecutor::new(temp.path());

        let def = InlineToolDef {
            name: "cwd_test".to_string(),
            description: "Cwd test".to_string(),
            command: "pwd".to_string(),
            parameters: HashMap::new(),
            timeout: 5000,
            cwd: Some("subdir".to_string()),
            env: HashMap::new(),
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor.execute(&tool, serde_json::json!({})).await;
        assert!(result.success);
        assert!(result.output.contains("subdir"));
    }

    #[tokio::test]
    async fn test_execute_with_env() {
        let temp = TempDir::new().unwrap();
        let executor = InlineToolExecutor::new(temp.path());

        let mut env = HashMap::new();
        env.insert("TEST_VAR".to_string(), "test_value".to_string());

        let def = InlineToolDef {
            name: "env_test".to_string(),
            description: "Env test".to_string(),
            command: "echo $TEST_VAR".to_string(),
            parameters: HashMap::new(),
            timeout: 5000,
            cwd: None,
            env,
            annotations: ToolAnnotations::default(),
        };

        let tool = InlineTool {
            definition: def,
            source_path: PathBuf::new(),
            source: InlineToolSource::Project,
        };

        let result = executor.execute(&tool, serde_json::json!({})).await;
        assert!(result.success);
        assert_eq!(result.output, "test_value");
    }
}

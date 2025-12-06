//! Tool registry and executor
//!
//! Manages tool definitions and execution.

use std::collections::HashMap;

use tokio::sync::mpsc;

use super::bash::{BashArgs, BashTool};
use crate::agent::{FromAgent, ToolDefinition, ToolResult};
use crate::ai::Tool;

/// Tool executor that can run tools
pub struct ToolExecutor {
    /// Bash tool instance
    bash: BashTool,
    /// Current working directory
    cwd: String,
}

impl ToolExecutor {
    /// Create a new tool executor
    pub fn new(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        Self {
            bash: BashTool::new(&cwd),
            cwd,
        }
    }

    /// Execute a tool by name
    pub async fn execute(
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
                        return ToolResult {
                            success: false,
                            output: String::new(),
                            error: Some(format!("Invalid bash arguments: {}", e)),
                        };
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
                // File reading tool
                let path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if path.is_empty() {
                    return ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some("Missing file_path argument".to_string()),
                    };
                }

                match tokio::fs::read_to_string(path).await {
                    Ok(content) => {
                        // Add line numbers
                        let numbered: String = content
                            .lines()
                            .enumerate()
                            .map(|(i, line)| format!("{:>6}\t{}", i + 1, line))
                            .collect::<Vec<_>>()
                            .join("\n");

                        ToolResult {
                            success: true,
                            output: numbered,
                            error: None,
                        }
                    }
                    Err(e) => ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some(format!("Failed to read file: {}", e)),
                    },
                }
            }
            "write" | "Write" => {
                let path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if path.is_empty() {
                    return ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some("Missing file_path argument".to_string()),
                    };
                }

                // Create parent directories if needed
                if let Some(parent) = std::path::Path::new(path).parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return ToolResult {
                            success: false,
                            output: String::new(),
                            error: Some(format!("Failed to create directory: {}", e)),
                        };
                    }
                }

                match tokio::fs::write(path, content).await {
                    Ok(_) => ToolResult {
                        success: true,
                        output: format!("File written successfully: {}", path),
                        error: None,
                    },
                    Err(e) => ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some(format!("Failed to write file: {}", e)),
                    },
                }
            }
            "glob" | "Glob" => {
                let pattern = args
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .unwrap_or("*");

                let base_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);

                // Use glob crate would be better, but for now use find
                let result = self
                    .bash
                    .execute(BashArgs {
                        command: format!(
                            "find {} -name '{}' -type f 2>/dev/null | head -100",
                            base_path, pattern
                        ),
                        timeout: Some(10000),
                        description: Some("Find files matching pattern".to_string()),
                        run_in_background: false,
                    })
                    .await;

                result
            }
            "grep" | "Grep" => {
                let pattern = args
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(".");

                if pattern.is_empty() {
                    return ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some("Missing pattern argument".to_string()),
                    };
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
            _ => ToolResult {
                success: false,
                output: String::new(),
                error: Some(format!("Unknown tool: {}", tool_name)),
            },
        }
    }

    /// Check if a tool requires approval
    pub fn requires_approval(&self, tool_name: &str, args: &serde_json::Value) -> bool {
        match tool_name {
            "bash" | "Bash" => {
                if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                    BashTool::requires_approval(cmd)
                } else {
                    true
                }
            }
            // Read operations don't need approval
            "read" | "Read" | "glob" | "Glob" | "grep" | "Grep" => false,
            // Write operations need approval
            "write" | "Write" | "edit" | "Edit" => true,
            // Default to requiring approval
            _ => true,
        }
    }
}

/// Tool registry that holds tool definitions
pub struct ToolRegistry {
    /// Tool definitions
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
                    "Read a file from the filesystem. Returns file contents with line numbers.",
                )
                .with_schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "The absolute path to the file to read"
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Line number to start reading from (optional)"
                        },
                        "limit": {
                            "type": "integer",
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

        Self { tools }
    }

    /// Get all tool definitions
    pub fn tools(&self) -> impl Iterator<Item = &ToolDefinition> {
        self.tools.values()
    }

    /// Get a tool definition by name
    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.get(name)
    }

    /// Check if a tool requires approval (considering dynamic logic)
    pub fn requires_approval(&self, name: &str, args: &serde_json::Value) -> bool {
        match name {
            "bash" | "Bash" => {
                if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                    BashTool::requires_approval(cmd)
                } else {
                    true
                }
            }
            _ => self.tools.get(name).map(|d| d.requires_approval).unwrap_or(true),
        }
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
    }

    #[test]
    fn test_registry_tool_count() {
        let registry = ToolRegistry::new();
        let count = registry.tools().count();
        assert_eq!(count, 5); // bash, read, write, glob, grep
    }

    #[test]
    fn test_registry_requires_approval_read() {
        let registry = ToolRegistry::new();
        let args = serde_json::json!({"file_path": "/etc/passwd"});
        assert!(!registry.requires_approval("read", &args));
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
        let result = executor.execute("nonexistent", &args, None, "test-call").await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("Unknown tool"));
    }
}

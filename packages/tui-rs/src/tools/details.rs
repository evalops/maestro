//! Tool Execution Details
//!
//! This module provides structured detail types for tool execution results.
//! These can be serialized into the `details` field of `AppMessage::ToolResult`
//! for richer session persistence.
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::tools::details::BashDetails;
//!
//! let details = BashDetails {
//!     command: "ls -la".to_string(),
//!     exit_code: 0,
//!     duration_ms: Some(150),
//!     truncated: false,
//!     ..Default::default()
//! };
//!
//! // Serialize to JSON for storage in ToolResult.details
//! let json = serde_json::to_value(&details)?;
//! ```

use serde::{Deserialize, Serialize};

/// Detailed information about a bash command execution.
///
/// This struct captures rich metadata that would otherwise be lost in a
/// simple string output. It's designed to be stored in the `details` field
/// of `AppMessage::ToolResult`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BashDetails {
    /// The command that was executed
    pub command: String,

    /// Exit code of the command (0 = success)
    pub exit_code: i32,

    /// Execution duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// Whether the command was cancelled by the user
    #[serde(default)]
    pub cancelled: bool,

    /// Whether the output was truncated due to size limits
    #[serde(default)]
    pub truncated: bool,

    /// Path to full output file if truncated
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,

    /// Working directory where command was executed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,

    /// Whether the command ran in the background
    #[serde(default)]
    pub background: bool,

    /// Process ID if running in background
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,

    /// Whether approval was required
    #[serde(default)]
    pub required_approval: bool,

    /// Description provided with the command
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl BashDetails {
    /// Create new bash details for a completed command
    pub fn new(command: impl Into<String>, exit_code: i32) -> Self {
        Self {
            command: command.into(),
            exit_code,
            ..Default::default()
        }
    }

    /// Create details for a successful command
    pub fn success(command: impl Into<String>) -> Self {
        Self::new(command, 0)
    }

    /// Create details for a failed command
    pub fn failed(command: impl Into<String>, exit_code: i32) -> Self {
        Self::new(command, exit_code)
    }

    /// Create details for a cancelled command
    pub fn cancelled(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cancelled: true,
            exit_code: 130, // Standard SIGINT exit code
            ..Default::default()
        }
    }

    /// Create details for a background command
    pub fn background(command: impl Into<String>, pid: u32) -> Self {
        Self {
            command: command.into(),
            background: true,
            pid: Some(pid),
            exit_code: 0,
            ..Default::default()
        }
    }

    /// Add duration information
    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Mark as truncated with optional full output path
    pub fn with_truncation(mut self, full_output_path: Option<String>) -> Self {
        self.truncated = true;
        self.full_output_path = full_output_path;
        self
    }

    /// Add working directory
    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Add description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Mark as requiring approval
    pub fn with_approval(mut self) -> Self {
        self.required_approval = true;
        self
    }

    /// Check if the command succeeded
    pub fn succeeded(&self) -> bool {
        self.exit_code == 0 && !self.cancelled
    }

    /// Convert to JSON value for storage
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// Try to parse from JSON value
    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a file read operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReadDetails {
    /// Path that was read
    pub path: String,

    /// File size in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,

    /// Number of lines read
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_read: Option<usize>,

    /// Whether the file was truncated
    #[serde(default)]
    pub truncated: bool,

    /// Line offset if partial read
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,

    /// Line limit if partial read
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,

    /// MIME type if detected
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// Read duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl ReadDetails {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            ..Default::default()
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Detailed information about a file write operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WriteDetails {
    /// Path that was written
    pub path: String,

    /// Bytes written
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_written: Option<u64>,

    /// Whether this was a new file
    #[serde(default)]
    pub created: bool,

    /// Write duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl WriteDetails {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            ..Default::default()
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Detailed information about a file edit operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditDetails {
    /// Path that was edited
    pub path: String,

    /// Number of replacements made
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacements: Option<usize>,

    /// Lines added
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<i32>,

    /// Lines removed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<i32>,

    /// Edit duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl EditDetails {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            ..Default::default()
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Union type for tool details that can be stored in ToolResult.details
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tool_type", rename_all = "snake_case")]
pub enum ToolDetails {
    Bash(BashDetails),
    Read(ReadDetails),
    Write(WriteDetails),
    Edit(EditDetails),
}

impl ToolDetails {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bash_details_success() {
        let details = BashDetails::success("ls -la");
        assert!(details.succeeded());
        assert_eq!(details.exit_code, 0);
    }

    #[test]
    fn test_bash_details_failed() {
        let details = BashDetails::failed("exit 1", 1);
        assert!(!details.succeeded());
        assert_eq!(details.exit_code, 1);
    }

    #[test]
    fn test_bash_details_cancelled() {
        let details = BashDetails::cancelled("sleep 1000");
        assert!(!details.succeeded());
        assert!(details.cancelled);
        assert_eq!(details.exit_code, 130);
    }

    #[test]
    fn test_bash_details_with_truncation() {
        let details =
            BashDetails::success("cat large_file").with_truncation(Some("/tmp/out.log".into()));

        assert!(details.truncated);
        assert_eq!(details.full_output_path, Some("/tmp/out.log".to_string()));
    }

    #[test]
    fn test_bash_details_to_json() {
        let details = BashDetails::success("echo hi").with_duration(100);

        let json = details.to_json();
        assert_eq!(json["command"], "echo hi");
        assert_eq!(json["exit_code"], 0);
        assert_eq!(json["duration_ms"], 100);
    }

    #[test]
    fn test_bash_details_from_json() {
        let json = serde_json::json!({
            "command": "pwd",
            "exit_code": 0,
            "truncated": false
        });

        let details = BashDetails::from_json(&json).unwrap();
        assert_eq!(details.command, "pwd");
        assert!(details.succeeded());
    }

    #[test]
    fn test_tool_details_union() {
        let bash = ToolDetails::Bash(BashDetails::success("ls"));
        let json = bash.to_json();

        assert_eq!(json["tool_type"], "bash");
        assert_eq!(json["command"], "ls");

        let parsed = ToolDetails::from_json(&json).unwrap();
        assert!(matches!(parsed, ToolDetails::Bash(_)));
    }

    #[test]
    fn test_read_details() {
        let details = ReadDetails {
            path: "/tmp/test.txt".to_string(),
            size_bytes: Some(1024),
            lines_read: Some(50),
            ..Default::default()
        };

        let json = details.to_json();
        assert_eq!(json["path"], "/tmp/test.txt");
        assert_eq!(json["size_bytes"], 1024);
    }
}

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

/// Detailed information about an image read/screenshot operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageDetails {
    /// Path that was read (if applicable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// MIME type of the image
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// Size in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,

    /// Image dimensions as "WxH"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<String>,

    /// Whether this was a screenshot vs file read
    #[serde(default)]
    pub is_screenshot: bool,

    /// Read/capture duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// Base64 encoded length
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64_length: Option<usize>,
}

impl ImageDetails {
    pub fn from_file(path: impl Into<String>) -> Self {
        Self {
            path: Some(path.into()),
            is_screenshot: false,
            ..Default::default()
        }
    }

    pub fn screenshot() -> Self {
        Self {
            is_screenshot: true,
            ..Default::default()
        }
    }

    pub fn with_mime_type(mut self, mime_type: impl Into<String>) -> Self {
        self.mime_type = Some(mime_type.into());
        self
    }

    pub fn with_size(mut self, size_bytes: u64) -> Self {
        self.size_bytes = Some(size_bytes);
        self
    }

    pub fn with_dimensions(mut self, width: u32, height: u32) -> Self {
        self.dimensions = Some(format!("{}x{}", width, height));
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn with_base64_length(mut self, len: usize) -> Self {
        self.base64_length = Some(len);
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a web fetch operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WebFetchDetails {
    /// URL that was fetched
    pub url: String,

    /// HTTP status code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,

    /// Content type from response headers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,

    /// Response body size in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_size: Option<usize>,

    /// Whether the content was truncated
    #[serde(default)]
    pub truncated: bool,

    /// Fetch duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// Final URL after redirects (if different from original)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,

    /// Optional prompt used for content extraction
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

impl WebFetchDetails {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            ..Default::default()
        }
    }

    pub fn with_status(mut self, code: u16) -> Self {
        self.status_code = Some(code);
        self
    }

    pub fn with_content_type(mut self, content_type: impl Into<String>) -> Self {
        self.content_type = Some(content_type.into());
        self
    }

    pub fn with_body_size(mut self, size: usize) -> Self {
        self.body_size = Some(size);
        self
    }

    pub fn with_truncation(mut self) -> Self {
        self.truncated = true;
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn with_final_url(mut self, url: impl Into<String>) -> Self {
        self.final_url = Some(url.into());
        self
    }

    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a glob/file search operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobDetails {
    /// The glob pattern used
    pub pattern: String,

    /// Base path for the search
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_path: Option<String>,

    /// Number of matches found
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_count: Option<usize>,

    /// Whether results were truncated (hit the limit)
    #[serde(default)]
    pub truncated: bool,

    /// Search duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl GlobDetails {
    pub fn new(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            ..Default::default()
        }
    }

    pub fn with_base_path(mut self, path: impl Into<String>) -> Self {
        self.base_path = Some(path.into());
        self
    }

    pub fn with_matches(mut self, count: usize) -> Self {
        self.matches_count = Some(count);
        self
    }

    pub fn with_truncation(mut self) -> Self {
        self.truncated = true;
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a grep/search operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrepDetails {
    /// The regex pattern used for searching
    pub pattern: String,

    /// Path or directory searched
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// Number of matches found
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_count: Option<usize>,

    /// Number of files with matches
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_matched: Option<usize>,

    /// Whether results were truncated (hit the limit)
    #[serde(default)]
    pub truncated: bool,

    /// Search duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// Which search tool was used (rg, grep)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_tool: Option<String>,
}

impl GrepDetails {
    pub fn new(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            ..Default::default()
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_matches(mut self, count: usize) -> Self {
        self.matches_count = Some(count);
        self
    }

    pub fn with_files_matched(mut self, count: usize) -> Self {
        self.files_matched = Some(count);
        self
    }

    pub fn with_truncation(mut self) -> Self {
        self.truncated = true;
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn with_search_tool(mut self, tool: impl Into<String>) -> Self {
        self.search_tool = Some(tool.into());
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a git diff operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiffDetails {
    /// Target commit or ref (e.g., "HEAD", "main")
    pub target: String,

    /// Path filter if specified
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// Number of files changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<usize>,

    /// Number of insertions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<usize>,

    /// Number of deletions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,

    /// Diff duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl DiffDetails {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            ..Default::default()
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_stats(mut self, files: usize, insertions: usize, deletions: usize) -> Self {
        self.files_changed = Some(files);
        self.insertions = Some(insertions);
        self.deletions = Some(deletions);
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Detailed information about a directory listing operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListDetails {
    /// Directory path listed
    pub path: String,

    /// Number of entries found
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries_count: Option<usize>,

    /// Whether listing was recursive
    #[serde(default)]
    pub recursive: bool,

    /// Whether results were truncated
    #[serde(default)]
    pub truncated: bool,

    /// List duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl ListDetails {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            ..Default::default()
        }
    }

    pub fn with_entries(mut self, count: usize) -> Self {
        self.entries_count = Some(count);
        self
    }

    pub fn with_recursive(mut self) -> Self {
        self.recursive = true;
        self
    }

    pub fn with_truncation(mut self) -> Self {
        self.truncated = true;
        self
    }

    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
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
    Image(ImageDetails),
    WebFetch(WebFetchDetails),
    Glob(GlobDetails),
    Grep(GrepDetails),
    Diff(DiffDetails),
    List(ListDetails),
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

    #[test]
    fn test_image_details_from_file() {
        let details = ImageDetails::from_file("/tmp/image.png")
            .with_mime_type("image/png")
            .with_size(1024)
            .with_dimensions(800, 600)
            .with_duration(50);

        assert_eq!(details.path, Some("/tmp/image.png".to_string()));
        assert_eq!(details.mime_type, Some("image/png".to_string()));
        assert_eq!(details.size_bytes, Some(1024));
        assert_eq!(details.dimensions, Some("800x600".to_string()));
        assert!(!details.is_screenshot);
        assert_eq!(details.duration_ms, Some(50));
    }

    #[test]
    fn test_image_details_screenshot() {
        let details = ImageDetails::screenshot()
            .with_mime_type("image/png")
            .with_size(2048)
            .with_base64_length(3000);

        assert!(details.is_screenshot);
        assert!(details.path.is_none());
        assert_eq!(details.size_bytes, Some(2048));
        assert_eq!(details.base64_length, Some(3000));
    }

    #[test]
    fn test_image_details_to_json() {
        let details = ImageDetails::from_file("/img.png")
            .with_mime_type("image/png")
            .with_size(500);

        let json = details.to_json();
        assert_eq!(json["path"], "/img.png");
        assert_eq!(json["mime_type"], "image/png");
        assert_eq!(json["size_bytes"], 500);
        assert_eq!(json["is_screenshot"], false);
    }

    #[test]
    fn test_image_details_from_json() {
        let json = serde_json::json!({
            "path": "/test.jpg",
            "mime_type": "image/jpeg",
            "size_bytes": 1000,
            "is_screenshot": false
        });

        let details = ImageDetails::from_json(&json).unwrap();
        assert_eq!(details.path, Some("/test.jpg".to_string()));
        assert_eq!(details.mime_type, Some("image/jpeg".to_string()));
        assert!(!details.is_screenshot);
    }

    #[test]
    fn test_web_fetch_details_new() {
        let details = WebFetchDetails::new("https://example.com")
            .with_status(200)
            .with_content_type("text/html")
            .with_body_size(1024)
            .with_duration(150);

        assert_eq!(details.url, "https://example.com");
        assert_eq!(details.status_code, Some(200));
        assert_eq!(details.content_type, Some("text/html".to_string()));
        assert_eq!(details.body_size, Some(1024));
        assert_eq!(details.duration_ms, Some(150));
        assert!(!details.truncated);
    }

    #[test]
    fn test_web_fetch_details_with_redirect() {
        let details = WebFetchDetails::new("https://old.com")
            .with_status(200)
            .with_final_url("https://new.com");

        assert_eq!(details.url, "https://old.com");
        assert_eq!(details.final_url, Some("https://new.com".to_string()));
    }

    #[test]
    fn test_web_fetch_details_truncated() {
        let details = WebFetchDetails::new("https://example.com")
            .with_truncation()
            .with_prompt("Find the title");

        assert!(details.truncated);
        assert_eq!(details.prompt, Some("Find the title".to_string()));
    }

    #[test]
    fn test_web_fetch_details_to_json() {
        let details = WebFetchDetails::new("https://example.com")
            .with_status(200)
            .with_body_size(500);

        let json = details.to_json();
        assert_eq!(json["url"], "https://example.com");
        assert_eq!(json["status_code"], 200);
        assert_eq!(json["body_size"], 500);
    }

    #[test]
    fn test_web_fetch_details_from_json() {
        let json = serde_json::json!({
            "url": "https://test.com",
            "status_code": 404,
            "truncated": true
        });

        let details = WebFetchDetails::from_json(&json).unwrap();
        assert_eq!(details.url, "https://test.com");
        assert_eq!(details.status_code, Some(404));
        assert!(details.truncated);
    }

    #[test]
    fn test_glob_details_new() {
        let details = GlobDetails::new("**/*.rs")
            .with_base_path("/src")
            .with_matches(42)
            .with_duration(10);

        assert_eq!(details.pattern, "**/*.rs");
        assert_eq!(details.base_path, Some("/src".to_string()));
        assert_eq!(details.matches_count, Some(42));
        assert_eq!(details.duration_ms, Some(10));
        assert!(!details.truncated);
    }

    #[test]
    fn test_glob_details_truncated() {
        let details = GlobDetails::new("*").with_matches(150).with_truncation();

        assert!(details.truncated);
        assert_eq!(details.matches_count, Some(150));
    }

    #[test]
    fn test_glob_details_to_json() {
        let details = GlobDetails::new("*.txt")
            .with_base_path("/docs")
            .with_matches(5);

        let json = details.to_json();
        assert_eq!(json["pattern"], "*.txt");
        assert_eq!(json["base_path"], "/docs");
        assert_eq!(json["matches_count"], 5);
    }

    #[test]
    fn test_glob_details_from_json() {
        let json = serde_json::json!({
            "pattern": "**/*.md",
            "matches_count": 10,
            "truncated": false
        });

        let details = GlobDetails::from_json(&json).unwrap();
        assert_eq!(details.pattern, "**/*.md");
        assert_eq!(details.matches_count, Some(10));
        assert!(!details.truncated);
    }

    #[test]
    fn test_grep_details_new() {
        let details = GrepDetails::new("TODO")
            .with_path("/src")
            .with_matches(15)
            .with_files_matched(3)
            .with_duration(25);

        assert_eq!(details.pattern, "TODO");
        assert_eq!(details.path, Some("/src".to_string()));
        assert_eq!(details.matches_count, Some(15));
        assert_eq!(details.files_matched, Some(3));
        assert_eq!(details.duration_ms, Some(25));
        assert!(!details.truncated);
    }

    #[test]
    fn test_grep_details_truncated() {
        let details = GrepDetails::new("error")
            .with_matches(100)
            .with_truncation()
            .with_search_tool("rg");

        assert!(details.truncated);
        assert_eq!(details.matches_count, Some(100));
        assert_eq!(details.search_tool, Some("rg".to_string()));
    }

    #[test]
    fn test_grep_details_to_json() {
        let details = GrepDetails::new("fn main")
            .with_path("/project")
            .with_matches(5)
            .with_files_matched(2);

        let json = details.to_json();
        assert_eq!(json["pattern"], "fn main");
        assert_eq!(json["path"], "/project");
        assert_eq!(json["matches_count"], 5);
        assert_eq!(json["files_matched"], 2);
    }

    #[test]
    fn test_grep_details_from_json() {
        let json = serde_json::json!({
            "pattern": "use std::",
            "path": "/src",
            "matches_count": 42,
            "files_matched": 8,
            "truncated": true
        });

        let details = GrepDetails::from_json(&json).unwrap();
        assert_eq!(details.pattern, "use std::");
        assert_eq!(details.path, Some("/src".to_string()));
        assert_eq!(details.matches_count, Some(42));
        assert_eq!(details.files_matched, Some(8));
        assert!(details.truncated);
    }

    #[test]
    fn test_grep_tool_details_union() {
        let grep = ToolDetails::Grep(GrepDetails::new("pattern").with_matches(10));
        let json = grep.to_json();

        assert_eq!(json["tool_type"], "grep");
        assert_eq!(json["pattern"], "pattern");
        assert_eq!(json["matches_count"], 10);

        let parsed = ToolDetails::from_json(&json).unwrap();
        assert!(matches!(parsed, ToolDetails::Grep(_)));
    }

    #[test]
    fn test_diff_details_new() {
        let details = DiffDetails::new("HEAD")
            .with_path("src/main.rs")
            .with_stats(3, 45, 12)
            .with_duration(100);

        assert_eq!(details.target, "HEAD");
        assert_eq!(details.path, Some("src/main.rs".to_string()));
        assert_eq!(details.files_changed, Some(3));
        assert_eq!(details.insertions, Some(45));
        assert_eq!(details.deletions, Some(12));
        assert_eq!(details.duration_ms, Some(100));
    }

    #[test]
    fn test_diff_details_to_json() {
        let details = DiffDetails::new("main").with_stats(2, 10, 5);

        let json = details.to_json();
        assert_eq!(json["target"], "main");
        assert_eq!(json["files_changed"], 2);
        assert_eq!(json["insertions"], 10);
        assert_eq!(json["deletions"], 5);
    }

    #[test]
    fn test_diff_details_from_json() {
        let json = serde_json::json!({
            "target": "feature-branch",
            "path": "lib/",
            "files_changed": 5,
            "insertions": 100,
            "deletions": 25
        });

        let details = DiffDetails::from_json(&json).unwrap();
        assert_eq!(details.target, "feature-branch");
        assert_eq!(details.path, Some("lib/".to_string()));
        assert_eq!(details.files_changed, Some(5));
        assert_eq!(details.insertions, Some(100));
        assert_eq!(details.deletions, Some(25));
    }

    #[test]
    fn test_diff_tool_details_union() {
        let diff = ToolDetails::Diff(DiffDetails::new("HEAD").with_stats(1, 10, 5));
        let json = diff.to_json();

        assert_eq!(json["tool_type"], "diff");
        assert_eq!(json["target"], "HEAD");

        let parsed = ToolDetails::from_json(&json).unwrap();
        assert!(matches!(parsed, ToolDetails::Diff(_)));
    }

    #[test]
    fn test_list_details_new() {
        let details = ListDetails::new("/home/user")
            .with_entries(25)
            .with_duration(15);

        assert_eq!(details.path, "/home/user");
        assert_eq!(details.entries_count, Some(25));
        assert_eq!(details.duration_ms, Some(15));
        assert!(!details.recursive);
        assert!(!details.truncated);
    }

    #[test]
    fn test_list_details_recursive() {
        let details = ListDetails::new("/src")
            .with_entries(200)
            .with_recursive()
            .with_truncation();

        assert_eq!(details.path, "/src");
        assert!(details.recursive);
        assert!(details.truncated);
        assert_eq!(details.entries_count, Some(200));
    }

    #[test]
    fn test_list_details_to_json() {
        let details = ListDetails::new("/tmp").with_entries(10).with_recursive();

        let json = details.to_json();
        assert_eq!(json["path"], "/tmp");
        assert_eq!(json["entries_count"], 10);
        assert_eq!(json["recursive"], true);
    }

    #[test]
    fn test_list_details_from_json() {
        let json = serde_json::json!({
            "path": "/var/log",
            "entries_count": 50,
            "recursive": true,
            "truncated": false
        });

        let details = ListDetails::from_json(&json).unwrap();
        assert_eq!(details.path, "/var/log");
        assert_eq!(details.entries_count, Some(50));
        assert!(details.recursive);
        assert!(!details.truncated);
    }

    #[test]
    fn test_list_tool_details_union() {
        let list = ToolDetails::List(ListDetails::new("/home").with_entries(30));
        let json = list.to_json();

        assert_eq!(json["tool_type"], "list");
        assert_eq!(json["path"], "/home");

        let parsed = ToolDetails::from_json(&json).unwrap();
        assert!(matches!(parsed, ToolDetails::List(_)));
    }
}

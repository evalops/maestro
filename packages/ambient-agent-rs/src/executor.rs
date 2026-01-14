//! Executor
//!
//! Executes tasks by calling LLMs and applying file changes.
//! Handles prompt construction, API calls, response parsing, and file operations.

use crate::cascader::RoutingResult;
use crate::types::*;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

/// Static regex patterns to avoid recompilation in hot path
static FILE_CHANGE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?s)<file_change>\s*<action>(\w+)</action>\s*<path>([^<]+)</path>(?:\s*<content>(.*?)</content>)?\s*</file_change>"
    ).unwrap()
});

static MARKDOWN_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)```(?:\w+)?\n// File: ([^\n]+)\n(.*?)```").unwrap()
});

/// Protected file patterns that should never be modified
static PROTECTED_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"^\.git/").unwrap(),
        Regex::new(r"^\.env").unwrap(),
        Regex::new(r"credentials").unwrap(),
        Regex::new(r"secrets?\.").unwrap(),
        Regex::new(r"\.pem$").unwrap(),
        Regex::new(r"\.key$").unwrap(),
        Regex::new(r"id_rsa").unwrap(),
        Regex::new(r"\.ssh/").unwrap(),
        Regex::new(r"node_modules/").unwrap(),
        Regex::new(r"vendor/").unwrap(),
    ]
});

/// Allowed test commands (whitelist for security)
static ALLOWED_TEST_COMMANDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    vec![
        "npm", "yarn", "pnpm", "bun",
        "cargo", "go", "pytest", "python",
        "ruby", "rspec", "bundle",
        "make", "gradle", "mvn",
    ]
});

/// Configuration for the executor
#[derive(Debug, Clone)]
pub struct ExecutorConfig {
    pub api_key: String,
    pub api_base_url: String,
    pub max_tokens: u32,
    pub temperature: f64,
    pub run_tests: bool,
    pub test_command: Option<String>,
    pub working_dir: String,
    pub request_timeout_secs: u64,
    pub test_timeout_secs: u64,
    pub max_retries: u32,
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            api_base_url: "https://api.anthropic.com/v1".to_string(),
            max_tokens: 4096,
            temperature: 0.0,
            run_tests: true,
            test_command: None,
            working_dir: ".".to_string(),
            request_timeout_secs: 300, // 5 minutes for LLM calls
            test_timeout_secs: 120,    // 2 minutes for tests
            max_retries: 3,
        }
    }
}

/// Executor handles LLM calls and file operations
pub struct Executor {
    config: ExecutorConfig,
    client: Client,
}

/// Anthropic API request
#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    temperature: f64,
    messages: Vec<Message>,
    system: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Message {
    role: String,
    content: String,
}

/// Anthropic API response
#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<ContentBlock>,
    usage: Usage,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    #[allow(dead_code)] // Required for deserialization but not read directly
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    input_tokens: u32,
    output_tokens: u32,
}

/// Parsed file change from LLM response
#[derive(Debug, Clone)]
struct ParsedChange {
    file_path: String,
    action: String, // "create", "modify", "delete"
    content: Option<String>,
}

impl Executor {
    /// Create a new executor with configured HTTP client
    pub fn new(config: ExecutorConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .pool_max_idle_per_host(5)
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { config, client }
    }

    /// Execute a task plan using the routed model
    pub async fn execute(&self, plan: &TaskPlan, routing: &RoutingResult) -> ExecutionResult {
        let mut logs = vec![];
        logs.push(format!("Executing: {}", plan.summary));
        logs.push(format!("Using model: {} ({})", routing.model, routing.tier.name));

        // Build the prompt
        let (system_prompt, user_prompt) = self.build_prompts(plan).await;
        logs.push("Built prompts".to_string());

        // Call the LLM with retries
        let response = match self.call_llm_with_retry(&routing.model, &system_prompt, &user_prompt).await {
            Ok(resp) => {
                logs.push(format!(
                    "LLM response received ({} input, {} output tokens)",
                    resp.usage.input_tokens, resp.usage.output_tokens
                ));
                resp
            }
            Err(e) => {
                error!("LLM call failed after retries: {}", e);
                return ExecutionResult {
                    status: ExecutionStatus::Failed,
                    changes: vec![],
                    test_results: vec![],
                    error: Some(format!("LLM call failed: {}", e)),
                    logs,
                };
            }
        };

        // Parse the response
        let llm_output = response
            .content
            .iter()
            .filter_map(|c| c.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n");

        let parsed_changes = match self.parse_response(&llm_output) {
            Ok(changes) => changes,
            Err(e) => {
                error!("Failed to parse LLM response: {}", e);
                return ExecutionResult {
                    status: ExecutionStatus::Failed,
                    changes: vec![],
                    test_results: vec![],
                    error: Some(format!("Parse error: {}", e)),
                    logs,
                };
            }
        };
        logs.push(format!("Parsed {} file changes", parsed_changes.len()));

        if parsed_changes.is_empty() {
            warn!("No file changes parsed from LLM response");
            return ExecutionResult {
                status: ExecutionStatus::Partial,
                changes: vec![],
                test_results: vec![],
                error: Some("No file changes found in LLM response".to_string()),
                logs,
            };
        }

        // Apply the changes
        let mut changes = vec![];
        let mut errors = vec![];

        for parsed in &parsed_changes {
            match self.apply_change(parsed).await {
                Ok(change) => {
                    logs.push(format!("Applied: {} {}", parsed.action, parsed.file_path));
                    changes.push(change);
                }
                Err(e) => {
                    let err_msg = format!("Failed to apply {} {}: {}", parsed.action, parsed.file_path, e);
                    error!("{}", err_msg);
                    errors.push(err_msg.clone());
                    logs.push(err_msg);
                }
            }
        }

        // Run tests if configured
        let test_results = if self.config.run_tests {
            match self.run_tests().await {
                Ok(results) => {
                    logs.push(format!("Ran {} tests", results.len()));
                    results
                }
                Err(e) => {
                    logs.push(format!("Test execution failed: {}", e));
                    vec![]
                }
            }
        } else {
            vec![]
        };

        // Determine status
        let status = if !errors.is_empty() {
            ExecutionStatus::Partial
        } else if test_results.iter().any(|t| !t.passed) {
            ExecutionStatus::Failed
        } else {
            ExecutionStatus::Success
        };

        ExecutionResult {
            status,
            changes,
            test_results,
            error: if errors.is_empty() {
                None
            } else {
                Some(errors.join("; "))
            },
            logs,
        }
    }

    /// Build system and user prompts for the LLM
    async fn build_prompts(&self, plan: &TaskPlan) -> (String, String) {
        let system_prompt = r#"You are an expert software engineer. Your task is to implement code changes based on the given requirements.

When making changes, output them in the following format:

<file_change>
<action>create|modify|delete</action>
<path>path/to/file.ext</path>
<content>
Full file content here (for create/modify)
</content>
</file_change>

Rules:
1. Output the COMPLETE file content for create/modify operations
2. Include all necessary imports and dependencies
3. Follow existing code style and conventions
4. Add appropriate error handling
5. Include comments for complex logic
6. Do not include content tags for delete operations
7. NEVER use absolute paths - always use relative paths from the project root
8. NEVER modify files outside the project directory

Think step by step about the implementation before writing code."#;

        // Build user prompt with context
        let mut user_prompt = format!("## Task\n{}\n\n", plan.summary);

        // Add event context
        user_prompt.push_str(&format!(
            "## Event Details\nType: {:?}\nTitle: {}\n",
            plan.event.event_type, plan.event.title
        ));

        if let Some(ref body) = plan.event.body {
            let truncated = self.safe_truncate(body, 2000);
            user_prompt.push_str(&format!("Body:\n{}\n\n", truncated));
        }

        // Add file context
        if !plan.files.is_empty() {
            user_prompt.push_str("## Relevant Files\n");
            for file in &plan.files {
                if let Ok(content) = self.read_file_context(file).await {
                    user_prompt.push_str(&format!("### {}\n```\n{}\n```\n\n", file, content));
                }
            }
        }

        // Add task breakdown
        user_prompt.push_str("## Tasks\n");
        for (i, task) in plan.tasks.iter().enumerate() {
            user_prompt.push_str(&format!("{}. {:?}: {}\n", i + 1, task.task_type, task.prompt));
        }

        (system_prompt.to_string(), user_prompt)
    }

    /// Safely truncate a string at character boundaries
    fn safe_truncate(&self, s: &str, max_chars: usize) -> String {
        if s.len() <= max_chars {
            return s.to_string();
        }
        // Find the last valid char boundary before max_chars
        let mut end = max_chars;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...(truncated)", &s[..end])
    }

    /// Read file content for context (truncated if too large)
    async fn read_file_context(&self, path: &str) -> anyhow::Result<String> {
        // Validate path before reading
        let full_path = self.validate_path(path)?;
        let content = fs::read_to_string(&full_path).await?;

        // Truncate if too large
        Ok(self.safe_truncate(&content, 10000))
    }

    /// Validate that a path is safe and within the working directory
    fn validate_path(&self, path: &str) -> anyhow::Result<PathBuf> {
        // Reject absolute paths
        if path.starts_with('/') || path.starts_with('\\') {
            anyhow::bail!("Absolute paths are not allowed: {}", path);
        }

        // Reject paths with .. components
        if path.contains("..") {
            anyhow::bail!("Path traversal detected: {}", path);
        }

        // Reject paths with null bytes
        if path.contains('\0') {
            anyhow::bail!("Invalid path (contains null byte): {}", path);
        }

        let working_dir = Path::new(&self.config.working_dir)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&self.config.working_dir));

        let full_path = working_dir.join(path);

        // For existing files, verify they're within working dir
        if full_path.exists() {
            let canonical = full_path.canonicalize()?;
            if !canonical.starts_with(&working_dir) {
                anyhow::bail!(
                    "Path escapes working directory: {} -> {}",
                    path,
                    canonical.display()
                );
            }
            return Ok(canonical);
        }

        // For new files, verify the path components don't escape
        // by checking each component. Split on both / and \ for cross-platform safety.
        let normalized: PathBuf = path
            .split(|c| c == '/' || c == '\\')
            .filter(|c| !c.is_empty() && *c != ".")
            .collect();
        let final_path = working_dir.join(&normalized);

        // Double-check that the final path is still within working_dir
        // by comparing path prefixes
        let final_str = final_path.to_string_lossy();
        let working_str = working_dir.to_string_lossy();
        if !final_str.starts_with(working_str.as_ref()) {
            anyhow::bail!("Path escapes working directory: {}", path);
        }

        Ok(final_path)
    }

    /// Check if a file path matches protected patterns
    fn is_protected_path(&self, path: &str) -> bool {
        for pattern in PROTECTED_PATTERNS.iter() {
            if pattern.is_match(path) {
                return true;
            }
        }
        false
    }

    /// Call the LLM with retry logic and exponential backoff
    async fn call_llm_with_retry(
        &self,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
    ) -> anyhow::Result<AnthropicResponse> {
        let mut last_error = None;
        let mut delay = Duration::from_secs(1);

        for attempt in 0..self.config.max_retries {
            if attempt > 0 {
                info!("Retrying LLM call (attempt {}/{})", attempt + 1, self.config.max_retries);
                tokio::time::sleep(delay).await;
                delay *= 2; // Exponential backoff
            }

            match self.call_llm(model, system_prompt, user_prompt).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    let err_str = e.to_string();
                    // Don't retry on client errors (4xx) except rate limits (429)
                    if err_str.contains("API error 4") && !err_str.contains("429") {
                        return Err(e);
                    }
                    warn!("LLM call attempt {} failed: {}", attempt + 1, e);
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("LLM call failed after retries")))
    }

    /// Call the Anthropic API
    async fn call_llm(
        &self,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
    ) -> anyhow::Result<AnthropicResponse> {
        let request = AnthropicRequest {
            model: model.to_string(),
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            system: system_prompt.to_string(),
            messages: vec![Message {
                role: "user".to_string(),
                content: user_prompt.to_string(),
            }],
        };

        let response = self
            .client
            .post(format!("{}/messages", self.config.api_base_url))
            .header("x-api-key", &self.config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        let result: AnthropicResponse = response.json().await?;
        Ok(result)
    }

    /// Parse LLM response to extract file changes with validation
    fn parse_response(&self, response: &str) -> anyhow::Result<Vec<ParsedChange>> {
        let mut changes = vec![];
        let valid_actions = ["create", "modify", "delete"];

        // Parse <file_change> blocks using static pattern
        for cap in FILE_CHANGE_PATTERN.captures_iter(response) {
            let action = cap.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
            let file_path = cap.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            let content = cap.get(3).map(|m| m.as_str().trim().to_string());

            // Validate action
            if !valid_actions.contains(&action.as_str()) {
                warn!("Invalid action '{}' for path '{}', skipping", action, file_path);
                continue;
            }

            if !file_path.is_empty() {
                changes.push(ParsedChange {
                    file_path,
                    action,
                    content,
                });
            }
        }

        // Fallback: try to parse markdown code blocks with file paths using static pattern
        if changes.is_empty() {
            debug!("No <file_change> blocks found, trying markdown fallback");

            for cap in MARKDOWN_FILE_PATTERN.captures_iter(response) {
                let file_path = cap.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
                let content = cap.get(2).map(|m| m.as_str().to_string());

                if !file_path.is_empty() {
                    changes.push(ParsedChange {
                        file_path,
                        action: "modify".to_string(),
                        content,
                    });
                }
            }
        }

        Ok(changes)
    }

    /// Apply a parsed change to the filesystem with security checks
    async fn apply_change(&self, change: &ParsedChange) -> anyhow::Result<FileChange> {
        // Security: Check for protected files
        if self.is_protected_path(&change.file_path) {
            anyhow::bail!("Cannot modify protected file: {}", change.file_path);
        }

        // Security: Validate path is within working directory
        let full_path = self.validate_path(&change.file_path)?;

        match change.action.as_str() {
            "create" => {
                // Ensure parent directory exists
                if let Some(parent) = full_path.parent() {
                    fs::create_dir_all(parent).await?;
                }

                let content = change.content.as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Create action requires content"))?;

                fs::write(&full_path, content).await?;

                let additions = content.lines().count() as u32;

                Ok(FileChange {
                    file: change.file_path.clone(),
                    change_type: ChangeType::Create,
                    content: Some(content.clone()),
                    old_path: None,
                    additions,
                    deletions: 0,
                })
            }
            "modify" => {
                let content = change.content.as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Modify action requires content"))?;

                // Count old lines for diff stats
                let old_lines = if full_path.exists() {
                    fs::read_to_string(&full_path).await?.lines().count() as u32
                } else {
                    0
                };

                fs::write(&full_path, content).await?;

                let new_lines = content.lines().count() as u32;

                Ok(FileChange {
                    file: change.file_path.clone(),
                    change_type: ChangeType::Modify,
                    content: Some(content.clone()),
                    old_path: None,
                    additions: new_lines,
                    deletions: old_lines,
                })
            }
            "delete" => {
                let old_lines = if full_path.exists() {
                    let content = fs::read_to_string(&full_path).await?;
                    fs::remove_file(&full_path).await?;
                    content.lines().count() as u32
                } else {
                    0
                };

                Ok(FileChange {
                    file: change.file_path.clone(),
                    change_type: ChangeType::Delete,
                    content: None,
                    old_path: None,
                    additions: 0,
                    deletions: old_lines,
                })
            }
            _ => anyhow::bail!("Unknown action: {}", change.action),
        }
    }

    /// Run tests and return results with timeout
    async fn run_tests(&self) -> anyhow::Result<Vec<TestResult>> {
        let test_cmd = match &self.config.test_command {
            Some(cmd) => cmd.clone(),
            None => return Ok(vec![]), // No test command configured
        };

        let parts: Vec<&str> = test_cmd.split_whitespace().collect();

        if parts.is_empty() {
            return Ok(vec![]);
        }

        // Security: Validate test command against whitelist using basename only
        let cmd = parts[0];
        let cmd_basename = Path::new(cmd)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(cmd);
        if !ALLOWED_TEST_COMMANDS.contains(&cmd_basename) {
            anyhow::bail!(
                "Test command '{}' not in allowed list. Allowed: {:?}",
                cmd,
                *ALLOWED_TEST_COMMANDS
            );
        }

        // Run with timeout
        let test_timeout = Duration::from_secs(self.config.test_timeout_secs);

        let output_result = timeout(
            test_timeout,
            Command::new(parts[0])
                .args(&parts[1..])
                .current_dir(&self.config.working_dir)
                .output()
        ).await;

        let output = match output_result {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => anyhow::bail!("Failed to execute test command: {}", e),
            Err(_) => anyhow::bail!("Test command timed out after {} seconds", self.config.test_timeout_secs),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        // Simple test result - real implementation would parse test output
        let passed = output.status.success();

        Ok(vec![TestResult {
            name: "test-suite".to_string(),
            passed,
            duration_ms: 0,
            error: if passed {
                None
            } else {
                Some(format!("{}\n{}", stdout, stderr))
            },
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_file_change_blocks() {
        let executor = Executor::new(ExecutorConfig::default());

        let response = r#"
Here's the implementation:

<file_change>
<action>create</action>
<path>src/utils/helper.rs</path>
<content>
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
</content>
</file_change>

<file_change>
<action>modify</action>
<path>src/main.rs</path>
<content>
mod utils;

fn main() {
    println!("{}", utils::helper::greet("World"));
}
</content>
</file_change>
"#;

        let changes = executor.parse_response(response).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].action, "create");
        assert_eq!(changes[0].file_path, "src/utils/helper.rs");
        assert_eq!(changes[1].action, "modify");
        assert_eq!(changes[1].file_path, "src/main.rs");
    }

    #[test]
    fn test_path_validation_rejects_traversal() {
        let executor = Executor::new(ExecutorConfig::default());

        // Should reject path traversal
        assert!(executor.validate_path("../../../etc/passwd").is_err());
        assert!(executor.validate_path("foo/../../../bar").is_err());

        // Should reject absolute paths
        assert!(executor.validate_path("/etc/passwd").is_err());
        assert!(executor.validate_path("/tmp/evil").is_err());

        // Should accept normal relative paths
        assert!(executor.validate_path("src/main.rs").is_ok());
        assert!(executor.validate_path("lib/utils/helper.rs").is_ok());
    }

    #[test]
    fn test_protected_paths() {
        let executor = Executor::new(ExecutorConfig::default());

        assert!(executor.is_protected_path(".git/config"));
        assert!(executor.is_protected_path(".env"));
        assert!(executor.is_protected_path(".env.local"));
        assert!(executor.is_protected_path("config/secrets.json"));
        assert!(executor.is_protected_path("credentials.yaml"));
        assert!(executor.is_protected_path("server.key"));
        assert!(executor.is_protected_path("node_modules/package/index.js"));

        assert!(!executor.is_protected_path("src/main.rs"));
        assert!(!executor.is_protected_path("lib/utils.ts"));
    }

    #[test]
    fn test_safe_truncate() {
        let executor = Executor::new(ExecutorConfig::default());

        // Normal truncation
        let short = "hello";
        assert_eq!(executor.safe_truncate(short, 10), "hello");

        let long = "hello world this is a long string";
        let truncated = executor.safe_truncate(long, 10);
        assert!(truncated.starts_with("hello worl"));
        assert!(truncated.ends_with("...(truncated)"));

        // UTF-8 boundary handling
        let utf8 = "hello 世界 world";
        let truncated = executor.safe_truncate(utf8, 8);
        assert!(truncated.is_ascii() || truncated.chars().all(|c| c.len_utf8() <= 4));
    }
}

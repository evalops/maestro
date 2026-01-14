//! Executor
//!
//! Executes tasks by calling LLMs and applying file changes.
//! Handles prompt construction, API calls, response parsing, and file operations.

use crate::cascader::RoutingResult;
use crate::types::*;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::LazyLock;
use tokio::fs;
use tokio::process::Command;
use tracing::{debug, error, warn};

/// Static regex patterns to avoid recompilation in hot path
static FILE_CHANGE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?s)<file_change>\s*<action>(\w+)</action>\s*<path>([^<]+)</path>(?:\s*<content>(.*?)</content>)?\s*</file_change>"
    ).unwrap()
});

static MARKDOWN_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)```(?:\w+)?\n// File: ([^\n]+)\n(.*?)```").unwrap()
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
    /// Create a new executor
    pub fn new(config: ExecutorConfig) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }

    /// Execute a task plan using the routed model
    pub async fn execute(&self, plan: &TaskPlan, routing: &RoutingResult) -> ExecutionResult {
        let mut logs = vec![];
        logs.push(format!("Executing: {}", plan.summary));
        logs.push(format!("Using model: {} ({})", routing.model, routing.tier.name));

        // Build the prompt
        let (system_prompt, user_prompt) = self.build_prompts(plan).await;
        logs.push("Built prompts".to_string());

        // Call the LLM
        let response = match self.call_llm(&routing.model, &system_prompt, &user_prompt).await {
            Ok(resp) => {
                logs.push(format!(
                    "LLM response received ({} input, {} output tokens)",
                    resp.usage.input_tokens, resp.usage.output_tokens
                ));
                resp
            }
            Err(e) => {
                error!("LLM call failed: {}", e);
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

        let parsed_changes = self.parse_response(&llm_output);
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

Think step by step about the implementation before writing code."#;

        // Build user prompt with context
        let mut user_prompt = format!("## Task\n{}\n\n", plan.summary);

        // Add event context
        user_prompt.push_str(&format!(
            "## Event Details\nType: {:?}\nTitle: {}\n",
            plan.event.event_type, plan.event.title
        ));

        if let Some(ref body) = plan.event.body {
            let truncated = if body.len() > 2000 {
                format!("{}...(truncated)", &body[..2000])
            } else {
                body.clone()
            };
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

    /// Read file content for context (truncated if too large)
    async fn read_file_context(&self, path: &str) -> anyhow::Result<String> {
        let full_path = Path::new(&self.config.working_dir).join(path);
        let content = fs::read_to_string(&full_path).await?;

        // Truncate if too large
        if content.len() > 10000 {
            Ok(format!("{}...(truncated at 10000 chars)", &content[..10000]))
        } else {
            Ok(content)
        }
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

    /// Parse LLM response to extract file changes
    fn parse_response(&self, response: &str) -> Vec<ParsedChange> {
        let mut changes = vec![];

        // Parse <file_change> blocks using static pattern
        for cap in FILE_CHANGE_PATTERN.captures_iter(response) {
            let action = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let file_path = cap.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            let content = cap.get(3).map(|m| m.as_str().trim().to_string());

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

        changes
    }

    /// Apply a parsed change to the filesystem
    async fn apply_change(&self, change: &ParsedChange) -> anyhow::Result<FileChange> {
        let full_path = Path::new(&self.config.working_dir).join(&change.file_path);

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

    /// Run tests and return results
    async fn run_tests(&self) -> anyhow::Result<Vec<TestResult>> {
        let test_cmd = self.config.test_command.as_deref().unwrap_or("npm test");
        let parts: Vec<&str> = test_cmd.split_whitespace().collect();

        if parts.is_empty() {
            return Ok(vec![]);
        }

        let output = Command::new(parts[0])
            .args(&parts[1..])
            .current_dir(&self.config.working_dir)
            .output()
            .await?;

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

        let changes = executor.parse_response(response);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].action, "create");
        assert_eq!(changes[0].file_path, "src/utils/helper.rs");
        assert_eq!(changes[1].action, "modify");
        assert_eq!(changes[1].file_path, "src/main.rs");
    }
}

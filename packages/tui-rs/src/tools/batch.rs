//! Batch Tool Execution
//!
//! This module provides parallel execution of multiple tool calls.
//! It allows running multiple tools concurrently with configurable
//! limits on parallelism and proper error handling.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use futures::future::join_all;
use tokio::sync::{mpsc, Semaphore};

use super::details::BatchDetails;
use super::registry::ToolExecutor;
use crate::agent::{FromAgent, ToolResult};

/// A single tool call in a batch
#[derive(Debug, Clone)]
pub struct BatchToolCall {
    /// Unique identifier for this call
    pub call_id: String,
    /// Tool name to execute
    pub tool_name: String,
    /// Arguments for the tool
    pub args: serde_json::Value,
}

impl BatchToolCall {
    /// Create a new batch tool call
    pub fn new(
        call_id: impl Into<String>,
        tool_name: impl Into<String>,
        args: serde_json::Value,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            tool_name: tool_name.into(),
            args,
        }
    }
}

/// Result of a single tool call in a batch
#[derive(Debug, Clone)]
pub struct BatchToolResult {
    /// Call ID that matches the input
    pub call_id: String,
    /// Tool name that was executed
    pub tool_name: String,
    /// The result from the tool
    pub result: ToolResult,
}

/// Configuration for batch execution
#[derive(Debug, Clone)]
pub struct BatchConfig {
    /// Maximum number of concurrent tool executions
    pub max_concurrency: usize,
    /// Whether to continue executing remaining tools after a failure
    pub continue_on_error: bool,
    /// Whether to emit individual tool events
    pub emit_events: bool,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 4,
            continue_on_error: true,
            emit_events: true,
        }
    }
}

impl BatchConfig {
    /// Create a new batch config with max concurrency
    pub fn with_concurrency(mut self, max: usize) -> Self {
        self.max_concurrency = max.max(1);
        self
    }

    /// Configure whether to continue after errors
    pub fn continue_on_error(mut self, cont: bool) -> Self {
        self.continue_on_error = cont;
        self
    }

    /// Configure event emission
    pub fn emit_events(mut self, emit: bool) -> Self {
        self.emit_events = emit;
        self
    }
}

/// Batch executor for running multiple tools in parallel
///
/// Note: The BatchExecutor caches a ToolExecutor for validation operations.
/// For parallel execution, it spawns independent executors per task.
pub struct BatchExecutor {
    /// Working directory for tool execution
    cwd: String,
    /// Configuration
    config: BatchConfig,
    /// Cached executor for validation (avoids repeated registry building)
    executor: ToolExecutor,
}

impl BatchExecutor {
    /// Create a new batch executor with the given working directory
    pub fn new(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        Self {
            executor: ToolExecutor::new(&cwd),
            cwd,
            config: BatchConfig::default(),
        }
    }

    /// Create with custom configuration
    pub fn with_config(cwd: impl Into<String>, config: BatchConfig) -> Self {
        let cwd = cwd.into();
        Self {
            executor: ToolExecutor::new(&cwd),
            cwd,
            config,
        }
    }

    /// Execute multiple tools in parallel
    ///
    /// Returns results in the same order as the input calls.
    /// Uses a semaphore to limit concurrency.
    pub async fn execute(
        &self,
        calls: Vec<BatchToolCall>,
        event_tx: Option<mpsc::UnboundedSender<FromAgent>>,
    ) -> Vec<BatchToolResult> {
        if calls.is_empty() {
            return Vec::new();
        }

        // Send batch start event
        if let Some(ref tx) = event_tx {
            if self.config.emit_events {
                let _ = tx.send(FromAgent::BatchStart { total: calls.len() });
            }
        }

        let semaphore = Arc::new(Semaphore::new(self.config.max_concurrency));
        let mut handles = Vec::with_capacity(calls.len());

        for call in calls {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let cwd = self.cwd.clone();
            let event_tx_clone = event_tx.clone();
            let emit_events = self.config.emit_events;

            let call_id = call.call_id.clone();
            let tool_name = call.tool_name.clone();
            let args = call.args.clone();

            handles.push(tokio::spawn(async move {
                // Each task creates its own executor
                let executor = ToolExecutor::new(&cwd);
                let result = executor
                    .execute(
                        &tool_name,
                        &args,
                        if emit_events {
                            event_tx_clone.as_ref()
                        } else {
                            None
                        },
                        &call_id,
                    )
                    .await;

                // Release permit when done
                drop(permit);

                BatchToolResult {
                    call_id,
                    tool_name,
                    result,
                }
            }));
        }

        // Wait for all tasks to complete
        let results: Vec<BatchToolResult> = join_all(handles)
            .await
            .into_iter()
            .filter_map(|r| r.ok())
            .collect();

        // Send batch end event
        if let Some(ref tx) = event_tx {
            if self.config.emit_events {
                let successes = results.iter().filter(|r| r.result.success).count();
                let failures = results.len() - successes;
                let _ = tx.send(FromAgent::BatchEnd {
                    total: results.len(),
                    successes,
                    failures,
                });
            }
        }

        results
    }

    /// Execute multiple tools in parallel and return detailed execution info
    ///
    /// Returns results along with batch-level details including timing,
    /// success rates, and per-tool durations.
    pub async fn execute_with_details(
        &self,
        calls: Vec<BatchToolCall>,
        event_tx: Option<mpsc::UnboundedSender<FromAgent>>,
    ) -> (Vec<BatchToolResult>, BatchDetails) {
        let start_time = Instant::now();
        let total = calls.len();

        if calls.is_empty() {
            let details = BatchDetails::new(0)
                .with_results(0, 0)
                .with_duration(0)
                .with_concurrency(self.config.max_concurrency);
            return (Vec::new(), details);
        }

        // Send batch start event
        if let Some(ref tx) = event_tx {
            if self.config.emit_events {
                let _ = tx.send(FromAgent::BatchStart { total });
            }
        }

        let semaphore = Arc::new(Semaphore::new(self.config.max_concurrency));
        let mut handles = Vec::with_capacity(calls.len());

        for call in calls {
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let cwd = self.cwd.clone();
            let event_tx_clone = event_tx.clone();
            let emit_events = self.config.emit_events;

            let call_id = call.call_id.clone();
            let tool_name = call.tool_name.clone();
            let args = call.args.clone();

            handles.push(tokio::spawn(async move {
                let tool_start = Instant::now();
                // Each task creates its own executor
                let executor = ToolExecutor::new(&cwd);
                let result = executor
                    .execute(
                        &tool_name,
                        &args,
                        if emit_events {
                            event_tx_clone.as_ref()
                        } else {
                            None
                        },
                        &call_id,
                    )
                    .await;

                let duration_ms = tool_start.elapsed().as_millis() as u64;

                // Release permit when done
                drop(permit);

                (
                    BatchToolResult {
                        call_id: call_id.clone(),
                        tool_name,
                        result,
                    },
                    call_id,
                    duration_ms,
                )
            }));
        }

        // Wait for all tasks to complete
        let task_results: Vec<_> = join_all(handles)
            .await
            .into_iter()
            .filter_map(|r| r.ok())
            .collect();

        // Separate results from durations
        let mut results = Vec::with_capacity(task_results.len());
        let mut tool_durations = HashMap::new();

        for (result, call_id, duration) in task_results {
            tool_durations.insert(call_id, duration);
            results.push(result);
        }

        // Calculate stats
        let duration_ms = start_time.elapsed().as_millis() as u64;
        let successes = results.iter().filter(|r| r.result.success).count();
        let failures = results.len() - successes;

        // Build details
        let mut details = BatchDetails::new(total)
            .with_results(successes, failures)
            .with_duration(duration_ms)
            .with_concurrency(self.config.max_concurrency)
            .with_tool_durations(tool_durations);

        if self.config.continue_on_error {
            details = details.with_continue_on_error();
        }

        // Send batch end event
        if let Some(ref tx) = event_tx {
            if self.config.emit_events {
                let _ = tx.send(FromAgent::BatchEnd {
                    total: results.len(),
                    successes,
                    failures,
                });
            }
        }

        (results, details)
    }

    /// Execute tools sequentially (useful for dependent operations)
    pub async fn execute_sequential(
        &self,
        calls: Vec<BatchToolCall>,
        event_tx: Option<mpsc::UnboundedSender<FromAgent>>,
    ) -> Vec<BatchToolResult> {
        let mut results = Vec::with_capacity(calls.len());

        for call in calls {
            let result = self
                .executor
                .execute(
                    &call.tool_name,
                    &call.args,
                    event_tx.as_ref(),
                    &call.call_id,
                )
                .await;

            let success = result.success;
            results.push(BatchToolResult {
                call_id: call.call_id,
                tool_name: call.tool_name,
                result,
            });

            // Stop on first error if configured
            if !success && !self.config.continue_on_error {
                break;
            }
        }

        results
    }

    /// Check which tools require approval
    pub fn check_approvals(&self, calls: &[BatchToolCall]) -> Vec<(String, bool)> {
        calls
            .iter()
            .map(|call| {
                let needs_approval = self.executor.requires_approval(&call.tool_name, &call.args);
                (call.call_id.clone(), needs_approval)
            })
            .collect()
    }

    /// Filter calls that require approval
    pub fn filter_needs_approval<'a>(&self, calls: &'a [BatchToolCall]) -> Vec<&'a BatchToolCall> {
        calls
            .iter()
            .filter(|call| self.executor.requires_approval(&call.tool_name, &call.args))
            .collect()
    }

    /// Validate all calls and return any with missing required fields
    pub fn validate_calls(&self, calls: &[BatchToolCall]) -> HashMap<String, Vec<String>> {
        let mut errors = HashMap::new();

        for call in calls {
            let missing = self.executor.missing_required(&call.tool_name, &call.args);
            if !missing.is_empty() {
                errors.insert(call.call_id.clone(), missing);
            }
        }

        errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_batch_tool_call_new() {
        let call = BatchToolCall::new("id1", "read", json!({"file_path": "/test.txt"}));
        assert_eq!(call.call_id, "id1");
        assert_eq!(call.tool_name, "read");
    }

    #[test]
    fn test_batch_config_default() {
        let config = BatchConfig::default();
        assert_eq!(config.max_concurrency, 4);
        assert!(config.continue_on_error);
        assert!(config.emit_events);
    }

    #[test]
    fn test_batch_config_builder() {
        let config = BatchConfig::default()
            .with_concurrency(8)
            .continue_on_error(false)
            .emit_events(false);

        assert_eq!(config.max_concurrency, 8);
        assert!(!config.continue_on_error);
        assert!(!config.emit_events);
    }

    #[test]
    fn test_batch_config_min_concurrency() {
        let config = BatchConfig::default().with_concurrency(0);
        assert_eq!(config.max_concurrency, 1); // Minimum is 1
    }

    #[tokio::test]
    async fn test_batch_executor_empty() {
        let batch = BatchExecutor::new("/tmp");

        let results = batch.execute(vec![], None).await;
        assert!(results.is_empty());
    }

    #[test]
    fn test_batch_executor_check_approvals() {
        let batch = BatchExecutor::new("/tmp");

        let calls = vec![
            BatchToolCall::new("1", "read", json!({"file_path": "/test.txt"})),
            BatchToolCall::new(
                "2",
                "write",
                json!({"file_path": "/test.txt", "content": "x"}),
            ),
        ];

        let approvals = batch.check_approvals(&calls);
        assert_eq!(approvals.len(), 2);

        // Read doesn't need approval
        assert!(!approvals.iter().find(|(id, _)| id == "1").unwrap().1);
        // Write needs approval
        assert!(approvals.iter().find(|(id, _)| id == "2").unwrap().1);
    }

    #[test]
    fn test_batch_executor_validate_calls() {
        let batch = BatchExecutor::new("/tmp");

        let calls = vec![
            BatchToolCall::new("1", "read", json!({})), // Missing file_path
            BatchToolCall::new("2", "read", json!({"file_path": "/test.txt"})), // Valid
        ];

        let errors = batch.validate_calls(&calls);
        assert!(errors.contains_key("1"));
        assert!(!errors.contains_key("2"));
    }

    #[test]
    fn test_batch_executor_filter_needs_approval() {
        let batch = BatchExecutor::new("/tmp");

        let calls = vec![
            BatchToolCall::new("1", "read", json!({"file_path": "/test.txt"})),
            BatchToolCall::new(
                "2",
                "write",
                json!({"file_path": "/test.txt", "content": "x"}),
            ),
            BatchToolCall::new("3", "glob", json!({"pattern": "*.rs"})),
        ];

        let needs_approval = batch.filter_needs_approval(&calls);
        assert_eq!(needs_approval.len(), 1);
        assert_eq!(needs_approval[0].call_id, "2");
    }

    #[tokio::test]
    async fn test_batch_executor_with_details_empty() {
        let batch = BatchExecutor::new("/tmp");

        let (results, details) = batch.execute_with_details(vec![], None).await;
        assert!(results.is_empty());
        assert_eq!(details.total, 0);
        assert_eq!(details.successes, 0);
        assert_eq!(details.failures, 0);
        assert!(details.duration_ms.is_some());
    }

    #[tokio::test]
    async fn test_batch_executor_with_details_tracks_timing() {
        let batch = BatchExecutor::new("/tmp");

        // Use glob which should succeed quickly
        let calls = vec![BatchToolCall::new("1", "glob", json!({"pattern": "*.rs"}))];

        let (results, details) = batch.execute_with_details(calls, None).await;

        assert_eq!(results.len(), 1);
        assert_eq!(details.total, 1);
        assert!(details.duration_ms.is_some());

        // Should have tool durations
        let tool_durations = details.tool_durations.as_ref().unwrap();
        assert!(tool_durations.contains_key("1"));
    }

    #[tokio::test]
    async fn test_batch_executor_with_details_config() {
        let config = BatchConfig::default()
            .with_concurrency(2)
            .continue_on_error(true);
        let batch = BatchExecutor::with_config("/tmp", config);

        let (_, details) = batch.execute_with_details(vec![], None).await;

        assert_eq!(details.max_concurrency, Some(2));
        // Empty batch doesn't set continue_on_error since it's only set on non-empty
    }
}

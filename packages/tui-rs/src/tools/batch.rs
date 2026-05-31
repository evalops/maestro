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
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

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
    #[must_use]
    pub fn with_concurrency(mut self, max: usize) -> Self {
        self.max_concurrency = max.max(1);
        self
    }

    /// Configure whether to continue after errors
    #[must_use]
    pub fn continue_on_error(mut self, cont: bool) -> Self {
        self.continue_on_error = cont;
        self
    }

    /// Configure event emission
    #[must_use]
    pub fn emit_events(mut self, emit: bool) -> Self {
        self.emit_events = emit;
        self
    }
}

/// Batch executor for running multiple tools in parallel
///
/// Note: The `BatchExecutor` shares one cached `ToolExecutor` across
/// validation and parallel execution tasks to avoid rebuilding registries on
/// every read-only wave member.
pub struct BatchExecutor {
    /// Configuration
    config: BatchConfig,
    /// Cached executor for validation (avoids repeated registry building)
    executor: Arc<ToolExecutor>,
}

impl BatchExecutor {
    /// Create a new batch executor with the given working directory
    pub fn new(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        Self {
            executor: Arc::new(ToolExecutor::new(&cwd)),
            config: BatchConfig::default(),
        }
    }

    /// Create with custom configuration
    pub fn with_config(cwd: impl Into<String>, config: BatchConfig) -> Self {
        let cwd = cwd.into();
        Self {
            executor: Arc::new(ToolExecutor::new(&cwd)),
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

        if !self.config.continue_on_error {
            if let Some(ref tx) = event_tx {
                if self.config.emit_events {
                    let _ = tx.send(FromAgent::BatchStart { total: calls.len() });
                }
            }

            let mut results = Vec::with_capacity(calls.len());
            let mut failed = false;

            for call in calls {
                if failed {
                    results.push(BatchToolResult {
                        call_id: call.call_id,
                        tool_name: call.tool_name,
                        result: ToolResult::failure("Skipped due to previous error in batch"),
                    });
                    continue;
                }

                let result = self
                    .executor
                    .execute(
                        &call.tool_name,
                        &call.args,
                        if self.config.emit_events {
                            event_tx.as_ref()
                        } else {
                            None
                        },
                        &call.call_id,
                    )
                    .await;

                if !result.success {
                    failed = true;
                }

                results.push(BatchToolResult {
                    call_id: call.call_id,
                    tool_name: call.tool_name,
                    result,
                });
            }

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

            return results;
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
            let executor = Arc::clone(&self.executor);
            let event_tx_clone = event_tx.clone();
            let emit_events = self.config.emit_events;

            let call_id = call.call_id.clone();
            let tool_name = call.tool_name.clone();
            let args = call.args.clone();

            handles.push(tokio::spawn(async move {
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
            .filter_map(std::result::Result::ok)
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

    /// Execute multiple tools in parallel and abort outstanding work when cancelled.
    ///
    /// Returns one result per requested call in input order. Calls that never
    /// complete because cancellation wins are surfaced as failed tool results so
    /// the caller can close out the batch cleanly.
    pub async fn execute_with_cancel(
        &self,
        calls: Vec<BatchToolCall>,
        event_tx: Option<mpsc::UnboundedSender<FromAgent>>,
        cancel_token: CancellationToken,
    ) -> Vec<BatchToolResult> {
        let total = calls.len();
        if calls.is_empty() {
            return Vec::new();
        }

        if !self.config.continue_on_error {
            if let Some(ref tx) = event_tx {
                if self.config.emit_events {
                    let _ = tx.send(FromAgent::BatchStart { total });
                }
            }

            let mut results = Vec::with_capacity(total);
            let mut failed = false;
            let mut cancelled = false;

            for call in calls {
                if cancelled || cancel_token.is_cancelled() {
                    cancelled = true;
                    results.push(BatchToolResult {
                        call_id: call.call_id,
                        tool_name: call.tool_name,
                        result: ToolResult::failure("Batch execution cancelled"),
                    });
                    continue;
                }

                if failed {
                    results.push(BatchToolResult {
                        call_id: call.call_id,
                        tool_name: call.tool_name,
                        result: ToolResult::failure("Skipped due to previous error in batch"),
                    });
                    continue;
                }

                let result = tokio::select! {
                    result = self.executor.execute(
                        &call.tool_name,
                        &call.args,
                        if self.config.emit_events { event_tx.as_ref() } else { None },
                        &call.call_id,
                    ) => result,
                    () = cancel_token.cancelled() => {
                        cancelled = true;
                        ToolResult::failure("Batch execution cancelled")
                    }
                };

                if !result.success {
                    failed = true;
                }

                results.push(BatchToolResult {
                    call_id: call.call_id,
                    tool_name: call.tool_name,
                    result,
                });
            }

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

            return results;
        }

        if let Some(ref tx) = event_tx {
            if self.config.emit_events {
                let _ = tx.send(FromAgent::BatchStart { total });
            }
        }

        let call_metadata: Vec<(String, String)> = calls
            .iter()
            .map(|call| (call.call_id.clone(), call.tool_name.clone()))
            .collect();
        let semaphore = Arc::new(Semaphore::new(self.config.max_concurrency));
        let mut task_set: JoinSet<(usize, BatchToolResult)> = JoinSet::new();
        let mut result_slots: Vec<Option<BatchToolResult>> =
            std::iter::repeat_with(|| None).take(total).collect();
        let mut cancelled = cancel_token.is_cancelled();

        if !cancelled {
            for (index, call) in calls.into_iter().enumerate() {
                let permit = tokio::select! {
                    permit = semaphore.clone().acquire_owned() => permit,
                    () = cancel_token.cancelled() => {
                        cancelled = true;
                        break;
                    }
                };

                let Ok(permit) = permit else {
                    cancelled = true;
                    break;
                };

                let executor = Arc::clone(&self.executor);
                let event_tx_clone = event_tx.clone();
                let emit_events = self.config.emit_events;
                let call_id = call.call_id;
                let tool_name = call.tool_name;
                let args = call.args;

                task_set.spawn(async move {
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

                    drop(permit);

                    (
                        index,
                        BatchToolResult {
                            call_id,
                            tool_name,
                            result,
                        },
                    )
                });
            }
        }

        if cancelled {
            task_set.abort_all();
        }

        while !task_set.is_empty() {
            if cancelled {
                record_joined_batch_result(task_set.join_next().await, &mut result_slots);
                continue;
            }

            tokio::select! {
                result = task_set.join_next() => {
                    record_joined_batch_result(result, &mut result_slots);
                }
                () = cancel_token.cancelled() => {
                    cancelled = true;
                    task_set.abort_all();
                }
            }
        }

        for (index, slot) in result_slots.iter_mut().enumerate() {
            if slot.is_none() {
                let (call_id, tool_name) = &call_metadata[index];
                *slot = Some(BatchToolResult {
                    call_id: call_id.clone(),
                    tool_name: tool_name.clone(),
                    result: ToolResult::failure("Batch execution cancelled"),
                });
            }
        }

        let results: Vec<BatchToolResult> = result_slots.into_iter().flatten().collect();

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

        if !self.config.continue_on_error {
            if let Some(ref tx) = event_tx {
                if self.config.emit_events {
                    let _ = tx.send(FromAgent::BatchStart { total });
                }
            }

            let mut results = Vec::with_capacity(total);
            let mut tool_durations = HashMap::new();
            let mut failed = false;

            for call in calls {
                if failed {
                    tool_durations.insert(call.call_id.clone(), 0);
                    results.push(BatchToolResult {
                        call_id: call.call_id,
                        tool_name: call.tool_name,
                        result: ToolResult::failure("Skipped due to previous error in batch"),
                    });
                    continue;
                }

                let tool_start = Instant::now();
                let result = self
                    .executor
                    .execute(
                        &call.tool_name,
                        &call.args,
                        if self.config.emit_events {
                            event_tx.as_ref()
                        } else {
                            None
                        },
                        &call.call_id,
                    )
                    .await;
                let duration_ms = tool_start.elapsed().as_millis() as u64;
                tool_durations.insert(call.call_id.clone(), duration_ms);

                if !result.success {
                    failed = true;
                }

                results.push(BatchToolResult {
                    call_id: call.call_id,
                    tool_name: call.tool_name,
                    result,
                });
            }

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let successes = results.iter().filter(|r| r.result.success).count();
            let failures = results.len() - successes;

            let details = BatchDetails::new(total)
                .with_results(successes, failures)
                .with_duration(duration_ms)
                .with_concurrency(self.config.max_concurrency)
                .with_tool_durations(tool_durations)
                .with_backpressure_count(0);

            if let Some(ref tx) = event_tx {
                if self.config.emit_events {
                    let _ = tx.send(FromAgent::BatchEnd {
                        total: results.len(),
                        successes,
                        failures,
                    });
                }
            }

            return (results, details);
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
            let executor = Arc::clone(&self.executor);
            let event_tx_clone = event_tx.clone();
            let emit_events = self.config.emit_events;

            let call_id = call.call_id.clone();
            let tool_name = call.tool_name.clone();
            let args = call.args.clone();

            handles.push(tokio::spawn(async move {
                let tool_start = Instant::now();
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
            .filter_map(std::result::Result::ok)
            .collect();

        // Separate results from durations
        let executor_reuse_count = task_results.len();
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
        let backpressure_count = total.saturating_sub(self.config.max_concurrency);

        // Build details
        let mut details = BatchDetails::new(total)
            .with_results(successes, failures)
            .with_duration(duration_ms)
            .with_concurrency(self.config.max_concurrency)
            .with_tool_durations(tool_durations)
            .with_executor_reuse_count(executor_reuse_count)
            .with_backpressure_count(backpressure_count);

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
        let mut failed = false;

        for call in calls {
            if failed {
                results.push(BatchToolResult {
                    call_id: call.call_id,
                    tool_name: call.tool_name,
                    result: ToolResult::failure("Skipped due to previous error in batch"),
                });
                continue;
            }

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
                failed = true;
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

fn record_joined_batch_result(
    result: Option<Result<(usize, BatchToolResult), tokio::task::JoinError>>,
    result_slots: &mut [Option<BatchToolResult>],
) {
    if let Some(Ok((index, result))) = result {
        if let Some(slot) = result_slots.get_mut(index) {
            *slot = Some(result);
        }
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
    async fn test_batch_executor_reuses_cached_executor_for_parallel_tasks() {
        let config = BatchConfig::default()
            .with_concurrency(2)
            .emit_events(false);
        let batch = BatchExecutor::with_config("/tmp", config);
        let calls = vec![
            BatchToolCall::new("1", "glob", json!({"pattern": "*.rs"})),
            BatchToolCall::new("2", "glob", json!({"pattern": "*.toml"})),
        ];

        let (results, details) = batch.execute_with_details(calls, None).await;

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].call_id, "1");
        assert_eq!(results[1].call_id, "2");
        assert_eq!(details.executor_reuse_count, Some(2));
        assert_eq!(details.backpressure_count, Some(0));
    }

    #[tokio::test]
    async fn test_batch_executor_reports_backpressure_count() {
        let config = BatchConfig::default()
            .with_concurrency(2)
            .emit_events(false);
        let batch = BatchExecutor::with_config("/tmp", config);
        let calls = vec![
            BatchToolCall::new("1", "glob", json!({"pattern": "*.rs"})),
            BatchToolCall::new("2", "glob", json!({"pattern": "*.toml"})),
            BatchToolCall::new("3", "glob", json!({"pattern": "*.md"})),
            BatchToolCall::new("4", "glob", json!({"pattern": "*.json"})),
        ];

        let (results, details) = batch.execute_with_details(calls, None).await;

        assert_eq!(results.len(), 4);
        assert_eq!(details.max_concurrency, Some(2));
        assert_eq!(details.backpressure_count, Some(2));
    }

    #[tokio::test]
    async fn test_batch_executor_cancel_closes_batch_with_failures() {
        let config = BatchConfig::default().with_concurrency(2);
        let batch = BatchExecutor::with_config("/tmp", config);
        let calls = vec![
            BatchToolCall::new("1", "glob", json!({"pattern": "*.rs"})),
            BatchToolCall::new("2", "glob", json!({"pattern": "*.toml"})),
            BatchToolCall::new("3", "glob", json!({"pattern": "*.json"})),
        ];
        let cancel_token = CancellationToken::new();
        cancel_token.cancel();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let results = batch
            .execute_with_cancel(calls, Some(tx), cancel_token)
            .await;

        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|result| !result.result.success));
        assert!(results.iter().all(|result| {
            result
                .result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("cancelled"))
        }));

        let mut saw_start = false;
        let mut saw_end = false;
        while let Ok(event) = rx.try_recv() {
            match event {
                FromAgent::BatchStart { total } => {
                    assert_eq!(total, 3);
                    saw_start = true;
                }
                FromAgent::BatchEnd {
                    total,
                    successes,
                    failures,
                } => {
                    assert_eq!(total, 3);
                    assert_eq!(successes, 0);
                    assert_eq!(failures, 3);
                    saw_end = true;
                }
                _ => {}
            }
        }

        assert!(saw_start);
        assert!(saw_end);
    }

    #[tokio::test]
    async fn test_cancelled_batch_drain_preserves_completed_results() {
        let mut task_set = JoinSet::new();
        task_set.spawn(async {
            (
                0,
                BatchToolResult {
                    call_id: "1".to_string(),
                    tool_name: "glob".to_string(),
                    result: ToolResult::success("completed before cancellation"),
                },
            )
        });

        let mut result_slots = vec![None];
        record_joined_batch_result(task_set.join_next().await, &mut result_slots);

        let result = result_slots.into_iter().next().flatten().unwrap();
        assert_eq!(result.call_id, "1");
        assert!(result.result.success);
        assert_eq!(result.result.output, "completed before cancellation");
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

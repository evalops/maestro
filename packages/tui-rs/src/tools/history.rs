//! Tool Output History
//!
//! Tracks tool executions with their inputs, outputs, and timing for
//! review, debugging, and re-execution.
//!
//! # Features
//!
//! - **Execution Log**: Records all tool calls with timing
//! - **Output Caching**: Stores outputs for review
//! - **Replay**: Re-run previous tool calls
//! - **Filtering**: Search by tool name, status, or content
//! - **Statistics**: Track success rates and execution times

use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

/// A single tool execution record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecution {
    /// Unique ID for this execution
    pub id: String,
    /// Tool name
    pub tool_name: String,
    /// Input arguments
    pub args: serde_json::Value,
    /// Output (if completed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Whether execution succeeded
    pub success: bool,
    /// Error message if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Structured execution details (timing, metadata, etc.)
    /// This captures tool-specific metadata like exit codes, file sizes, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// When execution started
    pub started_at: SystemTime,
    /// Execution duration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<Duration>,
    /// Whether this required user approval
    #[serde(default)]
    pub required_approval: bool,
    /// Whether user approved (if approval was required)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
}

impl ToolExecution {
    /// Create a new in-progress execution
    pub fn start(
        id: impl Into<String>,
        tool_name: impl Into<String>,
        args: serde_json::Value,
    ) -> Self {
        Self {
            id: id.into(),
            tool_name: tool_name.into(),
            args,
            output: None,
            success: false,
            error: None,
            details: None,
            started_at: SystemTime::now(),
            duration: None,
            required_approval: false,
            approved: None,
        }
    }

    /// Mark as requiring approval
    pub fn with_approval(mut self, required: bool) -> Self {
        self.required_approval = required;
        self
    }

    /// Complete the execution successfully
    pub fn complete(&mut self, output: String, duration: Duration) {
        self.output = Some(output);
        self.success = true;
        self.duration = Some(duration);
    }

    /// Complete the execution with structured details
    pub fn complete_with_details(
        &mut self,
        output: String,
        duration: Duration,
        details: Option<serde_json::Value>,
    ) {
        self.output = Some(output);
        self.success = true;
        self.duration = Some(duration);
        self.details = details;
    }

    /// Complete the execution with an error
    pub fn fail(&mut self, error: String, duration: Duration) {
        self.error = Some(error);
        self.success = false;
        self.duration = Some(duration);
    }

    /// Complete the execution with an error and details
    pub fn fail_with_details(
        &mut self,
        error: String,
        duration: Duration,
        details: Option<serde_json::Value>,
    ) {
        self.error = Some(error);
        self.success = false;
        self.duration = Some(duration);
        self.details = details;
    }

    /// Set the execution details
    pub fn set_details(&mut self, details: serde_json::Value) {
        self.details = Some(details);
    }

    /// Get the execution details
    pub fn get_details(&self) -> Option<&serde_json::Value> {
        self.details.as_ref()
    }

    /// Get typed details, deserializing to the specified type.
    /// Returns None if no details exist or if deserialization fails.
    pub fn get_typed_details<T>(&self) -> Option<T>
    where
        T: serde::de::DeserializeOwned,
    {
        self.details
            .as_ref()
            .and_then(|d| serde_json::from_value(d.clone()).ok())
    }

    /// Get duration in milliseconds
    pub fn duration_ms(&self) -> Option<u64> {
        self.duration.map(|d| d.as_millis() as u64)
    }

    /// Get the exit code from bash/inline tool details if available
    pub fn exit_code(&self) -> Option<i32> {
        self.details
            .as_ref()
            .and_then(|d| d.get("exit_code")?.as_i64().map(|i| i as i32))
    }

    /// Check if this execution timed out
    pub fn timed_out(&self) -> bool {
        self.details
            .as_ref()
            .and_then(|d| d.get("timed_out")?.as_bool())
            .unwrap_or(false)
    }

    /// Get the command that was executed (for bash/inline tools)
    pub fn command(&self) -> Option<&str> {
        self.details
            .as_ref()
            .and_then(|d| d.get("command")?.as_str())
    }

    /// Set approval status
    pub fn set_approved(&mut self, approved: bool) {
        self.approved = Some(approved);
    }

    /// Get a preview of the output (truncated, UTF-8 safe)
    pub fn output_preview(&self, max_len: usize) -> Option<String> {
        self.output.as_ref().map(|o| {
            let chars: Vec<char> = o.chars().collect();
            if chars.len() > max_len {
                format!("{}...", chars[..max_len].iter().collect::<String>())
            } else {
                o.clone()
            }
        })
    }

    /// Get a summary line for display
    pub fn summary(&self) -> String {
        let status = if self.success { "✓" } else { "✗" };
        let duration_str = self
            .duration
            .map(|d| format!("{:.0}ms", d.as_millis()))
            .unwrap_or_else(|| "...".to_string());

        format!("{} {} ({})", status, self.tool_name, duration_str)
    }
}

/// Statistics about tool executions
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolStats {
    /// Total executions
    pub total: u64,
    /// Successful executions
    pub successes: u64,
    /// Failed executions
    pub failures: u64,
    /// Total execution time
    pub total_duration: Duration,
    /// Average execution time
    #[serde(skip)]
    cached_avg: Option<Duration>,
}

impl ToolStats {
    /// Record an execution
    pub fn record(&mut self, success: bool, duration: Duration) {
        self.total += 1;
        if success {
            self.successes += 1;
        } else {
            self.failures += 1;
        }
        self.total_duration += duration;
        self.cached_avg = None;
    }

    /// Get success rate (0.0 - 1.0)
    pub fn success_rate(&self) -> f64 {
        if self.total > 0 {
            self.successes as f64 / self.total as f64
        } else {
            0.0
        }
    }

    /// Get average execution time
    pub fn avg_duration(&self) -> Duration {
        if self.total > 0 {
            self.total_duration / self.total as u32
        } else {
            Duration::ZERO
        }
    }

    /// Get average execution time in milliseconds
    pub fn avg_duration_ms(&self) -> u64 {
        self.avg_duration().as_millis() as u64
    }

    /// Get total execution time in milliseconds
    pub fn total_duration_ms(&self) -> u64 {
        self.total_duration.as_millis() as u64
    }

    /// Get failure rate (0.0 - 1.0)
    pub fn failure_rate(&self) -> f64 {
        if self.total > 0 {
            self.failures as f64 / self.total as f64
        } else {
            0.0
        }
    }

    /// Check if all executions succeeded
    pub fn all_succeeded(&self) -> bool {
        self.total > 0 && self.failures == 0
    }

    /// Check if any execution failed
    pub fn has_failures(&self) -> bool {
        self.failures > 0
    }

    /// Merge stats from another ToolStats
    pub fn merge(&mut self, other: &ToolStats) {
        self.total += other.total;
        self.successes += other.successes;
        self.failures += other.failures;
        self.total_duration += other.total_duration;
        self.cached_avg = None;
    }

    /// Create a summary string for display
    pub fn summary(&self) -> String {
        format!(
            "{}/{} ({}%) avg: {}ms",
            self.successes,
            self.total,
            (self.success_rate() * 100.0) as u32,
            self.avg_duration_ms()
        )
    }

    /// Convert to JSON
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "total": self.total,
            "successes": self.successes,
            "failures": self.failures,
            "total_duration_ms": self.total_duration_ms(),
            "avg_duration_ms": self.avg_duration_ms(),
            "success_rate": self.success_rate()
        })
    }
}

/// Filter criteria for searching history
#[derive(Debug, Clone, Default)]
pub struct HistoryFilter {
    /// Filter by tool name (partial match)
    pub tool_name: Option<String>,
    /// Filter by success status
    pub success: Option<bool>,
    /// Filter by output content (partial match)
    pub output_contains: Option<String>,
    /// Only show executions that required approval
    pub required_approval: Option<bool>,
    /// Minimum execution time
    pub min_duration: Option<Duration>,
}

impl HistoryFilter {
    /// Create a filter for a specific tool
    pub fn tool(name: impl Into<String>) -> Self {
        Self {
            tool_name: Some(name.into()),
            ..Default::default()
        }
    }

    /// Filter to only failures
    pub fn failures() -> Self {
        Self {
            success: Some(false),
            ..Default::default()
        }
    }

    /// Filter to only successes
    pub fn successes() -> Self {
        Self {
            success: Some(true),
            ..Default::default()
        }
    }

    /// Add output content filter
    pub fn containing(mut self, text: impl Into<String>) -> Self {
        self.output_contains = Some(text.into());
        self
    }

    /// Check if an execution matches this filter
    pub fn matches(&self, exec: &ToolExecution) -> bool {
        if let Some(ref name) = self.tool_name {
            if !exec.tool_name.to_lowercase().contains(&name.to_lowercase()) {
                return false;
            }
        }

        if let Some(success) = self.success {
            if exec.success != success {
                return false;
            }
        }

        if let Some(ref text) = self.output_contains {
            let text_lower = text.to_lowercase();
            let has_match = exec
                .output
                .as_ref()
                .map(|o| o.to_lowercase().contains(&text_lower))
                .unwrap_or(false);
            if !has_match {
                return false;
            }
        }

        if let Some(required) = self.required_approval {
            if exec.required_approval != required {
                return false;
            }
        }

        if let Some(min_dur) = self.min_duration {
            if exec.duration.map(|d| d < min_dur).unwrap_or(true) {
                return false;
            }
        }

        true
    }
}

/// Tool execution history tracker
#[derive(Debug)]
pub struct ToolHistory {
    /// Execution records (most recent last)
    executions: VecDeque<ToolExecution>,
    /// In-progress executions (by ID)
    in_progress: std::collections::HashMap<String, Instant>,
    /// Per-tool statistics
    stats: std::collections::HashMap<String, ToolStats>,
    /// Global statistics
    global_stats: ToolStats,
    /// Maximum history size
    max_size: usize,
}

impl ToolHistory {
    /// Create a new tool history tracker
    pub fn new(max_size: usize) -> Self {
        Self {
            executions: VecDeque::new(),
            in_progress: std::collections::HashMap::new(),
            stats: std::collections::HashMap::new(),
            global_stats: ToolStats::default(),
            max_size,
        }
    }

    /// Record the start of a tool execution
    pub fn start(
        &mut self,
        id: impl Into<String>,
        tool_name: impl Into<String>,
        args: serde_json::Value,
    ) -> String {
        let id = id.into();
        let tool_name = tool_name.into();

        self.in_progress.insert(id.clone(), Instant::now());

        let exec = ToolExecution::start(&id, &tool_name, args);
        self.executions.push_back(exec);

        // Trim if over size
        while self.executions.len() > self.max_size {
            self.executions.pop_front();
        }

        id
    }

    /// Record the start with approval info
    pub fn start_with_approval(
        &mut self,
        id: impl Into<String>,
        tool_name: impl Into<String>,
        args: serde_json::Value,
        requires_approval: bool,
    ) -> String {
        let id = id.into();
        let tool_name = tool_name.into();

        self.in_progress.insert(id.clone(), Instant::now());

        let exec = ToolExecution::start(&id, &tool_name, args).with_approval(requires_approval);
        self.executions.push_back(exec);

        while self.executions.len() > self.max_size {
            self.executions.pop_front();
        }

        id
    }

    /// Record approval decision
    pub fn record_approval(&mut self, id: &str, approved: bool) {
        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.set_approved(approved);
        }
    }

    /// Record successful completion
    pub fn complete(&mut self, id: &str, output: String) {
        let duration = self
            .in_progress
            .remove(id)
            .map(|start| start.elapsed())
            .unwrap_or(Duration::ZERO);

        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.complete(output, duration);

            // Update stats
            let tool_stats = self.stats.entry(exec.tool_name.clone()).or_default();
            tool_stats.record(true, duration);
            self.global_stats.record(true, duration);
        }
    }

    /// Record successful completion with structured details
    pub fn complete_with_details(
        &mut self,
        id: &str,
        output: String,
        details: Option<serde_json::Value>,
    ) {
        let duration = self
            .in_progress
            .remove(id)
            .map(|start| start.elapsed())
            .unwrap_or(Duration::ZERO);

        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.complete_with_details(output, duration, details);

            // Update stats
            let tool_stats = self.stats.entry(exec.tool_name.clone()).or_default();
            tool_stats.record(true, duration);
            self.global_stats.record(true, duration);
        }
    }

    /// Record failed completion
    pub fn fail(&mut self, id: &str, error: String) {
        let duration = self
            .in_progress
            .remove(id)
            .map(|start| start.elapsed())
            .unwrap_or(Duration::ZERO);

        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.fail(error, duration);

            // Update stats
            let tool_stats = self.stats.entry(exec.tool_name.clone()).or_default();
            tool_stats.record(false, duration);
            self.global_stats.record(false, duration);
        }
    }

    /// Record failed completion with structured details
    pub fn fail_with_details(
        &mut self,
        id: &str,
        error: String,
        details: Option<serde_json::Value>,
    ) {
        let duration = self
            .in_progress
            .remove(id)
            .map(|start| start.elapsed())
            .unwrap_or(Duration::ZERO);

        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.fail_with_details(error, duration, details);

            // Update stats
            let tool_stats = self.stats.entry(exec.tool_name.clone()).or_default();
            tool_stats.record(false, duration);
            self.global_stats.record(false, duration);
        }
    }

    /// Set details on an existing execution by ID
    pub fn set_details(&mut self, id: &str, details: serde_json::Value) {
        if let Some(exec) = self.executions.iter_mut().rev().find(|e| e.id == id) {
            exec.set_details(details);
        }
    }

    /// Get details from an execution by ID
    pub fn get_details(&self, id: &str) -> Option<&serde_json::Value> {
        self.executions
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.get_details())
    }

    /// Get all executions (most recent first)
    pub fn all(&self) -> impl Iterator<Item = &ToolExecution> {
        self.executions.iter().rev()
    }

    /// Get recent executions
    pub fn recent(&self, count: usize) -> Vec<&ToolExecution> {
        self.executions.iter().rev().take(count).collect()
    }

    /// Search history with filter
    pub fn search(&self, filter: &HistoryFilter) -> Vec<&ToolExecution> {
        self.executions
            .iter()
            .rev()
            .filter(|e| filter.matches(e))
            .collect()
    }

    /// Get executions for a specific tool
    pub fn for_tool(&self, tool_name: &str) -> Vec<&ToolExecution> {
        self.search(&HistoryFilter::tool(tool_name))
    }

    /// Get an execution by ID
    pub fn get(&self, id: &str) -> Option<&ToolExecution> {
        self.executions.iter().find(|e| e.id == id)
    }

    /// Get the most recent execution
    pub fn last(&self) -> Option<&ToolExecution> {
        self.executions.back()
    }

    /// Get stats for a specific tool
    pub fn tool_stats(&self, tool_name: &str) -> Option<&ToolStats> {
        self.stats.get(tool_name)
    }

    /// Get global stats
    pub fn global_stats(&self) -> &ToolStats {
        &self.global_stats
    }

    /// Get all tool stats
    pub fn all_stats(&self) -> &std::collections::HashMap<String, ToolStats> {
        &self.stats
    }

    /// Get tools ranked by usage count (descending)
    pub fn most_used_tools(&self, limit: usize) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self.stats.iter().map(|(k, v)| (k.as_str(), v)).collect();
        ranked.sort_by(|a, b| b.1.total.cmp(&a.1.total));
        ranked.truncate(limit);
        ranked
    }

    /// Get tools ranked by average duration (slowest first)
    pub fn slowest_tools(&self, limit: usize) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self
            .stats
            .iter()
            .filter(|(_, s)| s.total > 0)
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        ranked.sort_by(|a, b| b.1.avg_duration().cmp(&a.1.avg_duration()));
        ranked.truncate(limit);
        ranked
    }

    /// Get tools ranked by average duration (fastest first)
    pub fn fastest_tools(&self, limit: usize) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self
            .stats
            .iter()
            .filter(|(_, s)| s.total > 0)
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        ranked.sort_by(|a, b| a.1.avg_duration().cmp(&b.1.avg_duration()));
        ranked.truncate(limit);
        ranked
    }

    /// Get tools ranked by failure count (most failures first)
    pub fn most_failed_tools(&self, limit: usize) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self
            .stats
            .iter()
            .filter(|(_, s)| s.failures > 0)
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        ranked.sort_by(|a, b| b.1.failures.cmp(&a.1.failures));
        ranked.truncate(limit);
        ranked
    }

    /// Get tools with the highest failure rates (at least `min_calls` total)
    pub fn highest_failure_rate(&self, limit: usize, min_calls: u64) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self
            .stats
            .iter()
            .filter(|(_, s)| s.total >= min_calls && s.failures > 0)
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        ranked.sort_by(|a, b| {
            b.1.failure_rate()
                .partial_cmp(&a.1.failure_rate())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(limit);
        ranked
    }

    /// Get the total time spent executing tools
    pub fn total_execution_time(&self) -> Duration {
        self.global_stats.total_duration
    }

    /// Get the total time spent executing tools in milliseconds
    pub fn total_execution_time_ms(&self) -> u64 {
        self.global_stats.total_duration_ms()
    }

    /// Export all statistics as JSON
    pub fn stats_json(&self) -> serde_json::Value {
        let tool_stats: serde_json::Map<String, serde_json::Value> = self
            .stats
            .iter()
            .map(|(name, stats)| (name.clone(), stats.to_json()))
            .collect();

        serde_json::json!({
            "global": self.global_stats.to_json(),
            "by_tool": tool_stats,
            "total_executions": self.executions.len(),
            "in_progress": self.in_progress.len(),
            "tools_used": self.stats.len()
        })
    }

    /// Get a detailed stats summary with all tools
    pub fn detailed_summary(&self) -> String {
        let mut lines = vec![
            "Tool Execution Statistics".to_string(),
            "═".repeat(50),
            format!(
                "Total: {} executions ({} in progress)",
                self.global_stats.total,
                self.in_progress.len()
            ),
            format!(
                "Success Rate: {:.1}% ({}/{} succeeded)",
                self.global_stats.success_rate() * 100.0,
                self.global_stats.successes,
                self.global_stats.total
            ),
            format!(
                "Total Time: {:.2}s (avg: {}ms)",
                self.global_stats.total_duration.as_secs_f64(),
                self.global_stats.avg_duration_ms()
            ),
            String::new(),
        ];

        if !self.stats.is_empty() {
            lines.push("Most Used Tools:".to_string());
            lines.push("─".repeat(50));
            for (name, stats) in self.most_used_tools(5) {
                lines.push(format!(
                    "  {:15} {:>4} calls  {:>5.1}% success  {:>6}ms avg",
                    name,
                    stats.total,
                    stats.success_rate() * 100.0,
                    stats.avg_duration_ms()
                ));
            }

            let slowest = self.slowest_tools(3);
            if !slowest.is_empty() {
                lines.push(String::new());
                lines.push("Slowest Tools:".to_string());
                lines.push("─".repeat(50));
                for (name, stats) in slowest {
                    lines.push(format!(
                        "  {:15} {:>6}ms avg  ({} calls)",
                        name,
                        stats.avg_duration_ms(),
                        stats.total
                    ));
                }
            }

            let failed = self.most_failed_tools(3);
            if !failed.is_empty() {
                lines.push(String::new());
                lines.push("Most Failed Tools:".to_string());
                lines.push("─".repeat(50));
                for (name, stats) in failed {
                    lines.push(format!(
                        "  {:15} {:>4} failures  ({:.1}% failure rate)",
                        name,
                        stats.failures,
                        stats.failure_rate() * 100.0
                    ));
                }
            }
        }

        lines.join("\n")
    }

    /// Get the number of executions
    pub fn len(&self) -> usize {
        self.executions.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.executions.is_empty()
    }

    /// Get number of in-progress executions
    pub fn in_progress_count(&self) -> usize {
        self.in_progress.len()
    }

    /// Clear all history
    pub fn clear(&mut self) {
        self.executions.clear();
        self.in_progress.clear();
        self.stats.clear();
        self.global_stats = ToolStats::default();
    }

    /// Generate a summary report
    pub fn summary(&self) -> String {
        let mut lines = vec![
            format!("Tool Execution History"),
            format!("──────────────────────"),
            format!("Total: {} executions", self.global_stats.total),
            format!(
                "Success rate: {:.1}%",
                self.global_stats.success_rate() * 100.0
            ),
            format!(
                "Avg duration: {:.0}ms",
                self.global_stats.avg_duration().as_millis()
            ),
        ];

        if !self.stats.is_empty() {
            lines.push(String::new());
            lines.push("By Tool:".to_string());

            let mut tool_stats: Vec<_> = self.stats.iter().collect();
            tool_stats.sort_by(|a, b| b.1.total.cmp(&a.1.total));

            for (name, stats) in tool_stats.iter().take(10) {
                lines.push(format!(
                    "  {}: {} calls, {:.1}% success, {:.0}ms avg",
                    name,
                    stats.total,
                    stats.success_rate() * 100.0,
                    stats.avg_duration().as_millis()
                ));
            }
        }

        lines.join("\n")
    }
}

impl Default for ToolHistory {
    fn default() -> Self {
        Self::new(1000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_execution_lifecycle() {
        let mut exec = ToolExecution::start("call-1", "read", json!({"path": "/test"}));
        assert!(!exec.success);
        assert!(exec.output.is_none());

        exec.complete("file contents".to_string(), Duration::from_millis(50));
        assert!(exec.success);
        assert_eq!(exec.output, Some("file contents".to_string()));
    }

    #[test]
    fn test_tool_history_basic() {
        let mut history = ToolHistory::new(100);

        let id = history.start("1", "read", json!({"path": "/test"}));
        history.complete(&id, "output".to_string());

        assert_eq!(history.len(), 1);
        assert!(history.last().unwrap().success);
    }

    #[test]
    fn test_tool_history_stats() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({}));
        history.complete("1", "ok".to_string());

        history.start("2", "read", json!({}));
        history.fail("2", "error".to_string());

        let stats = history.global_stats();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.successes, 1);
        assert_eq!(stats.failures, 1);
        assert!((stats.success_rate() - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_tool_history_filter() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({}));
        history.complete("1", "file content".to_string());

        history.start("2", "write", json!({}));
        history.complete("2", "ok".to_string());

        history.start("3", "read", json!({}));
        history.fail("3", "not found".to_string());

        // Filter by tool
        let reads = history.search(&HistoryFilter::tool("read"));
        assert_eq!(reads.len(), 2);

        // Filter by success
        let successes = history.search(&HistoryFilter::successes());
        assert_eq!(successes.len(), 2);

        // Filter by failure
        let failures = history.search(&HistoryFilter::failures());
        assert_eq!(failures.len(), 1);

        // Filter by content
        let with_content = history.search(&HistoryFilter::default().containing("file"));
        assert_eq!(with_content.len(), 1);
    }

    #[test]
    fn test_tool_history_max_size() {
        let mut history = ToolHistory::new(3);

        for i in 0..5 {
            let id = format!("{}", i);
            history.start(&id, "test", json!({}));
            history.complete(&id, "ok".to_string());
        }

        assert_eq!(history.len(), 3);
        // Should have most recent (2, 3, 4)
        let ids: Vec<_> = history.all().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["4", "3", "2"]);
    }

    #[test]
    fn test_tool_stats() {
        let mut stats = ToolStats::default();

        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(200));
        stats.record(false, Duration::from_millis(50));

        assert_eq!(stats.total, 3);
        assert_eq!(stats.successes, 2);
        assert!((stats.success_rate() - 0.666).abs() < 0.01);
        assert_eq!(stats.avg_duration().as_millis(), 116); // (100+200+50)/3
    }

    #[test]
    fn test_execution_summary() {
        let mut exec = ToolExecution::start("1", "read", json!({}));
        exec.complete("ok".to_string(), Duration::from_millis(123));

        let summary = exec.summary();
        assert!(summary.contains("✓"));
        assert!(summary.contains("read"));
        assert!(summary.contains("123ms"));
    }

    #[test]
    fn test_approval_tracking() {
        let mut history = ToolHistory::new(100);

        history.start_with_approval("1", "write", json!({}), true);
        history.record_approval("1", true);
        history.complete("1", "ok".to_string());

        let exec = history.get("1").unwrap();
        assert!(exec.required_approval);
        assert_eq!(exec.approved, Some(true));
    }

    #[test]
    fn test_execution_with_details() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls"}));
        let details = json!({
            "command": "ls",
            "exit_code": 0,
            "duration_ms": 50
        });

        exec.complete_with_details(
            "file1\nfile2".to_string(),
            Duration::from_millis(50),
            Some(details.clone()),
        );

        assert!(exec.success);
        assert_eq!(exec.output, Some("file1\nfile2".to_string()));
        assert!(exec.details.is_some());

        let exec_details = exec.get_details().unwrap();
        assert_eq!(exec_details["exit_code"], 0);
        assert_eq!(exec_details["command"], "ls");
    }

    #[test]
    fn test_execution_fail_with_details() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "invalid"}));
        let details = json!({
            "command": "invalid",
            "exit_code": 127,
            "duration_ms": 10
        });

        exec.fail_with_details(
            "command not found".to_string(),
            Duration::from_millis(10),
            Some(details.clone()),
        );

        assert!(!exec.success);
        assert_eq!(exec.error, Some("command not found".to_string()));
        assert!(exec.details.is_some());

        let exec_details = exec.get_details().unwrap();
        assert_eq!(exec_details["exit_code"], 127);
    }

    #[test]
    fn test_history_complete_with_details() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({"file_path": "/test.txt"}));

        let details = json!({
            "file_path": "/test.txt",
            "bytes_read": 1024,
            "lines_returned": 50
        });

        history.complete_with_details("1", "file contents".to_string(), Some(details));

        let exec = history.get("1").unwrap();
        assert!(exec.success);
        assert!(exec.details.is_some());

        let stored_details = history.get_details("1").unwrap();
        assert_eq!(stored_details["bytes_read"], 1024);
        assert_eq!(stored_details["lines_returned"], 50);
    }

    #[test]
    fn test_history_fail_with_details() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({"file_path": "/missing.txt"}));

        let details = json!({
            "file_path": "/missing.txt",
            "error_code": "ENOENT"
        });

        history.fail_with_details("1", "file not found".to_string(), Some(details));

        let exec = history.get("1").unwrap();
        assert!(!exec.success);
        assert!(exec.details.is_some());

        let stored_details = history.get_details("1").unwrap();
        assert_eq!(stored_details["error_code"], "ENOENT");
    }

    #[test]
    fn test_history_set_and_get_details() {
        let mut history = ToolHistory::new(100);

        history.start("1", "glob", json!({"pattern": "*.rs"}));

        // Set details after the fact
        history.set_details(
            "1",
            json!({
                "pattern": "*.rs",
                "matches_count": 42,
                "base_path": "/src"
            }),
        );

        let details = history.get_details("1").unwrap();
        assert_eq!(details["matches_count"], 42);
        assert_eq!(details["base_path"], "/src");

        // Complete the execution
        history.complete("1", "found 42 files".to_string());

        // Details should still be present
        let exec = history.get("1").unwrap();
        assert!(exec.success);
        assert!(exec.details.is_some());
    }

    #[test]
    fn test_details_serialization() {
        let mut exec = ToolExecution::start("1", "image", json!({"path": "/screenshot.png"}));
        let details = json!({
            "path": "/screenshot.png",
            "mime_type": "image/png",
            "size_bytes": 50000,
            "dimensions": {"width": 1920, "height": 1080}
        });

        exec.complete_with_details(
            "base64...".to_string(),
            Duration::from_millis(100),
            Some(details),
        );

        // Test serialization round-trip
        let serialized = serde_json::to_string(&exec).unwrap();
        let deserialized: ToolExecution = serde_json::from_str(&serialized).unwrap();

        assert!(deserialized.details.is_some());
        let d = deserialized.details.unwrap();
        assert_eq!(d["mime_type"], "image/png");
        assert_eq!(d["dimensions"]["width"], 1920);
    }

    #[test]
    fn test_details_none_not_serialized() {
        let mut exec = ToolExecution::start("1", "read", json!({}));
        exec.complete("content".to_string(), Duration::from_millis(10));

        // Without details, should not have "details" key in JSON
        let serialized = serde_json::to_string(&exec).unwrap();
        assert!(!serialized.contains("\"details\""));
    }

    #[test]
    fn test_get_typed_details() {
        use crate::tools::details::BashDetails;

        let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls -la"}));
        let details = BashDetails::success("ls -la")
            .with_duration(50)
            .with_cwd("/home/user");

        exec.complete_with_details(
            "file1\nfile2".to_string(),
            Duration::from_millis(50),
            Some(details.to_json()),
        );

        // Get typed details
        let typed: Option<BashDetails> = exec.get_typed_details();
        assert!(typed.is_some());

        let bash_details = typed.unwrap();
        assert_eq!(bash_details.command, "ls -la");
        assert_eq!(bash_details.exit_code, 0);
        assert_eq!(bash_details.duration_ms, Some(50));
    }

    #[test]
    fn test_exit_code_accessor() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "false"}));
        let details = json!({
            "command": "false",
            "exit_code": 1,
            "duration_ms": 10
        });

        exec.complete_with_details("".to_string(), Duration::from_millis(10), Some(details));

        assert_eq!(exec.exit_code(), Some(1));
    }

    #[test]
    fn test_exit_code_accessor_none() {
        let mut exec = ToolExecution::start("1", "read", json!({"file_path": "/test.txt"}));
        exec.complete("content".to_string(), Duration::from_millis(10));

        // No details, so exit_code should be None
        assert_eq!(exec.exit_code(), None);
    }

    #[test]
    fn test_timed_out_accessor() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "sleep 100"}));
        let details = json!({
            "command": "sleep 100",
            "timed_out": true,
            "duration_ms": 30000
        });

        exec.fail_with_details(
            "Command timed out after 30000ms".to_string(),
            Duration::from_millis(30000),
            Some(details),
        );

        assert!(exec.timed_out());
    }

    #[test]
    fn test_timed_out_accessor_false() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "echo hi"}));
        let details = json!({
            "command": "echo hi",
            "timed_out": false,
            "exit_code": 0
        });

        exec.complete_with_details("hi".to_string(), Duration::from_millis(5), Some(details));

        assert!(!exec.timed_out());
    }

    #[test]
    fn test_command_accessor() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "cargo build"}));
        let details = json!({
            "command": "cargo build",
            "exit_code": 0
        });

        exec.complete_with_details(
            "Built".to_string(),
            Duration::from_millis(1000),
            Some(details),
        );

        assert_eq!(exec.command(), Some("cargo build"));
    }

    #[test]
    fn test_command_accessor_none() {
        let mut exec = ToolExecution::start("1", "read", json!({"file_path": "/test.txt"}));
        let details = json!({
            "file_path": "/test.txt",
            "bytes_read": 100
        });

        exec.complete_with_details(
            "content".to_string(),
            Duration::from_millis(10),
            Some(details),
        );

        // Read tool doesn't have a "command" field
        assert_eq!(exec.command(), None);
    }

    #[test]
    fn test_duration_ms_accessor() {
        let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls"}));
        exec.complete("output".to_string(), Duration::from_millis(123));

        assert_eq!(exec.duration_ms(), Some(123));
    }

    // ==================== ToolStats utility method tests ====================

    #[test]
    fn test_tool_stats_avg_duration_ms() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(200));
        stats.record(true, Duration::from_millis(300));

        assert_eq!(stats.avg_duration_ms(), 200);
    }

    #[test]
    fn test_tool_stats_avg_duration_ms_empty() {
        let stats = ToolStats::default();
        assert_eq!(stats.avg_duration_ms(), 0);
    }

    #[test]
    fn test_tool_stats_total_duration_ms() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(200));
        stats.record(false, Duration::from_millis(50));

        assert_eq!(stats.total_duration_ms(), 350);
    }

    #[test]
    fn test_tool_stats_failure_rate() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(10));
        stats.record(false, Duration::from_millis(10));
        stats.record(false, Duration::from_millis(10));
        stats.record(false, Duration::from_millis(10));

        assert!((stats.failure_rate() - 0.75).abs() < 0.01);
    }

    #[test]
    fn test_tool_stats_failure_rate_empty() {
        let stats = ToolStats::default();
        assert_eq!(stats.failure_rate(), 0.0);
    }

    #[test]
    fn test_tool_stats_all_succeeded() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(10));
        stats.record(true, Duration::from_millis(10));

        assert!(stats.all_succeeded());

        stats.record(false, Duration::from_millis(10));
        assert!(!stats.all_succeeded());
    }

    #[test]
    fn test_tool_stats_all_succeeded_empty() {
        let stats = ToolStats::default();
        // Empty stats should return false for all_succeeded
        assert!(!stats.all_succeeded());
    }

    #[test]
    fn test_tool_stats_has_failures() {
        let mut stats = ToolStats::default();
        assert!(!stats.has_failures());

        stats.record(true, Duration::from_millis(10));
        assert!(!stats.has_failures());

        stats.record(false, Duration::from_millis(10));
        assert!(stats.has_failures());
    }

    #[test]
    fn test_tool_stats_merge() {
        let mut stats1 = ToolStats::default();
        stats1.record(true, Duration::from_millis(100));
        stats1.record(true, Duration::from_millis(200));

        let mut stats2 = ToolStats::default();
        stats2.record(false, Duration::from_millis(50));
        stats2.record(true, Duration::from_millis(150));

        stats1.merge(&stats2);

        assert_eq!(stats1.total, 4);
        assert_eq!(stats1.successes, 3);
        assert_eq!(stats1.failures, 1);
        assert_eq!(stats1.total_duration_ms(), 500);
    }

    #[test]
    fn test_tool_stats_summary() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(200));
        stats.record(false, Duration::from_millis(50));

        let summary = stats.summary();
        assert!(summary.contains("2/3")); // 2 successes out of 3 total
        assert!(summary.contains("66%")); // ~66% success rate
    }

    #[test]
    fn test_tool_stats_to_json() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(false, Duration::from_millis(50));

        let json = stats.to_json();

        assert_eq!(json["total"], 2);
        assert_eq!(json["successes"], 1);
        assert_eq!(json["failures"], 1);
        assert_eq!(json["total_duration_ms"], 150);
        assert_eq!(json["avg_duration_ms"], 75);
        assert!((json["success_rate"].as_f64().unwrap() - 0.5).abs() < 0.01);
    }

    // ==================== ToolHistory analysis method tests ====================

    fn create_test_history() -> ToolHistory {
        let mut history = ToolHistory::new(100);

        // read: 5 calls, 4 success, avg 100ms
        for i in 0..5 {
            let id = format!("read-{}", i);
            history.start(&id, "read", json!({}));
            std::thread::sleep(Duration::from_millis(1)); // Simulate some time passing
            if i < 4 {
                history.complete(&id, "ok".to_string());
            } else {
                history.fail(&id, "error".to_string());
            }
        }

        // write: 3 calls, 2 success, avg 200ms
        for i in 0..3 {
            let id = format!("write-{}", i);
            history.start(&id, "write", json!({}));
            std::thread::sleep(Duration::from_millis(2));
            if i < 2 {
                history.complete(&id, "ok".to_string());
            } else {
                history.fail(&id, "error".to_string());
            }
        }

        // bash: 2 calls, 0 success (100% failure rate)
        for i in 0..2 {
            let id = format!("bash-{}", i);
            history.start(&id, "bash", json!({}));
            std::thread::sleep(Duration::from_millis(3));
            history.fail(&id, "error".to_string());
        }

        history
    }

    #[test]
    fn test_history_most_used_tools() {
        let history = create_test_history();

        let most_used = history.most_used_tools(10);
        assert_eq!(most_used.len(), 3);

        // read should be first (5 calls)
        assert_eq!(most_used[0].0, "read");
        assert_eq!(most_used[0].1.total, 5);

        // write should be second (3 calls)
        assert_eq!(most_used[1].0, "write");
        assert_eq!(most_used[1].1.total, 3);

        // bash should be third (2 calls)
        assert_eq!(most_used[2].0, "bash");
        assert_eq!(most_used[2].1.total, 2);
    }

    #[test]
    fn test_history_most_used_tools_limit() {
        let history = create_test_history();

        let most_used = history.most_used_tools(2);
        assert_eq!(most_used.len(), 2);
        assert_eq!(most_used[0].0, "read");
        assert_eq!(most_used[1].0, "write");
    }

    #[test]
    fn test_history_slowest_tools() {
        let history = create_test_history();

        let slowest = history.slowest_tools(10);
        assert_eq!(slowest.len(), 3);

        // bash should be slowest (3ms sleep per call)
        assert_eq!(slowest[0].0, "bash");

        // write should be second (2ms sleep per call)
        assert_eq!(slowest[1].0, "write");

        // read should be fastest (1ms sleep per call)
        assert_eq!(slowest[2].0, "read");
    }

    #[test]
    fn test_history_fastest_tools() {
        let history = create_test_history();

        let fastest = history.fastest_tools(10);
        assert_eq!(fastest.len(), 3);

        // read should be fastest
        assert_eq!(fastest[0].0, "read");

        // write should be second
        assert_eq!(fastest[1].0, "write");

        // bash should be slowest
        assert_eq!(fastest[2].0, "bash");
    }

    #[test]
    fn test_history_most_failed_tools() {
        let history = create_test_history();

        let most_failed = history.most_failed_tools(10);
        assert_eq!(most_failed.len(), 3);

        // bash has 2 failures
        assert_eq!(most_failed[0].0, "bash");
        assert_eq!(most_failed[0].1.failures, 2);

        // read and write each have 1 failure
        assert!(most_failed[1].1.failures == 1);
        assert!(most_failed[2].1.failures == 1);
    }

    #[test]
    fn test_history_highest_failure_rate() {
        let history = create_test_history();

        // bash has 100% failure rate, write has 33%, read has 20%
        let highest = history.highest_failure_rate(10, 1);
        assert_eq!(highest.len(), 3);

        // bash should be first (100% failure)
        assert_eq!(highest[0].0, "bash");
        assert!((highest[0].1.failure_rate() - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_history_highest_failure_rate_min_calls() {
        let history = create_test_history();

        // With min_calls=3, bash (2 calls) should be excluded
        let highest = history.highest_failure_rate(10, 3);
        assert_eq!(highest.len(), 2);

        // Only read and write should be included
        let names: Vec<_> = highest.iter().map(|(n, _)| *n).collect();
        assert!(!names.contains(&"bash"));
    }

    #[test]
    fn test_history_total_execution_time() {
        let history = create_test_history();

        let total = history.total_execution_time();
        // Should have some time recorded
        assert!(total.as_millis() > 0);

        let total_ms = history.total_execution_time_ms();
        assert_eq!(total_ms, total.as_millis() as u64);
    }

    #[test]
    fn test_history_stats_json() {
        let history = create_test_history();

        let json = history.stats_json();

        assert!(json.get("global").is_some());
        assert!(json.get("by_tool").is_some());
        assert_eq!(json["total_executions"], 10);
        assert_eq!(json["in_progress"], 0);
        assert_eq!(json["tools_used"], 3);

        let by_tool = json["by_tool"].as_object().unwrap();
        assert!(by_tool.contains_key("read"));
        assert!(by_tool.contains_key("write"));
        assert!(by_tool.contains_key("bash"));
    }

    #[test]
    fn test_history_stats_json_global() {
        let history = create_test_history();

        let json = history.stats_json();
        let global = &json["global"];

        assert_eq!(global["total"], 10);
        assert_eq!(global["successes"], 6);
        assert_eq!(global["failures"], 4);
    }

    #[test]
    fn test_history_detailed_summary() {
        let history = create_test_history();

        let summary = history.detailed_summary();

        // Check header
        assert!(summary.contains("Tool Execution Statistics"));

        // Check total
        assert!(summary.contains("10 executions"));

        // Check success rate
        assert!(summary.contains("60.0%")); // 6/10 = 60%

        // Check most used tools section
        assert!(summary.contains("Most Used Tools"));
        assert!(summary.contains("read"));
        assert!(summary.contains("write"));

        // Check slowest tools section
        assert!(summary.contains("Slowest Tools"));
        assert!(summary.contains("bash"));

        // Check most failed tools section
        assert!(summary.contains("Most Failed Tools"));
    }

    #[test]
    fn test_history_detailed_summary_empty() {
        let history = ToolHistory::new(100);

        let summary = history.detailed_summary();

        assert!(summary.contains("Tool Execution Statistics"));
        assert!(summary.contains("0 executions"));
        // Should not have tool sections when empty
        assert!(!summary.contains("Most Used Tools"));
    }

    #[test]
    fn test_history_analysis_empty() {
        let history = ToolHistory::new(100);

        assert!(history.most_used_tools(10).is_empty());
        assert!(history.slowest_tools(10).is_empty());
        assert!(history.fastest_tools(10).is_empty());
        assert!(history.most_failed_tools(10).is_empty());
        assert!(history.highest_failure_rate(10, 1).is_empty());
        assert_eq!(history.total_execution_time_ms(), 0);
    }
}

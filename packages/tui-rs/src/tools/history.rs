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

    /// Complete the execution with an error
    pub fn fail(&mut self, error: String, duration: Duration) {
        self.error = Some(error);
        self.success = false;
        self.duration = Some(duration);
    }

    /// Set approval status
    pub fn set_approved(&mut self, approved: bool) {
        self.approved = Some(approved);
    }

    /// Get a preview of the output (truncated)
    pub fn output_preview(&self, max_len: usize) -> Option<String> {
        self.output.as_ref().map(|o| {
            if o.len() > max_len {
                format!("{}...", &o[..max_len])
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
            history.start(&format!("{}", i), "test", json!({}));
            history.complete(&format!("{}", i), "ok".to_string());
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
}

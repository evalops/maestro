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
    #[must_use]
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
    #[must_use]
    pub fn get_details(&self) -> Option<&serde_json::Value> {
        self.details.as_ref()
    }

    /// Get typed details, deserializing to the specified type.
    /// Returns None if no details exist or if deserialization fails.
    #[must_use]
    pub fn get_typed_details<T>(&self) -> Option<T>
    where
        T: serde::de::DeserializeOwned,
    {
        self.details
            .as_ref()
            .and_then(|d| serde_json::from_value(d.clone()).ok())
    }

    /// Get duration in milliseconds
    #[must_use]
    pub fn duration_ms(&self) -> Option<u64> {
        self.duration.map(|d| d.as_millis() as u64)
    }

    /// Get the exit code from bash/inline tool details if available
    #[must_use]
    pub fn exit_code(&self) -> Option<i32> {
        self.details
            .as_ref()
            .and_then(|d| d.get("exit_code")?.as_i64().map(|i| i as i32))
    }

    /// Check if this execution timed out
    #[must_use]
    pub fn timed_out(&self) -> bool {
        self.details
            .as_ref()
            .and_then(|d| d.get("timed_out")?.as_bool())
            .unwrap_or(false)
    }

    /// Get the command that was executed (for bash/inline tools)
    #[must_use]
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
    #[must_use]
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
    #[must_use]
    pub fn summary(&self) -> String {
        let status = if self.success { "✓" } else { "✗" };
        let duration_str = self
            .duration
            .map_or_else(|| "...".to_string(), |d| format!("{:.0}ms", d.as_millis()));

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
    /// Minimum execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_duration: Option<Duration>,
    /// Maximum execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_duration: Option<Duration>,
    /// Individual durations for percentile calculations (capped)
    #[serde(skip)]
    durations: Vec<Duration>,
    /// Maximum durations to keep for percentile calculations
    #[serde(skip)]
    max_durations: usize,
    /// Average execution time
    #[serde(skip)]
    cached_avg: Option<Duration>,
}

impl ToolStats {
    /// Create a new `ToolStats` with a custom `max_durations` limit
    #[must_use]
    pub fn with_max_durations(max_durations: usize) -> Self {
        Self {
            max_durations,
            ..Default::default()
        }
    }

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

        // Track min/max
        self.min_duration = Some(self.min_duration.map_or(duration, |m| m.min(duration)));
        self.max_duration = Some(self.max_duration.map_or(duration, |m| m.max(duration)));

        // Track individual durations for percentiles (capped at max_durations)
        if self.max_durations == 0 {
            self.max_durations = 1000; // default cap
        }
        if self.durations.len() < self.max_durations {
            self.durations.push(duration);
        }
    }

    /// Get success rate (0.0 - 1.0)
    #[must_use]
    pub fn success_rate(&self) -> f64 {
        if self.total > 0 {
            self.successes as f64 / self.total as f64
        } else {
            0.0
        }
    }

    /// Get average execution time
    #[must_use]
    pub fn avg_duration(&self) -> Duration {
        if self.total > 0 {
            self.total_duration / self.total as u32
        } else {
            Duration::ZERO
        }
    }

    /// Get average execution time in milliseconds
    #[must_use]
    pub fn avg_duration_ms(&self) -> u64 {
        self.avg_duration().as_millis() as u64
    }

    /// Get total execution time in milliseconds
    #[must_use]
    pub fn total_duration_ms(&self) -> u64 {
        self.total_duration.as_millis() as u64
    }

    /// Get failure rate (0.0 - 1.0)
    #[must_use]
    pub fn failure_rate(&self) -> f64 {
        if self.total > 0 {
            self.failures as f64 / self.total as f64
        } else {
            0.0
        }
    }

    /// Check if all executions succeeded
    #[must_use]
    pub fn all_succeeded(&self) -> bool {
        self.total > 0 && self.failures == 0
    }

    /// Check if any execution failed
    #[must_use]
    pub fn has_failures(&self) -> bool {
        self.failures > 0
    }

    /// Merge stats from another `ToolStats`
    pub fn merge(&mut self, other: &ToolStats) {
        self.total += other.total;
        self.successes += other.successes;
        self.failures += other.failures;
        self.total_duration += other.total_duration;
        self.cached_avg = None;

        // Merge min/max
        if let Some(other_min) = other.min_duration {
            self.min_duration = Some(self.min_duration.map_or(other_min, |m| m.min(other_min)));
        }
        if let Some(other_max) = other.max_duration {
            self.max_duration = Some(self.max_duration.map_or(other_max, |m| m.max(other_max)));
        }

        // Merge durations (up to cap)
        let remaining_cap = self.max_durations.saturating_sub(self.durations.len());
        self.durations
            .extend(other.durations.iter().take(remaining_cap).copied());
    }

    /// Create a summary string for display
    #[must_use]
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
    #[must_use]
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

    /// Convert to detailed JSON including min/max/percentiles
    #[must_use]
    pub fn to_detailed_json(&self) -> serde_json::Value {
        let mut json = serde_json::json!({
            "total": self.total,
            "successes": self.successes,
            "failures": self.failures,
            "total_duration_ms": self.total_duration_ms(),
            "avg_duration_ms": self.avg_duration_ms(),
            "success_rate": self.success_rate(),
            "failure_rate": self.failure_rate()
        });

        if let Some(min) = self.min_duration {
            json["min_duration_ms"] = serde_json::json!(min.as_millis() as u64);
        }
        if let Some(max) = self.max_duration {
            json["max_duration_ms"] = serde_json::json!(max.as_millis() as u64);
        }
        if let Some(p50) = self.percentile(50) {
            json["p50_duration_ms"] = serde_json::json!(p50.as_millis() as u64);
        }
        if let Some(p90) = self.percentile(90) {
            json["p90_duration_ms"] = serde_json::json!(p90.as_millis() as u64);
        }
        if let Some(p99) = self.percentile(99) {
            json["p99_duration_ms"] = serde_json::json!(p99.as_millis() as u64);
        }

        json
    }

    /// Get minimum execution time in milliseconds
    #[must_use]
    pub fn min_duration_ms(&self) -> Option<u64> {
        self.min_duration.map(|d| d.as_millis() as u64)
    }

    /// Get maximum execution time in milliseconds
    #[must_use]
    pub fn max_duration_ms(&self) -> Option<u64> {
        self.max_duration.map(|d| d.as_millis() as u64)
    }

    /// Get the duration range (max - min)
    #[must_use]
    pub fn duration_range(&self) -> Option<Duration> {
        match (self.min_duration, self.max_duration) {
            (Some(min), Some(max)) => Some(max.saturating_sub(min)),
            _ => None,
        }
    }

    /// Get the duration range in milliseconds
    #[must_use]
    pub fn duration_range_ms(&self) -> Option<u64> {
        self.duration_range().map(|d| d.as_millis() as u64)
    }

    /// Calculate percentile duration (0-100)
    /// Returns None if no durations are recorded
    #[must_use]
    pub fn percentile(&self, p: u8) -> Option<Duration> {
        if self.durations.is_empty() {
            return None;
        }

        let p = f64::from(p.min(100)) / 100.0;
        let mut sorted = self.durations.clone();
        sorted.sort();

        let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
        Some(sorted[idx])
    }

    /// Calculate percentile duration in milliseconds
    #[must_use]
    pub fn percentile_ms(&self, p: u8) -> Option<u64> {
        self.percentile(p).map(|d| d.as_millis() as u64)
    }

    /// Get standard deviation of durations
    #[must_use]
    pub fn std_deviation(&self) -> Option<Duration> {
        if self.durations.len() < 2 {
            return None;
        }

        let avg = self.avg_duration().as_nanos() as f64;
        let variance: f64 = self
            .durations
            .iter()
            .map(|d| {
                let diff = d.as_nanos() as f64 - avg;
                diff * diff
            })
            .sum::<f64>()
            / self.durations.len() as f64;

        let std_dev_nanos = variance.sqrt() as u64;
        Some(Duration::from_nanos(std_dev_nanos))
    }

    /// Get standard deviation in milliseconds
    #[must_use]
    pub fn std_deviation_ms(&self) -> Option<u64> {
        self.std_deviation().map(|d| d.as_millis() as u64)
    }

    /// Check if durations have high variance (std dev > avg * threshold)
    #[must_use]
    pub fn has_high_variance(&self, threshold: f64) -> bool {
        match (self.std_deviation(), self.total > 0) {
            (Some(std), true) => {
                let avg = self.avg_duration();
                if avg.is_zero() {
                    false
                } else {
                    std.as_nanos() as f64 / avg.as_nanos() as f64 > threshold
                }
            }
            _ => false,
        }
    }

    /// Get throughput (executions per second)
    #[must_use]
    pub fn throughput(&self) -> f64 {
        if self.total_duration.is_zero() {
            0.0
        } else {
            self.total as f64 / self.total_duration.as_secs_f64()
        }
    }

    /// Compare with another `ToolStats` and return relative performance
    /// Returns a value > 1.0 if self is faster, < 1.0 if slower
    #[must_use]
    pub fn relative_performance(&self, other: &ToolStats) -> Option<f64> {
        if self.total == 0 || other.total == 0 {
            return None;
        }
        let self_avg = self.avg_duration().as_nanos() as f64;
        let other_avg = other.avg_duration().as_nanos() as f64;
        if self_avg == 0.0 {
            return None;
        }
        Some(other_avg / self_avg)
    }

    /// Get a health score (0.0-1.0) based on success rate and consistency
    /// Higher is better - penalizes failures and high variance
    #[must_use]
    pub fn health_score(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }

        let success_component = self.success_rate();

        // Variance penalty: if std dev > avg, penalize
        let variance_penalty = if self.has_high_variance(1.0) {
            0.8 // 20% penalty for high variance
        } else {
            1.0
        };

        success_component * variance_penalty
    }

    /// Check if this tool is "healthy" (high success rate, low variance)
    #[must_use]
    pub fn is_healthy(&self, min_success_rate: f64) -> bool {
        self.total > 0 && self.success_rate() >= min_success_rate && !self.has_high_variance(2.0)
    }

    /// Get number of tracked durations (for percentile accuracy)
    #[must_use]
    pub fn tracked_durations(&self) -> usize {
        self.durations.len()
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
    /// Maximum execution time
    pub max_duration: Option<Duration>,
    /// Filter executions started after this time
    pub after: Option<SystemTime>,
    /// Filter executions started before this time
    pub before: Option<SystemTime>,
    /// Filter by presence of details
    pub has_details: Option<bool>,
    /// Filter by specific detail field existence
    pub has_detail_field: Option<String>,
    /// Filter by exit code (for bash/inline tools)
    pub exit_code: Option<i32>,
    /// Filter by timed out status
    pub timed_out: Option<bool>,
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
    #[must_use]
    pub fn failures() -> Self {
        Self {
            success: Some(false),
            ..Default::default()
        }
    }

    /// Filter to only successes
    #[must_use]
    pub fn successes() -> Self {
        Self {
            success: Some(true),
            ..Default::default()
        }
    }

    /// Filter to executions that timed out
    #[must_use]
    pub fn timed_out_only() -> Self {
        Self {
            timed_out: Some(true),
            ..Default::default()
        }
    }

    /// Filter to executions with details
    #[must_use]
    pub fn with_details() -> Self {
        Self {
            has_details: Some(true),
            ..Default::default()
        }
    }

    /// Add output content filter
    pub fn containing(mut self, text: impl Into<String>) -> Self {
        self.output_contains = Some(text.into());
        self
    }

    /// Add time range filter (after)
    #[must_use]
    pub fn after(mut self, time: SystemTime) -> Self {
        self.after = Some(time);
        self
    }

    /// Add time range filter (before)
    #[must_use]
    pub fn before(mut self, time: SystemTime) -> Self {
        self.before = Some(time);
        self
    }

    /// Add time range filter (within last N seconds)
    #[must_use]
    pub fn within_last(mut self, duration: Duration) -> Self {
        self.after = Some(SystemTime::now() - duration);
        self
    }

    /// Filter by minimum duration
    #[must_use]
    pub fn min_duration(mut self, duration: Duration) -> Self {
        self.min_duration = Some(duration);
        self
    }

    /// Filter by maximum duration
    #[must_use]
    pub fn max_duration(mut self, duration: Duration) -> Self {
        self.max_duration = Some(duration);
        self
    }

    /// Filter by duration range
    #[must_use]
    pub fn duration_between(mut self, min: Duration, max: Duration) -> Self {
        self.min_duration = Some(min);
        self.max_duration = Some(max);
        self
    }

    /// Filter by exit code
    #[must_use]
    pub fn with_exit_code(mut self, code: i32) -> Self {
        self.exit_code = Some(code);
        self
    }

    /// Filter by presence of a specific detail field
    pub fn with_detail_field(mut self, field: impl Into<String>) -> Self {
        self.has_detail_field = Some(field.into());
        self
    }

    /// Check if an execution matches this filter
    #[must_use]
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
                .is_some_and(|o| o.to_lowercase().contains(&text_lower));
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
            if exec.duration.is_none_or(|d| d < min_dur) {
                return false;
            }
        }

        if let Some(max_dur) = self.max_duration {
            if exec.duration.is_none_or(|d| d > max_dur) {
                return false;
            }
        }

        if let Some(after) = self.after {
            if exec.started_at < after {
                return false;
            }
        }

        if let Some(before) = self.before {
            if exec.started_at > before {
                return false;
            }
        }

        if let Some(has_details) = self.has_details {
            if exec.details.is_some() != has_details {
                return false;
            }
        }

        if let Some(ref field) = self.has_detail_field {
            let has_field = exec.details.as_ref().and_then(|d| d.get(field)).is_some();
            if !has_field {
                return false;
            }
        }

        if let Some(expected_code) = self.exit_code {
            if exec.exit_code() != Some(expected_code) {
                return false;
            }
        }

        if let Some(expected_timeout) = self.timed_out {
            if exec.timed_out() != expected_timeout {
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
    #[must_use]
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
            .map_or(Duration::ZERO, |start| start.elapsed());

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
            .map_or(Duration::ZERO, |start| start.elapsed());

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
            .map_or(Duration::ZERO, |start| start.elapsed());

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
            .map_or(Duration::ZERO, |start| start.elapsed());

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
    #[must_use]
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
    #[must_use]
    pub fn recent(&self, count: usize) -> Vec<&ToolExecution> {
        self.executions.iter().rev().take(count).collect()
    }

    /// Search history with filter
    #[must_use]
    pub fn search(&self, filter: &HistoryFilter) -> Vec<&ToolExecution> {
        self.executions
            .iter()
            .rev()
            .filter(|e| filter.matches(e))
            .collect()
    }

    /// Get executions for a specific tool
    #[must_use]
    pub fn for_tool(&self, tool_name: &str) -> Vec<&ToolExecution> {
        self.search(&HistoryFilter::tool(tool_name))
    }

    /// Get an execution by ID
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&ToolExecution> {
        self.executions.iter().find(|e| e.id == id)
    }

    /// Get the most recent execution
    #[must_use]
    pub fn last(&self) -> Option<&ToolExecution> {
        self.executions.back()
    }

    /// Get stats for a specific tool
    #[must_use]
    pub fn tool_stats(&self, tool_name: &str) -> Option<&ToolStats> {
        self.stats.get(tool_name)
    }

    /// Get global stats
    #[must_use]
    pub fn global_stats(&self) -> &ToolStats {
        &self.global_stats
    }

    /// Get all tool stats
    #[must_use]
    pub fn all_stats(&self) -> &std::collections::HashMap<String, ToolStats> {
        &self.stats
    }

    /// Get tools ranked by usage count (descending)
    #[must_use]
    pub fn most_used_tools(&self, limit: usize) -> Vec<(&str, &ToolStats)> {
        let mut ranked: Vec<_> = self.stats.iter().map(|(k, v)| (k.as_str(), v)).collect();
        ranked.sort_by(|a, b| b.1.total.cmp(&a.1.total));
        ranked.truncate(limit);
        ranked
    }

    /// Get tools ranked by average duration (slowest first)
    #[must_use]
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
    #[must_use]
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
    #[must_use]
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
    #[must_use]
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
    #[must_use]
    pub fn total_execution_time(&self) -> Duration {
        self.global_stats.total_duration
    }

    /// Get the total time spent executing tools in milliseconds
    #[must_use]
    pub fn total_execution_time_ms(&self) -> u64 {
        self.global_stats.total_duration_ms()
    }

    /// Export all statistics as JSON
    #[must_use]
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
    #[must_use]
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
    #[must_use]
    pub fn len(&self) -> usize {
        self.executions.len()
    }

    /// Check if empty
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.executions.is_empty()
    }

    /// Get number of in-progress executions
    #[must_use]
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

    /// Compute stats from filtered executions
    /// This creates new stats from scratch based on the filter criteria
    #[must_use]
    pub fn filtered_stats(&self, filter: &HistoryFilter) -> ToolStats {
        let mut stats = ToolStats::default();
        for exec in self.executions.iter().filter(|e| filter.matches(e)) {
            if let Some(duration) = exec.duration {
                stats.record(exec.success, duration);
            }
        }
        stats
    }

    /// Compute per-tool stats from filtered executions
    #[must_use]
    pub fn filtered_stats_by_tool(
        &self,
        filter: &HistoryFilter,
    ) -> std::collections::HashMap<String, ToolStats> {
        let mut stats: std::collections::HashMap<String, ToolStats> =
            std::collections::HashMap::new();
        for exec in self.executions.iter().filter(|e| filter.matches(e)) {
            if let Some(duration) = exec.duration {
                let tool_stats = stats.entry(exec.tool_name.clone()).or_default();
                tool_stats.record(exec.success, duration);
            }
        }
        stats
    }

    /// Get stats for executions within a time range
    #[must_use]
    pub fn stats_in_range(&self, after: SystemTime, before: SystemTime) -> ToolStats {
        let filter = HistoryFilter::default().after(after).before(before);
        self.filtered_stats(&filter)
    }

    /// Get stats for executions in the last N seconds
    #[must_use]
    pub fn stats_last(&self, duration: Duration) -> ToolStats {
        let filter = HistoryFilter::default().within_last(duration);
        self.filtered_stats(&filter)
    }

    /// Get stats for slow executions (above threshold)
    #[must_use]
    pub fn stats_slow_executions(&self, threshold: Duration) -> ToolStats {
        let filter = HistoryFilter::default().min_duration(threshold);
        self.filtered_stats(&filter)
    }

    /// Get stats for fast executions (below threshold)
    #[must_use]
    pub fn stats_fast_executions(&self, threshold: Duration) -> ToolStats {
        let filter = HistoryFilter::default().max_duration(threshold);
        self.filtered_stats(&filter)
    }

    /// Get timed out executions
    #[must_use]
    pub fn timed_out_executions(&self) -> Vec<&ToolExecution> {
        self.search(&HistoryFilter::timed_out_only())
    }

    /// Get executions with specific exit code
    #[must_use]
    pub fn executions_with_exit_code(&self, code: i32) -> Vec<&ToolExecution> {
        self.search(&HistoryFilter::default().with_exit_code(code))
    }

    /// Get executions that have structured details
    #[must_use]
    pub fn executions_with_details(&self) -> Vec<&ToolExecution> {
        self.search(&HistoryFilter::with_details())
    }

    /// Get health report for all tools
    #[must_use]
    pub fn tool_health_report(&self) -> Vec<(&str, f64, bool)> {
        self.stats
            .iter()
            .map(|(name, stats)| {
                let score = stats.health_score();
                let healthy = stats.is_healthy(0.9);
                (name.as_str(), score, healthy)
            })
            .collect()
    }

    /// Get unhealthy tools (low success rate or high variance)
    #[must_use]
    pub fn unhealthy_tools(&self, min_success_rate: f64) -> Vec<(&str, &ToolStats)> {
        self.stats
            .iter()
            .filter(|(_, s)| s.total > 0 && !s.is_healthy(min_success_rate))
            .map(|(k, v)| (k.as_str(), v))
            .collect()
    }

    /// Compare two tools' performance
    #[must_use]
    pub fn compare_tools(&self, tool_a: &str, tool_b: &str) -> Option<f64> {
        match (self.stats.get(tool_a), self.stats.get(tool_b)) {
            (Some(a), Some(b)) => a.relative_performance(b),
            _ => None,
        }
    }

    /// Get overall throughput (executions per second)
    #[must_use]
    pub fn throughput(&self) -> f64 {
        self.global_stats.throughput()
    }

    /// Aggregate stats from multiple tool names
    #[must_use]
    pub fn aggregate_stats(&self, tool_names: &[&str]) -> ToolStats {
        let mut aggregated = ToolStats::default();
        for name in tool_names {
            if let Some(stats) = self.stats.get(*name) {
                aggregated.merge(stats);
            }
        }
        aggregated
    }

    /// Export detailed stats as JSON (with percentiles)
    #[must_use]
    pub fn detailed_stats_json(&self) -> serde_json::Value {
        let tool_stats: serde_json::Map<String, serde_json::Value> = self
            .stats
            .iter()
            .map(|(name, stats)| (name.clone(), stats.to_detailed_json()))
            .collect();

        serde_json::json!({
            "global": self.global_stats.to_detailed_json(),
            "by_tool": tool_stats,
            "total_executions": self.executions.len(),
            "in_progress": self.in_progress.len(),
            "tools_used": self.stats.len(),
            "throughput_per_sec": self.throughput()
        })
    }

    /// Generate a summary report
    #[must_use]
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
#[allow(clippy::float_cmp)]
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
            "size_bytes": 50_000,
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

        exec.complete_with_details(String::new(), Duration::from_millis(10), Some(details));

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
            "duration_ms": 30_000
        });

        exec.fail_with_details(
            "Command timed out after 30_000ms".to_string(),
            Duration::from_millis(30_000),
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

    // ==================== Advanced ToolStats tests ====================

    #[test]
    fn test_tool_stats_min_max_duration() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(50));
        stats.record(true, Duration::from_millis(200));
        stats.record(true, Duration::from_millis(75));

        assert_eq!(stats.min_duration_ms(), Some(50));
        assert_eq!(stats.max_duration_ms(), Some(200));
        assert_eq!(stats.duration_range_ms(), Some(150));
    }

    #[test]
    fn test_tool_stats_min_max_single_record() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));

        assert_eq!(stats.min_duration_ms(), Some(100));
        assert_eq!(stats.max_duration_ms(), Some(100));
        assert_eq!(stats.duration_range_ms(), Some(0));
    }

    #[test]
    fn test_tool_stats_percentile() {
        let mut stats = ToolStats::default();
        // Add 10 durations: 10, 20, 30, ..., 100ms
        for i in 1..=10 {
            stats.record(true, Duration::from_millis(i * 10));
        }

        // P50 should be around 50-60ms
        let p50 = stats.percentile_ms(50).unwrap();
        assert!((50..=60).contains(&p50));

        // P90 should be around 90-100ms
        let p90 = stats.percentile_ms(90).unwrap();
        assert!((90..=100).contains(&p90));

        // P0 should be min
        let p0 = stats.percentile_ms(0).unwrap();
        assert_eq!(p0, 10);

        // P100 should be max
        let p100 = stats.percentile_ms(100).unwrap();
        assert_eq!(p100, 100);
    }

    #[test]
    fn test_tool_stats_percentile_empty() {
        let stats = ToolStats::default();
        assert!(stats.percentile(50).is_none());
        assert!(stats.percentile_ms(50).is_none());
    }

    #[test]
    fn test_tool_stats_std_deviation() {
        let mut stats = ToolStats::default();
        // All same duration = 0 std dev
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(100));

        let std = stats.std_deviation_ms().unwrap();
        assert_eq!(std, 0);
    }

    #[test]
    fn test_tool_stats_std_deviation_varied() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(10));
        stats.record(true, Duration::from_millis(20));
        stats.record(true, Duration::from_millis(30));

        // std dev should be non-zero
        let std = stats.std_deviation_ms().unwrap();
        assert!(std > 0);
    }

    #[test]
    fn test_tool_stats_std_deviation_single() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));

        // Need at least 2 samples for std dev
        assert!(stats.std_deviation().is_none());
    }

    #[test]
    fn test_tool_stats_high_variance() {
        let mut stats = ToolStats::default();
        // High variance: 10ms and 1000ms
        stats.record(true, Duration::from_millis(10));
        stats.record(true, Duration::from_millis(1000));

        assert!(stats.has_high_variance(0.5));
    }

    #[test]
    fn test_tool_stats_low_variance() {
        let mut stats = ToolStats::default();
        // Low variance: all around 100ms
        stats.record(true, Duration::from_millis(98));
        stats.record(true, Duration::from_millis(100));
        stats.record(true, Duration::from_millis(102));

        assert!(!stats.has_high_variance(1.0));
    }

    #[test]
    fn test_tool_stats_throughput() {
        let mut stats = ToolStats::default();
        // 10 executions taking 100ms each = 1 second total = 10 ops/sec
        for _ in 0..10 {
            stats.record(true, Duration::from_millis(100));
        }

        let throughput = stats.throughput();
        assert!((throughput - 10.0).abs() < 0.1);
    }

    #[test]
    fn test_tool_stats_throughput_empty() {
        let stats = ToolStats::default();
        assert_eq!(stats.throughput(), 0.0);
    }

    #[test]
    fn test_tool_stats_relative_performance() {
        let mut fast = ToolStats::default();
        fast.record(true, Duration::from_millis(50));

        let mut slow = ToolStats::default();
        slow.record(true, Duration::from_millis(100));

        // fast is 2x faster than slow
        let perf = fast.relative_performance(&slow).unwrap();
        assert!((perf - 2.0).abs() < 0.01);

        // slow is 0.5x as fast as fast
        let perf2 = slow.relative_performance(&fast).unwrap();
        assert!((perf2 - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_tool_stats_health_score() {
        let mut healthy = ToolStats::default();
        for _ in 0..10 {
            healthy.record(true, Duration::from_millis(100));
        }
        assert!(healthy.health_score() > 0.9);
        assert!(healthy.is_healthy(0.9));

        let mut unhealthy = ToolStats::default();
        for _ in 0..5 {
            unhealthy.record(true, Duration::from_millis(100));
        }
        for _ in 0..5 {
            unhealthy.record(false, Duration::from_millis(100));
        }
        assert!(unhealthy.health_score() < 0.6);
        assert!(!unhealthy.is_healthy(0.9));
    }

    #[test]
    fn test_tool_stats_to_detailed_json() {
        let mut stats = ToolStats::default();
        for i in 1..=10 {
            stats.record(true, Duration::from_millis(i * 10));
        }

        let json = stats.to_detailed_json();

        assert!(json.get("total").is_some());
        assert!(json.get("min_duration_ms").is_some());
        assert!(json.get("max_duration_ms").is_some());
        assert!(json.get("p50_duration_ms").is_some());
        assert!(json.get("p90_duration_ms").is_some());
        assert!(json.get("failure_rate").is_some());
    }

    #[test]
    fn test_tool_stats_merge_with_min_max() {
        let mut stats1 = ToolStats::default();
        stats1.record(true, Duration::from_millis(100));
        stats1.record(true, Duration::from_millis(200));

        let mut stats2 = ToolStats::default();
        stats2.record(true, Duration::from_millis(50));
        stats2.record(true, Duration::from_millis(150));

        stats1.merge(&stats2);

        // Min should be 50, max should be 200
        assert_eq!(stats1.min_duration_ms(), Some(50));
        assert_eq!(stats1.max_duration_ms(), Some(200));
        assert_eq!(stats1.total, 4);
    }

    #[test]
    fn test_tool_stats_with_max_durations() {
        let mut stats = ToolStats::with_max_durations(3);

        for i in 0..10 {
            stats.record(true, Duration::from_millis(i * 10));
        }

        // Should only keep first 3 durations for percentile calculation
        assert_eq!(stats.tracked_durations(), 3);
        // But total count should still be accurate
        assert_eq!(stats.total, 10);
    }

    // ==================== Advanced HistoryFilter tests ====================

    #[test]
    fn test_filter_max_duration() {
        let mut history = ToolHistory::new(100);

        history.start("fast", "read", json!({}));
        std::thread::sleep(Duration::from_millis(1));
        history.complete("fast", "ok".to_string());

        history.start("slow", "read", json!({}));
        std::thread::sleep(Duration::from_millis(10));
        history.complete("slow", "ok".to_string());

        // Filter to only fast executions
        let filter = HistoryFilter::default().max_duration(Duration::from_millis(5));
        let results = history.search(&filter);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "fast");
    }

    #[test]
    fn test_filter_duration_between() {
        let mut history = ToolHistory::new(100);

        for i in 0..5 {
            let id = format!("{}", i);
            history.start(&id, "test", json!({}));
            std::thread::sleep(Duration::from_millis((i + 1) * 2));
            history.complete(&id, "ok".to_string());
        }

        // Filter to middle range
        let filter = HistoryFilter::default()
            .duration_between(Duration::from_millis(3), Duration::from_millis(7));
        let results = history.search(&filter);

        // Should match executions with ~4ms and ~6ms duration
        assert!(!results.is_empty());
    }

    #[test]
    fn test_filter_with_exit_code() {
        let mut history = ToolHistory::new(100);

        history.start("1", "bash", json!({}));
        history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

        history.start("2", "bash", json!({}));
        history.complete_with_details("2", "error".to_string(), Some(json!({"exit_code": 1})));

        history.start("3", "bash", json!({}));
        history.complete_with_details("3", "ok".to_string(), Some(json!({"exit_code": 0})));

        let filter = HistoryFilter::default().with_exit_code(0);
        let results = history.search(&filter);
        assert_eq!(results.len(), 2);

        let filter = HistoryFilter::default().with_exit_code(1);
        let results = history.search(&filter);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_filter_timed_out() {
        let mut history = ToolHistory::new(100);

        history.start("1", "bash", json!({}));
        history.complete_with_details("1", "ok".to_string(), Some(json!({"timed_out": false})));

        history.start("2", "bash", json!({}));
        history.fail_with_details("2", "timeout".to_string(), Some(json!({"timed_out": true})));

        let timed_out = history.timed_out_executions();
        assert_eq!(timed_out.len(), 1);
        assert_eq!(timed_out[0].id, "2");
    }

    #[test]
    fn test_filter_has_details() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({}));
        history.complete("1", "ok".to_string());

        history.start("2", "read", json!({}));
        history.complete_with_details("2", "ok".to_string(), Some(json!({"bytes": 100})));

        let with_details = history.executions_with_details();
        assert_eq!(with_details.len(), 1);
        assert_eq!(with_details[0].id, "2");
    }

    #[test]
    fn test_filter_has_detail_field() {
        let mut history = ToolHistory::new(100);

        history.start("1", "bash", json!({}));
        history.complete_with_details(
            "1",
            "ok".to_string(),
            Some(json!({"exit_code": 0, "command": "ls"})),
        );

        history.start("2", "read", json!({}));
        history.complete_with_details("2", "ok".to_string(), Some(json!({"bytes_read": 100})));

        let filter = HistoryFilter::default().with_detail_field("command");
        let results = history.search(&filter);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "1");
    }

    #[test]
    fn test_filter_time_range() {
        let mut history = ToolHistory::new(100);
        let _before_all = SystemTime::now();

        std::thread::sleep(Duration::from_millis(5));

        history.start("1", "read", json!({}));
        history.complete("1", "ok".to_string());

        let after_first = SystemTime::now();
        std::thread::sleep(Duration::from_millis(5));

        history.start("2", "read", json!({}));
        history.complete("2", "ok".to_string());

        // Filter to only after first
        let filter = HistoryFilter::default().after(after_first);
        let results = history.search(&filter);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "2");

        // Filter to before first completed
        let filter = HistoryFilter::default().before(after_first);
        let results = history.search(&filter);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "1");
    }

    #[test]
    fn test_filter_within_last() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({}));
        history.complete("1", "ok".to_string());

        // This should match since we just added it
        let filter = HistoryFilter::default().within_last(Duration::from_secs(10));
        let results = history.search(&filter);
        assert_eq!(results.len(), 1);
    }

    // ==================== Filtered Stats tests ====================

    #[test]
    fn test_filtered_stats() {
        let history = create_test_history();

        // Get stats for only read tool
        let filter = HistoryFilter::tool("read");
        let stats = history.filtered_stats(&filter);

        assert_eq!(stats.total, 5);
        assert_eq!(stats.successes, 4);
        assert_eq!(stats.failures, 1);
    }

    #[test]
    fn test_filtered_stats_by_tool() {
        let history = create_test_history();

        // Get stats for failures only
        let filter = HistoryFilter::failures();
        let stats_by_tool = history.filtered_stats_by_tool(&filter);

        assert!(stats_by_tool.contains_key("read"));
        assert!(stats_by_tool.contains_key("write"));
        assert!(stats_by_tool.contains_key("bash"));

        // All should have only failures
        for stats in stats_by_tool.values() {
            assert_eq!(stats.successes, 0);
        }
    }

    #[test]
    fn test_stats_last_duration() {
        let mut history = ToolHistory::new(100);

        history.start("1", "read", json!({}));
        history.complete("1", "ok".to_string());

        std::thread::sleep(Duration::from_millis(5));

        history.start("2", "read", json!({}));
        history.complete("2", "ok".to_string());

        // Stats from last 1 second should include both
        let stats = history.stats_last(Duration::from_secs(1));
        assert_eq!(stats.total, 2);
    }

    #[test]
    fn test_stats_slow_executions() {
        let mut history = ToolHistory::new(100);

        // Fast execution
        history.start("fast", "read", json!({}));
        std::thread::sleep(Duration::from_millis(1));
        history.complete("fast", "ok".to_string());

        // Slow execution
        history.start("slow", "read", json!({}));
        std::thread::sleep(Duration::from_millis(10));
        history.complete("slow", "ok".to_string());

        let stats = history.stats_slow_executions(Duration::from_millis(5));
        assert_eq!(stats.total, 1);
    }

    #[test]
    fn test_executions_with_exit_code() {
        let mut history = ToolHistory::new(100);

        history.start("1", "bash", json!({}));
        history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

        history.start("2", "bash", json!({}));
        history.fail_with_details("2", "err".to_string(), Some(json!({"exit_code": 127})));

        let execs = history.executions_with_exit_code(127);
        assert_eq!(execs.len(), 1);
        assert_eq!(execs[0].id, "2");
    }

    // ==================== Tool Health tests ====================

    #[test]
    fn test_tool_health_report() {
        let history = create_test_history();

        let report = history.tool_health_report();
        assert_eq!(report.len(), 3);

        // Find bash - should be unhealthy (100% failure)
        let bash = report.iter().find(|(name, _, _)| *name == "bash");
        assert!(bash.is_some());
        let (_, score, healthy) = bash.unwrap();
        assert!(*score < 0.5);
        assert!(!healthy);
    }

    #[test]
    fn test_unhealthy_tools() {
        let history = create_test_history();

        // With 90% threshold, bash (0% success) should be unhealthy
        let unhealthy = history.unhealthy_tools(0.9);
        assert!(!unhealthy.is_empty());

        let bash = unhealthy.iter().find(|(name, _)| *name == "bash");
        assert!(bash.is_some());
    }

    #[test]
    fn test_compare_tools() {
        let history = create_test_history();

        // Compare read and bash (bash takes longer due to longer sleep)
        let perf = history.compare_tools("read", "bash");
        assert!(perf.is_some());
        // read is faster, so relative performance > 1
        assert!(perf.unwrap() > 1.0);
    }

    #[test]
    fn test_compare_tools_missing() {
        let history = create_test_history();

        let perf = history.compare_tools("read", "nonexistent");
        assert!(perf.is_none());
    }

    // ==================== Aggregation tests ====================

    #[test]
    fn test_aggregate_stats() {
        let history = create_test_history();

        // Aggregate read and write stats
        let aggregated = history.aggregate_stats(&["read", "write"]);

        assert_eq!(aggregated.total, 8); // 5 + 3
        assert_eq!(aggregated.successes, 6); // 4 + 2
        assert_eq!(aggregated.failures, 2); // 1 + 1
    }

    #[test]
    fn test_aggregate_stats_partial() {
        let history = create_test_history();

        // One tool exists, one doesn't
        let aggregated = history.aggregate_stats(&["read", "nonexistent"]);

        assert_eq!(aggregated.total, 5); // Only read's 5
    }

    #[test]
    fn test_throughput() {
        let history = create_test_history();

        let throughput = history.throughput();
        // Should have positive throughput since we have executions
        assert!(throughput > 0.0);
    }

    #[test]
    fn test_detailed_stats_json() {
        let history = create_test_history();

        let json = history.detailed_stats_json();

        assert!(json.get("global").is_some());
        assert!(json.get("by_tool").is_some());
        assert!(json.get("throughput_per_sec").is_some());

        let global = &json["global"];
        assert!(global.get("min_duration_ms").is_some());
        assert!(global.get("max_duration_ms").is_some());
    }

    // ==================== Edge case and stress tests ====================

    #[test]
    fn test_large_history() {
        let mut history = ToolHistory::new(10_000);

        // Add many executions
        for i in 0..1000 {
            let id = format!("{}", i);
            let tool = if i % 3 == 0 {
                "read"
            } else if i % 3 == 1 {
                "write"
            } else {
                "bash"
            };
            history.start(&id, tool, json!({}));
            if i % 5 == 0 {
                history.fail(&id, "error".to_string());
            } else {
                history.complete(&id, "ok".to_string());
            }
        }

        assert_eq!(history.len(), 1000);

        // Stats should be accurate
        let global = history.global_stats();
        assert_eq!(global.total, 1000);
        assert_eq!(global.failures, 200); // Every 5th

        // Rankings should work
        let most_used = history.most_used_tools(10);
        assert!(!most_used.is_empty());
    }

    #[test]
    fn test_concurrent_tool_names() {
        let mut history = ToolHistory::new(100);

        // Same tool name, different outcomes
        for i in 0..10 {
            let id = format!("{}", i);
            history.start(&id, "read", json!({}));
            if i < 5 {
                history.complete(&id, "ok".to_string());
            } else {
                history.fail(&id, "error".to_string());
            }
        }

        let stats = history.tool_stats("read").unwrap();
        assert_eq!(stats.total, 10);
        assert_eq!(stats.successes, 5);
        assert_eq!(stats.failures, 5);
        assert!((stats.success_rate() - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_stats_after_clear() {
        let mut history = create_test_history();

        // Verify we have data
        assert!(!history.is_empty());
        assert!(history.global_stats().total > 0);

        // Clear
        history.clear();

        // Everything should be empty/zero
        assert_eq!(history.len(), 0);
        assert_eq!(history.global_stats().total, 0);
        assert!(history.all_stats().is_empty());
        assert!(history.most_used_tools(10).is_empty());
    }

    #[test]
    fn test_filter_combination() {
        let mut history = ToolHistory::new(100);

        // Add varied executions
        history.start("1", "bash", json!({}));
        history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

        history.start("2", "bash", json!({}));
        history.fail_with_details("2", "err".to_string(), Some(json!({"exit_code": 1})));

        history.start("3", "read", json!({}));
        history.complete_with_details("3", "ok".to_string(), Some(json!({"bytes": 100})));

        // Combine multiple filters: bash + failure + exit code 1
        let filter = HistoryFilter::tool("bash").with_exit_code(1);
        let results = history.search(&filter);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "2");
    }

    #[test]
    fn test_percentile_single_value() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));

        // All percentiles should return the same value
        assert_eq!(stats.percentile_ms(0), Some(100));
        assert_eq!(stats.percentile_ms(50), Some(100));
        assert_eq!(stats.percentile_ms(100), Some(100));
    }

    #[test]
    fn test_stats_serialization_round_trip() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::from_millis(100));
        stats.record(false, Duration::from_millis(50));

        let json = serde_json::to_string(&stats).unwrap();
        let deserialized: ToolStats = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.total, 2);
        assert_eq!(deserialized.successes, 1);
        assert_eq!(deserialized.failures, 1);
        // Note: durations vector is not serialized (skip), so percentiles won't work after deserialize
    }

    #[test]
    fn test_zero_duration_handling() {
        let mut stats = ToolStats::default();
        stats.record(true, Duration::ZERO);
        stats.record(true, Duration::ZERO);

        assert_eq!(stats.avg_duration_ms(), 0);
        assert_eq!(stats.throughput(), 0.0); // Avoid divide by zero
        assert!(!stats.has_high_variance(1.0));
    }
}

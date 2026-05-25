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
        ranked.sort_by_key(|candidate| std::cmp::Reverse(candidate.1.total));
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
        ranked.sort_by(|a, b| {
            b.1.avg_duration()
                .cmp(&a.1.avg_duration())
                .then_with(|| b.1.total_duration.cmp(&a.1.total_duration))
                .then_with(|| a.0.cmp(b.0))
        });
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
        ranked.sort_by(|a, b| {
            a.1.avg_duration()
                .cmp(&b.1.avg_duration())
                .then_with(|| a.1.total_duration.cmp(&b.1.total_duration))
                .then_with(|| a.0.cmp(b.0))
        });
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
        ranked.sort_by_key(|candidate| std::cmp::Reverse(candidate.1.failures));
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
            tool_stats.sort_by_key(|candidate| std::cmp::Reverse(candidate.1.total));

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
mod tests;

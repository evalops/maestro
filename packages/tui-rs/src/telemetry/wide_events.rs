//! Wide Events Implementation
//!
//! Canonical turn event types and the TurnCollector for accumulating
//! context during a turn and emitting a single wide event at completion.

use std::collections::HashMap;
use std::time::Instant;

use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Thinking/reasoning level for the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    #[default]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Max,
    Ultra,
}

impl std::fmt::Display for ThinkingLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => write!(f, "off"),
            Self::Minimal => write!(f, "minimal"),
            Self::Low => write!(f, "low"),
            Self::Medium => write!(f, "medium"),
            Self::High => write!(f, "high"),
            Self::Max => write!(f, "max"),
            Self::Ultra => write!(f, "ultra"),
        }
    }
}

/// Information about a single tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecution {
    pub name: String,
    pub call_id: String,
    pub duration_ms: u64,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_size_bytes: Option<u64>,
}

/// Token usage statistics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<u64>,
}

/// Model information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    pub thinking_level: ThinkingLevel,
}

impl Default for ModelInfo {
    fn default() -> Self {
        Self {
            id: "unknown".to_string(),
            provider: "unknown".to_string(),
            thinking_level: ThinkingLevel::Off,
        }
    }
}

/// Turn completion status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Success,
    Error,
    Aborted,
    RateLimited,
}

impl std::fmt::Display for TurnStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Success => write!(f, "success"),
            Self::Error => write!(f, "error"),
            Self::Aborted => write!(f, "aborted"),
            Self::RateLimited => write!(f, "rate_limited"),
        }
    }
}

/// Reason for abort.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    User,
    Timeout,
    ContextOverflow,
    RateLimit,
}

/// Reason why an event was sampled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SampleReason {
    Always,
    Error,
    Slow,
    FirstTurn,
    Random,
}

/// Sandbox execution mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    Docker,
    Local,
    #[default]
    None,
}

/// Approval mode for tool execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    Auto,
    #[default]
    Prompt,
    Fail,
}

/// Feature flags active during the turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeatureFlags {
    pub safe_mode: bool,
    pub guardian_enabled: bool,
    pub compaction_enabled: bool,
    pub hook_count: u32,
}

/// Error details for failed turns.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ErrorDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Canonical Turn Event - One wide event per agent turn.
///
/// Contains all context needed to debug and analyze any turn without
/// correlating multiple log lines. Designed for high-cardinality querying.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalTurnEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp: String,

    // ─── Identity ───────────────────────────────────────────────────────────
    pub session_id: String,
    pub turn_id: String,
    pub turn_number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,

    // ─── Model Context ──────────────────────────────────────────────────────
    pub model: ModelInfo,

    // ─── Timing ─────────────────────────────────────────────────────────────
    pub total_duration_ms: u64,
    pub llm_duration_ms: u64,
    pub tool_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_wait_ms: Option<u64>,

    // ─── Tool Executions ────────────────────────────────────────────────────
    pub tools: Vec<ToolExecution>,
    pub tool_count: u32,
    pub tool_success_count: u32,
    pub tool_failure_count: u32,

    // ─── Token Economics ────────────────────────────────────────────────────
    pub tokens: TokenUsage,
    pub cost_usd: f64,

    // ─── Business Context ───────────────────────────────────────────────────
    pub sandbox_mode: SandboxMode,
    pub approval_mode: ApprovalMode,
    pub mcp_server_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<String>>,
    pub context_source_count: u32,
    pub message_count: u32,
    pub input_size_bytes: u64,
    pub output_size_bytes: u64,

    // ─── Feature Flags ──────────────────────────────────────────────────────
    pub features: FeatureFlags,

    // ─── Outcome ────────────────────────────────────────────────────────────
    pub status: TurnStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abort_reason: Option<AbortReason>,

    // ─── Sampling Metadata ──────────────────────────────────────────────────
    pub sampled: bool,
    pub sample_reason: SampleReason,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tail Sampling Configuration
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for tail sampling decisions.
#[derive(Debug, Clone)]
pub struct TailSamplingConfig {
    /// Sample rate for successful fast turns (0.0 to 1.0)
    pub success_sample_rate: f64,
    /// Threshold in ms above which a turn is considered "slow"
    pub slow_threshold_ms: u64,
    /// Always sample first N turns of a session
    pub always_sample_first_n: u32,
}

impl Default for TailSamplingConfig {
    fn default() -> Self {
        Self {
            success_sample_rate: 0.05, // 5% of successful fast turns
            slow_threshold_ms: 5000,   // 5 seconds
            always_sample_first_n: 1,  // Always sample first turn
        }
    }
}

impl TailSamplingConfig {
    /// Create config from environment variables.
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(rate) = std::env::var("COMPOSER_WIDE_EVENT_SAMPLE_RATE") {
            if let Ok(r) = rate.parse::<f64>() {
                if (0.0..=1.0).contains(&r) {
                    config.success_sample_rate = r;
                }
            }
        }

        if let Ok(threshold) = std::env::var("COMPOSER_WIDE_EVENT_SLOW_THRESHOLD_MS") {
            if let Ok(t) = threshold.parse::<u64>() {
                config.slow_threshold_ms = t;
            }
        }

        config
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-progress Tool Tracking
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct PendingTool {
    name: String,
    start_time: Instant,
    input_size_bytes: Option<u64>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn Collector
// ─────────────────────────────────────────────────────────────────────────────

/// Collects context during a turn and emits a single wide event at completion.
///
/// Create a new collector at the start of each turn, record events as they
/// happen, then call `complete()` to emit the canonical event.
#[derive(Debug)]
pub struct TurnCollector {
    session_id: String,
    turn_number: u32,
    turn_id: String,
    start_time: Instant,
    sampling_config: TailSamplingConfig,

    // Timing
    llm_start_time: Option<Instant>,
    accumulated_llm_duration_ms: u64,
    queue_start_time: Option<Instant>,

    // Model
    model: ModelInfo,
    trace_id: Option<String>,

    // Tools
    pending_tools: HashMap<String, PendingTool>,
    completed_tools: Vec<ToolExecution>,

    // Context
    sandbox_mode: SandboxMode,
    approval_mode: ApprovalMode,
    mcp_servers: Vec<String>,
    context_source_count: u32,
    message_count: u32,
    input_size_bytes: u64,
    output_size_bytes: u64,
    features: FeatureFlags,
}

impl TurnCollector {
    /// Create a new turn collector.
    pub fn new(
        session_id: impl Into<String>,
        turn_number: u32,
        config: TailSamplingConfig,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_number,
            turn_id: Uuid::new_v4().to_string(),
            start_time: Instant::now(),
            sampling_config: config,
            llm_start_time: None,
            accumulated_llm_duration_ms: 0,
            queue_start_time: None,
            model: ModelInfo::default(),
            trace_id: None,
            pending_tools: HashMap::new(),
            completed_tools: Vec::new(),
            sandbox_mode: SandboxMode::None,
            approval_mode: ApprovalMode::Prompt,
            mcp_servers: Vec::new(),
            context_source_count: 0,
            message_count: 0,
            input_size_bytes: 0,
            output_size_bytes: 0,
            features: FeatureFlags::default(),
        }
    }

    // ─── Setters ──────────────────────────────────────────────────────────────

    pub fn set_model(&mut self, model: ModelInfo) -> &mut Self {
        self.model = model;
        self
    }

    pub fn set_trace_id(&mut self, trace_id: impl Into<String>) -> &mut Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    pub fn set_sandbox_mode(&mut self, mode: SandboxMode) -> &mut Self {
        self.sandbox_mode = mode;
        self
    }

    pub fn set_approval_mode(&mut self, mode: ApprovalMode) -> &mut Self {
        self.approval_mode = mode;
        self
    }

    pub fn set_mcp_servers(&mut self, servers: Vec<String>) -> &mut Self {
        self.mcp_servers = servers;
        self
    }

    pub fn set_context_source_count(&mut self, count: u32) -> &mut Self {
        self.context_source_count = count;
        self
    }

    pub fn set_message_count(&mut self, count: u32) -> &mut Self {
        self.message_count = count;
        self
    }

    pub fn set_input_size(&mut self, bytes: u64) -> &mut Self {
        self.input_size_bytes = bytes;
        self
    }

    pub fn add_output_size(&mut self, bytes: u64) -> &mut Self {
        self.output_size_bytes += bytes;
        self
    }

    pub fn set_features(&mut self, features: FeatureFlags) -> &mut Self {
        self.features = features;
        self
    }

    // ─── Timing ───────────────────────────────────────────────────────────────

    pub fn record_queue_start(&mut self) -> &mut Self {
        self.queue_start_time = Some(Instant::now());
        self
    }

    pub fn record_llm_start(&mut self) -> &mut Self {
        self.llm_start_time = Some(Instant::now());
        self
    }

    pub fn record_llm_end(&mut self) -> &mut Self {
        // Accumulate LLM duration (turns may have multiple LLM calls)
        if let Some(start) = self.llm_start_time.take() {
            self.accumulated_llm_duration_ms += start.elapsed().as_millis() as u64;
        }
        self
    }

    // ─── Tool Recording ───────────────────────────────────────────────────────

    pub fn record_tool_start(
        &mut self,
        name: impl Into<String>,
        call_id: impl Into<String>,
        input_size_bytes: Option<u64>,
    ) -> &mut Self {
        let call_id = call_id.into();
        self.pending_tools.insert(
            call_id,
            PendingTool {
                name: name.into(),
                start_time: Instant::now(),
                input_size_bytes,
            },
        );
        self
    }

    pub fn record_tool_end(
        &mut self,
        call_id: &str,
        success: bool,
        output_size_bytes: Option<u64>,
        error_code: Option<String>,
    ) -> &mut Self {
        if let Some(pending) = self.pending_tools.remove(call_id) {
            let duration_ms = pending.start_time.elapsed().as_millis() as u64;
            self.completed_tools.push(ToolExecution {
                name: pending.name,
                call_id: call_id.to_string(),
                duration_ms,
                success,
                error_code,
                input_size_bytes: pending.input_size_bytes,
                output_size_bytes,
            });
        }
        self
    }

    // ─── Completion ───────────────────────────────────────────────────────────

    /// Complete the turn and emit the canonical event.
    /// Applies tail sampling logic to decide whether to persist.
    pub fn complete(
        self,
        status: TurnStatus,
        tokens: TokenUsage,
        cost_usd: f64,
        error_details: Option<ErrorDetails>,
        abort_reason: Option<AbortReason>,
    ) -> CanonicalTurnEvent {
        let total_duration_ms = self.start_time.elapsed().as_millis() as u64;

        // Use accumulated LLM duration (for multi-call turns)
        let llm_duration_ms = self.accumulated_llm_duration_ms;

        let tool_duration_ms: u64 = self.completed_tools.iter().map(|t| t.duration_ms).sum();

        let queue_wait_ms = self.queue_start_time.map(|queue_start| {
            self.start_time
                .saturating_duration_since(queue_start)
                .as_millis() as u64
        });

        // Apply tail sampling
        let (sampled, sample_reason) = self.should_sample(status, total_duration_ms);

        let tool_count = self.completed_tools.len() as u32;
        let tool_success_count = self.completed_tools.iter().filter(|t| t.success).count() as u32;
        let tool_failure_count = tool_count - tool_success_count;

        CanonicalTurnEvent {
            event_type: "canonical-turn".to_string(),
            timestamp: Utc::now().to_rfc3339(),

            // Identity
            session_id: self.session_id,
            turn_id: self.turn_id,
            turn_number: self.turn_number,
            trace_id: self.trace_id,

            // Model
            model: self.model,

            // Timing
            total_duration_ms,
            llm_duration_ms,
            tool_duration_ms,
            queue_wait_ms,

            // Tools
            tools: self.completed_tools,
            tool_count,
            tool_success_count,
            tool_failure_count,

            // Tokens
            tokens,
            cost_usd,

            // Business context
            sandbox_mode: self.sandbox_mode,
            approval_mode: self.approval_mode,
            mcp_server_count: self.mcp_servers.len() as u32,
            mcp_servers: if self.mcp_servers.is_empty() {
                None
            } else {
                Some(self.mcp_servers)
            },
            context_source_count: self.context_source_count,
            message_count: self.message_count,
            input_size_bytes: self.input_size_bytes,
            output_size_bytes: self.output_size_bytes,

            // Features
            features: self.features,

            // Outcome
            status,
            error_category: error_details.as_ref().and_then(|e| e.category.clone()),
            error_message: error_details.as_ref().and_then(|e| e.message.clone()),
            abort_reason,

            // Sampling
            sampled,
            sample_reason,
        }
    }

    // ─── Sampling Logic ───────────────────────────────────────────────────────

    fn should_sample(&self, status: TurnStatus, total_duration_ms: u64) -> (bool, SampleReason) {
        // Always sample errors
        if status == TurnStatus::Error {
            return (true, SampleReason::Error);
        }

        // Always sample first N turns
        if self.turn_number <= self.sampling_config.always_sample_first_n {
            return (true, SampleReason::FirstTurn);
        }

        // Always sample slow turns
        if total_duration_ms >= self.sampling_config.slow_threshold_ms {
            return (true, SampleReason::Slow);
        }

        // Random sampling for successful fast turns
        let mut rng = rand::rng();
        if rng.random::<f64>() < self.sampling_config.success_sample_rate {
            return (true, SampleReason::Random);
        }

        (false, SampleReason::Random)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_turn_collector_basic() {
        let mut collector = TurnCollector::new("session-1", 1, TailSamplingConfig::default());

        collector.set_model(ModelInfo {
            id: "claude-opus-4-5-20251101".to_string(),
            provider: "anthropic".to_string(),
            thinking_level: ThinkingLevel::Medium,
        });

        collector.record_tool_start("bash", "call-1", Some(100));
        std::thread::sleep(std::time::Duration::from_millis(10));
        collector.record_tool_end("call-1", true, Some(50), None);

        let event = collector.complete(
            TurnStatus::Success,
            TokenUsage {
                input: 1000,
                output: 500,
                ..Default::default()
            },
            0.05,
            None,
            None,
        );

        assert_eq!(event.event_type, "canonical-turn");
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.turn_number, 1);
        assert_eq!(event.tool_count, 1);
        assert_eq!(event.tool_success_count, 1);
        assert!(event.sampled); // First turn is always sampled
        assert_eq!(event.sample_reason, SampleReason::FirstTurn);
    }

    #[test]
    fn test_sampling_error_always_sampled() {
        let collector = TurnCollector::new("session-1", 10, TailSamplingConfig::default());

        let event = collector.complete(
            TurnStatus::Error,
            TokenUsage::default(),
            0.0,
            Some(ErrorDetails {
                category: Some("network".to_string()),
                message: Some("Connection failed".to_string()),
            }),
            None,
        );

        assert!(event.sampled);
        assert_eq!(event.sample_reason, SampleReason::Error);
    }

    #[test]
    fn test_sampling_slow_always_sampled() {
        let config = TailSamplingConfig {
            slow_threshold_ms: 1, // Very low threshold
            ..Default::default()
        };
        let collector = TurnCollector::new("session-1", 10, config);

        // Wait a bit to exceed threshold
        std::thread::sleep(std::time::Duration::from_millis(5));

        let event = collector.complete(TurnStatus::Success, TokenUsage::default(), 0.0, None, None);

        assert!(event.sampled);
        assert_eq!(event.sample_reason, SampleReason::Slow);
    }

    #[test]
    fn test_tool_timing() {
        let mut collector = TurnCollector::new("session-1", 1, TailSamplingConfig::default());

        collector.record_tool_start("read", "call-1", None);
        std::thread::sleep(std::time::Duration::from_millis(20));
        collector.record_tool_end("call-1", true, None, None);

        collector.record_tool_start("write", "call-2", None);
        std::thread::sleep(std::time::Duration::from_millis(10));
        collector.record_tool_end("call-2", false, None, Some("permission_denied".to_string()));

        let event = collector.complete(TurnStatus::Success, TokenUsage::default(), 0.0, None, None);

        assert_eq!(event.tool_count, 2);
        assert_eq!(event.tool_success_count, 1);
        assert_eq!(event.tool_failure_count, 1);
        assert!(event.tool_duration_ms >= 30);
    }

    #[test]
    fn test_serialization() {
        let collector = TurnCollector::new("session-1", 1, TailSamplingConfig::default());
        let event = collector.complete(TurnStatus::Success, TokenUsage::default(), 0.0, None, None);

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"canonical-turn\""));
        assert!(json.contains("\"session_id\":\"session-1\""));
    }
}

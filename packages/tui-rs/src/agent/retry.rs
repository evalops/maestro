//! Retry Logic with Exponential Backoff
//!
//! This module provides intelligent retry handling for transient failures in AI API calls.
//! It implements exponential backoff with jitter to prevent thundering herd problems and
//! respects rate limit headers when available.
//!
//! # Features
//!
//! - **Exponential Backoff**: Delays increase exponentially (1s, 2s, 4s, 8s, ...)
//! - **Jitter**: Random variation prevents synchronized retries across clients
//! - **Rate Limit Awareness**: Extracts and respects `Retry-After` headers
//! - **Configurable Limits**: Max retries, max delay, and budget exhaustion
//! - **Error Classification**: Distinguishes retryable, fatal, and rate-limited errors
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::agent::retry::{RetryPolicy, RetryDecision, ErrorKind};
//!
//! let mut policy = RetryPolicy::default();
//!
//! loop {
//!     match make_api_call().await {
//!         Ok(response) => break response,
//!         Err(e) => {
//!             let kind = ErrorKind::classify(&e.to_string());
//!             match policy.should_retry(kind) {
//!                 RetryDecision::Retry { delay, attempt } => {
//!                     println!("Retrying in {:?} (attempt {})", delay, attempt);
//!                     tokio::time::sleep(delay).await;
//!                 }
//!                 RetryDecision::GiveUp { reason } => {
//!                     return Err(anyhow::anyhow!("Giving up: {}", reason));
//!                 }
//!             }
//!         }
//!     }
//! }
//! ```

use std::time::Duration;

use rand::Rng as _;

/// Configuration for retry behavior
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Maximum number of retry attempts (not including the initial attempt)
    pub max_retries: u32,
    /// Initial delay before first retry
    pub initial_delay: Duration,
    /// Maximum delay between retries (caps exponential growth)
    pub max_delay: Duration,
    /// Multiplier for exponential backoff (typically 2.0)
    pub backoff_multiplier: f64,
    /// Jitter factor (0.0 to 1.0) - adds randomness to delay
    pub jitter_factor: f64,
    /// Whether to respect Retry-After headers when present
    pub respect_retry_after: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            backoff_multiplier: 2.0,
            jitter_factor: 0.25,
            respect_retry_after: true,
        }
    }
}

impl RetryConfig {
    /// Create a config for aggressive retrying (more attempts, shorter delays)
    pub fn aggressive() -> Self {
        Self {
            max_retries: 5,
            initial_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(30),
            backoff_multiplier: 1.5,
            jitter_factor: 0.2,
            respect_retry_after: true,
        }
    }

    /// Create a config for conservative retrying (fewer attempts, longer delays)
    pub fn conservative() -> Self {
        Self {
            max_retries: 2,
            initial_delay: Duration::from_secs(2),
            max_delay: Duration::from_secs(120),
            backoff_multiplier: 3.0,
            jitter_factor: 0.3,
            respect_retry_after: true,
        }
    }

    /// Create a config that never retries
    pub fn no_retry() -> Self {
        Self {
            max_retries: 0,
            ..Default::default()
        }
    }
}

/// Classification of error types for retry decisions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Transient error that may succeed on retry (e.g., network timeout, 5xx errors)
    Transient,
    /// Rate limit exceeded - should wait before retrying
    RateLimited {
        /// Suggested wait time from Retry-After header (if available)
        retry_after: Option<Duration>,
    },
    /// Context overflow - requires compaction, not retry
    ContextOverflow,
    /// Authentication/authorization failure - won't succeed on retry
    AuthFailure,
    /// Invalid request - won't succeed on retry
    InvalidRequest,
    /// Unknown error - default to not retrying
    Unknown,
}

impl ErrorKind {
    /// Classify an error message into an ErrorKind
    pub fn classify(error_message: &str) -> Self {
        let lower = error_message.to_lowercase();

        // Check for rate limiting first (most specific)
        if lower.contains("rate limit")
            || lower.contains("rate_limit")
            || lower.contains("too many requests")
            || lower.contains("429")
        {
            // Try to extract retry-after time from message
            let retry_after = Self::extract_retry_after(&lower);
            return ErrorKind::RateLimited { retry_after };
        }

        // Check for context overflow
        if lower.contains("context_length")
            || lower.contains("context length")
            || lower.contains("maximum context")
            || lower.contains("token limit")
            || lower.contains("too long")
            || lower.contains("max_tokens")
        {
            return ErrorKind::ContextOverflow;
        }

        // Check for auth failures
        if lower.contains("unauthorized")
            || lower.contains("authentication")
            || lower.contains("invalid api key")
            || lower.contains("invalid_api_key")
            || lower.contains("401")
            || lower.contains("403")
        {
            return ErrorKind::AuthFailure;
        }

        // Check for invalid requests
        if lower.contains("invalid request")
            || lower.contains("bad request")
            || lower.contains("malformed")
            || lower.contains("400")
        {
            return ErrorKind::InvalidRequest;
        }

        // Check for transient errors
        if lower.contains("overloaded")
            || lower.contains("500")
            || lower.contains("502")
            || lower.contains("503")
            || lower.contains("504")
            || lower.contains("service unavailable")
            || lower.contains("server error")
            || lower.contains("internal error")
            || lower.contains("temporarily")
            || lower.contains("try again")
            || lower.contains("timeout")
            || lower.contains("connection")
            || lower.contains("network")
        {
            return ErrorKind::Transient;
        }

        ErrorKind::Unknown
    }

    /// Extract retry-after duration from error message (if present)
    fn extract_retry_after(message: &str) -> Option<Duration> {
        // Common patterns: "retry after 30 seconds", "retry-after: 30", "wait 1.5 minutes"

        // Pattern: "retry after X seconds"
        if let Some(pos) = message.find("retry after") {
            let after = &message[pos + 11..];
            if let Some(secs) = Self::parse_duration_from_start(after) {
                return Some(secs);
            }
        }

        // Pattern: "retry-after: X" or "retry_after: X"
        if let Some(pos) = message.find("retry-after") {
            let after = &message[pos + 12..];
            if let Some(secs) = Self::parse_duration_from_start(after) {
                return Some(secs);
            }
        }
        if let Some(pos) = message.find("retry_after") {
            let after = &message[pos + 12..];
            if let Some(secs) = Self::parse_duration_from_start(after) {
                return Some(secs);
            }
        }

        // Pattern: "wait X seconds/minutes"
        if let Some(pos) = message.find("wait") {
            let after = &message[pos + 4..];
            if let Some(secs) = Self::parse_duration_from_start(after) {
                return Some(secs);
            }
        }

        None
    }

    /// Parse a duration from the start of a string (e.g., "30 seconds", "1.5 minutes")
    fn parse_duration_from_start(s: &str) -> Option<Duration> {
        let s = s.trim_start_matches(|c: char| !c.is_ascii_digit());

        // Find the number
        let num_end = s.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(s.len());
        let num_str = &s[..num_end];
        let num: f64 = num_str.parse().ok()?;

        // Check for unit
        let rest = s[num_end..].trim();
        let multiplier = if rest.starts_with("minute") || rest.starts_with("min") {
            60.0
        } else if rest.starts_with("hour") || rest.starts_with("hr") {
            3600.0
        } else {
            1.0 // default to seconds
        };

        Some(Duration::from_secs_f64(num * multiplier))
    }

    /// Check if this error kind is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(self, ErrorKind::Transient | ErrorKind::RateLimited { .. })
    }
}

/// Decision about whether to retry
#[derive(Debug, Clone)]
pub enum RetryDecision {
    /// Retry after the specified delay
    Retry {
        /// How long to wait before retrying
        delay: Duration,
        /// Which attempt this will be (1-indexed)
        attempt: u32,
        /// Reason for retrying (for logging/display)
        reason: String,
    },
    /// Stop retrying and give up
    GiveUp {
        /// Reason for giving up
        reason: String,
    },
}

/// Retry policy that tracks state across retry attempts
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Configuration
    config: RetryConfig,
    /// Current attempt number (0 = initial attempt, 1 = first retry, etc.)
    current_attempt: u32,
    /// Total delay accumulated across all retries
    total_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::new(RetryConfig::default())
    }
}

impl RetryPolicy {
    /// Create a new retry policy with the given configuration
    pub fn new(config: RetryConfig) -> Self {
        Self {
            config,
            current_attempt: 0,
            total_delay: Duration::ZERO,
        }
    }

    /// Create a retry policy with default configuration
    pub fn with_defaults() -> Self {
        Self::default()
    }

    /// Reset the policy for a new request
    pub fn reset(&mut self) {
        self.current_attempt = 0;
        self.total_delay = Duration::ZERO;
    }

    /// Get the current attempt number (0 = initial, 1+ = retries)
    pub fn current_attempt(&self) -> u32 {
        self.current_attempt
    }

    /// Get the total delay accumulated across all retries
    pub fn total_delay(&self) -> Duration {
        self.total_delay
    }

    /// Determine whether to retry based on the error kind
    pub fn should_retry(&mut self, error_kind: ErrorKind) -> RetryDecision {
        // Check if error is retryable at all
        if !error_kind.is_retryable() {
            return RetryDecision::GiveUp {
                reason: match error_kind {
                    ErrorKind::ContextOverflow => {
                        "Context overflow - compaction required".to_string()
                    }
                    ErrorKind::AuthFailure => "Authentication failed - check API key".to_string(),
                    ErrorKind::InvalidRequest => "Invalid request - won't succeed on retry".to_string(),
                    ErrorKind::Unknown => "Unknown error - not retrying".to_string(),
                    _ => "Error is not retryable".to_string(),
                },
            };
        }

        // Check if we've exhausted retries
        if self.current_attempt >= self.config.max_retries {
            return RetryDecision::GiveUp {
                reason: format!(
                    "Exhausted {} retry attempts",
                    self.config.max_retries
                ),
            };
        }

        // Calculate delay
        let delay = self.calculate_delay(error_kind);

        // Update state
        self.current_attempt += 1;
        self.total_delay += delay;

        let reason = match error_kind {
            ErrorKind::RateLimited { .. } => "Rate limited by API".to_string(),
            ErrorKind::Transient => "Transient error, retrying".to_string(),
            _ => "Retrying".to_string(),
        };

        RetryDecision::Retry {
            delay,
            attempt: self.current_attempt,
            reason,
        }
    }

    /// Calculate the delay for the current retry attempt
    fn calculate_delay(&self, error_kind: ErrorKind) -> Duration {
        // If rate limited with retry-after, use that
        if let ErrorKind::RateLimited { retry_after: Some(suggested) } = error_kind {
            if self.config.respect_retry_after {
                // Still apply max_delay cap
                return suggested.min(self.config.max_delay);
            }
        }

        // Calculate exponential backoff
        let base_delay = self.config.initial_delay.as_secs_f64()
            * self.config.backoff_multiplier.powi(self.current_attempt as i32);

        // Apply max delay cap
        let capped_delay = base_delay.min(self.config.max_delay.as_secs_f64());

        // Apply jitter
        let jittered_delay = if self.config.jitter_factor > 0.0 {
            let mut rng = rand::rng();
            let jitter_range = capped_delay * self.config.jitter_factor;
            let jitter = rng.random_range(-jitter_range..=jitter_range);
            (capped_delay + jitter).max(0.1) // Ensure at least 100ms
        } else {
            capped_delay
        };

        Duration::from_secs_f64(jittered_delay)
    }

    /// Create a human-readable status message for the current retry state
    pub fn status_message(&self) -> String {
        if self.current_attempt == 0 {
            "Initial request".to_string()
        } else {
            format!(
                "Retry {}/{} (total wait: {:.1}s)",
                self.current_attempt,
                self.config.max_retries,
                self.total_delay.as_secs_f64()
            )
        }
    }
}

/// Helper to execute a future with retry logic
pub async fn with_retry<F, Fut, T, E>(
    mut policy: RetryPolicy,
    mut operation: F,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let error_kind = ErrorKind::classify(&e.to_string());
                match policy.should_retry(error_kind) {
                    RetryDecision::Retry { delay, .. } => {
                        tokio::time::sleep(delay).await;
                    }
                    RetryDecision::GiveUp { .. } => {
                        return Err(e);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_kind_classify_rate_limit() {
        let kind = ErrorKind::classify("Error 429: Rate limit exceeded");
        assert!(matches!(kind, ErrorKind::RateLimited { .. }));

        let kind = ErrorKind::classify("Too many requests, slow down");
        assert!(matches!(kind, ErrorKind::RateLimited { .. }));
    }

    #[test]
    fn test_error_kind_classify_transient() {
        let kind = ErrorKind::classify("503 Service Unavailable");
        assert_eq!(kind, ErrorKind::Transient);

        let kind = ErrorKind::classify("Internal server error");
        assert_eq!(kind, ErrorKind::Transient);

        let kind = ErrorKind::classify("Connection timeout");
        assert_eq!(kind, ErrorKind::Transient);

        let kind = ErrorKind::classify("API is overloaded");
        assert_eq!(kind, ErrorKind::Transient);
    }

    #[test]
    fn test_error_kind_classify_context_overflow() {
        let kind = ErrorKind::classify("context_length_exceeded");
        assert_eq!(kind, ErrorKind::ContextOverflow);

        let kind = ErrorKind::classify("Maximum context length exceeded");
        assert_eq!(kind, ErrorKind::ContextOverflow);
    }

    #[test]
    fn test_error_kind_classify_auth() {
        let kind = ErrorKind::classify("401 Unauthorized");
        assert_eq!(kind, ErrorKind::AuthFailure);

        let kind = ErrorKind::classify("Invalid API key provided");
        assert_eq!(kind, ErrorKind::AuthFailure);
    }

    #[test]
    fn test_error_kind_classify_invalid_request() {
        let kind = ErrorKind::classify("400 Bad Request");
        assert_eq!(kind, ErrorKind::InvalidRequest);

        let kind = ErrorKind::classify("Malformed JSON in request");
        assert_eq!(kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn test_error_kind_is_retryable() {
        assert!(ErrorKind::Transient.is_retryable());
        assert!(ErrorKind::RateLimited { retry_after: None }.is_retryable());
        assert!(!ErrorKind::ContextOverflow.is_retryable());
        assert!(!ErrorKind::AuthFailure.is_retryable());
        assert!(!ErrorKind::InvalidRequest.is_retryable());
        assert!(!ErrorKind::Unknown.is_retryable());
    }

    #[test]
    fn test_extract_retry_after_seconds() {
        let kind = ErrorKind::classify("Rate limit exceeded, retry after 30 seconds");
        if let ErrorKind::RateLimited { retry_after } = kind {
            assert_eq!(retry_after, Some(Duration::from_secs(30)));
        } else {
            panic!("Expected RateLimited");
        }
    }

    #[test]
    fn test_extract_retry_after_minutes() {
        let kind = ErrorKind::classify("Rate limit exceeded, please wait 2 minutes");
        if let ErrorKind::RateLimited { retry_after } = kind {
            assert_eq!(retry_after, Some(Duration::from_secs(120)));
        } else {
            panic!("Expected RateLimited");
        }
    }

    #[test]
    fn test_retry_policy_exhausted() {
        let config = RetryConfig {
            max_retries: 2,
            ..Default::default()
        };
        let mut policy = RetryPolicy::new(config);

        // First retry
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::Retry { attempt: 1, .. }));

        // Second retry
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::Retry { attempt: 2, .. }));

        // Should give up now
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::GiveUp { .. }));
    }

    #[test]
    fn test_retry_policy_non_retryable() {
        let mut policy = RetryPolicy::default();

        // Auth failure should not retry
        let decision = policy.should_retry(ErrorKind::AuthFailure);
        assert!(matches!(decision, RetryDecision::GiveUp { .. }));

        // Context overflow should not retry
        let decision = policy.should_retry(ErrorKind::ContextOverflow);
        assert!(matches!(decision, RetryDecision::GiveUp { .. }));
    }

    #[test]
    fn test_retry_policy_reset() {
        let config = RetryConfig {
            max_retries: 1,
            ..Default::default()
        };
        let mut policy = RetryPolicy::new(config);

        // Use up the retry
        let _ = policy.should_retry(ErrorKind::Transient);
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::GiveUp { .. }));

        // Reset
        policy.reset();

        // Should be able to retry again
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::Retry { .. }));
    }

    #[test]
    fn test_retry_policy_respects_retry_after() {
        let config = RetryConfig {
            respect_retry_after: true,
            max_delay: Duration::from_secs(120),
            ..Default::default()
        };
        let mut policy = RetryPolicy::new(config);

        let error_kind = ErrorKind::RateLimited {
            retry_after: Some(Duration::from_secs(45)),
        };
        let decision = policy.should_retry(error_kind);

        if let RetryDecision::Retry { delay, .. } = decision {
            // Should use the suggested 45 seconds (not exponential backoff)
            assert_eq!(delay, Duration::from_secs(45));
        } else {
            panic!("Expected Retry decision");
        }
    }

    #[test]
    fn test_retry_policy_caps_retry_after() {
        let config = RetryConfig {
            respect_retry_after: true,
            max_delay: Duration::from_secs(30),
            ..Default::default()
        };
        let mut policy = RetryPolicy::new(config);

        let error_kind = ErrorKind::RateLimited {
            retry_after: Some(Duration::from_secs(120)),
        };
        let decision = policy.should_retry(error_kind);

        if let RetryDecision::Retry { delay, .. } = decision {
            // Should cap at max_delay (30s) even though retry-after said 120s
            assert_eq!(delay, Duration::from_secs(30));
        } else {
            panic!("Expected Retry decision");
        }
    }

    #[test]
    fn test_retry_policy_exponential_backoff() {
        let config = RetryConfig {
            max_retries: 5,
            initial_delay: Duration::from_secs(1),
            backoff_multiplier: 2.0,
            jitter_factor: 0.0, // No jitter for deterministic test
            max_delay: Duration::from_secs(60),
            respect_retry_after: true,
        };
        let mut policy = RetryPolicy::new(config);

        // First retry: 1s
        if let RetryDecision::Retry { delay, .. } = policy.should_retry(ErrorKind::Transient) {
            assert_eq!(delay, Duration::from_secs(1));
        }

        // Second retry: 2s
        if let RetryDecision::Retry { delay, .. } = policy.should_retry(ErrorKind::Transient) {
            assert_eq!(delay, Duration::from_secs(2));
        }

        // Third retry: 4s
        if let RetryDecision::Retry { delay, .. } = policy.should_retry(ErrorKind::Transient) {
            assert_eq!(delay, Duration::from_secs(4));
        }
    }

    #[test]
    fn test_retry_config_presets() {
        let aggressive = RetryConfig::aggressive();
        assert_eq!(aggressive.max_retries, 5);
        assert!(aggressive.initial_delay < Duration::from_secs(1));

        let conservative = RetryConfig::conservative();
        assert_eq!(conservative.max_retries, 2);
        assert!(conservative.initial_delay >= Duration::from_secs(2));

        let no_retry = RetryConfig::no_retry();
        assert_eq!(no_retry.max_retries, 0);
    }

    #[test]
    fn test_status_message() {
        let mut policy = RetryPolicy::default();
        assert_eq!(policy.status_message(), "Initial request");

        let _ = policy.should_retry(ErrorKind::Transient);
        assert!(policy.status_message().contains("Retry 1/3"));
    }

    #[test]
    fn test_no_retry_config() {
        let mut policy = RetryPolicy::new(RetryConfig::no_retry());

        // Should immediately give up
        let decision = policy.should_retry(ErrorKind::Transient);
        assert!(matches!(decision, RetryDecision::GiveUp { .. }));
    }
}

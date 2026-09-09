//! Host configuration values shared with the terminal application.
use serde::{Deserialize, Serialize};

/// Conversation output detail, combining turn summaries and tool previews.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputDetail {
    /// Summarize tool activity per turn, with individual turns expandable.
    Summary,
    /// Show short tool previews, with individual results expandable.
    #[default]
    Compact,
    /// Show full tool output by default.
    Expanded,
}

impl OutputDetail {
    /// Stable value used in settings and persisted preferences.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Compact => "compact",
            Self::Expanded => "expanded",
        }
    }

    /// Parse a settings value.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "summary" => Some(Self::Summary),
            "compact" => Some(Self::Compact),
            "expanded" => Some(Self::Expanded),
            _ => None,
        }
    }
}

/// Approval mode for tool execution.
///
/// Controls how strictly the user must approve tool calls. Higher trust
/// means faster interaction but more risk from malicious commands.
///
/// # Rust Concept: Default Trait
///
/// `#[default]` on a variant makes it the default when calling
/// `ApprovalMode::default()`. This is used when creating new state
/// without explicit configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApprovalMode {
    /// Auto-approve ALL tool calls without asking.
    /// Fast but dangerous - a malicious prompt could run `rm -rf /`.
    /// Only use when you fully trust the conversation.
    ///
    /// The single exception: a `bypass_sandbox: true` bash call still asks,
    /// because waiving the native sandbox must always be an explicit human
    /// decision (see `ToolExecutor::requires_sandbox_bypass_approval`).
    Yolo,

    /// Approve based on tool/command risk (default).
    /// Safe commands (ls, git status) run automatically.
    /// Risky commands (rm, sudo) require approval.
    #[default]
    Selective,

    /// Require approval for ALL tool calls.
    /// Safest mode - nothing runs without your OK.
    /// Slower but maximum control.
    Safe,
}

impl ApprovalMode {
    /// Get human-readable label for display in the UI.
    ///
    /// # Rust Concept: `&'static str`
    ///
    /// Returning `&'static str` means we return a reference to a string
    /// that lives forever (it's compiled into the binary). This is more
    /// efficient than returning `String` because there's no allocation.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            ApprovalMode::Yolo => "YOLO (auto-approve all)",
            ApprovalMode::Selective => "Selective (approve risky)",
            ApprovalMode::Safe => "Safe (approve all)",
        }
    }

    /// Parse approval mode from a string.
    ///
    /// Accepts various aliases for user convenience.
    ///
    /// # Returns
    ///
    /// `Some(mode)` if the string is recognized, `None` otherwise.
    ///
    /// # Rust Concept: Returning Option
    ///
    /// Rather than throwing an exception for invalid input, we return
    /// `Option<Self>`. The caller must handle both cases, which the
    /// compiler enforces. This prevents runtime crashes from unhandled
    /// invalid input.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        // Convert to lowercase for case-insensitive matching
        match s.to_lowercase().as_str() {
            "yolo" | "trust" | "always-approve" | "always_approve" | "alwaysapprove" => {
                Some(ApprovalMode::Yolo)
            }
            // "auto" ≈ Grok auto (safe tools free, risky may prompt)
            "auto" | "selective" | "default" | "normal" => Some(ApprovalMode::Selective),
            "safe" | "ask" | "always" | "paranoid" => Some(ApprovalMode::Safe),
            _ => None, // Unknown mode - return None, not an error
        }
    }

    /// Cycle to the next mode (for keyboard shortcuts).
    ///
    /// Creates a circular cycle: Yolo -> Selective -> Safe -> Yolo
    ///
    /// # Rust Concept: `&self` vs `self`
    ///
    /// Taking `&self` (borrowed reference) means we don't consume the value.
    /// We can call this method and still use the original value afterward.
    /// Taking `self` (owned) would consume the value.
    #[must_use]
    pub fn next(&self) -> Self {
        match self {
            ApprovalMode::Yolo => ApprovalMode::Selective,
            ApprovalMode::Selective => ApprovalMode::Safe,
            ApprovalMode::Safe => ApprovalMode::Yolo,
        }
    }
}

/// Queue mode for prompts while the agent is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueMode {
    /// Allow queueing multiple prompts while running
    #[default]
    All,
    /// Only allow one-at-a-time (no queueing while running)
    One,
}

impl QueueMode {
    /// Human-readable label for display in the UI.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            QueueMode::All => "all (queue while running)",
            QueueMode::One => "one-at-a-time (pause while running)",
        }
    }

    /// Short label for compact UI badges.
    #[must_use]
    pub fn short_label(&self) -> &'static str {
        match self {
            QueueMode::All => "all",
            QueueMode::One => "one",
        }
    }

    /// Parse a queue mode from user input.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "all" => Some(QueueMode::All),
            "one" | "single" => Some(QueueMode::One),
            _ => None,
        }
    }

    /// Whether queueing is allowed under this mode.
    #[must_use]
    pub fn allows_queue(&self) -> bool {
        matches!(self, QueueMode::All)
    }
}

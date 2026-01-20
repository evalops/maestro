//! Safety and Security Module
//!
//! This module implements security controls for the Composer agent:
//!
//! - **Action Firewall**: Blocks or requires approval for dangerous operations
//! - **Dangerous Patterns**: Regex-based detection of malicious commands
//! - **Bash Analysis**: Parse and analyze shell commands for safety
//! - **Path Containment**: Ensure operations stay within safe directories
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐
//! │   Tool Call     │
//! └────────┬────────┘
//!          │
//!          ▼
//! ┌─────────────────┐
//! │ Action Firewall │──► Block / Require Approval / Allow
//! │                 │
//! │ ┌─────────────┐ │
//! │ │  Dangerous  │ │ Regex patterns for malicious commands
//! │ │  Patterns   │ │
//! │ └─────────────┘ │
//! │                 │
//! │ ┌─────────────┐ │
//! │ │    Bash     │ │ Command parsing and analysis
//! │ │  Analyzer   │ │
//! │ └─────────────┘ │
//! │                 │
//! │ ┌─────────────┐ │
//! │ │    Path     │ │ Workspace containment checks
//! │ │ Containment │ │
//! │ └─────────────┘ │
//! └─────────────────┘
//! ```
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::safety::{ActionFirewall, FirewallVerdict};
//!
//! let firewall = ActionFirewall::new("/workspace");
//!
//! // Check a bash command
//! let verdict = firewall.check_bash("rm -rf /");
//! assert!(matches!(verdict, FirewallVerdict::Block { .. }));
//!
//! // Check a file write
//! let verdict = firewall.check_file_write("/etc/passwd", "content");
//! assert!(matches!(verdict, FirewallVerdict::Block { .. }));
//! ```

mod bash_analyzer;
mod dangerous_patterns;
mod firewall;
mod path_containment;
mod policy;
mod safe_mode;
mod workflow_state;

#[cfg(test)]
mod integration_tests;

pub use bash_analyzer::{
    analyze_bash_command, is_dangerous, is_likely_safe, BashAnalysis, CommandRisk,
};
pub use dangerous_patterns::{
    check_dangerous_patterns, has_high_severity_pattern, most_severe_match, DangerousPattern,
    PatternMatch, Severity,
};
pub use firewall::{ActionFirewall, FirewallContext, FirewallVerdict};
pub(crate) use path_containment::{expand_tilde, is_tilde_path};
pub use path_containment::{
    has_path_traversal, is_path_contained, is_system_path, PathContainment,
};
pub use policy::{
    check_model_allowed, check_path_allowed, check_session_limits, get_policy_limits,
};
pub use safe_mode::{
    is_safe_mode_enabled, require_plan, run_validators, run_validators_with_diagnostics,
    set_plan_satisfied, ValidatorResult,
};
pub use workflow_state::{
    apply_workflow_state_hooks, has_tool_tags, is_human_facing_tool, is_workflow_tracked_tool,
    looks_like_egress, ToolEgress, ToolTag, WorkflowStateSnapshot, WorkflowStateTracker,
};

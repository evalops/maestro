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

#[cfg(test)]
mod integration_tests;

pub use bash_analyzer::{analyze_bash_command, BashAnalysis, CommandRisk};
pub use dangerous_patterns::{check_dangerous_patterns, DangerousPattern, PatternMatch};
pub use firewall::{ActionFirewall, FirewallVerdict};
pub use path_containment::{is_path_contained, PathContainment};

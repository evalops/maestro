//! Tool-name matching for hook definitions.
//!
//! A hook's `tools` list holds regular expressions, not literal names. Claude
//! Code's `hooks.json` uses regex matchers (`Write.*`, `Notebook.*`), and
//! before this module Maestro compared each entry with
//! `eq_ignore_ascii_case`, so `Write.*` matched nothing and never said so.
//!
//! Matchers are compiled at config-load time and report compile errors instead
//! of silently dropping the entry.
//!
//! Two deliberate differences from that reference:
//!
//! - Patterns are anchored (`^(?:...)$`). Unanchored matching would make the
//!   existing literal entry `Write` also
//!   match `WriteFile` and quietly widen every hook already configured with
//!   plain tool names.
//! - Matching is ASCII-case-insensitive, preserving the previous
//!   `eq_ignore_ascii_case` behavior for literal names.

use anyhow::{Context, Result};
use regex::Regex;

/// A compiled `tools` list.
///
/// An empty list matches every tool, which is how "no matcher" and `"*"` are
/// represented after [`crate::hooks::config`] parsing.
#[derive(Debug, Clone, Default)]
pub struct ToolMatcher {
    patterns: Vec<Regex>,
}

impl ToolMatcher {
    /// Compile every entry of a hook's `tools` list.
    ///
    /// # Errors
    ///
    /// Returns the first pattern that is not a valid regular expression, with
    /// the offending pattern and the compile error in the message.
    pub fn compile(tools: &[String]) -> Result<Self> {
        let patterns = tools
            .iter()
            .map(|pattern| compile_tool_pattern(pattern))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { patterns })
    }

    /// Whether `tool_name` is selected by this matcher.
    #[must_use]
    pub fn matches(&self, tool_name: &str) -> bool {
        self.patterns.is_empty()
            || self
                .patterns
                .iter()
                .any(|pattern| pattern.is_match(tool_name))
    }

    /// Whether the matcher selects every tool.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }
}

/// Compile one `tools` entry into an anchored, case-insensitive regex.
///
/// # Errors
///
/// Returns an error naming the pattern when it does not compile.
pub fn compile_tool_pattern(pattern: &str) -> Result<Regex> {
    Regex::new(&format!("(?i)^(?:{pattern})$"))
        .with_context(|| format!("hook tool matcher \"{pattern}\" is not a valid regex"))
}

/// Compile a hook's `tools` list, matching everything when it does not compile.
///
/// Configuration load already rejects an uncompilable matcher, so this branch
/// is only reachable for a hook constructed in-process. Widening to "matches
/// every tool" keeps a `PreToolUse` policy hook running rather than silently
/// disabling it.
#[must_use]
pub fn matcher_or_match_all(tools: &[String]) -> ToolMatcher {
    ToolMatcher::compile(tools).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_list_matches_every_tool() {
        let matcher = ToolMatcher::compile(&[]).unwrap();
        assert!(matcher.is_empty());
        assert!(matcher.matches("Bash"));
    }

    #[test]
    fn literal_name_matches_case_insensitively_and_exactly() {
        let matcher = ToolMatcher::compile(&["Write".to_string()]).unwrap();
        assert!(matcher.matches("Write"));
        assert!(matcher.matches("write"));
        assert!(!matcher.matches("WriteFile"));
        assert!(!matcher.matches("OverWrite"));
    }

    #[test]
    fn wildcard_pattern_matches_prefixed_tools() {
        let matcher = ToolMatcher::compile(&["Write.*".to_string()]).unwrap();
        assert!(matcher.matches("Write"));
        assert!(matcher.matches("WriteFile"));
        assert!(!matcher.matches("Read"));
    }

    #[test]
    fn alternation_matches_either_branch() {
        let matcher = ToolMatcher::compile(&["Write|Edit".to_string()]).unwrap();
        assert!(matcher.matches("Write"));
        assert!(matcher.matches("Edit"));
        assert!(!matcher.matches("Bash"));
    }

    #[test]
    fn malformed_regex_is_reported_with_the_pattern() {
        let error = ToolMatcher::compile(&["Write(".to_string()])
            .expect_err("an unbalanced group must not compile");
        let message = format!("{error:#}");
        assert!(message.contains("Write("), "{message}");
        assert!(message.contains("not a valid regex"), "{message}");
    }
}

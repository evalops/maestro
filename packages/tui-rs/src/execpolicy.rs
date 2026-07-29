//! Execution Policy System - Pattern-based command approval policies.
//!
//! This module implements a security system for controlling which shell commands an AI
//! agent can execute without user approval. It's ported from OpenAI Codex (MIT License):
//! https://github.com/openai/codex/tree/main/codex-rs/execpolicy
//!
//! # Policy Files
//!
//! Policies are defined in `.composer/execpolicy` files using a Starlark-like syntax:
//!
//! ```starlark
//! prefix_rule(
//!     pattern=["git", "status"],
//!     decision="allow",
//! )
//!
//! prefix_rule(
//!     pattern=["git", ["push", "fetch"]],
//!     decision="prompt",
//! )
//! ```
//!
//! # Policy Locations
//!
//! Policies are loaded from two locations in order:
//! 1. Global: `~/.composer/execpolicy`
//! 2. Project: `<workspace>/.composer/execpolicy` (overrides global)
//!
//! # Decision Types
//!
//! - `allow`: Command executes without prompting (e.g., read-only operations)
//! - `prompt`: User must approve before execution (e.g., destructive operations)
//! - `forbidden`: Command is never allowed (e.g., `rm -rf /`)
//!
//! # Pattern Matching
//!
//! Patterns are prefix-based, matching the start of the command:
//! - `["git", "status"]` matches `git status` and `git status --short`
//! - `["git", ["push", "pull"]]` matches `git push` or `git pull` (alternatives)
//!
//! # External Crates
//!
//! - **regex**: For parsing policy files (not for command matching)
//! - **serde**: For serializing evaluation results for IPC
//! - **once_cell**: For lazy policy loading and caching
//!
//! # ⚠️ NOT WIRED INTO THE APPROVAL PATH -- DO NOT CONNECT AS WRITTEN ⚠️
//!
//! This module is **not** consulted by the live tool-approval flow
//! (`components::approval`, `tools::registry::ToolExecutor`,
//! `safety::firewall`). Its only production caller is
//! `import_claude_cli`, which uses [`parse_policy`]/[`render_prefix_rule`]
//! purely to *migrate* Claude CLI permission rules into a `.composer/execpolicy`
//! file for potential future use -- it never reads that file back to make a
//! live approval decision. `tests/trace_replay.rs` also exercises
//! [`Policy::check`] directly as a fixture harness, not through any runtime
//! path.
//!
//! **Do not wire this up as-is.** [`load_policy`] reads
//! `<workspace>/.composer/execpolicy` -- a path fully controlled by the
//! repository being opened -- and honors any `decision="allow"` rule it
//! finds there with no workspace-trust gate (contrast with
//! `config::workspace_trusted_in_global_config`, which every other
//! repo-controlled load path in this crate is gated on, see
//! `tools::registry` (MCP servers)/`tools::inline`/`hooks::config`/
//! `skills::loader`/`plugins::discovery`). If this module is connected to
//! the approval path
//! exactly as written, a hostile repository can drop an `execpolicy` file
//! that self-declares its own dangerous commands `allow`ed, producing an
//! instant, repository-controlled auto-approve bypass -- worse than having
//! no execpolicy feature at all.
//!
//! There is also a known correctness bug that would make any such bypass
//! broader than intended: [`parse_policy`] silently degrades nested
//! alternative patterns (e.g. `pattern=["git", ["push", "fetch"]]`) to a
//! bare prefix (`["git"]`), so a rule meant to scope `allow`/`prompt` to one
//! subcommand actually matches the whole command family. See
//! <https://github.com/evalops/maestro-internal/issues/3091>.
//!
//! Before wiring this module into any live decision path: (1) fix #3091,
//! and (2) gate `load_policy`'s project-level file read on
//! `config::workspace_trusted_in_global_config`, the same way every other
//! repo-controlled loader in this crate is gated.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{LazyLock, OnceLock};

/// Decision for a command execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Prompt,
    Forbidden,
}

impl Decision {
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "prompt" => Some(Self::Prompt),
            "forbidden" => Some(Self::Forbidden),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Prompt => "prompt",
            Self::Forbidden => "forbidden",
        }
    }
}

/// Pattern token - either a single string or alternatives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternToken {
    Single(String),
    Alts(Vec<String>),
}

impl PatternToken {
    fn matches(&self, token: &str) -> bool {
        match self {
            Self::Single(s) => s == token,
            Self::Alts(alts) => alts.iter().any(|s| s == token),
        }
    }

    #[must_use]
    pub fn alternatives(&self) -> &[String] {
        match self {
            Self::Single(s) => std::slice::from_ref(s),
            Self::Alts(alts) => alts,
        }
    }
}

/// A prefix pattern for matching commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixPattern {
    pub first: String,
    pub rest: Vec<PatternToken>,
}

impl PrefixPattern {
    fn matches_prefix(&self, cmd: &[String]) -> Option<Vec<String>> {
        let pattern_length = self.rest.len() + 1;
        if cmd.len() < pattern_length || cmd[0] != self.first {
            return None;
        }

        for (pattern_token, cmd_token) in self.rest.iter().zip(&cmd[1..pattern_length]) {
            if !pattern_token.matches(cmd_token) {
                return None;
            }
        }

        Some(cmd[..pattern_length].to_vec())
    }
}

/// A prefix rule that matches commands.
#[derive(Debug, Clone)]
pub struct PrefixRule {
    pub pattern: PrefixPattern,
    pub decision: Decision,
}

/// A rule match result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RuleMatch {
    #[serde(rename_all = "camelCase")]
    Prefix {
        matched_prefix: Vec<String>,
        decision: Decision,
    },
    #[serde(rename_all = "camelCase")]
    Heuristics {
        command: Vec<String>,
        decision: Decision,
    },
}

impl RuleMatch {
    #[must_use]
    pub fn decision(&self) -> Decision {
        match self {
            Self::Prefix { decision, .. } => *decision,
            Self::Heuristics { decision, .. } => *decision,
        }
    }
}

/// Policy evaluation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub decision: Decision,
    pub matched_rules: Vec<RuleMatch>,
}

impl Evaluation {
    #[must_use]
    pub fn is_match(&self) -> bool {
        self.matched_rules
            .iter()
            .any(|m| !matches!(m, RuleMatch::Heuristics { .. }))
    }

    fn from_matches(matched_rules: Vec<RuleMatch>) -> Self {
        let decision = matched_rules
            .iter()
            .map(RuleMatch::decision)
            .max()
            .unwrap_or(Decision::Allow);

        Self {
            decision,
            matched_rules,
        }
    }
}

/// Policy containing multiple rules indexed by program name.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    rules_by_program: HashMap<String, Vec<PrefixRule>>,
}

impl Policy {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_rule(&mut self, rule: PrefixRule) {
        let program = rule.pattern.first.clone();
        self.rules_by_program.entry(program).or_default().push(rule);
    }

    pub fn add_prefix_rule(&mut self, prefix: &[String], decision: Decision) -> Result<(), String> {
        if prefix.is_empty() {
            return Err("prefix cannot be empty".to_string());
        }

        let (first, rest) = prefix.split_first().unwrap();
        let pattern = PrefixPattern {
            first: first.clone(),
            rest: rest
                .iter()
                .map(|s| PatternToken::Single(s.clone()))
                .collect(),
        };
        let rule = PrefixRule { pattern, decision };
        self.add_rule(rule);
        Ok(())
    }

    pub fn check<F>(&self, cmd: &[String], heuristics_fallback: Option<F>) -> Evaluation
    where
        F: Fn(&[String]) -> Decision,
    {
        let matched_rules = self.matches_for_command(cmd, heuristics_fallback.as_ref());
        Evaluation::from_matches(matched_rules)
    }

    fn matches_for_command<F>(
        &self,
        cmd: &[String],
        heuristics_fallback: Option<&F>,
    ) -> Vec<RuleMatch>
    where
        F: Fn(&[String]) -> Decision,
    {
        let mut matched_rules = Vec::new();

        if let Some(first) = cmd.first() {
            if let Some(rules) = self.rules_by_program.get(first) {
                for rule in rules {
                    if let Some(matched_prefix) = rule.pattern.matches_prefix(cmd) {
                        matched_rules.push(RuleMatch::Prefix {
                            matched_prefix,
                            decision: rule.decision,
                        });
                    }
                }
            }
        }

        if matched_rules.is_empty() {
            if let Some(fallback) = heuristics_fallback {
                matched_rules.push(RuleMatch::Heuristics {
                    command: cmd.to_vec(),
                    decision: fallback(cmd),
                });
            }
        }

        matched_rules
    }

    #[must_use]
    pub fn rules(&self) -> &HashMap<String, Vec<PrefixRule>> {
        &self.rules_by_program
    }
}

// ─────────────────────────────────────────────────────────────
// Policy Parsing
// ─────────────────────────────────────────────────────────────

static PREFIX_RULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    // Match prefix_rule(...) blocks, capturing the content inside parentheses
    // Uses non-greedy match for content, followed by optional trailing comma
    Regex::new(r"prefix_rule\s*\(\s*([\s\S]*?)\s*\)\s*,?").expect("valid regex")
});

static PATTERN_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pattern\s*=\s*\[").expect("valid regex"));

static DECISION_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"decision\s*=\s*"(\w+)""#).expect("valid regex"));

/// Parse a Starlark-like policy file.
pub fn parse_policy(content: &str, _identifier: &str) -> Policy {
    let mut policy = Policy::new();

    for cap in PREFIX_RULE_REGEX.captures_iter(content) {
        let args = &cap[1];

        if let Some(parsed) = parse_prefix_rule_args(args) {
            for first_alt in &parsed.first_alternatives {
                let pattern = PrefixPattern {
                    first: first_alt.clone(),
                    rest: parsed.rest.clone(),
                };
                let rule = PrefixRule {
                    pattern,
                    decision: parsed.decision,
                };
                policy.add_rule(rule);
            }
        }
    }

    policy
}

struct ParsedPrefixRule {
    first_alternatives: Vec<String>,
    rest: Vec<PatternToken>,
    decision: Decision,
}

fn parse_prefix_rule_args(args: &str) -> Option<ParsedPrefixRule> {
    // Parse pattern
    let pattern_str = extract_pattern_array(args)?;
    let pattern_tokens = parse_pattern_array(pattern_str)?;

    if pattern_tokens.is_empty() {
        return None;
    }

    let (first, rest) = pattern_tokens.split_first().unwrap();
    let first_alternatives = match first {
        PatternToken::Single(s) => vec![s.clone()],
        PatternToken::Alts(alts) => alts.clone(),
    };

    // Parse decision
    let decision = DECISION_REGEX
        .captures(args)
        .and_then(|cap| Decision::parse(&cap[1]))
        .unwrap_or(Decision::Allow);

    Some(ParsedPrefixRule {
        first_alternatives,
        rest: rest.to_vec(),
        decision,
    })
}

/// Extract the full `pattern=[...]` array literal from a prefix_rule body.
///
/// A regex cannot express the balanced brackets of nested alternative
/// groups (`["git", ["push", "fetch"]]`), so this scans from the opening
/// `[` to its matching `]`, ignoring brackets inside quoted strings.
/// Returns `None` (rule skipped) when the brackets never balance.
fn extract_pattern_array(args: &str) -> Option<&str> {
    let key = PATTERN_KEY_REGEX.find(args)?;
    let start = key.end() - 1; // byte index of the opening '['
    let bytes = args.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
        } else if let Some(q) = quote {
            if b == b'\\' {
                escaped = true;
            } else if b == q {
                quote = None;
            }
        } else if b == b'"' || b == b'\'' {
            quote = Some(b);
        } else if b == b'[' {
            depth += 1;
        } else if b == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(&args[start..=i]);
            }
        }
    }
    None
}

fn parse_pattern_array(s: &str) -> Option<Vec<PatternToken>> {
    let content = s.strip_prefix('[')?.strip_suffix(']')?.trim();
    if content.is_empty() {
        return Some(Vec::new());
    }

    let mut tokens = Vec::new();
    let mut i = 0;
    let chars: Vec<char> = content.chars().collect();

    while i < chars.len() {
        // Skip whitespace and commas
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ',') {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        if chars[i] == '"' || chars[i] == '\'' {
            let quote = chars[i];
            i += 1;
            let mut value = String::new();
            while i < chars.len() && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    value.push(chars[i]);
                } else {
                    value.push(chars[i]);
                }
                i += 1;
            }
            i += 1; // skip closing quote
            tokens.push(PatternToken::Single(value));
        } else if chars[i] == '[' {
            // Nested array (alternatives)
            let start = i;
            let mut depth = 1;
            i += 1;
            while i < chars.len() && depth > 0 {
                if chars[i] == '[' {
                    depth += 1;
                } else if chars[i] == ']' {
                    depth -= 1;
                }
                i += 1;
            }
            let nested_str: String = chars[start..i].iter().collect();
            if let Some(nested) = parse_string_array(&nested_str) {
                if nested.len() == 1 {
                    tokens.push(PatternToken::Single(nested[0].clone()));
                } else {
                    tokens.push(PatternToken::Alts(nested));
                }
            }
        }
    }

    Some(tokens)
}

fn parse_string_array(s: &str) -> Option<Vec<String>> {
    let content = s.strip_prefix('[')?.strip_suffix(']')?.trim();
    if content.is_empty() {
        return Some(Vec::new());
    }

    let mut strings = Vec::new();
    let mut i = 0;
    let chars: Vec<char> = content.chars().collect();

    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ',') {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        if chars[i] == '"' || chars[i] == '\'' {
            let quote = chars[i];
            i += 1;
            let mut value = String::new();
            while i < chars.len() && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    value.push(chars[i]);
                } else {
                    value.push(chars[i]);
                }
                i += 1;
            }
            i += 1;
            strings.push(value);
        }
    }

    Some(strings)
}

// ─────────────────────────────────────────────────────────────
// Policy Loading
// ─────────────────────────────────────────────────────────────

static CACHED_POLICY: OnceLock<Policy> = OnceLock::new();

/// Load policy from execpolicy files.
pub fn load_policy(workspace_dir: &Path) -> &'static Policy {
    CACHED_POLICY.get_or_init(|| {
        let mut policy = Policy::new();

        let home = dirs::home_dir().unwrap_or_default();
        let global_path = home.join(".composer").join("execpolicy");
        let project_path = workspace_dir.join(".composer").join("execpolicy");

        // Load global policy
        if let Ok(content) = fs::read_to_string(&global_path) {
            let parsed = parse_policy(&content, global_path.to_string_lossy().as_ref());
            for rules in parsed.rules().values() {
                for rule in rules {
                    policy.add_rule(rule.clone());
                }
            }
        }

        // Load project policy
        if let Ok(content) = fs::read_to_string(&project_path) {
            let parsed = parse_policy(&content, project_path.to_string_lossy().as_ref());
            for rules in parsed.rules().values() {
                for rule in rules {
                    policy.add_rule(rule.clone());
                }
            }
        }

        policy
    })
}

/// Render a prefix rule in the policy file syntax.
#[must_use]
pub fn render_prefix_rule(prefix: &[String], decision: Decision) -> String {
    let tokens: Vec<String> = prefix
        .iter()
        .map(|t| serde_json::to_string(t).unwrap_or_else(|_| format!("\"{t}\"")))
        .collect();
    let pattern = format!("[{}]", tokens.join(", "));
    format!(
        r#"prefix_rule(pattern={pattern}, decision="{}")"#,
        decision.as_str()
    )
}

/// Append a prefix rule with an explicit decision to the policy file.
pub fn append_prefix_rule(
    policy_path: &Path,
    prefix: &[String],
    decision: Decision,
) -> Result<(), String> {
    if prefix.is_empty() {
        return Err("prefix cannot be empty".to_string());
    }
    let rule = render_prefix_rule(prefix, decision);

    // Create directory if needed
    if let Some(dir) = policy_path.parent() {
        let _ = fs::create_dir_all(dir);
    }

    // Open file with append mode
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(policy_path)
        .map_err(|e| format!("Failed to open policy file: {e}"))?;

    // Check if file ends with newline
    let len = file
        .metadata()
        .map(|m| m.len())
        .map_err(|e| format!("Failed to get metadata: {e}"))?;

    if len > 0 {
        file.seek(SeekFrom::End(-1))
            .map_err(|e| format!("Failed to seek: {e}"))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)
            .map_err(|e| format!("Failed to read: {e}"))?;
        if last[0] != b'\n' {
            file.write_all(b"\n")
                .map_err(|e| format!("Failed to write newline: {e}"))?;
        }
    }

    file.write_all(format!("{rule}\n").as_bytes())
        .map_err(|e| format!("Failed to write rule: {e}"))?;

    Ok(())
}

/// Append an allow rule to the policy file.
pub fn append_allow_prefix_rule(policy_path: &Path, prefix: &[String]) -> Result<(), String> {
    append_prefix_rule(policy_path, prefix, Decision::Allow)
}

// ─────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────

/// Parse a command string into tokens.
#[must_use]
pub fn parse_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = ' ';
    let mut escape = false;

    for ch in command.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }

        if ch == '\\' {
            escape = true;
            continue;
        }

        if !in_quotes && (ch == '"' || ch == '\'') {
            in_quotes = true;
            quote_char = ch;
            continue;
        }

        if in_quotes && ch == quote_char {
            in_quotes = false;
            continue;
        }

        if !in_quotes && ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// Check if a command is allowed without prompting.
#[must_use]
pub fn is_command_allowed(command: &str, workspace_dir: &Path) -> bool {
    let policy = load_policy(workspace_dir);
    let tokens = parse_command(command);
    let result = policy.check(&tokens, None::<fn(&[String]) -> Decision>);
    result.decision == Decision::Allow
}

/// Check if a command is forbidden.
#[must_use]
pub fn is_command_forbidden(command: &str, workspace_dir: &Path) -> bool {
    let policy = load_policy(workspace_dir);
    let tokens = parse_command(command);
    let result = policy.check(&tokens, None::<fn(&[String]) -> Decision>);
    result.decision == Decision::Forbidden
}

/// Whitelist a command by adding an allow rule.
pub fn whitelist_command(workspace_dir: &Path, command: &str) -> Result<(), String> {
    let tokens = parse_command(command);
    let policy_path = workspace_dir.join(".composer").join("execpolicy");
    append_allow_prefix_rule(&policy_path, &tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_command() {
        assert_eq!(parse_command("git status"), vec!["git", "status"]);
        assert_eq!(parse_command("ls -la"), vec!["ls", "-la"]);
        assert_eq!(
            parse_command("echo \"hello world\""),
            vec!["echo", "hello world"]
        );
    }

    #[test]
    fn test_policy_check() {
        let mut policy = Policy::new();
        policy
            .add_prefix_rule(&["git".to_string(), "status".to_string()], Decision::Allow)
            .unwrap();

        let result = policy.check(
            &["git".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(result.decision, Decision::Allow);
        assert_eq!(result.matched_rules.len(), 1);
    }

    #[test]
    fn test_parse_policy() {
        let content = r#"
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
"#;
        let policy = parse_policy(content, "test");
        let result = policy.check(
            &["git".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(result.decision, Decision::Allow);
    }

    #[test]
    fn test_evaluation_prefers_forbidden_over_prompt_over_allow() {
        let eval = Evaluation::from_matches(vec![
            RuleMatch::Prefix {
                matched_prefix: vec!["git".to_string()],
                decision: Decision::Allow,
            },
            RuleMatch::Prefix {
                matched_prefix: vec!["git".to_string()],
                decision: Decision::Forbidden,
            },
            RuleMatch::Prefix {
                matched_prefix: vec!["git".to_string()],
                decision: Decision::Prompt,
            },
        ]);
        assert_eq!(eval.decision, Decision::Forbidden);

        // No matches at all defaults to Allow.
        let eval = Evaluation::from_matches(Vec::new());
        assert_eq!(eval.decision, Decision::Allow);

        // The same precedence holds when several policy rules match one command.
        let mut policy = Policy::new();
        policy
            .add_prefix_rule(&["git".to_string(), "push".to_string()], Decision::Allow)
            .unwrap();
        policy
            .add_prefix_rule(&["git".to_string()], Decision::Prompt)
            .unwrap();
        policy
            .add_prefix_rule(
                &["git".to_string(), "push".to_string(), "--force".to_string()],
                Decision::Forbidden,
            )
            .unwrap();

        let result = policy.check(
            &["git".to_string(), "push".to_string(), "--force".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(result.decision, Decision::Forbidden);
        assert_eq!(result.matched_rules.len(), 3);

        let result = policy.check(
            &["git".to_string(), "push".to_string(), "origin".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(result.decision, Decision::Prompt);
        assert_eq!(result.matched_rules.len(), 2);
    }

    #[test]
    fn test_load_policy_project_overrides_global() {
        // `load_policy` caches its result in a process-wide `OnceLock`, so this
        // must remain the only test in this binary that exercises it.
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();

        let global_dir = home.path().join(".composer");
        fs::create_dir_all(&global_dir).unwrap();
        fs::write(
            global_dir.join("execpolicy"),
            "prefix_rule(pattern=[\"git\", \"push\"], decision=\"allow\")\n\
             prefix_rule(pattern=[\"cargo\", \"build\"], decision=\"allow\")\n",
        )
        .unwrap();

        let project_dir = workspace.path().join(".composer");
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("execpolicy"),
            "prefix_rule(pattern=[\"git\", \"push\"], decision=\"forbidden\")\n",
        )
        .unwrap();

        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home.path());

        let policy = load_policy(workspace.path());

        let push = policy.check(
            &["git".to_string(), "push".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(
            push.decision,
            Decision::Forbidden,
            "project rule must override the global rule"
        );
        assert_eq!(
            push.matched_rules.len(),
            2,
            "both global and project rules should be merged"
        );

        let build = policy.check(
            &["cargo".to_string(), "build".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(
            build.decision,
            Decision::Allow,
            "global-only rule still applies"
        );

        match previous_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn test_append_prefix_rule_parse_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let policy_path = temp.path().join(".composer").join("execpolicy");

        append_prefix_rule(
            &policy_path,
            &["git".to_string(), "status".to_string()],
            Decision::Allow,
        )
        .unwrap();
        append_prefix_rule(
            &policy_path,
            &["git".to_string(), "push".to_string()],
            Decision::Prompt,
        )
        .unwrap();
        append_prefix_rule(
            &policy_path,
            &["rm".to_string(), "-rf".to_string()],
            Decision::Forbidden,
        )
        .unwrap();

        let content = fs::read_to_string(&policy_path).unwrap();
        let policy = parse_policy(&content, "roundtrip");

        let check = |cmd: &[&str]| {
            let tokens: Vec<String> = cmd.iter().map(|s| (*s).to_string()).collect();
            policy
                .check(&tokens, None::<fn(&[String]) -> Decision>)
                .decision
        };
        assert_eq!(check(&["git", "status"]), Decision::Allow);
        assert_eq!(check(&["git", "status", "--short"]), Decision::Allow);
        assert_eq!(check(&["git", "push", "origin"]), Decision::Prompt);
        assert_eq!(check(&["rm", "-rf", "/"]), Decision::Forbidden);

        // Appending to a file without a trailing newline still produces
        // parseable output.
        fs::write(
            &policy_path,
            "prefix_rule(pattern=[\"git\", \"status\"], decision=\"allow\")",
        )
        .unwrap();
        append_prefix_rule(
            &policy_path,
            &["git".to_string(), "push".to_string()],
            Decision::Prompt,
        )
        .unwrap();
        let content = fs::read_to_string(&policy_path).unwrap();
        let policy = parse_policy(&content, "roundtrip-no-newline");
        assert_eq!(check_decision(&policy, &["git", "status"]), Decision::Allow);
        assert_eq!(check_decision(&policy, &["git", "push"]), Decision::Prompt);

        assert!(append_prefix_rule(&policy_path, &[], Decision::Allow).is_err());
    }

    fn check_decision(policy: &Policy, cmd: &[&str]) -> Decision {
        let tokens: Vec<String> = cmd.iter().map(|s| (*s).to_string()).collect();
        policy
            .check(&tokens, None::<fn(&[String]) -> Decision>)
            .decision
    }

    #[test]
    fn test_missing_or_invalid_decision_silently_defaults_to_allow() {
        // Pins current behavior: a prefix_rule with a missing or unparseable
        // `decision=` falls back to Decision::Allow in parse_prefix_rule_args
        // instead of rejecting the rule. This is a dangerous silent default for
        // a security policy; the test documents it so a future fix is explicit.
        for content in [
            r#"prefix_rule(pattern=["rm", "-rf"])"#,
            r#"prefix_rule(pattern=["rm", "-rf"], decision="nonsense")"#,
        ] {
            let policy = parse_policy(content, "test");
            let result = policy.check(
                &["rm".to_string(), "-rf".to_string(), "/".to_string()],
                None::<fn(&[String]) -> Decision>,
            );
            assert_eq!(result.decision, Decision::Allow);
            assert_eq!(result.matched_rules.len(), 1);
        }
    }

    #[test]
    fn test_parse_policy_with_alternatives() {
        let content = r#"
prefix_rule(
    pattern=["git", ["push", "fetch"]],
    decision="prompt",
)
"#;
        let policy = parse_policy(content, "test");
        let check = |cmd: &[&str]| {
            let tokens: Vec<String> = cmd.iter().map(|s| (*s).to_string()).collect();
            policy.check(&tokens, None::<fn(&[String]) -> Decision>)
        };

        // Both alternatives match with the full two-token prefix.
        let push = check(&["git", "push"]);
        assert_eq!(push.decision, Decision::Prompt);
        assert_eq!(push.matched_rules.len(), 1);
        let fetch = check(&["git", "fetch", "origin"]);
        assert_eq!(fetch.decision, Decision::Prompt);
        assert_eq!(fetch.matched_rules.len(), 1);

        // The nested-alternatives token must survive parsing: any other git
        // subcommand matches NO rule, rather than a degraded bare ["git"]
        // prefix that would prompt on every git command (#3091).
        for cmd in [
            &["git", "status"][..],
            &["git", "log", "--oneline"],
            &["git", "pull"],
            &["git"],
        ] {
            let result = check(cmd);
            assert_eq!(result.decision, Decision::Allow, "cmd {cmd:?}");
            assert!(
                result.matched_rules.is_empty(),
                "cmd {cmd:?} must not match the push/fetch rule"
            );
        }

        // The matched prefix covers both tokens, not just "git".
        match &check(&["git", "push"]).matched_rules[0] {
            RuleMatch::Prefix { matched_prefix, .. } => {
                assert_eq!(matched_prefix, &vec!["git".to_string(), "push".to_string()]);
            }
            other => panic!("expected prefix match, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_policy_nested_alternatives_not_first_position() {
        // Alternatives as the first token expand into one rule per program.
        let content = r#"prefix_rule(pattern=[["git", "cargo"], "status"], decision="allow")"#;
        let policy = parse_policy(content, "test");
        assert_eq!(check_decision(&policy, &["git", "status"]), Decision::Allow);
        assert_eq!(
            check_decision(&policy, &["cargo", "status"]),
            Decision::Allow
        );
        assert_eq!(check_decision(&policy, &["npm", "status"]), Decision::Allow);
        let nomatch = policy.check(
            &["npm".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(nomatch.matched_rules.is_empty());

        // Several alternative groups in one pattern.
        let content = r#"prefix_rule(pattern=["git", ["push", "fetch"], ["--force", "--tags"]], decision="prompt")"#;
        let policy = parse_policy(content, "test");
        assert_eq!(
            check_decision(&policy, &["git", "push", "--force"]),
            Decision::Prompt
        );
        assert_eq!(
            check_decision(&policy, &["git", "fetch", "--tags"]),
            Decision::Prompt
        );
        let partial = policy.check(
            &["git".to_string(), "push".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(
            partial.matched_rules.is_empty(),
            "three-token pattern must not match a two-token command"
        );
    }

    #[test]
    fn test_parse_policy_unbalanced_pattern_brackets_skips_rule() {
        // Fail closed-ish: a pattern whose brackets never balance is not
        // parsed as a truncated prefix; the rule is dropped entirely.
        let content = r#"prefix_rule(pattern=["git", ["push"], decision="forbidden")"#;
        let policy = parse_policy(content, "test");
        let result = policy.check(
            &["git".to_string(), "push".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(result.matched_rules.is_empty());
    }
}

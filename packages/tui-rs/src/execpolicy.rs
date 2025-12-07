//! Execution Policy System - Pattern-based command approval policies.
//!
//! Ported from OpenAI Codex (MIT License):
//! https://github.com/openai/codex/tree/main/codex-rs/execpolicy
//!
//! Policies are defined in `.execpolicy` files using a Starlark-like syntax:
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
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "prompt" => Some(Self::Prompt),
            "forbidden" => Some(Self::Forbidden),
            _ => None,
        }
    }

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

static PATTERN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pattern\s*=\s*(\[[\s\S]*?\])").expect("valid regex"));

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
    let pattern_cap = PATTERN_REGEX.captures(args)?;
    let pattern_str = &pattern_cap[1];
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

/// Append an allow rule to the policy file.
pub fn append_allow_prefix_rule(policy_path: &Path, prefix: &[String]) -> Result<(), String> {
    if prefix.is_empty() {
        return Err("prefix cannot be empty".to_string());
    }

    let tokens: Vec<String> = prefix
        .iter()
        .map(|t| serde_json::to_string(t).unwrap_or_else(|_| format!("\"{}\"", t)))
        .collect();
    let pattern = format!("[{}]", tokens.join(", "));
    let rule = format!(r#"prefix_rule(pattern={}, decision="allow")"#, pattern);

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
        .map_err(|e| format!("Failed to open policy file: {}", e))?;

    // Check if file ends with newline
    let len = file
        .metadata()
        .map(|m| m.len())
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    if len > 0 {
        file.seek(SeekFrom::End(-1))
            .map_err(|e| format!("Failed to seek: {}", e))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)
            .map_err(|e| format!("Failed to read: {}", e))?;
        if last[0] != b'\n' {
            file.write_all(b"\n")
                .map_err(|e| format!("Failed to write newline: {}", e))?;
        }
    }

    file.write_all(format!("{}\n", rule).as_bytes())
        .map_err(|e| format!("Failed to write rule: {}", e))?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────

/// Parse a command string into tokens.
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
pub fn is_command_allowed(command: &str, workspace_dir: &Path) -> bool {
    let policy = load_policy(workspace_dir);
    let tokens = parse_command(command);
    let result = policy.check(&tokens, None::<fn(&[String]) -> Decision>);
    result.decision == Decision::Allow
}

/// Check if a command is forbidden.
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
    fn test_parse_policy_with_alternatives() {
        let content = r#"
prefix_rule(
    pattern=["git", ["push", "fetch"]],
    decision="prompt",
)
"#;
        let policy = parse_policy(content, "test");
        assert_eq!(
            policy
                .check(
                    &["git".to_string(), "push".to_string()],
                    None::<fn(&[String]) -> Decision>
                )
                .decision,
            Decision::Prompt
        );
        assert_eq!(
            policy
                .check(
                    &["git".to_string(), "fetch".to_string()],
                    None::<fn(&[String]) -> Decision>
                )
                .decision,
            Decision::Prompt
        );
    }
}

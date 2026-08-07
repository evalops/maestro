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
//!     justification="Pushes and fetches contact the remote.",
//!     match=[["git", "push"], "git fetch origin"],
//!     not_match=["git status"],
//! )
//! ```
//!
//! # Self-Testing Rules
//!
//! A rule may carry example invocations, validated when the policy loads:
//!
//! - `match`: examples that MUST match this rule
//! - `not_match`: examples that MUST NOT match this rule
//!
//! Examples are token arrays or plain strings (strings are tokenized with the
//! production [`parse_command`] tokenizer). A rule whose examples do not match
//! as declared is a load error naming the rule and the failing example —
//! think of them as unit tests for the rule. Rules without examples load as
//! before.
//!
//! # Justification
//!
//! `justification` is an optional human-readable rationale for why a rule
//! exists. It travels with the rule match and is surfaced in approval prompts
//! and rejection messages when the rule fires (see [`Evaluation::justification`]).
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
//! subcommand actually matches the whole command family.
//!
//! Before wiring this module into any live decision path: (1) fix the nested
//! alternative-pattern parsing bug, and (2) gate `load_policy`'s project-level
//! file read on
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
    /// Optional human-readable rationale for why the rule exists, surfaced
    /// in approval prompts and rejection messages when the rule fires.
    pub justification: Option<String>,
}

/// A rule match result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RuleMatch {
    #[serde(rename_all = "camelCase")]
    Prefix {
        matched_prefix: Vec<String>,
        decision: Decision,
        /// Rationale carried from the fired rule, when it declared one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        justification: Option<String>,
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

    /// Justification declared by a matched prefix rule at the effective
    /// decision — the rationale surfaced in the approval prompt (or
    /// rejection message) when the rule fires. `None` when no fired rule
    /// carries one.
    #[must_use]
    pub fn justification(&self) -> Option<&str> {
        self.matched_rules
            .iter()
            .filter(|m| m.decision() == self.decision)
            .find_map(|m| match m {
                RuleMatch::Prefix { justification, .. } => justification.as_deref(),
                RuleMatch::Heuristics { .. } => None,
            })
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
        let rule = PrefixRule {
            pattern,
            decision,
            justification: None,
        };
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
                            justification: rule.justification.clone(),
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

static PATTERN_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pattern\s*=\s*\[").expect("valid regex"));

static DECISION_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"decision\s*=\s*"(\w+)""#).expect("valid regex"));

static JUSTIFICATION_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"justification\s*=\s*"((?:[^"\\]|\\.)*)""#).expect("valid regex")
});

// Word boundary keeps `match` from matching the tail of `not_match` (`_` is
// a word character, so there is no boundary before "match" in "not_match").
static MATCH_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bmatch\s*=\s*\[").expect("valid regex"));

static NOT_MATCH_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bnot_match\s*=\s*\[").expect("valid regex"));

/// Parse a Starlark-like policy file.
///
/// Rules that fail to parse are skipped, as before. The one hard error is a
/// rule whose declared `match` / `not_match` examples do not match as
/// declared: those are unit tests for the rule, so a failure is a load error
/// naming the rule and the failing example.
pub fn parse_policy(content: &str, identifier: &str) -> Result<Policy, String> {
    let mut policy = Policy::new();

    for args in prefix_rule_args(content) {
        if let Some(parsed) = parse_prefix_rule_args(args, identifier)? {
            validate_examples(identifier, &parsed)?;
            for first_alt in &parsed.first_alternatives {
                let pattern = PrefixPattern {
                    first: first_alt.clone(),
                    rest: parsed.rest.clone(),
                };
                let rule = PrefixRule {
                    pattern,
                    decision: parsed.decision,
                    justification: parsed.justification.clone(),
                };
                policy.add_rule(rule);
            }
        }
    }

    Ok(policy)
}

#[derive(Default)]
struct StarlarkScanState {
    quote: Option<u8>,
    triple_quote: bool,
    escaped: bool,
    line_comment: bool,
    quote_delimiter_tail: usize,
}

impl StarlarkScanState {
    /// Return whether this byte is structural syntax and whether it is regular
    /// unescaped content inside a quoted string.
    fn consume(&mut self, bytes: &[u8], index: usize) -> (bool, bool) {
        let byte = bytes[index];
        if self.quote_delimiter_tail > 0 {
            self.quote_delimiter_tail -= 1;
        } else if self.line_comment {
            if byte == b'\n' || byte == b'\r' {
                self.line_comment = false;
            }
        } else if self.escaped {
            self.escaped = false;
        } else if let Some(active_quote) = self.quote {
            if byte == b'\\' {
                self.escaped = true;
            } else if self.triple_quote && bytes[index..].starts_with(&[active_quote; 3]) {
                self.quote = None;
                self.triple_quote = false;
                self.quote_delimiter_tail = 2;
            } else if !self.triple_quote && byte == active_quote {
                self.quote = None;
            } else {
                return (false, true);
            }
        } else if byte == b'#' {
            self.line_comment = true;
        } else if byte == b'"' || byte == b'\'' {
            self.quote = Some(byte);
            if bytes[index..].starts_with(&[byte; 3]) {
                self.triple_quote = true;
                self.quote_delimiter_tail = 2;
            }
        } else {
            return (true, false);
        }

        (false, false)
    }
}

/// Find balanced `prefix_rule(...)` calls, ignoring parentheses inside quoted
/// strings and line comments. An unbalanced outer call is skipped, matching
/// the prior parser's behavior of ignoring rules it could not capture.
fn prefix_rule_args(content: &str) -> Vec<&str> {
    const PREFIX_RULE: &str = "prefix_rule";

    let bytes = content.as_bytes();
    let mut args = Vec::new();
    let mut cursor = 0usize;

    while let Some(rule_start) = next_prefix_rule_start(content, cursor) {
        let mut open = rule_start + PREFIX_RULE.len();
        while bytes.get(open).is_some_and(u8::is_ascii_whitespace) {
            open += 1;
        }
        if bytes.get(open) != Some(&b'(') {
            cursor = rule_start + PREFIX_RULE.len();
            continue;
        }

        let args_start = open + 1;
        let mut depth = 1usize;
        let mut scan = StarlarkScanState::default();
        let mut close = None;
        let mut close_inside_unterminated_quote = None;

        for (index, &byte) in bytes.iter().enumerate().skip(args_start) {
            let (structural, quoted_content) = scan.consume(bytes, index);
            if quoted_content && byte == b')' && close_inside_unterminated_quote.is_none() {
                close_inside_unterminated_quote = Some(index);
            }
            if !structural {
                continue;
            }
            if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
        }

        // The previous regex stopped at `)` even when a quoted example was
        // unterminated, allowing `parse_declared_examples` to return its
        // established malformed-list error. Preserve that behavior without
        // using the fallback for any balanced quoted string.
        let close = close.or_else(|| scan.quote.and(close_inside_unterminated_quote));
        let Some(close) = close else {
            break;
        };
        args.push(&content[args_start..close]);
        cursor = close + 1;
    }

    args
}

fn next_prefix_rule_start(content: &str, mut cursor: usize) -> Option<usize> {
    const PREFIX_RULE: &[u8] = b"prefix_rule";

    let bytes = content.as_bytes();
    let mut scan = StarlarkScanState::default();

    while cursor < bytes.len() {
        if scan.consume(bytes, cursor).0 && bytes[cursor..].starts_with(PREFIX_RULE) {
            return Some(cursor);
        }
        cursor += 1;
    }

    None
}

struct ParsedPrefixRule {
    first_alternatives: Vec<String>,
    rest: Vec<PatternToken>,
    decision: Decision,
    justification: Option<String>,
    match_examples: Vec<Vec<String>>,
    not_match_examples: Vec<Vec<String>>,
}

fn parse_prefix_rule_args(
    args: &str,
    identifier: &str,
) -> Result<Option<ParsedPrefixRule>, String> {
    // Parse pattern
    let Some(pattern_str) = extract_bracketed(args, &PATTERN_KEY_REGEX) else {
        return Ok(None);
    };
    let Some(pattern_tokens) = parse_pattern_array(pattern_str) else {
        return Ok(None);
    };

    if pattern_tokens.is_empty() {
        return Ok(None);
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

    // Optional justification and self-test examples.
    let justification = parse_justification(args);
    let match_examples = parse_declared_examples(args, &MATCH_KEY_REGEX, "match", identifier)?;
    let not_match_examples =
        parse_declared_examples(args, &NOT_MATCH_KEY_REGEX, "not_match", identifier)?;

    Ok(Some(ParsedPrefixRule {
        first_alternatives,
        rest: rest.to_vec(),
        decision,
        justification,
        match_examples,
        not_match_examples,
    }))
}

fn parse_declared_examples(
    args: &str,
    key_regex: &Regex,
    key: &str,
    identifier: &str,
) -> Result<Vec<Vec<String>>, String> {
    if find_structural_key(args, key_regex).is_none() {
        return Ok(Vec::new());
    }
    let raw = extract_bracketed(args, key_regex)
        .ok_or_else(|| format!("{identifier}: malformed {key} example list"))?;
    parse_example_list(raw).ok_or_else(|| format!("{identifier}: malformed {key} example list"))
}

/// Validate a rule's declared examples against its pattern. Every `match`
/// example must match (at least one expanded first-alternative), and no
/// `not_match` example may match. A mismatch is a load error naming the rule
/// and the failing example — this catches patterns that silently degrade to
/// a broader prefix (see #3091) at load time instead of at prompt time.
fn validate_examples(identifier: &str, parsed: &ParsedPrefixRule) -> Result<(), String> {
    if parsed.match_examples.is_empty() && parsed.not_match_examples.is_empty() {
        return Ok(());
    }

    let rule_desc = describe_rule(parsed);
    let matches_rule = |example: &[String]| {
        parsed.first_alternatives.iter().any(|first| {
            let pattern = PrefixPattern {
                first: first.clone(),
                rest: parsed.rest.clone(),
            };
            pattern.matches_prefix(example).is_some()
        })
    };

    for example in &parsed.match_examples {
        if !matches_rule(example) {
            return Err(format!(
                "{identifier}: {rule_desc}: match example {} did not match the rule",
                render_tokens(example),
            ));
        }
    }
    for example in &parsed.not_match_examples {
        if matches_rule(example) {
            return Err(format!(
                "{identifier}: {rule_desc}: not_match example {} matched the rule",
                render_tokens(example),
            ));
        }
    }

    Ok(())
}

/// Render a parsed rule in policy-file syntax for error messages.
fn describe_rule(parsed: &ParsedPrefixRule) -> String {
    let mut tokens = Vec::with_capacity(parsed.rest.len() + 1);
    tokens.push(render_token_alts(&parsed.first_alternatives));
    for token in &parsed.rest {
        tokens.push(render_token_alts(token.alternatives()));
    }
    format!(
        "prefix_rule(pattern=[{}], decision=\"{}\")",
        tokens.join(", "),
        parsed.decision.as_str(),
    )
}

fn render_token_alts(alts: &[String]) -> String {
    if alts.len() == 1 {
        quote_token(&alts[0])
    } else {
        format!(
            "[{}]",
            alts.iter()
                .map(|s| quote_token(s))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn render_tokens(tokens: &[String]) -> String {
    format!(
        "[{}]",
        tokens
            .iter()
            .map(|s| quote_token(s))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn quote_token(token: &str) -> String {
    serde_json::to_string(token).unwrap_or_else(|_| format!("\"{token}\""))
}

fn parse_justification(args: &str) -> Option<String> {
    let cap = JUSTIFICATION_REGEX.captures(args)?;
    let mut value = String::new();
    let mut chars = cap[1].chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                value.push(next);
            }
        } else {
            value.push(ch);
        }
    }
    Some(value)
}

/// Extract the full `[...]` array literal following a `key=[` regex match.
///
/// A regex cannot express the balanced brackets of nested alternative
/// groups (`["git", ["push", "fetch"]]`), so this scans from the opening
/// `[` to its matching `]`, ignoring brackets inside quoted strings.
/// Returns `None` when the key is absent or the brackets never balance.
fn extract_bracketed<'a>(args: &'a str, key_regex: &Regex) -> Option<&'a str> {
    let key = find_structural_key(args, key_regex)?;
    let start = key.end() - 1; // byte index of the opening '['
    let bytes = args.as_bytes();
    let mut depth = 0usize;
    let mut scan = StarlarkScanState::default();
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if !scan.consume(bytes, i).0 {
            continue;
        }
        if b == b'[' {
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

/// Find a key assignment only when its identifier is structural Starlark
/// syntax, not text inside a string or a line comment.
fn find_structural_key<'a>(args: &'a str, key_regex: &Regex) -> Option<regex::Match<'a>> {
    let bytes = args.as_bytes();
    let mut scan = StarlarkScanState::default();
    let mut scanned = 0usize;

    for key in key_regex.find_iter(args) {
        while scanned <= key.start() {
            let structural = scan.consume(bytes, scanned).0;
            if scanned == key.start() && structural {
                return Some(key);
            }
            scanned += 1;
        }
    }

    None
}

/// Return the index immediately after the balanced array beginning at
/// `start`. Brackets inside quoted or escaped token text are not structural.
fn matching_bracket_end(chars: &[char], start: usize) -> Option<usize> {
    if chars.get(start) != Some(&'[') {
        return None;
    }

    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;

    for (index, &ch) in chars.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
        } else if quote.is_some() {
            if ch == '\\' {
                escaped = true;
            } else if quote == Some(ch) {
                quote = None;
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth -= 1;
            if depth == 0 {
                return Some(index + 1);
            }
        }
    }

    None
}

/// Parse a `match=[...]` / `not_match=[...]` example list. Each element is
/// either an array of token strings or a plain string, which is tokenized
/// with the production [`parse_command`] tokenizer.
fn parse_example_list(s: &str) -> Option<Vec<Vec<String>>> {
    let content = s.strip_prefix('[')?.strip_suffix(']')?.trim();
    if content.is_empty() {
        return Some(Vec::new());
    }

    let mut examples = Vec::new();
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
            if i >= chars.len() {
                return None;
            }
            i += 1; // skip closing quote
            examples.push(parse_command(&value));
        } else if chars[i] == '[' {
            // Nested array (token list)
            let start = i;
            i = matching_bracket_end(&chars, start)?;
            let nested_str: String = chars[start..i].iter().collect();
            examples.push(parse_string_array(&nested_str)?);
        } else {
            return None;
        }
    }

    Some(examples)
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
            i = matching_bracket_end(&chars, start)?;
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
            if i >= chars.len() {
                return None;
            }
            i += 1;
            strings.push(value);
        } else {
            return None;
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
            merge_policy_file(&mut policy, &content, &global_path);
        }

        // Load project policy
        if let Ok(content) = fs::read_to_string(&project_path) {
            merge_policy_file(&mut policy, &content, &project_path);
        }

        policy
    })
}

/// Parse one execpolicy file into `policy`. A file whose rules fail
/// self-test validation is skipped with a stderr warning naming the
/// offending rule and example, matching the existing behavior for
/// unreadable files (fail visible, not wedged at startup).
fn merge_policy_file(policy: &mut Policy, content: &str, path: &Path) {
    match parse_policy(content, path.to_string_lossy().as_ref()) {
        Ok(parsed) => {
            for rules in parsed.rules().values() {
                for rule in rules {
                    policy.add_rule(rule.clone());
                }
            }
        }
        Err(err) => eprintln!("execpolicy: ignoring {}: {err}", path.display()),
    }
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
        let policy = parse_policy(content, "test").unwrap();
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
                justification: None,
            },
            RuleMatch::Prefix {
                matched_prefix: vec!["git".to_string()],
                decision: Decision::Forbidden,
                justification: None,
            },
            RuleMatch::Prefix {
                matched_prefix: vec!["git".to_string()],
                decision: Decision::Prompt,
                justification: None,
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
        let policy = parse_policy(&content, "roundtrip").unwrap();

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
        let policy = parse_policy(&content, "roundtrip-no-newline").unwrap();
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
    fn test_parse_policy_keeps_parentheses_inside_quoted_examples() {
        let content = r#"
prefix_rule(
    pattern=["python", "-c"],
    decision="prompt",
    match=["python -c 'print(1)'"],
    not_match=["python -m pytest '(slow or network)'"],
)
"#;

        let policy = parse_policy(content, "quoted-parentheses.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["python", "-c", "print(1)"]),
            Decision::Prompt
        );
    }

    #[test]
    fn test_parse_policy_keeps_quoted_subshell_parentheses_in_not_match() {
        let content = r#"
prefix_rule(
    pattern=["sh", "-c", "deploy"],
    decision="prompt",
    match=["sh -c deploy"],
    not_match=["sh -c 'echo $(date)'", "sh -c '(echo safe)'"],
)
"#;

        let policy = parse_policy(content, "quoted-subshell.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["sh", "-c", "deploy"]),
            Decision::Prompt
        );
    }

    #[test]
    fn test_parse_policy_keeps_parentheses_after_escaped_quotes() {
        let content = r#"
prefix_rule(
    pattern=["python", "-c"],
    decision="prompt",
    match=["python -c \"print(1)\""],
)
"#;

        let policy = parse_policy(content, "escaped-quotes.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["python", "-c", "print(1)"]),
            Decision::Prompt
        );
    }

    #[test]
    fn test_parse_policy_resumes_at_adjacent_rule_after_quoted_parentheses() {
        let content = r#"
prefix_rule(
    pattern=["python", "-c"],
    decision="prompt",
    match=["python -c 'print(1)'"],
)
prefix_rule(pattern=["git", "status"], decision="allow")
"#;

        let policy = parse_policy(content, "adjacent-rules.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["python", "-c", "print(1)"]),
            Decision::Prompt
        );
        let git = policy.check(
            &["git".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(git.decision, Decision::Allow);
        assert_eq!(git.matched_rules.len(), 1);
    }

    #[test]
    fn test_parse_policy_ignores_parentheses_inside_line_comments() {
        let content = r#"
prefix_rule(
    pattern=["git", "push"],
    # Block destructive calls (tracked in the security backlog.
    decision="forbidden",
)
"#;

        let policy = parse_policy(content, "comment-parentheses.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["git", "push", "origin"]),
            Decision::Forbidden
        );
    }

    #[test]
    fn test_parse_policy_ignores_prefix_rule_text_in_top_level_comments() {
        let content = r#"
# syntax: prefix_rule(
prefix_rule(
    pattern=["git", "push"],
    decision="forbidden",
)
"#;

        let policy = parse_policy(content, "top-level-comment.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["git", "push", "origin"]),
            Decision::Forbidden
        );
    }

    #[test]
    fn test_parse_policy_ignores_triple_quoted_module_strings() {
        let content = r#"
"""A literal " character."""
prefix_rule(
    pattern=["git", "push"],
    decision="forbidden",
)
"#;

        let policy = parse_policy(content, "module-docstring.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["git", "push", "origin"]),
            Decision::Forbidden
        );
    }

    #[test]
    fn test_parse_policy_keeps_parentheses_inside_triple_quoted_arguments() {
        let content = r#"
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
    justification="""A literal " character ) remains text.""",
)
prefix_rule(
    pattern=["git", "push"],
    decision="forbidden",
)
"#;

        let policy = parse_policy(content, "triple-quoted-argument.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["git", "push", "origin"]),
            Decision::Forbidden
        );
    }

    #[test]
    fn test_parse_policy_ignores_unbalanced_outer_rule_as_before() {
        let content = r#"
prefix_rule(
    pattern=["git", "push"],
    decision="forbidden",
"#;

        let policy = parse_policy(content, "unbalanced-outer.policy").unwrap();
        let result = policy.check(
            &["git".to_string(), "push".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(
            result.matched_rules.is_empty(),
            "an outer prefix_rule call without a closing parenthesis stays ignored"
        );
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
            let policy = parse_policy(content, "test").unwrap();
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
        let policy = parse_policy(content, "test").unwrap();
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
        let policy = parse_policy(content, "test").unwrap();
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
        let policy = parse_policy(content, "test").unwrap();
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
        let policy = parse_policy(content, "test").unwrap();
        let result = policy.check(
            &["git".to_string(), "push".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(result.matched_rules.is_empty());
    }

    #[test]
    fn test_valid_match_and_not_match_examples_load() {
        let content = r#"
prefix_rule(
    pattern=["git", ["push", "fetch"]],
    decision="prompt",
    justification="Pushes and fetches contact the remote.",
    match=[["git", "push"], "git fetch origin"],
    not_match=["git status", ["git", "pull"]],
)
"#;
        let policy = parse_policy(content, "test").unwrap();
        assert_eq!(check_decision(&policy, &["git", "push"]), Decision::Prompt);
        assert_eq!(
            check_decision(&policy, &["git", "fetch", "origin"]),
            Decision::Prompt
        );
        // not_match examples really do not match the narrowed pattern.
        let status = policy.check(
            &["git".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(status.matched_rules.is_empty());
        let pull = policy.check(
            &["git".to_string(), "pull".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert!(pull.matched_rules.is_empty());
    }

    #[test]
    fn test_commented_examples_do_not_validate_the_rule() {
        let content = r#"
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
    # match=[42],
    # not_match=[["git", "status"]],
)
"#;

        let policy = parse_policy(content, "commented-examples.policy").unwrap();
        assert_eq!(check_decision(&policy, &["git", "status"]), Decision::Allow);
    }

    #[test]
    fn test_commented_example_before_real_example_does_not_shadow_it() {
        let content = r#"
prefix_rule(
    pattern=["git", "status"],
    decision="prompt",
    # match=[["git", "push"]],
    justification="The docs mention match=[[\"git\", \"push\"]] # literally.",
    match=[["git", "status"]],
)
"#;

        let policy = parse_policy(content, "commented-before-real.policy").unwrap();
        assert_eq!(
            check_decision(&policy, &["git", "status"]),
            Decision::Prompt
        );
    }

    #[test]
    fn test_nested_example_brackets_inside_quoted_tokens_are_text() {
        let content = r#"
prefix_rule(
    pattern=["python", "-c"],
    decision="prompt",
    match=[
        ["python", "-c", "print(\"]\")"],
        ["python", "-c", "print(\"[\")"],
        ["python", "-c", 'single ] bracket'],
        ["python", "-c", "escaped quote: \" ] still text"],
        ["python", "-c", "following sibling"],
    ],
)
"#;

        let policy = parse_policy(content, "quoted-bracket-example.policy").unwrap();
        for token in [
            "print(\"]\")",
            "print(\"[\")",
            "single ] bracket",
            "escaped quote: \" ] still text",
            "following sibling",
        ] {
            assert_eq!(
                check_decision(&policy, &["python", "-c", token]),
                Decision::Prompt,
                "example token {token:?}",
            );
        }
    }

    #[test]
    fn test_wrong_match_example_is_load_error() {
        // A `match` example the pattern does not cover must fail at load,
        // naming the rule and the failing example. A pattern degraded to a
        // bare prefix (#3091) would fail this way.
        let content = r#"
prefix_rule(
    pattern=["git", ["push", "fetch"]],
    decision="prompt",
    match=[["git", "push"], ["git", "pull"]],
)
"#;
        let err = parse_policy(content, "test.policy").unwrap_err();
        assert!(
            err.contains("test.policy"),
            "error must name the policy source: {err}"
        );
        assert!(
            err.contains(r#"prefix_rule(pattern=["git", ["push", "fetch"]], decision="prompt")"#),
            "error must name the rule: {err}"
        );
        assert!(
            err.contains(r#"match example ["git", "pull"] did not match"#),
            "error must name the failing example: {err}"
        );
    }

    #[test]
    fn test_wrong_not_match_example_is_load_error() {
        let content = r#"
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
    not_match=["git push origin"],
)
"#;
        let err = parse_policy(content, "test.policy").unwrap_err();
        assert!(
            err.contains(r#"prefix_rule(pattern=["git", "push"], decision="prompt")"#),
            "error must name the rule: {err}"
        );
        assert!(
            err.contains(r#"not_match example ["git", "push", "origin"] matched"#),
            "error must name the failing example: {err}"
        );
    }

    #[test]
    fn test_rules_without_examples_load_as_before() {
        // Backward compat: no match/not_match keys, no validation error.
        let content = r#"prefix_rule(pattern=["git", "status"], decision="allow")"#;
        let policy = parse_policy(content, "test").unwrap();
        assert_eq!(check_decision(&policy, &["git", "status"]), Decision::Allow);
    }

    #[test]
    fn test_malformed_example_scalar_is_load_error() {
        let content = r#"prefix_rule(pattern=["git", "pull"], decision="prompt", match=[42])"#;
        let err = parse_policy(content, "bad.policy").unwrap_err();
        assert!(
            err.contains("bad.policy: malformed match example list"),
            "{err}"
        );
    }

    #[test]
    fn test_unterminated_example_string_is_load_error() {
        let content = r#"prefix_rule(
            pattern=["git", "pull"],
            decision="prompt",
            match=["git pull],
        )"#;
        let err = parse_policy(content, "bad.policy").unwrap_err();
        assert!(
            err.contains("bad.policy: malformed match example list"),
            "{err}"
        );
    }

    #[test]
    fn test_malformed_nested_example_is_load_error_without_hanging() {
        let content = r#"prefix_rule(
            pattern=["git", "pull"],
            decision="prompt",
            match=[["git", 42]],
        )"#;
        let err = parse_policy(content, "bad.policy").unwrap_err();
        assert!(
            err.contains("bad.policy: malformed match example list"),
            "{err}"
        );
    }

    #[test]
    fn test_justification_surfaced_in_approval_reason() {
        let content = r#"
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
    justification="Pushes rewrite shared history; confirm the remote first.",
)
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
"#;
        let policy = parse_policy(content, "test").unwrap();

        let eval = policy.check(
            &["git".to_string(), "push".to_string(), "origin".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(eval.decision, Decision::Prompt);
        assert_eq!(
            eval.justification(),
            Some("Pushes rewrite shared history; confirm the remote first.")
        );

        // Rules without a justification surface nothing.
        let eval = policy.check(
            &["git".to_string(), "status".to_string()],
            None::<fn(&[String]) -> Decision>,
        );
        assert_eq!(eval.decision, Decision::Allow);
        assert_eq!(eval.justification(), None);
    }
}

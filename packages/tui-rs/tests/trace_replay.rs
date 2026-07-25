//! Replay-trace verification harness for pure agent-decision functions.
//!
//! Adapted from grok-build's trace-replay harness
//! (`crates/codegen/xai-grok-shell/tests/trace_replay.rs` in
//! <https://github.com/xai-org/grok-build>). Reads synthetic JSON fixtures from
//! `tests/fixtures/synthetic_*.json`, replays each scenario against a pure
//! agent-decision function, and asserts the produced decision equals the one
//! the fixture declares. No model, no network, no session state — deterministic
//! agent-logic regression coverage for the low-signal run-evals lane.
//!
//! Two decision surfaces are enrolled:
//!
//! - `safety`: [`SafetyController`] doom-loop / rate-limit gate
//!   (`src/agent/safety.rs`). A fixture replays an ordered trace of `check`,
//!   `record`, and `reset` steps and asserts the [`SafetyVerdict`] at every
//!   `check` step.
//! - `execpolicy`: [`Policy::check`] command-approval evaluation
//!   (`src/execpolicy.rs`). A fixture supplies an inline policy source and a
//!   list of commands, and asserts the [`Decision`] for each.
//!
//! Data-driven: dropping a new `synthetic_*.json` fixture into
//! `tests/fixtures/` enrolls it in [`replay_all_synthetic_fixtures`]
//! automatically, and adding its filename to [`CANONICAL_FIXTURES`] is the one
//! required Rust-side change — `canonical_fixtures_match_disk` asserts set
//! equality so a missing-or-extra fixture fails the harness (drift guard).
//!
//! # Fixture schema
//!
//! Every fixture is a single JSON object with a `"harness"` tag selecting the
//! decision surface, plus shared metadata:
//!
//! ```json
//! { "harness": "safety" | "execpolicy", "name": "...", "description": "..." }
//! ```
//!
//! Unknown fields are rejected (`deny_unknown_fields`), and every expected
//! decision is a closed serde enum, so a typo in a fixture fails to
//! deserialize instead of silently passing the wrong assertion branch.
//!
//! ## `harness: "safety"`
//!
//! ```json
//! {
//!   "harness": "safety",
//!   "name": "synthetic_safety_example",
//!   "description": "human-readable; surfaced only on assertion failure",
//!   "config": {
//!     "doom_loop_threshold": 3,
//!     "rate_limit": 5,
//!     "rate_window_secs": 60
//!   },
//!   "steps": [
//!     { "kind": "check", "tool": "bash", "args": {"command": "ls"},
//!       "expected": "allow" },
//!     { "kind": "record", "tool": "bash", "args": {"command": "ls"} },
//!     { "kind": "check", "tool": "bash", "args": {"command": "ls"},
//!       "expected": "block_doom_loop",
//!       "expected_reason_contains": ["doom loop"] },
//!     { "kind": "reset" }
//!   ]
//! }
//! ```
//!
//! - `config` is optional; omitted fields fall back to [`SafetyConfig::default`]
//!   via [`SafetyController::new`]. `rate_window_secs` should be comfortably
//!   larger than the replay's wall-clock runtime (the production limiter uses
//!   real `Instant`s) so rate-limit expectations stay deterministic.
//! - `steps[*].kind` is one of `check`, `record`, `reset`.
//! - `steps[*].expected` (check steps only) is a closed enum:
//!   `allow` | `block_doom_loop` | `block_rate_limit`.
//! - `expected_reason_contains` (optional, block verdicts only) lists
//!   substrings that must appear in the block reason. It must be absent or
//!   empty when `expected` is `allow`.
//!
//! ## `harness: "execpolicy"`
//!
//! ```json
//! {
//!   "harness": "execpolicy",
//!   "name": "synthetic_execpolicy_example",
//!   "description": "human-readable; surfaced only on assertion failure",
//!   "policy_source": "prefix_rule(pattern=[\"git\", \"status\"], decision=\"allow\")\n",
//!   "cases": [
//!     { "command": "git status --short", "expected": "allow" }
//!   ]
//! }
//! ```
//!
//! - `policy_source` is parsed with [`parse_policy`] (the production
//!   Starlark-like policy syntax).
//! - `cases[*].command` is tokenized with the production [`parse_command`]
//!   and evaluated with no heuristics fallback.
//! - `cases[*].expected` is the production [`Decision`] enum itself:
//!   `allow` | `prompt` | `forbidden`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use maestro_tui::agent::safety::{SafetyConfig, SafetyController, SafetyVerdict};
use maestro_tui::execpolicy::{parse_command, parse_policy, Decision};

/// Closed canonical set of shipped fixtures. Adding a fixture
/// here is the one required Rust-side change when a new failure shape
/// is enrolled — `canonical_fixtures_match_disk` asserts set equality
/// against this list so a missing-or-extra fixture fails the harness.
const CANONICAL_FIXTURES: &[&str] = &[
    "synthetic_execpolicy_destructive_fs.json",
    "synthetic_execpolicy_git_workflow.json",
    "synthetic_execpolicy_nested_alts_degradation.json",
    "synthetic_safety_doom_loop_distinct_args.json",
    "synthetic_safety_doom_loop_identical_calls.json",
    "synthetic_safety_rate_limit.json",
];

#[derive(Debug, Deserialize)]
#[serde(tag = "harness", rename_all = "snake_case")]
enum Fixture {
    Safety(SafetyFixture),
    #[serde(rename = "execpolicy")]
    ExecPolicy(ExecPolicyFixture),
}

impl Fixture {
    fn name(&self) -> &str {
        match self {
            Self::Safety(f) => &f.name,
            Self::ExecPolicy(f) => &f.name,
        }
    }
}

// ─────────────────────────────────────────────────────────────
// safety harness
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SafetyFixture {
    name: String,
    #[allow(dead_code)] // human-readable; surfaced only on assertion failure
    description: String,
    #[serde(default)]
    config: Option<SafetyFixtureConfig>,
    steps: Vec<SafetyStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SafetyFixtureConfig {
    doom_loop_threshold: usize,
    rate_limit: usize,
    rate_window_secs: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SafetyStep {
    Check(SafetyCheckStep),
    Record(SafetyRecordStep),
    Reset,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SafetyCheckStep {
    tool: String,
    args: serde_json::Value,
    expected: ExpectedVerdict,
    #[serde(default)]
    expected_reason_contains: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SafetyRecordStep {
    tool: String,
    args: serde_json::Value,
}

/// Typed mirror of the fixture's `expected` field for safety check steps. A
/// closed enum (not `String`) catches typos at deserialize time rather than
/// silently passing the wrong assertion branch. Mirrors [`SafetyVerdict`]
/// without the payload strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExpectedVerdict {
    Allow,
    BlockDoomLoop,
    BlockRateLimit,
}

impl From<&SafetyVerdict> for ExpectedVerdict {
    fn from(verdict: &SafetyVerdict) -> Self {
        match verdict {
            SafetyVerdict::Allow => Self::Allow,
            SafetyVerdict::BlockDoomLoop { .. } => Self::BlockDoomLoop,
            SafetyVerdict::BlockRateLimit { .. } => Self::BlockRateLimit,
        }
    }
}

/// Replay one safety fixture: fold the step trace into a fresh
/// [`SafetyController`], asserting the verdict at every check step.
/// `fixture_name` is only used in panic messages so failures point straight
/// at the offending JSON.
fn replay_safety_fixture(fixture_name: &str, fixture: SafetyFixture) {
    let mut controller = fixture.config.map_or_else(SafetyController::new, |c| {
        SafetyController::with_config(SafetyConfig {
            doom_loop_threshold: c.doom_loop_threshold,
            rate_limit: c.rate_limit,
            rate_window: Duration::from_secs(c.rate_window_secs),
        })
    });

    let mut saw_check = false;
    for (step_index, step) in fixture.steps.into_iter().enumerate() {
        match step {
            SafetyStep::Check(check) => {
                saw_check = true;
                let verdict = controller.check_tool_call(&check.tool, &check.args);
                let actual = ExpectedVerdict::from(&verdict);
                assert_eq!(
                    actual, check.expected,
                    "fixture {fixture_name} step {step_index}: safety verdict mismatch",
                );
                match &verdict {
                    SafetyVerdict::Allow => assert!(
                        check.expected_reason_contains.is_empty(),
                        "fixture {fixture_name} step {step_index} declares `allow` with \
                         `expected_reason_contains` — an allow verdict has no reason",
                    ),
                    SafetyVerdict::BlockDoomLoop { reason }
                    | SafetyVerdict::BlockRateLimit { reason } => {
                        for needle in &check.expected_reason_contains {
                            assert!(
                                reason.contains(needle.as_str()),
                                "fixture {fixture_name} step {step_index}: block reason missing \
                                 substring {needle:?}.\nFull reason:\n{reason}",
                            );
                        }
                    }
                }
            }
            SafetyStep::Record(record) => {
                controller.record_tool_call(&record.tool, &record.args);
            }
            SafetyStep::Reset => controller.reset(),
        }
    }
    assert!(
        saw_check,
        "fixture {fixture_name} has no check steps to evaluate",
    );
}

// ─────────────────────────────────────────────────────────────
// execpolicy harness
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecPolicyFixture {
    name: String,
    #[allow(dead_code)] // human-readable; surfaced only on assertion failure
    description: String,
    policy_source: String,
    cases: Vec<ExecPolicyCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecPolicyCase {
    command: String,
    // `Decision` is the production closed enum (`allow` | `prompt` |
    // `forbidden`); a typo here fails to deserialize.
    expected: Decision,
}

/// Replay one execpolicy fixture: parse the inline policy source with the
/// production parser and assert the decision for every command case.
fn replay_execpolicy_fixture(fixture_name: &str, fixture: ExecPolicyFixture) {
    let policy = parse_policy(&fixture.policy_source, fixture_name);

    assert!(
        !fixture.cases.is_empty(),
        "fixture {fixture_name} has no cases to evaluate",
    );
    for (case_index, case) in fixture.cases.iter().enumerate() {
        let tokens = parse_command(&case.command);
        let evaluation = policy.check(&tokens, None::<fn(&[String]) -> Decision>);
        assert_eq!(
            evaluation.decision, case.expected,
            "fixture {fixture_name} case {case_index}: execpolicy decision mismatch for \
             command {:?}",
            case.command,
        );
    }
}

// ─────────────────────────────────────────────────────────────
// harness plumbing
// ─────────────────────────────────────────────────────────────

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Every `synthetic_*.json` in `tests/fixtures/`, sorted for stable
/// output. Directory-iteration IO errors panic with diagnostic context
/// rather than being silently dropped (a permissioned-out fixture must
/// not vanish from the set unnoticed).
fn discover_fixtures() -> Vec<PathBuf> {
    let dir = fixtures_dir();
    let entries = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read fixtures dir {}: {e}", dir.display()));
    let mut paths: Vec<PathBuf> = entries
        .map(|entry| {
            entry
                .unwrap_or_else(|e| panic!("read entry in {}: {e}", dir.display()))
                .path()
        })
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with("synthetic_") && name.ends_with(".json"))
        })
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no synthetic_*.json fixtures found in {}",
        dir.display()
    );
    paths
}

fn load_fixture(path: &Path) -> Fixture {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

#[test]
fn replay_all_synthetic_fixtures() {
    for path in discover_fixtures() {
        let fixture = load_fixture(&path);
        let name = fixture.name().to_string();
        match fixture {
            Fixture::Safety(f) => replay_safety_fixture(&name, f),
            Fixture::ExecPolicy(f) => replay_execpolicy_fixture(&name, f),
        }
    }
}

/// Set-equality guard: the on-disk fixture set must exactly equal
/// [`CANONICAL_FIXTURES`]. Adding a fixture without updating the
/// constant — or losing one — fails the harness. Closes the
/// "open-ended presence check" gap.
#[test]
fn canonical_fixtures_match_disk() {
    let actual: BTreeSet<String> = discover_fixtures()
        .iter()
        .map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_else(|| panic!("non-UTF8 fixture path: {}", p.display()))
                .to_string()
        })
        .collect();
    let expected: BTreeSet<String> = CANONICAL_FIXTURES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert_eq!(actual, expected, "fixture set drift vs CANONICAL_FIXTURES");
}

/// Compile-time guard: `ExpectedVerdict` must stay a closed enum so a
/// fixture typo fails to load instead of silently passing the wrong branch.
#[test]
fn expected_safety_verdict_is_closed() {
    let parsed: ExpectedVerdict = serde_json::from_str(r#""allow""#).unwrap();
    assert_eq!(parsed, ExpectedVerdict::Allow);
    let parsed: ExpectedVerdict = serde_json::from_str(r#""block_doom_loop""#).unwrap();
    assert_eq!(parsed, ExpectedVerdict::BlockDoomLoop);
    let parsed: ExpectedVerdict = serde_json::from_str(r#""block_rate_limit""#).unwrap();
    assert_eq!(parsed, ExpectedVerdict::BlockRateLimit);
    let err = serde_json::from_str::<ExpectedVerdict>(r#""maybe""#).unwrap_err();
    assert!(
        err.to_string().contains("unknown variant"),
        "expected unknown-variant error, got: {err}"
    );
}

/// Compile-time guard: the execpolicy `expected` field is the production
/// [`Decision`] enum, so a fixture typo fails to load.
#[test]
fn expected_execpolicy_decision_is_closed() {
    for (json, expected) in [
        (r#""allow""#, Decision::Allow),
        (r#""prompt""#, Decision::Prompt),
        (r#""forbidden""#, Decision::Forbidden),
    ] {
        let parsed: Decision = serde_json::from_str(json).unwrap();
        assert_eq!(parsed, expected);
    }
    let err = serde_json::from_str::<Decision>(r#""yolo""#).unwrap_err();
    assert!(
        err.to_string().contains("unknown variant"),
        "expected unknown-variant error, got: {err}"
    );
}

/// Compile-time guard: an unknown `harness` tag fails to load instead of
/// being silently routed to the wrong replay.
#[test]
fn unknown_harness_tag_is_rejected() {
    let err = serde_json::from_str::<Fixture>(
        r#"{"harness": "saftey", "name": "x", "description": "x", "steps": []}"#,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("unknown variant"),
        "expected unknown-variant error, got: {err}"
    );
}

//! Perf baseline runner for maestro-tui hot paths.
//!
//! Adopted from xai-org/grok-build's pty-bench baseline gate: each scenario is
//! timed over a fixed synthetic workload, results are compared against a
//! versioned per-platform JSON baseline, and the run fails when any scenario
//! regresses by more than the threshold (15% by default).
//!
//! Usage:
//!   maestro-perf-bench                              Run scenarios and print timings
//!   maestro-perf-bench --write-baseline <path>      Record current timings as the baseline
//!   maestro-perf-bench --baseline <path>            Fail if a scenario regresses vs the baseline
//!   maestro-perf-bench --baseline <path> --threshold 0.25
//!
//! Baseline files live in `packages/tui-rs/benches/baselines/<platform>.json`;
//! see the README there for the update workflow.

use std::collections::BTreeMap;
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use maestro_tui::execpolicy::{parse_command, parse_policy, Decision};
use maestro_tui::session::{
    AppMessage, ContentBlock, MessageContent, MessageEntry, SessionEntry, SessionHeader,
    SessionReader, ThinkingLevel, TokenUsage,
};
use serde::{Deserialize, Serialize};

/// Default maximum allowed slowdown before a scenario counts as regressed.
const DEFAULT_THRESHOLD: f64 = 0.15;
/// Warmup rounds per scenario, discarded before measuring.
const WARMUP_ROUNDS: usize = 2;
/// Measured rounds per scenario; the median is reported.
const MEASURED_ROUNDS: usize = 9;
/// Messages in the synthetic session fixture (~2k JSONL lines).
const SESSION_MESSAGES: usize = 2_000;
/// Execpolicy evaluations per measured round.
const EXECPOLICY_EVALS_PER_ROUND: usize = 500;

/// Versioned per-platform baseline file.
#[derive(Debug, Serialize, Deserialize)]
struct Baseline {
    version: u32,
    platform: String,
    /// Scenario name -> median round time in nanoseconds.
    scenarios: BTreeMap<String, u64>,
}

/// One scenario's current-vs-baseline outcome.
#[derive(Debug)]
struct Comparison {
    name: String,
    baseline_ns: u64,
    current_ns: u64,
}

impl Comparison {
    fn ratio(&self) -> f64 {
        self.current_ns as f64 / self.baseline_ns as f64
    }
}

/// Compare current timings against a baseline. Scenarios absent from either
/// side are skipped; only shared scenarios can regress.
fn compare(baseline: &BTreeMap<String, u64>, current: &BTreeMap<String, u64>) -> Vec<Comparison> {
    baseline
        .iter()
        .filter_map(|(name, &baseline_ns)| {
            current.get(name).map(|&current_ns| Comparison {
                name: name.clone(),
                baseline_ns,
                current_ns,
            })
        })
        .collect()
}

/// Scenarios whose slowdown exceeds `threshold` (e.g. 0.15 for 15%).
fn regressions(comparisons: &[Comparison], threshold: f64) -> Vec<&Comparison> {
    comparisons
        .iter()
        .filter(|c| c.ratio() > 1.0 + threshold)
        .collect()
}

/// Platform key matching the baseline file naming: `<os>-<arch>`.
fn platform_id() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Time `round` over warmup + measured rounds; return the median in ns.
fn time_rounds(mut round: impl FnMut()) -> u64 {
    for _ in 0..WARMUP_ROUNDS {
        round();
    }
    let mut samples = Vec::with_capacity(MEASURED_ROUNDS);
    for _ in 0..MEASURED_ROUNDS {
        let start = Instant::now();
        round();
        samples.push(start.elapsed().as_nanos() as u64);
    }
    samples.sort_unstable();
    samples[samples.len() / 2]
}

/// Synthetic session entries: a header plus a user/assistant/toolResult mix
/// shaped like real JSONL session traffic.
fn bench_entries(message_count: usize) -> Vec<SessionEntry> {
    let header = SessionHeader {
        version: Some(1),
        id: "perf-bench-session".to_string(),
        timestamp: "2024-01-15T10:30:00.000Z".to_string(),
        cwd: "/tmp/perf-bench".to_string(),
        model: "anthropic/claude-3-5-sonnet-20241022".to_string(),
        subject: None,
        model_metadata: None,
        thinking_level: ThinkingLevel::Medium,
        system_prompt: None,
        prompt_metadata: None,
        prompt_context_manifest: None,
        unified_context_manifest: None,
        tools: Vec::new(),
        branched_from: None,
        parent_session: None,
    };

    let mut entries = Vec::with_capacity(message_count + 1);
    entries.push(SessionEntry::Session(header));

    for i in 0..message_count {
        let timestamp = format!("2024-01-15T10:{:02}:{:02}.000Z", (i / 60) % 60, i % 60);
        let message = match i % 3 {
            0 => AppMessage::User {
                content: MessageContent::Text(format!(
                    "Please refactor module {i} to use the new session reader API and update the tests."
                )),
                attachments: None,
                timestamp: i as u64,
            },
            1 => AppMessage::Assistant {
                content: vec![ContentBlock::Text {
                    text: format!(
                        "Refactored module {i}: switched to SessionReader::read_file, kept the wire format unchanged, and extended the regression tests."
                    ),
                }],
                api: Some("anthropic".to_string()),
                provider: Some("Anthropic".to_string()),
                model: Some("claude-3-5-sonnet-20241022".to_string()),
                usage: Some(TokenUsage {
                    input: 1_200 + i as u64,
                    output: 340,
                    cache_read: 800,
                    cache_write: 64,
                    cost: None,
                }),
                stop_reason: Some("end_turn".to_string()),
                timestamp: i as u64,
            },
            _ => AppMessage::ToolResult {
                tool_call_id: format!("call_{i}"),
                tool_name: "read".to_string(),
                content: format!("fn module_{i}() {{ /* source text for module {i} */ }}"),
                details: None,
                receipt: None,
                is_error: false,
                timestamp: i as u64,
            },
        };
        entries.push(SessionEntry::Message(MessageEntry {
            id: Some(format!("entry-{i}")),
            parent_id: None,
            timestamp,
            message,
        }));
    }

    entries
}

/// Serialize entries to JSONL, matching the on-disk session wire format.
fn to_jsonl(entries: &[SessionEntry]) -> String {
    let mut out = String::new();
    for entry in entries {
        out.push_str(&serde_json::to_string(entry).expect("session entry serializes"));
        out.push('\n');
    }
    out
}

/// Realistic execpolicy rule set for the evaluation scenario.
fn bench_policy_source() -> String {
    let mut source = String::new();
    for i in 0..40 {
        source.push_str(&format!(
            "prefix_rule(pattern = [\"tool{i}\", \"sub\", \"arg\"], decision = \"allow\")\n"
        ));
    }
    source.push_str("prefix_rule(pattern = [\"git\", \"status\"], decision = \"allow\")\n");
    source.push_str("prefix_rule(pattern = [\"git\", \"diff\"], decision = \"allow\")\n");
    source.push_str("prefix_rule(pattern = [\"rm\"], decision = \"forbidden\")\n");
    source
}

fn run_scenarios() -> Result<BTreeMap<String, u64>> {
    let mut results = BTreeMap::new();

    // Shared fixture: a synthetic session on disk and its in-memory entries.
    let fixture_dir =
        std::env::temp_dir().join(format!("maestro-perf-bench-{}", std::process::id()));
    fs::create_dir_all(&fixture_dir).context("create perf fixture dir")?;
    let session_path = fixture_dir.join("session.jsonl");
    let entries = bench_entries(SESSION_MESSAGES);
    fs::write(&session_path, to_jsonl(&entries)).context("write session fixture")?;

    results.insert(
        "session_read_full".to_string(),
        time_rounds(|| {
            let session = SessionReader::read_file(&session_path).expect("fixture parses");
            black_box(session);
        }),
    );

    results.insert(
        "session_read_header".to_string(),
        time_rounds(|| {
            let header = SessionReader::read_header(&session_path).expect("fixture parses");
            black_box(header);
        }),
    );

    results.insert(
        "session_wire_roundtrip".to_string(),
        time_rounds(|| {
            let jsonl = to_jsonl(black_box(&entries));
            for line in jsonl.lines() {
                let entry: SessionEntry = serde_json::from_str(line).expect("fixture roundtrips");
                black_box(entry);
            }
        }),
    );

    let policy = parse_policy(&bench_policy_source(), "perf-bench");
    let commands: Vec<Vec<String>> = (0..EXECPOLICY_EVALS_PER_ROUND)
        .map(|i| {
            let cmd = match i % 4 {
                0 => format!("tool{} sub arg extra", i % 40),
                1 => "git status --short".to_string(),
                2 => "rm -rf /tmp/scratch".to_string(),
                _ => format!("unknown-tool-{i} --flag value"),
            };
            parse_command(&cmd)
        })
        .collect();
    results.insert(
        "execpolicy_eval".to_string(),
        time_rounds(|| {
            for cmd in &commands {
                let eval = policy.check(black_box(cmd), None::<fn(&[String]) -> Decision>);
                black_box(eval);
            }
        }),
    );

    fs::remove_dir_all(&fixture_dir).ok();
    Ok(results)
}

fn load_baseline(path: &Path) -> Result<Baseline> {
    let text = fs::read_to_string(path).with_context(|| {
        format!(
            "baseline file {} not found; seed it with --write-baseline (see benches/baselines/README.md)",
            path.display()
        )
    })?;
    let baseline: Baseline = serde_json::from_str(&text)
        .with_context(|| format!("parse baseline file {}", path.display()))?;
    Ok(baseline)
}

fn write_baseline(path: &Path, scenarios: BTreeMap<String, u64>) -> Result<()> {
    let baseline = Baseline {
        version: 1,
        platform: platform_id(),
        scenarios,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(&baseline).expect("baseline serializes");
    fs::write(path, format!("{json}\n"))
        .with_context(|| format!("write baseline file {}", path.display()))?;
    println!(
        "wrote {} baseline for {} scenarios to {}",
        baseline.platform,
        baseline.scenarios.len(),
        path.display()
    );
    Ok(())
}

struct Args {
    write_baseline: Option<PathBuf>,
    baseline: Option<PathBuf>,
    threshold: f64,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        write_baseline: None,
        baseline: None,
        threshold: DEFAULT_THRESHOLD,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--write-baseline" => {
                args.write_baseline = Some(PathBuf::from(
                    iter.next().context("--write-baseline requires a path")?,
                ));
            }
            "--baseline" => {
                args.baseline = Some(PathBuf::from(
                    iter.next().context("--baseline requires a path")?,
                ));
            }
            "--threshold" => {
                let value = iter.next().context("--threshold requires a value")?;
                args.threshold = value
                    .parse()
                    .with_context(|| format!("invalid --threshold value: {value}"))?;
            }
            "-h" | "--help" => {
                println!(
                    "maestro-perf-bench [--write-baseline <path>] [--baseline <path>] [--threshold <frac>]"
                );
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other} (try --help)"),
        }
    }
    if args.write_baseline.is_some() && args.baseline.is_some() {
        bail!("--write-baseline and --baseline are mutually exclusive");
    }
    Ok(args)
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let current = run_scenarios()?;

    if let Some(path) = args.write_baseline {
        return write_baseline(&path, current);
    }

    println!("scenario timings (median round):");
    for (name, ns) in &current {
        println!("  {name}: {:.3} ms", *ns as f64 / 1e6);
    }

    let Some(path) = args.baseline else {
        return Ok(());
    };

    let baseline = load_baseline(&path)?;
    let comparisons = compare(&baseline.scenarios, &current);

    println!(
        "\ncomparison vs {} (threshold {:.0}%):",
        path.display(),
        args.threshold * 100.0
    );
    for c in &comparisons {
        println!(
            "  {}: {:.3} ms vs {:.3} ms baseline ({:+.1}%)",
            c.name,
            c.current_ns as f64 / 1e6,
            c.baseline_ns as f64 / 1e6,
            (c.ratio() - 1.0) * 100.0
        );
    }

    let regressed = regressions(&comparisons, args.threshold);
    if regressed.is_empty() {
        println!("no scenario regressed beyond the threshold");
        return Ok(());
    }

    eprintln!("\nperf regressions detected:");
    for c in regressed {
        eprintln!(
            "  {} regressed {:+.1}% ({:.3} ms vs {:.3} ms baseline)",
            c.name,
            (c.ratio() - 1.0) * 100.0,
            c.current_ns as f64 / 1e6,
            c.baseline_ns as f64 / 1e6
        );
    }
    eprintln!(
        "if this is intentional, refresh the baseline with --write-baseline and include this output in the PR body"
    );
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenarios(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn no_regression_within_threshold() {
        let baseline = scenarios(&[("a", 1_000), ("b", 2_000)]);
        let current = scenarios(&[("a", 1_150), ("b", 1_900)]);
        let comparisons = compare(&baseline, &current);
        assert!(regressions(&comparisons, 0.15).is_empty());
    }

    #[test]
    fn regression_beyond_threshold() {
        let baseline = scenarios(&[("a", 1_000)]);
        let current = scenarios(&[("a", 1_151)]);
        let comparisons = compare(&baseline, &current);
        let regressed = regressions(&comparisons, 0.15);
        assert_eq!(regressed.len(), 1);
        assert_eq!(regressed[0].name, "a");
    }

    #[test]
    fn improvement_never_regresses() {
        let baseline = scenarios(&[("a", 1_000)]);
        let current = scenarios(&[("a", 10)]);
        let comparisons = compare(&baseline, &current);
        assert!(regressions(&comparisons, 0.15).is_empty());
    }

    #[test]
    fn scenarios_missing_from_either_side_are_skipped() {
        let baseline = scenarios(&[("a", 1_000), ("b", 1_000)]);
        let current = scenarios(&[("a", 5_000), ("c", 1_000)]);
        let comparisons = compare(&baseline, &current);
        assert_eq!(comparisons.len(), 1);
        assert_eq!(comparisons[0].name, "a");
    }

    #[test]
    fn fixture_roundtrips_through_wire_format() {
        let entries = bench_entries(30);
        let jsonl = to_jsonl(&entries);
        let parsed: Vec<SessionEntry> = jsonl
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(parsed.len(), entries.len());
    }
}

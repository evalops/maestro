//! Task-scoped readiness plans over the existing mission `services.yaml`.
//!
//! This adapter never executes shell commands. Callers dispatch the plan through
//! the governed ToolExecutor and supply its actual results and repository identity.
//! Reports retain evidence references and exit metadata, never command output or
//! credentials. Authentication commands use the existing login environment.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::ToolResult;
use crate::tools::details::BashDetails;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Task readiness dimensions serialized as the corresponding manifest keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadinessCheck {
    /// Compile or assemble the task's deliverable.
    Build,
    /// Run the task's verification suite.
    Test,
    /// Confirm the relevant service or application can start.
    Start,
    /// Confirm access to the task's authenticated boundary.
    Authentication,
    /// Confirm that the task's behavior can be observed.
    Observation,
}

impl ReadinessCheck {
    /// Every dimension that a task manifest must configure or explain as inapplicable.
    pub const ALL: [Self; 5] = [
        Self::Build,
        Self::Test,
        Self::Start,
        Self::Authentication,
        Self::Observation,
    ];

    /// Return the stable manifest and acceptance-contract identifier.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Test => "test",
            Self::Start => "start",
            Self::Authentication => "authentication",
            Self::Observation => "observation",
        }
    }
}

/// A named shell command, using either the default timeout or an explicit bound.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ServiceCommand {
    /// Shell text with the default 120-second execution timeout.
    Command(String),
    /// Shell text with an explicitly bounded execution timeout.
    Bounded {
        /// Exact command text supplied to the governed Bash tool.
        command: String,
        /// Maximum runtime in milliseconds; planning validates the allowed range.
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
    },
}

/// A task's command selection or explicit explanation for an inapplicable check.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ReadinessRequirement {
    /// Select one named entry from the manifest's command map.
    Command {
        /// Name of the command to execute for this dimension.
        command: String,
    },
    /// Record why this dimension does not apply; acceptance still requires an owner waiver.
    NotApplicable {
        /// Nonempty explanation retained in the readiness report.
        #[serde(rename = "notApplicable")]
        reason: String,
    },
}

/// `readiness` selects named commands for each task. Existing service definitions
/// remain owned by the services consumer and are intentionally ignored here.
#[derive(Debug, Clone, Deserialize)]
pub struct ReadinessManifest {
    /// Manifest schema version; currently only version 1 is supported.
    pub version: u32,
    /// Command definitions referenced by each task's readiness requirements.
    #[serde(default)]
    pub commands: BTreeMap<String, ServiceCommand>,
    /// Task IDs mapped to an explicit requirement for every readiness dimension.
    #[serde(default)]
    pub readiness: BTreeMap<String, BTreeMap<ReadinessCheck, ReadinessRequirement>>,
}

/// A resolved foreground command whose exact text and timeout identify a check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedReadinessCommand {
    /// Readiness dimension this execution can satisfy.
    pub check: ReadinessCheck,
    /// Name of the selected manifest command.
    pub command_name: String,
    /// Exact shell text expected in the observed Bash result.
    pub command: String,
    /// Maximum foreground runtime in milliseconds.
    pub timeout_ms: u64,
}

impl PlannedReadinessCommand {
    /// Exact foreground Bash arguments; a detached process is not startup proof.
    pub fn tool_arguments(&self) -> Value {
        json!({
            "command": self.command,
            "timeout": self.timeout_ms,
            "run_in_background": false,
            "description": format!("Check task readiness: {}", self.check.as_str()),
        })
    }
}

/// Task-specific requirements bound to the executor's actual repository and revision.
#[derive(Debug, Clone)]
pub struct ReadinessPlan {
    /// Task whose manifest requirements were resolved.
    pub task_id: String,
    /// Absolute root obtained from the actual execution checkout.
    pub repository_root: PathBuf,
    /// Full committed Git revision against which results are collected.
    pub revision: String,
    /// Resolved commands that must produce governed execution observations.
    pub commands: BTreeMap<ReadinessCheck, PlannedReadinessCommand>,
    /// Explicit explanations for dimensions without an applicable command.
    pub not_applicable: BTreeMap<ReadinessCheck, String>,
}

/// The root and HEAD must come from the actual checkout, not manifest fields.
pub fn plan_readiness(
    manifest: &ReadinessManifest,
    task_id: &str,
    repository_root: &Path,
    actual_head: &str,
) -> Result<ReadinessPlan> {
    ensure!(
        manifest.version == 1,
        "Unsupported services manifest version"
    );
    ensure!(!task_id.trim().is_empty(), "Readiness requires a task id");
    ensure!(
        repository_root.is_absolute(),
        "Readiness requires an absolute repository root"
    );
    ensure!(
        maestro_runtime::coding_acceptance::valid_revision(actual_head),
        "Readiness requires the full repository HEAD"
    );
    let requirements = manifest.readiness.get(task_id).ok_or_else(|| {
        anyhow::anyhow!("No readiness requirements configured for task {task_id}")
    })?;
    let mut plan = ReadinessPlan {
        task_id: task_id.to_owned(),
        repository_root: repository_root.to_owned(),
        revision: actual_head.to_owned(),
        commands: BTreeMap::new(),
        not_applicable: BTreeMap::new(),
    };
    for check in ReadinessCheck::ALL {
        let requirement = requirements.get(&check).ok_or_else(|| {
            anyhow::anyhow!(
                "Task {task_id} must configure readiness check {}",
                check.as_str()
            )
        })?;
        match requirement {
            ReadinessRequirement::NotApplicable { reason } => {
                ensure!(
                    !reason.trim().is_empty(),
                    "A not-applicable check requires a reason"
                );
                plan.not_applicable.insert(check, reason.clone());
            }
            ReadinessRequirement::Command { command: name } => {
                let configured = manifest.commands.get(name).ok_or_else(|| {
                    anyhow::anyhow!("Readiness references unknown service command {name}")
                })?;
                let (command, timeout_ms) = match configured {
                    ServiceCommand::Command(command) => (command, DEFAULT_TIMEOUT_MS),
                    ServiceCommand::Bounded {
                        command,
                        timeout_ms,
                    } => (command, *timeout_ms),
                };
                ensure!(
                    !command.trim().is_empty(),
                    "Readiness command {name} is empty"
                );
                ensure!(
                    (1..=MAX_TIMEOUT_MS).contains(&timeout_ms),
                    "Readiness command {name} timeout must be 1..={MAX_TIMEOUT_MS}ms"
                );
                plan.commands.insert(
                    check,
                    PlannedReadinessCommand {
                        check,
                        command_name: name.clone(),
                        command: command.clone(),
                        timeout_ms,
                    },
                );
            }
        }
    }
    Ok(plan)
}

/// Observed outcome of a readiness dimension, before owner acceptance policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadinessStatus {
    /// The configured foreground command completed successfully.
    Passed,
    /// The configured command completed with failure or timeout.
    Failed,
    /// No authoritative completed execution is available.
    Blocked,
    /// The manifest explicitly explains why this dimension does not apply.
    NotApplicable,
}

/// Safe execution metadata for one dimension, excluding command output and secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessCheckReport {
    /// Observed readiness outcome.
    pub status: ReadinessStatus,
    /// Explanation of the outcome or manifest applicability decision.
    pub reason: String,
    /// Selected manifest command, absent for an inapplicable dimension.
    pub command_name: Option<String>,
    /// Planned execution deadline in milliseconds.
    pub timeout_ms: Option<u64>,
    /// Observed exit status, absent when no completed metadata is available.
    pub exit_code: Option<i32>,
    /// Execution duration reported by the Bash tool, when available.
    pub duration_ms: Option<u64>,
    /// References to executor-owned evidence rather than raw output.
    pub evidence_refs: Vec<String>,
}

/// Constructed only from a ToolExecutor result, never deserialized from worker
/// claims. The executor adapter supplies the evidence location and actual HEAD.
#[derive(Debug, Clone)]
pub struct ReadinessObservation {
    task_id: String,
    repository_root: PathBuf,
    revision: String,
    command: PlannedReadinessCommand,
    report: ReadinessCheckReport,
}

/// Match an observed check without accepting a caller-supplied observation.
pub fn observation_is_for_check(observation: &ReadinessObservation, check: ReadinessCheck) -> bool {
    observation.command.check == check
}

fn ensure_checkout(plan: &ReadinessPlan, root: &Path, head: &str) -> Result<()> {
    ensure!(
        plan.repository_root == root,
        "Readiness repository does not match the execution checkout"
    );
    ensure!(
        plan.revision == head,
        "Readiness revision is stale; rerun at current HEAD"
    );
    Ok(())
}

/// Convert an actual Bash result into evidence for its planned task and checkout.
///
/// The caller supplies executor-derived identity and an evidence reference.
/// Root, revision, command text, and result checkout must match the plan;
/// background, cancelled, or missing execution metadata cannot pass the check.
pub fn observe_readiness_result(
    plan: &ReadinessPlan,
    check: ReadinessCheck,
    actual_root: &Path,
    actual_head: &str,
    evidence_ref: &str,
    result: &ToolResult,
) -> Result<ReadinessObservation> {
    ensure_checkout(plan, actual_root, actual_head)?;
    ensure!(
        !evidence_ref.trim().is_empty(),
        "Readiness execution requires an evidence reference"
    );
    let command = plan
        .commands
        .get(&check)
        .ok_or_else(|| anyhow::anyhow!("Readiness check has no executable command"))?;
    let details = result
        .details
        .clone()
        .and_then(|value| serde_json::from_value::<BashDetails>(value).ok());
    let mut report = ReadinessCheckReport {
        status: ReadinessStatus::Blocked,
        reason: "Executor did not return completed Bash execution metadata".into(),
        command_name: Some(command.command_name.clone()),
        timeout_ms: Some(command.timeout_ms),
        exit_code: None,
        duration_ms: None,
        evidence_refs: vec![evidence_ref.to_owned()],
    };
    if let Some(details) = details {
        ensure!(
            details.command == command.command,
            "Readiness result belongs to a different command"
        );
        ensure!(
            details.cwd.as_deref().map(Path::new) == Some(actual_root),
            "Readiness result belongs to a different checkout"
        );
        report.exit_code = Some(details.exit_code);
        report.duration_ms = details.duration_ms;
        if details.background || details.cancelled {
            report.reason = "Readiness command did not finish in the foreground".into();
        } else if result.success && details.exit_code == 0 {
            report.status = ReadinessStatus::Passed;
            report.reason = "Configured readiness command passed".into();
        } else {
            report.status = ReadinessStatus::Failed;
            report.reason = if details.exit_code == 124 {
                "Baseline readiness command timed out".into()
            } else {
                "Baseline readiness command failed; inspect execution evidence".into()
            };
        }
    }
    Ok(ReadinessObservation {
        task_id: plan.task_id.clone(),
        repository_root: actual_root.to_owned(),
        revision: actual_head.to_owned(),
        command: command.clone(),
        report,
    })
}

/// Aggregated readiness observations for one task at one committed revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessReport {
    /// Task whose observations were collected.
    pub task_id: String,
    /// Absolute execution checkout root shared by all observations.
    pub repository_root: PathBuf,
    /// Full Git revision shared by the plan and observations.
    pub revision: String,
    /// Whether every dimension passed or was explicitly marked inapplicable.
    /// Owner acceptance separately authorizes any inapplicable dimensions.
    pub ready: bool,
    /// Report for every dimension, including blocked checks with missing observations.
    pub checks: BTreeMap<ReadinessCheck, ReadinessCheckReport>,
}

/// Aggregate observations while rejecting stale identity, changed commands, and duplicates.
/// Missing executions remain blocked; manifest applicability explanations remain explicit.
pub fn collect_readiness_report(
    plan: &ReadinessPlan,
    actual_root: &Path,
    actual_head: &str,
    observations: &[ReadinessObservation],
) -> Result<ReadinessReport> {
    ensure_checkout(plan, actual_root, actual_head)?;
    let mut checks = BTreeMap::new();
    for observation in observations {
        ensure!(
            observation.task_id == plan.task_id
                && observation.repository_root == plan.repository_root
                && observation.revision == plan.revision,
            "Readiness observation belongs to another task or revision"
        );
        ensure!(
            plan.commands.get(&observation.command.check) == Some(&observation.command),
            "Readiness command configuration changed; rerun the check"
        );
        if checks
            .insert(observation.command.check, observation.report.clone())
            .is_some()
        {
            bail!("Duplicate readiness execution; select one authoritative attempt");
        }
    }
    for check in ReadinessCheck::ALL {
        if let Some(reason) = plan.not_applicable.get(&check) {
            checks.insert(
                check,
                ReadinessCheckReport {
                    status: ReadinessStatus::NotApplicable,
                    reason: reason.clone(),
                    command_name: None,
                    timeout_ms: None,
                    exit_code: None,
                    duration_ms: None,
                    evidence_refs: vec![],
                },
            );
        } else {
            checks.entry(check).or_insert_with(|| ReadinessCheckReport {
                status: ReadinessStatus::Blocked,
                reason: "Required readiness check has not executed".into(),
                command_name: plan
                    .commands
                    .get(&check)
                    .map(|command| command.command_name.clone()),
                timeout_ms: plan.commands.get(&check).map(|command| command.timeout_ms),
                exit_code: None,
                duration_ms: None,
                evidence_refs: vec![],
            });
        }
    }
    Ok(ReadinessReport {
        task_id: plan.task_id.clone(),
        repository_root: plan.repository_root.clone(),
        revision: plan.revision.clone(),
        ready: checks.values().all(|check| {
            matches!(
                check.status,
                ReadinessStatus::Passed | ReadinessStatus::NotApplicable
            )
        }),
        checks,
    })
}

#[cfg(test)]
mod mission_readiness_tests {
    use super::*;

    const HEAD: &str = "1111111111111111111111111111111111111111";
    const ROOT: &str = "/repository";

    fn manifest() -> ReadinessManifest {
        serde_yaml::from_str("version: 1\ncommands:\n  test: cargo test\nservices: {}\nreadiness:\n  feature-a:\n    build: {notApplicable: 'Tests compile this library'}\n    test: {command: test}\n    start: {notApplicable: 'Library has no service'}\n    authentication: {notApplicable: 'No authenticated boundary'}\n    observation: {notApplicable: 'Test results are the observable output'}\n").unwrap()
    }

    fn plan() -> ReadinessPlan {
        plan_readiness(&manifest(), "feature-a", Path::new(ROOT), HEAD).unwrap()
    }

    fn result(exit_code: i32) -> ToolResult {
        ToolResult {
            success: exit_code == 0,
            output: "Secret-looking output must never enter report".into(),
            details: Some(
                serde_json::to_value(BashDetails {
                    command: "cargo test".into(),
                    exit_code,
                    cwd: Some(ROOT.into()),
                    duration_ms: Some(50),
                    ..Default::default()
                })
                .unwrap(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn empty_manifest_and_missing_task_or_check_fail_closed() {
        let empty = serde_yaml::from_str("version: 1\ncommands: {}\nservices: {}").unwrap();
        assert!(plan_readiness(&empty, "feature-a", Path::new(ROOT), HEAD).is_err());
        assert!(plan_readiness(&manifest(), "feature-b", Path::new(ROOT), HEAD).is_err());
        let mut incomplete = manifest();
        incomplete
            .readiness
            .get_mut("feature-a")
            .unwrap()
            .remove(&ReadinessCheck::Authentication);
        assert!(plan_readiness(&incomplete, "feature-a", Path::new(ROOT), HEAD).is_err());
    }

    #[test]
    fn failure_timeout_denial_and_missing_execution_never_report_ready() {
        let plan = plan();
        let missing = collect_readiness_report(&plan, Path::new(ROOT), HEAD, &[]).unwrap();
        assert!(!missing.ready);
        for result in [
            result(1),
            result(124),
            ToolResult::failure("Approval denied"),
        ] {
            let observation = observe_readiness_result(
                &plan,
                ReadinessCheck::Test,
                Path::new(ROOT),
                HEAD,
                "session/tool-call",
                &result,
            )
            .unwrap();
            let report =
                collect_readiness_report(&plan, Path::new(ROOT), HEAD, &[observation]).unwrap();
            assert!(!report.ready);
        }
    }

    #[test]
    fn explicit_exemptions_and_execution_produce_deterministic_secret_free_report() {
        let plan = plan();
        let observation = observe_readiness_result(
            &plan,
            ReadinessCheck::Test,
            Path::new(ROOT),
            HEAD,
            "session/tool-call",
            &result(0),
        )
        .unwrap();
        let report = collect_readiness_report(
            &plan,
            Path::new(ROOT),
            HEAD,
            std::slice::from_ref(&observation),
        )
        .unwrap();
        assert!(report.ready);
        assert_eq!(
            report.checks[&ReadinessCheck::Authentication].status,
            ReadinessStatus::NotApplicable
        );
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("Secret-looking"));
        assert_eq!(
            report,
            collect_readiness_report(&plan, Path::new(ROOT), HEAD, &[observation]).unwrap()
        );
    }

    #[test]
    fn stale_revision_wrong_repository_and_other_tasks_are_rejected() {
        let plan = plan();
        assert!(collect_readiness_report(&plan, Path::new(ROOT), &"2".repeat(40), &[]).is_err());
        assert!(
            observe_readiness_result(
                &plan,
                ReadinessCheck::Test,
                Path::new("/other"),
                HEAD,
                "evidence",
                &result(0)
            )
            .is_err()
        );
        let observation = observe_readiness_result(
            &plan,
            ReadinessCheck::Test,
            Path::new(ROOT),
            HEAD,
            "evidence",
            &result(0),
        )
        .unwrap();
        let mut other = plan.clone();
        other.task_id = "feature-b".into();
        assert!(collect_readiness_report(&other, Path::new(ROOT), HEAD, &[observation]).is_err());
    }

    #[test]
    fn background_or_unproven_success_is_blocked_and_changed_command_is_rejected() {
        let plan = plan();
        let unproven = observe_readiness_result(
            &plan,
            ReadinessCheck::Test,
            Path::new(ROOT),
            HEAD,
            "evidence",
            &ToolResult::success("done"),
        )
        .unwrap();
        assert_eq!(unproven.report.status, ReadinessStatus::Blocked);
        let mut background = result(0);
        background.details.as_mut().unwrap()["background"] = json!(true);
        let observation = observe_readiness_result(
            &plan,
            ReadinessCheck::Test,
            Path::new(ROOT),
            HEAD,
            "evidence",
            &background,
        )
        .unwrap();
        assert_eq!(observation.report.status, ReadinessStatus::Blocked);
        let mut wrong = result(0);
        wrong.details.as_mut().unwrap()["command"] = json!("echo ignored");
        assert!(
            observe_readiness_result(
                &plan,
                ReadinessCheck::Test,
                Path::new(ROOT),
                HEAD,
                "evidence",
                &wrong
            )
            .is_err()
        );
    }

    #[test]
    fn reasons_and_timeouts_are_required_and_commands_are_foreground() {
        let mut blank_reason = manifest();
        blank_reason.readiness.get_mut("feature-a").unwrap().insert(
            ReadinessCheck::Start,
            ReadinessRequirement::NotApplicable { reason: " ".into() },
        );
        assert!(plan_readiness(&blank_reason, "feature-a", Path::new(ROOT), HEAD).is_err());
        let mut bounded = manifest();
        bounded.commands.insert(
            "test".into(),
            ServiceCommand::Bounded {
                command: "cargo test".into(),
                timeout_ms: MAX_TIMEOUT_MS + 1,
            },
        );
        assert!(plan_readiness(&bounded, "feature-a", Path::new(ROOT), HEAD).is_err());
        assert_eq!(
            plan().commands[&ReadinessCheck::Test].tool_arguments()["run_in_background"],
            false
        );
    }
}

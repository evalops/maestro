//! Coding acceptance uses only observed executor results and runtime-owned children.
use super::ToolExecutor;
use crate::agent::ToolResult;
use crate::agents_cli::BuiltinValidatorRole;
use crate::mission_cli::{
    MissionStore, MissionStoreConfig, get_mission_artifact_layout, initialize_mission_artifacts,
};
use crate::mission_readiness::{self, ReadinessObservation, ReadinessPlan, ReadinessStatus};
use crate::tools::details::BashDetails;
use maestro_runtime::coding_acceptance::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct CodingTaskState {
    mission_id: String,
    contract: CodingAcceptanceContract,
    work_id: String,
    session_id: String,
    root: PathBuf,
    base_revision: String,
    revision: String,
    commands: Vec<CodingCommandResult>,
    plan: Option<ReadinessPlan>,
    observations: Vec<ReadinessObservation>,
    review_child: Option<String>,
    behavior_child: Option<String>,
    launching: bool,
    handoffs: Vec<CodingHandoffItem>,
    completed: Option<(CodingCompletionSubmission, Vec<CodingAcceptanceChildRecord>)>,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cannot establish coding repository identity".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn checkout(cwd: &Path) -> Result<(PathBuf, String), String> {
    Ok((
        PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"])?),
        git(cwd, &["rev-parse", "HEAD"])?,
    ))
}
fn normalized_repository(value: &str, actual_remote: bool) -> Option<String> {
    let value = value.trim();
    let candidate = if let Some(scp) = value.strip_prefix("git@") {
        let (host, path) = scp.split_once(':')?;
        format!("ssh://git@{host}/{path}")
    } else if value.contains("://") {
        value.to_owned()
    } else {
        let parts = value.split('/').collect::<Vec<_>>();
        if parts.len() == 2 {
            format!("https://github.com/{value}")
        } else {
            format!("https://{value}")
        }
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "https" | "ssh")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    if !actual_remote
        && (parsed.password().is_some()
            || !(parsed.username().is_empty()
                || parsed.scheme() == "ssh" && parsed.username() == "git"))
    {
        return None;
    }
    let host = parsed.host_str()?;
    let path = parsed.path().trim_matches('/').trim_end_matches(".git");
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(format!(
        "{host}{}/{path}",
        parsed.port().map(|p| format!(":{p}")).unwrap_or_default()
    ))
}
fn verify_repository(root: &Path, repository_id: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.code() == Some(1) {
        let canonical = dunce::canonicalize(root).map_err(|e| e.to_string())?;
        if repository_id == canonical.to_string_lossy() {
            return Ok(());
        }
    } else if output.status.success() {
        let actual = String::from_utf8_lossy(&output.stdout);
        if let (Some(actual), Some(admitted)) = (
            normalized_repository(&actual, true),
            normalized_repository(repository_id, false),
        ) {
            if actual == admitted {
                return Ok(());
            }
        }
    }
    Err("The admitted repository identity does not match this checkout's origin (or canonical root for a repository without an origin)".into())
}

fn ensure_revision(state: &CodingTaskState) -> Result<(), String> {
    let (root, revision) = checkout(&state.root)?;
    verify_repository(&root, &state.contract.repository_id)?;
    if root != state.root || revision != state.revision {
        return Err("Coding evidence is stale: run coding_task readiness at current HEAD, then rerun validation".into());
    }
    if !git(
        &root,
        &["status", "--porcelain", "--untracked-files=normal"],
    )?
    .is_empty()
    {
        return Err("Coding completion requires a clean committed checkout".into());
    }
    Ok(())
}
fn text_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{key} is required"))
}
impl CodingTaskState {
    fn persist(&self) -> Result<(), String> {
        let mut store = MissionStore::load(&self.mission_id, MissionStoreConfig::default())
            .map_err(|e| e.to_string())?;
        let mut features = store.get_snapshot().map_err(|e| e.to_string())?.features;
        let index = features
            .iter()
            .position(|f| f["id"] == self.contract.task_id)
            .ok_or("Coding task feature disappeared")?;
        let feature = &mut features[index];
        feature[CODING_ACCEPTANCE_METADATA_KEY] = json!(self.contract);
        feature["codingWorkflow"] = json!({"workId": self.work_id, "implementationSessionId": self.session_id,
            "repositoryRoot": self.root, "baseRevision": self.base_revision, "revision": self.revision,
            "contractDigest": self.contract.digest(), "handoffItems": self.handoffs, "reviewChildId": self.review_child, "behaviorChildId": self.behavior_child});
        feature["status"] = json!(if self.completed.is_some() {
            "passed"
        } else {
            "in-progress"
        });
        if let Some((submission, children)) = &self.completed {
            feature[CODING_ACCEPTANCE_RESULT_METADATA_KEY] = json!(submission);
            feature[CODING_ACCEPTANCE_CHILD_RECORDS_KEY] = json!(children);
        } else if let Some(obj) = feature.as_object_mut() {
            obj.remove(CODING_ACCEPTANCE_RESULT_METADATA_KEY);
            obj.remove(CODING_ACCEPTANCE_CHILD_RECORDS_KEY);
        }
        store.set_features(features).map_err(|e| e.to_string())?;
        Ok(())
    }
}
impl ToolExecutor {
    /// A fresh user request owns fresh evidence; prior mission artifacts remain durable.
    pub(crate) fn reset_coding_turn(&self) {
        self.coding_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.subagents.clear_coding_validator_records();
    }

    /// The admitted local coding contract, if this executor has started a workflow.
    pub fn coding_contract(&self) -> Option<CodingAcceptanceContract> {
        self.coding_task
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|s| s.contract.clone()))
    }

    /// Return owner-held accepted proof. Active incomplete/stale work fails closed.
    #[allow(clippy::type_complexity)]
    pub fn coding_completion(
        &self,
    ) -> Result<
        Option<(
            CodingAcceptanceContract,
            CodingCompletionSubmission,
            Vec<CodingAcceptanceChildRecord>,
        )>,
        String,
    > {
        let locked = self.coding_task.lock().map_err(|e| e.to_string())?;
        let Some(state) = locked.as_ref() else {
            return Ok(None);
        };
        ensure_revision(state)?;
        let (submission, children) = state.completed.clone().ok_or("Coding task remains incomplete: run readiness, independent validation, then coding_task complete")?;
        Ok(Some((state.contract.clone(), submission, children)))
    }

    pub(super) fn observe_coding_bash(
        &self,
        call_id: &str,
        result: &ToolResult,
    ) -> Result<(), String> {
        let Some(details) = result
            .details
            .clone()
            .and_then(|v| serde_json::from_value::<BashDetails>(v).ok())
        else {
            return Ok(());
        };
        self.check_coding_bash_revision(&details.command)?;
        let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
        let Some(state) = locked.as_mut() else {
            return Ok(());
        };
        let (root, head) = checkout(Path::new(&self.cwd))?;
        let mut next = state.clone();
        if observe_bash(&mut next, &root, &head, call_id, result, &details)? {
            if let Err(error) = next.persist() {
                // A failed attempt must not leave earlier passing evidence reusable.
                state.completed = None;
                state.commands.clear();
                state.observations.clear();
                return Err(error);
            }
            *state = next;
        }
        Ok(())
    }

    /// Both sides of a governed readiness execution must describe the committed source.
    pub(super) fn check_coding_bash_revision(&self, command: &str) -> Result<(), String> {
        let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
        let Some(state) = locked.as_mut() else {
            return Ok(());
        };
        if !state
            .plan
            .as_ref()
            .is_some_and(|plan| plan.commands.values().any(|check| check.command == command))
        {
            return Ok(());
        }
        if let Err(error) = ensure_revision(state) {
            state.commands.clear();
            state.observations.clear();
            state.completed = None;
            state.persist()?;
            return Err(format!(
                "Readiness requires unchanged committed source: {error}"
            ));
        }
        Ok(())
    }

    pub(super) async fn execute_coding_task(
        &self,
        args: &Value,
        call_id: &str,
        cancel: Option<&CancellationToken>,
    ) -> ToolResult {
        match self.coding_task_action(args, call_id, cancel).await {
            Ok(value) => ToolResult::success(value.to_string()).with_details(value),
            Err(error) => ToolResult::failure(error),
        }
    }

    async fn coding_task_action(
        &self,
        args: &Value,
        call_id: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        match text_arg(args, "action")? {
            "begin" => {
                let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
                if locked
                    .as_ref()
                    .is_some_and(|state| state.completed.is_none())
                {
                    return Err("A coding workflow is already active and incomplete; finish it before beginning another work item".into());
                }
                let contract: CodingAcceptanceContract = serde_json::from_value(
                    args.get("contract")
                        .cloned()
                        .ok_or("contract is required")?,
                )
                .map_err(|e| e.to_string())?;
                contract.validate().map_err(str::to_owned)?;
                let mission_id = text_arg(args, "mission_id")?.to_owned();
                let work_id = text_arg(args, "work_id")?.to_owned();
                if let Some(previous) = locked.as_ref() {
                    if previous.work_id == work_id && previous.mission_id == mission_id {
                        if previous.contract != contract {
                            return Err(
                                "The admitted contract cannot change for the same work item".into(),
                            );
                        }
                        return Ok(json!({"completed": true, "contract": previous.contract}));
                    }
                }
                let (root, revision) = checkout(Path::new(&self.cwd))?;
                verify_repository(&root, &contract.repository_id)?;
                let parent_scope = self.subagents.parent_scope_id();
                let session_id = parent_scope
                    .strip_prefix("session:")
                    .unwrap_or(&parent_scope)
                    .to_owned();
                let layout =
                    get_mission_artifact_layout(&mission_id, None).map_err(|e| e.to_string())?;
                let mut store = if layout.state_json.exists() {
                    MissionStore::load(&mission_id, MissionStoreConfig::default())
                        .map_err(|e| e.to_string())?
                } else {
                    if layout.mission_dir.exists() {
                        return Err("Existing mission is missing state.json; restore it instead of overwriting the mission".into());
                    }
                    let mut store = MissionStore::create(
                        &mission_id,
                        Some(&contract.task_id),
                        MissionStoreConfig::default(),
                    )
                    .map_err(|e| e.to_string())?;
                    store.save().map_err(|e| e.to_string())?;
                    initialize_mission_artifacts(&mission_id, Some(&contract.task_id), None, None)
                        .map_err(|e| e.to_string())?;
                    store
                };
                let mut features = store.get_snapshot().map_err(|e| e.to_string())?.features;
                let mut handoffs = vec![];
                let mut base_revision = revision.clone();
                if let Some(existing) = features.iter().find(|f| f["id"] == contract.task_id) {
                    if let Some(admitted) = existing.get(CODING_ACCEPTANCE_METADATA_KEY) {
                        if admitted != &json!(contract)
                            || existing["codingWorkflow"]["workId"] != work_id
                        {
                            return Err(
                                "The admitted coding contract and work identity cannot be replaced"
                                    .into(),
                            );
                        }
                        base_revision = existing["codingWorkflow"]["baseRevision"]
                            .as_str()
                            .ok_or("Missing admitted base revision")?
                            .to_owned();
                        handoffs = serde_json::from_value(
                            existing["codingWorkflow"]["handoffItems"].clone(),
                        )
                        .map_err(|e| format!("Cannot safely restore unresolved handoffs: {e}"))?;
                    }
                } else {
                    features.push(json!({"id": contract.task_id, "description": format!("Coding task {}", contract.task_id), "status":"pending", "fulfills": contract.required_assertion_ids}));
                    store.set_features(features).map_err(|e| e.to_string())?;
                    store.save().map_err(|e| e.to_string())?;
                }
                let state = CodingTaskState {
                    mission_id,
                    contract,
                    work_id,
                    session_id,
                    root,
                    base_revision,
                    revision,
                    commands: vec![],
                    plan: None,
                    observations: vec![],
                    review_child: None,
                    behavior_child: None,
                    launching: false,
                    handoffs,
                    completed: None,
                };
                state.persist()?;
                let response = json!({"contract": state.contract, "repositoryRoot": state.root, "revision": state.revision, "next":"Configure this task in mission services.yaml, then call coding_task readiness and execute the returned Bash calls."});
                *locked = Some(state);
                Ok(response)
            }
            "readiness" => {
                let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
                let state = locked.as_mut().ok_or("No active coding task")?;
                if state.launching {
                    return Err("Validator launch is in progress".into());
                }
                let (_, head) = checkout(&state.root)?;
                let mut next = state.clone();
                next.revision = head.clone();
                ensure_revision(&next)?;
                let layout = get_mission_artifact_layout(&state.mission_id, None)
                    .map_err(|e| e.to_string())?;
                let source =
                    std::fs::read_to_string(layout.services_yaml).map_err(|e| e.to_string())?;
                let manifest = serde_yaml::from_str(&source).map_err(|e| e.to_string())?;
                let plan = mission_readiness::plan_readiness(
                    &manifest,
                    &state.contract.task_id,
                    &state.root,
                    &head,
                )
                .map_err(|e| e.to_string())?;
                for id in &state.contract.readiness_requirements {
                    if !mission_readiness::ReadinessCheck::ALL
                        .iter()
                        .any(|check| check.as_str() == id)
                    {
                        return Err(format!("Unknown readiness requirement {id}"));
                    }
                }
                next.revision = head;
                next.commands.clear();
                next.observations.clear();
                next.review_child = None;
                next.behavior_child = None;
                next.completed = None;
                let response = json!({"revision":next.revision, "bashCalls":plan.commands.values().map(|c| c.tool_arguments()).collect::<Vec<_>>(), "notApplicable":plan.not_applicable, "instruction":"Execute each returned Bash call through the normal tool. Only actual foreground results are recorded. Run from repositoryRoot.", "repositoryRoot": next.root});
                next.plan = Some(plan);
                next.persist()?;
                *state = next;
                Ok(response)
            }
            "validate" => self.launch_coding_validator(args, call_id, cancel).await,
            "status" => {
                let locked = self.coding_task.lock().map_err(|e| e.to_string())?;
                let state = locked.as_ref().ok_or("No active coding task")?;
                let readiness = state
                    .plan
                    .as_ref()
                    .map(|_| readiness_results(state))
                    .transpose()?;
                Ok(
                    json!({"contract":state.contract,"revision":state.revision,"readiness":readiness,"reviewChildId":state.review_child,"behaviorChildId":state.behavior_child,"completed":state.completed.is_some(),"handoffItems":state.handoffs}),
                )
            }
            "handoff" => {
                let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
                let state = locked.as_mut().ok_or("No active coding task")?;
                let item: CodingHandoffItem =
                    serde_json::from_value(args.get("item").cloned().ok_or("item is required")?)
                        .map_err(|e| e.to_string())?;
                if item.id.trim().is_empty() || item.evidence_refs.is_empty() {
                    return Err("Handoff requires an item ID and evidence".into());
                }
                if matches!(
                    item.disposition,
                    CodingHandoffDisposition::Deferred | CodingHandoffDisposition::Dismissed
                ) && !state.contract.authorized_dispositions.contains(&item.id)
                {
                    return Err(
                        "Handoff disposition is not authorized by the admitted contract".into(),
                    );
                }
                let mut next = state.clone();
                next.handoffs.retain(|old| old.id != item.id);
                next.handoffs.push(item);
                next.completed = None;
                next.persist()?;
                *state = next;
                Ok(json!({"handoffItems":state.handoffs}))
            }
            "complete" => {
                let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
                let state = locked.as_mut().ok_or("No active coding task")?;
                ensure_revision(state)?;
                let (review, review_record) =
                    self.collect_coding_validator(state, CodingValidationRole::Review)?;
                let (behavior, behavior_record) =
                    self.collect_coding_validator(state, CodingValidationRole::Behavior)?;
                let submission = CodingCompletionSubmission {
                    task_id: state.contract.task_id.clone(),
                    work_id: state.work_id.clone(),
                    repository_id: state.contract.repository_id.clone(),
                    contract_digest: state.contract.digest(),
                    generation: state.contract.generation,
                    revision: state.revision.clone(),
                    implementation_session_id: state.session_id.clone(),
                    commands: state.commands.clone(),
                    readiness: readiness_results(state)?,
                    review: Some(review),
                    behavior: Some(behavior),
                    handoff_items: state.handoffs.clone(),
                };
                let children = vec![review_record, behavior_record];
                let decision = evaluate_coding_acceptance(
                    &state.contract,
                    Some(&submission),
                    &CodingAcceptanceScope {
                        organization_id: "",
                        workspace_id: "",
                        work_id: &state.work_id,
                        implementation_session_id: &state.session_id,
                    },
                    &children,
                );
                if !decision.accepted {
                    return Err(format!(
                        "Coding completion rejected: {}",
                        decision.reasons.join("; ")
                    ));
                }
                let mut next = state.clone();
                next.completed = Some((submission, children));
                next.persist()?;
                *state = next;
                Ok(json!(decision))
            }
            _ => Err("Unknown coding_task action".into()),
        }
    }

    async fn launch_coding_validator(
        &self,
        args: &Value,
        call_id: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        let role = match text_arg(args, "role")? {
            "review" => CodingValidationRole::Review,
            "behavior" => CodingValidationRole::Behavior,
            _ => return Err("role must be review or behavior".into()),
        };
        let snapshot = {
            let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
            let state = locked.as_mut().ok_or("No active coding task")?;
            ensure_revision(state)?;
            if state.launching {
                return Err("Another validator launch is in progress".into());
            }
            if state
                .handoffs
                .iter()
                .any(|item| item.disposition == CodingHandoffDisposition::Open)
            {
                return Err(
                    "Resolve or explicitly disposition open handoff items before validation".into(),
                );
            }
            if readiness_results(state)?.iter().any(|item| {
                !matches!(
                    item.status,
                    CodingVerificationStatus::Passed | CodingVerificationStatus::Skipped
                )
            }) {
                return Err("Required readiness checks have not passed".into());
            }
            let existing = match role {
                CodingValidationRole::Review => &state.review_child,
                CodingValidationRole::Behavior => &state.behavior_child,
            };
            if let Some(id) = existing {
                if !args.get("retry").and_then(Value::as_bool).unwrap_or(false) {
                    return Ok(
                        json!({"subagentId":id,"instruction":"Use wait_subagent to wait; complete collects the authoritative output. For a terminal failed/blocked report use retry=true."}),
                    );
                }
                let record = self.subagents.coding_validator_record(id)?;
                if matches!(
                    record.status,
                    crate::tools::subagents::SubagentStatus::Queued
                        | crate::tools::subagents::SubagentStatus::Running
                ) {
                    return Err("The previous validator is still running; wait or cancel it before retrying".into());
                }
            }
            state.launching = true;
            state.clone()
        };
        let layout =
            get_mission_artifact_layout(&snapshot.mission_id, None).map_err(|e| e.to_string())?;
        let task = json!({"role":role,"revision":snapshot.revision,"baseRevision":snapshot.base_revision,"repositoryRoot":snapshot.root,"assertionIds":snapshot.contract.required_assertion_ids,"authorizedSkips":snapshot.contract.authorized_skips,"validationContractPath":layout.validation_contract_markdown,"workerCommandEvidence":snapshot.commands,"handoffItems":snapshot.handoffs});
        let task = format!(
            "Validate only this coding assignment. Read the validation contract for assertion descriptions. Verify the assigned commit matches your checkout HEAD before examining anything; report blocked on mismatch. Use your built-in JSON report schema. Evidence references must identify actual inspected files/tool results. Do not modify the implementation or tests. Assignment:\n{task}"
        );
        let builtin = match role {
            CodingValidationRole::Review => BuiltinValidatorRole::CodingReviewer,
            CodingValidationRole::Behavior => BuiltinValidatorRole::CodingFlowValidator,
        };
        let result = self
            .subagents
            .spawn_coding_validator(
                &json!({"task":task,"run_in_background":true,"isolation":"worktree"}),
                call_id,
                self.sandbox_policy.clone(),
                self.credential_vault.clone(),
                cancel,
                builtin,
            )
            .await;
        let mut locked = self.coding_task.lock().map_err(|e| e.to_string())?;
        let state = locked
            .as_mut()
            .ok_or("Coding workflow disappeared during validator launch")?;
        if state.work_id != snapshot.work_id
            || state.session_id != snapshot.session_id
            || state.contract != snapshot.contract
            || state.revision != snapshot.revision
        {
            return Err(
                "Coding workflow changed during validator launch; launch fresh validation".into(),
            );
        }
        state.launching = false;
        if !result.success {
            return Err(result.error.unwrap_or(result.output));
        }
        let details = result
            .details
            .ok_or("Validator launch did not return its record")?;
        let id = details
            .get("subagentId")
            .and_then(Value::as_str)
            .ok_or("Validator launch did not return its child ID")?
            .to_owned();
        let mut next = state.clone();
        match role {
            CodingValidationRole::Review => next.review_child = Some(id),
            CodingValidationRole::Behavior => next.behavior_child = Some(id),
        }
        next.completed = None;
        next.persist()?;
        *state = next;
        Ok(details)
    }

    fn collect_coding_validator(
        &self,
        state: &CodingTaskState,
        role: CodingValidationRole,
    ) -> Result<(CodingValidationReport, CodingAcceptanceChildRecord), String> {
        let id = match role {
            CodingValidationRole::Review => &state.review_child,
            CodingValidationRole::Behavior => &state.behavior_child,
        }
        .as_ref()
        .ok_or(format!("Missing {role:?} validator execution"))?;
        let record = self.subagents.coding_validator_record(id)?;
        if record.status != crate::tools::subagents::SubagentStatus::Completed
            || record
                .parent_scope_id
                .strip_prefix("session:")
                .unwrap_or(&record.parent_scope_id)
                != state.session_id
        {
            return Err(format!(
                "{role:?} validator is unfinished or belongs to another parent"
            ));
        }
        let builtin_role = match role {
            CodingValidationRole::Review => BuiltinValidatorRole::CodingReviewer,
            CodingValidationRole::Behavior => BuiltinValidatorRole::CodingFlowValidator,
        };
        let expected_profile = crate::agents_cli::trusted_builtin_validator_profile(builtin_role);
        if record.profile.as_deref() != Some(expected_profile.name.as_str())
            || record.attempt != 1
            || record.initial_head.as_deref() != Some(state.revision.as_str())
        {
            return Err(
                "Validator profile, original attempt, or assigned revision mismatch".into(),
            );
        }
        let (child_root, child_head) = checkout(Path::new(&record.cwd))?;
        if child_head != state.revision
            || !git(
                &child_root,
                &["status", "--porcelain", "--untracked-files=no"],
            )?
            .is_empty()
        {
            return Err(
                "Validator changed the implementation or inspected a different revision".into(),
            );
        }
        let output = record
            .result
            .as_ref()
            .ok_or("Validator did not produce a result")?;
        let parsed: ValidatorOutput = serde_json::from_str(output.output.trim())
            .map_err(|e| format!("Validator must return its structured JSON report: {e}"))?;
        if parsed.revision != state.revision {
            return Err("Validator report has a stale revision".into());
        }
        let assertions: Vec<_> = parsed
            .assertions
            .into_iter()
            .map(|a| CodingAssertionResult {
                assertion_id: a.id,
                status: a.status,
                evidence_refs: a.evidence,
            })
            .collect();
        let status = if assertions.is_empty()
            || assertions
                .iter()
                .any(|a| a.status == CodingVerificationStatus::Blocked)
        {
            CodingVerificationStatus::Blocked
        } else if assertions
            .iter()
            .any(|a| a.status == CodingVerificationStatus::Failed)
        {
            CodingVerificationStatus::Failed
        } else {
            CodingVerificationStatus::Passed
        };
        let report = CodingValidationReport {
            child_id: record.id.clone(),
            session_id: record.id.clone(),
            revision: state.revision.clone(),
            status,
            assertions,
            evidence_refs: vec![format!("session:{}/result", record.id)],
        };
        let child = CodingAcceptanceChildRecord {
            organization_id: String::new(),
            workspace_id: String::new(),
            work_id: state.work_id.clone(),
            parent_session_id: state.session_id.clone(),
            child_id: record.id.clone(),
            session_id: record.id,
            role,
            revision: state.revision.clone(),
            completed_successfully: true,
            report_digest: report.digest(),
        };
        Ok((report, child))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidatorOutput {
    revision: String,
    assertions: Vec<ValidatorAssertion>,
    #[serde(rename = "summary")]
    _summary: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidatorAssertion {
    id: String,
    status: CodingVerificationStatus,
    evidence: Vec<String>,
    #[serde(rename = "observation")]
    _observation: String,
}

fn observe_bash(
    state: &mut CodingTaskState,
    root: &Path,
    head: &str,
    call_id: &str,
    result: &ToolResult,
    details: &BashDetails,
) -> Result<bool, String> {
    if details.background || details.cancelled {
        return Ok(false);
    }
    if root != state.root.as_path() || head != state.revision.as_str() {
        return Ok(state.completed.take().is_some());
    }
    let mut changed = false;
    let evidence = format!("session:{}/tool:{call_id}", state.session_id);
    if let Some(plan) = &state.plan {
        for command in plan
            .commands
            .values()
            .filter(|c| c.command == details.command)
        {
            let observation = mission_readiness::observe_readiness_result(
                plan,
                command.check,
                root,
                head,
                &evidence,
                result,
            )
            .map_err(|e| e.to_string())?;
            // Latest governed attempt of a configured check supersedes its baseline failure.
            state
                .observations
                .retain(|old| !mission_readiness::observation_is_for_check(old, command.check));
            state.observations.push(observation);
            state.commands.retain(|c| c.command != details.command);
            state.commands.push(CodingCommandResult {
                command: details.command.clone(),
                exit_code: Some(details.exit_code),
                evidence_refs: vec![evidence.clone()],
            });
            state.completed = None;
            changed = true;
        }
    }
    Ok(changed)
}

fn readiness_results(state: &CodingTaskState) -> Result<Vec<CodingAssertionResult>, String> {
    let plan = state
        .plan
        .as_ref()
        .ok_or("Readiness has not been planned")?;
    let report = mission_readiness::collect_readiness_report(
        plan,
        &state.root,
        &state.revision,
        &state.observations,
    )
    .map_err(|e| e.to_string())?;
    Ok(report
        .checks
        .into_iter()
        .filter(|(check, _)| {
            state
                .contract
                .readiness_requirements
                .iter()
                .any(|id| id == check.as_str())
        })
        .map(|(check, result)| {
            let status = match result.status {
                ReadinessStatus::Passed => CodingVerificationStatus::Passed,
                ReadinessStatus::Failed => CodingVerificationStatus::Failed,
                ReadinessStatus::Blocked => CodingVerificationStatus::Blocked,
                ReadinessStatus::NotApplicable => {
                    if state
                        .contract
                        .authorized_skips
                        .iter()
                        .any(|id| id == check.as_str())
                    {
                        CodingVerificationStatus::Skipped
                    } else {
                        CodingVerificationStatus::Blocked
                    }
                }
            };
            let evidence = if result.status == ReadinessStatus::NotApplicable {
                vec![format!(
                    "contract:{}/readiness:{}",
                    state.contract.digest(),
                    check.as_str()
                )]
            } else {
                result.evidence_refs
            };
            CodingAssertionResult {
                assertion_id: check.as_str().to_owned(),
                status,
                evidence_refs: evidence,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn state() -> CodingTaskState {
        let root = PathBuf::from("/repository");
        let manifest=serde_yaml::from_str("version: 1\ncommands:\n  test: cargo test\nreadiness:\n  feature:\n    build: {notApplicable: 'compiled by test'}\n    test: {command: test}\n    start: {notApplicable: 'library'}\n    authentication: {notApplicable: 'library'}\n    observation: {notApplicable: 'test output'}\n").unwrap();
        let plan = mission_readiness::plan_readiness(&manifest, "feature", &root, HEAD).unwrap();
        CodingTaskState {
            mission_id: "mission".into(),
            contract: CodingAcceptanceContract {
                task_id: "feature".into(),
                repository_id: "repo".into(),
                generation: 1,
                required_assertion_ids: vec!["works".into()],
                require_review: true,
                require_behavior: true,
                readiness_requirements: vec!["test".into()],
                authorized_skips: vec![],
                authorized_dispositions: vec![],
            },
            work_id: "work".into(),
            session_id: "implementation".into(),
            root,
            base_revision: HEAD.into(),
            revision: HEAD.into(),
            commands: vec![],
            plan: Some(plan),
            observations: vec![],
            review_child: None,
            behavior_child: None,
            launching: false,
            handoffs: vec![],
            completed: None,
        }
    }
    fn result(exit_code: i32) -> (ToolResult, BashDetails) {
        let details = BashDetails {
            command: "cargo test".into(),
            exit_code,
            cwd: Some("/repository".into()),
            ..Default::default()
        };
        (
            ToolResult {
                success: exit_code == 0,
                details: Some(json!(details)),
                ..Default::default()
            },
            details,
        )
    }
    #[test]
    fn only_matching_foreground_commands_produce_readiness_evidence() {
        let mut state = state();
        assert_eq!(
            readiness_results(&state).unwrap()[0].status,
            CodingVerificationStatus::Blocked
        );
        let (mut output, mut details) = result(0);
        details.command = "echo fabricated-success".into();
        output.details = Some(json!(details));
        observe_bash(
            &mut state,
            Path::new("/repository"),
            HEAD,
            "other",
            &output,
            &details,
        )
        .unwrap();
        assert!(state.commands.is_empty());
        let (mut output, mut details) = result(0);
        details.background = true;
        output.details = Some(json!(details));
        observe_bash(
            &mut state,
            Path::new("/repository"),
            HEAD,
            "background",
            &output,
            &details,
        )
        .unwrap();
        assert_eq!(
            readiness_results(&state).unwrap()[0].status,
            CodingVerificationStatus::Blocked
        );
        let (output, details) = result(0);
        observe_bash(
            &mut state,
            Path::new("/repository"),
            HEAD,
            "actual",
            &output,
            &details,
        )
        .unwrap();
        assert_eq!(
            readiness_results(&state).unwrap()[0].status,
            CodingVerificationStatus::Passed
        );
        assert_eq!(
            state.commands[0].evidence_refs,
            ["session:implementation/tool:actual"]
        );
    }

    #[test]
    fn fresh_turn_or_changed_parent_cannot_reuse_previous_coding_proof() {
        let executor = ToolExecutor::new("/repository");
        *executor.coding_task.lock().unwrap() = Some(state());
        assert!(executor.coding_completion().is_err());
        let same_scope = executor.subagent_parent_scope_id();
        executor.set_subagent_parent_scope(same_scope);
        assert!(executor.coding_contract().is_some());
        executor.set_subagent_parent_scope("session:another-session".into());
        assert!(executor.coding_completion().unwrap().is_none());
        *executor.coding_task.lock().unwrap() = Some(state());
        executor.reset_coding_turn();
        assert!(executor.coding_completion().unwrap().is_none());
    }
    #[test]
    fn failed_attempt_remains_blocking_until_actual_successful_retry() {
        let mut state = state();
        for (call, exit) in [("failed", 1), ("retry", 0)] {
            let (output, details) = result(exit);
            observe_bash(
                &mut state,
                Path::new("/repository"),
                HEAD,
                call,
                &output,
                &details,
            )
            .unwrap();
            assert_eq!(state.commands.len(), 1);
            assert_eq!(state.observations.len(), 1);
            assert_eq!(
                readiness_results(&state).unwrap()[0].status,
                if exit == 0 {
                    CodingVerificationStatus::Passed
                } else {
                    CodingVerificationStatus::Failed
                }
            );
        }
    }
    #[test]
    fn stale_revision_and_wrong_checkout_cannot_create_proof() {
        let mut state = state();
        let (output, details) = result(0);
        observe_bash(
            &mut state,
            Path::new("/repository"),
            &"b".repeat(40),
            "stale",
            &output,
            &details,
        )
        .unwrap();
        observe_bash(
            &mut state,
            Path::new("/another"),
            HEAD,
            "other",
            &output,
            &details,
        )
        .unwrap();
        assert!(state.commands.is_empty());
        assert!(state.observations.is_empty());
    }
    #[test]
    fn caller_report_ids_and_prose_are_not_validator_output() {
        assert!(
            serde_json::from_value::<ValidatorOutput>(
                json!({"revision":HEAD,"assertions":[],"summary":"ok","childId":"invented"})
            )
            .is_err()
        );
        assert!(serde_json::from_str::<ValidatorOutput>("Everything passed").is_err());
    }
    #[test]
    fn repository_identity_normalizes_transport_but_never_conflates_repositories() {
        assert_eq!(
            normalized_repository("git@github.com:evalops/mono.git", true),
            normalized_repository("evalops/mono", false)
        );
        assert_eq!(
            normalized_repository("ssh://git@github.com/evalops/mono.git", true),
            normalized_repository("https://github.com/evalops/mono", false)
        );
        assert_ne!(
            normalized_repository("evalops/mono", false),
            normalized_repository("evalops/other", false)
        );
        assert_ne!(
            normalized_repository("github.com/evalops/mono", false),
            normalized_repository("gitlab.com/evalops/mono", false)
        );
        assert!(
            normalized_repository("https://user:secret@github.com/evalops/mono", false).is_none()
        );
    }

    #[test]
    fn wrong_repository_contract_is_rejected_against_actual_git_origin() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(temp.path())
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "config",
                    "remote.origin.url",
                    "git@github.com:evalops/mono.git"
                ])
                .current_dir(temp.path())
                .status()
                .unwrap()
                .success()
        );
        assert!(verify_repository(temp.path(), "evalops/mono").is_ok());
        assert!(verify_repository(temp.path(), "evalops/another-repository").is_err());
    }

    #[test]
    fn repositories_without_origin_require_the_exact_canonical_root() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(temp.path())
                .status()
                .unwrap()
                .success()
        );
        let root = dunce::canonicalize(temp.path()).unwrap();
        assert!(verify_repository(temp.path(), &root.to_string_lossy()).is_ok());
        assert!(verify_repository(temp.path(), "invented-repository-id").is_err());
    }
}

#[cfg(test)]
mod dispatcher_tests;

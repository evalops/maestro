use crate::a2a_skill_catalog::{a2a_subagent_lane_is_executable, a2a_subagent_skill_contract};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt;

pub(crate) const SUBAGENT_TASK_CAPSULE_VERSION: &str = "evalops.maestro.task-capsule.v1";
pub(crate) const SUBAGENT_TASK_CAPSULE_MAX_RETRY_LIMIT: u8 = 3;

const MATERIAL_SUBAGENT_LANES: &[&str] = &["code-writer"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedSubagentTaskCapsule {
    pub(crate) skill_id: String,
    pub(crate) task_id: String,
    pub(crate) parent_task_id: String,
    pub(crate) lane_id: String,
    pub(crate) task_class: String,
    pub(crate) objective: String,
    pub(crate) in_scope_paths: Vec<String>,
    pub(crate) in_scope_resources: Vec<String>,
    pub(crate) out_of_scope: Vec<String>,
    pub(crate) context_artifacts: Vec<(String, String)>,
    pub(crate) allowed_capabilities: Vec<String>,
    pub(crate) mutation_paths: Vec<String>,
    pub(crate) mutation_resources: Vec<String>,
    pub(crate) expected_artifact_kinds: Vec<String>,
    pub(crate) acceptance_checks: Vec<String>,
    pub(crate) stop_conditions: Vec<String>,
    pub(crate) retry_limit: u64,
    pub(crate) deadline_at: DateTime<Utc>,
    pub(crate) model_route: String,
    pub(crate) material: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CapsuleValidationError {
    Malformed { message: String },
    UnsupportedVersion { found: String },
    UnknownLane { lane_id: String },
    SkillMismatch { expected: String, found: String },
    DeniedTaskClass { task_class: String },
    TaskClassNotAllowed { task_class: String },
    MissingCapability { capability: String },
    UnexpectedCapability { capability: String },
    ArtifactMismatch { artifact_kind: String },
    InvalidPath { path: String },
    ScopeBroadening { path: String },
    InvalidDeadline { deadline: String },
    ExpiredDeadline { deadline: String },
    InvalidModelRoute { model_route: String },
    RetryLimitExceeded { retry_limit: u64 },
    IndependentReviewRequired { lane_id: String },
}

impl fmt::Display for CapsuleValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed { message } => {
                write!(formatter, "invalid subagent task capsule: {message}")
            }
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "unsupported subagent task capsule version {found:?}; expected {SUBAGENT_TASK_CAPSULE_VERSION}"
            ),
            Self::UnknownLane { lane_id } => {
                write!(formatter, "unknown subagent lane {lane_id:?}")
            }
            Self::SkillMismatch { expected, found } => write!(
                formatter,
                "subagent capsule skill mismatch: expected {expected:?}, found {found:?}"
            ),
            Self::DeniedTaskClass { task_class } => {
                write!(formatter, "subagent task class {task_class:?} is denied")
            }
            Self::TaskClassNotAllowed { task_class } => {
                write!(
                    formatter,
                    "subagent task class {task_class:?} is not allowed"
                )
            }
            Self::MissingCapability { capability } => write!(
                formatter,
                "subagent task capsule is missing required capability {capability:?}"
            ),
            Self::UnexpectedCapability { capability } => write!(
                formatter,
                "subagent task capsule requests uncontracted capability {capability:?}"
            ),
            Self::ArtifactMismatch { artifact_kind } => write!(
                formatter,
                "subagent artifact kind {artifact_kind:?} is outside the lane contract"
            ),
            Self::InvalidPath { path } => write!(
                formatter,
                "subagent mutation path {path:?} is not normalized and workspace-relative"
            ),
            Self::ScopeBroadening { path } => write!(
                formatter,
                "subagent mutation boundary {path:?} broadens the declared input scope"
            ),
            Self::InvalidDeadline { deadline } => {
                write!(formatter, "subagent deadline {deadline:?} is not RFC3339")
            }
            Self::ExpiredDeadline { deadline } => {
                write!(formatter, "subagent deadline {deadline:?} has expired")
            }
            Self::InvalidModelRoute { model_route } => {
                write!(
                    formatter,
                    "subagent model route {model_route:?} is not allowlisted"
                )
            }
            Self::RetryLimitExceeded { retry_limit } => write!(
                formatter,
                "subagent retry limit {retry_limit} exceeds {SUBAGENT_TASK_CAPSULE_MAX_RETRY_LIMIT}"
            ),
            Self::IndependentReviewRequired { lane_id } => write!(
                formatter,
                "subagent lane {lane_id:?} requires an independent code-review disposition"
            ),
        }
    }
}

impl std::error::Error for CapsuleValidationError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubagentRequest {
    skill_id: String,
    capsule: TaskCapsule,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskCapsule {
    capsule_version: String,
    task_id: String,
    parent_task_id: String,
    lane_id: String,
    task_class: String,
    objective: String,
    in_scope: CapsuleBoundary,
    out_of_scope: Vec<String>,
    context_artifacts: Vec<ContextArtifact>,
    allowed_capabilities: Vec<String>,
    mutation_boundary: CapsuleBoundary,
    expected_artifact_kinds: Vec<String>,
    acceptance_checks: Vec<String>,
    stop_conditions: Vec<String>,
    retry_limit: u64,
    deadline_at: String,
    model_route: String,
    review: ReviewDisposition,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapsuleBoundary {
    paths: Vec<String>,
    resources: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextArtifact {
    artifact_id: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewDisposition {
    required: bool,
    #[serde(default)]
    lane_id: Option<String>,
}

pub(crate) fn validate_subagent_capsule(
    metadata: &Value,
    skill_id: &str,
) -> Result<ValidatedSubagentTaskCapsule, CapsuleValidationError> {
    decode_subagent_capsule(metadata, skill_id, true)
}

pub(crate) fn decode_subagent_capsule_for_completion(
    metadata: &Value,
    skill_id: &str,
) -> Result<ValidatedSubagentTaskCapsule, CapsuleValidationError> {
    decode_subagent_capsule(metadata, skill_id, false)
}

fn decode_subagent_capsule(
    metadata: &Value,
    skill_id: &str,
    require_future_deadline: bool,
) -> Result<ValidatedSubagentTaskCapsule, CapsuleValidationError> {
    let request: SubagentRequest = serde_json::from_value(metadata.clone()).map_err(|error| {
        CapsuleValidationError::Malformed {
            message: error.to_string(),
        }
    })?;
    let capsule = request.capsule;

    if capsule.capsule_version != SUBAGENT_TASK_CAPSULE_VERSION {
        return Err(CapsuleValidationError::UnsupportedVersion {
            found: capsule.capsule_version,
        });
    }
    if request.skill_id != skill_id {
        return Err(CapsuleValidationError::SkillMismatch {
            expected: skill_id.to_string(),
            found: request.skill_id,
        });
    }
    if !a2a_subagent_lane_is_executable(&capsule.lane_id) {
        return Err(CapsuleValidationError::UnknownLane {
            lane_id: capsule.lane_id,
        });
    }
    let lane_skill_id = format!("maestro.subagent.{}", capsule.lane_id);
    if lane_skill_id != skill_id {
        return Err(CapsuleValidationError::SkillMismatch {
            expected: lane_skill_id,
            found: skill_id.to_string(),
        });
    }

    validate_non_empty_fields(&capsule)?;
    validate_task_class(&capsule)?;
    validate_capabilities(&capsule)?;
    validate_artifacts(&capsule)?;
    validate_boundaries(&capsule)?;
    validate_context_artifacts(&capsule)?;
    let deadline = DateTime::parse_from_rfc3339(&capsule.deadline_at).map_err(|_| {
        CapsuleValidationError::InvalidDeadline {
            deadline: capsule.deadline_at.clone(),
        }
    })?;
    if require_future_deadline && deadline.with_timezone(&Utc) <= Utc::now() {
        return Err(CapsuleValidationError::ExpiredDeadline {
            deadline: capsule.deadline_at.clone(),
        });
    }
    if capsule.model_route != "haiku" {
        return Err(CapsuleValidationError::InvalidModelRoute {
            model_route: capsule.model_route,
        });
    }
    if capsule.retry_limit > u64::from(SUBAGENT_TASK_CAPSULE_MAX_RETRY_LIMIT) {
        return Err(CapsuleValidationError::RetryLimitExceeded {
            retry_limit: capsule.retry_limit,
        });
    }

    let material = MATERIAL_SUBAGENT_LANES.contains(&capsule.lane_id.as_str());
    if material
        && (!capsule.review.required || capsule.review.lane_id.as_deref() != Some("code-review"))
    {
        return Err(CapsuleValidationError::IndependentReviewRequired {
            lane_id: capsule.lane_id,
        });
    }

    Ok(ValidatedSubagentTaskCapsule {
        skill_id: skill_id.to_string(),
        task_id: capsule.task_id,
        parent_task_id: capsule.parent_task_id,
        lane_id: capsule.lane_id,
        task_class: capsule.task_class,
        objective: capsule.objective,
        in_scope_paths: capsule.in_scope.paths,
        in_scope_resources: capsule.in_scope.resources,
        out_of_scope: capsule.out_of_scope,
        context_artifacts: capsule
            .context_artifacts
            .into_iter()
            .map(|artifact| (artifact.artifact_id, artifact.sha256))
            .collect(),
        allowed_capabilities: capsule.allowed_capabilities,
        mutation_paths: capsule.mutation_boundary.paths,
        mutation_resources: capsule.mutation_boundary.resources,
        expected_artifact_kinds: capsule.expected_artifact_kinds,
        acceptance_checks: capsule.acceptance_checks,
        stop_conditions: capsule.stop_conditions,
        retry_limit: capsule.retry_limit,
        deadline_at: deadline.with_timezone(&Utc),
        model_route: capsule.model_route,
        material,
    })
}

fn validate_non_empty_fields(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    for (name, value) in [
        ("taskId", capsule.task_id.as_str()),
        ("parentTaskId", capsule.parent_task_id.as_str()),
        ("objective", capsule.objective.as_str()),
        ("modelRoute", capsule.model_route.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(CapsuleValidationError::Malformed {
                message: format!("{name} must not be empty"),
            });
        }
    }
    for (name, values) in [
        ("outOfScope", capsule.out_of_scope.as_slice()),
        ("acceptanceChecks", capsule.acceptance_checks.as_slice()),
        ("stopConditions", capsule.stop_conditions.as_slice()),
    ] {
        if values.is_empty() || values.iter().any(|value| value.trim().is_empty()) {
            return Err(CapsuleValidationError::Malformed {
                message: format!("{name} must contain non-empty values"),
            });
        }
    }
    Ok(())
}

fn validate_task_class(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    let contract = a2a_subagent_skill_contract(&capsule.lane_id);
    if contract
        .denied_task_classes
        .contains(&capsule.task_class.as_str())
    {
        return Err(CapsuleValidationError::DeniedTaskClass {
            task_class: capsule.task_class.clone(),
        });
    }
    if !contract
        .allowed_task_classes
        .contains(&capsule.task_class.as_str())
    {
        return Err(CapsuleValidationError::TaskClassNotAllowed {
            task_class: capsule.task_class.clone(),
        });
    }
    Ok(())
}

fn validate_capabilities(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    let contract = a2a_subagent_skill_contract(&capsule.lane_id);
    let capabilities = capsule
        .allowed_capabilities
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    for required in contract.required_context_grants {
        if !capabilities.contains(required) {
            return Err(CapsuleValidationError::MissingCapability {
                capability: (*required).to_string(),
            });
        }
    }
    for capability in capabilities {
        if !contract.required_context_grants.contains(&capability) {
            return Err(CapsuleValidationError::UnexpectedCapability {
                capability: capability.to_string(),
            });
        }
    }
    Ok(())
}

fn validate_artifacts(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    let contract = a2a_subagent_skill_contract(&capsule.lane_id);
    let expected = capsule
        .expected_artifact_kinds
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let contracted = contract
        .required_artifact_kinds
        .iter()
        .chain(contract.optional_artifact_kinds.iter())
        .copied()
        .collect::<BTreeSet<_>>();
    for artifact_kind in &expected {
        if !contracted.contains(artifact_kind) {
            return Err(CapsuleValidationError::ArtifactMismatch {
                artifact_kind: (*artifact_kind).to_string(),
            });
        }
    }
    for required in contract.required_artifact_kinds {
        if !expected.contains(required) {
            return Err(CapsuleValidationError::ArtifactMismatch {
                artifact_kind: (*required).to_string(),
            });
        }
    }
    Ok(())
}

fn validate_boundaries(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    if !capsule.mutation_boundary.paths.is_empty()
        && !capsule
            .allowed_capabilities
            .iter()
            .any(|capability| capability == "repo:write-scoped")
    {
        return Err(CapsuleValidationError::MissingCapability {
            capability: "repo:write-scoped".to_string(),
        });
    }
    for path in &capsule.in_scope.paths {
        validate_workspace_relative_path(path)?;
    }
    for mutation_path in &capsule.mutation_boundary.paths {
        if validate_workspace_relative_path(mutation_path).is_err() {
            return Err(CapsuleValidationError::ScopeBroadening {
                path: mutation_path.clone(),
            });
        }
        if !capsule
            .in_scope
            .paths
            .iter()
            .any(|scope| path_is_within(mutation_path, scope))
        {
            return Err(CapsuleValidationError::ScopeBroadening {
                path: mutation_path.clone(),
            });
        }
    }
    for resource in &capsule.mutation_boundary.resources {
        if !capsule.in_scope.resources.contains(resource) {
            return Err(CapsuleValidationError::ScopeBroadening {
                path: resource.clone(),
            });
        }
    }
    for resource in capsule
        .in_scope
        .resources
        .iter()
        .chain(capsule.mutation_boundary.resources.iter())
    {
        validate_resource_id(resource)?;
    }
    Ok(())
}

fn validate_resource_id(resource: &str) -> Result<(), CapsuleValidationError> {
    let invalid = resource.is_empty()
        || resource.trim() != resource
        || resource.starts_with('/')
        || resource.ends_with('/')
        || resource.contains("//")
        || resource.split('/').any(|part| part == "." || part == "..")
        || !resource.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/' | b'#')
        });
    if invalid {
        return Err(CapsuleValidationError::ScopeBroadening {
            path: resource.to_string(),
        });
    }
    Ok(())
}

fn validate_workspace_relative_path(path: &str) -> Result<(), CapsuleValidationError> {
    let invalid = path.is_empty()
        || path.trim() != path
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || path
            .split('/')
            .next()
            .is_some_and(|component| component.ends_with(':'));
    if invalid {
        return Err(CapsuleValidationError::InvalidPath {
            path: path.to_string(),
        });
    }
    Ok(())
}

fn path_is_within(path: &str, scope: &str) -> bool {
    path == scope
        || path
            .strip_prefix(scope)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_context_artifacts(capsule: &TaskCapsule) -> Result<(), CapsuleValidationError> {
    for artifact in &capsule.context_artifacts {
        if artifact.artifact_id.trim().is_empty()
            || artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(CapsuleValidationError::Malformed {
                message: "contextArtifacts must contain an artifactId and SHA-256 digest"
                    .to_string(),
            });
        }
    }
    Ok(())
}

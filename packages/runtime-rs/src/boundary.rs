use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::{HOSTED_RUNTIME_TOPOLOGY, RUNTIME_BOUNDARY_VERSION};

/// Authentication material is represented as a mode. The runtime boundary
/// never stores a bearer token or projected token contents.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostedRuntimeAuthMode {
    None,
    StaticBearer,
    WorkloadIdentity,
}

/// Values used to construct one hosted runtime boundary.
///
/// These values describe the requested pre-start configuration identity. They
/// do not represent post-bind observations, an active session, or ownership of
/// a listener or child process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedRuntimeBoundaryInput {
    /// Platform-issued identity for this hosted runner generation.
    pub runner_session_id: String,
    /// Absolute workspace root mounted into the runtime.
    pub workspace_root: String,
    /// Requested listener address, which may intentionally contain port `0`.
    pub bind_address: String,
    /// Platform-owned generation used for fencing and receipts.
    pub runtime_generation: u64,
    /// Optional Platform runtime owner identity.
    pub owner_instance_id: Option<String>,
    /// Optional EvalOps workspace identity.
    pub workspace_id: Option<String>,
    /// Optional Platform agent-run identity.
    pub agent_run_id: Option<String>,
    /// Optional configured Maestro session identity.
    pub maestro_session_id: Option<String>,
    /// Optional causal receipt identity.
    pub causal_receipt_id: Option<String>,
    /// Optional attach-audience identity.
    pub attach_audience: Option<String>,
    /// Authentication mode without embedding secret material.
    pub auth_mode: HostedRuntimeAuthMode,
}

/// The transport-neutral, pre-start identity snapshot of one hosted Maestro
/// runtime generation.
///
/// This value describes configuration identity, not observed post-bind or
/// post-session state. In particular, a requested port `0` and a restored or
/// fallback session identity are not authoritative runtime observations here.
/// The existing hosted runner still owns its listener and child process; this
/// snapshot does not move either responsibility or change the wire topology.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedRuntimeBoundary {
    pub schema_version: String,
    pub topology: String,
    pub runner_session_id: String,
    pub workspace_root: String,
    pub bind_address: String,
    pub runtime_generation: u64,
    pub owner_instance_id: Option<String>,
    pub workspace_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub maestro_session_id: Option<String>,
    pub causal_receipt_id: Option<String>,
    pub attach_audience: Option<String>,
    pub auth_mode: HostedRuntimeAuthMode,
}

impl HostedRuntimeBoundary {
    /// Validates and constructs a pre-start hosted runtime boundary snapshot.
    ///
    /// The returned object contains authentication mode only; bearer values and
    /// projected-token contents or paths are never copied into the boundary.
    /// Listener and child-process ownership remains with the hosted runner.
    ///
    /// # Errors
    ///
    /// Returns a [`RuntimeBoundaryError`] when a required identity is empty or
    /// the workspace root is not absolute.
    pub fn new(input: HostedRuntimeBoundaryInput) -> Result<Self, RuntimeBoundaryError> {
        let runner_session_id = required(input.runner_session_id, "runner_session_id")?;
        let workspace_root = required(input.workspace_root, "workspace_root")?;
        if !Path::new(&workspace_root).is_absolute() {
            return Err(RuntimeBoundaryError::RelativeWorkspaceRoot);
        }
        let bind_address = required(input.bind_address, "bind_address")?;

        Ok(Self {
            schema_version: RUNTIME_BOUNDARY_VERSION.into(),
            topology: HOSTED_RUNTIME_TOPOLOGY.into(),
            runner_session_id,
            workspace_root,
            bind_address,
            runtime_generation: input.runtime_generation,
            owner_instance_id: input.owner_instance_id,
            workspace_id: input.workspace_id,
            agent_run_id: input.agent_run_id,
            maestro_session_id: input.maestro_session_id,
            causal_receipt_id: input.causal_receipt_id,
            attach_audience: input.attach_audience,
            auth_mode: input.auth_mode,
        })
    }
}

/// Validation failures returned while constructing a hosted runtime boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeBoundaryError {
    EmptyField(&'static str),
    RelativeWorkspaceRoot,
}

impl std::fmt::Display for RuntimeBoundaryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField(field) => write!(formatter, "{field} must not be empty"),
            Self::RelativeWorkspaceRoot => {
                formatter.write_str("workspace_root must be an absolute path")
            }
        }
    }
}

impl std::error::Error for RuntimeBoundaryError {}

fn required(value: String, field: &'static str) -> Result<String, RuntimeBoundaryError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(RuntimeBoundaryError::EmptyField(field));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_root() -> String {
        std::env::temp_dir()
            .join("maestro-runtime-test-workspace")
            .to_string_lossy()
            .into_owned()
    }

    fn boundary(auth_mode: HostedRuntimeAuthMode) -> HostedRuntimeBoundary {
        HostedRuntimeBoundary::new(HostedRuntimeBoundaryInput {
            runner_session_id: "runner-1".into(),
            workspace_root: workspace_root(),
            bind_address: "127.0.0.1:8080".into(),
            runtime_generation: 7,
            owner_instance_id: Some("owner-1".into()),
            workspace_id: Some("workspace-1".into()),
            agent_run_id: Some("run-1".into()),
            maestro_session_id: Some("session-1".into()),
            causal_receipt_id: Some("receipt-1".into()),
            attach_audience: Some("audience-1".into()),
            auth_mode,
        })
        .expect("boundary should be valid")
    }

    #[test]
    fn boundary_records_topology_without_secret_values() {
        let boundary = boundary(HostedRuntimeAuthMode::StaticBearer);
        let encoded = serde_json::to_string(&boundary).expect("boundary should serialize");

        assert_eq!(boundary.schema_version, RUNTIME_BOUNDARY_VERSION);
        assert_eq!(boundary.topology, HOSTED_RUNTIME_TOPOLOGY);
        assert_eq!(boundary.auth_mode, HostedRuntimeAuthMode::StaticBearer);
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn boundary_rejects_relative_workspace_roots() {
        assert_eq!(
            HostedRuntimeBoundary::new(HostedRuntimeBoundaryInput {
                runner_session_id: "runner-1".into(),
                workspace_root: "relative/workspace".into(),
                bind_address: "127.0.0.1:8080".into(),
                runtime_generation: 1,
                owner_instance_id: None,
                workspace_id: None,
                agent_run_id: None,
                maestro_session_id: None,
                causal_receipt_id: None,
                attach_audience: None,
                auth_mode: HostedRuntimeAuthMode::None,
            }),
            Err(RuntimeBoundaryError::RelativeWorkspaceRoot)
        );
    }
}

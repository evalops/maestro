use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::HostedRuntimeAuthMode;

/// Version of the resolved hosted-runner launch document.
pub const HOSTED_LAUNCH_SPEC_VERSION: &str = "evalops.maestro.hosted-launch-spec.v1";

/// A transport-neutral snapshot of one resolved hosted-runner launch.
///
/// This is a pre-start configuration document. It is immutable by contract:
/// startup derives it once at the compatibility edge, validates it, and uses
/// it for identity and redacted-digest evidence. It contains no secret values;
/// secret-bearing inputs are represented only by file references. It does not
/// observe a bound port, restored session, listener, or child process, and it
/// does not move listener or child ownership out of the hosted runner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchSpec {
    /// Versioned schema identity for this document.
    pub schema_version: String,
    /// Runtime coordinates and generation fencing inputs.
    pub runtime: HostedLaunchRuntime,
    /// Workspace and session identity inputs.
    pub workspace: HostedLaunchWorkspace,
    /// Authentication mode and optional projected identity coordinates.
    pub identity: HostedLaunchIdentity,
    /// Model/provider binding expected from the headless child.
    pub model: HostedLaunchModelContract,
    /// Snapshot and restore intent supplied before startup.
    pub restore: HostedLaunchRestoreIntent,
    /// Optional reverse-rendezvous configuration without its bootstrap value.
    pub rendezvous: Option<HostedLaunchRendezvous>,
    /// References to secret files; no file contents are present.
    pub secret_files: HostedLaunchSecretFileRefs,
    /// Optional executable used for the supervised headless child.
    pub headless_cli_path: Option<String>,
    /// Optional child profile selected at the compatibility edge.
    pub profile: Option<String>,
    /// Optional child agent directory.
    pub agent_dir: Option<String>,
    /// Optional Platform agent identity forwarded to the child.
    pub agent_id: Option<String>,
}

/// Typed input used to construct a hosted launch specification.
///
/// Keeping the input in one named value avoids a positional constructor whose
/// arity grows whenever the producer-owned pre-start contract grows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedLaunchSpecInput {
    /// Runtime coordinates and generation fencing inputs.
    pub runtime: HostedLaunchRuntime,
    /// Workspace and session identity inputs.
    pub workspace: HostedLaunchWorkspace,
    /// Authentication mode and optional projected identity coordinates.
    pub identity: HostedLaunchIdentity,
    /// Model/provider binding expected from the headless child.
    pub model: HostedLaunchModelContract,
    /// Snapshot and restore intent supplied before startup.
    pub restore: HostedLaunchRestoreIntent,
    /// Optional reverse-rendezvous configuration.
    pub rendezvous: Option<HostedLaunchRendezvous>,
    /// References to secret files; no file contents are present.
    pub secret_files: HostedLaunchSecretFileRefs,
    /// Optional executable used for the supervised headless child.
    pub headless_cli_path: Option<String>,
    /// Optional child profile selected at the compatibility edge.
    pub profile: Option<String>,
    /// Optional child agent directory.
    pub agent_dir: Option<String>,
    /// Optional Platform agent identity forwarded to the child.
    pub agent_id: Option<String>,
}

/// Runtime coordinates captured before listener bind or child startup.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchRuntime {
    /// Platform-issued runner identity.
    pub runner_session_id: String,
    /// Requested listener address; port `0` remains a request, not an observation.
    pub bind_address: String,
    /// Platform-owned generation used for fencing and receipts.
    pub runtime_generation: u64,
    /// Optional owner instance identity.
    pub owner_instance_id: Option<String>,
    /// Optional expected attach audience.
    pub attach_audience: Option<String>,
    /// Optional causal receipt identity.
    pub causal_receipt_id: Option<String>,
}

/// Workspace and session identity inputs for a hosted launch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchWorkspace {
    /// Absolute workspace root mounted into the runtime.
    pub root: String,
    /// Optional Platform workspace identity.
    pub workspace_id: Option<String>,
    /// Optional Platform AgentRun identity.
    pub agent_run_id: Option<String>,
    /// Optional configured Maestro session identity.
    pub maestro_session_id: Option<String>,
}

/// Authentication and workload-identity inputs for a hosted launch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchIdentity {
    /// Authentication mode without embedding bearer material.
    pub auth_mode: HostedRuntimeAuthMode,
    /// Projected workload identity coordinates, when that mode is selected.
    pub workload_identity: Option<HostedLaunchWorkloadIdentity>,
}

/// Non-secret projected workload identity references and coordinates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchWorkloadIdentity {
    /// Read-only projected Kubernetes token path.
    pub kubernetes_token_file: String,
    /// Read-only identity exchange CA path.
    pub identity_tls_ca_file: String,
    /// HTTPS identity exchange endpoint.
    pub identity_exchange_url: String,
    /// Platform organization identity.
    pub organization_id: String,
    /// Platform workspace identity used by the exchange.
    pub workspace_id: String,
    /// Platform sandbox identity.
    pub sandbox_id: String,
    /// Placement generation bound to the projected identity.
    pub placement_generation: u64,
}

/// Model and provider contract expected from the headless child.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchModelContract {
    /// Exact model identifier forwarded to the child.
    pub model: String,
    /// Optional managed gateway base URL.
    pub base_url: Option<String>,
    /// Optional managed gateway organization identity.
    pub organization_id: Option<String>,
    /// Optional managed gateway workspace identity.
    pub workspace_id: Option<String>,
    /// Optional managed provider identity.
    pub provider: Option<String>,
    /// Optional managed environment identity.
    pub environment: Option<String>,
    /// Optional managed credential name.
    pub credential_name: Option<String>,
    /// Optional managed team identity.
    pub team_id: Option<String>,
    /// Optional resident readiness contract revision.
    pub resident_contract_revision: Option<String>,
}

/// Snapshot and restore intent resolved before startup.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchRestoreIntent {
    /// Directory for drain snapshot manifests.
    pub snapshot_root: Option<String>,
    /// Optional snapshot manifest requested for restore.
    pub restore_manifest_path: Option<String>,
}

/// Typed rendezvous configuration with the bootstrap nonce represented only by
/// a file reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchRendezvous {
    /// Selected inbound, shadow, or outbound authority mode.
    pub mode: HostedLaunchRendezvousMode,
    /// Bounded host and port endpoint.
    pub endpoint: String,
    /// TLS server name.
    pub server_name: String,
    /// HTTPS identity exchange endpoint.
    pub identity_exchange_url: String,
    /// Platform activation identity.
    pub activation_id: String,
    /// File containing the validated bootstrap nonce.
    pub nonce_file: Option<String>,
    /// Whether a validated bootstrap nonce was supplied.
    pub nonce_present: bool,
}

/// Rendezvous authority modes represented in the launch document.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostedLaunchRendezvousMode {
    /// Existing inbound listener remains authoritative.
    Inbound,
    /// Outbound stream is observation-only.
    OutboundShadow,
    /// Outbound stream is command-authoritative.
    Outbound,
}

/// Secret-file references carried by a launch document.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedLaunchSecretFileRefs {
    /// Optional static bearer file reference.
    pub static_bearer: Option<String>,
    /// Optional managed gateway access-token file reference.
    pub managed_gateway_access_token: Option<String>,
    /// Optional projected workload token file reference.
    pub projected_workload_token: Option<String>,
    /// Optional projected identity CA file reference.
    pub identity_tls_ca: Option<String>,
}

impl HostedLaunchSpec {
    /// Constructs and validates one pre-start hosted launch snapshot.
    ///
    /// This constructor validates configuration identity only. It does not
    /// observe an assigned port, restored session, listener, or child process.
    /// Use [`Self::from_json_str`] for the stricter executable file descriptor
    /// path, which additionally requires absolute, mode-consistent references.
    pub fn new(input: HostedLaunchSpecInput) -> Result<Self, HostedLaunchSpecError> {
        let HostedLaunchSpecInput {
            runtime,
            workspace,
            identity,
            model,
            restore,
            rendezvous,
            secret_files,
            headless_cli_path,
            profile,
            agent_dir,
            agent_id,
        } = input;
        let spec = Self {
            schema_version: HOSTED_LAUNCH_SPEC_VERSION.to_string(),
            runtime,
            workspace,
            identity,
            model,
            restore,
            rendezvous,
            secret_files,
            headless_cli_path,
            profile,
            agent_dir,
            agent_id,
        };
        spec.validate()?;
        Ok(spec)
    }

    /// Parses and validates an executable versioned launch descriptor.
    ///
    /// This is the canonical file-input decoder. It rejects unknown JSON
    /// fields, unknown schema versions, incomplete secret-file tuples, and
    /// descriptors that cannot be used to launch the existing hosted runner.
    /// Secret files are referenced but never read by this transport-neutral
    /// package; the hosted-runner adapter reads them with bounded limits before
    /// listener bind.
    pub fn from_json_str(document: &str) -> Result<Self, HostedLaunchSpecError> {
        let spec: Self = serde_json::from_str(document)
            .map_err(|error| HostedLaunchSpecError::InvalidDocument(error.to_string()))?;
        spec.validate_for_launch()?;
        Ok(spec)
    }

    /// Validates the typed pre-start snapshot without requiring referenced
    /// files to exist. This preserves the legacy CLI/env snapshot path while
    /// the descriptor decoder remains strict and executable.
    pub fn validate(&self) -> Result<(), HostedLaunchSpecError> {
        if self.schema_version != HOSTED_LAUNCH_SPEC_VERSION {
            return Err(HostedLaunchSpecError::InvalidSchemaVersion {
                actual: self.schema_version.clone(),
            });
        }
        required(&self.runtime.runner_session_id, "runtime.runnerSessionId")?;
        required(&self.runtime.bind_address, "runtime.bindAddress")?;
        required(&self.workspace.root, "workspace.root")?;
        if !Path::new(&self.workspace.root).is_absolute() {
            return Err(HostedLaunchSpecError::RelativeWorkspaceRoot);
        }
        if self
            .workspace
            .maestro_session_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(HostedLaunchSpecError::EmptyField(
                "workspace.maestroSessionId",
            ));
        }
        if self
            .workspace
            .workspace_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(HostedLaunchSpecError::EmptyField("workspace.workspaceId"));
        }
        for (value, field) in [
            (
                self.runtime.owner_instance_id.as_deref(),
                "runtime.ownerInstanceId",
            ),
            (
                self.runtime.attach_audience.as_deref(),
                "runtime.attachAudience",
            ),
            (
                self.workspace.agent_run_id.as_deref(),
                "workspace.agentRunId",
            ),
            (self.agent_id.as_deref(), "agentId"),
        ] {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(HostedLaunchSpecError::EmptyField(field));
            }
        }
        required(&self.model.model, "model.model")?;

        match (
            self.identity.auth_mode,
            self.identity.workload_identity.is_some(),
        ) {
            (HostedRuntimeAuthMode::WorkloadIdentity, false) => {
                return Err(HostedLaunchSpecError::WorkloadIdentityRequired)
            }
            (HostedRuntimeAuthMode::None | HostedRuntimeAuthMode::StaticBearer, true) => {
                return Err(HostedLaunchSpecError::UnexpectedWorkloadIdentity)
            }
            _ => {}
        }

        for (value, field) in [
            (&self.restore.snapshot_root, "restore.snapshotRoot"),
            (
                &self.restore.restore_manifest_path,
                "restore.restoreManifestPath",
            ),
            (&self.secret_files.static_bearer, "secretFiles.staticBearer"),
            (
                &self.secret_files.managed_gateway_access_token,
                "secretFiles.managedGatewayAccessToken",
            ),
            (
                &self.secret_files.projected_workload_token,
                "secretFiles.projectedWorkloadToken",
            ),
            (
                &self.secret_files.identity_tls_ca,
                "secretFiles.identityTlsCa",
            ),
        ] {
            if let Some(value) = value {
                required(value, field)?;
            }
        }

        if let Some(workload) = self.identity.workload_identity.as_ref() {
            for (value, field) in [
                (
                    &workload.kubernetes_token_file,
                    "identity.workloadIdentity.kubernetesTokenFile",
                ),
                (
                    &workload.identity_tls_ca_file,
                    "identity.workloadIdentity.identityTlsCaFile",
                ),
                (
                    &workload.identity_exchange_url,
                    "identity.workloadIdentity.identityExchangeUrl",
                ),
                (
                    &workload.organization_id,
                    "identity.workloadIdentity.organizationId",
                ),
                (
                    &workload.workspace_id,
                    "identity.workloadIdentity.workspaceId",
                ),
                (&workload.sandbox_id, "identity.workloadIdentity.sandboxId"),
            ] {
                required(value, field)?;
            }
            if workload.placement_generation == 0 {
                return Err(HostedLaunchSpecError::InvalidPlacementGeneration);
            }
            if self.runtime.runtime_generation != workload.placement_generation {
                return Err(HostedLaunchSpecError::RuntimePlacementGenerationMismatch {
                    runtime: self.runtime.runtime_generation,
                    placement: workload.placement_generation,
                });
            }
        }

        if let Some(rendezvous) = self.rendezvous.as_ref() {
            required(&rendezvous.endpoint, "rendezvous.endpoint")?;
            required(&rendezvous.server_name, "rendezvous.serverName")?;
            required(
                &rendezvous.identity_exchange_url,
                "rendezvous.identityExchangeUrl",
            )?;
            required(&rendezvous.activation_id, "rendezvous.activationId")?;
        }
        Ok(())
    }

    /// Validates that this typed document is complete enough to execute.
    ///
    /// Unlike [`Self::validate`], this requires the complete managed-model
    /// tuple, rejects orphaned managed-gateway credentials, and requires
    /// absolute, mode-consistent secret descriptors. It still does not read
    /// secret files. The hosted-runner adapter performs those bounded reads
    /// before listener bind.
    pub fn validate_for_launch(&self) -> Result<(), HostedLaunchSpecError> {
        self.validate()?;
        validate_optional_model_contract(&self.model)?;
        if self.secret_files.managed_gateway_access_token.is_some() && self.model.base_url.is_none()
        {
            return Err(HostedLaunchSpecError::ManagedGatewaySecretRequiresModel);
        }
        if self.model.base_url.is_some() && self.secret_files.managed_gateway_access_token.is_none()
        {
            return Err(HostedLaunchSpecError::ManagedGatewaySecretRequired);
        }
        match self.identity.auth_mode {
            HostedRuntimeAuthMode::None => {
                if self.secret_files.static_bearer.is_some()
                    || self.secret_files.projected_workload_token.is_some()
                    || self.secret_files.identity_tls_ca.is_some()
                {
                    return Err(HostedLaunchSpecError::UnexpectedSecretFileReferences);
                }
            }
            HostedRuntimeAuthMode::StaticBearer => {
                require_absolute_ref(
                    self.secret_files.static_bearer.as_deref(),
                    "secretFiles.staticBearer",
                )?;
                if self.secret_files.projected_workload_token.is_some()
                    || self.secret_files.identity_tls_ca.is_some()
                {
                    return Err(HostedLaunchSpecError::UnexpectedSecretFileReferences);
                }
            }
            HostedRuntimeAuthMode::WorkloadIdentity => {
                let workload = self
                    .identity
                    .workload_identity
                    .as_ref()
                    .expect("validate checks workload identity presence");
                require_absolute_ref(
                    Some(workload.kubernetes_token_file.as_str()),
                    "identity.workloadIdentity.kubernetesTokenFile",
                )?;
                require_absolute_ref(
                    Some(workload.identity_tls_ca_file.as_str()),
                    "identity.workloadIdentity.identityTlsCaFile",
                )?;
                if self.secret_files.projected_workload_token.as_deref()
                    != Some(workload.kubernetes_token_file.as_str())
                    || self.secret_files.identity_tls_ca.as_deref()
                        != Some(workload.identity_tls_ca_file.as_str())
                {
                    return Err(HostedLaunchSpecError::SecretFileReferenceMismatch);
                }
                if self.secret_files.static_bearer.is_some() {
                    return Err(HostedLaunchSpecError::UnexpectedSecretFileReferences);
                }
            }
        }
        for (value, field) in [
            (&self.restore.snapshot_root, "restore.snapshotRoot"),
            (
                &self.restore.restore_manifest_path,
                "restore.restoreManifestPath",
            ),
            (
                &self.secret_files.managed_gateway_access_token,
                "secretFiles.managedGatewayAccessToken",
            ),
        ] {
            if let Some(value) = value {
                require_absolute_ref(Some(value.as_str()), field)?;
            }
        }
        if let Some(rendezvous) = self.rendezvous.as_ref() {
            if !matches!(rendezvous.mode, HostedLaunchRendezvousMode::Inbound) {
                if !rendezvous.nonce_present || rendezvous.nonce_file.is_none() {
                    return Err(HostedLaunchSpecError::RendezvousNonceRequired);
                }
                if self.identity.auth_mode != HostedRuntimeAuthMode::WorkloadIdentity {
                    return Err(HostedLaunchSpecError::RendezvousWorkloadIdentityRequired);
                }
                require_absolute_ref(rendezvous.nonce_file.as_deref(), "rendezvous.nonceFile")?;
            }
            validate_rendezvous_endpoint(&rendezvous.endpoint)?;
        }
        for (value, field) in [
            (&self.profile, "profile"),
            (&self.agent_dir, "agentDir"),
            (&self.headless_cli_path, "headlessCliPath"),
        ] {
            if let Some(value) = value {
                required(value, field)?;
            }
        }
        Ok(())
    }

    /// Returns a stable SHA-256 digest of this secret-free serialized snapshot.
    #[must_use]
    pub fn redacted_digest(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("HostedLaunchSpec is always serializable");
        let digest = Sha256::digest(bytes);
        format!("sha256:{digest:x}")
    }
}

/// Validation failures returned while constructing a hosted launch document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostedLaunchSpecError {
    /// A required identity or reference was empty.
    EmptyField(&'static str),
    /// The workspace root was not absolute.
    RelativeWorkspaceRoot,
    /// Workload identity mode was selected without its coordinates.
    WorkloadIdentityRequired,
    /// Workload identity coordinates were supplied for another auth mode.
    UnexpectedWorkloadIdentity,
    /// Placement generation zero cannot bind a workload identity.
    InvalidPlacementGeneration,
    /// Runtime and workload placement generations must fence the same launch.
    RuntimePlacementGenerationMismatch { runtime: u64, placement: u64 },
    /// The document did not use the one supported schema version.
    InvalidSchemaVersion { actual: String },
    /// The document could not be decoded as the typed schema.
    InvalidDocument(String),
    /// A file descriptor omitted or mixed incompatible secret references.
    UnexpectedSecretFileReferences,
    /// Workload identity references did not match their typed coordinates.
    SecretFileReferenceMismatch,
    /// A rendezvous descriptor did not include a nonce file reference.
    RendezvousNonceRequired,
    /// A rendezvous endpoint did not contain a non-empty host and non-zero port.
    InvalidRendezvousEndpoint,
    /// Outbound rendezvous requires projected workload identity credentials.
    RendezvousWorkloadIdentityRequired,
    /// A file reference must be absolute so startup cannot reinterpret it.
    RelativeFileReference(&'static str),
    /// A managed model contract contained only some of its required tuple.
    IncompleteModelContract,
    /// A managed model omitted its access-token file reference.
    ManagedGatewaySecretRequired,
    /// A managed gateway access-token reference was supplied without a model tuple.
    ManagedGatewaySecretRequiresModel,
}

impl std::fmt::Display for HostedLaunchSpecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField(field) => write!(formatter, "{field} must not be empty"),
            Self::RelativeWorkspaceRoot => formatter.write_str("workspace.root must be absolute"),
            Self::WorkloadIdentityRequired => formatter.write_str(
                "workload identity auth mode requires workload identity coordinates",
            ),
            Self::UnexpectedWorkloadIdentity => formatter.write_str(
                "workload identity coordinates require workload identity auth mode",
            ),
            Self::InvalidPlacementGeneration => {
                formatter.write_str("workload identity placement generation must be positive")
            }
            Self::RuntimePlacementGenerationMismatch { runtime, placement } => write!(
                formatter,
                "runtime generation {runtime} must match workload placement generation {placement}"
            ),
            Self::InvalidSchemaVersion { actual } => write!(
                formatter,
                "unsupported hosted launch spec schema version {actual:?}"
            ),
            Self::InvalidDocument(error) => {
                write!(formatter, "invalid hosted launch spec: {error}")
            }
            Self::UnexpectedSecretFileReferences => formatter.write_str(
                "hosted launch spec contains secret-file references incompatible with its auth mode",
            ),
            Self::SecretFileReferenceMismatch => formatter.write_str(
                "workload identity secret-file references must match the typed workload coordinates",
            ),
            Self::RendezvousNonceRequired => {
                formatter.write_str("rendezvous requires a nonce file reference")
            }
            Self::InvalidRendezvousEndpoint => formatter.write_str(
                "rendezvous.endpoint must be a bounded host:port with a non-zero u16 port",
            ),
            Self::RendezvousWorkloadIdentityRequired => {
                formatter.write_str("outbound rendezvous requires projected workload identity")
            }
            Self::RelativeFileReference(field) => {
                write!(formatter, "{field} must be an absolute file reference")
            }
            Self::IncompleteModelContract => formatter.write_str(
                "managed model launch contract requires base URL, organization, workspace, and provider",
            ),
            Self::ManagedGatewaySecretRequired => formatter.write_str(
                "managed model launch contract requires secretFiles.managedGatewayAccessToken",
            ),
            Self::ManagedGatewaySecretRequiresModel => formatter.write_str(
                "secretFiles.managedGatewayAccessToken requires a managed model launch contract",
            ),
        }
    }
}

impl std::error::Error for HostedLaunchSpecError {}

fn required(value: &str, field: &'static str) -> Result<(), HostedLaunchSpecError> {
    if value.trim().is_empty() {
        return Err(HostedLaunchSpecError::EmptyField(field));
    }
    Ok(())
}

fn require_absolute_ref(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), HostedLaunchSpecError> {
    let value = value.ok_or(HostedLaunchSpecError::EmptyField(field))?;
    required(value, field)?;
    if !Path::new(value).is_absolute() {
        return Err(HostedLaunchSpecError::RelativeFileReference(field));
    }
    Ok(())
}

fn validate_rendezvous_endpoint(endpoint: &str) -> Result<(), HostedLaunchSpecError> {
    if endpoint.len() > 512 {
        return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
    }
    let Some((raw_host, port)) = endpoint.rsplit_once(':') else {
        return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
    };
    if port.parse::<u16>().ok().is_none_or(|port| port == 0) {
        return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
    }
    let (host, bracketed) = if let Some(host) = raw_host.strip_prefix('[') {
        let Some(host) = host.strip_suffix(']') else {
            return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
        };
        (host, true)
    } else {
        if raw_host.contains(['[', ']', ':']) {
            return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
        }
        (raw_host, false)
    };
    if host.is_empty() || host.trim() != host {
        return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
    }
    if bracketed {
        if !matches!(
            host.parse::<std::net::IpAddr>(),
            Ok(std::net::IpAddr::V6(_))
        ) {
            return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
        }
    } else if host.parse::<std::net::IpAddr>().is_err() && !is_valid_dns_host(host) {
        return Err(HostedLaunchSpecError::InvalidRendezvousEndpoint);
    }
    Ok(())
}

fn is_valid_dns_host(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host);
    !host.is_empty()
        && host.len() <= 253
        && host.is_ascii()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn validate_optional_model_contract(
    model: &HostedLaunchModelContract,
) -> Result<(), HostedLaunchSpecError> {
    let managed_fields = [
        model.base_url.as_ref(),
        model.organization_id.as_ref(),
        model.workspace_id.as_ref(),
    ];
    if managed_fields.iter().any(Option::is_some)
        && (managed_fields.iter().any(Option::is_none) || model.provider.is_none())
    {
        return Err(HostedLaunchSpecError::IncompleteModelContract);
    }
    for (value, field) in [
        (&model.base_url, "model.baseUrl"),
        (&model.organization_id, "model.organizationId"),
        (&model.workspace_id, "model.workspaceId"),
        (&model.provider, "model.provider"),
        (&model.environment, "model.environment"),
        (&model.credential_name, "model.credentialName"),
        (&model.team_id, "model.teamId"),
        (
            &model.resident_contract_revision,
            "model.residentContractRevision",
        ),
    ] {
        if let Some(value) = value {
            required(value, field)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_spec() -> HostedLaunchSpec {
        HostedLaunchSpec::new(HostedLaunchSpecInput {
            runtime: HostedLaunchRuntime {
                runner_session_id: "runner-1".into(),
                bind_address: "127.0.0.1:0".into(),
                runtime_generation: 7,
                owner_instance_id: Some("owner-1".into()),
                attach_audience: Some("audience-1".into()),
                causal_receipt_id: Some("receipt-1".into()),
            },
            workspace: HostedLaunchWorkspace {
                root: "/workspace".into(),
                workspace_id: Some("workspace-1".into()),
                agent_run_id: Some("run-1".into()),
                maestro_session_id: Some("session-1".into()),
            },
            identity: HostedLaunchIdentity {
                auth_mode: HostedRuntimeAuthMode::StaticBearer,
                workload_identity: None,
            },
            model: HostedLaunchModelContract {
                model: "gpt-5.5".into(),
                base_url: None,
                organization_id: None,
                workspace_id: None,
                provider: Some("test".into()),
                environment: None,
                credential_name: None,
                team_id: None,
                resident_contract_revision: None,
            },
            restore: HostedLaunchRestoreIntent {
                snapshot_root: Some("/workspace/.maestro/snapshots".into()),
                restore_manifest_path: None,
            },
            rendezvous: None,
            secret_files: HostedLaunchSecretFileRefs {
                static_bearer: Some("/run/secrets/maestro-bearer".into()),
                ..HostedLaunchSecretFileRefs::default()
            },
            headless_cli_path: None,
            profile: None,
            agent_dir: None,
            agent_id: Some("agent-1".into()),
        })
        .expect("launch spec should be valid")
    }

    #[test]
    fn launch_spec_is_versioned_and_digest_excludes_secret_values() {
        let mut spec = base_spec();
        let digest = spec.redacted_digest();
        spec.secret_files.static_bearer = Some("/run/secrets/rotated-bearer".into());
        let rotated_digest = spec.redacted_digest();
        let encoded = serde_json::to_string(&spec).expect("launch spec should serialize");

        assert_eq!(spec.schema_version, HOSTED_LAUNCH_SPEC_VERSION);
        assert_ne!(digest, rotated_digest);
        assert!(encoded.contains("rotated-bearer"));
        assert!(!encoded.contains("bearer-token-value"));
        assert!(!encoded.contains("projected-token-value"));
    }

    #[test]
    fn executable_decode_rejects_unknown_schema_and_fields() {
        let mut value = serde_json::to_value(base_spec()).expect("serialize base spec");
        value["unexpectedField"] = json!(true);
        let error = HostedLaunchSpec::from_json_str(&value.to_string())
            .expect_err("unknown fields must fail closed");
        assert!(error.to_string().contains("unknown field"));

        let mut value = serde_json::to_value(base_spec()).expect("serialize base spec");
        value["schemaVersion"] = json!("evalops.maestro.hosted-launch-spec.v2");
        let error = HostedLaunchSpec::from_json_str(&value.to_string())
            .expect_err("unknown schema versions must fail closed");
        assert!(matches!(
            error,
            HostedLaunchSpecError::InvalidSchemaVersion { .. }
        ));
    }

    #[test]
    fn launch_spec_preserves_port_zero_as_a_request() {
        let spec = base_spec();
        assert_eq!(spec.runtime.bind_address, "127.0.0.1:0");
    }

    #[test]
    fn legacy_snapshot_may_omit_nonce_file_but_executable_decode_may_not() {
        let mut spec = base_spec();
        spec.rendezvous = Some(HostedLaunchRendezvous {
            mode: HostedLaunchRendezvousMode::OutboundShadow,
            endpoint: "rendezvous.example:443".into(),
            server_name: "rendezvous.example".into(),
            identity_exchange_url: "https://identity.example/exchange".into(),
            activation_id: "00000000-0000-0000-0000-000000000008".into(),
            nonce_file: None,
            nonce_present: true,
        });

        spec.validate()
            .expect("legacy snapshot validation must not require secret paths");
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("executable descriptor must carry the nonce file reference");
        assert_eq!(error, HostedLaunchSpecError::RendezvousNonceRequired);
    }

    #[test]
    fn legacy_snapshot_allows_partial_model_metadata_but_executable_decode_rejects_it() {
        let mut spec = base_spec();
        spec.model.base_url = Some("https://gateway.example/v1".into());
        spec.model.provider = None;

        spec.validate()
            .expect("legacy snapshot validation must preserve partial model metadata");
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("executable descriptor must require a complete managed model tuple");
        assert_eq!(error, HostedLaunchSpecError::IncompleteModelContract);
    }

    #[test]
    fn executable_decode_rejects_outbound_rendezvous_without_workload_identity() {
        let mut spec = base_spec();
        spec.rendezvous = Some(HostedLaunchRendezvous {
            mode: HostedLaunchRendezvousMode::OutboundShadow,
            endpoint: "rendezvous.example:443".into(),
            server_name: "rendezvous.example".into(),
            identity_exchange_url: "https://identity.example/exchange".into(),
            activation_id: "00000000-0000-0000-0000-000000000008".into(),
            nonce_file: Some("/run/secrets/rendezvous-nonce".into()),
            nonce_present: true,
        });

        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("outbound rendezvous must require workload identity");
        assert_eq!(
            error,
            HostedLaunchSpecError::RendezvousWorkloadIdentityRequired
        );
    }

    #[test]
    fn workload_identity_generation_must_match_runtime_generation() {
        let mut spec = base_spec();
        spec.identity = HostedLaunchIdentity {
            auth_mode: HostedRuntimeAuthMode::WorkloadIdentity,
            workload_identity: Some(HostedLaunchWorkloadIdentity {
                kubernetes_token_file: "/var/run/secrets/token".into(),
                identity_tls_ca_file: "/var/run/secrets/ca.pem".into(),
                identity_exchange_url: "https://identity.example/exchange".into(),
                organization_id: "org-1".into(),
                workspace_id: "workspace-1".into(),
                sandbox_id: "00000000-0000-0000-0000-000000000009".into(),
                placement_generation: 8,
            }),
        };
        spec.secret_files = HostedLaunchSecretFileRefs {
            projected_workload_token: Some("/var/run/secrets/token".into()),
            identity_tls_ca: Some("/var/run/secrets/ca.pem".into()),
            ..HostedLaunchSecretFileRefs::default()
        };

        let error = spec
            .validate()
            .expect_err("generation mismatch must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::RuntimePlacementGenerationMismatch {
                runtime: 7,
                placement: 8,
            }
        );
    }

    #[test]
    fn executable_decode_rejects_blank_maestro_session_id() {
        let mut spec = base_spec();
        spec.workspace.maestro_session_id = Some(" \t".into());

        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank session identity must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::EmptyField("workspace.maestroSessionId")
        );
    }

    #[test]
    fn executable_decode_rejects_blank_workspace_id() {
        let mut spec = base_spec();
        spec.workspace.workspace_id = Some(" \t".into());

        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank workspace identity must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::EmptyField("workspace.workspaceId")
        );
    }

    #[test]
    fn executable_decode_rejects_blank_optional_identity_fields() {
        let mut spec = base_spec();
        spec.runtime.owner_instance_id = Some(" \t".into());
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank owner identity must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::EmptyField("runtime.ownerInstanceId")
        );

        spec.runtime.owner_instance_id = None;
        spec.runtime.attach_audience = Some(" \t".into());
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank attach audience must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::EmptyField("runtime.attachAudience")
        );

        spec.runtime.attach_audience = None;
        spec.workspace.agent_run_id = Some(" \t".into());
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank agent-run identity must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::EmptyField("workspace.agentRunId")
        );

        spec.workspace.agent_run_id = None;
        spec.agent_id = Some(" 	".into());
        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("blank agent identity must fail closed");
        assert_eq!(error, HostedLaunchSpecError::EmptyField("agentId"));
    }

    #[test]
    fn executable_decode_rejects_invalid_rendezvous_endpoints() {
        for endpoint in [
            "rendezvous.example:not-a-port",
            ":443",
            "rendezvous.example:0",
            "rendezvous.example:65536",
            "bad host:443",
            "-bad.example:443",
            "bad_.example:443",
            "[127.0.0.1]:443",
            "[::1:443",
        ] {
            let mut spec = base_spec();
            spec.rendezvous = Some(HostedLaunchRendezvous {
                mode: HostedLaunchRendezvousMode::Inbound,
                endpoint: endpoint.into(),
                server_name: "rendezvous.example".into(),
                identity_exchange_url: "https://identity.example/exchange".into(),
                activation_id: "00000000-0000-0000-0000-000000000008".into(),
                nonce_file: None,
                nonce_present: false,
            });

            let error = HostedLaunchSpec::from_json_str(
                &serde_json::to_string(&spec).expect("snapshot should serialize"),
            )
            .expect_err("invalid endpoint must fail closed");
            assert_eq!(error, HostedLaunchSpecError::InvalidRendezvousEndpoint);
        }
    }

    #[test]
    fn executable_decode_accepts_dns_ipv4_and_bracketed_ipv6_rendezvous_endpoints() {
        for endpoint in ["rendezvous.example:443", "127.0.0.1:443", "[::1]:443"] {
            let mut spec = base_spec();
            spec.rendezvous = Some(HostedLaunchRendezvous {
                mode: HostedLaunchRendezvousMode::Inbound,
                endpoint: endpoint.into(),
                server_name: "rendezvous.example".into(),
                identity_exchange_url: "https://identity.example/exchange".into(),
                activation_id: "00000000-0000-0000-0000-000000000008".into(),
                nonce_file: None,
                nonce_present: false,
            });

            HostedLaunchSpec::from_json_str(
                &serde_json::to_string(&spec).expect("snapshot should serialize"),
            )
            .expect("valid rendezvous endpoint should be accepted");
        }
    }

    #[test]
    fn executable_decode_rejects_orphaned_managed_gateway_secret() {
        let mut spec = base_spec();
        spec.secret_files.managed_gateway_access_token =
            Some("/run/secrets/managed-gateway-token".into());

        let error = HostedLaunchSpec::from_json_str(
            &serde_json::to_string(&spec).expect("snapshot should serialize"),
        )
        .expect_err("orphaned managed gateway secret must fail closed");
        assert_eq!(
            error,
            HostedLaunchSpecError::ManagedGatewaySecretRequiresModel
        );
    }

    #[test]
    fn workload_identity_requires_complete_typed_coordinates() {
        let error = HostedLaunchSpec::new(HostedLaunchSpecInput {
            runtime: HostedLaunchRuntime {
                runner_session_id: "runner-1".into(),
                bind_address: "127.0.0.1:8080".into(),
                runtime_generation: 1,
                owner_instance_id: None,
                attach_audience: None,
                causal_receipt_id: None,
            },
            workspace: HostedLaunchWorkspace {
                root: "/workspace".into(),
                workspace_id: None,
                agent_run_id: None,
                maestro_session_id: None,
            },
            identity: HostedLaunchIdentity {
                auth_mode: HostedRuntimeAuthMode::WorkloadIdentity,
                workload_identity: None,
            },
            model: HostedLaunchModelContract {
                model: "gpt-5.5".into(),
                base_url: None,
                organization_id: None,
                workspace_id: None,
                provider: None,
                environment: None,
                credential_name: None,
                team_id: None,
                resident_contract_revision: None,
            },
            restore: HostedLaunchRestoreIntent {
                snapshot_root: None,
                restore_manifest_path: None,
            },
            rendezvous: None,
            secret_files: HostedLaunchSecretFileRefs::default(),
            headless_cli_path: None,
            profile: None,
            agent_dir: None,
            agent_id: None,
        })
        .expect_err("missing workload identity must fail closed");
        assert_eq!(error, HostedLaunchSpecError::WorkloadIdentityRequired);
    }

    #[test]
    fn canonical_fixture_is_a_redacted_versioned_shape() {
        let fixture: HostedLaunchSpec =
            serde_json::from_str(include_str!("../fixtures/hosted-launch-spec-v1.json"))
                .expect("launch spec fixture should be valid JSON");
        fixture
            .validate()
            .expect("fixture should satisfy typed shape");
        assert_eq!(fixture.schema_version, HOSTED_LAUNCH_SPEC_VERSION);
        let encoded = serde_json::to_string(&fixture).expect("fixture should serialize");
        assert!(!encoded.contains("token-value"));
    }
}

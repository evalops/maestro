//! Producer-owned lifecycle evidence for one hosted Maestro generation.
//!
//! The receipt is a transport-neutral snapshot of evidence already made
//! durable by the hosted runtime. It does not accept terminal state, persist
//! tenant state, own retries, or move listener/child ownership from Maestro.

use serde::{Deserialize, Serialize};

/// Version of the serialized hosted runtime receipt contract.
pub const RUNTIME_RECEIPT_VERSION: &str = "evalops.maestro.runtime-receipt.v1";
/// Maximum UTF-8 byte length of a receipt identity or bounded metadata field.
pub const MAX_RUNTIME_RECEIPT_STRING_BYTES: usize = 256;
const RUNTIME_RECEIPT_REQUIRES_DURABLE_FLUSH: bool = true;
const RUNTIME_RECEIPT_TERMINAL_REQUIRES_CLASSIFICATION: bool = true;
const RUNTIME_RECEIPT_NON_TERMINAL_REJECTS_TERMINAL: bool = true;
const RUNTIME_RECEIPT_FAILED_REQUIRES_ERROR_TYPE: bool = true;
const RUNTIME_RECEIPT_NON_FAILED_REJECTS_ERROR_TYPE: bool = true;

/// Define a serde enum and generate its complete wire-value projection from
/// the same declaration. The compatibility fixture tests consume `all()` so
/// adding a variant necessarily changes the typed projection and fails until
/// the checked-in producer contract is updated.
macro_rules! define_runtime_wire_enum {
    (
        $(#[$enum_meta:meta])*
        $vis:vis enum $name:ident {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident
            ),+ $(,)?
        }
    ) => {
        $(#[$enum_meta])*
        $vis enum $name {
            $(
                $(#[$variant_meta])*
                $variant
            ),+
        }

        impl $name {
            /// Returns every declared wire value in producer declaration order.
            #[must_use]
            pub const fn all() -> &'static [Self] {
                &[$(Self::$variant),+]
            }
        }
    };
}

define_runtime_wire_enum! {
/// Boundary at which a hosted runtime receipt was produced.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeReceiptKind {
    /// The generation has completed its local execution-readiness boundary.
    Ready,
    /// The generation was initialized from a validated durable snapshot.
    Restored,
    /// A producer terminal event was durably observed.
    Terminal,
    /// A fatal runtime failure was durably observed.
    Failed,
    /// The generation entered the local drain boundary.
    Draining,
    /// The generation completed the local drain boundary.
    Drained,
}
}

define_runtime_wire_enum! {
/// Lifecycle state observed by a hosted runtime receipt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLifecycleState {
    /// Startup has begun but execution readiness is not established.
    Starting,
    /// Pre-start identity exchange has completed.
    IdentityBound,
    /// The child/runtime is ready to accept execution.
    ExecutionReady,
    /// The generation has active execution or attached work.
    Active,
    /// Local drain has started and new work is fenced.
    Draining,
    /// Local drain has completed.
    Drained,
    /// The generation has durably failed.
    Failed,
}
}

define_runtime_wire_enum! {
/// Terminal classification observed by the producer-owned runtime.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTerminalClassification {
    /// The producer completed the turn successfully.
    Completed,
    /// The producer interrupted the turn.
    Interrupted,
    /// The provider reported a terminal failure.
    ProviderFailed,
    /// The runtime reported a fatal terminal error.
    Fatal,
    /// The producer cancelled the turn without a fatal runtime failure.
    Cancelled,
    /// The producer reported a protocol-level terminal error.
    Protocol,
    /// The producer reported a tool-level terminal error.
    Tool,
    /// The producer reported a transient terminal error.
    Transient,
    /// The producer reported a nonfatal terminal error without a typed class.
    NonFatal,
}
}

const fn required_lifecycle_for_kind(kind: RuntimeReceiptKind) -> RuntimeLifecycleState {
    match kind {
        RuntimeReceiptKind::Ready | RuntimeReceiptKind::Restored => {
            RuntimeLifecycleState::ExecutionReady
        }
        RuntimeReceiptKind::Terminal => RuntimeLifecycleState::Active,
        RuntimeReceiptKind::Failed => RuntimeLifecycleState::Failed,
        RuntimeReceiptKind::Draining => RuntimeLifecycleState::Draining,
        RuntimeReceiptKind::Drained => RuntimeLifecycleState::Drained,
    }
}

/// Returns the producer-owned validation projection included in the
/// compatibility digest. The checked-in JSON fixture is tested against this
/// live projection so changes to non-structural receipt acceptance rules are
/// visible to compatibility consumers as well.
#[must_use]
pub fn runtime_receipt_validation_contract() -> serde_json::Value {
    let kind_lifecycle = RuntimeReceiptKind::all()
        .iter()
        .map(|kind| {
            let kind_name = serde_json::to_value(kind)
                .expect("runtime receipt kind must serialize")
                .as_str()
                .expect("runtime receipt kind must serialize as a string")
                .to_string();
            let lifecycle = serde_json::to_value(required_lifecycle_for_kind(*kind))
                .expect("runtime receipt lifecycle must serialize");
            (kind_name, serde_json::json!([lifecycle]))
        })
        .collect::<serde_json::Map<_, _>>();

    serde_json::json!({
        "maxStringBytes": MAX_RUNTIME_RECEIPT_STRING_BYTES,
        "requiresDurableFlush": RUNTIME_RECEIPT_REQUIRES_DURABLE_FLUSH,
        "terminalRequiresClassification": RUNTIME_RECEIPT_TERMINAL_REQUIRES_CLASSIFICATION,
        "nonTerminalRejectsTerminal": RUNTIME_RECEIPT_NON_TERMINAL_REJECTS_TERMINAL,
        "failedRequiresErrorType": RUNTIME_RECEIPT_FAILED_REQUIRES_ERROR_TYPE,
        "nonFailedRejectsErrorType": RUNTIME_RECEIPT_NON_FAILED_REJECTS_ERROR_TYPE,
        "kindLifecycle": kind_lifecycle,
    })
}

/// Input used to derive one generation-bound runtime receipt.
///
/// `flush_watermark` is the monotonic revision of the durable local journal,
/// not a byte offset or an observation of a bound listener. The caller must
/// supply it only after the journal persistence operation succeeds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeReceiptInput {
    /// Boundary at which this evidence was produced.
    pub kind: RuntimeReceiptKind,
    /// Lifecycle state represented by the evidence.
    pub lifecycle_state: RuntimeLifecycleState,
    /// Platform-owned generation fence.
    pub runtime_generation: u64,
    /// Hosted runner identity for this generation.
    pub runner_session_id: String,
    /// Durable Maestro session identity.
    pub maestro_session_id: String,
    /// Optional Platform workspace identity.
    pub workspace_id: Option<String>,
    /// Optional Platform AgentRun identity.
    pub agent_run_id: Option<String>,
    /// Model binding observed in the local runtime state.
    pub model: Option<String>,
    /// Provider binding observed in the local runtime state.
    pub provider: Option<String>,
    /// Digest of the producer-owned headless capability projection.
    pub capability_digest: String,
    /// Replay cursor in the hosted durable journal.
    pub replay_cursor: u64,
    /// Successful flush revision in the hosted durable journal.
    pub flush_watermark: u64,
    /// Opaque snapshot lineage identity, when restore/drain continuity exists.
    pub snapshot_lineage: Option<String>,
    /// Producer terminal classification, present only for terminal evidence.
    pub terminal: Option<RuntimeTerminalClassification>,
    /// Bounded machine-readable failure category, without an error message.
    pub error_type: Option<String>,
}

/// Generation-bound lifecycle evidence exposed by the hosted runtime.
///
/// This object is derived after a local journal flush. It is evidence for
/// Platform to persist and decide from; it is not Platform's terminal
/// acceptance, retry, recovery, receipt, or teardown decision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeReceipt {
    /// Versioned receipt contract identity.
    pub schema_version: String,
    /// Boundary that produced this receipt.
    pub kind: RuntimeReceiptKind,
    /// Lifecycle state observed at the boundary.
    pub lifecycle_state: RuntimeLifecycleState,
    /// Platform-owned generation fence.
    pub runtime_generation: u64,
    /// Hosted runner identity for this generation.
    pub runner_session_id: String,
    /// Durable Maestro session identity.
    pub maestro_session_id: String,
    /// Optional Platform workspace identity.
    pub workspace_id: Option<String>,
    /// Optional Platform AgentRun identity.
    pub agent_run_id: Option<String>,
    /// Model binding observed in the local runtime state.
    pub model: Option<String>,
    /// Provider binding observed in the local runtime state.
    pub provider: Option<String>,
    /// Digest of the producer-owned headless capability projection.
    pub capability_digest: String,
    /// Replay cursor in the hosted durable journal.
    pub replay_cursor: u64,
    /// Successful flush revision in the hosted durable journal.
    pub flush_watermark: u64,
    /// Opaque snapshot lineage identity, when restore/drain continuity exists.
    pub snapshot_lineage: Option<String>,
    /// Producer terminal classification, when this is terminal evidence.
    pub terminal: Option<RuntimeTerminalClassification>,
    /// Bounded machine-readable failure category, without an error message.
    pub error_type: Option<String>,
}

impl RuntimeReceipt {
    /// Derive and validate a receipt from evidence made durable by the local
    /// hosted journal.
    ///
    /// This function does not inspect a listener, child process, tenant store,
    /// or Platform state. In particular, a requested port `0` and a restored
    /// or fallback session identity are not post-bind observations here.
    pub fn derive(input: RuntimeReceiptInput) -> Result<Self, RuntimeReceiptError> {
        let RuntimeReceiptInput {
            kind,
            lifecycle_state,
            runtime_generation,
            runner_session_id,
            maestro_session_id,
            workspace_id,
            agent_run_id,
            model,
            provider,
            capability_digest,
            replay_cursor,
            flush_watermark,
            snapshot_lineage,
            terminal,
            error_type,
        } = input;

        let runner_session_id = required(runner_session_id, "runner_session_id")?;
        let maestro_session_id = required(maestro_session_id, "maestro_session_id")?;
        let capability_digest = required(capability_digest, "capability_digest")?;
        let workspace_id = bounded_optional(workspace_id, "workspace_id")?;
        let agent_run_id = bounded_optional(agent_run_id, "agent_run_id")?;
        let model = bounded_optional(model, "model")?;
        let provider = bounded_optional(provider, "provider")?;
        let snapshot_lineage = bounded_optional(snapshot_lineage, "snapshot_lineage")?;
        let error_type = bounded_optional(error_type, "error_type")?;

        if RUNTIME_RECEIPT_REQUIRES_DURABLE_FLUSH && flush_watermark == 0 {
            return Err(RuntimeReceiptError::MissingDurableFlush);
        }
        if RUNTIME_RECEIPT_TERMINAL_REQUIRES_CLASSIFICATION
            && matches!(kind, RuntimeReceiptKind::Terminal)
            && terminal.is_none()
        {
            return Err(RuntimeReceiptError::TerminalClassificationRequired);
        }
        if RUNTIME_RECEIPT_NON_TERMINAL_REJECTS_TERMINAL
            && !matches!(kind, RuntimeReceiptKind::Terminal)
            && terminal.is_some()
        {
            return Err(RuntimeReceiptError::UnexpectedTerminalClassification);
        }
        if matches!(kind, RuntimeReceiptKind::Failed) {
            if RUNTIME_RECEIPT_FAILED_REQUIRES_ERROR_TYPE && error_type.is_none() {
                return Err(RuntimeReceiptError::FailureTypeRequired);
            }
        } else if RUNTIME_RECEIPT_NON_FAILED_REJECTS_ERROR_TYPE && error_type.is_some() {
            return Err(RuntimeReceiptError::UnexpectedErrorType);
        }
        if lifecycle_state != required_lifecycle_for_kind(kind) {
            return Err(RuntimeReceiptError::InvalidLifecycleForKind);
        }

        Ok(Self {
            schema_version: RUNTIME_RECEIPT_VERSION.to_string(),
            kind,
            lifecycle_state,
            runtime_generation,
            runner_session_id,
            maestro_session_id,
            workspace_id,
            agent_run_id,
            model,
            provider,
            capability_digest,
            replay_cursor,
            flush_watermark,
            snapshot_lineage,
            terminal,
            error_type,
        })
    }

    /// Parse and validate a serialized receipt at a compatibility edge.
    ///
    /// Deserializing the struct directly still rejects unknown fields, while
    /// this helper additionally rejects an unsupported `schemaVersion`.
    pub fn from_json_str(value: &str) -> Result<Self, RuntimeReceiptError> {
        let receipt = serde_json::from_str::<Self>(value)
            .map_err(|error| RuntimeReceiptError::InvalidJson(error.to_string()))?;
        receipt.validate()?;
        Ok(receipt)
    }

    /// Validate the version and evidence invariants of a decoded receipt.
    pub fn validate(&self) -> Result<(), RuntimeReceiptError> {
        if self.schema_version != RUNTIME_RECEIPT_VERSION {
            return Err(RuntimeReceiptError::UnsupportedSchemaVersion);
        }
        validate_serialized_field_length(&self.runner_session_id, "runner_session_id")?;
        validate_serialized_field_length(&self.maestro_session_id, "maestro_session_id")?;
        validate_serialized_field_length(&self.capability_digest, "capability_digest")?;
        for (value, field) in [
            (self.workspace_id.as_deref(), "workspace_id"),
            (self.agent_run_id.as_deref(), "agent_run_id"),
            (self.model.as_deref(), "model"),
            (self.provider.as_deref(), "provider"),
            (self.snapshot_lineage.as_deref(), "snapshot_lineage"),
            (self.error_type.as_deref(), "error_type"),
        ] {
            if let Some(value) = value {
                validate_serialized_field_length(value, field)?;
            }
        }
        Self::derive(RuntimeReceiptInput {
            kind: self.kind,
            lifecycle_state: self.lifecycle_state,
            runtime_generation: self.runtime_generation,
            runner_session_id: self.runner_session_id.clone(),
            maestro_session_id: self.maestro_session_id.clone(),
            workspace_id: self.workspace_id.clone(),
            agent_run_id: self.agent_run_id.clone(),
            model: self.model.clone(),
            provider: self.provider.clone(),
            capability_digest: self.capability_digest.clone(),
            replay_cursor: self.replay_cursor,
            flush_watermark: self.flush_watermark,
            snapshot_lineage: self.snapshot_lineage.clone(),
            terminal: self.terminal,
            error_type: self.error_type.clone(),
        })
        .map(|_| ())
    }
}

/// Validation errors for a generation-bound runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeReceiptError {
    /// A required identity or digest was empty.
    EmptyField(&'static str),
    /// An optional field exceeded the bounded receipt size.
    FieldTooLong(&'static str),
    /// The receipt was created before a successful local journal flush.
    MissingDurableFlush,
    /// Terminal evidence must identify its producer terminal class.
    TerminalClassificationRequired,
    /// Non-terminal evidence cannot claim a terminal class.
    UnexpectedTerminalClassification,
    /// Failure evidence must identify a machine-readable failure category.
    FailureTypeRequired,
    /// Non-failure evidence cannot claim a failure category.
    UnexpectedErrorType,
    /// The kind and lifecycle state do not describe the same boundary.
    InvalidLifecycleForKind,
    /// The serialized receipt schema is newer or otherwise unsupported.
    UnsupportedSchemaVersion,
    /// The serialized receipt was not valid JSON for this contract.
    InvalidJson(String),
}

impl std::fmt::Display for RuntimeReceiptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField(field) => write!(formatter, "{field} must not be empty"),
            Self::FieldTooLong(field) => write!(formatter, "{field} exceeds receipt size limit"),
            Self::MissingDurableFlush => {
                formatter.write_str("receipt requires a successful durable journal flush")
            }
            Self::TerminalClassificationRequired => {
                formatter.write_str("terminal receipt requires a terminal classification")
            }
            Self::UnexpectedTerminalClassification => {
                formatter.write_str("non-terminal receipt cannot contain a terminal classification")
            }
            Self::FailureTypeRequired => {
                formatter.write_str("failed receipt requires an error type")
            }
            Self::UnexpectedErrorType => {
                formatter.write_str("non-failed receipt cannot contain an error type")
            }
            Self::InvalidLifecycleForKind => {
                formatter.write_str("receipt kind and lifecycle state are inconsistent")
            }
            Self::UnsupportedSchemaVersion => {
                formatter.write_str("unsupported runtime receipt schema version")
            }
            Self::InvalidJson(error) => write!(formatter, "invalid runtime receipt JSON: {error}"),
        }
    }
}

impl std::error::Error for RuntimeReceiptError {}

fn required(value: String, field: &'static str) -> Result<String, RuntimeReceiptError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(RuntimeReceiptError::EmptyField(field));
    }
    if value.len() > MAX_RUNTIME_RECEIPT_STRING_BYTES {
        return Err(RuntimeReceiptError::FieldTooLong(field));
    }
    Ok(value)
}

fn validate_serialized_field_length(
    value: &str,
    field: &'static str,
) -> Result<(), RuntimeReceiptError> {
    if value.len() > MAX_RUNTIME_RECEIPT_STRING_BYTES {
        return Err(RuntimeReceiptError::FieldTooLong(field));
    }
    Ok(())
}

fn bounded_optional(
    value: Option<String>,
    field: &'static str,
) -> Result<Option<String>, RuntimeReceiptError> {
    value.map(|value| required(value, field)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless_protocol_capability_digest;

    const RUNTIME_RECEIPT_FIXTURE: &str = include_str!("../fixtures/runtime-receipt-v1.json");
    const RUNTIME_RECEIPT_CONTRACT_FIXTURE: &str =
        include_str!("../fixtures/runtime-receipt-contract-v1.json");

    fn input(kind: RuntimeReceiptKind) -> RuntimeReceiptInput {
        RuntimeReceiptInput {
            kind,
            lifecycle_state: match kind {
                RuntimeReceiptKind::Ready | RuntimeReceiptKind::Restored => {
                    RuntimeLifecycleState::ExecutionReady
                }
                RuntimeReceiptKind::Failed => RuntimeLifecycleState::Failed,
                RuntimeReceiptKind::Draining => RuntimeLifecycleState::Draining,
                RuntimeReceiptKind::Drained => RuntimeLifecycleState::Drained,
                RuntimeReceiptKind::Terminal => RuntimeLifecycleState::Active,
            },
            runtime_generation: 7,
            runner_session_id: "runner-7".into(),
            maestro_session_id: "maestro-7".into(),
            workspace_id: Some("workspace-7".into()),
            agent_run_id: Some("run-7".into()),
            model: Some("model-7".into()),
            provider: Some("provider-7".into()),
            capability_digest: headless_protocol_capability_digest(),
            replay_cursor: 4,
            flush_watermark: 5,
            snapshot_lineage: Some("snapshot-7".into()),
            terminal: (kind == RuntimeReceiptKind::Terminal)
                .then_some(RuntimeTerminalClassification::Completed),
            error_type: (kind == RuntimeReceiptKind::Failed).then_some("event_pump_failed".into()),
        }
    }

    #[test]
    fn receipt_round_trips_with_generation_and_durable_evidence() {
        let receipt = RuntimeReceipt::derive(input(RuntimeReceiptKind::Ready)).unwrap();
        let encoded = serde_json::to_string(&receipt).unwrap();
        let decoded = RuntimeReceipt::from_json_str(&encoded).unwrap();

        assert_eq!(decoded, receipt);
        assert_eq!(receipt.schema_version, RUNTIME_RECEIPT_VERSION);
        assert_eq!(receipt.runtime_generation, 7);
        assert_eq!(receipt.replay_cursor, 4);
        assert_eq!(receipt.flush_watermark, 5);
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn checked_in_fixture_matches_typed_receipt_contract() {
        let receipt = RuntimeReceipt::from_json_str(RUNTIME_RECEIPT_FIXTURE).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(RUNTIME_RECEIPT_FIXTURE).unwrap();

        assert_eq!(receipt.schema_version, RUNTIME_RECEIPT_VERSION);
        assert_eq!(serde_json::to_value(receipt).unwrap(), fixture);
    }

    #[test]
    fn checked_in_contract_fixture_matches_all_typed_receipt_variants() {
        let contract: serde_json::Value =
            serde_json::from_str(RUNTIME_RECEIPT_CONTRACT_FIXTURE).unwrap();
        assert_eq!(contract["schemaVersion"], RUNTIME_RECEIPT_VERSION);
        assert_eq!(contract["rejectsUnknownFields"], true);
        assert_eq!(
            contract["validation"],
            runtime_receipt_validation_contract()
        );

        let mut fields =
            serde_json::to_value(RuntimeReceipt::derive(input(RuntimeReceiptKind::Ready)).unwrap())
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
        fields.sort_unstable();
        let mut fixture_fields = contract["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        fixture_fields.sort_unstable();
        assert_eq!(fields, fixture_fields);

        let kind_values = RuntimeReceiptKind::all()
            .iter()
            .copied()
            .map(|value| serde_json::to_value(value).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            contract["kindValues"],
            serde_json::Value::Array(kind_values)
        );

        let lifecycle_state_values = RuntimeLifecycleState::all()
            .iter()
            .copied()
            .map(|value| serde_json::to_value(value).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            contract["lifecycleStateValues"],
            serde_json::Value::Array(lifecycle_state_values)
        );

        let terminal_classification_values = RuntimeTerminalClassification::all()
            .iter()
            .copied()
            .map(|value| serde_json::to_value(value).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            contract["terminalClassificationValues"],
            serde_json::Value::Array(terminal_classification_values)
        );
    }

    #[test]
    fn receipt_rejects_missing_flush_and_inconsistent_boundaries() {
        let mut missing_flush = input(RuntimeReceiptKind::Ready);
        missing_flush.flush_watermark = 0;
        assert_eq!(
            RuntimeReceipt::derive(missing_flush),
            Err(RuntimeReceiptError::MissingDurableFlush)
        );

        let mut wrong_lifecycle = input(RuntimeReceiptKind::Drained);
        wrong_lifecycle.lifecycle_state = RuntimeLifecycleState::Draining;
        assert_eq!(
            RuntimeReceipt::derive(wrong_lifecycle),
            Err(RuntimeReceiptError::InvalidLifecycleForKind)
        );

        let mut wrong_terminal_lifecycle = input(RuntimeReceiptKind::Terminal);
        wrong_terminal_lifecycle.lifecycle_state = RuntimeLifecycleState::Drained;
        assert_eq!(
            RuntimeReceipt::derive(wrong_terminal_lifecycle),
            Err(RuntimeReceiptError::InvalidLifecycleForKind)
        );

        let mut encoded_terminal = serde_json::to_value(
            RuntimeReceipt::derive(input(RuntimeReceiptKind::Terminal)).unwrap(),
        )
        .unwrap();
        encoded_terminal["lifecycleState"] = serde_json::Value::String("drained".to_string());
        assert_eq!(
            RuntimeReceipt::from_json_str(&serde_json::to_string(&encoded_terminal).unwrap()),
            Err(RuntimeReceiptError::InvalidLifecycleForKind)
        );
    }

    #[test]
    fn receipt_requires_terminal_and_failure_classifications() {
        let mut missing_terminal = input(RuntimeReceiptKind::Terminal);
        missing_terminal.terminal = None;
        assert_eq!(
            RuntimeReceipt::derive(missing_terminal),
            Err(RuntimeReceiptError::TerminalClassificationRequired)
        );

        let mut missing_failure = input(RuntimeReceiptKind::Failed);
        missing_failure.error_type = None;
        assert_eq!(
            RuntimeReceipt::derive(missing_failure),
            Err(RuntimeReceiptError::FailureTypeRequired)
        );
    }

    #[test]
    fn receipt_rejects_unknown_fields() {
        let mut value =
            serde_json::to_value(RuntimeReceipt::derive(input(RuntimeReceiptKind::Ready)).unwrap())
                .unwrap();
        value["unexpected"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<RuntimeReceipt>(value).is_err());
    }

    #[test]
    fn receipt_compatibility_edge_rejects_unknown_schema_versions() {
        let mut value =
            serde_json::to_value(RuntimeReceipt::derive(input(RuntimeReceiptKind::Ready)).unwrap())
                .unwrap();
        value["schemaVersion"] = serde_json::Value::String("future.receipt.v2".to_string());
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(
            RuntimeReceipt::from_json_str(&encoded),
            Err(RuntimeReceiptError::UnsupportedSchemaVersion)
        );
    }

    #[test]
    fn receipt_compatibility_edge_rejects_raw_overlong_fields_before_trim() {
        let mut value =
            serde_json::to_value(RuntimeReceipt::derive(input(RuntimeReceiptKind::Ready)).unwrap())
                .unwrap();
        value["runnerSessionId"] = serde_json::Value::String(format!(
            "{}runner-7",
            " ".repeat(MAX_RUNTIME_RECEIPT_STRING_BYTES)
        ));
        let encoded = serde_json::to_string(&value).unwrap();

        assert_eq!(
            RuntimeReceipt::from_json_str(&encoded),
            Err(RuntimeReceiptError::FieldTooLong("runner_session_id"))
        );
    }
}

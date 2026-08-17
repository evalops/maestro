//! Durable native automation definitions, leases, and run receipts.
//!
//! The first production slice deliberately supports interval schedules and
//! tool-free native turns. Definitions and receipts are durable JSON state;
//! every mutation reloads under a create-new file lock before atomically
//! replacing the state file. This keeps a second gateway process or a crash
//! from turning an in-memory placeholder into a false success.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use maestro_tui::agent::{CredentialVault, FromAgent, NativeAgent, NativeAgentConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub(crate) const AUTOMATION_SCHEMA: &str = "evalops.maestro.automation.v1";
const AUTOMATION_STATE_SCHEMA: &str = "evalops.maestro.automation-state.v1";
const AUTOMATION_RECEIPT_SCHEMA: &str = "evalops.maestro.automation-run-receipt.v1";
const MAX_DEFINITIONS: usize = 256;
const MAX_RUNS: usize = 512;
const MAX_RECEIPTS_PER_RUN: usize = 16;
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_ID_BYTES: usize = 96;
const MAX_NAME_BYTES: usize = 128;
const MAX_MODEL_BYTES: usize = 256;
const MAX_ATTEMPTS: u32 = 8;
const MAX_INTERVAL_SECONDS: u64 = 86_400;
const MAX_RETRY_BACKOFF_SECONDS: u64 = 86_400;
const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;
const LEASE_DURATION_MS: u64 = 5 * 60 * 1_000;
const LEASE_HEARTBEAT_MS: u64 = 10 * 1_000;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

type HmacSha256 = Hmac<Sha256>;

fn default_state_schema() -> String {
    AUTOMATION_STATE_SCHEMA.to_owned()
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AutomationRunStatus {
    Running,
    RetryScheduled,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationDefinition {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) interval_seconds: Option<u64>,
    pub(crate) max_attempts: u32,
    pub(crate) retry_backoff_seconds: u64,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next_run_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunReceipt {
    pub(crate) schema_version: String,
    pub(crate) run_id: String,
    pub(crate) automation_id: String,
    pub(crate) idempotency_key: String,
    pub(crate) attempt: u32,
    pub(crate) status: AutomationRunStatus,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_sha256: Option<String>,
    pub(crate) output_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next_retry_at_ms: Option<u64>,
    pub(crate) signed_at_ms: u64,
    pub(crate) signature: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRun {
    pub(crate) run_id: String,
    pub(crate) automation_id: String,
    pub(crate) idempotency_key: String,
    pub(crate) attempt: u32,
    pub(crate) status: AutomationRunStatus,
    pub(crate) queued_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) lease_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) lease_expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next_retry_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_error_type: Option<String>,
    #[serde(default)]
    pub(crate) receipts: Vec<AutomationRunReceipt>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AutomationState {
    #[serde(default = "default_state_schema")]
    schema_version: String,
    #[serde(default)]
    definitions: BTreeMap<String, AutomationDefinition>,
    #[serde(default)]
    runs: Vec<AutomationRun>,
}

impl Default for AutomationState {
    fn default() -> Self {
        Self {
            schema_version: default_state_schema(),
            definitions: BTreeMap::new(),
            runs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ClaimedAutomationRun {
    pub(crate) run_id: String,
    pub(crate) automation_id: String,
    pub(crate) idempotency_key: String,
    pub(crate) attempt: u32,
    pub(crate) owner: String,
    pub(crate) prompt: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone)]
pub(crate) enum RunClaim {
    Claimed(ClaimedAutomationRun),
    Existing(AutomationRun),
}

#[derive(Debug, Clone)]
pub(crate) struct AutomationRunResult {
    pub(crate) succeeded: bool,
    pub(crate) output_sha256: Option<String>,
    pub(crate) output_bytes: u64,
    pub(crate) error_type: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum AutomationStoreError {
    #[error("automation state I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("automation state JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("automation state is invalid: {0}")]
    Invalid(String),
}

#[derive(Debug)]
pub(crate) struct AutomationStore {
    path: PathBuf,
    signing_key: Vec<u8>,
    state: AutomationState,
}

impl AutomationStore {
    pub(crate) fn load(path: PathBuf) -> Result<Self, AutomationStoreError> {
        let signing_key = load_signing_key(&path)?;
        let state = read_state(&path)?;
        if state.schema_version != AUTOMATION_STATE_SCHEMA {
            return Err(AutomationStoreError::Invalid(format!(
                "unsupported schema {}",
                state.schema_version
            )));
        }
        Ok(Self {
            path,
            signing_key,
            state,
        })
    }

    pub(crate) fn list_definitions(&mut self) -> Result<Vec<Value>, AutomationStoreError> {
        self.refresh()?;
        self.state
            .definitions
            .values()
            .map(|definition| serde_json::to_value(definition).map_err(AutomationStoreError::Json))
            .collect()
    }

    pub(crate) fn get_definition(
        &mut self,
        id: &str,
    ) -> Result<Option<Value>, AutomationStoreError> {
        self.refresh()?;
        self.state
            .definitions
            .get(id)
            .map(serde_json::to_value)
            .transpose()
            .map_err(AutomationStoreError::Json)
    }

    pub(crate) fn list_runs(
        &mut self,
        automation_id: &str,
    ) -> Result<Vec<Value>, AutomationStoreError> {
        self.refresh()?;
        self.state
            .runs
            .iter()
            .filter(|run| run.automation_id == automation_id)
            .map(|run| {
                let mut value = serde_json::to_value(run).map_err(AutomationStoreError::Json)?;
                if let Some(receipts) = value.get_mut("receipts").and_then(Value::as_array_mut) {
                    for (receipt_value, receipt) in receipts.iter_mut().zip(run.receipts.iter()) {
                        if let Some(object) = receipt_value.as_object_mut() {
                            object.insert(
                                "signatureValid".to_string(),
                                Value::Bool(self.verify_receipt(receipt)),
                            );
                        }
                    }
                }
                Ok(value)
            })
            .collect()
    }

    pub(crate) fn upsert(
        &mut self,
        id_override: Option<&str>,
        body: &Value,
        now_ms: u64,
    ) -> Result<Value, AutomationStoreError> {
        let requested_id = id_override
            .map(str::to_owned)
            .or_else(|| body.get("id").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| fresh_id("automation", now_ms));
        validate_id(&requested_id).map_err(AutomationStoreError::Invalid)?;
        let body = body.clone();
        let id = requested_id.clone();
        let value = self.mutate(|state| {
            let existing = state.definitions.get(&id);
            let definition = parse_definition(&id, &body, existing, now_ms)?;
            if existing.is_none() && state.definitions.len() >= MAX_DEFINITIONS {
                return Err(AutomationStoreError::Invalid(
                    "automation definition limit reached".to_string(),
                ));
            }
            state.definitions.insert(id.clone(), definition.clone());
            serde_json::to_value(definition).map_err(AutomationStoreError::Json)
        })?;
        Ok(value)
    }

    pub(crate) fn preview(&self, body: &Value, now_ms: u64) -> Result<Value, AutomationStoreError> {
        let id = body.get("id").and_then(Value::as_str).unwrap_or("preview");
        validate_id(id).map_err(AutomationStoreError::Invalid)?;
        let definition = parse_definition(id, body, None, now_ms)?;
        let next_runs = definition
            .interval_seconds
            .map(|interval| {
                (1..=3)
                    .map(|index| now_ms + interval * 1_000 * index)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({
            "valid": true,
            "schema": AUTOMATION_SCHEMA,
            "preview": definition,
            "nextRuns": next_runs,
            "execution": "native_tool_free_turn",
        }))
    }

    pub(crate) fn delete(&mut self, id: &str) -> Result<bool, AutomationStoreError> {
        self.mutate(|state| Ok(state.definitions.remove(id).is_some()))
    }

    pub(crate) fn claim_manual(
        &mut self,
        automation_id: &str,
        idempotency_key: Option<&str>,
        owner: &str,
        fallback_model: &str,
        now_ms: u64,
    ) -> Result<RunClaim, AutomationStoreError> {
        let key = idempotency_key
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| fresh_id("manual", now_ms));
        validate_idempotency_key(&key).map_err(AutomationStoreError::Invalid)?;
        let owner = owner.to_owned();
        let fallback_model = fallback_model.to_owned();
        self.mutate(|state| {
            if let Some(existing) = state
                .runs
                .iter()
                .find(|run| run.automation_id == automation_id && run.idempotency_key == key)
                .cloned()
            {
                return Ok(RunClaim::Existing(existing));
            }
            let definition = state
                .definitions
                .get(automation_id)
                .cloned()
                .ok_or_else(|| AutomationStoreError::Invalid("automation not found".to_string()))?;
            let claimed = new_claim(&definition, key, owner, fallback_model, now_ms);
            let run = run_from_claim(&claimed, now_ms);
            state.runs.push(run);
            Ok(RunClaim::Claimed(claimed))
        })
    }

    pub(crate) fn claim_due(
        &mut self,
        owner: &str,
        fallback_model: &str,
        now_ms: u64,
    ) -> Result<Option<ClaimedAutomationRun>, AutomationStoreError> {
        let owner = owner.to_owned();
        let fallback_model = fallback_model.to_owned();
        self.mutate(|state| {
            if let Some(index) = state.runs.iter().position(|run| {
                run.status == AutomationRunStatus::RetryScheduled
                    && run.next_retry_at_ms.is_some_and(|at| at <= now_ms)
            }) {
                let run = &mut state.runs[index];
                let definition = state
                    .definitions
                    .get(&run.automation_id)
                    .cloned()
                    .ok_or_else(|| {
                        AutomationStoreError::Invalid("automation definition removed".to_string())
                    })?;
                run.attempt = run.attempt.saturating_add(1);
                run.status = AutomationRunStatus::Running;
                run.started_at_ms = Some(now_ms);
                run.finished_at_ms = None;
                run.lease_owner = Some(owner.clone());
                run.lease_expires_at_ms = Some(now_ms + LEASE_DURATION_MS);
                run.next_retry_at_ms = None;
                run.last_error_type = None;
                return Ok(Some(claim_from_run(run, &definition, &fallback_model)));
            }

            let Some((id, definition)) = state
                .definitions
                .iter()
                .find(|(_, definition)| {
                    definition.enabled
                        && definition.interval_seconds.is_some()
                        && definition.next_run_at_ms.is_some_and(|at| at <= now_ms)
                })
                .map(|(id, definition)| (id.clone(), definition.clone()))
            else {
                return Ok(None);
            };
            let scheduled_for = definition.next_run_at_ms.unwrap_or(now_ms);
            let key = format!("schedule:{id}:{scheduled_for}");
            if state.runs.iter().any(|run| run.idempotency_key == key) {
                return Ok(None);
            }
            let interval_ms = definition.interval_seconds.unwrap_or(1) * 1_000;
            if let Some(current) = state.definitions.get_mut(&id) {
                current.next_run_at_ms = Some(
                    scheduled_for
                        .saturating_add(interval_ms)
                        .max(now_ms.saturating_add(interval_ms)),
                );
            }
            let claimed = new_claim(&definition, key, owner, fallback_model, now_ms);
            state.runs.push(run_from_claim(&claimed, now_ms));
            Ok(Some(claimed))
        })
    }

    pub(crate) fn renew_lease(
        &mut self,
        run_id: &str,
        owner: &str,
        now_ms: u64,
    ) -> Result<bool, AutomationStoreError> {
        self.mutate(|state| {
            let Some(run) = state.runs.iter_mut().find(|run| run.run_id == run_id) else {
                return Ok(false);
            };
            if run.status != AutomationRunStatus::Running
                || run.lease_owner.as_deref() != Some(owner)
            {
                return Ok(false);
            }
            run.lease_expires_at_ms = Some(now_ms + LEASE_DURATION_MS);
            Ok(true)
        })
    }

    pub(crate) fn recover_expired(&mut self, now_ms: u64) -> Result<(), AutomationStoreError> {
        let key = self.signing_key.clone();
        self.mutate(|state| {
            let expired = state
                .runs
                .iter()
                .filter(|run| {
                    run.status == AutomationRunStatus::Running
                        && run.lease_expires_at_ms.is_some_and(|at| at <= now_ms)
                })
                .map(|run| run.run_id.clone())
                .collect::<Vec<_>>();
            for run_id in expired {
                let index = state
                    .runs
                    .iter()
                    .position(|run| run.run_id == run_id)
                    .expect("expired run still exists");
                let run = &mut state.runs[index];
                let definition = state.definitions.get(&run.automation_id).cloned();
                let retryable = definition
                    .as_ref()
                    .is_some_and(|definition| run.attempt < definition.max_attempts);
                run.lease_owner = None;
                run.lease_expires_at_ms = None;
                run.finished_at_ms = Some(now_ms);
                run.last_error_type = Some("lease_expired".to_string());
                run.status = if retryable {
                    run.next_retry_at_ms =
                        Some(now_ms + retry_delay_ms(definition.as_ref().unwrap(), run.attempt));
                    AutomationRunStatus::RetryScheduled
                } else {
                    run.next_retry_at_ms = None;
                    AutomationRunStatus::Failed
                };
                let receipt = signed_receipt(
                    &key,
                    run,
                    now_ms,
                    None,
                    0,
                    Some("lease_expired".to_string()),
                );
                append_receipt(run, receipt);
            }
            Ok(())
        })
    }

    pub(crate) fn complete(
        &mut self,
        claim: &ClaimedAutomationRun,
        result: AutomationRunResult,
        now_ms: u64,
    ) -> Result<(), AutomationStoreError> {
        let key = self.signing_key.clone();
        let claim = claim.clone();
        self.mutate(|state| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run_id == claim.run_id)
                .ok_or_else(|| AutomationStoreError::Invalid("run not found".to_string()))?;
            if run.status != AutomationRunStatus::Running
                || run.lease_owner.as_deref() != Some(claim.owner.as_str())
            {
                return Err(AutomationStoreError::Invalid(
                    "run lease is no longer held".to_string(),
                ));
            }
            let definition = state
                .definitions
                .get(&run.automation_id)
                .cloned()
                .ok_or_else(|| {
                    AutomationStoreError::Invalid("automation definition removed".to_string())
                })?;
            let retryable = !result.succeeded && run.attempt < definition.max_attempts;
            run.status = if result.succeeded {
                AutomationRunStatus::Succeeded
            } else if retryable {
                AutomationRunStatus::RetryScheduled
            } else {
                AutomationRunStatus::Failed
            };
            run.finished_at_ms = Some(now_ms);
            run.lease_owner = None;
            run.lease_expires_at_ms = None;
            run.last_error_type = result.error_type.clone();
            run.next_retry_at_ms = if retryable {
                Some(now_ms + retry_delay_ms(&definition, run.attempt))
            } else {
                None
            };
            let receipt = signed_receipt(
                &key,
                run,
                now_ms,
                result.output_sha256,
                result.output_bytes,
                result.error_type,
            );
            append_receipt(run, receipt);
            Ok(())
        })
    }

    fn refresh(&mut self) -> Result<(), AutomationStoreError> {
        self.state = read_state(&self.path)?;
        Ok(())
    }

    fn mutate<F, T>(&mut self, update: F) -> Result<T, AutomationStoreError>
    where
        F: FnOnce(&mut AutomationState) -> Result<T, AutomationStoreError>,
    {
        let (state, value) = update_locked_state(&self.path, update)?;
        self.state = state;
        Ok(value)
    }

    pub(crate) fn verify_receipt(&self, receipt: &AutomationRunReceipt) -> bool {
        let mut unsigned = receipt.clone();
        let Some(signature) = unsigned.signature.take() else {
            return false;
        };
        signature == format!("hmac-sha256:{}", sign_bytes(&self.signing_key, &unsigned))
    }
}

fn parse_definition(
    id: &str,
    body: &Value,
    existing: Option<&AutomationDefinition>,
    now_ms: u64,
) -> Result<AutomationDefinition, AutomationStoreError> {
    let object = body.as_object().ok_or_else(|| {
        AutomationStoreError::Invalid("automation must be a JSON object".to_string())
    })?;
    let prompt = object
        .get("prompt")
        .or_else(|| object.get("task"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| existing.map(|definition| definition.prompt.as_str()))
        .ok_or_else(|| AutomationStoreError::Invalid("automation prompt is required".to_string()))?
        .to_owned();
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(AutomationStoreError::Invalid(
            "automation prompt is too large".to_string(),
        ));
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| existing.map(|definition| definition.name.as_str()))
        .unwrap_or(id)
        .to_owned();
    if name.len() > MAX_NAME_BYTES {
        return Err(AutomationStoreError::Invalid(
            "automation name is too large".to_string(),
        ));
    }
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .or_else(|| existing.map(|definition| definition.enabled))
        .unwrap_or(true);
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| existing.and_then(|definition| definition.model.clone()));
    if model
        .as_ref()
        .is_some_and(|value| value.len() > MAX_MODEL_BYTES)
    {
        return Err(AutomationStoreError::Invalid(
            "automation model is too large".to_string(),
        ));
    }
    let interval_seconds = number_field(object, "intervalSeconds")
        .or_else(|| {
            object
                .get("schedule")
                .and_then(Value::as_object)
                .and_then(|schedule| number_field(schedule, "intervalSeconds"))
        })
        .or_else(|| existing.and_then(|definition| definition.interval_seconds))
        .map(|value| value.clamp(1, MAX_INTERVAL_SECONDS));
    let max_attempts = number_field(object, "maxAttempts")
        .or_else(|| existing.map(|definition| u64::from(definition.max_attempts)))
        .unwrap_or(3)
        .clamp(1, u64::from(MAX_ATTEMPTS)) as u32;
    let retry_backoff_seconds = number_field(object, "retryBackoffSeconds")
        .or_else(|| existing.map(|definition| definition.retry_backoff_seconds))
        .unwrap_or(30)
        .clamp(1, MAX_RETRY_BACKOFF_SECONDS);
    let created_at_ms = existing
        .map(|definition| definition.created_at_ms)
        .unwrap_or(now_ms);
    let next_run_at_ms = if !enabled || interval_seconds.is_none() {
        None
    } else if let Some(existing) = existing {
        existing
            .next_run_at_ms
            .or_else(|| interval_seconds.map(|interval| now_ms + interval * 1_000))
    } else {
        interval_seconds.map(|interval| now_ms + interval * 1_000)
    };
    Ok(AutomationDefinition {
        id: id.to_owned(),
        name,
        prompt,
        enabled,
        model,
        interval_seconds,
        max_attempts,
        retry_backoff_seconds,
        created_at_ms,
        updated_at_ms: now_ms,
        next_run_at_ms,
    })
}

fn number_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("automation id must use ASCII letters, numbers, '.', '_' or '-'".to_string());
    }
    Ok(())
}

fn validate_idempotency_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 || key.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("idempotencyKey must be 1..256 printable bytes".to_string());
    }
    Ok(())
}

fn fresh_id(prefix: &str, now_ms: u64) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{now_ms}-{counter}")
}

fn new_claim(
    definition: &AutomationDefinition,
    idempotency_key: String,
    owner: String,
    fallback_model: String,
    now_ms: u64,
) -> ClaimedAutomationRun {
    ClaimedAutomationRun {
        run_id: fresh_id("run", now_ms),
        automation_id: definition.id.clone(),
        idempotency_key,
        attempt: 1,
        owner,
        prompt: definition.prompt.clone(),
        model: definition.model.clone().unwrap_or(fallback_model),
    }
}

fn claim_from_run(
    run: &AutomationRun,
    definition: &AutomationDefinition,
    fallback_model: &str,
) -> ClaimedAutomationRun {
    ClaimedAutomationRun {
        run_id: run.run_id.clone(),
        automation_id: run.automation_id.clone(),
        idempotency_key: run.idempotency_key.clone(),
        attempt: run.attempt,
        owner: run.lease_owner.clone().unwrap_or_default(),
        prompt: definition.prompt.clone(),
        model: definition
            .model
            .clone()
            .unwrap_or_else(|| fallback_model.to_owned()),
    }
}

fn run_from_claim(claim: &ClaimedAutomationRun, now_ms: u64) -> AutomationRun {
    AutomationRun {
        run_id: claim.run_id.clone(),
        automation_id: claim.automation_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        attempt: claim.attempt,
        status: AutomationRunStatus::Running,
        queued_at_ms: now_ms,
        started_at_ms: Some(now_ms),
        finished_at_ms: None,
        lease_owner: Some(claim.owner.clone()),
        lease_expires_at_ms: Some(now_ms + LEASE_DURATION_MS),
        next_retry_at_ms: None,
        last_error_type: None,
        receipts: Vec::new(),
    }
}

fn retry_delay_ms(definition: &AutomationDefinition, attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1).min(10);
    definition
        .retry_backoff_seconds
        .saturating_mul(1_000)
        .saturating_mul(1_u64 << exponent)
        .min(MAX_RETRY_BACKOFF_SECONDS * 1_000)
}

fn signed_receipt(
    key: &[u8],
    run: &AutomationRun,
    now_ms: u64,
    output_sha256: Option<String>,
    output_bytes: u64,
    error_type: Option<String>,
) -> AutomationRunReceipt {
    let mut receipt = AutomationRunReceipt {
        schema_version: AUTOMATION_RECEIPT_SCHEMA.to_owned(),
        run_id: run.run_id.clone(),
        automation_id: run.automation_id.clone(),
        idempotency_key: run.idempotency_key.clone(),
        attempt: run.attempt,
        status: run.status,
        started_at_ms: run.started_at_ms.unwrap_or(run.queued_at_ms),
        finished_at_ms: run.finished_at_ms.unwrap_or(now_ms),
        output_sha256,
        output_bytes,
        error_type,
        next_retry_at_ms: run.next_retry_at_ms,
        signed_at_ms: now_ms,
        signature: None,
    };
    receipt.signature = Some(format!("hmac-sha256:{}", sign_bytes(key, &receipt)));
    receipt
}

fn append_receipt(run: &mut AutomationRun, receipt: AutomationRunReceipt) {
    run.receipts.push(receipt);
    if run.receipts.len() > MAX_RECEIPTS_PER_RUN {
        let remove = run.receipts.len() - MAX_RECEIPTS_PER_RUN;
        run.receipts.drain(..remove);
    }
}

fn sign_bytes<T: Serialize>(key: &[u8], value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("automation receipt must serialize");
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts arbitrary key sizes");
    mac.update(&bytes);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn load_signing_key(path: &Path) -> Result<Vec<u8>, AutomationStoreError> {
    if let Ok(value) = std::env::var("MAESTRO_AUTOMATION_SIGNING_KEY") {
        let value = value.trim();
        if value.len() >= 32 {
            return Ok(value.as_bytes().to_vec());
        }
        return Err(AutomationStoreError::Invalid(
            "MAESTRO_AUTOMATION_SIGNING_KEY must contain at least 32 bytes".to_string(),
        ));
    }
    let key_path = path.with_extension("signing-key");
    if let Ok(key) = fs::read(&key_path) {
        if key.len() >= 32 {
            return Ok(key);
        }
        return Err(AutomationStoreError::Invalid(
            "automation signing key is too short".to_string(),
        ));
    }
    let mut key = vec![0_u8; 32];
    getrandom::fill(&mut key).map_err(|error| AutomationStoreError::Io(io::Error::other(error)))?;
    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent)?;
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_path)
    {
        Ok(mut file) => {
            file.write_all(&key)?;
            file.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
            }
            Ok(key)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let existing = fs::read(&key_path)?;
            if existing.len() < 32 {
                return Err(AutomationStoreError::Invalid(
                    "automation signing key is too short".to_string(),
                ));
            }
            Ok(existing)
        }
        Err(error) => Err(error.into()),
    }
}

fn read_state(path: &Path) -> Result<AutomationState, AutomationStoreError> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > MAX_STATE_BYTES {
                return Err(AutomationStoreError::Invalid(format!(
                    "automation state exceeds {MAX_STATE_BYTES} bytes"
                )));
            }
            let state: AutomationState = serde_json::from_slice(&bytes)?;
            validate_state(&state)?;
            Ok(state)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(AutomationState::default()),
        Err(error) => Err(error.into()),
    }
}

fn validate_state(state: &AutomationState) -> Result<(), AutomationStoreError> {
    if state.schema_version != AUTOMATION_STATE_SCHEMA {
        return Err(AutomationStoreError::Invalid(format!(
            "unsupported schema {}",
            state.schema_version
        )));
    }
    if state.definitions.len() > MAX_DEFINITIONS || state.runs.len() > MAX_RUNS {
        return Err(AutomationStoreError::Invalid(
            "automation state exceeds bounded retention limits".to_string(),
        ));
    }
    if state
        .runs
        .iter()
        .any(|run| run.receipts.len() > MAX_RECEIPTS_PER_RUN)
    {
        return Err(AutomationStoreError::Invalid(
            "automation run exceeds bounded receipt retention".to_string(),
        ));
    }
    Ok(())
}

fn trim_runs(state: &mut AutomationState) {
    while state.runs.len() > MAX_RUNS {
        let Some(index) = state.runs.iter().position(|run| {
            matches!(
                run.status,
                AutomationRunStatus::Succeeded | AutomationRunStatus::Failed
            )
        }) else {
            break;
        };
        state.runs.remove(index);
    }
}

fn update_locked_state<F, T>(
    path: &Path,
    update: F,
) -> Result<(AutomationState, T), AutomationStoreError>
where
    F: FnOnce(&mut AutomationState) -> Result<T, AutomationStoreError>,
{
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let lock_path = path.with_extension("json.lock");
    let started = Instant::now();
    let lock = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(file) => break file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if started.elapsed() >= LOCK_TIMEOUT {
                    return Err(AutomationStoreError::Io(io::Error::new(
                        ErrorKind::TimedOut,
                        format!("timed out waiting for {}", lock_path.display()),
                    )));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    };
    let temporary = path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("automations.json"),
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut state = read_state(path)?;
        let value = update(&mut state)?;
        trim_runs(&mut state);
        let bytes = serde_json::to_vec_pretty(&state)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok((state, value))
    })();
    drop(lock);
    let _ = fs::remove_file(&lock_path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn spawn_scheduler(
    api: std::sync::Arc<Mutex<crate::extended::ExtendedApiState>>,
    cwd: PathBuf,
    selected_model: std::sync::Arc<Mutex<crate::ModelInfo>>,
) {
    tokio::spawn(async move {
        let owner = format!("gateway-scheduler-{}", std::process::id());
        loop {
            let now_ms = crate::now_millis();
            let _ = api
                .lock()
                .await
                .automations
                .as_mut()
                .map(|store| store.recover_expired(now_ms));
            let fallback_model = {
                let model = selected_model.lock().await;
                format!("{}/{}", model.provider, model.id)
            };
            let claim = api
                .lock()
                .await
                .automations
                .as_mut()
                .and_then(|store| store.claim_due(&owner, &fallback_model, now_ms).ok())
                .flatten();
            if let Some(claim) = claim {
                spawn_claimed(api.clone(), cwd.clone(), claim);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

pub(crate) fn spawn_claimed(
    api: std::sync::Arc<Mutex<crate::extended::ExtendedApiState>>,
    cwd: PathBuf,
    claim: ClaimedAutomationRun,
) {
    tokio::spawn(async move {
        let heartbeat_api = api.clone();
        let heartbeat_claim = claim.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(LEASE_HEARTBEAT_MS)).await;
                let renewed = heartbeat_api
                    .lock()
                    .await
                    .automations
                    .as_mut()
                    .and_then(|store| {
                        store
                            .renew_lease(
                                &heartbeat_claim.run_id,
                                &heartbeat_claim.owner,
                                crate::now_millis(),
                            )
                            .ok()
                    })
                    .unwrap_or(false);
                if !renewed {
                    break;
                }
            }
        });
        let result = execute_native_turn(&claim, &cwd).await;
        heartbeat.abort();
        let _ = api
            .lock()
            .await
            .automations
            .as_mut()
            .map(|store| store.complete(&claim, result, crate::now_millis()));
    });
}

async fn execute_native_turn(claim: &ClaimedAutomationRun, cwd: &Path) -> AutomationRunResult {
    let config = NativeAgentConfig {
        model: claim.model.clone(),
        cwd: cwd.to_string_lossy().to_string(),
        system_prompt: Some(
            "You are running a durable Maestro automation. Complete the requested task and return a concise result. No external tool calls are available in this automation contract.".to_string(),
        ),
        ..NativeAgentConfig::default()
    };
    let allowed_tools = HashSet::new();
    let (agent, mut events) = match NativeAgent::new_with_allowed_tools_and_credential_vault(
        config,
        &allowed_tools,
        CredentialVault::new(),
    ) {
        Ok(agent) => agent,
        Err(_) => return failed_run("agent_initialization_failed"),
    };
    if agent
        .prompt(claim.prompt.clone(), Vec::new())
        .await
        .is_err()
    {
        return failed_run("prompt_enqueue_failed");
    }
    let mut digest = Sha256::new();
    let mut output_bytes = 0_u64;
    while let Some(event) = events.recv().await {
        match event {
            FromAgent::ResponseChunk {
                content,
                is_thinking: false,
                ..
            } => {
                output_bytes = output_bytes.saturating_add(content.len() as u64);
                digest.update(content.as_bytes());
            }
            FromAgent::TurnCompleted { .. } => {
                return AutomationRunResult {
                    succeeded: true,
                    output_sha256: Some(hex_digest(digest.finalize())),
                    output_bytes,
                    error_type: None,
                };
            }
            FromAgent::TurnInterrupted { .. } => return failed_run("turn_interrupted"),
            FromAgent::ProviderError { .. } => return failed_run("provider_error"),
            FromAgent::Error { terminal: true, .. } => return failed_run("agent_error"),
            _ => {}
        }
    }
    failed_run("agent_event_channel_closed")
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn failed_run(error_type: &str) -> AutomationRunResult {
    AutomationRunResult {
        succeeded: false,
        output_sha256: None,
        output_bytes: 0,
        error_type: Some(error_type.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, AutomationStore) {
        let dir = TempDir::new().unwrap();
        let store = AutomationStore::load(dir.path().join("automations.json")).unwrap();
        (dir, store)
    }

    fn definition_body() -> Value {
        serde_json::json!({
            "id": "nightly",
            "name": "Nightly summary",
            "prompt": "Summarize the repository status.",
            "intervalSeconds": 60,
            "maxAttempts": 3,
            "retryBackoffSeconds": 2
        })
    }

    #[test]
    fn definitions_survive_reload_and_preview_is_bounded() {
        let (dir, mut store) = store();
        store.upsert(None, &definition_body(), 1_000).unwrap();
        let preview = store.preview(&definition_body(), 1_000).unwrap();
        assert_eq!(preview["nextRuns"].as_array().unwrap().len(), 3);
        drop(store);
        let mut reloaded = AutomationStore::load(dir.path().join("automations.json")).unwrap();
        let definitions = reloaded.list_definitions().unwrap();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0]["id"], "nightly");
    }

    #[test]
    fn idempotency_returns_one_leased_run() {
        let (_dir, mut store) = store();
        store.upsert(None, &definition_body(), 1_000).unwrap();
        let first = store
            .claim_manual(
                "nightly",
                Some("request-1"),
                "owner-a",
                "openrouter/test",
                2_000,
            )
            .unwrap();
        let second = store
            .claim_manual(
                "nightly",
                Some("request-1"),
                "owner-b",
                "openrouter/test",
                2_001,
            )
            .unwrap();
        let first_id = match first {
            RunClaim::Claimed(claim) => claim.run_id,
            _ => panic!("first claim should create a run"),
        };
        match second {
            RunClaim::Existing(run) => assert_eq!(run.run_id, first_id),
            _ => panic!("second claim should replay the existing run"),
        }
    }

    #[test]
    fn failed_run_is_retry_scheduled_and_receipt_is_signed() {
        let (_dir, mut store) = store();
        store.upsert(None, &definition_body(), 1_000).unwrap();
        let claim = match store
            .claim_manual(
                "nightly",
                Some("request-2"),
                "owner-a",
                "openrouter/test",
                2_000,
            )
            .unwrap()
        {
            RunClaim::Claimed(claim) => claim,
            _ => panic!("claim should be new"),
        };
        store
            .complete(&claim, failed_run("provider_error"), 2_100)
            .unwrap();
        let runs = store.list_runs("nightly").unwrap();
        let run: AutomationRun = serde_json::from_value(runs[0].clone()).unwrap();
        assert_eq!(run.status, AutomationRunStatus::RetryScheduled);
        assert_eq!(run.receipts.len(), 1);
        assert!(store.verify_receipt(&run.receipts[0]));
        assert_eq!(
            run.receipts[0].error_type.as_deref(),
            Some("provider_error")
        );
    }

    #[test]
    fn expired_lease_recovers_without_claiming_success() {
        let (_dir, mut store) = store();
        store.upsert(None, &definition_body(), 1_000).unwrap();
        let _claim = match store
            .claim_manual(
                "nightly",
                Some("request-3"),
                "owner-a",
                "openrouter/test",
                2_000,
            )
            .unwrap()
        {
            RunClaim::Claimed(claim) => claim,
            _ => panic!("claim should be new"),
        };
        store.recover_expired(LEASE_DURATION_MS + 2_001).unwrap();
        let runs = store.list_runs("nightly").unwrap();
        let run: AutomationRun = serde_json::from_value(runs[0].clone()).unwrap();
        assert_eq!(run.status, AutomationRunStatus::RetryScheduled);
        assert_eq!(run.receipts[0].error_type.as_deref(), Some("lease_expired"));
        assert_ne!(run.status, AutomationRunStatus::Succeeded);
    }
}

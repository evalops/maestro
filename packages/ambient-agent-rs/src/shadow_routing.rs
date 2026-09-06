//! Evaluation-backed shadow routing.
//!
//! Shadow routing records a redacted routing decision and candidate evidence
//! without changing the selected model by default. Selection is fail-closed:
//! it requires both explicit configuration and enough persisted evidence to
//! satisfy the quality, success, cost, and latency gates.

use crate::{cascader::RoutingResult, types::*};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const SHADOW_ROUTING_SCHEMA: &str = "evalops.maestro.shadow-routing.v1";
const LEDGER_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_RECORDS: usize = 512;
const MAX_RECORDS: usize = 4096;
const MAX_OBSERVATIONS_PER_RECORD: usize = 32;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

fn default_max_records() -> usize {
    DEFAULT_MAX_RECORDS
}

fn default_min_samples() -> usize {
    20
}

fn default_min_quality_delta() -> f64 {
    0.05
}

fn default_max_cost_ratio() -> f64 {
    1.0
}

fn default_max_latency_ratio() -> f64 {
    1.0
}

/// A model that may be evaluated in shadow mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShadowCandidate {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub tier: String,
    pub cost_per_1k_input: f64,
    pub cost_per_1k_output: f64,
}

/// Runtime policy for shadow routing.
///
/// `enabled` controls recording. `selection_enabled` is a separate, explicit
/// opt-in because collecting evidence must never silently change production
/// behavior.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShadowRoutingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub selection_enabled: bool,
    #[serde(default = "default_max_records")]
    pub max_records: usize,
    #[serde(default = "default_min_samples")]
    pub min_samples: usize,
    #[serde(default = "default_min_quality_delta")]
    pub min_quality_delta: f64,
    #[serde(default = "default_max_cost_ratio")]
    pub max_cost_ratio: f64,
    #[serde(default = "default_max_latency_ratio")]
    pub max_latency_ratio: f64,
    #[serde(default)]
    pub candidates: Vec<ShadowCandidate>,
}

impl Default for ShadowRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            selection_enabled: false,
            max_records: DEFAULT_MAX_RECORDS,
            min_samples: default_min_samples(),
            min_quality_delta: default_min_quality_delta(),
            max_cost_ratio: default_max_cost_ratio(),
            max_latency_ratio: default_max_latency_ratio(),
            candidates: Vec::new(),
        }
    }
}

impl ShadowRoutingConfig {
    fn normalized(mut self) -> Self {
        self.max_records = self.max_records.clamp(1, MAX_RECORDS);
        self.min_samples = self.min_samples.clamp(1, self.max_records);
        if !self.min_quality_delta.is_finite() {
            self.min_quality_delta = default_min_quality_delta();
        }
        self.min_quality_delta = self.min_quality_delta.clamp(0.0, 1.0);
        if !self.max_cost_ratio.is_finite() || self.max_cost_ratio <= 0.0 {
            self.max_cost_ratio = default_max_cost_ratio();
        }
        if !self.max_latency_ratio.is_finite() || self.max_latency_ratio <= 0.0 {
            self.max_latency_ratio = default_max_latency_ratio();
        }
        self.candidates.retain(|candidate| {
            !candidate.id.trim().is_empty()
                && !candidate.model.trim().is_empty()
                && candidate.cost_per_1k_input.is_finite()
                && candidate.cost_per_1k_output.is_finite()
                && candidate.cost_per_1k_input >= 0.0
                && candidate.cost_per_1k_output >= 0.0
        });
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct RouteMetadata {
    provider: String,
    model: String,
    tier: String,
    estimated_cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CandidateMetadata {
    id: String,
    provider: String,
    model: String,
    tier: String,
    estimated_cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutcomeMetadata {
    pub quality: f64,
    pub success: bool,
    pub cost_usd: f64,
    pub latency_ms: u64,
    pub tokens: u64,
}

/// One redacted routing decision. No prompt, file contents, absolute path, or
/// repository name is stored here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShadowRecord {
    pub schema: String,
    pub decision_id: String,
    pub created_at: DateTime<Utc>,
    pub eval_join_key: String,
    pub request_fingerprint: String,
    primary: RouteMetadata,
    candidates: Vec<CandidateMetadata>,
    selected: RouteMetadata,
    pub applied: bool,
    pub outcome: Option<OutcomeMetadata>,
    observations: Vec<ShadowObservation>,
}

/// Candidate evaluation evidence. This is intentionally a separate record so
/// an offline evaluator can join by `decision_id` without receiving prompts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShadowObservation {
    pub decision_id: String,
    pub candidate_id: String,
    pub quality: f64,
    pub success: bool,
    pub cost_usd: f64,
    pub latency_ms: u64,
    pub tokens: u64,
    pub evaluated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerFile {
    schema_version: u32,
    records: Vec<ShadowRecord>,
}

impl Default for LedgerFile {
    fn default() -> Self {
        Self {
            schema_version: LEDGER_SCHEMA_VERSION,
            records: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ShadowRoutingError {
    #[error("shadow routing I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("shadow routing JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("shadow routing evidence is invalid: {0}")]
    InvalidEvidence(String),
}

/// An immutable view of a decision returned to the daemon.
#[derive(Debug, Clone)]
pub struct ShadowDecision {
    pub decision_id: String,
    pub eval_join_key: String,
    pub applied: bool,
    pub routing: RoutingResult,
}

/// Durable shadow-routing ledger and evidence gate.
pub struct ShadowRouter {
    config: ShadowRoutingConfig,
    ledger_path: PathBuf,
    ledger: LedgerFile,
}

impl ShadowRouter {
    pub fn disabled(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            config: ShadowRoutingConfig::default(),
            ledger_path: data_dir.join("shadow-routing.json"),
            ledger: LedgerFile::default(),
        }
    }

    /// Load configuration and prior evidence from a daemon data directory.
    /// Missing files mean disabled/default operation. Invalid state is surfaced
    /// so the daemon can fail closed instead of guessing at routing policy.
    pub fn from_data_dir(data_dir: impl Into<PathBuf>) -> Result<Self, ShadowRoutingError> {
        let data_dir = data_dir.into();
        let config_path = data_dir.join("shadow-routing.config.json");
        let ledger_path = data_dir.join("shadow-routing.json");
        let config = if config_path.exists() {
            serde_json::from_slice(&fs::read(&config_path)?)?
        } else {
            ShadowRoutingConfig::default()
        }
        .normalized();
        let ledger = if ledger_path.exists() {
            let ledger: LedgerFile = serde_json::from_slice(&fs::read(&ledger_path)?)?;
            if ledger.schema_version != LEDGER_SCHEMA_VERSION {
                return Err(ShadowRoutingError::InvalidEvidence(format!(
                    "unsupported ledger schema version {}",
                    ledger.schema_version
                )));
            }
            ledger
        } else {
            LedgerFile::default()
        };
        Ok(Self {
            config,
            ledger_path,
            ledger,
        })
    }

    pub fn config(&self) -> &ShadowRoutingConfig {
        &self.config
    }

    pub fn records(&self) -> &[ShadowRecord] {
        &self.ledger.records
    }

    /// Record a routing decision and return the route that is safe to execute.
    /// Selection remains unchanged unless both opt-ins and every evidence gate
    /// pass.
    pub fn decide(
        &mut self,
        task: &Task,
        context: &crate::cascader::TaskContext,
        primary: &RoutingResult,
    ) -> Result<ShadowDecision, ShadowRoutingError> {
        let decision_id = Uuid::new_v4().to_string();
        let eval_join_key = digest_key("eval", &decision_id);
        let request_fingerprint = request_fingerprint(task, context);
        let primary_metadata = route_metadata(primary);
        let candidates = self
            .config
            .candidates
            .iter()
            .map(|candidate| CandidateMetadata {
                id: candidate.id.clone(),
                provider: candidate.provider.clone(),
                model: candidate.model.clone(),
                tier: candidate.tier.clone(),
                estimated_cost_usd: estimated_cost(
                    candidate,
                    context.estimated_tokens,
                    primary.estimated_cost,
                ),
            })
            .collect::<Vec<_>>();

        let selected_candidate = self
            .config
            .selection_enabled
            .then(|| self.eligible_candidate(&primary.model))
            .flatten();
        let applied = self.config.enabled && selected_candidate.is_some();
        let mut routing = primary.clone();
        if let Some(candidate) = selected_candidate {
            routing.model = candidate.model.clone();
            routing.tier = ModelTier {
                name: candidate.tier.clone(),
                model: candidate.model.clone(),
                cost_per_1k_input: candidate.cost_per_1k_input,
                cost_per_1k_output: candidate.cost_per_1k_output,
                capabilities: primary.tier.capabilities.clone(),
                max_complexity: primary.tier.max_complexity,
            };
            routing.estimated_cost =
                estimated_cost(candidate, context.estimated_tokens, primary.estimated_cost);
            routing.reason = format!(
                "shadow evidence gate selected candidate {} after {} samples",
                candidate.id, self.config.min_samples
            );
            routing.shadow_decision_id = Some(decision_id.clone());
        }
        if self.config.enabled {
            // Keep the decision ID on the legacy route as well so the actual
            // primary outcome can be joined to the redacted record.
            routing.shadow_decision_id = Some(decision_id.clone());
        }

        let record = ShadowRecord {
            schema: SHADOW_ROUTING_SCHEMA.to_string(),
            decision_id: decision_id.clone(),
            created_at: Utc::now(),
            eval_join_key: eval_join_key.clone(),
            request_fingerprint,
            primary: primary_metadata,
            candidates,
            selected: route_metadata(&routing),
            applied,
            outcome: None,
            observations: Vec::new(),
        };
        if self.config.enabled {
            let max_records = self.config.max_records;
            self.update_ledger(|ledger| {
                ledger.records.push(record);
                trim_records(ledger, max_records);
                Ok(())
            })?;
        }

        Ok(ShadowDecision {
            decision_id,
            eval_join_key,
            applied,
            routing,
        })
    }

    /// Attach the real execution outcome to a previously recorded decision.
    pub fn record_outcome(
        &mut self,
        decision_id: &str,
        quality: f64,
        success: bool,
        cost_usd: f64,
        latency_ms: u64,
        tokens: u64,
    ) -> Result<(), ShadowRoutingError> {
        if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
            return Err(ShadowRoutingError::InvalidEvidence(
                "quality must be finite and between 0 and 1".to_string(),
            ));
        }
        if !cost_usd.is_finite() || cost_usd < 0.0 {
            return Err(ShadowRoutingError::InvalidEvidence(
                "cost must be finite and non-negative".to_string(),
            ));
        }
        self.update_ledger(|ledger| {
            if let Some(record) = ledger
                .records
                .iter_mut()
                .find(|record| record.decision_id == decision_id)
            {
                record.outcome = Some(OutcomeMetadata {
                    quality,
                    success,
                    cost_usd,
                    latency_ms,
                    tokens,
                });
            }
            Ok(())
        })
    }

    /// Record evaluator evidence for a candidate. The caller must supply a
    /// decision ID obtained from a prior redacted record; arbitrary joins are
    /// rejected so evidence cannot silently affect another request.
    pub fn record_observation(
        &mut self,
        mut observation: ShadowObservation,
    ) -> Result<(), ShadowRoutingError> {
        if !observation.quality.is_finite() || !(0.0..=1.0).contains(&observation.quality) {
            return Err(ShadowRoutingError::InvalidEvidence(
                "quality must be finite and between 0 and 1".to_string(),
            ));
        }
        if !observation.cost_usd.is_finite() || observation.cost_usd < 0.0 {
            return Err(ShadowRoutingError::InvalidEvidence(
                "cost must be finite and non-negative".to_string(),
            ));
        }
        observation.evaluated_at = Utc::now();
        self.update_ledger(|ledger| {
            let Some(record) = ledger
                .records
                .iter_mut()
                .find(|record| record.decision_id == observation.decision_id)
            else {
                return Err(ShadowRoutingError::InvalidEvidence(
                    "observation references an unknown decision".to_string(),
                ));
            };
            if !record
                .candidates
                .iter()
                .any(|candidate| candidate.id == observation.candidate_id)
            {
                return Err(ShadowRoutingError::InvalidEvidence(
                    "observation references an unconfigured candidate".to_string(),
                ));
            }
            record.observations.push(observation);
            record.observations.truncate(MAX_OBSERVATIONS_PER_RECORD);
            Ok(())
        })
    }

    fn eligible_candidate(&self, primary_model: &str) -> Option<&ShadowCandidate> {
        if !self.config.enabled {
            return None;
        }
        let primary = self.primary_metrics(primary_model)?;
        self.config
            .candidates
            .iter()
            .filter_map(|candidate| {
                let metrics = self.candidate_metrics(&candidate.id)?;
                if metrics.samples < self.config.min_samples
                    || metrics.quality < primary.quality + self.config.min_quality_delta
                    || metrics.success_rate < primary.success_rate
                    || metrics.cost_usd > primary.cost_usd * self.config.max_cost_ratio
                    || metrics.latency_ms > primary.latency_ms * self.config.max_latency_ratio
                {
                    return None;
                }
                Some((candidate, metrics))
            })
            .min_by(|(_, left), (_, right)| {
                right
                    .quality
                    .total_cmp(&left.quality)
                    .then_with(|| left.cost_usd.total_cmp(&right.cost_usd))
                    .then_with(|| left.latency_ms.total_cmp(&right.latency_ms))
            })
            .map(|(candidate, _)| candidate)
    }

    fn primary_metrics(&self, primary_model: &str) -> Option<Metrics> {
        let outcomes = self.ledger.records.iter().filter_map(|record| {
            (!record.applied && record.primary.model == primary_model)
                .then_some(record.outcome.as_ref())
                .flatten()
        });
        Metrics::from_outcomes(outcomes)
    }

    fn candidate_metrics(&self, candidate_id: &str) -> Option<Metrics> {
        let observations = self.ledger.records.iter().flat_map(|record| {
            record
                .observations
                .iter()
                .filter(move |observation| observation.candidate_id == candidate_id)
        });
        Metrics::from_observations(observations)
    }

    fn update_ledger<F>(&mut self, update: F) -> Result<(), ShadowRoutingError>
    where
        F: FnOnce(&mut LedgerFile) -> Result<(), ShadowRoutingError>,
    {
        let ledger = update_locked_atomic(&self.ledger_path, update)?;
        self.ledger = ledger;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct Metrics {
    samples: usize,
    quality: f64,
    success_rate: f64,
    cost_usd: f64,
    latency_ms: f64,
}

impl Metrics {
    fn from_outcomes<'a>(outcomes: impl Iterator<Item = &'a OutcomeMetadata>) -> Option<Self> {
        let values = outcomes.collect::<Vec<_>>();
        if values.is_empty() {
            return None;
        }
        let samples = values.len();
        Some(Self {
            samples,
            quality: values.iter().map(|outcome| outcome.quality).sum::<f64>() / samples as f64,
            success_rate: values.iter().filter(|outcome| outcome.success).count() as f64
                / samples as f64,
            cost_usd: values.iter().map(|outcome| outcome.cost_usd).sum::<f64>() / samples as f64,
            latency_ms: values
                .iter()
                .map(|outcome| outcome.latency_ms as f64)
                .sum::<f64>()
                / samples as f64,
        })
    }

    fn from_observations<'a>(
        observations: impl Iterator<Item = &'a ShadowObservation>,
    ) -> Option<Self> {
        let values = observations.collect::<Vec<_>>();
        if values.is_empty() {
            return None;
        }
        let samples = values.len();
        Some(Self {
            samples,
            quality: values
                .iter()
                .map(|observation| observation.quality)
                .sum::<f64>()
                / samples as f64,
            success_rate: values
                .iter()
                .filter(|observation| observation.success)
                .count() as f64
                / samples as f64,
            cost_usd: values
                .iter()
                .map(|observation| observation.cost_usd)
                .sum::<f64>()
                / samples as f64,
            latency_ms: values
                .iter()
                .map(|observation| observation.latency_ms as f64)
                .sum::<f64>()
                / samples as f64,
        })
    }
}

fn route_metadata(routing: &RoutingResult) -> RouteMetadata {
    RouteMetadata {
        provider: provider_for_model(&routing.model).to_string(),
        model: routing.model.clone(),
        tier: routing.tier.name.clone(),
        estimated_cost_usd: routing.estimated_cost,
    }
}

fn provider_for_model(model: &str) -> &str {
    model
        .split('/')
        .next()
        .filter(|provider| !provider.is_empty())
        .unwrap_or("unknown")
}

fn estimated_cost(
    candidate: &ShadowCandidate,
    estimated_tokens: Option<u64>,
    primary_estimated_cost: f64,
) -> f64 {
    let Some(tokens) = estimated_tokens else {
        return primary_estimated_cost;
    };
    (tokens as f64 * candidate.cost_per_1k_input) / 1000.0
        + (tokens as f64 * 0.3 * candidate.cost_per_1k_output) / 1000.0
}

/// Hash only coarse task shape. The input deliberately excludes prompt text,
/// file contents, workspace paths, repository names, and user identifiers.
fn request_fingerprint(task: &Task, context: &crate::cascader::TaskContext) -> String {
    let extensions = task
        .files
        .iter()
        .filter_map(|path| Path::new(path).extension().and_then(|ext| ext.to_str()))
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    digest_key(
        "request",
        &format!(
            "{:?}|{:?}|{}|{}|{}",
            task.task_type,
            context.complexity,
            task.files.len(),
            extensions.join(","),
            task.estimated_tokens.unwrap_or_default()
        ),
    )
}

fn digest_key(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    format!("{prefix}_sha256:{}", hex::encode(hasher.finalize()))
}

fn trim_records(ledger: &mut LedgerFile, max: usize) {
    if ledger.records.len() > max {
        let keep_from = ledger.records.len() - max;
        ledger.records.drain(..keep_from);
    }
}

fn update_locked_atomic<F>(path: &Path, update: F) -> Result<LedgerFile, ShadowRoutingError>
where
    F: FnOnce(&mut LedgerFile) -> Result<(), ShadowRoutingError>,
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
                    return Err(ShadowRoutingError::Io(io::Error::new(
                        ErrorKind::TimedOut,
                        format!("timed out waiting for {}", lock_path.display()),
                    )));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    };
    let temp_path = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut ledger = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<LedgerFile>(&bytes)?,
            Err(error) if error.kind() == ErrorKind::NotFound => LedgerFile::default(),
            Err(error) => return Err(ShadowRoutingError::Io(error)),
        };
        update(&mut ledger)?;
        let bytes = serde_json::to_vec_pretty(&ledger)?;
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(&bytes)?;
        temp.sync_all()?;
        fs::rename(&temp_path, path)?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok::<LedgerFile, ShadowRoutingError>(ledger)
    })();
    drop(lock);
    let _ = fs::remove_file(&lock_path);
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn primary() -> RoutingResult {
        RoutingResult {
            model: "openrouter/primary".to_string(),
            tier: ModelTier {
                name: "frontier".to_string(),
                model: "openrouter/primary".to_string(),
                cost_per_1k_input: 0.01,
                cost_per_1k_output: 0.02,
                capabilities: vec!["feature-impl".to_string()],
                max_complexity: Complexity::High,
            },
            reason: "primary".to_string(),
            estimated_cost: 0.3,
            shadow_decision_id: None,
        }
    }

    fn task() -> (Task, crate::cascader::TaskContext) {
        (
            Task {
                id: "task-secret-id".to_string(),
                task_type: TaskType::Implement,
                prompt: "do not persist this prompt".to_string(),
                files: vec!["src/main.rs".to_string()],
                depends_on: vec![],
                priority: 1,
                estimated_tokens: Some(1_000),
            },
            crate::cascader::TaskContext {
                complexity: Complexity::Medium,
                task_type: TaskType::Implement,
                estimated_tokens: Some(1_000),
                previous_attempts: 0,
            },
        )
    }

    fn config() -> ShadowRoutingConfig {
        ShadowRoutingConfig {
            enabled: true,
            selection_enabled: false,
            max_records: 8,
            min_samples: 2,
            candidates: vec![ShadowCandidate {
                id: "candidate-a".to_string(),
                provider: "openrouter".to_string(),
                model: "openrouter/candidate".to_string(),
                tier: "candidate".to_string(),
                cost_per_1k_input: 0.001,
                cost_per_1k_output: 0.002,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn default_is_disabled_and_preserves_primary_route() {
        let temp = TempDir::new().unwrap();
        let mut router = ShadowRouter::disabled(temp.path());
        let (task, context) = task();
        let decision = router.decide(&task, &context, &primary()).unwrap();
        assert!(!decision.applied);
        assert_eq!(decision.routing.model, "openrouter/primary");
        assert!(router.records().is_empty());
    }

    #[test]
    fn persisted_record_contains_hashes_but_no_prompt_or_path() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("shadow-routing.json");
        let mut router = ShadowRouter {
            config: config(),
            ledger_path: path.clone(),
            ledger: LedgerFile::default(),
        };
        let (task, context) = task();
        let decision = router.decide(&task, &context, &primary()).unwrap();
        router
            .record_outcome(&decision.decision_id, 0.8, true, 0.2, 42, 1000)
            .unwrap();
        let raw = fs::read_to_string(path).unwrap();
        assert!(!raw.contains("do not persist"));
        assert!(!raw.contains("/tmp"));
        assert!(raw.contains("eval_sha256:"));
        assert!(raw.contains("request_sha256:"));
        assert!(raw.contains(SHADOW_ROUTING_SCHEMA));
    }

    #[test]
    fn selection_requires_explicit_opt_in_and_evidence_gates() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("shadow-routing.json");
        let mut router = ShadowRouter {
            config: config(),
            ledger_path: path,
            ledger: LedgerFile::default(),
        };
        let (task, context) = task();
        let first = router.decide(&task, &context, &primary()).unwrap();
        router
            .record_outcome(&first.decision_id, 0.8, true, 0.3, 100, 1000)
            .unwrap();
        let gated = router.decide(&task, &context, &primary()).unwrap();
        assert!(!gated.applied);

        for _ in 0..2 {
            router
                .record_observation(ShadowObservation {
                    decision_id: first.decision_id.clone(),
                    candidate_id: "candidate-a".to_string(),
                    quality: 0.95,
                    success: true,
                    cost_usd: 0.1,
                    latency_ms: 50,
                    tokens: 500,
                    evaluated_at: Utc::now(),
                })
                .unwrap();
        }
        router.config.selection_enabled = true;
        let selected = router.decide(&task, &context, &primary()).unwrap();
        assert!(selected.applied);
        assert_eq!(selected.routing.model, "openrouter/candidate");
    }

    #[test]
    fn bounds_records_and_recovers_after_reload() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("shadow-routing.json");
        let mut router = ShadowRouter {
            config: config(),
            ledger_path: path.clone(),
            ledger: LedgerFile::default(),
        };
        let (task, context) = task();
        for _ in 0..20 {
            router.decide(&task, &context, &primary()).unwrap();
        }
        assert_eq!(router.records().len(), 8);
        let loaded = ShadowRouter {
            config: config(),
            ledger_path: path.clone(),
            ledger: serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap(),
        };
        assert_eq!(loaded.records().len(), 8);
    }

    #[test]
    fn concurrent_instances_merge_under_the_file_lock() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("shadow-routing.json");
        let mut first = ShadowRouter {
            config: config(),
            ledger_path: path.clone(),
            ledger: LedgerFile::default(),
        };
        let mut second = ShadowRouter {
            config: config(),
            ledger_path: path.clone(),
            ledger: LedgerFile::default(),
        };
        let (task, context) = task();
        let first_decision = first.decide(&task, &context, &primary()).unwrap();
        let second_decision = second.decide(&task, &context, &primary()).unwrap();
        first
            .record_outcome(&first_decision.decision_id, 0.8, true, 0.2, 42, 1000)
            .unwrap();

        let loaded = ShadowRouter::from_data_dir(temp.path()).unwrap();
        assert_eq!(loaded.records().len(), 2);
        assert!(
            loaded
                .records()
                .iter()
                .any(|record| record.decision_id == first_decision.decision_id
                    && record.outcome.is_some())
        );
        assert!(
            loaded
                .records()
                .iter()
                .any(|record| record.decision_id == second_decision.decision_id)
        );
    }
}

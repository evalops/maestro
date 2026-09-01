use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use clap::{Args, Subcommand, ValueEnum};
use fs2::FileExt;
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ureq::Agent;

mod proto;
mod provenance_compat;

use crate::proto as sessions_pb;
use crate::provenance_compat::{clear_hook_session, redact_text, touch_hook_session};

const MANIFEST_VERSION: u32 = 1;
const REDACTION_POLICY_VERSION: &str = "transcript-redaction-v2";
const LEGACY_REDACTION_POLICY_VERSION: &str = "transcript-redaction-v1";
const MAX_SEGMENT_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const TRANSCRIPT_METHOD: &str = "sessions.v1.SessionsService/RecordTranscriptSegment";

#[derive(Debug, Args)]
pub struct TranscriptArgs {
    #[command(subcommand)]
    command: TranscriptCommand,
}

#[derive(Debug, Subcommand)]
enum TranscriptCommand {
    /// Redact and spool one vendor JSONL transcript without network access.
    Prepare(PrepareTranscriptArgs),
    /// Upload pending segments from a prepared manifest and persist receipts.
    Push(PushTranscriptArgs),
    /// Consume a Codex/Claude lifecycle hook payload from stdin.
    #[command(hide = true)]
    Hook(HookTranscriptArgs),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptAgent {
    ClaudeCode,
    Codex,
    Maestro,
    Other,
}

impl TranscriptAgent {
    fn storage_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Maestro => "maestro",
            Self::Other => "other",
        }
    }

    fn proto(self) -> sessions_pb::AgentKind {
        match self {
            Self::ClaudeCode => sessions_pb::AgentKind::ClaudeCode,
            Self::Codex => sessions_pb::AgentKind::Codex,
            Self::Maestro => sessions_pb::AgentKind::Maestro,
            Self::Other => sessions_pb::AgentKind::Other,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptCompletenessArg {
    InProgress,
    Complete,
    Partial,
}

impl TranscriptCompletenessArg {
    fn proto(self) -> sessions_pb::TranscriptCompleteness {
        match self {
            Self::InProgress => sessions_pb::TranscriptCompleteness::InProgress,
            Self::Complete => sessions_pb::TranscriptCompleteness::Complete,
            Self::Partial => sessions_pb::TranscriptCompleteness::Partial,
        }
    }
}

#[derive(Debug, Args)]
struct PrepareTranscriptArgs {
    /// Vendor JSONL exported by Claude Code, Codex, Maestro, or another adapter.
    #[arg(long)]
    input: PathBuf,
    #[arg(long, value_enum)]
    agent: TranscriptAgent,
    /// Stable vendor-side session identifier.
    #[arg(long)]
    source_session_id: String,
    /// Platform session identifier. Derived deterministically when omitted.
    #[arg(long)]
    session_id: Option<String>,
    #[arg(long)]
    organization: String,
    #[arg(long)]
    workspace: String,
    #[arg(long)]
    repository_url: Option<String>,
    #[arg(long)]
    working_directory: Option<String>,
    #[arg(long)]
    branch: Option<String>,
    #[arg(long)]
    head_sha: Option<String>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long, value_enum, default_value_t = TranscriptCompletenessArg::Complete)]
    completeness: TranscriptCompletenessArg,
}

#[derive(Args)]
struct PushTranscriptArgs {
    #[arg(long)]
    manifest: PathBuf,
    #[arg(long, env = "PLATFORM_API_URL")]
    endpoint: String,
    #[arg(long, env = "PLATFORM_API_TOKEN")]
    token: Option<String>,
}

#[derive(Debug, Args)]
struct HookTranscriptArgs {
    #[arg(long, value_enum)]
    agent: TranscriptAgent,
    #[arg(long)]
    organization: Option<String>,
    #[arg(long)]
    workspace: Option<String>,
    #[arg(long)]
    endpoint: Option<String>,
    /// Wait for upload completion. Intended for diagnostics and end-to-end tests.
    #[arg(long)]
    wait_for_upload: bool,
}

#[derive(Debug, Deserialize)]
struct AgentHookPayload {
    hook_event_name: String,
    session_id: String,
    cwd: PathBuf,
    #[serde(default)]
    transcript_path: Option<PathBuf>,
    #[serde(default)]
    transcript_size_before: Option<u64>,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
}

/// Product-owned Maestro lifecycle event captured without a repository hook.
///
/// The tenant identifiers and bearer come from Maestro's verified Identity
/// session. They are passed in memory and are never serialized into the hook
/// payload or spool manifest.
#[derive(Clone)]
pub struct MaestroTranscriptEvent {
    pub event_name: String,
    pub source_session_id: String,
    pub cwd: PathBuf,
    pub transcript_path: Option<PathBuf>,
    pub transcript_size_before: Option<u64>,
    pub organization_id: String,
    pub workspace_id: String,
    pub endpoint: Option<String>,
    pub access_token: Option<String>,
    pub model: Option<String>,
}

impl std::fmt::Debug for PushTranscriptArgs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushTranscriptArgs")
            .field("manifest", &self.manifest)
            .field("endpoint", &self.endpoint)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TranscriptManifest {
    version: u32,
    organization_id: String,
    workspace_id: String,
    session_id: String,
    source_session_id: String,
    agent: TranscriptAgent,
    agent_name: String,
    repository_url: String,
    working_directory: String,
    branch: String,
    head_sha: String,
    title: String,
    completeness: TranscriptCompletenessArg,
    redaction_policy_version: String,
    segments: Vec<SpoolSegment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SpoolSegment {
    segment_index: u64,
    first_entry_index: u64,
    last_entry_index: u64,
    omitted_entry_count: u64,
    path: String,
    size_bytes: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    upload: Option<UploadReceipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct UploadReceipt {
    segment_id: String,
    object_id: String,
    version_id: String,
    replayed: bool,
    recorded_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TranscriptError {
    #[error("invalid transcript input: {0}")]
    InvalidInput(String),
    #[error("transcript I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("transcript JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("transcript upload failed: {0}")]
    Upload(String),
    #[error("transcript hook failed: {0}")]
    Hook(String),
}

pub fn execute_transcript(
    args: TranscriptArgs,
    state_dir: Option<&Path>,
) -> Result<Value, TranscriptError> {
    match args.command {
        TranscriptCommand::Prepare(args) => prepare_transcript(args, state_dir),
        TranscriptCommand::Push(args) => push_transcript(args),
        TranscriptCommand::Hook(args) => capture_hook(args, state_dir),
    }
}

fn capture_hook(
    args: HookTranscriptArgs,
    state_dir: Option<&Path>,
) -> Result<Value, TranscriptError> {
    let payload: AgentHookPayload = serde_json::from_reader(std::io::stdin().lock())?;
    capture_hook_payload(args, payload, state_dir, platform_token())
}

/// Capture one Maestro lifecycle event using the authenticated product session.
pub fn capture_maestro_event(
    event: MaestroTranscriptEvent,
    state_dir: Option<&Path>,
) -> Result<Value, TranscriptError> {
    let args = HookTranscriptArgs {
        agent: TranscriptAgent::Maestro,
        organization: Some(event.organization_id.clone()),
        workspace: Some(event.workspace_id.clone()),
        endpoint: event.endpoint.clone(),
        wait_for_upload: false,
    };
    let payload = AgentHookPayload {
        hook_event_name: event.event_name,
        session_id: event.source_session_id,
        cwd: event.cwd,
        transcript_path: event.transcript_path,
        transcript_size_before: event.transcript_size_before,
        organization_id: Some(event.organization_id),
        workspace_id: Some(event.workspace_id),
        model: event.model,
        prompt: None,
    };
    capture_hook_payload(args, payload, state_dir, event.access_token)
}

fn capture_hook_payload(
    args: HookTranscriptArgs,
    payload: AgentHookPayload,
    state_dir: Option<&Path>,
    access_token: Option<String>,
) -> Result<Value, TranscriptError> {
    validate_identifier("hook session_id", &payload.session_id, 1024)?;
    let git_repo = git_value(&payload.cwd, &["rev-parse", "--show-toplevel"]).map(PathBuf::from);
    let repo = git_repo.clone().unwrap_or_else(|| payload.cwd.clone());
    let repository_url = git_value(&repo, &["config", "--get", "remote.origin.url"])
        .unwrap_or_else(|| repo.display().to_string());
    let session_id = stable_session_id(args.agent, &payload.session_id, &repository_url);
    let agent_name = args.agent.storage_name();
    let organization = args
        .organization
        .or(payload.organization_id.clone())
        .or_else(|| {
            first_env(&[
                "MAESTRO_EVALOPS_ORG_ID",
                "EVALOPS_ORGANIZATION_ID",
                "DEIXIC_ORGANIZATION_ID",
                "DX_ORGANIZATION_ID",
            ])
        });
    let workspace = args.workspace.or(payload.workspace_id.clone()).or_else(|| {
        first_env(&[
            "MAESTRO_EVALOPS_WORKSPACE_ID",
            "EVALOPS_WORKSPACE_ID",
            "DEIXIC_WORKSPACE_ID",
            "DX_WORKSPACE_ID",
        ])
    });
    let endpoint = args.endpoint.or_else(platform_endpoint);

    match payload.hook_event_name.as_str() {
        "SessionStart" | "UserPromptSubmit" => {
            if git_repo.is_some() {
                touch_hook_session(
                    &repo,
                    &session_id,
                    &payload.session_id,
                    agent_name,
                    payload.model.as_deref(),
                    payload.prompt.as_deref(),
                )
                .map_err(|error| TranscriptError::Hook(error.to_string()))?;
            }
            let retry = if payload.hook_event_name == "SessionStart" {
                retry_pending_manifests(
                    state_dir,
                    organization.as_deref(),
                    workspace.as_deref(),
                    &repository_url,
                    endpoint.as_deref(),
                    access_token.as_deref(),
                    args.wait_for_upload,
                )?
            } else {
                json!({"status": "not_requested"})
            };
            Ok(json!({
                "operation": "transcript.hook",
                "event": payload.hook_event_name,
                "session_id": session_id,
                "lease": "active",
                "retry": retry,
            }))
        }
        "PostMessage" | "SessionEnd" => {
            let transcript_path = payload.transcript_path.ok_or_else(|| {
                TranscriptError::Hook(format!(
                    "{} payload omitted transcript_path",
                    payload.hook_event_name
                ))
            })?;
            if payload.hook_event_name == "PostMessage"
                && args.agent == TranscriptAgent::Maestro
                && let Some(size_before) = payload.transcript_size_before
            {
                wait_for_transcript_growth(&transcript_path, size_before)?;
            }
            let (Some(organization), Some(workspace)) = (organization, workspace) else {
                if payload.hook_event_name == "SessionEnd" && git_repo.is_some() {
                    clear_hook_session(&repo, &payload.session_id)
                        .map_err(|error| TranscriptError::Hook(error.to_string()))?;
                }
                return Ok(json!({
                    "operation": "transcript.hook",
                    "event": payload.hook_event_name,
                    "session_id": session_id,
                    "capture": "skipped",
                    "reason": "authenticated organization and workspace identity are required",
                }));
            };
            let prepared = prepare_transcript(
                PrepareTranscriptArgs {
                    input: transcript_path,
                    agent: args.agent,
                    source_session_id: payload.session_id.clone(),
                    session_id: Some(session_id.clone()),
                    organization,
                    workspace,
                    repository_url: Some(repository_url),
                    working_directory: Some(".".to_string()),
                    branch: git_value(&repo, &["branch", "--show-current"]),
                    head_sha: git_value(&repo, &["rev-parse", "HEAD"]),
                    title: None,
                    completeness: if args.agent == TranscriptAgent::Maestro {
                        // A Maestro session may be switched away from and resumed,
                        // so SessionEnd is a capture boundary, not finality.
                        TranscriptCompletenessArg::InProgress
                    } else {
                        TranscriptCompletenessArg::Complete
                    },
                },
                state_dir,
            )?;
            let manifest = prepared["manifest"]
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| {
                    TranscriptError::Hook("prepare omitted manifest path".to_string())
                })?;
            let upload = if let Some(endpoint) = endpoint {
                validate_endpoint(&endpoint)?;
                if args.wait_for_upload {
                    push_transcript(PushTranscriptArgs {
                        manifest: manifest.clone(),
                        endpoint,
                        token: access_token.clone(),
                    })?
                } else {
                    spawn_background_upload(&manifest, &endpoint, access_token.clone())?;
                    json!({"status": "started"})
                }
            } else {
                json!({"status": "pending", "reason": "PLATFORM_API_URL is not configured"})
            };
            if payload.hook_event_name == "SessionEnd" && git_repo.is_some() {
                clear_hook_session(&repo, &payload.session_id)
                    .map_err(|error| TranscriptError::Hook(error.to_string()))?;
            }
            Ok(json!({
                "operation": "transcript.hook",
                "event": payload.hook_event_name,
                "session_id": session_id,
                "manifest": manifest,
                "capture": "spooled",
                "upload": upload,
            }))
        }
        event => Err(TranscriptError::Hook(format!(
            "unsupported hook_event_name {event:?}"
        ))),
    }
}

fn wait_for_transcript_growth(path: &Path, size_before: u64) -> Result<(), TranscriptError> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if fs::metadata(path)
            .map(|metadata| metadata.len() > size_before)
            .unwrap_or(false)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(TranscriptError::Hook(format!(
                "Maestro transcript did not flush past byte {size_before} before PostMessage capture"
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn platform_endpoint() -> Option<String> {
    first_env(&[
        "PLATFORM_API_URL",
        "EVALOPS_PLATFORM_API_URL",
        "DEIXIC_PLATFORM_URL",
        "DX_PLATFORM_URL",
        "MAESTRO_EVALOPS_BASE_URL",
    ])
}

fn first_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn platform_token() -> Option<String> {
    first_env(&[
        "PLATFORM_API_TOKEN",
        "MAESTRO_EVALOPS_ACCESS_TOKEN",
        "EVALOPS_ACCESS_TOKEN",
        "DEIXIC_PLATFORM_TOKEN",
        "DX_PLATFORM_TOKEN",
    ])
}

fn git_value(repo: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn retry_pending_manifests(
    state_dir: Option<&Path>,
    organization: Option<&str>,
    workspace: Option<&str>,
    repository_url: &str,
    endpoint: Option<&str>,
    access_token: Option<&str>,
    wait_for_upload: bool,
) -> Result<Value, TranscriptError> {
    let (Some(organization), Some(workspace), Some(endpoint)) = (organization, workspace, endpoint)
    else {
        return Ok(json!({"status": "not_configured", "manifests": 0}));
    };
    validate_endpoint(endpoint)?;
    let root = transcript_state_root(state_dir)?;
    let mut pending = Vec::new();
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else { continue };
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let Ok(manifest) = read_locked_manifest(&manifest_path) else {
            continue;
        };
        if manifest.organization_id == organization
            && manifest.workspace_id == workspace
            && manifest.repository_url == repository_url
            && manifest
                .segments
                .iter()
                .any(|segment| segment.upload.is_none())
        {
            pending.push(manifest_path);
        }
    }
    if pending.is_empty() {
        return Ok(json!({"status": "complete", "manifests": 0}));
    }
    if !wait_for_upload {
        for manifest in &pending {
            spawn_background_upload(manifest, endpoint, access_token.map(str::to_owned))?;
        }
        return Ok(json!({"status": "started", "manifests": pending.len()}));
    }

    let mut failed = 0_usize;
    for manifest in &pending {
        if push_transcript(PushTranscriptArgs {
            manifest: manifest.clone(),
            endpoint: endpoint.to_string(),
            token: access_token.map(str::to_owned),
        })
        .is_err()
        {
            failed += 1;
        }
    }
    Ok(json!({
        "status": if failed == 0 { "complete" } else { "partial" },
        "manifests": pending.len(),
        "failed": failed,
    }))
}

fn read_locked_manifest(path: &Path) -> Result<TranscriptManifest, TranscriptError> {
    let directory = path.parent().ok_or_else(|| {
        TranscriptError::InvalidInput("manifest path must have a parent directory".to_string())
    })?;
    let _lock = lock_manifest_directory(directory)?;
    let manifest: TranscriptManifest = serde_json::from_reader(File::open(path)?)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn lock_manifest_directory(directory: &Path) -> Result<File, TranscriptError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(directory.join(".manifest.lock"))?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn spawn_background_upload(
    manifest: &Path,
    endpoint: &str,
    token: Option<String>,
) -> Result<(), TranscriptError> {
    let manifest = manifest.to_path_buf();
    let endpoint = endpoint.to_string();
    if token.is_some() {
        std::thread::Builder::new()
            .name("transcript-upload".to_string())
            .spawn(move || {
                let _ = push_transcript(PushTranscriptArgs {
                    manifest,
                    endpoint,
                    token,
                });
            })
            .map_err(TranscriptError::Io)?;
        return Ok(());
    }
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(["transcript", "push", "--manifest"])
        .arg(&manifest)
        .args(["--endpoint", &endpoint])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(token) = platform_token() {
        command.env("PLATFORM_API_TOKEN", token);
    }
    command.spawn().map_err(TranscriptError::Io)?;
    Ok(())
}

fn prepare_transcript(
    args: PrepareTranscriptArgs,
    state_dir: Option<&Path>,
) -> Result<Value, TranscriptError> {
    validate_identifier("organization", &args.organization, 255)?;
    validate_identifier("workspace", &args.workspace, 255)?;
    validate_identifier("source_session_id", &args.source_session_id, 1024)?;
    if !args.input.is_file() {
        return Err(TranscriptError::InvalidInput(format!(
            "--input is not a readable file: {}",
            args.input.display()
        )));
    }
    let repo = args
        .working_directory
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| args.input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let session_id = args.session_id.unwrap_or_else(|| {
        stable_session_id(
            args.agent,
            &args.source_session_id,
            args.repository_url.as_deref().unwrap_or_default(),
        )
    });
    validate_identifier("session_id", &session_id, 255)?;
    let spool_root = transcript_state_root(state_dir)?.join(&session_id);
    create_private_dir(&spool_root)?;
    let _manifest_lock = lock_manifest_directory(&spool_root)?;

    let entries = read_redacted_entries(&args.input, args.agent, &repo)?;
    if entries.is_empty() {
        return Err(TranscriptError::InvalidInput(
            "input contains no JSONL entries".to_string(),
        ));
    }
    let manifest_path = spool_root.join("manifest.json");
    let mut manifest = TranscriptManifest {
        version: MANIFEST_VERSION,
        organization_id: args.organization,
        workspace_id: args.workspace,
        session_id: session_id.clone(),
        source_session_id: args.source_session_id,
        agent: args.agent,
        agent_name: args.agent.storage_name().to_string(),
        repository_url: args.repository_url.unwrap_or_default(),
        working_directory: args.working_directory.unwrap_or_default(),
        branch: args.branch.unwrap_or_default(),
        head_sha: args.head_sha.unwrap_or_default(),
        title: args.title.unwrap_or_default(),
        completeness: args.completeness,
        redaction_policy_version: REDACTION_POLICY_VERSION.to_string(),
        segments: Vec::new(),
    };
    if manifest_path.is_file() {
        let existing: TranscriptManifest = serde_json::from_reader(File::open(&manifest_path)?)?;
        validate_manifest(&existing)?;
        validate_append_identity(&existing, &manifest)?;
        let next_entry_index = validate_existing_prefix(&existing, &spool_root, &entries)?;
        let mut segments = existing.segments;
        let next_segment_index = segments.len() as u64;
        segments.extend(write_segments_from(
            &spool_root,
            &entries[next_entry_index..],
            next_segment_index,
            next_entry_index as u64,
        )?);
        manifest.segments = segments;
    } else {
        manifest.segments = write_segments_from(&spool_root, &entries, 0, 0)?;
    }
    write_private_json(&manifest_path, &manifest)?;
    Ok(json!({
        "operation": "transcript.prepare",
        "session_id": session_id,
        "manifest": manifest_path,
        "segments": manifest.segments.len(),
        "entries": entries.len(),
        "size_bytes": manifest.segments.iter().map(|segment| segment.size_bytes).sum::<u64>(),
        "redaction_policy_version": REDACTION_POLICY_VERSION,
    }))
}

fn push_transcript(args: PushTranscriptArgs) -> Result<Value, TranscriptError> {
    validate_endpoint(&args.endpoint)?;
    let manifest_path = args.manifest;
    let manifest_dir = manifest_path.parent().ok_or_else(|| {
        TranscriptError::InvalidInput("manifest path must have a parent directory".to_string())
    })?;
    let _manifest_lock = lock_manifest_directory(manifest_dir)?;
    let mut manifest: TranscriptManifest = serde_json::from_reader(File::open(&manifest_path)?)?;
    validate_manifest(&manifest)?;
    let http: Agent = Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let url = format!(
        "{}/{}",
        args.endpoint.trim_end_matches('/'),
        TRANSCRIPT_METHOD
    );
    let mut uploaded = 0_u64;
    let mut replayed = 0_u64;
    let mut skipped = 0_u64;
    for index in 0..manifest.segments.len() {
        if manifest.segments[index].upload.is_some() {
            skipped += 1;
            continue;
        }
        let request = upload_request(&manifest, &manifest.segments[index], manifest_dir)?;
        let body = request.encode_to_vec();
        let mut builder = http
            .post(&url)
            .header("Accept", "application/proto")
            .header("Content-Type", "application/proto")
            .header("Connect-Protocol-Version", "1")
            .header("X-Organization-ID", &manifest.organization_id)
            .header("X-Workspace-ID", &manifest.workspace_id);
        if let Some(token) = args.token.as_deref() {
            builder = builder.header("Authorization", &format!("Bearer {token}"));
        }
        let mut response = builder
            .send(&body)
            .map_err(|error| map_upload_error(index, error))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(TranscriptError::Upload(format!(
                "segment {index} returned HTTP {status}"
            )));
        }
        let response_bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(|error| {
                TranscriptError::Upload(format!(
                    "segment {index} returned an invalid or oversized response: {error}"
                ))
            })?;
        let decoded =
            sessions_pb::RecordTranscriptSegmentResponse::decode(response_bytes.as_slice())
                .map_err(|error| {
                    TranscriptError::Upload(format!(
                        "segment {index} returned invalid protobuf: {error}"
                    ))
                })?;
        let segment = decoded.segment.as_ref().ok_or_else(|| {
            TranscriptError::Upload(format!("segment {index} response omitted segment metadata"))
        })?;
        if segment.sha256 != manifest.segments[index].sha256
            || segment.segment_index != manifest.segments[index].segment_index
        {
            return Err(TranscriptError::Upload(format!(
                "segment {index} response did not match the spooled digest and index"
            )));
        }
        manifest.segments[index].upload = Some(UploadReceipt {
            segment_id: segment.segment_id.clone(),
            object_id: segment.object_id.clone(),
            version_id: segment.version_id.clone(),
            replayed: decoded.replayed,
            recorded_at: segment.recorded_at.clone(),
        });
        if decoded.replayed {
            replayed += 1;
        } else {
            uploaded += 1;
        }
        write_private_json(&manifest_path, &manifest)?;
    }
    Ok(json!({
        "operation": "transcript.push",
        "session_id": manifest.session_id,
        "manifest": manifest_path,
        "uploaded": uploaded,
        "replayed": replayed,
        "already_receipted": skipped,
        "complete": manifest.segments.iter().all(|segment| segment.upload.is_some()),
    }))
}

fn read_redacted_entries(
    input: &Path,
    agent: TranscriptAgent,
    repo: &Path,
) -> Result<Vec<Vec<u8>>, TranscriptError> {
    let mut entries = Vec::new();
    for (source_index, line) in BufReader::new(File::open(input)?).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|error| {
            TranscriptError::InvalidInput(format!(
                "line {} is not valid JSON: {error}",
                source_index + 1
            ))
        })?;
        if !value.is_object() {
            return Err(TranscriptError::InvalidInput(format!(
                "line {} must be a JSON object",
                source_index + 1
            )));
        }
        let envelope = json!({
            "agent": agent.storage_name(),
            "event": redact_transcript_value(value, repo),
            "schema": "evalops.session.transcript.v1",
            "source_index": source_index,
        });
        let mut encoded = serde_json::to_vec(&envelope)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_SEGMENT_BYTES {
            return Err(TranscriptError::InvalidInput(format!(
                "line {} exceeds the 524288-byte segment limit after redaction",
                source_index + 1
            )));
        }
        entries.push(encoded);
    }
    Ok(entries)
}

fn redact_transcript_value(value: Value, repo: &Path) -> Value {
    match value {
        Value::String(value) => Value::String(redact_text(&value, repo)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_transcript_value(value, repo))
                .collect(),
        ),
        Value::Object(values) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in values {
                if is_secret_key(&key) {
                    redacted.insert(key, Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key, redact_transcript_value(value, repo));
                }
            }
            Value::Object(redacted)
        }
        value => value,
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "authorization"
            | "cookie"
            | "set_cookie"
            | "api_key"
            | "apikey"
            | "secret"
            | "secret_key"
            | "password"
            | "token"
            | "access_token"
            | "refresh_token"
            | "private_key"
            | "headers"
            | "env"
            | "environment"
            | "environ"
    )
}

fn write_segments_from(
    spool_root: &Path,
    entries: &[Vec<u8>],
    first_segment_index: u64,
    first_entry_offset: u64,
) -> Result<Vec<SpoolSegment>, TranscriptError> {
    let mut segments = Vec::new();
    let mut bytes = Vec::new();
    let mut first_entry_index = first_entry_offset;
    for (entry_index, entry) in entries.iter().enumerate() {
        let entry_index = first_entry_offset + entry_index as u64;
        if !bytes.is_empty() && bytes.len() + entry.len() > MAX_SEGMENT_BYTES {
            segments.push(write_segment(
                spool_root,
                first_segment_index + segments.len() as u64,
                first_entry_index,
                entry_index - 1,
                &bytes,
            )?);
            bytes.clear();
            first_entry_index = entry_index;
        }
        bytes.extend_from_slice(entry);
    }
    if !bytes.is_empty() {
        segments.push(write_segment(
            spool_root,
            first_segment_index + segments.len() as u64,
            first_entry_index,
            first_entry_offset + entries.len() as u64 - 1,
            &bytes,
        )?);
    }
    Ok(segments)
}

fn validate_append_identity(
    existing: &TranscriptManifest,
    incoming: &TranscriptManifest,
) -> Result<(), TranscriptError> {
    let matches = existing.version == incoming.version
        && existing.organization_id == incoming.organization_id
        && existing.workspace_id == incoming.workspace_id
        && existing.session_id == incoming.session_id
        && existing.source_session_id == incoming.source_session_id
        && existing.agent == incoming.agent
        && existing.agent_name == incoming.agent_name
        && existing.repository_url == incoming.repository_url
        && existing.working_directory == incoming.working_directory
        && existing.redaction_policy_version == incoming.redaction_policy_version;
    if !matches {
        return Err(TranscriptError::InvalidInput(
            "existing transcript manifest identity does not match this capture".to_string(),
        ));
    }
    Ok(())
}

fn validate_existing_prefix(
    manifest: &TranscriptManifest,
    manifest_dir: &Path,
    entries: &[Vec<u8>],
) -> Result<usize, TranscriptError> {
    for segment in &manifest.segments {
        let path = safe_segment_path(manifest_dir, &segment.path)?;
        let content = fs::read(&path)?;
        if content.len() as u64 != segment.size_bytes
            || format!("{:x}", Sha256::digest(&content)) != segment.sha256
        {
            return Err(TranscriptError::InvalidInput(format!(
                "spooled segment failed size or digest verification: {}",
                path.display()
            )));
        }
        let first = segment.first_entry_index as usize;
        let last = segment.last_entry_index as usize;
        let Some(prefix) = entries.get(first..=last) else {
            return Err(TranscriptError::InvalidInput(
                "existing transcript prefix was truncated".to_string(),
            ));
        };
        let expected = prefix.concat();
        if content != expected {
            return Err(TranscriptError::InvalidInput(
                "existing transcript prefix changed after it was spooled".to_string(),
            ));
        }
    }
    Ok(manifest
        .segments
        .last()
        .map_or(0, |segment| segment.last_entry_index as usize + 1))
}

fn write_segment(
    spool_root: &Path,
    segment_index: u64,
    first_entry_index: u64,
    last_entry_index: u64,
    bytes: &[u8],
) -> Result<SpoolSegment, TranscriptError> {
    let filename = format!("segment-{segment_index:020}.jsonl");
    let path = spool_root.join(&filename);
    write_private(&path, bytes)?;
    Ok(SpoolSegment {
        segment_index,
        first_entry_index,
        last_entry_index,
        omitted_entry_count: 0,
        path: filename,
        size_bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        upload: None,
    })
}

fn upload_request(
    manifest: &TranscriptManifest,
    segment: &SpoolSegment,
    manifest_dir: &Path,
) -> Result<sessions_pb::RecordTranscriptSegmentRequest, TranscriptError> {
    let path = safe_segment_path(manifest_dir, &segment.path)?;
    let content = fs::read(&path)?;
    if content.len() as u64 != segment.size_bytes
        || format!("{:x}", Sha256::digest(&content)) != segment.sha256
    {
        return Err(TranscriptError::InvalidInput(format!(
            "spooled segment failed size or digest verification: {}",
            path.display()
        )));
    }
    Ok(sessions_pb::RecordTranscriptSegmentRequest {
        organization_id: manifest.organization_id.clone(),
        workspace_id: manifest.workspace_id.clone(),
        session: Some(sessions_pb::AgentSessionDescriptor {
            session_id: manifest.session_id.clone(),
            agent_kind: manifest.agent.proto() as i32,
            agent_name: manifest.agent_name.clone(),
            source_session_id: manifest.source_session_id.clone(),
            repository_url: manifest.repository_url.clone(),
            working_directory: manifest.working_directory.clone(),
            branch: manifest.branch.clone(),
            head_sha: manifest.head_sha.clone(),
            title: manifest.title.clone(),
            completeness: manifest.completeness.proto() as i32,
            ..Default::default()
        }),
        segment_index: segment.segment_index,
        first_entry_index: segment.first_entry_index,
        last_entry_index: segment.last_entry_index,
        content,
        sha256: segment.sha256.clone(),
        edge_redacted: true,
        redaction_policy_version: manifest.redaction_policy_version.clone(),
        omitted_entry_count: segment.omitted_entry_count,
    })
}

fn validate_manifest(manifest: &TranscriptManifest) -> Result<(), TranscriptError> {
    if manifest.version != MANIFEST_VERSION {
        return Err(TranscriptError::InvalidInput(format!(
            "unsupported transcript manifest version {}",
            manifest.version
        )));
    }
    validate_identifier("organization_id", &manifest.organization_id, 255)?;
    validate_identifier("workspace_id", &manifest.workspace_id, 255)?;
    validate_identifier("session_id", &manifest.session_id, 255)?;
    validate_identifier("source_session_id", &manifest.source_session_id, 1024)?;
    if !matches!(
        manifest.redaction_policy_version.as_str(),
        REDACTION_POLICY_VERSION | LEGACY_REDACTION_POLICY_VERSION
    ) {
        return Err(TranscriptError::InvalidInput(format!(
            "unsupported redaction policy version {}",
            manifest.redaction_policy_version
        )));
    }
    if manifest.segments.is_empty() {
        return Err(TranscriptError::InvalidInput(
            "manifest has no transcript segments".to_string(),
        ));
    }
    let mut expected_entry_index = 0_u64;
    for (expected_index, segment) in manifest.segments.iter().enumerate() {
        if segment.segment_index != expected_index as u64
            || segment.first_entry_index != expected_entry_index
            || segment.last_entry_index < segment.first_entry_index
            || segment.size_bytes == 0
            || segment.size_bytes > MAX_SEGMENT_BYTES as u64
        {
            return Err(TranscriptError::InvalidInput(format!(
                "manifest segment {expected_index} has invalid indices or size"
            )));
        }
        expected_entry_index = segment.last_entry_index + 1;
    }
    Ok(())
}

fn safe_segment_path(manifest_dir: &Path, relative: &str) -> Result<PathBuf, TranscriptError> {
    let relative = Path::new(relative);
    let components = relative.components().collect::<Vec<_>>();
    if relative.is_absolute()
        || components.len() != 1
        || !matches!(components[0], std::path::Component::Normal(_))
    {
        return Err(TranscriptError::InvalidInput(
            "manifest segment path must be a single relative filename".to_string(),
        ));
    }
    Ok(manifest_dir.join(relative))
}

fn transcript_state_root(state_dir: Option<&Path>) -> Result<PathBuf, TranscriptError> {
    let root = state_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".dx")
    });
    let root = root.join("transcripts");
    create_private_dir(&root)?;
    Ok(root)
}

fn create_private_dir(path: &Path) -> Result<(), TranscriptError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), TranscriptError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_private(path, &bytes)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), TranscriptError> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            TranscriptError::InvalidInput("spool path has no valid filename".to_string())
        })?;
    let temporary = path.with_file_name(format!(".{filename}.tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    Ok(())
}

fn validate_identifier(name: &str, value: &str, maximum: usize) -> Result<(), TranscriptError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(TranscriptError::InvalidInput(format!(
            "{name} must be normalized and between 1 and {maximum} bytes"
        )));
    }
    Ok(())
}

fn validate_endpoint(value: &str) -> Result<(), TranscriptError> {
    let (secure, remainder) = if let Some(remainder) = value.strip_prefix("https://") {
        (true, remainder)
    } else if let Some(remainder) = value.strip_prefix("http://") {
        (false, remainder)
    } else {
        return Err(TranscriptError::InvalidInput(
            "--endpoint must use http or https".to_string(),
        ));
    };
    let authority = remainder.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || value.chars().any(char::is_control) {
        return Err(TranscriptError::InvalidInput(
            "--endpoint must not contain credentials or control characters".to_string(),
        ));
    }
    let host = if let Some(host) = authority.strip_prefix('[') {
        host.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if !secure && !loopback {
        return Err(TranscriptError::InvalidInput(
            "--endpoint must use HTTPS unless the host is loopback".to_string(),
        ));
    }
    Ok(())
}

fn stable_session_id(
    agent: TranscriptAgent,
    source_session_id: &str,
    repository_url: &str,
) -> String {
    let mut digest = Sha256::new();
    for value in [agent.storage_name(), source_session_id, repository_url] {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    format!("agent-session-{:x}", digest.finalize())
}

fn map_upload_error(segment_index: usize, error: ureq::Error) -> TranscriptError {
    TranscriptError::Upload(match error {
        ureq::Error::StatusCode(status) => {
            format!("segment {segment_index} returned HTTP {status}")
        }
        ureq::Error::Timeout(_) => format!("segment {segment_index} upload timed out"),
        ureq::Error::HostNotFound => {
            format!("segment {segment_index} upload host was not found")
        }
        error => format!("segment {segment_index} upload failed: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::tempdir;

    #[test]
    fn redaction_preserves_output_but_removes_secrets() {
        let value = json!({
            "output": "Bearer secret-value and ghp_abcdefghijklmnopqrstuvwxyz",
            "token": "must-not-survive",
            "nested": {"password": "must-not-survive", "text": "visible"},
        });
        let redacted = redact_transcript_value(value, Path::new("."));
        assert_eq!(redacted["token"], "[redacted]");
        assert_eq!(redacted["nested"]["password"], "[redacted]");
        assert_eq!(redacted["nested"]["text"], "visible");
        assert!(redacted["output"].as_str().unwrap().contains("[redacted]"));
        assert!(!redacted.to_string().contains("must-not-survive"));
    }

    #[test]
    fn prepare_spools_private_canonical_segments_and_manifest() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("codex.jsonl");
        fs::write(
            &input,
            "{\"type\":\"message\",\"token\":\"secret\"}\n{\"type\":\"tool\",\"output\":\"ok\"}\n",
        )
        .unwrap();
        let state = temp.path().join("state");
        let output = prepare_transcript(
            PrepareTranscriptArgs {
                input,
                agent: TranscriptAgent::Codex,
                source_session_id: "source-1".to_string(),
                session_id: Some("session-1".to_string()),
                organization: "org-1".to_string(),
                workspace: "workspace-1".to_string(),
                repository_url: Some("https://github.com/evalops/mono".to_string()),
                working_directory: Some(temp.path().display().to_string()),
                branch: Some("main".to_string()),
                head_sha: Some("0123456789abcdef".to_string()),
                title: Some("test".to_string()),
                completeness: TranscriptCompletenessArg::Complete,
            },
            Some(&state),
        )
        .unwrap();
        let manifest_path = PathBuf::from(output["manifest"].as_str().unwrap());
        let manifest: TranscriptManifest =
            serde_json::from_reader(File::open(&manifest_path).unwrap()).unwrap();
        assert_eq!(manifest.segments.len(), 1);
        let segment_path = manifest_path
            .parent()
            .unwrap()
            .join(&manifest.segments[0].path);
        let content = fs::read_to_string(segment_path).unwrap();
        assert!(content.ends_with('\n'));
        assert!(content.contains("[redacted]"));
        assert!(!content.contains("\"token\":\"secret\""));
        let request = upload_request(
            &manifest,
            &manifest.segments[0],
            manifest_path.parent().unwrap(),
        )
        .unwrap();
        assert!(request.edge_redacted);
        assert_eq!(request.redaction_policy_version, REDACTION_POLICY_VERSION);
        assert_eq!(request.last_entry_index, 1);
        assert_eq!(request.sha256, manifest.segments[0].sha256);
    }

    #[test]
    fn preparing_a_resumed_maestro_session_appends_after_receipted_segments() {
        // Maestro sessions can be switched away from and later resumed. The
        // server owns immutable segment indices, so preparing the larger JSONL
        // must retain segment 0 and append the newly observed entry as segment
        // 1 instead of rewriting the earlier receipt.
        let temp = tempdir().unwrap();
        let input = temp.path().join("maestro.jsonl");
        fs::write(&input, "{\"type\":\"message\",\"text\":\"first\"}\n").unwrap();
        let state = temp.path().join("state");
        let prepare = || {
            prepare_transcript(
                PrepareTranscriptArgs {
                    input: input.clone(),
                    agent: TranscriptAgent::Maestro,
                    source_session_id: "maestro-resumed-1".to_string(),
                    session_id: Some("session-resumed-1".to_string()),
                    organization: "org-1".to_string(),
                    workspace: "workspace-1".to_string(),
                    repository_url: Some("https://github.com/evalops/mono".to_string()),
                    working_directory: Some(temp.path().display().to_string()),
                    branch: Some("main".to_string()),
                    head_sha: Some("0123456789abcdef".to_string()),
                    title: None,
                    completeness: TranscriptCompletenessArg::InProgress,
                },
                Some(&state),
            )
            .unwrap()
        };

        let first = prepare();
        let manifest_path = PathBuf::from(first["manifest"].as_str().unwrap());
        let mut first_manifest: TranscriptManifest =
            serde_json::from_reader(File::open(&manifest_path).unwrap()).unwrap();
        let first_digest = first_manifest.segments[0].sha256.clone();
        first_manifest.segments[0].upload = Some(UploadReceipt {
            segment_id: "segment-0".to_string(),
            object_id: "object-0".to_string(),
            version_id: "version-0".to_string(),
            replayed: false,
            recorded_at: "2026-08-31T00:00:00Z".to_string(),
        });
        write_private_json(&manifest_path, &first_manifest).unwrap();

        fs::write(
            &input,
            concat!(
                "{\"type\":\"message\",\"text\":\"first\"}\n",
                "{\"type\":\"message\",\"text\":\"second\"}\n"
            ),
        )
        .unwrap();
        prepare();

        let resumed: TranscriptManifest =
            serde_json::from_reader(File::open(&manifest_path).unwrap()).unwrap();
        assert_eq!(resumed.segments.len(), 2);
        assert_eq!(resumed.segments[0].sha256, first_digest);
        assert_eq!(
            resumed.segments[0].upload.as_ref().unwrap().object_id,
            "object-0"
        );
        assert_eq!(resumed.segments[1].segment_index, 1);
        assert_eq!(resumed.segments[1].first_entry_index, 1);
        assert_eq!(resumed.segments[1].last_entry_index, 1);
    }

    #[test]
    fn preparing_a_resumed_session_rejects_a_changed_spooled_prefix() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("maestro.jsonl");
        fs::write(&input, "{\"type\":\"message\",\"text\":\"first\"}\n").unwrap();
        let state = temp.path().join("state");
        let prepare = || {
            prepare_transcript(
                PrepareTranscriptArgs {
                    input: input.clone(),
                    agent: TranscriptAgent::Maestro,
                    source_session_id: "maestro-changed-1".to_string(),
                    session_id: Some("session-changed-1".to_string()),
                    organization: "org-1".to_string(),
                    workspace: "workspace-1".to_string(),
                    repository_url: Some("https://github.com/evalops/mono".to_string()),
                    working_directory: Some(temp.path().display().to_string()),
                    branch: Some("main".to_string()),
                    head_sha: Some("0123456789abcdef".to_string()),
                    title: None,
                    completeness: TranscriptCompletenessArg::InProgress,
                },
                Some(&state),
            )
        };

        prepare().unwrap();
        fs::write(&input, "{\"type\":\"message\",\"text\":\"changed\"}\n").unwrap();
        let error = prepare().expect_err("an immutable prefix change must fail closed");
        assert!(error.to_string().contains("prefix changed"), "{error}");
    }

    #[test]
    fn manifest_paths_cannot_escape_the_private_spool() {
        let err = safe_segment_path(Path::new("/tmp/spool"), "../secret")
            .expect_err("parent traversal rejected");
        assert!(err.to_string().contains("single relative filename"));
        let err = safe_segment_path(Path::new("/tmp/spool"), "/tmp/secret")
            .expect_err("absolute path rejected");
        assert!(err.to_string().contains("single relative filename"));
    }

    #[test]
    fn remote_plaintext_endpoints_are_rejected_but_loopback_is_allowed() {
        assert!(validate_endpoint("https://platform.example.com").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8080").is_ok());
        assert!(validate_endpoint("http://localhost:8080").is_ok());
        assert!(validate_endpoint("http://127.evil.example").is_err());
        let error = validate_endpoint("http://platform.example.com")
            .expect_err("remote plaintext endpoint must fail closed");
        assert!(error.to_string().contains("HTTPS"), "{error}");
    }

    #[test]
    fn push_persists_receipt_and_skips_it_on_retry() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("maestro.jsonl");
        fs::write(&input, "{\"type\":\"turn\",\"text\":\"done\"}\n").unwrap();
        let state = temp.path().join("state");
        let prepared = prepare_transcript(
            PrepareTranscriptArgs {
                input,
                agent: TranscriptAgent::Maestro,
                source_session_id: "maestro-source-1".to_string(),
                session_id: Some("maestro-session-1".to_string()),
                organization: "org-1".to_string(),
                workspace: "workspace-1".to_string(),
                repository_url: None,
                working_directory: Some(temp.path().display().to_string()),
                branch: None,
                head_sha: None,
                title: None,
                completeness: TranscriptCompletenessArg::Complete,
            },
            Some(&state),
        )
        .unwrap();
        let manifest_path = PathBuf::from(prepared["manifest"].as_str().unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end;
            loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                received.extend_from_slice(&buffer[..read]);
                if let Some(position) = received.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    header_end = position + 4;
                    break;
                }
            }
            let headers = String::from_utf8(received[..header_end].to_vec()).unwrap();
            let lower_headers = headers.to_ascii_lowercase();
            assert!(lower_headers.contains("content-type: application/proto"));
            assert!(lower_headers.contains("x-organization-id: org-1"));
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while received.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                received.extend_from_slice(&buffer[..read]);
            }
            let request = sessions_pb::RecordTranscriptSegmentRequest::decode(
                &received[header_end..header_end + content_length],
            )
            .unwrap();
            assert!(request.edge_redacted);
            assert_eq!(
                request.session.as_ref().unwrap().session_id,
                "maestro-session-1"
            );
            let response = sessions_pb::RecordTranscriptSegmentResponse {
                segment: Some(sessions_pb::TranscriptSegment {
                    segment_id: "segment-1".to_string(),
                    organization_id: request.organization_id,
                    workspace_id: request.workspace_id,
                    session_id: "maestro-session-1".to_string(),
                    segment_index: request.segment_index,
                    first_entry_index: request.first_entry_index,
                    last_entry_index: request.last_entry_index,
                    object_id: "object-1".to_string(),
                    version_id: "version-1".to_string(),
                    content_type: "application/x-ndjson".to_string(),
                    size_bytes: request.content.len() as i64,
                    sha256: request.sha256,
                    recorded_at: "2026-08-24T00:00:00Z".to_string(),
                    redaction_policy_version: request.redaction_policy_version,
                    ..Default::default()
                }),
                ..Default::default()
            }
            .encode_to_vec();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/proto\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .unwrap();
            stream.write_all(&response).unwrap();
        });

        let first = push_transcript(PushTranscriptArgs {
            manifest: manifest_path.clone(),
            endpoint: format!("http://{address}"),
            token: None,
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(first["uploaded"], 1);
        let manifest: TranscriptManifest =
            serde_json::from_reader(File::open(&manifest_path).unwrap()).unwrap();
        assert_eq!(
            manifest.segments[0].upload.as_ref().unwrap().object_id,
            "object-1"
        );

        let retry = push_transcript(PushTranscriptArgs {
            manifest: manifest_path,
            endpoint: format!("http://{address}"),
            token: None,
        })
        .unwrap();
        assert_eq!(retry["already_receipted"], 1);
        assert_eq!(retry["uploaded"], 0);
        assert_eq!(retry["complete"], true);
    }
}

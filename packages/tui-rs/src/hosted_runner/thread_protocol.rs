use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use chrono::{SecondsFormat, Utc};
use fd_lock::RwLock as FileLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::session_scope::MaestroThreadId;
use crate::headless::{CodeMode, GovernedToolGrant};

use super::{
    response_ack_request_id, FromAgentMessage, IdentityBindingFailure, ServerRequestType,
    StreamEnvelope, ToAgentMessage,
};

pub(super) const THREAD_PROTOCOL_VERSION: &str = "evalops.maestro.thread.v1";
pub(super) const GOVERNED_THREAD_PROTOCOL_VERSION: &str = "evalops.maestro.thread.v2";
pub(super) const GOVERNED_THREAD_REQUIRED_FIELDS: &[&str] = &["codeMode", "toolGrant"];
const MAX_TURN_ID_BYTES: usize = 128;
const MAX_CONTENT_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENTS: usize = 64;

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ThreadTurnKind {
    UserMessage,
    Steer,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ThreadPhase {
    Idle,
    Accepted,
    Running,
    WaitingForApproval,
    WaitingForInput,
    WaitingForClientTool,
    WaitingForRetry,
    Completed,
    Failed,
    Interrupted,
}

impl ThreadPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppendTurnRequest {
    pub(super) protocol_version: String,
    pub(super) turn_id: String,
    pub(super) kind: ThreadTurnKind,
    pub(super) content: String,
    #[serde(default)]
    pub(super) attachments: Option<Vec<String>>,
    #[serde(default)]
    pub(super) code_mode: Option<CodeMode>,
    #[serde(default)]
    pub(super) tool_grant: Option<GovernedToolGrant>,
}

impl AppendTurnRequest {
    fn governed_fields_are_valid(&self) -> bool {
        GOVERNED_THREAD_REQUIRED_FIELDS
            .iter()
            .all(|field| match *field {
                "codeMode" => self.code_mode == Some(CodeMode::GovernedCode),
                "toolGrant" => self.tool_grant.is_some(),
                _ => false,
            })
    }

    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version != THREAD_PROTOCOL_VERSION
            && self.protocol_version != GOVERNED_THREAD_PROTOCOL_VERSION
        {
            return Err("unsupported thread protocol version");
        }
        match self.protocol_version.as_str() {
            THREAD_PROTOCOL_VERSION if self.code_mode.is_none() && self.tool_grant.is_none() => {}
            GOVERNED_THREAD_PROTOCOL_VERSION if self.governed_fields_are_valid() => {}
            GOVERNED_THREAD_PROTOCOL_VERSION => {
                return Err("governed thread protocol requires codeMode and toolGrant")
            }
            THREAD_PROTOCOL_VERSION => {
                return Err("thread v1 does not accept governed code fields")
            }
            _ => return Err("unsupported thread protocol version"),
        }
        if self.turn_id.is_empty() || self.turn_id.len() > MAX_TURN_ID_BYTES {
            return Err("turnId must contain between 1 and 128 bytes");
        }
        if self.content.is_empty() || self.content.len() > MAX_CONTENT_BYTES {
            return Err("content must contain between 1 byte and 1 MiB");
        }
        if self
            .attachments
            .as_ref()
            .is_some_and(|attachments| attachments.len() > MAX_ATTACHMENTS)
        {
            return Err("attachments must contain at most 64 entries");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct ThreadTurnRecord {
    pub(super) turn_id: String,
    pub(super) run_id: String,
    pub(super) kind: ThreadTurnKind,
    pub(super) content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) attachments: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) code_mode: Option<CodeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) tool_grant: Option<GovernedToolGrant>,
    pub(super) phase: ThreadPhase,
    pub(super) accepted_at: String,
    pub(super) cursor: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) provider_error_kind: Option<maestro_ai::ProviderStreamErrorKind>,
}

impl ThreadTurnRecord {
    pub(super) fn matches(&self, request: &AppendTurnRequest) -> bool {
        self.kind == request.kind
            && self.content == request.content
            && self.attachments == request.attachments
            && self.code_mode == request.code_mode
            && self.tool_grant == request.tool_grant
    }
}

#[derive(Debug, Clone)]
pub(super) struct ThreadProtocolState {
    thread_id: MaestroThreadId,
    turns: Vec<ThreadTurnRecord>,
    active_turn_ids: VecDeque<String>,
}

impl ThreadProtocolState {
    pub(super) fn new(thread_id: MaestroThreadId) -> Self {
        Self {
            thread_id,
            turns: Vec::new(),
            active_turn_ids: VecDeque::new(),
        }
    }

    fn restore(thread_id: MaestroThreadId, mut turns: Vec<ThreadTurnRecord>) -> Self {
        for turn in &mut turns {
            if !turn.phase.is_terminal() {
                turn.phase = ThreadPhase::Interrupted;
            }
        }
        Self {
            thread_id,
            turns,
            active_turn_ids: VecDeque::new(),
        }
    }

    pub(super) fn turn(&self, turn_id: &str) -> Option<&ThreadTurnRecord> {
        self.turns.iter().find(|turn| turn.turn_id == turn_id)
    }

    pub(super) fn planned_run_id(&self, request: &AppendTurnRequest) -> String {
        if request.kind == ThreadTurnKind::Steer {
            self.active_turn_ids
                .front()
                .and_then(|active_turn_id| self.turn(active_turn_id))
                .map(|turn| turn.run_id.clone())
                .unwrap_or_else(|| format!("run_{}", request.turn_id))
        } else {
            format!("run_{}", request.turn_id)
        }
    }

    pub(super) fn append(&mut self, request: AppendTurnRequest, cursor: u64) {
        let run_id = self.planned_run_id(&request);
        let turn_id = request.turn_id;
        self.active_turn_ids.push_back(turn_id.clone());
        self.turns.push(ThreadTurnRecord {
            run_id,
            turn_id,
            kind: request.kind,
            content: request.content,
            attachments: request.attachments,
            code_mode: request.code_mode,
            tool_grant: request.tool_grant,
            phase: ThreadPhase::Accepted,
            accepted_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            cursor,
            provider_error_kind: None,
        });
    }

    /// Roll back the latest append when its initial journal write failed.
    ///
    /// No dispatch has happened at this point, so retaining an in-memory
    /// `Accepted` record would make an identical retry look replayed even
    /// though the prompt was never delivered to the runtime.
    pub(super) fn rollback_unpersisted_append(&mut self, turn_id: &str) {
        let is_latest_accepted = self
            .turns
            .last()
            .is_some_and(|turn| turn.turn_id == turn_id && turn.phase == ThreadPhase::Accepted);
        let is_latest_active = self
            .active_turn_ids
            .back()
            .is_some_and(|active_turn_id| active_turn_id == turn_id);
        if is_latest_accepted && is_latest_active {
            self.turns.pop();
            self.active_turn_ids.pop_back();
        }
    }

    pub(super) fn mark_dispatched(&mut self, cursor: u64) {
        let Some(turn) = self.latest_active_turn_mut() else {
            return;
        };
        if turn.phase == ThreadPhase::Accepted {
            turn.phase = ThreadPhase::Running;
            turn.cursor = cursor;
        }
    }

    pub(super) fn mark_failed(&mut self, cursor: u64) {
        if let Some(turn) = self.latest_active_turn_mut() {
            turn.phase = ThreadPhase::Failed;
            turn.cursor = cursor;
        }
        self.active_turn_ids.pop_back();
    }

    pub(super) fn apply_agent_message(&mut self, message: &FromAgentMessage, cursor: u64) {
        match message {
            FromAgentMessage::ResponseStart { .. } => {
                if let Some(turn) = self.active_turn_mut() {
                    turn.phase = ThreadPhase::Running;
                    turn.cursor = cursor;
                }
            }
            FromAgentMessage::TurnCompleted { .. } => {
                self.mark_active_run_terminal(ThreadPhase::Completed, cursor, None);
            }
            FromAgentMessage::TurnInterrupted { .. } => {
                self.mark_active_run_terminal(ThreadPhase::Interrupted, cursor, None);
            }
            FromAgentMessage::ServerRequest { request_type, .. } => {
                let phase = match request_type {
                    ServerRequestType::Approval => ThreadPhase::WaitingForApproval,
                    ServerRequestType::UserInput => ThreadPhase::WaitingForInput,
                    ServerRequestType::ClientTool => ThreadPhase::WaitingForClientTool,
                    ServerRequestType::ToolRetry => ThreadPhase::WaitingForRetry,
                };
                if let Some(turn) = self.active_turn_mut() {
                    turn.phase = phase;
                    turn.cursor = cursor;
                }
            }
            FromAgentMessage::ServerRequestResolved { .. } => {
                if let Some(turn) = self.active_turn_mut() {
                    turn.phase = ThreadPhase::Running;
                    turn.cursor = cursor;
                }
            }
            FromAgentMessage::Error {
                fatal,
                terminal,
                error_type,
                ..
            } => {
                if !fatal && !terminal {
                    return;
                }
                let phase = if *fatal
                    || matches!(
                        error_type,
                        Some(crate::headless::messages::HeadlessErrorType::Cancelled)
                    ) {
                    ThreadPhase::Interrupted
                } else {
                    ThreadPhase::Failed
                };
                self.mark_active_run_terminal(phase, cursor, None);
            }
            FromAgentMessage::ProviderError { kind, .. } => {
                self.mark_active_run_terminal(ThreadPhase::Failed, cursor, Some(*kind));
            }
            _ => {}
        }
    }

    pub(super) fn view(&self, cursor: u64, runtime_generation: u64) -> ThreadStateView<'_> {
        ThreadStateView {
            protocol_version: THREAD_PROTOCOL_VERSION,
            thread_id: &self.thread_id,
            runtime_generation,
            phase: self.phase(),
            active_turn_id: self.active_turn_ids.front().map(String::as_str),
            cursor,
            turns: &self.turns,
        }
    }

    pub(super) fn phase(&self) -> ThreadPhase {
        self.active_turn_ids
            .front()
            .and_then(|turn_id| self.turn(turn_id))
            .map(|turn| turn.phase)
            .or_else(|| self.turns.last().map(|turn| turn.phase))
            .unwrap_or(ThreadPhase::Idle)
    }

    pub(super) fn has_active_turn(&self) -> bool {
        !self.active_turn_ids.is_empty()
    }

    fn active_turn_mut(&mut self) -> Option<&mut ThreadTurnRecord> {
        let turn_id = self.active_turn_ids.front()?.clone();
        self.turns.iter_mut().find(|turn| turn.turn_id == turn_id)
    }

    fn latest_active_turn_mut(&mut self) -> Option<&mut ThreadTurnRecord> {
        let turn_id = self.active_turn_ids.back()?.clone();
        self.turns.iter_mut().find(|turn| turn.turn_id == turn_id)
    }

    fn mark_active_run_terminal(
        &mut self,
        phase: ThreadPhase,
        cursor: u64,
        provider_error_kind: Option<maestro_ai::ProviderStreamErrorKind>,
    ) {
        let Some(run_id) = self
            .active_turn_ids
            .front()
            .and_then(|turn_id| self.turn(turn_id))
            .map(|turn| turn.run_id.clone())
        else {
            return;
        };
        let mut terminal_turn_ids = std::collections::HashSet::new();
        for turn in self.turns.iter_mut().filter(|turn| turn.run_id == run_id) {
            turn.phase = phase;
            turn.cursor = cursor;
            turn.provider_error_kind = provider_error_kind;
            terminal_turn_ids.insert(turn.turn_id.clone());
        }
        self.active_turn_ids
            .retain(|turn_id| !terminal_turn_ids.contains(turn_id));
    }
}

#[derive(Serialize)]
pub(super) struct ThreadStateView<'a> {
    pub(super) protocol_version: &'static str,
    pub(super) thread_id: &'a MaestroThreadId,
    pub(super) runtime_generation: u64,
    pub(super) phase: ThreadPhase,
    pub(super) active_turn_id: Option<&'a str>,
    pub(super) cursor: u64,
    pub(super) turns: &'a [ThreadTurnRecord],
}

#[derive(Debug, Deserialize, Serialize)]
struct DurableThreadDocument {
    protocol_version: String,
    thread_id: String,
    runtime_generation: u64,
    cursor: u64,
    turns: Vec<ThreadTurnRecord>,
    events: Vec<StreamEnvelope>,
    #[serde(default)]
    identity_binding_failures: Vec<IdentityBindingFailure>,
    #[serde(default)]
    response_idempotency_keys: Vec<String>,
    #[serde(default)]
    response_idempotency_digests: HashMap<String, String>,
    #[serde(default)]
    response_request_owners: HashMap<String, String>,
    #[serde(default)]
    pending_response_idempotency: HashMap<String, ToAgentMessage>,
    #[serde(default)]
    response_idempotency_order: Vec<String>,
    #[serde(default)]
    pending_response_idempotency_order: Vec<String>,
}

pub(super) struct ThreadJournal {
    path: PathBuf,
    _lock: ThreadJournalLock,
}

struct ThreadJournalLock {
    release: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for ThreadJournalLock {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(super) struct LoadedThreadJournal {
    pub(super) journal: ThreadJournal,
    pub(super) state: ThreadProtocolState,
    pub(super) cursor: u64,
    pub(super) events: VecDeque<StreamEnvelope>,
    pub(super) identity_binding_failures: VecDeque<IdentityBindingFailure>,
    pub(super) response_idempotency_keys: HashSet<String>,
    pub(super) response_idempotency_digests: HashMap<String, String>,
    pub(super) response_request_owners: HashMap<String, String>,
    pub(super) pending_response_idempotency: HashMap<String, ToAgentMessage>,
    pub(super) response_idempotency_order: VecDeque<String>,
    pub(super) pending_response_idempotency_order: VecDeque<String>,
}

pub(super) struct ResponseIdempotencyView<'a> {
    pub(super) keys: &'a HashSet<String>,
    pub(super) digests: &'a HashMap<String, String>,
    pub(super) request_owners: &'a HashMap<String, String>,
    pub(super) pending: &'a HashMap<String, ToAgentMessage>,
    pub(super) order: &'a VecDeque<String>,
    pub(super) pending_order: &'a VecDeque<String>,
}

impl ThreadJournal {
    pub(super) fn load(
        workspace_root: &Path,
        thread_id: &str,
        runtime_generation: u64,
    ) -> io::Result<LoadedThreadJournal> {
        let path = journal_path(workspace_root, thread_id);
        let journal = Self {
            _lock: acquire_journal_lock(&path)?,
            path,
        };
        let Some(document) = read_document(&journal.path)? else {
            return Ok(LoadedThreadJournal {
                journal,
                state: ThreadProtocolState::new(thread_id.to_string().into()),
                cursor: 0,
                events: VecDeque::new(),
                identity_binding_failures: VecDeque::new(),
                response_idempotency_keys: HashSet::new(),
                response_idempotency_digests: HashMap::new(),
                response_request_owners: HashMap::new(),
                pending_response_idempotency: HashMap::new(),
                response_idempotency_order: VecDeque::new(),
                pending_response_idempotency_order: VecDeque::new(),
            });
        };
        if document.protocol_version != THREAD_PROTOCOL_VERSION || document.thread_id != thread_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable thread journal identity does not match this runtime",
            ));
        }
        if document.runtime_generation > runtime_generation {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "durable thread journal is owned by a newer runtime generation",
            ));
        }
        let mut response_request_owners = document.response_request_owners;
        for (key, message) in &document.pending_response_idempotency {
            if let Some(request_id) = response_ack_request_id(message) {
                response_request_owners
                    .entry(request_id.to_string())
                    .or_insert_with(|| key.clone());
            }
        }
        Ok(LoadedThreadJournal {
            journal,
            state: ThreadProtocolState::restore(thread_id.to_string().into(), document.turns),
            cursor: document.cursor,
            events: document.events.into(),
            identity_binding_failures: document.identity_binding_failures.into(),
            response_idempotency_keys: document.response_idempotency_keys.into_iter().collect(),
            response_idempotency_digests: document.response_idempotency_digests,
            response_request_owners,
            pending_response_idempotency: document.pending_response_idempotency,
            response_idempotency_order: document.response_idempotency_order.into(),
            pending_response_idempotency_order: document.pending_response_idempotency_order.into(),
        })
    }

    pub(super) fn persist(
        &self,
        state: &ThreadProtocolState,
        runtime_generation: u64,
        cursor: u64,
        events: &VecDeque<StreamEnvelope>,
        response_idempotency: ResponseIdempotencyView<'_>,
        identity_binding_failures: &VecDeque<IdentityBindingFailure>,
    ) -> io::Result<()> {
        let mut response_idempotency_keys = response_idempotency
            .keys
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        response_idempotency_keys.sort();
        let document = DurableThreadDocument {
            protocol_version: THREAD_PROTOCOL_VERSION.to_string(),
            thread_id: state.thread_id.as_str().to_string(),
            runtime_generation,
            cursor,
            turns: state.turns.clone(),
            events: events.iter().cloned().collect(),
            identity_binding_failures: identity_binding_failures.iter().cloned().collect(),
            response_idempotency_keys,
            response_idempotency_digests: response_idempotency.digests.clone(),
            response_request_owners: response_idempotency.request_owners.clone(),
            pending_response_idempotency: response_idempotency.pending.clone(),
            response_idempotency_order: response_idempotency.order.iter().cloned().collect(),
            pending_response_idempotency_order: response_idempotency
                .pending_order
                .iter()
                .cloned()
                .collect(),
        };
        atomic_write_private_json(&self.path, &document)
    }
}

fn journal_path(workspace_root: &Path, thread_id: &str) -> PathBuf {
    workspace_root
        .join(".maestro")
        .join("hosted-runner")
        .join("threads")
        .join(format!("{}.json", path_safe_thread_id(thread_id)))
}

fn acquire_journal_lock(path: &Path) -> io::Result<ThreadJournalLock> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable thread journal has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let mut lock_name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    lock_name.push(".lock");
    let lock_path = path.with_file_name(lock_name);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)?;
    let (acquired_tx, acquired_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("maestro-thread-journal-lock".to_string())
        .spawn(move || {
            let mut lock = FileLock::new(file);
            match lock.try_write() {
                Ok(_guard) => {
                    let _ = acquired_tx.send(Ok(()));
                    let _ = release_rx.recv();
                }
                Err(error) => {
                    let _ = acquired_tx.send(Err(error));
                }
            };
        })?;
    match acquired_rx.recv() {
        Ok(Ok(())) => Ok(ThreadJournalLock {
            release: Some(release_tx),
            worker: Some(worker),
        }),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(error)
        }
        Err(error) => {
            let _ = worker.join();
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("durable thread journal lock worker exited: {error}"),
            ))
        }
    }
}

fn path_safe_thread_id(thread_id: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;
    let hash = thread_id
        .as_bytes()
        .iter()
        .fold(FNV_OFFSET_BASIS, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
        });
    let prefix = thread_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(48)
        .collect::<String>();
    let prefix = if prefix.is_empty() { "thread" } else { &prefix };
    format!("{prefix}-{hash:016x}")
}

fn read_document(path: &Path) -> io::Result<Option<DurableThreadDocument>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid durable thread journal: {error}"),
            )
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn atomic_write_private_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable thread journal has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".thread-{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let write_result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Ok(parent) = OpenOptions::new().read(true).open(parent) {
            let _ = parent.sync_all();
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_ai::ProviderStreamErrorKind;

    fn test_governed_grant() -> GovernedToolGrant {
        GovernedToolGrant {
            envelope_version: 2,
            grant_id: "grant-1".to_string(),
            grant_version: 1,
            issuer: "evalops.platform".to_string(),
            audience: "evalops.maestro".to_string(),
            organization_id: "org-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            run_id: "run-1".to_string(),
            runtime_generation: 1,
            grant_epoch: 1,
            issued_at_ms: 1,
            not_before_ms: 1,
            expires_at_ms: i64::MAX,
            grant_hash: "sha256:grant-1".to_string(),
            signing_key_id: "key-1".to_string(),
            grant_signature: "hmac-sha256:signature".to_string(),
            native_tool_ids: vec!["read".to_string()],
            external_tools: Vec::new(),
        }
    }

    fn governed_request() -> AppendTurnRequest {
        AppendTurnRequest {
            protocol_version: GOVERNED_THREAD_PROTOCOL_VERSION.to_string(),
            turn_id: "turn-1".to_string(),
            kind: ThreadTurnKind::UserMessage,
            content: "hello".to_string(),
            attachments: None,
            code_mode: Some(CodeMode::GovernedCode),
            tool_grant: Some(test_governed_grant()),
        }
    }

    #[test]
    fn thread_v2_requires_a_grant_and_v1_remains_backward_compatible() {
        governed_request().validate().expect("complete v2 request");

        let mut missing = governed_request();
        missing.tool_grant = None;
        assert!(missing.validate().is_err());

        let mut missing = governed_request();
        missing.code_mode = None;
        assert!(missing.validate().is_err());

        let mut unknown = governed_request();
        unknown.protocol_version = "evalops.maestro.thread.v3".to_string();
        assert!(unknown.validate().is_err());

        let legacy = AppendTurnRequest {
            protocol_version: THREAD_PROTOCOL_VERSION.to_string(),
            turn_id: "turn-legacy".to_string(),
            kind: ThreadTurnKind::UserMessage,
            content: "hello".to_string(),
            attachments: None,
            code_mode: None,
            tool_grant: None,
        };
        legacy.validate().expect("legacy v1 remains valid");
    }

    #[test]
    fn governed_grant_identity_is_persisted_and_part_of_duplicate_turn_equality() {
        let request = governed_request();
        let mut state = ThreadProtocolState::new("thread-1".to_string().into());
        state.append(request.clone(), 1);
        let record = state.turn("turn-1").unwrap();
        assert!(record.matches(&request));

        let serialized = serde_json::to_vec(record).unwrap();
        let restored: ThreadTurnRecord = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(
            restored
                .tool_grant
                .as_ref()
                .map(GovernedToolGrant::identity),
            request.tool_grant.as_ref().map(GovernedToolGrant::identity)
        );

        let mut changed_grant = governed_request();
        let grant = changed_grant.tool_grant.as_mut().unwrap();
        grant.grant_id = "grant-2".to_string();
        grant.grant_hash = "sha256:grant-2".to_string();
        assert!(
            !record.matches(&changed_grant),
            "same turn id with different authority must conflict, not replay"
        );
    }

    #[test]
    fn failed_initial_persistence_can_roll_back_an_undispatched_append() {
        let request = governed_request();
        let mut state = ThreadProtocolState::new("thread-1".to_string().into());
        state.append(request, 1);

        state.rollback_unpersisted_append("turn-1");

        assert!(state.turn("turn-1").is_none());
        assert!(!state.has_active_turn());
        assert_eq!(state.phase(), ThreadPhase::Idle);
    }

    #[test]
    fn accepted_turn_is_terminally_interrupted_after_a_dispatch_persistence_crash() {
        let request = governed_request();
        let mut before_crash = ThreadProtocolState::new("thread-1".to_string().into());
        before_crash.append(request, 1);
        assert_eq!(before_crash.phase(), ThreadPhase::Accepted);

        // The accepted snapshot is the last durable state if dispatch
        // succeeded but persisting Running failed before process death.
        let restored =
            ThreadProtocolState::restore(before_crash.thread_id.clone(), before_crash.turns);

        assert_eq!(restored.phase(), ThreadPhase::Interrupted);
        assert!(!restored.has_active_turn());
    }

    fn active_state() -> ThreadProtocolState {
        let mut state = ThreadProtocolState::new("thread-positive-terminal".to_string().into());
        state.append(
            AppendTurnRequest {
                protocol_version: THREAD_PROTOCOL_VERSION.to_string(),
                turn_id: "turn-1".to_string(),
                kind: ThreadTurnKind::UserMessage,
                content: "hello".to_string(),
                attachments: None,
                code_mode: None,
                tool_grant: None,
            },
            1,
        );
        state.mark_dispatched(2);
        state
    }

    #[test]
    fn response_end_does_not_complete_hosted_turn_but_turn_completed_does() {
        let mut state = active_state();

        state.apply_agent_message(
            &FromAgentMessage::ResponseEnd {
                response_id: "model-call".to_string(),
                usage: None,
                tools_summary: None,
                duration_ms: None,
                ttft_ms: None,
            },
            3,
        );
        assert_eq!(state.phase(), ThreadPhase::Running);

        state.apply_agent_message(
            &FromAgentMessage::TurnCompleted {
                response_id: "turn-1".to_string(),
            },
            4,
        );
        assert_eq!(state.phase(), ThreadPhase::Completed);
    }

    #[test]
    fn provider_terminal_error_cannot_be_followed_by_turn_completion() {
        let mut state = active_state();

        state.apply_agent_message(
            &FromAgentMessage::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message: "missing terminal event".to_string(),
            },
            3,
        );
        assert_eq!(state.phase(), ThreadPhase::Failed);

        state.apply_agent_message(
            &FromAgentMessage::TurnCompleted {
                response_id: "turn-1".to_string(),
            },
            4,
        );
        assert_eq!(state.phase(), ThreadPhase::Failed);
    }

    #[test]
    fn interrupted_terminal_survives_restore_without_becoming_completed() {
        let mut state = active_state();
        state.apply_agent_message(
            &FromAgentMessage::TurnInterrupted {
                response_id: "turn-1".to_string(),
                reason: "cancelled".to_string(),
            },
            3,
        );
        assert_eq!(state.phase(), ThreadPhase::Interrupted);

        let restored = ThreadProtocolState::restore(state.thread_id.clone(), state.turns.clone());
        assert_eq!(restored.phase(), ThreadPhase::Interrupted);
        assert_eq!(restored.turn("turn-1").unwrap().cursor, 3);
    }

    fn persist_and_reload_terminal(
        workspace_root: &Path,
        thread_id: &str,
        message: FromAgentMessage,
    ) -> LoadedThreadJournal {
        let mut loaded = ThreadJournal::load(workspace_root, thread_id, 1).unwrap();
        loaded.state.append(
            AppendTurnRequest {
                protocol_version: THREAD_PROTOCOL_VERSION.to_string(),
                turn_id: "turn-1".to_string(),
                kind: ThreadTurnKind::UserMessage,
                content: "hello".to_string(),
                attachments: None,
                code_mode: None,
                tool_grant: None,
            },
            1,
        );
        loaded.state.mark_dispatched(2);
        loaded.state.apply_agent_message(&message, 3);
        loaded.cursor = 3;
        loaded.events.push_back(StreamEnvelope::Message {
            cursor: 3,
            message: Box::new(message),
        });
        loaded
            .journal
            .persist(
                &loaded.state,
                1,
                loaded.cursor,
                &loaded.events,
                ResponseIdempotencyView {
                    keys: &loaded.response_idempotency_keys,
                    digests: &loaded.response_idempotency_digests,
                    request_owners: &loaded.response_request_owners,
                    pending: &loaded.pending_response_idempotency,
                    order: &loaded.response_idempotency_order,
                    pending_order: &loaded.pending_response_idempotency_order,
                },
                &loaded.identity_binding_failures,
            )
            .unwrap();
        drop(loaded);
        ThreadJournal::load(workspace_root, thread_id, 2).unwrap()
    }

    #[test]
    fn durable_journal_reloads_positive_and_provider_error_terminals() {
        let workspace = tempfile::tempdir().unwrap();

        let completed = persist_and_reload_terminal(
            workspace.path(),
            "completed-thread",
            FromAgentMessage::TurnCompleted {
                response_id: "turn-1".to_string(),
            },
        );
        assert_eq!(completed.state.phase(), ThreadPhase::Completed);
        assert!(matches!(
            completed.events.back(),
            Some(StreamEnvelope::Message { message, .. })
                if matches!(message.as_ref(), FromAgentMessage::TurnCompleted { .. })
        ));
        drop(completed);

        let failed = persist_and_reload_terminal(
            workspace.path(),
            "failed-thread",
            FromAgentMessage::ProviderError {
                kind: ProviderStreamErrorKind::TransientProtocol,
                message: "missing terminal event".to_string(),
            },
        );
        assert_eq!(failed.state.phase(), ThreadPhase::Failed);
        assert!(matches!(
            failed.events.back(),
            Some(StreamEnvelope::Message { message, .. })
                if matches!(message.as_ref(), FromAgentMessage::ProviderError { .. })
        ));
    }
}

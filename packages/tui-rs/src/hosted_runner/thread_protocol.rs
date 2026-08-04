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

use super::{
    response_ack_request_id, FromAgentMessage, ServerRequestType, StreamEnvelope, ToAgentMessage,
};

pub(super) const THREAD_PROTOCOL_VERSION: &str = "evalops.maestro.thread.v1";
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
}

impl AppendTurnRequest {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version != THREAD_PROTOCOL_VERSION {
            return Err("unsupported thread protocol version");
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
    pub(super) phase: ThreadPhase,
    pub(super) accepted_at: String,
    pub(super) cursor: u64,
}

impl ThreadTurnRecord {
    pub(super) fn matches(&self, request: &AppendTurnRequest) -> bool {
        self.kind == request.kind
            && self.content == request.content
            && self.attachments == request.attachments
    }
}

#[derive(Debug, Clone)]
pub(super) struct ThreadProtocolState {
    thread_id: String,
    turns: Vec<ThreadTurnRecord>,
    active_turn_ids: VecDeque<String>,
}

impl ThreadProtocolState {
    pub(super) fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            turns: Vec::new(),
            active_turn_ids: VecDeque::new(),
        }
    }

    fn restore(thread_id: String, mut turns: Vec<ThreadTurnRecord>) -> Self {
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

    pub(super) fn append(&mut self, request: AppendTurnRequest, cursor: u64) {
        let turn_id = request.turn_id;
        let run_id = if request.kind == ThreadTurnKind::Steer {
            self.active_turn_ids
                .front()
                .and_then(|active_turn_id| self.turn(active_turn_id))
                .map(|turn| turn.run_id.clone())
                .unwrap_or_else(|| format!("run_{turn_id}"))
        } else {
            format!("run_{turn_id}")
        };
        self.active_turn_ids.push_back(turn_id.clone());
        self.turns.push(ThreadTurnRecord {
            run_id,
            turn_id,
            kind: request.kind,
            content: request.content,
            attachments: request.attachments,
            phase: ThreadPhase::Accepted,
            accepted_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            cursor,
        });
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
            FromAgentMessage::ResponseEnd { .. } => {
                self.mark_active_run_terminal(ThreadPhase::Completed, cursor);
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
                fatal, error_type, ..
            } => {
                let phase = if *fatal
                    || matches!(
                        error_type,
                        Some(crate::headless::messages::HeadlessErrorType::Cancelled)
                    ) {
                    ThreadPhase::Interrupted
                } else {
                    ThreadPhase::Failed
                };
                self.mark_active_run_terminal(phase, cursor);
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

    fn mark_active_run_terminal(&mut self, phase: ThreadPhase, cursor: u64) {
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
            terminal_turn_ids.insert(turn.turn_id.clone());
        }
        self.active_turn_ids
            .retain(|turn_id| !terminal_turn_ids.contains(turn_id));
    }
}

#[derive(Serialize)]
pub(super) struct ThreadStateView<'a> {
    pub(super) protocol_version: &'static str,
    pub(super) thread_id: &'a str,
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
                state: ThreadProtocolState::new(thread_id.to_string()),
                cursor: 0,
                events: VecDeque::new(),
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
            state: ThreadProtocolState::restore(thread_id.to_string(), document.turns),
            cursor: document.cursor,
            events: document.events.into(),
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
    ) -> io::Result<()> {
        let mut response_idempotency_keys = response_idempotency
            .keys
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        response_idempotency_keys.sort();
        let document = DurableThreadDocument {
            protocol_version: THREAD_PROTOCOL_VERSION.to_string(),
            thread_id: state.thread_id.clone(),
            runtime_generation,
            cursor,
            turns: state.turns.clone(),
            events: events.iter().cloned().collect(),
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

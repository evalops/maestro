//! Stdio JSON-RPC client for Codex app-server.
//!
//! Mirrors `src/codex/app-server-client.ts` for the subset used by
//! `maestro codex` (login / logout / status / doctor).

use std::collections::{HashMap, VecDeque};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::time::timeout;

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_LOGIN_TIMEOUT_MS: u64 = 5 * 60_000;
/// Turns can run for several minutes when tools are involved.
const DEFAULT_TURN_TIMEOUT_MS: u64 = 10 * 60_000;
const MAX_NOTIFICATION_HISTORY: usize = 100;
const DEFAULT_CODEX_COMMAND: &str = "codex";
const DEFAULT_CODEX_APP_SERVER_ARGS: &[&str] = &["app-server", "--listen", "stdio://"];

/// How the app-server process was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnSource {
    Override,
    BundledPackage,
    Path,
}

/// Resolved spawn command for Codex app-server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnCommand {
    pub command: String,
    pub args: Vec<String>,
    pub source: SpawnSource,
}

#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub name: String,
    pub title: Option<String>,
    pub version: Option<String>,
}

impl Default for ClientInfo {
    fn default() -> Self {
        Self {
            name: "maestro".to_owned(),
            title: Some("Maestro".to_owned()),
            version: Some(package_version()),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct InitializeOptions {
    pub client_info: Option<ClientInfo>,
    pub experimental_api: bool,
    pub opt_out_notification_methods: Vec<String>,
    pub timeout_ms: Option<u64>,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value>>>;

/// Inbound JSON-RPC request from Codex app-server that Maestro must answer
/// (dynamic tools, approvals). When external handling is enabled, these are
/// queued for [`CodexAppServerClient::wait_for_server_request`] instead of
/// auto-declining.
pub struct IncomingServerRequest {
    pub id: Value,
    pub method: String,
    pub params: Option<Value>,
    reply: oneshot::Sender<Result<Value, String>>,
}

impl IncomingServerRequest {
    pub fn respond(self, result: Value) {
        let _ = self.reply.send(Ok(result));
    }

    pub fn reject(self, message: impl Into<String>) {
        let _ = self.reply.send(Err(message.into()));
    }
}

/// Typed wait outcome for [`CodexAppServerClient::wait_for_server_request`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerRequestWaitError {
    Timeout,
    Closed,
}

impl std::fmt::Display for ServerRequestWaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => write!(f, "Timed out waiting for Codex app-server server-request"),
            Self::Closed => write!(f, "Codex app-server client is closed"),
        }
    }
}

impl std::error::Error for ServerRequestWaitError {}

#[derive(Debug, Clone)]
pub struct AccountReadResult {
    pub account: Option<Value>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone)]
pub struct LoginCompleted {
    pub login_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

/// Parameters for Codex app-server `thread/start`.
#[derive(Debug, Clone)]
pub struct ThreadStartParams {
    pub model: String,
    pub cwd: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    /// Extra JSON fields merged into the request params.
    pub extra: Option<Value>,
}

impl ThreadStartParams {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            cwd: None,
            approval_policy: None,
            sandbox: None,
            extra: None,
        }
    }
}

/// Result of `thread/start`.
#[derive(Debug, Clone)]
pub struct ThreadStartResult {
    pub thread_id: String,
    pub raw: Value,
}

/// Parameters for Codex app-server `thread/inject_items`.
///
/// This protocol-defined operation appends raw Responses API items to the
/// model-visible history of an existing thread before its next turn.
#[derive(Debug, Clone)]
pub struct ThreadInjectItemsParams {
    pub thread_id: String,
    pub items: Value,
}

/// Parameters for Codex app-server `turn/start`.
#[derive(Debug, Clone)]
pub struct TurnStartParams {
    pub thread_id: String,
    /// Turn input items (typically `[{ "type": "text", "text": "..." }]`).
    pub input: Value,
    pub extra: Option<Value>,
}

impl TurnStartParams {
    pub fn text(thread_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            input: json!([{ "type": "text", "text": text.into() }]),
            extra: None,
        }
    }
}

/// Result of `turn/start`.
#[derive(Debug, Clone)]
pub struct TurnStartResult {
    pub turn_id: String,
    pub raw: Value,
}

/// Parameters for Codex app-server `thread/list` (subset of v2).
#[derive(Debug, Clone, Default)]
pub struct ThreadListParams {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    /// Exact cwd match filter when set.
    pub cwd: Option<String>,
    pub archived: Option<bool>,
    pub search_term: Option<String>,
}

/// Result of `thread/list`.
#[derive(Debug, Clone)]
pub struct ThreadListResult {
    pub threads: Vec<Value>,
    pub next_cursor: Option<String>,
    pub raw: Value,
}

/// Parameters for Codex app-server `thread/resume`.
#[derive(Debug, Clone)]
pub struct ThreadResumeParams {
    pub thread_id: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub path: Option<String>,
    pub extra: Option<Value>,
}

impl ThreadResumeParams {
    pub fn new(thread_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            model: None,
            cwd: None,
            path: None,
            extra: None,
        }
    }
}

/// Result of `thread/resume` (thread id + raw payload).
#[derive(Debug, Clone)]
pub struct ThreadResumeResult {
    pub thread_id: String,
    pub raw: Value,
}

/// Parameters for Codex app-server `turn/interrupt`.
#[derive(Debug, Clone)]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

/// Parameters for Codex app-server `turn/steer`.
#[derive(Debug, Clone)]
pub struct TurnSteerParams {
    pub thread_id: String,
    pub expected_turn_id: String,
    /// Steer input items (same shape as turn/start input).
    pub input: Value,
}

impl TurnSteerParams {
    pub fn text(
        thread_id: impl Into<String>,
        expected_turn_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            expected_turn_id: expected_turn_id.into(),
            input: json!([{ "type": "text", "text": text.into() }]),
        }
    }
}

/// Result of `turn/steer`.
#[derive(Debug, Clone)]
pub struct TurnSteerResult {
    pub turn_id: String,
    pub raw: Value,
}

/// Terminal turn notification payload.
#[derive(Debug, Clone)]
pub struct TurnCompleted {
    pub turn_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Option<Value>,
}

/// Outbound line sink + kill handle used by the RPC client.
struct TransportIo {
    write_tx: mpsc::UnboundedSender<String>,
    kill: Box<dyn Fn() + Send + Sync>,
    command_label: Option<String>,
}

/// Incoming line + lifecycle events for the RPC client.
struct TransportEvents {
    line_rx: mpsc::UnboundedReceiver<IoEvent>,
}

enum IoEvent {
    Line(String),
    Stderr(String),
    Exited {
        code: Option<i32>,
        signal: Option<String>,
    },
    SpawnError(String),
    Closed,
}

/// Stdio JSON-RPC client for Codex app-server.
pub struct CodexAppServerClient {
    write_tx: mpsc::UnboundedSender<String>,
    kill: Box<dyn Fn() + Send + Sync>,
    #[allow(dead_code)]
    command_label: Option<String>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    pending: Arc<Mutex<PendingMap>>,
    notifications: Arc<Mutex<VecDeque<Notification>>>,
    notify: Arc<Notify>,
    /// When true, tool/approval server requests are queued for the native
    /// agent instead of auto-declined.
    external_server_requests: Arc<AtomicBool>,
    server_requests: Arc<Mutex<VecDeque<IncomingServerRequest>>>,
    #[allow(dead_code)]
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    writer_task: Option<tokio::task::JoinHandle<()>>,
    /// Optional process child kept alive until close.
    _child_holder: Option<Arc<Mutex<Option<Child>>>>,
}

impl CodexAppServerClient {
    /// Spawn Codex app-server on stdio.
    pub async fn spawn(
        command: Option<String>,
        args: Option<Vec<String>>,
        request_timeout_ms: Option<u64>,
    ) -> Result<Self> {
        Self::spawn_with_env(command, args, request_timeout_ms, &HashMap::new()).await
    }

    /// Spawn Codex app-server with explicit child-only environment overrides.
    pub async fn spawn_with_env(
        command: Option<String>,
        args: Option<Vec<String>>,
        request_timeout_ms: Option<u64>,
        child_env: &HashMap<String, String>,
    ) -> Result<Self> {
        let _ = request_timeout_ms;
        let spawn = resolve_spawn_command(command.as_deref(), args.as_deref());
        let label = match spawn.source {
            SpawnSource::BundledPackage => "@openai/codex".to_owned(),
            _ => {
                let mut parts = vec![spawn.command.clone()];
                parts.extend(spawn.args.iter().cloned());
                parts.join(" ")
            }
        };

        let mut child = Command::new(&spawn.command)
            .args(&spawn.args)
            .envs(child_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format_spawn_error(&error, Some(&label)))?;

        let stdin = child
            .stdin
            .take()
            .context("Codex app-server missing stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("Codex app-server missing stdout")?;
        let stderr = child.stderr.take();

        let (write_tx, write_rx) = mpsc::unbounded_channel::<String>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<IoEvent>();

        let writer_task = tokio::spawn(async move {
            let mut stdin = stdin;
            let mut write_rx = write_rx;
            while let Some(line) = write_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });

        let event_tx_stdout = event_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if event_tx_stdout.send(IoEvent::Line(line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = event_tx_stdout.send(IoEvent::Closed);
                        break;
                    }
                    Err(_) => {
                        let _ = event_tx_stdout.send(IoEvent::Closed);
                        break;
                    }
                }
            }
        });

        if let Some(stderr) = stderr {
            let event_tx_stderr = event_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty()
                        && event_tx_stderr
                            .send(IoEvent::Stderr(trimmed.to_owned()))
                            .is_err()
                    {
                        break;
                    }
                }
            });
        }

        let child_holder = Arc::new(Mutex::new(Some(child)));
        let child_for_wait = Arc::clone(&child_holder);
        let event_tx_exit = event_tx;
        tokio::spawn(async move {
            let mut guard = child_for_wait.lock().await;
            if let Some(mut child) = guard.take() {
                match child.wait().await {
                    Ok(status) => {
                        let code = status.code();
                        #[cfg(unix)]
                        let signal = {
                            use std::os::unix::process::ExitStatusExt;
                            status.signal().map(|s| s.to_string())
                        };
                        #[cfg(not(unix))]
                        let signal = None;
                        let _ = event_tx_exit.send(IoEvent::Exited { code, signal });
                    }
                    Err(error) => {
                        let _ = event_tx_exit.send(IoEvent::SpawnError(error.to_string()));
                    }
                }
            }
        });

        let child_for_kill = Arc::clone(&child_holder);
        let kill = Box::new(move || {
            if let Ok(mut guard) = child_for_kill.try_lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.start_kill();
                }
            }
        });

        Ok(Self::from_transport(
            TransportIo {
                write_tx,
                kill,
                command_label: Some(label),
            },
            TransportEvents { line_rx: event_rx },
            Some(writer_task),
            Some(child_holder),
        ))
    }

    /// Build a client over an in-memory mock transport (tests).
    pub fn mock() -> (Self, MockCodexTransport) {
        let (write_tx, write_rx) = mpsc::unbounded_channel::<String>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<IoEvent>();
        let killed = Arc::new(AtomicBool::new(false));
        let killed_flag = Arc::clone(&killed);
        let kill = Box::new(move || {
            killed_flag.store(true, Ordering::SeqCst);
        });

        let client = Self::from_transport(
            TransportIo {
                write_tx,
                kill,
                command_label: Some("mock-codex".to_owned()),
            },
            TransportEvents { line_rx: event_rx },
            None,
            None,
        );

        let mock = MockCodexTransport {
            write_rx: Arc::new(Mutex::new(write_rx)),
            event_tx,
            killed,
            requests: Arc::new(Mutex::new(VecDeque::new())),
        };
        (client, mock)
    }

    fn from_transport(
        io: TransportIo,
        events: TransportEvents,
        writer_task: Option<tokio::task::JoinHandle<()>>,
        child_holder: Option<Arc<Mutex<Option<Child>>>>,
    ) -> Self {
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let notifications: Arc<Mutex<VecDeque<Notification>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        let notify = Arc::new(Notify::new());
        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let external_server_requests = Arc::new(AtomicBool::new(false));
        let server_requests: Arc<Mutex<VecDeque<IncomingServerRequest>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        let pending_r = Arc::clone(&pending);
        let notifications_r = Arc::clone(&notifications);
        let notify_r = Arc::clone(&notify);
        let stderr_r = Arc::clone(&stderr_tail);
        let closed_r = Arc::clone(&closed);
        let write_tx_r = io.write_tx.clone();
        let external_r = Arc::clone(&external_server_requests);
        let server_requests_r = Arc::clone(&server_requests);
        let command_label = io.command_label.clone();

        let reader_task = tokio::spawn(async move {
            let mut line_rx = events.line_rx;
            while let Some(event) = line_rx.recv().await {
                match event {
                    IoEvent::Line(line) => {
                        handle_line(
                            &line,
                            &pending_r,
                            &notifications_r,
                            &notify_r,
                            &write_tx_r,
                            &external_r,
                            &server_requests_r,
                        )
                        .await;
                    }
                    IoEvent::Stderr(line) => {
                        let mut tail = stderr_r.lock().await;
                        tail.push_back(line);
                        while tail.len() > 20 {
                            tail.pop_front();
                        }
                    }
                    IoEvent::Exited { code, signal } => {
                        let suffix = match (code, signal) {
                            (Some(code), _) => format!("code {code}"),
                            (None, Some(signal)) => format!("signal {signal}"),
                            (None, None) => "unknown status".to_owned(),
                        };
                        reject_all(
                            &pending_r,
                            &closed_r,
                            &stderr_r,
                            &format!("Codex app-server exited with {suffix}"),
                        )
                        .await;
                        notify_r.notify_waiters();
                        break;
                    }
                    IoEvent::SpawnError(message) => {
                        reject_all(&pending_r, &closed_r, &stderr_r, &message).await;
                        notify_r.notify_waiters();
                        break;
                    }
                    IoEvent::Closed => {
                        reject_all(
                            &pending_r,
                            &closed_r,
                            &stderr_r,
                            "Codex app-server closed stdout",
                        )
                        .await;
                        notify_r.notify_waiters();
                        break;
                    }
                }
            }
        });

        Self {
            write_tx: io.write_tx,
            kill: io.kill,
            command_label,
            next_id: AtomicU64::new(1),
            closed,
            pending,
            notifications,
            notify,
            external_server_requests,
            server_requests,
            stderr_tail,
            reader_task: Some(reader_task),
            writer_task,
            _child_holder: child_holder,
        }
    }

    /// Enable queueing of tool/approval server-requests for external handling.
    pub fn set_external_server_requests(&self, enabled: bool) {
        self.external_server_requests
            .store(enabled, Ordering::SeqCst);
    }

    /// Wait for the next inbound server-request (dynamic tool call / approval).
    pub async fn wait_for_server_request(
        &self,
        timeout_ms: Option<u64>,
    ) -> std::result::Result<IncomingServerRequest, ServerRequestWaitError> {
        let wait_ms = timeout_ms.unwrap_or(DEFAULT_TURN_TIMEOUT_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        loop {
            {
                let mut queue = self.server_requests.lock().await;
                if let Some(request) = queue.pop_front() {
                    return Ok(request);
                }
            }
            if self.closed.load(Ordering::SeqCst) {
                return Err(ServerRequestWaitError::Closed);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ServerRequestWaitError::Timeout);
            }
            let _ = timeout(remaining, self.notify.notified()).await;
        }
    }

    pub async fn initialize(&self, options: InitializeOptions) -> Result<Value> {
        let client_info = options.client_info.unwrap_or_default();
        let mut client_info_json = json!({
            "name": client_info.name,
        });
        if let Some(title) = client_info.title {
            client_info_json["title"] = json!(title);
        }
        if let Some(version) = client_info.version {
            client_info_json["version"] = json!(version);
        }

        let mut params = json!({ "clientInfo": client_info_json });
        if options.experimental_api || !options.opt_out_notification_methods.is_empty() {
            let mut capabilities = Map::new();
            if options.experimental_api {
                capabilities.insert("experimentalApi".to_owned(), json!(true));
            }
            if !options.opt_out_notification_methods.is_empty() {
                capabilities.insert(
                    "optOutNotificationMethods".to_owned(),
                    json!(options.opt_out_notification_methods),
                );
            }
            params["capabilities"] = Value::Object(capabilities);
        }

        let result = self
            .request("initialize", Some(params), options.timeout_ms)
            .await?;
        self.notify("initialized", None)?;
        Ok(result)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("Codex app-server client is closed");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        let mut message = json!({ "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)?;

        let wait_ms = timeout_ms.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        match timeout(Duration::from_millis(wait_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => bail!("Codex app-server request cancelled: {method}"),
            Err(_) => {
                let mut pending = self.pending.lock().await;
                pending.remove(&id);
                bail!("Codex app-server request timed out: {method}");
            }
        }
    }

    pub fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)
    }

    pub async fn read_account(&self, refresh_token: bool) -> Result<AccountReadResult> {
        let result = self
            .request(
                "account/read",
                Some(json!({ "refreshToken": refresh_token })),
                None,
            )
            .await?;
        Ok(AccountReadResult {
            account: result.get("account").cloned().filter(|v| !v.is_null()),
            requires_openai_auth: result
                .get("requiresOpenaiAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    pub async fn start_chatgpt_login(
        &self,
        flow: LoginFlow,
        codex_streamlined_login: bool,
    ) -> Result<Value> {
        let params = match flow {
            LoginFlow::Device => json!({ "type": "chatgptDeviceCode" }),
            LoginFlow::Browser => {
                let mut params = json!({ "type": "chatgpt" });
                if codex_streamlined_login {
                    params["codexStreamlinedLogin"] = json!(true);
                }
                params
            }
        };
        self.request("account/login/start", Some(params), None)
            .await
    }

    pub async fn wait_for_login_completion(
        &self,
        login_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<LoginCompleted> {
        let wait_ms = timeout_ms.unwrap_or(DEFAULT_LOGIN_TIMEOUT_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);

        loop {
            {
                let mut history = self.notifications.lock().await;
                if let Some(index) = history.iter().position(|notification| {
                    notification.method == "account/login/completed"
                        && notification
                            .params
                            .as_ref()
                            .and_then(|params| params.get("loginId"))
                            .and_then(Value::as_str)
                            == Some(login_id)
                }) {
                    let notification = history.remove(index).expect("index valid");
                    let params = notification.params.unwrap_or(Value::Null);
                    let success = params
                        .get("success")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let error = params.get("error").and_then(|value| {
                        if value.is_null() {
                            None
                        } else {
                            value.as_str().map(str::to_owned)
                        }
                    });
                    let completed = LoginCompleted {
                        login_id: params
                            .get("loginId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        success,
                        error: error.clone(),
                    };
                    if !success {
                        bail!(
                            error.unwrap_or_else(|| "ChatGPT sign-in did not complete".to_owned())
                        );
                    }
                    return Ok(completed);
                }
            }

            if self.closed.load(Ordering::SeqCst) {
                bail!("Codex app-server client is closed");
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("Timed out waiting for Codex app-server notification");
            }
            let _ = timeout(remaining, self.notify.notified()).await;
        }
    }

    pub async fn logout(&self) -> Result<()> {
        self.request("account/logout", None, None).await?;
        Ok(())
    }

    /// Start a Codex conversation thread (`thread/start`).
    ///
    /// Used by the openai-codex native-agent path so ChatGPT OAuth refresh and
    /// model routing stay inside Codex app-server rather than Maestro's
    /// Platform HTTP client (`UnifiedClient`).
    pub async fn start_thread(
        &self,
        params: ThreadStartParams,
        timeout_ms: Option<u64>,
    ) -> Result<ThreadStartResult> {
        let mut body = Map::new();
        body.insert("model".to_owned(), json!(params.model));
        if let Some(cwd) = params.cwd {
            body.insert("cwd".to_owned(), json!(cwd));
        }
        if let Some(approval_policy) = params.approval_policy {
            body.insert("approvalPolicy".to_owned(), json!(approval_policy));
        }
        if let Some(sandbox) = params.sandbox {
            body.insert("sandbox".to_owned(), json!(sandbox));
        }
        if let Some(Value::Object(map)) = params.extra {
            for (key, value) in map {
                body.entry(key).or_insert(value);
            }
        }

        let result = self
            .request("thread/start", Some(Value::Object(body)), timeout_ms)
            .await?;
        let thread_id = extract_nested_id(&result, "thread")
            .ok_or_else(|| anyhow!("thread/start response missing thread id: {result}"))?;
        Ok(ThreadStartResult {
            thread_id,
            raw: result,
        })
    }

    /// Append Responses API items to an existing thread (`thread/inject_items`).
    pub async fn inject_thread_items(
        &self,
        params: ThreadInjectItemsParams,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        self.request(
            "thread/inject_items",
            Some(json!({
                "threadId": params.thread_id,
                "items": params.items,
            })),
            timeout_ms,
        )
        .await
    }

    /// Start a turn on an existing thread (`turn/start`).
    pub async fn start_turn(
        &self,
        params: TurnStartParams,
        timeout_ms: Option<u64>,
    ) -> Result<TurnStartResult> {
        let mut body = Map::new();
        body.insert("threadId".to_owned(), json!(params.thread_id));
        body.insert("input".to_owned(), json!(params.input));
        if let Some(Value::Object(map)) = params.extra {
            for (key, value) in map {
                body.entry(key).or_insert(value);
            }
        }

        let result = self
            .request("turn/start", Some(Value::Object(body)), timeout_ms)
            .await?;
        let turn_id = extract_nested_id(&result, "turn")
            .ok_or_else(|| anyhow!("turn/start response missing turn id: {result}"))?;
        Ok(TurnStartResult {
            turn_id,
            raw: result,
        })
    }

    /// List persisted threads (`thread/list`).
    pub async fn list_threads(
        &self,
        params: ThreadListParams,
        timeout_ms: Option<u64>,
    ) -> Result<ThreadListResult> {
        let mut body = Map::new();
        if let Some(cursor) = params.cursor {
            body.insert("cursor".to_owned(), json!(cursor));
        }
        if let Some(limit) = params.limit {
            body.insert("limit".to_owned(), json!(limit));
        }
        if let Some(cwd) = params.cwd {
            body.insert("cwd".to_owned(), json!(cwd));
        }
        if let Some(archived) = params.archived {
            body.insert("archived".to_owned(), json!(archived));
        }
        if let Some(search_term) = params.search_term {
            body.insert("searchTerm".to_owned(), json!(search_term));
        }

        let result = self
            .request(
                "thread/list",
                if body.is_empty() {
                    Some(json!({}))
                } else {
                    Some(Value::Object(body))
                },
                timeout_ms,
            )
            .await?;
        let threads = result
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next_cursor = result
            .get("nextCursor")
            .or_else(|| result.get("next_cursor"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(ThreadListResult {
            threads,
            next_cursor,
            raw: result,
        })
    }

    /// Resume a thread by id (`thread/resume`).
    pub async fn resume_thread(
        &self,
        params: ThreadResumeParams,
        timeout_ms: Option<u64>,
    ) -> Result<ThreadResumeResult> {
        let mut body = Map::new();
        body.insert("threadId".to_owned(), json!(params.thread_id));
        if let Some(model) = params.model {
            body.insert("model".to_owned(), json!(model));
        }
        if let Some(cwd) = params.cwd {
            body.insert("cwd".to_owned(), json!(cwd));
        }
        if let Some(path) = params.path {
            body.insert("path".to_owned(), json!(path));
        }
        if let Some(Value::Object(map)) = params.extra {
            for (key, value) in map {
                body.entry(key).or_insert(value);
            }
        }

        let result = self
            .request("thread/resume", Some(Value::Object(body)), timeout_ms)
            .await?;
        let thread_id = extract_nested_id(&result, "thread")
            .or_else(|| {
                result
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or(params.thread_id);
        Ok(ThreadResumeResult {
            thread_id,
            raw: result,
        })
    }

    /// Interrupt an in-flight turn (`turn/interrupt`).
    pub async fn interrupt_turn(
        &self,
        params: TurnInterruptParams,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        let body = json!({
            "threadId": params.thread_id,
            "turnId": params.turn_id,
        });
        self.request("turn/interrupt", Some(body), timeout_ms).await
    }

    /// Steer the active turn with additional user input (`turn/steer`).
    pub async fn steer_turn(
        &self,
        params: TurnSteerParams,
        timeout_ms: Option<u64>,
    ) -> Result<TurnSteerResult> {
        let body = json!({
            "threadId": params.thread_id,
            "expectedTurnId": params.expected_turn_id,
            "input": params.input,
        });
        let result = self.request("turn/steer", Some(body), timeout_ms).await?;
        let turn_id = result
            .get("turnId")
            .or_else(|| result.get("turn_id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| extract_nested_id(&result, "turn"))
            .unwrap_or(params.expected_turn_id);
        Ok(TurnSteerResult {
            turn_id,
            raw: result,
        })
    }

    /// Wait for a turn to finish via app-server notifications.
    ///
    /// Recognizes common completion methods used by Codex app-server:
    /// `turn/completed`, `turn/complete`, and `codex/event` with
    /// `msg.type == "turn_complete"`.
    pub async fn wait_for_turn_completion(
        &self,
        turn_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<TurnCompleted> {
        let wait_ms = timeout_ms.unwrap_or(DEFAULT_TURN_TIMEOUT_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);

        loop {
            {
                let mut history = self.notifications.lock().await;
                if let Some(index) = history.iter().position(|notification| {
                    notification_matches_turn_complete(notification, turn_id)
                }) {
                    let notification = history.remove(index).expect("index valid");
                    let params = notification.params.unwrap_or(Value::Null);
                    return Ok(TurnCompleted {
                        turn_id: turn_id.to_owned(),
                        method: notification.method,
                        params,
                    });
                }
            }

            if self.closed.load(Ordering::SeqCst) {
                bail!("Codex app-server client is closed");
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("Timed out waiting for turn completion ({turn_id})");
            }
            let _ = timeout(remaining, self.notify.notified()).await;
        }
    }

    /// Drain buffered notifications matching `method` (and optional predicate).
    pub async fn take_notifications_where<F>(&self, mut predicate: F) -> Vec<Notification>
    where
        F: FnMut(&Notification) -> bool,
    {
        let mut history = self.notifications.lock().await;
        let mut kept = VecDeque::new();
        let mut taken = Vec::new();
        while let Some(notification) = history.pop_front() {
            if predicate(&notification) {
                taken.push(notification);
            } else {
                kept.push_back(notification);
            }
        }
        *history = kept;
        taken
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        (self.kill)();
        self.notify.notify_waiters();
    }

    fn write_message(&self, message: &Value) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("Codex app-server client is closed");
        }
        // Drop undefined-equivalent null optional fields? Compact like TS by filtering nulls only
        // at the top level where values are optional — keep as-is for fidelity.
        let line = format!("{}\n", serde_json::to_string(message)?);
        self.write_tx
            .send(line)
            .map_err(|_| anyhow!("Codex app-server stdin closed"))?;
        Ok(())
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        self.close();
        if let Some(handle) = self.reader_task.take() {
            handle.abort();
        }
        if let Some(handle) = self.writer_task.take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginFlow {
    Browser,
    Device,
}

/// In-memory transport for unit tests.
pub struct MockCodexTransport {
    write_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    event_tx: mpsc::UnboundedSender<IoEvent>,
    killed: Arc<AtomicBool>,
    requests: Arc<Mutex<VecDeque<Value>>>,
}

impl MockCodexTransport {
    /// Wait for the next outbound JSON-RPC message from the client.
    pub async fn next_request(&self) -> Result<Value> {
        {
            let mut buffered = self.requests.lock().await;
            if let Some(request) = buffered.pop_front() {
                return Ok(request);
            }
        }
        let mut rx = self.write_rx.lock().await;
        let line = timeout(Duration::from_secs(2), rx.recv())
            .await
            .map_err(|_| anyhow!("timed out waiting for client request"))?
            .ok_or_else(|| anyhow!("client write channel closed"))?;
        drop(rx);
        let value: Value = serde_json::from_str(line.trim())
            .with_context(|| format!("invalid client JSON: {line}"))?;
        Ok(value)
    }

    pub fn respond(&self, id: u64, result: Value) {
        let _ = self.event_tx.send(IoEvent::Line(
            json!({ "id": id, "result": result }).to_string(),
        ));
    }

    pub fn reject(&self, id: u64, message: &str) {
        let _ = self.event_tx.send(IoEvent::Line(
            json!({
                "id": id,
                "error": { "code": -32000, "message": message }
            })
            .to_string(),
        ));
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.event_tx.send(IoEvent::Line(
            json!({ "method": method, "params": params }).to_string(),
        ));
    }

    pub fn request_from_server(&self, id: Value, method: &str, params: Value) {
        let _ = self.event_tx.send(IoEvent::Line(
            json!({ "id": id, "method": method, "params": params }).to_string(),
        ));
    }

    pub fn exit(&self, code: i32) {
        let _ = self.event_tx.send(IoEvent::Exited {
            code: Some(code),
            signal: None,
        });
    }

    pub fn spawn_error_enoent(&self) {
        let _ = self.event_tx.send(IoEvent::SpawnError(
            "Codex app-server executable was not found (mock-codex). Maestro uses the bundled @openai/codex package when installed and falls back to a codex binary on PATH; run your package manager install in this checkout or install Codex with `npm install -g @openai/codex`.".to_owned(),
        ));
    }

    pub fn is_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }
}

async fn handle_line(
    line: &str,
    pending: &Arc<Mutex<PendingMap>>,
    notifications: &Arc<Mutex<VecDeque<Notification>>>,
    notify: &Arc<Notify>,
    write_tx: &mpsc::UnboundedSender<String>,
    external_server_requests: &Arc<AtomicBool>,
    server_requests: &Arc<Mutex<VecDeque<IncomingServerRequest>>>,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    let Some(obj) = message.as_object() else {
        return;
    };

    // Response: { id, result } or { id, error }
    if obj.contains_key("id") && (obj.contains_key("result") || obj.contains_key("error")) {
        let id = match obj.get("id") {
            Some(Value::Number(n)) => n.as_u64(),
            Some(Value::String(s)) => s.parse().ok(),
            _ => None,
        };
        let Some(id) = id else {
            return;
        };
        let mut map = pending.lock().await;
        if let Some(tx) = map.remove(&id) {
            if let Some(error) = obj.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server request failed");
                let _ = tx.send(Err(anyhow!(message.to_owned())));
            } else {
                let result = obj.get("result").cloned().unwrap_or(Value::Null);
                let _ = tx.send(Ok(result));
            }
        }
        return;
    }

    // Server request: { id, method, params? }
    if let (Some(method), Some(id)) = (
        obj.get("method").and_then(Value::as_str),
        obj.get("id").cloned(),
    ) {
        // Emit as notification too (matches TS)
        {
            let mut history = notifications.lock().await;
            history.push_back(Notification {
                method: method.to_owned(),
                params: obj.get("params").cloned(),
            });
            while history.len() > MAX_NOTIFICATION_HISTORY {
                history.pop_front();
            }
        }
        notify.notify_waiters();

        if method == "account/chatgptAuthTokens/refresh" {
            let response = json!({
                "id": id,
                "error": {
                    "code": -32601,
                    "message": "Maestro does not manage Codex ChatGPT auth tokens directly. Run `maestro codex login` or `codex login` so Codex app-server owns ChatGPT auth refresh."
                }
            });
            let _ = write_tx.send(format!("{response}\n"));
            return;
        }

        // Native agent owns tool calls and interactive approvals.
        // Await the reply off the reader task so message deltas and
        // turn/completed keep flowing while a tool or approval is outstanding.
        if external_server_requests.load(Ordering::SeqCst) && is_externally_handled_method(method) {
            let (reply_tx, reply_rx) = oneshot::channel();
            {
                let mut queue = server_requests.lock().await;
                queue.push_back(IncomingServerRequest {
                    id: id.clone(),
                    method: method.to_owned(),
                    params: obj.get("params").cloned(),
                    reply: reply_tx,
                });
            }
            notify.notify_waiters();
            let write_tx = write_tx.clone();
            let method_owned = method.to_owned();
            tokio::spawn(async move {
                let response =
                    match timeout(Duration::from_millis(DEFAULT_TURN_TIMEOUT_MS), reply_rx).await {
                        Ok(Ok(Ok(result))) => json!({ "id": id, "result": result }),
                        Ok(Ok(Err(message))) => json!({
                            "id": id,
                            "error": { "code": -32000, "message": message }
                        }),
                        Ok(Err(_)) => json!({
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": "Codex app-server server-request cancelled"
                            }
                        }),
                        Err(_) => json!({
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!(
                                    "Timed out waiting for Maestro to handle {method_owned}"
                                )
                            }
                        }),
                    };
                let _ = write_tx.send(format!("{response}\n"));
            });
            return;
        }

        let response = match default_server_request_response(method) {
            Some(result) => json!({ "id": id, "result": result }),
            None => json!({
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Unsupported Codex app-server request: {method}")
                }
            }),
        };
        let _ = write_tx.send(format!("{response}\n"));
        return;
    }

    // Notification: { method, params? }
    if let Some(method) = obj.get("method").and_then(Value::as_str) {
        let mut history = notifications.lock().await;
        history.push_back(Notification {
            method: method.to_owned(),
            params: obj.get("params").cloned(),
        });
        while history.len() > MAX_NOTIFICATION_HISTORY {
            history.pop_front();
        }
        notify.notify_waiters();
    }
}

async fn reject_all(
    pending: &Arc<Mutex<PendingMap>>,
    closed: &Arc<AtomicBool>,
    stderr_tail: &Arc<Mutex<VecDeque<String>>>,
    message: &str,
) {
    closed.store(true, Ordering::SeqCst);
    let stderr = {
        let tail = stderr_tail.lock().await;
        if tail.is_empty() {
            String::new()
        } else {
            let lines: Vec<_> = tail.iter().rev().take(5).cloned().collect();
            let mut ordered = lines;
            ordered.reverse();
            format!("\n{}", ordered.join("\n"))
        }
    };
    let full = format!("{message}{stderr}");
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(anyhow!(full.clone())));
    }
}

fn default_server_request_response(method: &str) -> Option<Value> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(json!({ "decision": "decline" }))
        }
        "item/permissions/requestApproval" => Some(json!({ "permissions": {}, "scope": "turn" })),
        "item/tool/requestUserInput" => Some(json!({ "answers": {} })),
        "mcpServer/elicitation/request" => {
            Some(json!({ "action": "decline", "content": null, "_meta": null }))
        }
        "applyPatchApproval" | "execCommandApproval" => Some(json!({ "decision": "denied" })),
        _ => None,
    }
}

fn is_externally_handled_method(method: &str) -> bool {
    matches!(
        method,
        "item/tool/call"
            | "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "applyPatchApproval"
            | "execCommandApproval"
    )
}

fn extract_nested_id(result: &Value, object_key: &str) -> Option<String> {
    // Prefer nested object: { thread: { id } } / { turn: { id } }
    if let Some(id) = result
        .get(object_key)
        .and_then(|obj| obj.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(id.to_owned());
    }
    // Flat forms used by some app-server builds: { threadId } / { turnId }
    let flat_key = format!("{object_key}Id");
    if let Some(id) = result
        .get(&flat_key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(id.to_owned());
    }
    // Bare { id } when the method scopes the object.
    result
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn notification_matches_turn_complete(notification: &Notification, turn_id: &str) -> bool {
    let params = notification.params.as_ref();
    let params_turn_id = params
        .and_then(|p| {
            p.get("turnId")
                .or_else(|| p.get("turn").and_then(|t| t.get("id")))
                .or_else(|| p.get("id"))
        })
        .and_then(Value::as_str);

    match notification.method.as_str() {
        "turn/completed" | "turn/complete" | "turn/completed/v2" => {
            params_turn_id.is_none_or(|id| id == turn_id)
        }
        "codex/event" => {
            let msg_type = params
                .and_then(|p| p.get("msg"))
                .and_then(|m| m.get("type"))
                .and_then(Value::as_str);
            msg_type == Some("turn_complete") && params_turn_id.is_none_or(|id| id == turn_id)
        }
        _ => false,
    }
}

/// Collect assistant text deltas from a batch of app-server notifications.
pub fn agent_message_text_from_notifications(notifications: &[Notification]) -> String {
    let mut out = String::new();
    for notification in notifications {
        let Some(params) = notification.params.as_ref() else {
            continue;
        };
        match notification.method.as_str() {
            "item/agentMessage/delta" | "item/agentMessageDelta" => {
                if let Some(delta) = params
                    .get("delta")
                    .or_else(|| params.get("text"))
                    .and_then(Value::as_str)
                {
                    out.push_str(delta);
                }
            }
            "item/agentMessage/completed" | "item/agentMessage" => {
                if let Some(text) = params
                    .get("text")
                    .or_else(|| params.get("message").and_then(|m| m.get("text")))
                    .and_then(Value::as_str)
                {
                    if out.is_empty() {
                        out.push_str(text);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Full text carried by an `item/completed` notification for an agent
/// message item (`ThreadItem::AgentMessage`).
///
/// Codex app-server (v2) delivers the authoritative, fully-accumulated
/// assistant text this way; there is no `item/agentMessage/completed`
/// method in the protocol.
pub fn agent_message_completed_text(notification: &Notification) -> Option<String> {
    if notification.method != "item/completed" {
        return None;
    }
    let item = notification.params.as_ref()?.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return None;
    }
    item.get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// True for notifications carrying assistant message content: streaming
/// `item/agentMessage/delta` and completed agent message items.
pub fn is_agent_message_notification(notification: &Notification) -> bool {
    notification.method.starts_with("item/agentMessage")
        || agent_message_completed_text(notification).is_some()
}

/// Resolve how to launch Codex app-server.
pub fn resolve_spawn_command(command: Option<&str>, args: Option<&[String]>) -> SpawnCommand {
    resolve_spawn_command_with(command, args, resolve_bundled_codex_bin_path)
}

pub fn resolve_spawn_command_with<F>(
    command: Option<&str>,
    args: Option<&[String]>,
    resolve_bundled: F,
) -> SpawnCommand
where
    F: FnOnce() -> Option<PathBuf>,
{
    let args = args.map(|values| values.to_vec()).unwrap_or_else(|| {
        DEFAULT_CODEX_APP_SERVER_ARGS
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    });

    if let Some(command) = command.filter(|value| !value.is_empty()) {
        return SpawnCommand {
            command: command.to_owned(),
            args,
            source: SpawnSource::Override,
        };
    }

    if let Some(bundled) = resolve_bundled() {
        let node = env::var("MAESTRO_NODE_BIN").unwrap_or_else(|_| "node".to_owned());
        let mut full_args = vec![bundled.display().to_string()];
        full_args.extend(args);
        return SpawnCommand {
            command: node,
            args: full_args,
            source: SpawnSource::BundledPackage,
        };
    }

    SpawnCommand {
        command: DEFAULT_CODEX_COMMAND.to_owned(),
        args,
        source: SpawnSource::Path,
    }
}

pub fn resolve_bundled_codex_bin_path() -> Option<PathBuf> {
    let relative = Path::new("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");

    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        let mut dir = cwd;
        for _ in 0..12 {
            candidates.push(dir.join(&relative));
            if !dir.pop() {
                break;
            }
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let mut dir = parent.to_path_buf();
            for _ in 0..12 {
                candidates.push(dir.join(&relative));
                if !dir.pop() {
                    break;
                }
            }
        }
    }
    // Packaged installs may coexist with node_modules at the package root.
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn package_version() -> String {
    env::var("MAESTRO_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned())
}

fn format_spawn_error(error: &std::io::Error, command_label: Option<&str>) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        let command = command_label
            .map(|label| format!(" ({label})"))
            .unwrap_or_default();
        return anyhow!(
            "Codex app-server executable was not found{command}. Maestro uses the bundled @openai/codex package when installed and falls back to a codex binary on PATH; run your package manager install in this checkout or install Codex with `npm install -g @openai/codex`."
        );
    }
    anyhow!(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_bundled_openai_codex_package_for_default_spawns() {
        let resolved = resolve_spawn_command_with(None, None, || {
            Some(PathBuf::from(
                "/workspace/node_modules/@openai/codex/bin/codex.js",
            ))
        });
        assert_eq!(resolved.source, SpawnSource::BundledPackage);
        let expected_node = std::env::var("MAESTRO_NODE_BIN").unwrap_or_else(|_| "node".to_owned());
        assert_eq!(resolved.command, expected_node);
        assert_eq!(
            resolved.args,
            vec![
                "/workspace/node_modules/@openai/codex/bin/codex.js".to_owned(),
                "app-server".to_owned(),
                "--listen".to_owned(),
                "stdio://".to_owned(),
            ]
        );
    }

    #[test]
    fn falls_back_to_codex_on_path_when_package_bin_unavailable() {
        let resolved = resolve_spawn_command_with(None, None, || None);
        assert_eq!(
            resolved,
            SpawnCommand {
                command: "codex".to_owned(),
                args: vec![
                    "app-server".to_owned(),
                    "--listen".to_owned(),
                    "stdio://".to_owned(),
                ],
                source: SpawnSource::Path,
            }
        );
    }

    #[test]
    fn honors_explicit_app_server_spawn_overrides() {
        let args = vec!["app-server".to_owned()];
        let resolved = resolve_spawn_command_with(Some("/tmp/codex-dev"), Some(&args), || {
            Some(PathBuf::from(
                "/workspace/node_modules/@openai/codex/bin/codex.js",
            ))
        });
        assert_eq!(
            resolved,
            SpawnCommand {
                command: "/tmp/codex-dev".to_owned(),
                args: vec!["app-server".to_owned()],
                source: SpawnSource::Override,
            }
        );
    }

    #[tokio::test]
    async fn initializes_and_sends_the_initialized_notification() {
        let (client, mock) = CodexAppServerClient::mock();
        let init = tokio::spawn(async move {
            client
                .initialize(InitializeOptions {
                    experimental_api: false,
                    ..Default::default()
                })
                .await
        });

        let request = mock.next_request().await.expect("initialize");
        assert_eq!(request["method"], "initialize");
        assert_eq!(request["id"], 1);
        assert_eq!(request["params"]["clientInfo"]["name"], "maestro");
        mock.respond(1, json!({ "protocolVersion": "app-server.v1" }));
        init.await.unwrap().expect("init ok");

        let initialized = mock.next_request().await.expect("initialized");
        assert_eq!(initialized["method"], "initialized");
        assert!(initialized.get("id").is_none());
    }

    #[tokio::test]
    async fn spawn_with_env_scopes_codex_home_to_the_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let script = temp.path().join("codex-env-server.js");
        std::fs::write(
            &script,
            r#"
const readline = require("readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { protocolVersion: process.env.CODEX_HOME || "missing" }
    }) + "\n");
  }
});
"#,
        )
        .expect("write script");
        let selected_home = temp.path().join("selected-codex-home");
        let child_env = HashMap::from([(
            "CODEX_HOME".to_owned(),
            selected_home.to_string_lossy().into_owned(),
        )]);
        let client = CodexAppServerClient::spawn_with_env(
            Some("node".to_owned()),
            Some(vec![script.to_string_lossy().into_owned()]),
            None,
            &child_env,
        )
        .await
        .expect("spawn fixture");
        let initialized = client
            .initialize(InitializeOptions::default())
            .await
            .unwrap();
        assert_eq!(
            initialized["protocolVersion"],
            selected_home.to_string_lossy().as_ref()
        );
        client.close();
    }

    #[tokio::test]
    async fn can_request_codex_streamlined_chatgpt_login() {
        let (client, mock) = CodexAppServerClient::mock();
        let task =
            tokio::spawn(async move { client.start_chatgpt_login(LoginFlow::Browser, true).await });
        let request = mock.next_request().await.expect("login");
        assert_eq!(request["params"]["type"], "chatgpt");
        assert_eq!(request["params"]["codexStreamlinedLogin"], true);
        mock.respond(
            1,
            json!({
                "type": "chatgpt",
                "loginId": "login-1",
                "authUrl": "https://chatgpt.com/auth"
            }),
        );
        task.await.unwrap().expect("ok");
    }

    #[tokio::test]
    async fn returns_actionable_error_for_unmanaged_token_refresh_requests() {
        let (client, mock) = CodexAppServerClient::mock();
        mock.request_from_server(
            json!("server-1"),
            "account/chatgptAuthTokens/refresh",
            json!({ "reason": "unauthorized" }),
        );
        // Allow reader to process
        tokio::time::sleep(Duration::from_millis(20)).await;
        let response = mock.next_request().await.expect("error response");
        assert_eq!(response["id"], "server-1");
        assert_eq!(response["error"]["code"], -32601);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("maestro codex login"));
        drop(client);
    }

    #[tokio::test]
    async fn resolves_login_completion_notifications_received_before_waiting() {
        let (client, mock) = CodexAppServerClient::mock();
        mock.notify(
            "account/login/completed",
            json!({
                "loginId": "login-1",
                "success": true,
                "error": null
            }),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        let completed = client
            .wait_for_login_completion("login-1", Some(100))
            .await
            .expect("completion");
        assert!(completed.success);
    }

    #[tokio::test]
    async fn rejects_notification_waiters_when_the_transport_exits() {
        let (client, mock) = CodexAppServerClient::mock();
        let wait = tokio::spawn(async move {
            client
                .wait_for_login_completion("login-1", Some(10_000))
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        mock.exit(1);
        let err = wait.await.unwrap().expect_err("should fail");
        let message = err.to_string();
        assert!(
            message.contains("exited with code 1") || message.contains("client is closed"),
            "unexpected error: {message}"
        );
    }

    #[tokio::test]
    async fn rejects_json_rpc_errors() {
        let (client, mock) = CodexAppServerClient::mock();
        let task = tokio::spawn(async move { client.read_account(false).await });
        let request = mock.next_request().await.expect("account/read");
        assert_eq!(request["method"], "account/read");
        let id = request["id"].as_u64().unwrap();
        mock.reject(id, "Not initialized");
        let err = task.await.unwrap().expect_err("rpc error");
        assert!(err.to_string().contains("Not initialized"));
    }

    #[tokio::test]
    async fn starts_login_waits_for_completion_end_to_end() {
        let (client, mock) = CodexAppServerClient::mock();
        let client = Arc::new(client);
        let client_login = Arc::clone(&client);
        let login_task = tokio::spawn(async move {
            client_login
                .start_chatgpt_login(LoginFlow::Browser, true)
                .await
        });
        let request = mock.next_request().await.unwrap();
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({
                "type": "chatgpt",
                "loginId": "login-1",
                "authUrl": "https://chatgpt.com/auth"
            }),
        );
        login_task.await.unwrap().unwrap();

        let client_wait = Arc::clone(&client);
        let wait_task = tokio::spawn(async move {
            client_wait
                .wait_for_login_completion("login-1", Some(1_000))
                .await
        });
        mock.notify(
            "account/login/completed",
            json!({
                "loginId": "login-1",
                "success": true,
                "error": null
            }),
        );
        let completed = wait_task.await.unwrap().unwrap();
        assert!(completed.success);
    }

    #[tokio::test]
    async fn starts_thread_and_turn_then_waits_for_completion() {
        let (client, mock) = CodexAppServerClient::mock();
        let client = Arc::new(client);

        let client_thread = Arc::clone(&client);
        let thread_task = tokio::spawn(async move {
            client_thread
                .start_thread(
                    ThreadStartParams {
                        model: "gpt-5.5".to_owned(),
                        cwd: Some("/tmp/ws".to_owned()),
                        approval_policy: Some("never".to_owned()),
                        sandbox: Some("workspace-write".to_owned()),
                        extra: None,
                    },
                    Some(1_000),
                )
                .await
        });
        let request = mock.next_request().await.expect("thread/start");
        assert_eq!(request["method"], "thread/start");
        assert_eq!(request["params"]["model"], "gpt-5.5");
        assert_eq!(request["params"]["cwd"], "/tmp/ws");
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({ "thread": { "id": "thr-1" } }),
        );
        let thread = thread_task.await.unwrap().expect("thread ok");
        assert_eq!(thread.thread_id, "thr-1");

        let client_turn = Arc::clone(&client);
        let turn_task = tokio::spawn(async move {
            client_turn
                .start_turn(TurnStartParams::text("thr-1", "hello"), Some(1_000))
                .await
        });
        let request = mock.next_request().await.expect("turn/start");
        assert_eq!(request["method"], "turn/start");
        assert_eq!(request["params"]["threadId"], "thr-1");
        assert_eq!(request["params"]["input"][0]["text"], "hello");
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({ "turn": { "id": "turn-9" } }),
        );
        let turn = turn_task.await.unwrap().expect("turn ok");
        assert_eq!(turn.turn_id, "turn-9");

        mock.notify(
            "item/agentMessage/delta",
            json!({ "turnId": "turn-9", "delta": "Hi " }),
        );
        mock.notify(
            "item/agentMessage/delta",
            json!({ "turnId": "turn-9", "delta": "there" }),
        );
        mock.notify(
            "turn/completed",
            json!({ "turnId": "turn-9", "status": "completed" }),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;

        let deltas = client
            .take_notifications_where(|n| n.method.starts_with("item/agentMessage"))
            .await;
        assert_eq!(agent_message_text_from_notifications(&deltas), "Hi there");

        let completed = client
            .wait_for_turn_completion("turn-9", Some(500))
            .await
            .expect("turn complete");
        assert_eq!(completed.turn_id, "turn-9");
        assert_eq!(completed.method, "turn/completed");
    }

    #[tokio::test]
    async fn injects_items_into_existing_thread_before_next_turn() {
        let (client, mock) = CodexAppServerClient::mock();
        let task = tokio::spawn(async move {
            client
                .inject_thread_items(
                    ThreadInjectItemsParams {
                        thread_id: "thr-restored".to_owned(),
                        items: json!([
                            { "type": "function_call", "call_id": "tool-1", "name": "read", "arguments": "{}" },
                            { "type": "function_call_output", "call_id": "tool-1", "output": "[tool result omitted from checkpoint]" }
                        ]),
                    },
                    Some(1_000),
                )
                .await
        });
        let request = mock.next_request().await.expect("thread/inject_items");
        assert_eq!(request["method"], "thread/inject_items");
        assert_eq!(request["params"]["threadId"], "thr-restored");
        assert_eq!(request["params"]["items"][0]["call_id"], "tool-1");
        assert_eq!(request["params"]["items"][1]["call_id"], "tool-1");
        mock.respond(request["id"].as_u64().unwrap(), json!({}));
        task.await.unwrap().expect("inject ok");
    }

    #[tokio::test]
    async fn lists_resumes_interrupts_and_steers_threads() {
        let (client, mock) = CodexAppServerClient::mock();
        let client = Arc::new(client);

        let list_client = Arc::clone(&client);
        let list_task = tokio::spawn(async move {
            list_client
                .list_threads(
                    ThreadListParams {
                        limit: Some(10),
                        cwd: Some("/tmp/ws".to_owned()),
                        ..Default::default()
                    },
                    Some(1_000),
                )
                .await
        });
        let request = mock.next_request().await.expect("thread/list");
        assert_eq!(request["method"], "thread/list");
        assert_eq!(request["params"]["limit"], 10);
        assert_eq!(request["params"]["cwd"], "/tmp/ws");
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({
                "data": [{ "id": "thr-1", "cwd": "/tmp/ws" }],
                "nextCursor": "cur-2"
            }),
        );
        let listed = list_task.await.unwrap().expect("list ok");
        assert_eq!(listed.threads.len(), 1);
        assert_eq!(listed.next_cursor.as_deref(), Some("cur-2"));

        let resume_client = Arc::clone(&client);
        let resume_task = tokio::spawn(async move {
            resume_client
                .resume_thread(ThreadResumeParams::new("thr-1"), Some(1_000))
                .await
        });
        let request = mock.next_request().await.expect("thread/resume");
        assert_eq!(request["method"], "thread/resume");
        assert_eq!(request["params"]["threadId"], "thr-1");
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({ "thread": { "id": "thr-1" } }),
        );
        let resumed = resume_task.await.unwrap().expect("resume ok");
        assert_eq!(resumed.thread_id, "thr-1");

        let interrupt_client = Arc::clone(&client);
        let interrupt_task = tokio::spawn(async move {
            interrupt_client
                .interrupt_turn(
                    TurnInterruptParams {
                        thread_id: "thr-1".to_owned(),
                        turn_id: "turn-9".to_owned(),
                    },
                    Some(1_000),
                )
                .await
        });
        let request = mock.next_request().await.expect("turn/interrupt");
        assert_eq!(request["method"], "turn/interrupt");
        assert_eq!(request["params"]["threadId"], "thr-1");
        assert_eq!(request["params"]["turnId"], "turn-9");
        mock.respond(request["id"].as_u64().unwrap(), json!({}));
        interrupt_task.await.unwrap().expect("interrupt ok");

        let steer_client = Arc::clone(&client);
        let steer_task = tokio::spawn(async move {
            steer_client
                .steer_turn(
                    TurnSteerParams::text("thr-1", "turn-9", "also do this"),
                    Some(1_000),
                )
                .await
        });
        let request = mock.next_request().await.expect("turn/steer");
        assert_eq!(request["method"], "turn/steer");
        assert_eq!(request["params"]["threadId"], "thr-1");
        assert_eq!(request["params"]["expectedTurnId"], "turn-9");
        assert_eq!(request["params"]["input"][0]["text"], "also do this");
        mock.respond(
            request["id"].as_u64().unwrap(),
            json!({ "turnId": "turn-9" }),
        );
        let steered = steer_task.await.unwrap().expect("steer ok");
        assert_eq!(steered.turn_id, "turn-9");
    }

    #[test]
    fn extract_nested_id_accepts_flat_and_nested_shapes() {
        assert_eq!(
            extract_nested_id(&json!({ "thread": { "id": "a" } }), "thread").as_deref(),
            Some("a")
        );
        assert_eq!(
            extract_nested_id(&json!({ "threadId": "b" }), "thread").as_deref(),
            Some("b")
        );
        assert_eq!(
            extract_nested_id(&json!({ "id": "c" }), "turn").as_deref(),
            Some("c")
        );
    }

    #[test]
    fn agent_message_completed_text_reads_item_completed_agent_messages() {
        let completed = Notification {
            method: "item/completed".to_owned(),
            params: Some(json!({
                "threadId": "thr-1",
                "turnId": "turn-9",
                "item": { "id": "msg-1", "type": "agentMessage", "text": "full answer" }
            })),
        };
        assert_eq!(
            agent_message_completed_text(&completed).as_deref(),
            Some("full answer")
        );
        assert!(is_agent_message_notification(&completed));

        // Other completed item types are not assistant text.
        let tool_item = Notification {
            method: "item/completed".to_owned(),
            params: Some(json!({
                "item": { "id": "tool-1", "type": "commandExecution", "text": "ls" }
            })),
        };
        assert_eq!(agent_message_completed_text(&tool_item), None);
        assert!(!is_agent_message_notification(&tool_item));

        // Deltas carry no completed text but are assistant notifications.
        let delta = Notification {
            method: "item/agentMessage/delta".to_owned(),
            params: Some(json!({ "turnId": "turn-9", "delta": "Hi" })),
        };
        assert_eq!(agent_message_completed_text(&delta), None);
        assert!(is_agent_message_notification(&delta));
    }
}

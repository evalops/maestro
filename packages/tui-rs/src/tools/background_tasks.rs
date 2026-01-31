//! Background task manager for long-running processes.
//!
//! This module provides functionality for managing background processes that
//! persist across agent interactions. Tasks are tracked with unique IDs and
//! their output is logged to files for later retrieval.
//!
//! # Features
//!
//! - Start processes in the background with optional shell mode
//! - Track process status (running, exited, failed, stopped)
//! - Retrieve logs from running or completed tasks
//! - Stop tasks and their child processes
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::tools::background_tasks::{start, list, stop, logs};
//!
//! // Start a dev server
//! let task = start(
//!     "npm run dev".to_string(),
//!     ".".to_string(),
//!     ".".to_string(),
//!     true,
//!     None,
//! )
//! .await?;
//!
//! // Check running tasks
//! for task in list() {
//!     println!("{}: {:?}", task.id, task.status);
//! }
//!
//! // Get logs
//! let output = logs(&task.id, 50)?;
//! ```

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use super::bash::resolve_shell_config;
use super::process_registry;
use super::process_utils::set_new_process_group;
use super::shell_env::resolve_shell_environment;

/// Status of a background task.
#[derive(Debug, Clone)]
pub enum BackgroundTaskStatus {
    /// Task is currently running.
    Running,
    /// Task exited successfully (exit code 0).
    Exited,
    /// Task failed (non-zero exit code or error).
    Failed,
    /// Task was manually stopped.
    Stopped,
}

/// A background task with its metadata and status.
#[derive(Debug, Clone)]
pub struct BackgroundTask {
    pub id: String,
    pub pid: Option<u32>,
    pub command: String,
    #[allow(dead_code)]
    pub cwd: String,
    pub log_path: String,
    pub log_write_failed: bool,
    pub log_write_error: Option<String>,
    pub status: BackgroundTaskStatus,
    #[allow(dead_code)]
    pub started_at: SystemTime,
    pub finished_at: Option<SystemTime>,
    pub exit_code: Option<i32>,
}

static TASKS: std::sync::LazyLock<RwLock<HashMap<String, BackgroundTask>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));
static ROTATION_OBSERVERS: std::sync::LazyLock<RwLock<HashMap<String, LogRotationObserver>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

const DEFAULT_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_LOG_SEGMENTS: usize = 2;
const MAX_LOG_SEGMENTS: usize = 10;
const MIN_LOG_BYTES: u64 = 50_000;

fn read_env_u64(name: &str, default: u64, min: u64) -> u64 {
    match std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok()) {
        Some(0) => 0,
        Some(value) if value < min => min,
        Some(value) => value,
        None => default,
    }
}

fn read_env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    match std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        Some(value) if value < min => min,
        Some(value) if value > max => max,
        Some(value) => value,
        None => default,
    }
}

fn log_limits() -> (u64, usize) {
    let bytes = read_env_u64(
        "COMPOSER_BACKGROUND_TASK_LOG_BYTES",
        DEFAULT_LOG_FILE_BYTES,
        MIN_LOG_BYTES,
    );
    let segments = read_env_usize(
        "COMPOSER_BACKGROUND_TASK_LOG_SEGMENTS",
        DEFAULT_LOG_SEGMENTS,
        0,
        MAX_LOG_SEGMENTS,
    );
    (bytes, segments)
}

#[derive(Debug, Clone)]
pub struct LogRotationInfo {
    pub log_path: PathBuf,
    pub archive_path: PathBuf,
    pub rotated_at: SystemTime,
}

#[derive(Debug, Default)]
struct RotationState {
    last_rotation: Option<LogRotationInfo>,
    failure_reason: Option<String>,
}

#[derive(Clone)]
struct LogRotationObserver {
    limit: u64,
    segments: usize,
    state: Arc<Mutex<RotationState>>,
    notify: Arc<Notify>,
}

impl LogRotationObserver {
    async fn wait_for_rotation(&self, timeout: Duration) -> Result<LogRotationInfo, String> {
        if self.segments == 0 || self.limit == 0 {
            return Err("Log rotation is disabled".to_string());
        }

        let deadline = Instant::now() + timeout;

        loop {
            {
                let state = self.state.lock().await;
                if let Some(info) = state.last_rotation.clone() {
                    return Ok(info);
                }
                if let Some(reason) = &state.failure_reason {
                    return Err(reason.clone());
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for log rotation".to_string());
            }

            if tokio::time::timeout(remaining, self.notify.notified())
                .await
                .is_err()
            {
                return Err("Timed out waiting for log rotation".to_string());
            }
        }
    }
}

fn store_rotation_observer(id: &str, observer: LogRotationObserver) {
    if let Ok(mut observers) = ROTATION_OBSERVERS.write() {
        observers.insert(id.to_string(), observer);
    }
}

fn remove_rotation_observer(id: &str) {
    if let Ok(mut observers) = ROTATION_OBSERVERS.write() {
        observers.remove(id);
    }
}

fn get_rotation_observer(id: &str) -> Result<LogRotationObserver, String> {
    let observers = ROTATION_OBSERVERS
        .read()
        .map_err(|_| "Rotation registry unavailable".to_string())?;
    if let Some(observer) = observers.get(id).cloned() {
        return Ok(observer);
    }
    drop(observers);
    let task_known = TASKS
        .read()
        .map(|tasks| tasks.contains_key(id))
        .unwrap_or(false);
    if task_known {
        return Err("Log rotation tracking unavailable for task".to_string());
    }
    Err("Task not found".to_string())
}

fn mark_log_write_failure(id: &str, reason: &str) {
    if let Ok(mut tasks) = TASKS.write() {
        if let Some(task) = tasks.get_mut(id) {
            if !task.log_write_failed {
                task.log_write_failed = true;
                task.log_write_error = Some(reason.to_string());
            }
        }
    }
}

struct RotatingLogWriter {
    log_path: PathBuf,
    limit: u64,
    segments: usize,
    current_size: u64,
    drop_all: bool,
    failed: bool,
    file: Option<tokio::fs::File>,
    observer: LogRotationObserver,
}

impl RotatingLogWriter {
    async fn new(log_path: PathBuf, limit: u64, segments: usize) -> Result<Self, String> {
        let state = Arc::new(Mutex::new(RotationState::default()));
        let notify = Arc::new(Notify::new());
        let observer = LogRotationObserver {
            limit,
            segments,
            state,
            notify,
        };

        let mut writer = Self {
            log_path,
            limit,
            segments,
            current_size: 0,
            drop_all: limit == 0,
            failed: false,
            file: None,
            observer,
        };

        writer.initialize().await?;
        Ok(writer)
    }

    fn observer(&self) -> LogRotationObserver {
        self.observer.clone()
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.ensure_log_file().await?;
        if self.drop_all {
            return Ok(());
        }

        let existing_size = match tokio::fs::metadata(&self.log_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        self.current_size = if self.limit > 0 {
            existing_size.min(self.limit)
        } else {
            0
        };

        if self.limit > 0 && self.current_size >= self.limit {
            let _ = self.rotate().await?;
        }

        Ok(())
    }

    async fn ensure_log_file(&mut self) -> Result<(), String> {
        ensure_logs_dir()?;
        if self.file.is_some() {
            return Ok(());
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .await
            .map_err(|e| format!("Failed to open log file: {e}"))?;
        self.file = Some(file);
        Ok(())
    }

    async fn append(&mut self, mut chunk: &[u8]) -> Result<(), String> {
        if self.drop_all || self.failed {
            return Ok(());
        }

        while !chunk.is_empty() {
            if self.current_size >= self.limit {
                let rotated = self.rotate().await?;
                if !rotated {
                    return Ok(());
                }
                continue;
            }

            let remaining_capacity = self.limit.saturating_sub(self.current_size);
            if remaining_capacity == 0 {
                return Ok(());
            }

            let to_write = remaining_capacity.min(chunk.len() as u64) as usize;
            let (head, rest) = chunk.split_at(to_write);

            self.ensure_log_file().await?;
            if let Some(file) = &mut self.file {
                file.write_all(head)
                    .await
                    .map_err(|e| format!("Failed to write log: {e}"))?;
            }
            self.current_size += head.len() as u64;
            chunk = rest;
        }

        Ok(())
    }

    async fn finish(&mut self) {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush().await;
        }

        let mut state = self.observer.state.lock().await;
        if state.last_rotation.is_none() && state.failure_reason.is_none() {
            state.failure_reason =
                Some("Log rotation did not occur before stream ended".to_string());
            drop(state);
            self.observer.notify.notify_waiters();
        }
    }

    async fn rotate(&mut self) -> Result<bool, String> {
        if self.segments == 0 {
            return Ok(false);
        }

        if let Some(mut file) = self.file.take() {
            let _ = file.flush().await;
        }

        self.shift_archives().await?;
        let archive_path = self.archive_path(1);

        match tokio::fs::rename(&self.log_path, &archive_path).await {
            Ok(()) => {
                self.ensure_log_file().await?;
                self.current_size = 0;
                let info = LogRotationInfo {
                    log_path: self.log_path.clone(),
                    archive_path: archive_path.clone(),
                    rotated_at: SystemTime::now(),
                };
                self.record_rotation(info).await;
                Ok(true)
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.ensure_log_file().await?;
                self.current_size = 0;
                Ok(true)
            }
            Err(err) => Err(format!("Failed to rotate log: {err}")),
        }
    }

    async fn shift_archives(&self) -> Result<(), String> {
        if self.segments == 0 {
            return Ok(());
        }
        for idx in (1..=self.segments).rev() {
            let path = self.archive_path(idx);
            if idx == self.segments {
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            let next = self.archive_path(idx + 1);
            let _ = tokio::fs::rename(&path, &next).await;
        }
        Ok(())
    }

    fn archive_path(&self, index: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.log_path.to_string_lossy(), index))
    }

    async fn record_rotation(&self, info: LogRotationInfo) {
        {
            let mut state = self.observer.state.lock().await;
            state.last_rotation = Some(info);
        }
        self.observer.notify.notify_waiters();
    }

    async fn record_failure(&mut self, reason: &str) {
        if self.failed {
            return;
        }
        self.failed = true;
        {
            let mut state = self.observer.state.lock().await;
            if state.failure_reason.is_none() {
                state.failure_reason = Some(reason.to_string());
            }
        }
        self.observer.notify.notify_waiters();
    }
}

const DEFAULT_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_LOG_SEGMENTS: usize = 2;
const MAX_LOG_SEGMENTS: usize = 10;
const MIN_LOG_BYTES: u64 = 50_000;

fn read_env_u64(name: &str, default: u64, min: u64) -> u64 {
    match std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok()) {
        Some(0) => 0,
        Some(value) if value < min => min,
        Some(value) => value,
        None => default,
    }
}

fn read_env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    match std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        Some(value) if value < min => min,
        Some(value) if value > max => max,
        Some(value) => value,
        None => default,
    }
}

fn log_limits() -> (u64, usize) {
    let bytes = read_env_u64(
        "COMPOSER_BACKGROUND_TASK_LOG_BYTES",
        DEFAULT_LOG_FILE_BYTES,
        MIN_LOG_BYTES,
    );
    let segments = read_env_usize(
        "COMPOSER_BACKGROUND_TASK_LOG_SEGMENTS",
        DEFAULT_LOG_SEGMENTS,
        0,
        MAX_LOG_SEGMENTS,
    );
    (bytes, segments)
}

#[derive(Debug, Clone)]
struct LogRotationInfo {
    log_path: PathBuf,
    archive_path: PathBuf,
    rotated_at: SystemTime,
}

#[derive(Debug, Default)]
struct RotationState {
    last_rotation: Option<LogRotationInfo>,
    failure_reason: Option<String>,
}

#[derive(Clone)]
struct LogRotationObserver {
    limit: u64,
    segments: usize,
    state: Arc<Mutex<RotationState>>,
    notify: Arc<Notify>,
}

impl LogRotationObserver {
    async fn wait_for_rotation(&self, timeout: Duration) -> Result<LogRotationInfo, String> {
        if self.segments == 0 || self.limit == 0 {
            return Err("Log rotation is disabled".to_string());
        }

        let deadline = Instant::now() + timeout;

        loop {
            {
                let state = self.state.lock().await;
                if let Some(info) = state.last_rotation.clone() {
                    return Ok(info);
                }
                if let Some(reason) = &state.failure_reason {
                    return Err(reason.clone());
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for log rotation".to_string());
            }

            if tokio::time::timeout(remaining, self.notify.notified())
                .await
                .is_err()
            {
                return Err("Timed out waiting for log rotation".to_string());
            }
        }
    }
}

struct RotatingLogWriter {
    log_path: PathBuf,
    limit: u64,
    segments: usize,
    current_size: u64,
    drop_all: bool,
    failed: bool,
    file: Option<tokio::fs::File>,
    observer: LogRotationObserver,
}

impl RotatingLogWriter {
    async fn new(log_path: PathBuf, limit: u64, segments: usize) -> Result<Self, String> {
        let state = Arc::new(Mutex::new(RotationState::default()));
        let notify = Arc::new(Notify::new());
        let observer = LogRotationObserver {
            limit,
            segments,
            state,
            notify,
        };

        let mut writer = Self {
            log_path,
            limit,
            segments,
            current_size: 0,
            drop_all: limit == 0,
            failed: false,
            file: None,
            observer,
        };

        writer.initialize().await?;
        Ok(writer)
    }

    fn observer(&self) -> LogRotationObserver {
        self.observer.clone()
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.ensure_log_file().await?;
        if self.drop_all {
            return Ok(());
        }

        let existing_size = match tokio::fs::metadata(&self.log_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        self.current_size = if self.limit > 0 {
            existing_size.min(self.limit)
        } else {
            0
        };

        if self.limit > 0 && self.current_size >= self.limit {
            let _ = self.rotate().await?;
        }

        Ok(())
    }

    async fn ensure_log_file(&mut self) -> Result<(), String> {
        ensure_logs_dir()?;
        if self.file.is_some() {
            return Ok(());
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .await
            .map_err(|e| format!("Failed to open log file: {e}"))?;
        self.file = Some(file);
        Ok(())
    }

    async fn append(&mut self, mut chunk: &[u8]) -> Result<(), String> {
        if self.drop_all || self.failed {
            return Ok(());
        }

        while !chunk.is_empty() {
            if self.current_size >= self.limit {
                let rotated = self.rotate().await?;
                if !rotated {
                    return Ok(());
                }
                continue;
            }

            let remaining_capacity = self.limit.saturating_sub(self.current_size);
            if remaining_capacity == 0 {
                return Ok(());
            }

            let to_write = remaining_capacity.min(chunk.len() as u64) as usize;
            let (head, rest) = chunk.split_at(to_write);

            self.ensure_log_file().await?;
            if let Some(file) = &mut self.file {
                file.write_all(head)
                    .await
                    .map_err(|e| format!("Failed to write log: {e}"))?;
            }
            self.current_size += head.len() as u64;
            chunk = rest;
        }

        Ok(())
    }

    async fn finish(&mut self) {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush().await;
        }

        let mut state = self.observer.state.lock().await;
        if state.last_rotation.is_none() && state.failure_reason.is_none() {
            state.failure_reason =
                Some("Log rotation did not occur before stream ended".to_string());
            drop(state);
            self.observer.notify.notify_waiters();
        }
    }

    async fn rotate(&mut self) -> Result<bool, String> {
        if self.segments == 0 {
            return Ok(false);
        }

        if let Some(mut file) = self.file.take() {
            let _ = file.flush().await;
        }

        self.shift_archives().await?;
        let archive_path = self.archive_path(1);

        match tokio::fs::rename(&self.log_path, &archive_path).await {
            Ok(()) => {
                self.ensure_log_file().await?;
                self.current_size = 0;
                let info = LogRotationInfo {
                    log_path: self.log_path.clone(),
                    archive_path: archive_path.clone(),
                    rotated_at: SystemTime::now(),
                };
                self.record_rotation(info).await;
                Ok(true)
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.ensure_log_file().await?;
                self.current_size = 0;
                Ok(true)
            }
            Err(err) => Err(format!("Failed to rotate log: {err}")),
        }
    }

    async fn shift_archives(&self) -> Result<(), String> {
        if self.segments == 0 {
            return Ok(());
        }
        for idx in (1..=self.segments).rev() {
            let path = self.archive_path(idx);
            if idx == self.segments {
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            let next = self.archive_path(idx + 1);
            let _ = tokio::fs::rename(&path, &next).await;
        }
        Ok(())
    }

    fn archive_path(&self, index: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.log_path.to_string_lossy(), index))
    }

    async fn record_rotation(&self, info: LogRotationInfo) {
        {
            let mut state = self.observer.state.lock().await;
            state.last_rotation = Some(info);
        }
        self.observer.notify.notify_waiters();
    }

    async fn record_failure(&mut self, reason: &str) {
        if self.failed {
            return;
        }
        self.failed = true;
        {
            let mut state = self.observer.state.lock().await;
            if state.failure_reason.is_none() {
                state.failure_reason = Some(reason.to_string());
            }
        }
        self.observer.notify.notify_waiters();
    }
}

fn logs_dir() -> PathBuf {
    dirs::home_dir().map_or_else(
        || std::env::temp_dir().join("composer-logs"),
        |home| home.join(".composer").join("logs"),
    )
}

fn ensure_logs_dir() -> Result<(), String> {
    let dir = logs_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create logs directory {}: {}", dir.display(), e))
}

fn read_last_lines(path: &Path, lines: usize) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open log: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read log: {e}"))?;

    let text = String::from_utf8_lossy(&buf);
    let mut collected: Vec<&str> = text.lines().collect();
    if collected.len() > lines {
        collected = collected.split_off(collected.len() - lines);
    }
    Ok(collected.join("\n"))
}

async fn drain_stream<R>(
    mut reader: R,
    writer: Arc<Mutex<RotatingLogWriter>>,
    remaining: Arc<AtomicUsize>,
    task_id: String,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buffer = [0u8; 8192];
    let mut write_failed = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => {
                if write_failed {
                    continue;
                }
                let mut guard = writer.lock().await;
                if let Err(err) = guard.append(&buffer[..count]).await {
                    guard.record_failure(&err).await;
                    mark_log_write_failure(&task_id, &err);
                    write_failed = true;
                }
            }
            Err(err) => {
                let mut guard = writer.lock().await;
                let reason = format!("Log stream read failed: {err}");
                guard.record_failure(&reason).await;
                mark_log_write_failure(&task_id, &reason);
                break;
            }
        }
    }

    if remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
        let mut guard = writer.lock().await;
        guard.finish().await;
    }
}

/// Start a new background task.
///
/// # Arguments
///
/// * `command` - The command to execute
/// * `cwd` - Working directory for the process
/// * `workspace_dir` - Workspace root for config resolution
/// * `shell` - If true, run through the system shell (enables pipes, redirects)
/// * `env` - Optional additional environment variables
///
/// # Returns
///
/// The created [`BackgroundTask`] with its unique ID, or an error message.
pub async fn start(
    command: String,
    cwd: String,
    workspace_dir: String,
    shell: bool,
    env: Option<HashMap<String, String>>,
) -> Result<BackgroundTask, String> {
    ensure_logs_dir()?;
    let id = Uuid::new_v4().to_string();
    let log_path = logs_dir().join(format!("background-{id}.log"));
    let (log_limit, log_segments) = log_limits();
    let log_writer = RotatingLogWriter::new(log_path.clone(), log_limit, log_segments).await?;
    let log_writer = Arc::new(Mutex::new(log_writer));
    let observer = { log_writer.lock().await.observer() };

    let mut cmd = if shell {
        let (shell_path, shell_args) =
            resolve_shell_config().map_err(|e| format!("Shell unavailable: {e}"))?;
        let mut cmd = Command::new(shell_path);
        cmd.args(shell_args).arg(command.clone());
        cmd
    } else {
        let parts = shlex::split(&command)
            .ok_or_else(|| "Failed to parse command arguments".to_string())?;
        if parts.is_empty() {
            return Err("Empty command".to_string());
        }
        let mut cmd = Command::new(&parts[0]);
        if parts.len() > 1 {
            cmd.args(&parts[1..]);
        }
        cmd
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let resolved_env = resolve_shell_environment(Path::new(&workspace_dir), env.as_ref());
    cmd.env_clear();
    cmd.envs(resolved_env);

    set_new_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn background task: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stream_count = usize::from(stdout.is_some()) + usize::from(stderr.is_some());
    let remaining = Arc::new(AtomicUsize::new(stream_count.max(1)));

    if let Some(out) = stdout {
        tokio::spawn(drain_stream(
            out,
            log_writer.clone(),
            remaining.clone(),
            id.clone(),
        ));
    }
    if let Some(err) = stderr {
        tokio::spawn(drain_stream(
            err,
            log_writer.clone(),
            remaining.clone(),
            id.clone(),
        ));
    }
    if stream_count == 0 {
        let mut guard = log_writer.lock().await;
        guard.finish().await;
    }

    let pid = child.id();
    if let Some(pid) = pid {
        process_registry::register(pid);
    }

    let task = BackgroundTask {
        id: id.clone(),
        pid,
        command: command.clone(),
        cwd,
        log_path: log_path.to_string_lossy().to_string(),
        log_write_failed: false,
        log_write_error: None,
        status: BackgroundTaskStatus::Running,
        started_at: SystemTime::now(),
        finished_at: None,
        exit_code: None,
    };

    if let Ok(mut tasks) = TASKS.write() {
        tasks.insert(id.clone(), task.clone());
    }
    store_rotation_observer(&id, observer);

    // Track completion
    tokio::spawn(async move {
        let status = child.wait().await;
        let (exit_code, failed) = match status {
            Ok(status) => (status.code().unwrap_or(-1), !status.success()),
            Err(_) => (-1, true),
        };

        if let Ok(mut tasks) = TASKS.write() {
            if let Some(existing) = tasks.get_mut(&id) {
                existing.finished_at = Some(SystemTime::now());
                existing.exit_code = Some(exit_code);
                existing.status = if failed {
                    BackgroundTaskStatus::Failed
                } else {
                    BackgroundTaskStatus::Exited
                };
            }
        }
        remove_rotation_observer(&id);

        if let Some(pid) = pid {
            process_registry::unregister(pid);
        }
    });

    Ok(task)
}

/// List all background tasks.
///
/// Returns a snapshot of all tasks, including completed ones.
pub fn list() -> Vec<BackgroundTask> {
    TASKS
        .read()
        .map(|tasks| tasks.values().cloned().collect())
        .unwrap_or_default()
}

/// Stop a running background task.
///
/// Kills the process and its children, then marks the task as stopped.
///
/// # Arguments
///
/// * `id` - The task ID returned from [`start`]
///
/// # Errors
///
/// Returns an error if the task is not found.
pub fn stop(id: &str) -> Result<BackgroundTask, String> {
    let mut tasks = TASKS
        .write()
        .map_err(|_| "Task registry unavailable".to_string())?;
    let task = tasks
        .get_mut(id)
        .ok_or_else(|| "Task not found".to_string())?;

    if let Some(pid) = task.pid {
        super::process_utils::kill_process_tree(pid);
        process_registry::unregister(pid);
    }
    task.status = BackgroundTaskStatus::Stopped;
    task.finished_at = Some(SystemTime::now());
    remove_rotation_observer(id);

    Ok(task.clone())
}

/// Retrieve the last N lines from a task's log file.
///
/// # Arguments
///
/// * `id` - The task ID returned from [`start`]
/// * `lines` - Maximum number of lines to retrieve
///
/// # Errors
///
/// Returns an error if the task is not found or the log file cannot be read.
pub fn logs(id: &str, lines: usize) -> Result<String, String> {
    let tasks = TASKS
        .read()
        .map_err(|_| "Task registry unavailable".to_string())?;
    let task = tasks.get(id).ok_or_else(|| "Task not found".to_string())?;
    read_last_lines(Path::new(&task.log_path), lines)
}

pub async fn wait_for_rotation(id: &str, timeout: Duration) -> Result<LogRotationInfo, String> {
    let observer = get_rotation_observer(id)?;
    observer.wait_for_rotation(timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ========================================================================
    // logs_dir Tests
    // ========================================================================

    #[test]
    fn test_logs_dir_returns_path() {
        let dir = logs_dir();
        // Should end with "logs" or "composer-logs"
        let dir_str = dir.to_string_lossy();
        assert!(
            dir_str.ends_with("logs") || dir_str.contains("composer"),
            "logs_dir should return a composer logs path: {}",
            dir_str
        );
    }

    #[test]
    fn test_logs_dir_is_absolute() {
        let dir = logs_dir();
        assert!(dir.is_absolute(), "logs_dir should return an absolute path");
    }

    // ========================================================================
    // read_last_lines Tests
    // ========================================================================

    #[test]
    fn test_read_last_lines_basic() {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_read_last_lines.txt");

        // Write test content
        {
            let mut file = File::create(&temp_file).unwrap();
            writeln!(file, "line 1").unwrap();
            writeln!(file, "line 2").unwrap();
            writeln!(file, "line 3").unwrap();
            writeln!(file, "line 4").unwrap();
            writeln!(file, "line 5").unwrap();
        }

        // Read last 3 lines
        let result = read_last_lines(&temp_file, 3).unwrap();
        assert_eq!(result, "line 3\nline 4\nline 5");

        // Cleanup
        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_read_last_lines_more_than_available() {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_read_last_lines_short.txt");

        // Write only 2 lines
        {
            let mut file = File::create(&temp_file).unwrap();
            writeln!(file, "first").unwrap();
            writeln!(file, "second").unwrap();
        }

        // Request more lines than available
        let result = read_last_lines(&temp_file, 10).unwrap();
        assert_eq!(result, "first\nsecond");

        // Cleanup
        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_read_last_lines_empty_file() {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_read_last_lines_empty.txt");

        // Create empty file
        File::create(&temp_file).unwrap();

        let result = read_last_lines(&temp_file, 5).unwrap();
        assert!(result.is_empty());

        // Cleanup
        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_read_last_lines_nonexistent_file() {
        let result = read_last_lines(Path::new("/nonexistent/path/file.txt"), 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to open log"));
    }

    // ========================================================================
    // BackgroundTaskStatus Tests
    // ========================================================================

    #[test]
    fn test_background_task_status_debug() {
        let running = BackgroundTaskStatus::Running;
        let exited = BackgroundTaskStatus::Exited;
        let failed = BackgroundTaskStatus::Failed;
        let stopped = BackgroundTaskStatus::Stopped;

        // Test that Debug is implemented
        assert!(format!("{:?}", running).contains("Running"));
        assert!(format!("{:?}", exited).contains("Exited"));
        assert!(format!("{:?}", failed).contains("Failed"));
        assert!(format!("{:?}", stopped).contains("Stopped"));
    }

    #[test]
    fn test_background_task_status_clone() {
        let status = BackgroundTaskStatus::Running;
        let cloned = status.clone();
        assert!(matches!(cloned, BackgroundTaskStatus::Running));
    }

    // ========================================================================
    // BackgroundTask Tests
    // ========================================================================

    #[test]
    fn test_background_task_struct() {
        let task = BackgroundTask {
            id: "test-id-123".to_string(),
            pid: Some(12345),
            command: "echo hello".to_string(),
            cwd: "/tmp".to_string(),
            log_path: "/tmp/test.log".to_string(),
            log_write_failed: false,
            log_write_error: None,
            status: BackgroundTaskStatus::Running,
            started_at: SystemTime::now(),
            finished_at: None,
            exit_code: None,
        };

        assert_eq!(task.id, "test-id-123");
        assert_eq!(task.pid, Some(12345));
        assert_eq!(task.command, "echo hello");
        assert!(task.finished_at.is_none());
        assert!(task.exit_code.is_none());
    }

    #[test]
    fn test_background_task_clone() {
        let task = BackgroundTask {
            id: "clone-test".to_string(),
            pid: None,
            command: "sleep 10".to_string(),
            cwd: ".".to_string(),
            log_path: "/tmp/clone.log".to_string(),
            log_write_failed: true,
            log_write_error: Some("Log write failed".to_string()),
            status: BackgroundTaskStatus::Exited,
            started_at: SystemTime::now(),
            finished_at: Some(SystemTime::now()),
            exit_code: Some(0),
        };

        let cloned = task.clone();
        assert_eq!(cloned.id, task.id);
        assert_eq!(cloned.command, task.command);
        assert_eq!(cloned.exit_code, Some(0));
    }

    // ========================================================================
    // list() Tests
    // ========================================================================

    #[test]
    fn test_list_returns_vec() {
        // list() should return a Vec, even if empty
        let tasks = list();
        // Verify it's a valid Vec (may or may not have tasks from other tests)
        // This primarily ensures the function doesn't panic
        let _ = tasks.len();
    }

    // ========================================================================
    // stop() and logs() Error Cases
    // ========================================================================

    #[test]
    fn test_stop_nonexistent_task() {
        let result = stop("nonexistent-task-id-12345");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Task not found"));
    }

    #[test]
    fn test_logs_nonexistent_task() {
        let result = logs("nonexistent-task-id-67890", 10);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Task not found"));
    }

    // ========================================================================
    // ensure_logs_dir Tests
    // ========================================================================

    #[test]
    fn test_ensure_logs_dir_success() {
        // Should succeed (creates dir if needed)
        let result = ensure_logs_dir();
        assert!(result.is_ok());

        // Verify the directory exists
        let dir = logs_dir();
        assert!(
            dir.exists(),
            "Logs directory should exist after ensure_logs_dir"
        );
    }

    // ========================================================================
    // Log Rotation Waiter Tests
    // ========================================================================

    #[tokio::test]
    async fn test_wait_for_rotation_disabled() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("disabled.log");
        let writer = RotatingLogWriter::new(log_path, 0, 0).await.unwrap();

        let err = writer
            .observer()
            .wait_for_rotation(Duration::from_millis(10))
            .await
            .unwrap_err();
        assert!(err.contains("Log rotation is disabled"));
    }

    #[tokio::test]
    async fn test_wait_for_rotation_times_out() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("timeout.log");
        let writer = RotatingLogWriter::new(log_path, 1024, 1).await.unwrap();

        let err = writer
            .observer()
            .wait_for_rotation(Duration::from_millis(10))
            .await
            .unwrap_err();
        assert!(err.contains("Timed out waiting for log rotation"));
    }

    #[tokio::test]
    async fn test_wait_for_rotation_succeeds() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("rotate.log");
        let mut writer = RotatingLogWriter::new(log_path.clone(), 10, 1)
            .await
            .unwrap();

        writer.append(b"12345678901").await.unwrap();

        let info = writer
            .observer()
            .wait_for_rotation(Duration::from_secs(1))
            .await
            .unwrap();
        assert!(info.archive_path.exists());
        assert_eq!(info.log_path, log_path);
    }

    #[tokio::test]
    async fn test_wait_for_rotation_stream_end() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("ended.log");
        let mut writer = RotatingLogWriter::new(log_path, 1024, 1).await.unwrap();
        let observer = writer.observer();

        writer.finish().await;

        let err = observer
            .wait_for_rotation(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(err.contains("Log rotation did not occur before stream ended"));
    }
}

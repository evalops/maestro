//! Background task manager (minimal parity with TS `background_tasks` tool).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::RwLock;
use std::time::SystemTime;

use tokio::process::Command;
use uuid::Uuid;

use super::bash::resolve_shell_config;
use super::process_registry;
use super::process_utils::set_new_process_group;

#[derive(Debug, Clone)]
pub enum BackgroundTaskStatus {
    Running,
    Exited,
    Failed,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct BackgroundTask {
    pub id: String,
    pub pid: Option<u32>,
    pub command: String,
    #[allow(dead_code)]
    pub cwd: String,
    pub log_path: String,
    pub status: BackgroundTaskStatus,
    #[allow(dead_code)]
    pub started_at: SystemTime,
    pub finished_at: Option<SystemTime>,
    pub exit_code: Option<i32>,
}

static TASKS: std::sync::LazyLock<RwLock<HashMap<String, BackgroundTask>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

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

pub async fn start(
    command: String,
    cwd: String,
    shell: bool,
    env: Option<HashMap<String, String>>,
) -> Result<BackgroundTask, String> {
    ensure_logs_dir()?;
    let id = Uuid::new_v4().to_string();
    let log_path = logs_dir().join(format!("background-{id}.log"));

    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;

    let stdout = Stdio::from(log_file.try_clone().map_err(|e| e.to_string())?);
    let stderr = Stdio::from(log_file);

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
        .stdout(stdout)
        .stderr(stderr);

    if let Some(env) = env {
        cmd.envs(env);
    }

    set_new_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn background task: {e}"))?;

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
        status: BackgroundTaskStatus::Running,
        started_at: SystemTime::now(),
        finished_at: None,
        exit_code: None,
    };

    if let Ok(mut tasks) = TASKS.write() {
        tasks.insert(id.clone(), task.clone());
    }

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

        if let Some(pid) = pid {
            process_registry::unregister(pid);
        }
    });

    Ok(task)
}

pub fn list() -> Vec<BackgroundTask> {
    TASKS
        .read()
        .map(|tasks| tasks.values().cloned().collect())
        .unwrap_or_default()
}

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

    Ok(task.clone())
}

pub fn logs(id: &str, lines: usize) -> Result<String, String> {
    let tasks = TASKS
        .read()
        .map_err(|_| "Task registry unavailable".to_string())?;
    let task = tasks.get(id).ok_or_else(|| "Task not found".to_string())?;
    read_last_lines(Path::new(&task.log_path), lines)
}

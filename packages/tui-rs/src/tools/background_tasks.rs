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
//! let task = start("npm run dev".to_string(), ".".to_string(), true, None).await?;
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

/// Start a new background task.
///
/// # Arguments
///
/// * `command` - The command to execute
/// * `cwd` - Working directory for the process
/// * `shell` - If true, run through the system shell (enables pipes, redirects)
/// * `env` - Optional additional environment variables
///
/// # Returns
///
/// The created [`BackgroundTask`] with its unique ID, or an error message.
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
}

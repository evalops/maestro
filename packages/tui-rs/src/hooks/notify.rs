//! Notification hooks for agent events
//!
//! Allows external programs to be notified when agent events occur,
//! enabling CI/automation integration and custom workflows.
//!
//! # Configuration
//!
//! Environment variables:
//! - `COMPOSER_NOTIFY_PROGRAM`: Path to script to run on events
//! - `COMPOSER_NOTIFY_EVENTS`: Comma-separated events or "all"
//! - `COMPOSER_NOTIFY_TERMINAL`: Enable OSC 9 terminal notifications
//! - `COMPOSER_NOTIFY_TIMEOUT`: Timeout in ms (default: 30000)
//!
//! Config file (`~/.composer/hooks.json`):
//! ```json
//! {
//!   "notify": {
//!     "program": "/path/to/script",
//!     "events": ["turn-complete", "session-end"],
//!     "terminalNotify": true
//!   }
//! }
//! ```
//!
//! # Terminal Notifications
//!
//! Uses OSC 9 escape sequences supported by:
//! - iTerm2
//! - Ghostty
//! - WezTerm
//! - Windows Terminal

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// Event types that can trigger notifications
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotifyEventType {
    /// A turn (user prompt + assistant response) completed
    TurnComplete,
    /// Session started
    SessionStart,
    /// Session ended
    SessionEnd,
    /// Tool execution completed
    ToolExecution,
    /// An error occurred
    Error,
}

impl NotifyEventType {
    /// Parse from string
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().replace('_', "-").as_str() {
            "turn-complete" => Some(Self::TurnComplete),
            "session-start" => Some(Self::SessionStart),
            "session-end" => Some(Self::SessionEnd),
            "tool-execution" => Some(Self::ToolExecution),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    /// All event types
    pub fn all() -> Vec<Self> {
        vec![
            Self::TurnComplete,
            Self::SessionStart,
            Self::SessionEnd,
            Self::ToolExecution,
            Self::Error,
        ]
    }
}

/// Payload sent to notification handlers
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPayload {
    /// Event type
    #[serde(rename = "type")]
    pub event_type: NotifyEventType,
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Current working directory
    pub cwd: String,
    /// Session/thread ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Turn ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// User input messages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_messages: Option<Vec<String>>,
    /// Last assistant message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
    /// Tool name (for tool-execution events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Tool result (truncated)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<String>,
    /// Error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NotifyPayload {
    /// Create a new payload with timestamp
    pub fn new(event_type: NotifyEventType, cwd: &str) -> Self {
        Self {
            event_type,
            timestamp: chrono::Utc::now().to_rfc3339(),
            cwd: cwd.to_string(),
            thread_id: None,
            turn_id: None,
            input_messages: None,
            last_assistant_message: None,
            tool_name: None,
            tool_result: None,
            error: None,
        }
    }

    /// Set session ID
    pub fn with_session(mut self, session_id: Option<String>) -> Self {
        self.thread_id = session_id;
        self
    }

    /// Set tool info
    pub fn with_tool(mut self, name: &str, result: Option<&str>) -> Self {
        self.tool_name = Some(name.to_string());
        self.tool_result = result.map(|r| r.chars().take(1000).collect());
        self
    }

    /// Set error message
    pub fn with_error(mut self, error: &str) -> Self {
        self.error = Some(error.to_string());
        self
    }

    /// Set assistant message
    pub fn with_assistant_message(mut self, message: &str) -> Self {
        self.last_assistant_message = Some(message.to_string());
        self
    }
}

/// Configuration for notification hooks
#[derive(Debug, Clone)]
pub struct NotifyConfig {
    /// External program to run
    pub program: Option<PathBuf>,
    /// Events to notify on
    pub events: Vec<NotifyEventType>,
    /// Enable OSC 9 terminal notifications
    pub terminal_notify: bool,
    /// Timeout for external program
    pub timeout: Duration,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            program: None,
            events: Vec::new(),
            terminal_notify: false,
            timeout: Duration::from_secs(30),
        }
    }
}

impl NotifyConfig {
    /// Load configuration from environment and config files
    pub fn load() -> Self {
        static CONFIG: OnceLock<NotifyConfig> = OnceLock::new();
        CONFIG.get_or_init(Self::load_impl).clone()
    }

    fn load_impl() -> Self {
        let mut config = Self {
            program: None,
            events: Vec::new(),
            terminal_notify: false,
            timeout: Duration::from_secs(30),
        };

        // Environment variables take precedence
        if let Ok(program) = std::env::var("COMPOSER_NOTIFY_PROGRAM") {
            config.program = Some(PathBuf::from(program));
        }

        if let Ok(events) = std::env::var("COMPOSER_NOTIFY_EVENTS") {
            if events == "all" {
                config.events = NotifyEventType::all();
            } else {
                config.events = events
                    .split(',')
                    .filter_map(|s| NotifyEventType::from_str(s.trim()))
                    .collect();
            }
        }

        if let Ok(terminal) = std::env::var("COMPOSER_NOTIFY_TERMINAL") {
            config.terminal_notify = terminal == "true" || terminal == "1";
        }

        if let Ok(timeout) = std::env::var("COMPOSER_NOTIFY_TIMEOUT") {
            if let Ok(ms) = timeout.parse::<u64>() {
                config.timeout = Duration::from_millis(ms);
            }
        }

        // Load from config file if program not set
        if config.program.is_none() {
            if let Some(home) = dirs::home_dir() {
                let config_path = home.join(".composer").join("hooks.json");
                if config_path.exists() {
                    if let Ok(contents) = std::fs::read_to_string(&config_path) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
                            if let Some(notify) = json.get("notify") {
                                if let Some(program) =
                                    notify.get("program").and_then(|v| v.as_str())
                                {
                                    config.program = Some(PathBuf::from(program));
                                }
                                if let Some(events) =
                                    notify.get("events").and_then(|v| v.as_array())
                                {
                                    config.events = events
                                        .iter()
                                        .filter_map(|v| v.as_str())
                                        .filter_map(NotifyEventType::from_str)
                                        .collect();
                                }
                                if let Some(terminal) =
                                    notify.get("terminalNotify").and_then(|v| v.as_bool())
                                {
                                    config.terminal_notify = terminal;
                                }
                                if let Some(timeout) =
                                    notify.get("timeout").and_then(|v| v.as_u64())
                                {
                                    config.timeout = Duration::from_millis(timeout);
                                }
                            }
                        }
                    }
                }
            }
        }

        config
    }

    /// Check if notifications are enabled for an event type
    pub fn is_enabled(&self, event_type: NotifyEventType) -> bool {
        self.program.is_some() && self.events.contains(&event_type)
    }
}

/// Notification system for sending alerts
pub struct Notifier {
    config: NotifyConfig,
}

impl Notifier {
    /// Create a new notifier with loaded configuration
    pub fn new() -> Self {
        Self {
            config: NotifyConfig::load(),
        }
    }

    /// Create with custom configuration
    pub fn with_config(config: NotifyConfig) -> Self {
        Self { config }
    }

    /// Check if notifications are enabled for an event
    pub fn is_enabled(&self, event_type: NotifyEventType) -> bool {
        self.config.is_enabled(event_type)
    }

    /// Check if terminal notifications are enabled
    pub fn terminal_enabled(&self) -> bool {
        self.config.terminal_notify
    }

    /// Send a notification (non-blocking)
    pub fn notify(&self, payload: &NotifyPayload) {
        // Terminal notification
        if self.config.terminal_notify {
            self.send_terminal_notification(payload);
        }

        // External program
        if self.config.is_enabled(payload.event_type) {
            self.send_program_notification(payload);
        }
    }

    /// Send OSC 9 terminal notification
    ///
    /// Supported by iTerm2, Ghostty, WezTerm, Windows Terminal
    pub fn send_terminal_notification(&self, payload: &NotifyPayload) {
        let title = match payload.event_type {
            NotifyEventType::TurnComplete => "Turn Complete",
            NotifyEventType::SessionStart => "Session Started",
            NotifyEventType::SessionEnd => "Session Ended",
            NotifyEventType::ToolExecution => "Tool Executed",
            NotifyEventType::Error => "Error",
        };

        let body = match payload.event_type {
            NotifyEventType::TurnComplete => payload
                .last_assistant_message
                .as_ref()
                .map(|m| m.chars().take(100).collect::<String>())
                .unwrap_or_default(),
            NotifyEventType::ToolExecution => payload
                .tool_name
                .as_ref()
                .map(|n| format!("Ran {}", n))
                .unwrap_or_default(),
            NotifyEventType::Error => payload.error.clone().unwrap_or_default(),
            _ => String::new(),
        };

        let message = if body.is_empty() {
            title.to_string()
        } else {
            format!("{}: {}", title, body)
        };

        // OSC 9: ESC ] 9 ; message BEL
        let osc9 = format!("\x1b]9;{}\x07", message);
        let _ = std::io::stdout().write_all(osc9.as_bytes());
        let _ = std::io::stdout().flush();
    }

    /// Send notification to external program
    fn send_program_notification(&self, payload: &NotifyPayload) {
        let Some(ref program) = self.config.program else {
            return;
        };

        let json = match serde_json::to_string(payload) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[notify] Failed to serialize payload: {}", e);
                return;
            }
        };

        let program = program.clone();
        let timeout = self.config.timeout;

        // Spawn in background to not block
        std::thread::spawn(move || {
            match Command::new(&program)
                .arg(&json)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(mut child) => {
                    // Wait with timeout
                    match child.wait_timeout(timeout) {
                        Ok(Some(status)) => {
                            if !status.success() {
                                eprintln!(
                                    "[notify] Program {} exited with status {}",
                                    program.display(),
                                    status
                                );
                            }
                        }
                        Ok(None) => {
                            // Timed out
                            let _ = child.kill();
                            eprintln!(
                                "[notify] Program {} timed out after {:?}",
                                program.display(),
                                timeout
                            );
                        }
                        Err(e) => {
                            eprintln!("[notify] Failed to wait for {}: {}", program.display(), e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[notify] Failed to spawn {}: {}", program.display(), e);
                }
            }
        });
    }

    /// Convenience: notify turn complete
    pub fn turn_complete(&self, cwd: &str, session_id: Option<String>, message: Option<&str>) {
        let mut payload =
            NotifyPayload::new(NotifyEventType::TurnComplete, cwd).with_session(session_id);
        if let Some(msg) = message {
            payload = payload.with_assistant_message(msg);
        }
        self.notify(&payload);
    }

    /// Convenience: notify session start
    pub fn session_start(&self, cwd: &str, session_id: Option<String>) {
        let payload =
            NotifyPayload::new(NotifyEventType::SessionStart, cwd).with_session(session_id);
        self.notify(&payload);
    }

    /// Convenience: notify session end
    pub fn session_end(&self, cwd: &str, session_id: Option<String>) {
        let payload = NotifyPayload::new(NotifyEventType::SessionEnd, cwd).with_session(session_id);
        self.notify(&payload);
    }

    /// Convenience: notify tool execution
    pub fn tool_execution(
        &self,
        cwd: &str,
        session_id: Option<String>,
        tool_name: &str,
        result: Option<&str>,
    ) {
        let payload = NotifyPayload::new(NotifyEventType::ToolExecution, cwd)
            .with_session(session_id)
            .with_tool(tool_name, result);
        self.notify(&payload);
    }

    /// Convenience: notify error
    pub fn error(&self, cwd: &str, session_id: Option<String>, error: &str) {
        let payload = NotifyPayload::new(NotifyEventType::Error, cwd)
            .with_session(session_id)
            .with_error(error);
        self.notify(&payload);
    }
}

impl Default for Notifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Extension trait for wait_timeout on Child
trait ChildExt {
    fn wait_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl ChildExt for std::process::Child {
    fn wait_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let start = std::time::Instant::now();
        loop {
            match self.try_wait()? {
                Some(status) => return Ok(Some(status)),
                None => {
                    if start.elapsed() >= timeout {
                        return Ok(None);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_from_str() {
        assert_eq!(
            NotifyEventType::from_str("turn-complete"),
            Some(NotifyEventType::TurnComplete)
        );
        assert_eq!(
            NotifyEventType::from_str("session-start"),
            Some(NotifyEventType::SessionStart)
        );
        assert_eq!(
            NotifyEventType::from_str("TURN_COMPLETE"),
            Some(NotifyEventType::TurnComplete)
        );
        assert_eq!(NotifyEventType::from_str("invalid"), None);
    }

    #[test]
    fn test_payload_serialization() {
        let payload = NotifyPayload::new(NotifyEventType::TurnComplete, "/tmp")
            .with_session(Some("session-123".to_string()))
            .with_assistant_message("Hello!");

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("turn-complete"));
        assert!(json.contains("session-123"));
        assert!(json.contains("Hello!"));
    }

    #[test]
    fn test_notifier_creation() {
        let notifier = Notifier::new();
        // Should not panic even without config
        assert!(!notifier.is_enabled(NotifyEventType::TurnComplete));
    }

    #[test]
    fn test_config_defaults() {
        let config = NotifyConfig::default();
        assert!(config.program.is_none());
        assert!(config.events.is_empty());
        assert!(!config.terminal_notify);
        assert_eq!(config.timeout, Duration::from_secs(30));
    }
}

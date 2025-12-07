//! Desktop notifications for agent events.
//!
//! Supports two notification mechanisms:
//! 1. External program notifications (JSON payload passed as argument)
//! 2. Terminal escape sequences (OSC 9) for iTerm2, Ghostty, WezTerm, etc.
//!
//! Configuration via environment variables:
//! - COMPOSER_NOTIFY_PROGRAM: Path to external notification program
//! - COMPOSER_NOTIFY_EVENTS: Comma-separated list of events (or "all")
//! - COMPOSER_NOTIFY_TERMINAL: Enable OSC 9 terminal notifications (true/1)

use serde::{Deserialize, Serialize};
use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Event types that can trigger notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationEvent {
    TurnComplete,
    SessionStart,
    SessionEnd,
    ToolExecution,
    Error,
}

impl NotificationEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TurnComplete => "turn-complete",
            Self::SessionStart => "session-start",
            Self::SessionEnd => "session-end",
            Self::ToolExecution => "tool-execution",
            Self::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "turn-complete" => Some(Self::TurnComplete),
            "session-start" => Some(Self::SessionStart),
            "session-end" => Some(Self::SessionEnd),
            "tool-execution" => Some(Self::ToolExecution),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

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

/// Payload sent to notification programs.
#[derive(Debug, Clone, Serialize)]
pub struct NotificationPayload {
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Notification configuration.
#[derive(Debug, Clone)]
pub struct NotificationConfig {
    pub program: Option<PathBuf>,
    pub events: Vec<NotificationEvent>,
    pub terminal_notify: bool,
    pub timeout_ms: u64,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            program: None,
            events: Vec::new(),
            terminal_notify: false,
            timeout_ms: 30_000,
        }
    }
}

static CONFIG: OnceLock<NotificationConfig> = OnceLock::new();

/// Load notification configuration from environment.
pub fn load_config() -> &'static NotificationConfig {
    CONFIG.get_or_init(|| {
        let mut config = NotificationConfig::default();

        // External program
        if let Ok(program) = env::var("COMPOSER_NOTIFY_PROGRAM") {
            config.program = Some(PathBuf::from(program));
        }

        // Events to notify on
        if let Ok(events) = env::var("COMPOSER_NOTIFY_EVENTS") {
            if events == "all" {
                config.events = NotificationEvent::all();
            } else {
                config.events = events
                    .split(',')
                    .filter_map(|s| NotificationEvent::parse(s.trim()))
                    .collect();
            }
        }

        // Terminal notifications
        if let Ok(terminal) = env::var("COMPOSER_NOTIFY_TERMINAL") {
            config.terminal_notify = terminal == "true" || terminal == "1";
        }

        // Timeout
        if let Ok(timeout) = env::var("COMPOSER_NOTIFY_TIMEOUT") {
            if let Ok(ms) = timeout.parse() {
                config.timeout_ms = ms;
            }
        }

        config
    })
}

/// Check if notifications are enabled for a given event.
pub fn is_enabled(event: NotificationEvent) -> bool {
    let config = load_config();
    config.program.is_some() && config.events.contains(&event)
}

/// Check if terminal notifications are enabled.
pub fn is_terminal_enabled() -> bool {
    load_config().terminal_notify
}

/// Send a notification via external program.
pub fn send_notification(payload: &NotificationPayload) {
    let config = load_config();

    let event = NotificationEvent::parse(&payload.event_type);
    if let Some(event) = event {
        if !config.events.contains(&event) {
            return;
        }
    }

    if let Some(program) = &config.program {
        if let Ok(json) = serde_json::to_string(payload) {
            let _ = Command::new(program).arg(&json).spawn();
        }
    }
}

/// Send a terminal notification using OSC 9 escape sequence.
/// Supported by iTerm2, Ghostty, WezTerm, Windows Terminal.
pub fn send_terminal_notification(title: &str, body: Option<&str>) {
    if !load_config().terminal_notify {
        return;
    }

    let message = match body {
        Some(b) => format!("{}: {}", title, b),
        None => title.to_string(),
    };

    // OSC 9 escape sequence: ESC ] 9 ; message BEL
    let osc9 = format!("\x1b]9;{}\x07", message);
    let _ = std::io::stdout().write_all(osc9.as_bytes());
    let _ = std::io::stdout().flush();
}

/// Convenience function to notify turn completion.
pub fn notify_turn_complete(summary: &str, session_id: Option<&str>) {
    // Terminal notification
    send_terminal_notification("Composer", Some(summary));

    // External program notification
    let payload = NotificationPayload {
        event_type: "turn-complete".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        thread_id: session_id.map(String::from),
        last_assistant_message: Some(summary.to_string()),
        tool_name: None,
        error: None,
    };
    send_notification(&payload);
}

/// Notify session start.
pub fn notify_session_start(session_id: Option<&str>) {
    send_terminal_notification("Composer", Some("Session started"));

    let payload = NotificationPayload {
        event_type: "session-start".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        thread_id: session_id.map(String::from),
        last_assistant_message: None,
        tool_name: None,
        error: None,
    };
    send_notification(&payload);
}

/// Notify error.
pub fn notify_error(error: &str) {
    send_terminal_notification("Composer Error", Some(error));

    let payload = NotificationPayload {
        event_type: "error".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        thread_id: None,
        last_assistant_message: None,
        tool_name: None,
        error: Some(error.to_string()),
    };
    send_notification(&payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_parse() {
        assert_eq!(
            NotificationEvent::parse("turn-complete"),
            Some(NotificationEvent::TurnComplete)
        );
        assert_eq!(NotificationEvent::parse("invalid"), None);
    }

    #[test]
    fn test_payload_serialization() {
        let payload = NotificationPayload {
            event_type: "turn-complete".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            cwd: "/test".to_string(),
            thread_id: Some("session-123".to_string()),
            last_assistant_message: Some("Done!".to_string()),
            tool_name: None,
            error: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("turn-complete"));
        assert!(json.contains("session-123"));
    }
}

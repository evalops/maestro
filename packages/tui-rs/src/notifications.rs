//! Desktop Notifications
//!
//! Sends system notifications when tasks complete.
//! Supports macOS, Linux, and Windows notification systems.

use std::path::PathBuf;

/// Configuration for desktop notifications.
#[derive(Debug, Clone, Default)]
pub struct NotificationConfig {
    /// Whether notifications are enabled.
    pub enabled: bool,
    /// Whether terminal bell is enabled.
    pub terminal_bell: bool,
    /// Custom sound file path (optional).
    pub sound_file: Option<PathBuf>,
}

/// Events that can trigger notifications.
#[derive(Debug, Clone)]
pub enum NotificationEvent {
    /// Session started.
    SessionStart,
    /// Turn/response completed.
    TurnComplete,
    /// Error occurred.
    Error(String),
}

/// Payload for a notification.
#[derive(Debug, Clone)]
pub struct NotificationPayload {
    /// Title of the notification.
    pub title: String,
    /// Body text.
    pub body: String,
    /// Optional sound.
    pub sound: Option<String>,
}

/// Load notification configuration.
pub fn load_config() -> NotificationConfig {
    NotificationConfig::default()
}

/// Check if notifications are enabled.
pub fn is_enabled() -> bool {
    false
}

/// Check if terminal notifications are enabled.
pub fn is_terminal_enabled() -> bool {
    false
}

/// Send a desktop notification.
pub fn send_notification(_payload: NotificationPayload) {
    // Stub - would use notify-rust or similar
}

/// Send a terminal notification (bell).
pub fn send_terminal_notification() {
    print!("\x07"); // Terminal bell
}

/// Notify session start.
pub fn notify_session_start() {
    // Stub
}

/// Notify turn complete.
pub fn notify_turn_complete() {
    // Stub
}

/// Notify error.
pub fn notify_error(_msg: &str) {
    // Stub
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults() {
        let config = NotificationConfig::default();
        assert!(!config.enabled);
    }
}

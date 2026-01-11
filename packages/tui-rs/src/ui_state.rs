//! Persistent UI state for the Rust TUI.
//!
//! Mirrors the JS UI state file for queue mode preferences.

use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::safety::expand_tilde;
use crate::state::QueueMode;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiStateFile {
    queue_mode: Option<QueueMode>,
    steering_mode: Option<QueueMode>,
    follow_up_mode: Option<QueueMode>,
}

#[derive(Debug, Clone, Default)]
pub struct QueueModeState {
    pub steering_mode: Option<QueueMode>,
    pub follow_up_mode: Option<QueueMode>,
}

#[must_use]
pub fn load_queue_modes() -> QueueModeState {
    let Some(path) = ui_state_path() else {
        return QueueModeState::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return QueueModeState::default();
    };
    let Ok(parsed) = serde_json::from_str::<UiStateFile>(&raw) else {
        return QueueModeState::default();
    };

    let legacy = parsed.queue_mode;
    QueueModeState {
        steering_mode: parsed.steering_mode.or(legacy),
        follow_up_mode: parsed.follow_up_mode.or(legacy),
    }
}

pub fn save_queue_modes(steering_mode: QueueMode, follow_up_mode: QueueMode) -> io::Result<()> {
    let Some(path) = ui_state_path() else {
        return Ok(());
    };

    let mut root = match fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        Some(value) => value,
        None => serde_json::Value::Object(serde_json::Map::new()),
    };
    if !root.is_object() {
        root = serde_json::Value::Object(serde_json::Map::new());
    }
    let object = root
        .as_object_mut()
        .expect("ui state value should be an object");

    object.insert(
        "steeringMode".to_string(),
        serde_json::to_value(steering_mode)?,
    );
    object.insert(
        "followUpMode".to_string(),
        serde_json::to_value(follow_up_mode)?,
    );
    if steering_mode == follow_up_mode {
        object.insert(
            "queueMode".to_string(),
            serde_json::to_value(steering_mode)?,
        );
    } else {
        object.remove("queueMode");
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_string_pretty(&root)?;
    fs::write(path, encoded)
}

fn ui_state_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("COMPOSER_UI_STATE") {
        if !path.trim().is_empty() {
            let raw = PathBuf::from(path);
            if let Some(expanded) = expand_tilde(&raw) {
                return Some(expanded);
            }
            return Some(raw);
        }
    }

    let home = dirs::home_dir()?;
    Some(home.join(".composer").join("agent").join("ui-state.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // UiStateFile Deserialization Tests
    // ========================================================================

    #[test]
    fn test_ui_state_file_empty() {
        let json = "{}";
        let state: UiStateFile = serde_json::from_str(json).unwrap();
        assert!(state.queue_mode.is_none());
        assert!(state.steering_mode.is_none());
        assert!(state.follow_up_mode.is_none());
    }

    #[test]
    fn test_ui_state_file_legacy_queue_mode() {
        let json = r#"{"queueMode": "all"}"#;
        let state: UiStateFile = serde_json::from_str(json).unwrap();
        assert_eq!(state.queue_mode, Some(QueueMode::All));
        assert!(state.steering_mode.is_none());
    }

    #[test]
    fn test_ui_state_file_new_modes() {
        let json = r#"{"steeringMode": "one", "followUpMode": "all"}"#;
        let state: UiStateFile = serde_json::from_str(json).unwrap();
        assert_eq!(state.steering_mode, Some(QueueMode::One));
        assert_eq!(state.follow_up_mode, Some(QueueMode::All));
    }

    #[test]
    fn test_ui_state_file_all_modes() {
        let json = r#"{"queueMode": "one", "steeringMode": "all", "followUpMode": "one"}"#;
        let state: UiStateFile = serde_json::from_str(json).unwrap();
        assert_eq!(state.queue_mode, Some(QueueMode::One));
        assert_eq!(state.steering_mode, Some(QueueMode::All));
        assert_eq!(state.follow_up_mode, Some(QueueMode::One));
    }

    // ========================================================================
    // QueueModeState Tests
    // ========================================================================

    #[test]
    fn test_queue_mode_state_default() {
        let state = QueueModeState::default();
        assert!(state.steering_mode.is_none());
        assert!(state.follow_up_mode.is_none());
    }

    // ========================================================================
    // UI State Path Tests
    // ========================================================================

    #[test]
    fn test_ui_state_path_default() {
        // Clear env var to test default behavior
        std::env::remove_var("COMPOSER_UI_STATE");
        let path = ui_state_path();
        if let Some(p) = path {
            assert!(p.ends_with("ui-state.json"));
            assert!(p.to_string_lossy().contains(".composer"));
        }
    }

    #[test]
    fn test_ui_state_path_from_env() {
        std::env::set_var("COMPOSER_UI_STATE", "/tmp/custom-ui-state.json");
        let path = ui_state_path();
        assert_eq!(path, Some(PathBuf::from("/tmp/custom-ui-state.json")));
        std::env::remove_var("COMPOSER_UI_STATE");
    }

    #[test]
    fn test_ui_state_path_empty_env() {
        std::env::set_var("COMPOSER_UI_STATE", "   ");
        let path = ui_state_path();
        // Should fall back to default when env var is empty/whitespace
        if let Some(p) = path {
            assert!(p.ends_with("ui-state.json"));
        }
        std::env::remove_var("COMPOSER_UI_STATE");
    }

    #[test]
    fn test_ui_state_path_tilde_expansion() {
        std::env::set_var("COMPOSER_UI_STATE", "~/my-ui-state.json");
        let path = ui_state_path();
        if let Some(p) = path {
            // Should not start with ~ after expansion
            assert!(!p.to_string_lossy().starts_with('~'));
            assert!(p.to_string_lossy().ends_with("my-ui-state.json"));
        }
        std::env::remove_var("COMPOSER_UI_STATE");
    }
}

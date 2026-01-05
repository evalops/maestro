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

    let next = UiStateFile {
        queue_mode: if steering_mode == follow_up_mode {
            Some(steering_mode)
        } else {
            None
        },
        steering_mode: Some(steering_mode),
        follow_up_mode: Some(follow_up_mode),
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_string_pretty(&next)?;
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

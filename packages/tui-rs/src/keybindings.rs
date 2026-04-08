use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crossterm::event::KeyCode;
use serde::Deserialize;

use crate::key_hints::{alt, ctrl, shift, KeyBinding};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum RustTuiKeybindingAction {
    CommandPalette,
    FileSearch,
    ToggleToolOutputs,
    EditLastQueuedFollowUp,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum RustTuiKeybindingShortcut {
    CtrlP,
    CtrlO,
    CtrlT,
    AltUp,
    ShiftLeft,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RustTuiKeybindingLabels {
    pub command_palette: String,
    pub file_search: String,
    pub toggle_tool_outputs: String,
    pub edit_last_queued_follow_up: String,
}

impl Default for RustTuiKeybindingLabels {
    fn default() -> Self {
        Self {
            command_palette: ctrl(KeyCode::Char('p')).display(),
            file_search: ctrl(KeyCode::Char('o')).display(),
            toggle_tool_outputs: ctrl(KeyCode::Char('t')).display(),
            edit_last_queued_follow_up: alt(KeyCode::Up).display(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RustTuiKeybindings {
    pub command_palette: KeyBinding,
    pub file_search: KeyBinding,
    pub toggle_tool_outputs: KeyBinding,
    pub edit_last_queued_follow_up: KeyBinding,
}

impl RustTuiKeybindings {
    #[must_use]
    pub fn labels(&self) -> RustTuiKeybindingLabels {
        RustTuiKeybindingLabels {
            command_palette: self.command_palette.display(),
            file_search: self.file_search.display(),
            toggle_tool_outputs: self.toggle_tool_outputs.display(),
            edit_last_queued_follow_up: self.edit_last_queued_follow_up.display(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct StoredRustTuiKeybindingsFile {
    version: Option<u8>,
    #[serde(default, rename = "rustBindings")]
    rust_bindings: HashMap<String, String>,
}

const RUST_TUI_KEYBINDING_ACTIONS: [RustTuiKeybindingAction; 4] = [
    RustTuiKeybindingAction::CommandPalette,
    RustTuiKeybindingAction::FileSearch,
    RustTuiKeybindingAction::ToggleToolOutputs,
    RustTuiKeybindingAction::EditLastQueuedFollowUp,
];

#[must_use]
pub fn queued_follow_up_edit_binding_for_terminal_name(
    terminal_name: &str,
    in_tmux: bool,
) -> KeyBinding {
    if in_tmux || terminal_name.eq_ignore_ascii_case("tmux") {
        return shift(KeyCode::Left);
    }

    match terminal_name.to_ascii_lowercase().as_str() {
        "apple_terminal" | "warp" | "warpterminal" | "vscode" => shift(KeyCode::Left),
        _ => alt(KeyCode::Up),
    }
}

#[must_use]
pub fn load_rust_tui_keybindings(terminal_name: &str, in_tmux: bool) -> RustTuiKeybindings {
    let config_path = std::env::var_os("MAESTRO_KEYBINDINGS_FILE")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".maestro").join("keybindings.json")));
    load_rust_tui_keybindings_from_path(config_path.as_deref(), terminal_name, in_tmux)
}

fn load_rust_tui_keybindings_from_path(
    config_path: Option<&Path>,
    terminal_name: &str,
    in_tmux: bool,
) -> RustTuiKeybindings {
    let defaults = default_shortcuts(terminal_name, in_tmux);
    let Some(path) = config_path else {
        return shortcuts_to_bindings(&defaults);
    };

    let overrides = read_rust_tui_keybinding_overrides(path);
    let mut resolved = defaults.clone();
    for (action, shortcut) in &overrides {
        resolved.insert(*action, *shortcut);
    }

    let overridden_actions: HashSet<RustTuiKeybindingAction> = overrides.keys().copied().collect();
    let mut changed = true;
    while changed {
        changed = false;
        let mut actions_by_shortcut: HashMap<
            RustTuiKeybindingShortcut,
            Vec<RustTuiKeybindingAction>,
        > = HashMap::new();
        for action in RUST_TUI_KEYBINDING_ACTIONS {
            let shortcut = resolved[&action];
            actions_by_shortcut
                .entry(shortcut)
                .or_default()
                .push(action);
        }

        for actions in actions_by_shortcut.values() {
            if actions.len() < 2 {
                continue;
            }
            for action in actions {
                if overridden_actions.contains(action) && resolved[action] != defaults[action] {
                    resolved.insert(*action, defaults[action]);
                    changed = true;
                }
            }
        }
    }

    shortcuts_to_bindings(&resolved)
}

fn default_shortcuts(
    terminal_name: &str,
    in_tmux: bool,
) -> HashMap<RustTuiKeybindingAction, RustTuiKeybindingShortcut> {
    HashMap::from([
        (
            RustTuiKeybindingAction::CommandPalette,
            RustTuiKeybindingShortcut::CtrlP,
        ),
        (
            RustTuiKeybindingAction::FileSearch,
            RustTuiKeybindingShortcut::CtrlO,
        ),
        (
            RustTuiKeybindingAction::ToggleToolOutputs,
            RustTuiKeybindingShortcut::CtrlT,
        ),
        (
            RustTuiKeybindingAction::EditLastQueuedFollowUp,
            shortcut_for_binding(queued_follow_up_edit_binding_for_terminal_name(
                terminal_name,
                in_tmux,
            )),
        ),
    ])
}

fn shortcuts_to_bindings(
    shortcuts: &HashMap<RustTuiKeybindingAction, RustTuiKeybindingShortcut>,
) -> RustTuiKeybindings {
    RustTuiKeybindings {
        command_palette: binding_for_shortcut(shortcuts[&RustTuiKeybindingAction::CommandPalette]),
        file_search: binding_for_shortcut(shortcuts[&RustTuiKeybindingAction::FileSearch]),
        toggle_tool_outputs: binding_for_shortcut(
            shortcuts[&RustTuiKeybindingAction::ToggleToolOutputs],
        ),
        edit_last_queued_follow_up: binding_for_shortcut(
            shortcuts[&RustTuiKeybindingAction::EditLastQueuedFollowUp],
        ),
    }
}

fn read_rust_tui_keybinding_overrides(
    path: &Path,
) -> HashMap<RustTuiKeybindingAction, RustTuiKeybindingShortcut> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<StoredRustTuiKeybindingsFile>(&content) else {
        return HashMap::new();
    };
    if parsed.version != Some(1) {
        return HashMap::new();
    }

    let mut overrides = HashMap::new();
    for (action, shortcut) in parsed.rust_bindings {
        let Some(action) = parse_action_name(&action) else {
            continue;
        };
        let Some(shortcut) = parse_shortcut_name(&shortcut) else {
            continue;
        };
        overrides.insert(action, shortcut);
    }
    overrides
}

fn parse_action_name(value: &str) -> Option<RustTuiKeybindingAction> {
    match value {
        "command-palette" => Some(RustTuiKeybindingAction::CommandPalette),
        "file-search" => Some(RustTuiKeybindingAction::FileSearch),
        "toggle-tool-outputs" => Some(RustTuiKeybindingAction::ToggleToolOutputs),
        "edit-last-follow-up" => Some(RustTuiKeybindingAction::EditLastQueuedFollowUp),
        _ => None,
    }
}

fn parse_shortcut_name(value: &str) -> Option<RustTuiKeybindingShortcut> {
    let normalized = value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "ctrl+p" => Some(RustTuiKeybindingShortcut::CtrlP),
        "ctrl+o" => Some(RustTuiKeybindingShortcut::CtrlO),
        "ctrl+t" => Some(RustTuiKeybindingShortcut::CtrlT),
        "alt+up" => Some(RustTuiKeybindingShortcut::AltUp),
        "shift+left" => Some(RustTuiKeybindingShortcut::ShiftLeft),
        _ => None,
    }
}

fn binding_for_shortcut(shortcut: RustTuiKeybindingShortcut) -> KeyBinding {
    match shortcut {
        RustTuiKeybindingShortcut::CtrlP => ctrl(KeyCode::Char('p')),
        RustTuiKeybindingShortcut::CtrlO => ctrl(KeyCode::Char('o')),
        RustTuiKeybindingShortcut::CtrlT => ctrl(KeyCode::Char('t')),
        RustTuiKeybindingShortcut::AltUp => alt(KeyCode::Up),
        RustTuiKeybindingShortcut::ShiftLeft => shift(KeyCode::Left),
    }
}

fn shortcut_for_binding(binding: KeyBinding) -> RustTuiKeybindingShortcut {
    match (binding.key, binding.modifiers) {
        (KeyCode::Char('p'), crossterm::event::KeyModifiers::CONTROL) => {
            RustTuiKeybindingShortcut::CtrlP
        }
        (KeyCode::Char('o'), crossterm::event::KeyModifiers::CONTROL) => {
            RustTuiKeybindingShortcut::CtrlO
        }
        (KeyCode::Char('t'), crossterm::event::KeyModifiers::CONTROL) => {
            RustTuiKeybindingShortcut::CtrlT
        }
        (KeyCode::Up, crossterm::event::KeyModifiers::ALT) => RustTuiKeybindingShortcut::AltUp,
        (KeyCode::Left, crossterm::event::KeyModifiers::SHIFT) => {
            RustTuiKeybindingShortcut::ShiftLeft
        }
        _ => RustTuiKeybindingShortcut::AltUp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn uses_terminal_aware_default_queued_follow_up_binding() {
        assert_eq!(
            queued_follow_up_edit_binding_for_terminal_name("vscode", false),
            shift(KeyCode::Left)
        );
        assert_eq!(
            queued_follow_up_edit_binding_for_terminal_name("wezterm", false),
            alt(KeyCode::Up)
        );
    }

    #[test]
    fn loads_valid_rust_tui_keybinding_overrides() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("keybindings.json");
        fs::write(
            &path,
            r#"{
  "version": 1,
  "rustBindings": {
    "command-palette": "Ctrl+O",
    "file-search": "Ctrl+P",
    "toggle-tool-outputs": "Shift+Left",
    "edit-last-follow-up": "Ctrl+T"
  }
}"#,
        )
        .expect("write keybindings");

        let resolved = load_rust_tui_keybindings_from_path(Some(&path), "wezterm", false);

        assert_eq!(resolved.command_palette, ctrl(KeyCode::Char('o')));
        assert_eq!(resolved.file_search, ctrl(KeyCode::Char('p')));
        assert_eq!(resolved.toggle_tool_outputs, shift(KeyCode::Left));
        assert_eq!(
            resolved.edit_last_queued_follow_up,
            ctrl(KeyCode::Char('t'))
        );
    }

    #[test]
    fn resets_conflicting_partial_overrides_to_defaults() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("keybindings.json");
        fs::write(
            &path,
            r#"{
  "version": 1,
  "rustBindings": {
    "command-palette": "Ctrl+O"
  }
}"#,
        )
        .expect("write keybindings");

        let resolved = load_rust_tui_keybindings_from_path(Some(&path), "wezterm", false);

        assert_eq!(resolved.command_palette, ctrl(KeyCode::Char('p')));
        assert_eq!(resolved.file_search, ctrl(KeyCode::Char('o')));
    }
}

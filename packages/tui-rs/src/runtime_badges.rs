//! Runtime badges for the Rust TUI status bar.
//!
//! Mirrors the TypeScript TUI runtime badges for environment and safety hints.

use std::env;
use std::fs;
use std::path::Path;

use crate::safety::is_safe_mode_enabled;
use crate::sandbox::SANDBOX_ENV_VAR;
use crate::session::ThinkingLevel;
use crate::state::ApprovalMode;
use crate::terminal_info::{is_ssh_session, is_wsl};
use crate::tools::background_process_count;

pub struct RuntimeBadges {
    pub core: Vec<String>,
    pub env: Vec<String>,
}

pub struct RuntimeBadgeParams {
    pub approval_mode: ApprovalMode,
    pub thinking_level: ThinkingLevel,
    pub mcp_connected: usize,
    pub mcp_tool_count: usize,
    pub alert_count: usize,
}

pub fn build_runtime_badges(params: RuntimeBadgeParams) -> RuntimeBadges {
    let mut core = Vec::new();
    let mut env_badges = Vec::new();

    if is_safe_mode_enabled() {
        core.push("safe:on".to_string());
    }

    if env::var("COMPOSER_PLAN_MODE").ok().as_deref() == Some("1") {
        core.push("plan:on".to_string());
    }

    core.push(format!(
        "approvals:{}",
        approval_label(params.approval_mode)
    ));

    if let Ok(value) = env::var(SANDBOX_ENV_VAR) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            core.push(format!("sandbox:{trimmed}"));
        }
    }

    if params.alert_count > 0 {
        core.push(format!("alerts:{}", params.alert_count));
    }

    if let Some(label) = thinking_badge_label(params.thinking_level) {
        core.push(format!("think:{label}"));
    }

    if params.mcp_connected > 0 {
        core.push(format!(
            "mcp:{}({})",
            params.mcp_connected, params.mcp_tool_count
        ));
    }

    let background_count = background_process_count();
    if background_count > 0 {
        core.push(format!("bg:{background_count}"));
    }

    if is_podman_env() {
        env_badges.push("env:podman".to_string());
    } else if is_docker_env() {
        env_badges.push("env:docker".to_string());
    } else if is_wsl() {
        env_badges.push("env:wsl".to_string());
    }

    if is_ssh_session() {
        env_badges.push("env:ssh".to_string());
    }
    if is_flatpak_env() {
        env_badges.push("env:flatpak".to_string());
    }
    if is_bubblewrap_env() {
        env_badges.push("env:bwrap".to_string());
    }
    if is_musl_env() {
        env_badges.push("env:musl".to_string());
    }

    if is_tmux_env() {
        env_badges.push("term:tmux".to_string());
    } else if is_screen_env() {
        env_badges.push("term:screen".to_string());
    }

    if is_jetbrains_terminal() {
        env_badges.push("term:jetbrains".to_string());
    }

    RuntimeBadges {
        core,
        env: env_badges,
    }
}

fn approval_label(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Yolo => "yolo",
        ApprovalMode::Selective => "selective",
        ApprovalMode::Safe => "safe",
    }
}

fn thinking_badge_label(level: ThinkingLevel) -> Option<&'static str> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Minimal => Some("minimal"),
        ThinkingLevel::Low => Some("low"),
        ThinkingLevel::Medium => Some("medium"),
        ThinkingLevel::High => Some("high"),
        ThinkingLevel::Max => Some("max"),
    }
}

fn is_docker_env() -> bool {
    if env::var("DOCKER_CONTAINER").ok().as_deref() == Some("1") {
        return true;
    }
    if Path::new("/.dockerenv").exists() {
        return true;
    }
    if let Ok(contents) = fs::read_to_string("/proc/1/cgroup") {
        if contents.contains("docker") || contents.contains("kubepods") {
            return true;
        }
    }
    false
}

fn is_podman_env() -> bool {
    if env::var("CONTAINER_RUNTIME")
        .ok()
        .map(|value| value.to_lowercase())
        .as_deref()
        == Some("podman")
    {
        return true;
    }
    if env::var("CONTAINER")
        .ok()
        .map(|value| value.to_lowercase())
        .as_deref()
        == Some("podman")
    {
        return true;
    }
    if Path::new("/.containerenv").exists() {
        return true;
    }
    if let Ok(contents) = fs::read_to_string("/proc/1/cgroup") {
        if contents.contains("libpod") {
            return true;
        }
    }
    false
}

fn is_flatpak_env() -> bool {
    if env::var("FLATPAK_ID").is_ok() || env::var("FLATPAK_SANDBOX_DIR").is_ok() {
        return true;
    }
    Path::new("/.flatpak-info").exists()
}

fn is_bubblewrap_env() -> bool {
    env::var("BWRAP_ARGS")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn is_tmux_env() -> bool {
    env::var("TMUX").is_ok()
}

fn is_screen_env() -> bool {
    env::var("STY").is_ok()
}

fn is_jetbrains_terminal() -> bool {
    if let Ok(term) = env::var("TERMINAL_EMULATOR") {
        if term.to_lowercase().contains("jediterm") {
            return true;
        }
    }
    env::var("JEDITERM_LOG_DIR").is_ok()
}

fn is_musl_env() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    for dir in ["/lib", "/usr/lib", "/lib64", "/usr/lib64"] {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("ld-musl-") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

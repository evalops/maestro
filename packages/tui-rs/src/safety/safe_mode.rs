//! Safe mode guardrails (plan requirement + validators)
//!
//! Mirrors the TypeScript safe-mode gates at a minimal level:
//! - Require a plan before mutating operations (write/edit/bash/background tasks)
//! - Run configured validators after file mutations

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::lsp::{self, LspDiagnostic};
use crate::tools::resolve_shell_config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorResult {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone)]
struct SafeModeConfig {
    enabled: bool,
    require_plan: bool,
    validators: Vec<String>,
    lsp_blocking_severity: u8,
}

static PLAN_SATISFIED: AtomicBool = AtomicBool::new(false);

static SAFE_MODE_CONFIG: Lazy<Mutex<SafeModeConfig>> = Lazy::new(|| {
    let enabled = std::env::var("COMPOSER_SAFE_MODE").ok().as_deref() == Some("1");
    let require_plan = if !enabled {
        false
    } else {
        std::env::var("COMPOSER_SAFE_REQUIRE_PLAN").ok().as_deref() != Some("0")
    };
    let validators_raw = std::env::var("COMPOSER_SAFE_VALIDATORS").unwrap_or_default();
    let validators = validators_raw
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    let lsp_blocking_severity = std::env::var("COMPOSER_SAFE_LSP_SEVERITY")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .map(|value| value.clamp(1, 4))
        .unwrap_or_else(lsp::blocking_severity);

    Mutex::new(SafeModeConfig {
        enabled,
        require_plan,
        validators,
        lsp_blocking_severity,
    })
});

/// Mark plan requirement as satisfied/unsatisfied.
pub fn set_plan_satisfied(value: bool) {
    PLAN_SATISFIED.store(value, Ordering::Relaxed);
}

/// Return true if safe mode is enabled.
pub fn is_safe_mode_enabled() -> bool {
    SAFE_MODE_CONFIG
        .lock()
        .map(|cfg| cfg.enabled)
        .unwrap_or(false)
}

/// Enforce plan requirement for mutating tools.
pub fn require_plan(tool_name: &str) -> Result<(), String> {
    let cfg = SAFE_MODE_CONFIG
        .lock()
        .map_err(|_| "Safe mode config unavailable".to_string())?;

    if !cfg.enabled || !cfg.require_plan {
        return Ok(());
    }

    if PLAN_SATISFIED.load(Ordering::Relaxed) {
        return Ok(());
    }

    Err(format!(
        "Safe mode requires a plan before executing {}. Create or update a todo checklist first.",
        tool_name
    ))
}

/// Run validators configured via COMPOSER_SAFE_VALIDATORS.
pub async fn run_validators(paths: &[String]) -> Result<Vec<ValidatorResult>, String> {
    run_validators_with_diagnostics(paths, None).await
}

pub async fn run_validators_with_diagnostics(
    paths: &[String],
    lsp_diagnostics: Option<&HashMap<String, Vec<LspDiagnostic>>>,
) -> Result<Vec<ValidatorResult>, String> {
    let cfg = SAFE_MODE_CONFIG
        .lock()
        .map_err(|_| "Safe mode config unavailable".to_string())?
        .clone();

    if !cfg.enabled {
        return Ok(Vec::new());
    }

    if let Some(diagnostics) = lsp_diagnostics {
        let blocking = find_blocking_diagnostics(diagnostics, cfg.lsp_blocking_severity);
        if !blocking.is_empty() {
            let summary = blocking
                .into_iter()
                .map(|entry| {
                    format!(
                        "{}:{}:{} {}",
                        entry.file,
                        entry.line + 1,
                        entry.character + 1,
                        entry.message
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!(
                "LSP diagnostics blocked safe-mode validators:\n{}",
                summary
            ));
        }
    }

    if cfg.validators.is_empty() {
        return Ok(Vec::new());
    }

    let (shell, shell_args) = resolve_shell_config()
        .map_err(|e| format!("Failed to resolve shell for validators: {}", e))?;

    let mut results = Vec::new();
    for command in cfg.validators {
        let mut cmd = tokio::process::Command::new(&shell);
        cmd.args(&shell_args)
            .arg(command.clone())
            .env("COMPOSER_SAFE_CHANGED_PATHS", paths.join("::"));

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run validator '{}': {}", command, e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let exit_code = output.status.code().unwrap_or(-1);

        let result = ValidatorResult {
            command: command.clone(),
            stdout,
            stderr,
            exit_code,
        };

        if !output.status.success() {
            return Err(format!(
                "Validator failed ({}). Exit code: {}. Stderr: {}",
                command,
                exit_code,
                result.stderr.trim()
            ));
        }

        results.push(result);
    }

    Ok(results)
}

#[derive(Debug, Clone)]
struct BlockingDiagnostic {
    file: String,
    line: u32,
    character: u32,
    message: String,
}

fn find_blocking_diagnostics(
    diagnostics: &HashMap<String, Vec<LspDiagnostic>>,
    threshold: u8,
) -> Vec<BlockingDiagnostic> {
    let mut blocking = Vec::new();
    for (file, entries) in diagnostics {
        for diag in entries {
            let severity = diag.severity.unwrap_or(u8::MAX);
            if severity <= threshold {
                blocking.push(BlockingDiagnostic {
                    file: file.clone(),
                    line: diag.range.start.line,
                    character: diag.range.start.character,
                    message: diag.message.clone(),
                });
            }
        }
    }
    blocking
}

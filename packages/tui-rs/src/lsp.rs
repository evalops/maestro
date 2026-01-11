//! LSP diagnostics bridge
//!
//! Provides optional access to the TypeScript LSP CLI (`dist/lsp/cli.js`) so the
//! Rust TUI can surface diagnostics and enforce safe-mode gates.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspDiagnostic {
    pub severity: Option<u8>,
    pub message: String,
    pub range: LspRange,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone)]
struct LspConfig {
    enabled: bool,
    max_diagnostics_per_file: usize,
    blocking_severity: u8,
}

static LSP_CONFIG: std::sync::LazyLock<LspConfig> = std::sync::LazyLock::new(load_config);

fn load_config() -> LspConfig {
    let mut config = LspConfig {
        enabled: true,
        max_diagnostics_per_file: 10,
        blocking_severity: 1,
    };

    let Some(home) = dirs::home_dir() else {
        return config;
    };

    let path = home.join(".composer").join("config.json");
    let content = std::fs::read_to_string(path);
    let Ok(raw) = content else {
        return config;
    };

    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return config;
    };

    let Some(lsp) = value.get("lsp") else {
        return config;
    };

    if let Some(enabled) = lsp.get("enabled").and_then(serde_json::Value::as_bool) {
        config.enabled = enabled;
    }
    if let Some(max_diag) = lsp
        .get("maxDiagnosticsPerFile")
        .and_then(serde_json::Value::as_u64)
    {
        config.max_diagnostics_per_file = max_diag.max(1) as usize;
    }
    if let Some(severity) = lsp
        .get("blockingSeverity")
        .and_then(serde_json::Value::as_u64)
    {
        config.blocking_severity = severity.clamp(1, 4) as u8;
    }

    config
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value.to_lowercase().as_str() {
        "1" | "true" | "on" => Some(true),
        "0" | "false" | "off" => Some(false),
        _ => None,
    }
}

#[must_use]
pub fn is_lsp_enabled() -> bool {
    if let Ok(value) = std::env::var("COMPOSER_LSP_ENABLED") {
        if let Some(parsed) = parse_env_bool(&value) {
            return parsed;
        }
    }
    LSP_CONFIG.enabled
}

#[must_use]
pub fn max_diagnostics_per_file() -> usize {
    if let Ok(value) = std::env::var("COMPOSER_LSP_MAX_DIAGNOSTICS") {
        if let Ok(parsed) = value.parse::<usize>() {
            return parsed.max(1);
        }
    }
    LSP_CONFIG.max_diagnostics_per_file
}

#[must_use]
pub fn blocking_severity() -> u8 {
    if let Ok(value) = std::env::var("COMPOSER_SAFE_LSP_SEVERITY") {
        if let Ok(parsed) = value.parse::<u8>() {
            return parsed.clamp(1, 4);
        }
    }
    LSP_CONFIG.blocking_severity
}

fn resolve_cli_path(cwd: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("COMPOSER_LSP_CLI") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    let mut roots = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots.push(cwd.to_path_buf());

    for root in roots {
        let mut cursor = Some(root.as_path());
        for _ in 0..10 {
            if let Some(path) = cursor {
                let direct = path.join("dist").join("lsp").join("cli.js");
                if direct.exists() {
                    return Some(direct);
                }
                let node_modules = path
                    .join("node_modules")
                    .join("@evalops")
                    .join("composer")
                    .join("dist")
                    .join("lsp")
                    .join("cli.js");
                if node_modules.exists() {
                    return Some(node_modules);
                }
                cursor = path.parent();
            } else {
                break;
            }
        }
    }

    None
}

fn resolve_runtime() -> String {
    std::env::var("COMPOSER_LSP_RUNTIME").unwrap_or_else(|_| "node".to_string())
}

fn normalize_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    std::fs::canonicalize(&path).unwrap_or(path)
}

async fn run_cli_diagnostics(
    cwd: &Path,
    path: &Path,
) -> Result<HashMap<String, Vec<LspDiagnostic>>, String> {
    let Some(cli_path) = resolve_cli_path(cwd) else {
        return Ok(HashMap::new());
    };

    let runtime = resolve_runtime();
    let output = Command::new(runtime)
        .arg(cli_path)
        .arg("diagnostics")
        .arg(path)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run LSP diagnostics: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "LSP diagnostics command failed (status {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let map: HashMap<String, Vec<LspDiagnostic>> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse LSP diagnostics: {e}"))?;
    Ok(map)
}

pub async fn collect_diagnostics_for_paths(
    cwd: &str,
    paths: &[String],
) -> Result<HashMap<String, Vec<LspDiagnostic>>, String> {
    if !is_lsp_enabled() || paths.is_empty() {
        return Ok(HashMap::new());
    }

    let cwd_path = Path::new(cwd);
    let mut combined: HashMap<String, Vec<LspDiagnostic>> = HashMap::new();
    let mut seen = HashSet::new();

    for raw in paths {
        let normalized = normalize_path(cwd_path, raw);
        if !seen.insert(normalized.clone()) {
            continue;
        }
        let map = run_cli_diagnostics(cwd_path, &normalized).await?;
        for (file, diagnostics) in map {
            combined.entry(file).or_default().extend(diagnostics);
        }
    }

    Ok(combined)
}

pub async fn diagnostics_for_file(cwd: &str, path: &str) -> Result<Vec<LspDiagnostic>, String> {
    if !is_lsp_enabled() {
        return Ok(Vec::new());
    }

    let cwd_path = Path::new(cwd);
    let normalized = normalize_path(cwd_path, path);
    let map = run_cli_diagnostics(cwd_path, &normalized).await?;

    if let Some(entries) = map.get(&normalized.to_string_lossy().to_string()) {
        return Ok(entries.clone());
    }

    if let Some(entries) = map.get(path) {
        return Ok(entries.clone());
    }

    Ok(Vec::new())
}

#[must_use]
pub fn format_lsp_summary(path: &str, diagnostics: &[LspDiagnostic]) -> String {
    if diagnostics.is_empty() {
        return String::new();
    }

    let mut lines = Vec::new();
    lines.push(format!("\nLinter check for {path}:"));

    let top = diagnostics.iter().take(5);
    for diag in top {
        let line = diag.range.start.line + 1;
        let severity = match diag.severity.unwrap_or(2) {
            1 => "Error",
            2 => "Warning",
            3 => "Info",
            4 => "Hint",
            _ => "Warning",
        };
        lines.push(format!("  [{}] Line {}: {}", severity, line, diag.message));
    }

    if diagnostics.len() > 5 {
        lines.push(format!("  ...and {} more.", diagnostics.len() - 5));
    }

    lines.join("\n")
}

#[must_use]
pub fn sanitize_diagnostic_message(raw: &str) -> String {
    let mut cleaned = String::new();
    for ch in raw.chars() {
        if ch == '`' || ch == '\n' || ch == '\r' {
            cleaned.push(' ');
            continue;
        }
        if ch.is_control() {
            continue;
        }
        cleaned.push(ch);
        if cleaned.len() >= 500 {
            break;
        }
    }
    cleaned
}

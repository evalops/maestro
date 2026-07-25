//! LSP diagnostics bridge
//!
//! Speaks Language Server Protocol JSON-RPC directly over stdio so the native
//! runtime can surface diagnostics and enforce safe-mode gates without a bridge.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

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
pub struct LspLocation {
    pub uri: String,
    pub range: LspRange,
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
    if let Ok(value) = std::env::var("MAESTRO_LSP_ENABLED") {
        if let Some(parsed) = parse_env_bool(&value) {
            return parsed;
        }
    }
    LSP_CONFIG.enabled
}

#[must_use]
pub fn max_diagnostics_per_file() -> usize {
    if let Ok(value) = std::env::var("MAESTRO_LSP_MAX_DIAGNOSTICS") {
        if let Ok(parsed) = value.parse::<usize>() {
            return parsed.max(1);
        }
    }
    LSP_CONFIG.max_diagnostics_per_file
}

#[must_use]
pub fn blocking_severity() -> u8 {
    if let Ok(value) = std::env::var("MAESTRO_SAFE_LSP_SEVERITY") {
        if let Ok(parsed) = value.parse::<u8>() {
            return parsed.clamp(1, 4);
        }
    }
    LSP_CONFIG.blocking_severity
}

fn normalize_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    dunce::canonicalize(&path).unwrap_or(path)
}

#[derive(Debug, Clone)]
struct NativeServerSpec {
    command: String,
    args: Vec<String>,
    language_id: &'static str,
}

fn native_server_for_path(path: &Path) -> Result<NativeServerSpec, String> {
    if let Ok(value) = std::env::var("MAESTRO_LSP_COMMAND") {
        let parts = shlex::split(&value)
            .ok_or_else(|| "MAESTRO_LSP_COMMAND contains invalid shell quoting".to_string())?;
        let (command, args) = parts
            .split_first()
            .ok_or_else(|| "MAESTRO_LSP_COMMAND is empty".to_string())?;
        return Ok(NativeServerSpec {
            command: command.clone(),
            args: args.to_vec(),
            language_id: language_id(path),
        });
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let (command, args) = match extension {
        "rs" => ("rust-analyzer", vec![]),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            ("typescript-language-server", vec!["--stdio"])
        }
        "py" | "pyi" => ("pyright-langserver", vec!["--stdio"]),
        "go" => ("gopls", vec![]),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" => ("clangd", vec![]),
        "java" => ("jdtls", vec![]),
        _ => {
            return Err(format!(
                "no native language server configured for {}",
                path.display()
            ))
        }
    };
    Ok(NativeServerSpec {
        command: command.to_string(),
        args: args.into_iter().map(str::to_string).collect(),
        language_id: language_id(path),
    })
}

fn language_id(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "py" | "pyi" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "java" => "java",
        _ => "plaintext",
    }
}

struct NativeLspSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl NativeLspSession {
    async fn start(cwd: &Path, path: &Path) -> Result<(Self, String), String> {
        let spec = native_server_for_path(path)?;
        let mut child = Command::new(&spec.command)
            .args(&spec.args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to start native LSP server {}: {error}",
                    spec.command
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "LSP stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "LSP stdout unavailable".to_string())?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        let root_uri = path_to_uri(cwd)?;
        session
            .request(
                "initialize",
                serde_json::json!({
                    "processId": std::process::id(),
                    "rootUri": root_uri,
                    "capabilities": {
                        "textDocument": { "publishDiagnostics": { "relatedInformation": true } }
                    },
                    "clientInfo": { "name": "maestro", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await?;
        session.notify("initialized", serde_json::json!({})).await?;
        let uri = path_to_uri(path)?;
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| format!("failed to read LSP document {}: {error}", path.display()))?;
        session
            .notify(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": spec.language_id,
                        "version": 1,
                        "text": text
                    }
                }),
            )
            .await?;
        Ok((session, uri))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        loop {
            let message = self.read().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
            {
                if let Some(error) = message.get("error") {
                    return Err(format!("LSP {method} request failed: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            self.respond_to_server_request(&message).await?;
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn next_notification(&mut self) -> Result<Value, String> {
        loop {
            let message = self.read().await?;
            if message.get("method").is_some() && message.get("id").is_none() {
                return Ok(message);
            }
            self.respond_to_server_request(&message).await?;
        }
    }

    async fn respond_to_server_request(&mut self, message: &Value) -> Result<(), String> {
        if message.get("method").is_some() {
            if let Some(id) = message.get("id") {
                self.write(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": Value::Null
                }))
                .await?;
            }
        }
        Ok(())
    }

    async fn write(&mut self, message: &Value) -> Result<(), String> {
        let payload = serde_json::to_vec(message)
            .map_err(|error| format!("failed to serialize LSP message: {error}"))?;
        self.stdin
            .write_all(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes())
            .await
            .map_err(|error| format!("failed to write LSP message: {error}"))?;
        self.stdin
            .write_all(&payload)
            .await
            .map_err(|error| format!("failed to write LSP payload: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush LSP message: {error}"))
    }

    async fn read(&mut self) -> Result<Value, String> {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            let count = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|error| format!("failed to read LSP header: {error}"))?;
            if count == 0 {
                return Err("native LSP server closed stdout".to_string());
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = Some(
                        value
                            .trim()
                            .parse::<usize>()
                            .map_err(|error| format!("invalid LSP content length: {error}"))?,
                    );
                }
            }
        }
        let length =
            content_length.ok_or_else(|| "LSP message omitted Content-Length".to_string())?;
        let mut payload = vec![0_u8; length];
        self.stdout
            .read_exact(&mut payload)
            .await
            .map_err(|error| format!("failed to read LSP payload: {error}"))?;
        serde_json::from_slice(&payload).map_err(|error| format!("invalid LSP JSON: {error}"))
    }

    async fn stop(mut self) {
        let _ = self.notify("exit", Value::Null).await;
        let _ = self.child.kill().await;
    }
}

fn path_to_uri(path: &Path) -> Result<String, String> {
    url::Url::from_file_path(path)
        .map(String::from)
        .map_err(|()| format!("cannot convert path to file URI: {}", path.display()))
}

async fn native_diagnostics(cwd: &Path, path: &Path) -> Result<Vec<LspDiagnostic>, String> {
    let (mut session, uri) = NativeLspSession::start(cwd, path).await?;
    let diagnostics = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let message = session.next_notification().await?;
            if message.get("method").and_then(Value::as_str)
                != Some("textDocument/publishDiagnostics")
            {
                continue;
            }
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if params.get("uri").and_then(Value::as_str) != Some(uri.as_str()) {
                continue;
            }
            return serde_json::from_value::<Vec<LspDiagnostic>>(
                params
                    .get("diagnostics")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([])),
            )
            .map_err(|error| format!("invalid LSP diagnostics: {error}"));
        }
    })
    .await
    .unwrap_or(Ok(Vec::new()));
    session.stop().await;
    diagnostics
}

async fn native_locations(
    cwd: &Path,
    method: &str,
    path: &Path,
    line: u32,
    character: u32,
    include_declaration: Option<bool>,
) -> Result<Vec<LspLocation>, String> {
    let (mut session, uri) = NativeLspSession::start(cwd, path).await?;
    let mut params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character }
    });
    if let Some(include_declaration) = include_declaration {
        params["context"] = serde_json::json!({ "includeDeclaration": include_declaration });
    }
    let result = session.request(method, params).await;
    session.stop().await;
    normalize_locations(result?)
}

fn normalize_locations(result: Value) -> Result<Vec<LspLocation>, String> {
    let values = if result.is_null() {
        Vec::new()
    } else if let Some(values) = result.as_array() {
        values.clone()
    } else {
        vec![result]
    };
    values
        .into_iter()
        .filter_map(|value| {
            if value.get("targetUri").is_some() {
                Some(serde_json::json!({
                    "uri": value.get("targetUri"),
                    "range": value.get("targetRange")
                }))
            } else if value.get("uri").is_some() {
                Some(value)
            } else {
                None
            }
        })
        .map(|value| {
            serde_json::from_value(value).map_err(|error| format!("invalid LSP location: {error}"))
        })
        .collect()
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
        let diagnostics = native_diagnostics(cwd_path, &normalized).await?;
        combined
            .entry(normalized.to_string_lossy().into_owned())
            .or_default()
            .extend(diagnostics);
    }

    Ok(combined)
}

pub async fn collect_workspace_diagnostics(
    cwd: &str,
) -> Result<HashMap<String, Vec<LspDiagnostic>>, String> {
    if !is_lsp_enabled() {
        return Ok(HashMap::new());
    }

    let cwd_path = Path::new(cwd);
    let files = crate::files::get_workspace_files(cwd_path, 200)
        .into_iter()
        .map(|file| cwd_path.join(file.relative_path))
        .filter(|path| native_server_for_path(path).is_ok())
        .collect::<Vec<_>>();
    let paths = files
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    collect_diagnostics_for_paths(cwd, &paths).await
}

pub async fn diagnostics_for_file(cwd: &str, path: &str) -> Result<Vec<LspDiagnostic>, String> {
    if !is_lsp_enabled() {
        return Ok(Vec::new());
    }

    let cwd_path = Path::new(cwd);
    let normalized = normalize_path(cwd_path, path);
    native_diagnostics(cwd_path, &normalized).await
}

pub async fn definition_for_position(
    cwd: &str,
    path: &str,
    line: u32,
    character: u32,
) -> Result<Vec<LspLocation>, String> {
    if !is_lsp_enabled() {
        return Ok(Vec::new());
    }

    let cwd_path = Path::new(cwd);
    let normalized = normalize_path(cwd_path, path);
    native_locations(
        cwd_path,
        "textDocument/definition",
        &normalized,
        line,
        character,
        None,
    )
    .await
}

pub async fn references_for_position(
    cwd: &str,
    path: &str,
    line: u32,
    character: u32,
    include_declaration: bool,
) -> Result<Vec<LspLocation>, String> {
    if !is_lsp_enabled() {
        return Ok(Vec::new());
    }

    let cwd_path = Path::new(cwd);
    let normalized = normalize_path(cwd_path, path);
    native_locations(
        cwd_path,
        "textDocument/references",
        &normalized,
        line,
        character,
        Some(include_declaration),
    )
    .await
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

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // parse_env_bool Tests
    // ========================================================================

    #[test]
    fn test_parse_env_bool_true_values() {
        assert_eq!(parse_env_bool("1"), Some(true));
        assert_eq!(parse_env_bool("true"), Some(true));
        assert_eq!(parse_env_bool("TRUE"), Some(true));
        assert_eq!(parse_env_bool("on"), Some(true));
        assert_eq!(parse_env_bool("ON"), Some(true));
    }

    #[test]
    fn test_parse_env_bool_false_values() {
        assert_eq!(parse_env_bool("0"), Some(false));
        assert_eq!(parse_env_bool("false"), Some(false));
        assert_eq!(parse_env_bool("FALSE"), Some(false));
        assert_eq!(parse_env_bool("off"), Some(false));
        assert_eq!(parse_env_bool("OFF"), Some(false));
    }

    #[test]
    fn test_parse_env_bool_invalid_values() {
        assert_eq!(parse_env_bool(""), None);
        assert_eq!(parse_env_bool("yes"), None);
        assert_eq!(parse_env_bool("no"), None);
        assert_eq!(parse_env_bool("2"), None);
        assert_eq!(parse_env_bool("random"), None);
    }

    // ========================================================================
    // LspPosition Tests
    // ========================================================================

    #[test]
    fn test_lsp_position_serialization() {
        let pos = LspPosition {
            line: 10,
            character: 5,
        };
        let json = serde_json::to_value(&pos).unwrap();
        assert_eq!(json["line"], 10);
        assert_eq!(json["character"], 5);
    }

    #[test]
    fn test_lsp_position_deserialization() {
        let json = r#"{"line": 15, "character": 20}"#;
        let pos: LspPosition = serde_json::from_str(json).unwrap();
        assert_eq!(pos.line, 15);
        assert_eq!(pos.character, 20);
    }

    // ========================================================================
    // LspRange Tests
    // ========================================================================

    #[test]
    fn test_lsp_range_serialization() {
        let range = LspRange {
            start: LspPosition {
                line: 1,
                character: 0,
            },
            end: LspPosition {
                line: 1,
                character: 10,
            },
        };
        let json = serde_json::to_value(&range).unwrap();
        assert_eq!(json["start"]["line"], 1);
        assert_eq!(json["end"]["character"], 10);
    }

    // ========================================================================
    // LspDiagnostic Tests
    // ========================================================================

    #[test]
    fn test_lsp_diagnostic_serialization() {
        let diag = LspDiagnostic {
            severity: Some(1),
            message: "Error message".to_string(),
            range: LspRange {
                start: LspPosition {
                    line: 5,
                    character: 0,
                },
                end: LspPosition {
                    line: 5,
                    character: 10,
                },
            },
            source: Some("eslint".to_string()),
        };
        let json = serde_json::to_value(&diag).unwrap();
        assert_eq!(json["severity"], 1);
        assert_eq!(json["message"], "Error message");
        assert_eq!(json["source"], "eslint");
    }

    #[test]
    fn test_lsp_diagnostic_deserialization_minimal() {
        let json = r#"{
            "message": "Test",
            "range": {
                "start": {"line": 0, "character": 0},
                "end": {"line": 0, "character": 5}
            }
        }"#;
        let diag: LspDiagnostic = serde_json::from_str(json).unwrap();
        assert_eq!(diag.message, "Test");
        assert!(diag.severity.is_none());
        assert!(diag.source.is_none());
    }

    // ========================================================================
    // format_lsp_summary Tests
    // ========================================================================

    #[test]
    fn test_format_lsp_summary_empty() {
        let summary = format_lsp_summary("test.rs", &[]);
        assert!(summary.is_empty());
    }

    #[test]
    fn test_format_lsp_summary_single_error() {
        let diagnostics = vec![LspDiagnostic {
            severity: Some(1),
            message: "Undefined variable".to_string(),
            range: LspRange {
                start: LspPosition {
                    line: 4,
                    character: 0,
                },
                end: LspPosition {
                    line: 4,
                    character: 10,
                },
            },
            source: None,
        }];
        let summary = format_lsp_summary("test.rs", &diagnostics);
        assert!(summary.contains("test.rs"));
        assert!(summary.contains("[Error]"));
        assert!(summary.contains("Line 5")); // 0-indexed + 1
        assert!(summary.contains("Undefined variable"));
    }

    #[test]
    fn test_format_lsp_summary_multiple_severities() {
        let diagnostics = vec![
            LspDiagnostic {
                severity: Some(2),
                message: "Warning message".to_string(),
                range: LspRange {
                    start: LspPosition {
                        line: 0,
                        character: 0,
                    },
                    end: LspPosition {
                        line: 0,
                        character: 5,
                    },
                },
                source: None,
            },
            LspDiagnostic {
                severity: Some(3),
                message: "Info message".to_string(),
                range: LspRange {
                    start: LspPosition {
                        line: 1,
                        character: 0,
                    },
                    end: LspPosition {
                        line: 1,
                        character: 5,
                    },
                },
                source: None,
            },
            LspDiagnostic {
                severity: Some(4),
                message: "Hint message".to_string(),
                range: LspRange {
                    start: LspPosition {
                        line: 2,
                        character: 0,
                    },
                    end: LspPosition {
                        line: 2,
                        character: 5,
                    },
                },
                source: None,
            },
        ];
        let summary = format_lsp_summary("test.rs", &diagnostics);
        assert!(summary.contains("[Warning]"));
        assert!(summary.contains("[Info]"));
        assert!(summary.contains("[Hint]"));
    }

    #[test]
    fn test_format_lsp_summary_more_than_five() {
        let diagnostics: Vec<LspDiagnostic> = (0..10)
            .map(|i| LspDiagnostic {
                severity: Some(2),
                message: format!("Warning {i}"),
                range: LspRange {
                    start: LspPosition {
                        line: i,
                        character: 0,
                    },
                    end: LspPosition {
                        line: i,
                        character: 5,
                    },
                },
                source: None,
            })
            .collect();
        let summary = format_lsp_summary("test.rs", &diagnostics);
        assert!(summary.contains("...and 5 more"));
    }

    // ========================================================================
    // sanitize_diagnostic_message Tests
    // ========================================================================

    #[test]
    fn test_sanitize_diagnostic_message_clean() {
        let message = "This is a clean message";
        assert_eq!(sanitize_diagnostic_message(message), message);
    }

    #[test]
    fn test_sanitize_diagnostic_message_backticks() {
        let message = "Use `const` instead of `let`";
        let sanitized = sanitize_diagnostic_message(message);
        assert!(!sanitized.contains('`'));
        assert!(sanitized.contains("const"));
    }

    #[test]
    fn test_sanitize_diagnostic_message_newlines() {
        let message = "Line 1\nLine 2\rLine 3";
        let sanitized = sanitize_diagnostic_message(message);
        assert!(!sanitized.contains('\n'));
        assert!(!sanitized.contains('\r'));
        assert!(sanitized.contains("Line 1"));
    }

    #[test]
    fn test_sanitize_diagnostic_message_control_chars() {
        let message = "Message with \x00 null and \x1b escape";
        let sanitized = sanitize_diagnostic_message(message);
        assert!(!sanitized.contains('\x00'));
        assert!(!sanitized.contains('\x1b'));
    }

    #[test]
    fn test_sanitize_diagnostic_message_truncation() {
        let long_message = "a".repeat(1000);
        let sanitized = sanitize_diagnostic_message(&long_message);
        assert_eq!(sanitized.len(), 500);
    }

    // ========================================================================
    // normalize_path Tests
    // ========================================================================

    #[test]
    fn test_normalize_path_absolute() {
        let cwd = Path::new("/home/user");
        let result = normalize_path(cwd, "/tmp/test.rs");
        assert_eq!(result, PathBuf::from("/tmp/test.rs"));
    }

    #[test]
    fn test_normalize_path_relative() {
        let cwd = Path::new("/home/user");
        let result = normalize_path(cwd, "src/main.rs");
        // Should join with cwd
        assert!(result.to_string_lossy().contains("src/main.rs"));
    }
}

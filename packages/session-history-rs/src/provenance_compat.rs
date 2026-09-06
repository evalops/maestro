use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const MAX_INSTRUCTION_CHARS: usize = 8_192;
const MAX_EVENT_CHARS: usize = 2_048;

pub(crate) fn touch_hook_session(
    repo: &Path,
    agent_session_id: &str,
    runner_session_id: &str,
    agent: &str,
    model: Option<&str>,
    instruction: Option<&str>,
) -> std::io::Result<PathBuf> {
    let path = evalops_git_dir(repo)?.join("session.json");
    let mut session = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .filter(|session| {
            session.get("runner_session_id").and_then(Value::as_str) == Some(runner_session_id)
        })
        .unwrap_or_default();

    session.insert(
        "session_id".to_string(),
        Value::String(agent_session_id.to_string()),
    );
    session.insert(
        "runner_session_id".to_string(),
        Value::String(runner_session_id.to_string()),
    );
    session.insert("agent".to_string(), Value::String(agent.to_string()));
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        session.insert("model".to_string(), Value::String(model.to_string()));
    }
    let instruction = instruction
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            session
                .get("instruction")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if let Some(instruction) = instruction {
        session.insert(
            "instruction_digest".to_string(),
            Value::String(format!(
                "sha256:{:x}",
                Sha256::digest(instruction.as_bytes())
            )),
        );
        let include_instruction = session
            .get("include_instruction")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || include_instruction_from_env();
        if include_instruction {
            session.insert(
                "instruction".to_string(),
                Value::String(truncate(
                    &redact_text(&instruction, repo),
                    MAX_INSTRUCTION_CHARS,
                )),
            );
            session.insert("include_instruction".to_string(), Value::Bool(true));
        } else {
            session.remove("instruction");
        }
    }
    if let Some(events) = session.remove("events") {
        session.insert("events".to_string(), redact_value(events, repo));
    }
    session.insert("hook_managed".to_string(), Value::Bool(true));
    session.insert("owner_pid".to_string(), Value::Null);
    let canonical = dunce::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    if session.get("worktree_id").and_then(Value::as_str).is_none() {
        session.insert(
            "worktree_id".to_string(),
            Value::String(format!(
                "sha256:{:x}",
                Sha256::digest(canonical.display().to_string().as_bytes())
            )),
        );
    }
    let now_value = chrono::Utc::now();
    let now = now_value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    if session.get("started_at").and_then(Value::as_str).is_none() {
        session.insert("started_at".to_string(), Value::String(now.clone()));
    }
    session.insert("heartbeat_at".to_string(), Value::String(now));
    session.insert(
        "expires_at".to_string(),
        Value::String(
            (now_value + chrono::Duration::hours(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ),
    );

    write_private_json(&path, &Value::Object(session))?;
    Ok(path)
}

pub(crate) fn clear_hook_session(repo: &Path, runner_session_id: &str) -> std::io::Result<bool> {
    let path = evalops_git_dir(repo)?.join("session.json");
    let Some(session) = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Ok(false);
    };
    if session.get("hook_managed").and_then(Value::as_bool) != Some(true)
        || session.get("runner_session_id").and_then(Value::as_str) != Some(runner_session_id)
    {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn evalops_git_dir(repo: &Path) -> std::io::Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .current_dir(repo)
        .env_remove("GIT_INDEX_FILE")
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "workspace is not a Git repository",
        ));
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let evalops = path.join("evalops");
    fs::create_dir_all(&evalops)?;
    Ok(evalops)
}

fn write_private_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

pub(crate) fn redact_text(input: &str, repo: &Path) -> String {
    let mut text = input.to_string();
    for pattern in builtin_patterns()
        .into_iter()
        .chain(custom_patterns(repo).unwrap_or_default())
    {
        text = replace_pattern(&text, &pattern);
    }
    redact_high_entropy_tokens(&strip_env_and_headers(&text))
}

fn redact_high_entropy_tokens(input: &str) -> String {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let token = TOKEN.get_or_init(|| {
        Regex::new(r"[A-Za-z0-9+/_-]{32,}={0,2}").expect("high-entropy token regex is valid")
    });
    token
        .replace_all(input, |capture: &regex::Captures<'_>| {
            let candidate = capture.get(0).map_or("", |value| value.as_str());
            if shannon_entropy(candidate) >= 4.5 {
                "[redacted]".to_string()
            } else {
                candidate.to_string()
            }
        })
        .into_owned()
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = [0_u32; 128];
    let mut length = 0_u32;
    for byte in value.bytes().filter(|byte| byte.is_ascii()) {
        counts[byte as usize] += 1;
        length += 1;
    }
    if length == 0 {
        return 0.0;
    }
    counts
        .into_iter()
        .filter(|count| *count > 0)
        .map(|count| {
            let probability = f64::from(count) / f64::from(length);
            -probability * probability.log2()
        })
        .sum()
}

fn builtin_patterns() -> Vec<String> {
    vec![
        r"ghp_[A-Za-z0-9]{20,}".to_string(),
        r"github_pat_[A-Za-z0-9_]{20,}".to_string(),
        r"glpat-[A-Za-z0-9_-]{20,}".to_string(),
        r"sk-[A-Za-z0-9]{20,}".to_string(),
        r"AKIA[0-9A-Z]{16}".to_string(),
        r#"(?i)\bbearer\s+[^\s"']+"#.to_string(),
        r"(?im)^\s*authorization:\s*\S.*$".to_string(),
        r"xox[baprs]-[A-Za-z0-9-]{10,}".to_string(),
        r"(?i)\bpassword\s*[:=]\s*\S+".to_string(),
        r"(?i)\b(?:api[_-]?key|secret[_-]?key)\s*[:=]\s*\S+".to_string(),
        r"-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----".to_string(),
    ]
}

fn custom_patterns(repo: &Path) -> std::io::Result<Vec<String>> {
    let path = repo.join(".evalops/redaction-patterns");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut patterns = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            patterns.push(trimmed.to_string());
        }
    }
    Ok(patterns)
}

fn replace_pattern(input: &str, pattern: &str) -> String {
    if pattern.is_empty() {
        return input.to_string();
    }
    match Regex::new(pattern) {
        Ok(regex) => regex.replace_all(input, "[redacted]").into_owned(),
        Err(_) => "[redacted]".to_string(),
    }
}

fn redact_value(value: Value, repo: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(truncate(&redact_text(&text, repo), MAX_EVENT_CHARS)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| redact_value(item, repo))
                .collect(),
        ),
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in map {
                let lowered = key.to_ascii_lowercase();
                if matches!(
                    lowered.as_str(),
                    "env"
                        | "environment"
                        | "environ"
                        | "headers"
                        | "authorization"
                        | "cookie"
                        | "set-cookie"
                        | "api_key"
                        | "apikey"
                        | "secret"
                        | "password"
                        | "token"
                        | "stdout"
                        | "stderr"
                        | "output"
                        | "raw"
                        | "raw_output"
                ) {
                    redacted.insert(key, Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key, redact_value(child, repo));
                }
            }
            Value::Object(redacted)
        }
        other => other,
    }
}

fn include_instruction_from_env() -> bool {
    matches!(
        std::env::var("EVALOPS_PROVENANCE_INCLUDE_INSTRUCTION")
            .ok()
            .as_deref(),
        Some("1" | "true" | "yes")
    )
}

fn truncate(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let clipped: String = input.chars().take(max.saturating_sub(16)).collect();
    format!("{clipped}…[truncated]")
}

fn strip_env_and_headers(input: &str) -> String {
    input
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.contains("authorization:")
                && !lower.starts_with("cookie:")
                && !lower.contains("_token=")
                && !lower.contains("_secret=")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_lease_preserves_context_and_redacts_opted_in_content() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(directory.path())
            .status()
            .expect("git init");
        assert!(initialized.success());

        let evalops = directory.path().join(".git/evalops");
        fs::create_dir_all(&evalops).expect("evalops directory");
        let path = evalops.join("session.json");
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "runner_session_id": "runner-1",
                "work_id": "work-1",
                "include_instruction": true,
                "events": [{
                    "token": "must-not-survive",
                    "message": "ghp_012345678901234567890123456789"
                }]
            }))
            .expect("session json"),
        )
        .expect("seed session");

        touch_hook_session(
            directory.path(),
            "agent-session-1",
            "runner-1",
            "codex",
            Some("gpt-test"),
            Some("use ghp_012345678901234567890123456789"),
        )
        .expect("touch lease");

        let session: Value =
            serde_json::from_slice(&fs::read(&path).expect("lease")).expect("valid session json");
        assert_eq!(session["work_id"], "work-1");
        assert_eq!(session["events"][0]["token"], "[redacted]");
        assert_eq!(session["events"][0]["message"], "[redacted]");
        assert_eq!(session["instruction"], "use [redacted]");
        assert!(
            session["instruction_digest"]
                .as_str()
                .is_some_and(|digest| digest.starts_with("sha256:"))
        );
        assert!(!clear_hook_session(directory.path(), "runner-2").expect("foreign clear"));
        assert!(clear_hook_session(directory.path(), "runner-1").expect("owned clear"));
        assert!(!path.exists());
    }
}

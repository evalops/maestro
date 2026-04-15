//! Git status tool helper.
//!
//! This module provides a wrapper around `git status --porcelain=v2` that parses
//! the output into structured data. It extracts:
//!
//! - Branch information (head, upstream, ahead/behind counts)
//! - File counts (modified, added, deleted, untracked, ignored)
//!
//! # Options
//!
//! - `branch_summary` - Include branch information (default: true)
//! - `include_ignored` - Include ignored files in the count (default: false)
//! - `paths` - Filter to specific paths (optional)

use serde::Deserialize;
use serde_json::Value;

use crate::agent::ToolResult;

#[derive(Debug, Deserialize)]
struct StatusArgs {
    #[serde(default, alias = "branchSummary")]
    branch_summary: Option<bool>,
    #[serde(default, alias = "includeIgnored")]
    include_ignored: Option<bool>,
    #[serde(default)]
    paths: Option<Value>,
}

fn normalize_paths(paths: Option<Value>) -> Vec<String> {
    match paths {
        None => Vec::new(),
        Some(Value::String(s)) => vec![s],
        Some(Value::Array(values)) => values
            .into_iter()
            .filter_map(|v| v.as_str().map(std::string::ToString::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

pub async fn git_status(args: Value, cwd: &str) -> ToolResult {
    let parsed: StatusArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid status arguments: {err}")),
    };

    let branch_summary = parsed.branch_summary.unwrap_or(true);
    let include_ignored = parsed.include_ignored.unwrap_or(false);
    let paths = normalize_paths(parsed.paths);

    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("status").arg("--porcelain=v2").arg("-z");
    if branch_summary {
        cmd.arg("-b");
    }
    if include_ignored {
        cmd.arg("--ignored=matching");
    }
    if !paths.is_empty() {
        cmd.arg("--");
        cmd.args(&paths);
    }
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let output = match cmd.output().await {
        Ok(out) => out,
        Err(err) => return ToolResult::failure(format!("Failed to run git status: {err}")),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return ToolResult::failure(if stderr.is_empty() {
            "git status exited with a non-zero status".to_string()
        } else {
            stderr
        });
    }

    let stdout = output.stdout;
    let parts: Vec<&[u8]> = stdout.split(|b| *b == b'\0').collect();
    let mut file_count = 0;
    let mut branch_head = None;
    let mut branch_upstream = None;
    let mut ahead = None;
    let mut behind = None;

    for part in parts {
        if part.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(part);
        if line.starts_with("# branch.head ") {
            branch_head = Some(line.trim_start_matches("# branch.head ").trim().to_string());
        } else if line.starts_with("# branch.upstream ") {
            branch_upstream = Some(
                line.trim_start_matches("# branch.upstream ")
                    .trim()
                    .to_string(),
            );
        } else if line.starts_with("# branch.ab ") {
            let remainder = line.trim_start_matches("# branch.ab ").trim();
            for token in remainder.split_whitespace() {
                if let Some(val) = token.strip_prefix('+') {
                    ahead = val.parse::<u64>().ok();
                } else if let Some(val) = token.strip_prefix('-') {
                    behind = val.parse::<u64>().ok();
                }
            }
        } else if line.starts_with('1')
            || line.starts_with('2')
            || line.starts_with('u')
            || line.starts_with('?')
            || line.starts_with('!')
        {
            file_count += 1;
        }
    }

    let mut summary_lines = Vec::new();
    if branch_summary {
        let mut branch_line = format!(
            "Branch: {}",
            branch_head
                .clone()
                .unwrap_or_else(|| "(detached)".to_string())
        );
        if let Some(upstream) = &branch_upstream {
            branch_line.push_str(&format!(" -> {upstream}"));
        }
        if ahead.is_some() || behind.is_some() {
            branch_line.push_str(&format!(
                " (ahead {}, behind {})",
                ahead.unwrap_or(0),
                behind.unwrap_or(0)
            ));
        }
        summary_lines.push(branch_line);
    }
    summary_lines.push(format!("Files: {file_count}"));

    let details = serde_json::json!({
        "command": "git status --porcelain=v2 -z",
        "branch": {
            "head": branch_head,
            "upstream": branch_upstream,
            "ahead": ahead,
            "behind": behind
        },
        "files": file_count
    });

    ToolResult::success(summary_lines.join("\n")).with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // StatusArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_args_deserialize_empty() {
        let json = serde_json::json!({});
        let args: StatusArgs = serde_json::from_value(json).unwrap();
        assert!(args.branch_summary.is_none());
        assert!(args.include_ignored.is_none());
        assert!(args.paths.is_none());
    }

    #[test]
    fn test_args_deserialize_snake_case() {
        let json = serde_json::json!({
            "branch_summary": false,
            "include_ignored": true
        });
        let args: StatusArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.branch_summary, Some(false));
        assert_eq!(args.include_ignored, Some(true));
    }

    #[test]
    fn test_args_deserialize_camel_case_aliases() {
        let json = serde_json::json!({
            "branchSummary": true,
            "includeIgnored": false
        });
        let args: StatusArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.branch_summary, Some(true));
        assert_eq!(args.include_ignored, Some(false));
    }

    #[test]
    fn test_args_deserialize_paths_string() {
        let json = serde_json::json!({
            "paths": "src/main.rs"
        });
        let args: StatusArgs = serde_json::from_value(json).unwrap();
        assert!(args.paths.is_some());
        assert_eq!(args.paths.unwrap().as_str(), Some("src/main.rs"));
    }

    #[test]
    fn test_args_deserialize_paths_array() {
        let json = serde_json::json!({
            "paths": ["src/", "tests/"]
        });
        let args: StatusArgs = serde_json::from_value(json).unwrap();
        assert!(args.paths.is_some());
        assert!(args.paths.unwrap().is_array());
    }

    // ========================================================================
    // normalize_paths Tests
    // ========================================================================

    #[test]
    fn test_normalize_paths_none() {
        let result = normalize_paths(None);
        assert!(result.is_empty());
    }

    #[test]
    fn test_normalize_paths_string() {
        let result = normalize_paths(Some(Value::String("src/main.rs".to_string())));
        assert_eq!(result, vec!["src/main.rs"]);
    }

    #[test]
    fn test_normalize_paths_array() {
        let array = Value::Array(vec![
            Value::String("src/".to_string()),
            Value::String("tests/".to_string()),
            Value::String("lib/".to_string()),
        ]);
        let result = normalize_paths(Some(array));
        assert_eq!(result, vec!["src/", "tests/", "lib/"]);
    }

    #[test]
    fn test_normalize_paths_empty_array() {
        let array = Value::Array(vec![]);
        let result = normalize_paths(Some(array));
        assert!(result.is_empty());
    }

    #[test]
    fn test_normalize_paths_mixed_array() {
        // Array with non-string values should filter them out
        let array = Value::Array(vec![
            Value::String("valid".to_string()),
            Value::Number(serde_json::Number::from(42)),
            Value::String("also_valid".to_string()),
            Value::Bool(true),
        ]);
        let result = normalize_paths(Some(array));
        assert_eq!(result, vec!["valid", "also_valid"]);
    }

    #[test]
    fn test_normalize_paths_invalid_type() {
        // Number value should return empty vec
        let result = normalize_paths(Some(Value::Number(serde_json::Number::from(42))));
        assert!(result.is_empty());
    }

    #[test]
    fn test_normalize_paths_object() {
        // Object value should return empty vec
        let result = normalize_paths(Some(serde_json::json!({"path": "src/"})));
        assert!(result.is_empty());
    }

    #[test]
    fn test_normalize_paths_null() {
        let result = normalize_paths(Some(Value::Null));
        assert!(result.is_empty());
    }
}

//! Git status tool helper.

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

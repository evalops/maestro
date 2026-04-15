//! GitHub CLI helpers using `gh api`.
//!
//! This module provides wrappers around the GitHub CLI (`gh`) for common
//! repository operations like managing pull requests, issues, and repositories.
//!
//! # Requirements
//!
//! The `gh` CLI must be installed and authenticated. See <https://cli.github.com/>
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::tools::gh::{gh_pr, GhPrArgs};
//! use serde_json::json;
//!
//! // List open pull requests
//! let result = gh_pr(json!({"action": "list", "state": "open"}), ".").await;
//! ```

use serde::Deserialize;
use serde_json::Value;

use crate::agent::ToolResult;

/// Arguments for GitHub Pull Request operations.
///
/// Used by [`gh_pr`] to perform PR actions like create, list, view, checkout, etc.
#[derive(Debug, Deserialize)]
pub struct GhPrArgs {
    action: String,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    label: Option<Vec<String>>,
    #[serde(default)]
    milestone: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    json: Option<bool>,
    #[serde(default, alias = "nameOnly")]
    name_only: Option<bool>,
    #[serde(default)]
    repository: Option<String>,
}

/// Arguments for GitHub Issue operations.
///
/// Used by [`gh_issue`] to perform issue actions like create, list, view, comment, etc.
#[derive(Debug, Deserialize)]
pub struct GhIssueArgs {
    action: String,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    json: Option<bool>,
    #[serde(default)]
    repository: Option<String>,
}

/// Arguments for GitHub Repository operations.
///
/// Used by [`gh_repo`] to perform repo actions like view, fork, and clone.
#[derive(Debug, Deserialize)]
pub struct GhRepoArgs {
    action: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    json: Option<bool>,
}

async fn ensure_gh_available() -> Result<(), String> {
    let output = tokio::process::Command::new("gh")
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("Failed to run gh: {e}"))?;
    if !output.status.success() {
        return Err("GitHub CLI (gh) is not available".to_string());
    }
    Ok(())
}

fn append_field(args: &mut Vec<String>, key: &str, value: &Value) {
    match value {
        Value::String(s) => {
            args.push("-f".to_string());
            args.push(format!("{key}={s}"));
        }
        Value::Number(n) => {
            args.push("-F".to_string());
            args.push(format!("{key}={n}"));
        }
        Value::Bool(b) => {
            args.push("-F".to_string());
            args.push(format!("{key}={b}"));
        }
        Value::Array(values) => {
            for item in values {
                append_field(args, &format!("{key}[]"), item);
            }
        }
        Value::Null => {}
        Value::Object(_) => {}
    }
}

async fn run_gh_api(
    endpoint: &str,
    method: &str,
    fields: Vec<(String, Value)>,
    headers: Vec<String>,
    gh_repo: Option<&str>,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.arg("api");
    cmd.arg(endpoint);
    cmd.arg("--method");
    cmd.arg(method);
    for header in headers {
        cmd.arg("-H").arg(header);
    }

    let mut args: Vec<String> = Vec::new();
    for (key, value) in fields {
        append_field(&mut args, &key, &value);
    }
    if !args.is_empty() {
        cmd.args(args);
    }
    if let Some(repo) = gh_repo {
        cmd.env("GH_REPO", repo);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run gh api: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(if stderr.is_empty() {
            "gh api failed".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn git_current_branch(cwd: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !output.status.success() {
        return Err("Unable to determine current branch".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn resolve_default_branch(gh_repo: Option<&str>) -> Result<String, String> {
    let output = run_gh_api(
        "repos/{owner}/{repo}",
        "GET",
        Vec::new(),
        Vec::new(),
        gh_repo,
    )
    .await?;
    let json: Value = serde_json::from_str(&output).map_err(|e| e.to_string())?;
    json.get("default_branch")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string)
        .ok_or_else(|| "Failed to read default_branch".to_string())
}

async fn resolve_repo_full_name(gh_repo: Option<&str>) -> Result<String, String> {
    if let Some(repo) = gh_repo {
        return Ok(repo.to_string());
    }
    let output = run_gh_api(
        "repos/{owner}/{repo}",
        "GET",
        Vec::new(),
        Vec::new(),
        gh_repo,
    )
    .await?;
    let json: Value = serde_json::from_str(&output).map_err(|e| e.to_string())?;
    json.get("full_name")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string)
        .ok_or_else(|| "Failed to read repo name".to_string())
}

/// Execute a GitHub Pull Request operation.
///
/// # Supported Actions
///
/// - `create` - Create a new PR (requires `title`, optional `body`, `branch`, `base`, `draft`)
/// - `list` - List PRs (optional `state`, `author`, `label`, `milestone`, `limit`)
/// - `view` - View a specific PR (requires `number`) or list all
/// - `checkout` - Checkout a PR branch locally (requires `number`)
/// - `comment` - Add a comment to a PR (requires `number`, `body`)
/// - `checks` - View CI check status (requires `number`)
/// - `diff` - Get PR diff (requires `number`, optional `nameOnly`)
///
/// # Arguments
///
/// * `args` - JSON value containing [`GhPrArgs`] fields
/// * `cwd` - Current working directory for git operations
pub async fn gh_pr(args: Value, cwd: &str) -> ToolResult {
    let parsed: GhPrArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid gh_pr arguments: {err}")),
    };

    if let Err(err) = ensure_gh_available().await {
        return ToolResult::failure(err);
    }

    let _ = parsed.json.as_ref();
    let repo = parsed.repository.as_deref();
    match parsed.action.as_str() {
        "create" => {
            let title = match parsed.title {
                Some(val) => val,
                None => return ToolResult::failure("title required for create".to_string()),
            };
            let head = parsed.branch.clone().unwrap_or_default();
            let head = if head.is_empty() {
                match git_current_branch(cwd).await {
                    Ok(branch) => branch,
                    Err(err) => return ToolResult::failure(err),
                }
            } else {
                head
            };
            let base = match parsed.base {
                Some(val) => val,
                None => match resolve_default_branch(repo).await {
                    Ok(branch) => branch,
                    Err(err) => return ToolResult::failure(err),
                },
            };
            let mut fields = vec![
                ("title".to_string(), Value::String(title)),
                ("head".to_string(), Value::String(head)),
                ("base".to_string(), Value::String(base)),
            ];
            if let Some(body) = parsed.body {
                fields.push(("body".to_string(), Value::String(body)));
            }
            if parsed.draft.unwrap_or(false) {
                fields.push(("draft".to_string(), Value::Bool(true)));
            }

            match run_gh_api(
                "repos/{owner}/{repo}/pulls",
                "POST",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "checkout" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for checkout".to_string()),
            };
            let output = match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/pulls/{number}"),
                "GET",
                Vec::new(),
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => output,
                Err(err) => return ToolResult::failure(err),
            };
            let json: Value = match serde_json::from_str(&output) {
                Ok(val) => val,
                Err(err) => return ToolResult::failure(format!("Invalid PR response: {err}")),
            };
            let head_ref = json
                .get("head")
                .and_then(|v| v.get("ref"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing PR head ref".to_string());
            let head_ref = match head_ref {
                Ok(val) => val.to_string(),
                Err(err) => return ToolResult::failure(err),
            };
            let repo_url = json
                .get("head")
                .and_then(|v| v.get("repo"))
                .and_then(|v| v.get("clone_url"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing PR head repo url".to_string());
            let repo_url = match repo_url {
                Ok(val) => val.to_string(),
                Err(err) => return ToolResult::failure(err),
            };

            let branch_name = format!("pr-{number}");
            let status = tokio::process::Command::new("git")
                .arg("fetch")
                .arg(&repo_url)
                .arg(&head_ref)
                .current_dir(cwd)
                .status()
                .await;
            if let Err(err) = status {
                return ToolResult::failure(format!("git fetch failed: {err}"));
            }

            let checkout_status = tokio::process::Command::new("git")
                .arg("checkout")
                .arg("-B")
                .arg(&branch_name)
                .arg("FETCH_HEAD")
                .current_dir(cwd)
                .status()
                .await;
            match checkout_status {
                Ok(status) if status.success() => {
                    ToolResult::success(format!("Checked out PR #{number} as {branch_name}"))
                }
                Ok(_) => ToolResult::failure("git checkout failed".to_string()),
                Err(err) => ToolResult::failure(format!("git checkout failed: {err}")),
            }
        }
        "view" => {
            let number = parsed.number;
            let endpoint = if let Some(num) = number {
                format!("repos/{{owner}}/{{repo}}/pulls/{num}")
            } else {
                "repos/{owner}/{repo}/pulls".to_string()
            };
            match run_gh_api(&endpoint, "GET", Vec::new(), Vec::new(), repo).await {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "list" => {
            let limit = parsed.limit.unwrap_or(30).min(100);
            let mut fields = vec![("per_page".to_string(), Value::Number(limit.into()))];
            if let Some(state) = &parsed.state {
                fields.push(("state".to_string(), Value::String(state.clone())));
            }

            let use_search =
                parsed.label.is_some() || parsed.milestone.is_some() || parsed.author.is_some();
            if use_search {
                let repo_name = match resolve_repo_full_name(repo).await {
                    Ok(name) => name,
                    Err(err) => return ToolResult::failure(err),
                };
                let mut query = format!("repo:{repo_name} is:pr");
                if let Some(state) = parsed.state {
                    if state != "all" {
                        query.push_str(&format!(" state:{state}"));
                    }
                }
                if let Some(author) = parsed.author {
                    query.push_str(&format!(" author:{author}"));
                }
                if let Some(labels) = parsed.label {
                    for label in labels {
                        query.push_str(&format!(" label:\"{label}\""));
                    }
                }
                if let Some(milestone) = parsed.milestone {
                    query.push_str(&format!(" milestone:\"{milestone}\""));
                }
                let fields = vec![
                    ("q".to_string(), Value::String(query)),
                    ("per_page".to_string(), Value::Number(limit.into())),
                ];
                match run_gh_api("search/issues", "GET", fields, Vec::new(), repo).await {
                    Ok(output) => ToolResult::success(output),
                    Err(err) => ToolResult::failure(err),
                }
            } else {
                match run_gh_api(
                    "repos/{owner}/{repo}/pulls",
                    "GET",
                    fields,
                    Vec::new(),
                    repo,
                )
                .await
                {
                    Ok(output) => ToolResult::success(output),
                    Err(err) => ToolResult::failure(err),
                }
            }
        }
        "comment" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for comment".to_string()),
            };
            let body = match parsed.body {
                Some(val) => val,
                None => return ToolResult::failure("body required for comment".to_string()),
            };
            let fields = vec![("body".to_string(), Value::String(body))];
            match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/issues/{number}/comments"),
                "POST",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "checks" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for checks".to_string()),
            };
            let pr_output = match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/pulls/{number}"),
                "GET",
                Vec::new(),
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => output,
                Err(err) => return ToolResult::failure(err),
            };
            let json: Value = match serde_json::from_str(&pr_output) {
                Ok(val) => val,
                Err(err) => return ToolResult::failure(format!("Invalid PR response: {err}")),
            };
            let sha = json
                .get("head")
                .and_then(|v| v.get("sha"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing PR head sha".to_string());
            let sha = match sha {
                Ok(val) => val.to_string(),
                Err(err) => return ToolResult::failure(err),
            };
            match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/commits/{sha}/check-runs"),
                "GET",
                Vec::new(),
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "diff" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for diff".to_string()),
            };
            if parsed.name_only.unwrap_or(false) {
                match run_gh_api(
                    &format!("repos/{{owner}}/{{repo}}/pulls/{number}/files"),
                    "GET",
                    vec![("per_page".to_string(), Value::Number(100.into()))],
                    Vec::new(),
                    repo,
                )
                .await
                {
                    Ok(output) => {
                        let json: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
                        if let Some(files) = json.as_array() {
                            let names: Vec<String> = files
                                .iter()
                                .filter_map(|f| f.get("filename").and_then(|v| v.as_str()))
                                .map(std::string::ToString::to_string)
                                .collect();
                            ToolResult::success(names.join("\n"))
                        } else {
                            ToolResult::success(output)
                        }
                    }
                    Err(err) => ToolResult::failure(err),
                }
            } else {
                match run_gh_api(
                    &format!("repos/{{owner}}/{{repo}}/pulls/{number}"),
                    "GET",
                    Vec::new(),
                    vec!["Accept: application/vnd.github.v3.diff".to_string()],
                    repo,
                )
                .await
                {
                    Ok(output) => ToolResult::success(output),
                    Err(err) => ToolResult::failure(err),
                }
            }
        }
        _ => ToolResult::failure("Unsupported gh_pr action".to_string()),
    }
}

/// Execute a GitHub Issue operation.
///
/// # Supported Actions
///
/// - `create` - Create a new issue (requires `title`, optional `body`, `labels`)
/// - `list` - List issues (optional `state`, `author`, `labels`, `limit`)
/// - `view` - View a specific issue (requires `number`)
/// - `comment` - Add a comment to an issue (requires `number`, `body`)
/// - `close` - Close an issue (requires `number`)
///
/// # Arguments
///
/// * `args` - JSON value containing [`GhIssueArgs`] fields
pub async fn gh_issue(args: Value) -> ToolResult {
    let parsed: GhIssueArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid gh_issue arguments: {err}")),
    };

    if let Err(err) = ensure_gh_available().await {
        return ToolResult::failure(err);
    }

    let _ = parsed.json.as_ref();
    let repo = parsed.repository.as_deref();
    match parsed.action.as_str() {
        "create" => {
            let title = match parsed.title {
                Some(val) => val,
                None => return ToolResult::failure("title required for create".to_string()),
            };
            let mut fields = vec![("title".to_string(), Value::String(title))];
            if let Some(body) = parsed.body {
                fields.push(("body".to_string(), Value::String(body)));
            }
            if let Some(labels) = parsed.labels {
                fields.push((
                    "labels".to_string(),
                    Value::Array(labels.into_iter().map(Value::String).collect()),
                ));
            }
            match run_gh_api(
                "repos/{owner}/{repo}/issues",
                "POST",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "view" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for view".to_string()),
            };
            match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/issues/{number}"),
                "GET",
                Vec::new(),
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "list" => {
            let limit = parsed.limit.unwrap_or(30).min(100);
            let mut fields = vec![("per_page".to_string(), Value::Number(limit.into()))];
            if let Some(state) = parsed.state {
                fields.push(("state".to_string(), Value::String(state)));
            }
            if let Some(author) = parsed.author {
                fields.push(("creator".to_string(), Value::String(author)));
            }
            if let Some(labels) = parsed.labels {
                if !labels.is_empty() {
                    fields.push(("labels".to_string(), Value::String(labels.join(","))));
                }
            }
            match run_gh_api(
                "repos/{owner}/{repo}/issues",
                "GET",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "comment" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for comment".to_string()),
            };
            let body = match parsed.body {
                Some(val) => val,
                None => return ToolResult::failure("body required for comment".to_string()),
            };
            let fields = vec![("body".to_string(), Value::String(body))];
            match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/issues/{number}/comments"),
                "POST",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "close" => {
            let number = match parsed.number {
                Some(val) => val,
                None => return ToolResult::failure("number required for close".to_string()),
            };
            let fields = vec![("state".to_string(), Value::String("closed".to_string()))];
            match run_gh_api(
                &format!("repos/{{owner}}/{{repo}}/issues/{number}"),
                "PATCH",
                fields,
                Vec::new(),
                repo,
            )
            .await
            {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        _ => ToolResult::failure("Unsupported gh_issue action".to_string()),
    }
}

/// Execute a GitHub Repository operation.
///
/// # Supported Actions
///
/// - `view` - View repository information
/// - `fork` - Fork the repository to your account
/// - `clone` - Clone the repository locally (optional `directory`)
///
/// # Arguments
///
/// * `args` - JSON value containing [`GhRepoArgs`] fields
/// * `cwd` - Current working directory for clone operations
pub async fn gh_repo(args: Value, cwd: &str) -> ToolResult {
    let parsed: GhRepoArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid gh_repo arguments: {err}")),
    };

    if let Err(err) = ensure_gh_available().await {
        return ToolResult::failure(err);
    }

    let _ = parsed.json.as_ref();
    let repo = parsed.repository.as_deref();
    match parsed.action.as_str() {
        "view" => {
            match run_gh_api("repos/{owner}/{repo}", "GET", Vec::new(), Vec::new(), repo).await {
                Ok(output) => ToolResult::success(output),
                Err(err) => ToolResult::failure(err),
            }
        }
        "fork" => match run_gh_api(
            "repos/{owner}/{repo}/forks",
            "POST",
            Vec::new(),
            Vec::new(),
            repo,
        )
        .await
        {
            Ok(output) => ToolResult::success(output),
            Err(err) => ToolResult::failure(err),
        },
        "clone" => {
            let repo_name = match resolve_repo_full_name(repo).await {
                Ok(name) => name,
                Err(err) => return ToolResult::failure(err),
            };
            let output =
                match run_gh_api("repos/{owner}/{repo}", "GET", Vec::new(), Vec::new(), repo).await
                {
                    Ok(output) => output,
                    Err(err) => return ToolResult::failure(err),
                };
            let json: Value = match serde_json::from_str(&output) {
                Ok(val) => val,
                Err(err) => return ToolResult::failure(format!("Invalid repo response: {err}")),
            };
            let clone_url = json
                .get("clone_url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing clone_url".to_string());
            let clone_url = match clone_url {
                Ok(val) => val.to_string(),
                Err(err) => return ToolResult::failure(err),
            };
            let dir = parsed.directory.unwrap_or_else(|| {
                repo_name
                    .split('/')
                    .next_back()
                    .unwrap_or("repo")
                    .to_string()
            });
            let status = tokio::process::Command::new("git")
                .arg("clone")
                .arg(&clone_url)
                .arg(&dir)
                .current_dir(cwd)
                .status()
                .await;
            match status {
                Ok(status) if status.success() => {
                    ToolResult::success(format!("Cloned {repo_name} to {dir}"))
                }
                Ok(_) => ToolResult::failure("git clone failed".to_string()),
                Err(err) => ToolResult::failure(format!("git clone failed: {err}")),
            }
        }
        _ => ToolResult::failure("Unsupported gh_repo action".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // GhPrArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_gh_pr_args_minimal() {
        let json = serde_json::json!({"action": "list"});
        let args: GhPrArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "list");
        assert!(args.number.is_none());
        assert!(args.title.is_none());
        assert!(args.repository.is_none());
    }

    #[test]
    fn test_gh_pr_args_create() {
        let json = serde_json::json!({
            "action": "create",
            "title": "Add new feature",
            "body": "This PR adds...",
            "branch": "feature-branch",
            "base": "main",
            "draft": true
        });
        let args: GhPrArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "create");
        assert_eq!(args.title.unwrap(), "Add new feature");
        assert_eq!(args.body.unwrap(), "This PR adds...");
        assert_eq!(args.branch.unwrap(), "feature-branch");
        assert_eq!(args.base.unwrap(), "main");
        assert!(args.draft.unwrap());
    }

    #[test]
    fn test_gh_pr_args_with_labels() {
        let json = serde_json::json!({
            "action": "list",
            "label": ["bug", "priority"],
            "state": "open",
            "limit": 50
        });
        let args: GhPrArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "list");
        assert_eq!(args.label.unwrap(), vec!["bug", "priority"]);
        assert_eq!(args.state.unwrap(), "open");
        assert_eq!(args.limit.unwrap(), 50);
    }

    #[test]
    fn test_gh_pr_args_name_only_alias() {
        let json = serde_json::json!({
            "action": "diff",
            "number": 123,
            "nameOnly": true
        });
        let args: GhPrArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "diff");
        assert_eq!(args.number.unwrap(), 123);
        assert!(args.name_only.unwrap());
    }

    // ========================================================================
    // GhIssueArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_gh_issue_args_minimal() {
        let json = serde_json::json!({"action": "list"});
        let args: GhIssueArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "list");
        assert!(args.number.is_none());
    }

    #[test]
    fn test_gh_issue_args_create() {
        let json = serde_json::json!({
            "action": "create",
            "title": "Bug report",
            "body": "Steps to reproduce...",
            "labels": ["bug", "critical"]
        });
        let args: GhIssueArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "create");
        assert_eq!(args.title.unwrap(), "Bug report");
        assert_eq!(args.body.unwrap(), "Steps to reproduce...");
        assert_eq!(args.labels.unwrap(), vec!["bug", "critical"]);
    }

    #[test]
    fn test_gh_issue_args_with_filters() {
        let json = serde_json::json!({
            "action": "list",
            "state": "closed",
            "author": "octocat",
            "limit": 25,
            "repository": "owner/repo"
        });
        let args: GhIssueArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "list");
        assert_eq!(args.state.unwrap(), "closed");
        assert_eq!(args.author.unwrap(), "octocat");
        assert_eq!(args.limit.unwrap(), 25);
        assert_eq!(args.repository.unwrap(), "owner/repo");
    }

    // ========================================================================
    // GhRepoArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_gh_repo_args_minimal() {
        let json = serde_json::json!({"action": "view"});
        let args: GhRepoArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "view");
        assert!(args.repository.is_none());
        assert!(args.directory.is_none());
    }

    #[test]
    fn test_gh_repo_args_clone() {
        let json = serde_json::json!({
            "action": "clone",
            "repository": "owner/repo",
            "directory": "my-local-dir"
        });
        let args: GhRepoArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.action, "clone");
        assert_eq!(args.repository.unwrap(), "owner/repo");
        assert_eq!(args.directory.unwrap(), "my-local-dir");
    }

    // ========================================================================
    // append_field Tests
    // ========================================================================

    #[test]
    fn test_append_field_string() {
        let mut args = Vec::new();
        append_field(&mut args, "title", &Value::String("Hello".to_string()));
        assert_eq!(args, vec!["-f", "title=Hello"]);
    }

    #[test]
    fn test_append_field_number() {
        let mut args = Vec::new();
        append_field(&mut args, "count", &serde_json::json!(42));
        assert_eq!(args, vec!["-F", "count=42"]);
    }

    #[test]
    fn test_append_field_bool() {
        let mut args = Vec::new();
        append_field(&mut args, "draft", &Value::Bool(true));
        assert_eq!(args, vec!["-F", "draft=true"]);
    }

    #[test]
    fn test_append_field_array() {
        let mut args = Vec::new();
        append_field(
            &mut args,
            "labels",
            &serde_json::json!(["bug", "enhancement"]),
        );
        assert_eq!(
            args,
            vec!["-f", "labels[]=bug", "-f", "labels[]=enhancement"]
        );
    }

    #[test]
    fn test_append_field_null() {
        let mut args = Vec::new();
        append_field(&mut args, "optional", &Value::Null);
        assert!(args.is_empty());
    }

    #[test]
    fn test_append_field_object_ignored() {
        let mut args = Vec::new();
        append_field(
            &mut args,
            "complex",
            &serde_json::json!({"nested": "value"}),
        );
        assert!(args.is_empty());
    }

    // ========================================================================
    // Error Cases Tests
    // ========================================================================

    #[test]
    fn test_gh_pr_args_invalid_json() {
        let json = serde_json::json!({"wrong_field": "value"});
        let result: Result<GhPrArgs, _> = serde_json::from_value(json);
        // Missing required "action" field
        assert!(result.is_err());
    }

    #[test]
    fn test_gh_issue_args_invalid_json() {
        let json = serde_json::json!({"number": 123});
        let result: Result<GhIssueArgs, _> = serde_json::from_value(json);
        // Missing required "action" field
        assert!(result.is_err());
    }
}

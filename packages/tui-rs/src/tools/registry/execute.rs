use super::super::shell_env::resolve_shell_environment;
use super::*;
#[cfg(windows)]
use crate::tools::bash::resolve_shell_config;
use tokio::io::{AsyncRead, AsyncReadExt as _};

pub(super) struct ProcessRunResult {
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) exit_code: i32,
    truncated: bool,
}

pub(super) const MAX_PROCESS_STDOUT_LINE_BYTES: usize = 64 * 1024;
pub(super) const MAX_PROCESS_STDERR_BYTES: usize = 64 * 1024;

fn lossy_line(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

async fn read_limited_lossy<R>(mut reader: R, byte_limit: usize, truncated_label: &str) -> String
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 8192];
    let mut bytes = Vec::with_capacity(byte_limit.min(buffer.len()));
    let mut truncated = false;

    while let Ok(read) = reader.read(&mut buffer).await {
        if read == 0 {
            break;
        }

        if bytes.len() < byte_limit {
            let remaining = byte_limit - bytes.len();
            let keep = remaining.min(read);
            bytes.extend_from_slice(&buffer[..keep]);
            truncated |= keep < read;
        } else {
            truncated = true;
        }
    }

    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(truncated_label);
    }
    output
}

fn collect_string_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(std::string::ToString::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn process_path_arg(path: &str) -> String {
    if path.starts_with('-')
        && !Path::new(path).is_absolute()
        && !path.starts_with("./")
        && !path.starts_with("../")
    {
        format!("./{path}")
    } else {
        path.to_string()
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut tokio::process::Command) {
    use std::os::unix::process::CommandExt as _;
    command.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut tokio::process::Command) {}

async fn terminate_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let process_group = -(pid as libc::pid_t);
        // Kill the process group so shell children close inherited stdio promptly.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }

    let _ = child.kill().await;
}

#[cfg(any(test, windows))]
fn shell_quote_arg(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }

    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(test, windows))]
pub(super) fn build_windows_list_shell_command(shell_path: &str, recursive: bool) -> String {
    let quoted_path = shell_quote_arg(shell_path);
    if recursive {
        format!("find -- {quoted_path} -type f")
    } else {
        format!("ls -la -- {quoted_path}")
    }
}

#[cfg(windows)]
fn build_list_process(
    _display_path: &str,
    shell_path: &str,
    recursive: bool,
) -> Result<(String, Vec<String>, &'static str), String> {
    let (program, mut args) = resolve_shell_config()?;
    args.push(build_windows_list_shell_command(shell_path, recursive));
    let process_name = if recursive { "find" } else { "ls" };
    Ok((program, args, process_name))
}

#[cfg(not(windows))]
fn build_list_process(
    display_path: &str,
    _shell_path: &str,
    recursive: bool,
) -> Result<(String, Vec<String>, &'static str), String> {
    let process_path = process_path_arg(display_path);
    if recursive {
        Ok((
            "find".to_string(),
            vec![process_path, "-type".to_string(), "f".to_string()],
            "find",
        ))
    } else {
        Ok((
            "ls".to_string(),
            vec!["-la".to_string(), process_path],
            "ls",
        ))
    }
}

pub(super) async fn run_process_limited_stdout_lines(
    program: &str,
    args: &[String],
    cwd: &str,
    timeout_ms: u64,
    line_limit: usize,
) -> Result<ProcessRunResult, String> {
    let mut command = tokio::process::Command::new(program);
    let env = resolve_shell_environment(Path::new(cwd), None);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {program}: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{program} stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{program} stderr unavailable"))?;
    let stderr_task = tokio::spawn(async move {
        read_limited_lossy(stderr, MAX_PROCESS_STDERR_BYTES, "[stderr truncated]").await
    });

    let read_and_wait = async {
        let mut stdout = stdout;
        let mut buffer = [0_u8; 8192];
        let mut current_line = Vec::new();
        let mut lines = Vec::new();
        let mut truncated = false;
        if line_limit == 0 {
            truncated = true;
            terminate_child(&mut child).await;
        }
        'read_stdout: loop {
            let read = stdout
                .read(&mut buffer)
                .await
                .map_err(|err| format!("{program} stdout read failed: {err}"))?;
            if read == 0 {
                break;
            }

            for byte in &buffer[..read] {
                if lines.len() >= line_limit {
                    truncated = true;
                    terminate_child(&mut child).await;
                    break 'read_stdout;
                }
                if *byte == b'\n' {
                    lines.push(lossy_line(&current_line));
                    current_line.clear();
                    if lines.len() >= line_limit {
                        truncated = true;
                        terminate_child(&mut child).await;
                        break 'read_stdout;
                    }
                    continue;
                }
                if current_line.len() >= MAX_PROCESS_STDOUT_LINE_BYTES {
                    truncated = true;
                    lines.push(lossy_line(&current_line));
                    current_line.clear();
                    terminate_child(&mut child).await;
                    break 'read_stdout;
                }
                current_line.push(*byte);
            }
        }

        if !current_line.is_empty() {
            if lines.len() >= line_limit {
                truncated = true;
                terminate_child(&mut child).await;
            } else {
                lines.push(lossy_line(&current_line));
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|err| format!("{program} wait failed: {err}"))?;
        Ok::<_, String>((lines, truncated, status.code().unwrap_or(-1)))
    };

    let (lines, truncated, exit_code) =
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), read_and_wait)
            .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => return Err(err),
            Err(_) => {
                terminate_child(&mut child).await;
                let _ = child.wait().await;
                let _ = stderr_task.await;
                return Err(format!("{program} timed out after {timeout_ms}ms"));
            }
        };
    let stderr = stderr_task.await.unwrap_or_default();

    Ok(ProcessRunResult {
        stdout: lines.join("\n"),
        stderr,
        exit_code,
        truncated,
    })
}

pub(super) fn process_succeeded_or_truncated(
    result: &ProcessRunResult,
    success_codes: &[i32],
) -> bool {
    result.truncated || success_codes.contains(&result.exit_code)
}

pub(super) async fn run_grep_with_fallback(
    rg_program: &str,
    rg_args: &[String],
    grep_program: &str,
    grep_args: &[String],
    cwd: &str,
    timeout_ms: u64,
    line_limit: usize,
) -> Result<(ProcessRunResult, &'static str), String> {
    match run_process_limited_stdout_lines(rg_program, rg_args, cwd, timeout_ms, line_limit).await {
        Ok(result) => Ok((result, "rg")),
        Err(message) if message.starts_with(&format!("Failed to start {rg_program}:")) => {
            run_process_limited_stdout_lines(grep_program, grep_args, cwd, timeout_ms, line_limit)
                .await
                .map(|result| (result, "grep"))
                .map_err(|fallback_message| {
                    format!("{message}; fallback grep failed: {fallback_message}")
                })
        }
        Err(message) => Err(message),
    }
}

impl ToolExecutor {
    async fn execute_search(&self, args: &serde_json::Value) -> ToolResult {
        let start_time = Instant::now();
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        if pattern.is_empty() {
            return ToolResult::failure("Missing pattern argument".to_string());
        }

        let paths = collect_string_values(args.get("paths").or_else(|| args.get("path")));
        let glob_patterns = collect_string_values(args.get("glob"));
        let command_cwd = match args.get("cwd").and_then(|v| v.as_str()) {
            Some(cwd) => match resolve_tool_path(&self.cwd, cwd) {
                Ok(path) => path,
                Err(message) => return ToolResult::failure(message),
            },
            None => self.cwd.clone(),
        };

        let mut rg_args = vec![
            "--color=never".to_string(),
            "--no-heading".to_string(),
            "-n".to_string(),
        ];
        let output_mode = args
            .get("outputMode")
            .and_then(|v| v.as_str())
            .unwrap_or("content");
        if output_mode == "files" {
            rg_args.push("-l".to_string());
        } else if output_mode == "count" {
            rg_args.push("--count-matches".to_string());
            rg_args.push("-H".to_string());
        }
        if args
            .get("ignoreCase")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("-i".to_string());
        }
        if args
            .get("literal")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("-F".to_string());
        }
        if args
            .get("word")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("-w".to_string());
        }
        if args
            .get("multiline")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("--multiline".to_string());
        }
        if let Some(context) = args.get("context").and_then(serde_json::Value::as_u64) {
            rg_args.push("-C".to_string());
            rg_args.push(context.to_string());
        } else {
            if let Some(before) = args
                .get("beforeContext")
                .and_then(serde_json::Value::as_u64)
            {
                rg_args.push("-B".to_string());
                rg_args.push(before.to_string());
            }
            if let Some(after) = args.get("afterContext").and_then(serde_json::Value::as_u64) {
                rg_args.push("-A".to_string());
                rg_args.push(after.to_string());
            }
        }
        for glob in &glob_patterns {
            rg_args.push("-g".to_string());
            rg_args.push(glob.clone());
        }
        if args
            .get("includeHidden")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("--hidden".to_string());
        }
        if args
            .get("useGitIgnore")
            .and_then(serde_json::Value::as_bool)
            .is_some_and(|v| !v)
        {
            rg_args.push("--no-ignore".to_string());
        }
        if args
            .get("invertMatch")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("--invert-match".to_string());
        }
        if args
            .get("onlyMatching")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            rg_args.push("--only-matching".to_string());
        }

        if args
            .get("format")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|format| format == "json")
            && output_mode == "content"
        {
            rg_args.push("--json".to_string());
        }

        for path in &paths {
            if path.trim().is_empty() {
                return ToolResult::failure("paths entries must be non-empty strings");
            }
        }

        let head_limit = args
            .get("headLimit")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(MAX_GREP_LINES as u64)
            .max(1) as usize;
        let line_limit = args
            .get("maxResults")
            .and_then(serde_json::Value::as_u64)
            .map(|max_results| (max_results.max(1) as usize).min(head_limit))
            .unwrap_or(head_limit);

        if let Some(max_results) = args.get("maxResults").and_then(serde_json::Value::as_u64) {
            rg_args.push("-m".to_string());
            rg_args.push(max_results.to_string());
        } else if output_mode == "content" {
            rg_args.push("-m".to_string());
            rg_args.push(head_limit.to_string());
        }

        rg_args.push("--".to_string());
        rg_args.push(pattern.to_string());
        if paths.is_empty() {
            rg_args.push(".".to_string());
        } else {
            rg_args.extend(paths.iter().cloned());
        }

        let result = match run_process_limited_stdout_lines(
            "rg",
            &rg_args,
            &command_cwd,
            30_000,
            line_limit,
        )
        .await
        {
            Ok(result) => result,
            Err(message) => return ToolResult::failure(message),
        };

        let duration_ms = start_time.elapsed().as_millis() as u64;
        let output_lines: Vec<&str> = result.stdout.lines().collect();
        let matches_count = output_lines.len();
        let truncated = result.truncated || matches_count >= head_limit;
        let output = output_lines
            .iter()
            .take(head_limit)
            .copied()
            .collect::<Vec<_>>()
            .join("\n");

        let mut details = GrepDetails::new(pattern)
            .with_path(paths.join(", "))
            .with_matches(matches_count)
            .with_duration(duration_ms)
            .with_search_tool("rg");
        if truncated {
            details = details.with_truncation();
        }

        if process_succeeded_or_truncated(&result, &[0, 1]) {
            ToolResult::success(output).with_details(details.to_json())
        } else {
            let message = result.stderr.trim();
            let message = if message.is_empty() {
                format!("ripgrep exited with status {}", result.exit_code)
            } else {
                message.to_string()
            };
            ToolResult::failure(message).with_details(details.to_json())
        }
    }

    /// Internal implementation of tool execution (without caching)
    pub(super) async fn execute_impl(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
        event_tx: Option<&mpsc::UnboundedSender<FromAgent>>,
        call_id: &str,
    ) -> ToolResult {
        if McpClient::is_mcp_tool(tool_name) {
            let client = match self.ensure_mcp_client().await {
                Ok(client) => client,
                Err(err) => return ToolResult::failure(err),
            };

            match client
                .call_tool_with_metadata(tool_name, args.clone())
                .await
            {
                Ok((server_name, tool_label, result)) => {
                    let text_output = result
                        .content
                        .iter()
                        .filter_map(|content| match content {
                            McpContent::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let output = if text_output.is_empty() {
                        serde_json::to_string_pretty(&result.content)
                            .unwrap_or_else(|_| "MCP tool returned non-text content".to_string())
                    } else {
                        text_output
                    };
                    let details = serde_json::json!({
                        "server": server_name,
                        "tool": tool_label,
                        "content": result.content,
                        "isError": result.is_error
                    });
                    return ToolResult::success(output).with_details(details);
                }
                Err(err) => {
                    return ToolResult::failure(format!("MCP tool error: {err}"));
                }
            }
        }

        match tool_name {
            "bash" | "Bash" => {
                let bash_args: BashArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid bash arguments: {e}"));
                    }
                };

                if let Err(err) = require_plan("bash") {
                    return ToolResult::failure(err);
                }

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.bash.execute(bash_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "read" | "Read" => {
                let start_time = Instant::now();
                let raw_path = args
                    .get("path")
                    .or_else(|| args.get("file_path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                let path_buf = std::path::Path::new(&path);
                let extension = path_buf
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_ascii_lowercase);

                // Optional line offset (1-indexed, defaults to 1)
                let offset = args
                    .get("offset")
                    .and_then(serde_json::Value::as_u64)
                    .map_or(1, |v| v.max(1) as usize);

                // Optional line limit (defaults to reading all)
                let limit = args
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as usize);

                let mode = args
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("normal");

                let line_numbers = args
                    .get("lineNumbers")
                    .or_else(|| args.get("line_numbers"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let wrap_in_code_fence = args
                    .get("wrapInCodeFence")
                    .or_else(|| args.get("wrap_in_code_fence"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let as_base64 = args
                    .get("asBase64")
                    .or_else(|| args.get("as_base64"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);

                let with_diagnostics = args
                    .get("withDiagnostics")
                    .or_else(|| args.get("diagnostics"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let language = args.get("language").and_then(|v| v.as_str());

                if let Some(ext) = extension.as_deref() {
                    let is_image =
                        matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg");
                    if is_image {
                        let image_args = ReadImageArgs {
                            file_path: path.clone(),
                            max_dimension: None,
                        };
                        return self.image.read_image(image_args).await;
                    }
                }

                if let Some(ext) = extension.as_deref() {
                    if ext == "pdf" {
                        let bytes = match tokio::fs::read(&path).await {
                            Ok(data) => data,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!("Failed to read PDF: {err}"))
                                    .with_details(details.to_json());
                            }
                        };
                        let text = match pdf_extract::extract_text_from_mem(&bytes) {
                            Ok(text) => text,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64)
                                    .with_mime_type("application/pdf");
                                return ToolResult::failure(format!(
                                    "Failed to extract PDF: {err}"
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let mut output = text;
                        if wrap_in_code_fence {
                            let fence_language = language.unwrap_or("");
                            output = format!("```{fence_language}\n{output}\n```");
                        }
                        let details = ReadDetails::new(path.clone())
                            .with_size(bytes.len() as u64)
                            .with_mime_type("application/pdf")
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::success(output).with_details(details.to_json());
                    }
                }

                if let Some(ext) = extension.as_deref() {
                    if ext == "ipynb" {
                        let content = match tokio::fs::read_to_string(&path).await {
                            Ok(text) => text,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!(
                                    "Failed to read notebook: {err}"
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let notebook: serde_json::Value = match serde_json::from_str(&content) {
                            Ok(val) => val,
                            Err(err) => {
                                let details = ReadDetails::new(path.clone())
                                    .with_duration(start_time.elapsed().as_millis() as u64);
                                return ToolResult::failure(format!(
                                    "Failed to parse notebook: {err}"
                                ))
                                .with_details(details.to_json());
                            }
                        };
                        let cells = notebook.get("cells").and_then(|v| v.as_array()).cloned();
                        let cells = match cells {
                            Some(val) => val,
                            None => {
                                return ToolResult::failure(
                                    "Invalid notebook format: missing cells".to_string(),
                                );
                            }
                        };
                        let mut lines = Vec::new();
                        for (idx, cell) in cells.iter().enumerate() {
                            let cell_type = cell
                                .get("cell_type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("code");
                            let cell_id = cell.get("id").and_then(|v| v.as_str());
                            let source = cell.get("source").map(|v| {
                                if v.is_array() {
                                    v.as_array()
                                        .unwrap_or(&Vec::new())
                                        .iter()
                                        .filter_map(|line| line.as_str())
                                        .collect::<Vec<_>>()
                                        .join("")
                                } else {
                                    v.as_str().unwrap_or("").to_string()
                                }
                            });
                            let preview = source.unwrap_or_default();
                            let preview_lines: Vec<&str> = preview.lines().take(3).collect();
                            let truncated = if preview.lines().count() > 3 {
                                "..."
                            } else {
                                ""
                            };
                            let id_suffix =
                                cell_id.map(|id| format!(" (id: {id})")).unwrap_or_default();
                            lines.push(format!(
                                "[{}] {}{}:\n{}{}",
                                idx,
                                cell_type,
                                id_suffix,
                                preview_lines.join("\n"),
                                truncated
                            ));
                            lines.push(String::new());
                        }
                        let output = lines.join("\n");
                        let details = ReadDetails::new(path.clone())
                            .with_size(content.len() as u64)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::success(output).with_details(details.to_json());
                    }
                }

                if let Ok(metadata) = tokio::fs::metadata(&path).await {
                    let size_bytes = metadata.len();
                    if size_bytes > MAX_READ_SIZE_BYTES {
                        let size_mb = (size_bytes as f64) / (1024.0 * 1024.0);
                        let details = ReadDetails::new(path.clone())
                            .with_size(size_bytes)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!(
                            "File is too large ({size_mb:.2}MB). Maximum size is 10MB. Use offset/limit or bash head/tail for large files."
                        ))
                        .with_details(details.to_json());
                    }
                }

                let bytes = match tokio::fs::read(&path).await {
                    Ok(data) => data,
                    Err(e) => {
                        let details = ReadDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to read file: {e}"))
                            .with_details(details.to_json());
                    }
                };

                if is_probably_binary(&bytes) && !as_base64 {
                    let details = ReadDetails::new(path.clone())
                        .with_size(bytes.len() as u64)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(
                        "Binary file detected. Re-run with asBase64=true or use the bash tool.",
                    )
                    .with_details(details.to_json());
                }

                if as_base64 {
                    let encoded = STANDARD.encode(&bytes);
                    let details = ReadDetails::new(path.clone())
                        .with_size(bytes.len() as u64)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::success(encoded).with_details(details.to_json());
                }

                let content = if let Ok(text) = String::from_utf8(bytes) {
                    text
                } else {
                    let details = ReadDetails::new(path.clone())
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(
                        "File is not valid UTF-8. Re-run with asBase64=true or use the bash tool.",
                    )
                    .with_details(details.to_json());
                };

                let lines: Vec<&str> = content.lines().collect();
                let total_lines = lines.len();

                let mut start_idx = (offset - 1).min(total_lines);
                let mut max_lines = limit.unwrap_or(total_lines);

                match mode {
                    "head" => {
                        start_idx = 0;
                        max_lines = limit.unwrap_or(total_lines);
                    }
                    "tail" => {
                        max_lines = limit.unwrap_or(total_lines);
                        start_idx = total_lines.saturating_sub(max_lines);
                    }
                    "normal" => {}
                    _ => {
                        let details = ReadDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure("Invalid mode. Use normal, head, or tail.")
                            .with_details(details.to_json());
                    }
                }

                let end_idx = (start_idx + max_lines).min(total_lines);
                let lines_read = end_idx.saturating_sub(start_idx);
                let truncated = limit.is_some() && end_idx < total_lines;

                let mut output: String = lines[start_idx..end_idx]
                    .iter()
                    .enumerate()
                    .map(|(i, line)| {
                        if line_numbers {
                            format!("{:>6}\t{}", start_idx + i + 1, line)
                        } else {
                            (*line).to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");

                if wrap_in_code_fence {
                    let fence_language = language.unwrap_or("");
                    output = format!("```{fence_language}\n{output}\n```");
                }

                if with_diagnostics {
                    if let Ok(diagnostics) = lsp::diagnostics_for_file(&self.cwd, &path).await {
                        if !diagnostics.is_empty() {
                            let errors: Vec<_> = diagnostics
                                .iter()
                                .filter(|d| d.severity == Some(1) || d.severity.is_none())
                                .collect();
                            let warnings: Vec<_> = diagnostics
                                .iter()
                                .filter(|d| d.severity == Some(2))
                                .collect();

                            if !errors.is_empty() || !warnings.is_empty() {
                                output.push_str("\n\n--- LSP Diagnostics ---\n");
                                let max_diagnostics = lsp::max_diagnostics_per_file();
                                let mut count = 0usize;

                                for diag in &errors {
                                    if count >= max_diagnostics {
                                        break;
                                    }
                                    let message = lsp::sanitize_diagnostic_message(&diag.message);
                                    output.push_str(&format!(
                                        "ERROR (line {}): {}\n",
                                        diag.range.start.line + 1,
                                        message
                                    ));
                                    count += 1;
                                }

                                for diag in &warnings {
                                    if count >= max_diagnostics {
                                        break;
                                    }
                                    let message = lsp::sanitize_diagnostic_message(&diag.message);
                                    output.push_str(&format!(
                                        "WARN (line {}): {}\n",
                                        diag.range.start.line + 1,
                                        message
                                    ));
                                    count += 1;
                                }

                                if errors.len() + warnings.len() > max_diagnostics {
                                    let remaining = errors.len() + warnings.len() - max_diagnostics;
                                    output.push_str(&format!(
                                        "...and {} more {} hidden.\n",
                                        remaining,
                                        if remaining == 1 {
                                            "diagnostic"
                                        } else {
                                            "diagnostics"
                                        }
                                    ));
                                }
                            }
                        }
                    }
                }

                let details = ReadDetails::new(path.clone())
                    .with_size(content.len() as u64)
                    .with_lines(lines_read)
                    .with_truncated(truncated)
                    .with_offset(if offset > 1 { Some(offset) } else { None })
                    .with_limit(limit)
                    .with_duration(start_time.elapsed().as_millis() as u64);

                ToolResult::success(output).with_details(details.to_json())
            }
            "write" | "Write" => {
                let start_time = Instant::now();
                let raw_path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                if let Err(err) = require_plan("write") {
                    return ToolResult::failure(err);
                }

                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let preview_diff = args
                    .get("previewDiff")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
                let backup = args
                    .get("backup")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let file_existed = std::path::Path::new(&path).exists();
                let mut previous_content: Option<String> = None;
                if file_existed {
                    if let Ok(text) = tokio::fs::read_to_string(&path).await {
                        previous_content = Some(text);
                    }
                }

                if let Some(parent) = std::path::Path::new(&path).parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        let details = WriteDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to create directory: {e}"))
                            .with_details(details.to_json());
                    }
                }

                let mut backup_path: Option<String> = None;
                let mut backup_renamed = false;
                if file_existed && backup {
                    let backup_target = format!("{path}.bak");
                    if tokio::fs::rename(&path, &backup_target).await.is_ok() {
                        backup_renamed = true;
                    } else if let Some(prev) = &previous_content {
                        let _ = tokio::fs::write(&backup_target, prev).await;
                    }
                    backup_path = Some(backup_target);
                }

                let tmp_path = format!("{}.{}.tmp", path, uuid::Uuid::new_v4());
                let write_result = async {
                    tokio::fs::write(&tmp_path, &content).await?;
                    tokio::fs::rename(&tmp_path, &path).await?;
                    Ok::<(), std::io::Error>(())
                }
                .await;

                if let Err(e) = write_result {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    if backup_renamed {
                        let _ = tokio::fs::rename(format!("{path}.bak"), &path).await;
                    } else if let Some(prev) = &previous_content {
                        let _ = tokio::fs::write(&path, prev).await;
                    }
                    let details = WriteDetails::new(path.clone())
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(format!("Failed to write file: {e}"))
                        .with_details(details.to_json());
                }

                let diff = if preview_diff {
                    previous_content.as_ref().map(|old| {
                        let diff = similar::TextDiff::from_lines(old, &content);
                        diff.unified_diff().to_string()
                    })
                } else {
                    None
                };

                let display_path = if raw_path.is_empty() { &path } else { raw_path };
                let mut linter_output = String::new();
                let lsp_diagnostics = match lsp::collect_diagnostics_for_paths(
                    &self.cwd,
                    std::slice::from_ref(&path),
                )
                .await
                {
                    Ok(map) => {
                        if let Some(file_diags) = map.get(&path).or_else(|| map.get(display_path)) {
                            linter_output =
                                lsp::format_lsp_summary(display_path, file_diags.as_slice());
                        }
                        Some(map)
                    }
                    Err(_) => None,
                };

                let validators = match run_validators_with_diagnostics(
                    std::slice::from_ref(&path),
                    lsp_diagnostics.as_ref(),
                )
                .await
                {
                    Ok(results) => Some(results),
                    Err(err) => {
                        if backup_renamed {
                            let _ = tokio::fs::rename(format!("{path}.bak"), &path).await;
                        } else if let Some(prev) = &previous_content {
                            let _ = tokio::fs::write(&path, prev).await;
                        }
                        return ToolResult::failure(err);
                    }
                };

                self.invalidate_file_cache(&path);

                let mut details = WriteDetails::new(path.clone())
                    .with_bytes(content.len() as u64)
                    .with_created(!file_existed)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                if let Some(diff) = diff {
                    details = details.with_diff(diff);
                }
                if let Some(backup_path) = backup_path {
                    details = details.with_backup(backup_path);
                }
                if let Some(validators) = validators {
                    details = details.with_validators(validators);
                }

                let mut summary = format!("File written successfully: {path}");
                if !linter_output.is_empty() {
                    summary.push_str(&linter_output);
                }

                ToolResult::success(summary).with_details(details.to_json())
            }
            "glob" | "Glob" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");

                let base_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);

                let full_pattern = build_glob_pattern(base_path, pattern);

                // Use native glob crate
                match glob::glob(&full_pattern) {
                    Ok(paths) => {
                        const MAX_GLOB_RESULTS: usize = 100;
                        let mut matches: Vec<String> = Vec::new();
                        let mut truncated = false;

                        for entry in paths {
                            let Ok(path) = entry else {
                                continue;
                            };
                            if matches.len() >= MAX_GLOB_RESULTS {
                                truncated = true;
                                break;
                            }
                            matches.push(path.display().to_string());
                        }

                        let details = GlobDetails::new(pattern)
                            .with_base_path(base_path)
                            .with_matches(matches.len())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        let details = if truncated {
                            details.with_truncation()
                        } else {
                            details
                        };

                        ToolResult::success(matches.join("\n")).with_details(details.to_json())
                    }
                    Err(e) => {
                        let details = GlobDetails::new(pattern)
                            .with_base_path(base_path)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        ToolResult::failure(format!("Glob error: {e}"))
                            .with_details(details.to_json())
                    }
                }
            }
            "grep" | "Grep" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                let raw_path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let (display_path, _) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                if pattern.is_empty() {
                    let details =
                        GrepDetails::new("").with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure("Missing pattern argument")
                        .with_details(details.to_json());
                }

                let rg_args = vec![
                    "--no-heading".to_string(),
                    "-n".to_string(),
                    "--".to_string(),
                    pattern.to_string(),
                    display_path.clone(),
                ];
                let grep_args = vec![
                    "-rn".to_string(),
                    "--".to_string(),
                    pattern.to_string(),
                    display_path.clone(),
                ];
                let (result, search_tool) = match run_grep_with_fallback(
                    "rg",
                    &rg_args,
                    "grep",
                    &grep_args,
                    &self.cwd,
                    30_000,
                    MAX_GREP_LINES,
                )
                .await
                {
                    Ok(result) => result,
                    Err(message) => {
                        let details = GrepDetails::new(pattern)
                            .with_path(&display_path)
                            .with_duration(start_time.elapsed().as_millis() as u64)
                            .with_search_tool("rg");
                        return ToolResult::failure(message).with_details(details.to_json());
                    }
                };

                // Build grep details from result
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let output_lines = result.stdout.lines().collect::<Vec<_>>();
                let matches_count = output_lines.len();
                let files_matched = output_lines
                    .iter()
                    .copied()
                    .filter_map(extract_grep_path)
                    .collect::<std::collections::HashSet<_>>()
                    .len();
                let truncated = result.truncated || matches_count >= MAX_GREP_LINES;
                let output = output_lines
                    .iter()
                    .take(MAX_GREP_LINES)
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");

                let details = GrepDetails::new(pattern)
                    .with_path(&display_path)
                    .with_matches(matches_count)
                    .with_files_matched(files_matched)
                    .with_duration(duration_ms)
                    .with_search_tool(search_tool);

                let details = if truncated {
                    details.with_truncation()
                } else {
                    details
                };

                if process_succeeded_or_truncated(&result, &[0, 1]) {
                    ToolResult::success(output).with_details(details.to_json())
                } else {
                    let message = result.stderr.trim();
                    let message = if message.is_empty() {
                        format!("ripgrep exited with status {}", result.exit_code)
                    } else {
                        message.to_string()
                    };
                    ToolResult::failure(message).with_details(details.to_json())
                }
            }
            "edit" | "Edit" => {
                let start_time = Instant::now();
                let raw_path = args
                    .get("file_path")
                    .or_else(|| args.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let path = match resolve_tool_path(&self.cwd, raw_path) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                if let Err(err) = require_plan("edit") {
                    return ToolResult::failure(err);
                }

                let replace_all = args
                    .get("replaceAll")
                    .or_else(|| args.get("replace_all"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let occurrence = args
                    .get("occurrence")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(1) as usize;
                let dry_run = args
                    .get("dryRun")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);

                let edits_value = args.get("edits").and_then(|v| v.as_array());
                let mut edits: Vec<(String, String)> = Vec::new();

                if let Some(edits_array) = edits_value {
                    if replace_all || occurrence != 1 {
                        return ToolResult::failure(
                            "Cannot use replaceAll or occurrence with edits array".to_string(),
                        );
                    }
                    for edit in edits_array {
                        let old = edit
                            .get("oldText")
                            .or_else(|| edit.get("old_string"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if old.is_empty() {
                            return ToolResult::failure("Edit entry missing oldText".to_string());
                        }
                        let new = edit
                            .get("newText")
                            .or_else(|| edit.get("new_string"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        edits.push((old, new));
                    }
                } else {
                    let old = args
                        .get("oldText")
                        .or_else(|| args.get("old_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if old.is_empty() {
                        return ToolResult::failure("Missing oldText argument".to_string());
                    }
                    let new = args
                        .get("newText")
                        .or_else(|| args.get("new_string"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    edits.push((old, new));
                }

                // Read file content
                let content = match tokio::fs::read_to_string(&path).await {
                    Ok(c) => c,
                    Err(e) => {
                        let details = EditDetails::new(path.clone())
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!("Failed to read file: {e}"))
                            .with_details(details.to_json());
                    }
                };

                let mut new_content = content.clone();
                let mut replacements_total = 0;
                for (old_text, new_text) in &edits {
                    let positions: Vec<usize> = new_content
                        .match_indices(old_text)
                        .map(|(i, _)| i)
                        .collect();
                    if positions.is_empty() {
                        let details = EditDetails::new(path.clone())
                            .with_replacements(replacements_total)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(
                            "oldText not found in file. Make sure the string matches exactly."
                                .to_string(),
                        )
                        .with_details(details.to_json());
                    }
                    if replace_all && edits.len() == 1 {
                        replacements_total += positions.len();
                        new_content = new_content.replace(old_text, new_text);
                        continue;
                    }
                    let idx = occurrence.saturating_sub(1);
                    if idx >= positions.len() {
                        return ToolResult::failure(format!(
                            "Occurrence {} out of range ({} matches)",
                            occurrence,
                            positions.len()
                        ));
                    }
                    let pos = positions[idx];
                    let mut updated = String::new();
                    updated.push_str(&new_content[..pos]);
                    updated.push_str(new_text);
                    updated.push_str(&new_content[pos + old_text.len()..]);
                    new_content = updated;
                    replacements_total += 1;
                }

                let diff = similar::TextDiff::from_lines(&content, &new_content)
                    .unified_diff()
                    .to_string();

                if dry_run {
                    let details = EditDetails::new(path.clone())
                        .with_replacements(replacements_total)
                        .with_diff(diff)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::success(
                        "Dry run complete (no changes written)".to_string(),
                    )
                    .with_details(details.to_json());
                }

                let tmp_path = format!("{}.{}.tmp", path, uuid::Uuid::new_v4());
                let write_result = async {
                    tokio::fs::write(&tmp_path, &new_content).await?;
                    tokio::fs::rename(&tmp_path, &path).await?;
                    Ok::<(), std::io::Error>(())
                }
                .await;

                if let Err(e) = write_result {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let details = EditDetails::new(path.clone())
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(format!("Failed to write file: {e}"))
                        .with_details(details.to_json());
                }

                let display_path = if raw_path.is_empty() { &path } else { raw_path };
                let mut linter_output = String::new();
                let lsp_diagnostics = match lsp::collect_diagnostics_for_paths(
                    &self.cwd,
                    std::slice::from_ref(&path),
                )
                .await
                {
                    Ok(map) => {
                        if let Some(file_diags) = map.get(&path).or_else(|| map.get(display_path)) {
                            linter_output =
                                lsp::format_lsp_summary(display_path, file_diags.as_slice());
                        }
                        Some(map)
                    }
                    Err(_) => None,
                };

                let validators = match run_validators_with_diagnostics(
                    std::slice::from_ref(&path),
                    lsp_diagnostics.as_ref(),
                )
                .await
                {
                    Ok(results) => Some(results),
                    Err(err) => {
                        let _ = tokio::fs::write(&path, &content).await;
                        return ToolResult::failure(err);
                    }
                };

                self.invalidate_file_cache(&path);

                let mut details = EditDetails::new(path.clone())
                    .with_replacements(replacements_total)
                    .with_diff(diff)
                    .with_duration(start_time.elapsed().as_millis() as u64)
                    .with_line_changes(&content, &new_content);
                if let Some(validators) = validators {
                    details = details.with_validators(validators);
                }

                let mut summary =
                    format!("Successfully replaced {replacements_total} occurrence(s) in {path}");
                if !linter_output.is_empty() {
                    summary.push_str(&linter_output);
                }

                ToolResult::success(summary).with_details(details.to_json())
            }
            "diff" | "Diff" => {
                let start_time = Instant::now();
                // Git diff tool - shows changes in working tree or between commits
                let target = args
                    .get("target")
                    .and_then(|v| v.as_str())
                    .unwrap_or("HEAD");

                let path = args.get("path").and_then(|v| v.as_str());
                let normalized_path = path.map(|raw_path| normalize_git_path(&self.cwd, raw_path));
                let (display_path, git_path) = match normalized_path.transpose() {
                    Ok(Some((display, _))) => (Some(display.clone()), Some(display)),
                    Ok(None) => (None, None),
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                let mut git_args = vec!["diff".to_string(), target.to_string()];
                if let Some(path) = git_path.as_ref() {
                    git_args.push("--".to_string());
                    git_args.push(path.clone());
                }
                let result = match run_process_limited_stdout_lines(
                    "git",
                    &git_args,
                    &self.cwd,
                    30_000,
                    MAX_DIFF_LINES,
                )
                .await
                {
                    Ok(result) => result,
                    Err(message) => {
                        let mut details = DiffDetails::new(target)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        if let Some(p) = display_path.as_ref() {
                            details = details.with_path(p);
                        }
                        return ToolResult::failure(message).with_details(details.to_json());
                    }
                };

                // Build diff details
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let mut details = DiffDetails::new(target).with_duration(duration_ms);

                if let Some(p) = display_path.as_ref() {
                    details = details.with_path(p);
                }

                // Parse diff stats from output (count +/- lines)
                let output_lines = result.stdout.lines().collect::<Vec<_>>();
                let insertions = output_lines
                    .iter()
                    .copied()
                    .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                    .count();
                let deletions = output_lines
                    .iter()
                    .copied()
                    .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                    .count();
                let files_changed = output_lines
                    .iter()
                    .copied()
                    .filter(|line| line.starts_with("diff --git"))
                    .count();

                if files_changed > 0 || insertions > 0 || deletions > 0 {
                    details = details.with_stats(files_changed, insertions, deletions);
                }

                let truncated = result.truncated;
                if truncated {
                    details = details.with_truncation();
                }
                let output = output_lines.join("\n");

                if process_succeeded_or_truncated(&result, &[0]) {
                    ToolResult::success(output).with_details(details.to_json())
                } else {
                    let message = result.stderr.trim();
                    let message = if message.is_empty() {
                        format!("git diff exited with status {}", result.exit_code)
                    } else {
                        message.to_string()
                    };
                    ToolResult::failure(message).with_details(details.to_json())
                }
            }
            "list" | "List" | "ls" => {
                let start_time = Instant::now();
                // Directory listing tool
                let raw_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);
                let (display_path, shell_path) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => {
                        return ToolResult::failure(message);
                    }
                };

                let recursive = args
                    .get("recursive")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);

                let (program, process_args, process_name) =
                    match build_list_process(&display_path, &shell_path, recursive) {
                        Ok(result) => result,
                        Err(message) => {
                            let details = ListDetails::new(&display_path)
                                .with_duration(start_time.elapsed().as_millis() as u64);
                            return ToolResult::failure(message).with_details(details.to_json());
                        }
                    };
                let result = match run_process_limited_stdout_lines(
                    &program,
                    &process_args,
                    &self.cwd,
                    10_000,
                    MAX_LIST_LINES,
                )
                .await
                {
                    Ok(result) => result,
                    Err(message) => {
                        let details = ListDetails::new(&display_path)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(message).with_details(details.to_json());
                    }
                };

                // Build list details
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let output_lines = result.stdout.lines().collect::<Vec<_>>();
                let entries_count = output_lines.len();
                let truncated = result.truncated;
                let output = output_lines.join("\n");

                let mut details = ListDetails::new(&display_path)
                    .with_entries(entries_count)
                    .with_duration(duration_ms);

                if recursive {
                    details = details.with_recursive();
                }

                if truncated {
                    details = details.with_truncation();
                }

                if process_succeeded_or_truncated(&result, &[0]) {
                    ToolResult::success(output).with_details(details.to_json())
                } else {
                    let message = result.stderr.trim();
                    let message = if message.is_empty() {
                        format!("{process_name} exited with status {}", result.exit_code)
                    } else {
                        message.to_string()
                    };
                    ToolResult::failure(message).with_details(details.to_json())
                }
            }
            "find" | "Find" => {
                let start_time = Instant::now();
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                if pattern.is_empty() {
                    return ToolResult::failure("Missing pattern argument".to_string());
                }
                let raw_path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&self.cwd);
                let (display_path, _) = match normalize_shell_path(raw_path) {
                    Ok(result) => result,
                    Err(message) => return ToolResult::failure(message),
                };
                let limit = args
                    .get("limit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(1000)
                    .max(1) as usize;
                let include_hidden = args
                    .get("includeHidden")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let mut rg_args = vec!["--files".to_string(), "--color=never".to_string()];
                if include_hidden {
                    rg_args.push("--hidden".to_string());
                }
                rg_args.push("-g".to_string());
                rg_args.push(pattern.to_string());
                rg_args.push("--".to_string());
                rg_args.push(display_path.clone());

                let result = match run_process_limited_stdout_lines(
                    "rg", &rg_args, &self.cwd, 20_000, limit,
                )
                .await
                {
                    Ok(result) => result,
                    Err(message) => {
                        let details = ListDetails::new(&display_path)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(message).with_details(details.to_json());
                    }
                };

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let output_lines = result.stdout.lines().collect::<Vec<_>>();
                let count = output_lines.len();
                let truncated = result.truncated;
                let output = output_lines.join("\n");
                let mut details = ListDetails::new(&display_path)
                    .with_entries(count)
                    .with_duration(duration_ms);
                if truncated {
                    details = details.with_truncation();
                }

                if process_succeeded_or_truncated(&result, &[0, 1]) {
                    ToolResult::success(output).with_details(details.to_json())
                } else {
                    let message = result.stderr.trim();
                    let message = if message.is_empty() {
                        format!("ripgrep exited with status {}", result.exit_code)
                    } else {
                        message.to_string()
                    };
                    ToolResult::failure(message).with_details(details.to_json())
                }
            }
            "search" | "Search" => self.execute_search(args).await,
            "parallel_ripgrep" | "ParallelRipgrep" => {
                let patterns = args.get("patterns").and_then(|v| v.as_array()).cloned();
                let patterns = match patterns {
                    Some(p) if !p.is_empty() => p,
                    _ => return ToolResult::failure("patterns array required".to_string()),
                };

                let mut combined = Vec::new();
                let mut commands = Vec::new();
                let mut total_matches = 0usize;
                for pattern_value in patterns {
                    let pattern = match pattern_value.as_str() {
                        Some(p) => p.to_string(),
                        None => continue,
                    };
                    let mut search_args = args.clone();
                    if let Some(obj) = search_args.as_object_mut() {
                        obj.insert("pattern".to_string(), Value::String(pattern.clone()));
                        obj.remove("patterns");
                    }
                    let result = self.execute_search(&search_args).await;
                    commands.push(pattern);
                    if result.success {
                        let line_count = result.output.lines().count();
                        total_matches += line_count;
                        combined.push(result.output);
                    } else {
                        combined.push(result.error.unwrap_or_default());
                    }
                }
                let details = serde_json::json!({
                    "commands": commands,
                    "matchCount": total_matches
                });
                ToolResult::success(combined.join("\n\n")).with_details(details)
            }
            "status" | "Status" => status::git_status(args.clone(), &self.cwd).await,
            "background_tasks" => {
                let action = args
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("list");
                match action {
                    "start" => {
                        if let Err(err) = require_plan("background_tasks") {
                            return ToolResult::failure(err);
                        }
                        let command = match args.get("command").and_then(|v| v.as_str()) {
                            Some(cmd) => cmd.to_string(),
                            None => {
                                return ToolResult::failure(
                                    "command required for start".to_string(),
                                )
                            }
                        };
                        let cwd = args
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&self.cwd)
                            .to_string();
                        let shell = args
                            .get("shell")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false);
                        let env = args.get("env").and_then(|v| v.as_object()).map(|map| {
                            map.iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                .collect::<std::collections::HashMap<_, _>>()
                        });
                        match background_tasks::start(command, cwd, self.cwd.clone(), shell, env)
                            .await
                        {
                            Ok(task) => {
                                let details = serde_json::json!({
                                    "id": task.id,
                                    "pid": task.pid,
                                    "status": "running",
                                    "logPath": task.log_path
                                });
                                ToolResult::success(format!("Started task {}", task.id))
                                    .with_details(details)
                            }
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    "stop" => {
                        let id = match args.get("taskId").and_then(|v| v.as_str()) {
                            Some(id) => id,
                            None => {
                                return ToolResult::failure("taskId required for stop".to_string())
                            }
                        };
                        match background_tasks::stop(id) {
                            Ok(task) => ToolResult::success(format!("Stopped task {}", task.id)),
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    "logs" => {
                        let id = match args.get("taskId").and_then(|v| v.as_str()) {
                            Some(id) => id,
                            None => {
                                return ToolResult::failure("taskId required for logs".to_string())
                            }
                        };
                        let lines = args
                            .get("lines")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(40) as usize;
                        match background_tasks::logs(id, lines) {
                            Ok(logs) => ToolResult::success(logs),
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    "waitForRotation" | "wait_for_rotation" => {
                        let id = match args.get("taskId").and_then(|v| v.as_str()) {
                            Some(id) => id,
                            None => {
                                return ToolResult::failure(
                                    "taskId required for waitForRotation".to_string(),
                                )
                            }
                        };
                        let timeout_ms = args
                            .get("timeoutMs")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(5000);
                        match background_tasks::wait_for_rotation(
                            id,
                            Duration::from_millis(timeout_ms),
                        )
                        .await
                        {
                            Ok(info) => {
                                let rotated_at = info
                                    .rotated_at
                                    .duration_since(SystemTime::UNIX_EPOCH)
                                    .ok()
                                    .map(|duration| duration.as_millis() as u64);
                                let details = serde_json::json!({
                                    "logPath": info.log_path.to_string_lossy(),
                                    "archivePath": info.archive_path.to_string_lossy(),
                                    "rotatedAt": rotated_at
                                });
                                ToolResult::success(format!("Log rotated for task {}", id))
                                    .with_details(details)
                            }
                            Err(err) => ToolResult::failure(err),
                        }
                    }
                    _ => {
                        let tasks = background_tasks::list();
                        let summary = tasks
                            .iter()
                            .map(|t| {
                                let mut line = format!("{} {:?} {}", t.id, t.status, t.command);
                                if t.log_write_failed {
                                    if let Some(reason) = &t.log_write_error {
                                        let reason = reason.replace(['\n', '\r'], " ");
                                        line.push_str(&format!(" [log write failed: {reason}]"));
                                    } else {
                                        line.push_str(" [log write failed]");
                                    }
                                }
                                line
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        let details = serde_json::json!({ "count": tasks.len() });
                        ToolResult::success(if summary.is_empty() {
                            "No background tasks".to_string()
                        } else {
                            summary
                        })
                        .with_details(details)
                    }
                }
            }
            "todo" => todo::todo(args.clone()).await,
            "ask_user" => ask_user::ask_user(args.clone()),
            "extract_document" => extract_document::extract_document(args.clone()).await,
            "notebook_edit" => notebook_edit::notebook_edit(args.clone(), &self.cwd).await,
            "websearch" => exa::websearch(args.clone()).await,
            "codesearch" => exa::codesearch(args.clone()).await,
            "gh_pr" => gh::gh_pr(args.clone(), &self.cwd).await,
            "gh_issue" => gh::gh_issue(args.clone()).await,
            "gh_repo" => gh::gh_repo(args.clone(), &self.cwd).await,
            "mcp_list_resources" => {
                let server_filter = args.get("server").and_then(|v| v.as_str());
                let client = match self.ensure_mcp_client().await {
                    Ok(client) => client,
                    Err(err) => return ToolResult::failure(err),
                };

                let mut resources = client.list_all_resources().await;
                if let Some(filter) = server_filter {
                    resources.retain(|(name, _)| name == filter);
                }

                let mut servers = Vec::new();
                for (name, uris) in resources {
                    if uris.is_empty() {
                        continue;
                    }
                    servers.push(serde_json::json!({
                        "name": name,
                        "resources": uris
                    }));
                }

                if servers.is_empty() {
                    return ToolResult::success(
                        "No MCP resources available. Either no servers are connected or they don't expose resources.".to_string(),
                    )
                    .with_details(serde_json::json!({ "servers": [] }));
                }

                let mut lines = Vec::new();
                lines.push("# Available MCP Resources".to_string());
                lines.push(String::new());
                for server in &servers {
                    let name = server
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    lines.push(format!("## {name}"));
                    if let Some(resources) = server.get("resources").and_then(|v| v.as_array()) {
                        for uri in resources {
                            if let Some(uri_str) = uri.as_str() {
                                lines.push(format!("- {uri_str}"));
                            }
                        }
                    }
                    lines.push(String::new());
                }

                ToolResult::success(lines.join("\n"))
                    .with_details(serde_json::json!({ "servers": servers }))
            }
            "mcp_list_prompts" => {
                let server_filter = args.get("server").and_then(|v| v.as_str());
                let prompt_servers = match self.mcp_prompt_details(server_filter).await {
                    Ok(entries) => entries,
                    Err(err) => return ToolResult::failure(err),
                };

                let mut servers = Vec::new();
                let mut lines = Vec::new();
                lines.push("# Available MCP Prompts".to_string());
                lines.push(String::new());
                for (name, prompts) in prompt_servers {
                    if prompts.is_empty() {
                        continue;
                    }
                    lines.push(format!("## {name}"));
                    for prompt in &prompts {
                        append_mcp_prompt_summary(&mut lines, prompt, "- ", "  ");
                    }
                    lines.push(String::new());
                    servers.push(serde_json::json!({
                        "name": name,
                        "prompts": prompts
                    }));
                }

                if servers.is_empty() {
                    return ToolResult::success(
                        "No MCP prompts available. Either no servers are connected or they don't expose prompts.".to_string(),
                    )
                    .with_details(serde_json::json!({ "servers": [] }));
                }

                ToolResult::success(lines.join("\n"))
                    .with_details(serde_json::json!({ "servers": servers }))
            }
            "mcp_read_resource" => {
                let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
                let uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                if server.is_empty() || uri.is_empty() {
                    return ToolResult::failure("server and uri are required".to_string());
                }

                let client = match self.ensure_mcp_client().await {
                    Ok(client) => client,
                    Err(err) => return ToolResult::failure(err),
                };

                match client.read_resource(server, uri).await {
                    Ok(result) => {
                        if result.contents.is_empty() {
                            return ToolResult::success(format!("Resource '{uri}' is empty."))
                                .with_details(serde_json::json!({
                                    "server": server,
                                    "uri": uri,
                                    "contents": []
                                }));
                        }

                        let text_output = result
                            .contents
                            .iter()
                            .filter_map(|content| content.text.clone())
                            .collect::<Vec<_>>()
                            .join("\n---\n");
                        let output = if text_output.is_empty() {
                            serde_json::to_string_pretty(&result.contents).unwrap_or_else(|_| {
                                "MCP resource returned non-text content".to_string()
                            })
                        } else {
                            text_output
                        };

                        ToolResult::success(output).with_details(serde_json::json!({
                            "server": server,
                            "uri": uri,
                            "contents": result.contents
                        }))
                    }
                    Err(err) => ToolResult::failure(format!("Failed to read MCP resource: {err}")),
                }
            }
            "mcp_get_prompt" => {
                let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if server.is_empty() || name.is_empty() {
                    return ToolResult::failure("server and name are required".to_string());
                }

                let arguments = args
                    .get("arguments")
                    .and_then(|v| v.as_object())
                    .map(|obj| {
                        obj.iter()
                            .map(|(key, value)| {
                                let value = match value {
                                    serde_json::Value::String(s) => s.clone(),
                                    other => other.to_string(),
                                };
                                (key.clone(), value)
                            })
                            .collect::<HashMap<String, String>>()
                    });

                let client = match self.ensure_mcp_client().await {
                    Ok(client) => client,
                    Err(err) => return ToolResult::failure(err),
                };

                match client.get_prompt(server, name, arguments).await {
                    Ok(result) => {
                        let description = result.description.clone();
                        let messages = result.messages;
                        let mut lines = Vec::new();
                        lines.push(format!("Prompt: {name}"));
                        if let Some(desc) = &description {
                            lines.push(String::new());
                            lines.push(format!("Description: {desc}"));
                        }
                        lines.push(String::new());
                        for msg in &messages {
                            lines.push(format!("[{}]", msg.role));
                            let content = msg.content.as_text().unwrap_or("[non-text content]");
                            lines.push(content.to_string());
                            lines.push(String::new());
                        }

                        ToolResult::success(lines.join("\n")).with_details(serde_json::json!({
                            "server": server,
                            "name": name,
                            "description": description,
                            "messages": messages,
                        }))
                    }
                    Err(err) => ToolResult::failure(format!("Failed to get MCP prompt: {err}")),
                }
            }
            "vscode_get_diagnostics" | "jetbrains_get_diagnostics" => {
                let uri = args.get("uri").and_then(|v| v.as_str());
                let diagnostics = if let Some(uri) = uri {
                    let uri = normalize_uri_input(uri);
                    let path = match resolve_tool_path(&self.cwd, &uri) {
                        Ok(resolved) => resolved,
                        Err(message) => return ToolResult::failure(message),
                    };
                    match lsp::diagnostics_for_file(&self.cwd, &path).await {
                        Ok(entries) => entries,
                        Err(err) => return ToolResult::failure(err),
                    }
                } else {
                    match lsp::collect_workspace_diagnostics(&self.cwd).await {
                        Ok(map) => map.values().flat_map(|entries| entries.clone()).collect(),
                        Err(err) => return ToolResult::failure(err),
                    }
                };

                let output =
                    serde_json::to_string_pretty(&diagnostics).unwrap_or_else(|_| "[]".to_string());
                ToolResult::success(output)
            }
            "vscode_get_definition" | "jetbrains_get_definition" => {
                let raw_uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                if raw_uri.is_empty() {
                    return ToolResult::failure("uri is required".to_string());
                }
                let line = match args.get("line").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as u32,
                    _ => {
                        return ToolResult::failure(
                            "line must be a non-negative integer".to_string(),
                        )
                    }
                };
                let character = match args.get("character").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as u32,
                    _ => {
                        return ToolResult::failure(
                            "character must be a non-negative integer".to_string(),
                        )
                    }
                };

                let uri = normalize_uri_input(raw_uri);
                let path = match resolve_tool_path(&self.cwd, &uri) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                let locations =
                    match lsp::definition_for_position(&self.cwd, &path, line, character).await {
                        Ok(entries) => entries,
                        Err(err) => return ToolResult::failure(err),
                    };
                let normalized: Vec<_> = locations
                    .into_iter()
                    .map(|mut location| {
                        location.uri = normalize_uri_input(&location.uri);
                        location
                    })
                    .collect();

                let output =
                    serde_json::to_string_pretty(&normalized).unwrap_or_else(|_| "[]".to_string());
                ToolResult::success(output)
            }
            "vscode_find_references" | "jetbrains_find_references" => {
                let raw_uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                if raw_uri.is_empty() {
                    return ToolResult::failure("uri is required".to_string());
                }
                let line = match args.get("line").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as u32,
                    _ => {
                        return ToolResult::failure(
                            "line must be a non-negative integer".to_string(),
                        )
                    }
                };
                let character = match args.get("character").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as u32,
                    _ => {
                        return ToolResult::failure(
                            "character must be a non-negative integer".to_string(),
                        )
                    }
                };
                let include_declaration = args
                    .get("includeDeclaration")
                    .or_else(|| args.get("include_declaration"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                let uri = normalize_uri_input(raw_uri);
                let path = match resolve_tool_path(&self.cwd, &uri) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                let locations = match lsp::references_for_position(
                    &self.cwd,
                    &path,
                    line,
                    character,
                    include_declaration,
                )
                .await
                {
                    Ok(entries) => entries,
                    Err(err) => return ToolResult::failure(err),
                };
                let normalized: Vec<_> = locations
                    .into_iter()
                    .map(|mut location| {
                        location.uri = normalize_uri_input(&location.uri);
                        location
                    })
                    .collect();

                let output =
                    serde_json::to_string_pretty(&normalized).unwrap_or_else(|_| "[]".to_string());
                ToolResult::success(output)
            }
            "vscode_read_file_range" | "jetbrains_read_file_range" => {
                let start_time = Instant::now();
                let raw_uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                if raw_uri.is_empty() {
                    return ToolResult::failure("uri is required".to_string());
                }
                let start_line = match args.get("startLine").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as usize,
                    _ => {
                        return ToolResult::failure(
                            "startLine must be a non-negative integer".to_string(),
                        )
                    }
                };
                let end_line = match args.get("endLine").and_then(serde_json::Value::as_i64) {
                    Some(value) if value >= 0 => value as usize,
                    _ => {
                        return ToolResult::failure(
                            "endLine must be a non-negative integer".to_string(),
                        )
                    }
                };

                let uri = normalize_uri_input(raw_uri);
                let path = match resolve_tool_path(&self.cwd, &uri) {
                    Ok(resolved) => resolved,
                    Err(message) => return ToolResult::failure(message),
                };

                let (output, lines_read) = match read_file_range(&path, start_line, end_line).await
                {
                    Ok(result) => result,
                    Err(err) => return ToolResult::failure(err),
                };

                let size_bytes = tokio::fs::metadata(&path).await.ok().map(|m| m.len());
                let mut details = ReadDetails::new(path.clone())
                    .with_lines(lines_read)
                    .with_offset(Some(start_line + 1))
                    .with_limit(Some(end_line.saturating_sub(start_line) + 1))
                    .with_duration(start_time.elapsed().as_millis() as u64);
                if let Some(size) = size_bytes {
                    details = details.with_size(size);
                }

                ToolResult::success(output).with_details(details.to_json())
            }
            "web_fetch" | "WebFetch" | "webfetch" => {
                let fetch_args: WebFetchArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid web_fetch arguments: {e}"));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.web_fetch.execute(fetch_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "read_image" | "ReadImage" | "readimage" => {
                let image_args: ReadImageArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid read_image arguments: {e}"));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.image.read_image(image_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            "screenshot" | "Screenshot" => {
                let screenshot_args: ScreenshotArgs = match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return ToolResult::failure(format!("Invalid screenshot arguments: {e}"));
                    }
                };

                // Send tool start event
                if let Some(tx) = event_tx {
                    let _ = tx.send(FromAgent::ToolStart {
                        call_id: call_id.to_string(),
                    });
                }

                let result = self.image.screenshot(screenshot_args).await;

                // Send tool output event
                if let Some(tx) = event_tx {
                    if !result.output.is_empty() {
                        let _ = tx.send(FromAgent::ToolOutput {
                            call_id: call_id.to_string(),
                            content: result.output.clone(),
                        });
                    }

                    let _ = tx.send(FromAgent::ToolEnd {
                        call_id: call_id.to_string(),
                        success: result.success,
                    });
                }

                result
            }
            _ => {
                // Check if this is an inline tool
                let tool_key = tool_name.to_lowercase();
                if let Some(inline_tool) = self.inline_tools.get(&tool_key) {
                    // Send tool start event
                    if let Some(tx) = event_tx {
                        let _ = tx.send(FromAgent::ToolStart {
                            call_id: call_id.to_string(),
                        });
                    }

                    let result = self
                        .inline_executor
                        .execute(inline_tool, args.clone())
                        .await;

                    // Send tool output and end events
                    if let Some(tx) = event_tx {
                        if !result.output.is_empty() {
                            let _ = tx.send(FromAgent::ToolOutput {
                                call_id: call_id.to_string(),
                                content: result.output.clone(),
                            });
                        }

                        let _ = tx.send(FromAgent::ToolEnd {
                            call_id: call_id.to_string(),
                            success: result.success,
                        });
                    }

                    result
                } else {
                    ToolResult::failure(format!("Unknown tool: {tool_name}"))
                }
            }
        }
    }
}

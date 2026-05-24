use std::env;
use std::io::Read;
use std::path::Path;
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const MARKITDOWN_EXTRACT_TIMEOUT: Duration = Duration::from_secs(20);
static MARKITDOWN_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
        .unwrap_or(false)
}

fn env_flag_disabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            )
        })
        .unwrap_or(false)
}

fn markitdown_preferred() -> bool {
    env_flag_enabled("MAESTRO_MARKITDOWN_PREFER")
}

fn markitdown_disabled() -> bool {
    env_flag_disabled("MAESTRO_MARKITDOWN")
}

pub(crate) fn should_prefer_markitdown() -> bool {
    markitdown_preferred() && !markitdown_disabled()
}

fn split_command_args(value: Option<String>) -> Result<Vec<String>, String> {
    let input = value.unwrap_or_default();
    let input = input.trim();
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut token_started = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                current.push(ch);
            }
            token_started = true;
            continue;
        }

        if quote == Some('"') {
            if ch == '"' {
                quote = None;
                token_started = true;
                continue;
            }
            if ch == '\\' {
                if let Some(&next) = chars.peek() {
                    if matches!(next, '"' | '\\' | '$' | '`' | '\n') {
                        current.push(next);
                        chars.next();
                    } else {
                        current.push(ch);
                    }
                } else {
                    current.push(ch);
                }
                token_started = true;
                continue;
            }
            current.push(ch);
            token_started = true;
            continue;
        }

        if ch == '\\' {
            if let Some(&next) = chars.peek() {
                if next.is_whitespace() || matches!(next, '\'' | '"' | '\\') {
                    current.push(next);
                    chars.next();
                } else {
                    current.push(ch);
                }
            } else {
                current.push(ch);
            }
            token_started = true;
            continue;
        }

        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            token_started = true;
            continue;
        }

        if ch.is_whitespace() {
            if token_started {
                args.push(std::mem::take(&mut current));
                token_started = false;
            }
            continue;
        }

        current.push(ch);
        token_started = true;
    }

    if quote.is_some() {
        return Err("Unterminated quote in MAESTRO_MARKITDOWN_ARGS".to_string());
    }

    if token_started {
        args.push(current);
    }
    Ok(args)
}

fn markitdown_candidates() -> Result<Vec<(String, Vec<String>)>, String> {
    if let Ok(command) = env::var("MAESTRO_MARKITDOWN_CMD") {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(vec![(
                command.to_string(),
                split_command_args(env::var("MAESTRO_MARKITDOWN_ARGS").ok())?,
            )]);
        }
    }
    Ok(vec![
        ("markitdown".to_string(), Vec::new()),
        ("uvx".to_string(), vec!["markitdown".to_string()]),
    ])
}

pub(crate) fn should_try_markitdown(
    format: &str,
    file_name: &str,
    mime_type: Option<&str>,
) -> bool {
    if markitdown_disabled() {
        return false;
    }
    if markitdown_preferred() {
        return true;
    }
    let lower_name = file_name.to_ascii_lowercase();
    let mime_type = mime_type.unwrap_or("").to_ascii_lowercase();
    format == "unknown"
        || lower_name.ends_with(".html")
        || lower_name.ends_with(".htm")
        || mime_type.contains("text/html")
}

fn read_markitdown_pipe<R>(mut pipe: R) -> thread::JoinHandle<std::io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        pipe.read_to_end(&mut output)?;
        Ok(output)
    })
}

fn join_markitdown_pipe(
    name: &str,
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("MarkItDown {name} reader panicked"))?
        .map_err(|error| format!("failed to read MarkItDown {name}: {error}"))
}

#[cfg(unix)]
fn set_markitdown_process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            let _ = libc::setpgid(0, 0);
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn set_markitdown_process_group(_command: &mut std::process::Command) {}

fn kill_markitdown_process(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            let pgid = unsafe { libc::getpgid(pid) };
            if pgid > 0 && pgid == pid {
                unsafe {
                    let _ = libc::kill(-pgid, libc::SIGKILL);
                }
            }
        }
    }

    let _ = child.kill();
}

fn run_markitdown_command(command: &str, args: &[String]) -> Result<String, String> {
    let mut process = std::process::Command::new(command);
    process
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    set_markitdown_process_group(&mut process);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let stdout_reader = child
        .stdout
        .take()
        .map(read_markitdown_pipe)
        .ok_or_else(|| "failed to capture MarkItDown stdout".to_string())?;
    let stderr_reader = child
        .stderr
        .take()
        .map(read_markitdown_pipe)
        .ok_or_else(|| "failed to capture MarkItDown stderr".to_string())?;
    let mut stdout_reader = Some(stdout_reader);
    let mut stderr_reader = Some(stderr_reader);
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to wait for MarkItDown: {error}"))?
        {
            let stdout = join_markitdown_pipe(
                "stdout",
                stdout_reader
                    .take()
                    .ok_or_else(|| "missing MarkItDown stdout reader".to_string())?,
            )?;
            let stderr = join_markitdown_pipe(
                "stderr",
                stderr_reader
                    .take()
                    .ok_or_else(|| "missing MarkItDown stderr reader".to_string())?,
            )?;
            if status.success() {
                return String::from_utf8(stdout)
                    .map_err(|_| "MarkItDown output was not UTF-8".to_string());
            }
            let stderr = String::from_utf8_lossy(&stderr);
            return Err(format!(
                "MarkItDown exited with {}{}",
                status,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", stderr.chars().take(500).collect::<String>())
                }
            ));
        }
        if started.elapsed() > MARKITDOWN_EXTRACT_TIMEOUT {
            kill_markitdown_process(&mut child);
            let _ = child.wait();
            return Err("MarkItDown conversion timed out".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

pub(crate) fn extract_with_markitdown(
    bytes: &[u8],
    file_name: &str,
    mime_type: Option<&str>,
) -> Result<Option<String>, String> {
    if markitdown_disabled() {
        return Ok(None);
    }
    let counter = MARKITDOWN_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let temp_dir =
        env::temp_dir().join(format!("maestro-markitdown-{}-{}", process::id(), counter));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("failed to create MarkItDown temp dir: {error}"))?;
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .unwrap_or("bin");
    let input_path = temp_dir.join(format!("input.{extension}"));
    let result = (|| {
        std::fs::write(&input_path, bytes)
            .map_err(|error| format!("failed to write MarkItDown input: {error}"))?;
        let mut last_error: Option<String> = None;
        for (command, prefix_args) in markitdown_candidates()? {
            let mut args = prefix_args;
            args.push(input_path.to_string_lossy().to_string());
            if let Some(mime_type) = mime_type {
                args.push("--mime-type".to_string());
                args.push(mime_type.to_string());
            }
            match run_markitdown_command(&command, &args) {
                Ok(output) => {
                    let text = output.trim().to_string();
                    if !text.is_empty() {
                        return Ok(Some(text));
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            }
        }
        if env::var("MAESTRO_MARKITDOWN_CMD")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Err(format!(
                "MarkItDown extraction failed: {}",
                last_error.unwrap_or_else(|| "no output".to_string())
            ));
        }
        Ok(None)
    })();
    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_script_path(name: &str) -> std::path::PathBuf {
        env::temp_dir().join(format!(
            "maestro-{name}-markitdown-{}-{}.sh",
            process::id(),
            MARKITDOWN_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn split_command_args_preserves_quoted_values() {
        let args = split_command_args(Some(
            r#"--script "/tmp/maestro markitdown/run.py" --flag='quoted value' --mime text/html"#
                .to_string(),
        ))
        .expect("quoted MarkItDown args should parse");

        assert_eq!(
            args,
            vec![
                "--script",
                "/tmp/maestro markitdown/run.py",
                "--flag=quoted value",
                "--mime",
                "text/html",
            ]
        );
    }

    #[test]
    fn split_command_args_preserves_windows_backslashes() {
        let quoted = split_command_args(Some(
            r#""C:\Program Files\markitdown\runner.py" --cache "C:\Users\me\Cache Dir""#
                .to_string(),
        ))
        .expect("quoted Windows MarkItDown args should parse");
        assert_eq!(
            quoted,
            vec![
                r"C:\Program Files\markitdown\runner.py",
                "--cache",
                r"C:\Users\me\Cache Dir",
            ]
        );

        let unquoted = split_command_args(Some(
            r"C:\tools\markitdown.py --flag C:\tmp\document.html".to_string(),
        ))
        .expect("unquoted Windows MarkItDown args should parse");
        assert_eq!(
            unquoted,
            vec![r"C:\tools\markitdown.py", "--flag", r"C:\tmp\document.html",]
        );
    }

    #[test]
    fn split_command_args_rejects_unterminated_quotes() {
        let error = split_command_args(Some(r#"--flag "unterminated"#.to_string()))
            .expect_err("unterminated MarkItDown args should fail");

        assert!(error.contains("Unterminated quote"));
    }

    #[test]
    fn run_markitdown_command_drains_large_stdout_before_waiting() {
        let script_path = unique_script_path("large");
        std::fs::write(
            &script_path,
            "i=0\nwhile [ \"$i\" -lt 12000 ]; do\n  printf '0123456789abcdef0123456789abcdef\\n'\n  i=$((i + 1))\ndone\nprintf 'MARKITDOWN_DONE\\n'\n",
        )
        .expect("large fake MarkItDown script should be written");

        let output = run_markitdown_command("sh", &[script_path.to_string_lossy().to_string()])
            .expect("large MarkItDown output should not deadlock");

        assert!(output.len() > 200_000);
        assert!(output.contains("MARKITDOWN_DONE"));

        let _ = std::fs::remove_file(script_path);
    }

    #[test]
    fn run_markitdown_command_timeout_does_not_wait_for_inherited_pipe_handles() {
        let script_path = unique_script_path("timeout");
        std::fs::write(&script_path, "sleep 28 &\nsleep 28\n")
            .expect("timeout fake MarkItDown script should be written");

        let started = Instant::now();
        let error = run_markitdown_command("sh", &[script_path.to_string_lossy().to_string()])
            .expect_err("timed-out MarkItDown command should fail");
        let elapsed = started.elapsed();

        assert_eq!(error, "MarkItDown conversion timed out");
        assert!(
            elapsed < MARKITDOWN_EXTRACT_TIMEOUT + Duration::from_secs(4),
            "timeout path waited for inherited pipe handles for {elapsed:?}"
        );

        let _ = std::fs::remove_file(script_path);
    }
}

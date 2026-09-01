//! Tool output truncation helpers.
//!
//! Mirrors the TypeScript TUI clamp behavior with configurable limits and
//! a human-readable truncation banner.

use std::path::{Path, PathBuf};

const DEFAULT_TOOL_MAX_CHARS: usize = 12000;
const DEFAULT_TOOL_MAX_LINES: usize = 200;

pub struct ToolOutputLimits {
    pub max_chars: usize,
    pub max_lines: usize,
}

pub struct ToolOutputClamp {
    pub text: String,
    pub truncated: bool,
    pub omitted_chars: usize,
    pub omitted_lines: usize,
}

fn parse_limit(raw: Option<String>, fallback: usize) -> usize {
    raw.and_then(|value| value.parse::<isize>().ok())
        .filter(|value| *value >= 0)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}

pub fn tool_output_limits() -> ToolOutputLimits {
    ToolOutputLimits {
        max_chars: parse_limit(
            std::env::var("MAESTRO_TUI_TOOL_MAX_CHARS").ok(),
            DEFAULT_TOOL_MAX_CHARS,
        ),
        max_lines: parse_limit(
            std::env::var("MAESTRO_TUI_TOOL_MAX_LINES").ok(),
            DEFAULT_TOOL_MAX_LINES,
        ),
    }
}

pub fn clamp_tool_output(output: &str, limits: ToolOutputLimits) -> ToolOutputClamp {
    if output.is_empty() {
        return ToolOutputClamp {
            text: String::new(),
            truncated: false,
            omitted_chars: 0,
            omitted_lines: 0,
        };
    }

    let mut text = output.to_string();
    let mut omitted_lines = 0;
    if limits.max_lines > 0 {
        let lines: Vec<&str> = output.lines().collect();
        if lines.len() > limits.max_lines {
            omitted_lines = lines.len() - limits.max_lines;
            text = lines[..limits.max_lines].join("\n");
        }
    }

    let mut omitted_chars = 0;
    if limits.max_chars > 0 {
        let text_len = text.chars().count();
        if text_len > limits.max_chars {
            omitted_chars = text_len - limits.max_chars;
            text = text.chars().take(limits.max_chars).collect();
        }
    }

    let truncated = omitted_lines > 0 || omitted_chars > 0;
    ToolOutputClamp {
        text,
        truncated,
        omitted_chars,
        omitted_lines,
    }
}

pub fn format_tool_output_truncation(result: &ToolOutputClamp) -> Option<String> {
    if !result.truncated {
        return None;
    }
    let mut parts = Vec::new();
    if result.omitted_lines > 0 {
        parts.push(format!("{} lines", result.omitted_lines));
    }
    if result.omitted_chars > 0 {
        parts.push(format!("{} chars", result.omitted_chars));
    }
    let detail = parts.join(", ");
    if detail.is_empty() {
        None
    } else {
        Some(format!("[output truncated: {detail} omitted]"))
    }
}

// ---------------------------------------------------------------------------
// Model-facing bounds
// ---------------------------------------------------------------------------
//
// The clamp above is a *renderer* limit: it decides how much of a tool result
// the TUI paints. Nothing bounded the copy of that same result that is put
// into `ContentBlock::ToolResult` and sent to the provider, so a single MCP
// call or `cargo test` run could push megabytes of text into conversation
// history and session storage. Output above a spill threshold is therefore
// written to a file when the model can retrieve it. Otherwise it is bounded
// inline, keeping both the head and the tail because command summaries and
// failure verdicts commonly appear at the end.

/// Byte size above which a model-facing tool result is spilled to a file
/// instead of being inlined into conversation history.
pub const MODEL_TOOL_SPILL_THRESHOLD_BYTES: usize = 40_000;

/// Hard byte cap applied to inline text when the spill file cannot be written.
/// Half is kept from the head and half from the tail.
pub const MODEL_TOOL_HARD_LIMIT_BYTES: usize = 200_000;

/// Upper bound on a single spill file. This matches the `read` tool's maximum
/// whole-file size so every pointer emitted here remains retrievable.
pub const MODEL_TOOL_SPILL_FILE_MAX_BYTES: usize = 10 * 1024 * 1024;

fn model_tool_spill_dir_in_sessions(sessions_dir: &Path, session_id: &str) -> PathBuf {
    sessions_dir
        .join("tool-output")
        .join(crate::session::sanitize_path_for_dirname(session_id))
}

/// Directory that holds spilled tool output for a workspace and session.
///
/// This lives beside the session transcript under `~/.composer/agent/sessions`,
/// never inside the project directory: spilled output is agent scratch, and
/// writing it into the workspace would show up as untracked files in the
/// user's repository.
#[must_use]
pub fn model_tool_spill_dir(cwd: &str, session_id: &str) -> PathBuf {
    model_tool_spill_dir_in_sessions(&crate::session::sessions_dir(cwd), session_id)
}

/// Remove model-facing spill files owned by a deleted session.
///
/// Session deletion and retention pruning call this after the transcript has
/// been removed so a failed transcript deletion never invalidates pointers in
/// a still-live conversation.
pub(crate) fn remove_model_tool_spill_dir(
    sessions_dir: &Path,
    session_id: &str,
) -> std::io::Result<()> {
    let spill_dir = model_tool_spill_dir_in_sessions(sessions_dir, session_id);
    match std::fs::remove_dir_all(&spill_dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir(spill_dir.parent().unwrap_or(sessions_dir));
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// What the model is given for one tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelToolPayload {
    /// Text small enough to sit in conversation history directly.
    Inline(String),
    /// Text written to `path`; the model receives a pointer line instead.
    Spilled {
        path: PathBuf,
        bytes: usize,
        lines: usize,
    },
}

impl ModelToolPayload {
    /// True when the payload was written to a file rather than inlined.
    #[must_use]
    pub fn is_spilled(&self) -> bool {
        matches!(self, Self::Spilled { .. })
    }

    /// The exact text placed in `ContentBlock::ToolResult`.
    #[must_use]
    pub fn into_model_text(self) -> String {
        match self {
            Self::Inline(text) => text,
            Self::Spilled { path, bytes, lines } => format!(
                "Large output has been written to: {} ({}, {lines} lines)\n\
                 Read it with the `read` tool (it accepts an offset and a limit).",
                path.display(),
                format_spill_size(bytes)
            ),
        }
    }
}

fn format_spill_size(bytes: usize) -> String {
    if bytes >= 1024 {
        #[allow(clippy::cast_precision_loss)]
        let kb = bytes as f64 / 1024.0;
        format!("{kb:.1} KB")
    } else {
        format!("{bytes} bytes")
    }
}

/// Largest index `<= index` that is a UTF-8 char boundary of `s`.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest index `>= index` that is a UTF-8 char boundary of `s`.
fn ceil_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Keep the first and last `max_bytes / 2` bytes of `text`, with an explicit
/// marker naming how much was dropped.
///
/// Head-only truncation discards exactly the part that carries the verdict: a
/// `cargo test` or `npm install` failure prints its summary last.
#[must_use]
pub fn truncate_head_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let half = max_bytes / 2;
    let head_end = floor_char_boundary(text, half);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(half));
    if tail_start <= head_end {
        return text.to_string();
    }
    let elided = tail_start - head_end;
    format!(
        "{}\n\n[... {elided} bytes elided ...]\n\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

fn spill_to_file(dir: &Path, tool: &str, text: &str) -> std::io::Result<ModelToolPayload> {
    // Leave room for the explicit omission marker so the file itself remains
    // within the advertised hard cap even when the byte count is 20 digits.
    let content = truncate_head_tail(text, MODEL_TOOL_SPILL_FILE_MAX_BYTES.saturating_sub(128));
    crate::fs_atomic::create_dir_all_synced(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        if let Some(tool_output_dir) = dir.parent() {
            if tool_output_dir.file_name().and_then(|name| name.to_str()) == Some("tool-output") {
                std::fs::set_permissions(tool_output_dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    let safe_tool: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = format!("{safe_tool}-{}.txt", uuid::Uuid::new_v4().simple());
    let path = dir.join(name);
    crate::fs_atomic::write_atomic_private(&path, &content)?;
    Ok(ModelToolPayload::Spilled {
        path,
        bytes: content.len(),
        lines: content.lines().count(),
    })
}

/// Bound and sanitize one tool result before it reaches the model.
///
/// Every result is stripped of terminal control characters (NUL, C0, C1;
/// tab/newline/carriage return survive) via
/// [`crate::output_sanitize::sanitize_control_chars`]. Results at or below
/// [`MODEL_TOOL_SPILL_THRESHOLD_BYTES`] are returned inline. Larger results
/// are written to `session_scratch_dir` and replaced by a pointer line. If no
/// scratch directory is available, or the write fails, the text is truncated
/// head-and-tail at [`MODEL_TOOL_HARD_LIMIT_BYTES`] so the result is still
/// bounded.
#[must_use]
pub fn clamp_for_model(
    text: &str,
    tool: &str,
    session_scratch_dir: Option<&Path>,
) -> ModelToolPayload {
    let sanitized = crate::output_sanitize::sanitize_control_chars(text);
    if sanitized.len() <= MODEL_TOOL_SPILL_THRESHOLD_BYTES {
        return ModelToolPayload::Inline(sanitized);
    }
    if let Some(dir) = session_scratch_dir {
        if let Ok(payload) = spill_to_file(dir, tool, &sanitized) {
            return payload;
        }
    }
    ModelToolPayload::Inline(truncate_head_tail(&sanitized, MODEL_TOOL_HARD_LIMIT_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_tool_output_respects_line_limit() {
        let limits = ToolOutputLimits {
            max_chars: 0,
            max_lines: 2,
        };
        let output = "a\nb\nc";
        let result = clamp_tool_output(output, limits);
        assert_eq!(result.text, "a\nb");
        assert_eq!(result.omitted_lines, 1);
        assert!(result.truncated);
    }

    #[test]
    fn clamp_tool_output_respects_char_limit() {
        let limits = ToolOutputLimits {
            max_chars: 4,
            max_lines: 0,
        };
        let output = "hello";
        let result = clamp_tool_output(output, limits);
        assert_eq!(result.text, "hell");
        assert_eq!(result.omitted_chars, 1);
        assert!(result.truncated);
    }

    #[test]
    fn format_truncation_banner() {
        let result = ToolOutputClamp {
            text: "ok".to_string(),
            truncated: true,
            omitted_chars: 2,
            omitted_lines: 3,
        };
        assert_eq!(
            format_tool_output_truncation(&result),
            Some("[output truncated: 3 lines, 2 chars omitted]".to_string())
        );
    }

    #[test]
    fn clamp_for_model_inlines_small_output_and_strips_nul() {
        let payload = clamp_for_model("ok\u{0}done", "bash", None);
        assert_eq!(payload, ModelToolPayload::Inline("okdone".to_string()));
        assert!(!payload.into_model_text().contains('\u{0}'));
    }

    #[test]
    fn clamp_for_model_spills_large_output_to_a_one_line_pointer() {
        let dir = tempfile::TempDir::new().unwrap();
        let scratch = dir.path().join("tool-output");
        let body = "x".repeat(5 * 1024 * 1024);
        let payload = clamp_for_model(&body, "mcp__server__tool", Some(&scratch));

        let ModelToolPayload::Spilled { path, bytes, lines } = payload.clone() else {
            panic!("5 MB result must spill, got {payload:?}");
        };
        assert_eq!(bytes, body.len());
        assert_eq!(lines, 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body);

        let text = payload.into_model_text();
        let pointer = text.lines().next().unwrap();
        assert!(pointer.starts_with("Large output has been written to: "));
        assert!(pointer.contains(&path.display().to_string()));
        assert!(text.len() < 500);
    }

    #[test]
    fn clamp_for_model_removes_nul_before_spilling() {
        let dir = tempfile::TempDir::new().unwrap();
        let body = format!("{}\u{0}{}", "a".repeat(60_000), "b".repeat(60_000));
        let payload = clamp_for_model(&body, "bash", Some(dir.path()));
        let ModelToolPayload::Spilled { path, .. } = payload else {
            panic!("large result must spill");
        };
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains('\u{0}'));
        assert_eq!(written.len(), body.len() - 1);
    }

    #[test]
    fn output_between_ten_and_fifty_mib_spills_to_a_retrievable_bounded_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let body = format!(
            "HEAD{}FAILURE-VERDICT-AT-TAIL",
            "m".repeat(20 * 1024 * 1024)
        );
        let payload = clamp_for_model(&body, "bash", Some(dir.path()));
        let ModelToolPayload::Spilled { path, bytes, .. } = payload else {
            panic!("large result must spill");
        };
        let written = std::fs::read_to_string(path).unwrap();
        assert!(written.starts_with("HEAD"));
        assert!(written.ends_with("FAILURE-VERDICT-AT-TAIL"));
        assert!(written.contains("bytes elided"));
        assert_eq!(bytes, written.len());
        assert!(written.len() <= MODEL_TOOL_SPILL_FILE_MAX_BYTES);
    }

    #[test]
    fn governed_profile_without_read_gets_bounded_inline_head_and_tail() {
        // The NativeAgent call path supplies no spill directory when `read`
        // is absent from the governed active-tool allowlist.
        let body = format!("HEAD{}FAILURE-VERDICT-AT-TAIL", "m".repeat(400_000));
        let payload = clamp_for_model(&body, "bash", None);
        let ModelToolPayload::Inline(text) = payload else {
            panic!("output must stay inline when the model cannot retrieve a spill file");
        };
        assert!(text.starts_with("HEAD"));
        assert!(text.ends_with("FAILURE-VERDICT-AT-TAIL"));
        assert!(text.contains("bytes elided"));
        assert!(text.len() <= MODEL_TOOL_HARD_LIMIT_BYTES + 64);
    }

    #[test]
    fn clamp_for_model_falls_back_to_head_and_tail_when_the_spill_write_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        // A regular file where the spill directory must go: `create_dir_all`
        // fails, so the hard-truncation fallback has to run.
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();

        let body = format!("HEAD{}TAILMARK", "m".repeat(400_000));
        let payload = clamp_for_model(&body, "bash", Some(&blocked));
        let ModelToolPayload::Inline(text) = payload else {
            panic!("blocked spill path must fall back to inline truncation");
        };
        assert!(text.starts_with("HEAD"));
        assert!(text.ends_with("TAILMARK"));
        assert!(text.contains("bytes elided"));
        assert!(text.len() <= MODEL_TOOL_HARD_LIMIT_BYTES + 64);
    }

    #[test]
    fn truncate_head_tail_keeps_both_ends() {
        let body = format!("HEAD{}TAILMARK", "z".repeat(10_000));
        let out = truncate_head_tail(&body, 100);
        assert!(out.starts_with("HEAD"));
        assert!(out.ends_with("TAILMARK"));
        assert!(out.contains("[... "));
        assert!(out.contains(" bytes elided ...]"));
    }

    #[test]
    fn truncate_head_tail_is_char_boundary_safe() {
        let body = "\u{e9}".repeat(1_000);
        let out = truncate_head_tail(&body, 101);
        assert!(out.contains("bytes elided"));
        assert!(!out.contains('\u{fffd}'));
    }

    #[test]
    fn spill_dir_lives_beside_sessions_not_in_the_project() {
        let dir = model_tool_spill_dir("/Users/john/projects/myapp", "sess-1");
        assert!(dir.ends_with(std::path::PathBuf::from("tool-output").join("sess-1")));
        assert!(dir.to_string_lossy().contains("sessions"));
        assert!(!dir.to_string_lossy().contains("projects/myapp/"));
    }

    #[test]
    fn session_spill_cleanup_removes_only_the_deleted_session() {
        let sessions = tempfile::tempdir().unwrap();
        let deleted = model_tool_spill_dir_in_sessions(sessions.path(), "session-a");
        let retained = model_tool_spill_dir_in_sessions(sessions.path(), "session-b");
        std::fs::create_dir_all(&deleted).unwrap();
        std::fs::create_dir_all(&retained).unwrap();
        std::fs::write(deleted.join("large.txt"), "deleted").unwrap();
        std::fs::write(retained.join("large.txt"), "retained").unwrap();

        remove_model_tool_spill_dir(sessions.path(), "session-a").unwrap();

        assert!(!deleted.exists());
        assert_eq!(
            std::fs::read_to_string(retained.join("large.txt")).unwrap(),
            "retained"
        );
    }
}

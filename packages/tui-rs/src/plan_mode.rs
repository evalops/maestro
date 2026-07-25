//! Grok-style plan mode: a session `plan.md` file is the only writable path
//! while plan mode is active. Mutating tools targeting any other path fail
//! until the user leaves plan mode (typically after approving the plan).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::safety::{is_plan_mode, set_plan_mode, set_plan_satisfied};

/// Mirror of `session::writer::sanitize_path_for_dirname` (private module).
fn sanitize_path_for_dirname(path: &str) -> String {
    path.replace(['/', '\\', ':'], "-")
        .trim_matches('-')
        .to_string()
}

/// Mirror of `session::writer::sessions_dir` so plan files live next to sessions.
fn sessions_dir(cwd: &str) -> PathBuf {
    let home = dirs::home_dir()
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    let sanitized = sanitize_path_for_dirname(cwd);
    home.join(".composer")
        .join("agent")
        .join("sessions")
        .join(format!("--{sanitized}--"))
}

/// Process-local override for the active session id used to locate `plan.md`.
static ACTIVE_SESSION_ID: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Remember which session owns the current plan file.
pub fn set_active_session_id(session_id: Option<String>) {
    if let Ok(mut guard) = ACTIVE_SESSION_ID.lock() {
        *guard = session_id;
    }
}

/// Return the active session id used for plan path resolution, if any.
#[must_use]
pub fn active_session_id() -> Option<String> {
    ACTIVE_SESSION_ID
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Directory that holds plan files for a workspace cwd.
#[must_use]
pub fn plan_dir_for_cwd(cwd: &str) -> PathBuf {
    sessions_dir(cwd).join("plans")
}

/// Absolute path of the plan file for the active session (or `current`).
#[must_use]
pub fn plan_file_path(cwd: &str) -> PathBuf {
    let session = active_session_id().unwrap_or_else(|| "current".to_string());
    let safe_session = sanitize_path_for_dirname(&session);
    plan_dir_for_cwd(cwd).join(format!("{safe_session}.plan.md"))
}

/// Workspace-relative plan path agents are instructed to write.
pub const PLAN_RELATIVE_HINT: &str = ".maestro/plan.md";

/// Canonical workspace plan path under the project (optional alias).
#[must_use]
pub fn workspace_plan_path(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(".maestro").join("plan.md")
}

/// True when `path` is the session plan file or the workspace `.maestro/plan.md` alias.
#[must_use]
pub fn is_plan_file_path(cwd: &str, path: &Path) -> bool {
    let Ok(candidate) = dunce::canonicalize(path).or_else(|_| {
        // File may not exist yet — canonicalize parent + file name.
        if let Some(parent) = path.parent() {
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            dunce::canonicalize(parent).map(|p| p.join(path.file_name().unwrap_or_default()))
        } else {
            Err(std::io::Error::other("no parent"))
        }
    }) else {
        // Fall back to lexical comparison.
        return paths_equal_lexically(path, &plan_file_path(cwd))
            || paths_equal_lexically(path, &workspace_plan_path(cwd));
    };

    let session_plan = plan_file_path(cwd);
    let workspace_plan = workspace_plan_path(cwd);

    paths_equal_lexically(&candidate, &session_plan)
        || paths_equal_lexically(&candidate, &workspace_plan)
        || file_name_is_plan_md(&candidate)
            && (candidate.starts_with(plan_dir_for_cwd(cwd))
                || candidate.parent().is_some_and(|p| p.ends_with(".maestro")))
}

fn file_name_is_plan_md(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("plan.md") || n.ends_with(".plan.md"))
}

fn paths_equal_lexically(a: &Path, b: &Path) -> bool {
    let a_norm = a.to_string_lossy().replace('\\', "/");
    let b_norm = b.to_string_lossy().replace('\\', "/");
    a_norm == b_norm
}

/// Gate mutating tools under plan mode.
///
/// - Plan mode: only writes/edits targeting the plan file are allowed.
/// - Bash / background tasks / other pathless mutations always fail in plan mode.
/// - Safe-mode "require plan" still uses the todo-satisfied flag outside plan mode.
pub fn gate_mutation(tool_name: &str, path: Option<&Path>, cwd: &str) -> Result<(), String> {
    if is_plan_mode() {
        if let Some(path) = path {
            if is_plan_file_path(cwd, path) {
                return Ok(());
            }
            return Err(format!(
                "Plan mode is read-only except for the plan file. \
Only edit `{PLAN_RELATIVE_HINT}` or the session plan at `{}`. \
Use `/view-plan` to review, then `/plan approve` to leave plan mode and implement.",
                plan_file_path(cwd).display()
            ));
        }
        return Err(format!(
            "Plan mode blocks `{tool_name}`. Explore and write the plan file only \
(`{PLAN_RELATIVE_HINT}`). When ready, call out the plan and the user can `/plan approve`."
        ));
    }

    // Fall back to todo-based safe mode gate.
    crate::safety::require_plan(tool_name)
}

/// After a successful plan-file write, ensure session + workspace plan paths
/// both hold `content`, and mark the plan present (not yet approved).
///
/// Always writes both paths (not just the "other" one) so callers that pass the
/// session plan path still persist content when the tool write was simulated or
/// failed partially.
pub fn record_plan_write(cwd: &str, _written_path: &Path, content: &str) -> Result<(), String> {
    let session_plan = plan_file_path(cwd);
    if let Some(parent) = session_plan.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create plan dir: {e}"))?;
    }
    fs::write(&session_plan, content).map_err(|e| format!("write session plan: {e}"))?;

    let workspace = workspace_plan_path(cwd);
    if let Some(parent) = workspace.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&workspace, content);

    // Plan content exists; mutations stay blocked until user approves/leaves plan mode.
    set_plan_satisfied(false);
    Ok(())
}

/// Read the current plan markdown, if any.
#[must_use]
pub fn read_plan(cwd: &str) -> Option<String> {
    let session_plan = plan_file_path(cwd);
    if let Ok(text) = fs::read_to_string(&session_plan) {
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    let workspace = workspace_plan_path(cwd);
    fs::read_to_string(workspace)
        .ok()
        .filter(|t| !t.trim().is_empty())
}

#[must_use]
pub fn plan_revision(plan: &str) -> String {
    format!("{:x}", Sha256::digest(plan.as_bytes()))
}

#[must_use]
pub fn plan_excerpt(plan: &str, start_line: usize, end_line: usize) -> Option<String> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let lines = plan.lines().collect::<Vec<_>>();
    if end_line > lines.len() {
        return None;
    }
    Some(lines[start_line - 1..end_line].join("\n"))
}

/// Approve the plan: leave plan mode so implementation tools unlock.
pub fn approve_plan() {
    set_plan_mode(false);
    set_plan_satisfied(true);
}

/// System-prompt addendum while plan mode is active.
#[must_use]
pub fn plan_mode_system_addendum(cwd: &str) -> String {
    let path = plan_file_path(cwd);
    format!(
        "\n\n# Plan mode (active)\n\
You are in plan mode. Do not modify project source files or run mutating shell commands.\n\
\n\
Allowed:\n\
- Read, search, and explore the codebase\n\
- Ask clarifying questions\n\
- Write or update the plan file at `{PLAN_RELATIVE_HINT}` (mirrored to `{}`)\n\
\n\
Plan file should include:\n\
- Context (why the change)\n\
- Recommended approach\n\
- Critical files/functions to reuse\n\
- Verification / test plan\n\
\n\
When the plan is ready, tell the user to run `/view-plan` and `/plan approve` \
(or Shift+Tab away from Plan mode) before implementation.\n",
        path.display()
    )
}

/// Empty-state template written on first plan-mode entry when no plan exists.
#[must_use]
pub fn empty_plan_template() -> &'static str {
    "# Plan\n\n\
## Context\n\n\
_Why this change is needed._\n\n\
## Approach\n\n\
_Recommended implementation approach._\n\n\
## Files\n\n\
- `path/to/file` — reason\n\n\
## Verification\n\n\
- [ ] How to test end-to-end\n"
}

/// Ensure the session plan file exists (creates a template if missing).
pub fn ensure_plan_file(cwd: &str) -> Result<PathBuf, String> {
    let path = plan_file_path(cwd);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create plan dir: {e}"))?;
    }
    if !path.exists() {
        fs::write(&path, empty_plan_template()).map_err(|e| format!("write plan template: {e}"))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn plan_file_path_uses_session_id() {
        set_active_session_id(Some("sess-123".into()));
        let path = plan_file_path("/tmp/proj");
        assert!(path.to_string_lossy().contains("plans"));
        assert!(path.to_string_lossy().contains("sess-123"));
        assert!(path.to_string_lossy().ends_with(".plan.md"));
        set_active_session_id(None);
    }

    #[test]
    fn is_plan_file_recognizes_workspace_alias() {
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let plan = workspace_plan_path(cwd);
        fs::create_dir_all(plan.parent().unwrap()).unwrap();
        fs::write(&plan, "# plan\n").unwrap();
        assert!(is_plan_file_path(cwd, &plan));
        assert!(!is_plan_file_path(cwd, &dir.path().join("src/main.rs")));
    }

    #[test]
    fn gate_mutation_allows_plan_path_in_plan_mode() {
        set_plan_mode(true);
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let plan = ensure_plan_file(cwd).unwrap();
        assert!(gate_mutation("write", Some(&plan), cwd).is_ok());
        assert!(gate_mutation("write", Some(&dir.path().join("x.rs")), cwd).is_err());
        assert!(gate_mutation("bash", None, cwd).is_err());
        set_plan_mode(false);
    }

    #[test]
    fn record_and_read_plan_roundtrip() {
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_str().unwrap();
        set_active_session_id(Some("roundtrip".into()));
        let plan = ensure_plan_file(cwd).unwrap();
        record_plan_write(cwd, &plan, "# My Plan\n\nDo the thing.\n").unwrap();
        let text = read_plan(cwd).expect("plan");
        assert!(text.contains("My Plan"));
        set_active_session_id(None);
    }

    #[test]
    fn plan_revision_and_excerpt_track_exact_content() {
        let plan = "one\ntwo\nthree\n";
        assert_eq!(plan_excerpt(plan, 2, 3).as_deref(), Some("two\nthree"));
        assert_ne!(plan_revision(plan), plan_revision("one\nchanged\nthree\n"));
        assert!(plan_excerpt(plan, 0, 1).is_none());
        assert!(plan_excerpt(plan, 2, 4).is_none());
    }
}

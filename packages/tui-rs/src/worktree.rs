//! Droid-style session worktrees (`maestro -w <name>` / `--worktree <name>`).
//!
//! When the flag is present, the CLI creates a git worktree for the current
//! repository at `../<repo-name>-wt-<name>` on a new branch derived from
//! `<name>`, then runs the whole session (TUI, `exec`, or print mode) with the
//! worktree as the working directory. On exit a clean worktree (no uncommitted
//! changes, no untracked files) is removed together with its branch; a dirty
//! worktree is kept and its path and branch are reported.
//!
//! Like the rest of the crate's git integration (see [`crate::git`]), this
//! module shells out to the `git` CLI instead of linking libgit2.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};

/// Sanitize a user-supplied worktree name into a valid git branch name.
///
/// Keeps ASCII alphanumerics plus `-`, `_`, and `.`; every other character
/// (including whitespace and `/`) collapses to a single `-`. Leading/trailing
/// `-` and `.` are trimmed, `..` sequences are collapsed, and a trailing
/// `.lock` is stripped, so the result always passes `git check-ref-format`.
pub fn sanitize_branch_name(input: &str) -> Result<String, String> {
    let mut out = String::with_capacity(input.len());
    let mut pending_dash = false;
    for ch in input.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let trimmed = out.trim_matches(['-', '.']).to_string();
    let trimmed = trimmed
        .strip_suffix(".lock")
        .map_or(trimmed.as_str(), |stem| stem.trim_matches(['-', '.']))
        .to_string();
    if trimmed.is_empty() {
        return Err(format!(
            "worktree name `{input}` does not produce a valid branch name"
        ));
    }
    Ok(trimmed)
}

/// Extract the requested worktree name from raw CLI arguments.
///
/// Supports `-w <name>`, `--worktree <name>`, `--worktree=<name>`, and the
/// attached short form `-w<name>`. Returns `None` when the flag is absent and
/// `Some(Err(..))` when it is present without a usable value.
#[must_use]
pub fn requested_name(raw_args: &[OsString]) -> Option<Result<String, String>> {
    for (index, raw) in raw_args.iter().enumerate() {
        let arg = raw.to_string_lossy();
        if arg == "-w" || arg == "--worktree" {
            return match raw_args.get(index + 1) {
                Some(value) if !value.to_string_lossy().starts_with('-') => {
                    Some(Ok(value.to_string_lossy().into_owned()))
                }
                _ => Some(Err(format!("{arg} requires a worktree name"))),
            };
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            return Some(if value.is_empty() {
                Err("--worktree requires a worktree name".to_string())
            } else {
                Ok(value.to_string())
            });
        }
        if !arg.starts_with("--") && arg.len() > 2 {
            if let Some(value) = arg.strip_prefix("-w") {
                return Some(Ok(value.to_string()));
            }
        }
    }
    None
}

/// A worktree created for one maestro session.
#[derive(Debug)]
pub struct WorktreeSession {
    repo_root: PathBuf,
    path: PathBuf,
    branch: String,
}

impl WorktreeSession {
    /// Create a worktree for the repository containing `cwd`.
    ///
    /// Fails cleanly when `cwd` is not inside a git repository, when the
    /// sanitized branch already exists, or when the target path is occupied.
    pub fn create_in(cwd: &Path, name: &str) -> Result<Self> {
        let branch = sanitize_branch_name(name).map_err(anyhow::Error::msg)?;

        let root_out = Command::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(cwd)
            .output()
            .context("failed to run git rev-parse")?;
        if !root_out.status.success() {
            bail!("-w/--worktree requires running inside a git repository");
        }
        let repo_root = PathBuf::from(String::from_utf8_lossy(&root_out.stdout).trim());
        let repo_name = repo_root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| {
                anyhow!(
                    "cannot derive a repository name from {}",
                    repo_root.display()
                )
            })?;
        let worktree_path = repo_root
            .parent()
            .ok_or_else(|| {
                anyhow!(
                    "repository root {} has no parent directory",
                    repo_root.display()
                )
            })?
            .join(format!("{repo_name}-wt-{branch}"));

        let branch_exists = Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .current_dir(&repo_root)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if branch_exists {
            bail!(
                "branch `{branch}` already exists; choose a different worktree name or delete the branch"
            );
        }
        if worktree_path.exists() {
            bail!(
                "worktree path {} already exists; remove it or choose a different name",
                worktree_path.display()
            );
        }

        let add_out = Command::new("git")
            .args(["worktree", "add", "-b", &branch])
            .arg(&worktree_path)
            .arg("HEAD")
            .current_dir(&repo_root)
            .output()
            .context("failed to run git worktree add")?;
        if !add_out.status.success() {
            let stderr = String::from_utf8_lossy(&add_out.stderr).trim().to_string();
            bail!("git worktree add failed: {stderr}");
        }

        Ok(Self {
            repo_root,
            path: worktree_path,
            branch,
        })
    }

    /// Filesystem path of the worktree the session should run in.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True when the worktree has no uncommitted changes and no untracked files.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&self.path)
            .output()
            .map(|output| output.status.success() && output.stdout.is_empty())
            .unwrap_or(false)
    }

    /// Apply exit semantics: clean worktrees are removed with their branch,
    /// dirty worktrees are kept and reported.
    pub fn finish(self) {
        if self.is_clean() {
            let removed = Command::new("git")
                .args(["worktree", "remove"])
                .arg(&self.path)
                .current_dir(&self.repo_root)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
            if !removed {
                eprintln!(
                    "Worktree kept (could not remove): {}\n  branch: {}",
                    self.path.display(),
                    self.branch
                );
                return;
            }
            let branch_deleted = Command::new("git")
                .args(["branch", "-d", &self.branch])
                .current_dir(&self.repo_root)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
            if branch_deleted {
                eprintln!(
                    "Removed clean worktree {} (branch {} deleted)",
                    self.path.display(),
                    self.branch
                );
            } else {
                // `git branch -d` refuses to delete branches with commits that
                // are not merged into the current HEAD; keep the user's work.
                eprintln!(
                    "Removed worktree {} but kept branch {} (it contains commits)",
                    self.path.display(),
                    self.branch
                );
            }
        } else {
            eprintln!(
                "Worktree kept (uncommitted changes): {}\n  branch: {}",
                self.path.display(),
                self.branch
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    fn sanitize_keeps_valid_names() {
        assert_eq!(sanitize_branch_name("feat-x").unwrap(), "feat-x");
        assert_eq!(
            sanitize_branch_name("release_1.2.3").unwrap(),
            "release_1.2.3"
        );
        assert_eq!(sanitize_branch_name("FixBug").unwrap(), "FixBug");
    }

    #[test]
    fn sanitize_replaces_invalid_characters() {
        assert_eq!(sanitize_branch_name("feat x").unwrap(), "feat-x");
        assert_eq!(sanitize_branch_name("feat/x").unwrap(), "feat-x");
        assert_eq!(sanitize_branch_name("a  b/c:d").unwrap(), "a-b-c-d");
        assert_eq!(sanitize_branch_name(" ticket #42 ").unwrap(), "ticket-42");
    }

    #[test]
    fn sanitize_trims_git_forbidden_edges() {
        assert_eq!(sanitize_branch_name("-feat-").unwrap(), "feat");
        assert_eq!(sanitize_branch_name("..feat..").unwrap(), "feat");
        assert_eq!(sanitize_branch_name("a..b").unwrap(), "a.b");
        assert_eq!(sanitize_branch_name("x.lock").unwrap(), "x");
    }

    #[test]
    fn sanitize_rejects_unusable_names() {
        assert!(sanitize_branch_name("").is_err());
        assert!(sanitize_branch_name("   ").is_err());
        assert!(sanitize_branch_name("///").is_err());
        assert!(sanitize_branch_name("...").is_err());
        assert_eq!(sanitize_branch_name(".lock").unwrap(), "lock");
    }

    #[test]
    fn requested_name_supports_split_and_inline_forms() {
        let args = |argv: &[&str]| argv.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            requested_name(&args(&["-w", "feat-x"])).unwrap().unwrap(),
            "feat-x"
        );
        assert_eq!(
            requested_name(&args(&["--worktree", "feat-x"]))
                .unwrap()
                .unwrap(),
            "feat-x"
        );
        assert_eq!(
            requested_name(&args(&["--worktree=feat-x"]))
                .unwrap()
                .unwrap(),
            "feat-x"
        );
        assert_eq!(
            requested_name(&args(&["-wfeat-x"])).unwrap().unwrap(),
            "feat-x"
        );
        assert_eq!(
            requested_name(&args(&["exec", "-w", "feat-x", "do", "it"]))
                .unwrap()
                .unwrap(),
            "feat-x"
        );
        assert!(requested_name(&args(&["exec", "do", "it"])).is_none());
        assert!(requested_name(&args(&["-w"])).unwrap().is_err());
        assert!(requested_name(&args(&["--worktree", "--json"]))
            .unwrap()
            .is_err());
        assert!(requested_name(&args(&["--worktree="])).unwrap().is_err());
    }

    fn temp_repo(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "maestro-worktree-test-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should follow the Unix epoch")
                .as_nanos()
        ));
        let repo = root.join("repo");
        fs::create_dir_all(&repo).expect("repo directory should be created");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git should run");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(repo.join("README.md"), "hello\n").expect("file should be written");
        git(&["add", "README.md"]);
        git(&["commit", "--quiet", "-m", "init"]);
        repo
    }

    /// `git branch --list <branch>` output, stripped of the `+`/`*` markers
    /// git adds for branches checked out in linked worktrees.
    fn listed_branch(repo: &Path, branch: &str) -> String {
        let output = Command::new("git")
            .args(["branch", "--list", branch])
            .current_dir(repo)
            .output()
            .expect("git branch should run");
        String::from_utf8_lossy(&output.stdout)
            .trim_start_matches(['+', '*', ' '])
            .trim_end()
            .to_string()
    }

    #[test]
    fn create_builds_sibling_worktree_on_new_branch() {
        let repo = temp_repo("create");
        let session =
            WorktreeSession::create_in(&repo, "My Feature!").expect("worktree should be created");
        let expected = repo
            .parent()
            .expect("repo has a parent")
            .join("repo-wt-My-Feature");
        assert_eq!(
            session.path(),
            dunce::canonicalize(expected.parent().expect("worktree has a parent"))
                .expect("canonical worktree parent")
                .join(expected.file_name().expect("worktree has a name"))
        );
        assert!(expected.join("README.md").is_file());
        assert!(session.is_clean());
        assert_eq!(listed_branch(&repo, "My-Feature"), "My-Feature");

        session.finish();
        assert!(!expected.exists(), "clean worktree should be removed");
        assert!(
            listed_branch(&repo, "My-Feature").is_empty(),
            "clean worktree branch should be deleted"
        );
        fs::remove_dir_all(repo.parent().expect("repo has a parent"))
            .expect("test directory should be removed");
    }

    #[test]
    fn dirty_worktree_is_kept_on_finish() {
        let repo = temp_repo("dirty");
        let session =
            WorktreeSession::create_in(&repo, "keepme").expect("worktree should be created");
        let path = session.path().to_path_buf();
        fs::write(path.join("scratch.txt"), "uncommitted\n").expect("file should be written");
        assert!(!session.is_clean());

        session.finish();
        assert!(path.exists(), "dirty worktree should be kept");
        assert_eq!(listed_branch(&repo, "keepme"), "keepme");

        Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&path)
            .current_dir(&repo)
            .output()
            .expect("git worktree remove should run");
        Command::new("git")
            .args(["branch", "-D", "keepme"])
            .current_dir(&repo)
            .output()
            .expect("git branch delete should run");
        fs::remove_dir_all(repo.parent().expect("repo has a parent"))
            .expect("test directory should be removed");
    }

    #[test]
    fn create_fails_when_branch_exists_or_outside_repo() {
        let repo = temp_repo("conflict");
        let session =
            WorktreeSession::create_in(&repo, "taken").expect("worktree should be created");
        let path = session.path().to_path_buf();

        let error = WorktreeSession::create_in(&repo, "taken")
            .expect_err("existing branch must be rejected");
        assert!(
            error.to_string().contains("already exists"),
            "unexpected error: {error:#}"
        );
        session.finish();
        assert!(!path.exists());

        let outside =
            std::env::temp_dir().join(format!("maestro-worktree-norepo-{}", std::process::id()));
        fs::create_dir_all(&outside).expect("directory should be created");
        let error = WorktreeSession::create_in(&outside, "x")
            .expect_err("non-repository directories must be rejected");
        assert!(
            error.to_string().contains("git repository"),
            "unexpected error: {error:#}"
        );
        fs::remove_dir_all(&outside).expect("test directory should be removed");
        fs::remove_dir_all(repo.parent().expect("repo has a parent"))
            .expect("test directory should be removed");
    }
}

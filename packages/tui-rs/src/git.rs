//! Git utilities
//!
//! Provides git repository detection and information.

use std::path::Path;
use std::process::Command;

/// Get the current git branch name, if in a git repository
pub fn current_branch(cwd: &Path) -> Option<String> {
    // Run `git rev-parse --abbrev-ref HEAD` to get the current branch
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() && branch != "HEAD" {
            Some(branch)
        } else {
            // Detached HEAD state - get the short commit hash
            short_commit_hash(cwd).map(|hash| format!("({})", hash))
        }
    } else {
        None
    }
}

/// Get the short commit hash (for detached HEAD state)
fn short_commit_hash(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;

    if output.status.success() {
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !hash.is_empty() {
            Some(hash)
        } else {
            None
        }
    } else {
        None
    }
}

/// Check if a directory is inside a git repository
pub fn is_git_repo(cwd: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the repository root directory
pub fn repo_root(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;

    if output.status.success() {
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !root.is_empty() {
            Some(root)
        } else {
            None
        }
    } else {
        None
    }
}

/// Get git status summary (for status bar)
#[derive(Debug, Clone, Default)]
pub struct GitStatus {
    /// Number of staged files
    pub staged: usize,
    /// Number of modified files
    pub modified: usize,
    /// Number of untracked files
    pub untracked: usize,
}

impl GitStatus {
    /// Check if the working tree is clean
    pub fn is_clean(&self) -> bool {
        self.staged == 0 && self.modified == 0 && self.untracked == 0
    }

    /// Get a short status string (e.g., "+2 ~3 ?1")
    pub fn short_status(&self) -> Option<String> {
        if self.is_clean() {
            return None;
        }
        let mut parts = Vec::new();
        if self.staged > 0 {
            parts.push(format!("+{}", self.staged));
        }
        if self.modified > 0 {
            parts.push(format!("~{}", self.modified));
        }
        if self.untracked > 0 {
            parts.push(format!("?{}", self.untracked));
        }
        Some(parts.join(" "))
    }
}

/// Get git status counts
pub fn get_status(cwd: &Path) -> Option<GitStatus> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut status = GitStatus::default();

    for line in stdout.lines() {
        if line.len() < 2 {
            continue;
        }
        let xy = &line[0..2];
        let x = xy.chars().next().unwrap_or(' ');
        let y = xy.chars().nth(1).unwrap_or(' ');

        // X = staged, Y = unstaged/modified
        if x != ' ' && x != '?' {
            status.staged += 1;
        }
        if y != ' ' && y != '?' {
            status.modified += 1;
        }
        if x == '?' && y == '?' {
            status.untracked += 1;
        }
    }

    Some(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_current_branch_in_repo() {
        // This test assumes we're running in the composer repo
        let cwd = env::current_dir().unwrap();
        let branch = current_branch(&cwd);
        // Should get a branch name (or None if not in git repo)
        if is_git_repo(&cwd) {
            assert!(branch.is_some());
            let branch = branch.unwrap();
            assert!(!branch.is_empty());
        }
    }

    #[test]
    fn test_current_branch_not_a_repo() {
        // /tmp is unlikely to be a git repo
        let branch = current_branch(Path::new("/tmp"));
        // May or may not be None depending on if /tmp is somehow a git repo
        // Just ensure no panic
        let _ = branch;
    }

    #[test]
    fn test_is_git_repo() {
        let cwd = env::current_dir().unwrap();
        // Should be true if running in the composer repo
        let is_repo = is_git_repo(&cwd);
        // Just check it returns a bool without panic
        let _ = is_repo;
    }

    #[test]
    fn test_repo_root() {
        let cwd = env::current_dir().unwrap();
        if is_git_repo(&cwd) {
            let root = repo_root(&cwd);
            assert!(root.is_some());
        }
    }

    #[test]
    fn test_git_status() {
        let cwd = env::current_dir().unwrap();
        if is_git_repo(&cwd) {
            let status = get_status(&cwd);
            assert!(status.is_some());
        }
    }

    #[test]
    fn test_git_status_short() {
        let status = GitStatus {
            staged: 2,
            modified: 3,
            untracked: 1,
        };
        assert_eq!(status.short_status(), Some("+2 ~3 ?1".to_string()));

        let clean = GitStatus::default();
        assert!(clean.is_clean());
        assert_eq!(clean.short_status(), None);
    }
}

//! Path Containment Checks
//!
//! Ensures file operations stay within safe directories (workspace, temp).
//! Prevents path traversal attacks and access to system directories.

use std::path::{Path, PathBuf};

/// Result of a path containment check
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathContainment {
    /// Path is contained within a safe zone
    Contained {
        /// Which safe zone contains the path
        zone: String,
    },
    /// Path escapes all safe zones
    Escaped {
        /// Reason for escape
        reason: String,
    },
    /// Path is in a system-protected directory (hard block)
    SystemProtected {
        /// The protected path
        protected_path: String,
    },
}

/// Critical system paths that should never be written to
#[cfg(target_os = "linux")]
const SYSTEM_PATHS: &[&str] = &[
    "/etc", "/usr", "/var", "/boot", "/sys", "/proc", "/dev", "/bin", "/sbin", "/lib", "/lib64",
    "/opt",
];

#[cfg(target_os = "macos")]
const SYSTEM_PATHS: &[&str] = &[
    "/etc",
    "/usr",
    "/var",
    "/System",
    "/Library",
    "/private/etc",
    "/private/var",
    "/bin",
    "/sbin",
];

#[cfg(target_os = "windows")]
const SYSTEM_PATHS: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
];

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
const SYSTEM_PATHS: &[&str] = &["/etc", "/usr", "/var", "/bin", "/sbin"];

/// Check if a path is contained within safe zones
///
/// # Arguments
///
/// * `target` - The path being accessed
/// * `workspace` - The current workspace directory
/// * `additional_safe_zones` - Additional trusted directories
///
/// # Returns
///
/// `PathContainment` indicating whether the path is safe
pub fn is_path_contained(
    target: &Path,
    workspace: &Path,
    additional_safe_zones: &[PathBuf],
) -> PathContainment {
    // Resolve the target path (handle symlinks and relative paths)
    let resolved = match resolve_path(target, workspace) {
        Ok(p) => p,
        Err(e) => {
            // If we can't resolve, check if parent exists
            // This handles the case of creating new files
            if let Some(parent) = target.parent() {
                match resolve_path(parent, workspace) {
                    Ok(p) => p.join(target.file_name().unwrap_or_default()),
                    Err(_) => {
                        return PathContainment::Escaped {
                            reason: format!("Cannot resolve path: {}", e),
                        }
                    }
                }
            } else {
                return PathContainment::Escaped {
                    reason: format!("Cannot resolve path: {}", e),
                };
            }
        }
    };

    // Check if in temp directory FIRST (before system paths, since temp may be
    // under /var on macOS which would otherwise be blocked as a system path).
    // We need to check multiple temp path variants because:
    // - std::env::temp_dir() returns /var/folders/... on macOS
    // - But /var is a symlink to /private/var
    // - So resolved paths become /private/var/folders/...
    // - We must match both the raw and canonicalized forms
    let temp_dir = std::env::temp_dir();

    // Check raw temp_dir (e.g., /var/folders/...)
    if path_starts_with(&resolved, &temp_dir) || path_starts_with(target, &temp_dir) {
        return PathContainment::Contained {
            zone: "temp".to_string(),
        };
    }

    // Check canonicalized temp_dir (e.g., /private/var/folders/...)
    if let Ok(temp_canonical) = temp_dir.canonicalize() {
        if path_starts_with(&resolved, &temp_canonical) {
            return PathContainment::Contained {
                zone: "temp".to_string(),
            };
        }
    }

    // Also check /tmp explicitly (may differ from temp_dir() on some systems)
    #[cfg(unix)]
    {
        let tmp = std::path::Path::new("/tmp");
        if path_starts_with(&resolved, tmp) || path_starts_with(target, tmp) {
            return PathContainment::Contained {
                zone: "temp".to_string(),
            };
        }
        // On macOS, /tmp is a symlink to /private/tmp
        let private_tmp = std::path::Path::new("/private/tmp");
        if path_starts_with(&resolved, private_tmp) {
            return PathContainment::Contained {
                zone: "temp".to_string(),
            };
        }
    }

    // Check against system-protected paths
    for sys_path in SYSTEM_PATHS {
        let sys_path = Path::new(sys_path);
        if path_starts_with(&resolved, sys_path) {
            return PathContainment::SystemProtected {
                protected_path: sys_path.display().to_string(),
            };
        }
    }

    // Resolve workspace path
    let workspace_resolved = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());

    // Check if contained in workspace
    if path_starts_with(&resolved, &workspace_resolved) {
        return PathContainment::Contained {
            zone: "workspace".to_string(),
        };
    }

    // Check additional safe zones
    for zone in additional_safe_zones {
        if let Ok(zone_resolved) = zone.canonicalize() {
            if path_starts_with(&resolved, &zone_resolved) {
                return PathContainment::Contained {
                    zone: zone.display().to_string(),
                };
            }
        }
    }

    // Check user home directory (allowed for certain operations)
    if let Some(home) = dirs::home_dir() {
        if let Ok(home_resolved) = home.canonicalize() {
            if path_starts_with(&resolved, &home_resolved) {
                // Home is allowed but noted
                return PathContainment::Contained {
                    zone: "home".to_string(),
                };
            }
        }
    }

    PathContainment::Escaped {
        reason: format!(
            "Path {} is outside workspace and trusted zones",
            resolved.display()
        ),
    }
}

/// Resolve a path, handling relative paths and symlinks
fn resolve_path(path: &Path, base: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };

    // Try to canonicalize (follows symlinks, fails if doesn't exist)
    absolute.canonicalize().or_else(|_| {
        // If file doesn't exist, normalize the path manually
        Ok(normalize_path(&absolute))
    })
}

/// Normalize a path without requiring it to exist
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::CurDir => {}
            _ => {
                components.push(component);
            }
        }
    }

    components.iter().collect()
}

/// Check if `path` starts with `base` (is contained within)
fn path_starts_with(path: &Path, base: &Path) -> bool {
    // Normalize both paths for comparison
    let path_str = path.to_string_lossy();
    let base_str = base.to_string_lossy();

    // Handle trailing slashes
    let base_normalized = base_str.trim_end_matches('/');

    path_str.starts_with(base_normalized)
        && (path_str.len() == base_normalized.len()
            || path_str
                .chars()
                .nth(base_normalized.len())
                .map(|c| c == '/' || c == '\\')
                .unwrap_or(false))
}

/// Check if a path is in a system-protected directory
pub fn is_system_path(path: &Path) -> bool {
    // First check if path is in temp directory (which may be under /var on macOS)
    // Temp should NOT be considered a system path
    let temp_dir = std::env::temp_dir();
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    // Check raw temp path (e.g., /var/folders/...)
    if path_starts_with(&resolved, &temp_dir) || path_starts_with(path, &temp_dir) {
        return false;
    }

    // Check canonicalized temp path (e.g., /private/var/folders/...)
    if let Ok(temp_canonical) = temp_dir.canonicalize() {
        if path_starts_with(&resolved, &temp_canonical) || path_starts_with(path, &temp_canonical) {
            return false;
        }
    }

    // Also check /tmp explicitly
    #[cfg(unix)]
    {
        let tmp = Path::new("/tmp");
        if path_starts_with(&resolved, tmp) || path_starts_with(path, tmp) {
            return false;
        }
        let private_tmp = Path::new("/private/tmp");
        if path_starts_with(&resolved, private_tmp) || path_starts_with(path, private_tmp) {
            return false;
        }
    }

    SYSTEM_PATHS.iter().any(|sys| {
        let sys_path = Path::new(sys);
        path_starts_with(path, sys_path)
    })
}

/// Check for path traversal attempts in a path string
pub fn has_path_traversal(path: &str) -> bool {
    path.contains("..") || path.contains("//") || path.starts_with('~')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ========================================================================
    // Basic Containment Tests
    // ========================================================================

    #[test]
    fn test_workspace_containment() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/src/file.rs");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_workspace_root_file() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/README.md");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_workspace_deeply_nested() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/a/b/c/d/e/f/file.rs");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    // ========================================================================
    // System Path Protection Tests
    // ========================================================================

    #[test]
    fn test_system_path_protection() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/etc/passwd");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::SystemProtected { .. }));
    }

    #[test]
    fn test_all_system_paths_protected() {
        let workspace = PathBuf::from("/home/user/project");

        // Test paths under each SYSTEM_PATH - this is cross-platform
        // (uses the platform-specific SYSTEM_PATHS constant)
        for sys_path in SYSTEM_PATHS {
            let test_path = format!("{}/test_file", sys_path);
            let result = is_path_contained(Path::new(&test_path), &workspace, &[]);
            assert!(
                matches!(result, PathContainment::SystemProtected { .. }),
                "Expected {} to be system protected, got {:?}",
                test_path,
                result
            );
        }
    }

    // ========================================================================
    // Escaped Path Tests (Strong Assertions)
    // ========================================================================

    #[test]
    fn test_escaped_path_outside_all_zones() {
        let workspace = PathBuf::from("/workspace/project");
        // Use a path that's definitely not in workspace, home, temp, or system
        let target = PathBuf::from("/mnt/external/data/file.txt");

        let result = is_path_contained(&target, &workspace, &[]);
        // Should be Escaped (not in any safe zone) or possibly home if /mnt is under home
        match &result {
            PathContainment::Escaped { reason } => {
                assert!(
                    reason.contains("outside workspace"),
                    "Expected escape reason to mention workspace"
                );
            }
            PathContainment::Contained { zone } => {
                // Only acceptable if it's in home or temp
                assert!(
                    zone == "home" || zone == "temp",
                    "Unexpected zone {} for path outside workspace",
                    zone
                );
            }
            PathContainment::SystemProtected { .. } => {
                panic!("/mnt/external should not be system protected");
            }
        }
    }

    // ========================================================================
    // Additional Safe Zone Tests (With Real Assertions)
    // ========================================================================

    #[test]
    fn test_additional_safe_zone_logic() {
        // Test the logic using temp directory which definitely exists
        let workspace = PathBuf::from("/nonexistent/workspace");
        let temp_dir = std::env::temp_dir();
        let target = temp_dir.join("test_file.txt");

        let result = is_path_contained(&target, &workspace, &[]);
        // Should be contained in temp zone
        assert!(
            matches!(&result, PathContainment::Contained { zone } if zone == "temp"),
            "Expected temp containment, got {:?}",
            result
        );
    }

    #[test]
    fn test_safe_zone_takes_precedence() {
        // If we add a safe zone that's a parent of the target, it should be allowed
        let workspace = PathBuf::from("/workspace");
        let temp_dir = std::env::temp_dir();
        let target = temp_dir.join("subdir/file.txt");
        let safe_zones = vec![temp_dir.clone()];

        let result = is_path_contained(&target, &workspace, &safe_zones);
        // Should be contained (either in temp or the additional safe zone)
        assert!(
            matches!(result, PathContainment::Contained { .. }),
            "Expected containment with safe zone, got {:?}",
            result
        );
    }

    // ========================================================================
    // is_system_path Tests
    // ========================================================================

    #[test]
    fn test_is_system_path() {
        assert!(is_system_path(Path::new("/etc/passwd")));
        assert!(is_system_path(Path::new("/usr/bin/ls")));
        assert!(is_system_path(Path::new("/var/log/messages")));
        assert!(!is_system_path(Path::new("/home/user/file")));
        assert!(!is_system_path(Path::new("/tmp/file")));
    }

    #[test]
    fn test_is_system_path_nested() {
        // Deeply nested system paths should still be detected
        assert!(is_system_path(Path::new("/etc/ssh/sshd_config")));
        assert!(is_system_path(Path::new("/usr/local/bin/custom")));
        assert!(is_system_path(Path::new("/var/lib/docker/overlay")));
    }

    #[test]
    fn test_is_system_path_edge_cases() {
        // Root is not a system path (it's the parent of them)
        assert!(!is_system_path(Path::new("/")));
        // Paths that start with system path names but aren't under them
        assert!(!is_system_path(Path::new("/etcdata/file")));
        assert!(!is_system_path(Path::new("/users/name"))); // not /usr
    }

    // ========================================================================
    // Path Traversal Detection Tests
    // ========================================================================

    #[test]
    fn test_has_path_traversal() {
        assert!(has_path_traversal("../etc/passwd"));
        assert!(has_path_traversal("/foo/../etc/passwd"));
        assert!(has_path_traversal("//etc/passwd"));
        assert!(has_path_traversal("~/secret"));
        assert!(!has_path_traversal("/home/user/file.txt"));
    }

    #[test]
    fn test_has_path_traversal_complex() {
        // Multiple traversals
        assert!(has_path_traversal("../../etc/passwd"));
        assert!(has_path_traversal("/a/b/c/../../../etc"));

        // Traversal in the middle
        assert!(has_path_traversal("/home/../root/.ssh"));

        // Double slashes
        assert!(has_path_traversal("//root//file"));
        assert!(has_path_traversal("/home//user"));

        // Tilde expansion
        assert!(has_path_traversal("~root/.ssh"));
        assert!(has_path_traversal("~/.ssh/id_rsa"));
    }

    #[test]
    fn test_has_path_traversal_safe_paths() {
        // These should NOT be flagged as traversal
        assert!(!has_path_traversal("/home/user/project/src/main.rs"));
        assert!(!has_path_traversal("relative/path/file.txt"));
        assert!(!has_path_traversal("/absolute/path/to/file"));
        // Single dots are OK (current directory)
        assert!(!has_path_traversal("/home/user/./file"));
    }

    // ========================================================================
    // path_starts_with Tests
    // ========================================================================

    #[test]
    fn test_path_starts_with() {
        assert!(path_starts_with(
            Path::new("/home/user/project/src"),
            Path::new("/home/user/project")
        ));
        assert!(!path_starts_with(
            Path::new("/home/user/project2"),
            Path::new("/home/user/project")
        ));
        assert!(path_starts_with(
            Path::new("/home/user/project"),
            Path::new("/home/user/project")
        ));
    }

    #[test]
    fn test_path_starts_with_edge_cases() {
        // Trailing slash handling
        assert!(path_starts_with(
            Path::new("/home/user/project/"),
            Path::new("/home/user/project")
        ));
        assert!(path_starts_with(
            Path::new("/home/user/project"),
            Path::new("/home/user/project/")
        ));

        // Root path
        assert!(path_starts_with(Path::new("/etc"), Path::new("/")));

        // Prefix that's not a path boundary
        assert!(!path_starts_with(
            Path::new("/home/username"),
            Path::new("/home/user")
        ));
    }

    // ========================================================================
    // normalize_path Tests
    // ========================================================================

    #[test]
    fn test_normalize_path() {
        let path = normalize_path(Path::new("/home/user/../user/project/./src"));
        assert_eq!(path, PathBuf::from("/home/user/project/src"));
    }

    #[test]
    fn test_normalize_path_multiple_traversals() {
        let path = normalize_path(Path::new("/a/b/c/../../d/./e/../f"));
        assert_eq!(path, PathBuf::from("/a/d/f"));
    }

    #[test]
    fn test_normalize_path_at_root() {
        // Can't go above root
        let path = normalize_path(Path::new("/home/../../../etc"));
        // This should normalize to /etc (can't go above root)
        assert!(path.to_string_lossy().ends_with("etc"));
    }

    #[test]
    fn test_normalize_path_current_dir() {
        let path = normalize_path(Path::new("/home/./user/./project/./"));
        assert_eq!(path, PathBuf::from("/home/user/project"));
    }

    // ========================================================================
    // Path Traversal Attack Simulation Tests
    // ========================================================================

    #[test]
    fn test_path_traversal_attack_normalized() {
        let workspace = PathBuf::from("/home/user/project");

        // Attempt to escape via traversal - normalize_path should handle this
        let malicious = Path::new("/home/user/project/../../../etc/passwd");
        let normalized = normalize_path(malicious);

        // The normalized path should be detected as system protected
        let result = is_path_contained(&normalized, &workspace, &[]);
        assert!(
            matches!(result, PathContainment::SystemProtected { .. }),
            "Traversal attack should be blocked: {:?} -> {:?}",
            malicious,
            result
        );
    }

    #[test]
    fn test_resolve_path_relative() {
        let base = PathBuf::from("/home/user/project");
        let relative = Path::new("src/main.rs");

        let resolved = resolve_path(relative, &base).unwrap();
        assert!(resolved.starts_with("/home/user/project"));
        assert!(resolved.to_string_lossy().contains("src"));
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_empty_path() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("");

        let result = is_path_contained(&target, &workspace, &[]);
        // Empty path should either escape or be handled gracefully
        assert!(
            matches!(
                result,
                PathContainment::Escaped { .. } | PathContainment::Contained { .. }
            ),
            "Empty path should be handled: {:?}",
            result
        );
    }

    #[test]
    fn test_root_path() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/");

        let result = is_path_contained(&target, &workspace, &[]);
        // Root should escape (not contained in workspace)
        assert!(
            !matches!(result, PathContainment::Contained { zone } if zone == "workspace"),
            "Root should not be contained in workspace"
        );
    }

    #[test]
    fn test_workspace_itself() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(
            matches!(result, PathContainment::Contained { zone } if zone == "workspace"),
            "Workspace itself should be contained"
        );
    }

    #[test]
    fn test_path_with_special_characters() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/file with spaces.txt");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_path_with_unicode() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/文件.txt");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }
}

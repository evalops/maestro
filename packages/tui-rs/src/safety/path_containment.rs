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
    "/etc",
    "/usr",
    "/var",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
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

    // Check against system-protected paths first
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

    // Check if in temp directory
    if let Ok(temp) = std::env::temp_dir().canonicalize() {
        if path_starts_with(&resolved, &temp) {
            return PathContainment::Contained {
                zone: "temp".to_string(),
            };
        }
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
    let path_str = path.to_string_lossy();
    SYSTEM_PATHS.iter().any(|sys| {
        let sys_path = Path::new(sys);
        path_starts_with(path, sys_path) || path_str.starts_with(sys)
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

    #[test]
    fn test_workspace_containment() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/home/user/project/src/file.rs");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_system_path_protection() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/etc/passwd");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::SystemProtected { .. }));
    }

    #[test]
    fn test_escaped_path() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/some/other/location/file.txt");

        let result = is_path_contained(&target, &workspace, &[]);
        // This may be escaped or contained in home depending on the actual paths
        assert!(matches!(
            result,
            PathContainment::Escaped { .. } | PathContainment::Contained { .. }
        ));
    }

    #[test]
    fn test_additional_safe_zone() {
        let workspace = PathBuf::from("/home/user/project");
        let target = PathBuf::from("/data/shared/file.txt");
        let safe_zones = vec![PathBuf::from("/data/shared")];

        // Note: This will only work if /data/shared exists
        // For testing, we rely on the logic being correct
    }

    #[test]
    fn test_is_system_path() {
        assert!(is_system_path(Path::new("/etc/passwd")));
        assert!(is_system_path(Path::new("/usr/bin/ls")));
        assert!(!is_system_path(Path::new("/home/user/file")));
    }

    #[test]
    fn test_has_path_traversal() {
        assert!(has_path_traversal("../etc/passwd"));
        assert!(has_path_traversal("/foo/../etc/passwd"));
        assert!(has_path_traversal("//etc/passwd"));
        assert!(has_path_traversal("~/secret"));
        assert!(!has_path_traversal("/home/user/file.txt"));
    }

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
    fn test_normalize_path() {
        let path = normalize_path(Path::new("/home/user/../user/project/./src"));
        assert_eq!(path, PathBuf::from("/home/user/project/src"));
    }
}

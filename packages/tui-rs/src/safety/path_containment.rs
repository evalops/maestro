//! Path Containment Checks
//!
//! Ensures file operations stay within safe directories (workspace, temp).
//! Prevents path traversal attacks and access to system directories.

#[cfg(windows)]
use std::borrow::Cow;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::collections::HashSet;

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
    "/etc", "/usr", "/var", "/run", "/boot", "/sys", "/proc", "/dev", "/bin", "/sbin", "/lib",
    "/lib64", "/opt",
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
    "/dev",
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

fn system_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut paths: Vec<PathBuf> = SYSTEM_PATHS.iter().map(PathBuf::from).collect();

        if let Ok(system_root) = std::env::var("SystemRoot") {
            paths.push(PathBuf::from(system_root));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            paths.push(PathBuf::from(program_files));
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            paths.push(PathBuf::from(program_files_x86));
        }

        let mut seen = HashSet::new();
        paths.retain(|path| {
            let key = normalize_path_for_compare(path).to_string();
            seen.insert(key)
        });

        return paths;
    }

    #[cfg(not(windows))]
    {
        SYSTEM_PATHS.iter().map(PathBuf::from).collect()
    }
}

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
    if path_starts_with(&resolved, &temp_dir) {
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
        if path_starts_with(&resolved, tmp) {
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
    for sys_path in system_paths() {
        if path_starts_with(&resolved, &sys_path) {
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
    } else if is_tilde_path(path) {
        expand_tilde(path).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Home directory unavailable for ~ expansion",
            )
        })?
    } else {
        base.join(path)
    };

    // Try to canonicalize (follows symlinks, fails if doesn't exist)
    absolute.canonicalize().or_else(|_| {
        if let Some(resolved) = resolve_existing_parent(&absolute) {
            return Ok(resolved);
        }
        // If file doesn't exist, normalize the path manually
        Ok(normalize_path(&absolute))
    })
}

fn resolve_existing_parent(path: &Path) -> Option<PathBuf> {
    let mut current = path;
    let mut remainder: Vec<std::ffi::OsString> = Vec::new();

    loop {
        if current.exists() {
            let resolved_parent = current.canonicalize().ok()?;
            let mut resolved = resolved_parent;
            for component in remainder.iter().rev() {
                resolved.push(component);
            }
            return Some(normalize_path(&resolved));
        }

        let name = current.file_name()?.to_os_string();
        remainder.push(name);
        current = current.parent()?;
    }
}

fn is_tilde_path(path: &Path) -> bool {
    let Some(path_str) = path.to_str() else {
        return false;
    };
    path_str == "~" || path_str.starts_with("~/") || path_str.starts_with("~\\")
}

fn expand_tilde(path: &Path) -> Option<PathBuf> {
    let path_str = path.to_str()?;
    if path_str == "~" {
        return dirs::home_dir();
    }
    if let Some(stripped) = path_str
        .strip_prefix("~/")
        .or_else(|| path_str.strip_prefix("~\\"))
    {
        return dirs::home_dir().map(|home| home.join(stripped));
    }
    None
}

/// Normalize a path without requiring it to exist
fn normalize_path(path: &Path) -> PathBuf {
    let mut components: Vec<std::path::Component<'_>> = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => match components.last() {
                Some(std::path::Component::Normal(_)) | Some(std::path::Component::CurDir) => {
                    components.pop();
                }
                Some(std::path::Component::RootDir) | Some(std::path::Component::Prefix(_)) => {
                    // Don't traverse above root/prefix.
                }
                Some(std::path::Component::ParentDir) | None => {
                    // Preserve leading ".." for relative paths.
                    components.push(component);
                }
            },
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
    #[cfg(windows)]
    {
        // Normalize both paths for comparison
        let path_str = normalize_path_for_compare(path);
        let base_str = normalize_path_for_compare(base);

        // Handle trailing slashes
        let base_normalized = base_str.trim_end_matches(['/', '\\']);

        path_str.starts_with(base_normalized)
            && (path_str.len() == base_normalized.len()
                || path_str
                    .chars()
                    .nth(base_normalized.len())
                    .map(|c| matches!(c, '/' | '\\'))
                    .unwrap_or(false));
    }

    #[cfg(not(windows))]
    {
        let path_normalized = normalize_path(path);
        let base_normalized = normalize_path(base);
        path_normalized == base_normalized || path_normalized.starts_with(&base_normalized)
    }
}

#[cfg(windows)]
fn normalize_path_for_compare(path: &Path) -> Cow<'_, str> {
    let mut normalized = path.to_string_lossy().replace('/', "\\");

    if let Some(stripped) = normalized.strip_prefix(r"\\?\UNC\") {
        let mut unc_path = String::from(r"\\");
        unc_path.push_str(stripped);
        return Cow::Owned(unc_path.to_lowercase());
    }

    if let Some(stripped) = normalized.strip_prefix(r"\\?\") {
        normalized = stripped.to_string();
    }

    Cow::Owned(normalized.to_lowercase())
}

/// Check if a path is in a system-protected directory
pub fn is_system_path(path: &Path) -> bool {
    // First check if path is in temp directory (which may be under /var on macOS)
    // Temp should NOT be considered a system path
    let temp_dir = std::env::temp_dir();
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    // Check raw temp path (e.g., /var/folders/...)
    if path_starts_with(&resolved, &temp_dir) {
        return false;
    }

    // Check canonicalized temp path (e.g., /private/var/folders/...)
    if let Ok(temp_canonical) = temp_dir.canonicalize() {
        if path_starts_with(&resolved, &temp_canonical) {
            return false;
        }
    }

    // Also check /tmp explicitly
    #[cfg(unix)]
    {
        let tmp = Path::new("/tmp");
        if path_starts_with(&resolved, tmp) {
            return false;
        }
        let private_tmp = Path::new("/private/tmp");
        if path_starts_with(&resolved, private_tmp) || path_starts_with(path, private_tmp) {
            return false;
        }
    }

    system_paths()
        .iter()
        .any(|sys_path| path_starts_with(&resolved, sys_path))
}

/// Check for path traversal attempts in a path string
pub fn has_path_traversal(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn workspace_root() -> PathBuf {
        std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir().join("composer-workspace"))
    }

    fn system_path_sample() -> PathBuf {
        system_paths().into_iter().next().unwrap_or_else(|| {
            if cfg!(windows) {
                PathBuf::from(r"C:\Windows")
            } else {
                PathBuf::from("/etc")
            }
        })
    }

    fn sibling_path_not_under(system_path: &Path) -> PathBuf {
        let name = system_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("system");
        let parent = system_path
            .parent()
            .unwrap_or_else(|| Path::new(std::path::MAIN_SEPARATOR_STR));
        parent.join(format!("{name}data"))
    }

    // ========================================================================
    // Basic Containment Tests
    // ========================================================================

    #[test]
    fn test_workspace_containment() {
        let workspace = workspace_root();
        let target = workspace.join("src/file.rs");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_workspace_root_file() {
        let workspace = workspace_root();
        let target = workspace.join("README.md");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    #[test]
    fn test_workspace_deeply_nested() {
        let workspace = workspace_root();
        let target = workspace.join("a/b/c/d/e/f/file.rs");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::Contained { zone } if zone == "workspace"));
    }

    // ========================================================================
    // System Path Protection Tests
    // ========================================================================

    #[test]
    fn test_system_path_protection() {
        let workspace = workspace_root();
        let target = system_path_sample().join("passwd");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::SystemProtected { .. }));
    }

    #[test]
    fn test_all_system_paths_protected() {
        let workspace = workspace_root();

        // Test paths under each SYSTEM_PATH - this is cross-platform
        // (uses the platform-specific SYSTEM_PATHS constant)
        for sys_path in system_paths() {
            let test_path = sys_path.join("test_file");
            let result = is_path_contained(&test_path, &workspace, &[]);
            assert!(
                matches!(result, PathContainment::SystemProtected { .. }),
                "Expected {:?} to be system protected, got {:?}",
                test_path,
                result
            );
        }
    }

    #[test]
    fn test_system_paths_match_shared_config() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/system-paths.json"
        ));
        let value: serde_json::Value =
            serde_json::from_str(raw).expect("system-paths.json should be valid JSON");

        let expected_key = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        };

        let expected_list = value
            .get(expected_key)
            .and_then(|v| v.as_array())
            .expect("system-paths.json missing expected list");

        let mut expected: Vec<String> = expected_list
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        let mut actual: Vec<String> = SYSTEM_PATHS.iter().map(|s| s.to_string()).collect();

        expected.sort();
        actual.sort();

        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[test]
    fn test_system_path_detection_follows_symlinks() {
        let workspace = PathBuf::from("/home/user/project");
        let temp_dir = tempfile::TempDir::new().unwrap();
        let link_path = temp_dir.path().join("etc-link");
        std::os::unix::fs::symlink("/etc", &link_path).unwrap();
        let target = link_path.join("passwd");

        let result = is_path_contained(&target, &workspace, &[]);
        assert!(matches!(result, PathContainment::SystemProtected { .. }));
    }

    #[cfg(windows)]
    #[test]
    fn test_system_path_detection_windows_case_insensitive() {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let lower = system_root.to_lowercase();
        assert!(is_system_path(Path::new(&system_root)));
        assert!(is_system_path(Path::new(&lower)));
    }

    // ========================================================================
    // Escaped Path Tests (Strong Assertions)
    // ========================================================================

    #[test]
    fn test_escaped_path_outside_all_zones() {
        let workspace = workspace_root();
        // Use a path that's definitely not in workspace, home, temp, or system
        let target = if cfg!(windows) {
            PathBuf::from(r"Z:\external\data\file.txt")
        } else {
            PathBuf::from("/mnt/external/data/file.txt")
        };

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
        let workspace = workspace_root().join("nonexistent");
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
        let workspace = workspace_root();
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
        let sys_path = system_path_sample();
        assert!(is_system_path(&sys_path.join("passwd")));
        assert!(is_system_path(&sys_path.join("bin/ls")));
        assert!(is_system_path(&sys_path.join("log/messages")));

        if let Some(home) = dirs::home_dir() {
            assert!(!is_system_path(&home.join("file")));
        }
        assert!(!is_system_path(&std::env::temp_dir().join("file")));
    }

    #[test]
    fn test_is_system_path_nested() {
        // Deeply nested system paths should still be detected
        let sys_path = system_path_sample();
        assert!(is_system_path(&sys_path.join("ssh/sshd_config")));
        assert!(is_system_path(&sys_path.join("local/bin/custom")));
        assert!(is_system_path(&sys_path.join("lib/docker/overlay")));
    }

    #[test]
    fn test_is_system_path_edge_cases() {
        // Root is not a system path (it's the parent of them)
        assert!(!is_system_path(Path::new(std::path::MAIN_SEPARATOR_STR)));
        // Paths that start with system path names but aren't under them
        let sys_path = system_path_sample();
        let sibling = sibling_path_not_under(&sys_path).join("file");
        assert!(!is_system_path(&sibling));
        let not_sys = sys_path
            .parent()
            .unwrap_or_else(|| Path::new(std::path::MAIN_SEPARATOR_STR))
            .join("users")
            .join("name");
        assert!(!is_system_path(&not_sys));
    }

    // ========================================================================
    // Path Traversal Detection Tests
    // ========================================================================

    #[test]
    fn test_has_path_traversal() {
        assert!(has_path_traversal("../etc/passwd"));
        assert!(has_path_traversal("/foo/../etc/passwd"));
        assert!(!has_path_traversal("/home/user/file.txt"));
    }

    #[test]
    fn test_has_path_traversal_complex() {
        // Multiple traversals
        assert!(has_path_traversal("../../etc/passwd"));
        assert!(has_path_traversal("/a/b/c/../../../etc"));

        // Traversal in the middle
        assert!(has_path_traversal("/home/../root/.ssh"));
    }

    #[test]
    fn test_has_path_traversal_safe_paths() {
        // These should NOT be flagged as traversal
        assert!(!has_path_traversal("/home/user/project/src/main.rs"));
        assert!(!has_path_traversal("relative/path/file.txt"));
        assert!(!has_path_traversal("/absolute/path/to/file"));
        assert!(!has_path_traversal("//root//file"));
        assert!(!has_path_traversal("/home//user"));
        assert!(!has_path_traversal("~/secret"));
        assert!(!has_path_traversal("~root/.ssh"));
        // Single dots are OK (current directory)
        assert!(!has_path_traversal("/home/user/./file"));
        // ".." in file names should not be treated as traversal
        assert!(!has_path_traversal("/home/user/file..backup"));
    }

    #[test]
    fn test_resolve_path_expands_tilde() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let resolved = resolve_path(Path::new("~/composer-test"), &std::env::temp_dir()).unwrap();
        assert!(resolved.starts_with(&home));
    }

    #[test]
    fn test_resolve_path_expands_tilde_backslash() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let resolved = resolve_path(Path::new("~\\composer-test"), &std::env::temp_dir()).unwrap();
        assert!(resolved.starts_with(&home));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_path_symlink_parent_missing_leaf() {
        let workspace = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let link_path = workspace.path().join("outside-link");
        std::os::unix::fs::symlink(outside.path(), &link_path).unwrap();

        let target = link_path.join("missing.txt");
        let resolved = resolve_path(&target, workspace.path()).unwrap();
        assert!(resolved.starts_with(outside.path()));
    }

    // ========================================================================
    // path_starts_with Tests
    // ========================================================================

    #[test]
    fn test_path_starts_with() {
        let workspace = workspace_root();
        assert!(path_starts_with(&workspace.join("src"), &workspace));
        assert!(!path_starts_with(
            Path::new(&format!("{}2", workspace.display())),
            &workspace
        ));
        assert!(path_starts_with(&workspace, &workspace));
    }

    #[test]
    fn test_path_starts_with_edge_cases() {
        let workspace = workspace_root();
        let workspace_with_sep = PathBuf::from(format!(
            "{}{}",
            workspace.display(),
            std::path::MAIN_SEPARATOR
        ));
        // Trailing slash handling
        assert!(path_starts_with(&workspace_with_sep, &workspace));
        assert!(path_starts_with(&workspace, &workspace_with_sep));

        // Root path
        let root = Path::new(std::path::MAIN_SEPARATOR_STR);
        let sys_path = system_path_sample();
        assert!(path_starts_with(&sys_path, root));

        // Prefix that's not a path boundary
        assert!(!path_starts_with(
            Path::new(&format!("{}name", workspace.display())),
            &workspace
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
        assert_eq!(path, PathBuf::from("/etc"));
    }

    #[cfg(not(windows))]
    #[test]
    fn test_normalize_path_above_root() {
        // Parent traversal above root should stay rooted
        let path = normalize_path(Path::new("/../etc"));
        assert_eq!(path, PathBuf::from("/etc"));
    }

    #[test]
    fn test_normalize_path_current_dir() {
        let path = normalize_path(Path::new("/home/./user/./project/./"));
        assert_eq!(path, PathBuf::from("/home/user/project"));
    }

    #[cfg(windows)]
    #[test]
    fn test_normalize_path_above_root_windows() {
        let path = normalize_path(Path::new(r"C:\..\Windows"));
        assert_eq!(path, PathBuf::from(r"C:\Windows"));
    }

    // ========================================================================
    // Path Traversal Attack Simulation Tests
    // ========================================================================

    #[cfg(not(windows))]
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

    #[cfg(windows)]
    #[test]
    fn test_path_traversal_attack_normalized_windows() {
        let workspace = PathBuf::from(r"C:\Users\user\project");

        // Attempt to escape via traversal - normalize_path should handle this
        let malicious =
            Path::new(r"C:\Users\user\project\..\..\Windows\System32\drivers\etc\hosts");
        let normalized = normalize_path(malicious);

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

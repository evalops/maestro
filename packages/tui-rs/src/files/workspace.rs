//! Workspace file discovery
//!
//! Lists files in the workspace using ripgrep or find.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A file in the workspace
#[derive(Debug, Clone)]
pub struct WorkspaceFile {
    /// Full path to the file
    pub path: PathBuf,
    /// Relative path from workspace root
    pub relative_path: String,
    /// File name only
    pub name: String,
    /// File extension
    pub extension: Option<String>,
    /// Whether this is a directory
    pub is_dir: bool,
}

impl WorkspaceFile {
    /// Create from a path relative to the workspace root
    pub fn from_path(root: &Path, path: PathBuf) -> Self {
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let extension = path.extension().map(|e| e.to_string_lossy().to_string());

        let is_dir = path.is_dir();

        Self {
            path,
            relative_path,
            name,
            extension,
            is_dir,
        }
    }

    /// Get a display path (shortened if in home directory)
    pub fn display_path(&self) -> String {
        if let Some(home) =
            dirs::home_dir().or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        {
            if let Ok(rel) = self.path.strip_prefix(&home) {
                return format!("~/{}", rel.display());
            }
        }
        self.path.display().to_string()
    }

    /// Check if this file has one of the given extensions
    pub fn has_extension(&self, extensions: &[&str]) -> bool {
        self.extension
            .as_ref()
            .map(|ext| extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
            .unwrap_or(false)
    }

    /// Check if this file is source code
    pub fn is_source_code(&self) -> bool {
        self.has_extension(patterns::SOURCE_CODE)
    }

    /// Check if this file is a config file
    pub fn is_config(&self) -> bool {
        self.has_extension(patterns::CONFIG)
    }

    /// Check if this file is documentation
    pub fn is_docs(&self) -> bool {
        self.has_extension(patterns::DOCS)
    }
}

/// Get all files in the workspace
pub fn get_workspace_files(root: &Path, max_files: usize) -> Vec<WorkspaceFile> {
    // Try ripgrep first (faster)
    if let Some(files) = try_ripgrep(root, max_files) {
        return files;
    }

    // Fall back to find
    if let Some(files) = try_find(root, max_files) {
        return files;
    }

    // Fall back to manual traversal
    manual_traverse(root, max_files)
}

/// Try to list files using ripgrep
fn try_ripgrep(root: &Path, max_files: usize) -> Option<Vec<WorkspaceFile>> {
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let output = Command::new("rg")
        .args(["--files", "--hidden", "--follow"])
        .args(["--glob", "!.git"])
        .args(["--glob", "!node_modules"])
        .args(["--glob", "!target"])
        .args(["--glob", "!.next"])
        .args(["--glob", "!dist"])
        .args(["--glob", "!build"])
        .current_dir(root)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();
    for line in stdout.lines() {
        if files.len() >= max_files {
            break;
        }
        let path = root.join(line);
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !canonical.starts_with(&root_canonical) {
            continue;
        }
        files.push(WorkspaceFile::from_path(root, path));
    }

    Some(files)
}

/// Try to list files using find
fn try_find(root: &Path, max_files: usize) -> Option<Vec<WorkspaceFile>> {
    let output = Command::new("find")
        .arg(".")
        .args(["-type", "f"])
        .args(["-not", "-path", "*/.git/*"])
        .args(["-not", "-path", "*/node_modules/*"])
        .args(["-not", "-path", "*/target/*"])
        .args(["-not", "-path", "*/.next/*"])
        .args(["-not", "-path", "*/dist/*"])
        .args(["-not", "-path", "*/build/*"])
        .current_dir(root)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<WorkspaceFile> = stdout
        .lines()
        .take(max_files)
        .filter_map(|line| {
            let line = line.strip_prefix("./").unwrap_or(line);
            if line.is_empty() {
                return None;
            }
            let path = root.join(line);
            Some(WorkspaceFile::from_path(root, path))
        })
        .collect();

    Some(files)
}

/// Manual directory traversal
fn manual_traverse(root: &Path, max_files: usize) -> Vec<WorkspaceFile> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut visited: HashSet<PathBuf> = HashSet::new();
    visited.insert(root_canonical.clone());

    // Directories to skip
    let skip_dirs = [".git", "node_modules", "target", ".next", "dist", "build"];

    while let Some(dir) = stack.pop() {
        if files.len() >= max_files {
            break;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            if files.len() >= max_files {
                break;
            }

            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            let is_dir = if file_type.is_dir() {
                true
            } else if file_type.is_symlink() {
                path.is_dir()
            } else {
                false
            };

            if is_dir {
                if !skip_dirs.contains(&name.as_str()) && !name.starts_with('.') {
                    let canonical = match path.canonicalize() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    if !canonical.starts_with(&root_canonical) {
                        continue;
                    }
                    if visited.insert(canonical.clone()) {
                        // Prefer canonical paths to avoid nondeterministic symlink ordering.
                        stack.push(canonical);
                    }
                }
            } else if file_type.is_file() || file_type.is_symlink() {
                if file_type.is_symlink() {
                    let canonical = match path.canonicalize() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    if !canonical.starts_with(&root_canonical) {
                        continue;
                    }
                }
                let root_for_relative = if path.starts_with(root) {
                    root
                } else if path.starts_with(&root_canonical) {
                    root_canonical.as_path()
                } else {
                    root
                };
                files.push(WorkspaceFile::from_path(root_for_relative, path));
            }
        }
    }

    files
}

/// Common file type patterns
pub mod patterns {
    pub const SOURCE_CODE: &[&str] = &[
        "rs", "ts", "tsx", "js", "jsx", "py", "go", "rb", "java", "cpp", "c", "h", "cs", "swift",
        "kt", "scala", "clj", "ex", "exs", "hs", "ml", "lua", "sh", "bash", "zsh",
    ];

    pub const CONFIG: &[&str] = &["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml"];

    pub const DOCS: &[&str] = &["md", "txt", "rst", "adoc", "org"];

    pub const ALL_CODE: &[&str] = &[
        "rs", "ts", "tsx", "js", "jsx", "py", "go", "rb", "java", "cpp", "c", "h", "cs", "swift",
        "kt", "scala", "clj", "ex", "exs", "hs", "ml", "lua", "sh", "bash", "zsh", "json", "yaml",
        "yml", "toml", "md",
    ];
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    #[test]
    fn workspace_file_from_path() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.rs");
        File::create(&file_path).unwrap();

        let wf = WorkspaceFile::from_path(dir.path(), file_path);
        assert_eq!(wf.name, "test.rs");
        assert_eq!(wf.extension, Some("rs".to_string()));
        assert!(!wf.is_dir);
    }

    #[test]
    fn workspace_file_relative_path() {
        let dir = TempDir::new().unwrap();
        let subdir = dir.path().join("src");
        std::fs::create_dir(&subdir).unwrap();
        let file_path = subdir.join("main.rs");
        File::create(&file_path).unwrap();

        let wf = WorkspaceFile::from_path(dir.path(), file_path);
        assert!(wf.relative_path.contains("src"));
        assert!(wf.relative_path.contains("main.rs"));
    }

    #[test]
    fn get_files_in_temp_dir() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("file1.txt")).unwrap();
        File::create(dir.path().join("file2.rs")).unwrap();

        let files = get_workspace_files(dir.path(), 100);
        assert!(files.len() >= 2);
    }

    #[cfg(unix)]
    #[test]
    fn manual_traverse_skips_symlinked_dirs_outside_root() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        File::create(outside.path().join("outside.txt")).unwrap();

        let link_path = dir.path().join("outside_link");
        symlink(outside.path(), &link_path).unwrap();

        let files = manual_traverse(dir.path(), 100);
        assert!(!files
            .iter()
            .any(|file| file.relative_path.starts_with("outside_link")));
    }

    #[cfg(unix)]
    #[test]
    fn manual_traverse_dedupes_symlinked_dirs() {
        let dir = TempDir::new().unwrap();
        let real_dir = dir.path().join("real");
        let nested_dir = real_dir.join("nested");
        std::fs::create_dir_all(&nested_dir).unwrap();
        File::create(nested_dir.join("file.txt")).unwrap();

        let link_path = dir.path().join("link");
        symlink(&real_dir, &link_path).unwrap();

        let files = manual_traverse(dir.path(), 100);
        let has_real = files
            .iter()
            .any(|file| file.relative_path.contains("real/nested/file.txt"));
        let has_link = files
            .iter()
            .any(|file| file.relative_path.contains("link/nested/file.txt"));

        assert!(
            has_real ^ has_link,
            "expected only one path via real or link, got real={has_real} link={has_link}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn manual_traverse_skips_symlinked_files_outside_root() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("outside.txt");
        File::create(&outside_file).unwrap();

        let link_path = dir.path().join("outside_file.txt");
        symlink(&outside_file, &link_path).unwrap();

        let files = manual_traverse(dir.path(), 100);
        assert!(!files
            .iter()
            .any(|file| file.relative_path.contains("outside_file.txt")));
    }

    #[cfg(unix)]
    #[test]
    fn try_ripgrep_skips_symlinked_files_outside_root() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("outside.txt");
        File::create(&outside_file).unwrap();

        let link_path = dir.path().join("outside_file.txt");
        symlink(&outside_file, &link_path).unwrap();

        if let Some(files) = try_ripgrep(dir.path(), 100) {
            assert!(!files
                .iter()
                .any(|file| file.relative_path.contains("outside_file.txt")));
        }
    }
}

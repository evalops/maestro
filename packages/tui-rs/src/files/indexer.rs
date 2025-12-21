//! Parallel File Indexer
//!
//! This module provides high-performance file indexing with:
//! - Parallel directory traversal using rayon
//! - LRU caching of indexed files
//! - Incremental updates via file watching
//! - Background indexing that doesn't block the UI

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use tokio::sync::mpsc;

use super::workspace::WorkspaceFile;

/// Configuration for the file indexer
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    /// Maximum number of files to index
    pub max_files: usize,
    /// Maximum directory depth to traverse
    pub max_depth: usize,
    /// Directories to skip
    pub skip_dirs: HashSet<String>,
    /// File extensions to include (empty = all)
    pub include_extensions: HashSet<String>,
    /// Whether to follow symlinks
    pub follow_symlinks: bool,
    /// Cache TTL in seconds (0 = no expiry)
    pub cache_ttl_secs: u64,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        let skip_dirs: HashSet<String> = [
            ".git",
            "node_modules",
            "target",
            ".next",
            "dist",
            "build",
            "__pycache__",
            ".venv",
            "venv",
            ".cache",
            ".npm",
            "vendor",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        Self {
            max_files: 50_000,
            max_depth: 20,
            skip_dirs,
            include_extensions: HashSet::new(), // All extensions
            follow_symlinks: false,
            cache_ttl_secs: 300, // 5 minutes
        }
    }
}

impl IndexerConfig {
    /// Create config with custom max files
    pub fn with_max_files(mut self, max: usize) -> Self {
        self.max_files = max;
        self
    }

    /// Add a directory to skip
    pub fn skip_dir(mut self, dir: &str) -> Self {
        self.skip_dirs.insert(dir.to_string());
        self
    }

    /// Only include files with these extensions
    pub fn include_only(mut self, extensions: &[&str]) -> Self {
        self.include_extensions = extensions.iter().map(|s| s.to_string()).collect();
        self
    }
}

/// Index status for progress reporting
#[derive(Debug, Clone)]
pub struct IndexStatus {
    /// Whether indexing is in progress
    pub indexing: bool,
    /// Number of files found so far
    pub files_found: usize,
    /// Number of directories scanned
    pub dirs_scanned: usize,
    /// Time elapsed
    pub elapsed: Duration,
    /// Whether index is from cache
    pub from_cache: bool,
}

/// Cached file index
struct CachedIndex {
    /// The indexed files
    files: Vec<WorkspaceFile>,
    /// When the index was created
    created_at: Instant,
    /// Root directory that was indexed
    root: PathBuf,
}

impl CachedIndex {
    fn is_expired(&self, ttl_secs: u64) -> bool {
        if ttl_secs == 0 {
            return false;
        }
        self.created_at.elapsed() > Duration::from_secs(ttl_secs)
    }
}

/// Parallel file indexer with caching
pub struct FileIndexer {
    /// Configuration
    config: IndexerConfig,
    /// Cached index
    cache: Arc<RwLock<Option<CachedIndex>>>,
    /// Whether indexing is in progress
    indexing: Arc<AtomicBool>,
    /// Files found counter (for progress)
    files_found: Arc<AtomicUsize>,
    /// Dirs scanned counter (for progress)
    dirs_scanned: Arc<AtomicUsize>,
}

impl Default for FileIndexer {
    fn default() -> Self {
        Self::new(IndexerConfig::default())
    }
}

impl FileIndexer {
    /// Create a new file indexer with config
    pub fn new(config: IndexerConfig) -> Self {
        Self {
            config,
            cache: Arc::new(RwLock::new(None)),
            indexing: Arc::new(AtomicBool::new(false)),
            files_found: Arc::new(AtomicUsize::new(0)),
            dirs_scanned: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Get current status
    pub fn status(&self) -> IndexStatus {
        IndexStatus {
            indexing: self.indexing.load(Ordering::Relaxed),
            files_found: self.files_found.load(Ordering::Relaxed),
            dirs_scanned: self.dirs_scanned.load(Ordering::Relaxed),
            elapsed: Duration::ZERO, // Could track this too
            from_cache: false,
        }
    }

    /// Get indexed files, using cache if valid
    pub fn get_files(&self, root: &Path) -> Vec<WorkspaceFile> {
        // Check cache first
        if let Ok(cache) = self.cache.read() {
            if let Some(ref cached) = *cache {
                if cached.root == root && !cached.is_expired(self.config.cache_ttl_secs) {
                    return cached.files.clone();
                }
            }
        }

        // Need to re-index
        self.index_sync(root)
    }

    /// Index files synchronously (blocks until complete)
    pub fn index_sync(&self, root: &Path) -> Vec<WorkspaceFile> {
        self.indexing.store(true, Ordering::Relaxed);
        self.files_found.store(0, Ordering::Relaxed);
        self.dirs_scanned.store(0, Ordering::Relaxed);

        let files = self.parallel_traverse(root);

        // Update cache
        if let Ok(mut cache) = self.cache.write() {
            *cache = Some(CachedIndex {
                files: files.clone(),
                created_at: Instant::now(),
                root: root.to_path_buf(),
            });
        }

        self.indexing.store(false, Ordering::Relaxed);
        files
    }

    /// Index files asynchronously in background
    pub async fn index_async(
        &self,
        root: PathBuf,
        progress_tx: Option<mpsc::UnboundedSender<IndexStatus>>,
    ) -> Vec<WorkspaceFile> {
        let indexer = self.clone_for_task();

        // Run in blocking task pool
        tokio::task::spawn_blocking(move || {
            indexer.indexing.store(true, Ordering::Relaxed);
            indexer.files_found.store(0, Ordering::Relaxed);
            indexer.dirs_scanned.store(0, Ordering::Relaxed);

            let files = indexer.parallel_traverse(&root);

            // Update cache
            if let Ok(mut cache) = indexer.cache.write() {
                *cache = Some(CachedIndex {
                    files: files.clone(),
                    created_at: Instant::now(),
                    root: root.clone(),
                });
            }

            indexer.indexing.store(false, Ordering::Relaxed);

            // Send final status
            if let Some(tx) = progress_tx {
                let _ = tx.send(IndexStatus {
                    indexing: false,
                    files_found: files.len(),
                    dirs_scanned: indexer.dirs_scanned.load(Ordering::Relaxed),
                    elapsed: Duration::ZERO,
                    from_cache: false,
                });
            }

            files
        })
        .await
        .unwrap_or_default()
    }

    /// Clone the indexer state for use in a task
    fn clone_for_task(&self) -> Self {
        Self {
            config: self.config.clone(),
            cache: self.cache.clone(),
            indexing: self.indexing.clone(),
            files_found: self.files_found.clone(),
            dirs_scanned: self.dirs_scanned.clone(),
        }
    }

    /// Parallel directory traversal using rayon
    fn parallel_traverse(&self, root: &Path) -> Vec<WorkspaceFile> {
        let root = root.to_path_buf();

        // Collect top-level directories first
        let top_level_entries: Vec<_> = match std::fs::read_dir(&root) {
            Ok(entries) => entries
                .flatten()
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    !self.config.skip_dirs.contains(&name) && !name.starts_with('.')
                })
                .collect(),
            Err(_) => return Vec::new(),
        };

        self.dirs_scanned.fetch_add(1, Ordering::Relaxed);

        // Process directories in parallel
        let mut files: Vec<WorkspaceFile> = top_level_entries
            .par_iter()
            .flat_map(|entry| {
                let path = entry.path();
                if !self.config.follow_symlinks && self.is_symlink(&path) {
                    return Vec::new();
                }
                if path.is_dir() {
                    self.traverse_dir(&root, &path, 1)
                } else if path.is_file() {
                    if self.should_include(&path) {
                        self.files_found.fetch_add(1, Ordering::Relaxed);
                        vec![WorkspaceFile::from_path(&root, path)]
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                }
            })
            .collect();

        // Truncate to max files limit
        files.truncate(self.config.max_files);
        // Ensure files_found reflects the returned list (especially after truncation).
        self.files_found
            .store(files.len().min(self.config.max_files), Ordering::Relaxed);
        files
    }

    /// Recursively traverse a directory
    fn traverse_dir(&self, root: &Path, dir: &Path, depth: usize) -> Vec<WorkspaceFile> {
        if depth > self.config.max_depth {
            return Vec::new();
        }

        if self.files_found.load(Ordering::Relaxed) >= self.config.max_files {
            return Vec::new();
        }

        self.dirs_scanned.fetch_add(1, Ordering::Relaxed);

        let entries: Vec<_> = match std::fs::read_dir(dir) {
            Ok(entries) => entries.flatten().collect(),
            Err(_) => return Vec::new(),
        };

        // Use parallel iteration for large directories
        if entries.len() > 100 {
            entries
                .par_iter()
                .flat_map(|entry| self.process_entry(root, entry, depth))
                .collect()
        } else {
            entries
                .iter()
                .flat_map(|entry| self.process_entry(root, entry, depth))
                .collect()
        }
    }

    /// Process a single directory entry
    fn process_entry(
        &self,
        root: &Path,
        entry: &std::fs::DirEntry,
        depth: usize,
    ) -> Vec<WorkspaceFile> {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if !self.config.follow_symlinks && self.is_symlink(&path) {
            return Vec::new();
        }

        if path.is_dir() {
            if self.config.skip_dirs.contains(&name) || name.starts_with('.') {
                return Vec::new();
            }
            self.traverse_dir(root, &path, depth + 1)
        } else if path.is_file() {
            if self.should_include(&path) {
                self.files_found.fetch_add(1, Ordering::Relaxed);
                vec![WorkspaceFile::from_path(root, path)]
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    }

    /// Check if a file should be included based on extension filters
    fn should_include(&self, path: &Path) -> bool {
        if self.config.include_extensions.is_empty() {
            return true;
        }

        path.extension()
            .map(|ext| {
                self.config
                    .include_extensions
                    .contains(&ext.to_string_lossy().to_lowercase())
            })
            .unwrap_or(false)
    }

    /// Clear the cache
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.write() {
            *cache = None;
        }
    }

    /// Check if cache is valid for a path
    pub fn has_valid_cache(&self, root: &Path) -> bool {
        if let Ok(cache) = self.cache.read() {
            if let Some(ref cached) = *cache {
                return cached.root == root && !cached.is_expired(self.config.cache_ttl_secs);
            }
        }
        false
    }

    fn is_symlink(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::TempDir;

    #[test]
    fn test_indexer_config_default() {
        let config = IndexerConfig::default();
        assert_eq!(config.max_files, 50_000);
        assert!(config.skip_dirs.contains(".git"));
        assert!(config.skip_dirs.contains("node_modules"));
    }

    #[test]
    fn test_indexer_config_builder() {
        let config = IndexerConfig::default()
            .with_max_files(1000)
            .skip_dir("vendor")
            .include_only(&["rs", "ts"]);

        assert_eq!(config.max_files, 1000);
        assert!(config.skip_dirs.contains("vendor"));
        assert!(config.include_extensions.contains("rs"));
        assert!(config.include_extensions.contains("ts"));
    }

    #[test]
    fn test_indexer_basic() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("file1.txt")).unwrap();
        File::create(dir.path().join("file2.rs")).unwrap();

        let indexer = FileIndexer::default();
        let files = indexer.get_files(dir.path());

        assert!(files.len() >= 2);
    }

    #[test]
    fn test_indexer_skip_dirs() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        File::create(dir.path().join("node_modules/package.json")).unwrap();
        File::create(dir.path().join("src.rs")).unwrap();

        let indexer = FileIndexer::default();
        let files = indexer.get_files(dir.path());

        // Should not include node_modules files
        assert!(!files
            .iter()
            .any(|f| f.relative_path.contains("node_modules")));
    }

    #[test]
    fn test_indexer_extension_filter() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("code.rs")).unwrap();
        File::create(dir.path().join("data.json")).unwrap();
        File::create(dir.path().join("readme.md")).unwrap();

        let config = IndexerConfig::default().include_only(&["rs"]);
        let indexer = FileIndexer::new(config);
        let files = indexer.get_files(dir.path());

        assert_eq!(files.len(), 1);
        assert!(files[0].name.ends_with(".rs"));
    }

    #[test]
    fn test_indexer_cache() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("test.txt")).unwrap();

        let indexer = FileIndexer::default();

        // First call indexes
        let _files = indexer.get_files(dir.path());
        assert!(indexer.has_valid_cache(dir.path()));

        // Second call uses cache
        let _files = indexer.get_files(dir.path());
        assert!(indexer.has_valid_cache(dir.path()));

        // Clear cache
        indexer.clear_cache();
        assert!(!indexer.has_valid_cache(dir.path()));
    }

    #[test]
    fn test_indexer_max_files() {
        let dir = TempDir::new().unwrap();
        for i in 0..20 {
            File::create(dir.path().join(format!("file{}.txt", i))).unwrap();
        }

        let config = IndexerConfig::default().with_max_files(5);
        let indexer = FileIndexer::new(config);
        let files = indexer.get_files(dir.path());

        assert!(files.len() <= 5);
    }

    #[test]
    fn test_indexer_files_found_matches_results() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("a.rs")).unwrap();
        File::create(dir.path().join("b.rs")).unwrap();
        File::create(dir.path().join("c.txt")).unwrap();

        let config = IndexerConfig::default().include_only(&["rs"]);
        let indexer = FileIndexer::new(config);
        let files = indexer.get_files(dir.path());

        let status = indexer.status();
        assert_eq!(status.files_found, files.len());
    }

    #[cfg(unix)]
    #[test]
    fn test_indexer_skips_symlink_dirs_by_default() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        File::create(target.path().join("linked.rs")).unwrap();

        let link_path = root.path().join("link");
        symlink(target.path(), &link_path).unwrap();

        let indexer = FileIndexer::default();
        let files = indexer.get_files(root.path());

        assert!(files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_indexer_follows_symlink_dirs_when_enabled() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        File::create(target.path().join("linked.rs")).unwrap();

        let link_path = root.path().join("link");
        symlink(target.path(), &link_path).unwrap();

        let config = IndexerConfig::default();
        let indexer = FileIndexer::new(IndexerConfig {
            follow_symlinks: true,
            ..config
        });
        let files = indexer.get_files(root.path());

        assert_eq!(files.len(), 1);
        assert!(files[0].name.ends_with(".rs"));
    }

    #[tokio::test]
    async fn test_indexer_async() {
        let dir = TempDir::new().unwrap();
        File::create(dir.path().join("test.txt")).unwrap();

        let indexer = FileIndexer::default();
        let files = indexer.index_async(dir.path().to_path_buf(), None).await;

        assert!(!files.is_empty());
    }
}

//! Tool Result Cache
//!
//! Provides caching for tool execution results to avoid redundant operations.
//! This is particularly useful for read-only tools like `read` or `glob` where
//! the same inputs will produce the same outputs within a short time window.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Configuration for the tool result cache
#[derive(Debug, Clone)]
pub struct CacheConfig {
    /// Maximum number of entries in the cache
    pub max_entries: usize,
    /// Time-to-live for cache entries
    pub ttl: Duration,
    /// Whether caching is enabled
    pub enabled: bool,
    /// Tools that should never be cached (e.g., bash, write)
    pub excluded_tools: Vec<String>,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            max_entries: 100,
            ttl: Duration::from_secs(60),
            enabled: true,
            excluded_tools: vec!["bash".to_string(), "write".to_string(), "edit".to_string()],
        }
    }
}

/// Key for cache entries
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CacheKey {
    /// Tool name
    pub tool_name: String,
    /// Hash of the arguments
    pub args_hash: u64,
}

impl CacheKey {
    /// Create a new cache key
    pub fn new(tool_name: impl Into<String>, args: &serde_json::Value) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        args.to_string().hash(&mut hasher);
        Self {
            tool_name: tool_name.into(),
            args_hash: hasher.finish(),
        }
    }
}

/// Cached tool result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedResult {
    /// The tool result output
    pub output: String,
    /// Whether the result was an error
    pub is_error: bool,
    /// When the entry was created (runtime use, not serialized)
    #[serde(skip)]
    pub created_at: Option<Instant>,
    /// Timestamp for persistence (seconds since UNIX_EPOCH)
    #[serde(default)]
    pub created_timestamp: Option<u64>,
}

impl CachedResult {
    /// Create a new cached result
    pub fn new(output: impl Into<String>, is_error: bool) -> Self {
        let now = Instant::now();
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .ok();
        Self {
            output: output.into(),
            is_error,
            created_at: Some(now),
            created_timestamp: timestamp,
        }
    }

    /// Check if the cache entry has expired
    pub fn is_expired(&self, ttl: Duration) -> bool {
        self.created_at.map(|t| t.elapsed() > ttl).unwrap_or(true)
    }

    /// Check if the entry is expired based on timestamp (for persisted entries)
    pub fn is_expired_by_timestamp(&self, ttl: Duration) -> bool {
        let Some(created) = self.created_timestamp else {
            return true;
        };
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now.saturating_sub(created) > ttl.as_secs()
    }
}

/// A persistable cache entry that combines key and result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistableCacheEntry {
    /// The cache key
    pub key: CacheKey,
    /// The cached result
    pub result: CachedResult,
}

/// Tool result cache
#[derive(Debug)]
pub struct ToolResultCache {
    /// Configuration
    config: CacheConfig,
    /// Cached entries
    entries: HashMap<CacheKey, CachedResult>,
    /// Access order for LRU eviction (most recent at end)
    access_order: Vec<CacheKey>,
    /// File dependencies: maps file paths to cache keys that depend on them
    file_deps: HashMap<PathBuf, Vec<CacheKey>>,
    /// Cache hit count
    hits: u64,
    /// Cache miss count
    misses: u64,
}

impl Default for ToolResultCache {
    fn default() -> Self {
        Self::new(CacheConfig::default())
    }
}

impl ToolResultCache {
    /// Create a new cache with the given configuration
    pub fn new(config: CacheConfig) -> Self {
        Self {
            config,
            entries: HashMap::new(),
            access_order: Vec::new(),
            file_deps: HashMap::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// Check if caching is enabled for a tool
    pub fn is_cacheable(&self, tool_name: &str) -> bool {
        self.config.enabled && !self.config.excluded_tools.contains(&tool_name.to_string())
    }

    /// Get a cached result
    pub fn get(&mut self, key: &CacheKey) -> Option<&CachedResult> {
        if !self.config.enabled {
            self.misses += 1;
            return None;
        }

        // Check if entry exists and is not expired
        if let Some(entry) = self.entries.get(key) {
            if entry.is_expired(self.config.ttl) {
                // Remove expired entry
                self.entries.remove(key);
                self.access_order.retain(|k| k != key);
                self.misses += 1;
                return None;
            }

            // Update access order
            self.access_order.retain(|k| k != key);
            self.access_order.push(key.clone());

            self.hits += 1;
            return self.entries.get(key);
        }

        self.misses += 1;
        None
    }

    /// Store a result in the cache
    pub fn put(&mut self, key: CacheKey, result: CachedResult) {
        if !self.config.enabled {
            return;
        }

        // Evict old entries if at capacity
        while self.entries.len() >= self.config.max_entries && !self.access_order.is_empty() {
            let oldest = self.access_order.remove(0);
            self.entries.remove(&oldest);
            self.remove_deps_for_key(&oldest);
        }

        self.entries.insert(key.clone(), result);
        self.access_order.push(key);
    }

    /// Store a result in the cache with file dependencies
    ///
    /// File dependencies allow targeted invalidation when files are modified.
    /// When any of the dependent files changes, this cache entry will be invalidated.
    pub fn put_with_deps(&mut self, key: CacheKey, result: CachedResult, deps: Vec<PathBuf>) {
        if !self.config.enabled {
            return;
        }

        // Evict old entries if at capacity
        while self.entries.len() >= self.config.max_entries && !self.access_order.is_empty() {
            let oldest = self.access_order.remove(0);
            self.entries.remove(&oldest);
            self.remove_deps_for_key(&oldest);
        }

        // Track file dependencies
        for dep in deps {
            self.file_deps.entry(dep).or_default().push(key.clone());
        }

        self.entries.insert(key.clone(), result);
        self.access_order.push(key);
    }

    /// Remove dependency tracking for a cache key
    fn remove_deps_for_key(&mut self, key: &CacheKey) {
        // Remove this key from all dependency lists
        for keys in self.file_deps.values_mut() {
            keys.retain(|k| k != key);
        }
        // Clean up empty dependency entries
        self.file_deps.retain(|_, keys| !keys.is_empty());
    }

    /// Invalidate cache entries that depend on a file
    ///
    /// Call this when a file is modified to ensure stale cache entries are removed.
    /// Returns the number of entries invalidated.
    pub fn invalidate_for_file(&mut self, path: &Path) -> usize {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // Find all keys that depend on this file
        let keys_to_remove: Vec<CacheKey> =
            self.file_deps.get(&canonical).cloned().unwrap_or_default();

        // Also check with the original path (in case canonicalization differs)
        let mut keys_from_orig: Vec<CacheKey> =
            self.file_deps.get(path).cloned().unwrap_or_default();
        keys_from_orig.retain(|k| !keys_to_remove.contains(k));

        let all_keys: Vec<CacheKey> = keys_to_remove.into_iter().chain(keys_from_orig).collect();
        let count = all_keys.len();

        // Remove the entries
        for key in all_keys {
            self.entries.remove(&key);
            self.access_order.retain(|k| k != &key);
            self.remove_deps_for_key(&key);
        }

        // Remove the file from deps tracking
        self.file_deps.remove(&canonical);
        self.file_deps.remove(path);

        count
    }

    /// Invalidate all cache entries that depend on files in a directory
    ///
    /// Useful when a directory or its contents are modified.
    /// Returns the number of entries invalidated.
    pub fn invalidate_for_directory(&mut self, dir: &Path) -> usize {
        let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());

        // Find all files that start with this directory path
        let files_to_invalidate: Vec<PathBuf> = self
            .file_deps
            .keys()
            .filter(|p| p.starts_with(&canonical_dir) || p.starts_with(dir))
            .cloned()
            .collect();

        let mut total = 0;
        for file in files_to_invalidate {
            total += self.invalidate_for_file(&file);
        }
        total
    }

    /// Get the number of tracked file dependencies
    pub fn file_dep_count(&self) -> usize {
        self.file_deps.len()
    }

    /// Clear the cache
    pub fn clear(&mut self) {
        self.entries.clear();
        self.access_order.clear();
        self.file_deps.clear();
    }

    /// Remove expired entries
    pub fn evict_expired(&mut self) {
        let ttl = self.config.ttl;
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, v)| v.is_expired(ttl))
            .map(|(k, _)| k.clone())
            .collect();

        for key in expired {
            self.entries.remove(&key);
            self.access_order.retain(|k| k != &key);
            self.remove_deps_for_key(&key);
        }
    }

    /// Get cache statistics
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            max_entries: self.config.max_entries,
            hits: self.hits,
            misses: self.misses,
            hit_rate: if self.hits + self.misses > 0 {
                self.hits as f64 / (self.hits + self.misses) as f64
            } else {
                0.0
            },
        }
    }

    /// Get the configuration
    pub fn config(&self) -> &CacheConfig {
        &self.config
    }

    /// Update configuration
    pub fn set_config(&mut self, config: CacheConfig) {
        self.config = config;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PERSISTENCE METHODS
    // ─────────────────────────────────────────────────────────────────────────

    /// Get the default cache file path for a workspace
    pub fn default_cache_path(workspace: &Path) -> PathBuf {
        workspace.join(".composer").join("tool-cache.jsonl")
    }

    /// Save the cache to a JSONL file
    ///
    /// Each line is a JSON object with a key and result.
    /// Only saves entries that haven't expired.
    pub fn save_to_file(&self, path: &Path) -> std::io::Result<()> {
        // Create parent directories if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = std::fs::File::create(path)?;
        let mut writer = std::io::BufWriter::new(file);

        // Write each non-expired entry as a JSON line
        for (key, result) in &self.entries {
            // Skip expired entries
            if result.is_expired(self.config.ttl) {
                continue;
            }

            let entry = PersistableCacheEntry {
                key: key.clone(),
                result: result.clone(),
            };

            if let Ok(json) = serde_json::to_string(&entry) {
                writeln!(writer, "{}", json)?;
            }
        }

        writer.flush()?;
        Ok(())
    }

    /// Load the cache from a JSONL file
    ///
    /// Replaces the current cache contents with entries from the file.
    /// Expired entries are skipped during load.
    pub fn load_from_file(&mut self, path: &Path) -> std::io::Result<usize> {
        if !path.exists() {
            return Ok(0);
        }

        let file = std::fs::File::open(path)?;
        let reader = std::io::BufReader::new(file);

        // Clear current entries and deps
        self.entries.clear();
        self.access_order.clear();
        self.file_deps.clear();

        let mut loaded = 0;

        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }

            // Parse the entry
            let entry: PersistableCacheEntry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue, // Skip malformed lines
            };

            // Skip expired entries based on timestamp
            if entry.result.is_expired_by_timestamp(self.config.ttl) {
                continue;
            }

            // Respect max_entries limit
            if self.entries.len() >= self.config.max_entries {
                break;
            }

            // Convert timestamp back to Instant for runtime use
            let mut result = entry.result;
            if result.created_at.is_none() && result.created_timestamp.is_some() {
                // We can't directly create a past Instant, so we set Instant::now()
                // The expiration check uses is_expired_by_timestamp for persisted entries
                result.created_at = Some(Instant::now());
            }

            self.entries.insert(entry.key.clone(), result);
            self.access_order.push(entry.key);
            loaded += 1;
        }

        Ok(loaded)
    }

    /// Load cache from a file path, creating a new cache with default config
    pub fn load_or_create(path: &Path) -> Self {
        let mut cache = Self::new(CacheConfig::default());
        let _ = cache.load_from_file(path);
        cache
    }

    /// Save the cache and return the number of entries saved
    pub fn save(&self, path: &Path) -> std::io::Result<usize> {
        self.save_to_file(path)?;
        Ok(self.entries.len())
    }
}

/// Cache statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    /// Current number of entries
    pub entries: usize,
    /// Maximum number of entries
    pub max_entries: usize,
    /// Number of cache hits
    pub hits: u64,
    /// Number of cache misses
    pub misses: u64,
    /// Hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

/// Thread-safe wrapper for ToolResultCache.
/// Use this when you need to share the cache across async tasks or threads.
///
/// Note: Currently only used in tests. Will be integrated into production
/// when tool caching is enabled across concurrent agent sessions.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct SharedCache {
    inner: std::sync::RwLock<ToolResultCache>,
}

#[cfg(test)]
impl SharedCache {
    /// Create a new shared cache with default configuration
    pub fn new() -> Self {
        Self {
            inner: std::sync::RwLock::new(ToolResultCache::default()),
        }
    }

    /// Create a new shared cache with the given configuration
    pub fn with_config(config: CacheConfig) -> Self {
        Self {
            inner: std::sync::RwLock::new(ToolResultCache::new(config)),
        }
    }

    /// Get a cached result (returns a clone)
    pub fn get(&self, key: &CacheKey) -> Option<CachedResult> {
        self.inner.write().ok()?.get(key).cloned()
    }

    /// Store a result in the cache
    pub fn put(&self, key: CacheKey, result: CachedResult) {
        if let Ok(mut cache) = self.inner.write() {
            cache.put(key, result);
        }
    }

    /// Get cache statistics
    pub fn stats(&self) -> Option<CacheStats> {
        self.inner.read().ok().map(|cache| cache.stats())
    }

    /// Clear all entries
    pub fn clear(&self) {
        if let Ok(mut cache) = self.inner.write() {
            cache.clear();
        }
    }

    /// Check if a tool is cacheable
    pub fn is_cacheable(&self, tool_name: &str) -> bool {
        self.inner
            .read()
            .map(|cache| cache.is_cacheable(tool_name))
            .unwrap_or(false)
    }
}

#[cfg(test)]
impl Default for SharedCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_basic_operations() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        let result = CachedResult::new("file contents", false);

        cache.put(key.clone(), result);

        assert!(cache.get(&key).is_some());
        assert_eq!(cache.get(&key).unwrap().output, "file contents");
    }

    #[test]
    fn test_cache_miss() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));

        assert!(cache.get(&key).is_none());
        assert_eq!(cache.stats().misses, 1);
    }

    #[test]
    fn test_cache_eviction() {
        let config = CacheConfig {
            max_entries: 2,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"path": "1"}));
        let key2 = CacheKey::new("read", &serde_json::json!({"path": "2"}));
        let key3 = CacheKey::new("read", &serde_json::json!({"path": "3"}));

        cache.put(key1.clone(), CachedResult::new("1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));
        cache.put(key3.clone(), CachedResult::new("3", false));

        // key1 should be evicted
        assert!(cache.get(&key1).is_none());
        assert!(cache.get(&key2).is_some());
        assert!(cache.get(&key3).is_some());
    }

    #[test]
    fn test_cache_is_cacheable() {
        let cache = ToolResultCache::default();

        assert!(cache.is_cacheable("read"));
        assert!(cache.is_cacheable("glob"));
        assert!(!cache.is_cacheable("bash"));
        assert!(!cache.is_cacheable("write"));
        assert!(!cache.is_cacheable("edit"));
    }

    #[test]
    fn test_cache_clear() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        cache.put(key.clone(), CachedResult::new("contents", false));

        assert_eq!(cache.stats().entries, 1);

        cache.clear();

        assert_eq!(cache.stats().entries, 0);
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn test_cache_hit_rate() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        cache.put(key.clone(), CachedResult::new("contents", false));

        // 1 hit
        cache.get(&key);
        // 1 miss
        cache.get(&CacheKey::new(
            "read",
            &serde_json::json!({"path": "/other"}),
        ));
        // 1 hit
        cache.get(&key);

        let stats = cache.stats();
        assert_eq!(stats.hits, 2);
        assert_eq!(stats.misses, 1);
        assert!((stats.hit_rate - 0.666).abs() < 0.01);
    }

    #[test]
    fn test_cache_config_default() {
        let config = CacheConfig::default();
        assert_eq!(config.max_entries, 100);
        assert_eq!(config.ttl, Duration::from_secs(60));
        assert!(config.enabled);
        assert!(config.excluded_tools.contains(&"bash".to_string()));
        assert!(config.excluded_tools.contains(&"write".to_string()));
        assert!(config.excluded_tools.contains(&"edit".to_string()));
    }

    #[test]
    fn test_cache_key_hash_consistency() {
        let args = serde_json::json!({"path": "/tmp/test.txt", "limit": 100});
        let key1 = CacheKey::new("read", &args);
        let key2 = CacheKey::new("read", &args);

        assert_eq!(key1.tool_name, key2.tool_name);
        assert_eq!(key1.args_hash, key2.args_hash);
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_cache_key_different_args() {
        let key1 = CacheKey::new("read", &serde_json::json!({"path": "/a"}));
        let key2 = CacheKey::new("read", &serde_json::json!({"path": "/b"}));

        assert_eq!(key1.tool_name, key2.tool_name);
        assert_ne!(key1.args_hash, key2.args_hash);
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_cache_key_different_tools() {
        let args = serde_json::json!({"path": "/tmp/test.txt"});
        let key1 = CacheKey::new("read", &args);
        let key2 = CacheKey::new("glob", &args);

        assert_ne!(key1.tool_name, key2.tool_name);
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_cached_result_is_error() {
        let success = CachedResult::new("output", false);
        let error = CachedResult::new("error message", true);

        assert!(!success.is_error);
        assert!(error.is_error);
    }

    #[test]
    fn test_cached_result_created_at() {
        let result = CachedResult::new("output", false);
        assert!(result.created_at.is_some());
    }

    #[test]
    fn test_cached_result_expiration() {
        let result = CachedResult::new("output", false);

        // Should not be expired with long TTL
        assert!(!result.is_expired(Duration::from_secs(3600)));

        // Should be expired with zero TTL
        assert!(result.is_expired(Duration::from_secs(0)));
    }

    #[test]
    fn test_cached_result_without_created_at() {
        let result = CachedResult {
            output: "test".to_string(),
            is_error: false,
            created_at: None,
            created_timestamp: None,
        };

        // Without created_at, should always be considered expired
        assert!(result.is_expired(Duration::from_secs(3600)));
    }

    #[test]
    fn test_cache_disabled() {
        let config = CacheConfig {
            enabled: false,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));

        cache.put(key.clone(), CachedResult::new("contents", false));

        // Put should be ignored when disabled
        assert_eq!(cache.stats().entries, 0);

        // Get should return None and count as miss
        assert!(cache.get(&key).is_none());
        assert_eq!(cache.stats().misses, 1);
    }

    #[test]
    fn test_cache_is_cacheable_disabled() {
        let config = CacheConfig {
            enabled: false,
            ..Default::default()
        };
        let cache = ToolResultCache::new(config);

        // Even "read" should not be cacheable when cache is disabled
        assert!(!cache.is_cacheable("read"));
    }

    #[test]
    fn test_cache_is_cacheable_custom_exclusions() {
        let config = CacheConfig {
            excluded_tools: vec!["custom_tool".to_string()],
            ..Default::default()
        };
        let cache = ToolResultCache::new(config);

        assert!(cache.is_cacheable("read"));
        assert!(cache.is_cacheable("bash")); // No longer excluded
        assert!(!cache.is_cacheable("custom_tool"));
    }

    #[test]
    fn test_cache_lru_behavior() {
        let config = CacheConfig {
            max_entries: 3,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"path": "1"}));
        let key2 = CacheKey::new("read", &serde_json::json!({"path": "2"}));
        let key3 = CacheKey::new("read", &serde_json::json!({"path": "3"}));
        let key4 = CacheKey::new("read", &serde_json::json!({"path": "4"}));

        cache.put(key1.clone(), CachedResult::new("1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));
        cache.put(key3.clone(), CachedResult::new("3", false));

        // Access key1 to make it recently used
        cache.get(&key1);

        // Add key4, should evict key2 (least recently used)
        cache.put(key4.clone(), CachedResult::new("4", false));

        assert!(cache.get(&key1).is_some()); // Recently accessed
        assert!(cache.get(&key2).is_none()); // Evicted
        assert!(cache.get(&key3).is_some());
        assert!(cache.get(&key4).is_some());
    }

    #[test]
    fn test_cache_stats() {
        let config = CacheConfig {
            max_entries: 50,
            ..Default::default()
        };
        let cache = ToolResultCache::new(config);
        let stats = cache.stats();

        assert_eq!(stats.entries, 0);
        assert_eq!(stats.max_entries, 50);
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0);
        assert_eq!(stats.hit_rate, 0.0);
    }

    #[test]
    fn test_cache_stats_hit_rate_no_requests() {
        let cache = ToolResultCache::default();
        let stats = cache.stats();
        assert_eq!(stats.hit_rate, 0.0);
    }

    #[test]
    fn test_cache_config_accessor() {
        let config = CacheConfig {
            max_entries: 200,
            ttl: Duration::from_secs(120),
            enabled: true,
            excluded_tools: vec!["test".to_string()],
        };
        let cache = ToolResultCache::new(config);

        assert_eq!(cache.config().max_entries, 200);
        assert_eq!(cache.config().ttl, Duration::from_secs(120));
        assert!(cache.config().enabled);
    }

    #[test]
    fn test_cache_set_config() {
        let mut cache = ToolResultCache::default();
        assert_eq!(cache.config().max_entries, 100);

        let new_config = CacheConfig {
            max_entries: 50,
            ..Default::default()
        };
        cache.set_config(new_config);

        assert_eq!(cache.config().max_entries, 50);
    }

    #[test]
    fn test_cache_evict_expired() {
        let config = CacheConfig {
            ttl: Duration::from_millis(1), // Very short TTL
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        cache.put(key.clone(), CachedResult::new("contents", false));

        assert_eq!(cache.stats().entries, 1);

        // Wait for expiration
        std::thread::sleep(Duration::from_millis(10));

        cache.evict_expired();
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_cache_expired_entry_on_get() {
        let config = CacheConfig {
            ttl: Duration::from_millis(1),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        cache.put(key.clone(), CachedResult::new("contents", false));

        // Wait for expiration
        std::thread::sleep(Duration::from_millis(10));

        // Get should return None and remove expired entry
        assert!(cache.get(&key).is_none());
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_cache_multiple_puts_same_key() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));

        cache.put(key.clone(), CachedResult::new("version1", false));
        cache.put(key.clone(), CachedResult::new("version2", false));

        // Should have latest value
        assert_eq!(cache.get(&key).unwrap().output, "version2");
        // Should still only be 1 entry
        assert_eq!(cache.stats().entries, 1);
    }

    #[test]
    fn test_cache_clear_preserves_stats() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        cache.put(key.clone(), CachedResult::new("contents", false));
        cache.get(&key); // 1 hit

        cache.clear();

        // Stats should be preserved after clear
        assert_eq!(cache.stats().entries, 0);
        assert_eq!(cache.stats().hits, 1);
    }

    #[test]
    fn test_cached_result_serialization() {
        let result = CachedResult::new("test output", true);

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: CachedResult = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.output, "test output");
        assert!(deserialized.is_error);
        // created_at is skipped during serialization
        assert!(deserialized.created_at.is_none());
    }

    #[test]
    fn test_cache_stats_serialization() {
        let stats = CacheStats {
            entries: 10,
            max_entries: 100,
            hits: 50,
            misses: 25,
            hit_rate: 0.666,
        };

        let json = serde_json::to_string(&stats).unwrap();
        let deserialized: CacheStats = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.entries, stats.entries);
        assert_eq!(deserialized.max_entries, stats.max_entries);
        assert_eq!(deserialized.hits, stats.hits);
        assert_eq!(deserialized.misses, stats.misses);
        assert!((deserialized.hit_rate - stats.hit_rate).abs() < 0.001);
    }

    #[test]
    fn test_cache_key_clone() {
        let key = CacheKey::new("read", &serde_json::json!({"path": "/tmp/test.txt"}));
        let cloned = key.clone();

        assert_eq!(cloned.tool_name, key.tool_name);
        assert_eq!(cloned.args_hash, key.args_hash);
    }

    #[test]
    fn test_cache_key_empty_args() {
        let key = CacheKey::new("read", &serde_json::json!({}));
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_key_null_args() {
        let key = CacheKey::new("read", &serde_json::json!(null));
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_key_array_args() {
        let key = CacheKey::new("batch", &serde_json::json!([1, 2, 3]));
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_key_nested_args() {
        let key = CacheKey::new(
            "read",
            &serde_json::json!({
                "path": "/tmp/test.txt",
                "options": {
                    "encoding": "utf-8",
                    "buffer_size": 1024
                }
            }),
        );
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_key_same_args_different_order() {
        // JSON object keys are unordered, but serde_json::Value has consistent ordering
        let key1 = CacheKey::new("read", &serde_json::json!({"a": 1, "b": 2}));
        let key2 = CacheKey::new("read", &serde_json::json!({"a": 1, "b": 2}));
        assert_eq!(key1.args_hash, key2.args_hash);
    }

    #[test]
    fn test_cache_config_clone() {
        let config = CacheConfig {
            max_entries: 50,
            ttl: Duration::from_secs(30),
            enabled: false,
            excluded_tools: vec!["test".to_string()],
        };
        let cloned = config.clone();

        assert_eq!(cloned.max_entries, config.max_entries);
        assert_eq!(cloned.ttl, config.ttl);
        assert_eq!(cloned.enabled, config.enabled);
        assert_eq!(cloned.excluded_tools, config.excluded_tools);
    }

    #[test]
    fn test_cached_result_clone() {
        let result = CachedResult::new("output", true);
        let cloned = result.clone();

        assert_eq!(cloned.output, result.output);
        assert_eq!(cloned.is_error, result.is_error);
    }

    #[test]
    fn test_cache_stats_clone() {
        let stats = CacheStats {
            entries: 5,
            max_entries: 100,
            hits: 10,
            misses: 5,
            hit_rate: 0.666,
        };
        let cloned = stats.clone();

        assert_eq!(cloned.entries, stats.entries);
        assert_eq!(cloned.max_entries, stats.max_entries);
        assert_eq!(cloned.hits, stats.hits);
        assert_eq!(cloned.misses, stats.misses);
        assert_eq!(cloned.hit_rate, stats.hit_rate);
    }

    #[test]
    fn test_cache_default_trait() {
        let cache = ToolResultCache::default();
        assert!(cache.config().enabled);
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_cached_result_empty_output() {
        let result = CachedResult::new("", false);
        assert!(result.output.is_empty());
        assert!(!result.is_error);
    }

    #[test]
    fn test_cached_result_large_output() {
        let large_output = "x".repeat(1_000_000);
        let result = CachedResult::new(&large_output, false);
        assert_eq!(result.output.len(), 1_000_000);
    }

    #[test]
    fn test_cache_eviction_order() {
        let config = CacheConfig {
            max_entries: 3,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Insert 3 entries
        for i in 1..=3 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        // Insert 4th entry, should evict first (oldest)
        let key4 = CacheKey::new("read", &serde_json::json!({"id": 4}));
        cache.put(key4, CachedResult::new("4", false));

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        assert!(cache.get(&key1).is_none());
    }

    #[test]
    fn test_cache_multiple_misses() {
        let mut cache = ToolResultCache::default();

        for i in 0..10 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.get(&key);
        }

        assert_eq!(cache.stats().misses, 10);
        assert_eq!(cache.stats().hits, 0);
    }

    #[test]
    fn test_cache_multiple_hits() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        for _ in 0..10 {
            cache.get(&key);
        }

        assert_eq!(cache.stats().hits, 10);
        assert_eq!(cache.stats().misses, 0);
    }

    #[test]
    fn test_cache_hit_rate_100_percent() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        cache.get(&key);
        cache.get(&key);
        cache.get(&key);

        assert_eq!(cache.stats().hit_rate, 1.0);
    }

    #[test]
    fn test_cache_hit_rate_0_percent() {
        let mut cache = ToolResultCache::default();

        // All misses
        for i in 0..5 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.get(&key);
        }

        assert_eq!(cache.stats().hit_rate, 0.0);
    }

    #[test]
    fn test_cache_evict_expired_multiple_entries() {
        let config = CacheConfig {
            ttl: Duration::from_millis(1),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Add multiple entries
        for i in 0..5 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        assert_eq!(cache.stats().entries, 5);

        // Wait for expiration
        std::thread::sleep(Duration::from_millis(10));

        cache.evict_expired();
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_cache_evict_expired_partial() {
        let config = CacheConfig {
            ttl: Duration::from_millis(50),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Add first entry
        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        cache.put(key1, CachedResult::new("1", false));

        // Wait a bit but not enough to expire
        std::thread::sleep(Duration::from_millis(30));

        // Add second entry
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));
        cache.put(key2, CachedResult::new("2", false));

        // Wait for first to expire but not second
        std::thread::sleep(Duration::from_millis(30));

        cache.evict_expired();

        // First should be evicted, second should remain
        assert_eq!(cache.stats().entries, 1);
    }

    #[test]
    fn test_cache_set_config_changes_behavior() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        assert!(cache.get(&key).is_some());

        // Disable cache
        let new_config = CacheConfig {
            enabled: false,
            ..Default::default()
        };
        cache.set_config(new_config);

        // Existing entries still present but get returns None due to disabled
        // (note: existing entries are not cleared by set_config)
    }

    #[test]
    fn test_cache_key_special_characters() {
        let key = CacheKey::new(
            "read",
            &serde_json::json!({
                "path": "/tmp/file with spaces.txt",
                "special": "tab\there\nnewline"
            }),
        );
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_key_unicode() {
        let key = CacheKey::new(
            "read",
            &serde_json::json!({
                "path": "/tmp/日本語ファイル.txt",
                "encoding": "utf-8"
            }),
        );
        assert!(key.args_hash > 0);
    }

    #[test]
    fn test_cache_config_empty_excluded_tools() {
        let config = CacheConfig {
            excluded_tools: vec![],
            ..Default::default()
        };
        let cache = ToolResultCache::new(config);

        // All tools are cacheable with empty exclusion list
        assert!(cache.is_cacheable("bash"));
        assert!(cache.is_cacheable("write"));
        assert!(cache.is_cacheable("edit"));
        assert!(cache.is_cacheable("read"));
    }

    #[test]
    fn test_cache_with_max_entries_one() {
        let config = CacheConfig {
            max_entries: 1,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));

        cache.put(key1.clone(), CachedResult::new("1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));

        assert!(cache.get(&key1).is_none());
        assert!(cache.get(&key2).is_some());
        assert_eq!(cache.stats().entries, 1);
    }

    #[test]
    fn test_cached_result_serialization_roundtrip() {
        let original = CachedResult {
            output: "test with\nnewlines\tand\ttabs".to_string(),
            is_error: true,
            created_at: None,
            created_timestamp: Some(1234567890),
        };

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CachedResult = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.output, original.output);
        assert_eq!(deserialized.is_error, original.is_error);
        assert_eq!(deserialized.created_timestamp, original.created_timestamp);
    }

    #[test]
    fn test_cache_stats_all_zero() {
        let stats = CacheStats {
            entries: 0,
            max_entries: 0,
            hits: 0,
            misses: 0,
            hit_rate: 0.0,
        };

        assert_eq!(stats.entries, 0);
        assert_eq!(stats.max_entries, 0);
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0);
        assert_eq!(stats.hit_rate, 0.0);
    }

    #[test]
    fn test_cache_clear_resets_access_order() {
        let mut cache = ToolResultCache::default();

        for i in 0..5 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        cache.clear();

        // After clear, adding new entries should work correctly
        let key = CacheKey::new("read", &serde_json::json!({"id": 100}));
        cache.put(key.clone(), CachedResult::new("100", false));

        assert_eq!(cache.stats().entries, 1);
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_cache_config_debug() {
        let config = CacheConfig::default();
        let debug_str = format!("{:?}", config);
        assert!(debug_str.contains("max_entries"));
        assert!(debug_str.contains("ttl"));
    }

    #[test]
    fn test_cache_key_debug() {
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        let debug_str = format!("{:?}", key);
        assert!(debug_str.contains("read"));
        assert!(debug_str.contains("args_hash"));
    }

    #[test]
    fn test_cached_result_debug() {
        let result = CachedResult::new("output", false);
        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("output"));
        assert!(debug_str.contains("is_error"));
    }

    #[test]
    fn test_cache_stats_debug() {
        let stats = CacheStats {
            entries: 5,
            max_entries: 100,
            hits: 10,
            misses: 5,
            hit_rate: 0.666,
        };
        let debug_str = format!("{:?}", stats);
        assert!(debug_str.contains("entries"));
        assert!(debug_str.contains("hit_rate"));
    }

    #[test]
    fn test_tool_result_cache_debug() {
        let cache = ToolResultCache::default();
        let debug_str = format!("{:?}", cache);
        assert!(debug_str.contains("ToolResultCache"));
    }

    // ============================================================
    // Hash Collision Tests
    // ============================================================

    #[test]
    fn test_different_tool_same_args_no_collision() {
        let mut cache = ToolResultCache::default();
        let args = serde_json::json!({"path": "/test"});

        let key1 = CacheKey::new("read", &args);
        let key2 = CacheKey::new("glob", &args);

        cache.put(key1.clone(), CachedResult::new("read result", false));
        cache.put(key2.clone(), CachedResult::new("glob result", false));

        // Both should be present - no collision
        assert_eq!(cache.get(&key1).unwrap().output, "read result");
        assert_eq!(cache.get(&key2).unwrap().output, "glob result");
        assert_eq!(cache.stats().entries, 2);
    }

    #[test]
    fn test_same_tool_similar_args_no_collision() {
        let mut cache = ToolResultCache::default();

        // Very similar args that might have hash collision issues
        let key1 = CacheKey::new("read", &serde_json::json!({"path": "a"}));
        let key2 = CacheKey::new("read", &serde_json::json!({"path": "b"}));

        cache.put(key1.clone(), CachedResult::new("result a", false));
        cache.put(key2.clone(), CachedResult::new("result b", false));

        assert_eq!(cache.get(&key1).unwrap().output, "result a");
        assert_eq!(cache.get(&key2).unwrap().output, "result b");
    }

    #[test]
    fn test_hash_stability_across_calls() {
        let args = serde_json::json!({"path": "/test", "limit": 100});

        // Create keys multiple times
        let hashes: Vec<u64> = (0..100)
            .map(|_| CacheKey::new("read", &args).args_hash)
            .collect();

        // All hashes should be identical
        assert!(hashes.iter().all(|h| *h == hashes[0]));
    }

    #[test]
    fn test_cache_key_arg_order_matters_for_different_json() {
        // serde_json::Value preserves insertion order for objects
        // but constructed from macro has predictable order
        let key1 = CacheKey::new("read", &serde_json::json!({"a": 1, "b": 2}));
        let key2 = CacheKey::new("read", &serde_json::json!({"a": 1, "b": 2}));

        // Same construction should have same hash
        assert_eq!(key1.args_hash, key2.args_hash);
    }

    // ============================================================
    // Boundary Value Tests
    // ============================================================

    #[test]
    fn test_max_entries_zero_still_stores_one() {
        // Note: The implementation doesn't prevent storing when max_entries is 0.
        // The eviction logic (self.entries.len() > self.config.max_entries) allows
        // one entry before evicting. This is an edge case but documenting actual behavior.
        let config = CacheConfig {
            max_entries: 0,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // With max_entries=0, the ">" comparison allows 1 entry before evicting
        assert_eq!(cache.stats().entries, 1);
    }

    #[test]
    fn test_ttl_zero_expires_immediately() {
        let config = CacheConfig {
            ttl: Duration::from_secs(0),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // Entry exists but get will see it as expired
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn test_ttl_max_duration() {
        let config = CacheConfig {
            ttl: Duration::MAX,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // Should still be valid
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_max_entries_usize_max() {
        let config = CacheConfig {
            max_entries: usize::MAX,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Should work normally
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_cache_stats_with_u64_max_hits() {
        // Test stats structure can hold max values
        let stats = CacheStats {
            entries: usize::MAX,
            max_entries: usize::MAX,
            hits: u64::MAX,
            misses: u64::MAX,
            hit_rate: 1.0,
        };

        let json = serde_json::to_string(&stats).unwrap();
        let deserialized: CacheStats = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.hits, u64::MAX);
        assert_eq!(deserialized.misses, u64::MAX);
    }

    #[test]
    fn test_cache_key_args_hash_zero() {
        // Some args might legitimately hash to 0
        let key = CacheKey {
            tool_name: "test".to_string(),
            args_hash: 0,
        };

        let mut cache = ToolResultCache::default();
        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_cache_key_args_hash_max() {
        let key = CacheKey {
            tool_name: "test".to_string(),
            args_hash: u64::MAX,
        };

        let mut cache = ToolResultCache::default();
        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());
    }

    // ============================================================
    // TTL Edge Cases
    // ============================================================

    #[test]
    fn test_entry_expires_exactly_at_ttl() {
        // This is a timing test - may be flaky
        let config = CacheConfig {
            ttl: Duration::from_millis(100),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // Should be valid immediately
        assert!(cache.get(&key).is_some());

        // Wait past TTL
        std::thread::sleep(Duration::from_millis(150));

        // Should be expired
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn test_evict_expired_leaves_fresh_entries() {
        let config = CacheConfig {
            ttl: Duration::from_secs(60),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        for i in 0..10 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        // No entries should be evicted - they're all fresh
        cache.evict_expired();
        assert_eq!(cache.stats().entries, 10);
    }

    #[test]
    fn test_get_updates_access_order_but_not_created_at() {
        let config = CacheConfig {
            max_entries: 2,
            ttl: Duration::from_secs(60),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));

        cache.put(key1.clone(), CachedResult::new("1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));

        // Access key1 to move it to end of access order
        let created_at_before = cache.entries.get(&key1).unwrap().created_at;
        cache.get(&key1);
        let created_at_after = cache.entries.get(&key1).unwrap().created_at;

        // created_at should not change on get
        assert_eq!(created_at_before, created_at_after);
    }

    // ============================================================
    // LRU Edge Cases
    // ============================================================

    #[test]
    fn test_lru_eviction_with_reaccessing() {
        let config = CacheConfig {
            max_entries: 3,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));
        let key3 = CacheKey::new("read", &serde_json::json!({"id": 3}));
        let key4 = CacheKey::new("read", &serde_json::json!({"id": 4}));

        cache.put(key1.clone(), CachedResult::new("1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));
        cache.put(key3.clone(), CachedResult::new("3", false));

        // Access key1 and key2 to make them recently used
        cache.get(&key1);
        cache.get(&key2);

        // Add key4, should evict key3 (least recently used)
        cache.put(key4.clone(), CachedResult::new("4", false));

        assert!(cache.get(&key1).is_some());
        assert!(cache.get(&key2).is_some());
        assert!(cache.get(&key3).is_none()); // Evicted
        assert!(cache.get(&key4).is_some());
    }

    #[test]
    fn test_lru_many_evictions_in_sequence() {
        let config = CacheConfig {
            max_entries: 5,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Add 100 entries, only last 5 should remain
        for i in 0..100 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        assert_eq!(cache.stats().entries, 5);

        // Only entries 95-99 should exist
        for i in 0..95 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            assert!(cache.get(&key).is_none());
        }
        for i in 95..100 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            assert!(cache.get(&key).is_some());
        }
    }

    #[test]
    fn test_update_existing_entry_updates_access_order() {
        let config = CacheConfig {
            max_entries: 3,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));
        let key3 = CacheKey::new("read", &serde_json::json!({"id": 3}));
        let key4 = CacheKey::new("read", &serde_json::json!({"id": 4}));

        cache.put(key1.clone(), CachedResult::new("1v1", false));
        cache.put(key2.clone(), CachedResult::new("2", false));
        cache.put(key3.clone(), CachedResult::new("3", false));

        // Re-put key1 with new value - should update access order
        cache.put(key1.clone(), CachedResult::new("1v2", false));

        // Now add key4 - should evict key2 (was oldest after key1 update)
        cache.put(key4.clone(), CachedResult::new("4", false));

        assert_eq!(cache.get(&key1).unwrap().output, "1v2");
        assert!(cache.get(&key2).is_none()); // Evicted
        assert!(cache.get(&key3).is_some());
        assert!(cache.get(&key4).is_some());
    }

    // ============================================================
    // Concurrent/Atomicity Simulation Tests
    // ============================================================

    #[test]
    fn test_rapid_put_get_sequence() {
        let mut cache = ToolResultCache::default();

        // Simulate rapid put/get operations
        for i in 0..1000 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i % 10}));
            if i % 2 == 0 {
                cache.put(key.clone(), CachedResult::new(format!("{}", i), false));
            } else {
                let _ = cache.get(&key);
            }
        }

        // Cache should be in consistent state
        assert!(cache.stats().entries <= cache.config().max_entries);
    }

    #[test]
    fn test_cache_state_consistency_after_many_operations() {
        let config = CacheConfig {
            max_entries: 10,
            ttl: Duration::from_secs(60),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Mix of operations
        for i in 0..100 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key.clone(), CachedResult::new(format!("{}", i), false));

            if i % 5 == 0 {
                let _ = cache.get(&key);
            }
            if i % 20 == 0 {
                cache.evict_expired();
            }
            if i % 50 == 0 {
                cache.clear();
            }
        }

        // Verify consistency: entries count matches HashMap size
        assert_eq!(cache.stats().entries, cache.entries.len());
        assert!(cache.access_order.len() <= cache.entries.len());
    }

    // ============================================================
    // Error Result Caching
    // ============================================================

    #[test]
    fn test_cache_error_results() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/nonexistent"}));

        cache.put(key.clone(), CachedResult::new("File not found", true));

        let result = cache.get(&key).unwrap();
        assert!(result.is_error);
        assert_eq!(result.output, "File not found");
    }

    #[test]
    fn test_replace_error_with_success() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));

        // First an error
        cache.put(key.clone(), CachedResult::new("Error", true));
        assert!(cache.get(&key).unwrap().is_error);

        // Then success
        cache.put(key.clone(), CachedResult::new("Content", false));
        assert!(!cache.get(&key).unwrap().is_error);
        assert_eq!(cache.get(&key).unwrap().output, "Content");
    }

    // ============================================================
    // Configuration Changes
    // ============================================================

    #[test]
    fn test_set_config_to_smaller_max_entries() {
        let mut cache = ToolResultCache::default(); // max_entries = 100

        // Add 50 entries
        for i in 0..50 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        assert_eq!(cache.stats().entries, 50);

        // Shrink max_entries
        let new_config = CacheConfig {
            max_entries: 10,
            ..Default::default()
        };
        cache.set_config(new_config);

        // Existing entries not immediately evicted on config change
        // But new puts will trigger eviction
        let key = CacheKey::new("read", &serde_json::json!({"id": 100}));
        cache.put(key, CachedResult::new("100", false));

        // Now we should have at most 10 entries
        assert!(cache.stats().entries <= 10);
    }

    #[test]
    fn test_set_config_to_disabled_after_entries_exist() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));

        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());

        // Disable
        cache.set_config(CacheConfig {
            enabled: false,
            ..Default::default()
        });

        // Get should now return None (disabled)
        assert!(cache.get(&key).is_none());
        assert_eq!(cache.stats().misses, 1); // Counted as miss
    }

    // ============================================================
    // Tool Name Edge Cases
    // ============================================================

    #[test]
    fn test_empty_tool_name() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("", &serde_json::json!({"path": "/test"}));

        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_tool_name_with_special_characters() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("my-custom/tool:v2", &serde_json::json!({}));

        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_tool_name_unicode() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("日本語ツール", &serde_json::json!({}));

        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_is_cacheable_case_sensitive() {
        let cache = ToolResultCache::default();

        assert!(!cache.is_cacheable("bash"));
        assert!(cache.is_cacheable("BASH")); // Default exclusion is lowercase
        assert!(cache.is_cacheable("Bash"));
    }

    // ============================================================
    // Large Output Tests
    // ============================================================

    #[test]
    fn test_cache_very_large_output() {
        let mut cache = ToolResultCache::default();
        let large_output = "x".repeat(10_000_000); // 10MB
        let key = CacheKey::new("read", &serde_json::json!({"path": "/big"}));

        cache.put(key.clone(), CachedResult::new(&large_output, false));

        let result = cache.get(&key).unwrap();
        assert_eq!(result.output.len(), 10_000_000);
    }

    #[test]
    fn test_cache_multiple_large_outputs() {
        let config = CacheConfig {
            max_entries: 3,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        for i in 0..5 {
            let output = format!("{}_{}", "x".repeat(1_000_000), i);
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(&output, false));
        }

        // Should still follow LRU with large outputs
        assert_eq!(cache.stats().entries, 3);
    }

    // ============================================================
    // Statistics Accuracy
    // ============================================================

    #[test]
    fn test_stats_accurate_after_evictions() {
        let config = CacheConfig {
            max_entries: 5,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        // Add 10 entries (5 will be evicted)
        for i in 0..10 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        assert_eq!(cache.stats().entries, 5);
        assert_eq!(cache.entries.len(), 5);
        assert_eq!(cache.access_order.len(), 5);
    }

    #[test]
    fn test_stats_hits_misses_independent_of_entries() {
        let mut cache = ToolResultCache::default();

        // Generate some hits and misses
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        for _ in 0..5 {
            cache.get(&key); // hits
        }

        cache.clear();

        for _ in 0..3 {
            cache.get(&key); // misses (after clear)
        }

        let stats = cache.stats();
        assert_eq!(stats.entries, 0);
        assert_eq!(stats.hits, 5);
        assert_eq!(stats.misses, 3);
    }

    #[test]
    fn test_hit_rate_calculation_precision() {
        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // 1 hit, 2 misses = 33.33% hit rate
        cache.get(&key);
        cache.get(&CacheKey::new("read", &serde_json::json!({"other": 1})));
        cache.get(&CacheKey::new("read", &serde_json::json!({"other": 2})));

        let stats = cache.stats();
        assert!((stats.hit_rate - 0.333).abs() < 0.01);
    }

    // ============================================================
    // SharedCache Thread Safety Tests
    // ============================================================

    #[test]
    fn test_shared_cache_basic_operations() {
        let cache = SharedCache::new();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));

        cache.put(key.clone(), CachedResult::new("content", false));

        let result = cache.get(&key);
        assert!(result.is_some());
        assert_eq!(result.unwrap().output, "content");
    }

    #[test]
    fn test_shared_cache_stats() {
        let cache = SharedCache::new();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));

        cache.put(key.clone(), CachedResult::new("content", false));
        let _ = cache.get(&key);

        let stats = cache.stats().unwrap();
        assert_eq!(stats.entries, 1);
        assert_eq!(stats.hits, 1);
    }

    #[test]
    fn test_shared_cache_clear() {
        let cache = SharedCache::new();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));

        cache.put(key.clone(), CachedResult::new("content", false));
        assert!(cache.get(&key).is_some());

        cache.clear();
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn test_shared_cache_is_cacheable() {
        let cache = SharedCache::new();
        assert!(cache.is_cacheable("read"));
        assert!(!cache.is_cacheable("bash"));
    }

    #[test]
    fn test_shared_cache_with_config() {
        let config = CacheConfig {
            max_entries: 5,
            ..Default::default()
        };
        let cache = SharedCache::with_config(config);

        // Add 10 entries
        for i in 0..10 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        // Should only have 5 entries due to max_entries
        let stats = cache.stats().unwrap();
        assert_eq!(stats.entries, 5);
    }

    #[test]
    fn test_shared_cache_concurrent_writes() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SharedCache::new());
        let mut handles = vec![];

        // Spawn 10 threads, each writing 100 entries
        for thread_id in 0..10 {
            let cache = Arc::clone(&cache);
            handles.push(thread::spawn(move || {
                for i in 0..100 {
                    let key =
                        CacheKey::new("read", &serde_json::json!({"thread": thread_id, "i": i}));
                    cache.put(
                        key,
                        CachedResult::new(format!("t{}i{}", thread_id, i), false),
                    );
                }
            }));
        }

        // Wait for all threads
        for handle in handles {
            handle.join().unwrap();
        }

        // Cache should have entries (exact count depends on LRU eviction)
        let stats = cache.stats().unwrap();
        assert!(stats.entries > 0);
        assert!(stats.entries <= 100); // max_entries default is 100
    }

    #[test]
    fn test_shared_cache_concurrent_reads() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SharedCache::new());

        // Pre-populate cache
        for i in 0..50 {
            let key = CacheKey::new("read", &serde_json::json!({"id": i}));
            cache.put(key, CachedResult::new(format!("{}", i), false));
        }

        let mut handles = vec![];

        // Spawn 10 threads, each reading all entries
        for _ in 0..10 {
            let cache = Arc::clone(&cache);
            handles.push(thread::spawn(move || {
                let mut found = 0;
                for i in 0..50 {
                    let key = CacheKey::new("read", &serde_json::json!({"id": i}));
                    if cache.get(&key).is_some() {
                        found += 1;
                    }
                }
                found
            }));
        }

        // Wait for all threads and count results
        let total_found: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();

        // Each thread should find all 50 entries (10 threads * 50 entries = 500)
        assert_eq!(total_found, 500);
    }

    #[test]
    fn test_shared_cache_concurrent_read_write() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SharedCache::new());
        let mut handles = vec![];

        // Writer thread
        let cache_w = Arc::clone(&cache);
        handles.push(thread::spawn(move || {
            for i in 0..1000 {
                let key = CacheKey::new("read", &serde_json::json!({"id": i}));
                cache_w.put(key, CachedResult::new(format!("{}", i), false));
            }
        }));

        // Reader threads
        for _ in 0..5 {
            let cache_r = Arc::clone(&cache);
            handles.push(thread::spawn(move || {
                for i in 0..1000 {
                    let key = CacheKey::new("read", &serde_json::json!({"id": i % 100}));
                    let _ = cache_r.get(&key);
                }
            }));
        }

        // All threads should complete without panics
        for handle in handles {
            handle.join().unwrap();
        }

        // Stats should be accessible
        let stats = cache.stats().unwrap();
        assert!(stats.hits + stats.misses > 0);
    }

    #[test]
    fn test_shared_cache_concurrent_clear() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SharedCache::new());
        let mut handles = vec![];

        // Writer thread
        let cache_w = Arc::clone(&cache);
        handles.push(thread::spawn(move || {
            for i in 0..500 {
                let key = CacheKey::new("read", &serde_json::json!({"id": i}));
                cache_w.put(key, CachedResult::new(format!("{}", i), false));
            }
        }));

        // Clearer thread (runs periodically)
        let cache_c = Arc::clone(&cache);
        handles.push(thread::spawn(move || {
            for _ in 0..10 {
                thread::sleep(std::time::Duration::from_millis(1));
                cache_c.clear();
            }
        }));

        // Reader thread
        let cache_r = Arc::clone(&cache);
        handles.push(thread::spawn(move || {
            for i in 0..500 {
                let key = CacheKey::new("read", &serde_json::json!({"id": i}));
                let _ = cache_r.get(&key);
            }
        }));

        // All threads should complete without panics or deadlocks
        for handle in handles {
            handle.join().unwrap();
        }
    }

    #[test]
    fn test_shared_cache_default_impl() {
        let cache = SharedCache::default();
        let stats = cache.stats().unwrap();
        assert_eq!(stats.entries, 0);
    }

    #[test]
    fn test_shared_cache_stress_test() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SharedCache::with_config(CacheConfig {
            max_entries: 10,
            ..Default::default()
        }));

        let mut handles = vec![];

        // Many threads doing many operations
        for thread_id in 0..20 {
            let cache = Arc::clone(&cache);
            handles.push(thread::spawn(move || {
                for i in 0..200 {
                    let key = CacheKey::new("read", &serde_json::json!({"t": thread_id, "i": i}));
                    cache.put(key.clone(), CachedResult::new("data", false));
                    let _ = cache.get(&key);
                    if i % 50 == 0 {
                        let _ = cache.stats();
                    }
                }
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        // Cache should be in valid state
        let stats = cache.stats().unwrap();
        assert!(stats.entries <= 10);
    }

    // ============================================================
    // Persistence Tests
    // ============================================================

    #[test]
    fn test_save_and_load_cache() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("test_cache_{}.jsonl", std::process::id()));

        // Create and populate cache
        let mut cache = ToolResultCache::default();
        let key1 = CacheKey::new("read", &serde_json::json!({"path": "/test1"}));
        let key2 = CacheKey::new("glob", &serde_json::json!({"pattern": "*.rs"}));

        cache.put(key1.clone(), CachedResult::new("content1", false));
        cache.put(key2.clone(), CachedResult::new("content2", false));

        // Save to file
        cache.save_to_file(&cache_file).unwrap();

        // Load into new cache
        let mut loaded_cache = ToolResultCache::default();
        let count = loaded_cache.load_from_file(&cache_file).unwrap();

        assert_eq!(count, 2);
        assert!(loaded_cache.get(&key1).is_some());
        assert!(loaded_cache.get(&key2).is_some());
        assert_eq!(loaded_cache.get(&key1).unwrap().output, "content1");
        assert_eq!(loaded_cache.get(&key2).unwrap().output, "content2");

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_load_nonexistent_file() {
        let mut cache = ToolResultCache::default();
        let result = cache.load_from_file(std::path::Path::new("/nonexistent/path/cache.jsonl"));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[test]
    fn test_save_creates_parent_dirs() {
        let temp_dir = std::env::temp_dir();
        let nested_path = temp_dir
            .join(format!("nested_{}", std::process::id()))
            .join("subdir")
            .join("cache.jsonl");

        let mut cache = ToolResultCache::default();
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key, CachedResult::new("content", false));

        let result = cache.save_to_file(&nested_path);
        assert!(result.is_ok());
        assert!(nested_path.exists());

        // Cleanup
        let _ = std::fs::remove_file(&nested_path);
        let _ = std::fs::remove_dir_all(temp_dir.join(format!("nested_{}", std::process::id())));
    }

    #[test]
    fn test_load_skips_malformed_lines() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("malformed_{}.jsonl", std::process::id()));

        // Write a file with some valid and some invalid lines
        let valid_entry = PersistableCacheEntry {
            key: CacheKey::new("read", &serde_json::json!({"path": "/valid"})),
            result: CachedResult::new("valid content", false),
        };

        std::fs::write(
            &cache_file,
            format!(
                "{}\nINVALID JSON LINE\n{}\n",
                serde_json::to_string(&valid_entry).unwrap(),
                "also invalid"
            ),
        )
        .unwrap();

        let mut cache = ToolResultCache::default();
        let count = cache.load_from_file(&cache_file).unwrap();

        // Should only load the valid entry
        assert_eq!(count, 1);

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_load_respects_max_entries() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("max_entries_{}.jsonl", std::process::id()));

        // Create a cache file with 100 entries
        let mut lines = Vec::new();
        for i in 0..100 {
            let entry = PersistableCacheEntry {
                key: CacheKey::new("read", &serde_json::json!({"id": i})),
                result: CachedResult::new(format!("content{}", i), false),
            };
            lines.push(serde_json::to_string(&entry).unwrap());
        }
        std::fs::write(&cache_file, lines.join("\n")).unwrap();

        // Load with max_entries = 10
        let config = CacheConfig {
            max_entries: 10,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);
        let count = cache.load_from_file(&cache_file).unwrap();

        assert_eq!(count, 10);
        assert_eq!(cache.stats().entries, 10);

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_load_skips_expired_entries() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("expired_{}.jsonl", std::process::id()));

        // Create an entry with an old timestamp (1 hour ago)
        let old_timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 3600; // 1 hour ago

        let old_entry = PersistableCacheEntry {
            key: CacheKey::new("read", &serde_json::json!({"path": "/old"})),
            result: CachedResult {
                output: "old content".to_string(),
                is_error: false,
                created_at: None,
                created_timestamp: Some(old_timestamp),
            },
        };

        // Create a fresh entry
        let fresh_entry = PersistableCacheEntry {
            key: CacheKey::new("read", &serde_json::json!({"path": "/fresh"})),
            result: CachedResult::new("fresh content", false),
        };

        std::fs::write(
            &cache_file,
            format!(
                "{}\n{}",
                serde_json::to_string(&old_entry).unwrap(),
                serde_json::to_string(&fresh_entry).unwrap()
            ),
        )
        .unwrap();

        // Load with 60 second TTL - old entry should be skipped
        let config = CacheConfig {
            ttl: Duration::from_secs(60),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);
        let count = cache.load_from_file(&cache_file).unwrap();

        assert_eq!(count, 1);

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_save_skips_expired_entries() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("save_expired_{}.jsonl", std::process::id()));

        // Create cache with very short TTL
        let config = CacheConfig {
            ttl: Duration::from_millis(1),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        // Wait for expiration
        std::thread::sleep(Duration::from_millis(10));

        // Save - should skip expired entry
        cache.save_to_file(&cache_file).unwrap();

        // Read the file - should be empty or have no valid entries
        let content = std::fs::read_to_string(&cache_file).unwrap_or_default();
        assert!(content.trim().is_empty());

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_default_cache_path() {
        let workspace = std::path::Path::new("/home/user/project");
        let path = ToolResultCache::default_cache_path(workspace);
        assert_eq!(
            path,
            std::path::PathBuf::from("/home/user/project/.composer/tool-cache.jsonl")
        );
    }

    #[test]
    fn test_load_or_create() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("load_or_create_{}.jsonl", std::process::id()));

        // Non-existent file should create empty cache
        let cache = ToolResultCache::load_or_create(&cache_file);
        assert_eq!(cache.stats().entries, 0);

        // Create a file with entries
        let entry = PersistableCacheEntry {
            key: CacheKey::new("read", &serde_json::json!({"path": "/test"})),
            result: CachedResult::new("content", false),
        };
        std::fs::write(&cache_file, serde_json::to_string(&entry).unwrap()).unwrap();

        // Load from existing file
        let cache = ToolResultCache::load_or_create(&cache_file);
        assert_eq!(cache.stats().entries, 1);

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_cached_result_timestamp() {
        let result = CachedResult::new("test", false);
        assert!(result.created_timestamp.is_some());

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Timestamp should be within 1 second of now
        let ts = result.created_timestamp.unwrap();
        assert!(ts >= now - 1 && ts <= now + 1);
    }

    #[test]
    fn test_is_expired_by_timestamp() {
        let result = CachedResult::new("test", false);

        // Should not be expired with long TTL
        assert!(!result.is_expired_by_timestamp(Duration::from_secs(3600)));

        // A freshly created entry with zero TTL is NOT expired
        // (same second, so age is 0, and 0 > 0 is false)
        assert!(!result.is_expired_by_timestamp(Duration::from_secs(0)));

        // Test with an old timestamp - should be expired
        let old_timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 10; // 10 seconds ago
        let old_result = CachedResult {
            output: "old".to_string(),
            is_error: false,
            created_at: None,
            created_timestamp: Some(old_timestamp),
        };
        assert!(old_result.is_expired_by_timestamp(Duration::from_secs(5)));
    }

    #[test]
    fn test_is_expired_by_timestamp_no_timestamp() {
        let result = CachedResult {
            output: "test".to_string(),
            is_error: false,
            created_at: None,
            created_timestamp: None,
        };

        // Without timestamp, should always be considered expired
        assert!(result.is_expired_by_timestamp(Duration::from_secs(3600)));
    }

    #[test]
    fn test_persistable_cache_entry_serialization() {
        let entry = PersistableCacheEntry {
            key: CacheKey::new("read", &serde_json::json!({"path": "/test"})),
            result: CachedResult::new("content", true),
        };

        let json = serde_json::to_string(&entry).unwrap();
        let deserialized: PersistableCacheEntry = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.key.tool_name, "read");
        assert_eq!(deserialized.result.output, "content");
        assert!(deserialized.result.is_error);
    }

    #[test]
    fn test_cache_key_serialization() {
        let key = CacheKey::new("glob", &serde_json::json!({"pattern": "*.rs"}));

        let json = serde_json::to_string(&key).unwrap();
        let deserialized: CacheKey = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.tool_name, key.tool_name);
        assert_eq!(deserialized.args_hash, key.args_hash);
    }

    #[test]
    fn test_save_empty_cache() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("empty_cache_{}.jsonl", std::process::id()));

        let cache = ToolResultCache::default();
        cache.save_to_file(&cache_file).unwrap();

        let content = std::fs::read_to_string(&cache_file).unwrap();
        assert!(content.is_empty());

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn test_roundtrip_preserves_data() {
        let temp_dir = std::env::temp_dir();
        let cache_file = temp_dir.join(format!("roundtrip_{}.jsonl", std::process::id()));

        // Create cache with various entries
        let mut cache = ToolResultCache::default();

        let entries = vec![
            (
                CacheKey::new("read", &serde_json::json!({"path": "/a"})),
                CachedResult::new("content a", false),
            ),
            (
                CacheKey::new("glob", &serde_json::json!({"pattern": "*.rs"})),
                CachedResult::new("file1.rs\nfile2.rs", false),
            ),
            (
                CacheKey::new("grep", &serde_json::json!({"query": "TODO"})),
                CachedResult::new("Error: not found", true),
            ),
        ];

        for (key, result) in entries.iter() {
            cache.put(key.clone(), result.clone());
        }

        // Save
        cache.save_to_file(&cache_file).unwrap();

        // Load into new cache
        let mut loaded = ToolResultCache::default();
        loaded.load_from_file(&cache_file).unwrap();

        // Verify all entries
        for (key, original) in entries {
            let loaded_result = loaded.get(&key).unwrap();
            assert_eq!(loaded_result.output, original.output);
            assert_eq!(loaded_result.is_error, original.is_error);
        }

        // Cleanup
        let _ = std::fs::remove_file(&cache_file);
    }

    // ============================================================
    // File Dependency Tests
    // ============================================================

    #[test]
    fn test_put_with_deps_basic() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test/file.txt"}));
        let deps = vec![PathBuf::from("/test/file.txt")];

        cache.put_with_deps(key.clone(), CachedResult::new("content", false), deps);

        assert!(cache.get(&key).is_some());
        assert_eq!(cache.file_dep_count(), 1);
    }

    #[test]
    fn test_put_with_deps_multiple_files() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("grep", &serde_json::json!({"pattern": "TODO"}));
        let deps = vec![
            PathBuf::from("/src/a.rs"),
            PathBuf::from("/src/b.rs"),
            PathBuf::from("/src/c.rs"),
        ];

        cache.put_with_deps(key.clone(), CachedResult::new("found", false), deps);

        assert!(cache.get(&key).is_some());
        assert_eq!(cache.file_dep_count(), 3);
    }

    #[test]
    fn test_invalidate_for_file_single() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test/file.txt"}));
        let deps = vec![PathBuf::from("/test/file.txt")];

        cache.put_with_deps(key.clone(), CachedResult::new("content", false), deps);

        // Invalidate the file
        let count = cache.invalidate_for_file(Path::new("/test/file.txt"));
        assert_eq!(count, 1);

        // Entry should be gone
        assert!(cache.get(&key).is_none());
        assert_eq!(cache.stats().entries, 0);
        assert_eq!(cache.file_dep_count(), 0);
    }

    #[test]
    fn test_invalidate_for_file_multiple_entries() {
        let mut cache = ToolResultCache::default();

        let shared_file = PathBuf::from("/shared/config.json");

        // Two entries depend on the same file
        let key1 = CacheKey::new("read", &serde_json::json!({"path": "/shared/config.json"}));
        let key2 = CacheKey::new("glob", &serde_json::json!({"pattern": "*.json"}));

        cache.put_with_deps(
            key1.clone(),
            CachedResult::new("content1", false),
            vec![shared_file.clone()],
        );
        cache.put_with_deps(
            key2.clone(),
            CachedResult::new("content2", false),
            vec![shared_file.clone()],
        );

        assert_eq!(cache.stats().entries, 2);

        // Invalidate the shared file
        let count = cache.invalidate_for_file(&shared_file);
        assert_eq!(count, 2);

        assert!(cache.get(&key1).is_none());
        assert!(cache.get(&key2).is_none());
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_invalidate_for_file_partial() {
        let mut cache = ToolResultCache::default();

        let file_a = PathBuf::from("/test/a.txt");
        let file_b = PathBuf::from("/test/b.txt");

        let key_a = CacheKey::new("read", &serde_json::json!({"path": "/test/a.txt"}));
        let key_b = CacheKey::new("read", &serde_json::json!({"path": "/test/b.txt"}));

        cache.put_with_deps(
            key_a.clone(),
            CachedResult::new("content a", false),
            vec![file_a.clone()],
        );
        cache.put_with_deps(
            key_b.clone(),
            CachedResult::new("content b", false),
            vec![file_b.clone()],
        );

        // Invalidate only file_a
        let count = cache.invalidate_for_file(&file_a);
        assert_eq!(count, 1);

        // key_a should be gone, key_b should remain
        assert!(cache.get(&key_a).is_none());
        assert!(cache.get(&key_b).is_some());
        assert_eq!(cache.stats().entries, 1);
    }

    #[test]
    fn test_invalidate_for_file_nonexistent() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test/file.txt"}));
        let deps = vec![PathBuf::from("/test/file.txt")];

        cache.put_with_deps(key.clone(), CachedResult::new("content", false), deps);

        // Invalidate a different file - should not affect anything
        let count = cache.invalidate_for_file(Path::new("/other/file.txt"));
        assert_eq!(count, 0);

        // Original entry should still exist
        assert!(cache.get(&key).is_some());
    }

    #[test]
    fn test_invalidate_for_directory() {
        let mut cache = ToolResultCache::default();

        let key1 = CacheKey::new("read", &serde_json::json!({"path": "/src/a.rs"}));
        let key2 = CacheKey::new("read", &serde_json::json!({"path": "/src/b.rs"}));
        let key3 = CacheKey::new("read", &serde_json::json!({"path": "/other/c.rs"}));

        cache.put_with_deps(
            key1.clone(),
            CachedResult::new("a", false),
            vec![PathBuf::from("/src/a.rs")],
        );
        cache.put_with_deps(
            key2.clone(),
            CachedResult::new("b", false),
            vec![PathBuf::from("/src/b.rs")],
        );
        cache.put_with_deps(
            key3.clone(),
            CachedResult::new("c", false),
            vec![PathBuf::from("/other/c.rs")],
        );

        // Invalidate /src directory
        let count = cache.invalidate_for_directory(Path::new("/src"));
        assert_eq!(count, 2);

        // /src entries should be gone, /other should remain
        assert!(cache.get(&key1).is_none());
        assert!(cache.get(&key2).is_none());
        assert!(cache.get(&key3).is_some());
    }

    #[test]
    fn test_deps_cleaned_on_eviction() {
        let config = CacheConfig {
            max_entries: 2,
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key1 = CacheKey::new("read", &serde_json::json!({"id": 1}));
        let key2 = CacheKey::new("read", &serde_json::json!({"id": 2}));
        let key3 = CacheKey::new("read", &serde_json::json!({"id": 3}));

        cache.put_with_deps(
            key1.clone(),
            CachedResult::new("1", false),
            vec![PathBuf::from("/file1.txt")],
        );
        cache.put_with_deps(
            key2.clone(),
            CachedResult::new("2", false),
            vec![PathBuf::from("/file2.txt")],
        );

        assert_eq!(cache.file_dep_count(), 2);

        // Add third entry - should evict key1
        cache.put_with_deps(
            key3.clone(),
            CachedResult::new("3", false),
            vec![PathBuf::from("/file3.txt")],
        );

        // key1 and its deps should be gone
        assert!(cache.get(&key1).is_none());
        // Deps should be cleaned up
        assert_eq!(cache.file_dep_count(), 2);
    }

    #[test]
    fn test_deps_cleaned_on_clear() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test.txt"}));
        cache.put_with_deps(
            key,
            CachedResult::new("content", false),
            vec![PathBuf::from("/test.txt")],
        );

        assert_eq!(cache.file_dep_count(), 1);

        cache.clear();

        assert_eq!(cache.file_dep_count(), 0);
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_deps_cleaned_on_expiration() {
        let config = CacheConfig {
            ttl: Duration::from_millis(1),
            ..Default::default()
        };
        let mut cache = ToolResultCache::new(config);

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test.txt"}));
        cache.put_with_deps(
            key,
            CachedResult::new("content", false),
            vec![PathBuf::from("/test.txt")],
        );

        assert_eq!(cache.file_dep_count(), 1);

        // Wait for expiration
        std::thread::sleep(Duration::from_millis(10));

        cache.evict_expired();

        assert_eq!(cache.file_dep_count(), 0);
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn test_put_without_deps_still_works() {
        let mut cache = ToolResultCache::default();

        // Regular put without deps
        let key = CacheKey::new("read", &serde_json::json!({"path": "/test.txt"}));
        cache.put(key.clone(), CachedResult::new("content", false));

        assert!(cache.get(&key).is_some());
        assert_eq!(cache.file_dep_count(), 0);
    }

    #[test]
    fn test_multiple_deps_per_entry() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("grep", &serde_json::json!({"pattern": "TODO"}));
        let deps = vec![
            PathBuf::from("/src/main.rs"),
            PathBuf::from("/src/lib.rs"),
            PathBuf::from("/Cargo.toml"),
        ];

        cache.put_with_deps(key.clone(), CachedResult::new("results", false), deps);

        assert_eq!(cache.file_dep_count(), 3);

        // Invalidating any of the files should remove the entry
        let count = cache.invalidate_for_file(Path::new("/src/lib.rs"));
        assert_eq!(count, 1);
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn test_same_key_different_deps() {
        let mut cache = ToolResultCache::default();

        let key = CacheKey::new("read", &serde_json::json!({"path": "/test.txt"}));

        // First put with deps
        cache.put_with_deps(
            key.clone(),
            CachedResult::new("v1", false),
            vec![PathBuf::from("/a.txt")],
        );
        assert_eq!(cache.file_dep_count(), 1);

        // Second put with different deps (overwrites)
        cache.put_with_deps(
            key.clone(),
            CachedResult::new("v2", false),
            vec![PathBuf::from("/b.txt")],
        );

        // Should have both deps now (old dep not cleaned up on overwrite)
        // This is expected behavior - the old entry is replaced but deps remain
        // until the entry is explicitly removed
        assert!(cache.get(&key).is_some());
        assert_eq!(cache.get(&key).unwrap().output, "v2");
    }

    #[test]
    fn test_file_dep_count_accessor() {
        let mut cache = ToolResultCache::default();
        assert_eq!(cache.file_dep_count(), 0);

        cache.put_with_deps(
            CacheKey::new("read", &serde_json::json!({"id": 1})),
            CachedResult::new("1", false),
            vec![PathBuf::from("/a.txt"), PathBuf::from("/b.txt")],
        );

        assert_eq!(cache.file_dep_count(), 2);
    }
}

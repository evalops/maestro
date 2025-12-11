//! Tool Result Cache
//!
//! Provides caching for tool execution results to avoid redundant operations.
//! This is particularly useful for read-only tools like `read` or `glob` where
//! the same inputs will produce the same outputs within a short time window.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
    /// When the entry was created
    #[serde(skip)]
    pub created_at: Option<Instant>,
}

impl CachedResult {
    /// Create a new cached result
    pub fn new(output: impl Into<String>, is_error: bool) -> Self {
        Self {
            output: output.into(),
            is_error,
            created_at: Some(Instant::now()),
        }
    }

    /// Check if the cache entry has expired
    pub fn is_expired(&self, ttl: Duration) -> bool {
        self.created_at.map(|t| t.elapsed() > ttl).unwrap_or(true)
    }
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
        }

        self.entries.insert(key.clone(), result);
        self.access_order.push(key);
    }

    /// Clear the cache
    pub fn clear(&mut self) {
        self.entries.clear();
        self.access_order.clear();
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
}

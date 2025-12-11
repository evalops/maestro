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
}

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
            created_at: None, // Will be None after deserialization anyway
        };

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CachedResult = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.output, original.output);
        assert_eq!(deserialized.is_error, original.is_error);
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
}

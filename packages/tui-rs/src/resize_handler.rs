//! Terminal Resize Handling with Cache Invalidation
//!
//! Provides utilities for detecting terminal resizes and intelligently
//! invalidating caches (like wrapped text) when dimensions change.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::collections::HashMap;
use std::hash::Hash;

// ─────────────────────────────────────────────────────────────────────────────
// TERMINAL SIZE
// ─────────────────────────────────────────────────────────────────────────────

/// Terminal dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TerminalSize {
    pub width: u16,
    pub height: u16,
}

impl TerminalSize {
    /// Create a new terminal size.
    pub fn new(width: u16, height: u16) -> Self {
        Self { width, height }
    }

    /// Get the current terminal size.
    ///
    /// Falls back to 80x24 if detection fails.
    pub fn current() -> Self {
        crossterm::terminal::size()
            .map(|(w, h)| Self::new(w, h))
            .unwrap_or(Self::new(80, 24))
    }

    /// Check if this size is valid (non-zero dimensions).
    pub fn is_valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }

    /// Get the area (width * height).
    pub fn area(&self) -> u32 {
        self.width as u32 * self.height as u32
    }
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self::new(80, 24)
    }
}

impl From<(u16, u16)> for TerminalSize {
    fn from((width, height): (u16, u16)) -> Self {
        Self::new(width, height)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESIZE TRACKER
// ─────────────────────────────────────────────────────────────────────────────

/// Tracks terminal size changes and determines when full redraws are needed.
#[derive(Debug, Clone)]
pub struct ResizeTracker {
    /// Previous terminal size.
    previous_size: Option<TerminalSize>,
    /// Whether the last render overflowed.
    previous_overflow: bool,
    /// Previous line count rendered.
    previous_line_count: usize,
}

impl Default for ResizeTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ResizeTracker {
    /// Create a new resize tracker.
    pub fn new() -> Self {
        Self {
            previous_size: None,
            previous_overflow: false,
            previous_line_count: 0,
        }
    }

    /// Check if a full redraw is needed given the new state.
    ///
    /// Returns true if:
    /// - Width changed (text wrapping invalidated)
    /// - Overflow state changed
    /// - Line count decreased (need to clear old lines)
    pub fn needs_full_redraw(
        &mut self,
        current_size: TerminalSize,
        is_overflow: bool,
        line_count: usize,
    ) -> bool {
        let width_changed = self
            .previous_size
            .map(|prev| prev.width != current_size.width)
            .unwrap_or(false);

        let overflow_changed = self.previous_overflow != is_overflow;
        let line_count_decreased = line_count < self.previous_line_count;

        // Update tracking state
        self.previous_size = Some(current_size);
        self.previous_overflow = is_overflow;
        self.previous_line_count = line_count;

        width_changed || overflow_changed || line_count_decreased
    }

    /// Check if the terminal was resized since last check.
    pub fn was_resized(&self, current_size: TerminalSize) -> bool {
        self.previous_size
            .map(|prev| prev != current_size)
            .unwrap_or(true)
    }

    /// Get the previous size, if known.
    pub fn previous_size(&self) -> Option<TerminalSize> {
        self.previous_size
    }

    /// Update with new size without checking for redraw.
    pub fn update(&mut self, size: TerminalSize, overflow: bool, line_count: usize) {
        self.previous_size = Some(size);
        self.previous_overflow = overflow;
        self.previous_line_count = line_count;
    }

    /// Reset tracking state.
    pub fn reset(&mut self) {
        self.previous_size = None;
        self.previous_overflow = false;
        self.previous_line_count = 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIDTH-KEYED CACHE
// ─────────────────────────────────────────────────────────────────────────────

/// A cache that keys by terminal width.
///
/// When the terminal width changes, only relevant cache entries are kept.
/// This is useful for caching wrapped text at different widths.
///
/// # Example
///
/// ```rust
/// use composer_tui::resize_handler::WidthCache;
///
/// let mut cache: WidthCache<String, Vec<String>> = WidthCache::new(3);
///
/// // Cache wrapped text at width 80
/// cache.insert(80, "key1".to_string(), vec!["wrapped".to_string()]);
///
/// // Retrieve
/// assert!(cache.get(80, &"key1".to_string()).is_some());
///
/// // Different width - not found
/// assert!(cache.get(100, &"key1".to_string()).is_none());
/// ```
pub struct WidthCache<K, V> {
    /// Cache entries keyed by (width, key).
    entries: HashMap<u16, HashMap<K, V>>,
    /// Maximum number of widths to keep.
    max_widths: usize,
    /// Recently used widths (most recent last).
    recent_widths: Vec<u16>,
}

impl<K: Eq + Hash, V> Default for WidthCache<K, V> {
    fn default() -> Self {
        Self::new(3)
    }
}

impl<K: Eq + Hash, V> WidthCache<K, V> {
    /// Create a new width cache.
    ///
    /// `max_widths` is the number of different terminal widths to cache.
    pub fn new(max_widths: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max_widths: max_widths.max(1),
            recent_widths: Vec::new(),
        }
    }

    /// Insert a value at a specific width.
    pub fn insert(&mut self, width: u16, key: K, value: V) {
        // Update recent widths
        self.recent_widths.retain(|&w| w != width);
        self.recent_widths.push(width);

        // Prune old widths if over limit
        while self.recent_widths.len() > self.max_widths {
            if let Some(old_width) = self.recent_widths.first().copied() {
                self.recent_widths.remove(0);
                self.entries.remove(&old_width);
            }
        }

        // Insert entry
        self.entries
            .entry(width)
            .or_insert_with(HashMap::new)
            .insert(key, value);
    }

    /// Get a value at a specific width.
    pub fn get(&self, width: u16, key: &K) -> Option<&V> {
        self.entries.get(&width)?.get(key)
    }

    /// Get a mutable value at a specific width.
    pub fn get_mut(&mut self, width: u16, key: &K) -> Option<&mut V> {
        self.entries.get_mut(&width)?.get_mut(key)
    }

    /// Remove a value at a specific width.
    pub fn remove(&mut self, width: u16, key: &K) -> Option<V> {
        self.entries.get_mut(&width)?.remove(key)
    }

    /// Clear all entries for a specific width.
    pub fn clear_width(&mut self, width: u16) {
        self.entries.remove(&width);
        self.recent_widths.retain(|&w| w != width);
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.recent_widths.clear();
    }

    /// Get the number of cached widths.
    pub fn width_count(&self) -> usize {
        self.entries.len()
    }

    /// Get the total number of cached entries.
    pub fn entry_count(&self) -> usize {
        self.entries.values().map(|m| m.len()).sum()
    }

    /// Check if the cache contains a key at any width.
    pub fn contains_key_any_width(&self, key: &K) -> bool {
        self.entries.values().any(|m| m.contains_key(key))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAP CACHE
// ─────────────────────────────────────────────────────────────────────────────

/// Specialized cache for wrapped text.
///
/// Caches the result of wrapping text to a specific width.
pub type WrapCache = WidthCache<String, Vec<String>>;

impl WrapCache {
    /// Get or compute wrapped text.
    ///
    /// If the text is already cached for this width, returns the cached version.
    /// Otherwise, computes using the provided function and caches the result.
    pub fn get_or_wrap<F>(&mut self, width: u16, text: &str, wrap_fn: F) -> &Vec<String>
    where
        F: FnOnce(&str, u16) -> Vec<String>,
    {
        let key = text.to_string();

        if self.get(width, &key).is_none() {
            let wrapped = wrap_fn(text, width);
            self.insert(width, key.clone(), wrapped);
        }

        self.get(width, &key).unwrap()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_basics() {
        let size = TerminalSize::new(80, 24);
        assert!(size.is_valid());
        assert_eq!(size.area(), 1920);

        let invalid = TerminalSize::new(0, 24);
        assert!(!invalid.is_valid());
    }

    #[test]
    fn resize_tracker_detects_width_change() {
        let mut tracker = ResizeTracker::new();

        // First call - no previous state
        let needs = tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 10);
        assert!(!needs); // No previous size to compare

        // Same size - no redraw needed
        let needs = tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 10);
        assert!(!needs);

        // Width changed - redraw needed
        let needs = tracker.needs_full_redraw(TerminalSize::new(100, 24), false, 10);
        assert!(needs);
    }

    #[test]
    fn resize_tracker_detects_overflow_change() {
        let mut tracker = ResizeTracker::new();

        tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 10);

        // Overflow changed - redraw needed
        let needs = tracker.needs_full_redraw(TerminalSize::new(80, 24), true, 10);
        assert!(needs);
    }

    #[test]
    fn resize_tracker_detects_line_decrease() {
        let mut tracker = ResizeTracker::new();

        tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 10);

        // Line count decreased - redraw needed
        let needs = tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 5);
        assert!(needs);

        // Line count increased - no redraw
        let needs = tracker.needs_full_redraw(TerminalSize::new(80, 24), false, 15);
        assert!(!needs);
    }

    #[test]
    fn width_cache_basic_operations() {
        let mut cache: WidthCache<String, i32> = WidthCache::new(3);

        cache.insert(80, "key1".to_string(), 100);
        cache.insert(80, "key2".to_string(), 200);

        assert_eq!(cache.get(80, &"key1".to_string()), Some(&100));
        assert_eq!(cache.get(80, &"key2".to_string()), Some(&200));
        assert_eq!(cache.get(100, &"key1".to_string()), None);
    }

    #[test]
    fn width_cache_prunes_old_widths() {
        let mut cache: WidthCache<String, i32> = WidthCache::new(2);

        cache.insert(80, "key".to_string(), 1);
        cache.insert(100, "key".to_string(), 2);
        cache.insert(120, "key".to_string(), 3);

        // Width 80 should be pruned
        assert_eq!(cache.get(80, &"key".to_string()), None);
        assert_eq!(cache.get(100, &"key".to_string()), Some(&2));
        assert_eq!(cache.get(120, &"key".to_string()), Some(&3));
    }

    #[test]
    fn width_cache_lru_behavior() {
        let mut cache: WidthCache<String, i32> = WidthCache::new(2);

        cache.insert(80, "key".to_string(), 1);
        cache.insert(100, "key".to_string(), 2);

        // Access 80 again to make it recent
        cache.insert(80, "key2".to_string(), 3);

        // Add new width - should prune 100, not 80
        cache.insert(120, "key".to_string(), 4);

        assert!(cache.get(80, &"key".to_string()).is_some());
        assert!(cache.get(100, &"key".to_string()).is_none());
    }

    #[test]
    fn wrap_cache_get_or_wrap() {
        let mut cache = WrapCache::new(3);

        let wrapped = cache.get_or_wrap(80, "hello world", |text, _width| vec![text.to_string()]);
        assert_eq!(wrapped, &vec!["hello world".to_string()]);

        // Should return cached value
        let wrapped2 = cache.get_or_wrap(80, "hello world", |_, _| {
            panic!("should not be called - cached");
        });
        assert_eq!(wrapped2, &vec!["hello world".to_string()]);
    }
}

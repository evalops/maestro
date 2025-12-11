//! Prompt history storage and search

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Configuration for prompt history
#[derive(Debug, Clone)]
pub struct HistoryConfig {
    /// Maximum number of entries to keep
    pub max_entries: usize,
    /// Path to history file
    pub path: PathBuf,
    /// Whether to deduplicate consecutive entries
    pub deduplicate: bool,
    /// Minimum prompt length to store
    pub min_length: usize,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".composer")
            .join("history")
            .join("prompts.jsonl");

        Self {
            max_entries: 10000,
            path,
            deduplicate: true,
            min_length: 2,
        }
    }
}

impl HistoryConfig {
    /// Create config with custom path
    pub fn with_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.path = path.into();
        self
    }

    /// Set max entries
    pub fn with_max_entries(mut self, max: usize) -> Self {
        self.max_entries = max;
        self
    }
}

/// A single history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// The prompt text
    pub prompt: String,
    /// When the prompt was entered
    pub timestamp: SystemTime,
    /// Optional session ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Optional tags
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl HistoryEntry {
    /// Create a new history entry
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            timestamp: SystemTime::now(),
            session_id: None,
            tags: Vec::new(),
        }
    }

    /// Set session ID
    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Add a tag
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }
}

/// Result of a history search
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Matching entries
    pub matches: Vec<SearchMatch>,
    /// Total searched
    pub total_searched: usize,
}

/// A single search match
#[derive(Debug, Clone)]
pub struct SearchMatch {
    /// The matching entry
    pub entry: HistoryEntry,
    /// Index in history (0 = most recent)
    pub index: usize,
    /// Match score (higher = better match)
    pub score: f64,
}

/// Prompt history with persistence and navigation
#[derive(Debug)]
pub struct PromptHistory {
    /// In-memory entries (most recent last)
    entries: VecDeque<HistoryEntry>,
    /// Current navigation position (None = not navigating)
    position: Option<usize>,
    /// Working buffer for current input
    working_buffer: String,
    /// Configuration
    config: HistoryConfig,
    /// Whether history has been modified
    dirty: bool,
}

impl PromptHistory {
    /// Create a new empty history
    pub fn new(config: HistoryConfig) -> Self {
        Self {
            entries: VecDeque::new(),
            position: None,
            working_buffer: String::new(),
            config,
            dirty: false,
        }
    }

    /// Load history from default location or create new
    pub fn load_or_create() -> std::io::Result<Self> {
        Self::load_with_config(HistoryConfig::default())
    }

    /// Load history with custom config
    pub fn load_with_config(config: HistoryConfig) -> std::io::Result<Self> {
        let mut history = Self::new(config);
        history.load()?;
        Ok(history)
    }

    /// Load entries from disk
    pub fn load(&mut self) -> std::io::Result<()> {
        if !self.config.path.exists() {
            return Ok(());
        }

        let file = File::open(&self.config.path)?;
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = line?;
            if line.is_empty() {
                continue;
            }

            if let Ok(entry) = serde_json::from_str::<HistoryEntry>(&line) {
                self.entries.push_back(entry);
            }
        }

        // Trim to max entries
        while self.entries.len() > self.config.max_entries {
            self.entries.pop_front();
        }

        Ok(())
    }

    /// Save history to disk
    pub fn save(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }

        // Ensure directory exists
        if let Some(parent) = self.config.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = File::create(&self.config.path)?;
        let mut writer = BufWriter::new(file);

        for entry in &self.entries {
            if let Ok(line) = serde_json::to_string(entry) {
                writeln!(writer, "{}", line)?;
            }
        }

        writer.flush()?;
        self.dirty = false;
        Ok(())
    }

    /// Append a single entry (efficient incremental save)
    fn append_to_file(&self, entry: &HistoryEntry) -> std::io::Result<()> {
        if let Some(parent) = self.config.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.config.path)?;
        let mut writer = BufWriter::new(file);

        if let Ok(line) = serde_json::to_string(entry) {
            writeln!(writer, "{}", line)?;
        }

        writer.flush()
    }

    /// Add a prompt to history
    pub fn add(&mut self, prompt: impl Into<String>) {
        let prompt = prompt.into();

        // Skip if too short
        if prompt.len() < self.config.min_length {
            return;
        }

        // Skip if duplicate of last entry
        if self.config.deduplicate {
            if let Some(last) = self.entries.back() {
                if last.prompt == prompt {
                    return;
                }
            }
        }

        let entry = HistoryEntry::new(&prompt);

        // Append to file immediately (for persistence)
        let _ = self.append_to_file(&entry);

        self.entries.push_back(entry);
        self.dirty = true;

        // Trim if over limit
        while self.entries.len() > self.config.max_entries {
            self.entries.pop_front();
        }

        // Reset navigation
        self.position = None;
    }

    /// Add a prompt with session context
    pub fn add_with_session(&mut self, prompt: impl Into<String>, session_id: impl Into<String>) {
        let prompt = prompt.into();

        if prompt.len() < self.config.min_length {
            return;
        }

        if self.config.deduplicate {
            if let Some(last) = self.entries.back() {
                if last.prompt == prompt {
                    return;
                }
            }
        }

        let entry = HistoryEntry::new(&prompt).with_session(session_id);
        let _ = self.append_to_file(&entry);

        self.entries.push_back(entry);
        self.dirty = true;

        while self.entries.len() > self.config.max_entries {
            self.entries.pop_front();
        }

        self.position = None;
    }

    /// Start navigation with current input
    pub fn start_navigation(&mut self, current_input: &str) {
        self.working_buffer = current_input.to_string();
        self.position = None;
    }

    /// Get the previous entry (up arrow)
    pub fn previous(&mut self) -> Option<&str> {
        if self.entries.is_empty() {
            return None;
        }

        let new_pos = match self.position {
            None => self.entries.len().saturating_sub(1),
            Some(0) => 0,
            Some(pos) => pos - 1,
        };

        self.position = Some(new_pos);
        self.entries.get(new_pos).map(|e| e.prompt.as_str())
    }

    /// Get the next entry (down arrow)
    pub fn next(&mut self) -> Option<&str> {
        match self.position {
            None => None,
            Some(pos) => {
                if pos + 1 >= self.entries.len() {
                    // Return to working buffer
                    self.position = None;
                    Some(self.working_buffer.as_str())
                } else {
                    self.position = Some(pos + 1);
                    self.entries.get(pos + 1).map(|e| e.prompt.as_str())
                }
            }
        }
    }

    /// Reset navigation position
    pub fn reset_navigation(&mut self) {
        self.position = None;
        self.working_buffer.clear();
    }

    /// Get the current entry being viewed (if navigating)
    pub fn current(&self) -> Option<&str> {
        match self.position {
            None => None,
            Some(pos) => self.entries.get(pos).map(|e| e.prompt.as_str()),
        }
    }

    /// Check if currently navigating
    pub fn is_navigating(&self) -> bool {
        self.position.is_some()
    }

    /// Search history with fuzzy matching
    pub fn search(&self, query: &str) -> SearchResult {
        let query_lower = query.to_lowercase();
        let mut matches = Vec::new();

        for (idx, entry) in self.entries.iter().enumerate().rev() {
            let prompt_lower = entry.prompt.to_lowercase();

            // Calculate match score
            let score = if entry.prompt == query {
                1.0 // Exact match
            } else if prompt_lower == query_lower {
                0.95 // Case-insensitive exact match
            } else if prompt_lower.starts_with(&query_lower) {
                0.9 // Prefix match
            } else if prompt_lower.contains(&query_lower) {
                0.7 // Contains match
            } else if fuzzy_match(&prompt_lower, &query_lower) {
                0.5 // Fuzzy match
            } else {
                continue;
            };

            // Recency boost: more recent entries get higher scores
            let recency_boost = (idx as f64 / self.entries.len() as f64) * 0.1;

            matches.push(SearchMatch {
                entry: entry.clone(),
                index: self.entries.len() - 1 - idx,
                score: score + recency_boost,
            });
        }

        // Sort by score descending
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

        SearchResult {
            matches,
            total_searched: self.entries.len(),
        }
    }

    /// Get recent entries
    pub fn recent(&self, count: usize) -> Vec<&HistoryEntry> {
        self.entries.iter().rev().take(count).collect()
    }

    /// Get all entries
    pub fn all(&self) -> impl Iterator<Item = &HistoryEntry> {
        self.entries.iter()
    }

    /// Get entry count
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clear all history
    pub fn clear(&mut self) {
        self.entries.clear();
        self.position = None;
        self.dirty = true;
    }

    /// Delete history file
    pub fn delete_file(&self) -> std::io::Result<()> {
        if self.config.path.exists() {
            fs::remove_file(&self.config.path)
        } else {
            Ok(())
        }
    }

    /// Get entries for a specific session
    pub fn for_session(&self, session_id: &str) -> Vec<&HistoryEntry> {
        self.entries
            .iter()
            .filter(|e| e.session_id.as_deref() == Some(session_id))
            .collect()
    }
}

impl Default for PromptHistory {
    fn default() -> Self {
        Self::new(HistoryConfig::default())
    }
}

/// Simple fuzzy matching (checks if all query chars appear in order)
fn fuzzy_match(haystack: &str, needle: &str) -> bool {
    let mut haystack_chars = haystack.chars().peekable();

    for needle_char in needle.chars() {
        loop {
            match haystack_chars.next() {
                Some(h_char) if h_char == needle_char => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_config(dir: &TempDir) -> HistoryConfig {
        HistoryConfig::default()
            .with_path(dir.path().join("test_history.jsonl"))
            .with_max_entries(100)
    }

    #[test]
    fn test_add_and_retrieve() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("first");
        history.add("second");
        history.add("third");

        assert_eq!(history.len(), 3);
    }

    #[test]
    fn test_deduplication() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("same");
        history.add("same"); // Should be skipped
        history.add("different");
        history.add("same"); // Should be added (not consecutive)

        assert_eq!(history.len(), 3);
    }

    #[test]
    fn test_navigation() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("first");
        history.add("second");
        history.add("third");

        history.start_navigation("current");

        assert_eq!(history.previous(), Some("third"));
        assert_eq!(history.previous(), Some("second"));
        assert_eq!(history.previous(), Some("first"));
        assert_eq!(history.previous(), Some("first")); // Stays at first

        assert_eq!(history.next(), Some("second"));
        assert_eq!(history.next(), Some("third"));
        assert_eq!(history.next(), Some("current")); // Back to working buffer
    }

    #[test]
    fn test_search_exact() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("git status");
        history.add("git commit -m 'test'");
        history.add("npm install");

        let results = history.search("git");
        assert_eq!(results.matches.len(), 2);
        assert!(results.matches[0].entry.prompt.contains("git"));
    }

    #[test]
    fn test_search_fuzzy() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("git status");
        history.add("commit message");

        // "gs" should fuzzy match "git status"
        let results = history.search("gs");
        assert!(!results.matches.is_empty());
    }

    #[test]
    fn test_persistence() {
        let dir = TempDir::new().unwrap();
        let config = test_config(&dir);

        // Write history
        {
            let mut history = PromptHistory::new(config.clone());
            history.add("persisted");
            history.save().unwrap();
        }

        // Read it back
        {
            let history = PromptHistory::load_with_config(config).unwrap();
            assert_eq!(history.len(), 1);
            assert_eq!(history.entries[0].prompt, "persisted");
        }
    }

    #[test]
    fn test_max_entries() {
        let dir = TempDir::new().unwrap();
        let config = test_config(&dir).with_max_entries(3);
        let mut history = PromptHistory::new(config);

        history.add("one");
        history.add("two");
        history.add("three");
        history.add("four"); // Should evict "one"

        assert_eq!(history.len(), 3);
        assert_eq!(history.entries[0].prompt, "two");
    }

    #[test]
    fn test_min_length() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("x"); // Too short
        history.add("ok"); // Just right

        assert_eq!(history.len(), 1);
    }

    #[test]
    fn test_session_filter() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add_with_session("session1 prompt", "sess-1");
        history.add_with_session("session2 prompt", "sess-2");
        history.add("no session");

        let sess1 = history.for_session("sess-1");
        assert_eq!(sess1.len(), 1);
        assert_eq!(sess1[0].prompt, "session1 prompt");
    }

    #[test]
    fn test_fuzzy_match_function() {
        assert!(fuzzy_match("git status", "gs"));
        assert!(fuzzy_match("hello world", "hlo"));
        assert!(!fuzzy_match("abc", "xyz"));
        assert!(fuzzy_match("abc", "ac"));
    }

    #[test]
    fn test_recent() {
        let dir = TempDir::new().unwrap();
        let mut history = PromptHistory::new(test_config(&dir));

        history.add("old");
        history.add("middle");
        history.add("recent");

        let recent = history.recent(2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].prompt, "recent");
        assert_eq!(recent[1].prompt, "middle");
    }
}

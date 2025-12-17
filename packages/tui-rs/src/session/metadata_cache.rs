//! Session Metadata Cache
//!
//! In-memory cache for tracking current session metadata (model, thinking level)
//! without requiring a full re-read of the session file.
//!
//! # Purpose
//!
//! When resuming a session, we need to know the current model and thinking level
//! settings. Rather than re-reading the entire session file every time, this cache
//! is seeded once during session load and updated as changes are written.
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::session::{SessionMetadataCache, SessionEntry};
//!
//! let mut cache = SessionMetadataCache::new();
//!
//! // Seed from existing session file
//! cache.seed_from_file("/path/to/session.jsonl");
//!
//! // Or apply entries as they're written
//! cache.apply(&entry);
//!
//! // Query current state
//! println!("Model: {:?}", cache.model());
//! println!("Thinking: {}", cache.thinking_level().label());
//! ```
//!
//! # Performance
//!
//! - `seed_from_file`: O(n) where n is the number of entries
//! - `apply`: O(1)
//! - `model/thinking_level`: O(1)
//!
//! Memory usage is minimal - just the current model string and thinking level enum.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::entries::{ModelChange, ModelMetadata, SessionEntry, ThinkingLevel};

/// In-memory cache for session metadata.
///
/// Tracks the current model and thinking level without requiring full session re-reads.
/// This cache is updated incrementally as session entries are written or when loading
/// an existing session.
#[derive(Debug, Default)]
pub struct SessionMetadataCache {
    /// Current thinking level ("off", "minimal", "low", "medium", "high", "max")
    thinking_level: ThinkingLevel,

    /// Current model in format "provider/modelId" (e.g., "anthropic/claude-opus-4-5-20251101")
    model: Option<String>,

    /// Full metadata for the current model (capabilities, context window, etc.)
    metadata: Option<ModelMetadata>,
}

impl SessionMetadataCache {
    /// Create a new empty cache with default values.
    pub fn new() -> Self {
        Self::default()
    }

    /// Update the cache based on a session entry.
    ///
    /// Called when writing new entries or loading existing sessions.
    /// Only processes entry types that affect model/thinking state.
    ///
    /// # Arguments
    ///
    /// * `entry` - The session entry to process
    pub fn apply(&mut self, entry: &SessionEntry) {
        match entry {
            SessionEntry::Session(header) => {
                self.thinking_level = header.thinking_level;
                self.model = Some(header.model.clone());
                self.metadata = header.model_metadata.clone();
            }
            SessionEntry::ThinkingLevelChange(change) => {
                self.thinking_level = change.thinking_level;
            }
            SessionEntry::ModelChange(ModelChange {
                model,
                model_metadata,
                ..
            }) => {
                self.model = Some(model.clone());
                self.metadata = model_metadata.clone();
            }
            // Other entry types don't affect metadata
            SessionEntry::Message(_)
            | SessionEntry::SessionMeta(_)
            | SessionEntry::Compaction(_) => {}
        }
    }

    /// Seed the cache by reading all entries from an existing session file.
    ///
    /// This reads the entire file but only parses entries that affect metadata.
    /// Invalid lines are silently skipped to be resilient to partial/corrupt files.
    ///
    /// # Arguments
    ///
    /// * `path` - Path to the session JSONL file
    ///
    /// # Returns
    ///
    /// Returns `true` if the file was successfully read (even if empty),
    /// `false` if the file couldn't be opened.
    pub fn seed_from_file(&mut self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();

        let file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return false,
        };

        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            if line.trim().is_empty() {
                continue;
            }

            // Quick check to avoid parsing irrelevant entries
            if !line.contains("\"type\":\"session\"")
                && !line.contains("\"type\":\"thinking_level_change\"")
                && !line.contains("\"type\":\"model_change\"")
            {
                continue;
            }

            if let Ok(entry) = serde_json::from_str::<SessionEntry>(&line) {
                self.apply(&entry);
            }
        }

        true
    }

    /// Get the current thinking level.
    pub fn thinking_level(&self) -> ThinkingLevel {
        self.thinking_level
    }

    /// Get the current model identifier.
    ///
    /// Returns `None` if no session has been loaded or started.
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    /// Get the current model metadata.
    ///
    /// Returns `None` if no metadata is available or no session has been loaded.
    pub fn model_metadata(&self) -> Option<&ModelMetadata> {
        self.metadata.as_ref()
    }

    /// Reset the cache to initial state.
    ///
    /// Useful when switching sessions or clearing state.
    pub fn reset(&mut self) {
        self.thinking_level = ThinkingLevel::default();
        self.model = None;
        self.metadata = None;
    }

    /// Set the thinking level directly.
    ///
    /// Use this when the user changes the thinking level via UI.
    pub fn set_thinking_level(&mut self, level: ThinkingLevel) {
        self.thinking_level = level;
    }

    /// Set the model directly.
    ///
    /// Use this when the user changes the model via UI.
    pub fn set_model(&mut self, model: String, metadata: Option<ModelMetadata>) {
        self.model = Some(model);
        self.metadata = metadata;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::entries::{SessionHeader, ThinkingLevelChange};
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn create_session_header(model: &str, thinking_level: ThinkingLevel) -> SessionEntry {
        SessionEntry::Session(SessionHeader {
            id: "test123".to_string(),
            timestamp: "2024-01-15T10:30:00Z".to_string(),
            cwd: "/tmp".to_string(),
            model: model.to_string(),
            model_metadata: None,
            thinking_level,
            system_prompt: None,
            tools: vec![],
            branched_from: None,
        })
    }

    #[test]
    fn new_cache_has_defaults() {
        let cache = SessionMetadataCache::new();
        assert_eq!(cache.thinking_level(), ThinkingLevel::Medium); // Default
        assert!(cache.model().is_none());
        assert!(cache.model_metadata().is_none());
    }

    #[test]
    fn apply_session_entry() {
        let mut cache = SessionMetadataCache::new();
        let entry = create_session_header("anthropic/claude-3", ThinkingLevel::High);

        cache.apply(&entry);

        assert_eq!(cache.thinking_level(), ThinkingLevel::High);
        assert_eq!(cache.model(), Some("anthropic/claude-3"));
    }

    #[test]
    fn apply_thinking_level_change() {
        let mut cache = SessionMetadataCache::new();
        cache.apply(&create_session_header(
            "anthropic/claude-3",
            ThinkingLevel::Low,
        ));

        assert_eq!(cache.thinking_level(), ThinkingLevel::Low);

        cache.apply(&SessionEntry::ThinkingLevelChange(ThinkingLevelChange {
            timestamp: "2024-01-15T10:31:00Z".to_string(),
            thinking_level: ThinkingLevel::Max,
        }));

        assert_eq!(cache.thinking_level(), ThinkingLevel::Max);
        // Model should be unchanged
        assert_eq!(cache.model(), Some("anthropic/claude-3"));
    }

    #[test]
    fn apply_model_change() {
        let mut cache = SessionMetadataCache::new();
        cache.apply(&create_session_header(
            "anthropic/claude-3",
            ThinkingLevel::Medium,
        ));

        cache.apply(&SessionEntry::ModelChange(ModelChange {
            timestamp: "2024-01-15T10:31:00Z".to_string(),
            model: "openai/gpt-4".to_string(),
            model_metadata: Some(ModelMetadata {
                provider: "openai".to_string(),
                model_id: "gpt-4".to_string(),
                provider_name: Some("OpenAI".to_string()),
                name: Some("GPT-4".to_string()),
                base_url: None,
                reasoning: None,
                context_window: Some(128000),
                max_tokens: None,
                source: None,
            }),
        }));

        assert_eq!(cache.model(), Some("openai/gpt-4"));
        assert!(cache.model_metadata().is_some());
        assert_eq!(
            cache.model_metadata().unwrap().provider_name,
            Some("OpenAI".to_string())
        );
    }

    #[test]
    fn seed_from_file() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"type":"session","id":"test123","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"anthropic/claude-3","thinking_level":"high"}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","timestamp":"2024-01-15T10:30:01Z","message":{{"role":"user","content":"Hello","timestamp":0}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"thinking_level_change","timestamp":"2024-01-15T10:31:00Z","thinking_level":"max"}}"#).unwrap();

        let mut cache = SessionMetadataCache::new();
        let success = cache.seed_from_file(file.path());

        assert!(success);
        assert_eq!(cache.model(), Some("anthropic/claude-3"));
        assert_eq!(cache.thinking_level(), ThinkingLevel::Max);
    }

    #[test]
    fn seed_from_nonexistent_file() {
        let mut cache = SessionMetadataCache::new();
        let success = cache.seed_from_file("/nonexistent/path/session.jsonl");

        assert!(!success);
        // Should retain defaults
        assert!(cache.model().is_none());
    }

    #[test]
    fn seed_handles_malformed_lines() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"type":"session","id":"test123","timestamp":"2024-01-15T10:30:00Z","cwd":"/tmp","model":"anthropic/claude-3","thinking_level":"low"}}"#).unwrap();
        writeln!(file, r#"{{ invalid json }}"#).unwrap();
        writeln!(file, r#"{{"type":"thinking_level_change","timestamp":"2024-01-15T10:31:00Z","thinking_level":"high"}}"#).unwrap();

        let mut cache = SessionMetadataCache::new();
        cache.seed_from_file(file.path());

        // Should have processed valid lines
        assert_eq!(cache.model(), Some("anthropic/claude-3"));
        assert_eq!(cache.thinking_level(), ThinkingLevel::High);
    }

    #[test]
    fn reset_clears_state() {
        let mut cache = SessionMetadataCache::new();
        cache.apply(&create_session_header(
            "anthropic/claude-3",
            ThinkingLevel::High,
        ));

        assert!(cache.model().is_some());
        assert_eq!(cache.thinking_level(), ThinkingLevel::High);

        cache.reset();

        assert!(cache.model().is_none());
        assert_eq!(cache.thinking_level(), ThinkingLevel::Medium); // Default
    }

    #[test]
    fn set_thinking_level_directly() {
        let mut cache = SessionMetadataCache::new();
        cache.set_thinking_level(ThinkingLevel::Max);
        assert_eq!(cache.thinking_level(), ThinkingLevel::Max);
    }

    #[test]
    fn set_model_directly() {
        let mut cache = SessionMetadataCache::new();
        cache.set_model("openai/gpt-4".to_string(), None);
        assert_eq!(cache.model(), Some("openai/gpt-4"));
    }
}

//! Command matching and tab completion
//!
//! This module implements fuzzy matching for slash commands with an intelligent
//! scoring algorithm. It enables features like command autocomplete, ranked suggestions,
//! and tab-cycling through matches.
//!
//! # Fuzzy Matching Algorithm
//!
//! The matcher uses a tiered scoring system that prioritizes different match types:
//!
//! ## Score Hierarchy (highest to lowest)
//!
//! 1. **Exact Match (100)**: Input matches the command name exactly
//!    - Example: "help" matches "/help" perfectly
//!
//! 2. **Prefix Match - Name (70)**: Input is a prefix of the command name
//!    - Example: "the" matches "/theme"
//!
//! 3. **Prefix Match - Alias (55)**: Input is a prefix of an alias
//!    - Example: "h" matches "/help" via alias "h"
//!
//! 4. **Contains Match - Name (25)**: Command name contains the input as substring
//!    - Example: "ver" matches "/version"
//!
//! 5. **Contains Match - Alias (15)**: Alias contains the input as substring
//!    - Example: "s" matches "/session" via alias "ss"
//!
//! ## Bonus Points
//!
//! Commands receive additional points based on usage patterns:
//!
//! - **Favorite with query (+12)**: User has marked this as a favorite
//! - **Favorite without query (+8)**: Favorite when showing all commands
//! - **Recent with query (+8)**: Command was recently used
//! - **Recent without query (+5)**: Recently used when showing all commands
//!
//! # Tab Completion
//!
//! The `SlashCycleState` struct manages state for cycling through command completions:
//!
//! - Maintains a cached list of matches for the current query
//! - Tracks the current index in the completion list
//! - Resets when the query changes
//! - Supports forward (Tab) and backward (Shift+Tab) cycling
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use composer_tui::commands::{build_command_registry, SlashCommandMatcher, SlashCycleState};
//! use std::sync::Arc;
//!
//! let registry = Arc::new(build_command_registry());
//! let mut matcher = SlashCommandMatcher::new(Arc::clone(&registry));
//!
//! // Add favorites for better scoring
//! matcher.add_favorite("help");
//! matcher.add_favorite("theme");
//!
//! // Get matches for a partial query
//! let matches = matcher.get_matches("/the");
//! // Returns: [theme (score: 70), thinking (score: 25), ...]
//!
//! // Record usage for recent commands bonus
//! matcher.record_usage("theme");
//!
//! // Tab completion cycling
//! let mut cycle = SlashCycleState::new();
//! cycle.set_query("/h", &matcher);
//! let first = cycle.current();       // Some("/help")
//! cycle.cycle_next();
//! let second = cycle.current();      // Some("/help") or next match
//! ```
//!
//! # Performance
//!
//! - **Matching**: O(n) where n = number of commands (typically 20-30)
//! - **Sorting**: O(n log n) for score-based ranking
//! - **Favorites/Recent**: O(1) lookup using Vec::contains (small lists)
//! - **Query caching**: Tab cycling avoids re-matching on every keypress

use std::sync::Arc;

use super::registry::CommandRegistry;
use super::types::Command;

/// A matched command with its computed score
///
/// Represents a single command that matched a user's query, along with metadata
/// about how it matched and its relevance score.
///
/// # Fields
///
/// - `command`: Arc reference to the matched command (cheap to clone)
/// - `score`: Numeric score indicating match quality (higher = better match)
/// - `matched_alias`: If matched via alias, stores which alias matched
/// - `matched_name`: The actual name or alias string that was matched
///
/// # Usage in UI
///
/// The UI can use these fields to:
/// - Display the matched name (could be primary name or alias)
/// - Show which alias was used (e.g., "help (h)")
/// - Rank matches by score for autocomplete suggestions
///
/// # Example
///
/// ```rust,ignore
/// // User types "/h"
/// // Matcher returns CommandMatch {
/// //   command: Arc<Command> for "help",
/// //   score: 100 (exact alias match),
/// //   matched_alias: Some("h"),
/// //   matched_name: "h"
/// // }
/// ```
#[derive(Debug, Clone)]
pub struct CommandMatch {
    /// The matched command (Arc for cheap cloning)
    pub command: Arc<Command>,
    /// Match score (higher is better)
    pub score: i32,
    /// If matched via alias, stores the alias name
    pub matched_alias: Option<String>,
    /// The name or alias that was matched (for display)
    pub matched_name: String,
}

impl CommandMatch {
    /// Create a new match
    pub fn new(command: Arc<Command>, score: i32) -> Self {
        Self {
            matched_name: command.name.clone(),
            command,
            score,
            matched_alias: None,
        }
    }

    /// Set matched alias
    pub fn with_alias(mut self, alias: String) -> Self {
        self.matched_alias = Some(alias.clone());
        self.matched_name = alias;
        self
    }
}

/// Scoring constants for fuzzy matching
///
/// These constants define the point values for different types of matches
/// in the fuzzy matching algorithm. Higher scores indicate better matches.
///
/// The values are carefully tuned to prioritize:
/// 1. Exact matches over partial matches
/// 2. Primary names over aliases
/// 3. Prefix matches over substring matches
/// 4. User preferences (favorites/recent) as tiebreakers
mod scores {
    /// Perfect match: query equals command name exactly
    pub const EXACT_MATCH: i32 = 100;

    /// Query is a prefix of the primary command name (e.g., "the" -> "theme")
    pub const PREFIX_MATCH_NAME: i32 = 70;

    /// Query is a prefix of an alias (e.g., "h" -> "help" via "h" alias)
    pub const PREFIX_MATCH_ALIAS: i32 = 55;

    /// Primary name contains query as substring (e.g., "ver" -> "version")
    pub const CONTAINS_MATCH_NAME: i32 = 25;

    /// Alias contains query as substring (less common)
    pub const CONTAINS_MATCH_ALIAS: i32 = 15;

    /// Bonus for favorite commands when user typed a query
    pub const FAVORITE_BONUS_WITH_QUERY: i32 = 12;

    /// Bonus for favorite commands when showing all (no query)
    pub const FAVORITE_BONUS_NO_QUERY: i32 = 8;

    /// Bonus for recently used commands when user typed a query
    pub const RECENT_BONUS_WITH_QUERY: i32 = 8;

    /// Bonus for recently used commands when showing all (no query)
    pub const RECENT_BONUS_NO_QUERY: i32 = 5;
}

/// Slash command matcher with fuzzy matching and tab completion
///
/// The `SlashCommandMatcher` provides intelligent command matching with scoring,
/// favorites tracking, and usage history. It wraps a `CommandRegistry` and adds
/// fuzzy search capabilities.
///
/// # Arc-based Registry Access
///
/// The matcher holds an `Arc<CommandRegistry>` for:
/// - Cheap cloning when creating multiple matchers
/// - Thread-safe shared access to the command registry
/// - No need to duplicate the entire registry for each matcher
///
/// # State Management
///
/// The matcher maintains mutable state for:
/// - **Favorites**: User-marked commands that get bonus points
/// - **Recent**: LRU (Least Recently Used) list of commands, capped at `max_recent`
///
/// This state influences scoring but doesn't affect the underlying registry.
///
/// # Example
///
/// ```rust,ignore
/// use composer_tui::commands::{build_command_registry, SlashCommandMatcher};
/// use std::sync::Arc;
///
/// let registry = Arc::new(build_command_registry());
/// let mut matcher = SlashCommandMatcher::new(registry);
///
/// // Track favorites
/// matcher.add_favorite("help");
/// matcher.add_favorite("quit");
///
/// // Record usage (maintains LRU list)
/// matcher.record_usage("theme");
/// matcher.record_usage("model");
///
/// // Get matches with bonuses applied
/// let matches = matcher.get_matches("h");
/// // "help" gets higher score due to favorite bonus
/// ```
pub struct SlashCommandMatcher {
    /// Arc reference to the command registry (shared ownership)
    registry: Arc<CommandRegistry>,
    /// Favorite commands (receive bonus points in scoring)
    favorites: Vec<String>,
    /// Recently used commands (LRU list, newest first)
    recent: Vec<String>,
    /// Maximum recent commands to track (default: 10)
    max_recent: usize,
}

impl SlashCommandMatcher {
    /// Create a new matcher
    pub fn new(registry: Arc<CommandRegistry>) -> Self {
        Self {
            registry,
            favorites: Vec::new(),
            recent: Vec::new(),
            max_recent: 10,
        }
    }

    /// Add a command to favorites
    pub fn add_favorite(&mut self, name: impl Into<String>) {
        let name = name.into();
        if !self.favorites.contains(&name) {
            self.favorites.push(name);
        }
    }

    /// Remove a command from favorites
    pub fn remove_favorite(&mut self, name: &str) {
        self.favorites.retain(|n| n != name);
    }

    /// Record a command as recently used
    pub fn record_usage(&mut self, name: impl Into<String>) {
        let name = name.into();
        self.recent.retain(|n| n != &name);
        self.recent.insert(0, name);
        if self.recent.len() > self.max_recent {
            self.recent.pop();
        }
    }

    /// Get all commands matching the query, sorted by relevance score
    ///
    /// Performs fuzzy matching against all commands in the registry and returns
    /// a sorted list of matches with their scores.
    ///
    /// # Algorithm
    ///
    /// 1. Normalize query (strip `/`, convert to lowercase)
    /// 2. If query is empty, return all commands sorted by favorites/recent
    /// 3. For each command:
    ///    - Try matching against primary name
    ///    - If no match, try matching against each alias
    ///    - Calculate base score (exact, prefix, or contains)
    ///    - Apply favorite and recent bonuses
    /// 4. Sort by score (descending)
    ///
    /// # Matching Priority
    ///
    /// The algorithm matches against primary names before aliases. If the primary
    /// name matches, aliases are not checked. This prevents duplicate matches.
    ///
    /// # Return Value
    ///
    /// Returns a Vec of `CommandMatch` sorted by score (highest first). Each match
    /// includes the command, score, and information about which name/alias matched.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let matches = matcher.get_matches("/the");
    /// // Returns:
    /// // [
    /// //   CommandMatch { command: "theme", score: 70, ... },     // prefix match
    /// //   CommandMatch { command: "thinking", score: 25, ... },  // contains match
    /// // ]
    /// ```
    #[allow(clippy::needless_borrow)] // Borrows enable &String -> &str coercion
    pub fn get_matches(&self, query: &str) -> Vec<CommandMatch> {
        let query = query.to_lowercase();
        let query = query.trim_start_matches('/');

        if query.is_empty() {
            // Return all commands sorted by favorites/recent
            return self.get_all_sorted();
        }

        let mut matches: Vec<CommandMatch> = Vec::new();

        for cmd in self.registry.all() {
            // Check main name
            if let Some(score) = self.score_match(&query, &cmd.name, false) {
                let mut m = CommandMatch::new(Arc::clone(&cmd), score);
                m = self.apply_bonuses(m, &query);
                matches.push(m);
                continue;
            }

            // Check aliases
            for alias in &cmd.aliases {
                if let Some(score) = self.score_match(&query, alias, true) {
                    let mut m =
                        CommandMatch::new(Arc::clone(&cmd), score).with_alias(alias.clone());
                    m = self.apply_bonuses(m, &query);
                    matches.push(m);
                    break;
                }
            }
        }

        // Sort by score descending
        matches.sort_by(|a, b| b.score.cmp(&a.score));
        matches
    }

    /// Score a match between query and target
    fn score_match(&self, query: &str, target: &str, is_alias: bool) -> Option<i32> {
        let target_lower = target.to_lowercase();

        if target_lower == query {
            return Some(scores::EXACT_MATCH);
        }

        if target_lower.starts_with(query) {
            return Some(if is_alias {
                scores::PREFIX_MATCH_ALIAS
            } else {
                scores::PREFIX_MATCH_NAME
            });
        }

        if target_lower.contains(query) {
            return Some(if is_alias {
                scores::CONTAINS_MATCH_ALIAS
            } else {
                scores::CONTAINS_MATCH_NAME
            });
        }

        None
    }

    /// Apply favorite and recent bonuses
    fn apply_bonuses(&self, mut m: CommandMatch, query: &str) -> CommandMatch {
        let has_query = !query.is_empty();

        if self.favorites.contains(&m.command.name) {
            m.score += if has_query {
                scores::FAVORITE_BONUS_WITH_QUERY
            } else {
                scores::FAVORITE_BONUS_NO_QUERY
            };
        }

        if self.recent.contains(&m.command.name) {
            m.score += if has_query {
                scores::RECENT_BONUS_WITH_QUERY
            } else {
                scores::RECENT_BONUS_NO_QUERY
            };
        }

        m
    }

    /// Get all commands sorted by favorites and recent usage
    fn get_all_sorted(&self) -> Vec<CommandMatch> {
        let mut matches: Vec<CommandMatch> = self
            .registry
            .all()
            .into_iter()
            .map(|cmd| {
                let mut m = CommandMatch::new(cmd, 0);
                m = self.apply_bonuses(m, "");
                m
            })
            .collect();

        matches.sort_by(|a, b| {
            // Sort by score first, then alphabetically
            match b.score.cmp(&a.score) {
                std::cmp::Ordering::Equal => a.command.name.cmp(&b.command.name),
                other => other,
            }
        });

        matches
    }

    /// Get completions for tab cycling
    pub fn get_completions(&self, query: &str) -> Vec<String> {
        self.get_matches(query)
            .into_iter()
            .map(|m| format!("/{}", m.matched_name))
            .collect()
    }

    /// Get the best match for a query
    pub fn best_match(&self, query: &str) -> Option<CommandMatch> {
        self.get_matches(query).into_iter().next()
    }
}

/// State for tab-cycling through command completions
///
/// Manages the state needed for cycling through command suggestions when the user
/// presses Tab or Shift+Tab. This struct caches matches to avoid recomputing them
/// on every keypress.
///
/// # State Lifecycle
///
/// 1. **Uninitialized**: `query` is None, no completions cached
/// 2. **Set Query**: User types, completions are fetched and cached
/// 3. **Cycling**: User presses Tab, index increments (wraps at end)
/// 4. **Query Change**: Detected by comparing to cached query, triggers refresh
/// 5. **Reset**: Explicitly called or query changes, clears all state
///
/// # Caching Strategy
///
/// The completions Vec is cached to avoid calling `matcher.get_completions()` on
/// every Tab press. The cache is invalidated when:
/// - The query string changes (detected in `set_query()`)
/// - `reset()` is called explicitly
///
/// # Example Usage
///
/// ```rust,ignore
/// use composer_tui::commands::{build_command_registry, SlashCommandMatcher, SlashCycleState};
/// use std::sync::Arc;
///
/// let registry = Arc::new(build_command_registry());
/// let matcher = SlashCommandMatcher::new(registry);
/// let mut cycle = SlashCycleState::new();
///
/// // User types "/h"
/// cycle.set_query("/h", &matcher);
/// assert_eq!(cycle.current(), Some("/help"));  // First match
///
/// // User presses Tab
/// cycle.cycle_next();
/// // Now on second match (if any)
///
/// // User presses Shift+Tab
/// cycle.cycle_prev();
/// // Back to first match
///
/// // User changes query to "/he"
/// cycle.set_query("/he", &matcher);
/// assert_eq!(cycle.current_index(), 0);  // Reset to start
/// ```
pub struct SlashCycleState {
    /// Current query string (None means uninitialized/reset)
    query: Option<String>,
    /// Current index in the completions list
    index: usize,
    /// Cached completions from matcher (invalidated when query changes)
    completions: Vec<String>,
}

impl SlashCycleState {
    /// Create a new cycle state
    pub fn new() -> Self {
        Self {
            query: None,
            index: 0,
            completions: Vec::new(),
        }
    }

    /// Update the query and reset cycle if changed
    pub fn set_query(&mut self, query: &str, matcher: &SlashCommandMatcher) {
        let should_update = match &self.query {
            None => true,
            Some(q) => q != query,
        };

        if should_update {
            self.query = Some(query.to_string());
            self.completions = matcher.get_completions(query);
            self.index = 0;
        }
    }

    /// Cycle to the next completion
    pub fn cycle_next(&mut self) -> Option<&str> {
        if self.completions.is_empty() {
            return None;
        }
        self.index = (self.index + 1) % self.completions.len();
        Some(&self.completions[self.index])
    }

    /// Cycle to the previous completion
    pub fn cycle_prev(&mut self) -> Option<&str> {
        if self.completions.is_empty() {
            return None;
        }
        if self.index == 0 {
            self.index = self.completions.len() - 1;
        } else {
            self.index -= 1;
        }
        Some(&self.completions[self.index])
    }

    /// Get the current completion
    pub fn current(&self) -> Option<&str> {
        self.completions.get(self.index).map(|s| s.as_str())
    }

    /// Reset the cycle state
    pub fn reset(&mut self) {
        self.query = None;
        self.index = 0;
        self.completions.clear();
    }

    /// Check if there are completions available
    pub fn has_completions(&self) -> bool {
        !self.completions.is_empty()
    }

    /// Get all completions
    pub fn completions(&self) -> &[String] {
        &self.completions
    }

    /// Get the current index
    pub fn current_index(&self) -> usize {
        self.index
    }
}

impl Default for SlashCycleState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::build_command_registry;

    fn create_matcher() -> SlashCommandMatcher {
        let registry = Arc::new(build_command_registry());
        SlashCommandMatcher::new(registry)
    }

    #[test]
    fn exact_match_scores_highest() {
        let matcher = create_matcher();
        let matches = matcher.get_matches("help");

        assert!(!matches.is_empty());
        assert_eq!(matches[0].command.name, "help");
        assert_eq!(matches[0].score, scores::EXACT_MATCH);
    }

    #[test]
    fn prefix_match_works() {
        let matcher = create_matcher();
        let matches = matcher.get_matches("the");

        assert!(!matches.is_empty());
        assert!(matches.iter().any(|m| m.command.name == "theme"));
    }

    #[test]
    fn alias_match_works() {
        let matcher = create_matcher();
        let matches = matcher.get_matches("h");

        // "h" is an alias for "help"
        assert!(!matches.is_empty());
        let help_match = matches.iter().find(|m| m.command.name == "help");
        assert!(help_match.is_some());
    }

    #[test]
    fn favorites_get_bonus() {
        let mut matcher = create_matcher();
        matcher.add_favorite("theme");

        let matches = matcher.get_matches("");
        let theme_match = matches.iter().find(|m| m.command.name == "theme").unwrap();

        assert!(theme_match.score > 0);
    }

    #[test]
    fn cycle_state_cycles() {
        let matcher = create_matcher();
        let mut cycle = SlashCycleState::new();

        cycle.set_query("", &matcher);
        assert!(cycle.has_completions());

        let first = cycle.current().unwrap().to_string();
        cycle.cycle_next();
        let second = cycle.current().unwrap().to_string();

        assert_ne!(first, second);
    }

    #[test]
    fn completions_include_slash() {
        let matcher = create_matcher();
        let completions = matcher.get_completions("help");

        assert!(!completions.is_empty());
        assert!(completions[0].starts_with('/'));
    }
}

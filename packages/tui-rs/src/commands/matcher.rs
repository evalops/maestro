//! Command matching and completion
//!
//! Provides fuzzy matching and scoring for slash commands,
//! along with tab completion cycling.

use std::sync::Arc;

use super::registry::CommandRegistry;
use super::types::Command;

/// A matched command with its score
#[derive(Debug, Clone)]
pub struct CommandMatch {
    /// The matched command
    pub command: Arc<Command>,
    /// Match score (higher is better)
    pub score: i32,
    /// Whether matched by alias
    pub matched_alias: Option<String>,
    /// The matched portion of the name
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

/// Scoring constants
mod scores {
    pub const EXACT_MATCH: i32 = 100;
    pub const PREFIX_MATCH_NAME: i32 = 70;
    pub const PREFIX_MATCH_ALIAS: i32 = 55;
    pub const CONTAINS_MATCH_NAME: i32 = 25;
    pub const CONTAINS_MATCH_ALIAS: i32 = 15;
    pub const FAVORITE_BONUS_WITH_QUERY: i32 = 12;
    pub const FAVORITE_BONUS_NO_QUERY: i32 = 8;
    pub const RECENT_BONUS_WITH_QUERY: i32 = 8;
    pub const RECENT_BONUS_NO_QUERY: i32 = 5;
}

/// Slash command matcher with fuzzy matching and tab completion
pub struct SlashCommandMatcher {
    /// Reference to command registry
    registry: Arc<CommandRegistry>,
    /// Favorite commands (get bonus in scoring)
    favorites: Vec<String>,
    /// Recently used commands
    recent: Vec<String>,
    /// Maximum recent commands to track
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

    /// Get matches for a query
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
pub struct SlashCycleState {
    /// Current query (None means uninitialized)
    query: Option<String>,
    /// Current cycle index
    index: usize,
    /// Cached completions
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

//! Undo/Redo History with Debounced Snapshots
//!
//! Provides a generic undo/redo system for editor state with:
//! - Debounced snapshots (group rapid edits into single undo unit)
//! - Configurable history limit
//! - Clear separation of undo/redo stacks
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/// Default maximum history entries.
pub const DEFAULT_MAX_HISTORY: usize = 100;

/// Default debounce duration for grouping rapid edits.
pub const DEFAULT_DEBOUNCE_MS: u64 = 300;

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY ENTRY
// ─────────────────────────────────────────────────────────────────────────────

/// A timestamped snapshot in the undo history.
#[derive(Debug, Clone)]
pub struct HistoryEntry<T> {
    /// The saved state.
    pub state: T,
    /// When this snapshot was taken.
    pub timestamp: Instant,
}

impl<T> HistoryEntry<T> {
    /// Create a new history entry with the current timestamp.
    pub fn new(state: T) -> Self {
        Self {
            state,
            timestamp: Instant::now(),
        }
    }

    /// Create a history entry with a specific timestamp.
    pub fn with_timestamp(state: T, timestamp: Instant) -> Self {
        Self { state, timestamp }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UNDO HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/// Generic undo/redo history manager.
///
/// Type parameter `T` is the state type (must be Clone).
///
/// # Example
///
/// ```rust
/// use maestro_tui::undo_history::UndoHistory;
///
/// let mut history: UndoHistory<String> = UndoHistory::new();
///
/// // Save initial state
/// history.save("hello".to_string());
///
/// // Make changes
/// history.save("hello world".to_string());
///
/// // Undo
/// if let Some(prev) = history.undo("hello world".to_string()) {
///     assert_eq!(prev, "hello");
/// }
///
/// // Redo
/// if let Some(next) = history.redo("hello".to_string()) {
///     assert_eq!(next, "hello world");
/// }
/// ```
#[derive(Debug, Clone)]
pub struct UndoHistory<T> {
    /// Stack of past states (for undo).
    undo_stack: Vec<HistoryEntry<T>>,
    /// Stack of future states (for redo).
    redo_stack: Vec<HistoryEntry<T>>,
    /// Maximum number of undo entries.
    max_history: usize,
    /// Debounce duration for grouping rapid saves.
    debounce: Duration,
    /// Last save timestamp for debouncing.
    last_save: Option<Instant>,
}

impl<T: Clone> Default for UndoHistory<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone> UndoHistory<T> {
    /// Create a new undo history with default settings.
    #[must_use]
    pub fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_history: DEFAULT_MAX_HISTORY,
            debounce: Duration::from_millis(DEFAULT_DEBOUNCE_MS),
            last_save: None,
        }
    }

    /// Create with custom max history size.
    #[must_use]
    pub fn with_max_history(mut self, max: usize) -> Self {
        self.max_history = max;
        self
    }

    /// Create with custom debounce duration.
    #[must_use]
    pub fn with_debounce(mut self, debounce: Duration) -> Self {
        self.debounce = debounce;
        self
    }

    /// Save a state to the undo history.
    ///
    /// Uses debouncing: if called within the debounce window of the last save,
    /// the save is skipped to group rapid edits together.
    ///
    /// Clears the redo stack when a new edit is made.
    pub fn save(&mut self, state: T) {
        let now = Instant::now();

        // Check debounce
        if let Some(last) = self.last_save {
            if now.duration_since(last) < self.debounce {
                return; // Skip - too soon after last save
            }
        }

        self.undo_stack.push(HistoryEntry::new(state));

        // Trim if over limit
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }

        // Clear redo stack on new edit
        self.redo_stack.clear();

        self.last_save = Some(now);
    }

    /// Force save without debouncing.
    ///
    /// Use this for significant state changes that should always be recorded.
    pub fn force_save(&mut self, state: T) {
        self.undo_stack.push(HistoryEntry::new(state));

        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }

        self.redo_stack.clear();
        self.last_save = Some(Instant::now());
    }

    /// Undo: restore the previous state.
    ///
    /// Takes the current state and pushes it to redo stack.
    /// Returns the previous state, or None if no history.
    pub fn undo(&mut self, current: T) -> Option<T> {
        let entry = self.undo_stack.pop()?;

        // Push current state to redo stack
        self.redo_stack.push(HistoryEntry::new(current));

        Some(entry.state)
    }

    /// Redo: restore the next state.
    ///
    /// Takes the current state and pushes it to undo stack.
    /// Returns the next state, or None if no redo history.
    pub fn redo(&mut self, current: T) -> Option<T> {
        let entry = self.redo_stack.pop()?;

        // Push current state to undo stack (bypass debounce)
        self.undo_stack.push(HistoryEntry::new(current));

        Some(entry.state)
    }

    /// Check if undo is available.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Check if redo is available.
    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Get the number of undo entries.
    #[must_use]
    pub fn undo_count(&self) -> usize {
        self.undo_stack.len()
    }

    /// Get the number of redo entries.
    #[must_use]
    pub fn redo_count(&self) -> usize {
        self.redo_stack.len()
    }

    /// Clear all history.
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.last_save = None;
    }

    /// Peek at the last undo entry without removing it.
    #[must_use]
    pub fn peek_undo(&self) -> Option<&T> {
        self.undo_stack.last().map(|e| &e.state)
    }

    /// Peek at the last redo entry without removing it.
    #[must_use]
    pub fn peek_redo(&self) -> Option<&T> {
        self.redo_stack.last().map(|e| &e.state)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EDITOR STATE
// ─────────────────────────────────────────────────────────────────────────────

/// A complete editor state snapshot.
///
/// This captures everything needed to restore editor state for undo/redo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorState {
    /// Lines of text.
    pub lines: Vec<String>,
    /// Current cursor line (0-indexed).
    pub cursor_line: usize,
    /// Current cursor column (0-indexed byte offset).
    pub cursor_col: usize,
}

impl EditorState {
    /// Create a new editor state.
    #[must_use]
    pub fn new(lines: Vec<String>, cursor_line: usize, cursor_col: usize) -> Self {
        Self {
            lines,
            cursor_line,
            cursor_col,
        }
    }

    /// Create from a single string (splits on newlines).
    pub fn from_text(text: &str, cursor_line: usize, cursor_col: usize) -> Self {
        Self {
            lines: text.lines().map(String::from).collect(),
            cursor_line,
            cursor_col,
        }
    }

    /// Convert to a single string.
    #[must_use]
    pub fn to_text(&self) -> String {
        self.lines.join("\n")
    }

    /// Check if state is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty() || (self.lines.len() == 1 && self.lines[0].is_empty())
    }
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            lines: vec![String::new()],
            cursor_line: 0,
            cursor_col: 0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EDITOR HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/// Convenience type alias for editor undo history.
pub type EditorHistory = UndoHistory<EditorState>;

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn new_history_is_empty() {
        let history: UndoHistory<String> = UndoHistory::new();
        assert!(!history.can_undo());
        assert!(!history.can_redo());
    }

    #[test]
    fn save_and_undo() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(0)); // Disable debounce for test

        history.save("state1".to_string());
        history.save("state2".to_string());

        assert!(history.can_undo());
        assert_eq!(history.undo_count(), 2);

        let prev = history.undo("state3".to_string());
        assert_eq!(prev, Some("state2".to_string()));
        assert!(history.can_redo());
    }

    #[test]
    fn redo_works() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(0));

        history.save("state1".to_string());
        history.undo("state2".to_string());

        let next = history.redo("state1".to_string());
        assert_eq!(next, Some("state2".to_string()));
    }

    #[test]
    fn new_edit_clears_redo() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(0));

        history.save("state1".to_string());
        history.undo("state2".to_string());
        assert!(history.can_redo());

        // New edit should clear redo
        history.save("state3".to_string());
        assert!(!history.can_redo());
    }

    #[test]
    fn debounce_groups_rapid_saves() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(100));

        history.save("state1".to_string());
        history.save("state2".to_string()); // Should be skipped
        history.save("state3".to_string()); // Should be skipped

        assert_eq!(history.undo_count(), 1);
    }

    #[test]
    fn debounce_allows_after_delay() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(10));

        history.save("state1".to_string());
        thread::sleep(Duration::from_millis(20));
        history.save("state2".to_string()); // Should succeed

        assert_eq!(history.undo_count(), 2);
    }

    #[test]
    fn force_save_bypasses_debounce() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_secs(1));

        history.save("state1".to_string());
        history.force_save("state2".to_string()); // Should succeed despite debounce

        assert_eq!(history.undo_count(), 2);
    }

    #[test]
    fn max_history_trims_old() {
        let mut history: UndoHistory<i32> = UndoHistory::new()
            .with_max_history(3)
            .with_debounce(Duration::from_millis(0));

        history.save(1);
        history.save(2);
        history.save(3);
        history.save(4); // Should trim oldest (1)

        assert_eq!(history.undo_count(), 3);
        assert_eq!(history.peek_undo(), Some(&4));
    }

    #[test]
    fn clear_removes_all() {
        let mut history: UndoHistory<String> =
            UndoHistory::new().with_debounce(Duration::from_millis(0));

        history.save("state1".to_string());
        history.undo("state2".to_string());

        history.clear();

        assert!(!history.can_undo());
        assert!(!history.can_redo());
    }

    #[test]
    fn editor_state_from_text() {
        let state = EditorState::from_text("line1\nline2\nline3", 1, 5);
        assert_eq!(state.lines.len(), 3);
        assert_eq!(state.lines[0], "line1");
        assert_eq!(state.cursor_line, 1);
        assert_eq!(state.cursor_col, 5);
    }

    #[test]
    fn editor_state_to_text() {
        let state = EditorState::new(vec!["line1".to_string(), "line2".to_string()], 0, 0);
        assert_eq!(state.to_text(), "line1\nline2");
    }

    #[test]
    fn editor_history_full_flow() {
        let mut history: EditorHistory = UndoHistory::new().with_debounce(Duration::from_millis(0));

        // Initial state
        let initial = EditorState::from_text("hello", 0, 5);
        history.force_save(initial.clone());

        // After typing
        let after_edit = EditorState::from_text("hello world", 0, 11);
        history.force_save(after_edit.clone());

        // Undo should restore initial
        let current = EditorState::from_text("hello world!", 0, 12);
        let restored = history.undo(current);
        assert_eq!(
            restored.map(|s| s.to_text()),
            Some("hello world".to_string())
        );
    }
}

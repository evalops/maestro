//! Notes appended to a tool result when the turn's own history says something.
//!
//! Some facts about a turn are visible to the runner and invisible to the
//! model: that `edit` has now failed three times in a row, that the todo list
//! it wrote is still open. Telling the model means putting text in front of
//! it, and there is exactly one safe place to put that text.
//!
//! It cannot be a new message. A provider request pairs every `tool_use`
//! block with a `tool_result` block; inserting a message between them makes
//! the request invalid on the OpenAI-compatible path and desynchronises the
//! Anthropic one. So a reminder is appended to the content of the **last**
//! `tool_result` of the batch, wrapped in [`REMINDER_OPEN`] /
//! [`REMINDER_CLOSE`] so the model can tell it apart from tool output.
//!
//! Reminder envelopes keep injected context separate from tool output.

use std::collections::{HashMap, HashSet};
use std::fmt;

/// Opening delimiter for appended reminders.
pub const REMINDER_OPEN: &str = "<tool_outcome_reminder>";
/// Closing delimiter for appended reminders.
pub const REMINDER_CLOSE: &str = "</tool_outcome_reminder>";

/// Consecutive failures of one tool before the failure reminder fires.
pub const CONSECUTIVE_FAILURE_THRESHOLD: usize = 3;

/// One tool result the runner observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    /// The tool that produced it.
    pub tool: String,
    /// Whether the result was reported to the model as an error.
    pub success: bool,
    /// Open todo items this result reported, when it came from `todo`.
    pub open_todos: Option<usize>,
}

/// What the reminders get to look at.
#[derive(Debug, Default, Clone)]
pub struct ReminderContext {
    /// Tool results seen so far in this turn.
    pub tool_calls: usize,
    /// Tool results seen so far in this turn, per tool.
    pub per_tool: HashMap<String, usize>,
    /// Failing results since that tool last succeeded, per tool.
    pub consecutive_failures: HashMap<String, usize>,
    /// Todo items not completed, as of the last `todo` result this turn.
    pub open_todos: usize,
    /// Tools in the batch that just finished.
    pub batch_tools: Vec<String>,
}

impl ReminderContext {
    /// Fold one tool result into the turn's counters.
    pub fn record(&mut self, outcome: &ToolOutcome) {
        self.tool_calls = self.tool_calls.saturating_add(1);
        *self.per_tool.entry(outcome.tool.clone()).or_insert(0) += 1;
        let failures = self
            .consecutive_failures
            .entry(outcome.tool.clone())
            .or_insert(0);
        if outcome.success {
            *failures = 0;
        } else {
            *failures = failures.saturating_add(1);
        }
        if let Some(open) = outcome.open_todos {
            self.open_todos = open;
        }
        self.batch_tools.push(outcome.tool.clone());
    }

    /// The tool with the most consecutive failures, when any has some.
    #[must_use]
    pub fn worst_consecutive_failure(&self) -> Option<(&str, usize)> {
        self.consecutive_failures
            .iter()
            .filter(|(_, count)| **count > 0)
            .max_by_key(|(tool, count)| (**count, (*tool).clone()))
            .map(|(tool, count)| (tool.as_str(), *count))
    }

    /// Whether the batch that just ran used this tool.
    #[must_use]
    pub fn batch_used(&self, tool: &str) -> bool {
        self.batch_tools.iter().any(|name| name == tool)
    }
}

/// One rule that may have something to say after a tool batch.
pub trait Reminder: Send + Sync {
    /// Stable name, used to emit a reminder at most once per turn.
    fn name(&self) -> &'static str;

    /// The text to append, or `None` when this rule has nothing to say.
    fn trigger(&self, context: &ReminderContext) -> Option<String>;
}

/// Fires when one tool has failed [`CONSECUTIVE_FAILURE_THRESHOLD`] times in
/// a row without a success in between.
#[derive(Debug, Default, Clone, Copy)]
pub struct ConsecutiveFailureReminder;

impl Reminder for ConsecutiveFailureReminder {
    fn name(&self) -> &'static str {
        "consecutive_tool_failures"
    }

    fn trigger(&self, context: &ReminderContext) -> Option<String> {
        let (tool, failures) = context.worst_consecutive_failure()?;
        if failures < CONSECUTIVE_FAILURE_THRESHOLD {
            return None;
        }
        Some(format!(
            "`{tool}` has failed {failures} times in a row. Read the error text before calling \
             it again. Change the arguments, use a different tool, or tell the user what is \
             blocking you. Do not repeat the same call."
        ))
    }
}

/// Fires when the todo list the model wrote still has open items and the
/// batch that just ran did not touch `todo`.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnfinishedTodoReminder;

impl Reminder for UnfinishedTodoReminder {
    fn name(&self) -> &'static str {
        "unfinished_todos"
    }

    fn trigger(&self, context: &ReminderContext) -> Option<String> {
        if context.open_todos == 0 || context.batch_used("todo") {
            return None;
        }
        let open = context.open_todos;
        Some(format!(
            "{open} todo item(s) are still open. Keep the list current with the `todo` tool as \
             you finish work, and before you end the turn state which items remain."
        ))
    }
}

/// Owns the turn's reminder context and the rules that read it.
pub struct ReminderEngine {
    context: ReminderContext,
    reminders: Vec<Box<dyn Reminder>>,
    emitted_this_turn: HashSet<&'static str>,
}

impl fmt::Debug for ReminderEngine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReminderEngine")
            .field("context", &self.context)
            .field(
                "reminders",
                &self
                    .reminders
                    .iter()
                    .map(|reminder| reminder.name())
                    .collect::<Vec<_>>(),
            )
            .field("emitted_this_turn", &self.emitted_this_turn)
            .finish()
    }
}

impl Default for ReminderEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ReminderEngine {
    /// Create an engine with the shipped rules.
    #[must_use]
    pub fn new() -> Self {
        Self::with_reminders(vec![
            Box::new(ConsecutiveFailureReminder),
            Box::new(UnfinishedTodoReminder),
        ])
    }

    /// Create an engine with a specific rule set.
    #[must_use]
    pub fn with_reminders(reminders: Vec<Box<dyn Reminder>>) -> Self {
        Self {
            context: ReminderContext::default(),
            reminders,
            emitted_this_turn: HashSet::new(),
        }
    }

    /// Read-only view of the accumulated context.
    #[must_use]
    pub fn context(&self) -> &ReminderContext {
        &self.context
    }

    /// Forget everything. A new user message starts a new turn.
    pub fn reset_turn(&mut self) {
        self.context = ReminderContext::default();
        self.emitted_this_turn.clear();
    }

    /// Fold one batch of tool results in and render whatever fires.
    ///
    /// A rule speaks at most once per turn: repeating the same sentence after
    /// every batch trains the model to skip it.
    pub fn observe_batch(&mut self, outcomes: &[ToolOutcome]) -> Option<String> {
        self.context.batch_tools.clear();
        for outcome in outcomes {
            self.context.record(outcome);
        }
        let mut triggered: Vec<String> = Vec::new();
        for reminder in &self.reminders {
            if self.emitted_this_turn.contains(reminder.name()) {
                continue;
            }
            if let Some(text) = reminder.trigger(&self.context) {
                self.emitted_this_turn.insert(reminder.name());
                triggered.push(text);
            }
        }
        if triggered.is_empty() {
            return None;
        }
        Some(format!(
            "{REMINDER_OPEN}\n{}\n{REMINDER_CLOSE}",
            triggered.join("\n\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{REMINDER_CLOSE, REMINDER_OPEN, ReminderEngine, ToolOutcome};

    fn outcome(tool: &str, success: bool) -> ToolOutcome {
        ToolOutcome {
            tool: tool.to_string(),
            success,
            open_todos: None,
        }
    }

    #[test]
    fn three_consecutive_failures_of_one_tool_fire_the_reminder() {
        let mut engine = ReminderEngine::new();
        assert_eq!(engine.observe_batch(&[outcome("edit", false)]), None);
        assert_eq!(engine.observe_batch(&[outcome("edit", false)]), None);
        let reminder = engine
            .observe_batch(&[outcome("edit", false)])
            .expect("the third consecutive failure must fire");
        assert!(reminder.starts_with(REMINDER_OPEN), "{reminder}");
        assert!(reminder.ends_with(REMINDER_CLOSE), "{reminder}");
        assert!(reminder.contains("`edit` has failed 3 times"), "{reminder}");
    }

    #[test]
    fn two_failures_do_not_fire_and_a_success_resets_the_run() {
        let mut engine = ReminderEngine::new();
        engine.observe_batch(&[outcome("edit", false)]);
        engine.observe_batch(&[outcome("edit", false)]);
        assert_eq!(engine.observe_batch(&[outcome("edit", true)]), None);
        assert_eq!(engine.context().consecutive_failures["edit"], 0);
        assert_eq!(engine.observe_batch(&[outcome("edit", false)]), None);
        assert_eq!(engine.observe_batch(&[outcome("edit", false)]), None);
    }

    #[test]
    fn failures_of_different_tools_do_not_add_up() {
        let mut engine = ReminderEngine::new();
        assert_eq!(engine.observe_batch(&[outcome("edit", false)]), None);
        assert_eq!(engine.observe_batch(&[outcome("bash", false)]), None);
        assert_eq!(engine.observe_batch(&[outcome("read", false)]), None);
    }

    #[test]
    fn a_reminder_is_emitted_once_per_turn_then_again_after_a_reset() {
        let mut engine = ReminderEngine::new();
        for _ in 0..3 {
            engine.observe_batch(&[outcome("edit", false)]);
        }
        assert_eq!(
            engine.observe_batch(&[outcome("edit", false)]),
            None,
            "the same rule must not repeat inside one turn"
        );
        engine.reset_turn();
        for _ in 0..2 {
            engine.observe_batch(&[outcome("edit", false)]);
        }
        assert!(
            engine
                .observe_batch(&[outcome("edit", false)])
                .is_some_and(|text| text.contains("`edit` has failed 3 times")),
            "a new turn starts the counters over"
        );
    }

    #[test]
    fn open_todos_fire_only_on_a_batch_that_did_not_touch_todo() {
        let mut engine = ReminderEngine::new();
        assert_eq!(
            engine.observe_batch(&[ToolOutcome {
                tool: "todo".to_string(),
                success: true,
                open_todos: Some(2),
            }]),
            None,
            "the batch that wrote the list must not be nagged about it"
        );
        let reminder = engine
            .observe_batch(&[outcome("read", true)])
            .expect("open todos must fire on the next batch");
        assert!(
            reminder.contains("2 todo item(s) are still open"),
            "{reminder}"
        );
    }

    #[test]
    fn a_finished_todo_list_says_nothing() {
        let mut engine = ReminderEngine::new();
        engine.observe_batch(&[ToolOutcome {
            tool: "todo".to_string(),
            success: true,
            open_todos: Some(0),
        }]);
        assert_eq!(engine.observe_batch(&[outcome("read", true)]), None);
    }

    #[test]
    fn both_reminders_share_one_delimited_block() {
        let mut engine = ReminderEngine::new();
        for _ in 0..2 {
            engine.observe_batch(&[outcome("edit", false)]);
        }
        engine.observe_batch(&[ToolOutcome {
            tool: "todo".to_string(),
            success: true,
            open_todos: Some(1),
        }]);
        let reminder = engine
            .observe_batch(&[outcome("edit", false)])
            .expect("both rules fire on this batch");
        assert_eq!(reminder.matches(REMINDER_OPEN).count(), 1, "{reminder}");
        assert!(reminder.contains("`edit` has failed 3 times"), "{reminder}");
        assert!(
            reminder.contains("todo item(s) are still open"),
            "{reminder}"
        );
    }
}

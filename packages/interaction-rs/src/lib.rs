//! Deterministic interaction primitives. The host owns all effects.
//!
//! There is no terminal, filesystem, global clock, task executor, or permission
//! system here. Hosts supply observed states and monotonic timestamps, then
//! explicitly handle returned effects. See `examples/task_monitor.rs`.

use std::time::Duration;

mod catalog;
pub use catalog::{ActionCatalog, CatalogError, Shortcut};

/// Dismissal and one-shot acceptance of a caller-provided draft suggestion.
/// The host still checks editor/modal eligibility and explicitly fills its draft.
#[derive(Debug, Default, Clone, Copy)]
pub struct Suggestion {
    dismissed: bool,
}

impl Suggestion {
    /// Allow suggestions at the beginning of the next interaction.
    pub fn reset(&mut self) {
        self.dismissed = false;
    }
    /// Hide suggestions after typing, paste, cancel, or acceptance.
    pub fn dismiss(&mut self) {
        self.dismissed = true;
    }
    /// Return the candidate only while suggestions are visible.
    pub fn visible<T>(self, candidate: Option<T>) -> Option<T> {
        if self.dismissed { None } else { candidate }
    }
    /// Consume an offered value once. This never submits or executes the value.
    pub fn take<T>(&mut self, candidate: Option<T>) -> Option<T> {
        let value = self.visible(candidate)?;
        self.dismiss();
        Some(value)
    }
}

/// One declaration shared by menus, commands, help, and the host's dispatcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Action<T> {
    /// Stable command/fixture identifier; independent of row order and wording.
    pub id: &'static str,
    /// User-facing description.
    pub label: &'static str,
    /// Typed intent. Selecting this value does not execute it.
    pub value: T,
    /// Longer help text, separate from the compact menu label.
    pub description: &'static str,
    /// Optional terminal binding; the host remains responsible for dispatch.
    pub shortcut: Option<Shortcut>,
}

impl<T> Action<T> {
    /// Declare an action without installing a handler or granting authority.
    pub const fn new(id: &'static str, label: &'static str, value: T) -> Self {
        Self {
            id,
            label,
            value,
            description: label,
            shortcut: None,
        }
    }
    /// Set the help text shared by command and menu documentation.
    pub const fn description(mut self, description: &'static str) -> Self {
        self.description = description;
        self
    }
    /// Attach a typed binding without installing an event handler.
    pub const fn shortcut(mut self, shortcut: Shortcut) -> Self {
        self.shortcut = Some(shortcut);
        self
    }
}

/// Clamped navigation for caller-owned lists, including filtered and empty lists.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Selection(usize);

impl Selection {
    /// Return the selected row only if it still exists.
    pub fn index(self, len: usize) -> Option<usize> {
        (self.0 < len).then_some(self.0)
    }
    /// Return the caller's selected item, never an unchecked numeric action.
    pub fn get<T>(self, items: &[T]) -> Option<&T> {
        items.get(self.0)
    }
    /// Reset to the first row after opening a new list.
    pub fn reset(&mut self) {
        self.0 = 0;
    }
    /// Reset when filtering removes the selected row.
    pub fn reconcile(&mut self, len: usize) {
        if self.0 >= len {
            self.reset();
        }
    }
    /// Move up, clamped at the first row.
    pub fn up(&mut self, len: usize) {
        self.reconcile(len);
        self.0 = self.0.saturating_sub(1);
    }
    /// Move down, clamped at the last row (or no selection for an empty list).
    pub fn down(&mut self, len: usize) {
        self.reconcile(len);
        self.0 = self.0.saturating_add(1).min(len.saturating_sub(1));
    }
}

/// Presentation preferences, supplied on each event so opt-outs apply immediately.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    /// Whether the host permits background notifications.
    pub notifications: bool,
    /// Whether focus return may request a recap.
    pub recaps: bool,
    /// Minimum absence before a changed state warrants a recap.
    pub recap_after: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            notifications: false,
            recaps: true,
            recap_after: Duration::from_secs(180),
        }
    }
}

/// Events translated from the application's authoritative lifecycle.
#[derive(Debug, Clone, Copy)]
pub enum Event<S> {
    /// Start a new interaction, including one that finishes between frames.
    Started(S),
    /// Observe a state; `attention` means completion, failure, or required input.
    Observed { state: S, attention: bool },
    /// The host lost focus.
    FocusLost,
    /// Observe the latest state and return to the host without a desktop alert.
    FocusGained { state: S, attention: bool },
    /// Discard all transient state when switching sessions.
    Reset,
}

/// Requests only: the host decides how to display a recap or deliver an alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Effects<S> {
    /// An observed change while away, when notifications are enabled.
    pub notification: Option<S>,
    /// A focus-return recap of the latest observed state.
    pub recap: Option<S>,
}

impl<S> Default for Effects<S> {
    fn default() -> Self {
        Self {
            notification: None,
            recap: None,
        }
    }
}

/// Focus and attention state independent of rendering, delivery, and domain types.
#[derive(Debug, Clone)]
pub struct Attention<S> {
    last: Option<S>,
    away_since: Option<Duration>,
    away_changed: bool,
}

impl<S> Default for Attention<S> {
    fn default() -> Self {
        Self {
            last: None,
            away_since: None,
            away_changed: false,
        }
    }
}

impl<S: Copy + Eq> Attention<S> {
    /// Latest state supplied by the host, if one has been observed.
    pub fn last_observed(&self) -> Option<S> {
        self.last
    }
    /// Whether an attention-worthy transition occurred during the current absence.
    pub fn changed_while_away(&self) -> bool {
        self.away_changed
    }

    /// Apply one event at a caller-supplied monotonic time. Never performs I/O.
    pub fn update(&mut self, event: Event<S>, now: Duration, policy: Policy) -> Effects<S> {
        let mut effects = Effects::default();
        match event {
            Event::Reset => *self = Self::default(),
            Event::Started(state) => self.last = Some(state),
            Event::FocusLost => {
                self.away_since.get_or_insert(now);
            }
            Event::Observed { state, attention } => {
                if self.observe(state, attention) && policy.notifications {
                    effects.notification = Some(state);
                }
            }
            Event::FocusGained { state, attention } => {
                self.observe(state, attention);
                let elapsed = self
                    .away_since
                    .take()
                    .and_then(|start| now.checked_sub(start));
                if self.away_changed
                    && policy.recaps
                    && elapsed.is_some_and(|elapsed| elapsed >= policy.recap_after)
                {
                    effects.recap = Some(state);
                }
                self.away_changed = false;
            }
        }
        effects
    }

    fn observe(&mut self, state: S, attention: bool) -> bool {
        if self.last == Some(state) {
            return false;
        }
        self.last = Some(state);
        let changed = attention && self.away_since.is_some();
        self.away_changed |= changed;
        changed
    }
}

/// A bounded reaction using a host clock; reading a frame never starts an effect.
#[derive(Debug, Default, Clone, Copy)]
pub struct Reaction {
    started: Option<Duration>,
}

impl Reaction {
    /// Start or restart a reaction at the supplied time.
    pub fn start(&mut self, now: Duration) {
        self.started = Some(now);
    }
    /// Return no frame before start, after expiry, or for a zero frame interval.
    pub fn frame(self, now: Duration, interval: Duration, lifetime: Duration) -> Option<u64> {
        let elapsed = now.checked_sub(self.started?)?;
        if elapsed >= lifetime || interval.is_zero() {
            return None;
        }
        u64::try_from(elapsed.as_nanos() / interval.as_nanos()).ok()
    }
}

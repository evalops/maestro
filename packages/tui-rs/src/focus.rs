//! Focus Management and Input Routing
//!
//! Provides a system for managing focus and routing keyboard input
//! through a component hierarchy.
//!
//! The focus system supports:
//! - Single focused component at a time
//! - Global interrupt handling (Ctrl+C, Esc) before delegation
//! - Modal/overlay focus that temporarily captures input
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

// ─────────────────────────────────────────────────────────────────────────────
// INPUT RESULT
// ─────────────────────────────────────────────────────────────────────────────

/// Result of handling a key event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputResult {
    /// Input was consumed and handled.
    Consumed,
    /// Input was ignored, should propagate.
    Ignored,
    /// Focus should be released (e.g., on Escape).
    ReleaseFocus,
    /// Request to dismiss the current modal/overlay.
    Dismiss,
    /// Request to submit/confirm the current input.
    Submit,
}

impl InputResult {
    /// Check if input was consumed.
    pub fn is_consumed(&self) -> bool {
        matches!(self, Self::Consumed | Self::Submit)
    }

    /// Check if focus should be released.
    pub fn should_release(&self) -> bool {
        matches!(self, Self::ReleaseFocus | Self::Dismiss)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FOCUSABLE TRAIT
// ─────────────────────────────────────────────────────────────────────────────

/// Trait for components that can receive focus and handle input.
pub trait Focusable {
    /// Handle a key event.
    ///
    /// Returns `InputResult` indicating what happened.
    fn handle_key(&mut self, key: KeyEvent) -> InputResult;

    /// Check if this component is currently complete/done.
    ///
    /// Used by modal stacks to auto-dismiss completed views.
    fn is_complete(&self) -> bool {
        false
    }

    /// Called when this component receives focus.
    fn on_focus(&mut self) {}

    /// Called when this component loses focus.
    fn on_blur(&mut self) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// FOCUS MANAGER
// ─────────────────────────────────────────────────────────────────────────────

/// Manages focus and input routing for a component tree.
///
/// # Focus Hierarchy
///
/// Input is routed in this order:
/// 1. Global interrupt handler (Ctrl+C)
/// 2. Modal stack (if any modals are open)
/// 3. Currently focused component
///
/// # Example
///
/// ```rust,ignore
/// use composer_tui::focus::{FocusManager, Focusable, InputResult};
///
/// struct MyWidget { /* ... */ }
///
/// impl Focusable for MyWidget {
///     fn handle_key(&mut self, key: KeyEvent) -> InputResult {
///         // Handle input...
///         InputResult::Consumed
///     }
/// }
///
/// let mut manager = FocusManager::new();
/// let widget_id = manager.register(Box::new(MyWidget { /* ... */ }));
/// manager.set_focus(widget_id);
///
/// // Later, route input:
/// let result = manager.handle_key(key_event);
/// ```
pub struct FocusManager<T: Focusable> {
    /// Stack of focusable components (last is topmost/focused).
    focus_stack: Vec<T>,
    /// Whether Ctrl+C should trigger interrupt.
    interrupt_enabled: bool,
    /// Callback for interrupt (Ctrl+C).
    interrupt_triggered: bool,
}

impl<T: Focusable> Default for FocusManager<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Focusable> FocusManager<T> {
    /// Create a new focus manager.
    pub fn new() -> Self {
        Self {
            focus_stack: Vec::new(),
            interrupt_enabled: true,
            interrupt_triggered: false,
        }
    }

    /// Push a new focused component onto the stack.
    ///
    /// The new component becomes the focused component.
    pub fn push(&mut self, mut component: T) {
        // Blur previous focus
        if let Some(prev) = self.focus_stack.last_mut() {
            prev.on_blur();
        }

        component.on_focus();
        self.focus_stack.push(component);
    }

    /// Pop the current focused component.
    ///
    /// Returns the popped component. Focus moves to the previous component.
    pub fn pop(&mut self) -> Option<T> {
        let mut popped = self.focus_stack.pop()?;
        popped.on_blur();

        // Focus new top
        if let Some(new_top) = self.focus_stack.last_mut() {
            new_top.on_focus();
        }

        Some(popped)
    }

    /// Get a reference to the currently focused component.
    pub fn focused(&self) -> Option<&T> {
        self.focus_stack.last()
    }

    /// Get a mutable reference to the currently focused component.
    pub fn focused_mut(&mut self) -> Option<&mut T> {
        self.focus_stack.last_mut()
    }

    /// Check if any component is focused.
    pub fn has_focus(&self) -> bool {
        !self.focus_stack.is_empty()
    }

    /// Get the depth of the focus stack.
    pub fn depth(&self) -> usize {
        self.focus_stack.len()
    }

    /// Enable or disable interrupt handling (Ctrl+C).
    pub fn set_interrupt_enabled(&mut self, enabled: bool) {
        self.interrupt_enabled = enabled;
    }

    /// Check if interrupt was triggered since last check.
    ///
    /// Clears the flag after checking.
    pub fn take_interrupt(&mut self) -> bool {
        std::mem::take(&mut self.interrupt_triggered)
    }

    /// Handle a key event, routing to the appropriate component.
    ///
    /// Returns the result of handling.
    pub fn handle_key(&mut self, key: KeyEvent) -> InputResult {
        // Check for global interrupt (Ctrl+C)
        if self.interrupt_enabled && is_interrupt(key) {
            self.interrupt_triggered = true;
            return InputResult::Consumed;
        }

        // Route to focused component
        if let Some(focused) = self.focus_stack.last_mut() {
            let result = focused.handle_key(key);

            // Auto-pop if dismissed or complete
            if result == InputResult::Dismiss
                || (result == InputResult::ReleaseFocus && focused.is_complete())
            {
                self.pop();
            }

            return result;
        }

        InputResult::Ignored
    }

    /// Clear the entire focus stack.
    pub fn clear(&mut self) {
        while self.pop().is_some() {}
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FOCUS RING
// ─────────────────────────────────────────────────────────────────────────────

/// A focus ring for tab-navigation between multiple components.
///
/// Unlike `FocusManager` which uses a stack, `FocusRing` provides
/// circular navigation through a fixed set of focusable items.
#[derive(Debug, Clone)]
pub struct FocusRing {
    /// Total number of focusable items.
    count: usize,
    /// Currently focused index.
    current: usize,
}

impl FocusRing {
    /// Create a new focus ring with the given number of items.
    pub fn new(count: usize) -> Self {
        Self { count, current: 0 }
    }

    /// Get the currently focused index.
    pub fn current(&self) -> usize {
        self.current
    }

    /// Set the focused index (clamped to valid range).
    pub fn set(&mut self, index: usize) {
        if self.count > 0 {
            self.current = index % self.count;
        }
    }

    /// Move focus to the next item (wraps around).
    pub fn next(&mut self) {
        if self.count > 0 {
            self.current = (self.current + 1) % self.count;
        }
    }

    /// Move focus to the previous item (wraps around).
    pub fn prev(&mut self) {
        if self.count > 0 {
            self.current = (self.current + self.count - 1) % self.count;
        }
    }

    /// Check if an index is currently focused.
    pub fn is_focused(&self, index: usize) -> bool {
        self.current == index
    }

    /// Handle Tab/Shift+Tab navigation.
    ///
    /// Returns true if focus changed.
    pub fn handle_tab(&mut self, key: KeyEvent) -> bool {
        if key.code == KeyCode::Tab {
            if key.modifiers.contains(KeyModifiers::SHIFT) {
                self.prev();
            } else {
                self.next();
            }
            return true;
        }
        false
    }

    /// Update the count (e.g., when items change).
    ///
    /// Adjusts current focus if needed.
    pub fn set_count(&mut self, count: usize) {
        self.count = count;
        if count > 0 && self.current >= count {
            self.current = count - 1;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Check if a key event is an interrupt (Ctrl+C).
pub fn is_interrupt(key: KeyEvent) -> bool {
    key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL)
}

/// Check if a key event is Escape.
pub fn is_escape(key: KeyEvent) -> bool {
    key.code == KeyCode::Esc
}

/// Check if a key event is Enter/Return.
pub fn is_enter(key: KeyEvent) -> bool {
    matches!(key.code, KeyCode::Enter)
}

/// Check if a key event is Tab.
pub fn is_tab(key: KeyEvent) -> bool {
    key.code == KeyCode::Tab && !key.modifiers.contains(KeyModifiers::SHIFT)
}

/// Check if a key event is Shift+Tab.
pub fn is_shift_tab(key: KeyEvent) -> bool {
    key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT)
}

/// Check if a key event is a navigation key (arrows, home, end, page up/down).
pub fn is_navigation(key: KeyEvent) -> bool {
    matches!(
        key.code,
        KeyCode::Up
            | KeyCode::Down
            | KeyCode::Left
            | KeyCode::Right
            | KeyCode::Home
            | KeyCode::End
            | KeyCode::PageUp
            | KeyCode::PageDown
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    struct TestWidget {
        name: String,
        complete: bool,
        focused: bool,
    }

    impl TestWidget {
        fn new(name: &str) -> Self {
            Self {
                name: name.to_string(),
                complete: false,
                focused: false,
            }
        }
    }

    impl Focusable for TestWidget {
        fn handle_key(&mut self, key: KeyEvent) -> InputResult {
            if is_escape(key) {
                InputResult::Dismiss
            } else if is_enter(key) {
                self.complete = true;
                InputResult::Submit
            } else {
                InputResult::Consumed
            }
        }

        fn is_complete(&self) -> bool {
            self.complete
        }

        fn on_focus(&mut self) {
            self.focused = true;
        }

        fn on_blur(&mut self) {
            self.focused = false;
        }
    }

    fn make_key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn make_key_mod(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }

    #[test]
    fn focus_manager_push_pop() {
        let mut manager: FocusManager<TestWidget> = FocusManager::new();

        manager.push(TestWidget::new("widget1"));
        assert!(manager.has_focus());
        assert_eq!(manager.depth(), 1);

        manager.push(TestWidget::new("widget2"));
        assert_eq!(manager.depth(), 2);
        assert_eq!(manager.focused().unwrap().name, "widget2");

        let popped = manager.pop();
        assert_eq!(popped.unwrap().name, "widget2");
        assert_eq!(manager.focused().unwrap().name, "widget1");
    }

    #[test]
    fn focus_callbacks_called() {
        let mut manager: FocusManager<TestWidget> = FocusManager::new();

        let mut widget = TestWidget::new("test");
        assert!(!widget.focused);

        manager.push(widget);
        assert!(manager.focused().unwrap().focused);

        manager.push(TestWidget::new("modal"));
        // Previous widget should be blurred
        assert_eq!(manager.focus_stack[0].focused, false);
        assert!(manager.focused().unwrap().focused);
    }

    #[test]
    fn escape_dismisses() {
        let mut manager: FocusManager<TestWidget> = FocusManager::new();

        manager.push(TestWidget::new("widget"));
        assert_eq!(manager.depth(), 1);

        let result = manager.handle_key(make_key(KeyCode::Esc));
        assert_eq!(result, InputResult::Dismiss);
        assert_eq!(manager.depth(), 0);
    }

    #[test]
    fn interrupt_handling() {
        let mut manager: FocusManager<TestWidget> = FocusManager::new();
        manager.push(TestWidget::new("widget"));

        let ctrl_c = make_key_mod(KeyCode::Char('c'), KeyModifiers::CONTROL);
        let result = manager.handle_key(ctrl_c);

        assert_eq!(result, InputResult::Consumed);
        assert!(manager.take_interrupt());
        assert!(!manager.take_interrupt()); // Cleared after take
    }

    #[test]
    fn focus_ring_navigation() {
        let mut ring = FocusRing::new(3);

        assert_eq!(ring.current(), 0);

        ring.next();
        assert_eq!(ring.current(), 1);

        ring.next();
        assert_eq!(ring.current(), 2);

        ring.next(); // Wraps
        assert_eq!(ring.current(), 0);

        ring.prev(); // Wraps back
        assert_eq!(ring.current(), 2);
    }

    #[test]
    fn focus_ring_tab_handling() {
        let mut ring = FocusRing::new(3);

        assert!(ring.handle_tab(make_key(KeyCode::Tab)));
        assert_eq!(ring.current(), 1);

        assert!(ring.handle_tab(make_key_mod(KeyCode::Tab, KeyModifiers::SHIFT)));
        assert_eq!(ring.current(), 0);
    }

    #[test]
    fn helper_functions() {
        assert!(is_interrupt(make_key_mod(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL
        )));
        assert!(is_escape(make_key(KeyCode::Esc)));
        assert!(is_enter(make_key(KeyCode::Enter)));
        assert!(is_tab(make_key(KeyCode::Tab)));
        assert!(is_shift_tab(make_key_mod(
            KeyCode::Tab,
            KeyModifiers::SHIFT
        )));
        assert!(is_navigation(make_key(KeyCode::Up)));
    }
}

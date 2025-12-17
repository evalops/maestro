//! Component Lifecycle Management
//!
//! Provides traits for managing component lifecycle in a retained-mode style,
//! even though Ratatui uses an immediate-mode rendering approach.
//!
//! # Why Lifecycle Management?
//!
//! While Ratatui renders widgets each frame without built-in lifecycle hooks,
//! complex components often need to:
//!
//! - **Mount**: Initialize resources, subscribe to events, start timers
//! - **Unmount**: Clean up subscriptions, stop timers, release resources
//! - **Dispose**: Perform final cleanup when component is destroyed
//!
//! This module provides traits that components can implement to receive
//! lifecycle callbacks when managed by a component manager.
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::components::lifecycle::{Lifecycle, LifecycleState};
//!
//! struct MyComponent {
//!     lifecycle: LifecycleState,
//!     subscription: Option<UnsubscribeFn>,
//! }
//!
//! impl Lifecycle for MyComponent {
//!     fn on_mount(&mut self) {
//!         self.subscription = Some(event_bus.subscribe(|event| { ... }));
//!     }
//!
//!     fn on_unmount(&mut self) {
//!         if let Some(unsub) = self.subscription.take() {
//!             unsub();
//!         }
//!     }
//! }
//!
//! // Managed usage
//! let mut component = MyComponent::new();
//! component.mount();  // Calls on_mount
//! // ... use component ...
//! component.unmount();  // Calls on_unmount
//! component.dispose();  // Final cleanup
//! ```
//!
//! # Lifecycle States
//!
//! ```text
//! ┌───────────┐     mount()      ┌───────────┐
//! │ Unmounted ├──────────────────► Mounted   │
//! └─────┬─────┘                  └─────┬─────┘
//!       │                              │
//!       │    unmount()                 │
//!       ◄───────────────────────────────┘
//!       │
//!       │    dispose()
//!       ▼
//! ┌───────────┐
//! │ Disposed  │
//! └───────────┘
//! ```
//!
//! # Subscription Management
//!
//! The [`SubscriptionManager`] helper tracks cleanup functions and disposes
//! them all at once:
//!
//! ```rust,ignore
//! let mut subs = SubscriptionManager::new();
//!
//! // Add cleanup functions
//! subs.add(|| timer.stop());
//! subs.add(|| event_bus.unsubscribe(handler_id));
//!
//! // Later, clean up everything
//! subs.dispose();  // Calls all cleanup functions
//! ```

/// Lifecycle trait for components that need mount/unmount callbacks.
///
/// Implement this trait for components that need to:
/// - Initialize resources when becoming active
/// - Clean up resources when becoming inactive
/// - Perform final cleanup when destroyed
///
/// Default implementations do nothing, so you only need to implement
/// the methods you care about.
pub trait Lifecycle {
    /// Called when the component becomes active/visible.
    ///
    /// Use this to:
    /// - Subscribe to events
    /// - Start timers or animations
    /// - Initialize resources that shouldn't exist when unmounted
    fn on_mount(&mut self) {}

    /// Called when the component becomes inactive/hidden.
    ///
    /// Use this to:
    /// - Unsubscribe from events
    /// - Stop timers or animations
    /// - Release temporary resources
    ///
    /// The component may be re-mounted later.
    fn on_unmount(&mut self) {}

    /// Called for permanent disposal.
    ///
    /// Use this for final cleanup that should only happen once.
    /// After this is called, the component should not be used again.
    ///
    /// Default implementation calls `on_unmount()`.
    fn on_dispose(&mut self) {
        self.on_unmount();
    }
}

/// Tracks the lifecycle state of a component.
///
/// This is a helper struct that components can embed to track their
/// current lifecycle state and ensure correct state transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LifecyclePhase {
    /// Initial state, not yet mounted
    #[default]
    Unmounted,
    /// Currently active and visible
    Mounted,
    /// Permanently disposed, cannot be re-mounted
    Disposed,
}

/// Lifecycle state manager for components.
///
/// Embed this in your component to track lifecycle state and get
/// correct state transition behavior.
///
/// ```rust,ignore
/// struct MyComponent {
///     state: LifecycleState,
///     // ... other fields
/// }
///
/// impl MyComponent {
///     pub fn new() -> Self {
///         Self {
///             state: LifecycleState::new(),
///         }
///     }
/// }
/// ```
#[derive(Debug, Default)]
pub struct LifecycleState {
    phase: LifecyclePhase,
}

impl LifecycleState {
    /// Create a new lifecycle state in the unmounted phase.
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the current lifecycle phase.
    pub fn phase(&self) -> LifecyclePhase {
        self.phase
    }

    /// Check if currently mounted.
    pub fn is_mounted(&self) -> bool {
        self.phase == LifecyclePhase::Mounted
    }

    /// Check if disposed.
    pub fn is_disposed(&self) -> bool {
        self.phase == LifecyclePhase::Disposed
    }

    /// Attempt to transition to mounted state.
    ///
    /// Returns `true` if the transition was successful (was unmounted),
    /// `false` if already mounted or disposed.
    pub fn mount(&mut self) -> bool {
        match self.phase {
            LifecyclePhase::Unmounted => {
                self.phase = LifecyclePhase::Mounted;
                true
            }
            LifecyclePhase::Mounted => false,  // Already mounted
            LifecyclePhase::Disposed => false, // Cannot mount disposed component
        }
    }

    /// Attempt to transition to unmounted state.
    ///
    /// Returns `true` if the transition was successful (was mounted),
    /// `false` if already unmounted or disposed.
    pub fn unmount(&mut self) -> bool {
        match self.phase {
            LifecyclePhase::Mounted => {
                self.phase = LifecyclePhase::Unmounted;
                true
            }
            LifecyclePhase::Unmounted => false, // Already unmounted
            LifecyclePhase::Disposed => false,  // Already disposed
        }
    }

    /// Transition to disposed state.
    ///
    /// Returns `true` if the transition was successful,
    /// `false` if already disposed.
    pub fn dispose(&mut self) -> bool {
        if self.phase == LifecyclePhase::Disposed {
            return false;
        }
        self.phase = LifecyclePhase::Disposed;
        true
    }
}

/// Helper for mounting a component with lifecycle.
///
/// Handles the lifecycle state transition and calls the callback.
pub fn mount_component<T: Lifecycle>(component: &mut T, state: &mut LifecycleState) {
    if state.mount() {
        component.on_mount();
    }
}

/// Helper for unmounting a component with lifecycle.
///
/// Handles the lifecycle state transition and calls the callback.
pub fn unmount_component<T: Lifecycle>(component: &mut T, state: &mut LifecycleState) {
    if state.unmount() {
        component.on_unmount();
    }
}

/// Helper for disposing a component with lifecycle.
///
/// Handles the lifecycle state transition and calls the callback.
pub fn dispose_component<T: Lifecycle>(component: &mut T, state: &mut LifecycleState) {
    if state.dispose() {
        component.on_dispose();
    }
}

/// Type alias for cleanup functions.
pub type CleanupFn = Box<dyn FnOnce() + Send>;

/// Manages a collection of cleanup functions.
///
/// Use this to track subscriptions, timers, and other resources that
/// need cleanup when a component is unmounted or disposed.
///
/// ```rust,ignore
/// let mut subs = SubscriptionManager::new();
///
/// // Track cleanup functions
/// subs.add(|| println!("Cleanup 1"));
/// subs.add(|| println!("Cleanup 2"));
///
/// // Run all cleanup functions
/// subs.dispose();  // Prints "Cleanup 1", then "Cleanup 2"
/// ```
pub struct SubscriptionManager {
    cleanups: Vec<CleanupFn>,
}

impl Default for SubscriptionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SubscriptionManager {
    /// Create a new empty subscription manager.
    pub fn new() -> Self {
        Self {
            cleanups: Vec::new(),
        }
    }

    /// Add a cleanup function to be called on dispose.
    ///
    /// Cleanup functions are called in the order they were added.
    pub fn add<F: FnOnce() + Send + 'static>(&mut self, cleanup: F) {
        self.cleanups.push(Box::new(cleanup));
    }

    /// Check if there are any tracked cleanups.
    pub fn is_empty(&self) -> bool {
        self.cleanups.is_empty()
    }

    /// Get the number of tracked cleanups.
    pub fn len(&self) -> usize {
        self.cleanups.len()
    }

    /// Run all cleanup functions and clear the list.
    ///
    /// Cleanup functions are called in FIFO order (first added, first called).
    /// Errors in cleanup functions are silently ignored.
    pub fn dispose(&mut self) {
        for cleanup in self.cleanups.drain(..) {
            // Call cleanup, ignoring any panics
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup));
        }
    }
}

impl Drop for SubscriptionManager {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn lifecycle_state_transitions() {
        let mut state = LifecycleState::new();

        assert_eq!(state.phase(), LifecyclePhase::Unmounted);
        assert!(!state.is_mounted());

        // Mount
        assert!(state.mount());
        assert!(state.is_mounted());
        assert!(!state.mount()); // Can't mount twice

        // Unmount
        assert!(state.unmount());
        assert!(!state.is_mounted());
        assert!(!state.unmount()); // Can't unmount twice

        // Dispose
        assert!(state.dispose());
        assert!(state.is_disposed());
        assert!(!state.mount()); // Can't mount disposed
        assert!(!state.unmount()); // Can't unmount disposed
        assert!(!state.dispose()); // Can't dispose twice
    }

    struct TestComponent {
        mount_count: Arc<AtomicUsize>,
        unmount_count: Arc<AtomicUsize>,
        dispose_count: Arc<AtomicUsize>,
    }

    impl Lifecycle for TestComponent {
        fn on_mount(&mut self) {
            self.mount_count.fetch_add(1, Ordering::SeqCst);
        }

        fn on_unmount(&mut self) {
            self.unmount_count.fetch_add(1, Ordering::SeqCst);
        }

        fn on_dispose(&mut self) {
            self.dispose_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn lifecycle_callbacks() {
        let mount_count = Arc::new(AtomicUsize::new(0));
        let unmount_count = Arc::new(AtomicUsize::new(0));
        let dispose_count = Arc::new(AtomicUsize::new(0));

        let mut component = TestComponent {
            mount_count: mount_count.clone(),
            unmount_count: unmount_count.clone(),
            dispose_count: dispose_count.clone(),
        };
        let mut state = LifecycleState::new();

        mount_component(&mut component, &mut state);
        assert_eq!(mount_count.load(Ordering::SeqCst), 1);

        // Second mount should not call callback
        mount_component(&mut component, &mut state);
        assert_eq!(mount_count.load(Ordering::SeqCst), 1);

        unmount_component(&mut component, &mut state);
        assert_eq!(unmount_count.load(Ordering::SeqCst), 1);

        dispose_component(&mut component, &mut state);
        assert_eq!(dispose_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn subscription_manager_basic() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut subs = SubscriptionManager::new();

        let c1 = counter.clone();
        subs.add(move || {
            c1.fetch_add(1, Ordering::SeqCst);
        });

        let c2 = counter.clone();
        subs.add(move || {
            c2.fetch_add(10, Ordering::SeqCst);
        });

        assert_eq!(subs.len(), 2);
        assert!(!subs.is_empty());

        subs.dispose();

        assert_eq!(counter.load(Ordering::SeqCst), 11);
        assert!(subs.is_empty());
    }

    #[test]
    fn subscription_manager_drop_calls_dispose() {
        let counter = Arc::new(AtomicUsize::new(0));
        {
            let mut subs = SubscriptionManager::new();
            let c = counter.clone();
            subs.add(move || {
                c.fetch_add(1, Ordering::SeqCst);
            });
            // subs dropped here
        }

        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }
}

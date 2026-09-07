//! Publishes whether a steering prompt is waiting to be delivered.
//!
//! A steering prompt is a message the user sends while the agent is busy. The
//! runner drains it between tool calls, which works as long as every tool call
//! ends promptly. A blocking wait breaks that: `wait_subagent` sleeps in 50 ms
//! slices for up to its whole timeout, and the runner does not look at the
//! queue again until it returns. The user's message sits there.
//!
//! [`MessageQueue`](super::message_queue::MessageQueue) owns the state and
//! keeps it exact: after every change to the queue it republishes whether a
//! [`PromptKind::Steer`](super::message_queue::PromptKind::Steer) message is
//! present. Tools hold the same [`SteerSignal`] and can wait on it.
//!
//! Waits race their sleep against admitted user injection and return
//! `"steer_release"` when steering should resume the loop.

use tokio::sync::watch;

/// Shared "a steering prompt is queued" flag with change notification.
#[derive(Debug)]
pub struct SteerSignal {
    sender: watch::Sender<bool>,
}

impl Default for SteerSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl SteerSignal {
    /// Create a signal with nothing pending.
    #[must_use]
    pub fn new() -> Self {
        Self {
            sender: watch::channel(false).0,
        }
    }

    /// Whether a steering prompt is queued right now.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        *self.sender.borrow()
    }

    /// Publish the current state. Only a change wakes waiters.
    pub fn set_pending(&self, pending: bool) {
        let _changed = self.sender.send_if_modified(|current| {
            if *current == pending {
                false
            } else {
                *current = pending;
                true
            }
        });
    }

    /// Resolve as soon as a steering prompt is queued.
    ///
    /// Returns immediately when one is already queued. Subscribing before the
    /// first check is what closes the race where a prompt is admitted between
    /// the check and the wait.
    pub async fn pending(&self) {
        let mut receiver = self.sender.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                // The sender lives as long as `self`, so this is unreachable
                // in practice. Never resolving is the safe reading: a caller
                // racing this against a deadline must not be released by a
                // signal that can no longer fire.
                std::future::pending::<()>().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::SteerSignal;

    #[tokio::test]
    async fn pending_resolves_immediately_when_already_set() {
        let signal = SteerSignal::new();
        signal.set_pending(true);
        assert!(signal.is_pending());
        tokio::time::timeout(Duration::from_millis(50), signal.pending())
            .await
            .expect("an already-pending signal must not block");
    }

    #[tokio::test]
    async fn pending_resolves_when_a_steer_arrives_later() {
        let signal = Arc::new(SteerSignal::new());
        let waiter = Arc::clone(&signal);
        let task = tokio::spawn(async move { waiter.pending().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        signal.set_pending(true);
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("a later steer must wake the waiter")
            .expect("waiter task");
    }

    #[tokio::test]
    async fn pending_does_not_resolve_while_nothing_is_queued() {
        let signal = SteerSignal::new();
        assert!(
            tokio::time::timeout(Duration::from_millis(60), signal.pending())
                .await
                .is_err(),
            "an empty queue must not release a waiter"
        );
    }

    #[tokio::test]
    async fn clearing_and_setting_again_wakes_a_new_waiter() {
        let signal = Arc::new(SteerSignal::new());
        signal.set_pending(true);
        signal.set_pending(false);
        assert!(!signal.is_pending());

        let waiter = Arc::clone(&signal);
        let task = tokio::spawn(async move { waiter.pending().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        signal.set_pending(true);
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("a re-set signal must wake a new waiter")
            .expect("waiter task");
    }
}

//! Message Queue for Pending User Inputs
//!
//! This module provides a simple queue for managing pending user messages
//! while the agent is processing. This improves UX by allowing users to
//! continue typing even when the agent is busy.
//!
//! # Use Cases
//!
//! 1. **Rapid-fire inputs**: User sends multiple messages before agent responds
//! 2. **UI feedback**: Show "2 messages pending" indicator
//! 3. **Race condition prevention**: Messages processed in order
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::agent::message_queue::MessageQueue;
//!
//! let mut queue = MessageQueue::new();
//!
//! // User sends messages while agent is busy
//! queue.push("First message");
//! queue.push("Second message");
//!
//! assert_eq!(queue.len(), 2);
//!
//! // Agent starts processing
//! if let Some(msg) = queue.pop() {
//!     // Process "First message"
//! }
//! ```

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// A pending message waiting to be processed.
#[derive(Debug, Clone)]
pub struct PendingMessage {
    /// The message content
    pub content: String,
    /// Timestamp when the message was queued (milliseconds since epoch)
    pub queued_at: u64,
    /// Optional priority (higher = more urgent)
    pub priority: u8,
}

impl PendingMessage {
    /// Create a new pending message with current timestamp
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            queued_at: current_timestamp_ms(),
            priority: 0,
        }
    }

    /// Create a high-priority pending message
    pub fn urgent(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            queued_at: current_timestamp_ms(),
            priority: 100,
        }
    }

    /// How long this message has been waiting (in milliseconds)
    pub fn waiting_ms(&self) -> u64 {
        current_timestamp_ms().saturating_sub(self.queued_at)
    }
}

/// Queue for managing pending user messages.
///
/// Messages are processed in FIFO order by default. High-priority messages
/// can be inserted at the front of the queue.
#[derive(Debug, Default)]
pub struct MessageQueue {
    queue: VecDeque<PendingMessage>,
    /// Maximum queue size (0 = unlimited)
    max_size: usize,
    /// Total messages ever queued (for statistics)
    total_queued: u64,
    /// Total messages dropped due to overflow
    dropped_count: u64,
}

impl MessageQueue {
    /// Create a new empty message queue
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
            max_size: 0,
            total_queued: 0,
            dropped_count: 0,
        }
    }

    /// Create a queue with a maximum size
    ///
    /// When the queue is full, oldest messages are dropped.
    pub fn with_max_size(max_size: usize) -> Self {
        Self {
            queue: VecDeque::with_capacity(max_size.min(100)),
            max_size,
            total_queued: 0,
            dropped_count: 0,
        }
    }

    /// Push a message onto the queue
    ///
    /// Returns the message that was dropped if the queue overflowed.
    pub fn push(&mut self, content: impl Into<String>) -> Option<PendingMessage> {
        self.push_message(PendingMessage::new(content))
    }

    /// Push a pending message onto the queue
    pub fn push_message(&mut self, msg: PendingMessage) -> Option<PendingMessage> {
        self.total_queued += 1;

        // Handle priority messages
        if msg.priority > 0 {
            self.queue.push_front(msg);
        } else {
            self.queue.push_back(msg);
        }

        // Check for overflow
        if self.max_size > 0 && self.queue.len() > self.max_size {
            self.dropped_count += 1;
            // Drop oldest (back of queue for normal, front for priority)
            return self.queue.pop_back();
        }

        None
    }

    /// Push a high-priority message to the front of the queue
    pub fn push_urgent(&mut self, content: impl Into<String>) -> Option<PendingMessage> {
        self.push_message(PendingMessage::urgent(content))
    }

    /// Pop the next message from the queue
    pub fn pop(&mut self) -> Option<PendingMessage> {
        self.queue.pop_front()
    }

    /// Peek at the next message without removing it
    pub fn peek(&self) -> Option<&PendingMessage> {
        self.queue.front()
    }

    /// Check if the queue is empty
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Get the number of pending messages
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// Clear all pending messages
    ///
    /// Returns the messages that were cleared.
    pub fn clear(&mut self) -> Vec<PendingMessage> {
        self.queue.drain(..).collect()
    }

    /// Get queue statistics
    pub fn stats(&self) -> QueueStats {
        let oldest_waiting_ms = self.queue.front().map(|m| m.waiting_ms());

        QueueStats {
            pending_count: self.queue.len(),
            total_queued: self.total_queued,
            dropped_count: self.dropped_count,
            oldest_waiting_ms,
        }
    }

    /// Iterate over pending messages without consuming them
    pub fn iter(&self) -> impl Iterator<Item = &PendingMessage> {
        self.queue.iter()
    }

    /// Take all messages as a vector, clearing the queue
    pub fn take_all(&mut self) -> Vec<PendingMessage> {
        self.clear()
    }

    /// Drain messages that have been waiting longer than the threshold
    pub fn drain_stale(&mut self, max_wait_ms: u64) -> Vec<PendingMessage> {
        let mut stale = Vec::new();
        let now = current_timestamp_ms();

        self.queue.retain(|msg| {
            if now.saturating_sub(msg.queued_at) > max_wait_ms {
                stale.push(msg.clone());
                false
            } else {
                true
            }
        });

        stale
    }
}

/// Statistics about the message queue
#[derive(Debug, Clone, Default)]
pub struct QueueStats {
    /// Current number of pending messages
    pub pending_count: usize,
    /// Total messages ever queued
    pub total_queued: u64,
    /// Total messages dropped due to overflow
    pub dropped_count: u64,
    /// How long the oldest message has been waiting
    pub oldest_waiting_ms: Option<u64>,
}

impl QueueStats {
    /// Check if any messages are pending
    pub fn has_pending(&self) -> bool {
        self.pending_count > 0
    }

    /// Format as a status string for display
    pub fn status_string(&self) -> String {
        if self.pending_count == 0 {
            String::new()
        } else if self.pending_count == 1 {
            "1 message pending".to_string()
        } else {
            format!("{} messages pending", self.pending_count)
        }
    }
}

/// Get current timestamp in milliseconds
fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_queue_push_pop() {
        let mut queue = MessageQueue::new();

        queue.push("First");
        queue.push("Second");
        queue.push("Third");

        assert_eq!(queue.len(), 3);

        let msg = queue.pop().unwrap();
        assert_eq!(msg.content, "First");

        let msg = queue.pop().unwrap();
        assert_eq!(msg.content, "Second");

        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn test_queue_fifo_order() {
        let mut queue = MessageQueue::new();

        for i in 1..=5 {
            queue.push(format!("Message {}", i));
        }

        for i in 1..=5 {
            let msg = queue.pop().unwrap();
            assert_eq!(msg.content, format!("Message {}", i));
        }
    }

    #[test]
    fn test_queue_urgent_priority() {
        let mut queue = MessageQueue::new();

        queue.push("Normal 1");
        queue.push("Normal 2");
        queue.push_urgent("Urgent!");

        // Urgent should be first
        let msg = queue.pop().unwrap();
        assert_eq!(msg.content, "Urgent!");

        let msg = queue.pop().unwrap();
        assert_eq!(msg.content, "Normal 1");
    }

    #[test]
    fn test_queue_max_size() {
        let mut queue = MessageQueue::with_max_size(2);

        queue.push("First");
        queue.push("Second");
        let dropped = queue.push("Third");

        // Should have dropped the oldest
        assert!(dropped.is_some());
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn test_queue_clear() {
        let mut queue = MessageQueue::new();

        queue.push("A");
        queue.push("B");
        queue.push("C");

        let cleared = queue.clear();
        assert_eq!(cleared.len(), 3);
        assert!(queue.is_empty());
    }

    #[test]
    fn test_queue_stats() {
        let mut queue = MessageQueue::new();

        queue.push("Test");
        queue.push("Test 2");

        let stats = queue.stats();
        assert_eq!(stats.pending_count, 2);
        assert_eq!(stats.total_queued, 2);
        assert_eq!(stats.dropped_count, 0);
        assert!(stats.has_pending());
    }

    #[test]
    fn test_queue_stats_string() {
        let stats = QueueStats {
            pending_count: 0,
            ..Default::default()
        };
        assert_eq!(stats.status_string(), "");

        let stats = QueueStats {
            pending_count: 1,
            ..Default::default()
        };
        assert_eq!(stats.status_string(), "1 message pending");

        let stats = QueueStats {
            pending_count: 5,
            ..Default::default()
        };
        assert_eq!(stats.status_string(), "5 messages pending");
    }

    #[test]
    fn test_pending_message_waiting_time() {
        let msg = PendingMessage::new("Test");

        // Should be close to 0ms since just created
        assert!(msg.waiting_ms() < 100);
    }

    #[test]
    fn test_queue_peek() {
        let mut queue = MessageQueue::new();

        assert!(queue.peek().is_none());

        queue.push("First");
        queue.push("Second");

        assert_eq!(queue.peek().unwrap().content, "First");
        assert_eq!(queue.len(), 2); // Peek doesn't remove
    }

    #[test]
    fn test_queue_iter() {
        let mut queue = MessageQueue::new();

        queue.push("A");
        queue.push("B");
        queue.push("C");

        let contents: Vec<&str> = queue.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, vec!["A", "B", "C"]);
    }

    #[test]
    fn test_take_all() {
        let mut queue = MessageQueue::new();

        queue.push("X");
        queue.push("Y");

        let all = queue.take_all();
        assert_eq!(all.len(), 2);
        assert!(queue.is_empty());
    }
}

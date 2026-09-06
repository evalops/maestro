//! Notification Queue System
//!
//! Provides a priority queue for notifications with:
//! - Multiple severity levels (info, warning, error)
//! - Auto-dismiss with configurable timeout
//! - Category-based batching (merge duplicate types)
//! - Maximum visible notifications limit
//!
//! Essential for responsive user feedback without blocking the UI.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION LEVEL
// ─────────────────────────────────────────────────────────────────────────────

/// Severity level of a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NotificationLevel {
    /// Informational message.
    Info = 0,
    /// Success message.
    Success = 1,
    /// Warning message.
    Warning = 2,
    /// Error message.
    Error = 3,
}

impl NotificationLevel {
    /// Get the display icon for this level.
    #[must_use]
    pub fn icon(&self) -> &'static str {
        match self {
            Self::Info => "ℹ",
            Self::Success => "✓",
            Self::Warning => "⚠",
            Self::Error => "✗",
        }
    }

    /// Get the ASCII fallback icon.
    #[must_use]
    pub fn ascii_icon(&self) -> &'static str {
        match self {
            Self::Info => "i",
            Self::Success => "+",
            Self::Warning => "!",
            Self::Error => "x",
        }
    }

    /// Get the color for this level.
    #[must_use]
    pub fn color(&self) -> Color {
        match self {
            Self::Info => Color::Cyan,
            Self::Success => Color::Green,
            Self::Warning => Color::Yellow,
            Self::Error => Color::Red,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/// A unique notification ID.
pub type NotificationId = u64;

/// A notification message.
#[derive(Debug, Clone)]
pub struct Notification {
    /// Unique ID.
    pub id: NotificationId,
    /// Severity level.
    pub level: NotificationLevel,
    /// Short title.
    pub title: String,
    /// Optional longer message.
    pub message: Option<String>,
    /// Category for batching similar notifications.
    pub category: Option<String>,
    /// Auto-dismiss duration (None = manual dismiss).
    pub duration: Option<Duration>,
    /// When this notification was created.
    pub created_at: Instant,
    /// How many similar notifications were batched into this one.
    pub batch_count: usize,
}

impl Notification {
    /// Create a new notification.
    pub fn new(level: NotificationLevel, title: impl Into<String>) -> Self {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

        Self {
            id: COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            level,
            title: title.into(),
            message: None,
            category: None,
            duration: Some(Duration::from_secs(5)),
            created_at: Instant::now(),
            batch_count: 1,
        }
    }

    /// Create an info notification.
    pub fn info(title: impl Into<String>) -> Self {
        Self::new(NotificationLevel::Info, title)
    }

    /// Create a success notification.
    pub fn success(title: impl Into<String>) -> Self {
        Self::new(NotificationLevel::Success, title)
    }

    /// Create a warning notification.
    pub fn warning(title: impl Into<String>) -> Self {
        Self::new(NotificationLevel::Warning, title)
    }

    /// Create an error notification.
    pub fn error(title: impl Into<String>) -> Self {
        Self::new(NotificationLevel::Error, title)
    }

    /// Add a message.
    pub fn with_message(mut self, msg: impl Into<String>) -> Self {
        self.message = Some(msg.into());
        self
    }

    /// Set the category for batching.
    pub fn with_category(mut self, cat: impl Into<String>) -> Self {
        self.category = Some(cat.into());
        self
    }

    /// Set the auto-dismiss duration.
    #[must_use]
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration = Some(duration);
        self
    }

    /// Make this notification persistent (no auto-dismiss).
    #[must_use]
    pub fn persistent(mut self) -> Self {
        self.duration = None;
        self
    }

    /// Check if this notification has expired.
    #[must_use]
    pub fn is_expired(&self) -> bool {
        if let Some(duration) = self.duration {
            self.created_at.elapsed() >= duration
        } else {
            false
        }
    }

    /// Render the notification to a Line.
    #[must_use]
    pub fn render(&self, use_ascii: bool) -> Line<'static> {
        let icon = if use_ascii {
            self.level.ascii_icon()
        } else {
            self.level.icon()
        };

        let mut spans = vec![
            Span::styled(
                format!("{icon} "),
                Style::default()
                    .fg(self.level.color())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                self.title.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
        ];

        if self.batch_count > 1 {
            spans.push(Span::styled(
                format!(" (x{})", self.batch_count),
                Style::default().fg(Color::DarkGray),
            ));
        }

        if let Some(ref msg) = self.message {
            spans.push(Span::styled(
                format!(" - {msg}"),
                Style::default().fg(Color::DarkGray),
            ));
        }

        Line::from(spans)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION QUEUE
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for the notification queue.
#[derive(Debug, Clone)]
pub struct NotificationQueueConfig {
    /// Maximum number of visible notifications.
    pub max_visible: usize,
    /// Maximum queue size.
    pub max_queue_size: usize,
    /// Whether to batch similar notifications.
    pub batch_similar: bool,
    /// Use ASCII icons.
    pub use_ascii: bool,
}

impl Default for NotificationQueueConfig {
    fn default() -> Self {
        Self {
            max_visible: 3,
            max_queue_size: 100,
            batch_similar: true,
            use_ascii: false,
        }
    }
}

/// A queue for managing notifications.
#[derive(Debug, Default)]
pub struct NotificationQueue {
    notifications: VecDeque<Notification>,
    config: NotificationQueueConfig,
}

impl NotificationQueue {
    /// Create a new notification queue.
    #[must_use]
    pub fn new(config: NotificationQueueConfig) -> Self {
        Self {
            notifications: VecDeque::new(),
            config,
        }
    }

    /// Push a notification to the queue.
    pub fn push(&mut self, notification: Notification) {
        if self.config.batch_similar {
            if let Some(cat) = &notification.category {
                if let Some(existing) = self
                    .notifications
                    .iter_mut()
                    .find(|n| n.category.as_ref() == Some(cat) && n.level == notification.level)
                {
                    existing.batch_count += 1;
                    existing.created_at = Instant::now();
                    return;
                }
            }
        }

        self.notifications.push_back(notification);

        while self.notifications.len() > self.config.max_queue_size {
            self.notifications.pop_front();
        }
    }

    /// Push an info notification.
    pub fn info(&mut self, title: impl Into<String>) {
        self.push(Notification::info(title));
    }

    /// Push a success notification.
    pub fn success(&mut self, title: impl Into<String>) {
        self.push(Notification::success(title));
    }

    /// Push a warning notification.
    pub fn warning(&mut self, title: impl Into<String>) {
        self.push(Notification::warning(title));
    }

    /// Push an error notification.
    pub fn error(&mut self, title: impl Into<String>) {
        self.push(Notification::error(title));
    }

    /// Dismiss a notification by ID.
    pub fn dismiss(&mut self, id: NotificationId) {
        self.notifications.retain(|n| n.id != id);
    }

    /// Dismiss all notifications.
    pub fn dismiss_all(&mut self) {
        self.notifications.clear();
    }

    /// Remove expired notifications.
    pub fn cleanup_expired(&mut self) -> usize {
        let initial_len = self.notifications.len();
        self.notifications.retain(|n| !n.is_expired());
        initial_len - self.notifications.len()
    }

    /// Get visible notifications (highest priority first).
    #[must_use]
    pub fn visible(&self) -> Vec<&Notification> {
        let mut sorted: Vec<_> = self.notifications.iter().collect();
        sorted.sort_by(|a, b| {
            b.level
                .cmp(&a.level)
                .then_with(|| a.created_at.cmp(&b.created_at))
        });
        sorted.into_iter().take(self.config.max_visible).collect()
    }

    /// Get the number of notifications.
    #[must_use]
    pub fn len(&self) -> usize {
        self.notifications.len()
    }

    /// Check if empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.notifications.is_empty()
    }

    /// Render visible notifications.
    #[must_use]
    pub fn render(&self) -> Vec<Line<'static>> {
        self.visible()
            .iter()
            .map(|n| n.render(self.config.use_ascii))
            .collect()
    }
}

/// A simple toast notification.
#[derive(Debug, Clone)]
pub struct Toast {
    pub message: String,
    pub level: NotificationLevel,
    pub created_at: Instant,
    pub duration: Duration,
}

impl Toast {
    pub const DEFAULT_DURATION: Duration = Duration::from_secs(2);

    pub fn new(message: impl Into<String>, level: NotificationLevel) -> Self {
        Self {
            message: message.into(),
            level,
            created_at: Instant::now(),
            duration: Self::DEFAULT_DURATION,
        }
    }

    pub fn info(message: impl Into<String>) -> Self {
        Self::new(message, NotificationLevel::Info)
    }
    pub fn success(message: impl Into<String>) -> Self {
        Self::new(message, NotificationLevel::Success)
    }
    pub fn warning(message: impl Into<String>) -> Self {
        Self::new(message, NotificationLevel::Warning)
    }
    pub fn error(message: impl Into<String>) -> Self {
        Self::new(message, NotificationLevel::Error)
    }

    #[must_use]
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= self.duration
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_levels() {
        assert!(NotificationLevel::Error > NotificationLevel::Warning);
    }

    #[test]
    fn queue_batching() {
        let mut queue = NotificationQueue::default();
        queue.push(Notification::info("Update").with_category("updates"));
        queue.push(Notification::info("Update").with_category("updates"));
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.notifications[0].batch_count, 2);
    }

    #[test]
    fn queue_priority() {
        let mut queue = NotificationQueue::default();
        queue.info("Info");
        queue.error("Error");
        let visible = queue.visible();
        assert_eq!(visible[0].level, NotificationLevel::Error);
    }
}

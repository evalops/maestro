//! Status Indicator Widget
//!
//! Displays a live status indicator during long-running operations.
//! Shows animated text with shimmer effect, elapsed time, and interrupt hints.
//!
//! # Features
//!
//! - Shimmer animation on status text
//! - Elapsed time display with auto-formatting
//! - Interrupt hint (Ctrl+C)
//! - Pause/resume timer capability
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::components::StatusIndicator;
//!
//! let mut indicator = StatusIndicator::new()
//!     .with_header("Working")
//!     .show_interrupt_hint(true);
//!
//! indicator.start();
//!
//! // In your render loop:
//! indicator.render(frame, area);
//!
//! // When done:
//! indicator.stop();
//! ```

use ratatui::{
    prelude::*,
    widgets::{Paragraph, Widget},
};
use std::time::{Duration, Instant};

use crate::effects::braille_spinner;
use crate::effects::shimmer_spans;

use super::rate_limit::format_duration_compact;

/// Status indicator showing progress during long operations
#[derive(Debug, Clone)]
pub struct StatusIndicator {
    /// Header text (e.g., "Working", "Thinking")
    header: String,
    /// Whether to show interrupt hint
    show_interrupt_hint: bool,
    /// Total elapsed time while running
    elapsed_running: Duration,
    /// When the timer was last resumed
    last_resume_at: Option<Instant>,
    /// Whether the timer is paused
    is_paused: bool,
    /// Whether animations are enabled
    animations_enabled: bool,
    /// Current spinner frame
    frame: usize,
    /// Optional status message
    status_message: Option<String>,
}

impl Default for StatusIndicator {
    fn default() -> Self {
        Self {
            header: "Working".to_string(),
            show_interrupt_hint: true,
            elapsed_running: Duration::ZERO,
            last_resume_at: None,
            is_paused: true,
            animations_enabled: true,
            frame: 0,
            status_message: None,
        }
    }
}

impl StatusIndicator {
    /// Create a new status indicator
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the header text
    pub fn with_header(mut self, header: impl Into<String>) -> Self {
        self.header = header.into();
        self
    }

    /// Enable/disable interrupt hint
    #[must_use]
    pub fn show_interrupt_hint(mut self, show: bool) -> Self {
        self.show_interrupt_hint = show;
        self
    }

    /// Enable/disable animations
    #[must_use]
    pub fn animations_enabled(mut self, enabled: bool) -> Self {
        self.animations_enabled = enabled;
        self
    }

    /// Start the timer
    pub fn start(&mut self) {
        self.is_paused = false;
        self.last_resume_at = Some(Instant::now());
        self.elapsed_running = Duration::ZERO;
    }

    /// Stop the timer
    pub fn stop(&mut self) {
        if !self.is_paused {
            if let Some(resume_at) = self.last_resume_at {
                self.elapsed_running += resume_at.elapsed();
            }
        }
        self.is_paused = true;
        self.last_resume_at = None;
    }

    /// Pause the timer
    pub fn pause(&mut self) {
        if !self.is_paused {
            if let Some(resume_at) = self.last_resume_at {
                self.elapsed_running += resume_at.elapsed();
            }
            self.is_paused = true;
            self.last_resume_at = None;
        }
    }

    /// Resume the timer
    pub fn resume(&mut self) {
        if self.is_paused {
            self.is_paused = false;
            self.last_resume_at = Some(Instant::now());
        }
    }

    /// Reset the timer
    pub fn reset(&mut self) {
        self.elapsed_running = Duration::ZERO;
        self.last_resume_at = if self.is_paused {
            None
        } else {
            Some(Instant::now())
        };
    }

    /// Update the header text
    pub fn set_header(&mut self, header: impl Into<String>) {
        self.header = header.into();
    }

    /// Set a status message (shown after elapsed time)
    pub fn set_status(&mut self, message: Option<String>) {
        self.status_message = message;
    }

    /// Get the header text
    #[must_use]
    pub fn header(&self) -> &str {
        &self.header
    }

    /// Check if running
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.is_paused
    }

    /// Get total elapsed time
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        let mut total = self.elapsed_running;
        if !self.is_paused {
            if let Some(resume_at) = self.last_resume_at {
                total += resume_at.elapsed();
            }
        }
        total
    }

    /// Advance the animation frame
    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
    }

    /// Get formatted elapsed time
    #[must_use]
    pub fn elapsed_display(&self) -> String {
        format_duration_compact(self.elapsed().as_secs())
    }

    /// Render with shimmer effect
    fn render_with_shimmer(&self, area: Rect, buf: &mut Buffer) {
        let spinner_span = if self.animations_enabled {
            braille_spinner(self.last_resume_at)
        } else {
            Span::styled("●", Style::default().fg(Color::Cyan))
        };

        let elapsed = self.elapsed_display();

        // Build spans
        let mut spans: Vec<Span> = Vec::new();

        // Spinner
        spans.push(spinner_span);
        spans.push(Span::raw(" "));

        // Header with shimmer
        if self.animations_enabled {
            spans.extend(shimmer_spans(&self.header));
        } else {
            spans.push(Span::styled(
                self.header.clone(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ));
        }

        // Elapsed time in brackets
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            format!("[{elapsed}]"),
            Style::default().fg(Color::DarkGray),
        ));

        // Status message if present
        if let Some(ref msg) = self.status_message {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(msg.clone(), Style::default().fg(Color::Gray)));
        }

        // Interrupt hint
        if self.show_interrupt_hint {
            spans.push(Span::raw("  "));
            spans.push(Span::styled(
                "Ctrl+C",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM),
            ));
            spans.push(Span::styled(
                " to interrupt",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM),
            ));
        }

        Paragraph::new(Line::from(spans)).render(area, buf);
    }
}

impl Widget for StatusIndicator {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if !self.is_paused || self.elapsed_running > Duration::ZERO {
            self.render_with_shimmer(area, buf);
        }
    }
}

/// Builder for status indicator with common presets
pub struct StatusIndicatorBuilder {
    indicator: StatusIndicator,
}

impl StatusIndicatorBuilder {
    /// Create a new builder
    #[must_use]
    pub fn new() -> Self {
        Self {
            indicator: StatusIndicator::new(),
        }
    }

    /// Preset for "Working" state
    #[must_use]
    pub fn working(mut self) -> Self {
        self.indicator.header = "Working".to_string();
        self
    }

    /// Preset for "Thinking" state
    #[must_use]
    pub fn thinking(mut self) -> Self {
        self.indicator.header = "Thinking".to_string();
        self
    }

    /// Preset for "Analyzing" state
    #[must_use]
    pub fn analyzing(mut self) -> Self {
        self.indicator.header = "Analyzing".to_string();
        self
    }

    /// Preset for "Generating" state
    #[must_use]
    pub fn generating(mut self) -> Self {
        self.indicator.header = "Generating".to_string();
        self
    }

    /// Custom header
    pub fn header(mut self, header: impl Into<String>) -> Self {
        self.indicator.header = header.into();
        self
    }

    /// Enable/disable interrupt hint
    #[must_use]
    pub fn interrupt_hint(mut self, show: bool) -> Self {
        self.indicator.show_interrupt_hint = show;
        self
    }

    /// Enable/disable animations
    #[must_use]
    pub fn animations(mut self, enabled: bool) -> Self {
        self.indicator.animations_enabled = enabled;
        self
    }

    /// Build and start the indicator
    #[must_use]
    pub fn build_started(mut self) -> StatusIndicator {
        self.indicator.start();
        self.indicator
    }

    /// Build without starting
    #[must_use]
    pub fn build(self) -> StatusIndicator {
        self.indicator
    }
}

impl Default for StatusIndicatorBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_indicator_default() {
        let indicator = StatusIndicator::new();
        assert_eq!(indicator.header(), "Working");
        assert!(indicator.show_interrupt_hint);
        assert!(!indicator.is_running());
    }

    #[test]
    fn test_status_indicator_start_stop() {
        let mut indicator = StatusIndicator::new();

        assert!(!indicator.is_running());

        indicator.start();
        assert!(indicator.is_running());

        std::thread::sleep(Duration::from_millis(10));
        assert!(indicator.elapsed() > Duration::ZERO);

        indicator.stop();
        assert!(!indicator.is_running());
    }

    #[test]
    fn test_status_indicator_pause_resume() {
        let mut indicator = StatusIndicator::new();
        indicator.start();

        std::thread::sleep(Duration::from_millis(10));
        let elapsed1 = indicator.elapsed();

        indicator.pause();
        std::thread::sleep(Duration::from_millis(10));
        let elapsed2 = indicator.elapsed();

        // Should be approximately the same (paused)
        assert!(elapsed2 >= elapsed1);
        assert!(elapsed2 < elapsed1 + Duration::from_millis(5));

        indicator.resume();
        std::thread::sleep(Duration::from_millis(10));
        let elapsed3 = indicator.elapsed();

        // Should have increased
        assert!(elapsed3 > elapsed2);
    }

    #[test]
    fn test_status_indicator_reset() {
        let mut indicator = StatusIndicator::new();
        indicator.start();

        std::thread::sleep(Duration::from_millis(10));
        assert!(indicator.elapsed() > Duration::ZERO);

        indicator.reset();
        // After reset, elapsed should be very small (just the time since reset)
        assert!(indicator.elapsed() < Duration::from_millis(5));
    }

    #[test]
    fn test_status_indicator_builder() {
        let indicator = StatusIndicatorBuilder::new()
            .thinking()
            .interrupt_hint(false)
            .animations(false)
            .build_started();

        assert_eq!(indicator.header(), "Thinking");
        assert!(!indicator.show_interrupt_hint);
        assert!(!indicator.animations_enabled);
        assert!(indicator.is_running());
    }

    #[test]
    fn test_status_indicator_tick() {
        let mut indicator = StatusIndicator::new();
        let initial = indicator.frame;

        indicator.tick();
        assert_eq!(indicator.frame, initial + 1);
    }

    #[test]
    fn test_status_indicator_elapsed_display() {
        let mut indicator = StatusIndicator::new();
        indicator.elapsed_running = Duration::from_secs(90);
        assert_eq!(indicator.elapsed_display(), "1m 30s");
    }

    #[test]
    fn test_status_indicator_set_status() {
        let mut indicator = StatusIndicator::new();
        assert!(indicator.status_message.is_none());

        indicator.set_status(Some("Reading files...".to_string()));
        assert_eq!(
            indicator.status_message.as_deref(),
            Some("Reading files...")
        );

        indicator.set_status(None);
        assert!(indicator.status_message.is_none());
    }
}

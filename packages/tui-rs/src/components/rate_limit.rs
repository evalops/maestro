//! Rate Limit Display Component
//!
//! Displays API rate limit status with visual progress bars and reset times.
//! Similar to `OpenAI` Codex's rate limit display.
//!
//! # Features
//!
//! - Visual progress bars for quota usage
//! - Color-coded warnings (green → yellow → red)
//! - Reset time countdown
//! - Multiple rate limit windows (primary, secondary)
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::components::{RateLimitDisplay, RateLimitWindow};
//!
//! let display = RateLimitDisplay::new()
//!     .with_primary(RateLimitWindow::new(0.45, Some(300))) // 45% used, resets in 5min
//!     .with_secondary(RateLimitWindow::new(0.20, Some(3600))); // 20% used, resets in 1hr
//!
//! // Render in your UI
//! display.render(frame, area);
//! ```

use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Gauge, Paragraph, Widget},
};
use std::time::{Duration, Instant};

/// A single rate limit window
#[derive(Debug, Clone)]
pub struct RateLimitWindow {
    /// Percentage of limit used (0.0 - 1.0)
    pub used_percent: f64,
    /// Seconds until reset (if known)
    pub resets_in_secs: Option<u64>,
    /// Window duration in minutes (if known)
    pub window_minutes: Option<u64>,
    /// Label for this window
    pub label: Option<String>,
}

impl RateLimitWindow {
    /// Create a new rate limit window
    #[must_use]
    pub fn new(used_percent: f64, resets_in_secs: Option<u64>) -> Self {
        Self {
            used_percent: used_percent.clamp(0.0, 1.0),
            resets_in_secs,
            window_minutes: None,
            label: None,
        }
    }

    /// Set the window duration
    #[must_use]
    pub fn with_window(mut self, minutes: u64) -> Self {
        self.window_minutes = Some(minutes);
        self
    }

    /// Set a custom label
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Get the color based on usage
    #[must_use]
    pub fn color(&self) -> Color {
        let pct = self.used_percent * 100.0;
        if pct >= 90.0 {
            Color::Red
        } else if pct >= 75.0 {
            Color::LightRed
        } else if pct >= 50.0 {
            Color::Yellow
        } else {
            Color::Green
        }
    }

    /// Format reset time for display
    pub fn format_reset(&self) -> Option<String> {
        self.resets_in_secs.map(format_duration_compact)
    }
}

/// Format seconds into compact human-readable form
/// Examples: 59s, 1m 00s, 59m 59s, 1h 00m
#[must_use]
pub fn format_duration_compact(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        let minutes = secs / 60;
        let seconds = secs % 60;
        format!("{minutes}m {seconds:02}s")
    } else {
        let hours = secs / 3600;
        let minutes = (secs % 3600) / 60;
        format!("{hours}h {minutes:02}m")
    }
}

/// Format elapsed time with automatic unit selection
#[must_use]
pub fn format_elapsed(duration: Duration) -> String {
    format_duration_compact(duration.as_secs())
}

/// Rate limit data state
#[derive(Debug, Clone, Default)]
pub enum RateLimitState {
    /// Rate limit data is available
    Available {
        primary: Option<RateLimitWindow>,
        secondary: Option<RateLimitWindow>,
        captured_at: Instant,
    },
    /// Rate limit data is stale (older than threshold)
    Stale {
        primary: Option<RateLimitWindow>,
        secondary: Option<RateLimitWindow>,
        captured_at: Instant,
    },
    /// No rate limit data available
    #[default]
    Missing,
}

impl RateLimitState {
    /// Check if data is stale (older than 15 minutes)
    #[must_use]
    pub fn is_stale(&self) -> bool {
        matches!(self, RateLimitState::Stale { .. })
    }

    /// Check if data is available
    #[must_use]
    pub fn is_available(&self) -> bool {
        matches!(self, RateLimitState::Available { .. })
    }
}

/// Credits/balance display
#[derive(Debug, Clone)]
pub struct CreditsDisplay {
    /// Whether the account has credits
    pub has_credits: bool,
    /// Whether credits are unlimited
    pub unlimited: bool,
    /// Formatted balance string
    pub balance: Option<String>,
}

impl CreditsDisplay {
    /// Create a new credits display
    #[must_use]
    pub fn new(balance: Option<String>) -> Self {
        Self {
            has_credits: balance.is_some(),
            unlimited: false,
            balance,
        }
    }

    /// Mark as unlimited
    #[must_use]
    pub fn unlimited(mut self) -> Self {
        self.unlimited = true;
        self.has_credits = true;
        self
    }
}

/// Rate limit display widget
#[derive(Debug, Clone, Default)]
pub struct RateLimitDisplay {
    /// Primary rate limit window
    pub primary: Option<RateLimitWindow>,
    /// Secondary rate limit window
    pub secondary: Option<RateLimitWindow>,
    /// Credits/balance info
    pub credits: Option<CreditsDisplay>,
    /// Whether to show as compact
    pub compact: bool,
    /// Custom title
    pub title: Option<String>,
}

impl RateLimitDisplay {
    /// Create a new rate limit display
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the primary rate limit window
    #[must_use]
    pub fn with_primary(mut self, window: RateLimitWindow) -> Self {
        self.primary = Some(window);
        self
    }

    /// Set the secondary rate limit window
    #[must_use]
    pub fn with_secondary(mut self, window: RateLimitWindow) -> Self {
        self.secondary = Some(window);
        self
    }

    /// Set credits display
    #[must_use]
    pub fn with_credits(mut self, credits: CreditsDisplay) -> Self {
        self.credits = Some(credits);
        self
    }

    /// Enable compact mode
    #[must_use]
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// Set custom title
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Render a rate limit bar
    fn render_bar(label: &str, window: &RateLimitWindow, area: Rect, buf: &mut Buffer) {
        let pct = (window.used_percent * 100.0) as u16;
        let color = window.color();

        let reset_text = window
            .format_reset()
            .map(|r| format!(" (resets in {r})"))
            .unwrap_or_default();

        let gauge_label = format!("{:.0}%{}", window.used_percent * 100.0, reset_text);

        Gauge::default()
            .block(Block::default().title(format!(" {label} ")))
            .gauge_style(Style::default().fg(color))
            .percent(pct.min(100))
            .label(gauge_label)
            .render(area, buf);
    }

    /// Render compact single-line version
    fn render_compact(&self, area: Rect, buf: &mut Buffer) {
        let mut spans = Vec::new();

        if let Some(ref primary) = self.primary {
            let pct = primary.used_percent * 100.0;
            let color = primary.color();
            spans.push(Span::styled(
                format!("Rate: {pct:.0}%"),
                Style::default().fg(color),
            ));

            if let Some(reset) = primary.format_reset() {
                spans.push(Span::styled(
                    format!(" ({reset})"),
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }

        if let Some(ref credits) = self.credits {
            if !spans.is_empty() {
                spans.push(Span::raw(" │ "));
            }
            if credits.unlimited {
                spans.push(Span::styled(
                    "Credits: ∞",
                    Style::default().fg(Color::Green),
                ));
            } else if let Some(ref balance) = credits.balance {
                spans.push(Span::styled(
                    format!("Credits: {balance}"),
                    Style::default().fg(Color::Cyan),
                ));
            }
        }

        Paragraph::new(Line::from(spans)).render(area, buf);
    }

    /// Render full version with bars
    fn render_full(&self, area: Rect, buf: &mut Buffer) {
        let title = self.title.as_deref().unwrap_or("Rate Limits");
        let block = Block::default()
            .borders(Borders::ALL)
            .title(format!(" {title} "));

        let inner = block.inner(area);
        block.render(area, buf);

        // Calculate layout
        let mut y = inner.y;
        let bar_height = 3u16;

        // Primary window
        if let Some(ref primary) = self.primary {
            if y + bar_height <= inner.y + inner.height {
                let bar_area = Rect::new(inner.x, y, inner.width, bar_height);
                let label = primary.label.as_deref().unwrap_or("Requests");
                Self::render_bar(label, primary, bar_area, buf);
                y += bar_height;
            }
        }

        // Secondary window
        if let Some(ref secondary) = self.secondary {
            if y + bar_height <= inner.y + inner.height {
                let bar_area = Rect::new(inner.x, y, inner.width, bar_height);
                let label = secondary.label.as_deref().unwrap_or("Tokens");
                Self::render_bar(label, secondary, bar_area, buf);
                y += bar_height;
            }
        }

        // Credits line
        if let Some(ref credits) = self.credits {
            if y < inner.y + inner.height {
                let credits_area = Rect::new(inner.x, y, inner.width, 1);
                let text = if credits.unlimited {
                    Span::styled("Credits: Unlimited", Style::default().fg(Color::Green))
                } else if let Some(ref balance) = credits.balance {
                    Span::styled(
                        format!("Credits: {balance}"),
                        Style::default().fg(Color::Cyan),
                    )
                } else {
                    Span::styled("Credits: Unknown", Style::default().fg(Color::DarkGray))
                };
                Paragraph::new(Line::from(vec![Span::raw(" "), text])).render(credits_area, buf);
            }
        }
    }
}

impl Widget for RateLimitDisplay {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if self.compact {
            self.render_compact(area, buf);
        } else {
            self.render_full(area, buf);
        }
    }
}

/// Rate limit tracker for managing state
#[derive(Debug, Default)]
pub struct RateLimitTracker {
    /// Current state
    pub state: RateLimitState,
    /// Stale threshold in seconds
    pub stale_threshold_secs: u64,
}

impl RateLimitTracker {
    /// Create a new tracker with default 15-minute stale threshold
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: RateLimitState::Missing,
            stale_threshold_secs: 15 * 60,
        }
    }

    /// Update with new rate limit data
    pub fn update(&mut self, primary: Option<RateLimitWindow>, secondary: Option<RateLimitWindow>) {
        self.state = RateLimitState::Available {
            primary,
            secondary,
            captured_at: Instant::now(),
        };
    }

    /// Check and mark as stale if needed
    pub fn check_stale(&mut self) {
        if let RateLimitState::Available {
            primary,
            secondary,
            captured_at,
        } = &self.state
        {
            if captured_at.elapsed().as_secs() > self.stale_threshold_secs {
                self.state = RateLimitState::Stale {
                    primary: primary.clone(),
                    secondary: secondary.clone(),
                    captured_at: *captured_at,
                };
            }
        }
    }

    /// Get a display widget for the current state
    #[must_use]
    pub fn display(&self) -> RateLimitDisplay {
        match &self.state {
            RateLimitState::Available {
                primary, secondary, ..
            }
            | RateLimitState::Stale {
                primary, secondary, ..
            } => {
                let mut display = RateLimitDisplay::new();
                if let Some(p) = primary {
                    display = display.with_primary(p.clone());
                }
                if let Some(s) = secondary {
                    display = display.with_secondary(s.clone());
                }
                display
            }
            RateLimitState::Missing => RateLimitDisplay::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_duration_compact() {
        assert_eq!(format_duration_compact(0), "0s");
        assert_eq!(format_duration_compact(59), "59s");
        assert_eq!(format_duration_compact(60), "1m 00s");
        assert_eq!(format_duration_compact(61), "1m 01s");
        assert_eq!(format_duration_compact(3599), "59m 59s");
        assert_eq!(format_duration_compact(3600), "1h 00m");
        assert_eq!(format_duration_compact(3661), "1h 01m");
        assert_eq!(format_duration_compact(7200), "2h 00m");
    }

    #[test]
    fn test_rate_limit_window_color() {
        assert_eq!(RateLimitWindow::new(0.25, None).color(), Color::Green);
        assert_eq!(RateLimitWindow::new(0.50, None).color(), Color::Yellow);
        assert_eq!(RateLimitWindow::new(0.75, None).color(), Color::LightRed);
        assert_eq!(RateLimitWindow::new(0.95, None).color(), Color::Red);
    }

    #[test]
    fn test_rate_limit_window_format_reset() {
        let window = RateLimitWindow::new(0.5, Some(300));
        assert_eq!(window.format_reset(), Some("5m 00s".to_string()));

        let window_no_reset = RateLimitWindow::new(0.5, None);
        assert!(window_no_reset.format_reset().is_none());
    }

    #[test]
    fn test_rate_limit_display_builder() {
        let display = RateLimitDisplay::new()
            .with_primary(RateLimitWindow::new(0.5, Some(300)))
            .with_secondary(RateLimitWindow::new(0.3, None))
            .with_credits(CreditsDisplay::new(Some("$10.00".to_string())))
            .compact();

        assert!(display.primary.is_some());
        assert!(display.secondary.is_some());
        assert!(display.credits.is_some());
        assert!(display.compact);
    }

    #[test]
    fn test_rate_limit_tracker_update() {
        let mut tracker = RateLimitTracker::new();
        assert!(matches!(tracker.state, RateLimitState::Missing));

        tracker.update(Some(RateLimitWindow::new(0.5, None)), None);
        assert!(tracker.state.is_available());
    }

    #[test]
    fn test_credits_display() {
        let credits = CreditsDisplay::new(Some("$5.00".to_string()));
        assert!(credits.has_credits);
        assert!(!credits.unlimited);

        let unlimited = CreditsDisplay::new(None).unlimited();
        assert!(unlimited.unlimited);
        assert!(unlimited.has_credits);
    }

    #[test]
    fn test_format_elapsed() {
        assert_eq!(format_elapsed(Duration::from_secs(30)), "30s");
        assert_eq!(format_elapsed(Duration::from_secs(90)), "1m 30s");
        assert_eq!(format_elapsed(Duration::from_secs(3700)), "1h 01m");
    }
}

//! Context Window Indicator Component
//!
//! Displays the current context window usage as a visual indicator.
//! Shows percentage of context used and provides warnings when approaching limits.
//!
//! # Features
//!
//! - Visual progress bar showing context usage
//! - Color-coded warnings (green → yellow → red)
//! - Token counts in human-readable format
//! - Model context window awareness
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::components::ContextIndicator;
//!
//! let indicator = ContextIndicator::new()
//!     .with_context_window(200_000)
//!     .with_usage(45_000, 15_000);
//!
//! // In your render function:
//! indicator.render(frame, area);
//! ```

use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Gauge, Paragraph, Widget},
};

/// Context window usage levels for color coding
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageLevel {
    /// Below 50% - safe
    Low,
    /// 50-75% - approaching limit
    Medium,
    /// 75-90% - warning
    High,
    /// Above 90% - critical
    Critical,
}

impl UsageLevel {
    /// Determine usage level from percentage
    #[must_use]
    pub fn from_percentage(pct: f64) -> Self {
        if pct >= 90.0 {
            Self::Critical
        } else if pct >= 75.0 {
            Self::High
        } else if pct >= 50.0 {
            Self::Medium
        } else {
            Self::Low
        }
    }

    /// Get the color for this usage level
    #[must_use]
    pub fn color(&self) -> Color {
        match self {
            Self::Low => Color::Green,
            Self::Medium => Color::Yellow,
            Self::High => Color::LightRed,
            Self::Critical => Color::Red,
        }
    }

    /// Get a label for this usage level
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Low => "OK",
            Self::Medium => "Moderate",
            Self::High => "High",
            Self::Critical => "Critical",
        }
    }
}

/// Context window indicator showing usage and remaining capacity
#[derive(Debug, Clone)]
pub struct ContextIndicator {
    /// Total context window size (in tokens)
    pub context_window: u64,
    /// Input tokens used
    pub input_tokens: u64,
    /// Output tokens used
    pub output_tokens: u64,
    /// Cache read tokens (counts against context but may be cheaper)
    pub cache_tokens: u64,
    /// Model name for display
    pub model_name: Option<String>,
    /// Whether to show detailed breakdown
    pub show_details: bool,
    /// Whether to show as a compact single-line
    pub compact: bool,
}

impl Default for ContextIndicator {
    fn default() -> Self {
        Self {
            context_window: 200_000, // Default Claude context
            input_tokens: 0,
            output_tokens: 0,
            cache_tokens: 0,
            model_name: None,
            show_details: false,
            compact: false,
        }
    }
}

impl ContextIndicator {
    /// Create a new context indicator
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the context window size
    #[must_use]
    pub fn with_context_window(mut self, tokens: u64) -> Self {
        self.context_window = tokens;
        self
    }

    /// Set token usage
    #[must_use]
    pub fn with_usage(mut self, input: u64, output: u64) -> Self {
        self.input_tokens = input;
        self.output_tokens = output;
        self
    }

    /// Set cache tokens
    #[must_use]
    pub fn with_cache(mut self, cache: u64) -> Self {
        self.cache_tokens = cache;
        self
    }

    /// Set the model name
    pub fn with_model(mut self, name: impl Into<String>) -> Self {
        self.model_name = Some(name.into());
        self
    }

    /// Enable detailed breakdown
    #[must_use]
    pub fn detailed(mut self) -> Self {
        self.show_details = true;
        self
    }

    /// Enable compact mode
    #[must_use]
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// Get total tokens used
    #[must_use]
    pub fn total_used(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    /// Get tokens remaining
    #[must_use]
    pub fn remaining(&self) -> u64 {
        self.context_window.saturating_sub(self.total_used())
    }

    /// Get usage percentage
    #[must_use]
    pub fn percentage(&self) -> f64 {
        if self.context_window == 0 {
            return 0.0;
        }
        (self.total_used() as f64 / self.context_window as f64) * 100.0
    }

    /// Get the usage level
    #[must_use]
    pub fn level(&self) -> UsageLevel {
        UsageLevel::from_percentage(self.percentage())
    }

    /// Format tokens for display
    fn format_tokens(tokens: u64) -> String {
        if tokens >= 1_000_000 {
            format!("{:.1}M", tokens as f64 / 1_000_000.0)
        } else if tokens >= 1_000 {
            format!("{:.1}K", tokens as f64 / 1_000.0)
        } else {
            tokens.to_string()
        }
    }

    /// Render as a compact single-line widget
    fn render_compact(&self, area: Rect, buf: &mut Buffer) {
        let pct = self.percentage();
        let level = self.level();

        let label = format!(
            "Context: {} / {} ({:.0}%)",
            Self::format_tokens(self.total_used()),
            Self::format_tokens(self.context_window),
            pct
        );

        let style = Style::default().fg(level.color());
        Paragraph::new(label).style(style).render(area, buf);
    }

    /// Render as a full gauge widget
    fn render_full(&self, area: Rect, buf: &mut Buffer) {
        let pct = self.percentage();
        let level = self.level();

        let label = if self.show_details {
            format!(
                "{} / {} ({:.0}%) - {} in, {} out",
                Self::format_tokens(self.total_used()),
                Self::format_tokens(self.context_window),
                pct,
                Self::format_tokens(self.input_tokens),
                Self::format_tokens(self.output_tokens),
            )
        } else {
            format!(
                "{} / {} ({:.0}%)",
                Self::format_tokens(self.total_used()),
                Self::format_tokens(self.context_window),
                pct
            )
        };

        let title = match &self.model_name {
            Some(name) => format!(" Context: {name} "),
            None => " Context Window ".to_string(),
        };

        Gauge::default()
            .block(Block::default().borders(Borders::ALL).title(title))
            .gauge_style(Style::default().fg(level.color()))
            .percent((pct.min(100.0)) as u16)
            .label(label)
            .render(area, buf);
    }
}

impl Widget for ContextIndicator {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if self.compact {
            self.render_compact(area, buf);
        } else {
            self.render_full(area, buf);
        }
    }
}

/// Builder for creating context indicators with model presets
pub struct ContextIndicatorBuilder {
    indicator: ContextIndicator,
}

impl ContextIndicatorBuilder {
    /// Create a new builder
    #[must_use]
    pub fn new() -> Self {
        Self {
            indicator: ContextIndicator::default(),
        }
    }

    /// Set context window for Claude models
    #[must_use]
    pub fn claude_opus(mut self) -> Self {
        self.indicator.context_window = 200_000;
        self.indicator.model_name = Some("Claude Opus".to_string());
        self
    }

    /// Set context window for Claude Sonnet
    #[must_use]
    pub fn claude_sonnet(mut self) -> Self {
        self.indicator.context_window = 200_000;
        self.indicator.model_name = Some("Claude Sonnet".to_string());
        self
    }

    /// Set context window for Claude Haiku
    #[must_use]
    pub fn claude_haiku(mut self) -> Self {
        self.indicator.context_window = 200_000;
        self.indicator.model_name = Some("Claude Haiku".to_string());
        self
    }

    /// Set context window for GPT-4
    #[must_use]
    pub fn gpt4(mut self) -> Self {
        self.indicator.context_window = 128_000;
        self.indicator.model_name = Some("GPT-4".to_string());
        self
    }

    /// Set context window for GPT-4o
    #[must_use]
    pub fn gpt4o(mut self) -> Self {
        self.indicator.context_window = 128_000;
        self.indicator.model_name = Some("GPT-4o".to_string());
        self
    }

    /// Set context window for Gemini Pro
    #[must_use]
    pub fn gemini_pro(mut self) -> Self {
        self.indicator.context_window = 1_000_000;
        self.indicator.model_name = Some("Gemini Pro".to_string());
        self
    }

    /// Set custom context window
    #[must_use]
    pub fn custom(mut self, window: u64, name: Option<String>) -> Self {
        self.indicator.context_window = window;
        self.indicator.model_name = name;
        self
    }

    /// Set token usage
    #[must_use]
    pub fn usage(mut self, input: u64, output: u64) -> Self {
        self.indicator.input_tokens = input;
        self.indicator.output_tokens = output;
        self
    }

    /// Enable details
    #[must_use]
    pub fn detailed(mut self) -> Self {
        self.indicator.show_details = true;
        self
    }

    /// Enable compact mode
    #[must_use]
    pub fn compact(mut self) -> Self {
        self.indicator.compact = true;
        self
    }

    /// Build the indicator
    #[must_use]
    pub fn build(self) -> ContextIndicator {
        self.indicator
    }
}

impl Default for ContextIndicatorBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_usage_level_from_percentage() {
        assert_eq!(UsageLevel::from_percentage(25.0), UsageLevel::Low);
        assert_eq!(UsageLevel::from_percentage(50.0), UsageLevel::Medium);
        assert_eq!(UsageLevel::from_percentage(75.0), UsageLevel::High);
        assert_eq!(UsageLevel::from_percentage(90.0), UsageLevel::Critical);
        assert_eq!(UsageLevel::from_percentage(100.0), UsageLevel::Critical);
    }

    #[test]
    fn test_usage_level_color() {
        assert_eq!(UsageLevel::Low.color(), Color::Green);
        assert_eq!(UsageLevel::Critical.color(), Color::Red);
    }

    #[test]
    fn test_context_indicator_percentage() {
        let indicator = ContextIndicator::new()
            .with_context_window(100_000)
            .with_usage(25_000, 25_000);

        assert!((indicator.percentage() - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_context_indicator_remaining() {
        let indicator = ContextIndicator::new()
            .with_context_window(100_000)
            .with_usage(30_000, 20_000);

        assert_eq!(indicator.remaining(), 50_000);
    }

    #[test]
    fn test_format_tokens() {
        assert_eq!(ContextIndicator::format_tokens(500), "500");
        assert_eq!(ContextIndicator::format_tokens(1_500), "1.5K");
        assert_eq!(ContextIndicator::format_tokens(1_500_000), "1.5M");
    }

    #[test]
    fn test_builder_claude_sonnet() {
        let indicator = ContextIndicatorBuilder::new()
            .claude_sonnet()
            .usage(10_000, 5_000)
            .build();

        assert_eq!(indicator.context_window, 200_000);
        assert_eq!(indicator.total_used(), 15_000);
    }

    #[test]
    fn test_builder_gpt4() {
        let indicator = ContextIndicatorBuilder::new().gpt4().build();

        assert_eq!(indicator.context_window, 128_000);
    }

    #[test]
    fn test_total_used() {
        let indicator = ContextIndicator::new().with_usage(10_000, 5_000);
        assert_eq!(indicator.total_used(), 15_000);
    }

    #[test]
    fn test_level() {
        let low = ContextIndicator::new()
            .with_context_window(100_000)
            .with_usage(10_000, 10_000);
        assert_eq!(low.level(), UsageLevel::Low);

        let high = ContextIndicator::new()
            .with_context_window(100_000)
            .with_usage(40_000, 40_000);
        assert_eq!(high.level(), UsageLevel::High);
    }
}

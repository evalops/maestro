//! Extended Thinking UI Indicator Component
//!
//! Displays visual feedback when the model is engaged in extended thinking mode.
//! Shows animated indicators, elapsed time, and thinking budget information.
//!
//! # Features
//!
//! - Animated thinking spinner/pulse
//! - Elapsed time display
//! - Token budget progress bar
//! - Thinking phase labels (analyzing, reasoning, synthesizing)
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::components::{ThinkingIndicator, ThinkingPhase};
//!
//! let indicator = ThinkingIndicator::new()
//!     .with_budget(16_000)
//!     .with_used(4_500)
//!     .with_phase(ThinkingPhase::Reasoning);
//!
//! // In your render function:
//! indicator.render(frame, area);
//! ```

use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Gauge, Paragraph, Widget},
};
use std::time::{Duration, Instant};

/// Phases of extended thinking
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingPhase {
    /// Initial analysis of the problem
    #[default]
    Analyzing,
    /// Deep reasoning and exploration
    Reasoning,
    /// Synthesizing conclusions
    Synthesizing,
    /// Verifying the solution
    Verifying,
    /// Completed thinking
    Complete,
}

impl ThinkingPhase {
    /// Get a human-readable label for the phase
    pub fn label(&self) -> &'static str {
        match self {
            Self::Analyzing => "Analyzing",
            Self::Reasoning => "Reasoning",
            Self::Synthesizing => "Synthesizing",
            Self::Verifying => "Verifying",
            Self::Complete => "Complete",
        }
    }

    /// Get the color for this phase
    pub fn color(&self) -> Color {
        match self {
            Self::Analyzing => Color::Cyan,
            Self::Reasoning => Color::Yellow,
            Self::Synthesizing => Color::Magenta,
            Self::Verifying => Color::Blue,
            Self::Complete => Color::Green,
        }
    }

    /// Get the spinner frames for this phase
    pub fn spinner_frames(&self) -> &'static [&'static str] {
        match self {
            Self::Analyzing => &["◐", "◓", "◑", "◒"],
            Self::Reasoning => &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
            Self::Synthesizing => &[
                "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂",
            ],
            Self::Verifying => &["◇", "◈", "◆", "◈"],
            Self::Complete => &["✓"],
        }
    }
}

/// Thinking indicator display modes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingDisplayMode {
    /// Compact single-line display
    #[default]
    Compact,
    /// Full display with progress bar
    Full,
    /// Minimal spinner only
    Minimal,
}

/// Extended thinking indicator widget
#[derive(Debug, Clone)]
pub struct ThinkingIndicator {
    /// Whether thinking is currently active
    pub active: bool,
    /// Current thinking phase
    pub phase: ThinkingPhase,
    /// Token budget for thinking (max tokens)
    pub budget: u32,
    /// Tokens used so far
    pub tokens_used: u32,
    /// When thinking started
    pub started_at: Option<Instant>,
    /// Current animation frame
    pub frame: usize,
    /// Display mode
    pub mode: ThinkingDisplayMode,
    /// Custom label override
    pub label: Option<String>,
    /// Whether to show elapsed time
    pub show_elapsed: bool,
    /// Whether to show token budget
    pub show_budget: bool,
}

impl Default for ThinkingIndicator {
    fn default() -> Self {
        Self {
            active: false,
            phase: ThinkingPhase::default(),
            budget: 16_000, // Default Claude thinking budget
            tokens_used: 0,
            started_at: None,
            frame: 0,
            mode: ThinkingDisplayMode::default(),
            label: None,
            show_elapsed: true,
            show_budget: true,
        }
    }
}

impl ThinkingIndicator {
    /// Create a new thinking indicator
    pub fn new() -> Self {
        Self::default()
    }

    /// Start thinking mode
    pub fn start(mut self) -> Self {
        self.active = true;
        self.started_at = Some(Instant::now());
        self.phase = ThinkingPhase::Analyzing;
        self.tokens_used = 0;
        self.frame = 0;
        self
    }

    /// Stop thinking mode
    pub fn stop(mut self) -> Self {
        self.active = false;
        self.phase = ThinkingPhase::Complete;
        self
    }

    /// Set the thinking budget
    pub fn with_budget(mut self, tokens: u32) -> Self {
        self.budget = tokens;
        self
    }

    /// Set tokens used
    pub fn with_used(mut self, tokens: u32) -> Self {
        self.tokens_used = tokens;
        self
    }

    /// Set the current phase
    pub fn with_phase(mut self, phase: ThinkingPhase) -> Self {
        self.phase = phase;
        self
    }

    /// Set display mode
    pub fn with_mode(mut self, mode: ThinkingDisplayMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set a custom label
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Enable/disable elapsed time display
    pub fn show_elapsed(mut self, show: bool) -> Self {
        self.show_elapsed = show;
        self
    }

    /// Enable/disable budget display
    pub fn show_budget(mut self, show: bool) -> Self {
        self.show_budget = show;
        self
    }

    /// Advance the animation frame
    pub fn tick(&mut self) {
        let frames = self.phase.spinner_frames();
        self.frame = (self.frame + 1) % frames.len();
    }

    /// Get the current spinner character
    pub fn spinner(&self) -> &'static str {
        let frames = self.phase.spinner_frames();
        frames[self.frame % frames.len()]
    }

    /// Get elapsed time since thinking started
    pub fn elapsed(&self) -> Duration {
        self.started_at
            .map(|start| start.elapsed())
            .unwrap_or_default()
    }

    /// Get budget usage as percentage
    pub fn budget_percentage(&self) -> f64 {
        if self.budget == 0 {
            return 0.0;
        }
        (self.tokens_used as f64 / self.budget as f64) * 100.0
    }

    /// Format elapsed time for display
    fn format_elapsed(&self) -> String {
        let elapsed = self.elapsed();
        let secs = elapsed.as_secs();
        if secs >= 60 {
            format!("{}m {}s", secs / 60, secs % 60)
        } else if secs > 0 {
            format!("{}s", secs)
        } else {
            format!("{}ms", elapsed.as_millis())
        }
    }

    /// Format tokens for display
    fn format_tokens(tokens: u32) -> String {
        if tokens >= 1_000 {
            format!("{:.1}K", tokens as f64 / 1_000.0)
        } else {
            tokens.to_string()
        }
    }

    /// Render minimal mode (spinner only)
    fn render_minimal(&self, area: Rect, buf: &mut Buffer) {
        if !self.active {
            return;
        }

        let spinner = self.spinner();
        let style = Style::default().fg(self.phase.color());

        buf.set_string(area.x, area.y, spinner, style);
    }

    /// Render compact mode (single line)
    fn render_compact(&self, area: Rect, buf: &mut Buffer) {
        if !self.active && self.phase != ThinkingPhase::Complete {
            return;
        }

        let spinner = self.spinner();
        let label = self.label.as_deref().unwrap_or(self.phase.label());
        let color = self.phase.color();

        let mut parts = vec![
            Span::styled(format!("{} ", spinner), Style::default().fg(color)),
            Span::styled(
                label,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
        ];

        if self.show_elapsed && self.active {
            parts.push(Span::raw(" "));
            parts.push(Span::styled(
                format!("({})", self.format_elapsed()),
                Style::default().fg(Color::DarkGray),
            ));
        }

        if self.show_budget && self.tokens_used > 0 {
            parts.push(Span::raw(" "));
            parts.push(Span::styled(
                format!(
                    "[{}/{}]",
                    Self::format_tokens(self.tokens_used),
                    Self::format_tokens(self.budget)
                ),
                Style::default().fg(Color::DarkGray),
            ));
        }

        let line = Line::from(parts);
        Paragraph::new(line).render(area, buf);
    }

    /// Render full mode (with progress bar)
    fn render_full(&self, area: Rect, buf: &mut Buffer) {
        if area.height < 3 {
            // Fall back to compact if not enough space
            self.render_compact(area, buf);
            return;
        }

        let spinner = self.spinner();
        let label = self.label.as_deref().unwrap_or(self.phase.label());
        let color = self.phase.color();

        // Title with spinner and phase
        let title = format!(" {} Extended Thinking: {} ", spinner, label);

        // Budget info for gauge label
        let gauge_label = if self.show_elapsed {
            format!(
                "{} / {} ({:.0}%) - {}",
                Self::format_tokens(self.tokens_used),
                Self::format_tokens(self.budget),
                self.budget_percentage(),
                self.format_elapsed()
            )
        } else {
            format!(
                "{} / {} ({:.0}%)",
                Self::format_tokens(self.tokens_used),
                Self::format_tokens(self.budget),
                self.budget_percentage()
            )
        };

        Gauge::default()
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(title)
                    .title_style(Style::default().fg(color).add_modifier(Modifier::BOLD)),
            )
            .gauge_style(Style::default().fg(color))
            .percent((self.budget_percentage().min(100.0)) as u16)
            .label(gauge_label)
            .render(area, buf);
    }
}

impl Widget for ThinkingIndicator {
    fn render(self, area: Rect, buf: &mut Buffer) {
        match self.mode {
            ThinkingDisplayMode::Minimal => self.render_minimal(area, buf),
            ThinkingDisplayMode::Compact => self.render_compact(area, buf),
            ThinkingDisplayMode::Full => self.render_full(area, buf),
        }
    }
}

/// Builder for creating thinking indicators
#[derive(Debug, Default)]
pub struct ThinkingIndicatorBuilder {
    indicator: ThinkingIndicator,
}

impl ThinkingIndicatorBuilder {
    /// Create a new builder
    pub fn new() -> Self {
        Self::default()
    }

    /// Set as active/started
    pub fn active(mut self) -> Self {
        self.indicator.active = true;
        self.indicator.started_at = Some(Instant::now());
        self
    }

    /// Set the phase
    pub fn phase(mut self, phase: ThinkingPhase) -> Self {
        self.indicator.phase = phase;
        self
    }

    /// Set the token budget
    pub fn budget(mut self, tokens: u32) -> Self {
        self.indicator.budget = tokens;
        self
    }

    /// Set tokens used
    pub fn used(mut self, tokens: u32) -> Self {
        self.indicator.tokens_used = tokens;
        self
    }

    /// Set display mode
    pub fn mode(mut self, mode: ThinkingDisplayMode) -> Self {
        self.indicator.mode = mode;
        self
    }

    /// Set compact mode
    pub fn compact(mut self) -> Self {
        self.indicator.mode = ThinkingDisplayMode::Compact;
        self
    }

    /// Set full mode
    pub fn full(mut self) -> Self {
        self.indicator.mode = ThinkingDisplayMode::Full;
        self
    }

    /// Set minimal mode
    pub fn minimal(mut self) -> Self {
        self.indicator.mode = ThinkingDisplayMode::Minimal;
        self
    }

    /// Build the indicator
    pub fn build(self) -> ThinkingIndicator {
        self.indicator
    }
}

/// State manager for thinking indicator animations
#[derive(Debug)]
pub struct ThinkingState {
    /// The indicator
    pub indicator: ThinkingIndicator,
    /// Animation tick interval
    pub tick_interval: Duration,
    /// Last tick time
    pub last_tick: Instant,
}

impl Default for ThinkingState {
    fn default() -> Self {
        Self {
            indicator: ThinkingIndicator::default(),
            tick_interval: Duration::from_millis(100),
            last_tick: Instant::now(),
        }
    }
}

impl ThinkingState {
    /// Create a new thinking state
    pub fn new() -> Self {
        Self::default()
    }

    /// Start thinking mode
    pub fn start(&mut self) {
        self.indicator.active = true;
        self.indicator.started_at = Some(Instant::now());
        self.indicator.phase = ThinkingPhase::Analyzing;
        self.indicator.tokens_used = 0;
        self.indicator.frame = 0;
        self.last_tick = Instant::now();
    }

    /// Stop thinking mode
    pub fn stop(&mut self) {
        self.indicator.active = false;
        self.indicator.phase = ThinkingPhase::Complete;
    }

    /// Update phase based on progress
    pub fn update_phase(&mut self, tokens_used: u32) {
        self.indicator.tokens_used = tokens_used;

        // Auto-progress through phases based on budget usage
        let pct = self.indicator.budget_percentage();
        self.indicator.phase = if pct >= 90.0 {
            ThinkingPhase::Verifying
        } else if pct >= 60.0 {
            ThinkingPhase::Synthesizing
        } else if pct >= 20.0 {
            ThinkingPhase::Reasoning
        } else {
            ThinkingPhase::Analyzing
        };
    }

    /// Check if animation should tick and advance if so
    pub fn maybe_tick(&mut self) -> bool {
        if !self.indicator.active {
            return false;
        }

        if self.last_tick.elapsed() >= self.tick_interval {
            self.indicator.tick();
            self.last_tick = Instant::now();
            true
        } else {
            false
        }
    }

    /// Get a reference to the indicator for rendering
    pub fn indicator(&self) -> &ThinkingIndicator {
        &self.indicator
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_phase_label() {
        assert_eq!(ThinkingPhase::Analyzing.label(), "Analyzing");
        assert_eq!(ThinkingPhase::Reasoning.label(), "Reasoning");
        assert_eq!(ThinkingPhase::Synthesizing.label(), "Synthesizing");
        assert_eq!(ThinkingPhase::Verifying.label(), "Verifying");
        assert_eq!(ThinkingPhase::Complete.label(), "Complete");
    }

    #[test]
    fn test_thinking_phase_color() {
        assert_eq!(ThinkingPhase::Analyzing.color(), Color::Cyan);
        assert_eq!(ThinkingPhase::Complete.color(), Color::Green);
    }

    #[test]
    fn test_thinking_phase_spinner() {
        let frames = ThinkingPhase::Analyzing.spinner_frames();
        assert!(!frames.is_empty());

        let complete_frames = ThinkingPhase::Complete.spinner_frames();
        assert_eq!(complete_frames, &["✓"]);
    }

    #[test]
    fn test_thinking_indicator_default() {
        let indicator = ThinkingIndicator::new();
        assert!(!indicator.active);
        assert_eq!(indicator.phase, ThinkingPhase::Analyzing);
        assert_eq!(indicator.budget, 16_000);
        assert_eq!(indicator.tokens_used, 0);
    }

    #[test]
    fn test_thinking_indicator_start_stop() {
        let indicator = ThinkingIndicator::new().start();
        assert!(indicator.active);
        assert!(indicator.started_at.is_some());

        let indicator = indicator.stop();
        assert!(!indicator.active);
        assert_eq!(indicator.phase, ThinkingPhase::Complete);
    }

    #[test]
    fn test_thinking_indicator_budget() {
        let indicator = ThinkingIndicator::new()
            .with_budget(32_000)
            .with_used(16_000);

        assert_eq!(indicator.budget, 32_000);
        assert_eq!(indicator.tokens_used, 16_000);
        assert!((indicator.budget_percentage() - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_thinking_indicator_tick() {
        let mut indicator = ThinkingIndicator::new();
        let initial_frame = indicator.frame;

        indicator.tick();
        assert_eq!(indicator.frame, initial_frame + 1);

        // Test wrapping
        indicator.frame = 3;
        indicator.tick(); // Analyzing has 4 frames
        assert_eq!(indicator.frame, 0);
    }

    #[test]
    fn test_thinking_indicator_spinner() {
        let indicator = ThinkingIndicator::new();
        let spinner = indicator.spinner();
        assert!(!spinner.is_empty());
    }

    #[test]
    fn test_format_tokens() {
        assert_eq!(ThinkingIndicator::format_tokens(500), "500");
        assert_eq!(ThinkingIndicator::format_tokens(1_500), "1.5K");
        assert_eq!(ThinkingIndicator::format_tokens(16_000), "16.0K");
    }

    #[test]
    fn test_builder() {
        let indicator = ThinkingIndicatorBuilder::new()
            .active()
            .phase(ThinkingPhase::Reasoning)
            .budget(32_000)
            .used(8_000)
            .compact()
            .build();

        assert!(indicator.active);
        assert_eq!(indicator.phase, ThinkingPhase::Reasoning);
        assert_eq!(indicator.budget, 32_000);
        assert_eq!(indicator.tokens_used, 8_000);
        assert_eq!(indicator.mode, ThinkingDisplayMode::Compact);
    }

    #[test]
    fn test_thinking_state() {
        let mut state = ThinkingState::new();
        assert!(!state.indicator.active);

        state.start();
        assert!(state.indicator.active);
        assert_eq!(state.indicator.phase, ThinkingPhase::Analyzing);

        state.update_phase(8_000); // 50% of 16K
        assert_eq!(state.indicator.phase, ThinkingPhase::Reasoning);

        state.update_phase(12_000); // 75%
        assert_eq!(state.indicator.phase, ThinkingPhase::Synthesizing);

        state.update_phase(15_000); // 93.75%
        assert_eq!(state.indicator.phase, ThinkingPhase::Verifying);

        state.stop();
        assert!(!state.indicator.active);
        assert_eq!(state.indicator.phase, ThinkingPhase::Complete);
    }

    #[test]
    fn test_display_modes() {
        let compact = ThinkingIndicator::new().with_mode(ThinkingDisplayMode::Compact);
        assert_eq!(compact.mode, ThinkingDisplayMode::Compact);

        let full = ThinkingIndicator::new().with_mode(ThinkingDisplayMode::Full);
        assert_eq!(full.mode, ThinkingDisplayMode::Full);

        let minimal = ThinkingIndicator::new().with_mode(ThinkingDisplayMode::Minimal);
        assert_eq!(minimal.mode, ThinkingDisplayMode::Minimal);
    }

    #[test]
    fn test_custom_label() {
        let indicator = ThinkingIndicator::new().with_label("Deep thinking...");
        assert_eq!(indicator.label.as_deref(), Some("Deep thinking..."));
    }
}

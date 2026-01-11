//! Animated Loading Indicator
//!
//! Provides an animated loader with multiple spinner styles and progress modes.
//!
//! Features:
//! - Multiple spinner styles: braille, dots, pulse, line
//! - Determinate (percentage) and indeterminate progress
//! - Stage tracking (step X of Y)
//! - Hint text support
//! - Low-color and low-unicode fallback modes
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

// ─────────────────────────────────────────────────────────────────────────────
// SPINNER STYLES
// ─────────────────────────────────────────────────────────────────────────────

/// Available spinner animation styles.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SpinnerStyle {
    /// Braille dots animation (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
    #[default]
    Braille,
    /// Three dots animation (·  ·· ···  ·· ·)
    Dots,
    /// Pulsing diamond (◆◇◇◇)
    Pulse,
    /// Rotating line (|/-\)
    Line,
}

/// A single spinner frame with glyph and color.
#[derive(Debug, Clone, Copy)]
pub struct SpinnerFrame {
    pub glyph: &'static str,
    pub color: Color,
}

impl SpinnerStyle {
    /// Get the frames for this spinner style.
    #[must_use]
    pub fn frames(&self) -> &'static [SpinnerFrame] {
        match self {
            SpinnerStyle::Braille => &BRAILLE_FRAMES,
            SpinnerStyle::Dots => &DOTS_FRAMES,
            SpinnerStyle::Pulse => &PULSE_FRAMES,
            SpinnerStyle::Line => &LINE_FRAMES,
        }
    }

    /// Get ASCII fallback frames (for low-unicode terminals).
    #[must_use]
    pub fn ascii_frames(&self) -> &'static [SpinnerFrame] {
        &ASCII_FRAMES
    }

    /// Recommended frame duration for smooth animation.
    #[must_use]
    pub fn frame_duration(&self) -> Duration {
        match self {
            SpinnerStyle::Braille => Duration::from_millis(80),
            SpinnerStyle::Dots => Duration::from_millis(120),
            SpinnerStyle::Pulse => Duration::from_millis(200),
            SpinnerStyle::Line => Duration::from_millis(100),
        }
    }
}

// Spinner frame definitions
static BRAILLE_FRAMES: [SpinnerFrame; 10] = [
    SpinnerFrame {
        glyph: "⠋",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "⠙",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "⠹",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "⠸",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "⠼",
        color: Color::Rgb(196, 181, 253),
    },
    SpinnerFrame {
        glyph: "⠴",
        color: Color::Rgb(196, 181, 253),
    },
    SpinnerFrame {
        glyph: "⠦",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "⠧",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "⠇",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "⠏",
        color: Color::Rgb(125, 211, 252),
    },
];

static DOTS_FRAMES: [SpinnerFrame; 6] = [
    SpinnerFrame {
        glyph: "·  ",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "·· ",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "···",
        color: Color::Rgb(196, 181, 253),
    },
    SpinnerFrame {
        glyph: " ··",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "  ·",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "   ",
        color: Color::Rgb(100, 116, 139),
    },
];

static PULSE_FRAMES: [SpinnerFrame; 4] = [
    SpinnerFrame {
        glyph: "◆",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "◇",
        color: Color::Rgb(100, 116, 139),
    },
    SpinnerFrame {
        glyph: "◇",
        color: Color::Rgb(100, 116, 139),
    },
    SpinnerFrame {
        glyph: "◇",
        color: Color::Rgb(100, 116, 139),
    },
];

static LINE_FRAMES: [SpinnerFrame; 4] = [
    SpinnerFrame {
        glyph: "|",
        color: Color::Rgb(125, 211, 252),
    },
    SpinnerFrame {
        glyph: "/",
        color: Color::Rgb(147, 197, 253),
    },
    SpinnerFrame {
        glyph: "-",
        color: Color::Rgb(196, 181, 253),
    },
    SpinnerFrame {
        glyph: "\\",
        color: Color::Rgb(147, 197, 253),
    },
];

static ASCII_FRAMES: [SpinnerFrame; 4] = [
    SpinnerFrame {
        glyph: "-",
        color: Color::Cyan,
    },
    SpinnerFrame {
        glyph: "\\",
        color: Color::Cyan,
    },
    SpinnerFrame {
        glyph: "|",
        color: Color::Cyan,
    },
    SpinnerFrame {
        glyph: "/",
        color: Color::Cyan,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESS BAR
// ─────────────────────────────────────────────────────────────────────────────

/// Progress bar style.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProgressBarStyle {
    /// Character for filled portion.
    pub filled: char,
    /// Character for empty portion.
    pub empty: char,
    /// Left bracket character.
    pub left_bracket: char,
    /// Right bracket character.
    pub right_bracket: char,
    /// Color for filled portion.
    pub filled_color: Color,
    /// Color for empty portion.
    pub empty_color: Color,
}

impl ProgressBarStyle {
    /// Unicode style (default).
    pub const UNICODE: Self = Self {
        filled: '━',
        empty: '─',
        left_bracket: '[',
        right_bracket: ']',
        filled_color: Color::Rgb(125, 211, 252),
        empty_color: Color::Rgb(100, 116, 139),
    };

    /// ASCII fallback style.
    pub const ASCII: Self = Self {
        filled: '=',
        empty: '-',
        left_bracket: '[',
        right_bracket: ']',
        filled_color: Color::Cyan,
        empty_color: Color::DarkGray,
    };

    /// Render a progress bar.
    #[must_use]
    pub fn render(&self, percent: f32, width: usize) -> Line<'static> {
        let percent = percent.clamp(0.0, 1.0);
        let inner_width = width.saturating_sub(2); // brackets
        let filled_count = ((inner_width as f32) * percent).round() as usize;
        let empty_count = inner_width.saturating_sub(filled_count);

        let filled_str: String = std::iter::repeat_n(self.filled, filled_count).collect();
        let empty_str: String = std::iter::repeat_n(self.empty, empty_count).collect();

        Line::from(vec![
            Span::styled(
                self.left_bracket.to_string(),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(filled_str, Style::default().fg(self.filled_color)),
            Span::styled(empty_str, Style::default().fg(self.empty_color)),
            Span::styled(
                self.right_bracket.to_string(),
                Style::default().fg(Color::DarkGray),
            ),
        ])
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADER
// ─────────────────────────────────────────────────────────────────────────────

/// Animated loading indicator with spinner and optional progress.
#[derive(Debug, Clone)]
pub struct Loader {
    /// Main message/title.
    message: String,
    /// Optional hint text.
    hint: Option<String>,
    /// Current step (1-indexed).
    current_step: Option<usize>,
    /// Total steps.
    total_steps: Option<usize>,
    /// Progress percentage (0.0-1.0), None for indeterminate.
    progress: Option<f32>,
    /// Spinner style.
    spinner_style: SpinnerStyle,
    /// Progress bar style.
    progress_style: ProgressBarStyle,
    /// Current frame index.
    frame_index: usize,
    /// Last frame update time.
    last_update: Instant,
    /// Whether to use low-unicode mode.
    low_unicode: bool,
    /// Whether to use low-color mode.
    low_color: bool,
    /// Width of the progress bar (in characters).
    progress_width: usize,
}

impl Default for Loader {
    fn default() -> Self {
        Self::new("Loading...")
    }
}

impl Loader {
    /// Create a new loader with a message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: None,
            current_step: None,
            total_steps: None,
            progress: None,
            spinner_style: SpinnerStyle::default(),
            progress_style: ProgressBarStyle::UNICODE,
            frame_index: 0,
            last_update: Instant::now(),
            low_unicode: false,
            low_color: false,
            progress_width: 20,
        }
    }

    /// Set the message.
    pub fn message(mut self, msg: impl Into<String>) -> Self {
        self.message = msg.into();
        self
    }

    /// Set the hint text.
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Clear the hint text.
    pub fn clear_hint(&mut self) {
        self.hint = None;
    }

    /// Set the current step (for "step X of Y" display).
    #[must_use]
    pub fn step(mut self, current: usize, total: usize) -> Self {
        self.current_step = Some(current);
        self.total_steps = Some(total);
        self
    }

    /// Update the current step.
    pub fn set_step(&mut self, current: usize) {
        self.current_step = Some(current);
    }

    /// Set determinate progress (0.0-1.0).
    #[must_use]
    pub fn progress(mut self, percent: f32) -> Self {
        self.progress = Some(percent.clamp(0.0, 1.0));
        self
    }

    /// Update progress.
    pub fn set_progress(&mut self, percent: f32) {
        self.progress = Some(percent.clamp(0.0, 1.0));
    }

    /// Clear progress (back to indeterminate).
    pub fn clear_progress(&mut self) {
        self.progress = None;
    }

    /// Set spinner style.
    #[must_use]
    pub fn spinner(mut self, style: SpinnerStyle) -> Self {
        self.spinner_style = style;
        self
    }

    /// Set progress bar width.
    #[must_use]
    pub fn progress_width(mut self, width: usize) -> Self {
        self.progress_width = width.max(5);
        self
    }

    /// Enable low-unicode mode (ASCII fallbacks).
    #[must_use]
    pub fn low_unicode(mut self, enabled: bool) -> Self {
        self.low_unicode = enabled;
        if enabled {
            self.progress_style = ProgressBarStyle::ASCII;
        }
        self
    }

    /// Enable low-color mode.
    #[must_use]
    pub fn low_color(mut self, enabled: bool) -> Self {
        self.low_color = enabled;
        self
    }

    /// Advance the animation frame if enough time has passed.
    ///
    /// Returns true if the frame changed (needs redraw).
    pub fn tick(&mut self) -> bool {
        let now = Instant::now();
        let duration = self.spinner_style.frame_duration();

        if now.duration_since(self.last_update) >= duration {
            let frames = if self.low_unicode {
                self.spinner_style.ascii_frames()
            } else {
                self.spinner_style.frames()
            };
            self.frame_index = (self.frame_index + 1) % frames.len();
            self.last_update = now;
            true
        } else {
            false
        }
    }

    /// Get the current spinner frame.
    #[must_use]
    pub fn current_frame(&self) -> SpinnerFrame {
        let frames = if self.low_unicode {
            self.spinner_style.ascii_frames()
        } else {
            self.spinner_style.frames()
        };
        frames[self.frame_index % frames.len()]
    }

    /// Render the loader to lines.
    #[must_use]
    pub fn render(&self) -> Vec<Line<'static>> {
        let mut lines = Vec::new();

        // Main line: [spinner] Message · step X/Y (hint)
        let frame = self.current_frame();
        let mut spans = vec![
            Span::styled(
                frame.glyph,
                if self.low_color {
                    Style::default().fg(Color::Cyan)
                } else {
                    Style::default().fg(frame.color)
                },
            ),
            Span::raw(" "),
            Span::styled(
                self.message.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
        ];

        // Add step info
        if let (Some(current), Some(total)) = (self.current_step, self.total_steps) {
            spans.push(Span::styled(" · ", Style::default().fg(Color::DarkGray)));
            spans.push(Span::styled(
                format!("step {current}/{total}"),
                Style::default().fg(Color::DarkGray),
            ));
        }

        // Add hint
        if let Some(ref hint) = self.hint {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                format!("({hint})"),
                Style::default().fg(Color::DarkGray),
            ));
        }

        lines.push(Line::from(spans));

        // Progress bar line (if determinate)
        if let Some(percent) = self.progress {
            let bar = self.progress_style.render(percent, self.progress_width);
            let percent_str = format!(" {}%", (percent * 100.0).round() as u8);

            let mut bar_spans = bar.spans;
            bar_spans.push(Span::styled(
                percent_str,
                Style::default().fg(Color::DarkGray),
            ));

            lines.push(Line::from(bar_spans));
        }

        lines
    }

    /// Complete the loader (static checkmark).
    #[must_use]
    pub fn complete(&self, message: Option<&str>) -> Line<'static> {
        let msg = message.unwrap_or(&self.message);
        Line::from(vec![
            Span::styled("✓", Style::default().fg(Color::Green)),
            Span::raw(" "),
            Span::styled(msg.to_string(), Style::default().fg(Color::Green)),
        ])
    }

    /// Fail the loader (static X mark).
    #[must_use]
    pub fn fail(&self, message: Option<&str>) -> Line<'static> {
        let msg = message.unwrap_or(&self.message);
        Line::from(vec![
            Span::styled("✗", Style::default().fg(Color::Red)),
            Span::raw(" "),
            Span::styled(msg.to_string(), Style::default().fg(Color::Red)),
        ])
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_renders_message() {
        let loader = Loader::new("Loading files");
        let lines = loader.render();
        assert!(!lines.is_empty());

        let content: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains("Loading files"));
    }

    #[test]
    fn loader_renders_steps() {
        let loader = Loader::new("Processing").step(2, 5);
        let lines = loader.render();

        let content: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains("step 2/5"));
    }

    #[test]
    fn loader_renders_progress() {
        let loader = Loader::new("Downloading").progress(0.42);
        let lines = loader.render();

        assert_eq!(lines.len(), 2); // Message + progress bar
        let bar_content: String = lines[1].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(bar_content.contains("42%"));
    }

    #[test]
    fn loader_tick_advances_frame() {
        let mut loader = Loader::new("Test");
        let initial_frame = loader.frame_index;

        // Force time advancement
        loader.last_update = Instant::now() - Duration::from_secs(1);
        assert!(loader.tick());
        assert_ne!(loader.frame_index, initial_frame);
    }

    #[test]
    fn spinner_styles_have_frames() {
        assert!(!SpinnerStyle::Braille.frames().is_empty());
        assert!(!SpinnerStyle::Dots.frames().is_empty());
        assert!(!SpinnerStyle::Pulse.frames().is_empty());
        assert!(!SpinnerStyle::Line.frames().is_empty());
    }

    #[test]
    fn progress_bar_renders() {
        let style = ProgressBarStyle::UNICODE;
        let line = style.render(0.5, 20);
        assert!(!line.spans.is_empty());
    }

    #[test]
    fn loader_complete_and_fail() {
        let loader = Loader::new("Operation");

        let complete = loader.complete(None);
        let content: String = complete.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains('✓'));

        let fail = loader.fail(Some("Error occurred"));
        let content: String = fail.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(content.contains('✗'));
        assert!(content.contains("Error occurred"));
    }

    #[test]
    fn low_unicode_fallback() {
        let loader = Loader::new("Test").low_unicode(true);
        let frame = loader.current_frame();
        // ASCII frames use simple characters
        assert!(frame.glyph.is_ascii());
    }
}

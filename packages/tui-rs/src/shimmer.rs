//! Shimmer Animation Effect
//!
//! Creates an animated shimmer effect for text, commonly used for loading
//! indicators and attention-grabbing headers.
//!
//! The shimmer is a wave of brightness that sweeps across the text,
//! creating a polished visual effect.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

use crate::color_utils::blend;

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS START TIME
// ─────────────────────────────────────────────────────────────────────────────

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Get the time elapsed since process start.
///
/// This ensures shimmer animations are synchronized across the application.
fn elapsed_since_start() -> Duration {
    let start = PROCESS_START.get_or_init(Instant::now);
    start.elapsed()
}

/// Reset the process start time (useful for testing).
#[cfg(test)]
pub fn reset_process_start() {
    // Can't reset OnceLock, but tests can work around this
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIMMER CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for the shimmer effect.
#[derive(Debug, Clone)]
pub struct ShimmerConfig {
    /// Base color for non-highlighted text.
    pub base_color: (u8, u8, u8),
    /// Highlight color for the shimmer peak.
    pub highlight_color: (u8, u8, u8),
    /// Duration of one complete sweep cycle in seconds.
    pub sweep_seconds: f32,
    /// Width of the shimmer band (in characters).
    pub band_half_width: f32,
    /// Padding before/after text for smooth entry/exit.
    pub padding: usize,
    /// Whether true color is supported.
    pub has_true_color: bool,
}

impl Default for ShimmerConfig {
    fn default() -> Self {
        Self {
            base_color: (128, 128, 128),
            highlight_color: (255, 255, 255),
            sweep_seconds: 2.0,
            band_half_width: 5.0,
            padding: 10,
            has_true_color: true,
        }
    }
}

impl ShimmerConfig {
    /// Create a config that automatically detects terminal capabilities.
    pub fn auto() -> Self {
        Self {
            has_true_color: crate::color_utils::has_true_color_support(),
            ..Default::default()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIMMER EFFECT
// ─────────────────────────────────────────────────────────────────────────────

/// Create shimmer spans for the given text.
///
/// Returns a vector of spans where each character has a style based on
/// its distance from the current shimmer position.
pub fn shimmer_spans(text: &str) -> Vec<Span<'static>> {
    shimmer_spans_with_config(text, &ShimmerConfig::auto())
}

/// Create shimmer spans with custom configuration.
pub fn shimmer_spans_with_config(text: &str, config: &ShimmerConfig) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    // Calculate current shimmer position based on time
    let period = chars.len() + config.padding * 2;
    let pos_f = (elapsed_since_start().as_secs_f32() % config.sweep_seconds) / config.sweep_seconds
        * (period as f32);
    let pos = pos_f as usize;

    let mut spans: Vec<Span<'static>> = Vec::with_capacity(chars.len());

    for (i, ch) in chars.iter().enumerate() {
        // Calculate distance from shimmer center
        let i_pos = i as isize + config.padding as isize;
        let pos_isize = pos as isize;
        let dist = (i_pos - pos_isize).abs() as f32;

        // Calculate intensity using cosine falloff
        let t = if dist <= config.band_half_width {
            let x = std::f32::consts::PI * (dist / config.band_half_width);
            0.5 * (1.0 + x.cos())
        } else {
            0.0
        };

        let style = if config.has_true_color {
            // Use smooth color blending
            let highlight = t.clamp(0.0, 1.0);
            let (r, g, b) = blend(config.highlight_color, config.base_color, highlight * 0.9);
            Style::default()
                .fg(Color::Rgb(r, g, b))
                .add_modifier(Modifier::BOLD)
        } else {
            // Fallback to modifier-based styling
            fallback_style_for_intensity(t)
        };

        spans.push(Span::styled(ch.to_string(), style));
    }

    spans
}

/// Create shimmer spans at a specific time offset.
///
/// Useful for testing or when you want to control the animation position.
pub fn shimmer_spans_at_time(text: &str, elapsed: Duration) -> Vec<Span<'static>> {
    let config = ShimmerConfig::auto();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let period = chars.len() + config.padding * 2;
    let pos_f =
        (elapsed.as_secs_f32() % config.sweep_seconds) / config.sweep_seconds * (period as f32);
    let pos = pos_f as usize;

    let mut spans: Vec<Span<'static>> = Vec::with_capacity(chars.len());

    for (i, ch) in chars.iter().enumerate() {
        let i_pos = i as isize + config.padding as isize;
        let pos_isize = pos as isize;
        let dist = (i_pos - pos_isize).abs() as f32;

        let t = if dist <= config.band_half_width {
            let x = std::f32::consts::PI * (dist / config.band_half_width);
            0.5 * (1.0 + x.cos())
        } else {
            0.0
        };

        let style = if config.has_true_color {
            let highlight = t.clamp(0.0, 1.0);
            let (r, g, b) = blend(config.highlight_color, config.base_color, highlight * 0.9);
            Style::default()
                .fg(Color::Rgb(r, g, b))
                .add_modifier(Modifier::BOLD)
        } else {
            fallback_style_for_intensity(t)
        };

        spans.push(Span::styled(ch.to_string(), style));
    }

    spans
}

/// Create a fallback style based on intensity when true color isn't available.
fn fallback_style_for_intensity(intensity: f32) -> Style {
    if intensity < 0.2 {
        Style::default().add_modifier(Modifier::DIM)
    } else if intensity < 0.6 {
        Style::default()
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIMMER LINE
// ─────────────────────────────────────────────────────────────────────────────

/// Create a shimmer line from text.
pub fn shimmer_line(text: &str) -> ratatui::text::Line<'static> {
    ratatui::text::Line::from(shimmer_spans(text))
}

/// Create a shimmer line with custom configuration.
pub fn shimmer_line_with_config(
    text: &str,
    config: &ShimmerConfig,
) -> ratatui::text::Line<'static> {
    ratatui::text::Line::from(shimmer_spans_with_config(text, config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shimmer_empty_text() {
        let spans = shimmer_spans("");
        assert!(spans.is_empty());
    }

    #[test]
    fn shimmer_creates_spans_for_each_char() {
        let spans = shimmer_spans("hello");
        assert_eq!(spans.len(), 5);
    }

    #[test]
    fn shimmer_spans_are_styled() {
        let spans = shimmer_spans("test");
        for span in spans {
            // Each span should have exactly one character
            assert_eq!(span.content.chars().count(), 1);
        }
    }

    #[test]
    fn shimmer_at_time_works() {
        let spans = shimmer_spans_at_time("hello", Duration::from_millis(500));
        assert_eq!(spans.len(), 5);
    }

    #[test]
    fn fallback_style_varies_with_intensity() {
        let dim = fallback_style_for_intensity(0.1);
        let normal = fallback_style_for_intensity(0.4);
        let bold = fallback_style_for_intensity(0.8);

        assert!(dim.add_modifier.contains(Modifier::DIM));
        assert!(!normal.add_modifier.contains(Modifier::DIM));
        assert!(bold.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn shimmer_config_auto_creates_config() {
        let config = ShimmerConfig::auto();
        assert!(config.sweep_seconds > 0.0);
    }

    #[test]
    fn shimmer_line_creates_line() {
        let line = shimmer_line("test");
        assert_eq!(line.spans.len(), 4);
    }
}

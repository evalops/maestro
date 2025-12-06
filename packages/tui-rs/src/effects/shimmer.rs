//! Shimmer animation effect
//!
//! Creates a wave-like highlight effect that sweeps across text.
//! Inspired by OpenAI Codex TUI.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

fn elapsed_since_start() -> Duration {
    let start = PROCESS_START.get_or_init(Instant::now);
    start.elapsed()
}

/// Blend two RGB colors together with a given ratio (0.0 = a, 1.0 = b)
fn blend(a: (u8, u8, u8), b: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    let t = t.clamp(0.0, 1.0);
    let r = (a.0 as f32 * (1.0 - t) + b.0 as f32 * t) as u8;
    let g = (a.1 as f32 * (1.0 - t) + b.1 as f32 * t) as u8;
    let b_out = (a.2 as f32 * (1.0 - t) + b.2 as f32 * t) as u8;
    (r, g, b_out)
}

/// Check if terminal supports true color
fn has_true_color() -> bool {
    // Check COLORTERM environment variable
    std::env::var("COLORTERM")
        .map(|v| v == "truecolor" || v == "24bit")
        .unwrap_or(false)
}

/// Create shimmer effect spans for the given text.
/// The shimmer is a wave of brightness that sweeps across the text.
pub fn shimmer_spans(text: &str) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    // Sweep configuration
    let padding = 10usize;
    let period = chars.len() + padding * 2;
    let sweep_seconds = 2.0f32;
    let band_half_width = 5.0f32;

    // Calculate current sweep position
    let pos_f =
        (elapsed_since_start().as_secs_f32() % sweep_seconds) / sweep_seconds * (period as f32);
    let pos = pos_f as usize;

    let has_rgb = has_true_color();

    // Base and highlight colors
    let base_color = (128, 128, 128); // Gray
    let highlight_color = (220, 220, 220); // Near white

    let mut spans: Vec<Span<'static>> = Vec::with_capacity(chars.len());

    for (i, ch) in chars.iter().enumerate() {
        let i_pos = i as isize + padding as isize;
        let pos = pos as isize;
        let dist = (i_pos - pos).abs() as f32;

        // Calculate intensity using cosine for smooth falloff
        let t = if dist <= band_half_width {
            let x = std::f32::consts::PI * (dist / band_half_width);
            0.5 * (1.0 + x.cos())
        } else {
            0.0
        };

        let style = if has_rgb {
            let (r, g, b) = blend(base_color, highlight_color, t * 0.9);
            Style::default()
                .fg(Color::Rgb(r, g, b))
                .add_modifier(Modifier::BOLD)
        } else {
            // Fallback for terminals without true color
            if t < 0.2 {
                Style::default().add_modifier(Modifier::DIM)
            } else if t < 0.6 {
                Style::default()
            } else {
                Style::default().add_modifier(Modifier::BOLD)
            }
        };

        spans.push(Span::styled(ch.to_string(), style));
    }

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shimmer_produces_spans() {
        let spans = shimmer_spans("Working");
        assert_eq!(spans.len(), 7);
    }

    #[test]
    fn shimmer_empty_string() {
        let spans = shimmer_spans("");
        assert!(spans.is_empty());
    }
}

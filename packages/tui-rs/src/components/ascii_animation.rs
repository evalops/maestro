//! ASCII Art Animation Component
//!
//! Provides animated ASCII art for welcome screens and loading states.
//! Supports multiple animation variants with smooth frame transitions.
//!
//! # Features
//!
//! - Multiple animation variants
//! - Configurable frame rate
//! - Random variant selection
//! - Time-synchronized animation
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::components::AsciiAnimation;
//!
//! let mut animation = AsciiAnimation::new();
//!
//! // In your render loop:
//! let frame = animation.current_frame();
//! // Render `frame` as text
//!
//! // Optionally switch to a random variant:
//! animation.pick_random_variant();
//! ```

use rand::Rng;
use std::time::{Duration, Instant};

/// Default frame tick duration (100ms)
pub const FRAME_TICK_DEFAULT: Duration = Duration::from_millis(100);

/// ASCII art animation frames - Robot variant
pub const ROBOT_FRAMES: &[&str] = &[
    r#"
    ┌─────┐
    │ ◕ ◕ │
    │  ▽  │
    └──┬──┘
   ┌───┴───┐
   │       │
   └───────┘
    "#,
    r#"
    ┌─────┐
    │ ◕ ◕ │
    │  △  │
    └──┬──┘
   ┌───┴───┐
   │       │
   └───────┘
    "#,
    r#"
    ┌─────┐
    │ ◔ ◕ │
    │  ▽  │
    └──┬──┘
   ┌───┴───┐
   │       │
   └───────┘
    "#,
    r#"
    ┌─────┐
    │ ◕ ◔ │
    │  ▽  │
    └──┬──┘
   ┌───┴───┐
   │       │
   └───────┘
    "#,
];

/// ASCII art animation frames - Terminal variant
pub const TERMINAL_FRAMES: &[&str] = &[
    r#"
  ╔══════════════╗
  ║ composer_    ║
  ║ █            ║
  ║              ║
  ╚══════════════╝
    "#,
    r#"
  ╔══════════════╗
  ║ composer_█   ║
  ║              ║
  ║              ║
  ╚══════════════╝
    "#,
    r#"
  ╔══════════════╗
  ║ composer_    ║
  ║ > thinking   ║
  ║   █          ║
  ╚══════════════╝
    "#,
    r#"
  ╔══════════════╗
  ║ composer_    ║
  ║ > thinking...║
  ║              ║
  ╚══════════════╝
    "#,
];

/// ASCII art animation frames - Pulse variant
pub const PULSE_FRAMES: &[&str] = &[
    r#"
       ·
      ···
     ·····
    ·······
     ·····
      ···
       ·
    "#,
    r#"
       ○
      ○○○
     ○○○○○
    ○○○○○○○
     ○○○○○
      ○○○
       ○
    "#,
    r#"
       ●
      ●●●
     ●●●●●
    ●●●●●●●
     ●●●●●
      ●●●
       ●
    "#,
    r#"
       ○
      ○○○
     ○○○○○
    ○○○○○○○
     ○○○○○
      ○○○
       ○
    "#,
];

/// ASCII art animation frames - Wave variant
pub const WAVE_FRAMES: &[&str] = &[
    "  ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁  ",
    "  ▂▃▄▅▆▇█▇▆▅▄▃▂▁▁  ",
    "  ▃▄▅▆▇█▇▆▅▄▃▂▁▁▂  ",
    "  ▄▅▆▇█▇▆▅▄▃▂▁▁▂▃  ",
    "  ▅▆▇█▇▆▅▄▃▂▁▁▂▃▄  ",
    "  ▆▇█▇▆▅▄▃▂▁▁▂▃▄▅  ",
    "  ▇█▇▆▅▄▃▂▁▁▂▃▄▅▆  ",
    "  █▇▆▅▄▃▂▁▁▂▃▄▅▆▇  ",
];

/// All animation variants
pub const ALL_VARIANTS: &[&[&str]] = &[ROBOT_FRAMES, TERMINAL_FRAMES, PULSE_FRAMES, WAVE_FRAMES];

/// ASCII art animation controller
#[derive(Debug, Clone)]
pub struct AsciiAnimation {
    /// Available animation variants
    variants: &'static [&'static [&'static str]],
    /// Current variant index
    variant_idx: usize,
    /// Frame tick duration
    frame_tick: Duration,
    /// Animation start time
    start: Instant,
}

impl Default for AsciiAnimation {
    fn default() -> Self {
        Self::new()
    }
}

impl AsciiAnimation {
    /// Create a new animation with all variants
    pub fn new() -> Self {
        Self::with_variants(ALL_VARIANTS, 0)
    }

    /// Create animation with specific variants
    pub fn with_variants(variants: &'static [&'static [&'static str]], variant_idx: usize) -> Self {
        assert!(!variants.is_empty(), "Must have at least one variant");
        let clamped_idx = variant_idx.min(variants.len() - 1);

        Self {
            variants,
            variant_idx: clamped_idx,
            frame_tick: FRAME_TICK_DEFAULT,
            start: Instant::now(),
        }
    }

    /// Create robot animation
    pub fn robot() -> Self {
        Self::with_variants(&[ROBOT_FRAMES], 0)
    }

    /// Create terminal animation
    pub fn terminal() -> Self {
        Self::with_variants(&[TERMINAL_FRAMES], 0)
    }

    /// Create pulse animation
    pub fn pulse() -> Self {
        Self::with_variants(&[PULSE_FRAMES], 0)
    }

    /// Create wave animation
    pub fn wave() -> Self {
        Self::with_variants(&[WAVE_FRAMES], 0)
    }

    /// Set the frame tick duration
    pub fn with_frame_tick(mut self, duration: Duration) -> Self {
        self.frame_tick = duration;
        self
    }

    /// Get the current frame to display
    pub fn current_frame(&self) -> &'static str {
        let frames = self.frames();
        if frames.is_empty() {
            return "";
        }

        let tick_ms = self.frame_tick.as_millis();
        if tick_ms == 0 {
            return frames[0];
        }

        let elapsed_ms = self.start.elapsed().as_millis();
        let idx = ((elapsed_ms / tick_ms) % frames.len() as u128) as usize;
        frames[idx]
    }

    /// Get the frame index
    pub fn frame_index(&self) -> usize {
        let frames = self.frames();
        if frames.is_empty() {
            return 0;
        }

        let tick_ms = self.frame_tick.as_millis();
        if tick_ms == 0 {
            return 0;
        }

        let elapsed_ms = self.start.elapsed().as_millis();
        ((elapsed_ms / tick_ms) % frames.len() as u128) as usize
    }

    /// Pick a random variant (different from current)
    pub fn pick_random_variant(&mut self) -> bool {
        if self.variants.len() <= 1 {
            return false;
        }

        let mut rng = rand::rng();
        let mut next = self.variant_idx;
        while next == self.variant_idx {
            next = rng.random_range(0..self.variants.len());
        }
        self.variant_idx = next;
        true
    }

    /// Set specific variant
    pub fn set_variant(&mut self, idx: usize) {
        if idx < self.variants.len() {
            self.variant_idx = idx;
        }
    }

    /// Get current variant index
    pub fn variant_index(&self) -> usize {
        self.variant_idx
    }

    /// Get number of variants
    pub fn variant_count(&self) -> usize {
        self.variants.len()
    }

    /// Get current variant's frames
    fn frames(&self) -> &'static [&'static str] {
        self.variants[self.variant_idx]
    }

    /// Get the height of the animation (in lines)
    pub fn height(&self) -> usize {
        self.current_frame().lines().count()
    }

    /// Get the width of the animation (max line length)
    pub fn width(&self) -> usize {
        self.current_frame()
            .lines()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(0)
    }

    /// Get time until next frame
    pub fn time_to_next_frame(&self) -> Duration {
        let tick_ms = self.frame_tick.as_millis();
        if tick_ms == 0 {
            return Duration::ZERO;
        }

        let elapsed_ms = self.start.elapsed().as_millis();
        let rem_ms = elapsed_ms % tick_ms;
        let delay_ms = if rem_ms == 0 { tick_ms } else { tick_ms - rem_ms };

        Duration::from_millis(delay_ms as u64)
    }

    /// Reset animation to start
    pub fn reset(&mut self) {
        self.start = Instant::now();
    }
}

/// Static ASCII art logos
pub mod logos {
    /// Composer logo
    pub const COMPOSER: &str = r#"
   ___
  / __\___  _ __ ___  _ __   ___  ___  ___ _ __
 / /  / _ \| '_ ` _ \| '_ \ / _ \/ __|/ _ \ '__|
/ /__| (_) | | | | | | |_) | (_) \__ \  __/ |
\____/\___/|_| |_| |_| .__/ \___/|___/\___|_|
                     |_|
    "#;

    /// Small composer logo
    pub const COMPOSER_SMALL: &str = r#"
╔═╗┌─┐┌┬┐┌─┐┌─┐┌─┐┌─┐┬─┐
║  │ ││││├─┘│ │└─┐├┤ ├┬┘
╚═╝└─┘┴ ┴┴  └─┘└─┘└─┘┴└─
    "#;

    /// AI brain logo
    pub const AI_BRAIN: &str = r#"
      ╭──────╮
     ╭┤ ◉  ◉ ├╮
     │╰──────╯│
    ╭┴────────┴╮
    │ ▓▓▓▓▓▓▓▓ │
    │ ░░░░░░░░ │
    ╰──────────╯
    "#;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_animation_default() {
        let anim = AsciiAnimation::new();
        assert!(!anim.current_frame().is_empty());
        assert!(anim.variant_count() > 0);
    }

    #[test]
    fn test_animation_specific_variant() {
        let anim = AsciiAnimation::robot();
        assert_eq!(anim.variant_count(), 1);
    }

    #[test]
    fn test_animation_pick_random() {
        let mut anim = AsciiAnimation::new();
        let original = anim.variant_index();

        // With multiple variants, should eventually pick a different one
        let mut changed = false;
        for _ in 0..10 {
            if anim.pick_random_variant() && anim.variant_index() != original {
                changed = true;
                break;
            }
        }

        // Note: This could theoretically fail with very low probability
        assert!(changed || anim.variant_count() == 1);
    }

    #[test]
    fn test_animation_frame_index() {
        let anim = AsciiAnimation::new();
        let idx = anim.frame_index();
        assert!(idx < anim.frames().len());
    }

    #[test]
    fn test_animation_dimensions() {
        let anim = AsciiAnimation::robot();
        assert!(anim.height() > 0);
        assert!(anim.width() > 0);
    }

    #[test]
    fn test_animation_with_frame_tick() {
        let anim = AsciiAnimation::new().with_frame_tick(Duration::from_millis(50));
        assert_eq!(anim.frame_tick, Duration::from_millis(50));
    }

    #[test]
    fn test_animation_set_variant() {
        let mut anim = AsciiAnimation::new();
        anim.set_variant(1);
        assert_eq!(anim.variant_index(), 1);

        // Setting out of bounds should not change
        anim.set_variant(999);
        assert_eq!(anim.variant_index(), 1);
    }

    #[test]
    fn test_logos_not_empty() {
        assert!(!logos::COMPOSER.is_empty());
        assert!(!logos::COMPOSER_SMALL.is_empty());
        assert!(!logos::AI_BRAIN.is_empty());
    }

    #[test]
    fn test_time_to_next_frame() {
        let anim = AsciiAnimation::new().with_frame_tick(Duration::from_millis(100));
        let time = anim.time_to_next_frame();
        assert!(time <= Duration::from_millis(100));
    }
}

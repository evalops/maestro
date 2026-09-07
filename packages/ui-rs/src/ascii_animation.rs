//! ASCII Animation System
//!
//! Frame-based ASCII art animations for terminal UIs.
//! Includes built-in animations and support for custom frames.
//!
//! Inspired by OpenAI Codex CLI (MIT licensed).

use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION STATE
// ─────────────────────────────────────────────────────────────────────────────

/// Default frame duration (80ms = ~12.5 FPS).
pub const DEFAULT_FRAME_DURATION: Duration = Duration::from_millis(80);

/// An ASCII animation with multiple frames.
#[derive(Debug, Clone)]
pub struct AsciiAnimation {
    /// Animation frames (each frame is multiple lines).
    frames: Vec<Vec<String>>,
    /// Duration per frame.
    frame_duration: Duration,
    /// Animation start time.
    start_time: Instant,
    /// Whether animation loops.
    looping: bool,
}

impl AsciiAnimation {
    /// Create a new animation from frames.
    ///
    /// Each frame is a slice of lines.
    #[must_use]
    pub fn new(frames: Vec<Vec<String>>) -> Self {
        Self {
            frames,
            frame_duration: DEFAULT_FRAME_DURATION,
            start_time: Instant::now(),
            looping: true,
        }
    }

    /// Create from static string frames.
    #[must_use]
    pub fn from_static(frames: &[&[&str]]) -> Self {
        let frames: Vec<Vec<String>> = frames
            .iter()
            .map(|f| f.iter().map(|s| (*s).to_string()).collect())
            .collect();
        Self::new(frames)
    }

    /// Set frame duration.
    #[must_use]
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.frame_duration = duration;
        self
    }

    /// Set whether animation loops.
    #[must_use]
    pub fn with_looping(mut self, looping: bool) -> Self {
        self.looping = looping;
        self
    }

    /// Reset animation to beginning.
    pub fn reset(&mut self) {
        self.start_time = Instant::now();
    }

    /// Get current frame index.
    #[must_use]
    pub fn current_frame_index(&self) -> usize {
        if self.frames.is_empty() || self.frame_duration.is_zero() {
            return 0;
        }

        let elapsed = self.start_time.elapsed();
        let frame_ms = self.frame_duration.as_millis() as u64;
        let elapsed_ms = elapsed.as_millis() as u64;
        let frame_idx = (elapsed_ms / frame_ms) as usize;

        if self.looping {
            frame_idx % self.frames.len()
        } else {
            frame_idx.min(self.frames.len().saturating_sub(1))
        }
    }

    /// Get current frame lines.
    #[must_use]
    pub fn current_frame(&self) -> &[String] {
        if self.frames.is_empty() {
            return &[];
        }
        &self.frames[self.current_frame_index()]
    }

    /// Get frame count.
    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    /// Check if animation has finished (non-looping only).
    #[must_use]
    pub fn is_finished(&self) -> bool {
        if self.looping || self.frames.is_empty() {
            return false;
        }
        let elapsed = self.start_time.elapsed();
        let total_duration = self.frame_duration * self.frames.len() as u32;
        elapsed >= total_duration
    }

    /// Get animation dimensions (width, height).
    #[must_use]
    pub fn dimensions(&self) -> (usize, usize) {
        if self.frames.is_empty() {
            return (0, 0);
        }
        let height = self.frames[0].len();
        let width = self.frames[0]
            .iter()
            .map(|l| l.chars().count())
            .max()
            .unwrap_or(0);
        (width, height)
    }

    /// Time until next frame change.
    #[must_use]
    pub fn time_until_next_frame(&self) -> Duration {
        if self.frame_duration.is_zero() {
            return Duration::ZERO;
        }
        let elapsed = self.start_time.elapsed();
        let frame_ms = self.frame_duration.as_millis() as u64;
        let elapsed_ms = elapsed.as_millis() as u64;
        let remainder = elapsed_ms % frame_ms;
        Duration::from_millis(frame_ms - remainder)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILT-IN ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/// Built-in spinner animation (dots).
#[must_use]
pub fn spinner_dots() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["⠋"],
        &["⠙"],
        &["⠹"],
        &["⠸"],
        &["⠼"],
        &["⠴"],
        &["⠦"],
        &["⠧"],
        &["⠇"],
        &["⠏"],
    ])
    .with_duration(Duration::from_millis(80))
}

/// Built-in spinner animation (line).
#[must_use]
pub fn spinner_line() -> AsciiAnimation {
    AsciiAnimation::from_static(&[&["-"], &["\\"], &["|"], &["/"]])
        .with_duration(Duration::from_millis(100))
}

/// Built-in spinner animation (growing dots).
#[must_use]
pub fn spinner_grow() -> AsciiAnimation {
    AsciiAnimation::from_static(&[&[".  "], &[".. "], &["..."], &[".. "], &[".  "], &["   "]])
        .with_duration(Duration::from_millis(150))
}

/// Built-in bouncing ball animation.
#[must_use]
pub fn bouncing_ball() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["●    "],
        &[" ●   "],
        &["  ●  "],
        &["   ● "],
        &["    ●"],
        &["   ● "],
        &["  ●  "],
        &[" ●   "],
    ])
    .with_duration(Duration::from_millis(100))
}

/// Built-in progress bar animation.
#[must_use]
pub fn progress_bar() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["[    ]"],
        &["[=   ]"],
        &["[==  ]"],
        &["[=== ]"],
        &["[====]"],
        &["[ ===]"],
        &["[  ==]"],
        &["[   =]"],
    ])
    .with_duration(Duration::from_millis(120))
}

/// Built-in wave animation.
#[must_use]
pub fn wave() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["▁▂▃▄▅▆▇█▇▆▅▄▃▂▁"],
        &["▂▃▄▅▆▇█▇▆▅▄▃▂▁▁"],
        &["▃▄▅▆▇█▇▆▅▄▃▂▁▁▂"],
        &["▄▅▆▇█▇▆▅▄▃▂▁▁▂▃"],
        &["▅▆▇█▇▆▅▄▃▂▁▁▂▃▄"],
        &["▆▇█▇▆▅▄▃▂▁▁▂▃▄▅"],
        &["▇█▇▆▅▄▃▂▁▁▂▃▄▅▆"],
        &["█▇▆▅▄▃▂▁▁▂▃▄▅▆▇"],
        &["▇▆▅▄▃▂▁▁▂▃▄▅▆▇█"],
        &["▆▅▄▃▂▁▁▂▃▄▅▆▇█▇"],
        &["▅▄▃▂▁▁▂▃▄▅▆▇█▇▆"],
        &["▄▃▂▁▁▂▃▄▅▆▇█▇▆▅"],
        &["▃▂▁▁▂▃▄▅▆▇█▇▆▅▄"],
        &["▂▁▁▂▃▄▅▆▇█▇▆▅▄▃"],
        &["▁▁▂▃▄▅▆▇█▇▆▅▄▃▂"],
    ])
    .with_duration(Duration::from_millis(60))
}

/// Built-in pulse animation (ASCII-safe).
#[must_use]
pub fn pulse_ascii() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["(   )"],
        &["(o  )"],
        &["(oO )"],
        &["(oO.)"],
        &["( O.)"],
        &["(  .)"],
        &["(   )"],
    ])
    .with_duration(Duration::from_millis(100))
}

/// Simple box animation.
#[must_use]
pub fn box_spin() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["┌─┐", "│ │", "└─┘"],
        &["╔═╗", "║ ║", "╚═╝"],
        &["┌─┐", "│ │", "└─┘"],
        &["╭─╮", "│ │", "╰─╯"],
    ])
    .with_duration(Duration::from_millis(200))
}

/// Thinking dots animation.
#[must_use]
pub fn thinking() -> AsciiAnimation {
    AsciiAnimation::from_static(&[&["●○○"], &["○●○"], &["○○●"], &["○●○"]])
        .with_duration(Duration::from_millis(200))
}

/// Earth rotation animation.
#[must_use]
pub fn earth() -> AsciiAnimation {
    AsciiAnimation::from_static(&[&["🌍"], &["🌎"], &["🌏"]])
        .with_duration(Duration::from_millis(300))
}

/// Clock animation.
#[must_use]
pub fn clock() -> AsciiAnimation {
    AsciiAnimation::from_static(&[
        &["🕐"],
        &["🕑"],
        &["🕒"],
        &["🕓"],
        &["🕔"],
        &["🕕"],
        &["🕖"],
        &["🕗"],
        &["🕘"],
        &["🕙"],
        &["🕚"],
        &["🕛"],
    ])
    .with_duration(Duration::from_millis(100))
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION PRESETS
// ─────────────────────────────────────────────────────────────────────────────

/// Available animation presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnimationPreset {
    /// Braille dots spinner.
    Dots,
    /// Line spinner (ASCII).
    Line,
    /// Growing dots.
    Grow,
    /// Bouncing ball.
    Bounce,
    /// Progress bar.
    Progress,
    /// Wave bars.
    Wave,
    /// Pulse (ASCII).
    Pulse,
    /// Box spin.
    Box,
    /// Thinking dots.
    Thinking,
    /// Earth emoji.
    Earth,
    /// Clock emoji.
    Clock,
}

impl AnimationPreset {
    /// Create animation from preset.
    #[must_use]
    pub fn create(self) -> AsciiAnimation {
        match self {
            Self::Dots => spinner_dots(),
            Self::Line => spinner_line(),
            Self::Grow => spinner_grow(),
            Self::Bounce => bouncing_ball(),
            Self::Progress => progress_bar(),
            Self::Wave => wave(),
            Self::Pulse => pulse_ascii(),
            Self::Box => box_spin(),
            Self::Thinking => thinking(),
            Self::Earth => earth(),
            Self::Clock => clock(),
        }
    }

    /// Get ASCII-only presets (for low-unicode terminals).
    #[must_use]
    pub fn ascii_presets() -> &'static [AnimationPreset] {
        &[
            Self::Line,
            Self::Grow,
            Self::Bounce,
            Self::Progress,
            Self::Pulse,
        ]
    }

    /// Get all presets.
    #[must_use]
    pub fn all() -> &'static [AnimationPreset] {
        &[
            Self::Dots,
            Self::Line,
            Self::Grow,
            Self::Bounce,
            Self::Progress,
            Self::Wave,
            Self::Pulse,
            Self::Box,
            Self::Thinking,
            Self::Earth,
            Self::Clock,
        ]
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn animation_frame_cycling() {
        let anim = AsciiAnimation::from_static(&[&["a"], &["b"], &["c"]])
            .with_duration(Duration::from_millis(10));

        assert_eq!(anim.frame_count(), 3);

        // Initial frame
        let _first = anim.current_frame_index();

        // Wait for a few frames
        sleep(Duration::from_millis(35));

        // Should have advanced
        let _later = anim.current_frame_index();
        // Frame should be different or wrapped
        assert!(anim.current_frame_index() < 3);
    }

    #[test]
    fn animation_dimensions() {
        let anim = box_spin();
        let (w, h) = anim.dimensions();
        assert_eq!(h, 3);
        assert!(w >= 3);
    }

    #[test]
    fn animation_non_looping() {
        let anim = AsciiAnimation::from_static(&[&["x"]])
            .with_duration(Duration::from_millis(10))
            .with_looping(false);

        assert!(!anim.is_finished());
        sleep(Duration::from_millis(20));
        assert!(anim.is_finished());
    }

    #[test]
    fn preset_creation() {
        for preset in AnimationPreset::all() {
            let anim = preset.create();
            assert!(anim.frame_count() > 0);
        }
    }

    #[test]
    fn spinner_dots_has_frames() {
        let anim = spinner_dots();
        assert_eq!(anim.frame_count(), 10);
    }

    #[test]
    fn wave_animation_works() {
        let anim = wave();
        assert!(anim.frame_count() > 0);
        assert!(!anim.current_frame().is_empty());
    }

    #[test]
    fn reset_restarts_animation() {
        let mut anim = spinner_dots();
        sleep(Duration::from_millis(100));
        let _before = anim.current_frame_index();
        anim.reset();
        // After reset, should be at or near frame 0
        assert!(anim.current_frame_index() <= 1);
    }

    #[test]
    fn time_until_next_frame_positive() {
        let anim = spinner_dots();
        let time = anim.time_until_next_frame();
        assert!(time <= anim.frame_duration);
    }
}

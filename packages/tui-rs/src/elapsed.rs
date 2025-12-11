//! Elapsed Time Formatting and Timer Utilities
//!
//! This module provides compact elapsed time formatting and a pausable timer
//! for status indicators and progress displays.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/// Format elapsed seconds into a compact human-friendly form.
///
/// Examples:
/// - 0 → "0s"
/// - 59 → "59s"
/// - 60 → "1m 00s"
/// - 3661 → "1h 01m 01s"
pub fn format_elapsed_compact(elapsed_secs: u64) -> String {
    if elapsed_secs < 60 {
        return format!("{elapsed_secs}s");
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{minutes}m {seconds:02}s");
    }
    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

/// Format a duration into a compact form.
pub fn format_duration_compact(duration: Duration) -> String {
    format_elapsed_compact(duration.as_secs())
}

/// Format elapsed time with millisecond precision for short durations.
///
/// - < 1s: "420ms"
/// - < 60s: "5.2s"
/// - >= 60s: Uses compact format
pub fn format_elapsed_precise(duration: Duration) -> String {
    let millis = duration.as_millis();
    if millis < 1000 {
        return format!("{}ms", millis);
    }
    let secs = duration.as_secs();
    if secs < 60 {
        let tenths = (millis % 1000) / 100;
        return format!("{}.{}s", secs, tenths);
    }
    format_elapsed_compact(secs)
}

// ─────────────────────────────────────────────────────────────────────────────
// PAUSABLE TIMER
// ─────────────────────────────────────────────────────────────────────────────

/// A timer that can be paused and resumed.
///
/// Useful for tracking elapsed time during long-running operations
/// that may be interrupted (e.g., waiting for user approval).
#[derive(Debug, Clone)]
pub struct PausableTimer {
    /// Accumulated time while running.
    elapsed_running: Duration,
    /// When the timer was last resumed.
    last_resume_at: Instant,
    /// Whether the timer is currently paused.
    is_paused: bool,
}

impl Default for PausableTimer {
    fn default() -> Self {
        Self::new()
    }
}

impl PausableTimer {
    /// Create a new timer that starts running immediately.
    pub fn new() -> Self {
        Self {
            elapsed_running: Duration::ZERO,
            last_resume_at: Instant::now(),
            is_paused: false,
        }
    }

    /// Create a new timer that starts paused.
    pub fn paused() -> Self {
        Self {
            elapsed_running: Duration::ZERO,
            last_resume_at: Instant::now(),
            is_paused: true,
        }
    }

    /// Check if the timer is currently paused.
    pub fn is_paused(&self) -> bool {
        self.is_paused
    }

    /// Pause the timer, capturing the current elapsed time.
    pub fn pause(&mut self) {
        self.pause_at(Instant::now());
    }

    /// Pause the timer at a specific instant.
    pub fn pause_at(&mut self, now: Instant) {
        if self.is_paused {
            return;
        }
        self.elapsed_running += now.saturating_duration_since(self.last_resume_at);
        self.is_paused = true;
    }

    /// Resume the timer.
    pub fn resume(&mut self) {
        self.resume_at(Instant::now());
    }

    /// Resume the timer at a specific instant.
    pub fn resume_at(&mut self, now: Instant) {
        if !self.is_paused {
            return;
        }
        self.last_resume_at = now;
        self.is_paused = false;
    }

    /// Reset the timer to zero and start running.
    pub fn reset(&mut self) {
        self.elapsed_running = Duration::ZERO;
        self.last_resume_at = Instant::now();
        self.is_paused = false;
    }

    /// Get the total elapsed duration.
    pub fn elapsed(&self) -> Duration {
        self.elapsed_at(Instant::now())
    }

    /// Get the elapsed duration at a specific instant.
    pub fn elapsed_at(&self, now: Instant) -> Duration {
        let mut elapsed = self.elapsed_running;
        if !self.is_paused {
            elapsed += now.saturating_duration_since(self.last_resume_at);
        }
        elapsed
    }

    /// Get elapsed seconds.
    pub fn elapsed_secs(&self) -> u64 {
        self.elapsed().as_secs()
    }

    /// Get elapsed seconds at a specific instant.
    pub fn elapsed_secs_at(&self, now: Instant) -> u64 {
        self.elapsed_at(now).as_secs()
    }

    /// Format the elapsed time compactly.
    pub fn format_compact(&self) -> String {
        format_elapsed_compact(self.elapsed_secs())
    }

    /// Format the elapsed time precisely.
    pub fn format_precise(&self) -> String {
        format_elapsed_precise(self.elapsed())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SPINNER
// ─────────────────────────────────────────────────────────────────────────────

/// Spinner frames for animated progress indication.
pub const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Braille dot spinner (alternative style).
pub const SPINNER_DOTS: &[&str] = &["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/// Simple ASCII spinner.
pub const SPINNER_ASCII: &[&str] = &["|", "/", "-", "\\"];

/// Get the current spinner frame based on time.
///
/// # Arguments
/// * `start_time` - When the spinner started (for animation timing)
/// * `frames` - The spinner frame characters
/// * `interval_ms` - Milliseconds between frames
pub fn spinner_frame<'a>(
    start_time: Option<Instant>,
    frames: &'a [&'a str],
    interval_ms: u64,
) -> &'a str {
    let now = Instant::now();
    let elapsed = start_time
        .map(|t| now.saturating_duration_since(t))
        .unwrap_or(Duration::ZERO);
    let frame_idx = (elapsed.as_millis() / interval_ms as u128) as usize % frames.len();
    frames[frame_idx]
}

/// Get the default spinner frame.
pub fn spinner(start_time: Option<Instant>) -> &'static str {
    spinner_frame(start_time, SPINNER_FRAMES, 80)
}

/// Get a spinner span for use in ratatui.
pub fn spinner_span(start_time: Option<Instant>) -> ratatui::text::Span<'static> {
    ratatui::text::Span::raw(spinner(start_time).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_elapsed_seconds() {
        assert_eq!(format_elapsed_compact(0), "0s");
        assert_eq!(format_elapsed_compact(1), "1s");
        assert_eq!(format_elapsed_compact(59), "59s");
    }

    #[test]
    fn format_elapsed_minutes() {
        assert_eq!(format_elapsed_compact(60), "1m 00s");
        assert_eq!(format_elapsed_compact(61), "1m 01s");
        assert_eq!(format_elapsed_compact(125), "2m 05s");
        assert_eq!(format_elapsed_compact(3599), "59m 59s");
    }

    #[test]
    fn format_elapsed_hours() {
        assert_eq!(format_elapsed_compact(3600), "1h 00m 00s");
        assert_eq!(format_elapsed_compact(3661), "1h 01m 01s");
        assert_eq!(format_elapsed_compact(7325), "2h 02m 05s");
    }

    #[test]
    fn format_elapsed_precise_millis() {
        assert_eq!(format_elapsed_precise(Duration::from_millis(420)), "420ms");
        assert_eq!(format_elapsed_precise(Duration::from_millis(999)), "999ms");
    }

    #[test]
    fn format_elapsed_precise_seconds() {
        assert_eq!(format_elapsed_precise(Duration::from_millis(1200)), "1.2s");
        assert_eq!(format_elapsed_precise(Duration::from_millis(5500)), "5.5s");
    }

    #[test]
    fn timer_basic_elapsed() {
        let timer = PausableTimer::new();
        std::thread::sleep(Duration::from_millis(50));
        assert!(timer.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn timer_pause_resume() {
        let baseline = Instant::now();
        let mut timer = PausableTimer::new();
        timer.last_resume_at = baseline;

        // Check elapsed after 5 seconds
        let elapsed_before = timer.elapsed_secs_at(baseline + Duration::from_secs(5));
        assert_eq!(elapsed_before, 5);

        // Pause at 5 seconds
        timer.pause_at(baseline + Duration::from_secs(5));

        // Check that elapsed is frozen at 5 even at 10 seconds
        let elapsed_paused = timer.elapsed_secs_at(baseline + Duration::from_secs(10));
        assert_eq!(elapsed_paused, 5);

        // Resume at 10 seconds
        timer.resume_at(baseline + Duration::from_secs(10));

        // Check elapsed at 13 seconds (5 + 3 = 8)
        let elapsed_after = timer.elapsed_secs_at(baseline + Duration::from_secs(13));
        assert_eq!(elapsed_after, 8);
    }

    #[test]
    fn timer_starts_paused() {
        let timer = PausableTimer::paused();
        assert!(timer.is_paused());
        std::thread::sleep(Duration::from_millis(50));
        assert!(timer.elapsed() < Duration::from_millis(10));
    }

    #[test]
    fn spinner_cycles_frames() {
        let start = Instant::now();
        let frame1 = spinner_frame(Some(start), SPINNER_FRAMES, 80);
        assert!(!frame1.is_empty());

        // Different start times should potentially give different frames
        let different_start = start - Duration::from_millis(160);
        let frame2 = spinner_frame(Some(different_start), SPINNER_FRAMES, 80);
        assert!(!frame2.is_empty());
    }

    #[test]
    fn spinner_without_start_time() {
        let frame = spinner(None);
        assert_eq!(frame, SPINNER_FRAMES[0]);
    }
}

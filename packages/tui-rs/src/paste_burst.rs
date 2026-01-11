//! Paste Burst Detection for Terminals Without Bracketed Paste
//!
//! This module provides heuristic-based paste detection for terminals that don't
//! support bracketed paste mode (or when it's disabled over SSH).
//!
//! # How It Works
//!
//! The detector identifies paste-like input by analyzing the timing between keystrokes:
//! - Characters arriving faster than ~8ms apart are likely pasted
//! - After detecting a burst, it buffers input until the burst ends
//! - Newlines during a burst are buffered rather than submitting
//!
//! This prevents accidental form submission when pasting multiline content and
//! provides a smoother experience when the terminal can't use bracketed paste.
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use std::time::Duration;
use std::time::Instant;

/// Minimum characters to trigger burst detection.
const PASTE_BURST_MIN_CHARS: u16 = 3;

/// Maximum time between characters to be considered part of a burst.
const PASTE_BURST_CHAR_INTERVAL: Duration = Duration::from_millis(8);

/// Window after a burst where Enter inserts newline instead of submitting.
const PASTE_ENTER_SUPPRESS_WINDOW: Duration = Duration::from_millis(120);

/// Paste burst detector state machine.
#[derive(Default)]
pub struct PasteBurst {
    last_plain_char_time: Option<Instant>,
    consecutive_plain_char_burst: u16,
    burst_window_until: Option<Instant>,
    buffer: String,
    active: bool,
    /// Hold first fast char briefly to avoid rendering flicker.
    pending_first_char: Option<(char, Instant)>,
}

/// Decision for how to handle a plain character.
pub enum CharDecision {
    /// Start buffering and retroactively capture some already-inserted chars.
    BeginBuffer {
        /// Number of characters to grab retroactively from the input.
        retro_chars: u16,
    },
    /// We are currently buffering; append the current char into the buffer.
    BufferAppend,
    /// Do not insert/render this char yet; temporarily save it while we
    /// wait to see if a paste-like burst follows.
    RetainFirstChar,
    /// Begin buffering using the previously saved first char.
    BeginBufferFromPending,
}

/// Information about retroactively grabbed text.
pub struct RetroGrab {
    /// Byte index where the grabbed text starts.
    pub start_byte: usize,
    /// The grabbed text.
    pub grabbed: String,
}

/// Result of flushing the burst buffer.
pub enum FlushResult {
    /// A pasted string is ready.
    Paste(String),
    /// A single typed character is ready (not a paste).
    Typed(char),
    /// Nothing to flush.
    None,
}

impl PasteBurst {
    /// Create a new paste burst detector.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Recommended delay to wait between simulated keypresses.
    ///
    /// This delay ensures a pending fast keystroke is flushed as normal
    /// typed input rather than being mistaken for part of a paste.
    #[must_use]
    pub fn recommended_flush_delay() -> Duration {
        PASTE_BURST_CHAR_INTERVAL + Duration::from_millis(1)
    }

    /// Process a plain character and decide how to handle it.
    pub fn on_plain_char(&mut self, ch: char, now: Instant) -> CharDecision {
        // Update burst tracking
        match self.last_plain_char_time {
            Some(prev) if now.duration_since(prev) <= PASTE_BURST_CHAR_INTERVAL => {
                self.consecutive_plain_char_burst =
                    self.consecutive_plain_char_burst.saturating_add(1);
            }
            _ => self.consecutive_plain_char_burst = 1,
        }
        self.last_plain_char_time = Some(now);

        // Already actively buffering
        if self.active {
            self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
            return CharDecision::BufferAppend;
        }

        // If we held a first char and got a second fast char, start buffering
        if let Some((held, held_at)) = self.pending_first_char {
            if now.duration_since(held_at) <= PASTE_BURST_CHAR_INTERVAL {
                self.active = true;
                self.pending_first_char = None;
                self.buffer.push(held);
                self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
                return CharDecision::BeginBufferFromPending;
            }
        }

        // Check if we've hit the burst threshold
        if self.consecutive_plain_char_burst >= PASTE_BURST_MIN_CHARS {
            return CharDecision::BeginBuffer {
                retro_chars: self.consecutive_plain_char_burst.saturating_sub(1),
            };
        }

        // Save first fast char to see if a burst follows
        self.pending_first_char = Some((ch, now));
        CharDecision::RetainFirstChar
    }

    /// Flush the buffer if the inter-key timeout has elapsed.
    pub fn flush_if_due(&mut self, now: Instant) -> FlushResult {
        let timed_out = self
            .last_plain_char_time
            .is_some_and(|t| now.duration_since(t) > PASTE_BURST_CHAR_INTERVAL);

        if timed_out && self.is_active_internal() {
            self.active = false;
            let out = std::mem::take(&mut self.buffer);
            FlushResult::Paste(out)
        } else if timed_out {
            // Flush a single held char as normal typed input
            if let Some((ch, _)) = self.pending_first_char.take() {
                FlushResult::Typed(ch)
            } else {
                FlushResult::None
            }
        } else {
            FlushResult::None
        }
    }

    /// Append a newline if currently in a burst context.
    ///
    /// Returns true if the newline was appended (we're in burst mode),
    /// false if it should be handled normally (submit).
    pub fn append_newline_if_active(&mut self, now: Instant) -> bool {
        if self.is_active() {
            self.buffer.push('\n');
            self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
            true
        } else {
            false
        }
    }

    /// Check if Enter should insert a newline vs submit.
    #[must_use]
    pub fn newline_should_insert_instead_of_submit(&self, now: Instant) -> bool {
        let in_burst_window = self.burst_window_until.is_some_and(|until| now <= until);
        self.is_active() || in_burst_window
    }

    /// Extend the burst window (call on each character in a burst).
    pub fn extend_window(&mut self, now: Instant) {
        self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
    }

    /// Begin buffering with retroactively grabbed text.
    pub fn begin_with_retro_grabbed(&mut self, grabbed: String, now: Instant) {
        if !grabbed.is_empty() {
            self.buffer.push_str(&grabbed);
        }
        self.active = true;
        self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
    }

    /// Append a character to the burst buffer.
    pub fn append_char_to_buffer(&mut self, ch: char, now: Instant) {
        self.buffer.push(ch);
        self.burst_window_until = Some(now + PASTE_ENTER_SUPPRESS_WINDOW);
    }

    /// Try to append a char only if a burst is already active.
    ///
    /// Returns true if captured, false if not in burst mode.
    pub fn try_append_char_if_active(&mut self, ch: char, now: Instant) -> bool {
        if self.active || !self.buffer.is_empty() {
            self.append_char_to_buffer(ch, now);
            true
        } else {
            false
        }
    }

    /// Decide whether to begin buffering by grabbing recent chars.
    ///
    /// Heuristic: if the grabbed text contains whitespace or is >= 16 chars,
    /// treat it as paste-like to avoid rendering flicker.
    pub fn decide_begin_buffer(
        &mut self,
        now: Instant,
        before: &str,
        retro_chars: usize,
    ) -> Option<RetroGrab> {
        let start_byte = retro_start_index(before, retro_chars);
        let grabbed = before[start_byte..].to_string();
        let looks_pastey =
            grabbed.chars().any(char::is_whitespace) || grabbed.chars().count() >= 16;
        if looks_pastey {
            self.begin_with_retro_grabbed(grabbed.clone(), now);
            Some(RetroGrab {
                start_byte,
                grabbed,
            })
        } else {
            None
        }
    }

    /// Flush the buffer immediately before processing modified/non-char input.
    pub fn flush_before_modified_input(&mut self) -> Option<String> {
        if !self.is_active() {
            return None;
        }
        self.active = false;
        let mut out = std::mem::take(&mut self.buffer);
        if let Some((ch, _)) = self.pending_first_char.take() {
            out.push(ch);
        }
        Some(out)
    }

    /// Clear timing state after non-character input.
    pub fn clear_window_after_non_char(&mut self) {
        self.consecutive_plain_char_burst = 0;
        self.last_plain_char_time = None;
        self.burst_window_until = None;
        self.active = false;
        self.pending_first_char = None;
    }

    /// Check if in any paste-burst related state.
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.is_active_internal() || self.pending_first_char.is_some()
    }

    fn is_active_internal(&self) -> bool {
        self.active || !self.buffer.is_empty()
    }

    /// Clear all state after explicit paste event.
    pub fn clear_after_explicit_paste(&mut self) {
        self.last_plain_char_time = None;
        self.consecutive_plain_char_burst = 0;
        self.burst_window_until = None;
        self.active = false;
        self.buffer.clear();
        self.pending_first_char = None;
    }

    /// Get the current buffer contents (for debugging).
    #[must_use]
    pub fn buffer(&self) -> &str {
        &self.buffer
    }
}

/// Find the byte index to start grabbing `retro_chars` characters from the end.
#[must_use]
pub fn retro_start_index(before: &str, retro_chars: usize) -> usize {
    if retro_chars == 0 {
        return before.len();
    }
    before
        .char_indices()
        .rev()
        .nth(retro_chars.saturating_sub(1))
        .map_or(0, |(idx, _)| idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retro_start_index() {
        assert_eq!(retro_start_index("hello", 0), 5);
        assert_eq!(retro_start_index("hello", 2), 3); // "lo"
        assert_eq!(retro_start_index("hello", 5), 0); // "hello"
        assert_eq!(retro_start_index("hello", 10), 0); // more than available
    }

    #[test]
    fn test_retro_start_index_unicode() {
        let s = "héllo"; // é is 2 bytes
        assert_eq!(retro_start_index(s, 2), 4); // "lo"
        assert_eq!(&s[retro_start_index(s, 2)..], "lo");
    }

    #[test]
    fn test_new_detector_inactive() {
        let d = PasteBurst::new();
        assert!(!d.is_active());
    }

    #[test]
    fn test_single_char_not_burst() {
        let mut d = PasteBurst::new();
        let now = Instant::now();

        // First char should be retained
        let decision = d.on_plain_char('a', now);
        assert!(matches!(decision, CharDecision::RetainFirstChar));

        // After timeout, should flush as typed
        let later = now + Duration::from_millis(20);
        let result = d.flush_if_due(later);
        assert!(matches!(result, FlushResult::Typed('a')));
    }

    #[test]
    fn test_fast_chars_trigger_burst() {
        let mut d = PasteBurst::new();
        let mut now = Instant::now();

        // First char - retained
        let _ = d.on_plain_char('a', now);

        // Second fast char - triggers burst from pending
        now += Duration::from_millis(5);
        let decision = d.on_plain_char('b', now);
        assert!(matches!(decision, CharDecision::BeginBufferFromPending));
        assert!(d.is_active());
    }

    #[test]
    fn test_burst_buffer_flush() {
        let mut d = PasteBurst::new();
        let mut now = Instant::now();

        // Simulate fast typing
        d.on_plain_char('a', now);
        now += Duration::from_millis(5);
        let decision = d.on_plain_char('b', now);

        // Should be buffering now
        if matches!(decision, CharDecision::BeginBufferFromPending) {
            d.append_char_to_buffer('b', now);
        }

        // Add more chars
        now += Duration::from_millis(5);
        d.append_char_to_buffer('c', now);

        // After timeout, should flush as paste
        now += Duration::from_millis(20);
        let result = d.flush_if_due(now);
        assert!(matches!(result, FlushResult::Paste(_)));
    }

    #[test]
    fn test_newline_during_burst() {
        let mut d = PasteBurst::new();
        let mut now = Instant::now();

        // Start a burst
        d.on_plain_char('a', now);
        now += Duration::from_millis(5);
        d.on_plain_char('b', now);
        d.buffer.push('a');
        d.buffer.push('b');
        d.active = true;

        // Newline should be buffered
        assert!(d.append_newline_if_active(now));
        assert!(d.buffer.contains('\n'));
    }

    #[test]
    fn test_recommended_flush_delay() {
        let delay = PasteBurst::recommended_flush_delay();
        assert!(delay > PASTE_BURST_CHAR_INTERVAL);
    }
}

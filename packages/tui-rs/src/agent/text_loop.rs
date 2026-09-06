//! Detects a model repeating itself inside one assistant message.
//!
//! The safety controller in [`crate::agent::safety`] watches tool calls: it
//! blocks three identical consecutive `(tool, args)` pairs. Nothing watches
//! assistant *text*, so a model that starts emitting the same line, or the
//! same short phrase, forever streams until the provider's own output cap
//! stops it. The user pays for every token of that.
//!
//! This detector reads the text deltas as they stream and reports a
//! repetition it is confident about. It runs two independent checks.
//!
//! - Single line: for every new non-whitespace character it asks, for each
//!   period `p` from 1 to [`SINGLE_LINE_MAX_PERIOD`], whether the character
//!   equals the one `p` positions back. A run of such matches means the tail
//!   of the line is periodic with period `p`. `run / p + 1` is the number of
//!   repetitions.
//! - Multiple lines: the same period test over the last
//!   [`MAX_LINE_BUFFER`] whole lines.
//!
//! Both checks need a minimum repetition count *and* a minimum
//! `period * repetitions` product, so one repeated character is not enough
//! and neither is a long line seen twice. Thresholds double inside a fenced
//! code block, where genuine repetition is common, and lines made mostly of
//! box-drawing characters (table rules, ASCII art borders) are excluded
//! outright.
//!
//! The deadline is per call to [`TextLoopDetector::add_text`]. An expired
//! deadline clears accumulated state and fails open for that chunk only, so one
//! slow chunk cannot silently disable detection for the rest of the response.

use std::collections::VecDeque;
use std::time::Instant;

/// Longest single-line period the detector tests.
pub const SINGLE_LINE_MAX_PERIOD: usize = 256;

/// Longest line the detector accumulates. Characters past this are ignored.
const MAX_LINE_LENGTH: usize = 10_000;

/// Minimum repetitions for a multi-line loop outside a code fence.
const MULTI_LINE_MIN_REPETITIONS: usize = 2;
/// Minimum repetitions for a multi-line loop inside a code fence.
const MULTI_LINE_MIN_REPETITIONS_IN_FENCE: usize = 3;
/// Number of whole lines kept for the multi-line period test.
const MAX_LINE_BUFFER: usize = 50 * MULTI_LINE_MIN_REPETITIONS;

/// Minimum repetitions for a single-line loop outside a code fence.
const SINGLE_LINE_MIN_REPETITIONS: usize = 3;
/// Minimum repetitions for a single-line loop inside a code fence.
const SINGLE_LINE_MIN_REPETITIONS_IN_FENCE: usize = 4;
/// Minimum `period * repetitions` for a single-line loop outside a fence.
const SINGLE_LINE_MIN_PERIOD_TIMES_REPS: usize = 100;
/// Minimum `period * repetitions` for a single-line loop inside a fence.
const SINGLE_LINE_MIN_PERIOD_TIMES_REPS_IN_FENCE: usize = 200;

/// Minimum `period * repetitions` for a multi-line loop outside a fence.
const MULTI_LINE_MIN_PERIOD_TIMES_REPS: usize = 3;
/// Minimum `period * repetitions` for a multi-line loop inside a fence.
const MULTI_LINE_MIN_PERIOD_TIMES_REPS_IN_FENCE: usize = 4;
/// Minimum repeated characters for a multi-line loop outside a fence.
const MULTI_LINE_MIN_TOTAL_CHARS: usize = 50;
/// Minimum repeated characters for a multi-line loop inside a fence.
const MULTI_LINE_MIN_TOTAL_CHARS_IN_FENCE: usize = 100;

/// Test the deadline every this many single-line periods.
const SINGLE_LINE_DEADLINE_STRIDE: usize = 32;
/// Test the deadline every this many multi-line periods.
const MULTI_LINE_DEADLINE_STRIDE: usize = 8;

/// A line with at least 4 box-drawing characters per 5 non-whitespace ones
/// is a rule or a border, not prose. Expressed as a ratio of integers so the
/// test never depends on floating-point rounding.
const BOX_BORDER_RATIO_NUMERATOR: usize = 4;
/// Denominator of [`BOX_BORDER_RATIO_NUMERATOR`].
const BOX_BORDER_RATIO_DENOMINATOR: usize = 5;

/// Characters that make up table rules and ASCII art borders.
const BOX_DRAWING_CHARS: &[char] = &[
    '─', '━', '═', '-', '_', '│', '┃', '║', '|', '┌', '┐', '└', '┘', '╔', '╗', '╚', '╝', '┏', '┓',
    '┗', '┛', '╓', '╖', '╙', '╜', '├', '┤', '┬', '┴', '┼', '╟', '╢', '╤', '╧', '╫', '╠', '╣', '╦',
    '╩', '╬', '╞', '╡', '╥', '╨', '╪', '+',
];

/// What kind of repetition the detector found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopKind {
    /// The tail of one line repeats a short string.
    SingleLine {
        /// Length of the repeating unit, in characters.
        period: usize,
        /// How many times that unit repeats.
        repetitions: usize,
        /// The repeating unit itself.
        root: String,
    },
    /// A block of whole lines repeats.
    MultiLine {
        /// Length of the repeating block, in lines.
        period: usize,
        /// How many times that block repeats.
        repetitions: usize,
        /// The repeating block, newline joined.
        pattern: String,
    },
}

impl LoopKind {
    /// Stable identifier for logs and counters.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::SingleLine { .. } => "single_line",
            Self::MultiLine { .. } => "multi_line",
        }
    }

    /// How many times the pattern repeated.
    #[must_use]
    pub fn repetitions(&self) -> usize {
        match self {
            Self::SingleLine { repetitions, .. } | Self::MultiLine { repetitions, .. } => {
                *repetitions
            }
        }
    }

    /// The repeating unit, truncated for logs.
    #[must_use]
    pub fn preview(&self) -> String {
        let pattern = match self {
            Self::SingleLine { root, .. } => root,
            Self::MultiLine { pattern, .. } => pattern,
        };
        pattern.chars().take(120).collect()
    }
}

/// Marker wrapping runtime notes the runner injects into the conversation.
///
/// The model needs to tell an injected note apart from something the user
/// typed. Nothing else in this crate injects such a note today, so this pair
/// is the whole convention: open tag, note, close tag, as one user-role
/// message.
pub const RUNTIME_NOTE_OPEN: &str = "<runtime_note>";
/// Closing half of [`RUNTIME_NOTE_OPEN`].
pub const RUNTIME_NOTE_CLOSE: &str = "</runtime_note>";

/// The steer text injected on the first detected loop.
#[must_use]
pub fn loop_reminder_message(kind: &LoopKind) -> String {
    let specific = match kind {
        LoopKind::SingleLine { .. } => {
            "Your reply repeated the same short text pattern within one line. Stop repeating \
             characters or words."
        }
        LoopKind::MultiLine { .. } => {
            "Your reply repeated the same block of lines. Stop repeating lines and stop \
             retrying the same tool calls."
        }
    };
    format!(
        "{RUNTIME_NOTE_OPEN}Your reply was stopped because it was looping. {specific} If you \
         cannot make progress, say so and ask the user what to do. Do not mention this note to \
         the user.{RUNTIME_NOTE_CLOSE}"
    )
}

/// Streaming repetition detector for one assistant message.
///
/// Feed every text delta to [`TextLoopDetector::add_text`] in order. Call
/// [`TextLoopDetector::reset`] when a new assistant message starts.
#[derive(Debug)]
pub struct TextLoopDetector {
    /// Whole lines seen so far, newest last, capped at [`MAX_LINE_BUFFER`].
    line_buf: VecDeque<String>,
    /// The line being accumulated, as characters for O(1) period indexing.
    current_line: Vec<char>,
    /// Box-drawing characters in `current_line`, kept incrementally so the
    /// border test is O(1) per character instead of O(line length).
    current_box_chars: usize,
    /// Non-whitespace characters in `current_line`, kept the same way.
    current_non_whitespace: usize,
    /// `single_runs[p]` counts consecutive characters matching period `p`.
    single_runs: [u32; SINGLE_LINE_MAX_PERIOD + 1],
    /// `multi_runs[p]` counts consecutive lines matching period `p`.
    multi_runs: Vec<u32>,
    /// Whether the stream is currently inside a fenced code block.
    in_fence: bool,
    /// The loop already reported, if any. Detection is one-shot per message.
    detected: Option<LoopKind>,
}

impl Default for TextLoopDetector {
    fn default() -> Self {
        Self::new()
    }
}

/// The deadline passed while scanning.
struct DeadlineExpired;

impl TextLoopDetector {
    /// Create an empty detector.
    #[must_use]
    pub fn new() -> Self {
        Self {
            line_buf: VecDeque::with_capacity(MAX_LINE_BUFFER),
            current_line: Vec::new(),
            current_box_chars: 0,
            current_non_whitespace: 0,
            single_runs: [0; SINGLE_LINE_MAX_PERIOD + 1],
            multi_runs: vec![0; MAX_LINE_BUFFER + 1],
            in_fence: false,
            detected: None,
        }
    }

    /// The loop this detector already reported, if any.
    #[must_use]
    pub fn detected(&self) -> Option<&LoopKind> {
        self.detected.as_ref()
    }

    /// Forget everything. Call this when a new assistant message starts.
    pub fn reset(&mut self) {
        self.line_buf.clear();
        self.current_line.clear();
        self.current_box_chars = 0;
        self.current_non_whitespace = 0;
        self.single_runs.fill(0);
        self.multi_runs.fill(0);
        self.in_fence = false;
        self.detected = None;
    }

    /// Feed one streamed text delta.
    ///
    /// Returns the loop on the delta that completes it, and `None` otherwise.
    /// A detector that already reported a loop keeps returning that loop
    /// without rescanning.
    ///
    /// `deadline` bounds this call only. If it passes mid-scan the detector
    /// drops the rest of the delta, clears its state, and returns `None`;
    /// the next call starts over rather than being disabled for good.
    pub fn add_text(&mut self, delta: &str, deadline: Instant) -> Option<LoopKind> {
        if self.detected.is_some() {
            return self.detected.clone();
        }
        for character in delta.chars() {
            if character == '\n' {
                match self.finish_line(deadline) {
                    Err(DeadlineExpired) => {
                        self.reset();
                        return None;
                    }
                    Ok(Some(kind)) => {
                        self.detected = Some(kind.clone());
                        return Some(kind);
                    }
                    Ok(None) => {}
                }
                continue;
            }
            match self.push_character(character, deadline) {
                Err(DeadlineExpired) => {
                    self.reset();
                    return None;
                }
                Ok(Some(kind)) => {
                    self.detected = Some(kind.clone());
                    return Some(kind);
                }
                Ok(None) => {}
            }
        }
        None
    }

    /// Append one non-newline character and run the single-line period test.
    fn push_character(
        &mut self,
        character: char,
        deadline: Instant,
    ) -> Result<Option<LoopKind>, DeadlineExpired> {
        if self.current_line.len() >= MAX_LINE_LENGTH {
            return Ok(None);
        }
        self.current_line.push(character);
        if !character.is_whitespace() {
            self.current_non_whitespace += 1;
        }
        if BOX_DRAWING_CHARS.contains(&character) {
            self.current_box_chars += 1;
        }
        if character.is_whitespace() || self.current_line_is_box_border() {
            return Ok(None);
        }
        let position = self.current_line.len() - 1;
        let max_period = SINGLE_LINE_MAX_PERIOD.min(position);
        let (min_repetitions, min_period_times_reps) = if self.in_fence {
            (
                SINGLE_LINE_MIN_REPETITIONS_IN_FENCE,
                SINGLE_LINE_MIN_PERIOD_TIMES_REPS_IN_FENCE,
            )
        } else {
            (
                SINGLE_LINE_MIN_REPETITIONS,
                SINGLE_LINE_MIN_PERIOD_TIMES_REPS,
            )
        };
        for period in 1..=max_period {
            if period % SINGLE_LINE_DEADLINE_STRIDE == 0 && Instant::now() >= deadline {
                return Err(DeadlineExpired);
            }
            if self.current_line[position] == self.current_line[position - period] {
                self.single_runs[period] = self.single_runs[period].saturating_add(1);
                let matched = self.single_runs[period] as usize;
                let repetitions = matched / period + 1;
                if repetitions >= min_repetitions && period * repetitions >= min_period_times_reps {
                    let root = self.current_line[self.current_line.len() - period..]
                        .iter()
                        .collect();
                    return Ok(Some(LoopKind::SingleLine {
                        period,
                        repetitions,
                        root,
                    }));
                }
            } else {
                self.single_runs[period] = 0;
            }
        }
        Ok(None)
    }

    /// Close the current line, update fence state, and run the line test.
    fn finish_line(&mut self, deadline: Instant) -> Result<Option<LoopKind>, DeadlineExpired> {
        let line: String = self.current_line.iter().collect();
        let was_box_border = self.current_line_is_box_border();
        self.current_line.clear();
        self.current_box_chars = 0;
        self.current_non_whitespace = 0;
        self.single_runs.fill(0);
        update_fence_state(&mut self.in_fence, &line);
        if line.trim().is_empty() || was_box_border {
            return Ok(None);
        }
        if self.line_buf.len() == MAX_LINE_BUFFER {
            self.line_buf.pop_front();
        }
        self.line_buf.push_back(line);
        self.check_multi_line(deadline)
    }

    /// Whether the line so far is mostly box-drawing characters.
    ///
    /// Table rules and ASCII art borders repeat by construction; treating
    /// them as prose would report every wide table as a loop.
    fn current_line_is_box_border(&self) -> bool {
        if self.current_non_whitespace == 0 {
            return false;
        }
        self.current_box_chars * BOX_BORDER_RATIO_DENOMINATOR
            >= self.current_non_whitespace * BOX_BORDER_RATIO_NUMERATOR
    }

    /// Period test over whole lines.
    fn check_multi_line(&mut self, deadline: Instant) -> Result<Option<LoopKind>, DeadlineExpired> {
        let count = self.line_buf.len();
        if count < 2 {
            return Ok(None);
        }
        let max_period = (count - 1).min(MAX_LINE_BUFFER - 1);
        let (min_repetitions, min_period_times_reps, min_total_chars) = if self.in_fence {
            (
                MULTI_LINE_MIN_REPETITIONS_IN_FENCE,
                MULTI_LINE_MIN_PERIOD_TIMES_REPS_IN_FENCE,
                MULTI_LINE_MIN_TOTAL_CHARS_IN_FENCE,
            )
        } else {
            (
                MULTI_LINE_MIN_REPETITIONS,
                MULTI_LINE_MIN_PERIOD_TIMES_REPS,
                MULTI_LINE_MIN_TOTAL_CHARS,
            )
        };
        for period in 1..=max_period {
            if period % MULTI_LINE_DEADLINE_STRIDE == 0 && Instant::now() >= deadline {
                return Err(DeadlineExpired);
            }
            if self.line_buf[count - 1] != self.line_buf[count - 1 - period] {
                self.multi_runs[period] = 0;
                continue;
            }
            self.multi_runs[period] = self.multi_runs[period].saturating_add(1);
            let matched = self.multi_runs[period] as usize;
            let repetitions = matched / period + 1;
            if repetitions < min_repetitions || period * repetitions < min_period_times_reps {
                continue;
            }
            let pattern: Vec<&String> = self.line_buf.iter().skip(count - period).collect();
            let root_chars: usize = pattern.iter().map(|line| line.chars().count()).sum();
            if root_chars * repetitions < min_total_chars {
                continue;
            }
            let pattern = pattern
                .into_iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(Some(LoopKind::MultiLine {
                period,
                repetitions,
                pattern,
            }));
        }
        Ok(None)
    }
}

/// Toggle fence state when a line carries an odd number of fence markers.
///
/// A marker is a run of three or more backticks. `` ```rust `` opens, a bare
/// ` ``` ` closes, and an inline `` `code` `` span is not a marker at all.
fn update_fence_state(in_fence: &mut bool, line: &str) {
    let mut markers = 0usize;
    let mut run = 0usize;
    for character in line.chars() {
        if character == '`' {
            run += 1;
            continue;
        }
        if run >= 3 {
            markers += 1;
        }
        run = 0;
    }
    if run >= 3 {
        markers += 1;
    }
    if markers % 2 == 1 {
        *in_fence = !*in_fence;
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{LoopKind, TextLoopDetector, loop_reminder_message};

    fn budget() -> Instant {
        Instant::now() + Duration::from_millis(500)
    }

    fn feed(detector: &mut TextLoopDetector, text: &str) -> Option<LoopKind> {
        detector.add_text(text, budget())
    }

    #[test]
    fn forty_repeated_lines_are_reported_as_a_multi_line_loop() {
        let mut detector = TextLoopDetector::new();
        let mut found = None;
        for _ in 0..40 {
            if let Some(kind) = feed(&mut detector, "Still working on the same subtask.\n") {
                found = Some(kind);
                break;
            }
        }
        let kind = found.expect("40 identical lines must be reported as a loop");
        assert_eq!(kind.label(), "multi_line");
        assert!(kind.repetitions() >= 2, "{kind:?}");
    }

    #[test]
    fn a_long_markdown_table_with_box_rules_is_not_a_loop() {
        let mut detector = TextLoopDetector::new();
        let mut table = String::from("| id | owner | status |\n|----|-------|--------|\n");
        for row in 0..300 {
            table.push_str(&format!("| {row} | owner-{row} | state-{row} |\n"));
        }
        assert_eq!(
            feed(&mut detector, &table),
            None,
            "a table with distinct rows and box rules must not be a loop"
        );
    }

    #[test]
    fn repetitive_code_inside_a_fence_needs_the_doubled_threshold() {
        let repeated = "    buffer.push(item);\n";

        let mut fenced = TextLoopDetector::new();
        let mut fenced_text = String::from("```rust\n");
        for _ in 0..4 {
            fenced_text.push_str(repeated);
        }
        assert_eq!(
            feed(&mut fenced, &fenced_text),
            None,
            "four identical lines inside a code fence are under the fenced threshold"
        );

        let mut plain = TextLoopDetector::new();
        let mut plain_text = String::new();
        for _ in 0..4 {
            plain_text.push_str(repeated);
        }
        assert!(
            feed(&mut plain, &plain_text).is_some(),
            "the same four lines outside a fence are over the plain threshold"
        );

        // The fence is not a permanent exemption: enough repetitions inside
        // one still trips the higher bar.
        let mut long_fenced = TextLoopDetector::new();
        let mut long_text = String::from("```rust\n");
        for _ in 0..12 {
            long_text.push_str(repeated);
        }
        assert!(
            feed(&mut long_fenced, &long_text).is_some(),
            "twelve identical lines inside a fence must still be reported"
        );
    }

    #[test]
    fn a_long_single_line_repetition_is_reported() {
        let mut detector = TextLoopDetector::new();
        let kind = feed(&mut detector, &"nope".repeat(60))
            .expect("a line repeating one word 60 times must be reported");
        assert_eq!(kind.label(), "single_line");
    }

    #[test]
    fn normal_prose_is_not_a_loop() {
        let mut detector = TextLoopDetector::new();
        let prose = "I read the file and found the handler. It parses the request, validates \
                     the token, and writes an audit row. The failing case is the missing \
                     workspace id, which the parser treats as empty rather than absent.\n";
        assert_eq!(feed(&mut detector, prose), None);
    }

    #[test]
    fn an_expired_deadline_fails_open_and_the_next_chunk_still_detects() {
        let mut detector = TextLoopDetector::new();
        let mut looping = String::new();
        for _ in 0..40 {
            looping.push_str("Still working on the same subtask.\n");
        }

        // A deadline captured now is already reached by the time the scan
        // tests it, which is what an expired budget looks like.
        let expired = Instant::now();
        assert_eq!(
            detector.add_text(&looping, expired),
            None,
            "an expired deadline must fail open"
        );
        assert!(detector.detected().is_none());

        assert!(
            detector.add_text(&looping, budget()).is_some(),
            "the detector must resume on the next chunk rather than latch off"
        );
    }

    #[test]
    fn a_reported_loop_is_returned_again_without_rescanning() {
        let mut detector = TextLoopDetector::new();
        let mut found = None;
        for _ in 0..40 {
            if let Some(kind) = feed(&mut detector, "Same line again.\n") {
                found = Some(kind);
                break;
            }
        }
        let first = found.expect("loop");
        assert_eq!(feed(&mut detector, "unrelated text\n"), Some(first));
    }

    #[test]
    fn the_reminder_names_the_loop_kind_and_stays_internal() {
        let single = loop_reminder_message(&LoopKind::SingleLine {
            period: 4,
            repetitions: 30,
            root: "nope".to_string(),
        });
        assert!(single.starts_with("<runtime_note>"), "{single}");
        assert!(single.ends_with("</runtime_note>"), "{single}");
        assert!(single.contains("within one line"), "{single}");

        let multi = loop_reminder_message(&LoopKind::MultiLine {
            period: 1,
            repetitions: 12,
            pattern: "same".to_string(),
        });
        assert!(multi.contains("block of lines"), "{multi}");
        assert!(multi.contains("Do not mention this note"), "{multi}");
    }
}

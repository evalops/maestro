//! Word wrapping utilities ported from OpenAI Codex (MIT licensed)
//!
//! This module provides intelligent word wrapping for styled text, preserving ratatui
//! span styles across line breaks. It's ported from OpenAI Codex under the MIT license.
//!
//! # Key Features
//!
//! - **Style Preservation**: Text attributes (color, bold, italic) are maintained when
//!   lines wrap, splitting spans at wrap points and continuing them on the next line.
//!
//! - **Optimal Fit Algorithm**: Uses the textwrap crate's optimal fit algorithm which
//!   minimizes raggedness across all lines using dynamic programming, producing visually
//!   balanced output similar to TeX's line breaking.
//!
//! - **Styled Indentation**: Supports different indents for the first line vs subsequent
//!   lines, with each indent being a styled `Line` (not just a string), allowing for
//!   colored or formatted indentation markers.
//!
//! # External Crates
//!
//! - **textwrap**: Provides the underlying word wrapping algorithms (optimal fit, first fit)
//!   and handles edge cases like long words, hyphenation, and CJK text.
//! - **ratatui**: Provides the `Line` and `Span` types for styled text.
//!
//! # Common Patterns
//!
//! This module is used throughout the codebase for:
//! - Wrapping chat messages in the conversation view
//! - Wrapping code block content when displaying diffs
//! - Wrapping markdown content in the pager
//! - Pushing styled history lines into terminal scrollback
//!
//! # Example
//!
//! ```
//! use ratatui::text::Line;
//! use maestro_tui::wrapping::{word_wrap_line, RtOptions};
//!
//! let line = Line::from("This is a very long line that needs to be wrapped");
//! let options = RtOptions::new(40)
//!     .initial_indent(Line::from("  "))
//!     .subsequent_indent(Line::from("    "));
//! let wrapped = word_wrap_line(&line, options);
//! ```

use ratatui::text::{Line, Span};
use std::ops::Range;
use textwrap::wrap_algorithms::Penalties;
use textwrap::Options;

/// Like `wrap_ranges` but returns ranges without trailing whitespace.
/// Suitable for general wrapping where trailing spaces should not be preserved.
fn wrap_ranges_trim<'a, O>(text: &str, width_or_options: O) -> Vec<Range<usize>>
where
    O: Into<Options<'a>>,
{
    let opts = width_or_options.into();
    let mut lines: Vec<Range<usize>> = Vec::new();
    for line in &textwrap::wrap(text, opts) {
        match line {
            std::borrow::Cow::Borrowed(slice) => {
                let start = unsafe { slice.as_ptr().offset_from(text.as_ptr()) as usize };
                let end = start + slice.len();
                lines.push(start..end);
            }
            std::borrow::Cow::Owned(_) => {
                // For owned strings, we can't compute byte offsets, skip
                continue;
            }
        }
    }
    lines
}

/// Options for rich text wrapping with styled indents
#[derive(Debug, Clone)]
pub struct RtOptions<'a> {
    /// The width in columns at which the text will be wrapped.
    pub width: usize,
    /// Indentation used for the first line of output.
    pub initial_indent: Line<'a>,
    /// Indentation used for subsequent lines of output.
    pub subsequent_indent: Line<'a>,
    /// Allow long words to be broken if they cannot fit on a line.
    pub break_words: bool,
}

impl From<usize> for RtOptions<'_> {
    fn from(width: usize) -> Self {
        RtOptions::new(width)
    }
}

impl<'a> RtOptions<'a> {
    #[must_use]
    pub fn new(width: usize) -> Self {
        RtOptions {
            width,
            initial_indent: Line::default(),
            subsequent_indent: Line::default(),
            break_words: true,
        }
    }

    #[must_use]
    pub fn initial_indent(self, initial_indent: Line<'a>) -> Self {
        RtOptions {
            initial_indent,
            ..self
        }
    }

    #[must_use]
    pub fn subsequent_indent(self, subsequent_indent: Line<'a>) -> Self {
        RtOptions {
            subsequent_indent,
            ..self
        }
    }
}

/// Wrap a single styled line, preserving span styles across line breaks
#[must_use]
pub fn word_wrap_line<'a, O>(line: &'a Line<'a>, width_or_options: O) -> Vec<Line<'a>>
where
    O: Into<RtOptions<'a>>,
{
    // Flatten the line and record span byte ranges
    let mut flat = String::new();
    let mut span_bounds = Vec::new();
    let mut acc = 0usize;
    for s in &line.spans {
        let text = s.content.as_ref();
        let start = acc;
        flat.push_str(text);
        acc += text.len();
        span_bounds.push((start..acc, s.style));
    }

    let rt_opts: RtOptions<'a> = width_or_options.into();
    let opts = Options::new(rt_opts.width)
        .break_words(rt_opts.break_words)
        .wrap_algorithm(textwrap::WrapAlgorithm::OptimalFit(Penalties {
            overflow_penalty: usize::MAX / 4,
            ..Default::default()
        }));

    let mut out: Vec<Line<'a>> = Vec::new();

    // Compute first line range with reduced width due to initial indent
    let initial_width_available = opts
        .width
        .saturating_sub(rt_opts.initial_indent.width())
        .max(1);
    let initial_wrapped = wrap_ranges_trim(&flat, opts.clone().width(initial_width_available));
    let Some(first_line_range) = initial_wrapped.first() else {
        return vec![rt_opts.initial_indent.clone()];
    };

    // Build first wrapped line with initial indent
    let mut first_line = rt_opts.initial_indent.clone().style(line.style);
    {
        let sliced = slice_line_spans(line, &span_bounds, first_line_range);
        let mut spans = first_line.spans;
        spans.extend(sliced.spans.into_iter().map(|s| s.patch_style(line.style)));
        first_line.spans = spans;
        out.push(first_line);
    }

    // Wrap the remainder using subsequent indent width
    let base = first_line_range.end;
    let skip_leading_spaces = flat[base..].chars().take_while(|c| *c == ' ').count();
    let base = base + skip_leading_spaces;
    let subsequent_width_available = opts
        .width
        .saturating_sub(rt_opts.subsequent_indent.width())
        .max(1);
    let remaining_wrapped = wrap_ranges_trim(&flat[base..], opts.width(subsequent_width_available));
    for r in &remaining_wrapped {
        if r.is_empty() {
            continue;
        }
        let mut subsequent_line = rt_opts.subsequent_indent.clone().style(line.style);
        let offset_range = (r.start + base)..(r.end + base);
        let sliced = slice_line_spans(line, &span_bounds, &offset_range);
        let mut spans = subsequent_line.spans;
        spans.extend(sliced.spans.into_iter().map(|s| s.patch_style(line.style)));
        subsequent_line.spans = spans;
        out.push(subsequent_line);
    }

    out
}

/// Wrap a sequence of lines, applying the initial indent only to the very first
/// output line, and using the subsequent indent for all later wrapped pieces.
pub fn word_wrap_lines<'a, O>(lines: &[Line<'a>], width_or_options: O) -> Vec<Line<'static>>
where
    O: Into<RtOptions<'a>>,
{
    let base_opts: RtOptions<'a> = width_or_options.into();
    let mut out: Vec<Line<'static>> = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let opts = if idx == 0 {
            base_opts.clone()
        } else {
            let mut o = base_opts.clone();
            let sub = o.subsequent_indent.clone();
            o = o.initial_indent(sub);
            o
        };
        let wrapped = word_wrap_line(line, opts);
        for l in wrapped {
            out.push(line_to_owned(&l));
        }
    }

    out
}

/// Convert a borrowed line to an owned line
fn line_to_owned(line: &Line<'_>) -> Line<'static> {
    Line {
        spans: line
            .spans
            .iter()
            .map(|s| Span {
                content: s.content.to_string().into(),
                style: s.style,
            })
            .collect(),
        style: line.style,
        alignment: line.alignment,
    }
}

fn slice_line_spans<'a>(
    original: &'a Line<'a>,
    span_bounds: &[(Range<usize>, ratatui::style::Style)],
    range: &Range<usize>,
) -> Line<'a> {
    let start_byte = range.start;
    let end_byte = range.end;
    let mut acc: Vec<Span<'a>> = Vec::new();
    for (i, (r, style)) in span_bounds.iter().enumerate() {
        let s = r.start;
        let e = r.end;
        if e <= start_byte {
            continue;
        }
        if s >= end_byte {
            break;
        }
        let seg_start = start_byte.max(s);
        let seg_end = end_byte.min(e);
        if seg_end > seg_start {
            let local_start = seg_start - s;
            let local_end = seg_end - s;
            let content = original.spans[i].content.as_ref();
            let slice = &content[local_start..local_end];
            acc.push(Span {
                style: *style,
                content: std::borrow::Cow::Borrowed(slice),
            });
        }
        if e >= end_byte {
            break;
        }
    }
    Line {
        style: original.style,
        alignment: original.alignment,
        spans: acc,
    }
}

/// Count the total number of wrapped lines for a Text.
///
/// This is useful for calculating content height in viewports.
#[must_use]
pub fn wrapped_line_count(text: &ratatui::text::Text, width: usize) -> usize {
    if width == 0 {
        return 0;
    }
    text.lines
        .iter()
        .map(|line| word_wrap_line(line, width).len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use ratatui::style::Color;
    use ratatui::style::Stylize;

    fn concat_line(line: &Line) -> String {
        line.spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn trivial_unstyled_no_indents_wide_width() {
        let line = Line::from("hello");
        let out = word_wrap_line(&line, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(concat_line(&out[0]), "hello");
    }

    #[test]
    fn simple_unstyled_wrap_narrow_width() {
        let line = Line::from("hello world");
        let out = word_wrap_line(&line, 5);
        assert_eq!(out.len(), 2);
        assert_eq!(concat_line(&out[0]), "hello");
        assert_eq!(concat_line(&out[1]), "world");
    }

    #[test]
    fn simple_styled_wrap_preserves_styles() {
        let line = Line::from(vec!["hello ".red(), "world".into()]);
        let out = word_wrap_line(&line, 6);
        assert_eq!(out.len(), 2);
        // First line should carry the red style
        assert_eq!(concat_line(&out[0]), "hello");
        assert_eq!(out[0].spans.len(), 1);
        assert_eq!(out[0].spans[0].style.fg, Some(Color::Red));
        // Second line is unstyled
        assert_eq!(concat_line(&out[1]), "world");
        assert_eq!(out[1].spans.len(), 1);
        assert_eq!(out[1].spans[0].style.fg, None);
    }

    #[test]
    fn with_initial_and_subsequent_indents() {
        let opts = RtOptions::new(8)
            .initial_indent(Line::from("- "))
            .subsequent_indent(Line::from("  "));
        let line = Line::from("hello world foo");
        let out = word_wrap_line(&line, opts);
        // Expect three lines with proper prefixes
        assert!(concat_line(&out[0]).starts_with("- "));
        assert!(concat_line(&out[1]).starts_with("  "));
        assert!(concat_line(&out[2]).starts_with("  "));
    }

    #[test]
    fn empty_input_yields_single_empty_line() {
        let line = Line::from("");
        let out = word_wrap_line(&line, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(concat_line(&out[0]), "");
    }
}

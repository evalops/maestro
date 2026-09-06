//! Sanitization for content that reaches a real terminal outside ratatui.
//!
//! `ratatui::buffer::Buffer::set_stringn` filters `char::is_control()` before
//! any styled span reaches the TTY, so content rendered through ratatui's
//! `Buffer` is already safe from ANSI/OSC/CSI escape injection. Every code
//! path in this crate that writes to stdout/stderr *without* going through
//! that `Buffer` (single-shot `--print` output, the remote-attach REPL,
//! native scrollback writers, OSC helper builders, ...) has no such
//! protection unless it calls [`sanitize_control_chars`] itself.
//!
//! # Where to sanitize
//!
//! Sanitize at the output boundary — the `print!`/`write!`/`queue!(Print(_))`
//! call site, or inside a "safe by construction" primitive like
//! [`crate::hyperlink::format_link`] — not upstream at ingestion. The same
//! provider/network content legitimately flows to the TUI (where ratatui's
//! `Buffer` filters it) and to `--json` output (where `serde_json` escapes
//! control characters as `\u00XX`). Filtering it earlier would either be
//! redundant (TUI/JSON paths) or double-escape JSON output.

/// Strip terminal control characters that could be interpreted as the start
/// of an ANSI/OSC/CSI escape sequence, while preserving plain-text
/// legibility.
///
/// Preserved: tab (`\t`), newline (`\n`), carriage return (`\r`).
///
/// Removed: NUL and other C0 controls (`\x00`-`\x08`, `\x0B`-`\x0C`,
/// `\x0E`-`\x1F`, including ESC `\x1B`), DEL (`\x7F`), and C1 controls
/// (`\u{0080}`-`\u{009F}`, which some terminals also treat as escape
/// introducers in 8-bit-C1 mode).
///
/// # Performance
///
/// For the common case of a clean ASCII chunk (the vast majority of
/// streamed provider text), this does a single byte scan and returns
/// without any per-character filtering pass or extra copy beyond the one
/// owned `String` the caller needs anyway.
#[must_use]
pub fn sanitize_control_chars(s: &str) -> String {
    if s.is_ascii()
        && !s
            .bytes()
            .any(|b| (b < 0x20 && b != 0x09 && b != 0x0A && b != 0x0D) || b == 0x7F)
    {
        return s.to_string();
    }

    s.chars()
        .filter(|&c| {
            match c {
                // Allow tab, newline, carriage return
                '\t' | '\n' | '\r' => true,
                // Filter C0 controls (except those above) and DEL
                '\x00'..='\x08' | '\x0B'..='\x0C' | '\x0E'..='\x1F' | '\x7F' => false,
                // Filter C1 controls
                '\u{0080}'..='\u{009F}' => false,
                // Allow everything else
                _ => true,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_whitespace() {
        let input = "Line 1\nLine 2\tTabbed\rCarriage";
        assert_eq!(sanitize_control_chars(input), input);
    }

    #[test]
    fn removes_nul() {
        let input = "Hello\x00World";
        assert_eq!(sanitize_control_chars(input), "HelloWorld");
    }

    #[test]
    fn removes_bell() {
        let input = "Alert\x07Sound";
        assert_eq!(sanitize_control_chars(input), "AlertSound");
    }

    #[test]
    fn removes_backspace() {
        let input = "Type\x08Over";
        assert_eq!(sanitize_control_chars(input), "TypeOver");
    }

    #[test]
    fn removes_del_with_no_other_control_bytes() {
        // Regression test: DEL (0x7F) is ASCII and is NOT `< 0x20`, so an
        // all-ASCII string containing only DEL (no other C0 control byte)
        // used to satisfy the fast path's bypass condition and be returned
        // unchanged, silently defeating this function's own documented
        // promise to remove DEL.
        let input = "Type\x7FOver";
        let out = sanitize_control_chars(input);
        assert_eq!(out, "TypeOver");
        assert!(!out.contains('\x7F'));
    }

    #[test]
    fn removes_c1() {
        let input = "Test\u{0080}C1\u{009F}End";
        assert_eq!(sanitize_control_chars(input), "TestC1End");
    }

    #[test]
    fn strips_escape_and_osc_title_injection() {
        // A minimal OSC-0 (set title) sequence: ESC ] 0 ; x BEL
        let input = "before\x1b]0;x\x07after";
        let out = sanitize_control_chars(input);
        assert_eq!(out, "before]0;xafter");
        assert!(!out.contains('\x1b'));
        assert!(!out.contains('\x07'));
    }

    #[test]
    fn strips_csi_sequence_preserves_visible_text() {
        // CSI: ESC [ 2 J (clear screen)
        let input = "safe\x1b[2Jtext";
        let out = sanitize_control_chars(input);
        assert_eq!(out, "safe[2Jtext");
        assert!(!out.contains('\x1b'));
    }

    #[test]
    fn clean_ascii_fast_path_returns_equal_string() {
        let input = "ordinary streamed text with no control bytes";
        assert_eq!(sanitize_control_chars(input), input);
    }
}

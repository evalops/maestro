//! Unicode sanitization utilities for AI API interactions
//!
//! This module provides functions to sanitize strings before sending them to AI APIs.
//! The main use case is removing unpaired UTF-16 surrogates that can cause JSON
//! serialization errors.
//!
//! # Background
//!
//! UTF-16 surrogates (U+D800 to U+DFFF) are used in pairs to encode characters
//! outside the Basic Multilingual Plane (BMP). When JavaScript strings contain
//! unpaired surrogates (lone high or low surrogates), they can cause issues:
//!
//! 1. JSON.stringify() may produce invalid UTF-8
//! 2. API servers may reject the malformed JSON
//! 3. serde_json serialization may fail or produce unexpected results
//!
//! While Rust strings are valid UTF-8 by construction, unpaired surrogates can
//! enter the system when:
//! - Reading from external sources (files, network)
//! - Processing user input that was corrupted
//! - Interoperating with JavaScript/WebAssembly code
//!
//! # Example
//!
//! ```rust
//! use composer_tui::ai::sanitize::sanitize_surrogates;
//!
//! // Clean string passes through unchanged
//! assert_eq!(sanitize_surrogates("Hello 世界"), "Hello 世界");
//!
//! // Strings with surrogates have them removed
//! // (Note: In practice, Rust strings can't contain surrogates,
//! // but this handles edge cases from external data)
//! ```

/// Sanitize a string by removing unpaired UTF-16 surrogates.
///
/// UTF-16 surrogate code points (U+D800-U+DFFF) should only appear in pairs.
/// When they appear alone, they're invalid and can cause JSON serialization issues.
///
/// Since Rust strings are valid UTF-8, they cannot contain actual surrogate
/// code points. However, this function handles edge cases where:
/// 1. Data was incorrectly transcoded from other encodings
/// 2. Replacement characters were used inconsistently
///
/// # Arguments
///
/// * `s` - The string to sanitize
///
/// # Returns
///
/// A new string with any surrogate code points removed. If the input contains
/// no surrogates (the common case), this returns a clone of the input.
///
/// # Performance
///
/// For strings without surrogates (the common case), this function performs
/// a single scan without allocation. Only when surrogates are found does it
/// allocate a new string.
pub fn sanitize_surrogates(s: &str) -> String {
    // Rust strings are UTF-8, so they can't actually contain surrogates.
    // However, we check for the UTF-8 encoding of what would be surrogate
    // code points (which is technically invalid UTF-8).
    //
    // In practice, String::from_utf8_lossy would already replace these with
    // the replacement character (U+FFFD). This function provides an additional
    // layer of defense by removing any remaining suspicious patterns.

    // Quick check: if string is ASCII, no surrogates possible
    if s.is_ascii() {
        return s.to_string();
    }

    // For UTF-8 strings, surrogates would be encoded as 3-byte sequences:
    // High surrogates (D800-DBFF): ED A0 80 to ED AF BF
    // Low surrogates (DC00-DFFF): ED B0 80 to ED BF BF
    //
    // However, valid UTF-8 cannot contain these sequences. If they somehow
    // exist (e.g., from a bug in transcoding), we remove them.

    let bytes = s.as_bytes();

    // Scan for potential surrogate-like sequences
    let has_potential_issues = bytes
        .windows(3)
        .any(|w| w[0] == 0xED && (w[1] >= 0xA0 && w[1] <= 0xBF));

    if !has_potential_issues {
        return s.to_string();
    }

    // Filter out surrogate-like sequences
    let mut result = String::with_capacity(s.len());

    for c in s.chars() {
        // Check if this char is in the surrogate range
        // Note: This shouldn't happen in valid Rust strings, but handle defensively
        let code_point = c as u32;
        if !(0xD800..=0xDFFF).contains(&code_point) {
            result.push(c);
        }
        // Surrogates are silently dropped
    }

    result
}

/// Sanitize a string by replacing non-printable control characters.
///
/// Some control characters can cause issues with terminal display or
/// API processing. This function replaces them with safe alternatives.
///
/// Preserved characters:
/// - Tab (U+0009)
/// - Newline (U+000A)
/// - Carriage return (U+000D)
///
/// Removed characters:
/// - NUL (U+0000) - Can truncate strings
/// - Other C0 controls (U+0001-U+0008, U+000B-U+000C, U+000E-U+001F)
/// - DEL (U+007F)
/// - C1 controls (U+0080-U+009F)
pub fn sanitize_control_chars(s: &str) -> String {
    if s.is_ascii()
        && !s
            .bytes()
            .any(|b| b < 0x20 && b != 0x09 && b != 0x0A && b != 0x0D)
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

/// Fully sanitize a string for API transmission.
///
/// This combines surrogate and control character sanitization into a single
/// pass for efficiency.
///
/// # Arguments
///
/// * `s` - The string to sanitize
///
/// # Returns
///
/// A sanitized string safe for JSON serialization and API transmission.
pub fn sanitize_for_api(s: &str) -> String {
    // For ASCII strings without control chars, return quickly
    if s.is_ascii()
        && !s
            .bytes()
            .any(|b| b < 0x20 && b != 0x09 && b != 0x0A && b != 0x0D)
    {
        return s.to_string();
    }

    s.chars()
        .filter(|&c| {
            let code_point = c as u32;

            // Remove surrogates (shouldn't exist in valid UTF-8)
            if (0xD800..=0xDFFF).contains(&code_point) {
                return false;
            }

            // Handle control characters
            match c {
                '\t' | '\n' | '\r' => true,
                '\x00'..='\x08' | '\x0B'..='\x0C' | '\x0E'..='\x1F' | '\x7F' => false,
                '\u{0080}'..='\u{009F}' => false,
                _ => true,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_surrogates_clean_string() {
        let input = "Hello, World!";
        assert_eq!(sanitize_surrogates(input), input);
    }

    #[test]
    fn test_sanitize_surrogates_unicode() {
        let input = "Hello 世界 🌍 مرحبا";
        assert_eq!(sanitize_surrogates(input), input);
    }

    #[test]
    fn test_sanitize_surrogates_empty() {
        assert_eq!(sanitize_surrogates(""), "");
    }

    #[test]
    fn test_sanitize_surrogates_ascii_fast_path() {
        // ASCII-only strings should hit the fast path
        let input = "This is a test with only ASCII characters 123!@#";
        assert_eq!(sanitize_surrogates(input), input);
    }

    #[test]
    fn test_sanitize_control_chars_preserves_whitespace() {
        let input = "Line 1\nLine 2\tTabbed\rCarriage";
        assert_eq!(sanitize_control_chars(input), input);
    }

    #[test]
    fn test_sanitize_control_chars_removes_nul() {
        let input = "Hello\x00World";
        assert_eq!(sanitize_control_chars(input), "HelloWorld");
    }

    #[test]
    fn test_sanitize_control_chars_removes_bell() {
        let input = "Alert\x07Sound";
        assert_eq!(sanitize_control_chars(input), "AlertSound");
    }

    #[test]
    fn test_sanitize_control_chars_removes_backspace() {
        let input = "Type\x08Over";
        assert_eq!(sanitize_control_chars(input), "TypeOver");
    }

    #[test]
    fn test_sanitize_control_chars_removes_c1() {
        let input = "Test\u{0080}C1\u{009F}End";
        assert_eq!(sanitize_control_chars(input), "TestC1End");
    }

    #[test]
    fn test_sanitize_for_api_combined() {
        // Test that both sanitizations work together
        let input = "Hello\x00World\nNew\x07Line";
        assert_eq!(sanitize_for_api(input), "HelloWorld\nNewLine");
    }

    #[test]
    fn test_sanitize_for_api_preserves_emoji() {
        let input = "🎉 Party time! 🎊";
        assert_eq!(sanitize_for_api(input), input);
    }

    #[test]
    fn test_sanitize_for_api_preserves_cjk() {
        let input = "日本語テスト Chinese: 中文 Korean: 한국어";
        assert_eq!(sanitize_for_api(input), input);
    }

    #[test]
    fn test_sanitize_for_api_preserves_rtl() {
        let input = "RTL: مرحبا בשלום";
        assert_eq!(sanitize_for_api(input), input);
    }

    #[test]
    fn test_sanitize_for_api_empty() {
        assert_eq!(sanitize_for_api(""), "");
    }

    #[test]
    fn test_sanitize_for_api_only_whitespace() {
        let input = "\n\t\r\n\t";
        assert_eq!(sanitize_for_api(input), input);
    }
}

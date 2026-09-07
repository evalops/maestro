//! Pure repair for context envelopes that were cut during compaction.
//!
//! Tool protocol code owns deciding which output is untrusted and how it is
//! wrapped. Context owns only the framing repair needed after truncation: a
//! summary or bounded tool result must never leave an opening envelope around
//! the trusted text that follows it.

/// Shared envelope tag used by tool-output wrapping and compaction repair.
pub const UNTRUSTED_CONTENT_TAG: &str = "untrusted_content";

/// Repair a dangling, unclosed `<untrusted_content ...>` opening tag left by
/// truncating or eliding already-wrapped content mid-body.
///
/// Every opening tag occurrence is validated. If an opener is cut inside its
/// attributes, the incomplete fragment is replaced by a provenance-free empty
/// envelope. Complete openers receive enough closing tags to balance the
/// literal structure. A no-op is returned for already balanced or unwrapped
/// text.
#[must_use]
pub fn close_dangling_untrusted_content_envelope(text: &str) -> String {
    let open_prefix = format!("<{UNTRUSTED_CONTENT_TAG}");
    let close_tag = format!("</{UNTRUSTED_CONTENT_TAG}>");
    let empty_envelope = format!("<{UNTRUSTED_CONTENT_TAG}>\n{close_tag}");

    let mut repaired = String::with_capacity(text.len() + empty_envelope.len());
    let mut rest = text;
    while let Some(open_start) = rest.find(&open_prefix) {
        repaired.push_str(&rest[..open_start]);
        let after_prefix = &rest[open_start + open_prefix.len()..];
        let gt = after_prefix.find('>');
        let lt = after_prefix.find('<');
        // Head/tail elision can retain the opener's tail (`...">`) after an
        // omission marker, even though the opener itself was cut in half.
        // That detached `>` must not make the partial opener look complete.
        let head_tail_cut = gt.is_some_and(|gt| after_prefix[..gt].contains("\n\n... ["));
        let malformed = match (gt, lt) {
            (Some(gt), Some(lt)) => lt < gt,
            (None, _) => true,
            (Some(_), None) => false,
        } || head_tail_cut;
        if malformed {
            repaired.push_str(&empty_envelope);
            rest = match lt {
                Some(lt) if after_prefix[lt..].starts_with(&close_tag) => {
                    &after_prefix[lt + close_tag.len()..]
                }
                Some(lt) => &after_prefix[lt..],
                None => "",
            };
        } else {
            repaired.push_str(&rest[open_start..open_start + open_prefix.len()]);
            rest = after_prefix;
        }
    }
    repaired.push_str(rest);

    let opens = repaired.matches(open_prefix.as_str()).count();
    let closes = repaired.matches(close_tag.as_str()).count();
    if opens <= closes {
        return repaired;
    }
    let mut out = String::with_capacity(repaired.len() + (opens - closes) * (close_tag.len() + 1));
    out.push_str(&repaired);
    for _ in 0..(opens - closes) {
        out.push('\n');
        out.push_str(&close_tag);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_truncated_open_tag() {
        let value = r#"<untrusted_content source="web_fetch" origin="https://example.com">body"#;
        let repaired = close_dangling_untrusted_content_envelope(value);
        assert_eq!(
            repaired.matches("<untrusted_content").count(),
            repaired.matches("</untrusted_content>").count()
        );
        assert!(repaired.ends_with("</untrusted_content>"));
    }

    #[test]
    fn replaces_partial_attribute_fragment() {
        let value = r#"<untrusted_content source="web_fetch" origin="https://example.com/long"#;
        assert_eq!(
            close_dangling_untrusted_content_envelope(value),
            "<untrusted_content>\n</untrusted_content>"
        );
    }

    #[test]
    fn repairs_head_tail_elided_opener() {
        let value = "<untrusted_content source=\"web_fetch\" origin=\"https://example.com/long\n\n... [64 chars elided] ...\n\nsegment/\">\nbody\n</untrusted_content>";
        let repaired = close_dangling_untrusted_content_envelope(value);
        assert!(repaired.contains("<untrusted_content>\n</untrusted_content>"));
        assert_eq!(
            repaired.matches("<untrusted_content").count(),
            repaired.matches("</untrusted_content>").count()
        );
    }

    #[test]
    fn validates_every_opener() {
        let value = r#"<untrusted_content source="web_fetch">body</untrusted_content> <untrusted_content source="web_fetch""#;
        let repaired = close_dangling_untrusted_content_envelope(value);
        assert_eq!(
            repaired.matches("<untrusted_content").count(),
            repaired.matches("</untrusted_content>").count()
        );
        assert!(repaired.contains("<untrusted_content>\n</untrusted_content>"));
    }

    #[test]
    fn leaves_balanced_and_plain_text_unchanged() {
        let balanced = r#"<untrusted_content source="web_fetch">body</untrusted_content>"#;
        assert_eq!(
            close_dangling_untrusted_content_envelope(balanced),
            balanced
        );
        let plain = "normal text";
        assert_eq!(close_dangling_untrusted_content_envelope(plain), plain);
    }
}

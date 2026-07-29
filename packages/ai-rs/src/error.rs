//! Provider API error body summarization.
//!
//! Provider error responses are JSON envelopes whose only actionable content
//! is a nested `message` string:
//!
//! - Anthropic: `{"type":"error","error":{"type":"invalid_request_error","message":"..."}}`
//! - OpenAI: `{"error":{"message":"...","type":"invalid_request_error","code":"..."}}`
//! - Google: `{"error":{"code":400,"message":"...","status":"INVALID_ARGUMENT"}}`
//!
//! Dumping the raw body into the UI truncates the envelope's opening braces
//! and hides the message, so we extract the message (and the error kind)
//! whenever the body parses as JSON.

use serde_json::Value;

/// Summarize a provider error response body for display.
///
/// Returns `"<kind>: <message>"` (or just `<message>`) when the body is a
/// JSON error envelope carrying a message. Otherwise returns the raw body
/// with whitespace runs collapsed so it renders as one wrapped paragraph.
#[must_use]
pub fn summarize_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "(empty response body)".to_string();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(summary) = extract_error_message(&value) {
            return summary;
        }
    }
    collapse_whitespace(trimmed)
}

/// Pull `error.message` (plus `error.type`/`status`/`code`) out of a parsed
/// error envelope. Also accepts a top-level `message` and the
/// `"error": "..."` string shorthand some gateways use.
fn extract_error_message(value: &Value) -> Option<String> {
    let error = value.get("error").unwrap_or(value);
    if let Some(message) = error.as_str() {
        let message = message.trim();
        return (!message.is_empty()).then(|| message.to_string());
    }
    let message = error.get("message").and_then(Value::as_str)?.trim();
    if message.is_empty() {
        return None;
    }
    let kind = error
        .get("type")
        .or_else(|| error.get("status"))
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .map(str::to_string)
        .or_else(|| error.get("code").map(ToString::to_string));
    Some(match kind {
        Some(kind) => format!("{kind}: {message}"),
        None => message.to_string(),
    })
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_anthropic_error_message_and_type() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages.0: all messages must have non-empty content"}}"#;
        assert_eq!(
            summarize_error_body(body),
            "invalid_request_error: messages.0: all messages must have non-empty content"
        );
    }

    #[test]
    fn extracts_openai_error_message_and_type() {
        let body = r#"{"error":{"message":"Invalid model: gpt-9000","type":"invalid_request_error","param":"model","code":"model_not_found"}}"#;
        assert_eq!(
            summarize_error_body(body),
            "invalid_request_error: Invalid model: gpt-9000"
        );
    }

    #[test]
    fn extracts_google_error_message_and_status() {
        let body =
            r#"{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(
            summarize_error_body(body),
            "INVALID_ARGUMENT: API key not valid."
        );
    }

    #[test]
    fn falls_back_to_numeric_code_when_no_kind_string() {
        let body = r#"{"error":{"code":429,"message":"quota exceeded"}}"#;
        assert_eq!(summarize_error_body(body), "429: quota exceeded");
    }

    #[test]
    fn accepts_top_level_message() {
        let body = r#"{"message":"rate limited, retry after 30s"}"#;
        assert_eq!(summarize_error_body(body), "rate limited, retry after 30s");
    }

    #[test]
    fn accepts_error_string_shorthand() {
        let body = r#"{"error":"upstream timeout"}"#;
        assert_eq!(summarize_error_body(body), "upstream timeout");
    }

    #[test]
    fn falls_back_to_collapsed_raw_body_for_non_json() {
        let body = "<html>\n  <body>Bad Gateway</body>\n</html>";
        assert_eq!(
            summarize_error_body(body),
            "<html> <body>Bad Gateway</body> </html>"
        );
    }

    #[test]
    fn falls_back_to_collapsed_raw_body_for_json_without_message() {
        let body = "{\n  \"unexpected\": true\n}";
        assert_eq!(summarize_error_body(body), "{ \"unexpected\": true }");
    }

    #[test]
    fn handles_empty_body() {
        assert_eq!(summarize_error_body(""), "(empty response body)");
        assert_eq!(summarize_error_body("  \n "), "(empty response body)");
    }
}

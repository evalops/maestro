//! Tool output truncation helpers.
//!
//! Mirrors the TypeScript TUI clamp behavior with configurable limits and
//! a human-readable truncation banner.

const DEFAULT_TOOL_MAX_CHARS: usize = 12000;
const DEFAULT_TOOL_MAX_LINES: usize = 200;

pub struct ToolOutputLimits {
    pub max_chars: usize,
    pub max_lines: usize,
}

pub struct ToolOutputClamp {
    pub text: String,
    pub truncated: bool,
    pub omitted_chars: usize,
    pub omitted_lines: usize,
}

fn parse_limit(raw: Option<String>, fallback: usize) -> usize {
    raw.and_then(|value| value.parse::<isize>().ok())
        .filter(|value| *value >= 0)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}

pub fn tool_output_limits() -> ToolOutputLimits {
    ToolOutputLimits {
        max_chars: parse_limit(
            std::env::var("MAESTRO_TUI_TOOL_MAX_CHARS").ok(),
            DEFAULT_TOOL_MAX_CHARS,
        ),
        max_lines: parse_limit(
            std::env::var("MAESTRO_TUI_TOOL_MAX_LINES").ok(),
            DEFAULT_TOOL_MAX_LINES,
        ),
    }
}

pub fn clamp_tool_output(output: &str, limits: ToolOutputLimits) -> ToolOutputClamp {
    if output.is_empty() {
        return ToolOutputClamp {
            text: String::new(),
            truncated: false,
            omitted_chars: 0,
            omitted_lines: 0,
        };
    }

    let mut text = output.to_string();
    let mut omitted_lines = 0;
    if limits.max_lines > 0 {
        let lines: Vec<&str> = output.lines().collect();
        if lines.len() > limits.max_lines {
            omitted_lines = lines.len() - limits.max_lines;
            text = lines[..limits.max_lines].join("\n");
        }
    }

    let mut omitted_chars = 0;
    if limits.max_chars > 0 {
        let text_len = text.chars().count();
        if text_len > limits.max_chars {
            omitted_chars = text_len - limits.max_chars;
            text = text.chars().take(limits.max_chars).collect();
        }
    }

    let truncated = omitted_lines > 0 || omitted_chars > 0;
    ToolOutputClamp {
        text,
        truncated,
        omitted_chars,
        omitted_lines,
    }
}

pub fn format_tool_output_truncation(result: &ToolOutputClamp) -> Option<String> {
    if !result.truncated {
        return None;
    }
    let mut parts = Vec::new();
    if result.omitted_lines > 0 {
        parts.push(format!("{} lines", result.omitted_lines));
    }
    if result.omitted_chars > 0 {
        parts.push(format!("{} chars", result.omitted_chars));
    }
    let detail = parts.join(", ");
    if detail.is_empty() {
        None
    } else {
        Some(format!("[output truncated: {detail} omitted]"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_tool_output_respects_line_limit() {
        let limits = ToolOutputLimits {
            max_chars: 0,
            max_lines: 2,
        };
        let output = "a\nb\nc";
        let result = clamp_tool_output(output, limits);
        assert_eq!(result.text, "a\nb");
        assert_eq!(result.omitted_lines, 1);
        assert!(result.truncated);
    }

    #[test]
    fn clamp_tool_output_respects_char_limit() {
        let limits = ToolOutputLimits {
            max_chars: 4,
            max_lines: 0,
        };
        let output = "hello";
        let result = clamp_tool_output(output, limits);
        assert_eq!(result.text, "hell");
        assert_eq!(result.omitted_chars, 1);
        assert!(result.truncated);
    }

    #[test]
    fn format_truncation_banner() {
        let result = ToolOutputClamp {
            text: "ok".to_string(),
            truncated: true,
            omitted_chars: 2,
            omitted_lines: 3,
        };
        assert_eq!(
            format_tool_output_truncation(&result),
            Some("[output truncated: 3 lines, 2 chars omitted]".to_string())
        );
    }
}

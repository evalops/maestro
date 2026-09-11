use super::{McpPrompt, McpPromptArgument};

const MAX_PROMPT_SAFE_DESCRIPTION_LEN: usize = 1024;

fn prompt_safe_description(description: Option<&str>) -> Option<String> {
    let description = description?;
    let mut normalized = String::new();
    let mut emitted = 0usize;
    let mut whitespace_run = 0usize;
    let mut pending_space = false;
    let mut has_text = false;

    for ch in description.chars() {
        if ch.is_whitespace() {
            if whitespace_run >= MAX_PROMPT_SAFE_DESCRIPTION_LEN {
                break;
            }
            whitespace_run += 1;
            if has_text {
                pending_space = true;
            }
            continue;
        }

        whitespace_run = 0;
        if pending_space && emitted > 0 {
            if emitted + 1 >= MAX_PROMPT_SAFE_DESCRIPTION_LEN {
                break;
            }
            normalized.push(' ');
            emitted += 1;
            pending_space = false;
        }

        if emitted >= MAX_PROMPT_SAFE_DESCRIPTION_LEN {
            break;
        }
        normalized.push(ch);
        emitted += 1;
        has_text = true;
    }

    if normalized.is_empty() {
        return None;
    }

    Some(normalized)
}

fn format_mcp_prompt_argument_summary(argument: &McpPromptArgument) -> String {
    let mut summary = if argument.required {
        format!("{} (required)", argument.name)
    } else {
        argument.name.clone()
    };

    if let Some(description) = prompt_safe_description(argument.description.as_deref()) {
        summary.push_str(": ");
        summary.push_str(&description);
    }

    summary
}

pub fn append_mcp_prompt_summary(
    lines: &mut Vec<String>,
    prompt: &McpPrompt,
    name_prefix: &str,
    detail_prefix: &str,
) {
    lines.push(format!("{name_prefix}{}", prompt.name));

    if let Some(title) = prompt
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty() && *title != prompt.name)
    {
        lines.push(format!("{detail_prefix}title: {title}"));
    }

    if let Some(description) = prompt_safe_description(prompt.description.as_deref()) {
        lines.push(format!("{detail_prefix}description: {description}"));
    }

    if let Some(arguments) = prompt
        .arguments
        .as_ref()
        .filter(|entries| !entries.is_empty())
    {
        let summary = arguments
            .iter()
            .map(format_mcp_prompt_argument_summary)
            .collect::<Vec<_>>()
            .join("; ");
        lines.push(format!("{detail_prefix}args: {summary}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_safe_description_collapses_whitespace_and_omits_empty_text() {
        assert_eq!(
            prompt_safe_description(Some("  Summarize\n\n\tissue   details  ")),
            Some("Summarize issue details".to_string())
        );
        assert_eq!(prompt_safe_description(Some(" \n\t ")), None);
        assert_eq!(prompt_safe_description(None), None);
    }

    #[test]
    fn prompt_safe_description_truncates_long_text() {
        let input = "A".repeat(MAX_PROMPT_SAFE_DESCRIPTION_LEN + 20);
        let output = prompt_safe_description(Some(&input)).expect("description");
        assert_eq!(output.len(), MAX_PROMPT_SAFE_DESCRIPTION_LEN);
    }

    #[test]
    fn prompt_safe_description_truncates_by_characters() {
        let input = "🙂".repeat(MAX_PROMPT_SAFE_DESCRIPTION_LEN + 1);
        let output = prompt_safe_description(Some(&input)).expect("description");
        assert_eq!(output.chars().count(), MAX_PROMPT_SAFE_DESCRIPTION_LEN);
    }

    #[test]
    fn prompt_safe_description_does_not_leave_trailing_separator() {
        let input = format!("{} c", "a".repeat(MAX_PROMPT_SAFE_DESCRIPTION_LEN - 1));
        let output = prompt_safe_description(Some(&input)).expect("description");
        assert_eq!(output.len(), MAX_PROMPT_SAFE_DESCRIPTION_LEN - 1);
        assert!(!output.ends_with(' '));
    }

    #[test]
    fn prompt_safe_description_bounds_whitespace_only_input() {
        let input = format!("{}hidden", " ".repeat(MAX_PROMPT_SAFE_DESCRIPTION_LEN + 1));
        assert_eq!(prompt_safe_description(Some(&input)), None);
    }
}

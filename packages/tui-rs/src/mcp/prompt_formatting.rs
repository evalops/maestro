use super::{McpPrompt, McpPromptArgument};

fn format_mcp_prompt_argument_summary(argument: &McpPromptArgument) -> String {
    let mut summary = if argument.required {
        format!("{} (required)", argument.name)
    } else {
        argument.name.clone()
    };

    if let Some(description) = argument
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        summary.push_str(": ");
        summary.push_str(description);
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

    if let Some(description) = prompt
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
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

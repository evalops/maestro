//! Ask user tool (structured questions).

use serde::{Deserialize, Serialize};

use crate::agent::ToolResult;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(default, alias = "multiSelect")]
    pub multi_select: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct AskUserArgs {
    pub questions: Vec<Question>,
}

fn format_questions(questions: &[Question]) -> String {
    let mut lines = Vec::new();
    for (idx, q) in questions.iter().enumerate() {
        lines.push(format!("**[{}]** {}", q.header, q.question));
        let multi = q.multi_select.unwrap_or(false);
        let marker = if multi { "[ ]" } else { "( )" };
        for (opt_idx, opt) in q.options.iter().enumerate() {
            lines.push(format!(
                "  {} {}. **{}**: {}",
                marker,
                opt_idx + 1,
                opt.label,
                opt.description
            ));
        }
        lines.push(format!(
            "  {} {}. **Other**: Provide custom answer",
            marker,
            q.options.len() + 1
        ));
        if idx + 1 < questions.len() {
            lines.push(String::new());
        }
    }
    lines.join("\n")
}

pub fn ask_user(args: serde_json::Value) -> ToolResult {
    let parsed: AskUserArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid ask_user arguments: {}", err)),
    };

    if parsed.questions.is_empty() {
        return ToolResult::failure("ask_user requires at least one question".to_string());
    }

    let formatted = format_questions(&parsed.questions);
    let details = serde_json::json!({
        "questions": parsed.questions,
        "status": "pending"
    });

    ToolResult::success(format!(
        "Please answer the following question(s):\n\n{}\n\nReply with option numbers, option labels, or your own answer for \"Other\".",
        formatted
    ))
    .with_details(details)
}

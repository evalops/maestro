//! Ask user tool (structured questions).
//!
//! This module implements a structured question-answer interface for the agent
//! to collect user input with predefined options. It supports:
//!
//! - Single-select questions (radio button style)
//! - Multi-select questions (checkbox style)
//! - Custom "Other" option for free-form responses
//!
//! # Question Format
//!
//! Questions are displayed with a header, the question text, and numbered options.
//! Each option has a label and description to help the user make an informed choice.

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
        Err(err) => return ToolResult::failure(format!("Invalid ask_user arguments: {err}")),
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
        "Please answer the following question(s):\n\n{formatted}\n\nReply with option numbers, option labels, or your own answer for \"Other\"."
    ))
    .with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // QuestionOption Tests
    // ========================================================================

    #[test]
    fn test_question_option_deserialize() {
        let json = serde_json::json!({
            "label": "Option A",
            "description": "This is option A"
        });
        let option: QuestionOption = serde_json::from_value(json).unwrap();
        assert_eq!(option.label, "Option A");
        assert_eq!(option.description, "This is option A");
    }

    #[test]
    fn test_question_option_serialize() {
        let option = QuestionOption {
            label: "Test".to_string(),
            description: "Test description".to_string(),
        };
        let json = serde_json::to_value(&option).unwrap();
        assert_eq!(json["label"], "Test");
        assert_eq!(json["description"], "Test description");
    }

    // ========================================================================
    // Question Tests
    // ========================================================================

    #[test]
    fn test_question_deserialize_minimal() {
        let json = serde_json::json!({
            "question": "What is your favorite color?",
            "header": "Color",
            "options": [
                {"label": "Red", "description": "The color red"},
                {"label": "Blue", "description": "The color blue"}
            ]
        });
        let question: Question = serde_json::from_value(json).unwrap();
        assert_eq!(question.question, "What is your favorite color?");
        assert_eq!(question.header, "Color");
        assert_eq!(question.options.len(), 2);
        assert!(question.multi_select.is_none());
    }

    #[test]
    fn test_question_deserialize_with_multi_select() {
        let json = serde_json::json!({
            "question": "Select features",
            "header": "Features",
            "options": [{"label": "A", "description": "Feature A"}],
            "multi_select": true
        });
        let question: Question = serde_json::from_value(json).unwrap();
        assert_eq!(question.multi_select, Some(true));
    }

    #[test]
    fn test_question_deserialize_camel_case_alias() {
        let json = serde_json::json!({
            "question": "Select features",
            "header": "Features",
            "options": [{"label": "A", "description": "Feature A"}],
            "multiSelect": false
        });
        let question: Question = serde_json::from_value(json).unwrap();
        assert_eq!(question.multi_select, Some(false));
    }

    // ========================================================================
    // AskUserArgs Tests
    // ========================================================================

    #[test]
    fn test_ask_user_args_deserialize() {
        let json = serde_json::json!({
            "questions": [
                {
                    "question": "Q1?",
                    "header": "H1",
                    "options": [{"label": "A", "description": "Desc A"}]
                }
            ]
        });
        let args: AskUserArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.questions.len(), 1);
        assert_eq!(args.questions[0].question, "Q1?");
    }

    // ========================================================================
    // format_questions Tests
    // ========================================================================

    #[test]
    fn test_format_questions_single_select() {
        let questions = vec![Question {
            question: "What color?".to_string(),
            header: "Color".to_string(),
            options: vec![
                QuestionOption {
                    label: "Red".to_string(),
                    description: "The color red".to_string(),
                },
                QuestionOption {
                    label: "Blue".to_string(),
                    description: "The color blue".to_string(),
                },
            ],
            multi_select: None,
        }];

        let result = format_questions(&questions);
        assert!(result.contains("**[Color]** What color?"));
        assert!(result.contains("( ) 1. **Red**: The color red"));
        assert!(result.contains("( ) 2. **Blue**: The color blue"));
        assert!(result.contains("( ) 3. **Other**: Provide custom answer"));
    }

    #[test]
    fn test_format_questions_multi_select() {
        let questions = vec![Question {
            question: "Select features".to_string(),
            header: "Features".to_string(),
            options: vec![QuestionOption {
                label: "Logging".to_string(),
                description: "Enable logging".to_string(),
            }],
            multi_select: Some(true),
        }];

        let result = format_questions(&questions);
        assert!(result.contains("[ ] 1. **Logging**: Enable logging"));
        assert!(result.contains("[ ] 2. **Other**: Provide custom answer"));
    }

    #[test]
    fn test_format_questions_multiple_questions() {
        let questions = vec![
            Question {
                question: "Q1?".to_string(),
                header: "H1".to_string(),
                options: vec![QuestionOption {
                    label: "A".to_string(),
                    description: "Option A".to_string(),
                }],
                multi_select: None,
            },
            Question {
                question: "Q2?".to_string(),
                header: "H2".to_string(),
                options: vec![QuestionOption {
                    label: "B".to_string(),
                    description: "Option B".to_string(),
                }],
                multi_select: None,
            },
        ];

        let result = format_questions(&questions);
        assert!(result.contains("**[H1]** Q1?"));
        assert!(result.contains("**[H2]** Q2?"));
        // Should have empty line between questions
        assert!(result.contains("\n\n"));
    }

    #[test]
    fn test_format_questions_empty() {
        let questions: Vec<Question> = vec![];
        let result = format_questions(&questions);
        assert!(result.is_empty());
    }

    // ========================================================================
    // ask_user Function Tests
    // ========================================================================

    #[test]
    fn test_ask_user_success() {
        let args = serde_json::json!({
            "questions": [{
                "question": "Test?",
                "header": "Test",
                "options": [{"label": "Yes", "description": "Affirmative"}]
            }]
        });

        let result = ask_user(args);
        assert!(result.output.contains("Please answer"));
        assert!(result.details.is_some());

        let details = result.details.unwrap();
        assert_eq!(details["status"], "pending");
        assert!(details["questions"].is_array());
    }

    #[test]
    fn test_ask_user_empty_questions() {
        let args = serde_json::json!({
            "questions": []
        });

        let result = ask_user(args);
        assert!(!result.success);
        let error = result.error.unwrap();
        assert!(error.contains("requires at least one question"));
    }

    #[test]
    fn test_ask_user_invalid_args() {
        let args = serde_json::json!({
            "invalid_field": true
        });

        let result = ask_user(args);
        assert!(!result.success);
        let error = result.error.unwrap();
        assert!(error.contains("Invalid ask_user arguments"));
    }
}

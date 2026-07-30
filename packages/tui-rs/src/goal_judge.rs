//! Second-model goal completion judge.
//!
//! After each main-agent turn while goal auto-continue is enabled, a *different*
//! model evaluates whether the active goal is complete, blocked, or still needs
//! work. That verdict (not a fixed turn count) drives the next auto-continue.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::agent::{CredentialVault, ExecutionSource, FromAgent, NativeAgent, NativeAgentConfig};
use crate::tools::ToolExecutor;

/// Read-only tools the judge may use to verify workspace state.
const JUDGE_TOOLS: &[&str] = &[
    "read", "glob", "grep", "list", "search", "find", "diff", "status",
];

const JUDGE_TIMEOUT: Duration = Duration::from_mins(3);

/// Cap on transcript text embedded in the judge prompt.
const MAX_TRANSCRIPT_CHARS: usize = 16_000;

/// Outcome of a background goal-completion judgment.
#[derive(Debug, Clone)]
pub enum GoalJudgeEvent {
    Decided {
        model: String,
        verdict: GoalJudgeVerdict,
    },
    Failed {
        model: String,
        message: String,
    },
}

/// Structured judgment returned by the second model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalJudgeDecision {
    /// Goal is not yet satisfied; submit another continuation turn.
    Continue,
    /// Goal is fully satisfied and verified.
    Complete,
    /// Progress is blocked on external input or an impossible constraint.
    Blocked,
}

impl GoalJudgeDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Complete => "complete",
            Self::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalJudgeVerdict {
    pub decision: GoalJudgeDecision,
    #[serde(default)]
    pub reason: String,
}

/// Build the judge prompt from goal fields + recent transcript.
pub fn build_judge_prompt(
    goal_id: &str,
    goal_text: &str,
    success_criteria: Option<&str>,
    transcript: &str,
    worker_model: &str,
) -> String {
    let criteria = success_criteria.unwrap_or("(none stated — infer from the goal text)");
    let transcript = if transcript.trim().is_empty() {
        "(no transcript yet)"
    } else {
        transcript
    };
    format!(
        r#"You are an independent judge measuring whether a coding agent has completed its active goal.
The worker model was: {worker_model}.
You do NOT implement the goal. You only decide whether it is done.

## Goal (id {goal_id})
{goal_text}

## Success criteria
{criteria}

## Recent transcript (user + assistant turns, truncated)
{transcript}

## Instructions
1. Use read-only tools if needed to verify claims (files, tests, git status).
2. Decide exactly one of: continue, complete, blocked.
3. complete only when the success criteria are met and verified (or the goal text is clearly fully done if no criteria).
4. blocked when external input is required or the goal is impossible under current constraints.
5. continue when more agent work is still needed.

## Required output
Reply with a single JSON object and nothing else:
{{"decision":"continue"|"complete"|"blocked","reason":"<one or two sentences>"}}
"#
    )
}

/// Extract a [`GoalJudgeVerdict`] from free-form model text.
pub fn parse_verdict(raw: &str) -> Result<GoalJudgeVerdict, String> {
    let trimmed = raw.trim();
    // Prefer fenced ```json blocks, then first {...} object.
    if let Some(json) = extract_json_object(trimmed) {
        return parse_verdict_json(&json);
    }
    // Lenient keyword fallback when the model ignored JSON.
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("\"decision\"") {
        return Err("could not parse decision JSON from judge output".into());
    }
    if lower.lines().any(|l| {
        let t = l.trim();
        t == "complete" || t.starts_with("complete:") || t.starts_with("decision: complete")
    }) || lower.contains("goal is complete")
        || lower.contains("fully satisfied")
    {
        return Ok(GoalJudgeVerdict {
            decision: GoalJudgeDecision::Complete,
            reason: first_sentence(trimmed),
        });
    }
    if lower.contains("blocked") && !lower.contains("not blocked") {
        return Ok(GoalJudgeVerdict {
            decision: GoalJudgeDecision::Blocked,
            reason: first_sentence(trimmed),
        });
    }
    Ok(GoalJudgeVerdict {
        decision: GoalJudgeDecision::Continue,
        reason: first_sentence(trimmed),
    })
}

fn parse_verdict_json(json: &str) -> Result<GoalJudgeVerdict, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid judge JSON: {e}"))?;
    let decision_raw = value
        .get("decision")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "judge JSON missing decision".to_string())?
        .to_ascii_lowercase();
    let decision = match decision_raw.as_str() {
        "continue" | "incomplete" | "more" | "wip" => GoalJudgeDecision::Continue,
        "complete" | "done" | "finished" | "success" => GoalJudgeDecision::Complete,
        "blocked" | "block" | "stuck" => GoalJudgeDecision::Blocked,
        other => return Err(format!("unknown judge decision '{other}'")),
    };
    let reason = value
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(GoalJudgeVerdict { decision, reason })
}

fn extract_json_object(text: &str) -> Option<String> {
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        let after = after
            .strip_prefix("json")
            .or_else(|| after.strip_prefix("JSON"))
            .unwrap_or(after);
        let after = after.trim_start_matches(['\r', '\n', ' ']);
        if let Some(end) = after.find("```") {
            let block = after[..end].trim();
            if block.starts_with('{') {
                return Some(block.to_string());
            }
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(text[start..=end].to_string())
    } else {
        None
    }
}

fn first_sentence(text: &str) -> String {
    let t = text.trim();
    let cut = t
        .find(['\n', '.'])
        .map(|i| {
            if t.as_bytes().get(i) == Some(&b'.') {
                i + 1
            } else {
                i
            }
        })
        .unwrap_or(t.len())
        .min(240);
    t[..cut].trim().to_string()
}

/// Truncate transcript from the end (keep recent turns) to max chars.
pub fn truncate_transcript(transcript: &str, max_chars: usize) -> String {
    if transcript.chars().count() <= max_chars {
        return transcript.to_string();
    }
    let mut chars: Vec<char> = transcript.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    chars.drain(..start);
    let mut out = String::from("…\n");
    out.extend(chars);
    out
}

/// Build a simple role-tagged transcript from message lines.
pub fn format_transcript_lines(lines: &[(String, String)]) -> String {
    let mut out = String::new();
    for (role, content) in lines {
        if content.trim().is_empty() {
            continue;
        }
        out.push_str("### ");
        out.push_str(role);
        out.push('\n');
        out.push_str(content.trim());
        out.push_str("\n\n");
    }
    truncate_transcript(&out, MAX_TRANSCRIPT_CHARS)
}

/// Inputs for a background goal-completion judgment.
pub struct GoalJudgeRequest {
    pub model: String,
    pub cwd: String,
    pub worker_model: String,
    pub goal_id: String,
    pub goal_text: String,
    pub success_criteria: Option<String>,
    pub transcript: String,
}

/// Run the judge in the background and report on `tx`.
pub async fn run_judge(req: GoalJudgeRequest, tx: std::sync::mpsc::Sender<GoalJudgeEvent>) {
    let prompt = build_judge_prompt(
        &req.goal_id,
        &req.goal_text,
        req.success_criteria.as_deref(),
        &req.transcript,
        &req.worker_model,
    );
    let model = req.model;
    let event = match drive_judge(&model, &req.cwd, &prompt).await {
        Ok(raw) => match parse_verdict(&raw) {
            Ok(verdict) => GoalJudgeEvent::Decided { model, verdict },
            Err(message) => GoalJudgeEvent::Failed {
                model,
                message: format!("{message}. Raw output:\n{raw}"),
            },
        },
        Err(err) => GoalJudgeEvent::Failed {
            model,
            message: format!("{err:#}"),
        },
    };
    let _ = tx.send(event);
}

async fn drive_judge(model: &str, cwd: &str, prompt: &str) -> Result<String> {
    let config = NativeAgentConfig {
        model: model.to_string(),
        max_tokens: 4096,
        system_prompt: Some(format!(
            "You are a strict independent goal-completion judge. Working directory: {cwd}. \
             Use read-only tools only. Output a single JSON object as instructed."
        )),
        thinking_enabled: false,
        thinking_budget: 0,
        cwd: cwd.to_string(),
        approval_mode: crate::state::ApprovalMode::Selective,
        sandbox_policy: None,
    };

    let allowed_tools: HashSet<String> =
        JUDGE_TOOLS.iter().map(|tool| (*tool).to_string()).collect();
    let credential_vault = CredentialVault::new();
    let (agent, mut event_rx) = NativeAgent::new_with_allowed_tools_and_credential_vault(
        config,
        &allowed_tools,
        credential_vault.clone(),
    )
    .context("Failed to create goal judge agent")?;
    let tool_tx = agent.tool_response_sender();
    let tool_executor = ToolExecutor::with_credential_vault(cwd, credential_vault.clone());

    agent.send_ready();
    agent
        .prompt(prompt.to_string(), vec![])
        .await
        .context("Failed to send judge prompt")?;

    let workspace = dunce::canonicalize(Path::new(cwd)).unwrap_or_else(|_| PathBuf::from(cwd));
    let drained = tokio::time::timeout(
        JUDGE_TIMEOUT,
        drain_events(
            &mut event_rx,
            &tool_tx,
            &tool_executor,
            &credential_vault,
            &allowed_tools,
            &workspace,
        ),
    )
    .await;
    match drained {
        Ok(text) => text,
        Err(_) => {
            agent.cancel();
            anyhow::bail!("Timed out after {} seconds", JUDGE_TIMEOUT.as_secs());
        }
    }
}

#[derive(Default)]
struct JudgeDrain {
    assistant_buf: String,
    last_completed: String,
    terminal_error: Option<String>,
}

impl JudgeDrain {
    fn on_chunk(&mut self, content: &str, is_thinking: bool) {
        if !is_thinking {
            self.assistant_buf.push_str(content);
        }
    }

    fn on_response_end(&mut self, response_id: &str) -> bool {
        if response_id == "done" {
            return true;
        }
        if response_id == "blocked" && self.terminal_error.is_some() {
            return true;
        }
        if !self.assistant_buf.is_empty() {
            self.last_completed = std::mem::take(&mut self.assistant_buf);
            self.terminal_error = None;
        }
        false
    }

    fn on_error(&mut self, message: &str, fatal: bool) -> Result<()> {
        if fatal {
            anyhow::bail!("Judge agent error: {message}");
        }
        self.terminal_error = Some(message.to_string());
        Ok(())
    }

    fn finish(self) -> Result<String> {
        if let Some(message) = self.terminal_error {
            anyhow::bail!("Judge provider failed: {message}");
        }
        let text = if self.last_completed.is_empty() {
            self.assistant_buf
        } else {
            self.last_completed
        };
        if text.trim().is_empty() {
            anyhow::bail!("Judge agent returned no output");
        }
        Ok(text)
    }
}

async fn drain_events(
    event_rx: &mut tokio::sync::mpsc::UnboundedReceiver<FromAgent>,
    tool_tx: &tokio::sync::mpsc::UnboundedSender<crate::agent::ToolResponseMessage>,
    tool_executor: &ToolExecutor,
    credential_vault: &CredentialVault,
    allowed_tools: &HashSet<String>,
    workspace: &Path,
) -> Result<String> {
    let mut drain = JudgeDrain::default();

    loop {
        let Some(msg) = event_rx.recv().await else {
            break;
        };

        match msg {
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                drain.on_chunk(&content, is_thinking);
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                ..
            } => {
                let normalized = tool.to_ascii_lowercase();
                let prepared = if allowed_tools.contains(&normalized) {
                    crate::rubber_duck::contain_tool_args(
                        &normalized,
                        &credential_vault.resolve_in_json(&args),
                        workspace,
                    )
                } else {
                    Err(format!("Tool `{tool}` is not allowed for the goal judge"))
                };
                let (approved, result) = match prepared {
                    Ok(prepared_args) => (
                        true,
                        tool_executor
                            .execute(&tool, &prepared_args, None, &call_id)
                            .await,
                    ),
                    Err(message) => (false, crate::agent::ToolResult::failure(message)),
                };
                let _ = tool_tx.send((call_id, approved, Some(result), ExecutionSource::Native));
            }
            FromAgent::ResponseEnd { response_id, .. } if drain.on_response_end(&response_id) => {
                break;
            }
            FromAgent::Error { message, fatal } => {
                drain.on_error(&message, fatal)?;
            }
            _ => {}
        }
    }

    drain.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_verdict() {
        let v = parse_verdict(r#"{"decision":"complete","reason":"tests pass"}"#).unwrap();
        assert_eq!(v.decision, GoalJudgeDecision::Complete);
        assert_eq!(v.reason, "tests pass");
    }

    #[test]
    fn parse_fenced_json() {
        let raw = "Here is my call:\n```json\n{\"decision\":\"blocked\",\"reason\":\"needs API key\"}\n```\n";
        let v = parse_verdict(raw).unwrap();
        assert_eq!(v.decision, GoalJudgeDecision::Blocked);
    }

    #[test]
    fn parse_continue_default() {
        let v = parse_verdict("Still need to implement the CLI flag.").unwrap();
        assert_eq!(v.decision, GoalJudgeDecision::Continue);
    }

    #[test]
    fn truncate_keeps_tail() {
        let long = "a".repeat(100);
        let t = truncate_transcript(&long, 20);
        assert!(t.starts_with('…'));
        assert!(t.ends_with('a'));
        assert!(t.chars().count() <= 22);
    }
}

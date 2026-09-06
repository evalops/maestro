//! Import a Claude Code `settings.json` hook block into Maestro hook config.
//!
//! The importer is deliberately fail-closed: every entry that cannot be
//! mapped is collected and reported, and the caller exits non-zero without
//! writing a partial config as if it were complete.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;

use super::types::HookEventType;

/// One Claude Code entry that has no Maestro equivalent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmappableEntry {
    /// The Claude Code event the entry was listed under.
    pub event: String,
    /// The entry's matcher, as written.
    pub matcher: Option<String>,
    /// Why it could not be mapped.
    pub reason: String,
}

impl fmt::Display for UnmappableEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.matcher {
            Some(matcher) => write!(
                formatter,
                "{} (matcher \"{}\"): {}",
                self.event, matcher, self.reason
            ),
            None => write!(formatter, "{}: {}", self.event, self.reason),
        }
    }
}

/// One imported hook, ready to be written as Maestro hook config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedHook {
    pub event: HookEventType,
    /// The Maestro tool matcher, or `None` for "every tool".
    pub matcher: Option<String>,
    pub command: String,
    pub timeout_ms: Option<u64>,
}

/// The result of reading one Claude Code settings file.
#[derive(Debug, Clone, Default)]
pub struct ImportOutcome {
    pub hooks: Vec<ImportedHook>,
    pub unmappable: Vec<UnmappableEntry>,
}

impl ImportOutcome {
    /// Whether anything was refused. The CLI exits non-zero when true.
    #[must_use]
    pub fn has_unmappable(&self) -> bool {
        !self.unmappable.is_empty()
    }
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeSettings {
    #[serde(default)]
    hooks: BTreeMap<String, Vec<ClaudeCodeMatcher>>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeMatcher {
    #[serde(default)]
    matcher: Option<String>,
    #[serde(default)]
    hooks: Vec<ClaudeCodeHook>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeHook {
    #[serde(rename = "type", default)]
    hook_type: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

/// Map a Claude Code hook event name onto a Maestro [`HookEventType`].
///
/// `Stop` is deliberately absent. Maestro's nearest name, `StopFailure`, runs
/// "when recovery cannot produce a valid completion"
/// (`hooks/types.rs`, `StopFailureInput`), not when the agent finishes a turn,
/// so mapping it would move when the user's command runs.
#[must_use]
pub fn map_event(name: &str) -> Option<HookEventType> {
    match name {
        "PreToolUse" => Some(HookEventType::PreToolUse),
        "PostToolUse" => Some(HookEventType::PostToolUse),
        "UserPromptSubmit" => Some(HookEventType::UserPromptSubmit),
        "SessionStart" => Some(HookEventType::SessionStart),
        "SessionEnd" => Some(HookEventType::SessionEnd),
        "Notification" => Some(HookEventType::Notification),
        "PreCompact" => Some(HookEventType::PreCompact),
        "SubagentStop" => Some(HookEventType::SubagentStop),
        _ => None,
    }
}

/// Maestro's name for a Claude Code tool.
///
/// The table is explicit rather than a lowercase transform: Maestro's names
/// are not a case variant of Claude Code's for `MultiEdit`, `NotebookEdit`,
/// `WebFetch`, `WebSearch`, and `TodoWrite`.
#[must_use]
pub fn map_tool(name: &str) -> Option<&'static str> {
    match name {
        "Bash" => Some("bash"),
        "Read" => Some("read"),
        "Write" => Some("write"),
        "Edit" | "MultiEdit" => Some("edit"),
        "Glob" => Some("glob"),
        "Grep" => Some("grep"),
        "NotebookEdit" => Some("notebook_edit"),
        "WebFetch" => Some("web_fetch"),
        "WebSearch" => Some("websearch"),
        "TodoWrite" => Some("todo"),
        _ => None,
    }
}

/// Translate a Claude Code matcher into a Maestro tool matcher.
///
/// Claude Code matchers are regular expressions over tool names, and so are
/// Maestro's. Supported literal tool-name tokens are renamed even when they
/// occur inside regex syntax. Regexes containing other literal tokens are
/// rejected because passing them through could silently change which renamed
/// tools they select.
///
/// # Errors
///
/// Returns a reason when the matcher cannot be translated without changing
/// its meaning.
pub fn map_matcher(matcher: Option<&str>) -> Result<Option<String>, String> {
    let Some(matcher) = matcher.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if matcher == "*" {
        return Ok(None);
    }

    let mut mapped = String::with_capacity(matcher.len());
    let mut chars = matcher.char_indices().peekable();
    while let Some((start, character)) = chars.next() {
        if !character.is_ascii_alphanumeric() && character != '_' {
            mapped.push(character);
            continue;
        }

        let mut end = start + character.len_utf8();
        while let Some(&(index, next)) = chars.peek() {
            if !next.is_ascii_alphanumeric() && next != '_' {
                break;
            }
            chars.next();
            end = index + next.len_utf8();
        }
        let token = &matcher[start..end];
        if token.bytes().all(|byte| byte.is_ascii_digit()) {
            mapped.push_str(token);
        } else if let Some(name) = map_tool(token) {
            mapped.push_str(name);
        } else {
            return Err(format!(
                "matcher token \"{token}\" cannot be translated safely to a Deixic Code tool name"
            ));
        }
    }

    regex::Regex::new(&mapped)
        .map_err(|error| format!("translated matcher is not a valid Deixic Code regex: {error}"))?;
    Ok(Some(mapped))
}

/// Read a Claude Code settings document and map its hook block.
///
/// # Errors
///
/// Returns an error when the document is not JSON.
pub fn import_claude_code_hooks(settings_json: &str) -> anyhow::Result<ImportOutcome> {
    let settings: ClaudeCodeSettings =
        serde_json::from_str(settings_json).map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut outcome = ImportOutcome::default();

    for (event_name, matchers) in settings.hooks {
        let event = map_event(&event_name);
        for matcher in matchers {
            let Some(event) = event else {
                outcome.unmappable.push(UnmappableEntry {
                    event: event_name.clone(),
                    matcher: matcher.matcher.clone(),
                    reason: format!("Deixic Code has no hook event equivalent to \"{event_name}\""),
                });
                continue;
            };
            let mapped_matcher = match map_matcher(matcher.matcher.as_deref()) {
                Ok(value) => value,
                Err(reason) => {
                    outcome.unmappable.push(UnmappableEntry {
                        event: event_name.clone(),
                        matcher: matcher.matcher.clone(),
                        reason,
                    });
                    continue;
                }
            };
            for hook in matcher.hooks {
                let hook_type = hook.hook_type.as_deref().unwrap_or("command");
                if hook_type != "command" {
                    outcome.unmappable.push(UnmappableEntry {
                        event: event_name.clone(),
                        matcher: matcher.matcher.clone(),
                        reason: format!(
                            "hook type \"{hook_type}\" has no Deixic Code equivalent; only command hooks are imported"
                        ),
                    });
                    continue;
                }
                let Some(command) = hook
                    .command
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    outcome.unmappable.push(UnmappableEntry {
                        event: event_name.clone(),
                        matcher: matcher.matcher.clone(),
                        reason: "command hook has no command".to_string(),
                    });
                    continue;
                };
                let timeout_ms = match hook.timeout {
                    Some(timeout_seconds) => {
                        let Some(timeout_ms) = timeout_seconds.checked_mul(1_000) else {
                            outcome.unmappable.push(UnmappableEntry {
                                event: event_name.clone(),
                                matcher: matcher.matcher.clone(),
                                reason: format!(
                                    "timeout {timeout_seconds} seconds is too large to represent in milliseconds"
                                ),
                            });
                            continue;
                        };
                        Some(timeout_ms)
                    }
                    None => None,
                };
                outcome.hooks.push(ImportedHook {
                    event,
                    matcher: mapped_matcher.clone(),
                    command: command.to_string(),
                    timeout_ms,
                });
            }
        }
    }

    outcome.hooks.sort_by(|left, right| {
        format!("{:?}", left.event)
            .cmp(&format!("{:?}", right.event))
            .then_with(|| left.matcher.cmp(&right.matcher))
            .then_with(|| left.command.cmp(&right.command))
    });
    Ok(outcome)
}

/// Schema version stamped into the generated Maestro hook config.
pub const IMPORTED_HOOK_CONFIG_VERSION: u32 = 1;

/// Render an [`ImportOutcome`] as a Maestro `hooks.json` document.
///
/// The document always carries `version`, so the generated file is explicit
/// about the schema it was written against.
#[must_use]
pub fn render_maestro_hooks_json(outcome: &ImportOutcome) -> String {
    let mut events: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    for hook in &outcome.hooks {
        let mut entry = serde_json::Map::new();
        if let Some(matcher) = &hook.matcher {
            entry.insert(
                "matcher".to_string(),
                serde_json::Value::String(matcher.clone()),
            );
        }
        let mut command = serde_json::Map::new();
        command.insert(
            "type".to_string(),
            serde_json::Value::String("command".to_string()),
        );
        command.insert(
            "command".to_string(),
            serde_json::Value::String(hook.command.clone()),
        );
        if let Some(timeout) = hook.timeout_ms {
            command.insert(
                "timeout".to_string(),
                serde_json::Value::Number(timeout.into()),
            );
        }
        entry.insert(
            "hooks".to_string(),
            serde_json::Value::Array(vec![serde_json::Value::Object(command)]),
        );
        events
            .entry(format!("{:?}", hook.event))
            .or_default()
            .push(serde_json::Value::Object(entry));
    }

    let document = serde_json::json!({
        "version": IMPORTED_HOOK_CONFIG_VERSION,
        "hooks": events,
    });
    serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "hooks": {
        "PreToolUse": [
          { "matcher": "Bash", "hooks": [{"type": "command", "command": "./guard.sh", "timeout": 20}] },
          { "matcher": "Write|Edit", "hooks": [{"type": "command", "command": "./fmt.sh"}] },
          { "matcher": "Nonsense", "hooks": [{"type": "command", "command": "./never.sh"}] }
        ],
        "UserPromptSubmit": [
          { "hooks": [{"type": "command", "command": "./context.sh"}] }
        ],
        "Stop": [
          { "hooks": [{"type": "command", "command": "./done.sh"}] }
        ]
      }
    }"#;

    #[test]
    fn fixture_maps_three_entries_and_names_both_failures() {
        let outcome = import_claude_code_hooks(FIXTURE).unwrap();

        assert_eq!(outcome.hooks.len(), 3, "{:?}", outcome.hooks);
        assert!(outcome.hooks.iter().any(|hook| {
            hook.event == HookEventType::PreToolUse
                && hook.matcher.as_deref() == Some("bash")
                && hook.command == "./guard.sh"
                && hook.timeout_ms == Some(20_000)
        }));
        assert!(outcome.hooks.iter().any(|hook| {
            hook.event == HookEventType::PreToolUse
                && hook.matcher.as_deref() == Some("write|edit")
                && hook.command == "./fmt.sh"
        }));
        assert!(outcome.hooks.iter().any(|hook| {
            hook.event == HookEventType::UserPromptSubmit
                && hook.matcher.is_none()
                && hook.command == "./context.sh"
        }));

        assert!(outcome.has_unmappable());
        assert_eq!(outcome.unmappable.len(), 2, "{:?}", outcome.unmappable);
        let rendered: Vec<String> = outcome.unmappable.iter().map(ToString::to_string).collect();
        assert!(
            rendered.iter().any(|line| line.contains("Nonsense")),
            "{rendered:?}"
        );
        assert!(
            rendered.iter().any(|line| line.contains("Stop")),
            "{rendered:?}"
        );
    }

    #[test]
    fn rendered_config_carries_a_version_and_the_mapped_events() {
        let outcome = import_claude_code_hooks(FIXTURE).unwrap();
        let rendered = render_maestro_hooks_json(&outcome);
        let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(value["version"], 1);
        assert!(value["hooks"]["PreToolUse"].is_array());
        assert!(value["hooks"]["UserPromptSubmit"].is_array());
        assert!(value["hooks"].get("Stop").is_none());
        assert_eq!(
            value["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"],
            20_000
        );
    }

    #[test]
    fn prompt_hooks_are_reported_not_dropped() {
        let outcome = import_claude_code_hooks(
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"prompt","prompt":"check"}]}]}}"#,
        )
        .unwrap();
        assert!(outcome.hooks.is_empty());
        assert_eq!(outcome.unmappable.len(), 1);
        assert!(
            outcome.unmappable[0].reason.contains("prompt"),
            "{:?}",
            outcome.unmappable[0]
        );
    }

    #[test]
    fn wildcard_and_regex_matchers_translate_tool_name_tokens() {
        assert_eq!(map_matcher(Some("*")).unwrap(), None);
        assert_eq!(map_matcher(None).unwrap(), None);
        assert_eq!(
            map_matcher(Some("Write.*")).unwrap().as_deref(),
            Some("write.*")
        );
        assert_eq!(
            map_matcher(Some("Bash|Write")).unwrap().as_deref(),
            Some("bash|write")
        );
        assert_eq!(
            map_matcher(Some("^(WebFetch|NotebookEdit|WebSearch|TodoWrite)$"))
                .unwrap()
                .as_deref(),
            Some("^(web_fetch|notebook_edit|websearch|todo)$")
        );
        assert_eq!(map_matcher(Some(".*")).unwrap().as_deref(), Some(".*"));
    }

    #[test]
    fn an_unknown_tool_name_is_an_error_not_a_dropped_branch() {
        let error = map_matcher(Some("Bash|Nonsense")).expect_err("unknown tool must be reported");
        assert!(error.contains("Nonsense"), "{error}");
    }

    #[test]
    fn ambiguous_regex_tokens_are_rejected_instead_of_silently_passed_through() {
        let error = map_matcher(Some("Web.*"))
            .expect_err("partial renamed tool token cannot be translated safely");
        assert!(error.contains("Web"), "{error}");
    }

    #[test]
    fn timeout_overflow_is_reported_as_unmappable() {
        let outcome = import_claude_code_hooks(&format!(
            r#"{{"hooks":{{"PreToolUse":[{{"matcher":"Bash","hooks":[{{"type":"command","command":"./guard.sh","timeout":{}}}]}}]}}}}"#,
            u64::MAX
        ))
        .unwrap();

        assert!(outcome.hooks.is_empty());
        assert_eq!(outcome.unmappable.len(), 1);
        assert!(
            outcome.unmappable[0].reason.contains("too large"),
            "{:?}",
            outcome.unmappable[0]
        );
    }

    #[test]
    fn every_claude_code_event_maps_or_is_refused_explicitly() {
        assert_eq!(map_event("PreToolUse"), Some(HookEventType::PreToolUse));
        assert_eq!(map_event("PostToolUse"), Some(HookEventType::PostToolUse));
        assert_eq!(map_event("Stop"), None);
        assert_eq!(map_event("Whatever"), None);
    }
}

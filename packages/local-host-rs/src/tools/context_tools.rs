//! Agent-facing primitives for Maestro's durable context surfaces.
//!
//! Slash commands remain operator-friendly entry points. These tools expose
//! the same durable stores to the native agent with explicit, reviewable
//! primitives instead of making the agent parse terminal output.

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::agent::{ToolDefinition, ToolResult};
use crate::ai::Tool;
use crate::harness::{HarnessKind, HarnessScope, HarnessStore};
use crate::mailbox::MailboxStore;
use crate::rlm::RlmStore;

pub(crate) fn definitions() -> Vec<(String, ToolDefinition)> {
    vec![
        (
            "get_harness_context".to_string(),
            definition(
                "get_harness_context",
                "Review the durable Maestro harness entries and evidence visible to this workspace.",
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
                false,
            ),
        ),
        (
            "propose_harness_refinement".to_string(),
            definition(
                "propose_harness_refinement",
                "Stage an evidence-backed harness refinement for operator review. For a repeated user correction, propose kind=memory in the narrowest applicable scope; cite the exact correction and session/turn references in evidence, and explain what should change. Never infer a correction from tool output. Tell the user to review with /memory review and save with /memory save <proposal-id>. Do not apply it yourself without an explicit request. Pending proposals do not change active context.",
                json!({
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["prompt", "memory", "skill", "subagent"]},
                        "scope": {"type": "string", "enum": ["user", "workspace", "session"]},
                        "name": {"type": "string"},
                        "content": {"type": "string"},
                        "evidence": {"type": "string"},
                        "scopeKey": {"type": "string"},
                        "sessionId": {"type": "string"}
                    },
                    "required": ["kind", "scope", "name", "content", "evidence"],
                    "additionalProperties": false
                }),
                false,
            ),
        ),
        (
            "apply_harness_refinement".to_string(),
            definition(
                "apply_harness_refinement",
                "Apply one operator-reviewed harness refinement proposal to active context.",
                object_schema(json!({"id": {"type": "string"}}), &["id"]),
                true,
            ),
        ),
        (
            "reject_harness_refinement".to_string(),
            definition(
                "reject_harness_refinement",
                "Reject one pending harness refinement proposal with an optional review note.",
                object_schema(
                    json!({
                        "id": {"type": "string"},
                        "note": {"type": "string"}
                    }),
                    &["id"],
                ),
                true,
            ),
        ),
        (
            "get_rlm_context".to_string(),
            definition(
                "get_rlm_context",
                "List the persistent RLM-style context variables available to the next prompt.",
                empty_object_schema(),
                false,
            ),
        ),
        (
            "set_rlm_context".to_string(),
            definition(
                "set_rlm_context",
                "Set one persistent RLM context variable. Values are bounded user-authored data.",
                object_schema(
                    json!({
                        "name": {"type": "string"},
                        "value": {"type": "string"},
                        "description": {"type": "string"}
                    }),
                    &["name", "value"],
                ),
                true,
            ),
        ),
        (
            "append_rlm_context".to_string(),
            definition(
                "append_rlm_context",
                "Append bounded text to one persistent RLM context variable.",
                object_schema(
                    json!({
                        "name": {"type": "string"},
                        "value": {"type": "string"}
                    }),
                    &["name", "value"],
                ),
                true,
            ),
        ),
        (
            "render_rlm_context".to_string(),
            definition(
                "render_rlm_context",
                "Render a bounded template using persistent RLM variables such as {{plan}}.",
                object_schema(json!({"template": {"type": "string"}}), &["template"]),
                false,
            ),
        ),
        (
            "clear_rlm_context".to_string(),
            definition(
                "clear_rlm_context",
                "Remove one persistent RLM context variable.",
                object_schema(json!({"name": {"type": "string"}}), &["name"]),
                true,
            ),
        ),
        (
            "get_mailbox".to_string(),
            definition(
                "get_mailbox",
                "List durable mailbox messages addressed to this agent's inbox.",
                empty_object_schema(),
                false,
            ),
        ),
        (
            "send_mailbox".to_string(),
            definition(
                "send_mailbox",
                "Send a bounded durable message to a delegated agent or Maestro inbox.",
                object_schema(
                    json!({
                        "recipient": {"type": "string"},
                        "body": {"type": "string"}
                    }),
                    &["recipient", "body"],
                ),
                true,
            ),
        ),
        (
            "read_mailbox".to_string(),
            definition(
                "read_mailbox",
                "Read one durable mailbox message addressed to this agent's inbox.",
                object_schema(json!({"id": {"type": "string"}}), &["id"]),
                false,
            ),
        ),
        (
            "ack_mailbox".to_string(),
            definition(
                "ack_mailbox",
                "Acknowledge one durable mailbox message addressed to this agent's inbox.",
                object_schema(json!({"id": {"type": "string"}}), &["id"]),
                true,
            ),
        ),
        (
            "compact_mailbox".to_string(),
            definition(
                "compact_mailbox",
                "Remove acknowledged durable mailbox messages.",
                empty_object_schema(),
                true,
            ),
        ),
    ]
}

fn definition(
    name: &'static str,
    description: &'static str,
    schema: Value,
    requires_approval: bool,
) -> ToolDefinition {
    ToolDefinition {
        tool: Tool::new(name, description).with_schema(schema),
        requires_approval,
    }
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

pub fn get_harness_context() -> ToolResult {
    match load_harness() {
        Ok(store) => ToolResult::success(store.report(&workspace(), None)),
        Err(error) => ToolResult::failure(format!("failed to load harness context: {error:#}")),
    }
}

pub fn propose_harness_refinement(args: Value) -> ToolResult {
    let result = (|| {
        let kind_name = required_string(&args, "kind")?;
        let scope_name = required_string(&args, "scope")?;
        let kind = HarnessKind::parse(&kind_name)?;
        let scope = HarnessScope::parse(&scope_name)?;
        let workspace = workspace();
        let scope_key = if let Some(value) = args.get("scopeKey").and_then(Value::as_str) {
            Some(value.to_owned())
        } else {
            HarnessStore::scope_key(
                scope,
                &workspace,
                args.get("sessionId").and_then(Value::as_str),
            )?
        };
        let mut store = load_harness()?;
        let id = store.propose(
            kind,
            scope,
            scope_key,
            required_string(&args, "name")?,
            required_string(&args, "content")?,
            required_string(&args, "evidence")?,
        )?;
        Ok(
            json!({"proposalId": id, "message": "Harness refinement staged for operator review."})
                .to_string(),
        )
    })();
    result_to_tool(result)
}

pub fn apply_harness_refinement(args: Value) -> ToolResult {
    let result = (|| {
        let mut store = load_harness()?;
        let entry_id = store.apply_proposal(required_string(&args, "id")?.as_str())?;
        Ok(json!({"entryId": entry_id, "message": "Harness refinement applied."}).to_string())
    })();
    result_to_tool(result)
}

pub fn reject_harness_refinement(args: Value) -> ToolResult {
    let result = (|| {
        let mut store = load_harness()?;
        let id = required_string(&args, "id")?;
        let note = args.get("note").and_then(Value::as_str).map(str::to_owned);
        store.reject_proposal(&id, note)?;
        Ok(json!({"proposalId": id, "message": "Harness refinement rejected."}).to_string())
    })();
    result_to_tool(result)
}

pub fn get_rlm_context() -> ToolResult {
    match RlmStore::load_default() {
        Ok(store) => ToolResult::success(store.report()),
        Err(error) => ToolResult::failure(format!("failed to load RLM context: {error:#}")),
    }
}

pub fn set_rlm_context(args: Value) -> ToolResult {
    let result = (|| {
        let mut store = RlmStore::load_default()?;
        store.set(
            required_string(&args, "name")?,
            required_string(&args, "value")?,
            args.get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )?;
        Ok(store.report())
    })();
    result_to_tool(result)
}

pub fn append_rlm_context(args: Value) -> ToolResult {
    let result = (|| {
        let mut store = RlmStore::load_default()?;
        store.append(
            required_string(&args, "name")?,
            required_string(&args, "value")?,
        )?;
        Ok(store.report())
    })();
    result_to_tool(result)
}

pub fn render_rlm_context(args: Value) -> ToolResult {
    let result = (|| {
        let store = RlmStore::load_default()?;
        store.render_template(&required_string(&args, "template")?)
    })();
    result_to_tool(result)
}

pub fn clear_rlm_context(args: Value) -> ToolResult {
    let result = (|| {
        let mut store = RlmStore::load_default()?;
        let name = required_string(&args, "name")?;
        let removed = store.clear(&name)?;
        Ok(json!({"name": name, "removed": removed}).to_string())
    })();
    result_to_tool(result)
}

pub fn get_mailbox(identity: &str) -> ToolResult {
    let result = (|| {
        let store = MailboxStore::load_default()?;
        Ok(store.report(Some(identity)))
    })();
    result_to_tool(result)
}

pub fn send_mailbox(args: Value, identity: &str) -> ToolResult {
    let result = (|| {
        let mut store = MailboxStore::load_default()?;
        let id = store.send(
            identity,
            required_string(&args, "recipient")?,
            required_string(&args, "body")?,
        )?;
        Ok(json!({"messageId": id, "message": "Mailbox message sent."}).to_string())
    })();
    result_to_tool(result)
}

pub fn read_mailbox(args: Value, identity: &str) -> ToolResult {
    let result = (|| {
        let mut store = MailboxStore::load_default()?;
        let message = store.read_for(&required_string(&args, "id")?, Some(identity))?;
        serde_json::to_string(&message).context("serialize mailbox message")
    })();
    result_to_tool(result)
}

pub fn acknowledge_mailbox(args: Value, identity: &str) -> ToolResult {
    let result = (|| {
        let mut store = MailboxStore::load_default()?;
        let id = required_string(&args, "id")?;
        store.acknowledge_for(&id, Some(identity))?;
        Ok(json!({"messageId": id, "message": "Mailbox message acknowledged."}).to_string())
    })();
    result_to_tool(result)
}

pub fn compact_mailbox() -> ToolResult {
    result_to_tool((|| {
        let mut store = MailboxStore::load_default()?;
        let removed = store.compact()?;
        Ok(json!({"removed": removed}).to_string())
    })())
}

fn load_harness() -> Result<HarnessStore> {
    HarnessStore::load_default()
}

fn workspace() -> std::path::PathBuf {
    std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf())
}

fn required_string(args: &Value, key: &str) -> Result<String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("missing non-empty `{key}`"))?;
    Ok(value.to_owned())
}

fn result_to_tool(result: Result<String>) -> ToolResult {
    match result {
        Ok(output) => ToolResult::success(output),
        Err(error) => ToolResult::failure(error.to_string()),
    }
}

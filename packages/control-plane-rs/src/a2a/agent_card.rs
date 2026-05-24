use serde_json::Value;

use crate::a2a_skill_catalog::a2a_subagent_skills;
use crate::http::RequestHead;
use crate::{
    trimmed_env, Config, A2A_DEFAULT_LIST_PAGE_SIZE, A2A_MAX_LIST_PAGE_SIZE, A2A_PROTOCOL_VERSION,
    EVALOPS_A2A_EXTENSION_URI,
};

pub(crate) fn a2a_agent_card(head: &RequestHead, config: &Config) -> Value {
    let base_url = a2a_public_base_url(head, config);
    let mut card = serde_json::json!({
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "name": trimmed_env("MAESTRO_A2A_AGENT_NAME")
            .unwrap_or_else(|| "Maestro Desktop Agent".to_string()),
        "description": trimmed_env("MAESTRO_A2A_AGENT_DESCRIPTION")
            .unwrap_or_else(|| "Local Maestro Rust/TS TUI agent endpoint for A2A task delegation.".to_string()),
        "url": base_url,
        "preferredTransport": "HTTP+JSON",
        "supportedInterfaces": [{
            "url": base_url,
            "protocolBinding": "HTTP+JSON",
            "protocolVersion": A2A_PROTOCOL_VERSION
        }],
        "provider": {
            "organization": "EvalOps",
            "url": "https://evalops.com"
        },
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": {
            "streaming": true,
            "pushNotifications": true,
            "extendedAgentCard": true,
            "extensions": [a2a_operating_plane_extension(false)]
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": a2a_agent_skills()
    });
    if let Some(security) = a2a_agent_card_security(config) {
        if let Value::Object(card) = &mut card {
            card.insert("securitySchemes".to_string(), security.0);
            card.insert("securityRequirements".to_string(), security.1);
        }
    }
    card
}

pub(crate) fn a2a_extended_agent_card(head: &RequestHead, config: &Config) -> Value {
    let mut card = a2a_agent_card(head, config);
    if let Value::Object(card_object) = &mut card {
        card_object.insert(
            "documentationUrl".to_string(),
            Value::String(
                "https://github.com/evalops/maestro/tree/main/docs/protocols".to_string(),
            ),
        );
        card_object.insert(
            "metadata".to_string(),
            serde_json::json!({
                "runtime": "maestro-rust-control-plane",
                "taskStore": "durable-file",
                "taskStorePath": config.a2a_tasks_file_path.to_string_lossy(),
                "streamingEndpoints": ["/message:stream", "/tasks/{id}:subscribe"],
                "pushNotificationEndpoints": [
                    "/tasks/{taskId}/pushNotificationConfigs",
                    "/tasks/{taskId}/pushNotificationConfigs/{id}"
                ],
                "taskList": {
                    "filters": ["contextId", "status", "statusTimestampAfter"],
                    "pagination": { "defaultPageSize": A2A_DEFAULT_LIST_PAGE_SIZE, "maxPageSize": A2A_MAX_LIST_PAGE_SIZE },
                    "historyLength": true,
                    "includeArtifacts": true
                },
                "operatingPlane": {
                    "extensionUri": EVALOPS_A2A_EXTENSION_URI,
                    "correlationFields": [
                        "workspaceId",
                        "sessionId",
                        "agentId",
                        "a2aSkillId",
                        "actorId",
                        "traceparent",
                        "tracestate"
                    ],
                    "subagentRequestMetadataPath": "evalops.subagentRequest",
                    "retentionFields": ["data_classification", "retention_class", "safe_summary"]
                }
            }),
        );
        card_object.insert(
            "capabilities".to_string(),
            serde_json::json!({
                "streaming": true,
                "pushNotifications": true,
                "extendedAgentCard": true,
                "extensions": [a2a_operating_plane_extension(true)]
            }),
        );
    }
    card
}

fn a2a_operating_plane_extension(extended: bool) -> Value {
    serde_json::json!({
        "uri": EVALOPS_A2A_EXTENSION_URI,
        "description": "Carries EvalOps/Maestro workspace, session, trace, retention, and approval correlation metadata without changing core A2A task semantics.",
        "required": false,
        "params": {
            "version": "1",
            "metadataFields": [
                "workspaceId",
                "sessionId",
                "agentId",
                "a2aSkillId",
                "actorId",
                "traceparent",
                "tracestate",
                "evalops.subagentRequest",
                "data_classification",
                "retention_class",
                "safe_summary"
            ],
            "extendedAgentCard": extended
        }
    })
}

fn a2a_agent_card_security(config: &Config) -> Option<(Value, Value)> {
    if !config.require_key {
        return None;
    }
    Some((
        serde_json::json!({
            "maestroApiKey": {
                "type": "apiKey",
                "in": "header",
                "name": "x-maestro-api-key",
                "description": "Maestro control-plane API key."
            },
            "bearer": {
                "type": "http",
                "scheme": "bearer",
                "description": "Bearer token accepted by Maestro shared-secret auth."
            }
        }),
        serde_json::json!([
            { "maestroApiKey": [] },
            { "bearer": [] }
        ]),
    ))
}

pub(crate) fn a2a_agent_skills() -> Value {
    let mut skill = serde_json::json!({
        "id": "maestro-tui-turn",
        "name": "Maestro TUI turn",
        "description": "Run a prompt through the local Maestro native TUI agent runner.",
        "tags": ["maestro", "tui", "codex", "a2a", "fleet"],
        "examples": [
            "Review the current workspace and summarize the next highest leverage action."
        ],
        "inputModes": ["text/plain"],
        "outputModes": ["text/plain", "application/json"]
    });
    if let Some(model) = trimmed_env("MAESTRO_A2A_MODEL") {
        skill["metadata"] = serde_json::json!({ "defaultModel": model });
    }
    let subagent_skills = a2a_subagent_skills(EVALOPS_A2A_EXTENSION_URI);
    let mut skills = Vec::with_capacity(1 + subagent_skills.len());
    skills.push(skill);
    skills.extend(subagent_skills);
    Value::Array(skills)
}

fn a2a_public_base_url(_head: &RequestHead, config: &Config) -> String {
    a2a_public_base_url_for_config(config)
}

pub(crate) fn a2a_public_base_url_for_config(config: &Config) -> String {
    if let Some(url) =
        trimmed_env("MAESTRO_A2A_PUBLIC_URL").or_else(|| trimmed_env("MAESTRO_CONTROL_PUBLIC_URL"))
    {
        return url.trim_end_matches('/').to_string();
    }
    let host = if let Some(host) = trimmed_env("MAESTRO_A2A_PUBLIC_HOST")
        .or_else(|| trimmed_env("MAESTRO_CONTROL_PUBLIC_HOST"))
    {
        host
    } else if config.listen_host == "0.0.0.0" || config.listen_host == "::" {
        trimmed_env("HOSTNAME")
            .or_else(|| trimmed_env("COMPUTERNAME"))
            .unwrap_or_else(|| "127.0.0.1".to_string())
    } else {
        config.listen_host.clone()
    };
    format!(
        "http://{}",
        a2a_public_host_authority(&host, config.listen_port)
    )
}

fn a2a_public_host_authority(host: &str, port: u16) -> String {
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let literal = &rest[..end];
            let suffix = &rest[end + 1..];
            let authority = format!("[{}]{suffix}", a2a_uri_host(literal));
            if suffix.starts_with(':') {
                authority
            } else {
                format!("{authority}:{port}")
            }
        } else {
            format!("[{}]:{port}", a2a_uri_host(rest))
        }
    } else if host.matches(':').count() > 1 {
        format!("[{}]:{port}", a2a_uri_host(host))
    } else if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

fn a2a_uri_host(host: &str) -> String {
    let mut normalized = String::with_capacity(host.len());
    let mut chars = host.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let mut lookahead = chars.clone();
            let already_encoded = lookahead
                .next()
                .is_some_and(|next| next.is_ascii_hexdigit())
                && lookahead
                    .next()
                    .is_some_and(|next| next.is_ascii_hexdigit());
            if already_encoded {
                normalized.push(ch);
            } else {
                normalized.push_str("%25");
            }
        } else {
            normalized.push(ch);
        }
    }
    normalized
}

use serde_json::{Map, Value};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::codex_subagent_dispatch;
use crate::{
    a2a_agent_skills, a2a_public_base_url_for_config, trimmed_env, truthy_env, Config,
    A2A_PROTOCOL_VERSION, EVALOPS_A2A_EXTENSION_URI,
};

const A2A_PLATFORM_DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 60_000;
const A2A_PLATFORM_DEFAULT_TIMEOUT_MS: u64 = 2_500;
const PLATFORM_AGENT_REGISTER_PATH: &str = "/agents.v1.AgentService/Register";
const PLATFORM_AGENT_UPDATE_PATH: &str = "/agents.v1.AgentService/Update";
const PLATFORM_AGENT_HEARTBEAT_PATH: &str = "/agents.v1.AgentService/Heartbeat";

#[derive(Debug, Clone)]
pub(crate) struct A2APlatformRegistrationConfig {
    pub(crate) base_url: String,
    pub(crate) token: String,
    pub(crate) organization_id: String,
    pub(crate) workspace_id: String,
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) agent_type: String,
    pub(crate) owner_id: Option<String>,
    pub(crate) public_endpoint_url: String,
    pub(crate) internal_endpoint_url: Option<String>,
    pub(crate) agent_card_url: Option<String>,
    pub(crate) heartbeat_interval_ms: u64,
    pub(crate) timeout_ms: u64,
    pub(crate) current_objective_ids: Vec<String>,
    pub(crate) max_concurrent_objectives: String,
    pub(crate) surface: String,
    pub(crate) surface_type: String,
}

pub(crate) fn maybe_spawn_a2a_platform_registration_loop(config: Arc<Config>) {
    let registration = match resolve_a2a_platform_registration_config(&config) {
        Ok(Some(registration)) => registration,
        Ok(None) => return,
        Err(error) => {
            eprintln!("maestro A2A Platform registration disabled: {error}");
            return;
        }
    };
    println!(
        "maestro A2A Platform registration loop enabled for {} at {}",
        registration.agent_id, registration.public_endpoint_url
    );
    thread::spawn(move || {
        let mut registered = false;
        loop {
            let result = if registered {
                send_a2a_platform_heartbeat(&registration, &config)
            } else {
                register_or_update_a2a_platform_agent(&registration, &config)
                    .and_then(|_| send_a2a_platform_heartbeat(&registration, &config))
            };
            match result {
                Ok(()) => registered = true,
                Err(error) => {
                    registered = false;
                    eprintln!(
                        "maestro A2A Platform registration/heartbeat failed for {}: {error}",
                        registration.agent_id
                    );
                }
            }
            thread::sleep(Duration::from_millis(registration.heartbeat_interval_ms));
        }
    });
}

pub(crate) fn resolve_a2a_platform_registration_config(
    config: &Config,
) -> Result<Option<A2APlatformRegistrationConfig>, String> {
    if !a2a_platform_registration_enabled() {
        return Ok(None);
    }

    let base_url = first_trimmed_env(&[
        "MAESTRO_AGENT_REGISTRY_SERVICE_URL",
        "AGENT_REGISTRY_SERVICE_URL",
        "MAESTRO_AGENT_REGISTRY_URL",
        "AGENT_REGISTRY_BASE_URL",
        "PLATFORM_AGENT_REGISTRY_URL",
        "MAESTRO_PLATFORM_BASE_URL",
        "MAESTRO_EVALOPS_BASE_URL",
        "EVALOPS_BASE_URL",
    ]);
    let token = first_trimmed_env(&[
        "MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
        "AGENT_REGISTRY_SERVICE_TOKEN",
        "MAESTRO_AGENT_REGISTRY_TOKEN",
        "AGENT_REGISTRY_TOKEN",
        "MAESTRO_EVALOPS_ACCESS_TOKEN",
        "EVALOPS_TOKEN",
    ]);
    let organization_id = first_trimmed_env(&[
        "MAESTRO_AGENT_REGISTRY_ORG_ID",
        "AGENT_REGISTRY_ORGANIZATION_ID",
        "AGENT_REGISTRY_ORG_ID",
        "MAESTRO_EVALOPS_ORG_ID",
        "EVALOPS_ORGANIZATION_ID",
        "EVALOPS_ORG_ID",
        "MAESTRO_ENTERPRISE_ORG_ID",
    ]);
    let workspace_id = first_trimmed_env(&[
        "MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
        "AGENT_REGISTRY_WORKSPACE_ID",
        "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
        "MAESTRO_EVALOPS_WORKSPACE_ID",
        "EVALOPS_WORKSPACE_ID",
        "MAESTRO_WORKSPACE_ID",
    ])
    .or_else(|| organization_id.clone());
    let explicit_public_endpoint_url = first_trimmed_env(&[
        "MAESTRO_A2A_PUBLIC_URL",
        "MAESTRO_CONTROL_PUBLIC_URL",
        "MAESTRO_A2A_URL",
        "MAESTRO_CONTROL_URL",
    ]);
    let public_host_hint =
        first_trimmed_env(&["MAESTRO_A2A_PUBLIC_HOST", "MAESTRO_CONTROL_PUBLIC_HOST"]).is_some();

    let mut missing = Vec::new();
    if base_url.is_none() {
        missing.push("Platform Agent Registry base URL");
    }
    if token.is_none() {
        missing.push("Platform Agent Registry token");
    }
    if organization_id.is_none() {
        missing.push("EvalOps organization id");
    }
    if a2a_platform_registration_enabled_by_hosted_default()
        && explicit_public_endpoint_url.is_none()
        && !public_host_hint
    {
        missing.push("routable A2A public URL or public host");
    }
    if !missing.is_empty() {
        return Err(format!(
            "missing {}; set MAESTRO_A2A_PLATFORM_REGISTER=0 to disable auto-registration",
            missing.join(", ")
        ));
    }

    let public_endpoint_url =
        explicit_public_endpoint_url.unwrap_or_else(|| a2a_public_base_url_for_config(config));
    let agent_id = first_trimmed_env(&[
        "MAESTRO_A2A_AGENT_ID",
        "MAESTRO_AGENT_ID",
        "EVALOPS_AGENT_ID",
    ])
    .unwrap_or_else(|| default_a2a_platform_agent_id(config));

    Ok(Some(A2APlatformRegistrationConfig {
        base_url: normalize_platform_base_url(&base_url.expect("base URL presence checked above")),
        token: token.expect("token presence checked above"),
        organization_id: organization_id.expect("organization id presence checked above"),
        workspace_id: workspace_id.expect("workspace id presence checked above"),
        agent_id,
        name: first_trimmed_env(&["MAESTRO_A2A_AGENT_NAME", "MAESTRO_AGENT_NAME"])
            .unwrap_or_else(|| "Maestro A2A Peer".to_string()),
        description: first_trimmed_env(&[
            "MAESTRO_A2A_AGENT_DESCRIPTION",
            "MAESTRO_AGENT_DESCRIPTION",
        ])
        .unwrap_or_else(|| {
            "Maestro peer exposing governed Codex subagent lanes through A2A.".to_string()
        }),
        agent_type: trimmed_env("MAESTRO_A2A_AGENT_TYPE").unwrap_or_else(|| "maestro".to_string()),
        owner_id: first_trimmed_env(&["MAESTRO_A2A_OWNER_ID", "EVALOPS_USER_ID"]),
        public_endpoint_url,
        internal_endpoint_url: first_trimmed_env(&[
            "MAESTRO_A2A_INTERNAL_URL",
            "MAESTRO_CONTROL_INTERNAL_URL",
        ]),
        agent_card_url: trimmed_env("MAESTRO_A2A_AGENT_CARD_URL"),
        heartbeat_interval_ms: env_u64_from_names(
            &[
                "MAESTRO_A2A_PLATFORM_HEARTBEAT_INTERVAL_MS",
                "MAESTRO_AGENT_REGISTRY_HEARTBEAT_INTERVAL_MS",
            ],
            A2A_PLATFORM_DEFAULT_HEARTBEAT_INTERVAL_MS,
        ),
        timeout_ms: env_u64_from_names(
            &[
                "MAESTRO_AGENT_REGISTRY_TIMEOUT_MS",
                "AGENT_REGISTRY_SERVICE_TIMEOUT_MS",
            ],
            A2A_PLATFORM_DEFAULT_TIMEOUT_MS,
        ),
        current_objective_ids: csv_env("MAESTRO_A2A_CURRENT_OBJECTIVE_IDS"),
        max_concurrent_objectives: first_trimmed_env(&[
            "MAESTRO_A2A_MAX_CONCURRENT_OBJECTIVES",
            "MAESTRO_SWARM_MAX_TEAMMATES",
        ])
        .unwrap_or_else(|| "10".to_string()),
        surface: trimmed_env("MAESTRO_A2A_PLATFORM_SURFACE").unwrap_or_else(|| "a2a".to_string()),
        surface_type: trimmed_env("MAESTRO_A2A_PLATFORM_SURFACE_TYPE")
            .unwrap_or_else(|| "SURFACE_MAESTRO".to_string()),
    }))
}

pub(crate) fn a2a_platform_registration_enabled() -> bool {
    if let Some(value) = explicit_a2a_platform_registration_enabled() {
        return value;
    }
    truthy_env("MAESTRO_HOSTED_RUNNER_MODE") || truthy_env("MAESTRO_HOSTED_RUNNER")
}

fn explicit_a2a_platform_registration_enabled() -> Option<bool> {
    if let Some(value) = env_bool("MAESTRO_A2A_PLATFORM_REGISTER")
        .or_else(|| env_bool("MAESTRO_A2A_PLATFORM_AUTO_REGISTER"))
    {
        return Some(value);
    }
    None
}

fn a2a_platform_registration_enabled_by_hosted_default() -> bool {
    explicit_a2a_platform_registration_enabled().is_none()
        && (truthy_env("MAESTRO_HOSTED_RUNNER_MODE") || truthy_env("MAESTRO_HOSTED_RUNNER"))
}

pub(crate) fn register_or_update_a2a_platform_agent(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Result<(), String> {
    match post_platform_connect_json(
        registration,
        PLATFORM_AGENT_REGISTER_PATH,
        &a2a_platform_register_payload(registration, config),
    ) {
        Ok(_) => Ok(()),
        Err(error) if platform_error_is_conflict(&error) => post_platform_connect_json(
            registration,
            PLATFORM_AGENT_UPDATE_PATH,
            &a2a_platform_update_payload(registration, config),
        )
        .map(|_| ()),
        Err(error) => Err(error),
    }
}

pub(crate) fn send_a2a_platform_heartbeat(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Result<(), String> {
    post_platform_connect_json(
        registration,
        PLATFORM_AGENT_HEARTBEAT_PATH,
        &a2a_platform_heartbeat_payload(registration, config),
    )
    .map(|_| ())
}

fn post_platform_connect_json(
    registration: &A2APlatformRegistrationConfig,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(registration.timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to build Platform client: {error}"))?;
    let url = format!("{}{}", registration.base_url, path);
    let response = client
        .post(&url)
        .bearer_auth(&registration.token)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("X-Organization-ID", &registration.organization_id)
        .header("X-Workspace-ID", &registration.workspace_id)
        .json(body)
        .send()
        .map_err(|error| format!("POST {url} failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("POST {url} response read failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("POST {url} returned {}: {}", status.as_u16(), text));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("POST {url} returned invalid JSON: {error}"))
}

pub(crate) fn a2a_platform_register_payload(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Value {
    let mut payload = Map::new();
    insert_string(
        &mut payload,
        "workspaceId",
        Some(&registration.workspace_id),
    );
    insert_string(&mut payload, "id", Some(&registration.agent_id));
    insert_string(&mut payload, "name", Some(&registration.name));
    insert_string(&mut payload, "description", Some(&registration.description));
    insert_string(&mut payload, "agentType", Some(&registration.agent_type));
    insert_string(&mut payload, "ownerId", registration.owner_id.as_deref());
    payload.insert(
        "capabilities".to_string(),
        Value::Array(
            a2a_platform_capabilities()
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    payload.insert(
        "surfaces".to_string(),
        Value::Array(
            vec![registration.surface.clone(), "maestro".to_string()]
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    payload.insert(
        "surfaceTypes".to_string(),
        Value::Array(vec![Value::String(registration.surface_type.clone())]),
    );
    payload.insert(
        "a2a".to_string(),
        a2a_platform_peer_projection(registration, config),
    );
    Value::Object(payload)
}

fn a2a_platform_update_payload(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Value {
    let mut payload = match a2a_platform_register_payload(registration, config) {
        Value::Object(payload) => payload,
        _ => Map::new(),
    };
    payload.remove("workspaceId");
    payload.remove("agentType");
    payload.remove("ownerId");
    Value::Object(payload)
}

pub(crate) fn a2a_platform_heartbeat_payload(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Value {
    let mut payload = Map::new();
    insert_string(&mut payload, "agentId", Some(&registration.agent_id));
    insert_string(
        &mut payload,
        "status",
        Some(
            trimmed_env("MAESTRO_A2A_PLATFORM_STATUS")
                .as_deref()
                .unwrap_or("AGENT_STATUS_IDLE"),
        ),
    );
    if !registration.current_objective_ids.is_empty() {
        payload.insert(
            "currentObjectiveIds".to_string(),
            Value::Array(
                registration
                    .current_objective_ids
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    insert_string(&mut payload, "surface", Some(&registration.surface));
    insert_string(
        &mut payload,
        "surfaceType",
        Some(&registration.surface_type),
    );
    payload.insert(
        "a2a".to_string(),
        a2a_platform_peer_projection(registration, config),
    );
    Value::Object(payload)
}

fn a2a_platform_peer_projection(
    registration: &A2APlatformRegistrationConfig,
    config: &Config,
) -> Value {
    let public_endpoint_url = registration.public_endpoint_url.trim_end_matches('/');
    let agent_card_url = registration
        .agent_card_url
        .clone()
        .unwrap_or_else(|| format!("{public_endpoint_url}/.well-known/agent-card.json"));
    let mut attributes = Map::new();
    insert_string(&mut attributes, "runtime", Some("maestro"));
    insert_string(&mut attributes, "controlPlane", Some("rust-control-plane"));
    insert_string(
        &mut attributes,
        "operatingPlaneExtension",
        Some(EVALOPS_A2A_EXTENSION_URI),
    );
    insert_string(
        &mut attributes,
        "maxConcurrentObjectives",
        Some(&registration.max_concurrent_objectives),
    );
    insert_string(
        &mut attributes,
        "taskStorePath",
        config.a2a_tasks_file_path.to_str(),
    );
    insert_string(
        &mut attributes,
        "publishedBy",
        Some("maestro-control-plane-auto-registration"),
    );

    let mut projection = Map::new();
    insert_string(
        &mut projection,
        "publicEndpointUrl",
        Some(public_endpoint_url),
    );
    insert_string(
        &mut projection,
        "internalEndpointUrl",
        registration.internal_endpoint_url.as_deref(),
    );
    insert_string(&mut projection, "agentCardUrl", Some(&agent_card_url));
    insert_string(&mut projection, "protocolBinding", Some("HTTP+JSON"));
    insert_string(
        &mut projection,
        "protocolVersion",
        Some(A2A_PROTOCOL_VERSION),
    );
    projection.insert(
        "supportedExtensions".to_string(),
        Value::Array(vec![Value::String(EVALOPS_A2A_EXTENSION_URI.to_string())]),
    );
    projection.insert(
        "skills".to_string(),
        Value::Array(a2a_platform_agent_skills()),
    );
    projection.insert(
        "securitySchemes".to_string(),
        Value::Array(vec![Value::String("evalops-agent-token".to_string())]),
    );
    projection.insert("pushNotifications".to_string(), Value::Bool(true));
    projection.insert("attributes".to_string(), Value::Object(attributes));
    Value::Object(projection)
}

fn a2a_platform_agent_skills() -> Vec<Value> {
    match a2a_agent_skills() {
        Value::Array(skills) => skills
            .into_iter()
            .filter_map(|skill| match skill {
                Value::Object(skill) => Some(a2a_platform_agent_skill(skill)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn a2a_platform_agent_skill(skill: Map<String, Value>) -> Value {
    let mut projected = Map::new();
    for key in [
        "id",
        "name",
        "description",
        "tags",
        "inputModes",
        "outputModes",
        "requiredContextGrants",
        "approvalPolicyRef",
        "maxAutonomy",
        "requiredArtifactKinds",
        "optionalArtifactKinds",
        "allowedTaskClasses",
        "deniedTaskClasses",
        "attributes",
    ] {
        if let Some(value) = skill.get(key) {
            projected.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(projected)
}

fn a2a_platform_capabilities() -> Vec<String> {
    let mut capabilities = vec![
        "maestro:a2a".to_string(),
        "maestro:cli".to_string(),
        "maestro:subagents".to_string(),
    ];
    for lane in codex_subagent_dispatch::CODEX_SUBAGENT_DISPATCH_LANES {
        capabilities.push(format!("maestro:{}", lane.lane_id));
        capabilities.extend(
            match lane.lane_id {
                "code-writer" => ["code:write", "code:edit", "code:implement"].as_slice(),
                "code-review" => ["code:review"].as_slice(),
                "test-runner" => ["code:test", "test:run"].as_slice(),
                "repo-explorer" => ["repo:explore", "code:search"].as_slice(),
                "release-shepherd" => ["release:shepherd", "release:manage"].as_slice(),
                _ => ["agent:delegate"].as_slice(),
            }
            .iter()
            .map(|value| (*value).to_string()),
        );
    }
    dedupe_strings(capabilities)
}

pub(crate) fn platform_error_is_conflict(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|part| part == "409")
        || lower.contains("already exists")
        || lower.contains("already_exists")
}

fn default_a2a_platform_agent_id(config: &Config) -> String {
    let host = first_trimmed_env(&["HOSTNAME", "COMPUTERNAME"])
        .unwrap_or_else(|| config.listen_host.clone());
    format!(
        "maestro-a2a-{}-{}",
        sanitize_agent_id_component(&host),
        config.listen_port
    )
}

fn sanitize_agent_id_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        "local".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn normalize_platform_base_url(base_url: &str) -> String {
    let mut normalized = base_url.trim().trim_end_matches('/').to_string();
    if let Some(index) = normalized.find("/agents.v1.AgentService") {
        normalized.truncate(index);
        return normalized.trim_end_matches('/').to_string();
    }
    for suffix in [
        PLATFORM_AGENT_REGISTER_PATH,
        PLATFORM_AGENT_UPDATE_PATH,
        PLATFORM_AGENT_HEARTBEAT_PATH,
        "/agents.v1.AgentService",
    ] {
        if normalized.ends_with(suffix) {
            normalized = normalized
                .trim_end_matches(suffix)
                .trim_end_matches('/')
                .to_string();
        }
    }
    normalized
}

fn first_trimmed_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| trimmed_env(name))
}

fn env_bool(name: &str) -> Option<bool> {
    trimmed_env(name).and_then(|value| match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    })
}

fn env_u64_from_names(names: &[&str], default: u64) -> u64 {
    names
        .iter()
        .find_map(|name| trimmed_env(name))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn csv_env(name: &str) -> Vec<String> {
    trimmed_env(name)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn dedupe_strings(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        if !output.contains(&value) {
            output.push(value);
        }
    }
    output
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

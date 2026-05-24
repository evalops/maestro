use super::*;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener as StdTcpListener;

static ENV_LOCK: Mutex<()> = Mutex::const_new(());
const A2A_PLATFORM_ENV_NAMES: &[&str] = &[
    "MAESTRO_A2A_PLATFORM_REGISTER",
    "MAESTRO_A2A_PLATFORM_AUTO_REGISTER",
    "MAESTRO_HOSTED_RUNNER_MODE",
    "MAESTRO_HOSTED_RUNNER",
    "MAESTRO_AGENT_REGISTRY_SERVICE_URL",
    "AGENT_REGISTRY_SERVICE_URL",
    "MAESTRO_AGENT_REGISTRY_URL",
    "AGENT_REGISTRY_BASE_URL",
    "PLATFORM_AGENT_REGISTRY_URL",
    "MAESTRO_PLATFORM_BASE_URL",
    "MAESTRO_EVALOPS_BASE_URL",
    "EVALOPS_BASE_URL",
    "MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
    "AGENT_REGISTRY_SERVICE_TOKEN",
    "MAESTRO_AGENT_REGISTRY_TOKEN",
    "AGENT_REGISTRY_TOKEN",
    "MAESTRO_EVALOPS_ACCESS_TOKEN",
    "EVALOPS_TOKEN",
    "MAESTRO_AGENT_REGISTRY_ORG_ID",
    "AGENT_REGISTRY_ORGANIZATION_ID",
    "AGENT_REGISTRY_ORG_ID",
    "MAESTRO_EVALOPS_ORG_ID",
    "EVALOPS_ORGANIZATION_ID",
    "EVALOPS_ORG_ID",
    "MAESTRO_ENTERPRISE_ORG_ID",
    "MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
    "AGENT_REGISTRY_WORKSPACE_ID",
    "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
    "MAESTRO_EVALOPS_WORKSPACE_ID",
    "EVALOPS_WORKSPACE_ID",
    "MAESTRO_WORKSPACE_ID",
    "MAESTRO_A2A_PUBLIC_URL",
    "MAESTRO_CONTROL_PUBLIC_URL",
    "MAESTRO_A2A_URL",
    "MAESTRO_CONTROL_URL",
    "MAESTRO_A2A_AGENT_ID",
    "MAESTRO_AGENT_ID",
    "EVALOPS_AGENT_ID",
    "MAESTRO_A2A_AGENT_NAME",
    "MAESTRO_AGENT_NAME",
    "MAESTRO_A2A_AGENT_DESCRIPTION",
    "MAESTRO_AGENT_DESCRIPTION",
    "MAESTRO_A2A_AGENT_TYPE",
    "MAESTRO_A2A_OWNER_ID",
    "EVALOPS_USER_ID",
    "MAESTRO_A2A_INTERNAL_URL",
    "MAESTRO_CONTROL_INTERNAL_URL",
    "MAESTRO_A2A_AGENT_CARD_URL",
    "MAESTRO_A2A_PLATFORM_HEARTBEAT_INTERVAL_MS",
    "MAESTRO_AGENT_REGISTRY_HEARTBEAT_INTERVAL_MS",
    "MAESTRO_AGENT_REGISTRY_TIMEOUT_MS",
    "AGENT_REGISTRY_SERVICE_TIMEOUT_MS",
    "MAESTRO_A2A_CURRENT_OBJECTIVE_IDS",
    "MAESTRO_A2A_MAX_CONCURRENT_OBJECTIVES",
    "MAESTRO_SWARM_MAX_TEAMMATES",
    "MAESTRO_A2A_PLATFORM_SURFACE",
    "MAESTRO_A2A_PLATFORM_SURFACE_TYPE",
    "MAESTRO_A2A_PLATFORM_STATUS",
    "PORT",
    "MAESTRO_CONTROL_HOST",
];

fn snapshot_env(names: &'static [&'static str]) -> Vec<(&'static str, Option<std::ffi::OsString>)> {
    names
        .iter()
        .map(|name| (*name, env::var_os(name)))
        .collect()
}

fn restore_env(snapshot: Vec<(&'static str, Option<std::ffi::OsString>)>) {
    for (name, value) in snapshot {
        if let Some(value) = value {
            env::set_var(name, value);
        } else {
            env::remove_var(name);
        }
    }
}

fn clear_env(names: &[&str]) {
    for name in names {
        env::remove_var(name);
    }
}

#[derive(Debug)]
struct CapturedHttpRequest {
    request_line: String,
    headers: HashMap<String, String>,
    body: Value,
}

fn capture_http_request(
    listener: &StdTcpListener,
    status_line: &str,
    response_body: &str,
) -> CapturedHttpRequest {
    let (mut stream, _) = listener
        .accept()
        .expect("test server should accept request");
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let read = stream
            .read(&mut chunk)
            .expect("test server should read request");
        assert!(read > 0, "client closed before request headers");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines
        .next()
        .expect("request should include request line")
        .to_string();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + content_length {
        let read = stream
            .read(&mut chunk)
            .expect("test server should read request body");
        assert!(read > 0, "client closed before request body");
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = if content_length == 0 {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&buffer[header_end..header_end + content_length])
            .expect("request body should be JSON")
    };
    let response = format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
    stream
        .write_all(response.as_bytes())
        .expect("test server should write response");
    CapturedHttpRequest {
        request_line,
        headers,
        body,
    }
}

#[test]
fn cli_args_default_to_serving() {
    assert_eq!(
        parse_cli_action(Vec::<String>::new()).unwrap(),
        CliAction::Serve
    );
}

#[test]
fn cli_args_handle_help_and_version_without_serving() {
    assert_eq!(parse_cli_action(["--help"]).unwrap(), CliAction::Help);
    assert_eq!(parse_cli_action(["-h"]).unwrap(), CliAction::Help);
    assert_eq!(parse_cli_action(["--version"]).unwrap(), CliAction::Version);
    assert_eq!(parse_cli_action(["-V"]).unwrap(), CliAction::Version);
}

#[test]
fn cli_args_reject_unknown_values() {
    let error = parse_cli_action(["--wat"]).unwrap_err();
    assert!(error.contains("--wat"));
}

#[test]
fn a2a_platform_registration_defaults_to_hosted_mode() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    assert!(!a2a_platform_registration_enabled());
    env::set_var("MAESTRO_HOSTED_RUNNER_MODE", "1");
    assert!(a2a_platform_registration_enabled());
    env::set_var("MAESTRO_A2A_PLATFORM_REGISTER", "0");
    assert!(!a2a_platform_registration_enabled());
    env::set_var("MAESTRO_A2A_PLATFORM_REGISTER", "1");
    assert!(a2a_platform_registration_enabled());

    restore_env(snapshot);
}

#[test]
fn a2a_platform_registration_config_uses_platform_env_and_stable_endpoint() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    env::set_var("MAESTRO_HOSTED_RUNNER_MODE", "1");
    env::set_var(
        "AGENT_REGISTRY_SERVICE_URL",
        "https://platform.test/agents.v1.AgentService/Register",
    );
    env::set_var("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
    env::set_var("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
    env::set_var("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");
    env::set_var("MAESTRO_A2A_PUBLIC_URL", "https://maestro.example/a2a/");
    env::set_var("MAESTRO_A2A_INTERNAL_URL", "http://maestro.mesh/a2a");
    env::set_var("MAESTRO_A2A_AGENT_ID", "maestro-peer-1");
    env::set_var("MAESTRO_A2A_CURRENT_OBJECTIVE_IDS", "obj_1, obj_2");
    env::set_var("MAESTRO_A2A_PLATFORM_HEARTBEAT_INTERVAL_MS", "1234");
    env::set_var("PORT", "18787");

    let config = Config::from_env();
    let registration = resolve_a2a_platform_registration_config(&config)
        .expect("registration config should resolve")
        .expect("hosted mode should enable registration");

    assert_eq!(registration.base_url, "https://platform.test");
    assert_eq!(registration.token, "registry-token");
    assert_eq!(registration.organization_id, "org_1");
    assert_eq!(registration.workspace_id, "ws_1");
    assert_eq!(registration.agent_id, "maestro-peer-1");
    assert_eq!(
        registration.public_endpoint_url,
        "https://maestro.example/a2a/"
    );
    assert_eq!(
        registration.internal_endpoint_url.as_deref(),
        Some("http://maestro.mesh/a2a")
    );
    assert_eq!(
        registration.current_objective_ids,
        vec!["obj_1".to_string(), "obj_2".to_string()]
    );
    assert_eq!(registration.heartbeat_interval_ms, 1234);

    restore_env(snapshot);
}

#[test]
fn a2a_platform_registration_requires_routable_endpoint_in_hosted_default() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    env::set_var("MAESTRO_HOSTED_RUNNER_MODE", "1");
    env::set_var("AGENT_REGISTRY_SERVICE_URL", "https://platform.test");
    env::set_var("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
    env::set_var("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
    env::set_var("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");

    let config = Config::from_env();
    let error = resolve_a2a_platform_registration_config(&config)
        .expect_err("hosted default should require a routable public endpoint");
    assert!(error.contains("routable A2A public URL or public host"));

    env::set_var("MAESTRO_A2A_PLATFORM_REGISTER", "1");
    assert!(resolve_a2a_platform_registration_config(&config)
        .expect("explicit local registration should resolve")
        .is_some());

    restore_env(snapshot);
}

#[test]
fn a2a_platform_registration_falls_back_to_org_scoped_workspace() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    env::set_var("MAESTRO_HOSTED_RUNNER_MODE", "1");
    env::set_var("AGENT_REGISTRY_SERVICE_URL", "https://platform.test");
    env::set_var("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
    env::set_var("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
    env::set_var("MAESTRO_A2A_PUBLIC_URL", "https://maestro.example/a2a");

    let config = Config::from_env();
    let registration = resolve_a2a_platform_registration_config(&config)
        .expect("registration should resolve")
        .expect("hosted mode should enable registration");
    assert_eq!(registration.workspace_id, "org_1");

    restore_env(snapshot);
}

#[test]
fn a2a_platform_payload_projects_governed_agent_card_without_drift_fields() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    let config = Config::from_env();
    let registration = A2APlatformRegistrationConfig {
        base_url: "https://platform.test".to_string(),
        token: "registry-token".to_string(),
        organization_id: "org_1".to_string(),
        workspace_id: "ws_1".to_string(),
        agent_id: "maestro-peer-1".to_string(),
        name: "Maestro Peer".to_string(),
        description: "Peer".to_string(),
        agent_type: "maestro".to_string(),
        owner_id: None,
        public_endpoint_url: "https://maestro.example/a2a".to_string(),
        internal_endpoint_url: Some("http://maestro.mesh/a2a".to_string()),
        agent_card_url: None,
        heartbeat_interval_ms: 60_000,
        timeout_ms: 2_500,
        current_objective_ids: vec!["obj_1".to_string()],
        max_concurrent_objectives: "4".to_string(),
        surface: "a2a".to_string(),
        surface_type: "SURFACE_MAESTRO".to_string(),
    };

    let payload = a2a_platform_register_payload(&registration, &config);
    assert_eq!(payload["id"], "maestro-peer-1");
    assert_eq!(
        payload["a2a"]["publicEndpointUrl"],
        "https://maestro.example/a2a"
    );
    assert_eq!(
        payload["a2a"]["agentCardUrl"],
        "https://maestro.example/a2a/.well-known/agent-card.json"
    );
    assert_eq!(payload["a2a"]["attributes"]["maxConcurrentObjectives"], "4");
    assert!(payload["capabilities"]
        .as_array()
        .expect("capabilities")
        .contains(&Value::String("code:review".to_string())));

    let skills = payload["a2a"]["skills"].as_array().expect("skills");
    let review = skills
        .iter()
        .find(|skill| skill["id"] == "maestro.subagent.code-review")
        .expect("review skill should be advertised");
    assert_eq!(review["requiredContextGrants"][0], "repo:read");
    assert_eq!(review["allowedTaskClasses"][0], "code.review");
    assert!(review.get("metadata").is_none());
    assert!(review.get("examples").is_none());

    let heartbeat = a2a_platform_heartbeat_payload(&registration, &config);
    assert_eq!(heartbeat["agentId"], "maestro-peer-1");
    assert_eq!(heartbeat["currentObjectiveIds"][0], "obj_1");
    assert_eq!(heartbeat["surface"], "a2a");
    assert_eq!(heartbeat["surfaceType"], "SURFACE_MAESTRO");

    restore_env(snapshot);
}

#[test]
fn a2a_platform_registration_posts_update_after_conflict_and_heartbeat() {
    let _guard = ENV_LOCK.blocking_lock();
    let snapshot = snapshot_env(A2A_PLATFORM_ENV_NAMES);
    clear_env(A2A_PLATFORM_ENV_NAMES);

    let listener = StdTcpListener::bind("127.0.0.1:0").expect("bind test server");
    let addr = listener.local_addr().expect("test server addr");
    let server = thread::spawn(move || {
        let register =
            capture_http_request(&listener, "409 Conflict", r#"{"message":"already exists"}"#);
        let update =
            capture_http_request(&listener, "200 OK", r#"{"agent":{"id":"maestro-peer-1"}}"#);
        let heartbeat = capture_http_request(
            &listener,
            "200 OK",
            r#"{"nextHeartbeatBy":"2026-05-20T10:05:00Z"}"#,
        );
        vec![register, update, heartbeat]
    });

    let config = Config::from_env();
    let registration = A2APlatformRegistrationConfig {
        base_url: format!("http://{addr}"),
        token: "registry-token".to_string(),
        organization_id: "org_1".to_string(),
        workspace_id: "ws_1".to_string(),
        agent_id: "maestro-peer-1".to_string(),
        name: "Maestro Peer".to_string(),
        description: "Peer".to_string(),
        agent_type: "maestro".to_string(),
        owner_id: Some("user_1".to_string()),
        public_endpoint_url: "https://maestro.example/a2a".to_string(),
        internal_endpoint_url: Some("http://maestro.mesh/a2a".to_string()),
        agent_card_url: None,
        heartbeat_interval_ms: 60_000,
        timeout_ms: 2_500,
        current_objective_ids: vec!["obj_1".to_string()],
        max_concurrent_objectives: "4".to_string(),
        surface: "a2a".to_string(),
        surface_type: "SURFACE_MAESTRO".to_string(),
    };

    register_or_update_a2a_platform_agent(&registration, &config)
        .expect("conflict should fall back to update");
    send_a2a_platform_heartbeat(&registration, &config)
        .expect("heartbeat should post after update");

    let requests = server.join().expect("test server should finish");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.request_line.as_str())
            .collect::<Vec<_>>(),
        vec![
            "POST /agents.v1.AgentService/Register HTTP/1.1",
            "POST /agents.v1.AgentService/Update HTTP/1.1",
            "POST /agents.v1.AgentService/Heartbeat HTTP/1.1"
        ]
    );
    for request in &requests {
        assert_eq!(
            request.headers.get("authorization").map(String::as_str),
            Some("Bearer registry-token")
        );
        assert_eq!(
            request
                .headers
                .get("connect-protocol-version")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            request.headers.get("x-organization-id").map(String::as_str),
            Some("org_1")
        );
        assert_eq!(
            request.headers.get("x-workspace-id").map(String::as_str),
            Some("ws_1")
        );
    }
    assert_eq!(requests[0].body["workspaceId"], "ws_1");
    assert_eq!(requests[0].body["ownerId"], "user_1");
    assert_eq!(
        requests[0].body["a2a"]["publicEndpointUrl"],
        "https://maestro.example/a2a"
    );
    assert!(requests[1].body.get("workspaceId").is_none());
    assert_eq!(requests[1].body["id"], "maestro-peer-1");
    assert_eq!(requests[2].body["agentId"], "maestro-peer-1");
    assert_eq!(requests[2].body["currentObjectiveIds"][0], "obj_1");

    restore_env(snapshot);
}

#[test]
fn a2a_platform_conflict_detection_requires_bounded_status() {
    assert!(platform_error_is_conflict(
        "POST /Register returned 409: already exists"
    ));
    assert!(platform_error_is_conflict("agent already_exists"));
    assert!(!platform_error_is_conflict(
        "POST http://127.0.0.1:4090/Register failed: connection refused"
    ));
    assert!(!platform_error_is_conflict(
        "POST /Register returned 500: trace id 4090"
    ));
}

#[test]
fn a2a_platform_base_url_strips_any_agent_service_method_suffix() {
    assert_eq!(
        normalize_platform_base_url("https://platform.test/agents.v1.AgentService/Register"),
        "https://platform.test"
    );
    assert_eq!(
        normalize_platform_base_url("https://platform.test/agents.v1.AgentService/Delegate"),
        "https://platform.test"
    );
    assert_eq!(
        normalize_platform_base_url("https://platform.test/prefix/agents.v1.AgentService/List"),
        "https://platform.test/prefix"
    );
}

#[test]
fn codex_app_server_model_ids_require_openai_codex_prefix() {
    assert_eq!(
        codex_app_server_model_id("openai-codex/gpt-5.5").as_deref(),
        Some("gpt-5.5")
    );
    assert_eq!(
        codex_app_server_model_id(" openai-codex/gpt-5.1-codex-max ").as_deref(),
        Some("gpt-5.1-codex-max")
    );
    assert!(codex_app_server_model_id("openai/gpt-5.5").is_none());
    assert!(codex_app_server_model_id("openai-codex/").is_none());
}

#[test]
fn codex_app_server_sandbox_mode_inherits_without_forcing_read_only() {
    assert_eq!(codex_app_server_sandbox_mode_from_values(None, None), None);
    assert_eq!(
        codex_app_server_sandbox_mode_from_values(None, Some("workspace-write")).as_deref(),
        Some("workspace-write")
    );
    assert_eq!(
        codex_app_server_sandbox_mode_from_values(Some("danger-full-access"), Some("read-only"))
            .as_deref(),
        Some("danger-full-access")
    );
    assert_eq!(
        codex_app_server_sandbox_mode_from_values(Some("inherit"), Some("workspace-write")),
        None
    );
}

#[test]
fn assistant_text_from_jsonl_reads_assistant_completion_only() {
    let jsonl = r#"noise line
{"type":"turn","phase":"start","role":"user","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"user text"}}
{"type":"turn","phase":"end","role":"user","turnId":"turn-1"}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-2"}
{"type":"item","subtype":"message_delta","turnId":"turn-2","data":{"text":"partial"}}
{"type":"item","subtype":"message_complete","turnId":"turn-2","data":{"text":"assistant text"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-2"}
        "#;
    assert_eq!(
        assistant_text_from_jsonl(jsonl).as_deref(),
        Ok("assistant text")
    );
}

#[test]
fn assistant_text_from_jsonl_requires_assistant_completion() {
    let jsonl = r#"
{"type":"thread","phase":"start","threadId":"thread-1"}
{"type":"turn","phase":"start","role":"user","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"user text"}}
{"type":"turn","phase":"end","role":"user","turnId":"turn-1"}
"#;
    assert!(assistant_text_from_jsonl(jsonl)
        .unwrap_err()
        .contains("without an assistant message"));
}

#[test]
fn assistant_text_from_jsonl_rejects_error_stop_reason() {
    let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"","stopReason":"error"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    assert!(assistant_text_from_jsonl(jsonl)
        .unwrap_err()
        .contains("error stop reason"));
}

#[test]
fn assistant_text_from_jsonl_rejects_empty_assistant_text() {
    let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    assert!(assistant_text_from_jsonl(jsonl)
        .unwrap_err()
        .contains("empty assistant message"));
}

#[test]
fn assistant_output_from_jsonl_reads_usage() {
    let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop","usage":{"input":123,"output":45,"cacheRead":7,"cacheWrite":3,"cost":{"input":0.1,"output":0.2,"cacheRead":0.01,"cacheWrite":0.02,"total":0.33}}}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    let output = assistant_output_from_jsonl(jsonl).expect("assistant output");
    let usage = output.usage.expect("usage");

    assert_eq!(output.text, "assistant text");
    assert_eq!(usage.input_tokens, 123);
    assert_eq!(usage.output_tokens, 45);
    assert_eq!(usage.cache_read_tokens, 7);
    assert_eq!(usage.cache_write_tokens, 3);
    assert_eq!(usage.cost, Some(0.33));
}

#[test]
fn assistant_output_from_jsonl_records_codex_collab_tool_items() {
    let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"prompt":"Inspect routing","agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"prompt":"Inspect routing","agents_states":{"thread-child":{"status":"completed","message":"Done"}},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

    assert_eq!(output.text, "assistant text");
    assert_eq!(output.tool_events.len(), 2);
    assert_eq!(output.tool_events[0].event_type, "tool_execution_start");
    assert_eq!(output.tool_events[0].tool_call_id, "collab-call-1");
    assert_eq!(output.tool_events[0].tool_name, "codex.subagent.spawnAgent");
    assert_eq!(
        output.tool_events[0].args["receiverThreadIds"],
        serde_json::json!(["thread-child"])
    );
    assert_eq!(
        output.tool_events[0].args["childRunIds"],
        serde_json::json!(["codex-thread:thread-child"])
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["schemaVersion"],
        CODEX_SUBAGENT_WORK_GRAPH_SCHEMA
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "codex-thread:thread-child"
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["edgeId"],
        "collab-call-1:0:spawnAgent:codex-thread:thread-child"
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["targetIndex"],
        serde_json::json!(0)
    );
    assert!(output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["status"].is_null());
    assert_eq!(output.tool_events[1].event_type, "tool_execution_end");
    assert_eq!(output.tool_events[1].is_error, Some(false));
    assert_eq!(
        output.tool_events[1].result["details"]["codexWorkGraph"]["status"],
        "completed"
    );
    assert_eq!(
        output.tool_events[1].result["details"]["codexWorkGraph"]["childRuns"][0]["status"],
        "completed"
    );
    assert_eq!(
        output.tool_events[1].result["details"]["agentsStates"]["thread-child"]["status"],
        "completed"
    );
}

#[test]
fn assistant_output_from_jsonl_normalizes_codex_collab_tool_aliases() {
    let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-wait","type":"collab_tool_call","tool":"wait_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-wait","type":"collab_tool_call","tool":"wait_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"agents_states":{},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

    assert_eq!(output.tool_events.len(), 2);
    assert_eq!(output.tool_events[0].tool_name, "codex.subagent.wait");
    assert_eq!(
        output.tool_events[0].display_name.as_deref(),
        Some("Codex subagent: wait")
    );
    assert_eq!(
        output.tool_events[0].args["codexTool"],
        serde_json::json!("wait")
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["tool"],
        serde_json::json!("wait")
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["operation"],
        serde_json::json!("wait")
    );
    assert_eq!(output.tool_events[1].tool_name, "codex.subagent.wait");
    assert_eq!(
        output.tool_events[1].result["details"]["codexTool"],
        serde_json::json!("wait")
    );
}

#[test]
fn assistant_output_from_jsonl_preserves_explicit_codex_child_run_ids() {
    let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"prompt":"Inspect routing","agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"prompt":"Inspect routing","agents_states":{},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

    assert_eq!(
        output.tool_events[0].args["childRunIds"],
        serde_json::json!(["agent-run-child-1"])
    );
    assert_eq!(
        output.tool_events[1].result["details"]["childRunIds"],
        serde_json::json!(["agent-run-child-1"])
    );
    assert_eq!(
        output.tool_events[1].result["details"]["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "agent-run-child-1"
    );
}

#[test]
fn assistant_output_from_jsonl_records_maestro_headless_tool_events() {
    let jsonl = r#"
{"type":"item","subtype":"tool_call","data":{"toolCallId":"collab-call-2","toolName":"codex.subagent.wait","args":{"codexTool":"wait","receiverThreadIds":["thread-child"]}}}
{"type":"item","subtype":"tool_result","data":{"toolCallId":"collab-call-2","toolName":"codex.subagent.wait","result":{"role":"toolResult","toolCallId":"collab-call-2","toolName":"codex.subagent.wait","content":[{"type":"text","text":"wait completed"}],"isError":false,"timestamp":1},"isError":false}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
    let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

    assert_eq!(output.tool_events.len(), 2);
    assert_eq!(output.tool_events[0].tool_name, "codex.subagent.wait");
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "codex-thread:thread-child"
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["toolCallId"],
        "collab-call-2"
    );
    assert_eq!(
        output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["edgeId"],
        "collab-call-2:0:wait:codex-thread:thread-child"
    );
    assert_eq!(output.tool_events[1].is_error, Some(false));
    assert_eq!(
        output.tool_events[1].result["content"][0]["text"],
        "wait completed"
    );
}

#[test]
fn codex_headless_usage_omits_empty_usage() {
    let event = serde_json::json!({
        "type": "response_end",
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0
        }
    });

    assert!(codex_headless_usage_from_json(&event).is_none());
}

#[test]
fn codex_headless_tool_events_preserve_subagent_lifecycle() {
    let start = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_call",
        "call_id": "collab-call-3",
        "tool": "codex.subagent.sendInput",
        "args": {
            "codexTool": "sendInput",
            "receiverThreadIds": ["thread-child"],
            "prompt": "Please continue"
        }
    }))
    .expect("start event");
    let end = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_end",
        "call_id": "collab-call-3",
        "tool": "codex.subagent.sendInput",
        "success": false,
        "error_code": "subagent_not_found",
        "details": {
            "receiverThreadIds": ["thread-child"],
            "childRunIds": ["agent-run-child-1"],
            "agentsStates": {
                "thread-child": { "status": "failed" }
            }
        }
    }))
    .expect("end event");

    assert_eq!(start.event_type, "tool_execution_start");
    assert_eq!(start.tool_name, "codex.subagent.sendInput");
    assert_eq!(start.args["prompt"], "Please continue");
    assert_eq!(start.args["toolCallId"], "collab-call-3");
    assert_eq!(start.args["codexWorkGraph"]["toolCallId"], "collab-call-3");
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["edgeId"],
        "collab-call-3:0:sendInput:codex-thread:thread-child"
    );
    assert_eq!(end.event_type, "tool_execution_end");
    assert_eq!(end.tool_call_id, "collab-call-3");
    assert_eq!(end.is_error, Some(true));
    assert_eq!(end.result["details"]["errorCode"], "subagent_not_found");
    assert_eq!(
        end.result["details"]["receiverThreadIds"],
        serde_json::json!(["thread-child"])
    );
    assert_eq!(
        end.result["details"]["childRunIds"],
        serde_json::json!(["agent-run-child-1"])
    );
    assert_eq!(
        end.result["details"]["agentsStates"]["thread-child"]["status"],
        "failed"
    );
    assert_eq!(
        end.result["content"][0]["text"],
        "codex.subagent.sendInput failed"
    );
}

#[test]
fn codex_headless_tool_events_normalize_snake_case_subagent_targets() {
    let start = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_call",
        "call_id": "collab-call-snake",
        "tool": "codex.subagent.send_input",
        "args": {
            "codex_tool": "send_input",
            "sender_thread_id": "thread-parent",
            "receiver_thread_ids": ["thread-child"],
            "child_run_ids": ["agent-run-child-1"],
            "agents_states": {
                "thread-child": { "status": "acknowledged" }
            }
        }
    }))
    .expect("start event");

    assert_eq!(start.tool_name, "codex.subagent.sendInput");
    assert_eq!(start.args["codexTool"], serde_json::json!("sendInput"));
    assert_eq!(
        start.args["receiverThreadIds"],
        serde_json::json!(["thread-child"])
    );
    assert_eq!(
        start.args["childRunIds"],
        serde_json::json!(["agent-run-child-1"])
    );
    assert_eq!(start.args["senderThreadId"], "thread-parent");
    assert_eq!(
        start.args["codexWorkGraph"]["parent"]["senderThreadId"],
        "thread-parent"
    );
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["threadId"],
        "thread-child"
    );
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "agent-run-child-1"
    );
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["status"],
        "acknowledged"
    );
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["edgeId"],
        "collab-call-snake:0:sendInput:agent-run-child-1"
    );
}

#[test]
fn codex_headless_tool_events_build_work_graph_from_child_run_ids_only() {
    let start = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_call",
        "call_id": "collab-call-child-only",
        "tool": "codex.subagent.wait",
        "args": {
            "child_run_ids": ["agent-run-child-only"]
        }
    }))
    .expect("start event");

    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "agent-run-child-only"
    );
    assert!(start.args["codexWorkGraph"]["childRuns"][0]["threadId"].is_null());
}

#[test]
fn codex_headless_tool_events_normalize_subagent_aliases() {
    let start = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_call",
        "call_id": "collab-call-5",
        "tool": "codex.subagent.resume_subagent",
        "args": {
            "codexTool": "resume_subagent",
            "receiverThreadIds": ["thread-child"],
            "childRunIds": ["agent-run-child-1"]
        }
    }))
    .expect("start event");
    let end = codex_headless_tool_event_from_json(&serde_json::json!({
        "type": "tool_end",
        "call_id": "collab-call-5",
        "tool": "codex.subagent.resume_subagent",
        "success": true
    }))
    .expect("end event");

    assert_eq!(start.tool_name, "codex.subagent.resumeAgent");
    assert_eq!(start.args["codexTool"], serde_json::json!("resumeAgent"));
    assert_eq!(
        start.args["codexWorkGraph"]["tool"],
        serde_json::json!("resumeAgent")
    );
    assert_eq!(
        start.args["codexWorkGraph"]["childRuns"][0]["operation"],
        serde_json::json!("resumeAgent")
    );
    assert_eq!(end.tool_name, "codex.subagent.resumeAgent");
    assert_eq!(
        end.result["content"][0]["text"],
        "codex.subagent.resumeAgent completed"
    );
}

#[test]
fn codex_headless_subagent_lifecycle_matches_workgraph_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../docs/protocols/codex-subagent-workgraph-v1.json"
    ))
    .expect("work graph fixture should parse");
    assert_eq!(
        fixture["schemaVersion"],
        serde_json::json!(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA)
    );
    assert_eq!(fixture["toolPrefix"], "codex.subagent.");
    assert_eq!(fixture["threadChildRunPrefix"], "codex-thread:");

    let operations = fixture["operations"]
        .as_array()
        .expect("fixture operations should be an array");
    let mut seen_tools = Vec::new();
    for operation in operations {
        let tool = operation["tool"].as_str().expect("tool");
        let operation_name = operation["operation"].as_str().expect("operation");
        let aliases = operation["aliases"].as_array().expect("aliases");
        assert_eq!(codex_canonical_collab_tool(tool), tool);
        assert_eq!(codex_canonical_collab_tool(operation_name), tool);
        seen_tools.push(tool.to_string());

        for alias in aliases {
            let alias = alias.as_str().expect("alias");
            assert_eq!(codex_canonical_collab_tool(alias), tool);
            let start = codex_headless_tool_event_from_json(&serde_json::json!({
                "type": "tool_call",
                "call_id": format!("collab-{operation_name}"),
                "tool": format!("codex.subagent.{alias}"),
                "args": {
                    "codexTool": alias,
                    "senderThreadId": "thread-parent",
                    "receiverThreadIds": ["thread-child"],
                    "childRunIds": ["agent-run-child-1"]
                }
            }))
            .expect("start event");

            assert_eq!(start.tool_name, format!("codex.subagent.{tool}"));
            assert_eq!(start.args["codexTool"], serde_json::json!(tool));
            assert_eq!(start.args["senderThreadId"], "thread-parent");
            assert_eq!(
                start.args["codexWorkGraph"]["schemaVersion"],
                serde_json::json!(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA)
            );
            assert_eq!(
                start.args["codexWorkGraph"]["tool"],
                serde_json::json!(tool)
            );
            assert_eq!(
                start.args["codexWorkGraph"]["childRuns"][0]["operation"],
                serde_json::json!(tool)
            );
            assert_eq!(
                start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
                "agent-run-child-1"
            );
        }
    }

    assert_eq!(
        seen_tools,
        vec![
            "spawnAgent",
            "sendInput",
            "resumeAgent",
            "wait",
            "closeAgent"
        ]
    );
}

#[test]
fn codex_headless_tool_end_uses_start_context_when_end_omits_tool_name() {
    let mut contexts = HashMap::new();
    let _ = codex_headless_tool_event_from_json_with_context(
        &serde_json::json!({
            "type": "tool_call",
            "call_id": "collab-call-4",
            "tool": "codex.subagent.spawnAgent",
            "args": {
                "codexTool": "spawnAgent",
                "receiverThreadIds": []
            }
        }),
        &mut contexts,
    )
    .expect("start event");
    let end = codex_headless_tool_event_from_json_with_context(
        &serde_json::json!({
            "type": "tool_end",
            "call_id": "collab-call-4",
            "success": true,
            "details": {
                "receiverThreadIds": ["thread-child-complete"],
                "childRunIds": ["agent-run-child-complete"]
            }
        }),
        &mut contexts,
    )
    .expect("end event");

    assert_eq!(end.tool_name, "codex.subagent.spawnAgent");
    assert_eq!(end.summary_label.as_deref(), Some("spawn agent"));
    assert_eq!(
        end.result["content"][0]["text"],
        "codex.subagent.spawnAgent completed"
    );
    assert_eq!(end.result["details"]["args"]["codexTool"], "spawnAgent");
    assert_eq!(
        end.result["details"]["receiverThreadIds"],
        serde_json::json!(["thread-child-complete"])
    );
    assert_eq!(
        end.result["details"]["childRunIds"],
        serde_json::json!(["agent-run-child-complete"])
    );
}

#[test]
fn codex_bridge_prompt_body_lists_attachment_paths() {
    let body = codex_bridge_prompt_body(
        "Summarize the upload",
        &[
            "/tmp/maestro-chat/a/report.pdf".to_string(),
            "/tmp/maestro-chat/a/screenshot.png".to_string(),
        ],
    );
    assert!(body.contains("Summarize the upload"));
    assert!(body.contains("/tmp/maestro-chat/a/report.pdf"));
    assert!(body.contains("/tmp/maestro-chat/a/screenshot.png"));
}

#[test]
fn codex_bridge_temp_dirs_are_unique_per_request() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
    env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    env::remove_var("MAESTRO_SANDBOX_MODE");
    let cwd = TestDir::new("codex-bridge-temp-cwd");
    let first = codex_bridge_temp_dir(cwd.path());
    let second = codex_bridge_temp_dir(cwd.path());
    if let Some(previous) = previous_bridge {
        env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    }
    if let Some(previous) = previous_sandbox {
        env::set_var("MAESTRO_SANDBOX_MODE", previous);
    } else {
        env::remove_var("MAESTRO_SANDBOX_MODE");
    }

    assert_ne!(first, second);
    assert!(first
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("maestro-codex-bridge-")));
}

#[test]
fn codex_bridge_temp_dir_uses_workspace_for_docker_sandbox() {
    let _guard = ENV_LOCK.blocking_lock();
    let cwd = TestDir::new("codex-bridge-docker-cwd");
    let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
    env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", "docker");
    env::remove_var("MAESTRO_SANDBOX_MODE");

    let temp_dir = codex_bridge_temp_dir(cwd.path());

    if let Some(previous) = previous_bridge {
        env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    }
    if let Some(previous) = previous_sandbox {
        env::set_var("MAESTRO_SANDBOX_MODE", previous);
    } else {
        env::remove_var("MAESTRO_SANDBOX_MODE");
    }

    assert!(temp_dir.starts_with(cwd.path()));
    assert!(temp_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".maestro-codex-bridge-")));
}

#[test]
fn codex_headless_pending_request_ids_include_run_id() {
    let first = codex_headless_pending_request_id(Some("session-1"), "run-a", "approval-1");
    let second = codex_headless_pending_request_id(Some("session-1"), "run-b", "approval-1");

    assert_eq!(first, "codex:session-1:run-a:approval-1");
    assert_eq!(second, "codex:session-1:run-b:approval-1");
    assert_ne!(first, second);
}

#[test]
fn codex_app_server_approval_mode_preserves_prompt() {
    assert_eq!(codex_app_server_approval_mode("auto"), "auto");
    assert_eq!(codex_app_server_approval_mode("prompt"), "prompt");
    assert_eq!(codex_app_server_approval_mode("fail"), "fail");
    assert_eq!(codex_app_server_approval_mode(""), "prompt");
}

#[test]
fn codex_app_server_cli_path_resolves_from_package_root_not_workspace() {
    let package = TestDir::new("codex-package-root");
    let workspace = TestDir::new("codex-workspace");
    let package_bin = package.path().join("bin");
    let package_dist = package.path().join("dist");
    let workspace_dist = workspace.path().join("dist");
    fs::create_dir_all(&package_bin).expect("package bin should be created");
    fs::create_dir_all(&package_dist).expect("package dist should be created");
    fs::create_dir_all(&workspace_dist).expect("workspace dist should be created");
    fs::write(package.path().join("package.json"), "{}").expect("package json should exist");
    fs::write(package_dist.join("cli.js"), "").expect("package cli should exist");
    fs::write(workspace_dist.join("cli.js"), "").expect("workspace cli should exist");

    let resolved = codex_app_server_cli_path_from_start_dir(&package_bin);

    assert_eq!(resolved, package_dist.join("cli.js"));
    assert_ne!(resolved, workspace_dist.join("cli.js"));
}

#[test]
fn codex_app_server_cli_path_missing_cli_still_points_at_package_root() {
    let package = TestDir::new("codex-package-root-missing-cli");
    let package_bin = package.path().join("bin");
    fs::create_dir_all(&package_bin).expect("package bin should be created");
    fs::write(package.path().join("package.json"), "{}").expect("package json should exist");

    let resolved = codex_app_server_cli_path_from_start_dir(&package_bin);

    assert_eq!(resolved, package.path().join("dist/cli.js"));
}

#[tokio::test]
async fn codex_app_server_cli_isolates_child_usage_file() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-isolated-usage");
    let cli_path = root.path().join("cli.js");
    let marker_path = root.path().join("child-usage-file.txt");
    let server_usage_path = root.path().join("server-usage.json");
    fs::write(
            &cli_path,
            r#"const fs = require("fs");
fs.writeFileSync(process.env.MAESTRO_USAGE_MARKER, process.env.MAESTRO_USAGE_FILE || "");
console.log(JSON.stringify({ type: "turn", phase: "start", role: "assistant" }));
console.log(JSON.stringify({ type: "item", subtype: "message_complete", data: { text: "ok", stopReason: "stop" } }));
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_usage_file = env::var_os("MAESTRO_USAGE_FILE");
    let previous_marker = env::var_os("MAESTRO_USAGE_MARKER");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_USAGE_FILE", &server_usage_path);
    env::set_var("MAESTRO_USAGE_MARKER", &marker_path);

    let output = run_codex_app_server_cli(root.path(), "gpt-5.5", "fail", "hello", &[])
        .await
        .expect("fixture should emit assistant output");
    let child_usage_file =
        fs::read_to_string(&marker_path).expect("child should record usage file path");

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_usage_file {
        env::set_var("MAESTRO_USAGE_FILE", previous);
    } else {
        env::remove_var("MAESTRO_USAGE_FILE");
    }
    if let Some(previous) = previous_marker {
        env::set_var("MAESTRO_USAGE_MARKER", previous);
    } else {
        env::remove_var("MAESTRO_USAGE_MARKER");
    }

    assert_eq!(output.text, "ok");
    assert_ne!(PathBuf::from(child_usage_file.trim()), server_usage_path);
    assert!(child_usage_file.trim().ends_with("usage.json"));
}

#[tokio::test]
async fn codex_headless_bridge_round_trips_prompt_approval() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-approval");
    let cli_path = root.path().join("cli.js");
    let marker_path = root.path().join("approval-response.json");
    fs::write(
            &cli_path,
            r#"const fs = require("fs");
const readline = require("readline");
const marker = process.env.MAESTRO_APPROVAL_RESPONSE_MARKER;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "server_request",
      request_id: "approval-1",
      request_type: "approval",
      call_id: "approval-1",
      tool: "write",
      args: { path: "file.txt" },
      reason: "Need approval"
    });
  } else if (msg.type === "server_request_response") {
    fs.writeFileSync(marker, JSON.stringify(msg));
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "approved output", is_thinking: false });
    send({
      type: "response_end",
      response_id: "response-1",
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_tokens: 1,
        cache_write_tokens: 0,
        total_tokens: 8,
        total_cost_usd: 0.01,
        model_id: "gpt-5.5",
        provider: "openai-codex"
      },
      tools_summary: { tools_used: ["write"], calls_succeeded: 1, calls_failed: 0 },
      duration_ms: 1
    });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_marker = env::var_os("MAESTRO_APPROVAL_RESPONSE_MARKER");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_APPROVAL_RESPONSE_MARKER", &marker_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

    let state = test_app_state_with_sessions(HashMap::new());
    let (_client, server) = tcp_stream_pair().await;
    let cwd = root.path().to_path_buf();
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        let mut server = server;
        run_codex_app_server_headless_cli(
            &mut server,
            CodexBridgeTransport::Sse,
            &state_for_run,
            Some("session-1"),
            &cwd,
            "gpt-5.5",
            "hello",
            &[],
        )
        .await
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    let (external_request_id, sender) = loop {
        let mut pending = state.pending_tool_responses.lock().await;
        let pending_id = pending
            .keys()
            .find(|id| id.starts_with("codex:session-1:") && id.ends_with(":approval-1"))
            .cloned();
        if let Some(pending_id) = pending_id {
            let sender = pending
                .remove(&pending_id)
                .expect("pending approval sender should exist");
            break (pending_id, sender);
        }
        drop(pending);
        assert!(
            Instant::now() < deadline,
            "headless approval request should be registered"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    sender
        .send((external_request_id, true, None))
        .expect("approval response should send");
    let result = run.await.expect("headless run should join");

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_marker {
        env::set_var("MAESTRO_APPROVAL_RESPONSE_MARKER", previous);
    } else {
        env::remove_var("MAESTRO_APPROVAL_RESPONSE_MARKER");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }

    let output = result.expect("headless bridge should complete");
    let approval_response: Value = serde_json::from_str(
        &fs::read_to_string(&marker_path).expect("approval response should be recorded"),
    )
    .expect("approval response should be json");

    assert_eq!(output.text, "approved output");
    assert_eq!(output.usage.expect("usage").input_tokens, 5);
    assert_eq!(approval_response["type"], "server_request_response");
    assert_eq!(approval_response["request_id"], "approval-1");
    assert_eq!(approval_response["approved"], true);
}

#[tokio::test]
async fn codex_headless_bridge_streams_tool_events_over_websocket() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-ws-tools");
    let cli_path = root.path().join("cli.js");
    fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "tool_call",
      call_id: "collab-call-ws",
      tool: "codex.subagent.spawnAgent",
      args: {
        codexTool: "spawnAgent",
        receiverThreadIds: ["child-thread-ws"],
        prompt: "Inspect the websocket bridge"
      }
    });
    send({
      type: "tool_end",
      call_id: "collab-call-ws",
      success: true
    });
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "websocket output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

    let state = test_app_state_with_sessions(HashMap::new());
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        let mut server = server;
        handle_codex_app_server_chat_transport(
            &mut server,
            &state_for_run,
            Some("session-ws"),
            "gpt-5.5",
            "hello",
            &[],
            CodexBridgeTransport::WebSocket,
        )
        .await
    });
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
        .await
        .expect("WebSocket stream should close")
        .expect("WebSocket frames should be readable");
    let result = run.await.expect("headless websocket run should join");

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }

    result.expect("headless WebSocket bridge should complete");
    let events = server_websocket_json_values(&bytes);
    assert!(events.iter().any(|event| event["type"] == "agent_start"));
    let start = events
        .iter()
        .find(|event| event["type"] == "tool_execution_start")
        .expect("tool start should stream over WebSocket");
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .expect("tool end should stream over WebSocket");
    assert_eq!(start["toolCallId"], "collab-call-ws");
    assert_eq!(start["toolName"], "codex.subagent.spawnAgent");
    assert_eq!(start["args"]["receiverThreadIds"][0], "child-thread-ws");
    assert_eq!(
        start["args"]["childRunIds"][0],
        "codex-thread:child-thread-ws"
    );
    assert_eq!(
        start["args"]["codexWorkGraph"]["childRuns"][0]["childRunId"],
        "codex-thread:child-thread-ws"
    );
    assert_eq!(end["toolCallId"], "collab-call-ws");
    assert_eq!(end["isError"], false);
    assert!(events.iter().any(|event| {
        event["type"] == "message_update" && event["message"]["content"] == "websocket output"
    }));
    assert!(events.iter().any(|event| event["type"] == "done"));
}

#[tokio::test]
async fn codex_headless_approval_wait_does_not_consume_request_timeout() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-approval-timeout");
    let cli_path = root.path().join("cli.js");
    fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "server_request",
      request_id: "approval-wait",
      request_type: "approval",
      call_id: "approval-wait",
      tool: "write",
      args: { path: "file.txt" },
      reason: "Need approval"
    });
  } else if (msg.type === "server_request_response") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "waited output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "500");

    let state = test_app_state_with_sessions(HashMap::new());
    let (_client, server) = tcp_stream_pair().await;
    let cwd = root.path().to_path_buf();
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        let mut server = server;
        run_codex_app_server_headless_cli(
            &mut server,
            CodexBridgeTransport::Sse,
            &state_for_run,
            Some("session-wait"),
            &cwd,
            "gpt-5.5",
            "hello",
            &[],
        )
        .await
    });

    let expected_prefix = "codex:session-wait:";
    let expected_suffix = ":approval-wait";
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if state
            .pending_tool_responses
            .lock()
            .await
            .keys()
            .any(|id| id.starts_with(expected_prefix) && id.ends_with(expected_suffix))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "headless approval request should be registered"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    tokio::time::sleep(Duration::from_millis(650)).await;
    let mut pending = state.pending_tool_responses.lock().await;
    let external_request_id = pending
        .keys()
        .find(|id| id.starts_with(expected_prefix) && id.ends_with(expected_suffix))
        .cloned()
        .expect("approval wait should remain pending after request timeout window");
    let sender = pending
        .remove(&external_request_id)
        .expect("approval wait should have a pending sender");
    drop(pending);
    sender
        .send((external_request_id, true, None))
        .expect("approval response should send");
    let result = run.await.expect("headless run should join");

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }

    assert_eq!(
        result
            .expect("manual approval wait should not time out")
            .text,
        "waited output"
    );
}

#[tokio::test]
async fn codex_headless_bridge_keeps_valid_output_after_nonzero_shutdown() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-nonzero-shutdown");
    let cli_path = root.path().join("cli.js");
    fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "kept output", is_thinking: false });
    send({
      type: "response_end",
      response_id: "response-1",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 2,
        total_cost_usd: 0.01,
        model_id: "gpt-5.5",
        provider: "openai-codex"
      },
      tools_summary: { tools_used: [], calls_succeeded: 0, calls_failed: 0 },
      duration_ms: 1
    });
  } else if (msg.type === "shutdown") {
    process.exit(7);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

    let state = test_app_state_with_sessions(HashMap::new());
    let (_client, mut server) = tcp_stream_pair().await;
    let output = run_codex_app_server_headless_cli(
        &mut server,
        CodexBridgeTransport::Sse,
        &state,
        None,
        root.path(),
        "gpt-5.5",
        "hello",
        &[],
    )
    .await;

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }

    assert_eq!(
        output.expect("valid protocol output should win").text,
        "kept output"
    );
}

#[tokio::test]
async fn codex_headless_bridge_keeps_valid_output_after_broken_pipe_shutdown() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-broken-pipe-shutdown");
    let cli_path = root.path().join("cli.js");
    fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "kept after broken pipe", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 10);
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

    let state = test_app_state_with_sessions(HashMap::new());
    let (_client, mut server) = tcp_stream_pair().await;
    let output = run_codex_app_server_headless_cli(
        &mut server,
        CodexBridgeTransport::Sse,
        &state,
        None,
        root.path(),
        "gpt-5.5",
        "hello",
        &[],
    )
    .await;

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }

    assert_eq!(
        output
            .expect("valid output should survive a broken shutdown pipe")
            .text,
        "kept after broken pipe"
    );
}

#[tokio::test]
async fn codex_headless_bridge_bounds_shutdown_wait_after_valid_output() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-headless-hung-shutdown");
    let cli_path = root.path().join("cli.js");
    fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "bounded output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    setInterval(() => {}, 1000);
  }
});
"#,
        )
        .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    let previous_shutdown_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");
    env::set_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS", "50");

    let state = test_app_state_with_sessions(HashMap::new());
    let (_client, mut server) = tcp_stream_pair().await;
    let started = Instant::now();
    let output = run_codex_app_server_headless_cli(
        &mut server,
        CodexBridgeTransport::Sse,
        &state,
        None,
        root.path(),
        "gpt-5.5",
        "hello",
        &[],
    )
    .await;

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }
    if let Some(previous) = previous_shutdown_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS");
    }

    assert_eq!(
        output
            .expect("valid output should survive a hung shutdown")
            .text,
        "bounded output"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "hung shutdown should be bounded"
    );
}

#[tokio::test]
async fn codex_app_server_timeout_kills_child_process() {
    let _guard = ENV_LOCK.lock().await;
    let root = TestDir::new("codex-timeout");
    let cli_path = root.path().join("cli.js");
    let marker_path = root.path().join("still-running.txt");
    fs::write(
        &cli_path,
        r#"const fs = require("fs");
setTimeout(() => {
  fs.writeFileSync(process.env.MAESTRO_TIMEOUT_MARKER, "still running");
}, 150);
"#,
    )
    .expect("cli fixture should be written");
    let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
    let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    let previous_marker = env::var_os("MAESTRO_TIMEOUT_MARKER");
    env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
    env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "50");
    env::set_var("MAESTRO_TIMEOUT_MARKER", &marker_path);

    let result = run_codex_app_server_cli(root.path(), "gpt-5.5", "fail", "hello", &[]).await;

    tokio::time::sleep(Duration::from_millis(250)).await;
    let marker_exists = marker_path.exists();

    if let Some(previous) = previous_cli {
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
    }
    if let Some(previous) = previous_timeout {
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
    }
    if let Some(previous) = previous_marker {
        env::set_var("MAESTRO_TIMEOUT_MARKER", previous);
    } else {
        env::remove_var("MAESTRO_TIMEOUT_MARKER");
    }

    assert!(matches!(
        result,
        Err(ref error) if error == "Codex app-server request timed out"
    ));
    assert!(
        !marker_exists,
        "timed out child process should be terminated before it can keep running"
    );
}

fn auth_test_config() -> Config {
    Config {
        listen_host: "127.0.0.1".to_string(),
        listen_port: 0,
        api_key: Some("api-key".to_string()),
        require_key: true,
        csrf_token: None,
        require_csrf: false,
        cwd: PathBuf::from("."),
        session_store_path: PathBuf::from("sessions.json"),
        command_prefs_path: PathBuf::from("command-prefs.json"),
        usage_file_path: PathBuf::from("usage.jsonl"),
        a2a_tasks_file_path: unique_test_dir("maestro-a2a-tasks").join("tasks.json"),
        static_root: PathBuf::from("dist"),
        static_cache_max_age: 0,
        llm_gateway_models_url: None,
        llm_gateway_token: None,
        llm_gateway_org_id: None,
        llm_gateway_timeout_ms: 2_500,
    }
}

fn bearer_head(token: &str) -> RequestHead {
    RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([("authorization".to_string(), format!("Bearer {token}"))]),
    }
}

fn shared_secret_bearer_token(secret: &[u8], user_id: &str) -> String {
    let signature = hmac_sha256_hex(secret, user_id.as_bytes());
    format!("{}.{}", URL_SAFE_NO_PAD.encode(user_id), signature)
}

fn csrf_head(method: &str, token: Option<&str>) -> RequestHead {
    csrf_head_for_path(method, "/api/status", token)
}

fn csrf_head_for_path(method: &str, path: &str, token: Option<&str>) -> RequestHead {
    let mut headers = HashMap::new();
    if let Some(token) = token {
        headers.insert("x-maestro-csrf".to_string(), token.to_string());
    }
    RequestHead {
        method: method.to_string(),
        path: path.to_string(),
        query: HashMap::new(),
        headers,
    }
}

fn test_session_record(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        owner: None,
        title: "Test Session".to_string(),
        created_at: "2026-04-27T00:00:00Z".to_string(),
        updated_at: "2026-04-27T00:00:00Z".to_string(),
        message_count: 0,
        favorite: None,
        tags: Vec::new(),
        messages: Vec::new(),
    }
}

fn test_app_state_with_sessions(sessions: HashMap<String, SessionRecord>) -> AppState {
    let config = Arc::new(auth_test_config());
    let (a2a_task_events, _) = broadcast::channel(256);
    AppState {
        config: config.clone(),
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(emergency_default_model())),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
        framework_preference: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(CommandPrefs::default())),
        sessions: Arc::new(Mutex::new(SessionStore {
            sessions,
            shared_sessions: HashMap::new(),
        })),
        session_store_persist_enabled: true,
        session_persist_lock: Arc::new(Mutex::new(())),
        usage_persist_lock: Arc::new(Mutex::new(())),
        shared_sessions: Arc::new(Mutex::new(HashMap::new())),
        approval_modes: Arc::new(Mutex::new(HashMap::new())),
        pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
        a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
        a2a_task_persist_lock: Arc::new(Mutex::new(())),
        a2a_task_events,
        a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
        a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
    }
}

fn unique_test_dir(prefix: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    env::temp_dir().join(format!("{prefix}-{}-{now}", process::id()))
}

async fn tcp_stream_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener should bind");
    let addr = listener
        .local_addr()
        .expect("listener should have local addr");
    let connect = TcpStream::connect(addr);
    let accept = listener.accept();
    let (client, accepted) = tokio::join!(connect, accept);
    let client = client.expect("client should connect");
    let (server, _) = accepted.expect("listener should accept");
    (client, server)
}

fn response_json(response: Vec<u8>) -> Value {
    let body = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| &response[index + 4..])
        .expect("response should contain header separator");
    serde_json::from_slice(body).expect("response body should be json")
}

fn response_status(response: &[u8]) -> u16 {
    let text = std::str::from_utf8(response).expect("response should be utf-8");
    let status = text
        .lines()
        .next()
        .expect("response should include status line")
        .split_whitespace()
        .nth(1)
        .expect("status line should include code");
    status.parse().expect("status code should parse")
}

fn response_body_text(response: &str) -> &str {
    let separator = response
        .find("\r\n\r\n")
        .expect("response should contain header separator");
    &response[separator + 4..]
}

fn server_websocket_json_values(bytes: &[u8]) -> Vec<Value> {
    let mut values = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        assert!(bytes.len() >= cursor + 2, "incomplete WebSocket frame");
        let opcode = bytes[cursor] & 0x0f;
        if opcode == 0x8 {
            break;
        }
        assert_eq!(opcode, 0x1, "expected text WebSocket frame");
        assert_eq!(
            bytes[cursor + 1] & 0x80,
            0,
            "server WebSocket frames should not be masked"
        );
        let mut offset = cursor + 2;
        let mut len = (bytes[cursor + 1] & 0x7f) as usize;
        if len == 126 {
            assert!(bytes.len() >= offset + 2, "incomplete extended length");
            len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
            offset += 2;
        } else if len == 127 {
            assert!(bytes.len() >= offset + 8, "incomplete extended length");
            len = u64::from_be_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]) as usize;
            offset += 8;
        }
        assert!(bytes.len() >= offset + len, "incomplete WebSocket payload");
        values.push(
            serde_json::from_slice(&bytes[offset..offset + len])
                .expect("WebSocket payload should be JSON"),
        );
        cursor = offset + len;
    }
    values
}

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "maestro-control-plane-{label}-{}-{}",
            process::id(),
            ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("test dir should be created");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn parses_request_path_without_query() {
    let request =
        b"GET /api/status?action=mark-onboarding-seen HTTP/1.1\r\nHost: localhost\r\n\r\n";
    let head = parse_request_head(request).expect("request should parse");

    assert_eq!(head.method, "GET");
    assert_eq!(head.path, "/api/status");
    assert_eq!(
        head.query.get("action"),
        Some(&"mark-onboarding-seen".to_string())
    );
    assert_eq!(head.headers.get("host"), Some(&"localhost".to_string()));
}

#[test]
fn parses_percent_encoded_query_components() {
    let request =
            b"GET /api/artifact-access?filename=logs%2Ftoday%20one.txt&action=mark+done HTTP/1.1\r\nHost: localhost\r\n\r\n";
    let head = parse_request_head(request).expect("request should parse");

    assert_eq!(
        head.query.get("filename"),
        Some(&"logs/today one.txt".to_string())
    );
    assert_eq!(head.query.get("action"), Some(&"mark done".to_string()));
}

#[test]
fn combines_duplicate_headers_in_parse_request_head() {
    let request = b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 10.0.0.1\r\nx-forwarded-for: 10.0.0.2\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n";
    let head = parse_request_head(request).expect("request should parse");

    assert_eq!(
        head.headers.get("x-forwarded-for"),
        Some(&"10.0.0.1, 10.0.0.2".to_string())
    );
    assert_eq!(head.headers.get("cookie"), Some(&"a=1, b=2".to_string()));
}

#[test]
fn query_flag_treats_present_valueless_param_as_true() {
    let head = parse_request_head(
        b"GET /artifact?download&standalone=0 HTTP/1.1\r\nHost: localhost\r\n\r\n",
    )
    .expect("request should parse");

    assert!(query_flag(&head, "download"));
    assert!(!query_flag(&head, "standalone"));
    assert!(!query_flag(&head, "missing"));
}

#[test]
fn authorizes_shared_secret_bearer_token() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
    env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");

    let user_id = "user-123";
    let signature = hmac_sha256_hex(b"shared-secret", user_id.as_bytes());
    let token = format!("{}.{}", URL_SAFE_NO_PAD.encode(user_id), signature);

    assert!(authorize(&bearer_head(&token), &auth_test_config()).is_ok());
    assert_eq!(
        auth_context(&bearer_head(&token), &auth_test_config()).and_then(|auth| auth.subject),
        Some("user-123".to_string())
    );
    assert!(authorize(&bearer_head("bad-token"), &auth_test_config()).is_err());

    if let Some(previous) = previous {
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous);
    } else {
        env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
    }
}

#[test]
fn csrf_validation_requires_matching_token_for_mutating_api_and_a2a_requests() {
    let mut config = auth_test_config();
    config.require_csrf = true;
    config.csrf_token = Some("csrf-token".to_string());

    assert!(validate_csrf(&csrf_head("POST", Some("csrf-token")), &config).is_ok());
    assert!(validate_csrf(&csrf_head("POST", Some("wrong-token")), &config).is_err());
    assert!(validate_csrf(&csrf_head("POST", None), &config).is_err());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/message:send", Some("csrf-token")),
        &config,
    )
    .is_ok());
    assert!(validate_csrf(&csrf_head_for_path("POST", "/message:send", None), &config).is_err());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/message:stream", Some("csrf-token")),
        &config,
    )
    .is_ok());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/message:stream", None),
        &config
    )
    .is_err());
    assert!(validate_csrf(
        &csrf_head_for_path(
            "POST",
            "/tasks/maestro-task-1:subscribe",
            Some("csrf-token")
        ),
        &config,
    )
    .is_ok());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/tasks/maestro-task-1:subscribe", None),
        &config
    )
    .is_err());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/tasks/maestro-task-1:cancel", Some("csrf-token")),
        &config,
    )
    .is_ok());
    assert!(validate_csrf(
        &csrf_head_for_path("POST", "/tasks/maestro-task-1:cancel", None),
        &config
    )
    .is_err());
    assert!(validate_csrf(&csrf_head("GET", None), &config).is_ok());
}

#[test]
fn authorizes_hs256_jwt_bearer_token() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_secret = env::var_os("MAESTRO_JWT_SECRET");
    let previous_alg = env::var_os("MAESTRO_JWT_ALG");
    let previous_aud = env::var_os("MAESTRO_JWT_AUD");
    let previous_iss = env::var_os("MAESTRO_JWT_ISS");
    env::set_var("MAESTRO_JWT_SECRET", "jwt-secret");
    env::remove_var("MAESTRO_JWT_ALG");
    env::remove_var("MAESTRO_JWT_AUD");
    env::remove_var("MAESTRO_JWT_ISS");

    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
        .saturating_add(60);
    let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"user-123","exp":{expires_at}}}"#));
    let signing_input = format!("{header}.{payload}");
    let signature = hmac_sha256_base64url(b"jwt-secret", signing_input.as_bytes());
    let token = format!("{signing_input}.{signature}");

    assert!(authorize(&bearer_head(&token), &auth_test_config()).is_ok());
    assert_eq!(
        auth_context(&bearer_head(&token), &auth_test_config()).and_then(|auth| auth.subject),
        Some("user-123".to_string())
    );

    if let Some(previous) = previous_secret {
        env::set_var("MAESTRO_JWT_SECRET", previous);
    } else {
        env::remove_var("MAESTRO_JWT_SECRET");
    }
    if let Some(previous) = previous_alg {
        env::set_var("MAESTRO_JWT_ALG", previous);
    }
    if let Some(previous) = previous_aud {
        env::set_var("MAESTRO_JWT_AUD", previous);
    }
    if let Some(previous) = previous_iss {
        env::set_var("MAESTRO_JWT_ISS", previous);
    }
}

#[tokio::test]
async fn jwks_auth_check_does_not_panic_inside_tokio_runtime() {
    let _guard = ENV_LOCK.lock().await;
    let previous_url = env::var_os("MAESTRO_JWT_JWKS_URL");
    let previous_alg = env::var_os("MAESTRO_JWT_ALG");
    let previous_secret = env::var_os("MAESTRO_JWT_SECRET");
    env::set_var("MAESTRO_JWT_JWKS_URL", "http://127.0.0.1:1/jwks.json");
    env::set_var("MAESTRO_JWT_ALG", "RS256");
    env::remove_var("MAESTRO_JWT_SECRET");

    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"user-123","exp":4102444800}"#);
    let token = format!("{header}.{payload}.signature");

    let result = std::panic::catch_unwind(|| authorize(&bearer_head(&token), &auth_test_config()));
    assert!(
        result.is_ok(),
        "authorize should not panic inside a Tokio runtime"
    );
    assert!(result.expect("authorize should return a result").is_err());

    if let Some(previous) = previous_url {
        env::set_var("MAESTRO_JWT_JWKS_URL", previous);
    } else {
        env::remove_var("MAESTRO_JWT_JWKS_URL");
    }
    if let Some(previous) = previous_alg {
        env::set_var("MAESTRO_JWT_ALG", previous);
    } else {
        env::remove_var("MAESTRO_JWT_ALG");
    }
    if let Some(previous) = previous_secret {
        env::set_var("MAESTRO_JWT_SECRET", previous);
    } else {
        env::remove_var("MAESTRO_JWT_SECRET");
    }
}

#[test]
fn detects_local_control_plane_routes() {
    let request = b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n";
    let head = parse_request_head(request).expect("request should parse");

    assert!(is_local_endpoint(&head));
}

#[test]
fn detects_a2a_control_plane_routes() {
    for request in [
            "GET /.well-known/agent-card.json HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /extendedAgentCard HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /tasks/maestro-task-1/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "DELETE /tasks/maestro-task-1/pushNotificationConfigs/config-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "OPTIONS /message:send HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_a2a_endpoint(&head), "{request} should be A2A");
        }
}

#[test]
fn detects_a2a_streaming_routes_separately() {
    for request in [
        "POST /message:stream HTTP/1.1\r\nHost: localhost\r\n\r\n",
        "GET /tasks/maestro-task-1:subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
        "POST /tasks/maestro-task-1:subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
        "GET /tasks/maestro-task-1/subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
    ] {
        let head = parse_request_head(request.as_bytes()).expect("request should parse");
        assert!(
            is_a2a_streaming_endpoint(&head),
            "{request} should be streaming A2A"
        );
        assert!(
            !is_a2a_endpoint(&head),
            "{request} should not be handled by non-streaming A2A routing"
        );
    }
}

#[test]
fn detects_platform_a2a_push_callback_route() {
    let head =
        parse_request_head(b"POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("request should parse");

    assert!(is_platform_a2a_push_endpoint(&head));
    assert!(!is_a2a_endpoint(&head));
}

#[test]
fn a2a_agent_card_advertises_http_json_interface() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
    let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
    let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
    let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
    env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\nx-forwarded-proto: https\r\n\r\n",
        )
        .expect("request should parse");
    let card = a2a_agent_card(&head, &auth_test_config());

    assert_eq!(card["protocolVersion"], A2A_PROTOCOL_VERSION);
    assert_eq!(card["url"], "http://127.0.0.1:0");
    assert_eq!(card["supportedInterfaces"][0]["url"], "http://127.0.0.1:0");
    assert_eq!(
        card["supportedInterfaces"][0]["protocolBinding"],
        "HTTP+JSON"
    );
    assert_eq!(card["capabilities"]["streaming"], true);
    assert_eq!(card["capabilities"]["pushNotifications"], true);
    assert_eq!(card["capabilities"]["extendedAgentCard"], true);
    assert_eq!(
        card["capabilities"]["extensions"][0]["uri"],
        EVALOPS_A2A_EXTENSION_URI
    );
    assert_eq!(
        card["securitySchemes"]["maestroApiKey"]["name"],
        "x-maestro-api-key"
    );
    assert_eq!(card["skills"][0]["id"], "maestro-tui-turn");
    let skill_ids = card["skills"]
        .as_array()
        .expect("skills should be an array")
        .iter()
        .filter_map(|skill| skill.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(skill_ids.contains(&"maestro.subagent.code-review"));
    assert!(skill_ids.contains(&"maestro.subagent.test-runner"));
    assert!(skill_ids.contains(&"maestro.subagent.repo-explorer"));
    let code_review_skill = card["skills"]
        .as_array()
        .expect("skills should be an array")
        .iter()
        .find(|skill| skill["id"] == "maestro.subagent.code-review")
        .expect("code review subagent skill should be advertised");
    assert_eq!(
        code_review_skill["metadata"]["requestMetadataPath"],
        "evalops.subagentRequest"
    );
    assert_eq!(
        code_review_skill["attributes"]["subagentLaneId"],
        "code-review"
    );
    assert_eq!(
        code_review_skill["attributes"]["requestMetadataPath"],
        "evalops.subagentRequest"
    );
    assert_eq!(
        code_review_skill["requiredContextGrants"],
        serde_json::json!(["repo:read", "pull-request:read", "evidence:read"])
    );
    assert_eq!(
        code_review_skill["approvalPolicyRef"],
        "maestro.subagent.code-review.target-policy"
    );
    assert_eq!(code_review_skill["maxAutonomy"], "bounded");
    assert_eq!(
        code_review_skill["requiredArtifactKinds"],
        serde_json::json!(["review.summary"])
    );
    assert_eq!(
        code_review_skill["allowedTaskClasses"],
        serde_json::json!(["code.review", "risk.analysis"])
    );
    assert_eq!(
        code_review_skill["deniedTaskClasses"],
        serde_json::json!([
            "credential.materialization",
            "secret.exfiltration",
            "unbounded.repository.write"
        ])
    );
    if let Some(previous_a2a_url) = previous_a2a_url {
        env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    }
    if let Some(previous_a2a_host) = previous_a2a_host {
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    }
    if let Some(previous_control_url) = previous_control_url {
        env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    }
    if let Some(previous_control_host) = previous_control_host {
        env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    }
}

#[test]
fn a2a_agent_card_uses_configured_public_host_for_wildcard_binds() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
    let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
    let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
    env::set_var("MAESTRO_A2A_PUBLIC_HOST", "mini.example.test");
    env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    let mut config = auth_test_config();
    config.listen_host = "0.0.0.0".to_string();
    config.listen_port = 18787;
    let head = parse_request_head(
        b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
    )
    .expect("request should parse");
    let card = a2a_agent_card(&head, &config);

    assert_eq!(card["url"], "http://mini.example.test:18787");
    assert_eq!(
        card["supportedInterfaces"][0]["url"],
        "http://mini.example.test:18787"
    );

    if let Some(previous_a2a_host) = previous_a2a_host {
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    }
    if let Some(previous_a2a_url) = previous_a2a_url {
        env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    }
    if let Some(previous_control_url) = previous_control_url {
        env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    }
}

#[test]
fn a2a_agent_card_formats_ipv6_listen_hosts() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_hostname = env::var_os("HOSTNAME");
    let previous_computername = env::var_os("COMPUTERNAME");
    let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
    let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
    let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
    let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
    env::remove_var("HOSTNAME");
    env::remove_var("COMPUTERNAME");
    env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    let mut config = auth_test_config();
    config.listen_host = "::1".to_string();
    config.listen_port = 18787;
    let head = parse_request_head(
        b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
    )
    .expect("request should parse");
    let card = a2a_agent_card(&head, &config);

    assert_eq!(card["url"], "http://[::1]:18787");
    assert_eq!(card["supportedInterfaces"][0]["url"], "http://[::1]:18787");

    if let Some(previous_hostname) = previous_hostname {
        env::set_var("HOSTNAME", previous_hostname);
    } else {
        env::remove_var("HOSTNAME");
    }
    if let Some(previous_computername) = previous_computername {
        env::set_var("COMPUTERNAME", previous_computername);
    } else {
        env::remove_var("COMPUTERNAME");
    }
    if let Some(previous_a2a_url) = previous_a2a_url {
        env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    }
    if let Some(previous_a2a_host) = previous_a2a_host {
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    }
    if let Some(previous_control_url) = previous_control_url {
        env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    }
    if let Some(previous_control_host) = previous_control_host {
        env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    }
}

#[test]
fn a2a_agent_card_formats_configured_ipv6_public_host() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
    let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
    let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
    let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
    env::set_var("MAESTRO_A2A_PUBLIC_HOST", "::1");
    env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    let mut config = auth_test_config();
    config.listen_host = "0.0.0.0".to_string();
    config.listen_port = 18787;
    let head = parse_request_head(
        b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
    )
    .expect("request should parse");
    let card = a2a_agent_card(&head, &config);

    assert_eq!(card["url"], "http://[::1]:18787");
    assert_eq!(card["supportedInterfaces"][0]["url"], "http://[::1]:18787");

    if let Some(previous_a2a_host) = previous_a2a_host {
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    }
    if let Some(previous_a2a_url) = previous_a2a_url {
        env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    }
    if let Some(previous_control_url) = previous_control_url {
        env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    }
    if let Some(previous_control_host) = previous_control_host {
        env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    }
}

#[test]
fn a2a_agent_card_percent_encodes_scoped_ipv6_public_host() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
    let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
    let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
    let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
    env::set_var("MAESTRO_A2A_PUBLIC_HOST", "fe80::1%en0");
    env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    let mut config = auth_test_config();
    config.listen_host = "0.0.0.0".to_string();
    config.listen_port = 18787;
    let head = parse_request_head(
        b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
    )
    .expect("request should parse");
    let card = a2a_agent_card(&head, &config);

    assert_eq!(card["url"], "http://[fe80::1%25en0]:18787");
    assert_eq!(
        card["supportedInterfaces"][0]["url"],
        "http://[fe80::1%25en0]:18787"
    );

    if let Some(previous_a2a_host) = previous_a2a_host {
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
    }
    if let Some(previous_a2a_url) = previous_a2a_url {
        env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
    } else {
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
    }
    if let Some(previous_control_url) = previous_control_url {
        env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
    }
    if let Some(previous_control_host) = previous_control_host {
        env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
    } else {
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
    }
}

#[test]
fn a2a_send_message_honors_return_immediately_configuration() {
    let request = A2ASendMessageRequest {
        message: A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("ctx-1".to_string()),
            task_id: None,
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("hello".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        },
        configuration: Some(serde_json::json!({ "returnImmediately": true })),
        metadata: None,
    };

    assert!(a2a_return_immediately(&request).expect("configuration should be valid"));
}

#[test]
fn a2a_user_message_value_replaces_empty_context_id() {
    let message = A2AMessageBody {
        message_id: Some("msg-1".to_string()),
        context_id: Some("   ".to_string()),
        task_id: None,
        role: Some("ROLE_USER".to_string()),
        parts: vec![A2APartBody {
            text: Some("hello".to_string()),
            url: None,
            data: None,
            metadata: None,
            filename: None,
            media_type: Some("text/plain".to_string()),
        }],
        metadata: None,
        extensions: None,
        reference_task_ids: None,
    };

    let value = a2a_user_message_value(&message, "ctx-1");

    assert_eq!(value["contextId"], "ctx-1");
}

#[test]
fn a2a_context_id_ignores_whitespace_before_falling_back() {
    let request = A2ASendMessageRequest {
        message: A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("   ".to_string()),
            task_id: None,
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("hello".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        },
        configuration: None,
        metadata: None,
    };
    let head = RequestHead {
        method: "POST".to_string(),
        path: "/message:send".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([(
            "x-evalops-session-id".to_string(),
            " header-ctx ".to_string(),
        )]),
    };

    assert_eq!(a2a_context_id(&request, &head), "header-ctx");
}

#[test]
fn a2a_context_id_falls_back_when_message_context_is_blank() {
    let request = A2ASendMessageRequest {
        message: A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("   ".to_string()),
            task_id: None,
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("hello".to_string()),
                url: None,
                data: None,
                metadata: Some(serde_json::json!({ "sessionId": " metadata-ctx " })),
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: Some(serde_json::json!({ "sessionId": " metadata-ctx " })),
            extensions: None,
            reference_task_ids: None,
        },
        configuration: None,
        metadata: None,
    };
    let head = parse_request_head(
            b"POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-evalops-session-id: header-ctx\r\n\r\n",
        )
        .expect("request should parse");

    assert_eq!(a2a_context_id(&request, &head), "metadata-ctx");
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_runs_fake_turn_and_records_task() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello from fake native turn");

    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}],"metadata":{"agentId":"ts-tui"}}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-workspace-id: ws-1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let task = &response["task"];

    assert_eq!(task["contextId"], "ctx-1");
    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(
        task["artifacts"][0]["parts"][0]["text"],
        "hello from fake native turn"
    );
    assert_eq!(task["metadata"]["workspaceId"], "ws-1");
    assert_eq!(state.a2a_tasks.lock().await.len(), 1);

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_records_extensions_and_push_config() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello with push config");
    env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");

    let body = format!(
        r#"{{
                "message": {{
                    "messageId": "msg-push",
                    "contextId": "ctx-push",
                    "role": "ROLE_USER",
                    "extensions": ["{EVALOPS_A2A_EXTENSION_URI}"],
                    "parts": [{{"text": "hello", "mediaType": "text/plain"}}]
                }},
                "configuration": {{
                    "taskPushNotificationConfig": {{
                        "id": "notify-1",
                        "url": "https://hooks.example/a2a",
                        "token": "notify-token",
                        "authentication": {{
                            "schemes": ["Bearer"],
                            "credentials": "auth-token"
                        }}
                    }}
                }}
            }}"#
    );
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nA2A-Extensions: {EVALOPS_A2A_EXTENSION_URI}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let task = &response["task"];

    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(
        task["metadata"]["a2aExtensions"][0],
        EVALOPS_A2A_EXTENSION_URI
    );
    assert_eq!(
        task["metadata"]["pushNotificationConfigs"][0]["taskId"],
        task["id"]
    );
    assert_eq!(
        task["metadata"]["pushNotificationConfigs"][0]["token"],
        "<redacted>"
    );
    let stored_tasks = state.a2a_tasks.lock().await;
    let stored_task = stored_tasks
        .get(task["id"].as_str().expect("task id should be a string"))
        .expect("task should be stored");
    assert_eq!(
        stored_task["metadata"]["pushNotificationConfigs"][0]["token"],
        "notify-token"
    );
    assert!(task["metadata"].get("configuration").is_none());

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
    if let Some(previous_disable_delivery) = previous_disable_delivery {
        env::set_var(
            "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
            previous_disable_delivery,
        );
    } else {
        env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn platform_a2a_push_callback_accepts_status_updates() {
    let _guard = ENV_LOCK.lock().await;
    let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

    let state = test_app_state_with_sessions(HashMap::new());
    let body = r#"{
            "statusUpdate": {
                "taskId": "platform-run-1",
                "contextId": "ctx-platform-1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "message": {
                        "messageId": "status-platform-run-1",
                        "contextId": "ctx-platform-1",
                        "role": "ROLE_AGENT",
                        "parts": [{"text": "Platform run completed", "mediaType": "text/plain"}]
                    },
                    "timestamp": "2026-05-17T00:00:00Z"
                },
                "metadata": {
                    "runtimeEventId": "event-1",
                    "runtimeEventType": "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED"
                }
            }
        }"#;
    let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_server = state.clone();
    let server_task =
        tokio::spawn(async move { handle_connection(server, state_for_server).await });

    client
        .write_all(request.as_bytes())
        .await
        .expect("request should write");
    client.shutdown().await.expect("client should shutdown");
    let mut response = Vec::new();
    client
        .read_to_end(&mut response)
        .await
        .expect("response should read");
    server_task
        .await
        .expect("server task should join")
        .expect("server should handle request");

    assert_eq!(response_status(&response), 202);
    let parsed = response_json(response);
    assert_eq!(parsed["accepted"], true);
    assert_eq!(parsed["taskId"], "platform-run-1");
    let tasks = state.a2a_tasks.lock().await;
    let task = tasks
        .get("platform-run-1")
        .expect("platform task should be recorded");
    assert_eq!(task["contextId"], "ctx-platform-1");
    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(
        task["metadata"]["lastPlatformStatusUpdate"]["runtimeEventType"],
        "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED"
    );

    if let Some(previous_token) = previous_token {
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
    } else {
        env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn platform_a2a_push_callback_rejects_invalid_token() {
    let _guard = ENV_LOCK.lock().await;
    let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

    let body =
        r#"{"statusUpdate":{"taskId":"platform-run-1","status":{"state":"TASK_STATE_WORKING"}}}"#;
    let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: wrong-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response = handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

    assert_eq!(response_status(&response), 401);
    assert!(state.a2a_tasks.lock().await.is_empty());

    if let Some(previous_token) = previous_token {
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
    } else {
        env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn platform_a2a_push_callback_requires_configured_token() {
    let _guard = ENV_LOCK.lock().await;
    let previous_primary = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    let previous_legacy = env::var_os("MAESTRO_A2A_CALLBACK_TOKEN");
    env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    env::remove_var("MAESTRO_A2A_CALLBACK_TOKEN");

    let body =
        r#"{"statusUpdate":{"taskId":"platform-run-1","status":{"state":"TASK_STATE_WORKING"}}}"#;
    let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response = handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

    assert_eq!(response_status(&response), 503);
    let parsed = response_json(response);
    assert_eq!(parsed["error"]["code"], "CALLBACK_TOKEN_NOT_CONFIGURED");
    assert!(state.a2a_tasks.lock().await.is_empty());

    if let Some(previous_primary) = previous_primary {
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_primary);
    } else {
        env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    }
    if let Some(previous_legacy) = previous_legacy {
        env::set_var("MAESTRO_A2A_CALLBACK_TOKEN", previous_legacy);
    } else {
        env::remove_var("MAESTRO_A2A_CALLBACK_TOKEN");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn platform_a2a_push_callback_records_artifact_updates() {
    let _guard = ENV_LOCK.lock().await;
    let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

    let state = test_app_state_with_sessions(HashMap::new());
    let body = r#"{
            "artifactUpdate": {
                "taskId": "platform-run-2",
                "contextId": "ctx-platform-2",
                "artifact": {
                    "artifactId": "artifact-1",
                    "name": "result",
                    "parts": [{"text": "artifact text", "mediaType": "text/plain"}]
                },
                "lastChunk": true
            }
        }"#;
    let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response = handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

    assert_eq!(response_status(&response), 202);
    let tasks = state.a2a_tasks.lock().await;
    let task = tasks
        .get("platform-run-2")
        .expect("platform artifact task should be recorded");
    assert_eq!(task["artifacts"][0]["artifactId"], "artifact-1");
    assert_eq!(task["artifacts"][0]["parts"][0]["text"], "artifact text");

    if let Some(previous_token) = previous_token {
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
    } else {
        env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn platform_a2a_push_callback_preserves_existing_context_without_context_update() {
    let state = test_app_state_with_sessions(HashMap::new());
    state.a2a_tasks.lock().await.insert(
        "platform-run-3".to_string(),
        serde_json::json!({
            "id": "platform-run-3",
            "contextId": "ctx-existing",
            "status": {"state": "TASK_STATE_WORKING"},
            "history": [],
            "artifacts": []
        }),
    );

    let status_update = serde_json::json!({
        "taskId": "platform-run-3",
        "status": {"state": "TASK_STATE_COMPLETED"}
    });
    let task = apply_platform_a2a_status_update(&state, &status_update)
        .await
        .expect("status update should be accepted");
    assert_eq!(task["contextId"], "ctx-existing");

    let artifact_update = serde_json::json!({
        "taskId": "platform-run-3",
        "artifact": {
            "artifactId": "artifact-ctx",
            "parts": [{"text": "keeps context", "mediaType": "text/plain"}]
        }
    });
    let task = apply_platform_a2a_artifact_update(&state, &artifact_update)
        .await
        .expect("artifact update should be accepted");
    assert_eq!(task["contextId"], "ctx-existing");
    assert_eq!(task["artifacts"][0]["artifactId"], "artifact-ctx");
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_unsupported_extensions() {
    let body = r#"{"message":{"messageId":"msg-extension","contextId":"ctx-extension","role":"ROLE_USER","extensions":["https://example.test/a2a/extensions/unsupported/v1"],"parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "EXTENSION_NOT_SUPPORTED");
    assert!(state.a2a_tasks.lock().await.is_empty());
}

#[test]
fn a2a_push_notification_payloads_use_stream_response_shape() {
    let terminal_task = a2a_task_value(
        "task-push-payload",
        "ctx-push-payload",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-push-payload", "done"),
        Vec::new(),
        vec![serde_json::json!({
            "artifactId": "artifact-1",
            "parts": [{ "text": "artifact text", "mediaType": "text/plain" }]
        })],
        serde_json::json!({
            "workspaceId": "ws-1",
            "pushNotificationConfigs": [{
                "id": "notify-1",
                "taskId": "task-push-payload",
                "url": "https://hooks.example/a2a",
                "token": "notify-token",
                "authentication": {
                    "schemes": ["Bearer"],
                    "credentials": "secret"
                }
            }]
        }),
    );

    let payloads = a2a_push_notification_payloads(&terminal_task);

    assert_eq!(payloads.len(), 3);
    assert_eq!(
        payloads[0]["statusUpdate"]["taskId"],
        serde_json::json!("task-push-payload")
    );
    assert_eq!(
        payloads[1]["artifactUpdate"]["artifact"]["artifactId"],
        serde_json::json!("artifact-1")
    );
    assert_eq!(
        payloads[2]["task"]["id"],
        serde_json::json!("task-push-payload")
    );
    assert_eq!(
        payloads[0]["statusUpdate"]["metadata"]["workspaceId"],
        "ws-1"
    );
    assert!(payloads[0]["statusUpdate"]["metadata"]
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .is_none());
    assert!(payloads[1]["artifactUpdate"]["metadata"]
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .is_none());
    assert!(payloads[2]["task"]["metadata"]
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .is_none());

    for payload in payloads {
        let stream_response_fields = ["task", "message", "statusUpdate", "artifactUpdate"]
            .into_iter()
            .filter(|field| payload.get(field).is_some())
            .count();
        assert_eq!(stream_response_fields, 1);
    }
}

#[test]
fn a2a_push_notification_config_rejects_unaddressable_ids() {
    for id in ["bad/id", "bad:id"] {
        let result = normalize_a2a_push_notification_config(
            "task-push",
            serde_json::json!({
                "id": id,
                "taskId": "task-push",
                "url": "https://hooks.example/a2a"
            }),
            true,
        );

        assert!(result.is_err(), "expected {id} to be rejected");
    }
}

#[test]
fn a2a_push_notification_config_generates_distinct_ids_when_missing() {
    let first = normalize_a2a_push_notification_config(
        "task-push",
        serde_json::json!({
            "taskId": "task-push",
            "url": "https://hooks.example/a2a"
        }),
        true,
    )
    .expect("first config should normalize");
    let second = normalize_a2a_push_notification_config(
        "task-push",
        serde_json::json!({
            "taskId": "task-push",
            "url": "https://hooks.example/a2a"
        }),
        true,
    )
    .expect("second config should normalize");

    let first_id = first["id"].as_str().expect("first id should exist");
    let second_id = second["id"].as_str().expect("second id should exist");
    assert_ne!(first_id, "task-push");
    assert_ne!(second_id, "task-push");
    assert_ne!(first_id, second_id);
    assert!(first_id.starts_with("pushcfg-"));
    assert!(second_id.starts_with("pushcfg-"));
}

#[test]
fn a2a_push_private_ip_check_includes_ipv4_mapped_ipv6() {
    let mapped_loopback = "::ffff:127.0.0.1"
        .parse::<IpAddr>()
        .expect("mapped IPv6 parses");

    assert!(a2a_push_ip_is_private(mapped_loopback));
}

#[test]
fn a2a_push_authorization_header_accepts_schemes_list() {
    let authentication = serde_json::json!({
        "schemes": ["Bearer"],
        "credentials": "secret"
    });
    let header = a2a_push_authorization_header(
        authentication
            .as_object()
            .expect("authentication should be an object"),
    );

    assert_eq!(header.as_deref(), Some("Bearer secret"));
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_ignores_push_config_metadata_smuggling() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello without smuggled push");
    env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");

    let body = r#"{
            "message": {
                "messageId": "msg-smuggle",
                "contextId": "ctx-smuggle",
                "role": "ROLE_USER",
                "parts": [{"text": "hello", "mediaType": "text/plain"}],
                "metadata": {
                    "pushNotificationConfigs": [
                        {"id": "msg-smuggled", "url": "https://hooks.example/a2a"}
                    ]
                }
            },
            "metadata": {
                "pushNotificationConfigs": [
                    {"id": "request-smuggled", "url": "https://hooks.example/a2a"}
                ]
            }
        }"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert!(response["task"]["metadata"]
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .is_none());

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
    if let Some(previous_disable_delivery) = previous_disable_delivery {
        env::set_var(
            "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
            previous_disable_delivery,
        );
    } else {
        env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_push_notification_config_crud_updates_task_metadata() {
    let _guard = ENV_LOCK.lock().await;
    let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
    env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "task-push",
        "ctx-push",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-push", "working"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("task-push".to_string(), task);

    let body = r#"{"id":"notify-1","taskId":"task-push","url":"https://hooks.example/a2a","token":"notify-token"}"#;
    let request = format!(
            "POST /tasks/task-push/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let created = response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    assert_eq!(created["id"], "notify-1");
    assert_eq!(created["taskId"], "task-push");
    assert_eq!(created["token"], "<redacted>");
    assert_eq!(
        state.a2a_tasks.lock().await["task-push"]["metadata"]["pushNotificationConfigs"][0]
            ["token"],
        "notify-token"
    );

    let mut initial =
            b"GET /tasks/task-push/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let listed = response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    assert_eq!(listed["configs"][0]["id"], "notify-1");
    assert_eq!(listed["configs"][0]["token"], "<redacted>");

    let mut initial =
            b"GET /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let fetched = response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    assert_eq!(fetched["token"], "<redacted>");

    let mut initial =
            b"DELETE /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let deleted = response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    assert_eq!(deleted, serde_json::json!({}));
    assert!(state.a2a_tasks.lock().await["task-push"]["metadata"]
        .get("pushNotificationConfigs")
        .is_none());

    let mut initial =
            b"DELETE /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let deleted_again =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    assert_eq!(deleted_again, serde_json::json!({}));

    if let Some(previous_disable_delivery) = previous_disable_delivery {
        env::set_var(
            "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
            previous_disable_delivery,
        );
    } else {
        env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_requires_csrf_token_when_enabled() {
    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let base_state = test_app_state_with_sessions(HashMap::new());
    let mut config = auth_test_config();
    config.require_csrf = true;
    config.csrf_token = Some("csrf-token".to_string());
    let state = AppState {
        config: Arc::new(config),
        ..base_state
    };

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"], "Forbidden: invalid CSRF token");
    assert!(state.a2a_tasks.lock().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_non_boolean_return_immediately() {
    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":{"returnImmediately":"true"}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "INVALID_REQUEST");
    assert_eq!(
        response["error"]["message"],
        "A2A configuration returnImmediately must be a boolean"
    );
    assert!(state.a2a_tasks.lock().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_non_object_configuration() {
    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":"oops"}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "INVALID_REQUEST");
    assert_eq!(
        response["error"]["message"],
        "A2A configuration must be an object"
    );
    assert!(state.a2a_tasks.lock().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_incompatible_protocol_version() {
    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send?a2a-version=2.0 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "UNSUPPORTED_VERSION");
    assert_eq!(
        response["error"]["message"],
        "Unsupported A2A protocol version 2.0; expected 1.0"
    );
    assert!(state.a2a_tasks.lock().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_tasks_list_only_returns_tasks_owned_by_subject() {
    let _guard = ENV_LOCK.lock().await;
    let previous_secret = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
    env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
    let state = test_app_state_with_sessions(HashMap::new());
    for (task_id, owner) in [
        ("owned-task", Some("user-123")),
        ("other-task", Some("user-456")),
        ("unowned-task", None),
    ] {
        let mut metadata = Map::new();
        if let Some(owner) = owner {
            metadata.insert("ownerSubject".to_string(), Value::String(owner.to_string()));
        }
        let task = a2a_task_value(
            task_id,
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "done"),
            Vec::new(),
            Vec::new(),
            Value::Object(metadata),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert(task_id.to_string(), task);
    }
    let token = shared_secret_bearer_token(b"shared-secret", "user-123");
    let request =
        format!("GET /tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n");
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let tasks = response["tasks"]
        .as_array()
        .expect("tasks should be an array");

    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], "owned-task");

    if let Some(previous_secret) = previous_secret {
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous_secret);
    } else {
        env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_tasks_list_supports_spec_filters_pagination_and_payload_trimming() {
    let state = test_app_state_with_sessions(HashMap::new());
    for (task_id, context_id, status, timestamp) in [
        (
            "task-a",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            "2026-05-15T00:03:00+00:00",
        ),
        (
            "task-b",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            "2026-05-15T00:02:00Z",
        ),
        (
            "task-c",
            "ctx-2",
            "TASK_STATE_WORKING",
            "2026-05-15T00:01:00Z",
        ),
        (
            "task-d",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            "2026-05-14T19:04:00-05:00",
        ),
    ] {
        let mut task = a2a_task_value(
            task_id,
            context_id,
            status,
            a2a_agent_message(context_id, "done"),
            vec![
                a2a_agent_message(context_id, "first"),
                a2a_agent_message(context_id, "second"),
            ],
            vec![serde_json::json!({
                "artifactId": format!("{task_id}-artifact"),
                "parts": [{ "text": "artifact", "mediaType": "text/plain" }]
            })],
            serde_json::json!({}),
        );
        task["status"]["timestamp"] = Value::String(timestamp.to_string());
        state
            .a2a_tasks
            .lock()
            .await
            .insert(task_id.to_string(), task);
    }
    let request = "GET /tasks?contextId=ctx-1&status=completed&pageSize=1&historyLength=1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let mut initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let tasks = response["tasks"]
        .as_array()
        .expect("tasks should be an array");

    assert_eq!(response["totalSize"], 3);
    assert_eq!(response["pageSize"], 1);
    let next_page_token = response["nextPageToken"]
        .as_str()
        .expect("next page token should be a string");
    assert!(!next_page_token.is_empty());
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], "task-d");
    assert_eq!(tasks[0]["history"].as_array().unwrap().len(), 1);
    assert!(tasks[0].get("artifacts").is_none());

    let mut newer_task = a2a_task_value(
        "task-e",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "newer"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    newer_task["status"]["timestamp"] = Value::String("2026-05-15T00:05:00Z".to_string());
    state
        .a2a_tasks
        .lock()
        .await
        .insert("task-e".to_string(), newer_task);
    let request = format!(
            "GET /tasks?contextId=ctx-1&status=completed&pageSize=1&historyLength=1&pageToken={next_page_token} HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
        );
    let mut initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let tasks = response["tasks"]
        .as_array()
        .expect("tasks should be an array");

    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], "task-a");

    let request = "GET /tasks?statusTimestampAfter=2026-05-15T00:03:00Z HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let mut initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let tasks = response["tasks"]
        .as_array()
        .expect("tasks should be an array");

    assert_eq!(response["totalSize"], 3);
    assert_eq!(tasks[0]["id"], "task-e");
    assert_eq!(tasks[1]["id"], "task-d");
    assert_eq!(tasks[2]["id"], "task-a");
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_tasks_list_rejects_invalid_history_length() {
    let state = test_app_state_with_sessions(HashMap::new());
    let request = "GET /tasks?historyLength=abc HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let mut initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "INVALID_REQUEST");
    assert_eq!(
        response["error"]["message"],
        "A2A query parameter historyLength must be an integer"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_store_persists_control_plane_tasks_to_ledger_file() {
    let root = TestDir::new("a2a-task-ledger");
    let base_state = test_app_state_with_sessions(HashMap::new());
    let mut config = auth_test_config();
    config.a2a_tasks_file_path = root.path().join("tasks.json");
    let state = AppState {
        config: Arc::new(config),
        ..base_state
    };
    tokio::fs::write(
        &state.config.a2a_tasks_file_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "tasks": [
                {
                    "id": "remote-ledger-row",
                    "kind": "message",
                    "peer": "peer-b",
                    "taskId": "remote-task",
                    "text": "remote peer task",
                    "state": "TASK_STATE_COMPLETED",
                    "createdAt": "2026-05-15T00:00:00Z",
                    "updatedAt": "2026-05-15T00:01:00Z"
                },
                {
                    "id": "maestro-control-plane-other-task",
                    "kind": "message",
                    "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
                    "taskId": "other-control-plane-task",
                    "contextId": "ctx-other",
                    "text": "other process request",
                    "responseText": "other process response",
                    "state": "TASK_STATE_COMPLETED",
                    "createdAt": "2026-05-15T00:00:00Z",
                    "updatedAt": "2026-05-15T00:03:00Z",
                    "metadata": { "workspaceId": "other-ws" }
                },
                {
                    "id": "raw-legacy-task",
                    "contextId": "ctx-legacy",
                    "status": {
                        "state": "TASK_STATE_COMPLETED",
                        "message": {
                            "messageId": "legacy-msg",
                            "contextId": "ctx-legacy",
                            "role": "ROLE_AGENT",
                            "parts": [{ "text": "legacy complete" }]
                        },
                        "timestamp": "2026-05-15T00:02:00Z"
                    },
                    "history": [
                        {
                            "messageId": "legacy-user",
                            "contextId": "ctx-legacy",
                            "role": "ROLE_USER",
                            "parts": [{ "text": "legacy request" }]
                        }
                    ],
                    "metadata": { "workspaceId": "legacy-ws" }
                }
            ]
        }))
        .expect("ledger should serialize"),
    )
    .await
    .expect("existing ledger should be written");
    let task = a2a_task_value(
        "maestro-task-durable",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({ "workspaceId": "ws-1" }),
    );
    let raw_legacy_task = load_a2a_tasks(&state.config.a2a_tasks_file_path)
        .await
        .remove("raw-legacy-task")
        .expect("raw legacy task should hydrate before migration");
    state
        .a2a_tasks
        .lock()
        .await
        .insert("raw-legacy-task".to_string(), raw_legacy_task);

    store_a2a_task_unless_canceled(&state, "maestro-task-durable", task).await;
    let loaded = load_a2a_tasks(&state.config.a2a_tasks_file_path).await;
    let ledger: Value = serde_json::from_slice(
        &tokio::fs::read(&state.config.a2a_tasks_file_path)
            .await
            .expect("ledger should be readable"),
    )
    .expect("ledger should be json");
    let entries = ledger["tasks"]
        .as_array()
        .expect("ledger tasks should be an array");
    let remote_entry = entries
        .iter()
        .find(|entry| entry["peer"] == "peer-b")
        .expect("remote peer ledger row should be retained");
    let other_control_plane_entry = entries
        .iter()
        .find(|entry| {
            entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
                && entry["taskId"] == "other-control-plane-task"
        })
        .expect("other process control-plane row should be retained");
    let control_plane_entry = entries
        .iter()
        .find(|entry| {
            entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
                && entry["taskId"] == "maestro-task-durable"
        })
        .expect("control-plane ledger row should be written");
    let raw_legacy_entries = entries
        .iter()
        .filter(|entry| entry["id"] == "raw-legacy-task")
        .count();

    assert_eq!(remote_entry["taskId"], "remote-task");
    assert_eq!(
        other_control_plane_entry["metadata"]["workspaceId"],
        "other-ws"
    );
    assert_eq!(control_plane_entry["taskId"], "maestro-task-durable");
    assert_eq!(control_plane_entry["state"], "TASK_STATE_COMPLETED");
    assert_eq!(
        control_plane_entry["peerDisplayName"],
        A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME
    );
    assert_eq!(control_plane_entry["a2aTask"]["id"], "maestro-task-durable");
    assert_eq!(
        raw_legacy_entries, 0,
        "raw legacy A2A rows should be migrated away from the shared TS ledger shape"
    );
    assert!(entries.iter().any(|entry| {
        entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
            && entry["taskId"] == "raw-legacy-task"
            && entry["a2aTask"]["id"] == "raw-legacy-task"
    }));
    assert!(!loaded.contains_key("remote-task"));
    assert_eq!(
        loaded["maestro-task-durable"]["metadata"]["workspaceId"],
        "ws-1"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_store_waits_for_shared_ledger_file_lock() {
    let root = TestDir::new("a2a-task-ledger-lock");
    let base_state = test_app_state_with_sessions(HashMap::new());
    let mut config = auth_test_config();
    config.a2a_tasks_file_path = root.path().join("tasks.json");
    let state = AppState {
        config: Arc::new(config),
        ..base_state
    };
    let lock_path = a2a_task_ledger_lock_path(&state.config.a2a_tasks_file_path);
    tokio::fs::create_dir_all(&lock_path)
        .await
        .expect("test lock should be created");
    let task = a2a_task_value(
        "maestro-task-locked",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    let state_for_store = state.clone();
    let store = tokio::spawn(async move {
        store_a2a_task_unless_canceled(&state_for_store, "maestro-task-locked", task).await;
    });

    tokio::time::sleep(Duration::from_millis(A2A_LEDGER_LOCK_RETRY_MS * 3)).await;
    assert!(
        !tokio::fs::try_exists(&state.config.a2a_tasks_file_path)
            .await
            .expect("ledger existence should be checkable"),
        "persist should wait for the shared TS ledger lock before writing"
    );
    tokio::fs::remove_dir_all(&lock_path)
        .await
        .expect("test lock should be released");
    tokio::time::timeout(Duration::from_secs(2), store)
        .await
        .expect("store should finish after lock release")
        .expect("store task should join");

    assert!(
        tokio::fs::try_exists(&state.config.a2a_tasks_file_path)
            .await
            .expect("ledger existence should be checkable"),
        "ledger should be written after lock release"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_ledger_lock_heartbeat_refreshes_while_owned() {
    let root = TestDir::new("a2a-task-ledger-lock-heartbeat");
    let tasks_path = root.path().join("tasks.json");
    let file_lock = acquire_a2a_task_ledger_file_lock(&tasks_path)
        .await
        .expect("lock should be acquired");
    let heartbeat_path = file_lock.path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE);
    let first_heartbeat = tokio::fs::read_to_string(&heartbeat_path)
        .await
        .expect("heartbeat should be readable");

    let heartbeat_task =
        spawn_a2a_task_ledger_lock_heartbeat(&file_lock, Duration::from_millis(10));
    tokio::time::sleep(Duration::from_millis(35)).await;
    heartbeat_task.abort();
    let _ = heartbeat_task.await;

    let refreshed_heartbeat = tokio::fs::read_to_string(&heartbeat_path)
        .await
        .expect("heartbeat should still be readable");
    assert_ne!(refreshed_heartbeat, first_heartbeat);

    release_a2a_task_ledger_file_lock(file_lock).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_load_skips_remote_cli_ledger_entries() {
    let root = TestDir::new("a2a-task-ledger-remote-skip");
    let tasks_path = root.path().join("tasks.json");
    tokio::fs::write(
            &tasks_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "tasks": [
                    {
                        "id": "remote-ledger-row",
                        "kind": "message",
                        "peer": "peer-b",
                        "taskId": "remote-task",
                        "text": "remote peer task",
                        "state": "TASK_STATE_COMPLETED",
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:01:00Z"
                    },
                    {
                        "id": "raw-legacy-task",
                        "contextId": "ctx-legacy",
                        "status": {
                            "state": "TASK_STATE_COMPLETED",
                            "message": {
                                "messageId": "legacy-msg",
                                "contextId": "ctx-legacy",
                                "role": "ROLE_AGENT",
                                "parts": [{ "text": "legacy complete" }]
                            }
                        },
                        "metadata": { "workspaceId": "legacy-ws" }
                    },
                    {
                        "id": "maestro-control-plane-local-task",
                        "kind": "message",
                        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
                        "taskId": "local-task",
                        "contextId": "ctx-local",
                        "text": "local request",
                        "responseText": "local response",
                        "state": "TASK_STATE_COMPLETED",
                        "transcript": [
                            { "role": "user", "text": "local request", "messageId": "msg-local" },
                            { "role": "agent", "text": "local response", "state": "TASK_STATE_COMPLETED" }
                        ],
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:02:00Z",
                        "metadata": { "workspaceId": "local-ws" }
                    }
                ]
            }))
            .expect("ledger should serialize"),
        )
        .await
        .expect("ledger should be written");

    let loaded = load_a2a_tasks(&tasks_path).await;

    assert!(!loaded.contains_key("remote-task"));
    assert_eq!(
        loaded["raw-legacy-task"]["metadata"]["workspaceId"],
        "legacy-ws"
    );
    assert_eq!(loaded["local-task"]["metadata"]["workspaceId"], "local-ws");
    assert_eq!(
        loaded["local-task"]["status"]["message"]["parts"][0]["text"],
        "local response"
    );
    assert_eq!(loaded["local-task"]["history"].as_array().unwrap().len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_persist_rewrites_legacy_control_plane_ledger_entries() {
    let root = TestDir::new("a2a-task-ledger-legacy-rewrite");
    let base_state = test_app_state_with_sessions(HashMap::new());
    let mut config = auth_test_config();
    config.a2a_tasks_file_path = root.path().join("tasks.json");
    let state = AppState {
        config: Arc::new(config),
        ..base_state
    };
    tokio::fs::write(
        &state.config.a2a_tasks_file_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "tasks": [
                {
                    "id": "remote-ledger-row",
                    "kind": "message",
                    "peer": "peer-b",
                    "taskId": "remote-task",
                    "text": "remote peer task",
                    "state": "TASK_STATE_COMPLETED",
                    "createdAt": "2026-05-15T00:00:00Z",
                    "updatedAt": "2026-05-15T00:01:00Z"
                },
                {
                    "id": "raw-legacy-task",
                    "contextId": "ctx-legacy",
                    "status": {
                        "state": "TASK_STATE_COMPLETED",
                        "message": {
                            "messageId": "legacy-msg",
                            "contextId": "ctx-legacy",
                            "role": "ROLE_AGENT",
                            "parts": [{ "text": "legacy complete" }]
                        }
                    },
                    "metadata": { "workspaceId": "legacy-ws" }
                }
            ]
        }))
        .expect("ledger should serialize"),
    )
    .await
    .expect("ledger should be written");

    let loaded = load_a2a_tasks(&state.config.a2a_tasks_file_path).await;
    state.a2a_tasks.lock().await.extend(loaded);

    persist_a2a_tasks(&state).await;

    let ledger: Value = serde_json::from_slice(
        &tokio::fs::read(&state.config.a2a_tasks_file_path)
            .await
            .expect("ledger should be readable"),
    )
    .expect("ledger should be json");
    let entries = ledger["tasks"]
        .as_array()
        .expect("ledger tasks should be an array");
    let control_plane_entry = entries
        .iter()
        .find(|entry| entry["taskId"] == "raw-legacy-task")
        .expect("legacy task should be rewritten as a control-plane row");

    assert_eq!(entries.len(), 2);
    assert_eq!(control_plane_entry["peer"], A2A_CONTROL_PLANE_LEDGER_PEER);
    assert_eq!(control_plane_entry["a2aTask"]["id"], "raw-legacy-task");
    assert_eq!(
        control_plane_entry["a2aTask"]["metadata"]["workspaceId"],
        "legacy-ws"
    );
    assert!(!entries
        .iter()
        .any(|entry| entry.get("peer").is_none() && entry["id"] == "raw-legacy-task"));
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_stream_emits_task_status_and_artifact_events() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "streamed fake response");
    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-stream","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:stream HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let state = test_app_state_with_sessions(HashMap::new());
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
    });
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
        .await
        .expect("stream response should close")
        .expect("stream response should be readable");
    run.await
        .expect("stream task should join")
        .expect("stream endpoint should succeed");
    let response = String::from_utf8(bytes).expect("response should be utf-8");

    assert!(response.contains("Content-Type: text/event-stream"));
    assert!(response.contains("event: task"));
    assert!(response.contains("event: statusUpdate"));
    assert!(response.contains("event: artifactUpdate"));
    assert!(response.contains("\"statusUpdate\""));
    assert!(response.contains("\"artifactUpdate\""));
    assert!(response.contains("streamed fake response"));
    assert_eq!(state.a2a_tasks.lock().await.len(), 1);

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_subscribe_rejects_existing_terminal_task() {
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-subscribe",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-subscribe".to_string(), task);
    let request = "GET /tasks/maestro-task-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
    });
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
        .await
        .expect("subscribe response should close")
        .expect("subscribe response should be readable");
    run.await
        .expect("subscribe task should join")
        .expect("subscribe endpoint should succeed");
    let response = String::from_utf8(bytes).expect("response should be utf-8");
    let body: Value =
        serde_json::from_str(response_body_text(&response)).expect("body should be json");

    assert!(response.contains("400 Bad Request"));
    assert_eq!(body["error"]["code"], "UNSUPPORTED_OPERATION");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("terminal tasks cannot be subscribed"));
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_subscribe_streams_active_task_until_terminal_update() {
    let _guard = ENV_LOCK.lock().await;
    let previous_timeout = env::var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS").ok();
    let previous_heartbeat = env::var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS").ok();
    env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", "250");
    env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", "10");
    let state = test_app_state_with_sessions(HashMap::new());
    let initial_task = a2a_task_value(
        "maestro-task-active-subscribe",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "working"),
        vec![a2a_agent_message("ctx-1", "working")],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-active-subscribe".to_string(), initial_task);
    let request = "GET /tasks/maestro-task-active-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
    });
    let mut response_bytes = vec![0_u8; 4096];
    let initial_len =
        tokio::time::timeout(Duration::from_secs(2), client.read(&mut response_bytes))
            .await
            .expect("subscribe response should start")
            .expect("subscribe response should be readable");
    response_bytes.truncate(initial_len);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let terminal_task = a2a_task_value(
        "maestro-task-active-subscribe",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        vec![
            a2a_agent_message("ctx-1", "working"),
            a2a_agent_message("ctx-1", "complete"),
        ],
        vec![serde_json::json!({
            "artifactId": "artifact-1",
            "parts": [{ "text": "artifact body", "mediaType": "text/plain" }]
        })],
        serde_json::json!({}),
    );
    state.a2a_tasks.lock().await.insert(
        "maestro-task-active-subscribe".to_string(),
        terminal_task.clone(),
    );
    publish_a2a_task_update(&state, &terminal_task).await;
    tokio::time::timeout(
        Duration::from_secs(2),
        client.read_to_end(&mut response_bytes),
    )
    .await
    .expect("subscribe response should close")
    .expect("subscribe response should be readable");
    run.await
        .expect("subscribe task should join")
        .expect("subscribe endpoint should succeed");
    let response = String::from_utf8(response_bytes).expect("response should be utf-8");

    assert!(response.contains("Content-Type: text/event-stream"));
    assert!(response.contains("event: task"));
    assert!(response.contains("event: statusUpdate"));
    assert!(response.contains("event: artifactUpdate"));
    assert!(response.contains("TASK_STATE_COMPLETED"));
    assert!(response.contains("artifact body"));

    if let Some(previous_timeout) = previous_timeout {
        env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", previous_timeout);
    } else {
        env::remove_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS");
    }
    if let Some(previous_heartbeat) = previous_heartbeat {
        env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", previous_heartbeat);
    } else {
        env::remove_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_subscribe_times_out_active_stream() {
    let _guard = ENV_LOCK.lock().await;
    let previous_timeout = env::var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS").ok();
    let previous_heartbeat = env::var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS").ok();
    env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", "40");
    env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", "10");
    let state = test_app_state_with_sessions(HashMap::new());
    let initial_task = a2a_task_value(
        "maestro-task-timeout-subscribe",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "working"),
        vec![a2a_agent_message("ctx-1", "working")],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-timeout-subscribe".to_string(), initial_task);
    let request = "GET /tasks/maestro-task-timeout-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
    });
    let mut response_bytes = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        client.read_to_end(&mut response_bytes),
    )
    .await
    .expect("subscribe response should close after timeout")
    .expect("subscribe response should be readable");
    run.await
        .expect("subscribe task should join")
        .expect("subscribe endpoint should succeed");
    let response = String::from_utf8(response_bytes).expect("response should be utf-8");

    assert!(response.contains("Content-Type: text/event-stream"));
    assert!(response.contains("TASK_STATE_WORKING"));
    assert!(response.contains(": keep-alive"));

    if let Some(previous_timeout) = previous_timeout {
        env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", previous_timeout);
    } else {
        env::remove_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS");
    }
    if let Some(previous_heartbeat) = previous_heartbeat {
        env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", previous_heartbeat);
    } else {
        env::remove_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_subscribe_reconciles_current_task_after_broadcast_lag() {
    let base_state = test_app_state_with_sessions(HashMap::new());
    let (a2a_task_events, _) = broadcast::channel(1);
    let state = AppState {
        a2a_task_events,
        ..base_state
    };
    let initial_task = a2a_task_value(
        "maestro-task-lagged-subscribe",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "working"),
        vec![a2a_agent_message("ctx-1", "working")],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-lagged-subscribe".to_string(), initial_task);
    let request = "GET /tasks/maestro-task-lagged-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (mut client, server) = tcp_stream_pair().await;
    let state_for_run = state.clone();
    let run = tokio::spawn(async move {
        handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
    });
    let mut response_bytes = vec![0_u8; 4096];
    let initial_len =
        tokio::time::timeout(Duration::from_secs(2), client.read(&mut response_bytes))
            .await
            .expect("subscribe response should start")
            .expect("subscribe response should be readable");
    response_bytes.truncate(initial_len);

    let intermediate_task = a2a_task_value(
        "maestro-task-lagged-subscribe",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "halfway after lag"),
        vec![
            a2a_agent_message("ctx-1", "working"),
            a2a_agent_message("ctx-1", "halfway after lag"),
        ],
        Vec::new(),
        serde_json::json!({}),
    );
    state.a2a_tasks.lock().await.insert(
        "maestro-task-lagged-subscribe".to_string(),
        intermediate_task.clone(),
    );
    publish_a2a_task_update(&state, &intermediate_task).await;
    let terminal_task = a2a_task_value(
        "maestro-task-lagged-subscribe",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete after lag"),
        vec![
            a2a_agent_message("ctx-1", "working"),
            a2a_agent_message("ctx-1", "halfway after lag"),
            a2a_agent_message("ctx-1", "complete after lag"),
        ],
        Vec::new(),
        serde_json::json!({}),
    );
    state.a2a_tasks.lock().await.insert(
        "maestro-task-lagged-subscribe".to_string(),
        terminal_task.clone(),
    );
    publish_a2a_task_update(&state, &terminal_task).await;
    for index in 0..4 {
        let unrelated_task = a2a_task_value(
            &format!("unrelated-task-{index}"),
            "ctx-other",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-other", "noise"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        publish_a2a_task_update(&state, &unrelated_task).await;
    }

    tokio::time::timeout(
        Duration::from_secs(2),
        client.read_to_end(&mut response_bytes),
    )
    .await
    .expect("subscribe response should close after reconciling lag")
    .expect("subscribe response should be readable");
    run.await
        .expect("subscribe task should join")
        .expect("subscribe endpoint should succeed");
    let response = String::from_utf8(response_bytes).expect("response should be utf-8");

    assert!(response.contains("TASK_STATE_COMPLETED"));
    assert!(response.contains("halfway after lag"));
    assert!(response.contains("complete after lag"));
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_task_follow_up_from_other_subject() {
    let _guard = ENV_LOCK.lock().await;
    let previous_secret = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "should not run");
    let state = test_app_state_with_sessions(HashMap::new());
    let existing_message = a2a_agent_message("ctx-1", "Need more input");
    let task = a2a_task_value(
        "owned-task",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        existing_message.clone(),
        vec![existing_message],
        Vec::new(),
        serde_json::json!({ "ownerSubject": "user-123" }),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("owned-task".to_string(), task);
    let token = shared_secret_bearer_token(b"shared-secret", "user-456");
    let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"owned-task","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "TASK_NOT_FOUND");
    assert_eq!(
        state.a2a_tasks.lock().await["owned-task"]["status"]["state"],
        "TASK_STATE_INPUT_REQUIRED"
    );

    if let Some(previous_secret) = previous_secret {
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous_secret);
    } else {
        env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
    }
    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_preserves_owner_metadata_on_unrestricted_follow_up() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "follow-up response");
    let state = test_app_state_with_sessions(HashMap::new());
    let existing_message = a2a_agent_message("ctx-1", "Need more input");
    let task = a2a_task_value(
        "owned-task",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        existing_message.clone(),
        vec![existing_message],
        Vec::new(),
        serde_json::json!({
            "ownerSubject": "user-123",
            "workspaceId": "ws-old"
        }),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("owned-task".to_string(), task);
    let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"owned-task","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-workspace-id: ws-new\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let task = &response["task"];

    assert_eq!(task["id"], "owned-task");
    assert_eq!(task["metadata"]["ownerSubject"], "user-123");
    assert_eq!(task["metadata"]["workspaceId"], "ws-new");
    assert_eq!(
        state.a2a_tasks.lock().await["owned-task"]["metadata"]["ownerSubject"],
        "user-123"
    );

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_unknown_task_id() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "should not run");

    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","taskId":"missing-task","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "TASK_NOT_FOUND");
    assert!(state.a2a_tasks.lock().await.is_empty());

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_reuses_existing_task_id_and_history() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "follow-up response");

    let body = r#"{"message":{"messageId":"msg-2","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-session-id: header-ctx\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());
    let existing_message = a2a_agent_message("ctx-1", "Need more input");
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        existing_message.clone(),
        vec![existing_message],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let task = &response["task"];

    assert_eq!(task["id"], "maestro-task-1");
    assert_eq!(task["contextId"], "ctx-1");
    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(task["history"].as_array().unwrap().len(), 3);
    assert_eq!(task["history"][1]["contextId"], "ctx-1");
    assert_eq!(task["history"][2]["parts"][0]["text"], "follow-up response");

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_terminal_task_id() {
    let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_rejects_active_task_id() {
    let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "working"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);
    let (cancel_tx, _cancel_rx) = watch::channel(false);
    state
        .a2a_cancel_senders
        .lock()
        .await
        .insert("maestro-task-1".to_string(), cancel_tx);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
    assert_eq!(
        stored["maestro-task-1"]["status"]["state"],
        "TASK_STATE_WORKING"
    );
    assert_eq!(state.a2a_cancel_senders.lock().await.len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_claims_input_task_before_launch() {
    let state = test_app_state_with_sessions(HashMap::new());
    let existing_message = a2a_agent_message("ctx-1", "Need more input");
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        existing_message.clone(),
        vec![existing_message],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);
    let head = RequestHead {
        method: "POST".to_string(),
        path: "/message:send".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let request = A2ASendMessageRequest {
        message: A2AMessageBody {
            message_id: Some("msg-2".to_string()),
            context_id: None,
            task_id: Some("maestro-task-1".to_string()),
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("follow up".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        },
        configuration: None,
        metadata: None,
    };
    let auth = AuthContext {
        subject: None,
        unrestricted: true,
    };

    let claimed = claim_a2a_send_task(
        &state,
        &request,
        &head,
        &auth,
        serde_json::json!({ "test": "metadata" }),
    )
    .await
    .expect("input-required task should be claimed");
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(claimed.task_id, "maestro-task-1");
    assert_eq!(claimed.context_id, "ctx-1");
    assert_eq!(claimed.history.len(), 2);
    assert_eq!(
        stored["maestro-task-1"]["status"]["state"],
        "TASK_STATE_WORKING"
    );
    drop(stored);

    let response = response_json(
        claim_a2a_send_task(&state, &request, &head, &auth, serde_json::json!({}))
            .await
            .expect_err("already-claimed task should reject overlap"),
    );
    assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_message_send_restores_claimed_task_when_cancel_sender_registration_fails() {
    let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());
    let existing_message = a2a_agent_message("ctx-1", "Need more input");
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        existing_message.clone(),
        vec![existing_message],
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);
    let (cancel_tx, _cancel_rx) = watch::channel(false);
    state
        .a2a_cancel_senders
        .lock()
        .await
        .insert("maestro-task-1".to_string(), cancel_tx);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
    assert_eq!(
        stored["maestro-task-1"]["status"]["state"],
        "TASK_STATE_INPUT_REQUIRED"
    );
    assert_eq!(
        stored["maestro-task-1"]["history"]
            .as_array()
            .expect("history should be an array")
            .len(),
        1
    );
    drop(stored);
    assert_eq!(state.a2a_cancel_senders.lock().await.len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_cancel_rejects_terminal_tasks() {
    let (_client, mut server) = tcp_stream_pair().await;
    let mut initial =
            b"POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
                .to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_COMPLETED",
        a2a_agent_message("ctx-1", "complete"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(response["error"]["code"], "TASK_NOT_CANCELABLE");
    assert_eq!(
        stored["maestro-task-1"]["status"]["state"],
        "TASK_STATE_COMPLETED"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_cancel_clears_stale_artifacts() {
    let (_client, mut server) = tcp_stream_pair().await;
    let mut initial =
            b"POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
                .to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        a2a_agent_message("ctx-1", "waiting"),
        Vec::new(),
        vec![serde_json::json!({
            "artifactId": "stale-artifact",
            "parts": [{ "text": "stale", "mediaType": "text/plain" }]
        })],
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(response["status"]["state"], "TASK_STATE_CANCELED");
    assert_eq!(response["artifacts"].as_array().unwrap().len(), 0);
    assert_eq!(
        stored["maestro-task-1"]["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_completion_attaches_subagent_work_graph_metadata() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "review complete");
    let state = test_app_state_with_sessions(HashMap::new());
    let user_message = a2a_user_message_value(
        &A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("ctx-1".to_string()),
            task_id: None,
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("review this".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        },
        "ctx-1",
    );
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let mut metadata = Map::new();
    metadata.insert(
        A2A_SUBAGENT_REQUEST_METADATA_PATH.to_string(),
        serde_json::json!({
            "skillId": "maestro.subagent.code-review",
            "role": "reviewer",
            "taskId": "alpha-review",
            "swarmId": "swarm-1"
        }),
    );

    let task = complete_a2a_task(
        &state,
        "review this".to_string(),
        "maestro-task-1".to_string(),
        "ctx-1".to_string(),
        vec![user_message],
        Value::Object(metadata),
        cancel_rx,
    )
    .await;

    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(
        task["metadata"]["workGraph"]["schemaVersion"],
        CODEX_SUBAGENT_WORK_GRAPH_SCHEMA
    );
    assert_eq!(task["metadata"]["workGraph"]["childRunCount"], 1);
    assert_eq!(
        task["metadata"]["workGraph"]["toolExecutionIds"][0],
        "a2a-subagent-dispatch:maestro-task-1"
    );
    assert_eq!(
        task["metadata"]["workGraph"]["codexSubagents"]["edges"][0]["role"],
        "reviewer"
    );
    assert_eq!(
        task["metadata"]["workGraph"]["correlationPath"],
        "maestro-swarm/swarm-1/alpha-review/a2a/maestro-task-1"
    );

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_async_completion_preserves_canceled_task_state() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "late response");

    let state = test_app_state_with_sessions(HashMap::new());
    let task = a2a_task_value(
        "maestro-task-1",
        "ctx-1",
        "TASK_STATE_CANCELED",
        a2a_agent_message("ctx-1", "Task canceled"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("maestro-task-1".to_string(), task);

    let user_message = a2a_user_message_value(
        &A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("ctx-1".to_string()),
            task_id: Some("maestro-task-1".to_string()),
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("hello".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        },
        "ctx-1",
    );
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let task = complete_a2a_task(
        &state,
        "hello".to_string(),
        "maestro-task-1".to_string(),
        "ctx-1".to_string(),
        vec![user_message],
        serde_json::json!({}),
        cancel_rx,
    )
    .await;
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(task["status"]["state"], "TASK_STATE_CANCELED");
    assert_eq!(
        stored["maestro-task-1"]["status"]["state"],
        "TASK_STATE_CANCELED"
    );

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_cancel_signals_return_immediately_worker() {
    let _guard = ENV_LOCK.lock().await;
    let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
    let previous_delay = env::var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS").ok();
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "late response");
    env::set_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS", "500");

    let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":{"returnImmediately":true}}"#;
    let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let task_id = response["task"]["id"]
        .as_str()
        .expect("task id should be present")
        .to_string();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        state.a2a_tasks.lock().await[&task_id]["status"]["state"],
        "TASK_STATE_WORKING"
    );

    let cancel_request = format!(
            "POST /tasks/{task_id}:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
        );
    let mut cancel_initial = cancel_request.into_bytes();
    let cancel_head = parse_request_head(&cancel_initial).expect("request should parse");
    let (_client, mut cancel_server) = tcp_stream_pair().await;
    let cancel_response = response_json(
        handle_a2a_endpoint(&mut cancel_server, &mut cancel_initial, cancel_head, &state).await,
    );
    assert_eq!(cancel_response["status"]["state"], "TASK_STATE_CANCELED");

    tokio::time::sleep(Duration::from_millis(600)).await;
    let stored = state.a2a_tasks.lock().await;
    assert_eq!(stored[&task_id]["status"]["state"], "TASK_STATE_CANCELED");
    assert_eq!(stored[&task_id]["artifacts"].as_array().unwrap().len(), 0);

    if let Some(previous_fake) = previous_fake {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
    }
    if let Some(previous_delay) = previous_delay {
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS", previous_delay);
    } else {
        env::remove_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_cancel_requires_csrf_token_when_enabled() {
    let base_state = test_app_state_with_sessions(HashMap::new());
    let mut config = auth_test_config();
    config.require_csrf = true;
    config.csrf_token = Some("csrf-token".to_string());
    let state = AppState {
        config: Arc::new(config),
        ..base_state
    };
    state.a2a_tasks.lock().await.insert(
        "maestro-task-1".to_string(),
        a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "working"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({ "workspaceId": "ws-1" }),
        ),
    );

    let request = "POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let mut initial = request.as_bytes().to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

    assert_eq!(response["error"], "Forbidden: invalid CSRF token");
    assert_eq!(
        state.a2a_tasks.lock().await["maestro-task-1"]["status"]["state"],
        "TASK_STATE_WORKING"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_task_store_evicts_old_terminal_tasks() {
    let state = test_app_state_with_sessions(HashMap::new());
    let working_task = a2a_task_value(
        "working-task",
        "ctx-1",
        "TASK_STATE_WORKING",
        a2a_agent_message("ctx-1", "still running"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    store_a2a_task_unless_canceled(&state, "working-task", working_task).await;

    for index in 0..=A2A_TERMINAL_TASK_STORE_LIMIT {
        let task_id = format!("terminal-task-{index}");
        let mut task = a2a_task_value(
            &task_id,
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "done"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        task["status"]["timestamp"] = Value::String(format!(
            "2026-05-15T00:{:02}:{:02}Z",
            index / 60,
            index % 60
        ));
        store_a2a_task_unless_canceled(&state, &task_id, task).await;
    }

    let newest_terminal_task_id = format!("terminal-task-{A2A_TERMINAL_TASK_STORE_LIMIT}");
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(stored.len(), A2A_TERMINAL_TASK_STORE_LIMIT + 1);
    assert!(stored.contains_key("working-task"));
    assert!(!stored.contains_key("terminal-task-0"));
    assert!(stored.contains_key(&newest_terminal_task_id));
    assert_eq!(
        stored
            .values()
            .filter(|task| a2a_task_is_terminal(task))
            .count(),
        A2A_TERMINAL_TASK_STORE_LIMIT
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a2a_cancel_prunes_terminal_task_store() {
    let state = test_app_state_with_sessions(HashMap::new());
    for index in 0..A2A_TERMINAL_TASK_STORE_LIMIT {
        let task_id = format!("terminal-task-{index}");
        let mut task = a2a_task_value(
            &task_id,
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "done"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        task["status"]["timestamp"] = Value::String(format!(
            "2026-05-15T00:{:02}:{:02}Z",
            index / 60,
            index % 60
        ));
        state.a2a_tasks.lock().await.insert(task_id, task);
    }
    let task = a2a_task_value(
        "cancel-task",
        "ctx-1",
        "TASK_STATE_INPUT_REQUIRED",
        a2a_agent_message("ctx-1", "Need more input"),
        Vec::new(),
        Vec::new(),
        serde_json::json!({}),
    );
    state
        .a2a_tasks
        .lock()
        .await
        .insert("cancel-task".to_string(), task);
    let request = b"POST /tasks/cancel-task:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
    let mut initial = request.to_vec();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;

    let response =
        response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
    let stored = state.a2a_tasks.lock().await;

    assert_eq!(response["status"]["state"], "TASK_STATE_CANCELED");
    assert!(stored.contains_key("cancel-task"));
    assert!(!stored.contains_key("terminal-task-0"));
    assert_eq!(
        stored
            .values()
            .filter(|task| a2a_task_is_terminal(task))
            .count(),
        A2A_TERMINAL_TASK_STORE_LIMIT
    );
}

#[test]
fn detects_migrated_web_api_routes() {
    for target in [
        "/api/model",
        "/api/files",
        "/api/commands",
        "/api/config",
        "/api/usage",
        "/api/approvals",
        "/api/telemetry",
        "/api/training",
        "/api/sessions",
        "/api/sessions/session-1",
        "/api/sessions/session-1/timeline",
        "/api/sessions/session-1/artifacts",
        "/api/sessions/session-1/artifact-access",
        "/api/sessions/session-1/artifacts/report.html",
        "/api/sessions/session-1/attachments/file-1",
        "/api/sessions/shared/session-1",
        "/api/sessions/shared/session-1/attachments/file-1",
    ] {
        let request = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        let head = parse_request_head(request.as_bytes()).expect("request should parse");
        assert!(is_local_endpoint(&head), "{target} should be local");
    }
}

#[test]
fn detects_session_create_and_pending_resume_routes() {
    for request in [
            "POST /api/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/share HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/export HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/attachments/att-1/extract HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/attachments/extract HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/approvals HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "PATCH /api/sessions/session-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "DELETE /api/sessions/session-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/pending-requests/request-1/resume HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/pending-requests/codex%3Asession-1%3Arun-1%3Aapproval-1/resume HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_local_endpoint(&head), "{request} should be local");
        }
}

#[test]
fn pending_resume_path_decodes_url_encoded_request_ids() {
    assert_eq!(
        pending_request_id_from_resume_path(
            "/api/pending-requests/codex%3Asession-1%3Arun-1%3Aapproval-1/resume"
        )
        .as_deref(),
        Some("codex:session-1:run-1:approval-1")
    );
    assert!(pending_request_id_from_resume_path("/api/pending-requests/bad%2Fid/resume").is_none());
}

#[test]
fn detects_api_options_preflight_as_local() {
    let head = parse_request_head(
            b"OPTIONS /api/chat HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4173\r\nAccess-Control-Request-Method: POST\r\n\r\n",
        )
        .expect("request should parse");
    assert!(is_local_endpoint(&head));

    let response = response(204, "text/plain; charset=utf-8", &[]);
    let text = String::from_utf8(response).expect("response should be utf-8");
    assert!(text.starts_with("HTTP/1.1 204 No Content\r\n"));
    assert!(text.contains("Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS\r\n"));
}

#[tokio::test]
async fn background_update_parses_body_and_returns_update_contract() {
    let body = r#"{"enabled":true}"#;
    let request = format!(
            "POST /api/background?action=notify HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_local_endpoint(&mut server, &mut initial, head, &state).await);
    let settings = state.background_settings.lock().await.clone();
    let status = background_response(
        &RequestHead {
            method: "GET".to_string(),
            path: "/api/background".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        },
        &settings,
    );

    assert_eq!(response.get("success").and_then(Value::as_bool), Some(true));
    assert_eq!(
        response.get("message").and_then(Value::as_str),
        Some("Background task notifications enabled.")
    );
    assert!(response.get("settings").is_none());
    assert_eq!(
        status
            .pointer("/settings/notificationsEnabled")
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[tokio::test]
async fn framework_update_parses_body_and_returns_contract_shape() {
    let body = r#"{"framework":"fastapi","scope":"workspace"}"#;
    let request = format!(
            "POST /api/framework HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    let mut initial = request.into_bytes();
    let head = parse_request_head(&initial).expect("request should parse");
    let (_client, mut server) = tcp_stream_pair().await;
    let state = test_app_state_with_sessions(HashMap::new());

    let response =
        response_json(handle_local_endpoint(&mut server, &mut initial, head, &state).await);
    let framework = state.framework_preference.lock().await.clone();
    let status = framework_response(
        &RequestHead {
            method: "GET".to_string(),
            path: "/api/framework".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        },
        framework.as_deref(),
    );

    assert_eq!(response.get("success").and_then(Value::as_bool), Some(true));
    assert_eq!(
        response.get("framework").and_then(Value::as_str),
        Some("fastapi")
    );
    assert_eq!(
        response.get("scope").and_then(Value::as_str),
        Some("workspace")
    );
    assert!(response.get("summary").and_then(Value::as_str).is_some());
    assert_eq!(
        status.get("framework").and_then(Value::as_str),
        Some("fastapi")
    );
}

#[test]
fn artifact_access_actions_decode_and_filter_query_actions() {
    let actions = artifact_access_actions(Some(&"view%2Cfile%2Cbad%2Czip%2Cfile".to_string()))
        .expect("valid actions should be extracted");
    assert_eq!(actions, vec!["view", "file", "zip"]);
}

#[test]
fn parses_session_attachment_extract_path() {
    assert_eq!(
        session_attachment_extract_id("attachments/att%201/extract"),
        Some("att 1".to_string())
    );
    assert!(session_attachment_extract_id("attachments/att-1").is_none());
    assert!(session_attachment_extract_id("artifacts/report.txt").is_none());
}

#[test]
fn extracts_text_attachment_without_node_runtime() {
    let output = extract_attachment_request(ExtractAttachmentRequest {
        file_name: "notes.md".to_string(),
        mime_type: Some("text/markdown".to_string()),
        content_base64: BASE64_STANDARD.encode("hello from rust"),
        max_chars: Some(5),
    })
    .expect("text extraction should succeed");

    assert_eq!(output.format, "text");
    assert_eq!(output.extractor, "native");
    assert_eq!(output.size_bytes, "hello from rust".len());
    assert_eq!(output.extracted_text, "hello");
    assert!(output.truncated);
}

#[test]
fn extracts_text_attachment_from_data_url_content() {
    let output = extract_attachment_request(ExtractAttachmentRequest {
        file_name: "notes.txt".to_string(),
        mime_type: None,
        content_base64: format!("data:text/plain;base64,{}", BASE64_STANDARD.encode("hello")),
        max_chars: None,
    })
    .expect("data url extraction should succeed");

    assert_eq!(output.extracted_text, "hello");
}

#[test]
fn extracts_docx_attachment_without_node_runtime() {
    let docx = build_store_zip([(
            "word/document.xml",
            br#"<w:document><w:body><w:p><w:r><w:t>Hello &amp; Rust</w:t></w:r></w:p></w:body></w:document>"#
                .as_slice(),
        )])
        .expect("docx zip should build");

    let output = extract_document_text(
        docx,
        "notes.docx".to_string(),
        Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()),
        None,
    )
    .expect("docx extraction should succeed");

    assert_eq!(output.format, "docx");
    assert_eq!(output.extractor, "native");
    assert!(output.extracted_text.contains("Hello & Rust"));
}

#[test]
fn extracts_html_attachment_with_configured_markitdown() {
    let script_path = env::temp_dir().join(format!(
        "maestro-fake-markitdown-{}-{}.sh",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::write(
        &script_path,
        "printf '# Converted by MarkItDown\\n\\nRust body from fake CLI'",
    )
    .expect("fake MarkItDown script should be written");
    env::set_var("MAESTRO_MARKITDOWN_CMD", "sh");
    env::set_var(
        "MAESTRO_MARKITDOWN_ARGS",
        script_path.to_string_lossy().to_string(),
    );
    env::remove_var("MAESTRO_MARKITDOWN");
    env::remove_var("MAESTRO_MARKITDOWN_PREFER");

    let output = extract_document_text(
        b"<html><body><h1>Ignored native HTML</h1></body></html>".to_vec(),
        "brief.html".to_string(),
        Some("text/html".to_string()),
        None,
    )
    .expect("MarkItDown extraction should succeed");

    assert_eq!(output.format, "text");
    assert_eq!(output.extractor, "markitdown");
    assert!(output.extracted_text.contains("# Converted by MarkItDown"));

    env::remove_var("MAESTRO_MARKITDOWN_CMD");
    env::remove_var("MAESTRO_MARKITDOWN_ARGS");
    let _ = std::fs::remove_file(script_path);
}

#[test]
fn builds_store_zip_archive_without_node_runtime() {
    let zip = build_store_zip([("artifact.txt", b"hello artifact".as_slice())])
        .expect("zip archive should build");

    assert!(zip.starts_with(&[0x50, 0x4b, 0x03, 0x04]));
    assert!(zip
        .windows("artifact.txt".len())
        .any(|window| window == b"artifact.txt"));
    assert!(zip
        .windows("hello artifact".len())
        .any(|window| window == b"hello artifact"));
    assert!(zip
        .windows(4)
        .any(|window| window == [0x50, 0x4b, 0x05, 0x06]));
}

#[test]
fn artifact_view_wraps_html_in_sandboxed_viewer() {
    let mut session = create_session_record(Some("Artifacts".to_string()), None);
    session.messages.push(composer_assistant_message_with_tools(
        "created",
        "",
        None,
        &[serde_json::json!({
            "id": "tool-1",
            "name": "artifacts",
            "status": "completed",
            "args": {
                "command": "create",
                "filename": "report.html",
                "content": "<script>window.top.location='https://example.com'</script>"
            },
            "result": { "isError": false }
        })],
    ));

    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/sessions/session-1/artifacts/report.html/view".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let response = serve_session_artifact(&head, &session, "artifacts/report.html/view");
    let text = String::from_utf8(response).expect("response should be utf-8");

    assert!(text.starts_with("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8"));
    assert!(text.contains("Content-Security-Policy: default-src 'none'"));
    assert!(text.contains("sandbox=\"allow-scripts allow-forms allow-popups allow-downloads\""));
    assert!(text.contains(
        "srcdoc=\"&lt;script&gt;window.top.location=&#39;https://example.com&#39;&lt;/script&gt;\""
    ));
    assert!(!text.contains("<script>window.top.location"));
}

#[test]
fn assistant_tool_metadata_reconstructs_artifacts_after_persist() {
    let mut tools = Vec::new();
    record_tool_call_metadata(
        &mut tools,
        "tool-1",
        "artifacts",
        serde_json::json!({
            "command": "create",
            "filename": "report.html",
            "content": "<h1>Hello</h1>"
        }),
    );
    update_tool_metadata_status(&mut tools, "tool-1", "running");
    finish_tool_metadata(&mut tools, "tool-1", true);

    let mut session = create_session_record(Some("Artifacts".to_string()), None);
    session.messages.push(composer_assistant_message_with_tools(
        "done", "", None, &tools,
    ));

    let artifacts = reconstruct_session_artifacts(&session);
    assert_eq!(
        artifacts.get("report.html"),
        Some(&"<h1>Hello</h1>".to_string())
    );
}

#[test]
fn assistant_usage_cost_uses_contract_shape() {
    let message = composer_assistant_message(
        "done",
        "",
        Some(TokenUsage {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            cost: None,
        }),
    );

    assert_eq!(message["usage"]["cost"]["input"], 0.0);
    assert_eq!(message["usage"]["cost"]["output"], 0.0);
    assert_eq!(message["usage"]["cost"]["cacheRead"], 0.0);
    assert_eq!(message["usage"]["cost"]["cacheWrite"], 0.0);
    assert_eq!(message["usage"]["cost"]["total"], 0.0);
}

#[tokio::test]
async fn usage_buckets_include_contract_breakdown_fields() {
    let path = env::temp_dir().join(format!(
        "maestro-usage-{}-{}.json",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let usage = serde_json::json!([{
        "provider": "openai",
        "model": "gpt-5.1-codex-max",
        "tokensInput": 10,
        "tokensOutput": 20,
        "tokensCacheRead": 3,
        "tokensCacheWrite": 4,
        "cost": 0.12
    }]);
    tokio::fs::write(&path, usage.to_string())
        .await
        .expect("usage file should be written");

    let snapshot = usage_snapshot(&path).await;
    let provider = snapshot
        .pointer("/summary/byProvider/openai")
        .expect("provider bucket should exist");
    let model = snapshot
        .pointer("/summary/byModel")
        .and_then(|models| models.get("openai/gpt-5.1-codex-max"))
        .expect("model bucket should exist");

    assert_eq!(provider.get("calls").and_then(Value::as_u64), Some(1));
    assert_eq!(
        provider.get("cachedTokens").and_then(Value::as_u64),
        Some(7)
    );
    assert_eq!(model.get("calls").and_then(Value::as_u64), Some(1));
    assert_eq!(model.get("cachedTokens").and_then(Value::as_u64), Some(7));

    let _ = tokio::fs::remove_file(path).await;
}

#[test]
fn onboarding_snapshot_honors_seen_count_limit() {
    let first_seen = compute_onboarding_snapshot(false, false, 1, false);
    assert!(first_seen.should_show);
    assert_eq!(first_seen.seen_count, 1);

    let capped =
        compute_onboarding_snapshot(false, false, MAX_PROJECT_ONBOARDING_IMPRESSIONS, false);
    assert!(!capped.should_show);
    assert_eq!(capped.seen_count, MAX_PROJECT_ONBOARDING_IMPRESSIONS);
}

#[test]
fn share_options_honor_expiry_and_access_limits() {
    let options = share_options_from_value(&serde_json::json!({
        "expiresInHours": 999,
        "maxAccesses": 0
    }));

    assert_eq!(options.expires_in_hours, 168);
    assert_eq!(options.max_accesses, Some(1));
    assert!(!options.allow_sensitive_content);

    let unlimited = share_options_from_value(&serde_json::json!({
        "maxAccesses": Value::Null,
        "allowSensitiveContent": true
    }));
    assert_eq!(unlimited.max_accesses, None);
    assert!(unlimited.allow_sensitive_content);
}

#[test]
fn session_store_preserves_shared_session_grants() {
    let store = SessionStore {
        sessions: HashMap::from([("session-1".to_string(), test_session_record("session-1"))]),
        shared_sessions: HashMap::from([(
            "share-token".to_string(),
            SharedSessionGrant {
                session_id: "session-1".to_string(),
                expires_at: 1_900_000_000_000,
                max_accesses: Some(3),
                access_count: 1,
            },
        )]),
    };

    let encoded = serde_json::to_vec(&store).expect("store should serialize");
    let decoded = decode_session_store(&encoded).expect("store should decode");
    let grant = decoded
        .shared_sessions
        .get("share-token")
        .expect("share grant should persist");

    assert_eq!(grant.session_id, "session-1");
    assert_eq!(grant.max_accesses, Some(3));
    assert_eq!(grant.access_count, 1);
}

#[test]
fn session_sensitive_content_detection_flags_secrets() {
    let mut session = test_session_record("session-1");
    session.messages.push(serde_json::json!({
        "role": "user",
        "content": "my api_key is secret"
    }));

    assert!(session_contains_sensitive_content(&session));
}

#[test]
fn subject_auth_only_sees_owned_sessions() {
    let mut session = test_session_record("session-1");
    session.owner = Some("user-123".to_string());
    let owner = AuthContext {
        subject: Some("user-123".to_string()),
        unrestricted: false,
    };
    let other_user = AuthContext {
        subject: Some("user-456".to_string()),
        unrestricted: false,
    };
    let admin = AuthContext {
        subject: None,
        unrestricted: true,
    };

    assert!(session_visible_to_auth(&session, &owner));
    assert!(!session_visible_to_auth(&session, &other_user));
    assert!(session_visible_to_auth(&session, &admin));
}

#[test]
fn decodes_legacy_session_store_shapes() {
    let wrapped = decode_session_store(
            br#"{"sessions":{"session-1":{"id":"session-1","title":"One","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}}}"#,
        )
        .expect("wrapped store should decode");
    assert!(wrapped.sessions.contains_key("session-1"));

    let mapped = decode_session_store(
            br#"{"session-2":{"id":"session-2","title":"Two","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}}"#,
        )
        .expect("map store should decode");
    assert!(mapped.sessions.contains_key("session-2"));

    let array = decode_session_store(
            br#"[{"id":"session-3","title":"Three","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}]"#,
        )
        .expect("array store should decode");
    assert!(array.sessions.contains_key("session-3"));
}

#[tokio::test]
async fn shared_attachment_reads_do_not_consume_or_require_page_access() {
    let mut session = test_session_record("session-1");
    session.messages.push(serde_json::json!({
        "role": "user",
        "content": "see attachment",
        "attachments": [{
            "id": "att-1",
            "fileName": "note.txt",
            "mimeType": "text/plain",
            "content": BASE64_STANDARD.encode("hello")
        }]
    }));
    let state =
        test_app_state_with_sessions(HashMap::from([(session.id.clone(), session.clone())]));
    state.shared_sessions.lock().await.insert(
        "share-token".to_string(),
        SharedSessionGrant {
            session_id: session.id.clone(),
            expires_at: now_millis().saturating_add(60_000),
            max_accesses: Some(1),
            access_count: 1,
        },
    );

    let response = handle_shared_session_get(
        &state,
        SharedSessionPath {
            token: "share-token",
            tail: Some("attachments/att-1"),
        },
    )
    .await;
    let text = String::from_utf8(response).expect("response should be utf-8");

    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.ends_with("hello"));
}

#[tokio::test]
async fn shared_session_get_uses_share_token_without_api_auth() {
    let mut session = test_session_record("session-1");
    session.messages.push(serde_json::json!({
        "role": "user",
        "content": "shared hello"
    }));
    let state =
        test_app_state_with_sessions(HashMap::from([(session.id.clone(), session.clone())]));
    state.shared_sessions.lock().await.insert(
        "share-token".to_string(),
        SharedSessionGrant {
            session_id: session.id.clone(),
            expires_at: now_millis().saturating_add(60_000),
            max_accesses: Some(2),
            access_count: 0,
        },
    );
    let mut server = tcp_stream_pair().await.0;
    let head = parse_request_head(
        b"GET /api/sessions/shared/share-token HTTP/1.1\r\nHost: localhost\r\n\r\n",
    )
    .expect("request should parse");

    let response = handle_session_endpoint(&mut server, &mut Vec::new(), &head, &state).await;
    let text = String::from_utf8(response).expect("response should be utf-8");

    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains("shared hello"));
}

#[tokio::test]
async fn chat_user_message_rejects_unowned_existing_session() {
    let mut session = test_session_record("session-1");
    session.owner = Some("other-user".to_string());
    let state = test_app_state_with_sessions(HashMap::from([(session.id.clone(), session)]));
    let auth = AuthContext {
        subject: Some("user-123".to_string()),
        unrestricted: false,
    };
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: Some("session-1".to_string()),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String("hello".to_string()),
            attachments: Vec::new(),
            extra: Map::new(),
        }],
    };

    let result = record_chat_user_message(&state, &chat, &auth).await;
    let stored = state.sessions.lock().await;

    assert!(result.is_err());
    assert!(stored.sessions["session-1"].messages.is_empty());
}

#[tokio::test]
async fn chat_user_message_preserves_requested_id_when_creating_session() {
    let state = test_app_state_with_sessions(HashMap::new());
    let auth = AuthContext {
        subject: Some("user-123".to_string()),
        unrestricted: false,
    };
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: Some("requested-session".to_string()),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String("hello".to_string()),
            attachments: Vec::new(),
            extra: Map::new(),
        }],
    };

    record_chat_user_message(&state, &chat, &auth)
        .await
        .expect("message should be recorded");
    let stored = state.sessions.lock().await;
    let session = stored
        .sessions
        .get("requested-session")
        .expect("session should use requested key");

    assert_eq!(session.id, "requested-session");
    assert_eq!(session.message_count, 1);
}

#[test]
fn session_read_payloads_omit_inline_attachment_content() {
    let mut session = test_session_record("session-1");
    session.messages.push(serde_json::json!({
        "role": "user",
        "content": "see attachment",
        "attachments": [{
            "id": "att-1",
            "fileName": "note.txt",
            "mimeType": "text/plain",
            "content": BASE64_STANDARD.encode("hello")
        }]
    }));

    let full = session_full_value(&session);
    let attachment = &full["messages"][0]["attachments"][0];
    assert!(attachment.get("content").is_none());
    assert_eq!(
        attachment.get("contentOmitted").and_then(Value::as_bool),
        Some(true)
    );

    let list = session_attachments_value(&session);
    assert!(list["attachments"][0].get("content").is_none());

    let response = serve_session_attachment(&session, "attachments/att-1");
    let text = String::from_utf8(response).expect("response should be utf-8");
    assert!(text.ends_with("hello"));
}

#[test]
fn export_options_require_explicit_sensitive_confirmation() {
    let default_options = export_options_from_body(&[]).expect("empty body should parse");
    assert_eq!(default_options.format, "json");
    assert!(!default_options.allow_sensitive_content);

    let confirmed = export_options_from_value(&serde_json::json!({
        "format": "markdown",
        "allowSensitiveContent": true
    }));
    assert_eq!(confirmed.format, "markdown");
    assert!(confirmed.allow_sensitive_content);
}

#[test]
fn timeline_items_use_run_timeline_schema() {
    let mut session = test_session_record("session-1");
    session.messages.push(serde_json::json!({
        "role": "user",
        "timestamp": "2026-04-27T00:00:00Z",
        "content": "hello"
    }));

    let timeline = session_timeline_value(&session);
    assert_eq!(timeline["sessionId"], "session-1");
    assert_eq!(timeline["items"][0]["sessionId"], "session-1");
    assert_eq!(timeline["items"][0]["type"], "message.user");
    assert_eq!(timeline["items"][0]["visibility"], "user");
}

#[test]
fn generated_share_tokens_are_opaque() {
    let session_id = "session-123";
    let token = generate_share_token().expect("share token should be generated");

    assert_ne!(token, session_id);
    assert!(!token.contains(session_id));
    assert!(token.len() >= 32);
}

#[test]
fn shared_session_paths_do_not_parse_as_regular_sessions() {
    assert!(session_path_from_path("/api/sessions/shared/token-1").is_none());
    let shared = shared_session_path_from_path("/api/sessions/shared/token-1/attachments/a1")
        .expect("shared path should parse");
    assert_eq!(shared.token, "token-1");
    assert_eq!(shared.tail, Some("attachments/a1"));
}

#[test]
fn websocket_origin_check_allows_local_and_rejects_cross_site() {
    let allowed = parse_request_head(
        b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4173\r\n\r\n",
    )
    .expect("request should parse");
    assert!(origin_allowed(&allowed));

    let packaged_origin = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost:8080\r\nOrigin: http://localhost:8080\r\n\r\n",
        )
        .expect("request should parse");
    assert!(origin_allowed(&packaged_origin));

    let rejected = parse_request_head(
        b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\n\r\n",
    )
    .expect("request should parse");
    assert!(!origin_allowed(&rejected));
}

#[tokio::test]
async fn allowed_request_origin_is_echoed_in_cors_response_headers() {
    let head = parse_request_head(
        b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:3000\r\n\r\n",
    )
    .expect("request should parse");

    let response = with_response_cors_origin(requested_cors_origin(&head), async {
        response(200, "application/json", b"{}")
    })
    .await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Access-Control-Allow-Origin: http://localhost:3000\r\n"));
    assert!(!response.contains("Access-Control-Allow-Origin: http://localhost:4173\r\n"));
}

#[tokio::test]
async fn cors_response_allows_platform_organization_header() {
    let response = with_response_cors_origin("http://localhost:3000".to_string(), async {
        response(204, "text/plain; charset=utf-8", &[])
    })
    .await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("x-organization-id"));
    assert!(response.contains("x-a2a-notification-token"));
}

#[test]
fn chat_body_limit_allows_base64_attachments() {
    const {
        assert!(MAX_JSON_BODY_BYTES >= 32 * 1024 * 1024);
        assert!(MAX_EXTRACT_JSON_BODY_BYTES > (MAX_EXTRACT_INPUT_BYTES * 4 / 3));
    }
}

#[test]
fn detects_chat_websocket_route_separately_from_sse() {
    let head = parse_request_head(b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .expect("request should parse");

    assert!(is_chat_websocket_endpoint(&head));
    assert!(!is_chat_endpoint(&head));
}

#[test]
fn computes_websocket_accept_key() {
    assert_eq!(
        websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

#[test]
fn parses_masked_websocket_text_frame() {
    let payload = br#"{"messages":[]}"#;
    let mask = [0x37, 0xfa, 0x21, 0x3d];
    let mut frame = vec![0x81, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % mask.len()]);
    }

    let parsed = try_parse_websocket_text_message(&mut frame)
        .expect("frame should parse")
        .expect("frame should be complete");

    assert_eq!(parsed, payload);
    assert!(frame.is_empty());
}

#[test]
fn parses_fragmented_masked_websocket_text_frame() {
    let first = br#"{"messages":"#;
    let second = br#"[]}"#;
    let mask = [0x37, 0xfa, 0x21, 0x3d];
    let mut frame = vec![0x01, 0x80 | first.len() as u8];
    frame.extend_from_slice(&mask);
    for (index, byte) in first.iter().enumerate() {
        frame.push(byte ^ mask[index % mask.len()]);
    }
    frame.extend_from_slice(&[0x80, 0x80 | second.len() as u8]);
    frame.extend_from_slice(&mask);
    for (index, byte) in second.iter().enumerate() {
        frame.push(byte ^ mask[index % mask.len()]);
    }

    let parsed = try_parse_websocket_text_message(&mut frame)
        .expect("fragmented frame should parse")
        .expect("fragmented frame should be complete");

    assert_eq!(parsed, br#"{"messages":[]}"#);
    assert!(frame.is_empty());
}

#[test]
fn pending_request_resume_maps_approval_and_tool_results() {
    let approval = pending_request_resume_value(
        "approval-1",
        &serde_json::json!({ "kind": "approval", "decision": "denied" }),
    );
    assert_eq!(
        approval
            .pointer("/request/resolution")
            .and_then(Value::as_str),
        Some("denied")
    );

    let tool = pending_request_resume_value(
        "tool-1",
        &serde_json::json!({ "content": [], "isError": true }),
    );
    assert_eq!(
        tool.pointer("/request/kind").and_then(Value::as_str),
        Some("client_tool")
    );
    assert_eq!(
        tool.pointer("/request/resolution").and_then(Value::as_str),
        Some("failed")
    );

    let (approved, result) = pending_tool_response_from_payload(
        &serde_json::json!({ "kind": "approval", "decision": "denied" }),
    );
    assert!(!approved);
    assert!(result.is_none());

    let (approved, result) =
        pending_tool_response_from_payload(&serde_json::json!({ "content": "ok" }));
    assert!(approved);
    assert_eq!(result.expect("tool result").output, "ok");
}

#[test]
fn composer_content_preserves_non_text_blocks() {
    let content = serde_json::json!([
        { "type": "text", "text": "hello" },
        { "type": "tool_result", "toolUseId": "tool-1", "content": "world" }
    ]);
    let rendered = composer_text_content(&content);

    assert!(rendered.contains("hello"));
    assert!(rendered.contains("tool_result"));
    assert!(rendered.contains("tool-1"));
}

#[test]
fn resolves_provider_model_ids() {
    let registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };
    let model = resolve_model("openai/gpt-5.1-codex-max", &registry).expect("model should resolve");

    assert_eq!(model.provider, "openai");
    assert_eq!(model.id, "gpt-5.1-codex-max");
    assert_eq!(model.api, "openai-responses");

    let codex_app_server = resolve_model("openai-codex/gpt-5.1-codex-max", &registry)
        .expect("codex app-server model should resolve");
    assert_eq!(codex_app_server.provider, "openai-codex");
    assert_eq!(codex_app_server.id, "gpt-5.1-codex-max");
    assert_eq!(codex_app_server.api, "openai-codex-app-server");
}

#[test]
fn resolves_configured_models_and_aliases() {
    let config = serde_json::json!({
        "aliases": { "fast": "local/llama-fast" },
        "providers": [{
            "id": "local",
            "name": "Local",
            "api": "openai-responses",
            "models": [{
                "id": "llama-fast",
                "name": "Llama Fast",
                "reasoning": false,
                "input": ["text", "image"],
                "contextWindow": 8192,
                "maxTokens": 2048,
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0
                }
            }]
        }]
    });
    let mut registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };
    merge_configured_models(&mut registry, &config);

    let model = resolve_model("fast", &registry).expect("alias should resolve");

    assert_eq!(model.provider, "local");
    assert_eq!(model.id, "llama-fast");
    assert!(model.capabilities.vision);
}

#[test]
fn merges_platform_model_catalog_from_llm_gateway_payload() {
    let catalog = serde_json::json!({
        "data": [{
            "id": "openai",
            "models": [{
                "id": "gpt-5.1-codex-max",
                "name": "GPT-5.1 Codex Max",
                "provider": "openai",
                "pricing": {
                    "input": 1.25,
                    "output": 10.0
                },
                "capabilities": {
                    "context_length": 400000,
                    "max_tokens": 128000,
                    "supports_streaming": true,
                    "supports_functions": true,
                    "supports_vision": true
                },
                "supports_reasoning": true
            }]
        }],
        "external_providers": [{
            "id": "together-ai",
            "models": [{
                "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "name": "Llama 3.3 70B Instruct Turbo",
                "reasoning": false,
                "tool_call": true,
                "cost": {
                    "input": 0.88,
                    "output": 0.88,
                    "cache_read": 0.0,
                    "cache_write": 0.0
                },
                "limit": {
                    "context": 131072,
                    "output": 4096
                },
                "modalities": {
                    "input": ["text", "image"],
                    "output": ["text"]
                }
            }]
        }]
    });
    let mut registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };

    merge_llm_gateway_model_catalog(&mut registry, &catalog);

    let codex = resolve_model("openai/gpt-5.1-codex-max", &registry).expect("codex model");
    assert_eq!(codex.max_tokens, 128_000);
    assert_eq!(codex.api, "openai-responses");
    assert!(codex.capabilities.reasoning);

    let codex_app_server =
        resolve_model("openai-codex/gpt-5.5", &registry).expect("codex app-server model");
    assert_eq!(codex_app_server.api, "openai-codex-app-server");
    assert_eq!(codex_app_server.max_tokens, 128_000);

    let llama = resolve_model(
        "together-ai/meta-llama/Llama-3.3-70B-Instruct-Turbo",
        &registry,
    )
    .expect("external model");
    assert_eq!(llama.context_window, 131_072);
    assert!(llama.capabilities.vision);
    assert_eq!(llama.cost.input, 0.88);
}

#[test]
fn merges_openrouter_model_catalog_payload() {
    let catalog = serde_json::json!({
        "data": [{
            "id": "anthropic/claude-sonnet-4.5",
            "name": "Anthropic: Claude Sonnet 4.5",
            "context_length": 200000,
            "architecture": {
                "input_modalities": ["text", "image"],
                "output_modalities": ["text"]
            },
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000015",
                "input_cache_read": "0.0000003",
                "input_cache_write": "0.00000375"
            },
            "top_provider": {
                "context_length": 200000,
                "max_completion_tokens": 64000,
                "is_moderated": true
            },
            "supported_parameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "tool_choice",
                "tools"
            ]
        }]
    });
    let mut registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };

    merge_llm_gateway_model_catalog(&mut registry, &catalog);
    let model = resolve_model("openrouter/anthropic/claude-sonnet-4.5", &registry)
        .expect("openrouter model should resolve");

    assert_eq!(model.provider, "openrouter");
    assert_eq!(model.id, "anthropic/claude-sonnet-4.5");
    assert_eq!(model.api, "openai-completions");
    assert_eq!(model.context_window, 200_000);
    assert_eq!(model.max_tokens, 64_000);
    assert!(model.capabilities.vision);
    assert!(model.capabilities.tools);
    assert!(model.capabilities.reasoning);
    assert_eq!(model.cost.input, 0.000003);
    assert_eq!(model.cost.cache_write, 0.00000375);
}

#[test]
fn default_model_handles_empty_registry() {
    let registry = ModelRegistry {
        models: Vec::new(),
        aliases: HashMap::new(),
    };

    let model = default_model_from_registry(&registry);

    assert_eq!(model.provider, "openai-codex");
    assert_eq!(model.id, "gpt-5.5");
    assert_eq!(model.api, "openai-codex-app-server");
}

#[test]
fn head_response_keeps_get_content_length_without_body() {
    let response =
        response_with_cache_and_length(200, "text/plain; charset=utf-8", &[], 60, "hello".len());
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Content-Length: 5\r\n"));
    assert!(response.ends_with("\r\n\r\n"));
}

#[test]
#[should_panic(expected = "response Content-Length 10 does not match body length 5")]
fn response_with_length_rejects_nonempty_body_length_mismatch() {
    let _response = response_with_extra_headers_and_length(200, "text/plain", b"hello", "", 10);
}

#[test]
fn parse_git_status_counts_both_porcelain_columns() {
    let status = parse_git_status(
            " M unstaged.txt\nM  staged.txt\nMM both.txt\nAM added_modified.txt\nD  staged_delete.txt\n D worktree_delete.txt\n R renamed.txt\n C copied.txt\nUU conflicted.txt\n?? new.txt\n",
        );

    assert_eq!(status.modified, 5);
    assert_eq!(status.added, 3);
    assert_eq!(status.deleted, 2);
    assert_eq!(status.untracked, 1);
    assert_eq!(status.total, 10);
}

#[test]
fn json_response_has_header_body_separator() {
    let response = json_response(200, &serde_json::json!({ "ok": true }));

    assert!(response.windows(4).any(|window| window == b"\r\n\r\n"));
    let response = String::from_utf8(response).expect("response should be utf-8");
    assert!(response.contains("x-composer-csrf"));
    assert!(response.contains("x-maestro-artifact-access"));
}

#[test]
fn json_response_uses_conflict_reason_phrase() {
    let response = json_response(409, &serde_json::json!({ "error": "Conflict" }));
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.starts_with("HTTP/1.1 409 Conflict\r\n"));
}

#[tokio::test]
async fn response_cors_origin_matches_allowed_request_origin() {
    let head = parse_request_head(
        b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nOrigin: http://127.0.0.1:5173\r\n\r\n",
    )
    .expect("request should parse");
    let response = with_response_cors_origin(requested_cors_origin(&head), async {
        json_response(200, &serde_json::json!({ "ok": true }))
    })
    .await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Access-Control-Allow-Origin: http://127.0.0.1:5173\r\n"));
    assert!(response.contains("Access-Control-Allow-Credentials: true\r\n"));
    assert!(response.contains("Vary: Origin\r\n"));
}

#[tokio::test]
async fn sse_headers_vary_by_request_origin() {
    let head = parse_request_head(
        b"GET /api/chat HTTP/1.1\r\nHost: localhost\r\nOrigin: http://127.0.0.1:5173\r\n\r\n",
    )
    .expect("request should parse");
    let response =
        with_response_cors_origin(requested_cors_origin(&head), async { sse_headers() }).await;

    assert!(response.contains("Access-Control-Allow-Origin: http://127.0.0.1:5173\r\n"));
    assert!(response.contains("Vary: Origin\r\n"));
}

#[tokio::test]
async fn wildcard_cors_origin_omits_credentials_header() {
    let response = with_response_cors_origin("*".to_string(), async {
        json_response(200, &serde_json::json!({ "ok": true }))
    })
    .await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
    assert!(!response.contains("Access-Control-Allow-Credentials: true\r\n"));
}

#[test]
fn wildcard_web_origin_allows_websocket_origins() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous = env::var_os("MAESTRO_WEB_ORIGIN");
    env::set_var("MAESTRO_WEB_ORIGIN", "*");
    let head = parse_request_head(
        b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: https://app.example.com\r\n\r\n",
    )
    .expect("request should parse");

    assert!(origin_allowed(&head));

    if let Some(previous) = previous {
        env::set_var("MAESTRO_WEB_ORIGIN", previous);
    } else {
        env::remove_var("MAESTRO_WEB_ORIGIN");
    }
}

#[test]
fn openrouter_catalog_requires_explicit_configuration() {
    let _guard = ENV_LOCK.blocking_lock();
    let vars = [
        "MAESTRO_LLM_GATEWAY_MODELS_URL",
        "MAESTRO_LLM_GATEWAY_URL",
        "MAESTRO_OPENROUTER_MODELS_URL",
        "MAESTRO_ENABLE_OPENROUTER_MODELS",
        "MAESTRO_OPENROUTER_API_KEY",
        "OPENROUTER_API_KEY",
    ];
    let previous = vars.map(|name| (name, env::var_os(name)));
    for name in vars {
        env::remove_var(name);
    }

    assert!(llm_gateway_models_url().is_none());

    env::set_var("MAESTRO_ENABLE_OPENROUTER_MODELS", "1");
    assert_eq!(
        llm_gateway_models_url().as_deref(),
        Some("https://openrouter.ai/api/v1/models")
    );

    env::set_var("MAESTRO_ENABLE_OPENROUTER_MODELS", "0");
    assert!(llm_gateway_models_url().is_none());

    env::set_var("MAESTRO_OPENROUTER_API_KEY", "key");
    assert_eq!(
        llm_gateway_models_url().as_deref(),
        Some("https://openrouter.ai/api/v1/models")
    );

    for (name, value) in previous {
        if let Some(value) = value {
            env::set_var(name, value);
        } else {
            env::remove_var(name);
        }
    }
}

#[test]
fn chat_prompt_preserves_structured_history() {
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: None,
        messages: vec![
            ChatMessage {
                role: "assistant".to_string(),
                content: Value::String("I can inspect that.".to_string()),
                attachments: Vec::new(),
                extra: {
                    let mut extra = Map::new();
                    extra.insert(
                        "tools".to_string(),
                        serde_json::json!([{ "id": "call-1", "name": "read_file" }]),
                    );
                    extra
                },
            },
            ChatMessage {
                role: "user".to_string(),
                content: serde_json::json!([
                    { "type": "text", "text": "What about this image?" },
                    { "type": "image", "url": "attachment://att-1" }
                ]),
                attachments: vec![ChatAttachment {
                    id: Some("att-1".to_string()),
                    attachment_type: Some("image".to_string()),
                    file_name: Some("screen.png".to_string()),
                    mime_type: Some("image/png".to_string()),
                    content: None,
                    content_omitted: Some(true),
                    extracted_text: None,
                }],
                extra: Map::new(),
            },
        ],
    };

    let prompt = build_prompt_from_chat(&chat);

    assert!(prompt.contains("\"tools\""));
    assert!(prompt.contains("\"type\": \"image\""));
    assert!(prompt.contains("\"attachments\""));
}

#[test]
fn spa_entry_response_uses_no_store() {
    let response =
        response_with_no_store_and_length(200, "text/html; charset=utf-8", &[], "index".len());
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Content-Length: 5\r\n"));
    assert!(response.contains("Cache-Control: no-store, no-cache, must-revalidate\r\n"));
}

#[test]
fn runtime_config_script_serializes_csrf_without_api_key() {
    let mut config = auth_test_config();
    config.csrf_token = Some("csrf\"token".to_string());

    let script = String::from_utf8(runtime_config_script(&config)).expect("script should be utf-8");

    assert!(!script.contains("api-key"));
    assert!(script.contains("delete window.__MAESTRO_API_KEY__;"));
    assert!(script.contains("window.__MAESTRO_CSRF_TOKEN__ = \"csrf\\\"token\";"));
}

#[test]
fn runtime_config_head_reports_script_length_without_body() {
    let mut config = auth_test_config();
    config.csrf_token = Some("csrf-token".to_string());
    let head = RequestHead {
        method: "HEAD".to_string(),
        path: RUNTIME_CONFIG_SCRIPT_PATH.to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let expected_length = runtime_config_script(&config).len();

    let response = runtime_config_response(&head, &config);
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains("Content-Type: application/javascript; charset=utf-8\r\n"));
    assert!(response.contains(&format!("Content-Length: {expected_length}\r\n")));
    assert!(response.ends_with("\r\n\r\n"));
}

#[tokio::test]
async fn spa_entry_injects_runtime_config_script_when_browser_auth_configured() {
    let root = TestDir::new("runtime-config-spa");
    let index = "<html><head><title>Maestro</title></head><body>ok</body></html>";
    fs::write(root.path().join("index.html"), index).expect("index should be written");
    let mut config = auth_test_config();
    config.static_root = root.path().to_path_buf();
    config.csrf_token = Some("csrf-token".to_string());
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");
    let body = response_body_text(&response);

    assert!(body.contains(RUNTIME_CONFIG_SCRIPT_TAG));
    assert!(body.contains("</head><body>ok</body>"));
    assert!(!body.contains("window.__MAESTRO_API_KEY__ ="));
    assert!(response.contains(&format!(
        "Set-Cookie: {RUNTIME_SESSION_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Lax\r\n",
        runtime_session_api_key_cookie_value(&config).expect("cookie should be available")
    )));
    assert!(response.contains(&format!("Content-Length: {}\r\n", body.len())));
}

#[test]
fn runtime_session_cookie_authorizes_same_origin_browser_requests() {
    let config = auth_test_config();
    let cookie = runtime_session_cookie_value(&config, "jonathan@evalops.dev")
        .expect("cookie should be available");
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([(
            "cookie".to_string(),
            format!("theme=dark; {RUNTIME_SESSION_COOKIE_NAME}={cookie}; other=value"),
        )]),
    };

    let context = auth_context(&head, &config).expect("cookie should authorize request");

    assert!(!context.unrestricted);
    assert_eq!(context.subject.as_deref(), Some("jonathan@evalops.dev"));
}

#[test]
fn bearer_token_identity_wins_over_runtime_session_cookie() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
    env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
    let config = auth_test_config();
    let cookie =
        runtime_session_cookie_value(&config, "cookie-user").expect("cookie should be available");
    let bearer_user = "bearer-user";
    let signature = hmac_sha256_hex(b"shared-secret", bearer_user.as_bytes());
    let token = format!("{}.{}", URL_SAFE_NO_PAD.encode(bearer_user), signature);
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([
            ("authorization".to_string(), format!("Bearer {token}")),
            (
                "cookie".to_string(),
                format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
            ),
        ]),
    };

    let context = auth_context(&head, &config).expect("bearer token should authorize");

    assert_eq!(context.subject.as_deref(), Some(bearer_user));
    assert!(!context.unrestricted);

    if let Some(previous) = previous {
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous);
    } else {
        env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
    }
}

#[test]
fn loopback_api_key_runtime_session_cookie_keeps_legacy_unrestricted_access() {
    let config = auth_test_config();
    let cookie = runtime_session_api_key_cookie_value(&config).expect("cookie should be available");
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/sessions".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([(
            "cookie".to_string(),
            format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
        )]),
    };

    let context = auth_context(&head, &config).expect("api-key cookie should authorize");

    assert!(context.subject.is_none());
    assert!(context.unrestricted);
}

#[test]
fn scoped_runtime_session_cookie_for_api_key_sentinel_subject_stays_scoped() {
    let config = auth_test_config();
    let subject = "api-key:unrestricted";
    let cookie =
        runtime_session_cookie_value(&config, subject).expect("cookie should be available");
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/sessions".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([(
            "cookie".to_string(),
            format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
        )]),
    };

    let context = auth_context(&head, &config).expect("scoped cookie should authorize");

    assert_eq!(context.subject.as_deref(), Some(subject));
    assert!(!context.unrestricted);
}

#[test]
fn trusted_proxy_auth_requires_shared_proxy_token() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous = env::var_os("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
    env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
    let config = auth_test_config();
    let spoofed = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([(
            "x-auth-request-email".to_string(),
            "jonathan@evalops.dev".to_string(),
        )]),
    };
    let trusted = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([
            (
                "x-auth-request-email".to_string(),
                "jonathan@evalops.dev".to_string(),
            ),
            (
                "x-maestro-proxy-auth".to_string(),
                "proxy-secret".to_string(),
            ),
        ]),
    };

    assert!(auth_context(&spoofed, &config).is_none());
    let context = auth_context(&trusted, &config).expect("proxy token should authorize");
    assert_eq!(context.subject.as_deref(), Some("jonathan@evalops.dev"));
    assert!(!context.unrestricted);

    if let Some(previous) = previous {
        env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", previous);
    } else {
        env::remove_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
    }
}

#[test]
fn trusted_proxy_token_counts_as_configured_auth() {
    let _guard = ENV_LOCK.blocking_lock();
    let previous = env::var_os("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
    env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
    let mut config = auth_test_config();
    config.api_key = None;
    config.require_key = false;
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    assert!(auth_context(&head, &config).is_none());

    if let Some(previous) = previous {
        env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", previous);
    } else {
        env::remove_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
    }
}

#[test]
fn web_auth_mode_matrix_pins_control_plane_access() {
    let _guard = ENV_LOCK.blocking_lock();
    let preserved_env: Vec<_> = [
        "MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN",
        "MAESTRO_AUTH_SHARED_SECRET",
        "MAESTRO_JWT_SECRET",
        "MAESTRO_JWT_JWKS_URL",
    ]
    .iter()
    .map(|name| (*name, env::var_os(name)))
    .collect();
    for (name, _) in &preserved_env {
        env::remove_var(name);
    }

    let api_key_config = auth_test_config();
    let mut open_dev_config = auth_test_config();
    open_dev_config.api_key = None;
    open_dev_config.require_key = false;
    let scoped_cookie = runtime_session_cookie_value(&api_key_config, "web-user")
        .expect("scoped cookie should be available");
    let api_key_cookie = runtime_session_api_key_cookie_value(&api_key_config)
        .expect("api-key cookie should be available");

    struct AuthMatrixCase {
        name: &'static str,
        config: Config,
        headers: HashMap<String, String>,
        expected_subject: Option<&'static str>,
        expected_unrestricted: Option<bool>,
    }

    let cases = vec![
        AuthMatrixCase {
            name: "open local dev when no auth is configured",
            config: open_dev_config.clone(),
            headers: HashMap::new(),
            expected_subject: None,
            expected_unrestricted: Some(true),
        },
        AuthMatrixCase {
            name: "api key configured rejects anonymous requests",
            config: api_key_config.clone(),
            headers: HashMap::new(),
            expected_subject: None,
            expected_unrestricted: None,
        },
        AuthMatrixCase {
            name: "api key header grants unrestricted loopback access",
            config: api_key_config.clone(),
            headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
            expected_subject: None,
            expected_unrestricted: Some(true),
        },
        AuthMatrixCase {
            name: "bearer api key grants unrestricted loopback access",
            config: api_key_config.clone(),
            headers: HashMap::from([("authorization".to_string(), "Bearer api-key".to_string())]),
            expected_subject: None,
            expected_unrestricted: Some(true),
        },
        AuthMatrixCase {
            name: "scoped runtime session cookie stays subject-scoped",
            config: api_key_config.clone(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("{RUNTIME_SESSION_COOKIE_NAME}={scoped_cookie}"),
            )]),
            expected_subject: Some("web-user"),
            expected_unrestricted: Some(false),
        },
        AuthMatrixCase {
            name: "legacy api-key runtime session cookie stays unrestricted",
            config: api_key_config.clone(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("{RUNTIME_SESSION_COOKIE_NAME}={api_key_cookie}"),
            )]),
            expected_subject: None,
            expected_unrestricted: Some(true),
        },
    ];

    for case in cases {
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: case.headers,
        };
        let context = auth_context(&head, &case.config);
        match case.expected_unrestricted {
            Some(unrestricted) => {
                let context = context.unwrap_or_else(|| {
                    panic!("{} should authorize", case.name);
                });
                assert_eq!(
                    context.subject.as_deref(),
                    case.expected_subject,
                    "{} subject",
                    case.name
                );
                assert_eq!(
                    context.unrestricted, unrestricted,
                    "{} unrestricted",
                    case.name
                );
            }
            None => assert!(context.is_none(), "{} should reject", case.name),
        }
    }

    env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
    let bearer_user = "bearer-user";
    let signature = hmac_sha256_hex(b"shared-secret", bearer_user.as_bytes());
    let bearer = format!("{}.{}", URL_SAFE_NO_PAD.encode(bearer_user), signature);
    let bearer_head = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([("authorization".to_string(), format!("Bearer {bearer}"))]),
    };
    let bearer_context =
        auth_context(&bearer_head, &open_dev_config).expect("bearer should authorize");
    assert_eq!(bearer_context.subject.as_deref(), Some(bearer_user));
    assert!(!bearer_context.unrestricted);

    env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
    env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
    let proxy_head = RequestHead {
        method: "GET".to_string(),
        path: "/api/status".to_string(),
        query: HashMap::new(),
        headers: HashMap::from([
            (
                "x-auth-request-email".to_string(),
                "proxy-user@evalops.dev".to_string(),
            ),
            (
                "x-maestro-proxy-auth".to_string(),
                "proxy-secret".to_string(),
            ),
        ]),
    };
    let proxy_context =
        auth_context(&proxy_head, &open_dev_config).expect("proxy should authorize");
    assert_eq!(
        proxy_context.subject.as_deref(),
        Some("proxy-user@evalops.dev")
    );
    assert!(!proxy_context.unrestricted);

    for (name, value) in preserved_env {
        if let Some(value) = value {
            env::set_var(name, value);
        } else {
            env::remove_var(name);
        }
    }
}

#[tokio::test]
async fn loopback_api_key_web_first_load_requires_authenticated_cookie_issuer() {
    let root = TestDir::new("runtime-config-spa-loopback-api-key");
    fs::write(root.path().join("index.html"), "<html><head></head></html>")
        .expect("index should be written");
    let mut config = auth_test_config();
    config.static_root = root.path().to_path_buf();
    config.listen_host = "127.0.0.1".to_string();
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(!response.contains("Set-Cookie: maestro_web_session="));
}

#[tokio::test]
async fn spa_entry_does_not_mint_session_cookie_without_authenticated_issuer() {
    let root = TestDir::new("runtime-config-spa-unauth");
    fs::write(root.path().join("index.html"), "<html><head></head></html>")
        .expect("index should be written");
    let mut config = auth_test_config();
    config.static_root = root.path().to_path_buf();
    config.listen_host = "0.0.0.0".to_string();
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(!response.contains("Set-Cookie: maestro_web_session="));
}

#[tokio::test]
async fn spa_entry_head_uses_injected_body_length() {
    let root = TestDir::new("runtime-config-spa-head");
    let index = "<html><head></head><body>ok</body></html>";
    fs::write(root.path().join("index.html"), index).expect("index should be written");
    let mut config = auth_test_config();
    config.static_root = root.path().to_path_buf();
    let expected_length = spa_entry_body(index.as_bytes(), &config).len();
    let head = RequestHead {
        method: "HEAD".to_string(),
        path: "/".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.contains(&format!("Content-Length: {expected_length}\r\n")));
    assert!(response.ends_with("\r\n\r\n"));
}

#[tokio::test]
async fn spa_entry_without_browser_auth_does_not_inject_runtime_config() {
    let root = TestDir::new("runtime-config-spa-disabled");
    let index = "<html><head></head><body>ok</body></html>";
    fs::write(root.path().join("index.html"), index).expect("index should be written");
    let mut config = auth_test_config();
    config.static_root = root.path().to_path_buf();
    config.api_key = None;
    config.csrf_token = None;
    let head = RequestHead {
        method: "GET".to_string(),
        path: "/".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(!response.contains(RUNTIME_CONFIG_SCRIPT_PATH));
    assert!(response.contains(index));
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_static_path_rejects_symlink_escape() {
    let base = env::temp_dir().join(format!(
        "maestro-static-test-{}-{}",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let root = base.join("static");
    let outside = base.join("outside");
    tokio::fs::create_dir_all(&root).await.expect("create root");
    tokio::fs::create_dir_all(&outside)
        .await
        .expect("create outside");
    tokio::fs::write(outside.join("secret.txt"), "secret")
        .await
        .expect("write secret");
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("secret.txt"))
        .expect("create symlink");

    assert!(matches!(
        canonical_static_path(&root, &root.join("secret.txt")).await,
        StaticPathResolution::Forbidden
    ));

    let _ = tokio::fs::remove_dir_all(base).await;
}

#[test]
fn missing_asset_paths_do_not_spa_fallback() {
    let asset = RequestHead {
        method: "GET".to_string(),
        path: "/assets/app.js".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let route = RequestHead {
        method: "GET".to_string(),
        path: "/settings".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };

    assert!(!should_spa_fallback(&asset));
    assert!(should_spa_fallback(&route));
}

#[test]
fn prepared_attachments_drop_removes_temp_dir() {
    let dir = env::temp_dir().join(format!(
        "maestro-attachment-drop-test-{}-{}",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(dir.join("file.txt"), "contents").expect("write temp file");

    drop(PreparedAttachments {
        paths: Vec::new(),
        temp_dir: Some(dir.clone()),
    });

    assert!(!dir.exists());
}

#[test]
fn emergency_default_model_is_available_without_registry_entries() {
    let model = emergency_default_model();

    assert_eq!(model.provider, "openai-codex");
    assert_eq!(model.id, "gpt-5.5");
    assert_eq!(model.api, "openai-codex-app-server");
}

#[test]
fn action_body_rejects_missing_or_unknown_actions() {
    assert_eq!(
        parse_action_body(br#"{"action":"reset"}"#, &["on", "off", "reset"])
            .expect("reset should parse"),
        "reset"
    );
    assert!(parse_action_body(br#"{}"#, &["on", "off", "reset"]).is_err());
    assert!(parse_action_body(br#"{"action":"maybe"}"#, &["on", "off", "reset"]).is_err());
}

#[test]
fn training_on_maps_to_opted_in() {
    let status = training_status(Some(false));

    assert_eq!(
        status.get("preference").and_then(Value::as_str),
        Some("opted-in")
    );
    assert_eq!(status.get("optOut").and_then(Value::as_bool), Some(false));
}

#[test]
fn telemetry_flag_accepts_common_truthy_values() {
    for value in ["1", "true", "TRUE", "True", "yes", "YES", "on", "On"] {
        assert!(
            telemetry_enabled(None, Some(value), false, false),
            "{value} should enable telemetry"
        );
    }
}

#[test]
fn telemetry_explicit_false_overrides_endpoint_and_file_configuration() {
    for value in ["0", "false", "FALSE", "False", "no", "NO", "off", "Off"] {
        assert!(
            !telemetry_enabled(None, Some(value), true, true),
            "{value} should disable telemetry"
        );
    }
}

#[test]
fn resolves_missing_static_paths_within_root() {
    let root = TestDir::new("static-root");
    fs::write(root.path().join("index.html"), "<html></html>").expect("index should be written");

    let resolved =
        resolve_static_path(root.path(), "/assets/app.js").expect("path should stay in root");

    assert_eq!(resolved, root.path().join("assets/app.js"));
}

#[cfg(unix)]
#[test]
fn rejects_static_paths_that_escape_through_symlinks() {
    let root = TestDir::new("static-root");
    let outside = TestDir::new("outside-root");
    let escape = root.path().join("escape");
    fs::write(root.path().join("index.html"), "<html></html>").expect("index should be written");
    fs::write(outside.path().join("secret.txt"), "secret").expect("secret should be written");
    std::os::unix::fs::symlink(outside.path(), &escape).expect("symlink should be created");

    assert!(resolve_static_path(root.path(), "/escape/secret.txt").is_none());
}

#[test]
fn validates_run_script_inputs() {
    assert!(is_valid_script_name("build:all"));
    assert!(!is_valid_script_name("build && rm -rf /"));
    assert!(contains_shell_metachars("foo; bar"));
    assert!(!contains_shell_metachars("--filter packages/web"));
}

#[test]
fn keeps_attachment_only_prompt_non_empty() {
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: None,
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String(String::new()),
            attachments: vec![ChatAttachment {
                id: Some("att-1".to_string()),
                attachment_type: Some("image".to_string()),
                file_name: Some("screen.png".to_string()),
                mime_type: Some("image/png".to_string()),
                content: Some("aGVsbG8=".to_string()),
                content_omitted: None,
                extracted_text: None,
            }],
            extra: Map::new(),
        }],
    };

    let prompt = build_prompt_from_chat(&chat);

    assert!(prompt.contains("screen.png"));
    assert!(!prompt.trim().is_empty());
}

#[tokio::test]
async fn prepared_attachments_drop_cleans_temp_dir() {
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: None,
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String("hello".to_string()),
            attachments: vec![ChatAttachment {
                id: Some("att-1".to_string()),
                attachment_type: Some("image".to_string()),
                file_name: Some("screen.png".to_string()),
                mime_type: Some("image/png".to_string()),
                content: Some("aGVsbG8=".to_string()),
                content_omitted: None,
                extracted_text: None,
            }],
            extra: Map::new(),
        }],
    };

    let cwd = TestDir::new("attachment-cwd");
    let attachments = prepare_chat_attachments(&chat, cwd.path())
        .await
        .expect("attachments should prepare");
    let temp_dir = attachments
        .temp_dir
        .clone()
        .expect("temp dir should be created");

    drop(attachments);

    assert!(!temp_dir.exists(), "temp dir should be removed on drop");
}

#[tokio::test]
async fn prepared_attachments_use_workspace_for_docker_sandbox() {
    let _guard = ENV_LOCK.lock().await;
    let cwd = TestDir::new("attachment-docker-cwd");
    let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
    env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", "docker");
    env::remove_var("MAESTRO_SANDBOX_MODE");
    let chat = ChatRequest {
        model: None,
        thinking_level: None,
        session_id: None,
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String("hello".to_string()),
            attachments: vec![ChatAttachment {
                id: Some("att-1".to_string()),
                attachment_type: Some("file".to_string()),
                file_name: Some("token.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
                content: Some("aGVsbG8=".to_string()),
                content_omitted: None,
                extracted_text: None,
            }],
            extra: Map::new(),
        }],
    };

    let attachments = prepare_chat_attachments(&chat, cwd.path())
        .await
        .expect("attachments should prepare");

    if let Some(previous) = previous_bridge {
        env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
    } else {
        env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
    }
    if let Some(previous) = previous_sandbox {
        env::set_var("MAESTRO_SANDBOX_MODE", previous);
    } else {
        env::remove_var("MAESTRO_SANDBOX_MODE");
    }

    let temp_dir = attachments
        .temp_dir
        .clone()
        .expect("temp dir should be created");
    assert!(temp_dir.starts_with(cwd.path()));
    assert!(attachments
        .paths
        .iter()
        .all(|path| Path::new(path).starts_with(cwd.path())));
}

#[tokio::test]
async fn missing_static_asset_returns_404_instead_of_index() {
    let static_root = unique_test_dir("maestro-static-asset");
    fs::create_dir_all(&static_root).expect("static root should exist");
    fs::write(static_root.join("index.html"), "<html>ok</html>").expect("index should exist");

    let head = RequestHead {
        method: "GET".to_string(),
        path: "/assets/app.js".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let config = Config {
        listen_host: "127.0.0.1".to_string(),
        listen_port: 8080,
        api_key: None,
        require_key: false,
        csrf_token: None,
        require_csrf: false,
        cwd: PathBuf::from("."),
        session_store_path: static_root.join("sessions.json"),
        command_prefs_path: static_root.join("command-prefs.json"),
        usage_file_path: static_root.join("usage.json"),
        a2a_tasks_file_path: static_root.join("a2a-tasks.json"),
        static_root: static_root.clone(),
        static_cache_max_age: 60,
        llm_gateway_models_url: None,
        llm_gateway_token: None,
        llm_gateway_org_id: None,
        llm_gateway_timeout_ms: 2_500,
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
    assert!(!response.contains("<html>ok</html>"));

    let _ = fs::remove_dir_all(static_root);
}

#[tokio::test]
async fn missing_spa_route_falls_back_to_index() {
    let static_root = unique_test_dir("maestro-static-spa");
    fs::create_dir_all(&static_root).expect("static root should exist");
    fs::write(static_root.join("index.html"), "<html>ok</html>").expect("index should exist");

    let head = RequestHead {
        method: "GET".to_string(),
        path: "/chat/session".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
    };
    let config = Config {
        listen_host: "127.0.0.1".to_string(),
        listen_port: 8080,
        api_key: None,
        require_key: false,
        csrf_token: None,
        require_csrf: false,
        cwd: PathBuf::from("."),
        session_store_path: static_root.join("sessions.json"),
        command_prefs_path: static_root.join("command-prefs.json"),
        usage_file_path: static_root.join("usage.json"),
        a2a_tasks_file_path: static_root.join("a2a-tasks.json"),
        static_root: static_root.clone(),
        static_cache_max_age: 60,
        llm_gateway_models_url: None,
        llm_gateway_token: None,
        llm_gateway_org_id: None,
        llm_gateway_timeout_ms: 2_500,
    };

    let response = static_response(&head, &config).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.contains("<html>ok</html>"));

    let _ = fs::remove_dir_all(static_root);
}

#[tokio::test]
async fn delete_session_subpath_returns_404_without_removing_session() {
    let root = TestDir::new("session-delete-subpath");
    let session_id = "session-1".to_string();
    let now = now_rfc3339();
    let session = SessionRecord {
        id: session_id.clone(),
        owner: None,
        title: "Test Session".to_string(),
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        favorite: None,
        tags: Vec::new(),
        messages: Vec::new(),
    };
    let state = AppState {
        config: Arc::new(Config {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 8080,
            api_key: Some("api-key".to_string()),
            require_key: true,
            csrf_token: None,
            require_csrf: false,
            cwd: PathBuf::from("."),
            session_store_path: root.path().join("sessions.json"),
            command_prefs_path: root.path().join("command-prefs.json"),
            usage_file_path: root.path().join("usage.json"),
            a2a_tasks_file_path: root.path().join("a2a-tasks.json"),
            static_root: root.path().to_path_buf(),
            static_cache_max_age: 60,
            llm_gateway_models_url: None,
            llm_gateway_token: None,
            llm_gateway_org_id: None,
            llm_gateway_timeout_ms: 2_500,
        }),
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(emergency_default_model())),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
        framework_preference: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(CommandPrefs {
            favorites: Vec::new(),
            recents: Vec::new(),
        })),
        sessions: Arc::new(Mutex::new(SessionStore {
            sessions: HashMap::from([(session_id.clone(), session)]),
            shared_sessions: HashMap::new(),
        })),
        session_store_persist_enabled: true,
        session_persist_lock: Arc::new(Mutex::new(())),
        usage_persist_lock: Arc::new(Mutex::new(())),
        shared_sessions: Arc::new(Mutex::new(HashMap::new())),
        approval_modes: Arc::new(Mutex::new(HashMap::new())),
        pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
        a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
        a2a_task_persist_lock: Arc::new(Mutex::new(())),
        a2a_task_events: broadcast::channel(256).0,
        a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
        a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
    };
    let (_client, mut server) = tcp_stream_pair().await;
    let head = RequestHead {
        method: "DELETE".to_string(),
        path: format!("/api/sessions/{session_id}/share"),
        query: HashMap::new(),
        headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
    };

    let response = handle_session_endpoint(&mut server, &mut Vec::new(), &head, &state).await;
    let response = String::from_utf8(response).expect("response should be utf-8");

    assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
    assert!(state
        .sessions
        .lock()
        .await
        .sessions
        .contains_key(&session_id));
}

#[tokio::test]
async fn invalid_session_store_is_left_untouched_and_future_writes_are_blocked() {
    let root = TestDir::new("invalid-session-store");
    let session_store_path = root.path().join("sessions.json");
    tokio::fs::write(&session_store_path, br#"{"sessions":"invalid"}"#)
        .await
        .expect("fixture should be written");

    let (store, persist_enabled) = load_session_store(&session_store_path).await;
    assert!(store.sessions.is_empty());
    assert!(!persist_enabled);

    let state = AppState {
        config: Arc::new(Config {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 8080,
            api_key: None,
            require_key: false,
            csrf_token: None,
            require_csrf: false,
            cwd: PathBuf::from("."),
            session_store_path: session_store_path.clone(),
            command_prefs_path: root.path().join("command-prefs.json"),
            usage_file_path: root.path().join("usage.json"),
            a2a_tasks_file_path: root.path().join("a2a-tasks.json"),
            static_root: root.path().to_path_buf(),
            static_cache_max_age: 60,
            llm_gateway_models_url: None,
            llm_gateway_token: None,
            llm_gateway_org_id: None,
            llm_gateway_timeout_ms: 2_500,
        }),
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(emergency_default_model())),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
        framework_preference: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(CommandPrefs {
            favorites: Vec::new(),
            recents: Vec::new(),
        })),
        sessions: Arc::new(Mutex::new(SessionStore {
            sessions: HashMap::from([("session-1".to_string(), test_session_record("session-1"))]),
            shared_sessions: HashMap::new(),
        })),
        session_store_persist_enabled: persist_enabled,
        session_persist_lock: Arc::new(Mutex::new(())),
        usage_persist_lock: Arc::new(Mutex::new(())),
        shared_sessions: Arc::new(Mutex::new(HashMap::new())),
        approval_modes: Arc::new(Mutex::new(HashMap::new())),
        pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
        a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
        a2a_task_persist_lock: Arc::new(Mutex::new(())),
        a2a_task_events: broadcast::channel(256).0,
        a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
        a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
    };

    persist_session_store(&state).await;

    let bytes = tokio::fs::read(&session_store_path)
        .await
        .expect("session store should still exist");
    assert_eq!(bytes, br#"{"sessions":"invalid"}"#);
}

#[test]
fn rejects_missing_request_target() {
    let request = b"GET\r\nHost: localhost\r\n\r\n";

    assert!(parse_request_head(request).is_err());
}

#[test]
fn approval_blocked_tool_event_uses_contract_tool_end_shape() {
    let event = approval_blocked_tool_event("call-1", "bash");

    assert_eq!(event["type"], "tool_execution_end");
    assert_eq!(event["toolCallId"], "call-1");
    assert_eq!(event["toolName"], "bash");
    assert_eq!(event["isError"], true);
    assert_eq!(event["result"]["isError"], true);
    assert_eq!(
        event["result"]["content"][0]["text"],
        "Tool execution blocked by approval mode"
    );
}

#[test]
fn failed_tool_metadata_is_marked_error_for_replay() {
    let mut tools = Vec::new();
    record_tool_call_metadata(&mut tools, "tool-1", "bash", serde_json::json!({}));

    finish_tool_metadata(&mut tools, "tool-1", false);

    assert_eq!(tools[0]["status"], "error");
    assert_eq!(tools[0]["result"]["isError"], true);
}

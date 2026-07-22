use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Days, Utc};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;
use uuid::Uuid;

const DEFAULT_AGENT_MCP_BASE_URL: &str = "https://app.evalops.dev";
const DEFAULT_IDENTITY_BASE_URL: &str = "https://identity.evalops.dev";
const AGENT_MCP_MANIFEST_PATH: &str = "/.well-known/evalops/agent-mcp.json";
const AGENT_MCP_PATH: &str = "/mcp";
const CALLBACK_PORT: u16 = 1460;
const CALLBACK_PATH: &str = "/auth/callback/evalops";
const REQUIRED_SCOPE: &str = "llm_gateway:invoke";
const DEFAULT_API_KEY_SCOPES: &[&str] = &[
    "agent:register",
    "agent:heartbeat",
    "governance:evaluate",
    "llm_gateway:invoke",
    "memories:read",
    "memories:write",
    "meter:record",
];
const DEFAULT_MAESTRO_CAPABILITIES: &[&str] = &[
    "maestro:init",
    "maestro:cli",
    "conversation:manage",
    "workflow:orchestrate",
    "code:write",
    "code:review",
    "code:test",
    "shell",
    "git",
    "fs",
    "mcp",
    "tool.use",
    "research",
    "responses:create",
];
const DEFAULT_AGENT_CAPABILITIES: &[&str] = &["mcp", "tool.use", "responses:create"];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct InitOptions {
    agent_type: Option<String>,
    api_key_scopes: Vec<String>,
    capabilities: Vec<String>,
    expires_in_days: Option<u64>,
    force_login: bool,
    integration_profile: Option<String>,
    json: bool,
    key_name: Option<String>,
    manifest_url: Option<String>,
    memory_mode: Option<String>,
    mcp_url: Option<String>,
    register_scopes: Vec<String>,
    rotate_key: bool,
    runtime_owner: Option<String>,
    shim_type: Option<String>,
    surface: Option<String>,
    trace_mode: Option<String>,
    ttl_seconds: Option<u64>,
    workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthCredentials {
    #[serde(rename = "type")]
    credential_type: String,
    refresh: String,
    access: String,
    expires: i64,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct OAuthClientRegistration {
    client_id: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenExchange {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
    scope: String,
    organization_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMcpMetadata {
    #[serde(rename = "type")]
    metadata_type: String,
    api_key: String,
    created_at: String,
    endpoint: String,
    registered_at: String,
    surface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    integration_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry_visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shim_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
}

#[derive(Debug, Clone)]
struct Endpoint {
    endpoint: String,
    identity_base_url: Option<String>,
    manifest_url: Option<String>,
    prefer_derived_identity: bool,
}

#[derive(Debug, Default, Clone)]
struct ApiKeyOutput {
    api_key: String,
    expires_at: Option<String>,
    key_id: Option<String>,
    name: Option<String>,
    prefix: Option<String>,
    scopes: Option<Vec<String>>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct RegisterOutput {
    agent_id: Option<String>,
    expires_at: Option<String>,
    integration_profile: Option<String>,
    memory_mode: Option<String>,
    registered: Option<bool>,
    registry_visible: Option<bool>,
    run_id: Option<String>,
    runtime_owner: Option<String>,
    scopes_granted: Option<Vec<String>>,
    shim_type: Option<String>,
    trace_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    api_key_created: bool,
    approval_policy_attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    authenticated_as: Option<String>,
    console_url: String,
    endpoint: String,
    evidence_event_published: bool,
    evidence_events: usize,
    governed_actions_loaded: u64,
    governed_inference_check_ran: bool,
    integration_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_url: Option<String>,
    memory_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry_visible: Option<bool>,
    risk_findings: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    runtime_owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes_granted: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_expires_at: Option<String>,
    shim_type: String,
    stored: bool,
    trace_ingestion_started: bool,
    trace_mode: String,
}

pub async fn run_init(args: &[String]) -> Result<i32> {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        println!("{}", help());
        return Ok(0);
    }
    let options = match parse_args(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error:#}");
            return Ok(1);
        }
    };
    let result = bootstrap(&options).await?;
    if options.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("{}", format_success(&result));
    }
    Ok(0)
}

fn help() -> &'static str {
    "maestro init\n  maestro init                         Login, create or reuse an API key, and register this agent\n  maestro init --rotate-key           Replace the stored agent MCP API key\n  maestro init --mcp-url <url>        Override the EvalOps agent MCP endpoint\n  maestro init --json                 Emit machine-readable bootstrap output\n\nOptions\n  --agent-type <type>                 Agent type to register, defaults to maestro\n  --surface <surface>                 Surface to register, defaults to cli\n  --integration-profile <profile>     mcp_only, mcp_otlp, managed_runtime, sdk_integrated, or provider_proxy\n  --shim-type <type>                  native_mcp, command_wrapper, hook, provider_proxy, sdk, or mcp_firewall_proxy\n  --trace-mode <mode>                 none, mcp_events, or otlp\n  --memory-mode <mode>                none, read_only, durable, or cerebro\n  --runtime-owner <owner>             external or evalops\n  --capability <cap[,cap...]>         Agent capability to declare; repeatable\n  --workspace, --workspace-id <id>    Workspace to associate with the registration\n  --scope <scope[,scope...]>          Registration scopes to request\n  --key-scope <scope[,scope...]>      API key scopes to request\n  --expires-in-days <days>            API key TTL in days\n  --force-login                       Re-run EvalOps OAuth before bootstrapping\n  --manifest-url <url>                Override the agent MCP manifest URL\n  --ttl-seconds <seconds>             Registration TTL in seconds"
}

fn parse_args(args: &[String]) -> Result<InitOptions> {
    let mut options = InitOptions::default();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let read = |index: usize| -> Result<String> {
            args.get(index + 1)
                .filter(|value| !value.starts_with('-'))
                .cloned()
                .ok_or_else(|| anyhow!("{flag} requires a value"))
        };
        match flag {
            "--agent-mcp-url" | "--mcp-url" => options.mcp_url = Some(read(index)?),
            "--agent-type" => options.agent_type = Some(read(index)?),
            "--api-key-scope" | "--key-scope" => {
                options.api_key_scopes.extend(split_list(&read(index)?));
            }
            "--capabilities" | "--capability" => {
                options.capabilities.extend(split_list(&read(index)?));
            }
            "--expires-in-days" => {
                options.expires_in_days = Some(positive_integer(&read(index)?, flag)?);
            }
            "--force-login" => {
                options.force_login = true;
                index += 1;
                continue;
            }
            "--integration-profile" => options.integration_profile = Some(read(index)?),
            "--json" => {
                options.json = true;
                index += 1;
                continue;
            }
            "--key-name" => options.key_name = Some(read(index)?),
            "--manifest-url" => options.manifest_url = Some(read(index)?),
            "--memory-mode" => options.memory_mode = Some(read(index)?),
            "--register-scope" | "--scope" => {
                options.register_scopes.extend(split_list(&read(index)?));
            }
            "--rotate-key" => {
                options.rotate_key = true;
                index += 1;
                continue;
            }
            "--runtime-owner" => options.runtime_owner = Some(read(index)?),
            "--shim-type" => options.shim_type = Some(read(index)?),
            "--surface" => options.surface = Some(read(index)?),
            "--trace-mode" => options.trace_mode = Some(read(index)?),
            "--ttl-seconds" => {
                options.ttl_seconds = Some(positive_integer(&read(index)?, flag)?);
            }
            "--workspace" | "--workspace-id" => options.workspace_id = Some(read(index)?),
            value if value.starts_with('-') => bail!("Unknown maestro init option: {value}"),
            value => bail!("Unexpected maestro init argument: {value}"),
        }
        index += 2;
    }
    Ok(options)
}

fn positive_integer(value: &str, flag: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow!("{flag} must be a positive integer"))
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

async fn bootstrap(options: &InitOptions) -> Result<InitResult> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("create EvalOps HTTP client")?;
    let loaded_credentials = if options.force_login {
        None
    } else {
        load_credentials()?
    };
    let mut credentials = if loaded_credentials
        .as_ref()
        .is_some_and(|credentials| can_reuse_stored_agent(options, credentials))
    {
        status(options, "Reusing stored EvalOps agent credentials");
        loaded_credentials.context("missing stored EvalOps credentials")?
    } else {
        ensure_login(options, &client).await?
    };
    let endpoint = resolve_endpoint(options, &client, &credentials).await?;
    let mut identity_base_url = resolve_identity_base_url(&endpoint, &credentials)?;
    let stored = stored_agent_mcp(&credentials);
    let now = Utc::now();

    let mut key_output = None;
    let mut api_key = if options.rotate_key {
        None
    } else {
        stored.as_ref().map(|stored| stored.api_key.clone())
    };
    let mut api_key_created = false;
    if api_key.is_none() {
        status(options, "Creating EvalOps agent API key");
        let created = create_api_key(
            options,
            &client,
            &identity_base_url,
            &credentials.access,
            now,
        )
        .await?;
        api_key = Some(created.api_key.clone());
        key_output = Some(created);
        api_key_created = true;
    } else {
        status(options, "Reusing stored EvalOps agent API key");
    }

    status(options, "Registering Maestro with EvalOps agent MCP");
    let mut agent_client = AgentMcpClient::connect(
        &endpoint.endpoint,
        api_key
            .as_deref()
            .context("missing EvalOps agent API key")?,
    )
    .await;
    if agent_client.is_err() && !api_key_created {
        status(
            options,
            "Stored EvalOps agent API key failed; rotating and retrying",
        );
        credentials = ensure_login(options, &client).await?;
        identity_base_url = resolve_identity_base_url(&endpoint, &credentials)?;
        let created = create_api_key(
            options,
            &client,
            &identity_base_url,
            &credentials.access,
            now,
        )
        .await?;
        api_key = Some(created.api_key.clone());
        key_output = Some(created);
        api_key_created = true;
        agent_client = AgentMcpClient::connect(
            &endpoint.endpoint,
            api_key.as_deref().context("missing rotated API key")?,
        )
        .await;
    }
    let mut agent_client = agent_client?;
    let register: RegisterOutput = agent_client
        .call_tool("evalops_register", register_args(options))
        .await
        .context("EvalOps agent registration failed")?;
    if register.registered != Some(true) || register.agent_id.as_deref().unwrap_or("").is_empty() {
        bail!("EvalOps agent registration did not return an agent_id");
    }

    status(options, "Running first governed inference check");
    let governed = match agent_client
        .call_tool::<Value>(
            "evalops_check_action",
            json!({
                "action_type": "llm_gateway.invoke",
                "action_payload": "maestro init first governed inference check",
                "declared_risk_level": "low"
            }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            status(
                options,
                &format!("EvalOps governed inference check unavailable; continuing bootstrap ({error:#})"),
            );
            json!({})
        }
    };
    status(options, "Loading EvalOps control-plane status");
    let summary = match agent_client
        .call_tool::<Value>("evalops_control_plane_summary", json!({}))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            status(
                options,
                &format!(
                    "EvalOps control-plane status unavailable; continuing bootstrap ({error:#})"
                ),
            );
            json!({})
        }
    };
    agent_client.close().await;

    let integration_profile = non_empty(register.integration_profile.as_deref())
        .unwrap_or_else(|| integration_profile(options));
    let memory_mode =
        non_empty(register.memory_mode.as_deref()).unwrap_or_else(|| memory_mode(options));
    let runtime_owner =
        non_empty(register.runtime_owner.as_deref()).unwrap_or_else(|| runtime_owner(options));
    let shim_type = non_empty(register.shim_type.as_deref()).unwrap_or_else(|| shim_type(options));
    let trace_mode =
        non_empty(register.trace_mode.as_deref()).unwrap_or_else(|| trace_mode(options));
    let organization_id = metadata_string(&credentials.metadata, "organizationId");
    let key_prefix = key_output
        .as_ref()
        .and_then(|key| key.prefix.clone())
        .or_else(|| stored.as_ref().and_then(|stored| stored.key_prefix.clone()));
    let scopes = key_output
        .as_ref()
        .and_then(|key| key.scopes.clone())
        .or_else(|| stored.as_ref().and_then(|stored| stored.scopes.clone()));
    let metadata = AgentMcpMetadata {
        metadata_type: "agent-mcp".to_owned(),
        api_key: api_key.context("missing API key after registration")?,
        created_at: if api_key_created {
            now.to_rfc3339()
        } else {
            stored
                .as_ref()
                .map(|value| value.created_at.clone())
                .unwrap_or_else(|| now.to_rfc3339())
        },
        endpoint: endpoint.endpoint.clone(),
        registered_at: Utc::now().to_rfc3339(),
        surface: options.surface.clone().unwrap_or_else(|| "cli".to_owned()),
        agent_id: register.agent_id.clone(),
        expires_at: key_output
            .as_ref()
            .and_then(|key| key.expires_at.clone())
            .or_else(|| stored.as_ref().and_then(|stored| stored.expires_at.clone())),
        integration_profile: Some(integration_profile.clone()),
        key_id: key_output
            .as_ref()
            .and_then(|key| key.key_id.clone())
            .or_else(|| stored.as_ref().and_then(|stored| stored.key_id.clone())),
        key_name: key_output
            .as_ref()
            .and_then(|key| key.name.clone())
            .or_else(|| stored.as_ref().and_then(|stored| stored.key_name.clone())),
        key_prefix: key_prefix.clone(),
        manifest_url: endpoint.manifest_url.clone(),
        memory_mode: Some(memory_mode.clone()),
        registry_visible: register.registry_visible,
        run_id: register.run_id.clone(),
        runtime_owner: Some(runtime_owner.clone()),
        scopes,
        session_expires_at: register.expires_at.clone(),
        shim_type: Some(shim_type.clone()),
        trace_mode: Some(trace_mode.clone()),
        workspace_id: options
            .workspace_id
            .clone()
            .or_else(|| organization_id.clone()),
    };
    credentials.metadata.insert(
        "agentId".to_owned(),
        option_value(register.agent_id.clone()),
    );
    credentials
        .metadata
        .insert("runId".to_owned(), option_value(register.run_id.clone()));
    credentials.metadata.insert(
        "surface".to_owned(),
        Value::String(options.surface.clone().unwrap_or_else(|| "cli".to_owned())),
    );
    credentials
        .metadata
        .insert("agentMcp".to_owned(), serde_json::to_value(metadata)?);
    save_credentials(&credentials)?;

    let evidence = summary
        .get("evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(InitResult {
        agent_id: register.agent_id,
        api_key_created,
        approval_policy_attached: has_policy_control(&summary),
        authenticated_as: authenticated_as(&credentials.metadata),
        console_url: console_url(&endpoint.endpoint)?,
        endpoint: endpoint.endpoint,
        evidence_event_published: !evidence.is_empty(),
        evidence_events: evidence.len(),
        governed_actions_loaded: governed_action_count(&summary),
        governed_inference_check_ran: governed.get("decision").and_then(Value::as_str).is_some(),
        integration_profile,
        key_prefix,
        manifest_url: endpoint.manifest_url,
        memory_mode,
        organization_id,
        registry_visible: register.registry_visible,
        risk_findings: count_high_risk(&summary),
        run_id: register.run_id,
        runtime_owner,
        scopes_granted: register.scopes_granted,
        session_expires_at: register.expires_at,
        shim_type,
        stored: true,
        trace_ingestion_started: has_trace_evidence(&summary),
        trace_mode,
    })
}

fn can_reuse_stored_agent(options: &InitOptions, credentials: &OAuthCredentials) -> bool {
    !options.force_login && !options.rotate_key && stored_agent_mcp(credentials).is_some()
}

fn register_args(options: &InitOptions) -> Value {
    let mut value = json!({
        "agent_type": options.agent_type.as_deref().unwrap_or("maestro"),
        "capabilities": capabilities(options),
        "integration_profile": integration_profile(options),
        "memory_mode": memory_mode(options),
        "runtime_owner": runtime_owner(options),
        "shim_type": shim_type(options),
        "surface": options.surface.as_deref().unwrap_or("cli"),
        "trace_mode": trace_mode(options),
    });
    let object = value
        .as_object_mut()
        .expect("registration payload is an object");
    if !options.register_scopes.is_empty() {
        object.insert("scopes".to_owned(), json!(options.register_scopes));
    }
    if let Some(ttl) = options.ttl_seconds {
        object.insert("ttl_seconds".to_owned(), json!(ttl));
    }
    if let Some(workspace) = options.workspace_id.as_ref() {
        object.insert("workspace_id".to_owned(), json!(workspace));
    }
    value
}

async fn ensure_login(options: &InitOptions, client: &Client) -> Result<OAuthCredentials> {
    let mut credentials = if options.force_login {
        None
    } else {
        load_credentials()?
    };
    if let Some(existing) = credentials.as_ref() {
        if existing.expires > Utc::now().timestamp_millis() + 60_000 {
            return Ok(existing.clone());
        }
        if !existing.refresh.trim().is_empty() {
            status(options, "Refreshing EvalOps login");
            if let Ok(refreshed) = refresh_credentials(existing, client).await {
                save_credentials(&refreshed)?;
                return Ok(refreshed);
            }
        }
    }
    status(options, "Opening EvalOps login");
    credentials = Some(login(options, client).await?);
    let mut credentials = credentials.context("EvalOps login did not produce credentials")?;
    maybe_enroll_desktop_device(client, &mut credentials).await;
    save_credentials(&credentials)?;
    Ok(credentials)
}

async fn login(options: &InitOptions, client: &Client) -> Result<OAuthCredentials> {
    let identity = identity_base_from_env();
    let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
        .await
        .with_context(|| format!("Port {CALLBACK_PORT} is already in use"))?;
    let callback_uri = format!("http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}");
    let registration_response = client
        .post(format!("{identity}/register"))
        .json(&json!({
            "client_name": "Maestro CLI",
            "redirect_uris": [&callback_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none"
        }))
        .send()
        .await
        .context("register Maestro OAuth client")?;
    let registration_status = registration_response.status();
    let registration_body = registration_response.text().await.unwrap_or_default();
    if !registration_status.is_success() {
        bail!(
            "EvalOps OAuth client registration failed (HTTP {}): {}",
            registration_status.as_u16(),
            response_detail(&registration_body)
        );
    }
    let registration: OAuthClientRegistration = serde_json::from_str(&registration_body)
        .context("parse EvalOps OAuth client registration")?;
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = Uuid::new_v4().simple().to_string();
    let mut authorization_url = Url::parse(&format!("{identity}/authorize"))?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &registration.client_id)
            .append_pair("redirect_uri", &callback_uri)
            .append_pair("scope", REQUIRED_SCOPE)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(org) = login_organization_id() {
            query.append_pair("organization_id", &org);
        }
    }
    status(options, "Waiting for EvalOps identity callback...");
    if options.json {
        eprintln!("Open this URL in your browser to authenticate with EvalOps:");
        eprintln!("{}", authorization_url.as_str());
    } else {
        println!("Open this URL in your browser to authenticate with EvalOps:");
        println!("{}", authorization_url.as_str());
    }
    open_browser(authorization_url.as_str());
    let callback = tokio::time::timeout(Duration::from_mins(5), accept_callback(listener, &state))
        .await
        .context("EvalOps login timed out after 5 minutes")??;
    let token_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", &callback.code)
        .append_pair("client_id", &registration.client_id)
        .append_pair("redirect_uri", &callback_uri)
        .append_pair("code_verifier", &verifier)
        .finish();
    let token_response = client
        .post(format!("{identity}/token"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(token_body)
        .send()
        .await
        .context("exchange EvalOps authorization code")?;
    let token_status = token_response.status();
    let token_response_body = token_response.text().await.unwrap_or_default();
    if !token_status.is_success() {
        bail!(
            "EvalOps authorization-code exchange failed (HTTP {}): {}",
            token_status.as_u16(),
            response_detail(&token_response_body)
        );
    }
    let token: OAuthTokenExchange = serde_json::from_str(&token_response_body)
        .context("parse EvalOps authorization-code exchange")?;
    Ok(OAuthCredentials {
        credential_type: "oauth".to_owned(),
        refresh: token.refresh_token,
        access: token.access_token,
        expires: Utc::now().timestamp_millis() + (token.expires_in as i64 * 1_000),
        metadata: Map::from_iter([
            ("identityBaseUrl".to_owned(), Value::String(identity)),
            (
                "organizationId".to_owned(),
                Value::String(token.organization_id),
            ),
            ("providerRef".to_owned(), provider_ref()),
            (
                "scopes".to_owned(),
                Value::Array(
                    token
                        .scope
                        .split_whitespace()
                        .map(|scope| Value::String(scope.to_owned()))
                        .collect(),
                ),
            ),
        ]),
    })
}

struct CallbackResult {
    code: String,
}

async fn accept_callback(listener: TcpListener, expected_state: &str) -> Result<CallbackResult> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        match read_callback(&mut stream, expected_state).await {
            Ok(Some(result)) => return Ok(result),
            Ok(None) => continue,
            Err(error) => return Err(error),
        }
    }
}

async fn read_callback(
    stream: &mut TcpStream,
    expected_state: &str,
) -> Result<Option<CallbackResult>> {
    let mut buffer = vec![0_u8; 16 * 1024];
    let size = stream.read(&mut buffer).await?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let first = request.lines().next().unwrap_or_default();
    let target = first.split_whitespace().nth(1).unwrap_or("/");
    let host = request
        .lines()
        .find_map(|line| {
            line.strip_prefix("Host: ")
                .or_else(|| line.strip_prefix("host: "))
        })
        .unwrap_or_default()
        .trim();
    if !matches!(host, "127.0.0.1:1460" | "localhost:1460" | "[::1]:1460") {
        write_http(stream, 403, "Invalid callback host.").await?;
        return Ok(None);
    }
    let url = Url::parse(&format!("http://127.0.0.1:{CALLBACK_PORT}{target}"))?;
    if url.path() != CALLBACK_PATH {
        write_http(stream, 404, "Not found").await?;
        return Ok(None);
    }
    let query = url.query_pairs().into_owned().collect::<BTreeMap<_, _>>();
    if let Some(error) = query.get("error") {
        write_http(
            stream,
            400,
            "EvalOps login failed. You can close this window.",
        )
        .await?;
        bail!("EvalOps identity login failed: {error}");
    }
    let code = match validated_callback_code(&query, expected_state) {
        Ok(code) => code,
        Err(error) => {
            write_http(stream, 403, "Invalid OAuth callback.").await?;
            return Err(error);
        }
    };
    write_http(
        stream,
        200,
        "Authentication successful. You can close this window and return to Maestro.",
    )
    .await?;
    Ok(Some(CallbackResult { code }))
}

fn validated_callback_code(
    query: &BTreeMap<String, String>,
    expected_state: &str,
) -> Result<String> {
    let state = query
        .get("state")
        .filter(|value| !value.is_empty())
        .context("EvalOps callback was missing state")?;
    if state != expected_state {
        bail!("EvalOps callback state did not match the login request");
    }
    query
        .get("code")
        .filter(|value| !value.is_empty())
        .cloned()
        .context("EvalOps callback was missing authorization code")
}

async fn write_http(stream: &mut TcpStream, status: u16, body: &str) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn refresh_credentials(
    existing: &OAuthCredentials,
    client: &Client,
) -> Result<OAuthCredentials> {
    let identity = metadata_string(&existing.metadata, "identityBaseUrl")
        .unwrap_or_else(identity_base_from_env);
    let existing_device_id = metadata_string(&existing.metadata, "deviceId");
    let device_proof = crate::device_identity::build_enrolled_desktop_device_proof(
        client,
        &identity,
        crate::device_identity::DeviceProofPurpose::Refresh,
        existing_device_id.as_deref(),
    )
    .await;

    let mut refresh_body = json!({ "refresh_token": existing.refresh });
    if let Some(proof) = &device_proof {
        refresh_body["device_proof"] = json!({
            "challenge_id": proof.challenge_id,
            "device_id": proof.device_id,
            "signature": proof.signature,
        });
    }

    let response = client
        .post(format!("{identity}/v1/tokens/refresh"))
        .json(&refresh_body)
        .send()
        .await?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        bail!(
            "{}",
            payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("EvalOps token refresh failed")
        );
    }
    let access =
        string_at(&payload, "access_token").context("EvalOps refresh missing access_token")?;
    let expires = parse_timestamp(
        payload.get("expires_at").and_then(Value::as_str),
        "expires_at",
    )?;
    let mut metadata = existing.metadata.clone();
    metadata.insert(
        "identityBaseUrl".to_owned(),
        Value::String(identity.clone()),
    );
    if let Some(org) = string_at(&payload, "organization_id") {
        metadata.insert("organizationId".to_owned(), Value::String(org));
    }
    if let Some(scopes) = string_array(payload.get("scopes")) {
        metadata.insert(
            "scopes".to_owned(),
            Value::Array(scopes.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(device_id) = existing_device_id {
        metadata.insert("deviceId".to_owned(), Value::String(device_id));
    }
    let refreshed = OAuthCredentials {
        credential_type: "oauth".to_owned(),
        refresh: string_at(&payload, "refresh_token").unwrap_or_else(|| existing.refresh.clone()),
        access,
        expires,
        metadata,
    };

    // Match TS: when no enrolled proof was available, persist the refresh first, then
    // best-effort migrate/enroll the current desktop device and attach deviceId.
    if device_proof.is_some() {
        return Ok(refreshed);
    }
    let _ = save_credentials(&refreshed);
    if let Some(device_id) = crate::device_identity::enroll_desktop_device_identity(
        client,
        &identity,
        &refreshed.access,
        Some(&package_version()),
    )
    .await
    {
        let mut migrated = refreshed;
        migrated
            .metadata
            .insert("deviceId".to_owned(), Value::String(device_id));
        return Ok(migrated);
    }
    Ok(refreshed)
}

async fn resolve_endpoint(
    options: &InitOptions,
    client: &Client,
    credentials: &OAuthCredentials,
) -> Result<Endpoint> {
    if let Some(url) = options.mcp_url.as_deref() {
        return Ok(Endpoint {
            endpoint: normalize_mcp_endpoint(url)?,
            identity_base_url: None,
            manifest_url: None,
            prefer_derived_identity: true,
        });
    }
    if let Some(url) = options.manifest_url.as_deref() {
        return endpoint_from_manifest(client, &normalize_manifest_url(url)?).await;
    }
    if let Some(url) = env_first(&[
        "MAESTRO_PLATFORM_MCP_URL",
        "MAESTRO_AGENT_MCP_URL",
        "MAESTRO_EVALOPS_AGENT_MCP_URL",
    ]) {
        return Ok(Endpoint {
            endpoint: normalize_mcp_endpoint(&url)?,
            identity_base_url: None,
            manifest_url: None,
            prefer_derived_identity: true,
        });
    }
    if let Some(url) = env_first(&[
        "MAESTRO_PLATFORM_MCP_MANIFEST_URL",
        "MAESTRO_AGENT_MCP_MANIFEST_URL",
        "MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL",
    ]) {
        return endpoint_from_manifest(client, &normalize_manifest_url(&url)?).await;
    }
    if let Some(stored) = stored_agent_mcp(credentials) {
        return Ok(Endpoint {
            endpoint: normalize_mcp_endpoint(&stored.endpoint)?,
            identity_base_url: None,
            manifest_url: stored.manifest_url,
            prefer_derived_identity: false,
        });
    }
    endpoint_from_manifest(
        client,
        &format!("{DEFAULT_AGENT_MCP_BASE_URL}{AGENT_MCP_MANIFEST_PATH}"),
    )
    .await
}

async fn endpoint_from_manifest(client: &Client, manifest_url: &str) -> Result<Endpoint> {
    let response = client
        .get(manifest_url)
        .header("accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        bail!(
            "Failed to fetch EvalOps MCP manifest ({} {})",
            response.status().as_u16(),
            response.status().canonical_reason().unwrap_or("")
        );
    }
    let payload: Value = response.json().await?;
    let endpoint = payload
        .pointer("/protocol/endpoint")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("EvalOps MCP manifest did not include protocol.endpoint")?;
    let identity_base_url = [
        "/identity/base_url",
        "/identity/baseUrl",
        "/identity/url",
        "/identity_base_url",
        "/identityBaseUrl",
    ]
    .iter()
    .find_map(|path| {
        payload
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    Ok(Endpoint {
        endpoint: normalize_mcp_endpoint(endpoint)?,
        identity_base_url,
        manifest_url: Some(manifest_url.to_owned()),
        prefer_derived_identity: true,
    })
}

fn normalize_mcp_endpoint(value: &str) -> Result<String> {
    let mut url = Url::parse(value.trim())?;
    if matches!(url.path(), "" | "/" | AGENT_MCP_MANIFEST_PATH) {
        url.set_path(AGENT_MCP_PATH);
        url.set_query(None);
        url.set_fragment(None);
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn normalize_manifest_url(value: &str) -> Result<String> {
    let mut url = Url::parse(value.trim())?;
    if matches!(url.path(), "" | "/") {
        url.set_path(AGENT_MCP_MANIFEST_PATH);
    }
    Ok(url.to_string())
}

fn resolve_identity_base_url(
    endpoint: &Endpoint,
    credentials: &OAuthCredentials,
) -> Result<String> {
    if let Some(configured) = env_first(&[
        "MAESTRO_IDENTITY_URL",
        "EVALOPS_IDENTITY_URL",
        "MAESTRO_PLATFORM_BASE_URL",
        "MAESTRO_EVALOPS_BASE_URL",
        "EVALOPS_BASE_URL",
    ]) {
        return Ok(normalize_identity(&configured));
    }
    if let Some(identity) = endpoint.identity_base_url.as_deref() {
        return Ok(normalize_identity(identity));
    }
    let derived = identity_from_mcp(&endpoint.endpoint)?;
    let stored = metadata_string(&credentials.metadata, "identityBaseUrl");
    if endpoint.prefer_derived_identity {
        return Ok(derived.unwrap_or_else(|| stored.unwrap_or_else(identity_base_from_env)));
    }
    let host = Url::parse(&endpoint.endpoint)?
        .host_str()
        .unwrap_or_default()
        .to_owned();
    let custom = !matches!(host.as_str(), "app.evalops.dev" | "staging.evalops.dev");
    if custom {
        if let Some(stored) = stored {
            return Ok(normalize_identity(&stored));
        }
    }
    Ok(derived.unwrap_or_else(|| stored.unwrap_or_else(identity_base_from_env)))
}

fn identity_from_mcp(endpoint: &str) -> Result<Option<String>> {
    let mut url = Url::parse(endpoint)?;
    let host = url.host_str().unwrap_or_default().to_owned();
    if host == "app.evalops.dev" {
        return Ok(Some(DEFAULT_IDENTITY_BASE_URL.to_owned()));
    }
    if host == "staging.evalops.dev" {
        return Ok(Some("https://api.staging.evalops.dev".to_owned()));
    }
    if let Some(rest) = host.strip_prefix("app.") {
        url.set_host(Some(&format!("identity.{rest}")))?;
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(Some(url.as_str().trim_end_matches('/').to_owned()))
}

async fn create_api_key(
    options: &InitOptions,
    client: &Client,
    identity: &str,
    oauth_token: &str,
    now: DateTime<Utc>,
) -> Result<ApiKeyOutput> {
    let expires_at = options
        .expires_in_days
        .and_then(|days| now.checked_add_days(Days::new(days)))
        .map(|date| date.to_rfc3339());
    let name = options.key_name.clone().unwrap_or_else(|| {
        let host = env_first(&["HOSTNAME", "COMPUTERNAME"])
            .unwrap_or_else(|| "local".to_owned())
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || ".-_".contains(character) {
                    character
                } else {
                    '-'
                }
            })
            .take(48)
            .collect::<String>();
        format!("maestro-init-{host}-{}", now.format("%Y-%m-%d"))
    });
    let scopes = if options.api_key_scopes.is_empty() {
        DEFAULT_API_KEY_SCOPES
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    } else {
        options.api_key_scopes.clone()
    };
    let mut body = json!({"name": name, "scopes": scopes});
    if let Some(expires_at) = expires_at.as_ref() {
        body["expires_at"] = Value::String(expires_at.clone());
    }
    let response = client
        .post(format!("{identity}/v1/api-keys"))
        .bearer_auth(oauth_token)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        bail!(
            "{}",
            payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("EvalOps API key creation failed")
        );
    }
    let nested = payload.get("key").unwrap_or(&Value::Null);
    let api_key = string_at(&payload, "api_key")
        .context("EvalOps API key creation did not return api_key")?;
    Ok(ApiKeyOutput {
        api_key,
        expires_at: string_at(&payload, "expires_at").or_else(|| string_at(nested, "expires_at")),
        key_id: string_at(&payload, "key_id").or_else(|| string_at(nested, "id")),
        name: string_at(&payload, "name").or_else(|| string_at(nested, "name")),
        prefix: string_at(&payload, "prefix").or_else(|| string_at(nested, "prefix")),
        scopes: string_array(payload.get("scopes"))
            .or_else(|| string_array(nested.get("scopes")))
            .or_else(|| string_array(payload.get("scopes_granted"))),
    })
}

struct AgentMcpClient {
    client: Client,
    endpoint: String,
    api_key: String,
    session_id: Option<String>,
    next_id: u64,
}

impl AgentMcpClient {
    async fn connect(endpoint: &str, api_key: &str) -> Result<Self> {
        let mut connection = Self {
            client: Client::builder().timeout(Duration::from_secs(30)).build()?,
            endpoint: endpoint.to_owned(),
            api_key: api_key.to_owned(),
            session_id: None,
            next_id: 1,
        };
        connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "clientInfo": {"name": "maestro", "version": package_version()}
                }),
            )
            .await?;
        connection
            .notification("notifications/initialized", None)
            .await?;
        Ok(connection)
    }

    async fn call_tool<T: for<'de> Deserialize<'de>>(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<T> {
        let result = self
            .request("tools/call", json!({"name": name, "arguments": arguments}))
            .await?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            bail!("{name} returned an MCP error");
        }
        let output = if let Some(structured) = result.get("structuredContent") {
            structured.clone()
        } else {
            let text = result
                .get("content")
                .and_then(Value::as_array)
                .and_then(|content| {
                    content.iter().find_map(|entry| {
                        (entry.get("type").and_then(Value::as_str) == Some("text"))
                            .then(|| entry.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                })
                .context("MCP tool did not return structured JSON output")?;
            serde_json::from_str(text).context("parse MCP text tool result")?
        };
        serde_json::from_value(output).context("decode MCP tool result")
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let response = self.send(&payload).await?;
        if let Some(error) = response.get("error") {
            bail!("MCP {method} failed: {error}");
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("MCP {method} response missing result"))
    }

    async fn notification(&mut self, method: &str, params: Option<Value>) -> Result<()> {
        let mut payload = json!({"jsonrpc": "2.0", "method": method});
        if let Some(params) = params {
            payload["params"] = params;
        }
        let response = self.send_response(&payload).await?;
        if !response.status().is_success() && response.status() != StatusCode::ACCEPTED {
            bail!("MCP {method} notification failed ({})", response.status());
        }
        Ok(())
    }

    async fn send(&mut self, payload: &Value) -> Result<Value> {
        let response = self.send_response(payload).await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            bail!("MCP request failed ({status}): {text}");
        }
        parse_mcp_response(response).await
    }

    async fn send_response(&mut self, payload: &Value) -> Result<Response> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", "2024-11-05")
            .json(payload);
        if let Some(session) = self.session_id.as_deref() {
            request = request.header("mcp-session-id", session);
        }
        let response = request.send().await?;
        if self.session_id.is_none() {
            self.session_id = response
                .headers()
                .get("mcp-session-id")
                .and_then(|header| header.to_str().ok())
                .map(str::to_owned);
        }
        Ok(response)
    }

    async fn close(&self) {
        if let Some(session) = self.session_id.as_deref() {
            let _ = self
                .client
                .delete(&self.endpoint)
                .bearer_auth(&self.api_key)
                .header("mcp-session-id", session)
                .header("mcp-protocol-version", "2024-11-05")
                .send()
                .await;
        }
    }
}

async fn parse_mcp_response(response: Response) -> Result<Value> {
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response.text().await?;
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    return serde_json::from_str(data).context("parse MCP SSE response");
                }
            }
        }
        bail!("MCP SSE response did not contain data");
    }
    serde_json::from_str(&body).context("parse MCP JSON response")
}

fn credentials_file() -> Result<PathBuf> {
    let home = crate::path_utils::maestro_home_dir().context("resolve Maestro home")?;
    Ok(home.join("oauth.json"))
}

fn force_file_storage() -> bool {
    matches!(
        std::env::var("MAESTRO_OAUTH_STORAGE_MODE")
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("file")
    ) || std::env::var("MAESTRO_DISABLE_KEYCHAIN").ok().as_deref() == Some("1")
}

fn force_keychain_storage() -> bool {
    matches!(
        std::env::var("MAESTRO_OAUTH_STORAGE_MODE")
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("keychain")
    ) && std::env::var("MAESTRO_DISABLE_KEYCHAIN").ok().as_deref() != Some("1")
}

fn load_credentials() -> Result<Option<OAuthCredentials>> {
    if !force_file_storage() {
        match keyring::Entry::new("maestro-oauth", "evalops") {
            Ok(entry) => match entry.get_password() {
                Ok(raw) => return Ok(Some(serde_json::from_str(&raw)?)),
                Err(keyring::Error::NoEntry) => {}
                Err(error) if force_keychain_storage() => {
                    return Err(error).context("read forced EvalOps keychain storage");
                }
                Err(_) => {}
            },
            Err(error) if force_keychain_storage() => {
                return Err(error).context("open forced EvalOps keychain storage");
            }
            Err(_) => {}
        }
    }
    let path = credentials_file()?;
    if !path.exists() {
        return Ok(None);
    }
    let storage: Value = serde_json::from_str(&fs::read_to_string(&path)?)
        .with_context(|| format!("parse {}", path.display()))?;
    storage
        .get("evalops")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("decode EvalOps OAuth credentials")
}

fn save_credentials(credentials: &OAuthCredentials) -> Result<()> {
    let serialized = serde_json::to_string(credentials)?;
    if !force_file_storage() {
        let keychain_result = (|| -> Result<()> {
            migrate_plaintext_credentials_to_keychain("evalops")?;
            let entry = keyring::Entry::new("maestro-oauth", "evalops")
                .context("open EvalOps keychain storage")?;
            entry
                .set_password(&serialized)
                .context("write EvalOps keychain storage")?;
            update_provider_registry("evalops")?;
            finish_keychain_migration()?;
            Ok(())
        })();
        match keychain_result {
            Ok(()) => return Ok(()),
            Err(error) if force_keychain_storage() => {
                return Err(error).context("forced EvalOps keychain storage failed");
            }
            Err(_) => {}
        }
    }
    let path = credentials_file()?;
    let mut storage = if path.exists() {
        serde_json::from_str::<Value>(&fs::read_to_string(&path)?)
            .with_context(|| format!("parse {}", path.display()))?
    } else {
        json!({})
    };
    let object = storage
        .as_object_mut()
        .context("OAuth storage root must be an object")?;
    object.insert("evalops".to_owned(), serde_json::to_value(credentials)?);
    atomic_private_write(&path, &serde_json::to_vec_pretty(&storage)?)
}

fn update_provider_registry(provider: &str) -> Result<()> {
    let path = credentials_file()?
        .parent()
        .context("OAuth file missing parent")?
        .join("oauth-providers.json");
    let mut providers = if path.exists() {
        let value: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        string_array(value.get("providers")).unwrap_or_default()
    } else {
        Vec::new()
    };
    if !providers.iter().any(|entry| entry == provider) {
        providers.push(provider.to_owned());
    }
    atomic_private_write(
        &path,
        &serde_json::to_vec_pretty(&json!({"providers": providers}))?,
    )
}

fn migrate_plaintext_credentials_to_keychain(replaced_provider: &str) -> Result<()> {
    let path = credentials_file()?;
    if !path.exists() {
        return Ok(());
    }
    let storage: Value = serde_json::from_str(&fs::read_to_string(&path)?)
        .with_context(|| format!("parse {} for keychain migration", path.display()))?;
    let providers = storage
        .as_object()
        .context("OAuth storage root must be an object")?;
    for (provider, credentials) in providers {
        if provider == replaced_provider {
            continue;
        }
        let entry = keyring::Entry::new("maestro-oauth", provider)
            .with_context(|| format!("open {provider} keychain storage"))?;
        entry
            .set_password(&serde_json::to_string(credentials)?)
            .with_context(|| format!("migrate {provider} credentials to keychain"))?;
        update_provider_registry(provider)?;
    }
    Ok(())
}

fn finish_keychain_migration() -> Result<()> {
    let path = credentials_file()?;
    let sentinel = path.with_extension("json.migrated");
    atomic_private_write(
        &sentinel,
        &serde_json::to_vec_pretty(&json!({
            "version": 1,
            "migratedAt": Utc::now().to_rfc3339()
        }))?,
    )?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn stored_agent_mcp(credentials: &OAuthCredentials) -> Option<AgentMcpMetadata> {
    credentials
        .metadata
        .get("agentMcp")
        .cloned()
        .and_then(|value| serde_json::from_value::<AgentMcpMetadata>(value).ok())
        .filter(|value| {
            !value.api_key.trim().is_empty()
                && !value.endpoint.trim().is_empty()
                && !value.created_at.trim().is_empty()
                && !value.registered_at.trim().is_empty()
                && !value.surface.trim().is_empty()
        })
}

fn capabilities(options: &InitOptions) -> Vec<String> {
    let defaults = if options.agent_type.as_deref().unwrap_or("maestro") == "maestro" {
        DEFAULT_MAESTRO_CAPABILITIES
    } else {
        DEFAULT_AGENT_CAPABILITIES
    };
    let source = if options.capabilities.is_empty() {
        defaults
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    } else {
        options.capabilities.clone()
    };
    let mut seen = HashSet::new();
    source
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            let key = trimmed.to_ascii_lowercase();
            (!trimmed.is_empty() && seen.insert(key)).then(|| trimmed.to_owned())
        })
        .collect()
}

fn integration_profile(options: &InitOptions) -> String {
    options.integration_profile.clone().unwrap_or_else(|| {
        if options
            .agent_type
            .as_deref()
            .is_some_and(|value| value != "maestro")
        {
            "mcp_otlp".to_owned()
        } else {
            "managed_runtime".to_owned()
        }
    })
}

fn shim_type(options: &InitOptions) -> String {
    options.shim_type.clone().unwrap_or_else(|| {
        if integration_profile(options) == "managed_runtime" {
            "sdk".to_owned()
        } else {
            "native_mcp".to_owned()
        }
    })
}

fn trace_mode(options: &InitOptions) -> String {
    options.trace_mode.clone().unwrap_or_else(|| {
        if integration_profile(options) == "mcp_only" {
            "mcp_events".to_owned()
        } else {
            "otlp".to_owned()
        }
    })
}

fn memory_mode(options: &InitOptions) -> String {
    options.memory_mode.clone().unwrap_or_else(|| {
        if integration_profile(options) == "managed_runtime" {
            "durable".to_owned()
        } else {
            "none".to_owned()
        }
    })
}

fn runtime_owner(options: &InitOptions) -> String {
    options.runtime_owner.clone().unwrap_or_else(|| {
        if integration_profile(options) == "managed_runtime" {
            "evalops".to_owned()
        } else {
            "external".to_owned()
        }
    })
}

fn status(options: &InitOptions, message: &str) {
    if options.json {
        eprintln!("{message}");
    } else {
        println!("{message}");
    }
}

fn format_success(result: &InitResult) -> String {
    let key_mode = if result.api_key_created {
        "Created"
    } else {
        "Reused"
    };
    let authenticated_as = result.authenticated_as.as_deref().unwrap_or("EvalOps");
    [
        "EvalOps Maestro bootstrap".to_owned(),
        String::new(),
        format!("✓ Authenticated as {authenticated_as}"),
        format!("✓ {key_mode} managed inference key"),
        "✓ Registered local agent runtime".to_owned(),
        format!(
            "✓ Integration profile {} via {}",
            result.integration_profile, result.shim_type
        ),
        format!(
            "✓ Loaded {} governed actions",
            result.governed_actions_loaded
        ),
        if result.approval_policy_attached {
            "✓ Attached default approval policy".to_owned()
        } else {
            "✓ Queued approval policy review".to_owned()
        },
        if result.trace_ingestion_started {
            "✓ Started trace ingestion".to_owned()
        } else {
            "✓ Requested trace ingestion".to_owned()
        },
        if result.governed_inference_check_ran {
            "✓ Ran first governed inference check".to_owned()
        } else {
            "✓ Queued first governed inference check".to_owned()
        },
        if result.evidence_event_published {
            "✓ Published evidence event".to_owned()
        } else {
            "✓ Queued evidence event".to_owned()
        },
        String::new(),
        "Open console:".to_owned(),
        result.console_url.clone(),
    ]
    .join("\n")
}

fn authenticated_as(metadata: &Map<String, Value>) -> Option<String> {
    ["email", "preferred_username", "preferredUsername", "user"]
        .iter()
        .find_map(|key| metadata_string(metadata, key))
        .or_else(|| {
            metadata
                .get("user")
                .and_then(Value::as_object)
                .and_then(|user| {
                    ["email", "name"]
                        .iter()
                        .find_map(|key| metadata_string(user, key))
                })
        })
}

fn console_url(endpoint: &str) -> Result<String> {
    let mut url = Url::parse(endpoint)?;
    let environment = match url.host_str().unwrap_or_default() {
        "app.evalops.dev" => "production",
        "staging.evalops.dev" => "staging",
        _ => "local",
    };
    url.set_path("/overview");
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("env", environment);
    Ok(url.to_string())
}

fn count_high_risk(summary: &Value) -> u64 {
    let findings = summary
        .get("findings")
        .and_then(Value::as_array)
        .map(|findings| {
            findings
                .iter()
                .filter(|finding| {
                    matches!(
                        finding
                            .get("severity")
                            .and_then(Value::as_str)
                            .map(str::to_ascii_lowercase)
                            .as_deref(),
                        Some("critical" | "high")
                    )
                })
                .count() as u64
        })
        .unwrap_or(0);
    let metric = summary
        .pointer("/metrics/high_risk_tools")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    findings.max(metric)
}

fn governed_action_count(summary: &Value) -> u64 {
    summary
        .pointer("/metrics/total_tools")
        .and_then(Value::as_u64)
        .or_else(|| {
            summary
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| tools.len() as u64)
        })
        .unwrap_or(0)
}

fn has_policy_control(summary: &Value) -> bool {
    if summary
        .pointer("/metrics/approval_required_tools")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        return true;
    }
    summary
        .get("policy_controls")
        .and_then(Value::as_array)
        .is_some_and(|controls| {
            controls.iter().any(|control| {
                ["label", "value", "detail"]
                    .iter()
                    .filter_map(|key| control.get(key).and_then(Value::as_str))
                    .any(|value| {
                        let lower = value.to_ascii_lowercase();
                        ["approval", "policy", "starter"]
                            .iter()
                            .any(|needle| lower.contains(needle))
                    })
            })
        })
}

fn has_trace_evidence(summary: &Value) -> bool {
    summary
        .get("evidence")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                ["trace", "trace_id", "traceId"].iter().any(|key| {
                    entry
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty())
                })
            })
        })
}

fn parse_timestamp(value: Option<&str>, field: &str) -> Result<i64> {
    let value = value.ok_or_else(|| anyhow!("Missing {field} in EvalOps response"))?;
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .with_context(|| format!("Invalid {field} in EvalOps response: {value}"))
}

fn provider_ref() -> Value {
    let mut value = json!({
        "provider": env_first(&["MAESTRO_EVALOPS_PROVIDER", "MAESTRO_LLM_GATEWAY_PROVIDER"])
            .unwrap_or_else(|| "openai".to_owned()),
        "environment": env_first(&["MAESTRO_EVALOPS_ENVIRONMENT", "MAESTRO_LLM_GATEWAY_ENVIRONMENT"])
            .unwrap_or_else(|| "prod".to_owned())
    });
    if let Some(name) = env_first(&[
        "MAESTRO_EVALOPS_CREDENTIAL_NAME",
        "MAESTRO_LLM_GATEWAY_CREDENTIAL_NAME",
    ]) {
        value["credential_name"] = Value::String(name);
    }
    if let Some(team) = env_first(&["MAESTRO_EVALOPS_TEAM_ID", "MAESTRO_LLM_GATEWAY_TEAM_ID"]) {
        value["team_id"] = Value::String(team);
    }
    value
}

fn identity_base_from_env() -> String {
    normalize_identity(
        &env_first(&[
            "MAESTRO_IDENTITY_URL",
            "EVALOPS_IDENTITY_URL",
            "MAESTRO_PLATFORM_BASE_URL",
            "MAESTRO_EVALOPS_BASE_URL",
            "EVALOPS_BASE_URL",
        ])
        .unwrap_or_else(|| DEFAULT_IDENTITY_BASE_URL.to_owned()),
    )
}

fn login_organization_id() -> Option<String> {
    env_first(&["MAESTRO_EVALOPS_ORG_ID", "EVALOPS_ORGANIZATION_ID"]).or_else(|| {
        load_credentials()
            .ok()
            .flatten()
            .and_then(|credentials| metadata_string(&credentials.metadata, "organizationId"))
    })
}

fn response_detail(body: &str) -> String {
    let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    ["error_description", "error", "message"]
        .iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| {
            let detail = body.trim();
            (!detail.is_empty()).then(|| detail.chars().take(300).collect())
        })
        .unwrap_or_else(|| "no response body".to_owned())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let command = ("open", vec![url]);
    #[cfg(target_os = "linux")]
    let command = ("xdg-open", vec![url]);
    #[cfg(target_os = "windows")]
    let command = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let command: (&str, Vec<&str>) = ("", Vec::new());

    if !command.0.is_empty() {
        let _ = std::process::Command::new(command.0)
            .args(command.1)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn normalize_identity(value: &str) -> String {
    let mut normalized = value.trim().trim_end_matches('/').to_owned();
    for suffix in [
        "/v1/api-keys",
        "/v1/auth/google/start",
        "/v1/tokens/refresh",
        "/v1/tokens/revoke",
        "/v1/delegation-tokens",
    ] {
        if normalized.ends_with(suffix) {
            normalized.truncate(normalized.len() - suffix.len());
            normalized = normalized.trim_end_matches('/').to_owned();
        }
    }
    normalized
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let values = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn option_value(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn package_version() -> String {
    std::env::var("MAESTRO_VERSION")
        .or_else(|_| std::env::var("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| "0.0.0".to_owned())
}

// ── Shared EvalOps OAuth surface for `evalops_cli` ────────────────────────────
//
// Login uses the same dynamic client-registration + PKCE flow as `maestro init`.
// Desktop device-identity enroll + refresh proofs are handled via
// [`crate::device_identity`] (soft-fail when the helper is unavailable).

/// Snapshot of stored EvalOps agent-MCP registration metadata for status display.
#[derive(Debug, Clone, Default)]
pub struct EvalOpsAgentMcpSnapshot {
    pub agent_id: Option<String>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub integration_profile: Option<String>,
    pub key_prefix: Option<String>,
    pub memory_mode: Option<String>,
    pub run_id: Option<String>,
    pub runtime_owner: Option<String>,
    pub session_expires_at: Option<String>,
    pub shim_type: Option<String>,
    pub trace_mode: Option<String>,
    pub workspace_id: Option<String>,
}

/// Snapshot of stored EvalOps OAuth credentials for status/logout.
#[derive(Debug, Clone)]
pub struct EvalOpsCredentialSnapshot {
    pub access: String,
    pub refresh: String,
    pub expires: i64,
    pub email: Option<String>,
    pub organization_id: Option<String>,
    pub user_id: Option<String>,
    pub identity_base_url: Option<String>,
    pub provider_ref: Option<Value>,
    pub agent_mcp: Option<EvalOpsAgentMcpSnapshot>,
}

/// Whether any EvalOps OAuth credentials are stored (keychain or file).
pub fn has_evalops_credentials() -> bool {
    load_credentials()
        .ok()
        .flatten()
        .is_some_and(|credentials| {
            !credentials.access.trim().is_empty() || !credentials.refresh.trim().is_empty()
        })
}

/// Load a display-oriented snapshot of stored EvalOps credentials.
pub fn load_evalops_snapshot() -> Result<Option<EvalOpsCredentialSnapshot>> {
    let Some(credentials) = load_credentials()? else {
        return Ok(None);
    };
    Ok(Some(snapshot_from_credentials(&credentials)))
}

/// Browser OAuth login for EvalOps; persists credentials on success.
///
/// After a successful token exchange, best-effort enrolls desktop device identity
/// (no-op when the helper is unavailable).
pub async fn perform_evalops_login() -> Result<()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("build EvalOps HTTP client")?;
    let options = InitOptions {
        force_login: true,
        ..InitOptions::default()
    };
    status(&options, "Opening EvalOps login");
    let mut credentials = login(&options, &client).await?;
    maybe_enroll_desktop_device(&client, &mut credentials).await;
    save_credentials(&credentials)?;
    Ok(())
}

/// Soft-fail desktop device enrollment; attaches `deviceId` to credential metadata when successful.
async fn maybe_enroll_desktop_device(client: &Client, credentials: &mut OAuthCredentials) {
    let identity = metadata_string(&credentials.metadata, "identityBaseUrl")
        .unwrap_or_else(identity_base_from_env);
    let Some(device_id) = crate::device_identity::enroll_desktop_device_identity(
        client,
        &identity,
        &credentials.access,
        Some(&package_version()),
    )
    .await
    else {
        return;
    };
    credentials
        .metadata
        .insert("identityBaseUrl".to_owned(), Value::String(identity));
    credentials
        .metadata
        .insert("deviceId".to_owned(), Value::String(device_id));
}

/// Best-effort revoke of the EvalOps refresh token, then delete local credentials.
pub async fn perform_evalops_logout() -> Result<()> {
    if let Some(credentials) = load_credentials()? {
        if !credentials.refresh.trim().is_empty() {
            let client = Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .context("build EvalOps HTTP client")?;
            if let Err(error) = revoke_refresh_token(&credentials, &client).await {
                eprintln!("Warning: failed to revoke EvalOps refresh token: {error:#}");
            }
        }
    }
    delete_credentials()?;
    Ok(())
}

fn snapshot_from_credentials(credentials: &OAuthCredentials) -> EvalOpsCredentialSnapshot {
    let agent_mcp = stored_agent_mcp(credentials).map(|meta| EvalOpsAgentMcpSnapshot {
        agent_id: meta.agent_id,
        api_key: (!meta.api_key.trim().is_empty()).then_some(meta.api_key),
        endpoint: (!meta.endpoint.trim().is_empty()).then_some(meta.endpoint),
        integration_profile: meta.integration_profile,
        key_prefix: meta.key_prefix,
        memory_mode: meta.memory_mode,
        run_id: meta.run_id,
        runtime_owner: meta.runtime_owner,
        session_expires_at: meta.session_expires_at,
        shim_type: meta.shim_type,
        trace_mode: meta.trace_mode,
        workspace_id: meta.workspace_id,
    });
    // Prefer loose metadata when full AgentMcp validation fails (e.g. missing secrets).
    let agent_mcp = agent_mcp.or_else(|| {
        credentials
            .metadata
            .get("agentMcp")
            .and_then(Value::as_object)
            .map(|object| EvalOpsAgentMcpSnapshot {
                agent_id: metadata_string(object, "agentId"),
                api_key: metadata_string(object, "apiKey"),
                endpoint: metadata_string(object, "endpoint"),
                integration_profile: metadata_string(object, "integrationProfile"),
                key_prefix: metadata_string(object, "keyPrefix"),
                memory_mode: metadata_string(object, "memoryMode"),
                run_id: metadata_string(object, "runId"),
                runtime_owner: metadata_string(object, "runtimeOwner"),
                session_expires_at: metadata_string(object, "sessionExpiresAt"),
                shim_type: metadata_string(object, "shimType"),
                trace_mode: metadata_string(object, "traceMode"),
                workspace_id: metadata_string(object, "workspaceId"),
            })
    });
    EvalOpsCredentialSnapshot {
        access: credentials.access.clone(),
        refresh: credentials.refresh.clone(),
        expires: credentials.expires,
        email: authenticated_as(&credentials.metadata),
        organization_id: metadata_string(&credentials.metadata, "organizationId"),
        user_id: metadata_string(&credentials.metadata, "userId"),
        identity_base_url: metadata_string(&credentials.metadata, "identityBaseUrl"),
        provider_ref: credentials.metadata.get("providerRef").cloned(),
        agent_mcp,
    }
}

async fn revoke_refresh_token(credentials: &OAuthCredentials, client: &Client) -> Result<()> {
    let identity = metadata_string(&credentials.metadata, "identityBaseUrl")
        .unwrap_or_else(identity_base_from_env);
    let response = client
        .post(format!("{identity}/v1/tokens/revoke"))
        .json(&json!({ "refresh_token": credentials.refresh }))
        .send()
        .await
        .context("revoke EvalOps refresh token")?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("EvalOps token revoke failed: {}", response_detail(&body));
    }
    Ok(())
}

fn delete_credentials() -> Result<()> {
    if !force_file_storage() {
        match keyring::Entry::new("maestro-oauth", "evalops") {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) if force_keychain_storage() => {
                    return Err(error).context("delete forced EvalOps keychain storage");
                }
                Err(_) => {}
            },
            Err(error) if force_keychain_storage() => {
                return Err(error).context("open forced EvalOps keychain storage for delete");
            }
            Err(_) => {}
        }
        remove_provider_from_registry("evalops")?;
    }

    let path = credentials_file()?;
    if !path.exists() {
        return Ok(());
    }
    let mut storage: Value = serde_json::from_str(&fs::read_to_string(&path)?)
        .with_context(|| format!("parse {} for credential delete", path.display()))?;
    if let Some(object) = storage.as_object_mut() {
        object.remove("evalops");
        if object.is_empty() {
            let _ = fs::remove_file(&path);
        } else {
            atomic_private_write(&path, &serde_json::to_vec_pretty(&storage)?)?;
        }
    }
    Ok(())
}

fn remove_provider_from_registry(provider: &str) -> Result<()> {
    let path = credentials_file()?
        .parent()
        .context("OAuth file missing parent")?
        .join("oauth-providers.json");
    if !path.exists() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&fs::read_to_string(&path)?)
        .with_context(|| format!("parse {}", path.display()))?;
    let mut providers = string_array(value.get("providers")).unwrap_or_default();
    let before = providers.len();
    providers.retain(|entry| entry != provider);
    if providers.len() == before {
        return Ok(());
    }
    if providers.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    atomic_private_write(
        &path,
        &serde_json::to_vec_pretty(&json!({ "providers": providers }))?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aliases_repeatable_lists_and_positive_numbers() {
        let args = [
            "--mcp-url",
            "https://app.example.test",
            "--capability",
            "mcp,shell",
            "--capabilities",
            "git",
            "--key-scope",
            "agent:register,llm_gateway:invoke",
            "--ttl-seconds",
            "60",
            "--json",
        ]
        .map(str::to_owned);
        let options = parse_args(&args).unwrap();
        assert_eq!(options.mcp_url.as_deref(), Some("https://app.example.test"));
        assert_eq!(options.capabilities, ["mcp", "shell", "git"]);
        assert_eq!(options.api_key_scopes.len(), 2);
        assert_eq!(options.ttl_seconds, Some(60));
        assert!(options.json);
    }

    #[test]
    fn rejects_unknown_options_and_non_positive_numbers() {
        assert!(parse_args(&["--wat".to_owned()]).is_err());
        assert!(parse_args(&["--ttl-seconds".to_owned(), "0".to_owned()]).is_err());
    }

    #[test]
    fn applies_legacy_registration_defaults() {
        let options = InitOptions::default();
        assert_eq!(integration_profile(&options), "managed_runtime");
        assert_eq!(shim_type(&options), "sdk");
        assert_eq!(trace_mode(&options), "otlp");
        assert_eq!(memory_mode(&options), "durable");
        assert_eq!(runtime_owner(&options), "evalops");
        assert!(capabilities(&options).contains(&"maestro:init".to_owned()));
    }

    #[test]
    fn normalizes_manifest_and_mcp_urls() {
        assert_eq!(
            normalize_mcp_endpoint("https://app.evalops.dev").unwrap(),
            "https://app.evalops.dev/mcp"
        );
        assert_eq!(
            normalize_manifest_url("https://app.evalops.dev").unwrap(),
            "https://app.evalops.dev/.well-known/evalops/agent-mcp.json"
        );
    }

    #[test]
    fn parses_json_and_sse_mcp_payloads() {
        let json_body = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let sse_body = format!("event: message\ndata: {json_body}\n\n");
        let json_value: Value = serde_json::from_str(json_body).unwrap();
        let sse_value: Value = sse_body
            .lines()
            .find_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .map(serde_json::from_str)
            .unwrap()
            .unwrap();
        assert_eq!(json_value, sse_value);
    }

    #[test]
    fn stored_agent_metadata_requires_runtime_secret_fields() {
        let mut credentials = OAuthCredentials {
            credential_type: "oauth".to_owned(),
            refresh: String::new(),
            access: "access".to_owned(),
            expires: 1,
            metadata: Map::new(),
        };
        credentials.metadata.insert(
            "agentMcp".to_owned(),
            json!({
                "type": "agent-mcp",
                "apiKey": "key",
                "createdAt": "2026-01-01T00:00:00Z",
                "endpoint": "https://app.evalops.dev/mcp",
                "registeredAt": "2026-01-01T00:00:00Z",
                "surface": "cli"
            }),
        );
        assert!(stored_agent_mcp(&credentials).is_some());
        credentials.metadata["agentMcp"]["apiKey"] = Value::String(String::new());
        assert!(stored_agent_mcp(&credentials).is_none());
    }

    #[test]
    fn stored_agent_credentials_skip_expired_oauth_unless_rotation_is_requested() {
        let mut credentials = OAuthCredentials {
            credential_type: "oauth".to_owned(),
            refresh: "refresh".to_owned(),
            access: "expired".to_owned(),
            expires: 1,
            metadata: Map::new(),
        };
        credentials.metadata.insert(
            "agentMcp".to_owned(),
            json!({
                "type": "agent-mcp",
                "apiKey": "agent-key",
                "createdAt": "2026-01-01T00:00:00Z",
                "endpoint": "https://app.evalops.dev/mcp",
                "registeredAt": "2026-01-01T00:00:00Z",
                "surface": "cli"
            }),
        );

        let options = InitOptions::default();
        assert!(can_reuse_stored_agent(&options, &credentials));
        assert!(!can_reuse_stored_agent(
            &InitOptions {
                rotate_key: true,
                ..InitOptions::default()
            },
            &credentials
        ));
        assert!(!can_reuse_stored_agent(
            &InitOptions {
                force_login: true,
                ..InitOptions::default()
            },
            &credentials
        ));
    }

    #[test]
    fn oauth_callback_requires_matching_state_and_authorization_code() {
        let valid = BTreeMap::from([
            ("state".to_owned(), "expected".to_owned()),
            ("code".to_owned(), "authorization-code".to_owned()),
        ]);
        assert_eq!(
            validated_callback_code(&valid, "expected").unwrap(),
            "authorization-code"
        );
        assert!(validated_callback_code(&valid, "different").is_err());
        assert!(validated_callback_code(&BTreeMap::new(), "expected").is_err());
    }

    #[test]
    fn oauth_error_detail_prefers_structured_description() {
        assert_eq!(
            response_detail(
                r#"{"error":"invalid_request","error_description":"redirect rejected"}"#
            ),
            "redirect rejected"
        );
        assert_eq!(response_detail(""), "no response body");
    }
}

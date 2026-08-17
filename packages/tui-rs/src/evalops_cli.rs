//! Native `maestro evalops` OAuth + managed-session helpers.
//!
//! Subcommands:
//! - `init` → delegates to [`crate::init_cli::run_init`]
//! - `login` / `logout` / `status` → best-effort parity with the former TypeScript handlers
//! - `platform-tools` → Platform-owned ToolExecution MCP server and approval controls
//!
//! Desktop device-identity enroll + refresh proofs are handled via
//! [`crate::device_identity`] (soft-fail without the native helper).
//!
//! Residual gap vs TypeScript:
//! - Login uses the same dynamic client-registration + PKCE flow as `maestro init`
//!   (not the identity-mediated Google-start URL used by the legacy TS path).

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde_json::Value;
use url::Url;

use crate::init_cli::{
    has_evalops_credentials, load_evalops_snapshot, perform_evalops_login, perform_evalops_logout,
    EvalOpsCredentialSnapshot,
};

mod platform_tools;

const EVALOPS_ACCESS_TOKEN_ENV_VARS: &[&str] = &["MAESTRO_EVALOPS_ACCESS_TOKEN", "EVALOPS_TOKEN"];
const EVALOPS_ORGANIZATION_ID_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_ORG_ID",
    "EVALOPS_ORGANIZATION_ID",
    "EVALOPS_ORG_ID",
    "MAESTRO_ENTERPRISE_ORG_ID",
    "MAESTRO_LLM_GATEWAY_ORG_ID",
    "MAESTRO_REMOTE_RUNNER_ORG_ID",
];
const EVALOPS_WORKSPACE_ID_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_WORKSPACE_ID",
    "EVALOPS_WORKSPACE_ID",
    "MAESTRO_WORKSPACE_ID",
    "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
];
const EVALOPS_USER_ID_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_USER_ID",
    "EVALOPS_USER_ID",
    "MAESTRO_USER_ID",
];
const EVALOPS_INTEGRATION_PROFILE_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_INTEGRATION_PROFILE",
    "EVALOPS_INTEGRATION_PROFILE",
    "MAESTRO_INTEGRATION_PROFILE",
];
const EVALOPS_MEMORY_MODE_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_MEMORY_MODE",
    "EVALOPS_MEMORY_MODE",
    "MAESTRO_MEMORY_MODE",
];
const EVALOPS_RUNTIME_OWNER_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_RUNTIME_OWNER",
    "EVALOPS_RUNTIME_OWNER",
    "MAESTRO_RUNTIME_OWNER",
];
const EVALOPS_SHIM_TYPE_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_SHIM_TYPE",
    "EVALOPS_SHIM_TYPE",
    "MAESTRO_SHIM_TYPE",
];
const EVALOPS_TRACE_MODE_ENV_VARS: &[&str] = &[
    "MAESTRO_EVALOPS_TRACE_MODE",
    "EVALOPS_TRACE_MODE",
    "MAESTRO_TRACE_MODE",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedContext {
    agent_id: Option<String>,
    authenticated: bool,
    control_plane_environment: Option<String>,
    control_plane_url: Option<String>,
    evidence_publisher: &'static str,
    expires_at: Option<i64>,
    inference: &'static str,
    integration_profile: Option<String>,
    key_prefix: Option<String>,
    managed: bool,
    memory_mode: Option<String>,
    mode: &'static str,
    organization_id: Option<String>,
    provider_ref: Option<Value>,
    run_id: Option<String>,
    runtime_owner: Option<String>,
    session_expires_at: Option<String>,
    shim_type: Option<String>,
    trace_ingestion: &'static str,
    trace_mode: Option<String>,
    user_email: Option<String>,
    user_id: Option<String>,
    workspace_id: Option<String>,
}

pub async fn run_evalops(args: &[String]) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("init") => crate::init_cli::run_init(&args[1..]).await,
        Some("platform-tools") => platform_tools::run(&args[1..]).await,
        Some("login" | "logout" | "status") if args.get(1).is_some_and(|arg| is_help(arg)) => {
            println!("{}", evalops_help());
            Ok(0)
        }
        Some("login") => login().await,
        Some("logout") => logout().await,
        Some("status") => status(),
        Some("help" | "--help" | "-h") | None => {
            println!("{}", evalops_help());
            Ok(0)
        }
        _ => {
            eprintln!(
                "Unknown evalops subcommand. Try \"maestro init\" for setup, \"maestro evalops platform-tools\" for governed execution, or \"maestro evalops login\", \"logout\", or \"status\"."
            );
            Ok(1)
        }
    }
}

fn is_help(arg: &str) -> bool {
    matches!(arg, "help" | "--help" | "-h")
}

fn evalops_help() -> &'static str {
    "maestro evalops\n  maestro evalops login               Authenticate with EvalOps (browser OAuth)\n  maestro evalops logout              Remove stored EvalOps credentials\n  maestro evalops status              Show managed EvalOps session status\n  maestro evalops init ...            Alias for `maestro init` (agent bootstrap)\n  maestro evalops platform-tools ...  Install and operate Platform-governed tools\n\nNotes:\n  - Desktop device-identity enroll/refresh proofs soft-fail without MAESTRO_DEVICE_IDENTITY_HELPER.\n  - Login uses the same PKCE client-registration flow as `maestro init`."
}

async fn login() -> Result<i32> {
    println!("Maestro EvalOps Login");
    match perform_evalops_login().await {
        Ok(()) => {
            println!("EvalOps credentials saved successfully.");
            println!("Try \"maestro --provider evalops --model gpt-4o-mini\".");
            Ok(0)
        }
        Err(error) => {
            eprintln!("Login failed: {error:#}");
            Ok(1)
        }
    }
}

async fn logout() -> Result<i32> {
    match perform_evalops_logout().await {
        Ok(()) => {
            println!("Removed stored EvalOps credentials.");
            Ok(0)
        }
        Err(error) => {
            eprintln!("Logout failed: {error:#}");
            Ok(1)
        }
    }
}

fn status() -> Result<i32> {
    // Match TS: short-circuit on stored OAuth credentials only (not env tokens).
    if !has_evalops_credentials() {
        println!("No stored EvalOps credentials.");
        println!("Run \"maestro evalops login\" to authenticate with EvalOps.");
        return Ok(0);
    }

    println!("Stored EvalOps credentials detected.");
    let snapshot = load_evalops_snapshot().ok().flatten();
    let context = resolve_managed_context(snapshot.as_ref(), &env_map());
    println!("{}", format_managed_status(&context));
    if !context.managed {
        println!("No EvalOps agent session yet. Run \"maestro init\".");
    }
    Ok(0)
}

fn resolve_managed_context(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
) -> ManagedContext {
    let agent_mcp = snapshot.and_then(|value| value.agent_mcp.as_ref());
    let access_token = env_from_map(env, EVALOPS_ACCESS_TOKEN_ENV_VARS).or_else(|| {
        snapshot
            .map(|value| value.access.clone())
            .filter(|v| !v.is_empty())
    });
    let organization_id = env_from_map(env, EVALOPS_ORGANIZATION_ID_ENV_VARS)
        .or_else(|| snapshot.and_then(|value| value.organization_id.clone()));
    let workspace_id = env_from_map(env, EVALOPS_WORKSPACE_ID_ENV_VARS)
        .or_else(|| agent_mcp.and_then(|meta| meta.workspace_id.clone()))
        .or_else(|| organization_id.clone());
    let agent_id = env_from_map(env, &["MAESTRO_AGENT_ID"])
        .or_else(|| agent_mcp.and_then(|meta| meta.agent_id.clone()));
    let run_id = env_from_map(env, &["MAESTRO_AGENT_RUN_ID"])
        .or_else(|| agent_mcp.and_then(|meta| meta.run_id.clone()));
    let authenticated = access_token.is_some() || snapshot.is_some();
    let managed_agent_session = agent_mcp
        .and_then(|meta| meta.api_key.as_ref())
        .is_some_and(|key| !key.trim().is_empty())
        || (env_from_map(env, EVALOPS_ACCESS_TOKEN_ENV_VARS).is_some()
            && (agent_id.is_some() || run_id.is_some()));
    let managed = organization_id.is_some() && managed_agent_session;
    let mode = if managed {
        "EvalOps managed"
    } else if authenticated {
        "EvalOps authenticated"
    } else {
        "local"
    };
    let trace_ingestion = if managed && run_id.is_some() {
        "live"
    } else {
        "not configured"
    };

    ManagedContext {
        agent_id,
        authenticated,
        control_plane_environment: control_plane_environment(
            agent_mcp.and_then(|meta| meta.endpoint.as_deref()),
        ),
        control_plane_url: agent_mcp.and_then(|meta| meta.endpoint.clone()),
        evidence_publisher: if managed { "EvalOps" } else { "none" },
        expires_at: snapshot.map(|value| value.expires),
        inference: if managed { "managed" } else { "local" },
        integration_profile: env_from_map(env, EVALOPS_INTEGRATION_PROFILE_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|meta| meta.integration_profile.clone())),
        key_prefix: agent_mcp.and_then(|meta| meta.key_prefix.clone()),
        managed,
        memory_mode: env_from_map(env, EVALOPS_MEMORY_MODE_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|meta| meta.memory_mode.clone())),
        mode,
        organization_id,
        provider_ref: snapshot.and_then(|value| value.provider_ref.clone()),
        run_id,
        runtime_owner: env_from_map(env, EVALOPS_RUNTIME_OWNER_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|meta| meta.runtime_owner.clone())),
        session_expires_at: agent_mcp.and_then(|meta| meta.session_expires_at.clone()),
        shim_type: env_from_map(env, EVALOPS_SHIM_TYPE_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|meta| meta.shim_type.clone())),
        trace_ingestion,
        trace_mode: env_from_map(env, EVALOPS_TRACE_MODE_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|meta| meta.trace_mode.clone())),
        user_email: snapshot.and_then(|value| value.email.clone()),
        user_id: env_from_map(env, EVALOPS_USER_ID_ENV_VARS)
            .or_else(|| snapshot.and_then(|value| value.user_id.clone())),
        workspace_id,
    }
}

fn format_managed_status(context: &ManagedContext) -> String {
    let mut lines = vec![
        format!("Mode: {}", context.mode),
        format!(
            "Control plane: {}",
            context
                .control_plane_environment
                .as_deref()
                .unwrap_or("not configured")
        ),
    ];
    if let Some(url) = context.control_plane_url.as_deref() {
        lines.push(format!("Control plane URL: {url}"));
    }
    if let Some(email) = context.user_email.as_deref() {
        lines.push(format!("Authenticated as: {email}"));
    }
    if let Some(org) = context.organization_id.as_deref() {
        lines.push(format!("Organization: {org}"));
    }
    if let Some(workspace) = context.workspace_id.as_deref() {
        lines.push(format!("Workspace: {workspace}"));
    }
    lines.push(format!(
        "Agent runtime: {}",
        if context.agent_id.is_some() {
            "registered"
        } else {
            "not registered"
        }
    ));
    if let Some(agent) = context.agent_id.as_deref() {
        lines.push(format!("Agent: {agent}"));
    }
    if let Some(run) = context.run_id.as_deref() {
        lines.push(format!("Run: {run}"));
    }
    if let Some(profile) = context.integration_profile.as_deref() {
        lines.push(format!("Integration profile: {profile}"));
    }
    if let Some(owner) = context.runtime_owner.as_deref() {
        lines.push(format!("Runtime owner: {owner}"));
    }
    if let Some(shim) = context.shim_type.as_deref() {
        lines.push(format!("Shim: {shim}"));
    }
    if let Some(trace) = context.trace_mode.as_deref() {
        lines.push(format!("Trace mode: {trace}"));
    }
    if let Some(memory) = context.memory_mode.as_deref() {
        lines.push(format!("Memory mode: {memory}"));
    }
    lines.push(format!("Trace ingestion: {}", context.trace_ingestion));
    lines.push(format!(
        "Evidence publisher: {}",
        context.evidence_publisher
    ));
    lines.push(format!("Inference: {}", context.inference));
    if let Some(provider_ref) = context.provider_ref.as_ref() {
        let provider = provider_ref
            .get("provider")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("openai");
        let environment = provider_ref
            .get("environment")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("prod");
        lines.push(format!("Provider ref: {provider}/{environment}"));
    }
    if let Some(prefix) = context.key_prefix.as_deref() {
        lines.push(format!("API key: {prefix}"));
    }
    if let Some(expires) = context.session_expires_at.as_deref() {
        lines.push(format!("Agent session expires: {expires}"));
    }
    if let Some(expires_at) = context.expires_at {
        let remaining_ms = (expires_at - now_ms()).max(0);
        let minutes = ((remaining_ms as f64) / 60_000.0).round() as i64;
        lines.push(format!(
            "Access token: expires in ~{minutes} minute{}",
            if minutes == 1 { "" } else { "s" }
        ));
    }
    lines.join("\n")
}

fn control_plane_environment(endpoint: Option<&str>) -> Option<String> {
    let endpoint = endpoint?;
    let parsed = Url::parse(endpoint).ok()?;
    match parsed.host_str() {
        Some("app.evalops.dev") => Some("production".to_owned()),
        Some("staging.evalops.dev") => Some("staging".to_owned()),
        Some(host) => Some(host.to_owned()),
        None => Some(endpoint.to_owned()),
    }
}

fn env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn env_from_map(env: &HashMap<String, String>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env.get(*name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_cli::EvalOpsAgentMcpSnapshot;
    use serde_json::json;

    #[test]
    fn help_mentions_login_and_device_identity_helper() {
        let help = evalops_help();
        assert!(help.contains("device-identity"));
        assert!(help.contains("MAESTRO_DEVICE_IDENTITY_HELPER"));
        assert!(help.contains("login"));
        assert!(help.contains("status"));
        assert!(help.contains("platform-tools"));
        assert!(!help.contains("is not ported"));
    }

    #[test]
    fn unknown_subcommand_returns_usage_exit() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let code = runtime
            .block_on(run_evalops(&["wat".to_owned()]))
            .expect("dispatch");
        assert_eq!(code, 1);
    }

    #[test]
    fn init_help_delegates_to_init_cli() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let code = runtime
            .block_on(run_evalops(&["init".to_owned(), "--help".to_owned()]))
            .expect("init help");
        assert_eq!(code, 0);
    }

    #[test]
    fn managed_status_formats_login_only_snapshot() {
        let snapshot = EvalOpsCredentialSnapshot {
            access: "tok".to_owned(),
            refresh: "ref".to_owned(),
            expires: now_ms() + 120_000,
            email: Some("user@evalops.dev".to_owned()),
            organization_id: Some("org_123".to_owned()),
            user_id: Some("user_1".to_owned()),
            identity_base_url: Some("https://identity.evalops.dev".to_owned()),
            provider_ref: Some(json!({"provider": "openai", "environment": "prod"})),
            agent_mcp: None,
        };
        let context = resolve_managed_context(Some(&snapshot), &HashMap::new());
        assert_eq!(context.mode, "EvalOps authenticated");
        assert!(!context.managed);
        assert_eq!(context.inference, "local");
        let output = format_managed_status(&context);
        assert!(output.contains("Mode: EvalOps authenticated"));
        assert!(output.contains("Organization: org_123"));
        assert!(output.contains("Authenticated as: user@evalops.dev"));
        assert!(output.contains("Provider ref: openai/prod"));
        assert!(output.contains("Agent runtime: not registered"));
        assert!(output.contains("Access token: expires in ~2 minutes"));
    }

    #[test]
    fn managed_status_detects_registered_agent_session() {
        let snapshot = EvalOpsCredentialSnapshot {
            access: "tok".to_owned(),
            refresh: "ref".to_owned(),
            expires: now_ms() + 3_600_000,
            email: None,
            organization_id: Some("org_abc".to_owned()),
            user_id: None,
            identity_base_url: None,
            provider_ref: None,
            agent_mcp: Some(EvalOpsAgentMcpSnapshot {
                agent_id: Some("agent_1".to_owned()),
                api_key: Some("evk_live_xxx".to_owned()),
                endpoint: Some("https://app.evalops.dev/mcp".to_owned()),
                integration_profile: Some("managed_runtime".to_owned()),
                key_prefix: Some("evk_live".to_owned()),
                memory_mode: Some("durable".to_owned()),
                run_id: Some("run_9".to_owned()),
                runtime_owner: Some("evalops".to_owned()),
                session_expires_at: Some("2026-12-01T00:00:00Z".to_owned()),
                shim_type: Some("sdk".to_owned()),
                trace_mode: Some("otlp".to_owned()),
                workspace_id: Some("ws_1".to_owned()),
            }),
        };
        let context = resolve_managed_context(Some(&snapshot), &HashMap::new());
        assert!(context.managed);
        assert_eq!(context.mode, "EvalOps managed");
        assert_eq!(
            context.control_plane_environment.as_deref(),
            Some("production")
        );
        assert_eq!(context.trace_ingestion, "live");
        assert_eq!(context.evidence_publisher, "EvalOps");
        assert_eq!(context.inference, "managed");
        let output = format_managed_status(&context);
        assert!(output.contains("Mode: EvalOps managed"));
        assert!(output.contains("Agent: agent_1"));
        assert!(output.contains("Run: run_9"));
        assert!(output.contains("API key: evk_live"));
        assert!(output.contains("Trace ingestion: live"));
    }

    #[test]
    fn env_overrides_take_precedence_for_workspace_and_owner() {
        let snapshot = EvalOpsCredentialSnapshot {
            access: "tok".to_owned(),
            refresh: String::new(),
            expires: 0,
            email: None,
            organization_id: Some("org_stored".to_owned()),
            user_id: None,
            identity_base_url: None,
            provider_ref: None,
            agent_mcp: Some(EvalOpsAgentMcpSnapshot {
                agent_id: Some("agent_stored".to_owned()),
                api_key: Some("key".to_owned()),
                endpoint: Some("https://staging.evalops.dev/mcp".to_owned()),
                workspace_id: Some("ws_stored".to_owned()),
                runtime_owner: Some("external".to_owned()),
                ..EvalOpsAgentMcpSnapshot::default()
            }),
        };
        let mut env = HashMap::new();
        env.insert(
            "MAESTRO_EVALOPS_WORKSPACE_ID".to_owned(),
            "ws_env".to_owned(),
        );
        env.insert(
            "MAESTRO_EVALOPS_RUNTIME_OWNER".to_owned(),
            "evalops".to_owned(),
        );
        let context = resolve_managed_context(Some(&snapshot), &env);
        assert_eq!(context.workspace_id.as_deref(), Some("ws_env"));
        assert_eq!(context.runtime_owner.as_deref(), Some("evalops"));
        assert_eq!(
            context.control_plane_environment.as_deref(),
            Some("staging")
        );
    }

    #[test]
    fn control_plane_environment_maps_known_hosts() {
        assert_eq!(
            control_plane_environment(Some("https://app.evalops.dev/mcp")).as_deref(),
            Some("production")
        );
        assert_eq!(
            control_plane_environment(Some("https://staging.evalops.dev/mcp")).as_deref(),
            Some("staging")
        );
        assert_eq!(
            control_plane_environment(Some("https://custom.example/mcp")).as_deref(),
            Some("custom.example")
        );
        assert_eq!(control_plane_environment(None), None);
    }
}

//! Product credential mode: mandatory EvalOps Identity plus managed inference
//! or local BYOK.
//!
//! Every process must have a live EvalOps Identity session before it can start
//! a model turn. Once signed in, it can use managed inference when its session
//! has workspace scope, or a local provider credential (BYOK). There is no
//! anonymous provider path.

use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::{
    ProviderRegistry, canonical_managed_credential_name, canonical_managed_environment,
};
use crate::init_cli::EvalOpsCredentialSnapshot;
use crate::service_connections::ConnectionStore;

pub const ACCESS_TOKEN_ENV: &str = "MAESTRO_EVALOPS_ACCESS_TOKEN";
pub const ACCESS_TOKEN_FILE_ENV: &str = "MAESTRO_EVALOPS_ACCESS_TOKEN_FILE";
pub const BASE_URL_ENV: &str = "MAESTRO_EVALOPS_BASE_URL";
pub const ORG_ID_ENV: &str = "MAESTRO_EVALOPS_ORG_ID";
pub const WORKSPACE_ID_ENV: &str = "MAESTRO_EVALOPS_WORKSPACE_ID";
pub const PROVIDER_ENV: &str = "MAESTRO_EVALOPS_PROVIDER";
pub const ENVIRONMENT_ENV: &str = "MAESTRO_EVALOPS_ENVIRONMENT";
pub const CREDENTIAL_NAME_ENV: &str = "MAESTRO_EVALOPS_CREDENTIAL_NAME";
pub const TEAM_ID_ENV: &str = "MAESTRO_EVALOPS_TEAM_ID";

pub const IDENTITY_REQUIRED_MESSAGE: &str = "An EvalOps Identity account is required. Run `deixic-code evalops login` to sign in or create one.";
pub const NOT_READY_MESSAGE: &str =
    "No usable local provider credential. Run `deixic-code setup --byok`.";

const IDENTITY_REQUIRED_SCOPE: &str = "llm_gateway:invoke";
const IDENTITY_INTROSPECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The deliberately small projection used to validate a local Identity
/// session. Tenant scope is derived only from this signed Identity response;
/// caller-provided `MAESTRO_EVALOPS_ORG_ID` / workspace values are never
/// trusted for a user-facing model turn.
#[derive(Debug, Deserialize)]
struct IdentityIntrospection {
    #[serde(default)]
    active: bool,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    scope: String,
}

/// A minimal live Identity endpoint shared by process-isolated Maestro tests.
///
/// Child fixtures must use the real verification path rather than implicitly
/// skipping Identity admission just because they are test binaries. The parent
/// test process keeps this loopback endpoint alive and passes its URL into the
/// child explicitly.
#[cfg(test)]
pub(crate) fn test_identity_base_url() -> &'static str {
    use std::io::{Read as _, Write as _};
    use std::sync::OnceLock;

    static IDENTITY_BASE_URL: OnceLock<String> = OnceLock::new();
    IDENTITY_BASE_URL
        .get_or_init(|| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("bind test Identity server");
            let address = listener.local_addr().expect("test Identity address");
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else {
                        continue;
                    };
                    let mut request = [0_u8; 4 * 1024];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let request = String::from_utf8_lossy(&request[..n]);
                    let (status, body) = test_identity_introspect_response(&request);
                    let reason = match status {
                        200 => "OK",
                        401 => "Unauthorized",
                        404 => "Not Found",
                        _ => "Error",
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            format!("http://{address}")
        })
        .as_str()
}

#[cfg(test)]
const TEST_IDENTITY_ACTIVE_BODY: &str = r#"{"active":true,"subject":"user-test","token_type":"access","organization_id":"org-test","workspace_id":"workspace-test","scopes":["llm_gateway:invoke"]}"#;

#[cfg(test)]
fn test_identity_introspect_response(request: &str) -> (u16, &'static str) {
    let first_line = request.lines().next().unwrap_or_default();
    let method_path = first_line.to_ascii_lowercase();
    if !method_path.starts_with("post ") || !method_path.contains("/v1/tokens/introspect") {
        return (404, r#"{"active":false}"#);
    }
    let token = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("authorization") {
            return None;
        }
        let value = value.trim();
        let (scheme, remainder) = value.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("bearer") {
            return None;
        }
        let token = remainder.trim();
        (!token.is_empty()).then_some(token)
    });
    match token {
        Some("inactive-token") => (
            200,
            r#"{"active":false,"subject":"user-test","token_type":"access","organization_id":"org-test","workspace_id":"workspace-test","scopes":["llm_gateway:invoke"]}"#,
        ),
        Some("unscoped-token") => (
            200,
            r#"{"active":true,"subject":"user-test","token_type":"access","organization_id":"org-test","workspace_id":"workspace-test","scopes":[]}"#,
        ),
        Some(_) => (200, TEST_IDENTITY_ACTIVE_BODY),
        None => (401, r#"{"active":false}"#),
    }
}

/// Process-global Identity env used by Maestro tests that construct a live
/// native agent. Callers must hold [`crate::config::test_process_env_lock`]
/// and restore the previous values on drop.
#[cfg(test)]
pub(crate) fn install_test_identity_env() {
    std::env::set_var(ACCESS_TOKEN_ENV, "fixture-evalops-access-token");
    std::env::set_var(ORG_ID_ENV, "fixture-evalops-org");
    std::env::set_var("MAESTRO_IDENTITY_URL", test_identity_base_url());
    std::env::set_var(crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV, "1");
}

#[cfg(test)]
pub(crate) const TEST_IDENTITY_ENV_VARS: &[&str] = &[
    ACCESS_TOKEN_ENV,
    ACCESS_TOKEN_FILE_ENV,
    ORG_ID_ENV,
    WORKSPACE_ID_ENV,
    "MAESTRO_IDENTITY_URL",
    crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialModeKind {
    Platform,
    Byok,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlatformSession {
    pub access_token: String,
    pub organization_id: String,
    pub workspace_id: Option<String>,
    pub provider_ref: Value,
    pub email: Option<String>,
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DetectedMode {
    Platform(PlatformSession),
    Byok,
}

impl DetectedMode {
    #[must_use]
    pub fn kind(&self) -> CredentialModeKind {
        match self {
            Self::Platform(_) => CredentialModeKind::Platform,
            Self::Byok => CredentialModeKind::Byok,
        }
    }

    #[must_use]
    pub fn is_platform(&self) -> bool {
        matches!(self, Self::Platform(_))
    }
}

/// Detect the active product mode from a snapshot and environment map.
///
/// Canonical identity env vars are `MAESTRO_EVALOPS_ACCESS_TOKEN` and
/// `MAESTRO_EVALOPS_ORG_ID`. Legacy aliases are ignored.
pub fn detect_from(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
) -> Option<DetectedMode> {
    if let Some(session) = platform_session_from(snapshot, env) {
        return Some(DetectedMode::Platform(session));
    }
    Some(DetectedMode::Byok)
}

/// Detect mode from stored EvalOps credentials and the process environment.
pub fn detect() -> Result<DetectedMode> {
    let snapshot = crate::init_cli::load_evalops_snapshot().ok().flatten();
    let env = std::env::vars().collect();
    Ok(detect_from(snapshot.as_ref(), &env).unwrap_or(DetectedMode::Byok))
}

/// Evaluate whether a supplied Identity session can serve `model`.
///
/// An explicit `openrouter/...` route is always BYOK after Identity is
/// established. Other local provider credentials also select BYOK after
/// Identity, while a scoped session without a local credential uses
/// llm-gateway. Production model construction calls [`require_ready`], which
/// verifies the supplied session against Identity first; this deterministic
/// helper is retained for diagnostics and unit tests.
pub fn require_ready_from(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
    model: &str,
) -> Result<DetectedMode> {
    let Some(session) = platform_session_from(snapshot, env) else {
        bail!("{IDENTITY_REQUIRED_MESSAGE}");
    };

    ready_mode_from_session(session, env, model)
}

fn ready_mode_from_session(
    session: PlatformSession,
    env: &HashMap<String, String>,
    model: &str,
) -> Result<DetectedMode> {
    if prefers_local_byok(model) {
        if byok_ready(model, env) {
            return Ok(DetectedMode::Byok);
        }
        bail!("{NOT_READY_MESSAGE}");
    }
    if byok_ready(model, env) || is_delegated_byok_transport(model) {
        return Ok(DetectedMode::Byok);
    }

    if session
        .workspace_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        Ok(DetectedMode::Platform(session))
    } else {
        bail!("EvalOps managed provider requires {WORKSPACE_ID_ENV}")
    }
}

pub fn require_ready(model: &str) -> Result<DetectedMode> {
    require_ready_with_identity(model).map(|(mode, _identity)| mode)
}

/// Resolve a ready provider mode together with the same live Identity session
/// that authorized it.
///
/// BYOK intentionally remains `DetectedMode::Byok`, but it is still admitted
/// only after this session is verified. Native telemetry uses the returned
/// session to bind a completed turn to its originating tenant rather than
/// rediscovering whatever account happens to be active during a later retry.
pub(crate) fn require_ready_with_identity(model: &str) -> Result<(DetectedMode, PlatformSession)> {
    let (session, mut env) = current_verified_identity_session_with_env()?;
    crate::service_connections::ConnectionBroker::merge_default_for_model(model, &mut env)?;
    let mode = ready_mode_from_session(session.clone(), &env, model)?;
    Ok((mode, session))
}

/// Return the currently configured Identity session only after live
/// verification. Best-effort delivery paths use this instead of trusting a
/// mutable local snapshot, so a durable record is never replayed under a
/// bearer whose tenant scope has changed.
#[cfg(not(test))]
pub(crate) fn current_verified_identity_session() -> Result<PlatformSession> {
    current_verified_identity_session_with_env().map(|(session, _env)| session)
}

fn current_verified_identity_session_with_env() -> Result<(PlatformSession, HashMap<String, String>)>
{
    let mut env = std::env::vars().collect::<HashMap<String, String>>();
    // An explicit Identity session is sufficient and avoids touching the
    // platform credential store (which may be an interactive OS keychain).
    // Fall back to the stored OAuth snapshot only when the process did not
    // provide both canonical Identity values.
    let snapshot = if platform_session_from(None, &env).is_some() {
        None
    } else {
        crate::init_cli::load_evalops_snapshot().ok().flatten()
    };
    let _ = crate::codex_auth::merge_codex_auth_snapshot_into_env(
        &mut env,
        crate::codex_auth::read_codex_auth(),
        false,
    );
    let session = verify_live_identity_session(snapshot.as_ref(), &env)?;
    Ok((session, env))
}

/// Load and verify the current human Identity session for a product-owned
/// child operation such as Session History ingestion.
pub(crate) fn verified_current_identity_session() -> Result<PlatformSession> {
    let env = std::env::vars().collect::<HashMap<String, String>>();
    let snapshot = if platform_session_from(None, &env).is_some() {
        None
    } else {
        crate::init_cli::load_evalops_snapshot().ok().flatten()
    };
    verify_live_identity_session(snapshot.as_ref(), &env)
}

/// Verify the access token with EvalOps Identity before it authorizes a local
/// provider or Codex transport. This is intentionally synchronous at the
/// native-agent construction boundary: it prevents a caller from starting an
/// upstream model turn until Identity has confirmed a live human session.
///
/// The request runs on a short-lived OS thread because the public constructor
/// can be called from both synchronous code and an active Tokio runtime.
fn verify_live_identity_session(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
) -> Result<PlatformSession> {
    let Some(unverified) = platform_session_from(snapshot, env) else {
        bail!("{IDENTITY_REQUIRED_MESSAGE}");
    };
    let identity_base_url = crate::init_cli::evalops_identity_base_url(snapshot, env)
        .with_context(|| IDENTITY_REQUIRED_MESSAGE.to_owned())?;
    let token = unverified.access_token.clone();
    let introspection = std::thread::spawn(move || -> Result<IdentityIntrospection> {
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(IDENTITY_INTROSPECTION_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none());
        if identity_base_url.starts_with("https://") {
            builder = builder.https_only(true);
        }
        let response = builder
            .build()
            .context("build EvalOps Identity verification client")?
            .post(format!("{identity_base_url}/v1/tokens/introspect"))
            .bearer_auth(token)
            .send()
            .context("contact EvalOps Identity")?;

        if response.status().is_redirection() {
            bail!("EvalOps Identity returned a redirect; admission does not follow redirects")
        }
        if !response.status().is_success() {
            bail!("EvalOps Identity rejected this session")
        }

        // Parse and drop the blocking response on this worker thread. Moving
        // it back into a Tokio task makes reqwest try to tear down its private
        // runtime from an async context, which panics before the model turn.
        response
            .json()
            .context("decode EvalOps Identity verification response")
    })
    .join()
    .map_err(|_| anyhow::anyhow!("EvalOps Identity verification thread panicked"))?
    .with_context(|| IDENTITY_REQUIRED_MESSAGE.to_owned())?;
    verified_platform_session(unverified, introspection)
}

fn verified_platform_session(
    mut session: PlatformSession,
    introspection: IdentityIntrospection,
) -> Result<PlatformSession> {
    let organization_id = introspection
        .organization_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let workspace_id = introspection
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let has_required_scope = introspection
        .scopes
        .iter()
        .map(String::as_str)
        .chain(introspection.scope.split_whitespace())
        .any(|scope| scope == IDENTITY_REQUIRED_SCOPE);
    if !introspection.active
        || introspection.subject.trim().is_empty()
        || introspection.token_type != "access"
        || organization_id.is_none()
        || !has_required_scope
    {
        bail!("{IDENTITY_REQUIRED_MESSAGE} Identity could not verify this session.");
    }

    // Never let an environment variable or mutable local credential snapshot
    // select a tenant different from the signed Identity token.
    session.organization_id = organization_id.expect("checked above").to_owned();
    session.workspace_id = workspace_id.map(str::to_owned);
    Ok(session)
}

fn prefers_local_byok(model: &str) -> bool {
    ProviderRegistry::resolve_descriptor(model)
        .is_ok_and(|descriptor| descriptor.id == "openrouter")
}

pub fn platform_session_from(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
) -> Option<PlatformSession> {
    let access_token = env_value(env, ACCESS_TOKEN_ENV)
        .or_else(|| file_env_value(env, ACCESS_TOKEN_ENV))
        .or_else(|| {
            snapshot
                .map(|value| value.access.trim().to_owned())
                .filter(|value| !value.is_empty())
        })?;
    let organization_id = env_value(env, ORG_ID_ENV).or_else(|| {
        snapshot
            .and_then(|value| value.organization_id.clone())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })?;
    let workspace_id = env_value(env, WORKSPACE_ID_ENV).or_else(|| {
        snapshot
            .and_then(|value| value.agent_mcp.as_ref())
            .and_then(|meta| meta.workspace_id.clone())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    });
    let provider_ref = snapshot
        .and_then(|value| value.provider_ref.clone())
        .unwrap_or_else(|| default_provider_ref(env, None));
    Some(PlatformSession {
        access_token,
        organization_id,
        workspace_id,
        provider_ref,
        email: snapshot.and_then(|value| value.email.clone()),
        user_id: snapshot.and_then(|value| value.user_id.clone()),
    })
}

/// True when BYOK can serve `model` from env, connections, or delegated login.
pub fn byok_ready(model: &str, env: &HashMap<String, String>) -> bool {
    byok_sources_ready(model, env) || connection_covers_provider(model, env).unwrap_or(false)
}

/// Env, file, and delegated-login sources only. Does not read connections.json.
pub fn byok_sources_ready(model: &str, env: &HashMap<String, String>) -> bool {
    let Ok(descriptor) = ProviderRegistry::resolve_descriptor(model) else {
        return false;
    };
    if !descriptor.requires_auth() {
        return true;
    }
    if descriptor.auth_env.iter().any(|name| {
        env.get(*name).is_some_and(|value| !value.trim().is_empty())
            || env
                .get(&format!("{name}_FILE"))
                .is_some_and(|value| !value.trim().is_empty())
    }) {
        return true;
    }
    if descriptor.id == "openai" && crate::openai_cli::has_stored_oauth_credential() {
        return true;
    }
    matches!(descriptor.id, "openai-codex" | "codex")
        && crate::codex_auth::read_codex_auth().is_some_and(|snap| snap.has_usable_credential())
}

fn is_delegated_byok_transport(model: &str) -> bool {
    ProviderRegistry::resolve_descriptor(model)
        .is_ok_and(|descriptor| matches!(descriptor.id, "openai-codex" | "codex"))
}

pub fn connection_covers_provider(model: &str, env: &HashMap<String, String>) -> Result<bool> {
    let provider_id = ProviderRegistry::resolve_descriptor(model)?.id;
    let store = match ConnectionStore::load(&ConnectionStore::default_path()?) {
        Ok(store) => store,
        Err(_) => return Ok(false),
    };
    let explicit = env
        .get("MAESTRO_CONNECTION")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok(store
        .selected(provider_id, explicit)?
        .is_some_and(|connection| {
            connection.state == crate::service_connections::ConnectionState::Active
        }))
}

impl PlatformSession {
    /// Environment for a managed `evalops/` client. Local provider keys are omitted.
    pub fn managed_env(
        &self,
        model: &str,
        source_env: &HashMap<String, String>,
    ) -> Result<HashMap<String, String>> {
        let workspace_id = self
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("EvalOps managed provider requires {WORKSPACE_ID_ENV}")
            })?;
        let mut env = HashMap::new();
        env.insert(ACCESS_TOKEN_ENV.to_owned(), self.access_token.clone());
        if let Some(base_url) = env_value(source_env, BASE_URL_ENV) {
            env.insert(BASE_URL_ENV.to_owned(), base_url);
        }
        env.insert(ORG_ID_ENV.to_owned(), self.organization_id.clone());
        env.insert(WORKSPACE_ID_ENV.to_owned(), workspace_id.to_owned());
        let provider = vendor_provider_id(model, &self.provider_ref)?;
        env.insert(PROVIDER_ENV.to_owned(), provider);
        env.insert(
            ENVIRONMENT_ENV.to_owned(),
            provider_ref_string(&self.provider_ref, "environment")
                .unwrap_or_else(|| canonical_managed_environment(None)),
        );
        env.insert(
            CREDENTIAL_NAME_ENV.to_owned(),
            provider_ref_string(&self.provider_ref, "credential_name")
                .unwrap_or_else(|| canonical_managed_credential_name(None)),
        );
        if let Some(team_id) = provider_ref_string(&self.provider_ref, "team_id") {
            env.insert(TEAM_ID_ENV.to_owned(), team_id);
        }
        Ok(env)
    }

    /// Route the selected model through the EvalOps managed provider.
    pub fn managed_model_route(&self, model: &str) -> String {
        let bare = model
            .split_once('/')
            .map(|(_, rest)| rest)
            .filter(|rest| !rest.is_empty())
            .unwrap_or(model);
        format!("evalops/{bare}")
    }
}

pub fn vendor_provider_id(model: &str, provider_ref: &Value) -> Result<String> {
    let descriptor = ProviderRegistry::resolve_descriptor(model)?;
    if matches!(descriptor.id, "evalops" | "maestro-managed") {
        return Ok(provider_ref_string(provider_ref, "provider")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "openai".to_owned()));
    }
    Ok(descriptor.id.to_owned())
}

pub fn default_provider_ref(env: &HashMap<String, String>, provider: Option<&str>) -> Value {
    let mut value = serde_json::json!({
        "provider": provider
            .map(str::to_owned)
            .or_else(|| env_value(env, PROVIDER_ENV))
            .unwrap_or_else(|| "openai".to_owned()),
        "environment": canonical_managed_environment(env_value(env, ENVIRONMENT_ENV).as_deref()),
        "credential_name": canonical_managed_credential_name(
            env_value(env, CREDENTIAL_NAME_ENV).as_deref(),
        ),
    });
    if let Some(team_id) = env_value(env, TEAM_ID_ENV) {
        value["team_id"] = Value::String(team_id);
    }
    value
}

pub fn env_value(env: &HashMap<String, String>, name: &str) -> Option<String> {
    env.get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn file_env_value(env: &HashMap<String, String>, name: &str) -> Option<String> {
    let path = env_value(env, &format!("{name}_FILE"))?;
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn provider_ref_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn setup_next_commands(
    provider: &str,
    identity_required: bool,
    byok_required: bool,
) -> Vec<(&'static str, &'static str, String)> {
    let byok_command = if matches!(provider, "openai-codex" | "codex") {
        "deixic-code codex login".to_owned()
    } else {
        "deixic-code connections add".to_owned()
    };
    let mut commands = Vec::new();
    if identity_required {
        commands.push((
            "evalops-login",
            "Sign in to EvalOps Identity (required for every Maestro session).",
            "deixic-code evalops login".to_owned(),
        ));
    }
    if byok_required {
        commands.push((
            "byok",
            "Add a local API key or provider login after Identity sign-in.",
            byok_command,
        ));
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_cli::{EvalOpsAgentMcpSnapshot, EvalOpsCredentialSnapshot};

    struct EnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvRestore {
        fn capture(names: &[&'static str]) -> Self {
            Self(
                names
                    .iter()
                    .copied()
                    .map(|name| (name, std::env::var_os(name)))
                    .collect(),
            )
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    fn snapshot(org: &str, token: &str) -> EvalOpsCredentialSnapshot {
        EvalOpsCredentialSnapshot {
            access: token.to_owned(),
            refresh: "refresh".to_owned(),
            expires: 1,
            email: Some("user@evalops.dev".to_owned()),
            organization_id: Some(org.to_owned()),
            user_id: Some("user_1".to_owned()),
            identity_base_url: Some("https://identity.evalops.dev".to_owned()),
            provider_ref: Some(serde_json::json!({
                "provider": "anthropic",
                "environment": "production",
                "credential_name": "default"
            })),
            agent_mcp: Some(EvalOpsAgentMcpSnapshot {
                workspace_id: Some("workspace_1".to_owned()),
                ..EvalOpsAgentMcpSnapshot::default()
            }),
        }
    }

    fn snapshot_without_workspace(org: &str, token: &str) -> EvalOpsCredentialSnapshot {
        let mut snapshot = snapshot(org, token);
        snapshot.agent_mcp = None;
        snapshot
    }

    fn active_introspection(
        organization_id: &str,
        workspace_id: Option<&str>,
    ) -> IdentityIntrospection {
        IdentityIntrospection {
            active: true,
            subject: "user_1".to_owned(),
            token_type: "access".to_owned(),
            organization_id: Some(organization_id.to_owned()),
            workspace_id: workspace_id.map(str::to_owned),
            scopes: vec![IDENTITY_REQUIRED_SCOPE.to_owned()],
            scope: String::new(),
        }
    }

    #[test]
    fn verified_identity_scope_overrides_mutable_local_tenant_values() {
        let session = PlatformSession {
            access_token: "access".to_owned(),
            organization_id: "forged-org".to_owned(),
            workspace_id: Some("forged-workspace".to_owned()),
            provider_ref: serde_json::json!({}),
            email: None,
            user_id: None,
        };

        let verified =
            verified_platform_session(session, active_introspection("org_1", Some("workspace_1")))
                .expect("active human token with the Maestro scope");

        assert_eq!(verified.organization_id, "org_1");
        assert_eq!(verified.workspace_id.as_deref(), Some("workspace_1"));
    }

    #[test]
    fn identity_introspection_does_not_follow_redirects() {
        use std::io::{Read as _, Write as _};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let _guard = crate::config::test_process_env_lock();
        let _restore = EnvRestore::capture(&[
            "MAESTRO_HOME",
            ACCESS_TOKEN_ENV,
            ACCESS_TOKEN_FILE_ENV,
            ORG_ID_ENV,
            WORKSPACE_ID_ENV,
            "MAESTRO_IDENTITY_URL",
            crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV,
        ]);

        let destination_hits = Arc::new(AtomicUsize::new(0));
        let destination = std::net::TcpListener::bind("127.0.0.1:0").expect("redirect target");
        let destination_addr = destination.local_addr().expect("redirect target addr");
        let destination_hits_for_server = Arc::clone(&destination_hits);
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = destination.accept() {
                let mut buf = [0_u8; 1024];
                let _ = stream.read(&mut buf);
                destination_hits_for_server.fetch_add(1, Ordering::SeqCst);
                let body = r#"{"active":true,"subject":"user-test","token_type":"access","organization_id":"org-test","workspace_id":"workspace-test","scopes":["llm_gateway:invoke"]}"#;
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });

        let origin = std::net::TcpListener::bind("127.0.0.1:0").expect("redirect origin");
        let origin_addr = origin.local_addr().expect("redirect origin addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = origin.accept() {
                let mut buf = [0_u8; 1024];
                let _ = stream.read(&mut buf);
                let location = format!("http://{destination_addr}/v1/tokens/introspect");
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
            }
        });

        let maestro_home = tempfile::tempdir().expect("maestro home");
        std::env::set_var("MAESTRO_HOME", maestro_home.path());
        std::env::set_var(ACCESS_TOKEN_ENV, "redirect-token");
        std::env::set_var(ORG_ID_ENV, "attacker-org");
        std::env::set_var("MAESTRO_IDENTITY_URL", format!("http://{origin_addr}"));
        std::env::set_var(crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV, "1");
        std::env::remove_var(ACCESS_TOKEN_FILE_ENV);
        std::env::remove_var(WORKSPACE_ID_ENV);

        let error = require_ready_with_identity("openai/gpt-5.5")
            .expect_err("a redirected Identity hop must fail closed");
        let rendered = format!("{error:#}");
        assert!(
            rendered.contains("redirect") || rendered.contains("rejected this session"),
            "{rendered}"
        );
        assert_eq!(
            destination_hits.load(Ordering::SeqCst),
            0,
            "introspection must not follow a 302 to a second origin"
        );
    }

    #[test]
    fn test_identity_fixture_rejects_missing_bearer_and_wrong_method() {
        let base = test_identity_base_url();
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .expect("identity fixture client");
        let missing = client
            .post(format!("{base}/v1/tokens/introspect"))
            .send()
            .expect("missing bearer");
        assert_eq!(missing.status().as_u16(), 401, "{}", missing.status());
        let wrong_method = client
            .get(format!("{base}/v1/tokens/introspect"))
            .bearer_auth("fixture-evalops-access-token")
            .send()
            .expect("wrong method");
        assert_eq!(
            wrong_method.status().as_u16(),
            404,
            "{}",
            wrong_method.status()
        );
    }

    #[test]
    fn live_introspection_rejects_inactive_and_unscoped_tokens() {
        let _guard = crate::config::test_process_env_lock();
        let _restore = EnvRestore::capture(&[
            "MAESTRO_HOME",
            ACCESS_TOKEN_ENV,
            ACCESS_TOKEN_FILE_ENV,
            ORG_ID_ENV,
            WORKSPACE_ID_ENV,
            "MAESTRO_IDENTITY_URL",
            crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV,
        ]);
        let maestro_home = tempfile::tempdir().expect("maestro home");
        std::env::set_var("MAESTRO_HOME", maestro_home.path());
        std::env::set_var(ORG_ID_ENV, "org-test");
        std::env::set_var("MAESTRO_IDENTITY_URL", test_identity_base_url());
        std::env::set_var(crate::init_cli::TEST_IDENTITY_AUTHORITY_ENV, "1");
        std::env::remove_var(ACCESS_TOKEN_FILE_ENV);
        std::env::remove_var(WORKSPACE_ID_ENV);

        std::env::set_var(ACCESS_TOKEN_ENV, "inactive-token");
        let inactive = require_ready_with_identity("openai/gpt-5.5")
            .expect_err("inactive live token must fail closed");
        assert!(
            format!("{inactive:#}").contains("Identity could not verify this session"),
            "{inactive:#}"
        );

        std::env::set_var(ACCESS_TOKEN_ENV, "unscoped-token");
        let unscoped = require_ready_with_identity("openai/gpt-5.5")
            .expect_err("unscoped live token must fail closed");
        assert!(
            format!("{unscoped:#}").contains("Identity could not verify this session"),
            "{unscoped:#}"
        );
    }

    #[test]
    fn verified_identity_rejects_inactive_nonhuman_and_unscoped_tokens() {
        let session = PlatformSession {
            access_token: "access".to_owned(),
            organization_id: "org_1".to_owned(),
            workspace_id: Some("workspace_1".to_owned()),
            provider_ref: serde_json::json!({}),
            email: None,
            user_id: None,
        };
        let mut inactive = active_introspection("org_1", Some("workspace_1"));
        inactive.active = false;
        assert!(verified_platform_session(session.clone(), inactive).is_err());

        let mut service = active_introspection("org_1", Some("workspace_1"));
        service.token_type = "service".to_owned();
        assert!(verified_platform_session(session.clone(), service).is_err());

        let mut unscoped = active_introspection("org_1", Some("workspace_1"));
        unscoped.scopes.clear();
        assert!(verified_platform_session(session, unscoped).is_err());
    }

    #[test]
    fn stored_evalops_session_is_platform_mode() {
        let mode = detect_from(Some(&snapshot("org_1", "tok")), &HashMap::new()).expect("mode");
        assert!(mode.is_platform());
        let DetectedMode::Platform(session) = mode else {
            panic!("expected platform");
        };
        assert_eq!(session.organization_id, "org_1");
        assert_eq!(session.access_token, "tok");
    }

    #[test]
    fn canonical_env_session_is_platform_mode() {
        let env = HashMap::from([
            (ACCESS_TOKEN_ENV.to_owned(), "env-tok".to_owned()),
            (ORG_ID_ENV.to_owned(), "org_env".to_owned()),
        ]);
        let mode = detect_from(None, &env).expect("mode");
        let DetectedMode::Platform(session) = mode else {
            panic!("expected platform");
        };
        assert_eq!(session.organization_id, "org_env");
        assert_eq!(session.access_token, "env-tok");
    }

    #[test]
    fn legacy_evalops_token_alias_is_ignored() {
        let env = HashMap::from([
            ("EVALOPS_TOKEN".to_owned(), "legacy".to_owned()),
            (
                "EVALOPS_ORGANIZATION_ID".to_owned(),
                "org_legacy".to_owned(),
            ),
        ]);
        let mode = detect_from(None, &env).expect("mode");
        assert_eq!(mode.kind(), CredentialModeKind::Byok);
    }

    #[test]
    fn platform_managed_env_preserves_gateway_url_and_omits_local_provider_keys() {
        let source_env = HashMap::from([
            (
                BASE_URL_ENV.to_owned(),
                "http://127.0.0.1:4321/v1".to_owned(),
            ),
            ("ANTHROPIC_API_KEY".to_owned(), "local-key".to_owned()),
        ]);
        let session =
            platform_session_from(Some(&snapshot("org_1", "tok")), &source_env).expect("session");
        let env = session
            .managed_env("anthropic/claude-opus-4-6", &source_env)
            .expect("env");
        assert_eq!(env.get(ACCESS_TOKEN_ENV).map(String::as_str), Some("tok"));
        assert_eq!(
            env.get(BASE_URL_ENV).map(String::as_str),
            Some("http://127.0.0.1:4321/v1")
        );
        assert_eq!(env.get(ORG_ID_ENV).map(String::as_str), Some("org_1"));
        assert_eq!(
            env.get(WORKSPACE_ID_ENV).map(String::as_str),
            Some("workspace_1")
        );
        assert_eq!(env.get(PROVIDER_ENV).map(String::as_str), Some("anthropic"));
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        let resolved = ProviderRegistry::require(
            &session.managed_model_route("anthropic/claude-opus-4-6"),
            &env,
        )
        .expect("managed provider route");
        assert_eq!(
            resolved.base_url.as_deref(),
            Some("http://127.0.0.1:4321/v1")
        );
        assert_eq!(
            session.managed_model_route("anthropic/claude-opus-4-6"),
            "evalops/claude-opus-4-6"
        );
    }

    #[test]
    fn byok_ready_requires_a_usable_local_credential() {
        let empty = HashMap::new();
        assert!(!byok_sources_ready("anthropic/claude-opus-4-6", &empty));
        let env = HashMap::from([("ANTHROPIC_API_KEY".to_owned(), "sk-test".to_owned())]);
        assert!(byok_sources_ready("anthropic/claude-opus-4-6", &env));
    }

    #[test]
    fn require_ready_fails_when_neither_mode_can_serve() {
        let error = require_ready_from(None, &HashMap::new(), "anthropic/claude-opus-4-6")
            .expect_err("should fail closed");
        assert!(error.to_string().contains("deixic-code evalops login"));
    }

    #[test]
    fn require_ready_accepts_platform_without_local_keys() {
        let mode = require_ready_from(
            Some(&snapshot("org_1", "tok")),
            &HashMap::new(),
            "anthropic/claude-opus-4-6",
        )
        .expect("platform is ready");
        assert!(mode.is_platform());
    }

    #[test]
    fn require_ready_allows_byok_after_identity_without_workspace() {
        let snapshot = snapshot_without_workspace("org_1", "tok");
        let env = HashMap::from([("ANTHROPIC_API_KEY".to_owned(), "local-key".to_owned())]);
        let mode = require_ready_from(Some(&snapshot), &env, "anthropic/claude-opus-4-6")
            .expect("an Identity session must permit a local provider credential");
        assert_eq!(mode.kind(), CredentialModeKind::Byok);

        let session = platform_session_from(Some(&snapshot), &env).expect("platform identity");
        assert!(
            session
                .managed_env("anthropic/claude-opus-4-6", &env)
                .is_err()
        );
    }

    #[test]
    fn require_ready_keeps_explicit_openrouter_on_byok() {
        let env = HashMap::from([("OPENROUTER_API_KEY".to_owned(), "or-test".to_owned())]);
        let mode = require_ready_from(
            Some(&snapshot("org_1", "tok")),
            &env,
            "openrouter/openai/o4-mini",
        )
        .expect("openrouter stays local");
        assert!(!mode.is_platform());
    }

    #[test]
    fn require_ready_rejects_byok_without_an_identity_account() {
        let env = HashMap::from([("OPENROUTER_API_KEY".to_owned(), "or-test".to_owned())]);
        let error = require_ready_from(None, &env, "openrouter/openai/o4-mini")
            .expect_err("BYOK must not bypass EvalOps Identity");
        assert!(error.to_string().contains("deixic-code evalops login"));
    }

    #[test]
    fn platform_managed_env_builds_evalops_llm_gateway_client() {
        let source_env = HashMap::new();
        let session =
            platform_session_from(Some(&snapshot("org_1", "tok")), &source_env).expect("session");
        let env = session
            .managed_env("anthropic/claude-opus-4-6", &source_env)
            .expect("env");
        let client = crate::ai::UnifiedClient::from_model_with_env(
            &session.managed_model_route("anthropic/claude-opus-4-6"),
            &env,
        )
        .expect("managed client");
        assert!(
            matches!(client, crate::ai::UnifiedClient::OpenAI(_)),
            "platform mode must use the llm-gateway OpenAI-compatible transport"
        );
        assert_eq!(client.provider_name(), "anthropic");
    }
}

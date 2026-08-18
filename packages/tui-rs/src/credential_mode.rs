//! Product credential mode: Platform identity session or local BYOK.
//!
//! A process is in Platform mode when a live EvalOps identity session exists.
//! Otherwise it is in BYOK mode and must have a usable local connection or
//! provider credential before a model turn starts. There is no third stack
//! and Platform mode does not fall back to local provider keys.

use std::collections::HashMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::{
    canonical_managed_credential_name, canonical_managed_environment, ProviderRegistry,
};
use crate::init_cli::EvalOpsCredentialSnapshot;
use crate::service_connections::ConnectionStore;

pub const ACCESS_TOKEN_ENV: &str = "MAESTRO_EVALOPS_ACCESS_TOKEN";
pub const ORG_ID_ENV: &str = "MAESTRO_EVALOPS_ORG_ID";
pub const WORKSPACE_ID_ENV: &str = "MAESTRO_EVALOPS_WORKSPACE_ID";
pub const PROVIDER_ENV: &str = "MAESTRO_EVALOPS_PROVIDER";
pub const ENVIRONMENT_ENV: &str = "MAESTRO_EVALOPS_ENVIRONMENT";
pub const CREDENTIAL_NAME_ENV: &str = "MAESTRO_EVALOPS_CREDENTIAL_NAME";
pub const TEAM_ID_ENV: &str = "MAESTRO_EVALOPS_TEAM_ID";

pub const NOT_READY_MESSAGE: &str = "No EvalOps session and no local API key. Run `maestro setup`.";

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

/// Fail closed unless Platform is live or BYOK can serve `model`.
///
/// An explicit `openrouter/...` route is always BYOK. A leftover EvalOps
/// identity session must not send that traffic to llm-gateway or ignore the
/// local connection store.
pub fn require_ready_from(
    snapshot: Option<&EvalOpsCredentialSnapshot>,
    env: &HashMap<String, String>,
    model: &str,
) -> Result<DetectedMode> {
    if prefers_local_byok(model) {
        if byok_ready(model, env) {
            return Ok(DetectedMode::Byok);
        }
        bail!("{NOT_READY_MESSAGE}");
    }
    match detect_from(snapshot, env) {
        Some(DetectedMode::Platform(session)) => Ok(DetectedMode::Platform(session)),
        Some(DetectedMode::Byok)
            if byok_sources_ready(model, env) || is_delegated_byok_transport(model) =>
        {
            Ok(DetectedMode::Byok)
        }
        _ => bail!("{NOT_READY_MESSAGE}"),
    }
}

pub fn require_ready(model: &str) -> Result<DetectedMode> {
    let snapshot = crate::init_cli::load_evalops_snapshot().ok().flatten();
    let mut env = std::env::vars().collect::<HashMap<String, String>>();
    let _ = crate::codex_auth::merge_codex_auth_snapshot_into_env(
        &mut env,
        crate::codex_auth::read_codex_auth(),
        false,
    );
    crate::service_connections::ConnectionBroker::merge_default_for_model(model, &mut env)?;
    require_ready_from(snapshot.as_ref(), &env, model)
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
    pub fn managed_env(&self, model: &str) -> Result<HashMap<String, String>> {
        let mut env = HashMap::new();
        env.insert(ACCESS_TOKEN_ENV.to_owned(), self.access_token.clone());
        env.insert(ORG_ID_ENV.to_owned(), self.organization_id.clone());
        if let Some(workspace_id) = &self.workspace_id {
            env.insert(WORKSPACE_ID_ENV.to_owned(), workspace_id.clone());
        }
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

pub fn setup_next_commands(provider: &str) -> Vec<(&'static str, &'static str, String)> {
    let byok_command = if matches!(provider, "openai-codex" | "codex") {
        "maestro codex login".to_owned()
    } else {
        "maestro connections add".to_owned()
    };
    vec![
        (
            "evalops-login",
            "Sign in to EvalOps for managed inference.",
            "maestro evalops login".to_owned(),
        ),
        (
            "byok",
            "Or add a local API key / provider login.",
            byok_command,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_cli::EvalOpsCredentialSnapshot;

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
            agent_mcp: None,
        }
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
    fn platform_managed_env_omits_local_provider_keys() {
        let session = platform_session_from(Some(&snapshot("org_1", "tok")), &HashMap::new())
            .expect("session");
        let env = session
            .managed_env("anthropic/claude-opus-4-6")
            .expect("env");
        assert_eq!(env.get(ACCESS_TOKEN_ENV).map(String::as_str), Some("tok"));
        assert_eq!(env.get(ORG_ID_ENV).map(String::as_str), Some("org_1"));
        assert_eq!(env.get(PROVIDER_ENV).map(String::as_str), Some("anthropic"));
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
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
        assert!(error.to_string().contains("maestro setup"));
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
    fn platform_managed_env_builds_evalops_llm_gateway_client() {
        let session = platform_session_from(Some(&snapshot("org_1", "tok")), &HashMap::new())
            .expect("session");
        let env = session
            .managed_env("anthropic/claude-opus-4-6")
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

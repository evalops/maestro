//! Codex-owned ChatGPT / API auth from `CODEX_HOME` (`~/.codex/auth.json`).
//!
//! Interactive native agent startup prefers Codex when that file has usable
//! credentials, matching the product default: bare `maestro` should use
//! `openai-codex/gpt-5.5` once `maestro codex login` has succeeded.
//!
//! Env vars already set by the user (or CLI flags) always win. We never write
//! Codex tokens into `~/.maestro/keys.json`. Native `openai-codex/*` turns let
//! Codex app-server read this file directly; the environment export helper is
//! retained only for direct-provider compatibility paths.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Default model when Codex ChatGPT auth is available and `MAESTRO_MODEL` is unset.
pub const DEFAULT_CODEX_MODEL: &str = "openai-codex/gpt-5.5";

/// Canonical route selected for a model id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexModelRoute {
    AppServer { model_id: String },
    DirectProvider,
}

impl CodexModelRoute {
    #[must_use]
    pub fn uses_app_server(&self) -> bool {
        matches!(self, Self::AppServer { .. })
    }
}

/// Resolve the transport and provider-native model id once for every caller.
///
/// Explicit provider namespaces win. Bare ids containing `codex` remain
/// supported for compatibility, while unrelated namespaces such
/// as `openai/codex-*` stay on the direct OpenAI transport.
#[must_use]
pub fn resolve_model_route(model: &str) -> CodexModelRoute {
    let trimmed = model.trim();
    if let Some((namespace, model_id)) = trimmed.split_once('/') {
        let namespace = namespace.trim().to_ascii_lowercase();
        let model_id = model_id.trim();
        if matches!(namespace.as_str(), "openai-codex" | "codex") && !model_id.is_empty() {
            return CodexModelRoute::AppServer {
                model_id: model_id.to_owned(),
            };
        }
        return CodexModelRoute::DirectProvider;
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("codex") {
        CodexModelRoute::AppServer {
            model_id: trimmed.to_owned(),
        }
    } else {
        CodexModelRoute::DirectProvider
    }
}
/// Fallback when no Codex auth and no `MAESTRO_MODEL` (OpenAI platform default).
pub const DEFAULT_PLATFORM_MODEL: &str = "gpt-5.5";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexAuthSnapshot {
    /// `chatgpt` (subscription) or `apiKey` (platform key stored by Codex).
    pub auth_mode: Option<String>,
    pub access_token: Option<String>,
    pub account_id: Option<String>,
    /// Present when Codex stored a platform API key (`OPENAI_API_KEY` field).
    pub api_key: Option<String>,
}

impl CodexAuthSnapshot {
    /// True when this snapshot can authenticate at least one OpenAI path.
    #[must_use]
    pub fn has_usable_credential(&self) -> bool {
        self.access_token
            .as_ref()
            .is_some_and(|t| !t.trim().is_empty())
            || self.api_key.as_ref().is_some_and(|k| !k.trim().is_empty())
    }

    /// Preferred interactive model id when this auth is the only source.
    #[must_use]
    pub fn preferred_default_model(&self) -> Option<&'static str> {
        if self
            .access_token
            .as_ref()
            .is_some_and(|t| !t.trim().is_empty())
        {
            Some(DEFAULT_CODEX_MODEL)
        } else if self.api_key.as_ref().is_some_and(|k| !k.trim().is_empty()) {
            // API-key mode still uses the OpenAI platform provider.
            Some(DEFAULT_PLATFORM_MODEL)
        } else {
            None
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct AuthFile {
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    #[serde(default)]
    tokens: Option<AuthTokens>,
}

#[derive(Debug, Default, Deserialize)]
struct AuthTokens {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}

/// `CODEX_HOME` or `~/.codex`.
#[must_use]
pub fn codex_home() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CODEX_HOME") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

/// Path to Codex auth file (`auth.json` under [`codex_home`]).
#[must_use]
pub fn codex_auth_path() -> Option<PathBuf> {
    codex_home().map(|home| home.join("auth.json"))
}

/// Read and parse Codex auth from an explicit path (tests / diagnostics).
#[must_use]
pub fn read_codex_auth_from(path: &Path) -> Option<CodexAuthSnapshot> {
    let raw = fs::read_to_string(path).ok()?;
    let file: AuthFile = serde_json::from_str(&raw).ok()?;
    let tokens = file.tokens.unwrap_or_default();
    let access_token = tokens
        .access_token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let account_id = tokens
        .account_id
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let api_key = file
        .openai_api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let snapshot = CodexAuthSnapshot {
        auth_mode: file
            .auth_mode
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        access_token,
        account_id,
        api_key,
    };
    if snapshot.has_usable_credential() {
        Some(snapshot)
    } else {
        None
    }
}

/// Read Codex auth from the standard `CODEX_HOME/auth.json` location.
#[must_use]
pub fn read_codex_auth() -> Option<CodexAuthSnapshot> {
    let path = codex_auth_path()?;
    read_codex_auth_from(&path)
}

/// Result of applying Codex auth into process environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexAuthApplyResult {
    pub auth_present: bool,
    pub injected_codex_token: bool,
    pub injected_api_key: bool,
    pub preferred_default_model: Option<&'static str>,
}

fn env_nonempty(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.to_string_lossy().trim().is_empty())
}

fn codex_token_env_already_set() -> bool {
    env_nonempty("OPENAI_CODEX_TOKEN")
        || env_nonempty("OPENAI_CODEX_ACCESS_TOKEN")
        || env_nonempty("CODEX_API_KEY")
}

fn set_env_var(name: &str, value: &str) {
    // Matching other startup injection sites in this crate (entrypoint).
    unsafe {
        std::env::set_var(name, value);
    }
}

/// Export Codex credentials into process env when missing, and report the
/// preferred default model for this machine.
///
/// Call once near process startup (before `NativeAgent` / `UnifiedClient`
/// construction). Safe to call multiple times.
#[must_use]
pub fn apply_codex_auth_to_process_env() -> CodexAuthApplyResult {
    apply_codex_auth_snapshot(read_codex_auth(), false)
}

/// Re-read `auth.json` and overwrite process Codex token env from disk.
///
/// Used after an API 401 so a refreshed ChatGPT access token written by
/// `codex login` / Codex app-server is picked up without restarting Maestro.
#[must_use]
pub fn refresh_codex_auth_to_process_env() -> CodexAuthApplyResult {
    apply_codex_auth_snapshot(read_codex_auth(), true)
}

/// Pure-ish apply used by tests: inject from an optional snapshot.
///
/// When `force` is true, overwrite existing `OPENAI_CODEX_TOKEN` /
/// `OPENAI_API_KEY` from the file (refresh path). When false, never clobber
/// user-provided env.
#[must_use]
pub fn apply_codex_auth_snapshot(
    snapshot: Option<CodexAuthSnapshot>,
    force: bool,
) -> CodexAuthApplyResult {
    let Some(snapshot) = snapshot else {
        return CodexAuthApplyResult::default();
    };
    if !snapshot.has_usable_credential() {
        return CodexAuthApplyResult::default();
    }

    let mut result = CodexAuthApplyResult {
        auth_present: true,
        preferred_default_model: snapshot.preferred_default_model(),
        ..Default::default()
    };

    // Platform API key stored by Codex (apiKey auth mode).
    if let Some(api_key) = snapshot.api_key.as_deref() {
        if force || !env_nonempty("OPENAI_API_KEY") {
            set_env_var("OPENAI_API_KEY", api_key);
            result.injected_api_key = true;
        }
    }

    // ChatGPT subscription access token → openai-codex provider env.
    if let Some(token) = snapshot.access_token.as_deref() {
        if force || !codex_token_env_already_set() {
            set_env_var("OPENAI_CODEX_TOKEN", token);
            result.injected_codex_token = true;
        }
        // Optional account id for backends that need it (harmless if unused).
        if let Some(account_id) = snapshot.account_id.as_deref() {
            if force || !env_nonempty("OPENAI_CODEX_ACCOUNT_ID") {
                set_env_var("OPENAI_CODEX_ACCOUNT_ID", account_id);
            }
        }
    }

    result
}

/// Merge Codex credentials into a caller-owned environment map.
///
/// This is the direct-provider counterpart to the process-env compatibility
/// helper above. It never reads or writes the process environment.
#[must_use]
pub fn merge_codex_auth_snapshot_into_env(
    env: &mut HashMap<String, String>,
    snapshot: Option<CodexAuthSnapshot>,
    force: bool,
) -> CodexAuthApplyResult {
    let Some(snapshot) = snapshot else {
        return CodexAuthApplyResult::default();
    };
    if !snapshot.has_usable_credential() {
        return CodexAuthApplyResult::default();
    }

    let mut result = CodexAuthApplyResult {
        auth_present: true,
        preferred_default_model: snapshot.preferred_default_model(),
        ..Default::default()
    };

    if let Some(api_key) = snapshot.api_key.as_deref() {
        let present = env
            .get("OPENAI_API_KEY")
            .is_some_and(|value| !value.trim().is_empty());
        if force || !present {
            env.insert("OPENAI_API_KEY".to_owned(), api_key.to_owned());
            result.injected_api_key = true;
        }
    }

    if let Some(token) = snapshot.access_token.as_deref() {
        let token_present = [
            "OPENAI_CODEX_TOKEN",
            "OPENAI_CODEX_ACCESS_TOKEN",
            "CODEX_API_KEY",
        ]
        .iter()
        .any(|name| env.get(*name).is_some_and(|value| !value.trim().is_empty()));
        if force || !token_present {
            env.insert("OPENAI_CODEX_TOKEN".to_owned(), token.to_owned());
            result.injected_codex_token = true;
        }
        if let Some(account_id) = snapshot.account_id.as_deref() {
            let account_present = env
                .get("OPENAI_CODEX_ACCOUNT_ID")
                .is_some_and(|value| !value.trim().is_empty());
            if force || !account_present {
                env.insert("OPENAI_CODEX_ACCOUNT_ID".to_owned(), account_id.to_owned());
            }
        }
    }

    result
}
/// True when the model id routes through the openai-codex provider.
#[must_use]
pub fn model_uses_openai_codex(model: &str) -> bool {
    resolve_model_route(model).uses_app_server()
}

/// Resolve the interactive/default model without exporting Codex credentials.
/// Explicit `MAESTRO_MODEL` wins, followed by the Codex default when auth is
/// present, and finally the platform default.
#[must_use]
pub fn resolve_default_model() -> String {
    if let Ok(model) = std::env::var("MAESTRO_MODEL") {
        let trimmed = model.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    read_codex_auth()
        .and_then(|snapshot| snapshot.preferred_default_model())
        .unwrap_or(DEFAULT_PLATFORM_MODEL)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env mutations are process-global; serialize tests that touch them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn write_auth(dir: &Path, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("auth.json"), body).unwrap();
    }

    #[test]
    fn reads_chatgpt_tokens_from_auth_json() {
        let dir = tempfile::tempdir().unwrap();
        write_auth(
            dir.path(),
            r#"{
              "auth_mode": "chatgpt",
              "OPENAI_API_KEY": null,
              "tokens": {
                "access_token": "access-secret",
                "account_id": "acct_123",
                "refresh_token": "refresh"
              }
            }"#,
        );
        let snap = read_codex_auth_from(&dir.path().join("auth.json")).unwrap();
        assert_eq!(snap.auth_mode.as_deref(), Some("chatgpt"));
        assert_eq!(snap.access_token.as_deref(), Some("access-secret"));
        assert_eq!(snap.account_id.as_deref(), Some("acct_123"));
        assert!(snap.api_key.is_none());
        assert_eq!(snap.preferred_default_model(), Some(DEFAULT_CODEX_MODEL));
    }

    #[test]
    fn reads_api_key_mode() {
        let dir = tempfile::tempdir().unwrap();
        write_auth(
            dir.path(),
            r#"{
              "auth_mode": "apiKey",
              "OPENAI_API_KEY": "sk-test",
              "tokens": null
            }"#,
        );
        let snap = read_codex_auth_from(&dir.path().join("auth.json")).unwrap();
        assert_eq!(snap.api_key.as_deref(), Some("sk-test"));
        assert_eq!(snap.preferred_default_model(), Some(DEFAULT_PLATFORM_MODEL));
    }

    #[test]
    fn empty_auth_is_none() {
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"auth_mode":"chatgpt","tokens":{}}"#);
        assert!(read_codex_auth_from(&dir.path().join("auth.json")).is_none());
    }

    #[test]
    fn injects_codex_token_when_env_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Clear relevant env for the test scope.
        unsafe {
            std::env::remove_var("OPENAI_CODEX_TOKEN");
            std::env::remove_var("OPENAI_CODEX_ACCESS_TOKEN");
            std::env::remove_var("CODEX_API_KEY");
            std::env::remove_var("OPENAI_API_KEY");
            std::env::remove_var("OPENAI_CODEX_ACCOUNT_ID");
        }

        let snap = CodexAuthSnapshot {
            auth_mode: Some("chatgpt".into()),
            access_token: Some("tok-xyz".into()),
            account_id: Some("acct".into()),
            api_key: None,
        };
        let result = apply_codex_auth_snapshot(Some(snap), false);
        assert!(result.auth_present);
        assert!(result.injected_codex_token);
        assert!(!result.injected_api_key);
        assert_eq!(result.preferred_default_model, Some(DEFAULT_CODEX_MODEL));
        assert_eq!(std::env::var("OPENAI_CODEX_TOKEN").unwrap(), "tok-xyz");
        assert_eq!(std::env::var("OPENAI_CODEX_ACCOUNT_ID").unwrap(), "acct");

        unsafe {
            std::env::remove_var("OPENAI_CODEX_TOKEN");
            std::env::remove_var("OPENAI_CODEX_ACCOUNT_ID");
        }
    }

    #[test]
    fn does_not_override_existing_codex_token() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var("OPENAI_CODEX_TOKEN", "already-set");
            std::env::remove_var("OPENAI_CODEX_ACCESS_TOKEN");
            std::env::remove_var("CODEX_API_KEY");
        }
        let snap = CodexAuthSnapshot {
            auth_mode: Some("chatgpt".into()),
            access_token: Some("from-file".into()),
            account_id: None,
            api_key: None,
        };
        let result = apply_codex_auth_snapshot(Some(snap), false);
        assert!(result.auth_present);
        assert!(!result.injected_codex_token);
        assert_eq!(std::env::var("OPENAI_CODEX_TOKEN").unwrap(), "already-set");
        unsafe {
            std::env::remove_var("OPENAI_CODEX_TOKEN");
        }
    }

    #[test]
    fn force_refresh_overwrites_stale_token() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var("OPENAI_CODEX_TOKEN", "stale");
            std::env::remove_var("OPENAI_CODEX_ACCESS_TOKEN");
            std::env::remove_var("CODEX_API_KEY");
        }
        let snap = CodexAuthSnapshot {
            auth_mode: Some("chatgpt".into()),
            access_token: Some("fresh".into()),
            account_id: None,
            api_key: None,
        };
        let result = apply_codex_auth_snapshot(Some(snap), true);
        assert!(result.injected_codex_token);
        assert_eq!(std::env::var("OPENAI_CODEX_TOKEN").unwrap(), "fresh");
        unsafe {
            std::env::remove_var("OPENAI_CODEX_TOKEN");
        }
    }

    #[test]
    fn model_route_normalizes_only_codex_namespaces() {
        assert_eq!(
            resolve_model_route(" OPENAI-CODEX/gpt-5.5 "),
            CodexModelRoute::AppServer {
                model_id: "gpt-5.5".to_owned(),
            },
        );
        assert_eq!(
            resolve_model_route("codex/gpt-5.5"),
            CodexModelRoute::AppServer {
                model_id: "gpt-5.5".to_owned(),
            },
        );
        assert!(resolve_model_route("gpt-5.1-codex-max").uses_app_server());
        assert!(resolve_model_route("codex-mini-latest").uses_app_server());
        assert_eq!(
            resolve_model_route("openai/codex-gpt"),
            CodexModelRoute::DirectProvider
        );
        assert_eq!(
            resolve_model_route("anthropic/codex"),
            CodexModelRoute::DirectProvider
        );
    }

    #[test]
    fn merge_codex_auth_into_env_is_local_and_respects_existing_values() {
        let mut env = HashMap::from([("OPENAI_API_KEY".to_owned(), "user-key".to_owned())]);
        let snapshot = CodexAuthSnapshot {
            auth_mode: Some("chatgpt".to_owned()),
            access_token: Some("file-token".to_owned()),
            account_id: Some("acct-1".to_owned()),
            api_key: Some("file-key".to_owned()),
        };
        let result = merge_codex_auth_snapshot_into_env(&mut env, Some(snapshot), false);
        assert!(result.auth_present);
        assert!(result.injected_codex_token);
        assert!(!result.injected_api_key);
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("user-key")
        );
        assert_eq!(
            env.get("OPENAI_CODEX_TOKEN").map(String::as_str),
            Some("file-token")
        );
        assert_eq!(
            env.get("OPENAI_CODEX_ACCOUNT_ID").map(String::as_str),
            Some("acct-1")
        );
    }

    #[test]
    fn model_uses_openai_codex_detects_prefix() {
        assert!(model_uses_openai_codex("openai-codex/gpt-5.5"));
        assert!(model_uses_openai_codex("gpt-5.1-codex-max"));
        assert!(!model_uses_openai_codex("openai/gpt-5.5"));
        assert!(!model_uses_openai_codex("claude-sonnet-4-6"));
    }

    #[test]
    fn resolve_default_model_respects_maestro_model() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var("MAESTRO_MODEL", "anthropic/claude-sonnet-4-6");
        }
        assert_eq!(resolve_default_model(), "anthropic/claude-sonnet-4-6");
        unsafe {
            std::env::remove_var("MAESTRO_MODEL");
        }
    }

    #[test]
    fn resolve_default_model_does_not_export_chatgpt_token() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_auth(
            dir.path(),
            r#"{
              "auth_mode": "chatgpt",
              "tokens": {"access_token": "access-secret"}
            }"#,
        );
        unsafe {
            std::env::set_var("CODEX_HOME", dir.path());
            std::env::remove_var("MAESTRO_MODEL");
            std::env::remove_var("OPENAI_CODEX_TOKEN");
            std::env::remove_var("OPENAI_CODEX_ACCOUNT_ID");
        }

        assert_eq!(resolve_default_model(), DEFAULT_CODEX_MODEL);
        assert!(std::env::var_os("OPENAI_CODEX_TOKEN").is_none());
        assert!(std::env::var_os("OPENAI_CODEX_ACCOUNT_ID").is_none());

        unsafe {
            std::env::remove_var("CODEX_HOME");
        }
    }
}

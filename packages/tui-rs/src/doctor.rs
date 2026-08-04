//! Typed native `maestro doctor` report.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::ai::{op_secret, ProviderProtocol, ProviderRegistry, ResolvedProvider};
use crate::model_catalog::{
    find_model, has_provider_mismatch, protocol_name, verify_model_offline, ModelInfo,
};

pub const REPORT_SCHEMA_VERSION: u32 = 1;
#[cfg(not(test))]
const LIVE_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const LIVE_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Warning,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub id: String,
    pub status: CheckStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub live: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectedModelReport {
    pub requested: String,
    pub provider: String,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<ModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorReport {
    pub schema_version: u32,
    pub ok: bool,
    pub live_requested: bool,
    pub selected_model: SelectedModelReport,
    pub checks: Vec<DoctorCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DoctorOptions {
    json: bool,
    live: bool,
    model: Option<String>,
}

fn parse_options(args: &[String]) -> Result<DoctorOptions> {
    let mut options = DoctorOptions {
        json: false,
        live: false,
        model: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => options.json = true,
            "--live" => options.live = true,
            "--model" => {
                index += 1;
                options.model = Some(args.get(index).context("--model requires a value")?.clone());
            }
            value if value.starts_with("--model=") => {
                options.model = Some(value[8..].to_owned());
            }
            "--help" | "-h" | "help" => bail!("help"),
            other => bail!("unknown doctor option: {other}"),
        }
        index += 1;
    }
    Ok(options)
}

fn check(
    id: &str,
    status: CheckStatus,
    summary: impl Into<String>,
    detail: Option<String>,
    live: bool,
) -> DoctorCheck {
    DoctorCheck {
        id: id.to_owned(),
        status,
        summary: summary.into(),
        detail,
        live,
    }
}

fn config_paths(cwd: &Path) -> Vec<PathBuf> {
    let mut paths = dirs::home_dir()
        .map(|home| vec![home.join(".composer/config.toml")])
        .unwrap_or_default();
    paths.push(cwd.join(".composer/config.toml"));
    paths
}

fn config_checks(cwd: &Path) -> Vec<DoctorCheck> {
    config_paths(cwd)
        .into_iter()
        .map(|path| {
            if !path.exists() {
                return check(
                    "config",
                    CheckStatus::Skipped,
                    format!("{} not present", path.display()),
                    None,
                    false,
                );
            }
            match std::fs::read_to_string(&path) {
                Ok(contents) => match toml::from_str::<crate::config::ComposerConfig>(&contents) {
                    Ok(_) => check(
                        "config",
                        CheckStatus::Pass,
                        format!("{} is valid TOML", path.display()),
                        None,
                        false,
                    ),
                    Err(error) => check(
                        "config",
                        CheckStatus::Fail,
                        format!("{} is invalid", path.display()),
                        Some(error.to_string()),
                        false,
                    ),
                },
                Err(error) => check(
                    "config",
                    CheckStatus::Fail,
                    format!("{} is unreadable", path.display()),
                    Some(error.to_string()),
                    false,
                ),
            }
        })
        .collect()
}

fn metadata_url(base_url: &str, suffix: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base_url).context("provider metadata URL is invalid")?;
    let path = format!(
        "{}/{}",
        url.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    );
    url.set_path(&path);
    Ok(url)
}

fn redacted_url(url: &reqwest::Url) -> String {
    let mut redacted = url.clone();
    let _ = redacted.set_username("");
    let _ = redacted.set_password(None);
    redacted.set_query(None);
    redacted.set_fragment(None);
    redacted.to_string()
}

fn metadata_request(
    client: &reqwest::Client,
    resolved: &ResolvedProvider,
    token: &str,
) -> Result<Option<(reqwest::RequestBuilder, ProviderProtocol)>> {
    let Some(base_url) = resolved.base_url.as_deref() else {
        return Ok(None);
    };
    let protocol = resolved.provider.protocol;
    let request = match protocol {
        ProviderProtocol::OpenAi | ProviderProtocol::OpenAiCompatible => client
            .get(metadata_url(base_url, "models")?)
            .bearer_auth(token),
        ProviderProtocol::Anthropic
        | ProviderProtocol::Google
        | ProviderProtocol::VertexAi
        | ProviderProtocol::Codex
        | ProviderProtocol::AzureOpenAi
        | ProviderProtocol::Bedrock
        | ProviderProtocol::Managed => return Ok(None),
    };
    Ok(Some((request, protocol)))
}

fn metadata_contains_model(
    payload: &serde_json::Value,
    protocol: ProviderProtocol,
    model: &str,
) -> bool {
    let entries = match protocol {
        ProviderProtocol::Google | ProviderProtocol::VertexAi => payload.get("models"),
        _ => payload.get("data"),
    }
    .and_then(serde_json::Value::as_array);
    entries.is_some_and(|entries| {
        entries.iter().any(|entry| {
            let id = match protocol {
                ProviderProtocol::Google | ProviderProtocol::VertexAi => entry.get("name"),
                _ => entry.get("id"),
            }
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
            let id = id.strip_prefix("models/").unwrap_or(id);
            id == model
        })
    })
}

fn request_error_detail(error: &reqwest::Error, endpoint: &str) -> String {
    if error.is_timeout() {
        format!("request to {endpoint} timed out")
    } else if error.is_connect() {
        format!("connection to {endpoint} failed")
    } else {
        format!("request to {endpoint} failed")
    }
}

async fn live_metadata_check_with_env(
    model: &SelectedModelReport,
    env: &HashMap<String, String>,
) -> DoctorCheck {
    let Ok(resolved) = ProviderRegistry::resolve(&model.requested, env) else {
        return check(
            "live_metadata",
            CheckStatus::Fail,
            "provider could not be resolved",
            None,
            true,
        );
    };
    let Some(token) = resolved.credential.as_deref() else {
        return check(
            "live_metadata",
            CheckStatus::Warning,
            "live metadata skipped: credentials unavailable",
            None,
            true,
        );
    };
    let client = match reqwest::Client::builder().timeout(LIVE_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => {
            return check(
                "live_metadata",
                CheckStatus::Fail,
                "HTTP client setup failed",
                None,
                true,
            )
        }
    };
    let (request, protocol) = match metadata_request(&client, &resolved, token) {
        Ok(Some(request)) => request,
        Ok(None) => {
            return check(
                "live_metadata",
                CheckStatus::Skipped,
                format!(
                    "{} does not have a safe native metadata probe",
                    resolved.provider.id
                ),
                None,
                true,
            )
        }
        Err(_) => {
            return check(
                "live_metadata",
                CheckStatus::Fail,
                "provider metadata endpoint is invalid",
                None,
                true,
            )
        }
    };
    let endpoint = request
        .try_clone()
        .and_then(|request| request.build().ok())
        .map_or_else(
            || "provider endpoint".to_owned(),
            |request| redacted_url(request.url()),
        );
    let started = Instant::now();
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let requested_model = model
                .requested
                .split_once('/')
                .map_or(model.requested.as_str(), |(_, model)| model);
            match response.json::<serde_json::Value>().await {
                Ok(payload) if metadata_contains_model(&payload, protocol, requested_model) => {
                    check(
                        "live_metadata",
                        CheckStatus::Pass,
                        format!(
                            "provider metadata confirmed {requested_model} in {} ms",
                            started.elapsed().as_millis()
                        ),
                        Some(endpoint),
                        true,
                    )
                }
                Ok(_) => check(
                    "live_metadata",
                    CheckStatus::Fail,
                    format!("provider metadata does not include {requested_model}"),
                    Some(endpoint),
                    true,
                ),
                Err(_) => check(
                    "live_metadata",
                    CheckStatus::Fail,
                    "provider metadata response is invalid",
                    Some(endpoint),
                    true,
                ),
            }
        }
        Ok(response) => {
            let status = response.status();
            let failed = matches!(status.as_u16(), 401 | 403) || status.is_server_error();
            check(
                "live_metadata",
                if failed {
                    CheckStatus::Fail
                } else {
                    CheckStatus::Warning
                },
                format!("provider metadata returned HTTP {status}"),
                Some(endpoint),
                true,
            )
        }
        Err(error) => check(
            "live_metadata",
            CheckStatus::Fail,
            "provider metadata request failed",
            Some(request_error_detail(&error, &endpoint)),
            true,
        ),
    }
}

async fn live_metadata_check(model: &SelectedModelReport) -> DoctorCheck {
    let env = std::env::vars().collect();
    live_metadata_check_with_env(model, &env).await
}

/// Providers covered by the doctor auth health section.
const AUTH_HEALTH_PROVIDERS: &[&str] = &[
    "openai",
    "openai-codex",
    "anthropic",
    "google",
    "vertex-ai",
    "xai",
];

/// Report credential availability for each well-known provider without ever
/// printing secret values. `op://` references are actually resolved through
/// the 1Password CLI so broken vault references surface here.
fn auth_health_checks(env: &HashMap<String, String>) -> Vec<DoctorCheck> {
    AUTH_HEALTH_PROVIDERS
        .iter()
        .map(|provider_id| auth_health_check(provider_id, env))
        .collect()
}

fn auth_health_check(provider_id: &str, env: &HashMap<String, String>) -> DoctorCheck {
    let Some(descriptor) = ProviderRegistry::descriptor(provider_id) else {
        return check(
            "auth_health",
            CheckStatus::Skipped,
            format!("{provider_id}: unknown provider"),
            None,
            false,
        );
    };
    let configured = descriptor.auth_env.iter().find_map(|name| {
        env.get(*name)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| (*name, value))
    });
    if let Some((name, value)) = configured {
        if op_secret::is_op_reference(value) {
            return match op_secret::resolve_credential(name, value) {
                Ok(_) => check(
                    "auth_health",
                    CheckStatus::Pass,
                    format!("{provider_id}: {name} op:// reference resolves via 1Password CLI"),
                    None,
                    false,
                ),
                Err(error) => check(
                    "auth_health",
                    CheckStatus::Fail,
                    format!("{provider_id}: {name} op:// reference could not be resolved"),
                    Some(format!("{error:#}")),
                    false,
                ),
            };
        }
        return check(
            "auth_health",
            CheckStatus::Pass,
            format!("{provider_id}: {name} is set"),
            None,
            false,
        );
    }
    if provider_id == "openai" && crate::openai_cli::has_stored_oauth_credential() {
        return check(
            "auth_health",
            CheckStatus::Pass,
            format!("{provider_id}: stored OAuth credential present"),
            None,
            false,
        );
    }
    if matches!(provider_id, "openai-codex" | "codex")
        && crate::codex_auth::read_codex_auth().is_some_and(|s| s.has_usable_credential())
    {
        return check(
            "auth_health",
            CheckStatus::Pass,
            format!("{provider_id}: CODEX_HOME/auth.json credential present"),
            crate::codex_auth::codex_auth_path().map(|p| p.display().to_string()),
            false,
        );
    }
    check(
        "auth_health",
        CheckStatus::Warning,
        format!("{provider_id}: no credential found"),
        Some(descriptor.auth_env.join(", ")),
        false,
    )
}

/// Dedicated Codex login surface so doctor is not API-key-centric when the
/// user is signed in via `maestro codex login`.
fn codex_login_health_check() -> DoctorCheck {
    match crate::codex_auth::read_codex_auth() {
        Some(snap) if snap.has_usable_credential() => {
            let mode = snap.auth_mode.as_deref().unwrap_or("unknown");
            let via = if snap.access_token.is_some() {
                "ChatGPT access token"
            } else {
                "API key in auth.json"
            };
            check(
                "codex_login",
                CheckStatus::Pass,
                format!("Codex auth available ({mode}, {via})"),
                crate::codex_auth::codex_auth_path().map(|p| p.display().to_string()),
                false,
            )
        }
        _ => check(
            "codex_login",
            CheckStatus::Warning,
            "Codex auth not found — run `maestro codex login` for ChatGPT subscription models",
            crate::codex_auth::codex_auth_path().map(|p| p.display().to_string()),
            false,
        ),
    }
}

/// Documents that `openai-codex/*` is the Codex app-server transport (not
/// Platform API-key HTTP). Only when the selected model provider is
/// openai-codex/codex (not merely because auth.json exists).
fn codex_app_server_transport_check(selected_provider: &str) -> DoctorCheck {
    if !matches!(selected_provider, "openai-codex" | "codex") {
        return check(
            "codex_app_server",
            CheckStatus::Skipped,
            "Codex app-server transport not selected (model is not openai-codex)",
            None,
            false,
        );
    }

    let spawn = crate::codex_app_server::resolve_spawn_command(None, None);
    let spawn_detail = match spawn.source {
        crate::codex_app_server::SpawnSource::BundledPackage => {
            format!(
                "bundled {}",
                spawn.args.first().cloned().unwrap_or_default()
            )
        }
        crate::codex_app_server::SpawnSource::Path => {
            format!("PATH binary `{}`", spawn.command)
        }
        crate::codex_app_server::SpawnSource::Override => {
            format!("override `{}`", spawn.command)
        }
    };

    let auth_ok =
        crate::codex_auth::read_codex_auth().is_some_and(|snap| snap.has_usable_credential());
    if auth_ok {
        check(
            "codex_app_server",
            CheckStatus::Pass,
            format!(
                "openai-codex path: Codex app-server (`thread/start`, `turn/start`); ChatGPT auth owned by Codex ({spawn_detail})"
            ),
            Some(spawn_detail),
            false,
        )
    } else {
        check(
            "codex_app_server",
            CheckStatus::Warning,
            format!(
                "Codex app-server spawn resolved ({spawn_detail}) but ChatGPT auth missing — run `maestro codex login`"
            ),
            Some(spawn_detail),
            false,
        )
    }
}

pub async fn build_report(model_override: Option<&str>, live: bool, cwd: &Path) -> DoctorReport {
    let config = crate::config::load_config(cwd, None);
    // load_config always merges DEFAULT_CONFIG.model = "gpt-5.5". When Codex
    // ChatGPT auth is present, prefer openai-codex/gpt-5.5 unless the user
    // set MAESTRO_MODEL or passed --model (same policy as spawn_agent).
    let codex_auth = crate::codex_auth::apply_codex_auth_to_process_env();
    let requested = model_override
        .map(str::to_owned)
        .filter(|m| !m.trim().is_empty())
        .or_else(|| {
            std::env::var("MAESTRO_MODEL")
                .ok()
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
        })
        .or_else(|| {
            let configured = config
                .model
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty());
            match (configured, codex_auth.preferred_default_model) {
                (Some(model), Some(codex_default))
                    if model == "gpt-5.5" || model == "gpt-5.1-codex-max" =>
                {
                    Some(codex_default.to_string())
                }
                (Some(model), _) => Some(model.to_string()),
                (None, Some(codex_default)) => Some(codex_default.to_string()),
                (None, None) => Some(crate::codex_auth::DEFAULT_PLATFORM_MODEL.to_string()),
            }
        })
        .unwrap_or_else(|| crate::codex_auth::DEFAULT_PLATFORM_MODEL.to_string());
    let env = std::env::vars().collect();
    let resolved = ProviderRegistry::resolve(&requested, &env);
    let (provider, protocol) = resolved.as_ref().map_or_else(
        |_| ("unknown".to_owned(), "unknown".to_owned()),
        |value| {
            (
                value.provider.id.to_owned(),
                protocol_name(value.provider.protocol).to_owned(),
            )
        },
    );
    let mut catalog = find_model(&requested);
    if let Some(model) = catalog.as_mut() {
        model.verification = verify_model_offline(&requested);
    }
    let selected_model = SelectedModelReport {
        requested: requested.clone(),
        provider,
        protocol,
        catalog,
    };
    let mut checks = config_checks(cwd);
    checks.push(match resolved {
        Ok(provider) if provider.credential.is_some() => check(
            "provider",
            CheckStatus::Pass,
            format!("{} resolved with credentials", provider.provider.id),
            provider.auth_source,
            false,
        ),
        Ok(provider) => check(
            "provider",
            CheckStatus::Warning,
            format!("{} resolved; credentials not found", provider.provider.id),
            Some(provider.provider.auth_env.join(", ")),
            false,
        ),
        Err(error) => check(
            "provider",
            CheckStatus::Fail,
            "provider resolution failed",
            Some(error.to_string()),
            false,
        ),
    });
    checks.extend(auth_health_checks(&env));
    checks.push(codex_login_health_check());
    checks.push(codex_app_server_transport_check(&selected_model.provider));
    checks.push(if has_provider_mismatch(&requested) {
        check(
            "model_catalog",
            CheckStatus::Fail,
            "selected model does not belong to the requested provider",
            Some(requested),
            false,
        )
    } else if selected_model.catalog.is_some() {
        check(
            "model_catalog",
            CheckStatus::Pass,
            "selected model has typed capability metadata",
            None,
            false,
        )
    } else {
        check(
            "model_catalog",
            CheckStatus::Warning,
            "selected model is not in the built-in capability catalog",
            Some(requested),
            false,
        )
    });
    match crate::codex_cli::codex_schema_diagnostics() {
        Ok(diagnostics) if diagnostics.is_empty() => checks.push(check(
            "codex_tools",
            CheckStatus::Pass,
            "Codex dynamic-tool schemas are compatible",
            None,
            false,
        )),
        Ok(diagnostics) => checks.push(check(
            "codex_tools",
            CheckStatus::Fail,
            "Codex dynamic-tool schema diagnostics found",
            Some(diagnostics.join("; ")),
            false,
        )),
        Err(error) => checks.push(check(
            "codex_tools",
            CheckStatus::Fail,
            "Codex tool profile is invalid",
            Some(error.to_string()),
            false,
        )),
    }
    if live {
        checks.push(live_metadata_check(&selected_model).await);
    } else {
        checks.push(check(
            "live_metadata",
            CheckStatus::Skipped,
            "live checks not requested",
            None,
            true,
        ));
    }
    let ok = !checks.iter().any(|item| item.status == CheckStatus::Fail);
    DoctorReport {
        schema_version: REPORT_SCHEMA_VERSION,
        ok,
        live_requested: live,
        selected_model,
        checks,
    }
}

pub async fn run_doctor(args: &[String]) -> Result<i32> {
    let options = match parse_options(args) {
        Ok(options) => options,
        Err(error) if error.to_string() == "help" => {
            println!("Usage: maestro doctor [--json] [--live] [--model <provider/model>]");
            return Ok(0);
        }
        Err(error) => return Err(error),
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let report = build_report(options.model.as_deref(), options.live, &cwd).await;
    if options.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("Maestro Doctor (schema v{})", report.schema_version);
        println!(
            "Model: {} ({}, {})",
            report.selected_model.requested,
            report.selected_model.provider,
            report.selected_model.protocol
        );
        for item in &report.checks {
            println!(
                "  {:<7} {:<16} {}",
                format!("{:?}", item.status).to_lowercase(),
                item.id,
                item.summary
            );
            if let Some(detail) = &item.detail {
                println!("          {detail}");
            }
        }
    }
    Ok(report_exit_code(&report))
}

fn report_exit_code(report: &DoctorReport) -> i32 {
    i32::from(!report.ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn selected_model(requested: &str) -> SelectedModelReport {
        SelectedModelReport {
            requested: requested.to_owned(),
            provider: "test".to_owned(),
            protocol: "test".to_owned(),
            catalog: find_model(requested),
        }
    }

    async fn test_server(
        status: u16,
        body: &'static str,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let handle = tokio::task::spawn_blocking(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut buffer = [0_u8; 4096];
            let bytes = stream.read(&mut buffer).expect("read test request");
            std::thread::sleep(delay);
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&buffer[..bytes]).into_owned()
        });
        (format!("http://{address}"), handle)
    }

    fn openai_env(base_url: String) -> HashMap<String, String> {
        HashMap::from([
            ("OPENAI_API_KEY".to_owned(), "bearer-secret".to_owned()),
            ("OPENAI_BASE_URL".to_owned(), base_url),
        ])
    }

    #[test]
    fn parses_supported_options() {
        let args = vec![
            "--json".into(),
            "--live".into(),
            "--model=openai/gpt-4o".into(),
        ];
        let options = parse_options(&args).expect("options");
        assert!(options.json && options.live);
        assert_eq!(options.model.as_deref(), Some("openai/gpt-4o"));
    }

    #[tokio::test]
    async fn offline_report_is_typed_and_skips_live_network() {
        let temp = tempfile::tempdir().expect("tempdir");
        let report = build_report(Some("openai/gpt-4o"), false, temp.path()).await;
        assert_eq!(report.schema_version, REPORT_SCHEMA_VERSION);
        assert!(report.selected_model.catalog.is_some());
        assert_eq!(
            report.checks.last().map(|check| check.status),
            Some(CheckStatus::Skipped)
        );
    }

    #[test]
    fn config_check_uses_runtime_config_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let config_dir = temp.path().join(".composer");
        std::fs::create_dir_all(&config_dir).expect("config directory");
        std::fs::write(config_dir.join("config.toml"), "model = 123\n")
            .expect("invalid runtime config");
        let checks = config_checks(temp.path());
        assert!(checks.iter().any(|check| {
            check
                .summary
                .contains(temp.path().to_string_lossy().as_ref())
                && check.status == CheckStatus::Fail
        }));
    }

    #[test]
    fn metadata_requests_only_probe_documented_protocols() {
        let client = reqwest::Client::new();

        let openai = ProviderRegistry::resolve(
            "openai/gpt-4o",
            &openai_env("https://example.com/v1".to_owned()),
        )
        .expect("OpenAI provider");
        let openai_request = metadata_request(&client, &openai, "openai-secret")
            .expect("OpenAI request")
            .expect("supported OpenAI probe")
            .0
            .build()
            .expect("build OpenAI request");
        assert_eq!(openai_request.url().path(), "/v1/models");
        assert_eq!(
            openai_request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer openai-secret"
        );

        let anthropic_env = HashMap::from([
            (
                "ANTHROPIC_API_KEY".to_owned(),
                "anthropic-secret".to_owned(),
            ),
            (
                "ANTHROPIC_BASE_URL".to_owned(),
                "https://example.com/v1".to_owned(),
            ),
        ]);
        let anthropic =
            ProviderRegistry::resolve("anthropic/claude-sonnet-4-5-20250514", &anthropic_env)
                .expect("Anthropic provider");
        assert!(metadata_request(&client, &anthropic, "anthropic-secret")
            .expect("Anthropic request")
            .is_none());

        let google_env = HashMap::from([
            ("GEMINI_API_KEY".to_owned(), "google-secret".to_owned()),
            (
                "GEMINI_BASE_URL".to_owned(),
                "https://example.com".to_owned(),
            ),
        ]);
        let google = ProviderRegistry::resolve("google/gemini-2.5-pro", &google_env)
            .expect("Google provider");
        assert!(metadata_request(&client, &google, "google-secret")
            .expect("Google request")
            .is_none());
    }

    #[tokio::test]
    async fn provider_model_mismatch_fails_report() {
        let temp = tempfile::tempdir().expect("tempdir");
        let report = build_report(Some("anthropic/gpt-4o"), false, temp.path()).await;
        assert!(!report.ok);
        assert_eq!(report_exit_code(&report), 1);
        assert!(report
            .checks
            .iter()
            .any(|check| { check.id == "model_catalog" && check.status == CheckStatus::Fail }));
    }

    #[tokio::test]
    async fn live_failures_are_fatal_and_redacted() {
        for status in [401, 403, 500] {
            let (base_url, server) = test_server(status, "{}", Duration::ZERO).await;
            let configured_url = format!(
                "http://user:password@{}?token=query-secret#fragment",
                base_url.trim_start_matches("http://")
            );
            let check = live_metadata_check_with_env(
                &selected_model("openai/gpt-4o"),
                &openai_env(configured_url),
            )
            .await;
            assert_eq!(check.status, CheckStatus::Fail);
            let serialized = serde_json::to_string(&check).expect("serialize check");
            for secret in [
                "user",
                "password",
                "query-secret",
                "fragment",
                "bearer-secret",
            ] {
                assert!(
                    !serialized.contains(secret),
                    "leaked {secret}: {serialized}"
                );
            }
            server.await.expect("test server");
        }
    }

    #[tokio::test]
    async fn live_timeout_and_missing_model_fail() {
        let (base_url, server) = test_server(
            200,
            r#"{"data":[{"id":"gpt-4o"}]}"#,
            Duration::from_millis(200),
        )
        .await;
        let timeout =
            live_metadata_check_with_env(&selected_model("openai/gpt-4o"), &openai_env(base_url))
                .await;
        assert_eq!(timeout.status, CheckStatus::Fail);
        assert!(timeout
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("timed out")));
        server.await.expect("timeout server");

        let (base_url, server) = test_server(200, r#"{"data":[]}"#, Duration::ZERO).await;
        let missing =
            live_metadata_check_with_env(&selected_model("openai/gpt-4o"), &openai_env(base_url))
                .await;
        assert_eq!(missing.status, CheckStatus::Fail);
        let report = DoctorReport {
            schema_version: REPORT_SCHEMA_VERSION,
            ok: false,
            live_requested: true,
            selected_model: selected_model("openai/gpt-4o"),
            checks: vec![missing],
        };
        assert_eq!(report_exit_code(&report), 1);
        server.await.expect("missing model server");
    }

    #[tokio::test]
    async fn unsupported_protocol_is_skipped() {
        let env = HashMap::from([
            ("AZURE_OPENAI_API_KEY".to_owned(), "secret".to_owned()),
            (
                "AZURE_OPENAI_ENDPOINT".to_owned(),
                "https://example.com".to_owned(),
            ),
        ]);
        let check =
            live_metadata_check_with_env(&selected_model("azure-openai/gpt-4o"), &env).await;
        assert_eq!(check.status, CheckStatus::Skipped);
    }

    #[test]
    fn auth_health_reports_env_key_without_printing_secret() {
        let env = HashMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "sk-plain-auth-health-secret".to_owned(),
        )]);
        let checks = auth_health_checks(&env);
        let openai = checks
            .iter()
            .find(|item| item.summary.starts_with("openai:"))
            .expect("openai auth health check");
        assert_eq!(openai.status, CheckStatus::Pass);
        assert!(openai.summary.contains("OPENAI_API_KEY is set"));
        let serialized = serde_json::to_string(&checks).expect("serialize checks");
        assert!(
            !serialized.contains("sk-plain-auth-health-secret"),
            "leaked secret: {serialized}"
        );
    }

    #[test]
    fn auth_health_resolves_op_reference() {
        let _fake = crate::ai::op_secret::test_support::FakeOp::install();
        let env = HashMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "op://vault/item/doctor-health".to_owned(),
        )]);
        let checks = auth_health_checks(&env);
        let openai = checks
            .iter()
            .find(|item| item.summary.starts_with("openai:"))
            .expect("openai auth health check");
        assert_eq!(openai.status, CheckStatus::Pass);
        assert!(openai.summary.contains("op:// reference resolves"));
        let serialized = serde_json::to_string(&checks).expect("serialize checks");
        assert!(
            !serialized.contains("resolved-secret-value"),
            "leaked secret: {serialized}"
        );
    }

    #[test]
    fn auth_health_flags_unresolvable_op_reference() {
        let _fake = crate::ai::op_secret::test_support::FakeOp::install();
        let env = HashMap::from([(
            "ANTHROPIC_API_KEY".to_owned(),
            "op://vault/item/missing".to_owned(),
        )]);
        let checks = auth_health_checks(&env);
        let anthropic = checks
            .iter()
            .find(|item| item.summary.starts_with("anthropic:"))
            .expect("anthropic auth health check");
        assert_eq!(anthropic.status, CheckStatus::Fail);
        let detail = anthropic.detail.as_deref().expect("failure detail");
        assert!(
            detail.contains("1Password CLI"),
            "detail should mention the op CLI: {detail}"
        );
    }

    #[test]
    fn auth_health_warns_when_no_credential() {
        let checks = auth_health_checks(&HashMap::new());
        assert_eq!(checks.len(), AUTH_HEALTH_PROVIDERS.len());
        for provider in ["anthropic", "google", "xai"] {
            let item = checks
                .iter()
                .find(|check| check.summary.starts_with(&format!("{provider}:")))
                .expect("provider auth health check");
            assert_eq!(item.status, CheckStatus::Warning, "{}", item.summary);
            assert!(item.summary.contains("no credential found"));
        }
        // openai / openai-codex may additionally have stored credentials on
        // disk; only assert those checks exist and never print a secret.
        assert!(checks
            .iter()
            .any(|check| check.summary.starts_with("openai:")));
        assert!(checks
            .iter()
            .any(|check| check.summary.starts_with("openai-codex:")));
        for check in &checks {
            assert!(
                !check.summary.contains("sk-")
                    && check
                        .detail
                        .as_deref()
                        .is_none_or(|d| !d.contains("sk-") && !d.contains("eyJ")),
                "auth_health must not print secrets: {:?}",
                check
            );
        }
    }
}

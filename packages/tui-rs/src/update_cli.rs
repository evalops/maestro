//! Native `maestro update` implementation.

use std::env;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};

const DEFAULT_GCS_URL: &str =
    "https://storage.googleapis.com/evalops-prod-maestro-releases/maestro/version.json";

#[derive(Debug, Clone, Deserialize)]
struct VersionMetadata {
    version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    source_url: String,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct UpdateArgs {
    check_only: bool,
    json: bool,
    help: bool,
}

fn parse_args(args: &[String]) -> Result<UpdateArgs> {
    let mut parsed = UpdateArgs::default();
    for arg in args {
        match arg.as_str() {
            "--check" => parsed.check_only = true,
            "--json" => parsed.json = true,
            "--help" | "-h" => parsed.help = true,
            other => bail!("Unknown maestro update option: {other}"),
        }
    }
    Ok(parsed)
}

fn update_urls(package: &str) -> Vec<String> {
    if let Ok(value) = env::var("MAESTRO_UPDATE_URLS") {
        let values = value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !values.is_empty() {
            return values;
        }
    }
    if let Ok(value) = env::var("MAESTRO_UPDATE_URL") {
        let value = value.trim();
        if !value.is_empty() {
            return vec![value.to_owned()];
        }
    }
    vec![
        DEFAULT_GCS_URL.to_owned(),
        format!(
            "https://registry.npmjs.org/{}/latest",
            urlencoding::encode(package)
        ),
    ]
}

async fn check_for_update(current: &str, package: &str) -> UpdateCheck {
    check_for_update_urls(current, update_urls(package)).await
}

async fn check_for_update_urls(current: &str, urls: Vec<String>) -> UpdateCheck {
    let current_version = Version::parse(current.trim());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();
    let mut best: Option<(Version, UpdateCheck)> = None;
    let mut last_error = None;
    let mut last_url = String::new();

    let Ok(client) = client else {
        return failed_check(current, "", "Failed to create update client");
    };
    let Ok(current_semver) = current_version else {
        return failed_check(current, "", "Current Maestro version is not valid semver");
    };

    for url in urls {
        last_url.clone_from(&url);
        let response = match client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = Some(format!("Update check failed ({})", response.status()));
            continue;
        }
        let metadata = match response.json::<VersionMetadata>().await {
            Ok(metadata) => metadata,
            Err(error) => {
                last_error = Some(format!("Invalid update metadata: {error}"));
                continue;
            }
        };
        let latest = match Version::parse(metadata.version.trim()) {
            Ok(version) => version,
            Err(error) => {
                last_error = Some(format!("Invalid update version: {error}"));
                continue;
            }
        };
        let status = if latest > current_semver {
            "available"
        } else {
            "current"
        };
        let check = UpdateCheck {
            status,
            current_version: current.to_owned(),
            latest_version: Some(latest.to_string()),
            source_url: url,
            error: None,
        };
        if best.as_ref().is_none_or(|(version, _)| latest > *version) {
            best = Some((latest, check));
        }
    }

    best.map_or_else(
        || {
            failed_check(
                current,
                &last_url,
                last_error
                    .as_deref()
                    .unwrap_or("No update metadata sources configured"),
            )
        },
        |(_, check)| check,
    )
}

fn failed_check(current: &str, source_url: &str, error: &str) -> UpdateCheck {
    UpdateCheck {
        status: "failed",
        current_version: current.to_owned(),
        latest_version: None,
        source_url: source_url.to_owned(),
        error: Some(error.to_owned()),
    }
}

fn package_manager() -> String {
    if let Ok(manager) = env::var("MAESTRO_UPDATE_PACKAGE_MANAGER") {
        if matches!(manager.as_str(), "npm" | "bun") {
            return manager;
        }
    }
    let executable = env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if executable.contains("/.bun/install/global/") {
        "bun".to_owned()
    } else {
        "npm".to_owned()
    }
}

fn install(package: &str, version: &str) -> Result<()> {
    let manager = package_manager();
    let spec = format!("{package}@{version}");
    let mut command = Command::new(&manager);
    command.args(["install", "-g", &spec]);
    sanitize_package_manager_env(&mut command);
    let status = command
        .status()
        .with_context(|| format!("Failed to launch {manager}"))?;
    if !status.success() {
        bail!("{manager} install exited with status {status}");
    }
    Ok(())
}

fn sanitize_package_manager_env(command: &mut Command) {
    for (key, _) in env::vars_os() {
        let key_text = key.to_string_lossy();
        if should_remove_package_manager_env(&key_text) {
            command.env_remove(key);
        }
    }
    command.env("MAESTRO_STARTUP_UPDATE_RETRY_MS", "0");
}

fn should_remove_package_manager_env(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let package_manager_setting = lower.starts_with("npm_config_")
        || lower.starts_with("bun_config_")
        || lower.starts_with("yarn_")
        || lower.starts_with("pnpm_");
    let allowed_prefix = lower == "npm_config_prefix";
    let blocked = matches!(
        key,
        "CI" | "NODE_ENV"
            | "NODE_OPTIONS"
            | "NPM_TOKEN"
            | "NODE_AUTH_TOKEN"
            | "MAESTRO_UPDATE_URL"
            | "MAESTRO_UPDATE_URLS"
            | "MAESTRO_STARTUP_UPDATE_STATE"
            | "MAESTRO_SKIP_STARTUP_UPDATE"
            | "MAESTRO_STARTUP_UPDATE"
    );
    blocked || (package_manager_setting && !allowed_prefix)
}

fn print_help() {
    println!("Usage: maestro update [--check] [--json]\n\nOptions:\n  --check   Check for the newest Maestro version without installing it\n  --json    Print machine-readable update status\n  --help    Show this help");
}

pub async fn run_update(args: &[String]) -> Result<i32> {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    if parsed.help {
        print_help();
        return Ok(0);
    }

    let current =
        env::var("MAESTRO_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    let package = env::var("MAESTRO_PACKAGE_NAME")
        .context("MAESTRO_PACKAGE_NAME must be set by the Maestro package launcher")?;
    let check = check_for_update(&current, &package).await;
    if parsed.check_only {
        if parsed.json {
            println!("{}", serde_json::to_string_pretty(&check)?);
        } else if check.status == "available" {
            println!(
                "Maestro {} is available (current {}).",
                check.latest_version.as_deref().unwrap_or("update"),
                current
            );
        } else if check.status == "current" {
            println!("Maestro is up to date ({current}).");
        } else {
            eprintln!(
                "Maestro update check failed: {}",
                check.error.as_deref().unwrap_or("unknown error")
            );
        }
        return Ok(i32::from(check.status == "failed"));
    }
    if check.status == "failed" {
        if parsed.json {
            println!("{}", serde_json::to_string_pretty(&check)?);
        } else {
            eprintln!(
                "Maestro update failed: {}",
                check.error.as_deref().unwrap_or("unknown error")
            );
        }
        return Ok(1);
    }
    if check.status == "current" {
        if parsed.json {
            println!("{}", serde_json::to_string_pretty(&check)?);
        } else {
            println!("Maestro is up to date ({current}).");
        }
        return Ok(0);
    }
    let latest = check
        .latest_version
        .as_deref()
        .context("Update metadata missing latest version")?;
    match install(&package, latest) {
        Ok(()) => {
            if parsed.json {
                let mut outcome = check.clone();
                outcome.status = "updated";
                println!("{}", serde_json::to_string_pretty(&outcome)?);
            } else {
                println!("Updated Maestro to {latest}.");
            }
            Ok(0)
        }
        Err(error) => {
            if parsed.json {
                let mut outcome = check;
                outcome.status = "failed";
                outcome.error = Some(format!("{error:#}"));
                println!("{}", serde_json::to_string_pretty(&outcome)?);
            } else {
                eprintln!("Maestro update failed: {error:#}");
            }
            Ok(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_update_options() {
        let args = vec!["--check".to_owned(), "--json".to_owned()];
        let parsed = parse_args(&args).expect("parse update args");
        assert!(parsed.check_only);
        assert!(parsed.json);
    }

    #[test]
    fn rejects_unknown_update_options() {
        let error = parse_args(&["--wat".to_owned()]).expect_err("unknown option");
        assert!(error.to_string().contains("Unknown maestro update option"));
    }

    #[test]
    fn strips_untrusted_package_manager_environment() {
        for key in [
            "NODE_OPTIONS",
            "NPM_TOKEN",
            "NODE_AUTH_TOKEN",
            "MAESTRO_UPDATE_URL",
            "npm_config_userconfig",
            "NPM_CONFIG_REGISTRY",
            "BUN_CONFIG_REGISTRY",
            "YARN_REGISTRY",
            "PNPM_HOME",
        ] {
            assert!(should_remove_package_manager_env(key), "kept {key}");
        }
        assert!(!should_remove_package_manager_env("PATH"));
        assert!(!should_remove_package_manager_env("NPM_CONFIG_PREFIX"));
        assert!(!should_remove_package_manager_env("npm_config_prefix"));
    }

    #[tokio::test]
    async fn checks_update_metadata_and_compares_semver() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).expect("read request");
            let body = r#"{"version":"0.11.0","notes":"native updater"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write response");
        });
        let check =
            check_for_update_urls("0.10.52", vec![format!("http://{address}/version.json")]).await;
        server.join().expect("join server");
        assert_eq!(check.status, "available");
        assert_eq!(check.latest_version.as_deref(), Some("0.11.0"));
    }
}

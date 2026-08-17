//! Native `maestro update` implementation.

use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use fd_lock::RwLock as FileLock;
use semver::Version;
use serde::{Deserialize, Serialize};
use wait_timeout::ChildExt;

const DEFAULT_GCS_URL: &str =
    "https://storage.googleapis.com/evalops-prod-maestro-releases/maestro/version.json";
const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_STARTUP_CHECK_TIMEOUT: Duration = Duration::from_millis(350);
const DEFAULT_STARTUP_RETRY: Duration = Duration::from_hours(24);
const INSTALL_TIMEOUT: Duration = Duration::from_mins(1);
#[cfg(unix)]
const INSTALL_CLEANUP_GRACE: Duration = Duration::from_secs(2);
const EMBEDDED_INSTALLER: &str = include_str!("../../../scripts/install.sh");

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupUpdateState {
    version: String,
    last_attempt_at: u64,
    last_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallContext {
    Package {
        manager: String,
        package: String,
        prefix: Option<PathBuf>,
        launcher: PathBuf,
    },
    Release {
        install_dir: PathBuf,
        data_dir: PathBuf,
        launcher: PathBuf,
    },
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

fn configured_update_urls() -> Option<Vec<String>> {
    if let Ok(value) = env::var("MAESTRO_UPDATE_URLS") {
        let values = value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !values.is_empty() {
            return Some(values);
        }
    }
    if let Ok(value) = env::var("MAESTRO_UPDATE_URL") {
        let value = value.trim();
        if !value.is_empty() {
            return Some(vec![value.to_owned()]);
        }
    }
    None
}

fn update_urls(package: &str) -> Vec<String> {
    configured_update_urls().unwrap_or_else(|| {
        vec![
            DEFAULT_GCS_URL.to_owned(),
            format!(
                "https://registry.npmjs.org/{}/latest",
                urlencoding::encode(package)
            ),
        ]
    })
}

fn trusted_startup_update_urls(context: &InstallContext) -> Vec<String> {
    match context {
        InstallContext::Package { package, .. } => vec![
            DEFAULT_GCS_URL.to_owned(),
            format!(
                "https://registry.npmjs.org/{}/latest",
                urlencoding::encode(package)
            ),
        ],
        InstallContext::Release { .. } => vec![DEFAULT_GCS_URL.to_owned()],
    }
}

async fn check_for_update(current: &str, context: &InstallContext) -> UpdateCheck {
    let urls = match context {
        InstallContext::Package { package, .. } => update_urls(package),
        InstallContext::Release { .. } => {
            configured_update_urls().unwrap_or_else(|| vec![DEFAULT_GCS_URL.to_owned()])
        }
    };
    check_for_update_urls_with_timeout(current, urls, DEFAULT_CHECK_TIMEOUT).await
}

#[cfg(test)]
async fn check_for_update_urls(current: &str, urls: Vec<String>) -> UpdateCheck {
    check_for_update_urls_with_timeout(current, urls, DEFAULT_CHECK_TIMEOUT).await
}

async fn check_for_update_urls_with_timeout(
    current: &str,
    urls: Vec<String>,
    timeout: Duration,
) -> UpdateCheck {
    let current_version = Version::parse(current.trim());
    let client = reqwest::Client::builder().timeout(timeout).build();
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

fn package_prefix(package_root: &Path, manager: &str) -> Option<PathBuf> {
    let normalized = package_root.to_string_lossy().replace('\\', "/");
    let marker = if manager == "bun" {
        "/install/global/node_modules/"
    } else {
        "/lib/node_modules/"
    };
    normalized
        .find(marker)
        .map(|index| {
            if manager == "bun" {
                PathBuf::from(format!("{}/install/global", &normalized[..index]))
            } else {
                PathBuf::from(&normalized[..index])
            }
        })
        .or_else(|| {
            (manager == "npm")
                .then(|| normalized.find("/node_modules/"))
                .flatten()
                .map(|index| PathBuf::from(&normalized[..index]))
        })
}

fn package_install_context_from(
    executable: &Path,
    package_root: &Path,
    package: String,
    manager_override: Option<&str>,
) -> Option<InstallContext> {
    let package_root = dunce::canonicalize(package_root).ok()?;
    let relative = executable.strip_prefix(&package_root).ok()?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    if components.len() != 4
        || components[0] != "vendor"
        || components[1] != "maestro"
        || components[3]
            != if cfg!(windows) {
                "maestro.exe"
            } else {
                "maestro"
            }
    {
        return None;
    }
    let manager = match manager_override {
        Some("npm") => "npm",
        Some("bun") => "bun",
        _ if package_root
            .to_string_lossy()
            .replace('\\', "/")
            .contains("/.bun/install/global/") =>
        {
            "bun"
        }
        _ => "npm",
    }
    .to_owned();
    let prefix = package_prefix(&package_root, &manager);
    Some(InstallContext::Package {
        manager,
        package,
        prefix,
        launcher: package_root.join("bin/maestro"),
    })
}

fn package_install_context(executable: &Path) -> Option<InstallContext> {
    let package = env::var("MAESTRO_PACKAGE_NAME").ok()?;
    let package_root = PathBuf::from(env::var_os("MAESTRO_PACKAGE_ROOT")?);
    let manager_override = env::var("MAESTRO_UPDATE_PACKAGE_MANAGER").ok();
    package_install_context_from(
        executable,
        &package_root,
        package,
        manager_override.as_deref(),
    )
}

fn release_install_context(executable: &Path) -> Option<InstallContext> {
    let install_dir = PathBuf::from(env::var_os("MAESTRO_INSTALL_DIR")?);
    let data_dir = PathBuf::from(env::var_os("MAESTRO_DATA_DIR")?);
    let releases = data_dir.join("releases");
    let relative = executable.strip_prefix(&releases).ok()?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    if components.len() != 4
        || components[2] != "bin"
        || components[3]
            != if cfg!(windows) {
                "maestro.exe"
            } else {
                "maestro"
            }
    {
        return None;
    }
    let launcher = install_dir.join(if cfg!(windows) {
        "maestro.exe"
    } else {
        "maestro"
    });
    launcher.is_file().then_some(InstallContext::Release {
        install_dir,
        data_dir,
        launcher,
    })
}

fn install_context() -> Option<InstallContext> {
    let executable = env::current_exe().ok()?;
    match env::var("MAESTRO_INSTALL_METHOD").ok().as_deref() {
        Some("package") => package_install_context(&executable),
        Some("release") => release_install_context(&executable),
        _ => None,
    }
}

fn run_with_timeout(command: &mut Command, label: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to launch {label}"))?;
    let Some(status) = child.wait_timeout(INSTALL_TIMEOUT)? else {
        #[cfg(unix)]
        {
            if let Ok(process_group_id) = i32::try_from(child.id()) {
                unsafe {
                    let _ = libc::kill(-process_group_id, libc::SIGTERM);
                }
                if child.wait_timeout(INSTALL_CLEANUP_GRACE)?.is_none() {
                    unsafe {
                        let _ = libc::kill(-process_group_id, libc::SIGKILL);
                    }
                }
            } else {
                let _ = child.kill();
            }
        }
        #[cfg(not(unix))]
        let _ = child.kill();
        let _ = child.wait();
        bail!(
            "{label} timed out after {} seconds",
            INSTALL_TIMEOUT.as_secs()
        );
    };
    if !status.success() {
        bail!("{label} exited with status {status}");
    }
    Ok(())
}

fn install_package(
    manager: &str,
    package: &str,
    prefix: Option<&Path>,
    version: &str,
) -> Result<()> {
    let spec = format!("{package}@{version}");
    let mut command = Command::new(manager);
    command.args(["install", "-g", &spec]);
    sanitize_package_manager_env(&mut command);
    if manager == "npm" {
        if let Some(prefix) = prefix {
            command.env("NPM_CONFIG_PREFIX", prefix);
        }
    } else if let Some(prefix) = prefix.and_then(Path::parent).and_then(Path::parent) {
        command.env("BUN_INSTALL", prefix);
    }
    run_with_timeout(&mut command, manager)
}

fn install_release(install_dir: &Path, data_dir: &Path, version: &str) -> Result<()> {
    let temporary = tempfile::tempdir().context("Failed to create updater directory")?;
    let installer = temporary.path().join("install.sh");
    fs::write(&installer, EMBEDDED_INSTALLER).context("Failed to stage embedded installer")?;
    let mut command = Command::new("bash");
    command.arg(&installer);
    sanitize_release_installer_env(&mut command);
    command
        .env("MAESTRO_INSTALL_VERSION", version)
        .env("MAESTRO_INSTALL_DIR", install_dir)
        .env("MAESTRO_DATA_DIR", data_dir)
        .env("MAESTRO_REQUIRE_SIGNED_INSTALL", "1")
        .env("MAESTRO_SKIP_STARTUP_UPDATE", "1");
    run_with_timeout(&mut command, "signed Maestro installer")
}

fn install(context: &InstallContext, version: &str) -> Result<()> {
    match context {
        InstallContext::Package {
            manager,
            package,
            prefix,
            ..
        } => install_package(manager, package, prefix.as_deref(), version),
        InstallContext::Release {
            install_dir,
            data_dir,
            ..
        } => install_release(install_dir, data_dir, version),
    }
}

fn launcher(context: &InstallContext) -> &Path {
    match context {
        InstallContext::Package { launcher, .. } | InstallContext::Release { launcher, .. } => {
            launcher
        }
    }
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

fn sanitize_release_installer_env(command: &mut Command) {
    for key in [
        "MAESTRO_ALLOW_UNSIGNED_INSTALL",
        "MAESTRO_RELEASE_BASE_URL",
        "MAESTRO_RELEASE_REPO",
        "MAESTRO_REQUIRE_SIGNED_INSTALL",
        "MAESTRO_INSTALL_VERSION",
        "MAESTRO_VERSION",
    ] {
        command.env_remove(key);
    }
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
            | "MAESTRO_AUTO_UPDATE"
            | "MAESTRO_PACKAGE_NAME"
            | "MAESTRO_PACKAGE_ROOT"
            | "MAESTRO_INSTALL_METHOD"
            | "MAESTRO_INSTALL_DIR"
            | "MAESTRO_DATA_DIR"
    );
    blocked || (package_manager_setting && !allowed_prefix)
}

fn env_duration(name: &str, default: Duration, allow_zero: bool) -> Duration {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| allow_zero || *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(default)
}

fn startup_state_path() -> Option<PathBuf> {
    env::var_os("MAESTRO_STARTUP_UPDATE_STATE")
        .map(PathBuf::from)
        .or_else(|| {
            crate::path_utils::maestro_home_dir().map(|home| home.join("startup-update-state.json"))
        })
}

fn read_startup_state(path: &Path) -> Option<StartupUpdateState> {
    let contents = fs::read(path).ok()?;
    serde_json::from_slice(&contents).ok()
}

fn write_startup_state(path: &Path, state: &StartupUpdateState) -> Result<()> {
    crate::path_utils::atomic_private_write(path, &serde_json::to_vec_pretty(state)?)
}

struct StartupUpdateLock {
    _lock: FileLock<fs::File>,
}

fn try_acquire_startup_update_lock(state_path: &Path) -> io::Result<Option<StartupUpdateLock>> {
    let lock_path = state_path.with_extension("lock");
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    let mut lock = FileLock::new(file);
    {
        let guard = match lock.try_write() {
            Ok(guard) => guard,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) => return Err(error),
        };
        // The operating-system lock is tied to the open file and is released
        // when `StartupUpdateLock` is dropped. Forgetting the borrowing guard
        // lets this function return ownership of that file-backed lock.
        std::mem::forget(guard);
    }
    Ok(Some(StartupUpdateLock { _lock: lock }))
}

fn should_throttle_startup_update(
    state: Option<&StartupUpdateState>,
    version: &str,
    now_ms: u64,
    retry: Duration,
) -> bool {
    let Some(state) = state else {
        return false;
    };
    state.version == version
        && now_ms.saturating_sub(state.last_attempt_at) < retry.as_millis() as u64
}

fn startup_update_mode() -> &'static str {
    let mode = env::var("MAESTRO_AUTO_UPDATE")
        .or_else(|_| env::var("MAESTRO_STARTUP_UPDATE"))
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(mode.as_str(), "0" | "false" | "off" | "skip" | "disabled") {
        "off"
    } else if matches!(mode.as_str(), "check" | "notice" | "notify") {
        "check"
    } else {
        "apply"
    }
}

fn startup_update_enabled() -> bool {
    env::var_os("MAESTRO_SKIP_STARTUP_UPDATE").is_none()
        && env::var_os("CI").is_none()
        && env::var("NODE_ENV").ok().as_deref() != Some("test")
        && startup_update_mode() != "off"
        && std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
}

/// Best-effort update of an installed interactive Maestro before the TUI starts.
///
/// Returns the restarted process exit code after a successful update. All check,
/// state, and install failures fail open so an unavailable update service can
/// never prevent Maestro from starting.
pub async fn run_startup_update(raw_args: &[std::ffi::OsString]) -> Option<i32> {
    if !startup_update_enabled() {
        return None;
    }
    let context = install_context()?;
    let current = env::var("MAESTRO_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into());
    let urls = trusted_startup_update_urls(&context);
    let total_timeout = env_duration(
        "MAESTRO_STARTUP_UPDATE_TIMEOUT_MS",
        DEFAULT_STARTUP_CHECK_TIMEOUT,
        false,
    );
    let source_count = u128::try_from(urls.len().max(1)).unwrap_or(1);
    let source_timeout = Duration::from_millis(
        u64::try_from((total_timeout.as_millis() / source_count).max(1)).unwrap_or(1),
    );
    let check = match tokio::time::timeout(
        total_timeout,
        check_for_update_urls_with_timeout(&current, urls, source_timeout),
    )
    .await
    {
        Ok(check) if check.status != "failed" => check,
        _ => return None,
    };
    if check.status != "available" {
        return None;
    }
    let latest = check.latest_version.as_deref()?;
    if startup_update_mode() == "check" {
        eprintln!("Maestro {latest} is available (current {current}); run `maestro update`.");
        return None;
    }

    let state_path = startup_state_path()?;
    let update_lock = try_acquire_startup_update_lock(&state_path).ok()??;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let retry = env_duration(
        "MAESTRO_STARTUP_UPDATE_RETRY_MS",
        DEFAULT_STARTUP_RETRY,
        true,
    );
    if should_throttle_startup_update(
        read_startup_state(&state_path).as_ref(),
        latest,
        now_ms,
        retry,
    ) {
        return None;
    }
    let attempted = StartupUpdateState {
        version: latest.to_owned(),
        last_attempt_at: now_ms,
        last_status: "failed".to_owned(),
    };
    if write_startup_state(&state_path, &attempted).is_err() {
        return None;
    }
    eprintln!("Updating Maestro from {current} to {latest}...");
    if let Err(error) = install(&context, latest) {
        eprintln!("Maestro auto-update failed; continuing with {current}: {error:#}");
        return None;
    }
    let completed = StartupUpdateState {
        last_status: "updated".to_owned(),
        ..attempted
    };
    let _ = write_startup_state(&state_path, &completed);
    eprintln!("Updated Maestro to {latest}; restarting.");
    drop(update_lock);

    let mut restart = Command::new(launcher(&context));
    restart
        .args(raw_args.iter().skip(1))
        .env_remove("MAESTRO_WEB_STATIC_ROOT")
        .env("MAESTRO_SKIP_STARTUP_UPDATE", "1");
    match restart.status() {
        Ok(status) => Some(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Maestro was updated, but automatic restart failed: {error}");
            None
        }
    }
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
    let context = install_context().context(
        "maestro update is available for signed release and global npm/Bun installations",
    )?;
    let check = check_for_update(&current, &context).await;
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
    match install(&context, latest) {
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

    #[test]
    fn preserves_the_original_global_install_prefix() {
        assert_eq!(
            package_prefix(
                Path::new("/opt/npm/lib/node_modules/@evalops/maestro"),
                "npm"
            ),
            Some(PathBuf::from("/opt/npm"))
        );
        assert_eq!(
            package_prefix(
                Path::new("/Users/me/.bun/install/global/node_modules/@evalops/maestro"),
                "bun"
            ),
            Some(PathBuf::from("/Users/me/.bun/install/global"))
        );
    }

    #[test]
    fn throttles_any_recent_attempt_for_the_same_version() {
        let mut state = StartupUpdateState {
            version: "0.11.0".to_owned(),
            last_attempt_at: 1_000,
            last_status: "failed".to_owned(),
        };
        assert!(should_throttle_startup_update(
            Some(&state),
            "0.11.0",
            2_000,
            Duration::from_secs(2)
        ));
        state.last_status = "updated".to_owned();
        assert!(should_throttle_startup_update(
            Some(&state),
            "0.11.0",
            2_000,
            Duration::from_secs(2)
        ));
        assert!(!should_throttle_startup_update(
            Some(&state),
            "0.11.1",
            2_000,
            Duration::from_secs(2)
        ));
        assert!(!should_throttle_startup_update(
            Some(&state),
            "0.11.0",
            3_000,
            Duration::from_secs(2)
        ));
    }

    #[test]
    fn startup_sources_are_built_in_and_release_updates_use_only_gcs() {
        let release = InstallContext::Release {
            install_dir: PathBuf::from("/opt/bin"),
            data_dir: PathBuf::from("/opt/share/maestro"),
            launcher: PathBuf::from("/opt/bin/maestro"),
        };
        assert_eq!(
            trusted_startup_update_urls(&release),
            vec![DEFAULT_GCS_URL.to_owned()]
        );

        let package = InstallContext::Package {
            manager: "npm".to_owned(),
            package: "@evalops/maestro".to_owned(),
            prefix: None,
            launcher: PathBuf::from("/opt/bin/maestro"),
        };
        assert_eq!(
            trusted_startup_update_urls(&package),
            vec![
                DEFAULT_GCS_URL.to_owned(),
                "https://registry.npmjs.org/%40evalops%2Fmaestro/latest".to_owned(),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn package_context_accepts_a_symlinked_package_root() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temp directory");
        let package_root = temporary.path().join("package");
        let executable = package_root.join("vendor/maestro/test-target/maestro");
        fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create package tree");
        fs::write(&executable, b"binary").expect("write executable");
        let executable = dunce::canonicalize(&executable).expect("canonical executable");
        let alias = temporary.path().join("package-alias");
        symlink(&package_root, &alias).expect("symlink package root");

        let context = package_install_context_from(
            &executable,
            &alias,
            "@evalops/maestro".to_owned(),
            Some("npm"),
        )
        .expect("package install context");
        assert_eq!(
            context,
            InstallContext::Package {
                manager: "npm".to_owned(),
                package: "@evalops/maestro".to_owned(),
                prefix: None,
                launcher: dunce::canonicalize(&package_root)
                    .expect("canonical package root")
                    .join("bin/maestro"),
            }
        );
    }

    #[test]
    fn startup_update_lock_is_nonblocking_and_released_on_drop() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let state_path = temporary.path().join("startup-update-state.json");
        let first = try_acquire_startup_update_lock(&state_path)
            .expect("acquire first lock")
            .expect("first lock available");
        assert!(try_acquire_startup_update_lock(&state_path)
            .expect("try second lock")
            .is_none());
        drop(first);
        assert!(try_acquire_startup_update_lock(&state_path)
            .expect("reacquire lock")
            .is_some());
    }

    #[test]
    fn embedded_release_updater_keeps_signature_verification() {
        assert!(EMBEDDED_INSTALLER.contains("verify_blob_signature"));
        assert!(EMBEDDED_INSTALLER.contains("SHA256SUMS.cosign.bundle"));
        assert!(EMBEDDED_INSTALLER.contains("${asset}.cosign.bundle"));
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

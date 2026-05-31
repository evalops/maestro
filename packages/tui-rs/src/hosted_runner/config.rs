use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};

const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
const DEFAULT_LISTEN_PORT: u16 = 8080;

#[derive(Debug, Clone)]
pub struct HostedRunnerConfig {
    pub runner_session_id: String,
    pub workspace_root: PathBuf,
    pub bind_addr: SocketAddr,
    pub owner_instance_id: Option<String>,
    pub snapshot_root: Option<PathBuf>,
    pub restore_manifest_path: Option<PathBuf>,
    pub workspace_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub maestro_session_id: Option<String>,
    pub attach_audience: Option<String>,
}

impl HostedRunnerConfig {
    pub fn from_env() -> Result<Self, HostedRunnerConfigError> {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        Self::from_env_map(&env)
    }

    pub fn from_env_map(env: &HashMap<String, String>) -> Result<Self, HostedRunnerConfigError> {
        let runner_session_id = first_env(
            env,
            &["MAESTRO_RUNNER_SESSION_ID", "REMOTE_RUNNER_SESSION_ID"],
        )
        .ok_or_else(|| {
            HostedRunnerConfigError::new("maestro hosted-runner requires MAESTRO_RUNNER_SESSION_ID")
        })?;
        let workspace_root = resolve_config_workspace_root(
            first_env(env, &["MAESTRO_WORKSPACE_ROOT", "WORKSPACE_ROOT"]).as_deref(),
        )?;
        let listen = parse_listen(env_value(env, "MAESTRO_HOSTED_RUNNER_LISTEN").as_deref())?;
        let hosted_runner_port =
            parse_optional_port(env_value(env, "MAESTRO_HOSTED_RUNNER_PORT").as_deref())
                .transpose()?;
        let port_env = parse_optional_port(env_value(env, "PORT").as_deref()).transpose()?;
        let port = listen
            .port
            .or(hosted_runner_port)
            .or(port_env)
            .unwrap_or(DEFAULT_LISTEN_PORT);
        let host = listen
            .host
            .or_else(|| env_value(env, "MAESTRO_HOSTED_RUNNER_HOST"))
            .unwrap_or_else(|| DEFAULT_LISTEN_HOST.to_string());
        let bind_addr = resolve_bind_addr(&host, port)?;
        let snapshot_root = resolve_snapshot_root(
            first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT",
                    "REMOTE_RUNNER_SNAPSHOT_ROOT",
                ],
            )
            .as_deref(),
            &workspace_root,
        );
        let restore_manifest_path = resolve_optional_config_path(
            first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST",
                    "REMOTE_RUNNER_RESTORE_MANIFEST",
                ],
            )
            .as_deref(),
            &workspace_root,
        );

        Ok(Self {
            runner_session_id: non_empty(runner_session_id, "runner_session_id")?,
            workspace_root,
            bind_addr,
            owner_instance_id: first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID",
                    "REMOTE_RUNNER_OWNER_INSTANCE_ID",
                ],
            ),
            snapshot_root: Some(snapshot_root),
            restore_manifest_path,
            workspace_id: first_env(
                env,
                &["MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "MAESTRO_WORKSPACE_ID"],
            ),
            agent_run_id: env_value(env, "MAESTRO_AGENT_RUN_ID"),
            maestro_session_id: env_value(env, "MAESTRO_SESSION_ID"),
            attach_audience: env_value(env, "MAESTRO_ATTACH_AUDIENCE"),
        })
    }

    pub fn new(
        runner_session_id: impl Into<String>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, HostedRunnerConfigError> {
        Ok(Self {
            runner_session_id: non_empty(runner_session_id.into(), "runner_session_id")?,
            workspace_root: resolve_config_workspace_root(Some(path_to_str(
                workspace_root.as_ref(),
            )?))?,
            bind_addr: format!("{DEFAULT_LISTEN_HOST}:{DEFAULT_LISTEN_PORT}")
                .parse()
                .expect("default hosted runner bind address is valid"),
            owner_instance_id: None,
            snapshot_root: None,
            restore_manifest_path: None,
            workspace_id: None,
            agent_run_id: None,
            maestro_session_id: None,
            attach_audience: None,
        })
    }

    #[must_use]
    pub fn with_bind_addr(mut self, bind_addr: SocketAddr) -> Self {
        self.bind_addr = bind_addr;
        self
    }

    #[must_use]
    pub fn with_owner_instance_id(mut self, owner_instance_id: impl Into<String>) -> Self {
        self.owner_instance_id = Some(owner_instance_id.into());
        self
    }

    #[must_use]
    pub fn with_snapshot_root(mut self, snapshot_root: impl Into<PathBuf>) -> Self {
        self.snapshot_root = Some(snapshot_root.into());
        self
    }

    #[must_use]
    pub fn with_restore_manifest_path(mut self, restore_manifest_path: impl Into<PathBuf>) -> Self {
        self.restore_manifest_path = Some(restore_manifest_path.into());
        self
    }

    #[must_use]
    pub fn with_workspace_id(mut self, workspace_id: impl Into<String>) -> Self {
        self.workspace_id = Some(workspace_id.into());
        self
    }

    #[must_use]
    pub fn with_agent_run_id(mut self, agent_run_id: impl Into<String>) -> Self {
        self.agent_run_id = Some(agent_run_id.into());
        self
    }

    #[must_use]
    pub fn with_maestro_session_id(mut self, maestro_session_id: impl Into<String>) -> Self {
        self.maestro_session_id = Some(maestro_session_id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRunnerConfigError {
    message: String,
}

impl HostedRunnerConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HostedRunnerConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HostedRunnerConfigError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedListen {
    host: Option<String>,
    port: Option<u16>,
}

fn first_env(env: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| env_value(env, key))
}

fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).map(|value| value.trim()).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn parse_listen(value: Option<&str>) -> Result<ParsedListen, HostedRunnerConfigError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(ParsedListen {
            host: None,
            port: None,
        });
    };
    if value.chars().all(|char| char.is_ascii_digit()) {
        return Ok(ParsedListen {
            host: None,
            port: Some(parse_port(value, "MAESTRO_HOSTED_RUNNER_LISTEN")?),
        });
    }
    let Some((host, port)) = value.rsplit_once(':') else {
        return Err(HostedRunnerConfigError::new(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    };
    if host.trim().is_empty() || port.trim().is_empty() {
        return Err(HostedRunnerConfigError::new(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    }
    Ok(ParsedListen {
        host: Some(host.trim().to_string()),
        port: Some(parse_port(port.trim(), "MAESTRO_HOSTED_RUNNER_LISTEN")?),
    })
}

fn parse_optional_port(value: Option<&str>) -> Option<Result<u16, HostedRunnerConfigError>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_port(value, "hosted runner port"))
}

fn parse_port(value: &str, label: &str) -> Result<u16, HostedRunnerConfigError> {
    if !value.chars().all(|char| char.is_ascii_digit()) {
        return Err(HostedRunnerConfigError::new(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    let port = value.parse::<u32>().map_err(|_| {
        HostedRunnerConfigError::new(format!("{label} must be a TCP port between 1 and 65535"))
    })?;
    if !(1..=65535).contains(&port) {
        return Err(HostedRunnerConfigError::new(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    Ok(port as u16)
}

fn resolve_bind_addr(host: &str, port: u16) -> Result<SocketAddr, HostedRunnerConfigError> {
    format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| {
            HostedRunnerConfigError::new(format!(
                "hosted runner listen address is invalid: {error}"
            ))
        })?
        .next()
        .ok_or_else(|| HostedRunnerConfigError::new("hosted runner listen address is invalid"))
}

fn resolve_config_workspace_root(path: Option<&str>) -> Result<PathBuf, HostedRunnerConfigError> {
    let path = path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            HostedRunnerConfigError::new("maestro hosted-runner requires MAESTRO_WORKSPACE_ROOT")
        })?;
    let workspace_root = fs::canonicalize(Path::new(path)).map_err(|error| {
        HostedRunnerConfigError::new(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    let metadata = fs::metadata(&workspace_root).map_err(|error| {
        HostedRunnerConfigError::new(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    if !metadata.is_dir() {
        return Err(HostedRunnerConfigError::new(
            "hosted runner workspace root is not a directory",
        ));
    }
    Ok(workspace_root)
}

fn resolve_snapshot_root(path: Option<&str>, workspace_root: &Path) -> PathBuf {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return workspace_root.join(".maestro").join("runner-snapshots");
    };
    resolve_config_path(path, workspace_root)
}

fn resolve_optional_config_path(path: Option<&str>, workspace_root: &Path) -> Option<PathBuf> {
    path.map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| resolve_config_path(path, workspace_root))
}

fn resolve_config_path(path: &str, workspace_root: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    }
}

fn path_to_str(path: &Path) -> Result<&str, HostedRunnerConfigError> {
    path.to_str()
        .ok_or_else(|| HostedRunnerConfigError::new("path must be valid UTF-8"))
}

fn non_empty(value: String, field: &str) -> Result<String, HostedRunnerConfigError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(HostedRunnerConfigError::new(format!(
            "{field} must not be empty"
        )));
    }
    Ok(value)
}

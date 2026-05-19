use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use clap::Parser;
use serde_json::json;

use crate::headless::{AgentSupervisor, SupervisorConfig};
use crate::hosted_runner::{
    start_hosted_runner_with_message_executor, AgentSupervisorHostedRunnerMessageExecutor,
    HostedRunnerConfig, HostedRunnerHandle,
};

#[derive(Debug, Parser)]
#[command(
    name = "maestro-tui hosted-runner",
    about = "Run the Rust Maestro hosted remote-runner runtime"
)]
pub struct HostedRunnerCliArgs {
    /// Platform remote-runner session id.
    #[arg(long)]
    runner_session_id: Option<String>,

    /// Platform runtime owner generation for attach fencing.
    #[arg(long)]
    owner_instance_id: Option<String>,

    /// Workspace root mounted into the runtime pod.
    #[arg(long)]
    workspace_root: Option<PathBuf>,

    /// Directory for drain snapshot manifests.
    #[arg(long)]
    snapshot_root: Option<PathBuf>,

    /// Snapshot manifest restored into this runner.
    #[arg(long)]
    restore_manifest: Option<PathBuf>,

    /// Address to bind, for example 0.0.0.0:8080.
    #[arg(long)]
    listen: Option<String>,

    /// Bind host when --listen is not used.
    #[arg(long)]
    host: Option<String>,

    /// Bind port when --listen is not used.
    #[arg(long)]
    port: Option<u16>,

    /// EvalOps workspace id for metadata.
    #[arg(long)]
    workspace_id: Option<String>,

    /// Platform agent-registry agent id forwarded to the headless runtime.
    #[arg(long)]
    agent_id: Option<String>,

    /// Platform AgentRun id for metadata.
    #[arg(long)]
    agent_run_id: Option<String>,

    /// Existing Maestro session id for metadata.
    #[arg(long)]
    maestro_session_id: Option<String>,

    /// Expected attach audience metadata.
    #[arg(long)]
    attach_audience: Option<String>,

    /// Local Maestro headless executable spawned behind the hosted runner.
    #[arg(long)]
    agent_cli_path: Option<PathBuf>,

    /// Compatibility flag used by Platform generated runtime args.
    #[arg(long)]
    from_config: bool,
}

pub struct HostedRunnerLaunchConfig {
    pub runner: HostedRunnerConfig,
    pub supervisor: SupervisorConfig,
    pub agent_id: Option<String>,
}

pub struct HostedRunnerCliRuntime {
    handle: HostedRunnerHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedRunnerShutdownSignal {
    Interrupt,
    Terminate,
}

impl HostedRunnerShutdownSignal {
    fn reason(self) -> &'static str {
        "process_shutdown"
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Interrupt => "sigint",
            Self::Terminate => "sigterm",
        }
    }
}

impl HostedRunnerCliRuntime {
    #[must_use]
    pub fn base_url(&self) -> String {
        self.handle.base_url()
    }

    pub async fn drain_for_shutdown(
        &self,
        signal: HostedRunnerShutdownSignal,
    ) -> Result<serde_json::Value> {
        self.handle
            .drain_for_shutdown(signal.reason(), "maestro-hosted-runner")
            .await
            .context("drain Rust hosted runner before shutdown")
    }

    pub async fn shutdown(self) {
        self.handle.shutdown().await;
    }
}

pub fn resolve_hosted_runner_launch_config<I, T>(
    args: I,
    env: &HashMap<String, String>,
) -> Result<HostedRunnerLaunchConfig>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = HostedRunnerCliArgs::try_parse_from(args)?;
    let mut merged_env = env.clone();
    apply_cli_env_overrides(&mut merged_env, &cli);

    let runner = HostedRunnerConfig::from_env_map(&merged_env)?;
    let mut supervisor = SupervisorConfig::default();
    supervisor.transport.cli_path = first_env(
        &merged_env,
        &[
            "MAESTRO_HEADLESS_CLI_PATH",
            "MAESTRO_AGENT_SCRIPT",
            "MAESTRO_CLI_PATH",
        ],
    )
    .unwrap_or_else(|| "maestro".to_string());
    supervisor.transport.cwd = Some(runner.workspace_root.to_string_lossy().to_string());
    supervisor.transport.env = hosted_agent_env(&runner, &merged_env);

    Ok(HostedRunnerLaunchConfig {
        runner,
        supervisor,
        agent_id: first_env(
            &merged_env,
            &["MAESTRO_REMOTE_RUNNER_AGENT_ID", "MAESTRO_AGENT_ID"],
        ),
    })
}

pub async fn start_hosted_runner_cli_runtime<I, T>(
    args: I,
    env: &HashMap<String, String>,
) -> Result<HostedRunnerCliRuntime>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let config = resolve_hosted_runner_launch_config(args, env)?;
    let mut supervisor = AgentSupervisor::new(config.supervisor);
    supervisor.connect().await?;
    let executor = Arc::new(AgentSupervisorHostedRunnerMessageExecutor::new(Arc::new(
        Mutex::new(supervisor),
    )));
    let handle = start_hosted_runner_with_message_executor(config.runner, executor)
        .await
        .context("start Rust hosted runner")?;
    Ok(HostedRunnerCliRuntime { handle })
}

pub async fn run_hosted_runner_cli_from_env<I, T>(args: I) -> Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let runtime = match start_hosted_runner_cli_runtime(args, &env).await {
        Ok(runtime) => runtime,
        Err(error) => {
            if let Some(clap_error) = error.downcast_ref::<clap::Error>() {
                clap_error.exit();
            }
            return Err(error);
        }
    };
    println!(
        "{}",
        json!({
            "baseUrl": runtime.base_url(),
            "runtime": "rust-hosted-runner",
        })
    );
    let signal = wait_for_shutdown_signal().await?;
    let drain = runtime.drain_for_shutdown(signal).await?;
    println!(
        "{}",
        json!({
            "drain": drain,
            "runtime": "rust-hosted-runner",
            "shutdownSignal": signal.as_str(),
        })
    );
    runtime.shutdown().await;
    Ok(())
}

async fn wait_for_shutdown_signal() -> Result<HostedRunnerShutdownSignal> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut interrupt = signal(SignalKind::interrupt())?;
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            _ = interrupt.recv() => Ok(HostedRunnerShutdownSignal::Interrupt),
            _ = terminate.recv() => Ok(HostedRunnerShutdownSignal::Terminate),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(HostedRunnerShutdownSignal::Interrupt)
    }
}

fn apply_cli_env_overrides(env: &mut HashMap<String, String>, cli: &HostedRunnerCliArgs) {
    set_string(
        env,
        "MAESTRO_RUNNER_SESSION_ID",
        cli.runner_session_id.as_deref(),
    );
    set_string(
        env,
        "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID",
        cli.owner_instance_id.as_deref(),
    );
    set_path(env, "MAESTRO_WORKSPACE_ROOT", cli.workspace_root.as_ref());
    set_path(
        env,
        "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT",
        cli.snapshot_root.as_ref(),
    );
    set_path(
        env,
        "MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST",
        cli.restore_manifest.as_ref(),
    );
    set_string(env, "MAESTRO_HOSTED_RUNNER_LISTEN", cli.listen.as_deref());
    set_string(env, "MAESTRO_HOSTED_RUNNER_HOST", cli.host.as_deref());
    if let Some(port) = cli.port {
        env.insert("MAESTRO_HOSTED_RUNNER_PORT".to_string(), port.to_string());
    }
    set_string(
        env,
        "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
        cli.workspace_id.as_deref(),
    );
    set_string(
        env,
        "MAESTRO_REMOTE_RUNNER_AGENT_ID",
        cli.agent_id.as_deref(),
    );
    set_string(env, "MAESTRO_AGENT_ID", cli.agent_id.as_deref());
    set_string(env, "MAESTRO_AGENT_RUN_ID", cli.agent_run_id.as_deref());
    set_string(env, "MAESTRO_SESSION_ID", cli.maestro_session_id.as_deref());
    set_string(
        env,
        "MAESTRO_ATTACH_AUDIENCE",
        cli.attach_audience.as_deref(),
    );
    set_path(
        env,
        "MAESTRO_HEADLESS_CLI_PATH",
        cli.agent_cli_path.as_ref(),
    );
}

fn hosted_agent_env(
    runner: &HostedRunnerConfig,
    merged_env: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let profile =
        first_env(merged_env, &["MAESTRO_PROFILE"]).unwrap_or_else(|| "hosted-runner".to_string());
    let mut env = vec![
        ("MAESTRO_HOSTED_RUNNER_MODE".to_string(), "1".to_string()),
        (
            "MAESTRO_RUNNER_SESSION_ID".to_string(),
            runner.runner_session_id.clone(),
        ),
        (
            "MAESTRO_WORKSPACE_ROOT".to_string(),
            runner.workspace_root.to_string_lossy().to_string(),
        ),
        ("MAESTRO_PROFILE".to_string(), profile),
    ];
    if let Some(owner_instance_id) = runner.owner_instance_id.as_ref() {
        env.push((
            "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID".to_string(),
            owner_instance_id.clone(),
        ));
        env.push((
            "REMOTE_RUNNER_OWNER_INSTANCE_ID".to_string(),
            owner_instance_id.clone(),
        ));
    }
    if let Some(snapshot_root) = runner.snapshot_root.as_ref() {
        env.push((
            "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT".to_string(),
            snapshot_root.to_string_lossy().to_string(),
        ));
    }
    if let Some(workspace_id) = runner.workspace_id.as_ref() {
        env.push((
            "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID".to_string(),
            workspace_id.clone(),
        ));
    }
    if let Some(agent_run_id) = runner.agent_run_id.as_ref() {
        env.push(("MAESTRO_AGENT_RUN_ID".to_string(), agent_run_id.clone()));
    }
    if let Some(maestro_session_id) = runner.maestro_session_id.as_ref() {
        env.push(("MAESTRO_SESSION_ID".to_string(), maestro_session_id.clone()));
    }
    if let Some(attach_audience) = runner.attach_audience.as_ref() {
        env.push((
            "MAESTRO_ATTACH_AUDIENCE".to_string(),
            attach_audience.clone(),
        ));
    }
    if let Some(agent_id) = first_env(
        merged_env,
        &["MAESTRO_REMOTE_RUNNER_AGENT_ID", "MAESTRO_AGENT_ID"],
    ) {
        env.push((
            "MAESTRO_REMOTE_RUNNER_AGENT_ID".to_string(),
            agent_id.clone(),
        ));
        env.push(("MAESTRO_AGENT_ID".to_string(), agent_id));
    }
    env
}

fn first_env(env: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| env.get(*key))
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn set_string(env: &mut HashMap<String, String>, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        env.insert(key.to_string(), value.to_string());
    }
}

fn set_path(env: &mut HashMap<String, String>, key: &str, value: Option<&PathBuf>) {
    if let Some(value) = value {
        env.insert(key.to_string(), value.to_string_lossy().to_string());
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::net::TcpListener;

    use tempfile::tempdir;

    use super::*;

    fn unused_tcp_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .expect("bind ephemeral test port")
            .local_addr()
            .expect("local addr")
            .port()
    }

    #[test]
    fn resolves_cli_flags_into_runner_and_supervisor_config() {
        let workspace = tempdir().expect("workspace");
        let agent = workspace.path().join("fake-maestro");
        fs::write(&agent, "#!/bin/sh\n").expect("agent");
        let port = unused_tcp_port();
        let listen = format!("127.0.0.1:{port}");
        let env = HashMap::from([("MAESTRO_PROFILE".to_string(), "sandbox".to_string())]);
        let config = resolve_hosted_runner_launch_config(
            [
                "maestro-tui hosted-runner",
                "--runner-session-id",
                "mrs_cli",
                "--owner-instance-id",
                "pod_cli",
                "--workspace-root",
                workspace.path().to_str().expect("workspace path"),
                "--snapshot-root",
                ".snapshots",
                "--listen",
                listen.as_str(),
                "--workspace-id",
                "ws_cli",
                "--agent-id",
                "agent_cli",
                "--agent-run-id",
                "run_cli",
                "--maestro-session-id",
                "sess_cli",
                "--attach-audience",
                "aud_cli",
                "--agent-cli-path",
                agent.to_str().expect("agent path"),
                "--from-config",
            ],
            &env,
        )
        .expect("config");

        assert_eq!(config.runner.runner_session_id, "mrs_cli");
        assert_eq!(config.runner.owner_instance_id.as_deref(), Some("pod_cli"));
        assert_eq!(config.runner.bind_addr.port(), port);
        assert_eq!(config.runner.workspace_id.as_deref(), Some("ws_cli"));
        assert_eq!(config.runner.agent_run_id.as_deref(), Some("run_cli"));
        assert_eq!(
            config.runner.maestro_session_id.as_deref(),
            Some("sess_cli")
        );
        assert_eq!(config.runner.attach_audience.as_deref(), Some("aud_cli"));
        assert_eq!(
            config.supervisor.transport.cli_path,
            agent.to_string_lossy()
        );
        assert_eq!(config.agent_id.as_deref(), Some("agent_cli"));
        assert!(config
            .supervisor
            .transport
            .env
            .iter()
            .any(|(key, value)| { key == "MAESTRO_AGENT_ID" && value == "agent_cli" }));
        assert!(config
            .supervisor
            .transport
            .env
            .iter()
            .any(|(key, value)| { key == "MAESTRO_PROFILE" && value == "sandbox" }));
    }

    #[tokio::test]
    async fn starts_real_hosted_runner_with_supervised_headless_child() {
        let workspace = tempdir().expect("workspace");
        let agent = workspace.path().join("fake-maestro-headless.sh");
        let port = unused_tcp_port();
        let listen = format!("127.0.0.1:{port}");
        let mut script = fs::File::create(&agent).expect("agent script");
        writeln!(script, "#!/bin/sh").expect("write shebang");
        writeln!(
            script,
            "printf '%s\\n' '{{\"type\":\"ready\",\"model\":\"fake\",\"provider\":\"test\",\"session_id\":\"sess_fake\"}}'"
        )
        .expect("write ready");
        writeln!(script, "while IFS= read -r line; do").expect("write loop");
        writeln!(
            script,
            "  printf '%s\\n' '{{\"type\":\"status\",\"message\":\"echo\"}}'"
        )
        .expect("write status");
        writeln!(script, "done").expect("write done");
        drop(script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&agent).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&agent, permissions).expect("chmod");
        }

        let runtime = start_hosted_runner_cli_runtime(
            [
                "maestro-tui hosted-runner",
                "--runner-session-id",
                "mrs_real",
                "--workspace-root",
                workspace.path().to_str().expect("workspace path"),
                "--listen",
                listen.as_str(),
                "--agent-cli-path",
                agent.to_str().expect("agent path"),
            ],
            &HashMap::new(),
        )
        .await
        .expect("runtime");

        let identity: serde_json::Value = reqwest::get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            runtime.base_url()
        ))
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
        assert_eq!(identity["runner_session_id"], "mrs_real");
        assert_eq!(identity["ready"], true);

        let drain = runtime
            .drain_for_shutdown(HostedRunnerShutdownSignal::Terminate)
            .await
            .expect("shutdown drain");
        assert_eq!(drain["status"], "drained");
        assert_eq!(drain["reason"], "process_shutdown");
        assert_eq!(drain["requested_by"], "maestro-hosted-runner");
        assert!(drain["manifest_path"]
            .as_str()
            .map(|path| PathBuf::from(path).is_file())
            .unwrap_or(false));

        let post_drain_identity: serde_json::Value = reqwest::get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            runtime.base_url()
        ))
        .await
        .expect("post-drain identity response")
        .json()
        .await
        .expect("post-drain identity json");
        assert_eq!(post_drain_identity["ready"], false);
        assert_eq!(post_drain_identity["draining"], true);

        runtime.shutdown().await;
    }
}

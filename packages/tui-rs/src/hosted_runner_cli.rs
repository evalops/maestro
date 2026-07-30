use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use clap::Parser;
use serde_json::json;

use crate::headless::{AgentSupervisor, SessionRecorder, SupervisorConfig};
use crate::hosted_runner::{
    load_hosted_runner_session_replay, start_hosted_runner_with_message_executor,
    AgentSupervisorHostedRunnerMessageExecutor, HostedRunnerConfig, HostedRunnerHandle,
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
    Hangup,
    Interrupt,
    Quit,
    Terminate,
}

impl HostedRunnerShutdownSignal {
    fn reason(self) -> &'static str {
        "process_shutdown"
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Hangup => "sighup",
            Self::Interrupt => "sigint",
            Self::Quit => "sigquit",
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
    let auth_required =
        first_env(&merged_env, &["MAESTRO_WEB_REQUIRE_KEY"]).as_deref() != Some("0");
    if auth_required && runner.auth_token.is_none() {
        anyhow::bail!(
            "maestro hosted-runner requires MAESTRO_HOSTED_RUNNER_AUTH_TOKEN or MAESTRO_WEB_API_KEY; set MAESTRO_WEB_REQUIRE_KEY=0 only for local testing"
        );
    }
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
    let mut config = resolve_hosted_runner_launch_config(args, env)?;
    let restore_replay = load_hosted_runner_session_replay(&config.runner).await?;
    let session_id = resolve_hosted_session_id(
        config.runner.maestro_session_id.as_deref(),
        restore_replay
            .as_ref()
            .and_then(|replay| replay.state.session_id.as_deref()),
        &config.runner.runner_session_id,
    );
    set_env_value(
        &mut config.supervisor.transport.env,
        "MAESTRO_SESSION_ID",
        &session_id,
    );
    let sessions_dir = config.runner.workspace_root.join(".maestro/sessions");
    std::fs::create_dir_all(&sessions_dir)?;
    let mut recorder = SessionRecorder::resume(sessions_dir, &session_recorder_id(&session_id))?;
    if let Some(replay) = restore_replay.as_ref() {
        recorder.apply_snapshot(replay.state.clone(), replay.last_init.clone())?;
    }
    let mut supervisor = AgentSupervisor::new(config.supervisor).with_session_recorder(recorder);
    if let Some(replay) = restore_replay {
        supervisor.restore_session_replay(replay);
    }
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
        let mut hangup = signal(SignalKind::hangup())?;
        let mut quit = signal(SignalKind::quit())?;
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            _ = hangup.recv() => Ok(HostedRunnerShutdownSignal::Hangup),
            _ = interrupt.recv() => Ok(HostedRunnerShutdownSignal::Interrupt),
            _ = quit.recv() => Ok(HostedRunnerShutdownSignal::Quit),
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
    env.push((
        "MAESTRO_AGENT_DIR".to_string(),
        first_env(merged_env, &["MAESTRO_AGENT_DIR"]).unwrap_or_else(|| {
            runner
                .workspace_root
                .join(".maestro/agent")
                .to_string_lossy()
                .to_string()
        }),
    ));
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

fn set_env_value(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some((_, existing_value)) = env.iter_mut().find(|(existing_key, _)| existing_key == key)
    {
        *existing_value = value.to_string();
    } else {
        env.push((key.to_string(), value.to_string()));
    }
}

fn session_recorder_id(session_id: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;
    let hash = session_id
        .as_bytes()
        .iter()
        .fold(FNV_OFFSET_BASIS, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
        });
    let prefix = session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(48)
        .collect::<String>();
    let prefix = if prefix.is_empty() {
        "session"
    } else {
        &prefix
    };
    format!("{prefix}-{hash:016x}")
}

fn resolve_hosted_session_id(
    configured_session_id: Option<&str>,
    restored_session_id: Option<&str>,
    runner_session_id: &str,
) -> String {
    configured_session_id
        .or(restored_session_id)
        .unwrap_or(runner_session_id)
        .to_string()
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

    fn unauthenticated_local_env() -> HashMap<String, String> {
        HashMap::from([("MAESTRO_WEB_REQUIRE_KEY".to_string(), "0".to_string())])
    }

    #[test]
    fn resolves_cli_flags_into_runner_and_supervisor_config() {
        let workspace = tempdir().expect("workspace");
        let agent = workspace.path().join("fake-maestro");
        fs::write(&agent, "#!/bin/sh\n").expect("agent");
        let port = unused_tcp_port();
        let listen = format!("127.0.0.1:{port}");
        let env = HashMap::from([
            ("MAESTRO_PROFILE".to_string(), "sandbox".to_string()),
            ("MAESTRO_WEB_REQUIRE_KEY".to_string(), "0".to_string()),
        ]);
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
        assert!(config.supervisor.transport.env.iter().any(|(key, value)| {
            key == "MAESTRO_AGENT_DIR"
                && value
                    == &config
                        .runner
                        .workspace_root
                        .join(".maestro/agent")
                        .to_string_lossy()
        }));
    }

    #[test]
    fn session_recorder_id_is_stable_and_path_safe() {
        let recorder_id = session_recorder_id("../../session/with spaces");

        assert_eq!(
            recorder_id,
            session_recorder_id("../../session/with spaces")
        );
        assert!(!recorder_id.contains('/'));
        assert!(!recorder_id.contains(".."));
        assert!(recorder_id.len() <= 65);
    }

    #[test]
    fn explicit_session_id_precedes_restored_and_runner_ids() {
        assert_eq!(
            resolve_hosted_session_id(Some("explicit"), Some("restored"), "runner"),
            "explicit"
        );
        assert_eq!(
            resolve_hosted_session_id(None, Some("restored"), "runner"),
            "restored"
        );
        assert_eq!(resolve_hosted_session_id(None, None, "runner"), "runner");
    }

    #[test]
    fn cli_requires_auth_by_default_even_on_loopback() {
        let workspace = tempdir().expect("workspace");
        let args = [
            "maestro-tui hosted-runner",
            "--runner-session-id",
            "mrs_auth",
            "--workspace-root",
            workspace.path().to_str().expect("workspace path"),
            "--listen",
            "127.0.0.1:8080",
        ];

        let error = match resolve_hosted_runner_launch_config(args.iter().copied(), &HashMap::new())
        {
            Ok(_) => panic!("missing auth should fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("MAESTRO_WEB_API_KEY"));

        let legacy_auth = HashMap::from([(
            "MAESTRO_WEB_API_KEY".to_string(),
            "legacy-secret".to_string(),
        )]);
        let config = resolve_hosted_runner_launch_config(args.iter().copied(), &legacy_auth)
            .expect("legacy auth should remain supported");
        assert_eq!(config.runner.auth_token.as_deref(), Some("legacy-secret"));
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
            &unauthenticated_local_env(),
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

    #[tokio::test]
    async fn restore_manifest_hydrates_supervised_session_and_replays_last_init() {
        let workspace = tempdir().expect("workspace");
        let source_agent = workspace.path().join("source-agent.sh");
        let mut source_script = fs::File::create(&source_agent).expect("source agent script");
        writeln!(source_script, "#!/bin/sh").expect("write shebang");
        writeln!(
            source_script,
            "printf '%s\\n' '{{\"type\":\"ready\",\"model\":\"fake\",\"provider\":\"test\",\"session_id\":\"sess_restore\"}}'"
        )
        .expect("write ready");
        writeln!(source_script, "while IFS= read -r line; do :; done").expect("write loop");
        drop(source_script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&source_agent).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&source_agent, permissions).expect("chmod");
        }

        let source_port = unused_tcp_port();
        let source_listen = format!("127.0.0.1:{source_port}");
        let source = start_hosted_runner_cli_runtime(
            [
                "maestro-tui hosted-runner",
                "--runner-session-id",
                "mrs_source",
                "--workspace-root",
                workspace.path().to_str().expect("workspace path"),
                "--listen",
                source_listen.as_str(),
                "--maestro-session-id",
                "sess_restore",
                "--agent-cli-path",
                source_agent.to_str().expect("source agent path"),
            ],
            &unauthenticated_local_env(),
        )
        .await
        .expect("source runtime");
        let client = reqwest::Client::new();
        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", source.base_url()))
            .json(&json!({
                "sessionId": "sess_restore",
                "connectionId": "conn_restore",
                "role": "controller"
            }))
            .send()
            .await
            .expect("source connection response")
            .json()
            .await
            .expect("source connection json");
        assert_eq!(connection["connection_id"], "conn_restore");
        let connection_capability = connection["connection_capability"]
            .as_str()
            .expect("source connection capability");
        let subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_restore/subscribe",
                source.base_url()
            ))
            .json(&json!({
                "connectionId": "conn_restore",
                "connectionCapability": connection_capability,
                "connectionCapabilityRequired": true,
                "role": "controller"
            }))
            .send()
            .await
            .expect("source subscription response")
            .json()
            .await
            .expect("source subscription json");
        let subscription_id = subscription["subscription_id"]
            .as_str()
            .expect("source subscription id");
        client
            .post(format!(
                "{}/api/headless/sessions/sess_restore/messages",
                source.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_restore")
            .header("x-maestro-headless-subscriber-id", subscription_id)
            .header(
                "x-maestro-headless-connection-capability",
                connection_capability,
            )
            .json(&json!({
                "type": "hello",
                "protocol_version": crate::headless::HEADLESS_PROTOCOL_VERSION
            }))
            .send()
            .await
            .expect("source hello response")
            .error_for_status()
            .expect("source hello status");
        client
            .post(format!(
                "{}/api/headless/sessions/sess_restore/messages",
                source.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_restore")
            .header("x-maestro-headless-subscriber-id", subscription_id)
            .header(
                "x-maestro-headless-connection-capability",
                connection_capability,
            )
            .json(&json!({
                "type": "init",
                "system_prompt": "restore system prompt",
                "append_system_prompt": "restore append prompt",
                "thinking_level": "high",
                "approval_mode": "prompt"
            }))
            .send()
            .await
            .expect("source init response")
            .error_for_status()
            .expect("source init status");
        let drain = source
            .drain_for_shutdown(HostedRunnerShutdownSignal::Terminate)
            .await
            .expect("source drain");
        assert_eq!(drain["manifest"]["runtime"]["flush_status"], "completed");
        let manifest_path = PathBuf::from(
            drain["manifest_path"]
                .as_str()
                .expect("source manifest path"),
        );
        let session_file = PathBuf::from(
            drain["manifest"]["runtime"]["session_file"]
                .as_str()
                .expect("source session file"),
        );
        assert!(session_file.is_file());
        let source_entry_count = fs::read_to_string(&session_file)
            .expect("source session log")
            .lines()
            .count();
        let metadata_file = session_file.with_extension("meta.json");
        let source_metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&metadata_file).expect("source session metadata"),
        )
        .expect("source session metadata json");
        source.shutdown().await;

        let restored_agent = workspace.path().join("restored-agent.sh");
        let restored_env = workspace.path().join("restored-session.txt");
        let restored_messages = workspace.path().join("restored-messages.jsonl");
        let mut restored_script = fs::File::create(&restored_agent).expect("restored agent script");
        writeln!(restored_script, "#!/bin/sh").expect("write shebang");
        writeln!(
            restored_script,
            "printf '%s' \"$MAESTRO_SESSION_ID\" > '{}'",
            restored_env.display()
        )
        .expect("write session capture");
        writeln!(
            restored_script,
            "printf '%s\\n' \"{{\\\"type\\\":\\\"ready\\\",\\\"model\\\":\\\"fake\\\",\\\"provider\\\":\\\"test\\\",\\\"session_id\\\":\\\"$MAESTRO_SESSION_ID\\\"}}\""
        )
        .expect("write ready");
        writeln!(restored_script, "while IFS= read -r line; do").expect("write loop");
        writeln!(
            restored_script,
            "  printf '%s\\n' \"$line\" >> '{}'",
            restored_messages.display()
        )
        .expect("write message capture");
        writeln!(restored_script, "done").expect("write loop end");
        drop(restored_script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&restored_agent)
                .expect("metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&restored_agent, permissions).expect("chmod");
        }

        let restored_port = unused_tcp_port();
        let restored_listen = format!("127.0.0.1:{restored_port}");
        let restored = start_hosted_runner_cli_runtime(
            [
                "maestro-tui hosted-runner",
                "--runner-session-id",
                "mrs_restored",
                "--workspace-root",
                workspace.path().to_str().expect("workspace path"),
                "--restore-manifest",
                manifest_path.to_str().expect("manifest path"),
                "--listen",
                restored_listen.as_str(),
                "--agent-cli-path",
                restored_agent.to_str().expect("restored agent path"),
            ],
            &unauthenticated_local_env(),
        )
        .await
        .expect("restored runtime");

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let messages = fs::read_to_string(&restored_messages).unwrap_or_default();
                if messages.contains("restore system prompt") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("restored init replay timeout");
        assert_eq!(
            fs::read_to_string(&restored_env).expect("restored session capture"),
            "sess_restore"
        );
        let messages = fs::read_to_string(&restored_messages).expect("restored messages");
        let init: serde_json::Value = serde_json::from_str(
            messages
                .lines()
                .find(|line| line.contains("restore system prompt"))
                .expect("restored init line"),
        )
        .expect("restored init json");
        assert_eq!(init["type"], "init");
        assert_eq!(init["system_prompt"], "restore system prompt");
        assert_eq!(init["append_system_prompt"], "restore append prompt");
        assert_eq!(init["thinking_level"], "high");
        assert_eq!(init["approval_mode"], "prompt");
        let restored_drain = restored
            .drain_for_shutdown(HostedRunnerShutdownSignal::Terminate)
            .await
            .expect("restored drain");
        assert_eq!(
            restored_drain["manifest"]["runtime"]["session_file"],
            session_file.to_string_lossy().as_ref()
        );
        let restored_entry_count = fs::read_to_string(&session_file)
            .expect("restored session log")
            .lines()
            .count();
        assert!(restored_entry_count > source_entry_count);
        let restored_metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(metadata_file).expect("restored session metadata"),
        )
        .expect("restored session metadata json");
        assert_eq!(
            restored_metadata["created_at"],
            source_metadata["created_at"]
        );
        assert!(
            restored_metadata["message_count"].as_u64() > source_metadata["message_count"].as_u64()
        );
        restored.shutdown().await;
    }
}

#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use tempfile::tempdir;

fn maestro_tui_binary() -> std::ffi::OsString {
    std::env::var_os("CARGO_BIN_EXE_maestro-tui")
        .expect("Cargo must provide the maestro-tui integration-test binary")
}

fn assert_signal_drains(signal: &str) {
    let workspace = tempdir().expect("workspace");
    let agent = workspace.path().join("fake-agent.sh");
    let mut script = fs::File::create(&agent).expect("create fake agent");
    writeln!(script, "#!/bin/sh").expect("write shebang");
    writeln!(
        script,
        "printf '%s\\n' '{{\"type\":\"ready\",\"model\":\"gpt-5.5\",\"provider\":\"test\",\"session_id\":\"signal_session\"}}'"
    )
    .expect("write ready");
    writeln!(script, "while IFS= read -r line; do :; done").expect("write loop");
    drop(script);
    let mut permissions = fs::metadata(&agent).expect("agent metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&agent, permissions).expect("chmod agent");

    let port = TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("ephemeral address")
        .port()
        .to_string();
    let listen = format!("127.0.0.1:{port}");
    let mut child = Command::new(maestro_tui_binary())
        .args([
            "hosted-runner",
            "--runner-session-id",
            "mrs_signal",
            "--workspace-root",
            workspace.path().to_str().expect("workspace path"),
            "--listen",
            &listen,
            "--maestro-session-id",
            "signal_session",
            "--agent-cli-path",
            agent.to_str().expect("agent path"),
        ])
        .stdout(Stdio::piped())
        .env("MAESTRO_WEB_REQUIRE_KEY", "0")
        .spawn()
        .expect("spawn hosted runner");
    let stdout = child.stdout.take().expect("hosted runner stdout");
    let (line_tx, line_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    let startup = line_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("hosted runner startup timeout")
        .expect("hosted runner startup line");
    let startup: serde_json::Value = serde_json::from_str(&startup).expect("startup json");
    assert_eq!(startup["runtime"], "rust-hosted-runner");

    let kill_status = Command::new("kill")
        .args([signal, &child.id().to_string()])
        .status()
        .expect("send hosted runner signal");
    assert!(kill_status.success());

    let shutdown = line_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("hosted runner drain timeout")
        .expect("hosted runner drain line");
    let shutdown: serde_json::Value = serde_json::from_str(&shutdown).expect("shutdown json");
    assert_eq!(shutdown["runtime"], "rust-hosted-runner");
    let manifest_path = shutdown["drain"]["manifest_path"]
        .as_str()
        .expect("drain manifest path");
    assert!(
        fs::metadata(manifest_path)
            .expect("drain manifest")
            .is_file()
    );
    assert!(child.wait().expect("hosted runner exit").success());
}

#[test]
fn hangup_and_quit_drain_before_exit() {
    for signal in ["-HUP", "-QUIT"] {
        assert_signal_drains(signal);
    }
}

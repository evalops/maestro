use std::path::PathBuf;
use std::process::Command;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/scripted-replay")
        .join(name)
}

fn scenario_binary() -> PathBuf {
    std::env::var_os("CARGO_BIN_EXE_maestro-scenario")
        .map(PathBuf::from)
        .expect("Cargo must provide the maestro-scenario integration-test binary")
}

#[test]
fn offline_runner_preserves_full_cli_argument_shape() {
    let output = Command::new(scenario_binary())
        .args([
            "scenario",
            "run",
            fixture("basic-tool-call.json").to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("run thin scenario binary");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("scenario JSON result");
    assert_eq!(result["scenario"]["observedOutcome"], "pass");
}

#[test]
fn thin_runner_rejects_real_agent_execution() {
    let output = Command::new(scenario_binary())
        .args([
            "scenario",
            "run",
            fixture("read-write-execute.json").to_str().unwrap(),
            "--execute",
            "--json",
        ])
        .output()
        .expect("run thin scenario binary");

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("--execute requires the full maestro binary")
    );
}

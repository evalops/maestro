use std::process::Command;

#[test]
fn direct_binary_help_remains_a_successful_early_exit() {
    let output = Command::new(env!("CARGO_BIN_EXE_maestro-tui"))
        .arg("--help")
        .output()
        .expect("run maestro-tui --help");
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("Usage:"));
}

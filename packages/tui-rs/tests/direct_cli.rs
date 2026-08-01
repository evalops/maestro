use std::process::Command;

#[test]
fn direct_binary_help_remains_a_successful_early_exit() {
    let output = Command::new(env!("CARGO_BIN_EXE_maestro-tui"))
        .arg("--help")
        .output()
        .expect("run maestro-tui --help");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage:"));
    assert!(stdout.contains("Usage: maestro"));
    assert!(!stdout.contains("maestro-tui"));
}

#[test]
fn direct_binary_supported_noninteractive_commands_exit_successfully() {
    let cases: &[(&[&str], &str)] = &[
        (&["a2a", "--help"], "a2a"),
        (&["hosted-runner", "--help"], "hosted-runner"),
        (&["init", "--help"], "init"),
        (&["remote", "--help"], "remote"),
        (&["skill", "--help"], "skill"),
        (&["update", "--help"], "update"),
    ];

    for &(args, marker) in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_maestro-tui"))
            .args(args)
            .output()
            .unwrap_or_else(|error| panic!("run maestro-tui {}: {error}", args.join(" ")));
        assert!(output.status.success(), "{args:?}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(marker),
            "{args:?}: expected help output to contain {marker:?}"
        );
    }
}

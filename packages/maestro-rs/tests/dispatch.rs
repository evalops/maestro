use maestro::{classify, AgentMode, Command};
use serde::Deserialize;
use std::ffi::OsString;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    name: String,
    argv: Vec<String>,
    route: String,
    exit_code: Option<i32>,
}

#[test]
fn web_dispatches_to_in_process_control_plane() {
    assert_eq!(classify(["web"]).unwrap(), Command::Web { port: None });
    assert_eq!(
        classify(["web", "--port", "9090"]).unwrap(),
        Command::Web { port: Some(9090) }
    );
}

#[test]
fn exec_dispatches_to_native_print() {
    assert_eq!(
        classify(["exec", "hello"]).unwrap(),
        Command::Agent(AgentMode::Exec)
    );
}

#[test]
fn doctor_dispatches_as_native_utility() {
    assert_eq!(
        classify(["doctor", "--json", "--model", "openai/gpt-4o"]).unwrap(),
        Command::Utility(vec![
            OsString::from("doctor"),
            OsString::from("--json"),
            OsString::from("--model"),
            OsString::from("openai/gpt-4o"),
        ])
    );
}

#[test]
fn frozen_cli_routes_are_owned_by_native_dispatch() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-cutover/cli-routing.json"
    ))
    .expect("parse CLI routing fixture");
    assert_eq!(fixture.schema_version, 1);

    for case in fixture.cases {
        let result = classify(case.argv.into_iter().map(OsString::from));
        if case.exit_code.is_some_and(|code| code != 0) {
            assert!(result.is_err(), "{} should reject invalid argv", case.name);
            continue;
        }
        let command = result.unwrap_or_else(|error| panic!("{}: {error}", case.name));
        match case.route.as_str() {
            "native-control-plane" => assert!(
                matches!(command, Command::Web { .. }),
                "{}: {command:?}",
                case.name
            ),
            "native-headless" => assert_eq!(
                command,
                Command::Agent(AgentMode::Headless),
                "{}",
                case.name
            ),
            "native-tui" | "native" => assert!(!matches!(command, Command::Web { .. })),
            other => panic!("{}: unknown fixture route {other}", case.name),
        }
    }
}

#[test]
fn web_rejects_prompt_arguments() {
    assert!(classify(["web", "prompt"]).is_err());
}

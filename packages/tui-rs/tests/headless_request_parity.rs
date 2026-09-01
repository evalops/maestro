use serde_json::Value;
use std::fs;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

fn maestro_tui_binary() -> std::ffi::OsString {
    std::env::var_os("CARGO_BIN_EXE_maestro-tui")
        .expect("Cargo must provide the maestro-tui integration-test binary")
}

fn test_identity_base_url() -> &'static str {
    static IDENTITY_BASE_URL: OnceLock<String> = OnceLock::new();
    IDENTITY_BASE_URL
        .get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test Identity server");
            let address = listener.local_addr().expect("test Identity address");
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else {
                        continue;
                    };
                    let mut request = [0_u8; 4 * 1024];
                    let _ = stream.read(&mut request);
                    let body = r#"{"active":true,"subject":"headless-parity-user","token_type":"access","organization_id":"headless-parity-org","workspace_id":"headless-parity-workspace","scopes":["llm_gateway:invoke"]}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            format!("http://{address}")
        })
        .as_str()
}

#[test]
fn every_contract_request_is_handled_or_typed_unsupported() {
    let fixture = include_str!("../../../test/fixtures/rust-cutover/headless-requests.jsonl");
    let workspace =
        std::env::temp_dir().join(format!("maestro-headless-parity-{}", std::process::id()));
    fs::create_dir_all(&workspace).expect("create fixture workspace");
    fs::write(
        workspace.join("Cargo.toml"),
        "[package]\nname = \"fixture\"\n",
    )
    .expect("write fixture file");
    let workspace = workspace.to_string_lossy().into_owned();
    let requests = fixture
        .lines()
        .map(|line| {
            let mut request = serde_json::from_str::<Value>(line).expect("valid request fixture");
            for field in ["cwd", "root_dir"] {
                if request["message"][field].as_str() == Some("/workspace") {
                    request["message"][field] = Value::String(workspace.clone());
                }
            }
            request
        })
        .collect::<Vec<_>>();
    let hello = requests
        .iter()
        .find(|request| request["message"]["type"] == "hello")
        .expect("fixture hello request");
    assert_eq!(
        hello["message"]["protocol_version"],
        maestro_tui::headless::HEADLESS_PROTOCOL_VERSION,
        "rust-cutover fixture must negotiate the current wire contract"
    );
    let input = requests
        .iter()
        .map(|request| serde_json::to_string(&request["message"]).expect("serialize request"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut child = Command::new(maestro_tui_binary())
        .arg("--headless")
        .env("MAESTRO_MODEL", "gpt-5.5")
        .env("OPENAI_API_KEY", "headless-parity-test-key")
        .env(
            maestro_tui::credential_mode::ACCESS_TOKEN_ENV,
            "headless-parity-identity-token",
        )
        .env(
            maestro_tui::credential_mode::ORG_ID_ENV,
            "headless-parity-org",
        )
        .env("MAESTRO_IDENTITY_URL", test_identity_base_url())
        .env(maestro_tui::init_cli::TEST_IDENTITY_AUTHORITY_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn native headless server");
    child
        .stdin
        .take()
        .expect("headless stdin")
        .write_all(input.as_bytes())
        .expect("write request fixture");

    let output = child.wait_with_output().expect("wait for headless server");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).expect("headless output is UTF-8");
    let events = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid headless event JSON"))
        .collect::<Vec<_>>();
    assert!(!events.is_empty());
    assert!(events.iter().all(|event| {
        event
            .get("message")
            .and_then(Value::as_str)
            .is_none_or(|message| !message.contains("ignored message"))
    }));

    for request in requests {
        let request_type = request["message"]["type"].as_str().expect("request type");
        assert!(
            events
                .iter()
                .any(|event| event_correlates(event, request_type, &request)),
            "no correlated event for {request_type}: {stdout}"
        );
    }
}

fn event_correlates(event: &Value, request_type: &str, request: &Value) -> bool {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = &request["message"];
    match request_type {
        "hello" => {
            event_type == "hello_ok"
                && event.get("protocol_version").and_then(Value::as_str)
                    == Some(maestro_tui::headless::HEADLESS_PROTOCOL_VERSION)
        }
        "init" => event.get("message").and_then(Value::as_str) == Some("init applied"),
        "prompt" => matches!(event_type, "ready" | "response_start" | "error"),
        "interrupt" | "cancel" => {
            event.get("error_type").and_then(Value::as_str) == Some("cancelled")
        }
        "tool_response" | "client_tool_result" => event.get("request_id") == message.get("call_id"),
        "server_request_response" => {
            event.get("request_id") == message.get("request_id")
                || event.get("call_id") == message.get("request_id")
        }
        "utility_command_start"
        | "utility_command_terminate"
        | "utility_command_stdin"
        | "utility_command_resize" => {
            event.get("command_id") == message.get("command_id")
                || event.get("request_id") == message.get("command_id")
        }
        "utility_file_search" => {
            event.get("search_id") == message.get("search_id")
                || event.get("request_id") == message.get("search_id")
        }
        "utility_file_read" => {
            event.get("read_id") == message.get("read_id")
                || event.get("request_id") == message.get("read_id")
        }
        "utility_file_watch_start" | "utility_file_watch_stop" => {
            event.get("watch_id") == message.get("watch_id")
                || event.get("request_id") == message.get("watch_id")
        }
        "shutdown" => event.get("message").and_then(Value::as_str) == Some("shutting down"),
        _ => false,
    }
}

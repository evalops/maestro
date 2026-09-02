use super::*;

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct EnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EnvRestore {
    fn capture(names: &[&'static str]) -> Self {
        Self(
            names
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect(),
        )
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (name, value) in self.0.drain(..) {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

fn canonical_event(status: TurnStatus) -> CanonicalTurnEvent {
    let mut event = crate::telemetry::TurnCollector::new(
        "private-session",
        1,
        crate::telemetry::TailSamplingConfig::default(),
    )
    .complete(
        status,
        crate::telemetry::TokenUsage {
            input: 12,
            output: 3,
            ..Default::default()
        },
        0.01,
        Some(crate::telemetry::ErrorDetails {
            category: Some("provider_stream".to_owned()),
            message: Some("prompt=/private/path token=secret".to_owned()),
        }),
        None,
    );
    event.identity_scope = Some(test_identity_scope("org-a", "workspace-a"));
    event
}

fn test_identity_scope(organization_id: &str, workspace_id: &str) -> TelemetryIdentityScope {
    TelemetryIdentityScope::new(organization_id, Some(workspace_id))
        .expect("complete test Identity scope")
}

fn delivery_session(
    access_token: &str,
    identity_scope: TelemetryIdentityScope,
) -> FirstPartyDeliverySession {
    FirstPartyDeliverySession {
        access_token: access_token.to_owned(),
        identity_scope,
    }
}

fn parse_jsonl_record(encoded: &str) -> Value {
    encoded
        .lines()
        .rev()
        .find_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                None
            } else {
                serde_json::from_str(line).ok()
            }
        })
        .expect("jsonl telemetry record")
}

fn clear_telemetry_env() {
    for name in [
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
        "MAESTRO_TELEMETRY_SAMPLE",
        "PLAYWRIGHT_TELEMETRY_SAMPLE",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ] {
        std::env::remove_var(name);
    }
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("test request timeout");
    let mut request = Vec::new();
    loop {
        let mut chunk = [0_u8; 4096];
        let bytes = stream.read(&mut chunk).expect("read test request");
        if bytes == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..bytes]);
        let Some(headers_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers_end = headers_end + 4;
        let headers = String::from_utf8_lossy(&request[..headers_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
            })
            .unwrap_or(0);
        if request.len() >= headers_end + content_length {
            break;
        }
    }
    String::from_utf8(request).expect("utf8 request")
}

fn loopback_server(
    statuses: Vec<u16>,
) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback server");
    let endpoint = format!(
        "http://{}",
        listener.local_addr().expect("loopback address")
    );
    let (sender, receiver) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        for status in statuses {
            let (mut stream, _) = listener.accept().expect("accept telemetry request");
            let request = read_http_request(&mut stream);
            sender.send(request).expect("send captured request");
            let body = "{}";
            let response = format!(
                "HTTP/1.1 {status} telemetry\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).expect("respond");
        }
    });
    (endpoint, receiver, handle)
}

fn loopback_server_records_unexpected_request(
    timeout: Duration,
) -> (String, mpsc::Receiver<bool>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback server");
    listener
        .set_nonblocking(true)
        .expect("configure loopback server");
    let endpoint = format!(
        "http://{}",
        listener.local_addr().expect("loopback address")
    );
    let (sender, receiver) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = read_http_request(&mut stream);
                    let body = "{}";
                    let response = format!(
                        "HTTP/1.1 202 telemetry\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    sender
                        .send(true)
                        .expect("report unexpected telemetry request");
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        sender.send(false).expect("report no telemetry request");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept loopback telemetry request: {error}"),
            }
        }
    });
    (endpoint, receiver, handle)
}

#[test]
fn staged_rollout_event_matches_typescript_contract() {
    let event = staged_rollout_event(
        "hidden_mode_used",
        "mode:frontier",
        "mode",
        Some("agent-runtime"),
        "cli:modes:describe",
    );
    assert_eq!(event["type"], "staged-rollout-surface");
    assert_eq!(event["event"], "hidden_mode_used");
    assert_eq!(event["surfaceId"], "mode:frontier");
    assert_eq!(event["surfaceType"], "mode");
    assert_eq!(event["metadata"]["owner"], "agent-runtime");
    assert_eq!(event["metadata"]["source"], "cli:modes:describe");
    assert!(
        event["timestamp"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z'))
    );
}

#[test]
fn canonical_turn_projection_uses_the_existing_telemetry_event_discriminator() {
    let payload = serde_json::to_value(canonical_event(TurnStatus::Success).external_projection())
        .expect("projection JSON");
    assert_eq!(payload["type"], "canonical-turn");
    assert!(payload.get("event_type").is_none());
    assert!(!payload.to_string().contains("private-session"));
}

#[test]
fn first_party_projection_is_closed_and_accepted_by_the_server_contract() {
    let mut event = canonical_event(TurnStatus::Error);
    event.model.provider = "customer-provider?secret=never-export".to_owned();
    event.model.id = "private-model-deployment".to_owned();
    event.mcp_servers = Some(vec!["customer-mcp".to_owned()]);
    let first_party =
        first_party_event(&event.external_projection()).expect("valid first-party event");
    assert!(first_party.is_server_valid());

    let encoded = serde_json::to_string(&first_party).expect("encode first-party event");
    let payload: Value = serde_json::from_str(&encoded).expect("decode first-party JSON");
    assert_eq!(payload["type"], "canonical-turn");
    assert_eq!(payload["modelProvider"], "other");
    assert_eq!(payload["errorCategory"], "provider");
    assert!(payload["eventId"].as_str().is_some());
    for secret in [
        "private-session",
        "private-model-deployment",
        "customer-mcp",
        "private/path",
        "token=secret",
        "customer-provider?secret",
        "organizationId",
        "workspaceId",
    ] {
        assert!(
            !encoded.contains(secret),
            "first-party event leaked {secret}"
        );
    }
}

#[test]
fn canonical_turn_is_durably_logged_and_queued_without_exporting_content() {
    let _lock = crate::config::test_process_env_lock();
    let _restore = EnvRestore::capture(&[
        "MAESTRO_HOME",
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ]);
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let telemetry_path = temp.path().join("telemetry.log");
    std::env::set_var("MAESTRO_HOME", temp.path());
    clear_telemetry_env();

    record_canonical_turn_event(&canonical_event(TurnStatus::Error));

    let encoded = fs::read_to_string(telemetry_path).expect("local telemetry log");
    let payload = parse_jsonl_record(&encoded);
    assert_eq!(payload["type"], "canonical-turn");
    assert_eq!(payload["status"], "error");
    assert_eq!(payload["tokens"]["input"], 12);
    assert_eq!(payload["error_category"], "provider_stream");
    for secret in ["private-session", "/private/path", "token=secret"] {
        assert!(!encoded.contains(secret), "local telemetry leaked {secret}");
    }

    let outbox = temp.path().join("telemetry/outbox");
    let paths = outbox_paths(&outbox);
    assert_eq!(paths.len(), 1, "first-party delivery must be durable");
    let queued = fs::read_to_string(&paths[0]).expect("queued telemetry event");
    assert!(queued.contains("\"eventId\""));
    for secret in ["private-session", "/private/path", "token=secret"] {
        assert!(!queued.contains(secret), "outbox leaked {secret}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        assert_eq!(
            fs::metadata(&paths[0])
                .expect("outbox permissions")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "the durable first-party record must not expose its contents"
        );
    }
}

#[test]
fn incomplete_identity_scope_keeps_the_local_receipt_without_remote_queueing() {
    let _lock = crate::config::test_process_env_lock();
    let _restore = EnvRestore::capture(&[
        "MAESTRO_HOME",
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ]);
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    std::env::set_var("MAESTRO_HOME", temp.path());
    clear_telemetry_env();
    let mut event = canonical_event(TurnStatus::Success);
    event.identity_scope = None;

    record_canonical_turn_event(&event);

    assert!(temp.path().join("telemetry.log").exists());
    assert!(
        outbox_paths(&temp.path().join("telemetry/outbox")).is_empty(),
        "remote telemetry must require a complete verified Identity scope"
    );
}

#[test]
fn first_party_outbox_is_bounded() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    for _ in 0..=OUTBOX_CAPACITY {
        let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
            .expect("first-party projection");
        persist_first_party_event(temp.path(), &scope, &event).expect("persist bounded event");
    }

    assert_eq!(outbox_paths(temp.path()).len(), OUTBOX_CAPACITY);
}

#[test]
fn outbox_rejects_tampered_content_before_delivery() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
        .expect("first-party projection");
    let path =
        persist_first_party_event(temp.path(), &scope, &event).expect("persist first-party event");
    let mut tampered: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read queued event"))
            .expect("queued event JSON");
    tampered["event"]["prompt"] =
        Value::String("secret prompt must never cross the wire".to_owned());
    fs::write(&path, serde_json::to_vec(&tampered).expect("tampered JSON"))
        .expect("write tampered event");

    assert!(read_bounded_outbox_record(&path).is_none());
}

#[test]
fn first_party_drain_retries_then_sends_identity_bearer_only_to_its_endpoint() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
        .expect("first-party projection");
    let path =
        persist_first_party_event(temp.path(), &scope, &event).expect("persist first-party event");
    let (endpoint, requests, server) = loopback_server(vec![503, 202]);
    let identity = delivery_session("identity-access-token", scope);

    drain_first_party_outbox_to_endpoint(temp.path(), &identity, &endpoint);
    assert!(path.exists(), "failed delivery must remain queued");
    drain_first_party_outbox_to_endpoint(temp.path(), &identity, &endpoint);
    assert!(
        !path.exists(),
        "2xx delivery must acknowledge the queued event"
    );

    for _ in 0..2 {
        let request = requests
            .recv_timeout(Duration::from_secs(3))
            .expect("first-party request");
        let normalized = request.to_ascii_lowercase();
        assert!(
            normalized.contains("authorization: bearer identity-access-token"),
            "first-party request omitted the Identity bearer: {request}"
        );
        assert!(normalized.contains("content-type: application/json"));
        assert!(!request.contains("private-session"));
        assert!(!request.contains("token=secret"));
        assert!(!request.contains("organizationId"));
        assert!(!request.contains("workspaceId"));
    }
    server.join().expect("loopback server");
}

#[test]
fn first_party_outbox_never_replays_an_event_under_a_different_identity_scope() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let origin_scope = test_identity_scope("org-a", "workspace-a");
    let later_scope = test_identity_scope("org-b", "workspace-b");
    let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
        .expect("first-party projection");
    let path = persist_first_party_event(temp.path(), &origin_scope, &event)
        .expect("persist first-party event");
    let origin_identity = delivery_session("origin-identity-token", origin_scope.clone());

    let (retry_endpoint, retry_requests, retry_server) = loopback_server(vec![503]);
    drain_first_party_outbox_to_endpoint(temp.path(), &origin_identity, &retry_endpoint);
    assert!(
        path.exists(),
        "a transient failure must retain the origin record"
    );
    let retry_request = retry_requests
        .recv_timeout(Duration::from_secs(3))
        .expect("origin retry request");
    assert!(
        retry_request
            .to_ascii_lowercase()
            .contains("authorization: bearer origin-identity-token")
    );
    retry_server.join().expect("retry loopback server");

    let (switched_endpoint, switched_requests, switched_server) =
        loopback_server_records_unexpected_request(Duration::from_millis(250));
    let switched_identity = delivery_session("switched-identity-token", later_scope);
    drain_first_party_outbox_to_endpoint(temp.path(), &switched_identity, &switched_endpoint);
    assert!(
        path.exists(),
        "a different tenant must not acknowledge the origin record"
    );
    assert!(
        !switched_requests
            .recv_timeout(Duration::from_secs(2))
            .expect("scope-switch result"),
        "the current tenant bearer must never replay a different tenant's record"
    );
    switched_server
        .join()
        .expect("scope-switch loopback server");

    let (origin_endpoint, origin_requests, origin_server) = loopback_server(vec![202]);
    drain_first_party_outbox_to_endpoint(temp.path(), &origin_identity, &origin_endpoint);
    assert!(
        !path.exists(),
        "the original verified Identity scope can acknowledge its record"
    );
    let request = origin_requests
        .recv_timeout(Duration::from_secs(3))
        .expect("origin delivery request");
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer origin-identity-token")
    );
    origin_server.join().expect("origin loopback server");
}

#[test]
fn failed_outbox_write_never_evicts_an_existing_record() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    for _ in 0..OUTBOX_CAPACITY {
        let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
            .expect("first-party projection");
        persist_first_party_event(temp.path(), &scope, &event).expect("fill durable outbox");
    }
    let oldest_path = outbox_paths(temp.path())
        .into_iter()
        .next()
        .expect("existing durable record");
    let replacement =
        first_party_event(&canonical_event(TurnStatus::Success).external_projection())
            .expect("first-party projection");

    assert!(
        persist_first_party_event_with_writer(
            temp.path(),
            &scope,
            &replacement,
            |_path, _bytes| { Err(anyhow::anyhow!("simulated disk full")) }
        )
        .is_none(),
        "a failed atomic write must not report success"
    );
    assert_eq!(outbox_paths(temp.path()).len(), OUTBOX_CAPACITY);
    assert!(
        oldest_path.exists(),
        "a failed replacement must not discard the oldest durable record"
    );
}

#[test]
fn permanent_client_rejection_is_quarantined_without_blocking_later_events() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    for _ in 0..2 {
        let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
            .expect("first-party projection");
        persist_first_party_event(temp.path(), &scope, &event).expect("persist first-party event");
    }
    let (endpoint, requests, server) = loopback_server(vec![400, 202]);
    let identity = delivery_session("identity-access-token", scope);

    drain_first_party_outbox_to_endpoint(temp.path(), &identity, &endpoint);

    assert!(
        outbox_paths(temp.path()).is_empty(),
        "the valid record after a permanent rejection must still drain"
    );
    assert_eq!(
        outbox_paths(&dead_letter_dir(temp.path())).len(),
        1,
        "the permanent rejection must be retained for local diagnosis"
    );
    for _ in 0..2 {
        let request = requests
            .recv_timeout(Duration::from_secs(3))
            .expect("first-party request");
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer identity-access-token")
        );
    }
    server.join().expect("loopback server");
}

#[test]
fn concurrent_outbox_writers_remain_within_capacity() {
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let scope = test_identity_scope("org-a", "workspace-a");
    for _ in 0..OUTBOX_CAPACITY - 1 {
        let event = first_party_event(&canonical_event(TurnStatus::Success).external_projection())
            .expect("first-party projection");
        persist_first_party_event(temp.path(), &scope, &event).expect("fill durable outbox");
    }

    let outbox_dir = temp.path().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let outbox_dir = outbox_dir.clone();
            let scope = scope.clone();
            let event =
                first_party_event(&canonical_event(TurnStatus::Success).external_projection())
                    .expect("first-party projection");
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                persist_first_party_event(&outbox_dir, &scope, &event)
                    .expect("concurrent outbox write");
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for handle in handles {
        handle.join().expect("concurrent outbox writer");
    }

    assert_eq!(outbox_paths(&outbox_dir).len(), OUTBOX_CAPACITY);
}

#[test]
fn configured_custom_export_never_receives_the_identity_bearer() {
    let _lock = crate::config::test_process_env_lock();
    let _restore = EnvRestore::capture(&[
        "MAESTRO_HOME",
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ]);
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    let (endpoint, requests, server) = loopback_server(vec![202]);
    std::env::set_var("MAESTRO_HOME", temp.path());
    clear_telemetry_env();
    std::env::set_var("MAESTRO_TELEMETRY_ENDPOINT", &endpoint);

    record_canonical_turn_event(&canonical_event(TurnStatus::Success));

    let request = requests
        .recv_timeout(Duration::from_secs(3))
        .expect("custom telemetry request");
    assert!(!request.to_ascii_lowercase().contains("authorization:"));
    assert!(request.contains("\"type\":\"canonical-turn\""));
    server.join().expect("loopback server");
}

#[test]
fn staged_rollout_usage_is_durably_logged_by_default() {
    let _lock = crate::config::test_process_env_lock();
    let _restore = EnvRestore::capture(&[
        "MAESTRO_HOME",
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
        "MAESTRO_TELEMETRY_SAMPLE",
        "PLAYWRIGHT_TELEMETRY_SAMPLE",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ]);
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    std::env::set_var("MAESTRO_HOME", temp.path());
    clear_telemetry_env();

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("telemetry runtime")
        .block_on(record_staged_rollout_surface_usage(
            "identity_required",
            "setup:identity",
            "setup",
            Some("maestro"),
            "test",
        ));

    let encoded = fs::read_to_string(temp.path().join("telemetry.log")).expect("telemetry log");
    let payload = parse_jsonl_record(&encoded);
    assert_eq!(payload["type"], "staged-rollout-surface");
    assert_eq!(payload["event"], "identity_required");
    assert_eq!(payload["surfaceId"], "setup:identity");
}

#[test]
fn telemetry_opt_out_suppresses_the_default_local_log_and_first_party_outbox() {
    let _lock = crate::config::test_process_env_lock();
    let _restore = EnvRestore::capture(&[
        "MAESTRO_HOME",
        "MAESTRO_TELEMETRY",
        "PLAYWRIGHT_TELEMETRY",
        "MAESTRO_TELEMETRY_FILE",
        "PLAYWRIGHT_TELEMETRY_FILE",
        "MAESTRO_INTERNAL_TELEMETRY_DISABLED",
        "EVALOPS_INTERNAL_TELEMETRY_DISABLED",
    ]);
    let temp = tempfile::tempdir().expect("telemetry tempdir");
    std::env::set_var("MAESTRO_HOME", temp.path());
    std::env::set_var("MAESTRO_TELEMETRY", "0");
    std::env::remove_var("MAESTRO_TELEMETRY_FILE");
    std::env::remove_var("PLAYWRIGHT_TELEMETRY_FILE");
    std::env::remove_var("MAESTRO_INTERNAL_TELEMETRY_DISABLED");
    std::env::remove_var("EVALOPS_INTERNAL_TELEMETRY_DISABLED");

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("telemetry runtime")
        .block_on(record_staged_rollout_surface_usage(
            "identity_required",
            "setup:identity",
            "setup",
            Some("maestro"),
            "test",
        ));
    record_canonical_turn_event(&canonical_event(TurnStatus::Success));

    assert!(!temp.path().join("telemetry.log").exists());
    assert!(!temp.path().join("telemetry/outbox").exists());
}

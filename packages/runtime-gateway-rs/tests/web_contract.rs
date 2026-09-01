use maestro_runtime_gateway::{RuntimeGatewayConfig, serve_listener};
use serde::Deserialize;
use std::collections::BTreeSet;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<RouteCase>,
}

#[derive(Deserialize)]
struct RouteCase {
    method: String,
    path: String,
}

#[tokio::test]
async fn every_frozen_web_route_is_owned_by_the_native_control_plane() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-cutover/web-routes.json"
    ))
    .expect("valid web route fixture");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        serve_listener(listener, RuntimeGatewayConfig::test_default())
            .await
            .unwrap();
    });

    let mut missing = BTreeSet::new();
    for case in fixture.cases {
        let path = materialize_path(&case.path);
        let response = request_head(address, &case.method, &path).await;
        let status = response
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or_default();
        if status == 501 {
            missing.insert(format!("{} {}", case.method, case.path));
        }
    }
    server.abort();
    assert!(
        missing.is_empty(),
        "unmigrated native routes:\n{}",
        missing.into_iter().collect::<Vec<_>>().join("\n")
    );
}

fn materialize_path(path: &str) -> String {
    path.replace(":workspaceId", "workspace-1")
        .replace(":controlId", "control-1")
        .replace(":taskType", "task-1")
        .replace(":requestId", "request-1")
        .replace(":attachmentId", "attachment-1")
        .replace(":filename", "artifact.txt")
        .replace(":period", "30d")
        .replace(":agentId", "agent-1")
        .replace(":token", "share-token")
        .replace(":id", "session-1")
}

async fn request_head(address: std::net::SocketAddr, method: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let body = if method == "GET" { "" } else { "{}" };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stream.read_to_end(&mut response),
    )
    .await;
    String::from_utf8_lossy(&response).into_owned()
}

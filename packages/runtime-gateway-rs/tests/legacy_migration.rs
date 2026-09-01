use maestro_runtime_gateway::{RuntimeGatewayConfig, serve_listener};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[tokio::test]
async fn legacy_session_map_is_atomically_upgraded_before_serving() {
    let root = test_root("legacy");
    std::fs::create_dir_all(&root).unwrap();
    let store = root.join("sessions.json");
    std::fs::write(
        &store,
        br#"{"session-2":{"id":"session-2","title":"Two","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}}"#,
    )
    .unwrap();
    let (address, server) = start(&store).await;
    let response = get(address, "/api/sessions").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    server.abort();

    let migrated: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
    assert!(migrated["sessions"]["session-2"].is_object());
    assert!(std::fs::read_dir(&root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("migration-")
    }));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn corrupt_legacy_state_is_left_byte_for_byte_untouched() {
    let root = test_root("corrupt");
    std::fs::create_dir_all(&root).unwrap();
    let store = root.join("sessions.json");
    let original = b"{broken legacy state";
    std::fs::write(&store, original).unwrap();
    let (_address, server) = start(&store).await;
    tokio::task::yield_now().await;
    server.abort();
    assert_eq!(std::fs::read(&store).unwrap(), original);
    let _ = std::fs::remove_dir_all(root);
}

async fn start(path: &Path) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = RuntimeGatewayConfig::test_default().with_session_store_path(path.to_path_buf());
    let server = tokio::spawn(async move { serve_listener(listener, config).await.unwrap() });
    (address, server)
}

async fn get(address: std::net::SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "maestro-runtime-gateway-migration-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

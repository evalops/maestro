use maestro_runtime_gateway::{RuntimeGatewayConfig, serve_listener};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn get(addr: std::net::SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .expect("write request");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("read response");
    response
}

#[tokio::test]
async fn library_server_serves_health_and_static_assets() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("maestro-runtime-gateway-library-{unique}"));
    tokio::fs::create_dir_all(&root).await.expect("create root");
    tokio::fs::write(root.join("index.html"), "<main>native</main>")
        .await
        .expect("write index");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local address");
    let config = RuntimeGatewayConfig::test_default().with_static_root(root.clone());
    let server = tokio::spawn(serve_listener(listener, config));

    let health = get(addr, "/healthz").await;
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    let index = get(addr, "/").await;
    assert!(index.starts_with("HTTP/1.1 200"), "{index}");
    assert!(index.contains("<main>native</main>"), "{index}");

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

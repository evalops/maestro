//! Native `maestro memory` shared-memory inspection command.

use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::{Client, Response, StatusCode};
use serde::Deserialize;
use serde_json::Value;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ATTEMPTS: usize = 2;
const INITIAL_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
struct SharedMemoryConfig {
    base_url: String,
    api_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CapabilitiesResponse {
    supports_sync: Option<bool>,
    supports_gzip: Option<bool>,
    max_body_bytes: Option<u64>,
    max_events_batch: Option<u64>,
    max_events: Option<u64>,
    max_event_payload_bytes: Option<u64>,
    max_event_type_length: Option<u64>,
    max_event_id_length: Option<u64>,
    max_session_id_length: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct ServiceMetricsResponse {
    status: Option<String>,
    now: Option<String>,
    capabilities: Option<CapabilitiesResponse>,
}

#[derive(Debug, Default, Deserialize)]
struct SessionMeta {
    last_seq: Option<u64>,
    min_seq: Option<u64>,
    updated_at: Option<String>,
    event_count: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct SessionMetricsResponse {
    meta: Option<SessionMeta>,
    metrics: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct AuditResponse {
    items: Option<Vec<BTreeMap<String, Value>>>,
}

pub async fn run_memory(args: &[String]) -> Result<i32> {
    let subcommand = args.first().map(String::as_str).unwrap_or("status");
    match subcommand {
        "help" | "--help" | "-h" => {
            println!("{}", memory_help());
            Ok(0)
        }
        "status" => {
            let config = config_from_env()?;
            let client = http_client()?;
            match status_output(&client, &config).await {
                Ok(output) => {
                    println!("{output}");
                    Ok(0)
                }
                Err(error) => {
                    eprintln!("Failed to fetch shared memory status: {error:#}");
                    Ok(1)
                }
            }
        }
        "capabilities" => {
            let config = config_from_env()?;
            let client = http_client()?;
            let caps: CapabilitiesResponse = fetch_json(&client, &config, "/capabilities").await?;
            println!("\nShared Memory Capabilities\n");
            println!("{}", capabilities_line(Some(&caps)));
            Ok(0)
        }
        "session" => {
            let Some(session_id) = args.get(1).filter(|value| !value.is_empty()) else {
                eprintln!("Session id required.");
                return Ok(1);
            };
            let config = config_from_env()?;
            let client = http_client()?;
            println!("{}", session_output(&client, &config, session_id).await?);
            Ok(0)
        }
        "audit" => {
            let Some(session_id) = args.get(1).filter(|value| !value.is_empty()) else {
                eprintln!("Session id required.");
                return Ok(1);
            };
            let limit = args
                .get(2)
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|value| *value > 0);
            let config = config_from_env()?;
            let client = http_client()?;
            println!(
                "{}",
                audit_output(&client, &config, session_id, limit).await?
            );
            Ok(0)
        }
        "export" => {
            let Some(session_id) = args.get(1).filter(|value| !value.is_empty()) else {
                eprintln!("Session id required.");
                return Ok(1);
            };
            let config = config_from_env()?;
            let client = http_client()?;
            let text = fetch_text(
                &client,
                &config,
                &format!(
                    "/sessions/{}/metrics.jsonl",
                    urlencoding::encode(session_id)
                ),
            )
            .await?;
            print!(
                "{}",
                export_text_for_stdout(&text, std::io::stdout().is_terminal())
            );
            if !text.ends_with('\n') {
                println!();
            }
            Ok(0)
        }
        "watch" => watch(args, config_from_env()?).await,
        other => {
            eprintln!("Unknown memory subcommand: {other}");
            println!("\nAvailable commands:");
            println!("{}", memory_help());
            Ok(1)
        }
    }
}

fn config_from_env() -> Result<SharedMemoryConfig> {
    let base_url = std::env::var("MAESTRO_SHARED_MEMORY_BASE")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .context(
            "MAESTRO_SHARED_MEMORY_BASE is not set. Configure shared memory to use this command.",
        )?;
    let api_key = std::env::var("MAESTRO_SHARED_MEMORY_API_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    Ok(SharedMemoryConfig { base_url, api_key })
}

fn http_client() -> Result<Client> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("failed to create shared memory HTTP client")
}

async fn fetch_response(
    client: &Client,
    config: &SharedMemoryConfig,
    path: &str,
) -> Result<Response> {
    let url = format!("{}{}", config.base_url, path);
    for attempt in 0..MAX_ATTEMPTS {
        let mut request = client.get(&url);
        if let Some(api_key) = &config.api_key {
            request = request.bearer_auth(api_key);
        }
        match request.send().await {
            Ok(response) if !retryable_status(response.status()) || attempt + 1 == MAX_ATTEMPTS => {
                return Ok(response);
            }
            Ok(response) => {
                tokio::time::sleep(retry_delay(&response, attempt)).await;
            }
            Err(error) if attempt + 1 == MAX_ATTEMPTS => {
                return Err(error).context("shared memory service request failed");
            }
            Err(_) => tokio::time::sleep(exponential_delay(attempt)).await,
        }
    }
    unreachable!("shared memory retry loop always returns")
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429) || status.is_server_error()
}

fn exponential_delay(attempt: usize) -> Duration {
    let multiplier = 1_u32.checked_shl(attempt as u32).unwrap_or(u32::MAX);
    INITIAL_RETRY_DELAY
        .saturating_mul(multiplier)
        .min(MAX_RETRY_DELAY)
}

fn retry_delay(response: &Response, attempt: usize) -> Duration {
    response
        .headers()
        .get("retry-after-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| exponential_delay(attempt))
        .min(MAX_RETRY_DELAY)
}

async fn fetch_text(client: &Client, config: &SharedMemoryConfig, path: &str) -> Result<String> {
    let response = fetch_response(client, config, path).await?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("Unknown").to_owned();
    let text = response
        .text()
        .await
        .context("failed to read shared memory response")?;
    if !status.is_success() {
        bail!(
            "Shared memory error {}: {}",
            status.as_u16(),
            if text.is_empty() { &status_text } else { &text }
        );
    }
    Ok(text)
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &Client,
    config: &SharedMemoryConfig,
    path: &str,
) -> Result<T> {
    let text = fetch_text(client, config, path).await?;
    serde_json::from_str(if text.is_empty() { "{}" } else { &text })
        .context("shared memory service returned invalid JSON")
}

/// Sanitize the raw shared-memory HTTP response body (`memory export`'s
/// JSONL payload) before it reaches the real terminal, which has no
/// ratatui `Buffer` in this CLI path to filter it.
///
/// This happens at the print boundary, not in `fetch_text` (which
/// `fetch_json` also uses to feed `serde_json::from_str`): sanitizing
/// there could strip bytes that are meaningful to the JSON parser.
fn sanitize_export_text(text: &str) -> String {
    crate::output_sanitize::sanitize_control_chars(text)
}

/// Decide whether `memory export`'s stdout write should sanitize `text`.
///
/// `export`'s whole point is byte-exact JSONL: a valid JSON string can
/// legitimately contain C1 code points (e.g. `U+0085`), and
/// `sanitize_export_text` would silently corrupt those when the output is
/// redirected to a file or another process -- which also cannot execute a
/// terminal escape sequence in the first place, so there is nothing to
/// protect against there. Only sanitize when stdout is an actual terminal.
/// Takes `stdout_is_terminal` as a parameter (mirroring
/// `hyperlink::format_link_with_fallback`'s `is_tty` parameter) so this
/// stays unit-testable without a real pty.
fn export_text_for_stdout(text: &str, stdout_is_terminal: bool) -> String {
    if stdout_is_terminal {
        sanitize_export_text(text)
    } else {
        text.to_string()
    }
}

async fn status_output(client: &Client, config: &SharedMemoryConfig) -> Result<String> {
    let metrics: ServiceMetricsResponse = fetch_json(client, config, "/metrics").await?;
    let mut lines = vec![
        "\nShared Memory\n".to_owned(),
        format!("Base: {}", config.base_url),
        format!("Status: {}", metrics.status.as_deref().unwrap_or("unknown")),
    ];
    if let Some(now) = metrics.now {
        lines.push(format!("Time: {now}"));
    }
    lines.push(capabilities_line(metrics.capabilities.as_ref()));
    // `metrics.status` and `metrics.now` are server-controlled JSON string
    // fields; this function's sole consumer is `print!`/`println!` to the
    // real terminal (no ratatui `Buffer` in this CLI path), so sanitize the
    // fully assembled output here rather than at ingestion.
    Ok(crate::output_sanitize::sanitize_control_chars(
        &lines.join("\n"),
    ))
}

fn capabilities_line(capabilities: Option<&CapabilitiesResponse>) -> String {
    let Some(cap) = capabilities else {
        return "Capabilities unavailable".to_owned();
    };
    let value = |value: Option<u64>| value.map_or_else(|| "?".to_owned(), |v| v.to_string());
    [
        format!(
            "sync: {}",
            if cap.supports_sync != Some(false) {
                "on"
            } else {
                "off"
            }
        ),
        format!(
            "gzip: {}",
            if cap.supports_gzip != Some(false) {
                "on"
            } else {
                "off"
            }
        ),
        format!("max_body: {}", value(cap.max_body_bytes)),
        format!("max_batch: {}", value(cap.max_events_batch)),
        format!("max_events: {}", value(cap.max_events)),
        format!("event_payload: {}", value(cap.max_event_payload_bytes)),
        format!("event_type: {}", value(cap.max_event_type_length)),
        format!("event_id: {}", value(cap.max_event_id_length)),
        format!("session_id: {}", value(cap.max_session_id_length)),
    ]
    .join("  ·  ")
}

async fn session_output(
    client: &Client,
    config: &SharedMemoryConfig,
    session_id: &str,
) -> Result<String> {
    let response: SessionMetricsResponse = fetch_json(
        client,
        config,
        &format!("/sessions/{}/metrics", urlencoding::encode(session_id)),
    )
    .await?;
    let mut lines = vec![
        "\nShared Memory Session\n".to_owned(),
        format!("Session: {session_id}"),
    ];
    if let Some(meta) = response.meta {
        lines.push(format!(
            "last_seq: {}  ·  min_seq: {}  ·  events: {}",
            display_number(meta.last_seq),
            display_number(meta.min_seq),
            display_number(meta.event_count)
        ));
        if let Some(updated_at) = meta.updated_at {
            lines.push(format!("Updated: {updated_at}"));
        }
    }
    if let Some(metrics) = response.metrics {
        lines.push("\nShared Memory Sync Metrics\n".to_owned());
        for (key, value) in metrics {
            if !value.is_null() {
                lines.push(format!("  {key}: {value}"));
            }
        }
    }
    // `updated_at` and the sync-metrics keys/values are server-controlled;
    // see the comment in `status_output` for why sanitization happens here.
    Ok(crate::output_sanitize::sanitize_control_chars(
        &lines.join("\n"),
    ))
}

async fn audit_output(
    client: &Client,
    config: &SharedMemoryConfig,
    session_id: &str,
    limit: Option<usize>,
) -> Result<String> {
    let response: AuditResponse = fetch_json(
        client,
        config,
        &format!("/sessions/{}/audit", urlencoding::encode(session_id)),
    )
    .await?;
    let items = response.items.unwrap_or_default();
    let start = limit.map_or(0, |limit| items.len().saturating_sub(limit));
    let mut lines = vec!["\nShared Memory Audit\n".to_owned()];
    if items.is_empty() || start == items.len() {
        lines.push("No audit entries found.".to_owned());
        return Ok(lines.join("\n"));
    }
    for entry in &items[start..] {
        lines.push(format!(
            "{}  ·  mode: {}  ·  events: {}  ·  source: {}",
            display_value(entry.get("at"), "?"),
            display_value(entry.get("mode"), "?"),
            display_value(entry.get("event_count"), "0"),
            display_value(entry.get("source"), "?")
        ));
    }
    // Every `display_value` above can surface an arbitrary server-controlled
    // JSON string (`at`/`mode`/`source`); see the comment in `status_output`.
    Ok(crate::output_sanitize::sanitize_control_chars(
        &lines.join("\n"),
    ))
}

async fn watch(args: &[String], config: SharedMemoryConfig) -> Result<i32> {
    let session_id = args.get(1).filter(|value| !value.is_empty());
    let interval_ms = args
        .get(2)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(2_000);
    println!(
        "Watching {} every {interval_ms}ms. Ctrl+C to stop.",
        session_id.map_or_else(|| "service".to_owned(), |id| format!("session {id}"))
    );
    let client = http_client()?;
    loop {
        let result = match session_id {
            Some(id) => session_output(&client, &config, id).await,
            None => status_output(&client, &config).await,
        };
        match result {
            Ok(output) => println!("{output}"),
            Err(error) => eprintln!("Shared memory watch error: {error:#}"),
        }
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
    }
}

fn display_number(value: Option<u64>) -> String {
    value.map_or_else(|| "?".to_owned(), |value| value.to_string())
}

fn display_value(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => fallback.to_owned(),
    }
}

fn memory_help() -> &'static str {
    "  maestro memory [status]\n  maestro memory capabilities\n  maestro memory session <id>\n  maestro memory audit <id> [limit]\n  maestro memory export <id>\n  maestro memory watch [id] [intervalMs]"
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn capabilities_preserve_legacy_defaults_and_limits() {
        let line = capabilities_line(Some(&CapabilitiesResponse {
            supports_sync: None,
            supports_gzip: Some(false),
            max_body_bytes: Some(1024),
            max_events_batch: Some(10),
            ..CapabilitiesResponse::default()
        }));
        assert!(line.contains("sync: on"));
        assert!(line.contains("gzip: off"));
        assert!(line.contains("max_body: 1024"));
        assert!(line.contains("max_events: ?"));
    }

    #[test]
    fn retryable_status_matches_downstream_http_contract() {
        assert!(retryable_status(StatusCode::REQUEST_TIMEOUT));
        assert!(retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!retryable_status(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn status_retries_transient_failure_and_sends_bearer_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0_u8; 4096];
                let read = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]);
                assert!(request.starts_with("GET /metrics HTTP/1.1"));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer memory-key"));
                let response = if attempt == 0 {
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 11\r\nRetry-After-Ms: 1\r\nConnection: close\r\n\r\nunavailable"
                        .to_owned()
                } else {
                    let body = r#"{"status":"ok","now":"2026-04-20T00:00:00.000Z","capabilities":{"supports_sync":true,"supports_gzip":true,"max_body_bytes":1024,"max_events_batch":10}}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let config = SharedMemoryConfig {
            base_url: format!("http://{address}"),
            api_key: Some("memory-key".to_owned()),
        };
        let output = status_output(&http_client().unwrap(), &config)
            .await
            .unwrap();
        server.await.unwrap();
        assert!(output.contains("Shared Memory"));
        assert!(output.contains("Status: ok"));
        assert!(output.contains("max_body: 1024"));
    }

    #[tokio::test]
    async fn missing_session_id_fails_before_reading_config() {
        let result = run_memory(&["session".to_owned()]).await.unwrap();
        assert_eq!(result, 1);
    }

    #[tokio::test]
    async fn status_output_sanitizes_server_controlled_strings() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            // `\u001b` / `\u0007` are valid JSON string escapes that decode
            // to a literal ESC/BEL byte in the parsed Rust `String` -- this
            // is how a malicious/compromised shared-memory service could
            // smuggle a minimal OSC-0 (set title) sequence through
            // `metrics.status`.
            let body = r#"{"status":"ok\u001b]0;evil\u0007","now":"safe","capabilities":null}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let config = SharedMemoryConfig {
            base_url: format!("http://{address}"),
            api_key: None,
        };
        let output = status_output(&http_client().unwrap(), &config)
            .await
            .unwrap();
        server.await.unwrap();
        assert!(!output.contains('\x1b'));
        assert!(!output.contains('\x07'));
        assert!(output.contains("Status: ok]0;evil"));
    }

    #[tokio::test]
    async fn session_output_sanitizes_server_controlled_strings() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            let body = r#"{"meta":{"last_seq":1,"min_seq":0,"event_count":2,"updated_at":"bad\u001b]0;evil\u0007time"},"metrics":{"queue_depth":"12"}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let config = SharedMemoryConfig {
            base_url: format!("http://{address}"),
            api_key: None,
        };
        let output = session_output(&http_client().unwrap(), &config, "sess-1")
            .await
            .unwrap();
        server.await.unwrap();
        assert!(!output.contains('\x1b'));
        assert!(!output.contains('\x07'));
        assert!(output.contains("Updated: bad]0;eviltime"));
    }

    #[tokio::test]
    async fn audit_output_sanitizes_server_controlled_strings() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            let body = r#"{"items":[{"at":"t0","mode":"m","event_count":1,"source":"peer\u001b]0;evil\u0007"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let config = SharedMemoryConfig {
            base_url: format!("http://{address}"),
            api_key: None,
        };
        let output = audit_output(&http_client().unwrap(), &config, "sess-1", None)
            .await
            .unwrap();
        server.await.unwrap();
        assert!(!output.contains('\x1b'));
        assert!(!output.contains('\x07'));
        assert!(output.contains("source: peer]0;evil"));
    }

    #[test]
    fn sanitize_export_text_strips_osc_injection_preserves_visible_text() {
        let input = "line one\nbefore\x1b]0;evil\x07after";
        let out = sanitize_export_text(input);
        assert_eq!(out, "line one\nbefore]0;evilafter");
        assert!(!out.contains('\x1b'));
        assert!(!out.contains('\x07'));
    }

    #[test]
    fn sanitize_export_text_preserves_ordinary_jsonl_text() {
        let input = "{\"seq\":1}\n{\"seq\":2}\n";
        assert_eq!(sanitize_export_text(input), input);
    }

    #[test]
    fn export_text_for_stdout_sanitizes_only_when_a_terminal() {
        let input = "before\x1b]0;evil\x07after";
        assert_eq!(export_text_for_stdout(input, true), "before]0;evilafter");
        // Redirected output must be byte-exact, even for control bytes that
        // would be dangerous on a real terminal.
        assert_eq!(export_text_for_stdout(input, false), input);
    }

    #[test]
    fn export_text_for_stdout_preserves_c1_jsonl_when_redirected() {
        // A legitimate JSON string value containing U+0085 (NEL, a C1 code
        // point `sanitize_control_chars` would otherwise strip) must survive
        // byte-for-byte when stdout is not a terminal.
        let input = "{\"note\":\"line one\u{0085}line two\"}\n";
        assert_eq!(export_text_for_stdout(input, false), input);
        assert_ne!(export_text_for_stdout(input, true), input);
    }
}

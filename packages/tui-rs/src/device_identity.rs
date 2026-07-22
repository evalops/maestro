//! Desktop device-identity helper for EvalOps OAuth enroll + refresh proofs.
//!
//! Mirrors `src/oauth/device-identity.ts`:
//! - Spawns the native helper from `MAESTRO_DEVICE_IDENTITY_HELPER` (macOS, or test helper)
//! - Soft-fails to `None` when the helper is missing, unusable, or identity HTTP fails
//! - Builds device proofs and enrolls devices against the identity service

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const SIGN_TIMEOUT: Duration = Duration::from_mins(2);
const DEVICE_CHALLENGES_PATH: &str = "/v1/device-challenges";
const DEVICES_PATH: &str = "/v1/devices";
const APP_BUNDLE_ID: &str = "com.evalops.composer";

/// Status payload returned by the device-identity helper.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceIdentityStatus {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_spki: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Signed device proof attached to refresh / delegation requests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceProof {
    pub challenge_id: String,
    pub device_id: String,
    pub signature: String,
}

/// Purpose for identity device challenges that produce proofs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceProofPurpose {
    Refresh,
    Delegation,
    Verify,
}

impl DeviceProofPurpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::Refresh => "refresh",
            Self::Delegation => "delegation",
            Self::Verify => "verify",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceChallengeResponse {
    challenge: Option<String>,
    challenge_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegisterDeviceResponse {
    device: Option<RegisterDeviceBody>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegisterDeviceBody {
    id: Option<String>,
}

fn get_helper_path() -> Option<PathBuf> {
    let value = std::env::var("MAESTRO_DEVICE_IDENTITY_HELPER")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())?;
    if helper_path_allowed() {
        Some(PathBuf::from(value))
    } else {
        None
    }
}

/// Helper is allowed on macOS always; on other platforms only when the test override is set
/// (mirrors `NODE_ENV=test` + `MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER=1` in TS).
fn helper_path_allowed() -> bool {
    if cfg!(target_os = "macos") {
        return true;
    }
    std::env::var("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER")
        .ok()
        .as_deref()
        == Some("1")
}

async fn helper_exists(helper_path: &Path) -> bool {
    let Ok(metadata) = tokio::fs::metadata(helper_path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

async fn run_helper(request: &Value, timeout: Duration) -> Option<DeviceIdentityStatus> {
    let helper_path = get_helper_path()?;
    if !helper_exists(&helper_path).await {
        return None;
    }

    let mut child = Command::new(&helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let mut stdout = child.stdout.take()?;
    let payload = serde_json::to_vec(request).ok()?;

    let outcome = tokio::time::timeout(timeout, async {
        stdin.write_all(&payload).await.ok()?;
        drop(stdin);
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).await.ok()?;
        Some(buf)
    })
    .await;

    let buf = match outcome {
        Ok(Some(buf)) => buf,
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return None;
        }
    };
    let _ = child.wait().await;
    serde_json::from_slice(&buf).ok()
}

/// Query local desktop device identity status via the helper.
pub async fn get_desktop_device_identity_status() -> Option<DeviceIdentityStatus> {
    run_helper(&json!({ "command": "status" }), DEFAULT_TIMEOUT).await
}

async fn sign_device_challenge(challenge: &str) -> Option<DeviceIdentityStatus> {
    let response = run_helper(
        &json!({ "command": "sign", "challenge": challenge }),
        SIGN_TIMEOUT,
    )
    .await?;
    if !response.available
        || response.device_id.as_ref().is_none_or(|id| id.is_empty())
        || response.signature.as_ref().is_none_or(|s| s.is_empty())
    {
        return None;
    }
    Some(response)
}

async fn create_device_challenge(
    client: &Client,
    identity_base_url: &str,
    purpose: &str,
    device_id: Option<&str>,
) -> Option<DeviceChallengeResponse> {
    let mut body = json!({ "purpose": purpose });
    if let Some(device_id) = device_id {
        body["device_id"] = Value::String(device_id.to_owned());
    }
    let response = client
        .post(format!(
            "{}{DEVICE_CHALLENGES_PATH}",
            identity_base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(DEFAULT_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

/// Build a device proof for the current desktop identity (if available).
pub async fn build_desktop_device_proof(
    client: &Client,
    identity_base_url: &str,
    purpose: DeviceProofPurpose,
) -> Option<DeviceProof> {
    let status = get_desktop_device_identity_status().await;
    build_desktop_device_proof_from_status(client, identity_base_url, purpose, status).await
}

/// Build a proof only when the local device matches a previously enrolled device id.
pub async fn build_enrolled_desktop_device_proof(
    client: &Client,
    identity_base_url: &str,
    purpose: DeviceProofPurpose,
    enrolled_device_id: Option<&str>,
) -> Option<DeviceProof> {
    let expected = enrolled_device_id
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let status = get_desktop_device_identity_status().await;
    if status.as_ref().and_then(|s| s.device_id.as_deref()) != Some(expected) {
        return None;
    }
    build_desktop_device_proof_from_status(client, identity_base_url, purpose, status).await
}

async fn build_desktop_device_proof_from_status(
    client: &Client,
    identity_base_url: &str,
    purpose: DeviceProofPurpose,
    status: Option<DeviceIdentityStatus>,
) -> Option<DeviceProof> {
    let status = status?;
    if !status.available {
        return None;
    }
    let device_id = status.device_id.filter(|id| !id.is_empty())?;
    let challenge = create_device_challenge(
        client,
        identity_base_url,
        purpose.as_str(),
        Some(&device_id),
    )
    .await?;
    let challenge_value = challenge.challenge.filter(|c| !c.is_empty())?;
    let challenge_id = challenge.challenge_id.filter(|c| !c.is_empty())?;
    let signed = sign_device_challenge(&challenge_value).await?;
    Some(DeviceProof {
        challenge_id,
        device_id: signed.device_id?,
        signature: signed.signature?,
    })
}

/// Enroll the local desktop device with the identity service. Soft-fails to `None`.
pub async fn enroll_desktop_device_identity(
    client: &Client,
    identity_base_url: &str,
    access_token: &str,
    app_version: Option<&str>,
) -> Option<String> {
    let status = get_desktop_device_identity_status().await?;
    if !status.available {
        return None;
    }
    let public_key_spki = status.public_key_spki.filter(|k| !k.is_empty())?;
    let challenge = create_device_challenge(client, identity_base_url, "enroll", None).await?;
    let challenge_value = challenge.challenge.filter(|c| !c.is_empty())?;
    let challenge_id = challenge.challenge_id.filter(|c| !c.is_empty())?;
    let signed = sign_device_challenge(&challenge_value).await?;
    let signed_device_id = signed.device_id.filter(|id| !id.is_empty())?;
    let signature = signed.signature.filter(|s| !s.is_empty())?;

    let body = json!({
        "app_bundle_id": APP_BUNDLE_ID,
        "app_version": app_version,
        "attestation_kind": "none",
        "attestation_status": "unverified",
        "challenge_id": challenge_id,
        "device_id": signed_device_id,
        "key_algorithm": status.key_algorithm.as_deref().unwrap_or("p256_ecdsa_sha256"),
        "key_origin": status.key_origin.as_deref().unwrap_or("secure_enclave"),
        "platform": "macos",
        "public_key_spki": public_key_spki,
        "signature": signature,
    });

    let response = client
        .post(format!(
            "{}{DEVICES_PATH}",
            identity_base_url.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(DEFAULT_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: RegisterDeviceResponse = response.json().await.ok()?;
    Some(
        payload
            .device
            .and_then(|device| device.id)
            .filter(|id| !id.is_empty())
            .unwrap_or(signed_device_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    fn fake_helper_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/fake-device-identity-helper.mjs")
            .canonicalize()
            .expect("fake device identity helper exists")
    }

    struct EnvGuard {
        previous: HashMap<&'static str, Option<String>>,
    }

    impl EnvGuard {
        fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
            let mut previous = HashMap::new();
            for (key, value) in pairs {
                previous.insert(*key, std::env::var(key).ok());
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
            Self { previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.previous {
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        authorization: Option<String>,
        body: Value,
        method: String,
        path: String,
    }

    async fn start_identity_harness() -> (
        String,
        Arc<Mutex<Vec<CapturedRequest>>>,
        oneshot::Sender<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let base_url = format!("http://{address}");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_server = Arc::clone(&requests);
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let challenge_count = Arc::new(Mutex::new(0_u32));

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break };
                        let mut buf = vec![0_u8; 64 * 1024];
                        let Ok(n) = stream.read(&mut buf).await else { continue };
                        if n == 0 {
                            continue;
                        }
                        let raw = String::from_utf8_lossy(&buf[..n]);
                        let (header_section, body_section) = raw
                            .split_once("\r\n\r\n")
                            .unwrap_or((raw.as_ref(), ""));
                        let first = header_section.lines().next().unwrap_or_default();
                        let mut parts = first.split_whitespace();
                        let method = parts.next().unwrap_or("GET").to_owned();
                        let path = parts.next().unwrap_or("/").to_owned();
                        let authorization = header_section.lines().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("authorization") {
                                Some(value.trim().to_owned())
                            } else {
                                None
                            }
                        });
                        let content_length = header_section
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        let mut body_bytes = body_section.as_bytes().to_vec();
                        while body_bytes.len() < content_length {
                            let mut more = vec![0_u8; content_length - body_bytes.len()];
                            match stream.read(&mut more).await {
                                Ok(0) => break,
                                Ok(read) => body_bytes.extend_from_slice(&more[..read]),
                                Err(_) => break,
                            }
                        }
                        let body: Value = serde_json::from_slice(&body_bytes[..content_length.min(body_bytes.len())])
                            .unwrap_or(json!({}));
                        requests_server
                            .lock()
                            .expect("lock")
                            .push(CapturedRequest {
                                authorization,
                                body: body.clone(),
                                method: method.clone(),
                                path: path.clone(),
                            });

                        let response_body = if method == "POST" && path == DEVICE_CHALLENGES_PATH {
                            let mut count = challenge_count.lock().expect("lock");
                            *count += 1;
                            let n = *count;
                            let purpose = body
                                .get("purpose")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            let device_id = body
                                .get("device_id")
                                .and_then(Value::as_str)
                                .unwrap_or("none");
                            json!({
                                "challenge": format!("challenge:{purpose}:{device_id}"),
                                "challenge_id": format!("challenge-{n}"),
                            })
                            .to_string()
                        } else if method == "POST" && path == DEVICES_PATH {
                            let device_id = body
                                .get("device_id")
                                .cloned()
                                .unwrap_or(Value::String("unknown".to_owned()));
                            json!({ "device": { "id": device_id } }).to_string()
                        } else {
                            json!({ "error": "not-found" }).to_string()
                        };
                        let status = if response_body.contains("not-found") {
                            "404 Not Found"
                        } else {
                            "200 OK"
                        };
                        let response = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                            response_body.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                }
            }
        });

        (base_url, requests, shutdown_tx)
    }

    fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client")
    }

    #[tokio::test]
    async fn soft_fails_without_helper() {
        let _env = EnvGuard::set(&[
            ("MAESTRO_DEVICE_IDENTITY_HELPER", None),
            ("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER", Some("1")),
        ]);
        assert!(get_desktop_device_identity_status().await.is_none());
        let proof = build_desktop_device_proof(
            &client(),
            "http://127.0.0.1:1",
            DeviceProofPurpose::Refresh,
        )
        .await;
        assert!(proof.is_none());
        let enrolled =
            enroll_desktop_device_identity(&client(), "http://127.0.0.1:1", "token", Some("1.0.0"))
                .await;
        assert!(enrolled.is_none());
    }

    #[tokio::test]
    async fn soft_fails_when_helper_not_allowed_on_non_macos() {
        if cfg!(target_os = "macos") {
            return;
        }
        let helper = fake_helper_path();
        let _env = EnvGuard::set(&[
            (
                "MAESTRO_DEVICE_IDENTITY_HELPER",
                Some(helper.to_str().expect("utf8")),
            ),
            ("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER", None),
        ]);
        assert!(get_desktop_device_identity_status().await.is_none());
    }

    #[tokio::test]
    async fn builds_desktop_proof_against_local_identity_challenge() {
        let helper = fake_helper_path();
        let _env = EnvGuard::set(&[
            (
                "MAESTRO_DEVICE_IDENTITY_HELPER",
                Some(helper.to_str().expect("utf8")),
            ),
            ("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER", Some("1")),
            ("MAESTRO_FAKE_DEVICE_ID", Some("desktop-test-device")),
            (
                "MAESTRO_FAKE_PUBLIC_KEY_SPKI",
                Some("fake-p256-public-key-spki"),
            ),
        ]);
        let (base_url, requests, shutdown) = start_identity_harness().await;
        let proof =
            build_desktop_device_proof(&client(), &base_url, DeviceProofPurpose::Refresh).await;
        let _ = shutdown.send(());
        assert_eq!(
            proof,
            Some(DeviceProof {
                challenge_id: "challenge-1".to_owned(),
                device_id: "desktop-test-device".to_owned(),
                signature: "fake-signature:challenge:refresh:desktop-test-device".to_owned(),
            })
        );
        let captured = requests.lock().expect("lock");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].method, "POST");
        assert_eq!(captured[0].path, DEVICE_CHALLENGES_PATH);
        assert_eq!(
            captured[0].body.get("device_id").and_then(Value::as_str),
            Some("desktop-test-device")
        );
        assert_eq!(
            captured[0].body.get("purpose").and_then(Value::as_str),
            Some("refresh")
        );
    }

    #[tokio::test]
    async fn suppresses_proofs_when_local_device_not_enrolled() {
        let helper = fake_helper_path();
        let _env = EnvGuard::set(&[
            (
                "MAESTRO_DEVICE_IDENTITY_HELPER",
                Some(helper.to_str().expect("utf8")),
            ),
            ("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER", Some("1")),
            ("MAESTRO_FAKE_DEVICE_ID", Some("desktop-test-device")),
        ]);
        let (base_url, requests, shutdown) = start_identity_harness().await;
        let proof = build_enrolled_desktop_device_proof(
            &client(),
            &base_url,
            DeviceProofPurpose::Refresh,
            Some("previously-enrolled-device"),
        )
        .await;
        let _ = shutdown.send(());
        assert!(proof.is_none());
        assert!(requests.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn enrolls_fake_desktop_device_with_signed_challenge() {
        let helper = fake_helper_path();
        let _env = EnvGuard::set(&[
            (
                "MAESTRO_DEVICE_IDENTITY_HELPER",
                Some(helper.to_str().expect("utf8")),
            ),
            ("MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER", Some("1")),
            ("MAESTRO_FAKE_DEVICE_ID", Some("desktop-test-device")),
            (
                "MAESTRO_FAKE_PUBLIC_KEY_SPKI",
                Some("fake-p256-public-key-spki"),
            ),
        ]);
        let (base_url, requests, shutdown) = start_identity_harness().await;
        let device_id = enroll_desktop_device_identity(
            &client(),
            &base_url,
            "access-token",
            Some("1.2.3-test"),
        )
        .await;
        let _ = shutdown.send(());
        assert_eq!(device_id.as_deref(), Some("desktop-test-device"));
        let captured = requests.lock().expect("lock");
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0].path, DEVICE_CHALLENGES_PATH);
        assert_eq!(
            captured[0].body.get("purpose").and_then(Value::as_str),
            Some("enroll")
        );
        assert_eq!(captured[1].path, DEVICES_PATH);
        assert_eq!(
            captured[1].authorization.as_deref(),
            Some("Bearer access-token")
        );
        assert_eq!(
            captured[1]
                .body
                .get("app_bundle_id")
                .and_then(Value::as_str),
            Some(APP_BUNDLE_ID)
        );
        assert_eq!(
            captured[1].body.get("app_version").and_then(Value::as_str),
            Some("1.2.3-test")
        );
        assert_eq!(
            captured[1].body.get("device_id").and_then(Value::as_str),
            Some("desktop-test-device")
        );
        assert_eq!(
            captured[1]
                .body
                .get("public_key_spki")
                .and_then(Value::as_str),
            Some("fake-p256-public-key-spki")
        );
        assert_eq!(
            captured[1].body.get("signature").and_then(Value::as_str),
            Some("fake-signature:challenge:enroll:none")
        );
        assert_eq!(
            captured[1].body.get("platform").and_then(Value::as_str),
            Some("macos")
        );
    }
}

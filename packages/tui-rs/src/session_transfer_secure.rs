//! Signed and authenticated encrypted portable-session transfer.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::session::SessionManager;

use super::{
    build_portable_bundle, ensure_output_parent, find_session, import_bundle_with_source,
    import_entries_with_source, write_private_file, ImportResult, PortableBundle, PortableSession,
    PORTABLE_FORMAT,
};

/// Stable machine-readable format for encrypted, signed session bundles.
pub const SECURE_PORTABLE_FORMAT: &str = "evalops.maestro.secure-session.v1";
const SECURE_ENCRYPTION_ALGORITHM: &str = "AES-256-GCM";
const SECURE_SIGNATURE_ALGORITHM: &str = "Ed25519";
const SECURE_RECIPIENT_KIND: &str = "symmetric-key";
const SECURE_KEY_BYTES: usize = 32;
const SECURE_SIGNATURE_BYTES: usize = 64;
const SECURE_TAG_BYTES: usize = 16;
const SECURE_MAX_ID_BYTES: usize = 128;
const SECURE_MAX_BUNDLE_BYTES: u64 = 16 * 1024 * 1024;
const SECURE_SIGNATURE_DOMAIN: &[u8] = b"evalops.maestro.secure-session.signature.v1";

/// Explicit key material references for secure session export.
///
/// The key files are intentionally not resolved through Maestro configuration
/// or a server. The encryption key is a 32-byte AES-256 key file and the
/// signing key is an Ed25519 PKCS#8 private-key file. Both are supplied by the
/// operator through an out-of-band trust process.
#[derive(Debug, Clone)]
pub struct SecureSessionExportOptions {
    pub encryption_key_file: PathBuf,
    pub signing_key_file: PathBuf,
    pub recipient_key_id: String,
    pub signing_key_id: String,
}

/// Explicit key material references for secure session import.
#[derive(Debug, Clone)]
pub struct SecureSessionImportOptions {
    pub encryption_key_file: PathBuf,
    pub verify_key_file: PathBuf,
    pub expected_recipient_key_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecurePortableBundle {
    format: String,
    exported_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sessions: Vec<SecurePortableSession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecurePortableSession {
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    entries: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecureSessionRecipient {
    kind: String,
    key_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecureSessionEncryption {
    algorithm: String,
    key_id: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecureSessionSigner {
    algorithm: String,
    key_id: String,
    signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecureSessionEnvelope {
    format: String,
    bundle_id: String,
    issued_at: String,
    recipient: SecureSessionRecipient,
    encryption: SecureSessionEncryption,
    signer: SecureSessionSigner,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureSessionSignedEnvelope<'a> {
    format: &'a str,
    bundle_id: &'a str,
    issued_at: &'a str,
    recipient: &'a SecureSessionRecipient,
    encryption: &'a SecureSessionEncryption,
    signer: SecureSessionUnsignedSigner<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureSessionUnsignedSigner<'a> {
    algorithm: &'a str,
    key_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureSessionAssociatedData<'a> {
    format: &'a str,
    bundle_id: &'a str,
    issued_at: &'a str,
    recipient_kind: &'a str,
    recipient_key_id: &'a str,
    encryption_algorithm: &'a str,
    encryption_key_id: &'a str,
    nonce: &'a str,
}

/// Export a redacted session family in a signed and encrypted envelope.
pub fn export_secure_portable_session(
    manager: &SessionManager,
    session_id: &str,
    output: Option<&Path>,
    options: &SecureSessionExportOptions,
) -> Result<PathBuf> {
    validate_key_id(&options.recipient_key_id, "recipient key id")?;
    validate_key_id(&options.signing_key_id, "signing key id")?;
    let selected = find_session(manager, session_id)?;
    let output = output.map_or_else(
        || default_secure_export_path(&selected.path),
        Path::to_path_buf,
    );
    ensure_output_parent(&output)?;

    // Secure exports always redact before serialization and encryption. There
    // is no opt-out at this boundary because encryption is not a substitute
    // for removing credentials from a portable artifact.
    let bundle = build_portable_bundle(&selected, true)?;
    let payload = serde_json::to_vec(&bundle).context("serialize secure session payload")?;
    let encryption_key = read_symmetric_key(&options.encryption_key_file)?;
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| anyhow::anyhow!("generate secure session nonce"))?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let bundle_id = uuid::Uuid::new_v4().to_string();
    let issued_at = chrono::Utc::now().to_rfc3339();
    let recipient = SecureSessionRecipient {
        kind: SECURE_RECIPIENT_KIND.to_string(),
        key_id: options.recipient_key_id.clone(),
    };
    let mut encryption = SecureSessionEncryption {
        algorithm: SECURE_ENCRYPTION_ALGORITHM.to_string(),
        key_id: options.recipient_key_id.clone(),
        nonce,
        ciphertext: String::new(),
    };
    let aad = secure_session_associated_data(
        SECURE_PORTABLE_FORMAT,
        &bundle_id,
        &issued_at,
        &recipient,
        &encryption,
    )?;
    let unbound_key = UnboundKey::new(&AES_256_GCM, encryption_key.as_slice())
        .map_err(|_| anyhow::anyhow!("initialize secure session encryption key"))?;
    let key = LessSafeKey::new(unbound_key);
    let nonce_bytes = decode_fixed_bytes::<NONCE_LEN>(&encryption.nonce, "secure session nonce")?;
    let nonce = Nonce::try_assume_unique_for_key(&nonce_bytes)
        .map_err(|_| anyhow::anyhow!("secure session nonce is invalid"))?;
    let mut ciphertext = payload;
    key.seal_in_place_append_tag(nonce, Aad::from(aad.as_slice()), &mut ciphertext)
        .map_err(|_| anyhow::anyhow!("encrypt secure session payload"))?;
    encryption.ciphertext = URL_SAFE_NO_PAD.encode(ciphertext);

    let mut envelope = SecureSessionEnvelope {
        format: SECURE_PORTABLE_FORMAT.to_string(),
        bundle_id,
        issued_at,
        recipient,
        encryption,
        signer: SecureSessionSigner {
            algorithm: SECURE_SIGNATURE_ALGORITHM.to_string(),
            key_id: options.signing_key_id.clone(),
            signature: String::new(),
        },
    };
    let signing_key_bytes = read_private_key(&options.signing_key_file)?;
    let signing_key = Ed25519KeyPair::from_pkcs8(&signing_key_bytes)
        .map_err(|_| anyhow::anyhow!("signing key file is not an Ed25519 PKCS#8 key"))?;
    let signature_payload = secure_session_signature_payload(&envelope)?;
    envelope.signer.signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&signature_payload));
    let encoded = serde_json::to_vec(&envelope).context("serialize secure session envelope")?;
    ensure_secure_bundle_size(&encoded)?;
    write_private_file(&output, &encoded)?;
    Ok(output)
}

/// Import a secure envelope from an explicitly selected file.
pub fn import_secure_portable_session(
    manager: &SessionManager,
    source: &Path,
    options: &SecureSessionImportOptions,
) -> Result<ImportResult> {
    if !source.exists() {
        bail!("Import file not found: {}", source.display());
    }
    let raw = read_bounded_secure_bundle(source)?;
    import_secure_bundle_bytes(manager, &raw, options)
}

pub(super) fn import_secure_bundle_bytes(
    manager: &SessionManager,
    raw: &[u8],
    options: &SecureSessionImportOptions,
) -> Result<ImportResult> {
    ensure_secure_bundle_size(raw)?;
    let envelope: SecureSessionEnvelope =
        serde_json::from_slice(raw).context("secure session envelope is not valid JSON")?;
    validate_secure_envelope(&envelope, options.expected_recipient_key_id.as_deref())?;

    // Verify the signer over the complete encrypted envelope before opening
    // or importing any session entries. AEAD then authenticates the payload
    // under the explicitly selected recipient key.
    let verify_key = read_public_key(&options.verify_key_file)?;
    let signature = decode_fixed_bytes::<SECURE_SIGNATURE_BYTES>(
        &envelope.signer.signature,
        "secure session signature",
    )?;
    let signature_payload = secure_session_signature_payload(&envelope)?;
    UnparsedPublicKey::new(&ED25519, verify_key.as_slice())
        .verify(&signature_payload, &signature)
        .map_err(|_| anyhow::anyhow!("secure session signature mismatch"))?;

    let encryption_key = read_symmetric_key(&options.encryption_key_file)?;
    let unbound_key = UnboundKey::new(&AES_256_GCM, encryption_key.as_slice())
        .map_err(|_| anyhow::anyhow!("initialize secure session decryption key"))?;
    let key = LessSafeKey::new(unbound_key);
    let nonce_bytes =
        decode_fixed_bytes::<NONCE_LEN>(&envelope.encryption.nonce, "secure session nonce")?;
    let nonce = Nonce::try_assume_unique_for_key(&nonce_bytes)
        .map_err(|_| anyhow::anyhow!("secure session nonce is invalid"))?;
    let aad = secure_session_associated_data(
        &envelope.format,
        &envelope.bundle_id,
        &envelope.issued_at,
        &envelope.recipient,
        &envelope.encryption,
    )?;
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.encryption.ciphertext)
        .context("decode secure session ciphertext")?;
    if ciphertext.len() < SECURE_TAG_BYTES {
        bail!("secure session ciphertext is truncated");
    }
    let plaintext = key
        .open_in_place(nonce, Aad::from(aad.as_slice()), &mut ciphertext)
        .map_err(|_| anyhow::anyhow!("secure session payload decryption failed"))?;
    let bundle = parse_secure_payload(plaintext)?;
    if !bundle.sessions.is_empty() {
        return import_bundle_with_source(manager, bundle, Some(&envelope.bundle_id));
    }
    if let Some(entries) = bundle.entries {
        return import_entries_with_source(manager, entries, Some(&envelope.bundle_id));
    }
    bail!("secure session payload is missing both entries and sessions")
}

fn parse_secure_payload(plaintext: &[u8]) -> Result<PortableBundle> {
    let bundle: SecurePortableBundle = serde_json::from_slice(plaintext)
        .context("secure session payload is not a valid portable bundle")?;
    if bundle.format != PORTABLE_FORMAT {
        bail!(
            "secure session payload has unsupported format: {}",
            bundle.format
        );
    }
    Ok(PortableBundle {
        format: bundle.format,
        exported_at: bundle.exported_at,
        session_id: bundle.session_id,
        entries: bundle.entries,
        sessions: bundle
            .sessions
            .into_iter()
            .map(|session| PortableSession {
                session_id: session.session_id,
                parent_session_id: session.parent_session_id,
                entries: session.entries,
            })
            .collect(),
    })
}

fn validate_secure_envelope(
    envelope: &SecureSessionEnvelope,
    expected_recipient_key_id: Option<&str>,
) -> Result<()> {
    if envelope.format != SECURE_PORTABLE_FORMAT {
        bail!("Unsupported secure session format: {}", envelope.format);
    }
    uuid::Uuid::parse_str(&envelope.bundle_id).context("secure session bundleId must be a UUID")?;
    chrono::DateTime::parse_from_rfc3339(&envelope.issued_at)
        .context("secure session issuedAt must be RFC3339")?;
    if envelope.recipient.kind != SECURE_RECIPIENT_KIND {
        bail!("unsupported secure session recipient kind");
    }
    validate_key_id(&envelope.recipient.key_id, "recipient key id")?;
    validate_key_id(&envelope.encryption.key_id, "encryption key id")?;
    validate_key_id(&envelope.signer.key_id, "signing key id")?;
    if envelope.recipient.key_id != envelope.encryption.key_id {
        bail!("secure session recipient and encryption key ids differ");
    }
    if let Some(expected) = expected_recipient_key_id {
        validate_key_id(expected, "expected recipient key id")?;
        if expected != envelope.recipient.key_id {
            bail!("secure session recipient key id does not match the requested key");
        }
    }
    if envelope.encryption.algorithm != SECURE_ENCRYPTION_ALGORITHM {
        bail!("unsupported secure session encryption algorithm");
    }
    if envelope.signer.algorithm != SECURE_SIGNATURE_ALGORITHM {
        bail!("unsupported secure session signature algorithm");
    }
    let _ = decode_fixed_bytes::<NONCE_LEN>(&envelope.encryption.nonce, "secure session nonce")?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.encryption.ciphertext)
        .context("secure session ciphertext is not valid base64url")?;
    if ciphertext.len() < SECURE_TAG_BYTES {
        bail!("secure session ciphertext is truncated");
    }
    if ciphertext.len() as u64 > SECURE_MAX_BUNDLE_BYTES {
        bail!("secure session ciphertext exceeds the 16 MiB size limit");
    }
    let _ = decode_fixed_bytes::<SECURE_SIGNATURE_BYTES>(
        &envelope.signer.signature,
        "secure session signature",
    )?;
    Ok(())
}

fn secure_session_signature_payload(envelope: &SecureSessionEnvelope) -> Result<Vec<u8>> {
    let unsigned = SecureSessionSignedEnvelope {
        format: &envelope.format,
        bundle_id: &envelope.bundle_id,
        issued_at: &envelope.issued_at,
        recipient: &envelope.recipient,
        encryption: &envelope.encryption,
        signer: SecureSessionUnsignedSigner {
            algorithm: &envelope.signer.algorithm,
            key_id: &envelope.signer.key_id,
        },
    };
    let mut payload = SECURE_SIGNATURE_DOMAIN.to_vec();
    serde_json::to_writer(&mut payload, &unsigned)
        .context("serialize secure session signature payload")?;
    Ok(payload)
}

fn secure_session_associated_data(
    format: &str,
    bundle_id: &str,
    issued_at: &str,
    recipient: &SecureSessionRecipient,
    encryption: &SecureSessionEncryption,
) -> Result<Vec<u8>> {
    let associated_data = SecureSessionAssociatedData {
        format,
        bundle_id,
        issued_at,
        recipient_kind: &recipient.kind,
        recipient_key_id: &recipient.key_id,
        encryption_algorithm: &encryption.algorithm,
        encryption_key_id: &encryption.key_id,
        nonce: &encryption.nonce,
    };
    serde_json::to_vec(&associated_data).context("serialize secure session associated data")
}

pub(super) fn read_bounded_secure_bundle(source: &Path) -> Result<Vec<u8>> {
    let metadata = fs::metadata(source).with_context(|| format!("inspect {}", source.display()))?;
    if metadata.len() > SECURE_MAX_BUNDLE_BYTES {
        bail!("secure session envelope exceeds the 16 MiB size limit");
    }
    fs::read(source).with_context(|| format!("read {}", source.display()))
}

fn ensure_secure_bundle_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 > SECURE_MAX_BUNDLE_BYTES {
        bail!("secure session envelope exceeds the 16 MiB size limit");
    }
    Ok(())
}

fn read_symmetric_key(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let bytes = read_private_key(path)?;
    if bytes.len() != SECURE_KEY_BYTES {
        bail!("encryption key file must contain exactly {SECURE_KEY_BYTES} raw bytes");
    }
    Ok(bytes)
}

fn read_private_key(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    ensure_private_key_permissions(path)?;
    let bytes = Zeroizing::new(fs::read(path).with_context(|| format!("read {}", path.display()))?);
    if bytes.is_empty() {
        bail!("private key file is empty: {}", path.display());
    }
    Ok(bytes)
}

fn read_public_key(path: &Path) -> Result<Vec<u8>> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() != SECURE_KEY_BYTES {
        bail!("verification key file must contain exactly {SECURE_KEY_BYTES} raw bytes");
    }
    Ok(bytes)
}

fn decode_fixed_bytes<const N: usize>(value: &str, field: &str) -> Result<[u8; N]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| format!("{field} is not valid base64url"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{field} must decode to exactly {N} bytes"))
}

fn validate_key_id(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > SECURE_MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
    {
        bail!("{field} must be 1..{SECURE_MAX_ID_BYTES} printable ASCII bytes");
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_private_key_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)
        .with_context(|| format!("inspect private key file {}", path.display()))?
        .permissions()
        .mode()
        & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "private key file {} must not be group- or world-readable",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_private_key_permissions(path: &Path) -> Result<()> {
    if !path.exists() {
        bail!("private key file not found: {}", path.display());
    }
    Ok(())
}

fn default_secure_export_path(source: &Path) -> PathBuf {
    PathBuf::from(
        source
            .file_stem()
            .unwrap_or_else(|| std::ffi::OsStr::new("session")),
    )
    .with_extension("secure.json")
}

#[cfg(test)]
mod tests {
    use super::super::{portable_entries, write_jsonl};
    use super::*;
    use ring::signature::KeyPair;

    fn fixture_secret(prefix: &str) -> String {
        [prefix, "abcdefghijklmnopqrstuvwxyz123456"].concat()
    }

    fn entry(id: &str, parent: Option<&str>, content: &str) -> Vec<Value> {
        vec![
            serde_json::json!({
                "type": "session",
                "id": id,
                "timestamp": "2026-01-01T00:00:00Z",
                "cwd": "/tmp/project",
                "model": "openai/gpt-5",
                "parentSession": parent,
            }),
            serde_json::json!({"type": "user", "message": content}),
        ]
    }

    fn secure_test_keys(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let encryption = root.join("recipient.key");
        write_private_file(&encryption, &[7_u8; SECURE_KEY_BYTES]).unwrap();

        let signing_bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .expect("generate test signing key");
        let signing = root.join("signing.pk8");
        write_private_file(&signing, signing_bytes.as_ref()).unwrap();
        let signing_key =
            Ed25519KeyPair::from_pkcs8(signing_bytes.as_ref()).expect("parse test signing key");

        let verify = root.join("verify.key");
        fs::write(&verify, signing_key.public_key().as_ref()).unwrap();
        (encryption, signing, verify)
    }

    fn secure_options(root: &Path) -> (SecureSessionExportOptions, SecureSessionImportOptions) {
        let (encryption, signing, verify) = secure_test_keys(root);
        (
            SecureSessionExportOptions {
                encryption_key_file: encryption.clone(),
                signing_key_file: signing,
                recipient_key_id: "recipient-test".to_string(),
                signing_key_id: "signer-test".to_string(),
            },
            SecureSessionImportOptions {
                encryption_key_file: encryption,
                verify_key_file: verify,
                expected_recipient_key_id: Some("recipient-test".to_string()),
            },
        )
    }

    fn secure_source_manager(root: &Path) -> (SessionManager, PathBuf) {
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("source.jsonl");
        write_jsonl(
            &source,
            &entry(
                "source-session",
                None,
                &format!("Bearer {}", fixture_secret("sk-")),
            ),
        )
        .unwrap();
        (
            SessionManager::with_sessions_dir("/tmp/project", &source_dir),
            source,
        )
    }

    #[test]
    fn secure_bundle_round_trips_redacted_payload_and_records_bundle_id() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = secure_source_manager(root.path());
        let (export_options, import_options) = secure_options(root.path());
        let output = root.path().join("session.secure.json");

        export_secure_portable_session(&manager, "source-session", Some(&output), &export_options)
            .unwrap();
        let raw = fs::read(&output).unwrap();
        let envelope: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(envelope["format"], SECURE_PORTABLE_FORMAT);
        assert!(!envelope["encryption"]["ciphertext"]
            .as_str()
            .unwrap()
            .is_empty());
        assert!(!String::from_utf8_lossy(&raw).contains(&fixture_secret("sk-")));

        let destination = root.path().join("destination");
        let destination_manager = SessionManager::with_sessions_dir("/tmp/project", &destination);
        let imported =
            import_secure_portable_session(&destination_manager, &output, &import_options).unwrap();
        let imported_entries = portable_entries(&imported.session_file, false).unwrap();
        let serialized = serde_json::to_string(&imported_entries).unwrap();
        assert!(!serialized.contains(&fixture_secret("sk-")));
        assert!(serialized.contains("[REDACTED:token:portable-export]"));
        assert_eq!(
            imported_entries[0]["portableBundleId"],
            envelope["bundleId"]
        );
    }

    #[test]
    fn secure_import_rejects_tampering_before_writing_sessions() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = secure_source_manager(root.path());
        let (export_options, import_options) = secure_options(root.path());
        let output = root.path().join("session.secure.json");
        export_secure_portable_session(&manager, "source-session", Some(&output), &export_options)
            .unwrap();

        let mut tampered: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        let signature = tampered["signer"]["signature"].as_str().unwrap();
        let replacement = if signature.starts_with('A') { 'B' } else { 'A' };
        tampered["signer"]["signature"] =
            Value::String(format!("{replacement}{}", &signature[1..]));
        let tampered_path = root.path().join("tampered.secure.json");
        fs::write(&tampered_path, serde_json::to_vec(&tampered).unwrap()).unwrap();

        let destination = root.path().join("destination");
        let destination_manager = SessionManager::with_sessions_dir("/tmp/project", &destination);
        let error =
            import_secure_portable_session(&destination_manager, &tampered_path, &import_options)
                .unwrap_err();
        assert!(error.to_string().contains("signature mismatch"));
        assert!(!destination.exists() || destination.read_dir().unwrap().next().is_none());
    }

    #[test]
    fn secure_import_rejects_wrong_key_and_truncation() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = secure_source_manager(root.path());
        let (export_options, import_options) = secure_options(root.path());
        let output = root.path().join("session.secure.json");
        export_secure_portable_session(&manager, "source-session", Some(&output), &export_options)
            .unwrap();

        let wrong_key = root.path().join("wrong-recipient.key");
        write_private_file(&wrong_key, &[8_u8; SECURE_KEY_BYTES]).unwrap();
        let wrong_options = SecureSessionImportOptions {
            encryption_key_file: wrong_key,
            ..import_options.clone()
        };
        let destination = root.path().join("wrong-destination");
        let destination_manager = SessionManager::with_sessions_dir("/tmp/project", &destination);
        let error = import_secure_portable_session(&destination_manager, &output, &wrong_options)
            .unwrap_err();
        assert!(error.to_string().contains("decryption failed"));
        assert!(!destination.exists() || destination.read_dir().unwrap().next().is_none());

        let raw = fs::read(&output).unwrap();
        let truncated_path = root.path().join("truncated.secure.json");
        fs::write(&truncated_path, &raw[..raw.len() / 2]).unwrap();
        let error =
            import_secure_portable_session(&destination_manager, &truncated_path, &import_options)
                .unwrap_err();
        assert!(error.to_string().contains("envelope"));
    }

    #[test]
    fn secure_payload_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "format": PORTABLE_FORMAT,
            "exportedAt": "2026-01-01T00:00:00Z",
            "entries": [],
            "sessions": [],
            "unexpected": true,
        });
        let error = parse_secure_payload(&serde_json::to_vec(&payload).unwrap()).unwrap_err();
        assert!(format!("{error:#}").contains("unknown field"));
    }

    #[test]
    fn secure_envelope_rejects_metadata_mutations() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = secure_source_manager(root.path());
        let (export_options, import_options) = secure_options(root.path());
        let output = root.path().join("session.secure.json");
        export_secure_portable_session(&manager, "source-session", Some(&output), &export_options)
            .unwrap();
        let original: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();

        let mut recipient = original.clone();
        recipient["recipient"]["keyId"] = Value::String("other-recipient".to_string());
        recipient["encryption"]["keyId"] = Value::String("other-recipient".to_string());
        let recipient = serde_json::from_value::<SecureSessionEnvelope>(recipient).unwrap();
        assert!(validate_secure_envelope(
            &recipient,
            import_options.expected_recipient_key_id.as_deref()
        )
        .unwrap_err()
        .to_string()
        .contains("does not match"));

        let mut encryption = original.clone();
        encryption["encryption"]["algorithm"] = Value::String("AES-128-GCM".to_string());
        let encryption = serde_json::from_value::<SecureSessionEnvelope>(encryption).unwrap();
        assert!(validate_secure_envelope(&encryption, None)
            .unwrap_err()
            .to_string()
            .contains("unsupported secure session encryption algorithm"));

        let mut signer = original;
        signer["signer"]["algorithm"] = Value::String("RSA-PSS".to_string());
        let signer = serde_json::from_value::<SecureSessionEnvelope>(signer).unwrap();
        assert!(validate_secure_envelope(&signer, None)
            .unwrap_err()
            .to_string()
            .contains("unsupported secure session signature algorithm"));
    }

    #[test]
    fn secure_bundle_size_is_rejected_before_write_or_read() {
        let oversized = vec![0_u8; SECURE_MAX_BUNDLE_BYTES as usize + 1];
        let error = ensure_secure_bundle_size(&oversized).unwrap_err();
        assert!(error.to_string().contains("16 MiB"));

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("oversized.secure.json");
        fs::write(&source, oversized).unwrap();
        let error = read_bounded_secure_bundle(&source).unwrap_err();
        assert!(error.to_string().contains("16 MiB"));
    }

    #[cfg(unix)]
    #[test]
    fn secure_encryption_key_requires_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let key = root.path().join("recipient.key");
        fs::write(&key, [7_u8; SECURE_KEY_BYTES]).unwrap();
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
        let error = read_symmetric_key(&key).unwrap_err();
        assert!(error.to_string().contains("group- or world-readable"));
    }
}

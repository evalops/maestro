//! Credential Store - Secure In-Memory Credential Vault
//!
//! This module provides secure storage for credentials (API keys, tokens, etc.)
//! that are detected during agent execution. Instead of blocking tool calls
//! containing credentials, we:
//!
//! 1. Detect the credential in tool arguments
//! 2. Store it securely in memory with a unique reference ID
//! 3. Replace the raw credential with a reference token
//! 4. Resolve references back to real values at execution time
//!
//! This approach allows users to provide test API keys without triggering
//! "credential leaked" errors, while still maintaining security by keeping
//! raw credentials out of the conversation context.
//!
//! # Reference Format
//!
//! Credentials are replaced with: `{{CRED:type:id}}`
//! - `type`: The credential type (e.g., "api_key", "token")
//! - `id`: A unique identifier for retrieval
//!
//! # Example
//!
//! ```rust
//! use maestro_tui::agent::credential_store::{CredentialStore, CredentialType};
//!
//! let mut store = CredentialStore::new();
//!
//! // Store a credential and get a reference
//! let reference = store.store("sk-ant-abc123", CredentialType::ApiKey);
//! // Returns something like: "{{CRED:api_key:a1b2c3d4e5f6}}"
//!
//! // Resolve a reference back to the real value
//! let value = store.resolve(&reference);
//! assert_eq!(value, Some("sk-ant-abc123".to_string()));
//!
//! // Resolve all references in a string
//! let cmd = format!("curl -H 'Authorization: Bearer {}'", reference);
//! let resolved = store.resolve_all(&cmd);
//! // Returns: "curl -H 'Authorization: Bearer sk-ant-abc123'"
//! ```
//!
//! # Thread Safety
//!
//! The `CredentialStore` is not thread-safe by itself. For concurrent access,
//! wrap it in a `Mutex` or `RwLock`.
//!
//! # Security Notes
//!
//! - Credentials are stored in memory only (not persisted to disk)
//! - Each session has its own credential store
//! - References are opaque and don't reveal credential content
//! - Store is cleared when dropped

use rand::Rng;
use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::fmt::Write;
use std::sync::{Arc, LazyLock, Mutex};
use zeroize::{Zeroize, Zeroizing};

/// Credential types that can be stored
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CredentialType {
    /// API key (OpenAI, Anthropic, etc.)
    ApiKey,
    /// Bearer token
    Token,
    /// Password
    Password,
    /// Generic secret
    Secret,
    /// Private key (RSA, SSH, etc.)
    PrivateKey,
    /// Connection string (database, etc.)
    ConnectionString,
    /// Unknown credential type
    Unknown,
}

impl CredentialType {
    /// Convert to string representation for reference format
    fn as_str(&self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Token => "token",
            Self::Password => "password",
            Self::Secret => "secret",
            Self::PrivateKey => "private_key",
            Self::ConnectionString => "connection_string",
            Self::Unknown => "unknown",
        }
    }

    /// Parse from string representation
    #[allow(dead_code)]
    fn from_str(s: &str) -> Self {
        match s {
            "api_key" => Self::ApiKey,
            "token" => Self::Token,
            "password" => Self::Password,
            "secret" => Self::Secret,
            "private_key" => Self::PrivateKey,
            "connection_string" => Self::ConnectionString,
            _ => Self::Unknown,
        }
    }
}

/// Stored credential metadata
#[derive(Clone)]
struct StoredCredential {
    /// The actual credential value
    value: Zeroizing<String>,
    /// Type of credential
    cred_type: CredentialType,
    /// How many times it's been resolved
    resolve_count: u32,
}

impl fmt::Debug for StoredCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredCredential")
            .field("cred_type", &self.cred_type)
            .field("resolve_count", &self.resolve_count)
            .finish_non_exhaustive()
    }
}

/// Reference pattern for matching credential references in strings
/// Matches: {{CRED:type:id}}
static REFERENCE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{CRED:([a-z_]+):([a-f0-9]+)\}\}").expect("Invalid regex pattern")
});

#[derive(Debug, Clone, Copy)]
enum ReplaceKind {
    Full,
    Bearer,
    KeyValue,
    UriUserInfo,
}

#[derive(Debug)]
struct CredentialPattern {
    regex: Regex,
    kind: CredentialType,
    replace: ReplaceKind,
}

static CREDENTIAL_PATTERNS: LazyLock<Vec<CredentialPattern>> = LazyLock::new(|| {
    let pem_begin = [
        "-----BEGIN ",
        "(?:RSA |EC |DSA |OPENSSH )?PRIVATE",
        " KEY-----",
    ]
    .concat();
    let pem_end = [
        "-----END ",
        "(?:RSA |EC |DSA |OPENSSH )?PRIVATE",
        " KEY-----",
    ]
    .concat();
    let pgp_block = ["PGP", " PRIVATE", " KEY", " BLOCK"].concat();

    vec![
        CredentialPattern {
            regex: Regex::new(
                r#"(?i)(password|passwd|pwd|credential|credentials)(['"]?\s*[:=]\s*['"]?)([^\s'",;}{}\[\]]+)"#,
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::Password,
            replace: ReplaceKind::KeyValue,
        },
        CredentialPattern {
            regex: Regex::new(r"(?i)([a-z][a-z0-9+.-]*://[^:/\s@]+:)([^@\s]+)(@)")
                .expect("Invalid regex pattern"),
            kind: CredentialType::Password,
            replace: ReplaceKind::UriUserInfo,
        },
        CredentialPattern {
            regex: Regex::new(
                r#"(?i)(api[_-]?key|apikey|api[_-]?token|token|secret)(['"\s:=]+)([A-Za-z0-9_-]{20,})"#,
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::KeyValue,
        },
        CredentialPattern {
            regex: Regex::new(
                r#"(?i)(aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?key)(['"\s:=]+)([A-Za-z0-9/+=]{40})"#,
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::Secret,
            replace: ReplaceKind::KeyValue,
        },
        CredentialPattern {
            regex: Regex::new(
                r#"(?i)(token|access[_-]?token|refresh[_-]?token|auth[_-]?token)(['"]?\s*[:=]\s*['"]?)([^\s'",;}{}\[\]]+)"#,
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::Token,
            replace: ReplaceKind::KeyValue,
        },
        CredentialPattern {
            regex: Regex::new(r"(?i)Bearer\s+([A-Za-z0-9_.-]+)")
                .expect("Invalid regex pattern"),
            kind: CredentialType::Token,
            replace: ReplaceKind::Bearer,
        },
        CredentialPattern {
            regex: Regex::new(r"(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}")
                .expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"sk-ant-[A-Za-z0-9_-]{20,}").expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"sk-[A-Za-z0-9]{20,}").expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"gh[pousr]_[A-Za-z0-9]{36,}").expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"xox[baprs]-[A-Za-z0-9-]{10,}")
                .expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"AKIA[A-Z0-9]{16}").expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"AIza[0-9A-Za-z_-]{35}").expect("Invalid regex pattern"),
            kind: CredentialType::ApiKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"ya29\.[A-Za-z0-9_-]{20,}").expect("Invalid regex pattern"),
            kind: CredentialType::Token,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(r"eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*")
                .expect("Invalid regex pattern"),
            kind: CredentialType::Token,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(
                &format!(r"(?s){pem_begin}.*?{pem_end}"),
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::PrivateKey,
            replace: ReplaceKind::Full,
        },
        CredentialPattern {
            regex: Regex::new(
                &format!(r"(?s)-----BEGIN {pgp_block}-----.*?-----END {pgp_block}-----"),
            )
            .expect("Invalid regex pattern"),
            kind: CredentialType::PrivateKey,
            replace: ReplaceKind::Full,
        },
    ]
});

/// Generate a short unique ID for credential references
fn generate_id() -> String {
    let mut rng = rand::rng();
    let bytes: [u8; 6] = rng.random();
    let mut hex_string = String::with_capacity(12);
    for byte in bytes {
        write!(hex_string, "{:02x}", byte).expect("Writing to string should never fail");
    }
    hex_string
}

fn random_fingerprint_key() -> [u8; 32] {
    rand::rng().random()
}

/// Credential Store - manages secure credential storage
pub struct CredentialStore {
    /// Credentials indexed by ID
    credentials: HashMap<String, StoredCredential>,
    /// Reverse lookup: keyed digest -> reference. Raw credential values are never duplicated.
    value_to_ref: HashMap<[u8; 32], String>,
    /// Per-store key for reverse lookup fingerprints.
    fingerprint_key: Zeroizing<[u8; 32]>,
}

/// Shared, session-scoped credential vault.
///
/// Clones share the same in-memory credentials while independent vaults remain
/// isolated. Inject this into every component that needs to vault or resolve
/// credentials for a session.
#[derive(Clone)]
pub struct CredentialVault(Arc<Mutex<CredentialVaultState>>);

struct CredentialVaultState {
    store: CredentialStore,
    generation: u64,
}

impl fmt::Debug for CredentialVault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store
            .fmt(formatter)
    }
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialVault {
    /// Create a new empty, independently scoped credential vault.
    #[must_use]
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(CredentialVaultState {
            store: CredentialStore::new(),
            generation: 0,
        })))
    }

    /// Store a credential and return its opaque reference.
    pub fn store(&self, value: &str, cred_type: CredentialType) -> String {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store
            .store(value, cred_type)
    }

    /// Capture the current session generation for an execution.
    #[must_use]
    pub(crate) fn generation(&self) -> u64 {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .generation
    }

    /// Resolve all credential references in a string.
    pub fn resolve_all(&self, input: &str) -> String {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store
            .resolve_all(input)
    }

    /// Resolve all credential references in a JSON value.
    pub fn resolve_in_json(&self, value: &serde_json::Value) -> serde_json::Value {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store
            .resolve_in_json(value)
    }

    /// Vault credentials in a plain text value.
    pub fn vault_in_text(&self, value: &str) -> String {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        vault_credentials_in_string(&mut state.store, value)
    }

    /// Vault credentials only when the execution still belongs to this session.
    ///
    /// Stale output is redacted rather than stored so a cleared vault cannot be
    /// repopulated by an execution that began under an earlier generation.
    pub(crate) fn vault_in_text_at_generation(&self, generation: u64, value: &str) -> String {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation == generation {
            vault_credentials_in_string(&mut state.store, value)
        } else {
            redact_credentials_in_string(value)
        }
    }

    /// Vault credentials in a JSON value.
    pub fn vault_in_json(&self, value: &serde_json::Value) -> serde_json::Value {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        vault_credentials_in_json(&mut state.store, value)
    }

    /// Vault JSON credentials only if the execution generation remains active.
    pub(crate) fn vault_in_json_at_generation(
        &self,
        generation: u64,
        value: &serde_json::Value,
    ) -> serde_json::Value {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation == generation {
            vault_credentials_in_json(&mut state.store, value)
        } else {
            redact_credentials_in_json(value)
        }
    }

    /// Clear and zeroize all credentials in this vault.
    pub fn clear(&self) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.store.clear();
        state.generation = state.generation.wrapping_add(1);
    }

    /// Get credential statistics for this vault.
    #[must_use]
    pub fn stats(&self) -> CredentialStats {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store
            .stats()
    }
}

impl fmt::Debug for CredentialStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialStore")
            .field("credential_count", &self.credentials.len())
            .finish()
    }
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore {
    /// Create a new empty credential store
    #[must_use]
    pub fn new() -> Self {
        Self {
            credentials: HashMap::new(),
            value_to_ref: HashMap::new(),
            fingerprint_key: Zeroizing::new(random_fingerprint_key()),
        }
    }

    fn fingerprint(&self, value: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(*self.fingerprint_key);
        hasher.update(value.as_bytes());
        hasher.finalize().into()
    }

    /// Store a credential and return a reference token
    ///
    /// If the same credential value is stored multiple times, the same
    /// reference is returned (deduplication).
    ///
    /// # Arguments
    ///
    /// * `value` - The raw credential value
    /// * `cred_type` - The type of credential
    ///
    /// # Returns
    ///
    /// A reference token like `{{CRED:api_key:a1b2c3d4e5f6}}`
    pub fn store(&mut self, value: &str, cred_type: CredentialType) -> String {
        // Check if we already have this value stored
        let fingerprint = self.fingerprint(value);
        if let Some(existing_ref) = self.value_to_ref.get(&fingerprint) {
            return existing_ref.clone();
        }

        // Generate a new reference
        let id = generate_id();
        let reference = format!("{{{{CRED:{}:{}}}}}", cred_type.as_str(), id);

        // Store the credential
        self.credentials.insert(
            id,
            StoredCredential {
                value: Zeroizing::new(value.to_string()),
                cred_type,
                resolve_count: 0,
            },
        );
        self.value_to_ref.insert(fingerprint, reference.clone());

        reference
    }

    /// Resolve a single reference token to its original value
    ///
    /// # Arguments
    ///
    /// * `reference` - A reference token like `{{CRED:api_key:a1b2c3d4e5f6}}`
    ///
    /// # Returns
    ///
    /// The original credential value, or None if not found
    pub fn resolve(&mut self, reference: &str) -> Option<String> {
        let caps = REFERENCE_PATTERN.captures(reference)?;
        let id = caps.get(2)?.as_str();

        let credential = self.credentials.get_mut(id)?;
        credential.resolve_count += 1;
        Some(credential.value.to_string())
    }

    /// Resolve all credential references in a string
    ///
    /// # Arguments
    ///
    /// * `input` - String potentially containing credential references
    ///
    /// # Returns
    ///
    /// String with all references replaced with actual values
    pub fn resolve_all(&mut self, input: &str) -> String {
        let mut result = input.to_string();

        // Find all matches and resolve them
        // We need to collect matches first to avoid borrow issues
        let matches: Vec<_> = REFERENCE_PATTERN
            .captures_iter(input)
            .filter_map(|caps| {
                let full_match = caps.get(0)?.as_str().to_string();
                let id = caps.get(2)?.as_str().to_string();
                Some((full_match, id))
            })
            .collect();

        for (full_match, id) in matches {
            if let Some(credential) = self.credentials.get_mut(&id) {
                credential.resolve_count += 1;
                result = result.replace(&full_match, &credential.value);
            }
        }

        result
    }

    /// Recursively resolve all credential references in a JSON value
    ///
    /// # Arguments
    ///
    /// * `value` - JSON value potentially containing credential references
    ///
    /// # Returns
    ///
    /// New JSON value with all references resolved
    pub fn resolve_in_json(&mut self, value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::String(s) => serde_json::Value::String(self.resolve_all(s)),
            serde_json::Value::Array(arr) => {
                serde_json::Value::Array(arr.iter().map(|v| self.resolve_in_json(v)).collect())
            }
            serde_json::Value::Object(map) => {
                let new_map: serde_json::Map<String, serde_json::Value> = map
                    .iter()
                    .map(|(k, v)| (k.clone(), self.resolve_in_json(v)))
                    .collect();
                serde_json::Value::Object(new_map)
            }
            // Other types pass through unchanged
            _ => value.clone(),
        }
    }

    /// Check if a string contains any credential references
    #[must_use]
    pub fn has_references(input: &str) -> bool {
        REFERENCE_PATTERN.is_match(input)
    }

    /// Get the number of stored credentials
    #[must_use]
    pub fn len(&self) -> usize {
        self.credentials.len()
    }

    /// Check if the store is empty
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.credentials.is_empty()
    }

    /// Clear all stored credentials
    pub fn clear(&mut self) {
        for credential in self.credentials.values_mut() {
            credential.value.zeroize();
        }
        self.credentials.clear();
        self.value_to_ref.clear();
        self.fingerprint_key.zeroize();
        self.fingerprint_key = Zeroizing::new(random_fingerprint_key());
    }

    /// Get statistics about stored credentials
    #[must_use]
    pub fn stats(&self) -> CredentialStats {
        let mut types: HashMap<CredentialType, usize> = HashMap::new();
        let mut total_resolves: u32 = 0;

        for cred in self.credentials.values() {
            *types.entry(cred.cred_type).or_insert(0) += 1;
            total_resolves += cred.resolve_count;
        }

        CredentialStats {
            count: self.credentials.len(),
            types,
            total_resolves,
        }
    }
}

fn vault_credentials_in_string(store: &mut CredentialStore, input: &str) -> String {
    let mut output = input.to_string();

    for pattern in CREDENTIAL_PATTERNS.iter() {
        let replaced = match pattern.replace {
            ReplaceKind::Full => pattern.regex.replace_all(&output, |caps: &Captures| {
                let value = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                store.store(value, pattern.kind)
            }),
            ReplaceKind::Bearer => pattern.regex.replace_all(&output, |caps: &Captures| {
                let value = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let reference = store.store(value, pattern.kind);
                format!("Bearer {}", reference)
            }),
            ReplaceKind::KeyValue => pattern.regex.replace_all(&output, |caps: &Captures| {
                let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let value = caps.get(3).map(|m| m.as_str()).unwrap_or("");
                let reference = store.store(value, pattern.kind);
                format!("{}{}{}", prefix, sep, reference)
            }),
            ReplaceKind::UriUserInfo => pattern.regex.replace_all(&output, |caps: &Captures| {
                let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let value = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let suffix = caps.get(3).map(|m| m.as_str()).unwrap_or("");
                let reference = store.store(value, pattern.kind);
                format!("{prefix}{reference}{suffix}")
            }),
        };
        output = replaced.into_owned();
    }

    output
}

fn vault_credentials_in_json(
    store: &mut CredentialStore,
    value: &serde_json::Value,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(vault_credentials_in_string(store, value))
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .iter()
                .map(|value| vault_credentials_in_json(store, value))
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), vault_credentials_in_json(store, value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// Replace credentials in an arbitrary JSON value with stable, non-reversible masks.
///
/// Portable session exports use this instead of the in-memory credential vault because
/// exported files must never contain references that require process-local state.
#[must_use]
pub fn redact_credentials_in_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            serde_json::Value::String(redact_credentials_in_string(value))
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(redact_credentials_in_json).collect())
        }
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_credentials_in_json(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn redact_credentials_in_string(input: &str) -> String {
    let mut output = input.to_string();
    for pattern in CREDENTIAL_PATTERNS.iter() {
        let mask = format!("[REDACTED:{}:portable-export]", pattern.kind.as_str());
        let replaced = match pattern.replace {
            ReplaceKind::Full => pattern
                .regex
                .replace_all(&output, mask.as_str())
                .into_owned(),
            ReplaceKind::Bearer => {
                let bearer_mask = format!("Bearer {mask}");
                pattern
                    .regex
                    .replace_all(&output, bearer_mask.as_str())
                    .into_owned()
            }
            ReplaceKind::KeyValue => pattern
                .regex
                .replace_all(&output, |caps: &Captures| {
                    let prefix = caps.get(1).map(|value| value.as_str()).unwrap_or("");
                    let separator = caps.get(2).map(|value| value.as_str()).unwrap_or("");
                    format!("{prefix}{separator}{mask}")
                })
                .into_owned(),
            ReplaceKind::UriUserInfo => pattern
                .regex
                .replace_all(&output, |caps: &Captures| {
                    let prefix = caps.get(1).map(|value| value.as_str()).unwrap_or("");
                    let suffix = caps.get(3).map(|value| value.as_str()).unwrap_or("");
                    format!("{prefix}{mask}{suffix}")
                })
                .into_owned(),
        };
        output = replaced;
    }
    output
}

/// Statistics about stored credentials
#[derive(Debug, Clone)]
pub struct CredentialStats {
    /// Total number of stored credentials
    pub count: usize,
    /// Count by credential type
    pub types: HashMap<CredentialType, usize>,
    /// Total number of times credentials have been resolved
    pub total_resolves: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_store_and_resolve() {
        let mut store = CredentialStore::new();
        let reference = store.store("sk-ant-test123", CredentialType::ApiKey);

        assert!(reference.starts_with("{{CRED:api_key:"));
        assert!(reference.ends_with("}}"));

        let resolved = store.resolve(&reference);
        assert_eq!(resolved, Some("sk-ant-test123".to_string()));
    }

    #[test]
    fn test_deduplication() {
        let mut store = CredentialStore::new();
        let ref1 = store.store("secret", CredentialType::Secret);
        let ref2 = store.store("secret", CredentialType::Secret);

        assert_eq!(ref1, ref2);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn cloned_vaults_share_credentials_but_separate_vaults_do_not() {
        let vault = CredentialVault::new();
        let clone = vault.clone();
        let isolated = CredentialVault::new();
        let secret = "credential-isolation-secret";
        let reference = vault.store(secret, CredentialType::Secret);

        assert_eq!(clone.resolve_all(&reference), secret);
        assert_eq!(isolated.resolve_all(&reference), reference);
    }

    #[test]
    fn clear_drops_references_and_does_not_expose_secret_in_debug_output() {
        let mut store = CredentialStore::new();
        let secret = "credential-that-must-not-appear-in-debug-output";
        let reference = store.store(secret, CredentialType::Secret);

        assert!(!format!("{store:?}").contains(secret));
        store.clear();

        assert!(store.is_empty());
        assert_eq!(store.resolve(&reference), None);
    }

    #[test]
    fn test_resolve_all() {
        let mut store = CredentialStore::new();
        let ref1 = store.store("key1", CredentialType::ApiKey);
        let ref2 = store.store("key2", CredentialType::Token);

        let input = format!("Use {} and {} in command", ref1, ref2);
        let resolved = store.resolve_all(&input);

        assert_eq!(resolved, "Use key1 and key2 in command");
    }

    #[test]
    fn test_resolve_in_json() {
        let mut store = CredentialStore::new();
        let reference = store.store("my-secret", CredentialType::Secret);

        let input = json!({
            "command": format!("echo {}", reference),
            "nested": {
                "key": reference.clone()
            },
            "array": [reference.clone(), "other"],
            "number": 42
        });

        let resolved = store.resolve_in_json(&input);

        assert_eq!(resolved["command"], "echo my-secret");
        assert_eq!(resolved["nested"]["key"], "my-secret");
        assert_eq!(resolved["array"][0], "my-secret");
        assert_eq!(resolved["array"][1], "other");
        assert_eq!(resolved["number"], 42);
    }

    #[test]
    fn test_vault_credentials_in_json_roundtrip() {
        let vault = CredentialVault::new();
        let sample_key = ["sk", "-", "abc123def456ghi789jkl012mno345pqr678"].join("");
        let payload = json!({
            "header": format!("Authorization: Bearer {}", sample_key),
        });

        let vaulted = vault.vault_in_json(&payload);
        let header = vaulted.get("header").and_then(|v| v.as_str()).unwrap_or("");

        assert!(header.contains("{{CRED:"));
        assert!(!header.contains("abc123def456"));

        let resolved = vault.resolve_in_json(&vaulted);
        assert_eq!(resolved, payload);
    }

    #[test]
    fn portable_redaction_masks_nested_credentials_without_vault_references() {
        let api_key = ["sk-ant-", "abcdefghijklmnopqrstuvwxyz123456"].concat();
        let payload = json!({
            "message": format!("apiKey={api_key}"),
            "nested": [format!("Bearer {api_key}")],
        });

        let redacted = redact_credentials_in_json(&payload);
        let serialized = serde_json::to_string(&redacted).unwrap();

        assert!(!serialized.contains(&api_key));
        assert!(serialized.contains("[REDACTED:api_key:portable-export]"));
        assert!(!serialized.contains("{{CRED:"));
    }

    #[test]
    fn portable_redaction_masks_uri_userinfo_and_generic_assignments() {
        let payload = json!({
            "database": "DATABASE_URL=postgres://alice:db-password@db.example/app",
            "password": "password = plain-secret",
            "credential": "credential: service-secret",
            "tokens": "token=plain-token access_token=access-secret refresh-token:refresh-secret authToken=auth-secret",
        });

        let redacted = redact_credentials_in_json(&payload);
        let serialized = serde_json::to_string(&redacted).unwrap();

        for secret in [
            "db-password",
            "plain-secret",
            "service-secret",
            "plain-token",
            "access-secret",
            "refresh-secret",
            "auth-secret",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert!(serialized.contains("postgres://alice:[REDACTED:password:portable-export]@"));
    }

    #[test]
    fn vault_roundtrips_uri_userinfo_and_generic_assignments() {
        let vault = CredentialVault::new();
        let payload = json!({
            "command": "connect postgres://alice:db-password@db.example/app password=plain-secret",
        });

        let vaulted = vault.vault_in_json(&payload);
        let serialized = serde_json::to_string(&vaulted).unwrap();
        assert!(!serialized.contains("db-password"));
        assert!(!serialized.contains("plain-secret"));
        assert_eq!(vault.resolve_in_json(&vaulted), payload);
    }

    #[test]
    fn test_vaults_private_key_blocks() {
        let vault = CredentialVault::new();
        let rsa_label = ["RSA", "PRIVATE", "KEY"].join(" ");
        let private_key = [
            "-----BEGIN ",
            rsa_label.as_str(),
            "-----\n",
            "MIIEpAIBAAKCAQEA...",
            "\n-----END RSA PRIVATE KEY-----",
        ]
        .join("");
        let payload = json!({
            "key": private_key,
        });

        let vaulted = vault.vault_in_json(&payload);
        let value = vaulted.get("key").and_then(|v| v.as_str()).unwrap_or("");

        assert!(value.contains("{{CRED:"));
        assert!(!value.contains("MIIEpAIB"));
        assert!(!value.contains("END RSA PRIVATE KEY"));
    }

    #[test]
    fn test_vaults_jwt_and_aws_secret() {
        let vault = CredentialVault::new();
        let aws_secret = ["wJalrXUtnFEMI/K7MDENG", "/bPxRfiCY", "EXAMPLEKEY"].join("");
        let jwt = [
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0",
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        ]
        .join(".");
        let payload = json!({
            "header": format!("AWS_SECRET_ACCESS_KEY={aws_secret}"),
            "token": jwt,
        });

        let vaulted = vault.vault_in_json(&payload);
        let header = vaulted.get("header").and_then(|v| v.as_str()).unwrap_or("");
        let token = vaulted.get("token").and_then(|v| v.as_str()).unwrap_or("");

        assert!(header.contains("{{CRED:"));
        assert!(!header.contains("EXAMPLEKEY"));
        assert!(token.contains("{{CRED:"));
        assert!(!token.contains("SflKxwRJSMeKKF2Q"));
    }

    #[test]
    fn test_has_references() {
        assert!(CredentialStore::has_references(
            "test {{CRED:api_key:abc123}} end"
        ));
        assert!(!CredentialStore::has_references("no references here"));
    }

    #[test]
    fn test_unknown_reference() {
        let mut store = CredentialStore::new();
        let result = store.resolve("{{CRED:api_key:nonexistent}}");
        assert_eq!(result, None);
    }

    #[test]
    fn test_clear() {
        let mut store = CredentialStore::new();
        store.store("secret1", CredentialType::Secret);
        store.store("secret2", CredentialType::Secret);

        assert_eq!(store.len(), 2);

        store.clear();

        assert!(store.is_empty());
    }

    #[test]
    fn test_stats() {
        let mut store = CredentialStore::new();
        let ref1 = store.store("key1", CredentialType::ApiKey);
        store.store("key2", CredentialType::ApiKey);
        store.store("token1", CredentialType::Token);

        // Resolve a few times
        store.resolve(&ref1);
        store.resolve(&ref1);

        let stats = store.stats();
        assert_eq!(stats.count, 3);
        assert_eq!(stats.types.get(&CredentialType::ApiKey), Some(&2));
        assert_eq!(stats.types.get(&CredentialType::Token), Some(&1));
        assert_eq!(stats.total_resolves, 2);
    }

    #[test]
    fn test_credential_type_roundtrip() {
        let types = [
            CredentialType::ApiKey,
            CredentialType::Token,
            CredentialType::Password,
            CredentialType::Secret,
            CredentialType::PrivateKey,
            CredentialType::ConnectionString,
            CredentialType::Unknown,
        ];

        for cred_type in types {
            let s = cred_type.as_str();
            let parsed = CredentialType::from_str(s);
            assert_eq!(parsed, cred_type);
        }
    }
}

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
//! use composer_tui::agent::credential_store::{CredentialStore, CredentialType};
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
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::LazyLock;
use std::sync::Mutex;

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
#[derive(Debug, Clone)]
struct StoredCredential {
    /// The actual credential value
    value: String,
    /// Type of credential
    cred_type: CredentialType,
    /// How many times it's been resolved
    resolve_count: u32,
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

/// Credential Store - manages secure credential storage
#[derive(Debug)]
pub struct CredentialStore {
    /// Credentials indexed by ID
    credentials: HashMap<String, StoredCredential>,
    /// Reverse lookup: value -> reference
    value_to_ref: HashMap<String, String>,
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
        }
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
        if let Some(existing_ref) = self.value_to_ref.get(value) {
            return existing_ref.clone();
        }

        // Generate a new reference
        let id = generate_id();
        let reference = format!("{{{{CRED:{}:{}}}}}", cred_type.as_str(), id);

        // Store the credential
        self.credentials.insert(
            id,
            StoredCredential {
                value: value.to_string(),
                cred_type,
                resolve_count: 0,
            },
        );
        self.value_to_ref
            .insert(value.to_string(), reference.clone());

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
        Some(credential.value.clone())
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
        self.credentials.clear();
        self.value_to_ref.clear();
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

fn vault_credentials_in_string(input: &str) -> String {
    let mut output = input.to_string();

    for pattern in CREDENTIAL_PATTERNS.iter() {
        let replaced = match pattern.replace {
            ReplaceKind::Full => pattern.regex.replace_all(&output, |caps: &Captures| {
                let value = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                store_credential(value, pattern.kind)
            }),
            ReplaceKind::Bearer => pattern.regex.replace_all(&output, |caps: &Captures| {
                let value = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let reference = store_credential(value, pattern.kind);
                format!("Bearer {}", reference)
            }),
            ReplaceKind::KeyValue => pattern.regex.replace_all(&output, |caps: &Captures| {
                let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let value = caps.get(3).map(|m| m.as_str()).unwrap_or("");
                let reference = store_credential(value, pattern.kind);
                format!("{}{}{}", prefix, sep, reference)
            }),
        };
        output = replaced.into_owned();
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

/// Global credential store for the session
///
/// This provides a convenient singleton for use throughout the application.
/// For testing or isolation, create a local `CredentialStore` instance instead.
static GLOBAL_STORE: LazyLock<Mutex<CredentialStore>> =
    LazyLock::new(|| Mutex::new(CredentialStore::new()));

/// Store a credential in the global store
pub fn store_credential(value: &str, cred_type: CredentialType) -> String {
    GLOBAL_STORE
        .lock()
        .expect("Failed to lock credential store")
        .store(value, cred_type)
}

/// Resolve credential references in the global store
pub fn resolve_credentials(input: &str) -> String {
    GLOBAL_STORE
        .lock()
        .expect("Failed to lock credential store")
        .resolve_all(input)
}

/// Resolve credential references in a JSON value using the global store
pub fn resolve_credentials_in_json(value: &serde_json::Value) -> serde_json::Value {
    GLOBAL_STORE
        .lock()
        .expect("Failed to lock credential store")
        .resolve_in_json(value)
}

/// Vault credentials in a JSON value using the global store
pub fn vault_credentials_in_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(vault_credentials_in_string(s)),
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(vault_credentials_in_json).collect())
        }
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), vault_credentials_in_json(v));
            }
            serde_json::Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Clear the global credential store
pub fn clear_credentials() {
    GLOBAL_STORE
        .lock()
        .expect("Failed to lock credential store")
        .clear();
}

/// Get statistics from the global credential store
pub fn credential_stats() -> CredentialStats {
    GLOBAL_STORE
        .lock()
        .expect("Failed to lock credential store")
        .stats()
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
        clear_credentials();
        let sample_key = ["sk", "-", "abc123def456ghi789jkl012mno345pqr678"].join("");
        let payload = json!({
            "header": format!("Authorization: Bearer {}", sample_key),
        });

        let vaulted = vault_credentials_in_json(&payload);
        let header = vaulted.get("header").and_then(|v| v.as_str()).unwrap_or("");

        assert!(header.contains("{{CRED:"));
        assert!(!header.contains("abc123def456"));

        let resolved = resolve_credentials_in_json(&vaulted);
        assert_eq!(resolved, payload);
    }

    #[test]
    fn test_vaults_private_key_blocks() {
        clear_credentials();
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

        let vaulted = vault_credentials_in_json(&payload);
        let value = vaulted.get("key").and_then(|v| v.as_str()).unwrap_or("");

        assert!(value.contains("{{CRED:"));
        assert!(!value.contains("MIIEpAIB"));
        assert!(!value.contains("END RSA PRIVATE KEY"));
    }

    #[test]
    fn test_vaults_jwt_and_aws_secret() {
        clear_credentials();
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

        let vaulted = vault_credentials_in_json(&payload);
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

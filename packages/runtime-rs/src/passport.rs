//! Artifact-bound identity for a native Maestro runtime release.
//!
//! A passport is a signed-release predicate, not a runtime authorization
//! decision.  The release workflow signs the serialized object with the
//! artifact's exact native or OCI digest; Platform can then verify the
//! signature and compare the contract digests before admitting a runtime.

use serde::{Deserialize, Serialize};

/// Version of the serialized runtime passport contract.
pub const RUNTIME_PASSPORT_VERSION: &str = "evalops.maestro.runtime-passport.v1";
/// Cosign predicate type used when a passport is attached to an artifact.
pub const RUNTIME_PASSPORT_PREDICATE_TYPE: &str =
    "https://evalops.dev/attestations/maestro-runtime-passport/v1";
/// Version of the black-box runtime conformance suite.
pub const RUNTIME_CONFORMANCE_VERSION: &str = "evalops.maestro.runtime-conformance.v1";
/// Behavior profile actually exercised by the standalone HTTP/SSE suite.
pub const RUNTIME_CONFORMANCE_PROFILE: &str = "hosted-http-sse-v1";

/// Artifact class named by a runtime passport.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeArtifactKind {
    /// A platform-specific native `maestro` executable.
    NativeBinary,
    /// The immutable OCI image served by the hosted runtime.
    OciImage,
}

/// Exact artifact identity covered by a passport signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeArtifactIdentityInput {
    /// Native or OCI artifact class.
    pub kind: RuntimeArtifactKind,
    /// Registry/name or release artifact name.
    pub name: String,
    /// `sha256:<64 lowercase hex characters>` digest of the artifact bytes or
    /// OCI manifest.
    pub digest: String,
}

/// Exact artifact identity in the serialized passport.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeArtifactIdentity {
    /// Native or OCI artifact class.
    pub kind: RuntimeArtifactKind,
    /// Registry/name or release artifact name.
    pub name: String,
    /// Digest covered by the outer signature.
    pub digest: String,
}

/// Conformance source identity bound into a passport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConformanceIdentityInput {
    /// Version of the executable conformance suite.
    pub suite_version: String,
    /// Digest of the canonical conformance case fixture.
    pub fixture_digest: String,
    /// Digest of the executable driver, canonical fixture, and native fixture source.
    pub suite_digest: String,
}

/// Conformance source identity in the serialized passport.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeConformanceIdentity {
    /// Version of the executable conformance suite.
    pub suite_version: String,
    /// Digest of the canonical conformance case fixture.
    pub fixture_digest: String,
    /// Digest of the executable driver, canonical fixture, and native fixture source.
    pub suite_digest: String,
}

/// Toolchain identity used to build the artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeToolchainIdentityInput {
    /// Rust compiler identity reported by the build runner.
    pub rustc: String,
    /// Target triple used for the artifact.
    pub target: String,
}

/// Toolchain identity in the serialized passport.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeToolchainIdentity {
    /// Rust compiler identity reported by the build runner.
    pub rustc: String,
    /// Target triple used for the artifact.
    pub target: String,
}

/// Typed input used to derive an artifact-bound runtime passport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePassportInput {
    /// Exact artifact covered by the passport.
    pub artifact: RuntimeArtifactIdentityInput,
    /// Forty-hex source revision used to build the artifact.
    pub source_sha: String,
    /// Producer-owned protocol compatibility digest.
    pub compatibility_digest: String,
    /// Versioned hosted launch contract accepted by the artifact.
    pub launch_spec_version: String,
    /// Versioned generation-bound receipt contract emitted by the artifact.
    pub receipt_version: String,
    /// Exact executable conformance identity.
    pub conformance: RuntimeConformanceIdentityInput,
    /// Behavior profiles exercised by the conformance suite.
    pub behavior_profiles: Vec<String>,
    /// Build toolchain identity.
    pub toolchain: RuntimeToolchainIdentityInput,
}

/// Signed-release passport for one exact native or OCI runtime artifact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimePassport {
    /// Versioned passport schema identity.
    pub schema_version: String,
    /// Predicate type expected by the release signer.
    pub predicate_type: String,
    /// Exact artifact covered by the outer signature.
    pub artifact: RuntimeArtifactIdentity,
    /// Source revision used to build the artifact.
    pub source_sha: String,
    /// Producer-owned protocol compatibility digest.
    pub compatibility_digest: String,
    /// Versioned hosted launch contract accepted by the artifact.
    pub launch_spec_version: String,
    /// Versioned generation-bound receipt contract emitted by the artifact.
    pub receipt_version: String,
    /// Exact executable conformance identity.
    pub conformance: RuntimeConformanceIdentity,
    /// Behavior profiles exercised by the conformance suite.
    pub behavior_profiles: Vec<String>,
    /// Build toolchain identity.
    pub toolchain: RuntimeToolchainIdentity,
}

impl RuntimePassport {
    /// Derive and validate a passport from release metadata.
    pub fn derive(input: RuntimePassportInput) -> Result<Self, RuntimePassportError> {
        let passport = Self {
            schema_version: RUNTIME_PASSPORT_VERSION.to_string(),
            predicate_type: RUNTIME_PASSPORT_PREDICATE_TYPE.to_string(),
            artifact: RuntimeArtifactIdentity {
                kind: input.artifact.kind,
                name: input.artifact.name,
                digest: input.artifact.digest,
            },
            source_sha: input.source_sha,
            compatibility_digest: input.compatibility_digest,
            launch_spec_version: input.launch_spec_version,
            receipt_version: input.receipt_version,
            conformance: RuntimeConformanceIdentity {
                suite_version: input.conformance.suite_version,
                fixture_digest: input.conformance.fixture_digest,
                suite_digest: input.conformance.suite_digest,
            },
            behavior_profiles: input.behavior_profiles,
            toolchain: RuntimeToolchainIdentity {
                rustc: input.toolchain.rustc,
                target: input.toolchain.target,
            },
        };
        passport.validate()?;
        Ok(passport)
    }

    /// Parse and validate a serialized passport at a compatibility edge.
    pub fn from_json_str(value: &str) -> Result<Self, RuntimePassportError> {
        let passport = serde_json::from_str::<Self>(value)
            .map_err(|error| RuntimePassportError::InvalidJson(error.to_string()))?;
        passport.validate()?;
        Ok(passport)
    }

    /// Validate schema identity, exact digests, and non-empty contract fields.
    pub fn validate(&self) -> Result<(), RuntimePassportError> {
        if self.schema_version != RUNTIME_PASSPORT_VERSION {
            return Err(RuntimePassportError::UnsupportedSchemaVersion);
        }
        if self.predicate_type != RUNTIME_PASSPORT_PREDICATE_TYPE {
            return Err(RuntimePassportError::InvalidPredicateType);
        }
        validate_source_sha(&self.source_sha)?;
        validate_digest(&self.artifact.digest, "artifact.digest")?;
        validate_digest(&self.compatibility_digest, "compatibility_digest")?;
        validate_digest(
            &self.conformance.fixture_digest,
            "conformance.fixture_digest",
        )?;
        validate_digest(&self.conformance.suite_digest, "conformance.suite_digest")?;
        for (value, field) in [
            (&self.artifact.name, "artifact.name"),
            (&self.launch_spec_version, "launch_spec_version"),
            (&self.receipt_version, "receipt_version"),
            (&self.conformance.suite_version, "conformance.suite_version"),
            (&self.toolchain.rustc, "toolchain.rustc"),
            (&self.toolchain.target, "toolchain.target"),
        ] {
            required(value, field)?;
        }
        if self.behavior_profiles.is_empty() {
            return Err(RuntimePassportError::EmptyField("behavior_profiles"));
        }
        if self
            .behavior_profiles
            .iter()
            .any(|profile| profile != RUNTIME_CONFORMANCE_PROFILE)
        {
            return Err(RuntimePassportError::UnsupportedBehaviorProfile);
        }
        let mut profiles = self.behavior_profiles.clone();
        profiles.sort_unstable();
        profiles.dedup();
        if profiles.len() != self.behavior_profiles.len() {
            return Err(RuntimePassportError::DuplicateBehaviorProfile);
        }
        Ok(())
    }
}

/// Return the live field and validation projection used by the canonical
/// passport contract fixture.
#[must_use]
pub fn runtime_passport_contract() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": RUNTIME_PASSPORT_VERSION,
        "predicateType": RUNTIME_PASSPORT_PREDICATE_TYPE,
        "fields": [
            "schemaVersion",
            "predicateType",
            "artifact",
            "sourceSha",
            "compatibilityDigest",
            "launchSpecVersion",
            "receiptVersion",
            "conformance",
            "behaviorProfiles",
            "toolchain"
        ],
        "artifactKinds": ["native_binary", "oci_image"],
        "behaviorProfiles": [RUNTIME_CONFORMANCE_PROFILE],
        "rejectsUnknownFields": true,
        "signature": "cosign-keyless-oidc"
    })
}

/// Return the executable case inventory bound into the conformance suite.
#[must_use]
pub fn runtime_conformance_contract() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": RUNTIME_CONFORMANCE_VERSION,
        "profile": RUNTIME_CONFORMANCE_PROFILE,
        "cases": [
            "startup_identity_and_readiness",
            "wrong_session_rejected",
            "file_search_and_read",
            "harmless_shell_command",
            "approval_request_and_resolution",
            "idempotent_response_replay",
            "drain_terminal_receipt"
        ]
    })
}

/// Validation failures for an artifact passport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimePassportError {
    /// A required passport field was empty.
    EmptyField(&'static str),
    /// A digest did not use the exact `sha256:<hex>` form.
    InvalidDigest(&'static str),
    /// The source revision was not a forty-hex SHA.
    InvalidSourceSha,
    /// The serialized schema version is unsupported.
    UnsupportedSchemaVersion,
    /// The signed predicate type is not the runtime passport predicate.
    InvalidPredicateType,
    /// Behavior profiles must be unique.
    DuplicateBehaviorProfile,
    /// A passport advertised a profile outside the producer-owned contract.
    UnsupportedBehaviorProfile,
    /// The serialized passport was not valid JSON for this contract.
    InvalidJson(String),
}

impl std::fmt::Display for RuntimePassportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField(field) => write!(formatter, "{field} must not be empty"),
            Self::InvalidDigest(field) => write!(formatter, "{field} must be a sha256 digest"),
            Self::InvalidSourceSha => formatter.write_str("source_sha must be a forty-hex SHA"),
            Self::UnsupportedSchemaVersion => {
                formatter.write_str("unsupported runtime passport schema version")
            }
            Self::InvalidPredicateType => {
                formatter.write_str("invalid runtime passport predicate type")
            }
            Self::DuplicateBehaviorProfile => {
                formatter.write_str("behavior_profiles must not contain duplicates")
            }
            Self::UnsupportedBehaviorProfile => {
                formatter.write_str("behavior_profiles contains an unexercised profile")
            }
            Self::InvalidJson(error) => write!(formatter, "invalid runtime passport JSON: {error}"),
        }
    }
}

impl std::error::Error for RuntimePassportError {}

fn required(value: &str, field: &'static str) -> Result<(), RuntimePassportError> {
    if value.trim().is_empty() {
        Err(RuntimePassportError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn validate_source_sha(value: &str) -> Result<(), RuntimePassportError> {
    if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(RuntimePassportError::InvalidSourceSha)
    }
}

fn validate_digest(value: &str, field: &'static str) -> Result<(), RuntimePassportError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(RuntimePassportError::InvalidDigest(field));
    };
    if hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(RuntimePassportError::InvalidDigest(field))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT_FIXTURE: &str = include_str!("../fixtures/runtime-passport-contract-v1.json");

    fn input() -> RuntimePassportInput {
        RuntimePassportInput {
            artifact: RuntimeArtifactIdentityInput {
                kind: RuntimeArtifactKind::NativeBinary,
                name: "maestro-linux-x64".to_string(),
                digest: format!("sha256:{}", "a".repeat(64)),
            },
            source_sha: "b".repeat(40),
            compatibility_digest: format!("sha256:{}", "c".repeat(64)),
            launch_spec_version: "evalops.maestro.hosted-launch-spec.v1".to_string(),
            receipt_version: "evalops.maestro.runtime-receipt.v1".to_string(),
            conformance: RuntimeConformanceIdentityInput {
                suite_version: RUNTIME_CONFORMANCE_VERSION.to_string(),
                fixture_digest: format!("sha256:{}", "d".repeat(64)),
                suite_digest: format!("sha256:{}", "e".repeat(64)),
            },
            behavior_profiles: vec![RUNTIME_CONFORMANCE_PROFILE.to_string()],
            toolchain: RuntimeToolchainIdentityInput {
                rustc: "rustc 1.90.0".to_string(),
                target: "x86_64-unknown-linux-gnu".to_string(),
            },
        }
    }

    #[test]
    fn passport_contract_fixture_matches_live_projection() {
        let fixture: serde_json::Value = serde_json::from_str(CONTRACT_FIXTURE).unwrap();
        assert_eq!(fixture, runtime_passport_contract());
    }

    #[test]
    fn passport_round_trips_and_rejects_unknown_fields() {
        let passport = RuntimePassport::derive(input()).unwrap();
        let encoded = serde_json::to_string(&passport).unwrap();
        assert_eq!(RuntimePassport::from_json_str(&encoded).unwrap(), passport);
        let mut object: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        object["unexpected"] = serde_json::json!(true);
        assert!(matches!(
            RuntimePassport::from_json_str(&object.to_string()),
            Err(RuntimePassportError::InvalidJson(_))
        ));
    }

    #[test]
    fn passport_rejects_wrong_schema_and_incomplete_identity() {
        let mut passport = RuntimePassport::derive(input()).unwrap();
        passport.schema_version = "evalops.maestro.runtime-passport.v2".to_string();
        assert_eq!(
            passport.validate(),
            Err(RuntimePassportError::UnsupportedSchemaVersion)
        );
        let mut incomplete = input();
        incomplete.artifact.digest = "sha256:short".to_string();
        assert_eq!(
            RuntimePassport::derive(incomplete),
            Err(RuntimePassportError::InvalidDigest("artifact.digest"))
        );
    }

    #[test]
    fn passport_rejects_profiles_outside_the_live_conformance_contract() {
        let mut unsupported = input();
        unsupported.behavior_profiles = vec!["hosted-resident-v1".to_string()];
        assert_eq!(
            RuntimePassport::derive(unsupported),
            Err(RuntimePassportError::UnsupportedBehaviorProfile)
        );

        let valid = RuntimePassport::derive(input()).unwrap();
        let mut encoded = serde_json::to_value(valid).unwrap();
        encoded["behaviorProfiles"] = serde_json::json!(["hosted-resident-v1"]);
        assert_eq!(
            RuntimePassport::from_json_str(&encoded.to_string()),
            Err(RuntimePassportError::UnsupportedBehaviorProfile)
        );
    }

    #[test]
    fn conformance_contract_fixture_is_runtime_owned() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/runtime-conformance-v1.json")).unwrap();
        assert_eq!(fixture, runtime_conformance_contract());
    }
}

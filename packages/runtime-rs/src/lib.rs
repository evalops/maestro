//! The transport-neutral native Maestro runtime product boundary.
//!
//! This crate records the identity and process topology of the native hosted
//! runtime. It intentionally does not own a socket, child process, database,
//! tenant lease, or retry loop. Those concerns remain in their existing owners
//! while callers adopt the boundary incrementally.

#![forbid(unsafe_code)]

mod boundary;
mod launch_spec;
pub mod passport;
pub mod protocol;
mod receipts;

pub use boundary::{
    HostedRuntimeAuthMode, HostedRuntimeBoundary, HostedRuntimeBoundaryInput, RuntimeBoundaryError,
};
pub use launch_spec::{
    HostedLaunchIdentity, HostedLaunchModelContract, HostedLaunchRendezvous,
    HostedLaunchRendezvousMode, HostedLaunchRestoreIntent, HostedLaunchRuntime,
    HostedLaunchSecretFileRefs, HostedLaunchSpec, HostedLaunchSpecError, HostedLaunchSpecInput,
    HostedLaunchWorkloadIdentity, HostedLaunchWorkspace, HOSTED_LAUNCH_SPEC_VERSION,
};
pub use passport::{
    runtime_conformance_contract, runtime_passport_contract, RuntimeArtifactIdentity,
    RuntimeArtifactIdentityInput, RuntimeArtifactKind, RuntimeConformanceIdentity,
    RuntimeConformanceIdentityInput, RuntimePassport, RuntimePassportError, RuntimePassportInput,
    RuntimeToolchainIdentity, RuntimeToolchainIdentityInput, RUNTIME_CONFORMANCE_PROFILE,
    RUNTIME_CONFORMANCE_VERSION, RUNTIME_PASSPORT_PREDICATE_TYPE, RUNTIME_PASSPORT_VERSION,
};
pub use protocol::{
    decode_tagged_message, headless_protocol_capability_digest, headless_protocol_contract,
    headless_protocol_version_is_supported, negotiate_headless_protocol, ConnectionRoleCapability,
    FromRuntimeMessageType, HeadlessCapabilityProjection, HeadlessProtocolContract,
    HeadlessTerminalProjection, NegotiatedHeadlessProtocol, NotificationCapability,
    SchemaOnlyServerRequestCapability, ServerRequestCapability, TaggedMessageDecode,
    TaggedMessageDecodeError, TerminalErrorKind, TerminalEvent, TerminalReducer, TerminalStatus,
    TerminalTransition, ToRuntimeMessageType, UnknownWireMessage,
    UnsupportedHeadlessProtocolVersion, UtilityOperationCapability,
    HEADLESS_FROM_RUNTIME_MESSAGE_NAMES, HEADLESS_PROTOCOL_SCHEMA_VERSION,
    HEADLESS_PROTOCOL_VERSION, HEADLESS_RUNTIME_ONLY_FROM_RUNTIME_MESSAGE_NAMES,
    HEADLESS_RUNTIME_ONLY_TO_RUNTIME_MESSAGE_NAMES, HEADLESS_TERMINAL_REDUCER_VERSION,
    HEADLESS_TO_RUNTIME_MESSAGE_NAMES, HEADLESS_TURN_TERMINAL_RESPONSE_IDS,
    SUPPORTED_HEADLESS_PROTOCOL_VERSIONS,
};
pub use receipts::{
    runtime_receipt_validation_contract, RuntimeLifecycleState, RuntimeReceipt,
    RuntimeReceiptError, RuntimeReceiptInput, RuntimeReceiptKind, RuntimeTerminalClassification,
    MAX_RUNTIME_RECEIPT_STRING_BYTES, RUNTIME_RECEIPT_VERSION,
};

/// Stable product identifier for the native Maestro runtime boundary.
pub const RUNTIME_PRODUCT_ID: &str = "evalops.maestro.runtime";
/// Version identifier for the serialized hosted runtime boundary contract.
pub const RUNTIME_BOUNDARY_VERSION: &str = "evalops.maestro.runtime-boundary.v1";
/// Existing hosted-runner process topology preserved by the native boundary.
pub const HOSTED_RUNTIME_TOPOLOGY: &str = "hosted-runner->maestro-headless-child";

/// Stable product and boundary-version identity for the native runtime crate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeProductIdentity {
    /// Stable product identifier.
    pub product_id: &'static str,
    /// Versioned boundary contract identifier.
    pub boundary_version: &'static str,
    /// Published native runtime package version.
    pub package_version: &'static str,
}

/// Returns the native runtime product identity used by startup and release
/// checks.
#[must_use]
pub const fn product_identity() -> RuntimeProductIdentity {
    RuntimeProductIdentity {
        product_id: RUNTIME_PRODUCT_ID,
        boundary_version: RUNTIME_BOUNDARY_VERSION,
        package_version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        product_identity, HOSTED_RUNTIME_TOPOLOGY, RUNTIME_BOUNDARY_VERSION, RUNTIME_PRODUCT_ID,
    };

    #[test]
    fn product_identity_is_stable() {
        let identity = product_identity();
        assert_eq!(identity.product_id, RUNTIME_PRODUCT_ID);
        assert_eq!(identity.boundary_version, RUNTIME_BOUNDARY_VERSION);
        assert_eq!(identity.package_version, "0.1.0");
    }

    #[test]
    fn hosted_topology_is_the_existing_process_shape() {
        assert_eq!(
            HOSTED_RUNTIME_TOPOLOGY,
            "hosted-runner->maestro-headless-child"
        );
    }
}

//! The trusted host supplies a new opaque capability for each HTTP invocation.
use std::{future::Future, pin::Pin};

use maestro_runtime_contracts::ManagedInferenceAuthorization;

/// Renewal is separate from logical-request hooks: transport retries consume
/// authority too. The client never signs or broadens the returned capability.
pub trait ManagedAuthorizationProvider: Send + Sync {
    fn renew(
        &self,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<ManagedInferenceAuthorization>> + Send + '_>>;
}

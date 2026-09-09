//! Monotonic delivery observations scoped to the same private outbox owner.
//! Counters describe successful local observations, not an external billing ledger.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeliveryAccounting {
    pub producer_id: Uuid,
    pub queued: u64,
    pub acknowledged: u64,
    pub evicted: u64,
    pub write_failures: u64,
}

impl Default for DeliveryAccounting {
    fn default() -> Self {
        Self {
            producer_id: Uuid::new_v4(),
            queued: 0,
            acknowledged: 0,
            evicted: 0,
            write_failures: 0,
        }
    }
}

fn path(outbox: &Path, scope: &TelemetryIdentityScope) -> Option<PathBuf> {
    let digest = Sha256::digest(serde_json::to_vec(scope).ok()?);
    Some(outbox.join(format!(".delivery-{digest:x}.state")))
}

pub(super) fn read(outbox: &Path, scope: &TelemetryIdentityScope) -> Option<DeliveryAccounting> {
    let bytes = fs::read(path(outbox, scope)?).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Caller holds the outbox lease. Missing/corrupt existing accounting never
/// resets counters; that would manufacture a fresh completeness denominator.
pub(super) fn update(
    outbox: &Path,
    scope: &TelemetryIdentityScope,
    update: impl FnOnce(&mut DeliveryAccounting),
) -> Option<()> {
    let path = path(outbox, scope)?;
    let mut counters = if path.exists() {
        read(outbox, scope)?
    } else {
        DeliveryAccounting::default()
    };
    update(&mut counters);
    crate::path_utils::atomic_private_write(&path, &serde_json::to_vec(&counters).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_counters_survive_reopen_and_never_cross_tenants() {
        let directory = tempfile::tempdir().unwrap();
        let a = TelemetryIdentityScope::new("org-a", Some("workspace-a")).unwrap();
        let b = TelemetryIdentityScope::new("org-b", Some("workspace-b")).unwrap();
        with_outbox_lock(directory.path(), || {
            update(directory.path(), &a, |s| s.queued += 1)
        })
        .unwrap();
        let first = read(directory.path(), &a).unwrap();
        with_outbox_lock(directory.path(), || {
            update(directory.path(), &a, |s| s.acknowledged += 1)
        })
        .unwrap();
        let second = read(directory.path(), &a).unwrap();
        assert_eq!(first.producer_id, second.producer_id);
        assert_eq!(second.queued, 1);
        assert_eq!(second.acknowledged, 1);
        assert!(read(directory.path(), &b).is_none());
        fs::write(path(directory.path(), &a).unwrap(), b"invalid").unwrap();
        assert!(
            update(directory.path(), &a, |_| {}).is_none(),
            "corrupt accounting cannot silently reset"
        );
    }
}

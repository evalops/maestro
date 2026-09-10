//! Pending responses belong to the future awaiting them, including when its
//! caller drops it during cancellation or an outer timeout.
use super::protocol::McpResponse;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub(super) type PendingResponses = Arc<Mutex<HashMap<u64, oneshot::Sender<McpResponse>>>>;

pub(super) struct PendingRequestGuard {
    pending: PendingResponses,
    id: u64,
}

impl PendingRequestGuard {
    pub(super) fn register(
        pending: &PendingResponses,
        id: u64,
        sender: oneshot::Sender<McpResponse>,
    ) -> Self {
        pending.lock().unwrap().insert(id, sender);
        Self {
            pending: Arc::clone(pending),
            id,
        }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        // A synchronous, short critical section makes cleanup immediate even
        // when the async request is dropped; no detached cleanup task is needed.
        self.pending.lock().unwrap().remove(&self.id);
    }
}

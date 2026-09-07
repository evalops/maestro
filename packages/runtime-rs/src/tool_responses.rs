//! Process-local keyed coordination for caller-owned tool responses.
//!
//! The acknowledgement sent by this module reports local response
//! consumption or rejection. Platform remains authoritative for approval,
//! attachment, and generation state; this coordinator has no persistence or
//! durable restore semantics.

use std::collections::{HashMap, HashSet, VecDeque};

use maestro_runtime_contracts::{ExecutionSource, ToolResult};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const CANCELLED_RESPONSE_REASON: &str = "tool response cancelled before native consumption";
const SESSION_BOUNDARY_RESPONSE_REASON: &str = "tool response invalidated by session boundary";

/// The message sent by a caller that owns execution of a tool.
///
/// `source` records whether a supplied result was produced by the local TUI
/// (`Native`) or by a remote/headless caller (`RemoteClient`). `result` and
/// its details are carried unchanged; `acknowledgement` fires only when the
/// coordinator consumes or rejects this exact keyed response.
pub type ToolResponseMessage = (
    String,
    bool,
    Option<ToolResult>,
    ExecutionSource,
    Option<oneshot::Sender<ToolResponseConsumption>>,
);

/// The response data returned after the coordinator consumes a tool response.
pub type ToolResponseData = (bool, Option<ToolResult>, ExecutionSource);

/// The acknowledgement sent to a caller after its response is consumed or rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolResponseConsumption {
    Accepted,
    Rejected { reason: String },
}

/// The result of waiting for one keyed caller-owned tool response.
#[derive(Debug)]
pub enum ToolResponseWait {
    Response(ToolResponseData),
    Cancelled,
    Closed,
}

/// The maximum number of cancelled call IDs retained to reject late responses.
const MAX_CANCELLED_TOOL_TOMBSTONES: usize = 4096;

#[derive(Debug, Default)]
struct CancelledToolTombstones {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl CancelledToolTombstones {
    fn insert(&mut self, call_id: String) {
        if !self.ids.insert(call_id.clone()) {
            return;
        }

        self.order.push_back(call_id);
        while self.order.len() > MAX_CANCELLED_TOOL_TOMBSTONES {
            if let Some(evicted) = self.order.pop_front() {
                self.ids.remove(&evicted);
            }
        }
    }

    fn remove(&mut self, call_id: &str) {
        if self.ids.remove(call_id) {
            self.order.retain(|entry| entry != call_id);
        }
    }

    fn contains(&self, call_id: &str) -> bool {
        self.ids.contains(call_id)
    }

    fn clear(&mut self) {
        self.ids.clear();
        self.order.clear();
    }
}

type PendingToolResponse = (
    bool,
    Option<ToolResult>,
    ExecutionSource,
    Option<oneshot::Sender<ToolResponseConsumption>>,
);

/// Coordinates caller-owned tool responses for native and Codex response paths.
///
/// The coordinator is the sole owner of the response receiver, keyed responses,
/// and cancellation tombstones. TUI callers can continue using the legacy
/// [`ToolResponseMessage`] and acknowledgement types through its compatibility
/// exports.
pub struct ToolResponseCoordinator {
    receiver: mpsc::UnboundedReceiver<ToolResponseMessage>,
    pending: HashMap<String, PendingToolResponse>,
    tombstones: CancelledToolTombstones,
}

impl std::fmt::Debug for ToolResponseCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolResponseCoordinator")
            .field("pending_len", &self.pending.len())
            .field("tombstone_len", &self.tombstones.ids.len())
            .finish_non_exhaustive()
    }
}

impl ToolResponseCoordinator {
    /// Creates a coordinator around the caller-owned response receiver.
    pub fn new(receiver: mpsc::UnboundedReceiver<ToolResponseMessage>) -> Self {
        Self {
            receiver,
            pending: HashMap::new(),
            tombstones: CancelledToolTombstones::default(),
        }
    }

    /// Buffers all currently available responses and rejects tombstoned calls.
    pub fn drain_available(&mut self) {
        while let Ok(response) = self.receiver.try_recv() {
            self.buffer_or_reject(response);
        }
    }

    /// Buffers a response unless its call ID has already been cancelled.
    fn buffer_or_reject(&mut self, response: ToolResponseMessage) {
        let (call_id, approved, result, source, acknowledgement) = response;
        if self.tombstones.contains(&call_id) {
            reject(acknowledgement, CANCELLED_RESPONSE_REASON);
            return;
        }

        self.pending
            .insert(call_id, (approved, result, source, acknowledgement));
    }

    /// Marks cancelled call IDs, rejects any buffered responses for them, and
    /// rejects late responses already waiting in the channel.
    pub fn discard_cancelled(&mut self, cancelled_ids: &HashSet<String>) {
        for call_id in cancelled_ids {
            self.tombstones.insert(call_id.clone());
        }

        for call_id in cancelled_ids {
            if let Some((_, _, _, acknowledgement)) = self.pending.remove(call_id) {
                reject(acknowledgement, CANCELLED_RESPONSE_REASON);
            }
        }

        self.drain_available();
    }

    /// Rejects buffered responses when cancellation prevents their consumption.
    pub fn reject_buffered_on_cancel(&mut self) {
        for (_, _, _, acknowledgement) in self.pending.drain().map(|(_, value)| value) {
            reject(acknowledgement, CANCELLED_RESPONSE_REASON);
        }
    }

    /// Invalidates pending and queued responses at a session boundary.
    pub fn reset(&mut self) {
        for (_, _, _, acknowledgement) in self.pending.drain().map(|(_, value)| value) {
            reject(acknowledgement, SESSION_BOUNDARY_RESPONSE_REASON);
        }

        while let Ok((_, _, _, _, acknowledgement)) = self.receiver.try_recv() {
            reject(acknowledgement, SESSION_BOUNDARY_RESPONSE_REASON);
        }

        self.tombstones.clear();
    }

    /// Removes a cancellation tombstone after a new turn has claimed the ID.
    pub fn remove_cancelled(&mut self, call_id: &str) {
        self.tombstones.remove(call_id);
    }

    /// Takes a response for orphan-history repair and acknowledges its
    /// consumption without waiting for a model turn.
    pub fn take_pending_for_repair(&mut self, call_id: &str) -> Option<ToolResponseData> {
        let (approved, result, source, acknowledgement) = self.pending.remove(call_id)?;
        acknowledge(acknowledgement);
        Some((approved, result, source))
    }

    /// Waits for one keyed tool response while honoring cancellation.
    pub async fn wait_for_tool_response(
        &mut self,
        call_id: &str,
        cancellation: &CancellationToken,
    ) -> ToolResponseWait {
        if cancellation.is_cancelled() {
            return ToolResponseWait::Cancelled;
        }

        if let Some((approved, result, source, acknowledgement)) = self.pending.remove(call_id) {
            acknowledge(acknowledgement);
            return ToolResponseWait::Response((approved, result, source));
        }

        loop {
            let response = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return ToolResponseWait::Cancelled,
                response = self.receiver.recv() => response,
            };

            let Some((response_call_id, approved, result, source, acknowledgement)) = response
            else {
                return ToolResponseWait::Closed;
            };

            if self.tombstones.contains(&response_call_id) {
                reject(acknowledgement, CANCELLED_RESPONSE_REASON);
            } else if response_call_id == call_id {
                acknowledge(acknowledgement);
                return ToolResponseWait::Response((approved, result, source));
            } else {
                self.pending.insert(
                    response_call_id,
                    (approved, result, source, acknowledgement),
                );
            }
        }
    }
}

fn acknowledge(acknowledgement: Option<oneshot::Sender<ToolResponseConsumption>>) {
    if let Some(acknowledgement) = acknowledgement {
        let _ = acknowledgement.send(ToolResponseConsumption::Accepted);
    }
}

fn reject(acknowledgement: Option<oneshot::Sender<ToolResponseConsumption>>, reason: &str) {
    if let Some(acknowledgement) = acknowledgement {
        let _ = acknowledgement.send(ToolResponseConsumption::Rejected {
            reason: reason.to_owned(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(
        call_id: &str,
        approved: bool,
        result: Option<ToolResult>,
        source: ExecutionSource,
    ) -> (
        ToolResponseMessage,
        oneshot::Receiver<ToolResponseConsumption>,
    ) {
        let (acknowledgement, receipt) = oneshot::channel();
        (
            (
                call_id.to_owned(),
                approved,
                result,
                source,
                Some(acknowledgement),
            ),
            receipt,
        )
    }

    #[tokio::test]
    async fn out_of_order_ack_happens_only_when_each_response_is_consumed() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (first, first_ack) = response(
            "first",
            true,
            Some(ToolResult::success("first output")),
            ExecutionSource::Native,
        );
        let (second, second_ack) = response(
            "second",
            false,
            Some(ToolResult::failure("second output")),
            ExecutionSource::RemoteClient,
        );
        sender.send(second).unwrap();
        sender.send(first).unwrap();

        let mut coordinator = ToolResponseCoordinator::new(receiver);
        let cancellation = CancellationToken::new();
        let mut first_ack = first_ack;
        assert!(matches!(
            first_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        assert!(matches!(
            coordinator
                .wait_for_tool_response("first", &cancellation)
                .await,
            ToolResponseWait::Response((true, Some(_), ExecutionSource::Native))
        ));
        assert_eq!(first_ack.await.unwrap(), ToolResponseConsumption::Accepted);
        let mut second_ack = second_ack;
        assert!(matches!(
            second_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        assert!(matches!(
            coordinator
                .wait_for_tool_response("second", &cancellation)
                .await,
            ToolResponseWait::Response((false, Some(_), ExecutionSource::RemoteClient))
        ));
        assert_eq!(second_ack.await.unwrap(), ToolResponseConsumption::Accepted);
    }

    #[tokio::test]
    async fn cancellation_tombstones_reject_late_responses_and_are_bounded() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        let cancelled_ids: HashSet<_> = ["cancelled".to_owned()].into_iter().collect();
        coordinator.discard_cancelled(&cancelled_ids);

        let (late, late_ack) = response(
            "cancelled",
            true,
            Some(ToolResult::success("late")),
            ExecutionSource::RemoteClient,
        );
        sender.send(late).unwrap();
        coordinator.drain_available();
        assert_eq!(
            late_ack.await.unwrap(),
            ToolResponseConsumption::Rejected {
                reason: CANCELLED_RESPONSE_REASON.to_owned()
            }
        );

        for index in 0..(MAX_CANCELLED_TOOL_TOMBSTONES + 1) {
            let one_id = [format!("cancelled-{index}")].into_iter().collect();
            coordinator.discard_cancelled(&one_id);
        }

        let (evicted, evicted_ack) = response("cancelled", true, None, ExecutionSource::Native);
        sender.send(evicted).unwrap();
        coordinator.drain_available();
        let mut evicted_ack = evicted_ack;
        assert!(matches!(
            evicted_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        let (retained, retained_ack) =
            response("cancelled-4096", true, None, ExecutionSource::Native);
        sender.send(retained).unwrap();
        coordinator.drain_available();
        assert_eq!(
            retained_ack.await.unwrap(),
            ToolResponseConsumption::Rejected {
                reason: CANCELLED_RESPONSE_REASON.to_owned()
            }
        );
    }

    #[tokio::test]
    async fn removing_and_reinserting_a_tombstone_preserves_bounded_eviction_order() {
        let (_sender, receiver) = mpsc::unbounded_channel();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        for index in 0..MAX_CANCELLED_TOOL_TOMBSTONES {
            let one_id = [format!("call-{index}")].into_iter().collect();
            coordinator.discard_cancelled(&one_id);
        }

        coordinator.remove_cancelled("call-0");
        let reinserted = ["call-0".to_owned()].into_iter().collect();
        coordinator.discard_cancelled(&reinserted);
        let newest = [format!("call-{MAX_CANCELLED_TOOL_TOMBSTONES}")]
            .into_iter()
            .collect();
        coordinator.discard_cancelled(&newest);

        let (reinserted_response, reinserted_ack) =
            response("call-0", true, None, ExecutionSource::Native);
        coordinator.buffer_or_reject(reinserted_response);
        assert_eq!(
            reinserted_ack.await.unwrap(),
            ToolResponseConsumption::Rejected {
                reason: CANCELLED_RESPONSE_REASON.to_owned()
            }
        );

        coordinator.buffer_or_reject((
            "call-1".to_owned(),
            true,
            None,
            ExecutionSource::Native,
            None,
        ));
        assert!(matches!(
            coordinator.take_pending_for_repair("call-1"),
            Some((true, None, ExecutionSource::Native))
        ));
    }

    #[tokio::test]
    async fn cancellation_rejects_buffered_responses_and_preserves_late_tombstones() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (buffered, buffered_ack) = response("buffered", true, None, ExecutionSource::Native);
        sender.send(buffered).unwrap();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.drain_available();
        coordinator.reject_buffered_on_cancel();
        assert_eq!(
            buffered_ack.await.unwrap(),
            ToolResponseConsumption::Rejected {
                reason: CANCELLED_RESPONSE_REASON.to_owned()
            }
        );

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            coordinator
                .wait_for_tool_response("buffered", &cancellation)
                .await,
            ToolResponseWait::Cancelled
        ));
    }

    #[tokio::test]
    async fn cancelled_wait_preserves_buffered_response_until_rejected() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (message, mut acknowledgement) =
            response("buffered", true, None, ExecutionSource::Native);
        sender.send(message).unwrap();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.drain_available();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            coordinator
                .wait_for_tool_response("buffered", &cancellation)
                .await,
            ToolResponseWait::Cancelled
        ));
        assert!(matches!(
            acknowledgement.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        coordinator.discard_cancelled(&HashSet::from(["buffered".to_owned()]));
        assert!(matches!(
            acknowledgement.await.unwrap(),
            ToolResponseConsumption::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn waiting_rejects_late_cancelled_response_before_consuming_active_call() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.discard_cancelled(&HashSet::from(["cancelled".to_owned()]));
        let (late, late_ack) = response("cancelled", true, None, ExecutionSource::RemoteClient);
        let (active, active_ack) = response("active", false, None, ExecutionSource::RemoteClient);
        sender.send(late).unwrap();
        sender.send(active).unwrap();
        assert!(matches!(
            coordinator
                .wait_for_tool_response("active", &CancellationToken::new())
                .await,
            ToolResponseWait::Response((false, None, ExecutionSource::RemoteClient))
        ));
        assert_eq!(
            late_ack.await.unwrap(),
            ToolResponseConsumption::Rejected {
                reason: CANCELLED_RESPONSE_REASON.to_owned(),
            }
        );
        assert_eq!(active_ack.await.unwrap(), ToolResponseConsumption::Accepted);
    }

    #[tokio::test]
    async fn reset_allows_call_id_reuse_after_clearing_cancellation_state() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.discard_cancelled(&HashSet::from(["reused".to_owned()]));
        coordinator.reset();
        let (message, acknowledgement) = response("reused", true, None, ExecutionSource::Native);
        sender.send(message).unwrap();
        assert!(matches!(
            coordinator
                .wait_for_tool_response("reused", &CancellationToken::new())
                .await,
            ToolResponseWait::Response((true, None, ExecutionSource::Native))
        ));
        assert_eq!(
            acknowledgement.await.unwrap(),
            ToolResponseConsumption::Accepted
        );
    }

    #[tokio::test]
    async fn cancellation_wakes_an_active_response_wait() {
        let (_sender, receiver) = mpsc::unbounded_channel();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        let cancellation = CancellationToken::new();
        let waiter_cancellation = cancellation.clone();
        let waiter = tokio::spawn(async move {
            coordinator
                .wait_for_tool_response("active", &waiter_cancellation)
                .await
        });

        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("cancellation should wake an active response wait")
            .expect("response waiter should not panic");
        assert!(matches!(result, ToolResponseWait::Cancelled));
    }

    #[tokio::test]
    async fn reset_rejects_queued_and_buffered_responses_and_closed_is_distinct() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (queued, queued_ack) = response("queued", true, None, ExecutionSource::RemoteClient);
        let (buffered, buffered_ack) =
            response("buffered", true, None, ExecutionSource::RemoteClient);
        sender.send(queued).unwrap();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.drain_available();
        sender.send(buffered).unwrap();
        coordinator.reset();

        let expected = ToolResponseConsumption::Rejected {
            reason: SESSION_BOUNDARY_RESPONSE_REASON.to_owned(),
        };
        assert_eq!(queued_ack.await.unwrap(), expected);
        assert_eq!(buffered_ack.await.unwrap(), expected);

        let (closed_sender, closed_receiver) = mpsc::unbounded_channel();
        drop(closed_sender);
        let mut closed_coordinator = ToolResponseCoordinator::new(closed_receiver);
        assert!(matches!(
            closed_coordinator
                .wait_for_tool_response("closed", &CancellationToken::new())
                .await,
            ToolResponseWait::Closed
        ));

        let (approved_sender, approved_receiver) = mpsc::unbounded_channel();
        let (approved, approved_ack) = response(
            "approved",
            true,
            Some(ToolResult::success("approved")),
            ExecutionSource::Native,
        );
        approved_sender.send(approved).unwrap();
        let mut approved_coordinator = ToolResponseCoordinator::new(approved_receiver);
        assert!(matches!(
            approved_coordinator
                .wait_for_tool_response("approved", &CancellationToken::new())
                .await,
            ToolResponseWait::Response((true, Some(_), ExecutionSource::Native))
        ));
        assert_eq!(
            approved_ack.await.unwrap(),
            ToolResponseConsumption::Accepted
        );
    }

    #[tokio::test]
    async fn receipt_details_source_and_unknown_remote_outcome_are_preserved() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let details = json!({
            "remoteOutcome": "unknown",
            "provider": "opaque-provider",
            "nested": {"attempt": 3}
        });
        let result = ToolResult::success("remote output").with_details(details.clone());
        let (message, acknowledgement) = response(
            "remote-call",
            true,
            Some(result.clone()),
            ExecutionSource::RemoteClient,
        );
        sender.send(message).unwrap();

        let mut coordinator = ToolResponseCoordinator::new(receiver);
        let ToolResponseWait::Response((approved, Some(received), source)) = coordinator
            .wait_for_tool_response("remote-call", &CancellationToken::new())
            .await
        else {
            panic!("expected remote response");
        };
        assert!(approved);
        assert_eq!(received.output, result.output);
        assert_eq!(received.error, result.error);
        assert_eq!(received.details, Some(details));
        assert_eq!(source, ExecutionSource::RemoteClient);
        assert_eq!(
            acknowledgement.await.unwrap(),
            ToolResponseConsumption::Accepted
        );
    }

    #[tokio::test]
    async fn orphan_repair_can_take_pending_response_and_acknowledge_consumption() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (message, acknowledgement) = response(
            "orphan",
            true,
            Some(ToolResult::success("orphan result")),
            ExecutionSource::RemoteClient,
        );
        sender.send(message).unwrap();
        let mut coordinator = ToolResponseCoordinator::new(receiver);
        coordinator.drain_available();

        let Some((approved, Some(result), source)) = coordinator.take_pending_for_repair("orphan")
        else {
            panic!("expected pending orphan response");
        };
        assert!(approved);
        assert_eq!(result.output, "orphan result");
        assert_eq!(source, ExecutionSource::RemoteClient);
        assert_eq!(
            acknowledgement.await.unwrap(),
            ToolResponseConsumption::Accepted
        );
    }
}

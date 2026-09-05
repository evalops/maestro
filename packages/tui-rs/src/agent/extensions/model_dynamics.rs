//! Suggest a bounded boost from observed failures, never from assistant prose.
use super::{AgentExtension, NativeToolResultContext, ToolResultContext, ToolResultPayload};
use crate::{
    agent::FromAgent,
    model_dynamics::{BoostStatus, DynamicsState},
};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub(crate) struct ModelDynamicsExtension {
    state: Arc<Mutex<DynamicsState>>,
    events: mpsc::UnboundedSender<FromAgent>,
    turn: String,
    failures: usize,
    native_calls: std::collections::HashSet<String>,
}

impl ModelDynamicsExtension {
    pub fn new(state: Arc<Mutex<DynamicsState>>, events: mpsc::UnboundedSender<FromAgent>) -> Self {
        Self {
            state,
            events,
            turn: String::new(),
            failures: 0,
            native_calls: Default::default(),
        }
    }
}

impl AgentExtension for ModelDynamicsExtension {
    fn name(&self) -> &'static str {
        "model-dynamics"
    }
    fn on_tool_result(&mut self, cx: &ToolResultContext, result: &mut ToolResultPayload) {
        self.observe(&cx.turn_id, result.is_error, None);
    }
    fn on_native_tool_result(&mut self, cx: &NativeToolResultContext) {
        self.observe(&cx.turn_id, !cx.success, Some(&cx.call_id));
    }
}

impl ModelDynamicsExtension {
    fn observe(&mut self, turn_id: &str, is_error: bool, native_call: Option<&str>) {
        if self.turn != turn_id {
            self.turn = turn_id.to_owned();
            self.failures = 0;
            self.native_calls.clear();
        }
        if let Some(call_id) = native_call {
            if !self.native_calls.insert(call_id.to_owned()) {
                return;
            }
        }
        self.failures = if is_error {
            self.failures.saturating_add(1)
        } else {
            0
        };
        let mut state = self.state.lock().expect("model dynamics mutex");
        if self.failures >= 3 && state.available && !state.used && state.status == BoostStatus::Idle
        {
            state.status = BoostStatus::Suggested;
            let _ = self.events.send(FromAgent::BoostChanged {
                status: state.status,
                thinking: None,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::extensions::ExtensionRegistry;
    #[test]
    fn registry_suggests_once_after_three_failures_and_never_changes_result() {
        let state = Arc::new(Mutex::new(DynamicsState {
            available: true,
            ..Default::default()
        }));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut registry = ExtensionRegistry::with_default_tenants();
        registry.register(Box::new(ModelDynamicsExtension::new(state.clone(), tx)));
        for i in 0..4 {
            let cx = ToolResultContext {
                turn_id: "turn".into(),
                call_id: i.to_string(),
                tool_name: "edit".into(),
                args_hash: "{}".into(),
                args: serde_json::json!({}),
                is_error: true,
                duration_ms: 1,
            };
            let mut payload = ToolResultPayload {
                content: "failure".into(),
                is_error: true,
            };
            registry.on_tool_result(&cx, &mut payload);
            assert_eq!(payload.content, "failure");
            assert!(payload.is_error);
        }
        assert_eq!(state.lock().unwrap().status, BoostStatus::Suggested);
        assert!(matches!(
            rx.try_recv().unwrap(),
            FromAgent::BoostChanged {
                status: BoostStatus::Suggested,
                ..
            }
        ));
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn success_and_new_turn_reset_failure_streak_and_used_boost_suppresses_hint() {
        let state = Arc::new(Mutex::new(DynamicsState {
            available: true,
            ..Default::default()
        }));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut extension = ModelDynamicsExtension::new(state.clone(), tx);
        for (turn, failed) in [
            ("a", true),
            ("a", true),
            ("a", false),
            ("a", true),
            ("b", true),
            ("b", true),
        ] {
            let cx = ToolResultContext {
                turn_id: turn.into(),
                call_id: "call".into(),
                tool_name: "read".into(),
                args_hash: "{}".into(),
                args: serde_json::json!({}),
                is_error: failed,
                duration_ms: 0,
            };
            extension.on_tool_result(
                &cx,
                &mut ToolResultPayload {
                    content: "result".into(),
                    is_error: failed,
                },
            );
        }
        assert!(rx.try_recv().is_err());
        state.lock().unwrap().used = true;
        let cx = ToolResultContext {
            turn_id: "b".into(),
            call_id: "last".into(),
            tool_name: "read".into(),
            args_hash: "{}".into(),
            args: serde_json::json!({}),
            is_error: true,
            duration_ms: 0,
        };
        extension.on_tool_result(
            &cx,
            &mut ToolResultPayload {
                content: "failure".into(),
                is_error: true,
            },
        );
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn native_tool_failures_suggest_boost_without_counting_duplicate_completions() {
        let state = Arc::new(Mutex::new(DynamicsState {
            available: true,
            ..Default::default()
        }));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut registry = ExtensionRegistry::with_default_tenants();
        registry.register(Box::new(ModelDynamicsExtension::new(state, tx)));
        for call in ["one", "one", "two"] {
            registry.on_native_tool_result(&NativeToolResultContext {
                turn_id: "turn".into(),
                call_id: call.into(),
                success: false,
            });
        }
        assert!(rx.try_recv().is_err());
        registry.on_native_tool_result(&NativeToolResultContext {
            turn_id: "turn".into(),
            call_id: "three".into(),
            success: false,
        });
        assert!(matches!(
            rx.try_recv().unwrap(),
            FromAgent::BoostChanged {
                status: BoostStatus::Suggested,
                ..
            }
        ));
        assert!(rx.try_recv().is_err());
    }
}

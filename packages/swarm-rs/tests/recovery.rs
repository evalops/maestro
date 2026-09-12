//! Recovery boundary tests for owner-persisted dynamic swarms.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use maestro_swarm::{
    RecoveryDecision, SwarmConfig, SwarmEvent, SwarmExecutor, SwarmPlan, SwarmRecoveryHooks,
    SwarmSnapshot, SwarmStatus, SwarmTask, SwarmTaskOutcome, TaskResult, TaskStatus,
};
use tokio::sync::Notify;

fn result(output: &str) -> TaskResult {
    TaskResult {
        success: true,
        output: output.to_string(),
        files_modified: Vec::new(),
        duration_ms: 0,
        error: None,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn config() -> SwarmConfig {
    SwarmConfig {
        max_concurrency: 1,
        task_timeout_ms: None,
        ..SwarmConfig::default()
    }
}

#[test]
fn reservation_snapshot_precedes_callback_and_retry_is_explicit() {
    runtime().block_on(async {
        let scheduler = Arc::new(
            SwarmExecutor::new_with_run_id(
                SwarmPlan::new("recovery").with_tasks(vec![SwarmTask::new("work", "work")]),
                config(),
                "owner-run-1",
            )
            .unwrap(),
        );
        let reservation_seen = Arc::new(Notify::new());
        let release_persist = Arc::new(Notify::new());
        let captured = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let callback_calls = Arc::new(AtomicUsize::new(0));

        let persist_seen = Arc::clone(&reservation_seen);
        let persist_release = Arc::clone(&release_persist);
        let persist_snapshot = Arc::clone(&captured);
        let hooks = SwarmRecoveryHooks::new(
            move |snapshot| {
                let persist_seen = Arc::clone(&persist_seen);
                let persist_release = Arc::clone(&persist_release);
                let persist_snapshot = Arc::clone(&persist_snapshot);
                async move {
                    if !snapshot.in_flight.is_empty() {
                        *persist_snapshot.lock().unwrap() = Some(snapshot);
                        persist_seen.notify_one();
                        persist_release.notified().await;
                    }
                    Ok(())
                }
            },
            |_task| async { Ok(RecoveryDecision::Retry) },
        );

        let run_scheduler = Arc::clone(&scheduler);
        let run_calls = Arc::clone(&callback_calls);
        let run = tokio::spawn(async move {
            run_scheduler
                .run_expanding_with_recovery(
                    1,
                    move |_context| {
                        let run_calls = Arc::clone(&run_calls);
                        async move {
                            run_calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result("done")))
                        }
                    },
                    hooks,
                )
                .await
        });

        reservation_seen.notified().await;
        let snapshot = captured.lock().unwrap().clone().unwrap();
        assert_eq!(snapshot.run_id, "owner-run-1");
        assert_eq!(snapshot.in_flight.len(), 1);
        assert_eq!(snapshot.in_flight[0].task_id, "work");
        assert_eq!(
            snapshot.plan.get_task("work").unwrap().status,
            TaskStatus::Running
        );
        assert_eq!(callback_calls.load(Ordering::SeqCst), 0);

        // Abort the crashed process before releasing its pre-start journal
        // write. No callback was admitted in the old scheduler.
        run.abort();
        let _ = run.await;
        release_persist.notify_one();

        let restored = SwarmExecutor::from_snapshot(snapshot).unwrap();
        let calls = Arc::clone(&callback_calls);
        let state = restored
            .run_expanding_with_recovery(
                1,
                move |_context| {
                    let calls = Arc::clone(&calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(SwarmTaskOutcome::from(result("replayed after owner retry")))
                    }
                },
                SwarmRecoveryHooks::new(
                    |_snapshot| async { Ok(()) },
                    |_task| async { Ok(RecoveryDecision::Retry) },
                ),
            )
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Completed);
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn restored_completed_children_are_not_invoked_again() {
    runtime().block_on(async {
        let scheduler = Arc::new(
            SwarmExecutor::new_with_run_id(
                SwarmPlan::new("completed child").with_tasks(vec![
                    SwarmTask::new("root", "root"),
                    SwarmTask::new("child", "child").with_dependencies(vec!["root".into()]),
                ]),
                config(),
                "owner-run-2",
            )
            .unwrap(),
        );
        let checkpoint_seen = Arc::new(Notify::new());
        let release_checkpoint = Arc::new(Notify::new());
        let captured = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let calls = Arc::new(AtomicUsize::new(0));
        let checkpoint_blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let seen = Arc::clone(&checkpoint_seen);
        let release = Arc::clone(&release_checkpoint);
        let saved = Arc::clone(&captured);
        let checkpoint_blocked_for_hook = Arc::clone(&checkpoint_blocked);
        let hooks = SwarmRecoveryHooks::persist_only(move |snapshot| {
            let seen = Arc::clone(&seen);
            let release = Arc::clone(&release);
            let saved = Arc::clone(&saved);
            let checkpoint_blocked = Arc::clone(&checkpoint_blocked_for_hook);
            async move {
                if snapshot.completed_tasks.contains_key("root")
                    && snapshot.in_flight.is_empty()
                    && snapshot.plan.get_task("child").unwrap().status == TaskStatus::Pending
                    && !checkpoint_blocked.swap(true, Ordering::SeqCst)
                {
                    *saved.lock().unwrap() = Some(snapshot);
                    seen.notify_one();
                    release.notified().await;
                }
                Ok(())
            }
        });
        let run_scheduler = Arc::clone(&scheduler);
        let run_calls = Arc::clone(&calls);
        let run = tokio::spawn(async move {
            run_scheduler
                .run_expanding_with_recovery(
                    2,
                    move |context| {
                        let run_calls = Arc::clone(&run_calls);
                        async move {
                            run_calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result(&context.task.id)))
                        }
                    },
                    hooks,
                )
                .await
        });

        checkpoint_seen.notified().await;
        let snapshot = captured.lock().unwrap().clone().unwrap();
        assert!(snapshot.completed_tasks.contains_key("root"));
        assert_eq!(
            snapshot.plan.get_task("root").unwrap().status,
            TaskStatus::Completed
        );
        assert_eq!(
            snapshot.plan.get_task("child").unwrap().status,
            TaskStatus::Pending
        );

        scheduler.cancel();
        release_checkpoint.notify_one();
        let old_state = run.await.unwrap().unwrap();
        assert_eq!(old_state.status, SwarmStatus::Cancelled);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let restored = SwarmExecutor::from_snapshot(snapshot).unwrap();
        let restored_state = restored
            .run_expanding_with_recovery(
                2,
                {
                    let calls = Arc::clone(&calls);
                    move |context| {
                        let calls = Arc::clone(&calls);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result(&context.task.id)))
                        }
                    }
                },
                SwarmRecoveryHooks::noop(),
            )
            .await
            .unwrap();
        assert_eq!(restored_state.status, SwarmStatus::Completed);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    });
}

#[test]
fn nested_expansion_checkpoint_contains_graph_and_result_atomically() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new_with_run_id(
            SwarmPlan::new("nested").with_tasks(vec![
                SwarmTask::new("discover", "discover"),
                SwarmTask::new("final", "final").with_dependencies(vec!["discover".into()]),
            ]),
            config(),
            "owner-run-3",
        )
        .unwrap();
        let captured = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let captured_for_hook = Arc::clone(&captured);
        let hooks = SwarmRecoveryHooks::persist_only(move |snapshot| {
            let captured_for_hook = Arc::clone(&captured_for_hook);
            async move {
                if snapshot.completed_tasks.contains_key("discover")
                    && snapshot.plan.get_task("partition").is_some()
                    && snapshot.plan.get_task("partition").unwrap().status == TaskStatus::Pending
                {
                    let mut captured = captured_for_hook.lock().unwrap();
                    if captured.is_none() {
                        *captured = Some(snapshot);
                    }
                }
                Ok(())
            }
        });
        let state = scheduler
            .run_expanding_with_recovery(
                4,
                {
                    move |context| async move {
                        let follow_up_tasks = match context.task.id.as_str() {
                            "discover" => vec![SwarmTask::new("partition", "partition")],
                            "partition" => vec![SwarmTask::new("leaf", "leaf")],
                            _ => Vec::new(),
                        };
                        Ok(SwarmTaskOutcome {
                            result: result(&context.task.id),
                            follow_up_tasks,
                        })
                    }
                },
                hooks,
            )
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Completed);

        let snapshot = captured.lock().unwrap().clone().unwrap();
        snapshot.validate().unwrap();
        assert_eq!(
            snapshot.plan.get_task("discover").unwrap().status,
            TaskStatus::Completed
        );
        assert_eq!(snapshot.completed_tasks["discover"].output, "discover");
        assert_eq!(
            snapshot.plan.get_task("partition").unwrap().status,
            TaskStatus::Pending
        );
        assert_eq!(
            snapshot.plan.get_task("final").unwrap().dependencies,
            vec!["discover", "partition"]
        );
    });
}

#[test]
fn invalid_snapshot_is_rejected_before_restore() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new(
            SwarmPlan::new("invalid").with_tasks(vec![SwarmTask::new("one", "one")]),
            config(),
        )
        .unwrap();
        let mut snapshot = scheduler.snapshot().await;
        snapshot.plan.tasks[0].status = TaskStatus::Completed;
        assert!(snapshot.validate().is_err());
        assert!(SwarmExecutor::from_snapshot(snapshot).is_err());
    });
}

#[test]
fn indeterminate_recovery_never_replays_unknown_effect() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new(
            SwarmPlan::new("unknown").with_tasks(vec![SwarmTask::new("effect", "effect")]),
            config(),
        )
        .unwrap();
        let captured = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let seen = Arc::clone(&captured);
        let reservation_seen = Arc::new(Notify::new());
        let reservation_seen_for_hook = Arc::clone(&reservation_seen);
        let release = Arc::new(Notify::new());
        let release_for_hook = Arc::clone(&release);
        let hooks = SwarmRecoveryHooks::new(
            move |snapshot| {
                let seen = Arc::clone(&seen);
                let reservation_seen = Arc::clone(&reservation_seen_for_hook);
                let release = Arc::clone(&release_for_hook);
                async move {
                    if !snapshot.in_flight.is_empty() {
                        *seen.lock().unwrap() = Some(snapshot);
                        reservation_seen.notify_one();
                        release.notified().await;
                    }
                    Ok(())
                }
            },
            |_task| async {
                Ok(RecoveryDecision::KeepIndeterminate(
                    "remote outcome unknown".into(),
                ))
            },
        );
        let scheduler = Arc::new(scheduler);
        let run_scheduler = Arc::clone(&scheduler);
        let run = tokio::spawn(async move {
            run_scheduler
                .run_expanding_with_recovery(
                    1,
                    |_context| async {
                        panic!("the callback must not start before the crash snapshot")
                    },
                    hooks,
                )
                .await
        });
        reservation_seen.notified().await;
        run.abort();
        let _ = run.await;
        let snapshot = captured.lock().unwrap().clone().unwrap();
        let restored = SwarmExecutor::from_snapshot(snapshot).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let blocked_snapshots = Arc::new(Mutex::new(Vec::<SwarmSnapshot>::new()));
        let blocked_snapshots_for_hook = Arc::clone(&blocked_snapshots);
        let state = restored
            .run_expanding_with_recovery(
                1,
                {
                    let calls = Arc::clone(&calls);
                    move |_context| {
                        let calls = Arc::clone(&calls);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result("must not run")))
                        }
                    }
                },
                SwarmRecoveryHooks::new(
                    move |snapshot| {
                        let blocked_snapshots = Arc::clone(&blocked_snapshots_for_hook);
                        async move {
                            if !snapshot.indeterminate_tasks.is_empty() {
                                blocked_snapshots.lock().unwrap().push(snapshot);
                            }
                            Ok(())
                        }
                    },
                    |_task| async {
                        Ok(RecoveryDecision::KeepIndeterminate(
                            "remote outcome unknown".into(),
                        ))
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Running);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!state.events.iter().any(|event| {
            matches!(
                event,
                SwarmEvent::Completed { .. } | SwarmEvent::Failed { .. }
            )
        }));

        // The final checkpoint remains Running with an explicit blocked task,
        // so the owner can restore it later and reconcile without replay.
        let blocked = blocked_snapshots.lock().unwrap().last().cloned().unwrap();
        assert_eq!(blocked.status, SwarmStatus::Running);
        assert_eq!(
            blocked.plan.get_task("effect").unwrap().status,
            TaskStatus::Blocked
        );
        assert_eq!(
            blocked.indeterminate_tasks["effect"].reason,
            "remote outcome unknown"
        );

        let reconciled = SwarmExecutor::from_snapshot(blocked)
            .unwrap()
            .run_expanding_with_recovery(
                1,
                {
                    let calls = Arc::clone(&calls);
                    move |_context| {
                        let calls = Arc::clone(&calls);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result("must remain unreplayed")))
                        }
                    }
                },
                SwarmRecoveryHooks::new(
                    |_snapshot| async { Ok(()) },
                    |_task| async { Ok(RecoveryDecision::Reconcile(result("owner-confirmed"))) },
                ),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.status, SwarmStatus::Completed);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn recovery_timeout_preserves_unknown_effect_until_owner_reconciles() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new_with_run_id(
            SwarmPlan::new("timeout").with_tasks(vec![SwarmTask::new("effect", "effect")]),
            SwarmConfig {
                max_concurrency: 1,
                task_timeout_ms: Some(5),
                ..SwarmConfig::default()
            },
            "owner-run-timeout",
        )
        .unwrap();
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let snapshots = Arc::new(Mutex::new(Vec::<SwarmSnapshot>::new()));
        let snapshots_for_hook = Arc::clone(&snapshots);
        let state = scheduler
            .run_expanding_with_recovery(
                1,
                {
                    let callback_calls = Arc::clone(&callback_calls);
                    move |_context| {
                        let callback_calls = Arc::clone(&callback_calls);
                        async move {
                            callback_calls.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            Ok(SwarmTaskOutcome::from(result("late")))
                        }
                    }
                },
                SwarmRecoveryHooks::persist_only(move |snapshot| {
                    let snapshots = Arc::clone(&snapshots_for_hook);
                    async move {
                        snapshots.lock().unwrap().push(snapshot);
                        Ok(())
                    }
                }),
            )
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Running);
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
        assert!(!state.events.iter().any(|event| {
            matches!(
                event,
                SwarmEvent::Completed { .. } | SwarmEvent::Failed { .. }
            )
        }));

        let snapshot = scheduler.snapshot().await;
        snapshot.validate().unwrap();
        assert_eq!(snapshot.status, SwarmStatus::Running);
        assert!(snapshot.failed_tasks.is_empty());
        assert_eq!(
            snapshot.plan.get_task("effect").unwrap().status,
            TaskStatus::Blocked
        );
        assert!(
            snapshot.indeterminate_tasks["effect"]
                .reason
                .contains("timed out")
        );
        assert!(
            snapshots
                .lock()
                .unwrap()
                .iter()
                .any(|checkpoint| checkpoint.indeterminate_tasks.contains_key("effect"))
        );

        let restored = SwarmExecutor::from_snapshot(snapshot).unwrap();
        let restored_state = restored
            .run_expanding_with_recovery(
                1,
                |_context| async { panic!("timeout effect must not be replayed") },
                SwarmRecoveryHooks::new(
                    |_snapshot| async { Ok(()) },
                    |_task| async { Ok(RecoveryDecision::Reconcile(result("owner-confirmed"))) },
                ),
            )
            .await
            .unwrap();
        assert_eq!(restored_state.status, SwarmStatus::Completed);
        assert_eq!(
            restored_state
                .plan
                .get_task("effect")
                .unwrap()
                .result
                .as_ref()
                .unwrap()
                .output,
            "owner-confirmed"
        );
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn recovery_panic_preserves_unknown_effect_until_owner_reconciles() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new_with_run_id(
            SwarmPlan::new("panic").with_tasks(vec![SwarmTask::new("effect", "effect")]),
            config(),
            "owner-run-panic",
        )
        .unwrap();
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let latest_snapshot = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let latest_snapshot_for_hook = Arc::clone(&latest_snapshot);
        let state = scheduler
            .run_expanding_with_recovery(
                1,
                {
                    let callback_calls = Arc::clone(&callback_calls);
                    move |_context| {
                        let callback_calls = Arc::clone(&callback_calls);
                        async move {
                            callback_calls.fetch_add(1, Ordering::SeqCst);
                            panic!("the callback effect is unknown after panic");
                        }
                    }
                },
                SwarmRecoveryHooks::persist_only(move |snapshot| {
                    let latest_snapshot = Arc::clone(&latest_snapshot_for_hook);
                    async move {
                        *latest_snapshot.lock().unwrap() = Some(snapshot);
                        Ok(())
                    }
                }),
            )
            .await
            .unwrap();

        assert_eq!(state.status, SwarmStatus::Running);
        assert!(state.failed_tasks.is_empty());
        assert!(state.indeterminate_tasks.contains_key("effect"));
        assert!(!state.events.iter().any(|event| {
            matches!(
                event,
                SwarmEvent::Completed { .. } | SwarmEvent::Failed { .. }
            )
        }));
        let snapshot = latest_snapshot.lock().unwrap().clone().unwrap();
        snapshot.validate().unwrap();
        assert_eq!(snapshot.status, SwarmStatus::Running);
        assert_eq!(
            snapshot.plan.get_task("effect").unwrap().status,
            TaskStatus::Blocked
        );

        let reconciled = SwarmExecutor::from_snapshot(snapshot)
            .unwrap()
            .run_expanding_with_recovery(
                1,
                |_context| async { panic!("panicked effect must not be replayed") },
                SwarmRecoveryHooks::new(
                    |_snapshot| async { Ok(()) },
                    |_task| async { Ok(RecoveryDecision::Reconcile(result("owner-confirmed"))) },
                ),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.status, SwarmStatus::Completed);
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn recovery_error_return_preserves_unknown_effect_until_owner_reconciles() {
    runtime().block_on(async {
        let scheduler = SwarmExecutor::new_with_run_id(
            SwarmPlan::new("error").with_tasks(vec![SwarmTask::new("effect", "effect")]),
            config(),
            "owner-run-error",
        )
        .unwrap();
        let callback_calls = Arc::new(AtomicUsize::new(0));
        let latest_snapshot = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let latest_snapshot_for_hook = Arc::clone(&latest_snapshot);
        let state = scheduler
            .run_expanding_with_recovery(
                1,
                {
                    let callback_calls = Arc::clone(&callback_calls);
                    move |_context| {
                        let callback_calls = Arc::clone(&callback_calls);
                        async move {
                            callback_calls.fetch_add(1, Ordering::SeqCst);
                            Err(anyhow::anyhow!("remote effect outcome was lost"))
                        }
                    }
                },
                SwarmRecoveryHooks::persist_only(move |snapshot| {
                    let latest_snapshot = Arc::clone(&latest_snapshot_for_hook);
                    async move {
                        *latest_snapshot.lock().unwrap() = Some(snapshot);
                        Ok(())
                    }
                }),
            )
            .await
            .unwrap();

        assert_eq!(state.status, SwarmStatus::Running);
        assert!(state.failed_tasks.is_empty());
        assert!(state.indeterminate_tasks.contains_key("effect"));
        let snapshot = latest_snapshot.lock().unwrap().clone().unwrap();
        snapshot.validate().unwrap();

        let reconciled = SwarmExecutor::from_snapshot(snapshot)
            .unwrap()
            .run_expanding_with_recovery(
                1,
                |_context| async { panic!("lost effect must not be replayed") },
                SwarmRecoveryHooks::new(
                    |_snapshot| async { Ok(()) },
                    |_task| async { Ok(RecoveryDecision::Reconcile(result("owner-confirmed"))) },
                ),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.status, SwarmStatus::Completed);
        assert_eq!(callback_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn recovery_round_trip_loads_a_500_task_checkpoint_without_replaying_root() {
    runtime().block_on(async {
        let scheduler = Arc::new(
            SwarmExecutor::new_with_run_id(
                SwarmPlan::new("large recovery").with_tasks(vec![SwarmTask::new("root", "root")]),
                SwarmConfig {
                    max_concurrency: 32,
                    task_timeout_ms: None,
                    ..SwarmConfig::default()
                },
                "owner-run-large",
            )
            .unwrap(),
        );
        let root_checkpoint_seen = Arc::new(Notify::new());
        let root_checkpoint_seen_for_hook = Arc::clone(&root_checkpoint_seen);
        let release_root_checkpoint = Arc::new(Notify::new());
        let release_root_checkpoint_for_hook = Arc::clone(&release_root_checkpoint);
        let root_checkpoint_blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let root_checkpoint_blocked_for_hook = Arc::clone(&root_checkpoint_blocked);
        let serialized_checkpoint = Arc::new(Mutex::new(None::<Vec<u8>>));
        let serialized_checkpoint_for_hook = Arc::clone(&serialized_checkpoint);
        let checkpoint_count = Arc::new(AtomicUsize::new(0));
        let checkpoint_count_for_hook = Arc::clone(&checkpoint_count);
        let callback_calls = Arc::new(AtomicUsize::new(0));

        let first_hooks = SwarmRecoveryHooks::persist_only(move |snapshot| {
            let seen = Arc::clone(&root_checkpoint_seen_for_hook);
            let release = Arc::clone(&release_root_checkpoint_for_hook);
            let blocked = Arc::clone(&root_checkpoint_blocked_for_hook);
            let serialized = Arc::clone(&serialized_checkpoint_for_hook);
            let checkpoint_count = Arc::clone(&checkpoint_count_for_hook);
            async move {
                checkpoint_count.fetch_add(1, Ordering::SeqCst);
                if snapshot.completed_tasks.contains_key("root")
                    && snapshot.plan.tasks.len() == 500
                    && !blocked.swap(true, Ordering::SeqCst)
                {
                    *serialized.lock().unwrap() = Some(serde_json::to_vec(&snapshot).unwrap());
                    seen.notify_one();
                    release.notified().await;
                }
                Ok(())
            }
        });
        let run_scheduler = Arc::clone(&scheduler);
        let run_calls = Arc::clone(&callback_calls);
        let run = tokio::spawn(async move {
            run_scheduler
                .run_expanding_with_recovery(
                    500,
                    move |context| {
                        let run_calls = Arc::clone(&run_calls);
                        async move {
                            run_calls.fetch_add(1, Ordering::SeqCst);
                            let follow_up_tasks = if context.task.id == "root" {
                                (0..499)
                                    .map(|index| SwarmTask::new(format!("item-{index}"), "item"))
                                    .collect()
                            } else {
                                Vec::new()
                            };
                            Ok(SwarmTaskOutcome {
                                result: result(&context.task.id),
                                follow_up_tasks,
                            })
                        }
                    },
                    first_hooks,
                )
                .await
        });

        root_checkpoint_seen.notified().await;
        run.abort();
        let _ = run.await;
        release_root_checkpoint.notify_one();

        let encoded = serialized_checkpoint.lock().unwrap().clone().unwrap();
        let checkpoint: SwarmSnapshot = serde_json::from_slice(&encoded).unwrap();
        checkpoint.validate().unwrap();
        assert_eq!(checkpoint.status, SwarmStatus::Running);
        assert_eq!(checkpoint.plan.tasks.len(), 500);
        assert_eq!(checkpoint.completed_tasks.len(), 1);
        assert_eq!(
            checkpoint.plan.get_task("root").unwrap().status,
            TaskStatus::Completed
        );
        assert!(checkpoint.in_flight.is_empty());

        let restored = SwarmExecutor::from_snapshot(checkpoint).unwrap();
        let latest_checkpoint = Arc::new(Mutex::new(None::<SwarmSnapshot>));
        let latest_checkpoint_for_hook = Arc::clone(&latest_checkpoint);
        let resumed_checkpoint_count = Arc::new(AtomicUsize::new(0));
        let resumed_checkpoint_count_for_hook = Arc::clone(&resumed_checkpoint_count);
        let resumed_state = restored
            .run_expanding_with_recovery(
                500,
                {
                    let run_calls = Arc::clone(&callback_calls);
                    move |context| {
                        let run_calls = Arc::clone(&run_calls);
                        async move {
                            run_calls.fetch_add(1, Ordering::SeqCst);
                            Ok(SwarmTaskOutcome::from(result(&context.task.id)))
                        }
                    }
                },
                SwarmRecoveryHooks::persist_only(move |snapshot| {
                    let latest_checkpoint = Arc::clone(&latest_checkpoint_for_hook);
                    let resumed_checkpoint_count = Arc::clone(&resumed_checkpoint_count_for_hook);
                    async move {
                        resumed_checkpoint_count.fetch_add(1, Ordering::SeqCst);
                        *latest_checkpoint.lock().unwrap() = Some(snapshot);
                        Ok(())
                    }
                }),
            )
            .await
            .unwrap();
        assert_eq!(resumed_state.status, SwarmStatus::Completed);
        assert_eq!(resumed_state.plan.tasks.len(), 500);
        assert_eq!(resumed_state.completed_tasks.len(), 500);
        assert_eq!(callback_calls.load(Ordering::SeqCst), 500);
        assert!(checkpoint_count.load(Ordering::SeqCst) >= 3);
        assert!(resumed_checkpoint_count.load(Ordering::SeqCst) >= 999);

        let final_checkpoint = {
            let latest = latest_checkpoint.lock().unwrap().clone().unwrap();
            let encoded = serde_json::to_vec(&latest).unwrap();
            serde_json::from_slice::<SwarmSnapshot>(&encoded).unwrap()
        };
        final_checkpoint.validate().unwrap();
        assert_eq!(final_checkpoint.status, SwarmStatus::Completed);
        assert_eq!(final_checkpoint.completed_tasks.len(), 500);
    });
}

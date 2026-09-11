//! Public API tests: discovery, bounded expansion, conflict scheduling, and fan-in.
use maestro_swarm::{
    SwarmConfig, SwarmExecutor, SwarmPlan, SwarmStatus, SwarmTask, SwarmTaskOutcome, TaskResult,
    TaskStatus,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn result(output: impl Into<String>) -> TaskResult {
    TaskResult {
        success: true,
        output: output.into(),
        files_modified: vec![],
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
fn executor(tasks: Vec<SwarmTask>, concurrency: usize, keep_going: bool) -> SwarmExecutor {
    SwarmExecutor::new(
        SwarmPlan::new("Discovery and verification").with_tasks(tasks),
        SwarmConfig {
            max_concurrency: concurrency,
            continue_on_failure: keep_going,
            task_timeout_ms: None,
            ..SwarmConfig::default()
        },
    )
    .unwrap()
}
fn consumer(id: &str, source: &str) -> SwarmTask {
    SwarmTask::new(id, id).with_dependencies(vec![source.into()])
}

#[test]
fn dynamic_workflow_discovers_500_children_and_returns_one_verified_result() {
    runtime().block_on(async {
        let scheduler = executor(
            vec![
                SwarmTask::new("discover", "discover"),
                consumer("verify", "discover"),
                consumer("final", "verify"),
            ],
            16,
            false,
        );
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let active_in = active.clone();
        let peak_in = peak.clone();
        let state = tokio::time::timeout(
            Duration::from_secs(15),
            scheduler.run_expanding(503, move |context| {
                let active = active_in.clone();
                let peak = peak_in.clone();
                async move {
                    let id = context.task.id.as_str();
                    let mut outcome = SwarmTaskOutcome::from(result(id));
                    match id {
                        "discover" => {
                            outcome.follow_up_tasks = (0..500)
                                .map(|index| {
                                    SwarmTask::new(format!("item-{index}"), "inspect item")
                                })
                                .collect();
                        }
                        "verify" => {
                            assert_eq!(context.dependency_results.len(), 501);
                            for index in 0..500 {
                                assert_eq!(
                                    context.dependency_results[&format!("item-{index}")].output,
                                    format!("item-{index}")
                                );
                            }
                            outcome.result.output = "500 contributions verified".into();
                        }
                        "final" => {
                            assert_eq!(
                                context.dependency_results["verify"].output,
                                "500 contributions verified"
                            );
                            outcome.result.output = "one coherent result".into();
                        }
                        _ => {
                            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(count, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(1)).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    Ok(outcome)
                }
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(state.status, SwarmStatus::Completed);
        assert_eq!(state.completed_tasks.len(), 503);
        assert_eq!(
            state
                .plan
                .get_task("final")
                .unwrap()
                .result
                .as_ref()
                .unwrap()
                .output,
            "one coherent result"
        );
        assert!(peak.load(Ordering::SeqCst) > 1);
        assert!(peak.load(Ordering::SeqCst) <= 16);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn dynamic_workflow_nested_discovery_extends_the_final_barrier() {
    runtime().block_on(async {
        let scheduler = executor(
            vec![
                SwarmTask::new("discover", "discover"),
                consumer("final", "discover"),
            ],
            4,
            false,
        );
        let state = scheduler
            .run_expanding(4, |context| async move {
                let follow_up_tasks = match context.task.id.as_str() {
                    "discover" => vec![SwarmTask::new("partition", "partition")],
                    "partition" => vec![SwarmTask::new("leaf", "leaf")],
                    "final" => {
                        assert!(context.dependency_results.contains_key("leaf"));
                        vec![]
                    }
                    _ => vec![],
                };
                Ok(SwarmTaskOutcome {
                    result: result("ok"),
                    follow_up_tasks,
                })
            })
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Completed);
        assert_eq!(
            state.plan.get_task("final").unwrap().dependencies,
            vec!["discover", "partition", "leaf"]
        );
    });
}

#[test]
fn dynamic_workflow_rejects_invalid_expansion_atomically() {
    runtime().block_on(async {
        for kind in ["duplicate", "cycle", "missing", "budget", "started"] {
            let scheduler = executor(
                vec![
                    SwarmTask::new("discover", "discover"),
                    consumer("final", "discover"),
                ],
                2,
                false,
            );
            let state = scheduler
                .run_expanding(3, move |_| async move {
                    let mut tasks = vec![SwarmTask::new("child", "child")];
                    match kind {
                        "duplicate" => tasks[0].id = "discover".into(),
                        "cycle" => tasks[0].dependencies.push("final".into()),
                        "missing" => tasks[0].dependencies.push("unknown".into()),
                        "budget" => tasks.push(SwarmTask::new("extra", "extra")),
                        "started" => tasks[0].status = TaskStatus::Completed,
                        _ => unreachable!(),
                    }
                    Ok(SwarmTaskOutcome {
                        result: result("discovered"),
                        follow_up_tasks: tasks,
                    })
                })
                .await
                .unwrap();
            assert_eq!(state.status, SwarmStatus::Failed, "{kind}");
            assert_eq!(state.plan.tasks.len(), 2, "{kind}");
            assert!(state.failed_tasks.contains("discover"));
            assert!(!state.completed_tasks.contains("final"));
            assert_eq!(
                state.plan.get_task("final").unwrap().dependencies,
                vec!["discover"]
            );
        }
    });
}

#[test]
fn dynamic_workflow_failed_result_blocks_transitive_consumers_but_finishes_other_work() {
    runtime().block_on(async {
        let scheduler = executor(
            vec![
                SwarmTask::new("check", "check"),
                consumer("integrate", "check"),
                consumer("final", "integrate"),
                SwarmTask::new("independent", "independent"),
            ],
            1,
            true,
        );
        let state = tokio::time::timeout(
            Duration::from_secs(2),
            scheduler.run(|task| async move {
                assert!(!matches!(task.id.as_str(), "integrate" | "final"));
                let mut report = result("evidence retained");
                if task.id == "check" {
                    report.success = false;
                    report.error = Some("verification failed".into());
                }
                Ok(report)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(state.status, SwarmStatus::Failed);
        assert!(state.completed_tasks.contains("independent"));
        assert!(state.failed_tasks.contains("check"));
        for id in ["integrate", "final"] {
            assert_eq!(state.plan.get_task(id).unwrap().status, TaskStatus::Skipped);
        }
        assert_eq!(
            state
                .plan
                .get_task("check")
                .unwrap()
                .result
                .as_ref()
                .unwrap()
                .output,
            "evidence retained"
        );
    });
}

#[test]
fn dynamic_workflow_overlapping_scopes_are_serial_and_disjoint_scopes_run_together() {
    runtime().block_on(async {
        let paths = ["src/a.rs", "./src/a.rs", "src", "tests/a.rs"];
        let tasks = paths
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let mut task = SwarmTask::new(i.to_string(), "edit");
                task.files = vec![(*path).into()];
                task
            })
            .collect();
        let scheduler = executor(tasks, 4, false);
        let active = Arc::new(Mutex::new(Vec::<String>::new()));
        let peak = Arc::new(AtomicUsize::new(0));
        let peak_in = peak.clone();
        let state = scheduler
            .run(move |task| {
                let active = active.clone();
                let peak = peak_in.clone();
                async move {
                    {
                        let mut current = active.lock().unwrap();
                        if task.id != "3" {
                            assert!(current.iter().all(|id| id == "3"));
                        }
                        current.push(task.id.clone());
                        peak.fetch_max(current.len(), Ordering::SeqCst);
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    active.lock().unwrap().retain(|id| id != &task.id);
                    Ok(result("edited"))
                }
            })
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Completed);
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    });
}

#[test]
fn dynamic_workflow_budget_and_single_execution_are_checked_before_dispatch() {
    runtime().block_on(async {
        let scheduler = executor(vec![SwarmTask::new("one", "one")], 1, false);
        assert!(
            scheduler
                .run_expanding(0, |_| async { panic!("must not dispatch") })
                .await
                .is_err()
        );
        assert_eq!(
            scheduler
                .run(|_| async { Ok(result("ok")) })
                .await
                .unwrap()
                .status,
            SwarmStatus::Completed
        );
        assert!(
            scheduler
                .run(|_| async { panic!("must not rerun") })
                .await
                .is_err()
        );
    });
}

#[test]
fn dynamic_workflow_concurrent_expansions_share_one_budget() {
    runtime().block_on(async {
        let scheduler = executor(
            vec![
                SwarmTask::new("left", "left"),
                SwarmTask::new("right", "right"),
            ],
            2,
            true,
        );
        let state = scheduler
            .run_expanding(3, |context| async move {
                let follow_up_tasks = if context.task.id.ends_with("child") {
                    vec![]
                } else {
                    vec![SwarmTask::new(
                        format!("{}-child", context.task.id),
                        "child",
                    )]
                };
                Ok(SwarmTaskOutcome {
                    result: result("ok"),
                    follow_up_tasks,
                })
            })
            .await
            .unwrap();
        assert_eq!(state.plan.tasks.len(), 3);
        assert_eq!(state.completed_tasks.len(), 2);
        assert_eq!(state.failed_tasks.len(), 1);
        assert_eq!(state.status, SwarmStatus::Failed);
    });
}

#[test]
fn dynamic_workflow_failed_child_cannot_expand_or_claim_success() {
    runtime().block_on(async {
        let scheduler = executor(vec![SwarmTask::new("check", "check")], 1, true);
        let state = scheduler
            .run_expanding(2, |_| async {
                let mut failed = result("failed verification");
                failed.success = false;
                Ok(SwarmTaskOutcome {
                    result: failed,
                    follow_up_tasks: vec![SwarmTask::new("unexpected", "unexpected")],
                })
            })
            .await
            .unwrap();
        assert_eq!(state.status, SwarmStatus::Failed);
        assert_eq!(state.plan.tasks.len(), 1);
        assert!(state.completed_tasks.is_empty());
    });
}

#[test]
fn dynamic_workflow_rejects_zero_concurrency() {
    assert!(
        SwarmExecutor::new(
            SwarmPlan::new("one").with_tasks(vec![SwarmTask::new("one", "one")]),
            SwarmConfig {
                max_concurrency: 0,
                ..SwarmConfig::default()
            }
        )
        .is_err()
    );
}

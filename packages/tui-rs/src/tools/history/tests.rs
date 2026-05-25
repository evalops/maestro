use super::*;
use serde_json::json;

#[test]
fn test_tool_execution_lifecycle() {
    let mut exec = ToolExecution::start("call-1", "read", json!({"path": "/test"}));
    assert!(!exec.success);
    assert!(exec.output.is_none());

    exec.complete("file contents".to_string(), Duration::from_millis(50));
    assert!(exec.success);
    assert_eq!(exec.output, Some("file contents".to_string()));
}

#[test]
fn test_tool_history_basic() {
    let mut history = ToolHistory::new(100);

    let id = history.start("1", "read", json!({"path": "/test"}));
    history.complete(&id, "output".to_string());

    assert_eq!(history.len(), 1);
    assert!(history.last().unwrap().success);
}

#[test]
fn test_tool_history_stats() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({}));
    history.complete("1", "ok".to_string());

    history.start("2", "read", json!({}));
    history.fail("2", "error".to_string());

    let stats = history.global_stats();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.successes, 1);
    assert_eq!(stats.failures, 1);
    assert!((stats.success_rate() - 0.5).abs() < 0.01);
}

#[test]
fn test_tool_history_filter() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({}));
    history.complete("1", "file content".to_string());

    history.start("2", "write", json!({}));
    history.complete("2", "ok".to_string());

    history.start("3", "read", json!({}));
    history.fail("3", "not found".to_string());

    // Filter by tool
    let reads = history.search(&HistoryFilter::tool("read"));
    assert_eq!(reads.len(), 2);

    // Filter by success
    let successes = history.search(&HistoryFilter::successes());
    assert_eq!(successes.len(), 2);

    // Filter by failure
    let failures = history.search(&HistoryFilter::failures());
    assert_eq!(failures.len(), 1);

    // Filter by content
    let with_content = history.search(&HistoryFilter::default().containing("file"));
    assert_eq!(with_content.len(), 1);
}

#[test]
fn test_tool_history_max_size() {
    let mut history = ToolHistory::new(3);

    for i in 0..5 {
        let id = format!("{}", i);
        history.start(&id, "test", json!({}));
        history.complete(&id, "ok".to_string());
    }

    assert_eq!(history.len(), 3);
    // Should have most recent (2, 3, 4)
    let ids: Vec<_> = history.all().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["4", "3", "2"]);
}

#[test]
fn test_tool_stats() {
    let mut stats = ToolStats::default();

    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(200));
    stats.record(false, Duration::from_millis(50));

    assert_eq!(stats.total, 3);
    assert_eq!(stats.successes, 2);
    assert!((stats.success_rate() - 0.666).abs() < 0.01);
    assert_eq!(stats.avg_duration().as_millis(), 116); // (100+200+50)/3
}

#[test]
fn test_execution_summary() {
    let mut exec = ToolExecution::start("1", "read", json!({}));
    exec.complete("ok".to_string(), Duration::from_millis(123));

    let summary = exec.summary();
    assert!(summary.contains("✓"));
    assert!(summary.contains("read"));
    assert!(summary.contains("123ms"));
}

#[test]
fn test_approval_tracking() {
    let mut history = ToolHistory::new(100);

    history.start_with_approval("1", "write", json!({}), true);
    history.record_approval("1", true);
    history.complete("1", "ok".to_string());

    let exec = history.get("1").unwrap();
    assert!(exec.required_approval);
    assert_eq!(exec.approved, Some(true));
}

#[test]
fn test_execution_with_details() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls"}));
    let details = json!({
        "command": "ls",
        "exit_code": 0,
        "duration_ms": 50
    });

    exec.complete_with_details(
        "file1\nfile2".to_string(),
        Duration::from_millis(50),
        Some(details.clone()),
    );

    assert!(exec.success);
    assert_eq!(exec.output, Some("file1\nfile2".to_string()));
    assert!(exec.details.is_some());

    let exec_details = exec.get_details().unwrap();
    assert_eq!(exec_details["exit_code"], 0);
    assert_eq!(exec_details["command"], "ls");
}

#[test]
fn test_execution_fail_with_details() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "invalid"}));
    let details = json!({
        "command": "invalid",
        "exit_code": 127,
        "duration_ms": 10
    });

    exec.fail_with_details(
        "command not found".to_string(),
        Duration::from_millis(10),
        Some(details.clone()),
    );

    assert!(!exec.success);
    assert_eq!(exec.error, Some("command not found".to_string()));
    assert!(exec.details.is_some());

    let exec_details = exec.get_details().unwrap();
    assert_eq!(exec_details["exit_code"], 127);
}

#[test]
fn test_history_complete_with_details() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({"file_path": "/test.txt"}));

    let details = json!({
        "file_path": "/test.txt",
        "bytes_read": 1024,
        "lines_returned": 50
    });

    history.complete_with_details("1", "file contents".to_string(), Some(details));

    let exec = history.get("1").unwrap();
    assert!(exec.success);
    assert!(exec.details.is_some());

    let stored_details = history.get_details("1").unwrap();
    assert_eq!(stored_details["bytes_read"], 1024);
    assert_eq!(stored_details["lines_returned"], 50);
}

#[test]
fn test_history_fail_with_details() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({"file_path": "/missing.txt"}));

    let details = json!({
        "file_path": "/missing.txt",
        "error_code": "ENOENT"
    });

    history.fail_with_details("1", "file not found".to_string(), Some(details));

    let exec = history.get("1").unwrap();
    assert!(!exec.success);
    assert!(exec.details.is_some());

    let stored_details = history.get_details("1").unwrap();
    assert_eq!(stored_details["error_code"], "ENOENT");
}

#[test]
fn test_history_set_and_get_details() {
    let mut history = ToolHistory::new(100);

    history.start("1", "glob", json!({"pattern": "*.rs"}));

    // Set details after the fact
    history.set_details(
        "1",
        json!({
            "pattern": "*.rs",
            "matches_count": 42,
            "base_path": "/src"
        }),
    );

    let details = history.get_details("1").unwrap();
    assert_eq!(details["matches_count"], 42);
    assert_eq!(details["base_path"], "/src");

    // Complete the execution
    history.complete("1", "found 42 files".to_string());

    // Details should still be present
    let exec = history.get("1").unwrap();
    assert!(exec.success);
    assert!(exec.details.is_some());
}

#[test]
fn test_details_serialization() {
    let mut exec = ToolExecution::start("1", "image", json!({"path": "/screenshot.png"}));
    let details = json!({
        "path": "/screenshot.png",
        "mime_type": "image/png",
        "size_bytes": 50_000,
        "dimensions": {"width": 1920, "height": 1080}
    });

    exec.complete_with_details(
        "base64...".to_string(),
        Duration::from_millis(100),
        Some(details),
    );

    // Test serialization round-trip
    let serialized = serde_json::to_string(&exec).unwrap();
    let deserialized: ToolExecution = serde_json::from_str(&serialized).unwrap();

    assert!(deserialized.details.is_some());
    let d = deserialized.details.unwrap();
    assert_eq!(d["mime_type"], "image/png");
    assert_eq!(d["dimensions"]["width"], 1920);
}

#[test]
fn test_details_none_not_serialized() {
    let mut exec = ToolExecution::start("1", "read", json!({}));
    exec.complete("content".to_string(), Duration::from_millis(10));

    // Without details, should not have "details" key in JSON
    let serialized = serde_json::to_string(&exec).unwrap();
    assert!(!serialized.contains("\"details\""));
}

#[test]
fn test_get_typed_details() {
    use crate::tools::details::BashDetails;

    let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls -la"}));
    let details = BashDetails::success("ls -la")
        .with_duration(50)
        .with_cwd("/home/user");

    exec.complete_with_details(
        "file1\nfile2".to_string(),
        Duration::from_millis(50),
        Some(details.to_json()),
    );

    // Get typed details
    let typed: Option<BashDetails> = exec.get_typed_details();
    assert!(typed.is_some());

    let bash_details = typed.unwrap();
    assert_eq!(bash_details.command, "ls -la");
    assert_eq!(bash_details.exit_code, 0);
    assert_eq!(bash_details.duration_ms, Some(50));
}

#[test]
fn test_exit_code_accessor() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "false"}));
    let details = json!({
        "command": "false",
        "exit_code": 1,
        "duration_ms": 10
    });

    exec.complete_with_details(String::new(), Duration::from_millis(10), Some(details));

    assert_eq!(exec.exit_code(), Some(1));
}

#[test]
fn test_exit_code_accessor_none() {
    let mut exec = ToolExecution::start("1", "read", json!({"file_path": "/test.txt"}));
    exec.complete("content".to_string(), Duration::from_millis(10));

    // No details, so exit_code should be None
    assert_eq!(exec.exit_code(), None);
}

#[test]
fn test_timed_out_accessor() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "sleep 100"}));
    let details = json!({
        "command": "sleep 100",
        "timed_out": true,
        "duration_ms": 30_000
    });

    exec.fail_with_details(
        "Command timed out after 30_000ms".to_string(),
        Duration::from_secs(30),
        Some(details),
    );

    assert!(exec.timed_out());
}

#[test]
fn test_timed_out_accessor_false() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "echo hi"}));
    let details = json!({
        "command": "echo hi",
        "timed_out": false,
        "exit_code": 0
    });

    exec.complete_with_details("hi".to_string(), Duration::from_millis(5), Some(details));

    assert!(!exec.timed_out());
}

#[test]
fn test_command_accessor() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "cargo build"}));
    let details = json!({
        "command": "cargo build",
        "exit_code": 0
    });

    exec.complete_with_details("Built".to_string(), Duration::from_secs(1), Some(details));

    assert_eq!(exec.command(), Some("cargo build"));
}

#[test]
fn test_command_accessor_none() {
    let mut exec = ToolExecution::start("1", "read", json!({"file_path": "/test.txt"}));
    let details = json!({
        "file_path": "/test.txt",
        "bytes_read": 100
    });

    exec.complete_with_details(
        "content".to_string(),
        Duration::from_millis(10),
        Some(details),
    );

    // Read tool doesn't have a "command" field
    assert_eq!(exec.command(), None);
}

#[test]
fn test_duration_ms_accessor() {
    let mut exec = ToolExecution::start("1", "bash", json!({"command": "ls"}));
    exec.complete("output".to_string(), Duration::from_millis(123));

    assert_eq!(exec.duration_ms(), Some(123));
}

// ==================== ToolStats utility method tests ====================

#[test]
fn test_tool_stats_avg_duration_ms() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(200));
    stats.record(true, Duration::from_millis(300));

    assert_eq!(stats.avg_duration_ms(), 200);
}

#[test]
fn test_tool_stats_avg_duration_ms_empty() {
    let stats = ToolStats::default();
    assert_eq!(stats.avg_duration_ms(), 0);
}

#[test]
fn test_tool_stats_total_duration_ms() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(200));
    stats.record(false, Duration::from_millis(50));

    assert_eq!(stats.total_duration_ms(), 350);
}

#[test]
fn test_tool_stats_failure_rate() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(10));
    stats.record(false, Duration::from_millis(10));
    stats.record(false, Duration::from_millis(10));
    stats.record(false, Duration::from_millis(10));

    assert!((stats.failure_rate() - 0.75).abs() < 0.01);
}

#[test]
fn test_tool_stats_failure_rate_empty() {
    let stats = ToolStats::default();
    assert_eq!(stats.failure_rate(), 0.0);
}

#[test]
fn test_tool_stats_all_succeeded() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(10));
    stats.record(true, Duration::from_millis(10));

    assert!(stats.all_succeeded());

    stats.record(false, Duration::from_millis(10));
    assert!(!stats.all_succeeded());
}

#[test]
fn test_tool_stats_all_succeeded_empty() {
    let stats = ToolStats::default();
    // Empty stats should return false for all_succeeded
    assert!(!stats.all_succeeded());
}

#[test]
fn test_tool_stats_has_failures() {
    let mut stats = ToolStats::default();
    assert!(!stats.has_failures());

    stats.record(true, Duration::from_millis(10));
    assert!(!stats.has_failures());

    stats.record(false, Duration::from_millis(10));
    assert!(stats.has_failures());
}

#[test]
fn test_tool_stats_merge() {
    let mut stats1 = ToolStats::default();
    stats1.record(true, Duration::from_millis(100));
    stats1.record(true, Duration::from_millis(200));

    let mut stats2 = ToolStats::default();
    stats2.record(false, Duration::from_millis(50));
    stats2.record(true, Duration::from_millis(150));

    stats1.merge(&stats2);

    assert_eq!(stats1.total, 4);
    assert_eq!(stats1.successes, 3);
    assert_eq!(stats1.failures, 1);
    assert_eq!(stats1.total_duration_ms(), 500);
}

#[test]
fn test_tool_stats_summary() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(200));
    stats.record(false, Duration::from_millis(50));

    let summary = stats.summary();
    assert!(summary.contains("2/3")); // 2 successes out of 3 total
    assert!(summary.contains("66%")); // ~66% success rate
}

#[test]
fn test_tool_stats_to_json() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(false, Duration::from_millis(50));

    let json = stats.to_json();

    assert_eq!(json["total"], 2);
    assert_eq!(json["successes"], 1);
    assert_eq!(json["failures"], 1);
    assert_eq!(json["total_duration_ms"], 150);
    assert_eq!(json["avg_duration_ms"], 75);
    assert!((json["success_rate"].as_f64().unwrap() - 0.5).abs() < 0.01);
}

// ==================== ToolHistory analysis method tests ====================

fn record_test_execution(
    history: &mut ToolHistory,
    id: &str,
    tool_name: &str,
    success: bool,
    duration: Duration,
) {
    history.start(id, tool_name, json!({}));
    history.in_progress.insert(
        id.to_string(),
        Instant::now().checked_sub(duration).unwrap(),
    );

    if success {
        history.complete(id, "ok".to_string());
    } else {
        history.fail(id, "error".to_string());
    }
}

fn create_test_history() -> ToolHistory {
    let mut history = ToolHistory::new(100);

    // read: 5 calls, 4 success, avg 100ms
    for i in 0..5 {
        let id = format!("read-{}", i);
        record_test_execution(&mut history, &id, "read", i < 4, Duration::from_millis(100));
    }

    // write: 3 calls, 2 success, avg 200ms
    for i in 0..3 {
        let id = format!("write-{}", i);
        record_test_execution(
            &mut history,
            &id,
            "write",
            i < 2,
            Duration::from_millis(200),
        );
    }

    // bash: 2 calls, 0 success, avg 300ms
    for i in 0..2 {
        let id = format!("bash-{}", i);
        record_test_execution(&mut history, &id, "bash", false, Duration::from_millis(300));
    }

    history
}

#[test]
fn test_history_most_used_tools() {
    let history = create_test_history();

    let most_used = history.most_used_tools(10);
    assert_eq!(most_used.len(), 3);

    // read should be first (5 calls)
    assert_eq!(most_used[0].0, "read");
    assert_eq!(most_used[0].1.total, 5);

    // write should be second (3 calls)
    assert_eq!(most_used[1].0, "write");
    assert_eq!(most_used[1].1.total, 3);

    // bash should be third (2 calls)
    assert_eq!(most_used[2].0, "bash");
    assert_eq!(most_used[2].1.total, 2);
}

#[test]
fn test_history_most_used_tools_limit() {
    let history = create_test_history();

    let most_used = history.most_used_tools(2);
    assert_eq!(most_used.len(), 2);
    assert_eq!(most_used[0].0, "read");
    assert_eq!(most_used[1].0, "write");
}

#[test]
fn test_history_slowest_tools() {
    let history = create_test_history();

    let slowest = history.slowest_tools(10);
    assert_eq!(slowest.len(), 3);

    // bash should be slowest (300ms avg per call)
    assert_eq!(slowest[0].0, "bash");

    // write should be second (200ms avg per call)
    assert_eq!(slowest[1].0, "write");

    // read should be fastest (100ms avg per call)
    assert_eq!(slowest[2].0, "read");
}

#[test]
fn test_history_fastest_tools() {
    let history = create_test_history();

    let fastest = history.fastest_tools(10);
    assert_eq!(fastest.len(), 3);

    // read should be fastest
    assert_eq!(fastest[0].0, "read");

    // write should be second
    assert_eq!(fastest[1].0, "write");

    // bash should be slowest
    assert_eq!(fastest[2].0, "bash");
}

#[test]
fn test_history_speed_rankings_are_deterministic_on_ties() {
    let mut history = ToolHistory::new(10);

    let mut beta = ToolStats::default();
    beta.record(true, Duration::from_millis(100));
    beta.record(true, Duration::from_millis(100));

    let mut omega = ToolStats::default();
    omega.record(true, Duration::from_millis(100));

    let mut alpha = ToolStats::default();
    alpha.record(true, Duration::from_millis(100));

    history.stats.insert("beta".to_string(), beta);
    history.stats.insert("omega".to_string(), omega);
    history.stats.insert("alpha".to_string(), alpha);

    let slowest = history.slowest_tools(10);
    assert_eq!(slowest.len(), 3);
    assert_eq!(slowest[0].0, "beta");
    assert_eq!(slowest[1].0, "alpha");
    assert_eq!(slowest[2].0, "omega");

    let fastest = history.fastest_tools(10);
    assert_eq!(fastest.len(), 3);
    assert_eq!(fastest[0].0, "alpha");
    assert_eq!(fastest[1].0, "omega");
    assert_eq!(fastest[2].0, "beta");
}

#[test]
fn test_history_most_failed_tools() {
    let history = create_test_history();

    let most_failed = history.most_failed_tools(10);
    assert_eq!(most_failed.len(), 3);

    // bash has 2 failures
    assert_eq!(most_failed[0].0, "bash");
    assert_eq!(most_failed[0].1.failures, 2);

    // read and write each have 1 failure
    assert!(most_failed[1].1.failures == 1);
    assert!(most_failed[2].1.failures == 1);
}

#[test]
fn test_history_highest_failure_rate() {
    let history = create_test_history();

    // bash has 100% failure rate, write has 33%, read has 20%
    let highest = history.highest_failure_rate(10, 1);
    assert_eq!(highest.len(), 3);

    // bash should be first (100% failure)
    assert_eq!(highest[0].0, "bash");
    assert!((highest[0].1.failure_rate() - 1.0).abs() < 0.01);
}

#[test]
fn test_history_highest_failure_rate_min_calls() {
    let history = create_test_history();

    // With min_calls=3, bash (2 calls) should be excluded
    let highest = history.highest_failure_rate(10, 3);
    assert_eq!(highest.len(), 2);

    // Only read and write should be included
    let names: Vec<_> = highest.iter().map(|(n, _)| *n).collect();
    assert!(!names.contains(&"bash"));
}

#[test]
fn test_history_total_execution_time() {
    let history = create_test_history();

    let total = history.total_execution_time();
    // Should have some time recorded
    assert!(total.as_millis() > 0);

    let total_ms = history.total_execution_time_ms();
    assert_eq!(total_ms, total.as_millis() as u64);
}

#[test]
fn test_history_stats_json() {
    let history = create_test_history();

    let json = history.stats_json();

    assert!(json.get("global").is_some());
    assert!(json.get("by_tool").is_some());
    assert_eq!(json["total_executions"], 10);
    assert_eq!(json["in_progress"], 0);
    assert_eq!(json["tools_used"], 3);

    let by_tool = json["by_tool"].as_object().unwrap();
    assert!(by_tool.contains_key("read"));
    assert!(by_tool.contains_key("write"));
    assert!(by_tool.contains_key("bash"));
}

#[test]
fn test_history_stats_json_global() {
    let history = create_test_history();

    let json = history.stats_json();
    let global = &json["global"];

    assert_eq!(global["total"], 10);
    assert_eq!(global["successes"], 6);
    assert_eq!(global["failures"], 4);
}

#[test]
fn test_history_detailed_summary() {
    let history = create_test_history();

    let summary = history.detailed_summary();

    // Check header
    assert!(summary.contains("Tool Execution Statistics"));

    // Check total
    assert!(summary.contains("10 executions"));

    // Check success rate
    assert!(summary.contains("60.0%")); // 6/10 = 60%

    // Check most used tools section
    assert!(summary.contains("Most Used Tools"));
    assert!(summary.contains("read"));
    assert!(summary.contains("write"));

    // Check slowest tools section
    assert!(summary.contains("Slowest Tools"));
    assert!(summary.contains("bash"));

    // Check most failed tools section
    assert!(summary.contains("Most Failed Tools"));
}

#[test]
fn test_history_detailed_summary_empty() {
    let history = ToolHistory::new(100);

    let summary = history.detailed_summary();

    assert!(summary.contains("Tool Execution Statistics"));
    assert!(summary.contains("0 executions"));
    // Should not have tool sections when empty
    assert!(!summary.contains("Most Used Tools"));
}

#[test]
fn test_history_analysis_empty() {
    let history = ToolHistory::new(100);

    assert!(history.most_used_tools(10).is_empty());
    assert!(history.slowest_tools(10).is_empty());
    assert!(history.fastest_tools(10).is_empty());
    assert!(history.most_failed_tools(10).is_empty());
    assert!(history.highest_failure_rate(10, 1).is_empty());
    assert_eq!(history.total_execution_time_ms(), 0);
}

// ==================== Advanced ToolStats tests ====================

#[test]
fn test_tool_stats_min_max_duration() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(50));
    stats.record(true, Duration::from_millis(200));
    stats.record(true, Duration::from_millis(75));

    assert_eq!(stats.min_duration_ms(), Some(50));
    assert_eq!(stats.max_duration_ms(), Some(200));
    assert_eq!(stats.duration_range_ms(), Some(150));
}

#[test]
fn test_tool_stats_min_max_single_record() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));

    assert_eq!(stats.min_duration_ms(), Some(100));
    assert_eq!(stats.max_duration_ms(), Some(100));
    assert_eq!(stats.duration_range_ms(), Some(0));
}

#[test]
fn test_tool_stats_percentile() {
    let mut stats = ToolStats::default();
    // Add 10 durations: 10, 20, 30, ..., 100ms
    for i in 1..=10 {
        stats.record(true, Duration::from_millis(i * 10));
    }

    // P50 should be around 50-60ms
    let p50 = stats.percentile_ms(50).unwrap();
    assert!((50..=60).contains(&p50));

    // P90 should be around 90-100ms
    let p90 = stats.percentile_ms(90).unwrap();
    assert!((90..=100).contains(&p90));

    // P0 should be min
    let p0 = stats.percentile_ms(0).unwrap();
    assert_eq!(p0, 10);

    // P100 should be max
    let p100 = stats.percentile_ms(100).unwrap();
    assert_eq!(p100, 100);
}

#[test]
fn test_tool_stats_percentile_empty() {
    let stats = ToolStats::default();
    assert!(stats.percentile(50).is_none());
    assert!(stats.percentile_ms(50).is_none());
}

#[test]
fn test_tool_stats_std_deviation() {
    let mut stats = ToolStats::default();
    // All same duration = 0 std dev
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(100));

    let std = stats.std_deviation_ms().unwrap();
    assert_eq!(std, 0);
}

#[test]
fn test_tool_stats_std_deviation_varied() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(10));
    stats.record(true, Duration::from_millis(20));
    stats.record(true, Duration::from_millis(30));

    // std dev should be non-zero
    let std = stats.std_deviation_ms().unwrap();
    assert!(std > 0);
}

#[test]
fn test_tool_stats_std_deviation_single() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));

    // Need at least 2 samples for std dev
    assert!(stats.std_deviation().is_none());
}

#[test]
fn test_tool_stats_high_variance() {
    let mut stats = ToolStats::default();
    // High variance: 10ms and 1000ms
    stats.record(true, Duration::from_millis(10));
    stats.record(true, Duration::from_secs(1));

    assert!(stats.has_high_variance(0.5));
}

#[test]
fn test_tool_stats_low_variance() {
    let mut stats = ToolStats::default();
    // Low variance: all around 100ms
    stats.record(true, Duration::from_millis(98));
    stats.record(true, Duration::from_millis(100));
    stats.record(true, Duration::from_millis(102));

    assert!(!stats.has_high_variance(1.0));
}

#[test]
fn test_tool_stats_throughput() {
    let mut stats = ToolStats::default();
    // 10 executions taking 100ms each = 1 second total = 10 ops/sec
    for _ in 0..10 {
        stats.record(true, Duration::from_millis(100));
    }

    let throughput = stats.throughput();
    assert!((throughput - 10.0).abs() < 0.1);
}

#[test]
fn test_tool_stats_throughput_empty() {
    let stats = ToolStats::default();
    assert_eq!(stats.throughput(), 0.0);
}

#[test]
fn test_tool_stats_relative_performance() {
    let mut fast = ToolStats::default();
    fast.record(true, Duration::from_millis(50));

    let mut slow = ToolStats::default();
    slow.record(true, Duration::from_millis(100));

    // fast is 2x faster than slow
    let perf = fast.relative_performance(&slow).unwrap();
    assert!((perf - 2.0).abs() < 0.01);

    // slow is 0.5x as fast as fast
    let perf2 = slow.relative_performance(&fast).unwrap();
    assert!((perf2 - 0.5).abs() < 0.01);
}

#[test]
fn test_tool_stats_health_score() {
    let mut healthy = ToolStats::default();
    for _ in 0..10 {
        healthy.record(true, Duration::from_millis(100));
    }
    assert!(healthy.health_score() > 0.9);
    assert!(healthy.is_healthy(0.9));

    let mut unhealthy = ToolStats::default();
    for _ in 0..5 {
        unhealthy.record(true, Duration::from_millis(100));
    }
    for _ in 0..5 {
        unhealthy.record(false, Duration::from_millis(100));
    }
    assert!(unhealthy.health_score() < 0.6);
    assert!(!unhealthy.is_healthy(0.9));
}

#[test]
fn test_tool_stats_to_detailed_json() {
    let mut stats = ToolStats::default();
    for i in 1..=10 {
        stats.record(true, Duration::from_millis(i * 10));
    }

    let json = stats.to_detailed_json();

    assert!(json.get("total").is_some());
    assert!(json.get("min_duration_ms").is_some());
    assert!(json.get("max_duration_ms").is_some());
    assert!(json.get("p50_duration_ms").is_some());
    assert!(json.get("p90_duration_ms").is_some());
    assert!(json.get("failure_rate").is_some());
}

#[test]
fn test_tool_stats_merge_with_min_max() {
    let mut stats1 = ToolStats::default();
    stats1.record(true, Duration::from_millis(100));
    stats1.record(true, Duration::from_millis(200));

    let mut stats2 = ToolStats::default();
    stats2.record(true, Duration::from_millis(50));
    stats2.record(true, Duration::from_millis(150));

    stats1.merge(&stats2);

    // Min should be 50, max should be 200
    assert_eq!(stats1.min_duration_ms(), Some(50));
    assert_eq!(stats1.max_duration_ms(), Some(200));
    assert_eq!(stats1.total, 4);
}

#[test]
fn test_tool_stats_with_max_durations() {
    let mut stats = ToolStats::with_max_durations(3);

    for i in 0..10 {
        stats.record(true, Duration::from_millis(i * 10));
    }

    // Should only keep first 3 durations for percentile calculation
    assert_eq!(stats.tracked_durations(), 3);
    // But total count should still be accurate
    assert_eq!(stats.total, 10);
}

// ==================== Advanced HistoryFilter tests ====================

#[test]
fn test_filter_max_duration() {
    let mut history = ToolHistory::new(100);

    history.start("fast", "read", json!({}));
    std::thread::sleep(Duration::from_millis(1));
    history.complete("fast", "ok".to_string());

    history.start("slow", "read", json!({}));
    std::thread::sleep(Duration::from_millis(10));
    history.complete("slow", "ok".to_string());

    // Filter to only fast executions
    let filter = HistoryFilter::default().max_duration(Duration::from_millis(5));
    let results = history.search(&filter);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "fast");
}

#[test]
fn test_filter_duration_between() {
    let mut history = ToolHistory::new(100);

    for i in 0..5 {
        let id = format!("{}", i);
        history.start(&id, "test", json!({}));
        std::thread::sleep(Duration::from_millis((i + 1) * 2));
        history.complete(&id, "ok".to_string());
    }

    // Filter to middle range
    let filter = HistoryFilter::default()
        .duration_between(Duration::from_millis(3), Duration::from_millis(7));
    let results = history.search(&filter);

    // Should match executions with ~4ms and ~6ms duration
    assert!(!results.is_empty());
}

#[test]
fn test_filter_with_exit_code() {
    let mut history = ToolHistory::new(100);

    history.start("1", "bash", json!({}));
    history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

    history.start("2", "bash", json!({}));
    history.complete_with_details("2", "error".to_string(), Some(json!({"exit_code": 1})));

    history.start("3", "bash", json!({}));
    history.complete_with_details("3", "ok".to_string(), Some(json!({"exit_code": 0})));

    let filter = HistoryFilter::default().with_exit_code(0);
    let results = history.search(&filter);
    assert_eq!(results.len(), 2);

    let filter = HistoryFilter::default().with_exit_code(1);
    let results = history.search(&filter);
    assert_eq!(results.len(), 1);
}

#[test]
fn test_filter_timed_out() {
    let mut history = ToolHistory::new(100);

    history.start("1", "bash", json!({}));
    history.complete_with_details("1", "ok".to_string(), Some(json!({"timed_out": false})));

    history.start("2", "bash", json!({}));
    history.fail_with_details("2", "timeout".to_string(), Some(json!({"timed_out": true})));

    let timed_out = history.timed_out_executions();
    assert_eq!(timed_out.len(), 1);
    assert_eq!(timed_out[0].id, "2");
}

#[test]
fn test_filter_has_details() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({}));
    history.complete("1", "ok".to_string());

    history.start("2", "read", json!({}));
    history.complete_with_details("2", "ok".to_string(), Some(json!({"bytes": 100})));

    let with_details = history.executions_with_details();
    assert_eq!(with_details.len(), 1);
    assert_eq!(with_details[0].id, "2");
}

#[test]
fn test_filter_has_detail_field() {
    let mut history = ToolHistory::new(100);

    history.start("1", "bash", json!({}));
    history.complete_with_details(
        "1",
        "ok".to_string(),
        Some(json!({"exit_code": 0, "command": "ls"})),
    );

    history.start("2", "read", json!({}));
    history.complete_with_details("2", "ok".to_string(), Some(json!({"bytes_read": 100})));

    let filter = HistoryFilter::default().with_detail_field("command");
    let results = history.search(&filter);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "1");
}

#[test]
fn test_filter_time_range() {
    let mut history = ToolHistory::new(100);
    let _before_all = SystemTime::now();

    std::thread::sleep(Duration::from_millis(50));

    history.start("1", "read", json!({}));
    history.complete("1", "ok".to_string());

    // Sleep enough to ensure timestamp difference is measurable
    std::thread::sleep(Duration::from_millis(50));
    let after_first = SystemTime::now();
    std::thread::sleep(Duration::from_millis(50));

    history.start("2", "read", json!({}));
    history.complete("2", "ok".to_string());

    // Filter to only after first
    let filter = HistoryFilter::default().after(after_first);
    let results = history.search(&filter);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "2");

    // Filter to before first completed
    let filter = HistoryFilter::default().before(after_first);
    let results = history.search(&filter);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "1");
}

#[test]
fn test_filter_within_last() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({}));
    history.complete("1", "ok".to_string());

    // This should match since we just added it
    let filter = HistoryFilter::default().within_last(Duration::from_secs(10));
    let results = history.search(&filter);
    assert_eq!(results.len(), 1);
}

// ==================== Filtered Stats tests ====================

#[test]
fn test_filtered_stats() {
    let history = create_test_history();

    // Get stats for only read tool
    let filter = HistoryFilter::tool("read");
    let stats = history.filtered_stats(&filter);

    assert_eq!(stats.total, 5);
    assert_eq!(stats.successes, 4);
    assert_eq!(stats.failures, 1);
}

#[test]
fn test_filtered_stats_by_tool() {
    let history = create_test_history();

    // Get stats for failures only
    let filter = HistoryFilter::failures();
    let stats_by_tool = history.filtered_stats_by_tool(&filter);

    assert!(stats_by_tool.contains_key("read"));
    assert!(stats_by_tool.contains_key("write"));
    assert!(stats_by_tool.contains_key("bash"));

    // All should have only failures
    for stats in stats_by_tool.values() {
        assert_eq!(stats.successes, 0);
    }
}

#[test]
fn test_stats_last_duration() {
    let mut history = ToolHistory::new(100);

    history.start("1", "read", json!({}));
    history.complete("1", "ok".to_string());

    std::thread::sleep(Duration::from_millis(5));

    history.start("2", "read", json!({}));
    history.complete("2", "ok".to_string());

    // Stats from last 1 second should include both
    let stats = history.stats_last(Duration::from_secs(1));
    assert_eq!(stats.total, 2);
}

#[test]
fn test_stats_slow_executions() {
    let mut history = ToolHistory::new(100);

    // Fast execution
    history.start("fast", "read", json!({}));
    std::thread::sleep(Duration::from_millis(1));
    history.complete("fast", "ok".to_string());

    // Slow execution
    history.start("slow", "read", json!({}));
    std::thread::sleep(Duration::from_millis(10));
    history.complete("slow", "ok".to_string());

    let stats = history.stats_slow_executions(Duration::from_millis(5));
    assert_eq!(stats.total, 1);
}

#[test]
fn test_executions_with_exit_code() {
    let mut history = ToolHistory::new(100);

    history.start("1", "bash", json!({}));
    history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

    history.start("2", "bash", json!({}));
    history.fail_with_details("2", "err".to_string(), Some(json!({"exit_code": 127})));

    let execs = history.executions_with_exit_code(127);
    assert_eq!(execs.len(), 1);
    assert_eq!(execs[0].id, "2");
}

// ==================== Tool Health tests ====================

#[test]
fn test_tool_health_report() {
    let history = create_test_history();

    let report = history.tool_health_report();
    assert_eq!(report.len(), 3);

    // Find bash - should be unhealthy (100% failure)
    let bash = report.iter().find(|(name, _, _)| *name == "bash");
    assert!(bash.is_some());
    let (_, score, healthy) = bash.unwrap();
    assert!(*score < 0.5);
    assert!(!healthy);
}

#[test]
fn test_unhealthy_tools() {
    let history = create_test_history();

    // With 90% threshold, bash (0% success) should be unhealthy
    let unhealthy = history.unhealthy_tools(0.9);
    assert!(!unhealthy.is_empty());

    let bash = unhealthy.iter().find(|(name, _)| *name == "bash");
    assert!(bash.is_some());
}

#[test]
fn test_compare_tools() {
    let history = create_test_history();

    // Compare read and bash (bash takes longer due to longer sleep)
    let perf = history.compare_tools("read", "bash");
    assert!(perf.is_some());
    // read is faster, so relative performance > 1
    assert!(perf.unwrap() > 1.0);
}

#[test]
fn test_compare_tools_missing() {
    let history = create_test_history();

    let perf = history.compare_tools("read", "nonexistent");
    assert!(perf.is_none());
}

// ==================== Aggregation tests ====================

#[test]
fn test_aggregate_stats() {
    let history = create_test_history();

    // Aggregate read and write stats
    let aggregated = history.aggregate_stats(&["read", "write"]);

    assert_eq!(aggregated.total, 8); // 5 + 3
    assert_eq!(aggregated.successes, 6); // 4 + 2
    assert_eq!(aggregated.failures, 2); // 1 + 1
}

#[test]
fn test_aggregate_stats_partial() {
    let history = create_test_history();

    // One tool exists, one doesn't
    let aggregated = history.aggregate_stats(&["read", "nonexistent"]);

    assert_eq!(aggregated.total, 5); // Only read's 5
}

#[test]
fn test_throughput() {
    let history = create_test_history();

    let throughput = history.throughput();
    // Should have positive throughput since we have executions
    assert!(throughput > 0.0);
}

#[test]
fn test_detailed_stats_json() {
    let history = create_test_history();

    let json = history.detailed_stats_json();

    assert!(json.get("global").is_some());
    assert!(json.get("by_tool").is_some());
    assert!(json.get("throughput_per_sec").is_some());

    let global = &json["global"];
    assert!(global.get("min_duration_ms").is_some());
    assert!(global.get("max_duration_ms").is_some());
}

// ==================== Edge case and stress tests ====================

#[test]
fn test_large_history() {
    let mut history = ToolHistory::new(10_000);

    // Add many executions
    for i in 0..1000 {
        let id = format!("{}", i);
        let tool = if i % 3 == 0 {
            "read"
        } else if i % 3 == 1 {
            "write"
        } else {
            "bash"
        };
        history.start(&id, tool, json!({}));
        if i % 5 == 0 {
            history.fail(&id, "error".to_string());
        } else {
            history.complete(&id, "ok".to_string());
        }
    }

    assert_eq!(history.len(), 1000);

    // Stats should be accurate
    let global = history.global_stats();
    assert_eq!(global.total, 1000);
    assert_eq!(global.failures, 200); // Every 5th

    // Rankings should work
    let most_used = history.most_used_tools(10);
    assert!(!most_used.is_empty());
}

#[test]
fn test_concurrent_tool_names() {
    let mut history = ToolHistory::new(100);

    // Same tool name, different outcomes
    for i in 0..10 {
        let id = format!("{}", i);
        history.start(&id, "read", json!({}));
        if i < 5 {
            history.complete(&id, "ok".to_string());
        } else {
            history.fail(&id, "error".to_string());
        }
    }

    let stats = history.tool_stats("read").unwrap();
    assert_eq!(stats.total, 10);
    assert_eq!(stats.successes, 5);
    assert_eq!(stats.failures, 5);
    assert!((stats.success_rate() - 0.5).abs() < 0.01);
}

#[test]
fn test_stats_after_clear() {
    let mut history = create_test_history();

    // Verify we have data
    assert!(!history.is_empty());
    assert!(history.global_stats().total > 0);

    // Clear
    history.clear();

    // Everything should be empty/zero
    assert_eq!(history.len(), 0);
    assert_eq!(history.global_stats().total, 0);
    assert!(history.all_stats().is_empty());
    assert!(history.most_used_tools(10).is_empty());
}

#[test]
fn test_filter_combination() {
    let mut history = ToolHistory::new(100);

    // Add varied executions
    history.start("1", "bash", json!({}));
    history.complete_with_details("1", "ok".to_string(), Some(json!({"exit_code": 0})));

    history.start("2", "bash", json!({}));
    history.fail_with_details("2", "err".to_string(), Some(json!({"exit_code": 1})));

    history.start("3", "read", json!({}));
    history.complete_with_details("3", "ok".to_string(), Some(json!({"bytes": 100})));

    // Combine multiple filters: bash + failure + exit code 1
    let filter = HistoryFilter::tool("bash").with_exit_code(1);
    let results = history.search(&filter);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "2");
}

#[test]
fn test_percentile_single_value() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));

    // All percentiles should return the same value
    assert_eq!(stats.percentile_ms(0), Some(100));
    assert_eq!(stats.percentile_ms(50), Some(100));
    assert_eq!(stats.percentile_ms(100), Some(100));
}

#[test]
fn test_stats_serialization_round_trip() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::from_millis(100));
    stats.record(false, Duration::from_millis(50));

    let json = serde_json::to_string(&stats).unwrap();
    let deserialized: ToolStats = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.total, 2);
    assert_eq!(deserialized.successes, 1);
    assert_eq!(deserialized.failures, 1);
    // Note: durations vector is not serialized (skip), so percentiles won't work after deserialize
}

#[test]
fn test_zero_duration_handling() {
    let mut stats = ToolStats::default();
    stats.record(true, Duration::ZERO);
    stats.record(true, Duration::ZERO);

    assert_eq!(stats.avg_duration_ms(), 0);
    assert_eq!(stats.throughput(), 0.0); // Avoid divide by zero
    assert!(!stats.has_high_variance(1.0));
}

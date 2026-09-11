//! Opt-in measurements of the persisted-session resume path.
use maestro_session::{SessionManager, SessionReader, model_history};
use std::hint::black_box;
use std::io::Write;
use std::time::Instant;

#[test]
#[ignore = "measures cumulative continuation replay; run in a dedicated process"]
fn resume_scaling_probe() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    writeln!(
        file,
        "{}",
        serde_json::json!({
            "type":"session", "version":2, "id":"resume-perf",
            "timestamp":"2026-09-10T00:00:00Z", "cwd":"/tmp", "model":"gpt-4o"
        })
    )
    .unwrap();
    let mut requests = Vec::new();
    for turn in 0..2000 {
        let request = format!("request-{turn}: {}", "retained evidence 🦀 ".repeat(24));
        requests.push(request.clone());
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"message", "timestamp":"2026-09-10T00:00:00Z",
                "message":{"role":"user", "content":request}
            })
        )
        .unwrap();
        if turn % 25 == 24 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type":"compaction", "timestamp":"2026-09-10T00:00:00Z",
                    "summary":"earlier work", "tokensBefore":5000,
                    "firstKeptEntryIndex":if turn == 24 { 20 } else { 25 },
                    "continuation":maestro_context::ContinuationRecord {
                        user_requests:requests.clone(), ..Default::default()
                    }
                })
            )
            .unwrap();
        }
    }
    file.flush().unwrap();
    drop(file);
    let bytes = std::fs::metadata(&path).unwrap().len();
    // Alternate modes in separate processes with the same binary and fixture.
    // The legacy path retained an unlocked parse while preparing a second one.
    let legacy = std::env::var("MAESTRO_RESUME_PERF_LEGACY").as_deref() == Ok("1");
    let mut manager = SessionManager::with_sessions_dir("/tmp", dir.path());
    let started = Instant::now();
    let selected = manager.find_session("resume-perf").unwrap();
    let selection_ms = started.elapsed().as_secs_f64() * 1000.;
    let started = Instant::now();
    let initial = legacy.then(|| SessionReader::read_file(&selected.path).unwrap());
    let read_ms = started.elapsed().as_secs_f64() * 1000.;
    let started = Instant::now();
    let prepared = manager.prepare_session_adoption(&selected.path).unwrap();
    let prepare_ms = started.elapsed().as_secs_f64() * 1000.;
    let session = prepared.session();
    assert_eq!(session.stats.user_messages, 2000);
    assert_eq!(session.compactions.len(), 80);
    assert_eq!(
        session
            .compactions
            .last()
            .unwrap()
            .continuation
            .as_ref()
            .unwrap()
            .user_requests,
        requests
    );
    let started = Instant::now();
    let history = black_box(model_history(session));
    let history_ms = started.elapsed().as_secs_f64() * 1000.;
    assert_eq!(history.len(), 6);
    assert!(
        history
            .last()
            .unwrap()
            .content
            .as_text()
            .unwrap()
            .starts_with("request-1999:")
    );
    if let Some(initial) = initial.as_ref() {
        assert_eq!(initial.stats.user_messages, session.stats.user_messages);
    }
    black_box(&initial);
    manager.adopt_prepared_session(prepared);
    assert_eq!(manager.current_session_id(), Some("resume-perf"));
    eprintln!(
        "RESUME_PERF {}",
        serde_json::json!({
            "legacy":legacy, "selection_ms":selection_ms, "read_ms":read_ms, "prepare_ms":prepare_ms, "history_ms":history_ms,
            "resume_ms":selection_ms + read_ms + prepare_ms + history_ms,
            "bytes":bytes, "correct":true, "turns":2000
        })
    );
}

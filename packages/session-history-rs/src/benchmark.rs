//! Reproducible CPU/disk baseline. Run explicitly; no timing assertions.
use super::*;

#[test]
#[ignore = "manual uploader benchmark; prints aggregates only"]
fn uploader_benchmark() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input.jsonl");
    let supplied = std::env::var_os("UPLOADER_BENCH_INPUT");
    if let Some(source) = supplied {
        fs::copy(source, &input).unwrap();
    } else {
        let count: usize = std::env::var("UPLOADER_BENCH_ENTRIES")
            .unwrap_or_else(|_| "500".into())
            .parse()
            .unwrap();
        let mut file = File::create(&input).unwrap();
        writeln!(file, "{}", json!({"type":"session","id":"bench","timestamp":"2026-09-08T08:00:00Z","cwd":"/workspace/mono","subject":"Uploader benchmark"})).unwrap();
        for index in 0..count {
            writeln!(file, "{}", json!({"type":"message","id":format!("entry-{index}"),"message":{"role":"assistant","content":[{"type":"text","text":"Inspect the workspace and verify the current implementation. ".repeat(16)},{"type":"toolCall","id":format!("call-{index}"),"name":"bash","arguments":{"command":"cargo test --locked","description":"Run regression checks"}}],"model":"example/model-a","provider":"example","usage":{"input":2048,"output":512}}})).unwrap();
        }
    }
    let args = || PrepareTranscriptArgs {
        input: input.clone(),
        agent: TranscriptAgent::Maestro,
        organization: "org-bench".into(),
        workspace: "ws-bench".into(),
        session_id: Some("bench".into()),
        source_session_id: "bench".into(),
        repository_url: None,
        working_directory: Some(temp.path().display().to_string()),
        branch: None,
        head_sha: None,
        title: None,
        completeness: TranscriptCompletenessArg::InProgress,
    };
    let start = Instant::now();
    let result = prepare_transcript(args(), Some(temp.path())).unwrap();
    let cold = start.elapsed();
    let start = Instant::now();
    prepare_transcript(args(), Some(temp.path())).unwrap();
    let resume = start.elapsed();
    let manifest_path = PathBuf::from(result["manifest"].as_str().unwrap());
    let manifest: TranscriptManifest =
        serde_json::from_reader(File::open(&manifest_path).unwrap()).unwrap();
    let start = Instant::now();
    let mut wire = 0;
    for segment in &manifest.segments {
        wire += upload_request(&manifest, segment, manifest_path.parent().unwrap())
            .unwrap()
            .encode_to_vec()
            .len();
    }
    let spool: u64 = manifest
        .segments
        .iter()
        .map(|s| {
            fs::metadata(manifest_path.parent().unwrap().join(&s.path))
                .unwrap()
                .len()
        })
        .sum();
    eprintln!(
        "BENCH {}",
        json!({"input_bytes":fs::metadata(input).unwrap().len(),"entries":result["entries"],"segments":manifest.segments.len(),"prepare_ms":cold.as_secs_f64()*1000.,"resume_ms":resume.as_secs_f64()*1000.,"encode_ms":start.elapsed().as_secs_f64()*1000.,"canonical_bytes":result["size_bytes"],"spool_bytes":spool,"protobuf_bytes":wire,"canonical_sha256":manifest.segments.iter().map(|segment| &segment.sha256).collect::<Vec<_>>()})
    );
}

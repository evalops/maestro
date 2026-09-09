use super::*;
use std::io::{Read, Write};

fn capture(input: &Path, root: &Path) -> Result<Value, TranscriptError> {
    capture_with_completeness(input, root, TranscriptCompletenessArg::InProgress)
}

fn capture_with_completeness(
    input: &Path,
    root: &Path,
    completeness: TranscriptCompletenessArg,
) -> Result<Value, TranscriptError> {
    prepare_transcript(
        PrepareTranscriptArgs {
            input: input.into(),
            agent: TranscriptAgent::Maestro,
            source_session_id: "maestro-quality-fixture".into(),
            session_id: Some("capture".into()),
            organization: "org-test".into(),
            workspace: "ws-test".into(),
            repository_url: None,
            working_directory: Some(root.display().to_string()),
            branch: Some("main".into()),
            head_sha: None,
            title: None,
            completeness,
        },
        Some(root),
    )
}
fn manifest(result: &Value) -> (PathBuf, TranscriptManifest) {
    let path = PathBuf::from(result["manifest"].as_str().unwrap());
    let value = serde_json::from_reader(File::open(&path).unwrap()).unwrap();
    (path, value)
}

#[test]
fn verified_cursor_preserves_source_lines_metadata_and_replay_after_append() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, include_bytes!("../tests/fixtures/maestro.jsonl")).unwrap();
    let (path, first) = manifest(&capture(&input, root.path()).unwrap());
    let original = upload_request(&first, &first.segments[0], path.parent().unwrap())
        .unwrap()
        .encode_to_vec();
    assert_eq!(capture(&input, root.path()).unwrap()["reused_entries"], 5);
    writeln!(
        OpenOptions::new().append(true).open(&input).unwrap(),
        "\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"continue\"}}}}"
    )
    .unwrap();
    let (_, after) = manifest(&capture(&input, root.path()).unwrap());
    assert_eq!(
        upload_request(&after, &after.segments[0], path.parent().unwrap())
            .unwrap()
            .encode_to_vec(),
        original
    );
    let tail = upload_request(&after, &after.segments[1], path.parent().unwrap()).unwrap();
    assert_eq!(tail.first_entry_index, 5);
    assert_eq!(
        serde_json::from_slice::<Value>(&tail.content).unwrap()["source_index"],
        6
    );
    assert_eq!(
        tail.session.as_ref().unwrap().started_at,
        first.segments[0]
            .metadata
            .as_ref()
            .unwrap()
            .started_at
            .as_deref()
            .and_then(proto_timestamp)
    );
    assert_eq!(tail.session.unwrap().title, "Check the workspace");
    let mut legacy = after.clone();
    legacy.source_checkpoint = None;
    write_private_json(&path, &legacy).unwrap();
    let (_, reparsed) = manifest(&capture(&input, root.path()).unwrap());
    for (a, b) in after.segments.iter().zip(&reparsed.segments) {
        assert_eq!(
            upload_request(&after, a, path.parent().unwrap())
                .unwrap()
                .encode_to_vec(),
            upload_request(&reparsed, b, path.parent().unwrap())
                .unwrap()
                .encode_to_vec()
        );
    }
}

#[test]
fn cursor_invalidates_on_policy_change_and_verifies_spool_even_when_source_is_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"sensitive-value\"}\n").unwrap();
    let (path, saved) = manifest(&capture(&input, root.path()).unwrap());
    fs::create_dir(root.path().join(".evalops")).unwrap();
    fs::write(
        root.path().join(".evalops/redaction-patterns"),
        "sensitive-value",
    )
    .unwrap();
    assert!(
        capture(&input, root.path())
            .unwrap_err()
            .to_string()
            .contains("prefix changed")
    );
    fs::remove_file(root.path().join(".evalops/redaction-patterns")).unwrap();
    fs::write(
        path.parent().unwrap().join(&saved.segments[0].path),
        b"corrupt",
    )
    .unwrap();
    assert!(capture(&input, root.path()).is_err());
}

#[test]
fn unterminated_last_record_is_reparsed_and_same_size_source_edits_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"one\"}").unwrap();
    let (_, saved) = manifest(&capture(&input, root.path()).unwrap());
    assert!(saved.source_checkpoint.is_none());
    fs::write(&input, "{\"text\":\"one\"}\n{\"text\":\"new\"}\n").unwrap();
    assert_eq!(capture(&input, root.path()).unwrap()["entries"], 2);
    fs::write(&input, "{\"text\":\"two\"}\n{\"text\":\"new\"}\n").unwrap();
    assert!(
        capture(&input, root.path())
            .unwrap_err()
            .to_string()
            .contains("prefix changed")
    );
}

#[test]
fn hook_capture_ignores_an_active_partial_tail_but_rejects_completed_malformed_json() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"complete\"}\n{\"text\":\"partial\"").unwrap();
    let args = || PrepareTranscriptArgs {
        input: input.clone(),
        agent: TranscriptAgent::Maestro,
        source_session_id: "maestro-partial-tail".to_string(),
        session_id: Some("session-partial-tail".to_string()),
        organization: "org-test".to_string(),
        workspace: "ws-test".to_string(),
        repository_url: None,
        working_directory: Some(root.path().display().to_string()),
        branch: None,
        head_sha: None,
        title: None,
        completeness: TranscriptCompletenessArg::InProgress,
    };

    let first = prepare_transcript_with_options(args(), Some(root.path()), true).unwrap();
    assert_eq!(first["entries"], 1);
    let (path, saved) = manifest(&first);
    assert!(saved.source_checkpoint.is_some());
    let content = read_segment(&saved.segments[0], path.parent().unwrap()).unwrap();
    assert!(!String::from_utf8(content).unwrap().contains("partial"));

    let error = prepare_transcript(args(), Some(root.path()))
        .expect_err("a completed malformed record must not be silently discarded");
    assert!(error.to_string().contains("not valid JSON"), "{error}");

    fs::write(&input, "{\"text\":\"complete\"}\n{\"text\":\"finished\"}\n").unwrap();
    let resumed = prepare_transcript_with_options(args(), Some(root.path()), true).unwrap();
    assert_eq!(resumed["entries"], 2);
    assert_eq!(resumed["reused_entries"], 1);
}

#[test]
fn http_upload_negotiates_gzip_and_retries_plain_during_a_rolling_upgrade() {
    for (advertise, reject_gzip, zstd_server) in [
        (false, false, false),
        (true, false, false),
        (true, true, false),
        (true, false, true),
        (true, true, true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("source.jsonl");
        fs::write(&input, "{\"text\":\"first\"}\n").unwrap();
        let (path, mut saved) = manifest(&capture(&input, root.path()).unwrap());
        let content = b"{\"text\":\"repeatable tool output\"}\n".repeat(1000);
        for index in 1..3 {
            saved.segments.push(
                write_segment(
                    path.parent().unwrap(),
                    index,
                    1 + (index - 1) * 1000,
                    index * 1000,
                    &content,
                )
                .unwrap(),
            );
        }
        write_private_json(&path, &saved).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut encodings = Vec::new();
            let mut accepted = 0;
            while accepted < 3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                let gzip = header.contains("content-encoding: gzip");
                let zstd = header.contains("content-encoding: zstd");
                encodings.push(gzip || zstd);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                if (gzip || zstd) && reject_gzip {
                    stream.write_all(b"HTTP/1.1 415 Unsupported Media Type\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    continue;
                }
                if gzip {
                    let mut decoded = Vec::new();
                    flate2::read::GzDecoder::new(body.as_slice())
                        .read_to_end(&mut decoded)
                        .unwrap();
                    body = decoded;
                }
                if zstd {
                    body = zstd::bulk::decompress(&body, 1024 * 1024).unwrap();
                }
                let request =
                    sessions_pb::RecordTranscriptSegmentRequest::decode(body.as_slice()).unwrap();
                assert_eq!(request.organization_id, "org-test");
                assert_eq!(request.workspace_id, "ws-test");
                assert_eq!(
                    request.sha256,
                    format!("{:x}", Sha256::digest(&request.content))
                );
                assert_eq!(request.segment_index, accepted);
                let response = sessions_pb::RecordTranscriptSegmentResponse {
                    segment: Some(sessions_pb::TranscriptSegment {
                        sha256: request.sha256,
                        segment_index: request.segment_index,
                        segment_id: format!("segment-{accepted}"),
                        ..Default::default()
                    }),
                    ..Default::default()
                }
                .encode_to_vec();
                let encoding = if advertise && (!reject_gzip || accepted == 0) {
                    if zstd_server {
                        "Accept-Encoding: zstd, gzip, identity\r\n"
                    } else {
                        "Accept-Encoding: gzip, identity\r\n"
                    }
                } else {
                    ""
                };
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/proto\r\n{encoding}Content-Length: {}\r\nConnection: close\r\n\r\n",response.len()).unwrap();
                stream.write_all(&response).unwrap();
                accepted += 1;
            }
            encodings
        });
        let result = push_transcript(PushTranscriptArgs {
            manifest: path.clone(),
            endpoint: endpoint.clone(),
            token: None,
        })
        .unwrap();
        assert_eq!(result["uploaded"], 3);
        assert_eq!(
            server.join().unwrap(),
            if !advertise {
                vec![false, false, false]
            } else if reject_gzip {
                vec![false, true, false, false]
            } else {
                vec![false, true, true]
            }
        );
        if advertise && !reject_gzip {
            assert!(
                result["wire_bytes"].as_u64().unwrap()
                    < result["uncompressed_bytes"].as_u64().unwrap() / 10
            );
        }
        // Receipts must avoid any subsequent network requests.
        assert_eq!(
            push_transcript(PushTranscriptArgs {
                manifest: path,
                endpoint,
                token: None
            })
            .unwrap()["already_receipted"],
            3
        );
    }
}

#[test]
fn http_upload_reuses_a_server_capability_for_a_later_push() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"first\"}\n").unwrap();
    let (path, _) = manifest(&capture(&input, root.path()).unwrap());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut encodings = Vec::new();
        for accepted in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end;
            loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                received.extend_from_slice(&buffer[..read]);
                if let Some(position) = received.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    header_end = position + 4;
                    break;
                }
            }
            let headers = String::from_utf8(received[..header_end].to_vec())
                .unwrap()
                .to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while received.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                received.extend_from_slice(&buffer[..read]);
            }
            let compressed = headers.contains("content-encoding: gzip");
            encodings.push(compressed);
            let mut body = received[header_end..header_end + content_length].to_vec();
            if compressed {
                let mut decoded = Vec::new();
                flate2::read::GzDecoder::new(body.as_slice())
                    .read_to_end(&mut decoded)
                    .unwrap();
                body = decoded;
            }
            let request =
                sessions_pb::RecordTranscriptSegmentRequest::decode(body.as_slice()).unwrap();
            assert_eq!(request.segment_index, accepted);
            let response = sessions_pb::RecordTranscriptSegmentResponse {
                segment: Some(sessions_pb::TranscriptSegment {
                    segment_index: request.segment_index,
                    sha256: request.sha256,
                    segment_id: format!("segment-{accepted}"),
                    ..Default::default()
                }),
                ..Default::default()
            }
            .encode_to_vec();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nAccept-Encoding: gzip, identity\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .unwrap();
            stream.write_all(&response).unwrap();
        }
        encodings
    });

    let first = push_transcript(PushTranscriptArgs {
        manifest: path.clone(),
        endpoint: endpoint.clone(),
        token: None,
    })
    .unwrap();
    assert_eq!(first["uploaded"], 1);

    let content = b"{\"text\":\"repeatable tool output\"}\n".repeat(1000);
    let mut saved = read_locked_manifest(&path).unwrap();
    saved
        .segments
        .push(write_segment(path.parent().unwrap(), 1, 1, 1000, &content).unwrap());
    write_private_json(&path, &saved).unwrap();
    let second = push_transcript(PushTranscriptArgs {
        manifest: path,
        endpoint,
        token: None,
    })
    .unwrap();
    assert_eq!(second["uploaded"], 1);
    assert_eq!(server.join().unwrap(), vec![false, true]);
}

#[test]
fn slow_upload_does_not_block_capture_or_overwrite_its_new_segments() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"first\"}\n").unwrap();
    let (path, _saved) = manifest(&capture(&input, root.path()).unwrap());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (received_tx, received_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
            let length: usize = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            let request =
                sessions_pb::RecordTranscriptSegmentRequest::decode(body.as_slice()).unwrap();
            assert_eq!(request.segment_index, index);
            if index == 0 {
                received_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            let response = sessions_pb::RecordTranscriptSegmentResponse {
                segment: Some(sessions_pb::TranscriptSegment {
                    sha256: request.sha256,
                    segment_index: index,
                    ..Default::default()
                }),
                ..Default::default()
            }
            .encode_to_vec();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .unwrap();
            stream.write_all(&response).unwrap();
        }
    });
    let upload_path = path.clone();
    let upload = std::thread::spawn(move || {
        push_transcript(PushTranscriptArgs {
            manifest: upload_path,
            endpoint,
            token: None,
        })
        .unwrap()
    });
    received_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    fs::write(&input, "{\"text\":\"first\"}\n{\"text\":\"second\"}\n").unwrap();
    let root_path = root.path().to_path_buf();
    let (prepared_tx, prepared_rx) = std::sync::mpsc::channel();
    let preparing =
        std::thread::spawn(move || prepared_tx.send(capture(&input, &root_path)).unwrap());
    let prepared = prepared_rx.recv_timeout(Duration::from_secs(2));
    release_tx.send(()).unwrap();
    upload.join().unwrap();
    server.join().unwrap();
    preparing.join().unwrap();
    assert!(
        prepared
            .expect("capture must finish before the server responds")
            .is_ok()
    );
    let latest = read_locked_manifest(&path).unwrap();
    assert_eq!(latest.segments.len(), 2);
    assert!(latest.segments[0].upload.is_some());
    assert!(latest.segments[1].upload.is_some());
    assert!(latest.source_checkpoint.is_some());
}

#[test]
fn first_upload_uses_current_completeness_and_freezes_it_before_an_ambiguous_retry() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"first\"}\n").unwrap();
    let (path, initial) = manifest(&capture(&input, root.path()).unwrap());
    assert!(!initial.segments[0].upload_started);
    let (_, complete) = manifest(
        &capture_with_completeness(&input, root.path(), TranscriptCompletenessArg::Complete)
            .unwrap(),
    );
    assert_eq!(complete.segments.len(), 1);
    assert_eq!(complete.segments[0].sha256, initial.segments[0].sha256);
    let expected =
        upload_request(&complete, &complete.segments[0], path.parent().unwrap()).unwrap();
    assert_eq!(
        expected.session.as_ref().unwrap().completeness,
        TranscriptCompletenessArg::Complete.proto() as i32
    );

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server_path = path.clone();
    let server = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for attempt in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
            let length: usize = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            let request =
                sessions_pb::RecordTranscriptSegmentRequest::decode(body.as_slice()).unwrap();
            assert_eq!(request, expected);
            let persisted: TranscriptManifest =
                serde_json::from_reader(File::open(&server_path).unwrap()).unwrap();
            assert!(persisted.segments[0].upload_started);
            assert_eq!(
                persisted.segments[0]
                    .metadata
                    .as_ref()
                    .unwrap()
                    .completeness
                    .proto(),
                TranscriptCompletenessArg::Complete.proto()
            );
            bodies.push(body);
            if attempt == 0 {
                // Model an accepted request whose success response was lost.
                stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                let response = sessions_pb::RecordTranscriptSegmentResponse {
                    segment: Some(sessions_pb::TranscriptSegment {
                        sha256: request.sha256,
                        segment_index: request.segment_index,
                        ..Default::default()
                    }),
                    replayed: true,
                }
                .encode_to_vec();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
            }
        }
        assert_eq!(bodies[0], bodies[1]);
    });
    assert!(
        push_transcript(PushTranscriptArgs {
            manifest: path.clone(),
            endpoint: endpoint.clone(),
            token: None
        })
        .is_err()
    );
    capture(&input, root.path()).unwrap();
    let result = push_transcript(PushTranscriptArgs {
        manifest: path.clone(),
        endpoint,
        token: None,
    })
    .unwrap();
    assert_eq!(result["replayed"], 1);
    server.join().unwrap();
    assert!(
        read_locked_manifest(&path).unwrap().segments[0]
            .upload
            .is_some()
    );
}

#[test]
fn legacy_segments_keep_their_retry_descriptor_when_attempt_history_is_unknown() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("source.jsonl");
    fs::write(&input, "{\"text\":\"first\"}\n").unwrap();
    let (path, saved) = manifest(&capture(&input, root.path()).unwrap());
    let expected = upload_request(&saved, &saved.segments[0], path.parent().unwrap()).unwrap();
    let mut legacy = serde_json::to_value(saved).unwrap();
    legacy["segments"][0]
        .as_object_mut()
        .unwrap()
        .remove("upload_started");
    write_private_json(&path, &legacy).unwrap();
    let (_, complete) = manifest(
        &capture_with_completeness(&input, root.path(), TranscriptCompletenessArg::Complete)
            .unwrap(),
    );
    assert!(complete.segments[0].upload_started);
    assert_eq!(
        upload_request(&complete, &complete.segments[0], path.parent().unwrap()).unwrap(),
        expected
    );
}

//! Compression is a local representation; canonical digests and wire bytes stay stable.
use super::*;
use std::io::Read;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SpoolEncoding {
    Zstd,
}

pub(super) fn encode_spool(
    bytes: &[u8],
) -> Result<(Vec<u8>, Option<SpoolEncoding>), TranscriptError> {
    if bytes.len() >= 1024 {
        let compressed = zstd::bulk::compress(bytes, 1)?;
        if compressed.len() + (bytes.len() / 8).max(64) < bytes.len() {
            return Ok((compressed, Some(SpoolEncoding::Zstd)));
        }
    }
    Ok((bytes.to_vec(), None))
}

pub(super) fn read_segment(
    segment: &SpoolSegment,
    root: &Path,
) -> Result<Vec<u8>, TranscriptError> {
    let path = safe_segment_path(root, &segment.path)?;
    let file = File::open(&path)?;
    // Both encoded and decoded representations are bounded, including legacy files.
    if file.metadata()?.len() > MAX_SEGMENT_BYTES as u64 {
        return Err(TranscriptError::InvalidInput(
            "spooled segment exceeds size limit".into(),
        ));
    }
    let mut content = Vec::with_capacity(segment.size_bytes.min(MAX_SEGMENT_BYTES as u64) as usize);
    match segment.encoding {
        Some(SpoolEncoding::Zstd) => {
            let mut decoder = zstd::stream::read::Decoder::new(file)?;
            // Refuse a hostile frame requiring an unbounded decoder window.
            decoder.window_log_max(23)?;
            decoder
                .take(MAX_SEGMENT_BYTES as u64 + 1)
                .read_to_end(&mut content)?;
        }
        None => {
            file.take(MAX_SEGMENT_BYTES as u64 + 1)
                .read_to_end(&mut content)?;
        }
    }
    if content.len() as u64 != segment.size_bytes
        || format!("{:x}", Sha256::digest(&content)) != segment.sha256
    {
        return Err(TranscriptError::InvalidInput(format!(
            "spooled segment failed size or digest verification: {}",
            path.display()
        )));
    }
    Ok(content)
}

/// Check immutable stored bytes without allocating/decompressing the old history.
/// Canonical bytes are independently checked again before every actual upload.
pub(super) fn verify_segment_storage(
    segment: &SpoolSegment,
    root: &Path,
) -> Result<(), TranscriptError> {
    let expected = match segment.encoding {
        Some(_) => match &segment.stored_sha256 {
            Some(digest) => digest,
            None => {
                read_segment(segment, root)?;
                return Ok(());
            }
        },
        None => &segment.sha256,
    };
    let mut file = File::open(safe_segment_path(root, &segment.path)?)?;
    let size = file.metadata()?.len();
    if size > MAX_SEGMENT_BYTES as u64 || (segment.encoding.is_none() && size != segment.size_bytes)
    {
        return Err(TranscriptError::InvalidInput(
            "spooled segment exceeds size limit".into(),
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != *expected {
        return Err(TranscriptError::InvalidInput(
            "spooled segment failed stored digest verification".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_and_legacy_segments_decode_to_the_same_canonical_bytes() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"{\"message\":\"repeated source text\"}\n".repeat(1000);
        let segment = write_segment(root.path(), 0, 0, 999, &bytes).unwrap();
        assert!(segment.encoding.is_some());
        assert!(
            fs::metadata(root.path().join(&segment.path)).unwrap().len() < bytes.len() as u64 / 10
        );
        assert_eq!(read_segment(&segment, root.path()).unwrap(), bytes);
        verify_segment_storage(&segment, root.path()).unwrap();
        let mut unindexed = segment.clone();
        unindexed.stored_sha256 = None;
        verify_segment_storage(&unindexed, root.path()).unwrap();
        let mut legacy = segment.clone();
        legacy.encoding = None;
        fs::write(root.path().join(&legacy.path), &bytes).unwrap();
        assert_eq!(read_segment(&legacy, root.path()).unwrap(), bytes);
        fs::write(root.path().join(&legacy.path), b"corrupt").unwrap();
        assert!(read_segment(&legacy, root.path()).is_err());
        assert!(verify_segment_storage(&segment, root.path()).is_err());
    }
    #[test]
    fn decompression_rejects_expansion_beyond_the_canonical_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut segment = write_segment(root.path(), 0, 0, 0, b"{}\n").unwrap();
        segment.encoding = Some(SpoolEncoding::Zstd);
        let bomb = zstd::bulk::compress(&vec![b'x'; MAX_SEGMENT_BYTES + 1], 1).unwrap();
        fs::write(root.path().join(&segment.path), bomb).unwrap();
        assert!(read_segment(&segment, root.path()).is_err());
    }
}

#[cfg(test)]
#[test]
#[ignore = "manual compression tradeoff benchmark"]
fn compression_matrix() {
    let input = std::env::var_os("UPLOADER_BENCH_INPUT").expect("benchmark corpus");
    let root = tempfile::tempdir().unwrap();
    let mut capture = read_capture(CaptureOptions {
        input: Path::new(&input),
        agent: TranscriptAgent::Maestro,
        source_session_id: "",
        repo: root.path(),
        spool_root: root.path(),
        repository_url: None,
        existing: None,
        allow_partial_tail: false,
    })
    .unwrap();
    let segments = capture.segments.clone();
    capture.commit();
    let canonical: Vec<Vec<u8>> = segments
        .iter()
        .map(|segment| read_segment(segment, root.path()).unwrap())
        .collect();
    for (name, level) in [
        ("zstd", 1),
        ("zstd", 3),
        ("zstd", 6),
        ("gzip", 1),
        ("gzip", 6),
    ] {
        for run in 0..3 {
            let start = Instant::now();
            let mut compressed_bytes = 0;
            for bytes in &canonical {
                compressed_bytes += if name == "zstd" {
                    zstd::bulk::compress(bytes, level).unwrap().len()
                } else {
                    let mut encoder = flate2::write::GzEncoder::new(
                        Vec::new(),
                        flate2::Compression::new(level as u32),
                    );
                    encoder.write_all(bytes).unwrap();
                    encoder.finish().unwrap().len()
                };
            }
            eprintln!(
                "COMPRESSION {}",
                json!({"codec":name,"level":level,"run":run,"milliseconds":start.elapsed().as_secs_f64()*1000.,"canonical_bytes":canonical.iter().map(Vec::len).sum::<usize>(),"compressed_bytes":compressed_bytes,"segments":segments.len()})
            );
        }
    }
}

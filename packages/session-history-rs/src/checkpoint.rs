//! A disposable cursor in the existing manifest. Never trust timestamps or size
//! as proof of an unchanged prefix: hash every source byte before skipping parsing.
use super::*;
use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct SourceCheckpoint {
    bytes: u64,
    lines: usize,
    sha256: String,
    policy_sha256: String,
}

pub(super) struct CaptureInput {
    pub segments: Vec<SpoolSegment>,
    pub checkpoint: Option<SourceCheckpoint>,
    pub metadata: CapturedMetadata,
    pub reused_entries: usize,
    pub parsed_entries: usize,
    pub pull_request_url: Option<String>,
    spool_root: PathBuf,
    committed: bool,
}

impl CaptureInput {
    pub(super) fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for CaptureInput {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for segment in &self.segments {
            if let Ok(path) = safe_segment_path(&self.spool_root, &segment.path) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

struct SegmentWriter<'a> {
    spool_root: &'a Path,
    next_segment_index: u64,
    next_entry_index: u64,
    first_entry_index: Option<u64>,
    bytes: Vec<u8>,
    segments: Vec<SpoolSegment>,
    committed: bool,
}

impl<'a> SegmentWriter<'a> {
    fn new(spool_root: &'a Path, next_segment_index: u64, next_entry_index: u64) -> Self {
        Self {
            spool_root,
            next_segment_index,
            next_entry_index,
            first_entry_index: None,
            bytes: Vec::with_capacity(MAX_SEGMENT_BYTES),
            segments: Vec::new(),
            committed: false,
        }
    }

    fn push_value(&mut self, value: &impl Serialize) -> Result<&[u8], TranscriptError> {
        let mut entry_start = self.bytes.len();
        if let Err(error) = serde_json::to_writer(&mut self.bytes, value) {
            self.bytes.truncate(entry_start);
            return Err(error.into());
        }
        self.bytes.push(b'\n');
        if self.bytes.len() > MAX_SEGMENT_BYTES {
            self.bytes.truncate(entry_start);
            if entry_start == 0 {
                return Err(TranscriptError::InvalidInput(
                    "transcript entry exceeds the 524288-byte segment limit after redaction"
                        .to_string(),
                ));
            }
            self.flush()?;
            entry_start = self.bytes.len();
            serde_json::to_writer(&mut self.bytes, value)?;
            self.bytes.push(b'\n');
            if self.bytes.len() > MAX_SEGMENT_BYTES {
                self.bytes.truncate(entry_start);
                return Err(TranscriptError::InvalidInput(
                    "transcript entry exceeds the 524288-byte segment limit after redaction"
                        .to_string(),
                ));
            }
            self.first_entry_index = Some(self.next_entry_index);
        } else if entry_start == 0 {
            self.first_entry_index = Some(self.next_entry_index);
        }
        self.next_entry_index += 1;
        Ok(&self.bytes[entry_start..])
    }

    fn flush(&mut self) -> Result<(), TranscriptError> {
        if self.bytes.is_empty() {
            return Ok(());
        }
        let first_entry_index = self.first_entry_index.take().ok_or_else(|| {
            TranscriptError::InvalidInput("capture segment lost its first entry index".to_string())
        })?;
        let segment = write_segment(
            self.spool_root,
            self.next_segment_index,
            first_entry_index,
            self.next_entry_index - 1,
            &self.bytes,
        )?;
        self.segments.push(segment);
        self.next_segment_index += 1;
        self.bytes.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<SpoolSegment>, TranscriptError> {
        self.flush()?;
        self.committed = true;
        Ok(std::mem::take(&mut self.segments))
    }
}

impl Drop for SegmentWriter<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for segment in &self.segments {
            let _ = fs::remove_file(self.spool_root.join(&segment.path));
        }
    }
}

struct PrefixVerifier<'a> {
    segments: &'a [SpoolSegment],
    spool_root: &'a Path,
    segment_index: usize,
    next_entry_index: u64,
    offset: usize,
    content: Vec<u8>,
}

impl<'a> PrefixVerifier<'a> {
    fn new(segments: &'a [SpoolSegment], spool_root: &'a Path) -> Self {
        Self {
            segments,
            spool_root,
            segment_index: 0,
            next_entry_index: 0,
            offset: 0,
            content: Vec::new(),
        }
    }

    fn compare(&mut self, entry: &[u8]) -> Result<(), TranscriptError> {
        let segment = self.segments.get(self.segment_index).ok_or_else(|| {
            TranscriptError::InvalidInput(
                "source contains entries beyond the existing transcript prefix".to_string(),
            )
        })?;
        if self.content.is_empty() {
            self.content = read_segment(segment, self.spool_root)?;
        }
        let index_mismatch = self.next_entry_index < segment.first_entry_index
            || self.next_entry_index > segment.last_entry_index;
        let length_mismatch = self.offset + entry.len() > self.content.len();
        let bytes_mismatch =
            !length_mismatch && self.content[self.offset..self.offset + entry.len()] != *entry;
        if index_mismatch || length_mismatch || bytes_mismatch {
            return Err(TranscriptError::InvalidInput(
                "existing transcript prefix changed after it was spooled".to_string(),
            ));
        }
        self.offset += entry.len();
        self.next_entry_index += 1;
        if self.offset == self.content.len() {
            self.segment_index += 1;
            self.offset = 0;
            self.content.clear();
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), TranscriptError> {
        if self.segment_index != self.segments.len() || !self.content.is_empty() {
            return Err(TranscriptError::InvalidInput(
                "existing transcript prefix was truncated".to_string(),
            ));
        }
        Ok(())
    }
}

pub(super) struct CaptureOptions<'a> {
    pub input: &'a Path,
    pub agent: TranscriptAgent,
    pub source_session_id: &'a str,
    pub repo: &'a Path,
    pub spool_root: &'a Path,
    pub repository_url: Option<&'a str>,
    pub existing: Option<&'a TranscriptManifest>,
    pub allow_partial_tail: bool,
}

pub(super) fn read_capture(options: CaptureOptions<'_>) -> Result<CaptureInput, TranscriptError> {
    let CaptureOptions {
        input,
        agent,
        source_session_id,
        repo,
        spool_root,
        repository_url,
        existing,
        allow_partial_tail,
    } = options;
    let redactor = Redactor::new(repo)?;
    let policy = redactor.fingerprint();
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(input)?);
    let snapshot_size = reader.get_ref().metadata()?.len();
    let mut digest = Sha256::new();
    let mut source_index = 0;
    let mut consumed = 0;
    let mut reused_entries = 0;
    if let Some(previous) = existing.and_then(|manifest| manifest.source_checkpoint.as_ref())
        && previous.policy_sha256 == policy
        && previous.bytes <= snapshot_size
    {
        let mut buffer = [0u8; 64 * 1024];
        let mut remaining = previous.bytes;
        while remaining > 0 {
            let length = remaining.min(buffer.len() as u64) as usize;
            reader.read_exact(&mut buffer[..length])?;
            digest.update(&buffer[..length]);
            remaining -= length as u64;
        }
        if format!("{:x}", digest.clone().finalize()) == previous.sha256 {
            consumed = previous.bytes;
            source_index = previous.lines;
            reused_entries = existing
                .unwrap()
                .segments
                .last()
                .map_or(0, |segment| segment.last_entry_index as usize + 1);
        } else {
            digest = Sha256::new();
            reader.seek(SeekFrom::Start(0))?;
        }
    }

    let existing_segments = existing.map_or(&[][..], |manifest| manifest.segments.as_slice());
    let existing_entry_count = existing_segments
        .last()
        .map_or(0, |segment| segment.last_entry_index as usize + 1);
    let mut prefix = (existing.is_some() && reused_entries == 0)
        .then(|| PrefixVerifier::new(existing_segments, spool_root));
    let mut writer = SegmentWriter::new(
        spool_root,
        existing_segments.len() as u64,
        existing_entry_count as u64,
    );
    let mut metadata = CapturedMetadata::default();
    let mut pull_request_url = None;
    let mut parsed_entries = 0;
    let mut line = Vec::new();
    let mut ended_at_newline = consumed > 0;
    // A bounded snapshot avoids chasing a concurrently growing file forever.
    let mut reader = reader.take(snapshot_size - consumed);
    while reader.read_until(b'\n', &mut line)? > 0 {
        let line_terminated = line.last() == Some(&b'\n');
        let text = match std::str::from_utf8(&line) {
            Ok(text) => text,
            Err(_error) if allow_partial_tail && !line_terminated => break,
            Err(error) => {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error).into());
            }
        };
        if !text.trim().is_empty() {
            let value: Value = match serde_json::from_slice(&line) {
                Ok(value) => value,
                Err(_error) if allow_partial_tail && !line_terminated => break,
                Err(error) => {
                    return Err(TranscriptError::InvalidInput(format!(
                        "line {} is not valid JSON: {error}",
                        source_index + 1
                    )));
                }
            };
            if !value.is_object() {
                return Err(TranscriptError::InvalidInput(format!(
                    "line {} must be a JSON object",
                    source_index + 1
                )));
            }
            let event = redact_transcript_value_with(value, &redactor);
            if agent == TranscriptAgent::Maestro {
                metadata.observe(&event, source_session_id);
            }
            let envelope = json!({
                "agent": agent.storage_name(),
                "event": event,
                "schema": "evalops.session.transcript.v1",
                "source_index": source_index,
            });
            match (parsed_entries < existing_entry_count, prefix.as_mut()) {
                (true, Some(prefix)) => {
                    let mut bytes = serde_json::to_vec(&envelope)?;
                    bytes.push(b'\n');
                    if pull_request_url.is_none() {
                        pull_request_url = detect_pull_request_url_bytes(&bytes, repository_url);
                    }
                    prefix.compare(&bytes)?;
                }
                _ => {
                    let bytes = writer.push_value(&envelope)?;
                    if pull_request_url.is_none() {
                        pull_request_url = detect_pull_request_url_bytes(bytes, repository_url);
                    }
                }
            }
            parsed_entries += 1;
        } else if allow_partial_tail && !line_terminated {
            // Whitespace without a newline is just as likely to be an active
            // producer tail as a partial JSON value; keep the last safe cursor.
            break;
        }
        consumed += line.len() as u64;
        digest.update(&line);
        ended_at_newline = line_terminated;
        source_index += 1;
        line.clear();
    }
    if let Some(prefix) = prefix {
        prefix.finish()?;
    }
    let segments = writer.finish()?;
    let checkpoint = ended_at_newline.then(|| SourceCheckpoint {
        bytes: consumed,
        lines: source_index,
        sha256: format!("{:x}", digest.finalize()),
        policy_sha256: policy,
    });
    Ok(CaptureInput {
        segments,
        checkpoint,
        metadata,
        reused_entries,
        parsed_entries,
        pull_request_url,
        spool_root: spool_root.to_path_buf(),
        committed: false,
    })
}

//! Minimal Sessions v1 protobuf messages used by transcript capture.
//!
//! The public Maestro release cannot depend on Mono's repository-root generated
//! proto crate. These prost definitions keep the same field numbers and wire
//! types for the small RecordTranscriptSegment boundary that Maestro owns.

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum AgentKind {
    Unspecified = 0,
    ClaudeCode = 1,
    Codex = 2,
    Maestro = 3,
    Other = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum TranscriptCompleteness {
    Unspecified = 0,
    InProgress = 1,
    Complete = 2,
    Partial = 3,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct AgentSessionDescriptor {
    #[prost(string, tag = "1")]
    pub session_id: String,
    #[prost(enumeration = "AgentKind", tag = "2")]
    pub agent_kind: i32,
    #[prost(string, tag = "3")]
    pub agent_name: String,
    #[prost(string, tag = "4")]
    pub source_session_id: String,
    #[prost(string, tag = "5")]
    pub repository_url: String,
    #[prost(string, tag = "6")]
    pub working_directory: String,
    #[prost(string, tag = "7")]
    pub branch: String,
    #[prost(string, tag = "8")]
    pub head_sha: String,
    #[prost(string, tag = "9")]
    pub title: String,
    #[prost(message, optional, tag = "10")]
    pub started_at: Option<prost_types::Timestamp>,
    #[prost(message, optional, tag = "11")]
    pub ended_at: Option<prost_types::Timestamp>,
    #[prost(enumeration = "TranscriptCompleteness", tag = "12")]
    pub completeness: i32,
    #[prost(string, tag = "13")]
    pub pull_request_url: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct TranscriptSegment {
    #[prost(string, tag = "1")]
    pub segment_id: String,
    #[prost(string, tag = "2")]
    pub organization_id: String,
    #[prost(string, tag = "3")]
    pub workspace_id: String,
    #[prost(string, tag = "4")]
    pub session_id: String,
    #[prost(uint64, tag = "5")]
    pub segment_index: u64,
    #[prost(uint64, tag = "6")]
    pub first_entry_index: u64,
    #[prost(uint64, tag = "7")]
    pub last_entry_index: u64,
    #[prost(string, tag = "8")]
    pub object_id: String,
    #[prost(string, tag = "9")]
    pub version_id: String,
    #[prost(string, tag = "10")]
    pub content_type: String,
    #[prost(int64, tag = "11")]
    pub size_bytes: i64,
    #[prost(string, tag = "12")]
    pub sha256: String,
    #[prost(string, tag = "13")]
    pub recorded_at: String,
    #[prost(bytes = "vec", tag = "14")]
    pub content: Vec<u8>,
    #[prost(string, tag = "15")]
    pub redaction_policy_version: String,
    #[prost(uint64, tag = "16")]
    pub omitted_entry_count: u64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct RecordTranscriptSegmentRequest {
    #[prost(string, tag = "1")]
    pub organization_id: String,
    #[prost(string, tag = "2")]
    pub workspace_id: String,
    #[prost(message, optional, tag = "3")]
    pub session: Option<AgentSessionDescriptor>,
    #[prost(uint64, tag = "4")]
    pub segment_index: u64,
    #[prost(uint64, tag = "5")]
    pub first_entry_index: u64,
    #[prost(uint64, tag = "6")]
    pub last_entry_index: u64,
    #[prost(bytes = "vec", tag = "7")]
    pub content: Vec<u8>,
    #[prost(string, tag = "8")]
    pub sha256: String,
    #[prost(bool, tag = "9")]
    pub edge_redacted: bool,
    #[prost(string, tag = "10")]
    pub redaction_policy_version: String,
    #[prost(uint64, tag = "11")]
    pub omitted_entry_count: u64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct RecordTranscriptSegmentResponse {
    #[prost(message, optional, tag = "1")]
    pub segment: Option<TranscriptSegment>,
    #[prost(bool, tag = "2")]
    pub replayed: bool,
}

# Agent Workforce Native Event Projection

`agent_workforce_native_event.v1` is Maestro's first native Agent Workforce
projection for the merged Platform contract introduced in Platform commit
`a559e842e2a1a0f142ea0ef4558a466567e8c8bc`. It answers what a coding
agent did, what Maestro observed at runtime, what tool or resource it attempted
to mutate, which approval decision applied, what model usage the provider
reported, and whether any credential assumption has been proven by Platform.

The implementation owner is
`src/telemetry/agent-workforce-native-event.ts`. The hook point is the Maestro
runtime `AgentEvent` stream emitted by `src/agent/agent.ts` and the existing
tool-safety/event-bus boundary. The projector deliberately consumes runtime
events such as `agent_start`, `turn_start`, `tool_execution_start`,
`action_approval_required`, `action_approval_resolved`, `tool_execution_end`,
and assistant `message_end`; it does not turn agent prose, status text, or raw
assistant claims into authority.

## Trust Boundary

The envelope is runtime-observed Maestro self-report:

- `emitter.emitter` is `evalops/maestro`.
- `emitter.emitter_owner` is `maestro.provider_event_bus`.
- `source_authority.declared_authority` is `native_observed`.
- `source_authority.evidence_authority` is `native_observed`.
- `source_authority.provenance_verified` remains `false`.
- `timeline_correlation.source_event_ref` and `evidence.refs` point back to
  runtime `maestro.AgentEvent` records and available AgentRuntime-style ids.

That means Maestro can authoritatively report the events it emitted at its own
runtime boundary. It does not prove that the event is externally complete or
that a credential assumption is valid. Platform must compare the envelope
against AgentRuntime, Registry, Secret Broker, LLM Gateway, Meter, and other
runtime-side records before treating provenance or credentials as verified.

## Credential Authority

Credential authority is separated from event authorship:

- With no Platform/Secret Broker/AgentRuntime/LLM Gateway/Meter join refs,
  `credential_assumption.proof_status` is `missing` and
  `credential_assumption.provenance_verified` is `false`.
- If Maestro is given only declared credential metadata or native caller-supplied
  join refs, even refs that look verified by shape, `credential_assumption.declared_authority`
  records the declared source, but `proof_status` remains `missing` and
  `verified_provenance` is omitted.
- Verified credential authority requires an explicit Platform ingestion/resolver
  authority bundle with fresh `observed_at`/`expires_at`, revocation, and joined
  identity, AgentRuntime, and Secret Broker evidence before
  `credential_assumption.verified_provenance` can be populated.

Maestro should not infer credential authority from environment variables,
provider names, model names, or agent text.

## Integrity

Projected envelopes are hash-chained with
`evidence.signature = sha256-chain:v1:<chain_id>:<sequence>:<prev_hash>:<event_hash>`.
The event hash is computed over the Platform-shaped envelope with
`evidence.signature` omitted, so the integrity primitive stays inside the
contract-allowed evidence structure. Platform can detect:

- Tampering: recompute the stable hash for each envelope.
- Omission: verify contiguous `action.sequence` values and previous-hash links.
- Reordering: verify that each event's previous hash matches the prior event.

Use `verifyAgentWorkforceNativeEventChain` as the local primitive. Platform can
use the same check before comparing the chain to runtime-side AgentRuntime or
tool-execution records.

## Platform HTTP Ingestion

Maestro can now POST projected native-event batches through
`src/telemetry/agent-workforce-native-event-client.ts`. Publishing is best
effort: missing configuration is a no-op, and configured network failures are
bounded by the downstream HTTP timeout/retry settings so local Maestro sessions
do not depend on Platform availability.

Configure one of these endpoint shapes:

- `MAESTRO_AGENT_WORKFORCE_INGEST_URL` for an exact dedicated HTTP endpoint.
- `MAESTRO_AGENT_WORKFORCE_BASE_URL`,
  `MAESTRO_AGENT_WORKFORCE_SERVICE_URL`, or the shared
  `MAESTRO_PLATFORM_BASE_URL`/`MAESTRO_EVALOPS_BASE_URL`/`EVALOPS_BASE_URL`
  for the default POST route:
  `/v1/agent-workforce/native-events:batch`.

Authentication and tenancy follow the existing EvalOps aliases:

- Token: `MAESTRO_AGENT_WORKFORCE_ACCESS_TOKEN`,
  `MAESTRO_EVALOPS_ACCESS_TOKEN`, or `EVALOPS_TOKEN`.
- Organization: `MAESTRO_AGENT_WORKFORCE_ORG_ID`,
  `MAESTRO_EVALOPS_ORG_ID`, `EVALOPS_ORGANIZATION_ID`, `EVALOPS_ORG_ID`, or
  `MAESTRO_ENTERPRISE_ORG_ID`.
- Workspace: `MAESTRO_AGENT_WORKFORCE_WORKSPACE_ID`,
  `MAESTRO_EVALOPS_WORKSPACE_ID`, `EVALOPS_WORKSPACE_ID`,
  `MAESTRO_WORKSPACE_ID`, or `MAESTRO_REMOTE_RUNNER_WORKSPACE_ID`.
- Bounds: `MAESTRO_AGENT_WORKFORCE_TIMEOUT_MS` defaults to `2000`, and
  `MAESTRO_AGENT_WORKFORCE_MAX_ATTEMPTS` defaults to `2`.

The request body is
`agent_workforce_native_event_batch.v1` with `organization_id`,
`workspace_id`, optional `batch_id`, `event_count`, and `events`. Each event is
the hash-chained `agent_workforce_native_event.v1` envelope. The POST egress
path drops raw sensitive extras such as token, secret, authorization,
provider-request, and provider-response internals; tool arguments remain
represented by safe key summaries and hashes instead of raw values.

Model usage in these events is local Maestro-observed usage:
`model_usage.usage_authority = maestro_local` and
`model_usage.cost_reconciliation_status = unreconciled`. Platform may display
that Maestro reported model usage and an unreconciled local cost estimate. It
must not claim reconciled billing, provider-meter proof, or LLM Gateway
authority until Platform joins the event to meter or gateway evidence.

Credential proof remains separate from event transport. Platform/UI may claim
that Maestro emitted a runtime-observed native event chain, that a tool or
approval event occurred at Maestro's boundary, and that the hash chain is
locally verifiable. Platform/UI must still label credential authority as
`evidence missing` unless the event contains a fresh Platform ingestion/resolver
authority bundle with valid identity, AgentRuntime, and Secret Broker or LLM
Gateway joined evidence. Declared Secret Broker/LLM Gateway/caller refs alone
remain unverified.

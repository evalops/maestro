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

## Pending Platform Ingestion

This PR stops at the projector and verification primitive. When Platform
ingestion is ready, wire the projector from the same runtime event boundary to
the existing audit bus publisher or a dedicated ingestion client. The expected
configuration hook should follow the existing EvalOps patterns:

- `MAESTRO_AGENT_WORKFORCE_INGEST_URL` for a dedicated HTTP endpoint, or
  `MAESTRO_PLATFORM_BASE_URL` when the endpoint is exposed as a Platform
  Connect service.
- `MAESTRO_EVALOPS_ACCESS_TOKEN` for auth.
- `MAESTRO_EVALOPS_ORG_ID` and `MAESTRO_EVALOPS_WORKSPACE_ID` for tenant joins.

The next PR should add the actual POST or event-bus subject only after Platform
publishes the ingestion method. Platform #2856 is the downstream resolver for
credential and cost joins; Maestro should not duplicate that authority joining
in this projector.

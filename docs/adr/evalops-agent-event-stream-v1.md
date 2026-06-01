# ADR: Define EvalOps Agent Event Stream v1

Status: Proposed
Date: 2026-06-01
Linear: EVA-109
runtime_implementation_allowed: false

## Decision

Define `evalops.agent_event.v1` and `evalops.agent_stream.v1` as docs-only
EvalOps contract vocabulary for Maestro and Platform review. This ADR freezes
event identity, delegation identity, task/context continuity, readiness,
evidence references, credential references, and budget terminology before any
runtime emitter or consumer is implemented.

This ADR does not authorize Maestro runtime, parser, session persistence,
event-writer, `--stream-json`, Platform trace UI, credential broker, hosted
progress redaction, replay prompt evidence, or deploy secret-alias changes.

## Source Evidence

Provenance:

- Coordination source: Linear EVA-109.

This ADR was prepared from EVA-109 manager and worker handoff artifacts. Source
evidence is retained in the private EVA-109 coordination record. Local
filesystem paths and private repository references are intentionally omitted
from mirrored docs so the public tree contains durable, reproducible references.

Observed validated evidence from those handoffs:

- The docs-ready slice names `evalops.agent_event.v1` and
  `evalops.agent_stream.v1`.
- The field dictionary covers the core event envelope.
- Coverage reports mark this slice as docs/ADR only, with runtime work blocked
  behind owner clearance.
- Candidate local-redacted evidence is advisory only and does not change
  canonical source registration.

Historical design input from those handoffs:

- Prefer Platform-mediated delegation when Platform can allocate or return
  dispatch identity.
- Treat durable work items and workGraph edges as traceable API identity.
- Treat governed `ToolExecution` IDs as first-class API identity, with raw
  provider or tool call IDs kept as gated evidence references.
- Preserve task and context identity across `INPUT_REQUIRED -> COMPLETED`.
- Refuse ambiguous coordinator queues instead of guessing.
- Use whole-operation budgets that cover initial send plus polling.
- Parse timeout values finitely and normalize external state casing before
  comparison.
- Pass credential references and capability grants, never raw secrets.

## Scope

The contract covers:

- `evalops.agent_event.v1`, the event envelope schema name.
- `evalops.agent_stream.v1`, the ordered stream binding for those events.
- JSONL output vocabulary for future review.
- Future JSON-RPC control/input vocabulary for future review.
- Dispatch, work-item, workGraph, task, context, and tool identity.
- Parentage and causality across child agents and tool executions.
- Readiness and lifecycle events.
- State-gated evidence references.
- Credential references and capability grants.

The contract is intentionally vocabulary-only. Implementations must pass a
separate owner review and bounded overlap check before emitting, parsing,
persisting, or rendering this schema.

## Non-Goals

- No hosted progress redaction changes.
- No replay prompt evidence behavior changes.
- No deploy secret alias changes.
- No parser, event writer, session persistence, stream-json output, Platform
  trace UI, runtime, or credential broker implementation.
- No credentialed API calls, secret reads, auth reads, token reads, Kubernetes
  mutation, production-like service mutation, or local coordination board use.
- No raw prompt, provider payload, tool arguments, token, auth file, cookie,
  keychain, credential, local-cache, or secret-bearing data in examples.
- No watcher permission. Polling terms here are bounded contract vocabulary,
  not approval to run unbounded watchers or shell loops.

## Versioning

Events must set:

```json
{
  "schema_version": "evalops.agent_event.v1"
}
```

Additive fields may be introduced under `extensions` or in type-specific
payload objects when they preserve existing meaning. Breaking field semantics,
event ordering semantics, identity semantics, or evidence access semantics
require a new schema version.

## Event Envelope

Every event has an ordered envelope:

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | Yes | Fixed to `evalops.agent_event.v1`. |
| `event_id` | Yes | Stable event identity. |
| `sequence` | Yes | Monotonic order within the stream. |
| `timestamp` | Yes | RFC3339 event time. |
| `type` | Yes | Normalized event type. |
| `session_id` | Yes | Durable session identity. |
| `turn_id` | No | Turn identity when available. |
| `run_id` | No | Run identity when distinct from session. |
| `correlation_id` | No | Invocation or request correlation identity. |
| `parent_event_id` | No | Causal parent event. |
| `parent_tool_use_id` | No | Legacy or provider tool-use parent reference. |
| `trace_id` | No | Platform trace identity. |
| `span_id` | No | Platform span identity. |
| `payload` | No | Redacted type-specific object. |
| `extensions` | No | Redacted additive extension object. |

`sequence` defines stream order. Consumers must not infer ordering from
timestamps alone.

## Stream Binding

`evalops.agent_stream.v1` is an append-only ordered stream of
`evalops.agent_event.v1` events. A JSONL binding writes exactly one event
envelope per line. A future JSON-RPC control/input binding may refer to the
same `event_id`, `correlation_id`, `task_id`, `context_id`, and
`input_request_id` values, but this ADR does not implement that binding.

Stream consumers must tolerate unknown additive fields and unknown future event
types by preserving the raw envelope as gated evidence or by reporting a safe
unsupported-type reason. Consumers must not fetch evidence references or
credentials implicitly while reading the stream.

## Delegation Identity

When Platform can allocate or return dispatch identity, child-agent delegation
uses Platform-mediated `dispatch_id` instead of direct A2A send identifiers as
the primary API identity.

Delegated work is represented with durable identity:

| Field | Required When | Meaning |
| --- | --- | --- |
| `dispatch_id` | Platform dispatch is used | Platform-mediated dispatch identity. |
| `work_item_id` | Delegation becomes durable work | Durable child work identity. |
| `work_graph_edge_id` | Parent/child relationship is tracked | Durable workGraph edge identity. |
| `parent_task_id` | Child task is created from a task | Parent task identity. |
| `child_task_id` | Child task is created | Child task identity. |
| `task_id` | Event is task-scoped | Durable task identity. |
| `context_id` | Event is context-scoped | Durable context identity. |

Transcript text, raw call IDs, or queue position are not sufficient identity
for delegated work.

## ToolExecution Identity

Governed `ToolExecution` IDs are first-class API identity:

| Field | Required When | Meaning |
| --- | --- | --- |
| `tool_execution_id` | Governed or observed tool execution is represented | Platform or governed tool execution identity. |
| `raw_call_ref` | Raw provider/tool call identity is retained | Evidence reference for raw call ID, not primary identity. |
| `tool_call_evidence_ref` | Tool-call evidence is retained | Gated evidence reference for raw call payload or vendor ID. |

Raw provider call IDs, MCP call IDs, model call IDs, and local transient tool
call IDs may appear only as state-gated evidence references. They must not
become durable API identity in this contract.

## Task, Context, And Peer Replies

Task and context identity must be preserved across:

- `INPUT_REQUIRED`
- peer reply recording
- resume
- `COMPLETED`

Peer replies are recorded in a durable ledger keyed by both `task_id` and
`context_id`.

| Field | Required When | Meaning |
| --- | --- | --- |
| `input_request_id` | Input is requested | Identity of the input wait. |
| `peer_reply_id` | Peer reply is recorded | Durable peer reply identity. |
| `peer_reply_ledger_ref` | Ledger entry is referenced | Reference to the task/context keyed ledger. |
| `queue_state` | Queue state is reported | Normalized queue state. |
| `refusal_reason_safe` | Queue is refused | Safe explanation with no raw payload. |

If the coordinator cannot resolve a unique task/context pair, it must emit or
record an ambiguous-queue refusal. It must not guess from the latest message,
latest queue item, or free-text transcript.

## Budgets And Timeouts

Budget vocabulary describes whole operations, not only a single network send or
poll loop:

| Field | Required When | Meaning |
| --- | --- | --- |
| `operation_budget_ms` | Operation has a bounded budget | Total budget for initial send plus polling. |
| `initial_send_timeout_ms` | Initial send has a timeout | Finite first-send timeout. |
| `send_budget_ms` | Send budget is separately reported | Send portion of the whole operation budget. |
| `poll_timeout_ms` | Polling has a timeout | Finite polling timeout. |
| `poll_budget_ms` | Polling budget is separately reported | Polling portion of the whole operation budget. |
| `poll_interval_ms` | Polling interval is specified | Bounded interval for future implementation planning. |
| `timeout_ms` | Generic timeout field is needed | Finite timeout value. |
| `started_at` | Budgeted operation starts | RFC3339 start time. |
| `deadline_at` | Budgeted operation has a deadline | RFC3339 deadline. |
| `state_normalized` | External state is compared | Case-normalized state used for comparison. |

Timeout parsing must reject non-finite values. External state names must be
normalized before comparison so `INPUT_REQUIRED`, `input_required`, and similar
external spellings do not fork state-machine behavior.

## Readiness

Readiness events must distinguish setup, runtime, identity, credential, and
capability readiness:

| Field | Required When | Meaning |
| --- | --- | --- |
| `readiness_state` | Readiness is reported | Normalized readiness state. |
| `readiness_check_id` | A check is reported | Durable readiness check identity. |
| `readiness_domain` | Readiness is reported | Required domain such as `bootstrap`, `remote_runner`, `identity`, `app_setup`, `credential`, `capability`, or `kyverno`. |
| `bootstrap_ready` | Bootstrap readiness is checked | Bootstrap readiness result. |
| `remote_runner_identity_ready` | Remote runner identity is checked | Remote-runner identity readiness result. |
| `identity_ready` | Identity readiness is checked | Identity readiness result. |
| `app_setup_ready` | App setup is checked | App setup readiness result. |
| `credential_readiness_ref` | Credential readiness is checked | Reference to readiness proof, not secret material. |
| `capability_grant_refs` | Capabilities are needed | Capability grant references required by the operation. |

Readiness must not be inferred from a generic deploy-health label when a more
specific readiness domain exists.

## Kyverno Readiness Boundary

`readiness_domain: "kyverno"` means Kubernetes admission, policy, webhook,
namespace/resource invariant, and manifest-shape compatibility for GitOps
manifests.

Kyverno may prove:

- Kubernetes admission and policy compatibility.
- Admission webhook behavior.
- Namespace and resource invariants.
- GitOps manifest shape.
- Credential reference shape in a manifest.

Kyverno must not be used as:

- Generic deploy health.
- PR queue serialization status.
- Argo freshness, stale-operation, or OutOfSync health.
- Runtime smoke health.
- Image sync health.
- Nimbus, Tempo, or proof-tail health.
- App readiness.
- Ordinary CI flake classification.
- Secret-value validation.

Secret paths stay on the normal secret-management path. Kyverno proves
references and shape; it does not read, probe, expose, validate, or prove raw
secret values.

## Evidence References

Evidence references are state-gated. Events may include evidence references,
but stream consumers must not auto-fetch raw evidence.

| Field | Required When | Meaning |
| --- | --- | --- |
| `evidence_refs` | Evidence is referenced | Array of redacted evidence refs. |
| `evidence_refs[].uri` | Evidence ref is present | Opaque evidence URI. |
| `evidence_refs[].scope_required` | Raw evidence requires scope | Scope needed for retrieval. |
| `evidence_refs[].redaction_state` | Evidence ref is present | Safe redaction state. |
| `evidence_refs[].raw_payload_state` | Evidence ref is present | Raw payload availability state. |

Allowed `redaction_state` values include `safe_summary`, `partial`, `full`,
and `redacted`.

Allowed `raw_payload_state` values include `not_collected`, `not_included`,
`withheld`, `redacted`, `available_by_scope`, and `expired`.

Evidence refs may point to raw call IDs or raw payload locations only when
access is gated by scope and state. The envelope itself must remain safe to
store, review, and mirror.

## Credential References And Capability Grants

Credential and capability vocabulary uses references only:

| Field | Required When | Meaning |
| --- | --- | --- |
| `credential_ref` | Credential class or handle is relevant | Managed credential reference, never secret material. |
| `capability_grant_id` | A single grant is relevant | Explicit capability grant identity. |
| `capability_grant_ref` | A grant is referenced | Explicit capability grant reference. |
| `capability_grant_refs` | Multiple grants are referenced | Array of grant references. |
| `capability_scope` | Grant scope is reported | Scope covered by the grant. |

Events must never include raw secrets, tokens, cookies, keychain values, auth
files, local credential cache contents, or decrypted secret values.

## Event Type Vocabulary

Lifecycle:

- `session.accepted`
- `runtime.ready`
- `runtime.readiness_failed`
- `session.archived`
- `session.forked`

Delegation:

- `delegation.dispatch_requested`
- `delegation.dispatched`
- `delegation.work_item_created`
- `delegation.work_graph_edge_created`
- `delegation.completed`
- `delegation.failed`

Task and peer reply:

- `task.input_required`
- `task.context_preserved`
- `task.reply_recorded`
- `task.completed`
- `task.queue_ambiguous`
- `peer_reply.recorded`
- `coordinator.queue.refused`

Tool execution:

- `tool.execution_started`
- `tool.execution_completed`
- `tool.execution_failed`

Budget and timeout:

- `operation.budget_started`
- `operation.timeout_warning`
- `operation.timeout_exceeded`
- `operation.polling_completed`

Evidence and authorization:

- `evidence.ref_added`
- `evidence.ref_redacted`
- `credential.capability_granted`
- `credential.capability_denied`

## Safe Examples

### Platform-Mediated Delegation

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFEDELEGATION",
  "sequence": 42,
  "timestamp": "2026-06-01T00:00:00Z",
  "type": "delegation.dispatched",
  "session_id": "sess_redacted",
  "correlation_id": "corr_redacted",
  "trace_id": "trace_redacted",
  "payload": {
    "dispatch_id": "dispatch_redacted",
    "work_item_id": "work_redacted_child",
    "work_graph_edge_id": "edge_redacted_parent_child",
    "parent_task_id": "task_parent_redacted",
    "child_task_id": "task_child_redacted",
    "dispatch_surface": "platform",
    "direct_a2a_send_used": false
  },
  "extensions": {}
}
```

### Governed ToolExecution Identity

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFETOOL",
  "sequence": 57,
  "timestamp": "2026-06-01T00:00:10Z",
  "type": "tool.execution_completed",
  "session_id": "sess_redacted",
  "span_id": "span_redacted",
  "payload": {
    "tool_execution_id": "toolexec_redacted",
    "status": "completed",
    "tool_call_evidence_ref": {
      "uri": "evidence://redacted/tool-call",
      "redaction_state": "safe_summary",
      "raw_payload_state": "withheld",
      "scope_required": "tool_audit"
    }
  },
  "extensions": {}
}
```

### Task/Context Peer Reply Continuity

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFEREPLY",
  "sequence": 61,
  "timestamp": "2026-06-01T00:00:20Z",
  "type": "peer_reply.recorded",
  "session_id": "sess_redacted",
  "payload": {
    "task_id": "task_redacted",
    "context_id": "ctx_redacted",
    "input_request_id": "inputreq_redacted",
    "peer_reply_id": "reply_redacted",
    "peer_reply_ledger_ref": "ledger://redacted/task-context",
    "from_state": "input_required",
    "to_state": "completed"
  },
  "extensions": {}
}
```

### Coordinator Refuses Ambiguous Queue

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFEQUEUE",
  "sequence": 62,
  "timestamp": "2026-06-01T00:00:22Z",
  "type": "coordinator.queue.refused",
  "session_id": "sess_redacted",
  "payload": {
    "queue_state": "ambiguous_refused",
    "task_id": null,
    "context_id": null,
    "refusal_reason_safe": "multiple candidate task/context pairs; explicit task_id and context_id required"
  },
  "extensions": {}
}
```

### Whole-Operation Budget And Readiness

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFEBUDGET",
  "sequence": 3,
  "timestamp": "2026-06-01T00:00:03Z",
  "type": "runtime.ready",
  "session_id": "sess_redacted",
  "payload": {
    "readiness_domain": "bootstrap",
    "readiness_state": "ready",
    "readiness_check_id": "readycheck_bootstrap_redacted",
    "operation_budget_ms": 300000,
    "initial_send_timeout_ms": 30000,
    "poll_timeout_ms": 270000,
    "state_normalized": "ready",
    "bootstrap_ready": true,
    "remote_runner_identity_ready": true,
    "identity_ready": true,
    "app_setup_ready": true,
    "credential_readiness_ref": "credential-readiness://redacted",
    "capability_grant_refs": ["capability://redacted/agent-dispatch"]
  },
  "extensions": {}
}
```

### Kyverno Manifest-Shape Readiness

```json
{
  "schema_version": "evalops.agent_event.v1",
  "event_id": "evt_01JSAFEKYVERNO",
  "sequence": 9,
  "timestamp": "2026-06-01T00:00:09Z",
  "type": "runtime.readiness_failed",
  "session_id": "sess_redacted",
  "payload": {
    "readiness_domain": "kyverno",
    "readiness_state": "blocked",
    "readiness_check_id": "readycheck_redacted",
    "manifest_ref": "gitops://redacted/manifest",
    "credential_ref": "credref_redacted",
    "kyverno_boundary": "admission_policy_webhook_namespace_resource_manifest_shape",
    "secret_value_checked": false
  },
  "extensions": {}
}
```

## Required Future Owner Checks

Before any implementation may start, owners must complete a fresh bounded
non-overlap check covering at least:

- hosted progress redaction work;
- replay prompt evidence behavior;
- deploy secret alias work;
- parser, event-writer, session persistence, runtime, and stream-json lanes;
- Platform trace UI work;
- credential broker or capability broker work.

Implementation must remain blocked unless the owning manager explicitly changes
`runtime_implementation_allowed` from `false` in a later approved artifact.

## Validation Expectations

Docs review should confirm:

- The ADR and PR body both state `runtime_implementation_allowed: false`.
- Examples are redacted and content-free.
- Observed evidence, historical design input, and inference are separated.
- Platform-mediated dispatch IDs are preferred when Platform can return them.
- Durable work items and workGraph edges are required for child-agent
  delegation identity.
- Governed `ToolExecution` IDs are first-class identity.
- Raw call IDs are evidence references, not durable identity.
- Task/context identity persists across input requests, peer replies, resume,
  and completion.
- Ambiguous queues are refused.
- Whole-operation budgets include initial send plus polling.
- Timeout parsing is finite and external state names are normalized.
- Readiness covers bootstrap, remote-runner identity, identity, app setup,
  credential readiness, and capability readiness.
- Kyverno is scoped to Kubernetes admission, policy, webhook,
  namespace/resource invariant, and manifest-shape compatibility for GitOps
  manifests, not generic deploy health or secret-value validation.
- Credential references and capability grants are used instead of raw secrets.

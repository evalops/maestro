# Platform AgentRuntime Session Bridge

This document explains how Maestro records hosted session starts in Platform
AgentRuntime and why the bridge is shaped as a small adapter instead of a new
runtime owner.

## Overview

Maestro remains the source of truth for the live headless runtime: session
ownership, connection leases, prompt execution, approval mode, and local
workspace state all stay in Maestro. Platform AgentRuntime receives a durable
projection of that session start and, when Platform returns a leased run
handle, a best-effort stream of hosted runtime progress. Platform can correlate
work across A2A tasks, AgentRuntime runs, traces, worker queues, hosted-runner
health, and timeline views without owning the live session.

The bridge is intentionally anchored by session start:

1. A headless session is created or attached.
2. Maestro records a Platform AgentRuntime trigger.
3. Platform returns an AgentRun, or an A2A task that maps back to an AgentRun.
4. Maestro stores correlation handles on the hosted-runner context.
5. If the AgentRun includes a lease token, Maestro records turn, tool, wait,
   and resume progress back to Platform.
6. When a managed hosted-runner drain explicitly flushes the active runtime,
   Maestro completes or fails the Platform run.

Maestro does not let Platform mutate the live runtime in this path. If the
Platform write fails or is not configured, the headless session still starts.

## Key Code Paths

| File | Responsibility |
|------|----------------|
| `src/server/handlers/headless-sessions.ts` | Starts headless runtimes, chooses session ownership, captures HTTP trace context, and stores hosted-runner correlation fields. |
| `src/server/hosted-agent-runtime-progress.ts` | Converts hosted runtime events into leased AgentRuntime step, wait, resume, complete, and fail writes. |
| `src/server/handlers/hosted-runner-drain.ts` | Defines the explicit terminal lifecycle boundary for successful or interrupted hosted-runner drains. |
| `src/platform/agent-runtime-client.ts` | Builds Platform AgentRuntime triggers, normalizes Connect responses, selects the Connect or A2A transport, and maps A2A task metadata back into AgentRuntime-shaped results. |
| `src/platform/a2a-client.ts` | Implements the A2A HTTP/JSON facade: agent-card discovery, message send, task lookup, Platform headers, and trace propagation. |

## Transport Choice

The default path uses Platform Connect `AgentRuntimeService.HandleTrigger`.
That is the narrowest adapter for Maestro's internal Platform contract and
keeps request and response shapes close to the generated proto names.

When `MAESTRO_AGENT_RUNTIME_A2A_ENABLED` or `MAESTRO_PLATFORM_A2A_ENABLED` is
enabled, Maestro uses the A2A facade instead. The A2A path exists because
production AgentRuntime can expose the same trigger as a protocol-native
`message:send` task. The bridge still returns a
`PlatformAgentRuntimeHandleTriggerResult` so upstream Maestro code does not
fork on transport.

Dedicated A2A environment variables win over shared AgentRuntime variables. If
no dedicated A2A value is configured, the bridge reuses the shared
AgentRuntime service base URL, token, organization, workspace, timeout, and
retry settings. This lets a managed deployment switch transports without
duplicating every secret.

## Idempotency And Correlation

The bridge derives these stable identifiers from the workspace and Maestro
session:

- `channelId`: `maestro-session:<session_id>`
- `idempotencyKey`: `maestro-session:<workspace_id>:<session_id>`
- `correlationId`: `maestro-session:<session_id>`
- A2A `contextId`: `maestro-session:<session_id>`
- A2A `messageId`: the same value as the idempotency key

The idempotency key is workspace-scoped so two workspaces can reuse a Maestro
session id without colliding in Platform. The correlation id is session-scoped
because logs, health checks, and support traces usually start from a visible
Maestro session id.

## Trace Context

Trace context is projected in both transport layers:

- HTTP headers: `traceparent` and `tracestate`
- Platform trigger channel attributes
- Platform trigger payload `trace_context`
- A2A message metadata
- A2A task metadata, when returned by Platform

Explicit input trace context takes precedence. Environment fallback is only
used when the caller did not provide trace fields. A partial explicit context
with only `traceparent` must not silently attach a stale `TRACESTATE` from the
process environment.

The headless HTTP handler reads `traceparent` from the current request context
and passes it into the Platform bridge. That ties the incoming user/API request
to the Platform AgentRuntime trigger and the later A2A task lookup.

## Boundary Normalization

`agent-runtime-client.ts` accepts both camelCase and snake_case fields at the
Platform boundary. That is deliberate. Connect JSON, protojson, smoke fixtures,
and older Platform service revisions can differ in field casing even when the
semantic contract is the same.

Normalization is kept inside the Platform client rather than spread across
server handlers. The rest of Maestro consumes stable TypeScript shapes such as
`PlatformAgentRun`, `PlatformAgentRunStep`, `PlatformAgentRunWait`, and
`PlatformRuntimeEvent`.

The normalizers are tolerant of extra fields but strict where Maestro needs a
usable handle. For example, a response without a run id is rejected because
there is no durable correlation key to store.

## Hosted-Runner State

Hosted-runner context stores only the Platform handles that operators and
support tools need:

- `agentRunId`
- `agentRuntimeLeaseToken`
- `a2aMessageId`
- `a2aTaskId`
- `agentRuntimeWorkerQueue`
- `agentRuntimeCorrelationPath`

The lease token is used only inside the hosted runtime process for progress
writes. Health and identity endpoints surface the support-grade ids, not the
lease token. These fields are not a replacement for the headless runtime
snapshot. They let Platform, deploy smoke tests, and support workflows join a
Maestro session to the AgentRuntime run and A2A task without granting them
ownership of the live session.

## Runtime Progress Projection

`hosted-agent-runtime-progress.ts` listens to the local headless runtime event
stream and records only structural progress metadata:

- `turn_start` and `turn_end` become model-call steps.
- Tool starts become tool-intent steps; tool ends become tool-result or error
  steps.
- Pending server requests become AgentRuntime waits with checkpoints.
- Server-request resolutions resume the matching AgentRuntime wait.
- Successful hosted-runner drain completes the Platform run.
- Interrupted hosted-runner drain records a terminal error step and fails the
  Platform run.

The recorder is deliberately inert unless the hosted-runner context has both
`agentRunId` and `agentRuntimeLeaseToken`. Writes are queued in order and
logged as warnings on failure; a Platform outage must not interrupt local
prompt execution. Tool arguments are summarized as key names instead of copied
into Platform progress payloads.

Terminal `CompleteRun` / `FailRun` calls are tied to hosted-runner drain,
including Kubernetes preStop and process shutdown. Generic idle disposal is not
a terminal signal because headless sessions can be disconnected and later
resumed. The current Platform client has no `CancelRun` helper, so interrupted
drains are represented with `FailRun` and a non-retryable drain error.

## Failure Behavior

The bridge is best-effort for session-start and runtime-progress recording:

- Missing Platform config returns `null`.
- Platform/A2A failures return `null`.
- Progress writes no-op without a run id and lease token.
- Progress write failures are logged and later progress writes continue.
- Abort errors are rethrown so shutdown and request cancellation still behave
  correctly.
- The headless session continues even when the Platform record is unavailable.

This split is important: AgentRuntime correlation should improve operations and
auditability, but it should not become a second availability dependency for
starting a Maestro session.

## Changing This Bridge

When changing the bridge, verify the behavior at all three layers:

1. Unit tests for request shape and normalization:
   `npm run test -- test/platform/agent-runtime-client.test.ts test/platform/a2a-client.test.ts`
2. Runtime-progress tests for step, wait, resume, and failure-safe behavior:
   `npm run test -- test/server/hosted-agent-runtime-progress.test.ts`
3. Hosted-runner drain tests for terminal complete/fail semantics:
   `npm run test -- test/server/hosted-runner-drain.test.ts`
4. Headless-session tests for hosted-runner correlation:
   `npm run test -- test/web/headless-sessions.test.ts`
5. Managed deployment smoke tests for live A2A trace projection in `evalops/deploy`.

Keep new code behind this adapter boundary. Server handlers should pass
session facts into the bridge and store returned correlation handles; they
should not know whether the active transport is Connect or A2A.

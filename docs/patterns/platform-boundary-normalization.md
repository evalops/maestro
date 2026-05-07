# Platform Boundary Normalization

Use this pattern when Maestro calls a Platform service whose wire response may
arrive as Connect JSON, protojson, a smoke-test fixture, or an older service
revision.

## Problem

Platform contracts often have one semantic field with several wire spellings:

- `runId` and `run_id`
- `workerQueue` and `worker_queue`
- `latestCheckpoint` and `latest_checkpoint`
- `traceparent` and `trace_parent`

If each caller handles those variants inline, Maestro accumulates duplicate
case-conversion logic and subtle differences in failure behavior.

## Pattern

Keep normalization at the Platform client boundary:

1. Accept `unknown` payloads from the wire.
2. Pick only the fields Maestro needs.
3. Support known casing variants in one helper.
4. Return a stable Maestro-owned TypeScript interface.
5. Throw only when the missing field prevents durable correlation.

The current example is `src/platform/agent-runtime-client.ts`, where helpers
such as `pickString`, `normalizeRun`, `normalizeLease`, `normalizeStep`,
`normalizeWait`, and `normalizeEvent` convert Platform responses into
`PlatformAgentRun` and `PlatformRuntimeEvent`.

## Why This Abstraction Exists

The abstraction is not meant to hide Platform. It localizes wire compatibility
so the rest of Maestro can use a typed, stable shape while Platform evolves its
proto/JSON surface.

That matters for runtime bridges because the server handler only needs to know
whether it has a durable `run.id`, task id, trace id, or worker queue. It should
not need to know whether those values came from Connect JSON, A2A metadata, or
an older snake_case fixture.

## Guidelines

- Keep the normalizer close to the service client, not in UI or HTTP handlers.
- Preserve explicit zero values with numeric checks such as
  `Number.isFinite(value)`; do not use truthiness for lease or retry fields.
- Compact optional string attributes before sending them to Platform so empty
  headers and channel attributes do not become misleading correlation data.
- Treat unknown extra fields as harmless.
- Reject payloads that cannot provide a durable id needed by downstream state.

## Consumers

- `src/platform/agent-runtime-client.ts`
- `src/platform/a2a-client.ts`
- `src/server/handlers/headless-sessions.ts`
- `docs/design/PLATFORM_AGENT_RUNTIME_SESSION_BRIDGE.md`

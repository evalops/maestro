# Durable Objects Session Hub (Design)

## Summary

Introduce an optional Durable Objects (DO) "session hub" that coordinates multi-client sessions
(Web, Slack, IDE, TUI) and fans out live updates. The hub is the authoritative session state
and streaming coordinator. The agent runner (Maestro runtime + tools) remains external.

This design treats DOs as the **session control plane** (state + fan-out) while the runner
handles **execution plane** (tool calls, file edits, tests, model calls).

## Goals

- Multi-client session sync with live streaming updates.
- Cheap idle sessions via DO WebSocket hibernation.
- Deterministic ordering per session (single-threaded DO execution).
- Clear separation between hub (state) and runner (execution).

## Non-goals

- Running tools or shell commands inside DOs.
- LLM calls inside DOs.
- Full replacement of current local/server session storage (initially).

## Architecture Overview

```
Clients (Web/Slack/IDE/TUI)
        \    |    /
          [Session Hub Worker]
                 |
            [Session DO]
                 |
           Runner/Webhook
```

### Components

- **SessionHub Worker**: HTTP + WS router. Validates auth and forwards to Session DO.
- **SessionHub DO**: One object per session. Stores session state + event log, manages
  WebSocket clients, and fan-out.
- **Runner**: Maestro runtime that executes tools and sends event updates to the Session DO.

## Data Model (SQLite-backed DO recommended)

- `sessions`:
  - `id` (text primary key)
  - `created_at` (integer)
  - `updated_at` (integer)
  - `title` (text nullable)
  - `model_id` (text nullable)
- `participants`:
  - `session_id` (text)
  - `user_id` (text)
  - `role` (text)
  - `last_seen` (integer)
- `events`:
  - `id` (text primary key)
  - `session_id` (text)
  - `seq` (integer)
  - `type` (text)
  - `payload` (json)
  - `ts` (integer)

Notes:
- `seq` is a monotonically increasing per-session sequence.
- Payloads should be compact; large blobs go to external storage.

## Protocol

### WebSocket

- Client -> Hub
  - `hello` (client metadata, session ID)
  - `ack` (last received seq)
  - `ping` (keepalive)
  - `request_state` (explicit resync)

- Hub -> Client
  - `state` (snapshot, optional)
  - `event` (seq, payload)
  - `info` (warnings, throttling)

### HTTP (Runner -> Hub)

- `POST /sessions/:id/events` ingest event (tool calls, deltas, usage updates)
- `GET /sessions/:id/events?since=<seq>&limit=<n>` replay events
- `POST /sessions/:id/state` update session metadata
- `GET /sessions/:id/state` snapshot fetch for reconnection

## Hibernation & Rehydration

- Use Durable Objects **native WebSocket API** (`acceptWebSocket`, `getWebSockets`).
- For each socket, call `serializeAttachment()` with small metadata:
  - user ID
  - client type
  - last_ack_seq
- On constructor:
  - Read session state + last seq from SQLite
  - Rebuild in-memory maps for sockets based on attachments

## Constraints & Operational Behaviors

- Hibernation occurs after ~10 seconds of inactivity if all criteria are met
  (no timers, no pending fetches, native WebSocket API only, and no active events).
- If not hibernateable, objects may be evicted after ~70–140 seconds of inactivity.
- Attachment size for `serializeAttachment()` is capped at 2,048 bytes.
- Per-object storage limit is 10 GB and key+value size is capped at 2 MB.
- WebSocket messages can be up to 32 MiB (received).
- CPU per request (including WebSocket messages) defaults to 30 seconds and can be raised.
- Soft throughput limit per object is ~1,000 requests/sec.
- Global uniqueness is enforced on event start and storage access; long events that never
  touch storage can become stale if the object is replaced during network partitions or
  code updates.

## Error Handling & Overload

- If DO is overloaded, return an error and rely on client backoff.
- Avoid retrying non-idempotent writes from the runner.

## Security & Auth

- Worker validates auth (JWT / GitHub OAuth) and maps user -> session access.
- Session DO enforces ACL on every event.

## Failure Modes & Mitigations

- **Stale DO instance**: touch storage early during each event; compare `session_epoch` to
  detect replacement.
- **Large payloads**: cap payload size; spill to object storage and send references.
- **Hibernation blocked**: avoid timers/fetches in DO; use alarms for scheduled tasks.
- **Event gaps**: if `since` is too old, respond with a snapshot + gap marker to force a resync.

## Rollout Plan

1. Add DO hub as optional feature flag.
2. Mirror SSE stream in parallel for web UI (dual-write to SSE + DO).
3. Cutover web UI to DO stream; keep server fallback.
4. Add Slack/IDE session fan-out.

## Open Questions

- Do we expose the DO hub externally (public API) or keep it internal?
- Do we use Agents SDK (`Agent`, `AgentClient`) for the hub or raw DO APIs?
- How do we authenticate runner -> hub (signed internal tokens vs. mTLS)?

## Sources

- Cloudflare Durable Objects lifecycle + hibernation
- Cloudflare Durable Objects limits
- Cloudflare Durable Objects WebSocket hibernation API
- Cloudflare Durable Objects known issues

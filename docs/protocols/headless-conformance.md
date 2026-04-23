# Headless Runtime Conformance

Maestro's hosted runtime contract is protocol-first. The current TypeScript
web/headless host and the target Rust runtime should both satisfy the same
observable session behavior before Platform or deploy code depends on a runner
implementation detail.

The executable suite starts in
[`test/headless/runtime-conformance.test.ts`](../../test/headless/runtime-conformance.test.ts).
It defines a small runtime adapter, then runs the same scenarios against the
current TypeScript in-process host. A future Rust-hosted runner should add an
adapter that drives the same operations over HTTP/SSE, stdio, or another
transport without changing the scenario body.

Local command:

```bash
npm run test -- test/headless/runtime-conformance.test.ts
```

## Contract Areas

The first conformance tranche covers:

- schema-valid runtime snapshots, subscription snapshots, stream envelopes, and
  heartbeat snapshots
- controller and viewer attach behavior
- viewer read-only enforcement
- explicit controller lease takeover
- cursor replay ordering and reset snapshots for replay gaps
- approval server request emission and protocol response resolution
- hosted workspace-root enforcement for file reads
- disconnect behavior that clears subscriptions and controller leases without
  destroying the runtime state

These cases intentionally avoid external model calls. They use a deterministic
fake agent and local scratch workspaces so CI can run them as protocol tests,
not as provider integration tests.

## Adapter Expectations

A conforming adapter should expose these operations:

- start or attach a runtime session with a stable scope key and session id
- subscribe controller and viewer connections
- attach an event stream from a cursor
- send protocol messages with explicit role and subscription or connection ids
- heartbeat a connection or subscription
- disconnect a connection or subscription
- replay events from a cursor or return a reset snapshot for gaps
- trigger deterministic approval/request fixtures for server-request coverage

The TypeScript adapter uses `HeadlessInProcessHost` to avoid HTTP server
bookkeeping. The Rust adapter should drive the external runtime surface so this
suite verifies true wire behavior rather than Rust internals.

## Reference Patterns

The downloaded reference tree at `/Users/jonathanhaas/Downloads/src` reinforces
three design choices this suite should keep enforcing:

- remote sessions need a durable control session plus a replayable event stream,
  not a single fragile socket
- read-only viewers and controller ownership must be enforced before mutating
  messages enter the runtime
- reconnect/replay paths should tolerate transient disconnects while treating
  authorization and ownership failures as terminal until the client reattaches
  intentionally

This matches Maestro's current cursor/reset envelopes, controller leases,
heartbeat calls, and hosted workspace-root checks.

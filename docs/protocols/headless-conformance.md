# Headless Runtime Conformance

Maestro's hosted runtime contract is protocol-first. The current TypeScript
web/headless host and the target Rust runtime should both satisfy the same
observable session behavior before Platform or deploy code depends on a runner
implementation detail.

The executable suite starts in
[`test/headless/runtime-conformance.test.ts`](../../test/headless/runtime-conformance.test.ts).
It defines a small runtime adapter, then runs the same scenarios against the
current TypeScript in-process host. It also includes a Rust adapter that
spawns `hosted_runner_conformance_fixture` and drives
`maestro_tui::hosted_runner::start_hosted_runner_with_message_executor` through
the external HTTP/SSE endpoints.

The provider-neutral hosted runner shape that these scenarios protect is defined
in [Hosted Runner Contract](./hosted-runner-contract.md).

Local command:

```bash
npm run test -- test/headless/runtime-conformance.test.ts
```

Rust hosted-runner wire check:

```bash
MAESTRO_RUST_HOSTED_CONFORMANCE=1 npm run test -- test/headless/runtime-conformance.test.ts
```

CI runs the Rust-hosted command as the dedicated
`rust-hosted-conformance` job. The environment flag remains the local switch
that chooses whether this file runs only the TypeScript in-process adapter or
also starts the Rust fixture.

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
- hosted utility command/search/watch lifecycle
- hosted drain/snapshot handoff, including manifest export paths and post-drain
  mutation rejection
- disconnect behavior that clears subscriptions and controller leases without
  destroying the runtime state

These cases intentionally avoid external model calls. They use deterministic
fake/fixture agents and local scratch workspaces so CI can run them as protocol
tests, not as provider integration tests.

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
- drain hosted runtimes into a provider-neutral snapshot manifest when the
  adapter exposes hosted lifecycle hooks

The TypeScript adapter uses `HeadlessInProcessHost` to avoid HTTP server
bookkeeping. The Rust adapter uses a deterministic fixture binary so the shared
suite verifies true wire behavior rather than Rust internals. The fixture
handles prompts and approvals deterministically while Maestro's Rust server owns
leases, replay, SSE, snapshots, workspace utilities, heartbeat, and disconnect
semantics.

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

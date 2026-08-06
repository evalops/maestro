# Maestro Rendezvous Parallel Startup Design

Date: 2026-08-05

## Context

Maestro main `f9c7c880842369f8db09e18e05cbb6e9d9b3eebb` already contains the outbound rendezvous runtime from PR #3335. It exchanges a dedicated tuple-bound ClientAuth identity, rotates that identity, opens the carrier, preserves inbound/shadow/outbound authority gates, and revokes outbound authority on disconnect.

Two serial startup boundaries remain:

1. `start_hosted_runner_with_message_executor` awaits the server certificate before requesting the rendezvous client certificate.
2. `start_hosted_runner_cli_runtime` awaits headless readiness before beginning hosted-runner workspace, identity, restore, and listener preparation.

This design removes those waits in two separately reviewable PRs without changing command authority or deployment defaults.

## Invariants

- No rendezvous configuration remains equivalent to inbound mode and never requests a client certificate or dials outbound.
- `outbound_shadow` may establish a carrier but inbound remains command-authoritative.
- `outbound` becomes command-authoritative only after the existing exact `Accepted` barrier grants runtime authority.
- Readiness is not published until headless and hosted-runner preparation have both succeeded.
- Any startup failure cancels or drops the concurrent sibling operation and leaves no listener, identity rotation, carrier, or child task orphaned.
- Client identities retain the exact tuple URI, ClientAuth-only EKU, bounded lifetime, CA validation, rotation, and connection revocation already merged in #3335.
- Replay, activation rotation, bounded queues, and N/N-1 framing behavior are unchanged.

## PR 1: Parallel Initial Certificate Exchanges

Introduce a small identity-startup helper used by `start_hosted_runner_with_message_executor`.

- With no rendezvous configuration, await only the existing server identity exchange.
- With rendezvous configured, poll the server and rendezvous-client exchange futures together with `tokio::try_join!`.
- Return both identities only after both validate successfully.
- If either exchange fails, cancel the sibling future by dropping it and fail startup before binding or advertising readiness.
- Keep server and client rotation as independent existing tasks after startup.

Primary files:

- `packages/tui-rs/src/hosted_runner.rs`
- `packages/tui-rs/src/hosted_runner/workload_identity.rs`
- focused tests beside the identity/startup code

Regression test: a local identity fixture holds each response until it observes both requests. The current serial implementation times out; the parallel implementation completes. Additional assertions cover server-only inbound startup and fail-closed cancellation when either exchange rejects.

## PR 2: Parallel Headless and Hosted-Runner Preparation

Split hosted-runner startup into preparation and activation while retaining the current public entry point.

Preparation owns only reversible resources:

- normalize and validate configuration;
- canonicalize the workspace and load restore state;
- perform initial server/client identity exchange;
- bind and retain the inbound listener.

Activation receives the prepared state plus the ready message executor, constructs `SharedRunner`, starts the event pump, listener, identity rotation, and rendezvous tasks, then publishes readiness.

`start_hosted_runner_with_message_executor` remains source-compatible by calling prepare and activate sequentially. The CLI path concurrently polls:

- supervisor connect plus the existing headless-ready barrier; and
- hosted-runner preparation.

Only after both succeed does it construct the executor and activate the prepared hosted runner. The operations are joined as futures rather than detached tasks so failure drops sibling resources deterministically.

Primary files:

- `packages/tui-rs/src/hosted_runner_cli.rs`
- `packages/tui-rs/src/hosted_runner.rs`
- `packages/tui-rs/src/hosted_runner/handle.rs` only if prepared-resource ownership requires it
- focused CLI and hosted-runner tests

Regression tests use synchronization barriers rather than wall-clock thresholds to prove both startup branches are polled concurrently. Failure tests prove that headless failure drops prepared listener/identity state, preparation failure prevents activation, and readiness is never emitted early. Existing rendezvous authority, replay, rotation, and readiness-revocation suites run unchanged.

## Verification and Delivery Boundaries

Each PR will run formatting, diff checks, focused rendezvous/startup tests, the hosted-runner library suite, `cargo check`, and clippy with warnings denied. PR 2 will be stacked on PR 1 only while PR 1 is under review, then rebased or retargeted to current main without rewriting shared history.

These PRs prove source behavior and local/hosted tests only. They do not prove image publication, deployment, Platform reachability, a live outbound activation, or a latency improvement in production. Paired activation and first-command/frame samples remain a separate post-promotion benchmark gate.

# Parallel Initial Rendezvous Identity Exchanges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Request and validate the initial hosted-runner ServerAuth and rendezvous ClientAuth certificates concurrently when outbound rendezvous is configured.

**Architecture:** Add one private future-joining helper in `hosted_runner.rs`. The existing startup path supplies the real server and client exchange futures to it, while inbound-only startup continues to await only the server exchange. No tasks are spawned and `try_join!` drops the sibling future on error.

**Tech Stack:** Rust, Tokio, `tokio::try_join!`, existing Maestro hosted-runner tests.

## Global Constraints

- Preserve inbound, outbound-shadow, and outbound single-authority behavior.
- Do not bind the listener or publish readiness unless every required identity validates.
- Do not weaken exact tuple URI, EKU, CA, expiry, rotation, replay, or queue checks.
- Do not add a deployment or live-latency claim.

---

### Task 1: Prove concurrent future polling

**Files:**
- Modify: `packages/tui-rs/src/hosted_runner.rs`
- Test: `packages/tui-rs/src/hosted_runner/tests.rs`

**Interfaces:**
- Produces: `join_initial_identity_exchanges(server, client) -> Result<(S, C), E>` as a private async helper over two futures with the same error type.
- Consumes: the existing `exchange_initial()` and `exchange_client_initial(&Url)` futures.

- [ ] **Step 1: Write the failing synchronization test**

Add a Tokio test that creates two futures. Each future signals that it has started and waits for the other signal before returning `Ok`. Wrap `join_initial_identity_exchanges` in a short timeout and assert it returns both values. Before the helper exists, the test must fail to compile because the named production function is absent.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p maestro-tui initial_identity_exchanges_are_polled_concurrently --locked`

Expected: compilation fails because `join_initial_identity_exchanges` is not defined.

- [ ] **Step 3: Implement the minimal helper**

Implement:

```rust
async fn join_initial_identity_exchanges<SF, CF, S, C, E>(
    server: SF,
    client: CF,
) -> Result<(S, C), E>
where
    SF: Future<Output = Result<S, E>>,
    CF: Future<Output = Result<C, E>>,
{
    tokio::try_join!(server, client)
}
```

- [ ] **Step 4: Verify GREEN**

Run the focused test again and require one pass with no failures.

- [ ] **Step 5: Commit the independently tested helper**

Commit only the helper and synchronization test as `test(hosted-runner): prove parallel identity polling`.

### Task 2: Use the helper in hosted-runner startup

**Files:**
- Modify: `packages/tui-rs/src/hosted_runner.rs:1498-1575`
- Test: `packages/tui-rs/src/hosted_runner/tests.rs`

**Interfaces:**
- Consumes: `join_initial_identity_exchanges` from Task 1.
- Preserves: `Option<(Arc<WorkloadIdentityExchanger>, ReloadableServerIdentity, Option<ReloadableClientIdentity>, HostedRunnerWorkloadIdentityConfig)>` startup state.

- [ ] **Step 1: Add a failing source-path regression**

Add a focused test around a small private selector that asserts rendezvous mode passes both real exchange futures through the concurrent helper while inbound-only mode never constructs or polls a client exchange future. Use an atomic poll counter for the client future.

- [ ] **Step 2: Verify RED**

Run both initial-identity focused tests and confirm the new selector test fails for the missing production path.

- [ ] **Step 3: Replace the serial awaits**

When `config.rendezvous` is present, construct both exchange futures and await them through `join_initial_identity_exchanges`. Wrap the returned client identity in `ReloadableClientIdentity`. When rendezvous is absent, retain the existing server-only exchange. Map either failure through the existing startup error and telemetry path before listener binding.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```sh
cargo test -p maestro-tui initial_identity_exchanges --locked
cargo test -p maestro-tui rendezvous --locked
cargo test -p maestro-tui --lib hosted_runner:: --locked
```

- [ ] **Step 5: Commit PR 1 implementation**

Commit the startup path and regression as `perf(hosted-runner): parallelize initial identity exchanges`.

### Task 3: Verify and publish PR 1

**Files:**
- Verify the complete branch diff from its exact base.

- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `git diff --check origin/main...HEAD`.
- [ ] Run `cargo check -p maestro-tui --locked`.
- [ ] Run `cargo clippy -p maestro-tui --lib --tests --locked -- -D warnings`.
- [ ] Re-run the focused and hosted-runner suites from Task 2.
- [ ] Push `agent/maestro-rendezvous-parallel-startup` and open a draft PR to `main` with explicit source-only and no-live-proof boundaries.

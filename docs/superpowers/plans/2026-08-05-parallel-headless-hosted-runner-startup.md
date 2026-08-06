# Parallel Headless and Hosted-Runner Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overlap headless connect/readiness with reversible hosted-runner workspace, identity, restore, and listener preparation without publishing readiness early.

**Architecture:** Split hosted-runner startup into `prepare_hosted_runner` and `start_prepared_hosted_runner`. Keep the existing public function as a sequential compatibility wrapper. The CLI joins preparation with headless startup as owned futures, constructs the executor only after both succeed, then activates tasks and readiness.

**Tech Stack:** Rust, Tokio futures, existing `AgentSupervisor`, `TcpListener`, cancellation tokens, hosted-runner CLI tests.

## Global Constraints

- PR 2 is stacked on PR 1 while under review and must identify that dependency.
- No background task may start before both preparation branches succeed.
- Readiness, carrier authority, replay, rotation, and bounded queues retain their current contracts.
- Headless child failure after readiness continues to clear readiness and revoke outbound authority immediately.
- No deployment or production-latency claim.

---

### Task 1: Extract reversible hosted-runner preparation

**Files:**
- Modify: `packages/tui-rs/src/hosted_runner.rs:1463-1660`
- Test: `packages/tui-rs/src/hosted_runner/tests.rs`

**Interfaces:**
- Produces: private `PreparedHostedRunner` owning normalized config, restore manifest, initial identity runtime, bound `TcpListener`, local address, startup timestamp, and tracing identity fields.
- Produces: `prepare_hosted_runner(config: HostedRunnerConfig) -> io::Result<PreparedHostedRunner>`.
- Produces: `start_prepared_hosted_runner(prepared, executor) -> io::Result<HostedRunnerHandle>`.
- Preserves: `start_hosted_runner_with_message_executor(config, executor)` as a sequential wrapper.

- [ ] **Step 1: Add a failing lifecycle test**

Add a test proving preparation binds the port but does not start the event pump, listener serve loop, identity rotation, rendezvous carrier, or readiness publication. Dropping `PreparedHostedRunner` must release the bound port.

- [ ] **Step 2: Verify RED**

Run the focused preparation test and confirm compilation fails because `prepare_hosted_runner` is absent.

- [ ] **Step 3: Extract preparation and activation**

Move only reversible setup into `prepare_hosted_runner`. Move `SharedRunner` construction, event-pump start, task spawning, readiness trace, and handle construction into `start_prepared_hosted_runner`. Implement the existing public function by awaiting prepare then activate.

- [ ] **Step 4: Verify GREEN and compatibility**

Run the new preparation test plus the complete hosted-runner library test filter.

- [ ] **Step 5: Commit the extraction**

Commit as `refactor(hosted-runner): split preparation from activation`.

### Task 2: Join headless startup and hosted-runner preparation

**Files:**
- Modify: `packages/tui-rs/src/hosted_runner_cli.rs:210-273`
- Test: `packages/tui-rs/src/hosted_runner_cli.rs:677-end`

**Interfaces:**
- Consumes: `prepare_hosted_runner` and `start_prepared_hosted_runner` from Task 1.
- Produces: private `join_hosted_runner_startup(headless_future, preparation_future)` helper used by the CLI.

- [ ] **Step 1: Add the failing barrier test**

Create two owned futures that each announce first poll and wait for the other branch. Assert the join helper completes within a timeout. Add drop guards and separate tests proving an error in either future drops its sibling.

- [ ] **Step 2: Verify RED**

Run `cargo test -p maestro-tui hosted_runner_startup_branches --locked` and confirm the missing helper causes failure.

- [ ] **Step 3: Implement concurrent CLI orchestration**

Move supervisor connect plus `await_headless_ready` into one future. Pass `config.runner` to `prepare_hosted_runner` as the other future. Await both with `tokio::try_join!`; build the executor from the ready supervisor; call `start_prepared_hosted_runner`. Do not use `tokio::spawn`.

- [ ] **Step 4: Verify GREEN and failure cleanup**

Run the barrier/drop tests, existing CLI startup tests, rendezvous tests, and hosted-runner library suite.

- [ ] **Step 5: Commit concurrency wiring**

Commit as `perf(hosted-runner): overlap headless and identity startup`.

### Task 3: Verify and publish PR 2

**Files:**
- Verify the full stacked diff and the PR-2-only diff from the PR 1 head.

- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `git diff --check <PR1_HEAD>...HEAD`.
- [ ] Run `cargo check -p maestro-tui --locked`.
- [ ] Run `cargo clippy -p maestro-tui --lib --tests --locked -- -D warnings`.
- [ ] Run focused CLI/startup, rendezvous, and hosted-runner suites.
- [ ] Push a separate branch and open a draft PR based on the PR 1 branch, documenting the dependency and source/live boundary.

# Maestro Correctness and Operational Safety Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:executing-plans** to implement this plan task-by-task.

**Goal:** Remove four proven correctness and operational-safety defects in Maestro's print mode, provider streaming, checkpoint storage, and Helm health checks.

**Architecture:** Keep each fix at its existing ownership boundary. Print mode remains the sole policy/execution owner for print-mode tool calls; the AI client treats abnormal stream closure as a terminal error; checkpoint storage gets an injective versioned session key while retaining legacy read/remove compatibility; the chart probes the control-plane health endpoint and guards that contract with a repository test.

**Tech Stack:** Rust, Tokio, Node.js `node:test`, Helm YAML, GitHub Actions.

## Global Constraints

- Preserve existing public APIs and runtime behavior outside the four affected paths.
- Do not commit, push, open, or merge a pull request during this pass.
- Run focused tests after each subsystem change, then run formatting and the relevant workspace checks.
- Keep legacy checkpoint directories readable and removable; new writes must use the collision-proof key.

---

## Task 1: Make print mode own every tool execution exactly once

**Files:**
- Modify: `packages/tui-rs/src/print_mode.rs`
- Test: `packages/tui-rs/src/print_mode.rs`

- [x] Add a print-mode approval-mode helper that documents the caller-owned execution contract and returns `ApprovalMode::Safe`.
- [x] Use that helper when constructing `NativeAgentConfig`, so native emits every print-mode tool call as approval-gated instead of auto-executing selective-safe calls.
- [x] Add a regression test pinning the print-mode configuration to the host-owned approval boundary.
- [x] Run `cargo test --locked -p maestro-tui print_mode`.

## Task 2: Surface abnormal provider stream closure

**Files:**
- Modify: `packages/ai-rs/src/client.rs`
- Test: `packages/ai-rs/src/client.rs`

- [x] Change the idle-policy forwarder so a receiver closing without `MessageStop` or `Error` retries before committed content and otherwise emits a terminal error.
- [x] Add tests for retrying an empty closed attempt, refusing to retry after partial content, and reporting exhaustion when all attempts close without a terminal event.
- [x] Run `cargo test --locked -p maestro-ai stream_idle_policy`.

## Task 3: Make checkpoint session directories collision-proof

**Files:**
- Modify: `packages/tui-rs/src/checkpoints.rs`
- Test: `packages/tui-rs/src/checkpoints.rs`

- [x] Add an injective, path-safe `v2~` hexadecimal session component for all new checkpoint roots.
- [x] Retain the legacy sanitized root as a read/remove fallback, with v2 data taking precedence when checkpoint IDs overlap.
- [x] Route checkpoint directory access through sanitized IDs so manifest contents cannot select an arbitrary path.
- [x] Add tests proving colliding session IDs get distinct roots and that the new root remains under `sessions/checkpoints`.
- [x] Run `cargo test --locked -p maestro-tui checkpoints`.

## Task 4: Probe the real control-plane health endpoint

**Files:**
- Modify: `deploy/helm/maestro/templates/deployment.yaml`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Add: `scripts/check-helm-probes.test.mjs`

- [x] Change liveness and readiness probes from `/health` to `/healthz`.
- [x] Add a Node regression test that requires both probe paths to be `/healthz` and rejects the SPA-shell `/health` path.
- [x] Expose the check through `npm run check:helm-probes`, include it in the root check, and run it in CI.
- [x] Run `npm run check:helm-probes`.

## Final Verification

- [x] Run `cargo fmt --all -- --check`.
- [x] Run the focused Rust tests for all changed packages and the Helm probe test.
- [x] Run `cargo test --workspace --locked --all-targets` if the local environment permits it.
- [x] Inspect `git diff` and `git status --short`; leave the branch uncommitted and report any checks that could not run.

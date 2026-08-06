# Managed Policy Publisher and Audit Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated enterprise control-plane caller publish a policy envelope signed out-of-process by the customer’s KMS/HSM, while Maestro validates, activates, and exposes durable rollout/audit status.

**Architecture:** Maestro remains a verifier and policy consumer; it never accepts or stores private signing keys. A customer-owned KMS/HSM signs the existing canonical envelope, and the authenticated publish endpoint validates the signature, scope, expiry, and monotonic version before atomically replacing the configured managed-policy file. A bounded JSONL audit log records accepted and rejected publication attempts, and authenticated status/audit endpoints expose only safe metadata.

**Tech Stack:** Rust 2021, ring Ed25519 verification, serde/serde_json, Tokio control plane, atomic filesystem writes, JSONL audit records, existing CSRF/auth boundaries.

## Global Constraints

- Keep managed policy opt-in through `MAESTRO_MANAGED_POLICY_PATH`; absent configuration keeps existing local-policy behavior.
- Never accept, log, persist, or return private key material; signing remains external to Maestro.
- Preserve fail-closed signature, scope, expiry, rollback, and kill-switch behavior.
- Publish only exact `ManagedPolicyEnvelope` values that verify against the configured public key and key ID.
- Require the existing authenticated and CSRF-protected control-plane boundary for publish and audit routes.
- Bound audit reads to at most 100 records and omit policy bodies, signatures, and public keys from responses.
- Do not add a marketplace, plugin registry, or broad policy language in this slice.

---

### Task 1: Add safe managed-policy publication and durable audit primitives

**Files:**
- Modify: `packages/tui-rs/src/safety/policy.rs`
- Modify: `packages/tui-rs/src/safety/mod.rs`
- Test: `packages/tui-rs/src/safety/policy.rs` module tests

**Interfaces:**
- Consumes: existing `ManagedPolicyEnvelope`, `ManagedPolicyStatus`, `verify_managed_policy`, `load_managed_policy_watermark`, and `refresh_managed_policy`.
- Produces:
  - `ManagedPolicyPublishResult { published: bool, status: ManagedPolicyStatus }`
  - `ManagedPolicyAuditEvent { event_id: String, action: String, actor: Option<String>, recorded_at: u64, outcome: String, metadata: Option<ManagedPolicyMetadata>, reason: Option<String> }`
  - `pub fn publish_managed_policy(envelope: ManagedPolicyEnvelope) -> Result<ManagedPolicyPublishResult, String>`
  - `pub fn record_managed_policy_audit(event: ManagedPolicyAuditEvent) -> Result<(), String>`
  - `pub fn managed_policy_audit(limit: usize) -> Result<Vec<ManagedPolicyAuditEvent>, String>`

- [x] **Step 1: Write the failing publication/audit regression test.**

  Extend the test environment preservation list with `MAESTRO_MANAGED_POLICY_AUDIT_PATH`. Add `managed_policy_publish_persists_and_audits` that:

  1. Creates a temporary policy path, state path, and audit path.
  2. Configures the existing test Ed25519 public key, org, workspace, and key ID.
  3. Calls `publish_managed_policy(signed_test_envelope(&key_pair, 1, false))`.
  4. Asserts `published == true`, status is valid at version 1, and the policy file exists.
  5. Records an accepted `ManagedPolicyAuditEvent`, reads `managed_policy_audit(10)`, and asserts the actor, action, outcome, and policy version round-trip.
  6. Attempts to publish a tampered envelope and asserts the call errors and the active file bytes remain unchanged.
  7. Publishes version 2, asserts status version 2, then attempts version 1 and asserts a rollback error.

- [x] **Step 2: Run the focused test and confirm it fails for the missing interface.**

  Run:

  ```sh
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-tui managed_policy_publish_persists_and_audits --lib -- --test-threads=1
  ```

  Expected: compilation failure because the publication and audit functions do not yet exist.

- [x] **Step 3: Implement the publication and audit primitives.**

  Add the public result/event types and export them from `safety/mod.rs`. Implement:

  - `publish_managed_policy` requiring an explicit regular `MAESTRO_MANAGED_POLICY_PATH`.
  - Existing `verify_managed_policy` validation before any write.
  - Monotonic comparison with the persisted watermark: reject lower versions and same-version/different-hash changes; allow idempotent same-version/same-hash publication.
  - Atomic envelope replacement using a process-specific temporary sibling and rename; do not write a private key or signature-derived secret.
  - Forced refresh after the write so the response reflects the activated status; a valid kill-switch envelope may return `published: true` with `status.valid: false` and the existing kill-switch error.
  - `MAESTRO_MANAGED_POLICY_AUDIT_PATH`, defaulting to the managed-policy state path plus `.audit.jsonl`.
  - JSONL append with `sync_all`, bounded actor/reason strings, and no policy body. Read audit records newest-first, skip no malformed records silently, and cap `limit` to 100.

- [x] **Step 4: Run the focused test and confirm it passes.**

  Run the command from Step 2. Expected: the named test passes with zero failures.

- [x] **Step 5: Run the existing managed-policy regression suite.**

  Run:

  ```sh
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-tui safety::policy::tests --lib -- --test-threads=1
  ```

  Expected: all managed-policy and existing policy tests pass.

### Task 2: Expose authenticated publish and audit APIs

**Files:**
- Modify: `packages/control-plane-rs/src/extended.rs`
- Modify: `packages/control-plane-rs/src/tests.rs`

**Interfaces:**
- Consumes: `maestro_tui::safety::publish_managed_policy`, `record_managed_policy_audit`, `managed_policy_audit`, and the existing `auth_context`/CSRF checks.
- Produces:
  - `POST /api/admin/enterprise-policy/publish` accepting `{ "envelope": ManagedPolicyEnvelope }`
  - `GET /api/admin/enterprise-policy/audit?limit=50` returning `{ "managedPolicyAudit": [...] }`

- [x] **Step 1: Add route recognition tests for publish and audit.**

  Extend `enterprise_policy_admin_routes_are_implemented` with:

  ```rust
  ("POST", "/api/admin/enterprise-policy/publish"),
  ("GET", "/api/admin/enterprise-policy/audit"),
  ```

- [x] **Step 2: Run the route test and confirm it fails.**

  Run:

  ```sh
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-control-plane enterprise_policy_admin_routes_are_implemented --lib -- --test-threads=1
  ```

  Expected: the test fails because the new paths are not recognized.

- [x] **Step 3: Implement the authenticated endpoints.**

  Add both paths to `is_extended_endpoint`. In `handle_extended_endpoint`, preserve the existing `validate_csrf` and `authorize` calls before dispatch. For publish:

  1. Parse the request body as `{ "envelope": ManagedPolicyEnvelope }`; return 400 for invalid shape/JSON.
  2. Derive the audit actor from the authenticated subject, using `"api-key"` only for unrestricted API-key auth and never echoing an authorization token.
  3. Call `publish_managed_policy`.
  4. Record an accepted event with safe metadata on success, or a rejected event with no untrusted policy metadata on validation failure.
  5. Return 200 with `{ "published": true, "managedPolicy": status }` on activation; return 409 for a rejected envelope; return 500 if the durable audit write fails.

  For audit, parse `limit` as a positive integer defaulting to 50, cap it at 100, call `managed_policy_audit`, and return 500 if the audit file cannot be read. Do not return envelope bodies or signatures.

- [x] **Step 4: Run the exact route test and the control-plane test target.**

  Run:

  ```sh
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-control-plane enterprise_policy_admin_routes_are_implemented --lib -- --test-threads=1
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-control-plane --lib -- --test-threads=1
  ```

  Expected: the route test passes and the full control-plane library test target has zero failures.

### Task 3: Document the customer workflow and audit contract

**Files:**
- Modify: `docs/SAFETY.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `docs/design/GROK_BUILD_PARITY.md`

**Interfaces:**
- Consumes: the published endpoint shape and `MAESTRO_MANAGED_POLICY_AUDIT_PATH`.
- Produces: operator/customer documentation for KMS/HSM signing, publication, rollout status, audit retrieval, and failure behavior.

- [x] **Step 1: Document the external KMS signing workflow.**

  State that the customer’s KMS/HSM signs the existing canonical payload, the private key never enters Maestro, and the resulting envelope is sent to the authenticated publish endpoint. Include the required environment variables and a redacted JSON/curl shape without a real signature or key.

- [x] **Step 2: Document rollout and audit behavior.**

  Explain version monotonicity, atomic activation, 409 rejection, kill-switch activation, audit JSONL retention path, bounded audit reads, and the existing fail-closed behavior.

- [x] **Step 3: Update the parity/threat-model boundary.**

  Mark the publisher/audit lifecycle as the enterprise control-plane transfer, explicitly excluding marketplace/plugin distribution and private-key custody.

### Task 4: Verify, publish, and merge

**Files:**
- Modify: `docs/superpowers/plans/2026-08-05-managed-policy-publisher.md` to record evidence.

- [x] **Step 1: Run formatting and diff checks.**

  ```sh
  cargo fmt --all -- --check
  git diff --check
  ```

- [x] **Step 2: Run focused and full relevant tests.**

  ```sh
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-tui safety::policy::tests --lib -- --test-threads=1
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test -p maestro-control-plane --lib -- --test-threads=1
  CARGO_INCREMENTAL=0 rustup run 1.95.0 cargo test --workspace --locked
  ```

  Record exact pass/fail counts. If the full suite cannot run because of disk quota, record that as an environment blocker and do not claim a green workspace.

- [ ] **Step 3: Review the exact staged scope and commit.**

  ```sh
  git status --short
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "feat(policy): add managed policy publisher and audit"
  ```

- [ ] **Step 4: Push and open a ready PR.**

  ```sh
  git push -u origin agent/managed-policy-publisher
  gh pr create --repo evalops/maestro-internal --base main --head agent/managed-policy-publisher --title "feat(policy): add managed policy publisher and audit"
  ```

- [ ] **Step 5: Wait for protected checks, merge, and verify main.**

  Use `gh pr checks --watch` and inspect exact failing logs if any check fails. Merge only through the protected path. Verify `state: MERGED`, `mergedAt`, `mergeCommit.oid`, fetch `origin/main`, and confirm the merge commit is the current main head.

## Verification evidence

- `cargo fmt --all -- --check` passed after the final source change.
- `git diff --check` passed after the final source change.
- `cargo test -p maestro-tui safety::policy::tests --lib -- --test-threads=1`: 22 passed, 0 failed.
- `cargo test -p maestro-control-plane --lib -- --test-threads=1`: 318 passed, 0 failed.
- `cargo test --workspace --locked`: passed with exit 0; Maestro TUI reported 4,414 passed and 1 pre-existing ignored test, and the workspace doc/package targets completed successfully.
- `cargo clippy --locked -p maestro-tui -p maestro-control-plane --all-targets -- -D warnings` passed after the JSONL append closure fix.

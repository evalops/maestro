# Enterprise Managed Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verifiable organization-managed policy plane to Maestro so enterprise operators can centrally constrain execution, revoke access, and audit the policy that governed each decision.

**Architecture:** A v1 signed policy envelope is verified at the existing `safety::policy` boundary. The verified policy is the upper bound; an optional local policy is intersected with it and can only narrow access. Signature, hash, scope, time, monotonic-version, and kill-switch failures fail closed. The native firewall and typed receipts consume the same verified snapshot. The control plane exposes authenticated status/refresh operations without minting or mutating signed policy.

**Tech Stack:** Rust workspace, `serde`/`serde_json`, `ring` Ed25519 verification, `sha2` SHA-256 policy hashes, existing native firewall/session/control-plane APIs.

## Global Constraints

- Preserve the existing unsigned local-policy contract when managed mode is not configured.
- If `MAESTRO_MANAGED_POLICY_PATH` is configured, missing, malformed, expired, out of scope, rolled back, tampered, or unsigned policy must block execution; never fall back to unsigned policy.
- Local policy may only narrow managed policy. Deny lists and restrictive limits compose conservatively; no local setting can widen a managed allowance.
- The kill switch must block new sessions, model selection, tool admission, and policy checks at the next safe boundary; an already-running external process is not force-killed by this change.
- Do not claim general RBAC, SSO, or tamper-evident storage. Control-plane endpoints remain behind existing API-key/CSRF authorization, and Platform remains responsible for publishing signed bundles and key rotation.
- Do not add a plugin/marketplace surface or weaken any existing safety gate.
- Keep existing session JSON and legacy tool-result fields backward-compatible through optional fields.

---

## Tasks

- [x] **Task 1: Add the signed managed-policy envelope and verifier**
  - Add serializable v1 envelope/payload types with org/workspace scope, version, issued/expiry timestamps, key id, kill-switch reason, policy body, signature, and SHA-256 policy hash.
  - Verify Ed25519 signatures against the configured public key, reject malformed encodings, hash mismatches, unsupported schema versions, invalid time windows, future-issued bundles beyond skew, and scope mismatches.
  - Track the accepted version/hash in process memory and a persistent watermark; reject rollbacks or same-version content changes.
  - Add focused unit tests for valid bundles, tampering, bad signatures, expiry, future issuance, scope, key id, rollback, kill switch, and malformed input.

- [x] **Task 2: Compose managed policy with local policy as a narrowing floor**
  - Keep the existing local policy loader and cache semantics.
  - When managed mode is active, intersect allowed tools/dependencies/models/paths, union blocked values, OR network blocks, conservatively intersect network allowlists, and take the strictest non-zero limits.
  - Ensure all existing policy checks and the direct firewall helpers fail closed on managed-policy verification errors.
  - Add tests proving local policy cannot widen managed policy and that invalid managed state never falls back to local policy.

- [x] **Task 3: Bind enforcement and audit receipts to the verified snapshot**
  - Ensure native firewall admission and direct tool execution gates observe the managed kill switch and verified policy on every admission.
  - Add optional managed-policy metadata to typed execution receipts: organization, workspace scope, policy version/hash, key id, and managed source.
  - Include the same metadata in durable guardian decision entries, while preserving existing fields and redaction behavior.
  - Add regression coverage for kill-switch denial, policy-bound receipts, and durable guardian decision entries.

- [x] **Task 4: Add authenticated control-plane policy operations**
  - Add `GET /api/admin/enterprise-policy/status` and `POST /api/admin/enterprise-policy/refresh` to the native control plane.
  - Return safe status metadata/error labels only; never return signatures, public keys, or policy contents.
  - Reuse the existing authorization and CSRF gates. Refresh must force revalidation and report failure rather than leaving a stale success.
  - Add route recognition coverage; the handler reuses the existing authorization and CSRF gates.

- [x] **Task 5: Document the enterprise contract and verify the changed surface**
  - Document the envelope schema, environment variables, fail-closed behavior, local narrowing rule, rotation/rollback expectations, control-plane endpoints, and the Platform publication boundary in `docs/SAFETY.md` and `docs/THREAT_MODEL.md`.
  - Add a short parity note in `docs/design/GROK_BUILD_PARITY.md` connecting the managed-policy/revocation capability to the enterprise recommendation without importing the marketplace surface.
  - Run formatting, focused policy/control-plane tests, the full TUI and control-plane suites, workspace Clippy with the repository's existing large-enum warnings isolated, workspace tests, and required repository checks where the environment permits.
  - Commit only intended changes, push the isolated branch, open a ready PR, wait for required checks, merge without bypassing protection, and record the merge SHA.

## Verification evidence

- `cargo fmt --all -- --check` passes.
- Managed-policy tests: 21 passed; control-plane route test: 1 passed.
- Full `maestro-tui` library suite: 4,405 passed, 1 ignored.
- Full `maestro-control-plane` library suite: 318 passed.
- Workspace Clippy passes with only the two existing `large_enum_variant` diagnostics
  excluded; strict Clippy still reports those pre-existing warnings.

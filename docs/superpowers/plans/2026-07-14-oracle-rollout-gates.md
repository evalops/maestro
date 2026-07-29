# Oracle Rollout Gates Implementation Plan

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate Oracle policy candidates with deterministic experiments and verified-outcome promotion gates.

**Architecture:** A pure assignment helper selects control or treatment by hashing experiment plus session. A pure evaluator compares verified aggregates against sample, quality, cost, latency, and safety thresholds and returns an advisory decision.

**Tech Stack:** TypeScript, existing Oracle consultation policy, intelligent-router outcomes, trajectory telemetry, Vitest.

## Global Constraints

- Assistant completion alone is never verified success.
- At least 20 verified samples per arm are required.
- Evaluation is advisory and never mutates production policy.

---

### Task 1: Deterministic experiment assignment

**Files:**
- Create: `src/agent/oracle-policy-experiment.ts`
- Create: `test/agent/oracle-policy-experiment.test.ts`
- Modify: `src/services/intelligent-router/types.ts`

**Interfaces:**
- Produces: `assignOraclePolicyExperiment({ experimentId, sessionId, allocation, controlVersion, treatmentVersion })` returning an immutable arm and policy version.

- [ ] **Step 1: Write failing tests** for stability, experiment isolation, allocation boundaries, and control/treatment version projection.
- [ ] **Step 2: Run the focused test** and confirm missing module failure.
- [ ] **Step 3: Implement assignment with a stable SHA-256-derived bucket in `[0, 1)`.** Allocation `0` always yields control and `1` always yields treatment.
- [ ] **Step 4: Re-run focused tests; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(oracle): add deterministic policy experiments"`.

### Task 2: Verified rollout evaluator

**Files:**
- Create: `src/agent/oracle-policy-rollout.ts`
- Create: `test/agent/oracle-policy-rollout.test.ts`

**Interfaces:**
- Produces: `evaluateOraclePolicyRollout(input): OraclePolicyRolloutDecision` with status `hold | promote | rollback`, sufficiency, metrics, and reasons.

- [ ] **Step 1: Write failing table tests** for insufficient samples, mixed versions, safety rollback, quality regression, cost/latency ceiling failures, and eligible promotion.
- [ ] **Step 2: Run the focused test** and confirm missing module failure.
- [ ] **Step 3: Implement the pure evaluator.** Ignore unverified samples; require 20 verified samples per arm; rollback for any safety violation; hold when treatment success trails control by more than `0.05` or configured cost/latency ratios are exceeded; promote only when every gate passes.
- [ ] **Step 4: Re-run focused tests; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(oracle): gate rollout on verified outcomes"`.

### Task 3: Apply and observe experiments

**Files:**
- Modify: `src/agent/oracle-consultation-policy.ts`
- Modify: `src/services/intelligent-router/service.ts`
- Modify: `src/server/handlers/chat.ts`
- Modify: `src/server/handlers/chat-ws.ts`
- Modify: `src/telemetry/otel.ts`
- Modify: `docs/AGENT_PROFILES.md`
- Test: `test/agent/oracle-consultation-policy.test.ts`
- Test: `test/web/chat-handler-routing.test.ts`
- Test: `test/telemetry/telemetry-otel-routing.test.ts`

**Interfaces:**
- Consumes: optional experiment configuration and verified routing outcomes.
- Produces: assignment in routing decisions/receipts and telemetry fields `oracle.experiment_id`, `oracle.arm`, and `oracle.policy_version`.

- [ ] **Step 1: Write failing parity and telemetry tests** for identical HTTP/WebSocket assignment and receipt projection.
- [ ] **Step 2: Run focused tests** and confirm experiment fields are absent.
- [ ] **Step 3: Assign before Oracle policy evaluation, select the arm's policy version, project it to routing receipts, and emit bounded telemetry attributes.**
- [ ] **Step 4: Run focused tests, lint, evals, and full build; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(oracle): observe outcome-calibrated rollout"`.

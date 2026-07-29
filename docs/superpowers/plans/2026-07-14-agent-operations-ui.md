# Agent Operations UI Implementation Plan

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web operations panel that presents durable parent/child agent lineage, live status, navigation, and safe cancellation.

**Architecture:** Extend the replay-lab wire projection with complete lineage, derive a deterministic forest in a pure web helper, and render it in a focused panel embedded in the composer. Existing session navigation and abort paths remain the only control mechanisms.

**Tech Stack:** TypeScript, Lit, Maestro trajectory/replay contracts, Vitest.

## Global Constraints

- Sparse legacy lineage renders as roots.
- No new execution-control channel or permission bypass.
- HTTP and persisted replay data remain compatible.

---

### Task 1: Complete the web lineage contract

**Files:**
- Modify: `packages/web/src/services/api-client.types.ts`
- Modify: `src/server/agent-trajectory-replay-lab.ts`
- Test: `test/server/agent-trajectory-replay-lab.test.ts`

**Interfaces:**
- Produces: `TrajectoryReplayLabTimelineItem.parentAgentRunId?: string` and existing `childAgentRunId?: string` from server projection.

- [ ] **Step 1: Add a failing projection test** asserting a parent and child timeline record retain both IDs.
- [ ] **Step 2: Run** `bunx vitest --run test/server/agent-trajectory-replay-lab.test.ts` and confirm the parent field assertion fails.
- [ ] **Step 3: Add `parentAgentRunId?: string` to the web type and copy the field in replay-lab projection.**
- [ ] **Step 4: Re-run the focused test** and expect PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(trajectory): project complete agent lineage"`.

### Task 2: Derive a deterministic operations forest

**Files:**
- Create: `packages/web/src/components/agent-operations-tree.ts`
- Create: `packages/web/src/components/agent-operations-tree.test.ts`

**Interfaces:**
- Produces: `buildAgentOperationsTree(items): AgentOperationsNode[]` where each node contains `runId`, `parentRunId?`, `status`, `latestItem`, and `children`.

- [ ] **Step 1: Write failing tests** for nested runs, missing parents, duplicate events, latest-status selection, and stable timestamp/run-ID ordering.
- [ ] **Step 2: Run** `bunx vitest --run packages/web/src/components/agent-operations-tree.test.ts` and confirm the missing module fails.
- [ ] **Step 3: Implement a pure two-pass builder:** coalesce items by run ID, attach known parents, retain orphans as roots, recursively sort by latest timestamp then run ID.
- [ ] **Step 4: Re-run the focused test** and expect PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(web): derive agent operations tree"`.

### Task 3: Render and control the operations panel

**Files:**
- Create: `packages/web/src/components/composer-agent-operations-panel.ts`
- Create: `packages/web/src/components/composer-agent-operations-panel.test.ts`
- Modify: `packages/web/src/components/composer-chat.ts`
- Modify: `packages/web/src/components/composer-chat-overlays.ts`

**Interfaces:**
- Consumes: `ApiClient.getSessionReplayLab(sessionId)` and `buildAgentOperationsTree`.
- Emits: `open-session` with `{ sessionId, runId }`, `cancel-run` with `{ runId }`, and `close`.

- [ ] **Step 1: Write failing component tests** that verify nesting, status copy, expansion, navigation events, and that cancellation is absent for terminal runs.
- [ ] **Step 2: Run** `bunx vitest --run packages/web/src/components/composer-agent-operations-panel.test.ts` and confirm the component is missing.
- [ ] **Step 3: Implement the panel and wire navigation/cancellation to existing composer handlers.** Disable cancellation while a request is pending and expose the server error inline.
- [ ] **Step 4: Run** the panel tests plus `packages/web/src/components/composer-chat.test.ts`; expect PASS.
- [ ] **Step 5: Build** with `npx nx run maestro-web:build --skip-nx-cache`; expect PASS.
- [ ] **Step 6: Commit** with `git commit -m "feat(web): add agent operations panel"`.

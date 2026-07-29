# Observable Agent Lineage Implementation Plan

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistently expose parent/child agent lineage and lifecycle operations through thread retrieval.

**Architecture:** Project normalized `codexWorkGraph` metadata already persisted in assistant tool calls and tool results. Aggregate operations by child-run ID into durable edges on `thread.graph`; consumers can then read each child thread’s messages through `thread/read`.

**Tech Stack:** TypeScript, TypeBox, Vitest, Bun, Nx.

## Global Constraints

- Stack on revision-aware retrieval, but merge only after its PR lands.
- Preserve provider-agnostic session storage and existing replay semantics.
- Additive contract only; no new hidden execution behavior.
- TDD for every production behavior.

---

### Task 1: Project durable lifecycle edges

**Files:** Create `src/session/agent-lineage-projection.ts`; test `test/session/agent-lineage-projection.test.ts`.

**Interfaces:** Produce `{ edges, operations }` keyed by stable child-run and tool-call identifiers from `SessionTreeEntry[]`.

- [ ] Write tests for spawn, send-input, wait, and close events updating one child edge.
- [ ] Verify the tests fail because the projector is missing.
- [ ] Implement normalization of camel/snake case work-graph fields and chronological aggregation.
- [ ] Verify targeted tests pass and commit.

### Task 2: Expose lineage through thread APIs

**Files:** Modify `src/session/session-graph-projection.ts`, `src/app-server/session-api.ts`, `packages/contracts/src/maestro-app-server.ts`, and their tests.

**Interfaces:** Add `agentLineage` to `SessionGraphProjection` and `MaestroAppServerThreadGraph`.

- [ ] Add failing graph/API contract tests.
- [ ] Map the projector into thread graph responses.
- [ ] Regenerate app-server schema fixtures.
- [ ] Run targeted tests, lint, full affected tests, commit, open PR, address feedback, merge, and verify mirror/deploy workflows.

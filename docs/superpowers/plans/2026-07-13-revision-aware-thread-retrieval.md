# Revision-Aware Thread Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `thread/read` able to return original, compacted, active, and superseded thread entries with enough lineage to identify later revisions and reverts.

**Architecture:** Extend the existing session graph projection rather than creating a second history model. The projection will retain its compacted replay window, add the complete authoritative active path and sibling revision groups, while `thread/read` exposes raw tree items only when `includeHistory: true` is requested.

**Tech Stack:** TypeScript, TypeBox contracts, Vitest, Bun, Nx.

## Global Constraints

- Changes originate in `evalops/maestro-internal` and reach the public repository through mirror automation.
- Existing `thread/read` responses remain backward-compatible when `includeHistory` is absent.
- Compaction summaries are navigation aids; original entries remain authoritative.
- Production behavior is implemented only after its failing test has been observed.

---

### Task 1: Project authoritative history and revisions

**Files:**
- Modify: `src/session/session-graph-projection.ts`
- Test: `test/session/session-graph-projection.test.ts`

**Interfaces:**
- Consumes: `SessionEntry[]` and the existing active-leaf traversal.
- Produces: `authoritativeEntryIds: string[]`, `supersededEntryIds: string[]`, and `revisionGroups: Array<{ parentEntryId: string | null; childEntryIds: string[]; activeChildEntryId?: string }>` on `SessionGraphProjection`.

- [ ] **Step 1: Write failing projection tests** proving pre-compaction entries remain in `authoritativeEntryIds` and sibling branches appear in a revision group with only the selected child active.
- [ ] **Step 2: Run** `bunx vitest --run test/session/session-graph-projection.test.ts` **and confirm failures are missing fields.**
- [ ] **Step 3: Implement the minimal projection fields** by retaining the unwindowed active path and grouping tree-entry siblings by `parentId`; do not change `activeEntries` replay semantics.
- [ ] **Step 4: Re-run the targeted test and confirm it passes.**
- [ ] **Step 5: Commit** `test(session): specify revision-aware graph projection` and the minimal implementation atomically.

### Task 2: Add opt-in raw history to thread retrieval

**Files:**
- Modify: `packages/contracts/src/maestro-app-server.ts`
- Modify: `src/app-server/session-api.ts`
- Test: `test/app-server/session-api.test.ts`

**Interfaces:**
- Consumes: `thread/read` params `{ includeHistory?: boolean }` and `SessionGraphProjection` from Task 1.
- Produces: optional `history: MaestroAppServerThreadItem[]` and graph lineage fields in the contract and response.

- [ ] **Step 1: Write a failing API test** requesting `includeHistory: true` from a compacted branched thread and asserting that old originals and superseded branch items are returned in persistence order.
- [ ] **Step 2: Run** `bunx vitest --run test/app-server/session-api.test.ts -t "revision-aware history"` **and confirm the response lacks history.**
- [ ] **Step 3: Extend TypeBox contracts and the response mapper** so history is omitted by default and populated from every `SessionTreeEntry` only when requested.
- [ ] **Step 4: Re-run the targeted API and projection tests and confirm they pass.**
- [ ] **Step 5: Regenerate contract artifacts using the repository’s existing schema-generation target, then commit** `feat(session): expose revision-aware thread history`.

### Task 3: Document and verify the public contract

**Files:**
- Modify: `packages/contracts/README.md`
- Modify generated schema files only through the repository generator.
- Test: `test/openapi-spec.test.ts`

**Interfaces:**
- Consumes: the additive contract from Task 2.
- Produces: documented client behavior and schema regression coverage.

- [ ] **Step 1: Add a failing contract assertion** that revision-aware graph fields and optional history are present in generated schemas.
- [ ] **Step 2: Run the contract/OpenAPI test and confirm the expected schema assertion fails before regeneration.**
- [ ] **Step 3: Document compacted replay versus authoritative raw history, including the cost of `includeHistory: true`.**
- [ ] **Step 4: Run** `bun run bun:lint`, `npx nx run maestro:test --skip-nx-cache`, and the touched package builds.
- [ ] **Step 5: Commit** `docs(session): describe authoritative thread retrieval`, push the branch, open `[maestro] add revision-aware thread retrieval`, address review/CI, merge, and verify internal deploy plus public mirror workflows.

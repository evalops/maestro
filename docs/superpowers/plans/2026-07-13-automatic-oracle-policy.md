# Automatic Oracle Consultation Policy Implementation Plan

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically and audibly recommend or require the read-only Oracle for tasks where independent reasoning is likely to improve outcomes.

**Architecture:** A pure versioned policy evaluates profile, task type, prompt signals, and prior failures. The intelligent router records the decision, and the chat handler injects explicit next-run guidance; a checked-in eval matrix prevents trigger drift.

**Tech Stack:** TypeScript, Vitest, intelligent router, Agent system-prompt additions.

## Global Constraints

- No hidden tool execution; the agent sees and follows an explicit policy directive.
- Oracle remains read-only and uses the profile’s complementary model.
- Low-risk profiles avoid mandatory Oracle cost.
- Policy behavior must be covered by named eval cases before integration.

---

### Task 1: Versioned consultation policy

**Files:** Create `src/agent/oracle-consultation-policy.ts`; test `test/agent/oracle-consultation-policy.test.ts`.

- [x] Write a failing eval matrix for low, medium, high, ultra, architecture/migration, ambiguity, cross-cutting work, and repeated failures.
- [x] Implement minimal deterministic scoring and prompt directive formatting.
- [x] Verify all eval cases pass.

### Task 2: Router and runtime integration

**Files:** Modify intelligent-router types/normalization/service/recorder and `src/server/handlers/chat.ts`; update focused tests.

- [x] Add failing tests for decision recording and next-run prompt injection.
- [x] Thread task summary and prior failure count through routing.
- [x] Queue policy guidance only for recommended/required modes.
- [ ] Run targeted tests, lint, affected tests, commit, open PR after PR 2 merges, address feedback, merge, and verify deployment/mirror workflows.

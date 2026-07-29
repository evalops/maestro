# Governed Custom-Agent API Implementation Plan

> **Historical:** This is a dated engineering record from before the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Paths below reflect the TypeScript tree as it existed at the time and are kept as-written for historical accuracy; do not treat them as live code.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let installed Maestro packages define policy-governed primary and subagent configurations through a typed API.

**Architecture:** Packages statically declare agent metadata, then register matching runtime configurations with a capability-scoped registry. A validator intersects requested models, tools, budgets, and permissions with host policy before creating immutable agent handles.

**Tech Stack:** TypeScript, Maestro packages, model/tool registries, permission profiles, Vitest.

## Global Constraints

- Registration cannot increase host authority.
- The first API configures agents but does not execute arbitrary tool implementations or UI code.
- Duplicate or mismatched registration fails atomically.

---

### Task 1: Add package agent discovery

**Files:**
- Modify: `src/packages/types.ts`
- Modify: `src/packages/loader.ts`
- Modify: `src/packages/runtime.ts`
- Modify: `src/app-server/plugin-bundle-api.ts`
- Modify: `packages/contracts/src/maestro-app-server.ts`
- Test: `test/packages/maestro-packages.test.ts`
- Test: `test/app-server/plugin-bundle-api.test.ts`

**Interfaces:**
- Produces: scoped `agents` resource directories and statically discoverable `AgentModeMetadata { key, label, entry }`.

- [ ] **Step 1: Write failing loader and app-server tests** for agent resources, scope precedence, and missing metadata.
- [ ] **Step 2: Run the focused tests** and confirm `agents` is absent.
- [ ] **Step 3: Extend package manifests/resources/runtime aggregation and plugin-bundle responses with `agents`, preserving existing filters and trust gates.**
- [ ] **Step 4: Re-run focused tests; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(packages): discover custom agents"`.

### Task 2: Implement the governed registry API

**Files:**
- Create: `src/agent/plugin-agent-registry.ts`
- Create: `src/agent/plugin-agent-api.ts`
- Modify: `src/agent/index.ts`
- Create: `test/agent/plugin-agent-registry.test.ts`

**Interfaces:**
- Produces: `createAgent(config)`, `registerAgentMode(registration)`, `PluginAgentHandle`, and `PluginAgentPolicy`.

- [ ] **Step 1: Write failing tests** for successful creation, primary-mode registration, duplicate keys, unknown tools, disallowed models, unbounded budgets, metadata mismatch, and permission escalation.
- [ ] **Step 2: Run** `bunx vitest --run test/agent/plugin-agent-registry.test.ts` and confirm missing module failure.
- [ ] **Step 3: Implement immutable handles and atomic validation.** `tools: "all"` means all tools already allowed by host policy; an explicit list is intersected with that same set. Budgets must be positive and no greater than host maxima. Requested approval/sandbox settings may only be equal or more restrictive.
- [ ] **Step 4: Re-run focused tests; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): add governed custom-agent API"`.

### Task 3: Load registrations and expose custom modes

**Files:**
- Create: `src/agent/plugin-agent-loader.ts`
- Modify: `src/agent/modes.ts`
- Modify: `src/agent/subagent-specs.ts`
- Modify: `src/cli/commands/modes.ts`
- Create: `docs/CUSTOM_AGENTS.md`
- Create: `test/agent/plugin-agent-loader.test.ts`
- Modify: `test/cli/modes-command.test.ts`

**Interfaces:**
- Consumes: installed package `agents` resources and the governed registry.
- Produces: custom modes in mode listing and custom agent handles usable by subagent dispatch.

- [ ] **Step 1: Write failing loader and CLI tests** using a fixture package that declares and registers `focused-reviewer`.
- [ ] **Step 2: Run focused tests** and confirm the custom mode is absent.
- [ ] **Step 3: Load registrations in package trust order, expose only validated agents, and document the typed API plus rejection rules.**
- [ ] **Step 4: Run focused tests, package-boundary validation, and the Maestro build; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): load package-defined agent modes"`.

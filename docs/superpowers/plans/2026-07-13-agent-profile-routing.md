# Agent Profile Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented model-only selection with a single, versioned agent-profile routing boundary while retaining compatibility for existing Maestro modes and clients.

**Architecture:** A new profile module owns user-facing capability levels and complete invocation bundles. Existing mode and intelligent-router entry points adapt to that module during migration, so every surface receives the same model, reasoning, oracle, specialist, and budget configuration. Routing promotion remains conservative until verified outcome evidence meets an explicit sample threshold.

**Tech Stack:** TypeScript, Bun, Vitest, existing Maestro model registry and routing services.

## Global Constraints

- Preserve `smart`, `rush`, `free`, `custom`, `frontier`, and `replay` as accepted compatibility inputs.
- Expose `low`, `medium`, `high`, and `ultra` as the canonical user-facing capability levels.
- Keep provider/model identifiers in the model registry layer; profiles reference registered identifiers and capabilities.
- No routing promotion based solely on an assistant message completing without an error.
- Every behavior change follows a failing-test, passing-test cycle.

---

### Task 1: Versioned agent profiles and compatibility aliases

**Files:**
- Create: `src/agent/profiles.ts`
- Modify: `src/agent/modes.ts`
- Modify: `src/agent/index.ts`
- Test: `test/agent/profiles.test.ts`
- Test: `test/agent/modes.test.ts`

**Interfaces:**
- Produces: `AgentProfileLevel`, `AgentProfile`, `AGENT_PROFILES`, `resolveAgentProfile(input, provider)`, and `parseAgentProfileLevel(input)`.
- Consumes: existing `ModelProvider`, `ReasoningEffort`, `SubagentType`, and model-tier resolution during the compatibility period.

- [ ] **Step 1: Write failing profile tests**

```ts
expect(parseAgentProfileLevel("rush")).toBe("low");
expect(parseAgentProfileLevel("smart")).toBe("medium");
expect(resolveAgentProfile("high", "openai-codex")).toMatchObject({
  id: "high-v1",
  level: "high",
  primary: { provider: "openai-codex", reasoningEffort: "xhigh" },
  oracle: { provider: "anthropic" },
});
```

- [ ] **Step 2: Run the tests and verify missing exports fail**

Run: `bunx vitest --run test/agent/profiles.test.ts test/agent/modes.test.ts`
Expected: FAIL because `src/agent/profiles.ts` and its exports do not exist.

- [ ] **Step 3: Implement immutable profile definitions and alias parsing**

Define `low-v1`, `medium-v1`, `high-v1`, and `ultra-v1` profiles. Each profile contains primary and oracle invocation configurations, specialist dispatch, fallback levels, and task budgets. Adapt `parseMode`, `getModelForMode`, and subagent dispatch through canonical levels without removing legacy inputs.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest --run test/agent/profiles.test.ts test/agent/modes.test.ts test/codex/subagent-dispatch-table.test.ts`
Expected: PASS.

### Task 2: Route profiles through the intelligent router

**Files:**
- Modify: `src/services/intelligent-router/types.ts`
- Modify: `src/services/intelligent-router/normalize.ts`
- Modify: `src/services/intelligent-router/service.ts`
- Modify: `src/services/intelligent-router/recorder.ts`
- Modify: `src/server/handlers/chat.ts`
- Test: `test/services/intelligent-router.test.ts`
- Test: `test/web/chat-handler-routing.test.ts`

**Interfaces:**
- Consumes: `AgentProfile` and `resolveAgentProfile` from Task 1.
- Produces: routing decisions containing `selectedProfile`, `fallbackProfiles`, and the resolved invocation profile while retaining `selectedModel` for wire compatibility.

- [ ] **Step 1: Write failing decision-contract tests**

```ts
expect(decision.selectedProfile).toMatchObject({ level: "medium", id: "medium-v1" });
expect(decision.fallbackProfiles.map(profile => profile.level)).toContain("low");
```

- [ ] **Step 2: Run focused tests and verify the new contract is absent**

Run: `bunx vitest --run test/services/intelligent-router.test.ts test/web/chat-handler-routing.test.ts`
Expected: FAIL because routing decisions contain models only.

- [ ] **Step 3: Implement the profile adapter and compatibility projection**

Resolve a profile before candidate scoring, constrain candidates to profile policy, return the selected immutable profile, and project its primary invocation into the legacy model fields.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest --run test/services/intelligent-router.test.ts test/web/chat-handler-routing.test.ts`
Expected: PASS.

### Task 3: Verified outcome evidence and conservative promotion

**Files:**
- Modify: `src/services/intelligent-router/types.ts`
- Modify: `src/services/intelligent-router/normalize.ts`
- Modify: `src/services/intelligent-router/service.ts`
- Modify: `src/services/intelligent-router/recorder.ts`
- Create: `src/services/intelligent-router/outcome.ts`
- Test: `test/services/intelligent-router.test.ts`
- Create: `test/services/intelligent-router-outcome.test.ts`

**Interfaces:**
- Produces: `RoutingOutcomeEvidence`, `deriveRoutingOutcome(evidence)`, `MIN_VERIFIED_SAMPLES`, and confidence metadata on routing scores.
- Consumes: verifier results, user acceptance/retry signals, task cost, and terminal assistant status.

- [ ] **Step 1: Write failing outcome tests**

```ts
expect(deriveRoutingOutcome({ assistantCompleted: true })).toEqual({ verified: false });
expect(deriveRoutingOutcome({ assistantCompleted: true, verificationPassed: true }))
  .toMatchObject({ verified: true, success: true });
```

- [ ] **Step 2: Run tests and verify the outcome module is missing**

Run: `bunx vitest --run test/services/intelligent-router-outcome.test.ts test/services/intelligent-router.test.ts`
Expected: FAIL because outcome evidence is not implemented.

- [ ] **Step 3: Implement verified metrics and promotion guards**

Do not record production quality or success from stop reason alone. Record unverified completions separately, require at least 20 verified samples for automatic promotion, expose sample sufficiency in routing reasons, and include total attempts plus total task cost in aggregates.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest --run test/services/intelligent-router-outcome.test.ts test/services/intelligent-router.test.ts test/web/chat-handler-routing.test.ts`
Expected: PASS.

### Task 4: Complementary oracle selection

**Files:**
- Modify: `src/tools/oracle.ts`
- Modify: `src/agent/profiles.ts`
- Test: `test/tools/oracle.test.ts`

**Interfaces:**
- Consumes: profile oracle invocation configuration and active primary provider.
- Produces: `selectComplementaryOracleModel` that prefers a different provider family and never silently falls back to an arbitrary non-reasoning model.

- [ ] **Step 1: Write failing oracle-selection tests**

```ts
expect(selectComplementaryOracleModel(models, { primaryProvider: "openai-codex" }))
  .toMatchObject({ provider: "anthropic", reasoning: true });
expect(() => selectComplementaryOracleModel(nonReasoningModels, options)).toThrow();
```

- [ ] **Step 2: Run the test and verify current arbitrary fallback fails it**

Run: `bunx vitest --run test/tools/oracle.test.ts`
Expected: FAIL because current selection accepts the first configured model.

- [ ] **Step 3: Implement complementary selection and profile defaults**

Select an explicit override first, then the active profile's oracle, then a reasoning-capable model from another provider. If none exists, use a same-provider reasoning model and record the degraded choice; never choose a non-reasoning model.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest --run test/tools/oracle.test.ts test/agent/profiles.test.ts`
Expected: PASS.

### Task 5: Profile packages, telemetry, documentation, and full verification

**Files:**
- Create: `src/agent/profile-loader.ts`
- Modify: `src/cli/commands/modes.ts`
- Modify: `docs/MODELS.md`
- Modify: `docs/FEATURES.md`
- Create: `docs/AGENT_PROFILES.md`
- Create: `test/agent/profile-loader.test.ts`

**Interfaces:**
- Consumes: the Task 1 profile schema.
- Produces: project/user profile loading, validation, versioned telemetry fields, and CLI descriptions of resolved complete profiles.

- [ ] **Step 1: Write failing loader tests**

```ts
expect(loadAgentProfiles(fixtureDir)).toContainEqual(
  expect.objectContaining({ id: "security-review-v1", level: "custom" }),
);
expect(() => loadAgentProfiles(invalidFixtureDir)).toThrow(/oracle.model/);
```

- [ ] **Step 2: Run tests and verify loader absence**

Run: `bunx vitest --run test/agent/profile-loader.test.ts`
Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Implement declarative loading and document the schema**

Load `.maestro/agent-profiles/*.yaml` and user profiles with project precedence, validate complete invocation bundles, show resolved primary/oracle/specialists/budgets in `maestro modes describe`, and document migration aliases.

- [ ] **Step 4: Run repository verification**

Run: `bun run bun:lint`
Expected: PASS.

Run: `npx nx run maestro:test --skip-nx-cache`
Expected: PASS.

Run: `npx nx run maestro:evals --skip-nx-cache`
Expected: PASS.

Run: `npx nx run maestro:build --skip-nx-cache`
Expected: PASS.

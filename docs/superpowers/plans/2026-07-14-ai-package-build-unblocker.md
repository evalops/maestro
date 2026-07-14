# AI Package Build Unblocker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the required Maestro test baseline by including painter image-provider dependencies in the AI package TypeScript project.

**Architecture:** Keep the current AI facade boundary and explicitly include the root image-provider directory alongside the other temporary root-owned sources. Protect the include with a source-level regression test.

**Tech Stack:** TypeScript project references, Vitest, Nx.

## Global Constraints

- Do not move painter implementation files in this unblocker.
- Do not skip hooks or required builds.

---

### Task 1: Cover and repair the package input boundary

**Files:**
- Modify: `packages/ai/tsconfig.build.json`
- Create: `test/packages/ai-tsconfig-boundary.test.ts`

**Interfaces:**
- Consumes: `packages/ai/tsconfig.build.json#include`.
- Produces: inclusion of `../../src/services/image-providers/**/*.ts` in the AI composite project.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("@evalops/ai TypeScript boundary", () => {
  it("includes painter image-provider dependencies", () => {
    const config = JSON.parse(readFileSync("packages/ai/tsconfig.build.json", "utf8"));
    expect(config.include).toContain("../../src/services/image-providers/**/*.ts");
  });
});
```

- [ ] **Step 2: Verify the test and package build fail**

Run: `bunx vitest --run test/packages/ai-tsconfig-boundary.test.ts`
Expected: FAIL because the include is absent.

Run: `npx nx run @evalops/ai:build --skip-nx-cache`
Expected: FAIL with TS6307 for `src/services/image-providers/*.ts`.

- [ ] **Step 3: Add the minimal include**

```json
"../../src/services/image-providers/**/*.ts",
```

Place it next to the existing `../../src/tools/**/*.ts` facade input.

- [ ] **Step 4: Verify the regression and baseline**

Run: `bunx vitest --run test/packages/ai-tsconfig-boundary.test.ts`
Expected: PASS.

Run: `npx nx run @evalops/ai:build --skip-nx-cache`
Expected: PASS.

Run: `npx nx run maestro:test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/tsconfig.build.json test/packages/ai-tsconfig-boundary.test.ts
git commit -m "fix(ai): include painter providers in package build"
```

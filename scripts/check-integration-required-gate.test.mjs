import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateIntegrationRequiredGate } from "./check-integration-required-gate.mjs";

test("passes when irrelevant paths intentionally skip the integration suite", () => {
  assert.deepEqual(
    evaluateIntegrationRequiredGate({
      pathCheckResult: "success",
      integrationPathsChanged: "false",
      integrationSuiteResult: "skipped",
    }),
    {
      ok: true,
      message: "integration suite correctly skipped for irrelevant paths",
    },
  );
});

test("fails when integration path detection fails", () => {
  assert.equal(
    evaluateIntegrationRequiredGate({
      pathCheckResult: "failure",
      integrationPathsChanged: "",
      integrationSuiteResult: "skipped",
    }).ok,
    false,
  );
});

test("requires the integration suite to succeed for relevant paths", () => {
  assert.equal(
    evaluateIntegrationRequiredGate({
      pathCheckResult: "success",
      integrationPathsChanged: "true",
      integrationSuiteResult: "success",
    }).ok,
    true,
  );
  assert.equal(
    evaluateIntegrationRequiredGate({
      pathCheckResult: "success",
      integrationPathsChanged: "true",
      integrationSuiteResult: "failure",
    }).ok,
    false,
  );
});

test("workflow retains the full suite and an always-reporting required gate", () => {
  const workflow = readFileSync(new URL("../.github/workflows/integration.yml", import.meta.url), "utf8");
  const requiredGate = workflow.match(
    /^  integration-tests:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n)/m,
  )?.[0];

  assert.match(workflow, /integration-suite:\n[\s\S]*cargo test --locked -p maestro-control-plane/);
  assert.ok(requiredGate, "integration-tests job must exist");
  assert.match(requiredGate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(requiredGate, /needs: \[pull-request-path-check, integration-suite\]/);
  assert.match(requiredGate, /timeout-minutes: 5/);
  assert.match(
    requiredGate,
    /uses: actions\/setup-node@395ad3262231945c25e8478fd5baf05154b1d79f[\s\S]*node-version: 22/,
  );
  assert.match(
    requiredGate,
    /github\.event\.pull_request\.head\.repo\.id != github\.event\.repository\.id[\s\S]*vars\.PR_CHECKS_RUNNER/,
  );
  assert.match(requiredGate, /run: node scripts\/check-integration-required-gate\.mjs/);
});

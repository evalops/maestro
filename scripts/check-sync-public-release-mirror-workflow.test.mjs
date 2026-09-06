import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/sync-public-release-mirror.yml",
    import.meta.url,
  ),
  "utf8",
);

/** Slice the workflow text of one step block, from `marker` to the next step. */
function stepBlock(marker) {
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `step not found: ${marker}`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n      - /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("prepared tree is linted as public CI will see it before any push", () => {
  const lintIndex = workflow.indexOf(
    "- name: Lint prepared tree with public-owned workflow CI",
  );
  const pushIndex = workflow.indexOf("- name: Open or update public sync PR");
  assert.notEqual(lintIndex, -1);
  assert.notEqual(pushIndex, -1);
  assert.ok(
    lintIndex < pushIndex,
    "the prepared-tree lint must run before the step that pushes to evalops/maestro",
  );

  const lint = stepBlock("- name: Lint prepared tree with public-owned workflow CI");
  // The merged tree restores the public-owned paths (.github/workflows/** and
  // .github/actionlint.yaml) from the evalops/maestro@main clone's HEAD.
  assert.match(
    lint,
    /git -C public-mirror archive HEAD \.github\/workflows \.github\/actionlint\.yaml/,
  );
  // Same linter, version, and disabled external linters as the public
  // actionlint workflow (evalops/maestro .github/workflows/actionlint.yml).
  assert.match(lint, /actionlint@v1\.7\.\d+/);
  assert.match(lint, /-shellcheck= -pyflakes=/);
  // The scratch copy has no .git; actionlint refuses to run without one.
  assert.match(lint, /git init -q/);
  // The module download is bounded (CI invariants: explicit short timeouts).
  assert.match(lint, /timeout \d+ go run/);
  // The public actionlint job's cheap workflow contract tests run too.
  assert.match(lint, /node --test scripts\/version\.test\.mjs/);
  assert.match(
    lint,
    /node --test \.github\/workflows\/check-release-workflow-contract\.test\.mjs/,
  );
  assert.match(lint, /node \.github\/workflows\/check-release-workflow-contract\.mjs/);
  // A lint failure must fail the sync: the step is not advisory.
  assert.doesNotMatch(lint, /continue-on-error/);
});

test("sync-hold label on the public sync PR blocks every push and exits 0", () => {
  const holdIndex = workflow.indexOf(
    "- name: Check sync-hold label on the public sync PR",
  );
  const cloneIndex = workflow.indexOf(
    "- name: Clone public repo for mirror validation",
  );
  assert.notEqual(holdIndex, -1);
  assert.notEqual(cloneIndex, -1);
  assert.ok(
    holdIndex < cloneIndex,
    "the hold must be evaluated before the mirror checkout and every later step",
  );

  const hold = stepBlock("- name: Check sync-hold label on the public sync PR");
  assert.match(hold, /id: sync-hold/);
  assert.match(hold, /sync-hold/);
  // Reads are bounded network calls, same pattern as the debounce.
  assert.match(hold, /--max-time \d+ --retry \d+/);
  // `force: true` must not bypass a human's do-not-touch label: unlike the
  // debounce, the hold step's condition never references the force input.
  assert.doesNotMatch(hold, /inputs\.force/);

  // Everything the debounce can skip, the hold can skip: both gates appear on
  // the same steps, including the push/PR step.
  const debounceGates = workflow.match(
    /steps\.debounce\.outputs\.skip != 'true'/g,
  );
  const holdGates = workflow.match(/steps\.sync-hold\.outputs\.hold != 'true'/g);
  assert.ok(debounceGates.length > 0);
  assert.equal(holdGates.length, debounceGates.length);

  const push = stepBlock("- name: Open or update public sync PR");
  assert.match(push, /steps\.sync-hold\.outputs\.hold != 'true'/);
});

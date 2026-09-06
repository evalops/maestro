import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflow } from "./check-release-workflow-contract.mjs";

const workflow = parseWorkflow(readFileSync(new URL("./release.yml", import.meta.url), "utf8"));
const publish = workflow.jobs.publish.steps.find(step => step.name === "Publish to npm").run;

function run(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-propagation-"));
  try {
    const scripts = {
      npm: `#!/bin/bash
count=0
[[ ! -f "$TEST_ROOT/count" ]] || read -r count < "$TEST_ROOT/count"
count=$((count + 1))
echo "$count" > "$TEST_ROOT/count"
[[ "$count" -gt "$TEST_MISSING" ]] || exit 1
echo "$TEST_INTEGRITY"
`,
      node: '#!/bin/bash\n[[ "$TEST_VERSION_EXISTS" == 1 ]] || exit 1\necho expected\n',
      npx: '#!/bin/bash\necho publish >> "$TEST_ROOT/publishes"\n',
      timeout: '#!/bin/bash\n[[ "$1" == *s ]] || exit 90\nshift\nexec "$@"\n',
      sleep: '#!/bin/bash\necho wait >> "$TEST_ROOT/waits"\n',
    };
    for (const [name, contents] of Object.entries(scripts)) writeFileSync(join(dir, name), contents, {mode:0o755});
    const result = spawnSync("bash", ["-c", publish], {
      encoding: "utf8", timeout: 5000,
      env: {...process.env, PATH:`${dir}:${process.env.PATH}`, TEST_ROOT:dir,
        TEST_MISSING:String(options.missing ?? 0), TEST_VERSION_EXISTS:String(options.exists ?? 1), TEST_INTEGRITY:options.integrity ?? "expected",
        PACKAGE_NAME:"@test/canonical", ALIAS_PACKAGE_NAME:"@test/alias", TARBALL:"canonical.tgz", ALIAS_TARBALL:"alias.tgz", PACKED_INTEGRITY:"expected", ALIAS_PACKED_INTEGRITY:"expected", RELEASE_VERSION:"1.2.3", NPM_TAG:"latest", NPM_CONFIG_REGISTRY:"https://registry.npmjs.org", RUNNER_TEMP:dir},
    });
    const count = name => { try { return readFileSync(join(dir, name), "utf8").trim().split("\n").length; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } };
    return {...result, publishes:count("publishes"), waits:count("waits")};
  } finally { rmSync(dir, {recursive:true, force:true}); }
}

test("published version waits for package index without publishing twice", () => {
  const result = run({missing:3});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishes, 0);
  assert.equal(result.waits, 2);
});
test("new package is published once and reconciled before continuing", () => {
  const result = run({missing:2, exists:0});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishes, 1);
  assert.equal(result.waits, 1);
});
test("integrity mismatch stops publication", () => {
  const result = run({integrity:"different"});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.publishes, 0);
});
test("missing index has a finite deadline and never counts as success", () => {
  const result = run({missing:1000});
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.publishes, 0);
  assert.equal(result.waits, 59);
  assert.match(result.stdout, /did not propagate/);
});

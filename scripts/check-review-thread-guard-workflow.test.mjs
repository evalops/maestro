import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("review events cannot cancel the required pull request thread guard", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/review-thread-guard.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}-\$\{\{ github\.event_name \}\}/,
  );
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
});

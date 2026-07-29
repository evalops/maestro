import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
	new URL("../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);

test("CI uses the current concurrency generation", () => {
	assert.match(
		workflow,
		/^\s*group: \$\{\{ github\.workflow \}\}-arc-v4-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m,
	);
});

test("CI cancels superseded pull request runs", () => {
	assert.match(
		workflow,
		/^\s*cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
	);
});

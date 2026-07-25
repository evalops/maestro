import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
	new URL("../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);

function jobBody(jobId) {
	const start = workflow.indexOf(`  ${jobId}:\n`);
	assert.notEqual(start, -1, `missing ${jobId} job`);
	const remainder = workflow.slice(start + 1);
	const next = remainder.search(/\n  [A-Za-z0-9_-]+:\n/);
	return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("native CI runs independent release, test, and quality lanes in parallel", () => {
	const release = jobBody("native-release");
	const tests = jobBody("native-tests");
	const quality = jobBody("native-quality");
	const aggregate = jobBody("native");

	assert.match(release, /npm run build/);
	assert.match(release, /npm run smoke:release-native-only/);
	assert.match(tests, /cargo test --workspace --locked/);
	assert.match(quality, /cargo clippy --workspace --all-targets --locked -- -D warnings/);
	assert.match(quality, /cargo fmt --all --check/);

	assert.match(aggregate, /needs:\n      - native-quality\n      - native-tests\n      - native-release/);
	assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
	for (const lane of ["native-quality", "native-tests", "native-release"]) {
		assert.match(aggregate, new RegExp(`needs\\.${lane}\\.result`));
	}
});

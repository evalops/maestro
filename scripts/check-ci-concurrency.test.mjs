import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pipeline = readFileSync(
	new URL("../.buildkite/pipeline.yml", import.meta.url),
	"utf8",
);
const advisory = readFileSync(
	new URL("../.buildkite/advisory.yml", import.meta.url),
	"utf8",
);

test("CI uses one configurable Buildkite concurrency group", () => {
	assert.match(pipeline, /MAESTRO_CI_CONCURRENCY_GROUP:-maestro-heavy-workloads/);
});

test("CI bounds each Buildkite lane to available worker capacity", () => {
	assert.equal((pipeline.match(/concurrency: 3/g) ?? []).length, 9);
});

test("advisory coverage and perf use a separate one-slot pool", () => {
	assert.doesNotMatch(pipeline, /MAESTRO_CI_ADVISORY_CONCURRENCY_GROUP/);
	assert.equal((pipeline.match(/^\s*concurrency: 1$/gmu) ?? []).length, 0);
	assert.match(
		advisory,
		/MAESTRO_CI_ADVISORY_CONCURRENCY_GROUP:-maestro-advisory-workloads/,
	);
	assert.equal((advisory.match(/^\s*concurrency: 1$/gmu) ?? []).length, 2);
});

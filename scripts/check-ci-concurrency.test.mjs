import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pipeline = readFileSync(
	new URL("../.buildkite/pipeline.yml", import.meta.url),
	"utf8",
);

test("CI uses one configurable Buildkite concurrency group", () => {
	assert.match(pipeline, /MAESTRO_CI_CONCURRENCY_GROUP:-hetzner-linux-heavy-workloads/);
});

test("CI bounds each Buildkite lane to available worker capacity", () => {
	assert.equal((pipeline.match(/concurrency: 3/g) ?? []).length, 11);
});

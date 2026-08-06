import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Rust PR workflows retain validation with shared caches and no duplicate gates", () => {
	const result = spawnSync(
		process.execPath,
		[join(repoRoot, "scripts/measure-ci-build-latency.mjs")],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const metrics = JSON.parse(result.stdout);
	assert.equal(metrics.required_contexts_preserved, 1);
	assert.equal(metrics.validation_contracts_preserved, 1);
	assert.equal(metrics.measurement_fixture_valid, 1);
	assert.equal(metrics.cache_identity_partitions, 4);
	assert.equal(metrics.duplicate_validation_commands, 0);
	assert.ok(metrics.projected_rust_runner_seconds <= 1800);
});

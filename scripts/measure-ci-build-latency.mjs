#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRequiredStatusChecks } from "./check-required-status-checks.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
	readFileSync(
		join(repoRoot, "test/fixtures/ci-build-latency/pr-rust-lanes.json"),
		"utf8",
	),
);

function read(relativePath) {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

function laneIsActive(lane) {
	const workflow = read(lane.workflow);
	return lane.activeMarkers.every((marker) => workflow.includes(marker));
}

function cacheIdentityIsShared() {
	const action = read(".github/actions/setup-rust/action.yml");
	const envVarLine = action
		.split("\n")
		.find((line) => line.trimStart().startsWith("env-vars:"));
	return (
		action.includes('default: "validation"') &&
		action.includes("/tmp/maestro-rust") &&
		!action.includes('base="${RUNNER_TEMP:-${GITHUB_WORKSPACE:-$PWD}/.tmp}/maestro-rust/${safe_repo}/${safe_job}') &&
		action.includes("getconf GNU_LIBC_VERSION") &&
		action.includes('add-job-id-key: "false"') &&
		envVarLine !== undefined &&
		!envVarLine.includes("CARGO_HOME") &&
		!envVarLine.includes("RUSTUP_HOME") &&
		action.includes("${{ inputs.cache-group }}")
	);
}

function validationContractsPass() {
	const ci = read(".github/workflows/ci.yml");
	const hooks = read(".github/workflows/hooks.yml");
	const coverage = read(".github/workflows/coverage.yml");
	const perf = read(".github/workflows/perf-baselines.yml");
	const scenario = read(".github/workflows/scenario-replay.yml");
	const integration = read(".github/workflows/integration.yml");
	return [
		ci.includes("cargo clippy --workspace --all-targets --locked -- -D warnings"),
		ci.includes("cargo test --workspace --locked"),
		ci.includes("npm run build"),
		ci.includes("npm run smoke:release-native-only"),
		hooks.includes("node scripts/check-hook-dispatch-coverage.mjs"),
		coverage.includes("cargo llvm-cov --workspace --locked --no-report"),
		perf.includes("maestro-perf-bench -- --baseline"),
		scenario.includes("npm run check:scenario-replay-gate"),
		integration.includes("cargo test --locked -p maestro-control-plane"),
	].every(Boolean);
}

const requiredStatusResult = evaluateRequiredStatusChecks({
	contexts: fixture.requiredContexts,
	root: repoRoot,
});
const cacheShared = cacheIdentityIsShared();
const activeLanes = fixture.lanes.filter(laneIsActive);
const projectedRustRunnerSeconds = activeLanes.reduce((total, lane) => {
	if (cacheShared && lane.cachedRunnerSeconds !== undefined) {
		return total + lane.cachedRunnerSeconds;
	}
	return total + lane.observedRunnerSeconds;
}, 0);
const slowestRustLaneSeconds = Math.max(
	...activeLanes.map((lane) =>
		cacheShared && lane.cachedWorkflowSeconds !== undefined
			? lane.cachedWorkflowSeconds
			: lane.observedWorkflowSeconds,
	),
);

const result = {
	projected_rust_runner_seconds: projectedRustRunnerSeconds,
	required_contexts_preserved: Number(requiredStatusResult.failures.length === 0),
	validation_contracts_preserved: Number(validationContractsPass()),
	measurement_fixture_valid: Number(
		fixture.lanes.length === 7 &&
		fixture.lanes.every(
			(lane) =>
				Number.isFinite(lane.observedRunnerSeconds) &&
				Number.isFinite(lane.observedWorkflowSeconds) &&
				lane.runId > 0,
		),
	),
	slowest_rust_lane_seconds: slowestRustLaneSeconds,
	independent_rust_compile_jobs: activeLanes.reduce(
		(total, lane) => total + lane.compileJobs,
		0,
	),
	cache_identity_partitions: cacheShared
		? fixture.optimizedCacheIdentityPartitions
		: fixture.baselineCacheIdentityPartitions,
	observed_cache_misses: fixture.observedCacheMisses,
	duplicate_validation_commands: activeLanes.filter(
		(lane) => lane.duplicateOf !== undefined,
	).length,
};

process.stdout.write(`${JSON.stringify(result)}\n`);

import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "run-scenario-replay-gate.mjs");

function createStub() {
	const root = mkdtempSync(join(tmpdir(), "maestro-scenario-gate-test-"));
	const stub = join(root, "maestro-stub.mjs");
	writeFileSync(
		stub,
		`#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const junit = process.argv[process.argv.indexOf("--junit") + 1];
mkdirSync(dirname(junit), { recursive: true });
writeFileSync(junit, "<testsuite tests=\\"1\\" failures=\\"0\\"/>\\n");
await new Promise((resolve) => setTimeout(resolve, 100));
if (process.env.STUB_MODE === "parse-fail") {
\tconsole.log("not-json");
\tprocess.exit(0);
}
if (process.env.STUB_MODE === "gate-fail") {
\tconsole.log(JSON.stringify({ releaseGate: { releaseBlocking: true, satisfied: false } }));
\tprocess.exit(0);
}
console.log(JSON.stringify({ scenario: { id: "stub", expectedOutcome: "pass", observedOutcome: "pass" }, counts: { assertions: 1, failed: 0, warnings: 0 } }));
`,
	);
	chmodSync(stub, 0o755);
	return { root, stub };
}

function runGate(
	stub,
	concurrency,
	{
		traceEnabled = false,
		mode = "success",
		expectedStatus = 0,
		maestroBin = stub,
	} = {},
) {
	const repoRoot = dirname(dirname(script));
	// Clean checkouts do not contain the ignored tmp/ parent yet.
	mkdirSync(join(repoRoot, "tmp"), { recursive: true });
	const output = mkdtempSync(
		join(repoRoot, "tmp/maestro-scenario-gate-output-"),
	);
	const relativeOutput = output.slice(`${repoRoot}/`.length);
	const result = spawnSync(process.execPath, [script, "--junit-dir", relativeOutput], {
		cwd: dirname(script),
		encoding: "utf8",
		env: {
			...process.env,
			MAESTRO_BIN: maestroBin,
			MAESTRO_SCENARIO_TRACE: traceEnabled ? "1" : "0",
			STUB_MODE: mode,
			SCENARIO_REPLAY_CONCURRENCY: String(concurrency),
		},
	});
	assert.equal(result.status, expectedStatus, result.stderr);
	return {
		summary: JSON.parse(
			readFileSync(join(repoRoot, relativeOutput, "summary.json"), "utf8"),
		),
		markdown: readFileSync(join(repoRoot, relativeOutput, "summary.md"), "utf8"),
		stderr: result.stderr,
	};
}

test("bounded parallel replay preserves all fixtures and cuts wall clock", () => {
	const { root, stub } = createStub();
	const { summary: serial } = runGate(stub, 1);
	const { summary: parallel } = runGate(stub, 4);

	assert.equal(serial.fixtures, 8);
	assert.equal(parallel.fixtures, serial.fixtures);
	assert.equal(parallel.results.length, serial.results.length);
	assert.ok(
		parallel.results.every((result) => result.status === "pass"),
		"parallel replay should preserve successful fixture results",
	);
	assert.ok(
		parallel.durationMs < serial.durationMs * 0.8,
		`expected parallel ${parallel.durationMs}ms < 80% of serial ${serial.durationMs}ms`,
	);
	assert.ok(root, "keep temporary stub rooted for debuggable failure output");
});

test("fixture completion traces include the process exit code", () => {
	const { stub } = createStub();
	const { stderr } = runGate(stub, 4, { traceEnabled: true });
	const completed = stderr
		.trim()
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		})
		.filter((event) => event.event === "fixture_completed");

	assert.equal(completed.length, 8);
	assert.ok(completed.every((event) => event.exitCode === 0));
});

test("exit-zero gate and parse failures keep distinct summary labels", () => {
	for (const [mode, label] of [
		["gate-fail", "gate"],
		["parse-fail", "parse"],
	]) {
		const { stub } = createStub();
		const { summary, markdown, stderr } = runGate(stub, 4, {
			mode,
			expectedStatus: 1,
			traceEnabled: true,
		});
		const completed = stderr
			.trim()
			.split("\n")
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			})
			.filter((event) => event.event === "fixture_completed");
		assert.equal(completed.length, 8);
		assert.ok(completed.every((event) => event.exitCode === 0));
		assert.ok(summary.results.every((result) => result.failureKind === label));
		assert.match(markdown, new RegExp(`failed \\(${label}\\)`));
	}
});

test("spawn failures have an explicit summary and trace label", () => {
	const { root, stub } = createStub();
	const missingBinary = join(root, "missing-maestro");
	const { summary, markdown, stderr } = runGate(stub, 4, {
		maestroBin: missingBinary,
		expectedStatus: 1,
		traceEnabled: true,
	});
	const completed = stderr
		.trim()
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		})
		.filter((event) => event.event === "fixture_completed");

	assert.equal(completed.length, 8);
	assert.ok(
		completed.every(
			(event) => event.failureKind === "spawn" && event.exitCode === null,
		),
	);
	assert.ok(summary.results.every((result) => result.failureKind === "spawn"));
	assert.match(markdown, /failed \(spawn\)/);
});

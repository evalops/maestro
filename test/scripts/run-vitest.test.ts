import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createVitestSummaryTracker } from "../../scripts/run-vitest.js";

describe("run-vitest summary tracking", () => {
	it("recognizes a passing Vitest summary split across chunks", () => {
		const tracker = createVitestSummaryTracker();

		tracker.push("\u001b[2m Test Fi");
		expect(tracker.passed).toBe(false);

		tracker.push(
			"les \u001b[22m \u001b[1m\u001b[32m44 passed\u001b[39m\u001b[22m\u001b[90m (44)\u001b[39m\n\u001b[2m      Tes",
		);
		expect(tracker.passed).toBe(false);

		tracker.push(
			"ts \u001b[22m \u001b[1m\u001b[32m944 passed\u001b[39m\u001b[22m\u001b[90m (944)\u001b[39m\n",
		);
		expect(tracker.passed).toBe(true);
	});

	it("does not treat a failed summary as passing", () => {
		const tracker = createVitestSummaryTracker();

		tracker.push(" Test Files  43 passed | 1 failed");
		tracker.push("      Tests  940 passed | 4 failed");

		expect(tracker.passed).toBe(false);
	});

	it("ignores ordinary log lines that contain the word failed", () => {
		const tracker = createVitestSummaryTracker();

		tracker.push("warning: withRetry failed, retrying");
		tracker.push("summary: Tests failed before the retry");
		tracker.push(" Test Files  44 passed");
		tracker.push("      Tests  944 passed");

		expect(tracker.passed).toBe(true);
	});

	it("terminates a stuck CI run after a passing summary", () => {
		const tempDir = join(tmpdir(), `maestro-run-vitest-${process.pid}`);
		const fakeBunx = join(tempDir, "bunx");
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			fakeBunx,
			[
				"#!/usr/bin/env node",
				"console.log(' Test Files  1 passed (1)')",
				"console.log('      Tests  1 passed (1)')",
				"setInterval(() => {}, 1000)",
				"",
			].join("\n"),
		);
		chmodSync(fakeBunx, 0o755);

		try {
			const result = spawnSync(
				process.execPath,
				[resolve("scripts/run-vitest.js"), "--run"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_ACTIONS: "true",
						PATH: `${tempDir}:${process.env.PATH ?? ""}`,
						VITEST_CI_POST_SUCCESS_EXIT_GRACE_MS: "25",
					},
					timeout: 5000,
				},
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Test Files  1 passed");
			expect(result.stderr).toContain("terminating CI process group");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("does not force success before coverage post-processing exits", () => {
		const tempDir = join(
			tmpdir(),
			`maestro-run-vitest-coverage-${process.pid}`,
		);
		const fakeBunx = join(tempDir, "bunx");
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			fakeBunx,
			[
				"#!/usr/bin/env node",
				"console.log(' Test Files  1 passed (1)')",
				"console.log('      Tests  1 passed (1)')",
				"setTimeout(() => process.exit(1), 75)",
				"",
			].join("\n"),
		);
		chmodSync(fakeBunx, 0o755);

		try {
			const result = spawnSync(
				process.execPath,
				[resolve("scripts/run-vitest.js"), "--run", "--coverage"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_ACTIONS: "true",
						PATH: `${tempDir}:${process.env.PATH ?? ""}`,
						VITEST_CI_POST_SUCCESS_EXIT_GRACE_MS: "25",
					},
					timeout: 5000,
				},
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain("terminating CI process group");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});

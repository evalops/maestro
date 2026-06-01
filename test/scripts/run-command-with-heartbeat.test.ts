import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/run-command-with-heartbeat.mjs";

const roots: string[] = [];
const scriptPath = join(
	process.cwd(),
	"scripts/run-command-with-heartbeat.mjs",
);

function makeRoot() {
	const root = mkdtempSync(join(tmpdir(), "maestro-run-heartbeat-"));
	roots.push(root);
	return root;
}

describe("run-command-with-heartbeat", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("parses command arguments after the separator", () => {
		expect(
			parseArgs([
				"--label",
				"Nx",
				"--logfile",
				"nx.log",
				"--timing-file",
				"timing.jsonl",
				"--summary-json",
				"nx.json",
				"--timeout-seconds",
				"10",
				"--heartbeat-seconds",
				"2",
				"--success-idle-final-pattern",
				"done",
				"--",
				"node",
				"-e",
				"console.log('ok')",
			]),
		).toMatchObject({
			command: ["node", "-e", "console.log('ok')"],
			heartbeatSeconds: 2,
			label: "Nx",
			logfile: "nx.log",
			successIdleFinalPattern: "done",
			timingFile: "timing.jsonl",
			summaryJson: "nx.json",
			timeoutSeconds: 10,
		});
	});

	it("mirrors command output into the logfile", () => {
		const root = makeRoot();
		const logfile = join(root, "command.log");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"quick command",
				"--logfile",
				logfile,
				"--timeout-seconds",
				"5",
				"--heartbeat-seconds",
				"0",
				"--",
				process.execPath,
				"-e",
				"console.log('hello from child')",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("hello from child");
		expect(readFileSync(logfile, "utf8")).toContain("hello from child");
	});

	it("writes a JSONL timing record", () => {
		const root = makeRoot();
		const timingFile = join(root, "timing.jsonl");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"timed command",
				"--timing-file",
				timingFile,
				"--timeout-seconds",
				"5",
				"--heartbeat-seconds",
				"0",
				"--",
				process.execPath,
				"-e",
				"console.log('timed ok')",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const [line] = readFileSync(timingFile, "utf8").trim().split("\n");
		const timing = JSON.parse(line ?? "{}") as {
			label?: string;
			status?: string;
			durationMs?: number;
			command?: string[];
		};
		expect(timing).toMatchObject({
			label: "timed command",
			status: "passed",
		});
		expect(timing.durationMs).toBeGreaterThanOrEqual(0);
		expect(timing.command?.[0]).toBe(process.execPath);
	});

	it("writes a summary JSON file for successful commands", () => {
		const root = makeRoot();
		const summaryJson = join(root, "summary.json");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"quick command",
				"--summary-json",
				summaryJson,
				"--timeout-seconds",
				"5",
				"--heartbeat-seconds",
				"0",
				"--",
				process.execPath,
				"-e",
				"console.log('ok')",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const summary = JSON.parse(readFileSync(summaryJson, "utf8"));
		expect(summary).toMatchObject({
			command: [process.execPath, "-e", "console.log('ok')"],
			exitCode: 0,
			label: "quick command",
			timedOut: false,
		});
		expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(summary.startedAt).toEqual(expect.any(String));
		expect(summary.finishedAt).toEqual(expect.any(String));
	});

	it("records failed command exit codes in summary JSON", () => {
		const root = makeRoot();
		const summaryJson = join(root, "failed-summary.json");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"failing command",
				"--summary-json",
				summaryJson,
				"--heartbeat-seconds",
				"0",
				"--",
				process.execPath,
				"-e",
				"process.exit(7)",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(7);
		expect(JSON.parse(readFileSync(summaryJson, "utf8"))).toMatchObject({
			exitCode: 7,
			label: "failing command",
			signal: null,
			timedOut: false,
		});
	});

	it("returns success when a command is idle after a passing summary", () => {
		const root = makeRoot();
		const logfile = join(root, "success-idle.log");
		const summaryJson = join(root, "success-idle-summary.json");
		const timingFile = join(root, "success-idle-timing.jsonl");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"stuck passing tests",
				"--logfile",
				logfile,
				"--summary-json",
				summaryJson,
				"--timing-file",
				timingFile,
				"--timeout-seconds",
				"10",
				"--heartbeat-seconds",
				"0",
				"--success-idle-seconds",
				"1",
				"--success-idle-pattern",
				"\\bTest Files\\b[^\\n]*\\d+\\s+passed\\b[\\s\\S]*\\bTests\\b[^\\n]*\\d+\\s+passed\\b",
				"--success-idle-final-pattern",
				"\\bSuccessfully ran target\\s+test\\b",
				"--",
				process.execPath,
				"-e",
				"console.log(' Test Files  1 passed (1)'); console.log('      Tests  1 passed (1)'); console.log(' NX  Successfully ran target test for 1 project'); setInterval(() => {}, 1000)",
			],
			{ encoding: "utf8", timeout: 5000 },
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("matched success-idle pattern");
		expect(readFileSync(logfile, "utf8")).toContain("Test Files  1 passed");
		expect(JSON.parse(readFileSync(summaryJson, "utf8"))).toMatchObject({
			exitCode: 0,
			forcedSuccess: true,
			timedOut: false,
		});
		expect(readFileSync(timingFile, "utf8")).toContain("passed_forced_success");
	});

	it("does not force success before the final completion marker", () => {
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"unfinished shard tests",
				"--timeout-seconds",
				"10",
				"--heartbeat-seconds",
				"0",
				"--success-idle-seconds",
				"1",
				"--success-idle-pattern",
				"\\bTest Files\\b[^\\n]*\\d+\\s+passed\\b[\\s\\S]*\\bTests\\b[^\\n]*\\d+\\s+passed\\b",
				"--success-idle-final-pattern",
				"\\bSuccessfully ran target\\s+test\\b",
				"--",
				process.execPath,
				"-e",
				"console.log(' Test Files  1 passed (1)'); console.log('      Tests  1 passed (1)'); setTimeout(() => process.exit(9), 1500)",
			],
			{ encoding: "utf8", timeout: 5000 },
		);

		expect(result.status).toBe(9);
		expect(result.stderr).not.toContain(
			"terminating process group as successful",
		);
	});

	it("returns 124 when the command exceeds the timeout", () => {
		const root = makeRoot();
		const summaryJson = join(root, "timeout-summary.json");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--label",
				"slow command",
				"--summary-json",
				summaryJson,
				"--timeout-seconds",
				"1",
				"--heartbeat-seconds",
				"0",
				"--",
				process.execPath,
				"-e",
				"setTimeout(() => {}, 5000)",
			],
			{ encoding: "utf8", timeout: 5000 },
		);

		expect(result.status).toBe(124);
		expect(result.stderr).toContain("slow command timed out after 1s");
		expect(JSON.parse(readFileSync(summaryJson, "utf8"))).toMatchObject({
			exitCode: 124,
			label: "slow command",
			timedOut: true,
		});
	});
});

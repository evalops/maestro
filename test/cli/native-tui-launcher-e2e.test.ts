import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function writeFakeBinary(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-tui-fake-"));
	const path = join(dir, "maestro-tui");
	writeFileSync(path, script, { encoding: "utf8", mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

describe("native TUI launcher e2e (spawn real CLI)", () => {
	it("hands interactive mode to MAESTRO_TUI_BIN with model flag", () => {
		const argsFile = join(
			mkdtempSync(join(tmpdir(), "maestro-tui-args-")),
			"args.txt",
		);
		const fake = writeFakeBinary(`#!/bin/sh
printf '%s\\n' "$*" > "${argsFile}"
exit 0
`);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"./src/cli.ts",
				"--provider",
				"openai",
				"-m",
				"gpt-4o-mini",
			],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
					MAESTRO_TUI_BIN: fake,
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const args = readFileSync(argsFile, "utf8").trim();
		expect(args).toContain("--provider openai");
		expect(args).toContain("--model gpt-4o-mini");
	});

	it("forwards non-zero child exit codes", () => {
		const fake = writeFakeBinary(`#!/bin/sh
exit 42
`);
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "./src/cli.ts"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
					MAESTRO_TUI_BIN: fake,
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(42);
	});

	it("forwards --resume without launching the old TS session selector", () => {
		const argsFile = join(
			mkdtempSync(join(tmpdir(), "maestro-tui-args-")),
			"args.txt",
		);
		const fake = writeFakeBinary(`#!/bin/sh
printf '%s\\n' "$*" > "${argsFile}"
exit 0
`);
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "./src/cli.ts", "--resume"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
					MAESTRO_TUI_BIN: fake,
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const args = readFileSync(argsFile, "utf8").trim();
		expect(args).toBe("--resume");
		expect(result.stdout + result.stderr).not.toMatch(/No session selected/i);
	});

	it("does not require maestro-tui for --help", () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "./src/cli.ts", "--help"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
					MAESTRO_TUI_BIN: "/definitely/missing-maestro-tui",
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/Usage/i);
	});
});

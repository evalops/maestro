import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertInstallablePackageMetadata,
	runBunxCliSmoke,
	runNpxCliSmoke,
} from "../../scripts/install-smoke-utils.js";

function withFakeLauncher(commandName: string, run: (logPath: string) => void) {
	const tempDir = mkdtempSync(join(tmpdir(), `maestro-${commandName}-`));
	const commandPath = join(tempDir, commandName);
	const logPath = join(tempDir, "calls.jsonl");
	const previousPath = process.env.PATH;
	const previousLogPath = process.env.MAESTRO_FAKE_LAUNCHER_LOG;
	writeFileSync(
		commandPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MAESTRO_FAKE_LAUNCHER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) {
	console.log("Maestro v9.9.9");
	process.exit(0);
}
if (process.argv.includes("--help")) {
	process.exit(0);
}
process.exit(2);
`,
	);
	chmodSync(commandPath, 0o755);
	try {
		process.env.PATH = `${tempDir}${delimiter}${previousPath ?? ""}`;
		process.env.MAESTRO_FAKE_LAUNCHER_LOG = logPath;
		run(logPath);
	} finally {
		process.env.PATH = previousPath;
		if (previousLogPath === undefined) {
			delete process.env.MAESTRO_FAKE_LAUNCHER_LOG;
		} else {
			process.env.MAESTRO_FAKE_LAUNCHER_LOG = previousLogPath;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function readLauncherCalls(logPath: string) {
	return readFileSync(logPath, "utf8")
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line));
}

describe("assertInstallablePackageMetadata", () => {
	it("allows ordinary registry dependencies", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@bufbuild/protobuf": "^2.11.0",
						zod: "^4.3.6",
					},
				},
				{
					label: "packed package",
					forbiddenWorkspaceNames: ["@evalops/contracts", "@evalops/tui"],
				},
			),
		).not.toThrow();
	});

	it("rejects private runtime workspaces in install-time dependencies", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@evalops/contracts": "^0.10.21",
					},
					optionalDependencies: {
						"@evalops/tui": "^0.10.21",
					},
				},
				{
					label: "published package",
					forbiddenWorkspaceNames: ["@evalops/contracts", "@evalops/tui"],
				},
			),
		).toThrow(
			"published package exposes non-registry workspace metadata: dependencies.@evalops/contracts, optionalDependencies.@evalops/tui",
		);
	});

	it("rejects workspace protocol specs and bundled private workspaces", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@evalops/maestro-helper": "workspace:*",
					},
					bundleDependencies: ["@evalops/contracts"],
				},
				{
					label: "packed package",
					forbiddenWorkspaceNames: ["@evalops/contracts"],
				},
			),
		).toThrow(
			"packed package exposes non-registry workspace metadata: bundleDependencies.@evalops/contracts, dependencies.@evalops/maestro-helper=workspace:",
		);
	});

	it("smoke-tests npm installs through the npx launcher", () => {
		withFakeLauncher("npx", (logPath) => {
			runNpxCliSmoke(process.cwd(), {
				cliCommand: "maestro",
				expectedVersion: "9.9.9",
				label: "fake npx",
			});

			expect(readLauncherCalls(logPath)).toEqual([
				["--no-install", "maestro", "--version"],
				["--no-install", "maestro", "--help"],
			]);
		});
	});

	it("smoke-tests Bun installs through the bunx launcher", () => {
		withFakeLauncher("bunx", (logPath) => {
			runBunxCliSmoke(process.cwd(), {
				cliCommand: "maestro",
				expectedVersion: "9.9.9",
				label: "fake bunx",
			});

			expect(readLauncherCalls(logPath)).toEqual([
				["maestro", "--version"],
				["maestro", "--help"],
			]);
		});
	});
});

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = join(
	process.cwd(),
	"scripts/check-prepared-public-mirror-tree.mjs",
);

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-prepared-public-mirror-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(root, { recursive: true });
	write(join(root, "package.json"), JSON.stringify({ scripts: {} }, null, 2));
	write(join(root, "src/cli/args.ts"), "const COMMANDS = new Set([]);\n");
	write(
		join(root, "scripts/check-public-surface-boundary.mjs"),
		[
			"#!/usr/bin/env node",
			"import { existsSync } from 'node:fs';",
			"if (existsSync('src/cli/commands/scenario.ts')) process.exit(1);",
			"console.log('Public surface boundary check passed.');",
		].join("\n"),
	);
	return root;
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function runCheck(target: string) {
	return spawnSync(process.execPath, [scriptPath, "--target", target], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

describe("check-prepared-public-mirror-tree", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("accepts a prepared public tree that can run its own boundary check", () => {
		const target = makeFixture();

		const result = runCheck(target);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"Prepared public mirror tree smoke passed.",
		);
	});

	it("rejects an internal mirror exclude file in the prepared public tree", () => {
		const target = makeFixture();
		write(join(target, ".github/public-release-mirror.exclude"), "internal\n");

		const result = runCheck(target);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			".github/public-release-mirror.exclude must not exist",
		);
	});

	it("surfaces public boundary check failures from the prepared tree", () => {
		const target = makeFixture();
		write(join(target, "src/cli/commands/scenario.ts"), "export {};\n");

		const result = runCheck(target);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Public surface boundary smoke failed");
	});
});

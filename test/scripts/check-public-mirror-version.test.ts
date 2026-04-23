import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = join(
	process.cwd(),
	"scripts/check-public-mirror-version.mjs",
);
const fixturePackageScope = "@evalops";
const fixturePackageName = "maestro";

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-public-mirror-version-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(source, { recursive: true });
	mkdirSync(target, { recursive: true });
	return { source, target };
}

function writePackage(root: string, version: string) {
	const name = `${fixturePackageScope}/${fixturePackageName}`;
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name, version }, null, 2)}\n`,
	);
}

function runCheck(source: string, target: string, ...extraArgs: string[]) {
	return spawnSync(
		process.execPath,
		[scriptPath, "--source", source, "--target", target, ...extraArgs],
		{
			encoding: "utf8",
		},
	);
}

describe("check-public-mirror-version", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("accepts matching or newer internal versions", () => {
		const { source, target } = makeFixture();
		writePackage(source, "1.2.4");
		writePackage(target, "1.2.3");

		const result = runCheck(source, target);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Public mirror version check passed");
	});

	it("rejects accidental public version rollbacks", () => {
		const { source, target } = makeFixture();
		writePackage(source, "1.2.2");
		writePackage(target, "1.2.3");

		const result = runCheck(source, target);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Refusing to mirror internal version");
	});

	it("allows explicit recovery rollbacks", () => {
		const { source, target } = makeFixture();
		writePackage(source, "1.2.2");
		writePackage(target, "1.2.3");

		const result = runCheck(source, target, "--allow-rollback");

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("Allowing public mirror rollback");
	});
});

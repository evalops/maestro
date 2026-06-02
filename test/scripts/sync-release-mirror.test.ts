import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-sync-release-mirror-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(source, { recursive: true });
	mkdirSync(target, { recursive: true });
	return { source, target };
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function runSyncReleaseMirror(source: string, target: string) {
	return execFileSync(
		process.execPath,
		["scripts/sync-release-mirror.mjs", "--source", source, "--target", target],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
}

function runSyncReleaseMirrorResult(source: string, target: string) {
	return spawnSync(
		process.execPath,
		["scripts/sync-release-mirror.mjs", "--source", source, "--target", target],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
}

describe("sync-release-mirror", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("skips helper sync in public trees without the internal manifest", () => {
		const { source, target } = makeFixture();

		expect(runSyncReleaseMirror(source, target)).toContain(
			"Release mirror manifest is absent in this public tree; skipping helper sync.",
		);
	});

	it("still requires the internal manifest for internal mirror sources", () => {
		const { source, target } = makeFixture();
		write(join(source, ".github/public-release-mirror.exclude"), "");

		const result = runSyncReleaseMirrorResult(source, target);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Missing release mirror manifest");
	});

	it("syncs files listed in the internal release mirror manifest", () => {
		const { source, target } = makeFixture();
		write(
			join(source, ".github/release-mirror-manifest.json"),
			JSON.stringify({ files: ["scripts/release-helper.mjs"] }),
		);
		write(join(source, ".github/public-release-mirror.exclude"), "");
		write(join(source, "scripts/release-helper.mjs"), "helper\n");

		expect(runSyncReleaseMirror(source, target)).toContain(
			"Synced 1 mirrored release files.",
		);
		expect(existsSync(join(target, "scripts/release-helper.mjs"))).toBe(true);
	});
});

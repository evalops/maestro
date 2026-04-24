import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = join(process.cwd(), "scripts/check-public-mirror-drift.mjs");
const packageName = ["@evalops", "maestro"].join("/");

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-public-mirror-drift-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(source, { recursive: true });
	mkdirSync(target, { recursive: true });
	writePackage(source);
	writePackage(target);
	return { root, source, target };
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function writePackage(root: string) {
	write(
		join(root, "package.json"),
		`${JSON.stringify(
			{
				name: packageName,
				version: "1.0.0",
				maestro: {
					canonicalPackageName: packageName,
					packageAliases: [packageName],
				},
			},
			null,
			2,
		)}\n`,
	);
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function runCheck(
	source: string,
	target: string,
	reportPath: string,
	statusPath: string,
	markdownPath: string,
) {
	return spawnSync(
		process.execPath,
		[
			scriptPath,
			"--source",
			source,
			"--target",
			target,
			"--report",
			reportPath,
			"--status-output",
			statusPath,
			"--markdown-output",
			markdownPath,
			"--summary-limit",
			"3",
		],
		{ encoding: "utf8" },
	);
}

describe("check-public-mirror-drift", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("writes source-of-truth status when public is in sync", () => {
		const { root, source, target } = makeFixture();
		write(join(source, "README.md"), "hello\n");
		write(join(target, "README.md"), "hello\n");
		const reportPath = join(root, "drift.json");
		const statusPath = join(root, "status.json");
		const markdownPath = join(root, "status.md");

		const result = runCheck(
			source,
			target,
			reportPath,
			statusPath,
			markdownPath,
		);

		expect(result.status).toBe(0);
		const status = readJson(statusPath);
		expect(status).toMatchObject({
			invariant: "public_is_verified_projection",
			mirror: {
				filesToCopyOrUpdate: 0,
				staleFilesToDelete: 0,
				publicPackageName: packageName,
			},
			result: "in_sync",
		});
		expect(readFileSync(markdownPath, "utf8")).toContain(
			"public_is_verified_projection",
		);
	});

	it("reports sampled changed paths when public has drift", () => {
		const { root, source, target } = makeFixture();
		write(join(source, "README.md"), "new\n");
		write(join(target, "README.md"), "old\n");
		const reportPath = join(root, "drift.json");
		const statusPath = join(root, "status.json");
		const markdownPath = join(root, "status.md");

		const result = runCheck(
			source,
			target,
			reportPath,
			statusPath,
			markdownPath,
		);

		expect(result.status).toBe(1);
		const status = readJson(statusPath);
		expect(status).toMatchObject({
			invariant: "public_projection_has_drift",
			mirror: {
				filesToCopyOrUpdate: 1,
				sampledChangedPaths: ["copy/update README.md"],
			},
			result: "drift_detected",
		});
		expect(readFileSync(markdownPath, "utf8")).toContain("drift detected");
	});
});

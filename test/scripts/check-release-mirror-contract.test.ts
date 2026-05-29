import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = join(
	process.cwd(),
	"scripts/check-release-mirror-contract.mjs",
);

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-release-mirror-contract-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(root, { recursive: true });
	write(
		join(root, ".github/RELEASE_MIRROR_CONTRACT.md"),
		"# Release Mirror Contract\n",
	);
	return root;
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function writeManifest(root: string, files: string[]) {
	write(
		join(root, ".github/release-mirror-manifest.json"),
		`${JSON.stringify({ files }, null, 2)}\n`,
	);
	for (const file of files) {
		write(join(root, file), "fixture\n");
	}
}

function runCheck(root: string) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd: root,
		encoding: "utf8",
	});
}

describe("check-release-mirror-contract", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("accepts a valid release mirror manifest", () => {
		const root = makeFixture();
		writeManifest(root, ["scripts/release-readiness.js"]);

		const result = runCheck(root);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Release mirror contract is valid.");
	});

	it("rejects legacy grouped command surfaces", () => {
		const root = makeFixture();
		writeManifest(root, ["src/cli-tui/commands/grouped/package.ts"]);

		const result = runCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("internal-only grouped-command surface");
	});

	it("keeps the command-suite mirror files together", () => {
		const root = makeFixture();
		writeManifest(root, ["src/cli-tui/commands/command-suite-handlers.ts"]);

		const result = runCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Missing command-suite mirror file: src/cli-tui/commands/command-catalog.ts",
		);
	});

	it("keeps mirrored local action dependencies together", () => {
		const root = makeFixture();
		write(
			join(root, ".github/release-mirror-manifest.json"),
			`${JSON.stringify(
				{ files: [".github/actions/setup-bun-nx/action.yml"] },
				null,
				2,
			)}\n`,
		);
		write(
			join(root, ".github/actions/setup-bun-nx/action.yml"),
			[
				"name: setup-bun-nx",
				"runs:",
				"  using: composite",
				"  steps:",
				"    - name: Ensure ripgrep",
				"      uses: ./.github/actions/ensure-ripgrep",
				"",
			].join("\n"),
		);

		const result = runCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Missing local action dependency for .github/actions/setup-bun-nx/action.yml: .github/actions/ensure-ripgrep/action.yml",
		);
	});
});

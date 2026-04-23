import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const internalPackageName = ["@evalops-jh", "maestro"].join("/");
const publicPackageName = ["@evalops", "maestro"].join("/");

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-release-context-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(join(root, "scripts"), { recursive: true });
	return root;
}

function copyScript(root: string, scriptName: string) {
	writeFileSync(
		join(root, "scripts", scriptName),
		readFileSync(join(process.cwd(), "scripts", scriptName), "utf8"),
	);
}

describe("release-context dependencies", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("loads package metadata before workspace dependencies are installed", () => {
		const root = makeFixture();
		copyScript(root, "package-metadata.js");
		copyScript(root, "workspace-utils.js");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify(
				{
					name: internalPackageName,
					version: "1.2.3",
					type: "module",
					bin: { maestro: "dist/cli.js" },
					maestro: {
						canonicalPackageName: publicPackageName,
						packageAliases: [internalPackageName],
					},
				},
				null,
				2,
			),
		);

		const output = execFileSync(process.execPath, ["--input-type=module"], {
			cwd: root,
			encoding: "utf8",
			input: [
				'import { getPackageMetadata } from "./scripts/package-metadata.js";',
				"console.log(JSON.stringify(getPackageMetadata()));",
			].join("\n"),
		});
		const metadata = JSON.parse(output) as Record<string, unknown>;

		expect(metadata.name).toBe(internalPackageName);
		expect(metadata.canonicalPackageName).toBe(publicPackageName);
		expect(metadata.packageAliases).toEqual([
			internalPackageName,
			publicPackageName,
		]);
	});
});

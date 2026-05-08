import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validatePackageBoundaries } from "../../scripts/validate-package-boundaries.js";

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-package-boundary-"));
	roots.push(root);
	mkdirSync(join(root, "packages", "facade", "src"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "src", "shared.ts"),
		"export const shared = 'root-runtime';\n",
	);
	writeFileSync(
		join(root, "packages", "facade", "src", "index.ts"),
		"export { shared } from '../../../src/shared.js';\n",
	);
	return root;
}

function writePackageJson(root: string, extra: Record<string, unknown> = {}) {
	writeFileSync(
		join(root, "packages", "facade", "package.json"),
		JSON.stringify(
			{
				name: "@evalops/facade",
				version: "0.0.0",
				type: "module",
				...extra,
			},
			null,
			2,
		),
	);
}

describe("validatePackageBoundaries", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects hidden imports from package source into root source", () => {
		const root = makeRoot();
		writePackageJson(root);

		expect(validatePackageBoundaries(root)).toEqual([
			"packages/facade/src/index.ts imports ../../../src/shared.js which resolves outside packages/facade",
		]);
	});

	it("allows explicitly declared internal facade packages", () => {
		const root = makeRoot();
		writePackageJson(root, {
			maestro: {
				packageBoundary: {
					mode: "internal-facade",
					allowedExternalSourceRoots: ["../../src"],
					rationale:
						"Stable package entrypoint while the root kernel is extracted.",
				},
			},
		});

		expect(validatePackageBoundaries(root)).toEqual([]);
	});

	it("rejects facade source roots outside the repository", () => {
		const root = makeRoot();
		writePackageJson(root, {
			maestro: {
				packageBoundary: {
					mode: "internal-facade",
					allowedExternalSourceRoots: ["../../../../outside"],
					rationale: "Invalid external root.",
				},
			},
		});

		expect(validatePackageBoundaries(root)).toContain(
			"@evalops/facade allows source root ../../../../outside outside the repository",
		);
	});

	it("can be imported when Node does not provide argv[1]", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"process.argv.splice(1); await import(process.env.VALIDATOR_URL); console.log('imported');",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					VALIDATOR_URL: pathToFileURL(
						join(process.cwd(), "scripts/validate-package-boundaries.js"),
					).href,
				},
			},
		);

		expect(output.trim()).toBe("imported");
	});
});

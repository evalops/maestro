import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeWorkspacePackageHash,
	parseOptions,
	selectWorkspacePackages,
	workspacePackageNeedsBuild,
	workspaceStampPath,
} from "../../scripts/ensure-deps.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-ensure-deps-"));
	roots.push(root);
	const packageDir = join(root, "packages", "demo");
	mkdirSync(join(packageDir, "src"), { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "@demo/pkg" }),
	);
	writeFileSync(join(packageDir, "tsconfig.build.json"), JSON.stringify({}));
	writeFileSync(
		join(packageDir, "src", "index.ts"),
		"export const ok = true;\n",
	);
	return {
		root,
		packageDir,
		spec: {
			name: "@demo/pkg",
			dir: "packages/demo",
			outputs: ["dist/index.js", "dist/index.d.ts"],
		},
	};
}

describe("ensure-deps workspace bootstrap", () => {
	it("selects a contracts-only bootstrap for web and CI callers", () => {
		const options = parseOptions([
			"--no-install",
			"--workspace",
			"@evalops/contracts",
		]);

		expect(options).toEqual({
			allowInstall: false,
			workspaceNames: ["@evalops/contracts"],
		});
		expect(
			selectWorkspacePackages(options.workspaceNames).map((pkg) => pkg.name),
		).toEqual(["@evalops/contracts"]);
	});

	it("requires a build when package dist outputs are missing", () => {
		const { root, spec } = makeFixture();

		expect(workspacePackageNeedsBuild(root, spec)).toBe(true);
	});

	it("skips a build when outputs and the source hash stamp are current", () => {
		const { root, packageDir, spec } = makeFixture();
		const hash = computeWorkspacePackageHash(root, spec);
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "dist", "index.js"), "export {};\n");
		writeFileSync(join(packageDir, "dist", "index.d.ts"), "export {};\n");
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(workspaceStampPath(root, spec), hash);

		expect(workspacePackageNeedsBuild(root, spec)).toBe(false);
	});

	it("includes contracts codegen inputs in the workspace build hash", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-ensure-deps-"));
		roots.push(root);
		const packageDir = join(root, "packages", "contracts");
		mkdirSync(join(packageDir, "src"), { recursive: true });
		mkdirSync(join(root, "proto", "maestro", "v1"), { recursive: true });
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "@evalops/contracts" }),
		);
		writeFileSync(join(packageDir, "tsconfig.build.json"), JSON.stringify({}));
		writeFileSync(join(packageDir, "src", "index.ts"), "export {};\n");
		writeFileSync(join(root, "bun.lockb"), "lock-v1\n");
		writeFileSync(join(root, "buf.gen.yaml"), "version: v2\n");
		writeFileSync(join(root, "buf.yaml"), "version: v2\n");
		writeFileSync(
			join(root, "proto", "maestro", "v1", "headless.proto"),
			'syntax = "proto3";\n',
		);
		writeFileSync(
			join(root, "scripts", "headless-protocol-codegen.mjs"),
			"console.log('v1');\n",
		);

		const spec = {
			name: "@evalops/contracts",
			dir: "packages/contracts",
			outputs: ["dist/index.js"],
		};
		const before = computeWorkspacePackageHash(root, spec);

		writeFileSync(
			join(root, "proto", "maestro", "v1", "headless.proto"),
			'syntax = "proto3";\nmessage Changed {}\n',
		);

		expect(computeWorkspacePackageHash(root, spec)).not.toBe(before);
	});
});

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeWorkspacePackageHash,
	parseOptions,
	selectWorkspacePackages,
	workspacePackageNeedsBuild,
	workspaceStampPath,
	writeInstallStamp,
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
	it("gates the install lifecycle to monorepo checkouts", () => {
		const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
			scripts?: Record<string, string>;
		};

		expect(rootPackage.scripts?.postinstall).toContain(
			"./scripts/ensure-deps.js",
		);
		expect(rootPackage.scripts?.postinstall).toContain(
			"./packages/contracts/package.json",
		);
	});

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

	it("records the lockfile stamp when install lifecycle assumes deps are present", () => {
		const { root } = makeFixture();
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "bun.lockb"), "lock-v1\n");

		const originalCwd = process.cwd();
		try {
			process.chdir(root);
			writeInstallStamp();
		} finally {
			process.chdir(originalCwd);
		}

		expect(
			readFileSync(join(root, "node_modules", ".bun-lockb.sha256"), "utf8"),
		).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("does not stamp the lockfile hash in no-install mode", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-ensure-deps-"));
		roots.push(root);
		writeFileSync(join(root, "bun.lockb"), "lock-v1\n");
		writeFileSync(join(root, "tsconfig.base.json"), JSON.stringify({}));
		mkdirSync(join(root, "node_modules"), { recursive: true });

		const specs = [
			{
				name: "@evalops/contracts",
				dir: "packages/contracts",
				outputs: ["dist/index.js", "dist/index.d.ts"],
			},
			{
				name: "@evalops/tui",
				dir: "packages/tui",
				outputs: ["dist/index.js", "dist/index.d.ts"],
			},
		];
		for (const spec of specs) {
			const packageDir = join(root, spec.dir);
			mkdirSync(join(packageDir, "dist"), { recursive: true });
			mkdirSync(join(packageDir, "src"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: spec.name }),
			);
			writeFileSync(
				join(packageDir, "tsconfig.build.json"),
				JSON.stringify({}),
			);
			writeFileSync(join(packageDir, "src", "index.ts"), "export {};\n");
			writeFileSync(join(packageDir, "dist", "index.js"), "export {};\n");
			writeFileSync(join(packageDir, "dist", "index.d.ts"), "export {};\n");
			writeFileSync(
				workspaceStampPath(root, spec),
				computeWorkspacePackageHash(root, spec),
			);
		}

		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), "scripts", "ensure-deps.js"), "--no-install"],
			{ cwd: root, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(existsSync(join(root, "node_modules", ".bun-lockb.sha256"))).toBe(
			false,
		);
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

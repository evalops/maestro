import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const internalPackageName = ["@evalops-jh", "maestro"].join("/");
const publicPackageName = ["@evalops", "maestro"].join("/");

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-public-mirror-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(source, { recursive: true });
	mkdirSync(target, { recursive: true });
	return { root, source, target };
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("prepare-public-release-mirror", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("copies public files, preserves excluded public-only files, and rewrites package metadata", () => {
		const { source, target } = makeFixture();
		write(
			join(source, "package.json"),
			JSON.stringify(
				{
					name: internalPackageName,
					version: "1.2.3",
					maestro: {
						canonicalPackageName: publicPackageName,
						packageAliases: [internalPackageName],
					},
				},
				null,
				2,
			),
		);
		write(join(source, "README.md"), "public readme\n");
		write(join(source, "src/index.ts"), "export const value = 1;\n");
		write(join(source, ".github/workflows/ci.yml"), "internal ci\n");
		write(join(source, ".husky/_/husky.sh"), "generated husky helper\n");
		write(
			join(source, "packages/contracts/dist/index.js"),
			"generated package output\n",
		);
		write(
			join(source, "packages/core/node_modules/pkg/index.js"),
			"nested dependency\n",
		);
		write(
			join(source, "scripts/smoke-registry-install.js"),
			"internal smoke\n",
		);
		write(join(source, ".env"), "SECRET=value\n");
		write(join(source, "docs/internal/notes.md"), "internal\n");
		write(join(source, ".github/public-release-mirror.exclude"), "");

		write(join(target, "old.txt"), "stale\n");
		write(join(target, ".github/workflows/ci.yml"), "public ci\n");
		write(
			join(target, ".github/workflows/public-release-mirror.yml"),
			"public workflow\n",
		);
		write(join(target, "scripts/smoke-registry-install.js"), "public smoke\n");
		write(join(target, ".git/config"), '[remote "origin"]\n');

		execFileSync(
			process.execPath,
			[
				"scripts/prepare-public-release-mirror.mjs",
				"--source",
				source,
				"--target",
				target,
			],
			{ cwd: process.cwd(), stdio: "pipe" },
		);

		expect(readFileSync(join(target, "README.md"), "utf8")).toBe(
			"public readme\n",
		);
		expect(readFileSync(join(target, "src/index.ts"), "utf8")).toBe(
			"export const value = 1;\n",
		);
		expect(existsSync(join(target, "old.txt"))).toBe(false);
		expect(existsSync(join(target, ".env"))).toBe(false);
		expect(existsSync(join(target, "docs/internal/notes.md"))).toBe(false);
		expect(existsSync(join(target, ".husky/_/husky.sh"))).toBe(false);
		expect(existsSync(join(target, "packages/contracts/dist/index.js"))).toBe(
			false,
		);
		expect(
			existsSync(join(target, "packages/core/node_modules/pkg/index.js")),
		).toBe(false);
		expect(
			readFileSync(
				join(target, ".github/workflows/public-release-mirror.yml"),
				"utf8",
			),
		).toBe("public workflow\n");
		expect(readFileSync(join(target, ".github/workflows/ci.yml"), "utf8")).toBe(
			"public ci\n",
		);
		expect(
			readFileSync(join(target, "scripts/smoke-registry-install.js"), "utf8"),
		).toBe("public smoke\n");
		expect(readFileSync(join(target, ".git/config"), "utf8")).toBe(
			'[remote "origin"]\n',
		);

		const pkg = readJson(join(target, "package.json"));
		expect(pkg.name).toBe(publicPackageName);
		expect(pkg.maestro).toMatchObject({
			canonicalPackageName: publicPackageName,
			packageAliases: [publicPackageName, internalPackageName],
		});
	});

	it("skips the nested target directory when the public clone lives under the source root", () => {
		const { root, source } = makeFixture();
		const target = join(source, "public-mirror");
		mkdirSync(target, { recursive: true });

		write(
			join(source, "package.json"),
			JSON.stringify(
				{
					name: internalPackageName,
					version: "1.2.3",
					maestro: {
						canonicalPackageName: publicPackageName,
					},
				},
				null,
				2,
			),
		);
		write(join(source, "README.md"), "public readme\n");
		write(
			join(target, "package.json"),
			JSON.stringify({ name: publicPackageName }),
		);

		execFileSync(
			process.execPath,
			[
				"scripts/prepare-public-release-mirror.mjs",
				"--source",
				source,
				"--target",
				target,
				"--exclude-file",
				join(root, "missing.exclude"),
			],
			{ cwd: process.cwd(), stdio: "pipe" },
		);

		expect(readFileSync(join(target, "README.md"), "utf8")).toBe(
			"public readme\n",
		);
		expect(existsSync(join(target, "public-mirror"))).toBe(false);
	});

	it("excludes docs/release-ops.md from the default fallback excludes", () => {
		const { source, target, root } = makeFixture();
		write(
			join(source, "package.json"),
			JSON.stringify(
				{
					name: internalPackageName,
					version: "1.2.3",
					maestro: {
						canonicalPackageName: publicPackageName,
					},
				},
				null,
				2,
			),
		);
		write(join(source, "README.md"), "public readme\n");
		write(join(source, "docs/release-ops.md"), "internal release ops\n");

		execFileSync(
			process.execPath,
			[
				"scripts/prepare-public-release-mirror.mjs",
				"--source",
				source,
				"--target",
				target,
				"--exclude-file",
				join(root, "missing.exclude"),
			],
			{ cwd: process.cwd(), stdio: "pipe" },
		);

		expect(existsSync(join(target, "docs/release-ops.md"))).toBe(false);
	});

	it("reports planned changes in check mode without mutating the target", () => {
		const { source, target } = makeFixture();
		const reportPath = join(source, "public-tree-report.json");
		write(
			join(source, "package.json"),
			JSON.stringify(
				{
					name: internalPackageName,
					version: "1.2.3",
					maestro: {
						canonicalPackageName: publicPackageName,
						packageAliases: [internalPackageName],
					},
				},
				null,
				2,
			),
		);
		write(join(source, "README.md"), "internal readme\n");
		write(join(source, "src/index.ts"), "export const value = 2;\n");
		write(join(target, "README.md"), "stale readme\n");
		write(join(target, "stale.txt"), "remove me\n");
		write(
			join(target, "package.json"),
			JSON.stringify(
				{
					name: publicPackageName,
					maestro: {
						canonicalPackageName: publicPackageName,
						packageAliases: [publicPackageName],
					},
				},
				null,
				2,
			),
		);

		expect(() =>
			execFileSync(
				process.execPath,
				[
					"scripts/prepare-public-release-mirror.mjs",
					"--check",
					"--report",
					reportPath,
					"--source",
					source,
					"--target",
					target,
				],
				{ cwd: process.cwd(), stdio: "pipe" },
			),
		).toThrowError(/Public release mirror drift detected/u);

		expect(readFileSync(join(target, "README.md"), "utf8")).toBe(
			"stale readme\n",
		);
		expect(existsSync(join(target, "stale.txt"))).toBe(true);

		const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
			string,
			unknown
		>;
		expect(report).toMatchObject({
			copiedCount: 3,
			deletedCount: 1,
			publicPackageName,
			copiedPaths: ["README.md", "package.json", "src/index.ts"],
			deletedPaths: ["stale.txt"],
		});
	});
});

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkReleaseSurfaceConformance,
	loadReleaseSurfaceConformanceManifest,
} from "../../scripts/check-release-surface-conformance.mjs";

describe("release-surface conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in release surface manifest", () => {
		expect(
			checkReleaseSurfaceConformance({
				manifest: loadReleaseSurfaceConformanceManifest(),
			}),
		).toEqual([]);
	});

	it("requires every release surface area", () => {
		tempDir = join(tmpdir(), `release-surface-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "surface.txt",
						evidenceType: "doc",
						anchors: ["present", "missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'public-install-docs: surface.txt is missing anchor "missing"',
		);
		expect(failures).toContain(
			"manifest is missing required area package-metadata",
		);
		expect(failures).toContain(
			"manifest is missing required area registry-install-smoke",
		);
		expect(failures).toContain(
			"manifest is missing required area public-mirror-workflow",
		);
	});

	it("rejects entries without evidence types or anchors", () => {
		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir || ".",
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "missing.txt",
						anchors: [],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: missing.txt is missing evidenceType",
		);
		expect(failures).toContain(
			"public-install-docs: missing.txt must list at least one anchor",
		);
	});

	it("rejects manifest paths that escape the repository root", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-escape-${process.pid}-${Date.now()}`,
		);
		const repoDir = join(tempDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		writeFileSync(join(tempDir, "outside.txt"), "present\n", "utf8");

		const failures = checkReleaseSurfaceConformance({
			rootDir: repoDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "../outside.txt",
						evidenceType: "doc",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: ../outside.txt escapes repository root",
		);
	});

	it("rejects manifest symlinks that resolve outside the repository root", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-symlink-${process.pid}-${Date.now()}`,
		);
		const repoDir = join(tempDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		const outsidePath = join(tempDir, "outside.txt");
		writeFileSync(outsidePath, "present\n", "utf8");
		symlinkSync(outsidePath, join(repoDir, "surface-link.txt"));

		const failures = checkReleaseSurfaceConformance({
			rootDir: repoDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "surface-link.txt",
						evidenceType: "doc",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: surface-link.txt escapes repository root",
		);
	});

	it("requires release-gate script evidence to validate package scripts", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-shape-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "surface.txt"),
			'"release:check": "node scripts/release-readiness.js release"\n"check:release-surface": "node scripts/check-release-surface-conformance.mjs"\n',
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "surface.txt",
						evidenceType: "source",
						anchors: [
							'"release:check": "node scripts/release-readiness.js release"',
							'"check:release-surface": "node scripts/check-release-surface-conformance.mjs"',
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: surface.txt must use package.json as release-gate script evidence",
		);
		expect(failures).toContain(
			"release-gate-scripts: surface.txt must use package-script evidence for release-gate validation",
		);
	});

	it("requires lint:evals to invoke the release surface conformance gate", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"release:check": "node scripts/release-readiness.js release",
					"check:release-surface":
						"node scripts/check-release-surface-conformance.mjs",
					"lint:evals":
						"node scripts/verify-evals.js && echo check:release-surface",
				},
			}),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "package.json",
						evidenceType: "package-script",
						anchors: [
							"release:check",
							"scripts/release-readiness.js",
							"check:release-surface",
							"scripts/check-release-surface-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: package.json scripts.lint:evals must run check:release-surface",
		);
	});

	it("rejects release-surface gates that can swallow failures", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-swallow-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"release:check": "node scripts/release-readiness.js release",
					"check:release-surface":
						"node scripts/check-release-surface-conformance.mjs || true",
					"lint:evals": "npm run check:release-surface",
				},
			}),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "package.json",
						evidenceType: "package-script",
						anchors: [
							"release:check",
							"scripts/release-readiness.js",
							"check:release-surface",
							"scripts/check-release-surface-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: package.json scripts.check:release-surface must run scripts/check-release-surface-conformance.mjs",
		);
	});
});

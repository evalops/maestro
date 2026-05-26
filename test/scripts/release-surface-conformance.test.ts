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
});

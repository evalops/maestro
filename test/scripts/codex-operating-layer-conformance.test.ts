import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkCodexOperatingLayerConformance,
	loadCodexOperatingLayerManifest,
} from "../../scripts/check-codex-operating-layer-conformance.mjs";

describe("Codex operating-layer conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in operating-layer manifest", () => {
		expect(
			checkCodexOperatingLayerConformance({
				manifest: loadCodexOperatingLayerManifest(),
			}),
		).toEqual([]);
	});

	it("requires every far-horizon operating-layer area", () => {
		tempDir = join(
			tmpdir(),
			`codex-operating-layer-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkCodexOperatingLayerConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "default-install",
						path: "surface.txt",
						anchors: ["present", "missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'default-install: surface.txt is missing anchor "missing"',
		);
		expect(failures).toContain(
			"manifest is missing required area chatgpt-sign-in",
		);
		expect(failures).toContain(
			"manifest is missing required area rust-control-plane",
		);
		expect(failures).toContain(
			"manifest is missing required area live-verification",
		);
	});

	it("rejects manifest entries without an evidence type", () => {
		const failures = checkCodexOperatingLayerConformance({
			rootDir: tempDir || ".",
			manifest: {
				version: 1,
				checks: [
					{
						area: "default-install",
						path: "missing.txt",
						anchors: ["anything"],
					},
				],
			},
		});

		expect(failures).toContain(
			"default-install: missing.txt is missing evidenceType",
		);
	});
});

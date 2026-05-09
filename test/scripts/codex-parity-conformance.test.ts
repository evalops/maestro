import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkCodexParityConformance,
	isDirectCliEntrypoint,
	loadCodexParityManifest,
} from "../../scripts/check-codex-parity-conformance.mjs";

describe("Codex parity conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in parity manifest", () => {
		expect(
			checkCodexParityConformance({
				manifest: loadCodexParityManifest(),
			}),
		).toEqual([]);
	});

	it("reports missing anchors with area and path context", () => {
		tempDir = join(tmpdir(), `codex-parity-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n");

		const failures = checkCodexParityConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "native-apply-patch",
						path: "surface.txt",
						anchors: ["present", "missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'native-apply-patch: surface.txt is missing anchor "missing"',
		);
		expect(failures).toContain(
			"manifest is missing required area codex-auth-provider",
		);
	});

	it("detects direct CLI execution for paths that need URL encoding", () => {
		const scriptPath = join(tmpdir(), "maestro path with spaces", "check.mjs");
		expect(
			isDirectCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath),
		).toBe(true);
		expect(isDirectCliEntrypoint(`file://${scriptPath}`, scriptPath)).toBe(
			false,
		);
	});
});

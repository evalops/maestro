import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroScriptedScenario } from "@evalops/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateScriptedScenario } from "../../src/server/scripted-scenario-runner.js";

let tempDir: string | undefined;

function createTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "maestro-scripted-scenario-runner-"));
	return tempDir;
}

describe("scripted scenario runner", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("allows file_contents equals to assert an empty file", () => {
		const baseDir = createTempDir();
		writeFileSync(join(baseDir, "empty.txt"), "");

		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "empty-file",
			description: "Accept empty equality assertions for empty files.",
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: [],
			},
			frames: [],
			assertions: [
				{
					id: "empty-file-equals",
					kind: "file_contents",
					path: "empty.txt",
					equals: "",
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });

		expect(result.scenario.observedOutcome).toBe("pass");
		expect(result.assertions).toContainEqual(
			expect.objectContaining({
				id: "empty-file-equals",
				status: "pass",
			}),
		);
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaestroScriptedScenario } from "@evalops/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	evaluateScriptedScenario,
	scriptedScenarioResultToJunit,
} from "../../src/server/scripted-scenario-runner.js";

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

	it("reports scripted workspace manifest and release gate evidence", () => {
		const baseDir = createTempDir();
		mkdirSync(join(baseDir, "workspace"), { recursive: true });
		writeFileSync(
			join(baseDir, "workspace", "package.json"),
			'{"name":"fixture"}\n',
		);
		writeFileSync(
			join(baseDir, "workspace-manifest.json"),
			JSON.stringify({
				schemaVersion: "evalops.maestro.scenario-workspace-manifest.v1",
				id: "workspace-scripted-runner-test",
				recordedAt: "2026-05-30T00:00:00.000Z",
				source: "fixture",
				hydration: {
					mode: "fixture_workspace",
					rootPath: "workspace",
				},
				files: [{ path: "package.json" }],
				toolAdapters: [{ tool: "read", mode: "mocked" }],
				redaction: {
					secretsRemoved: true,
					rawPromptsIncluded: false,
				},
			}),
		);

		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "workspace-scripted-gate",
			description: "Scripted replay with frozen workspace evidence.",
			workspaceManifestPath: "workspace-manifest.json",
			releaseGate: {
				releaseBlocking: true,
				tier: "smoke",
				requiredArtifacts: ["replay", "workspace_manifest"],
				maxToolCalls: 1,
				maxScoreFailures: 0,
				maxScoreWarnings: 0,
			},
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: ["read"],
			},
			frames: [
				{
					index: 0,
					statements: [{ kind: "tool_call", tool: "read", id: "call-read" }],
				},
			],
			assertions: [
				{
					id: "workspace-ready",
					kind: "workspace_manifest",
					requiredWorkspaceFiles: ["package.json"],
					requiredToolAdapters: ["read"],
					requiredHydrationModes: ["fixture_workspace"],
					requiredReleaseGateTier: "smoke",
					minWorkspaceFiles: 1,
					minToolAdapters: 1,
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });

		expect(result.scenario.observedOutcome).toBe("pass");
		expect(result.workspace).toMatchObject({
			manifestId: "workspace-scripted-runner-test",
			hydrationMode: "fixture_workspace",
			files: 1,
			toolAdapters: 1,
		});
		expect(result.releaseGate).toMatchObject({
			releaseBlocking: true,
			tier: "smoke",
			satisfied: true,
			missingArtifacts: [],
			budgetViolations: [],
			policyViolations: [],
		});
		expect(result.assertions[0]).toMatchObject({
			id: "workspace-ready",
			status: "pass",
			evidence: expect.arrayContaining([
				expect.objectContaining({
					kind: "workspace_manifest",
					id: "workspace-scripted-runner-test",
				}),
				expect.objectContaining({
					kind: "tool_adapter",
					id: "read",
				}),
			]),
		});
	});

	it("fails release-blocking gate violations even when assertions pass", () => {
		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "release-gate-budget-failure",
			description: "Scripted replay release gates must affect CI outcome.",
			releaseGate: {
				releaseBlocking: true,
				tier: "smoke",
				requiredArtifacts: ["replay"],
				maxToolCalls: 0,
			},
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: ["read"],
			},
			frames: [
				{
					index: 0,
					statements: [{ kind: "tool_call", tool: "read", id: "call-read" }],
				},
			],
			assertions: [],
		};

		const result = evaluateScriptedScenario(scenario, {
			baseDir: createTempDir(),
		});

		expect(result.scenario.observedOutcome).toBe("fail");
		expect(result.releaseGate).toMatchObject({
			releaseBlocking: true,
			satisfied: false,
			missingArtifacts: [],
			budgetViolations: ["toolCalls 1/0"],
			policyViolations: [],
		});
	});

	it("fails scripted workspace manifest assertions when hydration files are missing", () => {
		const baseDir = createTempDir();
		writeFileSync(
			join(baseDir, "workspace-manifest.json"),
			JSON.stringify({
				schemaVersion: "evalops.maestro.scenario-workspace-manifest.v1",
				id: "workspace-scripted-runner-missing-file",
				recordedAt: "2026-05-30T00:00:00.000Z",
				source: "fixture",
				hydration: {
					mode: "fixture_workspace",
					rootPath: "workspace",
				},
				files: [{ path: "package.json" }],
				toolAdapters: [{ tool: "read", mode: "mocked" }],
				redaction: {
					secretsRemoved: true,
					rawPromptsIncluded: false,
				},
			}),
		);

		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "workspace-scripted-gate-missing-file",
			description: "Scripted replay catches missing hydrated fixture files.",
			workspaceManifestPath: "workspace-manifest.json",
			releaseGate: {
				releaseBlocking: true,
				tier: "smoke",
				requiredArtifacts: ["replay", "workspace_manifest"],
				maxScoreFailures: 0,
			},
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: ["read"],
			},
			frames: [],
			assertions: [
				{
					id: "workspace-ready",
					kind: "workspace_manifest",
					requiredWorkspaceFiles: ["package.json"],
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });

		expect(result.scenario.observedOutcome).toBe("fail");
		expect(result.releaseGate?.satisfied).toBe(false);
		expect(result.releaseGate?.budgetViolations).toEqual([]);
		expect(result.releaseGate?.policyViolations).toEqual([
			"workspace manifest assertion workspace-ready failed",
		]);
		expect(result.assertions[0]).toMatchObject({
			id: "workspace-ready",
			status: "fail",
			message: expect.stringContaining("missing workspace file(s)"),
		});
	});

	it("rejects required workspace files that escape the hydrated root", () => {
		const baseDir = createTempDir();
		mkdirSync(join(baseDir, "workspace"), { recursive: true });
		writeFileSync(join(baseDir, "outside.txt"), "outside root\n");
		writeFileSync(
			join(baseDir, "workspace-manifest.json"),
			JSON.stringify({
				schemaVersion: "evalops.maestro.scenario-workspace-manifest.v1",
				id: "workspace-scripted-runner-escape-file",
				recordedAt: "2026-05-30T00:00:00.000Z",
				source: "fixture",
				hydration: {
					mode: "fixture_workspace",
					rootPath: "workspace",
				},
				files: [{ path: "../outside.txt" }],
				toolAdapters: [{ tool: "read", mode: "mocked" }],
				redaction: {
					secretsRemoved: true,
					rawPromptsIncluded: false,
				},
			}),
		);

		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "workspace-scripted-gate-escape-file",
			description: "Scripted replay rejects workspace evidence outside root.",
			workspaceManifestPath: "workspace-manifest.json",
			releaseGate: {
				releaseBlocking: true,
				tier: "smoke",
				requiredArtifacts: ["replay", "workspace_manifest"],
				maxScoreFailures: 0,
			},
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: ["read"],
			},
			frames: [],
			assertions: [
				{
					id: "workspace-ready",
					kind: "workspace_manifest",
					requiredWorkspaceFiles: ["../outside.txt"],
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });

		expect(result.scenario.observedOutcome).toBe("fail");
		expect(result.releaseGate?.satisfied).toBe(false);
		expect(result.releaseGate?.policyViolations).toEqual([
			"workspace manifest assertion workspace-ready failed",
		]);
		expect(result.assertions[0]).toMatchObject({
			id: "workspace-ready",
			status: "fail",
			message: expect.stringContaining("missing workspace file(s)"),
		});
	});

	it("rejects absolute required workspace files", () => {
		const baseDir = createTempDir();
		mkdirSync(join(baseDir, "workspace"), { recursive: true });
		const outsidePath = join(baseDir, "absolute-outside.txt");
		writeFileSync(outsidePath, "outside root\n");
		writeFileSync(
			join(baseDir, "workspace-manifest.json"),
			JSON.stringify({
				schemaVersion: "evalops.maestro.scenario-workspace-manifest.v1",
				id: "workspace-scripted-runner-absolute-file",
				recordedAt: "2026-05-30T00:00:00.000Z",
				source: "fixture",
				hydration: {
					mode: "fixture_workspace",
					rootPath: "workspace",
				},
				files: [{ path: outsidePath }],
				toolAdapters: [{ tool: "read", mode: "mocked" }],
				redaction: {
					secretsRemoved: true,
					rawPromptsIncluded: false,
				},
			}),
		);

		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "workspace-scripted-gate-absolute-file",
			description: "Scripted replay rejects absolute workspace evidence paths.",
			workspaceManifestPath: "workspace-manifest.json",
			releaseGate: {
				releaseBlocking: true,
				tier: "smoke",
				requiredArtifacts: ["replay", "workspace_manifest"],
				maxScoreFailures: 0,
			},
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: ["read"],
			},
			frames: [],
			assertions: [
				{
					id: "workspace-ready",
					kind: "workspace_manifest",
					requiredWorkspaceFiles: [outsidePath],
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });

		expect(result.scenario.observedOutcome).toBe("fail");
		expect(result.releaseGate?.satisfied).toBe(false);
		expect(result.releaseGate?.policyViolations).toEqual([
			"workspace manifest assertion workspace-ready failed",
		]);
		expect(result.assertions[0]).toMatchObject({
			id: "workspace-ready",
			status: "fail",
			message: expect.stringContaining("missing workspace file(s)"),
		});
	});

	it("renders expected scripted failures as passing JUnit", () => {
		const baseDir = createTempDir();
		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "expected-scripted-failure",
			description: "Expected failures should not look red to JUnit readers.",
			expectedOutcome: "fail",
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: [],
			},
			frames: [],
			assertions: [
				{
					id: "missing-file-is-the-signal",
					kind: "file_exists",
					path: "does-not-exist.txt",
				},
			],
		};

		const result = evaluateScriptedScenario(scenario, { baseDir });
		const junit = scriptedScenarioResultToJunit(result);

		expect(result.scenario.observedOutcome).toBe("fail");
		expect(junit).toContain('failures="0"');
		expect(junit).toContain("Expected failing assertion observed");
		expect(junit).not.toContain("<failure");
	});

	it("renders scripted outcome mismatches as JUnit failures", () => {
		const scenario: MaestroScriptedScenario = {
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "unexpected-scripted-success",
			description: "Unexpected passes should still fail JUnit.",
			expectedOutcome: "fail",
			metadata: {
				recordedAt: "2026-05-10T00:00:00.000Z",
				toolsExpected: [],
			},
			frames: [],
			assertions: [],
		};

		const result = evaluateScriptedScenario(scenario, {
			baseDir: createTempDir(),
		});
		const junit = scriptedScenarioResultToJunit(result);

		expect(result.scenario.observedOutcome).toBe("pass");
		expect(junit).toContain('name="scenario-outcome"');
		expect(junit).toContain('failures="1"');
		expect(junit).toContain("Observed outcome pass; expected fail.");
	});
});

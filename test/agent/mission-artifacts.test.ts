import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyMissionArtifactPath,
	initializeMissionArtifacts,
	validateMissionArtifactContent,
	validateMissionArtifactWrite,
} from "../../src/agent/mission-artifacts.js";

describe("agent/mission-artifacts", () => {
	it("initializes a mission directory with contract-first artifacts", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({
			missionId: "launch",
			title: "Launch",
			rootDir,
			now: "2026-06-19T00:00:00.000Z",
		});

		expect(readFileSync(layout.missionMarkdown, "utf-8")).toContain("# Launch");
		expect(readFileSync(layout.validationContractMarkdown, "utf-8")).toContain(
			"Validation Contract",
		);
		expect(
			classifyMissionArtifactPath(layout.featuresJson, rootDir),
		).toMatchObject({ kind: "features" });
	});

	it("validates features.json shape before accepting mission artifact writes", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({ missionId: "bad", rootDir });

		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "bad",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toEqual({ ok: true });
		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "bad",
					features: [],
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "other",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "bad",
					features: [
						{
							id: "feature-1",
							description: "Reject typo status",
							status: "done",
							fulfills: [],
						},
					],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "bad",
					features: [
						{
							id: "feature-1",
							description: "Reject malformed handoff",
							status: "passed",
							fulfills: [],
							handoff: {
								workerId: "worker-1",
								success: true,
								handedOffAt: "2026-06-19T00:00:00.000Z",
								discoveredIssues: "not-an-array",
							},
						},
					],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "bad",
					features: [
						{
							id: "feature-1",
							description: "Original feature",
							status: "pending",
							fulfills: [],
						},
						{
							id: "feature-1",
							description: "Duplicate feature",
							status: "in-progress",
							fulfills: [],
						},
					],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
	});

	it("classifies nested mission directories before top-level artifact names", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({ missionId: "nested", rootDir });

		expect(
			classifyMissionArtifactPath(
				join(layout.libraryDir, "state.json"),
				rootDir,
			),
		).toMatchObject({ kind: "library" });
		expect(
			classifyMissionArtifactPath(
				join(layout.handoffsDir, "features.json"),
				rootDir,
			),
		).toMatchObject({ kind: "handoff" });
	});

	it("rejects features.json content whose missionId does not match the folder", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({ missionId: "alpha", rootDir });

		expect(
			validateMissionArtifactContent(
				layout.featuresJson,
				JSON.stringify({
					version: 1,
					missionId: "beta",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
	});

	it("does not classify unrelated repo paths that happen to contain missions", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		expect(
			classifyMissionArtifactPath(
				join(process.cwd(), "docs", "missions", "demo", "features.json"),
				rootDir,
			),
		).toBeNull();
	});

	it("does not classify mission paths whose symlink targets escape the store", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "maestro-mission-outside-"));
		const layout = initializeMissionArtifacts({ missionId: "linked", rootDir });
		const linkedMissionDir = join(rootDir, "linked-mission");
		const linkedNestedDir = join(layout.libraryDir, "linked-out");
		mkdirSync(layout.libraryDir, { recursive: true });
		symlinkSync(outsideDir, linkedMissionDir);
		symlinkSync(outsideDir, linkedNestedDir);

		expect(
			classifyMissionArtifactPath(
				join(linkedMissionDir, "features.json"),
				rootDir,
			),
		).toBeNull();
		expect(
			classifyMissionArtifactPath(join(linkedNestedDir, "state.json"), rootDir),
		).toBeNull();
	});

	it("derives mission identity from symlink targets inside the store", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({ missionId: "target", rootDir });
		const aliasDir = join(rootDir, "alias");
		symlinkSync(layout.missionDir, aliasDir);
		const aliasFeaturesPath = join(aliasDir, "features.json");

		expect(
			classifyMissionArtifactPath(aliasFeaturesPath, rootDir),
		).toMatchObject({
			kind: "features",
			missionDir: realpathSync(layout.missionDir),
		});
		expect(
			validateMissionArtifactContent(
				aliasFeaturesPath,
				JSON.stringify({
					version: 1,
					missionId: "alias",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				aliasFeaturesPath,
				JSON.stringify({
					version: 1,
					missionId: "target",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toEqual({ ok: true });
	});

	it("guards mission artifacts reached through symlink aliases outside the store", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const aliasRoot = mkdtempSync(join(tmpdir(), "maestro-mission-alias-"));
		const layout = initializeMissionArtifacts({ missionId: "target", rootDir });
		const aliasDir = join(aliasRoot, "target-link");
		symlinkSync(layout.missionDir, aliasDir, "dir");
		const aliasFeaturesPath = join(aliasDir, "features.json");

		expect(
			classifyMissionArtifactPath(aliasFeaturesPath, rootDir),
		).toMatchObject({
			kind: "features",
			missionDir: realpathSync(layout.missionDir),
		});
		expect(
			validateMissionArtifactWrite({
				filePath: aliasFeaturesPath,
				content: JSON.stringify({
					version: 1,
					missionId: "target",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				role: "worker",
				rootDir,
			}),
		).toMatchObject({ ok: false });
	});

	it("keeps artifact guards active for dotted mission ids", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({ missionId: "..foo", rootDir });

		expect(
			classifyMissionArtifactPath(layout.stateJson, rootDir),
		).toMatchObject({
			kind: "state",
		});
		expect(
			validateMissionArtifactWrite({
				filePath: layout.stateJson,
				content: "{}",
				role: "orchestrator",
				rootDir,
			}),
		).toMatchObject({ ok: false });
	});

	it("validates state.json against the mission store schema", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({
			missionId: "stateful",
			rootDir,
		});

		expect(
			validateMissionArtifactContent(layout.stateJson, "{}", rootDir),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.stateJson,
				JSON.stringify({
					schemaVersion: "evalops.maestro.mission-store.v1",
					missionId: "stateful",
					state: "ready",
					features: [],
					progressLog: [],
					workerSessionIds: [],
					workerStates: {},
					tokenUsageBySessionId: {},
					createdAt: "2026-06-19T00:00:00.000Z",
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toEqual({ ok: true });
		expect(
			validateMissionArtifactContent(
				layout.stateJson,
				JSON.stringify({
					schemaVersion: "evalops.maestro.mission-store.v1",
					missionId: "stateful",
					state: "ready",
					features: [],
					progressLog: [null],
					workerSessionIds: [],
					workerStates: {},
					tokenUsageBySessionId: {},
					createdAt: "2026-06-19T00:00:00.000Z",
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.stateJson,
				JSON.stringify({
					schemaVersion: "evalops.maestro.mission-store.v1",
					missionId: "stateful",
					state: "ready",
					features: [
						{
							id: "feature-1",
							description: "Original feature",
							status: "pending",
							fulfills: [],
						},
						{
							id: "feature-1",
							description: "Duplicate feature",
							status: "in-progress",
							fulfills: [],
						},
					],
					progressLog: [],
					workerSessionIds: [],
					workerStates: {},
					tokenUsageBySessionId: {},
					createdAt: "2026-06-19T00:00:00.000Z",
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactContent(
				layout.stateJson,
				JSON.stringify({
					schemaVersion: "evalops.maestro.mission-store.v1",
					missionId: "stateful",
					state: "ready",
					features: [],
					progressLog: [],
					workerSessionIds: [],
					workerStates: {},
					tokenUsageBySessionId: { session: null },
					createdAt: "2026-06-19T00:00:00.000Z",
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			),
		).toMatchObject({ ok: false });
	});

	it("blocks workers from owning orchestrator/system mission files", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const layout = initializeMissionArtifacts({
			missionId: "guarded",
			rootDir,
		});

		expect(
			validateMissionArtifactWrite({
				filePath: layout.featuresJson,
				content: JSON.stringify({
					version: 1,
					missionId: "guarded",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				role: "worker",
				rootDir,
			}),
		).toMatchObject({ ok: false });
		expect(
			validateMissionArtifactWrite({
				filePath: layout.stateJson,
				content: "{}",
				role: "orchestrator",
				rootDir,
			}),
		).toMatchObject({ ok: false });
	});

	it("rejects nested mission artifact paths that escape through symlinks", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "maestro-mission-outside-"));
		const layout = initializeMissionArtifacts({
			missionId: "guarded",
			rootDir,
		});
		rmSync(layout.handoffsDir, { recursive: true, force: true });
		symlinkSync(outsideDir, layout.handoffsDir, "dir");
		const escapedPath = join(layout.handoffsDir, "handoff.json");

		expect(classifyMissionArtifactPath(escapedPath, rootDir)).toBeNull();
		expect(
			validateMissionArtifactWrite({
				filePath: escapedPath,
				content: JSON.stringify({ ok: true }),
				rootDir,
			}),
		).toMatchObject({ ok: false });
	});

	it("rejects mission directories that are symlinked outside the store", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-artifacts-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "maestro-mission-outside-"));
		mkdirSync(join(rootDir, "linked"), { recursive: true });
		rmSync(join(rootDir, "linked"), { recursive: true, force: true });
		symlinkSync(outsideDir, join(rootDir, "linked"), "dir");
		const escapedPath = join(rootDir, "linked", "features.json");

		expect(classifyMissionArtifactPath(escapedPath, rootDir)).toBeNull();
		expect(
			validateMissionArtifactWrite({
				filePath: escapedPath,
				content: JSON.stringify({
					version: 1,
					missionId: "linked",
					features: [],
					updatedAt: "2026-06-19T00:00:00.000Z",
				}),
				rootDir,
			}),
		).toMatchObject({ ok: false });
	});
});

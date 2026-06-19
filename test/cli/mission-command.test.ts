import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionStore } from "../../src/agent/mission-store.js";
import { handleMissionCommand } from "../../src/cli/commands/mission.js";
import { withEnv } from "../utils/env.js";

describe("mission command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("does not reset an existing mission when init is rerun", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["deep", "Deep Mission"]);
			const store = MissionStore.load("deep");
			store.setFeatures([
				{
					id: "feature-1",
					description: "Keep me",
					status: "pending",
					fulfills: [],
				},
			]);
			store.appendProgress({
				type: "note",
				message: "keep me",
			});
			rmSync(join(rootDir, "deep", "features.json"));

			await handleMissionCommand("init", ["deep", "Replacement Title"]);

			const snapshot = MissionStore.load("deep").getSnapshot();
			expect(snapshot.title).toBe("Deep Mission");
			expect(snapshot.features).toEqual([
				expect.objectContaining({ id: "feature-1" }),
			]);
			expect(snapshot.progressLog.map((entry) => entry.message)).toContain(
				"keep me",
			);
			expect(
				JSON.parse(readFileSync(join(rootDir, "deep", "features.json"), "utf8"))
					.features,
			).toEqual([expect.objectContaining({ id: "feature-1" })]);
		});
	});

	it("allows rerunning init with a sanitized mission id", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["customer value", "Customer Value"]);

			await expect(
				handleMissionCommand("init", ["customer-value", "Replacement Title"]),
			).resolves.toBeUndefined();

			const snapshot = MissionStore.load("customer-value").getSnapshot();
			expect(snapshot.missionId).toBe("customer-value");
			expect(snapshot.sourceMissionId).toBe("customer value");
			expect(snapshot.title).toBe("Customer Value");
		});
	});

	it("rejects init reruns through a different raw id alias", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["foo+bar", "Foo Plus Bar"]);

			await expect(
				handleMissionCommand("init", ["foo bar", "Foo Space Bar"]),
			).rejects.toThrow('missionId "foo bar" collides with existing mission');
		});
	});

	it("repairs missing features.json from existing durable mission state", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			const store = MissionStore.create({
				missionId: "deep",
				title: "Deep Mission",
			});
			store.setFeatures([
				{
					id: "feature-1",
					description: "Preserved durable feature",
					status: "in-progress",
					fulfills: [],
				},
			]);
			const featuresPath = join(rootDir, "deep", "features.json");
			rmSync(featuresPath);

			await handleMissionCommand("init", ["deep", "Replacement Title"]);

			const manifest = JSON.parse(readFileSync(featuresPath, "utf8")) as {
				features: Array<{ id: string; description: string }>;
			};
			expect(manifest.features).toEqual([
				expect.objectContaining({
					id: "feature-1",
					description: "Preserved durable feature",
				}),
			]);
			expect(MissionStore.load("deep").getSnapshot().features).toEqual([
				expect.objectContaining({ id: "feature-1" }),
			]);
		});
	});

	it("repairs empty features.json overlays from existing durable mission state", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			const store = MissionStore.create({
				missionId: "deep",
				title: "Deep Mission",
			});
			store.setFeatures([
				{
					id: "feature-1",
					description: "Preserved durable feature",
					status: "in-progress",
					fulfills: [],
				},
			]);
			const featuresPath = join(rootDir, "deep", "features.json");
			const emptyOverlay = JSON.parse(readFileSync(featuresPath, "utf8")) as {
				updatedAt: string;
			};
			emptyOverlay.updatedAt = "2099-06-19T00:00:00.000Z";
			writeFileSync(
				featuresPath,
				JSON.stringify({ ...emptyOverlay, features: [] }),
			);

			await handleMissionCommand("init", ["deep", "Replacement Title"]);

			expect(MissionStore.load("deep").getSnapshot().features).toEqual([
				expect.objectContaining({ id: "feature-1" }),
			]);
		});
	});

	it("uses newer feature overlays when rerunning init with JSON output", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			const store = MissionStore.create({
				missionId: "deep",
				title: "Deep Mission",
			});
			store.setFeatures([
				{
					id: "stale",
					description: "Stale durable feature",
					status: "pending",
					fulfills: [],
				},
			]);
			const featuresPath = join(rootDir, "deep", "features.json");
			const manifest = JSON.parse(readFileSync(featuresPath, "utf8"));
			writeFileSync(
				featuresPath,
				JSON.stringify({
					...manifest,
					features: [
						{
							id: "fresh",
							description: "Fresh overlay feature",
							status: "in-progress",
							fulfills: [],
						},
					],
					updatedAt: "2099-06-19T00:00:00.000Z",
				}),
			);

			await handleMissionCommand("init", ["deep", "Replacement Title"], {
				json: true,
			});

			const output = JSON.parse(logs.at(-1) ?? "{}") as {
				snapshot: { features: Array<{ id: string }> };
			};
			expect(output.snapshot.features.map((feature) => feature.id)).toEqual([
				"fresh",
			]);
		});
	});

	it("fails validation when durable mission state is missing", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["deep", "Deep Mission"]);
			rmSync(join(rootDir, "deep", "state.json"));

			await handleMissionCommand("validate", ["deep"]);

			expect(process.exitCode).toBe(1);
			expect(logs.join("\n")).toContain("state.json");
			expect(logs.join("\n")).toContain("Missing required mission artifact");
		});
	});

	it("sets a failing exit code for JSON validation failures", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["deep", "Deep Mission"]);
			rmSync(join(rootDir, "deep", "state.json"));

			await handleMissionCommand("validate", ["deep"], { json: true });

			expect(process.exitCode).toBe(1);
		});
	});

	it("refuses to recreate store state when artifacts remain but state.json is gone", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-cli-"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await withEnv({ MAESTRO_MISSION_STORE_DIR: rootDir }, async () => {
			await handleMissionCommand("init", ["deep", "Deep Mission"]);
			rmSync(join(rootDir, "deep", "state.json"));

			await expect(
				handleMissionCommand("init", ["deep", "Deep Mission"]),
			).rejects.toThrow("mission state missing for existing mission: deep");
		});
	});
});

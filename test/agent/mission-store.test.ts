import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	MissionStore,
	createMissionStoreSnapshot,
	listMissionStoreSnapshots,
	sanitizeMissionId,
	sumMissionTokenUsage,
} from "../../src/agent/mission-store.js";
import * as fsUtils from "../../src/utils/fs.js";

describe("agent/mission-store", () => {
	it("persists mission progress, workers, and token rollups", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const nowValues = [
			"2026-06-19T00:00:00.000Z",
			"2026-06-19T00:01:00.000Z",
			"2026-06-19T00:02:00.000Z",
		];
		const store = MissionStore.create({
			missionId: "customer value",
			title: "Customer value",
			config: {
				rootDir,
				now: () => nowValues.shift() ?? "2026-06-19T00:03:00.000Z",
			},
		});

		store.appendProgress({
			type: "worker_started",
			workerSessionId: "worker-1",
			featureId: "feature-1",
		});
		store.appendProgress({
			type: "worker_completed",
			workerSessionId: "worker-1",
			featureId: "feature-1",
			exitCode: 0,
		});
		store.setSessionTokenUsage("worker-1", {
			inputTokens: 10,
			outputTokens: 5,
			thinkingTokens: 2,
		});

		const loaded = MissionStore.load("customer value", {
			rootDir,
		}).getSnapshot();
		expect(loaded.missionId).toBe("customer-value");
		expect(loaded.workerSessionIds).toEqual(["worker-1"]);
		expect(loaded.workerStates["worker-1"]).toMatchObject({
			completedAt: "2026-06-19T00:02:00.000Z",
			exitCode: 0,
		});
		expect(loaded.tokenUsage).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			thinkingTokens: 2,
		});
		expect(listMissionStoreSnapshots(rootDir).map((m) => m.missionId)).toEqual([
			"customer-value",
		]);
	});

	it("records blocked state transitions even without a message", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:00:00.000Z",
			},
		});

		store.save();
		store.setState("blocked");

		const snapshot = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(snapshot.state).toBe("blocked");
		expect(snapshot.progressLog).toContainEqual(
			expect.objectContaining({
				type: "mission_blocked",
				timestamp: "2026-06-19T00:00:00.000Z",
			}),
		);
	});

	it("preserves progress and token usage from stale concurrent writers", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});

		store.save();
		const left = MissionStore.load("deep", { rootDir });
		const right = MissionStore.load("deep", { rootDir });

		left.appendProgress({
			type: "worker_started",
			workerSessionId: "worker-1",
		});
		right.appendProgress({
			type: "worker_started",
			workerSessionId: "worker-2",
		});
		left.setSessionTokenUsage("worker-1", {
			inputTokens: 1,
			outputTokens: 2,
		});
		right.setSessionTokenUsage("worker-2", {
			inputTokens: 3,
			outputTokens: 4,
		});

		const snapshot = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(snapshot.progressLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ workerSessionId: "worker-1" }),
				expect.objectContaining({ workerSessionId: "worker-2" }),
			]),
		);
		expect(snapshot.tokenUsageBySessionId).toMatchObject({
			"worker-1": { inputTokens: 1, outputTokens: 2 },
			"worker-2": { inputTokens: 3, outputTokens: 4 },
		});
	});

	it("sums token usage across sessions", () => {
		expect(
			sumMissionTokenUsage({
				a: { inputTokens: 1, outputTokens: 2, credits: 0.5 },
				b: { inputTokens: 3, outputTokens: 4, credits: 1 },
			}),
		).toMatchObject({ inputTokens: 4, outputTokens: 6, credits: 1.5 });
	});

	it("records blocked state transitions even without a custom message", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:01:00.000Z",
			},
		});

		const snapshot = store.setState("blocked");

		expect(snapshot.progressLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "mission_blocked",
					message: "Mission is blocked",
					timestamp: "2026-06-19T00:01:00.000Z",
				}),
			]),
		);
	});

	it("merges stale writer progress and token updates", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		first.appendProgress({
			type: "worker_started",
			workerSessionId: "worker-1",
			timestamp: "2026-06-19T00:01:00.000Z",
		});
		second.appendProgress({
			type: "worker_started",
			workerSessionId: "worker-2",
			timestamp: "2026-06-19T00:02:00.000Z",
		});
		first.setSessionTokenUsage("worker-1", {
			inputTokens: 10,
			outputTokens: 5,
		});
		second.setSessionTokenUsage("worker-2", {
			inputTokens: 20,
			outputTokens: 7,
		});

		const loaded = MissionStore.load("deep", { rootDir }).getSnapshot();

		expect(loaded.workerSessionIds).toEqual(["worker-1", "worker-2"]);
		expect(
			loaded.progressLog.flatMap((entry) =>
				entry.workerSessionId ? [entry.workerSessionId] : [],
			),
		).toEqual(["worker-1", "worker-2"]);
		expect(loaded.tokenUsageBySessionId).toMatchObject({
			"worker-1": { inputTokens: 10, outputTokens: 5 },
			"worker-2": { inputTokens: 20, outputTokens: 7 },
		});
		expect(loaded.tokenUsage).toMatchObject({
			inputTokens: 30,
			outputTokens: 12,
		});
	});

	it("preserves newer concurrent mission state without rejected progress", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		second.setState("running");
		first.setState("awaiting-input", "Still waiting for launch approval");

		const loaded = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(loaded.state).toBe("running");
		expect(loaded.progressLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "mission_started",
				}),
			]),
		);
		expect(loaded.progressLog).toEqual(
			expect.not.arrayContaining([
				expect.objectContaining({
					message: "Still waiting for launch approval",
				}),
			]),
		);
	});

	it("does not let stale writers downgrade terminal mission state", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		second.setState("completed");
		first.setState("running");

		const snapshot = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(snapshot.state).toBe("completed");
		expect(snapshot.progressLog.map((entry) => entry.type)).toEqual(
			expect.not.arrayContaining(["mission_started"]),
		);
	});

	it("rejects reopening a terminal mission from the same store instance", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});

		store.setState("completed");
		expect(() => store.setState("running")).toThrowError(
			"mission deep is already completed",
		);

		const snapshot = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(snapshot.state).toBe("completed");
		expect(snapshot.progressLog.map((entry) => entry.type)).not.toContain(
			"mission_started",
		);
	});

	it("does not duplicate terminal progress when the same state is set twice", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});

		store.setState("completed");
		const snapshot = store.setState("completed");

		expect(snapshot.state).toBe("completed");
		expect(
			snapshot.progressLog.filter(
				(entry) => entry.type === "mission_completed",
			),
		).toHaveLength(1);
	});
	it("merges stale writer feature updates by feature id", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		first.setFeatures([
			{
				id: "feature-1",
				description: "First feature",
				status: "pending",
				fulfills: [],
			},
		]);
		second.setFeatures([
			{
				id: "feature-2",
				description: "Second feature",
				status: "pending",
				fulfills: [],
			},
		]);

		expect(
			MissionStore.load("deep", { rootDir })
				.getSnapshot()
				.features.map((feature) => feature.id),
		).toEqual(["feature-1", "feature-2"]);
	});

	it("removes unchanged features omitted by setFeatures", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});
		store.setFeatures([
			{
				id: "feature-1",
				description: "Feature to remove",
				status: "pending",
				fulfills: [],
			},
		]);
		const loaded = MissionStore.load("deep", { rootDir });

		loaded.setFeatures([]);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([]);
	});

	it("rejects stale feature saves when another writer changed the same feature", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		first.setFeatures([
			{
				id: "feature-1",
				description: "First writer feature",
				status: "pending",
				fulfills: [],
			},
		]);

		expect(() =>
			second.setFeatures([
				{
					id: "feature-1",
					description: "Second writer feature",
					status: "pending",
					fulfills: [],
				},
			]),
		).toThrow(
			"mission feature feature-1 changed concurrently; reload before saving",
		);
		expect(second.getSnapshot().features).toEqual([]);
		expect(() =>
			second.appendProgress({
				type: "note",
				message: "Recovered after conflict",
			}),
		).not.toThrow();
		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "feature-1" })]);
		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().progressLog,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "note",
					message: "Recovered after conflict",
				}),
			]),
		);
	});

	it("restores in-memory state after failed saves", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const first = MissionStore.load("deep", { rootDir });
		const second = MissionStore.load("deep", { rootDir });

		first.setFeatures([
			{
				id: "feature-1",
				description: "First writer feature",
				status: "pending",
				fulfills: [],
			},
		]);
		expect(() =>
			second.setFeatures([
				{
					id: "feature-1",
					description: "Rejected second writer feature",
					status: "pending",
					fulfills: [],
				},
			]),
		).toThrow("changed concurrently");

		second.appendProgress({
			type: "note",
			message: "Recovered after rejected save",
		});

		const snapshot = MissionStore.load("deep", { rootDir }).getSnapshot();
		expect(snapshot.features).toEqual([
			expect.objectContaining({ description: "First writer feature" }),
		]);
		expect(snapshot.progressLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "note",
					message: "Recovered after rejected save",
				}),
			]),
		);
	});

	it("rolls back durable state when manifest writing fails", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const statePath = join(rootDir, "deep", "state.json");
		const featuresPath = join(rootDir, "deep", "features.json");
		const baseline = JSON.parse(readFileSync(statePath, "utf8")) as {
			updatedAt: string;
			progressLog: Array<{ message?: string }>;
		};
		rmSync(featuresPath, { force: true });
		mkdirSync(featuresPath);

		expect(() =>
			MissionStore.load("deep", { rootDir }).appendProgress({
				type: "note",
				message: "Should not survive failed manifest write",
			}),
		).toThrow("Failed to write JSON file");

		const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
			updatedAt: string;
			progressLog: Array<{ message?: string }>;
		};
		expect(saved.updatedAt).toBe(baseline.updatedAt);
		expect(saved.progressLog).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: "Should not survive failed manifest write",
				}),
			]),
		);
	});

	it("recovers abandoned mission state locks", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const lockPath = join(rootDir, "deep", "state.json.lock");
		mkdirSync(lockPath, { recursive: true });
		const old = new Date(Date.now() - 120_000);
		utimesSync(lockPath, old, old);

		MissionStore.load("deep", { rootDir }).appendProgress({
			type: "note",
			message: "Recovered stale lock",
		});

		expect(existsSync(join(lockPath, "owner.json"))).toBe(false);
		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().progressLog,
		).toEqual([
			expect.objectContaining({ type: "mission_created" }),
			expect.objectContaining({
				type: "note",
				message: "Recovered stale lock",
			}),
		]);
	});

	it("does not recover stale-looking locks owned by a live process", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const lockPath = join(rootDir, "deep", "state.json.lock");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				createdAt: "2026-06-19T00:00:00.000Z",
			}),
		);
		const old = new Date(Date.now() - 120_000);
		utimesSync(lockPath, old, old);

		expect(() =>
			MissionStore.load("deep", { rootDir }).appendProgress({
				type: "note",
				message: "Must wait for live owner",
			}),
		).toThrow("timed out waiting for mission state lock");
		expect(existsSync(join(lockPath, "owner.json"))).toBe(true);
	});

	it("does not overwrite a newer features.json manifest during save", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		const stale = MissionStore.load("deep", { rootDir });
		const featuresPath = join(rootDir, "deep", "features.json");
		writeFileSync(
			featuresPath,
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [
					{
						id: "fresh",
						description: "Newer manifest feature",
						status: "pending",
						fulfills: [],
					},
				],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		stale.appendProgress({ type: "note", message: "Do not clobber manifest" });

		const manifest = JSON.parse(readFileSync(featuresPath, "utf8")) as {
			features: Array<{ id: string }>;
			updatedAt: string;
		};
		expect(manifest.updatedAt).toBe("2099-06-19T00:00:00.000Z");
		expect(manifest.features.map((feature) => feature.id)).toEqual(["fresh"]);
	});

	it("does not let a newer empty features.json clear durable features", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});
		store.setFeatures([
			{
				id: "feature-1",
				description: "Durable feature",
				status: "pending",
				fulfills: [],
			},
		]);
		const featuresPath = join(rootDir, "deep", "features.json");
		writeFileSync(
			featuresPath,
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		MissionStore.load("deep", { rootDir }).appendProgress({
			type: "note",
			message: "Preserve durable features",
		});

		expect(
			MissionStore.load("deep", { rootDir })
				.getSnapshot()
				.features.map((feature) => feature.id),
		).toEqual(["feature-1"]);
		expect(
			(
				JSON.parse(readFileSync(featuresPath, "utf8")) as {
					features: Array<{ id: string }>;
				}
			).features.map((feature) => feature.id),
		).toEqual(["feature-1"]);
	});

	it("removes features omitted from a replacement set", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		});
		store.setFeatures([
			{
				id: "feature-1",
				description: "First feature",
				status: "pending",
				fulfills: [],
			},
			{
				id: "feature-2",
				description: "Second feature",
				status: "pending",
				fulfills: [],
			},
		]);

		store.setFeatures([
			{
				id: "feature-2",
				description: "Second feature",
				status: "pending",
				fulfills: [],
			},
		]);

		expect(
			MissionStore.load("deep", { rootDir })
				.getSnapshot()
				.features.map((feature) => feature.id),
		).toEqual(["feature-2"]);
		expect(
			JSON.parse(
				readFileSync(join(rootDir, "deep", "features.json"), "utf-8"),
			).features.map((feature: { id: string }) => feature.id),
		).toEqual(["feature-2"]);
	});

	it("creates normalized snapshots", () => {
		expect(
			createMissionStoreSnapshot({ missionId: "Deep Work" }).missionId,
		).toBe("Deep-Work");
	});

	it("rejects mission ids without alphanumeric characters", () => {
		expect(() => createMissionStoreSnapshot({ missionId: "." })).toThrow(
			"missionId must include at least one alphanumeric character",
		);
		expect(() => createMissionStoreSnapshot({ missionId: ".." })).toThrow(
			"missionId must include at least one alphanumeric character",
		);
		expect(() => sanitizeMissionId("___")).toThrow(
			"missionId must include at least one alphanumeric character",
		);
	});

	it("throws when loading a missing mission", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));

		expect(() => MissionStore.load("missing", { rootDir })).toThrow(
			"mission not found: missing",
		);
	});

	it("skips corrupt mission state files when listing snapshots", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({
			missionId: "healthy",
			config: { rootDir },
		}).save();
		const corruptDir = join(rootDir, "broken");
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(join(corruptDir, "state.json"), "{not-json");

		expect(listMissionStoreSnapshots(rootDir).map((m) => m.missionId)).toEqual([
			"healthy",
		]);
		expect(existsSync(join(corruptDir, "state.json"))).toBe(false);
		expect(
			readdirSync(corruptDir).some((name) =>
				name.startsWith("state.json.corrupt."),
			),
		).toBe(true);
	});

	it("skips invalid mission directories when listing", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "good", config: { rootDir } }).save();
		mkdirSync(join(rootDir, "!!!"), { recursive: true });

		expect(listMissionStoreSnapshots(rootDir).map((m) => m.missionId)).toEqual([
			"good",
		]);
	});

	it("loads current features from features.json when present", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "deep", config: { rootDir } }).save();
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [
					{
						id: "feature-1",
						description: "Fresh feature",
						status: "pending",
						fulfills: [],
					},
				],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "feature-1" })]);
	});

	it("keeps store features when features.json is older", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:02:00.000Z",
			},
		});
		store.setFeatures([
			{
				id: "fresh",
				description: "Fresh state feature",
				status: "pending",
				fulfills: [],
			},
		]);
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [
					{
						id: "stale",
						description: "Stale artifact feature",
						status: "pending",
						fulfills: [],
					},
				],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2026-06-19T00:01:00.000Z",
			}),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "fresh" })]);
	});

	it("ignores newer empty features.json overlays when durable state has features", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:02:00.000Z",
			},
		});
		store.setFeatures([
			{
				id: "fresh",
				description: "Fresh state feature",
				status: "pending",
				fulfills: [],
			},
		]);
		const featuresPath = join(rootDir, "deep", "features.json");
		writeFileSync(
			featuresPath,
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		const loaded = MissionStore.load("deep", {
			rootDir,
			now: () => "2026-06-19T00:03:00.000Z",
		});
		expect(loaded.getSnapshot().features).toEqual([
			expect.objectContaining({ id: "fresh" }),
		]);

		loaded.appendProgress({
			type: "note",
			message: "Preserve durable features",
		});

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "fresh" })]);
		expect(
			JSON.parse(readFileSync(featuresPath, "utf8")) as {
				features: Array<{ id: string }>;
			},
		).toMatchObject({
			features: [{ id: "fresh" }],
		});
	});

	it("ignores invalid features.json overlays without breaking mission loads", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:02:00.000Z",
			},
		});
		store.setFeatures([
			{
				id: "fresh",
				description: "Fresh state feature",
				status: "pending",
				fulfills: [],
			},
		]);
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify({
				version: 1,
				missionId: "other",
				milestones: [],
				features: [null],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "fresh" })]);
		expect(listMissionStoreSnapshots(rootDir).map((m) => m.missionId)).toEqual([
			"deep",
		]);
	});

	it("ignores features.json overlays with invalid feature statuses", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:02:00.000Z",
			},
		});
		store.setFeatures([
			{
				id: "fresh",
				description: "Fresh state feature",
				status: "pending",
				fulfills: [],
			},
		]);
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [
					{
						id: "corrupt",
						description: "Corrupt artifact feature",
						status: "done",
						fulfills: [],
					},
				],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "fresh" })]);
	});

	it("ignores features.json overlays with duplicate feature ids", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const store = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:02:00.000Z",
			},
		});
		store.setFeatures([
			{
				id: "fresh",
				description: "Fresh state feature",
				status: "pending",
				fulfills: [],
			},
		]);
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify({
				version: 1,
				missionId: "deep",
				milestones: [],
				features: [
					{
						id: "dupe",
						description: "First duplicate artifact feature",
						status: "pending",
						fulfills: [],
					},
					{
						id: "dupe",
						description: "Second duplicate artifact feature",
						status: "in-progress",
						fulfills: [],
					},
				],
				createdAt: "2026-06-19T00:00:00.000Z",
				updatedAt: "2099-06-19T00:00:00.000Z",
			}),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "fresh" })]);
	});

	it("rejects new raw mission ids that collide after sanitizing", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "foo bar", config: { rootDir } }).save();

		expect(() =>
			MissionStore.create({ missionId: "foo-bar", config: { rootDir } }).save(),
		).toThrow('missionId "foo-bar" collides with existing mission "foo bar"');
	});

	it("rejects loads whose raw mission ids collide after sanitizing", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({ missionId: "foo+bar", config: { rootDir } }).save();

		expect(() => MissionStore.load("foo bar", { rootDir })).toThrow(
			'missionId "foo bar" collides with existing mission "foo+bar"',
		);
		expect(
			MissionStore.load("foo-bar", { rootDir }).getSnapshot(),
		).toMatchObject({
			missionId: "foo-bar",
			sourceMissionId: "foo+bar",
		});
	});

	it("skips stray mission directories that cannot sanitize to a mission id", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({
			missionId: "good",
			config: { rootDir },
		}).save();
		mkdirSync(join(rootDir, "!!!"), { recursive: true });

		expect(
			listMissionStoreSnapshots(rootDir).map((snapshot) => snapshot.missionId),
		).toEqual(["good"]);
	});

	it("prefers validated features.json content over stale store snapshots", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const snapshot = MissionStore.create({
			missionId: "deep",
			config: { rootDir },
		}).save();
		writeFileSync(
			join(rootDir, "deep", "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: snapshot.missionId,
					milestones: [],
					features: [
						{
							id: "feature-1",
							description: "Fresh from manifest",
							status: "pending",
							fulfills: [],
						},
					],
					createdAt: snapshot.createdAt,
					updatedAt: "9999-12-31T23:59:59.999Z",
				},
				null,
				2,
			),
		);

		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toHaveLength(1);
		expect(listMissionStoreSnapshots(rootDir)[0]?.features).toHaveLength(1);
	});

	it("preserves newer features.json updates written during save", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		const base = MissionStore.create({
			missionId: "deep",
			config: {
				rootDir,
				now: () => "2026-06-19T00:00:00.000Z",
			},
		});
		base.save();

		const statePath = join(rootDir, "deep", "state.json");
		const featuresPath = join(rootDir, "deep", "features.json");
		const originalWriteJsonFile = fsUtils.writeJsonFile;
		const writeSpy = vi
			.spyOn(fsUtils, "writeJsonFile")
			.mockImplementation((path, data, options) => {
				originalWriteJsonFile(path, data, options);
				if (path !== statePath) return;
				writeFileSync(
					featuresPath,
					JSON.stringify(
						{
							version: 1,
							missionId: "deep",
							milestones: [],
							features: [
								{
									id: "feature-1",
									description: "Fresh orchestrator feature",
									status: "pending",
									fulfills: [],
								},
							],
							createdAt: "2026-06-19T00:00:00.000Z",
							updatedAt: "2026-06-19T00:02:00.000Z",
						},
						null,
						2,
					),
				);
			});

		try {
			const store = MissionStore.load("deep", {
				rootDir,
				now: () => "2026-06-19T00:01:00.000Z",
			});
			store.appendProgress({
				type: "note",
				message: "Keep progress without clobbering manifest",
			});
		} finally {
			writeSpy.mockRestore();
		}

		const manifest = JSON.parse(readFileSync(featuresPath, "utf8")) as {
			features: Array<{ id: string }>;
			updatedAt: string;
		};
		expect(manifest.features.map((feature) => feature.id)).toEqual([
			"feature-1",
		]);
		expect(manifest.updatedAt).toBe("2026-06-19T00:02:00.000Z");
		expect(
			MissionStore.load("deep", { rootDir }).getSnapshot().features,
		).toEqual([expect.objectContaining({ id: "feature-1" })]);
	});

	it("rejects creating a new mission over an existing normalized id", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-mission-store-"));
		MissionStore.create({
			missionId: "foo bar",
			config: { rootDir },
		}).save();

		expect(() =>
			MissionStore.create({
				missionId: "foo-bar",
				config: { rootDir },
			}),
		).toThrow('missionId "foo-bar" collides with existing mission "foo bar"');
	});
});

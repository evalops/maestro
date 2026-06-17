import { describe, expect, it } from "vitest";
import {
	MISSION_MANIFEST_VERSION,
	type MissionFeature,
	type MissionManifest,
	addMilestone,
	appendFeature,
	checkMissionCoverage,
	createMissionManifest,
	findFeature,
	preemptInsert,
	recordHandoff,
	setFeatureStatus,
	summarizeManifest,
} from "../../src/agent/mission-manifest.js";

function makeManifest(): MissionManifest {
	return createMissionManifest({
		missionId: "M-1",
		now: "2026-06-15T18:00:00.000Z",
	});
}

function makeFeature(
	overrides: Partial<Omit<MissionFeature, "status" | "handoff">> = {},
): Omit<MissionFeature, "status" | "handoff"> {
	return {
		id: "F-1",
		description: "Add the foo to the bar.",
		fulfills: ["a-1"],
		...overrides,
	};
}

describe("agent/mission-manifest", () => {
	describe("createMissionManifest", () => {
		it("returns an empty manifest with the configured version", () => {
			const m = makeManifest();
			expect(m.version).toBe(MISSION_MANIFEST_VERSION);
			expect(m.missionId).toBe("M-1");
			expect(m.features).toEqual([]);
			expect(m.milestones).toEqual([]);
		});

		it("throws when missionId is blank", () => {
			expect(() => createMissionManifest({ missionId: "" })).toThrow(
				/missionId is required/,
			);
			expect(() => createMissionManifest({ missionId: "  " })).toThrow(
				/missionId is required/,
			);
		});
	});

	describe("appendFeature", () => {
		it("appends a feature with status=pending", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			expect(m.features).toHaveLength(1);
			expect(m.features[0]?.status).toBe("pending");
		});

		it("throws on duplicate feature ids", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			expect(() => appendFeature(m, makeFeature({ id: "F-1" }))).toThrow(
				/Duplicate feature id/,
			);
		});

		it("drops a stray `handoff` on the input so pending features never carry one", () => {
			let m = makeManifest();
			// Bypass the type to simulate a caller that hand-rolled the
			// input from JSON and accidentally included a handoff.
			const bad = {
				id: "F-9",
				description: "with leaked handoff",
				fulfills: [],
				handoff: {
					workerId: "leaked",
					success: true,
					handedOffAt: "2026-06-15T19:00:00.000Z",
				},
			} as unknown as Omit<MissionFeature, "status" | "handoff">;
			m = appendFeature(m, bad);
			const f = findFeature(m, "F-9");
			expect(f?.status).toBe("pending");
			expect(f?.handoff).toBeUndefined();
		});

		it("throws on blank id / description", () => {
			const m = makeManifest();
			expect(() => appendFeature(m, makeFeature({ id: "" }))).toThrow(
				/feature.id is required/,
			);
			expect(() =>
				appendFeature(m, makeFeature({ description: "  " })),
			).toThrow(/feature.description is required/);
		});
	});

	describe("addMilestone", () => {
		it("adds milestones and rejects duplicates", () => {
			let m = makeManifest();
			m = addMilestone(m, { id: "ms-1", name: "First" });
			expect(m.milestones).toHaveLength(1);
			expect(() =>
				addMilestone(m, { id: "ms-1", name: "First again" }),
			).toThrow(/Duplicate milestone id/);
		});
	});

	describe("checkMissionCoverage", () => {
		it("returns ok when every contract assertion is claimed exactly once", () => {
			let m = makeManifest();
			m = appendFeature(
				m,
				makeFeature({ id: "F-1", fulfills: ["a-1", "a-2"] }),
			);
			m = appendFeature(m, makeFeature({ id: "F-2", fulfills: ["a-3"] }));
			const report = checkMissionCoverage(m, ["a-1", "a-2", "a-3"]);
			expect(report.ok).toBe(true);
			expect(report.orphans).toEqual([]);
			expect(report.duplicates).toEqual([]);
			expect(report.unknownAssertions).toEqual([]);
		});

		it("reports orphans (unclaimed contract assertions)", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1", fulfills: ["a-1"] }));
			const report = checkMissionCoverage(m, ["a-1", "a-2", "a-3"]);
			expect(report.ok).toBe(false);
			expect(report.orphans).toEqual(["a-2", "a-3"]);
		});

		it("reports duplicates (assertion claimed by > 1 feature)", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1", fulfills: ["a-1"] }));
			m = appendFeature(m, makeFeature({ id: "F-2", fulfills: ["a-1"] }));
			const report = checkMissionCoverage(m, ["a-1"]);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["a-1"]);
		});

		it("reports unknown assertion ids referenced by features", () => {
			let m = makeManifest();
			m = appendFeature(
				m,
				makeFeature({ id: "F-1", fulfills: ["a-1", "ghost"] }),
			);
			const report = checkMissionCoverage(m, ["a-1"]);
			expect(report.ok).toBe(false);
			expect(report.unknownAssertions).toEqual(["ghost"]);
		});

		it("reports orphans, duplicates, and unknowns together", () => {
			let m = makeManifest();
			m = appendFeature(
				m,
				makeFeature({ id: "F-1", fulfills: ["a-1", "a-1", "ghost"] }),
			);
			const report = checkMissionCoverage(m, ["a-1", "a-2"]);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["a-1"]);
			expect(report.orphans).toEqual(["a-2"]);
			expect(report.unknownAssertions).toEqual(["ghost"]);
		});

		it("reports an unknown assertion id claimed by > 1 feature as both unknown AND duplicate", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1", fulfills: ["ghost"] }));
			m = appendFeature(m, makeFeature({ id: "F-2", fulfills: ["ghost"] }));
			const report = checkMissionCoverage(m, ["a-1"]);
			expect(report.ok).toBe(false);
			expect(report.unknownAssertions).toEqual(["ghost"]);
			// Before the fix this was empty — duplicate detection only
			// considered contract ids, so two features racing on an
			// unknown id slipped through.
			expect(report.duplicates).toEqual(["ghost"]);
		});

		it("rejects duplicate assertion ids in the contract input", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1", fulfills: ["shared-id"] }));
			const report = checkMissionCoverage(m, ["shared-id", "shared-id"]);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["shared-id"]);
			expect(report.orphans).toEqual([]);
			expect(report.unknownAssertions).toEqual([]);
		});
	});

	describe("setFeatureStatus", () => {
		it("updates the lifecycle status of a feature", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			expect(findFeature(m, "F-1")?.status).toBe("in-progress");
		});

		it("throws when the feature id is unknown", () => {
			const m = makeManifest();
			expect(() => setFeatureStatus(m, "F-ghost", "passed")).toThrow(
				/not in manifest/,
			);
		});

		it("clears handoff when flipped to preempted so the next worker starts fresh", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "w-stale",
				success: true,
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			expect(findFeature(m, "F-1")?.handoff).toBeDefined();
			m = setFeatureStatus(m, "F-1", "preempted");
			const f = findFeature(m, "F-1");
			expect(f?.status).toBe("preempted");
			expect(f?.handoff).toBeUndefined();
		});

		it("preserves handoff when flipping to non-preempted statuses", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "w",
				success: true,
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = setFeatureStatus(m, "F-1", "failed");
			expect(findFeature(m, "F-1")?.handoff?.workerId).toBe("w");
		});

		it("clears handoff when re-queuing a feature back to pending", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "w-old",
				success: true,
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = setFeatureStatus(m, "F-1", "failed");
			expect(findFeature(m, "F-1")?.handoff?.workerId).toBe("w-old");
			m = setFeatureStatus(m, "F-1", "pending");
			const f = findFeature(m, "F-1");
			expect(f?.status).toBe("pending");
			expect(f?.handoff).toBeUndefined();
		});
	});

	describe("recordHandoff", () => {
		it("records the handoff and flips status to passed on success", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "worker-a",
				success: true,
				commitId: "abc1234",
				repoPath: "/tmp/repo",
				summary: "Implemented foo",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const f = findFeature(m, "F-1");
			expect(f?.status).toBe("passed");
			expect(f?.handoff?.commitId).toBe("abc1234");
		});

		it("flips status to failed when the handoff says success=false", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature());
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "worker-a",
				success: false,
				summary: "Validation failed",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			expect(findFeature(m, "F-1")?.status).toBe("failed");
		});

		it("throws when the feature id is unknown", () => {
			const m = makeManifest();
			expect(() =>
				recordHandoff(m, "F-ghost", {
					workerId: "w",
					success: true,
					handedOffAt: "2026-06-15T19:00:00.000Z",
				}),
			).toThrow(/not in manifest/);
		});
	});

	describe("preemptInsert", () => {
		it("inserts the new feature before the active one and reverts active to preempted", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = appendFeature(m, makeFeature({ id: "F-2" }));
			m = setFeatureStatus(m, "F-1", "passed");
			m = setFeatureStatus(m, "F-2", "in-progress");
			m = preemptInsert(
				m,
				makeFeature({ id: "F-urgent", description: "Hotfix" }),
			);

			expect(m.features.map((f) => f.id)).toEqual(["F-1", "F-urgent", "F-2"]);
			expect(findFeature(m, "F-urgent")?.status).toBe("pending");
			expect(findFeature(m, "F-2")?.status).toBe("preempted");
		});

		it("clears the preempted feature's handoff so the next worker starts fresh", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = recordHandoff(m, "F-1", {
				workerId: "w-old",
				success: true,
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			// The handoff just flipped F-1 to passed; reset to in-progress to
			// simulate a worker still in flight.
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = preemptInsert(m, makeFeature({ id: "F-urgent" }));

			const preempted = findFeature(m, "F-1");
			expect(preempted?.status).toBe("preempted");
			expect(preempted?.handoff).toBeUndefined();
		});

		it("drops a stray `handoff` on the inserted feature", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = setFeatureStatus(m, "F-1", "in-progress");
			const bad = {
				id: "F-urgent",
				description: "Hotfix",
				fulfills: [],
				handoff: {
					workerId: "leaked",
					success: true,
					handedOffAt: "2026-06-15T19:00:00.000Z",
				},
			} as unknown as Omit<MissionFeature, "status" | "handoff">;
			m = preemptInsert(m, bad);
			const inserted = findFeature(m, "F-urgent");
			expect(inserted?.status).toBe("pending");
			expect(inserted?.handoff).toBeUndefined();
		});

		it("throws when more than one feature is in-progress (runner invariant)", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = appendFeature(m, makeFeature({ id: "F-2", fulfills: [] }));
			m = setFeatureStatus(m, "F-1", "in-progress");
			m = setFeatureStatus(m, "F-2", "in-progress");
			expect(() => preemptInsert(m, makeFeature({ id: "F-urgent" }))).toThrow(
				/more than one feature is in-progress/,
			);
		});

		it("throws when no feature is in-progress", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			expect(() => preemptInsert(m, makeFeature({ id: "F-urgent" }))).toThrow(
				/no feature is currently in-progress/,
			);
		});

		it("throws when the inserted feature collides with an existing id", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = setFeatureStatus(m, "F-1", "in-progress");
			expect(() => preemptInsert(m, makeFeature({ id: "F-1" }))).toThrow(
				/duplicate feature id/,
			);
		});

		it("throws on blank id / description", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = setFeatureStatus(m, "F-1", "in-progress");
			expect(() => preemptInsert(m, makeFeature({ id: "" }))).toThrow(
				/feature.id is required/,
			);
			expect(() =>
				preemptInsert(m, makeFeature({ description: "  " })),
			).toThrow(/feature.description is required/);
		});
	});

	describe("summarizeManifest", () => {
		it("counts features by status and totals claimed assertions", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1", fulfills: ["a-1"] }));
			m = appendFeature(
				m,
				makeFeature({ id: "F-2", fulfills: ["a-2", "a-3"] }),
			);
			m = setFeatureStatus(m, "F-1", "passed");
			m = setFeatureStatus(m, "F-2", "in-progress");
			const s = summarizeManifest(m);
			expect(s.total).toBe(2);
			expect(s.byStatus.passed).toBe(1);
			expect(s.byStatus["in-progress"]).toBe(1);
			expect(s.assertionsClaimed).toBe(3);
		});
	});
});

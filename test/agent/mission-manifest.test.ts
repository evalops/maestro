import { describe, expect, it } from "vitest";
import {
	MISSION_MANIFEST_VERSION,
	type MissionFeature,
	type MissionManifest,
	addMilestone,
	appendFeature,
	appendHandoffFollowUps,
	canCompleteMission,
	checkMissionCoverage,
	createMissionManifest,
	dismissHandoffItem,
	findFeature,
	preemptInsert,
	recordHandoff,
	setFeatureStatus,
	summarizeManifest,
	summarizeMissionContinuity,
	trackHandoffItemOnFeature,
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

	describe("appendHandoffFollowUps", () => {
		it("turns unfinished work and blocking discoveries into pending follow-up features", () => {
			let m = makeManifest();
			m = appendFeature(
				m,
				makeFeature({
					id: "F-checkout",
					description: "Build checkout recovery.",
					milestone: "ms-1",
					skillName: "implementation-worker",
				}),
			);
			m = setFeatureStatus(m, "F-checkout", "in-progress");
			m = recordHandoff(m, "F-checkout", {
				workerId: "worker-a",
				success: false,
				whatWasImplemented:
					"Added checkout retry state and surfaced recoverable payment errors.",
				whatWasLeftUndone: "Run hosted checkout QA against staging.",
				discoveredIssues: [
					{
						severity: "blocking",
						description: "Staging seed account is missing billing fixtures.",
						suggestedFix: "Create a seeded billing account before QA.",
					},
					{
						severity: "non_blocking",
						description: "Local test output is noisy.",
					},
				],
				verification: {
					commandsRun: [
						{
							command: "npm test -- checkout",
							exitCode: 0,
							observation: "Unit coverage passed.",
						},
					],
				},
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			m = appendHandoffFollowUps(m, "F-checkout", {
				now: "2026-06-15T20:00:00.000Z",
			});

			expect(m.features.map((feature) => feature.id)).toEqual([
				"F-checkout",
				"F-checkout-followup-unfinished",
				"F-checkout-followup-issue-1",
			]);
			expect(findFeature(m, "F-checkout-followup-unfinished")).toMatchObject({
				status: "pending",
				milestone: "ms-1",
				skillName: "implementation-worker",
				fulfills: [],
				handoffSourceFeatureId: "F-checkout",
				handoffFollowUpKind: "unfinished_work",
				handoffItemKey:
					"unfinished_work:run hosted checkout qa against staging.",
				description:
					"Finish unfinished work from F-checkout: Run hosted checkout QA against staging.",
			});
			expect(findFeature(m, "F-checkout-followup-issue-1")).toMatchObject({
				status: "pending",
				handoffSourceFeatureId: "F-checkout",
				handoffFollowUpKind: "discovered_issue",
				handoffItemKey:
					"discovered_issue:blocking:staging seed account is missing billing fixtures.:create a seeded billing account before qa.",
				description:
					"Resolve blocking issue from F-checkout: Staging seed account is missing billing fixtures. Suggested fix: Create a seeded billing account before QA.",
			});
			expect(m.updatedAt).toBe("2026-06-15T20:00:00.000Z");
		});

		it("can include non-blocking discovered issues when requested", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-docs" }));
			m = recordHandoff(m, "F-docs", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "none",
				discoveredIssues: [
					{
						severity: "non_blocking",
						description: "Documentation should mention retry behavior.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			expect(appendHandoffFollowUps(m, "F-docs").features).toHaveLength(1);
			const withNonBlocking = appendHandoffFollowUps(m, "F-docs", {
				includeNonBlockingIssues: true,
				now: "2026-06-15T20:00:00.000Z",
			});
			expect(withNonBlocking.features.map((feature) => feature.id)).toEqual([
				"F-docs",
				"F-docs-followup-issue-1",
			]);
		});

		it("does not duplicate generated follow-ups when promotion is retried", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-retry" }));
			m = recordHandoff(m, "F-retry", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Run the hosted regression flow.",
				discoveredIssues: [
					{
						severity: "blocking",
						description: "Regression credentials are missing.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			m = appendHandoffFollowUps(m, "F-retry", {
				now: "2026-06-15T20:00:00.000Z",
			});
			m = appendHandoffFollowUps(m, "F-retry", {
				now: "2026-06-15T21:00:00.000Z",
			});

			expect(m.features.map((feature) => feature.id)).toEqual([
				"F-retry",
				"F-retry-followup-unfinished",
				"F-retry-followup-issue-1",
			]);
			expect(m.updatedAt).toBe("2026-06-15T20:00:00.000Z");
		});

		it("does not duplicate legacy follow-ups that do not have item keys", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-legacy" }));
			m = recordHandoff(m, "F-legacy", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Verify invoices in staging.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = appendFeature(
				m,
				makeFeature({
					id: "F-legacy-followup-unfinished",
					description:
						"Finish unfinished work from F-legacy: Verify invoices in staging.",
					fulfills: [],
					handoffSourceFeatureId: "F-legacy",
					handoffFollowUpKind: "unfinished_work",
				}),
			);

			m = appendHandoffFollowUps(m, "F-legacy", {
				now: "2026-06-15T20:00:00.000Z",
			});

			expect(
				m.features.filter(
					(feature) => feature.handoffSourceFeatureId === "F-legacy",
				),
			).toHaveLength(1);
			expect(m.features.map((feature) => feature.id)).toEqual([
				"F-legacy",
				"F-legacy-followup-unfinished",
			]);
		});

		it("handles handoffs without optional unfinished work or suggested fixes", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-minimal" }));
			m = recordHandoff(m, "F-minimal", {
				workerId: "worker-a",
				success: false,
				discoveredIssues: [
					{
						severity: "blocking",
						description: "Verification account is unavailable.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			m = appendHandoffFollowUps(m, "F-minimal", {
				now: "2026-06-15T20:00:00.000Z",
			});

			expect(m.features.map((feature) => feature.id)).toEqual([
				"F-minimal",
				"F-minimal-followup-issue-1",
			]);
		});

		it("allocates stable suffixes when follow-up ids already exist", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-1" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-1-followup-unfinished",
					description: "Existing manually-created follow-up.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-1", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Finish browser verification.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			m = appendHandoffFollowUps(m, "F-1", {
				now: "2026-06-15T20:00:00.000Z",
			});

			expect(m.features.map((feature) => feature.id)).toEqual([
				"F-1",
				"F-1-followup-unfinished-2",
				"F-1-followup-unfinished",
			]);
		});
	});

	describe("mission continuity", () => {
		it("reports blocking handoff items that have not been tracked or dismissed", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-auth" }));
			m = recordHandoff(m, "F-auth", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Run browser verification for SSO.",
				discoveredIssues: [
					{
						severity: "blocking",
						description: "The SSO fixture account cannot log in.",
					},
					{
						severity: "non_blocking",
						description: "Auth docs need a screenshot refresh.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(false);
			expect(continuity.unresolved).toMatchObject([
				{
					sourceFeatureId: "F-auth",
					kind: "unfinished_work",
					status: "untracked",
					description: "Run browser verification for SSO.",
				},
				{
					sourceFeatureId: "F-auth",
					kind: "discovered_issue",
					severity: "blocking",
					status: "untracked",
					description: "The SSO fixture account cannot log in.",
				},
			]);
			expect(continuity.openFollowUps).toEqual([]);
		});

		it("keeps mission continuity blocked until generated follow-ups pass", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-billing" }));
			m = recordHandoff(m, "F-billing", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Verify invoices in staging.",
				discoveredIssues: [
					{
						severity: "blocking",
						description: "Invoice webhook fixture is missing.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			m = appendHandoffFollowUps(m, "F-billing", {
				now: "2026-06-15T20:00:00.000Z",
			});

			let continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(false);
			expect(continuity.unresolved).toEqual([]);
			expect(continuity.tracked.map((item) => item.followUpFeatureId)).toEqual([
				"F-billing-followup-unfinished",
				"F-billing-followup-issue-1",
			]);
			expect(continuity.openFollowUps.map((item) => item.id)).toEqual([
				"F-billing-followup-unfinished",
				"F-billing-followup-issue-1",
			]);

			m = setFeatureStatus(m, "F-billing-followup-unfinished", "passed");
			m = setFeatureStatus(m, "F-billing-followup-issue-1", "passed");

			continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(true);
			expect(continuity.openFollowUps).toEqual([]);
		});

		it("recognizes legacy handoff follow-ups that do not have item keys", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-billing" }));
			m = recordHandoff(m, "F-billing", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify invoices in staging.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = appendFeature(
				m,
				makeFeature({
					id: "F-billing-followup-unfinished",
					description:
						"Finish unfinished work from F-billing: Verify invoices in staging.",
					fulfills: [],
					handoffSourceFeatureId: "F-billing",
					handoffFollowUpKind: "unfinished_work",
				}),
			);
			m = setFeatureStatus(m, "F-billing-followup-unfinished", "passed");

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(true);
			expect(continuity.tracked).toMatchObject([
				{
					sourceFeatureId: "F-billing",
					followUpFeatureId: "F-billing-followup-unfinished",
				},
			]);
			expect(continuity.unresolved).toEqual([]);
		});

		it("tracks a handoff item on an existing pending feature and blocks until that feature passes", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-checkout" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-staging-qa",
					description: "Run staging checkout and receipt QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-checkout", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Run hosted checkout QA.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			expect(item).toBeDefined();

			m = trackHandoffItemOnFeature(m, "F-checkout", "F-staging-qa", {
				kind: item!.kind,
				key: item!.key,
				note: "Existing QA feature already owns the hosted checkout pass.",
				now: "2026-06-15T20:00:00.000Z",
			});
			m = appendHandoffFollowUps(m, "F-checkout");

			let continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(false);
			expect(continuity.unresolved).toEqual([]);
			expect(continuity.tracked).toMatchObject([
				{
					sourceFeatureId: "F-checkout",
					trackingFeatureId: "F-staging-qa",
					trackingNote:
						"Existing QA feature already owns the hosted checkout pass.",
				},
			]);
			expect(continuity.openTrackedItems).toMatchObject([
				{
					id: "F-staging-qa",
					status: "pending",
					sourceFeatureId: "F-checkout",
					kind: "unfinished_work",
				},
			]);
			expect(
				m.features.filter(
					(feature) => feature.handoffSourceFeatureId === "F-checkout",
				),
			).toEqual([]);
			expect(findFeature(m, "F-staging-qa")?.trackedHandoffItems).toHaveLength(
				1,
			);
			expect(m.updatedAt).toBe("2026-06-15T20:00:00.000Z");

			m = setFeatureStatus(m, "F-staging-qa", "passed");
			continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(true);
			expect(continuity.openTrackedItems).toEqual([]);
		});

		it("moves an existing tracked handoff item when reassigned to a different feature", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-checkout" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-staging-qa",
					description: "Run staging checkout QA.",
					fulfills: [],
				}),
			);
			m = appendFeature(
				m,
				makeFeature({
					id: "F-browser-qa",
					description: "Run browser checkout QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-checkout", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Run hosted checkout QA.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			expect(item).toBeDefined();

			m = trackHandoffItemOnFeature(m, "F-checkout", "F-staging-qa", {
				kind: item!.kind,
				key: item!.key,
				note: "Initial QA owner.",
				now: "2026-06-15T20:00:00.000Z",
			});
			m = trackHandoffItemOnFeature(m, "F-checkout", "F-browser-qa", {
				kind: item!.kind,
				key: item!.key,
				note: "Reassigned to the browser QA pass.",
				now: "2026-06-15T21:00:00.000Z",
			});

			const continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(false);
			expect(continuity.tracked).toMatchObject([
				{
					sourceFeatureId: "F-checkout",
					trackingFeatureId: "F-browser-qa",
					trackingNote: "Reassigned to the browser QA pass.",
				},
			]);
			expect(continuity.openTrackedItems).toMatchObject([
				{
					id: "F-browser-qa",
					status: "pending",
					sourceFeatureId: "F-checkout",
					kind: "unfinished_work",
				},
			]);
			expect(
				findFeature(m, "F-staging-qa")?.trackedHandoffItems,
			).toBeUndefined();
			expect(findFeature(m, "F-browser-qa")?.trackedHandoffItems).toHaveLength(
				1,
			);
			expect(m.updatedAt).toBe("2026-06-15T21:00:00.000Z");
		});

		it("can requeue the source feature to handle its own handoff item", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-search" }));
			m = recordHandoff(m, "F-search", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Run browser verification for search filters.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			expect(findFeature(m, "F-search")?.status).toBe("passed");

			m = trackHandoffItemOnFeature(m, "F-search", "F-search", {
				kind: item!.kind,
				key: item!.key,
				note: "Re-run the same feature with the missing browser verification.",
				requeueTarget: true,
				now: "2026-06-15T20:00:00.000Z",
			});

			const feature = findFeature(m, "F-search");
			expect(feature?.status).toBe("pending");
			expect(feature?.handoff).toBeUndefined();
			expect(feature?.trackedHandoffItems).toMatchObject([
				{
					sourceFeatureId: "F-search",
					kind: "unfinished_work",
					key: item!.key,
				},
			]);
			const continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(false);
			expect(continuity.openTrackedItems).toMatchObject([
				{
					id: "F-search",
					status: "pending",
					sourceFeatureId: "F-search",
				},
			]);
		});

		it("does not keep cross-feature tracking open after the source is requeued", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				now: "2026-06-15T20:00:00.000Z",
			});
			m = setFeatureStatus(m, "F-source", "pending");

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(true);
			expect(continuity.tracked).toEqual([]);
			expect(continuity.unresolved).toEqual([]);
			expect(continuity.openTrackedItems).toEqual([]);
		});

		it("requeues failed targets and clears their stale handoff", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run the existing recovery flow.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = recordHandoff(m, "F-target", {
				workerId: "worker-b",
				success: false,
				summary: "Previous attempt failed.",
				handedOffAt: "2026-06-15T19:30:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;

			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				requeueTarget: true,
				now: "2026-06-15T20:00:00.000Z",
			});

			const target = findFeature(m, "F-target");
			expect(target?.status).toBe("pending");
			expect(target?.handoff).toBeUndefined();
			expect(target?.trackedHandoffItems).toHaveLength(1);
		});

		it("does not let stale tracking satisfy a newer handoff for the same item", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				now: "2026-06-15T20:00:00.000Z",
			});
			m = setFeatureStatus(m, "F-target", "passed");
			m = recordHandoff(m, "F-source", {
				workerId: "worker-c",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T21:00:00.000Z",
			});

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(false);
			expect(continuity.tracked).toEqual([]);
			expect(continuity.unresolved).toMatchObject([
				{
					sourceFeatureId: "F-source",
					kind: "unfinished_work",
				},
			]);
		});

		it("does not keep stale tracked items open after the source drops the obligation", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				now: "2026-06-15T20:00:00.000Z",
			});
			m = recordHandoff(m, "F-source", {
				workerId: "worker-b",
				success: true,
				whatWasLeftUndone: "none",
				handedOffAt: "2026-06-15T21:00:00.000Z",
			});

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(true);
			expect(continuity.tracked).toEqual([]);
			expect(continuity.unresolved).toEqual([]);
			expect(continuity.openTrackedItems).toEqual([]);
		});

		it("does not keep orphan tracked items open after the source is requeued", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				now: "2026-06-15T20:00:00.000Z",
			});
			m = setFeatureStatus(m, "F-source", "pending");

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(true);
			expect(continuity.tracked).toEqual([]);
			expect(continuity.unresolved).toEqual([]);
			expect(continuity.openTrackedItems).toEqual([]);
		});

		it("compares tracking freshness using parsed ISO instants with offsets", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T22:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				now: "2026-06-15T23:30:00.000Z",
			});
			m = setFeatureStatus(m, "F-target", "passed");
			m = recordHandoff(m, "F-source", {
				workerId: "worker-c",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00-05:00",
			});

			const continuity = summarizeMissionContinuity(m);

			expect(continuity.ok).toBe(false);
			expect(continuity.tracked).toEqual([]);
			expect(continuity.unresolved).toMatchObject([
				{
					sourceFeatureId: "F-source",
					kind: "unfinished_work",
				},
			]);
		});

		it("does not attach existing-feature tracking when a generated follow-up already owns the item", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: false,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			m = appendHandoffFollowUps(m, "F-source");
			const [tracked] = summarizeMissionContinuity(m).tracked;
			expect(tracked?.followUpFeatureId).toBe("F-source-followup-unfinished");
			expect(tracked?.trackingFeatureId).toBeUndefined();

			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-target", {
					kind: tracked!.kind,
					key: tracked!.key,
				}),
			).toThrow(/already tracked by follow-up feature/);
		});

		it("does not track dismissed handoff items", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			m = dismissHandoffItem(m, "F-source", {
				kind: item!.kind,
				key: item!.key,
				justification: "The staging receipt path is outside this mission.",
				now: "2026-06-15T20:00:00.000Z",
			});

			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-target", {
					kind: item!.kind,
					key: item!.key,
				}),
			).toThrow(/was dismissed/);
			expect(summarizeMissionContinuity(m).dismissed).toHaveLength(1);
		});

		it("requires self-tracking a passed source feature to requeue it", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;

			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-source", {
					kind: item!.kind,
					key: item!.key,
					allowPassedTarget: true,
				}),
			).toThrow(/self-track/);
		});

		it("requires in-progress targets to be requeued before tracking new handoff work", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Run recovery QA.",
					fulfills: [],
				}),
			);
			m = setFeatureStatus(m, "F-target", "in-progress");
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;

			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-target", {
					kind: item!.kind,
					key: item!.key,
				}),
			).toThrow(/in-progress feature/);

			m = trackHandoffItemOnFeature(m, "F-source", "F-target", {
				kind: item!.kind,
				key: item!.key,
				requeueTarget: true,
				now: "2026-06-15T20:00:00.000Z",
			});
			expect(findFeature(m, "F-target")?.status).toBe("pending");
		});

		it("requires an existing handoff item and refuses passed targets unless requeued", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-source" }));
			m = appendFeature(
				m,
				makeFeature({
					id: "F-target",
					description: "Already completed follow-on work.",
					fulfills: [],
				}),
			);
			m = setFeatureStatus(m, "F-target", "passed");
			m = recordHandoff(m, "F-source", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Verify staging receipts.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;

			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-target", {
					kind: item!.kind,
					key: item!.key,
				}),
			).toThrow(/passed feature/);
			expect(() =>
				trackHandoffItemOnFeature(m, "F-source", "F-source", {
					kind: "unfinished_work",
					key: "unfinished_work:not-real",
					requeueTarget: true,
				}),
			).toThrow(/not found/);
		});

		it("allows an explicit dismissal with justification to satisfy continuity", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-search" }));
			m = recordHandoff(m, "F-search", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Retest the legacy Lucene backend.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;
			expect(item).toBeDefined();

			m = dismissHandoffItem(m, "F-search", {
				kind: item!.kind,
				key: item!.key,
				justification:
					"Legacy Lucene backend is no longer shipped for this customer tier.",
				now: "2026-06-15T20:00:00.000Z",
			});

			const continuity = summarizeMissionContinuity(m);
			expect(continuity.ok).toBe(true);
			expect(continuity.dismissed).toMatchObject([
				{
					sourceFeatureId: "F-search",
					kind: "unfinished_work",
					status: "dismissed",
					dismissalJustification:
						"Legacy Lucene backend is no longer shipped for this customer tier.",
				},
			]);
			expect(findFeature(m, "F-search")?.handoffDismissals).toHaveLength(1);
			expect(m.updatedAt).toBe("2026-06-15T20:00:00.000Z");
		});

		it("requires dismissal justification and a real handoff item key", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-search" }));
			m = recordHandoff(m, "F-search", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Retest the legacy Lucene backend.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});
			const [item] = summarizeMissionContinuity(m).unresolved;

			expect(() =>
				dismissHandoffItem(m, "F-search", {
					kind: item!.kind,
					key: item!.key,
					justification: " ",
				}),
			).toThrow(/justification is required/);
			expect(() =>
				dismissHandoffItem(m, "F-search", {
					kind: "unfinished_work",
					key: "unfinished_work:not-a-real-item",
					justification: "Not applicable.",
				}),
			).toThrow(/not found/);
		});

		it("can include non-blocking issues in the continuity gate when requested", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-docs" }));
			m = recordHandoff(m, "F-docs", {
				workerId: "worker-a",
				success: true,
				discoveredIssues: [
					{
						severity: "non_blocking",
						description: "Docs should mention the fallback path.",
					},
				],
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			expect(summarizeMissionContinuity(m).ok).toBe(true);
			const strict = summarizeMissionContinuity(m, {
				includeNonBlockingIssues: true,
			});
			expect(strict.ok).toBe(false);
			expect(strict.unresolved).toMatchObject([
				{
					kind: "discovered_issue",
					severity: "non_blocking",
					status: "untracked",
				},
			]);
		});

		it("blocks mission completion on coverage gaps, incomplete features, and dangling handoff work", () => {
			let m = makeManifest();
			m = appendFeature(m, makeFeature({ id: "F-checkout" }));
			m = recordHandoff(m, "F-checkout", {
				workerId: "worker-a",
				success: true,
				whatWasLeftUndone: "Run hosted checkout QA.",
				handedOffAt: "2026-06-15T19:00:00.000Z",
			});

			let completion = canCompleteMission(m, ["a-1", "a-2"]);
			expect(completion.ok).toBe(false);
			expect(completion.coverage.orphans).toEqual(["a-2"]);
			expect(completion.continuity.unresolved).toHaveLength(1);
			expect(completion.incompleteFeatures).toEqual([]);

			m = appendFeature(
				m,
				makeFeature({ id: "F-receipts", fulfills: ["a-2"] }),
			);
			m = setFeatureStatus(m, "F-receipts", "passed");
			m = appendHandoffFollowUps(m, "F-checkout");
			completion = canCompleteMission(m, ["a-1", "a-2"]);
			expect(completion.ok).toBe(false);
			expect(completion.coverage.ok).toBe(true);
			expect(completion.continuity.openFollowUps).toHaveLength(1);
			expect(completion.incompleteFeatures).toMatchObject([
				{
					id: "F-checkout-followup-unfinished",
					status: "pending",
				},
			]);

			m = setFeatureStatus(m, "F-checkout-followup-unfinished", "passed");
			completion = canCompleteMission(m, ["a-1", "a-2"]);
			expect(completion.ok).toBe(true);
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

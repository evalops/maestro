import { describe, expect, it } from "vitest";
import type {
	MessageBoundarySnapshot,
	SessionSnapshotManifestData,
} from "../../src/agent/snapshot-manifest.js";
import {
	planPruning,
	pruningRequired,
} from "../../src/agent/snapshot-pruning-policy.js";

function makeBoundary(
	index: number,
	createdAt: string,
	bytes = 0,
): MessageBoundarySnapshot {
	return {
		index,
		createdAt,
		files: [],
		creations: [],
		deletions: [],
		totalSize: bytes,
	};
}

function makeManifest(
	boundaries: MessageBoundarySnapshot[],
): SessionSnapshotManifestData {
	return {
		sessionId: "test",
		version: 1,
		createdAt: boundaries[0]?.createdAt ?? "2026-06-15T18:00:00.000Z",
		lastAccessedAt:
			boundaries[boundaries.length - 1]?.createdAt ??
			"2026-06-15T18:00:00.000Z",
		boundaries,
		oldestAvailableBoundaryIndex: boundaries[0]?.index ?? 0,
		evictedBoundaryCount: 0,
	};
}

describe("agent/snapshot-pruning-policy", () => {
	describe("planPruning", () => {
		it("returns no-op for an empty manifest", () => {
			expect(planPruning(makeManifest([]), { maxBytes: 0 })).toEqual({
				dropCount: 0,
				reasons: [],
			});
		});

		it("returns no-op for an empty policy", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
			]);
			expect(planPruning(manifest, {})).toEqual({
				dropCount: 0,
				reasons: [],
			});
		});

		it("drops oldest boundaries to satisfy maxBytes", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
				makeBoundary(2, "2026-06-15T18:02:00.000Z", 100),
			]);
			const plan = planPruning(manifest, { maxBytes: 150 });
			expect(plan.dropCount).toBe(2);
			expect(plan.reasons).toContain("bytes-over-budget");
		});

		it("drops boundaries older than maxAgeMs", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z"),
				makeBoundary(1, "2026-06-15T18:01:00.000Z"),
				makeBoundary(2, "2026-06-15T18:30:00.000Z"),
			]);
			const plan = planPruning(
				manifest,
				{ maxAgeMs: 10 * 60 * 1000 },
				"2026-06-15T18:31:00.000Z",
			);
			// 18:00 and 18:01 are >10min old; 18:30 is within 10min.
			expect(plan.dropCount).toBe(2);
			expect(plan.reasons).toContain("age-over-limit");
		});

		it("caps retained boundary count at maxBoundaries", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z"),
				makeBoundary(1, "2026-06-15T18:01:00.000Z"),
				makeBoundary(2, "2026-06-15T18:02:00.000Z"),
				makeBoundary(3, "2026-06-15T18:03:00.000Z"),
			]);
			const plan = planPruning(manifest, { maxBoundaries: 2 });
			expect(plan.dropCount).toBe(2);
			expect(plan.reasons).toContain("count-over-limit");
		});

		it("never drops below minBoundaries even if other rules say more", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
			]);
			const plan = planPruning(manifest, {
				maxBytes: 0,
				minBoundaries: 2,
			});
			expect(plan.dropCount).toBe(0);
			expect(plan.reasons).toContain("min-boundaries-floor");
		});

		it("defaults minBoundaries to 1 so the manifest can't be emptied", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
			]);
			const plan = planPruning(manifest, { maxBytes: 0 });
			expect(plan.dropCount).toBe(1);
		});

		it("stops at the oldest pinned boundary", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
				makeBoundary(2, "2026-06-15T18:02:00.000Z", 100),
			]);
			const plan = planPruning(manifest, {
				maxBytes: 0,
				pinnedIndices: [1],
			});
			// Wants to drop 2 (to satisfy maxBytes=0), but boundary
			// index 1 is pinned → stop at index 1.
			expect(plan.dropCount).toBe(1);
			expect(plan.reasons).toContain("pinned-floor");
		});

		it("picks the most aggressive rule when multiple apply", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 1000),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
				makeBoundary(2, "2026-06-15T18:02:00.000Z", 100),
			]);
			const plan = planPruning(manifest, {
				maxBytes: 500, // would drop 1 (1000 → 200)
				maxBoundaries: 1, // would drop 2 (keep 1)
			});
			expect(plan.dropCount).toBe(2);
			expect(plan.reasons).toContain("count-over-limit");
		});

		it("reports every triggered rule in the reasons list", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 1000),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 1000),
				makeBoundary(2, "2026-06-15T18:02:00.000Z", 1000),
			]);
			const plan = planPruning(
				manifest,
				{
					maxBytes: 500, // 2 over budget
					maxAgeMs: 30 * 1000, // first 2 are older than 30s
					maxBoundaries: 1, // drop 2 to cap at 1
				},
				"2026-06-15T18:02:30.000Z",
			);
			expect(plan.reasons).toContain("bytes-over-budget");
			expect(plan.reasons).toContain("age-over-limit");
			expect(plan.reasons).toContain("count-over-limit");
		});

		it("falls back to file-size computation when totalSize is missing", () => {
			const manifest = makeManifest([
				{
					...makeBoundary(0, "2026-06-15T18:00:00.000Z"),
					totalSize: undefined,
					files: [
						{ path: "a", contentSha256: "x".repeat(64), size: 50 },
						{ path: "b", contentSha256: "y".repeat(64), size: 50 },
					],
				},
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
			]);
			const plan = planPruning(manifest, { maxBytes: 100 });
			expect(plan.dropCount).toBe(1);
		});
	});

	describe("pruningRequired", () => {
		it("returns true when planPruning would drop at least one boundary", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 100),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 100),
			]);
			expect(pruningRequired(manifest, { maxBytes: 50 })).toBe(true);
		});

		it("returns false when policy is satisfied", () => {
			const manifest = makeManifest([
				makeBoundary(0, "2026-06-15T18:00:00.000Z", 50),
				makeBoundary(1, "2026-06-15T18:01:00.000Z", 50),
			]);
			expect(pruningRequired(manifest, { maxBytes: 500 })).toBe(false);
		});
	});
});

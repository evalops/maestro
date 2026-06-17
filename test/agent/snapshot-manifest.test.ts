import { describe, expect, it } from "vitest";
import {
	type MessageBoundarySnapshot,
	SESSION_SNAPSHOT_MANIFEST_VERSION,
	appendBoundary,
	applyEvictionPlan,
	createSessionSnapshotManifest,
	findBoundaryByIndex,
	manifestTotalBytes,
	planEviction,
	summarizeManifest,
	withTotalSize,
} from "../../src/agent/snapshot-manifest.js";

function makeBoundary(
	overrides: Partial<Omit<MessageBoundarySnapshot, "index">> = {},
): Omit<MessageBoundarySnapshot, "index"> {
	return {
		createdAt: "2026-06-15T18:00:00.000Z",
		files: [{ path: "a.ts", contentSha256: "abc", size: 100 }],
		creations: [],
		deletions: [],
		...overrides,
	};
}

describe("agent/snapshot-manifest", () => {
	describe("createSessionSnapshotManifest", () => {
		it("returns an empty manifest with the configured version", () => {
			const m = createSessionSnapshotManifest(
				"sess-1",
				"2026-06-15T18:00:00.000Z",
			);
			expect(m.version).toBe(SESSION_SNAPSHOT_MANIFEST_VERSION);
			expect(m.sessionId).toBe("sess-1");
			expect(m.boundaries).toEqual([]);
			expect(m.oldestAvailableBoundaryIndex).toBe(0);
			expect(m.evictedBoundaryCount).toBe(0);
		});

		it("throws when sessionId is blank", () => {
			expect(() => createSessionSnapshotManifest("")).toThrow(
				/sessionId is required/,
			);
			expect(() => createSessionSnapshotManifest("  ")).toThrow(
				/sessionId is required/,
			);
		});
	});

	describe("withTotalSize", () => {
		it("computes totalSize from the files' sizes", () => {
			const sized = withTotalSize({
				index: 0,
				createdAt: "2026-06-15T18:00:00.000Z",
				files: [
					{ path: "a.ts", contentSha256: "x", size: 100 },
					{ path: "b.ts", contentSha256: "y", size: 250 },
				],
				creations: [],
				deletions: [],
			});
			expect(sized.totalSize).toBe(350);
		});
	});

	describe("appendBoundary", () => {
		it("assigns indices monotonically starting at 0", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());

			expect(m.boundaries.map((b) => b.index)).toEqual([0, 1, 2]);
		});

		it("continues the index sequence after eviction", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = applyEvictionPlan(m, 1);
			m = appendBoundary(m, makeBoundary());

			expect(m.boundaries.map((b) => b.index)).toEqual([1, 2]);
			expect(m.oldestAvailableBoundaryIndex).toBe(1);
		});

		it("computes totalSize when the caller doesn't supply it", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(
				m,
				makeBoundary({
					files: [
						{ path: "a.ts", contentSha256: "x", size: 100 },
						{ path: "b.ts", contentSha256: "y", size: 200 },
					],
				}),
			);
			expect(m.boundaries[0].totalSize).toBe(300);
		});

		it("updates lastAccessedAt to the boundary's createdAt", () => {
			let m = createSessionSnapshotManifest("sess", "2026-06-15T18:00:00.000Z");
			m = appendBoundary(
				m,
				makeBoundary({ createdAt: "2026-06-15T18:30:00.000Z" }),
			);
			expect(m.lastAccessedAt).toBe("2026-06-15T18:30:00.000Z");
		});
	});

	describe("manifestTotalBytes", () => {
		it("sums totalSize across retained boundaries", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(
				m,
				makeBoundary({
					files: [{ path: "a.ts", contentSha256: "x", size: 1000 }],
				}),
			);
			m = appendBoundary(
				m,
				makeBoundary({
					files: [{ path: "b.ts", contentSha256: "y", size: 2500 }],
				}),
			);
			expect(manifestTotalBytes(m)).toBe(3500);
		});

		it("re-computes when totalSize wasn't pre-supplied", () => {
			const manifest = createSessionSnapshotManifest("sess");
			manifest.boundaries.push({
				index: 0,
				createdAt: "2026-06-15T18:00:00.000Z",
				files: [{ path: "a.ts", contentSha256: "x", size: 100 }],
				creations: [],
				deletions: [],
			});
			expect(manifestTotalBytes(manifest)).toBe(100);
		});
	});

	describe("planEviction", () => {
		it("returns 0 when the manifest fits within the budget", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(
				m,
				makeBoundary({
					files: [{ path: "a.ts", contentSha256: "x", size: 100 }],
				}),
			);
			expect(planEviction(m, { maxBytes: 1000, minBoundaries: 0 })).toBe(0);
		});

		it("evicts from the oldest until the budget fits", () => {
			let m = createSessionSnapshotManifest("sess");
			for (let i = 0; i < 5; i += 1) {
				m = appendBoundary(
					m,
					makeBoundary({
						files: [{ path: `f${i}.ts`, contentSha256: `s${i}`, size: 100 }],
					}),
				);
			}
			// Total is 500; budget 200; should drop the 3 oldest.
			expect(planEviction(m, { maxBytes: 200, minBoundaries: 0 })).toBe(3);
		});

		it("respects the minBoundaries floor even when over budget", () => {
			let m = createSessionSnapshotManifest("sess");
			for (let i = 0; i < 5; i += 1) {
				m = appendBoundary(
					m,
					makeBoundary({
						files: [{ path: `f${i}.ts`, contentSha256: `s${i}`, size: 100 }],
					}),
				);
			}
			// Budget 0 means drop everything, but minBoundaries=3 prevents
			// reducing below 3 retained.
			expect(planEviction(m, { maxBytes: 0, minBoundaries: 3 })).toBe(2);
		});

		it("returns 0 on an empty manifest", () => {
			const m = createSessionSnapshotManifest("sess");
			expect(planEviction(m, { maxBytes: 0, minBoundaries: 0 })).toBe(0);
		});
	});

	describe("applyEvictionPlan", () => {
		it("drops the oldest count and advances index trackers", () => {
			let m = createSessionSnapshotManifest("sess");
			for (let i = 0; i < 4; i += 1) {
				m = appendBoundary(m, makeBoundary());
			}
			const after = applyEvictionPlan(m, 2);
			expect(after.boundaries.map((b) => b.index)).toEqual([2, 3]);
			expect(after.oldestAvailableBoundaryIndex).toBe(2);
			expect(after.evictedBoundaryCount).toBe(2);
		});

		it("is a no-op for non-positive counts", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			expect(applyEvictionPlan(m, 0)).toBe(m);
			expect(applyEvictionPlan(m, -1)).toBe(m);
		});

		it("clamps the count to the number of retained boundaries", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			const after = applyEvictionPlan(m, 99);
			expect(after.boundaries).toEqual([]);
			expect(after.evictedBoundaryCount).toBe(1);
		});
	});

	describe("findBoundaryByIndex", () => {
		it("returns the boundary at the stable index", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());

			expect(findBoundaryByIndex(m, 1)?.index).toBe(1);
		});

		it("still locates indices after eviction shifts the array", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = applyEvictionPlan(m, 1); // drops index 0

			// Boundary 1 is now at array position 0 — still findable by its
			// stable index.
			expect(findBoundaryByIndex(m, 1)?.index).toBe(1);
		});

		it("returns undefined for evicted indices", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			m = appendBoundary(m, makeBoundary());
			m = applyEvictionPlan(m, 1);

			expect(findBoundaryByIndex(m, 0)).toBeUndefined();
		});

		it("returns undefined for indices that never existed", () => {
			let m = createSessionSnapshotManifest("sess");
			m = appendBoundary(m, makeBoundary());
			expect(findBoundaryByIndex(m, 99)).toBeUndefined();
		});
	});

	describe("summarizeManifest", () => {
		it("reports retained / evicted / total / index window / bytes", () => {
			let m = createSessionSnapshotManifest("sess");
			for (let i = 0; i < 3; i += 1) {
				m = appendBoundary(
					m,
					makeBoundary({
						files: [{ path: `f${i}.ts`, contentSha256: `s${i}`, size: 100 }],
					}),
				);
			}
			m = applyEvictionPlan(m, 1);
			const s = summarizeManifest(m);
			expect(s.retained).toBe(2);
			expect(s.evicted).toBe(1);
			expect(s.totalBoundariesEver).toBe(3);
			expect(s.oldestIndex).toBe(1);
			expect(s.newestIndex).toBe(2);
			expect(s.totalBytes).toBe(200);
		});

		it("reports newestIndex as null for an empty manifest", () => {
			const m = createSessionSnapshotManifest("sess");
			expect(summarizeManifest(m).newestIndex).toBeNull();
		});
	});
});

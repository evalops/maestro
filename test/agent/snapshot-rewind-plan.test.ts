import { describe, expect, it } from "vitest";
import type {
	FileCreation,
	FileDeletion,
	FileSnapshot,
	MessageBoundarySnapshot,
	SessionSnapshotManifestData,
} from "../../src/agent/snapshot-manifest.js";
import {
	boundaryAt,
	canRewindTo,
	planRewind,
} from "../../src/agent/snapshot-rewind-plan.js";

function makeFile(
	path: string,
	contentSha256: string,
	size = contentSha256.length,
): FileSnapshot {
	return { path, contentSha256, size };
}

function makeBoundary(
	index: number,
	files: FileSnapshot[],
	{
		creations = [],
		deletions = [],
	}: {
		creations?: FileCreation[];
		deletions?: FileDeletion[];
	} = {},
): MessageBoundarySnapshot {
	return {
		index,
		createdAt: `2026-06-15T18:0${index}:00.000Z`,
		files,
		creations,
		deletions,
	};
}

function makeManifest(
	boundaries: MessageBoundarySnapshot[],
	oldestAvailable = boundaries[0]?.index ?? 0,
): SessionSnapshotManifestData {
	return {
		sessionId: "test-session",
		version: 1,
		createdAt: "2026-06-15T18:00:00.000Z",
		lastAccessedAt: "2026-06-15T18:05:00.000Z",
		boundaries,
		oldestAvailableBoundaryIndex: oldestAvailable,
		evictedBoundaryCount: oldestAvailable,
	};
}

describe("agent/snapshot-rewind-plan", () => {
	describe("planRewind", () => {
		// NOTE: the boundary schema captures pre-turn `files` plus the
		// turn's creations + deletions, but NOT in-place edits. The
		// planner can't trust any pre-turn hash for the latest boundary,
		// so it conservatively emits a restore for every target file
		// whose path is still present in the workspace. Tests below
		// reflect that safe-by-default behavior.

		it("returns a fully-restoring plan when target equals the latest boundary", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a.ts", "a".repeat(64))]),
				makeBoundary(1, [makeFile("a.ts", "b".repeat(64))]),
			]);
			const plan = planRewind(manifest, 1);
			// Even self-target replays a restore because in-place edits
			// could have happened between the boundary snapshot + now.
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "b".repeat(64),
					size: 64,
				},
			]);
			expect(plan.targetIndex).toBe(1);
			expect(plan.fromIndex).toBe(1);
		});

		it("uses successor boundary hashes for older target in-place edits", () => {
			const manifest = makeManifest([
				makeBoundary(0, [
					makeFile("a.ts", "old".padEnd(64, "0"), 100),
					makeFile("b.ts", "kept".padEnd(64, "0"), 50),
				]),
				makeBoundary(1, [
					makeFile("a.ts", "new".padEnd(64, "0"), 250),
					makeFile("b.ts", "kept".padEnd(64, "0"), 50),
				]),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "new".padEnd(64, "0"),
					size: 250,
				},
				{
					kind: "restore",
					path: "b.ts",
					contentSha256: "kept".padEnd(64, "0"),
					size: 50,
				},
			]);
			expect(plan.summary.bytesRestored).toBe(300);
		});

		it("emits delete ops for files that exist now but not at target", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a.ts", "a".repeat(64), 100)]),
				makeBoundary(1, [
					makeFile("a.ts", "a".repeat(64), 100),
					makeFile("created.ts", "c".repeat(64), 200),
				]),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops).toEqual([
				{ kind: "delete", path: "created.ts" },
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
			]);
			expect(plan.summary.deleteCount).toBe(1);
		});

		it("emits delete ops for files created during the latest turn", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a.ts", "a".repeat(64), 100)]),
				makeBoundary(1, [makeFile("a.ts", "a".repeat(64), 100)], {
					creations: [{ path: "created.ts" }],
				}),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops).toEqual([
				{ kind: "delete", path: "created.ts" },
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
			]);
		});

		it("does not delete files created during the target turn", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a.ts", "a".repeat(64), 100)]),
				makeBoundary(1, [makeFile("a.ts", "a".repeat(64), 100)], {
					creations: [{ path: "created.ts" }],
				}),
			]);
			const plan = planRewind(manifest, 1);
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
			]);
			expect(plan.summary.deleteCount).toBe(0);
		});

		it("emits restore ops for files that exist at target but not now", () => {
			const manifest = makeManifest([
				makeBoundary(0, [
					makeFile("a.ts", "a".repeat(64), 100),
					makeFile("removed.ts", "r".repeat(64), 250),
				]),
				makeBoundary(1, [makeFile("a.ts", "a".repeat(64), 100)]),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
				{
					kind: "restore",
					path: "removed.ts",
					contentSha256: "r".repeat(64),
					size: 250,
				},
			]);
		});

		it("emits restore ops for files deleted during the latest turn", () => {
			const manifest = makeManifest([
				makeBoundary(0, [
					makeFile("a.ts", "a".repeat(64), 100),
					makeFile("removed.ts", "r".repeat(64), 250),
				]),
				makeBoundary(
					1,
					[
						makeFile("a.ts", "a".repeat(64), 100),
						makeFile("removed.ts", "r".repeat(64), 250),
					],
					{
						deletions: [{ path: "removed.ts" }],
					},
				),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
				{
					kind: "restore",
					path: "removed.ts",
					contentSha256: "r".repeat(64),
					size: 250,
				},
			]);
		});

		it("does not restore files deleted during the target turn", () => {
			const manifest = makeManifest([
				makeBoundary(0, [
					makeFile("a.ts", "a".repeat(64), 100),
					makeFile("removed.ts", "r".repeat(64), 250),
				]),
				makeBoundary(
					1,
					[
						makeFile("a.ts", "a".repeat(64), 100),
						makeFile("removed.ts", "r".repeat(64), 250),
					],
					{
						deletions: [{ path: "removed.ts" }],
					},
				),
				makeBoundary(2, [makeFile("a.ts", "a".repeat(64), 100)]),
			]);
			const plan = planRewind(manifest, 1);
			expect(plan.ops).toEqual([
				{
					kind: "restore",
					path: "a.ts",
					contentSha256: "a".repeat(64),
					size: 100,
				},
			]);
		});

		it("orders deletes before restores so write-after-delete conflicts can't happen", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("path.ts", "old".padEnd(64, "0"), 100)]),
				makeBoundary(1, [
					makeFile("path.ts", "newer".padEnd(64, "0"), 200),
					makeFile("ext.ts", "x".repeat(64), 50),
				]),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops.map((op) => op.kind)).toEqual(["delete", "restore"]);
			expect(plan.ops[0]).toEqual({ kind: "delete", path: "ext.ts" });
		});

		it("sorts deletes + restores by path ascending for stable output", () => {
			const manifest = makeManifest([
				makeBoundary(0, [
					makeFile("z.ts", "z".repeat(64)),
					makeFile("a.ts", "a".repeat(64)),
				]),
				makeBoundary(1, [
					makeFile("z.ts", "Z".repeat(64)),
					makeFile("a.ts", "A".repeat(64)),
				]),
			]);
			const plan = planRewind(manifest, 0);
			expect(plan.ops.map((op) => op.path)).toEqual(["a.ts", "z.ts"]);
		});

		it("throws when the manifest has no boundaries", () => {
			const manifest = makeManifest([]);
			expect(() => planRewind(manifest, 0)).toThrow(/no boundaries/);
		});

		it("throws when target is older than the oldest available boundary (evicted)", () => {
			const manifest = makeManifest(
				[makeBoundary(5, [makeFile("a.ts", "a".repeat(64))])],
				5,
			);
			expect(() => planRewind(manifest, 2)).toThrow(/has been evicted/);
		});

		it("uses oldestAvailableBoundaryIndex for eviction even if the first boundary index drifts", () => {
			const manifest = makeManifest(
				[
					makeBoundary(4, [makeFile("a.ts", "a".repeat(64))]),
					makeBoundary(5, [makeFile("a.ts", "b".repeat(64))]),
				],
				5,
			);
			expect(() => planRewind(manifest, 4)).toThrow(/oldest available is 5/);
		});

		it("throws when target is newer than the latest boundary", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a.ts", "a".repeat(64))]),
				makeBoundary(1, [makeFile("a.ts", "a".repeat(64))]),
			]);
			expect(() => planRewind(manifest, 5)).toThrow(
				/is newer than the latest stored boundary/,
			);
		});
	});

	describe("canRewindTo", () => {
		it("is true within [oldestAvailable, latest]", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a", "a".repeat(64))]),
				makeBoundary(1, [makeFile("a", "a".repeat(64))]),
				makeBoundary(2, [makeFile("a", "a".repeat(64))]),
			]);
			expect(canRewindTo(manifest, 0)).toBe(true);
			expect(canRewindTo(manifest, 1)).toBe(true);
			expect(canRewindTo(manifest, 2)).toBe(true);
		});

		it("is false outside the kept range", () => {
			const manifest = makeManifest(
				[makeBoundary(5, [makeFile("a", "a".repeat(64))])],
				5,
			);
			expect(canRewindTo(manifest, 2)).toBe(false);
			expect(canRewindTo(manifest, 6)).toBe(false);
		});

		it("uses oldestAvailableBoundaryIndex when the retained array start drifts", () => {
			const manifest = makeManifest(
				[
					makeBoundary(4, [makeFile("a", "a".repeat(64))]),
					makeBoundary(5, [makeFile("a", "a".repeat(64))]),
				],
				5,
			);
			expect(canRewindTo(manifest, 4)).toBe(false);
			expect(canRewindTo(manifest, 5)).toBe(true);
		});

		it("is false for an empty manifest", () => {
			expect(canRewindTo(makeManifest([]), 0)).toBe(false);
		});
	});

	describe("boundaryAt", () => {
		it("returns the matching boundary", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a", "a".repeat(64))]),
				makeBoundary(1, [makeFile("b", "b".repeat(64))]),
			]);
			expect(boundaryAt(manifest, 0)?.index).toBe(0);
			expect(boundaryAt(manifest, 1)?.index).toBe(1);
		});

		it("returns undefined for unknown indices", () => {
			const manifest = makeManifest([
				makeBoundary(0, [makeFile("a", "a".repeat(64))]),
			]);
			expect(boundaryAt(manifest, 99)).toBeUndefined();
		});

		it("returns undefined for indices below the eviction guard", () => {
			// Eviction can leave stale-but-retained entries with index
			// below oldestAvailableBoundaryIndex; canRewindTo + planRewind
			// already refuse them, boundaryAt must agree.
			const manifest = makeManifest(
				[
					makeBoundary(2, [makeFile("a", "a".repeat(64))]),
					makeBoundary(3, [makeFile("b", "b".repeat(64))]),
				],
				3,
			);
			expect(boundaryAt(manifest, 2)).toBeUndefined();
			expect(boundaryAt(manifest, 3)?.index).toBe(3);
		});
	});
});

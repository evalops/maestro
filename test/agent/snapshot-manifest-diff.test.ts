import { describe, expect, it } from "vitest";
import {
	diffBoundarySnapshots,
	snapshotsEqual,
	summarizeDiff,
} from "../../src/agent/snapshot-manifest-diff.js";
import type {
	FileSnapshot,
	MessageBoundarySnapshot,
} from "../../src/agent/snapshot-manifest.js";

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
): MessageBoundarySnapshot {
	return {
		index,
		createdAt: "2026-06-15T18:00:00.000Z",
		files,
		creations: [],
		deletions: [],
	};
}

describe("agent/snapshot-manifest-diff", () => {
	describe("diffBoundarySnapshots", () => {
		it("returns empty add/remove/changed when both snapshots are identical", () => {
			const a = makeBoundary(0, [
				makeFile("src/a.ts", "a".repeat(64)),
				makeFile("src/b.ts", "b".repeat(64)),
			]);
			const b = makeBoundary(1, [
				makeFile("src/a.ts", "a".repeat(64)),
				makeFile("src/b.ts", "b".repeat(64)),
			]);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.added).toEqual([]);
			expect(diff.removed).toEqual([]);
			expect(diff.changed).toEqual([]);
			// unchanged omitted by default to keep diffs small.
			expect(diff.unchanged).toEqual([]);
		});

		it("includes unchanged entries when includeUnchanged=true", () => {
			const a = makeBoundary(0, [makeFile("src/a.ts", "a".repeat(64))]);
			const b = makeBoundary(1, [makeFile("src/a.ts", "a".repeat(64))]);
			const diff = diffBoundarySnapshots(a, b, { includeUnchanged: true });
			expect(diff.unchanged.map((f) => f.path)).toEqual(["src/a.ts"]);
		});

		it("flags added / removed / changed files correctly", () => {
			const a = makeBoundary(0, [
				makeFile("kept.ts", "k".repeat(64)),
				makeFile("modified.ts", "old".padEnd(64, "0")),
				makeFile("removed.ts", "r".repeat(64)),
			]);
			const b = makeBoundary(1, [
				makeFile("kept.ts", "k".repeat(64)),
				makeFile("modified.ts", "new".padEnd(64, "0")),
				makeFile("added.ts", "a".repeat(64)),
			]);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.added.map((f) => f.path)).toEqual(["added.ts"]);
			expect(diff.removed.map((f) => f.path)).toEqual(["removed.ts"]);
			expect(diff.changed.map((f) => f.path)).toEqual(["modified.ts"]);
			expect(diff.changed[0]?.fromSha).toBe("old".padEnd(64, "0"));
			expect(diff.changed[0]?.toSha).toBe("new".padEnd(64, "0"));
		});

		it("sorts every list by path ascending so output is order-stable", () => {
			const a = makeBoundary(0, [
				makeFile("z.ts", "z".repeat(64)),
				makeFile("a.ts", "a".repeat(64)),
			]);
			const b = makeBoundary(1, [
				makeFile("m.ts", "m".repeat(64)),
				makeFile("b.ts", "b".repeat(64)),
			]);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.added.map((f) => f.path)).toEqual(["b.ts", "m.ts"]);
			expect(diff.removed.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
		});

		it("records both from/to size when a file is modified", () => {
			const a = makeBoundary(0, [makeFile("x.ts", "a".repeat(64), 100)]);
			const b = makeBoundary(1, [makeFile("x.ts", "b".repeat(64), 250)]);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.changed[0]).toEqual({
				path: "x.ts",
				fromSha: "a".repeat(64),
				toSha: "b".repeat(64),
				fromSize: 100,
				toSize: 250,
			});
		});

		it("handles an empty from snapshot (everything is added)", () => {
			const a = makeBoundary(0, []);
			const b = makeBoundary(1, [
				makeFile("src/a.ts", "a".repeat(64)),
				makeFile("src/b.ts", "b".repeat(64)),
			]);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.added.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
			expect(diff.removed).toEqual([]);
		});

		it("handles an empty to snapshot (everything is removed)", () => {
			const a = makeBoundary(0, [
				makeFile("src/a.ts", "a".repeat(64)),
				makeFile("src/b.ts", "b".repeat(64)),
			]);
			const b = makeBoundary(1, []);
			const diff = diffBoundarySnapshots(a, b);
			expect(diff.removed.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
			expect(diff.added).toEqual([]);
		});
	});

	describe("summarizeDiff", () => {
		it("counts files + bytes across add/remove/change", () => {
			const a = makeBoundary(0, [
				makeFile("kept.ts", "k".repeat(64), 100),
				makeFile("shrink.ts", "old".padEnd(64, "0"), 800),
				makeFile("grow.ts", "old2".padEnd(64, "0"), 300),
				makeFile("removed.ts", "r".repeat(64), 600),
			]);
			const b = makeBoundary(1, [
				makeFile("kept.ts", "k".repeat(64), 100),
				makeFile("shrink.ts", "new".padEnd(64, "0"), 200),
				makeFile("grow.ts", "new2".padEnd(64, "0"), 750),
				makeFile("added.ts", "a".repeat(64), 250),
			]);
			const diff = diffBoundarySnapshots(a, b);
			const s = summarizeDiff(diff);
			expect(s.addedFiles).toBe(1);
			expect(s.removedFiles).toBe(1);
			expect(s.changedFiles).toBe(2);
			expect(s.bytesAdded).toBe(250);
			expect(s.bytesRemoved).toBe(600);
			// shrink: 200 - 800 = -600; grow: 750 - 300 = 450. Net -150.
			expect(s.bytesChanged).toBe(-150);
		});

		it("returns zeros for an empty diff", () => {
			expect(
				summarizeDiff({ added: [], removed: [], changed: [], unchanged: [] }),
			).toEqual({
				addedFiles: 0,
				removedFiles: 0,
				changedFiles: 0,
				bytesAdded: 0,
				bytesRemoved: 0,
				bytesChanged: 0,
			});
		});
	});

	describe("snapshotsEqual", () => {
		it("is true when file sets + hashes match", () => {
			const a = makeBoundary(0, [
				makeFile("a", "1".repeat(64)),
				makeFile("b", "2".repeat(64)),
			]);
			const b = makeBoundary(1, [
				makeFile("b", "2".repeat(64)),
				makeFile("a", "1".repeat(64)),
			]);
			expect(snapshotsEqual(a, b)).toBe(true);
		});

		it("is false when a hash differs", () => {
			const a = makeBoundary(0, [makeFile("a", "1".repeat(64))]);
			const b = makeBoundary(1, [makeFile("a", "2".repeat(64))]);
			expect(snapshotsEqual(a, b)).toBe(false);
		});

		it("is false when one side has duplicate paths and the other introduces a distinct path", () => {
			// Pre-fix `snapshotsEqual` did a length check + one-sided
			// path walk; duplicate paths in `from` could mask a path
			// that exists only in `to` and the function returned true
			// even though `diffBoundarySnapshots` correctly reported
			// the add. Index-based comparison fixes this.
			const a = makeBoundary(0, [
				makeFile("a", "1".repeat(64)),
				makeFile("a", "1".repeat(64)),
			]);
			const b = makeBoundary(1, [
				makeFile("a", "1".repeat(64)),
				makeFile("b", "2".repeat(64)),
			]);
			expect(snapshotsEqual(a, b)).toBe(false);
		});

		it("is false when file counts differ", () => {
			const a = makeBoundary(0, [makeFile("a", "1".repeat(64))]);
			const b = makeBoundary(1, [
				makeFile("a", "1".repeat(64)),
				makeFile("b", "2".repeat(64)),
			]);
			expect(snapshotsEqual(a, b)).toBe(false);
		});
	});
});

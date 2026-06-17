import { describe, expect, it } from "vitest";
import { aggregateBoundarySnapshotDiffs } from "../../src/agent/snapshot-diff-aggregate.js";
import type {
	BoundarySnapshotDiff,
	ChangedFile,
	SingleSidedFile,
} from "../../src/agent/snapshot-manifest-diff.js";

function makeSingle(
	path: string,
	sha: string,
	size = sha.length,
): SingleSidedFile {
	return { path, contentSha256: sha, size };
}

function makeChanged(
	path: string,
	fromSha: string,
	toSha: string,
	fromSize = fromSha.length,
	toSize = toSha.length,
): ChangedFile {
	return { path, fromSha, toSha, fromSize, toSize };
}

function makeDiff(
	overrides: Partial<BoundarySnapshotDiff> = {},
): BoundarySnapshotDiff {
	return {
		added: [],
		removed: [],
		changed: [],
		unchanged: [],
		...overrides,
	};
}

describe("agent/snapshot-diff-aggregate", () => {
	it("returns an empty diff for an empty input", () => {
		const out = aggregateBoundarySnapshotDiffs([]);
		expect(out.added).toEqual([]);
		expect(out.removed).toEqual([]);
		expect(out.changed).toEqual([]);
		expect(out.unchanged).toEqual([]);
	});

	it("passes a single diff through unchanged (ignoring `unchanged`)", () => {
		const single = makeDiff({
			added: [makeSingle("a.ts", "1".repeat(64))],
			removed: [makeSingle("b.ts", "2".repeat(64))],
			changed: [makeChanged("c.ts", "3".repeat(64), "4".repeat(64))],
			unchanged: [makeSingle("kept.ts", "k".repeat(64))],
		});
		const out = aggregateBoundarySnapshotDiffs([single]);
		expect(out.added.map((f) => f.path)).toEqual(["a.ts"]);
		expect(out.removed.map((f) => f.path)).toEqual(["b.ts"]);
		expect(out.changed.map((f) => f.path)).toEqual(["c.ts"]);
		expect(out.unchanged).toEqual([]);
	});

	it("cancels out a file added then removed", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({ added: [makeSingle("x.ts", "1".repeat(64))] }),
			makeDiff({ removed: [makeSingle("x.ts", "1".repeat(64))] }),
		]);
		expect(out.added).toEqual([]);
		expect(out.removed).toEqual([]);
	});

	it("collapses changed-then-removed into a single remove anchored at the original sha", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({
				changed: [
					makeChanged(
						"x.ts",
						"orig".padEnd(64, "0"),
						"mid".padEnd(64, "0"),
						100,
						200,
					),
				],
			}),
			makeDiff({
				removed: [makeSingle("x.ts", "mid".padEnd(64, "0"), 200)],
			}),
		]);
		expect(out.removed).toEqual([
			{
				path: "x.ts",
				contentSha256: "orig".padEnd(64, "0"),
				size: 100,
			},
		]);
	});

	it("collapses added-then-changed into a single add with the latest sha + size", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({ added: [makeSingle("x.ts", "first".padEnd(64, "0"), 100)] }),
			makeDiff({
				changed: [
					makeChanged(
						"x.ts",
						"first".padEnd(64, "0"),
						"second".padEnd(64, "0"),
						100,
						250,
					),
				],
			}),
		]);
		expect(out.added).toEqual([
			{
				path: "x.ts",
				contentSha256: "second".padEnd(64, "0"),
				size: 250,
			},
		]);
	});

	it("merges back-to-back changes keeping earliest fromSha and latest toSha", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({
				changed: [
					makeChanged(
						"x.ts",
						"v1".padEnd(64, "0"),
						"v2".padEnd(64, "0"),
						100,
						150,
					),
				],
			}),
			makeDiff({
				changed: [
					makeChanged(
						"x.ts",
						"v2".padEnd(64, "0"),
						"v3".padEnd(64, "0"),
						150,
						175,
					),
				],
			}),
		]);
		expect(out.changed[0]).toEqual({
			path: "x.ts",
			fromSha: "v1".padEnd(64, "0"),
			toSha: "v3".padEnd(64, "0"),
			fromSize: 100,
			toSize: 175,
		});
	});

	it("cancels out a change that ends up reverted to the original", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({
				changed: [
					makeChanged("x.ts", "orig".padEnd(64, "0"), "mid".padEnd(64, "0")),
				],
			}),
			makeDiff({
				changed: [
					makeChanged("x.ts", "mid".padEnd(64, "0"), "orig".padEnd(64, "0")),
				],
			}),
		]);
		expect(out.added).toEqual([]);
		expect(out.removed).toEqual([]);
		expect(out.changed).toEqual([]);
	});

	it("collapses removed-then-readded-with-same-sha back to a no-op", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({ removed: [makeSingle("x.ts", "a".repeat(64))] }),
			makeDiff({ added: [makeSingle("x.ts", "a".repeat(64))] }),
		]);
		expect(out.added).toEqual([]);
		expect(out.removed).toEqual([]);
	});

	it("collapses removed-then-readded-with-different-sha into a change", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({ removed: [makeSingle("x.ts", "a".repeat(64), 100)] }),
			makeDiff({ added: [makeSingle("x.ts", "b".repeat(64), 200)] }),
		]);
		expect(out.changed).toEqual([
			{
				path: "x.ts",
				fromSha: "a".repeat(64),
				toSha: "b".repeat(64),
				fromSize: 100,
				toSize: 200,
			},
		]);
	});

	it("sorts output lists by path ascending", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({
				added: [
					makeSingle("z.ts", "z".repeat(64)),
					makeSingle("a.ts", "a".repeat(64)),
				],
			}),
			makeDiff({
				removed: [
					makeSingle("zz.ts", "z".repeat(64)),
					makeSingle("aa.ts", "a".repeat(64)),
				],
			}),
		]);
		expect(out.added.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
		expect(out.removed.map((f) => f.path)).toEqual(["aa.ts", "zz.ts"]);
	});

	it("preserves unrelated paths across aggregation", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({ added: [makeSingle("kept-add.ts", "1".repeat(64))] }),
			makeDiff({ removed: [makeSingle("kept-remove.ts", "2".repeat(64))] }),
			makeDiff({
				changed: [
					makeChanged("kept-change.ts", "3".repeat(64), "4".repeat(64)),
				],
			}),
		]);
		expect(out.added.map((f) => f.path)).toEqual(["kept-add.ts"]);
		expect(out.removed.map((f) => f.path)).toEqual(["kept-remove.ts"]);
		expect(out.changed.map((f) => f.path)).toEqual(["kept-change.ts"]);
	});

	it("always returns an empty `unchanged` regardless of input", () => {
		const out = aggregateBoundarySnapshotDiffs([
			makeDiff({
				added: [makeSingle("x.ts", "a".repeat(64))],
				unchanged: [makeSingle("kept.ts", "k".repeat(64))],
			}),
		]);
		expect(out.unchanged).toEqual([]);
	});
});

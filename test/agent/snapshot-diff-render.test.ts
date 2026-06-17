import { describe, expect, it } from "vitest";
import { renderSnapshotDiff } from "../../src/agent/snapshot-diff-render.js";
import type {
	BoundarySnapshotDiff,
	ChangedFile,
	SingleSidedFile,
} from "../../src/agent/snapshot-manifest-diff.js";

function makeSingle(
	path: string,
	size = 100,
	sha = "a".repeat(64),
): SingleSidedFile {
	return { path, contentSha256: sha, size };
}

function makeChanged(
	path: string,
	fromSize: number,
	toSize: number,
): ChangedFile {
	return {
		path,
		fromSha: "a".repeat(64),
		toSha: "b".repeat(64),
		fromSize,
		toSize,
	};
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

describe("agent/snapshot-diff-render", () => {
	it("renders 'No changes.' when every list is empty", () => {
		const out = renderSnapshotDiff(makeDiff());
		expect(out).toContain("_No changes._");
		expect(out).not.toContain("Summary");
	});

	it("renders a summary line with added/removed/changed counts", () => {
		const out = renderSnapshotDiff(
			makeDiff({
				added: [makeSingle("a.ts"), makeSingle("b.ts")],
				removed: [makeSingle("r.ts")],
				changed: [makeChanged("c.ts", 100, 200)],
			}),
		);
		expect(out).toContain("**Summary:** +2 added · -1 removed · ~1 changed");
	});

	it("renders the Added section with byte sizes", () => {
		const out = renderSnapshotDiff(
			makeDiff({
				added: [makeSingle("src/new.ts", 1500)],
			}),
		);
		expect(out).toContain("Added (1)");
		expect(out).toContain("`src/new.ts`");
		expect(out).toContain("1.5 KB");
	});

	it("renders the Changed section with from→to size and signed delta", () => {
		const out = renderSnapshotDiff(
			makeDiff({
				changed: [
					makeChanged("shrink.ts", 800, 200),
					makeChanged("grow.ts", 300, 750),
					makeChanged("noop.ts", 100, 100),
				],
			}),
		);
		expect(out).toContain("`shrink.ts`");
		expect(out).toContain("800 B → 200 B, -600 bytes");
		expect(out).toContain("300 B → 750 B, +450 bytes");
		expect(out).toContain("100 B → 100 B, no size change");
	});

	it("formats large sizes in KB / MB / GB", () => {
		const out = renderSnapshotDiff(
			makeDiff({
				added: [
					makeSingle("small.ts", 512),
					makeSingle("medium.ts", 2 * 1024 * 1024),
					makeSingle("large.ts", 3 * 1024 * 1024 * 1024),
				],
			}),
		);
		expect(out).toContain("512 B");
		expect(out).toContain("2.0 MB");
		expect(out).toContain("3.0 GB");
	});

	it("uses a default H3 heading; respects custom title", () => {
		const out = renderSnapshotDiff(makeDiff({ added: [makeSingle("x.ts")] }));
		expect(out).toContain("### Workspace diff");
		const custom = renderSnapshotDiff(
			makeDiff({ added: [makeSingle("x.ts")] }),
			{ title: "Turn 7 diff" },
		);
		expect(custom).toContain("### Turn 7 diff");
	});

	it("omits the heading when title is null", () => {
		const out = renderSnapshotDiff(makeDiff({ added: [makeSingle("x.ts")] }), {
			title: null,
		});
		expect(out.startsWith("#")).toBe(false);
	});

	it("respects headingDepthOffset and clamps to H6", () => {
		const out = renderSnapshotDiff(makeDiff({ added: [makeSingle("x.ts")] }), {
			headingDepthOffset: 1,
		});
		expect(out).toMatch(/^#{4} Workspace diff/);
		const tooDeep = renderSnapshotDiff(
			makeDiff({ added: [makeSingle("x.ts")] }),
			{ headingDepthOffset: 99 },
		);
		expect(tooDeep).toMatch(/^#{6} Workspace diff/);
	});

	it("renders the Unchanged section when it's the only non-empty list (callers explicitly asked for it)", () => {
		// Pre-fix the early-return for empty add/remove/changed
		// dropped the `_No changes._` branch even when the caller
		// requested unchanged, so the Unchanged section never
		// rendered.
		const out = renderSnapshotDiff(
			makeDiff({ unchanged: [makeSingle("kept.ts", 200)] }),
			{ includeUnchanged: true },
		);
		expect(out).not.toContain("_No changes._");
		expect(out).toContain("Unchanged (1)");
		expect(out).toContain("`kept.ts`");
	});

	it("includes Unchanged section only when includeUnchanged=true", () => {
		const diff = makeDiff({
			changed: [makeChanged("x.ts", 100, 200)],
			unchanged: [makeSingle("kept.ts")],
		});
		expect(renderSnapshotDiff(diff)).not.toContain("Unchanged");
		expect(renderSnapshotDiff(diff, { includeUnchanged: true })).toContain(
			"Unchanged (1)",
		);
	});

	it("truncates each section at maxFilesPerSection", () => {
		const added: SingleSidedFile[] = [];
		for (let i = 0; i < 75; i += 1) {
			added.push(makeSingle(`f-${i}.ts`));
		}
		const out = renderSnapshotDiff(makeDiff({ added }), {
			maxFilesPerSection: 50,
		});
		expect(out).toContain("Added (75)");
		expect(out).toContain("_… and 25 more_");
		expect(out).toContain("`f-0.ts`");
		expect(out).not.toContain("`f-50.ts`");
	});

	it("does not truncate when section size <= maxFilesPerSection", () => {
		const added = [makeSingle("a.ts"), makeSingle("b.ts")];
		const out = renderSnapshotDiff(makeDiff({ added }), {
			maxFilesPerSection: 5,
		});
		expect(out).not.toContain("… and");
	});

	it("throws on a negative maxFilesPerSection", () => {
		expect(() =>
			renderSnapshotDiff(makeDiff({ added: [makeSingle("x.ts")] }), {
				maxFilesPerSection: -1,
			}),
		).toThrow(/maxFilesPerSection must be a non-negative integer/);
	});

	it("wraps backtick-containing paths in a code span that survives the embedded backtick", () => {
		// CommonMark treats backslash as literal inside code spans, so
		// a single-backtick wrapper around `` x`y `` would close at the
		// embedded backtick and corrupt the rendered list item. The
		// renderer picks a longer delimiter when needed.
		const out = renderSnapshotDiff(
			makeDiff({ added: [makeSingle("dir/`weird`.ts")] }),
		);
		expect(out).toContain("`` dir/`weird`.ts ``");
	});

	it("uses a delimiter longer than the longest internal backtick run", () => {
		// Path containing a 2-backtick run must get a 3-backtick
		// delimiter. The previous "skip run-lengths that appear in
		// the body" logic would have picked length 1 (which is legal
		// per CommonMark but ambiguous to some renderers).
		const out = renderSnapshotDiff(
			makeDiff({ added: [makeSingle("dir/x``y.ts")] }),
		);
		expect(out).toContain("``` dir/x``y.ts ```");
	});

	it("collapses newlines in paths so they can't bleed across markdown lines", () => {
		const out = renderSnapshotDiff(
			makeDiff({ added: [makeSingle("dir\n# inject\npath.ts")] }),
		);
		expect(out).not.toMatch(/^# inject$/m);
		expect(out).toContain("dir # inject path.ts");
	});
});

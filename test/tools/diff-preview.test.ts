import { beforeEach, describe, expect, it } from "vitest";
import { diffPreview } from "../../src/tools/diff-preview.js";

// The manager is a shared singleton; clear between tests for isolation.
beforeEach(() => {
	diffPreview.clearAllPreviews();
});

describe("DiffPreviewManager — createPreview", () => {
	it("generates hunks and counts additions/deletions for a modification", async () => {
		const preview = await diffPreview.createPreview({
			filePath: "src/app.ts",
			originalContent: "line1\nline2\nline3",
			newContent: "line1\nchanged\nline3",
		});
		expect(preview.fileName).toBe("app.ts");
		expect(preview.isNewFile).toBe(false);
		expect(preview.isDeleted).toBe(false);
		expect(preview.additions).toBe(1);
		expect(preview.deletions).toBe(1);
		expect(preview.hunks.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a new file when originalContent is empty", async () => {
		const preview = await diffPreview.createPreview({
			filePath: "new.txt",
			originalContent: "",
			newContent: "fresh\ncontent",
		});
		expect(preview.isNewFile).toBe(true);
		expect(preview.additions).toBeGreaterThan(0);
	});

	it("flags a deletion when newContent is empty", async () => {
		const preview = await diffPreview.createPreview({
			filePath: "gone.txt",
			originalContent: "was here",
			newContent: "",
		});
		expect(preview.isDeleted).toBe(true);
		expect(preview.deletions).toBe(1);
	});

	it("produces no hunks for identical content", async () => {
		const preview = await diffPreview.createPreview({
			filePath: "same.txt",
			originalContent: "a\nb\nc",
			newContent: "a\nb\nc",
		});
		expect(preview.hunks).toHaveLength(0);
		expect(preview.additions).toBe(0);
		expect(preview.deletions).toBe(0);
	});
});

describe("DiffPreviewManager — formatUnified", () => {
	it("renders file headers, hunk headers, and prefixed lines", async () => {
		const preview = await diffPreview.createPreview({
			filePath: "src/lib.ts",
			originalContent: "keep\ndelete me\nkeep2",
			newContent: "keep\nadded\nkeep2",
		});
		const out = diffPreview.formatUnified(preview);
		expect(out).toContain("--- a/lib.ts");
		expect(out).toContain("+++ b/lib.ts");
		// at least one hunk header line
		expect(out).toMatch(/@@.*@@/);
		// added line prefixed with +, removed with -
		expect(out).toContain("+added");
		expect(out).toContain("-delete me");
	});
});

describe("DiffPreviewManager — applyHunks (roundtrip)", () => {
	it("applying all hunks reconstructs the new content for a single-region change", async () => {
		const originalContent = "a\nb\nc\nd\ne";
		const newContent = "a\nB!\nc\nd\ne";
		const preview = await diffPreview.createPreview({
			filePath: "x.txt",
			originalContent,
			newContent,
		});
		const allIndices = preview.hunks.map((_, i) => i);
		const reconstructed = diffPreview.applyHunks(preview, allIndices);
		expect(reconstructed).toBe(newContent);
	});

	it("applying a subset yields a partial merge", async () => {
		// two separate change regions -> two hunks (with enough separation)
		const originalContent = "h1\nold1\nh2\nh3\nh4\nh5\nold2\nh6";
		const newContent = "h1\nnew1\nh2\nh3\nh4\nh5\nnew2\nh6";
		const preview = await diffPreview.createPreview({
			filePath: "two.txt",
			originalContent,
			newContent,
			contextLines: 1,
		});
		expect(preview.hunks.length).toBeGreaterThanOrEqual(2);
		// apply ONLY the first hunk -> first region changed, second left as original
		const onlyFirst = diffPreview.applyHunks(preview, [0]);
		expect(onlyFirst).toContain("new1");
		expect(onlyFirst).toContain("old2"); // second region untouched
	});
});

describe("DiffPreviewManager — pending preview state", () => {
	it("stores, retrieves, and clears previews", async () => {
		await diffPreview.createPreview({
			filePath: "state-a.txt",
			originalContent: "x",
			newContent: "y",
		});
		expect(diffPreview.getPendingPreview("state-a.txt")?.additions).toBe(1);

		diffPreview.clearPreview("state-a.txt");
		expect(diffPreview.getPendingPreview("state-a.txt")).toBeUndefined();
	});

	it("getSummary aggregates stored previews and clearAllPreviews empties them", async () => {
		await diffPreview.createPreview({
			filePath: "sum-1.txt",
			originalContent: "a",
			newContent: "a\nb",
		});
		await diffPreview.createPreview({
			filePath: "sum-2.txt",
			originalContent: "c\nd",
			newContent: "c",
		});
		const summary = diffPreview.getSummary();
		expect(summary.totalFiles).toBe(2);
		expect(summary.totalAdditions).toBe(1); // +b
		expect(summary.totalDeletions).toBe(1); // -d
		expect(summary.files.map((f) => f.path).sort()).toEqual([
			"sum-1.txt",
			"sum-2.txt",
		]);

		diffPreview.clearAllPreviews();
		expect(diffPreview.getSummary().totalFiles).toBe(0);
	});
});

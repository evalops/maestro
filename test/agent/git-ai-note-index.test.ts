import { describe, expect, it } from "vitest";
import {
	filterAgentNoteIndex,
	findAgentNoteForCommit,
	indexAgentNotesByCommit,
	summarizeAgentNoteIndex,
} from "../../src/agent/git-ai-note-index.js";
import {
	AGENT_NOTE_SCHEMA_VERSION,
	type AgentNote,
	makeAgentNote,
} from "../../src/agent/git-ai-note.js";

function makeNote(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234",
		intent: "Implement OAuth login.",
		evidence: ["test/auth/oauth.test.ts"],
		followUps: [],
		provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-index", () => {
	describe("indexAgentNotesByCommit", () => {
		it("returns an empty index for an empty input", () => {
			const index = indexAgentNotesByCommit([]);
			expect(index.byCommit.size).toBe(0);
			expect(index.dropped).toEqual([]);
		});

		it("indexes a single-note-per-commit list with lowercase keys", () => {
			const a = makeNote({ commitSha: "ABC1234" });
			const b = makeNote({ commitSha: "DEF5678", intent: "Add logout." });
			const index = indexAgentNotesByCommit([a, b]);
			expect(index.byCommit.size).toBe(2);
			expect(index.byCommit.get("abc1234")?.commitSha).toBe("ABC1234");
			expect(index.byCommit.get("def5678")?.commitSha).toBe("DEF5678");
		});

		it("normalizes a single note through mergeAgentNotes rules", () => {
			const raw = makeNote({
				commitSha: "ABC1234",
				evidence: ["proof A", "  "],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "  claude-sonnet-4-6  ",
				},
				version: 0,
			});
			const index = indexAgentNotesByCommit([raw]);
			expect(index.byCommit.get("abc1234")).toEqual({
				...raw,
				version: AGENT_NOTE_SCHEMA_VERSION,
				evidence: ["proof A"],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-sonnet-4-6",
				},
			});
		});

		it("merges notes that target the same commit", () => {
			const a = makeNote({
				commitSha: "abc1234",
				intent: "Add login.",
				evidence: ["test/login.test.ts"],
			});
			const b = makeNote({
				commitSha: "abc1234",
				intent: "Add logout.",
				evidence: ["test/logout.test.ts"],
			});
			const index = indexAgentNotesByCommit([a, b]);
			expect(index.byCommit.size).toBe(1);
			const merged = index.byCommit.get("abc1234");
			expect(merged?.intent).toBe("Add login. · Add logout.");
			expect(merged?.evidence).toEqual([
				"test/login.test.ts",
				"test/logout.test.ts",
			]);
		});

		it("treats case-only differences in commitSha as the same commit", () => {
			const a = makeNote({ commitSha: "ABC1234" });
			const b = makeNote({ commitSha: "abc1234" });
			const index = indexAgentNotesByCommit([a, b]);
			expect(index.byCommit.size).toBe(1);
			expect(index.dropped).toEqual([]);
		});

		it("normalizes single-note buckets through the merge helper", () => {
			// Blank evidence entries are stripped by mergeAgentNotes. The
			// indexer must apply that normalization even for single-note
			// buckets so the lookup payload doesn't differ from the multi-
			// note path.
			const note = makeNote({
				commitSha: "abc1234",
				evidence: ["test/login.test.ts", "", "   "],
			});
			const index = indexAgentNotesByCommit([note]);
			expect(index.byCommit.get("abc1234")?.evidence).toEqual([
				"test/login.test.ts",
			]);
		});

		it("treats surrounding whitespace in commitSha as the same commit", () => {
			const a = makeNote({ commitSha: " abc1234 " });
			const b = makeNote({ commitSha: "ABC1234" });
			const index = indexAgentNotesByCommit([a, b]);
			expect(index.byCommit.size).toBe(1);
			expect(index.dropped).toEqual([]);
		});
	});

	describe("findAgentNoteForCommit", () => {
		it("resolves the merged note for a known commit (case-insensitive query)", () => {
			const a = makeNote({ commitSha: "ABCDef1" });
			const index = indexAgentNotesByCommit([a]);
			expect(findAgentNoteForCommit(index, "ABCDEF1")?.intent).toBe(a.intent);
			expect(findAgentNoteForCommit(index, "abcdef1")?.intent).toBe(a.intent);
		});

		it("trims surrounding whitespace from the lookup sha", () => {
			const a = makeNote({ commitSha: " abcdef1 " });
			const index = indexAgentNotesByCommit([a]);
			expect(findAgentNoteForCommit(index, "abcdef1")?.intent).toBe(a.intent);
		});

		it("returns undefined for an unknown sha", () => {
			const index = indexAgentNotesByCommit([makeNote()]);
			expect(findAgentNoteForCommit(index, "ghost00")).toBeUndefined();
		});

		it("returns undefined for blank / non-string input", () => {
			const index = indexAgentNotesByCommit([makeNote()]);
			expect(findAgentNoteForCommit(index, "")).toBeUndefined();
			expect(
				findAgentNoteForCommit(index, undefined as unknown as string),
			).toBeUndefined();
			expect(
				findAgentNoteForCommit(index, 42 as unknown as string),
			).toBeUndefined();
		});
	});

	describe("filterAgentNoteIndex", () => {
		it("keeps only commits whose sha matches the predicate", () => {
			const a = makeNote({ commitSha: "aaa1234", intent: "Keep this one." });
			const b = makeNote({ commitSha: "bbb5678", intent: "Drop this one." });
			const index = indexAgentNotesByCommit([a, b]);
			const filtered = filterAgentNoteIndex(index, (sha) =>
				sha.startsWith("aaa"),
			);
			expect([...filtered.byCommit.keys()]).toEqual(["aaa1234"]);
		});

		it("preserves the dropped list across filtering", () => {
			const index: ReturnType<typeof indexAgentNotesByCommit> = {
				byCommit: new Map(),
				dropped: [makeNote()],
			};
			const filtered = filterAgentNoteIndex(index, () => true);
			expect(filtered.dropped).toEqual(index.dropped);
		});
	});

	describe("summarizeAgentNoteIndex", () => {
		it("returns commit + dropped counts", () => {
			const a = makeNote({ commitSha: "aaa1234" });
			const b = makeNote({ commitSha: "bbb5678" });
			const index = indexAgentNotesByCommit([a, b]);
			expect(summarizeAgentNoteIndex(index)).toEqual({
				commitCount: 2,
				droppedCount: 0,
			});
		});

		it("returns zeros for an empty index", () => {
			expect(
				summarizeAgentNoteIndex({ byCommit: new Map(), dropped: [] }),
			).toEqual({ commitCount: 0, droppedCount: 0 });
		});
	});
});

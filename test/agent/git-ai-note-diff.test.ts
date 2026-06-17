import { describe, expect, it } from "vitest";
import {
	type AgentNoteDiff,
	diffAgentNotes,
	summarizeAgentNoteDiff,
} from "../../src/agent/git-ai-note-diff.js";
import { type AgentNote, makeAgentNote } from "../../src/agent/git-ai-note.js";

function note(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234",
		intent: "Add OAuth login.",
		evidence: ["test/auth/oauth.test.ts"],
		followUps: [],
		provenance: {
			createdAt: "2026-06-15T18:00:00.000Z",
			modelId: "claude-opus-4-7",
		},
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-diff", () => {
	describe("diffAgentNotes", () => {
		it("returns unchanged: true when both notes are byte-equal", () => {
			const a = note();
			const b = note();
			const diff = diffAgentNotes(a, b);
			expect(diff.unchanged).toBe(true);
		});

		it("treats two undefined inputs as no-op", () => {
			expect(diffAgentNotes(undefined, undefined).unchanged).toBe(true);
		});

		it("surfaces every field as additions for a fresh note (before undefined)", () => {
			const after = note({ intent: "Brand new note." });
			const diff = diffAgentNotes(undefined, after);
			expect(diff.unchanged).toBe(false);
			expect(diff.intent).toEqual({
				before: undefined,
				after: "Brand new note.",
			});
			expect(diff.commitSha).toEqual({
				before: undefined,
				after: "abc1234",
			});
		});

		it("flags intent change", () => {
			const before = note({ intent: "Add login." });
			const after = note({ intent: "Add OAuth login." });
			const diff = diffAgentNotes(before, after);
			expect(diff.intent).toEqual({
				before: "Add login.",
				after: "Add OAuth login.",
			});
			expect(diff.unchanged).toBe(false);
		});

		it("flags commitSha and version changes", () => {
			const before = note({ commitSha: "aaa", version: 1 });
			const after = note({ commitSha: "bbb", version: 2 });
			const diff = diffAgentNotes(before, after);
			expect(diff.commitSha).toEqual({ before: "aaa", after: "bbb" });
			expect(diff.version).toEqual({ before: 1, after: 2 });
		});

		it("flags evidence added and removed", () => {
			const before = note({ evidence: ["a.test.ts", "b.test.ts"] });
			const after = note({ evidence: ["b.test.ts", "c.test.ts"] });
			const diff = diffAgentNotes(before, after);
			expect(diff.evidence.added).toEqual(["c.test.ts"]);
			expect(diff.evidence.removed).toEqual(["a.test.ts"]);
		});

		it("preserves first-seen order in evidence add/remove lists", () => {
			const before = note({ evidence: ["a", "b", "c"] });
			const after = note({ evidence: ["d", "e", "c"] });
			const diff = diffAgentNotes(before, after);
			expect(diff.evidence.added).toEqual(["d", "e"]);
			expect(diff.evidence.removed).toEqual(["a", "b"]);
		});

		it("counts duplicate evidence removals and additions", () => {
			const before = note({ evidence: ["same", "same", "keep"] });
			const after = note({ evidence: ["same", "keep", "same", "same"] });
			const diff = diffAgentNotes(before, after);
			expect(diff.evidence.added).toEqual(["same"]);
			expect(diff.evidence.removed).toEqual([]);
		});

		it("counts duplicate evidence removals when copies are dropped", () => {
			const before = note({ evidence: ["same", "same", "keep"] });
			const after = note({ evidence: ["same", "keep"] });
			const diff = diffAgentNotes(before, after);
			expect(diff.evidence.added).toEqual([]);
			expect(diff.evidence.removed).toEqual(["same"]);
		});

		it("flags follow-ups added, removed, and changed by title identity", () => {
			const before = note({
				followUps: [
					{ title: "ship doc", severity: "info" },
					{ title: "rotate key", severity: "risk", detail: "old detail" },
				],
			});
			const after = note({
				followUps: [
					// Title kept, detail edited → changed
					{ title: "rotate key", severity: "risk", detail: "new detail" },
					// New title → added
					{ title: "audit telemetry", severity: "watch" },
				],
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.removed.map((f) => f.title)).toEqual(["ship doc"]);
			expect(diff.followUps.added.map((f) => f.title)).toEqual([
				"audit telemetry",
			]);
			expect(diff.followUps.changed.map((f) => f.title)).toEqual([
				"rotate key",
			]);
			expect(diff.followUps.changed[0]?.before?.detail).toBe("old detail");
			expect(diff.followUps.changed[0]?.after?.detail).toBe("new detail");
		});

		it("doesn't flag identical follow-ups as changed even if reordered", () => {
			const before = note({
				followUps: [
					{ title: "a", severity: "info" },
					{ title: "b", severity: "watch" },
				],
			});
			const after = note({
				followUps: [
					{ title: "b", severity: "watch" },
					{ title: "a", severity: "info" },
				],
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([]);
			expect(diff.followUps.changed).toEqual([]);
			expect(diff.unchanged).toBe(true);
		});

		it("handles duplicate follow-up titles without collapsing removals or changes", () => {
			const before = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [
					{ title: "dup", detail: "keep" },
					{ title: "dup", detail: "old" },
					{ title: "dup", detail: "remove" },
				],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const after = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [
					{ title: "dup", detail: "keep" },
					{ title: "dup", detail: "new" },
				],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([
				{ title: "dup", detail: "remove", severity: "info" },
			]);
			expect(diff.followUps.changed).toEqual([
				{
					title: "dup",
					before: { title: "dup", detail: "old", severity: "info" },
					after: { title: "dup", detail: "new", severity: "info" },
				},
			]);
		});

		it("pairs duplicate-title follow-up changes by content when unmatched entries are reordered", () => {
			const before = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [
					{ title: "dup", detail: "keep" },
					{ title: "dup", detail: "remove" },
					{ title: "dup", detail: "old" },
				],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const after = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [
					{ title: "dup", detail: "keep" },
					{ title: "dup", detail: "new" },
				],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([
				{ title: "dup", detail: "remove", severity: "info" },
			]);
			expect(diff.followUps.changed).toEqual([
				{
					title: "dup",
					before: { title: "dup", detail: "old", severity: "info" },
					after: { title: "dup", detail: "new", severity: "info" },
				},
			]);
		});

		it("treats missing severity as 'info' (matches makeAgentNote's default)", () => {
			// A parsed note keeps severity absent; makeAgentNote
			// normalizes the same field to "info". Diffing the two
			// must not flag a spurious changed entry.
			const parsed = note({ followUps: [{ title: "x" }] });
			const built = note({ followUps: [{ title: "x", severity: "info" }] });
			const diff = diffAgentNotes(parsed, built);
			expect(diff.followUps.changed).toEqual([]);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([]);
		});

		it("treats blank detail the same as an omitted detail", () => {
			// Parsed notes can keep whitespace-only detail while
			// makeAgentNote trims the same value away.
			const parsed = note({ followUps: [{ title: "x", detail: "   " }] });
			const built = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [{ title: "x", detail: "" }],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const diff = diffAgentNotes(parsed, built);
			expect(diff.followUps.changed).toEqual([]);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([]);
		});

		it("treats surrounding title whitespace the same as a trimmed title", () => {
			const parsed = note({ followUps: [{ title: "  x  " }] });
			const built = note({ followUps: [{ title: "x", severity: "info" }] });
			const diff = diffAgentNotes(parsed, built);
			expect(diff.followUps.changed).toEqual([]);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.removed).toEqual([]);
		});

		it("handles duplicate follow-up titles in the same note (multi-map accounting)", () => {
			// Map-by-title would collapse duplicates; the diff must
			// still surface accurate add / remove counts when the same
			// title appears multiple times in either list.
			const before = note({
				followUps: [
					{ title: "rotate key", severity: "risk", detail: "first" },
					{ title: "rotate key", severity: "risk", detail: "second" },
				],
			});
			const after = note({
				followUps: [{ title: "rotate key", severity: "risk", detail: "first" }],
			});
			const diff = diffAgentNotes(before, after);
			// One "rotate key" was dropped — surface it as removed.
			expect(diff.followUps.removed.map((f) => f.detail)).toEqual(["second"]);
			expect(diff.followUps.added).toEqual([]);
			expect(diff.followUps.changed).toEqual([]);
		});

		it("counts duplicate-title additions correctly", () => {
			const before = note({
				followUps: [{ title: "ship doc" }],
			});
			const after = note({
				followUps: [
					{ title: "ship doc" },
					{ title: "ship doc", detail: "second instance" },
				],
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.added.map((f) => f.detail)).toEqual([
				"second instance",
			]);
			expect(diff.followUps.removed).toEqual([]);
		});

		it("treats duplicate-title shrink without exact matches as add plus removals", () => {
			const before = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [
					{ title: "dup", detail: "old-a" },
					{ title: "dup", detail: "old-b" },
				],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const after = makeAgentNote({
				commitSha: "abc1234",
				intent: "Add OAuth login.",
				evidence: ["test/auth/oauth.test.ts"],
				followUps: [{ title: "dup", detail: "new-only" }],
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.followUps.changed).toEqual([]);
			expect(diff.followUps.added).toEqual([
				{ title: "dup", detail: "new-only", severity: "info" },
			]);
			expect(diff.followUps.removed).toEqual([
				{ title: "dup", detail: "old-a", severity: "info" },
				{ title: "dup", detail: "old-b", severity: "info" },
			]);
		});

		it("diffs every provenance field independently", () => {
			const before = note({
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
					sessionId: "session-1",
				},
			});
			const after = note({
				provenance: {
					createdAt: "2026-06-15T19:00:00.000Z",
					modelId: "claude-sonnet-4-6",
					sessionId: "session-1",
					agentVersion: "1.2.3",
				},
			});
			const diff = diffAgentNotes(before, after);
			expect(diff.provenance.createdAt).toEqual({
				before: "2026-06-15T18:00:00.000Z",
				after: "2026-06-15T19:00:00.000Z",
			});
			expect(diff.provenance.modelId).toEqual({
				before: "claude-opus-4-7",
				after: "claude-sonnet-4-6",
			});
			expect(diff.provenance.sessionId).toBeUndefined();
			expect(diff.provenance.agentVersion).toEqual({
				before: undefined,
				after: "1.2.3",
			});
		});
	});

	describe("summarizeAgentNoteDiff", () => {
		it("returns 'no changes' for a no-op diff", () => {
			expect(summarizeAgentNoteDiff(diffAgentNotes(note(), note()))).toBe(
				"no changes",
			);
		});

		it("lists every category that changed", () => {
			const before = note({
				evidence: ["a.test.ts"],
				followUps: [{ title: "old", severity: "info" }],
			});
			const after = note({
				intent: "Updated intent.",
				evidence: ["b.test.ts"],
				followUps: [{ title: "new", severity: "watch" }],
				provenance: {
					createdAt: "2026-06-15T19:00:00.000Z",
					modelId: "claude-sonnet-4-6",
				},
			});
			const summary = summarizeAgentNoteDiff(diffAgentNotes(before, after));
			expect(summary).toContain("intent changed");
			expect(summary).toContain("1 evidence entry added");
			expect(summary).toContain("1 evidence entry removed");
			expect(summary).toContain("1 follow-up added");
			expect(summary).toContain("1 follow-up removed");
			expect(summary).toContain("provenance:");
			expect(summary).toContain("createdAt");
			expect(summary).toContain("modelId");
		});

		it("pluralizes counts (2 follow-ups added, 2 evidence entries)", () => {
			const before = note({
				evidence: ["a"],
				followUps: [{ title: "x" }],
			});
			const after = note({
				evidence: ["a", "b", "c"],
				followUps: [{ title: "x" }, { title: "y" }, { title: "z" }],
			});
			const summary = summarizeAgentNoteDiff(diffAgentNotes(before, after));
			expect(summary).toContain("2 evidence entries added");
			expect(summary).toContain("2 follow-ups added");
		});

		it("emits the version-bump marker when version increments", () => {
			const before = note({ version: 1 });
			const after = note({ version: 2 });
			const diff: AgentNoteDiff = diffAgentNotes(before, after);
			expect(summarizeAgentNoteDiff(diff)).toContain("version bumped");
		});
	});
});

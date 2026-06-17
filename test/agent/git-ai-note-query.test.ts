import { describe, expect, it } from "vitest";
import {
	countAgentNotes,
	groupAgentNotesByCommit,
	queryAgentNotes,
} from "../../src/agent/git-ai-note-query.js";
import { type AgentNote, makeAgentNote } from "../../src/agent/git-ai-note.js";

function note(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234",
		intent: "Add OAuth login.",
		evidence: ["test/auth/oauth.test.ts"],
		followUps: [],
		provenance: {
			createdAt: "2026-06-15T18:00:00.000Z",
		},
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-query", () => {
	describe("queryAgentNotes", () => {
		it("returns the input unchanged for an empty query", () => {
			const a = note();
			const b = note({ commitSha: "def5678" });
			expect(queryAgentNotes([a, b], {})).toEqual([a, b]);
		});

		it("filters by lowercase commit SHA prefix", () => {
			const a = note({ commitSha: "ABCdef1" });
			const b = note({ commitSha: "ffffffff" });
			expect(
				queryAgentNotes([a, b], { commitShaPrefix: "abc" }).map(
					(n) => n.commitSha,
				),
			).toEqual(["ABCdef1"]);
		});

		it("trims commit SHA prefix and stored SHAs before matching", () => {
			// Without trimming, "  abc" never matches notes that bucket
			// under "abc" via groupAgentNotesByCommit (which trims).
			const a = note({ commitSha: " ABCdef1 " });
			const b = note({ commitSha: "ffffffff" });
			expect(
				queryAgentNotes([a, b], { commitShaPrefix: "  abc " }).length,
			).toBe(1);
		});

		it("treats blank provenance filters as wildcards", () => {
			// makeAgentNote leaves modelId/sessionId/agentVersion as
			// undefined when the caller doesn't set them. Without the
			// wildcard, a cleared form field would drop every note.
			const a = note();
			expect(
				queryAgentNotes([a], {
					modelId: "",
					sessionId: "",
					agentVersion: "",
				}).length,
			).toBe(1);
		});

		it("treats whitespace-only filters as wildcards", () => {
			// Without the trim guard, "   " untilIso compares as
			// `createdAt > "   "` and rejects every ISO timestamp; "   "
			// modelId fails the exact-match against undefined provenance;
			// whitespace-only substring filters would also reject typical
			// intents / evidence paths because they are trimmed.
			const a = note();
			expect(
				queryAgentNotes([a], {
					sinceIso: "   ",
					untilIso: "   ",
					modelId: "   ",
					sessionId: "   ",
					agentVersion: "   ",
					intentContains: "   ",
					evidenceContains: "   ",
				}).length,
			).toBe(1);
		});

		it("treats blank sinceIso / untilIso as wildcards", () => {
			// Real ISO timestamps compare greater than "" so an empty
			// untilIso would otherwise reject every note. Both bounds
			// should fall through to wildcard when blank.
			const a = note({
				provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
			});
			expect(queryAgentNotes([a], { sinceIso: "", untilIso: "" }).length).toBe(
				1,
			);
		});

		it("filters by case-insensitive intent substring", () => {
			const a = note({ intent: "Add OAuth login." });
			const b = note({ intent: "Refactor logout." });
			expect(
				queryAgentNotes([a, b], { intentContains: "OAUTH" }).map(
					(n) => n.intent,
				),
			).toEqual(["Add OAuth login."]);
		});

		it("filters by case-insensitive evidence fragment", () => {
			const a = note({ evidence: ["test/auth/oauth.test.ts"] });
			const b = note({ evidence: ["test/dashboard/widget.test.ts"] });
			expect(
				queryAgentNotes([a, b], { evidenceContains: "OAUTH" }).map(
					(n) => n.evidence,
				),
			).toEqual([["test/auth/oauth.test.ts"]]);
		});

		it("filters by follow-up severity", () => {
			const a = note({
				followUps: [{ title: "ship doc", severity: "info" }],
			});
			const b = note({
				followUps: [{ title: "token rotation risk", severity: "risk" }],
			});
			expect(
				queryAgentNotes([a, b], { hasFollowUpSeverity: "risk" }).length,
			).toBe(1);
		});

		it("treats missing follow-up severity as info", () => {
			const parsed: AgentNote = {
				...note(),
				followUps: [{ title: "ship doc" }],
			};
			expect(
				queryAgentNotes([parsed], { hasFollowUpSeverity: "info" }).length,
			).toBe(1);
		});

		it("filters by createdAt window (inclusive bounds)", () => {
			const early = note({
				provenance: { createdAt: "2026-06-01T00:00:00.000Z" },
			});
			const mid = note({
				provenance: { createdAt: "2026-06-10T00:00:00.000Z" },
			});
			const late = note({
				provenance: { createdAt: "2026-06-20T00:00:00.000Z" },
			});
			expect(
				queryAgentNotes([early, mid, late], {
					sinceIso: "2026-06-05T00:00:00.000Z",
					untilIso: "2026-06-15T00:00:00.000Z",
				}),
			).toEqual([mid]);
		});

		it("filters by modelId exact match", () => {
			const a = note({
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-opus-4-7",
				},
			});
			const b = note({
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					modelId: "claude-sonnet-4-6",
				},
			});
			expect(
				queryAgentNotes([a, b], { modelId: "claude-opus-4-7" }).length,
			).toBe(1);
		});

		it("filters by sessionId exact match", () => {
			const a = note({
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					sessionId: "sess-1",
				},
			});
			const b = note({
				provenance: {
					createdAt: "2026-06-15T18:00:00.000Z",
					sessionId: "sess-2",
				},
			});
			expect(queryAgentNotes([a, b], { sessionId: "sess-1" }).length).toBe(1);
		});

		it("AND-composes predicates: every supplied filter must match", () => {
			const a = note({ intent: "Add OAuth login.", commitSha: "abc1234" });
			const b = note({ intent: "Refactor login.", commitSha: "abcdef0" });
			expect(
				queryAgentNotes([a, b], {
					intentContains: "oauth",
					commitShaPrefix: "abc",
				}).length,
			).toBe(1);
		});

		it("preserves input order in the output", () => {
			const first = note({ commitSha: "aaaaaaa" });
			const second = note({ commitSha: "abc0000" });
			const third = note({ commitSha: "abc1111" });
			expect(
				queryAgentNotes([first, second, third], {
					commitShaPrefix: "abc",
				}).map((n) => n.commitSha),
			).toEqual(["abc0000", "abc1111"]);
		});
	});

	describe("countAgentNotes", () => {
		it("returns the number of matches without exposing the array", () => {
			const a = note({ commitSha: "abc1234" });
			const b = note({ commitSha: "def5678" });
			expect(countAgentNotes([a, b], { commitShaPrefix: "abc" })).toBe(1);
		});

		it("returns 0 when nothing matches", () => {
			expect(countAgentNotes([note()], { commitShaPrefix: "ghost" })).toBe(0);
		});
	});

	describe("groupAgentNotesByCommit", () => {
		it("groups matches by lowercase commit SHA", () => {
			const a = note({ commitSha: "ABC1234" });
			const b = note({ commitSha: "abc1234", intent: "Second note." });
			const c = note({ commitSha: "DEF5678" });
			const grouped = groupAgentNotesByCommit([a, b, c]);
			expect(grouped.size).toBe(2);
			expect(grouped.get("abc1234")?.length).toBe(2);
			expect(grouped.get("def5678")?.length).toBe(1);
		});

		it("preserves input order within each bucket", () => {
			const first = note({ commitSha: "abc", intent: "First." });
			const second = note({ commitSha: "abc", intent: "Second." });
			const grouped = groupAgentNotesByCommit([first, second]);
			expect(grouped.get("abc")?.map((n) => n.intent)).toEqual([
				"First.",
				"Second.",
			]);
		});

		it("applies the query before grouping", () => {
			const match = note({ commitSha: "abc", intent: "OAuth login." });
			const skip = note({ commitSha: "abc", intent: "Logout." });
			const grouped = groupAgentNotesByCommit([match, skip], {
				intentContains: "oauth",
			});
			expect(grouped.size).toBe(1);
			expect(grouped.get("abc")?.length).toBe(1);
		});

		it("returns an empty map when nothing matches", () => {
			expect(
				groupAgentNotesByCommit([note()], { commitShaPrefix: "ghost" }).size,
			).toBe(0);
		});

		it("trims and lowercases the bucket key so case + whitespace variants merge", () => {
			const a = note({ commitSha: " ABC1234 " });
			const b = note({ commitSha: "abc1234" });
			const grouped = groupAgentNotesByCommit([a, b]);
			expect(grouped.size).toBe(1);
			expect(grouped.get("abc1234")?.length).toBe(2);
		});
	});
});

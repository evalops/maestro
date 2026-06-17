import { describe, expect, it } from "vitest";
import {
	canMergeAgentNotes,
	mergeAgentNotes,
} from "../../src/agent/git-ai-note-merge.js";
import { type AgentNote, makeAgentNote } from "../../src/agent/git-ai-note.js";

function makeNote(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234",
		intent: "Implement OAuth login.",
		evidence: ["test/auth/oauth.test.ts: 12/12 pass"],
		followUps: [],
		provenance: {
			createdAt: "2026-06-15T18:00:00.000Z",
		},
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-merge", () => {
	describe("mergeAgentNotes", () => {
		it("throws on an empty list", () => {
			expect(() => mergeAgentNotes([])).toThrow(/non-empty/);
		});

		it("treats commit SHAs that differ only in casing as the same revision", () => {
			const merged = mergeAgentNotes([
				makeNote({ commitSha: "ABC1234" }),
				makeNote({ commitSha: "abc1234" }),
			]);
			expect(merged.commitSha).toBe("ABC1234");
		});

		it("treats commit SHAs with surrounding whitespace as the same revision", () => {
			const merged = mergeAgentNotes([
				makeNote({ commitSha: " abc1234 " }),
				makeNote({ commitSha: "ABC1234" }),
			]);
			expect(merged.commitSha).toBe(" abc1234 ");
		});

		it("throws when notes target different commits", () => {
			expect(() =>
				mergeAgentNotes([
					makeNote({ commitSha: "abc1234" }),
					makeNote({ commitSha: "def5678" }),
				]),
			).toThrow(/every note must target the same commit/);
		});

		it("returns a single note unchanged when only one is supplied (intent + evidence preserved)", () => {
			const note = makeNote({
				intent: "Solo intent.",
				evidence: ["proof A", "proof B"],
			});
			const merged = mergeAgentNotes([note]);
			expect(merged.commitSha).toBe(note.commitSha);
			expect(merged.intent).toBe("Solo intent.");
			expect(merged.evidence).toEqual(["proof A", "proof B"]);
		});

		it("concatenates intents with the default separator", () => {
			const merged = mergeAgentNotes([
				makeNote({ intent: "Add login." }),
				makeNote({ intent: "Add logout." }),
			]);
			expect(merged.intent).toBe("Add login. · Add logout.");
		});

		it("respects a custom intent separator", () => {
			const merged = mergeAgentNotes(
				[makeNote({ intent: "Step 1." }), makeNote({ intent: "Step 2." })],
				{ intentSeparator: "\n---\n" },
			);
			expect(merged.intent).toBe("Step 1.\n---\nStep 2.");
		});

		it("dedupes identical intents (case + whitespace insensitive)", () => {
			const merged = mergeAgentNotes([
				makeNote({ intent: "Add  Login." }),
				makeNote({ intent: "add login." }),
				makeNote({ intent: "Add logout." }),
			]);
			expect(merged.intent).toBe("Add  Login. · Add logout.");
		});

		it("dedupes evidence in first-seen order", () => {
			const merged = mergeAgentNotes([
				makeNote({ evidence: ["test A", "test B"] }),
				makeNote({ evidence: ["test B", "test C"] }),
			]);
			expect(merged.evidence).toEqual(["test A", "test B", "test C"]);
		});

		it("dedupes follow-ups by title in first-seen order, preserves severity/detail", () => {
			const merged = mergeAgentNotes([
				makeNote({
					followUps: [
						{
							title: "audit telemetry",
							severity: "watch",
							detail: "from agent A",
						},
					],
				}),
				makeNote({
					followUps: [
						{ title: "audit telemetry", severity: "risk" },
						{ title: "write migration", detail: "from agent B" },
					],
				}),
			]);
			// First-seen wins (the watch + detail-from-A version).
			expect(merged.followUps).toEqual([
				{
					title: "audit telemetry",
					severity: "watch",
					detail: "from agent A",
				},
				{ title: "write migration", detail: "from agent B" },
			]);
		});

		it("takes the latest provenance.createdAt", () => {
			const merged = mergeAgentNotes([
				makeNote({
					provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
				}),
				makeNote({
					provenance: { createdAt: "2026-06-15T19:00:00.000Z" },
				}),
				makeNote({
					provenance: { createdAt: "2026-06-15T18:30:00.000Z" },
				}),
			]);
			expect(merged.provenance.createdAt).toBe("2026-06-15T19:00:00.000Z");
		});

		it("preserves the most-set provenance model/session/version fields (last-wins)", () => {
			const merged = mergeAgentNotes([
				makeNote({
					provenance: {
						createdAt: "2026-06-15T18:00:00.000Z",
						modelId: "claude-opus-4-7",
						sessionId: "session-a",
					},
				}),
				makeNote({
					provenance: {
						createdAt: "2026-06-15T19:00:00.000Z",
						modelId: "claude-sonnet-4-6",
						agentVersion: "0.42.0",
					},
				}),
			]);
			expect(merged.provenance.modelId).toBe("claude-sonnet-4-6");
			expect(merged.provenance.sessionId).toBe("session-a");
			expect(merged.provenance.agentVersion).toBe("0.42.0");
		});

		it("ignores whitespace-only provenance fields when picking last non-empty values", () => {
			const merged = mergeAgentNotes([
				makeNote({
					provenance: {
						createdAt: "2026-06-15T18:00:00.000Z",
						modelId: "claude-sonnet-4-6",
						sessionId: "session-a",
						agentVersion: "0.42.0",
					},
				}),
				makeNote({
					provenance: {
						createdAt: "2026-06-15T19:00:00.000Z",
						modelId: "   ",
						sessionId: "\t",
						agentVersion: "  ",
					},
				}),
			]);
			expect(merged.provenance.modelId).toBe("claude-sonnet-4-6");
			expect(merged.provenance.sessionId).toBe("session-a");
			expect(merged.provenance.agentVersion).toBe("0.42.0");
		});

		it("uses the higher of the input versions", () => {
			const merged = mergeAgentNotes([
				{ ...makeNote(), version: 1 },
				{ ...makeNote(), version: 2 },
			]);
			expect(merged.version).toBe(2);
		});

		it("drops blank intents but doesn't break the separator math", () => {
			const merged = mergeAgentNotes([
				makeNote({ intent: "" }),
				makeNote({ intent: "Add login." }),
				makeNote({ intent: "   " }),
			]);
			expect(merged.intent).toBe("Add login.");
		});

		it("drops blank evidence entries on merge", () => {
			const merged = mergeAgentNotes([
				makeNote({ evidence: ["proof A", "  "] }),
				makeNote({ evidence: ["proof B"] }),
			]);
			expect(merged.evidence).toEqual(["proof A", "proof B"]);
		});
	});

	describe("canMergeAgentNotes", () => {
		it("is false for an empty list", () => {
			expect(canMergeAgentNotes([])).toBe(false);
		});

		it("is true when every note targets the same commit", () => {
			expect(
				canMergeAgentNotes([
					makeNote({ commitSha: "abc1234" }),
					makeNote({ commitSha: "abc1234" }),
				]),
			).toBe(true);
		});

		it("is true when commit SHAs match case-insensitively", () => {
			expect(
				canMergeAgentNotes([
					makeNote({ commitSha: "ABC1234" }),
					makeNote({ commitSha: "abc1234" }),
				]),
			).toBe(true);
		});

		it("is true when commit SHAs only differ by surrounding whitespace", () => {
			expect(
				canMergeAgentNotes([
					makeNote({ commitSha: " abc1234 " }),
					makeNote({ commitSha: "ABC1234" }),
				]),
			).toBe(true);
		});

		it("is false when commits differ", () => {
			expect(
				canMergeAgentNotes([
					makeNote({ commitSha: "abc1234" }),
					makeNote({ commitSha: "def5678" }),
				]),
			).toBe(false);
		});
	});
});

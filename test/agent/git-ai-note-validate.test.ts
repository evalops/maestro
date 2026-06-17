import { describe, expect, it } from "vitest";
import {
	partitionValidAgentNotes,
	validateAgentNote,
} from "../../src/agent/git-ai-note-validate.js";
import { type AgentNote, makeAgentNote } from "../../src/agent/git-ai-note.js";

function makeNote(overrides: Partial<AgentNote> = {}): AgentNote {
	const base = makeAgentNote({
		commitSha: "abc1234",
		intent: "Implement OAuth login.",
		evidence: ["test/auth/oauth.test.ts: 12/12 pass"],
		followUps: [],
		provenance: { createdAt: "2026-06-15T18:00:00.000Z" },
	});
	return { ...base, ...overrides };
}

describe("agent/git-ai-note-validate", () => {
	describe("validateAgentNote", () => {
		it("returns ok for a well-formed note", () => {
			expect(validateAgentNote(makeNote())).toEqual({ ok: true });
		});

		it("rejects intents shorter than the configured minimum", () => {
			const result = validateAgentNote(makeNote({ intent: "fix" }));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/intent must be at least 8/);
			}
		});

		it("uses the custom minIntentLength", () => {
			const result = validateAgentNote(makeNote({ intent: "abc" }), {
				minIntentLength: 2,
			});
			expect(result.ok).toBe(true);
		});

		it("requires at least one evidence entry by default", () => {
			const result = validateAgentNote(makeNote({ evidence: [] }));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/evidence must include/);
			}
		});

		it("skips the evidence check when requireEvidence=false", () => {
			expect(
				validateAgentNote(makeNote({ evidence: [] }), {
					requireEvidence: false,
				}).ok,
			).toBe(true);
		});

		it("flags blank evidence entries even when others are present", () => {
			const result = validateAgentNote(
				makeNote({ evidence: ["good entry", "   ", ""] }),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/2 blank entries/);
			}
		});

		it("flags non-string evidence entries without throwing", () => {
			const result = validateAgentNote(
				makeNote({ evidence: [null as unknown as string] }),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/1 blank entry/);
			}
		});

		it("flags risk-severity follow-ups missing a detail", () => {
			const result = validateAgentNote(
				makeNote({
					followUps: [
						{ title: "audit telemetry", severity: "risk" },
						{ title: "monitor", severity: "watch" }, // ok without detail
					],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/risk severity but has no detail/,
				);
				expect(
					result.reasons.filter((r) => r.includes("no detail")).length,
				).toBe(1);
			}
		});

		it("accepts a risk follow-up with detail", () => {
			expect(
				validateAgentNote(
					makeNote({
						followUps: [
							{
								title: "audit telemetry",
								severity: "risk",
								detail: "schedule before SOC2 review",
							},
						],
					}),
				).ok,
			).toBe(true);
		});

		it("flags follow-ups missing a title", () => {
			const result = validateAgentNote(
				makeNote({ followUps: [{ title: "  " }] }),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/is missing a title/);
			}
		});

		it("flags non-string follow-up titles without throwing", () => {
			const result = validateAgentNote(
				makeNote({
					followUps: [{ title: undefined as unknown as string }],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/is missing a title/);
			}
		});

		it("flags null follow-up entries without throwing", () => {
			const result = validateAgentNote(
				makeNote({
					followUps: [null as unknown as AgentNote["followUps"][number]],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(/must be an object/);
			}
		});

		it("treats non-string risk details as missing detail", () => {
			const result = validateAgentNote(
				makeNote({
					followUps: [
						{
							title: "audit telemetry",
							severity: "risk",
							detail: 0 as unknown as string,
						},
					],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/risk severity but has no detail/,
				);
			}
		});

		it("rejects commitSha values that aren't 7–64 hex chars", () => {
			expect(validateAgentNote(makeNote({ commitSha: "abc" })).ok).toBe(false);
			expect(validateAgentNote(makeNote({ commitSha: "xyz1234" })).ok).toBe(
				false,
			);
			expect(
				validateAgentNote(makeNote({ commitSha: "a".repeat(65) })).ok,
			).toBe(false);
		});

		it("accepts 40-char, 64-char, and mixed-case shas", () => {
			expect(
				validateAgentNote(makeNote({ commitSha: "a".repeat(40) })).ok,
			).toBe(true);
			expect(
				validateAgentNote(makeNote({ commitSha: "b".repeat(64) })).ok,
			).toBe(true);
			expect(
				validateAgentNote(makeNote({ commitSha: "ABC1234defghABC1234defABC" }))
					.ok,
			).toBe(false); // contains 'g', 'h' — not hex
			expect(
				validateAgentNote(makeNote({ commitSha: "ABc12345DEf67890" })).ok,
			).toBe(true);
		});

		it("collects every failing reason in one pass", () => {
			const result = validateAgentNote(
				makeNote({
					intent: "fix",
					evidence: [],
					commitSha: "bad",
					followUps: [{ title: "x", severity: "risk" }],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.length).toBeGreaterThanOrEqual(4);
			}
		});

		it("throws on a negative minIntentLength", () => {
			expect(() =>
				validateAgentNote(makeNote(), { minIntentLength: -1 }),
			).toThrow(/non-negative integer/);
		});

		it("flags blank provenance.createdAt", () => {
			const result = validateAgentNote({
				...makeNote(),
				provenance: { createdAt: "  " },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/provenance\.createdAt is required/,
				);
			}
		});
	});

	describe("partitionValidAgentNotes", () => {
		it("splits valid + invalid lists", () => {
			const good = makeNote({ commitSha: "abc1234" });
			const bad = makeNote({ commitSha: "x", intent: "fix" });
			const out = partitionValidAgentNotes([good, bad]);
			expect(out.valid.map((n) => n.commitSha)).toEqual(["abc1234"]);
			expect(out.invalid[0]?.reasons.length).toBeGreaterThan(0);
		});

		it("returns empty lists for an empty input", () => {
			expect(partitionValidAgentNotes([])).toEqual({ valid: [], invalid: [] });
		});

		it("respects validator options across the partition", () => {
			const note = makeNote({ evidence: [] });
			expect(
				partitionValidAgentNotes([note], { requireEvidence: false }).valid,
			).toHaveLength(1);
			expect(
				partitionValidAgentNotes([note], { requireEvidence: true }).invalid,
			).toHaveLength(1);
		});
	});
});

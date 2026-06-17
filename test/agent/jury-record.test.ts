import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUDIT_AREAS,
	type FindingSeverity,
	JURY_RECORD_VERSION,
	type JurorVerdict,
	appendPriorArt,
	appendPriorArtDeep,
	appendVerdict,
	makeFindingRecord,
	modelFamiliesAtPass,
	summarizeFindings,
	synthesisRuleFor,
	synthesizePass1,
	synthesizePass8,
	withState,
} from "../../src/agent/jury-record.js";

function makeProposal(
	overrides: Partial<Parameters<typeof makeFindingRecord>[0]> = {},
) {
	return {
		id: "F-1",
		area: "ssrf",
		title: "SSRF in webhook fetcher",
		proposedSeverity: "high" as FindingSeverity,
		location: {
			file: "src/webhooks/fetcher.ts",
			line: 42,
			commitSha: "abc1234",
		},
		codeQuote: "fetch(url, { method: 'GET' });",
		proposedAt: "2026-06-15T18:00:00.000Z",
		...overrides,
	};
}

function makeVerdict(overrides: Partial<JurorVerdict>): JurorVerdict {
	return {
		pass: 1,
		jurorId: "juror-a",
		modelFamily: "anthropic",
		classification: "CONFIRMED",
		stampedAt: "2026-06-15T18:30:00.000Z",
		...overrides,
	};
}

describe("agent/jury-record", () => {
	describe("makeFindingRecord", () => {
		it("returns a record at version + state=proposed", () => {
			const r = makeFindingRecord(makeProposal());
			expect(r.version).toBe(JURY_RECORD_VERSION);
			expect(r.state).toBe("proposed");
			expect(r.verdicts).toEqual([]);
			expect(r.priorArt).toEqual([]);
			expect(r.priorArtDeep).toEqual([]);
		});

		it("throws on missing id / area / title", () => {
			expect(() => makeFindingRecord(makeProposal({ id: "" }))).toThrow(
				/finding id is required/,
			);
			expect(() => makeFindingRecord(makeProposal({ area: "  " }))).toThrow(
				/finding area is required/,
			);
			expect(() => makeFindingRecord(makeProposal({ title: "" }))).toThrow(
				/finding title is required/,
			);
		});

		it("throws on invalid line numbers", () => {
			expect(() =>
				makeFindingRecord(
					makeProposal({
						location: {
							file: "x.ts",
							line: 0,
							commitSha: "abc1234",
						},
					}),
				),
			).toThrow(/location.line must be >= 1/);
		});
	});

	describe("appendVerdict / appendPriorArt", () => {
		it("appends verdicts in order without mutating the input", () => {
			const before = makeFindingRecord(makeProposal());
			const after = appendVerdict(before, makeVerdict({}));
			expect(after.verdicts).toHaveLength(1);
			expect(before.verdicts).toHaveLength(0);
			expect(after.updatedAt).toBe("2026-06-15T18:30:00.000Z");
		});

		it("appends prior art and deep prior art separately", () => {
			let r = makeFindingRecord(makeProposal());
			r = appendPriorArt(r, {
				id: "CVE-2024-0001",
				kind: "cve",
				summary: "Similar SSRF",
			});
			r = appendPriorArtDeep(r, {
				id: "https://example.com/talk",
				kind: "talk",
				summary: "DEF CON talk on SSRF",
			});
			expect(r.priorArt).toHaveLength(1);
			expect(r.priorArtDeep).toHaveLength(1);
		});
	});

	describe("modelFamiliesAtPass", () => {
		it("returns the set of families that voted on the given pass", () => {
			let r = makeFindingRecord(makeProposal());
			r = appendVerdict(r, makeVerdict({ modelFamily: "anthropic", pass: 1 }));
			r = appendVerdict(r, makeVerdict({ modelFamily: "openai", pass: 1 }));
			r = appendVerdict(r, makeVerdict({ modelFamily: "google", pass: 2 }));

			expect(modelFamiliesAtPass(r, 1)).toEqual(
				new Set(["anthropic", "openai"]),
			);
			expect(modelFamiliesAtPass(r, 2)).toEqual(new Set(["google"]));
			expect(modelFamiliesAtPass(r, 8)).toEqual(new Set());
		});
	});

	describe("synthesisRuleFor", () => {
		it("uses unanimous for critical, majority otherwise, informational for info", () => {
			expect(synthesisRuleFor("critical")).toBe("unanimous");
			expect(synthesisRuleFor("high")).toBe("majority");
			expect(synthesisRuleFor("medium")).toBe("majority");
			expect(synthesisRuleFor("low")).toBe("majority");
			expect(synthesisRuleFor("info")).toBe("informational");
		});
	});

	describe("synthesizePass1", () => {
		it("promotes a high-severity finding on majority CONFIRMED", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "high" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-c", classification: "DISPUTED" }),
			);
			expect(synthesizePass1(r)).toBe("promoted");
		});

		it("demotes a high-severity finding on majority DISPUTED", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "medium" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "DISPUTED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "DISPUTED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-c", classification: "CONFIRMED" }),
			);
			expect(synthesizePass1(r)).toBe("demoted");
		});

		it("returns needs-context when a majority-severity jury is tied", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "low" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "DISPUTED" }),
			);
			expect(synthesizePass1(r)).toBe("needs-context");
		});

		it("requires unanimous CONFIRMED for critical findings", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "critical" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-c", classification: "DISPUTED" }),
			);
			// Not unanimous → demote.
			expect(synthesizePass1(r)).toBe("demoted");

			let r2 = makeFindingRecord(
				makeProposal({ proposedSeverity: "critical" }),
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({ jurorId: "juror-b", classification: "CONFIRMED" }),
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({ jurorId: "juror-c", classification: "CONFIRMED" }),
			);
			expect(synthesizePass1(r2)).toBe("promoted");
		});

		it("returns needs-context when any juror said NEEDS-CONTEXT", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "high" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "NEEDS-CONTEXT" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-c", classification: "CONFIRMED" }),
			);
			expect(synthesizePass1(r)).toBe("needs-context");
		});

		it("promotes info findings after Pass 1 verdicts arrive", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "info" }));
			r = appendVerdict(r, makeVerdict({ classification: "DISPUTED" }));
			expect(synthesizePass1(r)).toBe("promoted");
		});

		it("returns the existing state when no Pass 1 verdicts have arrived", () => {
			const r = makeFindingRecord(makeProposal());
			expect(synthesizePass1(r)).toBe("proposed");
		});

		it("promotes info-severity findings on majority CONFIRMED", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "info" }));
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-c", classification: "DISPUTED" }),
			);
			expect(synthesizePass1(r)).toBe("promoted");
		});

		it("throws on unknown classification strings (no silent skew)", () => {
			let r = makeFindingRecord(makeProposal());
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-b", classification: "MAYBE" as never }),
			);
			expect(() => synthesizePass1(r)).toThrow(/unknown Pass 1 classification/);
		});

		it("rejects Object.prototype names as classifications (toString, constructor)", () => {
			let r = makeFindingRecord(makeProposal());
			r = appendVerdict(
				r,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({
					jurorId: "juror-b",
					classification: "toString" as never,
				}),
			);
			expect(() => synthesizePass1(r)).toThrow(/unknown Pass 1 classification/);

			let r2 = makeFindingRecord(makeProposal());
			r2 = appendVerdict(
				r2,
				makeVerdict({ jurorId: "juror-a", classification: "CONFIRMED" }),
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({
					jurorId: "juror-b",
					classification: "constructor" as never,
				}),
			);
			expect(() => synthesizePass1(r2)).toThrow(
				/unknown Pass 1 classification/,
			);
		});

		it("uses the latest verdict per juror when a juror re-votes after retry", () => {
			let r = makeFindingRecord(makeProposal({ proposedSeverity: "high" }));
			// Initial round: juror-a NEEDS-CONTEXT blocks the synthesis.
			r = appendVerdict(
				r,
				makeVerdict({
					jurorId: "juror-a",
					classification: "NEEDS-CONTEXT",
					stampedAt: "2026-06-15T18:00:00.000Z",
				}),
			);
			r = appendVerdict(
				r,
				makeVerdict({
					jurorId: "juror-b",
					classification: "CONFIRMED",
					stampedAt: "2026-06-15T18:00:00.000Z",
				}),
			);
			r = appendVerdict(
				r,
				makeVerdict({
					jurorId: "juror-c",
					classification: "CONFIRMED",
					stampedAt: "2026-06-15T18:00:00.000Z",
				}),
			);
			expect(synthesizePass1(r)).toBe("needs-context");

			// The orchestrator hands juror-a the missing context; juror-a
			// re-votes CONFIRMED. Synthesis must now ignore the stale
			// NEEDS-CONTEXT stamp and read the new majority.
			r = appendVerdict(
				r,
				makeVerdict({
					jurorId: "juror-a",
					classification: "CONFIRMED",
					stampedAt: "2026-06-15T19:00:00.000Z",
				}),
			);
			expect(synthesizePass1(r)).toBe("promoted");
		});
	});

	describe("synthesizePass8", () => {
		it("promotes to red-team-survived on SURVIVED verdict", () => {
			let r = withState(
				makeFindingRecord(makeProposal({ proposedSeverity: "high" })),
				"promoted",
			);
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-SURVIVED" }),
			);
			expect(synthesizePass8(r)).toBe("red-team-survived");
		});

		it("demotes on DISPROVED verdict", () => {
			let r = withState(makeFindingRecord(makeProposal()), "promoted");
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-DISPROVED" }),
			);
			expect(synthesizePass8(r)).toBe("demoted");
		});

		it("leaves state untouched on INCONCLUSIVE", () => {
			let r = withState(makeFindingRecord(makeProposal()), "promoted");
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-INCONCLUSIVE" }),
			);
			expect(synthesizePass8(r)).toBe("promoted");
		});

		it("returns the existing state when no Pass 8 verdict has arrived", () => {
			const r = withState(makeFindingRecord(makeProposal()), "promoted");
			expect(synthesizePass8(r)).toBe("promoted");
		});

		it("uses the latest Pass 8 verdict when retries append history", () => {
			let r = withState(makeFindingRecord(makeProposal()), "promoted");
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-INCONCLUSIVE" }),
			);
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-DISPROVED" }),
			);
			expect(synthesizePass8(r)).toBe("demoted");

			let r2 = withState(
				makeFindingRecord(makeProposal({ id: "F-2" })),
				"demoted",
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({ pass: 8, classification: "RED-TEAM-DISPROVED" }),
			);
			r2 = appendVerdict(
				r2,
				makeVerdict({ pass: 8, classification: "RED-TEAM-SURVIVED" }),
			);
			expect(synthesizePass8(r2)).toBe("red-team-survived");
		});

		it("throws on unknown Pass 8 classifications", () => {
			let r = withState(makeFindingRecord(makeProposal()), "promoted");
			r = appendVerdict(
				r,
				makeVerdict({ pass: 8, classification: "RED-TEAM-MAYBE" as never }),
			);
			expect(() => synthesizePass8(r)).toThrow(/unknown Pass 8 classification/);
		});
	});

	describe("DEFAULT_AUDIT_AREAS", () => {
		it("includes standard security areas and LLM-specific ones", () => {
			expect(DEFAULT_AUDIT_AREAS).toContain("authentication");
			expect(DEFAULT_AUDIT_AREAS).toContain("ssrf");
			expect(DEFAULT_AUDIT_AREAS).toContain("deserialization");
			expect(DEFAULT_AUDIT_AREAS).toContain("llm-prompt-construction");
			expect(DEFAULT_AUDIT_AREAS).toContain("llm-agency-tool-permissions");
		});

		it("has unique area ids", () => {
			expect(new Set(DEFAULT_AUDIT_AREAS).size).toBe(
				DEFAULT_AUDIT_AREAS.length,
			);
		});
	});

	describe("summarizeFindings", () => {
		it("counts by state, severity, and area", () => {
			const r1 = makeFindingRecord(makeProposal({ id: "F-1" }));
			const r2 = withState(
				makeFindingRecord(
					makeProposal({
						id: "F-2",
						proposedSeverity: "critical",
						area: "auth",
					}),
				),
				"red-team-survived",
			);
			const summary = summarizeFindings([r1, r2]);
			expect(summary.total).toBe(2);
			expect(summary.byState.proposed).toBe(1);
			expect(summary.byState["red-team-survived"]).toBe(1);
			expect(summary.bySeverity.high).toBe(1);
			expect(summary.bySeverity.critical).toBe(1);
			expect(summary.byArea.ssrf).toBe(1);
			expect(summary.byArea.auth).toBe(1);
		});
	});
});

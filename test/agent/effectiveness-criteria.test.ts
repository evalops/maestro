import { describe, expect, it } from "vitest";
import {
	DEFAULT_EFFECTIVENESS_CRITERIA,
	EFFECTIVENESS_REPORT_VERSION,
	type EffectivenessCriterion,
	type EffectivenessInputs,
	aggregateScore,
	buildEffectivenessReport,
	reportId,
} from "../../src/agent/effectiveness-criteria.js";

function makeInputs(
	overrides: Partial<EffectivenessInputs["stats"]> = {},
): EffectivenessInputs {
	return {
		stats: {
			agentSessions: 10,
			prsMerged: 8,
			prsAgentAuthored: 6,
			ticketsClosed: 5,
			toolCalls: 200,
			promptToCommitMinutes: 30,
			...overrides,
		},
		scope: { repos: ["acme/web", "acme/api"], users: [] },
		window: {
			start: "2026-06-01T00:00:00.000Z",
			end: "2026-06-15T00:00:00.000Z",
		},
	};
}

describe("agent/effectiveness-criteria", () => {
	describe("buildEffectivenessReport", () => {
		it("returns a versioned, content-addressed report with one score per criterion", () => {
			const report = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				makeInputs(),
				{ generatedAt: "2026-06-15T18:00:00.000Z" },
			);
			expect(report.version).toBe(EFFECTIVENESS_REPORT_VERSION);
			expect(report.criterionResults).toHaveLength(
				DEFAULT_EFFECTIVENESS_CRITERIA.length,
			);
			expect(report.id).toMatch(/^report-/);
			expect(report.generatedAt).toBe("2026-06-15T18:00:00.000Z");
		});

		it("computes a stable id for the same window + scope + criterion set", () => {
			const a = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				makeInputs(),
			);
			const b = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				makeInputs(),
			);
			expect(a.id).toBe(b.id);
		});

		it("produces a different id when scope changes", () => {
			const a = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				makeInputs(),
			);
			const b = buildEffectivenessReport(DEFAULT_EFFECTIVENESS_CRITERIA, {
				...makeInputs(),
				scope: { repos: ["acme/web"], users: [] },
			});
			expect(a.id).not.toBe(b.id);
		});

		it("produces the same id regardless of scope/criterion ordering", () => {
			const a = buildEffectivenessReport(DEFAULT_EFFECTIVENESS_CRITERIA, {
				...makeInputs(),
				scope: { repos: ["acme/api", "acme/web"], users: ["u1", "u2"] },
			});
			const b = buildEffectivenessReport(DEFAULT_EFFECTIVENESS_CRITERIA, {
				...makeInputs(),
				scope: { repos: ["acme/web", "acme/api"], users: ["u2", "u1"] },
			});
			expect(a.id).toBe(b.id);
		});

		it("throws when the criteria registry is empty", () => {
			expect(() => buildEffectivenessReport([], makeInputs())).toThrow(
				/criteria registry is empty/,
			);
		});

		it("throws on duplicate criterion ids", () => {
			const c: EffectivenessCriterion = DEFAULT_EFFECTIVENESS_CRITERIA[0]!;
			expect(() => buildEffectivenessReport([c, c], makeInputs())).toThrow(
				/duplicate criterion id/,
			);
		});

		it("throws on out-of-range weights", () => {
			const bad: EffectivenessCriterion = {
				id: "weighty",
				label: "Weighty",
				description: "Test",
				weight: 1.5,
				score: () => ({
					criterionId: "weighty",
					score: 0,
					confidence: "ok",
					evidence: [],
				}),
			};
			expect(() => buildEffectivenessReport([bad], makeInputs())).toThrow(
				/weight must be in \[0, 1\]/,
			);
		});

		it("throws when a criterion returns the wrong criterionId", () => {
			const bad: EffectivenessCriterion = {
				id: "good",
				label: "G",
				description: "x",
				weight: 1,
				score: () => ({
					criterionId: "bad",
					score: 1,
					confidence: "ok",
					evidence: [],
				}),
			};
			expect(() => buildEffectivenessReport([bad], makeInputs())).toThrow(
				/produced a score for/,
			);
		});

		it("throws when a criterion returns an out-of-range score", () => {
			const bad: EffectivenessCriterion = {
				id: "bad-score",
				label: "B",
				description: "x",
				weight: 1,
				score: () => ({
					criterionId: "bad-score",
					score: 2,
					confidence: "ok",
					evidence: [],
				}),
			};
			expect(() => buildEffectivenessReport([bad], makeInputs())).toThrow(
				/score must be in \[0, 1\]/,
			);
		});
	});

	describe("aggregateScore", () => {
		it("returns the weighted mean of confident criterion scores", () => {
			const report = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				makeInputs(),
			);
			expect(report.overall).toBeGreaterThan(0);
			expect(report.overall).toBeLessThanOrEqual(1);
			// The default weights sum to 1, so the aggregate equals the
			// weighted mean of all confident scores.
			const manual = report.criterionResults
				.filter((r) => r.confidence === "ok")
				.reduce((sum, r) => {
					const c = DEFAULT_EFFECTIVENESS_CRITERIA.find(
						(x) => x.id === r.criterionId,
					);
					return sum + r.score * (c?.weight ?? 0);
				}, 0);
			expect(report.overall).toBeCloseTo(manual);
		});

		it("excludes unknown-confidence criteria so a missing input doesn't drag the score to zero", () => {
			const inputs = makeInputs({
				agentSessions: 0,
				prsMerged: 0,
				prsAgentAuthored: 0,
				ticketsClosed: 0,
				promptToCommitMinutes: null,
			});
			const report = buildEffectivenessReport(
				DEFAULT_EFFECTIVENESS_CRITERIA,
				inputs,
			);
			// Every default criterion should report unknown confidence here.
			expect(
				report.criterionResults.every((r) => r.confidence === "unknown"),
			).toBe(true);
			expect(report.overall).toBe(0);
		});

		it("returns 0 when there are no scores to aggregate", () => {
			expect(aggregateScore([], [])).toBe(0);
		});
	});

	describe("DEFAULT_EFFECTIVENESS_CRITERIA", () => {
		it("weights sum to 1.0 (within float epsilon)", () => {
			const total = DEFAULT_EFFECTIVENESS_CRITERIA.reduce(
				(sum, c) => sum + c.weight,
				0,
			);
			expect(total).toBeCloseTo(1, 5);
		});

		it("agent-pr-share scores the ratio of agent-authored / merged PRs", () => {
			const c = DEFAULT_EFFECTIVENESS_CRITERIA.find(
				(x) => x.id === "agent-pr-share",
			);
			const s = c!.score(makeInputs({ prsMerged: 10, prsAgentAuthored: 7 }));
			expect(s.score).toBeCloseTo(0.7);
			expect(s.confidence).toBe("ok");
		});

		it("agent-pr-share returns unknown when no PRs merged", () => {
			const c = DEFAULT_EFFECTIVENESS_CRITERIA.find(
				(x) => x.id === "agent-pr-share",
			);
			const s = c!.score(makeInputs({ prsMerged: 0, prsAgentAuthored: 0 }));
			expect(s.confidence).toBe("unknown");
		});

		it("prompt-to-commit-latency is unknown when telemetry missing, otherwise inverse-linear in minutes", () => {
			const c = DEFAULT_EFFECTIVENESS_CRITERIA.find(
				(x) => x.id === "prompt-to-commit-latency",
			);
			expect(
				c!.score(makeInputs({ promptToCommitMinutes: null })).confidence,
			).toBe("unknown");
			// 0 min → 1.0; 60 min → 0; 30 min → 0.5
			expect(c!.score(makeInputs({ promptToCommitMinutes: 0 })).score).toBe(1);
			expect(c!.score(makeInputs({ promptToCommitMinutes: 60 })).score).toBe(0);
			expect(
				c!.score(makeInputs({ promptToCommitMinutes: 30 })).score,
			).toBeCloseTo(0.5);
		});

		it("prs-per-session caps at 1.0 even when ratio exceeds it", () => {
			const c = DEFAULT_EFFECTIVENESS_CRITERIA.find(
				(x) => x.id === "prs-per-session",
			);
			const s = c!.score(makeInputs({ agentSessions: 5, prsMerged: 50 }));
			expect(s.score).toBe(1);
		});
	});

	describe("reportId", () => {
		it("is deterministic across runs and renders ISO timestamps safely", () => {
			const id = reportId(
				{ start: "2026-06-01T00:00:00.000Z", end: "2026-06-15T00:00:00.000Z" },
				{ repos: ["acme/web"], users: [] },
				DEFAULT_EFFECTIVENESS_CRITERIA,
			);
			expect(id).toContain("2026-06-01T00-00-00-000Z");
			expect(id).not.toContain(":");
		});
	});
});

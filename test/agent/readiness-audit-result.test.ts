import { describe, expect, it } from "vitest";
import {
	type ReadinessFinding,
	failuresAtOrAboveLevel,
	findFindingFor,
	findingsByCategory,
	makeReadinessAuditResult,
	passRatio,
	summarizeAuditResult,
} from "../../src/agent/readiness-audit-result.js";
import type { AgentReadinessCriterion } from "../../src/agent/readiness-criteria.js";

function criterion(
	overrides: Partial<AgentReadinessCriterion> & { id: string },
): AgentReadinessCriterion {
	return {
		name: overrides.id,
		description: "test criterion",
		category: "docs",
		level: 1,
		scope: "repository",
		instructions: "...",
		...overrides,
	};
}

function finding(
	overrides: Partial<ReadinessFinding> & { criterionId: string },
): ReadinessFinding {
	return {
		status: "pass",
		summary: "ok",
		...overrides,
	};
}

describe("agent/readiness-audit-result", () => {
	describe("makeReadinessAuditResult", () => {
		it("returns an empty result for no findings", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", []);
			expect(result.findings).toEqual([]);
			expect(result.completedAt).toBe("2026-06-15T18:00:00.000Z");
		});

		it("preserves the order of findings as the caller provided them", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a" }),
				finding({ criterionId: "b" }),
				finding({ criterionId: "c" }),
			]);
			expect(result.findings.map((f) => f.criterionId)).toEqual([
				"a",
				"b",
				"c",
			]);
		});

		it("defensively copies the findings array", () => {
			const findings: ReadinessFinding[] = [finding({ criterionId: "a" })];
			const result = makeReadinessAuditResult(
				"2026-06-15T18:00:00.000Z",
				findings,
			);
			findings.push(finding({ criterionId: "b" }));
			expect(result.findings).toHaveLength(1);
		});

		it("throws on duplicate criterion ids", () => {
			expect(() =>
				makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
					finding({ criterionId: "a" }),
					finding({ criterionId: "a" }),
				]),
			).toThrow(/duplicate finding/);
		});
	});

	describe("findFindingFor", () => {
		it("returns the finding when it exists", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a", status: "fail", summary: "missing" }),
			]);
			expect(findFindingFor(result, "a")?.summary).toBe("missing");
		});

		it("returns undefined for criteria not in the audit", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a" }),
			]);
			expect(findFindingFor(result, "ghost")).toBeUndefined();
		});
	});

	describe("passRatio", () => {
		it("returns 0 for an empty audit", () => {
			expect(
				passRatio(makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [])),
			).toBe(0);
		});

		it("returns 0 when every finding is skip or error", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a", status: "skip" }),
				finding({ criterionId: "b", status: "error" }),
			]);
			expect(passRatio(result)).toBe(0);
		});

		it("excludes skip + error from both the numerator and denominator", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "fail" }),
				finding({ criterionId: "c", status: "skip" }),
				finding({ criterionId: "d", status: "error" }),
			]);
			expect(passRatio(result)).toBe(0.5);
		});

		it("returns 1 when every graded criterion passed", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "pass" }),
				finding({ criterionId: "c", status: "skip" }),
			]);
			expect(passRatio(result)).toBe(1);
		});
	});

	describe("findingsByCategory", () => {
		const criteria = [
			criterion({ id: "doc-a", category: "docs" }),
			criterion({ id: "doc-b", category: "docs" }),
			criterion({ id: "test-a", category: "testing" }),
		];

		it("returns only findings whose criterion is in the requested category", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "doc-a" }),
				finding({ criterionId: "doc-b", status: "fail", summary: "no readme" }),
				finding({ criterionId: "test-a" }),
			]);
			expect(
				findingsByCategory(result, criteria, "docs").map((f) => f.criterionId),
			).toEqual(["doc-a", "doc-b"]);
		});

		it("returns an empty list for a category with no matching findings", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "doc-a" }),
			]);
			expect(findingsByCategory(result, criteria, "testing")).toEqual([]);
		});
	});

	describe("failuresAtOrAboveLevel", () => {
		const criteria = [
			criterion({ id: "low", level: 1 }),
			criterion({ id: "mid", level: 3 }),
			criterion({ id: "high", level: 5 }),
		];

		it("returns failed findings at or above the given level", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "low", status: "fail" }),
				finding({ criterionId: "mid", status: "fail" }),
				finding({ criterionId: "high", status: "fail" }),
			]);
			expect(
				failuresAtOrAboveLevel(result, criteria, 3).map((f) => f.criterionId),
			).toEqual(["mid", "high"]);
		});

		it("excludes passes even if they are at or above the level", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "mid", status: "pass" }),
				finding({ criterionId: "high", status: "fail" }),
			]);
			expect(
				failuresAtOrAboveLevel(result, criteria, 3).map((f) => f.criterionId),
			).toEqual(["high"]);
		});

		it("returns an empty list when no failures meet the level cutoff", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "low", status: "fail" }),
			]);
			expect(failuresAtOrAboveLevel(result, criteria, 3)).toEqual([]);
		});
	});

	describe("summarizeAuditResult", () => {
		it("counts each status bucket separately", () => {
			const result = makeReadinessAuditResult("2026-06-15T18:00:00.000Z", [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "pass" }),
				finding({ criterionId: "c", status: "fail" }),
				finding({ criterionId: "d", status: "skip" }),
				finding({ criterionId: "e", status: "error" }),
			]);
			expect(summarizeAuditResult(result)).toEqual({
				total: 5,
				pass: 2,
				fail: 1,
				skip: 1,
				error: 1,
			});
		});

		it("returns zeros for an empty audit", () => {
			expect(
				summarizeAuditResult(
					makeReadinessAuditResult("2026-06-15T18:00:00.000Z", []),
				),
			).toEqual({ total: 0, pass: 0, fail: 0, skip: 0, error: 0 });
		});
	});
});

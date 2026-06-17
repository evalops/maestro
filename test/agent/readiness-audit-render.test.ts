import { describe, expect, it } from "vitest";
import {
	renderAuditResult,
	renderAuditResultSummaryLine,
} from "../../src/agent/readiness-audit-render.js";
import {
	type ReadinessFinding,
	makeReadinessAuditResult,
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

const TS = "2026-06-15T18:00:00.000Z";

describe("agent/readiness-audit-render", () => {
	describe("renderAuditResult", () => {
		it("renders an empty audit with just the heading and summary line", () => {
			const out = renderAuditResult(makeReadinessAuditResult(TS, []));
			expect(out).toContain("# Agent readiness audit");
			expect(out).toContain("`0 passed, 0 failed, 0 skipped, 0 errors`");
		});

		it("groups failures under their own H2 section before passes", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "fail", summary: "missing" }),
			]);
			const out = renderAuditResult(result);
			const failuresIdx = out.indexOf("## Failures");
			const passesIdx = out.indexOf("## Passes");
			expect(failuresIdx).toBeGreaterThan(-1);
			expect(passesIdx).toBeGreaterThan(-1);
			expect(failuresIdx).toBeLessThan(passesIdx);
		});

		it("renders failure body with summary and evidence", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({
					criterionId: "oauth_login",
					status: "fail",
					summary: "Auth criterion not satisfied.",
					evidence: "src/auth/oauth.ts:42",
				}),
			]);
			const out = renderAuditResult(result);
			expect(out).toContain("**`oauth_login`**");
			expect(out).toContain("Auth criterion not satisfied.");
			expect(out).toContain("Evidence: `src/auth/oauth.ts:42`");
		});

		it("includes criterion name + level when rubric is supplied", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "readme", status: "pass" }),
			]);
			const out = renderAuditResult(result, {
				criteria: [
					criterion({ id: "readme", name: "README exists", level: 1 }),
				],
				includeNonFailures: true,
			});
			// Passes section shows just the id (no name decoration); names
			// only decorate non-pass rows so the passes list stays compact.
			expect(out).toContain("- `readme`");
		});

		it("decorates failure rows with the criterion name + level", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({
					criterionId: "oauth_login",
					status: "fail",
					summary: "missing",
				}),
			]);
			const out = renderAuditResult(result, {
				criteria: [
					criterion({
						id: "oauth_login",
						name: "OAuth login required",
						level: 3,
						category: "security",
					}),
				],
			});
			expect(out).toContain(
				"**`oauth_login`** — OAuth login required _(L3, security)_",
			);
		});

		it("renders the skippedBecause attribution for skip findings", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({
					criterionId: "agents_md_validation",
					status: "skip",
					summary: "upstream missing",
					skippedBecause: "agents_md",
				}),
			]);
			const out = renderAuditResult(result);
			expect(out).toContain("Skipped because `agents_md` failed");
		});

		it("renders errors in their own section, separate from failures", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({
					criterionId: "rubric_a",
					status: "error",
					summary: "LLM timeout",
				}),
			]);
			const out = renderAuditResult(result);
			expect(out).toContain("## Errors");
			expect(out).not.toContain("## Failures");
		});

		it("omits the non-failure sections when includeNonFailures: false", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "fail", summary: "missing" }),
				finding({ criterionId: "c", status: "skip" }),
			]);
			const out = renderAuditResult(result, { includeNonFailures: false });
			expect(out).toContain("## Failures");
			expect(out).not.toContain("## Passes");
			expect(out).not.toContain("## Skipped");
		});

		it("escapes markdown metacharacters in the title", () => {
			const out = renderAuditResult(makeReadinessAuditResult(TS, []), {
				title: "`xss` *or* something",
			});
			expect(out).toContain("\\`xss\\`");
			expect(out).toContain("\\*or\\*");
		});

		it("omits the heading entirely when title is null", () => {
			const out = renderAuditResult(makeReadinessAuditResult(TS, []), {
				title: null,
			});
			expect(out).not.toContain("# ");
		});

		it("respects headingDepthOffset for sub-sections", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "fail", summary: "x" }),
			]);
			const out = renderAuditResult(result, { headingDepthOffset: 1 });
			expect(out).toContain("## Agent readiness audit");
			expect(out).toContain("### Failures");
		});

		it("renders summary, evidence, and finding rows safe against backticks", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({
					criterionId: "id`with`backticks",
					status: "fail",
					summary: "summary `with` backticks",
					evidence: "ev`idence`",
				}),
			]);
			const out = renderAuditResult(result);
			// criterionId + evidence go through renderInlineCode (dynamic
			// fence), summary through escapeMd (backslash escape).
			expect(out).toContain("``id`with`backticks``");
			// Evidence body ends in a backtick, so renderInlineCode pads
			// with surrounding spaces per CommonMark.
			expect(out).toContain("`` ev`idence` ``");
			expect(out).toContain("summary \\`with\\` backticks");
		});
	});

	describe("renderAuditResultSummaryLine", () => {
		it("returns a single status-bar line with pass percentage", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "pass" }),
				finding({ criterionId: "c", status: "fail" }),
				finding({ criterionId: "d", status: "skip" }),
			]);
			const out = renderAuditResultSummaryLine(result);
			expect(out).toBe(
				"readiness: 2 passed, 1 failed, 1 skipped, 0 errors (67% pass rate)",
			);
		});

		it("includes the error count so the status bar can't mask evaluation failures", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "pass" }),
				finding({
					criterionId: "b",
					status: "error",
					summary: "LLM timeout",
				}),
			]);
			expect(renderAuditResultSummaryLine(result)).toContain("1 errors");
		});

		it("reports 0% when nothing was graded", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "skip" }),
			]);
			expect(renderAuditResultSummaryLine(result)).toContain("(0% pass rate)");
		});

		it("reports 100% when every graded criterion passed", () => {
			const result = makeReadinessAuditResult(TS, [
				finding({ criterionId: "a", status: "pass" }),
				finding({ criterionId: "b", status: "skip" }),
			]);
			expect(renderAuditResultSummaryLine(result)).toContain(
				"(100% pass rate)",
			);
		});
	});
});

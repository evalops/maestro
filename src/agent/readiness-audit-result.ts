/**
 * Agent Readiness audit result
 *
 * Pure data layer for the audit output. The readiness auditor walks
 * the rubric (`readiness-criteria.ts`, part 1 of #2661) and emits one
 * `ReadinessFinding` per criterion. This module collects those
 * findings into a `ReadinessAuditResult` and provides typed helpers
 * the renderer + CLI summary share.
 *
 * Findings come in four flavors:
 *   - `pass`  — criterion satisfied
 *   - `fail`  — criterion not satisfied; carries an evidence excerpt
 *   - `skip`  — criterion explicitly skipped (e.g. application-shape
 *               check on a docs-only repo, or `requires` upstream
 *               failed)
 *   - `error` — auditor couldn't evaluate the criterion (LLM timeout,
 *               bad regex, etc); distinct from `fail` so reports
 *               can flag operability issues separately
 *
 * Roll-up helpers:
 *   - `passRatio(result)` — overall pass / total (excluding skips +
 *                            errors so the percentage reflects what
 *                            the auditor actually graded)
 *   - `findingsByCategory(result, category)`
 *   - `failuresAtOrAboveLevel(result, level)` — which high-impact
 *                                                criteria failed
 *   - `summarizeAuditResult(result)` — total, pass, fail, skip,
 *                                      error counts in one shot
 *
 * Pure data + functions. No I/O, no auditor invocation.
 */

import type {
	AgentReadinessCriterion,
	ReadinessCategory,
	ReadinessLevel,
} from "./readiness-criteria.js";

/** Outcome the auditor records for a single criterion. */
export type ReadinessFindingStatus = "pass" | "fail" | "skip" | "error";

/**
 * Per-criterion audit finding. `criterionId` is the stable rubric id
 * (`AgentReadinessCriterion.id`) so renderers can re-load the full
 * criterion if they need the name/instructions.
 */
export interface ReadinessFinding {
	criterionId: string;
	status: ReadinessFindingStatus;
	/** Short summary the renderer can show inline. */
	summary: string;
	/**
	 * Optional evidence snippet (file path + excerpt, command output,
	 * etc). Kept opaque to the data layer.
	 */
	evidence?: string;
	/**
	 * Optional id of the upstream criterion that caused this one to
	 * skip (used when `requires` upstream failed). Only meaningful when
	 * `status === "skip"`.
	 */
	skippedBecause?: string;
}

/**
 * A complete audit pass: one finding per criterion the auditor
 * touched. Order should match the rubric order; this module does not
 * re-sort.
 */
export interface ReadinessAuditResult {
	/** ISO8601 timestamp the auditor finished. */
	completedAt: string;
	findings: readonly ReadinessFinding[];
}

/**
 * Collect findings into an audit result. Throws on duplicate criterion
 * ids — two findings for the same criterion is always a caller bug.
 */
export function makeReadinessAuditResult(
	completedAt: string,
	findings: readonly ReadinessFinding[],
): ReadinessAuditResult {
	const seen = new Set<string>();
	for (const f of findings) {
		if (seen.has(f.criterionId)) {
			throw new Error(
				`makeReadinessAuditResult: duplicate finding for criterion "${f.criterionId}"`,
			);
		}
		seen.add(f.criterionId);
	}
	return { completedAt, findings: [...findings] };
}

/**
 * Look up the finding for a specific criterion. Returns undefined when
 * the auditor didn't touch that criterion (rather than recording a
 * skip), which lets callers distinguish "not in this audit" from
 * "explicitly skipped".
 */
export function findFindingFor(
	result: ReadinessAuditResult,
	criterionId: string,
): ReadinessFinding | undefined {
	return result.findings.find((f) => f.criterionId === criterionId);
}

/**
 * Pass ratio over criteria the auditor actually graded (excludes
 * `skip` + `error`). Returns 0 when nothing was graded so callers
 * don't have to special-case empty audits.
 */
export function passRatio(result: ReadinessAuditResult): number {
	let graded = 0;
	let passed = 0;
	for (const f of result.findings) {
		if (f.status === "pass") {
			graded += 1;
			passed += 1;
		} else if (f.status === "fail") {
			graded += 1;
		}
	}
	if (graded === 0) return 0;
	return passed / graded;
}

/**
 * Return findings whose criterion belongs to `category`. The rubric
 * is required so this module doesn't have to re-join against
 * criterion metadata.
 */
export function findingsByCategory(
	result: ReadinessAuditResult,
	criteria: readonly AgentReadinessCriterion[],
	category: ReadinessCategory,
): ReadinessFinding[] {
	const inCategory = new Set(
		criteria.filter((c) => c.category === category).map((c) => c.id),
	);
	return result.findings.filter((f) => inCategory.has(f.criterionId));
}

/**
 * Failures at or above a given rubric level. Useful for "did the
 * agent platform clear the level-3 bar?" gates.
 */
export function failuresAtOrAboveLevel(
	result: ReadinessAuditResult,
	criteria: readonly AgentReadinessCriterion[],
	level: ReadinessLevel,
): ReadinessFinding[] {
	const atOrAbove = new Set(
		criteria.filter((c) => c.level >= level).map((c) => c.id),
	);
	return result.findings.filter(
		(f) => f.status === "fail" && atOrAbove.has(f.criterionId),
	);
}

/**
 * Quick counts for a header row: total / pass / fail / skip / error
 * in one shot so the CLI summary doesn't walk the array five times.
 */
export function summarizeAuditResult(result: ReadinessAuditResult): {
	total: number;
	pass: number;
	fail: number;
	skip: number;
	error: number;
} {
	let pass = 0;
	let fail = 0;
	let skip = 0;
	let error = 0;
	for (const f of result.findings) {
		switch (f.status) {
			case "pass":
				pass += 1;
				break;
			case "fail":
				fail += 1;
				break;
			case "skip":
				skip += 1;
				break;
			case "error":
				error += 1;
				break;
		}
	}
	return { total: result.findings.length, pass, fail, skip, error };
}

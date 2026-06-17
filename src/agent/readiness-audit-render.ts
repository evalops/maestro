/**
 * Agent Readiness audit markdown renderer
 *
 * Builds on the readiness criteria rubric (part 1 of #2661, merged as
 * #2675) and the audit result primitive (part 3 of #2661, merged as
 * #2707). Pure renderer that turns a `ReadinessAuditResult` into a
 * human-readable markdown block — suitable for:
 *
 *   - PR comments after `maestro readiness audit` runs
 *   - the orchestrator's UI surface
 *   - exported `readiness.md` reports stored in `.maestro/`
 *
 * Output shape:
 *
 *   # Agent readiness audit
 *
 *   `12 passed, 2 failed, 1 skipped, 0 errors` _(completed 2026-06-15T18:00:00Z)_
 *
 *   ## Failures
 *   - **`oauth_login`** — _Auth criterion not satisfied._
 *     - Evidence: `src/auth/oauth.ts:42`
 *   ...
 *
 *   ## Passes
 *   - `readme`
 *   - `coverage_threshold`
 *   ...
 *
 * Pure function over the record types. No I/O.
 */

import type {
	ReadinessAuditResult,
	ReadinessFinding,
	ReadinessFindingStatus,
} from "./readiness-audit-result.js";
import { summarizeAuditResult } from "./readiness-audit-result.js";
import type {
	AgentReadinessCriterion,
	ReadinessCategory,
	ReadinessLevel,
} from "./readiness-criteria.js";

export interface RenderAuditResultOptions {
	/**
	 * Optional rubric so the renderer can pull human-readable criterion
	 * names + categories alongside the bare `criterionId`. When omitted,
	 * findings render with just the id.
	 */
	criteria?: readonly AgentReadinessCriterion[];
	/**
	 * Document title. Pass `null` to skip the heading entirely (useful
	 * when splicing into a larger document). Defaults to
	 * `"Agent readiness audit"`.
	 */
	title?: string | null;
	/**
	 * Heading depth offset. `0` (default) makes the top-level heading an
	 * H1. Bump to splice under H2/H3 sections. Clamped to [0, 4].
	 */
	headingDepthOffset?: number;
	/**
	 * When true (default), include the passes/skips/errors sections.
	 * Set `false` for a failures-only report.
	 */
	includeNonFailures?: boolean;
}

/**
 * Render a complete audit result as a markdown block.
 */
export function renderAuditResult(
	result: ReadinessAuditResult,
	options: RenderAuditResultOptions = {},
): string {
	const offset = clampOffset(options.headingDepthOffset ?? 0);
	const h = (level: number) => "#".repeat(Math.min(level + offset, 6));
	const includeNonFailures = options.includeNonFailures ?? true;
	const criteriaById = indexCriteriaById(options.criteria ?? []);
	const summary = summarizeAuditResult(result);

	const lines: string[] = [];
	if (options.title !== null) {
		const title = options.title ?? "Agent readiness audit";
		lines.push(`${h(1)} ${escapeMd(title)}`);
		lines.push("");
	}
	lines.push(
		`${renderInlineCode(
			`${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped, ${summary.error} errors`,
		)} _(completed ${escapeMd(result.completedAt)})_`,
	);

	const buckets = bucketFindings(result.findings);
	if (buckets.fail.length > 0) {
		lines.push("");
		lines.push(`${h(2)} Failures`);
		lines.push("");
		for (const f of buckets.fail) {
			lines.push(...renderFindingLines(f, criteriaById));
		}
	}
	if (includeNonFailures) {
		if (buckets.error.length > 0) {
			lines.push("");
			lines.push(`${h(2)} Errors`);
			lines.push("");
			for (const f of buckets.error) {
				lines.push(...renderFindingLines(f, criteriaById));
			}
		}
		if (buckets.skip.length > 0) {
			lines.push("");
			lines.push(`${h(2)} Skipped`);
			lines.push("");
			for (const f of buckets.skip) {
				lines.push(...renderFindingLines(f, criteriaById));
			}
		}
		if (buckets.pass.length > 0) {
			lines.push("");
			lines.push(`${h(2)} Passes`);
			lines.push("");
			for (const f of buckets.pass) {
				lines.push(`- ${renderInlineCode(f.criterionId)}`);
			}
		}
	}
	return lines.join("\n");
}

/**
 * Lightweight single-line summary for header bars / status bars.
 * Example: `readiness: 12 passed, 2 failed, 1 skipped (60% pass rate)`.
 */
export function renderAuditResultSummaryLine(
	result: ReadinessAuditResult,
): string {
	const summary = summarizeAuditResult(result);
	const graded = summary.pass + summary.fail;
	const pct = graded === 0 ? 0 : Math.round((summary.pass / graded) * 100);
	// Surface error count too — error is a first-class outcome at the
	// data layer and renderAuditResult always lists it, so the status
	// bar would otherwise imply a clean / fully-skipped audit when
	// criteria actually failed to evaluate.
	return `readiness: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped, ${summary.error} errors (${pct}% pass rate)`;
}

function renderFindingLines(
	finding: ReadinessFinding,
	criteriaById: Map<string, AgentReadinessCriterion>,
): string[] {
	const criterion = criteriaById.get(finding.criterionId);
	const idCell = renderInlineCode(finding.criterionId);
	const nameSuffix = criterion
		? ` — ${escapeMd(criterion.name)} _(L${criterion.level}, ${escapeBadge(criterion.category)})_`
		: "";
	const lines: string[] = [
		`- **${idCell}**${nameSuffix}`,
		`  - ${escapeMd(finding.summary)}`,
	];
	if (finding.evidence) {
		lines.push(`  - Evidence: ${renderInlineCode(finding.evidence)}`);
	}
	if (finding.skippedBecause && finding.status === "skip") {
		lines.push(
			`  - Skipped because ${renderInlineCode(finding.skippedBecause)} failed`,
		);
	}
	return lines;
}

function bucketFindings(
	findings: readonly ReadinessFinding[],
): Record<ReadinessFindingStatus, ReadinessFinding[]> {
	const buckets: Record<ReadinessFindingStatus, ReadinessFinding[]> = {
		pass: [],
		fail: [],
		skip: [],
		error: [],
	};
	for (const f of findings) {
		buckets[f.status].push(f);
	}
	return buckets;
}

function indexCriteriaById(
	criteria: readonly AgentReadinessCriterion[],
): Map<string, AgentReadinessCriterion> {
	const map = new Map<string, AgentReadinessCriterion>();
	for (const c of criteria) {
		map.set(c.id, c);
	}
	return map;
}

function clampOffset(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 4) return 4;
	return Math.floor(value);
}

function renderInlineCode(input: string): string {
	const normalized = input.replace(/\r?\n|\r/g, " ");
	const longestBacktickRun = Math.max(
		0,
		...[...normalized.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	const body =
		normalized.startsWith("`") || normalized.endsWith("`")
			? ` ${normalized} `
			: normalized;
	return `${fence}${body}${fence}`;
}

function escapeMd(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/_/g, "\\_")
		.replace(/\*/g, "\\*")
		.replace(/\r?\n|\r/g, " ");
}

function escapeBadge(value: ReadinessCategory | ReadinessLevel): string {
	return escapeMd(String(value));
}

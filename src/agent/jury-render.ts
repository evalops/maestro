/**
 * Jury record markdown renderer
 *
 * Builds on the jury record primitive (part 1 of #2668, merged as
 * #2680). Renders a `JuryFindingRecord` (or a list of them) as
 * markdown suitable for:
 *
 *   - PR review comments (where the agent posts its findings)
 *   - audit logs (where the security team reviews after the fact)
 *   - the orchestrator's UI
 *
 * Pure function over the record type. No I/O, no API calls, no
 * upstream agent dependencies. The PR-post integration, the
 * audit-store wiring, and the UI rendering live in follow-up PRs.
 */

import type {
	FindingSeverity,
	FindingState,
	JurorVerdict,
	JuryFindingRecord,
	PriorArtRef,
} from "./jury-record.js";
import { renderInlineCode } from "./markdown-render-utils.js";

export interface RenderJuryFindingOptions {
	/**
	 * When set, only verdicts at or after `sincePass` are rendered in
	 * the timeline. Useful when reposting an updated comment to surface
	 * only what's new since the last post.
	 */
	sincePass?: number;
	/** Include the code quote block in the output. Defaults to `true`. */
	includeCode?: boolean;
	/** Include the prior-art section. Defaults to `true`. */
	includePriorArt?: boolean;
}

/**
 * Render one finding as a markdown block. The output starts with an
 * H3 (`### ...`) so the caller can drop it into a larger document
 * without rewriting the heading level.
 */
export function renderJuryFinding(
	record: JuryFindingRecord,
	options: RenderJuryFindingOptions = {},
): string {
	const includeCode = options.includeCode ?? true;
	const includePriorArt = options.includePriorArt ?? true;
	const sincePass = options.sincePass;

	const lines: string[] = [];
	const severityBadge = renderSeverity(record.proposedSeverity);
	const stateBadge = renderState(record.state);
	lines.push(`### ${severityBadge} ${escapeMd(record.title)}`);
	lines.push("");
	lines.push(
		`- **Finding id:** ${renderInlineCode(record.id)} (area: ${renderInlineCode(record.area)})`,
	);
	lines.push(`- **State:** ${stateBadge}`);
	lines.push(
		`- **Location:** ${renderInlineCode(`${record.location.file}:${record.location.line}`)} @ ${renderInlineCode(record.location.commitSha.slice(0, 7))}`,
	);
	lines.push(
		`- **Proposed:** ${escapeMd(record.proposedAt)} · **Updated:** ${escapeMd(record.updatedAt)}`,
	);

	if (includeCode && record.codeQuote.trim()) {
		lines.push("");
		lines.push("```");
		lines.push(record.codeQuote.replace(/```/g, "``​`"));
		lines.push("```");
	}

	const filteredVerdicts =
		sincePass === undefined
			? record.verdicts
			: record.verdicts.filter((v) => v.pass >= sincePass);
	if (filteredVerdicts.length > 0) {
		lines.push("");
		lines.push("**Verdict timeline:**");
		lines.push("");
		for (const v of filteredVerdicts) {
			lines.push(`- ${renderVerdict(v)}`);
		}
	}

	if (includePriorArt && record.priorArt.length > 0) {
		lines.push("");
		lines.push("**Prior art (Pass 2):**");
		lines.push("");
		for (const ref of record.priorArt) {
			lines.push(`- ${renderPriorArt(ref)}`);
		}
	}
	if (includePriorArt && record.priorArtDeep.length > 0) {
		lines.push("");
		lines.push("**Prior art (Pass 3 — deep research):**");
		lines.push("");
		for (const ref of record.priorArtDeep) {
			lines.push(`- ${renderPriorArt(ref)}`);
		}
	}

	return lines.join("\n");
}

/**
 * Render multiple findings as a single markdown document. Includes a
 * brief summary header followed by one `renderJuryFinding` block per
 * record, separated by horizontal rules. Findings are sorted by
 * severity desc, then state, then `proposedAt` desc — so reviewers
 * see the most actionable items first.
 */
export function renderJuryFindings(
	records: readonly JuryFindingRecord[],
	options: RenderJuryFindingOptions = {},
): string {
	if (records.length === 0) {
		return "_No findings to render._";
	}
	const sorted = [...records].sort(compareForReview);
	const counts = countBySeverity(sorted);

	const header: string[] = [];
	header.push(`## Jury findings (${sorted.length})`);
	header.push("");
	header.push(
		`Severity mix: ${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low · ${counts.info} info`,
	);

	const bodies = sorted.map((r) => renderJuryFinding(r, options));
	return [header.join("\n"), bodies.join("\n\n---\n\n")].join("\n\n");
}

function compareForReview(a: JuryFindingRecord, b: JuryFindingRecord): number {
	const sevOrder =
		SEVERITY_ORDER[a.proposedSeverity] - SEVERITY_ORDER[b.proposedSeverity];
	if (sevOrder !== 0) return sevOrder;
	const stateOrder = STATE_ORDER[a.state] - STATE_ORDER[b.state];
	if (stateOrder !== 0) return stateOrder;
	if (a.proposedAt === b.proposedAt) return 0;
	return a.proposedAt < b.proposedAt ? 1 : -1;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	info: 4,
};

const STATE_ORDER: Record<FindingState, number> = {
	"red-team-survived": 0,
	promoted: 1,
	"needs-context": 2,
	demoted: 3,
	proposed: 4,
};

function countBySeverity(
	records: readonly JuryFindingRecord[],
): Record<FindingSeverity, number> {
	const counts: Record<FindingSeverity, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		info: 0,
	};
	for (const r of records) {
		counts[r.proposedSeverity] += 1;
	}
	return counts;
}

function renderSeverity(severity: FindingSeverity): string {
	return `**[${severity.toUpperCase()}]**`;
}

function renderState(state: FindingState): string {
	const label = state.replace(/-/g, " ");
	return `\`${label}\``;
}

function renderVerdict(v: JurorVerdict): string {
	const reason = v.reason ? ` — _${escapeMd(v.reason)}_` : "";
	return `Pass ${v.pass} · ${renderInlineCode(v.jurorId)} (${escapeMd(v.modelFamily)}) → **${escapeMd(v.classification)}** at ${escapeMd(v.stampedAt)}${reason}`;
}

function renderPriorArt(ref: PriorArtRef): string {
	const summary = ref.summary ? `: ${escapeMd(ref.summary)}` : "";
	return `${renderInlineCode(ref.id)} (${ref.kind})${summary}`;
}

/**
 * Escape characters that would otherwise be interpreted as markdown
 * syntax inside inline contexts. Conservative — we don't try to
 * fully sanitize, just keep titles + reasons from accidentally
 * breaking the surrounding formatting.
 */
function escapeMd(input: string): string {
	return input
		.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/_/g, "\\_")
		.replace(/\*/g, "\\*");
}

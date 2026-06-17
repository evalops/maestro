/**
 * Readiness criteria markdown renderer
 *
 * Builds on the readiness criteria primitive (part 1 of #2661, merged
 * as #2675). Pure renderer: turn a list of `AgentReadinessCriterion`s
 * into a markdown checklist suitable for documentation, the
 * `/readiness --help` output, or the audit report header that lists
 * what's about to be evaluated.
 *
 * No I/O, no audit runner. Just deterministic markdown.
 */

import type {
	AgentReadinessCriterion,
	ReadinessCategory,
	ReadinessLevel,
	ReadinessScope,
} from "./readiness-criteria.js";

export interface RenderReadinessOptions {
	/**
	 * When set, only criteria at or below this level are rendered.
	 * Useful for "show me the level-1 floor" docs.
	 */
	maxLevel?: ReadinessLevel;
	/** When set, only criteria matching this scope are rendered. */
	scope?: ReadinessScope;
	/**
	 * Title for the rendered document. Defaults to "Agent readiness
	 * criteria". Pass `null` to omit the heading entirely (callers that
	 * splice the output into a larger document do this).
	 */
	title?: string | null;
	/**
	 * Render each criterion as a GFM checkbox item (`- [ ]`) instead
	 * of the default bullet. Useful when the renderer's output is going
	 * straight into an audit progress checklist.
	 */
	asChecklist?: boolean;
}

/**
 * Render `criteria` as a category-grouped markdown document. Within
 * each category, entries are ordered by `level` ascending, then by `id`
 * ascending for stability.
 */
export function renderReadinessCriteria(
	criteria: readonly AgentReadinessCriterion[],
	options: RenderReadinessOptions = {},
): string {
	const filtered = applyFilters(criteria, options);
	const filterRequested =
		options.maxLevel !== undefined || options.scope !== undefined;
	const titleLine =
		options.title === undefined
			? "# Agent readiness criteria"
			: options.title === null
				? null
				: `# ${escapeMd(options.title)}`;

	if (filtered.length === 0) {
		return [
			titleLine,
			"",
			filterRequested
				? "_No criteria match the requested filter._"
				: "_No readiness criteria are defined._",
		]
			.filter((line): line is string => line !== null)
			.join("\n");
	}

	const grouped = groupByCategory(filtered);
	const sections: string[] = [];
	if (titleLine) sections.push(titleLine);
	sections.push(summaryLine(filtered));

	for (const [category, items] of grouped) {
		sections.push(`\n## ${categoryLabel(category)}`);
		const sorted = [...items].sort((a, b) => {
			if (a.level !== b.level) return a.level - b.level;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		for (const c of sorted) {
			sections.push(renderCriterion(c, options.asChecklist === true));
		}
	}

	return sections.join("\n");
}

/**
 * Render a single criterion as a checklist or bullet block. Includes
 * the level, scope, and `skippable` flag inline so reviewers can spot
 * the metadata without scrolling sideways.
 */
export function renderCriterion(
	criterion: AgentReadinessCriterion,
	asChecklist: boolean,
): string {
	const bullet = asChecklist ? "- [ ]" : "-";
	const skippable = criterion.isSkippable ? " · skippable" : "";
	const requires =
		criterion.requires && criterion.requires.length > 0
			? `\n  - **Depends on:** ${criterion.requires.map(renderInlineCode).join(", ")}`
			: "";
	return [
		`${bullet} **${renderInlineCode(criterion.id)}** — ${escapeMd(criterion.name)} _(L${criterion.level}, ${criterion.scope}${skippable})_`,
		`  - ${escapeMd(criterion.description)}`,
		requires,
	]
		.filter((line) => line !== "")
		.join("\n");
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

function summaryLine(criteria: readonly AgentReadinessCriterion[]): string {
	const byLevel: Record<ReadinessLevel, number> = {
		1: 0,
		2: 0,
		3: 0,
		4: 0,
		5: 0,
	};
	for (const c of criteria) byLevel[c.level] += 1;
	const counts: string[] = [];
	for (const level of [1, 2, 3, 4, 5] as ReadinessLevel[]) {
		if (byLevel[level] > 0) counts.push(`L${level}: ${byLevel[level]}`);
	}
	return `\n_${criteria.length} criteria — ${counts.join(" · ")}_`;
}

function applyFilters(
	criteria: readonly AgentReadinessCriterion[],
	options: RenderReadinessOptions,
): AgentReadinessCriterion[] {
	return criteria.filter((c) => {
		if (options.maxLevel !== undefined && c.level > options.maxLevel) {
			return false;
		}
		if (options.scope !== undefined && c.scope !== options.scope) {
			return false;
		}
		return true;
	});
}

function groupByCategory(
	criteria: readonly AgentReadinessCriterion[],
): Map<ReadinessCategory, AgentReadinessCriterion[]> {
	// `Map` keeps insertion order; insert categories in the canonical
	// order so the rendered output stays stable across runs.
	const order: ReadinessCategory[] = [
		"docs",
		"build",
		"testing",
		"style",
		"debugging",
		"security",
		"product",
	];
	const grouped = new Map<ReadinessCategory, AgentReadinessCriterion[]>();
	for (const category of order) grouped.set(category, []);
	for (const c of criteria) {
		const bucket = grouped.get(c.category);
		if (bucket) bucket.push(c);
	}
	// Drop empty categories so the output doesn't show headers with no
	// content.
	for (const [category, items] of grouped) {
		if (items.length === 0) grouped.delete(category);
	}
	return grouped;
}

function categoryLabel(category: ReadinessCategory): string {
	switch (category) {
		case "docs":
			return "Docs";
		case "build":
			return "Build & tooling";
		case "testing":
			return "Testing";
		case "style":
			return "Style & conventions";
		case "debugging":
			return "Debugging";
		case "security":
			return "Security & safety";
		case "product":
			return "Product discipline";
	}
}

function escapeMd(input: string): string {
	return input
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/_/g, "\\_")
		.replace(/\*/g, "\\*");
}

/**
 * Per-Repo Wiki — canonical page schema
 *
 * Every maestro-managed wiki follows a fixed page tree. The agent
 * reads from the wiki to answer "how does this codebase work?" without
 * re-deriving it every session, and refreshes the always-present
 * pages from the repo's current state on a schedule.
 *
 * ## The canonical tree
 *
 * ```
 * overview/
 *   index.md                       project overview, who uses it, quick links
 *   architecture.md                system architecture with Mermaid diagrams
 *   getting-started.md             prerequisites, install, build, test, run
 *   glossary.md                    project-specific terms and domain vocabulary
 * by-the-numbers.md                codebase statistics snapshot — ALWAYS REFRESHED
 * lore.md                          timeline + history — refresh on substantial delta only
 * fun-facts.md                     easter eggs, origin stories, oldest code (optional)
 * how-to-contribute/
 *   index.md                       work pickup, PR process, definition of done
 *   development-workflow.md        branch → code → test → PR → merge cycle
 *   testing.md                     frameworks, patterns, how to run / mock / cover
 *   debugging.md                   logs, common errors, troubleshooting runbook
 *   patterns-and-conventions.md    error handling, coding style, cross-cutting concerns
 *   tooling.md                     build system, linters, codegen, CI
 * lenses/                          codebase deep-dives, at least one required, combinable
 *   [any combination]
 * reference/                       detailed reference material (conditional)
 * maintainers.md                   ownership mapping (conditional)
 * ```
 *
 * ## Refresh policy
 *
 *   always       — regenerate every refresh (`by-the-numbers.md`)
 *   on-delta     — regenerate only on substantial code change (`lore.md`)
 *   on-demand    — author or refresh-once content; never auto-overwritten
 *
 * ## What this module is and isn't
 *
 * Pure data shape + page validation. No I/O, no rendering, no GitHub
 * sync; the refresh runner in part 2 of #2664 consumes this schema to
 * decide which pages need regeneration.
 */

/** Refresh cadence for a wiki page. */
export type WikiRefreshPolicy = "always" | "on-delta" | "on-demand";

/** Whether the page is always present, conditional, or a lens. */
export type WikiPagePresence = "always-present" | "conditional" | "lens";

/** One entry in the canonical wiki tree. */
export interface WikiPage {
	/** Relative path under the wiki root. */
	path: string;
	/** Human-readable section title. */
	title: string;
	/** One-line description of the page's purpose. */
	description: string;
	/** Logical section the page belongs to. */
	section: "overview" | "how-to-contribute" | "lenses" | "reference" | "root";
	/** Presence rule. */
	presence: WikiPagePresence;
	/** Refresh cadence. */
	refresh: WikiRefreshPolicy;
	/**
	 * `true` if the page is always rendered as a single file. `false` allows
	 * the page to expand into a directory with sub-pages as the project grows.
	 */
	atomic: boolean;
}

/**
 * Canonical page set every maestro wiki ships with. The agent renders
 * these in this exact order in the table of contents.
 */
export const BUILTIN_WIKI_PAGES: readonly WikiPage[] = [
	{
		path: "overview/index.md",
		title: "Overview",
		description:
			"Project overview: what it does, who uses it, quick links to the deepest dives.",
		section: "overview",
		presence: "always-present",
		refresh: "on-delta",
		atomic: true,
	},
	{
		path: "overview/architecture.md",
		title: "Architecture",
		description:
			"System architecture with Mermaid diagrams covering services, data flow, and boundaries.",
		section: "overview",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "overview/getting-started.md",
		title: "Getting started",
		description: "Prerequisites, install, build, test, run.",
		section: "overview",
		presence: "always-present",
		refresh: "on-delta",
		atomic: true,
	},
	{
		path: "overview/glossary.md",
		title: "Glossary",
		description: "Project-specific terms and domain vocabulary.",
		section: "overview",
		presence: "always-present",
		refresh: "on-delta",
		atomic: true,
	},
	{
		path: "by-the-numbers.md",
		title: "By the numbers",
		description:
			"Codebase statistics snapshot (LOC, files, dependencies, top languages).",
		section: "root",
		presence: "always-present",
		refresh: "always",
		atomic: true,
	},
	{
		path: "lore.md",
		title: "Lore",
		description:
			"Timeline + history. Refresh only on substantial change (major rewrite, new subsystem, deprecation).",
		section: "root",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "fun-facts.md",
		title: "Fun facts",
		description:
			"Easter eggs, origin stories, oldest code, naming origins. Optional but encouraged.",
		section: "root",
		presence: "conditional",
		refresh: "on-demand",
		atomic: true,
	},
	{
		path: "how-to-contribute/index.md",
		title: "How to contribute",
		description:
			"Work pickup, PR process, review expectations, definition of done.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: true,
	},
	{
		path: "how-to-contribute/development-workflow.md",
		title: "Development workflow",
		description: "Branch → code → test → PR → merge cycle for this repo.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "how-to-contribute/testing.md",
		title: "Testing",
		description: "Frameworks, patterns, how to run / mock / cover tests.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "how-to-contribute/debugging.md",
		title: "Debugging",
		description: "Logs, common errors, troubleshooting runbook.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "how-to-contribute/patterns-and-conventions.md",
		title: "Patterns and conventions",
		description:
			"Error handling, coding style, cross-cutting concerns specific to this repo.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "how-to-contribute/tooling.md",
		title: "Tooling",
		description:
			"Build system, linters, code generators, CI tooling. Promote to top-level if tooling IS the product.",
		section: "how-to-contribute",
		presence: "always-present",
		refresh: "on-delta",
		atomic: false,
	},
	{
		path: "maintainers.md",
		title: "Maintainers",
		description:
			"Ownership mapping (who owns what subsystem). No per-person metrics — those create toxic comparisons.",
		section: "root",
		presence: "conditional",
		refresh: "on-delta",
		atomic: true,
	},
];

/**
 * Lens defaults. At least one lens must be configured per wiki; the
 * concrete lens set is repo-specific.
 */
export const DEFAULT_LENS_CATALOG: readonly Pick<
	WikiPage,
	"path" | "title" | "description"
>[] = [
	{
		path: "lenses/performance.md",
		title: "Performance lens",
		description:
			"Hot paths, profiling guidance, latency budgets, scaling notes.",
	},
	{
		path: "lenses/security.md",
		title: "Security lens",
		description:
			"Trust boundaries, sensitive flows, secret handling, threat model entry points.",
	},
	{
		path: "lenses/data-flow.md",
		title: "Data flow lens",
		description:
			"How data enters, transforms, and exits the system. Schema boundaries and consistency expectations.",
	},
	{
		path: "lenses/onboarding.md",
		title: "Onboarding lens",
		description:
			"What a new contributor needs to know first: the 80/20 of the codebase they'll touch.",
	},
];

const VALID_SECTIONS = new Set<WikiPage["section"]>([
	"overview",
	"how-to-contribute",
	"lenses",
	"reference",
	"root",
]);
const VALID_PRESENCE = new Set<WikiPagePresence>([
	"always-present",
	"conditional",
	"lens",
]);
const VALID_REFRESH = new Set<WikiRefreshPolicy>([
	"always",
	"on-delta",
	"on-demand",
]);

/** Per-validation result envelope. */
export type WikiPageValidation =
	| { ok: true }
	| { ok: false; reasons: string[] };

/**
 * Validate a single page against the canonical schema. Reports every
 * problem in one pass so callers fix the lot rather than one at a time.
 */
export function validateWikiPage(page: WikiPage): WikiPageValidation {
	const reasons: string[] = [];
	const trimmedPath = typeof page.path === "string" ? page.path.trim() : "";
	if (typeof page.path !== "string" || !trimmedPath) {
		reasons.push("path is required");
	} else if (page.path !== trimmedPath) {
		// Reject leading / trailing whitespace before the relative-path
		// check — otherwise " ../etc/passwd" would slip past the
		// startsWith("/") guard and hasParentSegment.
		reasons.push("path must not have leading or trailing whitespace");
	} else if (!page.path.endsWith(".md")) {
		reasons.push("path must end in .md");
	} else if (isAbsoluteWikiPath(page.path) || hasParentSegment(page.path)) {
		reasons.push("path must be relative and not contain a '..' segment");
	}
	if (typeof page.title !== "string" || !page.title.trim()) {
		reasons.push("title is required");
	}
	if (typeof page.description !== "string" || !page.description.trim()) {
		reasons.push("description is required");
	}
	if (!VALID_SECTIONS.has(page.section)) {
		reasons.push(
			`section must be one of: ${Array.from(VALID_SECTIONS).join(", ")}`,
		);
	}
	if (!VALID_PRESENCE.has(page.presence)) {
		reasons.push(
			`presence must be one of: ${Array.from(VALID_PRESENCE).join(", ")}`,
		);
	}
	if (!VALID_REFRESH.has(page.refresh)) {
		reasons.push(
			`refresh must be one of: ${Array.from(VALID_REFRESH).join(", ")}`,
		);
	}
	if (typeof page.atomic !== "boolean") {
		reasons.push("atomic must be a boolean");
	}
	// Lens pages and the lenses section travel together: a page whose
	// section is "lenses" must have presence "lens", and a page with
	// presence "lens" must live in the "lenses" section. Otherwise the
	// helpers that drive lens selection (alwaysPresentPages,
	// summarizeWikiPages) see mismatched metadata.
	if (page.section === "lenses" && page.presence !== "lens") {
		reasons.push(
			`section "lenses" requires presence "lens" (got "${String(page.presence)}")`,
		);
	}
	if (page.presence === "lens" && page.section !== "lenses") {
		reasons.push(
			`presence "lens" requires section "lenses" (got "${String(page.section)}")`,
		);
	}
	// Lens pages must also live under the `lenses/` path prefix so the
	// refresh runner and TOC generator can find them by directory walk.
	// Without this guard a page at `overview/foo.md` could declare
	// section "lenses" + presence "lens" and be treated as the required
	// lens even though it lives in the wrong tree.
	if (
		typeof page.path === "string" &&
		page.section === "lenses" &&
		!/^lenses[/\\]/.test(page.path)
	) {
		reasons.push(
			`section "lenses" requires path to start with "lenses/" (got "${page.path}")`,
		);
	}
	if (
		typeof page.path === "string" &&
		/^lenses[/\\]/.test(page.path) &&
		(page.section !== "lenses" || page.presence !== "lens")
	) {
		reasons.push(
			`path under "lenses/" requires section "lenses" and presence "lens" (got section "${String(page.section)}" and presence "${String(page.presence)}")`,
		);
	}
	if (reasons.length > 0) {
		return { ok: false, reasons };
	}
	return { ok: true };
}

function hasParentSegment(path: string): boolean {
	return path.split(/[/\\]/).some((segment) => segment === "..");
}

function normalizeWikiPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function isAbsoluteWikiPath(path: string): boolean {
	return (
		path.startsWith("/") ||
		path.startsWith("\\") ||
		path.startsWith("~") ||
		/^[A-Za-z]:[\\/]/.test(path)
	);
}

/**
 * Validate the full set of pages a wiki ships with. Catches duplicates,
 * lenses-without-a-lens (the wiki schema requires at least one), and
 * any per-page violations.
 */
export function validateWikiPageSet(
	pages: readonly WikiPage[],
): WikiPageValidation {
	const reasons: string[] = [];
	const seenPaths = new Set<string>();
	for (let i = 0; i < pages.length; i += 1) {
		const page = pages[i];
		if (!page) {
			reasons.push(`pages[${i}]: page is required`);
			continue;
		}
		const result = validateWikiPage(page);
		if (!result.ok) {
			for (const r of result.reasons) {
				reasons.push(`pages[${i}]: ${r}`);
			}
		}
		const normalizedPath =
			typeof page.path === "string" ? normalizeWikiPath(page.path) : undefined;
		if (normalizedPath !== undefined && seenPaths.has(normalizedPath)) {
			reasons.push(`pages[${i}]: path "${page.path}" is duplicated`);
		}
		if (normalizedPath !== undefined) {
			seenPaths.add(normalizedPath);
		}
	}
	const hasLens = pages.some((p) => p?.section === "lenses");
	if (!hasLens) {
		reasons.push("at least one page in section 'lenses' is required");
	}
	if (reasons.length > 0) {
		return { ok: false, reasons };
	}
	return { ok: true };
}

/** Return pages that must be regenerated on every refresh. */
export function pagesAlwaysRefreshed(
	pages: readonly WikiPage[] = BUILTIN_WIKI_PAGES,
): WikiPage[] {
	return pages.filter((p) => p.refresh === "always");
}

/** Return pages refreshed only when the underlying repo state changes substantially. */
export function pagesRefreshedOnDelta(
	pages: readonly WikiPage[] = BUILTIN_WIKI_PAGES,
): WikiPage[] {
	return pages.filter((p) => p.refresh === "on-delta");
}

/** Pages that always appear in the wiki (no opting out). */
export function alwaysPresentPages(
	pages: readonly WikiPage[] = BUILTIN_WIKI_PAGES,
): WikiPage[] {
	return pages.filter((p) => p.presence === "always-present");
}

/** Quick counts by section + presence + refresh for surface UI. */
export function summarizeWikiPages(
	pages: readonly WikiPage[] = BUILTIN_WIKI_PAGES,
): {
	total: number;
	bySection: Record<WikiPage["section"], number>;
	byPresence: Record<WikiPagePresence, number>;
	byRefresh: Record<WikiRefreshPolicy, number>;
} {
	const bySection: Record<WikiPage["section"], number> = {
		overview: 0,
		"how-to-contribute": 0,
		lenses: 0,
		reference: 0,
		root: 0,
	};
	const byPresence: Record<WikiPagePresence, number> = {
		"always-present": 0,
		conditional: 0,
		lens: 0,
	};
	const byRefresh: Record<WikiRefreshPolicy, number> = {
		always: 0,
		"on-delta": 0,
		"on-demand": 0,
	};
	for (const p of pages) {
		bySection[p.section] += 1;
		byPresence[p.presence] += 1;
		byRefresh[p.refresh] += 1;
	}
	return {
		total: pages.length,
		bySection,
		byPresence,
		byRefresh,
	};
}

/**
 * Skill template registry
 *
 * Builds on the scaffolder primitive (part 1 of #2665, merged as
 * #2674). The scaffolder writes a SKILL.md given a name + options;
 * this module owns the canonical set of *templates* the agent + the
 * `/setup-*` slash commands draw from.
 *
 * Each template names a skill family (review, lint, test, ...) and
 * supplies the body, allowed-tools whitelist, and metadata the
 * scaffolder hands straight to `scaffoldSkillWithBody`. The set is
 * pure data: callers can compose, copy, or branch the templates
 * without touching the scaffolder code.
 *
 * What's NOT here: slash command registration, the YAML emitter
 * (those live in `./scaffolder.ts`), no disk I/O. Pure types + a
 * frozen registry.
 */

/** Allowed-tools / builtin-tools entries match the scaffolder option shape. */
export interface SkillTemplate {
	/** Stable id used as the scaffolded skill name (kebab-case). */
	name: string;
	/** Short human-readable description for `/setup-*` discovery. */
	description: string;
	/** Markdown body the scaffolder writes after the frontmatter. */
	body: string;
	/** Optional `allowed-tools` whitelist passed straight to the scaffolder. */
	allowedTools?: string[];
	/** Optional `builtin-tools` list (Maestro-provided tools). */
	builtinTools?: string[];
	/** Optional simple key/value metadata nested under `metadata:`. */
	metadata?: Record<string, string>;
	/**
	 * Tags for `findSkillTemplates({ tag })` queries. Templates are
	 * tagged loosely so consumers can group by category ("review",
	 * "lint", "test", ...) without inventing a new field per cut.
	 */
	tags: string[];
}

/** Slug-keyed lookup for an immutable copy of the registry. */
export interface SkillTemplateLookup {
	byName(name: string): SkillTemplate | undefined;
	list(): SkillTemplate[];
}

const TEMPLATES: readonly SkillTemplate[] = Object.freeze([
	{
		name: "review",
		description:
			"Anchor skill the agent invokes when a reviewer asks for code review or PR comment.",
		body: [
			"# Review skill",
			"",
			"Use this skill when a teammate asks for a review of a diff, PR, or",
			"branch.",
			"",
			"## Process",
			"",
			"1. Read the diff end-to-end before commenting on anything.",
			"2. Identify the top three risks; lead with those.",
			"3. Match the project's review tone — terse, direct, no praise filler.",
			"4. Defer style nits to the linter where it covers them.",
		].join("\n"),
		allowedTools: ["read", "search", "gh_pr"],
		tags: ["review", "anchor"],
	},
	{
		name: "review-guidelines",
		description:
			"Repository-specific review guidelines that get spliced into the review skill at activation time.",
		body: [
			"# Review guidelines",
			"",
			"_Document this repository's review expectations here._",
			"",
			"- Linked issue or ticket required on every PR.",
			"- Tests must exist for every behavioral change.",
			"- Public mirror changes need the public-release-mirror label.",
		].join("\n"),
		tags: ["review", "guidelines"],
	},
	{
		name: "lint",
		description:
			"Run the project's linters and surface findings as actionable bullets.",
		body: [
			"# Lint skill",
			"",
			"Use this skill when the reviewer asks for a lint pass.",
			"",
			"## Process",
			"",
			"1. Run `bun run bun:lint` (or the project's equivalent).",
			"2. Group findings by file + severity.",
			"3. Quote the offending line and propose a fix in-line.",
		].join("\n"),
		allowedTools: ["bash", "read"],
		tags: ["lint", "tooling"],
	},
	{
		name: "test",
		description:
			"Run the test suite (or a filtered subset) and report failures with the smallest reproduction.",
		body: [
			"# Test skill",
			"",
			"Use this skill when the reviewer asks for tests to be run or a",
			"specific failure investigated.",
			"",
			"## Process",
			"",
			"1. Default to `npx nx run maestro:test --skip-nx-cache`.",
			"2. For targeted runs use `bunx vitest --run -t '<name>'`.",
			"3. Report passes inline and failures with the smallest reproduction.",
		].join("\n"),
		allowedTools: ["bash", "read"],
		tags: ["test", "tooling"],
	},
	{
		name: "release-notes",
		description:
			"Draft release notes from git log + PR titles, grouped by category.",
		body: [
			"# Release notes skill",
			"",
			"Use this skill when the reviewer asks for release notes.",
			"",
			"## Process",
			"",
			"1. `gh pr list --search 'merged:>=<date>'` for the window.",
			"2. Group by `[maestro]`, `[codex]`, `fix(*)`, etc.",
			"3. Keep entries to one sentence; link to PR.",
		].join("\n"),
		allowedTools: ["bash", "gh_pr"],
		tags: ["release", "docs"],
	},
]);

/** Canonical set of templates the agent ships out of the box. */
export const SKILL_TEMPLATES: readonly SkillTemplate[] = TEMPLATES;

/**
 * Find a template by `name` (case-sensitive). Returns `undefined` if
 * no template matches.
 */
export function findSkillTemplate(name: string): SkillTemplate | undefined {
	if (typeof name !== "string") return undefined;
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return TEMPLATES.find((t) => t.name === trimmed);
}

/** Filter options for `findSkillTemplates`. */
export interface FindSkillTemplatesOptions {
	/** Only include templates carrying every tag listed here. */
	tags?: string[];
	/**
	 * Optional substring match against `name` or `description`
	 * (case-insensitive). Empty/whitespace ignored.
	 */
	search?: string;
}

/**
 * Filter the registry. Stable result order: matches the registry
 * declaration order (the canonical ordering callers see in
 * `SKILL_TEMPLATES`).
 */
export function findSkillTemplates(
	options: FindSkillTemplatesOptions = {},
): SkillTemplate[] {
	const tags = options.tags?.filter((t) => t.trim().length > 0) ?? [];
	const search = options.search?.toLowerCase().trim() ?? "";
	return TEMPLATES.filter((t) => {
		if (tags.length > 0 && !tags.every((tag) => t.tags.includes(tag))) {
			return false;
		}
		if (search) {
			const haystack = `${t.name} ${t.description}`.toLowerCase();
			if (!haystack.includes(search)) return false;
		}
		return true;
	});
}

/** Build a slug-keyed lookup over a custom registry. */
export function makeSkillTemplateLookup(
	templates: readonly SkillTemplate[],
): SkillTemplateLookup {
	const byName = new Map<string, SkillTemplate>();
	for (const template of templates) {
		if (byName.has(template.name)) {
			throw new Error(
				`makeSkillTemplateLookup: duplicate template name "${template.name}"`,
			);
		}
		byName.set(template.name, template);
	}
	return {
		byName: (name) => byName.get(name),
		list: () => [...templates],
	};
}

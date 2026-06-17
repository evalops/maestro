import { describe, expect, it } from "vitest";
import {
	BUILTIN_WIKI_PAGES,
	DEFAULT_LENS_CATALOG,
	type WikiPage,
	alwaysPresentPages,
	pagesAlwaysRefreshed,
	pagesRefreshedOnDelta,
	summarizeWikiPages,
	validateWikiPage,
	validateWikiPageSet,
} from "../../src/agent/wiki-schema.js";

describe("agent/wiki-schema", () => {
	describe("BUILTIN_WIKI_PAGES", () => {
		it("includes every always-present page from the canonical tree", () => {
			const paths = BUILTIN_WIKI_PAGES.map((p) => p.path);
			expect(paths).toContain("overview/index.md");
			expect(paths).toContain("overview/architecture.md");
			expect(paths).toContain("overview/getting-started.md");
			expect(paths).toContain("overview/glossary.md");
			expect(paths).toContain("by-the-numbers.md");
			expect(paths).toContain("lore.md");
			expect(paths).toContain("how-to-contribute/index.md");
			expect(paths).toContain("how-to-contribute/development-workflow.md");
			expect(paths).toContain("how-to-contribute/testing.md");
			expect(paths).toContain("how-to-contribute/debugging.md");
			expect(paths).toContain("how-to-contribute/patterns-and-conventions.md");
			expect(paths).toContain("how-to-contribute/tooling.md");
		});

		it("marks by-the-numbers as always-refreshed", () => {
			const byTheNumbers = BUILTIN_WIKI_PAGES.find(
				(p) => p.path === "by-the-numbers.md",
			);
			expect(byTheNumbers?.refresh).toBe("always");
		});

		it("marks lore as on-delta-refreshed", () => {
			const lore = BUILTIN_WIKI_PAGES.find((p) => p.path === "lore.md");
			expect(lore?.refresh).toBe("on-delta");
		});

		it("marks fun-facts and maintainers as conditional / on-demand", () => {
			const funFacts = BUILTIN_WIKI_PAGES.find(
				(p) => p.path === "fun-facts.md",
			);
			expect(funFacts?.presence).toBe("conditional");
			expect(funFacts?.refresh).toBe("on-demand");
			const maintainers = BUILTIN_WIKI_PAGES.find(
				(p) => p.path === "maintainers.md",
			);
			expect(maintainers?.presence).toBe("conditional");
		});

		it("marks single-file pages as atomic and expandable pages as non-atomic", () => {
			const index = BUILTIN_WIKI_PAGES.find(
				(p) => p.path === "overview/index.md",
			);
			expect(index?.atomic).toBe(true);
			const arch = BUILTIN_WIKI_PAGES.find(
				(p) => p.path === "overview/architecture.md",
			);
			expect(arch?.atomic).toBe(false);
		});

		it("has unique paths across the canonical set", () => {
			const paths = BUILTIN_WIKI_PAGES.map((p) => p.path);
			expect(new Set(paths).size).toBe(paths.length);
		});
	});

	describe("DEFAULT_LENS_CATALOG", () => {
		it("ships at least one example lens", () => {
			expect(DEFAULT_LENS_CATALOG.length).toBeGreaterThan(0);
			for (const lens of DEFAULT_LENS_CATALOG) {
				expect(lens.path.startsWith("lenses/")).toBe(true);
				expect(lens.title.length).toBeGreaterThan(0);
			}
		});
	});

	describe("validateWikiPage", () => {
		const goodPage: WikiPage = {
			path: "overview/index.md",
			title: "Overview",
			description: "Project overview.",
			section: "overview",
			presence: "always-present",
			refresh: "on-delta",
			atomic: true,
		};

		it("accepts a well-formed page", () => {
			expect(validateWikiPage(goodPage).ok).toBe(true);
		});

		it("rejects paths that don't end in .md", () => {
			const result = validateWikiPage({ ...goodPage, path: "overview/index" });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("path must end in .md");
			}
		});

		it("rejects absolute or traversal paths", () => {
			expect(validateWikiPage({ ...goodPage, path: "/abs/index.md" }).ok).toBe(
				false,
			);
			expect(validateWikiPage({ ...goodPage, path: "../escape.md" }).ok).toBe(
				false,
			);
		});

		it("rejects paths with leading or trailing whitespace", () => {
			// Without this guard, " ../etc/passwd.md" slips past the
			// startsWith("/") check + hasParentSegment because the leading
			// space breaks the prefix match.
			expect(validateWikiPage({ ...goodPage, path: " ../escape.md" }).ok).toBe(
				false,
			);
			expect(validateWikiPage({ ...goodPage, path: "page.md " }).ok).toBe(
				false,
			);
		});

		it("rejects Windows absolute paths", () => {
			expect(
				validateWikiPage({ ...goodPage, path: "C:\\abs\\index.md" }).ok,
			).toBe(false);
			expect(
				validateWikiPage({ ...goodPage, path: "\\abs\\index.md" }).ok,
			).toBe(false);
			expect(
				validateWikiPage({ ...goodPage, path: "\\\\server\\share\\page.md" })
					.ok,
			).toBe(false);
		});
		it("rejects unknown sections, presence, refresh values", () => {
			const result = validateWikiPage({
				...goodPage,
				section: "bogus" as never,
				presence: "bogus" as never,
				refresh: "bogus" as never,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.length).toBeGreaterThanOrEqual(3);
			}
		});

		it("requires title and description", () => {
			expect(validateWikiPage({ ...goodPage, title: "  " }).ok).toBe(false);
			expect(validateWikiPage({ ...goodPage, description: "" }).ok).toBe(false);
		});

		it("requires atomic to be a boolean", () => {
			expect(validateWikiPage({ ...goodPage, atomic: "yes" as never }).ok).toBe(
				false,
			);
		});

		it("requires section 'lenses' to pair with presence 'lens'", () => {
			const result = validateWikiPage({
				...goodPage,
				path: "lenses/x.md",
				section: "lenses",
				presence: "always",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/section "lenses" requires presence "lens"/,
				);
			}
		});

		it("requires presence 'lens' to pair with section 'lenses'", () => {
			const result = validateWikiPage({
				...goodPage,
				section: "guides",
				presence: "lens",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/presence "lens" requires section "lenses"/,
				);
			}
		});

		it("requires section 'lenses' pages to live under the lenses/ path prefix", () => {
			const result = validateWikiPage({
				...goodPage,
				path: "overview/sneaky.md",
				section: "lenses",
				presence: "lens",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/section "lenses" requires path to start with "lenses\/"/,
				);
			}
		});

		it("requires pages under lenses/ to use the lens section/presence pairing", () => {
			const result = validateWikiPage({
				...goodPage,
				path: "lenses/sneaky.md",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/path under "lenses\/" requires section "lenses" and presence "lens"/,
				);
			}
		});

		it("treats backslash paths under the lenses tree as lens pages too", () => {
			const result = validateWikiPage({
				...goodPage,
				path: "lenses\\sneaky.md",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.join(" ")).toMatch(
					/path under "lenses\/" requires section "lenses" and presence "lens"/,
				);
			}
		});

		it("accepts a correctly-tagged lens page with backslash separators", () => {
			// Pre-fix: the section-lenses guard used startsWith("lenses/")
			// only, so a properly-tagged page at "lenses\foo.md" failed
			// the path-prefix check while the backslash-aware guard
			// elsewhere accepted it — an internally inconsistent reject.
			expect(
				validateWikiPage({
					...goodPage,
					path: "lenses\\foo.md",
					section: "lenses",
					presence: "lens",
				}).ok,
			).toBe(true);
		});

		it("accepts filenames whose path contains '..' but no parent segment", () => {
			// Pre-fix: `path.includes("..")` rejected this even though it's
			// just a filename with two consecutive dots — no traversal.
			expect(
				validateWikiPage({
					...goodPage,
					path: "lenses/foo..bar.md",
					section: "lenses",
					presence: "lens",
				}).ok,
			).toBe(true);
		});

		it("still rejects paths with a real '..' parent segment", () => {
			expect(validateWikiPage({ ...goodPage, path: "../escape.md" }).ok).toBe(
				false,
			);
			expect(
				validateWikiPage({ ...goodPage, path: "foo/../escape.md" }).ok,
			).toBe(false);
		});
	});

	describe("validateWikiPageSet", () => {
		it("accepts the canonical set when at least one lens is included", () => {
			const withLens: WikiPage[] = [
				...BUILTIN_WIKI_PAGES,
				{
					path: "lenses/security.md",
					title: "Security lens",
					description: "Security-focused deep dive.",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
			];
			expect(validateWikiPageSet(withLens).ok).toBe(true);
		});

		it("rejects the canonical set without any lens", () => {
			const result = validateWikiPageSet(BUILTIN_WIKI_PAGES);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.some((r) => r.includes("lenses"))).toBe(true);
			}
		});

		it("returns validation errors instead of throwing on nullish entries", () => {
			const result = validateWikiPageSet([undefined] as unknown as WikiPage[]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("pages[0]: page is required");
				expect(result.reasons).toContain(
					"at least one page in section 'lenses' is required",
				);
			}
		});

		it("rejects nullish entries even when another page satisfies the lens requirement", () => {
			const result = validateWikiPageSet([
				{
					path: "lenses/security.md",
					title: "Security lens",
					description: "Security-focused deep dive.",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
				undefined,
			] as unknown as WikiPage[]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("pages[1]: page is required");
			}
		});

		it("flags duplicate paths", () => {
			const dup: WikiPage[] = [
				...BUILTIN_WIKI_PAGES,
				{
					path: "lenses/x.md",
					title: "x",
					description: "x",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
				{
					path: "lenses/x.md",
					title: "x dup",
					description: "x dup",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
			];
			const result = validateWikiPageSet(dup);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons.some((r) => r.includes("duplicated"))).toBe(true);
			}
		});

		it("flags duplicate paths when slash variants point to the same lens page", () => {
			const result = validateWikiPageSet([
				...BUILTIN_WIKI_PAGES,
				{
					path: "lenses/x.md",
					title: "x",
					description: "x",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
				{
					path: "lenses\\x.md",
					title: "x dup",
					description: "x dup",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
			]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain(
					'pages[15]: path "lenses\\x.md" is duplicated',
				);
			}
		});

		it("rejects non-lens metadata on pages under the lenses/ tree", () => {
			const result = validateWikiPageSet([
				...BUILTIN_WIKI_PAGES,
				{
					path: "lenses/security.md",
					title: "Security lens",
					description: "Security-focused deep dive.",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
				{
					path: "lenses/sneaky.md",
					title: "Sneaky",
					description: "Mis-tagged page under the lenses tree.",
					section: "overview",
					presence: "always-present",
					refresh: "on-delta",
					atomic: true,
				},
			]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.reasons.some((r) =>
						r.includes(
							'path under "lenses/" requires section "lenses" and presence "lens"',
						),
					),
				).toBe(true);
			}
		});

		it("rejects non-lens metadata on backslash paths under the lenses tree", () => {
			const result = validateWikiPageSet([
				...BUILTIN_WIKI_PAGES,
				{
					path: "lenses/security.md",
					title: "Security lens",
					description: "Security-focused deep dive.",
					section: "lenses",
					presence: "lens",
					refresh: "on-delta",
					atomic: true,
				},
				{
					path: "lenses\\sneaky.md",
					title: "Sneaky",
					description: "Mis-tagged page under the lenses tree.",
					section: "overview",
					presence: "always-present",
					refresh: "on-delta",
					atomic: true,
				},
			]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.reasons.some((r) =>
						r.includes(
							'path under "lenses/" requires section "lenses" and presence "lens"',
						),
					),
				).toBe(true);
			}
		});
	});

	describe("filter helpers", () => {
		it("returns always-refreshed pages", () => {
			const always = pagesAlwaysRefreshed();
			expect(always.some((p) => p.path === "by-the-numbers.md")).toBe(true);
			expect(always.every((p) => p.refresh === "always")).toBe(true);
		});

		it("returns on-delta-refreshed pages", () => {
			const onDelta = pagesRefreshedOnDelta();
			expect(onDelta.some((p) => p.path === "lore.md")).toBe(true);
			expect(onDelta.every((p) => p.refresh === "on-delta")).toBe(true);
		});

		it("returns always-present pages", () => {
			const always = alwaysPresentPages();
			expect(always.length).toBeGreaterThan(0);
			expect(always.every((p) => p.presence === "always-present")).toBe(true);
			expect(always.some((p) => p.path === "overview/index.md")).toBe(true);
		});
	});

	describe("summarizeWikiPages", () => {
		it("counts by section, presence, and refresh", () => {
			const summary = summarizeWikiPages();
			expect(summary.total).toBe(BUILTIN_WIKI_PAGES.length);
			const sectionSum = Object.values(summary.bySection).reduce(
				(a, b) => a + b,
				0,
			);
			expect(sectionSum).toBe(summary.total);
			expect(summary.byRefresh.always).toBeGreaterThan(0);
			expect(summary.byPresence["always-present"]).toBeGreaterThan(0);
		});
	});
});

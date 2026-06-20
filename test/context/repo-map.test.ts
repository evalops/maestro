import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ExtractedSymbol,
	type RepoMap,
	type RepoMapEntry,
	generateRepoContext,
	repoMap,
} from "../../src/context/repo-map.js";

function entry(overrides: Partial<RepoMapEntry>): RepoMapEntry {
	return {
		path: `/abs/${overrides.relativePath ?? "f.ts"}`,
		relativePath: "f.ts",
		size: 100,
		language: "typescript",
		symbols: [],
		importance: 1,
		...overrides,
	};
}

function symbol(overrides: Partial<ExtractedSymbol>): ExtractedSymbol {
	return {
		name: "x",
		kind: "function",
		line: 1,
		exported: false,
		...overrides,
	};
}

function mapOf(entries: RepoMapEntry[]): RepoMap {
	return {
		rootDir: "/repo",
		generatedAt: "2026-01-01T00:00:00.000Z",
		totalFiles: entries.length,
		entries,
		summary: "summary",
	};
}

describe("repo-map — formatForContext (pure)", () => {
	it("renders the header, summary, and groups entries by directory", () => {
		const out = repoMap.formatForContext(
			mapOf([
				entry({ relativePath: "src/a.ts" }),
				entry({ relativePath: "src/b.ts" }),
				entry({ relativePath: "README.md", language: "markdown" }),
			]),
		);
		expect(out).toContain("## Repository Structure");
		expect(out).toContain("summary");
		expect(out).toContain("**src/**");
		expect(out).toContain("- a.ts");
		expect(out).toContain("- b.ts");
		// root-level file lands in "."
		expect(out).toContain("**./**");
		expect(out).toContain("- README.md");
	});

	it("lists exported symbols (top 5) next to the filename", () => {
		const symbols = [1, 2, 3, 4, 5, 6].map((n) =>
			symbol({ name: `fn${n}`, exported: true }),
		);
		const out = repoMap.formatForContext(
			mapOf([entry({ relativePath: "src/lib.ts", symbols })]),
		);
		// only exported, capped at 5
		expect(out).toContain("fn1, fn2, fn3, fn4, fn5");
		expect(out).not.toContain("fn6");
	});

	it("omits the symbol list when nothing is exported", () => {
		const out = repoMap.formatForContext(
			mapOf([
				entry({
					relativePath: "src/internal.ts",
					symbols: [symbol({ name: "hidden", exported: false })],
				}),
			]),
		);
		expect(out).toContain("- internal.ts");
		// no trailing colon-list
		expect(out).not.toContain("internal.ts:");
	});
});

describe("repo-map — getRelevantFiles (pure)", () => {
	const map = mapOf([
		entry({
			relativePath: "src/auth/login.ts",
			symbols: [symbol({ name: "login" })],
		}),
		entry({
			relativePath: "src/db/query.ts",
			symbols: [symbol({ name: "execute" })],
		}),
		entry({ relativePath: "README.md", language: "markdown" }),
	]);

	it("matches by path substring", () => {
		const hits = repoMap.getRelevantFiles(map, "auth");
		expect(hits.map((h) => h.relativePath)).toEqual(["src/auth/login.ts"]);
	});

	it("matches by symbol name (case-insensitive)", () => {
		const hits = repoMap.getRelevantFiles(map, "EXECUTE");
		expect(hits.map((h) => h.relativePath)).toEqual(["src/db/query.ts"]);
	});

	it("matches when any term hits (union)", () => {
		const hits = repoMap.getRelevantFiles(map, "login readme");
		expect(hits.map((h) => h.relativePath).sort()).toEqual([
			"README.md",
			"src/auth/login.ts",
		]);
	});

	it("returns nothing for an unrelated query", () => {
		expect(repoMap.getRelevantFiles(map, "nonexistentXYZ")).toEqual([]);
	});
});

describe("repo-map — generate (filesystem)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "repomap-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("walks the root, collects entries, and returns a structured map", async () => {
		await writeFile(join(dir, "a.ts"), "export function alpha() {}\n");
		await writeFile(join(dir, "b.ts"), "export const beta = 1;\n");
		const map = await repoMap.generate({ rootDir: dir, maxTokens: 4000 });
		expect(map.rootDir).toBe(dir);
		expect(map.totalFiles).toBe(2);
		expect(map.entries.length).toBe(2);
		const paths = map.entries.map((e) => e.relativePath).sort();
		expect(paths).toEqual(["a.ts", "b.ts"]);
		expect(map.summary).toContain("2/2 files mapped");
	});

	it("respects the token budget by truncating entries", async () => {
		// many files, tiny budget -> not all included
		for (let i = 0; i < 10; i++) {
			await writeFile(join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
		}
		const map = await repoMap.generate({ rootDir: dir, maxTokens: 1 });
		expect(map.entries.length).toBeLessThan(10);
		expect(map.totalFiles).toBe(10); // total scanned, not just included
	});

	it("generateRepoContext() produces context text end-to-end", async () => {
		await writeFile(join(dir, "mod.ts"), "export function thing() {}\n");
		const ctx = await generateRepoContext(dir);
		expect(ctx).toContain("## Repository Structure");
		expect(ctx).toContain("mod.ts");
	});
});

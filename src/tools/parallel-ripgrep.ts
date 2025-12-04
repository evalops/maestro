/**
 * Parallel Ripgrep Tool
 *
 * This tool enables searching for multiple regex patterns simultaneously
 * across a codebase. Unlike running separate ripgrep searches, this tool:
 *
 * 1. Runs all pattern searches in parallel for performance
 * 2. Merges overlapping line ranges to avoid duplicate context
 * 3. Returns consolidated results with per-pattern attribution
 *
 * Use cases:
 * - Finding function definitions AND their usages
 * - Searching for multiple related patterns (e.g., import + export)
 * - Finding all occurrences of related symbols
 *
 * The merging algorithm:
 * 1. Each pattern search returns line matches with context
 * 2. Matches are grouped by file
 * 3. Overlapping/adjacent ranges within a file are merged
 * 4. Final output shows which patterns matched each range
 */

import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import {
	globSchema,
	parseRipgrepJson,
	pathSchema,
	runRipgrep,
	toArray,
} from "./ripgrep-utils.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

/** Maximum number of line ranges to include in detailed output */
const RANGE_DETAIL_LIMIT = 200;
/** Default max matches per pattern (prevents runaway searches) */
const DEFAULT_MAX_RESULTS = 500;

const parallelRipgrepSchema = Type.Object({
	patterns: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 10,
		description:
			"Regex patterns to search for in parallel (1-10). Results are merged when matches overlap.",
	}),
	paths: pathSchema,
	glob: globSchema,
	ignoreCase: Type.Optional(
		Type.Boolean({
			description: "Case-insensitive search (-i) for all patterns",
			default: false,
		}),
	),
	literal: Type.Optional(
		Type.Boolean({
			description:
				"Treat patterns as literal strings, not regex (--fixed-strings)",
			default: false,
		}),
	),
	word: Type.Optional(
		Type.Boolean({
			description: "Match whole words only (-w)",
			default: false,
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description: "Enable multiline matching (--multiline)",
			default: false,
		}),
	),
	maxResults: Type.Optional(
		Type.Integer({
			description: "Max matches per pattern (-m)",
			minimum: 1,
			maximum: 1000,
		}),
	),
	context: Type.Optional(
		Type.Integer({
			description: "Lines of context before and after each match (-C)",
			minimum: 0,
			maximum: 20,
		}),
	),
	beforeContext: Type.Optional(
		Type.Integer({
			description: "Lines of context before each match (-B)",
			minimum: 0,
			maximum: 20,
		}),
	),
	afterContext: Type.Optional(
		Type.Integer({
			description: "Lines of context after each match (-A)",
			minimum: 0,
			maximum: 20,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for ripgrep",
			minLength: 1,
		}),
	),
	includeHidden: Type.Optional(
		Type.Boolean({
			description: "Include hidden files (--hidden)",
			default: false,
		}),
	),
	useGitIgnore: Type.Optional(
		Type.Boolean({
			description: "Respect .gitignore (false to pass --no-ignore)",
			default: true,
		}),
	),
	headLimit: Type.Optional(
		Type.Integer({
			description: "Max number of merged line ranges to return",
			minimum: 1,
			maximum: RANGE_DETAIL_LIMIT,
		}),
	),
});

/**
 * A single merged line range with its content.
 * Represents a contiguous block of lines that matched one or more patterns.
 */
type RangeDetail = {
	/** Relative path to the file */
	file: string;
	/** First line number (1-based) */
	start: number;
	/** Last line number (1-based, inclusive) */
	end: number;
	/** List of patterns that matched within this range */
	patterns: string[];
	/** Actual content of the lines */
	content: string;
};

/**
 * Detailed output from the parallel ripgrep tool.
 * Includes both summary statistics and the full range details.
 */
type ParallelRipgrepDetails = {
	/** The ripgrep commands that were executed */
	commands: string[];
	/** Working directory for the search */
	cwd: string;
	/** Total number of individual matches across all patterns */
	matchCount: number;
	/** Number of merged line ranges in output */
	rangeCount: number;
	/** The merged and deduplicated line ranges */
	ranges: RangeDetail[];
	/** Whether output was truncated due to limits */
	truncated: boolean;
};

/**
 * Merge overlapping or adjacent line ranges within a single file.
 *
 * This is the core deduplication logic. Given ranges like:
 *   [1-5, 3-8, 10-12]
 * It produces:
 *   [1-8, 10-12]
 *
 * Ranges are considered mergeable if they overlap or are exactly adjacent
 * (e.g., 1-5 and 6-10 merge to 1-10).
 *
 * Pattern sets are unioned when ranges merge.
 */
function mergeRanges(
	ranges: Array<{ start: number; end: number; patterns: Set<string> }>,
): Array<{
	start: number;
	end: number;
	patterns: Set<string>;
}> {
	// Sort by start line to enable single-pass merging
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number; patterns: Set<string> }> =
		[];

	for (const range of sorted) {
		const last = merged.at(-1);
		// Check if this range overlaps or is adjacent to the previous one
		// (start <= end + 1 allows for adjacent ranges to merge)
		if (last && range.start <= last.end + 1) {
			// Extend the previous range and merge patterns
			last.end = Math.max(last.end, range.end);
			for (const pattern of range.patterns) {
				last.patterns.add(pattern);
			}
		} else {
			// Start a new merged range
			merged.push({
				start: range.start,
				end: range.end,
				patterns: new Set(range.patterns),
			});
		}
	}

	return merged;
}

/**
 * Read file contents for each merged range and build detailed output.
 *
 * This function:
 * 1. Sorts ranges by file then line number for consistent output
 * 2. Reads file contents (with caching to avoid re-reading)
 * 3. Extracts the actual line content for each range
 * 4. Applies the limit to avoid excessive output
 *
 * @param commandCwd - Working directory to resolve relative paths
 * @param ranges - The merged ranges to populate with content
 * @param limit - Maximum number of ranges to include
 */
async function buildRangeContent(
	commandCwd: string,
	ranges: Array<{
		file: string;
		start: number;
		end: number;
		patterns: Set<string>;
	}>,
	limit: number,
): Promise<{ ranges: RangeDetail[]; truncated: boolean }> {
	// Sort for deterministic output: by file, then by line number
	const mergedRanges = ranges.sort((a, b) => {
		if (a.file === b.file) {
			return a.start - b.start;
		}
		return a.file.localeCompare(b.file);
	});

	const truncated = mergedRanges.length > limit;
	const selected = mergedRanges.slice(0, limit);

	// Cache file contents to avoid re-reading the same file multiple times
	const fileCache = new Map<string, string[]>();
	const results: RangeDetail[] = [];

	for (const range of selected) {
		const absolutePath = resolvePath(commandCwd, range.file);
		let lines: string[];

		// Check cache first
		if (fileCache.has(absolutePath)) {
			lines = fileCache.get(absolutePath) as string[];
		} else {
			try {
				const content = await fs.readFile(absolutePath, "utf-8");
				lines = content.split(/\r?\n/);
				fileCache.set(absolutePath, lines);
			} catch {
				// Skip files that can't be read (deleted, permissions, etc.)
				continue;
			}
		}

		// Clamp range to actual file bounds
		const start = Math.max(1, range.start);
		const end = Math.min(range.end, lines.length);
		if (end < start) {
			continue;
		}

		// Extract the content (lines array is 0-indexed, our ranges are 1-indexed)
		const snippet = lines.slice(start - 1, end).join("\n");
		results.push({
			file: range.file,
			start,
			end,
			patterns: Array.from(range.patterns).sort(),
			content: snippet,
		});
	}

	return { ranges: results, truncated };
}

export const parallelRipgrepTool = createTool<
	typeof parallelRipgrepSchema,
	ParallelRipgrepDetails
>({
	name: "parallel_ripgrep",
	label: "parallel_ripgrep",
	description:
		"Search for multiple patterns simultaneously. Runs ripgrep queries in parallel, automatically merges overlapping line ranges, and returns consolidated content. Ideal for finding related code (e.g., function definitions AND usages) or multiple related patterns without duplicate context.",
	schema: parallelRipgrepSchema,
	async run(params, { signal, respond }) {
		const {
			patterns,
			paths,
			glob,
			ignoreCase,
			literal,
			word,
			multiline,
			maxResults,
			context,
			beforeContext,
			afterContext,
			cwd,
			includeHidden,
			useGitIgnore = true,
			headLimit,
		} = params;

		if (
			context !== undefined &&
			(beforeContext !== undefined || afterContext !== undefined)
		) {
			throw new Error(
				"Use either context or before/after context options, not both.",
			);
		}

		const pathArgs = toArray(paths);
		const globArgs = toArray(glob);
		const commandCwd = cwd ? resolvePath(expandUserPath(cwd)) : process.cwd();
		const before = beforeContext ?? context ?? 0;
		const after = afterContext ?? context ?? 0;

		const baseArgs: string[] = [
			"--color=never",
			"--json",
			"-n",
			"--with-filename",
		];

		if (ignoreCase) {
			baseArgs.push("-i");
		}

		if (literal) {
			baseArgs.push("--fixed-strings");
		}

		if (word) {
			baseArgs.push("-w");
		}

		if (multiline) {
			baseArgs.push("--multiline");
		}

		if (includeHidden) {
			baseArgs.push("--hidden");
		}

		if (!useGitIgnore) {
			baseArgs.push("--no-ignore");
		}

		const effectiveMaxResults = maxResults ?? DEFAULT_MAX_RESULTS;
		baseArgs.push("-m", String(effectiveMaxResults));

		if (context !== undefined) {
			baseArgs.push(`-C${context}`);
		}

		if (beforeContext !== undefined) {
			baseArgs.push(`-B${beforeContext}`);
		}

		if (afterContext !== undefined) {
			baseArgs.push(`-A${afterContext}`);
		}

		for (const globPattern of globArgs) {
			baseArgs.push("--glob", globPattern);
		}

		if (pathArgs.length === 0) {
			pathArgs.push(".");
		}

		const commands: string[] = [];
		let truncatedByBytes = false;
		const ripgrepCalls = patterns.map(async (pattern) => {
			const args = [...baseArgs, "--", pattern, ...pathArgs];
			commands.push(["rg", ...args].join(" "));
			const result = await runRipgrep(args, signal, commandCwd);
			truncatedByBytes ||= result.truncated;
			return { pattern, result };
		});

		let results: Array<{
			pattern: string;
			result: Awaited<ReturnType<typeof runRipgrep>>;
		}>;
		try {
			results = await Promise.all(ripgrepCalls);
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown error: ${String(error)}`;
			return respond.text(`ripgrep failed\n\n${reason}`).detail({
				commands,
				cwd: commandCwd,
				matchCount: 0,
				rangeCount: 0,
				ranges: [],
				truncated: false,
			});
		}

		let matchCount = 0;
		const rangesByFile = new Map<
			string,
			Array<{ start: number; end: number; patterns: Set<string> }>
		>();

		for (const { pattern, result } of results) {
			if (result.exitCode === 2) {
				const message = result.stderr.trim() || result.stdout.trim();
				throw new Error(
					message.length > 0 ? message : "ripgrep exited with an error",
				);
			}

			if (result.exitCode === 1 || result.stdout.trim().length === 0) {
				continue;
			}

			const matches = parseRipgrepJson(result.stdout);
			matchCount += matches.length;

			for (const match of matches) {
				const start = Math.max(1, match.line - before);
				const end = match.line + after;
				const ranges = rangesByFile.get(match.file) ?? [];
				ranges.push({ start, end, patterns: new Set([pattern]) });
				rangesByFile.set(match.file, ranges);
			}
		}

		if (matchCount === 0) {
			return respond.text("No matches found.").detail({
				commands,
				cwd: commandCwd,
				matchCount,
				rangeCount: 0,
				ranges: [],
				truncated: false,
			});
		}

		const mergedRanges: Array<{
			file: string;
			start: number;
			end: number;
			patterns: Set<string>;
		}> = [];
		for (const [file, ranges] of rangesByFile.entries()) {
			for (const range of mergeRanges(ranges)) {
				mergedRanges.push({
					file,
					start: range.start,
					end: range.end,
					patterns: range.patterns,
				});
			}
		}

		const rangeLimit = headLimit ?? RANGE_DETAIL_LIMIT;
		const { ranges, truncated } = await buildRangeContent(
			commandCwd,
			mergedRanges,
			rangeLimit,
		);

		const fileCount = new Set(ranges.map((range) => range.file)).size;
		const summaryLines = ranges
			.map((range) => {
				const header = `${range.file}:${range.start}-${range.end} [${range.patterns.join(", ")}]:`;
				return `${header}\n${range.content}`;
			})
			.join("\n\n");

		const truncatedNote = truncated
			? `\n\n... (showing ${ranges.length} of ${mergedRanges.length} ranges)`
			: truncatedByBytes
				? "\n\n... (output truncated due to size limit)"
				: "";

		return respond
			.text(
				`Found ${matchCount} match(es) across ${fileCount} file(s) for ${patterns.length} pattern(s). Extracted ${mergedRanges.length} line range(s).\n\n${summaryLines}${truncatedNote}`,
			)
			.detail({
				commands,
				cwd: commandCwd,
				matchCount,
				rangeCount: mergedRanges.length,
				ranges,
				truncated: truncated || truncatedByBytes,
			});
	},
});

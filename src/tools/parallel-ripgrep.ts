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

const RANGE_DETAIL_LIMIT = 200;

const parallelRipgrepSchema = Type.Intersect([
	Type.Object({
		patterns: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			maxItems: 10,
			description: "Multiple regex patterns to search for",
		}),
		paths: pathSchema,
		glob: globSchema,
		ignoreCase: Type.Optional(
			Type.Boolean({
				description: "Perform case-insensitive search (-i) for all patterns.",
				default: false,
			}),
		),
		literal: Type.Optional(
			Type.Boolean({
				description: "Treat all patterns as literal strings (--fixed-strings).",
				default: false,
			}),
		),
		word: Type.Optional(
			Type.Boolean({
				description: "Match only whole words (-w).",
				default: false,
			}),
		),
		multiline: Type.Optional(
			Type.Boolean({
				description: "Enable multiline matching (--multiline).",
				default: false,
			}),
		),
		maxResults: Type.Optional(
			Type.Integer({
				description: "Stop after this many matches per pattern (-m).",
				minimum: 1,
				maximum: 1000,
			}),
		),
		context: Type.Optional(
			Type.Integer({
				description: "Lines of context before/after each match (-C).",
				minimum: 0,
				maximum: 20,
			}),
		),
		beforeContext: Type.Optional(
			Type.Integer({
				description: "Lines of context before each match (-B).",
				minimum: 0,
				maximum: 20,
			}),
		),
		afterContext: Type.Optional(
			Type.Integer({
				description: "Lines of context after each match (-A).",
				minimum: 0,
				maximum: 20,
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory to run ripgrep from",
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
				description: "Respect .gitignore (set false to pass --no-ignore)",
				default: true,
			}),
		),
		headLimit: Type.Optional(
			Type.Integer({
				description: "Limit number of line ranges returned",
				minimum: 1,
				maximum: RANGE_DETAIL_LIMIT,
			}),
		),
	}),
	Type.Object(
		{},
		{
			description:
				"Runs ripgrep for multiple patterns in parallel and returns merged line ranges with content.",
		},
	),
]);

type RangeDetail = {
	file: string;
	start: number;
	end: number;
	patterns: string[];
	content: string;
};

type ParallelRipgrepDetails = {
	commands: string[];
	cwd: string;
	matchCount: number;
	rangeCount: number;
	ranges: RangeDetail[];
	truncated: boolean;
};

function mergeRanges(
	ranges: Array<{ start: number; end: number; patterns: Set<string> }>,
): Array<{
	start: number;
	end: number;
	patterns: Set<string>;
}> {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number; patterns: Set<string> }> =
		[];

	for (const range of sorted) {
		const last = merged.at(-1);
		if (last && range.start <= last.end + 1) {
			last.end = Math.max(last.end, range.end);
			for (const pattern of range.patterns) {
				last.patterns.add(pattern);
			}
		} else {
			merged.push({
				start: range.start,
				end: range.end,
				patterns: new Set(range.patterns),
			});
		}
	}

	return merged;
}

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
	const mergedRanges = ranges.sort((a, b) => {
		if (a.file === b.file) {
			return a.start - b.start;
		}
		return a.file.localeCompare(b.file);
	});

	const truncated = mergedRanges.length > limit;
	const selected = mergedRanges.slice(0, limit);
	const fileCache = new Map<string, string[]>();
	const results: RangeDetail[] = [];

	for (const range of selected) {
		const absolutePath = resolvePath(commandCwd, range.file);
		let lines: string[];
		if (fileCache.has(absolutePath)) {
			lines = fileCache.get(absolutePath) as string[];
		} else {
			try {
				const content = await fs.readFile(absolutePath, "utf-8");
				lines = content.split(/\r?\n/);
				fileCache.set(absolutePath, lines);
			} catch {
				continue;
			}
		}

		const start = Math.max(1, range.start);
		const end = Math.min(range.end, lines.length);
		if (end < start) {
			continue;
		}
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
		"Run multiple ripgrep searches in parallel, merge overlapping matches into line ranges, and return their content.",
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

		if (maxResults !== undefined) {
			baseArgs.push("-m", String(maxResults));
		}

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
		const ripgrepCalls = patterns.map(async (pattern) => {
			const args = [...baseArgs, "--", pattern, ...pathArgs];
			commands.push(["rg", ...args].join(" "));
			return { pattern, result: await runRipgrep(args, signal, commandCwd) };
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
				truncated,
			});
	},
});

import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import {
	type RipgrepMatch,
	globSchema,
	parseRipgrepJson,
	pathSchema,
	runRipgrep,
	toArray,
} from "./ripgrep-utils.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

const searchSchema = Type.Intersect([
	Type.Object({
		pattern: Type.String({
			description: "Regex pattern (or literal when literal=true)",
			minLength: 1,
		}),
		paths: pathSchema,
		glob: globSchema,
		ignoreCase: Type.Optional(
			Type.Boolean({
				description: "Perform case-insensitive search (-i).",
				default: false,
			}),
		),
		literal: Type.Optional(
			Type.Boolean({
				description: "Treat the pattern as a literal string (--fixed-strings).",
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
				description: "Stop after this many matches (-m).",
				minimum: 1,
				maximum: 1000,
			}),
		),
		context: Type.Optional(
			Type.Integer({
				description: "Show this many lines of context before and after (-C).",
				minimum: 0,
				maximum: 20,
			}),
		),
		beforeContext: Type.Optional(
			Type.Integer({
				description: "Show this many lines of context before each match (-B).",
				minimum: 0,
				maximum: 20,
			}),
		),
		afterContext: Type.Optional(
			Type.Integer({
				description: "Show this many lines of context after each match (-A).",
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
		outputMode: Type.Optional(
			Type.Union(
				[Type.Literal("content"), Type.Literal("files"), Type.Literal("count")],
				{
					description:
						"Output mode: 'content' shows matching lines (default), 'files' lists only file paths, 'count' shows match counts per file.",
					default: "content",
				},
			),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("text"), Type.Literal("json")], {
				description:
					"Output format for content mode. JSON not supported with files/count modes.",
				default: "text",
			}),
		),
		invertMatch: Type.Optional(
			Type.Boolean({
				description:
					"Show lines that do NOT match the pattern (--invert-match).",
				default: false,
			}),
		),
		onlyMatching: Type.Optional(
			Type.Boolean({
				description:
					"Only show the matched text, not the entire line (--only-matching). Only works with content mode.",
				default: false,
			}),
		),
		headLimit: Type.Optional(
			Type.Integer({
				description:
					"Limit output to first N lines/entries. Useful for sampling large result sets.",
				minimum: 1,
				maximum: 10000,
			}),
		),
	}),
	Type.Object(
		{},
		{
			description:
				"Use either context or before/after context options, not both.",
		},
	),
]);

const JSON_DETAIL_LIMIT = 200;

type SearchToolDetails = {
	command: string;
	cwd: string;
	format?: "text" | "json" | "files" | "count";
	matches?: RipgrepMatch[];
	fileCount?: number;
	files?: string[];
	totalMatches?: number;
	counts?: Array<{ file: string; count: number }>;
	truncated?: boolean;
};

export const searchTool = createTool<typeof searchSchema, SearchToolDetails>({
	name: "search",
	label: "search",
	description: `Find text across files using ripgrep with optional globbing and context controls.

Output modes (outputMode parameter):
- "content": Show matching lines with file:line:content format (default)
- "files": List only file paths containing matches (fast for finding files)
- "count": Show match counts per file (useful for gauging scope)

Modifiers:
- invertMatch: Show lines that do NOT match
- onlyMatching: Show only the matched text (content mode only)
- headLimit: Limit output to first N entries (useful for sampling)

Examples:
  {pattern: "TODO", outputMode: "files"}  → list files containing TODO
  {pattern: "function", outputMode: "count"}  → count functions per file
  {pattern: "^#", invertMatch: true}  → lines not starting with #`,
	schema: searchSchema,
	async run(params, { signal, respond }) {
		const {
			pattern,
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
			outputMode = "content",
			format = "text",
			invertMatch = false,
			onlyMatching = false,
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

		// Validate options incompatible with files/count modes
		if (outputMode !== "content" && onlyMatching) {
			throw new Error(
				"onlyMatching can only be used with outputMode: 'content'.",
			);
		}

		if (
			outputMode !== "content" &&
			(context !== undefined ||
				beforeContext !== undefined ||
				afterContext !== undefined)
		) {
			throw new Error(
				"Context options can only be used with outputMode: 'content'.",
			);
		}

		if (format === "json" && outputMode !== "content") {
			throw new Error(
				"JSON format is not supported with outputMode: 'files' or 'count'. Use format: 'text' or omit the format parameter.",
			);
		}

		const pathArgs = toArray(paths);
		const globArgs = toArray(glob);
		const commandCwd = cwd ? resolvePath(expandUserPath(cwd)) : process.cwd();

		const args: string[] = ["--color=never"];

		// Output mode flags
		if (outputMode === "files") {
			args.push("--files-with-matches");
		} else if (outputMode === "count") {
			// Use --count-matches for actual match counts, -H to always show filename
			args.push("--count-matches", "-H");
		} else {
			// content mode: show line numbers and filenames
			args.push("-n", "--with-filename");
		}

		if (ignoreCase) {
			args.push("-i");
		}

		if (literal) {
			args.push("--fixed-strings");
		}

		if (word) {
			args.push("-w");
		}

		if (multiline) {
			args.push("--multiline");
		}

		if (includeHidden) {
			args.push("--hidden");
		}

		if (!useGitIgnore) {
			args.push("--no-ignore");
		}

		if (invertMatch) {
			args.push("--invert-match");
		}

		if (onlyMatching) {
			args.push("--only-matching");
		}

		if (maxResults !== undefined) {
			args.push("-m", String(maxResults));
		}

		if (context !== undefined) {
			args.push(`-C${context}`);
		}

		if (beforeContext !== undefined) {
			args.push(`-B${beforeContext}`);
		}

		if (afterContext !== undefined) {
			args.push(`-A${afterContext}`);
		}

		for (const globPattern of globArgs) {
			args.push("--glob", globPattern);
		}

		if (format === "json" && outputMode === "content") {
			args.push("--json");
		}

		args.push("--", pattern);

		if (pathArgs.length > 0) {
			args.push(...pathArgs);
		} else {
			args.push(".");
		}

		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await runRipgrep(args, signal, commandCwd);
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown error: ${String(error)}`;
			return respond
				.text(`ripgrep failed\n\n${reason}`)
				.detail({ command: ["rg", ...args].join(" "), cwd: commandCwd });
		}

		if (result.exitCode === 2) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "ripgrep exited with an error",
			);
		}

		const command = ["rg", ...args].join(" ");

		if (result.exitCode === 1 || result.stdout.trim().length === 0) {
			// Use correct format in detail based on mode
			const detailFormat =
				outputMode === "files"
					? "files"
					: outputMode === "count"
						? "count"
						: format;
			return respond
				.text("No matches found.")
				.detail({ command, cwd: commandCwd, format: detailFormat });
		}

		// Handle files mode output
		if (outputMode === "files") {
			const allFiles = result.stdout
				.trim()
				.split("\n")
				.filter((f) => f.length > 0);
			const files =
				headLimit !== undefined ? allFiles.slice(0, headLimit) : allFiles;
			const truncated = headLimit !== undefined && allFiles.length > headLimit;
			const fileList = files.join("\n");
			const truncatedNote = truncated
				? `\n\n... (showing ${files.length} of ${allFiles.length} files)`
				: "";
			return respond
				.text(
					`Found ${allFiles.length} file(s) matching "${pattern}":\n\n${fileList}${truncatedNote}`,
				)
				.detail({
					command,
					cwd: commandCwd,
					format: "files",
					fileCount: allFiles.length,
					files,
					truncated,
				});
		}

		// Handle count mode output
		if (outputMode === "count") {
			const lines = result.stdout
				.trim()
				.split("\n")
				.filter((l) => l.length > 0);
			const allCounts: Array<{ file: string; count: number }> = [];
			let totalMatches = 0;
			// Use regex to parse "filename:count" format robustly
			// This handles Windows paths (C:\path\file.txt:5) and colons in filenames
			const countLineRegex = /^(.+):(\d+)$/;
			for (const line of lines) {
				const match = line.match(countLineRegex);
				if (match) {
					const file = match[1];
					const matchCount = Number.parseInt(match[2], 10);
					allCounts.push({ file, count: matchCount });
					totalMatches += matchCount;
				}
			}
			const counts =
				headLimit !== undefined ? allCounts.slice(0, headLimit) : allCounts;
			const truncated = headLimit !== undefined && allCounts.length > headLimit;
			const summary = counts.map((c) => `${c.file}: ${c.count}`).join("\n");
			const truncatedNote = truncated
				? `\n\n... (showing ${counts.length} of ${allCounts.length} files)`
				: "";
			return respond
				.text(
					`Found ${totalMatches} match(es) across ${allCounts.length} file(s):\n\n${summary}${truncatedNote}`,
				)
				.detail({
					command,
					cwd: commandCwd,
					format: "count",
					totalMatches,
					fileCount: allCounts.length,
					counts,
					truncated,
				});
		}

		// Handle JSON format
		if (format === "json") {
			const allMatches = parseRipgrepJson(result.stdout);
			const matches =
				headLimit !== undefined ? allMatches.slice(0, headLimit) : allMatches;
			const headLimitTruncated =
				headLimit !== undefined && allMatches.length > headLimit;
			const detailLimitTruncated = matches.length > JSON_DETAIL_LIMIT;
			const truncated = headLimitTruncated || detailLimitTruncated;
			const preview = matches
				.slice(0, 5)
				.map(
					(match) =>
						`${match.file}:${match.line}:${match.column} ${match.match.trim()}`,
				)
				.join("\n");
			const suffix =
				matches.length > 5 ? `\n... (${matches.length - 5} more matches)` : "";
			const truncatedNote = headLimitTruncated
				? `\n(showing ${matches.length} of ${allMatches.length} total matches)`
				: "";
			const text = matches.length
				? `Found ${allMatches.length} match(es).${truncatedNote}\n\n${preview}${suffix}`
				: "No matches found.";
			return respond.text(text).detail({
				command,
				cwd: commandCwd,
				format,
				matches: matches.slice(0, JSON_DETAIL_LIMIT),
				truncated,
			});
		}

		// Handle text format (content mode)
		const lines = result.stdout.trimEnd().split("\n");
		const outputLines =
			headLimit !== undefined ? lines.slice(0, headLimit) : lines;
		const truncated = headLimit !== undefined && lines.length > headLimit;
		const truncatedNote = truncated
			? `\n\n... (showing ${outputLines.length} of ${lines.length} lines)`
			: "";
		return respond
			.text(outputLines.join("\n") + truncatedNote)
			.detail({ command, cwd: commandCwd, format, truncated });
	},
});

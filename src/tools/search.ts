import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTool, expandUserPath } from "./tool-dsl.js";

const pathSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Directory or file to search",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple directories or files to search",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

const globSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Glob pattern passed to ripgrep",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple glob patterns",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

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
	}),
	Type.Object(
		{},
		{
			description:
				"Use either context or before/after context options, not both.",
		},
	),
]);

function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

async function runRipgrep(
	args: string[],
	signal?: AbortSignal,
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn("rg", args, {
		cwd: cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		signal,
	});

	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.once("error", (error) => {
			reject(
				error instanceof Error
					? new Error(`Failed to start ripgrep: ${error.message}`)
					: new Error(`Failed to start ripgrep: ${String(error)}`),
			);
		});

		child.once("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

type RipgrepMatch = {
	file: string;
	line: number;
	column: number;
	match: string;
	lines: string;
};

function parseRipgrepJson(output: string): RipgrepMatch[] {
	const matches: RipgrepMatch[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "match") {
				const pathText = event.data?.path?.text ?? "";
				for (const submatch of event.data?.submatches ?? []) {
					matches.push({
						file: pathText,
						line: event.data?.line_number ?? 0,
						column: submatch.start ?? 0,
						match: submatch.match?.text ?? "",
						lines: event.data?.lines?.text ?? "",
					});
				}
			}
		} catch {
			// ignore parse errors from non-JSON lines
		}
	}
	return matches;
}

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
			const files = result.stdout
				.trim()
				.split("\n")
				.filter((f) => f.length > 0);
			const fileList = files.join("\n");
			return respond
				.text(
					`Found ${files.length} file(s) matching "${pattern}":\n\n${fileList}`,
				)
				.detail({
					command,
					cwd: commandCwd,
					format: "files",
					fileCount: files.length,
					files,
				});
		}

		// Handle count mode output
		if (outputMode === "count") {
			const lines = result.stdout
				.trim()
				.split("\n")
				.filter((l) => l.length > 0);
			const counts: Array<{ file: string; count: number }> = [];
			let totalMatches = 0;
			// Use regex to parse "filename:count" format robustly
			// This handles Windows paths (C:\path\file.txt:5) and colons in filenames
			const countLineRegex = /^(.+):(\d+)$/;
			for (const line of lines) {
				const match = line.match(countLineRegex);
				if (match) {
					const file = match[1];
					const matchCount = Number.parseInt(match[2], 10);
					counts.push({ file, count: matchCount });
					totalMatches += matchCount;
				}
			}
			const summary = counts.map((c) => `${c.file}: ${c.count}`).join("\n");
			return respond
				.text(
					`Found ${totalMatches} match(es) across ${counts.length} file(s):\n\n${summary}`,
				)
				.detail({
					command,
					cwd: commandCwd,
					format: "count",
					totalMatches,
					fileCount: counts.length,
					counts,
				});
		}

		// Handle JSON format
		if (format === "json") {
			const matches = parseRipgrepJson(result.stdout);
			const preview = matches
				.slice(0, 5)
				.map(
					(match) =>
						`${match.file}:${match.line}:${match.column} ${match.match.trim()}`,
				)
				.join("\n");
			const suffix =
				matches.length > 5 ? `\n... (${matches.length - 5} more matches)` : "";
			const text = matches.length
				? `Found ${matches.length} match(es).\n\n${preview}${suffix}`
				: "No matches found.";
			return respond.text(text).detail({
				command,
				cwd: commandCwd,
				format,
				matches: matches.slice(0, JSON_DETAIL_LIMIT),
			});
		}

		return respond
			.text(result.stdout.trimEnd())
			.detail({ command, cwd: commandCwd, format });
	},
});

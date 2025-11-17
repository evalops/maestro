import { spawn } from "node:child_process";
import os from "node:os";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTypeboxTool } from "./typebox-tool.js";

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
		format: Type.Optional(
			Type.Union([Type.Literal("text"), Type.Literal("json")], {
				description: "Output format",
				default: "text",
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

function expandPath(path?: string): string | undefined {
	if (!path) return undefined;
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return os.homedir() + path.slice(1);
	return resolvePath(path);
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
	format?: "text" | "json";
	matches?: RipgrepMatch[];
};

export const searchTool = createTypeboxTool<
	typeof searchSchema,
	SearchToolDetails
>({
	name: "search",
	label: "search",
	description:
		"Find text across files using ripgrep with optional globbing and context controls.",
	schema: searchSchema,
	async execute(_toolCallId, params, signal) {
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
			format = "text",
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
		const commandCwd = expandPath(cwd) ?? process.cwd();

		const args: string[] = ["--color=never", "-n", "--with-filename"];

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

		if (format === "json") {
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
			return {
				content: [
					{
						type: "text",
						text: `ripgrep failed\n\n${reason}`,
					},
				],
				details: { command: ["rg", ...args].join(" "), cwd: commandCwd },
			};
		}

		if (result.exitCode === 2) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "ripgrep exited with an error",
			);
		}

		const command = ["rg", ...args].join(" ");

		if (result.exitCode === 1 || result.stdout.trim().length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No matches found.",
					},
				],
				details: { command, cwd: commandCwd, format },
			};
		}

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
			return {
				content: [{ type: "text", text }],
				details: {
					command,
					cwd: commandCwd,
					format,
					matches: matches.slice(0, JSON_DETAIL_LIMIT),
				},
			};
		}

		return {
			content: [{ type: "text", text: result.stdout.trimEnd() }],
			details: { command, cwd: commandCwd, format },
		};
	},
});

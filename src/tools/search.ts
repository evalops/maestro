import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

const pathSchema = z
	.union([
		z.string({ description: "Directory or file to search" }).min(1),
		z
			.array(
				z
					.string({ description: "Multiple directories or files to search" })
					.min(1),
			)
			.min(1, "Provide at least one search path"),
	])
	.optional();

const globSchema = z
	.union([
		z.string({ description: "Glob pattern passed to ripgrep" }).min(1),
		z
			.array(z.string({ description: "Multiple glob patterns" }).min(1))
			.min(1, "Provide at least one glob"),
	])
	.optional();

const searchSchemaBase = z
	.object({
		pattern: z
			.string({ description: "Regex pattern (or literal when literal=true)" })
			.min(1, "Search pattern must not be empty"),
		paths: pathSchema,
		glob: globSchema,
		ignoreCase: z
			.boolean({ description: "Perform case-insensitive search (-i)." })
			.optional()
			.default(false),
		literal: z
			.boolean({
				description: "Treat the pattern as a literal string (--fixed-strings).",
			})
			.optional()
			.default(false),
		word: z
			.boolean({ description: "Match only whole words (-w)." })
			.optional()
			.default(false),
		multiline: z
			.boolean({ description: "Enable multiline matching (--multiline)." })
			.optional()
			.default(false),
		maxResults: z
			.number({ description: "Stop after this many matches (-m)." })
			.int()
			.min(1)
			.max(1000)
			.optional(),
		context: z
			.number({
				description: "Show this many lines of context before and after (-C).",
			})
			.int()
			.min(0)
			.max(20)
			.optional(),
		beforeContext: z
			.number({
				description: "Show this many lines of context before each match (-B).",
			})
			.int()
			.min(0)
			.max(20)
			.optional(),
		afterContext: z
			.number({
				description: "Show this many lines of context after each match (-A).",
			})
			.int()
			.min(0)
			.max(20)
			.optional(),
	})
	.strict();

const searchSchema = searchSchemaBase.refine(
	(data) =>
		!(
			data.context !== undefined &&
			(data.beforeContext !== undefined || data.afterContext !== undefined)
		),
	"Use either context or before/after context options, not both.",
);

function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

async function runRipgrep(
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn("rg", args, {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		signal,
	});

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

	const [exitCode] = (await once(child, "close")) as [number];
	return { stdout, stderr, exitCode: exitCode ?? 0 };
}

export const searchTool = createZodTool({
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
		} = params;

		const pathArgs = toArray(paths);
		const globArgs = toArray(glob);

		const args: string[] = ["--color=never", "-n", "--with-filename"]; // include line numbers and filenames

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

		args.push(pattern);

		if (pathArgs.length > 0) {
			args.push(...pathArgs);
		} else {
			args.push(".");
		}

		const result = await runRipgrep(args, signal);

		if (result.exitCode === 2) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "ripgrep exited with an error",
			);
		}

		if (result.exitCode === 1 || result.stdout.trim().length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No matches found.",
					},
				],
				details: { command: ["rg", ...args].join(" ") },
			};
		}

		return {
			content: [{ type: "text", text: result.stdout.trimEnd() }],
			details: { command: ["rg", ...args].join(" ") },
		};
	},
});

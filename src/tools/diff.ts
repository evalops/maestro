import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

const pathInputSchema = z
	.union([
		z.string({ description: "Limit diff to a specific path" }).min(1),
		z
			.array(
				z
					.string({ description: "Multiple paths to include in the diff" })
					.min(1),
			)
			.min(1, "Provide at least one path"),
	])
	.optional();

const diffSchemaBase = z
	.object({
		staged: z
			.boolean({
				description:
					"Show staged (index) changes instead of working tree modifications.",
			})
			.optional()
			.default(false),
		range: z
			.string({
				description:
					"Git revision or range (for example HEAD~1..HEAD). Overrides staged/worktree scope.",
			})
			.min(1)
			.optional(),
		context: z
			.number({ description: "Number of context lines to include (git -U)." })
			.int()
			.min(0)
			.max(1000)
			.optional(),
		stat: z
			.boolean({
				description: "Include a summary (--stat) alongside the patch.",
			})
			.optional()
			.default(false),
		wordDiff: z
			.boolean({
				description: "Highlight changes at the word level (--word-diff=color).",
			})
			.optional()
			.default(false),
		nameOnly: z
			.boolean({
				description: "List only filenames that changed (--name-only).",
			})
			.optional()
			.default(false),
		paths: pathInputSchema,
	})
	.strict();

const diffSchema = diffSchemaBase.refine(
	(data) => !(data.nameOnly && data.wordDiff),
	"Cannot request both name-only and word-diff output.",
);

function normalizePaths(paths: z.infer<typeof pathInputSchema>): string[] {
	if (paths === undefined) {
		return [];
	}
	return Array.isArray(paths) ? paths : [paths];
}

async function runGitDiff(
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn("git", args, {
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

export const diffTool = createZodTool({
	name: "diff",
	label: "diff",
	description:
		"Inspect git diffs with optional staging, revision, and path filters.",
	schema: diffSchema,
	async execute(_toolCallId, params, signal) {
		const { staged, range, context, stat, wordDiff, nameOnly, paths } = params;

		const pathArgs = normalizePaths(paths);
		const args = ["diff", "--no-color"];

		if (stat) {
			args.push("--stat");
		}

		if (context !== undefined) {
			args.push(`-U${context}`);
		}

		if (wordDiff) {
			args.push("--word-diff=color");
		}

		if (nameOnly) {
			args.push("--name-only");
		}

		if (range) {
			args.push(range);
		} else if (staged) {
			args.push("--cached");
		}

		if (pathArgs.length > 0) {
			args.push("--", ...pathArgs);
		}

		const commandSummary = ["git", ...args].join(" ");

		const result = await runGitDiff(args, signal);

		if (result.exitCode !== 0) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "git diff exited with a non-zero status",
			);
		}

		const output = result.stdout.trim();

		if (output.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No changes found for the selected diff options.",
					},
				],
				details: { command: commandSummary },
			};
		}

		return {
			content: [{ type: "text", text: output }],
			details: { command: commandSummary },
		};
	},
});

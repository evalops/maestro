import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { createTool } from "./tool-dsl.js";

const pathInputSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Limit diff to a specific path",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple paths to include in the diff",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

const diffSchema = Type.Intersect([
	Type.Object({
		staged: Type.Optional(
			Type.Boolean({
				description:
					"Show staged (index) changes instead of working tree modifications.",
				default: false,
			}),
		),
		range: Type.Optional(
			Type.String({
				description:
					"Git revision or range (for example HEAD~1..HEAD). Overrides staged/worktree scope.",
				minLength: 1,
			}),
		),
		context: Type.Optional(
			Type.Integer({
				description: "Number of context lines to include (git -U).",
				minimum: 0,
				maximum: 1000,
			}),
		),
		stat: Type.Optional(
			Type.Boolean({
				description: "Include a summary (--stat) alongside the patch.",
				default: false,
			}),
		),
		wordDiff: Type.Optional(
			Type.Boolean({
				description: "Highlight changes at the word level (--word-diff=color).",
				default: false,
			}),
		),
		nameOnly: Type.Optional(
			Type.Boolean({
				description: "List only filenames that changed (--name-only).",
				default: false,
			}),
		),
		paths: pathInputSchema,
	}),
	Type.Object(
		{},
		{ description: "Cannot request both name-only and word-diff output." },
	),
]);

function normalizePaths(paths: string | string[] | undefined): string[] {
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
					? new Error(`Failed to start git diff: ${error.message}`)
					: new Error(`Failed to start git diff: ${String(error)}`),
			);
		});

		child.once("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

type DiffToolDetails = { command: string };

export const diffTool = createTool<typeof diffSchema, DiffToolDetails>({
	name: "diff",
	label: "diff",
	description:
		"Inspect git diffs with optional staging, revision, and path filters.",
	schema: diffSchema,
	async run(params, { signal, respond }) {
		const { staged, range, context, stat, wordDiff, nameOnly, paths } = params;

		if (wordDiff && nameOnly) {
			throw new Error("Cannot request both name-only and word-diff output.");
		}

		const pathArgs = normalizePaths(paths);
		const args = ["diff"];

		if (!wordDiff) {
			args.push("--no-color");
		}

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

		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await runGitDiff(args, signal);
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown error: ${String(error)}`;
			return respond
				.text(`git diff failed\n\n${reason}`)
				.detail({ command: commandSummary });
		}

		if (result.exitCode !== 0) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "git diff exited with a non-zero status",
			);
		}

		const output = result.stdout.trim();

		if (output.length === 0) {
			return respond
				.text("No changes found for the selected diff options.")
				.detail({ command: commandSummary });
		}

		return respond.text(output).detail({ command: commandSummary });
	},
});

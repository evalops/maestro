import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { type ParsedStatus, parseStatusOutput } from "./diff.js";
import { createTool } from "./tool-dsl.js";

const pathInputSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Limit status to a specific path",
			minLength: 1,
		}),
		Type.Array(Type.String({ description: "Multiple paths", minLength: 1 }), {
			minItems: 1,
		}),
	]),
);

const statusSchema = Type.Object({
	branchSummary: Type.Optional(
		Type.Boolean({
			description: "Include branch/ahead-behind data (-b)",
			default: true,
		}),
	),
	includeIgnored: Type.Optional(
		Type.Boolean({
			description: "Include ignored files (--ignored=matching)",
			default: false,
		}),
	),
	paths: pathInputSchema,
});

function normalizePaths(paths: string | string[] | undefined): string[] {
	if (paths === undefined) return [];
	return Array.isArray(paths) ? paths : [paths];
}

async function runGitStatus(
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
					? new Error(`Failed to start git status: ${error.message}`)
					: new Error(`Failed to start git status: ${String(error)}`),
			);
		});

		child.once("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

export const statusTool = createTool<
	typeof statusSchema,
	{ command: string; status?: ParsedStatus }
>({
	name: "status",
	label: "status",
	description:
		"Show git status (porcelain v2) with optional branch and ignored info, returning structured output.",
	schema: statusSchema,
	async run(params, { signal, respond }) {
		const { branchSummary = true, includeIgnored = false, paths } = params;
		const pathArgs = normalizePaths(paths);
		const args = ["status", "--porcelain=v2", "-z"];
		if (branchSummary) args.push("-b");
		if (includeIgnored) args.push("--ignored=matching");
		if (pathArgs.length > 0) args.push("--", ...pathArgs);

		const commandSummary = ["git", ...args].join(" ");
		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await runGitStatus(args, signal);
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown error: ${String(error)}`;
			return respond
				.text(`git status failed\n\n${reason}`)
				.detail({ command: commandSummary });
		}

		if (result.exitCode !== 0) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0
					? message
					: "git status exited with a non-zero status",
			);
		}

		const parsed = parseStatusOutput(result.stdout);
		const summaryLines: string[] = [`Files: ${parsed.files.length}`];

		if (branchSummary && parsed.branch) {
			summaryLines.unshift(
				`Branch: ${parsed.branch.head ?? "(detached)"}${
					parsed.branch.upstream ? ` -> ${parsed.branch.upstream}` : ""
				}${
					parsed.branch.ahead || parsed.branch.behind
						? ` (ahead ${parsed.branch.ahead ?? 0}, behind ${parsed.branch.behind ?? 0})`
						: ""
				}`,
			);
		}

		const summary = respond.text(summaryLines.join("\n"));

		return summary.detail({ command: commandSummary, status: parsed });
	},
});

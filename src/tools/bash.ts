import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import {
	getShellConfig,
	killProcessTree,
	validateShellParams,
} from "./shell-utils.js";
import { createTool } from "./tool-dsl.js";

const bashSchema = Type.Object({
	command: Type.String({
		description: "Bash command to execute",
		minLength: 1,
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (optional, no default timeout)",
			exclusiveMinimum: 0,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the command (relative or absolute)",
			minLength: 1,
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String({ minLength: 1 }), Type.String(), {
			description: "Additional environment variables for the command",
		}),
	),
});

export const bashTool = createTool<typeof bashSchema>({
	name: "bash",
	label: "bash",
	description: `Execute bash commands. Returns stdout and stderr.

Usage guidelines:
- ALWAYS quote paths with spaces: cd "/path with spaces"
- DO NOT use: find, grep, cat, head, tail, ls (use search, read, list tools instead)
- Prefer rg over grep if you must search
- Chain commands with ';' or '&&', avoid cd
- Use 'gh' CLI for GitHub operations (gh pr create, gh issue list, gh repo view)

Timeout: 90s default, 600s max. Output truncates at 40KB.`,
	schema: bashSchema,
	async run({ command, timeout, cwd, env }, { signal }) {
		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve, reject) => {
			let resolvedCwd: string | undefined;
			try {
				({ resolvedCwd } = validateShellParams(command, cwd, env));
			} catch (error) {
				reject(error);
				return;
			}

			const { shell, args } = getShellConfig();
			const mergedEnv = { ...process.env, ...env } as Record<string, string>;
			const child = spawn(shell, [...args, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: resolvedCwd,
				env: mergedEnv,
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let stdoutTruncated = false;
			let stderrTruncated = false;
			const MAX_BUFFER = 10 * 1024 * 1024;

			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					onAbort();
				}, timeout * 1000);
			}

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			const cleanup = () => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
			};

			if (child.stdout) {
				child.stdout.on("data", (data) => {
					stdout += data.toString();
					if (stdout.length > MAX_BUFFER) {
						stdout = stdout.slice(0, MAX_BUFFER);
						stdoutTruncated = true;
					}
				});
			}

			if (child.stderr) {
				child.stderr.on("data", (data) => {
					stderr += data.toString();
					if (stderr.length > MAX_BUFFER) {
						stderr = stderr.slice(0, MAX_BUFFER);
						stderrTruncated = true;
					}
				});
			}

			child.on("close", (code) => {
				cleanup();

				if (signal?.aborted) {
					let output = stdout;
					if (stderr) {
						if (output) output += "\n";
						output += stderr;
					}
					if (stdoutTruncated || stderrTruncated) {
						if (output) output += "\n\n";
						output += "Output truncated at 10MB";
					}
					if (output) output += "\n\n";
					output += "Command aborted";
					resolve({
						content: [{ type: "text", text: `Command failed\n\n${output}` }],
						details: undefined,
					});
					return;
				}

				if (timedOut) {
					let output = stdout;
					if (stderr) {
						if (output) output += "\n";
						output += stderr;
					}
					if (stdoutTruncated || stderrTruncated) {
						if (output) output += "\n\n";
						output += "Output truncated at 10MB";
					}
					if (output) output += "\n\n";
					output += `Command timed out after ${timeout} seconds`;
					resolve({
						content: [{ type: "text", text: `Command failed\n\n${output}` }],
						details: undefined,
					});
					return;
				}

				let output = stdout;
				if (stderr) {
					if (output) output += "\n";
					output += stderr;
				}
				if (stdoutTruncated || stderrTruncated) {
					if (output) output += "\n\n";
					output += "Output truncated at 10MB";
				}

				if (code !== 0 && code !== null) {
					if (output) output += "\n\n";
					resolve({
						content: [
							{
								type: "text",
								text: `Command failed\n\n${output}Command exited with code ${code}`,
							},
						],
						details: undefined,
					});
				} else {
					resolve({
						content: [{ type: "text", text: output || "(no output)" }],
						details: undefined,
					});
				}
			});

			child.once("error", (error) => {
				cleanup();
				const reason =
					error instanceof Error
						? `${error.name}: ${error.message}`
						: `Failed to start process: ${String(error)}`;
				resolve({
					content: [
						{
							type: "text",
							text: `Command failed to start\n\n${reason}`,
						},
					],
					details: undefined,
				});
			});

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		});
	},
});

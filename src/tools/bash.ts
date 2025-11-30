import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import {
	getShellConfig,
	killProcessTree,
	validateShellParams,
} from "./shell-utils.js";
import { createTool, interpolateContext } from "./tool-dsl.js";

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
	description: `Execute bash commands.

Usage guidelines:
- ALWAYS quote paths with spaces: cd "/path with spaces"
- DO NOT use: find, grep, cat, head, tail, ls (use search, read, list tools instead)
- Prefer rg over grep if you must search
- Chain commands with ';' or '&&', avoid cd
- Use 'gh' CLI for GitHub operations (gh pr create, gh issue list, gh repo view)

Supports interpolation in command:
- \${cwd} - current working directory
- \${home} - user home directory
- \${env.VAR} - environment variable

Timeout: 90s default, 600s max. Output truncates at 40KB.`,
	schema: bashSchema,
	async run({ command, timeout, cwd, env }, { signal, sandbox }) {
		// Interpolate ${cwd}, ${home}, ${env.VAR} in command
		const interpolatedCommand = interpolateContext(command);

		if (sandbox) {
			const result = await sandbox.exec(interpolatedCommand, cwd, env);

			let output = "";
			if (result.stdout) {
				output += result.stdout;
			}
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			if (result.exitCode !== 0) {
				output += `\n\nExit code: ${result.exitCode}`;
			}

			return {
				content: [
					{
						type: "text",
						text: output.trim() || "Command executed successfully (no output)",
					},
				],
				details: undefined,
			};
		}

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve, reject) => {
			let resolvedCwd: string | undefined;
			try {
				({ resolvedCwd } = validateShellParams(interpolatedCommand, cwd, env));
			} catch (error) {
				reject(error);
				return;
			}

			const { shell, args } = getShellConfig();
			const mergedEnv = { ...process.env, ...env } as Record<string, string>;
			const child = spawn(shell, [...args, interpolatedCommand], {
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
					if (stdout.length < MAX_BUFFER) {
						stdout += data.toString();
					} else {
						stdoutTruncated = true;
					}
				});
			}

			if (child.stderr) {
				child.stderr.on("data", (data) => {
					if (stderr.length < MAX_BUFFER) {
						stderr += data.toString();
					} else {
						stderrTruncated = true;
					}
				});
			}

			child.on("error", (error) => {
				cleanup();
				reject(error);
			});

			child.on("close", (code) => {
				cleanup();
				let output = stdout;
				if (stderr) {
					if (output) output += "\n";
					output += stderr;
				}

				if (stdoutTruncated || stderrTruncated) {
					output += "\n\n(Output truncated)";
				}

				if (timedOut) {
					output += "\n\n(Command timed out)";
				} else if (code !== 0) {
					output += `\n\nExit code: ${code}`;
				}

				resolve({
					content: [
						{
							type: "text",
							text:
								output.trim() || "Command executed successfully (no output)",
						},
					],
					details: undefined,
				});
			});

			if (signal) {
				signal.addEventListener("abort", onAbort);
			}
		});
	},
});

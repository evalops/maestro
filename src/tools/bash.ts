import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import {
	formatGuardianResult,
	runGuardian,
	shouldGuardCommand,
} from "../guardian/index.js";
import { requirePlanCheck } from "../safety/safe-mode.js";
import { backgroundTaskManager } from "./background-tasks.js";
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
	runInBackground: Type.Optional(
		Type.Boolean({
			description:
				"Run command as a managed background task (use background_tasks tool to inspect/stop)",
			default: false,
		}),
	),
});

const DEFAULT_TIMEOUT_SECONDS = 90;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_BUFFER = 40 * 1024; // 40KB stdout/stderr cap to avoid runaway output

export type BashBackgroundDetails = {
	taskId: string;
	logPath: string;
	command: string;
	cwd?: string;
	status: "running" | "stopped" | "exited" | "failed" | "restarting";
};

function isMutatingCommand(command: string): boolean {
	const mutationPatterns = [
		/(^|\s)(rm|mv|cp|chmod|chown|truncate|dd|mkfs|ln)\b/i,
		/\btee\b/i,
		/\bsed\b[^|;]*\s-i\b/i,
		/(^|\s)sudo\b/i,
		/>|>>/, // file redirection
	];
	return mutationPatterns.some((re) => re.test(command));
}

export const bashTool = createTool<typeof bashSchema, BashBackgroundDetails>({
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
	async run(
		{ command, timeout, cwd, env, runInBackground },
		{ signal, sandbox, respond },
	) {
		// Interpolate ${cwd}, ${home}, ${env.VAR} in command
		const interpolatedCommand = interpolateContext(command);

		if (isMutatingCommand(interpolatedCommand)) {
			requirePlanCheck("bash");
		}

		const guardCheck = shouldGuardCommand(interpolatedCommand);
		if (guardCheck.shouldGuard) {
			const guardian = await runGuardian({
				trigger: guardCheck.trigger ?? "git",
				target: "staged",
			});
			if (guardian.status === "failed" || guardian.status === "error") {
				return {
					content: [
						{
							type: "text",
							text: `Composer Guardian blocked ${guardCheck.trigger ?? "git"}\n\n${formatGuardianResult(guardian)}`,
						},
					],
					details: undefined,
				};
			}
		}

		const effectiveTimeout = Math.min(
			timeout ?? DEFAULT_TIMEOUT_SECONDS,
			MAX_TIMEOUT_SECONDS,
		);

		if (runInBackground) {
			if (sandbox) {
				return respond.text(
					"Background execution is not available in sandbox mode. Retry without runInBackground or disable sandbox.",
				);
			}

			const { resolvedCwd } = validateShellParams(
				interpolatedCommand,
				cwd,
				env,
			);

			const task = backgroundTaskManager.start(interpolatedCommand, {
				cwd: resolvedCwd,
				env: env as Record<string, string> | undefined,
				useShell: true,
			});

			const lines = [
				`Started background task ${task.id} (status=${task.status})`,
				`Logs: ${task.logPath}`,
				"Use background_tasks action=logs taskId=<id> to view output, action=stop to terminate.",
			];

			return respond.text(lines.join("\n")).detail({
				taskId: task.id,
				logPath: task.logPath,
				command: interpolatedCommand,
				cwd: resolvedCwd,
				status: task.status,
			});
		}

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

			let timeoutHandle: NodeJS.Timeout | undefined;
			if (effectiveTimeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					onAbort();
				}, effectiveTimeout * 1000);
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

				// Provide detailed truncation feedback
				const truncationMessages: string[] = [];
				if (stdoutTruncated) {
					const displayedKB = Math.round(MAX_BUFFER / 1024);
					truncationMessages.push(
						`stdout exceeded ${displayedKB}KB limit and was truncated`,
					);
				}
				if (stderrTruncated) {
					const displayedKB = Math.round(MAX_BUFFER / 1024);
					truncationMessages.push(
						`stderr exceeded ${displayedKB}KB limit and was truncated`,
					);
				}
				if (truncationMessages.length > 0) {
					output += `\n\n⚠️ Output truncated: ${truncationMessages.join("; ")}. Consider piping output to a file or using head/tail.`;
				}

				if (timedOut) {
					output += `\n\n⏱️ Command timed out after ${effectiveTimeout}s`;
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

/**
 * Bash Tool - Shell command execution for the agent.
 *
 * This module provides the agent with the ability to execute arbitrary bash
 * commands in the user's shell environment. It's one of the most powerful
 * tools in the toolbox, enabling system operations, file manipulation,
 * git commands, and running build/test scripts.
 *
 * ## Security Features
 *
 * - **Guardian Integration**: Commands matching certain patterns (git push, npm publish)
 *   trigger the Guardian system for additional security checks.
 * - **Safe Mode**: Mutating commands require a plan to be set when safe mode is enabled.
 * - **Output Limits**: stdout/stderr capped at 40KB to prevent memory issues.
 * - **Timeout**: Default 90s timeout, max 600s to prevent runaway processes.
 * - **Process Tree Killing**: On abort/timeout, kills the entire process tree.
 *
 * ## Execution Modes
 *
 * 1. **Foreground (default)**: Waits for command completion, returns output.
 * 2. **Background**: Starts as managed background task, returns immediately.
 * 3. **Sandbox**: Routes execution through sandbox environment when enabled.
 *
 * ## Variable Interpolation
 *
 * Commands support variable interpolation for common paths:
 * - `${cwd}` - Current working directory
 * - `${home}` - User's home directory
 * - `${env.VAR}` - Environment variables
 */

import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import {
	formatGuardianResult,
	runGuardian,
	shouldGuardCommand,
} from "../guardian/index.js";
import { checkCommand } from "../safety/execpolicy.js";
import { checkBashCommandForNestedAgent } from "../safety/nested-agent-guard.js";
import { requirePlanCheck } from "../safety/safe-mode.js";
import { backgroundTaskManager } from "./background-tasks.js";
import {
	getShellConfig,
	killProcessTree,
	validateShellParams,
} from "./shell-utils.js";
import { createTool, interpolateContext } from "./tool-dsl.js";

/**
 * Schema for bash tool parameters.
 * Defines the structure and validation for command execution options.
 */
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

// Default timeout for command execution (90 seconds)
// Most commands complete quickly, but builds/tests may take longer
const DEFAULT_TIMEOUT_SECONDS = 90;

// Maximum allowed timeout (10 minutes) to prevent indefinite hangs
const MAX_TIMEOUT_SECONDS = 600;

// Output buffer limit (40KB) to prevent memory exhaustion from verbose commands
// Commands that exceed this will have output truncated with a warning
const MAX_BUFFER = 40 * 1024;

/**
 * Details returned when a command is started as a background task.
 * Used to track and manage long-running processes.
 */
export type BashBackgroundDetails = {
	/** Unique identifier for the background task */
	taskId: string;
	/** Path to the log file containing command output */
	logPath: string;
	/** The command that was executed */
	command: string;
	/** Working directory where command is running */
	cwd?: string;
	/** Current status of the background task */
	status: "running" | "stopped" | "exited" | "failed" | "restarting";
};

/**
 * Check if a command is likely to modify the filesystem.
 *
 * Used by safe mode to determine if a command requires plan approval.
 * Matches common file-modifying commands and patterns.
 *
 * @param command - The command string to analyze
 * @returns true if the command appears to modify files
 */
function isMutatingCommand(command: string): boolean {
	const mutationPatterns = [
		// File operations: rm, mv, cp, chmod, chown, truncate, dd, mkfs, ln
		/(^|\s)(rm|mv|cp|chmod|chown|truncate|dd|mkfs|ln)\b/i,
		// tee writes to files
		/\btee\b/i,
		// sed with -i flag modifies files in place
		/\bsed\b[^|;]*\s-i\b/i,
		// sudo can modify protected files
		/(^|\s)sudo\b/i,
		// Output redirection creates/overwrites files
		/>|>>/,
	];
	return mutationPatterns.some((re) => re.test(command));
}

/**
 * The bash tool instance created using the tool DSL.
 *
 * This tool executes shell commands and handles:
 * - Variable interpolation (${cwd}, ${home}, ${env.VAR})
 * - Safe mode checks for mutating commands
 * - Guardian integration for sensitive operations
 * - Background task management
 * - Sandbox execution when enabled
 * - Output capture with truncation
 * - Timeout handling with process tree cleanup
 */
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
		// Step 1: Interpolate variables in the command string
		// Replaces ${cwd}, ${home}, ${env.VAR} with actual values
		const interpolatedCommand = interpolateContext(command);

		// Step 2: Check execpolicy for command approval
		// Policies in ~/.composer/execpolicy and .composer/execpolicy
		const policyResult = checkCommand(interpolatedCommand, process.cwd());
		if (policyResult.decision === "forbidden") {
			const matchInfo = policyResult.matchedRules
				.map((r) =>
					r.type === "prefix"
						? `prefix: ${r.matchedPrefix.join(" ")}`
						: `heuristic: ${r.command.join(" ")}`,
				)
				.join(", ");
			return respond.text(
				`Command blocked by execpolicy: ${interpolatedCommand}\n\nDecision: forbidden\nMatched rules: ${matchInfo || "none"}\n\nTo allow this command, add a prefix_rule to .composer/execpolicy`,
			);
		}

		// Step 2.5: Check for nested agent spawning
		// Prevents CPU exhaustion from recursive agent spawning
		const nestedAgentError =
			checkBashCommandForNestedAgent(interpolatedCommand);
		if (nestedAgentError) {
			return respond.text(
				`${nestedAgentError}\n\nCommand: ${interpolatedCommand.slice(0, 100)}...`,
			);
		}

		// Step 3: Safe mode check - mutating commands require a plan
		if (isMutatingCommand(interpolatedCommand)) {
			requirePlanCheck("bash");
		}

		// Step 4: Guardian check - sensitive commands (git push, npm publish) may be blocked
		const guardCheck = shouldGuardCommand(interpolatedCommand);
		if (guardCheck.shouldGuard) {
			const guardian = await runGuardian({
				trigger: guardCheck.trigger ?? "git",
				target: "staged",
			});
			// Block execution if guardian check fails
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

		// Step 5: Calculate effective timeout (user timeout clamped to max)
		const effectiveTimeout = Math.min(
			timeout ?? DEFAULT_TIMEOUT_SECONDS,
			MAX_TIMEOUT_SECONDS,
		);

		// ============================================
		// Background execution mode
		// ============================================
		if (runInBackground) {
			// Background tasks can't run in sandbox - sandbox doesn't support detached processes
			if (sandbox) {
				return respond.text(
					"Background execution is not available in sandbox mode. Retry without runInBackground or disable sandbox.",
				);
			}

			// Validate and resolve the working directory
			const { resolvedCwd } = validateShellParams(
				interpolatedCommand,
				cwd,
				env,
			);

			// Start the command as a managed background task
			// Output is captured to a log file instead of returned directly
			const task = backgroundTaskManager.start(interpolatedCommand, {
				cwd: resolvedCwd,
				env: env as Record<string, string> | undefined,
				useShell: true,
			});

			// Provide instructions for monitoring the background task
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

		// ============================================
		// Sandbox execution mode
		// ============================================
		if (sandbox) {
			// Execute in isolated sandbox environment (e.g., Docker container)
			const result = await sandbox.exec(interpolatedCommand, cwd, env);

			// Combine stdout and stderr for output
			let output = "";
			if (result.stdout) {
				output += result.stdout;
			}
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			// Include exit code for non-zero exits to help with debugging
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

		// ============================================
		// Foreground execution mode (default)
		// ============================================
		// Execute command synchronously and capture output
		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve, reject) => {
			// Validate working directory and environment
			let resolvedCwd: string | undefined;
			try {
				({ resolvedCwd } = validateShellParams(interpolatedCommand, cwd, env));
			} catch (error) {
				reject(error);
				return;
			}

			// Get shell configuration (bash -lc on most systems)
			const { shell, args } = getShellConfig();
			// Merge custom env vars with process environment
			const mergedEnv = { ...process.env, ...env } as Record<string, string>;

			// Spawn the child process in detached mode for clean process tree handling
			const child = spawn(shell, [...args, interpolatedCommand], {
				detached: true, // Allows killProcessTree to work correctly
				stdio: ["ignore", "pipe", "pipe"], // No stdin, capture stdout/stderr
				cwd: resolvedCwd,
				env: mergedEnv,
			});

			// Output buffers with truncation tracking
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let stdoutTruncated = false;
			let stderrTruncated = false;

			// Set up timeout handler
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (effectiveTimeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					onAbort();
				}, effectiveTimeout * 1000);
			}

			// Abort handler - kills the entire process tree
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			// Cleanup function to remove event listeners and clear timeout
			const cleanup = () => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
			};

			// Capture stdout with buffer limit
			if (child.stdout) {
				child.stdout.on("data", (data) => {
					if (stdout.length < MAX_BUFFER) {
						stdout += data.toString();
					} else {
						stdoutTruncated = true;
					}
				});
			}

			// Capture stderr with buffer limit
			if (child.stderr) {
				child.stderr.on("data", (data) => {
					if (stderr.length < MAX_BUFFER) {
						stderr += data.toString();
					} else {
						stderrTruncated = true;
					}
				});
			}

			// Handle spawn errors (e.g., command not found)
			child.on("error", (error) => {
				cleanup();
				reject(error);
			});

			// Handle process completion
			child.on("close", (code) => {
				cleanup();

				// Combine stdout and stderr
				let output = stdout;
				if (stderr) {
					if (output) output += "\n";
					output += stderr;
				}

				// Provide helpful truncation feedback
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

				// Add timeout or exit code information
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

			// Allow external abort signal to cancel execution
			if (signal) {
				signal.addEventListener("abort", onAbort);
			}
		});
	},
});

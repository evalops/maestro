import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTypeboxTool } from "./typebox-tool.js";

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		throw new Error(
			`Git Bash not found. Please install Git for Windows from https://git-scm.com/download/win\nSearched in:\n${paths
				.map((p) => `  ${p}`)
				.join("\n")}`,
		);
	}

	return { shell: "sh", args: ["-c"] };
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch (error) {
			// ignore
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error_) {
			// already exited
		}
	}
}

function expandPath(path?: string): string | undefined {
	if (!path) return undefined;
	if (path === "~") {
		return os.homedir();
	}
	if (path.startsWith("~/")) {
		return os.homedir() + path.slice(1);
	}
	return resolvePath(path);
}

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

export const bashTool = createTypeboxTool({
	name: "bash",
	label: "bash",
	description:
		"Execute a bash command in the current working directory. Returns stdout and stderr. Optionally provide a timeout in seconds.",
	schema: bashSchema,
	async execute(_toolCallId, { command, timeout, cwd, env }, signal) {
		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve, reject) => {
			const { shell, args } = getShellConfig();
			const resolvedCwd = expandPath(cwd);
			if (resolvedCwd && !existsSync(resolvedCwd)) {
				reject(new Error(`Working directory not found: ${cwd}`));
				return;
			}
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

			// Set timeout if provided
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

			// Collect stdout
			if (child.stdout) {
				child.stdout.on("data", (data) => {
					stdout += data.toString();
					if (stdout.length > MAX_BUFFER) {
						stdout = stdout.slice(0, MAX_BUFFER);
						stdoutTruncated = true;
					}
				});
			}

			// Collect stderr
			if (child.stderr) {
				child.stderr.on("data", (data) => {
					stderr += data.toString();
					if (stderr.length > MAX_BUFFER) {
						stderr = stderr.slice(0, MAX_BUFFER);
						stderrTruncated = true;
					}
				});
			}

			// Handle process exit
			child.on("close", (code) => {
				cleanup();

				if (signal?.aborted) {
					let output = "";
					if (stdout) output += stdout;
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
					let output = "";
					if (stdout) output += stdout;
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

				let output = "";
				if (stdout) output += stdout;
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

import { spawn } from "node:child_process";
import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

const bashSchema = z
	.object({
		command: z
			.string({ description: "Bash command to execute" })
			.min(1, "Command must not be empty"),
		timeout: z
			.number({
				description: "Timeout in seconds (optional, no default timeout)",
			})
			.positive()
			.optional(),
	})
	.strict();

export const bashTool = createZodTool({
	name: "bash",
	label: "bash",
	description:
		"Execute a bash command in the current working directory. Returns stdout and stderr. Optionally provide a timeout in seconds.",
	schema: bashSchema,
	async execute(_toolCallId, { command, timeout }, signal) {
		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve) => {
			const child = spawn("sh", ["-c", command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

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
					// Kill the entire process group (negative PID kills all processes in the group)
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch (e) {
						// Fallback to killing just the child if process group kill fails
						try {
							child.kill("SIGKILL");
						} catch (e2) {
							// Process already dead
						}
					}
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
					// Limit buffer size
					if (stdout.length > 10 * 1024 * 1024) {
						stdout = stdout.slice(0, 10 * 1024 * 1024);
					}
				});
			}

			// Collect stderr
			if (child.stderr) {
				child.stderr.on("data", (data) => {
					stderr += data.toString();
					// Limit buffer size
					if (stderr.length > 10 * 1024 * 1024) {
						stderr = stderr.slice(0, 10 * 1024 * 1024);
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

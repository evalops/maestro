import { type ChildProcess, spawn } from "node:child_process";

export interface StreamingShellCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	signal?: AbortSignal;
}

export interface StreamingShellCommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run a shell command with streaming output callbacks.
 * Calls onStdout/onStderr for each chunk received, enabling real-time display.
 */
export async function runStreamingShellCommand(
	command: string,
	options: StreamingShellCommandOptions = {},
): Promise<StreamingShellCommandResult> {
	return await new Promise((resolve) => {
		const cwd = options.cwd ?? process.cwd();
		const shellCommand = `cd -- ${shellEscape(cwd)} && ${command}`;
		const child: ChildProcess = spawn("bash", ["-lc", shellCommand], {
			cwd,
			env: {
				...(options.env ?? process.env),
				PWD: cwd,
			},
		});

		let stdout = "";
		let stderr = "";
		let aborted = false;
		let closed = false;
		let killTimeout: ReturnType<typeof setTimeout> | null = null;

		const cleanup = () => {
			if (killTimeout) {
				clearTimeout(killTimeout);
				killTimeout = null;
			}
			if (options.signal) {
				options.signal.removeEventListener("abort", handleAbort);
			}
		};

		const handleAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => {
				if (!closed) {
					child.kill("SIGKILL");
				}
			}, 500);
		};

		if (options.signal) {
			if (options.signal.aborted) {
				handleAbort();
			} else {
				options.signal.addEventListener("abort", handleAbort, { once: true });
			}
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			options.onStdout?.(text);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			options.onStderr?.(text);
		});

		child.on("close", (code) => {
			if (closed) {
				return;
			}
			closed = true;
			cleanup();
			if (aborted) {
				resolve({
					success: false,
					code: -1,
					stdout: stdout.trimEnd(),
					stderr: `${stderr.trimEnd()}\n[Command aborted]`.trim(),
				});
				return;
			}
			resolve({
				success: code === 0,
				code: code ?? -1,
				stdout: stdout.trimEnd(),
				stderr: stderr.trimEnd(),
			});
		});

		child.on("error", (error) => {
			if (closed) {
				return;
			}
			closed = true;
			cleanup();
			resolve({
				success: false,
				code: -1,
				stdout: stdout.trimEnd(),
				stderr:
					error instanceof Error ? error.message : String(error ?? "unknown"),
			});
		});
	});
}

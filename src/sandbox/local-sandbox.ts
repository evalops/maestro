/**
 * Local Sandbox - Direct Filesystem Execution
 *
 * This module provides a non-isolated sandbox that executes commands and
 * file operations directly on the local filesystem. It implements the
 * Sandbox interface for consistency but provides no actual isolation.
 *
 * ## Use Cases
 *
 * - Default execution environment when Docker is unavailable
 * - Development and testing scenarios
 * - Trusted workspace operations
 *
 * ## Operations
 *
 * | Method     | Description                               |
 * |------------|-------------------------------------------|
 * | exec()     | Run shell command via child_process       |
 * | readFile() | Read file contents using fs.readFile      |
 * | writeFile()| Write file contents using fs.writeFile    |
 * | exists()   | Check file existence using fs.access      |
 * | list()     | List directory contents                   |
 *
 * ## Security Note
 *
 * This sandbox provides NO isolation. Commands run with the same
 * permissions as the Maestro process. Use DockerSandbox for
 * isolated execution in untrusted environments.
 *
 * @module sandbox/local-sandbox
 */

import { exec, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveShellEnvironment } from "../utils/shell-env.js";
import {
	appendCapturedOutput,
	createOutputCapture,
	finalizeCapturedOutput,
} from "./output-capture.js";
import type { ExecResult, ExecWithArgsOptions, Sandbox } from "./types.js";

const execAsync = promisify(exec);
const EXEC_WITH_ARGS_MAX_BUFFER = 1024 * 1024;

export class LocalSandbox implements Sandbox {
	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<ExecResult> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd,
				env: resolveShellEnvironment(env, {
					workspaceDir: process.cwd(),
				}),
				signal,
			});
			return {
				stdout,
				stderr,
				exitCode: 0, // execAsync throws on non-zero exit, so if we're here it's 0
			};
		} catch (error: unknown) {
			const execError = error as {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: execError.stdout || "",
				stderr: execError.stderr || "",
				exitCode: execError.code || 1,
			};
		}
	}

	async execWithArgs(
		command: string,
		args: string[] = [],
		options: ExecWithArgsOptions = {},
	): Promise<ExecResult> {
		try {
			const maxBuffer = options.maxBuffer ?? EXEC_WITH_ARGS_MAX_BUFFER;
			return await new Promise<ExecResult>((resolve, reject) => {
				const child = spawn(command, args, {
					cwd: options.cwd,
					detached: true,
					env: resolveShellEnvironment(options.env, {
						workspaceDir: process.cwd(),
					}),
					stdio: ["ignore", "pipe", "pipe"],
				});
				const stdoutCapture = createOutputCapture();
				const stderrCapture = createOutputCapture();
				const killChildTree = (): void => {
					if (child.pid !== undefined) {
						try {
							process.kill(-child.pid, "SIGTERM");
							return;
						} catch {
							// Fall back for platforms without process groups.
						}
					}
					child.kill("SIGTERM");
				};
				const cleanupAbort = (): void => {
					options.signal?.removeEventListener("abort", killChildTree);
				};
				options.signal?.addEventListener("abort", killChildTree, {
					once: true,
				});
				if (options.signal?.aborted) {
					killChildTree();
				}

				child.stdout?.on("data", (data) => {
					appendCapturedOutput(stdoutCapture, Buffer.from(data), maxBuffer);
				});
				child.stderr?.on("data", (data) => {
					appendCapturedOutput(stderrCapture, Buffer.from(data), maxBuffer);
				});
				child.on("close", (code) => {
					cleanupAbort();
					resolve({
						stdout: finalizeCapturedOutput(stdoutCapture),
						stderr: finalizeCapturedOutput(stderrCapture),
						exitCode: code ?? 1,
					});
				});
				child.on("error", (error) => {
					cleanupAbort();
					const execError = error as Error & {
						stdout?: string;
						stderr?: string;
					};
					execError.stdout = finalizeCapturedOutput(stdoutCapture);
					execError.stderr =
						finalizeCapturedOutput(stderrCapture) || execError.message;
					reject(execError);
				});
			});
		} catch (error: unknown) {
			const execError = error as {
				stdout?: string;
				stderr?: string;
				message?: string;
				code?: number | string;
			};
			return {
				stdout: execError.stdout || "",
				stderr: execError.stderr || execError.message || "",
				exitCode: typeof execError.code === "number" ? execError.code : 1,
			};
		}
	}

	async readFile(path: string): Promise<string> {
		return readFile(path, "utf-8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await writeFile(path, content, "utf-8");
	}

	async exists(path: string): Promise<boolean> {
		try {
			await access(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async dispose(): Promise<void> {
		// Nothing to clean up for local sandbox
	}
}

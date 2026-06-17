/**
 * Docker Sandbox - Isolated Container Execution Environment
 *
 * This module provides a Docker-based sandbox for running commands and
 * file operations in an isolated container. It mounts the current workspace
 * and executes operations within the container.
 *
 * ## Features
 *
 * - **Isolation**: Commands run in a Docker container
 * - **Workspace mount**: Current directory mounted at /workspace
 * - **Persistent container**: Reuses container across operations
 * - **Cleanup**: Container automatically removed on dispose
 *
 * ## Default Configuration
 *
 * | Setting        | Default        | Description                  |
 * |----------------|----------------|------------------------------|
 * | image          | node:20-slim   | Docker image to use          |
 * | workspaceMount | /workspace     | Mount point in container     |
 *
 * ## Container Lifecycle
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Container Lifecycle                      │
 * ├─────────────────────────────────────────────────────────────┤
 * │  initialize()                                               │
 * │       │                                                     │
 * │       ▼                                                     │
 * │  docker run -d --rm ...  (starts detached container)        │
 * │       │                                                     │
 * │       ▼                                                     │
 * │  exec() / readFile() / writeFile() (reuse container)        │
 * │       │                                                     │
 * │       ▼                                                     │
 * │  dispose() → docker stop (container auto-removed)           │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Example
 *
 * ```typescript
 * const sandbox = new DockerSandbox({ image: 'python:3.12-slim' });
 * await sandbox.initialize();
 *
 * const result = await sandbox.exec('python --version');
 * console.log(result.stdout); // Python 3.12.x
 *
 * await sandbox.dispose();
 * ```
 *
 * @module sandbox/docker-sandbox
 */

import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";
import {
	appendCapturedOutput,
	createOutputCapture,
	finalizeCapturedOutput,
} from "./output-capture.js";
import type { ExecResult, ExecWithArgsOptions, Sandbox } from "./types.js";

const logger = createLogger("sandbox:docker");

const execAsync = promisify(exec);
const EXEC_WITH_ARGS_MAX_BUFFER = 1024 * 1024;
const DOCKER_ABORTABLE_EXEC_WRAPPER = `
child_pid=""
on_signal() {
	if [ -n "$child_pid" ]; then
		kill -TERM -- "-$child_pid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true
		wait "$child_pid" 2>/dev/null || true
	fi
	exit 143
}
trap on_signal TERM INT HUP
if command -v setsid >/dev/null 2>&1; then
	setsid "$@" &
else
	"$@" &
fi
child_pid=$!
wait "$child_pid"
`.trim();

export interface DockerSandboxConfig {
	image?: string;
	workspaceMount?: string;
}

export class DockerSandbox implements Sandbox {
	private containerId: string | null = null;
	private image: string;
	private workspaceMount: string;

	constructor(config: DockerSandboxConfig = {}) {
		this.image = config.image || "node:20-slim";
		this.workspaceMount = config.workspaceMount || "/workspace";
	}

	async initialize(): Promise<void> {
		if (this.containerId) return;

		// Start a detached container that stays alive
		const name = `composer-sandbox-${randomUUID()}`;
		const cmd = `docker run -d --rm --name ${name} -v "${process.cwd()}:${this.workspaceMount}" -w ${this.workspaceMount} ${this.image} tail -f /dev/null`;

		try {
			const { stdout } = await execAsync(cmd);
			this.containerId = stdout.trim();
		} catch (error) {
			throw new Error(`Failed to start docker sandbox: ${error}`);
		}
	}

	private async ensureContainer(): Promise<string> {
		if (!this.containerId) {
			await this.initialize();
		}
		if (!this.containerId) {
			throw new Error("Sandbox not initialized");
		}
		return this.containerId;
	}

	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<ExecResult> {
		const id = await this.ensureContainer();

		// Build argv for `spawn` — never a shell string. This is the
		// #2473 fix:
		//
		//   1. Env values are NOT placed on argv (the previous
		//      `-e KEY="value"` made secrets visible via `ps` to
		//      other users on the host). Instead we pass `-e KEY`
		//      (no value) and supply the value via the child
		//      process's environment, which Docker reads from there.
		//   2. Nothing is shelled on the host. The `command` string
		//      is still shelled inside the container via `sh -c`
		//      (that's the existing API contract), but no host-side
		//      escaping is needed and no values from `env` or `cwd`
		//      touch a shell on the host.
		const dockerArgs: string[] = ["exec"];
		if (cwd) {
			dockerArgs.push("-w", cwd);
		}
		const childEnv: NodeJS.ProcessEnv = { ...process.env };
		if (env) {
			for (const [k, v] of Object.entries(env)) {
				dockerArgs.push("-e", k);
				childEnv[k] = v;
			}
		}
		dockerArgs.push(id, "sh", "-c", command);

		return await new Promise<ExecResult>((resolve) => {
			const child = spawn("docker", dockerArgs, {
				signal,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			const stdoutCapture = createOutputCapture();
			const stderrCapture = createOutputCapture();
			child.stdout?.on("data", (data: Buffer) => {
				appendCapturedOutput(stdoutCapture, data, EXEC_WITH_ARGS_MAX_BUFFER);
			});
			child.stderr?.on("data", (data: Buffer) => {
				appendCapturedOutput(stderrCapture, data, EXEC_WITH_ARGS_MAX_BUFFER);
			});
			child.on("close", (code) => {
				resolve({
					stdout: finalizeCapturedOutput(stdoutCapture),
					stderr: finalizeCapturedOutput(stderrCapture),
					exitCode: code ?? 1,
				});
			});
			child.on("error", (error) => {
				resolve({
					stdout: finalizeCapturedOutput(stdoutCapture),
					stderr:
						finalizeCapturedOutput(stderrCapture) ||
						(error instanceof Error ? error.message : String(error)),
					exitCode: 1,
				});
			});
		});
	}

	async execWithArgs(
		command: string,
		args: string[] = [],
		options: ExecWithArgsOptions = {},
	): Promise<ExecResult> {
		try {
			const id = await this.ensureContainer();
			const dockerArgs = ["exec"];
			if (options.cwd) {
				dockerArgs.push("-w", options.cwd);
			}
			// Env values are passed via the child process's env, not on
			// argv. See #2473 — the previous `-e KEY=VALUE` form leaked
			// secrets to host `ps`. When `options.env` is absent we
			// leave the spawn options' `env` field undefined so the
			// child simply inherits the parent's env.
			let childEnv: NodeJS.ProcessEnv | undefined;
			if (options.env) {
				childEnv = { ...process.env };
				for (const key of Object.keys(options.env)) {
					dockerArgs.push("-e", key);
					childEnv[key] = options.env[key];
				}
			}
			if (options.signal) {
				dockerArgs.push(
					id,
					"sh",
					"-lc",
					DOCKER_ABORTABLE_EXEC_WRAPPER,
					"sh",
					command,
					...args,
				);
			} else {
				dockerArgs.push(id, command, ...args);
			}

			return await new Promise<ExecResult>((resolve, reject) => {
				const child = spawn("docker", dockerArgs, {
					signal: options.signal,
					stdio: ["ignore", "pipe", "pipe"],
					...(childEnv ? { env: childEnv } : {}),
				});
				const maxBuffer = options.maxBuffer ?? EXEC_WITH_ARGS_MAX_BUFFER;
				const stdoutCapture = createOutputCapture();
				const stderrCapture = createOutputCapture();

				child.stdout?.on("data", (data: Buffer) => {
					appendCapturedOutput(stdoutCapture, data, maxBuffer);
				});
				child.stderr?.on("data", (data: Buffer) => {
					appendCapturedOutput(stderrCapture, data, maxBuffer);
				});
				child.on("close", (code) => {
					resolve({
						stdout: finalizeCapturedOutput(stdoutCapture),
						stderr: finalizeCapturedOutput(stderrCapture),
						exitCode: code ?? 1,
					});
				});
				child.on("error", (error) => {
					const execError = error as Error & {
						stdout?: string;
						stderr?: string;
					};
					execError.stdout = finalizeCapturedOutput(stdoutCapture);
					execError.stderr = finalizeCapturedOutput(stderrCapture);
					reject(execError);
				});
			});
		} catch (error: unknown) {
			const execError = error as {
				stdout?: string;
				stderr?: string;
				code?: number | string;
				message?: string;
			};
			return {
				stdout: execError.stdout || "",
				stderr: execError.stderr || execError.message || "",
				exitCode: typeof execError.code === "number" ? execError.code : 1,
			};
		}
	}

	async readFile(path: string): Promise<string> {
		// Use execWithArgs so `path` is a separate argv entry — no
		// shell interpolation of the path on host OR in container.
		// Previously: `cat "${path}"` was sent through a shell, so
		// `path` containing `"` or `$` could break or inject (#2473).
		const result = await this.execWithArgs("cat", [path]);
		if (result.exitCode !== 0) {
			throw new Error(`Failed to read file: ${result.stderr}`);
		}
		return result.stdout;
	}

	async writeFile(path: string, content: string): Promise<void> {
		// Stream content over stdin (#2473). The previous
		// implementation built `echo "${content}" > "${path}"` with
		// naive quote-escaping, which corrupted any content containing
		// quotes, backslashes, `$`, backticks, newlines, or binary
		// bytes — and was shell-injectable via the path argument.
		//
		// Now: argv is fully spawn-quoted; the inner shell line
		// reads `path` as `$1` (literal param expansion, no further
		// shell interpretation), then `cat`s stdin into it. Content
		// round-trips byte-for-byte for any string.
		const id = await this.ensureContainer();
		const dockerArgs = ["exec", "-i", id, "sh", "-c", 'cat > "$1"', "sh", path];

		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", dockerArgs, {
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stderrCapture = createOutputCapture();
			child.stderr?.on("data", (data: Buffer) => {
				appendCapturedOutput(stderrCapture, data, EXEC_WITH_ARGS_MAX_BUFFER);
			});
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(
						new Error(
							`Failed to write file: ${finalizeCapturedOutput(stderrCapture)}`,
						),
					);
				}
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.stdin?.end(content);
		});
	}

	async exists(path: string): Promise<boolean> {
		// `test` directly invoked, no shell interpolation of path (#2473).
		const result = await this.execWithArgs("test", ["-e", path]);
		return result.exitCode === 0;
	}

	async dispose(): Promise<void> {
		if (this.containerId) {
			try {
				await execAsync(`docker stop ${this.containerId}`); // --rm handles removal
			} catch (err) {
				logger.debug("Failed to stop docker container during dispose", {
					containerId: this.containerId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			this.containerId = null;
		}
	}
}

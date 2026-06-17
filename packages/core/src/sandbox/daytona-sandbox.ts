/**
 * DaytonaSandbox — Sandbox implementation backed by Daytona cloud sandboxes.
 *
 * Implements the standard Sandbox interface so it can be used interchangeably
 * with LocalSandbox, DockerSandbox, and NativeSandbox.
 *
 * Uses a static factory (create) because sandbox creation is async.
 * Caches the sandbox handle to avoid redundant API calls per operation.
 */

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Daytona } from "@daytonaio/sdk";
import type {
	ExecResult,
	ExecWithArgsOptions,
	Sandbox,
} from "../../../../src/sandbox/types.js";

export interface DaytonaSandboxConfig {
	apiKey: string;
	apiUrl?: string;
	language?: string;
	ephemeral?: boolean;
}

type SandboxHandle = Awaited<
	ReturnType<InstanceType<typeof Daytona>["create"]>
>;

type DaytonaSessionCommand = {
	cmdId?: string;
	exitCode?: number;
};

type DaytonaSessionLogs = {
	output?: string;
	stdout?: string;
	stderr?: string;
};

type DaytonaProcessApi = SandboxHandle["process"] & {
	createSession?: (sessionId: string) => Promise<void>;
	deleteSession?: (sessionId: string) => Promise<void>;
	executeSessionCommand?: (
		sessionId: string,
		req: {
			command: string;
			runAsync?: boolean;
			suppressInputEcho?: boolean;
		},
		timeout?: number,
	) => Promise<DaytonaSessionCommand>;
	getSessionCommand?: (
		sessionId: string,
		commandId: string,
	) => Promise<DaytonaSessionCommand>;
	getSessionCommandLogs?: (
		sessionId: string,
		commandId: string,
	) => Promise<DaytonaSessionLogs>;
};

const SESSION_POLL_MS = 100;
const SESSION_COMMAND_TIMEOUT_MS = 90_000;
const EXEC_OUTPUT_MAX_BUFFER = 40 * 1024;

function cancelledExecResult(): ExecResult {
	return { stdout: "", stderr: "", exitCode: 1 };
}

function quoteShellArg(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function truncateOutput(value: string, maxBuffer?: number): string {
	if (maxBuffer === undefined) {
		return value;
	}
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBuffer) {
		return value;
	}
	// `Buffer#toString("utf-8")` on a raw slice emits U+FFFD when the cut
	// lands inside a multi-byte sequence. Decode through StringDecoder
	// instead — `write()` returns only complete characters and buffers any
	// trailing partial bytes internally. Since we discard everything past
	// `maxBuffer`, the buffered bytes are dropped silently, so the result
	// is always ≤ maxBuffer bytes and never contains a replacement
	// character at the boundary.
	const decoder = new StringDecoder("utf8");
	return decoder.write(bytes.subarray(0, maxBuffer));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaytonaSandbox implements Sandbox {
	private constructor(private handle: SandboxHandle) {}

	private hasSessionApi(processApi: DaytonaProcessApi): boolean {
		return !!(
			processApi.createSession &&
			processApi.deleteSession &&
			processApi.executeSessionCommand &&
			processApi.getSessionCommand &&
			processApi.getSessionCommandLogs
		);
	}

	private buildShellCommand(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): string {
		let fullCommand = command;
		if (env && Object.keys(env).length > 0) {
			const envPrefix = Object.entries(env)
				.map(([k, v]) => {
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
						throw new Error(`Invalid environment variable name: ${k}`);
					}
					const escaped = v.replace(/'/g, "'\\''");
					return `${k}='${escaped}'`;
				})
				.join(" ");
			fullCommand = `${envPrefix} ${fullCommand}`;
		}
		if (cwd) {
			const escapedCwd = cwd.replace(/'/g, "'\\''");
			fullCommand = `cd '${escapedCwd}' && ${fullCommand}`;
		}
		return fullCommand;
	}

	private async execWithSession(
		command: string,
		options: ExecWithArgsOptions = {},
	): Promise<ExecResult> {
		const processApi = this.handle.process as DaytonaProcessApi;
		if (!this.hasSessionApi(processApi)) {
			if (options.signal?.aborted) {
				return cancelledExecResult();
			}
			if (options.signal) {
				throw new Error(
					"Daytona abortable execution requires session API support",
				);
			}
			const result = await processApi.executeCommand(command);
			return {
				stdout: truncateOutput(result.result, options.maxBuffer),
				stderr: "",
				exitCode: result.exitCode,
			};
		}

		const sessionId = `maestro-exec-${randomUUID()}`;
		let sessionDeleted = false;
		let sessionDeletePromise: Promise<void> | undefined;
		const deleteSession = async (): Promise<void> => {
			if (sessionDeleted) {
				return;
			}
			if (sessionDeletePromise) {
				await sessionDeletePromise;
				if (sessionDeleted) {
					return;
				}
			}
			sessionDeletePromise = (async () => {
				try {
					await processApi.deleteSession!(sessionId);
					sessionDeleted = true;
				} catch {
					// The session may not exist yet during setup cancellation.
				} finally {
					sessionDeletePromise = undefined;
				}
			})();
			await sessionDeletePromise;
		};
		// Tracks whether the async session command was started but never
		// observed to complete. We use this to warn loudly if the caller
		// aborts mid-execution: Daytona's `deleteSession` is documented to
		// terminate the associated process (see
		// `deleteSessionDeprecated`: "Delete a PTY session and terminate the
		// associated process"), but the SDK exposes no direct
		// command-cancellation endpoint, so the in-flight remote process
		// outliving the session would be invisible to us without this log.
		let inflightCmdId: string | null = null;
		const abortSession = (): void => {
			void deleteSession();
		};
		options.signal?.addEventListener("abort", abortSession, { once: true });

		try {
			if (options.signal?.aborted) {
				return cancelledExecResult();
			}
			await processApi.createSession(sessionId);
			if (options.signal?.aborted) {
				return cancelledExecResult();
			}

			const response = await processApi.executeSessionCommand(sessionId, {
				command,
				runAsync: true,
				suppressInputEcho: true,
			});
			if (!response.cmdId) {
				throw new Error("Daytona session command did not return a command id");
			}
			inflightCmdId = response.cmdId;

			const startedAt = Date.now();
			while (!options.signal?.aborted) {
				if (Date.now() - startedAt >= SESSION_COMMAND_TIMEOUT_MS) {
					throw new Error("Daytona session command timed out");
				}
				const commandState = await processApi.getSessionCommand(
					sessionId,
					response.cmdId,
				);
				if (options.signal?.aborted) {
					return cancelledExecResult();
				}
				if (typeof commandState.exitCode === "number") {
					inflightCmdId = null;
					const logs = await processApi.getSessionCommandLogs(
						sessionId,
						response.cmdId,
					);
					if (options.signal?.aborted) {
						return cancelledExecResult();
					}
					return {
						stdout: truncateOutput(
							logs.stdout ?? logs.output ?? "",
							options.maxBuffer,
						),
						stderr: truncateOutput(logs.stderr ?? "", options.maxBuffer),
						exitCode: commandState.exitCode,
					};
				}
				await sleep(SESSION_POLL_MS);
			}

			return cancelledExecResult();
		} finally {
			options.signal?.removeEventListener("abort", abortSession);
			await deleteSession();
			if (options.signal?.aborted && inflightCmdId) {
				// Surface the residual-process risk so a stuck/long-lived
				// remote command after an aborted session is at least
				// observable. The Daytona session API does not currently
				// expose a way for us to verify termination ourselves.
				console.warn(
					`[daytona] Session ${sessionId} aborted with command ${inflightCmdId} still in flight; relying on Daytona's documented deleteSession-terminates-process contract.`,
				);
			}
		}
	}

	/**
	 * Create a new Daytona sandbox. This is async because it provisions
	 * a remote sandbox environment.
	 */
	static async create(config: DaytonaSandboxConfig): Promise<DaytonaSandbox> {
		const client = new Daytona({
			apiKey: config.apiKey,
			apiUrl: config.apiUrl || "https://app.daytona.io/api",
		});
		const handle = await client.create({
			language: config.language ?? "python",
			ephemeral: config.ephemeral ?? false,
		});
		return new DaytonaSandbox(handle);
	}

	get id(): string {
		return this.handle.id;
	}

	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<ExecResult> {
		try {
			const fullCommand = this.buildShellCommand(command, cwd, env);
			const processApi = this.handle.process as DaytonaProcessApi;
			if (signal?.aborted) {
				return cancelledExecResult();
			}
			if (signal && this.hasSessionApi(processApi)) {
				return await this.execWithSession(fullCommand, {
					signal,
					maxBuffer: EXEC_OUTPUT_MAX_BUFFER,
				});
			}
			const result = await processApi.executeCommand(fullCommand);
			// Apply the same `EXEC_OUTPUT_MAX_BUFFER` cap as the session
			// path so a single sandbox can't accidentally load unbounded
			// log output through one entry point but not the other
			// (Cursor Bugbot rounds 4–5 on PR #2748).
			return {
				stdout: truncateOutput(result.result, EXEC_OUTPUT_MAX_BUFFER),
				stderr: "",
				exitCode: result.exitCode,
			};
		} catch (err) {
			return {
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				exitCode: 1,
			};
		}
	}

	async execWithArgs(
		command: string,
		args: string[] = [],
		options: ExecWithArgsOptions = {},
	): Promise<ExecResult> {
		try {
			const fullCommand = this.buildShellCommand(
				[command, ...args].map(quoteShellArg).join(" "),
				options.cwd,
				options.env,
			);
			// Default `maxBuffer` to `EXEC_OUTPUT_MAX_BUFFER` so both the
			// signal/session path and the plain executeCommand path apply
			// the same cap. Without this default the caller could omit
			// `maxBuffer` and load unbounded stdout — the inconsistency
			// Cursor Bugbot flagged on PR #2748.
			const maxBuffer = options.maxBuffer ?? EXEC_OUTPUT_MAX_BUFFER;
			// Cursor Bugbot finding on PR #2757 (medium): gate the session
			// path on `hasSessionApi` the same way `exec` does. Without
			// this gate, `execWithArgs("cmd", [], { signal })` on a
			// Daytona build that doesn't expose session APIs causes
			// `execWithSession` to throw outright instead of falling back
			// to plain `executeCommand`. Match `exec`'s graceful-fallback
			// behavior: if abort isn't supported by this sandbox build,
			// honor the already-aborted signal but otherwise run the
			// command as a non-abortable plain exec.
			const processApi = this.handle.process as DaytonaProcessApi;
			if (options.signal?.aborted) {
				return cancelledExecResult();
			}
			if (options.signal && this.hasSessionApi(processApi)) {
				return await this.execWithSession(fullCommand, {
					...options,
					maxBuffer,
				});
			}
			const result = await this.handle.process.executeCommand(fullCommand);
			return {
				stdout: truncateOutput(result.result, maxBuffer),
				stderr: "",
				exitCode: result.exitCode,
			};
		} catch (err) {
			return {
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				exitCode: 1,
			};
		}
	}

	async readFile(path: string): Promise<string> {
		const content = await this.handle.fs.downloadFile(path);
		return typeof content === "string" ? content : content.toString("utf-8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.handle.fs.uploadFile(Buffer.from(content), path);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.handle.fs.getFileDetails(path);
			return true;
		} catch {
			return false;
		}
	}

	async list(path: string): Promise<string[]> {
		const files = await this.handle.fs.listFiles(path);
		return files.map((f: { name: string }) => f.name);
	}

	async delete(path: string, recursive?: boolean): Promise<void> {
		await this.handle.fs.deleteFile(path, recursive);
	}

	async dispose(): Promise<void> {
		try {
			await this.handle.delete();
		} catch {
			// Sandbox may already be deleted (ephemeral mode)
		}
	}
}

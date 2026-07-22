/**
 * Native headless NDJSON client for maestro-tui --headless.
 *
 * Spawns the native binary with piped stdio and speaks the headless protocol
 * (see src/cli/headless-protocol.ts). This is the production typed client for
 * JSON-over-stdio agent control (including CLI `--mode rpc`, which launches
 * native headless). The legacy TS RpcClient residual was removed.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Interface, createInterface } from "node:readline";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessApprovalMode,
	type HeadlessConnectionRole,
	type HeadlessFromAgentMessage,
	type HeadlessHistoryMessage,
	type HeadlessReadyMessage,
	type HeadlessThinkingLevel,
	type HeadlessToAgentMessage,
} from "../cli/headless-protocol.js";
import { spawnNativeHeadlessProcess } from "../cli/native-tui-launcher.js";
import { isRecord } from "../utils/json.js";

export type NativeHeadlessClientOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Inject spawn for tests. */
	spawnProcess?: () => {
		child: ChildProcess;
		binary: string;
		args: string[];
	};
	/** Timeout waiting for first ready message (default 15000). */
	readyTimeoutMs?: number;
};

function isHeadlessFromAgentMessage(
	value: unknown,
): value is HeadlessFromAgentMessage {
	return isRecord(value) && typeof value.type === "string";
}

function isReadyMessage(
	message: HeadlessFromAgentMessage,
): message is HeadlessReadyMessage {
	return message.type === "ready";
}

export class NativeHeadlessClient extends EventEmitter {
	private process: ChildProcess | null = null;
	private readline: Interface | null = null;
	private running = false;
	private stopped = false;
	private readonly options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		spawnProcess?: NativeHeadlessClientOptions["spawnProcess"];
		readyTimeoutMs: number;
	};

	constructor(options: NativeHeadlessClientOptions = {}) {
		super();
		this.options = {
			cwd: options.cwd,
			env: options.env,
			spawnProcess: options.spawnProcess,
			readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
		};
	}

	get isRunning(): boolean {
		return this.running && this.process !== null;
	}

	/**
	 * Start the child process and wait for the first `ready` message.
	 */
	async start(): Promise<HeadlessReadyMessage> {
		if (this.process) {
			throw new Error("NativeHeadlessClient already started");
		}
		this.stopped = false;

		const spawned = this.options.spawnProcess
			? this.options.spawnProcess()
			: spawnNativeHeadlessProcess({
					cwd: this.options.cwd,
					env: this.options.env,
				});

		this.process = spawned.child;

		if (!this.process.stdin || !this.process.stdout) {
			this.cleanupProcess();
			throw new Error(
				"Failed to create stdio pipes for native headless process",
			);
		}

		this.readline = createInterface({
			input: this.process.stdout,
			terminal: false,
		});

		this.readline.on("line", (line) => {
			this.handleLine(line);
		});

		this.process.on("error", (error) => {
			this.emit("error", error);
		});

		this.process.on("exit", (code) => {
			this.running = false;
			this.emit("exit", code);
			this.cleanupIo();
		});

		this.process.stderr?.on("data", (data: Buffer | string) => {
			this.emit("stderr", data.toString());
		});

		this.running = true;

		return this.waitForReady();
	}

	/**
	 * Send any protocol message as a JSON line on stdin.
	 */
	send(msg: HeadlessToAgentMessage): void {
		if (!this.process?.stdin || this.stopped) {
			throw new Error("NativeHeadlessClient is not running");
		}
		if (this.process.stdin.destroyed || !this.process.stdin.writable) {
			throw new Error("NativeHeadlessClient stdin is not writable");
		}
		this.process.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	/**
	 * Convenience: hello with protocol_version from HEADLESS_PROTOCOL_VERSION.
	 */
	hello(opts?: {
		clientName?: string;
		role?: HeadlessConnectionRole;
	}): void {
		this.send({
			type: "hello",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			client_info: {
				name: opts?.clientName ?? "maestro-web",
			},
			...(opts?.role ? { role: opts.role } : {}),
		});
	}

	/**
	 * Convenience: init with model-related fields if supported.
	 *
	 * Use `history` for structured prior turns. `append_system_prompt` is reserved
	 * for trusted system guidance and must not contain conversation history.
	 */
	init(opts?: {
		thinking_level?: HeadlessThinkingLevel;
		approval_mode?: HeadlessApprovalMode;
		system_prompt?: string;
		append_system_prompt?: string;
		/** Structured prior conversation (protocol field on init). */
		history?: HeadlessHistoryMessage[];
	}): void {
		this.send({
			type: "init",
			...(opts?.thinking_level !== undefined
				? { thinking_level: opts.thinking_level }
				: {}),
			...(opts?.approval_mode !== undefined
				? { approval_mode: opts.approval_mode }
				: {}),
			...(opts?.system_prompt !== undefined
				? { system_prompt: opts.system_prompt }
				: {}),
			...(opts?.append_system_prompt !== undefined
				? { append_system_prompt: opts.append_system_prompt }
				: {}),
			...(opts?.history !== undefined && opts.history.length > 0
				? { history: opts.history }
				: {}),
		});
	}

	/**
	 * Seed structured conversation history via `init.history`.
	 *
	 * Equivalent to `init({ history })`. Web and automation turns include
	 * structured history in their initial init message.
	 */
	seedHistory(messages: HeadlessHistoryMessage[]): void {
		if (!messages.length) return;
		this.init({ history: messages });
	}

	/** Convenience: prompt. */
	prompt(content: string, attachments?: string[]): void {
		this.send({
			type: "prompt",
			content,
			...(attachments && attachments.length > 0 ? { attachments } : {}),
		});
	}

	interrupt(): void {
		this.send({ type: "interrupt" });
	}

	cancel(): void {
		this.send({ type: "cancel" });
	}

	shutdown(): void {
		this.send({ type: "shutdown" });
	}

	/**
	 * Kill the process and close readline. Attempts shutdown first when possible.
	 */
	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.running = false;

		if (this.process?.stdin && !this.process.stdin.destroyed) {
			try {
				this.process.stdin.write(
					`${JSON.stringify({ type: "shutdown" } satisfies HeadlessToAgentMessage)}\n`,
				);
			} catch {
				// Best-effort shutdown before kill.
			}
		}

		if (this.process) {
			try {
				this.process.kill();
			} catch {
				// Process may already have exited.
			}
			this.process = null;
		}

		this.cleanupIo();
	}

	private waitForReady(): Promise<HeadlessReadyMessage> {
		return new Promise((resolve, reject) => {
			const timeoutMs = this.options.readyTimeoutMs;
			let settled = false;

			const cleanup = () => {
				this.off("ready", onReady);
				this.off("error", onError);
				this.off("exit", onExit);
				clearTimeout(timer);
			};

			const settleOk = (message: HeadlessReadyMessage) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(message);
			};

			const settleErr = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};

			const onReady = (message: HeadlessReadyMessage) => {
				settleOk(message);
			};

			const onError = (error: unknown) => {
				// Non-fatal parse errors during startup should not abort wait;
				// only process-level errors reject.
				if (
					error instanceof Error &&
					error.message.startsWith("Failed to parse")
				) {
					return;
				}
				settleErr(error instanceof Error ? error : new Error(String(error)));
			};

			const onExit = (code: number | null) => {
				settleErr(
					new Error(
						`Native headless process exited before ready (code=${code ?? "null"})`,
					),
				);
			};

			const timer = setTimeout(() => {
				settleErr(
					new Error(
						`Timed out waiting for native headless ready after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			this.on("ready", onReady);
			this.on("error", onError);
			this.on("exit", onExit);

			// If a ready was already emitted (unlikely before listeners), check is not needed —
			// ready only fires after start attaches the readline handler.
		});
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			this.emit(
				"error",
				new Error(`Failed to parse headless message: ${trimmed}`),
			);
			return;
		}

		if (!isHeadlessFromAgentMessage(parsed)) {
			this.emit(
				"error",
				new Error(`Invalid headless message shape: ${trimmed}`),
			);
			return;
		}

		this.emit("message", parsed);

		if (isReadyMessage(parsed)) {
			this.emit("ready", parsed);
		}

		if (parsed.type === "error" && parsed.fatal) {
			this.emit(
				"error",
				new Error(`Fatal headless protocol error: ${parsed.message}`),
			);
		}
	}

	private cleanupIo(): void {
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}
	}

	private cleanupProcess(): void {
		this.running = false;
		if (this.process) {
			try {
				this.process.kill();
			} catch {
				// ignore
			}
			this.process = null;
		}
		this.cleanupIo();
	}
}

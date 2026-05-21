import { spawn as spawnChild } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { readPackageVersion } from "../package-version.js";

type JsonRpcId = number | string;

export interface CodexAppServerTransport {
	stdin: Writable;
	stdout: Readable;
	stderr?: Readable | null;
	kill?: (signal?: NodeJS.Signals | number) => boolean;
	on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
	once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface CodexAppServerClientInfo {
	name: string;
	title?: string;
	version?: string;
}

export interface CodexAppServerInitializeOptions {
	clientInfo?: CodexAppServerClientInfo;
	experimentalApi?: boolean;
	optOutNotificationMethods?: string[];
	timeoutMs?: number;
}

export interface CreateCodexAppServerClientOptions {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
}

export type CodexAccount =
	| { type: "apiKey" }
	| { type: "chatgpt"; email: string; planType: string }
	| { type: string; [key: string]: unknown };

export interface CodexAccountReadResult {
	account: CodexAccount | null;
	requiresOpenaiAuth: boolean;
}

export type CodexLoginStartResult =
	| { type: "apiKey" }
	| { type: "chatgpt"; loginId: string; authUrl: string }
	| {
			type: "chatgptDeviceCode";
			loginId: string;
			verificationUrl: string;
			userCode: string;
	  }
	| { type: string; [key: string]: unknown };

export interface CodexLoginCompletedNotification {
	loginId: string | null;
	success: boolean;
	error: string | null;
}

export interface CodexAppServerNotification<TParams = unknown> {
	method: string;
	params?: TParams;
}

export interface CodexAppServerRequest<TParams = unknown> {
	id: JsonRpcId;
	method: string;
	params?: TParams;
}

export type CodexAppServerRequestHandlerResult =
	| {
			handled: true;
			result?: unknown;
	  }
	| {
			handled: true;
			error: {
				code?: number;
				message: string;
				data?: unknown;
			};
	  }
	| {
			handled: false;
	  };

export type CodexAppServerRequestHandler = (
	request: CodexAppServerRequest,
) =>
	| CodexAppServerRequestHandlerResult
	| Promise<CodexAppServerRequestHandlerResult>;

export interface CodexAppServerClientLike {
	initialize(options?: CodexAppServerInitializeOptions): Promise<unknown>;
	request<TResult = unknown>(
		method: string,
		params?: unknown,
		options?: { timeoutMs?: number },
	): Promise<TResult>;
	notify(method: string, params?: unknown): void;
	onNotification(
		listener: (notification: CodexAppServerNotification) => void,
	): () => void;
	onRequest(listener: CodexAppServerRequestHandler): () => void;
	readAccount(refreshToken?: boolean): Promise<CodexAccountReadResult>;
	startChatGptLogin(
		flow?: "browser" | "device",
	): Promise<CodexLoginStartResult>;
	waitForLoginCompletion(
		loginId: string,
		timeoutMs?: number,
	): Promise<CodexLoginCompletedNotification>;
	logout(): Promise<void>;
	close(): void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface PendingNotification {
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	unsubscribe: () => void;
}

interface JsonRpcResponse {
	id?: JsonRpcId;
	result?: unknown;
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_NOTIFICATION_HISTORY = 100;
const DEFAULT_CLIENT_INFO: CodexAppServerClientInfo = {
	name: "maestro",
	title: "Maestro",
	version: readPackageVersion(),
};

export class CodexAppServerRpcClient implements CodexAppServerClientLike {
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly notificationListeners = new Set<
		(notification: CodexAppServerNotification) => void
	>();
	private readonly notificationHistory: CodexAppServerNotification[] = [];
	private readonly notificationWaiters = new Set<PendingNotification>();
	private readonly requestHandlers = new Set<CodexAppServerRequestHandler>();
	private readonly stderrTail: string[] = [];
	private readonly rl: ReadlineInterface;
	private nextId = 1;
	private closed = false;

	constructor(
		private readonly transport: CodexAppServerTransport,
		private readonly options: { requestTimeoutMs?: number } = {},
	) {
		this.rl = createInterface({ input: transport.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
		this.rl.on("close", () => this.rejectAll("Codex app-server closed stdout"));
		transport.stderr?.on("data", (chunk) => this.captureStderr(chunk));
		transport.once?.("exit", (code, signal) => {
			const suffix =
				code === null || code === undefined
					? `signal ${String(signal)}`
					: `code ${String(code)}`;
			this.rejectAll(`Codex app-server exited with ${suffix}`);
		});
		transport.once?.("error", (error) => {
			const message =
				error instanceof Error
					? error.message
					: `Process error: ${String(error)}`;
			this.rejectAll(message);
		});
	}

	static spawn(
		options: CreateCodexAppServerClientOptions = {},
	): CodexAppServerRpcClient {
		const command = options.command ?? "codex";
		const args = options.args ?? ["app-server", "--listen", "stdio://"];
		const child: ChildProcessWithoutNullStreams = spawnChild(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: "pipe",
		});
		return new CodexAppServerRpcClient(child, {
			requestTimeoutMs: options.requestTimeoutMs,
		});
	}

	async initialize(
		options: CodexAppServerInitializeOptions = {},
	): Promise<unknown> {
		const capabilities =
			options.experimentalApi || options.optOutNotificationMethods?.length
				? {
						experimentalApi: options.experimentalApi || undefined,
						optOutNotificationMethods:
							options.optOutNotificationMethods ?? undefined,
					}
				: undefined;
		const result = await this.request(
			"initialize",
			{
				clientInfo: options.clientInfo ?? DEFAULT_CLIENT_INFO,
				capabilities,
			},
			{ timeoutMs: options.timeoutMs },
		);
		this.notify("initialized");
		return result;
	}

	request<TResult = unknown>(
		method: string,
		params?: unknown,
		options: { timeoutMs?: number } = {},
	): Promise<TResult> {
		if (this.closed) {
			return Promise.reject(new Error("Codex app-server client is closed"));
		}
		const id = this.nextId++;
		const timeoutMs =
			options.timeoutMs ??
			this.options.requestTimeoutMs ??
			DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise<TResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as TResult),
				reject,
				timer,
			});
			try {
				this.writeMessage({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	notify(method: string, params?: unknown): void {
		this.writeMessage({ method, params });
	}

	onNotification(
		listener: (notification: CodexAppServerNotification) => void,
	): () => void {
		this.notificationListeners.add(listener);
		return () => {
			this.notificationListeners.delete(listener);
		};
	}

	onRequest(listener: CodexAppServerRequestHandler): () => void {
		this.requestHandlers.add(listener);
		return () => {
			this.requestHandlers.delete(listener);
		};
	}

	waitForNotification<TParams = unknown>(
		predicate: (notification: CodexAppServerNotification) => boolean,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<CodexAppServerNotification<TParams>> {
		const buffered = this.notificationHistory.find(predicate);
		if (buffered) {
			return Promise.resolve(buffered as CodexAppServerNotification<TParams>);
		}
		if (this.closed) {
			return Promise.reject(new Error("Codex app-server client is closed"));
		}
		return new Promise((resolve, reject) => {
			let unsubscribe = () => {};
			const waiter: PendingNotification = {
				reject: (error) => {
					clearTimeout(waiter.timer);
					unsubscribe();
					this.notificationWaiters.delete(waiter);
					reject(error);
				},
				timer: setTimeout(() => {
					waiter.reject(
						new Error("Timed out waiting for Codex app-server notification"),
					);
				}, timeoutMs),
				unsubscribe: () => unsubscribe(),
			};
			unsubscribe = this.onNotification((notification) => {
				if (!predicate(notification)) {
					return;
				}
				clearTimeout(waiter.timer);
				waiter.unsubscribe();
				this.notificationWaiters.delete(waiter);
				resolve(notification as CodexAppServerNotification<TParams>);
			});
			this.notificationWaiters.add(waiter);
		});
	}

	readAccount(refreshToken = false): Promise<CodexAccountReadResult> {
		return this.request("account/read", { refreshToken });
	}

	startChatGptLogin(
		flow: "browser" | "device" = "browser",
	): Promise<CodexLoginStartResult> {
		return this.request("account/login/start", {
			type: flow === "device" ? "chatgptDeviceCode" : "chatgpt",
		});
	}

	async waitForLoginCompletion(
		loginId: string,
		timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
	): Promise<CodexLoginCompletedNotification> {
		const notification =
			await this.waitForNotification<CodexLoginCompletedNotification>(
				(candidate) =>
					candidate.method === "account/login/completed" &&
					isRecord(candidate.params) &&
					candidate.params.loginId === loginId,
				timeoutMs,
			);
		const params = notification.params;
		if (!params?.success) {
			throw new Error(params?.error || "ChatGPT sign-in did not complete");
		}
		return params;
	}

	async logout(): Promise<void> {
		await this.request("account/logout", undefined);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.rejectAll("Codex app-server client closed");
		this.rl.close();
		try {
			this.transport.stdin.end();
		} catch {
			// Best-effort shutdown only.
		}
		this.transport.kill?.("SIGTERM");
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!isRecord(message)) {
			return;
		}
		if ("id" in message && ("result" in message || "error" in message)) {
			this.handleResponse(message as JsonRpcResponse);
			return;
		}
		if (typeof message.method === "string" && "id" in message) {
			void this.handleServerRequest(
				message as unknown as CodexAppServerRequest,
			);
			return;
		}
		if (typeof message.method === "string") {
			this.emitNotification({
				method: message.method,
				params: message.params,
			});
		}
	}

	private handleResponse(response: JsonRpcResponse): void {
		if (response.id === undefined) {
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.error) {
			const message =
				response.error.message ?? "Codex app-server request failed";
			pending.reject(new Error(message));
			return;
		}
		pending.resolve(response.result);
	}

	private async handleServerRequest(
		request: CodexAppServerRequest,
	): Promise<void> {
		this.emitNotification({
			method: request.method,
			params: request.params,
		});

		for (const handler of Array.from(this.requestHandlers)) {
			try {
				const handled = await handler(request);
				if (!handled.handled) {
					continue;
				}
				if ("error" in handled) {
					this.writeMessage({
						id: request.id,
						error: {
							code: handled.error.code ?? -32000,
							message: handled.error.message,
							data: handled.error.data,
						},
					});
					return;
				}
				this.writeMessage({ id: request.id, result: handled.result });
				return;
			} catch (error: unknown) {
				this.writeMessage({
					id: request.id,
					error: {
						code: -32000,
						message: error instanceof Error ? error.message : String(error),
					},
				});
				return;
			}
		}

		const fallback = defaultServerRequestResponse(request.method);
		if (fallback.ok) {
			this.writeMessage({ id: request.id, result: fallback.result });
			return;
		}
		this.writeMessage({
			id: request.id,
			error: {
				code: -32601,
				message: `Unsupported Codex app-server request: ${request.method}`,
			},
		});
	}

	private emitNotification(notification: CodexAppServerNotification): void {
		this.notificationHistory.push(notification);
		if (this.notificationHistory.length > MAX_NOTIFICATION_HISTORY) {
			this.notificationHistory.shift();
		}
		for (const listener of this.notificationListeners) {
			listener(notification);
		}
	}

	private writeMessage(message: Record<string, unknown>): void {
		const compact = Object.fromEntries(
			Object.entries(message).filter(([, value]) => value !== undefined),
		);
		const line = `${JSON.stringify(compact)}\n`;
		if (!this.transport.stdin.write(line)) {
			// Backpressure is tiny for JSON-RPC control messages; the stream queues it.
		}
	}

	private captureStderr(chunk: unknown): void {
		const text = Buffer.isBuffer(chunk)
			? chunk.toString("utf8")
			: String(chunk);
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			this.stderrTail.push(trimmed);
			if (this.stderrTail.length > 20) {
				this.stderrTail.shift();
			}
		}
	}

	private rejectAll(message: string): void {
		this.closed = true;
		const stderr = this.stderrTail.length
			? `\n${this.stderrTail.slice(-5).join("\n")}`
			: "";
		const error = new Error(`${message}${stderr}`);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of Array.from(this.notificationWaiters)) {
			waiter.reject(error);
		}
		this.notificationWaiters.clear();
	}
}

export function createCodexAppServerClient(
	options: CreateCodexAppServerClientOptions = {},
): CodexAppServerRpcClient {
	return CodexAppServerRpcClient.spawn(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function defaultServerRequestResponse(
	method: string,
): { ok: true; result: unknown } | { ok: false } {
	switch (method) {
		case "item/commandExecution/requestApproval":
			return { ok: true, result: { decision: "decline" } };
		case "item/fileChange/requestApproval":
			return { ok: true, result: { decision: "decline" } };
		case "item/permissions/requestApproval":
			return { ok: true, result: { permissions: {}, scope: "turn" } };
		case "item/tool/requestUserInput":
			return { ok: true, result: { answers: {} } };
		case "mcpServer/elicitation/request":
			return {
				ok: true,
				result: { action: "decline", content: null, _meta: null },
			};
		case "applyPatchApproval":
		case "execCommandApproval":
			return { ok: true, result: { decision: "denied" } };
		default:
			return { ok: false };
	}
}

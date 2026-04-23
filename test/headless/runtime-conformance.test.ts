import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HeadlessRuntimeHeartbeatSnapshotSchema,
	HeadlessRuntimeSnapshotSchema,
	HeadlessRuntimeStreamEnvelopeSchema,
	HeadlessRuntimeSubscriptionSnapshotSchema,
} from "@evalops/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
	ApprovalMode,
} from "../../src/agent/action-approval.js";
import type {
	AgentEvent,
	AppMessage,
	Attachment,
	ThinkingLevel,
} from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessClientCapabilities,
	type HeadlessToAgentMessage,
} from "../../src/cli/headless-protocol.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import { HeadlessInProcessHost } from "../../src/server/headless-in-process-host.js";
import {
	type HeadlessAttachedSubscription,
	type HeadlessRuntimeConnectionClosedSnapshot,
	type HeadlessRuntimeHeartbeatSnapshot,
	HeadlessRuntimeService,
	type HeadlessRuntimeSnapshot,
	type HeadlessRuntimeStreamEnvelope,
	type HeadlessRuntimeSubscriptionSnapshot,
} from "../../src/server/headless-runtime-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";
import { SessionManager } from "../../src/session/manager.js";

const TEST_MODEL: RegisteredModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200_000,
	maxTokens: 32_000,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

const DEFAULT_CAPABILITIES: HeadlessClientCapabilities = {
	server_requests: ["approval", "client_tool", "tool_retry"],
	utility_operations: [
		"command_exec",
		"file_search",
		"file_read",
		"file_watch",
	],
	raw_agent_events: true,
};

type MaybePromise<T> = T | Promise<T>;

class FakeAgent {
	state = {
		model: TEST_MODEL,
		systemPrompt: "",
		thinkingLevel: "off" as ThinkingLevel,
		tools: [],
		messages: [] as AppMessage[],
	};
	prompts: Array<{ content: string; attachments?: Attachment[] }> = [];
	aborts = 0;
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	subscribe(listener: (event: AgentEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setSystemPrompt(value: string) {
		this.state.systemPrompt = value;
	}

	setThinkingLevel(level: ThinkingLevel) {
		this.state.thinkingLevel = level;
	}

	abort() {
		this.aborts += 1;
	}

	async prompt(content: string, attachments?: Attachment[]) {
		this.prompts.push({ content, attachments });
		this.emit({
			type: "status",
			status: `Prompt: ${content}`,
			details: {},
		});
	}

	emit(event: AgentEvent) {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

interface StartOptions {
	approvalMode?: ApprovalMode;
	capabilities?: HeadlessClientCapabilities;
}

interface SendOptions {
	role?: "viewer" | "controller";
	connectionId?: string | null;
	subscriptionId?: string | null;
}

interface HostedDrainRequest {
	reason?: string;
	requested_by?: string;
	export_paths?: string[];
}

interface HostedDrainResult {
	protocol_version: string;
	status: string;
	runner_session_id: string;
	requested_by?: string | null;
	reason?: string | null;
	manifest_path: string;
	manifest?: Record<string, unknown>;
}

interface RuntimeConformanceAdapter {
	readonly label: string;
	readonly workspaceRoot: string;
	readonly outsideRoot: string;
	start(options?: StartOptions): Promise<HeadlessRuntimeSnapshot>;
	subscribe(options: {
		role?: "viewer" | "controller";
		takeControl?: boolean;
	}): MaybePromise<HeadlessRuntimeSubscriptionSnapshot>;
	attachStream(options: {
		role?: "viewer" | "controller";
		cursor?: number | null;
	}): MaybePromise<HeadlessAttachedSubscription>;
	send(
		message: HeadlessToAgentMessage,
		options?: SendOptions,
	): Promise<HeadlessRuntimeSnapshot>;
	heartbeat(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): MaybePromise<HeadlessRuntimeHeartbeatSnapshot>;
	disconnect(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeConnectionClosedSnapshot>;
	replayFrom(
		cursor: number,
	): MaybePromise<HeadlessRuntimeStreamEnvelope[] | null>;
	emitAgentEvent(event: AgentEvent): void;
	requestApproval(
		request: ActionApprovalRequest,
	): Promise<ActionApprovalDecision>;
	drain?(request: HostedDrainRequest): Promise<HostedDrainResult>;
	restoreFromDrain?(drain: HostedDrainResult): Promise<HeadlessRuntimeSnapshot>;
	close(): Promise<void>;
}

class TypeScriptInProcessConformanceAdapter
	implements RuntimeConformanceAdapter
{
	readonly label = "typescript-in-process";
	readonly scopeKey = "runtime-conformance";
	workspaceRoot = "";
	outsideRoot = "";
	private sessionDir = "";
	private sessionId = "";
	private fakeAgent = new FakeAgent();
	private runtimeService = new HeadlessRuntimeService();
	private host = new HeadlessInProcessHost(this.runtimeService);

	async start(options: StartOptions = {}): Promise<HeadlessRuntimeSnapshot> {
		this.sessionDir = await mkdtemp(
			join(tmpdir(), "maestro-conformance-sessions-"),
		);
		this.workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-conformance-workspace-"),
		);
		this.outsideRoot = await mkdtemp(
			join(tmpdir(), "maestro-conformance-outside-"),
		);
		await writeFile(
			join(this.workspaceRoot, "notes.md"),
			"alpha\nbeta\ngamma\n",
		);
		await writeFile(join(this.outsideRoot, "secret.txt"), "not in workspace\n");

		const sessionManager = new SessionManager(false, undefined, {
			sessionDir: this.sessionDir,
		});
		const snapshot = await this.host.ensureSession({
			scope_key: this.scopeKey,
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: options.approvalMode ?? "prompt",
			context: {
				createAgent: vi.fn().mockResolvedValue(this.fakeAgent),
			},
			sessionManager,
			clientProtocolVersion: HEADLESS_PROTOCOL_VERSION,
			clientInfo: {
				name: "maestro-conformance",
				version: "0.1.0",
			},
			capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
			role: "controller",
		});
		this.sessionId = snapshot.session_id;
		return snapshot;
	}

	subscribe(options: {
		role?: "viewer" | "controller";
		takeControl?: boolean;
	}): HeadlessRuntimeSubscriptionSnapshot {
		return this.host.subscribe({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			takeControl: options.takeControl,
		});
	}

	attachStream(options: {
		role?: "viewer" | "controller";
		cursor?: number | null;
	}): HeadlessAttachedSubscription {
		return this.host.attachStream({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			cursor: options.cursor,
		});
	}

	async send(
		message: HeadlessToAgentMessage,
		options: SendOptions = {},
	): Promise<HeadlessRuntimeSnapshot> {
		return await this.host.send({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
			message,
		});
	}

	heartbeat(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): HeadlessRuntimeHeartbeatSnapshot {
		return this.host.heartbeat({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
		});
	}

	async disconnect(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeConnectionClosedSnapshot> {
		return await this.host.disconnect({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
		});
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		return this.host.replayFrom(this.scopeKey, this.requireSessionId(), cursor);
	}

	emitAgentEvent(event: AgentEvent): void {
		this.fakeAgent.emit(event);
	}

	async requestApproval(
		request: ActionApprovalRequest,
	): Promise<ActionApprovalDecision> {
		const runtime = this.runtimeService.getRuntime(
			this.scopeKey,
			this.requireSessionId(),
		);
		if (!runtime) {
			throw new Error("Headless runtime not found");
		}
		const approvalService = (
			runtime as unknown as {
				approvalService: {
					requestApproval(
						request: ActionApprovalRequest,
					): Promise<ActionApprovalDecision>;
				};
			}
		).approvalService;
		return await approvalService.requestApproval(request);
	}

	async close(): Promise<void> {
		if (this.sessionId) {
			await this.runtimeService
				.getRuntime(this.scopeKey, this.sessionId)
				?.dispose();
		}
		await Promise.all(
			[this.sessionDir, this.workspaceRoot, this.outsideRoot]
				.filter(Boolean)
				.map((path) => rm(path, { recursive: true, force: true })),
		);
	}

	private requireSessionId(): string {
		if (!this.sessionId) {
			throw new Error("Conformance adapter has not started a session");
		}
		return this.sessionId;
	}
}

class SseHeadlessAttachedSubscription implements HeadlessAttachedSubscription {
	readonly id: string;
	private readonly abortController = new AbortController();
	private readonly listeners = new Set<() => void>();
	private readonly queue: HeadlessRuntimeStreamEnvelope[] = [];
	private error: Error | null = null;

	private constructor(id: string) {
		this.id = id;
	}

	static async connect(options: {
		id: string;
		url: string;
		initialSnapshot?: HeadlessRuntimeSnapshot;
	}): Promise<SseHeadlessAttachedSubscription> {
		const subscription = new SseHeadlessAttachedSubscription(options.id);
		if (options.initialSnapshot) {
			subscription.enqueue({
				type: "snapshot",
				snapshot: options.initialSnapshot,
			});
		}
		await subscription.start(options.url);
		return subscription;
	}

	next(): HeadlessRuntimeStreamEnvelope | null {
		if (this.error) {
			throw this.error;
		}
		return this.queue.shift() ?? null;
	}

	onAvailable(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	enqueue(envelope: HeadlessRuntimeStreamEnvelope): void {
		this.queue.push(envelope);
		for (const listener of this.listeners) {
			listener();
		}
	}

	close(): void {
		this.abortController.abort();
	}

	private async start(url: string): Promise<void> {
		const response = await fetch(url, {
			headers: { accept: "text/event-stream" },
			signal: this.abortController.signal,
		});
		if (!response.ok) {
			throw await responseError(response);
		}
		if (!response.body) {
			throw new Error("Rust hosted runner SSE response did not include a body");
		}
		void this.pump(response.body.getReader());
	}

	private async pump(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) {
					return;
				}
				buffer += decoder.decode(chunk.value, { stream: true });
				const frames = buffer.split(/\r?\n\r?\n/);
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					this.enqueueFrame(frame);
				}
			}
		} catch (error) {
			if (!this.abortController.signal.aborted) {
				this.error = error instanceof Error ? error : new Error(String(error));
				for (const listener of this.listeners) {
					listener();
				}
			}
		}
	}

	private enqueueFrame(frame: string): void {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trimStart())
			.join("\n");
		if (!data) {
			return;
		}
		const envelope = JSON.parse(data) as HeadlessRuntimeStreamEnvelope;
		this.enqueue(envelope);
	}
}

class RustHostedHttpConformanceAdapter implements RuntimeConformanceAdapter {
	readonly label = "rust-hosted-http";
	workspaceRoot = "";
	outsideRoot = "";
	private sessionId = "sess_conformance";
	private sessionDir = "";
	private baseUrl = "";
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly subscriptions = new Map<
		string,
		HeadlessRuntimeSubscriptionSnapshot
	>();
	private readonly streams = new Set<SseHeadlessAttachedSubscription>();
	private latestControllerSubscriptionId: string | null = null;
	private pendingApprovalRequest: ActionApprovalRequest | null = null;

	async start(): Promise<HeadlessRuntimeSnapshot> {
		this.sessionDir = await mkdtemp(
			join(tmpdir(), "maestro-rust-conformance-sessions-"),
		);
		this.workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-rust-conformance-workspace-"),
		);
		this.outsideRoot = await mkdtemp(
			join(tmpdir(), "maestro-rust-conformance-outside-"),
		);
		await writeFile(
			join(this.workspaceRoot, "notes.md"),
			"alpha\nbeta\ngamma\n",
		);
		await writeFile(join(this.outsideRoot, "secret.txt"), "not in workspace\n");
		await this.startFixture();
		return await this.fetchState();
	}

	async subscribe(options: {
		role?: "viewer" | "controller";
		takeControl?: boolean;
	}): Promise<HeadlessRuntimeSubscriptionSnapshot> {
		const subscription =
			await this.postJson<HeadlessRuntimeSubscriptionSnapshot>(
				`/api/headless/sessions/${this.sessionId}/subscribe`,
				{
					protocolVersion: HEADLESS_PROTOCOL_VERSION,
					clientInfo: {
						name: "maestro-rust-conformance",
						version: "0.1.0",
					},
					capabilities: httpCapabilities(DEFAULT_CAPABILITIES),
					role: options.role ?? "controller",
					takeControl: options.takeControl ?? false,
				},
			);
		this.subscriptions.set(subscription.subscription_id, subscription);
		if (subscription.role === "controller") {
			this.latestControllerSubscriptionId = subscription.subscription_id;
		}
		return subscription;
	}

	async attachStream(options: {
		role?: "viewer" | "controller";
		cursor?: number | null;
	}): Promise<HeadlessAttachedSubscription> {
		const includeInitialSnapshot =
			options.cursor === undefined || options.cursor === null;
		const snapshot = includeInitialSnapshot
			? await this.fetchState()
			: undefined;
		const query = includeInitialSnapshot
			? ""
			: `?cursor=${encodeURIComponent(String(options.cursor))}`;
		const stream = await SseHeadlessAttachedSubscription.connect({
			id: `rust-${this.streams.size + 1}`,
			url: `${this.baseUrl}/api/headless/sessions/${this.sessionId}/events${query}`,
			initialSnapshot: snapshot,
		});
		this.streams.add(stream);
		return stream;
	}

	async send(
		message: HeadlessToAgentMessage,
		options: SendOptions = {},
	): Promise<HeadlessRuntimeSnapshot> {
		const headers: Record<string, string> = {};
		const connectionId =
			options.connectionId ??
			this.subscriptionConnectionId(options.subscriptionId ?? null);
		if (connectionId) {
			headers["x-maestro-headless-connection-id"] = connectionId;
		}
		if (options.subscriptionId) {
			headers["x-maestro-headless-subscriber-id"] = options.subscriptionId;
		}
		const response = await this.postJson<{
			snapshot?: HeadlessRuntimeSnapshot;
		}>(`/api/headless/sessions/${this.sessionId}/messages`, message, headers);
		return response.snapshot ?? (await this.fetchState());
	}

	async heartbeat(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeHeartbeatSnapshot> {
		return await this.postJson<HeadlessRuntimeHeartbeatSnapshot>(
			`/api/headless/sessions/${this.sessionId}/heartbeat`,
			{
				connectionId: options.connectionId,
				subscriptionId: options.subscriptionId,
			},
		);
	}

	async disconnect(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeConnectionClosedSnapshot> {
		return await this.postJson<HeadlessRuntimeConnectionClosedSnapshot>(
			`/api/headless/sessions/${this.sessionId}/disconnect`,
			{
				connectionId: options.connectionId,
				subscriptionId: options.subscriptionId,
			},
		);
	}

	async replayFrom(
		cursor: number,
	): Promise<HeadlessRuntimeStreamEnvelope[] | null> {
		const stream = await SseHeadlessAttachedSubscription.connect({
			id: `rust-replay-${Date.now()}`,
			url: `${this.baseUrl}/api/headless/sessions/${this.sessionId}/events?cursor=${encodeURIComponent(
				String(cursor),
			)}`,
		});
		await sleep(50);
		const replay: HeadlessRuntimeStreamEnvelope[] = [];
		for (;;) {
			const next = stream.next();
			if (!next) {
				break;
			}
			replay.push(next);
		}
		stream.close();
		return replay;
	}

	emitAgentEvent(event: AgentEvent): void {
		if (event.type === "action_approval_required") {
			this.pendingApprovalRequest = event.request;
		}
	}

	async requestApproval(
		request: ActionApprovalRequest,
	): Promise<ActionApprovalDecision> {
		const approvalRequest = this.pendingApprovalRequest ?? request;
		const subscriptionId = this.latestControllerSubscriptionId;
		if (!subscriptionId) {
			throw new Error("Rust conformance approval needs a controller");
		}
		await this.send(
			{
				type: "prompt",
				content: `__maestro_conformance_approval__:${JSON.stringify({
					request_id: approvalRequest.id,
					tool: approvalRequest.toolName,
					args: approvalRequest.args,
					reason: approvalRequest.reason,
				})}`,
			},
			{ role: "controller", subscriptionId },
		);

		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline) {
			const replay = (await this.replayFrom(0)) ?? [];
			const resolved = replay.find((entry) => {
				return (
					entry.type === "message" &&
					entry.message.type === "server_request_resolved" &&
					entry.message.request_id === approvalRequest.id
				);
			});
			if (resolved?.type === "message") {
				const message = resolved.message;
				if (message.type === "server_request_resolved") {
					return {
						approved: message.resolution === "approved",
						reason: message.reason,
						resolvedBy: message.resolved_by,
					};
				}
			}
			await sleep(25);
		}
		throw new Error("Timed out waiting for Rust conformance approval");
	}

	async drain(request: HostedDrainRequest): Promise<HostedDrainResult> {
		const response = await this.postJson<HostedDrainResult>(
			"/.well-known/evalops/remote-runner/drain",
			request,
		);
		if (!response.manifest) {
			response.manifest = JSON.parse(
				await readFile(response.manifest_path, "utf8"),
			) as Record<string, unknown>;
		}
		return response;
	}

	async restoreFromDrain(
		drain: HostedDrainResult,
	): Promise<HeadlessRuntimeSnapshot> {
		for (const stream of this.streams) {
			stream.close();
		}
		this.streams.clear();
		this.subscriptions.clear();
		this.latestControllerSubscriptionId = null;
		this.pendingApprovalRequest = null;
		if (this.child) {
			await stopFixture(this.child);
			this.child = null;
		}
		const manifest = drain.manifest as
			| { maestro_session_id?: string }
			| undefined;
		await this.startFixture({
			restoreManifestPath: drain.manifest_path,
			restoredSessionId: manifest?.maestro_session_id ?? this.sessionId,
			runnerSessionId: "mrs_conformance_restored",
			maestroSessionId: null,
		});
		return await this.fetchState();
	}

	async close(): Promise<void> {
		for (const stream of this.streams) {
			stream.close();
		}
		this.streams.clear();
		const child = this.child;
		this.child = null;
		if (child) {
			await stopFixture(child);
		}
		await Promise.all(
			[this.sessionDir, this.workspaceRoot, this.outsideRoot]
				.filter(Boolean)
				.map((path) => rm(path, { recursive: true, force: true })),
		);
	}

	private async startFixture(
		options: {
			restoreManifestPath?: string;
			restoredSessionId?: string;
			runnerSessionId?: string;
			maestroSessionId?: string | null;
		} = {},
	): Promise<void> {
		const env = { ...process.env };
		delete env.PORT;
		env.MAESTRO_RUNNER_SESSION_ID =
			options.runnerSessionId ?? "mrs_conformance";
		if (options.maestroSessionId === null) {
			delete env.MAESTRO_SESSION_ID;
		} else {
			env.MAESTRO_SESSION_ID = options.maestroSessionId ?? this.sessionId;
		}
		env.MAESTRO_WORKSPACE_ROOT = this.workspaceRoot;
		env.MAESTRO_HOSTED_RUNNER_LISTEN = `127.0.0.1:${await findAvailableTcpPort()}`;
		env.MAESTRO_REMOTE_RUNNER_WORKSPACE_ID = "ws_conformance";
		env.MAESTRO_AGENT_RUN_ID = "run_conformance";
		if (options.restoreManifestPath) {
			env.MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST = options.restoreManifestPath;
		} else {
			delete env.MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST;
		}
		const child = spawn(
			"cargo",
			["run", "--quiet", "--bin", "hosted_runner_conformance_fixture"],
			{
				cwd: join(process.cwd(), "packages/tui-rs"),
				env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.child = child;
		const startup = await readFixtureStartup(child);
		this.baseUrl = startup.baseUrl;
		this.sessionId = options.restoredSessionId ?? startup.sessionId;
	}

	private async fetchState(): Promise<HeadlessRuntimeSnapshot> {
		return await this.getJson<HeadlessRuntimeSnapshot>(
			`/api/headless/sessions/${this.sessionId}/state`,
		);
	}

	private subscriptionConnectionId(
		subscriptionId: string | null,
	): string | null {
		if (!subscriptionId) {
			return null;
		}
		return this.subscriptions.get(subscriptionId)?.connection_id ?? null;
	}

	private async getJson<T>(path: string): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`);
		return await readJsonResponse<T>(response);
	}

	private async postJson<T>(
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		});
		return await readJsonResponse<T>(response);
	}
}

async function readJsonResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		throw await responseError(response);
	}
	const text = await response.text();
	return (text ? JSON.parse(text) : {}) as T;
}

async function responseError(response: Response): Promise<Error> {
	const text = await response.text();
	try {
		const body = JSON.parse(text) as { error?: string; message?: string };
		return new Error(body.error ?? body.message ?? text);
	} catch {
		return new Error(text || `HTTP ${response.status}`);
	}
}

function httpCapabilities(capabilities: HeadlessClientCapabilities) {
	return {
		serverRequests: capabilities.server_requests,
		utilityOperations: capabilities.utility_operations,
		rawAgentEvents: capabilities.raw_agent_events,
	};
}

async function findAvailableTcpPort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not reserve TCP port")));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function readFixtureStartup(
	child: ChildProcessWithoutNullStreams,
): Promise<{ baseUrl: string; sessionId: string }> {
	let stdout = "";
	let stderr = "";
	return await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`Timed out waiting for Rust hosted runner fixture startup${stderr ? `:\n${stderr}` : ""}`,
				),
			);
		}, 30_000);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			const newline = stdout.indexOf("\n");
			if (newline === -1) {
				return;
			}
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(stdout.slice(0, newline)));
			} catch (error) {
				reject(
					new Error(
						`Failed to parse Rust hosted runner fixture startup line: ${String(
							error,
						)}\n${stdout}${stderr ? `\n${stderr}` : ""}`,
					),
				);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`Rust hosted runner fixture exited before startup with code ${code}${stderr ? `:\n${stderr}` : ""}`,
				),
			);
		});
	});
}

async function stopFixture(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 1_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
		child.stdin.end();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readNextEnvelope(
	stream: HeadlessAttachedSubscription,
): Promise<HeadlessRuntimeStreamEnvelope> {
	const immediate = stream.next();
	if (immediate) {
		return immediate;
	}
	await new Promise<void>((resolve) => {
		const unsubscribe = stream.onAvailable(() => {
			unsubscribe();
			resolve();
		});
	});
	const next = stream.next();
	if (!next) {
		throw new Error("Expected next headless conformance envelope");
	}
	return next;
}

async function readUntil(
	stream: HeadlessAttachedSubscription,
	predicate: (envelope: HeadlessRuntimeStreamEnvelope) => boolean,
): Promise<HeadlessRuntimeStreamEnvelope[]> {
	const envelopes: HeadlessRuntimeStreamEnvelope[] = [];
	for (let index = 0; index < 20; index += 1) {
		const next = await readNextEnvelope(stream);
		envelopes.push(next);
		if (predicate(next)) {
			return envelopes;
		}
	}
	throw new Error("Timed out waiting for headless conformance envelope");
}

function expectRuntimeSnapshot(value: HeadlessRuntimeSnapshot): void {
	const errors = [...Value.Errors(HeadlessRuntimeSnapshotSchema, value)].map(
		(error) => `${error.path}: ${error.message}`,
	);
	expect(
		Value.Check(HeadlessRuntimeSnapshotSchema, value),
		errors.join("\n"),
	).toBe(true);
}

function expectStreamEnvelope(value: HeadlessRuntimeStreamEnvelope): void {
	const errors = [
		...Value.Errors(HeadlessRuntimeStreamEnvelopeSchema, value),
	].map((error) => `${error.path}: ${error.message}`);
	expect(
		Value.Check(HeadlessRuntimeStreamEnvelopeSchema, value),
		[...errors, JSON.stringify(value)].filter(Boolean).join("\n"),
	).toBe(true);
}

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, name);
		return;
	}
	process.env[name] = value;
}

function defineHeadlessRuntimeConformanceSuite(
	name: string,
	createAdapter: () => RuntimeConformanceAdapter,
	options: { skip?: boolean } = {},
) {
	const describeRuntime = options.skip ? describe.skip : describe;
	describeRuntime(`${name} headless runtime conformance`, () => {
		let adapter: RuntimeConformanceAdapter | null = null;
		const originalHostedMode = process.env.MAESTRO_HOSTED_RUNNER_MODE;
		const originalWorkspaceRoot = process.env.MAESTRO_WORKSPACE_ROOT;

		async function start(
			options?: StartOptions,
		): Promise<RuntimeConformanceAdapter> {
			adapter = createAdapter();
			const snapshot = await adapter.start(options);
			expectRuntimeSnapshot(snapshot);
			return adapter;
		}

		afterEach(async () => {
			restoreEnvValue("MAESTRO_HOSTED_RUNNER_MODE", originalHostedMode);
			restoreEnvValue("MAESTRO_WORKSPACE_ROOT", originalWorkspaceRoot);
			for (const request of serverRequestManager.listPending()) {
				serverRequestManager.cancel(request.id, "Conformance cleanup");
			}
			await adapter?.close();
			adapter = null;
			vi.restoreAllMocks();
		});

		it("creates controller and viewer subscriptions with schema-valid heartbeat snapshots", async () => {
			const runtime = await start();
			const controller = await runtime.subscribe({ role: "controller" });
			expect(
				Value.Check(HeadlessRuntimeSubscriptionSnapshotSchema, controller),
			).toBe(true);
			expect(controller.role).toBe("controller");
			expect(controller.controller_lease_granted).toBe(true);

			const viewer = await runtime.subscribe({ role: "viewer" });
			expect(
				Value.Check(HeadlessRuntimeSubscriptionSnapshotSchema, viewer),
			).toBe(true);
			expect(viewer.role).toBe("viewer");
			expect(viewer.controller_lease_granted).toBe(false);
			expect(viewer.controller_connection_id).toBe(controller.connection_id);

			const controllerHeartbeat = await runtime.heartbeat({
				subscriptionId: controller.subscription_id,
			});
			expect(
				Value.Check(
					HeadlessRuntimeHeartbeatSnapshotSchema,
					controllerHeartbeat,
				),
			).toBe(true);
			expect(controllerHeartbeat.controller_lease_granted).toBe(true);

			const viewerHeartbeat = await runtime.heartbeat({
				subscriptionId: viewer.subscription_id,
			});
			expect(
				Value.Check(HeadlessRuntimeHeartbeatSnapshotSchema, viewerHeartbeat),
			).toBe(true);
			expect(viewerHeartbeat.controller_lease_granted).toBe(false);
		});

		it("enforces viewer read-only access and explicit controller takeover", async () => {
			const runtime = await start();
			const controller = await runtime.subscribe({ role: "controller" });
			const viewer = await runtime.subscribe({ role: "viewer" });

			await expect(
				runtime.send(
					{ type: "prompt", content: "viewer should not mutate" },
					{ role: "viewer", subscriptionId: viewer.subscription_id },
				),
			).rejects.toThrow("Viewer headless connections cannot send messages");

			await expect(
				Promise.resolve().then(() => runtime.subscribe({ role: "controller" })),
			).rejects.toThrow(
				"Controller lease is already held by another connection",
			);

			const takeover = await runtime.subscribe({
				role: "controller",
				takeControl: true,
			});
			expect(takeover.controller_lease_granted).toBe(true);
			expect(takeover.controller_connection_id).toBe(takeover.connection_id);
			expect(
				(
					await runtime.heartbeat({
						subscriptionId: controller.subscription_id,
					})
				).controller_lease_granted,
			).toBe(false);

			await expect(
				runtime.send(
					{ type: "prompt", content: "old controller should not mutate" },
					{ role: "controller", subscriptionId: controller.subscription_id },
				),
			).rejects.toThrow(
				"Controller lease is currently held by another connection",
			);
		});

		it("replays cursor-ordered events and emits reset snapshots for replay gaps", async () => {
			const runtime = await start();
			const controller = await runtime.subscribe({ role: "controller" });
			const stream = await runtime.attachStream({
				role: "viewer",
				cursor: null,
			});
			const initial = await readNextEnvelope(stream);
			expectStreamEnvelope(initial);
			expect(initial.type).toBe("snapshot");

			await runtime.send(
				{ type: "init", system_prompt: "Conformance mode" },
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			await runtime.send(
				{ type: "prompt", content: "cursor replay" },
				{ role: "controller", subscriptionId: controller.subscription_id },
			);

			await vi.waitFor(async () => {
				expect(
					(await runtime.replayFrom(0))?.some((entry) => {
						return (
							entry.type === "message" &&
							entry.message.type === "status" &&
							entry.message.message === "Prompt: cursor replay"
						);
					}),
				).toBe(true);
			});

			const replay = (await runtime.replayFrom(0)) ?? [];
			expect(replay.length).toBeGreaterThan(0);
			for (const envelope of replay) {
				expectStreamEnvelope(envelope);
			}
			const replayTypes = replay.map((entry) =>
				entry.type === "message" ? entry.message.type : entry.type,
			);
			expect(replayTypes).toEqual(expect.arrayContaining(["status"]));
			if (runtime.label === "typescript-in-process") {
				expect(replayTypes).toEqual(
					expect.arrayContaining(["ready", "session_info", "status", "status"]),
				);
			}

			const resetStream = await runtime.attachStream({
				role: "viewer",
				cursor: -999,
			});
			const reset = await readNextEnvelope(resetStream);
			expectStreamEnvelope(reset);
			expect(reset).toMatchObject({
				type: "reset",
				reason: "replay_gap",
			});
			resetStream.close();
			stream.close();
		});

		it("emits approval server requests and resolves them through the protocol response path", async () => {
			const runtime = await start();
			const controller = await runtime.subscribe({ role: "controller" });
			const request: ActionApprovalRequest = {
				id: "call_conformance_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Conformance approval fixture",
			};

			runtime.emitAgentEvent({
				type: "action_approval_required",
				request,
			});
			const approval = runtime.requestApproval(request);

			await vi.waitFor(async () => {
				expect(
					(await runtime.replayFrom(0))?.some((entry) => {
						return (
							entry.type === "message" &&
							entry.message.type === "server_request" &&
							entry.message.request_id === request.id
						);
					}),
				).toBe(true);
			});

			await runtime.send(
				{
					type: "server_request_response",
					request_id: request.id,
					request_type: "approval",
					approved: false,
					result: {
						success: false,
						output: "",
						error: "Denied in conformance",
					},
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);

			await expect(approval).resolves.toEqual({
				approved: false,
				reason: "Denied in conformance",
				resolvedBy: "user",
			});
			expect(
				(await runtime.replayFrom(0))?.some((entry) => {
					return (
						entry.type === "message" &&
						entry.message.type === "server_request_resolved" &&
						entry.message.request_id === request.id &&
						entry.message.resolution === "denied"
					);
				}),
			).toBe(true);
		});

		it("scopes utility file reads to the hosted workspace root", async () => {
			const runtime = await start();
			process.env.MAESTRO_HOSTED_RUNNER_MODE = "1";
			process.env.MAESTRO_WORKSPACE_ROOT = runtime.workspaceRoot;

			const controller = await runtime.subscribe({ role: "controller" });
			const stream = await runtime.attachStream({
				role: "viewer",
				cursor: null,
			});
			expect((await readNextEnvelope(stream)).type).toBe("snapshot");

			await runtime.send(
				{
					type: "utility_file_read",
					read_id: "read_notes",
					path: "notes.md",
					cwd: runtime.workspaceRoot,
					limit: 2,
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			const envelopes = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_file_read_result" &&
					envelope.message.read_id === "read_notes",
			);
			for (const envelope of envelopes) {
				expectStreamEnvelope(envelope);
			}
			expect(envelopes.at(-1)).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_read_result",
					read_id: "read_notes",
					relative_path: "notes.md",
					content: "alpha\nbeta",
					truncated: true,
				},
			});

			await expect(
				runtime.send(
					{
						type: "utility_file_read",
						read_id: "read_escape",
						path: join(runtime.outsideRoot, "secret.txt"),
						cwd: runtime.workspaceRoot,
					},
					{ role: "controller", subscriptionId: controller.subscription_id },
				),
			).rejects.toThrow(/outside|Access denied|Path is outside/);
			stream.close();
		});

		it("streams utility command, file search, and file watch lifecycle events", async () => {
			const runtime = await start();
			process.env.MAESTRO_HOSTED_RUNNER_MODE = "1";
			process.env.MAESTRO_WORKSPACE_ROOT = runtime.workspaceRoot;

			const controller = await runtime.subscribe({ role: "controller" });
			const stream = await runtime.attachStream({
				role: "viewer",
				cursor: null,
			});
			expect((await readNextEnvelope(stream)).type).toBe("snapshot");

			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
				"process.stdout.write('utility ok'); setTimeout(() => process.exit(0), 50)",
			)}`;
			const commandSnapshot = await runtime.send(
				{
					type: "utility_command_start",
					command_id: "cmd_conformance",
					command,
					cwd: runtime.workspaceRoot,
					shell_mode: "direct",
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			expect(commandSnapshot.state.active_utility_commands).toContainEqual(
				expect.objectContaining({
					command_id: "cmd_conformance",
					owner_connection_id: controller.connection_id,
				}),
			);

			const commandEnvelopes = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_command_exited" &&
					envelope.message.command_id === "cmd_conformance",
			);
			for (const envelope of commandEnvelopes) {
				expectStreamEnvelope(envelope);
			}
			expect(commandEnvelopes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({
							type: "utility_command_started",
							command_id: "cmd_conformance",
							owner_connection_id: controller.connection_id,
						}),
					}),
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({
							type: "utility_command_output",
							command_id: "cmd_conformance",
							stream: "stdout",
							content: "utility ok",
						}),
					}),
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({
							type: "utility_command_exited",
							command_id: "cmd_conformance",
							success: true,
							exit_code: 0,
						}),
					}),
				]),
			);

			await runtime.send(
				{
					type: "utility_file_search",
					search_id: "search_notes",
					query: "notes",
					cwd: runtime.workspaceRoot,
					limit: 5,
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			const searchEnvelopes = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_file_search_results" &&
					envelope.message.search_id === "search_notes",
			);
			expect(searchEnvelopes.at(-1)).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_search_results",
					search_id: "search_notes",
					query: "notes",
				},
			});
			const searchResult = searchEnvelopes.at(-1);
			expect(
				searchResult?.type === "message" &&
					searchResult.message.type === "utility_file_search_results" &&
					searchResult.message.results.some((result) =>
						result.path.endsWith("notes.md"),
					),
			).toBe(true);

			const watchSnapshot = await runtime.send(
				{
					type: "utility_file_watch_start",
					watch_id: "watch_conformance",
					root_dir: runtime.workspaceRoot,
					debounce_ms: 0,
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			expect(watchSnapshot.state.active_file_watches).toContainEqual(
				expect.objectContaining({
					watch_id: "watch_conformance",
					owner_connection_id: controller.connection_id,
				}),
			);
			const watchStarted = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_file_watch_started" &&
					envelope.message.watch_id === "watch_conformance",
			);
			expect(watchStarted.at(-1)).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_watch_started",
					watch_id: "watch_conformance",
					owner_connection_id: controller.connection_id,
				},
			});

			const watchStoppedSnapshot = await runtime.send(
				{
					type: "utility_file_watch_stop",
					watch_id: "watch_conformance",
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			expect(watchStoppedSnapshot.state.active_file_watches).toEqual([]);
			const watchStopped = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_file_watch_stopped" &&
					envelope.message.watch_id === "watch_conformance",
			);
			expect(watchStopped.at(-1)).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_watch_stopped",
					watch_id: "watch_conformance",
					reason: "Stopped by controller",
				},
			});
			stream.close();
		});

		it("drains hosted runners into a manifest and rejects new mutations", async () => {
			const runtime = await start();
			if (!runtime.drain) {
				expect(runtime.label).toBe("typescript-in-process");
				return;
			}

			const controller = await runtime.subscribe({ role: "controller" });
			const stream = await runtime.attachStream({
				role: "viewer",
				cursor: null,
			});
			expect((await readNextEnvelope(stream)).type).toBe("snapshot");

			await runtime.send(
				{ type: "prompt", content: "before hosted drain" },
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			await vi.waitFor(async () => {
				expect(
					(await runtime.replayFrom(0))?.some((entry) => {
						return (
							entry.type === "message" &&
							entry.message.type === "status" &&
							entry.message.message === "Prompt: before hosted drain"
						);
					}),
				).toBe(true);
			});

			const drain = await runtime.drain({
				reason: "conformance_stop",
				requested_by: "runtime-conformance",
				export_paths: ["notes.md"],
			});
			expect(drain).toMatchObject({
				protocol_version: "evalops.remote-runner.drain.v1",
				status: "drained",
				runner_session_id: "mrs_conformance",
				requested_by: "runtime-conformance",
				reason: "conformance_stop",
				manifest_path: expect.stringContaining("mrs_conformance"),
			});
			expect(drain.manifest).toBeDefined();
			const manifest = drain.manifest as Record<string, unknown>;
			expect(manifest).toMatchObject({
				protocol_version: "evalops.remote-runner.snapshot-manifest.v1",
				runner_session_id: "mrs_conformance",
				workspace_id: "ws_conformance",
				agent_run_id: "run_conformance",
				maestro_session_id: "sess_conformance",
				reason: "conformance_stop",
				requested_by: "runtime-conformance",
			});
			const runtimeManifest = manifest.runtime as {
				cursor?: number;
				flush_status?: string;
				protocol_version?: string;
				session_id?: string;
			};
			expect(runtimeManifest).toMatchObject({
				flush_status: "completed",
				protocol_version: HEADLESS_PROTOCOL_VERSION,
				session_id: "sess_conformance",
			});
			expect(runtimeManifest.cursor).toBeGreaterThan(0);
			const snapshot = manifest.snapshot as HeadlessRuntimeSnapshot;
			expectRuntimeSnapshot(snapshot);
			expect(snapshot.cursor).toBeGreaterThan(0);
			const workspaceExport = manifest.workspace_export as {
				mode?: string;
				paths?: Array<Record<string, unknown>>;
			};
			expect(workspaceExport).toMatchObject({
				mode: "local_path_contract",
			});
			expect(workspaceExport.paths).toContainEqual(
				expect.objectContaining({
					input: "notes.md",
					relative_path: "notes.md",
					type: "file",
				}),
			);

			const drainedSnapshot = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "snapshot" &&
					envelope.snapshot.state.last_status === "Drained",
			);
			for (const envelope of drainedSnapshot) {
				expectStreamEnvelope(envelope);
			}
			expect(drainedSnapshot.at(-1)).toMatchObject({
				type: "snapshot",
				snapshot: {
					state: {
						is_ready: false,
						last_status: "Drained",
					},
				},
			});

			await expect(
				runtime.send(
					{ type: "prompt", content: "after hosted drain" },
					{ role: "controller", subscriptionId: controller.subscription_id },
				),
			).rejects.toThrow(/runtime_not_ready|draining|not ready/);
			await expect(runtime.subscribe({ role: "viewer" })).rejects.toThrow(
				/runtime_not_ready|draining|not ready|not accepting new attachments/,
			);
			stream.close();

			if (!runtime.restoreFromDrain) {
				return;
			}
			const restored = await runtime.restoreFromDrain(drain);
			expectRuntimeSnapshot(restored);
			expect(restored.session_id).toBe("sess_conformance");
			expect(restored.cursor).toBe(runtimeManifest.cursor);
			expect(restored.state.last_status).toBe("Restored from snapshot");
			expect(restored.state.is_ready).toBe(true);

			const restoredStream = await runtime.attachStream({
				role: "viewer",
				cursor: 0,
			});
			const restoredReset = await readNextEnvelope(restoredStream);
			expectStreamEnvelope(restoredReset);
			expect(restoredReset).toMatchObject({
				type: "reset",
				reason: "restored_from_snapshot",
				snapshot: {
					session_id: "sess_conformance",
					cursor: runtimeManifest.cursor,
					state: {
						last_status: "Restored from snapshot",
					},
				},
			});
			restoredStream.close();

			const restoredController = await runtime.subscribe({
				role: "controller",
			});
			expect(restoredController.controller_lease_granted).toBe(true);
			const afterRestore = await runtime.send(
				{ type: "prompt", content: "after hosted restore" },
				{
					role: "controller",
					subscriptionId: restoredController.subscription_id,
				},
			);
			expect(afterRestore.session_id).toBe("sess_conformance");
			expect(afterRestore.cursor).toBeGreaterThan(runtimeManifest.cursor ?? 0);
			expect(afterRestore.state.last_status).toBe(
				"Prompt: after hosted restore",
			);
		});

		it("disconnects subscriptions and clears controller leases without destroying the runtime", async () => {
			const runtime = await start();
			const controller = await runtime.subscribe({ role: "controller" });
			const viewer = await runtime.subscribe({ role: "viewer" });

			const viewerDisconnect = await runtime.disconnect({
				connectionId: viewer.connection_id,
			});
			expect(viewerDisconnect).toEqual({
				success: true,
				connection_id: viewer.connection_id,
				controller_connection_id: controller.connection_id,
				disconnected_subscription_ids: [viewer.subscription_id],
			});

			const controllerDisconnect = await runtime.disconnect({
				connectionId: controller.connection_id,
			});
			expect(controllerDisconnect).toEqual({
				success: true,
				connection_id: controller.connection_id,
				controller_connection_id: null,
				disconnected_subscription_ids: [controller.subscription_id],
			});
			const replay = (await runtime.replayFrom(0)) ?? [];
			expect(replay.length).toBeGreaterThan(0);
			expect(
				replay.every((envelope) =>
					Value.Check(HeadlessRuntimeStreamEnvelopeSchema, envelope),
				),
			).toBe(true);
		});
	});
}

defineHeadlessRuntimeConformanceSuite(
	"TypeScript in-process host",
	() => new TypeScriptInProcessConformanceAdapter(),
);

defineHeadlessRuntimeConformanceSuite(
	"Rust hosted HTTP runner",
	() => new RustHostedHttpConformanceAdapter(),
	{ skip: process.env.MAESTRO_RUST_HOSTED_CONFORMANCE !== "1" },
);

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	HeadlessRuntimeHeartbeatSnapshotSchema,
	HeadlessRuntimeSnapshotSchema,
	HeadlessRuntimeStreamEnvelopeSchema,
	HeadlessRuntimeSubscriptionSnapshotSchema,
} from "@evalops/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AppMessage,
	Attachment,
	ThinkingLevel,
} from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	createHeadlessRuntimeState,
} from "../../src/cli/headless-protocol.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { clientToolService } from "../../src/server/client-tools-service.js";
import {
	handleHeadlessConnectionCreate,
	handleHeadlessSessionCreate,
	handleHeadlessSessionEvents,
	handleHeadlessSessionMessage,
	handleHeadlessSessionSubscribe,
	handleHeadlessSessionUnsubscribe,
} from "../../src/server/handlers/headless-sessions.js";
import {
	HeadlessRuntimeService,
	type HeadlessRuntimeSnapshot,
	type HeadlessRuntimeStreamEnvelope,
} from "../../src/server/headless-runtime-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";
import { ApiError } from "../../src/server/server-utils.js";
import { createSessionManagerForRequest } from "../../src/server/session-scope.js";
import { ServerRequestToolRetryService } from "../../src/server/tool-retry-service.js";
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

class MockResponse extends EventEmitter {
	body = "";
	headers: Record<string, string | number> = {};
	statusCode = 200;
	headersSent = false;
	writableEnded = false;
	writable = true;
	destroyed = false;
	req?: IncomingMessage;

	writeHead(statusCode: number, headers: Record<string, string | number>) {
		this.statusCode = statusCode;
		this.headers = { ...this.headers, ...headers };
		this.headersSent = true;
		return this;
	}

	write(chunk: string | Buffer) {
		this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
		return true;
	}

	end(chunk?: string | Buffer) {
		if (chunk) {
			this.write(chunk);
		}
		this.writableEnded = true;
		this.emit("close");
		return this;
	}

	destroy() {
		this.destroyed = true;
		this.writableEnded = true;
		this.emit("close");
		return this;
	}
}

class BackpressuredMockResponse extends MockResponse {
	private writes = 0;

	override write(chunk: string | Buffer) {
		this.writes += 1;
		super.write(chunk);
		return this.writes !== 2;
	}
}

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

function createJsonRequest(
	method: string,
	url: string,
	body?: unknown,
	headers: Record<string, string> = {},
): IncomingMessage {
	let sent = false;
	const payload =
		body === undefined ? null : Buffer.from(JSON.stringify(body), "utf-8");
	const req = new Readable({
		read() {
			if (sent) {
				return;
			}
			sent = true;
			if (payload) {
				this.push(payload);
			}
			this.push(null);
		},
	}) as IncomingMessage;
	Object.assign(req, {
		method,
		url,
		headers: {
			host: "localhost",
			...(body === undefined
				? {}
				: {
						"content-type": "application/json",
						"content-length": String(JSON.stringify(body).length),
					}),
			...headers,
		},
	});
	return req;
}

function createContext(overrides: Partial<WebServerContext>): WebServerContext {
	const headlessRuntimeService = new HeadlessRuntimeService();
	return {
		corsHeaders: {},
		staticMaxAge: 0,
		defaultApprovalMode: "prompt",
		defaultProvider: "openai",
		defaultModelId: TEST_MODEL.id,
		createAgent: vi.fn(),
		getRegisteredModel: vi.fn().mockResolvedValue(TEST_MODEL),
		getCurrentSelection: () => ({
			provider: TEST_MODEL.provider,
			modelId: TEST_MODEL.id,
		}),
		ensureCredential: vi.fn(),
		setModelSelection: vi.fn(),
		acquireSse: () => null,
		releaseSse: () => {},
		headlessRuntimeService,
		...overrides,
	};
}

function createMockAttachedStream(
	initial: HeadlessRuntimeStreamEnvelope[] = [],
	options?: { overflowSnapshot?: HeadlessRuntimeSnapshot },
) {
	const queue = [...initial];
	const listeners = new Set<() => void>();
	let queuedReset: HeadlessRuntimeStreamEnvelope | null = null;
	return {
		stream: {
			id: "sub_test",
			next: () => {
				const next = queuedReset ?? queue.shift() ?? null;
				if (queuedReset) {
					queuedReset = null;
				}
				return next;
			},
			onAvailable: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			enqueue: (envelope: HeadlessRuntimeStreamEnvelope) => {
				queue.push(envelope);
				if (options?.overflowSnapshot && queue.length > 128) {
					queue.length = 0;
					queuedReset = {
						type: "reset",
						reason: "lagged",
						snapshot: options.overflowSnapshot,
					};
				}
				for (const listener of listeners) {
					listener();
				}
			},
			close: vi.fn(),
		},
		push: (envelope: HeadlessRuntimeStreamEnvelope) => {
			queue.push(envelope);
			if (options?.overflowSnapshot && queue.length > 128) {
				queue.length = 0;
				queuedReset = {
					type: "reset",
					reason: "lagged",
					snapshot: options.overflowSnapshot,
				};
			}
			for (const listener of listeners) {
				listener();
			}
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const request of serverRequestManager.listPending()) {
		serverRequestManager.cancel(request.id, "Test cleanup");
	}
});

describe("headless session runtime", () => {
	it("creates a replayable snapshot and tracks outgoing init/prompt state", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const initial = runtime.getSnapshot();
			expect(initial.protocolVersion).toBe(HEADLESS_PROTOCOL_VERSION);
			expect(initial.state.is_ready).toBe(true);
			expect(initial.state.model).toBe(TEST_MODEL.id);
			expect(initial.state.provider).toBe(TEST_MODEL.provider);

			await runtime.send({
				type: "init",
				system_prompt: "Be precise",
				thinking_level: "high",
			});
			await runtime.send({
				type: "prompt",
				content: "Summarize the session",
			});

			const snapshot = runtime.getSnapshot();
			expect(snapshot.last_init).toEqual({
				type: "init",
				system_prompt: "Be precise",
				thinking_level: "high",
			});
			expect(Value.Check(HeadlessRuntimeSnapshotSchema, snapshot)).toBe(true);
			expect(fakeAgent.prompts).toEqual([
				{ content: "Summarize the session", attachments: undefined },
			]);
			expect(snapshot.state.last_status).toBe("Prompt: Summarize the session");

			const replay = runtime.replayFrom(0);
			for (const envelope of replay ?? []) {
				expect(Value.Check(HeadlessRuntimeStreamEnvelopeSchema, envelope)).toBe(
					true,
				);
			}
			expect(
				replay?.map((entry) =>
					entry.type === "message" ? entry.message.type : entry.type,
				),
			).toEqual(["ready", "session_info", "status", "status"]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("emits subscription and heartbeat payloads that satisfy generated schemas", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
					utility_operations: ["command_exec"],
				},
				context,
				sessionManager,
			});

			const subscription = runtime.createSubscription({
				role: "controller",
				explicit: true,
			});
			expect(
				Value.Check(HeadlessRuntimeSubscriptionSnapshotSchema, subscription),
			).toBe(true);

			const heartbeat = runtime.heartbeatConnection({
				subscriptionId: subscription.subscription_id,
			});
			expect(
				Value.Check(HeadlessRuntimeHeartbeatSnapshotSchema, heartbeat),
			).toBe(true);

			await runtime.dispose();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("filters opted-out notification types from subscription mailboxes", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
					utility_operations: ["command_exec"],
				},
				context,
				sessionManager,
			});

			const subscription = runtime.createSubscription({
				role: "controller",
				explicit: true,
				optOutNotifications: ["status", "heartbeat", "connection_info"],
			});
			expect(subscription.opt_out_notifications).toEqual([
				"status",
				"heartbeat",
				"connection_info",
			]);

			const attached = runtime.attachSubscription(subscription.subscription_id);
			expect(attached).not.toBeNull();
			expect(attached?.next()).toMatchObject({ type: "snapshot" });
			expect(attached?.next()).toBeNull();

			await runtime.send({
				type: "init",
				system_prompt: "Be terse",
			});
			expect(attached?.next()).toBeNull();

			attached?.enqueue(runtime.heartbeat());
			expect(attached?.next()).toBeNull();

			await runtime.dispose();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("tracks negotiated connection metadata in runtime snapshots", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				clientProtocolVersion: "2026-03-30",
				clientInfo: { name: "maestro-web", version: "1.2.3" },
				capabilities: { server_requests: ["approval", "client_tool"] },
				optOutNotifications: ["status", "heartbeat"],
				role: "controller",
				context,
				sessionManager,
			});

			const snapshot = runtime.getSnapshot();
			expect(snapshot.state.client_protocol_version).toBe("2026-03-30");
			expect(snapshot.state.client_info).toEqual({
				name: "maestro-web",
				version: "1.2.3",
			});
			expect(snapshot.state.capabilities).toEqual({
				server_requests: ["approval", "client_tool"],
			});
			expect(snapshot.state.opt_out_notifications).toEqual([
				"status",
				"heartbeat",
			]);
			expect(snapshot.state.connection_role).toBe("controller");
			expect(snapshot.state.connections[0]?.opt_out_notifications).toEqual([
				"status",
				"heartbeat",
			]);

			expect(
				runtime
					.replayFrom(0)
					?.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.type === "connection_info",
					),
			).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("inherits connection-level opt-out notifications for new subscriptions", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				clientProtocolVersion: "2026-04-02",
				clientInfo: { name: "maestro-web", version: "1.2.3" },
				capabilities: { server_requests: ["approval"] },
				optOutNotifications: ["status", "connection_info"],
				role: "controller",
				context,
				sessionManager,
			});

			const subscription = runtime.createSubscription({
				role: "controller",
				explicit: true,
			});
			expect(subscription.opt_out_notifications).toEqual([
				"status",
				"connection_info",
			]);

			await runtime.dispose();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("replays approval request lifecycle messages from the runtime broker", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const request = {
				id: "call_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			};
			fakeAgent.emit({
				type: "action_approval_required",
				request,
			});
			const approvalService = (
				runtime as unknown as {
					approvalService: {
						requestApproval(request: typeof request): Promise<{
							approved: boolean;
							reason?: string;
							resolvedBy: "policy" | "user";
						}>;
					};
				}
			).approvalService;
			const approvalPromise = approvalService.requestApproval(request);

			await runtime.send({
				type: "tool_response",
				call_id: request.id,
				approved: false,
				result: {
					error: "Denied by user",
				},
			});
			await expect(approvalPromise).resolves.toEqual({
				approved: false,
				reason: "Denied by user",
				resolvedBy: "user",
			});

			const replay = runtime.replayFrom(0);
			expect(
				replay?.map((entry) =>
					entry.type === "message" ? entry.message.type : entry.type,
				),
			).toEqual([
				"ready",
				"session_info",
				"tool_call",
				"server_request",
				"server_request_resolved",
				"snapshot",
			]);
			expect(runtime.getSnapshot().state.pending_approvals).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes a snapshot after interrupt clears pending approval state", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const request = {
				id: "call_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			};
			fakeAgent.emit({
				type: "action_approval_required",
				request,
			});
			const approvalService = (
				runtime as unknown as {
					approvalService: {
						requestApproval(request: typeof request): Promise<unknown>;
					};
				}
			).approvalService;
			void approvalService.requestApproval(request);

			await runtime.send({ type: "interrupt" });

			const replay = runtime.replayFrom(0);
			expect(replay?.at(-2)).toEqual({
				type: "message",
				cursor: expect.any(Number),
				message: {
					type: "server_request_resolved",
					request_id: "call_approval",
					request_type: "approval",
					call_id: "call_approval",
					resolution: "cancelled",
					reason: "Interrupted before request completed",
					resolved_by: "runtime",
				},
			});
			expect(replay?.at(-1)).toEqual({
				type: "snapshot",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({
						pending_approvals: [],
						tracked_tools: [],
						active_tools: [],
						is_responding: false,
					}),
				}),
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("suppresses approval-only headless messages in auto approval mode", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "auto",
				context,
				sessionManager,
			});

			fakeAgent.emit({
				type: "action_approval_required",
				request: {
					id: "call_auto_approval",
					toolName: "bash",
					args: { command: "git push --force" },
					reason: "Force push requires approval",
				},
			});

			const replay = runtime.replayFrom(0) ?? [];
			expect(
				replay.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.type === "tool_call" &&
						entry.message.call_id === "call_auto_approval",
				),
			).toBeUndefined();
			expect(
				replay.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.type === "server_request" &&
						entry.message.request_id === "call_auto_approval",
				),
			).toBeUndefined();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes cancelled client tool request resolutions before interrupt snapshots", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			fakeAgent.emit({
				type: "client_tool_request",
				toolCallId: "call_client",
				toolName: "artifacts",
				args: { command: "create", filename: "report.txt" },
			});
			void clientToolService.requestExecution(
				"call_client",
				"artifacts",
				{ command: "create", filename: "report.txt" },
				undefined,
				runtime.id(),
			);

			await runtime.send({ type: "interrupt" });

			const replay = runtime.replayFrom(0);
			expect(
				replay?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request_resolved" &&
						entry.message.request_type === "client_tool" &&
						entry.message.resolution === "cancelled"
					);
				}),
			).toBe(true);
			expect(runtime.getSnapshot().state.pending_client_tools).toEqual([]);
			expect(runtime.getSnapshot().state.tracked_tools).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels shared approval requests on interrupt without duplicating later approval events", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const request = {
				id: "call_interrupt_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			};
			fakeAgent.emit({
				type: "action_approval_required",
				request,
			});

			const approvalService = (
				runtime as unknown as {
					approvalService: {
						requestApproval(request: typeof request): Promise<{
							approved: boolean;
							reason?: string;
							resolvedBy: "policy" | "user";
						}>;
					};
				}
			).approvalService;
			const pendingDecision = approvalService.requestApproval(request);
			expect(
				serverRequestManager.listPending({ sessionId: runtime.id() }),
			).toEqual([
				expect.objectContaining({
					id: "call_interrupt_approval",
					kind: "approval",
				}),
			]);

			await runtime.send({ type: "interrupt" });
			await expect(pendingDecision).resolves.toEqual({
				approved: false,
				reason: "Interrupted before request completed",
				resolvedBy: "policy",
			});
			expect(
				serverRequestManager.listPending({ sessionId: runtime.id() }),
			).toEqual([]);

			fakeAgent.emit({
				type: "action_approval_resolved",
				request,
				decision: {
					approved: false,
					reason: "Interrupted before request completed",
					resolvedBy: "policy",
				},
			});

			const replay = runtime.replayFrom(0) ?? [];
			const resolutions = replay.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.type === "server_request_resolved" &&
					entry.message.call_id === "call_interrupt_approval",
			);
			expect(resolutions).toHaveLength(1);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels shared client tool requests on interrupt", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			fakeAgent.emit({
				type: "client_tool_request",
				toolCallId: "call_interrupt_client_tool",
				toolName: "artifacts",
				args: { command: "create", filename: "report.txt" },
			});
			const pendingExecution = clientToolService.requestExecution(
				"call_interrupt_client_tool",
				"artifacts",
				{ command: "create", filename: "report.txt" },
				undefined,
				runtime.id(),
			);
			expect(
				serverRequestManager.listPending({ sessionId: runtime.id() }),
			).toEqual([
				expect.objectContaining({
					id: "call_interrupt_client_tool",
					kind: "client_tool",
				}),
			]);

			await runtime.send({ type: "interrupt" });
			await expect(pendingExecution).resolves.toEqual({
				content: [
					{
						type: "text",
						text: "Interrupted before request completed",
					},
				],
				isError: true,
			});
			expect(
				serverRequestManager.listPending({ sessionId: runtime.id() }),
			).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes timeout-driven server request resolutions from the shared manager", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const request = {
				id: "call_timeout_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			};
			fakeAgent.emit({
				type: "action_approval_required",
				request,
			});
			const approvalService = (
				runtime as unknown as {
					approvalService: {
						requestApproval(
							request: typeof request,
							signal?: AbortSignal,
						): Promise<{
							approved: boolean;
							reason?: string;
							resolvedBy: "policy" | "user";
						}>;
					};
				}
			).approvalService;
			const pendingDecision = approvalService.requestApproval(request);

			serverRequestManager.cleanup(Date.now() + 60 * 60 * 1000 + 5);

			await expect(pendingDecision).resolves.toEqual({
				approved: false,
				reason: "Approval request timed out",
				resolvedBy: "policy",
			});
			expect(runtime.getSnapshot().state.pending_approvals).toEqual([]);

			const replay = runtime.replayFrom(0) ?? [];
			expect(
				replay.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.type === "server_request_resolved" &&
						entry.message.call_id === "call_timeout_approval" &&
						entry.message.resolution === "denied" &&
						entry.message.reason === "Approval request timed out" &&
						entry.message.resolved_by === "policy",
				),
			).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes a snapshot after tool responses clear approval state", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const approvalService = (
				runtime as unknown as {
					approvalService: {
						requestApproval(request: {
							id: string;
							toolName: string;
							args: unknown;
							reason: string;
						}): Promise<unknown>;
					};
				}
			).approvalService;

			const approvalPromise = approvalService.requestApproval({
				id: "call_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			});

			fakeAgent.emit({
				type: "action_approval_required",
				request: {
					id: "call_approval",
					toolName: "bash",
					args: { command: "git push --force" },
					reason: "Force push requires approval",
				},
			});

			await runtime.send({
				type: "tool_response",
				call_id: "call_approval",
				approved: false,
				result: {
					error: "Denied by user",
				},
			});

			await expect(approvalPromise).resolves.toEqual({
				approved: false,
				reason: "Denied by user",
				resolvedBy: "user",
			});

			const replay = runtime.replayFrom(0);
			expect(replay?.at(-1)).toEqual({
				type: "snapshot",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({
						pending_approvals: [],
						tracked_tools: [],
					}),
				}),
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("replays client tool requests and resolves them through headless messages", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				context,
				sessionManager,
			});

			const resultPromise = clientToolService.requestExecution(
				"call_client",
				"artifacts",
				{ command: "create", filename: "report.txt" },
				undefined,
				runtime.id(),
			);

			fakeAgent.emit({
				type: "client_tool_request",
				toolCallId: "call_client",
				toolName: "artifacts",
				args: { command: "create", filename: "report.txt" },
			});

			expect(runtime.getSnapshot().state.pending_client_tools).toEqual([
				{
					call_id: "call_client",
					tool: "artifacts",
					args: { command: "create", filename: "report.txt" },
				},
			]);

			await runtime.send({
				type: "client_tool_result",
				call_id: "call_client",
				content: [{ type: "text", text: "created" }],
				is_error: false,
			});

			await expect(resultPromise).resolves.toEqual({
				content: [{ type: "text", text: "created" }],
				isError: false,
			});

			expect(runtime.getSnapshot().state.pending_client_tools).toEqual([]);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return entry.message.type === "client_tool_request";
				}),
			).toBe(true);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request" &&
						entry.message.request_type === "client_tool"
					);
				}),
			).toBe(true);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request_resolved" &&
						entry.message.request_type === "client_tool" &&
						entry.message.resolution === "completed"
					);
				}),
			).toBe(true);
			expect(runtime.replayFrom(0)?.at(-1)).toEqual({
				type: "snapshot",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({
						pending_client_tools: [],
					}),
				}),
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("headless session handlers", () => {
	it("creates a session and returns a snapshot response", async () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_123",
			cursor: 2,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const runtime = {
			getSnapshot: vi.fn().mockReturnValue(snapshot),
		};
		const context = createContext({
			headlessRuntimeService: {
				ensureRuntime: vi.fn().mockResolvedValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			thinkingLevel: "low",
		});
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessSessionCreate(
			req,
			res as unknown as ServerResponse,
			context,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual(snapshot);
	});

	it("includes negotiated connection metadata in session snapshots", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			protocolVersion: "2026-03-30",
			clientInfo: { name: "maestro-vscode", version: "0.2.0" },
			capabilities: {
				serverRequests: ["approval"],
			},
			role: "viewer",
		});
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessSessionCreate(
			req,
			res as unknown as ServerResponse,
			context,
		);

		const body = JSON.parse(res.body);
		expect(body.state.client_protocol_version).toBe("2026-03-30");
		expect(body.state.client_info).toEqual({
			name: "maestro-vscode",
			version: "0.2.0",
		});
		expect(body.state.capabilities).toEqual({
			server_requests: ["approval"],
		});
		expect(body.state.connection_role).toBe("viewer");
	});

	it("creates an explicit connection bootstrap without attaching a subscription", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const req = createJsonRequest("POST", "/api/headless/connections", {
			model: TEST_MODEL.id,
			protocolVersion: "2026-04-03",
			clientInfo: { name: "maestro-tui-rs", version: "0.1.0" },
			capabilities: {
				serverRequests: ["approval", "client_tool"],
				utilityOperations: ["command_exec", "file_read"],
			},
			role: "controller",
		});
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessConnectionCreate(
			req,
			res as unknown as ServerResponse,
			context,
		);

		const body = JSON.parse(res.body);
		expect(body.connection_id).toEqual(expect.any(String));
		expect(body.controller_lease_granted).toBe(true);
		expect(body.role).toBe("controller");
		expect(body.snapshot.state.connection_count).toBe(1);
		expect(body.snapshot.state.subscriber_count).toBe(0);
		expect(body.snapshot.state.controller_connection_id).toBe(
			body.connection_id,
		);
		expect(body.snapshot.state.client_protocol_version).toBe("2026-04-03");
		expect(body.snapshot.state.client_info).toEqual({
			name: "maestro-tui-rs",
			version: "0.1.0",
		});
		expect(Value.Check(HeadlessRuntimeSnapshotSchema, body.snapshot)).toBe(
			true,
		);
	});

	it("creates explicit subscriptions with controller lease metadata", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const createReq = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
		});
		const createRes = new MockResponse();
		createRes.req = createReq;
		await handleHeadlessSessionCreate(
			createReq,
			createRes as unknown as ServerResponse,
			context,
		);
		const sessionId = JSON.parse(createRes.body).session_id;

		const subscribeReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{
				role: "controller",
				protocolVersion: "2026-03-30",
				clientInfo: { name: "maestro-tui-rs", version: "0.1.0" },
			},
		);
		const subscribeRes = new MockResponse();
		subscribeRes.req = subscribeReq;

		await handleHeadlessSessionSubscribe(
			subscribeReq,
			subscribeRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);

		const body = JSON.parse(subscribeRes.body);
		expect(body.subscription_id).toEqual(expect.any(String));
		expect(body.controller_lease_granted).toBe(true);
		expect(body.controller_subscription_id).toBe(body.subscription_id);
		expect(body.snapshot.state.subscriber_count).toBe(1);
		expect(body.snapshot.state.controller_subscription_id).toBe(
			body.subscription_id,
		);
	});

	it("rejects a second explicit controller subscription while a lease is held", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const createReq = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
		});
		const createRes = new MockResponse();
		createRes.req = createReq;
		await handleHeadlessSessionCreate(
			createReq,
			createRes as unknown as ServerResponse,
			context,
		);
		const sessionId = JSON.parse(createRes.body).session_id;

		const firstReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{ role: "controller" },
		);
		const firstRes = new MockResponse();
		firstRes.req = firstReq;
		await handleHeadlessSessionSubscribe(
			firstReq,
			firstRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);

		const secondReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{ role: "controller" },
		);
		const secondRes = new MockResponse();
		secondRes.req = secondReq;
		await expect(
			handleHeadlessSessionSubscribe(
				secondReq,
				secondRes as unknown as ServerResponse,
				context,
				{ id: sessionId },
			),
		).rejects.toMatchObject({
			statusCode: 409,
			message: "Controller lease is already held by another connection",
		});

		const runtime = await context.headlessRuntimeService.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
			sessionId,
			registerConnection: false,
		});
		expect(runtime.getSnapshot().state.connection_count).toBe(1);
	});

	it("allows explicit controller takeover when requested", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const createReq = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
		});
		const createRes = new MockResponse();
		createRes.req = createReq;
		await handleHeadlessSessionCreate(
			createReq,
			createRes as unknown as ServerResponse,
			context,
		);
		const sessionId = JSON.parse(createRes.body).session_id;

		const firstReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{ role: "controller" },
		);
		const firstRes = new MockResponse();
		firstRes.req = firstReq;
		await handleHeadlessSessionSubscribe(
			firstReq,
			firstRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);
		const first = JSON.parse(firstRes.body);

		const secondReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{ role: "controller", takeControl: true },
		);
		const secondRes = new MockResponse();
		secondRes.req = secondReq;
		await handleHeadlessSessionSubscribe(
			secondReq,
			secondRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);
		const second = JSON.parse(secondRes.body);

		expect(second.subscription_id).not.toBe(first.subscription_id);
		expect(second.controller_subscription_id).toBe(second.subscription_id);
		expect(second.snapshot.state.controller_subscription_id).toBe(
			second.subscription_id,
		);
	});

	it("fully clears runtime connection state after shutdown", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const runtime = await context.headlessRuntimeService.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		const subscription = runtime.createSubscription({ role: "controller" });
		await runtime.send(
			{ type: "shutdown" },
			{ subscriptionId: subscription.subscription_id },
		);

		const snapshot = runtime.getSnapshot();
		expect(runtime.isDisposed()).toBe(true);
		expect(snapshot.state.connection_count).toBe(0);
		expect(snapshot.state.subscriber_count).toBe(0);
		expect(snapshot.state.controller_connection_id).toBeNull();
	});

	it("coalesces concurrent runtime disposal", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const runtime = await context.headlessRuntimeService.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		const internals = runtime as unknown as {
			utilityCommands: {
				dispose: (reason?: string) => Promise<void>;
			};
		};
		const originalDispose = internals.utilityCommands.dispose.bind(
			internals.utilityCommands,
		);
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		const disposeSpy = vi
			.spyOn(internals.utilityCommands, "dispose")
			.mockImplementation(async (reason?: string) => {
				await disposeGate;
				return originalDispose(reason);
			});

		const firstDispose = runtime.dispose();
		await Promise.resolve();
		const secondDispose = runtime.dispose();

		expect(disposeSpy).toHaveBeenCalledTimes(1);

		releaseDispose();
		await Promise.all([firstDispose, secondDispose]);

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(runtime.isDisposed()).toBe(true);
	});

	it("allows retrying runtime disposal after a failed attempt", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const runtime = await context.headlessRuntimeService.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		const internals = runtime as unknown as {
			utilityCommands: {
				dispose: (reason?: string) => Promise<void>;
			};
		};
		const originalDispose = internals.utilityCommands.dispose.bind(
			internals.utilityCommands,
		);
		const disposeSpy = vi
			.spyOn(internals.utilityCommands, "dispose")
			.mockRejectedValueOnce(new Error("dispose failed"))
			.mockImplementation((reason?: string) => originalDispose(reason));

		await expect(runtime.dispose()).rejects.toThrow("dispose failed");
		expect(runtime.isDisposed()).toBe(false);

		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(disposeSpy).toHaveBeenCalledTimes(2);
		expect(runtime.isDisposed()).toBe(true);
	});

	it("allows retrying runtime disposal after a synchronous failed attempt", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const runtime = await context.headlessRuntimeService.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		const internals = runtime as unknown as {
			utilityCommands: {
				dispose: (reason?: string) => Promise<void>;
			};
		};
		const originalDispose = internals.utilityCommands.dispose.bind(
			internals.utilityCommands,
		);
		const disposeSpy = vi
			.spyOn(internals.utilityCommands, "dispose")
			.mockImplementationOnce(() => {
				throw new Error("dispose failed synchronously");
			})
			.mockImplementation((reason?: string) => originalDispose(reason));

		await expect(runtime.dispose()).rejects.toThrow(
			"dispose failed synchronously",
		);
		expect(runtime.isDisposed()).toBe(false);

		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(disposeSpy).toHaveBeenCalledTimes(2);
		expect(runtime.isDisposed()).toBe(true);
	});

	it("continues cleanup when one runtime disposal fails", async () => {
		const firstAgent = new FakeAgent();
		const secondAgent = new FakeAgent();
		const createAgent = vi
			.fn()
			.mockResolvedValueOnce(firstAgent)
			.mockResolvedValueOnce(secondAgent);
		const context = createContext({ createAgent });
		const service = context.headlessRuntimeService;
		const firstRuntime = await service.ensureRuntime({
			scope_key: "anon",
			sessionId: "first",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});
		const secondRuntime = await service.ensureRuntime({
			scope_key: "anon",
			sessionId: "second",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		vi.spyOn(firstRuntime, "isIdle").mockReturnValue(true);
		vi.spyOn(secondRuntime, "isIdle").mockReturnValue(true);
		vi.spyOn(firstRuntime, "dispose").mockRejectedValueOnce(
			new Error("first dispose failed"),
		);

		await (
			service as unknown as {
				cleanup: () => Promise<void>;
			}
		).cleanup();

		expect(service.getRuntime("anon", firstRuntime.id())).toBe(firstRuntime);
		expect(service.getRuntime("anon", secondRuntime.id())).toBeUndefined();
	});

	it("force-disposes idle runtimes after repeated cleanup failures", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const service = context.headlessRuntimeService;
		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			sessionId: "stuck",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context,
			sessionManager: createSessionManagerForRequest(
				createJsonRequest("POST", "/api/headless/sessions", {}),
				"headless",
			),
		});

		vi.spyOn(runtime, "isIdle").mockReturnValue(true);
		vi.spyOn(runtime, "dispose").mockRejectedValue(
			new Error("dispose keeps failing"),
		);

		const cleanup = (
			service as unknown as {
				cleanup: () => Promise<void>;
			}
		).cleanup.bind(service);

		await cleanup();
		expect(service.getRuntime("anon", runtime.id())).toBe(runtime);
		expect(runtime.isDisposed()).toBe(false);

		await cleanup();
		expect(service.getRuntime("anon", runtime.id())).toBe(runtime);
		expect(runtime.isDisposed()).toBe(false);

		await cleanup();
		expect(service.getRuntime("anon", runtime.id())).toBeUndefined();
		expect(runtime.isDisposed()).toBe(true);
	});

	it("explicit unsubscribe releases the controller lease", async () => {
		const fakeAgent = new FakeAgent();
		const context = createContext({
			createAgent: vi.fn().mockResolvedValue(fakeAgent),
		});
		const createReq = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
		});
		const createRes = new MockResponse();
		createRes.req = createReq;
		await handleHeadlessSessionCreate(
			createReq,
			createRes as unknown as ServerResponse,
			context,
		);
		const sessionId = JSON.parse(createRes.body).session_id;

		const subscribeReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/subscribe`,
			{ role: "controller" },
		);
		const subscribeRes = new MockResponse();
		subscribeRes.req = subscribeReq;
		await handleHeadlessSessionSubscribe(
			subscribeReq,
			subscribeRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);
		const { subscription_id } = JSON.parse(subscribeRes.body);

		const unsubscribeReq = createJsonRequest(
			"POST",
			`/api/headless/sessions/${sessionId}/unsubscribe`,
			{ subscriptionId: subscription_id },
		);
		const unsubscribeRes = new MockResponse();
		unsubscribeRes.req = unsubscribeReq;
		await handleHeadlessSessionUnsubscribe(
			unsubscribeReq,
			unsubscribeRes as unknown as ServerResponse,
			context,
			{ id: sessionId },
		);

		expect(JSON.parse(unsubscribeRes.body)).toEqual({ success: true });
		const runtime = context.headlessRuntimeService.getRuntime(
			"anon",
			sessionId,
		);
		expect(runtime?.getSnapshot().state.subscriber_count).toBe(0);
		expect(runtime?.getSnapshot().state.controller_subscription_id).toBeNull();
	});

	it("explicit unsubscribe cleans up utility resources owned by that connection", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
					utility_operations: ["file_watch"],
				},
				context,
				sessionManager,
			});
			const sessionId = runtime.getSnapshot().session_id;
			if (!sessionId) {
				throw new Error("Expected headless session id");
			}

			const subscribeReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/subscribe`,
				{ role: "controller" },
			);
			const subscribeRes = new MockResponse();
			subscribeRes.req = subscribeReq;
			await handleHeadlessSessionSubscribe(
				subscribeReq,
				subscribeRes as unknown as ServerResponse,
				context,
				{ id: sessionId },
			);
			const { connection_id, subscription_id } = JSON.parse(subscribeRes.body);

			const messageReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_file_watch_start",
					watch_id: "watch_owned",
					root_dir: tempDir,
					debounce_ms: 10,
				},
				{
					"x-maestro-headless-subscriber-id": subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const messageRes = new MockResponse();
			messageRes.req = messageReq;
			await handleHeadlessSessionMessage(
				messageReq,
				messageRes as unknown as ServerResponse,
				context,
				{ id: sessionId },
			);
			expect(JSON.parse(messageRes.body)).toEqual({ success: true });
			expect(runtime.getSnapshot().state.active_file_watches).toEqual([
				expect.objectContaining({
					watch_id: "watch_owned",
					owner_connection_id: connection_id,
				}),
			]);

			const unsubscribeReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/unsubscribe`,
				{ subscriptionId: subscription_id },
			);
			const unsubscribeRes = new MockResponse();
			unsubscribeRes.req = unsubscribeReq;
			await handleHeadlessSessionUnsubscribe(
				unsubscribeReq,
				unsubscribeRes as unknown as ServerResponse,
				context,
				{ id: sessionId },
			);

			expect(JSON.parse(unsubscribeRes.body)).toEqual({ success: true });
			expect(runtime.getSnapshot().state.active_file_watches).toEqual([]);
			expect(runtime.getSnapshot().state.controller_connection_id).toBeNull();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("streams utility file read results to the owning subscription", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			await writeFile(join(tempDir, "notes.txt"), "one\ntwo\nthree\nfour\n");
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
					utility_operations: ["file_read"],
				},
				context,
				sessionManager,
			});
			const sessionId = runtime.getSnapshot().session_id;
			if (!sessionId) {
				throw new Error("Expected headless session id");
			}

			const subscription = runtime.createSubscription({ role: "controller" });
			const attached = runtime.attachSubscription(subscription.subscription_id);
			while (attached?.next()) {
				// Drain connection-info messages queued during explicit subscription setup.
			}

			const messageReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_file_read",
					read_id: "read_remote",
					path: "notes.txt",
					cwd: tempDir,
					offset: 2,
					limit: 2,
				},
				{
					"x-maestro-headless-subscriber-id": subscription.subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const messageRes = new MockResponse();
			messageRes.req = messageReq;
			await handleHeadlessSessionMessage(
				messageReq,
				messageRes as unknown as ServerResponse,
				context,
				{ id: sessionId },
			);

			expect(JSON.parse(messageRes.body)).toEqual({ success: true });
			expect(attached?.next()).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_read_result",
					read_id: "read_remote",
					relative_path: "notes.txt",
					cwd: tempDir,
					content: "two\nthree",
					start_line: 2,
					end_line: 3,
					total_lines: 4,
					truncated: true,
				},
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("queues hello_ok only for the initiating subscription", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
				},
				context,
				sessionManager,
			});

			const subscription = runtime.createSubscription({
				role: "controller",
				optOutNotifications: ["connection_info"],
			});
			const attached = runtime.attachSubscription(subscription.subscription_id);
			while (attached?.next()) {
				// Drain any initial subscription envelopes.
			}

			await runtime.send(
				{
					type: "hello",
					protocol_version: "2026-04-02",
					client_info: { name: "maestro-web", version: "1.0.0" },
					capabilities: { server_requests: ["approval"] },
					opt_out_notifications: ["connection_info"],
					role: "controller",
				},
				{ subscriptionId: subscription.subscription_id },
			);

			expect(attached?.next()).toMatchObject({
				type: "message",
				message: {
					type: "hello_ok",
					protocol_version: HEADLESS_PROTOCOL_VERSION,
					connection_id: subscription.connection_id,
					client_protocol_version: "2026-04-02",
					opt_out_notifications: ["connection_info"],
					role: "controller",
				},
			});
			expect(attached?.next()).toBeNull();
			expect(runtime.getSnapshot().state.client_protocol_version).toBe(
				"2026-04-02",
			);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects utility control messages from a different controller connection", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval"],
					utility_operations: ["command_exec", "file_watch"],
				},
				context,
				sessionManager,
			});
			const sessionId = runtime.getSnapshot().session_id;
			if (!sessionId) {
				throw new Error("Expected headless session id");
			}

			const first = runtime.createSubscription({ role: "controller" });
			const second = runtime.createSubscription({
				role: "controller",
				takeControl: true,
			});

			await runtime.send(
				{
					type: "utility_command_start",
					command_id: "cmd_owned",
					command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
					shell_mode: "direct",
				},
				{ subscriptionId: first.subscription_id },
			);
			await runtime.send(
				{
					type: "utility_file_watch_start",
					watch_id: "watch_owned",
					root_dir: tempDir,
					debounce_ms: 10,
				},
				{ subscriptionId: first.subscription_id },
			);

			const commandStdinReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_command_stdin",
					command_id: "cmd_owned",
					content: "status\n",
				},
				{
					"x-maestro-headless-subscriber-id": second.subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const commandStdinRes = new MockResponse();
			commandStdinRes.req = commandStdinReq;
			await expect(
				handleHeadlessSessionMessage(
					commandStdinReq,
					commandStdinRes as unknown as ServerResponse,
					context,
					{ id: sessionId },
				),
			).rejects.toMatchObject({
				statusCode: 403,
				message: "Headless command cmd_owned is owned by another connection",
			});

			const commandReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_command_terminate",
					command_id: "cmd_owned",
				},
				{
					"x-maestro-headless-subscriber-id": second.subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const commandRes = new MockResponse();
			commandRes.req = commandReq;
			await expect(
				handleHeadlessSessionMessage(
					commandReq,
					commandRes as unknown as ServerResponse,
					context,
					{ id: sessionId },
				),
			).rejects.toMatchObject({
				statusCode: 403,
				message: "Headless command cmd_owned is owned by another connection",
			});

			const commandResizeReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_command_resize",
					command_id: "cmd_owned",
					columns: 100,
					rows: 40,
				},
				{
					"x-maestro-headless-subscriber-id": second.subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const commandResizeRes = new MockResponse();
			commandResizeRes.req = commandResizeReq;
			await expect(
				handleHeadlessSessionMessage(
					commandResizeReq,
					commandResizeRes as unknown as ServerResponse,
					context,
					{ id: sessionId },
				),
			).rejects.toMatchObject({
				statusCode: 403,
				message: "Headless command cmd_owned is owned by another connection",
			});

			const watchReq = createJsonRequest(
				"POST",
				`/api/headless/sessions/${sessionId}/messages`,
				{
					type: "utility_file_watch_stop",
					watch_id: "watch_owned",
				},
				{
					"x-maestro-headless-subscriber-id": second.subscription_id,
					"x-maestro-headless-role": "controller",
				},
			);
			const watchRes = new MockResponse();
			watchRes.req = watchReq;
			await expect(
				handleHeadlessSessionMessage(
					watchReq,
					watchRes as unknown as ServerResponse,
					context,
					{ id: sessionId },
				),
			).rejects.toMatchObject({
				statusCode: 403,
				message:
					"Headless file watch watch_owned is owned by another connection",
			});

			expect(runtime.getSnapshot().state.active_utility_commands).toEqual([
				expect.objectContaining({
					command_id: "cmd_owned",
					owner_connection_id: first.connection_id,
				}),
			]);
			expect(runtime.getSnapshot().state.active_file_watches).toEqual([
				expect.objectContaining({
					watch_id: "watch_owned",
					owner_connection_id: first.connection_id,
				}),
			]);

			await runtime.dispose();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("passes client tool creation options through to the agent factory", async () => {
		const createAgent = vi.fn().mockResolvedValue(new FakeAgent());
		const context = createContext({ createAgent });
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			enableClientTools: true,
			capabilities: {
				serverRequests: ["approval", "client_tool"],
			},
			client: "vscode",
		});
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessSessionCreate(
			req,
			res as unknown as ServerResponse,
			context,
		);

		expect(createAgent).toHaveBeenCalledWith(
			TEST_MODEL,
			"off",
			"prompt",
			expect.objectContaining({
				enableClientTools: true,
				useClientAskUser: false,
				includeVscodeTools: true,
				includeJetBrainsTools: false,
				includeConductorTools: false,
			}),
		);
	});

	it("enables client ask_user routing when user_input capability is negotiated", async () => {
		const createAgent = vi.fn().mockResolvedValue(new FakeAgent());
		const context = createContext({ createAgent });
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			capabilities: {
				serverRequests: ["approval", "user_input"],
			},
		});
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessSessionCreate(
			req,
			res as unknown as ServerResponse,
			context,
		);

		expect(createAgent).toHaveBeenCalledWith(
			TEST_MODEL,
			"off",
			"prompt",
			expect.objectContaining({
				enableClientTools: undefined,
				useClientAskUser: true,
			}),
		);
	});

	it("rejects enabling client tools without negotiated client_tool support", async () => {
		const context = createContext({});
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			enableClientTools: true,
			capabilities: {
				serverRequests: ["approval"],
			},
			client: "vscode",
		});
		const res = new MockResponse();
		res.req = req;

		await expect(
			handleHeadlessSessionCreate(
				req,
				res as unknown as ServerResponse,
				context,
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message:
				"client_tool capability is required when enableClientTools is true",
		});
	});

	it("rejects viewer user_input capability negotiation", async () => {
		const context = createContext({});
		const req = createJsonRequest("POST", "/api/headless/sessions", {
			model: TEST_MODEL.id,
			role: "viewer",
			capabilities: {
				serverRequests: ["approval", "user_input"],
			},
		});
		const res = new MockResponse();
		res.req = req;

		await expect(
			handleHeadlessSessionCreate(
				req,
				res as unknown as ServerResponse,
				context,
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message:
				"viewer headless connections cannot negotiate user_input requests",
		});
	});

	it("rejects viewer headless message posts", async () => {
		const runtime = {
			assertCanSend: vi.fn().mockImplementation(() => {
				throw new Error("Viewer headless connections cannot send messages");
			}),
			send: vi.fn().mockResolvedValue(undefined),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"POST",
			"/api/headless/sessions/sess_123/messages",
			{ type: "interrupt" },
			{ "x-maestro-headless-role": "viewer" },
		);
		const res = new MockResponse();
		res.req = req;

		await expect(
			handleHeadlessSessionMessage(
				req,
				res as unknown as ServerResponse,
				context,
				{ id: "sess_123" },
			),
		).rejects.toMatchObject({
			statusCode: 403,
			message: "Viewer headless connections cannot send messages",
		});
		expect(runtime.send).not.toHaveBeenCalled();
	});

	it("rejects malformed headless message payloads against generated schemas", async () => {
		const runtime = {
			assertCanSend: vi.fn(),
			send: vi.fn().mockResolvedValue(undefined),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"POST",
			"/api/headless/sessions/sess_123/messages",
			{
				type: "utility_command_stdin",
				command_id: "cmd_missing_content",
			},
		);
		const res = new MockResponse();
		res.req = req;

		await expect(
			handleHeadlessSessionMessage(
				req,
				res as unknown as ServerResponse,
				context,
				{ id: "sess_123" },
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining("content"),
		});
		expect(runtime.assertCanSend).not.toHaveBeenCalled();
		expect(runtime.send).not.toHaveBeenCalled();
	});

	it("rejects unexpected properties on known headless message types", async () => {
		const runtime = {
			assertCanSend: vi.fn(),
			send: vi.fn().mockResolvedValue(undefined),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"POST",
			"/api/headless/sessions/sess_123/messages",
			{
				type: "interrupt",
				unexpected: true,
			},
		);
		const res = new MockResponse();
		res.req = req;

		await expect(
			handleHeadlessSessionMessage(
				req,
				res as unknown as ServerResponse,
				context,
				{ id: "sess_123" },
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining("additional properties"),
		});
		expect(runtime.assertCanSend).not.toHaveBeenCalled();
		expect(runtime.send).not.toHaveBeenCalled();
	});

	it("replays user input requests and resolves them through headless messages", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval", "user_input"],
				},
				context,
				sessionManager,
			});

			const resultPromise = clientToolService.requestExecution(
				"call_user_input",
				"ask_user",
				{
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
				undefined,
				runtime.id(),
			);

			fakeAgent.emit({
				type: "client_tool_request",
				toolCallId: "call_user_input",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			});

			expect(runtime.getSnapshot().state.pending_user_inputs).toEqual([
				{
					call_id: "call_user_input",
					tool: "ask_user",
					args: {
						questions: [
							{
								header: "Stack",
								question: "Which schema library should we use?",
								options: [
									{
										label: "Zod",
										description: "Use Zod schemas",
									},
								],
							},
						],
					},
				},
			]);

			await runtime.send({
				type: "client_tool_result",
				call_id: "call_user_input",
				content: [{ type: "text", text: "Use Zod" }],
				is_error: false,
			});

			await expect(resultPromise).resolves.toEqual({
				content: [{ type: "text", text: "Use Zod" }],
				isError: false,
			});

			expect(runtime.getSnapshot().state.pending_user_inputs).toEqual([]);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request" &&
						entry.message.request_type === "user_input"
					);
				}),
			).toBe(true);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request_resolved" &&
						entry.message.request_type === "user_input" &&
						entry.message.resolution === "answered"
					);
				}),
			).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts generic server_request_response messages for user input requests", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval", "user_input"],
				},
				context,
				sessionManager,
			});

			const resultPromise = clientToolService.requestExecution(
				"call_user_input_generic",
				"ask_user",
				{
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
				undefined,
				runtime.id(),
			);

			fakeAgent.emit({
				type: "client_tool_request",
				toolCallId: "call_user_input_generic",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			});

			await runtime.send({
				type: "server_request_response",
				request_id: "call_user_input_generic",
				request_type: "user_input",
				content: [{ type: "text", text: "Use Zod" }],
				is_error: false,
			});

			await expect(resultPromise).resolves.toEqual({
				content: [{ type: "text", text: "Use Zod" }],
				isError: false,
			});

			expect(runtime.getSnapshot().state.pending_user_inputs).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("replays tool retry requests and resolves them through generic server request responses", async () => {
		const fakeAgent = new FakeAgent();
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-runtime-"));
		try {
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir: tempDir,
			});
			const context = createContext({
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			});

			const runtime = await context.headlessRuntimeService.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				capabilities: {
					server_requests: ["approval", "tool_retry"],
				},
				context,
				sessionManager,
			});

			const toolRetryService = new ServerRequestToolRetryService("prompt", () =>
				runtime.id(),
			);
			const decisionPromise = toolRetryService.requestDecision({
				id: "retry_1",
				toolCallId: "call_bash",
				toolName: "bash",
				args: { command: "ls" },
				errorMessage: "Command failed",
				attempt: 1,
				summary: "Retry bash command",
			});

			expect(runtime.getSnapshot().state.pending_tool_retries).toEqual([
				{
					call_id: "call_bash",
					request_id: "retry_1",
					tool: "bash",
					args: {
						tool_call_id: "call_bash",
						args: { command: "ls" },
						error_message: "Command failed",
						attempt: 1,
						summary: "Retry bash command",
					},
				},
			]);

			await runtime.send({
				type: "server_request_response",
				request_id: "retry_1",
				request_type: "tool_retry",
				decision_action: "retry",
				reason: "Try again",
			});

			await expect(decisionPromise).resolves.toEqual({
				action: "retry",
				reason: "Try again",
				resolvedBy: "user",
			});

			expect(runtime.getSnapshot().state.pending_tool_retries).toEqual([]);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request" &&
						entry.message.request_type === "tool_retry" &&
						entry.message.request_id === "retry_1"
					);
				}),
			).toBe(true);
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					if (entry.type !== "message") {
						return false;
					}
					return (
						entry.message.type === "server_request_resolved" &&
						entry.message.request_type === "tool_retry" &&
						entry.message.resolution === "retried"
					);
				}),
			).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("streams a snapshot envelope on initial SSE attach", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 4,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const attached = createMockAttachedStream(
			[
				{
					type: "snapshot",
					snapshot,
				},
			],
			{ overflowSnapshot: snapshot },
		);
		const runtime = {
			createImplicitStream: vi.fn().mockReturnValue(attached.stream),
			heartbeat: vi.fn().mockReturnValue({ type: "heartbeat", cursor: 4 }),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"GET",
			"/api/headless/sessions/sess_sse/events",
		);
		const res = new MockResponse();

		handleHeadlessSessionEvents(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_sse" },
		);

		expect(res.headers["Content-Type"]).toBe("text/event-stream");
		expect(res.body).toContain('"type":"snapshot"');
		expect(res.body).toContain('"session_id":"sess_sse"');

		req.emit("close");
		expect(attached.stream.close).toHaveBeenCalledTimes(1);
	});

	it("passes explicit opt-out notifications through subscribe requests", async () => {
		const runtime = {
			createSubscription: vi.fn().mockReturnValue({
				connection_id: "conn_remote",
				subscription_id: "sub_remote",
				opt_out_notifications: ["status", "heartbeat"],
				role: "controller",
				controller_lease_granted: true,
				controller_subscription_id: "sub_remote",
				controller_connection_id: "conn_remote",
				lease_expires_at: "2026-04-02T00:00:15Z",
				heartbeat_interval_ms: 15000,
				snapshot: {
					protocolVersion: HEADLESS_PROTOCOL_VERSION,
					session_id: "sess_subscribe",
					cursor: 1,
					last_init: null,
					state: createHeadlessRuntimeState(),
				},
			}),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"POST",
			"/api/headless/sessions/sess_subscribe/subscribe",
			{
				optOutNotifications: ["status", "heartbeat"],
			},
		);
		const res = new MockResponse();

		await handleHeadlessSessionSubscribe(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_subscribe" },
		);

		expect(runtime.createSubscription).toHaveBeenCalledWith(
			expect.objectContaining({
				optOutNotifications: ["status", "heartbeat"],
			}),
		);
		expect(res.body).toContain(
			'"opt_out_notifications":["status","heartbeat"]',
		);
	});

	it("rejects explicit SSE attaches with unknown subscription ids before sending headers", () => {
		const runtime = {
			attachSubscription: vi.fn().mockReturnValue(null),
			createImplicitStream: vi.fn(),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"GET",
			"/api/headless/sessions/sess_sse/events?subscriptionId=sub_missing",
		);
		const res = new MockResponse();

		expect(() =>
			handleHeadlessSessionEvents(
				req,
				res as unknown as ServerResponse,
				context,
				{ id: "sess_sse" },
			),
		).toThrowError(ApiError);
		expect(res.headersSent).toBe(false);
		expect(runtime.attachSubscription).toHaveBeenCalledWith("sub_missing");
	});

	it("streams a reset envelope when the requested replay cursor is stale", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 12,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const attached = createMockAttachedStream([
			{
				type: "reset",
				reason: "replay_gap",
				snapshot,
			},
		]);
		const runtime = {
			createImplicitStream: vi.fn().mockReturnValue(attached.stream),
			heartbeat: vi.fn().mockReturnValue({ type: "heartbeat", cursor: 12 }),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"GET",
			"/api/headless/sessions/sess_sse/events?cursor=1",
		);
		const res = new MockResponse();

		handleHeadlessSessionEvents(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_sse" },
		);

		expect(res.body).toContain('"type":"reset"');
		expect(res.body).toContain('"reason":"replay_gap"');
		expect(res.body).toContain('"session_id":"sess_sse"');
	});

	it("passes opt-out notifications through implicit SSE attaches", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 4,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const attached = createMockAttachedStream(
			[
				{
					type: "snapshot",
					snapshot,
				},
			],
			{ overflowSnapshot: snapshot },
		);
		const runtime = {
			createImplicitStream: vi.fn().mockReturnValue(attached.stream),
			heartbeat: vi.fn().mockReturnValue({ type: "heartbeat", cursor: 4 }),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"GET",
			"/api/headless/sessions/sess_sse/events?optOutNotifications=status,heartbeat",
		);
		const res = new MockResponse();

		handleHeadlessSessionEvents(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_sse" },
		);

		expect(runtime.createImplicitStream).toHaveBeenCalledWith(
			expect.objectContaining({
				optOutNotifications: ["status", "heartbeat"],
			}),
		);
		req.emit("close");
	});

	it("coalesces lagged SSE subscribers into a reset envelope", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 4,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const attached = createMockAttachedStream(
			[
				{
					type: "snapshot",
					snapshot,
				},
			],
			{ overflowSnapshot: snapshot },
		);
		const runtime = {
			createImplicitStream: vi.fn().mockReturnValue(attached.stream),
			heartbeat: vi.fn().mockReturnValue({ type: "heartbeat", cursor: 4 }),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"GET",
			"/api/headless/sessions/sess_sse/events",
		);
		const res = new BackpressuredMockResponse();

		handleHeadlessSessionEvents(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_sse" },
		);

		attached.push({
			type: "message",
			cursor: 5,
			message: { type: "status", message: "first" },
		});
		for (let index = 0; index < 130; index += 1) {
			attached.push({
				type: "message",
				cursor: 6 + index,
				message: { type: "status", message: `queued-${index}` },
			});
		}
		res.emit("drain");

		expect(res.body).toContain('"type":"reset"');
		expect(res.body).toContain('"reason":"lagged"');
	});

	it("forwards message posts to the runtime", async () => {
		const runtime = {
			assertCanSend: vi.fn(),
			send: vi.fn().mockResolvedValue(undefined),
		};
		const context = createContext({
			headlessRuntimeService: {
				getRuntime: vi.fn().mockReturnValue(runtime),
			} as unknown as HeadlessRuntimeService,
		});
		const req = createJsonRequest(
			"POST",
			"/api/headless/sessions/sess_123/messages",
			{ type: "interrupt" },
		);
		const res = new MockResponse();
		res.req = req;

		await handleHeadlessSessionMessage(
			req,
			res as unknown as ServerResponse,
			context,
			{ id: "sess_123" },
		);

		expect(runtime.send).toHaveBeenCalledWith(
			{ type: "interrupt" },
			{ connectionId: undefined, subscriptionId: undefined },
		);
		expect(JSON.parse(res.body)).toEqual({ success: true });
	});
});

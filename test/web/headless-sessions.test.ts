import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
	handleHeadlessSessionCreate,
	handleHeadlessSessionEvents,
	handleHeadlessSessionMessage,
} from "../../src/server/handlers/headless-sessions.js";
import {
	HeadlessRuntimeService,
	type HeadlessRuntimeSnapshot,
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
		headlessRuntimeService: new HeadlessRuntimeService(),
		...overrides,
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
			expect(fakeAgent.prompts).toEqual([
				{ content: "Summarize the session", attachments: undefined },
			]);
			expect(snapshot.state.last_status).toBe("Prompt: Summarize the session");

			const replay = runtime.replayFrom(0);
			expect(
				replay?.map((entry) =>
					entry.type === "message" ? entry.message.type : entry.type,
				),
			).toEqual(["ready", "session_info", "status", "status"]);
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
			expect(snapshot.state.connection_role).toBe("controller");

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
				includeVscodeTools: true,
				includeJetBrainsTools: false,
				includeConductorTools: false,
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

	it("rejects viewer headless message posts", async () => {
		const runtime = {
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

	it("streams a snapshot envelope on initial SSE attach", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 4,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const unsubscribe = vi.fn();
		const runtime = {
			getSnapshot: vi.fn().mockReturnValue(snapshot),
			replayFrom: vi.fn().mockReturnValue([]),
			subscribe: vi.fn().mockReturnValue(unsubscribe),
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
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("streams a reset envelope when the requested replay cursor is stale", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 12,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		const runtime = {
			getSnapshot: vi.fn().mockReturnValue(snapshot),
			replayFrom: vi.fn().mockReturnValue(null),
			subscribe: vi.fn().mockReturnValue(vi.fn()),
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

	it("coalesces lagged SSE subscribers into a reset envelope", () => {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "sess_sse",
			cursor: 4,
			last_init: null,
			state: createHeadlessRuntimeState(),
		};
		let listener: ((envelope: unknown) => void) | undefined;
		const runtime = {
			getSnapshot: vi.fn().mockReturnValue(snapshot),
			replayFrom: vi.fn().mockReturnValue([]),
			subscribe: vi.fn().mockImplementation((next) => {
				listener = next;
				return vi.fn();
			}),
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

		listener?.({
			type: "message",
			cursor: 5,
			message: { type: "status", message: "first" },
		});
		for (let index = 0; index < 130; index += 1) {
			listener?.({
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

		expect(runtime.send).toHaveBeenCalledWith({ type: "interrupt" });
		expect(JSON.parse(res.body)).toEqual({ success: true });
	});
});

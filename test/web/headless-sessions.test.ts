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
import {
	handleHeadlessSessionCreate,
	handleHeadlessSessionEvents,
	handleHeadlessSessionMessage,
} from "../../src/server/handlers/headless-sessions.js";
import {
	HeadlessRuntimeService,
	type HeadlessRuntimeSnapshot,
} from "../../src/server/headless-runtime-service.js";
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
			expect(replay?.map((entry) => entry.message.type)).toEqual([
				"ready",
				"session_info",
				"status",
				"status",
			]);
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

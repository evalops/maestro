import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import type { HeadlessFromAgentMessage } from "../../src/cli/headless-protocol.js";
import type { NativeHeadlessClient } from "../../src/server/native-headless-client.js";
import {
	composerHistoryForNative,
	mapApprovalModeForNative,
	mapControllerApprovalModeForNative,
	runNativeWebChatTurn,
	toHeadlessHistoryRole,
	toHeadlessProtocolHistory,
} from "../../src/server/web-native-chat.js";

describe("mapApprovalModeForNative", () => {
	it("preserves explicit auto and fails closed otherwise", () => {
		expect(mapApprovalModeForNative("auto")).toBe("auto");
		expect(mapApprovalModeForNative("fail")).toBe("fail");
		expect(mapApprovalModeForNative("prompt")).toBe("fail");
		expect(mapApprovalModeForNative(undefined)).toBe("fail");
		expect(mapApprovalModeForNative("bogus")).toBe("fail");
	});

	it("preserves prompt for long-lived native controllers", () => {
		expect(mapControllerApprovalModeForNative("auto")).toBe("auto");
		expect(mapControllerApprovalModeForNative("prompt")).toBe("prompt");
		expect(mapControllerApprovalModeForNative("fail")).toBe("fail");
		expect(mapControllerApprovalModeForNative(undefined)).toBe("fail");
	});
});

describe("composerHistoryForNative", () => {
	it("replays prior attachment context but excludes the current turn", () => {
		expect(
			composerHistoryForNative([
				{
					role: "user",
					content: "Review this report",
					attachments: [
						{
							id: "report",
							type: "document",
							fileName: "report.pdf",
							mimeType: "application/pdf",
							size: 42,
							extractedText: "Quarterly revenue increased.",
						},
					],
				},
				{
					role: "assistant",
					content: "I reviewed it.",
				},
				{
					role: "user",
					content: "What changed?",
					attachments: [
						{
							id: "current",
							type: "image",
							fileName: "current.png",
							mimeType: "image/png",
							size: 12,
						},
					],
				},
			]),
		).toEqual([
			{
				role: "user",
				text: "Review this report\n\n[Attachment: report.pdf]\nQuarterly revenue increased.",
			},
			{ role: "assistant", text: "I reviewed it." },
		]);
	});

	it("keeps a reference for prior attachments without extracted text", () => {
		expect(
			composerHistoryForNative([
				{
					role: "user",
					content: "",
					attachments: [
						{
							id: "diagram",
							type: "image",
							fileName: "diagram.png",
							mimeType: "image/png",
							size: 12,
						},
					],
				},
				{ role: "user", content: "Describe it again" },
			]),
		).toEqual([
			{ role: "user", text: "[Attachment: diagram.png (image/png)]" },
		]);
	});
});

describe("toHeadlessProtocolHistory", () => {
	it("maps roles and content for init.history", () => {
		expect(
			toHeadlessProtocolHistory([
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
				{ role: "model", text: "also assistant" },
			]),
		).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
			{ role: "assistant", content: "also assistant" },
		]);
	});

	it("returns undefined for empty history", () => {
		expect(toHeadlessProtocolHistory([])).toBeUndefined();
	});

	it("normalizes free-form roles", () => {
		expect(toHeadlessHistoryRole("User")).toBe("user");
		expect(toHeadlessHistoryRole("MODEL")).toBe("assistant");
		expect(toHeadlessHistoryRole("system")).toBe("system");
		expect(toHeadlessHistoryRole("tool")).toBe("user");
	});
});

type MockClient = EventEmitter & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	hello: ReturnType<typeof vi.fn>;
	init: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	interrupt: ReturnType<typeof vi.fn>;
	isRunning: boolean;
};

function createMockClient(options?: {
	startError?: Error;
	ready?: Record<string, unknown>;
}): MockClient {
	const client = new EventEmitter() as MockClient;
	client.isRunning = false;
	client.stop = vi.fn(() => {
		client.isRunning = false;
	});
	client.hello = vi.fn();
	client.init = vi.fn();
	client.send = vi.fn();
	client.prompt = vi.fn((content: string) => {
		// Simulate a short streaming turn after prompt.
		// Native emits intermediate response_end (LLM round) then sentinel "done".
		queueMicrotask(() => {
			const messages: HeadlessFromAgentMessage[] = [
				{ type: "response_start", response_id: "r1" },
				{
					type: "response_chunk",
					response_id: "r1",
					content: `echo:${content}`,
					is_thinking: false,
				},
				{
					type: "response_end",
					response_id: "r1",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						total_tokens: 2,
						total_cost_usd: 0,
						model_id: "test-model",
						provider: "test",
					},
					tools_summary: {
						tools_used: [],
						calls_succeeded: 0,
						calls_failed: 0,
					},
					duration_ms: 5,
				},
				{
					type: "response_end",
					response_id: "done",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						total_tokens: 0,
						total_cost_usd: 0,
						model_id: "test-model",
						provider: "test",
					},
					tools_summary: {
						tools_used: [],
						calls_succeeded: 0,
						calls_failed: 0,
					},
					duration_ms: 0,
				},
			];
			for (const message of messages) {
				client.emit("message", message);
			}
		});
	});
	client.interrupt = vi.fn();
	client.start = vi.fn(async () => {
		if (options?.startError) {
			throw options.startError;
		}
		client.isRunning = true;
		return (
			options?.ready ?? {
				type: "ready",
				protocol_version: "2026-04-02",
				model: "test-model",
				provider: "test",
				session_id: null,
			}
		);
	});
	return client;
}

describe("runNativeWebChatTurn", () => {
	const clients: MockClient[] = [];

	afterEach(() => {
		for (const client of clients) {
			client.removeAllListeners();
		}
		clients.length = 0;
	});

	it("reports the start phase when start fails", async () => {
		const client = createMockClient({
			startError: new Error("spawn ENOENT"),
		});
		clients.push(client);

		const events: AgentEvent[] = [];
		const result = await runNativeWebChatTurn({
			prompt: "hello",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: (event) => {
				events.push(event);
			},
		});

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ message: "spawn ENOENT" }),
			phase: "start",
		});
		expect(events).toEqual([]);
		expect(client.stop).toHaveBeenCalled();
		expect(client.prompt).not.toHaveBeenCalled();
	});

	it("streams adapted events through onEvent and completes on sentinel response_end done", async () => {
		const client = createMockClient();
		clients.push(client);
		const events: AgentEvent[] = [];
		const onStarted = vi.fn(() => {
			expect(client.prompt).toHaveBeenCalledWith("hi there", undefined);
		});

		const result = await runNativeWebChatTurn({
			prompt: "hi there",
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "low",
			approvalMode: "prompt",
			// Explicit so unit tests do not depend on full prompt resolution.
			systemPrompt: "test-system",
			createClient: () => client as unknown as NativeHeadlessClient,
			onStarted,
			onEvent: (event) => {
				events.push(event);
			},
		});

		expect(result).toEqual({ ok: true });
		expect(onStarted).toHaveBeenCalledWith({ systemPrompt: "test-system" });
		expect(client.hello).toHaveBeenCalledWith({
			clientName: "maestro-web",
			role: "controller",
		});
		expect(client.init).toHaveBeenCalledWith({
			thinking_level: "low",
			approval_mode: "fail",
			system_prompt: "test-system",
		});
		expect(client.prompt).toHaveBeenCalledWith("hi there", undefined);
		expect(client.stop).toHaveBeenCalled();

		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_start");
		expect(types).toContain("message_update");
		expect(types).toContain("message_end");
		expect(types).toContain("agent_end");
	});

	it("does not persist a turn when the native child rejects the prompt", async () => {
		const client = createMockClient();
		clients.push(client);
		client.prompt.mockImplementationOnce(() => {
			throw new Error("stdin closed");
		});
		const onStarted = vi.fn();

		const result = await runNativeWebChatTurn({
			prompt: "not accepted",
			systemPrompt: "test-system",
			createClient: () => client as unknown as NativeHeadlessClient,
			onStarted,
			onEvent: () => {},
		});

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ message: "stdin closed" }),
			phase: "turn",
		});
		expect(onStarted).not.toHaveBeenCalled();
	});

	it("completes pre-prompt policy checks before writing the prompt", async () => {
		const client = createMockClient();
		clients.push(client);
		const onBeforePrompt = vi.fn(() => {
			expect(client.prompt).not.toHaveBeenCalled();
		});

		const result = await runNativeWebChatTurn({
			prompt: "authorized",
			systemPrompt: "test-system",
			createClient: () => client as unknown as NativeHeadlessClient,
			onBeforePrompt,
			onEvent: () => {},
		});

		expect(result).toEqual({ ok: true });
		expect(onBeforePrompt).toHaveBeenCalledOnce();
		expect(client.prompt).toHaveBeenCalledWith("authorized", undefined);
	});

	it("does not write a prompt when pre-prompt policy rejects the turn", async () => {
		const client = createMockClient();
		clients.push(client);
		const onStarted = vi.fn();

		const result = await runNativeWebChatTurn({
			prompt: "denied",
			systemPrompt: "test-system",
			createClient: () => client as unknown as NativeHeadlessClient,
			onBeforePrompt: () => {
				throw new Error("session policy denied");
			},
			onStarted,
			onEvent: () => {},
		});

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ message: "session policy denied" }),
			phase: "turn",
		});
		expect(client.hello).not.toHaveBeenCalled();
		expect(client.init).not.toHaveBeenCalled();
		expect(client.prompt).not.toHaveBeenCalled();
		expect(onStarted).not.toHaveBeenCalled();
	});

	it("buffers native events until post-prompt persistence completes", async () => {
		const client = createMockClient();
		clients.push(client);
		const events: AgentEvent[] = [];
		let finishPersistence: (() => void) | undefined;
		const persistenceReady = new Promise<void>((resolve) => {
			finishPersistence = resolve;
		});

		const turn = runNativeWebChatTurn({
			prompt: "accepted",
			systemPrompt: "test-system",
			createClient: () => client as unknown as NativeHeadlessClient,
			onStarted: () => persistenceReady,
			onEvent: (event) => events.push(event),
		});

		await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
		await Promise.resolve();
		expect(events).toEqual([]);
		finishPersistence?.();
		expect(await turn).toEqual({ ok: true });
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("maps thinkingLevel max → ultra for headless init", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "x",
			thinkingLevel: "max",
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledWith({
			thinking_level: "ultra",
			approval_mode: "fail",
			system_prompt: "",
		});
	});

	it("maps approvalMode fail/prompt to fail for headless init", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "x",
			approvalMode: "fail",
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledWith({
			approval_mode: "fail",
			system_prompt: "",
		});

		const client2 = createMockClient();
		clients.push(client2);
		await runNativeWebChatTurn({
			prompt: "x",
			approvalMode: "prompt",
			systemPrompt: "",
			createClient: () => client2 as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});
		expect(client2.init).toHaveBeenCalledWith({
			approval_mode: "fail",
			system_prompt: "",
		});
	});

	it("defaults approval_mode to fail when approvalMode is omitted", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "x",
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledWith({
			approval_mode: "fail",
			system_prompt: "",
		});
	});

	it("does not auto-approve tool calls", async () => {
		const client = createMockClient();
		clients.push(client);
		client.prompt = vi.fn(() => {
			queueMicrotask(() => {
				client.emit("message", {
					type: "tool_call",
					call_id: "tc-approve-1",
					tool: "bash",
					args: { command: "echo hi" },
					requires_approval: true,
				} satisfies HeadlessFromAgentMessage);
				// Finish turn after approval path has a chance to run.
				queueMicrotask(() => {
					client.emit("message", {
						type: "response_end",
						response_id: "done",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_read_tokens: 0,
							cache_write_tokens: 0,
							total_tokens: 0,
							total_cost_usd: 0,
							model_id: "test-model",
							provider: "test",
						},
						tools_summary: {
							tools_used: ["bash"],
							calls_succeeded: 1,
							calls_failed: 0,
						},
						duration_ms: 0,
					} satisfies HeadlessFromAgentMessage);
				});
			});
		});

		const result = await runNativeWebChatTurn({
			prompt: "run bash",
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(result).toEqual({ ok: true });
		expect(client.send).not.toHaveBeenCalled();
	});

	it("dual-writes structured history for older native binaries", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "what next?",
			history: [
				{ role: "user", text: "first question" },
				{ role: "assistant", text: "first answer" },
			],
			systemPromptAppend: "Be concise.",
			systemPrompt: "base",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledTimes(1);
		const initArg = client.init.mock.calls[0]?.[0] as {
			append_system_prompt?: string;
			system_prompt?: string;
			history?: Array<{ role: string; content: string }>;
		};
		expect(initArg.system_prompt).toBe("base");
		expect(initArg.history).toEqual([
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
		]);
		expect(initArg.append_system_prompt).toBe(
			"## Prior conversation\nUser: first question\nAssistant: first answer\n\nBe concise.",
		);
		expect(client.prompt).toHaveBeenCalledWith("what next?", undefined);
	});

	it("omits history and append_system_prompt when history is empty", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "solo",
			history: [],
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledWith({
			approval_mode: "fail",
			system_prompt: "",
		});
	});

	it("materializes attachments privately and removes them after the turn", async () => {
		const client = createMockClient();
		clients.push(client);
		let observedPath: string | undefined;
		let observedContent: Buffer | undefined;
		const originalPrompt = client.prompt;
		client.prompt = vi.fn((content: string, attachments?: string[]) => {
			observedPath = attachments?.[0];
			if (observedPath) observedContent = readFileSync(observedPath);
			originalPrompt(content, attachments);
		});

		const result = await runNativeWebChatTurn({
			prompt: "inspect",
			attachments: [
				{
					id: "a1",
					type: "document",
					fileName: "../notes.txt",
					mimeType: "text/plain",
					size: 5,
					content: Buffer.from("hello").toString("base64"),
				},
			],
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(result).toEqual({ ok: true });
		expect(observedContent?.toString()).toBe("hello");
		expect(observedPath).toBeDefined();
		expect(existsSync(observedPath as string)).toBe(false);
	});

	it("adds a MIME-derived extension to extensionless image uploads", async () => {
		const client = createMockClient();
		clients.push(client);
		let observedPath: string | undefined;
		const originalPrompt = client.prompt;
		client.prompt = vi.fn((content: string, attachments?: string[]) => {
			observedPath = attachments?.[0];
			originalPrompt(content, attachments);
		});

		const result = await runNativeWebChatTurn({
			prompt: "inspect",
			attachments: [
				{
					id: "image-1",
					type: "image",
					fileName: "blob",
					mimeType: "image/png",
					size: 4,
					content: Buffer.from([0, 1, 2, 3]).toString("base64"),
				},
			],
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(result).toEqual({ ok: true });
		expect(observedPath).toMatch(/0-blob\.png$/);
		expect(existsSync(observedPath as string)).toBe(false);
	});

	it("materializes extracted document text for native attachment loading", async () => {
		const client = createMockClient();
		clients.push(client);
		let observedPath: string | undefined;
		let observedContent: string | undefined;
		const originalPrompt = client.prompt;
		client.prompt = vi.fn((content: string, attachments?: string[]) => {
			observedPath = attachments?.[0];
			if (observedPath) observedContent = readFileSync(observedPath, "utf8");
			originalPrompt(content, attachments);
		});

		const result = await runNativeWebChatTurn({
			prompt: "inspect",
			attachments: [
				{
					id: "a1",
					type: "document",
					fileName: "report.pdf",
					mimeType: "application/pdf",
					size: 4,
					content: Buffer.from([0, 1, 2, 3]).toString("base64"),
					extractedText: "Quarterly revenue increased.",
				},
			],
			systemPrompt: "",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(result).toEqual({ ok: true });
		expect(observedPath).toMatch(/report\.pdf\.txt$/);
		expect(observedContent).toBe(
			"[Document: report.pdf]\nQuarterly revenue increased.",
		);
		expect(existsSync(observedPath as string)).toBe(false);
	});

	it("forwards systemPrompt on headless init", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "x",
			systemPrompt: "You are a concise helper.",
			approvalMode: "auto",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledWith({
			approval_mode: "auto",
			system_prompt: "You are a concise helper.",
		});
	});

	it("resolves Maestro system prompt when systemPrompt is omitted", async () => {
		const client = createMockClient();
		clients.push(client);

		await runNativeWebChatTurn({
			prompt: "x",
			// Empty profile still yields a non-empty bundled Maestro prompt.
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(client.init).toHaveBeenCalledTimes(1);
		const initArg = client.init.mock.calls[0]?.[0] as {
			system_prompt?: string;
		};
		expect(typeof initArg.system_prompt).toBe("string");
		expect(initArg.system_prompt?.length).toBeGreaterThan(0);
	});

	it("reports the turn phase when a turn fails after start", async () => {
		const client = createMockClient();
		clients.push(client);
		client.prompt = vi.fn(() => {
			queueMicrotask(() => {
				client.emit("error", new Error("Fatal headless protocol error: boom"));
			});
		});

		const result = await runNativeWebChatTurn({
			prompt: "x",
			createClient: () => client as unknown as NativeHeadlessClient,
			onEvent: () => {},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.phase).toBe("turn");
			expect(result.error.message).toMatch(/boom|Fatal/);
		}
		expect(client.stop).toHaveBeenCalled();
	});

	it("does not complete on intermediate response_end (tool-loop rounds)", async () => {
		const client = createMockClient();
		clients.push(client);
		client.prompt = vi.fn(() => {
			queueMicrotask(() => {
				client.emit("message", {
					type: "response_start",
					response_id: "r1",
				} satisfies HeadlessFromAgentMessage);
				client.emit("message", {
					type: "response_chunk",
					response_id: "r1",
					content: "calling tool",
					is_thinking: false,
				} satisfies HeadlessFromAgentMessage);
				client.emit("message", {
					type: "response_end",
					response_id: "r1",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						total_tokens: 2,
						total_cost_usd: 0,
						model_id: "test-model",
						provider: "test",
					},
					tools_summary: {
						tools_used: ["bash"],
						calls_succeeded: 0,
						calls_failed: 0,
					},
					duration_ms: 5,
				} satisfies HeadlessFromAgentMessage);
				// Intentionally no "done" yet — turn must stay open.
			});
		});

		const events: AgentEvent[] = [];
		let resolveMessageEnd: (() => void) | undefined;
		const messageEndSeen = new Promise<void>((resolve) => {
			resolveMessageEnd = resolve;
		});
		const turnPromise = runNativeWebChatTurn({
			prompt: "use a tool",
			createClient: () => client as unknown as NativeHeadlessClient,
			turnTimeoutMs: 200,
			onEvent: (event) => {
				events.push(event);
				if (event.type === "message_end") resolveMessageEnd?.();
			},
		});

		await messageEndSeen;
		expect(events.some((e) => e.type === "message_end")).toBe(true);
		expect(events.some((e) => e.type === "agent_end")).toBe(false);
		expect(client.stop).not.toHaveBeenCalled();

		// Finish with sentinel.
		client.emit("message", {
			type: "response_end",
			response_id: "done",
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				total_tokens: 0,
				total_cost_usd: 0,
				model_id: "test-model",
				provider: "test",
			},
			tools_summary: {
				tools_used: ["bash"],
				calls_succeeded: 1,
				calls_failed: 0,
			},
			duration_ms: 0,
		} satisfies HeadlessFromAgentMessage);

		const result = await turnPromise;
		expect(result).toEqual({ ok: true });
		expect(events.some((e) => e.type === "agent_end")).toBe(true);
		expect(client.stop).toHaveBeenCalled();
	});

	it("does not call onStarted when start fails", async () => {
		const client = createMockClient({
			startError: new Error("missing binary"),
		});
		clients.push(client);
		const onStarted = vi.fn();

		await runNativeWebChatTurn({
			prompt: "x",
			createClient: () => client as unknown as NativeHeadlessClient,
			onStarted,
			onEvent: () => {},
		});

		expect(onStarted).not.toHaveBeenCalled();
	});
});

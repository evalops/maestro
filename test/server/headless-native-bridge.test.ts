import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessFromAgentMessage } from "../../src/cli/headless-protocol.js";
import {
	attachNativeHeadlessPublisher,
	isTerminalTurnMessage,
	startNativeHeadlessBackend,
} from "../../src/server/headless-native-bridge.js";
import type { NativeHeadlessClient } from "../../src/server/native-headless-client.js";

type MockClient = EventEmitter & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	hello: ReturnType<typeof vi.fn>;
	init: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
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
	client.prompt = vi.fn();
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
				session_id: "sess-1",
			}
		);
	});
	return client;
}

describe("isTerminalTurnMessage", () => {
	it("treats response_end done/blocked as terminal", () => {
		expect(
			isTerminalTurnMessage({
				type: "response_end",
				response_id: "done",
			} as HeadlessFromAgentMessage),
		).toBe(true);
		expect(
			isTerminalTurnMessage({
				type: "response_end",
				response_id: "blocked",
			} as HeadlessFromAgentMessage),
		).toBe(true);
		expect(
			isTerminalTurnMessage({
				type: "response_end",
				response_id: "r1",
			} as HeadlessFromAgentMessage),
		).toBe(false);
	});

	it("treats fatal errors as terminal", () => {
		expect(
			isTerminalTurnMessage({
				type: "error",
				message: "boom",
				fatal: true,
			} as HeadlessFromAgentMessage),
		).toBe(true);
		expect(
			isTerminalTurnMessage({
				type: "error",
				message: "soft",
				fatal: false,
			} as HeadlessFromAgentMessage),
		).toBe(false);
	});
});

describe("startNativeHeadlessBackend", () => {
	it("starts client, hellos, and inits with system prompt + thinking/approval", async () => {
		const mock = createMockClient();
		const { client, ready } = await startNativeHeadlessBackend({
			cwd: "/tmp/ws",
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "low",
			approvalMode: "prompt",
			systemPrompt: "You are Maestro.",
			createClient: () => mock as unknown as NativeHeadlessClient,
		});

		expect(client).toBe(mock);
		expect(ready).toMatchObject({ type: "ready", model: "test-model" });
		expect(mock.start).toHaveBeenCalledOnce();
		expect(mock.hello).toHaveBeenCalledWith({
			clientName: "maestro-headless-runtime",
			role: "controller",
		});
		expect(mock.init).toHaveBeenCalledWith({
			thinking_level: "low",
			approval_mode: "prompt",
			system_prompt: "You are Maestro.",
		});
	});

	it("resolves Maestro system prompt when systemPrompt is omitted", async () => {
		const mock = createMockClient();
		await startNativeHeadlessBackend({
			cwd: process.cwd(),
			createClient: () => mock as unknown as NativeHeadlessClient,
		});

		expect(mock.init).toHaveBeenCalledTimes(1);
		const initArg = mock.init.mock.calls[0]?.[0] as {
			system_prompt?: string;
		};
		expect(typeof initArg.system_prompt).toBe("string");
		expect(initArg.system_prompt?.length).toBeGreaterThan(0);
	});

	it("propagates start failures", async () => {
		const mock = createMockClient({
			startError: new Error("spawn failed"),
		});
		await expect(
			startNativeHeadlessBackend({
				// Skip prompt resolution on the start-failure path.
				systemPrompt: "",
				createClient: () => mock as unknown as NativeHeadlessClient,
			}),
		).rejects.toThrow("spawn failed");
		expect(mock.stop).toHaveBeenCalledOnce();
	});

	it("stops the native child when post-start initialization fails", async () => {
		const mock = createMockClient();
		mock.init.mockImplementationOnce(() => {
			throw new Error("init failed");
		});

		await expect(
			startNativeHeadlessBackend({
				systemPrompt: "prompt",
				createClient: () => mock as unknown as NativeHeadlessClient,
			}),
		).rejects.toThrow("init failed");
		expect(mock.stop).toHaveBeenCalledOnce();
	});
});

describe("attachNativeHeadlessPublisher", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("publishes protocol messages and idles on terminal response_end", () => {
		const mock = createMockClient();
		const published: HeadlessFromAgentMessage[] = [];
		const onIdle = vi.fn();
		const detach = attachNativeHeadlessPublisher({
			client: mock as unknown as NativeHeadlessClient,
			publish: (msg) => {
				published.push(msg);
			},
			onIdle,
		});
		cleanups.push(detach);

		const intermediate = {
			type: "response_end",
			response_id: "r1",
		} as HeadlessFromAgentMessage;
		const done = {
			type: "response_end",
			response_id: "done",
		} as HeadlessFromAgentMessage;

		mock.emit("message", intermediate);
		expect(published).toEqual([intermediate]);
		expect(onIdle).not.toHaveBeenCalled();

		mock.emit("message", done);
		expect(published).toEqual([intermediate, done]);
		expect(onIdle).toHaveBeenCalledOnce();
	});

	it("ignores parse errors and detaches cleanly", () => {
		const mock = createMockClient();
		const onError = vi.fn();
		const detach = attachNativeHeadlessPublisher({
			client: mock as unknown as NativeHeadlessClient,
			publish: () => {},
			onError,
		});
		cleanups.push(detach);

		mock.emit("error", new Error("Failed to parse headless message: x"));
		expect(onError).not.toHaveBeenCalled();

		mock.emit("error", new Error("Fatal boom"));
		expect(onError).toHaveBeenCalledOnce();

		detach();
		// After detach, no publisher listeners remain — use a no-op listener so
		// Node EventEmitter does not throw "Unhandled error" on emit.
		mock.on("error", () => {});
		mock.emit("error", new Error("after detach"));
		expect(onError).toHaveBeenCalledOnce();
	});
});

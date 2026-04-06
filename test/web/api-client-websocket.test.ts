import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../packages/web/src/services/api-client.js";

declare const global: {
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
};

const originalFetch = global.fetch;
const originalWebSocket = global.WebSocket;

type MockWebSocketEventMap = {
	open: Event;
	close: Event;
	error: Event;
	message: { data: string };
};

class MockWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState = MockWebSocket.OPEN;
	sent: string[] = [];
	private readonly listeners = new Map<
		keyof MockWebSocketEventMap,
		Set<(event: Event | { data: string }) => void>
	>();

	constructor(url: string | URL) {
		this.url = String(url);
		queueMicrotask(() => {
			this.emit("open", {} as Event);
		});
	}

	addEventListener<K extends keyof MockWebSocketEventMap>(
		type: K,
		listener: (event: MockWebSocketEventMap[K]) => void,
	) {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener as (event: Event | { data: string }) => void);
		this.listeners.set(type, set);
	}

	send(payload: string) {
		this.sent.push(payload);
	}

	close() {
		if (this.readyState === MockWebSocket.CLOSED) {
			return;
		}
		this.readyState = MockWebSocket.CLOSED;
		this.emit("close", {} as Event);
	}

	emit<K extends keyof MockWebSocketEventMap>(
		type: K,
		event: MockWebSocketEventMap[K],
	) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

describe("ApiClient websocket chat transport", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		global.fetch = originalFetch;
		global.WebSocket = originalWebSocket;
	});

	it("streams websocket chat events including session updates", async () => {
		const webSockets: MockWebSocket[] = [];
		vi.stubGlobal(
			"WebSocket",
			class extends MockWebSocket {
				constructor(url: string | URL) {
					super(url);
					webSockets.push(this);
				}
			} as unknown as typeof WebSocket,
		);

		const api = new ApiClient("http://localhost:8080");
		api.setTransportPreference("ws");

		const received: Array<Record<string, unknown>> = [];
		const consumePromise = (async () => {
			for await (const event of api.chatWithEvents({
				messages: [{ role: "user", content: "hi" }],
			})) {
				received.push(event as Record<string, unknown>);
			}
		})();

		for (
			let attempt = 0;
			attempt < 20 && webSockets.length === 0;
			attempt += 1
		) {
			await Promise.resolve();
		}
		const ws = webSockets[0];
		expect(ws).toBeDefined();
		expect(ws?.url).toContain("/api/chat/ws?");
		expect(ws?.url).toContain("clientTools=1");
		expect(ws?.url).toContain("slim=1");
		expect(ws?.url).toContain("client=web");

		for (
			let attempt = 0;
			attempt < 20 && (ws?.sent.length ?? 0) === 0;
			attempt += 1
		) {
			await Promise.resolve();
		}
		expect(ws?.sent).toHaveLength(1);
		expect(JSON.parse(ws?.sent[0] ?? "{}")).toMatchObject({
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});

		ws?.emit("message", {
			data: JSON.stringify({ type: "session_update", sessionId: "session-1" }),
		});
		ws?.emit("message", {
			data: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello from websocket" }],
				},
			}),
		});
		ws?.emit("message", {
			data: JSON.stringify({ type: "done" }),
		});
		await consumePromise;

		expect(received).toEqual([
			{ type: "session_update", sessionId: "session-1" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello from websocket" }],
				},
			},
			{ type: "done" },
		]);
		expect(ws?.readyState).toBe(MockWebSocket.CLOSED);
	});

	it("throws when the websocket closes before a done event", async () => {
		const webSockets: MockWebSocket[] = [];
		vi.stubGlobal(
			"WebSocket",
			class extends MockWebSocket {
				constructor(url: string | URL) {
					super(url);
					webSockets.push(this);
				}
			} as unknown as typeof WebSocket,
		);

		const api = new ApiClient("http://localhost:8080");
		api.setTransportPreference("ws");

		const received: Array<Record<string, unknown>> = [];
		const consumePromise = (async () => {
			for await (const event of api.chatWithEvents({
				messages: [{ role: "user", content: "hi" }],
			})) {
				received.push(event as Record<string, unknown>);
			}
		})();

		for (
			let attempt = 0;
			attempt < 20 && webSockets.length === 0;
			attempt += 1
		) {
			await Promise.resolve();
		}
		const ws = webSockets[0];
		expect(ws).toBeDefined();

		ws?.emit("message", {
			data: JSON.stringify({ type: "session_update", sessionId: "session-2" }),
		});
		ws?.close();

		await expect(consumePromise).rejects.toThrow(
			"WebSocket closed before completion",
		);
		expect(received).toEqual([
			{ type: "session_update", sessionId: "session-2" },
		]);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../packages/web/src/services/api-client.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { SseSession, sendSSE } from "../../src/server/sse-session.js";

declare const global: {
	fetch?: typeof fetch;
};

const originalFetch = global.fetch;

const makeSseResponse = (chunks: string[]) => {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};

const makeSseResponseFromSession = (events: AgentEvent[]) => {
	const chunks: string[] = [];
	const res = {
		writable: true,
		writableEnded: false,
		destroyed: false,
		write: (chunk: string) => {
			chunks.push(chunk);
			return true;
		},
		end: vi.fn(),
		flushHeaders: vi.fn(),
	};
	const session = new SseSession(res);
	for (const event of events) {
		sendSSE(session, event);
	}
	session.sendDone();
	return makeSseResponse(chunks);
};

describe("Server -> web SSE reasoning summary stream", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it("parses thinking deltas emitted by the server SSE session", async () => {
		const response = makeSseResponseFromSession([
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "Reasoning summary",
				},
			} as AgentEvent,
		]);

		global.fetch = vi.fn().mockResolvedValue(response);

		const api = new ApiClient("http://localhost:8080");
		const events: AgentEvent[] = [];
		for await (const event of api.chatWithEvents({
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(event);
		}

		const update = events.find((event) => event.type === "message_update");
		expect(update?.assistantMessageEvent?.type).toBe("thinking_delta");
		expect(update?.assistantMessageEvent?.delta).toBe("Reasoning summary");
	});
});

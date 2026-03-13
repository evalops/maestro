import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

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

const makeSseData = (payload: unknown) =>
	`data: ${JSON.stringify(payload)}\n\n`;

describe("ApiClient chat streaming", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		global.fetch = originalFetch;
	});

	it("streams text deltas from message_update events", async () => {
		const events = [
			makeSseData({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hello",
					partial: {
						role: "assistant",
						content: [{ type: "text", text: "Hello" }],
					},
				},
			}),
			makeSseData({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: " world",
					partial: {
						role: "assistant",
						content: [{ type: "text", text: "Hello world" }],
					},
				},
			}),
			"data: [DONE]\n\n",
		];

		global.fetch = vi.fn().mockResolvedValue(makeSseResponse(events));

		const api = new ApiClient("http://localhost:8080");
		const chunks: string[] = [];
		for await (const chunk of api.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual(["Hello", " world"]);
	});

	it("falls back to message_end text when no deltas were streamed", async () => {
		const events = [
			makeSseData({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "No deltas here" }],
				},
			}),
			"data: [DONE]\n\n",
		];

		global.fetch = vi.fn().mockResolvedValue(makeSseResponse(events));

		const api = new ApiClient("http://localhost:8080");
		const chunks: string[] = [];
		for await (const chunk of api.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual(["No deltas here"]);
	});

	it("streams legacy delta events when no message_update deltas were seen", async () => {
		const events = [
			makeSseData({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Legacy" },
			}),
			makeSseData({ type: "text_delta", delta: " text" }),
			"data: [DONE]\n\n",
		];

		global.fetch = vi.fn().mockResolvedValue(makeSseResponse(events));

		const api = new ApiClient("http://localhost:8080");
		const chunks: string[] = [];
		for await (const chunk of api.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual(["Legacy", " text"]);
	});

	it("ignores legacy deltas after message_update streaming begins", async () => {
		const events = [
			makeSseData({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hi",
					partial: {
						role: "assistant",
						content: [{ type: "text", text: "Hi" }],
					},
				},
			}),
			makeSseData({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Legacy" },
			}),
			"data: [DONE]\n\n",
		];

		global.fetch = vi.fn().mockResolvedValue(makeSseResponse(events));

		const api = new ApiClient("http://localhost:8080");
		const chunks: string[] = [];
		for await (const chunk of api.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual(["Hi"]);
	});

	it("uses text_end fallback once and ignores legacy events", async () => {
		const events = [
			makeSseData({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Fallback text" }],
				},
				assistantMessageEvent: {
					type: "text_end",
					contentIndex: 0,
					content: "Fallback text",
					partial: {
						role: "assistant",
						content: [{ type: "text", text: "Fallback text" }],
					},
				},
			}),
			makeSseData({
				type: "text_delta",
				delta: "Legacy",
			}),
			"data: [DONE]\n\n",
		];

		global.fetch = vi.fn().mockResolvedValue(makeSseResponse(events));

		const api = new ApiClient("http://localhost:8080");
		const chunks: string[] = [];
		for await (const chunk of api.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual(["Fallback text"]);
	});

	it("adds centralized auth headers to chat event streaming requests", async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(makeSseResponse(["data: [DONE]\n\n"]));

		const api = new ApiClient("http://localhost:8080", {
			auth: {
				accessToken: "access-token",
				apiKey: "api-key",
				csrfToken: "csrf-token",
			},
		});

		for await (const _event of api.chatWithEvents({
			messages: [{ role: "user", content: "hi" }],
		})) {
			// consume stream
		}

		const [, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
		const headers = new Headers((init as RequestInit).headers);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
		expect(headers.get("x-composer-client-tools")).toBe("1");
		expect(headers.get("x-composer-slim-events")).toBe("1");
	});

	it("uses SSE when WebSocket transport is selected but auth headers are required", async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(makeSseResponse(["data: [DONE]\n\n"]));
		const webSocketSpy = vi.fn();
		vi.stubGlobal("WebSocket", webSocketSpy);

		const api = new ApiClient("http://localhost:8080", {
			auth: { accessToken: "access-token" },
		});
		api.setTransportPreference("ws");

		for await (const _event of api.chatWithEvents({
			messages: [{ role: "user", content: "hi" }],
		})) {
			// consume stream
		}

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(webSocketSpy).not.toHaveBeenCalled();
	});

	it("does not fall back to WebSocket after SSE startup failure when auth headers are required", async () => {
		const sseError = new Error("sse failed");
		global.fetch = vi.fn().mockRejectedValue(sseError);
		const webSocketSpy = vi.fn();
		vi.stubGlobal("WebSocket", webSocketSpy);

		const api = new ApiClient("http://localhost:8080", {
			auth: { apiKey: "api-key" },
		});

		await expect(
			(async () => {
				for await (const _event of api.chatWithEvents({
					messages: [{ role: "user", content: "hi" }],
				})) {
					// consume stream
				}
			})(),
		).rejects.toThrow("sse failed");
		expect(webSocketSpy).not.toHaveBeenCalled();
	});
});

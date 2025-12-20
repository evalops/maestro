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
});

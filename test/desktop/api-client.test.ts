import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../packages/desktop/src/renderer/lib/api-client";

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

describe("desktop api client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it("sends both composer and maestro headers for streaming chat", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeSseResponse(["data: [DONE]\n\n"]));
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		for await (const _event of client.chat({
			messages: [{ role: "user", content: "hi" }],
		})) {
			// drain stream
		}

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-csrf")).toBe("maestro-desktop-csrf");
		expect(headers.get("x-maestro-csrf")).toBe("maestro-desktop-csrf");
		expect(headers.get("x-composer-slim-events")).toBe("1");
		expect(headers.get("x-maestro-slim-events")).toBe("1");
	});

	it("sends both csrf header variants for JSON writes", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: "claude", name: "Claude" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.setModel("claude");

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-csrf")).toBe("maestro-desktop-csrf");
		expect(headers.get("x-maestro-csrf")).toBe("maestro-desktop-csrf");
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

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

describe("vscode api client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it("sends composer and maestro client headers for chat streams", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeSseResponse(["data: [DONE]\n\n"]));
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		for await (const _event of client.chatWithEvents({
			messages: [{ role: "user", content: "hi" }],
		})) {
			// drain stream
		}

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-client")).toBe("vscode");
		expect(headers.get("x-maestro-client")).toBe("vscode");
		expect(headers.get("x-composer-client-tools")).toBe("1");
		expect(headers.get("x-maestro-client-tools")).toBe("1");
		expect(headers.get("x-composer-slim-events")).toBe("1");
		expect(headers.get("x-maestro-slim-events")).toBe("1");
	});

	it("sends composer and maestro client headers for approval writes", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.submitApproval("approval-1", "approved");

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-client")).toBe("vscode");
		expect(headers.get("x-maestro-client")).toBe("vscode");
	});
});

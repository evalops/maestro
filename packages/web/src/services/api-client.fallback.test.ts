import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

declare const global: {
	window?: { location: { origin: string } };
	fetch?: typeof fetch;
};

const makeJsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const makeNoContentResponse = () =>
	new Response(null, {
		status: 204,
	});

const originalWindow = global.window;
const originalFetch = global.fetch;

describe("ApiClient fallback resolution", () => {
	beforeEach(() => {
		// Provide a window origin so fallbacks include both origin and localhost.
		global.window = { location: { origin: "https://app.test" } };
	});

	afterEach(() => {
		vi.restoreAllMocks();
		global.window = originalWindow;
		global.fetch = originalFetch;
	});

	it("falls back to secondary base when the primary fetch fails", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("primary failed"))
			.mockResolvedValueOnce(
				makeJsonResponse({ id: "m", provider: "p", name: "Model M" }),
			);

		global.fetch = fetchMock;

		const api = new ApiClient();
		const model = await api.getCurrentModel();

		expect(model?.id).toBe("m");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]![0])).toContain("https://app.test");
		expect(String(fetchMock.mock.calls[1]![0])).toContain(
			"http://localhost:8080",
		);
	});

	it("short-circuits fallback retries on non-retriable 4xx responses", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
		);

		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test");
		const model = await api.getCurrentModel();

		expect(model).toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]![0])).toContain("https://app.test");
	});

	it("retries JSON write requests across fallback bases", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("primary failed"))
			.mockResolvedValueOnce(makeNoContentResponse());

		global.fetch = fetchMock;

		const api = new ApiClient();
		await api.setModel("claude-opus");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]![0])).toContain("https://app.test");
		expect(String(fetchMock.mock.calls[1]![0])).toContain(
			"http://localhost:8080",
		);

		for (const call of fetchMock.mock.calls) {
			const init = call[1] as RequestInit;
			const headers = new Headers(init.headers);
			expect(init.method).toBe("POST");
			expect(headers.get("content-type")).toBe("application/json");
			expect(init.body).toBe(JSON.stringify({ model: "claude-opus" }));
		}
	});

	it("uses the shared JSON helper for session creation", async () => {
		const session = {
			id: "session-1",
			title: "Refactor",
			createdAt: "2026-03-12T00:00:00.000Z",
			updatedAt: "2026-03-12T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		};
		const fetchMock = vi.fn().mockResolvedValueOnce(makeJsonResponse(session));

		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test");
		const created = await api.createSession("Refactor");

		expect(created).toEqual(session);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(init.method).toBe("POST");
		expect(headers.get("content-type")).toBe("application/json");
		expect(init.body).toBe(JSON.stringify({ title: "Refactor" }));
	});

	it("preserves complex JSON payloads for branch creation", async () => {
		const branchResponse = {
			success: true,
			newSessionId: "branch-session",
			newSessionFile: "/tmp/branch-session.jsonl",
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeJsonResponse(branchResponse));

		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test");
		const branch = await api.createBranch("session-1", {
			messageIndex: 7,
			userMessageNumber: 3,
		});

		expect(branch).toEqual(branchResponse);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(init.method).toBe("POST");
		expect(headers.get("content-type")).toBe("application/json");
		expect(init.body).toBe(
			JSON.stringify({
				sessionId: "session-1",
				messageIndex: 7,
				userMessageNumber: 3,
			}),
		);
	});
});

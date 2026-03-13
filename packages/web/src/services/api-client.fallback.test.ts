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

const originalWindow = global.window;
const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;

describe("ApiClient fallback resolution", () => {
	beforeEach(() => {
		// Provide a window origin so fallbacks include both origin and localhost.
		global.window = { location: { origin: "https://app.test" } };
	});

	afterEach(() => {
		vi.restoreAllMocks();
		global.window = originalWindow;
		global.fetch = originalFetch;
		URL.createObjectURL = originalCreateObjectURL;
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

	it("injects auth, api key, and csrf headers into JSON requests", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(makeNoContentResponse());

		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test", {
			auth: {
				accessToken: "access-token",
				apiKey: "api-key",
				csrfToken: "csrf-token",
			},
		});
		await api.setModel("claude-opus");

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("x-composer-api-key")).toBe("api-key");
		expect(headers.get("x-composer-csrf")).toBe("csrf-token");
	});

	it("bootstraps auth-aware artifact viewer blobs when header auth is required", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				makeJsonResponse({
					token: "artifact-token",
					expiresAt: "2026-03-13T00:00:00.000Z",
					actions: ["view", "file", "events", "zip"],
					sessionId: "session-1",
					filename: "preview.html",
				}),
			)
			.mockResolvedValueOnce(
				new Response("<html><body>viewer</body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);
		URL.createObjectURL = vi.fn().mockReturnValue("blob:artifact-viewer");

		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test", {
			auth: { accessToken: "access-token" },
		});
		const url = await api.resolveSessionArtifactViewUrl(
			"session-1",
			"preview.html",
		);

		expect(url).toBe("blob:artifact-viewer");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]![0])).toBe(
			"https://app.test/api/sessions/session-1/artifact-access?actions=view%2Cfile%2Cevents%2Czip&filename=preview.html",
		);
		expect(String(fetchMock.mock.calls[1]![0])).toBe(
			"https://app.test/api/sessions/session-1/artifacts/preview.html/view",
		);
		const accessInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const accessHeaders = new Headers(accessInit.headers);
		expect(accessHeaders.get("authorization")).toBe("Bearer access-token");
		const artifactInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
		const artifactHeaders = new Headers(artifactInit.headers);
		expect(artifactHeaders.get("authorization")).toBe("Bearer access-token");
		expect(artifactHeaders.get("x-composer-artifact-access")).toBe(
			"artifact-token",
		);
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
	});

	it("keeps direct artifact zip urls when header auth is not required", async () => {
		const fetchMock = vi.fn();
		global.fetch = fetchMock;

		const api = new ApiClient("https://app.test");
		const url = await api.resolveSessionArtifactsZipUrl("session-1");

		expect(url).toBe("https://app.test/api/sessions/session-1/artifacts.zip");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back across base URLs when chat streaming startup fails", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("primary failed"))
			.mockResolvedValueOnce(makeSseResponse(["data: [DONE]\n\n"]));

		global.fetch = fetchMock;

		const api = new ApiClient();
		for await (const _event of api.chatWithEvents({
			messages: [{ role: "user", content: "hi" }],
		})) {
			// consume stream
		}

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]![0])).toContain(
			"https://app.test/api/chat",
		);
		expect(String(fetchMock.mock.calls[1]![0])).toContain(
			"http://localhost:8080/api/chat",
		);
	});

	it("preserves setModel fallback retries for non-ok primary responses", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "Not found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(makeNoContentResponse());

		global.fetch = fetchMock;

		const api = new ApiClient();
		await api.setModel("claude-opus");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]![0])).toContain("https://app.test");
		expect(String(fetchMock.mock.calls[1]![0])).toContain(
			"http://localhost:8080",
		);
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

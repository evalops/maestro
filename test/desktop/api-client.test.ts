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

const makeJsonResponse = (payload: unknown) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

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

	it("encodes memory topic names in read requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				topic: "api design",
				memories: [],
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.listMemoryTopic("api design");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/memory?action=list&topic=api%20design",
		);
	});

	it("includes session id in scoped memory read requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				topics: [],
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.listMemoryTopics("sess_123");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/memory?action=list&sessionId=sess_123",
		);
	});

	it("posts memory writes with csrf headers and request payload", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				success: true,
				message: 'Memory saved to topic "api-design"',
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.saveMemory(
			"api-design",
			"Use REST conventions",
			["rest"],
			"sess_123",
		);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/memory",
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.body).toBe(
			JSON.stringify({
				action: "save",
				topic: "api-design",
				content: "Use REST conventions",
				tags: ["rest"],
				sessionId: "sess_123",
			}),
		);
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-csrf")).toBe("maestro-desktop-csrf");
		expect(headers.get("x-maestro-csrf")).toBe("maestro-desktop-csrf");
	});

	it("loads repo-scoped team memory status", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				available: true,
				status: {
					gitRoot: "/repo",
					projectId: "proj123",
					projectName: "maestro",
					directory: "/repo/.maestro/team-memory",
					entrypoint: "/repo/.maestro/team-memory/MEMORY.md",
					exists: true,
					fileCount: 1,
					files: ["MEMORY.md"],
				},
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.getTeamMemoryStatus();

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/memory?action=team",
		);
	});

	it("posts team memory initialization requests with csrf headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				success: true,
				message: "Team memory ready at /repo/.maestro/team-memory/MEMORY.md",
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		await client.initTeamMemory();

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/memory",
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.body).toBe(JSON.stringify({ action: "team-init" }));
		const headers = new Headers(init.headers);
		expect(headers.get("x-composer-csrf")).toBe("maestro-desktop-csrf");
		expect(headers.get("x-maestro-csrf")).toBe("maestro-desktop-csrf");
	});

	it("loads the Magic Docs automation template", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeJsonResponse({
				magicDocs: [
					{
						path: "docs/architecture.md",
						title: "Architecture",
					},
				],
				template: {
					name: "Magic Docs Sync",
					prompt: "Update the docs",
					contextPaths: ["docs/architecture.md"],
				},
			}),
		);
		global.fetch = fetchMock;

		const client = new ApiClient("http://localhost:8080");
		const response = await client.getMagicDocsAutomationTemplate();

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/automations/magic-docs",
		);
		expect(response.template?.contextPaths).toEqual(["docs/architecture.md"]);
	});
});

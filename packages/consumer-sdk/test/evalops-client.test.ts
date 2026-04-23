import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvalOpsTransport } from "../src/http.js";
import { EvalOpsClient } from "../src/index.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("EvalOpsClient", () => {
	beforeEach(() => {
		vi.stubEnv("EVALOPS_BASE_URL", "https://evalops.test/");
		vi.stubEnv("EVALOPS_TOKEN", "token-123");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("uses env config and bearer auth for service requests", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				jsonResponse({ id: "user_1", email: "dev@example.com" }),
			);
		const client = EvalOpsClient.fromEnv({ fetch: fetchMock });

		await expect(client.identity.getProfile()).resolves.toMatchObject({
			id: "user_1",
		});

		expect(client.baseUrl).toBe("https://evalops.test");
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://evalops.test/identity.v1.IdentityService/GetProfile",
		);
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer token-123",
			"Content-Type": "application/json",
		});
	});

	it("caches read-style calls for the configured TTL", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				jsonResponse({ skills: [{ id: "skill_1", name: "review" }] }),
			);
		const client = new EvalOpsClient({
			baseUrl: "https://evalops.test",
			fetch: fetchMock,
			cacheTtlMs: 30_000,
		});

		await client.skills.list({ workspaceId: "workspace_1" });
		await client.skills.list({ workspaceId: "workspace_1" });

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(client.getMetrics()).toMatchObject({
			requests: 2,
			cacheHits: 1,
		});
	});

	it("prunes expired entries when later cacheable requests use different keys", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-20T19:00:00.000Z"));
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_url) => jsonResponse({ ok: true }));
		const transport = new EvalOpsTransport({
			baseUrl: "https://evalops.test",
			fetch: fetchMock,
			cacheTtlMs: 1_000,
		});
		const cacheView = transport as unknown as {
			cache: Map<string, unknown>;
		};

		await transport.request({
			service: "traces",
			operation: "get",
			path: "/traces.v1.TracesService/Get/trace-1",
			cache: true,
		});
		expect(cacheView.cache.size).toBe(1);

		vi.advanceTimersByTime(1_001);
		await transport.request({
			service: "traces",
			operation: "get",
			path: "/traces.v1.TracesService/Get/trace-2",
			cache: true,
		});

		expect(cacheView.cache.size).toBe(1);
		expect(Array.from(cacheView.cache.keys())[0]).toContain("trace-2");
	});

	it("evicts least recently used entries when the cache reaches its max size", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_url) => jsonResponse({ ok: true }));
		const transport = new EvalOpsTransport({
			baseUrl: "https://evalops.test",
			fetch: fetchMock,
			cacheMaxEntries: 2,
		});
		const cacheView = transport as unknown as {
			cache: Map<string, unknown>;
		};

		for (const traceId of ["trace-1", "trace-2", "trace-1", "trace-3"]) {
			await transport.request({
				service: "traces",
				operation: "get",
				path: `/traces.v1.TracesService/Get/${traceId}`,
				cache: true,
			});
		}

		const keys = Array.from(cacheView.cache.keys()).join("\n");
		expect(cacheView.cache.size).toBe(2);
		expect(keys).toContain("trace-1");
		expect(keys).toContain("trace-3");
		expect(keys).not.toContain("trace-2");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("returns offline fallbacks and records metrics when downstream fails", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("network unavailable"));
		const client = new EvalOpsClient({
			baseUrl: "https://evalops.test",
			fetch: fetchMock,
		});

		await expect(client.connectors.list()).resolves.toEqual({
			connectors: [],
			offline: true,
			reason: "network unavailable",
		});

		expect(client.getMetrics()).toMatchObject({
			requests: 1,
			fallbacks: 1,
			fallbacksByService: {
				connectors: 1,
			},
			lastFallback: {
				service: "connectors",
				operation: "list",
				reason: "network unavailable",
			},
		});
	});

	it("throws downstream errors when offline fallback is disabled", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("network unavailable"));
		const client = new EvalOpsClient({
			baseUrl: "https://evalops.test",
			fetch: fetchMock,
			offlineFallback: false,
		});

		await expect(client.connectors.list()).rejects.toThrow(
			"network unavailable",
		);
		expect(client.getMetrics()).toMatchObject({
			requests: 1,
			fallbacks: 0,
		});
	});
});

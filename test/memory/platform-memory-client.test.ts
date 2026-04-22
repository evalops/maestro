import { describe, expect, it, vi } from "vitest";
import { MemoryClient } from "../../src/memory/platform-memory-client.js";

describe("platform memory client", () => {
	it("preserves zero list pagination fields from the memory service", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					limit: 0,
					memories: [],
					offset: 0,
					total: 0,
				}),
				{ status: 200 },
			);
		});
		const client = new MemoryClient({
			accessToken: "memory-token",
			baseUrl: "https://memory.test",
			fetch: fetchMock,
			organizationId: "org_123",
		});

		await expect(client.list()).resolves.toEqual({
			limit: 0,
			memories: [],
			offset: 0,
			total: 0,
		});
	});

	it("preserves a zero recall total from the memory service", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					memories: [],
					total: 0,
				}),
				{ status: 200 },
			);
		});
		const client = new MemoryClient({
			accessToken: "memory-token",
			baseUrl: "https://memory.test",
			fetch: fetchMock,
			organizationId: "org_123",
		});

		await expect(client.recall({ query: "empty result" })).resolves.toEqual({
			memories: [],
			total: 0,
		});
	});
});

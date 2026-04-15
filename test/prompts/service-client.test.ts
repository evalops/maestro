import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePromptTemplate } from "../../src/prompts/service-client.js";

describe("prompts service client", () => {
	beforeEach(() => {
		process.env.PROMPTS_SERVICE_URL = "http://prompts.test/";
		process.env.PROMPTS_SERVICE_TOKEN = "prompts-token";
		process.env.PROMPTS_SERVICE_ORGANIZATION_ID = "org_123";
		process.env.PROMPTS_SERVICE_TIMEOUT_MS = "2400";
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		delete process.env.PROMPTS_SERVICE_URL;
		delete process.env.PROMPTS_SERVICE_TOKEN;
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		delete process.env.PROMPTS_SERVICE_TIMEOUT_MS;
		vi.unstubAllGlobals();
	});

	it("resolves a prompt version with org-scoped headers", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://prompts.test/v1/resolve?name=maestro-system&env=production&surface=maestro",
			);
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({
				Authorization: "Bearer prompts-token",
				"X-Organization-ID": "org_123",
			});
			return new Response(
				JSON.stringify({
					version: {
						id: "ver_7",
						version: 7,
						content: "Resolved system instructions",
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await resolvePromptTemplate({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
		});

		expect(result).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 7,
			versionId: "ver_7",
			content: "Resolved system instructions",
		});
	});

	it("returns null when there is no active prompt deployment", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();
	});

	it("returns null when prompt service configuration throws before fetch", async () => {
		process.env.PROMPTS_SERVICE_URL = "not a url";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePromptTemplate } from "../../src/prompts/service-client.js";

describe("prompts service client", () => {
	beforeEach(() => {
		process.env.PROMPTS_SERVICE_URL = "http://prompts.test/";
		process.env.PROMPTS_SERVICE_TOKEN = "prompts-token";
		process.env.PROMPTS_SERVICE_ORGANIZATION_ID = "org_123";
		process.env.PROMPTS_SERVICE_TIMEOUT_MS = "2400";
		process.env.PROMPTS_SERVICE_MAX_ATTEMPTS = "2";
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		delete process.env.PROMPTS_SERVICE_URL;
		delete process.env.PROMPTS_SERVICE_TOKEN;
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		delete process.env.PROMPTS_SERVICE_TIMEOUT_MS;
		delete process.env.PROMPTS_SERVICE_MAX_ATTEMPTS;
		delete process.env.PROMPTS_SERVICE_TRANSPORT;
		delete process.env.MAESTRO_PLATFORM_BASE_URL;
		delete process.env.MAESTRO_PROMPTS_SERVICE_URL;
		delete process.env.MAESTRO_PROMPTS_SERVICE_TOKEN;
		delete process.env.MAESTRO_PROMPTS_ORGANIZATION_ID;
		delete process.env.MAESTRO_EVALOPS_ACCESS_TOKEN;
		delete process.env.MAESTRO_EVALOPS_ORG_ID;
		delete process.env.MAESTRO_HOME;
		delete process.env.EVALOPS_TOKEN;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("resolves a prompt version with org-scoped headers", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://prompts.test/v1/resolve?name=maestro-system&env=production&surface=maestro",
			);
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer prompts-token",
					"X-Organization-ID": "org_123",
				}),
			);
			expect(init?.headers).not.toEqual(
				expect.objectContaining({ "Content-Type": "application/json" }),
			);
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

	it("retries legacy REST prompt resolution based on configured attempts", async () => {
		const fetchMock = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockRejectedValueOnce(new Error("temporary network failure"))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						version: {
							id: "ver_retry_8",
							version: 8,
							content: "Resolved after retry",
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await resolvePromptTemplate({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 8,
			versionId: "ver_retry_8",
			content: "Resolved after retry",
		});
	});

	it("resolves prompt versions through the shared Platform Connect endpoint", async () => {
		delete process.env.PROMPTS_SERVICE_URL;
		delete process.env.PROMPTS_SERVICE_TOKEN;
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		process.env.PROMPTS_SERVICE_TRANSPORT = "connect";
		process.env.MAESTRO_PLATFORM_BASE_URL = "http://platform.test/";
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "platform-token";
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_platform";

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://platform.test/prompts.v1.PromptService/Resolve",
			);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer platform-token",
					"Connect-Protocol-Version": "1",
					"Content-Type": "application/json",
					"X-Organization-ID": "org_platform",
				}),
			);
			expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			});
			return new Response(
				JSON.stringify({
					version: {
						id: "ver_platform_9",
						version: 9,
						content: "Platform resolved system instructions",
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
			version: 9,
			versionId: "ver_platform_9",
			content: "Platform resolved system instructions",
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

	it("warns when configured prompt service is missing an organization id", async () => {
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Prompts service configured without organization id",
			),
		);
	});

	it("warns when configured prompt service is missing an access token", async () => {
		delete process.env.PROMPTS_SERVICE_TOKEN;
		process.env.MAESTRO_HOME = "/tmp/maestro-prompts-test-no-oauth";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Prompts service configured without access token",
			),
		);
	});
});

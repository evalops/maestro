import { describe, expect, it } from "vitest";
import {
	checkModelRequestUrlPolicy,
	validateCustomHeaders,
	validateCustomModelBaseUrl,
	validateCustomModelConfigUrls,
} from "../../src/models/url-policy.js";

describe("custom model URL policy", () => {
	it("rejects non-HTTPS public base URLs by default", () => {
		expect(() =>
			validateCustomModelBaseUrl(
				"http://api.example.com/v1",
				{},
				{
					providerId: "custom",
					field: "baseUrl",
				},
			),
		).toThrow(/https/);
	});

	it("rejects embedded URL credentials", () => {
		expect(() =>
			validateCustomModelBaseUrl(
				"https://user:pass@api.example.com/v1",
				{},
				{
					providerId: "custom",
					field: "baseUrl",
				},
			),
		).toThrow(/embedded credentials/);
	});

	it("rejects internal hosts unless explicitly allowlisted", () => {
		for (const baseUrl of [
			"http://localhost:11434/v1",
			"http://127.0.0.1:1234/v1",
			"http://10.0.0.5/v1",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]:11434/v1",
		]) {
			expect(() =>
				validateCustomModelBaseUrl(
					baseUrl,
					{},
					{
						providerId: "custom",
						field: "baseUrl",
					},
				),
			).toThrow(/internal host/);
		}
	});

	it("allows exact internal URL prefixes listed in internalBaseUrlAllowList", () => {
		expect(() =>
			validateCustomModelBaseUrl(
				"http://localhost:11434/v1/chat/completions",
				{ internalBaseUrlAllowList: ["http://localhost:11434/v1"] },
				{
					providerId: "ollama",
					field: "baseUrl",
				},
			),
		).not.toThrow();
	});

	it("uses strict origin and path-prefix semantics for allowedBaseUrls", () => {
		const policy = { allowedBaseUrls: ["https://api.openai.com/v1"] };
		expect(() =>
			validateCustomModelBaseUrl(
				"https://api.openai.com/v1/chat/completions",
				policy,
				{ providerId: "openai", field: "baseUrl" },
			),
		).not.toThrow();
		expect(() =>
			validateCustomModelBaseUrl(
				"https://api.openai.com.evil.test/v1/chat/completions",
				policy,
				{ providerId: "openai", field: "baseUrl" },
			),
		).toThrow(/allowedBaseUrls/);
		expect(() =>
			validateCustomModelBaseUrl("https://api.openai.com/v10", policy, {
				providerId: "openai",
				field: "baseUrl",
			}),
		).toThrow(/allowedBaseUrls/);
	});

	it("rejects reserved upstream-control headers", () => {
		for (const headerName of [
			"Authorization",
			"Host",
			"Cookie",
			"X-Forwarded-For",
			"X-Real-IP",
			// Provider-specific credential headers
			"x-api-key",
			"anthropic-api-key",
			"openai-organization",
			"x-goog-api-key",
			// Suffix-driven match: any *-api-key / *-token header
			"acme-api-key",
			"acme-auth-token",
			"vendor-token",
		]) {
			expect(() =>
				validateCustomHeaders(
					{ [headerName]: "value" },
					{
						providerId: "custom",
						field: "headers",
					},
				),
			).toThrow(/reserved header/);
		}
	});

	it("rejects base URLs that carry a query string or fragment", () => {
		const policy = { allowedBaseUrls: ["https://api.example.com/v1"] };

		expect(() =>
			validateCustomModelBaseUrl(
				"https://api.example.com/v1/chat?api_key=leak",
				policy,
				{ providerId: "custom", field: "baseUrl" },
			),
		).toThrow(/query string or fragment/);

		expect(() =>
			validateCustomModelBaseUrl(
				"https://api.example.com/v1/chat#frag",
				policy,
				{ providerId: "custom", field: "baseUrl" },
			),
		).toThrow(/query string or fragment/);
	});

	it("validates provider and model URL/header policy together", () => {
		expect(() =>
			validateCustomModelConfigUrls({
				allowedBaseUrls: ["https://api.example.com/v1"],
				providers: [
					{
						id: "custom",
						api: "openai-responses",
						baseUrl: "https://api.example.com/v1/responses",
						headers: { Authorization: "Bearer attacker" },
						models: [],
					},
				],
			}),
		).toThrow(/reserved header/);
	});

	it("blocks hostnames that resolve to private addresses at request time", async () => {
		const result = await checkModelRequestUrlPolicy("https://llm.example/v1", {
			lookup: async () => [{ address: "10.0.0.5", family: 4 }],
		});

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("dns_resolved_internal");
		expect(result.resolvedAddresses).toEqual(["10.0.0.5"]);
	});

	it("returns resolved public addresses so callers can pin the checked socket", async () => {
		const result = await checkModelRequestUrlPolicy("https://llm.example/v1", {
			lookup: async () => [{ address: "203.0.113.10", family: 4 }],
		});

		expect(result.allowed).toBe(true);
		expect(result.hostname).toBe("llm.example");
		expect(result.resolvedAddresses).toEqual(["203.0.113.10"]);
	});

	it("blocks hostnames when DNS resolution returns no addresses", async () => {
		const result = await checkModelRequestUrlPolicy("https://llm.example/v1", {
			lookup: async () => [],
		});

		expect(result).toMatchObject({
			allowed: false,
			reason: "dns_resolution_failed",
			hostname: "llm.example",
			resolvedAddresses: [],
		});
	});

	it("applies allowlist and https rules at request time", async () => {
		await expect(
			checkModelRequestUrlPolicy("http://api.example.com/v1", {
				policy: {
					allowedBaseUrls: ["https://trusted.example/v1"],
				},
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "insecure_protocol",
		});

		await expect(
			checkModelRequestUrlPolicy("https://attacker.example/v1", {
				policy: {
					allowedBaseUrls: ["https://trusted.example/v1"],
				},
				lookup: async () => [{ address: "203.0.113.20", family: 4 }],
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "not_in_allowed_base_urls",
		});
	});

	it("re-checks internal redirects against internalBaseUrlAllowList prefixes", async () => {
		await expect(
			checkModelRequestUrlPolicy("http://localhost:11434/other", {
				allowInternalBaseUrl: true,
				policy: {
					internalBaseUrlAllowList: ["http://localhost:11434/v1"],
				},
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "internal_host",
		});
	});

	it("fails closed when request-time public allowlist parsing hits invalid config", async () => {
		await expect(
			checkModelRequestUrlPolicy("https://trusted.example/v1", {
				policy: {
					allowedBaseUrls: ["notaurl"],
				},
				lookup: async () => [{ address: "203.0.113.20", family: 4 }],
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "invalid_url",
			hostname: "trusted.example",
		});
	});

	it("fails closed when request-time internal allowlist parsing hits invalid config", async () => {
		await expect(
			checkModelRequestUrlPolicy("http://localhost:11434/v1/chat", {
				allowInternalBaseUrl: true,
				internalBaseUrl: "http://localhost:11434/v1",
				policy: {
					internalBaseUrlAllowList: ["notaurl"],
				},
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "invalid_url",
			hostname: "localhost",
		});
	});

	it("does not reuse internal base URL allowance for DNS-rebound public hosts", async () => {
		await expect(
			checkModelRequestUrlPolicy("https://redirect.example/v1", {
				allowInternalBaseUrl: true,
				internalBaseUrl: "http://localhost:11434/v1",
				lookup: async () => [{ address: "10.0.0.5", family: 4 }],
			}),
		).resolves.toMatchObject({
			allowed: false,
			reason: "dns_resolved_internal",
			resolvedAddresses: ["10.0.0.5"],
		});
	});

	it("allows DNS-resolved internal addresses only for the configured internal base", async () => {
		await expect(
			checkModelRequestUrlPolicy("http://localhost:11434/v1/chat", {
				allowInternalBaseUrl: true,
				internalBaseUrl: "http://localhost:11434/v1",
				policy: {
					internalBaseUrlAllowList: ["http://localhost:11434/v1"],
				},
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			}),
		).resolves.toMatchObject({
			allowed: true,
			resolvedAddresses: ["127.0.0.1"],
		});
	});
});

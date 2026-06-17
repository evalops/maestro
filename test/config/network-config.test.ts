import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Provider Network Config", () => {
	const testDir = join(tmpdir(), `composer-network-test-${Date.now()}`);
	const originalEnv = { ...process.env };
	const originalHome = process.env.HOME;

	beforeEach(() => {
		// Reset environment
		Reflect.deleteProperty(process.env, "MAESTRO_PROVIDER_TIMEOUT_MS");
		Reflect.deleteProperty(process.env, "MAESTRO_PROVIDER_MAX_RETRIES");
		Reflect.deleteProperty(process.env, "MAESTRO_STREAM_MAX_RETRIES");
		Reflect.deleteProperty(process.env, "MAESTRO_STREAM_IDLE_TIMEOUT_MS");

		// Create test directory and set HOME
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		process.env.HOME = testDir;

		// Clear module cache to reset config
		vi.resetModules();
	});

	afterEach(() => {
		// Restore environment
		process.env = { ...originalEnv };
		process.env.HOME = originalHome;

		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("getProviderNetworkConfig", () => {
		it("should return default config when no overrides", async () => {
			const { getProviderNetworkConfig, clearNetworkConfigCache } =
				await import("../../src/providers/network-config.js");
			clearNetworkConfigCache();

			const config = getProviderNetworkConfig("anthropic");

			expect(config.timeout).toBe(120_000);
			expect(config.maxRetries).toBe(3);
			expect(config.streamMaxRetries).toBe(5);
			expect(config.streamIdleTimeout).toBe(300_000);
			expect(config.backoffInitial).toBe(1_000);
			expect(config.backoffMax).toBe(30_000);
			expect(config.backoffMultiplier).toBe(2);
		});

		it("should apply global environment overrides", async () => {
			process.env.MAESTRO_PROVIDER_TIMEOUT_MS = "60000";
			process.env.MAESTRO_PROVIDER_MAX_RETRIES = "5";

			const { getProviderNetworkConfig, clearNetworkConfigCache } =
				await import("../../src/providers/network-config.js");
			clearNetworkConfigCache();

			const config = getProviderNetworkConfig("anthropic");

			expect(config.timeout).toBe(60000);
			expect(config.maxRetries).toBe(5);
		});

		it("should apply per-provider config from file", async () => {
			const providersConfig = {
				anthropic: {
					timeout: 90000,
					maxRetries: 4,
				},
				openai: {
					timeout: 45000,
				},
			};

			writeFileSync(
				join(testDir, ".maestro", "providers.json"),
				JSON.stringify(providersConfig),
			);

			const { getProviderNetworkConfig, clearNetworkConfigCache } =
				await import("../../src/providers/network-config.js");
			clearNetworkConfigCache();

			const anthropicConfig = getProviderNetworkConfig("anthropic");
			expect(anthropicConfig.timeout).toBe(90000);
			expect(anthropicConfig.maxRetries).toBe(4);

			const openaiConfig = getProviderNetworkConfig("openai");
			expect(openaiConfig.timeout).toBe(45000);
			expect(openaiConfig.maxRetries).toBe(3); // Default, not overridden
		});

		it("should cache config per provider", async () => {
			const { getProviderNetworkConfig, clearNetworkConfigCache } =
				await import("../../src/providers/network-config.js");
			clearNetworkConfigCache();

			const config1 = getProviderNetworkConfig("anthropic");
			const config2 = getProviderNetworkConfig("anthropic");

			expect(config1).toBe(config2); // Same object reference
		});

		it("should handle case-insensitive provider names", async () => {
			const providersConfig = {
				ANTHROPIC: {
					timeout: 90000,
				},
			};

			writeFileSync(
				join(testDir, ".maestro", "providers.json"),
				JSON.stringify(providersConfig),
			);

			const { getProviderNetworkConfig, clearNetworkConfigCache } =
				await import("../../src/providers/network-config.js");
			clearNetworkConfigCache();

			const config = getProviderNetworkConfig("anthropic");
			expect(config.timeout).toBe(90000);
		});
	});

	describe("calculateBackoff", () => {
		it("should calculate exponential backoff", async () => {
			const { calculateBackoff } = await import(
				"../../src/providers/network-config.js"
			);

			const config = {
				timeout: 120000,
				maxRetries: 3,
				streamMaxRetries: 5,
				streamIdleTimeout: 300000,
				backoffInitial: 1000,
				backoffMax: 30000,
				backoffMultiplier: 2,
			};

			expect(calculateBackoff(0, config)).toBe(1000); // 1000 * 2^0 = 1000
			expect(calculateBackoff(1, config)).toBe(2000); // 1000 * 2^1 = 2000
			expect(calculateBackoff(2, config)).toBe(4000); // 1000 * 2^2 = 4000
			expect(calculateBackoff(3, config)).toBe(8000); // 1000 * 2^3 = 8000
		});

		it("should cap at backoffMax", async () => {
			const { calculateBackoff } = await import(
				"../../src/providers/network-config.js"
			);

			const config = {
				timeout: 120000,
				maxRetries: 3,
				streamMaxRetries: 5,
				streamIdleTimeout: 300000,
				backoffInitial: 1000,
				backoffMax: 5000,
				backoffMultiplier: 2,
			};

			expect(calculateBackoff(5, config)).toBe(5000); // Would be 32000, capped at 5000
			expect(calculateBackoff(10, config)).toBe(5000);
		});
	});

	describe("isRetryableError", () => {
		it("should return true for network errors", async () => {
			const { isRetryableError } = await import(
				"../../src/providers/network-config.js"
			);

			const abortError = new Error("request aborted");
			abortError.name = "AbortError";

			expect(isRetryableError(new Error("network error"))).toBe(true);
			expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
			expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
			expect(isRetryableError(new Error("socket hang up"))).toBe(true);
			expect(isRetryableError(new Error("fetch failed"))).toBe(true);
			expect(isRetryableError(abortError)).toBe(true);
		});

		it("should return false for non-network errors", async () => {
			const { isRetryableError } = await import(
				"../../src/providers/network-config.js"
			);

			expect(isRetryableError(new Error("Invalid API key"))).toBe(false);
			expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(false);
			expect(isRetryableError(new Error("Bad request"))).toBe(false);
		});

		it("should return false for non-Error objects", async () => {
			const { isRetryableError } = await import(
				"../../src/providers/network-config.js"
			);

			expect(isRetryableError("string error")).toBe(false);
			expect(isRetryableError(null)).toBe(false);
			expect(isRetryableError(undefined)).toBe(false);
		});
	});

	describe("isModelRequestUrlPolicyError", () => {
		it("matches the fail-closed policy-denial error prefix", async () => {
			const { isModelRequestUrlPolicyError } = await import(
				"../../src/providers/network-config.js"
			);

			expect(
				isModelRequestUrlPolicyError(
					new Error(
						"Model request blocked by URL policy: not_in_allowed_base_urls",
					),
				),
			).toBe(true);
			expect(
				isModelRequestUrlPolicyError(
					new Error("Model request blocked by URL policy: unknown_reason"),
				),
			).toBe(true);
		});

		it("does not match generic fetch errors", async () => {
			const { isModelRequestUrlPolicyError } = await import(
				"../../src/providers/network-config.js"
			);

			expect(isModelRequestUrlPolicyError(new Error("fetch failed"))).toBe(
				false,
			);
			expect(isModelRequestUrlPolicyError(new Error("ECONNRESET"))).toBe(false);
			expect(isModelRequestUrlPolicyError("string error")).toBe(false);
			expect(isModelRequestUrlPolicyError(null)).toBe(false);
		});
	});

	describe("isRetryableStatus", () => {
		it("should return true for retryable status codes", async () => {
			const { isRetryableStatus } = await import(
				"../../src/providers/network-config.js"
			);

			expect(isRetryableStatus(429)).toBe(true); // Too Many Requests
			expect(isRetryableStatus(500)).toBe(true); // Internal Server Error
			expect(isRetryableStatus(502)).toBe(true); // Bad Gateway
			expect(isRetryableStatus(503)).toBe(true); // Service Unavailable
			expect(isRetryableStatus(504)).toBe(true); // Gateway Timeout
		});

		it("should return false for non-retryable status codes", async () => {
			const { isRetryableStatus } = await import(
				"../../src/providers/network-config.js"
			);

			expect(isRetryableStatus(200)).toBe(false);
			expect(isRetryableStatus(400)).toBe(false);
			expect(isRetryableStatus(401)).toBe(false);
			expect(isRetryableStatus(403)).toBe(false);
			expect(isRetryableStatus(404)).toBe(false);
		});
	});

	describe("fetchWithPinnedModelRequestDns", () => {
		it("pins fetch lookups to policy-approved addresses", async () => {
			type PinnedLookup = (
				hostname: string,
				options: { all?: boolean; family?: number },
				callback: (
					error: NodeJS.ErrnoException | null,
					address: string | Array<{ address: string; family: number }>,
					family?: number,
				) => void,
			) => void;
			type MockAgentInstance = {
				options: { connect?: { lookup?: PinnedLookup } };
				close: ReturnType<typeof vi.fn>;
			};

			const createdAgents: MockAgentInstance[] = [];
			class MockAgent implements MockAgentInstance {
				close = vi.fn().mockResolvedValue(undefined);

				constructor(public options: MockAgentInstance["options"]) {
					createdAgents.push(this);
				}
			}

			vi.doMock("undici", () => ({ Agent: MockAgent }));
			vi.resetModules();
			const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
			vi.stubGlobal("fetch", fetchMock);

			try {
				const { fetchWithPinnedModelRequestDns } = await import(
					"../../src/providers/network-config.js"
				);

				await fetchWithPinnedModelRequestDns(
					"https://api.example.test/v1/messages",
					{ method: "POST", redirect: "follow" },
					{
						allowed: true,
						hostname: "api.example.test",
						resolvedAddresses: [
							"93.184.216.34",
							"2606:2800:220:1:248:1893:25c8:1946",
						],
					},
				);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(createdAgents).toHaveLength(1);
				const fetchInit = fetchMock.mock.calls[0]?.[1] as
					| (RequestInit & { dispatcher?: unknown })
					| undefined;
				expect(fetchInit?.dispatcher).toBe(createdAgents[0]);
				expect(fetchInit?.redirect).toBe("manual");

				const lookup = createdAgents[0]?.options.connect?.lookup;
				expect(lookup).toBeTypeOf("function");
				if (!lookup) return;

				const allAddresses = await new Promise<
					Array<{ address: string; family: number }>
				>((resolve, reject) => {
					lookup("api.example.test", { all: true }, (error, address) => {
						if (error) {
							reject(error);
							return;
						}
						resolve(address as Array<{ address: string; family: number }>);
					});
				});
				expect(allAddresses).toEqual([
					{ address: "93.184.216.34", family: 4 },
					{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
				]);

				const ipv4Address = await new Promise<{
					address: string;
					family?: number;
				}>((resolve, reject) => {
					lookup(
						"api.example.test",
						{ family: 4 },
						(error, address, family) => {
							if (error) {
								reject(error);
								return;
							}
							resolve({ address: String(address), family });
						},
					);
				});
				expect(ipv4Address).toEqual({
					address: "93.184.216.34",
					family: 4,
				});

				const mismatchCode = await new Promise<string | undefined>(
					(resolve) => {
						lookup("other.example.test", {}, (error) => resolve(error?.code));
					},
				);
				expect(mismatchCode).toBe("ERR_DNS_PINNED_HOST_MISMATCH");
				expect(createdAgents[0]?.close).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock("undici");
				vi.resetModules();
			}
		});

		it("follows redirects only after re-checking URL policy", async () => {
			type MockAgentInstance = {
				close: ReturnType<typeof vi.fn>;
			};

			const createdAgents: MockAgentInstance[] = [];
			class MockAgent implements MockAgentInstance {
				close = vi.fn().mockResolvedValue(undefined);

				constructor(_options: unknown) {
					createdAgents.push(this);
				}
			}

			vi.doMock("undici", () => ({ Agent: MockAgent }));
			vi.resetModules();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(null, {
						status: 302,
						headers: {
							location: "https://93.184.216.34/v1/messages",
						},
					}),
				)
				.mockResolvedValueOnce(new Response("ok"));
			vi.stubGlobal("fetch", fetchMock);

			try {
				const { fetchWithModelRequestPolicyRedirects } = await import(
					"../../src/providers/network-config.js"
				);

				const response = await fetchWithModelRequestPolicyRedirects(
					"https://api.example.test/v1/messages",
					{ method: "POST", body: JSON.stringify({ hello: "world" }) },
					{
						allowed: true,
						hostname: "api.example.test",
						resolvedAddresses: ["93.184.216.34"],
					},
				);

				expect(await response.text()).toBe("ok");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
					redirect: "manual",
				});
				expect(fetchMock.mock.calls[1]?.[0]).toBe(
					"https://93.184.216.34/v1/messages",
				);
				expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
					redirect: "manual",
				});
				expect(createdAgents[0]?.close).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock("undici");
				vi.resetModules();
			}
		});

		it("blocks redirects to internal hosts before following them", async () => {
			type MockAgentInstance = {
				close: ReturnType<typeof vi.fn>;
			};

			const createdAgents: MockAgentInstance[] = [];
			class MockAgent implements MockAgentInstance {
				close = vi.fn().mockResolvedValue(undefined);

				constructor(_options: unknown) {
					createdAgents.push(this);
				}
			}

			vi.doMock("undici", () => ({ Agent: MockAgent }));
			vi.resetModules();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: {
						location: "http://127.0.0.1:8080/v1/messages",
					},
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			try {
				const { fetchWithModelRequestPolicyRedirects } = await import(
					"../../src/providers/network-config.js"
				);

				await expect(
					fetchWithModelRequestPolicyRedirects(
						"https://api.example.test/v1/messages",
						{ method: "POST" },
						{
							allowed: true,
							hostname: "api.example.test",
							resolvedAddresses: ["93.184.216.34"],
						},
					),
				).rejects.toThrow(/internal_host/);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(createdAgents[0]?.close).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock("undici");
				vi.resetModules();
			}
		});

		it("does not reuse internal base URL allowance for other redirect targets", async () => {
			type MockAgentInstance = {
				close: ReturnType<typeof vi.fn>;
			};

			const createdAgents: MockAgentInstance[] = [];
			class MockAgent implements MockAgentInstance {
				close = vi.fn().mockResolvedValue(undefined);

				constructor(_options: unknown) {
					createdAgents.push(this);
				}
			}

			vi.doMock("undici", () => ({ Agent: MockAgent }));
			vi.resetModules();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: {
						location: "http://127.0.0.1:8080/v1/messages",
					},
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			try {
				const { fetchWithModelRequestPolicyRedirects } = await import(
					"../../src/providers/network-config.js"
				);

				await expect(
					fetchWithModelRequestPolicyRedirects(
						"http://localhost:11434/v1/messages",
						{ method: "POST" },
						{
							allowed: true,
							hostname: "localhost",
							resolvedAddresses: ["127.0.0.1"],
						},
						{
							allowInternalBaseUrl: true,
							internalBaseUrl: "http://localhost:11434/v1",
							policy: {
								internalBaseUrlAllowList: ["http://localhost:11434/v1"],
							},
						},
					),
				).rejects.toThrow(/internal_host/);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(createdAgents[0]?.close).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock("undici");
				vi.resetModules();
			}
		});

		it("blocks redirects that leave the configured public allowlist", async () => {
			type MockAgentInstance = {
				close: ReturnType<typeof vi.fn>;
			};

			const createdAgents: MockAgentInstance[] = [];
			class MockAgent implements MockAgentInstance {
				close = vi.fn().mockResolvedValue(undefined);

				constructor(_options: unknown) {
					createdAgents.push(this);
				}
			}

			vi.doMock("undici", () => ({ Agent: MockAgent }));
			vi.resetModules();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: {
						location: "https://attacker.example/v1/messages",
					},
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			try {
				const { fetchWithModelRequestPolicyRedirects } = await import(
					"../../src/providers/network-config.js"
				);

				await expect(
					fetchWithModelRequestPolicyRedirects(
						"https://trusted.example/v1/messages",
						{ method: "POST" },
						{
							allowed: true,
							hostname: "trusted.example",
							resolvedAddresses: ["93.184.216.34"],
						},
						{
							policy: {
								allowedBaseUrls: ["https://trusted.example/v1"],
							},
						},
					),
				).rejects.toThrow(/not_in_allowed_base_urls/);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(createdAgents[0]?.close).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock("undici");
				vi.resetModules();
			}
		});
	});

	describe("sleep", () => {
		it("should wait for specified milliseconds", async () => {
			const { sleep } = await import("../../src/providers/network-config.js");

			const start = Date.now();
			await sleep(50);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeGreaterThanOrEqual(45);
			expect(elapsed).toBeLessThan(150);
		});
	});
});

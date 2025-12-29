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
		Reflect.deleteProperty(process.env, "COMPOSER_PROVIDER_TIMEOUT_MS");
		Reflect.deleteProperty(process.env, "COMPOSER_PROVIDER_MAX_RETRIES");
		Reflect.deleteProperty(process.env, "COMPOSER_STREAM_MAX_RETRIES");
		Reflect.deleteProperty(process.env, "COMPOSER_STREAM_IDLE_TIMEOUT_MS");

		// Create test directory and set HOME
		mkdirSync(join(testDir, ".composer"), { recursive: true });
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
			process.env.COMPOSER_PROVIDER_TIMEOUT_MS = "60000";
			process.env.COMPOSER_PROVIDER_MAX_RETRIES = "5";

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
				join(testDir, ".composer", "providers.json"),
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
				join(testDir, ".composer", "providers.json"),
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

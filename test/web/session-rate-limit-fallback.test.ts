import { describe, expect, it, vi } from "vitest";

describe("session rate limit fallback cleanup", () => {
	it("evicts buckets when exceeding the fallback max", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COMPOSER_RATE_LIMIT_FALLBACK_MAX_BUCKETS", "2");
		vi.stubEnv("COMPOSER_RATE_LIMIT_FALLBACK_CLEANUP_INTERVAL", "1");
		vi.stubEnv("COMPOSER_RATE_LIMIT_SESSION", "2");
		vi.stubEnv("COMPOSER_REDIS_URL", "");
		try {
			vi.setSystemTime(0);
			vi.resetModules();
			const module = await import(
				"../../src/server/utils/session-rate-limit.js"
			);
			module.resetFallbackBucketsForTests();

			await module.checkSessionRateLimitAsync("session-old");
			vi.setSystemTime(1);
			await module.checkSessionRateLimitAsync("session-mid");
			vi.setSystemTime(2);
			await module.checkSessionRateLimitAsync("session-new");

			expect(module.getFallbackBucketCountForTests()).toBeLessThanOrEqual(2);

			const retry = await module.checkSessionRateLimitAsync("session-old");
			expect(retry.remaining).toBe(1);
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});
});

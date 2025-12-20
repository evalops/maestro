import { describe, expect, it, vi } from "vitest";

describe("session rate limit fallback cleanup", () => {
	it("evicts buckets when exceeding the fallback max", async () => {
		vi.stubEnv("COMPOSER_RATE_LIMIT_FALLBACK_MAX_BUCKETS", "5");
		vi.stubEnv("COMPOSER_RATE_LIMIT_FALLBACK_CLEANUP_INTERVAL", "1");
		try {
			vi.resetModules();
			const module = await import(
				"../../src/server/utils/session-rate-limit.js"
			);
			module.resetFallbackBucketsForTests();

			for (let i = 0; i < 10; i += 1) {
				await module.checkSessionRateLimitAsync(`session-${i}`);
			}

			expect(module.getFallbackBucketCountForTests()).toBeLessThanOrEqual(5);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

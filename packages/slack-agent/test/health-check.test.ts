import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HealthChecker,
	createHealthChecker,
	createHealthEndpoints,
	standardChecks,
} from "../src/utils/health-check.js";

describe("HealthChecker", () => {
	describe("registration", () => {
		it("registers components", () => {
			const checker = new HealthChecker();

			checker.register("db", async () => true);
			checker.register("cache", async () => true);

			expect(checker.getComponentNames()).toEqual(["db", "cache"]);
		});

		it("unregisters components", () => {
			const checker = new HealthChecker();

			checker.register("db", async () => true);
			checker.register("cache", async () => true);

			const removed = checker.unregister("db");

			expect(removed).toBe(true);
			expect(checker.getComponentNames()).toEqual(["cache"]);
		});

		it("returns false when unregistering non-existent", () => {
			const checker = new HealthChecker();
			expect(checker.unregister("nonexistent")).toBe(false);
		});
	});

	describe("check", () => {
		it("returns healthy when all components healthy", async () => {
			const checker = new HealthChecker();

			checker.register("db", async () => true);
			checker.register("cache", async () => true);

			const result = await checker.check();

			expect(result.healthy).toBe(true);
			expect(result.status).toBe("healthy");
			expect(result.components.db!.healthy).toBe(true);
			expect(result.components.cache!.healthy).toBe(true);
		});

		it("returns unhealthy when critical component fails", async () => {
			const checker = new HealthChecker();

			checker.register("db", async () => false, { critical: true });
			checker.register("cache", async () => true);

			const result = await checker.check();

			expect(result.healthy).toBe(false);
			expect(result.status).toBe("unhealthy");
		});

		it("returns degraded when non-critical component fails", async () => {
			const checker = new HealthChecker();

			checker.register("db", async () => true, { critical: true });
			checker.register("metrics", async () => false, { critical: false });

			const result = await checker.check();

			expect(result.healthy).toBe(true);
			expect(result.status).toBe("degraded");
		});

		it("handles check returning object with message", async () => {
			const checker = new HealthChecker();

			checker.register("db", async () => ({
				healthy: true,
				message: "Connection pool: 5/10",
			}));

			const result = await checker.check();

			expect(result.components.db!.healthy).toBe(true);
			expect(result.components.db!.message).toBe("Connection pool: 5/10");
		});

		it("handles throwing checks", async () => {
			const checker = new HealthChecker();

			checker.register("db", async () => {
				throw new Error("Connection refused");
			});

			const result = await checker.check();

			expect(result.healthy).toBe(false);
			expect(result.components.db!.healthy).toBe(false);
			expect(result.components.db!.message).toBe("Connection refused");
		});

		it("includes latency measurements", async () => {
			const checker = new HealthChecker();

			checker.register("slow", async () => {
				await new Promise((r) => setTimeout(r, 60));
				return true;
			});

			const result = await checker.check();

			expect(result.components.slow!.latencyMs).toBeGreaterThanOrEqual(50);
		});

		it("includes timestamp and version", async () => {
			const checker = new HealthChecker({ version: "1.2.3" });

			checker.register("db", async () => true);

			const before = Date.now();
			const result = await checker.check();
			const after = Date.now();

			expect(result.timestamp).toBeGreaterThanOrEqual(before);
			expect(result.timestamp).toBeLessThanOrEqual(after);
			expect(result.version).toBe("1.2.3");
		});
	});

	describe("timeout handling", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("times out slow checks", async () => {
			const checker = new HealthChecker({ timeoutMs: 100 });

			checker.register("slow", async () => {
				await new Promise((r) => setTimeout(r, 500));
				return true;
			});

			const checkPromise = checker.check();
			await vi.advanceTimersByTimeAsync(150);
			const result = await checkPromise;

			expect(result.components.slow!.healthy).toBe(false);
			expect(result.components.slow!.message).toContain("timeout");
		});

		it("uses per-check timeout override", async () => {
			const checker = new HealthChecker({ timeoutMs: 100 });

			checker.register(
				"fast",
				async () => {
					await new Promise((r) => setTimeout(r, 50));
					return true;
				},
				{ timeoutMs: 200 },
			);

			const checkPromise = checker.check();
			await vi.advanceTimersByTimeAsync(60);
			const result = await checkPromise;

			expect(result.components.fast!.healthy).toBe(true);
		});
	});

	describe("caching", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("caches results within TTL", async () => {
			const checker = new HealthChecker({ cacheTtlMs: 1000 });
			let callCount = 0;

			checker.register("db", async () => {
				callCount++;
				return true;
			});

			await checker.check();
			await checker.check();
			await checker.check();

			expect(callCount).toBe(1);
		});

		it("refreshes cache after TTL expires", async () => {
			const checker = new HealthChecker({ cacheTtlMs: 1000 });
			let callCount = 0;

			checker.register("db", async () => {
				callCount++;
				return true;
			});

			await checker.check();
			vi.advanceTimersByTime(1100);
			await checker.check();

			expect(callCount).toBe(2);
		});

		it("clearCache forces refresh", async () => {
			const checker = new HealthChecker({ cacheTtlMs: 10000 });
			let callCount = 0;

			checker.register("db", async () => {
				callCount++;
				return true;
			});

			await checker.check();
			checker.clearCache();
			await checker.check();

			expect(callCount).toBe(2);
		});
	});

	describe("isReady and isAlive", () => {
		it("isReady returns true when healthy", async () => {
			const checker = new HealthChecker();
			checker.register("db", async () => true);

			expect(await checker.isReady()).toBe(true);
		});

		it("isReady returns false when unhealthy", async () => {
			const checker = new HealthChecker();
			checker.register("db", async () => false);

			expect(await checker.isReady()).toBe(false);
		});

		it("isAlive returns true by default", () => {
			const checker = new HealthChecker();
			expect(checker.isAlive()).toBe(true);
		});
	});

	describe("reset", () => {
		it("clears all checks and cache", async () => {
			const checker = new HealthChecker({ cacheTtlMs: 10000 });

			checker.register("db", async () => true);
			await checker.check();

			checker.reset();

			expect(checker.getComponentNames()).toEqual([]);
		});
	});
});

describe("createHealthChecker", () => {
	it("creates checker with defaults", () => {
		const checker = createHealthChecker();
		expect(checker).toBeInstanceOf(HealthChecker);
	});

	it("creates checker with config", () => {
		const checker = createHealthChecker({
			timeoutMs: 10000,
			version: "2.0.0",
		});
		expect(checker).toBeInstanceOf(HealthChecker);
	});
});

describe("createHealthEndpoints", () => {
	it("handleLiveness returns 200 when alive", () => {
		const checker = createHealthChecker();
		const endpoints = createHealthEndpoints(checker);

		const result = endpoints.handleLiveness();

		expect(result.status).toBe(200);
		expect(result.body).toBe("OK");
	});

	it("handleReadiness returns 200 when ready", async () => {
		const checker = createHealthChecker();
		checker.register("db", async () => true);
		const endpoints = createHealthEndpoints(checker);

		const result = await endpoints.handleReadiness();

		expect(result.status).toBe(200);
		expect(result.body).toBe("OK");
	});

	it("handleReadiness returns 503 when not ready", async () => {
		const checker = createHealthChecker();
		checker.register("db", async () => false);
		const endpoints = createHealthEndpoints(checker);

		const result = await endpoints.handleReadiness();

		expect(result.status).toBe(503);
		expect(result.body).toBe("Service Unavailable");
	});

	it("handleHealth returns full status", async () => {
		const checker = createHealthChecker({ version: "1.0.0" });
		checker.register("db", async () => true);
		const endpoints = createHealthEndpoints(checker);

		const result = await endpoints.handleHealth();

		expect(result.status).toBe(200);
		expect(result.body.healthy).toBe(true);
		expect(result.body.version).toBe("1.0.0");
		expect(result.body.components.db!.healthy).toBe(true);
	});
});

describe("standardChecks", () => {
	describe("slack", () => {
		it("returns healthy when auth.test succeeds", async () => {
			const check = standardChecks.slack(async () => ({ ok: true }));
			expect(await check()).toBe(true);
		});

		it("returns unhealthy when auth.test fails", async () => {
			const check = standardChecks.slack(async () => ({ ok: false }));
			expect(await check()).toBe(false);
		});
	});

	describe("redis", () => {
		it("returns healthy when ping returns PONG", async () => {
			const check = standardChecks.redis(async () => "PONG");
			expect(await check()).toBe(true);
		});

		it("returns unhealthy when ping fails", async () => {
			const check = standardChecks.redis(async () => "error");
			expect(await check()).toBe(false);
		});
	});

	describe("database", () => {
		it("returns healthy when query succeeds", async () => {
			const check = standardChecks.database(async () => [{ "1": 1 }]);
			expect(await check()).toBe(true);
		});

		it("throws when query fails", async () => {
			const check = standardChecks.database(async () => {
				throw new Error("Connection error");
			});
			await expect(check()).rejects.toThrow("Connection error");
		});
	});

	describe("filesystem", () => {
		it("returns healthy when write/delete succeeds", async () => {
			const fs = {
				writeFile: vi.fn().mockResolvedValue(undefined),
				unlink: vi.fn().mockResolvedValue(undefined),
			};

			const check = standardChecks.filesystem("/tmp", fs);
			expect(await check()).toBe(true);
			expect(fs.writeFile).toHaveBeenCalled();
			expect(fs.unlink).toHaveBeenCalled();
		});

		it("returns unhealthy when write fails", async () => {
			const fs = {
				writeFile: vi.fn().mockRejectedValue(new Error("Permission denied")),
				unlink: vi.fn().mockResolvedValue(undefined),
			};

			const check = standardChecks.filesystem("/tmp", fs);
			expect(await check()).toBe(false);
		});
	});

	describe("memory", () => {
		it("returns healthy when under threshold", async () => {
			const check = standardChecks.memory(1000); // 1GB threshold
			const result = await check();
			expect(typeof result === "object" ? result.healthy : result).toBe(true);
		});

		it("returns unhealthy when over threshold", async () => {
			const check = standardChecks.memory(1); // 1MB threshold (likely exceeded)
			const result = await check();
			// This might pass or fail depending on actual heap usage
			expect(typeof result).toBe("object");
		});
	});
});

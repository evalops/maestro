import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CircuitBreaker,
	CircuitBreakerRegistry,
	CircuitOpenError,
	DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../../src/safety/circuit-breaker.js";

describe("circuit-breaker", () => {
	describe("CircuitBreaker", () => {
		let breaker: CircuitBreaker;

		beforeEach(() => {
			breaker = new CircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 1000,
				successThreshold: 2,
				toolName: "test-tool",
			});
		});

		describe("initial state", () => {
			it("starts in closed state", () => {
				expect(breaker.state).toBe("closed");
				expect(breaker.failures).toBe(0);
			});
		});

		describe("execute", () => {
			it("passes through successful operations", async () => {
				const result = await breaker.execute(async () => "success");
				expect(result).toBe("success");
				expect(breaker.state).toBe("closed");
			});

			it("throws operation errors", async () => {
				await expect(
					breaker.execute(async () => {
						throw new Error("operation failed");
					}),
				).rejects.toThrow("operation failed");
				expect(breaker.failures).toBe(1);
			});

			it("tracks consecutive failures", async () => {
				for (let i = 0; i < 2; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.failures).toBe(2);
				expect(breaker.state).toBe("closed");
			});

			it("opens circuit after failure threshold", async () => {
				for (let i = 0; i < 3; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.state).toBe("open");
				expect(breaker.failures).toBe(3);
			});

			it("throws CircuitOpenError when circuit is open", async () => {
				// Open the circuit
				for (let i = 0; i < 3; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}

				// Next call should throw CircuitOpenError
				await expect(breaker.execute(async () => "success")).rejects.toThrow(
					CircuitOpenError,
				);
			});

			it("resets failure count on success", async () => {
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
				expect(breaker.failures).toBe(1);

				await breaker.execute(async () => "success");
				expect(breaker.failures).toBe(0);
			});
		});

		describe("half-open state", () => {
			beforeEach(async () => {
				// Open the circuit
				for (let i = 0; i < 3; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.state).toBe("open");
			});

			it("transitions to half-open after reset timeout", async () => {
				// Wait for reset timeout
				await new Promise((resolve) => setTimeout(resolve, 1100));

				// The state check happens on next execute call
				try {
					await breaker.execute(async () => "success");
				} catch {
					// May fail, we just need the state check to happen
				}

				// Should be closed after successful recovery
				// (2 successes needed, 1 already done)
				await breaker.execute(async () => "success");
				expect(breaker.state).toBe("closed");
			});

			it("reopens on failure during half-open", async () => {
				// Wait for reset timeout
				await new Promise((resolve) => setTimeout(resolve, 1100));

				// Trigger state check and fail
				await breaker
					.execute(async () => {
						throw new Error("still failing");
					})
					.catch(() => {});

				expect(breaker.state).toBe("open");
			});

			it("closes after success threshold in half-open", async () => {
				// Create a new breaker with shorter timeout for this test
				const fastBreaker = new CircuitBreaker({
					failureThreshold: 2,
					resetTimeoutMs: 100,
					successThreshold: 2,
				});

				// Open it
				for (let i = 0; i < 2; i++) {
					await fastBreaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(fastBreaker.state).toBe("open");

				// Wait for reset timeout
				await new Promise((resolve) => setTimeout(resolve, 150));

				// Two successes should close it
				await fastBreaker.execute(async () => "success1");
				await fastBreaker.execute(async () => "success2");

				expect(fastBreaker.state).toBe("closed");
			});
		});

		describe("manual controls", () => {
			it("reset() closes circuit and clears counts", async () => {
				// Open the circuit
				for (let i = 0; i < 3; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.state).toBe("open");

				breaker.reset();

				expect(breaker.state).toBe("closed");
				expect(breaker.failures).toBe(0);
			});

			it("trip() opens circuit immediately", () => {
				expect(breaker.state).toBe("closed");

				breaker.trip("manual intervention");

				expect(breaker.state).toBe("open");
			});

			it("trip() is idempotent when already open", async () => {
				// Open the circuit
				for (let i = 0; i < 3; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}

				const statsBefore = breaker.getStats();
				breaker.trip();
				const statsAfter = breaker.getStats();

				// State should remain open, no double tracking
				expect(statsAfter.state).toBe("open");
			});
		});

		describe("getStats", () => {
			it("returns current circuit state", () => {
				const stats = breaker.getStats();

				expect(stats.state).toBe("closed");
				expect(stats.failures).toBe(0);
				expect(stats.successes).toBe(0);
				expect(stats.lastFailureTime).toBeNull();
				expect(stats.timeInCurrentState).toBeGreaterThanOrEqual(0);
			});

			it("tracks time in current state", async () => {
				const stats1 = breaker.getStats();
				await new Promise((resolve) => setTimeout(resolve, 50));
				const stats2 = breaker.getStats();

				expect(stats2.timeInCurrentState).toBeGreaterThan(
					stats1.timeInCurrentState,
				);
			});
		});
	});

	describe("CircuitOpenError", () => {
		it("includes tool name and retry time", () => {
			const error = new CircuitOpenError("test-tool", 5000);

			expect(error.name).toBe("CircuitOpenError");
			expect(error.toolName).toBe("test-tool");
			expect(error.retryAfterMs).toBe(5000);
			expect(error.message).toContain("test-tool");
			expect(error.message).toContain("5s");
		});
	});

	describe("CircuitBreakerRegistry", () => {
		let registry: CircuitBreakerRegistry;

		beforeEach(() => {
			registry = new CircuitBreakerRegistry({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
			});
		});

		describe("getOrCreate", () => {
			it("creates new breaker for unknown key", () => {
				const breaker = registry.getOrCreate("tool1");

				expect(breaker).toBeInstanceOf(CircuitBreaker);
				expect(breaker.state).toBe("closed");
			});

			it("returns existing breaker for known key", () => {
				const breaker1 = registry.getOrCreate("tool1");
				const breaker2 = registry.getOrCreate("tool1");

				expect(breaker1).toBe(breaker2);
			});

			it("uses default config from registry", async () => {
				const breaker = registry.getOrCreate("tool1");

				// Default threshold is 5, so 4 failures should keep it closed
				for (let i = 0; i < 4; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.state).toBe("closed");

				// 5th failure should open it
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
				expect(breaker.state).toBe("open");
			});

			it("allows per-breaker config override", async () => {
				const breaker = registry.getOrCreate("tool1", { failureThreshold: 2 });

				// Only 2 failures needed
				for (let i = 0; i < 2; i++) {
					await breaker
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}
				expect(breaker.state).toBe("open");
			});
		});

		describe("getAll", () => {
			it("returns all breakers", () => {
				registry.getOrCreate("tool1");
				registry.getOrCreate("tool2");

				const all = registry.getAll();

				expect(all.size).toBe(2);
				expect(all.has("tool1")).toBe(true);
				expect(all.has("tool2")).toBe(true);
			});

			it("returns a copy, not the internal map", () => {
				registry.getOrCreate("tool1");
				const all = registry.getAll();

				all.delete("tool1");

				expect(registry.getAll().has("tool1")).toBe(true);
			});
		});

		describe("getSummary", () => {
			it("returns summary of all circuit states", async () => {
				const breaker1 = registry.getOrCreate("tool1", { failureThreshold: 2 });
				registry.getOrCreate("tool2");

				// Open tool1's circuit
				for (let i = 0; i < 2; i++) {
					await breaker1
						.execute(async () => {
							throw new Error("fail");
						})
						.catch(() => {});
				}

				const summary = registry.getSummary();

				expect(summary.tool1.state).toBe("open");
				expect(summary.tool1.failures).toBe(2);
				expect(summary.tool2.state).toBe("closed");
				expect(summary.tool2.failures).toBe(0);
			});
		});

		describe("resetAll", () => {
			it("resets all breakers to closed", async () => {
				const breaker1 = registry.getOrCreate("tool1", { failureThreshold: 2 });
				const breaker2 = registry.getOrCreate("tool2", { failureThreshold: 2 });

				// Open both circuits
				for (const breaker of [breaker1, breaker2]) {
					for (let i = 0; i < 2; i++) {
						await breaker
							.execute(async () => {
								throw new Error("fail");
							})
							.catch(() => {});
					}
				}

				expect(breaker1.state).toBe("open");
				expect(breaker2.state).toBe("open");

				registry.resetAll();

				expect(breaker1.state).toBe("closed");
				expect(breaker2.state).toBe("closed");
			});
		});

		describe("clear", () => {
			it("removes all breakers", () => {
				registry.getOrCreate("tool1");
				registry.getOrCreate("tool2");

				registry.clear();

				expect(registry.getAll().size).toBe(0);
			});
		});
	});

	describe("DEFAULT_CIRCUIT_BREAKER_CONFIG", () => {
		it("has sensible defaults", () => {
			expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
			expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs).toBe(30_000);
			expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold).toBe(2);
		});
	});
});

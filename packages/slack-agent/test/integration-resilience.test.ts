/**
 * Integration tests for resilience utilities working together
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiQueue, createApiQueue } from "../src/utils/api-queue.js";
import {
	CircuitBreaker,
	createCircuitBreaker,
} from "../src/utils/circuit-breaker.js";
import { ShutdownManager } from "../src/utils/graceful-shutdown.js";
import {
	HealthChecker,
	createHealthChecker,
} from "../src/utils/health-check.js";
import {
	MetricsCollector,
	createMetricsCollector,
} from "../src/utils/metrics.js";

describe("Resilience Utilities Integration", () => {
	describe("Circuit Breaker + Metrics", () => {
		it("tracks circuit breaker state changes in metrics", async () => {
			const metrics = createMetricsCollector({ prefix: "app" });
			const breaker = createCircuitBreaker({
				name: "api",
				failureThreshold: 2,
				onStateChange: (from, to) => {
					metrics.increment("circuit_state_changes", { from, to });
				},
			});

			// Trigger failures to open circuit
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			expect(breaker.getState()).toBe("OPEN");
			expect(
				metrics.getCounter("circuit_state_changes", {
					from: "CLOSED",
					to: "OPEN",
				}),
			).toBe(1);
		});

		it("tracks API call latency through circuit breaker", async () => {
			const metrics = createMetricsCollector();
			const breaker = createCircuitBreaker({ name: "api" });

			const result = await metrics.time("api_latency", () =>
				breaker.execute(async () => {
					await new Promise((r) => setTimeout(r, 10));
					return "success";
				}),
			);

			expect(result).toBe("success");
			const hist = metrics.getHistogram("api_latency");
			expect(hist?.count).toBe(1);
			// Allow 2ms jitter for timer imprecision
			expect(hist?.avg).toBeGreaterThanOrEqual(8);
		});
	});

	describe("Health Checker + Circuit Breaker", () => {
		it("reports circuit breaker state in health check", async () => {
			const breaker = createCircuitBreaker({
				name: "external-api",
				failureThreshold: 1,
			});
			const health = createHealthChecker();

			health.register("external-api", async () => {
				return {
					healthy: breaker.getState() !== "OPEN",
					message: `Circuit: ${breaker.getState()}`,
				};
			});

			// Initially healthy
			let result = await health.check();
			expect(result.healthy).toBe(true);
			expect(result.components["external-api"]!.message).toContain("CLOSED");

			// Trip the breaker
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			// Now unhealthy
			result = await health.check();
			expect(result.healthy).toBe(false);
			expect(result.components["external-api"]!.message).toContain("OPEN");
		});

		it("multiple circuit breakers in health check", async () => {
			const slackBreaker = createCircuitBreaker({
				name: "slack",
				failureThreshold: 1,
			});
			const dbBreaker = createCircuitBreaker({
				name: "database",
				failureThreshold: 1,
			});
			const health = createHealthChecker();

			health.register("slack", async () => slackBreaker.getState() !== "OPEN", {
				critical: true,
			});
			health.register("database", async () => dbBreaker.getState() !== "OPEN", {
				critical: true,
			});

			// Trip only slack
			await slackBreaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			const result = await health.check();
			expect(result.healthy).toBe(false);
			expect(result.components.slack!.healthy).toBe(false);
			expect(result.components.database!.healthy).toBe(true);
		});
	});

	describe("Shutdown Manager + All Components", () => {
		it("gracefully shuts down all components", async () => {
			const shutdownOrder: string[] = [];
			const shutdown = new ShutdownManager({ exit: false });
			const health = createHealthChecker();
			const metrics = createMetricsCollector();

			// Register components with priorities
			shutdown.register(
				"metrics-flush",
				async () => {
					shutdownOrder.push("metrics");
					// Simulate flushing metrics
					metrics.reset();
				},
				300,
			);

			shutdown.register(
				"health-disable",
				async () => {
					shutdownOrder.push("health");
					health.reset();
				},
				200,
			);

			shutdown.register(
				"connections-close",
				async () => {
					shutdownOrder.push("connections");
				},
				100,
			);

			const result = await shutdown.shutdown();

			expect(result.success).toBe(true);
			expect(shutdownOrder).toEqual(["connections", "health", "metrics"]);
		});
	});

	describe("API Queue + Circuit Breaker", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("circuit breaker protects queue from repeated failures", async () => {
			const breaker = createCircuitBreaker({
				name: "api",
				failureThreshold: 2,
				resetTimeoutMs: 5000,
			});

			let callCount = 0;

			// Create a function that fails initially
			const apiCall = async () => {
				callCount++;
				if (callCount <= 3) {
					throw new Error("API error");
				}
				return "success";
			};

			// First two calls fail and open circuit
			await breaker.execute(apiCall).catch(() => {});
			await breaker.execute(apiCall).catch(() => {});

			expect(breaker.getState()).toBe("OPEN");

			// Circuit is open, should fail fast
			await expect(breaker.execute(apiCall)).rejects.toThrow("Circuit");
			expect(callCount).toBe(2); // No new call made

			// Advance time to allow half-open
			vi.advanceTimersByTime(5000);

			// Now in half-open, try again (will fail once more)
			await breaker.execute(apiCall).catch(() => {});
			expect(callCount).toBe(3);

			// Back to open
			expect(breaker.getState()).toBe("OPEN");
		});
	});

	describe("Metrics + Health Check Dashboard", () => {
		it("provides comprehensive system status", async () => {
			const metrics = createMetricsCollector({ prefix: "app" });
			const health = createHealthChecker({ version: "1.0.0" });

			// Simulate some activity
			metrics.increment("requests_total", { method: "GET" }, 100);
			metrics.increment("requests_total", { method: "POST" }, 50);
			metrics.histogram("request_latency", 45);
			metrics.histogram("request_latency", 52);
			metrics.histogram("request_latency", 48);
			metrics.gauge("active_connections", 25);

			health.register("api", async () => true);
			health.register("cache", async () => true);

			// Get combined status
			const healthStatus = await health.check();
			const metricsStatus = metrics.getSummary();

			// Verify health
			expect(healthStatus.healthy).toBe(true);
			expect(healthStatus.version).toBe("1.0.0");

			// Verify metrics
			expect(metricsStatus.counters["app_requests_total{method=GET}"]).toBe(
				100,
			);
			expect(metricsStatus.gauges.app_active_connections).toBe(25);
			expect(metricsStatus.histograms.app_request_latency!.count).toBe(3);
		});

		it("exports prometheus format", () => {
			const metrics = createMetricsCollector();

			metrics.increment("http_requests", { status: "200" }, 500);
			metrics.histogram("latency_ms", 100);
			metrics.histogram("latency_ms", 200);

			const prometheus = metrics.toPrometheus();

			expect(prometheus).toContain("# TYPE http_requests counter");
			expect(prometheus).toContain("http_requests{status=200} 500");
			expect(prometheus).toContain("# TYPE latency_ms summary");
			expect(prometheus).toContain('latency_ms{quantile="0.5"}');
		});
	});

	describe("Error Propagation", () => {
		it("errors flow correctly through circuit breaker to metrics", async () => {
			const metrics = createMetricsCollector();
			const breaker = createCircuitBreaker({
				name: "api",
				failureThreshold: 3,
			});

			const wrappedCall = async () => {
				try {
					return await breaker.execute(async () => {
						metrics.increment("api_calls");
						throw new Error("API Error");
					});
				} catch (error) {
					metrics.increment("api_errors", {
						type:
							error instanceof Error && error.name === "CircuitOpenError"
								? "circuit_open"
								: "api_error",
					});
					throw error;
				}
			};

			// Make calls until circuit opens
			for (let i = 0; i < 5; i++) {
				await wrappedCall().catch(() => {});
			}

			// 3 actual API calls, 2 circuit open rejections
			expect(metrics.getCounter("api_calls")).toBe(3);
			expect(metrics.getCounter("api_errors", { type: "api_error" })).toBe(3);
			expect(metrics.getCounter("api_errors", { type: "circuit_open" })).toBe(
				2,
			);
		});
	});
});

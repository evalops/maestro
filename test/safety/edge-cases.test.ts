/**
 * Edge case tests for the security system
 *
 * Tests unusual scenarios, error handling, and boundary conditions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AdaptiveThresholds } from "../../src/safety/adaptive-thresholds.js";
import {
	CircuitBreaker,
	CircuitOpenError,
} from "../../src/safety/circuit-breaker.js";
import { checkContextFirewall } from "../../src/safety/context-firewall.js";
import { ToolSequenceAnalyzer } from "../../src/safety/tool-sequence-analyzer.js";
import {
	type SecurityEvent,
	clearEventBuffer,
	getEventStats,
	getRecentEvents,
	onSecurityEvent,
	trackLoopDetection,
	trackToolBlocked,
} from "../../src/telemetry/security-events.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_AWS_ACCESS_KEY = joinParts("AK", "IA", "IOSFODNN7", "EXAMPLE");

describe("security edge cases", () => {
	beforeEach(() => {
		clearEventBuffer();
	});

	describe("event buffer management", () => {
		it("handles rapid event emission", () => {
			// Emit many events rapidly using public API
			for (let i = 0; i < 100; i++) {
				trackToolBlocked({
					toolName: "test",
					reason: `Test event ${i}`,
					source: "firewall",
				});
			}

			const events = getRecentEvents(200);
			// Should have all events (buffer is 1000)
			expect(events.length).toBe(100);
		});

		it("handles event retrieval with limits", () => {
			// Emit events
			for (let i = 0; i < 50; i++) {
				trackToolBlocked({
					toolName: "test",
					reason: `Event ${i}`,
					source: "firewall",
				});
			}

			// Get limited subset
			const limited = getRecentEvents(10);
			expect(limited.length).toBe(10);

			// Get all
			const all = getRecentEvents(100);
			expect(all.length).toBe(50);
		});

		it("isolates listener errors", () => {
			const goodListenerCalls: SecurityEvent[] = [];

			// Register a throwing listener
			const unsub1 = onSecurityEvent(() => {
				throw new Error("Listener error");
			});

			// Register a good listener after
			const unsub2 = onSecurityEvent((event) => {
				goodListenerCalls.push(event);
			});

			// Emit event - should not throw
			expect(() => {
				trackToolBlocked({
					toolName: "test",
					reason: "Test",
					source: "firewall",
				});
			}).not.toThrow();

			// Good listener should still have been called
			expect(goodListenerCalls.length).toBe(1);

			unsub1();
			unsub2();
		});

		it("handles concurrent event emission", async () => {
			const events: SecurityEvent[] = [];
			const unsub = onSecurityEvent((e) => events.push(e));

			// Emit events concurrently
			await Promise.all(
				Array.from({ length: 50 }, (_, i) =>
					Promise.resolve().then(() =>
						trackToolBlocked({
							toolName: "test",
							reason: `Concurrent event ${i}`,
							source: "firewall",
						}),
					),
				),
			);

			// All events should be captured
			expect(events.length).toBe(50);
			unsub();
		});

		it("maintains correct stats after clearing", () => {
			// Emit events with unique reasons to avoid deduplication
			for (let i = 0; i < 10; i++) {
				trackToolBlocked({
					toolName: `test-${i}`,
					reason: `Unique test reason ${i} at ${Date.now()}`,
					source: "firewall",
				});
			}

			let stats = getEventStats();
			expect(stats.total).toBe(10);

			// Clear
			clearEventBuffer();

			stats = getEventStats();
			expect(stats.total).toBe(0);
			expect(stats.byType.tool_blocked).toBe(0);
		});
	});

	describe("circuit breaker edge cases", () => {
		it("handles zero timeout gracefully", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 0,
				successThreshold: 1,
			});

			// One failure opens circuit
			await breaker
				.execute(() => Promise.reject(new Error("fail")))
				.catch(() => {});
			expect(breaker.state).toBe("open");

			// With 0 timeout, should immediately transition to half-open
			// (on next execute attempt)
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should now be able to try again
			await breaker.execute(() => Promise.resolve("ok"));
			expect(breaker.state).toBe("closed");
		});

		it("handles synchronous operation errors", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 2 });

			const syncError = async () => {
				throw new Error("Sync throw");
			};

			await breaker.execute(syncError).catch(() => {});
			expect(breaker.failures).toBe(1);
		});

		it("preserves error information", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 5 });

			const customError = new Error("Custom error message");
			customError.name = "CustomError";

			let caught: Error | null = null;
			try {
				await breaker.execute(() => Promise.reject(customError));
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).toBe(customError);
			expect(caught?.message).toBe("Custom error message");
			expect(caught?.name).toBe("CustomError");
		});

		it("CircuitOpenError includes retry timing", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 5000,
				toolName: "TestTool",
			});

			await breaker
				.execute(() => Promise.reject(new Error("fail")))
				.catch(() => {});

			let error: CircuitOpenError | null = null;
			try {
				await breaker.execute(() => Promise.resolve("ok"));
			} catch (e) {
				error = e as CircuitOpenError;
			}

			expect(error).toBeInstanceOf(CircuitOpenError);
			expect(error?.toolName).toBe("TestTool");
			expect(error?.retryAfterMs).toBeGreaterThan(0);
			expect(error?.retryAfterMs).toBeLessThanOrEqual(5000);
		});

		it("trip() is idempotent", () => {
			const breaker = new CircuitBreaker();

			breaker.trip("first");
			const stats1 = breaker.getStats();

			breaker.trip("second");
			const stats2 = breaker.getStats();

			// Should remain in open state
			expect(stats1.state).toBe("open");
			expect(stats2.state).toBe("open");
		});
	});

	describe("adaptive thresholds edge cases", () => {
		it("handles negative values", () => {
			const thresholds = new AdaptiveThresholds({ minObservations: 3 });

			thresholds.recordObservation("test", -10);
			thresholds.recordObservation("test", -20);
			thresholds.recordObservation("test", -15);

			const summary = thresholds.getMetricSummary("test");
			expect(summary).not.toBeNull();
			expect(summary!.mean).toBeLessThan(0);
			expect(summary!.min).toBe(-20);
			expect(summary!.max).toBe(-10);
		});

		it("handles very large values", () => {
			const thresholds = new AdaptiveThresholds({ minObservations: 3 });

			thresholds.recordObservation("test", 1e15);
			thresholds.recordObservation("test", 1e15);
			thresholds.recordObservation("test", 1e15);

			const summary = thresholds.getMetricSummary("test");
			expect(summary!.mean).toBeGreaterThan(1e14);
		});

		it("handles very small values", () => {
			const thresholds = new AdaptiveThresholds({ minObservations: 3 });

			thresholds.recordObservation("test", 0.0000001);
			thresholds.recordObservation("test", 0.0000002);
			thresholds.recordObservation("test", 0.0000001);

			const summary = thresholds.getMetricSummary("test");
			expect(summary!.mean).toBeLessThan(0.001);
			expect(summary!.mean).toBeGreaterThan(0);
		});

		it("handles zero values", () => {
			const thresholds = new AdaptiveThresholds({ minObservations: 3 });

			thresholds.recordObservation("test", 0);
			thresholds.recordObservation("test", 0);
			thresholds.recordObservation("test", 0);

			const summary = thresholds.getMetricSummary("test");
			expect(summary!.mean).toBe(0);

			// Anomaly detection should use floor for std dev
			const result = thresholds.checkAnomaly("test", 10);
			expect(result.stdDev).toBeGreaterThan(0); // Floor applied
		});

		it("handles alternating high/low values", () => {
			const thresholds = new AdaptiveThresholds({ minObservations: 5 });

			// Alternating pattern
			for (let i = 0; i < 10; i++) {
				thresholds.recordObservation("test", i % 2 === 0 ? 100 : 0);
			}

			const summary = thresholds.getMetricSummary("test");
			// Mean should be somewhere between 0 and 100
			expect(summary!.mean).toBeGreaterThan(10);
			expect(summary!.mean).toBeLessThan(90);
			// Should have high std dev
			expect(summary!.stdDev).toBeGreaterThan(10);
		});
	});

	describe("context firewall edge cases", () => {
		it("handles empty input", () => {
			const result1 = checkContextFirewall({});
			expect(result1.findings.length).toBe(0);

			const result2 = checkContextFirewall({ arg: "" });
			expect(result2.findings.length).toBe(0);
		});

		it("handles deeply nested objects", () => {
			const deepNested = {
				level1: {
					level2: {
						level3: {
							level4: {
								secret: SAMPLE_AWS_ACCESS_KEY,
							},
						},
					},
				},
			};

			const result = checkContextFirewall(deepNested);
			expect(result.findings.length).toBeGreaterThan(0);
		});

		it("handles arrays with secrets", () => {
			const withArrays = {
				items: [
					"normal text",
					"another normal item",
					SAMPLE_AWS_ACCESS_KEY,
					"more text",
				],
			};

			const result = checkContextFirewall(withArrays);
			expect(result.findings.length).toBeGreaterThan(0);
		});

		it("handles non-string values", () => {
			const mixedTypes = {
				number: 12345,
				boolean: true,
				null: null,
				undefined: undefined,
				array: [1, 2, 3],
			};

			// Should not throw
			expect(() => checkContextFirewall(mixedTypes)).not.toThrow();
		});

		it("handles very long strings", () => {
			// Create a very long string with a secret hidden in it
			const longString = `${"x".repeat(10000)}${SAMPLE_AWS_ACCESS_KEY}${"y".repeat(10000)}`;

			const result = checkContextFirewall({ content: longString });
			expect(result.findings.length).toBeGreaterThan(0);
		});
	});

	describe("tool sequence analyzer edge cases", () => {
		it("handles rapid tool recording", () => {
			const analyzer = new ToolSequenceAnalyzer({ maxRecords: 100 });

			// Record many tools rapidly
			for (let i = 0; i < 50; i++) {
				analyzer.recordTool(`tool_${i}`, { index: i }, true, true);
			}

			expect(analyzer.getRecordCount()).toBe(50);
		});

		it("prunes old records correctly", () => {
			const analyzer = new ToolSequenceAnalyzer({
				maxRecords: 10,
				maxAgeMs: 60000,
			});

			// Record more than max
			for (let i = 0; i < 20; i++) {
				analyzer.recordTool(`tool_${i}`, {}, true, true);
			}

			// Should only keep maxRecords
			expect(analyzer.getRecordCount()).toBe(10);
		});

		it("handles tools with unusual names", () => {
			const analyzer = new ToolSequenceAnalyzer();

			// Should not throw
			expect(() => {
				analyzer.recordTool("", {}, true, true);
				analyzer.recordTool("mcp__server__tool", {}, true, true);
				analyzer.recordTool("tool-with-dashes", {}, true, true);
				analyzer.recordTool("UPPERCASE_TOOL", {}, true, true);
				analyzer.recordTool("tool.with.dots", {}, true, true);
			}).not.toThrow();
		});

		it("handles circular references in args gracefully", () => {
			const analyzer = new ToolSequenceAnalyzer();

			const circular: Record<string, unknown> = { name: "test" };
			circular.self = circular;

			// Should not throw (sanitizeArgs should handle this)
			expect(() => {
				analyzer.recordTool("test", circular, true, true);
			}).not.toThrow();
		});
	});

	describe("security event stats", () => {
		it("tracks events by type correctly", () => {
			// Use unique reasons to avoid event deduplication
			trackToolBlocked({
				toolName: "test-1",
				reason: `Unique blocked reason 1 - ${Date.now()}`,
				source: "firewall",
			});
			trackToolBlocked({
				toolName: "test-2",
				reason: `Unique blocked reason 2 - ${Date.now() + 1}`,
				source: "firewall",
			});
			trackLoopDetection({
				toolName: "test-loop",
				loopType: "exact",
				repetitions: 5,
				action: "warn",
				reason: `Unique loop reason - ${Date.now() + 2}`,
			});

			const stats = getEventStats();
			expect(stats.byType.tool_blocked).toBe(2);
			expect(stats.byType.loop_detected).toBe(1);
			expect(stats.total).toBe(3);
		});

		it("tracks events by severity correctly", () => {
			// tool_blocked events have high severity by default
			trackToolBlocked({
				toolName: "test",
				reason: "Test 1",
				source: "firewall",
			});
			trackToolBlocked({
				toolName: "test",
				reason: "Test 2",
				source: "firewall",
			});

			const stats = getEventStats();
			expect(stats.bySeverity.high).toBeGreaterThanOrEqual(2);
		});

		it("tracks recent high severity events", () => {
			// Circuit breaker state changes to "open" have high severity
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				toolName: "test-breaker",
			});

			// Open the breaker (generates high severity event)
			breaker.trip("test");

			const stats = getEventStats();
			expect(stats.recentHigh).toBeGreaterThanOrEqual(1);
		});
	});
});

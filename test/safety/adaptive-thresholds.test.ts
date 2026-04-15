import { beforeEach, describe, expect, it } from "vitest";
import {
	AdaptiveThresholds,
	DEFAULT_ADAPTIVE_CONFIG,
	METRICS,
} from "../../src/safety/adaptive-thresholds.js";

describe("adaptive-thresholds", () => {
	let thresholds: AdaptiveThresholds;

	beforeEach(() => {
		thresholds = new AdaptiveThresholds({
			minObservations: 3, // Lower for testing
			anomalyThreshold: 2.0,
		});
	});

	describe("recordObservation", () => {
		it("records observations and updates mean", () => {
			thresholds.recordObservation("test_metric", 10);
			thresholds.recordObservation("test_metric", 20);
			thresholds.recordObservation("test_metric", 30);

			const summary = thresholds.getMetricSummary("test_metric");
			expect(summary).not.toBeNull();
			expect(summary!.count).toBe(3);
			// EWMA mean won't be exactly 20, but should be in reasonable range
			expect(summary!.mean).toBeGreaterThan(10);
			expect(summary!.mean).toBeLessThan(30);
		});

		it("tracks min and max values", () => {
			thresholds.recordObservation("test_metric", 5);
			thresholds.recordObservation("test_metric", 15);
			thresholds.recordObservation("test_metric", 10);

			const summary = thresholds.getMetricSummary("test_metric");
			expect(summary!.min).toBe(5);
			expect(summary!.max).toBe(15);
		});

		it("returns null for unknown metric", () => {
			const summary = thresholds.getMetricSummary("unknown");
			expect(summary).toBeNull();
		});
	});

	describe("isAnomaly", () => {
		it("returns false when insufficient observations", () => {
			thresholds.recordObservation("test_metric", 10);
			// Only 1 observation, need 3

			const isAnomaly = thresholds.isAnomaly("test_metric", 100);
			expect(isAnomaly).toBe(false);
		});

		it("returns false for values within normal range", () => {
			// Use a deterministic baseline with realistic spread so the test does not
			// randomly fail when EWMA variance happens to collapse around 10.5.
			for (const value of [
				10.0, 11.0, 10.2, 10.8, 10.3, 10.7, 10.4, 10.6, 10.45, 10.55,
			]) {
				thresholds.recordObservation("test_metric", value);
			}

			// Value close to mean should not be anomaly
			const isAnomaly = thresholds.isAnomaly("test_metric", 10.5);
			expect(isAnomaly).toBe(false);
		});

		it("returns true for values far outside normal range", () => {
			// Record consistent low values
			for (let i = 0; i < 10; i++) {
				thresholds.recordObservation("test_metric", 10);
			}

			// Much higher value should be anomaly
			const isAnomaly = thresholds.isAnomaly("test_metric", 100);
			expect(isAnomaly).toBe(true);
		});

		it("returns false for unknown metric", () => {
			const isAnomaly = thresholds.isAnomaly("unknown", 100);
			expect(isAnomaly).toBe(false);
		});
	});

	describe("checkAnomaly", () => {
		it("provides detailed anomaly information", () => {
			// Record consistent values
			for (let i = 0; i < 5; i++) {
				thresholds.recordObservation("test_metric", 10);
			}

			const result = thresholds.checkAnomaly("test_metric", 100);

			expect(result.isAnomaly).toBe(true);
			expect(result.zScore).toBeGreaterThan(2);
			expect(result.observationCount).toBe(5);
			expect(result.reason).toBeDefined();
		});

		it("provides reason when insufficient observations", () => {
			thresholds.recordObservation("test_metric", 10);

			const result = thresholds.checkAnomaly("test_metric", 100);

			expect(result.isAnomaly).toBe(false);
			expect(result.reason).toContain("Insufficient observations");
		});
	});

	describe("getAdaptedThreshold", () => {
		it("returns default when insufficient observations", () => {
			thresholds.recordObservation("test_metric", 10);
			// Only 1 observation

			const threshold = thresholds.getAdaptedThreshold("test_metric", 50);
			expect(threshold).toBe(50);
		});

		it("returns default for unknown metric", () => {
			const threshold = thresholds.getAdaptedThreshold("unknown", 50);
			expect(threshold).toBe(50);
		});

		it("returns adapted threshold based on observations", () => {
			// Record consistent values around 10
			for (let i = 0; i < 10; i++) {
				thresholds.recordObservation("test_metric", 10);
			}

			const threshold = thresholds.getAdaptedThreshold("test_metric", 50);

			// Should be around mean + 2*stdDev, which should be much less than 50
			expect(threshold).toBeLessThan(50);
			expect(threshold).toBeGreaterThan(5); // At least above some floor
		});
	});

	describe("metric management", () => {
		it("lists all tracked metrics", () => {
			thresholds.recordObservation("metric1", 10);
			thresholds.recordObservation("metric2", 20);
			thresholds.recordObservation("metric3", 30);

			const metrics = thresholds.getAllMetrics();
			expect(metrics).toContain("metric1");
			expect(metrics).toContain("metric2");
			expect(metrics).toContain("metric3");
			expect(metrics.length).toBe(3);
		});

		it("resets specific metric", () => {
			thresholds.recordObservation("metric1", 10);
			thresholds.recordObservation("metric2", 20);

			thresholds.resetMetric("metric1");

			expect(thresholds.getMetricSummary("metric1")).toBeNull();
			expect(thresholds.getMetricSummary("metric2")).not.toBeNull();
		});

		it("clears all metrics", () => {
			thresholds.recordObservation("metric1", 10);
			thresholds.recordObservation("metric2", 20);

			thresholds.clear();

			expect(thresholds.getAllMetrics().length).toBe(0);
		});

		it("provides summary of all metrics", () => {
			thresholds.recordObservation("metric1", 10);
			thresholds.recordObservation("metric2", 20);

			const summary = thresholds.getSummary();

			expect(summary.metric1).toBeDefined();
			expect(summary.metric2).toBeDefined();
			expect(summary.metric1.mean).toBe(10);
			expect(summary.metric2.mean).toBe(20);
		});
	});

	describe("time-based behavior", () => {
		it("resets metric when data is too old", async () => {
			const shortLivedThresholds = new AdaptiveThresholds({
				maxAgeMs: 50, // 50ms max age
				minObservations: 3,
			});

			// Record initial observation
			shortLivedThresholds.recordObservation("test_metric", 10);
			shortLivedThresholds.recordObservation("test_metric", 10);
			shortLivedThresholds.recordObservation("test_metric", 10);
			expect(shortLivedThresholds.getMetricSummary("test_metric")!.count).toBe(
				3,
			);

			// Wait for data to become stale
			await new Promise((resolve) => setTimeout(resolve, 100));

			// New observation should reset the metric
			shortLivedThresholds.recordObservation("test_metric", 100);

			const summary = shortLivedThresholds.getMetricSummary("test_metric");
			expect(summary!.count).toBe(1); // Reset to new observation only
			expect(summary!.mean).toBe(100);
		});

		it("prunes stale metrics", async () => {
			const shortLivedThresholds = new AdaptiveThresholds({
				maxAgeMs: 50, // 50ms max age
				minObservations: 1,
			});

			shortLivedThresholds.recordObservation("metric1", 10);
			shortLivedThresholds.recordObservation("metric2", 20);

			// Wait for data to become stale
			await new Promise((resolve) => setTimeout(resolve, 100));

			const pruned = shortLivedThresholds.pruneStaleMetrics();

			expect(pruned).toBe(2);
			expect(shortLivedThresholds.getAllMetrics().length).toBe(0);
		});
	});

	describe("EWMA convergence", () => {
		it("converges to new mean when values change", () => {
			// Start with values around 10
			for (let i = 0; i < 10; i++) {
				thresholds.recordObservation("test_metric", 10);
			}

			const summary1 = thresholds.getMetricSummary("test_metric");
			expect(summary1!.mean).toBeCloseTo(10, 0);

			// Switch to values around 50
			for (let i = 0; i < 20; i++) {
				thresholds.recordObservation("test_metric", 50);
			}

			const summary2 = thresholds.getMetricSummary("test_metric");
			// Should have moved significantly toward 50
			expect(summary2!.mean).toBeGreaterThan(40);
		});

		it("responds to value spikes", () => {
			// Establish baseline
			for (let i = 0; i < 5; i++) {
				thresholds.recordObservation("test_metric", 10);
			}

			// Record a spike
			thresholds.recordObservation("test_metric", 100);

			const summary = thresholds.getMetricSummary("test_metric");
			// Mean should have increased but not jumped to 100
			expect(summary!.mean).toBeGreaterThan(10);
			expect(summary!.mean).toBeLessThan(100);
			// Std dev should have increased
			expect(summary!.stdDev).toBeGreaterThan(0);
		});
	});

	describe("DEFAULT_ADAPTIVE_CONFIG", () => {
		it("has sensible defaults", () => {
			expect(DEFAULT_ADAPTIVE_CONFIG.alpha).toBe(0.3);
			expect(DEFAULT_ADAPTIVE_CONFIG.anomalyThreshold).toBe(2.0);
			expect(DEFAULT_ADAPTIVE_CONFIG.minObservations).toBe(20); // Increased for cold start protection
			expect(DEFAULT_ADAPTIVE_CONFIG.maxAgeMs).toBe(3600000); // 1 hour
			expect(DEFAULT_ADAPTIVE_CONFIG.stdDevFloor).toBe(0.1);
			expect(DEFAULT_ADAPTIVE_CONFIG.anchoredBaselineSize).toBe(50);
			expect(DEFAULT_ADAPTIVE_CONFIG.enableColdStartProtection).toBe(true);
		});
	});

	describe("METRICS constants", () => {
		it("provides predefined metric names", () => {
			expect(METRICS.TOOL_CALLS_PER_MINUTE).toBe("tool_calls_per_minute");
			expect(METRICS.READS_PER_MINUTE).toBe("reads_per_minute");
			expect(METRICS.FAILURE_RATE).toBe("failure_rate");
			expect(METRICS.SENSITIVE_ACCESSES).toBe("sensitive_accesses");
		});
	});
});

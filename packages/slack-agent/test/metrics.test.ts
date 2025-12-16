import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	MetricsCollector,
	createMetricsCollector,
	createSlackMetrics,
} from "../src/utils/metrics.js";

describe("MetricsCollector", () => {
	let collector: MetricsCollector;

	beforeEach(() => {
		collector = new MetricsCollector();
	});

	describe("counters", () => {
		it("increments counter", () => {
			collector.increment("requests");
			collector.increment("requests");
			collector.increment("requests");

			expect(collector.getCounter("requests")).toBe(3);
		});

		it("increments by custom value", () => {
			collector.increment("bytes", undefined, 1024);
			collector.increment("bytes", undefined, 512);

			expect(collector.getCounter("bytes")).toBe(1536);
		});

		it("decrements counter", () => {
			collector.increment("queue_size", undefined, 10);
			collector.decrement("queue_size");
			collector.decrement("queue_size");

			expect(collector.getCounter("queue_size")).toBe(8);
		});

		it("supports tags", () => {
			collector.increment("requests", { method: "GET" });
			collector.increment("requests", { method: "POST" });
			collector.increment("requests", { method: "GET" });

			expect(collector.getCounter("requests", { method: "GET" })).toBe(2);
			expect(collector.getCounter("requests", { method: "POST" })).toBe(1);
		});

		it("returns 0 for non-existent counter", () => {
			expect(collector.getCounter("nonexistent")).toBe(0);
		});
	});

	describe("gauges", () => {
		it("sets gauge value", () => {
			collector.gauge("temperature", 72.5);
			expect(collector.getGauge("temperature")).toBe(72.5);
		});

		it("overwrites gauge value", () => {
			collector.gauge("connections", 10);
			collector.gauge("connections", 15);
			expect(collector.getGauge("connections")).toBe(15);
		});

		it("supports tags", () => {
			collector.gauge("cpu_usage", 45, { core: 0 });
			collector.gauge("cpu_usage", 60, { core: 1 });

			expect(collector.getGauge("cpu_usage", { core: 0 })).toBe(45);
			expect(collector.getGauge("cpu_usage", { core: 1 })).toBe(60);
		});

		it("returns undefined for non-existent gauge", () => {
			expect(collector.getGauge("nonexistent")).toBeUndefined();
		});
	});

	describe("histograms", () => {
		it("records histogram values", () => {
			collector.histogram("latency", 10);
			collector.histogram("latency", 20);
			collector.histogram("latency", 30);

			const summary = collector.getHistogram("latency");
			expect(summary).toBeDefined();
			expect(summary?.count).toBe(3);
			expect(summary?.sum).toBe(60);
			expect(summary?.avg).toBe(20);
		});

		it("calculates min and max", () => {
			collector.histogram("latency", 100);
			collector.histogram("latency", 50);
			collector.histogram("latency", 200);

			const summary = collector.getHistogram("latency");
			expect(summary?.min).toBe(50);
			expect(summary?.max).toBe(200);
		});

		it("calculates percentiles", () => {
			// Add 100 values: 1, 2, 3, ..., 100
			for (let i = 1; i <= 100; i++) {
				collector.histogram("latency", i);
			}

			const summary = collector.getHistogram("latency");
			expect(summary?.p50).toBe(50);
			expect(summary?.p90).toBe(90);
			expect(summary?.p99).toBe(99);
		});

		it("supports tags", () => {
			collector.histogram("latency", 10, { endpoint: "/api" });
			collector.histogram("latency", 20, { endpoint: "/health" });

			expect(
				collector.getHistogram("latency", { endpoint: "/api" })?.count,
			).toBe(1);
			expect(
				collector.getHistogram("latency", { endpoint: "/health" })?.count,
			).toBe(1);
		});

		it("returns undefined for non-existent histogram", () => {
			expect(collector.getHistogram("nonexistent")).toBeUndefined();
		});

		it("respects max entries limit", () => {
			const limited = new MetricsCollector({ maxHistogramEntries: 5 });

			for (let i = 0; i < 10; i++) {
				limited.histogram("test", i);
			}

			const summary = limited.getHistogram("test");
			expect(summary?.count).toBe(5);
			// Should have values 5-9 (oldest trimmed)
			expect(summary?.min).toBe(5);
		});
	});

	describe("timers", () => {
		it("records timing to histogram", async () => {
			const timer = collector.startTimer("operation");
			await new Promise((r) => setTimeout(r, 10));
			const duration = timer.end();

			// Allow 2ms jitter for timer imprecision
			expect(duration).toBeGreaterThanOrEqual(8);

			const summary = collector.getHistogram("operation");
			expect(summary?.count).toBe(1);
			expect(summary?.avg).toBeGreaterThanOrEqual(8);
		});

		it("time() records async function duration", async () => {
			const result = await collector.time(
				"async_op",
				async () => {
					await new Promise((r) => setTimeout(r, 15));
					return "done";
				},
				{ type: "test" },
			);

			expect(result).toBe("done");

			const summary = collector.getHistogram("async_op", { type: "test" });
			expect(summary?.count).toBe(1);
			// Use a lower bound to account for timer precision
			expect(summary?.avg).toBeGreaterThanOrEqual(10);
		});

		it("time() records duration even on error", async () => {
			await expect(
				collector.time("failing_op", async () => {
					await new Promise((r) => setTimeout(r, 5));
					throw new Error("fail");
				}),
			).rejects.toThrow("fail");

			const summary = collector.getHistogram("failing_op");
			expect(summary?.count).toBe(1);
		});
	});

	describe("getSummary", () => {
		it("returns all metrics", () => {
			collector.increment("counter1");
			collector.gauge("gauge1", 42);
			collector.histogram("hist1", 100);

			const summary = collector.getSummary();

			expect(summary.counters.counter1).toBe(1);
			expect(summary.gauges.gauge1).toBe(42);
			expect(summary.histograms.hist1.count).toBe(1);
		});
	});

	describe("toPrometheus", () => {
		it("exports counters in Prometheus format", () => {
			collector.increment("http_requests", { method: "GET" });

			const output = collector.toPrometheus();

			expect(output).toContain("# TYPE http_requests counter");
			expect(output).toContain("http_requests{method=GET} 1");
		});

		it("exports gauges in Prometheus format", () => {
			collector.gauge("temperature", 72.5);

			const output = collector.toPrometheus();

			expect(output).toContain("# TYPE temperature gauge");
			expect(output).toContain("temperature 72.5");
		});

		it("exports histograms as summaries", () => {
			collector.histogram("latency", 10);
			collector.histogram("latency", 20);

			const output = collector.toPrometheus();

			expect(output).toContain("# TYPE latency summary");
			expect(output).toContain('latency{quantile="0.5"}');
			expect(output).toContain("latency_count 2");
			expect(output).toContain("latency_sum 30");
		});
	});

	describe("reset", () => {
		it("clears all metrics", () => {
			collector.increment("counter");
			collector.gauge("gauge", 1);
			collector.histogram("hist", 1);

			collector.reset();

			expect(collector.getCounter("counter")).toBe(0);
			expect(collector.getGauge("gauge")).toBeUndefined();
			expect(collector.getHistogram("hist")).toBeUndefined();
		});

		it("resetMetric clears specific metric", () => {
			collector.increment("keep");
			collector.increment("remove");

			collector.resetMetric("remove");

			expect(collector.getCounter("keep")).toBe(1);
			expect(collector.getCounter("remove")).toBe(0);
		});
	});

	describe("prefix", () => {
		it("adds prefix to metric names", () => {
			const prefixed = new MetricsCollector({ prefix: "myapp" });

			prefixed.increment("requests");

			const summary = prefixed.getSummary();
			expect(summary.counters.myapp_requests).toBe(1);
		});
	});
});

describe("createMetricsCollector", () => {
	it("creates collector with defaults", () => {
		const collector = createMetricsCollector();
		expect(collector).toBeInstanceOf(MetricsCollector);
	});

	it("creates collector with config", () => {
		const collector = createMetricsCollector({
			prefix: "test",
			maxHistogramEntries: 500,
		});
		expect(collector).toBeInstanceOf(MetricsCollector);
	});
});

describe("createSlackMetrics", () => {
	it("creates slack-specific metrics helper", () => {
		const metrics = createSlackMetrics();
		expect(metrics.collector).toBeInstanceOf(MetricsCollector);
		expect(typeof metrics.trackApiCall).toBe("function");
		expect(typeof metrics.trackError).toBe("function");
	});

	it("trackApiCall records success metrics", async () => {
		const metrics = createSlackMetrics();

		await metrics.trackApiCall("chat.postMessage", async () => "ok");

		// Note: prefix is applied internally, so don't include it in getCounter
		expect(
			metrics.collector.getCounter("api_calls_total", {
				method: "chat.postMessage",
			}),
		).toBe(1);
		expect(
			metrics.collector.getCounter("api_success_total", {
				method: "chat.postMessage",
			}),
		).toBe(1);
	});

	it("trackApiCall records error metrics", async () => {
		const metrics = createSlackMetrics();

		await expect(
			metrics.trackApiCall("chat.postMessage", async () => {
				throw new Error("fail");
			}),
		).rejects.toThrow("fail");

		expect(
			metrics.collector.getCounter("api_calls_total", {
				method: "chat.postMessage",
			}),
		).toBe(1);
		expect(
			metrics.collector.getCounter("api_errors_total", {
				method: "chat.postMessage",
			}),
		).toBe(1);
	});

	it("trackApiCall records latency histogram", async () => {
		const metrics = createSlackMetrics();

		await metrics.trackApiCall("auth.test", async () => {
			await new Promise((r) => setTimeout(r, 5));
			return { ok: true };
		});

		const hist = metrics.collector.getHistogram("api_latency_ms", {
			method: "auth.test",
		});
		expect(hist?.count).toBe(1);
		expect(hist?.avg).toBeGreaterThanOrEqual(5);
	});

	it("trackRateLimit increments rate limit counter", () => {
		const metrics = createSlackMetrics();

		metrics.trackRateLimit("chat.postMessage");
		metrics.trackRateLimit("chat.postMessage");

		expect(
			metrics.collector.getCounter("rate_limits_total", {
				method: "chat.postMessage",
			}),
		).toBe(2);
	});

	it("trackMessageSent increments message counter", () => {
		const metrics = createSlackMetrics();

		metrics.trackMessageSent("general");
		metrics.trackMessageSent("random");
		metrics.trackMessageSent("general");

		expect(
			metrics.collector.getCounter("messages_sent_total", {
				channel: "general",
			}),
		).toBe(2);
		expect(
			metrics.collector.getCounter("messages_sent_total", {
				channel: "random",
			}),
		).toBe(1);
	});

	it("uses custom prefix", () => {
		const metrics = createSlackMetrics("mybot");

		metrics.trackMessageSent("test");

		const summary = metrics.collector.getSummary();
		expect(summary.counters["mybot_messages_sent_total{channel=test}"]).toBe(1);
	});
});

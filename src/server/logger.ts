import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import v8 from "node:v8";
import { circuitBreakers } from "./circuit-breaker.js";
import {
	type RequestContext,
	requestContextStorage,
} from "./request-context.js";

const ESC = "\u001B[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

// Foreground colors
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;

const LOG_FORMAT =
	process.env.COMPOSER_LOG_FORMAT?.toLowerCase() === "json" ? "json" : "text";

const LOAD_SHEDDING_THRESHOLD_MS =
	Number.parseInt(
		process.env.COMPOSER_LOAD_SHEDDING_THRESHOLD_MS || "200",
		10,
	) || 200;

// Dapper-style Sampling: Default to 100% in dev, configurable in prod
const LOG_SAMPLE_RATE = Number.parseFloat(
	process.env.COMPOSER_LOG_SAMPLE_RATE || "1.0",
);

const HISTOGRAM_SIZE = 1000;

function colorize(text: string | number, color: string): string {
	if (LOG_FORMAT === "json") return String(text);
	return `${color}${text}${RESET}`;
}

export function formatMethod(method = "GET"): string {
	if (LOG_FORMAT === "json") return method.toUpperCase();
	switch (method.toUpperCase()) {
		case "GET":
			return colorize(method.padEnd(7), BLUE);
		case "POST":
			return colorize(method.padEnd(7), GREEN);
		case "DELETE":
			return colorize(method.padEnd(7), RED);
		case "PUT":
			return colorize(method.padEnd(7), YELLOW);
		case "PATCH":
			return colorize(method.padEnd(7), MAGENTA);
		case "OPTIONS":
			return colorize(method.padEnd(7), DIM);
		default:
			return colorize(method.padEnd(7), RESET);
	}
}

export function formatStatus(status: number): string {
	if (LOG_FORMAT === "json") return String(status);
	if (status >= 500) return colorize(status, RED);
	if (status >= 400) return colorize(status, YELLOW);
	if (status >= 300) return colorize(status, CYAN);
	if (status >= 200) return colorize(status, GREEN);
	return colorize(status, DIM);
}

export function formatDuration(start: number): string {
	const duration = performance.now() - start;
	if (LOG_FORMAT === "json") return duration.toFixed(2);
	const text = `${duration.toFixed(2)}ms`;
	if (duration > 1000) return colorize(text, RED);
	if (duration > 500) return colorize(text, YELLOW);
	return colorize(text, DIM);
}

// Simple histogram implementation for P50/P95/P99
class Histogram {
	private values: number[] = [];
	private maxSize: number;

	constructor(maxSize = 1000) {
		this.maxSize = maxSize;
	}

	add(value: number) {
		this.values.push(value);
		if (this.values.length > this.maxSize) {
			this.values.shift();
		}
	}

	getPercentile(percentile: number): number {
		if (this.values.length === 0) return 0;
		const sorted = [...this.values].sort((a, b) => a - b);
		const index = Math.ceil((percentile / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}
}

// Event Loop Monitor
const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
loopMonitor.enable();

// --- Prometheus / Borgmon Style Metrics ---

interface Counter {
	name: string;
	help: string;
	values: Map<string, number>; // labelString -> value
}

interface Gauge {
	name: string;
	help: string;
	getValue: () => number | Promise<number>;
}

const registry = {
	counters: new Map<string, Counter>(),
	gauges: new Map<string, Gauge>(),
};

export function registerGauge(
	name: string,
	help: string,
	getValue: () => number | Promise<number>,
): void {
	registry.gauges.set(name, { name, help, getValue });
}

function getCounter(name: string, help: string): Counter {
	if (!registry.counters.has(name)) {
		registry.counters.set(name, { name, help, values: new Map() });
	}
	// biome-ignore lint/style/noNonNullAssertion: we just set it if it was missing
	return registry.counters.get(name)!;
}

function incCounter(name: string, labels: Record<string, string>, value = 1) {
	// Simple label serialization: method="GET",status="200"
	const labelKey = Object.entries(labels)
		.sort(([k1], [k2]) => k1.localeCompare(k2))
		.map(([k, v]) => `${k}="${v}"`)
		.join(",");

	const counter = getCounter(name, "Dynamic counter"); // Help text is simplified here
	const current = counter.values.get(labelKey) || 0;
	counter.values.set(labelKey, current + value);
}

// Initialize standard counters
getCounter("http_requests_total", "Total number of HTTP requests");
getCounter(
	"http_request_duration_seconds_sum",
	"Total duration of HTTP requests",
);
getCounter(
	"http_request_duration_seconds_count",
	"Count of HTTP requests for duration",
);

// --- End Metrics ---

// Request stats tracking (Internal snapshot)
export interface RequestStats {
	total: number;
	errors: number;
	rateLimited: number;
	totalDuration: number;
	startTime: number;
	requestsPerSecond: number;
	latencyP50: number;
	latencyP95: number;
	latencyP99: number;
	eventLoopLag: number;
}

const stats: RequestStats = {
	total: 0,
	errors: 0,
	rateLimited: 0,
	totalDuration: 0,
	startTime: Date.now(),
	requestsPerSecond: 0,
	latencyP50: 0,
	latencyP95: 0,
	latencyP99: 0,
	eventLoopLag: 0,
};

const latencyHistogram = new Histogram(HISTOGRAM_SIZE);

let statsInterval: NodeJS.Timeout | null = null;

export function startStatsCollection() {
	if (statsInterval) return;
	stats.startTime = Date.now();
	stats.total = 0;
	stats.errors = 0;
	stats.rateLimited = 0;
	stats.totalDuration = 0;
	stats.requestsPerSecond = 0;

	let lastTotal = 0;

	statsInterval = setInterval(() => {
		const now = Date.now();
		const currentTotal = stats.total;
		const diff = currentTotal - lastTotal;
		const rps = diff / 5; // 5 seconds interval
		lastTotal = currentTotal;

		stats.requestsPerSecond = rps;
		stats.latencyP50 = latencyHistogram.getPercentile(50);
		stats.latencyP95 = latencyHistogram.getPercentile(95);
		stats.latencyP99 = latencyHistogram.getPercentile(99);
		stats.eventLoopLag = loopMonitor.mean / 1_000_000;

		loopMonitor.reset();
	}, 5000);

	// Don't keep process alive
	if (statsInterval.unref) {
		statsInterval.unref();
	}
}

export function stopStatsCollection() {
	if (statsInterval) {
		clearInterval(statsInterval);
		statsInterval = null;
	}
	loopMonitor.disable();
}

export function isOverloaded(): boolean {
	return loopMonitor.mean / 1_000_000 > LOAD_SHEDDING_THRESHOLD_MS;
}

export function getStatsSnapshot(): RequestStats {
	return { ...stats };
}

export async function getPrometheusMetrics(): Promise<string> {
	const lines: string[] = [];

	// Counters
	for (const counter of registry.counters.values()) {
		lines.push(`# HELP ${counter.name} ${counter.help}`);
		lines.push(`# TYPE ${counter.name} counter`);
		for (const [labels, value] of counter.values.entries()) {
			lines.push(`${counter.name}{${labels}} ${value}`);
		}
	}

	// Custom gauges
	for (const gauge of registry.gauges.values()) {
		lines.push(`# HELP ${gauge.name} ${gauge.help}`);
		lines.push(`# TYPE ${gauge.name} gauge`);
		try {
			const value = await gauge.getValue();
			lines.push(`${gauge.name} ${value}`);
		} catch {
			// Skip failed gauges
		}
	}

	// Process metrics
	lines.push("# HELP process_event_loop_lag_seconds Average event loop lag");
	lines.push("# TYPE process_event_loop_lag_seconds gauge");
	lines.push(`process_event_loop_lag_seconds ${stats.eventLoopLag / 1000}`);

	lines.push("# HELP http_requests_per_second Current RPS");
	lines.push("# TYPE http_requests_per_second gauge");
	lines.push(`http_requests_per_second ${stats.requestsPerSecond}`);

	// Memory metrics
	const heapStats = v8.getHeapStatistics();
	lines.push("# HELP nodejs_heap_size_total_bytes Total heap size");
	lines.push("# TYPE nodejs_heap_size_total_bytes gauge");
	lines.push(`nodejs_heap_size_total_bytes ${heapStats.total_heap_size}`);

	lines.push("# HELP nodejs_heap_size_used_bytes Used heap size");
	lines.push("# TYPE nodejs_heap_size_used_bytes gauge");
	lines.push(`nodejs_heap_size_used_bytes ${heapStats.used_heap_size}`);

	// Circuit Breakers
	for (const [name, breaker] of circuitBreakers.entries()) {
		const state = breaker.getState();
		const stateVal = state === "CLOSED" ? 0 : state === "OPEN" ? 1 : 0.5;
		lines.push(
			`# HELP circuit_breaker_state State of circuit breaker ${name} (0=closed, 1=open, 0.5=half-open)`,
		);
		lines.push("# TYPE circuit_breaker_state gauge");
		lines.push(`circuit_breaker_state{name="${name}"} ${stateVal}`);
	}

	return lines.join("\n");
}

export function getStatsSummary(): string {
	const rps = stats.requestsPerSecond.toFixed(2);
	const p99 = stats.latencyP99.toFixed(0);
	const errorRate =
		stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : "0.0";
	const rateLimitCount = stats.rateLimited;
	const lag = stats.eventLoopLag.toFixed(1);

	return `${colorize("RPS:", DIM)} ${colorize(rps, CYAN)} | ${colorize("P99:", DIM)} ${colorize(`${p99}ms`, CYAN)} | ${colorize("Err:", DIM)} ${colorize(`${errorRate}%`, stats.errors > 0 ? RED : GREEN)} | ${colorize("RL:", DIM)} ${colorize(rateLimitCount, rateLimitCount > 0 ? YELLOW : DIM)} | ${colorize("Lag:", DIM)} ${colorize(`${lag}ms`, stats.eventLoopLag > 50 ? YELLOW : GREEN)}`;
}

// CLFK: Capture call site location
function getCallSite() {
	const oldPrepareStackTrace = Error.prepareStackTrace;
	try {
		Error.prepareStackTrace = (_, stack) => stack;
		const err = new Error();
		const stack = err.stack as unknown as NodeJS.CallSite[];

		// Walk up the stack to find the caller outside of this file
		for (const frame of stack) {
			const fileName = frame.getFileName();
			// Skip internal node modules and this file
			if (
				fileName &&
				!fileName.startsWith("node:") &&
				!fileName.includes("logger.ts")
			) {
				return {
					file: fileName ? basename(fileName) : undefined, // Just basename for cleaner logs
					line: frame.getLineNumber(),
					function: frame.getFunctionName() || "<anonymous>",
				};
			}
		}
	} catch {
		// Fallback if something goes wrong
	} finally {
		Error.prepareStackTrace = oldPrepareStackTrace;
	}
	return undefined;
}

export function logError(error: Error | string) {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	const store = requestContextStorage.getStore();
	const requestId = store?.requestId;
	const traceId = store?.traceId;
	const callSite = getCallSite();

	if (LOG_FORMAT === "json") {
		console.error(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level: "error",
				message,
				stack,
				requestId,
				traceId,
				source: callSite,
			}),
		);
		return;
	}

	const sourceInfo = callSite
		? ` ${colorize(`(${callSite.file}:${callSite.line})`, DIM)}`
		: "";
	console.error(
		`${colorize(`[ERROR${requestId ? ` ${requestId.slice(0, 8)}` : ""}]`, RED)}${sourceInfo} ${message}`,
	);
	if (stack) {
		console.error(colorize(stack, DIM));
	}
}

export function logRequest(
	req: IncomingMessage,
	statusCode: number,
	start: number,
) {
	const duration = performance.now() - start;
	latencyHistogram.add(duration);

	const store = requestContextStorage.getStore();
	const requestId = store?.requestId || "unknown";
	const traceId = store?.traceId;
	const shortId = requestId.slice(0, 8);

	// Update internal stats
	stats.total++;
	stats.totalDuration += duration;
	if (statusCode >= 400) stats.errors++;
	if (statusCode === 429) stats.rateLimited++;

	// Update Prometheus metrics
	const method = req.method || "UNKNOWN";
	const url = req.url || "/";
	const route = url.split("?")[0];

	incCounter("http_requests_total", {
		method,
		route,
		status: statusCode.toString(),
	});
	incCounter(
		"http_request_duration_seconds_sum",
		{ method, route },
		duration / 1000,
	);
	incCounter("http_request_duration_seconds_count", { method, route });

	// SAMPLING LOGIC
	// Always log errors (>= 400) or if sampled in
	const isError = statusCode >= 400;
	const shouldLog = isError || Math.random() < LOG_SAMPLE_RATE;

	if (!shouldLog) {
		return;
	}

	if (LOG_FORMAT === "json") {
		console.log(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level: isError ? (statusCode >= 500 ? "error" : "warn") : "info",
				requestId,
				traceId,
				method: req.method,
				url: req.url,
				statusCode,
				durationMs: duration,
				userAgent: req.headers["user-agent"],
				metrics: {
					eventLoopLag: loopMonitor.mean / 1_000_000,
					p99: stats.latencyP99,
					rateLimited: stats.rateLimited,
				},
			}),
		);
		return;
	}

	const methodStr = formatMethod(req.method);
	const statusStr = formatStatus(statusCode);
	const durationStr = formatDuration(start);

	// Add stats to the log line
	const statsSummary = getStatsSummary();

	console.log(
		`${colorize(`[${shortId}]`, DIM)} ${methodStr} ${statusStr} ${durationStr} ${url.padEnd(40)} ${statsSummary}`,
	);
}

export function logStartup(port: number) {
	if (LOG_FORMAT === "json") {
		console.log(
			JSON.stringify({
				level: "info",
				message: "Server started",
				port,
				localUrl: `http://localhost:${port}`,
				apiUrl: `http://localhost:${port}/api`,
			}),
		);
		return;
	}

	console.clear();
	const line = colorize("─".repeat(80), DIM);

	console.log(`\n${line}`);
	console.log(`  ${colorize("COMPOSER WEB SERVER", BOLD + BLUE)}`);
	console.log(`${line}\n`);

	console.log(
		`  ${colorize("►", GREEN)}  Local:    ${colorize(`http://localhost:${port}`, CYAN)}`,
	);
	console.log(
		`  ${colorize("►", GREEN)}  API:      ${colorize(`http://localhost:${port}/api`, CYAN)}`,
	);
	console.log(
		`  ${colorize("►", GREEN)}  Monitor:  ${colorize("Live stats enabled", DIM)}`,
	);
	console.log(
		`  ${colorize("►", GREEN)}  Safety:   ${colorize(`Load shedding > ${LOAD_SHEDDING_THRESHOLD_MS}ms lag`, DIM)}`,
	);

	console.log(`\n${line}\n`);
	console.log(colorize("  Ready to accept requests...", DIM));
}

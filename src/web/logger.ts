import type { IncomingMessage } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
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

const HISTOGRAM_SIZE = 100;

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
			this.values.shift(); // Keep simple sliding window
		}
	}

	getPercentile(percentile: number): number {
		if (this.values.length === 0) return 0;
		// Sort copy to avoid mutating data
		const sorted = [...this.values].sort((a, b) => a - b);
		const index = Math.ceil((percentile / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}
}

// Event Loop Monitor
const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
loopMonitor.enable();

// Request stats tracking
export interface RequestStats {
	total: number;
	errors: number;
	totalDuration: number;
	startTime: number;
	requestsPerSecond: number;
	latencyP50: number;
	latencyP95: number;
	latencyP99: number;
	eventLoopLag: number; // Current event loop lag in ms
}

const stats: RequestStats = {
	total: 0,
	errors: 0,
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
	stats.totalDuration = 0;
	stats.requestsPerSecond = 0;

	let lastTotal = 0;

	statsInterval = setInterval(() => {
		const now = Date.now();
		// Calculate RPS for this interval
		const currentTotal = stats.total;
		const diff = currentTotal - lastTotal;
		const rps = diff / 5; // 5 seconds interval
		lastTotal = currentTotal;

		stats.requestsPerSecond = rps;
		stats.latencyP50 = latencyHistogram.getPercentile(50);
		stats.latencyP95 = latencyHistogram.getPercentile(95);
		stats.latencyP99 = latencyHistogram.getPercentile(99);

		// Convert nanoseconds to milliseconds
		stats.eventLoopLag = loopMonitor.mean / 1_000_000;
		loopMonitor.reset();
	}, 5000);
}

export function stopStatsCollection() {
	if (statsInterval) {
		clearInterval(statsInterval);
		statsInterval = null;
	}
	loopMonitor.disable();
}

export function isOverloaded(): boolean {
	// Check if event loop lag exceeds threshold
	return loopMonitor.mean / 1_000_000 > LOAD_SHEDDING_THRESHOLD_MS;
}

export function getStatsSnapshot(): RequestStats {
	return { ...stats };
}

export function getStatsSummary(): string {
	const rps = stats.requestsPerSecond.toFixed(2);
	const p99 = stats.latencyP99.toFixed(0);
	const errorRate =
		stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : "0.0";
	const lag = stats.eventLoopLag.toFixed(1);

	// Compact summary
	// RPS: 12.50 | P99: 120ms | Err: 0.0% | Lag: 5.2ms
	return `${colorize("RPS:", DIM)} ${colorize(rps, CYAN)} | ${colorize("P99:", DIM)} ${colorize(`${p99}ms`, CYAN)} | ${colorize("Err:", DIM)} ${colorize(`${errorRate}%`, stats.errors > 0 ? RED : GREEN)} | ${colorize("Lag:", DIM)} ${colorize(`${lag}ms`, stats.eventLoopLag > 50 ? YELLOW : GREEN)}`;
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
	const shortId = requestId.slice(0, 8);

	// Update stats
	stats.total++;
	stats.totalDuration += duration;
	if (statusCode >= 400) stats.errors++;

	if (LOG_FORMAT === "json") {
		console.log(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level:
					statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
				requestId,
				method: req.method,
				url: req.url,
				statusCode,
				durationMs: duration,
				userAgent: req.headers["user-agent"],
				metrics: {
					eventLoopLag: loopMonitor.mean / 1_000_000,
					p99: stats.latencyP99,
				},
			}),
		);
		return;
	}

	const method = formatMethod(req.method);
	const status = formatStatus(statusCode);
	const durationText = formatDuration(start);
	const url = req.url || "/";

	// Add stats to the log line
	const statsSummary = getStatsSummary();

	console.log(
		`${colorize(`[${shortId}]`, DIM)} ${method} ${status} ${durationText} ${url.padEnd(40)} ${statsSummary}`,
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

import type { IncomingMessage } from "node:http";
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

// Request stats tracking
export interface RequestStats {
	total: number;
	errors: number;
	totalDuration: number;
	startTime: number;
	requestsPerSecond: number;
}

const stats: RequestStats = {
	total: 0,
	errors: 0,
	totalDuration: 0,
	startTime: Date.now(),
	requestsPerSecond: 0,
};

let statsInterval: NodeJS.Timeout | null = null;

export function startStatsCollection() {
	if (statsInterval) return;
	stats.startTime = Date.now();
	stats.total = 0;
	stats.errors = 0;
	stats.totalDuration = 0;
	stats.requestsPerSecond = 0;

	statsInterval = setInterval(() => {
		const now = Date.now();
		const elapsedSeconds = (now - stats.startTime) / 1000;
		if (elapsedSeconds > 0) {
			stats.requestsPerSecond = stats.total / elapsedSeconds;
		}
	}, 5000);
}

export function stopStatsCollection() {
	if (statsInterval) {
		clearInterval(statsInterval);
		statsInterval = null;
	}
}

export function getStatsSnapshot(): RequestStats {
	return { ...stats };
}

export function getStatsSummary(): string {
	const now = Date.now();
	const elapsedSeconds = (now - stats.startTime) / 1000;
	const rps =
		elapsedSeconds > 0 ? (stats.total / elapsedSeconds).toFixed(2) : "0.00";
	const avgDuration =
		stats.total > 0 ? (stats.totalDuration / stats.total).toFixed(2) : "0.00";
	const errorRate =
		stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : "0.0";

	return `${colorize("RPS:", DIM)} ${colorize(rps, CYAN)} | ${colorize("Avg:", DIM)} ${colorize(`${avgDuration}ms`, CYAN)} | ${colorize("Err:", DIM)} ${colorize(`${errorRate}%`, stats.errors > 0 ? RED : GREEN)}`;
}

export function logRequest(
	req: IncomingMessage,
	statusCode: number,
	start: number,
) {
	const duration = performance.now() - start;
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

	console.log(`\n${line}\n`);
	console.log(colorize("  Ready to accept requests...", DIM));
}

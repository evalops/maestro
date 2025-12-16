/**
 * Console logging utilities for the Slack agent
 *
 * Supports structured logging with automatic context propagation.
 * Uses AsyncLocalStorage for proper async context tracking across
 * concurrent requests.
 *
 * Use runWithContext() to attach context that will be included in
 * all log messages within that execution scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import chalk from "chalk";

export interface LogContext {
	channelId: string;
	userName?: string;
	channelName?: string;
	threadTs?: string;
	runId?: string;
	taskId?: string;
	source?: "channel" | "dm" | "slash" | "scheduled";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogOutputOptions {
	/** Output format: 'pretty' for colored console, 'json' for structured logs */
	format?: "pretty" | "json";
	/** Minimum log level to output */
	minLevel?: LogLevel;
}

// ============================================================================
// Configuration
// ============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let outputFormat: "pretty" | "json" = "pretty";
let minLogLevel: LogLevel = "debug";

/**
 * Configure log output options
 */
export function configureLogger(options: LogOutputOptions): void {
	if (options.format) outputFormat = options.format;
	if (options.minLevel) minLogLevel = options.minLevel;
}

function shouldLog(level: LogLevel): boolean {
	return LOG_LEVELS[level] >= LOG_LEVELS[minLogLevel];
}

// ============================================================================
// Context Management (AsyncLocalStorage-based)
// ============================================================================

const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Get the current logging context from AsyncLocalStorage
 */
export function getCurrentContext(): LogContext | null {
	return contextStorage.getStore() ?? null;
}

/**
 * Run a function with a specific logging context.
 * Context is automatically propagated through all async operations.
 * This is the preferred way to set context for async code.
 */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
	return contextStorage.run(ctx, fn);
}

/**
 * @deprecated Use runWithContext() instead - it properly handles async context
 */
export function setCurrentContext(_ctx: LogContext | null): void {
	// No-op: kept for backward compatibility but does nothing
	// Context should be set via runWithContext()
}

/**
 * @deprecated Use runWithContext() instead
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
	return runWithContext(ctx, fn);
}

/**
 * @deprecated Use runWithContext() instead - it handles both sync and async
 */
export async function withContextAsync<T>(
	ctx: LogContext,
	fn: () => Promise<T>,
): Promise<T> {
	return runWithContext(ctx, fn);
}

/**
 * Generate a unique run ID for tracking request execution
 */
export function generateRunId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${timestamp}_${random}`;
}

// ============================================================================
// Output Helpers
// ============================================================================

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function isoTimestamp(): string {
	return new Date().toISOString();
}

interface JsonLogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	context?: LogContext;
	data?: Record<string, unknown>;
}

function outputJson(entry: JsonLogEntry): void {
	console.log(JSON.stringify(entry));
}

function contextToData(
	ctx: LogContext | null,
): Record<string, unknown> | undefined {
	if (!ctx) return undefined;
	return {
		channelId: ctx.channelId,
		userName: ctx.userName,
		channelName: ctx.channelName,
		threadTs: ctx.threadTs,
		runId: ctx.runId,
		taskId: ctx.taskId,
		source: ctx.source,
	};
}

function formatContext(ctx: LogContext): string {
	if (ctx.channelId.startsWith("D")) {
		const base = `[DM:${ctx.userName || ctx.channelId}]`;
		return appendExtras(base, ctx);
	}
	const channel = ctx.channelName || ctx.channelId;
	const user = ctx.userName || "unknown";
	const base = `[${channel.startsWith("#") ? channel : `#${channel}`}:${user}]`;
	return appendExtras(base, ctx);
}

function appendExtras(base: string, ctx: LogContext): string {
	const extras: string[] = [];
	if (ctx.source) extras.push(`src=${ctx.source}`);
	if (ctx.runId) extras.push(`run=${shorten(ctx.runId, 10)}`);
	if (ctx.taskId) extras.push(`task=${shorten(ctx.taskId, 12)}`);
	if (ctx.threadTs) extras.push(`thread=${shorten(ctx.threadTs, 10)}`);
	return extras.length > 0 ? `${base} ${extras.join(" ")}` : base;
}

function shorten(value: string, maxLen: number): string {
	return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
}

export function logUserMessage(ctx: LogContext, text: string): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

export function logToolStart(
	ctx: LogContext,
	toolName: string,
	label: string,
	args: Record<string, unknown>,
): void {
	const formattedArgs = formatToolArgs(args);
	console.log(
		chalk.yellow(
			`${timestamp()} ${formatContext(ctx)} -> ${toolName}: ${label}`,
		),
	);
	if (formattedArgs) {
		console.log(chalk.dim(indent(formattedArgs)));
	}
}

export function logToolSuccess(
	ctx: LogContext,
	toolName: string,
	durationMs: number,
	result: string,
): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(
		chalk.yellow(
			`${timestamp()} ${formatContext(ctx)} ok ${toolName} (${duration}s)`,
		),
	);
	const truncated = truncate(result, 1000);
	if (truncated) {
		console.log(chalk.dim(indent(truncated)));
	}
}

export function logToolError(
	ctx: LogContext,
	toolName: string,
	durationMs: number,
	error: string,
): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(
		chalk.yellow(
			`${timestamp()} ${formatContext(ctx)} err ${toolName} (${duration}s)`,
		),
	);
	console.log(chalk.dim(indent(truncate(error, 1000))));
}

export function logResponseStart(ctx: LogContext): void {
	console.log(
		chalk.yellow(
			`${timestamp()} ${formatContext(ctx)} -> Streaming response...`,
		),
	);
}

export function logThinking(ctx: LogContext, thinking: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Thinking`));
	console.log(chalk.dim(indent(truncate(thinking, 1000))));
}

export function logResponse(ctx: LogContext, text: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Response`));
	console.log(chalk.dim(indent(truncate(text, 1000))));
}

export function logInfo(message: string, ctx?: LogContext): void {
	if (!shouldLog("info")) return;
	const context = ctx ?? getCurrentContext();

	if (outputFormat === "json") {
		outputJson({
			timestamp: isoTimestamp(),
			level: "info",
			message,
			context: context ?? undefined,
		});
		return;
	}

	const contextStr = context ? formatContext(context) : "[system]";
	console.log(chalk.blue(`${timestamp()} ${contextStr} ${message}`));
}

export function logWarning(
	message: string,
	details?: string,
	ctx?: LogContext,
): void {
	if (!shouldLog("warn")) return;
	const context = ctx ?? getCurrentContext();

	if (outputFormat === "json") {
		outputJson({
			timestamp: isoTimestamp(),
			level: "warn",
			message,
			context: context ?? undefined,
			data: details ? { details } : undefined,
		});
		return;
	}

	const contextStr = context ? formatContext(context) : "[system]";
	console.log(chalk.yellow(`${timestamp()} ${contextStr} warning: ${message}`));
	if (details) {
		console.log(chalk.dim(indent(details)));
	}
}

export function logDebug(
	message: string,
	data?: Record<string, unknown>,
): void {
	if (!shouldLog("debug")) return;
	if (process.env.DEBUG !== "true" && process.env.DEBUG !== "1") {
		return;
	}
	const context = getCurrentContext();

	if (outputFormat === "json") {
		outputJson({
			timestamp: isoTimestamp(),
			level: "debug",
			message,
			context: context ?? undefined,
			data,
		});
		return;
	}

	const contextStr = context ? formatContext(context) : "[debug]";
	const dataStr = data ? ` ${JSON.stringify(data)}` : "";
	console.log(chalk.gray(`${timestamp()} ${contextStr} ${message}${dataStr}`));
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
	if (!shouldLog("error")) return;

	if (outputFormat === "json") {
		outputJson({
			timestamp: isoTimestamp(),
			level: "error",
			message: "Agent error",
			context: ctx === "system" ? undefined : ctx,
			data: { error },
		});
		return;
	}

	const context = ctx === "system" ? "[system]" : formatContext(ctx);
	console.log(chalk.yellow(`${timestamp()} ${context} Agent error`));
	console.log(chalk.dim(indent(error)));
}

export function logRunSummary(
	ctx: LogContext,
	summary: {
		stopReason: string;
		durationMs: number;
		toolsExecuted: number;
		cost: {
			total: number;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			model?: string | null;
		};
	},
): void {
	if (!shouldLog("info")) return;

	if (outputFormat === "json") {
		outputJson({
			timestamp: isoTimestamp(),
			level: "info",
			message: "Run summary",
			context: ctx,
			data: {
				stopReason: summary.stopReason,
				durationMs: summary.durationMs,
				toolsExecuted: summary.toolsExecuted,
				cost: summary.cost.total,
				inputTokens: summary.cost.inputTokens,
				outputTokens: summary.cost.outputTokens,
				cacheReadTokens: summary.cost.cacheReadTokens,
				cacheWriteTokens: summary.cost.cacheWriteTokens,
				model: summary.cost.model,
			},
		});
		return;
	}

	const duration = (summary.durationMs / 1000).toFixed(1);
	const modelPart = summary.cost.model ? ` model=${summary.cost.model}` : "";
	const line = `stop=${summary.stopReason} dur=${duration}s tools=${summary.toolsExecuted} cost=$${summary.cost.total.toFixed(4)} tokens=${summary.cost.inputTokens}/${summary.cost.outputTokens}${modelPart}`;
	console.log(chalk.blue(`${timestamp()} ${formatContext(ctx)} Run summary`));
	console.log(chalk.dim(indent(line)));
}

export function logUsageSummary(
	ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	},
): string {
	const lines: string[] = [];
	lines.push("*Usage Summary*");
	lines.push(
		`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`,
	);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(
			`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`,
		);
	}
	lines.push(
		`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out${
			usage.cacheRead > 0 || usage.cacheWrite > 0
				? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
				: ""
		}`,
	);
	lines.push(`*Total: $${usage.cost.total.toFixed(4)}*`);

	const summary = lines.join("\n");

	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Usage`));
	console.log(
		chalk.dim(
			indent(
				`${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out${
					usage.cacheRead > 0 || usage.cacheWrite > 0
						? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
						: ""
				} = $${usage.cost.total.toFixed(4)}`,
			),
		),
	);

	return summary;
}

export function logStartup(workingDir: string, sandbox: string): void {
	console.log("Starting Slack agent...");
	console.log(`  Working directory: ${workingDir}`);
	console.log(`  Sandbox: ${sandbox}`);
}

export function logConnected(): void {
	console.log("Slack agent connected and listening!");
	console.log("");
}

export function logDisconnected(): void {
	console.log("Slack agent disconnected.");
}

export function logBackfillStart(channelCount: number): void {
	console.log(
		chalk.blue(
			`${timestamp()} [system] Backfilling ${channelCount} channels...`,
		),
	);
}

export function logBackfillChannel(
	channelName: string,
	messageCount: number,
): void {
	console.log(
		chalk.blue(
			`${timestamp()} [system]   #${channelName}: ${messageCount} messages`,
		),
	);
}

export function logBackfillComplete(
	totalMessages: number,
	durationMs: number,
): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(
		chalk.blue(
			`${timestamp()} [system] Backfill complete: ${totalMessages} messages in ${duration}s`,
		),
	);
}

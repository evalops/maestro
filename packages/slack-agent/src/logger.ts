/**
 * Console logging utilities for the Slack agent
 */

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

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
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

export function logInfo(message: string): void {
	console.log(chalk.blue(`${timestamp()} [system] ${message}`));
}

export function logWarning(message: string, details?: string): void {
	console.log(chalk.yellow(`${timestamp()} [system] warning: ${message}`));
	if (details) {
		console.log(chalk.dim(indent(details)));
	}
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
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

/**
 * Session Performance Collector
 *
 * Aggregates per-turn metrics across an entire session for display
 * in /diag perf. Keeps running stats (min/max/avg/p95) for:
 * - Tool execution time (per tool name)
 * - LLM response latency
 * - Total turn duration
 * - Token throughput
 *
 * Can be fed either CanonicalTurnEvents (from TurnTracker) or raw
 * AgentEvents (directly from agent.subscribe).
 */

import chalk from "chalk";
import type { AgentEvent, Usage } from "../agent/types.js";
import type { CanonicalTurnEvent, ToolExecution } from "./wide-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LatencyStats {
	count: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	/** Sorted sample for percentile calculation (capped at 1000 entries) */
	samples: number[];
}

export interface SessionPerfSnapshot {
	turnCount: number;
	totalDurationMs: number;
	turns: LatencyStats;
	llm: LatencyStats;
	tools: Map<string, LatencyStats>;
	tokens: {
		totalInput: number;
		totalOutput: number;
		totalCacheRead: number;
	};
	costUsd: number;
	errors: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SAMPLES = 1000;

function emptyStats(): LatencyStats {
	return {
		count: 0,
		totalMs: 0,
		minMs: Number.POSITIVE_INFINITY,
		maxMs: 0,
		samples: [],
	};
}

function recordSample(stats: LatencyStats, ms: number): void {
	stats.count++;
	stats.totalMs += ms;
	if (ms < stats.minMs) stats.minMs = ms;
	if (ms > stats.maxMs) stats.maxMs = ms;
	if (stats.samples.length < MAX_SAMPLES) {
		stats.samples.push(ms);
	}
}

function avgMs(stats: LatencyStats): number {
	return stats.count === 0 ? 0 : stats.totalMs / stats.count;
}

function p95Ms(stats: LatencyStats): number {
	if (stats.samples.length === 0) return 0;
	const sorted = [...stats.samples].sort((a, b) => a - b);
	const idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
	return sorted[Math.max(idx, 0)] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collects performance data across an entire session.
 *
 * Two feeding modes:
 * - `record(event)` — from CanonicalTurnEvents (rich, post-processed)
 * - `handleAgentEvent(event)` — from raw agent events (lightweight state machine)
 */
export class SessionPerfCollector {
	private turnStats = emptyStats();
	private llmStats = emptyStats();
	private toolStats = new Map<string, LatencyStats>();
	private turnCount = 0;
	private totalDurationMs = 0;
	private totalInput = 0;
	private totalOutput = 0;
	private totalCacheRead = 0;
	private costUsd = 0;
	private errors = 0;

	// Lightweight state machine for raw event mode
	private turnStart = 0;
	private llmStart = 0;
	private toolStarts = new Map<string, { name: string; start: number }>();
	private turnUsage: Usage | null = null;

	// ── CanonicalTurnEvent mode ──────────────────────────────────────────────

	/** Record a completed turn event (from TurnTracker). */
	record(event: CanonicalTurnEvent): void {
		this.turnCount++;
		this.totalDurationMs += event.totalDurationMs;
		this.totalInput += event.tokens.input;
		this.totalOutput += event.tokens.output;
		this.totalCacheRead += event.tokens.cacheRead;
		this.costUsd += event.costUsd;
		if (event.status === "error") this.errors++;

		recordSample(this.turnStats, event.totalDurationMs);
		if (event.llmDurationMs > 0) {
			recordSample(this.llmStats, event.llmDurationMs);
		}

		for (const tool of event.tools) {
			this.recordTool(tool);
		}
	}

	// ── Raw AgentEvent mode ──────────────────────────────────────────────────

	/** Feed a raw agent event. Uses a lightweight state machine to track turns. */
	handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.turnStart = performance.now();
				this.turnUsage = null;
				this.toolStarts.clear();
				this.llmStart = 0;
				break;

			case "message_start":
				if (event.message?.role === "assistant") {
					this.llmStart = performance.now();
				}
				break;

			case "message_end":
				if (event.message?.role === "assistant" && this.llmStart > 0) {
					recordSample(this.llmStats, performance.now() - this.llmStart);
					this.llmStart = 0;
				}
				if (
					event.message?.role === "assistant" &&
					"usage" in event.message &&
					event.message.usage
				) {
					const u = event.message.usage as Usage;
					if (this.turnUsage) {
						this.turnUsage = {
							input: this.turnUsage.input + u.input,
							output: this.turnUsage.output + u.output,
							cacheRead: this.turnUsage.cacheRead + u.cacheRead,
							cacheWrite: this.turnUsage.cacheWrite + u.cacheWrite,
							cost: {
								input: this.turnUsage.cost.input + u.cost.input,
								output: this.turnUsage.cost.output + u.cost.output,
								cacheRead: this.turnUsage.cost.cacheRead + u.cost.cacheRead,
								cacheWrite: this.turnUsage.cost.cacheWrite + u.cost.cacheWrite,
								total: this.turnUsage.cost.total + u.cost.total,
							},
						};
					} else {
						this.turnUsage = u;
					}
				}
				break;

			case "tool_execution_start":
				if ("toolCallId" in event && "toolName" in event) {
					this.toolStarts.set(event.toolCallId, {
						name: event.toolName,
						start: performance.now(),
					});
				}
				break;

			case "tool_execution_end":
				if ("toolCallId" in event) {
					const info = this.toolStarts.get(event.toolCallId);
					if (info) {
						const durationMs = performance.now() - info.start;
						let stats = this.toolStats.get(info.name);
						if (!stats) {
							stats = emptyStats();
							this.toolStats.set(info.name, stats);
						}
						recordSample(stats, durationMs);
						this.toolStarts.delete(event.toolCallId);
					}
				}
				break;

			case "agent_end": {
				if (this.turnStart > 0) {
					const durationMs = performance.now() - this.turnStart;
					this.turnCount++;
					this.totalDurationMs += durationMs;
					recordSample(this.turnStats, durationMs);

					if (this.turnUsage) {
						this.totalInput += this.turnUsage.input;
						this.totalOutput += this.turnUsage.output;
						this.totalCacheRead += this.turnUsage.cacheRead;
						this.costUsd += this.turnUsage.cost.total;
					}

					if ("error" in event && event.error) {
						this.errors++;
					}

					this.turnStart = 0;
					this.turnUsage = null;
					this.toolStarts.clear();
					this.llmStart = 0;
				}
				break;
			}
		}
	}

	// ── Snapshot ──────────────────────────────────────────────────────────────

	private recordTool(tool: ToolExecution): void {
		let stats = this.toolStats.get(tool.name);
		if (!stats) {
			stats = emptyStats();
			this.toolStats.set(tool.name, stats);
		}
		recordSample(stats, tool.durationMs);
	}

	/** Snapshot current stats for display. */
	snapshot(): SessionPerfSnapshot {
		return {
			turnCount: this.turnCount,
			totalDurationMs: this.totalDurationMs,
			turns: { ...this.turnStats },
			llm: { ...this.llmStats },
			tools: new Map(this.toolStats),
			tokens: {
				totalInput: this.totalInput,
				totalOutput: this.totalOutput,
				totalCacheRead: this.totalCacheRead,
			},
			costUsd: this.costUsd,
			errors: this.errors,
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
	return `${Math.round(ms)}ms`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatStatLine(label: string, stats: LatencyStats): string {
	if (stats.count === 0) return `  ${chalk.dim(label)}: no data`;
	return `  ${chalk.dim(label)}: avg ${fmtMs(avgMs(stats))}, p95 ${fmtMs(p95Ms(stats))}, min ${fmtMs(stats.minMs)}, max ${fmtMs(stats.maxMs)} (${stats.count} calls)`;
}

/**
 * Format a SessionPerfSnapshot into a human-readable report for /diag perf.
 */
export function formatPerfReport(snap: SessionPerfSnapshot): string {
	if (snap.turnCount === 0) {
		return `${chalk.bold("Performance")}\n${chalk.dim("No turns recorded yet.")}`;
	}

	const lines: string[] = [];
	lines.push(chalk.bold("Performance"));
	lines.push("");

	// Summary
	lines.push(
		`${chalk.dim("Turns")}: ${snap.turnCount} (${snap.errors} errors), total ${fmtMs(snap.totalDurationMs)}`,
	);

	// Turn timing
	lines.push(chalk.bold("Turn Latency"));
	lines.push(formatStatLine("Total", snap.turns));
	lines.push(formatStatLine("LLM", snap.llm));

	// Tool timing (sorted by total time descending)
	const sortedTools = [...snap.tools.entries()].sort(
		(a, b) => b[1].totalMs - a[1].totalMs,
	);

	if (sortedTools.length > 0) {
		lines.push("");
		lines.push(chalk.bold("Tool Latency"));
		for (const [name, stats] of sortedTools.slice(0, 10)) {
			lines.push(formatStatLine(name, stats));
		}
		if (sortedTools.length > 10) {
			lines.push(chalk.dim(`  …and ${sortedTools.length - 10} more tools`));
		}
	}

	// Token throughput
	lines.push("");
	lines.push(chalk.bold("Tokens"));
	lines.push(
		`  ${chalk.dim("Input")}: ${fmtTokens(snap.tokens.totalInput)}  ${chalk.dim("Output")}: ${fmtTokens(snap.tokens.totalOutput)}  ${chalk.dim("Cache Read")}: ${fmtTokens(snap.tokens.totalCacheRead)}`,
	);
	const totalTokens = snap.tokens.totalInput + snap.tokens.totalOutput;
	if (snap.totalDurationMs > 0 && totalTokens > 0) {
		const tokPerSec = (totalTokens / (snap.totalDurationMs / 1000)).toFixed(0);
		lines.push(`  ${chalk.dim("Throughput")}: ~${tokPerSec} tok/s`);
	}

	// Cost
	if (snap.costUsd > 0) {
		lines.push("");
		lines.push(`${chalk.dim("Cost")}: $${snap.costUsd.toFixed(4)}`);
	}

	return lines.join("\n");
}
